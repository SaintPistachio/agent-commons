import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Store, CommonsError, type Actor, type Json } from './fixtures/service.ts';
import { adapter, DEFAULT_ROUTE } from '../src/adapters/registry.ts';
import { chooseClaudeModel, chooseCodexModel, cliEfforts, type CatalogSnapshot } from '../src/adapters/cli-models.ts';
import { compareCostEfficiency, isModelEntitled } from '../src/adapters/model-pricing.ts';
import { AIR_WORKER_PRIMER } from '../src/air/primer.ts';
import { checkWorkerBlock } from '../src/air/worker.ts';
import { cooldownUntil } from '../src/cooldown.ts';
import { acceptanceHistory, appendOutcome } from '../src/outcomes.ts';
import { claude } from '../src/adapters/claude.ts';

function setupStore(t: TestContext, routes: string[] = ['claude', 'codex', 'openai-api', 'antigravity']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-orch-opt-'));
  const home = path.join(dir, 'home');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(home);
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'index.ts'), 'export const x = 1;\n');
  const store = new Store(home);
  t.after(() => {
    try { store.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  for (const id of routes) {
    store.recordProbe(adapter(id)!.capabilities, { state: 'verified', cliVersion: '1.0' });
  }
  const actor: Actor = store.createActor('claude-desktop', 'participant', 'claude-desktop').actor;
  store.setActorTags('claude-desktop', 'anthropic', 'claude');
  store.call(actor, 'project_create', { name: 'Repo', root: repo, operation_id: randomUUID() });
  const db = (store as unknown as { db: DatabaseSync }).db;
  return { dir, home, repo, store, actor, db };
}

test('AIR_WORKER_PRIMER avoids BNF bracket placeholders and literal worker block parses cleanly', () => {
  assert.equal(/\[(?:key=|#0|to=|eff=|ctx=|\.\.)/i.test(AIR_WORKER_PRIMER), false);
  assert.match(AIR_WORKER_PRIMER, /NO square brackets/);
  const verdict = checkWorkerBlock('Verified.\n@air1\n#0 chk verdict=ok p=.9 "complete"');
  assert.equal(verdict.ok, true);
  if (verdict.ok) {
    assert.equal(verdict.verdict, 'ok');
    assert.equal(verdict.p, 0.9);
  }
});

test('fable and carbon are entitlement-gated with max fallback to opus/sol and reversible unentitled state', t => {
  const { store, actor } = setupStore(t);

  // Claude: eff=max falls back to opus by default, uses fable only when entitled, reverts when marked unentitled.
  const claudeSnap: CatalogSnapshot = {
    state: 'trusted', source: 'cli-catalog', selected: '2.4.0', producer: '2.4.0', fetched: Date.now(),
    models: [
      { id: 'claude-sonnet-5-5', family: 'sonnet', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium', hidden: false, versionParts: ['5', '5'] },
      { id: 'claude-opus-5-5', family: 'opus', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', hidden: false, versionParts: ['5', '5'] },
      { id: 'claude-fable-5-2', family: 'fable', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', hidden: false, versionParts: ['5', '2'] },
    ],
  };
  const withoutEntitlement = chooseClaudeModel({
    intent: 'deep', eff: 'max', model: null, effort: 'max', explicitModel: false, explicitEffort: false,
    tracksLatest: true, allowPremium: true,
  }, claudeSnap);
  assert.equal(withoutEntitlement.model, 'opus');
  assert.equal(chooseClaudeModel({
    intent: 'deep', eff: 'max', model: null, effort: 'max', explicitModel: false, explicitEffort: false,
    tracksLatest: true, allowPremium: true,
    entitledModels: new Set(['fable']),
  }, claudeSnap).model, 'fable');

  store.markModelUnentitled('claude', 'fable', 'not entitled on plan');
  assert.equal(store.modelEntitlements('claude').unentitled.has('fable'), true);
  const jobAfterUnentitled = store.call(actor, 'job_submit', {
    project_id: 'p1', route: 'claude', intent: 'deep', eff: 'max', prompt: 'Deep check.', operation_id: randomUUID(),
  }).job as Json;
  assert.notEqual(jobAfterUnentitled.model, 'fable');

  store.markModelValidated('claude', 'fable');
  assert.equal(store.modelEntitlements('claude').entitled.has('fable'), true);
  assert.equal(chooseClaudeModel({
    intent: 'deep', eff: 'max', model: null, effort: 'max', explicitModel: false, explicitEffort: false,
    tracksLatest: true, allowPremium: true,
    entitledModels: store.modelEntitlements('claude').entitled,
    unentitledModels: store.modelEntitlements('claude').unentitled,
  }, claudeSnap).model, 'fable');

  // Codex: astra fallback to sol when unentitled.
  const codexCache: CatalogSnapshot = {
    state: 'trusted', source: 'cli-cache', selected: '0.171.0', producer: '0.171.0', fetched: Date.now(),
    models: [
      { id: 'gpt-6-luna', family: 'luna', efforts: ['low', 'medium'], defaultEffort: 'low', hidden: false, versionParts: ['6'] },
      { id: 'gpt-6.1-terra', family: 'terra', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', hidden: false, versionParts: ['6', '1'] },
      { id: 'gpt-6.2-sol', family: 'sol', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium', hidden: false, versionParts: ['6', '2'] },
      { id: 'gpt-6.2-astra', family: 'astra', efforts: ['medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', hidden: false, versionParts: ['6', '2'] },
    ],
  };
  assert.equal(chooseCodexModel({
    intent: 'deep', eff: 'max', model: null, explicitModel: false, explicitEffort: false,
    tracksLatest: true, allowPremium: true, effort: cliEfforts.max,
  }, codexCache).model, 'gpt-6.2-astra');

  const codexFallback = chooseCodexModel({
    intent: 'deep', eff: 'max', model: null, explicitModel: false, explicitEffort: false,
    tracksLatest: true, allowPremium: true, effort: cliEfforts.max,
    unentitledModels: new Set(['gpt-6.2-astra']),
  }, codexCache);
  assert.equal(codexFallback.model, 'gpt-6.2-sol');
  assert.equal(codexFallback.effort, 'xhigh');

  // Antigravity: carbon is skipped when unentitled and max effort fits to xhigh.
  store.markModelUnentitled('antigravity', 'gemini-4-carbon', 'not entitled');
  const agPlan = store.planRoute(actor, { route: 'antigravity', intent: 'deep', eff: 'max', prompt: 'Inspect architecture' }) as Json;
  assert.notEqual(agPlan.resolved.model, 'gemini-4-carbon');
  assert.equal(agPlan.resolved.effort, 'xhigh');
});

test('compareCostEfficiency proves sol@medium dominates terra@max on both capability tier and expected cost', () => {
  const ranked = compareCostEfficiency([
    { model: 'gpt-6.1-terra', effort: 'high' },
    { model: 'gpt-6.1-terra', effort: 'max' },
    { model: 'gpt-6.2-sol', effort: 'medium' },
    { model: 'gpt-6.2-sol', effort: 'low' },
  ], 2000);
  const terraMax = ranked.find(r => r.model === 'gpt-6.1-terra' && r.effort === 'max')!;
  const solMed = ranked.find(r => r.model === 'gpt-6.2-sol' && r.effort === 'medium')!;
  assert.ok(solMed.tier > terraMax.tier);
  assert.ok(solMed.expectedUsd <= terraMax.expectedUsd);
  assert.ok(terraMax.dominatedBy);
});

test('openai-api checkBudget fails fast with BUDGET_TOO_LOW instead of silently downgrading model or tokens', t => {
  const { store, actor } = setupStore(t);
  assert.throws(() => store.call(actor, 'job_submit', {
    project_id: 'p1', route: 'openai-api', intent: 'deep', eff: 'high',
    max_cost_usd: '0.005', max_output_tokens: 8192,
    purpose: 'budget check', deliverable: 'review',
    prompt: 'Analyze security architecture.', operation_id: randomUUID(),
  }), (err: unknown) => err instanceof CommonsError && err.code === 'BUDGET_TOO_LOW');
});

test('default route is auto and prefers workspace-read routes when repo context or workspace wording is needed', t => {
  assert.equal(DEFAULT_ROUTE, 'auto');
  const { store, actor } = setupStore(t, ['antigravity', 'codex']);
  // Give antigravity higher allowance (90% vs codex 30%) so without workspace preference antigravity would lead,
  // proving hasWorkspaceReadTools breaks the tie when repo files are needed.
  const in1h = new Date(Date.now() + 3600_000).toISOString();
  const in4h = new Date(Date.now() + 4 * 3600_000).toISOString();
  store.recordUsage('codex', [{ pool: 'primary', window: '5h', remaining_percent: 25, resets_at: in4h }], 'operator');
  store.recordUsage('antigravity', [{ pool: 'Gemini Models', window: 'Five Hour Limit Remaining', remaining_percent: 90, resets_at: in1h }], 'operator');
  const job = store.call(actor, 'job_submit', {
    project_id: 'p1', prompt: 'Inspect v2/src/store.ts and explain route selection.', operation_id: randomUUID(),
  }).job as Json;
  assert.equal(job.route, 'codex');
  assert.equal(job.options.auto.picked, 'codex');
  assert.equal(job.options.auto.workspace_read_preferred, true);
});

test('non-noop repair avoids clamped duplicate steps by failing over across subscription routes or refusing NO_STRONGER_PROFILE', t => {
  const { store, actor, repo, db } = setupStore(t, ['antigravity', 'codex']);
  const orig = store.call(actor, 'job_submit', {
    project_id: 'p1', route: 'antigravity', intent: 'code', eff: 'med', task: 'explain',
    protocol: 'air', prompt: 'Explain this bounded behavior.', operation_id: randomUUID(),
  }).job as Json;
  store.updateJob(orig.id, { status: 'running', workdir: repo });
  store.updateJob(orig.id, { status: 'completed', result: 'Missing air block', finished_at: new Date().toISOString() });

  const repair = db.prepare("SELECT * FROM jobs WHERE repair_of=?").get(orig.id) as Json;
  assert.ok(repair, 'expected failover repair job');
  assert.equal(repair.route, 'codex');
  const repairOpts = JSON.parse(repair.options);
  assert.equal(repairOpts.correction.kind, 'route_failover');
  assert.equal(repairOpts.correction.from, 'antigravity');
  assert.equal(repairOpts.correction.to, 'codex');

  // When codex is on cooldown and antigravity clamps at task='explain' medium, refuse with NO_STRONGER_PROFILE.
  store.setCooldown('codex', '2100-01-01T00:00:00.000Z', 'exhausted');
  const orig2 = store.call(actor, 'job_submit', {
    project_id: 'p1', route: 'antigravity', intent: 'code', eff: 'med', task: 'explain',
    protocol: 'air', prompt: 'Explain this again.', operation_id: randomUUID(),
  }).job as Json;
  store.updateJob(orig2.id, { status: 'running', workdir: repo });
  store.updateJob(orig2.id, { status: 'completed', result: 'Still missing air block', finished_at: new Date().toISOString() });
  assert.equal(db.prepare("SELECT * FROM jobs WHERE repair_of=?").get(orig2.id), undefined);
  const updated2 = store.jobRecord(orig2.id)!;
  assert.equal(updated2.options.repair.refused, 'NO_STRONGER_PROFILE');
});

test('cooldownUntil parses wall-clock reset times and claude.usage exposes closed 5h quota observations', () => {
  const refNow = Date.UTC(2026, 10, 21, 18, 0, 0); // 12:00pm America/Chicago (CST, UTC-6)
  const untilIso = cooldownUntil('You hit your limit · resets 2:10pm (America/Chicago)', refNow);
  const untilMs = Date.parse(untilIso);
  assert.ok(untilMs > refNow);
  // 2:10pm CST = 20:10 UTC (2h10m later)
  assert.equal(untilMs - refNow, (2 * 60 + 10) * 60 * 1000);

  const obs = claude.usage!({ usage: [{ pool: 'default', window: '5h', remaining_percent: 0, resets_at: untilIso, closed: true }] });
  assert.equal(obs.length, 1);
  assert.equal(obs[0].closed, true);
  assert.equal(obs[0].window, '5h');
  assert.equal(obs[0].remaining_percent, 0);
});

test('acceptanceHistory falls back hierarchically across efforts with conservative (accepted+2)/(weight+4) prior', t => {
  const { store, actor, db } = setupStore(t, ['codex']);
  const insertCompleted = (eff: string, kind: 'accepted' | 'rejected') => {
    const job = store.call(actor, 'job_submit', {
      project_id: 'p1', route: 'codex', intent: 'code', eff, prompt: 'Do work', operation_id: randomUUID(),
    }).job as Json;
    store.updateJob(job.id, { status: 'completed', finished_at: new Date().toISOString() });
    db.prepare('UPDATE jobs SET resolved_model=?, resolved_eff=? WHERE id=?')
      .run('gpt-6.1-terra', eff === 'high' ? 'high' : 'medium', job.id);
    appendOutcome(db, job.id, kind, kind, actor.id);
  };

  // 4 exact code/med samples (<10) + 8 code/high samples on same model = 12 pooled samples (>=10).
  for (let i = 0; i < 4; i++) insertCompleted('med', 'accepted');
  for (let i = 0; i < 8; i++) insertCompleted('high', 'accepted');

  const hist = acceptanceHistory(db, {
    route: 'codex', intent: 'code', eff: 'med', model: 'gpt-6.1-terra', nativeEffort: 'medium', mode: 'advice',
  });
  assert.equal(hist.n, 12);
  assert.ok(hist.rate !== null);
  // 12 accepted with (accepted+2)/(weight+4) -> ~14/16 = 0.875 (below unweighted 1.0, above naive 13/14).
  assert.ok(hist.rate! > 0.85 && hist.rate! < 0.90);
});

test('store.planRoute performs read-only dry-run across lookup, risk, and budget-error scenarios', t => {
  const { store, actor } = setupStore(t);

  const lookup = store.planRoute(actor, { prompt: 'List the exported functions in selection.ts' }) as Json;
  assert.equal(lookup.selection.intent, 'fast');
  assert.equal(lookup.selection.eff, 'low');
  assert.ok(lookup.selection.reasons.includes('bounded_lookup'));

  const risky = store.planRoute(actor, {
    prompt: 'Audit credential handling and authentication security.',
    context_refs: ['file:index.ts'],
  }) as Json;
  assert.equal(risky.selection.intent, 'deep');
  assert.equal(risky.selection.eff, 'high');

  const tightApi = store.planRoute(actor, {
    route: 'openai-api', intent: 'deep', eff: 'high', max_cost_usd: '0.005', max_output_tokens: 8192,
    prompt: 'Review auth',
  }) as Json;
  assert.match(String(tightApi.budget_error), /exceeding max_cost_usd/);
});

test('j118 fixes: exact-model unentitlement, 24h expiry, preferred protection, missing-rate budget skip, and claude no-op repair', t => {
  const { store, actor, repo, db } = setupStore(t, ['claude', 'codex', 'openai-api']);
  const openaiApi = adapter('openai-api')!;

  // 1. Exact-model unentitlement on gpt-6.3-sol must NOT exclude gpt-6.2-sol, and runtime unentitlement expires after 24h while operator override persists.
  store.markModelUnentitled('codex', 'gpt-6.3-sol', 'model_not_found');
  const entNow = store.modelEntitlements('codex');
  assert.equal(isModelEntitled('gpt-6.3-sol', entNow.entitled, entNow.unentitled), false);
  assert.equal(isModelEntitled('gpt-6.2-sol', entNow.entitled, entNow.unentitled), true);
  assert.equal(store.modelEntitlements('codex', Date.now() + 25 * 3600_000).unentitled.has('gpt-6.3-sol'), false);

  store.setModelEntitlement('codex', 'gpt-6.3-sol', false, 'operator');
  assert.equal(store.modelEntitlements('codex', Date.now() + 48 * 3600_000).unentitled.has('gpt-6.3-sol'), true);

  // 2. Preferred row is never demoted by markModelUnentitled.
  store.recordDiscovery('codex', [{ model: 'gpt-6.2-sol', family: 'sol', efforts: ['medium'], state: 'validated', source: 'cli-cache' }]);
  store.setModelState('codex', 'gpt-6.2-sol', 'preferred');
  store.markModelUnentitled('codex', 'gpt-6.2-sol', 'model_not_found');
  assert.equal(store.routeModels('codex').find(m => m.model === 'gpt-6.2-sol')?.state, 'preferred');

  // 3. checkBudget skips refusal when the OpenAI registry lacks a rate for that model.
  assert.doesNotThrow(() => openaiApi.checkBudget!({
    model: 'gpt-unlisted-custom', effort: 'high', promptChars: 1000,
    options: { max_output_tokens: 8192 }, input: { max_cost_usd: '0.001' }, home: store.home,
  }));

  // 4. Claude fast/min no-op repair skips clamped fast/low and steps to code/max instead.
  const claudeOrig = store.call(actor, 'job_submit', {
    project_id: 'p1', route: 'claude', intent: 'fast', eff: 'min',
    protocol: 'air', prompt: 'Quick check.', operation_id: randomUUID(),
  }).job as Json;
  store.updateJob(claudeOrig.id, { status: 'running', workdir: repo });
  store.updateJob(claudeOrig.id, { status: 'completed', result: 'Missing block', finished_at: new Date().toISOString() });
  const repair = db.prepare('SELECT req_intent, req_eff FROM jobs WHERE repair_of=?').get(claudeOrig.id) as Json;
  assert.equal(repair.req_intent, 'code');
  assert.equal(repair.req_eff, 'max');
});

test('route failover reaches prepaid spend-down only for a job that omitted cost', t => {
  const { store, actor, repo, db } = setupStore(t, ['antigravity', 'codex', 'openai-api']);
  store.recordUsage('openai-api', [{ pool: 'prepaid', window: 'weekly', remaining_percent: 90,
    resets_at: new Date(Date.now() + 24 * 3600_000).toISOString() }], 'test');
  store.setCooldown('codex', '2100-01-01T00:00:00.000Z', 'exhausted');
  const fail = (extra: Json) => {
    const orig = store.call(actor, 'job_submit', {
      project_id: 'p1', route: 'antigravity', intent: 'code', eff: 'med', task: 'explain', context_refs: ['file:index.ts'],
      protocol: 'air', prompt: `Explain this bounded behavior ${randomUUID()}.`, operation_id: randomUUID(), ...extra,
    }).job as Json;
    store.updateJob(orig.id, { status: 'running', workdir: repo });
    store.updateJob(orig.id, { status: 'completed', result: 'Missing air block', finished_at: new Date().toISOString() });
    return db.prepare('SELECT * FROM jobs WHERE repair_of=?').get(orig.id) as Json | undefined;
  };
  // An explicit cost=sub job never gets a paid repair.
  const strict = fail({ cost: 'sub' });
  assert.ok(!strict || strict.route !== 'openai-api');
  // A job that omitted cost may fail over into spend-down, with AC's ceiling and its own purpose.
  const open = fail({});
  assert.equal(open?.route, 'openai-api');
  const opts = JSON.parse(open!.options);
  assert.equal(opts.spend_down, true);
  assert.equal(opts.max_cost_usd, '2.00');
  assert.match(opts.purpose, /^prepaid grant spend-down: /);
});
