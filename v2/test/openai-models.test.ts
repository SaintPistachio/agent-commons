import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import {
  newestOpenAILines, openAIProfileSeeds, parseOpenAIModelIndex, parseOpenAIModelPage,
  parseOpenAIPricing, readOpenAIModelStatus, synchronizeOpenAIModels, type PageFetch,
} from '../src/adapters/openai-models.ts';
import { openaiApi } from '../src/adapters/openai-api.ts';
import { Store } from './fixtures/service.ts';
import { Prober } from '../src/prober.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

// Trimmed copies of the supplied 2026-11-20 official Markdown token tables.
const PRICING = `# Pricing

### Standard pricing data

| Model | Short context input | Short context output | Short context cached input | Short context 30m write | Short context 12h write | Long context input | Long context output | Long context cached input | Long context 30m write | Long context 12h write |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gpt-6.2-astra | $8.00 | $40.00 | $0.40 | $10.00 | $20.00 | $16.00 | $60.00 | $0.80 | $20.00 | $40.00 |
| gpt-6.2-sol | $2.00 | $10.00 | $0.10 | $2.50 | $5.00 | $4.00 | $15.00 | $0.20 | $5.00 | $10.00 |
| gpt-6.1-sol | $2.00 | $10.00 | $0.10 | $2.50 | $5.00 | $4.00 | $15.00 | $0.20 | $5.00 | $10.00 |
| gpt-6-luna | $0.10 | $0.50 | $0.01 | $0.125 | $0.25 | $0.20 | $0.75 | $0.02 | $0.25 | $0.50 |

### Batch pricing data

| Model | Short context input | Short context output | Short context cached input | Short context 30m write | Short context 12h write | Long context input | Long context output | Long context cached input | Long context 30m write | Long context 12h write |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gpt-6.2-astra | $4.00 | $20.00 | $0.20 | $5.00 | $10.00 | $8.00 | $30.00 | $0.40 | $10.00 | $20.00 |
| gpt-6.2-sol | $1.00 | $5.00 | $0.05 | $1.25 | $2.50 | $2.00 | $7.50 | $0.10 | $2.50 | $5.00 |
| gpt-6.1-sol | $1.00 | $5.00 | $0.05 | $1.25 | $2.50 | $2.00 | $7.50 | $0.10 | $2.50 | $5.00 |
| gpt-6-luna | $0.05 | $0.25 | $0.005 | $0.0625 | $0.125 | $0.10 | $0.375 | $0.01 | $0.125 | $0.25 |

### Flex pricing data

| Model | Short context input | Short context output | Short context cached input | Short context 30m write | Short context 12h write | Long context input | Long context output | Long context cached input | Long context 30m write | Long context 12h write |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gpt-6.1-sol | $1.00 | $5.00 | $0.05 | $1.25 | $2.50 | $2.00 | $7.50 | $0.10 | $2.50 | $5.00 |
| gpt-6-luna | $0.05 | $0.25 | $0.005 | $0.0625 | $0.125 | $0.10 | $0.375 | $0.01 | $0.125 | $0.25 |

### Fast pricing data

| Model | Input | Output | Cached input |
| --- | --- | --- | --- |
| gpt-6.2-sol | $4.00 | $20.00 | $0.20 |

Short context: ≤272K input tokens. Long context: >272K input tokens.
`;

const INDEX = `# Models

- [GPT-6.2 Astra](/api/docs/models/gpt-6.2-astra.md): Our most capable model.
- [GPT-6.2 Sol](/api/docs/models/gpt-6.2-sol.md): Our go-to model.
- [GPT-6.1 Sol](/api/docs/models/gpt-6.1-sol.md): Near-Astra performance.
- [GPT-6 Luna](/api/docs/models/gpt-6-luna.md): Our most efficient model.
`;

// The supplied Sol page is the evidence for these limits.
const SOL = `# GPT-6.2 Sol

Model ID: \`gpt-6.2-sol\`

## Model details

- Input modalities: text, image
- Output modalities: text
- 1,050,000 context window
- Maximum input tokens: 922,000
- 128,000 max output tokens

For requests with more than 272K input tokens, input and cache rates double.

## Endpoints

| Endpoint | Route | Support |
| --- | --- | --- |
| Chat Completions | \`v1/chat/completions\` | Supported |
| Responses | \`v1/responses\` | Supported |
`;

// Other pages are explicitly mock-server data, not claims about unprovided official pages.
// Production always fetches and verifies each model's own page.
function mockPage(model: string): string {
  return SOL.replaceAll('gpt-6.2-sol', model);
}

