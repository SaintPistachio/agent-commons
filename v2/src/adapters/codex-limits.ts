/** Learn only from the rate limits actually observed in this job's event stream. */
import type { ConsumptionRow, UsageObservation, UsageWindow } from './types.ts';

type Row = Record<string, unknown>;
type Sample = UsageObservation & { used: number };
type Series = { first: Sample; last: Sample; count: number; uninterrupted: boolean };
const key = (row: UsageObservation) => JSON.stringify([row.pool, row.window]);
const row = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : undefined;

function resetTime(value: unknown, minutes: number, now: number): string | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return null;
  const ms = value * 1000;
  // Reject millisecond timestamps or bogus far-future resets that would pin a cooldown near-permanently.
  if (!Number.isFinite(ms) || ms > now + (minutes + 60) * 60_000) return null;
  return new Date(ms).toISOString();
}

function sample(pool: string, value: unknown, now: number): Sample | undefined {
  const input = row(value), used = input?.used_percent, minutes = input?.window_minutes;
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100 ||
      typeof minutes !== 'number' || !Number.isSafeInteger(minutes) || minutes <= 0) return undefined;
  return { pool, window: `${minutes}m`, used, remaining_percent: 100 - used, resets_at: resetTime(input?.resets_at, minutes, now) };
}

export function codexLimits(events: Iterable<unknown>, previous: UsageWindow[] = [], now = Date.now()): {
  usage: UsageObservation[]; evidence: ConsumptionRow[]; cooldownUntil: string | null; reached: boolean;
} {
  const series = new Map<string, Series>();
  const known = new Map(previous.map(window => [key(window), window]));
  const pools = new Set(previous.map(window => window.pool));
  let reached = false;
  for (const event of events) {
    const data = row(event);
    const limits = row(data?.rate_limits) ?? row(row(data?.payload)?.rate_limits);
    const pool = limits?.limit_id;
    if (!limits || typeof pool !== 'string' || !pool.trim()) continue;
    pools.add(pool);
    const primary = sample(pool, limits.primary, now), secondary = sample(pool, limits.secondary, now);
    const samples = [...new Map([primary, secondary].filter((value): value is Sample => !!value).map(value => [key(value), value])).values()];
    const signal = limits.rate_limit_reached_type;
    const closed = typeof signal === 'string' && !!signal.trim();
    reached ||= closed;
    const named = signal === 'primary' ? primary : signal === 'secondary' ? secondary : undefined;
    const exhausted = samples.filter(value => value.used === 100 && value.resets_at && Date.parse(value.resets_at) > now);
    const future = samples.filter(value => value.resets_at && Date.parse(value.resets_at) > now)
      .sort((a, b) => Date.parse(a.resets_at!) - Date.parse(b.resets_at!));
    // If the signal does not identify a window and none reports 100%, use the first
    // possible reset as the conservative time to start considering the pool open again.
    const blocked = !closed ? [] : named ? [named] : exhausted.length ? exhausted : future.slice(0, 1);
    const marked = new Set(blocked.map(key));
    for (const value of samples) {
      const id = key(value), before = series.get(id), previousWindow = before?.last ?? known.get(id);
      const sameReset = value.resets_at !== null && value.resets_at === previousWindow?.resets_at;
      const recovered = previousWindow?.remaining_percent != null ? value.used < 100 - previousWindow.remaining_percent
        : previousWindow?.closed === true && value.used === 0;
      value.closed = !!value.resets_at && Date.parse(value.resets_at) > now &&
        (marked.has(id) || (sameReset && previousWindow?.closed === true && !recovered));
      series.set(id, { first: before?.first ?? value, last: value, count: (before?.count ?? 0) + 1,
        uninterrupted: !before || (before.uninterrupted && sameReset) });
    }
  }
  const usage = [...series.values()].map(({ last: { used: _used, ...value } }) => value);
  const evidence = [...series.values()].flatMap(({ first, last, count, uninterrupted }) =>
    count > 1 && uninterrupted ? [{ pool: first.pool, window: first.window, consumed: last.used > first.used }] : []);
  const closedUntil = new Map<string, number>();
  const current = new Map<string, UsageObservation>(previous.map(window => [key(window), window]));
  for (const value of usage) current.set(key(value), value);
  for (const value of current.values()) {
    const reset = value.resets_at ? Date.parse(value.resets_at) : NaN;
    if (value.closed && reset > now) closedUntil.set(value.pool, Math.max(closedUntil.get(value.pool) ?? 0, reset));
  }
  const cooldownUntil = pools.size && [...pools].every(pool => closedUntil.has(pool))
    ? new Date(Math.min(...closedUntil.values())).toISOString() : null;
  return { usage, evidence, cooldownUntil, reached };
}

function mapAppServerWindow(value: unknown): Row | null {
  const w = row(value);
  if (!w) return null;
  return {
    used_percent: w.usedPercent,
    window_minutes: w.windowDurationMins,
    resets_at: w.resetsAt,
  };
}

/**
 * Normalize a `codex app-server` `account/rateLimits/read` JSON-RPC result into `UsageObservation[]`
 * using the same pool IDs, window keys, and reset rules as `codexLimits()`.
 */
export function parseCodexAppServerRateLimits(result: unknown, previous: UsageWindow[] = [], now = Date.now(), observedAt?: string): UsageObservation[] | undefined {
  const r = row(result);
  if (!r) return undefined;
  const candidates: Row[] = [];
  const byId = row(r.rateLimitsByLimitId);
  if (byId) for (const entry of Object.values(byId)) { const s = row(entry); if (s) candidates.push(s); }
  const single = row(r.rateLimits);
  if (single) candidates.push(single);
  if (!candidates.length) return undefined;

  const prevPools = [...new Set(previous.map(w => w.pool))];
  const fallbackPool = prevPools.length === 1 ? prevPools[0] : undefined;
  const seen = new Set<string>();
  const events: Row[] = [];
  for (const snap of candidates) {
    const pool = typeof snap.limitId === 'string' && snap.limitId.trim() ? snap.limitId.trim() : fallbackPool;
    if (!pool || seen.has(pool)) continue;
    seen.add(pool);
    events.push({
      rate_limits: {
        limit_id: pool,
        rate_limit_reached_type: typeof snap.rateLimitReachedType === 'string' && snap.rateLimitReachedType.trim() ? snap.rateLimitReachedType.trim() : null,
        primary: mapAppServerWindow(snap.primary),
        secondary: mapAppServerWindow(snap.secondary),
      },
    });
  }
  if (!events.length) return undefined;
  const { usage } = codexLimits(events, previous, now);
  if (!usage.length) return undefined;
  return observedAt ? usage.map(u => ({ ...u, observed_at: observedAt })) : usage;
}
