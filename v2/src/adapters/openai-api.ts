/**
 * openai-api: one Responses request through the original central OpenAI helper
 * (tools/openai-capabilities), which alone admits, reserves and accounts for spending. This
 * adapter never changes the helper and keeps no ledger of its own.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Json } from '../store.ts';
import { fail } from '../errors.ts';
import { text } from '../validate.ts';
import { type Active, type PlatformAdapter, type ProbeContext, type ProbeResult, type RouteCommand, type RunContext, type ReconcileContext, type UsageSnapshot } from './types.ts';
import { hashFile, helperCall, helperEnv, killTree, openOutputs, replyUsage } from './shared.ts';
import { metadataFamily } from './inventory.ts';
import type { ModelDiscoveries } from './types.ts';
import { defaultOpenAIHelperRoot, initialOpenAIRegistry, isRestrictedOpenAIModel, newestOpenAILines, openAIProfileSeeds, openAIModelSummary, readOpenAIModelStatus, readOpenAIRegistry, registryModelMap, registryRatesForModel, responsesRegistryModels, synchronizeOpenAIModels } from './openai-models.ts';
import { readPublicInventory, refreshPublicInventory } from './openai-public-inventory.ts';
import { ENTITLEMENT_ERROR_PATTERN, estimateExpectedCostUsd, estimateWorstCaseUsd, modelPricing } from './model-pricing.ts';
import { openAICreditUsage } from './openai-credits.ts';
import { sameCliPath } from './cli-freshness.ts';
import { readOpenAISdk, sdkPython, updateOpenAISdk } from './openai-sdk.ts';
import { DEFAULT_MAX_TURNS, MAX_TURNS, launchToolLoop, reconcileToolLoop, turnRequestId } from './openai-api-tools.ts';

const startupRegistry = initialOpenAIRegistry();
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

function helperRoot(helper?: RouteCommand, home?: string): string {
  return helper ? helper.cwd ?? path.dirname(helper.prefix?.[0] ?? helper.file) : defaultOpenAIHelperRoot(home);
}

function sdkRoot(ctx: ProbeContext): string | undefined {
  const helper = ctx.options.openaiHelper ?? resolveOpenAIHelper(defaultOpenAIHelperRoot(ctx.home));
  if (!helper) return;
  const root = path.resolve(helperRoot(helper, ctx.home));
  // Do not update a venv that the configured route does not actually use.
  if (sameCliPath(path.resolve(helper.file), sdkPython(path.join(root, '.venv')))) return root;
}

function registeredTiers(responses: Record<string, unknown>): string[] {
  const tiers = responses.tiers;
  if (!tiers || typeof tiers !== 'object' || Array.isArray(tiers)) return [];
  return Object.entries(tiers)
    .filter(([, rates]) => rates && typeof rates === 'object' && !Array.isArray(rates))
    .map(([tier]) => tier).sort();
}

/** The maintained helper under tools/openai-capabilities in the AgentCommons checkout, unless config overrides it. */
export function resolveOpenAIHelper(root = defaultOpenAIHelperRoot()): RouteCommand | undefined {
  const python = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const script = path.join(root, 'run.py');
  return fs.existsSync(python) && fs.existsSync(script) ? { file: python, prefix: [script], cwd: root } : undefined;
}

/**
 * The v2 job ID is the helper's external_request_id, so the same job can never be submitted twice. Admission
 * refusals spend nothing; an unclear outcome (uncertain, cancelled or timed out mid-request) is left for review,
 * never retried.
 */
