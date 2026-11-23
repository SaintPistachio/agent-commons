// Phase 5d: presence and ask wake=auto. AIR calls record when each app was last seen. An ask with wake=auto to an app
// not seen in the last 2 minutes queues one read-only advice job on that app's own adapter (subscription or local
// only); its answer is posted on the thread as the app's reply, marked "via jN". wake=force wakes even an online app.
// Default (wake=none) changes nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, type Actor } from './fixtures/service.ts';
import { adapter } from '../src/adapters/registry.ts';

function fixture(t: any) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-p5d-'));
  const home = path.join(base, 'home'), repo = path.join(base, 'repo'); fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'spec.md'), 'the spec\n');
  const store = new Store(home);
  t.after(() => { try { store.close(); } catch {} fs.rmSync(base, { recursive: true, force: true }); });
  const claude: Actor = store.createActor('claude-desktop', 'participant', 'claude-desktop').actor;
  const codex: Actor = store.createActor('codex-desktop', 'participant', 'codex-desktop').actor;
  const plain: Actor = store.createActor('plain-app', 'participant', 'plain-app').actor;
  store.setActorTags('claude-desktop', 'anthropic', 'claude'); store.setActorTags('codex-desktop', 'openai', 'codex');
  for (const id of ['claude', 'codex', 'openai-api', 'antigravity']) store.recordProbe(adapter(id)!.capabilities, { state: 'verified' });
  const call = (actor: Actor, method: string, input: Record<string, unknown> = {}) => store.call(actor, method, input);
  call(claude, 'project_create', { name: 'Repo', root: repo, operation_id: randomUUID() });
  const tx = (actor: Actor, packet: string) => call(actor, 'air_tx', { project_id: 'p1', packet, operation_id: randomUUID() });
  const seen = (id: string) => store.db.prepare('SELECT * FROM actor_presence WHERE actor_id=?').get(id) as any;
  const ago = (id: string, minutes: number) => store.db.prepare('UPDATE actor_presence SET last_seen_at=? WHERE actor_id=?').run(new Date(Date.now() - minutes * 60000).toISOString(), id);
  const wakeJob = (reply: string) => store.jobByRef(/wake=[^ \n]*codex-desktop:(j\d+)/.exec(reply)![1]);
  const inbox = (actor: Actor) => call(actor, 'team_inbox', { project_id: 'p1' }).messages as any[];
  return { store, claude, codex, plain, call, tx, seen, ago, wakeJob, inbox };
}

test('AIR calls record presence: when, which project, family and adapter', t => {
  const f = fixture(t);
  assert.equal(f.seen('codex-desktop'), undefined);
  f.call(f.codex, 'air_sync', { project_id: 'p1' });
  const row = f.seen('codex-desktop');
  assert.ok(Date.now() - Date.parse(row.last_seen_at) < 5000);
  assert.deepEqual([row.family, row.adapter_id, row.last_project_id], ['openai', 'codex', f.store.db.prepare('SELECT id FROM projects').get()!.id]);
  f.call(f.claude, 'project_status', { project_id: 'p1' });
  assert.equal(f.seen('claude-desktop'), undefined, 'JSON reads do not count');
  f.tx(f.claude, '@air1\n#0 dec "x"');
  assert.ok(f.seen('claude-desktop'), 'air_tx counts');
});

