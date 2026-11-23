// Phase 5b: working rooms. ropen turns a discussion into a room with seats (route, effort, role) and a round limit;
// rstep runs one bounded round of read-only seat jobs; seat replies are posted into the room; the room converges when
// every seat's latest verdict is ok, or is capped at its round limit. No new MCP tools: two AIR-T opcodes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, CommonsError, type Actor } from '../src/store.ts';
import { adapter } from '../src/adapters/registry.ts';
import { SCHEMA_VERSION } from '../src/schema.ts';

function fixture(t: any) {
  // The repo sits beside the home, not inside it: nothing under the Agent Commons home is ever sent as context.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-p5b-'));
  const home = path.join(base, 'home'), repo = path.join(base, 'repo'); fs.mkdirSync(repo);
  const store = new Store(home);
  t.after(() => { try { store.close(); } catch {} fs.rmSync(base, { recursive: true, force: true }); });
  const claude: Actor = store.createActor('claude-desktop', 'participant', 'claude-desktop').actor;
  store.setActorTags('claude-desktop', 'anthropic', 'claude');
  for (const id of ['claude', 'codex', 'openai-api', 'antigravity']) store.recordProbe(adapter(id)!.capabilities, { state: 'verified' });
  const call = (method: string, input: Record<string, unknown> = {}) => store.call(claude, method, input);
  call('project_create', { name: 'Repo', root: repo, operation_id: randomUUID() });
  const tx = (packet: string) => call('air_tx', { project_id: 'p1', packet, operation_id: randomUUID() });
  const code = (packet: string) => { try { tx(packet); } catch (error) { return (error as CommonsError).code; } throw new Error('expected a failure'); };
  const task = tx('@air1\n#0 tnew "Probe quarantine policy"').handles['0'].split('@')[0];
  const open = (extra = '') => tx(`@air1\n#0 ropen subj="drift policy" t=${task} seats=ag:high:arch,codex:med:critic ${extra} "agree on quarantine after a CLI self-update"`).handles['0'] as string;
  const step = (room: string, extra = '') => tx(`@air1\n#0 rstep g=${room} ${extra} "independent review"`);
  const jobsOf = (reply: string) => /\(([^)]*)\)/.exec(reply)![1].split(/[,;]/).filter(s => /^j\d+$/.test(s));
  const finish = (job: string, verdict: string | null, status = 'completed') => store.updateJob(store.jobByRef(job).id,
    { status, ...(verdict ? { result: `My view on the policy.\n@air1\n#0 chk verdict=${verdict} p=.7 "${verdict} from this seat"` } : { error: 'CLI_ERROR: crashed' }), finished_at: new Date().toISOString() });
  const room = (handle: string) => store.db.prepare('SELECT * FROM discussions WHERE seq=?').get(Number(handle.slice(1))) as any;
  const inbox = () => call('team_inbox', { project_id: 'p1' }).messages as any[];
  return { store, claude, call, tx, code, task, open, step, jobsOf, finish, room, inbox };
}

