import fsSync from 'node:fs';
import { adapter } from '../src/adapters/registry.ts';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { openaiApi } from '../src/adapters/openai-api.ts';
import {
  inspectSdkSwap, readOpenAISdk, recoverInterruptedSdkSwap, sdkPython, updateOpenAISdk, wheelLock, type SdkProcessRunner,
} from '../src/adapters/openai-sdk.ts';
import { sdkSwapPath, writeSdkSwap, type SdkSwap } from '../src/adapters/sdk-swap.ts';
import { sdkStatusLine } from '../src/adapters/sdk-freshness.ts';
import { recordSdkRecovery } from '../src/prober.ts';
import { migrate } from '../src/schema.ts';
import { sdkUpdateCommand } from '../src/sdk-update-command.ts';
import { Store } from '../src/store.ts';

const route = openaiApi.capabilities.id;
const installed = '3.41.0', target = '3.57.0', tzdata = '2026.6';
const oldRequirements = '# Official SDK, Apache-2.0. Reviewed 2026-10-30 against exact upstream tag.\n' +
  `openai==${installed}\ntzdata==${tzdata}\n`;
const oldLock = `openai==${installed} --hash=sha256:${'0'.repeat(64)}\n`;

async function tempDir(t: TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-sdk-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('tracks installed SDK and stable PyPI version; ignores a prerelease', async t => {
  const root = await tempDir(t);
  const run: SdkProcessRunner = async spec => {
    assert.equal(spec.file, sdkPython(path.join(root, '.venv')));
    assert.deepEqual(spec.args, ['-c', "import importlib.metadata as m; print(m.version('openai'))"]);
    assert.equal(spec.timeoutMs, 10_000);
    return { code: 0, out: `${installed}\n` };
  };
  const pypi = (version: string): typeof fetch => async (url, init) => {
    assert.equal(url, 'https://pypi.org/pypi/openai/json');
    assert.ok(init?.signal);
    return Response.json({ info: { version } });
  };
  const stable = await readOpenAISdk(root, run, pypi(target));
  assert.deepEqual(stable, { installed, latest: target });
  const line = sdkStatusLine({ sdk_version: stable.installed, sdk_latest: stable.latest, sdk_auto_update: 1 });
  assert.match(line, /installed 3\.41\.0, latest stable 3\.57\.0; auto-update on/);
  assert.match(line, /WARN newer stable SDK 3\.57\.0/);
  const prerelease = await readOpenAISdk(root, run, pypi('3.58.0rc1'));
  assert.deepEqual(prerelease, { installed, latest: null });
  assert.doesNotMatch(sdkStatusLine({ sdk_version: prerelease.installed, sdk_latest: prerelease.latest }), /WARN/);
});

function sdkStore(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  // Start with the v16 columns used by these store methods and apply the actual migration.
  db.exec(`CREATE TABLE platform_state (
    adapter_id TEXT PRIMARY KEY, family TEXT NOT NULL, billing TEXT NOT NULL, probe_state TEXT NOT NULL,
    last_probe_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_update_result TEXT
  );
  CREATE TABLE jobs (seq INTEGER PRIMARY KEY, id TEXT, route TEXT NOT NULL, status TEXT NOT NULL, consult_verdict TEXT, finished_at TEXT, created_at TEXT);
  PRAGMA user_version=16;`);
  migrate(db);
  const store: Store = Object.assign(Object.create(Store.prototype), {
    db, jobEvents: new EventEmitter(),
    transaction<T>(action: () => T): T {
      db.exec('BEGIN IMMEDIATE');
      try { const result = action(); db.exec('COMMIT'); return result; }
      catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
    },
  });
  store.setSdkAutoUpdate(openaiApi.capabilities, false);
  assert.equal(store.recordSdkSnapshot(route, { installed, latest: target }, null), true);
  return { db, store };
}

test('SDK lease checks auto-update, blocks busy routes and rejects new work while held', t => {
  const { db, store } = sdkStore(t);
  assert.equal(store.beginSdkUpdate(route, target, null, false), null);
  for (const status of ['queued', 'running']) {
    db.prepare('INSERT INTO jobs(route,status) VALUES(?,?)').run(route, status);
    assert.equal(store.beginSdkUpdate(route, target, null, true), null);
    db.prepare('DELETE FROM jobs WHERE route=?').run(route);
  }
  db.prepare("INSERT INTO jobs(route,status) VALUES(?,'failed')").run(route);
  store.setSdkAutoUpdate(openaiApi.capabilities, true);
  const lease = store.beginSdkUpdate(route, target, null, false);
  assert.ok(lease);
  assert.equal(store.platformState(route)?.last_update_result, 'running');
  // While the lease is held, last_update_result='running' keeps claimQueuedJob from starting this route's jobs;
  // new jobs may queue and simply wait (checked by the claim tests).
  db.prepare("INSERT INTO jobs(route,status) VALUES('other','queued')").run();
  assert.equal(store.recordSdkSnapshot(route, { installed, latest: target }, null), false);
  assert.equal(store.beginSdkUpdate(route, target, lease.started, true), null);
  assert.equal(store.finishSdkUpdate(route, lease, target, 'success'), true);
  assert.equal(store.platformState(route)?.sdk_version, target);
  assert.equal(store.platformState(route)?.last_update_result, null);
  db.prepare("INSERT INTO jobs(route,status) VALUES(?,'queued')").run(route);
});

test('SDK leases honor six-hour success and daily failure limits, including --now', t => {
  const { db, store } = sdkStore(t);
  const history = (result: string, hoursAgo: number) => {
    const epoch = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
    db.prepare('UPDATE platform_state SET sdk_last_update_result=?, sdk_last_update_at=? WHERE adapter_id=?')
      .run(result, epoch, route);
    return epoch;
  };
  for (const [result, blockedAt, allowedAt] of [['success', 5.9, 6.1], ['failed: tests', 23.9, 24.1]] as const) {
    assert.equal(store.beginSdkUpdate(route, target, history(result, blockedAt), true), null);
    const lease = store.beginSdkUpdate(route, target, history(result, allowedAt), true);
    assert.ok(lease);
    assert.ok(store.finishSdkUpdate(route, lease, target, result));
  }
});

test('generates sorted, normalized, independently hashed wheel pins', async t => {
  const wheels = await tempDir(t);
  await fs.writeFile(path.join(wheels, 'Zope_Interface-7.1.0-1-py3-none-any.whl'), 'fixture one');
  await fs.writeFile(path.join(wheels, 'anyio-4.0.0-py3-none-any.whl'), 'fixture two');
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  assert.equal(await wheelLock(wheels), `anyio==4.0.0 --hash=sha256:${hash('fixture two')}\n` +
    `zope-interface==7.1.0 --hash=sha256:${hash('fixture one')}\n`);
  await fs.writeFile(path.join(wheels, 'zope.interface-7.1.0-py3-none-any.whl'), 'duplicate');
  await assert.rejects(wheelLock(wheels), /duplicate/);
});

const staleDryRun = {
  status: 'dry_run', reservation_usd: '0.01',
  reservation_admission: { status: 'blocked', error_code: 'account_costs_stale' },
};
type WheelFailure = 'digest' | 'yanked' | 'filename' | 'fetch';
async function helperFixture(t: TestContext, fail?: 'candidate' | 'promoted',
  reply: unknown = staleDryRun, wheelFailure?: WheelFailure) {
  const dir = await tempDir(t), root = path.join(dir, 'helper'), home = path.join(dir, 'AgentCommons-data');
  const venv = path.join(root, '.venv'), candidate = path.join(root, '.venv-candidate');
  const previous = path.join(root, '.venv-previous'), baseHome = path.join(dir, 'base-python');
  const cfg = `home = ${baseHome}\nversion = 3.14.6\n`;
  await fs.mkdir(venv, { recursive: true });
  await fs.mkdir(previous);
  await fs.writeFile(path.join(previous, 'marker'), 'older');
  await fs.writeFile(path.join(venv, 'marker'), installed);
  await fs.writeFile(path.join(venv, 'pyvenv.cfg'), cfg);
  await fs.writeFile(path.join(root, 'requirements.txt'), oldRequirements);
  await fs.writeFile(path.join(root, 'requirements.lock'), oldLock);
  const logPath = path.join(home, 'logs', 'sdk-update-fixture.log');
  const backup = path.join(home, 'backups', 'helper-sdk-fixture');
  const calls: string[] = [];
  const run: SdkProcessRunner = async ({ file, args, cwd, env }) => {
    assert.equal(cwd, root);
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.PIP_INDEX_URL, undefined);
    if (args[0] === '-c') {
      const folder = path.resolve(path.dirname(file), '..');
      return { code: 0, out: await fs.readFile(path.join(folder, 'marker'), 'utf8') };
    }
    if (args[2] === 'download') {
      calls.push('download');
      assert.equal(path.dirname(file), baseHome);
      for (const arg of [`openai==${target}`, `tzdata==${tzdata}`, '--only-binary=:all:'])
        assert.ok(args.includes(arg));
      const wheels = args[args.indexOf('--dest') + 1];
      assert.equal(path.relative(home, wheels).split(path.sep).length, 2);
      await fs.writeFile(path.join(wheels, `openai-${target}-py3-none-any.whl`), 'openai wheel');
      await fs.writeFile(path.join(wheels, `tzdata-${tzdata}-py2.py3-none-any.whl`), 'tzdata wheel');
    } else if (args[1] === 'venv') {
      calls.push('venv');
      assert.equal(path.dirname(file), baseHome);
      assert.equal(args[2], candidate);
      await fs.writeFile(path.join(candidate, 'pyvenv.cfg'), cfg);
    } else if (args[2] === 'install') {
      calls.push('install');
      assert.equal(file, sdkPython(candidate));
      for (const arg of ['--require-hashes', '--no-deps', '--no-index', '--find-links'])
        assert.ok(args.includes(arg));
      const lock = await fs.readFile(args[args.indexOf('--requirement') + 1], 'utf8');
      assert.match(lock, /openai==3\.57\.0 --hash=sha256:[a-f0-9]{64}/);
      await fs.writeFile(path.join(candidate, 'marker'), target);
    } else if (args[2] === 'check') {
      calls.push('pip check');
      assert.equal(file, sdkPython(candidate));
    } else if (args[1] === 'unittest') {
      assert.deepEqual(args, ['-m', 'unittest', 'discover', '-s', 'tests']);
      const phase = file === sdkPython(candidate) ? 'candidate'
        : await fs.readFile(path.join(venv, 'marker'), 'utf8') === installed ? 'restored' : 'promoted';
      assert.equal(file, sdkPython(phase === 'candidate' ? candidate : venv));
      calls.push(phase);
      if (phase === fail) return { code: 1, out: 'secret known only to subprocess' };
    } else if (args[0] === 'run.py') {
      calls.push('dry-run');
      assert.equal(file, sdkPython(candidate));
      assert.deepEqual(args.slice(0, 3), ['run.py', 'dry-run', '--request']);
      const request = JSON.parse(await fs.readFile(args[3], 'utf8'));
      assert.match(request.external_request_id, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
      assert.equal(request.model, 'gpt-6.2-sol');
      assert.equal(request.tier, 'default');
      return { code: 0, out: JSON.stringify(reply) };
    } else assert.fail('unexpected process');
    return { code: 0, out: '' };
  };
  const fetched: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    assert.ok(init?.signal);
    assert.equal(init.redirect, 'error');
    const release = String(url);
    const sdk = release === `https://pypi.org/pypi/openai/${target}/json`;
    if (!sdk) assert.equal(release, `https://pypi.org/pypi/tzdata/${tzdata}/json`);
    const name = sdk ? 'openai' : 'tzdata';
    fetched.push(name);
    if (sdk && wheelFailure === 'fetch') throw new Error('untrusted download detail');
    const filename = sdk ? `openai-${target}-py3-none-any.whl` : `tzdata-${tzdata}-py2.py3-none-any.whl`;
    return Response.json({ urls: [{
      filename: sdk && wheelFailure === 'filename' ? 'different.whl' : filename,
      yanked: sdk && wheelFailure === 'yanked',
      digests: { sha256: sdk && wheelFailure === 'digest' ? '0'.repeat(64)
        : createHash('sha256').update(`${name} wheel`).digest('hex') },
    }] });
  };
  return { root, home, venv, previous, candidate, logPath, backup, calls, fetched, run,
    update: () => updateOpenAISdk(root, { home, options: {}, overrides: {}, targetVersion: target, logPath }, run, fetcher) };
}

