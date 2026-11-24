// Allowance-aware route=auto (j20 section 1, stage 6): prefer allowance that would lapse unused, hold back scarce
// allowance, only among eligible routes of the same billing class, never changing limits.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, type Actor } from './fixtures/service.ts';
import { adapter } from '../src/adapters/registry.ts';
import { bindingWindow, classifyAllowance, formatCompactDuration, formatPaceSummary, windowLengthMs, windowPace, windowProjection } from '../src/allowance.ts';
import type { UsageWindow } from '../src/adapters/types.ts';

const H = 3600_000, NOW = Date.parse('2026-11-20T12:00:00Z');
const w = (pool: string, window: string, remaining: number | null, resetsInMs: number | null, extra: Partial<UsageWindow> = {}): UsageWindow => ({
  route: 'r', pool, window, remaining_percent: remaining, resets_at: resetsInMs === null ? null : new Date(NOW + resetsInMs).toISOString(),
  observed_at: new Date(NOW).toISOString(), source: 'test', stale: false, ...extra,
});

test('window lengths come from labels only when the label states them', () => {
  assert.equal(windowLengthMs('300m'), 5 * H);
  assert.equal(windowLengthMs('10080m'), 168 * H);
  assert.equal(windowLengthMs('5-hour'), 5 * H);
  assert.equal(windowLengthMs('5h'), 5 * H);
  assert.equal(windowLengthMs('weekly'), 168 * H);
  assert.equal(windowLengthMs('grant'), null);
});

test('the binding window decides: expiring, scarce, or neutral', () => {
  // A 5-hour window with 80% left resetting within the last quarter of its length would lapse unused.
  assert.equal(classifyAllowance([w('p', '300m', 80, 1 * H)], NOW).cls, 'expiring');
  assert.equal(classifyAllowance([w('p', '300m', 80, 3 * H)], NOW).cls, 'neutral', 'too early to call it lapsing');
  assert.equal(classifyAllowance([w('p', '300m', 40, 1 * H)], NOW).cls, 'neutral', 'not enough left');
  // The weekly window binds the pool, so a generous 5-hour window does not make the pool expiring.
  assert.equal(classifyAllowance([w('p', '300m', 90, 1 * H), w('p', '10080m', 25, 100 * H)], NOW).cls, 'scarce');
  assert.equal(classifyAllowance([w('p', '10080m', 25, 20 * H)], NOW).cls, 'neutral', 'scarce allowance that refills soon is not held back');
  // Independent pools are alternatives: the best pool decides.
  assert.equal(classifyAllowance([w('a', 'weekly', 2, 100 * H), w('b', 'weekly', 70, 30 * H)], NOW).cls, 'expiring');
  // Unknown length: the fallback horizon applies.
  assert.equal(classifyAllowance([w('prepaid', 'grant', 90, 10 * H)], NOW).cls, 'expiring');
  assert.equal(classifyAllowance([w('prepaid', 'grant', 90, 30 * 24 * H)], NOW).cls, 'neutral');
  // Unknown, stale, closed, or no reset time: neutral, never plentiful.
  assert.equal(classifyAllowance([], NOW).cls, 'neutral');
  assert.equal(classifyAllowance([w('p', '300m', null, 1 * H)], NOW).cls, 'neutral');
  assert.equal(classifyAllowance([w('p', '300m', 80, 1 * H, { stale: true })], NOW).cls, 'neutral');
  assert.equal(classifyAllowance([w('p', '300m', 80, 1 * H, { closed: true })], NOW).cls, 'neutral');
  assert.equal(classifyAllowance([w('p', '300m', 80, null)], NOW).cls, 'neutral');
  assert.equal(classifyAllowance([w('p', '300m', 80, 1 * H), w('p', 'weekly', null, 50 * H)], NOW).cls, 'neutral', 'an unknown window makes its pool unknown');
});

