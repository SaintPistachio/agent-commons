import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from '../src/store.ts';
import { acceptanceHistory, appendOutcome, recordConsultOutcome } from '../src/outcomes.ts';
import { outcomeStats } from '../src/ops.ts';
import { parsePacket } from '../src/air/parser.ts';

const project = randomUUID();
const actor = { id: 'tester', name: 'Tester', role: 'operator' as const };

function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commons-outcomes-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const store = new Store(home);
  t.after(() => { store.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const timestamp = new Date().toISOString();
  store.db.prepare('INSERT INTO actors(id,name,role,token_sha256,created_at) VALUES(?,?,?,?,?)')
    .run(actor.id, actor.name, actor.role, 'test-only', timestamp);
  store.db.prepare('INSERT INTO projects(id,name,root,created_at,updated_at) VALUES(?,?,?,?,?)')
    .run(project, 'Test', dir, timestamp, timestamp);
  const makeJob = (route = 'first', intent = 'code', eff = 'med', model = 'native') => {
    const id = randomUUID();
    const row = store.db.prepare(`INSERT INTO jobs(id,project_id,route,mode,prompt,status,timeout_ms,created_by,created_at,
      req_intent,req_eff,resolved_model,resolved_eff,latency_ms,cost_usd) VALUES(?,?,?,'advice','test','completed',1000,?,?,?,?,?,'normal',100,'0.02')`)
      .run(id, project, route, actor.id, timestamp, intent, eff, model);
    return { id, handle: `j${row.lastInsertRowid}` };
  };
  const outcomes = (id: string) => store.db.prepare('SELECT kind, detail FROM job_outcomes WHERE job_id=? ORDER BY id').all(id)
    .map(row => ({ ...row }));
  return { dir, home, store, makeJob, outcomes };
}

test('AIR records explicit decisions and links redone to a replacement, idempotently', t => {
  const { store, makeJob, outcomes } = fixture(t);
  const job = makeJob(), replacement = makeJob();
  const packet = `@air1\n#0 out j=${job.handle} v=accepted "correct"\n#1 out j=${job.handle} v=rejected "regression"\n#2 out j=${job.handle} v=redone replacement=${replacement.handle} "quality failure"`;
  const input = { project_id: project, packet, operation_id: randomUUID() };
  store.call(actor, 'air_tx', input);
  store.call(actor, 'air_tx', input);
  assert.deepEqual(outcomes(job.id), [
    { kind: 'accepted', detail: 'correct' }, { kind: 'rejected', detail: 'regression' },
    { kind: 'redone', detail: JSON.stringify({ reason: 'quality failure', replacement_job_id: replacement.id }) },
  ]);
  assert.throws(() => parsePacket(packet, 'worker'), /workers may only use/);
});

test('consult verdicts stay separate from completion, acceptance and rejection in stats', t => {
  const { store, makeJob, outcomes } = fixture(t);
  const job = makeJob();
  const unknown = makeJob();
  store.db.prepare('UPDATE jobs SET cost_usd=NULL, latency_ms=NULL WHERE id=?').run(unknown.id);
  store.db.prepare("UPDATE jobs SET trigger='auto_review', consult_verdict='chg' WHERE id=?").run(job.id);
  recordConsultOutcome(store.db, job.id, 'service');
  recordConsultOutcome(store.db, job.id, 'service');
  assert.deepEqual(outcomes(job.id), [{ kind: 'consult_verdict', detail: 'chg' }]);
  assert.deepEqual(outcomes(unknown.id), []);
  assert.match(outcomeStats(store).join('\n'), /jobs=2 completed=2 outcomes=1 feedback_jobs=1 insufficient applied=0 accepted=0 rejected=0/);
  assert.match(outcomeStats(store).join('\n'), /median_cost_usd=0\.0200 \(n=1\) median_latency_ms=100\.0 \(n=1\)/);
});

test('air-apply emits per-job evidence through air_tx for real writes and verification, not dry runs', t => {
  const { dir, home, makeJob, outcomes } = fixture(t);
  const passed = makeJob(), failed = makeJob();
  // Substitute only the loopback client transport. The child runs the actual CLI, verifier and Store.air_tx.
  const connection = path.join(dir, 'connection.json');
  fs.writeFileSync(connection, '{}');
  const mock = path.join(dir, 'client-mock.mjs');
  const storeUrl = new URL('../src/store.ts', import.meta.url).href;
  fs.writeFileSync(mock, `
    import { Store } from ${JSON.stringify(storeUrl)};
    export class RemoteError extends Error {}
    export const isRetryableTransportError = () => false;
    export const readConnection = () => ({ projectIds: [${JSON.stringify(project)}] });
    export async function call(_connection, method, input) {
      if (method === 'air_get') return { raw: [{ handle: input.handles, kind: 'job', status: 'completed',
        complete: true, content: ['<<<FILE ' + input.handles + '.txt', 'proposal', '>>>END'].join('\\n') }] };
      if (method !== 'air_tx') throw new Error('unexpected method');
      const store = new Store(${JSON.stringify(home)});
      try { return store.call(${JSON.stringify(actor)}, method, input); } finally { store.db.close(); }
    }
  `);
  const hook = path.join(dir, 'hook.mjs');
  fs.writeFileSync(hook, `import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, next) {
      if (specifier === './client.ts' && context.parentURL?.endsWith('/src/cli.ts'))
        return { url: ${JSON.stringify(pathToFileURL(mock).href)}, shortCircuit: true };
      return next(specifier, context);
    } });
  `);
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const run = (handle: string, code: number, dry = false) => {
    const child = spawnSync(process.execPath, ['--import', pathToFileURL(hook).href, cli, 'air-apply',
      '--connection', connection, '--handles', handle, '--cwd', dir, '--no-pack-repair',
      '--verify', `exit ${code}`, ...(dry ? ['--dry-run'] : [])], { encoding: 'utf8', timeout: 15_000 });
    assert.ifError(child.error);
    assert.equal(child.status, dry || code === 0 ? 0 : 2, child.stderr + child.stdout);
    assert.doesNotMatch(child.stderr, /could not record outcome evidence/);
  };
  run(passed.handle, 0, true);
  assert.equal(fs.existsSync(path.join(dir, `${passed.handle}.txt`)), false);
  assert.deepEqual(outcomes(passed.id), []);
  run(passed.handle, 0);
  run(failed.handle, 7);
  for (const [job, kind, exit] of [[passed, 'verify_pass', 0], [failed, 'verify_fail', 7]] as const) {
    assert.equal(fs.readFileSync(path.join(dir, `${job.handle}.txt`), 'utf8'), 'proposal\n');
    const [applied, verification] = outcomes(job.id);
    assert.equal(applied.kind, 'applied');
    assert.equal(JSON.parse(String(applied.detail)).files, 1);
    assert.equal(JSON.parse(String(applied.detail)).edits, 0);
    assert.equal(verification.kind, kind);
    assert.equal(JSON.parse(String(verification.detail)).exit_code, exit);
  }
});

test('route history needs ten distinct decisions on both sides and cannot bypass profile floors', t => {
  const { store, makeJob } = fixture(t);
  const profile = store.db.prepare(`INSERT INTO platform_profiles(adapter_id,intent,eff,native_model,native_effort,priority,updated_at)
    VALUES(?,'code','med','native','normal',10,?)`);
  for (const route of ['first', 'peer']) profile.run(route, new Date().toISOString());
  const base = { billing: 'sub', priority: 10, lowQuota: 0, running: 0, queued: 0, limit: 1, success: 1 };
  // Exercise the real history layer with deterministic, already-eligible policy candidates.
  const hooks = store as unknown as {
    pickRouteByPolicy: (...args: any[]) => unknown;
    jobConfiguration: (...args: any[]) => unknown;
    pickRoute: (actor: unknown, input: unknown, mode: string, intent: string, eff: string) => { route: string; outcomeHistory?: true };
  };
  hooks.pickRouteByPolicy = (_actor, _input, _mode, _intent, _eff, observe) => {
    observe([{ ...base, id: 'first', order: 0 }, { ...base, id: 'peer', order: 1 }]);
    return { route: 'first', considered: ['first', 'peer'] };
  };
  hooks.jobConfiguration = () => ({ model: 'native', effort: 'normal' });
  const add = (route: string, decision: 'accepted' | 'rejected') => {
    const job = makeJob(route);
    appendOutcome(store.db, job.id, decision, 'test decision', actor.id);
    return job;
  };
  for (let i = 0; i < 9; i++) {
    add('first', 'rejected');
    const job = add('peer', 'accepted');
    appendOutcome(store.db, job.id, 'accepted', 'duplicate feedback on the same job', actor.id);
  }
  const pick = (intent = 'code', effort = 'med') => hooks.pickRoute(actor, {}, 'advice', intent, effort);
  assert.equal(acceptanceHistory(store.db, { route: 'peer', intent: 'code', eff: 'med', model: 'native', nativeEffort: 'normal', mode: 'advice' }).n, 9);
  assert.equal(pick().route, 'first');
  add('first', 'rejected');
  assert.equal(pick().route, 'first');
  add('peer', 'accepted');
  assert.equal(pick().route, 'peer');
  assert.equal(pick().outcomeHistory, true);
  assert.equal(pick('review').route, 'first');
  assert.equal(pick('deep').route, 'first');
  assert.equal(pick('code', 'high').route, 'first');
  store.db.prepare("UPDATE platform_profiles SET priority=1 WHERE adapter_id='peer'").run();
  assert.equal(pick().route, 'first');
});
