// AIR-T step 2a: air_get, air_sync root=, unseen/inbox counts, self-echo suppression, artifact dedup and jcan.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, CommonsError, type Actor } from '../src/store.ts';
import { toolReply } from '../src/mcp-reply.ts';
import { listedTools } from '../src/tools.ts';

function fixture(t: any) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-air2a-'));
  const store = new Store(home);
  t.after(() => { try { store.close(); } catch {} fs.rmSync(home, { recursive: true, force: true }); });
  const claude = store.createActor('claude-desktop', 'participant', 'claude-desktop').actor;
  const codex = store.createActor('codex-desktop', 'participant', 'codex-desktop').actor;
  const op = () => randomUUID();
  const call = (actor: Actor, method: string, input: Record<string, unknown> = {}) => store.call(actor, method, input);
  const project = call(claude, 'project_create', { name: 'Demo', root: home, operation_id: op() }).project;
  const tx = (actor: Actor, packet: string) => call(actor, 'air_tx', { project_id: project.id, packet, operation_id: op() });
  const get = (actor: Actor, handles: string, extra: Record<string, unknown> = {}) => call(actor, 'air_get', { handles, ...extra }).air.split('\n') as string[];
  const sync = (actor: Actor, extra: Record<string, unknown> = {}) => call(actor, 'air_sync', { project_id: project.id, ...extra }).air.split('\n') as string[];
  const count = (table: string) => Number((store.db.prepare(`SELECT count(*) n FROM ${table}`).get() as any).n);
  return { home, store, claude, codex, op, call, tx, get, sync, count, project };
}
const failure = (fn: () => unknown) => { try { fn(); } catch (error) { return error as CommonsError; } throw new Error('expected a failure'); };
const h = (handle: string) => handle.split('@')[0];

test('air_get returns every field air_sync leaves out, without the 300-character cut', t => {
  const f = fixture(t);
  const long = 'x'.repeat(400);
  const r = f.tx(f.claude, `@air1
#0 tnew "full task" obj="${long}" acc="passes tests","has docs" next=ship
#1 art name=log kind=text "line one"
#2 dec t=#0 why="because, reasons" ev=file:a.ts,#1 p=.9 "pick A"
#3 chk t=#0 rev=abc br=main ok="tsc ok","48/48" q="keep it?" arts=#1 next=merge "built it"
#4 dopen subj=naming "which name?"
#5 dpost g=#4 ev=file:b.ts "call it B"
#6 job t=#0 route=antigravity task=review "review the change"`);
  const [task, art, dec, chk, disc, , job] = [0, 1, 2, 3, 4, 5, 6].map(k => h(r.handles[k]));
  f.store.updateJob(f.store.db.prepare('SELECT id FROM jobs').get()!.id as string,
    { status: 'completed', result: 'all good\nsecond line', changed_files: ['a.ts'], turns: 3, cost_usd: 0.01, finished_at: new Date().toISOString() });
  const lines = f.get(f.codex, [task, dec, chk, disc, job, 'zz9', 't999'].join(','));
  assert.equal(lines[0], '@air1 get n=7');
  const T = lines.find(l => l.startsWith(`T ${task} `))!;
  assert.ok(T.includes(`obj=${long}`), 'objective is complete'); assert.match(T, /acc="passes tests","has docs"/); assert.match(T, /next=ship/);
  assert.match(lines.find(l => l.startsWith(`D ${dec} `))!, new RegExp(`^D ${dec} t=${task} by=claude-desktop p=\\.9 why="because, reasons" ev=file:a.ts,${art} "pick A"$`));
  assert.match(lines.find(l => l.startsWith(`C ${chk} `))!, new RegExp(`ok="tsc ok",48/48 q="keep it\\?" arts=${art} "built it"$`));
  const g = lines.findIndex(l => l.startsWith(`G ${disc} `));
  assert.match(lines[g], /q="which name\?"/); assert.match(lines[g + 1], /^M m\d+ g=g\d+ from=claude-desktop type=post ev=file:b.ts "call it B"$/, 'the discussion lists its messages');
  const J = lines.find(l => l.startsWith(`J ${job} `))!;
  assert.match(J, /st=completed/); assert.match(J, /files=a.ts/); assert.match(J, /turns=3/); assert.match(J, /cost=0.01/); assert.match(J, /res="all good\\nsecond line"/);
  assert.ok(lines.includes('! zz9 err=BAD_HANDLE') && lines.includes('! t999 err=NOT_FOUND'), 'bad items fail alone');
  // A UUID works too, and a per-field cap applies when asked.
  const byId = f.get(f.codex, f.store.db.prepare('SELECT id FROM tasks').get()!.id as string, { max_chars: 50 });
  assert.ok(byId[1].includes(`obj="${'x'.repeat(50)}...[+350]"`), byId[1]);
  assert.equal(failure(() => f.get(f.codex, Array.from({ length: 26 }, (_, i) => 't' + (i + 1)).join(','))).code, 'INVALID_INPUT');
});

