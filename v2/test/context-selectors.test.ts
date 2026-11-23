import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { buildContext, resolveContextRoot } from '../src/context.ts';
import { Store } from '../src/store.ts';

const absent = () => undefined;

test('context paths use the selected directory of a registered linked worktree', () => {
  const temp = fs.mkdtempSync(path.join(tmpdir(), 'ac-context-'));
  try {
    const root = path.join(temp, 'main');
    const linked = path.join(temp, 'linked checkout');
    fs.mkdirSync(root);
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
    git('init');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'initial');
    git('worktree', 'add', '--detach', linked, 'HEAD');

    const cwd = path.join(linked, 'src');
    fs.mkdirSync(cwd);
    fs.writeFileSync(path.join(cwd, 'sample.txt'), 'linked content\n');
    const selected = resolveContextRoot(root, cwd);
    assert.equal(selected, fs.realpathSync(cwd));
    assert.equal(
      buildContext(['file:sample.txt'], { root: selected, artifact: absent, task: absent }),
      '@ctx file:sample.txt lines=1-1 chars=14\nlinked content\n@ctx end',
    );
    assert.throws(() => resolveContextRoot(root, temp), { code: 'CTX_OUTSIDE_ROOT' });
    assert.throws(() => resolveContextRoot(root, cwd, [linked]), { code: 'CTX_DENIED' });
  } finally {
    fs.rmSync(temp, { force: true, recursive: true });
  }
});

test('job context uses the full spilled output and does not read foreign jobs’ artifacts', () => {
  const jobs = new Map([
    ['j1', { project_id: 'p1', result: 'inline output' }],
    ['j2', { project_id: 'p1', result: 'preview', options: { output_artifact: 'full' } }],
    ['j3', { project_id: 'p2', result: 'foreign preview', options: { output_artifact: 'foreign' } }],
  ]);
  const reads: string[] = [];
  const store = Object.assign(Object.create(Store.prototype) as {
    projectJobText(projectId: string, ref: string): string | undefined;
  }, {
    resolveId: (_kind: string, ref: string) => ref,
    jobRecord: (id: string) => jobs.get(id),
    projectArtifactText: (projectId: string, ref: string) => {
      reads.push(`${projectId}:${ref}`);
      return ref === 'full' ? 'first\nsecond\nthird\n' : undefined;
    },
  });
  const sources = {
    root: '.',
    artifact: absent,
    task: absent,
    job: (ref: string) => store.projectJobText('p1', ref),
  };
  assert.equal(buildContext(['job:j1'], sources), '@ctx job:j1 chars=13\ninline output\n@ctx end');
  assert.equal(buildContext(['job:j2'], sources), '@ctx job:j2 chars=19\nfirst\nsecond\nthird\n\n@ctx end');
  assert.equal(buildContext(['job:j2:2-3'], sources), '@ctx job:j2:2-3 lines=2-3 chars=12\nsecond\nthird\n@ctx end');
  assert.throws(() => buildContext(['job:j3'], sources), { code: 'CTX_NOT_FOUND' });
  assert.throws(() => buildContext(['job:j9'], sources), { code: 'CTX_NOT_FOUND' });
  assert.deepEqual(reads, ['p1:full', 'p1:full']);
});
