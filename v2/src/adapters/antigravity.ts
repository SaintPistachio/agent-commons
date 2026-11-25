/**
 * antigravity: one reasoning-only Run through Agent Commons' own copy of the guarded antigravity helper
 * (v2/helpers/antigravity, shipped with each release, never modified here) on the included Google AI quota.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Json } from '../store.ts';
import { fail } from '../errors.ts';
import { optText } from '../validate.ts';
import { profileGrid, type Active, type PlatformAdapter, type ProbeContext, type ProbeResult, type RouteCommand, type RunContext, type UsageObservation, type UsageSnapshot, type UsageWindow } from './types.ts';
import { hashFile, helperCall, killTree, openOutputs, replyUsage, workerEnv } from './shared.ts';
import { metadataEfforts, metadataFamily, metadataModel, metadataModels } from './inventory.ts';
import { acceptedAntigravityIdentity, antigravityInventorySummary, currentAntigravityProfiles, profileState,
  projectAntigravityInventory, saveAntigravityInventory, type SeedProfile } from './antigravity-inventory.ts';
import { ENTITLEMENT_ERROR_PATTERN, estimateExpectedCostUsd, modelPricing } from './model-pricing.ts';
import {
  acpInventorySummary,
  launchAntigravityAcp,
  probeAntigravityAcp,
  projectAcpDiscoveries,
  resolveAntigravityAcp,
  saveAcpCatalog,
} from './antigravity-acp.ts';
import type { Consumption, ConsumptionRun, ModelDiscoveries, ModelDiscovery, PoolEvidence } from './types.ts';

/**
 * antigravity-helper refusals raised before it starts any CLI run: identity and activation, local setup
 * (preflight), quota and model selection. They count only when the reply also has no run fields.
 */
const PRE_RUN_GATES = new Set(['NO_ELIGIBLE_MODEL', 'REVALIDATION_REQUIRED', 'REVALIDATION_BUSY', 'NOT_ACTIVATED', 'QUOTA_EXHAUSTED', 'QUOTA_UNKNOWN', 'MODEL_UNAVAILABLE',
  'INVALID_INPUT', 'SETUP_MISSING', 'CREDITS_ENABLED', 'HOOKS_CONFIGURED', 'AUTH_OVERRIDE',
  'AMBIENT_CUSTOMIZATIONS', 'MCP_CONFIGURED']);

function seedProfiles(): SeedProfile[] {
  // Read-only: the helper owns its catalog, validation and approval records.
  const file = fileURLToPath(new URL('../../helpers/antigravity/routing-seed.json', import.meta.url));
  try {
    const seed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(seed.profiles) ? seed.profiles.filter((p: SeedProfile) =>
      typeof p.model === 'string' && typeof p.family === 'string' && Array.isArray(p.tasks)
      && Array.isArray(p.quota_limits) && p.quota_limits.length > 0) : [];
  } catch { return []; }
}

function availableProfiles(home?: string): SeedProfile[] {
  return (home ? currentAntigravityProfiles(home) : undefined) ?? seedProfiles();
}

function vendor(model: unknown): string | null {
  if (typeof model !== 'string') return null;
  if (model.startsWith('claude-')) return 'anthropic';
  if (model.startsWith('gpt-')) return 'openai';
  if (model.startsWith('gemini-')) return 'google';
  return null;
}

function quotaUsage(reply: Json): UsageObservation[] {
  const rows = Array.isArray(reply.quota_after) ? reply.quota_after
    : Array.isArray(reply.quota_before) ? reply.quota_before : [];
  const observed = reply.observed_at_utc ?? reply.completed_at_utc;
  return rows.filter((row: Json) => row && typeof row.group === 'string' && typeof row.limit === 'string'
    && (row.remaining_percent === null || (typeof row.remaining_percent === 'number'
      && Number.isFinite(row.remaining_percent) && row.remaining_percent >= 0 && row.remaining_percent <= 100))
    && (row.resets_at === null || (typeof row.resets_at === 'string' && Number.isFinite(Date.parse(row.resets_at)))))
    .map((row: Json) => ({
      pool: row.group, window: row.limit, remaining_percent: row.remaining_percent, resets_at: row.resets_at,
      ...(typeof observed === 'string' && Number.isFinite(Date.parse(observed)) ? { observed_at: observed } : {}),
    }));
}

function mergedUsage(job: Json, ctx: RunContext, reply: Json): UsageWindow[] {
  const key = (row: UsageObservation) => JSON.stringify([row.pool, row.window]);
  const rows = new Map(ctx.usage().map(row => [key(row), row]));
  const at = Date.now();
  for (const observation of quotaUsage(reply)) {
    const observed_at = observation.observed_at ?? new Date(at).toISOString();
    const previous = rows.get(key(observation));
    if (previous && Date.parse(previous.observed_at) > Date.parse(observed_at)) continue;
    const stale = at - Date.parse(observed_at) > 6 * 60 * 60 * 1000
      || (observation.resets_at !== null && Date.parse(observation.resets_at) <= at);
    rows.set(key(observation), { ...observation, route: job.route, observed_at, source: 'reply', stale,
      remaining_percent: stale ? null : observation.remaining_percent });
  }
  return [...rows.values()];
}

