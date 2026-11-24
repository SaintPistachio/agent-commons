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
  if (/\bfive[\s-]?hours?\b/i.test(label)) return 5 * HOUR;
  const days = /\b(\d{1,3})[\s-]?d(?:ays?)?\b/i.exec(label);
  if (days) return Number(days[1]) * 24 * HOUR;
  if (/\b(?:weekly|week)\b/i.test(label)) return 7 * 24 * HOUR;
  if (/\bdaily\b/i.test(label)) return 24 * HOUR;
  return null;
}

const left = (w: UsageWindow) => w.closed ? 0 : w.remaining_percent!;
const resetAt = (w: UsageWindow) => w.resets_at === null ? Infinity : Date.parse(w.resets_at);

/**
 * Selects the binding fresh window across pools: each pool is bound by its tightest window
 * (a window with unknown remaining makes its pool unknown), and independent pools choose the
 * one with the most remaining headroom (ties break to the sooner reset).
 */
export function bindingWindow(windows: readonly UsageWindow[]): UsageWindow | undefined {
  const pools = new Map<string, UsageWindow | null>();
  for (const w of windows) {
    if (w.stale) continue;
    if (!w.closed && w.remaining_percent === null) { pools.set(w.pool, null); continue; }
    const current = pools.get(w.pool);
    if (current === null) continue;
    if (!current || left(w) < left(current) || (left(w) === left(current) && resetAt(w) > resetAt(current))) pools.set(w.pool, w);
  }
  let best: UsageWindow | undefined;
  for (const w of pools.values()) {
    if (!w) continue;
    if (!best || left(w) > left(best) || (left(w) === left(best) && resetAt(w) < resetAt(best))) best = w;
  }
  return best;
}

export function classifyAllowance(windows: readonly UsageWindow[], at = Date.now()): Allowance {
  const best = bindingWindow(windows);
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

export interface WindowPace {
  elapsedPercent: number;
  remainingTimePercent: number;
  pacePercent: number;
  windowMs: number;
  remainingMs: number;
}

export type WindowProjection =
  | { kind: 'too_early' }
  | { kind: 'remaining_at_reset'; percent: number }
  | { kind: 'runs_out'; afterMs: number };

/** Advisory ratio of remaining allowance percent to remaining time percent (> 100% = ahead of even pace). */
export function windowPace(window: UsageWindow, at = Date.now()): WindowPace | null {
  if (window.stale || (!window.closed && window.remaining_percent === null) || window.resets_at === null) return null;
  const windowMs = windowLengthMs(window.window);
  if (windowMs === null || windowMs <= 0) return null;
  const remainingMs = Date.parse(window.resets_at) - at;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return null;
  const remaining = window.closed ? 0 : Math.min(100, Math.max(0, window.remaining_percent!));
  const remainingTimePercent = Math.min(100, Math.max(0, (remainingMs / windowMs) * 100));
  const elapsedPercent = Math.min(100, Math.max(0, 100 - remainingTimePercent));
  const pacePercent = remainingTimePercent > 0 ? Math.min(1000, (remaining / remainingTimePercent) * 100) : 0;
  return { elapsedPercent, remainingTimePercent, pacePercent, windowMs, remainingMs };
}

/** Advisory linear burn-rate forecast through the end of the current window (guarded below 5% elapsed). */
export function windowProjection(window: UsageWindow, at = Date.now()): WindowProjection | null {
  if (window.stale || (!window.closed && window.remaining_percent === null)) return null;
  const remaining = window.closed ? 0 : Math.min(100, Math.max(0, window.remaining_percent!));
  if (remaining <= 0) return { kind: 'runs_out', afterMs: 0 };
  const pace = windowPace(window, at);
  if (!pace) return null;
  if (pace.elapsedPercent < 5) return { kind: 'too_early' };
  const used = 100 - remaining;
  if (used <= 0) return { kind: 'remaining_at_reset', percent: remaining };
  const rate = used / pace.elapsedPercent;
  const leftAtReset = remaining - rate * pace.remainingTimePercent;
  return leftAtReset >= 0
    ? { kind: 'remaining_at_reset', percent: leftAtReset }
    : { kind: 'runs_out', afterMs: (remaining / rate / 100) * pace.windowMs };
}

export function formatCompactDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

/** Human-readable advisory pace and reset forecast for CLI status and viewer cards. */
export function formatPaceSummary(window: UsageWindow, at = Date.now()): string | null {
  const pace = windowPace(window, at);
  if (!pace) return null;
  const pct = Math.round(pace.pacePercent);
  const proj = windowProjection(window, at);
  if (!proj || proj.kind === 'too_early') return `pace ${pct}%`;
  if (proj.kind === 'remaining_at_reset') return `pace ${pct}%, proj +${Math.round(proj.percent)}% at reset`;
  return `pace ${pct}%, proj runs out in ${formatCompactDuration(proj.afterMs)}`;
}

export interface UsageHistoryPoint {
  observed_at: string;
  remaining_percent: number;
}

export interface UsageHistoryCycle {
  route: string;
  pool: string;
  window: string;
  started_at: string;
  resets_at: string;
  points: UsageHistoryPoint[];
}

export function downsamplePoints<T>(points: readonly T[], limit = 240): T[] {
  if (points.length <= limit || limit <= 1) return [...points];
  return Array.from({ length: limit }, (_, i) => points[Math.floor((i * (points.length - 1)) / (limit - 1))]);
}

/** Sort key: lower is preferred. */
export const allowanceRank = (cls: AllowanceClass): number => cls === 'expiring' ? 0 : cls === 'neutral' ? 1 : 2;

/** Short label for job options, e.g. `expiring:gemini/weekly@62%`. */
export const allowanceLabel = (a: Allowance): string =>
  a.cls === 'neutral' ? 'neutral' : `${a.cls}:${a.pool}/${a.window}@${Math.round(a.remaining!)}%`;
