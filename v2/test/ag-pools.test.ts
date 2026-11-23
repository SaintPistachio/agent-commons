import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store, type Actor } from '../src/store.ts';
import { Runner } from '../src/runner.ts';
import { antigravity } from '../src/adapters/antigravity.ts';
import type { UsageObservation } from '../src/adapters/types.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-antigravity.mjs', import.meta.url));
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const FINAL = ['completed', 'failed', 'cancelled', 'needs_review'];
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function observations(gemini = 0, claude = 97, argon = 94): UsageObservation[] {
  const weekly = new Date(Date.now() + 3 * 86400000).toISOString();
  const hourly = new Date(Date.now() + 2 * 3600000).toISOString();
  return [
    { pool: 'Gemini Models', window: 'Weekly Limit Remaining', remaining_percent: gemini, resets_at: weekly },
    { pool: 'Gemini Models', window: 'Five Hour Limit Remaining', remaining_percent: 100, resets_at: hourly },
    { pool: 'Claude and GPT models', window: 'Weekly Limit Remaining', remaining_percent: claude, resets_at: weekly },
    { pool: 'Claude and GPT models', window: 'Five Hour Limit Remaining', remaining_percent: 100, resets_at: hourly },
    { pool: 'Gemini 4 Argon', window: 'Gemini 4 Argon Weekly Limit', remaining_percent: argon, resets_at: weekly },
  ];
}

function fixture(t: any) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-pools-'));
  const home = path.join(base, 'home'), root = path.join(base, 'repo');
  fs.mkdirSync(root, { recursive: true });
  const store = new Store(home);
  const actor: Actor = store.createActor('pool-reviewer', 'participant', 'pool-reviewer').actor;
  const call = (method: string, input: Record<string, unknown> = {}) => store.call(actor, method, input);
  const project = call('project_create', { name: 'Pools', root, operation_id: randomUUID() }).project;
  const runners: Runner[] = [];
  const submit = (prompt: string, extra: Record<string, unknown> = {}) =>
    call('job_submit', { project_id: project.id, route: 'antigravity', task: 'review', effort: 'high',
      prompt, operation_id: randomUUID(), ...extra }).job;
  const start = () => {
    const runner = new Runner(store, home, { antigravity: { file: process.execPath, prefix: [FAKE] }, tickMs: 25 });
    runners.push(runner);
    runner.start();
    return runner;
  };
  const until = async (id: string) => {
    const end = Date.now() + 15000;
    for (;;) {
      const job = call('job_status', { job_id: id }).job;
      if (FINAL.includes(job.status)) return job;
      if (Date.now() > end) throw new Error(`job stuck in ${job.status}`);
      await sleep(25);
    }
  };
  const args = (id: string): string[] => JSON.parse(fs.readFileSync(path.join(home, 'jobs', id, 'args.json'), 'utf8'));
  t.after(() => {
    for (const runner of runners) runner.stop();
    store.close();
    fs.rmSync(base, { recursive: true, force: true });
  });
  return { store, actor, home, submit, start, until, args };
}

test('schema v10 stores reply observations and the actual vendor family', async t => {
  const f = fixture(t);
  const job = f.submit('AG_USAGE');
  f.start();
  const done = await f.until(job.id);
  assert.equal(done.status, 'completed', done.error);
  assert.equal(done.options.effective_family, 'anthropic');
  const rows = f.store.usageFor('antigravity');
  assert.equal(rows.length, 5);
  const weekly = rows.find(row => row.pool === 'Gemini Models' && row.window === 'Weekly Limit Remaining')!;
  assert.equal(weekly.remaining_percent, 1);
  assert.equal(weekly.source, 'reply');
  assert.equal(weekly.stale, false);
  assert.ok(Number(f.store.serviceCounts().schema_version) >= 10);
  assert.equal(f.store.usageWindows().length, 5);
  assert.equal('usage_windows' in f.store.serviceCounts(), false, 'usage stays off the unauthenticated /health');
});

test('quota_before is used only when quota_after is absent', async t => {
  const f = fixture(t);
  const job = f.submit('BEFORE_USAGE');
  f.start();
  const done = await f.until(job.id);
  assert.equal(done.status, 'completed', done.error);
  assert.equal(done.options.effective_family, 'openai');
  assert.equal(f.store.usageFor('antigravity').length, 5);
  assert.deepEqual(antigravity.usage!({
    quota_before: [{ group: 'p', limit: 'w', remaining_percent: 90, resets_at: null }],
    quota_after: [],
  }), []);
});

