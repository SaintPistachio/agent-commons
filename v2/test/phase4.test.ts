// Phase 4 (fabric Stage 4): the R route-status line, route=auto (deterministic, cross-family for reviews, never paid
// without cost=paid and spend fields), route hints, and the CLI clients for tools without MCP.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store, CommonsError, type Actor } from './fixtures/service.ts';
import { startServer } from './fixtures/service.ts';
import { adapter, registerAdapter, unregisterAdapter } from '../src/adapters/registry.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const failure = (fn: () => unknown) => { try { fn(); } catch (error) { return error as CommonsError; } throw new Error('expected a failure'); };

function fixture(t: any, verified = ['claude', 'codex', 'openai-api', 'antigravity']) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-p4-'));
  const home = path.join(fixtureRoot, 'data');
  const repo = path.join(fixtureRoot, 'repo'); fs.mkdirSync(repo);
  const store = new Store(home);
  t.after(() => { try { store.close(); } catch {} fs.rmSync(fixtureRoot, { recursive: true, force: true }); });
  const claude: Actor = store.createActor('claude-desktop', 'participant', 'claude-desktop').actor;
  const codex: Actor = store.createActor('codex-desktop', 'participant', 'codex-desktop').actor;
  store.setActorTags('claude-desktop', 'anthropic', 'claude'); store.setActorTags('codex-desktop', 'openai', 'codex');
  for (const id of verified) store.recordProbe(adapter(id)!.capabilities, { state: 'verified', cliVersion: '1.0' });
  const call = (actor: Actor, method: string, input: Record<string, unknown> = {}) => store.call(actor, method, input);
  call(claude, 'project_create', { name: 'Repo', root: repo, operation_id: randomUUID() });
  const submit = (actor: Actor, extra: Record<string, unknown>) => call(actor, 'job_submit', { project_id: 'p1', prompt: 'x', operation_id: randomUUID(), ...extra }).job;
  const auto = (extra: Record<string, unknown> = {}, actor = claude) => submit(actor, { route: 'auto', ...extra });
  const rline = (actor: Actor = claude) => (call(actor, 'air_sync', { project_id: 'p1' }).air as string).split('\n').find(l => l.startsWith('R ')) ?? null;
  return { home, repo, store, claude, codex, call, submit, auto, rline };
}

test('the R line shows each route\'s load, queue, probe state, cooldown and billing', t => {
  const f = fixture(t, ['claude', 'codex', 'openai-api']);
  f.store.recordProbe(adapter('antigravity')!.capabilities, { state: 'blocked', reason: 'helper files changed' });
  f.store.setCooldown('codex', '2100-01-01T00:00:00.000Z', 'QUOTA_EXHAUSTED: weekly limit');
  f.submit(f.claude, { prompt: 'waiting' });
  assert.equal(f.rline(), 'R claude=0/1+1q codex=0/1:cool@2100-01-01T00:00Z api=0/1:paid ag=0/1:blk');
});

test('the R line shows the limit the runner enforces, including an operator override', t => {
  const f = fixture(t, ['claude', 'codex', 'openai-api', 'antigravity']);
  f.store.setRouteLimit('antigravity', 2);
  f.store.setRouteLimit('openai-api', 3);
  assert.equal(f.rline(), 'R claude=0/1 codex=0/1 api=0/3:paid ag=0/2');
  f.store.db.prepare("UPDATE platform_state SET max_running=9 WHERE adapter_id='antigravity'").run(); // a stored value above the ceiling
  const snapshot = (f.call(f.claude, 'air_sync', { project_id: 'p1', since_seq: 0 }).air as string).split('\n').find(l => l.startsWith('R '));
  assert.match(snapshot!, / ag=0\/2$/, 'capped at the ceiling, as the runner caps it');
});

test('a job may name its route by the short name the R line shows; it is stored by its full ID', t => {
  const f = fixture(t);
  assert.equal(f.submit(f.claude, { route: 'ag' }).route, 'antigravity');
  const paid = f.submit(f.claude, { route: 'api', cost: 'paid', max_cost_usd: 0.1, purpose: 'a check', deliverable: 'an answer' });
  assert.equal(paid.route, 'openai-api');
  assert.equal(failure(() => f.submit(f.claude, { route: 'nowhere' })).code, 'ROUTE_UNAVAILABLE');
});

