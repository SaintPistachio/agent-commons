/** Read-only inventories. A failed read is not an authoritative empty snapshot. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compareCliVersions, parseCliVersion } from './cli-freshness.ts';
import { highestSupportedEffort, isModelEntitled } from './model-pricing.ts';
import type { Json } from '../store.ts';
import type { ModelChoice, ModelChoiceRequest, ModelDiscoveries, ModelSourceFallback } from './types.ts';

const DAY = 24 * 60 * 60 * 1000;
const EFFORT = /^[a-z][a-z0-9_-]*$/;
const MODEL = /^[a-z0-9][a-z0-9._/-]*$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export interface CatalogModel {
  id: string;
  family: string;
  efforts: string[];
  defaultEffort: string | null;
  hidden: boolean;
  versionParts: string[];
}

export interface CatalogSnapshot {
  state: 'trusted' | 'stale' | 'foreign';
  source: 'cli-cache' | 'cli-catalog';
  selected: string | null;
  producer: string | null;
  minimum?: string | null;
  fetched: number | null;
  reason?: string;
  models: CatalogModel[];
  /** Catalog entries left out because they were incomplete. */
  skipped?: string[];
}

export const cliEfforts = { min: 'low', low: 'low', med: 'medium', high: 'high', max: 'max' } as const;
const codexFallbackEfforts = { min: 'minimal', low: 'low', med: 'medium', high: 'high', max: 'high' } as const;

function fallbackEffort(snapshot: CatalogSnapshot, eff: ModelChoiceRequest['eff']): string | undefined {
  return (snapshot.source === 'cli-cache' ? codexFallbackEfforts : cliEfforts)[eff];
}

function fallbackSource(snapshot: CatalogSnapshot): ModelSourceFallback {
  return { state: 'fallback', reason: catalogStatus(snapshot) };
}

function fallbackChoice(snapshot: CatalogSnapshot, request: ModelChoiceRequest): ModelChoice {
  if (request.explicitEffort && (!request.effort || !EFFORT.test(request.effort)))
    return { error: 'CLI effort must be a lowercase effort identifier' };
  return {
    model: request.explicitModel ? request.model : null,
    effort: (request.explicitEffort ? request.effort : fallbackEffort(snapshot, request.eff)) ?? 'medium',
    source: fallbackSource(snapshot),
  };
}

type ObjectRow = Record<string, unknown>;
function object(value: unknown): ObjectRow | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectRow : undefined;
}
function exactVersion(value: unknown): string | null {
  return typeof value === 'string' && parseCliVersion(value) === value ? value : null;
}
function epoch(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && Number.isFinite(new Date(value).getTime()) ? value : null;
}
function fresh(fetched: number | null, now: number): boolean {
  return fetched !== null && fetched <= now && now - fetched <= DAY;
}
function failure(snapshot: CatalogSnapshot, state: 'stale' | 'foreign', reason: string): CatalogSnapshot {
  return { ...snapshot, state, reason, models: [] };
}
function readObject(file: string): ObjectRow | undefined {
  try { return object(JSON.parse(fs.readFileSync(file, 'utf8'))); }
  catch { return undefined; }
}
function efforts(value: unknown, extract: (entry: unknown) => unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const list = value.map(extract);
  if (!list.every((entry): entry is string => typeof entry === 'string' && EFFORT.test(entry))) return null;
  return [...new Set(list)];
}
function defaultEffort(value: unknown, levels: string[]): string | null {
  return typeof value === 'string' && levels.includes(value) ? value : null;
}
function uniqueModels(models: CatalogModel[]): boolean {
  return new Set(models.map(model => model.id)).size === models.length;
}

export function codexLine(id: string): string {
  return /^gpt-\d+(?:\.\d+)*-([a-z][a-z0-9]*)(?=-|$)/.exec(id)?.[1]
    ?? id.replace(/(^|-)\d+(?:[.-]\d+)*(?=-|$)/, '');
}

