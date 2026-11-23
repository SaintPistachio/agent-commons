import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { claude, claudeArgs } from '../src/adapters/claude.ts';
import { codex, codexArgs } from '../src/adapters/codex.ts';
import { codexLimits } from '../src/adapters/codex-limits.ts';
import { catalogDiscoveries, catalogStatus, chooseClaudeModel, chooseCodexModel,
  cliEfforts, queuedCliSelection, readClaudeModels, readCodexModels } from '../src/adapters/cli-models.ts';
import type { ModelChoiceRequest, ProbeContext, UsageWindow } from '../src/adapters/types.ts';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-20T12:00:00Z');
const codexVersion = '0.171.0';
const claudeVersion = '2.4.0';
const base: ModelChoiceRequest = { intent: 'code', eff: 'med', model: null, effort: 'medium', explicitModel: false,
  explicitEffort: false, tracksLatest: true, allowPremium: false };

function codexModel(slug: string, levels = ['low', 'medium', 'high'], visibility = 'list') {
  return { slug, display_name: slug, visibility, default_reasoning_level: levels[0],
    supported_reasoning_levels: levels.map(effort => ({ effort })) };
}
function claudeModel(id: string, family: string, levels = ['low', 'medium', 'high', 'xhigh', 'max'], minimum = '2.0.0', section = 'main') {
  return { id, section, min_claude_code_version: minimum,
    runtime: { family, effort_levels: levels, default_effort: levels[0] } };
}
function fixture(cleanup: (fn: () => void) => void) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-cli-models-'));
  cleanup(() => fs.rmSync(home, { recursive: true, force: true }));
  const catalog = path.join(home, 'cache', 'model-catalog');
  fs.mkdirSync(catalog, { recursive: true });
  const codexModels = [
    codexModel('gpt-6.9-sol'), codexModel('gpt-6.10-sol', ['low', 'medium', 'high', 'xhigh', 'ultra']),
    codexModel('gpt-7.1-sol', ['high'], 'hide'), codexModel('gpt-6-luna'),
    codexModel('gpt-6.1-terra'), codexModel('gpt-6.2-astra', ['low', 'medium', 'high', 'max']),
  ];
  const claudeModels = [
    claudeModel('claude-sonnet-5-4', 'sonnet', ['low', 'medium', 'high']),
    claudeModel('claude-sonnet-5-5', 'sonnet'), claudeModel('claude-haiku-5-5', 'haiku'),
    claudeModel('claude-opus-5-5', 'opus'), claudeModel('claude-fable-5-2', 'fable'),
    claudeModel('claude-opus-4-6', 'opus', ['low', 'medium'], '2.0.0', 'overflow'),
  ];
  const writeCodex = (patch: Record<string, unknown> = {}) => fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({
    client_version: codexVersion, fetched_at: new Date(NOW - HOUR).toISOString(), models: codexModels, ...patch,
  }));
  const writeClaude = (file: string, surface: string, models = claudeModels, patch: Record<string, unknown> = {}) =>
    fs.writeFileSync(path.join(catalog, file), JSON.stringify({
      version: 2, fetchedAt: NOW - HOUR, staleAt: NOW + HOUR, catalog: { surface, config: { models } }, ...patch,
    }));
  const ctx = (cliVersion: string): ProbeContext => ({ home, cliVersion, options: {}, overrides: { cliModelHome: home } });
  return { home, codexModels, claudeModels, writeCodex, writeClaude, ctx };
}

test('Codex cache requires an exact core and prerelease match and a non-future fetch within 24h', t => {
  const f = fixture(fn => t.after(fn));
  f.writeCodex();
  const foreign = readCodexModels('0.164.0', f.home, NOW);
  assert.equal(foreign.state, 'foreign');
  assert.match(catalogStatus(foreign, NOW), /age 60m; producer 0\.171\.0; using 0\.164\.0/);
  assert.throws(() => catalogDiscoveries(foreign), /foreign/);
  assert.equal(readCodexModels(null, f.home, NOW).state, 'stale');
  assert.equal(readCodexModels(codexVersion, f.home, NOW).state, 'trusted');
  assert.equal(readCodexModels(codexVersion, f.home, NOW + 24 * HOUR).state, 'stale');
  assert.equal(readCodexModels(codexVersion, f.home, NOW - 2 * HOUR).state, 'stale');
  f.writeCodex({ client_version: `${codexVersion}-alpha.1` });
  assert.equal(readCodexModels(codexVersion, f.home, NOW).state, 'foreign');
  assert.equal(readCodexModels(`${codexVersion}-alpha.2`, f.home, NOW).state, 'foreign');
  assert.equal(readCodexModels(`${codexVersion}-alpha.1+build`, f.home, NOW).state, 'trusted');
});

