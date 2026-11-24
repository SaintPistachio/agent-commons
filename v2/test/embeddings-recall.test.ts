import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  cosineSimilarity,
  decodeVector,
  embeddingsStatus,
  encodeVector,
  loadEmbeddingsConfig,
  parseEmbeddingsConfig,
  providerId,
  syncMemoryVectors,
} from '../src/embeddings.ts';
import { recallProjectMemory } from '../src/recall.ts';
import { migrate, SCHEMA_VERSION } from '../src/schema.ts';
import { startServer } from './fixtures/service.ts';
import { Store, type Actor } from './fixtures/service.ts';

function vectorForText(text: string): number[] {
  const lower = text.toLowerCase();
  if (lower.includes('database') || lower.includes('sqlite') || lower.includes('storage') || lower.includes('wal')) {
    return [0.95, 0.1, 0.0, 0.0];
  }
  if (lower.includes('authentication') || lower.includes('login') || lower.includes('oauth') || lower.includes('token')) {
    return [0.0, 0.95, 0.1, 0.0];
  }
  if (lower.includes('rendering') || lower.includes('canvas') || lower.includes('shader')) {
    return [0.0, 0.0, 0.95, 0.1];
  }
  return [0.1, 0.1, 0.1, 0.9];
}

async function startMockEmbeddingsServer(t: TestContext, failMode: { fail?: boolean; redirect?: boolean } = {}) {
  let requests = 0;
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/embeddings') {
      res.writeHead(404).end();
      return;
    }
    requests++;
    if (failMode.redirect) {
      res.writeHead(302, { location: 'https://example.com/steal' }).end();
      return;
    }
    if (failMode.fail) {
      res.writeHead(503).end(JSON.stringify({ error: 'unavailable' }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { input: string };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ embedding: vectorForText(body.input) }] }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  t.after(() => new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  }));
  const port = (server.address() as { port: number }).port;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, getRequests: () => requests };
}