test('air_get slices and searches artifacts by line', t => {
  const f = fixture(t);
  const content = Array.from({ length: 500 }, (_, i) => `line ${i + 1}${(i + 1) % 100 === 0 ? ' ERROR here' : ''}`).join('\n');
  const a = f.call(f.claude, 'artifact_submit', { project_id: f.project.id, name: 'big.log', content, operation_id: f.op() }).artifact;
  const handle = f.store.handleOf('a', a.id)!;
  const first = f.get(f.codex, handle);
  assert.match(first[1], new RegExp(`^A ${handle} name=big.log kind=text bytes=\\d+ lines=500 show=1-200 more=1$`), 'default: the first 200 lines');
  assert.equal(first.length, 202); assert.equal(first[2], "|line 1"); assert.equal(first[201], "|line 200 ERROR here");
  const slice = f.get(f.codex, `${handle}:10-12`);
  assert.deepEqual(slice.slice(1), [`A ${handle} name=big.log kind=text bytes=${a.bytes} lines=500 show=10-12`, '|line 10', '|line 11', '|line 12']);
  const hits = f.get(f.codex, handle, { grep: 'error' });
  assert.equal(hits[1], `A ${handle} name=big.log kind=text bytes=${a.bytes} lines=500 grep=error hits=5`);
  assert.deepEqual(hits.slice(2), ['100|line 100 ERROR here', '200|line 200 ERROR here', '300|line 300 ERROR here', '400|line 400 ERROR here', '500|line 500 ERROR here']);
  assert.deepEqual(f.get(f.codex, `${handle}:150-250`, { grep: 'error' }).slice(2), ['200|line 200 ERROR here'], 'grep stays inside the range');
  // The byte cap cuts at a whole line and says where to continue.
  const capped = f.get(f.codex, `${handle}:1-500`, { max_chars: 100 });
  assert.match(capped[1], /show=1-\d+ more=1$/); assert.ok(capped.slice(2).join('\n').length <= 100);
  assert.equal(f.get(f.codex, `${handle}:9-3`)[1], `! ${handle}:9-3 err=BAD_RANGE`);
});

test('air_sync finds the project from the workspace root', t => {
  const f = fixture(t);
  const sub = path.join(f.home, 'src', 'deep');
  assert.match(f.call(f.codex, 'air_sync', { root: sub }).air, /^@air1 sync p=p1 name=Demo /);
  assert.equal(failure(() => f.call(f.codex, 'air_sync', { root: os.tmpdir() })).code, 'PROJECT_NOT_FOUND');
  const other = f.call(f.claude, 'project_create', { name: 'Other', operation_id: f.op() }).project;
  assert.equal(failure(() => f.call(f.codex, 'air_sync', { project_id: other.id, root: f.home })).code, 'PROJECT_MISMATCH');
  // A nested project wins over its parent.
  const nested = f.call(f.claude, 'project_create', { name: 'Nested', root: path.join(f.home, 'src'), operation_id: f.op() }).project;
  assert.match(f.call(f.codex, 'air_sync', { root: sub }).air, new RegExp(`^@air1 sync p=${f.store.handleOf('p', nested.id)} name=Nested `));
  assert.ok(listedTools().find(tool => tool.name === 'air_sync')!.inputSchema.properties.root, 'the tool takes root');
});

