// One automatic repair per root job (j16 sections 3 and 5): explicit deliverable-failure evidence only, the smallest
// correction, never a replay of an uncertain outcome, never an edit job, and at most one per root.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, type Actor, type Json } from './fixtures/service.ts';
import { adapter } from '../src/adapters/registry.ts';
import { planCorrection, repairTrigger } from '../src/repair.ts';
import { SCHEMA_VERSION } from '../src/schema.ts';

const GOOD_AIR = 'Answer.\n@air1\n#0 chk "done" verdict=ok p=.9';
const BAD_AIR = 'Answer without a block.';

function fixture(t: any) {
  // The repository is outside the Agent Commons home, as in a real install (the home is denied to workspaces).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-repair-'));
  const home = path.join(dir, 'home'), repo = path.join(dir, 'repo'); fs.mkdirSync(home); fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'alpha\nbeta\n');
  const store = new Store(home);
  t.after(() => { try { store.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  const claude: Actor = store.createActor('claude-desktop', 'participant', 'claude-desktop').actor;
  store.setActorTags('claude-desktop', 'anthropic', 'claude');
  for (const id of ['claude', 'codex', 'openai-api']) store.recordProbe(adapter(id)!.capabilities, { state: 'verified', cliVersion: '1.0' });
  store.call(claude, 'project_create', { name: 'Repo', root: repo, operation_id: randomUUID() });
  const submit = (extra: Record<string, unknown> = {}) =>
    store.call(claude, 'job_submit', { project_id: 'p1', prompt: 'Do the thing.', route: 'claude', intent: 'code', eff: 'med', protocol: 'air', operation_id: randomUUID(), ...extra }).job as Json;
  const finish = (id: string, fields: Json) => {
    store.updateJob(id, { status: 'running', workdir: repo });
    return store.updateJob(id, { finished_at: new Date().toISOString(), ...fields });
  };
  const job = (id: string) => store.jobRecord(id)!;
  const repairs = () => store.db.prepare("SELECT id, repair_of, parent_job_id, req_intent, req_eff FROM jobs WHERE trigger='repair'").all() as Json[];
  return { home, repo, store, claude, submit, finish, job, repairs };
}

test('a malformed AIR block gets one repair at one effort step, linked and followed by waits', t => {
  const f = fixture(t);
  const original = f.submit();
  f.finish(original.id, { status: 'completed', result: BAD_AIR });
  const [repair] = f.repairs();
  assert.ok(repair, 'a repair job was submitted');
  assert.equal(repair.repair_of, original.id);
  assert.equal(repair.parent_job_id, original.id, 'the requester stays responsible through the parent link');
  assert.equal(repair.req_intent, 'code');
  assert.equal(repair.req_eff, 'high');
  const linked = f.job(original.id);
  assert.equal(linked.status, 'completed', 'the original attempt is unchanged');
  assert.equal(linked.options.repair.job, repair.id);
  assert.equal(linked.options.next, repair.id);
  const repaired = f.job(repair.id);
  assert.equal(repaired.route, 'claude');
  assert.equal(repaired.options.proto, 'air');
  assert.equal(repaired.options.repair_trigger, 'malformed_air');
  assert.ok(repaired.options.ctx.includes(`job:${f.store.handleOf('j', original.id)}`), 'the previous answer is context');
  assert.match(repaired.prompt, /^Do the thing\.\n\n@repair malformed_air \(NO_BLOCK\)/);
  assert.equal((f.store as unknown as { chainTail(id: string): string }).chainTail(original.id), repair.id);
  // The repair itself is never repaired, and the root is never repaired twice.
  f.finish(repair.id, { status: 'completed', result: BAD_AIR });
  assert.equal(f.repairs().length, 1);
  assert.equal(f.job(repair.id).options.repair, undefined);
});

test('valid answers, text jobs, uncertain outcomes, timeouts and cancellations never trigger a repair', t => {
  const f = fixture(t);
  f.finish(f.submit().id, { status: 'completed', result: GOOD_AIR });
  f.finish(f.submit({ protocol: 'text' }).id, { status: 'completed', result: BAD_AIR });
  f.finish(f.submit().id, { status: 'needs_review', error: 'SERVICE_STOPPED_DURING_JOB' });
  f.finish(f.submit().id, { status: 'failed', error: 'TIMEOUT' });
  f.finish(f.submit().id, { status: 'cancelled', error: 'CANCELLED' });
  f.finish(f.submit({ route: 'openai-api', cost: 'paid', max_cost_usd: '0.5', purpose: 'p', deliverable: 'd', protocol: 'text' }).id,
    { status: 'needs_review', error: 'HELPER_OUTCOME_UNCLEAR: helper status unknown' });
  assert.equal(f.repairs().length, 0);
});

test('edit jobs, repair=off and the effort ceiling are refused visibly', t => {
  const f = fixture(t);
  const edit = f.submit({ mode: 'edit', intent: 'edit' });
  f.finish(edit.id, { status: 'completed', result: BAD_AIR });
  assert.deepEqual(f.job(edit.id).options.repair, { trigger: 'malformed_air', refused: 'EDIT_JOB' });
  const off = f.submit({ repair: 'off' });
  f.finish(off.id, { status: 'completed', result: BAD_AIR });
  assert.equal(f.job(off.id).options.repair.refused, 'REPAIR_OFF');
  const top = f.submit({ intent: 'deep', eff: 'max' });
  f.finish(top.id, { status: 'completed', result: BAD_AIR });
  assert.equal(f.job(top.id).options.repair.refused, 'AT_CEILING');
  assert.equal(f.repairs().length, 0);
  assert.throws(() => f.submit({ repair: 'sometimes' }), /repair must be auto or off/);
});

test('at the top effort the correction is one capability step', t => {
  const f = fixture(t);
  const original = f.submit({ eff: 'max' });
  f.finish(original.id, { status: 'completed', result: BAD_AIR });
  const [repair] = f.repairs();
  assert.equal(repair.req_intent, 'deep');
  assert.equal(repair.req_eff, 'max');
  assert.equal(f.job(original.id).options.repair.correction, 'capability');
});

test('a truncated API answer gets more output room with the same model and effort, within what is left of the ceiling', t => {
  const f = fixture(t);
  const paid = { route: 'openai-api', cost: 'paid', max_cost_usd: '0.5', purpose: 'p', deliverable: 'd', protocol: 'text', max_output_tokens: 4000 };
  const original = f.submit(paid);
  f.finish(original.id, { status: 'failed', error: 'HELPER_INCOMPLETE: max_output_tokens', helper_job_id: 'h1', cost_usd: '0.12' });
  const [repair] = f.repairs();
  const repaired = f.job(repair.id), before = f.job(original.id);
  assert.equal(repaired.options.max_output_tokens, 8000);
  assert.equal(repaired.options.max_cost_usd, '0.38', 'only the rest of the caller ceiling, never more');
  assert.equal(repaired.model, before.model);
  assert.equal(repaired.effort, before.effort);
  assert.equal(repaired.options.ctx, undefined, 'an incomplete answer has no output to pass on');
  assert.match(repaired.prompt, /@repair truncated/);
  const maxed = f.submit({ ...paid, max_output_tokens: 65536 });
  f.finish(maxed.id, { status: 'failed', error: 'HELPER_INCOMPLETE: max_output_tokens', cost_usd: '0.1' });
  assert.equal(f.job(maxed.id).options.repair.refused, 'OUTPUT_AT_MAX');
  const unknown = f.submit(paid);
  f.finish(unknown.id, { status: 'failed', error: 'HELPER_INCOMPLETE: max_output_tokens' });
  assert.equal(f.job(unknown.id).options.repair.refused, 'UNKNOWN_SPEND');
  const spent = f.submit(paid);
  f.finish(spent.id, { status: 'failed', error: 'HELPER_INCOMPLETE: max_output_tokens', cost_usd: '0.495' });
  assert.equal(f.job(spent.id).options.repair.refused, 'BUDGET_SPENT');
  // Only the explicit output-limit reason qualifies.
  for (const error of ['HELPER_INCOMPLETE: content_filter', 'HELPER_INCOMPLETE: see helper job']) {
    const other = f.submit(paid);
    f.finish(other.id, { status: 'failed', error, cost_usd: '0.1' });
    assert.equal(f.job(other.id).options.repair, undefined);
  }
  assert.equal(f.repairs().length, 1);
});

test('a failure while linking the repair leaves no unlinked repair behind', t => {
  const f = fixture(t);
  const store = f.store as unknown as { mergeJobOptions(id: string, patch: Json): void };
  const merge = store.mergeJobOptions.bind(f.store);
  let fail = true;
  store.mergeJobOptions = (id, patch) => {
    if (patch.next && fail) { fail = false; throw new Error('disk full'); }
    merge(id, patch);
  };
  const original = f.submit();
  const logged: string[] = [], log = console.error;
  console.error = value => { logged.push(String(value)); };
  try { f.finish(original.id, { status: 'completed', result: BAD_AIR }); } finally { console.error = log; }
  assert.equal(f.repairs().length, 0, 'the inserted repair was rolled back with the failed link');
  assert.equal(f.job(original.id).status, 'completed');
  assert.ok(logged.some(line => line.includes('store.repair_failed')));
});

test('a v19 database with jobs migrates additively to the current schema', t => {
  const f = fixture(t);
  const kept = f.submit();
  const db = f.store.db;
  db.exec('DROP INDEX jobs_repair_of; ALTER TABLE jobs DROP COLUMN repair_of; PRAGMA user_version = 19;');
  f.store.close();
  const reopened = new Store(f.home);
  assert.equal(Number((reopened.db.prepare('PRAGMA user_version').get() as Json).user_version), SCHEMA_VERSION);
  assert.equal((reopened.db.prepare('SELECT repair_of FROM jobs WHERE id=?').get(kept.id) as Json).repair_of, null);
  assert.ok(reopened.db.prepare("SELECT 1 FROM sqlite_master WHERE name='jobs_repair_of'").get());
  reopened.close();
});

test('patch proposals are dry-run checked in the job workspace; unparseable or unapplicable ones get a repair', t => {
  const f = fixture(t);
  const good = f.submit({ protocol: 'patch' });
  f.finish(good.id, { status: 'completed', result: '<<<EDIT a.txt\n<<<OLD\nbeta\n>>>NEW\ngamma\n>>>END\n@air1\n#0 chk "edit" verdict=chg' });
  assert.deepEqual(f.job(good.id).options.patch_check, { applied: 1, rejected: 0 });
  assert.equal(fs.readFileSync(path.join(f.repo, 'a.txt'), 'utf8'), 'alpha\nbeta\n', 'a dry run writes nothing');
  assert.equal(f.repairs().length, 0);

  const stale = f.submit({ protocol: 'patch' });
  f.finish(stale.id, { status: 'completed', result: '<<<EDIT a.txt\n<<<OLD\ndelta\n>>>NEW\ngamma\n>>>END\n@air1\n#0 chk "edit" verdict=chg' });
  const checked = f.job(stale.id).options;
  assert.equal(checked.patch_check.rejected, 1);
  const [repair] = f.repairs();
  assert.equal(f.job(repair.id).options.repair_trigger, 'patch_unapplicable');
  assert.ok(f.job(repair.id).options.ctx.includes(`art:${f.store.handleOf('a', checked.patch_check.repair_ctx)}`));

  const broken = f.submit({ protocol: 'patch' });
  f.finish(broken.id, { status: 'completed', result: '<<<EDIT a.txt\n>>>END\n@air1\n#0 chk "edit" verdict=chg' });
  assert.match(f.job(broken.id).options.patch_error, /Malformed patch/);
  assert.equal(f.job(f.job(broken.id).options.repair.job).options.repair_trigger, 'patch_invalid');
});

test('a yield continuation is repaired against its root, once', t => {
  const f = fixture(t);
  const root = f.submit();
  const continuation = f.store.op_job_submit({ id: 'agent-commons', name: 'agent-commons', role: 'participant' },
    { project_id: 'p1', route: 'claude', prompt: 'Do the thing.\n\n@consult answered', protocol: 'air', intent: 'code', eff: 'med' },
    { trigger: 'resume', parentJobId: root.id }).job;
  f.finish(continuation.id, { status: 'completed', result: BAD_AIR });
  const [repair] = f.repairs();
  assert.equal(repair.repair_of, root.id);
  f.finish(root.id, { status: 'completed', result: BAD_AIR });
  assert.equal(f.job(root.id).options.repair.refused, 'ALREADY_REPAIRED');
  assert.equal(f.repairs().length, 1);
});

test('planning is pure and needs explicit evidence', () => {
  assert.equal(repairTrigger({ status: 'completed', mode: 'advice', route: 'claude', options: { proto: 'air', air: { ok: true } } }), null);
  assert.equal(repairTrigger({ status: 'failed', mode: 'advice', route: 'openai-api', error: 'HELPER_FAILED: x' }), null);
  assert.deepEqual(planCorrection({ kind: 'malformed_air', detail: '' }, { status: 'completed', mode: 'advice', route: 'x', req_intent: 'review', req_eff: 'low' }),
    { kind: 'effort', intent: 'review', eff: 'med' });
  assert.deepEqual(planCorrection({ kind: 'truncated', detail: '' }, { status: 'failed', mode: 'advice', route: 'x', options: {} }), { refused: 'NO_OUTPUT_LIMIT' });
});

test('repair=off on the root also covers its yield continuations', t => {
  const f = fixture(t);
  const root = f.submit({ repair: 'off' });
  const continuation = f.store.op_job_submit({ id: 'agent-commons', name: 'agent-commons', role: 'participant' },
    { project_id: 'p1', route: 'claude', prompt: 'Do the thing.\n\n@consult answered', protocol: 'air', intent: 'code', eff: 'med' },
    { trigger: 'resume', parentJobId: root.id }).job;
  f.finish(continuation.id, { status: 'completed', result: BAD_AIR });
  assert.equal(f.job(continuation.id).options.repair.refused, 'REPAIR_OFF');
  assert.equal(f.repairs().length, 0);
});
