import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.ts';
import { startServer } from '../src/server.ts';
import { editDiff, worktreeGit } from '../src/adapters/shared.ts';
import { ensureTokenHome } from '../src/token-home.ts';
import { protectFixtureHome } from './fixtures/service.ts';

function workspace(t: TestContext) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-daybreak-'));
  const cleanups: Array<() => void | Promise<void>> = [() => fs.rmSync(base, { recursive: true, force: true })];
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });
  const home = path.join(base, 'data'), root = path.join(base, 'repo');
  fs.mkdirSync(root);
  return { base, home, root, after: (cleanup: () => void | Promise<void>) => cleanups.push(cleanup) };
}

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