export function readCodexModels(selected: string | null, home = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'),
  now = Date.now()): CatalogSnapshot {
  const snapshot: CatalogSnapshot = { source: 'cli-cache', state: 'stale', producer: null, selected, fetched: null, models: [] };
  if (!path.isAbsolute(home)) return failure(snapshot, 'stale', 'relative CODEX_HOME cannot identify the worker cache');
  const document = readObject(path.join(home, 'models_cache.json'));
  if (!document) return failure(snapshot, 'stale', 'models_cache.json is missing or unreadable');
  snapshot.producer = exactVersion(document.client_version);
  snapshot.fetched = typeof document.fetched_at === 'string' && ISO.test(document.fetched_at) ? epoch(Date.parse(document.fetched_at)) : null;
  if (!exactVersion(selected)) return failure(snapshot, 'stale', 'no verified CLI version in use');
  // Build metadata is not part of the client version contract; the entire prerelease is.
  if (!snapshot.producer || snapshot.producer.split('+')[0] !== selected!.split('+')[0])
    return failure(snapshot, 'foreign', 'cache client_version does not match the selected CLI');
  if (!fresh(snapshot.fetched, now)) return failure(snapshot, 'stale', 'cache timestamp is invalid, in the future, or older than 24h');
  if (!Array.isArray(document.models)) return failure(snapshot, 'stale', 'cache is missing its model list');
  const models: CatalogModel[] = [];
  for (const value of document.models) {
    const model = object(value), id = model?.slug;
    const levels = efforts(model?.supported_reasoning_levels, entry => object(entry)?.effort);
    if (typeof id !== 'string' || !MODEL.test(id) || !levels || (model?.visibility !== 'list' && model?.visibility !== 'hide'))
      return failure(snapshot, 'stale', 'cache contains an invalid model entry');
    models.push({ id, family: codexLine(id), efforts: levels, defaultEffort: defaultEffort(model.default_reasoning_level, levels),
      hidden: model.visibility === 'hide', versionParts: (/^gpt-(\d+(?:\.\d+)*)(?=-|$)/.exec(id)?.[1] ?? '').split('.').filter(Boolean) });
  }
  if (!uniqueModels(models)) return failure(snapshot, 'stale', 'cache contains duplicate model identifiers');
  return { ...snapshot, state: 'trusted', models };
}

function claudeLine(id: string): string | undefined {
  return /^claude-(fable|opus|sonnet|haiku)(?=-|$)/.exec(id)?.[1];
}

export function readClaudeModels(selected: string | null, home = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'),
  now = Date.now()): CatalogSnapshot {
  const snapshot: CatalogSnapshot = { source: 'cli-catalog', state: 'stale', producer: null, selected, fetched: null, models: [] };
  if (!path.isAbsolute(home)) return failure(snapshot, 'stale', 'relative CLAUDE_CONFIG_DIR cannot identify the worker catalog');
  const dir = path.join(home, 'cache', 'model-catalog');
  let files: string[];
  try { files = fs.readdirSync(dir).filter(file => file.endsWith('.json')).sort(); }
  catch { return failure(snapshot, 'stale', 'model-catalog directory is missing or unreadable'); }
  const catalogs = files.flatMap(file => {
    const document = readObject(path.join(dir, file));
    const catalog = object(document?.catalog);
    return document && catalog ? [{ document, catalog, fetched: epoch(document.fetchedAt) }] : [];
  });
  // Model availability is per account; CLI support is checked per model below (min_claude_code_version against the
  // CLI AC runs). So the freshest CLI (cc) or Claude Code desktop (ccd) catalog is used.
  const cc = catalogs.filter(row => row.catalog.surface === 'cc' || row.catalog.surface === 'ccd')
    .sort((a, b) => (b.fetched ?? -Infinity) - (a.fetched ?? -Infinity))[0];
  if (!cc) return failure(snapshot, 'stale', 'no Claude Code (cc or ccd) catalog was found');
  snapshot.producer = `surface ${String(cc.catalog.surface)}`;
  snapshot.fetched = cc.fetched;
  if (cc.document.version !== 2) return failure(snapshot, 'stale', 'unrecognized CLI catalog format');
  const entries = object(cc.catalog.config)?.models;
  if (!Array.isArray(entries)) return failure(snapshot, 'stale', 'catalog is missing its model list');
  const models: CatalogModel[] = [];
  const skipped: string[] = [];
  let minimum: string | null = null;
  for (const value of entries) {
    const model = object(value), runtime = object(model?.runtime), id = model?.id;
    const levels = efforts(runtime?.effort_levels, entry => entry);
    // min_claude_code_version is optional: absent means no minimum; present but unparseable is invalid.
    const declared = model?.min_claude_code_version;
    const required = declared === undefined || declared === null ? null : exactVersion(declared);
    if (typeof id !== 'string' || !MODEL.test(id) || !levels || (declared != null && !required) ||
        (model?.section !== 'main' && model?.section !== 'overflow') ||
        typeof runtime?.family !== 'string' || !runtime.family.trim()) {
      // One incomplete entry (for example an old model without runtime details) is skipped, not trusted.
      skipped.push(typeof id === 'string' ? id : '(no id)');
      continue;
    }
    if (required && (!minimum || compareCliVersions(required, minimum) > 0)) minimum = required;
    models.push({ id, family: claudeLine(id) ?? runtime.family, efforts: levels, defaultEffort: defaultEffort(runtime.default_effort, levels),
      hidden: false, versionParts: (/^claude-[a-z]+-(\d+(?:[.-]\d+)*)(?=-|$)/.exec(id)?.[1] ?? '').split(/[.-]/).filter(Boolean) });
  }
  snapshot.minimum = minimum;
  if (!exactVersion(selected)) return failure(snapshot, 'stale', 'no verified CLI version in use');
  if (minimum && compareCliVersions(minimum, selected!) > 0)
    return failure(snapshot, 'foreign', 'a listed model requires a newer CLI');
  if (!fresh(snapshot.fetched, now)) return failure(snapshot, 'stale', 'catalog timestamp is invalid, in the future, or older than 24h');
  // staleAt is Claude Code's own refresh hint (about an hour after each fetch), not an expiry; the 24 h rule decides.
  if (!models.length) return failure(snapshot, 'stale', 'catalog has no complete model entries');
  if (!uniqueModels(models)) return failure(snapshot, 'stale', 'catalog contains duplicate model identifiers');
  return { ...snapshot, state: 'trusted', models, ...(skipped.length ? { skipped } : {}) };
}

