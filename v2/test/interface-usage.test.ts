import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { waitDisplayOptions } from '../src/air/wait-options.ts';
import { Store } from './fixtures/service.ts';
import { listedTools } from '../src/tools.ts';

const reader = { id: 'reader' } as Parameters<Store['op_air_sync']>[0];
const project = { id: 'project-one', name: 'Interface usage', root: null, archived: 0, next_action: '' };
const ownJob = 'j1', otherJob = 'j2';

function fixture(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  t.after(() => { db.close(); });
  db.exec(`
    CREATE TABLE events (
      seq INTEGER PRIMARY KEY, project_id TEXT, task_id TEXT, kind TEXT,
      action TEXT, entity_id TEXT, actor_id TEXT, air_line TEXT
    );
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY, seq INTEGER, project_id TEXT, created_by TEXT,
      options TEXT, route TEXT, status TEXT
    );
    CREATE TABLE actor_cursors (
      actor_id TEXT, project_id TEXT, last_seq INTEGER, updated_at TEXT,
      PRIMARY KEY (actor_id,project_id)
    );
    CREATE TABLE usage_windows (
      route TEXT, pool TEXT, window TEXT, remaining_percent REAL,
      resets_at TEXT, observed_at TEXT, source TEXT
    );
    CREATE TABLE job_outcomes (
      job_id TEXT, kind TEXT
    );
  `);
  const event = (kind: string, action: string, id: string, actor: string, line: string, projectId = project.id) =>
    db.prepare('INSERT INTO events(project_id,kind,action,entity_id,actor_id,air_line) VALUES(?,?,?,?,?,?)')
      .run(projectId, kind, action, id, actor, line);
  const maxSeq = (projectId = project.id) =>
    Number(db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE project_id=?').get(projectId)?.seq);
  const cursor = () => db.prepare('SELECT last_seq FROM actor_cursors WHERE actor_id=? AND project_id=?')
    .get(reader.id, project.id)?.last_seq;
  const startCursor = () => db.prepare('INSERT INTO actor_cursors VALUES(?,?,?,?)')
    .run(reader.id, project.id, 0, new Date().toISOString());
  const addJob = (id: string, owner: string, options: Record<string, unknown> = {}) =>
    db.prepare("INSERT INTO jobs VALUES(?,?,?,?,?,NULL,'completed')")
      .run(id, Number(id.slice(1)), project.id, owner, JSON.stringify(options));

  // Exercise the real feed, wait and scheduling logic without opening a live home or invoking adapters.
  const store = Object.assign(Object.create(Store.prototype), {
    db, maxSeq, seenRoutes: new Map(), project: () => project, heartbeat() {},
    handleOf: (kind: string, id: string) => kind === 'p' ? 'p1' : id,
    routeLine: () => 'R', inbox: () => [], actorFamily: () => null,
    airNode: () => {
      event('decision', 'decision_record', 'd1', reader.id, 'D d1');
      return { handle: 'd1' };
    },
    op_art_put: () => ({ artifact: { id: 'a6', project_id: project.id }, air: 'A a6' }),
    emit: (kind: string, action: string, id: string, actor: string) => event(kind, action, id, actor, `A ${id}`),
  }) as Store;
  const tx = (id: string) => store.op_air_tx(reader, { project_id: project.id, operation_id: id, packet: '@air1\n#0 dec "Own decision"' });
  const put = () => (store as any).apply(reader, 'art_put', { project_id: project.id });
  const ownEvents = () => {
    addJob(ownJob, reader.id, { ctx_artifact: 'a1', output_artifact: 'a2', diff_artifact: 'a3' });
    event('job', 'job_status', ownJob, 'agent-commons', 'J j1 status=running');
    event('artifact', 'job_context', 'a1', 'agent-commons', 'A a1');
    event('artifact', 'job_output', 'a2', 'agent-commons', 'A a2');
    event('artifact', 'job_diff', 'a3', 'agent-commons', 'A a3');
    event('job', 'job_status', ownJob, 'agent-commons', 'J j1 status=completed ctx=a1 out=a2 diff=a3');
  };
  return { db, store, event, maxSeq, cursor, startCursor, addJob, ownEvents, tx, put };
}

test('air_tx counts foreign work but advances across the caller’s system job events', t => {
  const f = fixture(t);
  f.startCursor();
  f.ownEvents();
  f.event('artifact', 'job_output', 'a9', 'agent-commons', 'A a9', 'another-project');
  assert.equal(f.tx('one').unseen, 0);
  const saved = f.maxSeq();
  assert.equal(f.cursor(), saved);

  f.addJob(otherJob, 'peer', { output_artifact: 'a4' });
  f.event('job', 'job_status', otherJob, 'agent-commons', 'J j2');
  f.event('artifact', 'job_output', 'a4', 'agent-commons', 'A a4');
  f.event('artifact', 'job_output', 'a5', 'agent-commons', 'A a5');
  f.event('decision', 'decision_record', 'd2', 'peer', 'D d2');
  assert.equal(f.tx('two').unseen, 4);
  assert.equal(f.cursor(), saved);
});

test('art_put advances an existing cursor only when no foreign changes would be skipped', t => {
  const f = fixture(t);
  f.put();
  assert.equal(f.cursor(), undefined);
  f.startCursor();
  f.ownEvents();
  f.put();
  const saved = f.maxSeq();
  assert.equal(f.cursor(), saved);
  f.event('artifact', 'art_put', 'a8', 'peer', 'A a8');
  f.put();
  assert.equal(f.cursor(), saved);
});

test('delta air_sync omits only the caller’s system job context and output artifacts', t => {
  const f = fixture(t);
  f.startCursor();
  f.ownEvents();
  f.addJob(otherJob, 'peer', { ctx_artifact: 'a4', output_artifact: 'a5' });
  f.event('artifact', 'job_context', 'a4', 'agent-commons', 'A a4');
  f.event('artifact', 'job_output', 'a5', 'agent-commons', 'A a5');
  f.event('artifact', 'job_output', 'a6', reader.id, 'A a6');
  const sync = f.store.op_air_sync(reader, { project_id: project.id });
  const lines = sync.air.split('\n');
  assert.deepEqual(lines.filter((line: string) => line.startsWith('A ')), ['A a3', 'A a4', 'A a5', 'A a6']);
  assert.deepEqual(lines.filter((line: string) => line.startsWith('J ')), ['J j1 status=completed ctx=a1 out=a2 diff=a3']);
  assert.equal(f.cursor(), f.maxSeq());
});

test('brief wait reports full output length and a bounded summary or preview', async t => {
  const f = fixture(t);
  f.addJob(ownJob, reader.id);
  f.db.prepare("INSERT INTO job_outcomes VALUES(?,'accepted')").run(ownJob);
  const output = 'x'.repeat(20_000);
  let air: { ok: boolean; summary: string } | undefined = { ok: true, summary: 's'.repeat(250) };
  const prompt = JSON.stringify('example res="not a result field"');
  Object.assign(f.store, {
    waitTarget: () => [ownJob], chainTail: (id: string) => id,
    jobRecord: () => ({ result: output.slice(0, 500), options: { output_artifact: 'a1', air } }),
    op_artifact_read: () => ({ content: output }),
    airItem: (handle: string, cap: number) => [`J ${handle} status=completed prompt=${prompt} res=${JSON.stringify(output.slice(0, cap))} out=a1`],
  });

  const full = await f.store.airWait(reader, { handles: ownJob });
  assert.ok(full.air.includes(`res="${output.slice(0, 16000)}"`));
  assert.doesNotMatch(full.air, / rchars=/);

  const summarized = await f.store.airWait(reader, { handles: ownJob, brief: true });
  assert.equal(summarized.air, `@air1 wait n=1 done=1\nJ j1 status=completed prompt=${prompt} out=a1 rchars=20000 sum="${'s'.repeat(200)}"`);

  air = undefined;
  for (const [maxChars, previewLength] of [[undefined, 240], [32, 32]] as const) {
    const brief = await f.store.airWait(reader, { handles: ownJob, brief: true, max_chars: maxChars });
    assert.ok(brief.air.endsWith(`out=a1 rchars=20000 res="${'x'.repeat(previewLength)}"`));
  }
  await assert.rejects(f.store.airWait(reader, { handles: ownJob, brief: 'true' }), { code: 'INVALID_INPUT' });
});

test('both wait commands can omit display options or send only the flags supplied', () => {
  assert.deepEqual(waitDisplayOptions(false), {});
  assert.deepEqual(waitDisplayOptions(true), { brief: true });
  assert.deepEqual(waitDisplayOptions(false, '35'), { max_chars: 35 });
  assert.deepEqual(waitDisplayOptions(true, '80'), { brief: true, max_chars: 80 });
  for (const bad of [null, '', '19', '200001', '20.5', 'oops'])
    assert.throws(() => waitDisplayOptions(false, bad), { code: 'INVALID_INPUT' });

  const tools = listedTools('air');
  assert.deepEqual(tools.find(tool => tool.name === 'air_wait')?.inputSchema.properties.brief, { type: 'boolean' });
  assert.ok(JSON.stringify({ tools }).length <= 3400);
});

function routing(t: TestContext, ids: string[]) {
  const { store, db } = fixture(t);
  Object.assign(store, {
    routeStatus: () => ids.map(id => ({
      id, short: id === 'openai-api' ? 'api' : id,
      state: 'verified', billing: id === 'openai-api' ? 'paid' : 'sub', family: id,
      queued: 0, running: 0, limit: 1,
    })),
  });
  const usage = (route: string, pool: string, window: string, percent: number, { stale = false, closed = false } = {}) => {
    const observed = new Date(Date.now() - (stale ? 7 * 60 * 60 * 1000 : 0)).toISOString();
    const resets = closed ? new Date(Date.now() + 60 * 60 * 1000).toISOString() : null;
    db.prepare('INSERT INTO usage_windows VALUES(?,?,?,?,?,?,?)')
      .run(route, pool, window, percent, resets, observed, closed ? 'test:closed' : 'test');
  };
  const pick = (input: Record<string, unknown> = {}) =>
    (store as any).pickRoute(reader, { prompt: 'Review the result', ...input }, 'advice', null, null);
  return { usage, pick };
}

test('auto routing uses each pool’s lowest fresh window and skips exhausted routes', t => {
  const f = routing(t, ['claude', 'codex']);
  f.usage('claude', 'first', '5h', 75);
  f.usage('claude', 'first', 'weekly', 0);
  f.usage('claude', 'second', '5h', 80, { closed: true });
  f.usage('codex', 'default', '5h', 0, { stale: true });
  assert.deepEqual(f.pick(), { route: 'codex', considered: ['codex'] });

  f.usage('codex', 'default', 'weekly', 0);
  assert.throws(() => f.pick(), /claude:quota codex:quota/);
});

test('auto routing takes the best independent pool and deprioritizes low quota before billing', t => {
  const f = routing(t, ['claude', 'codex', 'openai-api']);
  f.usage('claude', 'default', '5h', 15);
  f.usage('claude', 'default', 'weekly', 80);
  f.usage('codex', 'used', '5h', 0);
  assert.deepEqual(f.pick(), { route: 'claude', considered: ['claude'] });

  const paid = { cost: 'paid', max_cost_usd: '0.25', purpose: 'Cross-family review', deliverable: 'Review findings' };
  assert.equal(f.pick(paid).route, 'openai-api');
  assert.equal(f.pick({ cost: 'paid' }).route, 'claude');

  f.usage('codex', 'other', '5h', 16);
  assert.deepEqual(f.pick(paid), { route: 'codex', considered: ['codex', 'openai-api', 'claude'] });
});
