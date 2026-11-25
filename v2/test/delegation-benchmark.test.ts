import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runDelegationBenchmark } from '../scripts/delegation-benchmark.ts';

test('stub delegation benchmark compares identical inputs and reports failed acceptance', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-benchmark-test-'));
  t.after(() => fs.rmdirSync(root));
  const report = await runDelegationBenchmark(root, { omitStubEditFor: 'bug-fix', stubConflictFor: 'small-change' });
  assert.equal(report.kind, 'deterministic-stub');
  assert.equal(report.trials.length, 9);
  for (const id of ['small-change', 'bug-fix', 'split-change']) {
    const trials = report.trials.filter(trial => trial.fixture === id);
    assert.deepEqual(trials.map(trial => trial.mode), ['solo', 'review', 'split']);
    assert.equal(new Set(trials.map(trial => trial.revision)).size, 1);
    assert.ok(trials.every(trial => trial.accepted === (id !== 'bug-fix')));
    assert.ok(trials.every(trial => trial.tokens === null && trial.costUsd === null));
  }
  assert.equal(report.trials.find(trial => trial.fixture === 'split-change' && trial.mode === 'split')?.workers, 2);
  const reviewed = report.trials.find(trial => trial.fixture === 'small-change' && trial.mode === 'review')!;
  assert.equal(reviewed.rework, 1);
  assert.equal(reviewed.mergeConflicts, 1);
  assert.deepEqual(reviewed.issues, []);
  assert.deepEqual(fs.readdirSync(root), []);
});
