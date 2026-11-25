/**
 * gemini-api: one generateContent request through the Gemini credit helper (tools/gemini-capabilities), which alone
 * admits, reserves and accounts for recorded Google promotional and purchased credit.
 * This adapter keeps no ledger of its own and never retries.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Json } from '../store.ts';
import { fail } from '../errors.ts';
import { text } from '../validate.ts';
import { profileGrid, type Active, type PlatformAdapter, type ProbeContext, type ProbeResult, type RouteCommand, type RunContext,
  type ReconcileContext, type RunnerOptions, type UsageSnapshot } from './types.ts';
import { hashFile, helperCall, helperEnv, killTree, openOutputs } from './shared.ts';
import { defaultOpenAIHelperRoot } from './openai-models.ts';
import { openAICreditUsage } from './openai-credits.ts';
import { metadataFamily, supersededBy } from './inventory.ts';

export function defaultGeminiHelperRoot(home?: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.AGENT_COMMONS_GEMINI_HELPER_ROOT?.trim();
  if (override) return path.resolve(home ?? process.cwd(), override);
  return path.join(path.dirname(defaultOpenAIHelperRoot(home, env)), 'gemini-capabilities');
}

/** Setup pins the interpreter used to encrypt and read the key independently of the OpenAI SDK virtualenv. */
export function resolveGeminiHelper(root: string): RouteCommand | undefined {
  let python: string;
  try { python = fs.readFileSync(path.join(root, '.local', 'python-path.txt'), 'utf8').trim(); }
  catch { return undefined; }
  const script = path.join(root, 'run.py');
  return path.isAbsolute(python) && fs.existsSync(python) && fs.existsSync(script) ? { file: python, prefix: ['-I', script], cwd: root } : undefined;
}

const helperFor = (ctx: { options: RunnerOptions; home?: string }) =>
  ctx.options.geminiHelper ?? resolveGeminiHelper(defaultGeminiHelperRoot(ctx.home));
const registryRoot = (helper: RouteCommand | undefined, home?: string) => helper?.cwd ?? defaultGeminiHelperRoot(home);

interface Price { from: string; input: string; output: string }
interface Catalog {
  models: Record<string, { prices: Price[]; output_token_limit?: number }>;
  superseded?: Record<string, string>;
  unavailable?: Record<string, string>;
  observed_at?: string;
}
function readCatalog(root: string): Catalog {
  const cache = path.join(root, '.local', 'model-catalog.json');
  try {
    const catalog = JSON.parse(fs.readFileSync(fs.existsSync(cache) ? cache : path.join(root, 'registry.json'), 'utf8'));
    if (catalog?.models && typeof catalog.models === 'object' && !Array.isArray(catalog.models)) return catalog;
  } catch { return { models: {} }; }
  return { models: {} };
}
/** Highest listed rate from now on, per token (the helper reserves the same way). */
function worstRates(entry: { prices: Price[] } | undefined): { input: number; output: number } | null {
  if (!entry?.prices?.length) return null;
  const now = Date.now();
  const current = [...entry.prices].sort((a, b) => a.from.localeCompare(b.from)).filter(p => Date.parse(p.from) <= now).pop();
  const rows = [...(current ? [current] : []), ...entry.prices.filter(p => Date.parse(p.from) > now)];
  if (!current || rows.some(r => [r.input, r.output].some(rate => !Number.isFinite(Number(rate)) || Number(rate) <= 0))) return null;
  return { input: Math.max(...rows.map(r => Number(r.input))) / 1e6, output: Math.max(...rows.map(r => Number(r.output))) / 1e6 };
}
const THINKING_RESERVE = 24576;

const MODELS = { fast: 'gemini-3.8-flash', balanced: 'gemini-4-hydrogen', pro: 'gemini-4-neon' } as const;

const modelProfiles = (modelFor: (baseline: string) => string | null) =>
  profileGrid(['advice'], (intent, eff) => modelFor(intent === 'fast' || eff === 'min' || eff === 'low' ? MODELS.fast
    : intent === 'code' && eff === 'med' ? MODELS.balanced : MODELS.pro), { min: null, low: null, med: null, high: null, max: null });