const FIELDS = ['input', 'instructions', 'max_output_tokens', 'reasoning', 'text', 'prompt_cache_options', 'prompt_cache_key'];
const SOL_DEFAULT = { input: '2', output: '10', cache_read: '0.1', cache_write_30m: '2.5', cache_write_12h: '5' };
const SOL_BATCH = { input: '1', output: '5', cache_read: '0.05', cache_write_30m: '1.25', cache_write_12h: '2.5' };
const SOL_LONG = { input: '4', output: '15', cache_read: '0.2', cache_write_30m: '5', cache_write_12h: '10' };
const SOL_BATCH_LONG = { input: '2', output: '7.5', cache_read: '0.1', cache_write_30m: '2.5', cache_write_12h: '5' };

function seedRegistry() {
  return {
    'gpt-6.1-sol': {
      capabilities: {
        responses: {
          endpoint: '/v1/responses',
          verified_at: '2026-11-20',
          tiers: { default: SOL_DEFAULT, batch: SOL_BATCH, flex: SOL_BATCH },
          long_context_threshold: 272000,
          long_context_rates: { default: SOL_LONG, batch: SOL_BATCH_LONG, flex: SOL_BATCH_LONG },
          max_input_tokens: 922000,
          max_output_tokens: 128000,
          allowed_fields: FIELDS,
          input_modalities: ['text'],
          cache_ttls: ['30m', '12h'],
          sources: ['https://developers.openai.com/api/docs/pricing'],
        },
      },
    },
  };
}

function fixture(t: { after(fn: () => void): void }) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-openai-models-'));
  const root = path.join(base, 'helper');
  const home = path.join(base, 'AgentCommons-data');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const registry = path.join(root, 'registry.json');
  fs.writeFileSync(registry, JSON.stringify(seedRegistry(), null, 2));
  const pages = new Map<string, string>([
    ['/api/docs/pricing.md', PRICING],
    ['/api/docs/models.md', INDEX],
    ...['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.1-sol', 'gpt-6-luna']
      .map(model => [`/api/docs/models/${model}.md`, mockPage(model)] as [string, string]),
  ]);
  const requests: string[] = [];
  const fetch: PageFetch = async (url, init) => {
    requests.push(url);
    assert.equal((init?.headers as Record<string, string>)['User-Agent'], 'AgentCommons/2');
    assert.ok(init?.signal);
    const page = pages.get(new URL(url).pathname);
    return new Response(page ?? 'not found', { status: page === undefined ? 404 : 200 });
  };
  const now = () => new Date('2026-11-20T12:00:00.000Z');
  const read = () => JSON.parse(fs.readFileSync(registry, 'utf8'));
  const cleanups: Array<() => void> = [];
  t.after(() => {
    for (const cleanup of cleanups.reverse()) cleanup();
    fs.rmSync(base, { recursive: true, force: true });
  });
  return { base, root, home, registry, pages, requests, fetch, now, read, cleanups };
}

test('official Markdown yields exact Sol and Astra rates, context split and documented Sol limits', () => {
  const pricing = parseOpenAIPricing(PRICING);
  assert.equal(pricing.long_context_threshold, 272000);
  assert.deepEqual(pricing.models['gpt-6.2-sol'], {
    tiers: { default: SOL_DEFAULT, batch: SOL_BATCH },
    long_context_rates: { default: SOL_LONG, batch: SOL_BATCH_LONG },
  });
  assert.deepEqual(pricing.models['gpt-6.2-astra'], {
    tiers: {
      default: { input: '8', output: '40', cache_read: '0.4', cache_write_30m: '10', cache_write_12h: '20' },
      batch: { input: '4', output: '20', cache_read: '0.2', cache_write_30m: '5', cache_write_12h: '10' },
    },
    long_context_rates: {
      default: { input: '16', output: '60', cache_read: '0.8', cache_write_30m: '20', cache_write_12h: '40' },
      batch: { input: '8', output: '30', cache_read: '0.4', cache_write_30m: '10', cache_write_12h: '20' },
    },
  });
  assert.ok(pricing.models['gpt-6.1-sol'].tiers.flex);
  assert.equal((pricing.models['gpt-6.2-sol'].tiers as Record<string, unknown>).flex, undefined);
  assert.equal((pricing.models['gpt-6.2-sol'].tiers as Record<string, unknown>).fast, undefined);
  assert.deepEqual(parseOpenAIModelPage(SOL, 'gpt-6.2-sol'), {
    supported: true, endpoint: '/v1/responses', max_input_tokens: 922000, max_output_tokens: 128000,
  });
  assert.ok(parseOpenAIModelIndex(INDEX).has('gpt-6.2-sol'));
  assert.ok(!parseOpenAIModelIndex(INDEX).has('gpt-6.2-sol.md'));
});

