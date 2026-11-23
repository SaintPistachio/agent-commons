// Phase 5c: yield and resume. A proto=air advice worker that cannot finish alone ends with "@air1 #0 need to=...
// "question"". Agent Commons runs one consult job (depth 1), then a continuation job: the same worker again, with the
// answer. At most 2 yields per chain, never on a paid route, never from an edit job or a consult. air_wait follows the
// chain to its last job.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, CommonsError, type Actor } from '../src/store.ts';
import { adapter } from '../src/adapters/registry.ts';
import { parsePacket } from '../src/air/parser.ts';
import { checkWorkerBlock } from '../src/air/worker.ts';
import { AirParseError } from '../src/air/types.ts';

function fixture(t: any) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-p5c-'));
  const home = path.join(base, 'home'), repo = path.join(base, 'repo'); fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'notes.md'), 'design notes\n');
  const store = new Store(home);
  t.after(() => { try { store.close(); } catch {} fs.rmSync(base, { recursive: true, force: true }); });
  const claude: Actor = store.createActor('claude-desktop', 'participant', 'claude-desktop').actor;
  store.setActorTags('claude-desktop', 'anthropic', 'claude');
  for (const id of ['claude', 'codex', 'openai-api', 'antigravity']) store.recordProbe(adapter(id)!.capabilities, { state: 'verified' });
  const call = (method: string, input: Record<string, unknown> = {}) => store.call(claude, method, input);
  call('project_create', { name: 'Repo', root: repo, operation_id: randomUUID() });
  const submit = (extra: Record<string, unknown> = {}) => call('job_submit', { project_id: 'p1', protocol: 'air', prompt: 'Design the cache', context_refs: ['file:notes.md'], operation_id: randomUUID(), ...extra }).job;
  const finish = (id: string, result: string, status = 'completed') => store.updateJob(id, { status, result, ...(status === 'failed' ? { error: 'CLI_ERROR: crashed' } : {}), finished_at: new Date().toISOString() });
  const need = (to: string, question = 'Which eviction policy fits?', extra = '') => `Partial work.\n@air1\n#0 need to=${to} ${extra} "${question}"`;
  const done = (text = 'final design') => `${text}\n@air1\n#0 chk verdict=ok p=.9 "${text}"`;
  const job = (id: string) => store.jobByRef(id);
  return { store, claude, call, submit, finish, need, done, job };
}

test('need is a worker-only opcode; the worker check returns it', () => {
  const parsed = parsePacket('@air1\n#0 need to=codex eff=high ctx=file:a.ts,task:t1 "which eviction policy?"', 'worker');
  assert.equal(parsed.nodes[0].op, 'need');
  assert.throws(() => parsePacket('@air1\n#0 need to=codex "x"'), (e: AirParseError) => e.code === 'WORKER_ONLY');
  const checked = checkWorkerBlock('thinking...\n@air1\n#0 need to=codex eff=high ctx=file:a.ts "which eviction policy?"');
  assert.deepEqual(checked, { ok: true, nodes: 1, verdict: null, p: null, summary: null, need: { to: 'codex', eff: 'high', ctx: ['file:a.ts'], question: 'which eviction policy?' } });
});

test('a need runs one consult, then the same worker again with the answer and the same context', t => {
  const f = fixture(t);
  const root = f.submit();
  f.finish(root.id, f.need('codex', 'Which eviction policy fits?', 'eff=high ctx=file:notes.md'));
  const consultId = f.job(root.id).options.next;
  const consult = f.job(consultId);
  assert.deepEqual([consult.route, consult.mode, consult.trigger, consult.wake_depth, consult.parent_job_id, consult.options.proto, consult.req_eff],
    ['codex', 'advice', 'yield', 1, root.id, 'air', 'high']);
  assert.deepEqual(consult.options.ctx, ['file:notes.md']);
  assert.match(consult.prompt, /^A worker on job j\d+ asks: Which eviction policy fits\?/);
  f.finish(consultId, 'Use LRU with a size cap.\n@air1\n#0 chk p=.8 "LRU"');
  const contId = f.job(consultId).options.next;
  const cont = f.job(contId);
  assert.deepEqual([cont.route, cont.trigger, cont.wake_depth, cont.parent_job_id, cont.options.yields, cont.options.proto], ['claude', 'resume', 0, root.id, 1, 'air']);
  assert.deepEqual(cont.options.ctx, ['file:notes.md'], 'the worker keeps its context');
  assert.match(cont.prompt, /^Design the cache\n\n@consult j\d+ \(codex\) answered "Which eviction policy fits\?":\nUse LRU with a size cap\.\n\nContinue the original request/);
  assert.match(f.call('air_get', { handles: `j${f.store.handleOf('j', root.id)!.slice(1)}` }).air, / next=j\d+/, 'the J line links to the next job');
});