async function discover(ctx: ProbeContext): Promise<import('./types.ts').ModelDiscoveries> {
  const helper = helperFor(ctx);
  if (!helper) throw new Error('Gemini helper is unavailable');
  const { code, reply } = await helperCall(helper, ['sync-models']);
  if (code !== 0 || reply?.status !== 'observed' || !reply.models || !reply.superseded || !reply.unavailable)
    throw new Error(`Gemini model discovery failed (${reply?.error_code ?? 'invalid reply'})`);
  const models = Object.keys(reply.models).filter(model => worstRates(reply.models[model]));
  const current = (baseline: string) => supersededBy(baseline, models) ?? (models.includes(baseline) ? baseline : null);
  const fallback = current(MODELS.balanced) ?? current(MODELS.fast) ?? models[0] ?? null;
  const previous = [...geminiApi.profiles];
  const profiles = modelProfiles(model => current(model) ?? fallback).map(seed => {
    const old = previous.find(item => item.intent === seed.intent && item.eff === seed.eff);
    return old?.model ? { ...seed, previousSeeds: [{ native_model: old.model, native_effort: old.effort }] } : seed;
  });
  geminiApi.profiles.splice(0, geminiApi.profiles.length, ...profiles);
  geminiApi.capabilities.defaultModel = current(MODELS.pro) ?? fallback;
  const rows: import('./types.ts').ModelDiscoveries = [
    ...models.map(model => ({ model, family: metadataFamily({}, model), state: 'verified' as const, source: 'registry' })),
    ...[...Object.keys(reply.superseded), ...Object.keys(reply.unavailable)].map(model => ({
      model, family: metadataFamily({}, model), state: 'retired' as const, source: 'registry',
    })),
  ];
  rows.completeSources = ['registry'];
  return rows;
}

function launch(job: Json, ctx: RunContext): void {
  const helper = helperFor(ctx);
  if (!helper) return ctx.finish('failed', { error: 'ROUTE_EXECUTABLE_NOT_FOUND' });
  const o = job.options ?? {};
  const request = { job_id: job.id, model: job.model, prompt: job.prompt, max_cost_usd: o.max_cost_usd,
    max_output_tokens: o.max_output_tokens, purpose: o.purpose, deliverable: o.deliverable, timeout_ms: job.timeout_ms };
  const requestFile = path.join(ctx.dir, 'request.json');
  fs.writeFileSync(requestFile, JSON.stringify(request, null, 2));
  ctx.store.updateJob(job.id, { workdir: helper.cwd ?? null });
  const [stdout, stderr] = openOutputs(ctx.dir);
  const timer = setTimeout(() => { const a = ctx.active(); if (a && !a.reason) { a.reason = 'TIMEOUT'; if (a.child?.pid) killTree(a.child.pid); } }, job.timeout_ms);
  const active: Active = { timer };
  ctx.track(active);
  let child: ChildProcess;
  try {
    child = spawn(helper.file, [...(helper.prefix ?? []), 'invoke', '--request', requestFile],
      { cwd: helper.cwd, env: helperEnv(), stdio: ['ignore', stdout, stderr], windowsHide: true, detached: process.platform !== 'win32' });
  } catch (error) {
    fs.closeSync(stdout); fs.closeSync(stderr); clearTimeout(timer);
    return ctx.finish('failed', { error: 'SPAWN_FAILED_BEFORE_SUBMISSION: ' + String((error as Error).message).slice(0, 300) });
  }
  active.child = child;
  child.on('error', error => { if (!active.reason) active.reason = 'SPAWN_FAILED: ' + error.message; });
  child.on('close', code => {
    clearTimeout(timer); fs.closeSync(stdout); fs.closeSync(stderr);
    if (ctx.active() !== active) return;
    if (child.pid === undefined) return ctx.finish('failed', { exit_code: code, error: `${active.reason ?? 'SPAWN_FAILED'}_BEFORE_SUBMISSION` });
    try { complete(ctx, code, active.reason); }
    catch (error) { ctx.finish('needs_review', { exit_code: code, error: 'RESULT_RECORDING_FAILED: ' + String((error as Error).message).slice(0, 300) }); }
  });
  ctx.store.updateJob(job.id, { pid: child.pid ?? null });
}

