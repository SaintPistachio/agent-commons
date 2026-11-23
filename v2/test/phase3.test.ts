// Phase 3 (fabric Stage 3): worker context (ctx=), the AIR-T worker envelope (proto=air), output spill and edit diffs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store, CommonsError, type Actor } from './fixtures/service.ts';
import { Runner } from '../src/runner.ts';
import { AIR_WORKER_PRIMER } from '../src/air/primer.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const code = (fn: () => unknown) => { try { fn(); } catch (error) { return (error as CommonsError).code; } throw new Error('expected a failure'); };

function fixture(t: any) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-p3-'));
  const home = path.join(base, 'home'), repo = path.join(base, 'repo'), outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true }); fs.mkdirSync(path.join(repo, 'config')); fs.mkdirSync(outside);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { stdio: 'ignore' });
  fs.writeFileSync(path.join(repo, 'src', 'app.ts'), ['line 1', 'line 2', 'line 3', 'line 4', 'line 5'].join('\n') + '\n');
  fs.writeFileSync(path.join(repo, 'README.md'), 'repo\n');
  git('init', '-q'); git('add', '.'); git('commit', '-qm', 'one');
  fs.writeFileSync(path.join(repo, 'src', 'app.ts'), 'changed\n'); fs.writeFileSync(path.join(repo, '.env'), 'API_KEY=leak\n');
  git('add', '.'); git('commit', '-qm', 'two');
  fs.writeFileSync(path.join(repo, 'config', 'secret.json'), '{"k":1}'); fs.writeFileSync(path.join(repo, 'server.pem'), 'pem');
  fs.writeFileSync(path.join(repo, 'blob.bin'), Buffer.from([1, 0, 2, 3])); fs.writeFileSync(path.join(outside, 'private.txt'), 'outside the root');
  let junction = true;
  try { fs.symlinkSync(outside, path.join(repo, 'escape'), 'junction'); } catch { junction = false; }
  const store = new Store(home);
  const actor: Actor = store.createActor('claude-desktop', 'participant', 'claude-desktop').actor;
  const call = (method: string, input: Record<string, unknown> = {}) => store.call(actor, method, input);
  const project = call('project_create', { name: 'Repo', root: repo, operation_id: randomUUID() }).project;
  const runners: Runner[] = [];
  t.after(() => {
    for (const r of runners) r.stop();
    try { execFileSync('git', ['-C', repo, 'worktree', 'prune'], { stdio: 'ignore' }); } catch {}
    store.close(); fs.rmSync(base, { recursive: true, force: true });
  });
  const submit = (extra: Record<string, unknown>) => call('job_submit', { project_id: project.id, route: 'claude', prompt: 'Review it', operation_id: randomUUID(), ...extra }).job;
  const run = () => { const r = new Runner(store, home, { claude: { file: process.execPath, prefix: [FAKE] }, tickMs: 50 }); runners.push(r); r.start(); return r; };
  const until = async (id: string) => {
    for (let i = 0; i < 300; i++) { const job = call('job_status', { job_id: id, include_prompt: true }).job; if (['completed', 'failed', 'cancelled', 'needs_review'].includes(job.status)) return job; await sleep(50); }
    throw new Error('job did not finish');
  };
  const artifactText = (id: string) => call('artifact_read', { artifact_id: id }).content as string;
  const get = (handles: string, extra: Record<string, unknown> = {}) => call('air_get', { handles, ...extra }).air as string;
  return { base, home, repo, store, call, project, submit, run, until, artifactText, get, junction };
}

test('ctx= snapshots files, artifacts, tasks and diffs at submit time', t => {
  const f = fixture(t);
  const art = f.call('artifact_submit', { project_id: 'p1', name: 'notes', content: 'n1\nn2\nn3\n', operation_id: randomUUID() }).artifact;
  const task = f.call('task_create', { project_id: 'p1', title: 'Guard it', objective: 'Add the guard', acceptance: ['tests pass'], operation_id: randomUUID() }).task;
  const job = f.submit({ context_refs: ['file:src/app.ts', 'file:README.md:1-1', `art:${f.store.handleOf('a', art.id)}:2-3`, `task:${f.store.handleOf('t', task.id)}`, 'diff:HEAD~1..HEAD'] });
  assert.equal(job.options.ctx.length, 5);
  const text = f.artifactText(job.options.ctx_artifact);
  assert.match(text, /^@ctx file:src\/app\.ts lines=1-1 chars=\d+\nchanged\n@ctx end$/m);
  assert.match(text, /@ctx file:README\.md:1-1 lines=1-1 chars=\d+\nrepo\n@ctx end/);
  assert.match(text, /@ctx art:a\d+:2-3 lines=2-3 chars=\d+\nn2\nn3\n@ctx end/);
  assert.match(text, /@ctx task:t\d+ chars=\d+\nT t\d+ v=1 st=open obj="Add the guard" acc="tests pass" "Guard it"/);
  assert.match(text, /@ctx diff:HEAD~1\.\.HEAD chars=\d+\n[\s\S]*\+changed[\s\S]*@ctx end/);
  assert.doesNotMatch(text, /API_KEY|leak/, 'the diff leaves out secret-like files');
  assert.equal(job.options.ctx_chars, text.length);
});