for (const phase of ['candidate', 'promoted'] as const) {
  test(`failure with ${phase} venv preserves or restores the installation`, async t => {
    const f = await helperFixture(t, phase);
    await assert.rejects(f.update(), /run helper tests with .* failed \(exit 1\)/);
    assert.equal(await fs.readFile(path.join(f.venv, 'marker'), 'utf8'), installed);
    assert.equal(await fs.readFile(path.join(f.previous, 'marker'), 'utf8'), 'older');
    assert.equal(await fs.readFile(path.join(f.root, 'requirements.txt'), 'utf8'), oldRequirements);
    assert.equal(await fs.readFile(path.join(f.root, 'requirements.lock'), 'utf8'), oldLock);
    await assert.rejects(fs.stat(f.candidate), { code: 'ENOENT' });
    const log = await fs.readFile(f.logPath, 'utf8');
    assert.doesNotMatch(log, /secret known only to subprocess/);
    if (phase === 'candidate') {
      await assert.rejects(fs.stat(f.backup), { code: 'ENOENT' });
      assert.ok(!f.calls.includes('dry-run'));
    } else assert.match(log, /restore previous live venv/);
  });
}

test('successful SDK update verifies both venvs and writes backup, lock and pin', async t => {
  const f = await helperFixture(t);
  await f.update();
  assert.deepEqual(f.calls, ['download', 'venv', 'install', 'pip check', 'candidate', 'dry-run', 'promoted']);
  assert.deepEqual(f.fetched, ['openai', 'tzdata']);
  await assert.rejects(fs.stat(sdkSwapPath(f.root)), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(f.venv, 'marker'), 'utf8'), target);
  assert.equal(await fs.readFile(path.join(f.previous, 'marker'), 'utf8'), installed);
  await assert.rejects(fs.stat(f.candidate), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(f.backup, 'requirements.txt'), 'utf8'), oldRequirements);
  assert.equal(await fs.readFile(path.join(f.backup, 'requirements.lock'), 'utf8'), oldLock);
  assert.match(await fs.readFile(path.join(f.root, 'requirements.txt'), 'utf8'),
    /^# Official SDK, Apache-2\.0\. Verified by AC on \d{4}-\d{2}-\d{2} \(tests \+ dry run\)\.\nopenai==3\.57\.0\ntzdata==2026\.6\n$/);
  const lock = await fs.readFile(path.join(f.root, 'requirements.lock'), 'utf8');
  assert.match(lock, /^openai==3\.57\.0 --hash=sha256:[a-f0-9]{64}\ntzdata==2026\.6 --hash=sha256:[a-f0-9]{64}\n$/);
  assert.deepEqual((await fs.readdir(f.home)).sort(), ['backups', 'logs']);
});

