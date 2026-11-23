import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { buildContext } from '../src/context.ts';
import { backfillMemoryIndex } from '../src/recall.ts';
import { migrate, SCHEMA_VERSION } from '../src/schema.ts';
import { Store, type Actor, type Json } from '../src/store.ts';

type Internals = {
  db: DatabaseSync;
  emit(kind: string, action: string, id: string, actorId: string): void;
  airSnapshot(actor: Actor, project: Json, task: string | null): { lines: string[] };
  taskContext(projectId: string, ref: string): string | undefined;
  handleOf(kind: string, id: string): string;
  yieldStep(id: string): void;
};

function fixture(t: TestContext) {
  const base = mkdtempSync(join(tmpdir(), 'ac-m3c-'));
  const home = join(base, 'data'), root = join(base, 'project');
  mkdirSync(home);
  mkdirSync(root);
  const store = new Store(home);
  const internals = store as unknown as Internals;
  const db = internals.db;
  t.after(() => {
    try { store.close(); } catch {}
    rmSync(base, { recursive: true, force: true });
  });
  const actor: Actor = { id: 'm3c-test', name: 'Memory tests', role: 'operator' };
  store.op_air_get(actor, { handles: 'p1' });
  const stamp = new Date().toISOString();
  const project = { id: randomUUID(), root, name: 'Memory', objective: 'Verify project recall' };
  const taskId = randomUUID();

  function seed(table: string, values: Record<string, SQLInputValue>) {
    const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
    const fields = Object.entries({ created_at: stamp, updated_at: stamp, actor_id: actor.id,
      created_by: actor.id, ...values }).filter(([key]) => columns.has(key));
    db.prepare(`INSERT INTO ${table} (${fields.map(([key]) => key).join(',')})
      VALUES (${fields.map(() => '?').join(',')})`).run(...fields.map(([, value]) => value));
  }

  seed('projects', project);
  internals.emit('project', 'project_create', project.id, actor.id);
  seed('tasks', {
    id: taskId, project_id: project.id, seq: 1, title: 'Memory task',
    status: 'open', objective: 'Check bounded recall', acceptance: '[]', version: 1,
  });
  internals.emit('task', 'task_create', taskId, actor.id);

  let decisionSeq = 0;
  function decision(summary: string, task: string | null, supersedes: string | null = null, evidence: string[] = []) {
    const id = randomUUID();
    seed('decisions', {
      id, seq: ++decisionSeq, project_id: project.id, task_id: task, summary, rationale: '',
      supersedes, evidence: JSON.stringify(evidence), confidence: 0.9,
    });
    internals.emit('decision', 'decision_record', id, actor.id);
    return id;
  }
  let checkpointSeq = 99;
  function checkpoint(summary = 'Probe failed', failed = 1, artifacts: string[] = []) {
    const id = randomUUID();
    seed('checkpoints', {
      id, seq: ++checkpointSeq, project_id: project.id, task_id: taskId, summary, failed,
      checks: JSON.stringify(['file:src/needle.ts']), artifacts: JSON.stringify(artifacts), open_questions: '[]', next_action: '',
    });
    internals.emit('checkpoint', 'checkpoint_save', id, actor.id);
    return id;
  }
  return { store, internals, db, actor, project, taskId, decision, checkpoint, home };
}

test('active briefings keep standing decisions and direct fetch annotates supersession', t => {
  const { store, internals, actor, project, taskId, decision } = fixture(t);
  const oldStanding = decision('obsolete standing', null);
  const standing = decision('active standing', null, oldStanding);
  for (let i = 0; i < 16; i++) decision(`local ${i}`, taskId);
  const oldLocal = decision('obsolete local', taskId);
  const newLocal = decision('active local', taskId, oldLocal);
  const overview = store.op_project_resume(actor, { project_id: project.id }).recent_decisions;
  assert.equal(overview.length, 11);
  assert.equal(overview[0].id, standing);
  assert.ok(!overview.some((row: Json) => row.id === oldStanding || row.id === oldLocal));

  const snapshot = internals.airSnapshot(actor, project, null).lines.join('\n');
  assert.match(snapshot, /active standing/);
  assert.match(snapshot, /active local/);
  assert.doesNotMatch(snapshot, /obsolete (standing|local)/);
  const focused = store.op_project_resume(actor, { project_id: project.id, task_id: taskId });
  assert.equal(focused.decisions[0].id, newLocal);
  assert.ok(!focused.decisions.some((row: Json) => row.id === oldLocal));
  const taskRef = internals.handleOf('t', taskId);
  const taskContext = buildContext([`task:${taskRef}`], {
    root: project.root, artifact: () => undefined,
    task: ref => internals.taskContext(project.id, ref),
  });
  for (const context of [taskContext, internals.airSnapshot(actor, project, taskId).lines.join('\n')]) {
    assert.match(context, /active local/);
    assert.doesNotMatch(context, /obsolete local/);
  }
  const detail = store.op_air_get(actor, { handles: internals.handleOf('d', oldLocal) }).air;
  assert.match(detail, new RegExp(`\\bsup_by=${internals.handleOf('d', newLocal)}(?:\\s|$)`));
});

