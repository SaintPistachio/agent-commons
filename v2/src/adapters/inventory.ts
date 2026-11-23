/** Read-only helpers for the adapters' local metadata formats. */
import type { Json } from '../store.ts';
import type { ModelDiscoveries, ProfileSeed } from './types.ts';

export function metadataModel(row: Json): string | undefined {
  const value = row.model ?? row.model_id ?? row.modelId ?? row.id ?? row.name;
  return typeof value === 'string' && value.trim() ? value.trim().replace(/^models\//, '') : undefined;
}

/** Supports arrays and model-keyed maps, including the helpers' profiles/models containers. */
export function metadataModels(value: unknown): Json[] {
  const containers = ['models', 'profiles', 'items', 'catalog', 'data', 'available_models', 'discovered_models'];
  const fields = ['family', 'model_family', 'efforts', 'supported_efforts', 'reasoning_efforts', 'supportedEfforts', 'effort', 'capabilities'];
  const parse = (input: unknown): Json[] => {
    if (Array.isArray(input)) return input.flatMap(item =>
      typeof item === 'string' && item.trim() ? [{ model: item }] : parse(item));
    if (!input || typeof input !== 'object') return [];
    const row = input as Json;
    // A named wrapper is not itself a model.
    const nested = containers.filter(key => row[key] !== undefined);
    if (nested.length) return nested.flatMap(key => parse(row[key]));
    if (metadataModel(row)) return [row];
    return Object.entries(row).flatMap(([model, details]) => {
      if (!details || typeof details !== 'object' || Array.isArray(details)) return [];
      const entry = details as Json;
      // Do not reinterpret an unrecognized wrapper containing lists/objects as a model-keyed map.
      if (Object.entries(entry).some(([key, child]) =>
        child !== null && typeof child === 'object' && !fields.includes(key))) return [];
      if (!metadataModel(entry) && !fields.some(key => entry[key] !== undefined)
        && !/^[a-z0-9][a-z0-9._/-]*[-/][a-z0-9._/-]+$/i.test(model)) return [];
      return [{ ...entry, model: metadataModel(entry) ?? model }];
    });
  };
  const rows = parse(value);
  const nonempty = typeof value === 'string' ? value.trim().length > 0
    : !!value && typeof value === 'object' && Object.keys(value).length > 0;
  const explicitlyEmpty = (input: unknown): boolean => {
    if (!input || typeof input !== 'object') return false;
    if (!Object.keys(input).length) return true;
    const row = input as Json;
    const nested = containers.filter(key => row[key] !== undefined);
    return nested.length > 0 && nested.every(key => explicitlyEmpty(row[key]));
  };
  // Known empty containers are authoritative empty snapshots. Unsupported non-empty
  // snapshots must fail rather than retire previously discovered models.
  if (nonempty && !rows.length && !explicitlyEmpty(value))
    throw new Error('Unrecognized or empty non-empty model metadata snapshot');
  return rows;
}

export function metadataEfforts(row: Json): string[] {
  const efforts = row.efforts ?? row.supported_efforts ?? row.reasoning_efforts ?? row.supportedEfforts;
  return [...new Set([
    ...(Array.isArray(efforts) ? efforts.filter((effort): effort is string => typeof effort === 'string') : []),
    ...(typeof row.effort === 'string' ? [row.effort] : []),
  ])].sort();
}

export interface ModelVersion {
  /** Complete version-free family line, e.g. 'gpt-sol' or 'claude-sonnet'. */
  line: string;
  parts: number[];
}

/** Parses dotted or dashed numeric release version tokens (excludes zero-padded or multi-digit date snapshots). */
export function parseModelVersion(model: string): ModelVersion | undefined {
  if (typeof model !== 'string') return undefined;
  const match = /(?:^|-)(\d+(?:[.-]\d+)*)(?=-|$)/.exec(model);
  if (!match) return undefined;
  const rawParts = match[1].split(/[.-]/);
  // Reject leading-zero segments (e.g. -0613) and 4+ digit year/YYYYMMDD snapshots so dates never outrank releases.
  if (rawParts.some(segment => !/^(?:0|[1-9]\d{0,2})$/.test(segment))) return undefined;
  const parts = rawParts.map(Number);
  if (parts.some(n => !Number.isSafeInteger(n))) return undefined;
  const line = model.slice(0, match.index) + model.slice(match.index + match[0].length);
  if (/(?:^|-)(?:0\d+|\d{4,})(?:-|$)/.test(line)) return undefined;
  return { line, parts };
}

/** Positive when a > b, negative when a < b, 0 when equal. */
export function compareVersionParts(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

/** Maps each versioned line present in `models` to the highest-version model ID in that line. */
export function newestByLine(models: Iterable<string>): Map<string, string> {
  const best = new Map<string, { model: string; parts: number[] }>();
  for (const model of models) {
    const parsed = parseModelVersion(model);
    if (!parsed) continue;
    const prev = best.get(parsed.line);
    if (!prev || compareVersionParts(parsed.parts, prev.parts) > 0) best.set(parsed.line, { model, parts: parsed.parts });
  }
  return new Map([...best.entries()].map(([line, { model }]) => [line, model]));
}

/** Returns the strictly newer active model ID in the same versioned line, or null if current or unversioned. */
export function supersededBy(model: string, activeModels: Iterable<string>): string | null {
  const target = parseModelVersion(model);
  if (!target) return null;
  const newest = newestByLine(activeModels).get(target.line);
  if (!newest || newest === model) return null;
  const candidate = parseModelVersion(newest);
  return candidate && compareVersionParts(candidate.parts, target.parts) > 0 ? newest : null;
}

export function metadataFamily(row: Json, model: string): string {
  const parsed = parseModelVersion(model);
  // Keep both the prefix and the tier suffix: versions alone distinguish releases, not lines.
  if (parsed) return parsed.line;
  const family = row.family ?? row.model_family;
  return typeof family === 'string' && family ? family : model;
}

export function profileInventory(profiles: readonly ProfileSeed[]): ModelDiscoveries {
  const rows: ModelDiscoveries = [];
  for (const profile of profiles) {
    // A null model delegates to the CLI; it is not a discoverable model identifier.
    if (!profile.model) continue;
    let row = rows.find(candidate => candidate.model === profile.model);
    if (!row) {
      row = { model: profile.model, family: metadataFamily({}, profile.model),
        efforts: [], state: 'preferred', source: 'profile' };
      rows.push(row);
    }
    if (profile.effort && !row.efforts!.includes(profile.effort)) row.efforts!.push(profile.effort);
  }
  for (const row of rows) row.efforts!.sort();
  rows.completeSources = [];
  return rows;
}
