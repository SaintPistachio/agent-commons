// Ops hardening checklist (Sections 1-5): graceful shutdown and backups, cleanup commands, quota cooldowns, uniform
// usage telemetry, central capability limits, air_wait disconnects, key stripping, context secret scanning, project
// archiving, actor families and the enriched /health.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { startServer, releaseInfo, protectFixtureHome } from './fixtures/service.ts';
import { Store, CommonsError, type Actor } from './fixtures/service.ts';
import { Runner } from '../src/runner.ts';
import { workerEnv, helperEnv } from '../src/adapters/shared.ts';
import { registerAdapter, unregisterAdapter } from '../src/adapters/registry.ts';
import { cooldownUntil } from '../src/cooldown.ts';
import { backupDatabase, restoreDatabase, dropJob, jobDiff, pruneHome, rotateLog } from '../src/ops.ts';
import { SCHEMA_VERSION } from '../src/schema.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const FAKE_AG = fileURLToPath(new URL('./fixtures/fake-antigravity.mjs', import.meta.url));
const FAKE_API = fileURLToPath(new URL('./fixtures/fake-openai-helper.mjs', import.meta.url));
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const code = (fn: () => unknown) => { try { fn(); } catch (error) { return (error as CommonsError).code; } throw new Error('expected a failure'); };

function fixture(t: any) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-ops-'));
  const home = path.join(base, 'home'), repo = path.join(base, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { stdio: 'ignore' });
  fs.writeFileSync(path.join(repo, 'README.md'), 'repo\n'); git('init', '-q'); git('add', '.'); git('commit', '-qm', 'init');
  const store = new Store(home);
  const created = store.createActor('claude-desktop', 'participant', 'claude-desktop');
  const operator = store.createActor('operator', 'operator', 'local-operator');
  const actor: Actor = created.actor;
  const call = (method: string, input: Record<string, unknown> = {}) => store.call(actor, method, input);
  const project = call('project_create', { name: 'Repo', root: repo, operation_id: randomUUID() }).project;
  const runners: Runner[] = [];
  t.after(() => {
    for (const r of runners) r.stop();
    try { execFileSync('git', ['-C', repo, 'worktree', 'prune'], { stdio: 'ignore' }); } catch {}
    try { store.close(); } catch {}
    fs.rmSync(base, { recursive: true, force: true });
  });
  const submit = (extra: Record<string, unknown>) => call('job_submit', { project_id: project.id, route: 'claude', prompt: 'x', operation_id: randomUUID(), ...extra }).job;
  const run = (options: Record<string, unknown> = {}) => { const r = new Runner(store, home, { claude: { file: process.execPath, prefix: [FAKE] }, tickMs: 50, ...options }); runners.push(r); r.start(); return r; };
  const until = async (id: string) => {
    for (let i = 0; i < 300; i++) { const job = store.jobRecord(id)!; if (['completed', 'failed', 'cancelled', 'needs_review'].includes(job.status)) return job; await sleep(50); }
    throw new Error('job did not finish');
  };
  const state = (route: string) => store.platformState(route);
  return { base, home, repo, store, actor, call, project, submit, run, until, state, token: created.token, operatorToken: operator.token };
}

test('1.1 shutdown: operator or runtime token only; pending air_wait answers closing=1; the database closes', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-stop-'));
  const home = path.join(base, 'data'), repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const seed = new Store(home);
  const participant = seed.createActor('claude-desktop', 'participant', 'claude-desktop').token;
  const operator = seed.createActor('operator', 'operator', 'local-operator').token;
  const actor = { id: 'claude-desktop', name: 'claude-desktop', role: 'participant' as const };
  seed.call(actor, 'project_create', { name: 'R', root: repo, operation_id: randomUUID() });
  const job = seed.call(actor, 'job_submit', { project_id: 'p1', route: 'claude', prompt: 'x', operation_id: randomUUID() }).job;
  seed.close();
  let stopped!: () => void; const shut = new Promise<void>(resolve => { stopped = resolve; });
  const running = await startServer(home, 0, false, { onShutdown: () => stopped() });
  const post = (token: string) => fetch(running.url + '/api/v1/shutdown', { method: 'POST', headers: { authorization: 'Bearer ' + token } });
  assert.equal((await post(participant)).status, 403);
  assert.equal((await post('nonsense')).status, 401);
  const runtime = JSON.parse(fs.readFileSync(path.join(home, 'runtime.json'), 'utf8'));
  assert.match(runtime.shutdown_token, /^[0-9a-f]{64}$/, 'a per-start shutdown token for cli.ts stop');
  const waiting = fetch(running.url + '/api/v1/call', { method: 'POST', headers: { authorization: 'Bearer ' + participant, 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'air_wait', input: { handles: job.id, wait_seconds: 30 } }) }).then(r => r.json());
  await sleep(300);
  assert.equal((await post(operator)).status, 200);
  assert.match((await waiting).result.air, /^@air1 wait n=1 done=0 closing=1/);
  await shut;
  assert.equal(running.store.db.isOpen, false, 'SQLite closed cleanly');
  assert.equal(fs.existsSync(path.join(home, 'runtime.json')), false);
});