test('schema 18 rebuild and live writes feed bounded lexical, reference and temporal recall', t => {
  const { store, internals, db, actor, project, taskId, decision, checkpoint } = fixture(t);
  decision('lexical sentinel', null);
  checkpoint();
  decision('apply retry guard', taskId);
  const p = internals.handleOf('p', project.id);

  assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, SCHEMA_VERSION);
  db.exec('DROP TABLE memory_fts; DROP TABLE entity_refs; PRAGMA user_version = 17');
  migrate(db);
  assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, SCHEMA_VERSION);
  assert.match(store.op_air_get(actor, { handles: '?sentinel' }).air, /lexical sentinel/);
  // The fix has no query terms or reference edge. Its decision seq is smaller
  // than the failed checkpoint's seq, but its event occurred afterward.
  const result = store.op_air_get(actor, { handles: `${p}:recall:src/needle.ts`, max_chars: 1000 }).air;
  assert.match(result, new RegExp(`@air1 recall p=${p}\\b`));
  assert.match(result, /Probe failed/);
  assert.match(result, /apply retry guard/);
  assert.ok(result.split('\n').slice(2).join('\n').length <= 1000);
  assert.match(store.op_air_get(actor, { handles: '?needle', max_chars: 20 }).air, /\bhits=0$/);
  assert.match(store.op_air_get(actor, { handles: '?needle', raw: true }).air, /err=BAD_HANDLE/);

  decision('fresh index entry', null, null, ['file:src/needle.ts']);
  assert.match(store.op_air_get(actor, { handles: '?needle' }).air, /fresh index entry/);
  const artId = store.op_art_put(actor, {
    project_id: project.id, name: 'spec.md', kind: 'doc', content: 'spec body',
  }).artifact.id;
  const art = internals.handleOf('a', artId);
  checkpoint('linked to artifact handle', 0, [artId]);
  assert.match(store.op_air_get(actor, { handles: `?${art}` }).air, /linked to artifact handle/);
  backfillMemoryIndex(db);
  assert.equal(db.prepare("SELECT count(*) AS n FROM memory_fts WHERE primary_text = 'fresh index entry'").get()?.n, 1);
  assert.match(store.op_air_get(actor, { handles: `?${art}` }).air, /linked to artifact handle/);
});

test('job submission and need to=ctx resolve project recall without calling a worker', t => {
  const { store, internals, db, actor, project, taskId, decision, home } = fixture(t);
  decision('remember the input guard', null, null, ['file:src/guard.ts']);
  const submit = (refs: string[]) => store.op_job_submit(actor, {
    project_id: project.id, task_id: taskId, route: 'openai-api', mode: 'advice',
    protocol: 'air', prompt: 'Review the guard', context_refs: refs,
    max_cost_usd: 0.25, purpose: 'M3c test', deliverable: 'Review',
  }).job;
  const ref = 'recall:src/guard.ts';
  submit([ref]);
  const dir = join(home, 'artifacts');
  assert.ok(readdirSync(dir).some(file => {
    const body = readFileSync(join(dir, file), 'utf8');
    return body.includes(`@ctx ${ref}`) && body.includes('remember the input guard');
  }));

  const job = submit([]);
  const row = db.prepare('SELECT options FROM jobs WHERE id=?').get(job.id);
  const options = JSON.parse(String(row?.options));
  db.prepare("UPDATE jobs SET status='completed', options=? WHERE id=?")
    .run(JSON.stringify({ ...options, air: { ok: true, need: { to: 'ctx', ctx: [ref] } } }), job.id);
  internals.yieldStep(job.id);
  const updated = db.prepare('SELECT options FROM jobs WHERE id=?').get(job.id);
  const resolved = JSON.parse(String(updated?.options));
  assert.equal(resolved.need_refused, 'PAID_ROUTE');
  assert.equal(resolved.next, undefined);
  assert.ok(resolved.need_ctx_artifact);
  const artifact = db.prepare('SELECT sha256 FROM artifacts WHERE id=?').get(resolved.need_ctx_artifact);
  const body = readFileSync(join(dir, String(artifact?.sha256)), 'utf8');
  assert.match(body, /@ctx recall:src\/guard\.ts/);
  assert.match(body, /remember the input guard/);
});