function fixture(t: any) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-allowance-'));
  const home = path.join(fixtureRoot, 'data');
  const repo = path.join(fixtureRoot, 'repo'); fs.mkdirSync(repo);
  const store = new Store(home);
  t.after(() => { try { store.close(); } catch {} fs.rmSync(fixtureRoot, { recursive: true, force: true }); });
  const claude: Actor = store.createActor('claude-desktop', 'participant', 'claude-desktop').actor;
  store.setActorTags('claude-desktop', 'anthropic', 'claude');
  for (const id of ['claude', 'codex', 'openai-api']) store.recordProbe(adapter(id)!.capabilities, { state: 'verified', cliVersion: '1.0' });
  store.call(claude, 'project_create', { name: 'Repo', root: repo, operation_id: randomUUID() });
  const auto = (extra: Record<string, unknown> = {}) =>
    store.call(claude, 'job_submit', { project_id: 'p1', prompt: 'x', route: 'auto', operation_id: randomUUID(), ...extra }).job;
  const usage = (route: string, window: string, remaining: number, resetsInMs: number) =>
    store.recordUsage(route, [{ pool: 'main', window, remaining_percent: remaining, resets_at: new Date(Date.now() + resetsInMs).toISOString() }], 'test');
  return { store, auto, usage };
}

test('route=auto prefers a comparable route whose allowance would lapse unused, and records why', t => {
  const f = fixture(t);
  assert.equal(f.auto().route, 'claude', 'registry order without usage evidence');
  f.store.db.prepare("UPDATE jobs SET status='cancelled'").run();
  f.usage('codex', '300m', 85, 30 * 60_000);
  const job = f.auto();
  assert.equal(job.route, 'codex');
  assert.match(job.options.auto.allowance.codex, /^expiring:main\/300m@85%$/);
  assert.ok(job.options.selection.reasons.includes('allowance:expiring:main/300m@85%'));
});

test('route=auto holds back scarce allowance while a comparable route can serve, but still uses it alone', t => {
  const f = fixture(t);
  f.usage('claude', '10080m', 25, 100 * H);
  const job = f.auto();
  assert.equal(job.route, 'codex');
  assert.ok(job.options.selection.reasons.includes('allowance:held_back_scarce'));
  f.store.db.prepare("UPDATE jobs SET status='cancelled'").run();
  f.store.setCooldown('codex', '2100-01-01T00:00:00.000Z', 'limit');
  assert.equal(f.auto().route, 'claude', 'scarce is held back, not refused');
});

test('allowance never outranks billing class, load, or operator priority, and changes no limits', t => {
  const f = fixture(t);
  const limits = JSON.stringify(f.store.effectiveLimits(['claude', 'codex', 'openai-api']));
  // An expiring prepaid grant does not pull work onto the paid route.
  f.usage('openai-api', 'grant', 95, 2 * H);
  f.usage('claude', '10080m', 25, 100 * H);
  f.store.setCooldown('codex', '2100-01-01T00:00:00.000Z', 'limit');
  assert.equal(f.auto({ cost: 'paid', max_cost_usd: '0.05', purpose: 'p', deliverable: 'd' }).route, 'claude');
  f.store.clearCooldown('codex');
  f.store.db.prepare("UPDATE jobs SET status='cancelled'").run();
  // A busy expiring route does not beat an idle one.
  f.usage('codex', '300m', 85, 30 * 60_000);
  f.store.db.prepare("DELETE FROM usage_windows WHERE route='claude'").run();
  f.auto({ route: 'codex' });
  assert.equal(f.auto().route, 'claude', 'codex has a queued job');
  f.store.db.prepare("UPDATE jobs SET status='cancelled'").run();
  // Operator priority wins over allowance.
  f.store.db.prepare("UPDATE platform_profiles SET priority=5 WHERE adapter_id='claude' AND intent='review' AND eff='high'").run();
  assert.equal(f.auto({ intent: 'review', eff: 'high' }).route, 'codex', 'reviews still prefer another family');
  f.store.db.prepare("UPDATE jobs SET status='cancelled'").run();
  f.store.db.prepare("UPDATE platform_profiles SET priority=5 WHERE adapter_id='claude' AND intent='code' AND eff='med'").run();
  assert.equal(f.auto({ intent: 'code', eff: 'med' }).route, 'claude');
  assert.equal(JSON.stringify(f.store.effectiveLimits(['claude', 'codex', 'openai-api'])), limits);
});

