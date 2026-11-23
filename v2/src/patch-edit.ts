import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AIR_PATCH_PRIMER } from './air/primer.ts';
import { checkWorkerBlock } from './air/worker.ts';
import type { Active, PlatformAdapter, RunContext } from './adapters/types.ts';
import { patchWorktreeExecutables, worktreeChangedFiles } from './adapters/shared.ts';
import { buildContext, redactSecrets, same } from './context.ts';
import { applyPatchBlocks, parsePatchBlocks } from './patch.ts';
import { preflightPatchCheck, resolvePatchCheck, runPatchCheck } from './patch-check.ts';
import { CommonsError, sha256, type Json } from './store.ts';

/** Preserve the complete precision that the helper reports across paid turns. */
function nanos(value: unknown): bigint | null {
  const raw = typeof value === 'number' ? value.toFixed(9) : value;
  if (typeof raw !== 'string' || !/^\d{1,6}(\.\d{1,9})?$/.test(raw)) return null;
  const [whole, frac = ''] = raw.split('.');
  return BigInt(whole) * 1000000000n + BigInt(frac.padEnd(9, '0'));
}

const micros = (n: bigint) => `${n / 1000000000n}.${String(n % 1000000000n / 1000n).padStart(6, '0')}`;
const usd = (n: bigint) => `${n / 1000000000n}.${String(n % 1000000000n).padStart(9, '0')}`;
const message = (error: unknown) => redactSecrets(String((error as Error)?.message ?? error)).slice(0, 300);

interface PatchEditHooks {
  prompt: string;
  fence(text: string): string;
  observe(reply?: Json): void;
}

