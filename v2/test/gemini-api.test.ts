// gemini-api route (d734): the Gemini credit helper admits every request; the adapter reads its credits, validates
// spend fields, and probes readiness without spending.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { geminiApi } from '../src/adapters/gemini-api.ts';
import { parseLocalWorkerPolicy, releaseWorkerPolicy, workerPolicyFromConfig } from '../src/worker-policy.ts';

function fixture(t: TestContext, reply: unknown, code = 0) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-gemini-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const script = path.join(home, 'helper.cjs');
  fs.writeFileSync(script, `process.stdout.write(${JSON.stringify(JSON.stringify(reply))}); process.exitCode = ${code};`);
  return { home, options: { geminiHelper: { file: process.execPath, prefix: [script], cwd: home } }, overrides: {} } as any;
}

test('gemini-api reads the helper credits as a grant row and a paced weekly row', async t => {
  const ctx = fixture(t, { status: 'ready', credits: {
    status: 'snapshot', grant_observed_at: '2026-11-25T18:00:00Z', observed_balance_usd: '10',
    estimated_remaining_usd: '9.5', spendable_estimate_after_reservations_usd: '9.5',
    grants: [{ grant_id: 'g', balance_usd: '10', expires_on: '2027-11-01' }],
    observed_credit_by_kind_usd: { promotional: '10', prepaid: '5' },
    monthly_budget: { target_usd: '10', available_for_new_requests_usd: '0' },
    weekly_budget: { status: 'active', weekly_limit_usd: '2.333333', available_for_new_requests_usd: '1.75', reset_at: '2030-01-07T00:00:00Z' },
  } });
  const snapshot = await geminiApi.observeUsage!(ctx);
  assert.deepEqual(snapshot!.rows.map(r => [r.pool, r.window, Math.round(r.remaining_percent ?? -1), r.resets_at]), [
    ['prepaid', 'grant', 95, '2027-11-01T00:00:00.000Z'],
    ['prepaid', 'weekly', 75, '2030-01-07T00:00:00.000Z'],
    ['prepaid', 'rolling budget', 0, null],
  ]);
  assert.match(snapshot!.source, /^Gemini helper credits; observed balance \$10/);
  assert.match(snapshot!.source, /Google balance observed 2026-11-25T18:00:00.000Z/);
  assert.match(snapshot!.source, /promotional \$10, purchased \$5 at observation/);
  assert.deepEqual(geminiApi.routeQuotaWindows!(snapshot!.rows.map(r => ({ ...r, route: 'gemini-api', observed_at: '', source: '', stale: false })))
    .map(r => r.window), ['grant', 'rolling budget']);
});

test('blocked helper status closes grant and pacing rows even if its balance is positive', async t => {
  const ctx = fixture(t, { status: 'blocked', blockers: ['funding_stale'], credits: { observed_balance_usd: '10' } }, 2);
  const usage = await geminiApi.observeUsage!(ctx);
  assert.deepEqual(usage?.rows.map(row => [row.window, row.remaining_percent]), [['grant', 0], ['weekly', 0], ['rolling budget', 0]]);
  assert.match(usage!.source, /funding_stale/);
});

test('operator policy can enable Gemini advice while gating edits and tool sets', () => {
  assert.equal(releaseWorkerPolicy('gemini-api', null, 'advice'), 'WORKER_ROUTE_GATED');
  const policy = workerPolicyFromConfig(parseLocalWorkerPolicy({
    schemaVersion: 1, allowRoutes: ['gemini-api'], allowNativeEdit: true, allowApprovedToolsets: true,
  }));
  assert.equal(policy('gemini-api', null, 'advice'), null);
  assert.equal(policy('gemini-api', null, 'edit', true), 'WORKER_MODE_GATED');
  assert.equal(policy('gemini-api', 'project', 'advice'), 'WORKER_TOOLSET_GATED');
});

test('gemini-api is verified only when the helper reports ready', async t => {
  assert.equal((await geminiApi.probe(fixture(t, { status: 'ready', blockers: [] }))).state, 'verified');
  const blocked = await geminiApi.probe(fixture(t, { status: 'blocked', blockers: ['credential_missing', 'funding_missing'] }));
  assert.equal(blocked.state, 'unavailable');
  assert.match(blocked.reason ?? '', /credential_missing, funding_missing/);
});

