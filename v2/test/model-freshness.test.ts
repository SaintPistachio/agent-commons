import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { antigravity } from '../src/adapters/antigravity.ts';
import { claude } from '../src/adapters/claude.ts';
import { Prober } from '../src/prober.ts';
import { Store } from '../src/store.ts';

function fixture(t: TestContext) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-model-freshness-'));
  const store = new Store(home);
  t.after(() => {
    store.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const write = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value));
  return { home, store, write };
}

test('Claude catalog republishing refreshes native efforts, with coalescing and last-good retention', async t => {
  const { home, store, write } = fixture(t);
  const directory = path.join(home, 'cache', 'model-catalog');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'claude.json');
  const publish = (efforts: string[]) => write(file, {
    version: 2, fetchedAt: Date.now(),
    catalog: { surface: 'cc', config: { models: [{
      id: 'claude-sonnet-5-5', section: 'main',
      runtime: { family: 'sonnet', effort_levels: efforts, default_effort: 'low' },
    }] } },
  });
  publish(['low']);
  store.recordProbe(claude.capabilities, {
    state: 'verified', binary: { path: process.execPath, version: '2.1.325', source: 'test' },
  });
  const prober = new Prober(store, home, {}, { adapters: ['claude'], cliModelHome: home, schedule: false });
  t.after(() => prober.stop());
  const model = () => store.routeModels('claude').find(row => row.model === 'claude-sonnet-5-5');
  await prober.discover('claude');
  assert.deepEqual(model()?.efforts, ['low']);

  publish(['low', 'high']);
  const pending = prober.refreshModelCatalogs();
  assert.equal(prober.refreshModelCatalogs(), pending);
  await pending;
  assert.deepEqual(model()?.efforts, ['low', 'high']);

  fs.writeFileSync(file, '{');
  await prober.refreshModelCatalogs();
  assert.match(store.modelDiscoveryState('claude')?.error, /catalog/i);
  assert.deepEqual(model()?.efforts, ['low', 'high']);
  assert.equal(model()?.miss_count, 0);

  prober.stop();
  publish(['low', 'high', 'xhigh']);
  await prober.refreshModelCatalogs();
  assert.deepEqual(model()?.efforts, ['low', 'high']);
});

test('Antigravity checks an overdue catalog when the verified route becomes idle', async t => {
  const at = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now: at });
  const { home, store, write } = fixture(t);
  const helper = path.join(home, 'fixture-helper');
  const directory = path.join(home, 'helpers', 'antigravity');
  fs.mkdirSync(helper);
  fs.mkdirSync(directory, { recursive: true });
  write(path.join(helper, 'routing-seed.json'), { profiles: [] });
  write(path.join(directory, 'catalog.json'), {
    fetched_at: new Date(at).toISOString(),
    models: [{ id: 'gemini-4-neon-low', efforts: ['low'] }],
  });
  store.recordProbe(antigravity.capabilities, { state: 'verified' });
  const prober = new Prober(store, home, {}, {
    adapters: ['antigravity'], antigravityHelperRoot: helper, schedule: false,
  });
  t.after(() => prober.stop());
  await prober.discover('antigravity');
  assert.equal(store.modelDiscoveryState('antigravity')?.error, null);
  const before = store.modelDiscoveryState('antigravity')?.last_attempt_at;
  const actor = store.createActor('catalog-operator', 'participant', 'catalog-operator').actor;
  const project = store.call(actor, 'project_create', { name: 'Inventory', root: home, operation_id: randomUUID() }).project;
  const job = store.call(actor, 'job_submit', {
    project_id: project.id, route: 'antigravity', prompt: 'fixture', operation_id: randomUUID(),
  }).job;

  t.mock.timers.setTime(at + 61 * 60 * 1000);
  await prober.refreshModelCatalogs();
  assert.equal(store.modelDiscoveryState('antigravity')?.last_attempt_at, before);

  store.db.prepare("UPDATE jobs SET status='cancelled' WHERE id=?").run(job.id);
  await prober.refreshModelCatalogs();
  assert.notEqual(store.modelDiscoveryState('antigravity')?.last_attempt_at, before);
  const refreshed = store.modelDiscoveryState('antigravity')?.last_attempt_at;
  t.mock.timers.setTime(at + 62 * 60 * 1000);
  await prober.refreshModelCatalogs();
  assert.equal(store.modelDiscoveryState('antigravity')?.last_attempt_at, refreshed);
});
