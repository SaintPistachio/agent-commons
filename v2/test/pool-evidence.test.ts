import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from './fixtures/service.ts';
import { Runner } from '../src/runner.ts';
import { antigravity } from '../src/adapters/antigravity.ts';
import type { Consumption, UsageObservation } from '../src/adapters/types.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const FAKE = fileURLToPath(new URL('./fixtures/fake-antigravity.mjs', import.meta.url));
const GEMINI = 'Gemini Models';
const ARGON = 'Gemini 4 Argon';
const SHARED = 'Claude and GPT models';
const WEEK = 'Weekly Limit Remaining';
const HOURS = 'Five Hour Limit Remaining';
const ARGON_WEEK = 'Gemini 4 Argon Weekly Limit';
const FAMILY = 'gemini-4-argon';
const FLASH = 'gemini-3.8-flash';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function fixture(t: any) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-evidence-'));
  const home = path.join(base, 'home'), root = path.join(base, 'repo');
  fs.mkdirSync(root, { recursive: true });
  const store = new Store(home);
  const actor = store.createActor('evidence-reviewer', 'participant', 'evidence-reviewer').actor;
  const call = (method: string, input: Record<string, unknown> = {}) => store.call(actor, method, input);
  const project = call('project_create', { name: 'Evidence', root, operation_id: randomUUID() }).project;
  const runners: Runner[] = [];
  const submit = (prompt = 'use recorded evidence', task = 'review', effort = 'high') =>
    call('job_submit', { project_id: project.id, route: 'antigravity', task, effort,
      prompt, operation_id: randomUUID() }).job;
  const start = () => {
    const runner = new Runner(store, home, { antigravity: { file: process.execPath, prefix: [FAKE] }, tickMs: 25 });
    runners.push(runner);
    runner.start();
  };
  const until = async (id: string) => {
    const end = Date.now() + 15000;
    for (;;) {
      const job = call('job_status', { job_id: id }).job;
      if (['completed', 'failed', 'cancelled', 'needs_review'].includes(job.status)) return job;
      if (Date.now() > end) throw new Error(`job stuck in ${job.status}`);
      await sleep(25);
    }
  };
  const cli = (...args: string[]) => execFileSync(process.execPath, [CLI, ...args, '--home', home], { encoding: 'utf8' });
  t.after(() => {
    for (const runner of runners) runner.stop();
    store.close();
    fs.rmSync(base, { recursive: true, force: true });
  });
  return { home, store, submit, start, until, cli };
}

/** The observed live pattern: Argon decreases, both Gemini Models windows remain unchanged. */
function argonReply(extra = false) {
  const weekly = new Date(Date.now() + 3 * 86400000).toISOString();
  const hourly = new Date(Date.now() + 2 * 3600000).toISOString();
  const before = [
    { group: GEMINI, limit: WEEK, remaining_percent: 1, resets_at: weekly },
    { group: GEMINI, limit: HOURS, remaining_percent: 100, resets_at: hourly },
    { group: SHARED, limit: WEEK, remaining_percent: 97, resets_at: weekly },
    { group: SHARED, limit: HOURS, remaining_percent: 100, resets_at: hourly },
    { group: ARGON, limit: ARGON_WEEK, remaining_percent: 91, resets_at: weekly },
  ];
  if (extra) before.push({ group: 'Observed Extra', limit: 'Daily', remaining_percent: 50, resets_at: weekly });
  return {
    status: 'SUCCESS', response: 'saved response', reported_model: 'gemini-4-argon-high',
    quota_before: before,
    quota_after: before.map(row => ({
      ...row,
      remaining_percent: row.group === ARGON || row.group === 'Observed Extra' ? row.remaining_percent - 1 : row.remaining_percent,
    })),
  };
}

/** Synthetic contradiction: Flash leaves both seed windows unchanged but consumes the Argon pool. */
function flashConsumption(): Consumption {
  return antigravity.consumption!({ ...argonReply(), reported_model: `${FLASH}-medium` })!;
}