/** Adds a scoped exhaustion observation when a refusal did not include its updated quota row. */
function exhaustionReply(job: Json, ctx: RunContext, reply: Json): Json {
  if (reply.error_code !== 'QUOTA_EXHAUSTED') return reply;
  const profiles = availableProfiles(ctx.home);
  const message = String(reply.error ?? '');
  const groups = [...new Set(profiles.flatMap(p => p.quota_limits.map(q => q.group)))];
  const model = reply.reported_model ?? reply.selected_model ?? job.model;
  const pool = groups.find(group => message.toLowerCase().includes(group.toLowerCase()))
    ?? (/\bargon\b/i.test(message) ? 'Gemini 4 Argon'
      : /\bgemini\b/i.test(message) ? 'Gemini Models'
      : /\b(claude|gpt)\b/i.test(message) ? 'Claude and GPT models' : undefined)
    ?? reply.selection?.group
    ?? profiles.find(p => p.model === model)?.group;
  if (typeof pool !== 'string') return reply;
  const observations = quotaUsage(reply);
  if (observations.some(row => row.pool === pool && row.remaining_percent === 0)) return reply;
  const limits = [...new Set(profiles.flatMap(p => p.quota_limits)
    .filter(q => q.group === pool).map(q => q.limit))];
  const window = limits.find(limit => /\bweek/i.test(message) && /week/i.test(limit))
    ?? limits.find(limit => /\b(hour|five)\b/i.test(message) && /hour/i.test(limit))
    ?? 'exhaustion';
  const existing = [...observations, ...ctx.usage()].find(row => row.pool === pool && row.window === window);
  const iso = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})/.exec(message)?.[0];
  const reset = reply.resets_at ?? existing?.resets_at ?? iso;
  const resets_at = typeof reset === 'string' && Date.parse(reset) > Date.now() ? reset : null;
  const base = Array.isArray(reply.quota_after) ? reply.quota_after
    : Array.isArray(reply.quota_before) ? reply.quota_before : [];
  return { ...reply, quota_after: [...base, { group: pool, limit: window, remaining_percent: 0, resets_at }] };
}

const EFFORT_RANK = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** A stable, comparable window is evidence even when it did not decrease. A reset is neither. */
function consumption(reply: Json): Consumption | undefined {
  if (!Array.isArray(reply.quota_before) || !Array.isArray(reply.quota_after)) return undefined;
  const model = typeof reply.reported_model === 'string' ? reply.reported_model : reply.selected_model;
  if (typeof model !== 'string' || !model.trim()) return undefined;
  const profile = seedProfiles().find(p => p.model === model || p.family === model);
  const family = profile?.family ?? model.replace(/-(minimal|low|medium|high|xhigh|max)$/, '');
  const before = quotaUsage({ quota_after: reply.quota_before });
  const after = quotaUsage({ quota_after: reply.quota_after });
  const key = (row: { pool: string; window: string }) => JSON.stringify([row.pool, row.window]);
  const previous = new Map(before.map(row => [key(row), row]));
  const rows: Consumption['rows'] = [];
  for (const row of after) {
    const prior = previous.get(key(row));
    if (!prior || prior.remaining_percent === null || row.remaining_percent === null) continue;
    const reset = (value: string | null) => value === null ? null : Date.parse(value);
    if (reset(prior.resets_at) !== reset(row.resets_at) || row.remaining_percent > prior.remaining_percent) continue;
    rows.push({ pool: row.pool, window: row.window, consumed: row.remaining_percent < prior.remaining_percent });
  }
  return rows.length ? { family, rows } : undefined;
}

/** Reads saved adapter output only; no helper process, provider call, or replay. */
function backfillConsumption(job: { id: string }, home: string): Consumption | undefined {
  try {
    const reply = JSON.parse(fs.readFileSync(path.join(home, 'jobs', job.id, 'stdout.json'), 'utf8'));
    if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return undefined;
    return consumption(reply);
  } catch { return undefined; }
}

interface PoolRequirement {
  pool: string;
  windows: string[];
  required: boolean;
  basis: 'evidence' | 'seed-unverified';
  reason: string;
  verified_runs?: number;
}

/**
 * Never infer non-consumption from aggregate counters alone. Each supporting job must compare all
 * seed-required windows of this pool and consume another required pool in that very same job.
 * One observed consumption permanently defeats a non-consumption inference.
 */