test('old observations and passed resets read as unknown; older deliveries do not overwrite', t => {
  const f = fixture(t);
  const old = new Date(Date.now() - 7 * 3600000).toISOString();
  const recent = new Date(Date.now() - 60000).toISOString();
  const passed = new Date(Date.now() - 1000).toISOString();
  f.store.recordUsage('test-route', [
    { pool: 'old', window: 'week', remaining_percent: 70, resets_at: null, observed_at: old },
    { pool: 'reset', window: 'week', remaining_percent: 80, resets_at: passed, observed_at: recent },
    { pool: 'fresh', window: 'week', remaining_percent: 60, resets_at: null, observed_at: recent },
  ], 'operator');
  f.store.recordUsage('test-route', [
    { pool: 'fresh', window: 'week', remaining_percent: 99, resets_at: null, observed_at: old },
  ], 'reply');
  const rows = f.store.usageFor('test-route');
  for (const pool of ['old', 'reset']) {
    const row = rows.find(r => r.pool === pool)!;
    assert.equal(row.stale, true);
    assert.equal(row.remaining_percent, null);
  }
  const fresh = rows.find(r => r.pool === 'fresh')!;
  assert.equal(fresh.remaining_percent, 60);
  assert.equal(fresh.stale, false);
  assert.equal(fresh.source, 'operator');
});

test('a review at medium effort runs at the nearest validated effort above it (high), recorded on the job', async t => {
  const f = fixture(t);
  f.store.recordUsage('antigravity', observations(), 'operator');
  const job = f.submit('review at medium effort', { effort: 'medium' });
  f.start();
  const done = await f.until(job.id);
  assert.equal(done.status, 'completed', done.error);
  const args = f.args(job.id);
  assert.equal(args[args.indexOf('-Effort') + 1], 'high');
  assert.equal(args[args.indexOf('-ModelFamily') + 1], 'claude-opus-5-5');
  assert.deepEqual(done.options.ag_effort_fit, { requested: 'medium', used: 'high', reason: 'no validated review model at medium' });
});

test('without consumption evidence, exhausted Gemini allowance still closes seed-dependent Argon', async t => {
  const f = fixture(t);
  f.store.recordUsage('antigravity', observations(), 'operator');
  const job = f.submit('review with scarce Gemini allowance');
  f.start();
  const done = await f.until(job.id);
  assert.equal(done.status, 'completed', done.error);
  const args = f.args(job.id);
  assert.equal(args[args.indexOf('-ModelFamily') + 1], 'claude-opus-5-5');
  assert.equal(done.options.ag_steer.family, 'claude-opus-5-5');
  assert.deepEqual(done.options.ag_steer.pools, ['Claude and GPT models']);
});

test('without observations the adapter leaves selection to the helper', async t => {
  const f = fixture(t);
  const job = f.submit('helper decides');
  f.start();
  const done = await f.until(job.id);
  assert.equal(done.status, 'completed', done.error);
  assert.equal(f.args(job.id).includes('-ModelFamily'), false);
  assert.equal(done.options.ag_steer, undefined);
});

test('stale observations do not steer or pretend that allowance refilled', async t => {
  const f = fixture(t);
  f.store.recordUsage('antigravity', observations(0, 0, 0).map(row => ({
    ...row, observed_at: new Date(Date.now() - 7 * 3600000).toISOString(),
  })), 'operator');
  const job = f.submit('stale allowance');
  f.start();
  const done = await f.until(job.id);
  assert.equal(done.status, 'completed', done.error);
  assert.equal(f.args(job.id).includes('-ModelFamily'), false);
});

test('all closed families fail before spawning a helper', async t => {
  const f = fixture(t);
  f.store.recordUsage('antigravity', observations(0, 0, 0), 'operator');
  const job = f.submit('no open pool');
  f.start();
  const done = await f.until(job.id);
  assert.equal(done.status, 'failed');
  assert.equal(done.error, 'AG_NO_OPEN_POOL');
  assert.equal(fs.existsSync(path.join(f.home, 'jobs', job.id, 'args.json')), false);
});

test('the next known reset precedes the seed preference among capable open families', async t => {
  const f = fixture(t);
  const rows = observations(70, 80, 90).map(row => ({
    ...row,
    resets_at: new Date(Date.now() + (row.pool === 'Gemini 4 Argon' ? 1 : row.pool === 'Gemini Models' ? 3 : 4) * 3600000).toISOString(),
  }));
  f.store.recordUsage('antigravity', rows, 'operator');
  const job = f.submit('use the pool resetting soonest');
  f.start();
  const done = await f.until(job.id);
  assert.equal(done.status, 'completed', done.error);
  const args = f.args(job.id);
  assert.equal(args[args.indexOf('-ModelFamily') + 1], 'gemini-4-argon');
});

test('an explicit model or family is not silently replaced', async t => {
  const f = fixture(t);
  f.store.recordUsage('antigravity', observations(), 'operator');
  const model = f.submit('explicit model', { model: 'gemini-4-argon-high' });
  const family = f.submit('explicit family', { model_family: 'gemini-4-argon' });
  f.start();
  assert.equal((await f.until(model.id)).status, 'completed');
  assert.equal(f.args(model.id).includes('-ModelFamily'), false);
  assert.equal((await f.until(family.id)).status, 'completed');
  const args = f.args(family.id);
  assert.equal(args[args.indexOf('-ModelFamily') + 1], 'gemini-4-argon');
});