test('ask wake=auto to an offline app queues one advice job on its adapter, with the task and named files as context', t => {
  const f = fixture(t);
  f.call(f.codex, 'air_sync', { project_id: 'p1' }); f.ago('codex-desktop', 5);
  const task = f.tx(f.claude, '@air1\n#0 tnew "Cache"').handles['0'].split('@')[0];
  const r = f.tx(f.claude, `@air1\n#0 ask to=codex-desktop t=${task} ev=file:spec.md,c1 wake=auto "Does the spec cover eviction?"`);
  assert.match(r.air, /^@air1 ok op=\S+ seq=\d+ unseen=\d+ inbox=\d+ wake=codex-desktop:j\d+\n#0=m\d+$/);
  const job = f.wakeJob(r.air);
  assert.deepEqual([job.route, job.mode, job.trigger, job.wake_depth, job.created_by, job.options.proto, job.options.wake_for, job.options.asked_by],
    ['codex', 'advice', 'wake', 1, 'agent-commons', 'air', 'codex-desktop', 'claude-desktop']);
  assert.deepEqual(job.options.ctx, [`task:${task}`, 'file:spec.md'], 'only evidence that names context is resolved');
  assert.match(job.prompt, /^claude-desktop asked codex-desktop \(you are answering for codex-desktop, which is offline\):\nDoes the spec cover eviction\?/);
  assert.equal(f.inbox(f.codex).some(m => m.body === 'Does the spec cover eviction?'), true, 'the question still waits in the app\'s own inbox');
});

test('online apps, the default, and unsuitable recipients are not woken', t => {
  const f = fixture(t);
  f.call(f.codex, 'air_sync', { project_id: 'p1' });
  assert.match(f.tx(f.claude, '@air1\n#0 ask to=codex-desktop wake=auto "online?"').air, / wake=codex-desktop:online\n/);
  assert.match(f.tx(f.claude, '@air1\n#0 ask to=codex-desktop wake=force "anyway"').air, / wake=codex-desktop:j\d+\n/, 'force wakes an online app');
  assert.doesNotMatch(f.tx(f.claude, '@air1\n#0 ask to=codex-desktop "no wake"').air, /wake=/);
  assert.match(f.tx(f.claude, '@air1\n#0 ask to=plain-app wake=auto "who?"').air, / wake=plain-app:no_adapter\n/);
  f.store.setActorTags('plain-app', 'openai', 'openai-api');
  assert.match(f.tx(f.claude, '@air1\n#0 ask to=plain-app wake=auto "paid?"').air, / wake=plain-app:paid\n/);
  f.ago('codex-desktop', 5);
  f.store.setCooldown('codex', '2100-01-01T00:00:00.000Z', 'limit');
  assert.match(f.tx(f.claude, '@air1\n#0 ask to=codex-desktop wake=auto "cooling?"').air, / wake=codex-desktop:cooldown\n/);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM jobs WHERE trigger='wake'").get()!.n, 1, 'only the forced wake ran');
  assert.throws(() => f.tx(f.claude, '@air1\n#0 ask to=codex-desktop wake=always "x"'), /wake must be none, auto or force/);
});

test('a finished wake job answers on the thread as the app, marked via jN; a failed one tells the asker', t => {
  const f = fixture(t);
  const r = f.tx(f.claude, '@air1\n#0 ask to=codex-desktop wake=auto "Ship it?"');
  const question = f.store.db.prepare("SELECT id FROM messages WHERE body='Ship it?'").get()!.id;
  const job = f.wakeJob(r.air);
  f.store.updateJob(job.id, { status: 'completed', result: 'Yes, after the tests pass.\n@air1\n#0 chk verdict=ok p=.85 "ship after tests"', finished_at: new Date().toISOString() });
  const reply = f.inbox(f.claude).find(m => m.reply_to === question);
  const jh = f.store.handleOf('j', job.id);
  assert.deepEqual([reply.sender_id, reply.type, reply.body, reply.confidence, reply.evidence], ['codex-desktop', 'reply', `via ${jh}: Yes, after the tests pass.`, 0.85, [jh]]);
  f.store.updateJob(job.id, { status: 'completed', finished_at: new Date().toISOString() });
  assert.equal(f.inbox(f.claude).filter(m => m.reply_to === question).length, 1, 'answered once');
  const failed = f.wakeJob(f.tx(f.claude, '@air1\n#0 ask to=codex-desktop wake=auto "Again?"').air);
  f.store.updateJob(failed.id, { status: 'failed', error: 'QUOTA_EXHAUSTED: limit', finished_at: new Date().toISOString() });
  assert.match(f.inbox(f.claude).at(-1).body, new RegExp(`^wake ${f.store.handleOf('j', failed.id)} for codex-desktop did not finish \\(failed\\): QUOTA_EXHAUSTED`));
});

test('wakes count toward a task\'s consults, and taskless wakes are limited per asker per hour', t => {
  const f = fixture(t);
  const task = f.tx(f.claude, '@air1\n#0 tnew "Busy"').handles['0'].split('@')[0];
  for (let i = 0; i < 5; i++) assert.match(f.tx(f.claude, `@air1\n#0 ask to=codex-desktop t=${task} wake=force "q${i}"`).air, /codex-desktop:j\d+/);
  assert.match(f.tx(f.claude, `@air1\n#0 ask to=codex-desktop t=${task} wake=force "q6"`).air, /wake=codex-desktop:MAX_CONSULTS/);
  for (let i = 0; i < 5; i++) f.tx(f.claude, `@air1\n#0 ask to=codex-desktop wake=force "free ${i}"`);
  assert.match(f.tx(f.claude, '@air1\n#0 ask to=codex-desktop wake=force "eleventh"').air, /wake=codex-desktop:RATE/, '10 wakes per asker per hour');
});