test('at most two yields per chain; edit jobs, paid routes and consults cannot yield', t => {
  const f = fixture(t);
  let current = f.submit().id;
  for (let i = 0; i < 2; i++) {
    f.finish(current, f.need('codex'));
    const consult = f.job(current).options.next; f.finish(consult, 'answer');
    current = f.job(consult).options.next;
  }
  assert.equal(f.job(current).options.yields, 2);
  f.finish(current, f.need('codex'));
  assert.equal(f.job(current).options.need_refused, 'MAX_YIELDS'); assert.equal(f.job(current).options.next, undefined);
  const edit = f.submit({ mode: 'edit', context_refs: [] });
  f.finish(edit.id, f.need('codex')); assert.equal(f.job(edit.id).options.need_refused, 'EDIT_JOB');
  const paid = f.submit({ route: 'openai-api', max_cost_usd: '0.05', purpose: 'p', deliverable: 'd' });
  f.finish(paid.id, f.need('codex')); assert.equal(f.job(paid.id).options.need_refused, 'PAID_ROUTE');
  const asksPaid = f.submit();
  f.finish(asksPaid.id, f.need('api')); assert.equal(f.job(asksPaid.id).options.need_refused, 'PAID_ROUTE');
  const root = f.submit();
  f.finish(root.id, f.need('codex'));
  const consult = f.job(root.id).options.next;
  f.finish(consult, f.need('claude'));
  assert.equal(f.job(consult).options.need_refused, undefined, 'a consult\'s need is its answer, not a new yield');
  assert.ok(f.job(f.job(consult).options.next).trigger === 'resume', 'the worker resumes with whatever the consult said');
  const plain = f.call('job_submit', { project_id: 'p1', prompt: 'x', operation_id: randomUUID() }).job;
  f.finish(plain.id, f.need('codex')); assert.equal(f.job(plain.id).options.next, undefined, 'only proto=air jobs yield');
});

test('need to=auto picks a subscription route; a failed consult still resumes the worker', t => {
  const f = fixture(t);
  const root = f.submit();
  f.finish(root.id, f.need('auto'));
  const consult = f.job(f.job(root.id).options.next);
  assert.notEqual(consult.route, 'openai-api'); assert.deepEqual(consult.options.auto?.considered?.includes('openai-api'), false);
  f.finish(consult.id, 'boom', 'failed');
  const cont = f.job(f.job(consult.id).options.next);
  assert.match(cont.prompt, /@consult j\d+ \(\w+\) did not finish \(failed\): CLI_ERROR: crashed\n\nContinue the original request without it/);
});

test('air_wait on the first job follows the chain and answers with its last job', async t => {
  const f = fixture(t);
  const root = f.submit();
  const actor = { id: 'claude-desktop', name: 'claude-desktop', role: 'participant' as const };
  const waiting = f.store.airWait(actor, { handles: f.store.handleOf('j', root.id)!, wait_seconds: 10 });
  setTimeout(() => {
    f.finish(root.id, f.need('codex'));
    setTimeout(() => {
      const consult = f.job(root.id).options.next; f.finish(consult, 'LRU');
      setTimeout(() => f.finish(f.job(consult).options.next, f.done()), 50);
    }, 50);
  }, 50);
  const r = await waiting;
  assert.match(r.air, /^@air1 wait n=1 done=1\nJ j\d+ route=claude mode=advice st=completed by=agent-commons trig=resume verdict=ok/);
  assert.doesNotMatch(r.air, /timeout=1/);
});