test('a delta sync carries the R line only when a route or a job changed since that reader\'s last read', t => {
  const f = fixture(t);
  assert.ok(f.rline(f.codex), 'the first read (a snapshot) has it');
  assert.equal(f.rline(f.codex), null, 'nothing changed');
  f.call(f.claude, 'air_tx', { project_id: 'p1', packet: '@air1\n#0 dec "unrelated"', operation_id: randomUUID() });
  assert.equal(f.rline(f.codex), null, 'a decision is not a route change');
  f.store.setCooldown('codex', '2100-01-01T00:00:00.000Z', 'limit');
  assert.match(f.rline(f.codex)!, /codex=0\/1:cool@/, 'a cooldown shows');
  assert.equal(f.rline(f.codex), null);
  f.store.clearCooldown('codex');
  assert.match(f.rline(f.codex)!, /codex=0\/1 /, 'so does its end');
  f.submit(f.claude, { prompt: 'job' });
  assert.match(f.rline(f.codex)!, /claude=0\/1\+1q/, 'and a job change');
});

test('route=auto: subscription before paid, idle first, other family for reviews, shell needs, cooldowns', t => {
  const f = fixture(t, ['claude', 'codex', 'openai-api']);
  const first = f.auto();
  assert.equal(first.route, 'claude', 'idle subscription routes, in registry order');
  assert.deepEqual(first.options.auto, { picked: 'claude', considered: ['claude', 'codex'] });
  assert.equal(f.auto().route, 'codex', 'claude has a queued job now, so the idle codex wins');
  assert.equal(f.auto({ intent: 'review' }).route, 'codex', 'claude-desktop (anthropic) gets an openai reviewer');
  assert.equal(f.auto({ intent: 'review' }, f.codex).route, 'claude', 'codex-desktop (openai) gets an anthropic reviewer, busy or not');
  assert.equal(f.auto({ mode: 'edit', shell: true }).route, 'codex', 'only codex runs a shell in edit jobs');
  f.store.setCooldown('codex', '2100-01-01T00:00:00.000Z', 'limit');
  assert.equal(f.auto({ intent: 'review' }).route, 'claude', 'a cooling route is skipped');
  const fromPacket = f.call(f.codex, 'air_tx', { project_id: 'p1', packet: '@air1\n#0 job route=auto intent=review cost=sub "check this"', operation_id: randomUUID() });
  assert.equal(f.call(f.codex, 'job_status', { job_id: fromPacket.handles['0'] }).job.route, 'claude', 'route=auto works in a packet too');
  const none = failure(() => f.auto({ mode: 'edit', shell: true }));
  assert.equal(none.code, 'NO_ELIGIBLE_ROUTE');
  assert.match(none.message, /claude:no_shell codex:cooldown api:mode ag:not_probed$/);
  assert.equal(f.submit(f.claude, { route: 'codex', prompt: 'explicit' }).route, 'codex', 'an explicit route is the caller\'s choice, cooldown or not');
});

test('route=auto reaches the paid route only with cost=paid and the spend fields', t => {
  const f = fixture(t, ['claude', 'codex', 'openai-api']);
  for (const route of ['claude', 'codex']) f.store.setCooldown(route, '2100-01-01T00:00:00.000Z', 'limit');
  assert.match(failure(() => f.auto()).message, /api:cost/, 'cost=sub is the default');
  assert.match(failure(() => f.auto({ cost: 'paid' })).message, /api:spend_fields/);
  const paid = f.auto({ cost: 'paid', max_cost_usd: '0.05', purpose: 'p', deliverable: 'd' });
  assert.equal(paid.route, 'openai-api'); assert.equal(paid.model, 'gpt-6.1-terra');
  f.store.clearCooldown('claude');
  assert.equal(f.auto({ cost: 'paid', max_cost_usd: '0.05', purpose: 'p', deliverable: 'd' }).route, 'claude', 'a subscription route still wins when one is free');
  assert.equal(failure(() => f.auto({ cost: 'cheap' })).code, 'INVALID_INPUT');
});

test('route=auto prefers a local route, and skips a route without a profile for the intent', t => {
  const f = fixture(t, ['claude', 'codex']);
  registerAdapter({ capabilities: { id: 'local-stub', family: 'local', transport: 'cli', billing: 'local', modes: ['advice'], supportsShellInEdit: false,
    maxPromptChars: 1000, maxTimeoutMinutes: 30, defaultTimeoutMinutes: 5, quotaGroup: 'local', defaultModel: null, maxConcurrent: 1, maxConcurrentCeiling: 1, short: 'loc' },
    profiles: [], probe: async () => ({ state: 'verified' }), validate: () => ({}), launch: () => {} });
  t.after(() => unregisterAdapter('local-stub'));
  f.store.recordProbe(adapter('local-stub')!.capabilities, { state: 'verified' });
  assert.equal(f.auto().route, 'local-stub', 'local before subscription');
  assert.equal(f.auto({ intent: 'code' }).route, 'claude', 'the stub has no profiles, so an intent skips it');
  assert.match(failure(() => f.auto({ prompt: 'p'.repeat(1500), cost: 'local' })).message, /loc:prompt_size/);
});

