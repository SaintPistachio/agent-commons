import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store, type Actor } from './fixtures/service.ts';
import { Runner } from '../src/runner.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function fixture(t: any) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-run-'));
  const home = path.join(base, 'home'), repo = path.join(base, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
  git('init', '-q'); fs.writeFileSync(path.join(repo, 'README.md'), 'repo\n');
  git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'init');
  const store = new Store(home);
  const actor: Actor = store.createActor('claude-desktop', 'participant', 'claude-desktop').actor;
  const call = (method: string, input: Record<string, unknown> = {}) => store.call(actor, method, input);
  const project = call('project_create', { name: 'Repo', root: repo, operation_id: randomUUID() }).project;
  const runners: Runner[] = [];
  const runner = () => { const r = new Runner(store, home, { claude: { file: process.execPath, prefix: [FAKE] }, tickMs: 50 }); runners.push(r); return r; };
  t.after(() => {
    for (const r of runners) r.stop();
    try { execFileSync('git', ['-C', repo, 'worktree', 'prune'], { stdio: 'ignore' }); } catch {}
    store.close(); fs.rmSync(base, { recursive: true, force: true });
  });
  const submit = (prompt: string, extra: Record<string, unknown> = {}) => call('job_submit', { project_id: project.id, route: 'claude', prompt, operation_id: randomUUID(), ...extra }).job;
  const until = async (id: string, statuses: string[], ms = 15000) => {
    const end = Date.now() + ms;
    for (;;) { const job = call('job_status', { job_id: id }).job; if (statuses.includes(job.status)) return job; if (Date.now() > end) throw new Error(`job stuck in ${job.status}`); await sleep(50); }
  };
  return { store, call, project, repo, home, runner, submit, until };
}

test('an advice job runs read-only in the project root and records the result', async t => {
  const f = fixture(t);
  const job = f.submit('Summarize the README');
  assert.equal(job.status, 'queued');
  f.runner().start();
  const done = await f.until(job.id, ['completed', 'failed']);
  assert.equal(done.status, 'completed', done.error);
  assert.equal(done.result, 'echo: Summarize the README');
  assert.equal(done.turns, 1); assert.equal(done.workdir, f.repo); assert.deepEqual(done.changed_files, []);
  assert(fs.existsSync(path.join(f.home, 'jobs', job.id, 'stdout.json')));
  assert.equal(f.call('project_resume', { project_id: f.project.id }).jobs.length, 0, 'finished jobs leave the briefing');
});

