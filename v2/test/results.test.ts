import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store, CommonsError } from './fixtures/service.ts';
import { startServer } from './fixtures/service.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const fullResult = () => 'Beginning "quoted" \\ text\r\n' + 'line: λ 🐈 "quoted" \\ literal\\n\n'.repeat(24000) + 'end without newline';

function fixture(t: any) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-results-'));
  const home = path.join(fixtureRoot, 'data');
  const repo = path.join(fixtureRoot, 'repo');
  fs.mkdirSync(repo);
  const store = new Store(home);
  t.after(() => {
    try { store.close(); } catch {}
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });
  const { actor, token } = store.createActor('results-user', 'participant', 'results-user');
  store.setActorTags(actor.id, 'anthropic', null);
  const call = (method: string, input: Record<string, unknown> = {}) => store.call(actor, method, input);
  call('project_create', { name: 'Results', root: repo, operation_id: randomUUID() });
  const submit = () => call('job_submit', {
    project_id: 'p1', route: 'claude', prompt: 'Produce a result', operation_id: randomUUID(),
  }).job;
  const raw = (handles: string, extra: Record<string, unknown> = {}) =>
    call('air_get', { handles, raw: true, ...extra });
  return { home, repo, store, actor, token, call, submit, raw };
}

test('raw inline job results are exact and retain the AIR reply', t => {
  const f = fixture(t);
  const job = f.submit();
  const content = '  "quotes" \\ path\r\nλ 🐈\nfinal line without newline';
  f.store.updateJob(job.id, { status: 'completed', result: content });
  const reply = f.raw(job.id, { grep: 'not present', max_chars: 1 });
  assert.match(reply.air, /^@air1 get n=1\nJ /);
  assert.equal(reply.raw.length, 1);
  assert.deepEqual(reply.raw[0], {
    handle: 'j1', id: job.id, kind: 'job', status: 'completed',
    content, complete: true, artifacts: [],
  });
  assert.equal(f.call('air_get', { handles: job.id }).raw, undefined);
});

test('raw spilled job results return the entire stored output', t => {
  const f = fixture(t);
  const job = f.submit(), content = fullResult();
  const saved = f.store.updateJob(job.id, { status: 'completed', result: content });
  assert.notEqual(saved.result, content);
  assert.match(saved.result, /characters omitted; full output: a\d+/);
  const entry = f.raw('j1').raw[0];
  assert.equal(entry.content, content);
  assert.equal(entry.complete, true);
  assert.equal(entry.reason, undefined);
  assert.equal(Buffer.byteLength(entry.content), Buffer.byteLength(content));
});

test('raw artifacts return all text without line selection, filtering, or caps', t => {
  const f = fixture(t);
  const content = 'first\r\n"quoted" \\ λ\nthird\n';
  const submitted = f.call('artifact_submit', {
    project_id: 'p1', name: 'notes.txt', kind: 'text', content, operation_id: randomUUID(),
  });
  const reply = f.raw(`${submitted.artifact.id}:2-2`, { grep: 'absent', max_chars: 20 });
  assert.deepEqual(reply.raw[0], {
    handle: 'a1', id: submitted.artifact.id, kind: 'artifact', content, complete: true,
  });
});

test('raw jobs list their produced artifacts with download metadata', t => {
  const f = fixture(t);
  const job = f.submit(), content = fullResult();
  f.store.updateJob(job.id, { status: 'completed', result: content });
  const entry = f.raw('j1').raw[0];
  assert.equal(entry.artifacts.length, 1);
  assert.deepEqual(entry.artifacts[0], {
    handle: 'a1', name: 'j1-output.txt', kind: 'job_output', bytes: Buffer.byteLength(content),
  });
  const artifact = f.raw(entry.artifacts[0].handle).raw[0];
  assert.equal(artifact.kind, 'artifact');
  assert.equal(artifact.content, content);
  assert.equal(artifact.complete, true);
});

test('raw air_get refuses more than ten handles', t => {
  const f = fixture(t);
  const job = f.submit();
  assert.throws(() => f.raw(Array(11).fill(job.id).join(',')), error =>
    error instanceof CommonsError && error.code === 'INVALID_INPUT');
  assert.equal(f.raw(Array(10).fill(job.id).join(',')).raw.length, 10);
});

