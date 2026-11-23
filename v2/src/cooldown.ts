/**
 * When a route that reported QUOTA_EXHAUSTED may be tried again. A reset time in the message wins when it is in the
 * future and at most 8 days ahead (usage windows are weekly at most); otherwise a conservative 15 minutes.
 */
const DEFAULT_MS = 15 * 60 * 1000, MAX_AHEAD_MS = 8 * 24 * 60 * 60 * 1000;
const UNIT_MS: Record<string, number> = { second: 1000, minute: 60000, hour: 3600000, day: 86400000 };

function nextZonedTimeMs(hour24: number, minute: number, zone: string, now: number): number | null {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
    const parts = (ms: number) => {
      const m: Record<string, number> = {};
      for (const p of fmt.formatToParts(new Date(ms))) if (p.type !== 'literal') m[p.type] = Number(p.value);
      return m;
    };
    const cur = parts(now);
    const localAsUtc = (y: number, mo: number, d: number, h: number, mi: number) => Date.UTC(y, mo - 1, d, h, mi, 0, 0);
    for (const dayOffset of [0, 1]) {
      const target = localAsUtc(cur.year, cur.month, cur.day + dayOffset, hour24, minute);
      let guess = target;
      for (let i = 0; i < 3; i++) {
        const p = parts(guess);
        const diff = target - localAsUtc(p.year, p.month, p.day, p.hour, p.minute);
        if (diff === 0) break;
        guess += diff;
      }
      if (guess > now) return guess;
    }
    return null;
  } catch { return null; }
}

export function cooldownUntil(message: string, now = Date.now()): string {
  const plausible = (ms: number) => Number.isFinite(ms) && ms > now && ms - now <= MAX_AHEAD_MS;
  const candidates: number[] = [];
  const epoch = /\|(\d{10})\b/.exec(message);  // "usage limit reached|1795176000" (epoch seconds)
  if (epoch) candidates.push(Number(epoch[1]) * 1000);
  const iso = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})/.exec(message);
  if (iso) candidates.push(Date.parse(iso[0]));
  const wall = /\bresets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+)\)/i.exec(message);
  if (wall) {
    const h12 = Number(wall[1]), min = wall[2] ? Number(wall[2]) : 0, ampm = wall[3].toLowerCase();
    if (h12 >= 1 && h12 <= 12 && min >= 0 && min <= 59) {
      const h24 = (h12 % 12) + (ampm === 'pm' ? 12 : 0);
      const resolved = nextZonedTimeMs(h24, min, wall[4], now);
      if (resolved !== null) candidates.push(resolved);
    }
  }
  const relative = /\bin (\d{1,4}) ?(second|minute|hour|day)s?\b/i.exec(message);
  if (relative) candidates.push(now + Number(relative[1]) * UNIT_MS[relative[2].toLowerCase()]);
  return new Date(candidates.find(plausible) ?? now + DEFAULT_MS).toISOString();
}
