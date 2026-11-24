import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Runner } from '../src/runner.ts';
import { Store } from '../src/store.ts';
import { startServer } from '../src/server.ts';
import { claudeArgs } from '../src/adapters/claude.ts';
import { adapter } from '../src/adapters/registry.ts';
import { editDiff, worktreeGit } from '../src/adapters/shared.ts';
import { ensureTokenHome } from '../src/token-home.ts';
import { WORKER_POLICY_FILE } from '../src/worker-policy.ts';
import { protectFixtureHome } from './fixtures/service.ts';

function workspace(t: TestContext) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-daybreak-'));
  const cleanups: Array<() => void | Promise<void>> = [() => fs.rmSync(base, { recursive: true, force: true })];
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });
  const home = path.join(base, 'data'), root = path.join(base, 'repo');
  fs.mkdirSync(root);
  return { base, home, root, after: (cleanup: () => void | Promise<void>) => cleanups.push(cleanup) };
}

test('the production worker gate blocks direct, automatic and previously queued native jobs', t => {
  const { home, root, after } = workspace(t);
  const store = new Store(home);
  after(() => store.close());
  const operator = store.createActor('operator', 'operator').actor;
  const participant = store.createActor('participant', 'participant').actor;
  const project = store.call(operator, 'project_create', { name: 'Repository', root, operation_id: randomUUID() }).project;
  const submit = (route: string, extra = {}) => store.call(participant, 'job_submit', {
    route, project_id: project.id, prompt: 'Summarize the project.', operation_id: randomUUID(), ...extra,
  });
  for (const route of ['claude', 'codex', 'ag']) {
    assert.throws(() => submit(route), { code: 'WORKER_ROUTE_GATED' });
  }
  assert.throws(() => submit('auto'), { code: 'NO_ELIGIBLE_ROUTE' });
  assert.throws(() => submit('api', { tools: 'custom' }), { code: 'WORKER_TOOLSET_GATED' });
  const room = store.call(participant, 'air_tx', {
    project_id: project.id, packet: '@air1\n#0 ropen subj="Review" seats=claude,codex "Review the project"', operation_id: randomUUID(),
  });
  assert.throws(() => store.call(participant, 'air_tx', {
    project_id: project.id, packet: `@air1\n#0 rstep g=${room.handles['0']} "Review it"`, operation_id: randomUUID(),
  }), { code: 'ROOM_SEATS_UNAVAILABLE' });
  const id = randomUUID();
  store.db.prepare(`INSERT INTO jobs(id,project_id,route,mode,prompt,timeout_ms,status,created_by,created_at)
    VALUES(?,?, 'claude','advice','legacy job',1000,'queued',?,?)`).run(id, project.id, participant.id, new Date().toISOString());
  new Runner(store, home).tick();
  assert.equal(store.jobRecord(id)?.status, 'failed');
  assert.equal(store.jobRecord(id)?.error, 'WORKER_ROUTE_GATED');
  assert.equal(store.jobRecord(id)?.pid, null);
  assert.equal(fs.existsSync(path.join(home, 'jobs', id)), false);
});