function quota(gemini: number, shared: number, argon: number): UsageObservation[] {
  const weekly = new Date(Date.now() + 3 * 86400000).toISOString();
  const hourly = new Date(Date.now() + 2 * 3600000).toISOString();
  return [
    { pool: GEMINI, window: WEEK, remaining_percent: gemini, resets_at: weekly },
    { pool: GEMINI, window: HOURS, remaining_percent: 100, resets_at: hourly },
    { pool: SHARED, window: WEEK, remaining_percent: shared, resets_at: weekly },
    { pool: SHARED, window: HOURS, remaining_percent: 100, resets_at: hourly },
    { pool: ARGON, window: ARGON_WEEK, remaining_percent: argon, resets_at: weekly },
  ];
}

function record(store: Store, jobId: string, result: Consumption = antigravity.consumption!(argonReply())!) {
  return store.recordConsumption('antigravity', result.family, result.rows, jobId);
}

test('consumption compares both snapshots, preserves unchanged windows, and identifies the model family', () => {
  const result = antigravity.consumption!(argonReply())!;
  assert.equal(result.family, FAMILY);
  assert.equal(result.rows.length, 5);
  assert.deepEqual(result.rows.filter(row => row.consumed), [
    { pool: ARGON, window: ARGON_WEEK, consumed: true },
  ]);
  assert.equal(result.rows.find(row => row.pool === GEMINI && row.window === WEEK)!.consumed, false);
  assert.equal(antigravity.consumption!({ reported_model: 'gemini-4-argon-high', quota_before: [] }), undefined);
  assert.equal(antigravity.consumption!({ reported_model: 'gemini-4-argon-high', quota_after: [] }), undefined);
});

test('consumption skips refills, changed reset timestamps, absent windows, nulls, and invalid values', () => {
  const reset = new Date(Date.now() + 86400000).toISOString();
  const later = new Date(Date.now() + 2 * 86400000).toISOString();
  const row = (limit: string, remaining_percent: number | null, resets_at: string | null = reset) =>
    ({ group: 'pool', limit, remaining_percent, resets_at });
  const result = antigravity.consumption!({
    selected_model: 'claude-opus-5-5-high',
    quota_before: [
      row('decrease', 50), row('unchanged', 50), row('refill', 50),
      row('reset', 50), row('new-reset', 50, null), row('before-only', 50),
      row('unknown', null), row('invalid', 101),
    ],
    quota_after: [
      row('decrease', 49), row('unchanged', 50), row('refill', 51),
      row('reset', 49, later), row('new-reset', 49), row('after-only', 49),
      row('unknown', 49), row('invalid', 49),
    ],
  })!;
  assert.equal(result.family, 'claude-opus-5-5');
  assert.deepEqual(result.rows, [
    { pool: 'pool', window: 'decrease', consumed: true },
    { pool: 'pool', window: 'unchanged', consumed: false },
  ]);
});

test('recordConsumption counts per window, deduplicates jobs, and retains comparable runs', t => {
  const f = fixture(t);
  assert.ok(Number(f.store.serviceCounts().schema_version) >= 13);
  assert.equal(record(f.store, 'run-1'), true);
  assert.equal(record(f.store, 'run-1'), false);
  assert.equal(record(f.store, 'run-2'), true);
  let evidence = f.store.poolEvidence('antigravity');
  const argon = evidence.find(row => row.pool === ARGON)!;
  assert.equal(argon.runs, 2);
  assert.equal(argon.consumed_runs, 2);
  assert.equal(argon.last_job_id, 'run-2');
  assert.ok(Number.isFinite(Date.parse(argon.last_seen_at)));
  const gemini = evidence.find(row => row.pool === GEMINI && row.window === WEEK)!;
  assert.equal(gemini.runs, 2);
  assert.equal(gemini.consumed_runs, 0);
  assert.equal(f.store.consumptionRuns('antigravity').length, 2);
  assert.equal(f.store.consumptionRuns('antigravity')[0].rows.length, 5);
  assert.equal(f.store.recordConsumption('other-route', FAMILY, [{ pool: ARGON, window: ARGON_WEEK, consumed: true }], 'run-1'), true);
  assert.equal(f.store.poolEvidence('other-route')[0].runs, 1);
  assert.equal(f.store.recordConsumption('antigravity', FAMILY, [], 'empty'), false);
  assert.equal(f.store.recordConsumption('antigravity', FAMILY, [
    { pool: ARGON, window: ARGON_WEEK, consumed: false },
    { pool: ARGON, window: ARGON_WEEK, consumed: true },
  ], 'run-3'), true);
  evidence = f.store.poolEvidence('antigravity');
  assert.equal(evidence.find(row => row.pool === ARGON)!.runs, 3);
  assert.equal(evidence.find(row => row.pool === ARGON)!.consumed_runs, 3);
});

