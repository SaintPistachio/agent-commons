/**
 * openai-api tool loop: a job with a tool set runs as several helper requests ("turns"). Each turn sends the
 * conversation so far with the granted tools as strict function tools; the central helper admits, reserves and
 * accounts for it like any request. Agent Commons runs the function calls the model returns and sends their results
 * in the next turn, until the model answers without calling a tool.
 *
 * Spending rules: max_cost_usd covers every turn (each turn's ceiling is what is left); a turn with no known cost,
 * an uncertain turn, or an interruption while a request is in flight leaves the job for review; nothing is replayed.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Json } from '../store.ts';
import type { Active, ReconcileContext, RouteCommand, RunContext } from './types.ts';
import { helperCall, helperEnv, killTree, replyUsage } from './shared.ts';
import { mcpTools, projectTools, type ToolHost } from '../api-tools.ts';

export const DEFAULT_MAX_TURNS = 8, MAX_TURNS = 20;
/** Under this much budget left, another turn is not attempted. */
const MIN_TURN_MICRO = 10000;

/** The helper takes a canonical UUID or a lowercase SHA-256 as external_request_id; a turn's is the hash of <jobId>:t<n>. */
export const turnRequestId = (jobId: string, n: number) => createHash('sha256').update(`${jobId}:t${n}`).digest('hex');

const toMicro = (usd: unknown): number | null => {
  const text = typeof usd === 'number' ? usd.toFixed(6) : usd;
  if (typeof text !== 'string' || !/^\d{1,6}(\.\d{1,9})?$/.test(text)) return null;
  const [whole, frac = ''] = text.split('.');
  return Number(whole) * 1e6 + Number((frac + '000000').slice(0, 6));
};
const fromMicro = (micro: number) => `${Math.floor(micro / 1e6)}.${String(micro % 1e6).padStart(6, '0')}`;

export interface TurnRecord {
  n: number;
  request_id: string;
  ceiling_usd: string;
  status: string;
  helper_job_id?: string | null;
  cost_usd?: string | null;
  tokens_in?: number | null;
  tokens_out?: number | null;
  calls?: string[];
}

const INSTRUCTIONS = (root: string, tools: string[], maxTurns: number) =>
  `You are an Agent Commons advice worker. You may call these tools to inspect before answering: ${tools.join(', ')}. `
  + `Paths are relative to the job folder (${path.basename(root) || root}). Tools are read-only for this job. `
  + `Ask for narrow ranges; each tool result is cut at 16000 characters. You have at most ${maxTurns} turns in total; `
  + 'on the last one tools are switched off. When you have enough, answer the request directly without calling a tool.';

interface Outcome { status: string; fields: Json }