test('1.1 backup copies the live database with the backup API and keeps the newest N', async t => {
  const f = fixture(t);
  const made = [];
  for (let i = 0; i < 3; i++) made.push((await backupDatabase(f.home, 2)).file);
  const left = fs.readdirSync(path.join(f.home, 'backups')).sort();
  assert.equal(left.length, 2); assert.deepEqual(left, made.slice(1).map(p => path.basename(p)).sort());
  const copy = new DatabaseSync(made[2], { readOnly: true });
  assert.equal((copy.prepare('PRAGMA integrity_check').get() as any).integrity_check, 'ok');
  assert.equal((copy.prepare('SELECT name FROM projects').get() as any).name, 'Repo');
  copy.close();
  fs.writeFileSync(path.join(f.home, 'backups', 'commons-schema5-before-x.sqlite'), 'manual');
  await backupDatabase(f.home, 1);
  assert.ok(fs.existsSync(path.join(f.home, 'backups', 'commons-schema5-before-x.sqlite')), 'manually named backups are never pruned');
  // The CLI form never opens the database through Store (no migration before the old service stops).
  const out = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'backup', '--home', f.home, '--keep', '5'], { encoding: 'utf8' });
  assert.match(out, /backed up .*commons-\d{8}T\d{9}Z(-\d+)?\.sqlite \(integrity ok\)/);
});