test('ties and loose labels classify the same whatever the input order', () => {
  assert.equal(windowLengthMs('30-day'), 30 * 24 * H);
  assert.equal(windowLengthMs('biweekly'), null);
  assert.equal(windowLengthMs('daily'), 24 * H);
  // Within a pool, an equal-remaining tie binds to the later reset (not expiring), in either order.
  const short = w('p', '300m', 80, 1 * H), long = w('p', 'weekly', 80, 100 * H);
  assert.equal(classifyAllowance([short, long], NOW).cls, 'neutral');
  assert.equal(classifyAllowance([long, short], NOW).cls, 'neutral');
  // Across pools, an equal-remaining tie prefers the sooner reset (use it or lose it), in either order.
  const a = w('a', '300m', 80, 1 * H), b = w('b', '300m', 80, 3 * H);
  assert.equal(classifyAllowance([a, b], NOW).cls, 'expiring');
  assert.equal(classifyAllowance([b, a], NOW).cls, 'expiring');
  // Stale windows are ignored; a closed window binds its pool at zero, leaving another pool to decide.
  assert.equal(classifyAllowance([w('p', '300m', 80, 1 * H), w('p', 'weekly', 5, 100 * H, { stale: true })], NOW).cls, 'expiring');
  assert.equal(classifyAllowance([w('p', '300m', 80, 1 * H, { closed: true }), w('q', 'weekly', 20, 100 * H)], NOW).cls, 'scarce');
});

test('an outcome-history swap keeps the allowance reason unless it lands on the no-allowance winner', t => {
  const f = fixture(t);
  const hooks = f.store as unknown as {
    pickRouteByPolicy: (...args: any[]) => unknown;
    jobConfiguration: (...args: any[]) => unknown;
    pickRoute: (actor: unknown, input: unknown, mode: string, intent: string, eff: string) => { route: string; outcomeHistory?: true; allowanceDecided?: true };
  };
  const base = { billing: 'sub', priority: 0, lowQuota: 0, running: 0, queued: 0, limit: 1, success: 1, allowance: { cls: 'expiring' } };
  let without = 'a';
  hooks.pickRouteByPolicy = (_actor, _input, _mode, _intent, _eff, observe) => {
    observe([{ ...base, id: 'b', order: 1 }, { ...base, id: 'c', order: 2 }, { ...base, id: 'a', order: 0, allowance: { cls: 'scarce' } }]);
    return { route: 'b', considered: ['b', 'c', 'a'], allowanceDecided: true, withoutAllowance: without };
  };
  hooks.jobConfiguration = () => ({ model: 'native', effort: 'normal' });
  const profile = f.store.db.prepare(`INSERT INTO platform_profiles(adapter_id,intent,eff,native_model,native_effort,priority,updated_at)
    VALUES(?,'code','med','native','normal',0,?)`);
  for (const route of ['a', 'b', 'c']) profile.run(route, new Date().toISOString());
  const decide = (route: string, kind: string) => {
    const id = randomUUID();
    f.store.db.prepare(`INSERT INTO jobs(id,project_id,route,mode,prompt,status,timeout_ms,created_by,created_at,req_intent,req_eff,resolved_model,resolved_eff)
      VALUES(?,(SELECT id FROM projects LIMIT 1),?,'advice','x','completed',1000,'claude-desktop',?,'code','med','native','normal')`).run(id, route, new Date().toISOString());
    f.store.db.prepare("INSERT INTO job_outcomes(job_id,kind,detail,actor_id,created_at) VALUES(?,?,'t','claude-desktop',?)").run(id, kind, new Date().toISOString());
  };
  for (let i = 0; i < 10; i++) { decide('b', 'rejected'); decide('c', 'accepted'); }
  const swapped = hooks.pickRoute({ id: 'claude-desktop' }, {}, 'advice', 'code', 'med');
  assert.equal(swapped.route, 'c');
  assert.equal(swapped.outcomeHistory, true);
  assert.equal(swapped.allowanceDecided, true);
  without = 'c';
  assert.equal(hooks.pickRoute({ id: 'claude-desktop' }, {}, 'advice', 'code', 'med').allowanceDecided, undefined);
});

