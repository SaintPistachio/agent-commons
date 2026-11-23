import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Store, type Actor } from './fixtures/service.ts';
import { Runner, resolveAntigravity } from '../src/runner.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-antigravity.mjs', import.meta.url));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function fixture(t: any) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-ag-'));
  const home = path.join(base, 'home'), root = path.join(base, 'repo');
  fs.mkdirSync(root, { recursive: true });
  const store = new Store(home);
  const actor: Actor = store.createActor('claude-desktop', 'participant', 'claude-desktop').actor;
  const call = (method: string, input: Record<string, unknown> = {}) => store.call(actor, method, input);
  const project = call('project_create', { name: 'Repo', root, operation_id: randomUUID() }).project;
  const runners: Runner[] = [];
  const runner = () => { const r = new Runner(store, home, { antigravity: { file: process.execPath, prefix: [FAKE] }, tickMs: 50 }); runners.push(r); return r; };
  t.after(() => { for (const r of runners) r.stop(); store.close(); fs.rmSync(base, { recursive: true, force: true }); });
  const submit = (prompt: string, extra: Record<string, unknown> = {}) =>
    call('job_submit', { project_id: project.id, prompt, route: 'antigravity', operation_id: randomUUID(), ...extra }).job;
  const until = async (id: string, statuses: string[], ms = 15000) => {
    const end = Date.now() + ms;
    for (;;) { const job = call('job_status', { job_id: id }).job; if (statuses.includes(job.status)) return job; if (Date.now() > end) throw new Error(`job stuck in ${job.status}`); await sleep(50); }
  };
  const args = (id: string): string[] => JSON.parse(fs.readFileSync(path.join(home, 'jobs', id, 'args.json'), 'utf8'));
  return { call, runner, submit, until, args, home };
}
const FINAL = ['completed', 'failed', 'needs_review', 'cancelled'];

test('an antigravity job runs the helper once with task, effort and the prompt in a file', async t => {
  const f = fixture(t);
  const job = f.submit('Compare two designs', { task: 'review', effort: 'high', effort_reason: 'Demanding critique of a short design.', timeout_minutes: 10 });
  assert.deepEqual(job.options, { task: 'review', effort_reason: 'Demanding critique of a short design.', selection: { intent: 'code', eff: 'med', source: 'inferred', reasons: ['default'] } });
  f.runner().start();
  const done = await f.until(job.id, FINAL);
  assert.equal(done.status, 'completed', done.error);
  assert.equal(done.result, 'ag: Compare two designs');
  const args = f.args(job.id);
  assert.deepEqual(args.slice(0, 4), ['-Action', 'Run', '-Task', 'review']);
  assert.equal(args[args.indexOf('-Effort') + 1], 'high');
  assert.equal(args[args.indexOf('-EffortReason') + 1], 'Demanding critique of a short design.');
  assert.equal(args[args.indexOf('-TimeoutSeconds') + 1], '540');
  assert.equal(fs.readFileSync(args[args.indexOf('-PromptPath') + 1], 'utf8'), 'Compare two designs');
  const env = JSON.parse(fs.readFileSync(path.join(f.home, 'jobs', job.id, 'env.json'), 'utf8'));
  assert.equal(env.AC_ANTIGRAVITY_STATE, path.join(f.home, 'helpers', 'antigravity'));
  assert.ok(fs.statSync(env.AC_ANTIGRAVITY_STATE).isDirectory());
});

test("the antigravity route uses the helper shipped with Agent Commons, not another app's folder", () => {
  const route = resolveAntigravity();
  if (!route) return; // no PowerShell 7 on this machine
  const script = route.prefix![route.prefix!.indexOf('-File') + 1];
  assert.equal(path.resolve(script), path.resolve(fileURLToPath(new URL('../helpers/antigravity/scripts/Invoke-Antigravity.ps1', import.meta.url))));
  assert.ok(fs.existsSync(script));
});

test('refusals before submission fail; a submitted run without an answer is left for review', async t => {
  const f = fixture(t);
  const quota = f.submit('QUOTA'), preflight = f.submit('PREFLIGHT'), unclear = f.submit('UNCLEAR'), invalid = f.submit('INVALID');
  f.runner().start();
  const q = await f.until(quota.id, FINAL);
  assert.equal(q.status, 'failed'); assert.match(q.error, /^AG_POOL_EXHAUSTED: Gemini weekly limit/);
  const p = await f.until(preflight.id, FINAL);
  assert.equal(p.status, 'failed'); assert.equal(p.error, 'HELPER_BLOCKED: REVALIDATION_REQUIRED');
  const u = await f.until(unclear.id, FINAL);
  assert.equal(u.status, 'needs_review'); assert.match(u.error, /INFERENCE_TIMEOUT; the prompt may have been submitted/);
  const i = await f.until(invalid.id, FINAL);
  assert.equal(i.status, 'failed'); assert.equal(i.error, 'HELPER_INVALID_OUTPUT');
});

test('model-selection and setup refusals happen before any run, so they fail instead of waiting for review', async t => {
  const f = fixture(t);
  const noModel = f.submit('NO_MODEL'), ambient = f.submit('AMBIENT');
  f.runner().start();
  const n = await f.until(noModel.id, FINAL);
  assert.equal(n.status, 'failed', n.error); assert.equal(n.error, 'HELPER_BLOCKED: NO_ELIGIBLE_MODEL');
  const a = await f.until(ambient.id, FINAL);
  assert.equal(a.status, 'failed', a.error); assert.equal(a.error, 'HELPER_BLOCKED: AMBIENT_CUSTOMIZATIONS');
});

test('only a known pre-run refusal or a consistent not_submitted reply counts as not submitted', async t => {
  const f = fixture(t);
  const late = f.submit('LATE_ERROR'), contradiction = f.submit('CONTRADICTION'), twoLines = f.submit('TWO_LINES');
  f.runner().start();
  for (const job of [late, contradiction, twoLines]) {
    const done = await f.until(job.id, FINAL);
    assert.equal(done.status, 'needs_review', `${job.prompt}: ${done.error}`);
  }
});

test('cancelling a running antigravity job leaves it for review (the prompt may be out)', async t => {
  const f = fixture(t);
  const job = f.submit('SLEEP on it');
  f.runner().start();
  await f.until(job.id, ['running']);
  await sleep(500);
  f.call('job_cancel', { job_id: job.id, operation_id: randomUUID() });
  const done = await f.until(job.id, FINAL);
  assert.equal(done.status, 'needs_review'); assert.match(done.error, /^CANCELLED/);
});

test('antigravity validation: advice only, task, effort, one-line reason, time limit', t => {
  const f = fixture(t);
  assert.throws(() => f.submit('x', { mode: 'edit' }), /advice only/);
  assert.throws(() => f.submit('x', { task: 'transform' }), /task must be/);
  assert.throws(() => f.submit('x', { effort: 'extreme' }), /effort must be/);
  assert.throws(() => f.submit('x', { effort_reason: 'two\nlines' }), /one line/);
  assert.throws(() => f.submit('x', { timeout_minutes: 90 }), /60 minutes/);
  assert.equal(f.submit('ok').options.task, 'coding');
  assert.equal(f.submit('ok').timeout_ms, 15 * 60000);
});

test('the helper offline guard checks pass', () => {
  const script = fileURLToPath(new URL('../helpers/antigravity/tests/test_guard.py', import.meta.url));
  let out: string;
  try { out = execFileSync('python', ['-B', script], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }); }
  catch (error: any) { if (error.code === 'ENOENT') return; throw new Error(String(error.stdout ?? error)); }
  assert.match(out, /\nALL PASS\s*$/, out);
});