test('restart recovers a settled result and accounting from the helper before reading worker stdout', async t => {
  const ctx = fixture(t, { job: { status: 'completed', actual_usd: '0.01',
    usage: { promptTokenCount: 20, candidatesTokenCount: 10, thoughtsTokenCount: 5 } },
    result: { status: 'completed', job_id: 'recover', text: 'answer', finish_reason: 'STOP', model: 'gemini-revision' },
  });
  const updates: unknown[] = [];
  await geminiApi.reconcile!({ id: 'recover' }, { ...ctx, store: {
    home: ctx.home, updateJob: (id: string, fields: unknown) => updates.push([id, fields]),
  } });
  assert.deepEqual(updates, [['recover', { cost_usd: '0.01', tokens_in: 20, tokens_out: 15,
    status: 'completed', error: null, result: 'answer', reported_model: 'gemini-revision' }]]);
});

test('discovery publishes current Gemini lines and validation refuses their older IDs', async t => {
  const entry = { prices: [{ from: '2026-01-01', input: '1', output: '5' }], output_token_limit: 32768 };
  const latest = 'gemini-5-neon';
  const prior = 'gemini-4-neon';
  const snapshot = { status: 'observed', observed_at: '2026-11-25T18:00:00Z',
    models: { [latest]: entry, 'gemini-3.5-flash-lite': entry }, superseded: { [prior]: latest }, unavailable: {} };
  const ctx = fixture(t, snapshot);
  fs.mkdirSync(path.join(ctx.home, '.local'));
  fs.writeFileSync(path.join(ctx.home, '.local', 'model-catalog.json'), JSON.stringify(snapshot));
  const originalProfiles = [...geminiApi.profiles];
  const originalDefault = geminiApi.capabilities.defaultModel;
  t.after(() => {
    geminiApi.profiles.splice(0, geminiApi.profiles.length, ...originalProfiles);
    geminiApi.capabilities.defaultModel = originalDefault;
  });
  const rows = await geminiApi.discover!(ctx);
  assert.deepEqual(rows.map(row => [row.model, row.state]),
    [[latest, 'verified'], ['gemini-3.5-flash-lite', 'verified'], [prior, 'retired']]);
  assert.equal(geminiApi.capabilities.defaultModel, latest);
  const job = { mode: 'advice', minutes: 10, home: ctx.home, options: ctx.options } as const;
  const args = { max_cost_usd: '1', purpose: 'p', deliverable: 'd' };
  assert.equal(geminiApi.validate(args, { ...job, model: latest }).max_cost_usd, '1');
  assert.throws(() => geminiApi.validate(args, { ...job, model: prior }), /superseded by gemini-5-neon/);
  assert.throws(() => geminiApi.validate({ ...args, max_output_tokens: 50000 }, { ...job, model: latest }), /limit of 32768/);
});

test('gemini-api jobs need registered models and a ceiling of at most $2', () => {
  const root = path.resolve(import.meta.dirname, '..', '..', 'tools', 'gemini-capabilities');
  const previous = process.env.AGENT_COMMONS_GEMINI_HELPER_ROOT;
  process.env.AGENT_COMMONS_GEMINI_HELPER_ROOT = root;
  try {
    const job = { mode: 'advice', minutes: 10 } as any;
    const ok = geminiApi.validate({ max_cost_usd: '0.50', purpose: 'p', deliverable: 'd' }, { ...job, model: 'gemini-4-neon' });
    assert.equal(ok.max_cost_usd, '0.50');
    assert.throws(() => geminiApi.validate({ max_cost_usd: '5', purpose: 'p', deliverable: 'd' }, { ...job, model: 'gemini-4-neon' }), /up to 2/);
    assert.throws(() => geminiApi.validate({ max_cost_usd: '0.5', purpose: 'p', deliverable: 'd' }, { ...job, model: 'gemini-unknown' }), /no effective price/);
    assert.throws(() => geminiApi.checkBudget!({ model: 'gemini-4-neon', effort: null, promptChars: 1, input: {},
      options: { max_cost_usd: '0.01', max_output_tokens: 8192 } }), /cannot cover the estimated prompt and output reservation/);
    assert.throws(() => geminiApi.checkBudget!({ model: 'gemini-4-neon', effort: null, promptChars: 200000, input: {},
      options: { max_cost_usd: '0.60', max_output_tokens: 8192 } }), /cannot cover the estimated prompt and output reservation/);
    const est = geminiApi.estimatedCost!('gemini-4-neon', null, 3000, { max_output_tokens: 8192 });
    assert.ok(est && est.worstCaseUsd! > est.expectedUsd && est.worstCaseUsd! < 2);
  } finally {
    if (previous === undefined) delete process.env.AGENT_COMMONS_GEMINI_HELPER_ROOT;
    else process.env.AGENT_COMMONS_GEMINI_HELPER_ROOT = previous;
  }
});