test('missing Sol is registered exactly, with a byte-for-byte backup and atomic replacement', async t => {
  const f = fixture(t);
  const original = fs.readFileSync(f.registry, 'utf8');
  const renames: Array<[string, string]> = [];
  const realRename = fs.renameSync.bind(fs);
  t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === f.registry) {
      assert.equal(fs.readFileSync(f.registry, 'utf8'), original);
      assert.equal(path.dirname(String(from)), f.root);
      assert.ok(String(from).endsWith('.tmp'));
      JSON.parse(fs.readFileSync(from, 'utf8'));
    }
    renames.push([String(from), String(to)]);
    realRename(from, to);
  });
  await synchronizeOpenAIModels(f);
  const entry = f.read()['gpt-6.2-sol'];
  assert.deepEqual(entry, {
    capabilities: {
      responses: {
        endpoint: '/v1/responses',
        verified_at: '2026-11-20',
        tiers: { default: SOL_DEFAULT, batch: SOL_BATCH },
        long_context_threshold: 272000,
        long_context_rates: { default: SOL_LONG, batch: SOL_BATCH_LONG },
        max_input_tokens: 922000,
        max_output_tokens: 128000,
        allowed_fields: FIELDS,
        input_modalities: ['text'],
        cache_ttls: ['30m', '12h'],
        sources: [
          'https://developers.openai.com/api/docs/pricing',
          'https://developers.openai.com/api/docs/models',
          'https://developers.openai.com/api/docs/models/gpt-6.2-sol',
        ],
      },
    },
  });
  const backups = fs.readdirSync(path.join(f.home, 'backups'));
  assert.equal(backups.length, 1);
  assert.match(backups[0], /^helper-registry-.*\.json$/);
  assert.equal(fs.readFileSync(path.join(f.home, 'backups', backups[0]), 'utf8'), original);
  assert.equal(renames.filter(([, to]) => to === f.registry).length, 1);
  assert.ok(readOpenAIModelStatus(f.home).events.some(event => event.kind === 'added' && event.model === 'gpt-6.2-sol'));
  const bytes = fs.readFileSync(f.registry, 'utf8');
  await synchronizeOpenAIModels(f);
  assert.equal(fs.readFileSync(f.registry, 'utf8'), bytes);
  assert.equal(fs.readdirSync(path.join(f.home, 'backups')).length, 1);
});

test('different prices are corrected, preserving unrelated entries and capabilities', async t => {
  const f = fixture(t);
  await synchronizeOpenAIModels(f);
  const registry = f.read();
  registry['gpt-6.2-sol'].capabilities.responses.tiers.default.input = '9';
  registry['gpt-6.2-sol'].capabilities.other = { retained: true };
  registry['private-alias'] = { retained: true };
  fs.writeFileSync(f.registry, JSON.stringify(registry));
  await synchronizeOpenAIModels(f);
  assert.equal(f.read()['gpt-6.2-sol'].capabilities.responses.tiers.default.input, '2');
  assert.deepEqual(f.read()['gpt-6.2-sol'].capabilities.other, { retained: true });
  assert.deepEqual(f.read()['private-alias'], { retained: true });
  assert.ok(readOpenAIModelStatus(f.home).price_mismatches.some(row => row.model === 'gpt-6.2-sol' && row.corrected));
});

test('one unverifiable model page is skipped on its own; the other models still sync', async t => {
  const f = fixture(t);
  const before = fs.readFileSync(f.registry, 'utf8');
  const astraMentions = (text: string) => text.split('"gpt-6.2-astra"').length - 1;
  f.pages.set('/api/docs/models/gpt-6.2-astra.md', '# broken');
  const status = await synchronizeOpenAIModels(f);
  assert.equal(status.error, null);
  assert.deepEqual(status.skipped?.map(row => row.model), ['gpt-6.2-astra']);
  assert.match(status.skipped![0].reason, /identity mismatch/);
  const after = fs.readFileSync(f.registry, 'utf8');
  // Nothing is written for the skipped model; the verifiable one is still registered.
  assert.equal(astraMentions(after), astraMentions(before));
  assert.ok(after.includes('"gpt-6.2-sol"'), 'the verifiable model is still registered');
});