test('one percent is open and zero percent is closed', async t => {
  const f = fixture(t);
  f.store.recordUsage('antigravity', quota(1, 1, 1), 'operator');
  const open = f.submit('one percent remains');
  f.start();
  const done = await f.until(open.id);
  assert.equal(done.status, 'completed', done.error);
  assert.ok(done.options.ag_steer.requirements.every((row: { basis: string }) => row.basis === 'seed-unverified'));
  f.store.recordUsage('antigravity', quota(0, 0, 0), 'operator');
  const closed = await f.until(f.submit('zero percent remains').id);
  assert.equal(closed.status, 'failed');
  assert.equal(closed.error, 'AG_NO_OPEN_POOL');
});

test('one contradicting run retains the seed requirement; two let Flash use its observed pool', async t => {
  const f = fixture(t);
  const parsed = flashConsumption();
  record(f.store, 'evidence-1', parsed);
  f.store.recordUsage('antigravity', quota(0, 0, 90), 'operator');
  // Medium explain makes Flash eligible without making Argon a competing profile.
  const first = f.submit('use recorded evidence', 'explain', 'medium');
  f.start();
  const blocked = await f.until(first.id);
  assert.equal(blocked.status, 'failed');
  assert.equal(blocked.error, 'AG_NO_OPEN_POOL');
  record(f.store, 'evidence-2', parsed);
  const next = f.submit('use recorded evidence', 'explain', 'medium');
  const done = await f.until(next.id);
  assert.equal(done.status, 'completed', done.error);
  assert.equal(done.options.ag_steer.family, FLASH);
  assert.deepEqual(done.options.ag_steer.pools, [ARGON]);
  const requirements = done.options.ag_steer.requirements;
  const ignored = requirements.find((row: { pool: string }) => row.pool === GEMINI);
  assert.equal(ignored.required, false);
  assert.equal(ignored.basis, 'evidence');
  assert.deepEqual([...ignored.windows].sort(), [HOURS, WEEK]);
  assert.equal(ignored.reason, 'not consumed (verified by 2 runs)');
  const required = requirements.find((row: { pool: string }) => row.pool === ARGON);
  assert.equal(required.required, true);
  assert.equal(required.basis, 'evidence');
  const args = JSON.parse(fs.readFileSync(path.join(f.home, 'jobs', next.id, 'args.json'), 'utf8'));
  assert.equal(args[args.indexOf('-ModelFamily') + 1], FLASH);
});

test('unchanged-only runs cannot contradict the seed, nor can missing window comparisons', async t => {
  const f = fixture(t);
  const parsed = flashConsumption();
  for (let n = 0; n < 2; n++) record(f.store, `unchanged-${n}`, {
    family: FLASH, rows: parsed.rows.map(row => ({ ...row, consumed: false })),
  });
  for (let n = 0; n < 2; n++) record(f.store, `partial-${n}`, {
    family: FLASH, rows: parsed.rows.filter(row => row.pool !== GEMINI || row.window !== HOURS),
  });
  f.store.recordUsage('antigravity', quota(0, 0, 90), 'operator');
  const job = f.submit('use recorded evidence', 'explain', 'medium');
  f.start();
  const done = await f.until(job.id);
  assert.equal(done.status, 'failed');
  assert.equal(done.error, 'AG_NO_OPEN_POOL');
});

test('a consumed pool absent from the seed becomes required', async t => {
  const f = fixture(t);
  const parsed = antigravity.consumption!(argonReply(true))!;
  record(f.store, 'extra-1', parsed);
  record(f.store, 'extra-2', parsed);
  const extra: UsageObservation = {
    pool: 'Observed Extra', window: 'Daily', remaining_percent: 0,
    resets_at: new Date(Date.now() + 86400000).toISOString(),
  };
  f.store.recordUsage('antigravity', [...quota(0, 0, 90), extra], 'operator');
  const blocked = f.submit();
  f.start();
  assert.equal((await f.until(blocked.id)).error, 'AG_NO_OPEN_POOL');
  f.store.recordUsage('antigravity', [{ ...extra, remaining_percent: 1 }], 'operator');
  const done = await f.until(f.submit().id);
  assert.equal(done.status, 'completed', done.error);
  const requirement = done.options.ag_steer.requirements.find((row: { pool: string }) => row.pool === 'Observed Extra');
  assert.equal(requirement.required, true);
  assert.equal(requirement.basis, 'evidence');
  assert.deepEqual(requirement.windows, ['Daily']);
});

