import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, type Actor } from '../src/store.ts';
import { Prober } from '../src/prober.ts';
import { antigravity } from '../src/adapters/antigravity.ts';

// A stand-in for the helper's Status action: records its arguments and state folder, prints one JSON reply.
const STATUS = `
import fs from 'node:fs';
const log = process.env.FAKE_STATUS_LOG;
if (log) fs.appendFileSync(log, JSON.stringify({ args: process.argv.slice(2), state: process.env.AC_ANTIGRAVITY_STATE }) + '\\n');
if (process.env.FAKE_STATUS_FAIL) { console.log(JSON.stringify({ status: 'FAILED', error_code: 'CLI_ERROR' })); process.exit(1); }
console.log(JSON.stringify({ status: 'SUCCESS', quota: [
  { group: 'Gemini Models', limit: 'Five Hour Limit Remaining', remaining_percent: 54.0, resets_at: '2026-11-22T02:02:12Z' },
  { group: 'Claude and GPT models', limit: 'Five Hour Limit Remaining', remaining_percent: 0.0, resets_at: null, state: 'disabled' },
] }));
`;

function fixture(t: any, accepted = true) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-agusage-'));
  t.after(() => { delete process.env.FAKE_STATUS_LOG; delete process.env.FAKE_STATUS_FAIL; try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* the store may still hold its files on Windows */ } });
  const home = path.join(base, 'home');
  const state = path.join(home, 'helpers', 'antigravity');
  fs.mkdirSync(state, { recursive: true });
  if (accepted) fs.writeFileSync(path.join(state, 'acceptance.json'), JSON.stringify({ status: 'passed' }));
  const script = path.join(base, 'status.mjs');
  fs.writeFileSync(script, STATUS);
  const log = path.join(base, 'calls.log');
  process.env.FAKE_STATUS_LOG = log;
  const options = { antigravity: { file: process.execPath, prefix: [script] } };
  const calls = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [];
  return { base, home, state, options, calls };
}

test('Antigravity usage is read through the helper Status action, without a job', async (t) => {
  const f = fixture(t);
  const snapshot = await antigravity.observeUsage!({ home: f.home, options: f.options, overrides: {} });
  assert.equal(snapshot?.source, 'status');
  assert.deepEqual(snapshot!.rows.map(r => [r.pool, r.window, r.remaining_percent, r.resets_at]), [
    ['Gemini Models', 'Five Hour Limit Remaining', 54, '2026-11-22T02:02:12Z'],
    ['Claude and GPT models', 'Five Hour Limit Remaining', 0, null],  // disabled: still closed, not unknown
  ]);
  assert.ok(snapshot!.rows.every(r => typeof r.observed_at === 'string'));
  const [call] = f.calls();
  assert.deepEqual(call.args, ['-Action', 'Status']);
  assert.equal(call.state, f.state);
});

test('no usage read without a passed helper approval record, or when the helper fails', async (t) => {
  const unapproved = fixture(t, false);
  assert.equal(await antigravity.observeUsage!({ home: unapproved.home, options: unapproved.options, overrides: {} }), undefined);
  assert.equal(unapproved.calls().length, 0);
  const failing = fixture(t);
  process.env.FAKE_STATUS_FAIL = '1';
  assert.equal(await antigravity.observeUsage!({ home: failing.home, options: failing.options, overrides: {} }), undefined);
});

test('the usage refresh records windows for an idle verified route and skips one with a running job', async (t) => {
  const f = fixture(t);
  const root = path.join(f.base, 'repo');
  fs.mkdirSync(root);
  const store = new Store(f.home);
  t.after(() => store.close());
  store.recordProbe(antigravity.capabilities, { state: 'verified' });
  const prober = new Prober(store, f.home, f.options, { adapters: ['antigravity'], schedule: false });
  const windows = () => store.db.prepare(`SELECT pool, remaining_percent, source FROM usage_windows WHERE route='antigravity' ORDER BY pool`).all() as any[];

  await prober.refreshUsage();
  assert.deepEqual(windows().map(w => [w.pool, w.remaining_percent, w.source]),
    [['Claude and GPT models', 0, 'status'], ['Gemini Models', 54, 'status']]);
  assert.equal(f.calls().length, 1);

  // A running job will report its own quota when it ends: no Status call meanwhile.
  const actor: Actor = store.createActor('usage-tester', 'participant', 'usage-tester').actor;
  const project = store.call(actor, 'project_create', { name: 'Usage', root, operation_id: randomUUID() }).project;
  const job = store.call(actor, 'job_submit', { project_id: project.id, route: 'antigravity', prompt: 'x', operation_id: randomUUID() }).job;
  store.db.prepare(`UPDATE jobs SET status='running' WHERE id=?`).run(job.id);
  await prober.refreshUsage();
  assert.equal(f.calls().length, 1);

  // An unverified route is not read either.
  store.db.prepare(`UPDATE jobs SET status='cancelled' WHERE id=?`).run(job.id);
  store.recordProbe(antigravity.capabilities, { state: 'blocked', reason: 'test' });
  await prober.refreshUsage();
  assert.equal(f.calls().length, 1);
});

test('no usage read while a job is queued, and none after the prober stops (j122 review)', async (t) => {
  const f = fixture(t);
  const root = path.join(f.base, 'repo');
  fs.mkdirSync(root);
  const store = new Store(f.home);
  t.after(() => store.close());
  store.recordProbe(antigravity.capabilities, { state: 'verified' });
  const prober = new Prober(store, f.home, f.options, { adapters: ['antigravity'], schedule: false });
  const actor: Actor = store.createActor('usage-tester', 'participant', 'usage-tester').actor;
  const project = store.call(actor, 'project_create', { name: 'Usage', root, operation_id: randomUUID() }).project;
  const job = store.call(actor, 'job_submit', { project_id: project.id, route: 'antigravity', prompt: 'x', operation_id: randomUUID() }).job;
  await prober.refreshUsage();
  assert.equal(f.calls().length, 0, 'a queued job is about to start: no Status call');
  store.db.prepare(`UPDATE jobs SET status='cancelled' WHERE id=?`).run(job.id);
  await Promise.all([prober.refreshUsage(), prober.refreshUsage()]);
  assert.ok(f.calls().length >= 1 && f.calls().length <= 2, 'reads are serialized and a waiting read is shared');
  const before = f.calls().length;
  prober.stop();
  await prober.refreshUsage();
  assert.equal(f.calls().length, before, 'a stopped prober starts no reads');
});
