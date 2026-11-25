import type { UsageSnapshot } from './types.ts';

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function dollars(value: unknown): number | null {
  if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim())) value = Number(value);
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function expiry(value: unknown): number {
  if (typeof value === 'number') return new Date(value * 1000).getTime();
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? Date.parse(value) : NaN;
}

/** Parse a local `credits` reply. Unknown or inconsistent amounts do not imply a full or empty grant. */
export function openAICreditUsage(reply: unknown): UsageSnapshot {
  const credits = record(reply);
  const balance = dollars(credits?.observed_balance_usd);
  const remaining = dollars(credits?.estimated_remaining_usd);
  const spendable = dollars(credits?.spendable_estimate_after_reservations_usd);
  const percent = balance !== null && balance > 0 && spendable !== null && spendable >= 0 && spendable <= balance
    ? 100 * (spendable / balance) : null;

  const grants = credits?.grants;
  const entries = Array.isArray(grants) ? grants : record(grants)?.data;
  let earliest = Infinity;
  if (Array.isArray(entries)) for (const value of entries) {
    const grant = record(value);
    if (!grant) continue;
    // Prefer an explicit remaining amount, including zero, over the original grant amount.
    const left = dollars(grant.remaining_usd ?? grant.remaining_amount_usd ?? grant.balance_usd);
    const amount = dollars(grant.amount_usd ?? grant.grant_amount_usd ?? grant.grant_amount);
    const used = dollars(grant.used_amount_usd ?? grant.used_amount);
    const positive = left ?? (amount === null ? 0 : amount - (used ?? 0));
    const end = expiry(grant.expires_at);
    if (positive > 0 && Number.isFinite(end)) earliest = Math.min(earliest, end);
  }

  // Weekly spend budget (the helper spreads each grant over its remaining weeks): a window of known length, so the
  // allowance rules can see when prepaid credit is on track to go unused. Display figures only; the helper admits.
  const weekly = record(credits?.weekly_budget);
  const limit = dollars(weekly?.weekly_limit_usd), available = dollars(weekly?.available_for_new_requests_usd);
  const weeklyReset = typeof weekly?.reset_at === 'string' ? Date.parse(weekly.reset_at) : NaN;
  const weeklyRow = weekly && limit !== null && limit > 0 && Number.isFinite(weeklyReset) ? [{
    pool: 'prepaid', window: 'weekly',
    remaining_percent: available === null ? null : Math.min(100, Math.max(0, 100 * available / limit)),
    resets_at: new Date(weeklyReset).toISOString(),
  }] : [];

  const display = (value: number | null) => value === null ? 'unknown' : `$${value}`;
  const weekNote = weeklyRow.length
    ? `; this week ${display(available)} of ${display(limit)}${weekly?.display_from_stale_costs ? ' (from the last Costs read)' : ''}` : '';
  return {
    rows: [{
      pool: 'prepaid', window: 'grant', remaining_percent: percent,
      resets_at: Number.isFinite(earliest) ? new Date(earliest).toISOString() : null,
    }, ...weeklyRow],
    // Status already renders the source and observation time, including for stale snapshots.
    source: `helper credits; observed balance ${display(balance)}; estimated remaining ${display(remaining)}; spendable after reservations ${display(spendable)}${weekNote}`,
  };
}