test('route_hints lists idle routes outside the caller\'s family', t => {
  const f = fixture(t);
  assert.equal(f.call(f.claude, 'route_hints').air, 'codex,ag', 'anthropic caller: openai and google peers, never the paid route');
  assert.equal(f.call(f.codex, 'route_hints').air, 'claude,ag');
  assert.equal(f.call(f.claude, 'route_hints', { exclude_family: 'google' }).air, 'claude,codex');
  f.store.setCooldown('codex', '2100-01-01T00:00:00.000Z', 'limit');
  f.submit(f.claude, { route: 'antigravity', prompt: 'busy' });
  assert.equal(f.call(f.claude, 'route_hints').air, '', 'cooling and busy peers are not idle');
});

test('the CLI clients speak AIR-T over the loopback API with a connection file', async t => {
  const f = fixture(t);
  f.store.close();
  const seed = new Store(f.home);
  const token = seed.createActor('cli-user', 'participant', 'cli-user').token;
  seed.setActorTags('cli-user', 'anthropic', null);
  seed.close();
  const running = await startServer(f.home, 0, false);
  try {
    const conn = path.join(f.home, 'conn.json');
    fs.writeFileSync(conn, JSON.stringify({ url: running.url, token, actorId: 'cli-user' }));
    const cli = (...args: string[]) => new Promise<string>((resolve, reject) => {
      // Asynchronous: the server runs in this process.
      import('node:child_process').then(({ execFile }) => execFile(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, ...args, '--connection', conn],
        { encoding: 'utf8' }, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout.trim())));
    });
    assert.match(await cli('air-sync', '--root', path.join(f.repo, 'src')), /^@air1 sync p=p1 name=Repo .*snap=1[\s\S]*\nR claude=0\/1/);
    const packet = path.join(f.home, 'packet.air'); fs.writeFileSync(packet, '@air1\n#0 dec "from the cli"');
    assert.match(await cli('air-tx', '--project', 'p1', '--packet-file', packet), /^@air1 ok op=\S+ seq=\d+ unseen=\d+ inbox=0\n#0=d1$/);
    assert.match(await cli('air-get', '--handles', 'd1'), /^@air1 get n=1\nD d1 by=cli-user "from the cli"$/);
    const job = running.store.call({ id: 'cli-user', name: 'cli-user', role: 'participant' }, 'job_submit', { project_id: 'p1', prompt: 'x', operation_id: randomUUID() }).job;
    assert.match(await cli('air-wait', '--handles', job.id, '--wait', '1'), /^@air1 wait n=1 done=0 timeout=1/);
    assert.equal(await cli('route-hints'), 'codex,ag');
  } finally { await running.close(); }
});

test('the runner\'s default per-route limit comes from each adapter', () => {
  for (const id of ['claude', 'codex', 'openai-api', 'antigravity']) assert.equal(adapter(id)!.capabilities.maxConcurrent, 1, id);
  assert.deepEqual(['claude', 'codex', 'openai-api', 'antigravity'].map(id => adapter(id)!.capabilities.short), ['claude', 'codex', 'api', 'ag']);
});

test('air_get routes: one W line per route with limit, usage left, track record and feedback', t => {
  const f = fixture(t, ['claude', 'codex', 'openai-api', 'antigravity']);
  f.store.recordUsage('claude', [{ pool: 'default', window: '5h', remaining_percent: 60, resets_at: null }], 'operator');
  const job = f.submit(f.claude, { route: 'claude' });
  f.store.db.prepare("UPDATE jobs SET status='completed', latency_ms=4000, cost_usd=0.02 WHERE id=?").run(job.id);
  f.call(f.claude, 'air_tx', { project_id: 'p1', packet: `@air1\n#0 out j=${job.id} v=accepted "fine"`, operation_id: randomUUID() });
  const lines = (f.call(f.claude, 'air_get', { handles: 'routes' }).air as string).split('\n');
  assert.equal(lines[1], '@air1 routes window=90d');
  const claude = lines.find(l => l.startsWith('W claude '))!;
  assert.match(claude, /^W claude fam=anthropic bill=sub ws=1 alw=neu st=verified run=0\/1 left%=5h:60 jobs=1 ok=1 bad=0 acc=1 rej=0 p50=4s avg\$=0\.020$/);
  assert.match(lines.find(l => l.startsWith('W ag '))!, / left%=\? jobs=0 /);
});