export function catalogStatus(snapshot: CatalogSnapshot, now = Date.now()): string {
  const age = snapshot.fetched === null ? 'unknown' : `${Math.floor((now - snapshot.fetched) / 60_000)}m`;
  const minimum = snapshot.minimum ? `; highest model minimum ${snapshot.minimum}` : '';
  return `${snapshot.state === 'trusted' ? '' : 'WARN '}${snapshot.source}: ${snapshot.state}; age ${age}; ` +
    `producer ${snapshot.producer ?? 'unknown'}; using ${snapshot.selected ?? 'none'}${minimum}` +
    (snapshot.reason ? `; ${snapshot.reason}` : '');
}

export function catalogSelectionStatus(snapshot: CatalogSnapshot): string {
  const status = catalogStatus(snapshot);
  return snapshot.state === 'trusted' ? status
    : `${status}; fallback: CLI default model unless the caller supplies a model`;
}

export function catalogDiscoveries(snapshot: CatalogSnapshot): ModelDiscoveries {
  if (snapshot.state !== 'trusted') throw new Error(catalogStatus(snapshot));
  const rows: ModelDiscoveries = snapshot.models.map(model => ({
    model: model.id, family: model.family, efforts: model.efforts, hidden: model.hidden,
    source: snapshot.source, state: 'verified',
  }));
  rows.completeSources = [snapshot.source, `${snapshot.source}:hidden`];
  return rows;
}

function newest(models: CatalogModel[], line: string): CatalogModel | undefined {
  return models.filter(model => !model.hidden && model.family === line && model.versionParts.length).sort((a, b) => {
    for (let i = 0; i < Math.max(a.versionParts.length, b.versionParts.length); i++) {
      const x = (a.versionParts[i] ?? '0').replace(/^0+(?=\d)/, '');
      const y = (b.versionParts[i] ?? '0').replace(/^0+(?=\d)/, '');
      const order = y.length - x.length || (x === y ? 0 : x < y ? 1 : -1);
      if (order) return order;
    }
    return a.id.length - b.id.length || (a.id === b.id ? 0 : a.id < b.id ? -1 : 1);
  })[0];
}

const CLAUDE_ALIASES = new Set(['haiku', 'sonnet', 'opus', 'fable']);
function findModel(snapshot: CatalogSnapshot, model: string): CatalogModel | undefined {
  if (snapshot.source === 'cli-catalog' && CLAUDE_ALIASES.has(model)) return newest(snapshot.models, model);
  return snapshot.models.find(row => row.id === model);
}