for (const [label, reply] of [
  ['empty object', {}],
  ['error object', { error: { code: 'account_costs_stale' } }],
  ['error on otherwise valid reply', { ...staleDryRun, error: {} }],
  ['blocked status', { ...staleDryRun, status: 'blocked' }],
  ['missing reservation', { status: 'dry_run' }],
  ['zero reservation', { ...staleDryRun, reservation_usd: '0.00' }],
  ['nondecimal reservation', { ...staleDryRun, reservation_usd: '1e2' }],
  ['other block', { ...staleDryRun, reservation_admission: { status: 'blocked', error_code: 'over_budget' } }],
] as const) {
  test(`SDK dry-run gate rejects ${label} before starting the swap`, async t => {
    const f = await helperFixture(t, undefined, reply);
    await assert.rejects(f.update(), /run local helper dry run failed/);
    assert.equal(await fs.readFile(path.join(f.venv, 'marker'), 'utf8'), installed);
    assert.equal(await fs.readFile(path.join(f.root, 'requirements.lock'), 'utf8'), oldLock);
    assert.equal(f.calls.at(-1), 'dry-run');
    await assert.rejects(fs.stat(sdkSwapPath(f.root)), { code: 'ENOENT' });
    await assert.rejects(fs.stat(f.backup), { code: 'ENOENT' });
  });
}

