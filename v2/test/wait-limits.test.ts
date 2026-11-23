// Stage 3 (turn-free waiting) and operator-set parallelism: the air-wait-until client, per-route and global running
// limits (validated against each adapter's ceiling), claims that follow a limit change at once, and the limits CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store, CommonsError, type Actor } from './fixtures/service.ts';
import { startServer } from './fixtures/service.ts';
import { Runner } from '../src/runner.ts';
import { adapter } from '../src/adapters/registry.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const ROUTES = ['claude', 'codex', 'openai-api', 'antigravity'];
const failure = (fn: () => unknown) => { try { fn(); } catch (error) { return error as CommonsError; } throw new Error('expected a failure'); };

/** Runs the CLI without blocking this process (a test server may run in it); resolves with the exit code, never rejects. */
const run = (args: string[], env: Record<string, string> = {}) => new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
  execFile(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...env } },
    (error, stdout, stderr) => {
      const code = error ? (error as { code?: unknown }).code : 0;
      resolve({ code: typeof code === 'number' ? code : 1, stdout: String(stdout).trim(), stderr: String(stderr) });
    });
});

function fixture(t: any) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-wl-'));
  const home = path.join(fixtureRoot, 'data');
  const repo = path.join(fixtureRoot, 'repo'); fs.mkdirSync(repo);
  const store = new Store(home);
  t.after(() => { try { store.close(); } catch {} fs.rmSync(fixtureRoot, { recursive: true, force: true }); });
  const claude: Actor = store.createActor('claude-desktop', 'participant', 'claude-desktop').actor;
  store.setActorTags('claude-desktop', 'anthropic', 'claude');
  for (const id of ROUTES) store.recordProbe(adapter(id)!.capabilities, { state: 'verified', cliVersion: '1.0' });
  store.call(claude, 'project_create', { name: 'Repo', root: repo, operation_id: randomUUID() });
  const submit = (extra: Record<string, unknown> = {}) => store.call(claude, 'job_submit', { project_id: 'p1', prompt: 'x', operation_id: randomUUID(), ...extra }).job;
  return { home, repo, store, claude, submit };
}

/** A running test server (no runner) and a connection file for a CLI participant. */
async function withServer(t: any, work: (s: any) => Promise<void>) {
  const f = fixture(t);
  const token = f.store.createActor('cli-user', 'participant', 'cli-user').token;
  f.store.setActorTags('cli-user', 'anthropic', null);
  f.store.close();
  const running = await startServer(f.home, 0, false);
  try {
    const conn = path.join(f.home, 'conn.json');
    fs.writeFileSync(conn, JSON.stringify({ url: running.url, token, actorId: 'cli-user' }));
    const user = { id: 'cli-user', name: 'cli-user', role: 'participant' } as Actor;
    const submit = () => running.store.call(user, 'job_submit', { project_id: 'p1', prompt: 'x', operation_id: randomUUID() }).job;
    await work({ ...f, running, conn, submit });
  } finally { await running.close(); }
}

test('air-wait-until exits 0 with the J line when a job finishes during the wait', async t => {
  await withServer(t, async s => {
    const job = s.submit();
    const waiting = run(['air-wait-until', '--handles', job.id, '--connection', s.conn], { AC_WAIT_SLICE_SECONDS: '1', AC_WAIT_DEADLINE_SECONDS: '30' });
    // Finished from the test, as the runner would; the waiting client only reads.
    await new Promise(resolve => setTimeout(resolve, 1500));
    s.running.store.updateJob(job.id, { status: 'failed', error: 'TEST_FINISHED', finished_at: new Date().toISOString() });
    const result = await waiting;
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /^@air1 wait n=1 done=1(?! timeout)/);
    assert.match(result.stdout, /\nJ j\d+\b/);
    assert.match(result.stdout, /\n@air1 waited s=\d+ done=1\/1$/);
  });
});

test('air-wait-until exits 2 with done=0/1 when the deadline passes first', async t => {
  await withServer(t, async s => {
    const job = s.submit();
    const result = await run(['air-wait-until', '--handles', job.id, '--connection', s.conn], { AC_WAIT_SLICE_SECONDS: '1', AC_WAIT_DEADLINE_SECONDS: '2' });
    assert.equal(result.code, 2, result.stdout + result.stderr);
    assert.match(result.stdout, /^@air1 wait n=1 done=0 timeout=1/);
    assert.match(result.stdout, /\n@air1 waited s=\d+ done=0\/1$/);
  });
});

test('air-wait-until reports bad input as an @air1 err line with exit 1', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-wl-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const conn = path.join(dir, 'conn.json');
  fs.writeFileSync(conn, JSON.stringify({ url: 'http://127.0.0.1:9', token: 'x', actorId: 'nobody' }));
  for (const args of [['--handles', 'j1', '--max-minutes', '56'], ['--handles', 'j1', '--max-minutes', '0'], []]) {
    const result = await run(['air-wait-until', ...args, '--connection', conn]);
    assert.equal(result.code, 1, args.join(' '));
    assert.match(result.stdout, /^@air1 err/, args.join(' '));
    assert.match(result.stdout, /INVALID_INPUT/, args.join(' '));
  }
});