function launch(job: Json, ctx: RunContext): void {
  const helper = ctx.options.openaiHelper ?? resolveOpenAIHelper(defaultOpenAIHelperRoot(ctx.home));
  if (!helper) return ctx.finish('failed', { error: 'ROUTE_EXECUTABLE_NOT_FOUND' });
  // A job with a tool set runs as a tool loop: several helper requests, one per turn.
  if (job.options?.toolset) return launchToolLoop(job, ctx, helper);
  const o = job.options ?? {};
  const request = { capability: 'responses', external_request_id: o.patch_turn ? turnRequestId(job.id, o.patch_turn) : job.id, model: job.model, tier: o.tier, max_cost_usd: o.max_cost_usd,
    local_timeout_seconds: Math.min(900, Math.max(1, Math.floor(job.timeout_ms / 1000) - 30)),
    purpose: { kind: 'coding_assistance', description: o.purpose, deliverable: o.deliverable },
    payload: { input: job.prompt, max_output_tokens: o.max_output_tokens, ...(job.effort ? { reasoning: { effort: job.effort } } : {}) } };
  const requestFile = path.join(ctx.dir, 'request.json');
  fs.writeFileSync(requestFile, JSON.stringify(request, null, 2));
  if (!o.patch_turn) ctx.store.updateJob(job.id, { workdir: helper.cwd ?? null });
  const [stdout, stderr] = openOutputs(ctx.dir);
  const timer = setTimeout(() => { const a = ctx.active(); if (a && !a.reason) { a.reason = 'TIMEOUT'; if (a.child?.pid) killTree(a.child.pid); } }, job.timeout_ms);
  const active: Active = { timer };
  ctx.track(active);
  const current = () => ctx.active() === active;
  let submitted = false;
  const run = async () => {
    // Admission needs cost evidence under five minutes old; refreshing it is a read-only account call.
    const costs = await helperCall(helper, ['refresh-costs']);
    fs.writeSync(stderr, `refresh-costs exit ${costs.code}: ${JSON.stringify(costs.reply)?.slice(0, 1000)}\n`);
    // stop() already recorded the job (conservatively, as needs_review): never hand it to the helper afterwards.
    if (!current()) { fs.closeSync(stdout); fs.closeSync(stderr); return; }
    if (active.reason) { fs.closeSync(stdout); fs.closeSync(stderr); return finishInterrupted(ctx, null); }
    let child: ChildProcess;
    try {
      child = spawn(helper.file, [...(helper.prefix ?? []), 'invoke', '--request', requestFile],
        { cwd: helper.cwd, env: helperEnv(), stdio: ['ignore', stdout, stderr], windowsHide: true, detached: process.platform !== 'win32' });
    } catch (error) {
      fs.closeSync(stdout); fs.closeSync(stderr); clearTimeout(timer);
      return ctx.finish('failed', { error: 'SPAWN_FAILED_BEFORE_SUBMISSION: ' + String((error as Error).message).slice(0, 300) });
    }
    submitted = true; active.child = child;
    child.on('error', error => { if (!active.reason) active.reason = 'SPAWN_FAILED: ' + error.message; });
    child.on('close', code => {
      clearTimeout(timer); fs.closeSync(stdout); fs.closeSync(stderr);
      if (!current()) return;
      // No pid means the helper process never started, so the request cannot have been sent.
      if (child.pid === undefined) return ctx.finish('failed', { exit_code: code, error: `${active.reason ?? 'SPAWN_FAILED'}_BEFORE_SUBMISSION` });
      try { complete(ctx, code, active.reason, job.model); }
      catch (error) { ctx.finish('needs_review', { exit_code: code, error: 'RESULT_RECORDING_FAILED: ' + String((error as Error).message).slice(0, 300) }); }
    });
    ctx.store.updateJob(job.id, { pid: child.pid ?? null });
  };
  run().catch(error => {
    if (!submitted) for (const fd of [stdout, stderr]) try { fs.closeSync(fd); } catch { /* already closed */ }
    if (!current()) return;
    // Before the spawn nothing reached the helper; after it, the request may have been sent.
    try { ctx.finish(submitted ? 'needs_review' : 'failed', { error: (submitted ? 'HELPER_LAUNCH_FAILED: ' : 'HELPER_LAUNCH_FAILED_BEFORE_SUBMISSION: ') + String((error as Error).message).slice(0, 300) }); }
    catch (inner) { console.error(JSON.stringify({ event: 'runner.api_launch_failed', job: job.id, error: String((inner as Error)?.message ?? inner) })); }
  });
}

