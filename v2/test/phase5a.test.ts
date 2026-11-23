// Phase 5a: consult triggers. Opt-in cross-family review when a task moves to review, the two-strike consult hint on
// air_tx, consult caps, verdicts recorded on jobs and reported back, and cli.ts stats.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, type Actor } from '../src/store.ts';
import { adapter } from '../src/adapters/registry.ts';
import { SCHEMA_VERSION } from '../src/schema.ts';
import { consultStats } from '../src/ops.ts';

function fixture(t: any, verified = ['claude', 'codex', 'openai-api', 'antigravity']) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-p5a-'));
  const repo = path.join(home, 'repo'); fs.mkdirSync(repo);
  const store = new Store(home);
  t.after(() => { try { store.close(); } catch {} fs.rmSync(home, { recursive: true, force: true }); });
  const claude: Actor = store.createActor('claude-desktop', 'participant', 'claude-desktop').actor;
  store.setActorTags('claude-desktop', 'anthropic', 'claude');
  for (const id of verified) store.recordProbe(adapter(id)!.capabilities, { state: 'verified' });
  const call = (method: string, input: Record<string, unknown> = {}) => store.call(claude, method, input);
  call('project_create', { name: 'Repo', root: repo, operation_id: randomUUID() });
  const tx = (packet: string) => call('air_tx', { project_id: 'p1', packet, operation_id: randomUUID() });
  const job = (handle: string) => store.jobByRef(handle);
  const inbox = () => call('team_inbox', { project_id: 'p1' }).messages as any[];
  return { home, store, claude, call, tx, job, inbox };
}
const verdictAnswer = (verdict: string) => `Looked.\n@air1\n#0 chk verdict=${verdict} p=.8 "needs a guard"`;

