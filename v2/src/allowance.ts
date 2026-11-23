import type { UsageWindow } from './adapters/types.ts';

/**
 * Allowance-aware ordering for route=auto (j20 section 1, stage 6). Pure: no I/O, no inference, no limit changes.
 *
 * A route's allowance is read from its fresh usage windows. Each pool is bound by its tightest window (the same rule
 * as routeQuotaState); the route's usable pool is the one with the most remaining. Only that binding window decides:
 * - `expiring`: it resets soon and much of it is left, so the allowance would otherwise lapse unused.
 * - `scarce`: little of it is left and its reset is far away, so it is held back while a comparable route can serve.
 * - `neutral`: anything else, including unknown or stale usage (unknown is not exhausted and not plentiful).
 *
 * The thresholds below are scheduling policy, not facts about any provider's quota. They only reorder routes that
 * are already eligible and in the same billing class; they never admit a route, lift a cooldown, or raise a limit.
 */
export const ALLOWANCE_POLICY = {
  /** Binding window has at least this much left (percent) to count as expiring. */
  expiringMinRemaining: 50,
  /** ...and resets within this share of its window length. */
  expiringShareOfWindow: 0.25,
  /** Fallback horizon when the window length cannot be read from its label (for example a prepaid grant). */
  expiringFallbackMs: 24 * 3600_000,
  /** Binding window has at most this much left (percent) to count as scarce (15 or less is already low quota). */
  scarceMaxRemaining: 30,
  /** ...and its reset is further away than this share of its window (or the fallback horizon). */
  scarceShareOfWindow: 0.5,
} as const;

export type AllowanceClass = 'expiring' | 'neutral' | 'scarce';
export interface Allowance { cls: AllowanceClass; pool?: string; window?: string; remaining?: number; resetsAt?: string }

const HOUR = 3600_000;
/**
 * Window length from its label when the label states it: Codex `300m`/`10080m`, `5h`, `5-hour`, `30-day`, or the
 * whole words `weekly`/`week`/`daily`. Anything else (`grant`, `biweekly`) has no known length.
 */
export function windowLengthMs(label: string): number | null {
  const minutes = /^(\d{1,6})m$/.exec(label);
  if (minutes) return Number(minutes[1]) * 60_000;
  const hours = /\b(\d{1,3})[\s-]?h(?:ours?|r)?\b/i.exec(label);
  if (hours) return Number(hours[1]) * HOUR;
  const days = /\b(\d{1,3})[\s-]?d(?:ays?)?\b/i.exec(label);
  if (days) return Number(days[1]) * 24 * HOUR;
  if (/\b(?:weekly|week)\b/i.test(label)) return 7 * 24 * HOUR;
  if (/\bdaily\b/i.test(label)) return 24 * HOUR;
  return null;
}

const left = (w: UsageWindow) => w.closed ? 0 : w.remaining_percent!;
const resetAt = (w: UsageWindow) => w.resets_at === null ? Infinity : Date.parse(w.resets_at);

export function classifyAllowance(windows: readonly UsageWindow[], at = Date.now()): Allowance {
  // Tightest fresh window per pool; a window without a known remaining value makes its pool unknown. On a tie the
  // later reset binds (the conservative reading: the sooner window's surplus is still limited by the longer one).
  const pools = new Map<string, UsageWindow | null>();
  for (const w of windows) {
    if (w.stale) continue;
    if (!w.closed && w.remaining_percent === null) { pools.set(w.pool, null); continue; }
    const current = pools.get(w.pool);
    if (current === null) continue;
    if (!current || left(w) < left(current) || (left(w) === left(current) && resetAt(w) > resetAt(current))) pools.set(w.pool, w);
  }
  // Independent pools are alternatives: the most remaining wins; on a tie the sooner reset (use it or lose it).
  let best: UsageWindow | undefined;
  for (const w of pools.values()) {
    if (!w) continue;
    if (!best || left(w) > left(best) || (left(w) === left(best) && resetAt(w) < resetAt(best))) best = w;
  }
  if (!best || best.closed || best.resets_at === null) return { cls: 'neutral' };
  const remaining = best.remaining_percent!, until = Date.parse(best.resets_at) - at;
  if (!Number.isFinite(until) || until <= 0) return { cls: 'neutral' };
  const length = windowLengthMs(best.window);
  const detail = { pool: best.pool, window: best.window, remaining, resetsAt: best.resets_at };
  const p = ALLOWANCE_POLICY;
  if (remaining >= p.expiringMinRemaining && until <= (length ? length * p.expiringShareOfWindow : p.expiringFallbackMs))
    return { cls: 'expiring', ...detail };
  if (remaining <= p.scarceMaxRemaining && until > (length ? length * p.scarceShareOfWindow : p.expiringFallbackMs))
    return { cls: 'scarce', ...detail };
  return { cls: 'neutral' };
}

/** Sort key: lower is preferred. */
export const allowanceRank = (cls: AllowanceClass): number => cls === 'expiring' ? 0 : cls === 'neutral' ? 1 : 2;

/** Short label for job options, e.g. `expiring:gemini/weekly@62%`. */
export const allowanceLabel = (a: Allowance): string =>
  a.cls === 'neutral' ? 'neutral' : `${a.cls}:${a.pool}/${a.window}@${Math.round(a.remaining!)}%`;
