import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildContext } from '../src/context.ts';
import {
  formatGraphContext,
  graphIdentity,
  graphStatus,
  queryGraph,
  refreshGraph,
  resolveGraphDir,
  resolveGraphifyExecutable,
} from '../src/graph.ts';
import { Store, type Actor } from './fixtures/service.ts';

function writeValidGraph(
  graphDir: string,
  root: string,
  nodes: Array<{ id: string; label: string; source_file: string; source_location?: number }>,
  links: Array<{ source: string; target: string; relation: string; source_file: string; source_location?: number; confidence?: string }>,
  manifestFiles: string[],
) {
  mkdirSync(graphDir, { recursive: true });
  const graphPath = join(graphDir, 'graph.json');
  const manifestPath = join(graphDir, 'manifest.json');
  const receiptPath = join(graphDir, '.graphify_build_state.json');

  writeFileSync(graphPath, JSON.stringify({ nodes, links }, null, 2));
  const manifest: Record<string, { mtime: number }> = {};
  for (const rel of manifestFiles) {
    const file = join(root, rel);
    manifest[rel] = { mtime: statSync(file).mtimeMs / 1000 };
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const stat = statSync(graphPath, { bigint: true });
  assert.ok(stat.mtimeNs > BigInt(Number.MAX_SAFE_INTEGER), 'nanosecond mtime exercises 64-bit precision');
  // Write raw JSON with exact 64-bit integer mtime_ns (as Graphify produces in Python).
  writeFileSync(
    receiptPath,
    `{"graph_size": ${stat.size.toString()}, "graph_mtime_ns": ${stat.mtimeNs.toString()}}`,
  );
}

test('graphIdentity validates 64-bit BigInt nanosecond mtime and queryGraph filters stale edges', t => {
  const base = mkdtempSync(join(tmpdir(), 'ac-graph-'));
  const home = join(base, 'home');
  const root = join(base, 'repo');
  mkdirSync(home);
  mkdirSync(join(root, 'src'), { recursive: true });
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const aFile = join(root, 'src', 'alpha.ts');
  const bFile = join(root, 'src', 'beta.ts');
  writeFileSync(aFile, 'export function buildContext() { return helper(); }\n');
  writeFileSync(bFile, 'export function helper() { return 1; }\n');

  const graphDir = resolveGraphDir(home, root);
  writeValidGraph(
    graphDir,
    root,
    [
      { id: 'n1', label: 'buildContext()', source_file: 'src/alpha.ts', source_location: 1 },
      { id: 'n2', label: 'helper()', source_file: 'src/beta.ts', source_location: 1 },
    ],
    [
      { source: 'n1', target: 'n2', relation: 'calls', source_file: 'src/alpha.ts', source_location: 1, confidence: 'EXTRACTED' },
    ],
    ['src/alpha.ts', 'src/beta.ts'],
  );

  const id = graphIdentity(graphDir);
  assert.ok(id.graphMtimeNs > BigInt(Number.MAX_SAFE_INTEGER));
  assert.equal(graphStatus(root, graphDir).status, 'available');

  const ok = queryGraph(root, graphDir, 'buildContext', [home]);
  assert.equal(ok.status, 'available');
  assert.equal(ok.relationships.length, 1);
  assert.equal(ok.relationships[0].relation, 'calls');
  assert.match(formatGraphContext(ok, 'buildContext'), /buildContext\(\) \(src\/alpha\.ts:1\) --\[calls\]--> helper\(\)/);

  // Tampering with receipt (even off by 1 nanosecond beyond Number precision) invalidates the graph
  const receiptFile = join(graphDir, '.graphify_build_state.json');
  const originalReceipt = readFileSync(receiptFile, 'utf8');
  writeFileSync(receiptFile, `{"graph_size": ${id.graphSize.toString()}, "graph_mtime_ns": ${(id.graphMtimeNs + 1n).toString()}}`);
  assert.equal(graphStatus(root, graphDir).status, 'invalid');
  writeFileSync(receiptFile, originalReceipt);

  // Modifying bFile makes its manifest mtime stale -> edge dropped & status becomes partially-stale
  const manifest = JSON.parse(readFileSync(join(graphDir, 'manifest.json'), 'utf8'));
  manifest['src/beta.ts'].mtime -= 5;
  writeFileSync(join(graphDir, 'manifest.json'), JSON.stringify(manifest));
  const stale = queryGraph(root, graphDir, 'buildContext', [home]);
  assert.equal(stale.status, 'partially-stale');
  assert.equal(stale.relationships.length, 0);
});

test('queryGraph and buildContext enforce path safety and secret filtering', t => {
  const base = mkdtempSync(join(tmpdir(), 'ac-graph-sec-'));
  const home = join(base, 'home');
  const root = join(base, 'repo');
  const outside = join(base, 'outside.ts');
  mkdirSync(home);
  mkdirSync(join(root, 'src'), { recursive: true });
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const safeFile = join(root, 'src', 'main.ts');
  const envFile = join(root, '.env');
  const secretFile = join(root, 'src', 'secret.ts');
  const deniedDir = join(root, 'denied');
  mkdirSync(deniedDir);
  const deniedFile = join(deniedDir, 'hidden.ts');
  writeFileSync(safeFile, 'export const ok = 1;\n');
  writeFileSync(envFile, 'SECRET=1\n');
  writeFileSync(secretFile, 'export const s = 1;\n');
  writeFileSync(deniedFile, 'export const d = 1;\n');
  writeFileSync(outside, 'export const out = 1;\n');

  const graphDir = resolveGraphDir(home, root);
  writeValidGraph(
    graphDir,
    root,
    [
      { id: 'safe', label: 'mainEntry', source_file: 'src/main.ts' },
      { id: 'trav', label: 'mainEntry', source_file: '../outside.ts' },
      { id: 'abs', label: 'mainEntry', source_file: outside },
      { id: 'env', label: 'mainEntry', source_file: '.env' },
      { id: 'sec', label: 'mainEntry', source_file: 'src/secret.ts' },
      { id: 'den', label: 'mainEntry', source_file: 'denied/hidden.ts' },
      { id: 'leak', label: 'sk-ant-1234567890123456789012345', source_file: 'src/main.ts' },
    ],
    [
      { source: 'safe', target: 'trav', relation: 'calls', source_file: 'src/main.ts' },
      { source: 'safe', target: 'abs', relation: 'calls', source_file: 'src/main.ts' },
      { source: 'safe', target: 'env', relation: 'calls', source_file: 'src/main.ts' },
      { source: 'safe', target: 'sec', relation: 'calls', source_file: 'src/main.ts' },
      { source: 'safe', target: 'den', relation: 'calls', source_file: 'src/main.ts' },
    ],
    ['src/main.ts', '.env', 'src/secret.ts', 'denied/hidden.ts'],
  );

  // Add outside entry manually to manifest to ensure path rules still block it
  const manifest = JSON.parse(readFileSync(join(graphDir, 'manifest.json'), 'utf8'));
  manifest['../outside.ts'] = { mtime: statSync(outside).mtimeMs / 1000 };
  manifest[outside] = { mtime: statSync(outside).mtimeMs / 1000 };
  writeFileSync(join(graphDir, 'manifest.json'), JSON.stringify(manifest));

  const res = queryGraph(root, graphDir, 'mainEntry', [home, deniedDir]);
  assert.equal(res.relationships.length, 0);

  // Symlinked file inside root is rejected if symlink creation is permitted
  const linkFile = join(root, 'src', 'linked.ts');
  let linked = false;
  try {
    symlinkSync(outside, linkFile);
    linked = true;
  } catch { /* Developer Mode not active on Windows */ }
  if (linked) {
    writeValidGraph(
      graphDir,
      root,
      [
        { id: 'safe', label: 'mainEntry', source_file: 'src/main.ts' },
        { id: 'lnk', label: 'linkedFn', source_file: 'src/linked.ts' },
      ],
      [{ source: 'safe', target: 'lnk', relation: 'calls', source_file: 'src/main.ts' }],
      ['src/main.ts', 'src/linked.ts'],
    );
    assert.equal(queryGraph(root, graphDir, 'mainEntry', [home]).relationships.length, 0);
  }

  // CTX_SECRET catches credential-like tokens inside symbol labels
  writeValidGraph(
    graphDir,
    root,
    [
      { id: 'safe', label: 'leakToken', source_file: 'src/main.ts' },
      { id: 'leak', label: 'sk-ant-1234567890123456789012345', source_file: 'src/main.ts' },
    ],
    [{ source: 'safe', target: 'leak', relation: 'calls', source_file: 'src/main.ts' }],
    ['src/main.ts'],
  );
  assert.throws(
    () => buildContext(['graph:leakToken'], {
      root,
      artifact: () => undefined,
      task: () => undefined,
      graph: q => formatGraphContext(queryGraph(root, graphDir, q, [home]), q),
    }),
    { code: 'CTX_SECRET' },
  );
});

test('Store wires graph: in air_get, job_submit, need to=ctx, and refreshGraph repairs corrupt dirs', t => {
  const base = mkdtempSync(join(tmpdir(), 'ac-graph-store-'));
  const home = join(base, 'home');
  const root = join(base, 'repo');
  mkdirSync(home);
  mkdirSync(join(root, 'src'), { recursive: true });

  writeFileSync(join(root, 'src', 'router.ts'), 'export function pickRoute() { return allowanceRank(); }\n');
  writeFileSync(join(root, 'src', 'allowance.ts'), 'export function allowanceRank() { return 0; }\n');

  const graphDir = resolveGraphDir(home, root);
  writeValidGraph(
    graphDir,
    root,
    [
      { id: 'r1', label: 'pickRoute()', source_file: 'src/router.ts', source_location: 1 },
      { id: 'a1', label: 'allowanceRank()', source_file: 'src/allowance.ts', source_location: 1 },
    ],
    [{ source: 'r1', target: 'a1', relation: 'calls', source_file: 'src/router.ts', source_location: 1, confidence: 'EXTRACTED' }],
    ['src/router.ts', 'src/allowance.ts'],
  );

  const store = new Store(home);
  t.after(() => {
    try { store.close(); } catch {}
    rmSync(base, { recursive: true, force: true });
  });
  const actor: Actor = { id: 'op', name: 'Operator', role: 'operator' };
  const project = store.call(actor, 'project_create', { name: 'GraphProj', root, operation_id: randomUUID() }).project;
  const task = store.call(actor, 'task_create', { project_id: project.id, title: 'Inspect routing', operation_id: randomUUID() }).task;
  const pHandle = store.handleOf('p', project.id);

  // air_get graph:<symbol>
  const airGot = store.op_air_get(actor, { handles: `${pHandle}:graph:pickRoute` }).air;
  assert.match(airGot, /@air1 graph p=p1 q=pickRoute status=available edges=1/);
  assert.match(airGot, /allowanceRank\(\)/);

  // job_submit ctx=graph:<symbol>
  const job = store.op_job_submit(actor, {
    project_id: project.id,
    task_id: task.id,
    route: 'openai-api',
    mode: 'advice',
    protocol: 'air',
    prompt: 'Review pickRoute',
    context_refs: ['graph:pickRoute'],
    max_cost_usd: 0.25,
    purpose: 'test',
    deliverable: 'review',
    operation_id: randomUUID(),
  }).job;
  const opts = JSON.parse(String((store.db.prepare('SELECT options FROM jobs WHERE id=?').get(job.id) as any).options));
  const art = store.db.prepare('SELECT sha256 FROM artifacts WHERE id=?').get(opts.ctx_artifact) as { sha256: string };
  assert.match(readFileSync(join(home, 'artifacts', art.sha256), 'utf8'), /pickRoute\(\).*allowanceRank\(\)/);

  // need to=ctx with graph:<symbol>
  const job2 = store.op_job_submit(actor, {
    project_id: project.id,
    task_id: task.id,
    route: 'openai-api',
    mode: 'advice',
    protocol: 'air',
    prompt: 'Need graph',
    max_cost_usd: 0.25,
    purpose: 'test',
    deliverable: 'review',
    operation_id: randomUUID(),
  }).job;
  const opts2 = JSON.parse(String((store.db.prepare('SELECT options FROM jobs WHERE id=?').get(job2.id) as any).options));
  store.db.prepare("UPDATE jobs SET status='completed', options=? WHERE id=?")
    .run(JSON.stringify({ ...opts2, air: { ok: true, need: { to: 'ctx', ctx: ['graph:pickRoute'] } } }), job2.id);
  (store as unknown as { yieldStep(id: string): void }).yieldStep(job2.id);
  const updated = JSON.parse(String((store.db.prepare('SELECT options FROM jobs WHERE id=?').get(job2.id) as any).options));
  assert.ok(updated.need_ctx_artifact);
  const art2 = store.db.prepare('SELECT sha256 FROM artifacts WHERE id=?').get(updated.need_ctx_artifact) as { sha256: string };
  assert.match(readFileSync(join(home, 'artifacts', art2.sha256), 'utf8'), /@ctx graph:pickRoute/);

  // Corrupt existing graph.json -> refreshGraph builds in staged dir and swaps atomically
  writeFileSync(join(graphDir, 'graph.json'), '{broken json');
  assert.equal(graphStatus(root, graphDir).status, 'invalid');
  const refreshed = refreshGraph(root, graphDir, {
    spawnImpl: ((_cmd: string, _args: readonly string[], opts: { env?: NodeJS.ProcessEnv }) => {
      const outDir = opts.env!.GRAPHIFY_OUT!;
      writeValidGraph(
        outDir,
        root,
        [{ id: 'r1', label: 'pickRoute()', source_file: 'src/router.ts' }],
        [],
        ['src/router.ts'],
      );
      return { status: 0, stdout: 'ok', stderr: '', pid: 1, output: [], signal: null };
    }) as any,
  });
  assert.equal(refreshed.status, 'available');
  assert.equal(refreshed.nodes, 1);

  // Security regressions from review:
  // 1. graphs.json must not map to projectRoot or home
  writeFileSync(join(home, 'graphs.json'), JSON.stringify({ projects: { [root]: join(root, 'nested') } }));
  assert.throws(() => resolveGraphDir(home, root), { code: 'GRAPHS_CONFIG_INVALID' });
  writeFileSync(join(home, 'graphs.json'), JSON.stringify({ projects: { [root]: home } }));
  assert.throws(() => resolveGraphDir(home, root), { code: 'GRAPHS_CONFIG_INVALID' });
  rmSync(join(home, 'graphs.json'));

  // 2. Corrupt-dir repair refuses to delete a directory containing unrelated files
  const nonGraphDir = join(base, 'shared-dir');
  mkdirSync(nonGraphDir);
  writeFileSync(join(nonGraphDir, 'graph.json'), '{broken');
  writeFileSync(join(nonGraphDir, 'manifest.json'), '{}');
  writeFileSync(join(nonGraphDir, '.graphify_build_state.json'), '{}');
  writeFileSync(join(nonGraphDir, 'keep-me.txt'), 'important');
  assert.throws(
    () => refreshGraph(root, nonGraphDir, {
      spawnImpl: (() => ({ status: 0, stdout: '', stderr: '', pid: 1, output: [], signal: null })) as any,
    }),
    { code: 'GRAPH_REPAIR_REFUSED' },
  );
  assert.equal(readFileSync(join(nonGraphDir, 'keep-me.txt'), 'utf8'), 'important');

  // 3. Dead-PID lock file is reclaimed cleanly
  const lockPath = join(base, 'home', 'graphs', `${graphDir.split(/[\\/]/).pop()}.lock`);
  writeFileSync(lockPath, JSON.stringify({ pid: 99999999, started_at: Date.now() }));
  const afterStaleLock = refreshGraph(root, graphDir, {
    spawnImpl: ((_cmd: string, _args: readonly string[], opts: { env?: NodeJS.ProcessEnv }) => {
      assert.equal(opts.env?.OPENAI_API_KEY, undefined);
      return { status: 0, stdout: 'ok', stderr: '', pid: 1, output: [], signal: null };
    }) as any,
  });
  assert.equal(afterStaleLock.status, 'available');

  // 4. resolveGraphifyExecutable skips repo-planted graphify binary
  const planted = join(root, process.platform === 'win32' ? 'graphify.exe' : 'graphify');
  writeFileSync(planted, 'fake');
  const prevPath = process.env.PATH;
  const prevBin = process.env.GRAPHIFY_BIN;
  delete process.env.GRAPHIFY_BIN;
  process.env.PATH = root;
  try {
    assert.throws(() => resolveGraphifyExecutable(root), { code: 'GRAPHIFY_NOT_FOUND' });
  } finally {
    process.env.PATH = prevPath;
    if (prevBin !== undefined) process.env.GRAPHIFY_BIN = prevBin;
  }
});