function familyRequirements(family: string, profiles: SeedProfile[], evidence: PoolEvidence[], runs: ConsumptionRun[]): PoolRequirement[] {
  const seed = profiles.filter(p => p.family === family).flatMap(p => p.quota_limits);
  const observed = evidence.filter(row => row.family === family);
  const consumed = observed.filter(row => row.consumed_runs > 0);
  const pools = [...new Set([...seed.map(row => row.group), ...consumed.map(row => row.pool)])];
  const requiredPools = new Set(pools);
  return pools.map(pool => {
    const seedWindows = [...new Set(seed.filter(row => row.group === pool).map(row => row.limit))];
    const consumedWindows = consumed.filter(row => row.pool === pool).map(row => row.window);
    const windows = [...new Set([...seedWindows, ...consumedWindows])];
    if (consumedWindows.length) return { pool, windows, required: true, basis: 'evidence', reason: 'observed consumption' };
    const supporting = runs.filter(run => run.family === family
      && seedWindows.length > 0
      && seedWindows.every(window => run.rows.some(row => row.pool === pool && row.window === window && !row.consumed))
      && !run.rows.some(row => row.pool === pool && row.consumed)
      && run.rows.some(row => row.pool !== pool && requiredPools.has(row.pool) && row.consumed)).length;
    if (supporting >= 2) return {
      pool, windows, required: false, basis: 'evidence',
      reason: `not consumed (verified by ${supporting} runs)`, verified_runs: supporting,
    };
    return { pool, windows, required: true, basis: 'seed-unverified', reason: 'helper seed; consumption requirement unverified' };
  });
}

function routingProfiles(job: Json, ctx: RunContext): { profiles: SeedProfile[]; requirements: Map<string, PoolRequirement[]> } {
  const seed = availableProfiles(ctx.home);
  const evidence = ctx.store.poolEvidence(job.route);
  const runs = ctx.store.consumptionRuns(job.route);
  const requirements = new Map([...new Set(seed.map(p => p.family))]
    .map(family => [family, familyRequirements(family, seed, evidence, runs)] as const));
  const profiles = seed.map(profile => ({
    ...profile,
    quota_limits: requirements.get(profile.family)!.filter(row => row.required)
      .flatMap(row => row.windows.map(limit => ({ group: row.pool, limit }))),
  }));
  return { profiles, requirements };
}

function poolEvidenceStatus(evidence: PoolEvidence[], runs: ConsumptionRun[]): string[] {
  const lines: string[] = [];
  const seed = seedProfiles();
  for (const family of [...new Set(evidence.map(row => row.family))].sort()) {
    const requirements = familyRequirements(family, seed, evidence, runs);
    const familyRuns = runs.filter(run => run.family === family);
    for (const pool of [...new Set(evidence.filter(row => row.family === family).map(row => row.pool))].sort()) {
      const compared = familyRuns.filter(run => run.rows.some(row => row.pool === pool));
      const consumedRuns = compared.filter(run => run.rows.some(row => row.pool === pool && row.consumed)).length;
      const requirement = requirements.find(row => row.pool === pool);
      const description = consumedRuns
        ? `consumed (${consumedRuns}/${compared.length} runs)`
        : requirement?.required === false
          ? `${requirement.reason}; ${compared.length} compared runs`
          : `not consumed (${compared.length} runs; unverified)`;
      lines.push(`${family} / ${pool}: ${description}`);
      if (requirement?.required === false) lines.push(
        `WARN ${family}: helper seed requires ${pool} but ${requirement.verified_runs} runs show it is not consumed; the helper itself may still refuse ${family} when ${pool} reaches 0%`);
    }
  }
  return lines;
}

function fitAntigravityEffort(profiles: SeedProfile[], task: string, requestedEffort?: string | null): {
  effort?: string; fit?: { requested: string; used: string; reason: string };
} {
  const forTask = profiles.filter(p => p.tasks.includes(task));
  if (!requestedEffort || !forTask.length || forTask.some(p => p.effort === requestedEffort)) {
    return requestedEffort ? { effort: requestedEffort } : {};
  }
  const rank = (e: string) => EFFORT_RANK.indexOf(e);
  const efforts = [...new Set(forTask.map(p => p.effort))].sort((a, b) => rank(a) - rank(b));
  const fitted = efforts.find(e => rank(e) > rank(requestedEffort)) ?? efforts[efforts.length - 1];
  return { effort: fitted, fit: { requested: requestedEffort, used: fitted, reason: `no validated ${task} model at ${requestedEffort}` } };
}