test('a single observed consumption prevents ignoring a seed pool', async t => {
  const f = fixture(t);
  record(f.store, 'stable-1');
  record(f.store, 'stable-2');
  const parsed = antigravity.consumption!(argonReply())!;
  record(f.store, 'consumed-once', {
    family: FAMILY,
    rows: parsed.rows.map(row => row.pool === GEMINI && row.window === WEEK ? { ...row, consumed: true } : row),
  });
  f.store.recordUsage('antigravity', quota(0, 0, 90), 'operator');
  const job = f.submit();
  f.start();
  const done = await f.until(job.id);
  assert.equal(done.error, 'AG_NO_OPEN_POOL');
});

test('status reports family pool counts and warns when evidence contradicts the helper seed', t => {
  const f = fixture(t);
  const parsed = flashConsumption();
  record(f.store, 'status-1', parsed);
  const unverified = f.cli('status');
  assert.match(unverified, /gemini-3\.8-flash \/ Gemini Models: not consumed \(1 runs; unverified\)/);
  assert.doesNotMatch(unverified, /WARN gemini-3\.8-flash/);
  record(f.store, 'status-2', parsed);
  const output = f.cli('status');
  assert.match(output, /gemini-3\.8-flash \/ Gemini 4 Argon: consumed \(2\/2 runs\)/);
  assert.match(output, /gemini-3\.8-flash \/ Gemini Models: not consumed \(verified by 2 runs\)/);
  assert.match(output, /WARN gemini-3\.8-flash: helper seed requires Gemini Models but 2 runs show it is not consumed/);
  assert.match(output, /the helper itself may still refuse gemini-3\.8-flash when Gemini Models reaches 0%/);
});

test('backfill reads only finished jobs, is idempotent, and shares live-recording deduplication', t => {
  const f = fixture(t);
  const saved = f.submit('previously finished');
  const alreadyCounted = f.submit('already recorded live');
  const queued = f.submit('not finished');
  for (const job of [saved, alreadyCounted, queued]) {
    const dir = path.join(f.home, 'jobs', job.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'stdout.json'), JSON.stringify(argonReply()), 'utf8');
  }
  for (const job of [saved, alreadyCounted]) f.store.updateJob(job.id, {
    status: 'completed', result: 'saved response', finished_at: new Date().toISOString(),
  });
  record(f.store, alreadyCounted.id);
  const first = f.cli('pool-evidence', '--backfill');
  assert.match(first, /"recorded_jobs":\s*1/);
  assert.equal(f.store.poolEvidence('antigravity').find(row => row.pool === ARGON)!.runs, 2);
  assert.equal(f.store.consumptionRuns('antigravity').length, 2);
  assert.equal(f.store.jobRecord(queued.id)!.status, 'queued');
  const second = f.cli('pool-evidence', '--backfill');
  assert.match(second, /"recorded_jobs":\s*0/);
  assert.equal(f.store.poolEvidence('antigravity').find(row => row.pool === ARGON)!.runs, 2);
  assert.equal(record(f.store, saved.id), false);
});

test('runner records consumption from a completed helper reply without replaying it', async t => {
  const f = fixture(t);
  // Use a saved script as a fake helper so both snapshots are deterministic.
  const script = path.join(f.home, 'reply.mjs');
  fs.writeFileSync(script, `process.stdout.write(${JSON.stringify(JSON.stringify(argonReply()))});`, 'utf8');
  const runner = new Runner(f.store, f.home, { antigravity: { file: process.execPath, prefix: [script] }, tickMs: 25 });
  t.after(() => runner.stop());
  const job = f.submit();
  runner.start();
  const done = await f.until(job.id);
  assert.equal(done.status, 'completed', done.error);
  assert.equal(f.store.poolEvidence('antigravity').find(row => row.pool === ARGON)!.consumed_runs, 1);
  assert.equal(f.store.consumptionRuns('antigravity')[0].job_id, job.id);
  assert.match(f.cli('pool-evidence', '--backfill'), /"recorded_jobs":\s*0/);
});