test('nonpositive prices, missing context split and unsafe limits fail closed', async t => {
  const f = fixture(t);
  const original = fs.readFileSync(f.registry, 'utf8');
  f.pages.set('/api/docs/pricing.md', PRICING.replace('$2.00', '$0.00'));
  await assert.rejects(synchronizeOpenAIModels(f), /positive decimal/);
  assert.equal(fs.readFileSync(f.registry, 'utf8'), original);
  assert.throws(() => parseOpenAIPricing(PRICING.replace('Short context: ≤272K input tokens. Long context: >272K input tokens.', '')), /context split/);
  assert.throws(() => parseOpenAIModelPage(SOL.replace('128,000 max', '200,001 max'), 'gpt-6.2-sol'), /safety bound/);
});

test('disappearing models are flagged, never removed; unsupported Responses models are not registered', async t => {
  const f = fixture(t);
  const registry = f.read();
  registry['gpt-5.9-sol'] = structuredClone(registry['gpt-6.1-sol']);
  fs.writeFileSync(f.registry, JSON.stringify(registry));
  f.pages.set('/api/docs/models/gpt-6.2-astra.md', mockPage('gpt-6.2-astra').replace(
    '| Responses | `v1/responses` | Supported |',
    '| Responses | `v1/responses` | Not supported |',
  ));
  await synchronizeOpenAIModels(f);
  assert.ok(f.read()['gpt-5.9-sol']);
  assert.equal(f.read()['gpt-6.2-astra'], undefined);
  assert.ok(readOpenAIModelStatus(f.home).flagged.includes('gpt-5.9-sol'));
});

test('fallback profiles are fixed and labeled, without inventing registry evidence', () => {
  const registry = { __agentCommonsFallback: true };
  assert.deepEqual(newestOpenAILines(registry), {});
  const profiles = openAIProfileSeeds(registry);
  assert.ok(profiles.length > 0);
  for (const profile of profiles) {
    const expected = profile.eff === 'max' ? 'gpt-6.2-astra'
      : profile.intent === 'fast' && (profile.eff === 'min' || profile.eff === 'low' || profile.eff === 'med')
        ? 'gpt-6-luna'
        : profile.intent === 'code' && (profile.eff === 'min' || profile.eff === 'low' || profile.eff === 'med') || (profile.intent === 'fast' && profile.eff === 'high')
          ? 'gpt-6.1-terra' : 'gpt-6.2-sol';
    assert.equal(profile.model, expected);
    assert.equal(profile.options?.model_source, 'fallback');
  }
  assert.ok(openAIProfileSeeds({}).every(profile => profile.model === null),
    'a readable empty registry must not be replaced with fallback inventory');
});

test('newest line selection is numeric; fast low uses Luna and every max uses Astra', () => {
  const response = seedRegistry()['gpt-6.1-sol'];
  const registry = Object.fromEntries([
    'gpt-6.1-sol', 'gpt-6.2-sol', 'gpt-6.1-terra', 'gpt-6-luna', 'gpt-6.2-astra',
  ].map(model => [model, response]));
  assert.equal(newestOpenAILines(registry).sol, 'gpt-6.2-sol');
  assert.equal(newestOpenAILines(registry).terra, 'gpt-6.1-terra');
  const profiles = openAIProfileSeeds(registry);
  assert.equal(profiles.find(row => row.intent === 'fast' && row.eff === 'low')?.model, 'gpt-6-luna');
  assert.equal(profiles.find(row => row.intent === 'code' && row.eff === 'med')?.model, 'gpt-6.1-terra');
  const withoutTerra = Object.fromEntries(['gpt-6.2-sol', 'gpt-6-luna', 'gpt-6.2-astra'].map(model => [model, response]));
  assert.equal(openAIProfileSeeds(withoutTerra).find(row => row.intent === 'code' && row.eff === 'med')?.model, 'gpt-6.2-sol');
  assert.ok(profiles.filter(row => row.eff === 'max').every(row => row.model === 'gpt-6.2-astra' && row.effort === 'max'));
  assert.equal(newestOpenAILines({
    'gpt-6.9-sol': response, 'gpt-6.10-sol': response,
  }).sol, 'gpt-6.10-sol');
});

