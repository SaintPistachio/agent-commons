import { posix } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

type Row = Record<string, unknown>;

const entities = {
  task: { table: 'tasks', prefix: 't', seq: 'seq', task: 'id' },
  decision: { table: 'decisions', prefix: 'd', seq: 'seq', task: 'task_id' },
  checkpoint: { table: 'checkpoints', prefix: 'c', seq: 'seq', task: 'task_id' },
  discussion: { table: 'discussions', prefix: 'g', seq: 'seq', task: 'task_id' },
  artifact: { table: 'artifacts', prefix: 'a', seq: 'rowid', task: 'NULL' },
  job: { table: 'jobs', prefix: 'j', seq: 'seq', task: 'task_id' },
} as const;
type Kind = keyof typeof entities;
const kinds = Object.keys(entities) as Kind[];
const isKind = (kind: unknown): kind is Kind =>
  typeof kind === 'string' && Object.hasOwn(entities, kind);

export function extractRefTokens(values: unknown[]): string[] {
  const tokens = new Set<string>();
  const pending = [...values].reverse();
  const visited = new Set<unknown[]>();
  const addPath = (raw: string) => {
    const path = raw.toLowerCase().replaceAll('\\', '/');
    tokens.add(path);
    tokens.add(posix.basename(path));
    return path;
  };
  while (pending.length) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      if (!visited.has(value)) {
        visited.add(value);
        for (let i = value.length - 1; i >= 0; i--) pending.push(value[i]);
      }
      continue;
    }
    if (typeof value !== 'string') continue;
    const text = value.toLowerCase();
    for (const [, prefix, path] of text.matchAll(/\b(file|test):([a-z0-9_./\\-]+\.[a-z0-9]+)/g)) {
      tokens.add(`${prefix}:${path.replaceAll('\\', '/')}`);
      addPath(path);
    }
    for (const [handle] of text.matchAll(/\b[tdcgmaj][1-9]\d*\b/g)) tokens.add(handle);
    for (const [path] of text.matchAll(/[a-z0-9_./\\-]+\.[a-z0-9]+/g)) addPath(path);
  }
  return [...tokens];
}

interface IndexItem {
  projectId: string;
  taskId: string | null;
  kind: string;
  entityId: string;
  handle: string;
  seq: number;
  primaryText: string;
  secondaryText: string;
  refSources: unknown[];
}