function steer(job: Json, ctx: RunContext): { family?: string; effort?: string; error?: string } {
  const o = job.options ?? {};
  const explicit = job.model_family ?? o.model_family ?? o.family;
  const isReview = !!(o.review_for || job.trigger === 'auto_review');
  const target = isReview ? ctx.reviewFamily() : null;
  const independent = !!target;
  if (job.model || explicit) {
    if (independent && [job.model, explicit].some(model => vendor(model) === target))
      return { error: 'AG_NO_INDEPENDENT_POOL' };
    return typeof explicit === 'string' ? { family: explicit } : {};
  }

  const task = o.task ?? 'explain';
  // Capability and effort are eligibility constraints, not a claim that one vendor is better.
  // The helper validates exact task/effort pairs. When the requested effort has none for this task, use the nearest
  // validated effort above it (never below while a higher one exists), so the job runs at the right level first time.
  const routing = routingProfiles(job, ctx);
  const forTask = routing.profiles.filter(p => p.tasks.includes(task));
  const fitted = fitAntigravityEffort(routing.profiles, task, job.effort ?? undefined);
  let effort = fitted.effort;
  if (fitted.fit) ctx.annotate({ ag_effort_fit: fitted.fit });
  const profiles = forTask.filter(p => !effort || p.effort === effort);
  if (!profiles.length) return independent ? { error: 'AG_NO_INDEPENDENT_POOL' } : { effort };
  const eligible = profiles.filter(p => !independent || vendor(p.family) !== target);
  if (!eligible.length) return { error: 'AG_NO_INDEPENDENT_POOL' };
  const rows = ctx.usage();
  const open = eligible.filter(p => profileState(p, rows) === 'open');
  const unknown = eligible.filter(p => profileState(p, rows) === 'unknown');
  // Unknown quota is not exhaustion. For independent work we must still pin the family,
  // otherwise the helper could choose the vendor being reviewed.
  const candidates = open.length ? open : independent ? unknown : [];
  if (!candidates.length) {
    if (independent) return { error: 'AG_NO_INDEPENDENT_POOL' };
    return unknown.length ? { effort } : { error: 'AG_NO_OPEN_POOL' };
  }
  const nextReset = (profile: SeedProfile): number => Math.min(...profile.quota_limits.map(required => {
    const row = rows.find(r => r.pool === required.group && r.window === required.limit);
    return row?.resets_at ? Date.parse(row.resets_at) : Infinity;
  }));
  candidates.sort((a, b) => {
    const ar = nextReset(a), br = nextReset(b);
    if (ar !== br) return ar < br ? -1 : 1;
    // In the helper seed, a lower task preference number is preferred.
    return (a.task_preferences?.[task] ?? Infinity) - (b.task_preferences?.[task] ?? Infinity);
  });
  const chosen = candidates[0];
  ctx.annotate({ ag_steer: {
    family: chosen.family,
    reason: independent
      ? `Validated task/effort; independent ${open.length ? 'open' : 'unknown quota'} pool, earliest known reset, then helper preference.`
      : 'Validated task/effort; open pool, earliest known reset, then helper preference.',
    pools: [...new Set(chosen.quota_limits.map(q => q.group))],
    requirements: routing.requirements.get(chosen.family) ?? [],
  } });
  return { family: chosen.family, effort };
}

/**
 * Agent Commons' own copy of the antigravity helper (v2/helpers/antigravity, shipped with this release), run with
 * PowerShell 7. Nothing is read from another app's folders, so app updates cannot remove it.
 */
export function resolveAntigravity(): RouteCommand | undefined {
  const script = fileURLToPath(new URL('../../helpers/antigravity/scripts/Invoke-Antigravity.ps1', import.meta.url));
  if (!fs.existsSync(script)) return undefined;
  let pwsh = process.platform === 'win32' ? path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'PowerShell', '7', 'pwsh.exe') : 'pwsh';
  if (process.platform === 'win32' && !fs.existsSync(pwsh)) {
    try { pwsh = execFileSync('where.exe', ['pwsh'], { encoding: 'utf8' }).split(/\r?\n/)[0]?.trim() ?? ''; } catch { return undefined; }
    if (!pwsh) return undefined;
  }
  return { file: pwsh, prefix: ['-NoProfile', '-NonInteractive', '-File', script] };
}

/**
 * The prompt goes in a file in the job folder. The helper reports whether the prompt was submitted;
 * anything that may have reached the provider without a terminal answer is left for review, never replayed.
 */
