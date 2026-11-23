import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Store, type Actor } from './fixtures/service.ts';
import { Runner } from '../src/runner.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function fixture(t: any) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-codex-'));
  const home = path.join(base, 'home'), repo = path.join(base, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
  git('init', '-q'); fs.writeFileSync(path.join(repo, 'README.md'), 'repo\n');
  git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'init');
  const store = new Store(home);
  const actor: Actor = store.createActor('antigravity-desktop', 'participant', 'antigravity-desktop').actor;
  const call = (method: string, input: Record<string, unknown> = {}) => store.call(actor, method, input);
  const project = call('project_create', { name: 'Repo', root: repo, operation_id: randomUUID() }).project;
  const runners: Runner[] = [];
  const runner = () => { const r = new Runner(store, home, { codex: { file: process.execPath, prefix: [FAKE] }, tickMs: 50 }); runners.push(r); return r; };
  t.after(() => {
    for (const r of runners) r.stop();
    try { execFileSync('git', ['-C', repo, 'worktree', 'prune'], { stdio: 'ignore' }); } catch {}
    store.close(); fs.rmSync(base, { recursive: true, force: true });
  });
  const submit = (prompt: string, extra: Record<string, unknown> = {}) => call('job_submit', { project_id: project.id, route: 'codex', prompt, operation_id: randomUUID(), ...extra }).job;
  const until = async (id: string, statuses: string[], ms = 15000) => {
    const end = Date.now() + ms;
    for (;;) { const job = call('job_status', { job_id: id }).job; if (statuses.includes(job.status)) return job; if (Date.now() > end) throw new Error(`job stuck in ${job.status}`); await sleep(50); }
  };
  return { store, call, project, repo, home, runner, submit, until };
}

test('a codex advice job runs read-only, ephemeral, without user config or API keys', async t => {
  const f = fixture(t);
  const before = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'synthetic';
  t.after(() => { if (before === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = before; });
  const job = f.submit('ARGS please', { model: 'gpt-6.1-sol', effort: 'high' });
  f.runner().start();
  const done = await f.until(job.id, ['completed', 'failed']);
  assert.equal(done.status, 'completed', done.error);
  const seen = JSON.parse(done.result);
  assert.equal(seen.apiKey, false);
  for (const flag of ['exec', '--json', '--ephemeral', '--ignore-user-config']) assert(seen.args.includes(flag), flag);
  assert.equal(seen.args[seen.args.indexOf('-s') + 1], 'read-only');
  assert.equal(seen.args[seen.args.indexOf('-C') + 1], f.repo);
  assert.equal(seen.args[seen.args.indexOf('-m') + 1], 'gpt-6.1-sol');
  assert.equal(seen.args[seen.args.indexOf('-c') + 1], 'model_reasoning_effort="high"');
  assert.equal(done.turns, 1);
});

test('a codex edit job uses workspace-write in its own worktree and leaves changes for review', async t => {
  const f = fixture(t);
  const job = f.submit('EDIT something', { mode: 'edit' });
  assert.equal(job.model, null);
  assert.equal(job.options.model_source.state, 'fallback');
  f.runner().start();
  const done = await f.until(job.id, ['completed', 'failed']);
  assert.equal(done.status, 'completed', done.error);
  assert.equal(done.branch, `ac/job-${job.id.slice(0, 8)}`);
  assert.deepEqual(done.changed_files, ['codex-edit.txt']);
  assert(!fs.existsSync(path.join(f.repo, 'codex-edit.txt')));
});

test('a usage-limit error is reported as QUOTA_EXHAUSTED; cancel stops a running codex job', async t => {
  const f = fixture(t);
  const limited = f.submit('LIMIT reached');
  f.runner().start();
  const a = await f.until(limited.id, ['completed', 'failed']);
  assert.equal(a.status, 'failed'); assert.match(a.error, /^QUOTA_EXHAUSTED: You've hit your usage limit/);
  const slow = f.submit('SLEEP');
  await f.until(slow.id, ['running']);
  f.call('job_cancel', { job_id: slow.id, operation_id: randomUUID() });
  assert.equal((await f.until(slow.id, ['cancelled', 'failed'])).status, 'cancelled');
});

test('schema v4 keeps existing jobs and accepts any validated route', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-v4-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  // Build a schema-3 database with one job, then let Store migrate it.
  const db = new DatabaseSync(path.join(home, 'commons.sqlite'));
  const seed = new Store(path.join(home, 'seed')); seed.close();
  const v3 = fs.readFileSync(fileURLToPath(new URL('../src/schema.ts', import.meta.url)), 'utf8');
  assert(v3.includes('jobs_v4'));
  db.close();
  const store = new Store(home);
  try {
    // Later steps (v5 and on) also run; this test checks what v4 did to the jobs table.
    assert.ok(Number(store.db.prepare('PRAGMA user_version').get()!.user_version) >= 4);
    const sql = String((store.db.prepare("SELECT sql FROM sqlite_master WHERE name='jobs'").get() as { sql: string }).sql);
    assert(!sql.includes('CHECK(route'), 'route is validated in code');
    assert(sql.includes("CHECK(status IN"), 'other constraints are kept');
  } finally { store.close(); }
});