export function indexEntity(db: DatabaseSync, item: IndexItem, skipDelete = false): void {
  const { projectId, taskId, kind, entityId, handle, seq, primaryText, secondaryText } = item;
  const tokens = extractRefTokens(item.refSources);
  if (!skipDelete) {
    db.prepare('DELETE FROM memory_fts WHERE project_id = ? AND kind = ? AND entity_id = ?')
      .run(projectId, kind, entityId);
    db.prepare('DELETE FROM entity_refs WHERE project_id = ? AND kind = ? AND entity_id = ?')
      .run(projectId, kind, entityId);
  }
  db.prepare(`INSERT INTO memory_fts
    (entity_id, handle, project_id, task_id, kind, primary_text, secondary_text, refs_text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(entityId, handle, projectId, taskId, kind, primaryText, secondaryText, tokens.join(' '));
  if (tokens.length) {
    const insert = db.prepare(`INSERT INTO entity_refs
      (project_id, kind, entity_id, handle, seq, ref_token) VALUES (?, ?, ?, ?, ?, ?)`);
    for (const token of tokens) insert.run(projectId, kind, entityId, handle, seq, token);
  }
}

const text = (...values: unknown[]) =>
  values.filter((value): value is string => typeof value === 'string' && value !== '').join('\n');

function refValue(value: unknown): unknown {
  if (typeof value === 'string' && value.trimStart().startsWith('[')) {
    try { return JSON.parse(value); } catch { /* keep non-JSON text */ }
  }
  return value;
}

/** Use the same field projection on live writes and on schema backfill. */
export function indexMemoryRow(db: DatabaseSync, kind: string, row: Row, handle: string, skipDelete = false): void {
  if (!isKind(kind)) return;
  let contextRefs: unknown;
  if (kind === 'job' && typeof row.options === 'string') {
    try { contextRefs = JSON.parse(row.options)?.ctx; } catch { /* legacy options */ }
  }
  let artifactHandles: unknown;
  if (kind === 'checkpoint' && typeof row.artifacts === 'string') {
    const ids = refValue(row.artifacts);
    if (Array.isArray(ids) && ids.length) {
      const lookup = db.prepare("SELECT num FROM short_ids WHERE kind = 'a' AND id = ?");
      artifactHandles = ids.map(id => {
        if (typeof id !== 'string') return null;
        if (/^a[1-9]\d*$/i.test(id)) return id.toLowerCase();
        const found = lookup.get(id) as { num?: number } | undefined;
        return found?.num ? `a${found.num}` : id;
      });
    }
  }
  const taskId = kind === 'task' ? row.id : row.task_id;
  indexEntity(db, {
    projectId: String(row.project_id), taskId: taskId == null ? null : String(taskId),
    kind, entityId: String(row.id), handle, seq: Number(row.memory_seq ?? row.seq),
    primaryText: text(row.title, row.summary, row.subject, row.name, row.prompt),
    secondaryText: text(row.objective, row.rationale, row.question, row.outcome, row.result, row.error),
    refSources: [
      row.acceptance, row.evidence, row.checks, row.artifacts, artifactHandles, row.changed_files, row.context_refs,
      contextRefs, kind === 'artifact' ? row.name : null,
    ].map(refValue),
  }, skipDelete);
}

export function backfillMemoryIndex(db: DatabaseSync): void {
  db.exec('DELETE FROM memory_fts; DELETE FROM entity_refs;');
  const shortIds = new Map<string, unknown>();
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'short_ids' AND type = 'table'").get()) {
    for (const row of db.prepare('SELECT * FROM short_ids').iterate()) {
      const id = row.entity_id ?? row.id;
      const kind = row.kind ?? row.prefix ?? '';
      const value = row.handle ?? row.n ?? row.short_id ?? row.num ?? row.seq ?? row.short;
      if (typeof id === 'string' && value != null) shortIds.set(`${kind}:${id}`, value);
    }
  }
  for (const kind of kinds) {
    const { table, prefix, seq, task } = entities[kind];
    const cols = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name));
    if (!cols.has('id') || !cols.has('project_id')) continue;
    for (const row of db.prepare(`SELECT *, ${seq} AS memory_seq, ${task} AS memory_task FROM ${table}`).iterate()) {
      const id = String(row.id);
      const mapped = shortIds.get(`${kind}:${id}`) ?? shortIds.get(`${prefix}:${id}`) ?? shortIds.get(`:${id}`);
      const handle = String(mapped ?? (kind === 'artifact' ? '' : row.memory_seq)).toLowerCase();
      if (!new RegExp(`^${prefix}?[1-9]\\d*$`).test(handle)) {
        throw new Error(`MEMORY_SHORT_ID_MISSING: ${kind}:${id}`);
      }
      indexMemoryRow(db, kind, row, handle.startsWith(prefix) ? handle : `${prefix}${handle}`, true);
    }
  }
}

export function activeDecisionsSql(alias = 'decisions'): string {
  return `NOT EXISTS (SELECT 1 FROM decisions d_sup WHERE d_sup.project_id = ${alias}.project_id AND d_sup.supersedes = ${alias}.id)`;
}

interface Candidate {
  kind: Kind;
  id: string;
  seq: number;
  taskId: string | null;
  row: Row;
}

const catalogSql = kinds.map(kind => {
  const { table, seq, task } = entities[kind];
  return `SELECT '${kind}' AS kind, id, ${seq} AS seq, ${task} AS task_id
          FROM ${table} WHERE project_id = $project`;
}).join(' UNION ALL ');

const graphSql = `
  WITH catalog AS NOT MATERIALIZED (${catalogSql}),
  seeds AS (
    SELECT kind, entity_id AS id, 0 AS hop FROM entity_refs
    WHERE project_id = $project AND ref_token IN (SELECT value FROM json_each($tokens))
    UNION
    SELECT kind, entity_id AS id, 0 AS hop FROM memory_fts
    WHERE project_id = $project AND handle IN (SELECT value FROM json_each($handles))
  ),
  matched AS (
    SELECT c.*, min(s.hop) AS hop FROM catalog c JOIN seeds s ON s.kind = c.kind AND s.id = c.id
    GROUP BY c.kind, c.id
  ),
  neighbors AS (
    SELECT kind, id, seq, hop FROM matched
    UNION ALL
    SELECT c.kind, c.id, c.seq, 1 AS hop FROM catalog c
    WHERE c.kind = 'task' AND c.id IN (SELECT task_id FROM matched)
    UNION ALL
    SELECT 'decision', d.id, d.seq, 1 AS hop FROM decisions d
    WHERE d.project_id = $project AND d.supersedes IN (SELECT id FROM matched WHERE kind = 'decision')
  )
  SELECT kind, id, min(hop) AS hop, max(seq) AS seq FROM neighbors
  GROUP BY kind, id
  ORDER BY hop ASC, seq DESC, kind, id LIMIT 40`;

export function recallProjectMemory(db: DatabaseSync, options: {
  projectId: string;
  query: string;
  maxChars: number;
  renderEntity: (kind: string, id: string) => string | null;
}): { lines: string[]; hits: number } {
  const { projectId, query, renderEntity } = options;
  const budget = Math.floor(options.maxChars);
  if (!Number.isFinite(budget) || budget <= 0) return { lines: [], hits: 0 };

  const words = [...new Set(query.toLowerCase().match(/[a-z0-9_]+/g) ?? [])];
  const refs = extractRefTokens([query]);
  const tokens = [...new Set([...words, ...refs])];
  if (!tokens.length) return { lines: [], hits: 0 };

  const lexical = words.length ? db.prepare(`
    SELECT kind, entity_id AS id FROM memory_fts WHERE memory_fts MATCH ? AND project_id = ?
    ORDER BY bm25(memory_fts), kind, entity_id LIMIT 40`)
    .all(words.map(word => `"${word}"`).join(' OR '), projectId) : [];
  const graph = db.prepare(graphSql).all({
    $project: projectId, $tokens: JSON.stringify(tokens),
    $handles: JSON.stringify(refs.filter(token => /^[tdcgaj][1-9]\d*$/.test(token))),
  });

  const key = (kind: string, id: string) => `${kind}:${id}`;
  const cache = new Map<string, Candidate | null>();
  const resolve = (hit: Row): Candidate | null => {
    if (!isKind(hit.kind) || typeof hit.id !== 'string') return null;
    const { kind, id } = hit;
    const k = key(kind, id);
    if (cache.has(k)) return cache.get(k) ?? null;
    const { table, seq, task } = entities[kind];
    const extra = kind === 'decision' ? `, confidence, ${activeDecisionsSql()} AS active`
      : kind === 'checkpoint' ? ', confidence, failed'
      : kind === 'job' ? ', consult_verdict'
      : kind === 'task' ? ', status' : '';
    const row = db.prepare(`SELECT ${seq} AS seq, ${task} AS task_id${extra}
      FROM ${table} WHERE project_id = ? AND id = ?`).get(projectId, id);
    const candidate = row
      ? { kind, id, seq: Number(row.seq), taskId: row.task_id == null ? null : String(row.task_id), row }
      : null;
    cache.set(k, candidate);
    return candidate;
  };

  const unique = (hits: Row[]): Candidate[] => {
    const seen = new Map<string, Candidate>();
    for (const hit of hits) {
      const candidate = resolve(hit);
      if (candidate) seen.set(key(candidate.kind, candidate.id), candidate);
    }
    return [...seen.values()];
  };
  const arms = [unique(lexical), unique(graph)];
  // Entity sequences are local to their tables; event sequences order different kinds.
  const nextFix = db.prepare(`
    SELECT e.kind, e.entity_id AS id
    FROM events e
    WHERE e.project_id = $project AND e.task_id IS $task
      AND e.seq > (
        SELECT max(origin.seq) FROM events origin
        WHERE origin.project_id = $project AND origin.kind = $kind AND origin.entity_id = $id
      )
      AND (
        (e.kind = 'checkpoint' AND EXISTS (
          SELECT 1 FROM checkpoints c WHERE c.id = e.entity_id AND c.project_id = $project AND c.failed = 0
        ))
        OR (e.kind = 'decision' AND EXISTS (
          SELECT 1 FROM decisions d WHERE d.id = e.entity_id AND d.project_id = $project
        ))
      )
    ORDER BY e.seq LIMIT 1`);
  const fixes: Row[] = [];
  const paired = new Set<string>();
  for (const candidate of arms.flat()) {
    const k = key(candidate.kind, candidate.id);
    if (paired.has(k)) continue;
    paired.add(k);
    const { kind, row } = candidate;
    if (!(kind === 'checkpoint' && row.failed === 1) &&
        !(kind === 'job' && (row.consult_verdict === 'chg' || row.consult_verdict === 'blk'))) continue;
    const fix = nextFix.get({ $project: projectId, $task: candidate.taskId, $kind: kind, $id: candidate.id });
    if (fix) fixes.push(fix);
  }
  arms.push(unique(fixes));

  const fused = new Map<string, { candidate: Candidate; score: number }>();
  for (const arm of arms) {
    arm.forEach((candidate, i) => {
      const k = key(candidate.kind, candidate.id);
      const entry = fused.get(k) ?? { candidate, score: 0 };
      entry.score += 1 / (61 + i);
      fused.set(k, entry);
    });
  }
  for (const entry of fused.values()) {
    const { kind, row, taskId } = entry.candidate;
    if (kind === 'decision') {
      entry.score *= row.active ? 1.35 : 0.35;
      if (taskId === null) entry.score *= 1.2;
      if (typeof row.confidence === 'number' && row.confidence >= 0.8) entry.score *= 1.15;
    } else if (kind === 'checkpoint') {
      entry.score *= 1.1;
      if (typeof row.confidence === 'number' && row.confidence >= 0.8) entry.score *= 1.15;
    } else if (kind === 'task' && row.status === 'cancelled') entry.score *= 0.4;
  }

  const lines: string[] = [];
  let used = 0;
  for (const { candidate } of [...fused.values()].sort((a, b) =>
    b.score - a.score || b.candidate.seq - a.candidate.seq ||
    (key(a.candidate.kind, a.candidate.id) < key(b.candidate.kind, b.candidate.id) ? -1 : 1))) {
    const line = renderEntity(candidate.kind, candidate.id);
    if (!line) continue;
    const size = line.length + (lines.length ? 1 : 0);
    if (used + size > budget) continue;
    lines.push(line);
    used += size;
  }
  return { lines, hits: lines.length };
}
