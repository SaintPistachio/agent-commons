// Outcome-learning extras: repair rate and total cost until accepted in stats, and the schema 21 backfill of
// consult verdicts recorded before schema 19.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, type Json } from './fixtures/service.ts';
import { acceptedAssignments, outcomeStats } from '../src/ops.ts';
import { appendOutcome } from '../src/outcomes.ts';
import { migrate, SCHEMA_VERSION } from '../src/schema.ts';
import { DatabaseSync } from 'node:sqlite';

const project = randomUUID(), actor = 'tester';

function fixture(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-outcome-extras-'));
  const home = path.join(dir, 'home'); fs.mkdirSync(home);
  let store = new Store(home);
  t.after(() => { try { store.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  const at = new Date().toISOString();
  store.db.prepare('INSERT INTO projects(id,name,root,created_at,updated_at) VALUES(?,?,?,?,?)').run(project, 'Test', dir, at, at);
  const job = (fields: Json = {}) => {
    const row = { id: randomUUID(), route: 'openai-api', status: 'completed', eff: 'med', cost: null as string | null, trigger: null as string | null,
      parent: null as string | null, repair_of: null as string | null, verdict: null as string | null, ...fields };
    store.db.prepare(`INSERT INTO jobs(id,project_id,route,mode,prompt,status,timeout_ms,created_by,created_at,finished_at,req_intent,req_eff,
      resolved_model,resolved_eff,cost_usd,trigger,parent_job_id,repair_of,consult_verdict) VALUES(?,?,?,'advice','x',?,1000,?,?,?,'code',?,'m','normal',?,?,?,?,?)`)
      .run(row.id, project, row.route, row.status, actor, at, at, row.eff, row.cost, row.trigger, row.parent, row.repair_of, row.verdict);
    return row.id;
  };
  const reopen = () => { store.close(); store = new Store(home); return store; };
  return { get store() { return store; }, job, reopen };
}

test('stats report the repair rate and the total known cost until acceptance per root configuration', t => {
  const f = fixture(t);
  // A repaired root accepted on its repair: root 0.10 + repair 0.20.
  const root = f.job({ cost: '0.10' });
  const repair = f.job({ cost: '0.20', trigger: 'repair', parent: root, repair_of: root, eff: 'high' });
  appendOutcome(f.store.db, repair, 'accepted', 'good', actor);
  // A yield chain under another root, accepted on the root: root + consult + continuation.
  const asker = f.job({ cost: '0.01' });
  const consult = f.job({ cost: '0.02', trigger: 'yield', parent: asker, eff: 'high' });
  const continuation = f.job({ cost: '0.03', trigger: 'resume', parent: asker });
  appendOutcome(f.store.db, continuation, 'accepted', 'good', actor);
  // A rejected and redone attempt followed by an accepted replacement: 0.05 + 0.07, credited to the replacement.
  const first = f.job({ cost: '0.05', eff: 'low' }), replacement = f.job({ cost: '0.07', eff: 'low' });
  appendOutcome(f.store.db, first, 'rejected', 'wrong', actor);
  appendOutcome(f.store.db, first, 'redone', JSON.stringify({ reason: 'quality', replacement_job_id: replacement }), actor);
  appendOutcome(f.store.db, replacement, 'accepted', 'good', actor);
  // A paid job of unknown cost is unknown, not free; a subscription job without a price counts as zero.
  const unpriced = f.job({ eff: 'min' });
  appendOutcome(f.store.db, unpriced, 'accepted', 'good', actor);
  const sub = f.job({ route: 'claude', eff: 'med' });
  appendOutcome(f.store.db, sub, 'accepted', 'good', actor);
  // A later rejection supersedes acceptance.
  const reversed = f.job({ cost: '0.40', eff: 'max' });
  appendOutcome(f.store.db, reversed, 'accepted', 'good', actor);
  appendOutcome(f.store.db, reversed, 'rejected', 'regressed', actor);

  const costs = new Map(acceptedAssignments(f.store).map(a => [a.root, a.cost]));
  assert.equal(costs.get(root)!.toFixed(2), '0.30');
  assert.equal(costs.get(asker)!.toFixed(2), '0.06');
  assert.equal(costs.get(replacement)!.toFixed(2), '0.12');
  assert.equal(costs.get(unpriced), null);
  assert.equal(costs.get(sub), 0);
  assert.equal(costs.has(reversed), false);
  assert.equal(costs.size, 5, 'each assignment once');

  const lines = outcomeStats(f.store);
  const line = (eff: string, route = 'openai-api') => lines.find(l => l.includes(`route=${route} intent=code effort=${eff} `))!;
  // med openai-api: root (repaired) and asker (not) are finished caller jobs; continuation is not a root.
  assert.match(line('med'), /repair_rate=50% \(1\/2\) cost_to_accept_usd median=0\.1800 \(n=2\) total=0\.3600/);
  assert.match(line('high'), /repair_rate=unknown \(0\/0\) cost_to_accept_usd=unknown \(n=0\)/);
  assert.match(line('low'), /cost_to_accept_usd median=0\.1200 \(n=1\) total=0\.1200/);
  assert.match(line('min'), /cost_to_accept_usd=unknown \(n=0, unknown=1\)/);
  assert.match(line('med', 'claude'), /cost_to_accept_usd median=0\.0000 \(n=1\)/);
});

test('schema 21 backfills pre-schema-19 consult verdicts once, for completed jobs only', t => {
  const f = fixture(t);
  const old = f.job({ verdict: 'chg' });
  const recorded = f.job({ verdict: 'ok' });
  f.store.db.prepare("INSERT INTO job_outcomes(job_id,kind,detail,actor_id,created_at) VALUES(?,'consult_verdict','ok','agent-commons',?)")
    .run(recorded, new Date().toISOString());
  const failed = f.job({ verdict: 'none', status: 'failed' });
  const plain = f.job();
  f.store.db.exec('PRAGMA user_version = 20');
  const store = f.reopen();
  assert.equal(Number((store.db.prepare('PRAGMA user_version').get() as Json).user_version), SCHEMA_VERSION);
  const rows = (id: string) => store.db.prepare("SELECT detail, actor_id FROM job_outcomes WHERE job_id=? AND kind='consult_verdict'").all(id) as Json[];
  assert.deepEqual(rows(old).map(r => ({ ...r })), [{ detail: 'chg', actor_id: 'agent-commons:backfill-v21' }]);
  assert.deepEqual(rows(recorded).map(r => r.actor_id), ['agent-commons'], 'an existing observation is kept, not duplicated');
  assert.equal(rows(failed).length, 0);
  assert.equal(rows(plain).length, 0);
  store.db.exec('PRAGMA user_version = 20');
  const again = f.reopen();
  assert.equal(Number((again.db.prepare("SELECT count(*) n FROM job_outcomes WHERE job_id=? AND kind='consult_verdict'").get(old) as Json).n), 1,
    'running the step again adds nothing');
});

test('redo chains, forks, nested repairs, cycles and bad prices are credited once and safely', t => {
  const f = fixture(t);
  const redone = (from: string, to: string) => appendOutcome(f.store.db, from, 'redone', JSON.stringify({ reason: 'q', replacement_job_id: to }), actor);
  // A was accepted, then redone by B, which was accepted: one assignment (B) carrying both costs.
  const a = f.job({ cost: '0.01', eff: 'low' }), b = f.job({ cost: '0.02', eff: 'low' });
  appendOutcome(f.store.db, a, 'accepted', 'ok', actor); redone(a, b); appendOutcome(f.store.db, b, 'accepted', 'ok', actor);
  // A fork: C redone toward D, then (latest) toward E. Only E carries C.
  const c = f.job({ cost: '0.10', eff: 'min' }), d = f.job({ cost: '0.20', eff: 'min' }), e = f.job({ cost: '0.30', eff: 'min' });
  redone(c, d); redone(c, e);
  appendOutcome(f.store.db, d, 'accepted', 'ok', actor); appendOutcome(f.store.db, e, 'accepted', 'ok', actor);
  // A repair of a yield continuation is credited to the job that yielded.
  const asker = f.job({ cost: '0.01', eff: 'high' });
  const cont = f.job({ cost: '0.01', trigger: 'resume', parent: asker, eff: 'high' });
  const fix = f.job({ cost: '0.01', trigger: 'repair', parent: asker, repair_of: asker, eff: 'max' });
  appendOutcome(f.store.db, fix, 'accepted', 'ok', actor);
  // A parent cycle does not hang or crash.
  const x = f.job({ trigger: 'resume', route: 'claude' }), y = f.job({ trigger: 'resume', route: 'claude', parent: x });
  f.store.db.prepare('UPDATE jobs SET parent_job_id=? WHERE id=?').run(y, x);
  appendOutcome(f.store.db, y, 'accepted', 'ok', actor);
  // A negative price on a paid job makes the assignment unknown.
  const negative = f.job({ cost: '-1', eff: 'med' });
  appendOutcome(f.store.db, negative, 'accepted', 'ok', actor);

  const all = acceptedAssignments(f.store), by = new Map(all.map(r => [r.root, r]));
  assert.equal(by.has(a), false, 'a superseded root is not its own assignment');
  assert.equal(by.get(b)!.cost!.toFixed(2), '0.03');
  assert.equal(by.get(d)!.cost!.toFixed(2), '0.20', 'the earlier fork target does not carry the predecessor');
  assert.equal(by.get(e)!.cost!.toFixed(2), '0.40');
  assert.equal(by.get(asker)!.cost!.toFixed(2), '0.03');
  assert.equal(by.get(asker)!.jobs, 3);
  assert.equal(void cont, undefined);
  assert.ok([x, y].some(id => by.has(id)), 'the cycle resolves to one of its jobs');
  assert.equal(by.get(negative)!.cost, null);
});

test('the repair rate counts finished caller jobs only', t => {
  const f = fixture(t);
  for (const status of ['completed', 'failed', 'cancelled', 'needs_review', 'queued', 'running']) f.job({ status, eff: 'low' });
  const repaired = f.job({ status: 'failed', eff: 'low' });
  f.job({ trigger: 'repair', parent: repaired, repair_of: repaired, eff: 'med', status: 'queued' });
  f.job({ trigger: 'auto_review', eff: 'low' });
  const line = outcomeStats(f.store).find(l => l.includes('effort=low '))!;
  assert.match(line, /repair_rate=20% \(1\/5\)/);
});

test('a backfill that fails leaves the schema version unchanged', t => {
  const f = fixture(t);
  f.store.db.exec('ALTER TABLE job_outcomes RENAME TO job_outcomes_old; CREATE TABLE job_outcomes(id INTEGER PRIMARY KEY); PRAGMA user_version = 20;');
  const file = f.store.db.prepare('PRAGMA database_list').get() as Json;
  f.store.close();
  const db = new DatabaseSync(file.file);
  try {
    assert.throws(() => migrate(db));
    assert.equal(Number((db.prepare('PRAGMA user_version').get() as Json).user_version), 20);
  } finally { db.close(); }
});