for (const failure of ['digest', 'yanked', 'filename', 'fetch'] as const) {
  test(`independent wheel verification rejects ${failure} before candidate creation`, async t => {
    const f = await helperFixture(t, undefined, staleDryRun, failure);
    await assert.rejects(f.update(), /verify wheel hashes against PyPI failed/);
    assert.deepEqual(f.calls, ['download']);
    assert.deepEqual(f.fetched, ['openai']);
    await assert.rejects(fs.stat(f.candidate), { code: 'ENOENT' });
    const log = await fs.readFile(f.logPath, 'utf8');
    assert.match(log, /openai-3\.57\.0-py3-none-any\.whl sha256:[a-f0-9]{64}/);
    assert.doesNotMatch(log, /untrusted download detail/);
  });
}

const newRequirements = oldRequirements.replace(installed, target);
const newLock = oldLock.replace(installed, target);
async function interruptedFixture(t: TestContext, step: SdkSwap['step'], promoted: boolean, failPromoted = false) {
  const f = await helperFixture(t, failPromoted ? 'promoted' : undefined);
  const staging = await fs.mkdtemp(path.join(f.root, '.sdk-swap-'));
  await fs.mkdir(f.backup, { recursive: true });
  await fs.writeFile(path.join(f.backup, 'requirements.txt'), oldRequirements);
  await fs.writeFile(path.join(f.backup, 'requirements.lock'), oldLock);
  await fs.rename(f.previous, path.join(staging, 'older-venv'));
  await fs.rename(f.venv, f.previous);
  await fs.mkdir(f.candidate);
  await fs.writeFile(path.join(f.candidate, 'marker'), target);
  if (promoted) await fs.rename(f.candidate, f.venv);
  await fs.writeFile(path.join(f.root, 'requirements.txt'), newRequirements);
  await fs.writeFile(path.join(f.root, 'requirements.lock'), newLock);
  await writeSdkSwap(f.root, {
    step, venv: f.venv, previous: f.previous, candidate: f.candidate, staging, backup: f.backup,
    oldVersion: installed, newVersion: target, modes: [0o644, 0o644],
  });
  return { ...f, staging };
}

