// The watchdog's health line in air_sync replies (hardening plan Phase 2, decision D2).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './fixtures/service.ts';
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
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
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