test('Claude uses the freshest cc or ccd catalog, honors the 24 h rule, and checks the minimum CLI for every model', t => {
  const f = fixture(fn => t.after(fn));
  // A desktop (ccd) catalog with models counts: CLI support is checked per model through min_claude_code_version.
  f.writeClaude('desktop.json', 'ccd', [], { fetchedAt: NOW });
  assert.equal(readClaudeModels(claudeVersion, f.home, NOW).state, 'stale', 'an empty catalog is not trusted');
  f.writeClaude('desktop.json', 'ccd', f.claudeModels, { fetchedAt: NOW - HOUR });
  assert.equal(readClaudeModels(claudeVersion, f.home, NOW).state, 'trusted');
  f.writeClaude('cli.json', 'cc');
  const trusted = readClaudeModels(claudeVersion, f.home, NOW);
  assert.equal(trusted.state, 'trusted');
  assert.equal(trusted.models.length, f.claudeModels.length);
  assert.match(catalogStatus(trusted, NOW), /producer surface cc; using 2\.4\.0; highest model minimum 2\.0\.0/);
  assert.equal(readClaudeModels('2.0.0-rc.1', f.home, NOW).state, 'foreign');
  f.writeClaude('cli.json', 'cc', [...f.claudeModels, claudeModel('claude-opus-6-0', 'opus', ['low'], '2.5.0', 'overflow')]);
  assert.equal(readClaudeModels(claudeVersion, f.home, NOW).state, 'foreign');
  // staleAt is only Claude Code's refresh hint; a catalog fetched within 24 h stays trusted.
  f.writeClaude('cli.json', 'cc', f.claudeModels, { staleAt: NOW });
  assert.equal(readClaudeModels(claudeVersion, f.home, NOW).state, 'trusted');
  // The freshest catalog decides: an old CLI catalog with a fresh desktop one is trusted; both old is stale.
  f.writeClaude('cli.json', 'cc', f.claudeModels, { fetchedAt: NOW - 25 * HOUR });
  assert.equal(readClaudeModels(claudeVersion, f.home, NOW).state, 'trusted');
  f.writeClaude('desktop.json', 'ccd', f.claudeModels, { fetchedAt: NOW - 26 * HOUR });
  assert.equal(readClaudeModels(claudeVersion, f.home, NOW).state, 'stale');
});

test('adapter discovery includes hidden and overflow entries and rejects non-authoritative snapshots', async t => {
  const f = fixture(fn => t.after(fn));
  const now = Date.now();
  f.writeCodex({ fetched_at: new Date(now - 1000).toISOString() });
  f.writeClaude('cli.json', 'cc', f.claudeModels, { fetchedAt: now - 1000, staleAt: now + HOUR });
  const codexRows = await codex.discover!(f.ctx(codexVersion));
  assert.equal(codexRows.length, f.codexModels.length);
  assert.equal(codexRows.find(row => row.model === 'gpt-7.1-sol')?.hidden, true);
  assert.deepEqual(codexRows.find(row => row.model === 'gpt-6.10-sol')?.efforts, ['low', 'medium', 'high', 'xhigh', 'ultra']);
  assert.deepEqual(codexRows.completeSources, ['cli-cache', 'cli-cache:hidden']);
  const claudeRows = await claude.discover!(f.ctx(claudeVersion));
  assert.equal(claudeRows.length, f.claudeModels.length);
  assert.equal(claudeRows.find(row => row.model === 'claude-opus-4-6')?.state, 'verified');
  assert.ok([...claudeRows, ...codexRows].every(row => row.state === 'verified'));
  await assert.rejects(codex.discover!(f.ctx('0.164.0')), /foreign/);
  await assert.rejects(claude.discover!(f.ctx('1.0.0')), /foreign/);
  f.writeCodex({ fetched_at: new Date(now - 1000).toISOString(), models: [{}] });
  await assert.rejects(codex.discover!(f.ctx(codexVersion)), /invalid model entry/);
});

