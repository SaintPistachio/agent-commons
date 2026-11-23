import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Runner } from '../src/runner.ts';
import { Store, type Json } from '../src/store.ts';
import { patchCheckArgs, resolvePatchCheck, runPatchCheck } from '../src/patch-check.ts';
import type { RunnerOptions } from '../src/adapters/types.ts';
import { patchWorktreeExecutables } from '../src/adapters/shared.ts';
import { turnRequestId } from '../src/adapters/openai-api-tools.ts';

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-patch-edit-'));
  const repo = path.join(root, 'repo'), home = path.join(root, 'home'), helper = path.join(root, 'helper');
  for (const folder of [repo, home, helper]) fs.mkdirSync(folder);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(repo, 'README.md'), 'committed original\n');
  const commit = () => { git('add', 'README.md'); git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'); };
  commit();
  const base = git('rev-parse', 'HEAD');
  const store = new Store(home);
  const actor = store.createActor('patch-fixture', 'participant', 'patch-fixture').actor;
  const call = (method: string, fields: Json) => store.call(actor, method, { operation_id: randomUUID(), ...fields });
  const project = call('project_create', { name: 'Patch fixture', root: repo }).project;
  const checkConfig = (protected_paths: string[] = ['package.json']) => fs.writeFileSync(path.join(home, 'patch-checks.json'), JSON.stringify({
    docker: process.execPath, projects: [{ root: repo, checks: { verify: { image: `example/check@sha256:${'a'.repeat(64)}`,
      argv: ['node', '--test'], timeout_seconds: 10, protected_paths, share_failure_output: true } } }],
  }));
  checkConfig();
  const checkCalls: string[] = [];
  const fake = (name: string, cwd?: string) => ({ file: process.execPath, prefix: [fileURLToPath(new URL(`./fixtures/fake-${name}.mjs`, import.meta.url))], cwd });
  const makeRunner = (patchCheck: RunnerOptions['patchCheck'] = {
    preflight() {}, run: async (_check, cwd) => {
      const text = fs.readFileSync(path.join(cwd, 'README.md'), 'utf8').trim();
      checkCalls.push(text);
      return { exitCode: text === 'verified answer' ? 0 : 1, output: 'approved-check-failure-marker' };
    },
  }) => {
    const runner = new Runner(store, home, { tickMs: 20, patchCheck, claude: fake('claude'), codex: fake('codex'),
      antigravity: fake('antigravity'), openaiHelper: fake('openai-helper', helper) });
    t.after(() => runner.stop());
    return runner;
  };
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const submit = (route: string, fields: Json = {}) => call('job_submit', { project_id: project.id, route, mode: 'edit', check: 'verify',
    prompt: 'PATCH-EDIT-FIXTURE update the answer', context_refs: ['file:README.md'],
    ...(route === 'openai-api' ? { max_cost_usd: '0.050000', purpose: 'Verify patch editing', deliverable: 'Verified patch' } : {}), ...fields }).job;
  const untilDone = async (id: string) => {
    for (let n = 0; n < 300; n++) {
      const job = store.jobRecord(id)!;
      if (!['queued', 'running'].includes(job.status)) return job;
      await wait(25);
    }
    throw new Error(`fixture job stuck: ${JSON.stringify(store.jobRecord(id)?.options?.patch_state)}`);
  };
  return { store, base, git, commit, repo, home, helper, project, call, checkConfig, checkCalls, makeRunner, submit, untilDone };
}

