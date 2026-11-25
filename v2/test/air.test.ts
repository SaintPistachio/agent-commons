import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, CommonsError, type Actor } from './fixtures/service.ts';
import { parsePacket } from '../src/air/parser.ts';
import { AirParseError } from '../src/air/types.ts';
import { toolReply, toolError } from '../src/mcp-reply.ts';
import { RemoteError } from '../src/client.ts';
import { SCHEMA_VERSION } from '../src/schema.ts';

function fixture(t: any) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-air-'));
  const home = path.join(workspace, 'data');
  const projectDirectory = path.join(workspace, 'repo');
  fs.mkdirSync(projectDirectory);
  let store = new Store(home);
  t.after(() => { try { store.close(); } catch {} fs.rmSync(workspace, { recursive: true, force: true }); });
  const claude = store.createActor('claude-desktop', 'participant', 'claude-desktop').actor;
  const codex = store.createActor('codex-desktop', 'participant', 'codex-desktop').actor;
  const ag = store.createActor('antigravity', 'participant', 'antigravity-desktop').actor;
  const op = () => randomUUID();
  const call = (actor: Actor, method: string, input: Record<string, unknown> = {}) => store.call(actor, method, input);
  const project = call(claude, 'project_create', { name: 'Demo', root: projectDirectory, operation_id: op() }).project;
  const tx = (actor: Actor, packet: string, extra: Record<string, unknown> = {}) => call(actor, 'air_tx', { project_id: project.id, packet, operation_id: op(), ...extra });
  const count = (table: string) => Number((store.db.prepare(`SELECT count(*) n FROM ${table}`).get() as any).n);
  return { home, projectDirectory, claude, codex, ag, op, call, tx, count, project, get store() { return store; }, reopen: () => { store.close(); store = new Store(home); return store; } };
}
const failure = (fn: () => unknown) => { try { fn(); } catch (error) { return error as CommonsError & AirParseError; } throw new Error('expected a failure'); };
const parseCode = (packet: string) => failure(() => parsePacket(packet)).code;

test('1. the parser rejects malformed packets before any database work', () => {
  assert.equal(parseCode('#0 ref x'), 'MISSING_HEADER');
  assert.equal(parseCode('@air1\n#1 ref x'), 'BAD_INDEX');
  assert.equal(parseCode('@air1\n#0 ref x\n#2 ref y'), 'BAD_INDEX');
  assert.equal(parseCode('@air1\n#0 ref x\n#1 dec ev=#2 "s"'), 'FORWARD_REF');
  assert.equal(parseCode('@air1\n#0 dec ev=#0 "s"'), 'FORWARD_REF');
  for (const p of ['0', '1', '-0.1', '1.2']) assert.equal(parseCode(`@air1\n#0 dec p=${p} "s"`), 'BAD_CONFIDENCE', p);
  assert.equal(parseCode('@air1\n#0 frob "s"'), 'UNKNOWN_OPCODE');
  assert.equal(parseCode('@air1\n#0 tupd t=t4 st=done'), 'MISSING_FIELD');
  assert.equal(parseCode('@air1\n#0 dec "s" bogus=1'), 'UNKNOWN_FIELD');
  assert.equal(parseCode('@air1\n#0 ref x\0'), 'NUL_BYTE');
  assert.equal(parseCode('@air1\n#0 dec "unterminated'), 'UNTERMINATED_STRING');
  const err = failure(() => parsePacket('@air1 p=p1\n#0 ref x\n\n#1 frob'));
  assert.equal(err.line, 4); assert.equal(err.node, 1);
  // The spec's worked example parses: ref URIs, quoted values with spaces, lists of references.
  const ok = parsePacket(`@air1 p=p1
#0 ref file:v2/src/mcp.ts:13-28
#1 ref test:v2/test/mcp.test.ts status=pass
#2 dec t=t4 p=.92 ev=#0,#1 "add opt-in air_tx and air_sync to mcp bridge" why="avoids native app config edits"
#3 tupd t=t4 v=3 st=awaiting_review next="codex review #0"
#4 chk t=t4 rev=a91f3c br=main ok=#1 q="keep json default?" next="merge after review" "implemented air_tx and air_sync"
#5 ask to=codex t=t4 ev=#0,#2 "verify backwards compatibility with existing v2 clients"`);
  assert.equal(ok.project, 'p1'); assert.equal(ok.nodes.length, 6);
  assert.deepEqual(ok.nodes[2].fields.ev, [{ ref: 0 }, { ref: 1 }]);
  assert.deepEqual(ok.nodes[3].fields.next, [{ text: 'codex review #0' }], 'a quoted #0 is text, not a reference');
});