/** Runs one tool-loop job to its end. Called by the openai-api adapter for jobs with a tool set. */
export function launchToolLoop(job: Json, ctx: RunContext, helper: RouteCommand): void {
  const o = job.options ?? {};
  const set = o.toolset;
  const maxTurns = Math.min(MAX_TURNS, Math.max(1, Number(o.max_turns ?? DEFAULT_MAX_TURNS)));
  const budget = toMicro(o.max_cost_usd) ?? 0;
  const turns: TurnRecord[] = [];
  const transcript: string[] = [];
  let log: number | undefined = fs.openSync(path.join(ctx.dir, 'stderr.log'), 'w');
  const note = (line: string) => { const fd = log; if (fd === undefined) return; try { fs.writeSync(fd, line.endsWith('\n') ? line : line + '\n'); } catch { /* log closed */ } };
  const closeLog = () => { const fd = log; if (fd === undefined) return; log = undefined; try { fs.closeSync(fd); } catch { /* closed */ } };
  let host: ToolHost | undefined;
  let closeHost: (() => void) | undefined;
  let inFlight = false;
  const stopHost = () => { closeHost?.(); host?.close(); };
  let finished = false;
  let transcriptSaved = false;
  const record = () => ctx.annotate({ api_turns: turns });
  const summaryFields = (): Json => {
    const known = turns.map(t => toMicro(t.cost_usd)).filter((c): c is number => c !== null);
    const sum = (k: 'tokens_in' | 'tokens_out') =>
      turns.some(t => typeof t[k] === 'number') ? turns.reduce((a, t) => a + (t[k] ?? 0), 0) : null;
    return {
      helper_job_id: turns.findLast(t => t.helper_job_id)?.helper_job_id ?? null,
      cost_usd: turns.length ? (known.length ? fromMicro(known.reduce((a, b) => a + b, 0)) : null) : null,
      tokens_in: sum('tokens_in'),
      tokens_out: sum('tokens_out'),
      turns: turns.length,
    };
  };
  const saveTranscript = (status: string, error?: unknown) => {
    if (transcriptSaved) return;
    transcriptSaved = true;
    try {
      const known = turns.map(t => toMicro(t.cost_usd)).filter((c): c is number => c !== null);
      const header = [`# ${job.id} tool loop`, `tool set: ${set.name} (definition ${String(set.def_sha256 ?? '').slice(0, 12)}); model ${job.model}; ceiling $${o.max_cost_usd}; max_turns ${maxTurns}`,
        `outcome: ${status}${error ? ` (${error})` : ''}; recorded cost $${fromMicro(known.reduce((a, b) => a + b, 0))}${known.length < turns.length ? ' (some turns have no known cost)' : ''}`, ''];
      ctx.store.attachTranscript(job.id, [...header, ...transcript].join('\n') + '\n');
    } catch (err) { note(`transcript not saved: ${String((err as Error).message).slice(0, 200)}`); }
  };
  const stopNow = (reason: string) => {
    if (active.reason) return;
    active.reason = reason;
    if (active.child?.pid) killTree(active.child.pid);
    stopHost();
  };
  const active: Active = {
    timer: setTimeout(() => stopNow('TIMEOUT'), job.timeout_ms),
    cleanup: stopHost,
    stopFields: () => {
      finished = true;
      try { record(); } catch (err) { note(`api_turns not saved: ${String((err as Error).message).slice(0, 200)}`); }
      saveTranscript('needs_review', active.reason);
      closeLog();
      return summaryFields();
    },
  };
  ctx.track(active);
  const current = () => ctx.active() === active;
  const finish = ({ status, fields }: Outcome) => {
    if (finished) return;
    finished = true;
    clearTimeout(active.timer);
    stopHost();
    saveTranscript(status, fields.error);
    closeLog();
    if (!current()) return;
    record();
    ctx.finish(status, { ...fields, ...summaryFields() });
  };
  /** Stopped with no request in flight: every earlier turn is settled, so the job is cancelled or failed, not uncertain. */
  const stoppedBetween = (): Outcome => ({ status: active.reason === 'CANCELLED' ? 'cancelled' : 'failed',
    fields: { error: `${active.reason}: stopped between turns; no request was in flight` } });

  const run = async (): Promise<Outcome> => {
    const root = ctx.prepareWorkdir();
    host = set.builtin === 'project'
      ? projectTools(root, [ctx.home])
      : await mcpTools(set, { dir: ctx.dir, log: note, onClose: fn => { closeHost = fn; if (active.reason) fn(); } });
    if (host.pid) ctx.store.updateJob(job.id, { pid: host.pid });
    if (active.reason) return stoppedBetween();
    transcript.push(`tools offered: ${host.tools.map(t => t.name).join(', ') || 'none'}${host.skipped.length ? `; skipped: ${host.skipped.join('; ')}` : ''}`, '');
    if (!host.tools.length) return { status: 'failed', fields: { error: `TOOLSET_NO_TOOLS: no granted tool could be offered (${host.skipped.join('; ').slice(0, 300)})` } };
    const items: Json[] = [{ role: 'user', content: [{ type: 'input_text', text: job.prompt, prompt_cache_breakpoint: { mode: 'explicit', ttl: '30m' } }] }];
    const instructions = INSTRUCTIONS(root, host.tools.map(t => t.name), maxTurns);
    for (let n = 1; n <= maxTurns; n++) {
      if (active.reason) return stoppedBetween();
      const spent = turns.reduce((a, t) => a + (toMicro(t.cost_usd) ?? 0), 0), left = budget - spent;
      if (left < MIN_TURN_MICRO) return { status: 'failed', fields: { error: `BUDGET_SPENT: $${fromMicro(Math.max(0, left))} of $${o.max_cost_usd} left before turn ${n}` } };
      // Admission needs cost evidence under five minutes old; refreshing it is a read-only account call.
      const hostPid = host.pid ?? null;
      const costs = await helperCall(helper, ['refresh-costs'], 120000, c => {
        active.child = c;
        if (current()) try { ctx.store.updateJob(job.id, { pid: c?.pid ?? hostPid }); } catch { /* best effort */ }
      });
      note(`turn ${n} refresh-costs exit ${costs.code}: ${JSON.stringify(costs.reply)?.slice(0, 500)}`);
      if (active.reason || !current()) return stoppedBetween();
      const last = n === maxTurns;
      const turn: TurnRecord = { n, request_id: turnRequestId(job.id, n), ceiling_usd: fromMicro(left), status: 'submitting' };
      const request = { capability: 'responses', external_request_id: turn.request_id, model: job.model, tier: o.tier, max_cost_usd: turn.ceiling_usd,
        local_timeout_seconds: Math.min(900, Math.max(1, Math.floor(job.timeout_ms / 1000) - 30)),
        purpose: { kind: 'coding_assistance', description: o.purpose, deliverable: o.deliverable },
        payload: { input: items, instructions, max_output_tokens: o.max_output_tokens, ...(job.effort ? { reasoning: { effort: job.effort } } : {}),
          tools: host.tools, tool_choice: last ? 'none' : 'auto', parallel_tool_calls: true } };
      const requestFile = path.join(ctx.dir, `request-t${n}.json`), replyFile = path.join(ctx.dir, `reply-t${n}.json`);
      fs.writeFileSync(requestFile, JSON.stringify(request, null, 2));
      // Recorded before the request can leave, so a restart knows which turn IDs to look up.
      turns.push(turn); record();
      transcript.push(`## Turn ${n}`, `request ${turn.request_id.slice(0, 16)}; ceiling $${turn.ceiling_usd}${last ? '; tools off (last turn)' : ''}`);
      const out = fs.openSync(replyFile, 'w');
      let child: ChildProcess;
      try {
        child = spawn(helper.file, [...(helper.prefix ?? []), 'invoke', '--request', requestFile],
          { cwd: helper.cwd, env: helperEnv(), stdio: ['ignore', out, log ?? 'ignore'], windowsHide: true, detached: process.platform !== 'win32' });
      } catch (error) {
        fs.closeSync(out); turn.status = 'not_submitted';
        return { status: 'failed', fields: { error: 'SPAWN_FAILED_BEFORE_SUBMISSION: ' + String((error as Error).message).slice(0, 300) } };
      }
      inFlight = true; active.child = child;
      if (child.pid) ctx.store.updateJob(job.id, { pid: child.pid });
      const code = await new Promise<number | null>(resolve => { child.on('error', () => {}); child.on('close', resolve); });
      active.child = undefined;
      try { fs.closeSync(out); } catch { /* closed */ }
      if (current()) ctx.store.updateJob(job.id, { pid: hostPid });
      if (child.pid === undefined) { inFlight = false; turn.status = 'not_submitted'; return { status: 'failed', fields: { exit_code: code, error: `${active.reason ?? 'SPAWN_FAILED'}_BEFORE_SUBMISSION` } }; }
      let reply: Json | null = null;
      try { reply = JSON.parse(fs.readFileSync(replyFile, 'utf8')); } catch { /* unclear below */ }
      const usage = replyUsage(reply ?? {});
      Object.assign(turn, { helper_job_id: reply?.job_id ?? null, cost_usd: reply?.cost_usd ?? null, tokens_in: usage.tokens_in, tokens_out: usage.tokens_out });
      if (reply?.status === 'blocked' && !reply.job_id) {
        inFlight = false;
        turn.status = 'blocked'; turn.cost_usd = null;
        transcript.push(`refused at admission: ${reply.error_code ?? 'unknown'}`, '');
        return { status: 'failed', fields: { exit_code: code, error: `HELPER_BLOCKED: ${reply.error_code ?? 'unknown'} (turn ${n})` } };
      }
      if (['failed', 'refused', 'invalid_result', 'incomplete', 'partial'].includes(reply?.status) && reply?.job_id) {
        turn.status = reply!.status;
        transcript.push(`helper status ${reply!.status}; cost $${turn.cost_usd ?? 'unknown'}`, '');
        if (toMicro(turn.cost_usd) === null) return { status: 'needs_review', fields: { exit_code: code, error: `UNKNOWN_SPEND: turn ${n} ended ${reply!.status} without a recorded cost` } };
        inFlight = false;
        return { status: 'failed', fields: { exit_code: code, error: `HELPER_${String(reply!.status).toUpperCase()}: ${reply!.error_code ?? 'see helper job'} (turn ${n})` } };
      }
      if (reply?.status !== 'completed') {
        turn.status = String(reply?.status ?? 'unknown');
        transcript.push(`outcome unclear: ${active.reason ?? 'helper status ' + (reply?.status ?? 'unknown')}`, '');
        return { status: 'needs_review', fields: { exit_code: code,
          error: `${active.reason ?? 'HELPER_OUTCOME_UNCLEAR'}: turn ${n} helper status ${reply?.status ?? 'unknown'}; reservation may be held until the helper reconciles it` } };
      }
      inFlight = false;
      turn.status = 'completed';
      if (job.model) ctx.store.markModelValidated('openai-api', job.model);
      if (current()) { record(); ctx.store.updateJob(job.id, summaryFields()); }
      if (toMicro(turn.cost_usd) === null) {
        transcript.push('completed without a recorded cost', '');
        return { status: 'needs_review', fields: { exit_code: code, error: `UNKNOWN_SPEND: turn ${n} completed without a recorded cost; the loop stopped` } };
      }
      const output = reply.output;
      const text = typeof output?.text === 'string' ? output.text : typeof output === 'string' ? output : '';
      const calls: Array<{ call_id: string; name: string; arguments: string }> = Array.isArray(output?.function_calls) ? output.function_calls : [];
      if (calls.some(c => !c || typeof c.call_id !== 'string' || typeof c.name !== 'string' || typeof c.arguments !== 'string'))
        return { status: 'failed', fields: { exit_code: code, error: `HELPER_OUTPUT_INVALID: turn ${n} returned malformed function calls` } };
      transcript.push(`cost $${turn.cost_usd}; tokens ${turn.tokens_in ?? '?'} in / ${turn.tokens_out ?? '?'} out`);
      if (text) transcript.push('assistant:', text);
      turn.calls = calls.map(c => c.name);
      if (!calls.length) { transcript.push(''); return { status: 'completed', fields: { exit_code: code, result: text || '(no text)' } }; }
      if (last) return { status: 'failed', fields: { exit_code: code, error: `MAX_TURNS: the model still called tools on turn ${n} of ${maxTurns}`, result: text || null } };
      if (text) items.push({ role: 'assistant', content: [{ type: 'output_text', text }] });
      for (const c of calls) items.push({ type: 'function_call', call_id: c.call_id, name: c.name, arguments: c.arguments });
      for (const c of calls) {
        if (active.reason) return stoppedBetween();
        const result = await host.call(c.name, c.arguments);
        items.push({ type: 'function_call_output', call_id: c.call_id, output: result });
        transcript.push(`call ${c.name} ${c.arguments.slice(0, 500)}`, `result (${result.length} chars):`, result, '');
      }
      record();
    }
    return { status: 'failed', fields: { error: `MAX_TURNS: ${maxTurns} turns used` } };
  };
  run().then(finish, error => {
    // A failure inside a request (inFlight) may have reached the provider; anywhere else nothing was in flight.
    const why = String((error as Error)?.message ?? error).slice(0, 300);
    finish(inFlight ? { status: 'needs_review', fields: { error: `TOOL_LOOP_FAILED_DURING_REQUEST: ${why}` } }
      : active.reason ? stoppedBetween() : { status: 'failed', fields: { error: `TOOL_LOOP_FAILED: ${why}` } });
  });
}