/** Adapters provide advice turns. Only this job runner may apply a patch and request the approved check. */
export function launchPatchEdit(job: Json, route: PlatformAdapter, ctx: RunContext, hooks: PatchEditHooks): void {
  const config = job.options.patch_edit;
  const project = ctx.store.projectRoot(job.project_id);
  if (!project) throw new Error('project root is unavailable');
  const check = resolvePatchCheck(ctx.home, project, config.check);
  const approved = () => sha256(JSON.stringify(resolvePatchCheck(ctx.home, project, config.check))) === config.check_hash;
  if (sha256(JSON.stringify(check)) !== config.check_hash) throw new Error('approved check changed since job submission');
  const runCheck = ctx.options.patchCheck?.run ?? runPatchCheck;
  (ctx.options.patchCheck?.preflight ?? preflightPatchCheck)(check, ctx.dir);
  const worktree = ctx.prepareWorkdir();
  const deadline = Date.parse(job.started_at) + job.timeout_ms;
  const paid = route.capabilities.billing === 'paid';
  const budget = paid ? nanos(job.options.max_cost_usd) : null;
  if (paid && (budget === null || budget < 1000n)) throw new Error('patch edit requires a positive cost ceiling with up to nine decimal places');
  let spent = 0n, turn = 0, feedback = '';
  const appliedChanges = new Map<string, string[]>();
  let tokensIn = 0, tokensOut = 0, sawTokensIn = false, sawTokensOut = false;
  let last: Json = {};
  const attempts: Json[] = [];
  const stillRunning = () => ctx.store.jobRecord(job.id)?.status === 'running';
  const fields = () => ({ ...last, turns: turn, ...(paid ? { cost_usd: usd(spent) } : {}),
    tokens_in: sawTokensIn ? tokensIn : null, tokens_out: sawTokensOut ? tokensOut : null });
  const finish = (status: string, error?: string) => {
    if (!stillRunning()) return;
    const active = ctx.active();
    if (active) clearTimeout(active.timer);
    ctx.annotate({ patch_attempts: attempts });
    const result = status === 'completed' ? `Applied and verified the patch with ${check.name} (${turn} worker ${turn === 1 ? 'turn' : 'turns'}). Review the worktree diff.` : undefined;
    ctx.finish(status, { ...fields(), result: result ?? null, ...(error ? { error } : {}) });
  };
  const allowNext = () => turn < config.turns && Date.now() < deadline && (budget === null || budget - spent >= 1000n);

  const launchTurn = () => {
    if (!stillRunning()) return;
    if (ctx.store.jobRecord(job.id)?.cancel_requested) return finish('cancelled', 'CANCELLED');
    if (Date.now() >= deadline) return finish('failed', 'PATCH_EDIT_TIMEOUT');
    if (turn > 0 && !approved()) return finish('failed', 'PATCH_CHECK_APPROVAL_CHANGED');
    turn++;
    const dir = path.join(ctx.dir, `patch-turn-${turn}`);
    fs.mkdirSync(dir);
    const refs: string[] = job.options.patch_file_refs ?? [];
    const fileContext = refs.map(ref => {
      try { return buildContext([ref], { root: worktree, artifact: () => undefined, task: () => undefined }); }
      catch (error) {
        if (turn > 1 && error instanceof CommonsError && error.code === 'CTX_NOT_FOUND') return `Previously selected context is absent: ${ref}`;
        throw error;
      }
    }).join('\n\n');
    const perFile = Math.max(32, Math.min(2000, Math.floor(12000 / Math.max(1, appliedChanges.size))));
    const previousPatch = [...appliedChanges].map(([file, edits]) => `${file}\n${edits.join('\n').slice(-perFile)}`).join('\n\n');
    const context = [fileContext, feedback, previousPatch && `Applied changes by file (excerpts):\n${previousPatch}`].filter(Boolean).join('\n\n');
    if (context) ctx.store.recordPatchTurnContext(job, turn, context);
    const prompt = `${AIR_PATCH_PRIMER}\nAC applies your patch and runs the approved check. Return changes relative to the current file excerpts. Do not run checks yourself.\n${context ? `${hooks.fence(context)}\n` : ''}${hooks.prompt}`;
    if (prompt.length > route.capabilities.maxPromptChars) return finish('failed', 'PATCH_EDIT_PROMPT_TOO_LARGE');
    const left = budget === null ? null : micros(budget - spent);
    const options = { ...job.options, patch_turn: turn, ...(left === null ? {} : { max_cost_usd: left }) };
    route.checkBudget?.({ model: job.model, effort: job.effort, promptChars: prompt.length, options,
      input: ctx.options.openaiHelper ? { openaiHelper: ctx.options.openaiHelper } : {}, home: ctx.home });
    const attempt: Json = { turn, ...(left === null ? {} : { ceiling_usd: left }) };
    attempts.push(attempt);
    ctx.annotate({ patch_attempts: attempts, patch_state: { phase: 'worker', turn } });
    let reported = false, scratch: string | undefined;
    const removeScratch = () => { if (scratch) try { fs.rmdirSync(scratch); } catch { /* Keep an occupied directory for diagnosis. */ } };
    const turnCtx: RunContext = {
      ...ctx, dir,
      prepareWorkdir: () => {
        if (!stillRunning()) throw new Error('patch job is no longer running');
        scratch ??= fs.mkdtempSync(path.join(os.tmpdir(), 'ac-patch-worker-'));
        return scratch;
      },
      track: active => {
        const previousCleanup = active.cleanup;
        active.cleanup = () => { try { previousCleanup?.(); } finally { removeScratch(); } };
        active.stopFields = fields;
        ctx.track(active);
      },
      finish: (status, replyFields = {}, reply) => {
        if (reported || !stillRunning()) return;
        reported = true;
        const active = ctx.active();
        const interrupted = active?.reason;
        if (active) clearTimeout(active.timer);
        removeScratch();
        try {
          attempt.worker = status;
          Object.assign(attempt, { helper_job_id: replyFields.helper_job_id, cost_usd: replyFields.cost_usd });
          last = replyFields;
          if (typeof replyFields.tokens_in === 'number') { tokensIn += replyFields.tokens_in; sawTokensIn = true; }
          if (typeof replyFields.tokens_out === 'number') { tokensOut += replyFields.tokens_out; sawTokensOut = true; }
          if (paid) {
            const exact = nanos(replyFields.cost_usd);
            if (exact === null && (status === 'completed' || replyFields.helper_job_id)) return finish('needs_review', 'PATCH_EDIT_UNKNOWN_SPEND');
            spent += exact ?? 0n;
            if (spent > budget!) return finish('needs_review', 'PATCH_EDIT_BUDGET_OVERRUN');
          }
          hooks.observe(reply);
          if (status !== 'completed') return finish(status, replyFields.error);
          if (interrupted || ctx.store.jobRecord(job.id)?.cancel_requested)
            return finish(interrupted === 'TIMEOUT' ? 'failed' : 'cancelled', interrupted ?? 'CANCELLED');
          if (Date.now() >= deadline) return finish('failed', 'PATCH_EDIT_TIMEOUT');
          if (!approved()) return finish('failed', 'PATCH_CHECK_APPROVAL_CHANGED');
          const result = String(replyFields.result ?? '');
          const verdict = checkWorkerBlock(result);
          if (!verdict.ok || verdict.verdict === 'blk' || verdict.need) return finish('failed', 'PATCH_EDIT_INVALID_WORKER_RESULT');
          const blocks = parsePatchBlocks(result);
          if (!blocks.length) return finish('failed', 'PATCH_EDIT_NO_PATCH');
          const targets = blocks.map(block => block.path.replaceAll('\\', '/'));
          if (targets.some(target => path.posix.isAbsolute(target) || path.posix.normalize(target) !== target
            || target.split('/').some(part => !part || part === '.' || part === '..' || /[:\x00-\x1f]|[. ]$/.test(part)
              || (process.platform === 'win32' && /~\d/.test(part))))) return finish('failed', 'PATCH_EDIT_REJECTED: noncanonical patch path');
          const isProtected = (target: string) => check.protected_paths.some(p => same(target) === same(p) || same(target).startsWith(`${same(p)}/`));
          if (targets.some(isProtected)) return finish('failed', 'PATCH_EDIT_PROTECTED_CHECK_PATH');
          ctx.annotate({ patch_attempts: attempts, patch_state: { phase: 'apply', turn } });
          const latest = new Map<string, string[]>();
          const applied = applyPatchBlocks(worktree, blocks, { onAccepted: (block, _target, changed) => {
            if (!changed) return;
            const file = block.path.replaceAll('\\', '/');
            const text = block.kind === 'delete' ? 'Deleted file' : redactSecrets(block.text);
            latest.set(file, [...(latest.get(file) ?? []), text]);
          } });
          if (applied.rejected.length) return finish('failed', `PATCH_EDIT_REJECTED: ${message(applied.rejected[0].reason)}`);
          if (!applied.files) return finish('failed', 'PATCH_EDIT_NO_CHANGES');
          const gitDir = ctx.store.jobRecord(job.id)?.options.git_dir;
          if (worktreeChangedFiles(worktree, config.base, gitDir, ctx.home, true).some(isProtected))
            return finish('needs_review', 'PATCH_EDIT_PROTECTED_CHECK_PATH');
          attempt.applied = applied.files;
          for (const [file, edits] of latest) appliedChanges.set(file, edits);
          const executables = patchWorktreeExecutables(worktree, gitDir, ctx.home);
          const container = `ac-check-${job.id}-${turn}`;
          ctx.annotate({ patch_attempts: attempts, patch_state: { phase: 'check', turn, container, docker: check.docker } });
          const cancellation = new AbortController();
          const checkActive: Active = { stopFields: fields, cleanup: () => cancellation.abort() };
          ctx.track(checkActive);
          void runCheck(check, worktree, path.join(dir, 'check'), container, Math.max(1, deadline - Date.now()), (child, cancel) => {
            checkActive.child = child;
            checkActive.cleanup = () => { cancellation.abort(); cancel(); };
            ctx.store.updateJob(job.id, { pid: child.pid ?? null });
          }, cancellation.signal, executables).then(outcome => {
            if (!stillRunning() || ctx.active() !== checkActive) return;
            attempt.check = { name: check.name, exit_code: outcome.exitCode, error: outcome.error };
            const output = redactSecrets(outcome.output).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').slice(-12000);
            fs.writeFileSync(path.join(dir, 'check-result.json'), JSON.stringify({ ...attempt.check, output }), { flag: 'wx' });
            if (outcome.error === 'PATCH_CHECK_INTERRUPTED' || checkActive.reason)
              return finish('needs_review', checkActive.reason ?? outcome.error);
            ctx.annotate({ patch_attempts: attempts, patch_state: { phase: 'checked', turn } });
            if (ctx.store.jobRecord(job.id)?.cancel_requested) return finish('cancelled', 'CANCELLED');
            if (Date.now() >= deadline) return finish('failed', 'PATCH_EDIT_TIMEOUT');
            if (outcome.error) return finish('failed', outcome.error);
            if (outcome.exitCode === 0) return finish('completed');
            if (!allowNext()) return finish('failed', `PATCH_CHECK_FAILED: ${check.name} exited ${outcome.exitCode}`);
            feedback = `Previous patch applied. Approved check ${check.name} exited ${outcome.exitCode}. Correct the failure against the current file excerpts.`;
            if (check.share_failure_output && output) feedback += `\n${output}`;
            try { launchTurn(); }
            catch (error) { finish('failed', `PATCH_EDIT_NEXT_TURN: ${message(error)}`); }
          }).catch(error => finish('needs_review', `PATCH_CHECK_ERROR: ${message(error)}`));
        } catch (error) {
          const phase = ctx.store.jobRecord(job.id)?.options.patch_state?.phase;
          finish(phase === 'apply' || phase === 'check' ? 'needs_review' : 'failed', `PATCH_EDIT_ERROR: ${message(error)}`);
        }
      },
    };
    route.launch({ ...job, mode: 'advice', timeout_ms: Math.max(1, deadline - Date.now()), prompt, options }, turnCtx);
  };
  launchTurn();
}
