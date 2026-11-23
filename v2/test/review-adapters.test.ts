import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { antigravity } from '../src/adapters/antigravity.ts';
import { metadataFamily, metadataModel, metadataModels } from '../src/adapters/inventory.ts';
import type { ProbeContext, RunContext, UsageWindow } from '../src/adapters/types.ts';
import type { Json } from '../src/store.ts';

const seedFile = fileURLToPath(new URL('../helpers/antigravity/routing-seed.json', import.meta.url));
const profiles = JSON.parse(fs.readFileSync(seedFile, 'utf8')).profiles as Array<{
  family: string; effort: string; tasks: string[];
  quota_limits: Array<{ group: string; limit: string }>;
  task_preferences?: Record<string, number>;
}>;
const vendor = (family: string) => family.startsWith('claude-') ? 'anthropic'
  : family.startsWith('gpt-') ? 'openai' : family.startsWith('gemini-') ? 'google' : null;

function temp(t: any): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-review-adapter-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function usage(percent: number): UsageWindow[] {
  const rows = new Map<string, UsageWindow>();
  for (const p of profiles) for (const q of p.quota_limits) {
    rows.set(JSON.stringify(q), {
      route: 'antigravity', pool: q.group, window: q.limit, remaining_percent: percent,
      resets_at: new Date(Date.now() + 86400000).toISOString(),
      observed_at: new Date().toISOString(), source: 'reply', stale: false,
    });
  }
  return [...rows.values()];
}

async function launch(t: any, target: string, job: Json, rows: UsageWindow[],
  reply: Json = { status: 'SUCCESS', response: 'ok' }) {
  const home = temp(t), dir = path.join(home, 'job'), helper = path.join(home, 'helper.mjs');
  fs.mkdirSync(dir);
  fs.writeFileSync(helper, `
    import fs from 'node:fs';
    fs.writeFileSync('args.json', JSON.stringify(process.argv.slice(2)));
    console.log(${JSON.stringify(JSON.stringify(reply))});
  `);
  let active: ReturnType<RunContext['active']>;
  const annotations: Json = {};
  const result = await new Promise<{ status: string; fields: Json }>((resolve, reject) => {
    const ctx = {
      home, dir, options: { antigravity: { file: process.execPath, prefix: [helper] } },
      store: { updateJob() {}, poolEvidence: () => [], consumptionRuns: () => [] },
      usage: () => rows,
      reviewFamily: () => target,
      annotate: (values: Json) => Object.assign(annotations, values),
      track: (value: typeof active) => { active = value; },
      active: () => active,
      finish: (status: string, fields: Json = {}) => resolve({ status, fields }),
    } as unknown as RunContext;
    try {
      antigravity.launch({
        id: 'test', route: 'antigravity', prompt: 'review', timeout_ms: 10000,
        options: { review_for: 'actor:test', task: 'review' }, ...job,
      }, ctx);
    } catch (error) { reject(error); }
  });
  const file = path.join(dir, 'args.json');
  return { ...result, annotations, args: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as string[] : [] };
}

test('explicit models and families cannot select any reviewed vendor', async t => {
  for (const [target, model] of [['anthropic', 'claude-test'], ['openai', 'gpt-test'], ['google', 'gemini-test']]) {
    for (const job of [
      { model },
      { model_family: model },
      { options: { review_for: 'actor:test', family: model } },
      { model: 'unrelated-model', model_family: model },
      { model, trigger: 'auto_review', options: {} },
    ]) {
      const result = await launch(t, target, job, []);
      assert.equal(result.status, 'failed');
      assert.equal(result.fields.error, 'AG_NO_INDEPENDENT_POOL');
      assert.deepEqual(result.args, []);
    }
  }
});

test('an OpenAI review automatically selects an independent open profile', async t => {
  // Prefer an overlapping GPT task/effort when the helper seed has one, but do not
  // require the shipped seed to offer GPT and another vendor at the same effort.
  const p = profiles.find(p => vendor(p.family) === 'openai' && p.tasks.some(task =>
    profiles.some(q => q.effort === p.effort && q.tasks.includes(task) && vendor(q.family) !== 'openai')))
    ?? profiles.find(p => vendor(p.family) !== 'openai' && p.tasks.length > 0);
  assert.ok(p, 'seed must offer an independent profile');
  const task = p.tasks.find(task => profiles.some(q =>
    q.effort === p.effort && q.tasks.includes(task) && vendor(q.family) !== 'openai'))!;
  const result = await launch(t, 'openai', {
    effort: p.effort, options: { review_for: 'actor:test', task },
  }, usage(100));
  assert.equal(result.status, 'completed');
  const i = result.args.indexOf('-ModelFamily');
  assert.ok(i >= 0);
  assert.notEqual(vendor(result.args[i + 1]), 'openai');
});

