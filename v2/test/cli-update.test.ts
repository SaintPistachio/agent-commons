import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { claude } from '../src/adapters/claude.ts';
import { cliUpdateStatusLine } from '../src/adapters/cli-freshness.ts';
import type { CliBinary, CliUpdateContext, CliUpstream } from '../src/adapters/types.ts';
import { cliUpdateCommand } from '../src/cli-update-command.ts';
import { Prober } from '../src/prober.ts';
import { adapter } from '../src/adapters/registry.ts';
import { migrate } from '../src/schema.ts';
import { Store } from './fixtures/service.ts';

const route = claude.capabilities;
const copy = (version: string): CliBinary => ({ path: path.resolve(`fixture-${version}`), version, source: 'fixture' });
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

function fixture(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-cli-update-'));
  t.after(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  // Minimal v15 fixture: use the real v16 migration and Store's SQL without unrelated application setup.
  db.exec(`CREATE TABLE platform_state (
    adapter_id TEXT PRIMARY KEY, family TEXT, billing TEXT, probe_state TEXT,
    binary_sha256 TEXT, cli_version TEXT, help_sha256 TEXT, reason TEXT, last_probe_at TEXT, updated_at TEXT,
    bin_path TEXT, bin_selected_path TEXT, bin_version TEXT, bin_source TEXT, bin_installed TEXT, bin_upstream TEXT,
    cooldown_until TEXT
  );
  CREATE TABLE jobs (seq INTEGER PRIMARY KEY, id TEXT, route TEXT, status TEXT, consult_verdict TEXT, finished_at TEXT, created_at TEXT);
  CREATE TABLE projects (id TEXT PRIMARY KEY);
  CREATE TABLE tasks (id TEXT PRIMARY KEY, depends_on TEXT NOT NULL DEFAULT '[]');
  CREATE TABLE usage_windows (route TEXT, pool TEXT, window TEXT, remaining_percent REAL, resets_at TEXT, observed_at TEXT, source TEXT);
  PRAGMA user_version=15;`);
  migrate(db);
  const store = {
    db,
    transaction<T>(fn: () => T): T {
      db.exec('BEGIN IMMEDIATE');
      try { const value = fn(); db.exec('COMMIT'); return value; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    platformState: Store.prototype.platformState,
    recordProbe: Store.prototype.recordProbe,
    setCliAutoUpdate: Store.prototype.setCliAutoUpdate,
    beginCliUpdate: Store.prototype.beginCliUpdate,
    finishCliUpdate: Store.prototype.finishCliUpdate,
    jobEvents: new EventEmitter(),
    jobState: () => undefined,
    recordDiscovery: () => false,
    seedProfiles: () => {},
    recordDiscoveryFailure: () => {},
    recordDiscoverySummary: () => {},
  };
  const f = {
    installed: [copy('1.0.0')],
    upstream: { stable: '2.0.0', latest: '3.0.0-rc.1', source: 'fixture' } as CliUpstream,
    bad: new Set<string>(),
    calls: [] as CliUpdateContext[],
    scans: 0,
    run: async (ctx: CliUpdateContext) => { f.installed.push(copy(ctx.targetVersion)); },
  };
  const prober = new Prober(store, home, {}, {
    adapters: [route.id], schedule: false,
    binaries: async () => { f.scans++; return [...f.installed]; },
    upstream: async () => f.upstream,
    cliProbe: async (_id, binary) => f.bad.has(binary.version)
      ? { state: 'blocked', reason: 'missing flags' }
      : { state: 'verified', cliVersion: binary.version },
    cliUpdate: async (_id, ctx) => { f.calls.push(ctx); await f.run(ctx); },
  });
  return { db, store, f, prober, state: () => store.platformState(route.id)!, on: () => store.setCliAutoUpdate(route, true) };
}

test('daily updates are opt-in; ordinary probes never update', async t => {
  const { prober, state, f, on } = fixture(t);
  await prober.daily();
  assert.equal(state().auto_update, 0);
  on();
  await prober.probe(route.id);
  assert.equal(f.calls.length, 0);
  await prober.daily();
  assert.equal(f.calls.length, 1);
});

test('compare the stable tag with the newest installed stable, not the current selection', async t => {
  const { prober, state, f, on } = fixture(t);
  on();
  f.installed.push(copy('2.1.0+vendor-build'));
  f.bad.add('2.1.0+vendor-build');
  await prober.daily();
  assert.equal(state().bin_version, '1.0.0');
  assert.equal(f.calls.length, 0);
  f.upstream.stable = '2.1.0';
  await prober.daily();
  assert.equal(f.calls.length, 0, 'build metadata does not change precedence');
  f.upstream.stable = '2.2.0';
  await prober.daily();
  assert.equal(f.calls.length, 1);
});

test('ignore a prerelease stable tag, even when it is newer and requested with --now', async t => {
  const { prober, f, on } = fixture(t);
  on();
  f.upstream.stable = '9.0.0-beta.1';
  f.upstream.latest = '9.0.0';
  await prober.daily();
  assert.match(await prober.updateNow(route.id), /no newer stable/);
  assert.equal(f.calls.length, 0);
});

test('running and queued jobs both defer an update until a later check', async t => {
  const { db, prober, f, on } = fixture(t);
  on();
  db.prepare('INSERT INTO jobs(route,status) VALUES(?,?)').run(route.id, 'running');
  await prober.daily();
  db.prepare("UPDATE jobs SET status='queued'").run();
  assert.match(await prober.updateNow(route.id), /skipped/);
  assert.equal(f.calls.length, 0);
  db.prepare("UPDATE jobs SET status='completed'").run();
  await prober.daily();
  assert.equal(f.calls.length, 1);
});

test('success rescans and selects the new CLI, logs it, and records a durable event', async t => {
  const { db, prober, f, state, on, store } = fixture(t);
  on();
  assert.match(cliUpdateStatusLine((await prober.probe(route.id), state()), 'stable'), /pending stable: 2\.0\.0/);
  const scans = f.scans;
  f.run = async ctx => {
    assert.equal(state().last_update_result, 'running');
    assert.equal(ctx.selected?.version, '1.0.0');
    assert.equal(store.beginCliUpdate(route.id, '2.0.0', state().last_update_at, true), null);
    fs.appendFileSync(ctx.logPath, 'fixture updater output\n');
    f.installed.push(copy(ctx.targetVersion));
  };
  await prober.daily();
  assert.equal(f.scans - scans, 2);
  assert.equal(state().bin_version, '2.0.0');
  assert.equal(state().last_update_version, '2.0.0');
  assert.equal(state().last_update_result, 'success');
  assert.match(fs.readFileSync(f.calls[0].logPath, 'utf8'), /fixture updater output/);
  assert.equal(db.prepare('SELECT result FROM cli_update_events').get()?.result, 'success');
  assert.match(cliUpdateStatusLine(state(), 'stable'), /last update: success.*pending stable: none/);
});

test('a successful update limits even manual attempts for six hours', async t => {
  const { db, prober, f, on } = fixture(t);
  on();
  await prober.daily();
  f.upstream.stable = '2.1.0';
  db.prepare('UPDATE platform_state SET last_update_at=?').run(hoursAgo(5));
  assert.match(await prober.updateNow(route.id), /skipped/);
  assert.equal(f.calls.length, 1);
  db.prepare('UPDATE platform_state SET last_update_at=?').run(hoursAgo(7));
  await prober.daily();
  assert.equal(f.calls.length, 2);
});

test('a new copy that fails the probe leaves the old copy selected and records failure', async t => {
  const { db, prober, f, state, on } = fixture(t);
  on();
  f.bad.add('2.0.0');
  await prober.daily();
  assert.equal(state().probe_state, 'verified');
  assert.equal(state().bin_version, '1.0.0');
  assert.equal(state().last_update_version, '2.0.0');
  assert.match(state().last_update_result, /^failed:.*post-update probe/);
  assert.match(String(db.prepare('SELECT result FROM cli_update_events').get()?.result), /^failed:/);
  await prober.daily();
  assert.equal(f.calls.length, 1, 'a rejected installed copy still counts as installed');
});

test('an updater process failure is rescanned and cannot be retried within 24 hours', async t => {
  const { db, prober, f, state, on } = fixture(t);
  on();
  f.run = async () => { throw new Error('installer exited 1'); };
  await prober.daily();
  assert.equal(f.scans, 2);
  assert.equal(state().bin_version, '1.0.0');
  assert.match(state().last_update_result, /installer exited 1/);
  db.prepare('UPDATE platform_state SET last_update_at=?').run(hoursAgo(23));
  await prober.daily();
  await prober.updateNow(route.id);
  assert.equal(f.calls.length, 1);
  db.prepare('UPDATE platform_state SET last_update_at=?').run(hoursAgo(25));
  await prober.daily();
  assert.equal(f.calls.length, 2);
});

test('cli-update --on, --off and --now; --now does not change the persisted policy', async t => {
  const { prober, store, f, state } = fixture(t);
  const command = (on: boolean, off: boolean, now: boolean) =>
    cliUpdateCommand(claude, { on, off, now }, store, id => prober.updateNow(id));
  await assert.rejects(command(false, false, false), /exactly one/);
  await assert.rejects(command(true, false, true), /exactly one/);
  assert.match(await command(true, false, false), /auto-update on/);
  assert.equal(state().auto_update, 1);
  assert.match(await command(false, true, false), /auto-update off/);
  assert.equal(state().auto_update, 0);
  assert.match(await command(false, false, true), /success/);
  assert.equal(state().auto_update, 0);
  assert.equal(f.calls.length, 1);
});

test('turning auto-update on works for a route whose state row already exists (live regression)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-autoupdate-'));
  const store = new Store(home);
  try {
    store.recordProbe(adapter('codex')!.capabilities, { state: 'verified', cliVersion: 'codex-cli 0.164.0' });
    store.setCliAutoUpdate(adapter('codex')!.capabilities, true);
    assert.equal(store.platformState('codex')?.auto_update, 1);
    store.setCliAutoUpdate(adapter('claude')!.capabilities, true); // no row yet
    assert.equal(store.platformState('claude')?.auto_update, 1);
  } finally { store.close(); fs.rmSync(home, { recursive: true, force: true }); }
});