test('Codex resolves visible newest slugs with trusted metadata and delegates the model on fallback', t => {
  const f = fixture(fn => t.after(fn));
  f.writeCodex();
  const cache = readCodexModels(codexVersion, f.home, NOW);
  const choose = (request: Partial<ModelChoiceRequest>) => chooseCodexModel({ ...base, ...request }, cache);
  assert.deepEqual(choose({}), { model: 'gpt-6.1-terra', effort: 'medium', source: 'cli-cache' });
  assert.equal(choose({ intent: 'fast', eff: 'min', effort: cliEfforts.min }).model, 'gpt-6-luna');
  assert.equal(choose({ intent: 'fast', eff: 'low', effort: cliEfforts.low }).model, 'gpt-6-luna');
  assert.equal(choose({ intent: 'fast' }).model, 'gpt-6-luna');
  assert.equal(choose({ eff: 'max', effort: cliEfforts.max }).model, 'gpt-6.2-astra');
  assert.equal(choose({ tracksLatest: false, model: 'gpt-6.1-terra' }).model, 'gpt-6.1-terra');
  assert.equal(choose({ explicitModel: true, model: 'gpt-7.1-sol', effort: 'high' }).model, 'gpt-7.1-sol');
  for (const effort of ['xhigh', 'ultra']) assert.equal(choose({ effort, explicitEffort: true }).effort, effort);
  assert.match(choose({ model: 'gpt-6-luna', explicitModel: true, effort: 'ultra', explicitEffort: true }).error ?? '', /unsupported effort/);
  const foreign = readCodexModels('0.164.0', f.home, NOW);
  assert.deepEqual(chooseCodexModel({ ...base, eff: 'max', effort: 'max' }, foreign), {
    model: null, effort: 'high', source: { state: 'fallback', reason: catalogStatus(foreign) },
  });
  const queued = { model: 'gpt-6.10-sol', effort: 'max', req_eff: 'max' };
  assert.match(queuedCliSelection(cache, queued).error ?? '', /no longer supported/);
  const dispatched = queuedCliSelection(foreign, queued);
  assert.equal(dispatched.model, null);
  assert.equal(dispatched.effort, 'high');
  assert.equal(dispatched.fallback?.state, 'fallback');
  assert.ok(!codexArgs({ file: 'codex' }, dispatched, '/project', '/job').includes('-m'));

  const explicit = { ...queued, options: { cli_explicit_model: true, cli_explicit_effort: true } };
  const explicitDispatch = queuedCliSelection(foreign, explicit);
  assert.equal(explicitDispatch.model, queued.model);
  assert.equal(explicitDispatch.effort, queued.effort);
  assert.equal(explicitDispatch.fallback?.state, 'fallback');
  const argv = codexArgs({ file: 'codex', prefix: ['stub'] }, { ...choose({ effort: 'ultra', explicitEffort: true }), mode: 'advice' }, '/project', '/job');
  assert.deepEqual(argv.slice(-4), ['-m', 'gpt-6.10-sol', '-c', 'model_reasoning_effort="ultra"']);
  assert.ok(argv.includes('--json'));
});

