import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { parseClaudeUsage, readClaudeUsage } from '../src/adapters/claude-usage.ts';
import { claude } from '../src/adapters/claude.ts';
import { parseCodexAppServerRateLimits } from '../src/adapters/codex-limits.ts';
import { UsageContractViolation, type UsageObservation, type UsageWindow } from '../src/adapters/types.ts';
import { Prober } from '../src/prober.ts';
import { Store } from '../src/store.ts';
import { migrate, SCHEMA_VERSION } from '../src/schema.ts';

const iso = (offset: number) => new Date(Date.now() + offset).toISOString();
const reading = (window: string, remaining: number, resets_at: string | null, observed_at: string, pool = 'default'): UsageObservation =>
  ({ window, pool, remaining_percent: remaining, resets_at, observed_at });

test('schema 22 preserves quota readings and carries forward an active schema 21 cooldown', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE platform_state (adapter_id TEXT PRIMARY KEY, cooldown_until TEXT, updated_at TEXT);
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
  const store = new Store(dir);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, store };
}

function setClaudeUsage(t: TestContext, value: '0' | '1') {
  const previous = process.env.AGENT_COMMONS_CLAUDE_USAGE;
  process.env.AGENT_COMMONS_CLAUDE_USAGE = value;
  t.after(() => {
    if (previous === undefined) delete process.env.AGENT_COMMONS_CLAUDE_USAGE;
    else process.env.AGENT_COMMONS_CLAUDE_USAGE = previous;
  });
}

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
  const unknownScope = frames('session', reset);
  const scoped = unknownScope[2].usage_report!.rate_limits.limits[2];
  scoped.scope!.model.display_name = 'Unrecognized display text';
  assert.equal(parse(unknownScope)?.partial, true);
  assert.equal(parse(unknownScope)?.rows.length, 2);
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
  setClaudeUsage(t, '0');
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
  assert.equal(fs.existsSync(calls), false, 'Claude is not started without the operator opt-in');
  process.env.AGENT_COMMONS_CLAUDE_USAGE = '1';
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
  setClaudeUsage(t, '1');
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