test('2. one air_tx creates, claims, decides, checkpoints and asks, chaining earlier nodes', t => {
  const f = fixture(t);
  const r = f.tx(f.claude, `@air1
#0 tnew "AIR bridge" next="build it"
#1 ref file:v2/src/mcp.ts:13-28 status=pass
#2 tclm t=#0 v=1
#3 dec t=#0 ev=#1 p=.85 "use compact text replies" why="no duplicate payload"
#4 chk t=#0 ok=#1 q="keep json default?" "codec done"
#5 ask to=codex-desktop t=#0 ev=#1,#3 "verify compatibility"`);
  assert.match(r.air, /^@air1 ok op=\S+ seq=\d+ unseen=0 inbox=0\n#0=t\d+@v1 #2=t\d+@v2 #3=d\d+ #4=c\d+ #5=m\d+$/);
  const task = f.call(f.claude, 'task_read', { task_id: r.handles['0'].split('@')[0] }).task;
  assert.equal(task.owner, 'claude-desktop'); assert.equal(task.version, 2); assert.equal(task.title, 'AIR bridge');
  const decision = f.store.db.prepare('SELECT * FROM decisions').get() as any;
  assert.equal(decision.task_id, task.id); assert.equal(decision.confidence, 0.85);
  assert.deepEqual(JSON.parse(decision.evidence), ['file:v2/src/mcp.ts:13-28 [pass]']);
  const checkpoint = f.store.db.prepare('SELECT * FROM checkpoints').get() as any;
  assert.deepEqual(JSON.parse(checkpoint.checks), ['file:v2/src/mcp.ts:13-28 [pass]']);
  assert.deepEqual(JSON.parse(checkpoint.open_questions), ['keep json default?']);
  const message = f.store.db.prepare('SELECT * FROM messages').get() as any;
  assert.deepEqual(JSON.parse(message.recipients), ['codex-desktop']);
  assert.deepEqual(JSON.parse(message.evidence), ['file:v2/src/mcp.ts:13-28 [pass]', r.handles['3']]);
  // Actors resolve by ID first, then by unique name.
  const byName = f.tx(f.claude, `@air1\n#0 ask to=antigravity t=${r.handles['0'].split('@')[0]} "and you?"`);
  assert.match(byName.handles['0'], /^m\d+$/);
});

test('3. a failing node rolls back every earlier node and stores no operation', t => {
  const f = fixture(t);
  const task = f.call(f.claude, 'task_create', { project_id: f.project.id, title: 'Existing', operation_id: f.op() }).task;
  const handle = f.store.handleOf('t', task.id)!;
  const before = { tasks: f.count('tasks'), decisions: f.count('decisions'), events: f.count('events'), operations: f.count('operations') };
  const err = failure(() => f.tx(f.claude, `@air1\n#0 tnew "new task"\n#1 dec "a decision"\n#2 ref x\n#3 tupd t=${handle} v=99 st=done`));
  assert.equal(err.code, 'VERSION_CONFLICT'); assert.match(err.message, /^line=5 node=3: task is at version 1/);
  assert.deepEqual({ tasks: f.count('tasks'), decisions: f.count('decisions'), events: f.count('events'), operations: f.count('operations') }, before);
  assert.equal(failure(() => f.tx(f.claude, '@air1\n#0 dec "kept?"\n#1 ask to=nobody "hello"')).code, 'ACTOR_NOT_FOUND');
  assert.equal(f.count('decisions'), before.decisions);
});

test('4. replaying an air_tx returns the same handles; changed input with the same operation_id conflicts', t => {
  const f = fixture(t);
  const input = { project_id: f.project.id, packet: '@air1\n#0 tnew "once"\n#1 dec t=#0 "only once"', operation_id: 'air-op-1' };
  const first = f.call(f.claude, 'air_tx', input), again = f.call(f.claude, 'air_tx', input);
  assert.deepEqual(again.handles, first.handles); assert.equal(again.replayed, true);
  assert.match(again.air, /^@air1 ok op=air-op-1 seq=\d+ replay=1 unseen=0 inbox=0\n/);
  assert.equal(f.count('tasks'), 1);
  assert.equal(failure(() => f.call(f.claude, 'air_tx', { ...input, packet: input.packet + 'x' })).code, 'IDEMPOTENCY_CONFLICT');
  // The header's op= and project must agree with the call.
  assert.equal(failure(() => f.tx(f.claude, '@air1 op=other\n#0 tnew "x"', { operation_id: 'mine' })).code, 'OPERATION_ID_MISMATCH');
  assert.equal(failure(() => f.call(f.claude, 'air_tx', { packet: '@air1\n#0 tnew "x"', operation_id: f.op() })).code, 'PROJECT_REQUIRED');
  const other = f.call(f.claude, 'project_create', { name: 'Other', operation_id: f.op() }).project;
  assert.equal(failure(() => f.tx(f.claude, `@air1 p=${other.id}\n#0 tnew "x"`)).code, 'PROJECT_MISMATCH');
  assert.equal(f.tx(f.claude, '@air1 p=p1\n#0 tnew "header names p1"').handles['0'].startsWith('t'), true);
});

test('5. JSON tools and AIR-T see the same state', t => {
  const f = fixture(t);
  assert.match(f.call(f.codex, 'air_sync', { project_id: f.project.id }).air, /^@air1 sync p=p1 name=Demo from=0 to=\d+ snap=1/);
  const task = f.call(f.claude, 'task_create', { project_id: f.project.id, title: 'JSON task', operation_id: f.op() }).task;
  f.call(f.claude, 'decision_record', { project_id: f.project.id, task_id: task.id, summary: 'JSON decision', operation_id: f.op() });
  f.call(f.claude, 'project_checkpoint', { project_id: f.project.id, summary: 'JSON checkpoint', next_action: 'next step', operation_id: f.op() });
  const delta = f.call(f.codex, 'air_sync', { project_id: f.project.id }).air.split('\n');
  assert.match(delta[0], /^@air1 sync p=p1 name=Demo from=\d+ to=\d+ next="next step"$/);
  assert.deepEqual(delta.slice(1).map((l: string) => l[0]), ['T', 'D', 'C']);
  assert.match(delta[1], /^T t\d+ v=1 st=open "JSON task"$/);
  // Written through AIR-T, read through JSON.
  const handle = f.store.handleOf('t', task.id)!;
  f.tx(f.claude, `@air1\n#0 tclm t=${handle} v=1\n#1 tupd t=${handle} v=2 st=awaiting_review next="review it"`);
  const resume = f.call(f.codex, 'project_resume', { project_id: 'p1' });
  assert.equal(resume.active_tasks[0].status, 'awaiting_review'); assert.equal(resume.active_tasks[0].next_action, 'review it');
  assert.equal(f.call(f.codex, 'task_read', { task_id: handle }).task.id, task.id, 'JSON tools accept short handles');
  const decoded = f.store.airDecode('p1');
  assert.ok(decoded.some(l => /claude-desktop updated task t\d+ "JSON task" \(now awaiting_review, version 3\)/.test(l)), decoded.join('\n'));
  assert.ok(decoded.every(l => !l.includes('@air1')), 'the decoder prints plain English');
});

test('a first read of a project with no events yet still leads to deltas, not another snapshot', t => {
  // Found live on 2026-11-19: right after the schema-5 install the feed was empty, the first read saved position 0,
  // and the second read returned a whole snapshot again.
  const f = fixture(t);
  f.store.db.exec('DELETE FROM events');
  assert.match(f.call(f.codex, 'air_sync', { project_id: f.project.id }).air, /from=0 to=0 snap=1/);
  f.tx(f.claude, '@air1\n#0 dec "after the first read"');
  const second = f.call(f.codex, 'air_sync', { project_id: f.project.id }).air.split('\n');
  assert.doesNotMatch(second[0], /snap=1/); assert.match(second[0], /from=0 to=\d+/);
  assert.deepEqual(second.slice(1).map((l: string) => l[0]), ['D']);
  assert.match(f.call(f.codex, 'air_sync', { project_id: f.project.id, since_seq: 0 }).air, /snap=1/, 'since_seq 0 still asks for a snapshot');
});

test('a task-scoped air_sync does not move the project-wide read position', t => {
  const f = fixture(t);
  const sync = (extra = {}) => f.call(f.codex, 'air_sync', { project_id: f.project.id, ...extra }).air.split('\n');
  const position = () => (f.store.db.prepare('SELECT last_seq FROM actor_cursors WHERE actor_id=? AND project_id=?').get(f.codex.id, f.project.id) as any)?.last_seq;
  // A task-scoped first read saves no position, so the next project-wide read is still a snapshot.
  const t0 = f.tx(f.claude, '@air1\n#0 tnew "early"').handles['0'].split('@')[0];
  assert.match(sync({ task_id: t0 })[0], /snap=1/);
  assert.equal(position(), undefined);
  assert.match(sync()[0], /snap=1/);
  const saved = position();
  const r = f.tx(f.claude, '@air1\n#0 tnew "alpha"\n#1 tnew "beta"\n#2 dec "project decision"\n#3 chk "project checkpoint"');
  const [alpha, beta] = [r.handles['0'], r.handles['1']].map((h: string) => h.split('@')[0]);
  const scoped = sync({ task_id: alpha }).slice(1);
  assert.deepEqual(scoped.map((l: string) => l.split(' ').slice(0, 2).join(' ')), [`T ${alpha}`]);
  assert.equal(position(), saved, 'the task-scoped read left the position alone');
  const kinds = sync().slice(1).map((l: string) => l.split(' ').slice(0, 2).join(' '));
  for (const want of [`T ${alpha}`, `T ${beta}`]) assert.ok(kinds.includes(want), want);
  assert.ok(kinds.some((k: string) => k.startsWith('D ')), 'project decision');
  assert.ok(kinds.some((k: string) => k.startsWith('C ')), 'project checkpoint');
  assert.deepEqual(sync().slice(1), [], 'the project-wide read moved the position');
});

test('6. each actor has its own read position', t => {
  const f = fixture(t);
  const sync = (actor: Actor, extra = {}) => f.call(actor, 'air_sync', { project_id: f.project.id, ...extra }).air.split('\n');
  for (const actor of [f.claude, f.codex, f.ag]) sync(actor);
  f.tx(f.ag, '@air1\n#0 dec "from antigravity"');
  assert.equal(sync(f.codex).filter((l: string) => l.startsWith('D')).length, 1);
  assert.deepEqual(sync(f.codex).slice(1), [], 'nothing new on the next read');
  assert.equal(sync(f.claude, { advance_cursor: false }).length, 2, 'peek');
  assert.equal(sync(f.claude).length, 2, 'the peek did not move the position');
  assert.equal(sync(f.claude).length, 1);
  // A task changed several times appears once, in its latest state.
  sync(f.ag);  // catch up past its own decision first
  const r = f.tx(f.claude, '@air1\n#0 tnew "busy"\n#1 tclm t=#0 v=1\n#2 tupd t=#0 v=2 st=blocked');
  const lines = sync(f.ag).slice(1);
  assert.equal(lines.length, 1); assert.match(lines[0], new RegExp(`^T ${r.handles['0'].split('@')[0]} v=3 st=blk own=claude-desktop busy$`), 'one-word text is written bare');
  assert.match(f.call(f.codex, 'air_sync', { project_id: f.project.id, include_spec: true }).air, /\n@air1 spec\nAIR-T v0\.1/);
});

test('7. the MCP bridge returns AIR-T text without a JSON copy', () => {
  const ok = toolReply('air_tx', { air: '@air1 ok op=x seq=3\n#0=t4@v1', op: 'x', seq: 3, handles: { 0: 't4@v1' } }) as any;
  assert.deepEqual(ok, { content: [{ type: 'text', text: '@air1 ok op=x seq=3\n#0=t4@v1' }] });
  assert.ok((toolReply('task_read', { task: {} }) as any).structuredContent, 'JSON tools are unchanged');
  const err = toolError('air_tx', new RemoteError('VERSION_CONFLICT', 'line=5 node=3: task is at version 4'), {}) as any;
  assert.equal(err.isError, true); assert.equal(err.structuredContent, undefined);
  assert.equal(err.content[0].text, '@air1 err line=5 node=3 code=VERSION_CONFLICT msg="task is at version 4"');
});

test('job nodes keep every job_submit rule; proto takes text or air', t => {
  const f = fixture(t);
  assert.equal(failure(() => f.tx(f.claude, '@air1\n#0 job route=openai-api "no ceiling"')).code, 'INVALID_INPUT');
  assert.equal(failure(() => f.tx(f.claude, '@air1\n#0 job route=claude proto=xml "x"')).code, 'INVALID_INPUT');
  const r = f.tx(f.claude, '@air1\n#0 tnew "with a job"\n#1 job t=#0 route=antigravity task=review "review this"');
  assert.match(r.handles['1'], /^j\d+$/);
  const job = f.call(f.claude, 'job_status', { job_id: r.handles['1'] }).job;
  assert.equal(job.route, 'antigravity'); assert.deepEqual(job.options, { task: 'review', cost_class: 'omitted', selection: { intent: 'code', eff: 'med', source: 'inferred', reasons: ['default'] } });
});

test('an existing ID that looks like a handle wins over the handle', t => {
  const f = fixture(t);
  const first = f.call(f.claude, 'task_create', { project_id: f.project.id, title: 'seq one', operation_id: f.op() }).task;
  f.store.db.prepare("INSERT INTO tasks(id,project_id,title,objective,acceptance,status,version,created_by,created_at,updated_at) VALUES('t1',?,'imported','', '[]','open',1,'x','2026-01-01','2026-01-01')").run(f.project.id);
  assert.equal(f.call(f.claude, 'task_read', { task_id: 't1' }).task.title, 'imported');
  assert.equal(f.store.handleOf('t', first.id), 't1', 'its handle still prints as t1; the UUID is unambiguous');
});

test('schema 5 backfills short handles for existing projects and artifacts', t => {
  const f = fixture(t);
  f.call(f.claude, 'artifact_submit', { project_id: f.project.id, name: 'log', content: 'hello', operation_id: f.op() });
  const second = f.call(f.claude, 'project_create', { name: 'Second', operation_id: f.op() }).project;
  // Turn the database back into schema 4, then reopen.
  f.store.db.exec(`DROP TABLE short_ids; DROP TABLE events; DROP TABLE actor_cursors; ALTER TABLE decisions DROP COLUMN confidence;
    ALTER TABLE messages DROP COLUMN confidence; ALTER TABLE checkpoints DROP COLUMN confidence; PRAGMA user_version = 4;`);
  const store = f.reopen();
  assert.equal(Number((store.db.prepare('PRAGMA user_version').get() as any).user_version), SCHEMA_VERSION);
  assert.equal(store.handleOf('p', f.project.id), 'p1'); assert.equal(store.handleOf('p', second.id), 'p2');
  assert.equal(store.handleOf('a', (store.db.prepare('SELECT id FROM artifacts').get() as any).id), 'a1');
  const third = f.call(f.claude, 'project_create', { name: 'Third', operation_id: f.op() }).project;
  assert.equal(store.handleOf('p', third.id), 'p3', 'new projects continue the numbering');
});
