import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store, type Actor } from '../src/store.ts';
import { Runner } from '../src/runner.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-openai-helper.mjs', import.meta.url));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const API = { route: 'openai-api', max_cost_usd: '0.25', purpose: 'Second opinion on a boundary case', deliverable: 'Test list for parser' };

function fixture(t: any) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-api-'));
  const home = path.join(base, 'home'), helperDir = path.join(base, 'helper'), root = path.join(base, 'repo');
  fs.mkdirSync(helperDir, { recursive: true }); fs.mkdirSync(root, { recursive: true });
  const store = new Store(home);
  const actor: Actor = store.createActor('codex-desktop', 'participant', 'codex-desktop').actor;
  const call = (method: string, input: Record<string, unknown> = {}) => store.call(actor, method, input);
  const operator = store.createActor('operator', 'operator').actor;
  const project = store.call(operator, 'project_create', { name: 'Repo', root, operation_id: randomUUID() }).project;
  const runners: Runner[] = [];
  // Shared and mutable, so a test can break the helper executable between refresh-costs and invoke.
  const helper = { file: process.execPath, prefix: [FAKE], cwd: helperDir };
  const runner = () => { const r = new Runner(store, home, { openaiHelper: helper, tickMs: 50 }); runners.push(r); return r; };
  t.after(() => { for (const r of runners) r.stop(); store.close(); fs.rmSync(base, { recursive: true, force: true }); });
  const submit = (prompt: string, extra: Record<string, unknown> = {}) => call('job_submit', { project_id: project.id, prompt, operation_id: randomUUID(), ...API, ...extra }).job;
  const until = async (id: string, statuses: string[], ms = 15000) => {
    const end = Date.now() + ms;
    for (;;) { const job = call('job_status', { job_id: id }).job; if (statuses.includes(job.status)) return job; if (Date.now() > end) throw new Error(`job stuck in ${job.status}`); await sleep(50); }
  };
  const calls = () => fs.existsSync(path.join(helperDir, 'calls.log'))
    ? fs.readFileSync(path.join(helperDir, 'calls.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  return { store, call, project, home, helperDir, helper, runner, submit, until, calls };
}

/** Waits until the fake helper has logged a call with this command. */
async function untilCall(f: ReturnType<typeof fixture>, command: string, ms = 10000) {
  const end = Date.now() + ms;
  while (!f.calls().some(c => c.command === command)) { if (Date.now() > end) throw new Error(`${command} never called`); await sleep(25); }
}

test('a service stop during refresh-costs never hands the request to the helper', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.helperDir, 'slow-refresh'), '');
  const job = f.submit('stopped before invoke');
  const r = f.runner(); r.start();
  await untilCall(f, 'refresh-costs');
  r.stop();
  await sleep(2500); // past the slow refresh reply
  assert.deepEqual(f.calls().map(c => c.command), ['refresh-costs']);
  const done = f.call('job_status', { job_id: job.id }).job;
  assert.equal(done.status, 'needs_review'); assert.equal(done.error, 'SERVICE_STOPPED_DURING_JOB');
});

test('an invoke that cannot be spawned fails as not submitted instead of needing review', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.helperDir, 'slow-refresh'), '');
  const job = f.submit('spawn will fail');
  f.runner().start();
  await untilCall(f, 'refresh-costs');
  f.helper.file = path.join(f.helperDir, 'missing-python.exe');
  const done = await f.until(job.id, ['completed', 'failed', 'needs_review']);
  assert.equal(done.status, 'failed'); assert.match(done.error, /^SPAWN_FAILED.*_BEFORE_SUBMISSION$/);
});

test('a launch setup failure fails the claimed job instead of leaving it running', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.home, 'jobs'), 'not a directory');
  const job = f.submit('no job directory');
  f.runner().start();
  const done = await f.until(job.id, ['completed', 'failed', 'needs_review'], 5000);
  assert.equal(done.status, 'failed'); assert.match(done.error, /^LAUNCH_FAILED/);
  assert.equal(f.calls().length, 0);
});

test('after a graceful stop mid-request, the next start asks the helper ledger', async t => {
  const f = fixture(t);
  const job = f.submit('SLEEP until the service stops');
  const r = f.runner(); r.start();
  await untilCall(f, 'invoke');
  r.stop();
  assert.equal(f.call('job_status', { job_id: job.id }).job.status, 'needs_review');
  const artifact = path.join(f.helperDir, 'artifact.json');
  fs.writeFileSync(artifact, JSON.stringify({ status: 'completed', output: 'finished after stop' }));
  fs.writeFileSync(path.join(f.helperDir, 'lookup.json'), JSON.stringify({ status: 'completed', job_id: 'hj-s', artifact, cost_usd: '0.000300' }));
  f.runner().start();
  const done = await f.until(job.id, ['completed'], 5000);
  assert.equal(done.result, 'finished after stop');
  assert.equal(f.calls().filter(c => c.command === 'invoke').length, 1);
});