test('an anthropic review target excludes Claude even when it is the preferred family', async t => {
  const f = fixture(t);
  f.store.setActorTags(f.actor.id, 'anthropic', null);
  f.store.recordUsage('antigravity', observations(80, 97, 94), 'operator');
  const job = f.submit('independent review');
  f.store.annotateJob(job.id, { review_for: f.actor.id });
  f.start();
  const done = await f.until(job.id);
  assert.equal(done.status, 'completed', done.error);
  const args = f.args(job.id);
  assert.equal(args[args.indexOf('-ModelFamily') + 1], 'gemini-4-neon');
});

test('only Claude open is not an independent pool for an anthropic review target', async t => {
  const f = fixture(t);
  f.store.setActorTags(f.actor.id, 'anthropic', null);
  f.store.recordUsage('antigravity', observations(0, 97, 0), 'operator');
  const job = f.submit('independent review unavailable');
  f.store.annotateJob(job.id, { review_for: f.actor.id });
  f.start();
  const done = await f.until(job.id);
  assert.equal(done.status, 'failed');
  assert.equal(done.error, 'AG_NO_INDEPENDENT_POOL');
  assert.equal(fs.existsSync(path.join(f.home, 'jobs', job.id, 'args.json')), false);
});

test('an explicit Claude family cannot bypass review independence', async t => {
  const f = fixture(t);
  f.store.setActorTags(f.actor.id, 'anthropic', null);
  const job = f.submit('explicit but not independent', { model_family: 'claude-opus-5-5' });
  f.store.annotateJob(job.id, { review_for: f.actor.id });
  f.start();
  const done = await f.until(job.id);
  assert.equal(done.status, 'failed');
  assert.equal(done.error, 'AG_NO_INDEPENDENT_POOL');
});

test('pool exhaustion records zero without cooling a route that has another open pool', async t => {
  const f = fixture(t);
  const job = f.submit('POOL_QUOTA');
  f.start();
  const done = await f.until(job.id);
  assert.equal(done.status, 'failed');
  assert.match(done.error, /^AG_POOL_EXHAUSTED:/);
  assert.equal(f.store.usageFor('antigravity').find(row =>
    row.pool === 'Gemini Models' && row.window === 'Weekly Limit Remaining')!.remaining_percent, 0);
  assert.equal(f.store.platformState('antigravity')?.cooldown_until ?? null, null);
});

test('a route cooldown is requested only when all validated pools are closed', async t => {
  const f = fixture(t);
  const job = f.submit('ALL_QUOTA');
  f.start();
  const done = await f.until(job.id);
  assert.equal(done.status, 'failed');
  assert.match(done.error, /^QUOTA_EXHAUSTED:/);
  assert.ok(f.store.platformState('antigravity')?.cooldown_until);
});

test('NO_ELIGIBLE_MODEL is a model-selection gate before any run; a reply with run evidence still goes to review', async t => {
  const f = fixture(t);
  const safe = f.submit('NO_MODEL');
  const bare = f.submit('NO_MODEL_UNKNOWN');  // the real helper's reply: status, error_code and error only
  const contradictory = f.submit('NO_MODEL_SUBMITTED');
  f.start();
  for (const job of [safe, bare]) {
    const done = await f.until(job.id);
    assert.equal(done.status, 'failed', done.error);
    assert.equal(done.error, 'HELPER_BLOCKED: NO_ELIGIBLE_MODEL');
  }
  const done = await f.until(contradictory.id);
  assert.equal(done.status, 'needs_review');
  assert.match(done.error, /never replayed/);
});

test('usage-set writes a validated operator observation', t => {
  const f = fixture(t);
  const reset = new Date(Date.now() + 86400000).toISOString();
  const out = execFileSync(process.execPath, [
    CLI, 'usage-set', '--home', f.home, '--route', 'antigravity',
    '--pool', 'Gemini Models', '--window', 'Weekly Limit Remaining',
    '--percent', '1', '--resets-at', reset,
  ], { encoding: 'utf8' });
  assert.match(out, /operator/);
  const row = f.store.usageFor('antigravity')[0];
  assert.equal(row.pool, 'Gemini Models');
  assert.equal(row.remaining_percent, 1);
  assert.equal(row.resets_at, reset);
  assert.equal(row.source, 'operator');
  assert.equal(row.stale, false);
  assert.throws(() => execFileSync(process.execPath, [
    CLI, 'usage-set', '--home', f.home, '--route', 'antigravity',
    '--pool', 'bad', '--window', 'week', '--percent', '101',
  ], { encoding: 'utf8', stdio: 'pipe' }));
  assert.equal(f.store.usageFor('antigravity').length, 1);
});
