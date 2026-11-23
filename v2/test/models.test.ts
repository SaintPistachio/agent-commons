import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.ts';
import { Prober } from '../src/prober.ts';
import { antigravity } from '../src/adapters/antigravity.ts';
import { openaiApi } from '../src/adapters/openai-api.ts';
import { claude } from '../src/adapters/claude.ts';
import { codex } from '../src/adapters/codex.ts';
import type { ModelDiscoveries, ProbeContext } from '../src/adapters/types.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

function fixture(t: { after(fn: () => void): void }) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-models-'));
  const home = path.join(base, 'home');
  const helper = path.join(base, 'helper');
  const state = path.join(home, 'helpers', 'antigravity');
  fs.mkdirSync(helper, { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  const store = new Store(home);
  const write = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value));
  const ctx: ProbeContext = {
    home,
    options: { openaiHelper: { file: process.execPath, prefix: [path.join(helper, 'run.py')], cwd: helper } },
    overrides: { antigravityHelperRoot: helper, schedule: false, openaiModelRefresh: false },
  };
  t.after(() => {
    store.close();
    fs.rmSync(base, { recursive: true, force: true });
  });
  return { home, helper, state, store, write, ctx };
}

test('metadata discovery reads seed, generated routing state and catalog without running the helper', async t => {
  const f = fixture(t);
  f.write(path.join(f.helper, 'routing-seed.json'), { profiles: [
    { model: 'gemini-3.8', family: 'gemini', effort: 'high' },
    { model: 'gemini-3.8', family: 'gemini', effort: 'low' },
  ] });
  f.write(path.join(f.state, 'routing-state.json'), { profiles: [
    { model: 'gemini-3.8', effort: 'medium' },
    { model: 'gemini-3.9', family: 'gemini', effort: 'high' },
  ] });
  const catalog = path.join(f.state, 'catalog.json');
  f.write(catalog, { models: [
    { id: 'gemini-3.8', efforts: ['high'] },
    { id: 'gemini-4', family: 'gemini', efforts: ['high', 'max'] },
  ] });
  const before = fs.readFileSync(catalog, 'utf8');
  const rows = await antigravity.discover!(f.ctx);
  assert.deepEqual(rows.completeSources, ['catalog']);
  assert.equal(rows.find(row => row.model === 'gemini-3.8')?.state, 'validated');
  assert.deepEqual(rows.find(row => row.model === 'gemini-3.8')?.efforts, ['high', 'low', 'medium']);
  assert.equal(rows.find(row => row.model === 'gemini-3.9')?.state, 'discovered');
  assert.equal(rows.find(row => row.model === 'gemini-4')?.state, 'discovered');
  assert.equal(rows.find(row => row.model === 'gemini-4')?.source, 'catalog');
  assert.equal(fs.readFileSync(catalog, 'utf8'), before);

  fs.unlinkSync(catalog);
  const partial = await antigravity.discover!(f.ctx);
  assert.deepEqual(partial.completeSources, []);
  f.store.recordDiscovery('antigravity', rows);
  f.store.recordDiscovery('antigravity', partial);
  f.store.recordDiscovery('antigravity', partial);
  assert.equal(f.store.routeModels('antigravity').find(row => row.model === 'gemini-4')?.state, 'discovered');
});