test('only operators approve rooted projects and a redirected root must be reapproved', async t => {
  const { base, home, root, after } = workspace(t);
  protectFixtureHome(home);
  const running = await startServer(home, 0, false);
  after(() => running.close());
  const store = running.store;
  const operator = store.createActor('operator', 'operator');
  const participant = store.createActor('participant', 'participant');
  const request = (token: string, method: string, input: object) => fetch(`${running.url}/api/v1/call`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, input: { ...input, operation_id: randomUUID() } }),
  });
  const denied = await request(participant.token, 'project_create', { name: 'Denied', root });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error.code, 'OPERATOR_REQUIRED');
  const unsafe = await request(operator.token, 'project_create', { name: 'Data parent', root: base });
  assert.equal((await unsafe.json()).error.code, 'PROJECT_ROOT_INVALID');
  const project = store.call(operator.actor, 'project_create', { name: 'Repository', root, operation_id: randomUUID() }).project;
  // A pre-upgrade project row carries a path but no operator approval.
  store.db.prepare('UPDATE projects SET approved_root=NULL WHERE id=?').run(project.id);
  assert.equal(store.call(participant.actor, 'project_status', { project_id: project.id }).project.root, fs.realpathSync(root));
  assert.throws(() => store.approvedProjectRoot(project.id), { code: 'PROJECT_ROOT_UNAPPROVED' });
  assert.throws(() => store.approveProjectRoot(participant.actor, project.id, root), { code: 'OPERATOR_REQUIRED' });
  store.approveProjectRoot(operator.actor, project.id, root);
  assert.equal(store.approvedProjectRoot(project.id), fs.realpathSync(root));
  const renamed = path.join(base, 'renamed');
  fs.renameSync(root, renamed);
  fs.symlinkSync(renamed, root, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => store.approvedProjectRoot(project.id), { code: 'PROJECT_ROOT_CHANGED' });
});

test('a schema upgrade preserves project history and leaves legacy roots unapproved', t => {
  const { home, root, after } = workspace(t);
  const store = new Store(home);
  const operator = store.createActor('operator', 'operator').actor;
  const project = store.call(operator, 'project_create', { root, name: 'Legacy project', operation_id: randomUUID() }).project;
  store.call(operator, 'task_create', { project_id: project.id, title: 'Retained task', operation_id: randomUUID() });
  store.db.exec('ALTER TABLE projects DROP COLUMN approved_root; ALTER TABLE projects DROP COLUMN approved_git_dir; PRAGMA user_version=24');
  store.close();
  const upgraded = new Store(home);
  after(() => upgraded.close());
  assert.equal(upgraded.call(operator, 'project_resume', { project_id: project.id }).active_tasks[0].title, 'Retained task');
  assert.throws(() => upgraded.approvedProjectRoot(project.id), { code: 'PROJECT_ROOT_UNAPPROVED' });
  upgraded.approveProjectRoot(operator, project.id, root);
  assert.equal(upgraded.approvedProjectRoot(project.id), fs.realpathSync(root));
});

test('the worktree Git path leaves repository hooks and external filters disabled', t => {
  const { base, root } = workspace(t);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  fs.writeFileSync(path.join(root, '.gitattributes'), 'note.txt filter=fixture\n');
  fs.writeFileSync(path.join(root, 'note.txt'), 'original\n');
  fs.mkdirSync(path.join(root, 'hooks'));
  fs.writeFileSync(path.join(root, 'hooks', 'post-checkout'), '#!/bin/sh\nprintf test > hook-marker\n', { mode: 0o755 });
  git('add', '.');
  git('commit', '-qm', 'fixture');
  const head = git('rev-parse', 'HEAD');
  const subfolder = path.join(root, 'subfolder');
  fs.mkdirSync(subfolder);
  const store = new Store(path.join(base, 'data'));
  try {
    const operator = store.createActor('operator', 'operator').actor;
    const project = store.call(operator, 'project_create', { name: 'Subfolder', root: subfolder, operation_id: randomUUID() }).project;
    assert.throws(() => store.assertJobRepository(project.id, subfolder), { code: 'PROJECT_REPOSITORY_UNAPPROVED' });
  } finally { store.close(); }
  git('config', 'core.hooksPath', 'hooks');
  git('config', 'filter.fixture.smudge', 'tee filter-marker');
  git('config', 'filter.fixture.clean', 'tee clean-marker');
  git('config', 'filter.fixture.required', 'true');
  const checkout = path.join(base, 'checkout');
  worktreeGit(root, ['worktree', 'add', '--no-checkout', '--no-track', '-b', 'fixture/job', checkout, head]);
  const gitDir = worktreeGit(checkout, ['rev-parse', '--absolute-git-dir']);
  worktreeGit(checkout, ['reset', '--hard', '--no-recurse-submodules', head], gitDir);
  assert.equal(worktreeGit(checkout, ['rev-parse', 'HEAD'], gitDir), head);
  fs.writeFileSync(path.join(checkout, 'note.txt'), 'changed\n');
  assert.match(editDiff(checkout, head, gitDir)?.patch ?? '', /\+changed/);
  for (const folder of [root, checkout]) {
    for (const name of ['hook-marker', 'filter-marker', 'clean-marker']) assert.equal(fs.existsSync(path.join(folder, name)), false);
  }
});