test('the CLI gets the prompt over stdin, read-only tools and no API credentials', async t => {
  const f = fixture(t);
  const before = process.env.ANTHROPIC_API_KEY; process.env.ANTHROPIC_API_KEY = 'sk-should-not-leak';
  t.after(() => { if (before === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = before; });
  const job = f.submit('ENV check', { model: 'opus' });
  f.runner().start();
  const done = await f.until(job.id, ['completed', 'failed']);
  const seen = JSON.parse(done.result);
  assert.equal(seen.apiKey, false); assert.equal(seen.jobId, job.id);
  assert.deepEqual(seen.args.slice(seen.args.indexOf('--tools'), seen.args.indexOf('--tools') + 2), ['--tools', 'Read,Grep,Glob']);
  assert.deepEqual(seen.args.slice(seen.args.indexOf('--allowedTools') + 1, seen.args.indexOf('--disallowedTools')), ['Read', 'Grep', 'Glob']);
  assert.deepEqual(seen.args.slice(seen.args.indexOf('--disallowedTools') + 1, seen.args.indexOf('--disallowedTools') + 6), ['Bash', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
  assert.equal(seen.args[seen.args.indexOf('--model') + 1], 'opus');
  assert.equal(seen.args[seen.args.indexOf('--permission-mode') + 1], 'default');
});

test('an edit job works in its own worktree and branch and leaves changes uncommitted', async t => {
  const f = fixture(t);
  const job = f.submit('EDIT a file', { mode: 'edit' });
  f.runner().start();
  const done = await f.until(job.id, ['completed', 'failed']);
  assert.equal(done.status, 'completed', done.error);
  assert.equal(done.branch, `ac/job-${job.id.slice(0, 8)}`);
  assert.notEqual(done.workdir, f.repo);
  assert(fs.existsSync(path.join(done.workdir, 'from-job.txt')), 'the change is in the worktree');
  assert(!fs.existsSync(path.join(f.repo, 'from-job.txt')), 'the project checkout is untouched');
  assert.deepEqual(done.changed_files, ['from-job.txt']);
  assert.match(done.base_revision, /^[0-9a-f]{40}$/);
});

test('failures, unparseable output and timeouts are recorded as failed', async t => {
  const f = fixture(t);
  const failed = f.submit('FAIL please'), garbage = f.submit('GARBAGE out'), slow = f.submit('SLEEP forever', { timeout_minutes: 1 });
  // Shorten the timeout for the test by editing the row before the runner claims it.
  f.store.db.prepare('UPDATE jobs SET timeout_ms=300 WHERE id=?').run(slow.id);
  f.runner().start();
  assert.equal((await f.until(failed.id, ['failed', 'completed'])).error, 'CLI_ERROR: error_during_execution');
  assert.match((await f.until(garbage.id, ['failed', 'completed'])).error, /^NO_RESULT: fatal: not json/);
  assert.equal((await f.until(slow.id, ['failed', 'completed'])).error, 'TIMEOUT');
});

test('cancel stops a queued job before it starts and a running job mid-way', async t => {
  const f = fixture(t);
  const running = f.submit('SLEEP a while'), queued = f.submit('never starts');
  f.runner().start();
  await f.until(running.id, ['running']);
  assert.equal(f.call('job_status', { job_id: queued.id }).job.status, 'queued', 'one claude job at a time');
  assert.equal(f.call('job_cancel', { job_id: queued.id, operation_id: randomUUID() }).job.status, 'cancelled');
  f.call('job_cancel', { job_id: running.id, operation_id: randomUUID() });
  const stopped = await f.until(running.id, ['cancelled', 'failed']);
  assert.equal(stopped.status, 'cancelled');
  assert.throws(() => f.call('job_cancel', { job_id: running.id, operation_id: randomUUID() }), /JOB_FINISHED|job is cancelled/);
});

test('a job running when the service stopped becomes needs_review and is never re-run', async t => {
  const f = fixture(t);
  const job = f.submit('SLEEP until the service dies');
  const first = f.runner(); first.start();
  await f.until(job.id, ['running']);
  // Simulate a crash: the old runner vanishes without recording anything.
  f.store.db.prepare("UPDATE jobs SET status='running' WHERE id=?").run(job.id);
  const pid = f.call('job_status', { job_id: job.id }).job.pid;
  assert(pid > 0);
  (first as any).active.clear();
  f.runner().start();
  const reviewed = await f.until(job.id, ['needs_review']);
  assert.equal(reviewed.error, 'SERVICE_STOPPED_DURING_JOB');
  await sleep(300);
  assert.equal(f.call('job_status', { job_id: job.id }).job.status, 'needs_review');
  assert.equal(f.call('project_resume', { project_id: f.project.id }).jobs[0].id, job.id, 'needs_review jobs stay in the briefing');
});

test('job_submit validates route, mode, timeout and replays by operation_id', t => {
  const f = fixture(t);
  assert.throws(() => f.submit('x', { route: 'nonexistent' }), /ROUTE_UNAVAILABLE|route must be/);
  assert.throws(() => f.submit('x', { mode: 'shell' }), /mode must be/);
  assert.throws(() => f.submit('x', { timeout_minutes: 0 }), /timeout_minutes/);
  const op = randomUUID();
  const a = f.call('job_submit', { project_id: f.project.id, route: 'claude', prompt: 'once', operation_id: op });
  const b = f.call('job_submit', { project_id: f.project.id, route: 'claude', prompt: 'once', operation_id: op });
  assert.equal(a.job.id, b.job.id);
  assert.equal(f.call('job_list', { project_id: f.project.id }).jobs.length, 1);
});