test('ctx= refuses paths outside the root, secret-like and binary files, and bad refs', t => {
  const f = fixture(t);
  const refused = (ref: string, extra: Record<string, unknown> = {}) => code(() => f.submit({ context_refs: [ref], ...extra }));
  assert.equal(refused('file:../outside/private.txt'), 'CTX_OUTSIDE_ROOT');
  assert.equal(refused(`file:${path.join(f.base, 'outside', 'private.txt')}`), 'CTX_OUTSIDE_ROOT');
  if (f.junction) assert.equal(refused('file:escape/private.txt'), 'CTX_OUTSIDE_ROOT', 'a link out of the root is refused');
  for (const ref of ['file:.env', 'file:config/secret.json', 'file:server.pem', 'file:.git/config']) assert.equal(refused(ref), 'CTX_DENIED', ref);
  assert.equal(refused('file:blob.bin'), 'CTX_BINARY');
  assert.equal(refused('file:src/missing.ts'), 'CTX_NOT_FOUND');
  assert.equal(refused('file:src/app.ts:5-2'), 'CTX_BAD_REF');
  assert.equal(refused('diff:--output=x'), 'CTX_BAD_REF');
  assert.equal(refused('diff:nosuchbranch..HEAD'), 'CTX_BAD_REF');
  assert.equal(refused('web:https://example.invalid'), 'CTX_BAD_REF');
  assert.equal(refused('art:a99'), 'CTX_NOT_FOUND');
  assert.equal(refused('diff:HEAD~1..HEAD', { route: 'openai-api', max_cost_usd: '0.10', purpose: 'p', deliverable: 'd' }), 'CTX_NOT_ALLOWED', 'the paid route takes no diffs');
  assert.equal(code(() => f.submit({ context_refs: Array.from({ length: 21 }, () => 'file:README.md') })), 'INVALID_INPUT');
  fs.writeFileSync(path.join(f.repo, 'big.txt'), 'y'.repeat(150000));
  assert.equal(code(() => f.submit({ context_refs: ['file:big.txt'], prompt: 'z'.repeat(60000) })), 'PROMPT_TOO_LARGE');
  assert.equal(Number((f.store.db.prepare('SELECT count(*) n FROM jobs').get() as any).n), 0, 'refused jobs leave nothing behind');
});

test('the worker gets the primer, the context and the request; plain jobs get the prompt unchanged', async t => {
  const f = fixture(t);
  f.run();
  const air = await f.until(f.submit({ protocol: 'air', context_refs: ['file:README.md'], prompt: 'Summarize' }).id);
  assert.equal(air.status, 'completed', air.error);
  assert.ok(air.result.startsWith('echo: ' + AIR_WORKER_PRIMER.trim()), 'primer first');
  assert.match(air.result, /===DATA-([0-9a-f]{32})===\n@ctx file:README\.md lines=1-1 chars=\d+\nrepo\n@ctx end\n===END-DATA-\1===\n\n@request\nSummarize$/);
  const plain = await f.until(f.submit({ prompt: 'Just this' }).id);
  assert.equal(plain.result, 'echo: Just this');
});