test('Windows verifies bearer storage before writing tokens or starting the service', { skip: process.platform !== 'win32' }, async t => {
  const { home } = workspace(t);
  ensureTokenHome(home, true);
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const run = (...args: string[]) => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli, ...args, '--home', home], { encoding: 'utf8' });
  run('init');
  const connections = path.join(home, 'connections');
  execFileSync('icacls.exe', [connections, '/grant', '*S-1-5-32-545:(OI)(CI)RX'], { windowsHide: true });
  assert.throws(() => run('add-client', '--name', 'blocked'), /AC_HOME_NOT_PRIVATE/);
  await assert.rejects(startServer(home, 0, false), /AC_HOME_NOT_PRIVATE/);
  assert.equal(fs.existsSync(path.join(connections, 'blocked.json')), false);
  assert.equal(fs.existsSync(path.join(home, 'runtime.json')), false);
  protectFixtureHome(home);
  const runtime = await startServer(home, 0, false);
  try {
    run('rotate-client', '--name', 'local-operator');
    ensureTokenHome(home);
    for (const file of [path.join(connections, 'operator.json'), path.join(home, 'runtime.json')]) {
      const acl = execFileSync('icacls.exe', [file], { encoding: 'utf8' });
      assert.doesNotMatch(acl, /BUILTIN\\Users|S-1-5-32-545/i);
    }
  } finally { await runtime.close(); }
});