test('schema 25 upgrades cleanly from v23 and v17', t => {
  const home = mkdtempSync(join(tmpdir(), 'ac-emb-schema-'));
  const store = new Store(home);
  t.after(() => {
    try { store.close(); } catch {}
    rmSync(home, { recursive: true, force: true });
  });
  assert.equal(Number((store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version), SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, 25);

  store.db.exec('DROP TABLE memory_vectors; ALTER TABLE projects DROP COLUMN approved_root; ALTER TABLE projects DROP COLUMN approved_git_dir; PRAGMA user_version = 23;');
  migrate(store.db);
  assert.equal(Number((store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version), SCHEMA_VERSION);
  assert.ok(store.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_vectors' AND type='table'").get());

  store.db.exec('DROP TABLE memory_vectors; DROP TABLE entity_refs; DROP TABLE memory_fts; DROP TABLE job_outcomes; DROP TABLE usage_history; ALTER TABLE projects DROP COLUMN approved_root; ALTER TABLE projects DROP COLUMN approved_git_dir; PRAGMA user_version = 17;');
  migrate(store.db);
  assert.equal(Number((store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version), SCHEMA_VERSION);
  assert.ok(store.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_vectors' AND type='table'").get());
  assert.ok(encodeVector([1, 2, 3]).byteLength === 12);
  assert.deepEqual([...decodeVector(encodeVector([0.5, -1]), 2)!], [0.5, -1]);
  assert.equal(decodeVector(encodeVector([1, 2]), 3), null);
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
});

test('parseEmbeddingsConfig enforces loopback-only URLs and no credentials', t => {
  const home = mkdtempSync(join(tmpdir(), 'ac-emb-cfg-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));

  assert.equal(loadEmbeddingsConfig(home), null);
  writeFileSync(join(home, 'embeddings.json'), JSON.stringify({ enabled: false, model: 'nomic-embed-text' }));
  assert.equal(loadEmbeddingsConfig(home), null);

  for (const url of ['http://127.0.0.1:11434/v1', 'http://localhost:11434/v1', 'http://[::1]:11434/v1']) {
    const cfg = parseEmbeddingsConfig({ enabled: true, base_url: url, model: 'nomic-embed-text' });
    assert.ok(cfg);
    assert.equal(cfg.model, 'nomic-embed-text');
  }

  for (const bad of [
    { enabled: true, base_url: 'https://api.openai.com/v1', model: 'text-embedding-3-small' },
    { enabled: true, base_url: 'http://user:pass@127.0.0.1:11434/v1', model: 'nomic-embed-text' },
    { enabled: true, base_url: 'ftp://127.0.0.1:11434/v1', model: 'nomic-embed-text' },
    { enabled: true, base_url: 'http://127.0.0.1:11434/v1', model: '   ' },
  ]) {
    assert.throws(() => parseEmbeddingsConfig(bad), { code: 'EMBEDDINGS_CONFIG_INVALID' });
  }
});

test('syncMemoryVectors and 4th RRF semantic arm retrieve non-lexical hits and pair failure fixes', async t => {
  const base = mkdtempSync(join(tmpdir(), 'ac-emb-sync-'));
  const home = join(base, 'data');
  const root = join(base, 'proj');
  mkdirSync(home);
  mkdirSync(root);

  const mock = await startMockEmbeddingsServer(t);
  writeFileSync(join(home, 'embeddings.json'), JSON.stringify({
    enabled: true,
    base_url: mock.baseUrl,
    model: 'mock-embed-v1',
    min_similarity: 0.7,
  }));

  const store = new Store(home);
  t.after(() => {
    try { store.close(); } catch {}
    rmSync(base, { recursive: true, force: true });
  });
  const actor: Actor = { id: 'op', name: 'Operator', role: 'operator' };
  const project = store.call(actor, 'project_create', { name: 'Embed', root, operation_id: randomUUID() }).project;
  const task = store.call(actor, 'task_create', { project_id: project.id, title: 'Persistence hardening', operation_id: randomUUID() }).task;

  const d1 = store.call(actor, 'decision_record', {
    project_id: project.id,
    task_id: task.id,
    summary: 'Enable SQLite WAL journaling for concurrent reads',
    operation_id: randomUUID(),
  }).decision.id;
  // Semantically matches "authentication" without sharing lexical tokens with "login flow"
  store.call(actor, 'project_checkpoint', {
    project_id: project.id,
    task_id: task.id,
    summary: 'OAuth token refresh failed under load',
    failed: true,
    operation_id: randomUUID(),
  });
  store.call(actor, 'decision_record', {
    project_id: project.id,
    task_id: task.id,
    summary: 'Add mutex around session rotation',
    operation_id: randomUUID(),
  });

  const cfg = loadEmbeddingsConfig(home)!;
  const first = await syncMemoryVectors(store.db, cfg);
  assert.equal(first.errors, 0);
  assert.ok(first.indexed >= 4);
  assert.equal(first.pruned, 0);
  const requestsAfterFirst = mock.getRequests();

  // Second sync skips unchanged rows
  const second = await syncMemoryVectors(store.db, cfg);
  assert.equal(second.indexed, 0);
  assert.equal(mock.getRequests(), requestsAfterFirst);

  const status = embeddingsStatus(store.db, home);
  assert.equal(status.enabled, true);
  assert.equal(status.indexed_vectors, first.indexed);

  // Semantic recall with query "database storage" (zero lexical overlap with "SQLite WAL journaling")
  const storageRecall = recallProjectMemory(store.db, {
    projectId: project.id,
    query: 'database storage',
    maxChars: 4000,
    semantic: {
      providerId: providerId(cfg),
      queryVector: new Float32Array(vectorForText('database storage')),
      minSimilarity: cfg.min_similarity,
    },
    renderEntity: (kind, id) => `${kind}:${id}`,
  });
  assert.ok(storageRecall.lines.includes(`decision:${d1}`));

  // Semantic recall on "login" matches failed checkpoint ("OAuth token refresh failed") and pairs with fix ("Add mutex...")
  const authRecall = recallProjectMemory(store.db, {
    projectId: project.id,
    query: 'login',
    maxChars: 4000,
    semantic: {
      providerId: providerId(cfg),
      queryVector: new Float32Array(vectorForText('login')),
      minSimilarity: cfg.min_similarity,
    },
    renderEntity: (kind, id) => {
      if (kind === 'decision') {
        const r = store.db.prepare('SELECT summary FROM decisions WHERE id=?').get(id) as { summary: string };
        return `D ${r.summary}`;
      }
      if (kind === 'checkpoint') {
        const r = store.db.prepare('SELECT summary FROM checkpoints WHERE id=?').get(id) as { summary: string };
        return `C ${r.summary}`;
      }
      return `${kind}:${id}`;
    },
  });
  assert.ok(authRecall.lines.some(l => l.includes('OAuth token refresh failed')));
  assert.ok(authRecall.lines.some(l => l.includes('Add mutex around session rotation')));

  // Pruning orphaned rows when entity is deleted from memory_fts
  store.db.prepare('DELETE FROM memory_fts WHERE entity_id = ?').run(d1);
  const third = await syncMemoryVectors(store.db, cfg);
  assert.equal(third.pruned, 1);
});

test('server integrates semantic recall for air_get and job_submit and falls back on endpoint failure', async t => {
  const base = mkdtempSync(join(tmpdir(), 'ac-emb-srv-'));
  const home = join(base, 'data');
  const root = join(base, 'proj');
  mkdirSync(home);
  mkdirSync(root);

  const failMode: { fail: boolean; redirect?: boolean } = { fail: false };
  const mock = await startMockEmbeddingsServer(t, failMode);
  writeFileSync(join(home, 'embeddings.json'), JSON.stringify({
    enabled: true,
    base_url: mock.baseUrl,
    model: 'mock-embed-v1',
    min_similarity: 0.7,
  }));

  const running = await startServer(home, 0, false);
  t.after(async () => {
    try { await running.close(); } catch {}
    rmSync(base, { recursive: true, force: true });
  });
  const { actor, token } = running.store.createActor('Client', 'operator');
  const project = running.store.call(actor, 'project_create', { name: 'Srv', root, operation_id: randomUUID() }).project;
  running.store.call(actor, 'decision_record', {
    project_id: project.id,
    summary: 'Use shader precompilation for canvas',
    operation_id: randomUUID(),
  });

  const cfg = loadEmbeddingsConfig(home)!;
  await syncMemoryVectors(running.store.db, cfg);

  const callApi = async (method: string, input: Record<string, unknown>) => {
    const res = await fetch(`${running.url}/api/v1/call`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ method, input }),
    });
    assert.equal(res.status, 200);
    return (await res.json() as { result: Record<string, any> }).result;
  };

  // Query "rendering" has zero lexical overlap with "shader precompilation for canvas"
  const got = await callApi('air_get', { handles: '?rendering' });
  assert.match(got.air, /shader precompilation/);

  const submitted = await callApi('job_submit', {
    project_id: project.id,
    route: 'openai-api',
    mode: 'advice',
    protocol: 'air',
    prompt: 'Check graphics pipeline',
    context_refs: ['recall:rendering'],
    max_cost_usd: 0.25,
    purpose: 'test',
    deliverable: 'report',
    operation_id: randomUUID(),
  });
  const opts = JSON.parse(String((running.store.db.prepare('SELECT options FROM jobs WHERE id=?').get(submitted.job.id) as any).options));
  const art = running.store.db.prepare('SELECT sha256 FROM artifacts WHERE id=?').get(opts.ctx_artifact) as { sha256: string };
  const ctxBody = await import('node:fs').then(fs => fs.readFileSync(join(home, 'artifacts', art.sha256), 'utf8'));
  assert.match(ctxBody, /shader precompilation/);

  // Endpoint failure degrades gracefully to 3-arm lexical recall
  failMode.fail = true;
  const fallback = await callApi('air_get', { handles: '?precompilation' });
  assert.match(fallback.air, /shader precompilation/);

  // 3xx redirect off loopback is refused and never followed
  failMode.fail = false;
  failMode.redirect = true;
  running.store.call(actor, 'decision_record', {
    project_id: project.id,
    summary: 'Never follow redirects off loopback',
    operation_id: randomUUID(),
  });
  const redirectSync = await syncMemoryVectors(running.store.db, cfg, { limit: 2 });
  assert.equal(redirectSync.errors, 1);
  assert.equal(redirectSync.indexed, 0);
});