function finishInterrupted(ctx: RunContext, code: number | null): void {
  const active = ctx.active();
  if (active) clearTimeout(active.timer);
  // Stopped before the request was handed to the helper: nothing was submitted.
  ctx.finish(active?.reason === 'CANCELLED' ? 'cancelled' : 'failed', { exit_code: code, error: (active?.reason ?? 'INTERRUPTED') + '_BEFORE_SUBMISSION' });
}

function complete(ctx: RunContext, code: number | null, reason?: string, model?: string): void {
  let reply: Json | null = null;
  try { reply = JSON.parse(fs.readFileSync(path.join(ctx.dir, 'stdout.json'), 'utf8')); } catch { /* handled below */ }
  const recorded = { exit_code: code, helper_job_id: reply?.job_id ?? null, cost_usd: reply?.cost_usd ?? null, ...replyUsage(reply ?? {}) };
  if (reply?.status === 'completed') {
    const output = typeof reply.output === 'string' ? reply.output : JSON.stringify(reply.output ?? null);
    if (model) ctx.store.markModelValidated(openaiApi.capabilities.id, model);
    return ctx.finish('completed', { ...recorded, result: output });
  }
  // Refused at admission, before any helper job existed: nothing was submitted or spent.
  if (reply?.status === 'blocked' && !reply.job_id) {
    const detail = String(reply.error_code ?? 'unknown');
    if (model && (detail === 'model_not_found' || detail === 'unsupported_model' || ENTITLEMENT_ERROR_PATTERN.test(String(reply.error ?? detail)))) {
      ctx.store.markModelUnentitled(openaiApi.capabilities.id, model, String(reply.error ?? detail));
    }
    return ctx.finish('failed', { ...recorded, error: `HELPER_BLOCKED: ${detail}` });
  }
  // The provider answered with a known, unusable outcome; the helper has accounted for it.
  if (['failed', 'refused', 'invalid_result', 'incomplete', 'partial'].includes(reply?.status) && reply?.job_id) {
    // For incomplete responses the helper passes through the provider's incomplete_details (reason such as
    // max_output_tokens or content_filter); automatic repair relies on that explicit reason, never on length.
    const detail = reply!.status === 'incomplete' ? reply!.output?.incomplete_details?.reason : undefined;
    const reason = typeof detail === 'string' && /^[a-z_]{1,64}$/.test(detail) ? detail : null;
    return ctx.finish('failed', { ...recorded, error: `HELPER_${String(reply!.status).toUpperCase()}: ${reason ?? reply!.error_code ?? 'see helper job'}` });
  }
  // Anything else (uncertain, a kill mid-request, unparseable output) may have reached the provider.
  ctx.finish('needs_review', { ...recorded,
    error: `${reason ?? 'HELPER_OUTCOME_UNCLEAR'}: helper status ${reply?.status ?? 'unknown'}; reservation may be held until the helper reconciles it` });
}

/** After a service restart: record the helper's outcome if it has one. Never resubmits. */
async function reconcile(job: Json, ctx: ReconcileContext): Promise<void> {
  const home = ctx.home ?? ctx.store.home;
  const helper = ctx.options.openaiHelper ?? resolveOpenAIHelper(defaultOpenAIHelperRoot(home));
  if (!helper) return;
  if (job.options?.patch_edit) {
    const state = job.options.patch_state;
    if (state?.phase !== 'worker') return;
    const { reply } = await helperCall(helper, ['lookup', '--external-request-id', turnRequestId(job.id, state.turn)]);
    if (reply?.status) ctx.store.annotateJob(job.id, { patch_reconciled_turn: { turn: state.turn, status: reply.status,
      helper_job_id: reply.job_id ?? null, cost_usd: reply.cost_usd ?? null } });
    return;
  }
  if (job.options?.toolset) return reconcileToolLoop(job, ctx, helper);
  const { reply } = await helperCall(helper, ['lookup', '--external-request-id', job.id]);
  if (reply?.status !== 'completed' || typeof reply.artifact !== 'string') {
    if (reply?.status) ctx.store.updateJob(job.id, { helper_job_id: reply.job_id ?? null, error: `SERVICE_STOPPED_DURING_JOB; helper status ${reply.status}` });
    return;
  }
  let output: unknown = null;
  try { output = JSON.parse(fs.readFileSync(reply.artifact, 'utf8')).output; } catch { /* keep needs_review */ }
  if (output === null) return;
  ctx.store.updateJob(job.id, { status: 'completed', error: null, helper_job_id: reply.job_id ?? null, cost_usd: reply.cost_usd ?? null,
    result: (typeof output === 'string' ? output : JSON.stringify(output)) });
  if (job.model) ctx.store.markModelValidated(openaiApi.capabilities.id, job.model);
}

