import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Store, type Actor } from '../src/store.ts';
import { adapter } from '../src/adapters/registry.ts';
import { EFFORTS, INTENTS } from '../src/adapters/types.ts';
import { inferSelection, type SelectionInput } from '../src/selection.ts';

function fixture(t: TestContext) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-selection-'));
  const repo = path.join(home, 'repo');
  fs.mkdirSync(repo);
  let store = new Store(home);
  t.after(() => {
    try { store.close(); } catch {}
    fs.rmSync(home, { recursive: true, force: true });
  });
  const actor: Actor = store.createActor('selection-test', 'participant', 'selection-test').actor;
  store.recordProbe(adapter('openai-api')!.capabilities, { state: 'verified', cliVersion: '1.0' });
  const call = (method: string, input: Record<string, unknown>) => store.call(actor, method, input);
  call('project_create', { name: 'Repo', root: repo, operation_id: randomUUID() });
  const jobInput = (extra: Record<string, unknown> = {}) => ({
    project_id: 'p1', prompt: 'Explain the implementation.', route: 'openai-api', cost: 'paid',
    max_cost_usd: 0.1, purpose: 'Understand the implementation', deliverable: 'An explanation',
    operation_id: randomUUID(), ...extra,
  });
  return {
    submit: (extra: Record<string, unknown> = {}) => call('job_submit', jobInput(extra)).job,
    internal: (trigger: string, extra: Record<string, unknown> = {}) =>
      store.op_job_submit(actor, jobInput(extra), { trigger }).job,
    db: () => (store as unknown as { db: DatabaseSync }).db,
    reopen: () => { store.close(); store = new Store(home); },
  };
}

test('inferSelection defaults to code/med and recognizes edit mode', () => {
  assert.deepEqual(inferSelection({ intent: null, eff: null, mode: 'advice', prompt: '', contextRefs: [] }), {
    intent: 'code', eff: 'med', source: 'inferred', reasons: ['default'],
  });
  assert.deepEqual(inferSelection({ mode: 'edit' }), {
    intent: 'edit', eff: 'med', source: 'inferred', reasons: ['mode:edit'],
  });
});

test('inferSelection handles each internal trigger', () => {
  const cases = [
    ['auto_review', 'review', 'med'],
    ['room', 'review', 'med'],
    ['yield', 'deep', 'high'],
    ['wake', 'deep', 'high'],
    ['resume', 'code', 'med'],
  ] as const;
  for (const [trigger, intent, eff] of cases) {
    const selection = inferSelection({ trigger });
    assert.equal(selection.intent, intent, trigger);
    assert.equal(selection.eff, eff, trigger);
    assert.equal(selection.source, 'inferred');
    assert.ok(selection.reasons.includes(trigger === 'resume' ? 'default' : `trigger:${trigger}`));
  }
  const editYield = inferSelection({ mode: 'edit', trigger: 'yield' });
  assert.equal(editYield.intent, 'edit');
  assert.equal(editYield.eff, 'high');
});

test('risk signals in prompts and context refs raise inferred intent and effort', () => {
  const signals = [
    ['schema', 'schema'],
    ['migration', 'migration'],
    ['wire protocol', 'wire_protocol'],
    ['security', 'security'],
    ['auth', 'auth'],
    ['credential', 'credential'],
    ['secret', 'secret'],
    ['billing', 'billing'],
    ['spend', 'spend'],
    ['payment', 'payment'],
    ['concurrency', 'concurrency'],
    ['lock', 'lock'],
    ['race', 'race'],
    ['data integrity', 'data_integrity'],
  ] as const;
  const refSkipped = new Set(['schema', 'wire protocol', 'spend', 'concurrency', 'lock', 'race', 'data integrity']);
  for (const [word, code] of signals) {
    const promptSel = inferSelection({ prompt: `Check ${word.toUpperCase()}.` });
    assert.equal(promptSel.intent, 'deep', word);
    assert.equal(promptSel.eff, 'high', word);
    assert.ok(promptSel.reasons.includes(`risk:${code}`), word);

    const refSel = inferSelection({ contextRefs: [`file:docs/${word.toUpperCase()}.md`] });
    if (refSkipped.has(word)) {
      assert.equal(refSel.intent, 'code', word);
      assert.equal(refSel.eff, 'med', word);
    } else {
      assert.equal(refSel.intent, 'deep', word);
      assert.equal(refSel.eff, 'high', word);
      assert.ok(refSel.reasons.includes(`risk:${code}`), word);
    }
  }
  assert.equal(inferSelection({ mode: 'edit', prompt: 'Update the schema.' }).intent, 'deep');
  const ordinary = inferSelection({ prompt: 'An author examines a traceback and a secretive character.' });
  assert.equal(ordinary.intent, 'code');
  assert.equal(ordinary.eff, 'med');
});