function launch(job: Json, ctx: RunContext): void {
  const steering = steer(job, ctx);
  if (steering.error) return ctx.finish('failed', { error: steering.error });
  const acp = resolveAntigravityAcp(ctx.options);
  if (acp) {
    return launchAntigravityAcp(
      job,
      ctx,
      acp,
      { family: steering.family, effort: steering.effort, availableProfiles: availableProfiles(ctx.home) },
      {
        vendor,
        classifyQuotaFailure(failedJob, failedCtx, message, reportedModel) {
          const reply = exhaustionReply(failedJob, failedCtx, {
            error_code: 'QUOTA_EXHAUSTED',
            error: message,
            reported_model: reportedModel,
          });
          const { profiles } = routingProfiles(failedJob, failedCtx);
          const rows = mergedUsage(failedJob, failedCtx, reply);
          const allClosed = profiles.length > 0 && profiles.every(p => profileState(p, rows) === 'closed');
          return { error: `${allClosed ? 'QUOTA_EXHAUSTED' : 'AG_POOL_EXHAUSTED'}: ${message}`.trim(), reply };
        },
      },
    );
  }
  const command = ctx.options.antigravity ?? resolveAntigravity();
  if (!command) return ctx.finish('failed', { error: 'ROUTE_EXECUTABLE_NOT_FOUND' });
  const o = job.options ?? {};
  const promptFile = path.join(ctx.dir, 'prompt.md');
  fs.writeFileSync(promptFile, job.prompt, 'utf8');
  const seconds = Math.min(3600, Math.max(5, Math.floor(job.timeout_ms / 1000) - 60));
  const args = [...(command.prefix ?? []), '-Action', 'Run', '-Task', o.task ?? 'explain', '-PromptPath', promptFile,
    '-TimeoutSeconds', String(seconds), ...(job.model ? ['-Model', job.model] : []), ...((steering.effort ?? job.effort) ? ['-Effort', steering.effort ?? job.effort] : []),
    ...(steering.family ? ['-ModelFamily', steering.family] : []),
    ...(o.effort_reason ? ['-EffortReason', o.effort_reason] : [])];
  const env = workerEnv(job.id);
  // The helper's approval records, catalog, locks and diagnostics live in Agent Commons' home, so they
  // survive upgrades (each release has its own code folder) and stay out of other apps' folders.
  const state = path.join(ctx.home, 'helpers', 'antigravity');
  fs.mkdirSync(state, { recursive: true });
  env.AC_ANTIGRAVITY_STATE = state;
  env.PYTHONDONTWRITEBYTECODE = '1';
  if (!job.options?.patch_turn) ctx.store.updateJob(job.id, { workdir: ctx.dir });
  const [stdout, stderr] = openOutputs(ctx.dir);
  let child: ChildProcess;
  try {
    child = spawn(command.file, args, { cwd: ctx.dir, env, stdio: ['ignore', stdout, stderr], windowsHide: true, detached: process.platform !== 'win32' });
  } catch (error) {
    fs.closeSync(stdout); fs.closeSync(stderr);
    return ctx.finish('failed', { error: 'SPAWN_FAILED_BEFORE_SUBMISSION: ' + String((error as Error).message).slice(0, 300) });
  }
  const timer = setTimeout(() => { const a = ctx.active(); if (a && !a.reason) { a.reason = 'TIMEOUT'; if (child.pid) killTree(child.pid); } }, job.timeout_ms);
  const active: Active = { child, timer };
  ctx.track(active);
  // Only a spawn failure (no pid) is recorded; other 'error' events must not suppress the timeout kill.
  child.on('error', error => { if (!active.reason && child.pid === undefined) active.reason = 'SPAWN_FAILED: ' + error.message; });
  child.on('close', code => {
    clearTimeout(timer); fs.closeSync(stdout); fs.closeSync(stderr);
    if (ctx.active() !== active) return; // already recorded by stop()
    if (child.pid === undefined) return ctx.finish('failed', { exit_code: code, error: `${active.reason ?? 'SPAWN_FAILED'}_BEFORE_SUBMISSION` });
    try { complete(job, ctx, code, active.reason); }
    catch (error) { ctx.finish('needs_review', { exit_code: code, error: 'RESULT_RECORDING_FAILED: ' + String((error as Error).message).slice(0, 300) }); }
  });
  ctx.store.updateJob(job.id, { pid: child.pid ?? null });
}

