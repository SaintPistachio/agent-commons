import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store, type Actor } from './fixtures/service.ts';
import { adapter } from '../src/adapters/registry.ts';
import { compareVersionParts, newestByLine, parseModelVersion, supersededBy } from '../src/adapters/inventory.ts';
import {
  openAIModelVersion, openAIModelVisibility, parseOpenAICatalog, parseOpenAIPricing,
  readOpenAIModelStatus, refreshOpenAICatalog, synchronizeOpenAIModels, type PageFetch,
} from '../src/adapters/openai-models.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

function fixture(t: { after(fn: () => void): void }) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-current-models-'));
  const home = path.join(base, 'home');
  const helperDir = path.join(base, 'helper');
  const repo = path.join(base, 'repo');
  const claudeHome = path.join(base, 'claude-home');
  const codexHome = path.join(base, 'codex-home');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(helperDir, { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(claudeHome, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  const prevClaude = process.env.CLAUDE_CONFIG_DIR;
  const prevCodex = process.env.CODEX_HOME;
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  process.env.CODEX_HOME = codexHome;
  const registry = {
    models: {
      'text-embedding-3-small': { capabilities: { embeddings: { endpoint: '/v1/embeddings', tiers: { default: { input: '0.02', output: '0' } } } } },
      'gpt-5.6-sol': { capabilities: { responses: { endpoint: '/v1/responses', tiers: { default: { input: '2', output: '10' } }, allowed_fields: ['input'], input_modalities: ['text'], cache_ttls: ['30m'] } } },
      'gpt-6.1-sol': { capabilities: { responses: { endpoint: '/v1/responses', tiers: { default: { input: '2', output: '10' }, batch: { input: '1', output: '5' } }, allowed_fields: ['input'], input_modalities: ['text'], cache_ttls: ['30m'] } } },
      'gpt-6.2-sol': { capabilities: { responses: { endpoint: '/v1/responses', tiers: { default: { input: '2', output: '10' }, batch: { input: '1', output: '5' } }, allowed_fields: ['input'], input_modalities: ['text'], cache_ttls: ['30m'] } } },
      'gpt-6-luna': { capabilities: { responses: { endpoint: '/v1/responses', tiers: { default: { input: '0.1', output: '0.5' }, batch: { input: '0.05', output: '0.25' } }, allowed_fields: ['input'], input_modalities: ['text'], cache_ttls: ['30m'] } } },
      'gpt-6.2-astra': { capabilities: { responses: { endpoint: '/v1/responses', tiers: { default: { input: '8', output: '40' }, batch: { input: '4', output: '20' } }, allowed_fields: ['input'], input_modalities: ['text'], cache_ttls: ['30m'] } } },
    },
  };
  fs.writeFileSync(path.join(helperDir, 'registry.json'), JSON.stringify(registry, null, 2));
  const store = new Store(home);
  const helper = { file: process.execPath, prefix: [path.join(helperDir, 'run.py')], cwd: helperDir };
  store.setValidationOptions({ openaiHelper: helper });
  const actor: Actor = store.createActor('codex-desktop', 'participant', 'codex-desktop').actor;
  const project = store.call(actor, 'project_create', { name: 'P', root: repo, operation_id: randomUUID() }).project;
  t.after(() => {
    if (prevClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prevClaude;
    if (prevCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prevCodex;
    store.close();
    fs.rmSync(base, { recursive: true, force: true });
  });
  return { base, home, helperDir, helper, repo, claudeHome, codexHome, store, actor, project };
}

test('version helpers resolve newest model per family line automatically', () => {
  assert.deepEqual(parseModelVersion('gpt-6.10-sol'), { line: 'gpt-sol', parts: [6, 10] });
  assert.deepEqual(parseModelVersion('claude-opus-5-5'), { line: 'claude-opus', parts: [5, 5] });
  assert.equal(parseModelVersion('sonnet'), undefined);
  assert.ok(compareVersionParts([6, 10], [6, 9]) > 0);
  const active = ['gpt-6.9-sol', 'gpt-6.10-sol', 'gpt-6-luna', 'claude-opus-4-6', 'claude-opus-5-5', 'gemini-3.8', 'gemini-4'];
  assert.equal(newestByLine(active).get('gpt-sol'), 'gpt-6.10-sol');
  assert.equal(newestByLine(active).get('claude-opus'), 'claude-opus-5-5');
  assert.equal(newestByLine(active).get('gemini'), 'gemini-4');
  assert.equal(supersededBy('gpt-6.9-sol', active), 'gpt-6.10-sol');
  assert.equal(supersededBy('gpt-6.10-sol', active), null);
  assert.equal(supersededBy('sonnet', active), null);
  assert.equal(supersededBy('gpt-6', ['gpt-6', 'gpt-6.0']), null);
});

test('op_job_submit refuses superseded models with MODEL_SUPERSEDED and preserves history', t => {
  const f = fixture(t);
  f.store.recordDiscovery('claude', [
    { model: 'claude-sonnet-5-4', family: 'sonnet', efforts: ['low', 'medium', 'high'], state: 'verified', source: 'cli-catalog' },
    { model: 'claude-sonnet-5-5', family: 'sonnet', efforts: ['low', 'medium', 'high'], state: 'verified', source: 'cli-catalog' },
    { model: 'claude-sonnet-6-0', family: 'sonnet', efforts: ['low'], state: 'verified', source: 'cli-catalog', hidden: true },
  ]);
  f.store.recordDiscovery('codex', [
    { model: 'gpt-6.9-sol', family: 'sol', efforts: ['medium'], state: 'verified', source: 'cli-cache' },
    { model: 'gpt-6.10-sol', family: 'sol', efforts: ['medium'], state: 'verified', source: 'cli-cache' },
  ]);
  f.store.recordDiscovery('antigravity', [
    { model: 'gemini-3.8', family: 'gemini', efforts: ['high'], state: 'discovered', source: 'catalog' },
    { model: 'gemini-4', family: 'gemini', efforts: ['high'], state: 'discovered', source: 'catalog' },
  ]);
  // Retired newer model must not supersede an active older model.
  f.store.recordDiscovery('antigravity', [
    { model: 'gemini-3.8', family: 'gemini', efforts: ['high'], state: 'discovered', source: 'catalog' },
    { model: 'gemini-4', family: 'gemini', efforts: ['high'], state: 'discovered', source: 'catalog' },
    { model: 'gemini-9', family: 'gemini', efforts: ['high'], state: 'retired', source: 'catalog' },
  ]);
  f.store.setModelState('antigravity', 'gemini-9', 'retired');

  const apiMeta = { max_cost_usd: '0.25', purpose: 'Check', deliverable: 'Answer' };
  const submit = (input: Record<string, unknown>) => f.store.call(f.actor, 'job_submit', {
    project_id: f.project.id, prompt: 'test', operation_id: randomUUID(), ...input,
  });

  // Historical job in DB remains intact even for a now-superseded model.
  const histId = randomUUID();
  f.store.db.prepare(`INSERT INTO jobs(id,project_id,route,mode,prompt,model,effort,timeout_ms,status,created_by,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(histId, f.project.id, 'openai-api', 'advice', 'old', 'gpt-6.1-sol', 'medium', 60000, 'completed', f.actor.id, new Date().toISOString());
  assert.equal(f.store.jobRecord(histId)!.model, 'gpt-6.1-sol');

  assert.throws(() => submit({ route: 'openai-api', model: 'gpt-6.1-sol', ...apiMeta }),
    (err: any) => err.code === 'MODEL_SUPERSEDED' && /superseded by gpt-6\.2-sol/.test(err.message));
  assert.throws(() => submit({ route: 'openai-api', model: 'gpt-5.6-sol', ...apiMeta }),
    (err: any) => err.code === 'MODEL_SUPERSEDED' && /superseded by gpt-6\.2-sol/.test(err.message));
  assert.throws(() => submit({ route: 'claude', model: 'claude-sonnet-5-4', effort: 'medium' }),
    (err: any) => err.code === 'MODEL_SUPERSEDED' && /superseded by claude-sonnet-5-5/.test(err.message));
  assert.throws(() => submit({ route: 'codex', model: 'gpt-6.9-sol', effort: 'medium' }),
    (err: any) => err.code === 'MODEL_SUPERSEDED' && /superseded by gpt-6\.10-sol/.test(err.message));
  assert.throws(() => submit({ route: 'antigravity', model: 'gemini-3.8', effort: 'high' }),
    (err: any) => err.code === 'MODEL_SUPERSEDED' && /superseded by gemini-4/.test(err.message));

  assert.equal(submit({ route: 'openai-api', model: 'gpt-6.2-sol', ...apiMeta }).job.model, 'gpt-6.2-sol');
  // Hidden claude-sonnet-6-0 must not supersede visible claude-sonnet-5-5; unversioned alias works.
  assert.equal(submit({ route: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' }).job.model, 'claude-sonnet-5-5');
  assert.equal(submit({ route: 'claude', model: 'sonnet', effort: 'medium' }).job.model, 'sonnet');
  assert.equal(submit({ route: 'antigravity', model: 'gemini-4', effort: 'high' }).job.model, 'gemini-4');

  // Pinned superseded profile is refused at submit and dropped from active routeProfiles.
  f.store.pinProfile('openai-api', 'review', 'high', 'gpt-6.1-sol');
  assert.ok(!f.store.routeProfiles('openai-api').some(p => p.intent === 'review' && p.eff === 'high'));
  assert.throws(() => submit({ route: 'openai-api', intent: 'review', eff: 'high', ...apiMeta }),
    (err: any) => err.code === 'MODEL_SUPERSEDED');

  const listed = f.store.routeModels('claude');
  assert.equal(listed.find(r => r.model === 'claude-sonnet-5-4')?.superseded_by, 'claude-sonnet-5-5');
  const cliOut = execFileSync(process.execPath, [CLI, 'models', '--home', f.home, '--route', 'claude'], { encoding: 'utf8', timeout: 20000 });
  assert.match(cliOut, /claude-sonnet-5-4 verified;.*superseded by claude-sonnet-5-5/);
});

test('route=auto drops routes whose active profile resolves to a superseded model', t => {
  const f = fixture(t);
  const nowMs = Date.now();
  fs.mkdirSync(path.join(f.claudeHome, 'cache', 'model-catalog'), { recursive: true });
  fs.writeFileSync(path.join(f.claudeHome, 'cache', 'model-catalog', 'cli.json'), JSON.stringify({
    version: 2, fetchedAt: nowMs - 1000, staleAt: nowMs + 3600_000,
    catalog: {
      surface: 'cc',
      config: {
        models: [
          { id: 'claude-sonnet-5-4', section: 'main', min_claude_code_version: '2.0.0', runtime: { family: 'sonnet', effort_levels: ['low', 'medium', 'high'], default_effort: 'medium' } },
          { id: 'claude-sonnet-5-5', section: 'main', min_claude_code_version: '2.0.0', runtime: { family: 'sonnet', effort_levels: ['low', 'medium', 'high'], default_effort: 'medium' } },
        ],
      },
    },
  }));
  fs.writeFileSync(path.join(f.codexHome, 'models_cache.json'), JSON.stringify({
    client_version: '0.171.0',
    fetched_at: new Date(nowMs - 1000).toISOString(),
    models: [
      { slug: 'gpt-6.9-sol', display_name: 'gpt-6.9-sol', visibility: 'list', default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }] },
      { slug: 'gpt-6.10-sol', display_name: 'gpt-6.10-sol', visibility: 'list', default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }] },
    ],
  }));
  f.store.recordProbe(adapter('claude')!.capabilities, { state: 'verified', cliVersion: '2.4.0', binary: { path: path.join(f.base, 'claude'), version: '2.4.0', source: 'test' } });
  f.store.recordProbe(adapter('codex')!.capabilities, { state: 'verified', cliVersion: '0.171.0', binary: { path: path.join(f.base, 'codex'), version: '0.171.0', source: 'test' } });
  // Make claude's code/med profile explicitly pinned to superseded claude-sonnet-5-4.
  f.store.recordDiscovery('claude', [
    { model: 'claude-sonnet-5-4', family: 'sonnet', efforts: ['low', 'medium', 'high'], state: 'verified', source: 'cli-catalog' },
    { model: 'claude-sonnet-5-5', family: 'sonnet', efforts: ['low', 'medium', 'high'], state: 'verified', source: 'cli-catalog' },
  ]);
  f.store.db.prepare("UPDATE platform_profiles SET native_model='claude-sonnet-5-4',tracks_latest=0 WHERE adapter_id='claude' AND intent='code' AND eff='med'").run();
  // Codex tracks latest (gpt-6.10-sol).
  f.store.recordDiscovery('codex', [
    { model: 'gpt-6.9-sol', family: 'sol', efforts: ['medium'], state: 'verified', source: 'cli-cache' },
    { model: 'gpt-6.10-sol', family: 'sol', efforts: ['medium'], state: 'verified', source: 'cli-cache' },
  ]);
  const picked = f.store.call(f.actor, 'job_submit', {
    project_id: f.project.id, route: 'auto', intent: 'code', eff: 'med', prompt: 'Check auto routing', operation_id: randomUUID(),
  }).job;
  assert.equal(picked.route, 'codex');

  // If codex is also pinned to a superseded model (and antigravity without selectModel too), route=auto reports :superseded with no eligible route.
  f.store.db.prepare("UPDATE platform_profiles SET native_model='gpt-6.9-sol',tracks_latest=0 WHERE adapter_id='codex' AND intent='code' AND eff='med'").run();
  f.store.recordProbe(adapter('antigravity')!.capabilities, { state: 'verified' });
  f.store.recordDiscovery('antigravity', [
    { model: 'gemini-3.8', family: 'gemini', efforts: ['high'], state: 'discovered', source: 'catalog' },
    { model: 'gemini-4', family: 'gemini', efforts: ['high'], state: 'discovered', source: 'catalog' },
  ]);
  f.store.db.prepare("UPDATE platform_profiles SET native_model='gemini-3.8',tracks_latest=0 WHERE adapter_id='antigravity' AND intent='code' AND eff='med'").run();
  assert.throws(() => f.store.call(f.actor, 'job_submit', {
    project_id: f.project.id, route: 'auto', intent: 'code', eff: 'med', prompt: 'None eligible', operation_id: randomUUID(),
  }), (err: any) => err.code === 'NO_ELIGIBLE_ROUTE' && /claude:superseded/.test(err.message) && /codex:superseded/.test(err.message) && /ag:superseded/.test(err.message));
});

test('AC-side OpenAI catalog records non-text modalities with prices without changing helper registry', async t => {
  const f = fixture(t);
  const pricing = `# Pricing

### Standard pricing data

| Model | Short context input | Short context output | Short context cached input |
| --- | --- | --- | --- |
| gpt-6.2-astra | $8.00 | $40.00 | $0.40 |
| gpt-6.2-sol | $2.00 | $10.00 | $0.10 |
| gpt-6.1-sol | $2.00 | $10.00 | $0.10 |
| gpt-6-luna | $0.10 | $0.50 | $0.01 |

### Batch pricing data

| Model | Short context input | Short context output |
| --- | --- | --- |
| gpt-6.2-sol | $1.00 | $5.00 |

Short context: ≤272K input tokens. Long context: >272K input tokens.

## Audio

### Realtime

| Model | Text input | Text output | Audio input | Audio output |
| --- | --- | --- | --- | --- |
| gpt-realtime | $4.00 | $16.00 | $32.00 | $64.00 |

### Transcription

| Model | Cost per minute |
| --- | --- |
| gpt-4o-transcribe | $0.006 |
| whisper-1 | $0.006 |

### Text-to-speech

| Model | Input | Cost per minute |
| --- | --- | --- |
| gpt-4o-mini-tts | $0.60 | $0.015 |
| tts-1 | $15.00 / 1M chars | - |

## Image generation

| Model | Text input | Image output |
| --- | --- | --- |
| gpt-image-1 | $5.00 | $40.00 |

## Embeddings

| Model | Input | Batch input |
| --- | --- | --- |
| text-embedding-3-small | $0.02 | $0.01 |
| text-embedding-3-large | $0.13 | $0.065 |

## Moderation

| Model | Input |
| --- | --- |
| omni-moderation-latest | Free |

## Video

| Model | Cost per second |
| --- | --- |
| sora-2 | $0.10 |
`;
  const index = `# Models
- [GPT-6.2 Astra](/api/docs/models/gpt-6.2-astra.md)
- [GPT-6.2 Sol](/api/docs/models/gpt-6.2-sol.md)
- [GPT-6.1 Sol](/api/docs/models/gpt-6.1-sol.md)
- [GPT-6 Luna](/api/docs/models/gpt-6-luna.md)
`;
  const page = (id: string) => `# ${id}\nModel ID: \`${id}\`\n- Maximum input tokens: 922,000\n- 128,000 max output tokens\n| Endpoint | Route | Support |\n| --- | --- | --- |\n| Responses | \`v1/responses\` | Supported |\n`;
  const pages = new Map<string, string>([
    ['/api/docs/pricing.md', pricing],
    ['/api/docs/models.md', index],
    ...['gpt-6.2-astra', 'gpt-6.2-sol', 'gpt-6.1-sol', 'gpt-6-luna'].map(m => [`/api/docs/models/${m}.md`, page(m)] as [string, string]),
  ]);
  const fetch: PageFetch = async url => {
    const body = pages.get(new URL(url).pathname);
    return new Response(body ?? 'not found', { status: body ? 200 : 404 });
  };
  const beforeRegistry = JSON.parse(fs.readFileSync(path.join(f.helperDir, 'registry.json'), 'utf8'));
  const status = await synchronizeOpenAIModels({ home: f.home, root: f.helperDir, fetch, now: () => new Date('2026-11-21T12:00:00Z') });
  // Registry did not add any non-text model and left existing non-text entries unchanged.
  const afterRegistry = JSON.parse(fs.readFileSync(path.join(f.helperDir, 'registry.json'), 'utf8'));
  assert.deepEqual(afterRegistry.models['text-embedding-3-small'], beforeRegistry.models['text-embedding-3-small']);
  for (const nonText of ['gpt-realtime', 'gpt-4o-transcribe', 'whisper-1', 'gpt-4o-mini-tts', 'tts-1', 'gpt-image-1', 'text-embedding-3-large', 'omni-moderation-latest', 'sora-2']) {
    assert.equal(afterRegistry.models[nonText], undefined, `${nonText} must not be written to helper registry`);
  }

  const catalog = status.catalog ?? readOpenAIModelStatus(f.home).catalog ?? [];
  const byModel = new Map(catalog.map(c => [c.model, c]));
  assert.equal(byModel.get('gpt-6.2-sol')?.routable, true);
  assert.equal(byModel.get('gpt-6.1-sol')?.routable, false);
  assert.equal(byModel.get('gpt-6.1-sol')?.superseded_by, 'gpt-6.2-sol');
  for (const [model, modality] of [
    ['gpt-realtime', 'realtime'],
    ['gpt-4o-transcribe', 'transcription'],
    ['gpt-4o-mini-tts', 'tts'],
    ['gpt-image-1', 'image'],
    ['text-embedding-3-large', 'embeddings'],
    ['omni-moderation-latest', 'moderation'],
    ['sora-2', 'video'],
  ] as const) {
    const entry = byModel.get(model);
    assert.ok(entry, model);
    assert.equal(entry.modality, modality);
    assert.equal(entry.routable, false);
    assert.ok(Object.keys(entry.pricing).length > 0, `${model} has pricing`);
  }
  assert.equal(byModel.get('sora-2')?.pricing.cost_per_second, '$0.10');
  assert.equal(byModel.get('gpt-realtime')?.pricing.audio_output, '$64.00');
  assert.equal(parseOpenAICatalog(pricing, index, ['gpt-6.2-sol']).find(c => c.model === 'gpt-6.1-sol')?.superseded_by, 'gpt-6.2-sol');

  const vis = openAIModelVisibility(f.home, f.helperDir).join('\n');
  assert.match(vis, /SUPERSEDED: gpt-6\.1-sol -> gpt-6\.2-sol \(refused at submit\)/);
  assert.match(vis, /CATALOG \[not-routable\] gpt-realtime \(realtime\):/);
  assert.match(vis, /CATALOG \[not-routable\] sora-2 \(video\): cost_per_second=\$0\.10/);
});

test('j109 regressions: dated snapshots, flagged/retired active exclusions, inferred route=auto, pricing guards, and read-only catalog refresh', async t => {
  const f = fixture(t);

  // 1. Dated snapshots never supersede newer release versions, and openAIModelVersion matches parseModelVersion.
  assert.equal(parseModelVersion('gpt-4-0613'), undefined);
  assert.equal(parseModelVersion('gpt-4-2024-08-06'), undefined);
  assert.equal(parseModelVersion('claude-sonnet-4-5-20250929'), undefined);
  assert.equal(parseModelVersion('gpt-6.2-sol-20261120'), undefined);
  assert.equal(openAIModelVersion('gpt-4-0613'), undefined);
  assert.equal(openAIModelVersion('gpt-6.2-sol-20261120'), undefined);
  assert.deepEqual(openAIModelVersion('gpt-6.2-sol'), { line: 'sol', version: [6, 2] });
  assert.equal(supersededBy('gpt-4.1', ['gpt-4-0613', 'gpt-4-2024-08-06', 'gpt-4.1']), null);
  assert.equal(supersededBy('claude-sonnet-4-5', ['claude-sonnet-4-5', 'claude-sonnet-4-5-20250929']), null);

  // 2. Retired/hidden inventory rows & flagged openai-models entries cannot supersede active usable models.
  f.store.recordProbe(adapter('openai-api')!.capabilities, { state: 'verified' });
  const flaggedRegistry = JSON.parse(fs.readFileSync(path.join(f.helperDir, 'registry.json'), 'utf8'));
  flaggedRegistry.models['gpt-6.9-sol'] = structuredClone(flaggedRegistry.models['gpt-6.2-sol']);
  fs.writeFileSync(path.join(f.helperDir, 'registry.json'), JSON.stringify(flaggedRegistry, null, 2));
  // Mark gpt-6.9-sol retired in route_models AND flagged in openai-models.json.
  f.store.recordDiscovery('openai-api', [
    { model: 'gpt-6.2-sol', family: 'sol', efforts: ['medium'], state: 'verified', source: 'registry' },
    { model: 'gpt-6.9-sol', family: 'sol', efforts: ['medium'], state: 'retired', source: 'registry' },
  ]);
  f.store.setModelState('openai-api', 'gpt-6.9-sol', 'retired');
  fs.writeFileSync(path.join(f.home, 'openai-models.json'), JSON.stringify({
    events: [], flagged: ['gpt-6.9-sol'], price_mismatches: [],
  }));
  assert.equal(f.store.supersededModel('openai-api', 'gpt-6.2-sol'), null);
  const catalogWithFlagged = parseOpenAICatalog(
    `# Pricing\n### Standard pricing data\n| Model | Input | Output |\n| --- | --- | --- |\n| gpt-6.2-sol | $2.00 | $10.00 |\n| gpt-6.9-sol | $2.00 | $10.00 |\n`,
    `# Models\n- [GPT-6.2 Sol](/api/docs/models/gpt-6.2-sol.md)\n- [GPT-6.9 Sol](/api/docs/models/gpt-6.9-sol.md)\n`,
    ['gpt-6.2-sol'], // flagged gpt-6.9-sol excluded by caller
    flaggedRegistry,
  );
  assert.equal(catalogWithFlagged.find(c => c.model === 'gpt-6.9-sol')?.routable, false);
  assert.equal(catalogWithFlagged.find(c => c.model === 'gpt-6.2-sol')?.routable, true);
  assert.equal(catalogWithFlagged.find(c => c.model === 'gpt-6.2-sol')?.superseded_by, undefined);

  // 3. Inferred selection (e.g. security -> deep/high) resolves the same profile pair in route=auto and submit.
  f.store.recordDiscovery('openai-api', [
    { model: 'gpt-6.1-sol', family: 'sol', efforts: ['medium', 'high'], state: 'verified', source: 'registry' },
    { model: 'gpt-6.2-sol', family: 'sol', efforts: ['medium', 'high'], state: 'verified', source: 'registry' },
    { model: 'gpt-6.2-astra', family: 'astra', efforts: ['high', 'max'], state: 'verified', source: 'registry' },
  ]);
  // Pin code/med to superseded gpt-6.1-sol while deep/high stays current gpt-6.2-sol -> risk prompt ("security") MUST succeed!
  f.store.pinProfile('openai-api', 'code', 'med', 'gpt-6.1-sol');
  const riskJob = f.store.call(f.actor, 'job_submit', {
    project_id: f.project.id, route: 'auto', cost: 'paid',
    max_cost_usd: '0.25', purpose: 'Security audit', deliverable: 'Findings',
    prompt: 'Audit security boundaries in store.ts', operation_id: randomUUID(),
  }).job;
  assert.equal(riskJob.route, 'openai-api');
  assert.equal(riskJob.model, 'gpt-6.2-sol');
  // Reverse: code/med current, deep/high pinned to superseded gpt-6.1-sol -> risk prompt MUST skip api:superseded!
  f.store.pinProfile('openai-api', 'code', 'med', undefined, true);
  f.store.pinProfile('openai-api', 'deep', 'high', 'gpt-6.1-sol');
  assert.throws(() => f.store.call(f.actor, 'job_submit', {
    project_id: f.project.id, route: 'auto', cost: 'paid',
    max_cost_usd: '0.25', purpose: 'Security audit', deliverable: 'Findings',
    prompt: 'Audit security boundaries in store.ts', operation_id: randomUUID(),
  }), (err: any) => err.code === 'NO_ELIGIBLE_ROUTE' && /api:superseded/.test(err.message));

  // 4. Empty/unrecognized Batch table body throws instead of passing on heading alone; Ultrafast tiers do not overwrite Standard.
  assert.throws(() => parseOpenAIPricing(`# Pricing
### Standard pricing data
| Model | Input | Output |
| --- | --- | --- |
| gpt-6.2-sol | $2.00 | $10.00 |
### Batch pricing data
| Unrecognized | Column |
| --- | --- |
| foo | bar |
`), /Missing Standard or Batch pricing tables/);

  const tierPricing = parseOpenAICatalog(`# Pricing
### Standard pricing data
| Model | Input | Output |
| --- | --- | --- |
| gpt-6.2-sol | $2.00 | $10.00 |
### Ultrafast promotion pricing data
| Model | Input | Output |
| --- | --- | --- |
| gpt-6.2-sol | $9.00 | $45.00 |
### Ultrafast list pricing data
| Model | Input | Output |
| --- | --- | --- |
| gpt-6.2-sol | $12.00 | $60.00 |
`, `# Models\n- [GPT-6.2 Sol](/api/docs/models/gpt-6.2-sol.md)\n`, ['gpt-6.2-sol']);
  const solCatalog = tierPricing.find(c => c.model === 'gpt-6.2-sol')!;
  assert.equal(solCatalog.pricing.input, '$2.00');
  assert.equal(solCatalog.pricing['ultrafast_promotion.input'], '$9.00');
  assert.equal(solCatalog.pricing['ultrafast_list.input'], '$12.00');

  // 5. Read-only refreshOpenAICatalog refreshes status.catalog without modifying registry.json bytes at all.
  const exactBefore = fs.readFileSync(path.join(f.helperDir, 'registry.json'), 'utf8');
  const fetchCatalog: PageFetch = async url => {
    const p = new URL(url).pathname;
    if (p === '/api/docs/pricing.md') {
      return new Response(`# Pricing
### Standard pricing data
| Model | Input | Output |
| --- | --- | --- |
| gpt-6.2-sol | $2.00 | $10.00 |
## Video
| Model | Cost per second |
| --- | --- |
| sora-2 | $0.10 |
`, { status: 200 });
    }
    if (p === '/api/docs/models.md') {
      return new Response('# Models\n- [GPT-6.2 Sol](/api/docs/models/gpt-6.2-sol.md)\n', { status: 200 });
    }
    return new Response('not found', { status: 404 });
  };
  const refreshed = await refreshOpenAICatalog({
    home: f.home, root: f.helperDir, fetch: fetchCatalog, now: () => new Date('2026-11-21T13:00:00Z'),
  });
  assert.equal(fs.readFileSync(path.join(f.helperDir, 'registry.json'), 'utf8'), exactBefore);
  assert.equal(refreshed.catalog?.find(c => c.model === 'sora-2')?.routable, false);
  assert.equal(refreshed.catalog?.find(c => c.model === 'gpt-6.9-sol')?.routable, false);
});