test('large context raises only inferred effort, with strict size thresholds and a high ceiling', () => {
  const sixRefs = Array.from({ length: 6 }, (_, i) => `file:src/file${i}.ts`);
  assert.equal(inferSelection({ contextRefs: sixRefs }).eff, 'med');
  assert.equal(inferSelection({ prompt: 'x'.repeat(20000) }).eff, 'med');

  for (const input of [
    { contextRefs: [...sixRefs, 'file:src/extra.ts'] },
    { prompt: 'x'.repeat(20001) },
  ]) {
    const selection = inferSelection(input);
    assert.equal(selection.intent, 'code');
    assert.equal(selection.eff, 'high');
    assert.ok(selection.reasons.includes('large_context'));
  }

  const high = inferSelection({ trigger: 'yield', prompt: 'x'.repeat(20001) });
  assert.equal(high.eff, 'high');
  const explicit = inferSelection({ eff: 'min', prompt: 'x'.repeat(20001) });
  assert.equal(explicit.eff, 'min');
  assert.equal(explicit.source, 'mixed');
  assert.ok(explicit.reasons.includes('large_context'));
});

test('caller values are kept independently, including explicit fast and max', () => {
  assert.deepEqual(inferSelection({ intent: 'fast', eff: 'max' }), {
    intent: 'fast', eff: 'max', source: 'caller', reasons: ['default'],
  });

  const intentOnly = inferSelection({ intent: 'fast', prompt: 'A security decision.' });
  assert.equal(intentOnly.intent, 'fast');
  assert.equal(intentOnly.eff, 'high');
  assert.equal(intentOnly.source, 'mixed');

  const effortOnly = inferSelection({ eff: 'low', prompt: 'A security decision.' });
  assert.equal(effortOnly.intent, 'deep');
  assert.equal(effortOnly.eff, 'low');
  assert.equal(effortOnly.source, 'mixed');

  const both = inferSelection({ intent: 'fast', eff: 'min', trigger: 'wake', prompt: 'Billing security.' });
  assert.equal(both.intent, 'fast');
  assert.equal(both.eff, 'min');
  assert.equal(both.source, 'caller');

  for (const intent of INTENTS) for (const eff of EFFORTS) {
    const selection = inferSelection({ intent, eff, prompt: 'Security.', trigger: 'wake' });
    assert.equal(selection.intent, intent);
    assert.equal(selection.eff, eff);
    assert.equal(selection.source, 'caller');
  }
});

test('automatic inference never chooses max and uses fast/low only for bounded lookups', () => {
  const triggers = [undefined, 'auto_review', 'room', 'yield', 'wake', 'resume'];
  for (const trigger of triggers) for (const mode of ['advice', 'edit']) {
    for (const prompt of ['', 'Security.', 'x'.repeat(20001)]) {
      const selection = inferSelection({ trigger, mode, prompt });
      assert.notEqual(selection.intent, 'fast');
      assert.notEqual(selection.eff, 'max');
    }
  }
  const lookup = inferSelection({ mode: 'advice', prompt: 'List the files in v2/src.' });
  assert.equal(lookup.intent, 'fast');
  assert.equal(lookup.eff, 'low');
  assert.ok(lookup.reasons.includes('bounded_lookup'));
});

test('inferSelection does not mutate its input', () => {
  const contextRefs = Object.freeze(['file:docs/schema.md']);
  const input: SelectionInput = Object.freeze({ intent: 'fast', contextRefs, prompt: 'Explain this.' });
  const first = inferSelection(input);
  assert.deepEqual(inferSelection(input), first);
  first.reasons.push('test');
  assert.ok(!inferSelection(input).reasons.includes('test'));
  assert.deepEqual(contextRefs, ['file:docs/schema.md']);
});