function complete(ctx: RunContext, code: number | null, reason?: string): void {
  let reply: Json | null = null;
  try { reply = JSON.parse(fs.readFileSync(path.join(ctx.dir, 'stdout.json'), 'utf8')); } catch { /* handled below */ }
  const recorded = { exit_code: code, cost_usd: reply?.cost_usd ?? null, reported_model: typeof reply?.model === 'string' ? reply.model : null,
    ...usageFields(reply?.usage) };
  if (reply?.status === 'completed' && typeof reply.text === 'string') {
    const error = resultError(reply);
    if (error) return ctx.finish('failed', { ...recorded, error, result: reply.text || null });
    return ctx.finish('completed', { ...recorded, result: reply.text });
  }
  // Refused by the helper or by a clear provider refusal: nothing was processed, nothing was spent.
  if (reply?.status === 'blocked') return ctx.finish('failed', { ...recorded, error: `HELPER_BLOCKED: ${String(reply.error_code ?? 'unknown')}` });
  // Anything else (uncertain, a kill mid-request, unreadable output) may have reached the provider.
  ctx.finish('needs_review', { ...recorded, error: `${reason ?? 'HELPER_OUTCOME_UNCLEAR'}: helper status ${reply?.status ?? 'unknown'}; reservation held until settled by hand` });
}

function resultError(result: Json): string | null {
  if (result.finish_reason === 'MAX_TOKENS') return 'HELPER_INCOMPLETE: max_output_tokens';
  if (!result.text.trim() || (result.finish_reason && result.finish_reason !== 'STOP'))
    return `HELPER_NO_OUTPUT: ${result.finish_reason ?? 'unknown'}`;
  return null;
}

function usageFields(usage?: Json | null) {
  const count = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 ? v as number : null;
  const output = count(usage?.candidatesTokenCount), thoughts = count(usage?.thoughtsTokenCount);
  return { tokens_in: count(usage?.promptTokenCount),
    tokens_out: output === null && thoughts === null ? null : (output ?? 0) + (thoughts ?? 0) };
}

/** After a service restart: record a completed outcome if the helper has one. Never resubmits. */
async function reconcile(job: Json, ctx: ReconcileContext): Promise<void> {
  const helper = helperFor({ options: ctx.options, home: ctx.home ?? ctx.store.home });
  if (!helper) return;
  const { reply } = await helperCall(helper, ['lookup', '--job-id', job.id]);
  const saved = reply?.job;
  if (!saved?.status) {
    if (reply?.error_code === 'job_unknown') ctx.store.updateJob(job.id, { error: 'SERVICE_STOPPED_DURING_JOB; no helper reservation recorded' });
    return;
  }
  const accounting = { cost_usd: saved.actual_usd ?? null, ...usageFields(saved.usage) };
  if (saved.status === 'completed') {
    let output: Json | null = reply?.result ?? null;
    if (!output) {
      try { output = JSON.parse(fs.readFileSync(path.join(ctx.store.home, 'jobs', job.id, 'stdout.json'), 'utf8')); } catch { /* ledger still has cost */ }
    }
    if (output?.status === 'completed' && output.job_id === job.id && typeof output.text === 'string') {
      const error = resultError(output);
      ctx.store.updateJob(job.id, { ...accounting, status: error ? 'failed' : 'completed', error, result: output.text || null, reported_model: output.model ?? null });
      return;
    }
  }
  ctx.store.updateJob(job.id, { ...accounting, error: `SERVICE_STOPPED_DURING_JOB; helper status ${saved.status}` });
}