test('route limits stay within each adapter\'s ceiling and the global limit within 1-16', t => {
  const f = fixture(t);
  assert.deepEqual(ROUTES.map(id => adapter(id)!.capabilities.maxConcurrentCeiling), [1, 1, 8, 2]);
  for (const [route, max] of [['claude', 2], ['codex', 2], ['openai-api', 9], ['antigravity', 3], ['claude', 0], ['claude', 1.5], ['nowhere', 1]] as const)
    assert.equal(failure(() => f.store.setRouteLimit(route, max)).code, 'INVALID_INPUT', `${route} ${max}`);
  f.store.setRouteLimit('openai-api', 8);
  f.store.setRouteLimit('antigravity', 2);
  for (const n of [0, 17, 2.5]) assert.equal(failure(() => f.store.setGlobalLimit(n)).code, 'INVALID_INPUT', String(n));
  f.store.setGlobalLimit(16);
  let limits = f.store.effectiveLimits(ROUTES);
  assert.deepEqual(limits.routes, { claude: 1, codex: 1, 'openai-api': 8, antigravity: 2 });
  assert.deepEqual(limits.overrides, { 'openai-api': 8, antigravity: 2 });
  assert.equal(limits.global, 16);
  f.store.clearLimits();
  limits = f.store.effectiveLimits(ROUTES, 5);
  assert.deepEqual(limits.routes, { claude: 1, codex: 1, 'openai-api': 1, antigravity: 1 });
  assert.equal(limits.global, 5); // the runner's option applies when the operator set nothing
  assert.equal(f.store.effectiveLimits(ROUTES).global, 3);
});

test('a limit change applies to the next claim without restarting the runner', t => {
  const f = fixture(t);
  const first = f.submit({ route: 'openai-api', cost: 'paid', max_cost_usd: 0.1, purpose: 'limit test', deliverable: 'none' }), second = f.submit({ route: 'openai-api', cost: 'paid', max_cost_usd: 0.1, purpose: 'limit test', deliverable: 'none' });
  const runner = new Runner(f.store, f.home); // never started: each claim uses the limits a tick would read
  const claim = () => { const limits = runner.limits(); return f.store.claimQueuedJob(limits.routes, limits.global); };
  assert.equal(claim()?.id, first.id);
  assert.equal(claim(), null); // one at a time by default
  f.store.setRouteLimit('openai-api', 2);
  f.store.setGlobalLimit(1);
  assert.equal(claim(), null); // the global limit still holds it
  f.store.setGlobalLimit(null);
  assert.equal(runner.limits().routes['openai-api'], 2);
  assert.equal(claim()?.id, second.id);
  assert.equal(f.store.jobRecord(second.id)!.status, 'running');
  // The routeLimits test seam still replaces the defaults; an operator override wins over it.
  assert.deepEqual(new Runner(f.store, f.home, { routeLimits: { codex: 1 } }).limits().routes, { codex: 1, 'openai-api': 2 });
});

test('the limits CLI prints the effective table after a change, and status shows the limits', t => {
  const f = fixture(t);
  f.store.close();
  const cli = (...args: string[]) => {
    try {
      const stdout = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, ...args, '--home', f.home], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { code: 0, stdout, stderr: '' };
    } catch (error: any) { return { code: error.status ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') }; }
  };
  let out = cli('limits', '--route', 'antigravity', '--max', '2');
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /^route\s+default\s+override\s+ceiling\s+effective$/m);
  assert.match(out.stdout, /^antigravity\s+1\s+2\s+2\s+2$/m);
  assert.match(out.stdout, /^codex\s+1\s+-\s+1\s+1$/m);
  assert.match(out.stdout, /^global\s+3\s+-\s+16\s+3$/m);
  out = cli('limits', '--global', '5');
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /^global\s+3\s+5\s+16\s+5$/m);
  assert.match(out.stdout, /^antigravity\s+1\s+2\s+2\s+2$/m); // the earlier change is kept
  out = cli('limits', '--route', 'antigravity', '--max', '9');
  assert.equal(out.code, 2);
  assert.match(out.stderr, /limits refused/);
  out = cli('status');
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /^running limits: .*\bantigravity 2\*.*; global 5\*/m);
  out = cli('limits', '--clear');
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /^claude\s+1\s+-\s+1\s+1$/m);
  assert.match(out.stdout, /^global\s+3\s+-\s+16\s+3$/m);
});

test('a probe never erases an operator route limit', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-limits-probe-'));
  const store = new Store(home);
  try {
    store.setRouteLimit('openai-api', 3);
    store.recordProbe(adapter('openai-api')!.capabilities, { state: 'verified', cliVersion: '1.0' });
    assert.equal(store.routeLimitOverride('openai-api'), 3);
  } finally { store.close(); fs.rmSync(home, { recursive: true, force: true }); }
});