test('unknown independent quota is pinned to the best eligible family; closed quota is refused', async t => {
  const p = profiles.find(p => vendor(p.family) !== 'anthropic' && p.tasks.includes('review'));
  assert.ok(p);
  const eligible = profiles.filter(q =>
    q.tasks.includes('review') && q.effort === p.effort && vendor(q.family) !== 'anthropic');
  eligible.sort((a, b) =>
    (a.task_preferences?.review ?? Infinity) - (b.task_preferences?.review ?? Infinity));
  const result = await launch(t, 'anthropic', { effort: p.effort }, []);
  assert.equal(result.status, 'completed');
  const i = result.args.indexOf('-ModelFamily');
  assert.ok(i >= 0);
  assert.equal(result.args[i + 1], eligible[0].family);
  const closed = await launch(t, 'anthropic', { effort: p.effort }, usage(0));
  assert.equal(closed.status, 'failed');
  assert.equal(closed.fields.error, 'AG_NO_INDEPENDENT_POOL');
});

test('REVALIDATION_BUSY without run fields is a pre-submission refusal, never replayed', async t => {
  const result = await launch(t, 'anthropic', { model: 'gemini-test' }, [], {
    status: 'BLOCKED', error_code: 'REVALIDATION_BUSY',
    error: 'Timed out waiting for the existing synthetic revalidation; no task prompt was sent.',
  });
  assert.equal(result.status, 'failed');
  assert.match(result.fields.error, /HELPER_BLOCKED: REVALIDATION_BUSY/);
  const submitted = await launch(t, 'anthropic', { model: 'gemini-test' }, [], {
    status: 'BLOCKED', error_code: 'REVALIDATION_BUSY', run_id: 'possibly-submitted',
  });
  assert.equal(submitted.status, 'needs_review');
});

test('metadata containers take precedence over wrapper names and unknown snapshots fail', () => {
  for (const key of ['models', 'profiles', 'items', 'data']) {
    const rows = metadataModels({ name: 'registry', [key]: { 'gpt-6-luna': { efforts: ['high'] } } });
    assert.deepEqual(rows.map(metadataModel), ['gpt-6-luna']);
  }
  for (const snapshot of [
    { unexpected: ['gpt-6-luna'] },
    { unexpected: { nested: ['gpt-6-luna'] } },
    { models: { unexpected: ['gpt-6-luna'] } },
  ]) assert.throws(() => metadataModels(snapshot), /metadata snapshot/);
  for (const key of ['models', 'profiles', 'items', 'data']) {
    assert.deepEqual(metadataModels({ [key]: [] }), []);
    assert.deepEqual(metadataModels({ [key]: {} }), []);
  }
  assert.deepEqual(metadataModels([]), []);
  assert.deepEqual(metadataModels({}), []);
});

test('a non-empty unrecognized complete Antigravity catalog rejects discovery', async t => {
  const home = temp(t), helper = path.join(home, 'helper');
  fs.mkdirSync(helper);
  fs.writeFileSync(path.join(helper, 'routing-seed.json'), '[]');
  const state = path.join(home, 'helpers', 'antigravity');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'catalog.json'), JSON.stringify({ unexpected: ['gemini-4-argon'] }));
  await assert.rejects(antigravity.discover!({
    home, overrides: { antigravityHelperRoot: helper },
  } as ProbeContext), /metadata snapshot/);
});

test('inventory family inference retains model tiers on both sides of a version', () => {
  for (const [model, family] of [
    ['gpt-6-luna', 'gpt-luna'], ['gpt-6.1-luna', 'gpt-luna'], ['gpt-6.1-sol', 'gpt-sol'],
    ['claude-opus-5-5', 'claude-opus'], ['claude-opus-5-6', 'claude-opus'],
    ['gemini-3.8-flash', 'gemini-flash'], ['gemini-4-flash', 'gemini-flash'],
    ['gemini-4-argon', 'gemini-argon'],
  ]) assert.equal(metadataFamily({ family: 'overly-broad' }, model), family);
});