test('registry discovery includes responses models, distinguishes profile preferences and runs no command', async t => {
  const f = fixture(t);
  const preferred = [...new Set(openaiApi.profiles.map(profile => profile.model).filter((model): model is string => !!model))];
  const models: Record<string, unknown> = {
    'gpt-7.2': { family: 'gpt', capabilities: { responses: {} }, efforts: ['low', 'high'] },
    'audio-only': { capabilities: { audio: {} } },
  };
  for (const model of preferred) models[model] = { family: 'gpt', capabilities: { responses: {} } };
  f.write(path.join(f.helper, 'registry.json'), { models });
  // The nonexistent run.py would fail if discovery attempted a helper command.
  const rows = await openaiApi.discover!(f.ctx);
  assert.deepEqual(rows.completeSources, ['registry']);
  // Discovery reports registry facts; the store marks the models profiles use as preferred.
  for (const model of preferred) assert.equal(rows.find(row => row.model === model)?.state, 'verified', model);
  assert.equal(rows.find(row => row.model === 'gpt-7.2')?.state, 'verified');
  // The registry's own efforts are kept; the documented API efforts are added for every Responses model.
  for (const effort of ['high', 'low']) assert.ok(rows.find(row => row.model === 'gpt-7.2')?.efforts?.includes(effort), effort);
  assert.ok(!rows.some(row => row.model === 'audio-only'));
  assert.ok(rows.every(row => row.source === 'registry'));
});

test('CLI discovery reports concrete inventory, not profile aliases, and requires a compatible CLI version', async t => {
  const f = fixture(t);
  const now = Date.now();
  const catalog = path.join(f.home, 'cache', 'model-catalog');
  fs.mkdirSync(catalog, { recursive: true });
  f.write(path.join(catalog, 'cli.json'), {
    version: 2, fetchedAt: now - 1000, staleAt: now + 3_600_000,
    catalog: { surface: 'cc', config: { models: [{
      id: 'claude-sonnet-5-5', section: 'main', min_claude_code_version: '2.0.0',
      runtime: { family: 'sonnet', effort_levels: ['high'], default_effort: 'high' },
    }] } },
  });
  f.write(path.join(f.home, 'models_cache.json'), {
    client_version: '0.171.0', fetched_at: new Date(now - 1000).toISOString(),
    models: [{ slug: 'gpt-6.2-sol', visibility: 'list', default_reasoning_level: 'high',
      supported_reasoning_levels: [{ effort: 'high' }] }],
  });
  const ctx: ProbeContext = { ...f.ctx, overrides: { ...f.ctx.overrides, cliModelHome: f.home } };
  for (const [platform, version, model, source] of [
    [claude, '2.4.0', 'claude-sonnet-5-5', 'cli-catalog'],
    [codex, '0.171.0', 'gpt-6.2-sol', 'cli-cache'],
  ] as const) {
    await assert.rejects(platform.discover!({ ...ctx, cliVersion: null }), /no verified CLI version/);
    await assert.rejects(platform.discover!({ ...ctx, cliVersion: '0.1.0' }), /foreign/);
    const rows = await platform.discover!({ ...ctx, cliVersion: version });
    assert.deepEqual(rows.map(row => [row.model, row.state, row.source, row.efforts]), [[model, 'verified', source, ['high']]]);
  }
});