/** Public docs, project model visibility, and the helper's Responses registry remain separate evidence. */
async function discover(ctx: ProbeContext): Promise<ModelDiscoveries> {
  const helper = ctx.options.openaiHelper ?? resolveOpenAIHelper(defaultOpenAIHelperRoot(ctx.home));
  if (!helper) throw new Error('central helper not found; model registry could not be read');
  const root = helperRoot(helper, ctx.home);
  const inventory = ctx.overrides.openaiModelRefresh !== false
    ? await refreshPublicInventory(ctx.home, root, helper, ctx.overrides.openaiFetch)
    : readPublicInventory(ctx.home);
  if (ctx.overrides.openaiModelRefresh !== false)
    await synchronizeOpenAIModels({ home: ctx.home, root, fetch: ctx.overrides.openaiFetch, excluded: inventory.excluded });
  const registry = readOpenAIRegistry(root);
  const previous = openaiApi.profiles.map(seed => ({ ...seed }));
  const seeds = openAIProfileSeeds(registry).map(seed => {
    const old = previous.find(candidate => candidate.intent === seed.intent && candidate.eff === seed.eff);
    return { ...seed, previousSeeds: [...(seed.previousSeeds ?? []), ...(old?.model ? [{ native_model: old.model, native_effort: old.effort }] : [])] };
  });
  openaiApi.profiles.splice(0, openaiApi.profiles.length, ...seeds);
  openaiApi.capabilities.defaultModel = newestOpenAILines(registry).sol ?? null;
  const models = registryModelMap(registry);
  const rows: ModelDiscoveries = responsesRegistryModels(registry).filter(({ model }) =>
    !isRestrictedOpenAIModel(model)).map(({ model, responses }) => ({
    model, family: metadataFamily(models[model], model), efforts: [...EFFORTS],
    tiers: registeredTiers(responses), state: 'verified', source: 'registry',
  }));
  rows.completeSources = ['registry'];
  return rows;
}

/**
 * Presence only: the helper's files exist (and a hash of its entry script, to notice helper updates). No helper
 * command runs, not even an account read: the helper checks admission on every request anyway.
 */
async function probe(ctx: ProbeContext): Promise<ProbeResult> {
  const helper = ctx.options.openaiHelper ?? resolveOpenAIHelper(defaultOpenAIHelperRoot(ctx.home));
  if (!helper) return { state: 'unavailable', reason: 'central OpenAI helper not found' };
  const script = helper.prefix?.[0] ?? helper.file;
  const root = helperRoot(helper, ctx.home);
  return { state: 'verified', binarySha256: fs.existsSync(script) ? await hashFile(script) : null,
    reason: 'helper present; it admits each request itself; ' + openAIModelSummary(ctx.home, root) };
}

/** `credits` reads local helper state. Do not refresh provider costs or balances here. */
async function observeUsage(ctx: ProbeContext): Promise<UsageSnapshot | undefined> {
  const helper = ctx.options.openaiHelper ?? resolveOpenAIHelper(defaultOpenAIHelperRoot(ctx.home));
  if (!helper) return;
  const { code, reply } = await helperCall(helper, ['credits']);
  return openAICreditUsage(code === 0 ? reply : null);
}