/**
 * After a service restart: look up every recorded turn in the helper's ledger and record what it knows (status and
 * cost). The loop is never resumed and nothing is resubmitted; the job stays needs_review for a person.
 */
export async function reconcileToolLoop(job: Json, ctx: ReconcileContext, helper: RouteCommand): Promise<void> {
  const turns: TurnRecord[] = Array.isArray(job.options?.api_turns) ? job.options.api_turns : [];
  if (!turns.length) return;
  for (const turn of turns) {
    if (turn.status !== 'submitting' && turn.status !== 'unknown'
      && turn.status !== 'helper:submitting' && turn.status !== 'helper:unknown'
      && (turn.status === 'blocked' || turn.status === 'not_submitted' || toMicro(turn.cost_usd) !== null)) continue;
    const { reply } = await helperCall(helper, ['lookup', '--external-request-id', turn.request_id]);
    if (!reply?.status) continue;
    turn.status = `helper:${reply.status}`;
    turn.helper_job_id = reply.job_id ?? turn.helper_job_id ?? null;
    if (reply.cost_usd !== undefined && reply.cost_usd !== null) turn.cost_usd = reply.cost_usd;
    const usage = replyUsage(reply);
    if (usage.tokens_in !== null) turn.tokens_in = usage.tokens_in;
    if (usage.tokens_out !== null) turn.tokens_out = usage.tokens_out;
  }
  const known = turns.map(t => toMicro(t.cost_usd)).filter((c): c is number => c !== null);
  const sum = (k: 'tokens_in' | 'tokens_out') =>
    turns.some(t => typeof t[k] === 'number') ? turns.reduce((a, t) => a + (t[k] ?? 0), 0) : null;
  const unresolved = turns.some(t => t.status === 'submitting' || t.status === 'unknown' || t.status === 'helper:submitting' || t.status === 'helper:unknown');
  ctx.store.annotateJob(job.id, { api_turns: turns });
  ctx.store.updateJob(job.id, {
    helper_job_id: turns.findLast(t => t.helper_job_id)?.helper_job_id ?? null,
    cost_usd: known.length ? fromMicro(known.reduce((a, b) => a + b, 0)) : null,
    tokens_in: sum('tokens_in'),
    tokens_out: sum('tokens_out'),
    turns: turns.length,
    error: unresolved ? 'SERVICE_STOPPED_DURING_JOB'
      : `SERVICE_STOPPED_DURING_TOOL_LOOP: ${turns.length} turn(s) recorded (${turns.map(t => `t${t.n}:${t.status}`).join(',')}); never resumed`,
  });
}
