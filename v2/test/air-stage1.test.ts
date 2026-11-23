// Fabric Stage 1: air_wait (bounded wait on one or more jobs) and short task status codes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server.ts';
import { Store, type Actor } from '../src/store.ts';
import { call, RemoteError, type Connection } from '../src/client.ts';
import { listedTools } from '../src/tools.ts';
import { AIR_PRIMER } from '../src/air/primer.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

async function service(t: any) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-wait-'));
  const repo = path.join(home, 'repo'); fs.mkdirSync(repo);
  const seed = new Store(home);
  const token = seed.createActor('claude-desktop', 'participant', 'claude-desktop').token;
  seed.close();
  const running = await startServer(home, 0, { claude: { file: process.execPath, prefix: [FAKE] }, tickMs: 50 });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await running.close(); } };
  t.after(async () => { await close(); fs.rmSync(home, { recursive: true, force: true }); });
  const conn: Connection = { url: running.url, token, actorId: 'claude-desktop' };
  const c = (method: string, input: Record<string, unknown> = {}) => call(conn, method, input);
  await c('project_create', { name: 'Repo', root: repo, operation_id: randomUUID() });
  const job = async (prompt: string) => (await c('air_tx', { project_id: 'p1', packet: `@air1\n#0 job route=claude ${JSON.stringify(prompt)}`, operation_id: randomUUID() })).handles['0'] as string;
  const wait = async (handles: string, extra: Record<string, unknown> = {}) => {
    const started = Date.now(), r = await c('air_wait', { handles, ...extra });
    return { lines: r.air.split('\n') as string[], ms: Date.now() - started };
  };
  return { c, job, wait, close, running };
}

test('air_wait returns as soon as the job finishes, with its full J line', async t => {
  const s = await service(t);
  const j = await s.job('DELAY then answer');
  const { lines, ms } = await s.wait(j, { wait_seconds: 20 });
  assert.equal(lines[0], '@air1 wait n=1 done=1');
  assert.match(lines[1], new RegExp(`^J ${j} route=claude mode=advice st=completed .*res=late`));
  assert.ok(ms < 10000, `took ${ms} ms`);
  const again = await s.wait(j, { wait_seconds: 20 });
  assert.ok(again.ms < 2000, 'an already finished job answers at once'); assert.equal(again.lines[0], '@air1 wait n=1 done=1');
});

test('air_wait times out without failing, and waits for every job by default', async t => {
  const s = await service(t);
  const slow = await s.job('SLEEP forever');
  const timedOut = await s.wait(slow, { wait_seconds: 1 });
  assert.equal(timedOut.lines[0], '@air1 wait n=1 done=0 timeout=1');
  assert.match(timedOut.lines[1], /st=(queued|running)/); assert.ok(timedOut.ms >= 900 && timedOut.ms < 5000, `took ${timedOut.ms} ms`);
  await s.c('air_tx', { project_id: 'p1', packet: `@air1\n#0 jcan j=${slow}`, operation_id: randomUUID() });
  await s.wait(slow, { wait_seconds: 20 });
  // Two jobs on one route run one after the other; the wait returns when both are done.
  const [a, b] = [await s.job('DELAY one'), await s.job('DELAY two')];
  const both = await s.wait(`${a},${b}`, { wait_seconds: 20 });
  assert.equal(both.lines[0], '@air1 wait n=2 done=2');
  // any: true returns at the first finished job.
  const [x, y] = [await s.job('DELAY first'), await s.job('SLEEP second')];
  const any = await s.wait(`${x},${y}`, { wait_seconds: 20, any: true });
  assert.equal(any.lines[0], '@air1 wait n=2 done=1');
  await s.c('air_tx', { project_id: 'p1', packet: `@air1\n#0 jcan j=${y}`, operation_id: randomUUID() });
});

test('air_wait checks its input and reports bad items alone', async t => {
  const s = await service(t);
  const task = (await s.c('air_tx', { project_id: 'p1', packet: '@air1\n#0 tnew "not a job"', operation_id: randomUUID() })).handles['0'].split('@')[0];
  const { lines } = await s.wait(`${task},j99,zz`, { wait_seconds: 1 });  // a task with no jobs (since Phase 3 a task handle stands for its jobs)
  assert.deepEqual(lines, ['@air1 wait n=3 done=3', `! ${task} err=NO_JOBS`, '! j99 err=NOT_FOUND', '! zz err=BAD_HANDLE']);
  assert.equal((await s.wait('d1', { wait_seconds: 1 })).lines[1], '! d1 err=NOT_A_JOB', 'other kinds are not jobs');
  for (const bad of [{ handles: 'j1', wait_seconds: 0 }, { handles: 'j1', wait_seconds: 51 }, { handles: Array.from({ length: 11 }, (_, i) => 'j' + (i + 1)).join(',') }])
    await assert.rejects(s.c('air_wait', bad), (error: RemoteError) => error.code === 'INVALID_INPUT');
});