function complete(job: Json, ctx: RunContext, code: number | null, reason?: string): void {
  // The helper prints exactly one JSON object on stdout when it exits (progress goes to stderr).
  // Anything else (nothing, several lines, a non-object) is an unclear outcome.
  let reply: Json | null = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(ctx.dir, 'stdout.json'), 'utf8').trim());
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.status === 'string') reply = parsed;
  } catch { /* handled below */ }
  if (reply) {
    reply = exhaustionReply(job, ctx, reply);
    const family = vendor(reply.reported_model) ?? vendor(reply.selected_model);
    if (family) ctx.annotate({ effective_family: family });
  }
  if (reply?.status === 'SUCCESS' && typeof reply.response === 'string') {
    const used = reply.reported_model ?? reply.selected_model;
    if (typeof used === 'string' && used.trim()) ctx.store.markModelValidated(antigravity.capabilities.id, used);
    return ctx.finish('completed', { exit_code: code, result: reply.response, ...replyUsage(reply) }, reply);
  }
  const helperCode = String(reply?.error_code ?? reply?.status ?? 'unknown');
  if (ENTITLEMENT_ERROR_PATTERN.test(String(reply?.error ?? ''))) {
    const denied = [reply?.selected_model, job.model].find(v => typeof v === 'string' && v.trim());
    if (typeof denied === 'string') ctx.store.markModelUnentitled(antigravity.capabilities.id, denied, String(reply?.error ?? helperCode));
  }
  // Not submitted only when the helper says so consistently, or when it is one of the gates the helper
  // checks before starting any CLI run. Its catch-all LOCAL_ERROR carries no run fields even after a
  // submitted run, so missing fields alone never prove that nothing was sent.
  const notSubmitted = !!reply && reply.prompt_submitted !== true && (
    (reply.submission_state === 'not_submitted' && (reply.prompt_submitted === false || reply.run_id === undefined))
    || (reply.status === 'BLOCKED' && PRE_RUN_GATES.has(helperCode)
      && reply.submission_state === undefined && reply.run_id === undefined && reply.process_id === undefined));
  if (notSubmitted) {
    let error = `HELPER_BLOCKED: ${helperCode}`;
    if (helperCode === 'QUOTA_EXHAUSTED') {
      const { profiles } = routingProfiles(job, ctx);
      const rows = mergedUsage(job, ctx, reply!);
      // A task-specific or unknown pool refusal is not a route-wide quota stop.
      const allClosed = profiles.length > 0 && profiles.every(p => profileState(p, rows) === 'closed');
      error = `${allClosed ? 'QUOTA_EXHAUSTED' : 'AG_POOL_EXHAUSTED'}: ${reply!.error ?? ''}`.trim();
    }
    return ctx.finish(reason === 'CANCELLED' ? 'cancelled' : 'failed', { exit_code: code, error }, reply!);
  }
  // Submitted and the provider answered with a known, unusable outcome (for example invalid output).
  if (reply?.terminal_received === true && !reason)
    return ctx.finish('failed', { exit_code: code, error: `HELPER_${helperCode}` }, reply);
  ctx.finish('needs_review', { exit_code: code,
    error: `${reason ?? 'AG_OUTCOME_UNCLEAR'}: helper ${helperCode}; the prompt may have been submitted, so it is never replayed` }, reply ?? undefined);
}

async function discover(ctx: ProbeContext): Promise<ModelDiscoveries> {
  const acp = resolveAntigravityAcp(ctx.options, ctx.overrides);
  if (acp) {
    const res = await probeAntigravityAcp(acp);
    if (!res.ok) throw new Error(res.reason);
    saveAcpCatalog(ctx.home, res.snapshot, new Date().toISOString());
    return projectAcpDiscoveries(res.snapshot, new Set(seedProfiles().map(p => p.model)));
  }
  // Injected offline fixtures cover persisted legacy shapes without launching a native helper.
  if (ctx.overrides.antigravityHelperRoot && !ctx.options?.antigravity) return discoverLocalFixture(ctx);
  const state = path.join(ctx.home, 'helpers', 'antigravity');
  const approvalFile = path.join(state, 'acceptance.json');
  const readApproval = (): Json => JSON.parse(fs.readFileSync(approvalFile, 'utf8'));
  const approval = readApproval();
  const identity = acceptedAntigravityIdentity(approval);
  if (!identity) throw new Error('Antigravity has no valid helper approval');
  const command = ctx.options.antigravity ?? resolveAntigravity();
  if (!command) throw new Error('Antigravity helper not found');
  const observedAt = new Date().toISOString();
  // Catalog is the same metadata-only gate the helper uses, including its one-hour provider cache.
  const { code, reply } = await helperCall(command, ['-Action', 'Catalog'], 90_000, undefined,
    { AC_ANTIGRAVITY_STATE: state, PYTHONDONTWRITEBYTECODE: '1' });
  if (code !== 0 || reply?.status !== 'SUCCESS') {
    const detail = typeof reply?.error_code === 'string' && /^[A-Z0-9_]{1,80}$/.test(reply.error_code) ? ` (${reply.error_code})` : '';
    throw new Error(`Antigravity guarded Catalog refresh failed${detail}`);
  }
  if (acceptedAntigravityIdentity(readApproval()) !== identity)
    throw new Error('Antigravity helper approval changed during the Catalog refresh');
  const quota = quotaUsage({ quota_after: reply.quota, observed_at_utc: observedAt });
  return saveAntigravityInventory(ctx.home, projectAntigravityInventory(reply, approval, quota, observedAt));
}