test('air_tx reports unseen changes and the inbox, and skips your own writes on the next sync', t => {
  const f = fixture(t);
  f.sync(f.claude); f.sync(f.codex);
  const quiet = f.tx(f.claude, '@air1\n#0 dec "mine"');
  assert.match(quiet.air, /^@air1 ok op=\S+ seq=\d+ unseen=0 inbox=0\n#0=d\d+$/);
  assert.deepEqual(f.sync(f.claude).slice(1), [], 'nothing from others, so its own write is not echoed back');
  assert.equal(f.sync(f.codex).filter(l => l.startsWith('D')).length, 1, 'others still see it');
  f.tx(f.codex, '@air1\n#0 dec "from codex"\n#1 ask to=claude-desktop "are you there?"');
  const busy = f.tx(f.claude, '@air1\n#0 dec "mine again"');
  assert.match(busy.air, /unseen=2 inbox=1/);
  const next = f.sync(f.claude);
  assert.match(next[0], / inbox=1/);
  assert.deepEqual(next.slice(1).map(l => l[0]).sort(), ['D', 'D', 'M'], 'unread changes from others keep the position, so its own write shows with them');
  // A replay repeats the stored reply.
  const input = { project_id: f.project.id, packet: '@air1\n#0 dec "once"', operation_id: 'fixed-op' };
  const a = f.call(f.claude, 'air_tx', input), b = f.call(f.claude, 'air_tx', input);
  assert.equal(b.air, a.air.replace(/(seq=\d+)/, '$1 replay=1'));
  // An actor that never synced keeps its first snapshot.
  f.tx(f.store.createActor('fresh', 'participant', 'fresh').actor, '@air1\n#0 dec "hello"');
  assert.match(f.call({ id: 'fresh', name: 'fresh', role: 'participant' }, 'air_sync', { project_id: f.project.id }).air, /snap=1/);
});

test('the same artifact stored twice keeps one row, one handle and one event', t => {
  const f = fixture(t);
  const put = (name: string, content: string) => f.call(f.claude, 'artifact_submit', { project_id: f.project.id, name, content, operation_id: f.op() });
  const first = put('log', 'same bytes'), again = put('log', 'same bytes');
  assert.equal(again.artifact.id, first.artifact.id); assert.equal(again.dedup, true); assert.equal(first.dedup, undefined);
  assert.equal(again.artifact.seq, undefined);
  assert.notEqual(put('other-name', 'same bytes').artifact.id, first.artifact.id, 'a different name is a different artifact');
  assert.equal(f.count('artifacts'), 2); assert.equal(Number((f.store.db.prepare("SELECT count(*) n FROM events WHERE kind='artifact'").get() as any).n), 2);
  const r = f.tx(f.claude, '@air1\n#0 art name=log "same bytes"');
  assert.equal(r.handles['0'], f.store.handleOf('a', first.artifact.id));
});

test('jcan cancels a job inside air_tx', t => {
  const f = fixture(t);
  const r = f.tx(f.claude, '@air1\n#0 job route=antigravity "think"');
  const c = f.tx(f.claude, `@air1\n#0 jcan j=${r.handles['0']}`);
  assert.equal(c.handles['0'], r.handles['0']);
  assert.equal(f.call(f.claude, 'job_status', { job_id: r.handles['0'] }).job.status, 'cancelled');
  assert.equal(failure(() => f.tx(f.claude, `@air1\n#0 jcan j=${r.handles['0']}`)).code, 'JOB_FINISHED');
});

test('the MCP bridge returns air_get as text only', () => {
  assert.deepEqual(toolReply('air_get', { air: '@air1 get n=1\nT t1 v=1 st=open x' }), { content: [{ type: 'text', text: '@air1 get n=1\nT t1 v=1 st=open x' }] });
});