test('startup recovery restores a missing live venv and both manifests without PyPI', async t => {
  // Simulate interruption after the rename, before recording "live-moved".
  const f = await interruptedFixture(t, 'previous-parked', false);
  const { store } = sdkStore(t);
  assert.ok(store.beginSdkUpdate(route, target, null, true));
  const events: unknown[] = [];
  store.jobEvents.on('sdk-recovery', event => events.push(event));
  const neverFetch: typeof fetch = async () => assert.fail('recovery must not use PyPI');
  const outcome = await inspectSdkSwap(() => readOpenAISdk(f.root, f.run, neverFetch), f.home,
    event => recordSdkRecovery(store, openaiApi.capabilities, event));
  assert.equal(outcome, 'recovered');
  assert.equal(store.platformState(route)?.sdk_last_update_result, 'recovered');
  assert.equal(store.platformState(route)?.sdk_version, installed);
  assert.equal(store.platformState(route)?.last_update_result, null);
  assert.equal(events.length, 1);
  assert.match(await fs.readFile(path.join(f.home, 'logs', 'sdk-recovery.log'), 'utf8'), /recovered SDK 3\.41\.0/);
  assert.deepEqual(f.calls, ['restored']);
  assert.equal(await fs.readFile(path.join(f.venv, 'marker'), 'utf8'), installed);
  assert.equal(await fs.readFile(path.join(f.previous, 'marker'), 'utf8'), 'older');
  assert.equal(await fs.readFile(path.join(f.root, 'requirements.txt'), 'utf8'), oldRequirements);
  assert.equal(await fs.readFile(path.join(f.root, 'requirements.lock'), 'utf8'), oldLock);
  for (const file of [f.candidate, f.staging, sdkSwapPath(f.root)])
    await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});

for (const [step, fail, keep] of [
  ['live-moved', false, false], // Promotion happened before its journal write.
  ['manifests-published', false, false], // A working venv is not a committed venv.
  ['verified', false, true],
  ['verified', true, false], // Recheck fails; the previous live venv still exists.
] as const) {
  test(`recovers promoted swap at ${step} (${fail ? 'failed recheck' : keep ? 'keep new' : 'roll back'})`, async t => {
    const f = await interruptedFixture(t, step, true, fail);
    assert.equal(await recoverInterruptedSdkSwap(f.root, f.home, f.run), 'recovered');
    assert.equal(await fs.readFile(path.join(f.venv, 'marker'), 'utf8'), keep ? target : installed);
    assert.equal(await fs.readFile(path.join(f.previous, 'marker'), 'utf8'), keep ? installed : 'older');
    assert.equal(await fs.readFile(path.join(f.root, 'requirements.txt'), 'utf8'), keep ? newRequirements : oldRequirements);
    assert.equal(await fs.readFile(path.join(f.root, 'requirements.lock'), 'utf8'), keep ? newLock : oldLock);
    assert.deepEqual(f.calls, keep ? ['promoted'] : fail ? ['promoted', 'restored'] : ['restored']);
    for (const file of [f.candidate, f.staging, sdkSwapPath(f.root)])
      await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  });
}