function discoverLocalFixture(ctx: ProbeContext): ModelDiscoveries {
  const helperRoot = ctx.overrides.antigravityHelperRoot ?? fileURLToPath(new URL('../../helpers/antigravity/', import.meta.url));
  const state = path.join(ctx.home, 'helpers', 'antigravity');
  const seed = metadataModels(JSON.parse(fs.readFileSync(path.join(helperRoot, 'routing-seed.json'), 'utf8')));
  const validated = new Set(seed.map(metadataModel).filter((model): model is string => !!model));
  const rows = new Map<string, ModelDiscovery>();
  const add = (entries: Json[], source: string) => {
    for (const entry of entries) {
      const model = metadataModel(entry);
      if (!model) continue;
      const previous = rows.get(model);
      rows.set(model, { model, family: previous?.family ?? metadataFamily(entry, model),
        efforts: [...new Set([...(previous?.efforts ?? []), ...metadataEfforts(entry)])].sort(),
        state: validated.has(model) ? 'validated' : 'discovered', source });
    }
  };
  add(seed, 'routing-seed');
  const routingState = path.join(state, 'routing-state.json');
  if (fs.existsSync(routingState)) add(metadataModels(JSON.parse(fs.readFileSync(routingState, 'utf8'))), 'routing-state');
  const catalog = path.join(state, 'catalog.json');
  const hasCatalog = fs.existsSync(catalog);
  if (hasCatalog) add(metadataModels(JSON.parse(fs.readFileSync(catalog, 'utf8'))), 'catalog');
  return Object.assign([...rows.values()], { completeSources: hasCatalog ? ['catalog'] : [] });
}

import { sameCliPath, versionedCopies } from './cli-freshness.ts';

function antigravityCliPath(ctx: ProbeContext): string {
  return ctx.overrides.antigravityCli ?? path.join(os.homedir(), 'AppData', 'Local', 'agy', 'bin', 'agy.exe');
}

/**
 * Read-only: compares the helper's approval record (acceptance.json in Agent Commons' helper state folder) with the
 * shipped helper files and the Antigravity CLI, the same comparison the helper makes before each run. Agent Commons
 * never writes the record and never marks the route verified on its own: only the helper's Probe approves.
 */
async function probe(ctx: ProbeContext): Promise<ProbeResult> {
  const acp = resolveAntigravityAcp(ctx.options, ctx.overrides);
  if (acp) {
    const target = acp.prefix?.[0] && fs.existsSync(acp.prefix[0]) ? acp.prefix[0] : acp.file;
    let binarySha256: string | null = null;
    try { binarySha256 = await hashFile(target); } catch { /* unavailable handled below */ }
    const res = await probeAntigravityAcp(acp);
    if (!res.ok) return { state: res.state, binarySha256, reason: res.reason };
    const cli = antigravityCliPath(ctx);
    return {
      state: 'verified',
      binarySha256,
      cliVersion: res.snapshot.cliVersion,
      binary: ctx.installed?.find(binary => sameCliPath(binary.path, cli)) ?? {
        path: target,
        version: res.snapshot.cliVersion,
        source: 'acp',
      },
    };
  }
  const helperRoot = ctx.overrides.antigravityHelperRoot ?? fileURLToPath(new URL('../../helpers/antigravity/', import.meta.url));
  const cli = antigravityCliPath(ctx);
  const recordFile = path.join(ctx.home, 'helpers', 'antigravity', 'acceptance.json');
  if (!fs.existsSync(recordFile)) return { state: 'unavailable', reason: 'no helper approval record; run the helper Probe' };
  let record: Json;
  try { record = JSON.parse(fs.readFileSync(recordFile, 'utf8')); } catch { return { state: 'blocked', reason: 'the helper approval record is unreadable' }; }
  if (record.status !== 'passed') return { state: 'blocked', cliVersion: record.cli_version ?? null, reason: `helper approval status is ${record.status}` };
  if (!fs.existsSync(cli)) return { state: 'unavailable', reason: 'Antigravity CLI not found' };
  const binarySha256 = await hashFile(cli);
  const changed: string[] = [];
  for (const [file, sha] of Object.entries(record.implementation ?? {})) {
    const full = path.join(helperRoot, file);
    if (!fs.existsSync(full) || await hashFile(full) !== sha) changed.push(file);
  }
  if (changed.length) return { state: 'blocked', binarySha256, cliVersion: record.cli_version ?? null,
    reason: `helper files differ from the approved ones (${changed.slice(0, 5).join(', ')}${changed.length > 5 ? ', ...' : ''}); the helper needs an explicit Probe` };
  if (binarySha256 !== record.cli_sha256) return { state: 'drifted', binarySha256, cliVersion: record.cli_version ?? null,
    reason: `Antigravity CLI changed since approval (approved ${record.cli_version}); the helper re-checks it before the next run` };
  return { state: 'verified', binarySha256, cliVersion: record.cli_version ?? null,
    binary: ctx.installed?.find(binary => sameCliPath(binary.path, cli)) };
}

/**
 * Current quota without a job: the helper's Status action, which reads Antigravity's own `/usage` report (the same read
 * the helper makes before every run) and sends no model prompt. Runs only when the helper's approval record passed;
 * any failure leaves the recorded windows as they are.
 */
