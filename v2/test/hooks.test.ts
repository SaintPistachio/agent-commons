// Phase 5e: app-side helpers, shipped but not installed. Hook scripts for Claude Code and Codex (never Antigravity),
// command templates, and the draft shared instruction block. The scripts talk to the service over loopback HTTP and
// never block a session: when the service is down they print nothing and exit 0.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { adapter } from '../src/adapters/registry.ts';

const SCRIPTS = fileURLToPath(new URL('../scripts/', import.meta.url));
const START = path.join(SCRIPTS, 'hooks', 'ac-session-start.mjs'), NUDGE = path.join(SCRIPTS, 'hooks', 'ac-failure-nudge.mjs');

function run(script: string, args: string[], stdin: unknown): Promise<{ code: number | null; out: string; ms: number }> {
  const started = Date.now();
  return new Promise(resolve => {
    const child = execFile(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 10000 }, (error, stdout) =>
      resolve({ code: error ? (error as any).code ?? 1 : 0, out: stdout.trim(), ms: Date.now() - started }));
    child.stdin!.end(JSON.stringify(stdin));
  });
}

async function service(t: any) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-hooks-'));
  const home = path.join(base, 'home'), repo = path.join(base, 'repo'), state = path.join(base, 'state');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true }); fs.mkdirSync(state);
  const seed = new Store(home);
  const token = seed.createActor('claude-desktop', 'participant', 'claude-desktop').token;
  seed.setActorTags('claude-desktop', 'anthropic', 'claude');
  for (const id of ['claude', 'codex', 'openai-api', 'antigravity']) seed.recordProbe(adapter(id)!.capabilities, { state: 'verified' });
  seed.call({ id: 'claude-desktop', name: 'claude-desktop', role: 'participant' }, 'project_create', { name: 'Repo', root: repo, operation_id: randomUUID() });
  seed.close();
  const running = await startServer(home, 0, false);
  const conn = path.join(base, 'conn.json');
  fs.writeFileSync(conn, JSON.stringify({ url: running.url, token, actorId: 'claude-desktop' }));
  const down = path.join(base, 'down.json');
  fs.writeFileSync(down, JSON.stringify({ url: 'http://127.0.0.1:9', token, actorId: 'claude-desktop' }));
  return { base, repo, state, conn, down, running, close: async () => { await running.close(); fs.rmSync(base, { recursive: true, force: true }); } };
}

test('session start: a peek at the project (nothing marked read); silent when the service is down or no project matches', async t => {
  const s = await service(t);
  try {
    const plain = await run(START, ['--connection', s.conn], { cwd: path.join(s.repo, 'src'), hook_event_name: 'SessionStart', session_id: 'a' });
    assert.equal(plain.code, 0);
    assert.match(plain.out, /^Agent Commons \(peek; nothing is marked read\):\n@air1 sync p=p1 name=Repo .*snap=1/);
    assert.equal(s.running.store.db.prepare('SELECT count(*) n FROM actor_cursors').get()!.n, 0, 'the read position is not moved');
    const json = await run(START, ['--connection', s.conn, '--format', 'json'], { cwd: s.repo, hook_event_name: 'SessionStart' });
    const parsed = JSON.parse(json.out);
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart'); assert.match(parsed.hookSpecificOutput.additionalContext, /@air1 sync p=p1/);
    const offline = await run(START, ['--connection', s.down, '--timeout-ms', '1500'], { cwd: s.repo });
    assert.deepEqual([offline.code, offline.out], [0, '']); assert.ok(offline.ms < 5000, `took ${offline.ms} ms`);
    const elsewhere = await run(START, ['--connection', s.conn], { cwd: os.tmpdir() });
    assert.deepEqual([elsewhere.code, elsewhere.out], [0, '']);
    const noConnection = await run(START, [], { cwd: s.repo });
    assert.deepEqual([noConnection.code, noConnection.out], [0, ''], 'no connection configured: silent');
  } finally { await s.close(); }
});

test('failure nudge: silent on one failure, one line at the second and every third after, reset by a success', async t => {
  const s = await service(t);
  try {
    const fail = (session = 's1', format = 'plain', conn = s.conn) => run(NUDGE, ['--connection', conn, '--state-dir', s.state, '--format', format],
      { session_id: session, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: { exit_code: 1, stderr: 'boom' } });
    const pass = () => run(NUDGE, ['--connection', s.conn, '--state-dir', s.state], { session_id: 's1', tool_name: 'Bash', tool_response: { exit_code: 0 } });
    assert.equal((await fail()).out, '');
    assert.equal((await fail()).out, 'AC hint: 2 consecutive command failures. Idle peers of another model family: codex,ag. Consider air_tx ask wake=auto, or a job with proto=air, with ctx= pointing at the failure before attempt 3.');
    assert.equal((await fail()).out, ''); assert.equal((await fail()).out, '');
    assert.match((await fail()).out, /^AC hint: 5 consecutive command failures\./);
    await pass();
    assert.equal((await fail()).out, '', 'a success reset the count');
    assert.equal((await run(NUDGE, ['--state-dir', s.state], { session_id: 's1', tool_name: 'Bash', tool_response: { stdout: 'no exit code here' } })).out, '', 'unknown outcome: no change');
    assert.equal((await fail()).out.startsWith('AC hint: 2 '), true, 'the unknown outcome did not reset or count');
    await fail('s2', 'json'); const json = JSON.parse((await fail('s2', 'json')).out);
    assert.equal(json.hookSpecificOutput.hookEventName, 'PostToolUse'); assert.match(json.hookSpecificOutput.additionalContext, /^AC hint: 2 /);
    await fail('s3', 'plain', s.down);
    assert.equal((await fail('s3', 'plain', s.down)).out, 'AC hint: 2 consecutive command failures. Consider air_tx ask wake=auto, or a job with proto=air, with ctx= pointing at the failure before attempt 3.', 'service down: no peers named');
    for (const file of fs.readdirSync(s.state)) assert.match(file, /^ac-hook-fails-[A-Za-z0-9_-]+\.json$/);
  } finally { await s.close(); }
});

test('templates and the instruction draft ship; nothing targets Antigravity', () => {
  for (const name of ['consult.md', 'delegate.md', 'room.md']) {
    const text = fs.readFileSync(path.join(SCRIPTS, 'commands', name), 'utf8');
    assert.match(text, /^---\ndescription: .+\nargument-hint: .+\n---\n/, name); assert.match(text, /\$ARGUMENTS/, name);
  }
  const block = fs.readFileSync(path.join(SCRIPTS, 'instructions', 'agent-commons.md'), 'utf8');
  assert.ok(block.split('\n').length <= 20, 'a short block'); assert.match(block, /air_sync/);
  assert.doesNotMatch(block, /gpt-|opus|sonnet|gemini/i, 'no model names: Agent Commons holds those');
  assert.deepEqual(fs.readdirSync(path.join(SCRIPTS, 'hooks')).sort(), ['README.md', 'ac-failure-nudge.mjs', 'ac-session-start.mjs']);
  assert.doesNotMatch(fs.readFileSync(path.join(SCRIPTS, 'hooks', 'README.md'), 'utf8'), /\.gemini.*hooks/i);
});
