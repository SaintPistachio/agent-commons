import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { openaiApi } from '../src/adapters/openai-api.ts';
import { openAICreditUsage } from '../src/adapters/openai-credits.ts';
import { openAIModelVisibility } from '../src/adapters/openai-models.ts';

const prices = { input: '1', output: '2' };
function fixture(t: TestContext) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-api-options-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, 'registry.json'), JSON.stringify({ models: {
    'gpt-6.2-sol': { capabilities: { responses: { tiers: { default: prices, batch: prices, flex: prices } } } },
    'gpt-6.1-terra': { capabilities: { responses: { tiers: { default: prices, batch: prices } } } },
    'gpt-6-luna': { capabilities: { responses: { tiers: { default: prices } } } },
    'gpt-6.2-astra': { capabilities: { responses: { tiers: { default: prices } } } },
    'gpt-test-other': { capabilities: { embeddings: {} } },
  } }));
  return {
    home,
    options: { openaiHelper: { file: process.execPath, cwd: home } },
    overrides: { openaiModelRefresh: false },
  };
}

test('API validation accepts explicit Responses models and rejects unknown or non-Responses models', t => {
  const { options } = fixture(t);
  const job = { mode: 'advice', minutes: 1, options };
  const input = { max_cost_usd: '1', purpose: 'Test validation', deliverable: 'A verdict' };
  assert.equal(openaiApi.validate({ ...input, model: 'gpt-6.1-terra' }, job).tier, 'default');
  for (const model of ['gpt-test-missing', 'gpt-test-other'])
    assert.throws(() => openaiApi.validate({ ...input, model }, job), /not a Responses model/);
});

test('API validation checks efforts and synchronous tiers against the resolved model', t => {
  const { options } = fixture(t);
  const job = { mode: 'advice', minutes: 1, options };
  const input = { model: 'gpt-6.2-sol', max_cost_usd: '1', purpose: 'Test validation', deliverable: 'A verdict' };
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max'])
    assert.equal(openaiApi.validate({ ...input, effort, tier: 'flex' }, job).tier, 'flex');
  assert.equal(openaiApi.validate({ ...input, tier: 'default' }, job).tier, 'default');
  for (const effort of ['none', 'minimal'])
    assert.throws(() => openaiApi.validate({ ...input, effort }, job), /effort must be one of/);
  for (const tier of ['batch', 'fast'])
    assert.throws(() => openaiApi.validate({ ...input, tier }, job), /tier must be default or flex/);
  const { model: _explicit, ...implicit } = input;
  assert.throws(() => openaiApi.validate({ ...implicit, tier: 'flex' }, { ...job, model: 'gpt-6.1-terra' }), /no flex pricing/);
});

test('API discovery lists registry models with efforts and tiers, and identifies automatic profiles', async t => {
  const ctx = fixture(t);
  const previousProfiles = [...openaiApi.profiles];
  const previousDefault = openaiApi.capabilities.defaultModel;
  try {
    const rows = await openaiApi.discover!(ctx);
    assert.deepEqual(rows.map(row => row.model).sort(), ['gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.2-astra', 'gpt-6.2-sol']);
    assert.deepEqual(rows.completeSources, ['registry']);
    for (const row of rows) assert.deepEqual(row.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.deepEqual(rows.find(row => row.model === 'gpt-6.2-sol')?.tiers, ['batch', 'default', 'flex']);
    assert.deepEqual(rows.find(row => row.model === 'gpt-6.1-terra')?.tiers, ['batch', 'default']);
    const visibility = openAIModelVisibility(ctx.home, ctx.home).join('\n');
    assert.match(visibility, /luna: gpt-6-luna; automatic profile seeds: fast\/min, fast\/low/);
    assert.match(visibility, /terra: gpt-6\.1-terra; automatic profile seeds:.*code\/med/);
    assert.match(visibility, /sol: gpt-6\.2-sol; automatic profile seeds:.*review\/high/);
    assert.match(visibility, /astra: gpt-6\.2-astra; automatic profile seeds:.*deep\/max/);
  } finally {
    openaiApi.profiles.splice(0, openaiApi.profiles.length, ...previousProfiles);
    openaiApi.capabilities.defaultModel = previousDefault;
  }
});

test('API usage reads injected local credits output and reports the spendable grant', async t => {
  const ctx = fixture(t);
  const script = path.join(ctx.home, 'helper.cjs');
  const credits = {
    observed_balance_usd: '80.00',
    estimated_remaining_usd: '50.00',
    spendable_estimate_after_reservations_usd: '20.00',
    grants: [
      { amount_usd: '50', remaining_usd: '0', expires_at: '2030-01-01T00:00:00Z' },
      { amount_usd: '40', expires_at: '2030-03-01T00:00:00Z' },
      { remaining_usd: '10', expires_at: '2030-02-01T00:00:00Z' },
    ],
  };
  fs.writeFileSync(script, `
if (process.argv.slice(2).join(' ') !== 'credits') process.exit(1);
process.stdout.write(${JSON.stringify(JSON.stringify(credits))});
`);
  const snapshot = await openaiApi.observeUsage!({
    ...ctx, options: { openaiHelper: { ...ctx.options.openaiHelper, prefix: [script] } },
  });
  assert.deepEqual(snapshot?.rows, [{
    pool: 'prepaid', window: 'grant', remaining_percent: 25, resets_at: '2030-02-01T00:00:00.000Z',
  }]);
  assert.match(snapshot?.source ?? '', /observed balance \$80; estimated remaining \$50; spendable after reservations \$20/);
  assert.deepEqual(openAICreditUsage({ observed_balance_usd: '0' }).rows, [{
    pool: 'prepaid', window: 'grant', remaining_percent: null, resets_at: null,
  }]);
});
