import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { parseClaudeCachedUsage, parseClaudeUsage, readClaudeCachedUsage, readClaudeUsage } from '../src/adapters/claude-usage.ts';
import { claude } from '../src/adapters/claude.ts';
import { codex } from '../src/adapters/codex.ts';
import { codexExpiringResets, codexUsageInventoryComplete, parseCodexAppServerRateLimits, parseCodexResetCredits } from '../src/adapters/codex-limits.ts';
import { UsageContractViolation, type UsageDiagnostic, type UsageObservation, type UsageWindow } from '../src/adapters/types.ts';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { Prober, USAGE_REFRESH } from '../src/prober.ts';
import { migrate, SCHEMA_VERSION } from '../src/schema.ts';
import { downsamplePoints } from '../src/store.ts';
import { Store } from './fixtures/service.ts';

const iso = (offset: number) => new Date(Date.now() + offset).toISOString();
const reading = (window: string, remaining: number, resets_at: string | null, observed_at: string, pool = 'default'): UsageObservation =>
  ({ window, pool, remaining_percent: remaining, resets_at, observed_at });

test('schema 22 preserves quota readings and carries forward an active schema 21 cooldown', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE platform_state (adapter_id TEXT PRIMARY KEY, cooldown_until TEXT, updated_at TEXT);
    CREATE TABLE projects (id TEXT PRIMARY KEY);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, depends_on TEXT NOT NULL DEFAULT '[]');
    CREATE TABLE usage_windows (route TEXT, pool TEXT, window TEXT, source TEXT, remaining_percent REAL, resets_at TEXT);
    PRAGMA user_version = 21;
  `);
  const observedAt = iso(-10_000);
  const resetsAt = iso(60_000);
  db.prepare('INSERT INTO platform_state VALUES (?, ?, ?)').run('claude', resetsAt, observedAt);
  db.prepare('INSERT INTO usage_windows VALUES (?, ?, ?, ?, ?, ?)').run('claude', 'default', 'weekly', 'reply', 0, resetsAt);

  migrate(db);
  migrate(db);

  assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, SCHEMA_VERSION);
  const route = db.prepare('SELECT cooldown_until, cooldown_started_at, cooldown_quota_windows, usage_blocked_identity FROM platform_state').get()!;
  assert.equal(route.cooldown_until, resetsAt);
  assert.equal(route.cooldown_started_at, observedAt);
  assert.equal(route.cooldown_quota_windows, '[["default","weekly"]]');
  assert.equal(route.usage_blocked_identity, null);
  const quota = db.prepare('SELECT remaining_percent, resets_at, early_reset_observed_at FROM usage_windows').get()!;
  assert.equal(quota.remaining_percent, 0);
  assert.equal(quota.resets_at, resetsAt);
  assert.equal(quota.early_reset_observed_at, null);
});

test('stored quota timestamps are canonical UTC even when the provider sends an offset', t => {
  const { store } = fixture(t);
  store.recordUsage('claude', [reading('weekly', 40, '2099-01-02T01:00:00+02:00', '2026-11-22T20:00:00-06:00')], 'claude-usage');

  const window = store.usageFor('claude')[0];
  assert.equal(window.resets_at, '2099-01-01T23:00:00.000Z');
  assert.equal(window.observed_at, '2026-11-23T02:00:00.000Z');
});

function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-usage-polling-'));
  const store = new Store(path.join(dir, 'data'));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, store };
}

test('a fresh complete usage inventory retires absent meters while retaining history and operator rows', t => {
  const { store } = fixture(t);
  const route = 'antigravity', reset = iso(60_000), old = iso(-5_000), readAt = iso(-2_000);
  const argon = reading('weekly', 60, reset, old, 'Gemini 4 Argon');
  const current = reading('weekly', 50, reset, readAt, 'Gemini Models');
  store.recordUsage(route, [argon], 'status');
  store.recordUsage(route, [reading('5h', 40, reset, old, 'operator override')], 'operator');
  store.recordUsage(route, [reading('weekly', 80, reset, iso(-500), 'newer reply')], 'reply');
  assert.equal(store.recordUsage(route, [current], 'status', readAt, false, true), true);
  assert.deepEqual(store.usageFor(route).map(row => row.pool), ['Gemini Models', 'newer reply', 'operator override']);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM usage_history WHERE pool='Gemini 4 Argon'").get()?.n, 1);
});

test('partial, rejected or out-of-order reads cannot retire an omitted meter', t => {
  const { store } = fixture(t);
  const route = 'codex', reset = iso(60_000);
  store.recordUsage(route, [reading('weekly', 60, reset, iso(-5_000), 'retained')], 'app-server');
  const current = reading('weekly', 50, reset, iso(-4_000), 'codex');
  store.recordUsage(route, [current], 'app-server', current.observed_at, true, true);
  assert.ok(store.usageFor(route).some(row => row.pool === 'retained'));
  const fresh = { ...current, observed_at: iso(-2_000) };
  store.recordUsage(route, [fresh, { ...fresh, pool: 'invalid', remaining_percent: -1 }], 'app-server', fresh.observed_at, false, true);
  store.recordUsage(route, [current], 'app-server', current.observed_at, false, true);
  assert.ok(store.usageFor(route).some(row => row.pool === 'retained'));
});

test('an omitted pool stays retired after an older report, and cooldown evidence survives omission', t => {
  const { store } = fixture(t);
  const route = 'codex', reset = iso(60_000), oldAt = iso(-5000), reportAt = iso(-1000);
  store.recordProbe(codex.capabilities, { state: 'verified' });
  const removed = reading('weekly', 10, reset, oldAt, 'removed');
  const exhausted = reading('weekly', 0, reset, oldAt, 'exhausted');
  store.recordUsage(route, [removed, exhausted], 'app-server');
  store.setCooldown(route, reset, 'QUOTA_EXHAUSTED: exhausted');
  const current = reading('weekly', 50, reset, reportAt, 'codex');
  assert.equal(store.recordUsage(route, [current], 'app-server', reportAt, false, true), true);
  store.recordUsageMeta(route, { meta: null });
  store.recordUsage(route, [removed], 'reply');
  assert.deepEqual(store.usageFor(route).map(row => row.pool), ['codex', 'exhausted']);
  assert.equal(store.platformState(route)?.cooldown_until, reset);
});

test('usage and model inventory changes recheck the other inventory once per polling interval', async t => {
  const { store, dir } = fixture(t);
  const route = 'claude';
  const base = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now: base });
  store.recordProbe(claude.capabilities, { state: 'verified' });
  let model = 'first', pool = 'default', usageReads = 0, discoveries = 0;
  const usage = () => reading('weekly', 50, null, iso(0), pool);
  const models = () => [{ model, efforts: ['medium'], source: 'test' }];
  const platform = claude as Required<Pick<typeof claude, 'observeUsage' | 'discover'>>;
  t.mock.method(platform, 'observeUsage', async () => {
    usageReads++;
    return { source: 'claude-usage', rows: [usage()], completeInventory: true };
  });
  t.mock.method(platform, 'discover', async () => {
    discoveries++;
    return models();
  });
  const prober = new Prober(store, dir, {}, { adapters: [route], schedule: false, cliModelHome: dir });
  t.after(() => prober.stop());
  await prober.refreshUsage();
  await prober.discover(route);
  assert.deepEqual([usageReads, discoveries], [1, 1]);

  t.mock.timers.setTime(base + 1000);
  pool = 'new pool';
  model = 'second';
  const discover = prober.discover.bind(prober);
  const calls = t.mock.method(prober, 'discover', discover);
  await prober.refreshUsage();
  assert.equal(calls.mock.callCount(), 1);
  await calls.mock.calls[0].result;
  assert.deepEqual([usageReads, discoveries], [2, 2]);

  t.mock.timers.setTime(base + 2000);
  model = 'third';
  await prober.discover(route);
  await nextTurn();
  assert.deepEqual([usageReads, discoveries], [2, 3]);

  t.mock.timers.setTime(base + 1000 + USAGE_REFRESH);
  pool = 'another pool';
  model = 'fourth';
  await prober.discover(route);
  await nextTurn();
  assert.deepEqual([usageReads, discoveries], [3, 4]);
});

test('Codex requires the explicit complete pool map before retiring omitted meters', () => {
  const now = Date.now();
  const primary = { usedPercent: 25, windowDurationMins: 10080, resetsAt: Math.floor(now / 1000) + 60 };
  const snap = { limitId: 'codex', primary, secondary: null };
  const full = { rateLimits: snap, rateLimitsByLimitId: { codex: snap } };
  const rows = parseCodexAppServerRateLimits(full, [], now)!;
  assert.equal(codexUsageInventoryComplete(full, rows, now), true);
  assert.equal(codexUsageInventoryComplete({ rateLimits: snap }, rows, now), false);
  const malformed = { ...full, rateLimitsByLimitId: { ...full.rateLimitsByLimitId, unknown: null } };
  assert.equal(codexUsageInventoryComplete(malformed, rows, now), false);
});

function frames(session_id: string, resets_at: string) {
  return [
    { type: 'system', subtype: 'ui_invalidate', session_id },
    { type: 'system', subtype: 'init', session_id, tools: [], mcp_servers: [] },
    { type: 'assistant', session_id, usage_report: { rate_limits: { limits: [
      { kind: 'session', percent: 40, resets_at },
      { kind: 'weekly_all', percent: 20, resets_at },
      { kind: 'weekly_scoped', percent: 90, resets_at, scope: { model: { display_name: 'Fable' } } },
    ] } } },
    { type: 'result', subtype: 'success', session_id, is_error: false, local_command: 'usage',
      duration_api_ms: 0, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } },
  ];
}

test('Claude usage only accepts structured local /usage with no inference or tools', () => {
  const reset = '2026-11-23T08:00:00.123456+00:00';
  const output = frames('session', reset);
  const parse = (batch: unknown[]) => parseClaudeUsage(batch.map(row => JSON.stringify(row)).join('\n'), 'session');
  assert.deepEqual(parse(output)?.rows, [
    { pool: 'default', window: '5h', remaining_percent: 60, resets_at: reset },
    { pool: 'default', window: 'weekly', remaining_percent: 80, resets_at: reset },
    { pool: 'claude / Fable', window: 'weekly', remaining_percent: 10, resets_at: reset },
  ]);
  for (const badResult of [{ duration_api_ms: 1 }, { total_cost_usd: 0.01 }, { local_command: undefined },
    { usage: { input_tokens: 0, output_tokens: 1 } }]) {
    assert.throws(() => parse([...output.slice(0, -1), { ...output.at(-1), ...badResult }]), UsageContractViolation);
  }
  assert.equal(parse([...output.slice(0, -1), { ...output.at(-1), session_id: 'other' }]), undefined);
  assert.throws(() => parse([output[0], output[1], { type: 'assistant', session_id: 'session' },
    { ...output.at(-1), duration_api_ms: 10 }]), UsageContractViolation);
  assert.equal(parse(output.slice(0, -1)), undefined);
  assert.equal(parse([output[0], { ...output[1], tools: ['Bash'] }, ...output.slice(2)]), undefined);
  output[2].usage_report!.rate_limits.limits.push({ kind: 'unmapped_window', percent: 100, resets_at: reset });
  assert.equal(parse(output)?.partial, true, 'retain known meters but suppress recovery on an unrecognized meter');
});

test('same-schedule early replenishment survives later reads and clears a quota-only cooldown with complete coverage', t => {
  const { store } = fixture(t);
  const reset = iso(60_000), before = iso(-4000), cooldown = iso(-3000), partial = iso(-2000), complete = iso(-1000);
  store.recordUsage('claude', [reading('5h', 0, reset, before)], 'reply');
  store.setCooldown('claude', reset, 'QUOTA_EXHAUSTED: session');
  store.db.prepare('UPDATE platform_state SET cooldown_started_at=? WHERE adapter_id=?').run(cooldown, 'claude');
  store.recordUsage('claude', [reading('5h', 60, reset, partial)], 'claude-usage', partial);
  const earlyObservedAt = store.usageFor('claude')[0].early_reset_observed_at;
  assert.ok(earlyObservedAt && earlyObservedAt >= partial);
  assert.equal(store.routeStatus().find(route => route.id === 'claude')?.cooldownUntil, reset, 'omitted weekly meter keeps the cooldown');
  store.recordUsage('claude', [reading('5h', 60, reset, complete), reading('weekly', 20, reset, complete)], 'claude-usage', complete);
  assert.equal(store.routeStatus().find(route => route.id === 'claude')?.cooldownUntil, null);
  store.recordUsage('claude', [reading('5h', 0, reset, partial)], 'claude-usage', partial);
  const short = store.usageFor('claude').find(window => window.window === '5h');
  assert.deepEqual([short?.remaining_percent, short?.resets_at, short?.early_reset_observed_at, short?.early_reset_scheduled_at],
    [60, reset, earlyObservedAt, reset]);
});

test('a check that started before a newer cooldown cannot reopen it', t => {
  const { store } = fixture(t);
  const reset = iso(60_000), started = iso(-3000), cooldown = iso(-2000), completed = iso(-1000);
  store.recordUsage('claude', [reading('weekly', 0, reset, iso(-4000))], 'reply');
  store.setCooldown('claude', reset, 'QUOTA_EXHAUSTED: weekly');
  store.db.prepare('UPDATE platform_state SET cooldown_started_at=? WHERE adapter_id=?').run(cooldown, 'claude');
  store.recordUsage('claude', [reading('5h', 60, reset, completed), reading('weekly', 20, reset, completed)], 'claude-usage', started);
  assert.equal(store.routeStatus().find(route => route.id === 'claude')?.cooldownUntil, reset);
});

test('an unrelated open Antigravity pool cannot clear a scoped quota cooldown', t => {
  const { store } = fixture(t);
  const reset = iso(60_000), failedAt = iso(-3000), cooldownAt = iso(-2000), reportAt = iso(-1000);
  store.recordUsage('antigravity', [reading('Weekly Limit Remaining', 0, reset, failedAt, 'Gemini Models')], 'reply');
  store.setCooldown('antigravity', reset, 'QUOTA_EXHAUSTED: Gemini Models');
  store.db.prepare('UPDATE platform_state SET cooldown_started_at=? WHERE adapter_id=?').run(cooldownAt, 'antigravity');
  store.recordUsage('antigravity', [
    reading('Gemini 4 Argon Weekly Limit', 100, reset, reportAt, 'Gemini 4 Argon'),
    reading('Weekly Limit Remaining', 0, reset, reportAt, 'Gemini Models'),
    reading('Five Hour Limit Remaining', 100, reset, reportAt, 'Gemini Models'),
  ], 'status', reportAt);
  assert.equal(store.routeStatus().find(route => route.id === 'antigravity')?.cooldownUntil, reset);
});

test('a Claude metadata command reporting model work suspends future reads for that binary identity', async t => {
  const { dir, store } = fixture(t);
  const fake = path.join(dir, 'bad-claude.mjs'), calls = path.join(dir, 'calls.txt');
  fs.writeFileSync(fake, `
    import fs from 'node:fs';
    fs.readFileSync(0, 'utf8');
    fs.appendFileSync(${JSON.stringify(calls)}, 'called\\n');
    const session = process.argv[process.argv.indexOf('--session-id') + 1];
    const output = (${frames.toString()})(session, ${JSON.stringify(iso(60_000))});
    output.at(-1).duration_api_ms = 1;
    for (const frame of output) console.log(JSON.stringify(frame));
  `);
  store.recordProbe(claude.capabilities, { state: 'verified' });
  store.db.prepare('UPDATE platform_state SET bin_selected_path=?, bin_version=? WHERE adapter_id=?')
    .run(process.execPath, '2.1.323', 'claude');
  const prober = new Prober(store, dir, { claude: { file: process.execPath, prefix: [fake] } },
    { adapters: ['claude'], schedule: false });
  await prober.refreshUsage();
  assert.equal(store.usageFor('claude').length, 0);
  assert.ok(store.platformState('claude')?.usage_blocked_identity);
  await prober.refreshUsage();
  assert.equal(fs.readFileSync(calls, 'utf8'), 'called\n');
  prober.stop();
});

test('Claude usage still detects model work within the byte limit when a trailing chunk exceeds it', async t => {
  const { dir } = fixture(t);
  const fake = path.join(dir, 'overflow-claude.mjs');
  fs.writeFileSync(fake, `
    import fs from 'node:fs';
    fs.readFileSync(0, 'utf8');
    const result = JSON.stringify({ type: 'result', subtype: 'success', duration_api_ms: 5 });
    process.stdout.write('x'.repeat(512 * 1024 - 300) + '\\n' + result + '\\n' + 'x'.repeat(1000));
  `);
  await assert.rejects(readClaudeUsage({ file: process.execPath, prefix: [fake] }), UsageContractViolation);
});

test('an exhausted newly observed Claude scope or a partial report cannot lift a cooldown', t => {
  const { store } = fixture(t);
  const reset = iso(60_000), failedAt = iso(-4000), cooldownAt = iso(-3000), reportAt = iso(-2000), partialAt = iso(-1000);
  store.recordUsage('claude', [reading('weekly', 0, reset, failedAt)], 'reply');
  store.setCooldown('claude', reset, 'QUOTA_EXHAUSTED: weekly');
  store.db.prepare('UPDATE platform_state SET cooldown_started_at=? WHERE adapter_id=?').run(cooldownAt, 'claude');
  store.recordUsage('claude', [reading('5h', 60, reset, reportAt), reading('weekly', 20, reset, reportAt),
    reading('weekly', 0, reset, reportAt, 'claude / Fable')], 'claude-usage', reportAt);
  assert.equal(store.routeStatus().find(route => route.id === 'claude')?.cooldownUntil, reset);
  store.recordUsage('claude', [reading('5h', 60, reset, partialAt), reading('weekly', 20, reset, partialAt),
    reading('weekly', 50, reset, partialAt, 'claude / Fable')], 'claude-usage', partialAt, true);
  assert.equal(store.routeStatus().find(route => route.id === 'claude')?.cooldownUntil, reset);
});

test('a poll started before a scheduled reset cannot label an increase observed after it as early', t => {
  const { store } = fixture(t);
  const reset = iso(-2000), before = iso(-4000), poll = iso(-3000);
  store.recordUsage('claude', [reading('5h', 0, reset, before)], 'claude-usage');
  store.recordUsage('claude', [reading('5h', 100, iso(60_000), poll)], 'claude-usage', poll);
  assert.equal(store.usageFor('claude')[0].early_reset_observed_at, undefined);
});

test('a rebound to already observed headroom preserves the early replenishment observation', t => {
  const { store } = fixture(t);
  const reset = iso(60_000);
  const samples = [-5000, -4000, -3000, -2000].map(iso);
  const save = (remaining: number, observed: string) =>
    store.recordUsage('claude', [reading('5h', remaining, reset, observed)], 'claude-usage', observed);
  save(1, samples[0]);
  save(60, samples[1]);
  assert.ok(store.usageFor('claude')[0].early_reset_observed_at);
  // Distinct timestamps even when the fixture completes in one millisecond.
  store.db.prepare('UPDATE usage_windows SET early_reset_observed_at=?').run(samples[1]);
  save(50, samples[2]);
  assert.equal(store.usageFor('claude')[0].remaining_percent, 50);
  save(60, samples[3]);
  assert.equal(store.usageFor('claude')[0].early_reset_observed_at, samples[1]);
});

test('a weekly-only Codex snapshot cannot clear an unidentified exhausted window', t => {
  const { store } = fixture(t);
  const reset = iso(60_000), failedAt = iso(-3000), cooldownAt = iso(-2000), reportAt = iso(-1000);
  store.recordUsage('codex', [reading('exhaustion', 0, reset, failedAt, 'codex')], 'reply');
  store.setCooldown('codex', reset, 'QUOTA_EXHAUSTED: unknown window');
  store.db.prepare('UPDATE platform_state SET cooldown_started_at=? WHERE adapter_id=?').run(cooldownAt, 'codex');
  store.recordUsage('codex', [reading('10080m', 100, reset, reportAt, 'codex')], 'app-server', reportAt);
  assert.equal(store.routeStatus().find(route => route.id === 'codex')?.cooldownUntil, reset);
  assert.ok(store.usageFor('codex').some(window => window.window === 'exhaustion'));
  store.recordUsage('codex', [reading('300m', 0, reset, failedAt, 'alternate')], 'reply');
  const next = iso(-500);
  store.recordUsage('codex', [reading('10080m', 100, reset, next, 'codex'),
    reading('300m', 100, reset, next, 'codex')], 'app-server', next);
  assert.equal(store.routeStatus().find(route => route.id === 'codex')?.cooldownUntil, reset, 'an omitted active alternate remains unverified');
});

test('polling Claude can reopen a quota-held queue without submitting a model prompt', async t => {
  const { dir, store } = fixture(t);
  const fake = path.join(dir, 'claude.mjs');
  const reset = iso(60_000);
  fs.writeFileSync(fake, `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    const args = process.argv.slice(2);
    assert.equal(fs.readFileSync(0, 'utf8'), '/usage');
    assert.equal(args[args.indexOf('--max-turns') + 1], '0');
    assert.equal(args[args.indexOf('--model') + 1], 'claude-ac-quota-metadata-only-00000000');
    for (const flag of ['--safe-mode', '--no-session-persistence', '--strict-mcp-config']) assert.ok(args.includes(flag));
    assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
    for (const frame of (${frames.toString()})(args[args.indexOf('--session-id') + 1], ${JSON.stringify(reset)})) console.log(JSON.stringify(frame));
  `);
  store.recordProbe(claude.capabilities, { state: 'verified' });
  store.db.prepare('UPDATE platform_state SET bin_selected_path=?, bin_version=? WHERE adapter_id=?').run(process.execPath, '2.1.323', 'claude');
  const projectRoot = path.join(dir, 'project');
  fs.mkdirSync(projectRoot);
  const actor = store.createActor('quota-tester', 'participant', 'quota-tester').actor;
  const project = store.call(actor, 'project_create', { name: 'Quota test', root: projectRoot, operation_id: randomUUID() }).project;
  store.call(actor, 'job_submit', { project_id: project.id, route: 'auto', prompt: 'queued job', operation_id: randomUUID() });
  store.recordUsage('claude', [reading('weekly', 0, reset, iso(-2000))], 'reply');
  store.setCooldown('claude', reset, 'QUOTA_EXHAUSTED: weekly');
  store.db.prepare('UPDATE platform_state SET cooldown_started_at=? WHERE adapter_id=?').run(iso(-1000), 'claude');
  assert.equal(store.claimQueuedJob({ claude: 1 }, 1), null, 'a route cooldown holds the runner queue');
  const prober = new Prober(store, dir, { claude: { file: process.execPath, prefix: [fake] } },
    { adapters: ['claude'], schedule: false });
  await prober.refreshUsage();
  assert.equal(store.usageFor('claude').length, 3);
  assert.equal(store.routeStatus().find(route => route.id === 'claude')?.cooldownUntil, null);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM jobs WHERE status='queued'").get()?.n, 1);
  assert.equal(store.claimQueuedJob({ claude: 1 }, 1)?.route, 'claude', 'the existing queued job is eligible again');
  prober.stop();
});

test('Codex app-server can replace a previously closed window when headroom returns before its scheduled reset', () => {
  const now = Date.now(), reset = Math.floor(now / 1000) + 1800, resets_at = new Date(reset * 1000).toISOString();
  const previous: UsageWindow = { pool: 'codex', window: '10080m', remaining_percent: 0, resets_at, closed: true,
    route: 'codex', observed_at: iso(-1000), source: 'reply', stale: false };
  const rows = parseCodexAppServerRateLimits({ rateLimits: { limitId: 'codex',
    primary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: reset } } }, [previous], now);
  assert.deepEqual([rows?.[0].remaining_percent, rows?.[0].closed, rows?.[0].resets_at], [60, false, resets_at]);
});

test('schema 22 migrates to schema 23 preserving usage_windows and adding usage_history and meta columns', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-schema23-'));
  let reopened: Store | undefined;
  t.after(() => { try { reopened?.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  const store = new Store(dir);
  const reset = iso(24 * 3600_000), seen = iso(-60_000);
  store.recordUsage('codex', [reading('10080m', 77, reset, seen, 'codex')], 'app-server');
  store.close();

  const db = new DatabaseSync(path.join(dir, 'commons.sqlite'));
  db.exec(`DROP TABLE usage_history;
    ALTER TABLE platform_state DROP COLUMN usage_account_scope;
    ALTER TABLE platform_state DROP COLUMN usage_last_error;
    ALTER TABLE platform_state DROP COLUMN usage_meta;
    PRAGMA user_version = 22;`);
  db.close();

  reopened = new Store(dir);
  assert.equal(Number((reopened.db.prepare('PRAGMA user_version').get() as any).user_version), SCHEMA_VERSION);
  assert.equal(reopened.usageFor('codex')[0]?.remaining_percent, 77);
  const cols = (reopened.db.prepare('PRAGMA table_info(platform_state)').all() as any[]).map(c => c.name);
  for (const col of ['usage_account_scope', 'usage_last_error', 'usage_meta']) assert.ok(cols.includes(col));
});

test('usage_history coalesces 5-minute buckets, tolerates 60s reset jitter, rolls over on early reset, and isolates account scopes', t => {
  const { store } = fixture(t);
  store.recordProbe(codex.capabilities, { state: 'verified' });
  const base = Date.parse('2026-11-23T12:00:00.000Z');
  const reset1 = new Date(base + 5 * 86_400_000).toISOString();
  const reset1Jitter = new Date(base + 5 * 86_400_000 + 30_000).toISOString();
  const t1 = new Date(base + 60_000).toISOString();
  const t2 = new Date(base + 120_000).toISOString(); // same 5m bucket
  const t3 = new Date(base + 6 * 60_000).toISOString(); // next 5m bucket

  store.recordUsage('codex', [reading('10080m', 90, reset1, t1, 'codex')], 'app-server');
  store.recordUsage('codex', [reading('10080m', 88, reset1Jitter, t2, 'codex')], 'app-server');
  store.recordUsage('codex', [reading('10080m', 84, reset1Jitter, t3, 'codex')], 'app-server');
  let cycles = store.usageHistory('codex', base + 7 * 60_000);
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].resets_at, reset1, '60s jitter stays on the existing cycle');
  assert.deepEqual(cycles[0].points.map(p => p.remaining_percent), [88, 84], 'same 5-minute bucket updates in place');

  // Early reset (reset moves forward AND remaining jumps >= 5%) starts a fresh cycle.
  const reset2 = new Date(base + 7 * 86_400_000).toISOString();
  const t4 = new Date(base + 10 * 60_000).toISOString();
  store.recordUsage('codex', [reading('10080m', 100, reset2, t4, 'codex')], 'app-server');
  cycles = store.usageHistory('codex', base + 11 * 60_000);
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].resets_at, reset2);
  assert.deepEqual(cycles[0].points.map(p => p.remaining_percent), [100]);

  // Changing accountScope clears prior account history and stale usage_meta.
  store.recordUsageMeta('codex', {
    accountScope: 'scope-a',
    meta: { resetCredits: { availableCount: 1, capturedAt: t4, credits: [] } },
    clearError: true,
  });
  store.recordUsage('codex', [reading('10080m', 95, reset2, new Date(base + 15 * 60_000).toISOString(), 'codex')], 'app-server');
  store.recordUsageMeta('codex', { accountScope: 'scope-b', clearError: true });
  assert.equal(store.usageHistory('codex', base + 16 * 60_000).length, 0);
  assert.equal(store.platformState('codex')?.usage_meta, null);

  // Downsampling preserves endpoints.
  const pts = Array.from({ length: 300 }, (_, i) => i);
  const sampled = downsamplePoints(pts, 240);
  assert.equal(sampled.length, 240);
  assert.equal(sampled[0], 0);
  assert.equal(sampled[sampled.length - 1], 299);
});

test('Codex app-server verifies account/read, handles legacy -32600, decodes resetCredits, and reports structured diagnostics', async t => {
  const { dir } = fixture(t);
  const nowSec = Math.floor(Date.now() / 1000);
  const resetSec = nowSec + 3 * 86400;
  const expSoonSec = nowSec + 24 * 3600;
  const expPastCaptureSec = nowSec - 60;
  const script = path.join(dir, 'codex-app.mjs');
  fs.writeFileSync(script, `
    import readline from 'node:readline';
    const mode = process.argv[2];
    const send = obj => console.log(JSON.stringify(obj));
    readline.createInterface({ input: process.stdin }).on('line', line => {
      const m = JSON.parse(line);
      if (m.method === 'initialize') return send({ id: m.id, result: {} });
      if (m.method === 'initialized') return;
      if (m.method === 'account/read') {
        if (mode === 'signed-out') return send({ id: m.id, result: { account: null, requiresOpenaiAuth: true } });
        if (mode === 'api-key') return send({ id: m.id, result: { account: { type: 'apiKey' } } });
        if (mode === 'no-account-read') return send({ id: m.id, error: { code: -32601, message: 'not found' } });
        return send({ id: m.id, result: {
          account: { type: 'chatgpt', planType: 'plus' },
          workspaceRouting: { chatgptAccountId: 'acct-A', backendOrigin: 'https://chatgpt.com' },
        } });
      }
      if (m.method === 'account/rateLimits/read') {
        if (mode === 'legacy-params' && m.params !== undefined) {
          return send({ id: m.id, error: { code: -32600, message: 'expected null params' } });
        }
        return send({ id: m.id, result: {
          accountId: mode === 'mismatch' ? 'acct-B' : 'acct-A',
          rateLimits: { limitId: 'codex', primary: { usedPercent: 20, windowDurationMins: 10080, resetsAt: ${resetSec} } },
          rateLimitResetCredits: {
            availableCount: 2,
            credits: [
              { id: 'c1', status: 'available', grantedAt: ${nowSec - 3600}, expiresAt: ${expSoonSec} },
              { id: 'c2', status: 'available', grantedAt: ${nowSec - 7200}, expiresAt: ${expSoonSec + 10 * 86400} },
            ],
          },
        } });
      }
    });
  `);

  const callMode = async (mode: string) => {
    const errors: UsageDiagnostic[] = [];
    const snap = await codex.observeUsage!({
      home: dir,
      options: { codex: { file: process.execPath, prefix: [script, mode] } },
      overrides: {},
      onUsageError: d => errors.push(d),
    });
    return { snap, errors };
  };

  const ok = await callMode('ok');
  assert.equal(ok.errors.length, 0);
  assert.ok(ok.snap?.accountScope && /^[0-9a-f]{64}$/.test(ok.snap.accountScope));
  assert.equal(ok.snap?.meta?.resetCredits?.availableCount, 2);
  const expReport = codexExpiringResets(ok.snap?.meta?.resetCredits, 3);
  assert.equal(expReport.remainingCount, 2);
  assert.equal(expReport.expiring.length, 1);
  assert.equal(expReport.expiring[0].count, 1);

  // Newly expired credit subtraction check
  const parsed = parseCodexResetCredits({
    rateLimitResetCredits: {
      availableCount: 2,
      credits: [
        { id: 'expired-since', status: 'available', grantedAt: nowSec - 7200, expiresAt: expPastCaptureSec },
        { id: 'still-live', status: 'available', grantedAt: nowSec - 7200, expiresAt: expSoonSec },
      ],
    },
  }, new Date((nowSec - 120) * 1000).toISOString());
  assert.equal(codexExpiringResets(parsed, 3, nowSec * 1000).remainingCount, 1);

  assert.equal((await callMode('legacy-params')).snap?.rows[0].remaining_percent, 80);
  assert.equal((await callMode('no-account-read')).snap?.rows[0].remaining_percent, 80);
  assert.equal((await callMode('signed-out')).errors[0]?.kind, 'signedOut');
  assert.equal((await callMode('api-key')).errors[0]?.kind, 'unsupportedAccount');
  assert.equal((await callMode('mismatch')).errors[0]?.kind, 'accountMismatch');
});

test('Prober applies failure backoff on usage errors, bypasses on forced refresh, and cleans reset timers on stop', async t => {
  const { dir, store } = fixture(t);
  const callsFile = path.join(dir, 'codex-calls.txt');
  const modeFile = path.join(dir, 'codex-mode.txt');
  fs.writeFileSync(modeFile, 'signed-out');
  const script = path.join(dir, 'prober-codex.mjs');
  const resetSec = Math.floor((Date.now() + 5 * 60_000) / 1000);
  fs.writeFileSync(script, `
    import fs from 'node:fs';
    import readline from 'node:readline';
    fs.appendFileSync(${JSON.stringify(callsFile)}, 'call\\n');
    const mode = fs.readFileSync(${JSON.stringify(modeFile)}, 'utf8').trim();
    const send = o => console.log(JSON.stringify(o));
    readline.createInterface({ input: process.stdin }).on('line', line => {
      const m = JSON.parse(line);
      if (m.method === 'initialize') return send({ id: m.id, result: {} });
      if (m.method === 'initialized') return;
      if (m.method === 'account/read') {
        if (mode === 'signed-out') return send({ id: m.id, result: { account: null, requiresOpenaiAuth: true } });
        return send({ id: m.id, result: { account: { type: 'chatgpt', planType: 'plus' }, workspaceRouting: { chatgptAccountId: 'acct-1' } } });
      }
      if (m.method === 'account/rateLimits/read') {
        return send({ id: m.id, result: { accountId: 'acct-1', rateLimits: { limitId: 'codex', primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: ${resetSec} } } } });
      }
    });
  `);

  store.recordProbe(codex.capabilities, { state: 'verified' });
  const prober = new Prober(store, dir, { codex: { file: process.execPath, prefix: [script] } }, { adapters: ['codex'], schedule: false });
  await prober.refreshUsage();
  assert.equal(fs.readFileSync(callsFile, 'utf8').trim().split('\n').length, 1);
  assert.equal(JSON.parse(store.platformState('codex')!.usage_last_error).kind, 'signedOut');

  // Non-forced refresh skips during backoff.
  await prober.refreshUsage();
  assert.equal(fs.readFileSync(callsFile, 'utf8').trim().split('\n').length, 1);

  // Forced refresh bypasses backoff and clears usage_last_error on success.
  fs.writeFileSync(modeFile, 'ok');
  await prober.refreshUsage(true);
  assert.equal(fs.readFileSync(callsFile, 'utf8').trim().split('\n').length, 2);
  assert.equal(store.platformState('codex')!.usage_last_error, null);
  assert.equal(store.usageFor('codex')[0]?.remaining_percent, 90);
  prober.stop();
});

test('parseClaudeCachedUsage parses matching account limits, falls back to summary windows, and fails closed', t => {
  const now = Date.UTC(2026, 10, 24, 6, 0, 0);
  const fetchedAtMs = now - 5 * 60_000;
  const reset = '2026-11-24T08:19:59.705981+00:00';
  const expectedObservedAt = new Date(fetchedAtMs).toISOString();

  const withLimits = JSON.stringify({
    oauthAccount: { accountUuid: 'acct-uuid-1', emailAddress: 'user@example.com' },
    cachedUsageUtilization: {
      fetchedAtMs,
      accountUuid: 'acct-uuid-1',
      utilization: {
        five_hour: { utilization: 99, resets_at: reset },
        seven_day: { utilization: 99, resets_at: reset },
        limits: [
          { kind: 'session', percent: 14, resets_at: reset, scope: null },
          { kind: 'weekly_all', percent: 7, resets_at: reset, scope: null },
          { kind: 'weekly_scoped', percent: 45, resets_at: reset, scope: { model: { display_name: 'Fable' } } },
        ],
      },
    },
  });
  const parsed = parseClaudeCachedUsage(withLimits, now);
  assert.equal(parsed?.source, 'claude-cache');
  assert.equal(parsed?.partial, false);
  assert.deepEqual(parsed?.rows, [
    { pool: 'default', window: '5h', remaining_percent: 86, resets_at: reset, observed_at: expectedObservedAt },
    { pool: 'default', window: 'weekly', remaining_percent: 93, resets_at: reset, observed_at: expectedObservedAt },
    { pool: 'claude / Fable', window: 'weekly', remaining_percent: 55, resets_at: reset, observed_at: expectedObservedAt },
  ]);

  const fallbackOnly = JSON.stringify({
    oauthAccount: { accountUuid: 'acct-uuid-1' },
    cachedUsageUtilization: {
      fetchedAtMs,
      accountUuid: 'acct-uuid-1',
      utilization: {
        five_hour: { utilization: 25, resets_at: reset },
        seven_day: { utilization: 10, resets_at: null },
        limits: [],
      },
    },
  });
  assert.deepEqual(parseClaudeCachedUsage(fallbackOnly, now)?.rows, [
    { pool: 'default', window: '5h', remaining_percent: 75, resets_at: reset, observed_at: expectedObservedAt },
    { pool: 'default', window: 'weekly', remaining_percent: 90, resets_at: null, observed_at: expectedObservedAt },
  ]);

  const partialLimits = JSON.stringify({
    oauthAccount: { accountUuid: 'acct-uuid-1' },
    cachedUsageUtilization: {
      fetchedAtMs,
      accountUuid: 'acct-uuid-1',
      utilization: {
        limits: [
          { kind: 'session', percent: 10, resets_at: reset },
          { kind: 'unmapped_future_window', percent: 50, resets_at: reset },
        ],
      },
    },
  });
  assert.equal(parseClaudeCachedUsage(partialLimits, now)?.partial, true);

  // Fail-closed cases
  assert.equal(parseClaudeCachedUsage('{bad json', now), undefined);
  assert.equal(parseClaudeCachedUsage(JSON.stringify({
    oauthAccount: { accountUuid: 'acct-a' },
    cachedUsageUtilization: { fetchedAtMs, accountUuid: 'acct-b', utilization: { five_hour: { utilization: 10, resets_at: reset } } },
  }), now), undefined);
  assert.equal(parseClaudeCachedUsage(JSON.stringify({
    cachedUsageUtilization: { fetchedAtMs, accountUuid: 'acct-b', utilization: { five_hour: { utilization: 10, resets_at: reset } } },
  }), now), undefined);
  assert.equal(parseClaudeCachedUsage(JSON.stringify({
    oauthAccount: { accountUuid: 'acct-1' },
    cachedUsageUtilization: { fetchedAtMs: now - 6 * 60 * 60 * 1000 - 1, accountUuid: 'acct-1', utilization: { five_hour: { utilization: 10, resets_at: reset } } },
  }), now), undefined);
  assert.equal(parseClaudeCachedUsage(JSON.stringify({
    oauthAccount: { accountUuid: 'acct-1' },
    cachedUsageUtilization: { fetchedAtMs: now + 61_000, accountUuid: 'acct-1', utilization: { five_hour: { utilization: 10, resets_at: reset } } },
  }), now), undefined);
  assert.equal(parseClaudeCachedUsage(JSON.stringify({
    oauthAccount: { accountUuid: 'acct-1' },
    cachedUsageUtilization: { fetchedAtMs, accountUuid: 'acct-1', utilization: { limits: [{ kind: 'session', percent: 105, resets_at: reset }] } },
  }), now), undefined);
  assert.equal(parseClaudeCachedUsage(JSON.stringify({
    oauthAccount: { accountUuid: 'acct-1' },
    cachedUsageUtilization: { fetchedAtMs, accountUuid: 'acct-1', utilization: { limits: [{ kind: 'session', percent: 10, resets_at: 'not-a-date' }] } },
  }), now), undefined);

  // readClaudeCachedUsage file handling
  const { dir } = fixture(t);
  const stateFile = path.join(dir, '.claude.json');
  fs.writeFileSync(stateFile, withLimits);
  assert.equal(readClaudeCachedUsage(stateFile, now)?.source, 'claude-cache');
  assert.equal(readClaudeCachedUsage(path.join(dir, 'missing.json'), now), undefined);
  assert.equal(readClaudeCachedUsage(null, now), undefined);
});

test('Prober falls back to claude-cache when headless /usage fails, honors UsageContractViolation, and respects recency', async t => {
  const { dir, store } = fixture(t);
  const failingCli = path.join(dir, 'fail-claude.mjs');
  fs.writeFileSync(failingCli, 'process.exit(1);\n');
  const now = Date.now();
  const reset = new Date(now + 60 * 60_000).toISOString();
  const recentMs = now - 30_000;
  const stateFile = path.join(dir, 'claude-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({
    oauthAccount: { accountUuid: 'acct-1' },
    cachedUsageUtilization: {
      fetchedAtMs: recentMs,
      accountUuid: 'acct-1',
      utilization: {
        limits: [
          { kind: 'session', percent: 20, resets_at: reset },
          { kind: 'weekly_all', percent: 10, resets_at: reset },
        ],
      },
    },
  }));

  store.recordProbe(claude.capabilities, { state: 'verified' });
  store.db.prepare('UPDATE platform_state SET bin_selected_path=?, bin_version=? WHERE adapter_id=?')
    .run(process.execPath, '2.1.325', 'claude');

  const prober = new Prober(store, dir, { claude: { file: process.execPath, prefix: [failingCli] } },
    { adapters: ['claude'], schedule: false, claudeStatePath: stateFile });
  await prober.refreshUsage();
  const rows = store.usageFor('claude');
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.source, 'claude-cache');
  assert.equal(rows.find(r => r.window === '5h')?.remaining_percent, 80);
  prober.stop();

  // Newer claude-usage reading cannot be overwritten by an older cache reading,
  // and an older cache reading cannot lift an active quota cooldown.
  const newerAt = new Date(now - 5_000).toISOString();
  const olderMs = now - 60_000;
  store.recordUsage('claude', [
    { pool: 'default', window: '5h', remaining_percent: 50, resets_at: reset, observed_at: newerAt },
    { pool: 'default', window: 'weekly', remaining_percent: 40, resets_at: reset, observed_at: newerAt },
  ], 'claude-usage', newerAt);
  store.setCooldown('claude', reset, 'QUOTA_EXHAUSTED: session');
  store.db.prepare('UPDATE platform_state SET cooldown_started_at=? WHERE adapter_id=?').run(newerAt, 'claude');

  fs.writeFileSync(stateFile, JSON.stringify({
    oauthAccount: { accountUuid: 'acct-1' },
    cachedUsageUtilization: {
      fetchedAtMs: olderMs,
      accountUuid: 'acct-1',
      utilization: {
        limits: [
          { kind: 'session', percent: 5, resets_at: reset },
          { kind: 'weekly_all', percent: 5, resets_at: reset },
        ],
      },
    },
  }));
  const proberOlder = new Prober(store, dir, { claude: { file: process.execPath, prefix: [failingCli] } },
    { adapters: ['claude'], schedule: false, claudeStatePath: stateFile });
  await proberOlder.refreshUsage();
  assert.equal(store.usageFor('claude').find(r => r.window === '5h')?.remaining_percent, 50);
  assert.equal(store.routeStatus().find(r => r.id === 'claude')?.cooldownUntil, reset);
  proberOlder.stop();

  // UsageContractViolation still suspends the binary even when claudeStatePath is valid.
  const { dir: dir2, store: store2 } = fixture(t);
  const badCli = path.join(dir2, 'bad-claude.mjs');
  fs.writeFileSync(badCli, `
    import fs from 'node:fs';
    fs.readFileSync(0, 'utf8');
    const session = process.argv[process.argv.indexOf('--session-id') + 1];
    const output = (${frames.toString()})(session, ${JSON.stringify(reset)});
    output.at(-1).duration_api_ms = 2;
    for (const frame of output) console.log(JSON.stringify(frame));
  `);
  store2.recordProbe(claude.capabilities, { state: 'verified' });
  store2.db.prepare('UPDATE platform_state SET bin_selected_path=?, bin_version=? WHERE adapter_id=?')
    .run(process.execPath, '2.1.325', 'claude');
  const proberBad = new Prober(store2, dir2, { claude: { file: process.execPath, prefix: [badCli] } },
    { adapters: ['claude'], schedule: false, claudeStatePath: stateFile });
  await proberBad.refreshUsage();
  assert.equal(store2.usageFor('claude').length, 0);
  assert.ok(store2.platformState('claude')?.usage_blocked_identity);
  proberBad.stop();
});