async function probe(ctx: ProbeContext): Promise<ProbeResult> {
  const helper = helperFor(ctx);
  if (!helper) return { state: 'unavailable', reason: 'Gemini helper or its configured Python interpreter is missing; run Enter-ApiKey.ps1' };
  const { code, reply } = await helperCall(helper, ['status']);
  if (code === null || !reply) return { state: 'unavailable', reason: 'Gemini credit helper did not answer' };
  const script = helper.prefix?.[1] ?? helper.file;
  // Blockers (no key, no funding, disabled) are setup states: the route stays unavailable until the helper is ready.
  return code === 0 && reply.status === 'ready'
    ? { state: 'verified', binarySha256: fs.existsSync(script) ? await hashFile(script) : null, reason: 'helper ready; it admits each request itself' }
    : { state: 'unavailable', reason: `Gemini credit helper blocked: ${(reply.blockers ?? []).join(', ') || reply.error_code || 'unknown'}` };
}

/** `status` reads only the locally stored credential and ledger (no network). */
async function observeUsage(ctx: ProbeContext): Promise<UsageSnapshot | undefined> {
  const helper = helperFor(ctx);
  if (!helper) return;
  const { code, reply } = await helperCall(helper, ['status']);
  const credits = reply?.credits;
  const blocked = code === 2 && reply?.status === 'blocked';
  if (!(code === 0 && reply?.status === 'ready') && !blocked) {
    ctx.onUsageError?.({ kind: `helper:${reply?.error_code ?? 'invalid_status'}`, method: 'status', at: new Date().toISOString() });
    return;
  }
  if (blocked) return {
    rows: [{ pool: 'prepaid', window: 'grant', remaining_percent: 0, resets_at: null },
      { pool: 'prepaid', window: 'weekly', remaining_percent: 0, resets_at: null },
      { pool: 'prepaid', window: 'rolling budget', remaining_percent: 0, resets_at: null }],
    source: `Gemini helper blocked: ${(Array.isArray(reply.blockers) ? reply.blockers.join(', ') : reply.error_code) || 'unknown'}`,
  };
  if (credits?.status !== 'snapshot' || !Array.isArray(credits.grants)
    || typeof credits.grant_observed_at !== 'string' || !Number.isFinite(Date.parse(credits.grant_observed_at))) {
    ctx.onUsageError?.({ kind: 'helper:invalid_credit_snapshot', method: 'status', at: new Date().toISOString() });
    return;
  }
  // Same shape as the OpenAI helper's credits: a grant row and a paced weekly row.
  const snapshot = openAICreditUsage({ ...credits, grants: credits.grants.map((g: Json) => ({ remaining_usd: g.balance_usd, expires_at: g.expires_on })) });
  const monthly = credits.monthly_budget;
  const target = Number(monthly?.target_usd ?? NaN);
  const available = Number(monthly?.available_for_new_requests_usd ?? NaN);
  if (Number.isFinite(target) && target > 0 && Number.isFinite(available) && available >= 0 && available <= target) {
    snapshot.rows.push({ pool: 'prepaid', window: 'rolling budget', remaining_percent: 100 * available / target, resets_at: null });
  }
  const observed = new Date(credits.grant_observed_at).toISOString();
  const breakdown = credits.observed_credit_by_kind_usd;
  const balances = typeof breakdown?.promotional === 'string' && typeof breakdown?.prepaid === 'string'
    ? `; promotional $${breakdown.promotional}, purchased $${breakdown.prepaid} at observation` : '';
  return { ...snapshot, completeInventory: snapshot.rows.length === 3,
    source: snapshot.source.replace('helper credits', 'Gemini helper credits')
    + `; Google balance observed ${observed}${balances}; subsequent AC usage from the local ledger; rolling budget is 30 days` };
}