test('discovery upserts, preserves first seen, updates last seen and records schema v12', t => {
  const f = fixture(t);
  const rows: ModelDiscoveries = [
    { model: 'example-1', family: 'example', efforts: ['low'], state: 'verified', source: 'registry' },
  ];
  f.store.recordDiscovery('test-route', rows);
  const first = f.store.routeModels('test-route')[0];
  f.store.db.prepare("UPDATE route_models SET last_seen_at='2000-01-01T00:00:00.000Z' WHERE route=?").run('test-route');
  f.store.recordDiscovery('test-route', [
    { ...rows[0], efforts: ['low', 'high'], state: 'validated' },
  ]);
  const updated = f.store.routeModels('test-route')[0];
  assert.equal(updated.first_seen_at, first.first_seen_at);
  assert.notEqual(updated.last_seen_at, '2000-01-01T00:00:00.000Z');
  assert.ok(Number.isFinite(Date.parse(updated.last_seen_at)));
  assert.deepEqual(updated.efforts, ['low', 'high']);
  assert.equal(updated.state, 'validated');
  assert.equal(f.store.routeModels('test-route').length, 1);
  assert.ok((f.store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version >= 12);
  assert.equal(f.store.modelDiscoveryState('test-route')?.error, null);
});

test('complete sources retire only after two misses, and seeing a model resets the count', t => {
  const f = fixture(t);
  const rows: ModelDiscoveries = [
    { model: 'example-1', state: 'verified', source: 'registry' },
  ];
  f.store.recordDiscovery('test-route', rows);
  f.store.recordDiscovery('test-route', []);
  assert.equal(f.store.routeModels('test-route')[0].state, 'verified');
  assert.equal(f.store.routeModels('test-route')[0].miss_count, 1);
  f.store.recordDiscovery('test-route', rows);
  assert.equal(f.store.routeModels('test-route')[0].miss_count, 0);
  f.store.recordDiscovery('test-route', []);
  assert.equal(f.store.routeModels('test-route')[0].state, 'verified');
  f.store.recordDiscovery('test-route', []);
  assert.equal(f.store.routeModels('test-route')[0].state, 'retired');
  f.store.recordDiscovery('test-route', rows);
  assert.equal(f.store.routeModels('test-route')[0].state, 'verified');
  assert.equal(f.store.routeModels('test-route')[0].miss_count, 0);

  f.store.recordDiscovery('other-route', [{ model: 'example-2', state: 'validated', source: 'profile' }]);
  f.store.recordDiscovery('other-route', []);
  f.store.recordDiscovery('other-route', []);
  assert.equal(f.store.routeModels('other-route')[0].state, 'validated');
});

test('preferred and all operator-set states survive automatic updates and retirement', t => {
  const f = fixture(t);
  f.store.recordDiscovery('test-route', [
    { model: 'example-1', state: 'preferred', source: 'catalog' },
    { model: 'example-2', state: 'verified', source: 'catalog' },
    { model: 'example-3', state: 'verified', source: 'catalog' },
  ]);
  f.store.setModelState('test-route', 'example-2', 'discovered');
  f.store.setModelState('test-route', 'example-3', 'retired');
  f.store.recordDiscovery('test-route', [
    { model: 'example-1', state: 'discovered', source: 'catalog' },
    { model: 'example-2', state: 'validated', source: 'catalog' },
    { model: 'example-3', state: 'preferred', source: 'catalog' },
  ]);
  f.store.recordDiscovery('test-route', []);
  f.store.recordDiscovery('test-route', []);
  assert.deepEqual(f.store.routeModels('test-route').map(row => row.state), ['preferred', 'discovered', 'retired']);
  assert.throws(() => f.store.setModelState('test-route', 'example-1', 'unknown'));
  assert.throws(() => f.store.setModelState('test-route', 'missing', 'preferred'));
});

test('freshness compares numeric dotted and dashed versions within a family and route', t => {
  const f = fixture(t);
  f.store.recordDiscovery('test-route', [
    { model: 'gemini-3.8', family: 'gemini', state: 'preferred', source: 'profile' },
    { model: 'gemini-4', family: 'gemini', state: 'discovered', source: 'catalog' },
    { model: 'gpt-6', family: 'gpt', state: 'preferred', source: 'profile' },
    { model: 'gpt-6.0', family: 'gpt', state: 'verified', source: 'registry' },
    { model: 'gpt-6.1', family: 'gpt', state: 'verified', source: 'registry' },
    { model: 'gpt-99', family: 'gpt', state: 'retired', source: 'registry' },
    { model: 'claude-opus-5-5', family: 'claude-opus', state: 'preferred', source: 'profile' },
    { model: 'claude-opus-5-6', family: 'claude-opus', state: 'validated', source: 'catalog' },
    { model: 'claude-sonnet-99', family: 'claude-sonnet', state: 'discovered', source: 'catalog' },
    { model: 'latest', state: 'preferred', source: 'profile' },
  ]);
  f.store.recordDiscovery('other-route', [
    { model: 'gpt-100', family: 'gpt', state: 'verified', source: 'registry' },
  ]);
  const warnings = f.store.newerAvailable('test-route');
  assert.equal(warnings.length, 3);
  assert.deepEqual(warnings.map(row => `${row.old} -> ${row.new}`).sort(), [
    'claude-opus-5-5 -> claude-opus-5-6',
    'gemini-3.8 -> gemini-4',
    'gpt-6 -> gpt-6.1',
  ]);
  assert.equal(warnings.find(row => row.new === 'gpt-6.1')?.state, 'verified');

  f.store.recordDiscovery('numeric-route', [
    { model: 'example-6.9', state: 'preferred', source: 'profile' },
    { model: 'example-6.10', state: 'discovered', source: 'catalog' },
  ]);
  assert.equal(f.store.newerAvailable('numeric-route')[0]?.new, 'example-6.10');
});

test('probes also discover; malformed metadata is recorded and never retires inventory', async t => {
  const f = fixture(t);
  f.write(path.join(f.helper, 'routing-seed.json'), { profiles: [] });
  const catalog = path.join(f.state, 'catalog.json');
  f.write(catalog, { models: [{ id: 'gemini-4' }] });
  const prober = new Prober(f.store, f.home, f.ctx.options,
    { ...f.ctx.overrides, adapters: ['antigravity'] });
  await prober.probeAll();
  assert.equal(f.store.routeModels('antigravity')[0]?.model, 'gemini-4');
  assert.equal(f.store.modelDiscoveryState('antigravity')?.error, null);
  fs.writeFileSync(catalog, '{invalid');
  await prober.probeAll();
  await prober.discoverAll();
  assert.ok(f.store.modelDiscoveryState('antigravity')?.error);
  assert.equal(f.store.routeModels('antigravity')[0].state, 'discovered');
  assert.equal(f.store.routeModels('antigravity')[0].miss_count, 0);
  f.write(catalog, { models: [] });
  await prober.discoverAll();
  assert.equal(f.store.modelDiscoveryState('antigravity')?.error, null);
  assert.equal(f.store.routeModels('antigravity')[0].state, 'discovered');
  await prober.discoverAll();
  assert.equal(f.store.routeModels('antigravity')[0].state, 'retired');
});

test('models CLI prints inventory and warnings, supports operator changes, and status counts warnings', t => {
  const f = fixture(t);
  f.store.recordDiscovery('test-route', [
    { model: 'example-1', family: 'example', efforts: ['low', 'high'], state: 'preferred', source: 'profile' },
    { model: 'example-2', family: 'example', efforts: ['high'], state: 'verified', source: 'registry' },
  ]);
  f.store.recordDiscovery('other-route', [
    { model: 'unrelated-1', state: 'discovered', source: 'profile' },
  ]);
  const cli = (...args: string[]) => execFileSync(process.execPath, [CLI, ...args, '--home', f.home],
    { encoding: 'utf8', timeout: 30000 });
  const output = cli('models', '--route', 'test-route');
  assert.match(output, /test-route:/);
  assert.match(output, /example-1 preferred; efforts low, high; last seen \d{4}-/);
  assert.match(output, /NEWER AVAILABLE: example-1 -> example-2 \(verified\)/);
  assert.doesNotMatch(output, /unrelated-1/);
  assert.match(cli('status'), /model freshness: 1 newer-version warning\b/);

  const changed = cli('models', '--route', 'test-route', '--set-state', 'example-2', 'retired');
  assert.match(changed, /example-2 retired/);
  assert.doesNotMatch(changed, /NEWER AVAILABLE:/);
  assert.equal(f.store.routeModels('test-route').find(row => row.model === 'example-2')?.operator_state, 1);
  assert.match(cli('status'), /model freshness: 0 newer-version warnings/);

  const inferred = cli('models', '--set-state', 'example-2', 'validated');
  assert.match(inferred, /example-2 validated/);
  assert.match(inferred, /NEWER AVAILABLE: example-1 -> example-2 \(validated\)/);
});
