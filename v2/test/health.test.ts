// The watchdog's health line in air_sync replies (hardening plan Phase 2, decision D2).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from './fixtures/service.ts';
import { codex } from '../src/adapters/codex.ts';
import { healthLine, HEALTH_FILE, STALE_MS } from '../src/health.ts';

function home(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-health-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const write = (dir: string, data: unknown) => fs.writeFileSync(path.join(dir, HEALTH_FILE), typeof data === 'string' ? data : JSON.stringify(data));

test('no health file, or no problems: no line', t => {
  const dir = home(t);
  assert.equal(healthLine(dir), null);
  write(dir, { checked_at: new Date().toISOString(), problems: [] });
  assert.equal(healthLine(dir), null);
});

test('problems are listed on one line; a stale or broken file is reported', t => {
  const dir = home(t), at = Date.now();
  write(dir, { checked_at: new Date(at).toISOString(), problems: [{ id: 'backup', text: 'last run failed (exit 1)', since: new Date(at).toISOString() }, { id: 'service', text: '/health did not answer' }] });
  assert.equal(healthLine(dir, at), '! health n=2 "backup: last run failed (exit 1) | service: /health did not answer"');
  assert.match(healthLine(dir, at + STALE_MS + 1000)!, /^! health watchdog=stale since=/);
  write(dir, '{not json');
  assert.match(healthLine(dir)!, /watchdog=unreadable/);
});

test('air_sync shows the health line in snapshots and deltas while a problem lasts', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-health-'));
  const home = path.join(dir, 'data');
  const store = new Store(home);
  t.after(() => { try { store.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  const actor = store.createActor('claude-desktop', 'participant', 'claude-desktop').actor;
  const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
  store.call(actor, 'project_create', { name: 'Repo', root: repo, operation_id: randomUUID() });
  write(home, { checked_at: new Date().toISOString(), problems: [{ id: 'backup', text: 'stale' }] });
  const first = store.call(actor, 'air_sync', { project_id: 'p1' }).air as string;
  assert.equal(first.split('\n')[1], '! health n=1 "backup: stale"');
  const delta = store.call(actor, 'air_sync', { project_id: 'p1' }).air as string;
  assert.match(delta, /^! health n=1/m);
  write(home, { checked_at: new Date().toISOString(), problems: [] });
  assert.doesNotMatch(store.call(actor, 'air_sync', { project_id: 'p1' }).air as string, /! health/);
});

test('Watch-AcHealth flags Codex banked resets expiring within ResetExpiryDays and stays quiet otherwise', t => {
  if (process.platform !== 'win32') return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-watch-reset-'));
  const backupDir = path.join(dir, 'backups'); fs.mkdirSync(backupDir);
  const store = new Store(dir);
  t.after(() => { try { store.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  store.recordProbe(codex.capabilities, { state: 'verified' });
  const nowMs = Date.now();
  store.recordUsageMeta('codex', {
    meta: {
      resetCredits: {
        availableCount: 1,
        capturedAt: new Date(nowMs - 60_000).toISOString(),
        credits: [{ id: 'r1', status: 'available', grantedAt: new Date(nowMs - 3600_000).toISOString(), expiresAt: new Date(nowMs + 24 * 3600_000).toISOString() }],
      },
    },
  });
  store.close();

  const script = fileURLToPath(new URL('../scripts/automation/Watch-AcHealth.ps1', import.meta.url));
  execFileSync('pwsh', ['-NoProfile', '-File', script, '-DataRoot', dir, '-Destination', backupDir, '-Url', 'http://127.0.0.1:1', '-NoToast'], { stdio: 'pipe' });
  const first = JSON.parse(fs.readFileSync(path.join(dir, HEALTH_FILE), 'utf8'));
  assert.ok(first.problems.some((p: any) => p.id === 'codex-reset-expiry'), 'expiring reset within 3 days is flagged');

  const reopened = new Store(dir);
  reopened.recordUsageMeta('codex', {
    meta: {
      resetCredits: {
        availableCount: 1,
        capturedAt: new Date(nowMs - 60_000).toISOString(),
        credits: [{ id: 'r1', status: 'available', grantedAt: new Date(nowMs - 3600_000).toISOString(), expiresAt: new Date(nowMs + 10 * 86_400_000).toISOString() }],
      },
    },
  });
  reopened.close();

  execFileSync('pwsh', ['-NoProfile', '-File', script, '-DataRoot', dir, '-Destination', backupDir, '-Url', 'http://127.0.0.1:1', '-NoToast'], { stdio: 'pipe' });
  const second = JSON.parse(fs.readFileSync(path.join(dir, HEALTH_FILE), 'utf8'));
  assert.ok(!second.problems.some((p: any) => p.id === 'codex-reset-expiry'), 'reset expiring in 10 days is not flagged');
});

test('Watch-AcHealth reports a backup run whose last status line failed, and clears it after a good run', t => {
  if (process.platform !== 'win32') return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-watch-backup-run-'));
  const backupDir = path.join(dir, 'backups'); fs.mkdirSync(backupDir);
  new Store(dir).close();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runLog = path.join(backupDir, '_offdrive-backup.log');
  const script = fileURLToPath(new URL('../scripts/automation/Watch-AcHealth.ps1', import.meta.url));
  const cloudDir = path.join(dir, 'cloud'); fs.mkdirSync(cloudDir);
  const run = (cloud = false) => {
    execFileSync('pwsh', ['-NoProfile', '-File', script, '-DataRoot', dir, '-Destination', backupDir, '-Url', 'http://127.0.0.1:1', '-NoToast',
      ...(cloud ? ['-CloudDestination', cloudDir] : [])], { stdio: 'pipe' });
    return JSON.parse(fs.readFileSync(path.join(dir, HEALTH_FILE), 'utf8')).problems.find((p: any) => p.id === 'backup-run');
  };
  const failed = '2026-11-25T02:30:04 off-drive ok: copied\n2026-11-25T02:30:09 failed: cli.ts bundle command failed (exit 1)\n';
  fs.writeFileSync(runLog, failed + 'continuation\n'.repeat(60));
  assert.match(run()?.text ?? '', /last backup run failed at 2026-11-25T02:30:09: cli\.ts bundle command failed/, 'found past later non-status lines');

  // With a cloud destination the off-drive step alone does not clear the failure; the cloud step does.
  fs.appendFileSync(runLog, '2026-11-25T10:20:00 off-drive ok: copied\n');
  assert.ok(run(true), 'cloud step of the new run has not finished');
  assert.equal(run(), undefined, 'without a cloud destination the off-drive step ends the run');
  fs.appendFileSync(runLog, '2026-11-25T10:20:20 cloud ok: verified x\n');
  assert.equal(run(true), undefined);
});