test('an API job refreshes costs, then invokes the helper once with the job id as external_request_id', async t => {
  const f = fixture(t);
  const job = f.submit('Review this excerpt', { max_output_tokens: 2048, effort: 'low' });
  assert.equal(job.model, 'gpt-6.1-terra'); assert.equal(job.options.tier, 'default');
  f.runner().start();
  const done = await f.until(job.id, ['completed', 'failed', 'needs_review']);
  assert.equal(done.status, 'completed', done.error);
  assert.equal(done.result, 'api: Review this excerpt');
  assert.equal(done.cost_usd, '0.000123'); assert.equal(done.helper_job_id, 'hj-ok');
  const [refresh, invoke, ...others] = f.calls();
  assert.equal(refresh.command, 'refresh-costs'); assert.equal(invoke.command, 'invoke'); assert.equal(others.length, 0);
  assert.equal(invoke.request.external_request_id, job.id);
  assert.deepEqual(invoke.request.purpose, { kind: 'coding_assistance', description: API.purpose, deliverable: API.deliverable });
  assert.equal(invoke.request.max_cost_usd, '0.25'); assert.equal(invoke.request.capability, 'responses');
  assert.deepEqual(invoke.request.payload, { input: 'Review this excerpt', max_output_tokens: 2048, reasoning: { effort: 'low' } });
});

test('an admission refusal fails the job with the helper code and spends nothing', async t => {
  const f = fixture(t);
  const job = f.submit('BLOCK me');
  f.runner().start();
  const done = await f.until(job.id, ['completed', 'failed', 'needs_review']);
  assert.equal(done.status, 'failed'); assert.equal(done.error, 'HELPER_BLOCKED: grant_expired'); assert.equal(done.cost_usd, null);
});

test('known provider failures are failed; uncertain outcomes are left for review and never resubmitted', async t => {
  const f = fixture(t);
  const failed = f.submit('FAILED request'), uncertain = f.submit('UNCERTAIN request');
  f.runner().start();
  const a = await f.until(failed.id, ['completed', 'failed', 'needs_review']);
  assert.equal(a.status, 'failed'); assert.equal(a.error, 'HELPER_FAILED: provider_error'); assert.equal(a.cost_usd, '0.000010');
  const b = await f.until(uncertain.id, ['completed', 'failed', 'needs_review']);
  assert.equal(b.status, 'needs_review'); assert.equal(b.helper_job_id, 'hj-uncertain'); assert.match(b.error, /helper status uncertain/);
  await sleep(300);
  assert.equal(f.calls().filter(c => c.command === 'invoke' && c.request.external_request_id === uncertain.id).length, 1);
});

test('cancelling mid-request leaves the job for review, because the request may have been sent', async t => {
  const f = fixture(t);
  const job = f.submit('SLEEP while thinking');
  f.runner().start();
  const end = Date.now() + 10000;
  while (!f.calls().some(c => c.command === 'invoke')) { if (Date.now() > end) throw new Error('invoke never started'); await sleep(50); }
  f.call('job_cancel', { job_id: job.id, operation_id: randomUUID() });
  const done = await f.until(job.id, ['completed', 'failed', 'needs_review', 'cancelled']);
  assert.equal(done.status, 'needs_review'); assert.match(done.error, /^CANCELLED/);
});

test('after a restart, the helper ledger is asked; a recorded result is kept and nothing is resubmitted', async t => {
  const f = fixture(t);
  const job = f.submit('interrupted by a crash');
  // Simulate a crash mid-request: the row says running, and the helper has the completed result.
  f.store.db.prepare("UPDATE jobs SET status='running',started_at=? WHERE id=?").run(new Date().toISOString(), job.id);
  const artifact = path.join(f.helperDir, 'artifact.json');
  fs.writeFileSync(artifact, JSON.stringify({ status: 'completed', output: 'recovered answer' }));
  fs.writeFileSync(path.join(f.helperDir, 'lookup.json'), JSON.stringify({ status: 'completed', job_id: 'hj-r', artifact, cost_usd: '0.000200' }));
  f.runner().start();
  const done = await f.until(job.id, ['completed'], 5000);
  assert.equal(done.result, 'recovered answer'); assert.equal(done.cost_usd, '0.000200');
  assert.deepEqual(f.calls().map(c => c.command), ['lookup']);
});

test('API job validation: ceiling, purpose, deliverable, advice only, time limit', t => {
  const f = fixture(t);
  assert.throws(() => f.submit('x', { max_cost_usd: undefined }), /max_cost_usd/);
  assert.throws(() => f.submit('x', { max_cost_usd: '30' }), /max_cost_usd/);
  assert.throws(() => f.submit('x', { max_cost_usd: '-1' }), /max_cost_usd/);
  assert.throws(() => f.submit('x', { purpose: undefined }), /purpose/);
  assert.throws(() => f.submit('x', { deliverable: undefined }), /deliverable/);
  assert.throws(() => f.submit('x', { mode: 'edit' }), /advice only/);
  assert.throws(() => f.submit('x', { timeout_minutes: 30 }), /15 minutes/);
  assert.equal(f.submit('ok', { max_cost_usd: 0.5 }).options.max_cost_usd, '0.5');
});