test('missing stored artifact content is explicitly incomplete', t => {
  const f = fixture(t);
  const submitted = f.call('artifact_submit', {
    project_id: 'p1', name: 'missing.txt', content: 'stored text', operation_id: randomUUID(),
  });
  fs.unlinkSync(path.join(f.home, 'artifacts', submitted.artifact.sha256));
  const reply = f.raw(submitted.artifact.id);
  assert.equal(reply.raw.length, 1);
  assert.equal(reply.raw[0].complete, false);
  assert.equal(reply.raw[0].content, '');
  assert.match(reply.raw[0].reason, /unavailable/i);
  assert.match(reply.air, /CONTENT_MISSING/);
});

test('a spill larger than artifact storage is not advertised as complete', t => {
  const f = fixture(t);
  const job = f.submit();
  f.store.updateJob(job.id, { status: 'completed', result: 'x'.repeat(5 * 1024 * 1024) });
  const entry = f.raw('j1').raw[0];
  assert.equal(entry.complete, false);
  assert.match(entry.reason, /stored artifact/i);
});

test('air-result writes exact workspace files, protects existing files, and downloads artifacts', async t => {
  const f = fixture(t);
  const inline = f.submit(), inlineContent = '"quoted" \\ path\r\nλ 🐈\nno final newline';
  f.store.updateJob(inline.id, { status: 'completed', result: inlineContent });
  const spilled = f.submit(), spilledContent = fullResult();
  f.store.updateJob(spilled.id, { status: 'completed', result: spilledContent });
  const artifact = f.raw(spilled.id).raw[0].artifacts[0];
  f.store.close();

  const running = await startServer(f.home, 0, false);
  try {
    const connection = path.join(f.home, 'connection.json');
    fs.writeFileSync(connection, JSON.stringify({
      url: running.url, token: f.token, actorId: f.actor.id, toolProfile: 'air',
    }));
    const workspace = path.join(f.home, 'caller-workspace');
    fs.mkdirSync(workspace);
    const cli = (...args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
      // The service runs in this process, so the child must be asynchronous.
      execFile(process.execPath, [
        '--disable-warning=ExperimentalWarning', CLI, 'air-result',
        ...args, '--connection', connection,
      ], { cwd: workspace, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
        resolve({ code: error ? Number(error.code) || 1 : 0, stdout, stderr });
      });
    });

    const stdout = await cli('--handles', inline.id);
    assert.equal(stdout.code, 0, stdout.stdout + stdout.stderr);
    assert.equal(stdout.stdout, inlineContent);

    const first = await cli('--handles', inline.id, '--out', 'answer.txt');
    assert.equal(first.code, 0, first.stdout + first.stderr);
    assert.equal(fs.readFileSync(path.join(workspace, 'answer.txt'), 'utf8'), inlineContent);
    assert.match(first.stdout, new RegExp(` ${Buffer.byteLength(inlineContent)} bytes\\n$`));
    assert.equal(first.stdout.trim().split('\n').length, 1);

    fs.writeFileSync(path.join(workspace, 'answer.txt'), 'do not overwrite');
    const refused = await cli('--handles', inline.id, '--out', 'answer.txt');
    assert.equal(refused.code, 1);
    assert.match(refused.stdout, /^@air1 err .*FILE_EXISTS/);
    assert.equal(fs.readFileSync(path.join(workspace, 'answer.txt'), 'utf8'), 'do not overwrite');

    const forced = await cli('--handles', inline.id, '--out', 'answer.txt', '--force');
    assert.equal(forced.code, 0, forced.stdout + forced.stderr);
    assert.equal(fs.readFileSync(path.join(workspace, 'answer.txt'), 'utf8'), inlineContent);

    const directory = await cli('--handles', spilled.id, '--out-dir', 'results', '--artifacts');
    assert.equal(directory.code, 0, directory.stdout + directory.stderr);
    assert.equal(fs.readFileSync(path.join(workspace, 'results', 'j2.txt'), 'utf8'), spilledContent);
    assert.equal(fs.readFileSync(path.join(workspace, 'results', artifact.name), 'utf8'), spilledContent);
    assert.equal(directory.stdout.trim().split('\n').length, 2);
    for (const line of directory.stdout.trim().split('\n')) {
      assert.match(line, new RegExp(` ${Buffer.byteLength(spilledContent)} bytes$`));
    }

    const directoryRefused = await cli('--handles', spilled.id, '--out-dir', 'results', '--artifacts');
    assert.equal(directoryRefused.code, 1);
    assert.match(directoryRefused.stdout, /^@air1 err .*FILE_EXISTS/);
    assert.equal(fs.readFileSync(path.join(workspace, 'results', artifact.name), 'utf8'), spilledContent);
    assert.deepEqual(fs.readdirSync(workspace).sort(), ['answer.txt', 'results']);
  } finally {
    await running.close();
  }
});