test('proto=air checks the worker\'s @air1 block without applying it and keeps the raw answer', async t => {
  const f = fixture(t);
  f.run();
  const ok = await f.until(f.submit({ protocol: 'air', prompt: 'AIRBLOCK please' }).id);
  assert.equal(ok.status, 'completed');
  assert.deepEqual(ok.options.air, { ok: true, nodes: 2, verdict: 'chg', p: 0.8, summary: 'needs a guard' });
  assert.match(ok.result, /^Looked at it/, 'the raw answer is kept');
  assert.match(f.get(`j${(f.store.db.prepare('SELECT seq FROM jobs WHERE id=?').get(ok.id) as any).seq}`), / air=ok verdict=chg /);
  assert.equal(Number((f.store.db.prepare('SELECT count(*) n FROM checkpoints').get() as any).n), 0, 'the block is never applied');
  const bad = await f.until(f.submit({ protocol: 'air', prompt: 'AIRBAD please' }).id);
  assert.equal(bad.status, 'completed', 'a bad block never fails finished work');
  assert.deepEqual(bad.options.air, { ok: false, code: 'DISALLOWED_OP', line: 2 });
  const none = await f.until(f.submit({ protocol: 'air', prompt: 'USAGE only' }).id);  // answers "counted", with no block
  assert.equal(none.options.air.code, 'NO_BLOCK');
  // A git range goes unquoted in a packet (found live: ~ used to need quotes).
  const viaAir = f.call('air_tx', { project_id: 'p1', packet: '@air1\n#0 job route=claude proto=air ctx=file:README.md,diff:HEAD~1..HEAD,diff:HEAD^..HEAD "AIRBLOCK"', operation_id: randomUUID() });
  const viaAirJob = await f.until(viaAir.handles['0']);
  assert.equal(viaAirJob.options.air.verdict, 'chg'); assert.deepEqual(viaAirJob.options.ctx, ['file:README.md', 'diff:HEAD~1..HEAD', 'diff:HEAD^..HEAD']);
  assert.equal(code(() => f.call('air_tx', { project_id: 'p1', packet: '@air1\n#0 chk verdict=ok "x"', operation_id: randomUUID() })), 'UNKNOWN_FIELD', 'verdict= is for worker blocks only');
  assert.equal(code(() => f.submit({ protocol: 'xml' })), 'INVALID_INPUT');
});

test('output over 64 KB is kept in full as an artifact; the result keeps the head and the tail', async t => {
  const f = fixture(t);
  f.run();
  const job = await f.until(f.submit({ prompt: 'BIGOUT' }).id);
  assert.equal(job.status, 'completed');
  assert.ok(job.result.length < 64 * 1024, `result is ${job.result.length}`);
  assert.ok(job.result.startsWith('HEAD') && job.result.endsWith('TAIL'));
  assert.match(job.result, /full output: a\d+/);
  const full = f.artifactText(job.options.output_artifact);
  assert.equal(full.length, 100008); assert.ok(full.endsWith('TAIL'));
});

test('an edit job saves its diff, new files included, with a short stat', async t => {
  const f = fixture(t);
  f.run();
  const job = await f.until(f.submit({ mode: 'edit', prompt: 'EDIT something' }).id);
  assert.equal(job.status, 'completed', job.error);
  assert.equal(job.options.diff_stat, '+1 -0 (1f)');
  assert.match(f.artifactText(job.options.diff_artifact), /from-job\.txt[\s\S]*\+written by job/);
  assert.match(f.get(`j${(f.store.db.prepare('SELECT seq FROM jobs WHERE id=?').get(job.id) as any).seq}`), /diff=a\d+ stat="\+1 -0 \(1f\)"/);
  const advice = await f.until(f.submit({ prompt: 'nothing to edit' }).id);
  assert.equal(advice.options.diff_artifact, undefined, 'advice jobs have no diff');
});

test('air_wait on a task waits for every job of that task', async t => {
  const f = fixture(t);
  const task = f.call('task_create', { project_id: 'p1', title: 'Fan out', operation_id: randomUUID() }).task;
  f.submit({ task_id: task.id, prompt: 'DELAY a' }); f.submit({ task_id: task.id, prompt: 'DELAY b' });
  f.run();
  const r = await f.store.airWait({ id: 'claude-desktop', name: 'claude-desktop', role: 'participant' }, { handles: f.store.handleOf('t', task.id)!, wait_seconds: 20 });
  assert.match(r.air, /^@air1 wait n=2 done=2\nJ j\d+ .*st=completed[\s\S]*\nJ j\d+ .*st=completed/);
  const empty = f.call('task_create', { project_id: 'p1', title: 'No jobs', operation_id: randomUUID() }).task;
  assert.match((await f.store.airWait({ id: 'claude-desktop', name: 'claude-desktop', role: 'participant' }, { handles: f.store.handleOf('t', empty.id)!, wait_seconds: 1 })).air, /! t\d+ err=NO_JOBS/);
});