test('an explicit update recovers an interrupted swap but does not download in the same pass', async t => {
  const f = await interruptedFixture(t, 'live-moved', false);
  await assert.rejects(f.update(), /SDK update deferred: recovered/);
  assert.deepEqual(f.calls, ['restored']);
  assert.deepEqual(f.fetched, []);
  assert.equal(await fs.readFile(path.join(f.venv, 'marker'), 'utf8'), installed);
});

test('no swap journal and missing live venv records recovery_failed without guessing', async t => {
  const f = await helperFixture(t);
  await fs.rm(f.venv, { recursive: true });
  const { store } = sdkStore(t);
  assert.equal(await recoverInterruptedSdkSwap(f.root, f.home, f.run,
    event => recordSdkRecovery(store, openaiApi.capabilities, event)), 'recovery_failed');
  assert.equal(store.platformState(route)?.sdk_last_update_result, 'recovery_failed');
  assert.equal(store.platformState(route)?.last_update_result, 'running');
  assert.match(await fs.readFile(path.join(f.home, 'logs', 'sdk-recovery.log'), 'utf8'), /recovery_failed/);
  assert.deepEqual(f.calls, []);
  assert.equal(await fs.readFile(path.join(f.previous, 'marker'), 'utf8'), 'older');
  await assert.rejects(fs.stat(f.venv), { code: 'ENOENT' });
});

test('failed restored tests retain the journal for a later recovery', async t => {
  const f = await interruptedFixture(t, 'live-moved', false);
  const failTests: SdkProcessRunner = async spec => spec.args[1] === 'unittest'
    ? { code: 1, out: 'untrusted test output' } : f.run(spec);
  assert.equal(await recoverInterruptedSdkSwap(f.root, f.home, failTests), 'recovery_failed');
  assert.ok((await fs.stat(sdkSwapPath(f.root))).isFile());
  assert.ok((await fs.stat(f.candidate)).isDirectory());
  assert.equal(await recoverInterruptedSdkSwap(f.root, f.home, f.run), 'recovered');
  await assert.rejects(fs.stat(sdkSwapPath(f.root)), { code: 'ENOENT' });
});

test('sdk-update on/off persist the flag; now runs once without changing it', async t => {
  const { store } = sdkStore(t);
  const calls: string[] = [];
  const update = async (id: string) => { calls.push(id); return 'success'; };
  const execute = (on: boolean, off: boolean, now: boolean) =>
    sdkUpdateCommand(openaiApi, { on, off, now }, store, update);
  await assert.rejects(execute(false, false, false), /exactly one/);
  await assert.rejects(execute(true, false, true), /exactly one/);
  assert.match(await execute(true, false, false), /auto-update on/);
  assert.equal(store.platformState(route)?.sdk_auto_update, 1);
  assert.match(await execute(false, true, false), /auto-update off/);
  assert.equal(store.platformState(route)?.sdk_auto_update, 0);
  assert.match(await execute(false, false, true), /success/);
  assert.deepEqual(calls, [route]);
  assert.equal(store.platformState(route)?.sdk_auto_update, 0);
});

test('queued jobs on a route under maintenance wait: claims skip it until the update finishes', () => {
  const home = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ac-sdk-gate-'));
  const store = new Store(home);
  try {
    const actor = store.createActor('claude-desktop', 'participant', 'claude-desktop').actor;
    const root = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ac-sdk-gate-root-'));
    store.call(actor, 'project_create', { name: 'Gate', root, operation_id: randomUUID() });
    store.recordProbe(adapter('openai-api')!.capabilities, { state: 'verified' });
    const job = store.call(actor, 'job_submit', { project_id: 'p1', route: 'openai-api', prompt: 'x', cost: 'paid', max_cost_usd: 0.1,
      purpose: 'gate test', deliverable: 'none', operation_id: randomUUID() }).job;
    store.db.prepare("UPDATE platform_state SET last_update_result='running' WHERE adapter_id='openai-api'").run();
    assert.equal(store.claimQueuedJob({ 'openai-api': 1 }, 3), null, 'no claim during maintenance');
    store.db.prepare("UPDATE platform_state SET last_update_result='success' WHERE adapter_id='openai-api'").run();
    assert.equal(store.claimQueuedJob({ 'openai-api': 1 }, 3)?.id, job.id, 'claimed after maintenance');
    fsSync.rmSync(root, { recursive: true, force: true });
  } finally { store.close(); fsSync.rmSync(home, { recursive: true, force: true }); }
});