test('stopping the service ends a pending air_wait promptly', async t => {
  const s = await service(t);
  const slow = await s.job('SLEEP forever');
  const started = Date.now();
  const pending = s.wait(slow, { wait_seconds: 40 }).then(r => r.lines[0], (e: Error) => 'error: ' + e.message);
  await new Promise(resolve => setTimeout(resolve, 500));
  await s.close();
  const first = await pending;
  assert.ok(Date.now() - started < 10000, 'did not wait out the 40 seconds');
  assert.match(first, /^@air1 wait n=1 done=1 closing=1$/, 'the stopped job is needs_review, a finished state');
});

test('air_wait is the fifth AIR tool and is in the full catalog too', () => {
  assert.deepEqual(listedTools('air').map(tool => tool.name), ['air_sync', 'air_tx', 'air_get', 'air_wait', 'art_put']);
  assert.ok(listedTools('full').some(tool => tool.name === 'air_wait'));
});

test('short task status codes: accepted on input, written on new lines, spelled out by the decoder', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-codes-'));
  const store = new Store(home);
  t.after(() => { store.close(); fs.rmSync(home, { recursive: true, force: true }); });
  const actor: Actor = store.createActor('claude-desktop', 'participant', 'claude-desktop').actor;
  store.call(actor, 'project_create', { name: 'Demo', operation_id: randomUUID() });
  const tx = (packet: string) => store.call(actor, 'air_tx', { project_id: 'p1', packet, operation_id: randomUUID() });
  const t1 = tx('@air1\n#0 tnew "coded"\n#1 tclm t=#0 v=1').handles['0'].split('@')[0];
  const status = () => (store.db.prepare('SELECT status FROM tasks').get() as any).status;
  const line = () => (store.db.prepare("SELECT air_line FROM events WHERE kind='task' ORDER BY seq DESC LIMIT 1").get() as any).air_line as string;
  assert.match(line(), / st=wip /, 'in_progress is written as wip');
  for (const [code, stored, version] of [['blk', 'blocked', 2], ['rev', 'awaiting_review', 3], ['wip', 'in_progress', 4], ['blocked', 'blocked', 5], ['can', 'cancelled', 6]] as const) {
    tx(`@air1\n#0 tupd t=${t1} v=${version} st=${code}`);
    assert.equal(status(), stored, code); assert.match(line(), new RegExp(` st=${({ blocked: 'blk', awaiting_review: 'rev', in_progress: 'wip', cancelled: 'can' } as any)[stored]} `));
  }
  assert.throws(() => tx(`@air1\n#0 tupd t=${t1} v=7 st=bogus`), /st= must be one of/);
  const t2 = store.call(actor, 'task_create', { project_id: 'p1', title: 'json', operation_id: randomUUID() }).task;
  store.call(actor, 'task_claim', { task_id: t2.id, version: 1, operation_id: randomUUID() });
  assert.equal(store.call(actor, 'task_update', { task_id: t2.id, version: 2, status: 'blk', operation_id: randomUUID() }).task.status, 'blocked', 'JSON tools accept the codes too');
  assert.ok(store.airDecode('p1').some(l => /\(now blocked, version 3\)/.test(l)), 'the decoder prints the full name');
  assert.match(AIR_PRIMER, /wip=in_progress/);
});

test('air_wait reminds the submitter to record an outcome until one exists', async t => {
  const s = await service(t);
  const j = await s.job('DELAY then answer');
  const first = await s.wait(j, { wait_seconds: 20 });
  assert.match(first.lines.at(-1)!, new RegExp(`^hint=out: after using ${j}, record`));
  await s.c('air_tx', { project_id: 'p1', packet: `@air1\n#0 out j=${j} v=accepted "useful"`, operation_id: randomUUID() });
  const after = await s.wait(j, { wait_seconds: 20 });
  assert.ok(!after.lines.some(l => l.startsWith('hint=out')), after.lines.join('\n'));
});