export const geminiApi: PlatformAdapter = {
  capabilities: { id: 'gemini-api', family: 'google', transport: 'helper', billing: 'paid', modes: ['advice'], supportsShellInEdit: false, hasWorkspaceReadTools: false,
    maxPromptChars: 200000, maxTimeoutMinutes: 15, defaultTimeoutMinutes: 10, quotaGroup: 'gemini-api', defaultModel: MODELS.pro,
    maxConcurrent: 1, maxConcurrentCeiling: 2, short: 'gem', automaticRepair: false },
  profiles: modelProfiles(model => model),
  probe,
  discover,
  activeModels(ctx) {
    return Object.keys(readCatalog(registryRoot(ctx.options?.geminiHelper, ctx.home)).models);
  },
  discoverySummary(ctx) {
    const catalog = readCatalog(registryRoot(ctx.options.geminiHelper, ctx.home));
    if (!catalog.observed_at) return 'Gemini model catalog has not been refreshed';
    return `Google model list and pricing verified at ${catalog.observed_at}; ${Object.keys(catalog.models).length} current models; ${Object.keys(catalog.unavailable ?? {}).length} without verified pricing or limits`;
  },
  observeUsage,
  // The weekly row paces spend-down only; the helper's binding limit is its rolling 30-day budget.
  routeQuotaWindows: rows => rows.filter(row => !(row.pool === 'prepaid' && row.window === 'weekly')),
  estimatedCost(model, _effort, promptChars, options) {
    const rates = worstRates(readCatalog(registryRoot(options?.geminiHelper, options?.home)).models[model ?? MODELS.pro]);
    if (!rates) return null;
    const output = Number.isInteger(options?.max_output_tokens) ? Number(options!.max_output_tokens) : 8192;
    const input = Math.ceil(promptChars / 3);
    return { expectedUsd: rates.input * input + rates.output * Math.min(output, 2000),
      worstCaseUsd: (rates.input * input + rates.output * (output + THINKING_RESERVE)) * 1.15, basis: 'pricing' as const };
  },
  checkBudget({ model, promptChars, options, input, home }) {
    const estimate = geminiApi.estimatedCost!(model, null, promptChars, {
      home, geminiHelper: input.geminiHelper, max_output_tokens: options.max_output_tokens ?? input.max_output_tokens,
    });
    if (estimate?.worstCaseUsd === undefined)
      return fail('INVALID_INPUT', 400, 'The Gemini helper registry has no effective price for this model');
    // This is an estimate. The helper counts exact tokens before reserving or generating.
    if (estimate.worstCaseUsd > Number(options.max_cost_usd ?? input.max_cost_usd))
      fail('BUDGET_TOO_LOW', 400, 'The Gemini job ceiling cannot cover the estimated prompt and output reservation');
  },
  validate(input, job) {
    const model = job.model === undefined ? input.model ?? geminiApi.capabilities.defaultModel : job.model;
    if (typeof model !== 'string' || !model) fail('INVALID_INPUT', 400, 'gemini-api needs a model from the Gemini helper registry');
    const catalog = readCatalog(registryRoot(job.options?.geminiHelper, job.home));
    const replacement = catalog.superseded?.[model];
    if (replacement) fail('MODEL_SUPERSEDED', 400, `${model} was superseded by ${replacement}`);
    const entry = catalog.models[model];
    if (!worstRates(entry))
      fail('INVALID_INPUT', 400, `${model} has no effective price in the Gemini helper registry`);
    const cost = typeof input.max_cost_usd === 'number' ? String(input.max_cost_usd) : input.max_cost_usd;
    if (typeof cost !== 'string' || !/^\d{1,3}(\.\d{1,6})?$/.test(cost) || Number(cost) <= 0 || Number(cost) > 2)
      fail('INVALID_INPUT', 400, 'gemini-api jobs need max_cost_usd: a positive amount up to 2 (an explicit ceiling, not a target)');
    const tokens = input.max_output_tokens ?? 8192;
    if (!Number.isInteger(tokens) || tokens < 256 || tokens > 65536) fail('INVALID_INPUT', 400, 'max_output_tokens must be 256-65536');
    if (entry?.output_token_limit && tokens > entry.output_token_limit)
      fail('INVALID_INPUT', 400, `max_output_tokens exceeds the ${model} limit of ${entry.output_token_limit}`);
    return { max_cost_usd: cost, max_output_tokens: tokens,
      purpose: text(input.purpose, 'purpose (the concrete benefit of this request)', 1000), deliverable: text(input.deliverable, 'deliverable', 500) };
  },
  launch,
  reconcile,
};