test('1.2 job-diff, job-drop (refusing a dirty worktree without --force), prune and log rotation', async t => {
  const f = fixture(t);
  f.run();
  const edit = await f.until(f.submit({ mode: 'edit', prompt: 'EDIT it' }).id);
  assert.match(jobDiff(f.store, edit.id), /\+1 -0 \(1f\)[\s\S]*\+written by job/);
  assert.equal(code(() => dropJob(f.store, edit.id, false)), 'WORKTREE_DIRTY');
  assert.ok(fs.existsSync(edit.workdir), 'nothing removed');
  const lines = dropJob(f.store, edit.id, true);
  assert.ok(!fs.existsSync(edit.workdir)); assert.match(lines.join('\n'), /removed worktree[\s\S]*deleted branch ac\/job-/);
  assert.equal(execFileSync('git', ['-C', f.repo, 'branch', '--list', edit.branch], { encoding: 'utf8' }).trim(), '');
  assert.match(jobDiff(f.store, edit.id), /\+written by job/, 'the saved diff artifact still answers');
  // prune: old finished job folders and releases beyond the newest N (never current's target).
  const advice = await f.until(f.submit({ prompt: 'plain' }).id);
  const running = f.submit({ prompt: 'SLEEP long' });
  for (let i = 0; i < 100 && !fs.existsSync(path.join(f.home, 'jobs', running.id)); i++) await sleep(50);
  assert.equal(code(() => dropJob(f.store, running.id, true)), 'JOB_NOT_FINISHED');
  f.store.db.prepare("UPDATE jobs SET finished_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(advice.id);
  const app = path.join(f.home, 'app');
  for (const [i, name] of ['c1', 'c2', 'c3', 'c4'].entries()) { fs.mkdirSync(path.join(app, name, 'v2'), { recursive: true }); const at = new Date(Date.now() - (10 - i) * 86400000); fs.utimesSync(path.join(app, name), at, at); }
  fs.symlinkSync(path.join(app, 'c1'), path.join(f.home, 'current'), 'junction');
  const dry = pruneHome(f.store, f.home, { olderThanDays: 14, keepReleases: 2, dryRun: true });
  assert.ok(dry.some(l => l.includes('would remove') && l.includes(advice.id))); assert.ok(fs.existsSync(path.join(f.home, 'jobs', advice.id)), 'dry run removes nothing');
  pruneHome(f.store, f.home, { olderThanDays: 14, keepReleases: 2 });
  assert.ok(!fs.existsSync(path.join(f.home, 'jobs', advice.id)));
  assert.ok(f.store.jobRecord(advice.id), 'the job row stays');
  assert.deepEqual(fs.readdirSync(app).sort(), ['c1', 'c3', 'c4'], 'current (c1) and the newest two stay');
  assert.ok(fs.existsSync(path.join(f.home, 'jobs', running.id)), 'unfinished jobs are never pruned');
  fs.mkdirSync(path.join(f.home, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(f.home, 'logs', 'service.log'), 'x'.repeat(2000));
  assert.match(rotateLog(f.home, 1000), /rotated/);
  assert.equal(fs.readFileSync(path.join(f.home, 'logs', 'service.log.1'), 'utf8').length, 2000);
  assert.equal(fs.existsSync(path.join(f.home, 'logs', 'service.log')), false);
  assert.match(rotateLog(f.home, 1000), /no rotation/);
});

test('2.1 a Claude usage limit is QUOTA_EXHAUSTED and sets a cooldown; the next success clears it', async t => {
  const f = fixture(t);
  f.run();
  const hit = await f.until(f.submit({ prompt: 'LIMITHIT now' }).id);
  assert.equal(hit.status, 'failed'); assert.match(hit.error, /^QUOTA_EXHAUSTED: Claude AI usage limit reached/);
  const reset = Date.parse(f.state('claude')!.cooldown_until);
  assert.ok(Math.abs(reset - (Date.now() + 3600000)) < 120000, 'the reset time the CLI reported (one hour ahead)');
  assert.match(f.state('claude')!.cooldown_reason, /usage limit/);
  await f.until(f.submit({ prompt: 'fine now' }).id);
  assert.equal(f.state('claude')!.cooldown_until, null, 'a success clears the cooldown');
  const soon = Date.now(), again = await f.until(f.submit({ prompt: 'LIMITSOON' }).id);
  assert.match(again.error, /^QUOTA_EXHAUSTED/);
  const until = Date.parse(f.state('claude')!.cooldown_until);
  assert.ok(until >= soon + 14 * 60000 && until <= Date.now() + 16 * 60000, 'no reset time: 15 minutes');
  f.store.clearCooldown('claude'); assert.equal(f.state('claude')!.cooldown_until, null);
  const fiveHour = await f.until(f.submit({ prompt: 'LIMIT5H' }).id);
  assert.equal(fiveHour.status, 'failed');
  assert.match(fiveHour.error, /^QUOTA_EXHAUSTED: You've hit your 5-hour limit/);
  assert.ok(f.state('claude')!.cooldown_until, '5-hour limit sets a cooldown');
  f.store.clearCooldown('claude'); assert.equal(f.state('claude')!.cooldown_until, null);
  // Reset-time parsing.
  const now = Date.parse('2026-11-20T10:00:00Z');
  assert.equal(cooldownUntil('limit|4102444800', now), '2026-11-20T10:15:00.000Z', 'over 8 days ahead is not trusted: the default');
  assert.equal(cooldownUntil('limit|1795176000', now), '2026-11-20T12:00:00.000Z', 'epoch seconds after |');
  assert.equal(cooldownUntil('resets at 2026-11-20T12:30:00Z', now), '2026-11-20T12:30:00.000Z');
  assert.equal(cooldownUntil('try again in 2 hours', now), '2026-11-20T12:00:00.000Z');
  assert.equal(cooldownUntil('try again in 30 minutes', now), '2026-11-20T10:30:00.000Z');
  assert.equal(cooldownUntil('limit reached', now), '2026-11-20T10:15:00.000Z');
  assert.equal(cooldownUntil('resets at 2020-01-01T00:00:00Z', now), '2026-11-20T10:15:00.000Z', 'a past time falls back to the default');
});

test('2.2 antigravity and openai-api record the reported model and tokens', async t => {
  const f = fixture(t);
  const apiDir = path.join(f.base, 'api'); fs.mkdirSync(apiDir);
  f.run({ antigravity: { file: process.execPath, prefix: [FAKE_AG] }, openaiHelper: { file: process.execPath, prefix: [FAKE_API], cwd: apiDir } });
  const ag = await f.until(f.submit({ route: 'antigravity', prompt: 'hello' }).id);
  assert.deepEqual([ag.status, ag.reported_model, ag.tokens_in, ag.tokens_out], ['completed', 'gemini-4-argon-high', 11, 7]);
  const api = await f.until(f.submit({ route: 'openai-api', prompt: 'hello', max_cost_usd: '0.10', purpose: 'p', deliverable: 'd' }).id);
  assert.deepEqual([api.status, api.reported_model, api.tokens_in, api.tokens_out], ['completed', 'gpt-6-luna-2026-11', 21, 9]);
});

test('2.3 the store enforces each adapter\'s modes, time limit and prompt limit', t => {
  const f = fixture(t);
  registerAdapter({ capabilities: { id: 'stub', family: 'local', transport: 'cli', billing: 'local', modes: ['advice'], supportsShellInEdit: false,
    maxPromptChars: 100, maxTimeoutMinutes: 5, defaultTimeoutMinutes: 2, quotaGroup: 'stub', defaultModel: null, maxConcurrent: 1, maxConcurrentCeiling: 1, short: 'stub' },
    profiles: [], probe: async () => ({ state: 'verified' }), validate: () => ({}), launch: () => {} });
  t.after(() => unregisterAdapter('stub'));
  assert.throws(() => f.submit({ route: 'stub', mode: 'edit' }), /stub jobs are advice only/);
  assert.throws(() => f.submit({ route: 'stub', timeout_minutes: 6 }), /at most 5 minutes/);
  assert.equal(code(() => f.submit({ route: 'stub', prompt: 'p'.repeat(101) })), 'PROMPT_TOO_LARGE');
  assert.equal(f.submit({ route: 'stub', prompt: 'p'.repeat(100) }).timeout_ms, 2 * 60000);
});

test('2.4 a client that disconnects mid air_wait leaves no listener behind', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-abort-'));
  const home = path.join(base, 'data'), repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  const seed = new Store(home);
  const token = seed.createActor('claude-desktop', 'participant', 'claude-desktop').token;
  const actor = { id: 'claude-desktop', name: 'claude-desktop', role: 'participant' as const };
  seed.call(actor, 'project_create', { name: 'R', root: repo, operation_id: randomUUID() });
  const job = seed.call(actor, 'job_submit', { project_id: 'p1', route: 'claude', prompt: 'x', operation_id: randomUUID() }).job;
  seed.close();
  const running = await startServer(home, 0, false);
  t.after(async () => { await running.close(); fs.rmSync(base, { recursive: true, force: true }); });
  const baseline = running.store.jobEvents.listenerCount('job');
  const controller = new AbortController();
  const request = fetch(running.url + '/api/v1/call', { method: 'POST', signal: controller.signal, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'air_wait', input: { handles: job.id, wait_seconds: 30 } }) }).catch(() => 'aborted');
  for (let i = 0; i < 40 && running.store.jobEvents.listenerCount('job') === baseline; i++) await sleep(25);
  assert.equal(running.store.jobEvents.listenerCount('job'), baseline + 1);
  controller.abort(); assert.equal(await request, 'aborted');
  for (let i = 0; i < 40 && running.store.jobEvents.listenerCount('job') !== baseline; i++) await sleep(25);
  assert.equal(running.store.jobEvents.listenerCount('job'), baseline, 'cleaned up at once, not after 30 seconds');
});