test('tracks_latest upgrades live rows, respects pins, and successful jobs retain validation', t => {
  const f = fixture(t);
  const oldProfiles = openaiApi.profiles.map(row => structuredClone(row));
  t.after(() => openaiApi.profiles.splice(0, openaiApi.profiles.length, ...oldProfiles));
  const response = seedRegistry()['gpt-6.1-sol'];
  const registry = Object.fromEntries(['gpt-6.2-sol', 'gpt-6-luna', 'gpt-6.2-astra'].map(model => [model, response]));
  openaiApi.profiles.splice(0, openaiApi.profiles.length, ...openAIProfileSeeds(registry));
  const store = new Store(f.home);
  f.cleanups.push(() => store.close());
  const db = (store as unknown as { db: DatabaseSync }).db;
  assert.ok((db.prepare('PRAGMA table_info(platform_profiles)').all() as Array<{ name: string }>).some(row => row.name === 'tracks_latest'));
  db.prepare(`UPDATE platform_profiles SET native_model='gpt-6.1-sol',native_effort='medium'
    WHERE adapter_id='openai-api' AND intent='code' AND eff='med'`).run();
  store.pinProfile('openai-api', 'review', 'high', 'gpt-6.1-sol');
  store.seedProfiles('openai-api');
  const get = (intent: string, eff: string) => db.prepare(
    `SELECT * FROM platform_profiles WHERE adapter_id='openai-api' AND intent=? AND eff=?`,
  ).get(intent, eff) as Record<string, unknown>;
  assert.equal(get('code', 'med').native_model, 'gpt-6.2-sol');
  assert.equal(get('review', 'high').native_model, 'gpt-6.1-sol');
  assert.equal(get('review', 'high').tracks_latest, 0);
  store.pinProfile('openai-api', 'review', 'high', undefined, true);
  assert.equal(get('review', 'high').tracks_latest, 1);
  assert.equal(get('review', 'high').native_model, 'gpt-6.2-sol');
  store.recordDiscovery('openai-api', [{ model: 'gpt-6.2-sol', state: 'verified', source: 'registry' }]);
  store.markModelValidated('openai-api', 'gpt-6.2-sol');
  store.recordDiscovery('openai-api', [{ model: 'gpt-6.2-sol', state: 'verified', source: 'registry' }]);
  assert.equal(store.routeModels('openai-api').find(row => row.model === 'gpt-6.2-sol')?.state, 'validated');
});

test('Prober registers and re-seeds in the same run without invoking the helper', async t => {
  const f = fixture(t);
  const oldProfiles = openaiApi.profiles.map(row => structuredClone(row));
  const oldDefault = openaiApi.capabilities.defaultModel;
  t.after(() => {
    openaiApi.profiles.splice(0, openaiApi.profiles.length, ...oldProfiles);
    openaiApi.capabilities.defaultModel = oldDefault;
  });
  const store = new Store(f.home);
  f.cleanups.push(() => store.close());
  const db = (store as unknown as { db: DatabaseSync }).db;
  db.prepare(`UPDATE platform_profiles SET native_model='gpt-6.1-sol',native_effort='medium'
    WHERE adapter_id='openai-api' AND intent='code' AND eff='med'`).run();
  const prober = new Prober(store, f.home, {
    openaiHelper: { file: process.execPath, prefix: [path.join(f.root, 'must-not-run.py')], cwd: f.root },
  }, { adapters: ['openai-api'], schedule: false, openaiFetch: f.fetch });
  await prober.discover('openai-api');
  assert.equal(store.modelDiscoveryState('openai-api')?.error, null);
  assert.equal(store.routeModels('openai-api').find(row => row.model === 'gpt-6.2-sol')?.state, 'verified');
  assert.equal((db.prepare(`SELECT native_model FROM platform_profiles
    WHERE adapter_id='openai-api' AND intent='code' AND eff='med'`).get() as { native_model: string }).native_model, 'gpt-6.2-sol');
  assert.equal(openaiApi.capabilities.defaultModel, 'gpt-6.2-sol'); // ordinary work defaults to the newest sol, not the small luna
});

test('profile-pin CLI pins an explicit model and can unpin it', t => {
  const f = fixture(t);
  const store = new Store(f.home);
  f.cleanups.push(() => store.close());
  const db = (store as unknown as { db: DatabaseSync }).db;
  const run = (...args: string[]) => execFileSync(process.execPath, [
    CLI, 'profile-pin', '--home', f.home, '--route', 'openai-api', '--intent', 'code', '--eff', 'med', ...args,
  ], {
    encoding: 'utf8',
    env: { ...process.env, AGENT_COMMONS_HOME: f.home, AC_HOME: f.home },
    timeout: 20000,
  });
  assert.match(run('--model', 'gpt-6.1-sol'), /pinned/);
  let row = db.prepare(`SELECT native_model,tracks_latest FROM platform_profiles
    WHERE adapter_id='openai-api' AND intent='code' AND eff='med'`).get() as { native_model: string; tracks_latest: number };
  assert.equal(row.native_model, 'gpt-6.1-sol');
  assert.equal(row.tracks_latest, 0);
  assert.match(run('--unpin'), /tracks latest/);
  row = db.prepare(`SELECT native_model,tracks_latest FROM platform_profiles
    WHERE adapter_id='openai-api' AND intent='code' AND eff='med'`).get() as typeof row;
  assert.equal(row.tracks_latest, 1);
});
