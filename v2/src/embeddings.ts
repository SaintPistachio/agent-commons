/**
 * Opt-in loopback hybrid semantic embeddings for project memory recall.
 * Disabled by default; never reads API keys or contacts non-loopback hosts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { fail } from './errors.ts';

export const DEFAULT_EMBEDDINGS_BASE_URL = 'http://127.0.0.1:11434/v1';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const MAX_EMBED_CHARS = 8000;

export interface EmbeddingsConfig {
  enabled: true;
  base_url: string;
  model: string;
  timeout_ms: number;
  query_timeout_ms: number;
  min_similarity: number;
}

export interface EmbeddingsStatus {
  enabled: boolean;
  provider_id?: string;
  base_url?: string;
  model?: string;
  indexed_vectors: number;
  indexed_entities: number;
  config_error?: string;
}

export interface SyncVectorsResult {
  indexed: number;
  skipped: number;
  pruned: number;
  errors: number;
  provider_id: string;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fail('EMBEDDINGS_CONFIG_INVALID', 400, 'timeout values must be finite numbers');
  }
  return Math.max(min, Math.min(max, Math.round(value)));
}

function clampSim(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fail('EMBEDDINGS_CONFIG_INVALID', 400, 'min_similarity must be a finite number');
  }
  return Math.max(0, Math.min(1, value));
}

export function providerId(cfg: Pick<EmbeddingsConfig, 'base_url' | 'model'>): string {
  return `${cfg.base_url.replace(/\/+$/, '')}|${cfg.model}`;
}

export function parseEmbeddingsConfig(raw: unknown): EmbeddingsConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('EMBEDDINGS_CONFIG_INVALID', 400, 'embeddings.json must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;
  if (obj.enabled !== true) return null;
  const rawBase = obj.base_url === undefined ? DEFAULT_EMBEDDINGS_BASE_URL : obj.base_url;
  if (typeof rawBase !== 'string' || !rawBase.trim()) {
    return fail('EMBEDDINGS_CONFIG_INVALID', 400, 'base_url must be a non-empty URL');
  }
  let parsed: URL;
  try {
    parsed = new URL(rawBase.trim());
  } catch {
    return fail('EMBEDDINGS_CONFIG_INVALID', 400, 'base_url is not a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return fail('EMBEDDINGS_CONFIG_INVALID', 400, 'base_url must use http or https');
  }
  if (parsed.username || parsed.password) {
    return fail('EMBEDDINGS_CONFIG_INVALID', 400, 'base_url must not contain credentials');
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
    return fail('EMBEDDINGS_CONFIG_INVALID', 400, 'embeddings base_url must use a loopback host (127.0.0.1, localhost, ::1)');
  }
  const rawModel = obj.model;
  if (typeof rawModel !== 'string' || !rawModel.trim()) {
    return fail('EMBEDDINGS_CONFIG_INVALID', 400, 'model must be a non-empty string');
  }
  return {
    enabled: true,
    base_url: rawBase.trim().replace(/\/+$/, ''),
    model: rawModel.trim(),
    timeout_ms: clampInt(obj.timeout_ms, 3000, 200, 30000),
    query_timeout_ms: clampInt(obj.query_timeout_ms, 1500, 200, 10000),
    min_similarity: clampSim(obj.min_similarity, 0.25),
  };
}

export function loadEmbeddingsConfig(home: string): EmbeddingsConfig | null {
  const file = path.join(home, 'embeddings.json');
  if (!fs.existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    fail('EMBEDDINGS_CONFIG_INVALID', 400, `${file} is not valid JSON`);
  }
  return parseEmbeddingsConfig(parsed);
}

export function encodeVector(values: readonly number[]): Uint8Array {
  if (!values.length) throw new Error('Embedding vector must not be empty');
  const f32 = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('Embedding vector contains non-finite value');
    f32[i] = v;
  }
  return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
}

export function decodeVector(blob: Uint8Array, dims: number): Float32Array | null {
  if (!(blob instanceof Uint8Array) || !Number.isInteger(dims) || dims <= 0) return null;
  if (blob.byteLength !== dims * 4) return null;
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer);
}

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  const denom = Math.sqrt(normA * normB);
  return denom > 0 && Number.isFinite(denom) ? dot / denom : 0;
}

export async function requestEmbedding(
  cfg: EmbeddingsConfig,
  input: string,
  timeoutMs = cfg.timeout_ms,
  fetchImpl: typeof fetch = fetch,
): Promise<Float32Array> {
  const endpoint = `${cfg.base_url.replace(/\/+$/, '')}/embeddings`;
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: cfg.model, input: input.slice(0, MAX_EMBED_CHARS) }),
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Embeddings endpoint returned HTTP ${response.status}`);
  const body = await response.json() as { data?: Array<{ embedding?: unknown }> };
  const raw = body?.data?.[0]?.embedding;
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('Invalid embedding response');
  const out = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('Embedding response contains non-finite number');
    out[i] = v;
  }
  return out;
}

export async function syncMemoryVectors(
  db: DatabaseSync,
  cfg: EmbeddingsConfig,
  options: { projectId?: string; limit?: number; fetchImpl?: typeof fetch } = {},
): Promise<SyncVectorsResult> {
  const provider = providerId(cfg);
  const { projectId, limit, fetchImpl = fetch } = options;
  const rows = (projectId
    ? db.prepare(`SELECT project_id, kind, entity_id, primary_text, secondary_text, refs_text
        FROM memory_fts WHERE project_id = ? ORDER BY kind, entity_id`).all(projectId)
    : db.prepare(`SELECT project_id, kind, entity_id, primary_text, secondary_text, refs_text
        FROM memory_fts ORDER BY project_id, kind, entity_id`).all()
  ) as Array<{
    project_id: string; kind: string; entity_id: string;
    primary_text: string; secondary_text: string; refs_text: string;
  }>;

  const existingStmt = db.prepare(
    'SELECT content_sha256, provider_id FROM memory_vectors WHERE project_id = ? AND kind = ? AND entity_id = ?',
  );
  const upsertStmt = db.prepare(`INSERT OR REPLACE INTO memory_vectors
    (project_id, kind, entity_id, content_sha256, provider_id, dims, vector, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

  let indexed = 0;
  let skipped = 0;
  let errors = 0;
  let attempts = 0;
  let consecutiveHttpErrors = 0;
  const activeKeys = new Set<string>();

  for (const row of rows) {
    activeKeys.add(`${row.project_id}\0${row.kind}\0${row.entity_id}`);
  }

  for (const row of rows) {
    if (limit !== undefined && attempts >= limit) break;
    const text = [row.primary_text, row.secondary_text, row.refs_text]
      .filter((s): s is string => typeof s === 'string' && s.trim() !== '')
      .join('\n')
      .trim();
    if (!text) {
      skipped++;
      continue;
    }
    const contentHash = createHash('sha256').update(text).digest('hex');
    const existing = existingStmt.get(row.project_id, row.kind, row.entity_id) as
      { content_sha256: string; provider_id: string } | undefined;
    if (existing && existing.content_sha256 === contentHash && existing.provider_id === provider) {
      skipped++;
      continue;
    }
    attempts++;
    try {
      const vec = await requestEmbedding(cfg, text, cfg.timeout_ms, fetchImpl);
      consecutiveHttpErrors = 0;
      const blob = new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
      // Skip upsert if the entity was deleted or rewritten while awaiting the local embedding request.
      const currentFts = db.prepare(
        'SELECT primary_text, secondary_text, refs_text FROM memory_fts WHERE project_id = ? AND kind = ? AND entity_id = ?',
      ).get(row.project_id, row.kind, row.entity_id) as
        { primary_text: string; secondary_text: string; refs_text: string } | undefined;
      if (!currentFts) continue;
      const currentText = [currentFts.primary_text, currentFts.secondary_text, currentFts.refs_text]
        .filter((s): s is string => typeof s === 'string' && s.trim() !== '')
        .join('\n')
        .trim();
      if (createHash('sha256').update(currentText).digest('hex') !== contentHash) continue;

      upsertStmt.run(
        row.project_id, row.kind, row.entity_id,
        contentHash, provider, vec.length, blob, new Date().toISOString(),
      );
      indexed++;
    } catch (error) {
      errors++;
      const msg = String((error as Error)?.message ?? error);
      // Bail early on connection/network failures or repeated HTTP errors instead of hammering a dead/failing local server.
      if (!msg.startsWith('Embeddings endpoint returned HTTP')) break;
      consecutiveHttpErrors++;
      if (consecutiveHttpErrors >= 3) break;
    }
  }

  // Prune orphans in JS against activeKeys instead of scanning UNINDEXED FTS5 columns per vector row.
  const storedRows = (projectId
    ? db.prepare('SELECT project_id, kind, entity_id FROM memory_vectors WHERE project_id = ?').all(projectId)
    : db.prepare('SELECT project_id, kind, entity_id FROM memory_vectors').all()
  ) as Array<{ project_id: string; kind: string; entity_id: string }>;
  const deleteStmt = db.prepare('DELETE FROM memory_vectors WHERE project_id = ? AND kind = ? AND entity_id = ?');
  let pruned = 0;
  for (const v of storedRows) {
    if (!activeKeys.has(`${v.project_id}\0${v.kind}\0${v.entity_id}`)) {
      pruned += Number(deleteStmt.run(v.project_id, v.kind, v.entity_id).changes ?? 0);
    }
  }

  return { indexed, skipped, pruned, errors, provider_id: provider };
}

export function embeddingsStatus(db: DatabaseSync, home: string): EmbeddingsStatus {
  const indexedEntities = Number((db.prepare('SELECT count(*) AS n FROM memory_fts').get() as { n: number }).n);
  const indexedVectors = db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'memory_vectors' AND type = 'table'").get()
    ? Number((db.prepare('SELECT count(*) AS n FROM memory_vectors').get() as { n: number }).n)
    : 0;
  try {
    const cfg = loadEmbeddingsConfig(home);
    if (!cfg) {
      return { enabled: false, indexed_vectors: indexedVectors, indexed_entities: indexedEntities };
    }
    return {
      enabled: true,
      provider_id: providerId(cfg),
      base_url: cfg.base_url,
      model: cfg.model,
      indexed_vectors: indexedVectors,
      indexed_entities: indexedEntities,
    };
  } catch (error) {
    return {
      enabled: false,
      indexed_vectors: indexedVectors,
      indexed_entities: indexedEntities,
      config_error: (error as Error).message,
    };
  }
}

export class MemoryEmbedder {
  private readonly db: DatabaseSync;
  private readonly home: string;
  private readonly intervalMs: number;
  private timer?: NodeJS.Timeout;
  private syncing?: Promise<SyncVectorsResult | null>;
  private stopped = false;

  constructor(db: DatabaseSync, home: string, intervalMs = 60_000) {
    this.db = db;
    this.home = home;
    this.intervalMs = intervalMs;
  }

  start(): void {
    if (this.stopped || this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  tick(): Promise<SyncVectorsResult | null> {
    if (this.stopped) return Promise.resolve(null);
    if (this.syncing) return this.syncing;
    const run = (async () => {
      try {
        const cfg = loadEmbeddingsConfig(this.home);
        if (!cfg || this.stopped) return null;
        return await syncMemoryVectors(this.db, cfg, { limit: 32 });
      } catch {
        return null;
      } finally {
        this.syncing = undefined;
      }
    })();
    this.syncing = run;
    return run;
  }
}