test('schema 9 adds room fields to discussions and room links to jobs', t => {
  const f = fixture(t);
  assert.ok(SCHEMA_VERSION >= 9);
  const columns = (table: string) => (f.store.db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map(c => c.name);
  for (const c of ['room_mode', 'seats', 'max_rounds', 'round', 'room_status']) assert.ok(columns('discussions').includes(c), c);
  for (const c of ['room_id', 'room_round']) assert.ok(columns('jobs').includes(c), c);
});

test('ropen opens a room with seats and a round limit, and checks them', t => {
  const f = fixture(t);
  const g = f.open('mode=directed max_r=2');
  const row = f.room(g);
  assert.deepEqual([row.room_mode, row.max_rounds, row.round, row.room_status], ['directed', 2, 0, 'idle']);
  assert.deepEqual(JSON.parse(row.seats), [{ seat: 'arch', route: 'antigravity', eff: 'high', role: 'arch' }, { seat: 'critic', route: 'codex', eff: 'med', role: 'critic' }]);
  assert.match(f.call('air_get', { handles: g }).air, new RegExp(`^G ${g} t=t\\d+ own=claude-desktop st=open room=directed r=0/2 rst=idle seats=arch:ag,critic:codex`, 'm'));
  const bad = (seats: string, extra = '') => f.code(`@air1\n#0 ropen subj=x seats=${seats} ${extra} "q"`);
  assert.equal(bad('codex'), 'ROOM_SEATS', 'at least two seats');
  assert.equal(bad('claude,codex,ag,claude::b,codex::c'), 'ROOM_SEATS', 'at most four');
  assert.equal(bad('nowhere,codex'), 'ROUTE_UNAVAILABLE');
  assert.equal(bad('api,codex'), 'ROOM_SEAT_PAID', 'subscription seats only');
  assert.equal(bad('codex,codex'), 'ROOM_SEATS', 'seat names must differ');
  assert.equal(bad('codex::a,claude::b', 'max_r=6'), 'INVALID_INPUT');
  assert.equal(bad('codex::a,claude::b', 'mode=chaos'), 'INVALID_INPUT');
  assert.equal(bad('codex:extreme:a,claude::b'), 'INVALID_INPUT', 'eff is min low med high max');
});

test('a parallel round wakes every seat with the question, the transcript and the task as context', t => {
  const f = fixture(t);
  const g = f.open();
  fs.writeFileSync(path.join(f.store.home, '..', 'repo', 'policy.md'), 'quarantine draft\n');
  const r1 = f.step(g, 'ctx=file:policy.md').handles['0'];
  assert.match(r1, new RegExp(`^${g}@r1\\(j\\d+,j\\d+\\)$`));
  const [ag, codex] = f.jobsOf(r1).map(h => f.store.jobByRef(h));
  assert.deepEqual([ag.route, codex.route], ['antigravity', 'codex']);
  for (const [job, seat, eff] of [[ag, 'arch', 'high'], [codex, 'critic', 'med']] as const) {
    assert.deepEqual([job.mode, job.trigger, job.wake_depth, job.room_round, job.req_intent, job.req_eff, job.options.proto, job.options.seat, job.created_by],
      ['advice', 'room', 1, 1, 'review', eff, 'air', seat, 'claude-desktop']);
    assert.equal(job.room_id, f.room(g).id);
    assert.deepEqual(job.options.ctx, [`task:${f.task}`, 'file:policy.md']);
    assert.match(job.prompt, new RegExp(`Working room ${g} "drift policy", round 1 of 3\\. You are seat "${seat}"`));
    assert.match(job.prompt, /Question: agree on quarantine after a CLI self-update/);
    assert.match(job.prompt, /This round: independent review/);
  }
  assert.equal(f.room(g).room_status, 'running');
  assert.equal(f.code(`@air1\n#0 rstep g=${g} "too soon"`), 'ROOM_BUSY', 'one round at a time');
});

test('seat replies are posted; a split round leaves the room idle; a directed round wakes only the dissenting seat; agreement converges', t => {
  const f = fixture(t);
  const g = f.open('mode=directed max_r=3');
  const [agJob, codexJob] = f.jobsOf(f.step(g).handles['0']);
  f.finish(agJob, 'ok');
  assert.equal(f.room(g).room_status, 'running', 'one seat still working');
  f.finish(codexJob, 'chg');
  const posts = f.call('discussion_read', { discussion_id: g }).messages.filter((m: any) => m.type === 'post');
  assert.deepEqual(posts.map((m: any) => [m.sender_id, m.confidence]), [['seat:arch', 0.7], ['seat:critic', 0.7]]);
  assert.match(posts[1].body, /^r1 critic verdict=chg p=0\.7: chg from this seat\nMy view on the policy\.$/);
  assert.equal(f.room(g).room_status, 'idle');
  assert.match(f.inbox().at(-1).body, new RegExp(`^room ${g} round 1/3 done: ok 1 chg 1 blk 0 unfinished 0; next: rstep g=${g}`));
  const r2 = f.step(g).handles['0'];
  const woken = f.jobsOf(r2);
  assert.equal(woken.length, 1, 'directed: only the seat that asked for changes');
  const critic = f.store.jobByRef(woken[0]);
  assert.equal(critic.options.seat, 'critic');
  assert.match(critic.prompt, /Transcript so far:\n[\s\S]*\[seat:arch\] r1 arch verdict=ok[\s\S]*\[seat:critic\] r1 critic verdict=chg/);
  f.finish(woken[0], 'ok');
  assert.equal(f.room(g).room_status, 'converged', 'every seat\'s latest verdict is ok');
  assert.match(f.inbox().at(-1).body, new RegExp(`^room ${g} round 2/3 done: ok 1 chg 0 blk 0 unfinished 0; converged`));
  assert.equal(f.code(`@air1\n#0 rstep g=${g} "again"`), 'ROOM_CONVERGED');
});

test('the round limit caps a room; an explicit to= picks seats; failed seats and unavailable routes are not agreement', t => {
  const f = fixture(t);
  const g = f.open('max_r=1');
  for (const job of f.jobsOf(f.step(g).handles['0'])) f.finish(job, 'ok');
  assert.equal(f.room(g).room_status, 'converged');
  const h = f.open('max_r=2 mode=directed');
  const [a, c] = f.jobsOf(f.step(h).handles['0']);
  f.finish(a, null, 'failed'); f.finish(c, 'ok');
  assert.ok(f.call('discussion_read', { discussion_id: h }).messages.some((m: any) => m.body === 'r1 arch did not finish (failed): CLI_ERROR: crashed'), 'the failed seat says so');
  assert.equal(f.room(h).room_status, 'idle', 'a failed seat is not agreement');
  const r2 = f.step(h, 'to=critic').handles['0'];
  assert.equal(f.store.jobByRef(f.jobsOf(r2)[0]).options.seat, 'critic', 'to= wins over the dissent rule');
  f.finish(f.jobsOf(r2)[0], 'ok');
  assert.equal(f.room(h).room_status, 'capped', 'round 2 of 2 without every seat ok');
  assert.match(f.inbox().at(-1).body, /round 2\/2 done: .*; capped/);
  assert.equal(f.code(`@air1\n#0 rstep g=${h} "third"`), 'ROOM_MAX_ROUNDS');
  // A seat whose route is cooling is skipped (not queued) and named in the reply.
  const k = f.open();
  f.store.setCooldown('antigravity', '2100-01-01T00:00:00.000Z', 'limit');
  const r = f.step(k).handles['0'];
  assert.match(r, /\(j\d+;arch:cooldown\)$/); assert.equal(f.jobsOf(r).length, 1);
  assert.equal(f.code(`@air1\n#0 rstep g=${f.open()} to=nobody "x"`), 'ROOM_SEATS');
});

test('room jobs do not use up the per-task consult cap, and a plain discussion is not a room', t => {
  const f = fixture(t);
  const g = f.open('max_r=5');
  for (let round = 0; round < 3; round++) for (const job of f.jobsOf(f.step(g).handles['0'])) f.finish(job, 'chg');
  f.tx(`@air1\n#0 tclm t=${f.task} v=1\n#1 tupd t=${f.task} v=2 rev_pol=cross\n#2 tupd t=${f.task} v=3 st=rev`);
  assert.equal(Number((f.store.db.prepare("SELECT count(*) n FROM jobs WHERE trigger='auto_review'").get() as any).n), 1, '6 room jobs did not count');
  const plain = f.tx('@air1\n#0 dopen subj=plain "just talk"').handles['0'];
  assert.equal(f.code(`@air1\n#0 rstep g=${plain} "x"`), 'NOT_A_ROOM');
});