test('windowPace and windowProjection calculate advisory burn rate, early guard, and Antigravity 5h labels', () => {
  assert.equal(windowLengthMs('Five Hour Limit Remaining'), 5 * H);
  assert.equal(windowLengthMs('Weekly Limit Remaining'), 168 * H);
  assert.equal(formatCompactDuration(0), '0m');
  assert.equal(formatCompactDuration(45 * 60_000), '45m');
  assert.equal(formatCompactDuration((18 * 60 + 20) * 60_000), '18h 20m');
  assert.equal(formatCompactDuration((76 * 60) * 60_000), '3d 4h');

  // 50% time left, 75% quota left -> 150% pace, +50% projected at reset
  const ahead = w('default', '10080m', 75, 84 * H);
  const pAhead = windowPace(ahead, NOW)!;
  assert.ok(Math.abs(pAhead.elapsedPercent - 50) < 1e-6);
  assert.ok(Math.abs(pAhead.pacePercent - 150) < 1e-6);
  const projAhead = windowProjection(ahead, NOW)!;
  assert.equal(projAhead.kind, 'remaining_at_reset');
  if (projAhead.kind === 'remaining_at_reset') assert.ok(Math.abs(projAhead.percent - 50) < 1e-6);
  assert.equal(formatPaceSummary(ahead, NOW), 'pace 150%, proj +50% at reset');

  // 50% time left, 25% quota left -> 50% pace, 75% used in 84h => runs out in 28h
  const fast = w('default', '10080m', 25, 84 * H);
  const projFast = windowProjection(fast, NOW)!;
  assert.equal(projFast.kind, 'runs_out');
  if (projFast.kind === 'runs_out') assert.ok(Math.abs(projFast.afterMs - 28 * H) < 1e-3);
  assert.equal(formatPaceSummary(fast, NOW), 'pace 50%, proj runs out in 1d 4h');

  // Under 5% elapsed -> too_early projection, pace still returned
  const early = w('default', '10080m', 98, 165 * H);
  assert.equal(windowProjection(early, NOW)?.kind, 'too_early');
  assert.match(formatPaceSummary(early, NOW)!, /^pace \d+%$/);

  // Zero used -> projects current remaining at reset
  const unused = w('default', '5h', 100, 2.5 * H);
  assert.deepEqual(windowProjection(unused, NOW), { kind: 'remaining_at_reset', percent: 100 });

  // Zero remaining or closed -> runs_out 0ms
  assert.deepEqual(windowProjection(w('default', '5h', 0, 2 * H), NOW), { kind: 'runs_out', afterMs: 0 });
  assert.deepEqual(windowProjection(w('default', '5h', 0, 2 * H, { closed: true }), NOW), { kind: 'runs_out', afterMs: 0 });

  // Stale or unknown window length -> null
  assert.equal(windowPace(w('default', '5h', 80, 2 * H, { stale: true }), NOW), null);
  assert.equal(windowProjection(w('default', '5h', 80, 2 * H, { stale: true }), NOW), null);
  assert.equal(windowPace(w('prepaid', 'grant', 80, 2 * H), NOW), null);
  assert.equal(windowPace(w('default', '5h', 80, null), NOW), null);
  assert.equal(bindingWindow([w('p', '300m', 90, 1 * H), w('p', '10080m', 25, 100 * H)])?.window, '10080m');
});