test('schema 8 adds review policy, failed checkpoints and consult columns on jobs', t => {
  const f = fixture(t);
  assert.ok(SCHEMA_VERSION >= 8);
  const columns = (table: string) => (f.store.db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map(c => c.name);
  assert.ok(columns('tasks').includes('review_policy')); assert.ok(columns('checkpoints').includes('failed'));
  for (const c of ['parent_job_id', 'wake_depth', 'consult_verdict', 'trigger']) assert.ok(columns('jobs').includes(c), c);
});

test('moving a cross-review task to rev queues one review on another model family, with the task and its diff as context', t => {
  const f = fixture(t);
  const r = f.tx('@air1\n#0 tnew rev_pol=cross "Add the guard"\n#1 tclm t=#0 v=1');
  const task = r.handles['0'].split('@')[0];
  assert.match(f.call('air_get', { handles: task }).air, / pol=cross /, 'the policy shows on the task line');
  // An earlier edit job on the task left a diff: the reviewer gets it too.
  const edit = f.call('job_submit', { project_id: 'p1', task_id: task, mode: 'edit', prompt: 'edit', operation_id: randomUUID() }).job;
  f.store.attachDiff(edit.id, 'diff --git a/x b/x\n+guard\n', '+1 -0 (1f)');
  const moved = f.tx(`@air1\n#0 tupd t=${task} v=2 st=rev`);
  const review = /review=(j\d+)/.exec(moved.air)![1];
  assert.match(moved.air, /^@air1 ok op=\S+ seq=\d+ unseen=\d+ inbox=\d+ review=j\d+\n#0=t\d+@v3$/);
  const job = f.job(review);
  assert.equal(job.route, 'codex', 'claude-desktop is anthropic: the idle openai route first in registry order');
  assert.deepEqual([job.mode, job.created_by, job.wake_depth, job.trigger, job.req_intent, job.req_eff, job.options.proto, job.task_id],
    ['advice', 'agent-commons', 1, 'auto_review', 'review', 'high', 'air', f.store.jobByRef(review).task_id]);
  assert.deepEqual(job.options.ctx, [`task:${task}`, `art:${f.store.handleOf('a', f.store.jobByRef(edit.id).options.diff_artifact)}`]);
  assert.equal(job.options.review_for, 'claude-desktop');
  // A task without the policy gets nothing.
  const plain = f.tx('@air1\n#0 tnew "No policy"\n#1 tclm t=#0 v=1').handles['0'].split('@')[0];
  assert.doesNotMatch(f.tx(`@air1\n#0 tupd t=${plain} v=2 st=rev`).air, /review=/);
});

test('the review cap, a missing route and paid routes never block the move itself', t => {
  const f = fixture(t);
  const task = f.tx('@air1\n#0 tnew rev_pol=cross "Loop"\n#1 tclm t=#0 v=1').handles['0'].split('@')[0];
  let v = 2;
  for (let i = 0; i < 5; i++) {
    assert.match(f.tx(`@air1\n#0 tupd t=${task} v=${v++} st=rev`).air, /review=j\d+/, `review ${i + 1}`);
    f.tx(`@air1\n#0 tupd t=${task} v=${v++} st=wip`);
  }
  const capped = f.tx(`@air1\n#0 tupd t=${task} v=${v++} st=rev`);
  assert.match(capped.air, /review=skip:MAX_CONSULTS/); assert.match(capped.air, /#0=t\d+@v13/, 'the task still moved');
  const g = fixture(t, ['claude']);  // only the caller's own family is available: no cross-family reviewer
  const lone = g.tx('@air1\n#0 tnew rev_pol=cross "Alone"\n#1 tclm t=#0 v=1').handles['0'].split('@')[0];
  const skipped = g.tx(`@air1\n#0 tupd t=${lone} v=2 st=rev`);
  assert.match(skipped.air, /review=skip:NO_CROSS_FAMILY/);
  assert.match(g.inbox().at(-1).body, /^review skipped for t\d+: NO_CROSS_FAMILY/, 'the mover is told');
  assert.equal(Number((g.store.db.prepare("SELECT count(*) n FROM jobs WHERE route='openai-api'").get() as any).n), 0, 'never the paid route');
});

test('a finished review reports its verdict to the mover once, and every proto=air job records consult_verdict', t => {
  const f = fixture(t);
  const task = f.tx('@air1\n#0 tnew rev_pol=cross "Report"\n#1 tclm t=#0 v=1').handles['0'].split('@')[0];
  const review = /review=(j\d+)/.exec(f.tx(`@air1\n#0 tupd t=${task} v=2 st=rev`).air)![1];
  const id = f.job(review).id;
  f.store.updateJob(id, { status: 'completed', result: verdictAnswer('chg'), finished_at: new Date().toISOString() });
  assert.equal(f.job(review).consult_verdict, 'chg');
  const note = f.inbox().at(-1);
  assert.deepEqual([note.sender_id, note.type, note.task_id === f.store.jobByRef(review).task_id, note.confidence], ['agent-commons', 'reply', true, 0.8]);
  assert.equal(note.body, `review ${review} verdict=chg p=0.8: needs a guard`);
  assert.ok(note.evidence.includes(review));
  f.store.updateJob(id, { status: 'completed', finished_at: new Date().toISOString() });
  assert.equal(f.inbox().filter((m: any) => m.sender_id === 'agent-commons').length, 1, 'reported once');
  // A review that does not finish says so instead of leaving the mover waiting.
  const again = /review=(j\d+)/.exec((f.tx(`@air1\n#0 tupd t=${task} v=3 st=wip`), f.tx(`@air1\n#0 tupd t=${task} v=4 st=rev`)).air)![1];
  f.store.updateJob(f.job(again).id, { status: 'failed', error: 'QUOTA_EXHAUSTED: weekly limit', finished_at: new Date().toISOString() });
  assert.match(f.inbox().at(-1).body, new RegExp(`^review ${again} did not finish \\(failed\\): QUOTA_EXHAUSTED`));
  assert.equal(f.job(again).consult_verdict, null);
  // Any proto=air job records its verdict, trigger or not.
  const plain = f.call('job_submit', { project_id: 'p1', protocol: 'air', prompt: 'x', operation_id: randomUUID() }).job;
  f.store.updateJob(plain.id, { status: 'completed', result: verdictAnswer('ok'), finished_at: new Date().toISOString() });
  assert.equal(f.store.jobByRef(plain.id).consult_verdict, 'ok');
});

test('two failed checkpoints in a row on the same task add hint=consult with idle peers of another family', t => {
  const f = fixture(t);
  const task = f.tx('@air1\n#0 tnew "Flaky"').handles['0'].split('@')[0];
  assert.doesNotMatch(f.tx(`@air1\n#0 chk t=${task} fail=1 "tests fail"`).air, /hint=/, 'one strike');
  assert.match(f.tx(`@air1\n#0 chk t=${task} fail=1 "still failing"`).air, / hint=consult:codex,ag(\n|$)/, 'two strikes');
  assert.doesNotMatch(f.tx(`@air1\n#0 chk t=${task} "green now"`).air, /hint=/, 'a pass clears the streak');
  assert.doesNotMatch(f.tx(`@air1\n#0 ref test:unit status=fail\n#1 chk t=${task} ok=#0 "red again"`).air, /hint=/, 'one strike after the pass');
  assert.match(f.tx(`@air1\n#0 ref test:unit status=fail\n#1 chk t=${task} ok=#0 "red"`).air, /hint=consult:/, 'a failed check counts like fail=1');
  // Project-level checkpoints keep their own streak.
  assert.doesNotMatch(f.tx('@air1\n#0 chk fail=1 "build broke"').air, /hint=/);
  f.call('project_checkpoint', { project_id: 'p1', summary: 'build still broken', failed: true, operation_id: randomUUID() });
  assert.equal((f.store.db.prepare('SELECT failed FROM checkpoints ORDER BY seq DESC').get() as any).failed, 1);
  assert.match(f.tx('@air1\n#0 chk fail=1 "third"').air, /hint=consult:codex,ag/);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM jobs').get()!.n, 0, 'a hint never starts a job');
});

test('cli stats: consult verdicts by trigger and route, and each route\'s reliability', t => {
  const f = fixture(t);
  const task = f.tx('@air1\n#0 tnew rev_pol=cross "Stats"\n#1 tclm t=#0 v=1').handles['0'].split('@')[0];
  const review = /review=(j\d+)/.exec(f.tx(`@air1\n#0 tupd t=${task} v=2 st=rev`).air)![1];
  f.store.updateJob(f.job(review).id, { status: 'completed', result: verdictAnswer('blk'), finished_at: new Date().toISOString() });
  const lines = consultStats(f.store).join('\n');
  assert.match(lines, /auto_review +codex +ok 0 +chg 0 +blk 1 +none 0 +unfinished 0/);
  assert.match(lines, /codex +completed 1 +failed 0 +needs_review 0 +cancelled 0/);
});
