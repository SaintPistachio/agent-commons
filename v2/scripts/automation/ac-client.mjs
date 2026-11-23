// Shared helpers for the Agent Commons automation scripts (plain Node 24, no dependencies).
// Writes go through the loopback API with a connection file, exactly as an app's own calls do. Reads that the API
// cannot answer (a job by its ac/job-<prefix> branch name, jobs on a route since a time) open the database read-only.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The Agent Commons home: AGENT_COMMONS_HOME, else the folder that holds `current` (this file is in current\v2\scripts\automation). */
export function acHome() {
  if (process.env.AGENT_COMMONS_HOME) return process.env.AGENT_COMMONS_HOME;
  const here = path.dirname(fileURLToPath(import.meta.url));
  // <home>\current\v2\scripts\automation or <home>\app\<commit>\v2\scripts\automation
  for (let dir = here, i = 0; i < 6; i++, dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'commons.sqlite'))) return dir;
  }
  throw new Error('Set AGENT_COMMONS_HOME when running from a source checkout.');
}

/** A connection by actor name (connections\<name>.json) or by file path. Returns null when it does not exist. */
export function loadConnection(nameOrFile, home = acHome()) {
  const file = nameOrFile.includes('\\') || nameOrFile.includes('/') || nameOrFile.endsWith('.json')
    ? nameOrFile : path.join(home, 'connections', `${nameOrFile}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

/** One API call; returns the `air` text, or throws with the service's error. */
export async function call(connection, method, input, timeoutMs = 10_000) {
  const response = await fetch(connection.url + '/api/v1/call', {
    method: 'POST', signal: AbortSignal.timeout(timeoutMs),
    headers: { authorization: 'Bearer ' + connection.token, 'content-type': 'application/json' },
    body: JSON.stringify({ method, input }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status} ${JSON.stringify(body?.error ?? body).slice(0, 400)}`);
  return typeof body?.result?.air === 'string' ? body.result.air : JSON.stringify(body?.result ?? body);
}

export const airTx = (connection, projectId, packet, operationId) =>
  call(connection, 'air_tx', { project_id: projectId, packet, operation_id: operationId });

/** A string value as an AIR-T JSON string (always quoted, so any text is safe). */
export const q = (text) => JSON.stringify(String(text).replace(/\s+/g, ' ').trim().slice(0, 3800));

/** Read-only database handle; the caller closes it. */
export async function openDb(home = acHome()) {
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(path.join(home, 'commons.sqlite'), { readOnly: true });
}

/** Resolves jN, a full UUID or an 8+ character UUID prefix to the job row, or null. */
export function findJob(db, ref) {
  const r = String(ref).trim().toLowerCase();
  let id = null;
  const short = /^j(\d+)$/.exec(r);
  if (short) id = db.prepare(`SELECT id FROM jobs WHERE seq=?`).get(Number(short[1]))?.id ?? null;  // jN is the job's seq
  else if (/^[0-9a-f-]{8,36}$/.test(r)) {
    const rows = db.prepare(`SELECT id FROM jobs WHERE id LIKE ? LIMIT 2`).all(r + '%');
    if (rows.length === 1) id = rows[0].id;
  }
  if (!id) return null;
  return db.prepare(`SELECT id, seq, project_id, route, mode, status, created_by, created_at, finished_at, error FROM jobs WHERE id=?`).get(id) ?? null;
}

/** The project ID for a name or handle (p1); falls back to the only unarchived project. */
export function projectId(db, ref = 'p1') {
  const short = /^p(\d+)$/.exec(ref);
  if (short) { const row = db.prepare(`SELECT id FROM short_ids WHERE kind='p' AND num=?`).get(Number(short[1])); if (row) return row.id; }
  const byName = db.prepare(`SELECT id FROM projects WHERE name=? OR id=?`).get(ref, ref);
  return byName?.id ?? null;
}

export const args = process.argv.slice(2);
export const option = (name, fallback) => { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback; };
export const flag = (name) => args.includes('--' + name);