async function observeUsage(ctx: ProbeContext): Promise<UsageSnapshot | undefined> {
  const state = path.join(ctx.home, 'helpers', 'antigravity');
  try { if (JSON.parse(fs.readFileSync(path.join(state, 'acceptance.json'), 'utf8')).status !== 'passed') return; } catch { return; }
  const command = ctx.options.antigravity ?? resolveAntigravity();
  if (!command) return;
  // Timestamped when the read starts, so a slow reply never looks newer than what it measured.
  const observedAt = new Date().toISOString();
  const { code, reply } = await helperCall(command, ['-Action', 'Status'], 90_000, undefined,
    { AC_ANTIGRAVITY_STATE: state, PYTHONDONTWRITEBYTECODE: '1' });
  if (code !== 0 || reply?.status !== 'SUCCESS' || !Array.isArray(reply.quota)) {
    const reason = typeof reply?.error_code === 'string' && /^[A-Z0-9_]{1,64}$/.test(reply.error_code) ? reply.error_code : `exit_${code ?? 'none'}`;
    ctx.onUsageError?.({ kind: `helper:${reason}`, method: 'Status', at: new Date().toISOString() });
    return;
  }
  const rows = quotaUsage({ quota_after: reply.quota, observed_at_utc: observedAt });
  if (!rows.length) ctx.onUsageError?.({ kind: 'helper:no_quota_rows', method: 'Status', at: new Date().toISOString() });
  return rows.length ? { rows, source: 'status', completeInventory: rows.length === reply.quota.length } : undefined;
}

export const antigravity: PlatformAdapter = {
  // Ceiling 2: the helper documentation verifies two simultaneous instances.
  capabilities: { id: 'antigravity', family: 'google', transport: 'helper', billing: 'sub', modes: ['advice'], supportsShellInEdit: false, hasWorkspaceReadTools: false,
    maxPromptChars: 200000, maxTimeoutMinutes: 60, defaultTimeoutMinutes: 15, quotaGroup: 'ag-google', defaultModel: null, maxConcurrent: 1, maxConcurrentCeiling: 2, short: 'ag' },
  // The helper picks the model under its Probe; profiles choose only its task category and effort.
  profiles: profileGrid(['advice'], () => null, { min: 'low', low: 'low', med: 'medium', high: 'high', max: 'xhigh' },
    intent => ({ task: ({ fast: 'explain', code: 'coding', review: 'review', deep: 'complex', edit: 'coding' } as const)[intent] })),
  effectiveEffort(taskOrIntent: string, nativeEffort: string, home?: string): string | null {
    const task = ({ fast: 'explain', code: 'coding', review: 'review', deep: 'complex', edit: 'coding' } as Record<string, string>)[taskOrIntent] ?? taskOrIntent;
    return fitAntigravityEffort(availableProfiles(home), task, nativeEffort).effort ?? nativeEffort;
  },
  estimatedCost(model: string | null, effort: string | null, promptChars: number, options?: Json) {
    const task = String(options?.task ?? 'explain');
    const eff = effort ?? 'medium';
    const guessedModel = model ?? availableProfiles(options?.home).find(p => p.tasks.includes(task) && p.effort === eff)?.family
      ?? (task === 'explain' ? 'gemini-3.8-flash' : task === 'coding' ? 'gemini-4-argon' : 'gemini-4-neon');
    const spec = modelPricing(guessedModel);
    return spec ? { expectedUsd: estimateExpectedCostUsd(spec, promptChars, eff), basis: 'weight' as const } : null;
  },
  probe,
  binaries: ctx => versionedCopies([{ path: antigravityCliPath(ctx), source: 'helper install' }], file => ({ file })),
  discover,
  discoverySummary: ctx => {
    if (resolveAntigravityAcp(ctx.options, ctx.overrides)) {
      const acpSummary = acpInventorySummary(ctx.home);
      if (acpSummary) return acpSummary;
    }
    return antigravityInventorySummary(ctx.home);
  },
  usage: quotaUsage,
  observeUsage,
  reopenedQuotaPools: (rows, _known, home) => [...new Set(availableProfiles(home)
    .filter(profile => profileState(profile, rows) === 'open').map(profile => profile.group))],
  consumption,
  backfillConsumption,
  poolEvidenceStatus,
  validate(input) {  // modes and time limits are enforced by the store from capabilities
    // The guarded helper runs reasoning only: the model gets the prompt text and no tools.
    const task = input.task ?? 'explain';
    if (!['explain', 'coding', 'complex', 'review'].includes(task)) fail('INVALID_INPUT', 400, 'task must be explain, coding, complex or review');
    if (input.effort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(input.effort)) fail('INVALID_INPUT', 400, 'effort must be low, medium, high, xhigh or max');
    const reason = optText(input.effort_reason, 'effort_reason', 240);
    if (reason && /[\x00-\x1f\x7f]/.test(reason)) fail('INVALID_INPUT', 400, 'effort_reason must be one line');
    const family = optText(input.model_family ?? input.family, 'model_family', 100);
    if (family && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(family)) fail('INVALID_INPUT', 400, 'model_family must be a lowercase family identifier');
    return { task, ...(reason ? { effort_reason: reason } : {}), ...(family ? { model_family: family } : {}) };
  },
  launch,
};