export const openaiApi: PlatformAdapter = {
  capabilities: { id: 'openai-api', family: 'openai', transport: 'helper', billing: 'paid', modes: ['advice'], supportsShellInEdit: false, hasWorkspaceReadTools: false,
    maxPromptChars: 200000, maxTimeoutMinutes: 15, defaultTimeoutMinutes: 10, quotaGroup: 'openai-api', defaultModel: newestOpenAILines(startupRegistry).sol ?? (startupRegistry.__agentCommonsFallback === true ? 'gpt-6.2-sol' : null), maxConcurrent: 1, maxConcurrentCeiling: 8, short: 'api' },
  profiles: openAIProfileSeeds(startupRegistry),
  probe,
  discover,
  observeUsage,
  estimatedCost(model: string | null, effort: string | null, promptChars: number, options?: Json) {
    const resolvedModel = model ?? openaiApi.capabilities.defaultModel ?? 'gpt-6.2-sol';
    const tier = typeof options?.tier === 'string' ? options.tier : 'default';
    let rates: { input: number; output: number } | null = null;
    try { rates = registryRatesForModel(readOpenAIRegistry(helperRoot(options?.openaiHelper, typeof options?.home === 'string' ? options.home : undefined)), resolvedModel, tier); } catch { /* fallback below */ }
    const fromRegistry = rates !== null;
    rates ??= modelPricing(resolvedModel);
    if (!rates) return null;
    const toolChars = options?.toolset ? 7000 : 0;
    const maxTokens = Number.isInteger(options?.max_output_tokens) ? Number(options!.max_output_tokens) : undefined;
    return {
      expectedUsd: estimateExpectedCostUsd(rates, promptChars + toolChars, effort),
      ...(maxTokens !== undefined ? { worstCaseUsd: estimateWorstCaseUsd(rates, promptChars + toolChars, maxTokens) } : {}),
      basis: (fromRegistry ? 'pricing' : 'weight') as 'pricing' | 'weight',
    };
  },
  checkBudget({ model, promptChars, options, input, home }) {
    const resolvedModel = model ?? openaiApi.capabilities.defaultModel;
    if (!resolvedModel) return;
    const tier = String(options.tier ?? input.tier ?? 'default');
    const tokens = Number(options.max_output_tokens ?? input.max_output_tokens ?? 8192);
    const ceiling = Number(options.max_cost_usd ?? input.max_cost_usd);
    if (!Number.isFinite(ceiling) || ceiling <= 0) return;
    let rates: { input: number; output: number } | null = null;
    try { rates = registryRatesForModel(readOpenAIRegistry(helperRoot(input.openaiHelper ?? options.openaiHelper, home)), resolvedModel, tier); } catch { /* unverified rate skips budget refusal */ }
    if (!rates) return;
    const toolChars = options.toolset || input.tools ? 7000 : 0;
    const estimated = estimateWorstCaseUsd(rates, promptChars + toolChars, tokens);
    if (estimated > ceiling) {
      const suggestedUsd = (Math.ceil(estimated * 100) / 100).toFixed(2);
      fail('BUDGET_TOO_LOW', 400,
        `${resolvedModel} (${tier}, max_output_tokens=${tokens}) worst-case turn-1 reservation is ~$${estimated.toFixed(4)}, `
        + `exceeding max_cost_usd=$${ceiling}; raise max_usd to at least ${suggestedUsd}, lower max_tok, or use intent=fast eff=low / a lower-cost model`);
    }
  },
  sdk: {
    async inspect(ctx) {
      const root = sdkRoot(ctx);
      return root ? readOpenAISdk(root, ctx.overrides.openaiSdkRun, ctx.overrides.openaiSdkFetch)
        : { installed: null, latest: null };
    },
    async update(ctx) {
      const root = sdkRoot(ctx);
      if (!root) throw new Error('helper venv is unavailable');
      await updateOpenAISdk(root, ctx, ctx.overrides.openaiSdkRun);
    },
  },
  discoverySummary(ctx) {
    const helper = ctx.options.openaiHelper ?? resolveOpenAIHelper(defaultOpenAIHelperRoot(ctx.home));
    return openAIModelSummary(ctx.home, helperRoot(helper, ctx.home));
  },
  activeModels(ctx) {
    try {
      const helper = ctx.options?.openaiHelper ?? resolveOpenAIHelper(defaultOpenAIHelperRoot(ctx.home));
      const flagged = new Set(readOpenAIModelStatus(ctx.home).flagged);
      return responsesRegistryModels(readOpenAIRegistry(helperRoot(helper, ctx.home)))
        .map(entry => entry.model)
        .filter(model => !isRestrictedOpenAIModel(model) && !flagged.has(model));
    } catch { return []; }
  },
  validate(input, job) {  // modes and time limits are enforced by the store from capabilities
    const model = job.model === undefined ? input.model ?? openaiApi.capabilities.defaultModel : job.model;
    if (typeof model !== 'string' || !model)
      fail('INVALID_INPUT', 400, 'openai-api needs a Responses model from the central helper registry');
    if (isRestrictedOpenAIModel(model))
      fail('MODEL_UNAVAILABLE', 400, 'This OpenAI model is outside the public API route inventory');
    const effort = job.effort === undefined ? input.effort : job.effort;
    if (effort != null && !EFFORTS.some(allowed => allowed === effort))
      fail('INVALID_INPUT', 400, `openai-api effort must be one of ${EFFORTS.join(', ')}`);
    const tier = input.tier ?? 'default';
    if (tier !== 'flex' && tier !== 'default')
      fail('INVALID_INPUT', 400, 'openai-api tier must be default or flex (batch is asynchronous)');
    let registered: ReturnType<typeof responsesRegistryModels>;
    try { registered = responsesRegistryModels(readOpenAIRegistry(helperRoot(job.options?.openaiHelper, job.home))); }
    catch { return fail('ROUTE_UNAVAILABLE', 503, 'openai-api cannot read the central helper model registry'); }
    const entry = registered.find(candidate => candidate.model === model);
    if (!entry) return fail('INVALID_INPUT', 400, `${model} is not a Responses model in the central helper registry`);
    if (tier === 'flex' && !registeredTiers(entry.responses).includes('flex'))
      fail('INVALID_INPUT', 400, `${model} has no flex pricing in the central helper registry`);
    // The original central helper admits and accounts for all API spending; these fields are what it requires.
    const cost = typeof input.max_cost_usd === 'number' ? String(input.max_cost_usd) : input.max_cost_usd;
    if (typeof cost !== 'string' || !/^\d{1,3}(\.\d{1,6})?$/.test(cost) || Number(cost) <= 0 || Number(cost) > 25)
      fail('INVALID_INPUT', 400, 'openai-api jobs need max_cost_usd: a positive amount up to 25 (an explicit ceiling, not a target)');
    const tokens = input.max_output_tokens ?? 8192;
    if (!Number.isInteger(tokens) || tokens < 256 || tokens > 65536) fail('INVALID_INPUT', 400, 'max_output_tokens must be 256-65536');
    // Tool loops (tools=<set>): max_turns caps the helper requests; max_cost_usd covers all of them.
    const turns = input.max_turns ?? (input.tools ? DEFAULT_MAX_TURNS : undefined);
    if (turns !== undefined && !input.tools) fail('INVALID_INPUT', 400, 'max_turns needs tools=<set>');
    if (turns !== undefined && (!Number.isInteger(turns) || turns < 1 || turns > MAX_TURNS)) fail('INVALID_INPUT', 400, `max_turns must be 1-${MAX_TURNS}`);
    return { max_cost_usd: cost, max_output_tokens: tokens, tier, ...(turns !== undefined ? { max_turns: turns } : {}),
      purpose: text(input.purpose, 'purpose (the concrete benefit of this request)', 1000), deliverable: text(input.deliverable, 'deliverable', 500) };
  },
  launch,
  reconcile,
};
