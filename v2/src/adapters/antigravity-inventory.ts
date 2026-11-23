import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Json } from '../store.ts';
import type { ModelDiscoveries, UsageObservation, UsageWindow } from './types.ts';

export interface SeedProfile {
  model: string;
  family: string;
  effort: string;
  tasks: string[];
  group: string;
  quota_limits: Array<{ group: string; limit: string }>;
  task_preferences?: Record<string, number>;
}

interface Variant {
  model: string;
  family?: string;
  effort?: string;
  profile?: SeedProfile;
  unavailable?: string;
  quotaProfile?: SeedProfile;
}

interface Inventory {
  observedAt: string;
  catalogAt: string;
  identity: string;
  quota: UsageObservation[];
  variants: Variant[];
}

const SOURCE = 'guarded-catalog';
const CATALOG_TTL = 60 * 60_000;
const MODEL = /^[a-z0-9][a-z0-9.-]{1,127}$/;
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const TASKS = new Set(['transform', 'explain', 'coding', 'complex', 'review', 'followup']);
const JOB_TASKS = new Set(['explain', 'coding', 'complex', 'review']);
const statePath = (home: string, name: string) => path.join(home, 'helpers', 'antigravity', name);

function readJson(file: string): Json | undefined {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}

function record(value: unknown): value is Json {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isModel(value: unknown): value is string {
  return typeof value === 'string' && MODEL.test(value);
}

// These keys and values are the helper's ASCII identity manifest. Match its stable SHA-256 mapping
// so changing the accepted CLI or any guarded helper input invalidates promoted assignments.
export function acceptedAntigravityIdentity(approval: Json | undefined): string | null {
  if (approval?.status !== 'passed' || !isDigest(approval.cli_sha256) || !isDigest(approval.agent_sha256)
      || !record(approval.implementation)) return null;
  const files = Object.keys(approval.implementation).sort();
  if (!files.length || !files.every(file => isDigest(approval.implementation[file]))) return null;
  const identity = {
    agent_sha256: approval.agent_sha256,
    cli_sha256: approval.cli_sha256,
    implementation: Object.fromEntries(files.map(file => [file, approval.implementation[file]])),
  };
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

function isDigest(value: unknown): boolean {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function parseProfiles(assignments: unknown, identity: string): Map<string, SeedProfile> {
  if (!record(assignments) || assignments.schema_version !== 1
      || !Array.isArray(assignments.profiles) || !assignments.profiles.length)
    throw new Error('Antigravity Catalog did not return a complete assignment registry');
  const profiles = new Map<string, SeedProfile>();
  for (const profile of assignments.profiles) {
    if (!record(profile) || !isModel(profile.model) || profiles.has(profile.model)
      || !isModel(profile.family) || !EFFORTS.has(profile.effort)
      || profile.model !== `${profile.family}-${profile.effort}`
      || !Array.isArray(profile.tasks) || !profile.tasks.length || profile.tasks.some(task => !TASKS.has(task))
      || typeof profile.group !== 'string' || !profile.group || !Array.isArray(profile.quota_limits)
      || !profile.quota_limits.length || profile.quota_limits.some(limit =>
        !record(limit) || typeof limit.group !== 'string' || !limit.group || typeof limit.limit !== 'string' || !limit.limit)
      || (profile.state !== 'seeded' && (profile.state !== 'validated' || profile.validation?.status !== 'passed'
        || profile.validation.identity_hash !== identity)))
      throw new Error('Antigravity Catalog returned an invalid assignment');
    const { model, family, effort, tasks, group, quota_limits, task_preferences } = profile;
    profiles.set(model, { model, family, effort, tasks, group, quota_limits, task_preferences });
  }
  return profiles;
}

export function projectAntigravityInventory(reply: Json | null, approval: Json | undefined,
  quota: UsageObservation[], observedAt: string): Inventory {
  const identity = acceptedAntigravityIdentity(approval);
  if (!identity || reply?.status !== 'SUCCESS' || reply.activated !== true)
    throw new Error('Antigravity Catalog did not confirm the guarded helper is active');
  const catalog = reply.catalog;
  if (!record(catalog) || catalog.schema_version !== 1 || catalog.cli_sha256 !== approval?.cli_sha256
      || !Number.isFinite(Date.parse(catalog.fetched_at)) || !record(catalog.models)
      || !record(catalog.variants) || !Array.isArray(catalog.unsupported)
      || !Object.keys(catalog.models).length
      || Object.keys(catalog.models).length !== Object.keys(catalog.variants).length)
    throw new Error('Antigravity Catalog metadata was incomplete or the CLI identity changed');
  const profiles = parseProfiles(reply.assignments, identity);
  const variants: Variant[] = [];
  for (const [model, variant] of Object.entries(catalog.variants)) {
    if (!isModel(model) || typeof catalog.models[model] !== 'string' || !record(variant)
        || !isModel(variant.family) || !EFFORTS.has(variant.effort) || model !== `${variant.family}-${variant.effort}`)
      throw new Error('Antigravity Catalog returned an invalid model variant');
    const { family, effort } = variant;
    const profile = profiles.get(model);
    const quotaProfile = profile ? undefined : [...profiles.values()].find(candidate => candidate.family === family);
    const unavailable = family.startsWith('gpt-oss') ? 'excluded by the guarded helper' : undefined;
    variants.push({ model, family, effort, profile, unavailable, quotaProfile });
  }
  for (const entry of catalog.unsupported) {
    if (!record(entry) || !isModel(entry.id) || variants.some(variant => variant.model === entry.id))
      throw new Error('Antigravity Catalog returned an invalid unsupported entry');
    variants.push({ model: entry.id, unavailable: 'no supported effort in the guarded catalog' });
  }
  return { observedAt, catalogAt: catalog.fetched_at, identity, quota, variants: variants.sort((a, b) => a.model.localeCompare(b.model)) };
}

export function saveAntigravityInventory(home: string, inventory: Inventory): ModelDiscoveries {
  const target = statePath(home, 'agent-commons-inventory.json');
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(inventory), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return Object.assign(inventory.variants.map(variant => ({
    model: variant.model, family: variant.family, efforts: variant.effort ? [variant.effort] : [],
    state: !variant.unavailable && variant.profile ? 'validated' as const : 'discovered' as const,
    // Discovered variants remain visible in the inventory. They cannot supersede a qualified route choice.
    hidden: !!variant.unavailable || !variant.profile,
    source: SOURCE,
  })), { completeSources: [SOURCE, `${SOURCE}:hidden`, 'catalog', 'routing-state', 'routing-seed'] });
}

function readInventory(home: string): Inventory | undefined {
  const inventory = readJson(statePath(home, 'agent-commons-inventory.json'));
  if (!inventory || !isDigest(inventory.identity) || !Number.isFinite(Date.parse(inventory.catalogAt))
      || !Number.isFinite(Date.parse(inventory.observedAt)) || !Array.isArray(inventory.variants)
      || !Array.isArray(inventory.quota) || inventory.variants.some((variant: unknown) =>
        !record(variant) || !isModel(variant.model) || [variant.profile, variant.quotaProfile].some(profile =>
          profile !== undefined && (!record(profile) || !Array.isArray(profile.tasks) ||
            !Array.isArray(profile.quota_limits))))) return undefined;
  return inventory as Inventory;
}

function inventoryCurrent(home: string, inventory: Inventory): boolean {
  const approval = readJson(statePath(home, 'acceptance.json'));
  const age = Date.now() - Date.parse(inventory.catalogAt);
  return age >= 0 && age < CATALOG_TTL && acceptedAntigravityIdentity(approval) === inventory.identity;
}

/** Keep the accepted assignment list until the helper identity changes. The launched helper always re-checks its live catalog. */
export function currentAntigravityProfiles(home: string): SeedProfile[] | undefined {
  const inventory = readInventory(home);
  if (!inventory || acceptedAntigravityIdentity(readJson(statePath(home, 'acceptance.json'))) !== inventory.identity) return undefined;
  return inventory.variants.flatMap(row => row.profile && !row.unavailable ? [row.profile] : []);
}

export function profileState(profile: SeedProfile, rows: UsageWindow[]): 'open' | 'closed' | 'unknown' {
  let unknown = false;
  for (const required of profile.quota_limits) {
    const exhausted = rows.find(row => row.pool === required.group && row.window === 'exhaustion'
      && !row.stale && row.remaining_percent === 0);
    if (exhausted) return 'closed';
    const row = rows.find(row => row.pool === required.group && row.window === required.limit);
    if (!row || row.stale || row.remaining_percent === null) unknown = true;
    else if (row.closed || row.remaining_percent === 0) return 'closed';
  }
  return unknown ? 'unknown' : 'open';
}

export function antigravityInventorySummary(home: string): string {
  const inventory = readInventory(home);
  if (!inventory) return 'Antigravity guarded catalog unavailable';
  const state = inventoryCurrent(home, inventory) ? 'current' : 'stale';
  return `Antigravity guarded catalog ${state}; observed ${inventory.catalogAt}; last successful refresh ${inventory.observedAt}`;
}

export function antigravityInventoryLines(home: string, usage: UsageWindow[]): string[] {
  const inventory = readInventory(home);
  if (!inventory) return [];
  const current = inventoryCurrent(home, inventory);
  const windows = new Map<string, UsageWindow>();
  const key = (row: UsageObservation) => JSON.stringify([row.pool, row.window]);
  for (const row of inventory.quota) {
    const observed_at = row.observed_at ?? inventory.observedAt;
    const stale = !current || (row.resets_at !== null && Date.parse(row.resets_at) <= Date.now());
    windows.set(key(row), { ...row, route: 'antigravity', source: SOURCE, observed_at, stale });
  }
  for (const row of usage) {
    const previous = windows.get(key(row));
    if (!previous || Date.parse(previous.observed_at) <= Date.parse(row.observed_at)) windows.set(key(row), row);
  }
  const rows = [...windows.values()];
  const attempts = readJson(statePath(home, 'candidate-attempts.json'))?.attempts;
  const failures = new Map<string, Json>();
  if (record(attempts)) for (const attempt of Object.values(attempts)) {
    if (record(attempt) && attempt.identity_hash === inventory.identity && attempt.status === 'failed'
      && /^[A-Z0-9_]{1,80}$/.test(attempt.reason) && typeof attempt.completed_at === 'string'
      && (!failures.has(attempt.model) || failures.get(attempt.model)!.completed_at < attempt.completed_at))
      failures.set(attempt.model, attempt);
  }
  return [antigravityInventorySummary(home), ...inventory.variants.map(variant => {
    const effort = variant.effort ? `; effort ${variant.effort}` : '';
    const prefix = `  ${variant.model}${effort}`;
    if (variant.unavailable) return `${prefix}; unavailable (${variant.unavailable})`;
    const profile = variant.profile ?? variant.quotaProfile;
    const quota = profile ? profileState(profile, rows) : 'unknown';
    const quotaDetail = profile ? `; ${profile.group} quota ${quota === 'closed' ? 'exhausted' : quota}` : '';
    if (!variant.profile) {
      const failure = failures.get(variant.model);
      return `${prefix}; awaiting qualification${failure ? ` (last attempt: ${failure.reason})` : ''}${quotaDetail}`;
    }
    const tasks = variant.profile.tasks.filter(task => JOB_TASKS.has(task));
    const helperTasks = variant.profile.tasks.filter(task => !JOB_TASKS.has(task));
    const taskDetail = tasks.length ? `tasks ${tasks.join(', ')}` : 'unavailable for Agent Commons job tasks';
    const helperDetail = helperTasks.length ? `; helper tasks ${helperTasks.join(', ')}` : '';
    return `${prefix}; qualified${current ? '' : ' in last good catalog'}; ${taskDetail}${helperDetail}${quotaDetail}`;
  })];
}