test('3 Google keys are stripped; ctx= refuses secret-looking content and the service home', t => {
  const f = fixture(t);
  const saved = { g: process.env.GEMINI_API_KEY, k: process.env.GOOGLE_API_KEY };
  process.env.GEMINI_API_KEY = 'gem'; process.env.GOOGLE_API_KEY = 'goo';
  t.after(() => { for (const [k, v] of [['GEMINI_API_KEY', saved.g], ['GOOGLE_API_KEY', saved.k]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  for (const env of [workerEnv('j'), helperEnv()]) { assert.equal(env.GEMINI_API_KEY, undefined); assert.equal(env.GOOGLE_API_KEY, undefined); }
  const secrets = { 'openai.txt': 'key = sk-' + 'a'.repeat(40), 'google.txt': 'AIza' + 'b'.repeat(35), 'github.txt': 'ghp_' + 'c'.repeat(36),
    'pk.txt': ['-----BEGIN', 'RSA', 'PRIVATE KEY-----'].join(' ') + '\nabc\n-----END RSA PRIVATE KEY-----',
    'aws.txt': 'AKIA' + 'D'.repeat(16) };
  for (const [name, content] of Object.entries(secrets)) {
    fs.writeFileSync(path.join(f.repo, name), content);
    assert.equal(code(() => f.submit({ context_refs: [`file:${name}`] })), 'CTX_SECRET', name);
  }
  fs.writeFileSync(path.join(f.repo, 'fine.txt'), 'sk-short and AIza too short');
  assert.equal(f.submit({ context_refs: ['file:fine.txt'] }).options.ctx.length, 1);
  // A project cannot include the service data directory.
  assert.equal(code(() => f.call('project_create', { name: 'Outer', root: f.base, operation_id: randomUUID() })), 'PROJECT_ROOT_INVALID');
});

test('4.1 archived projects leave discovery and root lookup unless asked for', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.repo, 'scratch'));
  const scratch = f.call('project_create', { name: 'Scratch', root: path.join(f.repo, 'scratch'), operation_id: randomUUID() }).project;
  f.store.setArchived('p2', true);
  assert.deepEqual(f.call('project_discover', {}).projects.map((p: any) => p.name), ['Repo']);
  assert.deepEqual(f.call('project_discover', { include_archived: true }).projects.map((p: any) => p.name).sort(), ['Repo', 'Scratch']);
  assert.match(f.call('air_sync', { root: path.join(f.repo, 'scratch', 'x') }).air, /name=Repo /, 'an archived nested project yields to its live parent');
  f.store.setArchived(scratch.id, false);
  assert.match(f.call('air_sync', { root: path.join(f.repo, 'scratch', 'x') }).air, /name=Scratch /);
});

test('4.2 /health reports schema and job counts; 4.3 actors take a family and adapter', async t => {
  const f = fixture(t);
  f.submit({ prompt: 'queued one' });
  f.store.setActorTags('claude-desktop', 'anthropic', 'claude');
  assert.deepEqual({ ...f.store.db.prepare("SELECT family, adapter_id FROM actors WHERE id='claude-desktop'").get() }, { family: 'anthropic', adapter_id: 'claude' });
  assert.equal(code(() => f.store.setActorTags('claude-desktop', 'anthropic', 'nope')), 'ROUTE_UNAVAILABLE');
  assert.equal(code(() => f.store.setActorTags('ghost', 'openai', null)), 'ACTOR_NOT_FOUND');
  f.store.close();
  // Closed here, not in t.after: after hooks run in registration order, and the fixture's folder removal (registered
  // first) cannot delete an open database on Windows.
  const running = await startServer(f.home, 0, false);
  try {
    const health = await (await fetch(running.url + '/health')).json();
    assert.deepEqual(health, { status: 'ready', service: 'agent-commons-v2', schema_version: SCHEMA_VERSION, running_jobs: 0, queued_jobs: 1, needs_review_jobs: 0 });
  } finally { await running.close(); }
});

test('cli project-create makes a project through the operator actor (AIR-profile apps cannot)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-pc-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-pc-root-'));
  const run = (...a: string[]) => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, ...a, '--home', home], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    protectFixtureHome(home);
    run('init');
    const project = JSON.parse(run('project-create', '--name', 'Demo', '--root', root, '--objective', 'try it'));
    assert.equal(project.name, 'Demo');
    assert.equal(project.root, path.resolve(root));
    assert.equal(project.objective, 'try it');
    assert.throws(() => run('project-create', '--name', 'Again', '--root', root), /PROJECT_ROOT_EXISTS/);
    const store = new Store(home);
    try { assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM projects').get() as any).n, 1); } finally { store.close(); }
  } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true }); }
});