test('job_submit without intent/eff resolves the API standard profile and records selection', t => {
  const f = fixture(t);
  const job = f.submit();
  assert.equal(job.model, 'gpt-6.1-terra');
  assert.equal(job.effort, 'medium');
  assert.deepEqual(job.options.selection, {
    intent: 'code', eff: 'med', source: 'inferred', reasons: ['default'],
  });
});

test('explicit fast/low selects Luna and explicit max retains native max', t => {
  const f = fixture(t);
  const fast = f.submit({ intent: 'fast', eff: 'low' });
  assert.equal(fast.model, 'gpt-6-luna');
  assert.equal(fast.effort, 'low');
  assert.equal(fast.options.selection.source, 'caller');

  const maximum = f.submit({ eff: 'max', max_cost_usd: 0.5 });
  assert.equal(maximum.model, 'gpt-6.2-astra');
  assert.equal(maximum.effort, 'max');
  assert.equal(maximum.options.selection.intent, 'code');
  assert.equal(maximum.options.selection.eff, 'max');
  assert.equal(maximum.options.selection.source, 'mixed');
});

test('route=auto sees inferred requirements before choosing its profile', t => {
  const f = fixture(t);
  const job = f.submit({ route: 'auto', prompt: 'Review the security decision.' });
  assert.equal(job.route, 'openai-api');
  assert.equal(job.model, 'gpt-6.2-sol');
  assert.equal(job.effort, 'high');
  assert.equal(job.options.selection.intent, 'deep');
  assert.ok(job.options.selection.reasons.includes('risk:security'));
});

test('internal origins use inference and resume preserves copied native fields', t => {
  const f = fixture(t);
  const review = f.internal('auto_review');
  assert.equal(review.options.selection.intent, 'review');
  assert.equal(review.options.selection.eff, 'med');

  const yielded = f.internal('yield');
  assert.equal(yielded.options.selection.intent, 'deep');
  assert.equal(yielded.effort, 'high');

  // Use a valid Responses model distinct from the inferred code profile's model.
  const resumed = f.internal('resume', { model: 'gpt-6-luna', effort: 'low' });
  assert.equal(resumed.model, 'gpt-6-luna');
  assert.equal(resumed.effort, 'low');
  assert.equal(resumed.options.selection.source, 'inferred');
});

test('seedProfiles upgrades exact old API seeds while preserving model and effort edits', t => {
  const f = fixture(t);
  const update = f.db().prepare(`UPDATE platform_profiles SET native_model=?,native_effort=?
    WHERE adapter_id='openai-api' AND intent=? AND eff=?`);
  update.run('gpt-6-luna', 'medium', 'code', 'med');
  update.run('gpt-6-luna', 'high', 'code', 'max');
  update.run('gpt-6-luna', 'low', 'fast', 'low');
  update.run('operator-model', 'medium', 'review', 'med');
  update.run('gpt-6-luna', 'low', 'deep', 'high');

  f.reopen();

  const profile = (intent: string, eff: string) => f.db().prepare(`SELECT native_model,native_effort
    FROM platform_profiles WHERE adapter_id='openai-api' AND intent=? AND eff=?`).get(intent, eff) as {
      native_model: string; native_effort: string;
    };

  assert.equal(profile('code', 'med').native_model, 'gpt-6.1-terra');
  assert.equal(profile('code', 'med').native_effort, 'medium');
  assert.equal(profile('code', 'max').native_model, 'gpt-6.2-astra');
  assert.equal(profile('code', 'max').native_effort, 'max');
  assert.equal(profile('fast', 'low').native_model, 'gpt-6-luna');
  assert.equal(profile('fast', 'low').native_effort, 'low');
  assert.equal(profile('review', 'med').native_model, 'operator-model');
  assert.equal(profile('review', 'med').native_effort, 'medium');
  assert.equal(profile('deep', 'high').native_model, 'gpt-6-luna');
  assert.equal(profile('deep', 'high').native_effort, 'low');

  // A second startup neither reverts the upgrade nor overwrites the operator's edits.
  f.reopen();
  assert.equal(profile('code', 'max').native_effort, 'max');
  assert.equal(profile('review', 'med').native_model, 'operator-model');
  assert.equal(profile('deep', 'high').native_effort, 'low');
});
