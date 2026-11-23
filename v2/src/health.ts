/**
 * The service-health line in air_sync replies. The watchdog (scripts/automation/Watch-AcHealth.ps1, a scheduled task)
 * writes <home>\health.json; the service only reads it, so a broken watchdog never breaks air_sync.
 *   { "checked_at": ISO time, "problems": [{ "id": "backup", "text": "...", "since": ISO time }] }
 * No file: no line (the watchdog is not installed). A file older than STALE_MS: the watchdog itself stopped.
 */
import fs from 'node:fs';
import path from 'node:path';
import { q } from './air/format.ts';

export const HEALTH_FILE = 'health.json';
export const STALE_MS = 45 * 60_000;

export function healthLine(home: string, at = Date.now()): string | null {
  let raw: string;
  try { raw = fs.readFileSync(path.join(home, HEALTH_FILE), 'utf8'); } catch { return null; }
  let data: any;
  try { data = JSON.parse(raw); } catch { return '! health watchdog=unreadable "health.json is not valid JSON"'; }
  const checked = Date.parse(data?.checked_at);
  if (!Number.isFinite(checked)) return '! health watchdog=unreadable "health.json has no checked_at"';
  if (at - checked > STALE_MS) return `! health watchdog=stale since=${q(new Date(checked).toISOString())} "the health watchdog has not run; check the AgentCommons-Watchdog task"`;
  const problems = Array.isArray(data.problems) ? data.problems.filter((p: any) => p && typeof p.text === 'string') : [];
  if (!problems.length) return null;
  const text = problems.map((p: any) => `${typeof p.id === 'string' ? p.id + ': ' : ''}${p.text}`).join(' | ');
  return `! health n=${problems.length} ${q(text, 600)}`;
}