test('Claude uses aliases for tracked profiles, validates against the newest release, and never infers Fable', t => {
  const f = fixture(fn => t.after(fn));
  f.writeClaude('cli.json', 'cc');
  const catalog = readClaudeModels(claudeVersion, f.home, NOW);
  const choose = (request: Partial<ModelChoiceRequest>) => chooseClaudeModel({ ...base, ...request }, catalog);
  assert.equal(choose({ intent: 'fast', eff: 'low', effort: 'low' }).model, 'haiku');
  assert.equal(choose({}).model, 'sonnet');
  assert.equal(choose({ intent: 'review' }).model, 'opus');
  assert.equal(choose({ intent: 'deep' }).model, 'opus');
  assert.equal(choose({ eff: 'max', effort: 'max' }).model, 'opus');
  assert.equal(choose({ allowPremium: true, eff: 'max', effort: 'max' }).model, 'opus');
  assert.equal(choose({ allowPremium: true, entitledModels: new Set(['fable']), eff: 'max', effort: 'max' }).model, 'fable');
  const choice = choose({ effort: 'xhigh', explicitEffort: true });
  assert.equal(choice.effort, 'xhigh');
  const pinned = choose({ model: 'claude-sonnet-5-4', tracksLatest: false, effort: 'xhigh', explicitEffort: true });
  assert.match(pinned.error ?? '', /unsupported effort/);
  assert.deepEqual(claudeArgs({ file: 'claude' }, { ...choice, mode: 'advice' }).slice(-4),
    ['--model', 'sonnet', '--effort', 'xhigh']);
  const stale = readClaudeModels(claudeVersion, f.home, NOW + 25 * HOUR);
  const source = { state: 'fallback', reason: catalogStatus(stale) };
  const fallback = chooseClaudeModel(base, stale);
  assert.deepEqual(fallback, { model: null, effort: 'medium', source });
  assert.ok(!claudeArgs({ file: 'claude' }, fallback).includes('--model'));
  assert.deepEqual(chooseClaudeModel({ ...base, model: 'opus', explicitModel: true }, stale),
    { model: 'opus', effort: 'medium', source });
});

test('Codex windows and evidence use first/last readings and do not compare across resets', () => {
  const reset = NOW / 1000 + 3600;
  const window = (used_percent: number, window_minutes: number, resets_at = reset) => ({ used_percent, window_minutes, resets_at });
  const result = codexLimits([
    { rate_limits: { limit_id: 'codex', primary: window(10, 300), secondary: window(30, 10080) } },
    { payload: { rate_limits: { limit_id: 'premium', primary: window(5, 300), secondary: null } } },
    { rate_limits: { limit_id: 'codex', primary: window(12.5, 300), secondary: window(1, 10080, reset + 3600) } },
    { rate_limits: { limit_id: 'premium', primary: window(5, 300), secondary: { used_percent: 101, window_minutes: 10080 } } },
  ], [], NOW);
  assert.equal(result.cooldownUntil, null);
  assert.deepEqual(result.usage.find(row => row.pool === 'codex' && row.window === '300m'), {
    pool: 'codex', window: '300m', remaining_percent: 87.5, resets_at: new Date(reset * 1000).toISOString(), closed: false,
  });
  assert.deepEqual(result.evidence, [
    { pool: 'codex', window: '300m', consumed: true },
    { pool: 'premium', window: '300m', consumed: false },
  ]);
  assert.equal(codex.usage!({ usage: result.usage }), result.usage);
  assert.deepEqual(codex.consumption!({ consumption: { family: 'sol', rows: result.evidence } }),
    { family: 'sol', rows: result.evidence });
});

test('Codex cools down only after every observed pool closes and reopens at the first pool reset', () => {
  const inSeconds = NOW / 1000;
  const event = (limit_id: string, expires: number, type: string | null) => ({ rate_limits: { limit_id,
    primary: { used_percent: 90, window_minutes: 300, resets_at: inSeconds + expires }, secondary: null,
    rate_limit_reached_type: type } });
  const first = codexLimits([event('codex', 7200, 'usage_limit'), event('premium', 3600, null)], [], NOW);
  assert.equal(first.reached, true);
  assert.equal(first.usage.find(row => row.pool === 'codex')?.closed, true);
  assert.equal(first.usage.find(row => row.pool === 'codex')?.remaining_percent, 10);
  assert.equal(first.cooldownUntil, null);
  const previous: UsageWindow[] = first.usage.map(row => ({ ...row, route: 'codex', source: 'reply',
    observed_at: new Date(NOW).toISOString(), stale: false }));
  const second = codexLimits([event('premium', 3600, 'usage_limit'), event('codex', 7200, null)], previous, NOW);
  assert.equal(second.cooldownUntil, new Date(NOW + HOUR).toISOString());
  assert.equal(codexLimits([event('premium', 3600, 'usage_limit')], previous, NOW + HOUR).cooldownUntil, null);
  assert.equal(codexLimits([event('premium', 3600, 'usage_limit'), { rate_limits: { limit_id: 'new-pool' } }], previous, NOW).cooldownUntil, null);
});