function pick(snapshot: CatalogSnapshot, request: ModelChoiceRequest, model: string | null): ModelChoice {
  const entry = model ? findModel(snapshot, model) : undefined;
  if (!model || !entry) return { error: model ? `${model} is not in the trusted ${snapshot.source}` : `no listed model for this profile in the trusted ${snapshot.source}` };
  let effort = request.effort;
  if (!request.explicitEffort && (!effort || ((request.explicitModel || !request.tracksLatest || request.eff === 'max') && !entry.efforts.includes(effort)))) {
    effort = request.eff === 'max' ? (highestSupportedEffort(entry.efforts) ?? entry.defaultEffort ?? effort)
      : (entry.defaultEffort ?? effort);
  }
  if (!effort || !entry.efforts.includes(effort))
    return { error: `unsupported effort ${effort ?? '(none)'} for ${model}; supported: ${entry.efforts.join(', ') || 'none'}` };
  return { model, effort, source: snapshot.source };
}

export function chooseCodexModel(request: ModelChoiceRequest, snapshot: CatalogSnapshot): ModelChoice {
  if (snapshot.state !== 'trusted') return fallbackChoice(snapshot, request);
  if (request.explicitModel || !request.tracksLatest) return pick(snapshot, request, request.model);
  const supportsReqEffort = (candidate: CatalogModel) =>
    !request.explicitEffort || !request.effort || candidate.efforts.includes(request.effort);
  const available = (line: string) => {
    const candidate = newest(snapshot.models, line);
    if (!candidate || !supportsReqEffort(candidate)) return null;
    return isModelEntitled(candidate.id, request.entitledModels, request.unentitledModels) ? candidate.id : null;
  };
  let model: string | null = null;
  if (request.eff === 'max') {
    model = available('astra') ?? available('sol') ?? available('terra');
  } else if (request.intent === 'fast' && request.eff !== 'high') {
    model = available('luna') ?? available('terra') ?? available('sol');
  } else if ((request.intent === 'fast' && request.eff === 'high') ||
      (request.intent === 'code' && (request.eff === 'min' || request.eff === 'low' || request.eff === 'med'))) {
    model = available('terra') ?? available('sol') ?? available('astra');
  } else {
    model = available('sol') ?? available('astra') ?? available('terra');
  }
  return pick(snapshot, request, model);
}

export function claudeFallback(intent: ModelChoiceRequest['intent']): string {
  return intent === 'review' || intent === 'deep' ? 'opus' : 'sonnet';
}

export function chooseClaudeModel(request: ModelChoiceRequest, snapshot: CatalogSnapshot): ModelChoice {
  const fallback = claudeFallback(request.intent);
  if (snapshot.state !== 'trusted') return fallbackChoice(snapshot, request);
  if (request.explicitModel || !request.tracksLatest) return pick(snapshot, request, request.model);
  const canUse = (line: string) =>
    !!findModel(snapshot, line) && isModelEntitled(line, request.entitledModels, request.unentitledModels);
  let alias = fallback;
  if (request.eff === 'max') {
    if (request.allowPremium && canUse('fable')) alias = 'fable';
    else if (canUse('opus')) alias = 'opus';
  } else if (request.intent === 'fast' && request.eff !== 'high') {
    alias = canUse('haiku') ? 'haiku' : fallback;
  }
  return pick(snapshot, request, alias);
}

/** Recheck a queued choice without selecting a different catalog model at dispatch. */
export function queuedCliSelection(snapshot: CatalogSnapshot, job: Json): {
  model: string | null; effort: string | null; fallback?: ModelSourceFallback; error?: string;
} {
  const model = typeof job.model === 'string' ? job.model : null;
  const effort = typeof job.effort === 'string' ? job.effort : null;
  if (snapshot.state !== 'trusted') {
    return {
      model: job.options?.cli_explicit_model === true ? model : null,
      effort: job.options?.cli_explicit_effort === true ? effort : fallbackEffort(snapshot, job.req_eff) ?? effort,
      fallback: fallbackSource(snapshot),
    };
  }
  // A job submitted with the CLI default still uses the default if the catalog becomes trusted.
  if (model === null) return { model, effort };
  const entry = findModel(snapshot, model);
  if (!entry) return { model, effort, error: 'the queued model is no longer available in the trusted inventory' };
  if (!effort || !entry.efforts.includes(effort)) {
    // A fallback job's implicit effort was not selected against this model's metadata.
    if (job.options?.model_source?.state === 'fallback' &&
        job.options?.cli_explicit_effort !== true && entry.defaultEffort)
      return { model, effort: entry.defaultEffort };
    return { model, effort, error: `the queued effort is no longer supported for ${entry.id}` };
  }
  return { model, effort };
}