test('job-settle closes a needs_review job as failed or cancelled, keeps the old error, and never re-runs it', async t => {
  const f = fixture(t);
  const job = f.submit({ prompt: 'plain' });
  f.store.db.prepare("UPDATE jobs SET status='needs_review', error='HELPER_OUTCOME_UNCLEAR: x' WHERE id=?").run(job.id);
  const operator = (f.store.db.prepare("SELECT id FROM actors WHERE role='operator'").get() as any).id;
  assert.equal(code(() => f.store.settleJob(job.id, 'failed', '  ', operator)), 'INVALID_INPUT');
  assert.equal(code(() => f.store.settleJob(job.id, 'completed' as any, 'checked', operator)), 'INVALID_INPUT');
  const settled = f.store.settleJob(job.id, 'cancelled', 'helper shows nothing pending', operator);
  assert.equal(settled.status, 'cancelled');
  const row = f.store.jobRecord(job.id)!;
  assert.match(row.error, /^SETTLED: helper shows nothing pending \(was: HELPER_OUTCOME_UNCLEAR: x\)$/);
  assert.equal(row.options.settled.by, operator);
  assert.equal(code(() => f.store.settleJob(job.id, 'failed', 'again', operator)), 'JOB_NOT_IN_REVIEW');
  const events = f.store.db.prepare("SELECT count(*) n FROM events WHERE entity_id=? AND action='job_settle'").get(job.id) as any;
  assert.equal(events.n, 1);
  assert.equal((f.store.db.prepare('SELECT count(*) n FROM jobs').get() as any).n, 1, 'no repair or replacement job');
  const other = f.submit({ prompt: 'plain' });
  assert.equal(code(() => f.store.settleJob(other.id, 'failed', 'checked', operator)), 'JOB_NOT_IN_REVIEW', 'only needs_review jobs');
});