test('operator worker-policy.json enables local CLI routes, rejects malformed policy, and resets to fail-closed', t => {
  const { home, root } = workspace(t);
  protectFixtureHome(home);
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const run = (...args: string[]) => JSON.parse(execFileSync(process.execPath,
    ['--disable-warning=ExperimentalWarning', cli, ...args, '--home', home], { encoding: 'utf8' }));

  const initial = new Store(home);
  const operator = initial.createActor('operator', 'operator').actor;
  const participant = initial.createActor('participant', 'participant').actor;
  const project = initial.call(operator, 'project_create', { name: 'Local', root, operation_id: randomUUID() }).project;
  for (const id of ['claude', 'codex', 'antigravity']) initial.recordProbe(adapter(id)!.capabilities, { state: 'verified', cliVersion: '1.0' });
  assert.throws(() => initial.call(participant, 'job_submit', {
    route: 'claude', project_id: project.id, prompt: 'Blocked before opt-in.', operation_id: randomUUID(),
  }), { code: 'WORKER_ROUTE_GATED' });
  initial.close();

  const enabled = run('worker-policy', '--allow-local-cli');
  assert.equal(enabled.source, 'local-file');
  assert.deepEqual(enabled.config, {
    schemaVersion: 1,
    allowRoutes: ['claude', 'codex', 'antigravity'],
    allowNativeEdit: true,
    allowApprovedToolsets: true,
  });
  ensureTokenHome(home);
  if (process.platform === 'win32') {
    const acl = execFileSync('icacls.exe', [path.join(home, WORKER_POLICY_FILE)], { encoding: 'utf8' });
    assert.doesNotMatch(acl, /BUILTIN\\Users|S-1-5-32-545/i);
  }
  assert.equal(run('worker-policy').source, 'local-file');

  const optedIn = new Store(home);
  try {
    for (const route of ['claude', 'codex', 'ag', 'auto']) {
      const submitted = optedIn.call(participant, 'job_submit', {
        route, project_id: project.id, prompt: 'Allowed after local opt-in.', operation_id: randomUUID(),
      }).job;
      assert.ok(submitted.id);
    }
    const editJob = optedIn.call(participant, 'job_submit', {
      route: 'claude', mode: 'edit', project_id: project.id, prompt: 'Edit allowed with local opt-in.', operation_id: randomUUID(),
    }).job;
    assert.equal(editJob.mode, 'edit');
    const room = optedIn.call(participant, 'air_tx', {
      project_id: project.id,
      packet: '@air1\n#0 ropen subj="Local room" seats=claude,codex "Review"\n#1 rstep g=#0 "Run round 1"',
      operation_id: randomUUID(),
    });
    assert.match(room.handles['1'], /^g1@r1\(/);
  } finally { optedIn.close(); }

  const policyFile = path.join(home, WORKER_POLICY_FILE);
  for (const invalid of ['{', JSON.stringify({ schemaVersion: 1, allowRoutes: ['unknown'] }), JSON.stringify({ schemaVersion: 1, allowRoutes: [], extra: true })]) {
    fs.writeFileSync(policyFile, invalid, 'utf8');
    assert.throws(() => new Store(home), { code: 'WORKER_POLICY_INVALID' });
  }
  fs.writeFileSync(policyFile, '{', 'utf8');
  const statusOut = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli, 'status', '--home', home], { encoding: 'utf8' });
  assert.match(statusOut, /worker policy \(on disk\): INVALID/);

  const restricted = run('worker-policy', '--allow-local-cli', '--routes', 'claude,codex', '--no-native-edit');
  assert.equal(restricted.source, 'local-file');
  assert.deepEqual(restricted.config, {
    schemaVersion: 1,
    allowRoutes: ['claude', 'codex'],
    allowNativeEdit: false,
    allowApprovedToolsets: true,
  });
  const narrowed = new Store(home);
  try {
    narrowed.db.prepare("DELETE FROM jobs").run();
    assert.equal(narrowed.call(participant, 'route_hints', { mode: 'advice' }).air, 'claude,codex');
    assert.equal(narrowed.call(participant, 'route_hints', { mode: 'edit' }).air, '');
    assert.throws(() => narrowed.call(participant, 'job_submit', {
      route: 'claude', mode: 'edit', project_id: project.id, prompt: 'Blocked when native edit is off.', operation_id: randomUUID(),
    }), { code: 'WORKER_MODE_GATED' });
  } finally { narrowed.close(); }

  const reset = run('worker-policy', '--reset');
  assert.equal(reset.source, 'default');
  assert.equal(reset.removed, true);
  assert.match(reset.note, /restart/i);
  assert.equal(fs.existsSync(policyFile), false);

  const restored = new Store(home);
  try {
    assert.throws(() => restored.call(participant, 'job_submit', {
      route: 'claude', project_id: project.id, prompt: 'Blocked again after reset.', operation_id: randomUUID(),
    }), { code: 'WORKER_ROUTE_GATED' });
  } finally { restored.close(); }
});

test('Claude advice mode restricts built-in tools and disallows Bash and file-writing tools while edit mode keeps them', () => {
  const adviceArgs = claudeArgs({ file: 'claude' }, { mode: 'advice', model: 'sonnet', effort: 'medium', options: {} });
  const toolsStart = adviceArgs.indexOf('--tools');
  assert.notEqual(toolsStart, -1);
  assert.deepEqual(adviceArgs.slice(toolsStart, toolsStart + 2), ['--tools', 'Read,Grep,Glob']);
  const disallowedStart = adviceArgs.indexOf('--disallowedTools');
  assert.notEqual(disallowedStart, -1);
  assert.deepEqual(adviceArgs.slice(disallowedStart, disallowedStart + 6), ['--disallowedTools', 'Bash', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

  const editArgs = claudeArgs({ file: 'claude' }, { mode: 'edit', model: 'sonnet', effort: 'medium', options: {} });
  assert.equal(editArgs.includes('--tools'), false);
  assert.equal(editArgs.includes('--disallowedTools'), false);
});