test('all four adapters revise a patch against refreshed context, with the main checkout untouched', async t => {
  const f = fixture(t);
  const jobs = ['claude', 'codex', 'antigravity', 'openai-api'].map(route => f.submit(route, { intent: 'edit' }));
  fs.writeFileSync(path.join(f.repo, 'README.md'), 'new branch revision\n');
  f.commit();
  fs.writeFileSync(path.join(f.repo, 'README.md'), 'uncommitted user work\n');
  const runner = f.makeRunner(); runner.start();
  try {
    const completed = await Promise.all(jobs.map(job => f.untilDone(job.id)));
    for (const job of completed) {
      assert.equal(job.status, 'completed', `${job.route}: ${job.error}`);
      assert.equal(job.base_revision, f.base);
      assert.equal(job.turns, 2);
      assert.deepEqual(job.options.patch_attempts.map((a: Json) => a.check.exit_code), [1, 0]);
      assert.deepEqual(job.changed_files, ['README.md']);
      assert.match(f.store.artifactContent(job.options.diff_artifact)!, /\+verified answer/);
      assert.match(f.store.artifactContent(job.options.patch_contexts[1])!, /@ctx file:README\.md[^\n]*\n.*draft answer/);
      assert.equal(fs.readFileSync(path.join(job.workdir, 'README.md'), 'utf8'), 'verified answer\n');
    }
    assert.equal(fs.readFileSync(path.join(f.repo, 'README.md'), 'utf8'), 'uncommitted user work\n');
    assert.equal(f.checkCalls.length, 8);
    const paid = completed.find(job => job.route === 'openai-api')!;
    const requests = fs.readFileSync(path.join(f.helper, 'calls.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
      .filter(row => row.command === 'invoke').map(row => row.request);
    assert.deepEqual(requests.map(req => req.external_request_id), [turnRequestId(paid.id, 1), turnRequestId(paid.id, 2)]);
    assert.deepEqual(requests.map(req => req.max_cost_usd), ['0.050000', '0.039999']);
    assert.equal(paid.cost_usd, '0.020000250');
    assert.equal(paid.tokens_in, 42);
  } finally { runner.stop(); }
});

test('AIR job requires an approved name and blocks a traversal patch before running the check', async t => {
  const f = fixture(t);
  assert.throws(() => f.submit('antigravity', { check: 'unknown' }), /PATCH_CHECK_NOT_APPROVED|not approved/);
  assert.throws(() => f.submit('claude', { shell: true }), /shell and tool sets/);
  assert.throws(() => f.submit('claude', { context_refs: ['file:missing.txt'] }), /CTX_NOT_FOUND|not found/i);
  fs.mkdirSync(path.join(f.repo, 'subdir'));
  assert.throws(() => f.submit('claude', { cwd: 'subdir' }), /select the registered repository root/);
  const reply = f.call('air_tx', { project_id: f.project.id,
    packet: '@air1\n#0 job route=antigravity mode=edit check=verify "PATCH-EDIT-FIXTURE PATCH-ESCAPE-FIXTURE"' });
  const handle = JSON.stringify(reply).match(/#0=(j\d+)/)?.[1];
  assert(handle, JSON.stringify(reply));
  const job = f.call('job_status', { job_id: handle }).job;
  const runner = f.makeRunner(); runner.start();
  try {
    const done = await f.untilDone(job.id);
    assert.equal(done.status, 'failed');
    assert.match(done.error, /PATCH_EDIT_REJECTED/);
    assert.equal(f.checkCalls.length, 0);
    assert.equal(fs.readFileSync(path.join(done.workdir, 'README.md'), 'utf8'), 'committed original\n');
  } finally { runner.stop(); }
});

test('a paid provider outcome with unknown spend never starts another turn or applies a patch', async t => {
  const f = fixture(t);
  const job = f.submit('openai-api', { prompt: 'PATCH-EDIT-FIXTURE PATCH-UNCERTAIN-FIXTURE' });
  const runner = f.makeRunner(); runner.start();
  try {
    const done = await f.untilDone(job.id);
    assert.equal(done.status, 'needs_review');
    assert.equal(done.error, 'PATCH_EDIT_UNKNOWN_SPEND');
    assert.equal(done.turns, 1);
    assert.equal(f.checkCalls.length, 0);
    assert.equal(fs.readFileSync(path.join(done.workdir, 'README.md'), 'utf8'), 'committed original\n');
  } finally { runner.stop(); }
});

test('approved Docker checks use fixed arguments and a read-only source mount with no network', t => {
  const f = fixture(t);
  const check = resolvePatchCheck(f.home, f.repo, 'verify');
  const source = path.join(f.home, 'source');
  const args = patchCheckArgs(check, source, 'ac-check-test');
  for (const expected of ['--pull', 'never', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--user', '65534:65534'])
    assert(args.includes(expected), expected);
  assert(args.includes(`type=bind,source=${source},target=/input,readonly`));
  assert(!args.includes('--privileged'));
  assert.deepEqual(args.slice(-2), ['node', '--test']);
});

test('patch edits preserve CRLF in a checkout and reject edits to protected check inputs', async t => {
  const f = fixture(t);
  f.git('config', 'core.autocrlf', 'true');
  const job = f.submit('claude');
  const runner = f.makeRunner(); runner.start();
  try {
    const done = await f.untilDone(job.id);
    assert.equal(done.status, 'completed', done.error);
    assert.equal(fs.readFileSync(path.join(done.workdir, 'README.md'), 'utf8'), 'verified answer\r\n');
    f.checkConfig(['README.md']);
    const protectedJob = await f.untilDone(f.submit('claude').id);
    assert.equal(protectedJob.error, 'PATCH_EDIT_PROTECTED_CHECK_PATH');
    assert.equal(f.checkCalls.length, 2);
    assert.equal(fs.readFileSync(path.join(protectedJob.workdir, 'README.md'), 'utf8'), 'committed original\r\n');
  } finally { runner.stop(); }
});

test('an unavailable sandbox fails before provider submission or worktree creation', async t => {
  const f = fixture(t);
  const job = f.submit('openai-api');
  const runner = f.makeRunner({
    preflight() { throw new Error('approved Linux check image is unavailable locally'); },
    async run() { throw new Error('check should not run'); },
  });
  runner.start();
  try {
    const done = await f.untilDone(job.id);
    assert.equal(done.status, 'failed');
    assert.match(done.error, /approved Linux check image is unavailable locally/);
    assert.equal(done.workdir, null);
    assert(!fs.existsSync(path.join(f.helper, 'calls.log')));
  } finally { runner.stop(); }
});

test('revision context represents each modified file even when the first patch block is large', async t => {
  const f = fixture(t);
  const job = f.submit('antigravity', { context_refs: [], prompt: 'PATCH-EDIT-FIXTURE PATCH-EXCERPTS-FIXTURE' });
  const runner = f.makeRunner({ preflight() {}, async run(_check, cwd) {
    const current = fs.readFileSync(path.join(cwd, 'later.txt'), 'utf8');
    return { exitCode: current === 'later verified\n' ? 0 : 1, output: 'approved-check-failure-marker' };
  } });
  runner.start();
  try {
    const done = await f.untilDone(job.id);
    assert.equal(done.status, 'completed', done.error);
    const context = f.store.artifactContent(done.options.patch_contexts[0])!;
    assert.match(context, /first\.txt\nx/);
    assert.match(context, /later\.txt\nlater draft/);
    assert.equal(fs.readFileSync(path.join(done.workdir, 'later.txt'), 'utf8'), 'later verified\n');
  } finally { runner.stop(); }
});

test('the check snapshot honors cancellation and a missing Docker executable settles', async t => {
  const f = fixture(t);
  const check = { ...resolvePatchCheck(f.home, f.repo, 'verify'), docker: path.join(f.home, 'missing-docker.exe') };
  const cancellation = new AbortController();
  cancellation.abort();
  const cancelled = await runPatchCheck(check, f.repo, path.join(f.home, 'cancelled-check'), 'ac-check-cancelled', 5000,
    () => assert.fail('cancelled snapshot must not launch'), cancellation.signal);
  assert.equal(cancelled.error, 'PATCH_CHECK_INTERRUPTED');
  fs.writeFileSync(path.join(f.repo, 'verify.sh'), '#!/bin/sh\nexit 0\n');
  f.git('update-index', '--add', '--chmod=+x', 'verify.sh');
  const executablePaths = patchWorktreeExecutables(f.repo, undefined, f.home);
  assert.deepEqual(executablePaths, ['verify.sh']);
  const dir = path.join(f.home, 'missing-check');
  const unavailable = await runPatchCheck(check, f.repo, dir, 'ac-check-missing', 5000, () => {}, undefined, executablePaths);
  assert.equal(unavailable.error, 'PATCH_CHECK_UNAVAILABLE');
  assert(!fs.existsSync(path.join(dir, 'source')));
  const manifest = path.join(dir, 'executable-paths');
  assert.equal(fs.readFileSync(manifest, 'utf8'), './verify.sh\0');
  assert(patchCheckArgs(check, path.join(dir, 'source'), 'ac-check-test', manifest)
    .includes(`type=bind,source=${manifest},target=/ac-executable-paths,readonly`));
});