test('restore copies a backup into a new home only, and never re-runs running or queued jobs', async t => {
  const f = fixture(t);
  const running = f.submit({ prompt: 'plain' }), queued = f.submit({ prompt: 'plain' }), done = f.submit({ prompt: 'plain' });
  f.store.db.prepare("UPDATE jobs SET status='running' WHERE id=?").run(running.id);
  f.store.db.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(done.id);
  const { file } = await backupDatabase(f.home, 5);
  const target = path.join(f.base, 'restored');
  assert.equal(await restoreDatabase(file, f.home, SCHEMA_VERSION).catch(e => e.code), 'HOME_NOT_EMPTY', 'never over a live home');
  const r = await restoreDatabase(file, target, SCHEMA_VERSION);
  assert.deepEqual([r.schema, r.running, r.queued], [SCHEMA_VERSION, 1, 1]);
  assert.deepEqual(fs.readdirSync(target), ['commons.sqlite'], 'published under its real name only; no staging files left');
  const restored = new Store(target);
  assert.equal(restored.jobRecord(running.id)!.status, 'needs_review');
  assert.match(restored.jobRecord(running.id)!.error, /^RESTORED_FROM_BACKUP/);
  assert.equal(restored.jobRecord(queued.id)!.status, 'cancelled');
  assert.equal(restored.jobRecord(done.id)!.status, 'completed');
  assert.ok(restored.authenticate(f.token), 'the apps\' tokens still work');
  restored.close();
  assert.equal(await restoreDatabase(file, path.join(f.base, 'other'), SCHEMA_VERSION - 1).catch(e => e.code), 'SCHEMA_TOO_NEW');
  const junk = path.join(f.base, 'junk.sqlite'); fs.writeFileSync(junk, 'not a database');
  assert.ok(await restoreDatabase(junk, path.join(f.base, 'other2'), SCHEMA_VERSION).then(() => false, () => true), 'a non-database is refused');
  assert.equal(await restoreDatabase(path.join(f.base, 'missing.sqlite'), path.join(f.base, 'other3'), SCHEMA_VERSION).catch(e => e.code), 'NOT_FOUND');
});

test('releaseInfo reads the installed release.json and is null for a checkout', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-release-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'release.json');
  assert.equal(releaseInfo(file), null);
  fs.writeFileSync(file, JSON.stringify({ commit: 'abc', v2_tree: 'def', installed_at: '2026-11-21T00:00:00Z', node: { version: '24.18.0', path: 'C:\node.exe' } }));
  assert.deepEqual(releaseInfo(file), { commit: 'abc', v2_tree: 'def', installed_at: '2026-11-21T00:00:00Z', node: '24.18.0' });
});
