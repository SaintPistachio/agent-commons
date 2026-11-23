import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startServer } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { call, RemoteError } from '../src/client.ts';
import { importV1 } from '../src/import-v1.ts';

const MCP = fileURLToPath(new URL('../src/mcp.ts', import.meta.url));
/** Cleanups run last-in, first-out, so handles close before their directories are removed. */
const stacks = new WeakMap<object, Array<() => unknown>>();
function defer(t: any, fn: () => unknown): void {
  let stack = stacks.get(t);
  if (!stack) { const created: Array<() => unknown> = []; stack = created; stacks.set(t, created); t.after(async () => { for (const step of created.reverse()) await step(); }); }
  stack.push(fn);
}
const tempHome = (t: any, prefix: string) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); defer(t, () => fs.rmSync(dir, { recursive: true, force: true })); return dir; };

async function mcpClient(t: any, connectionFile: string) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--disable-warning=ExperimentalWarning', MCP, '--connection', connectionFile], stderr: 'pipe' }));
  defer(t, () => client.close());
  return async (name: string, args: Record<string, unknown> = {}) => {
    const result: any = await client.callTool({ name, arguments: args });
    if (result.isError) throw new RemoteError(result.structuredContent.error.code, result.structuredContent.error.message);
    return result.structuredContent;
  };
}

test('two apps share a project through the MCP bridge, across a service restart', async t => {
  const home = tempHome(t, 'ac2-int-');
  const seed = new Store(home);
  const claudeToken = seed.createActor('claude-desktop', 'participant', 'claude-desktop').token;
  const codexToken = seed.createActor('codex-desktop', 'participant', 'codex-desktop').token;
  seed.close();
  let running = await startServer(home, 0);
  defer(t, () => running.close());
  const connection = (actorId: string, token: string, projectIds: string[] = []) => {
    const file = path.join(home, actorId + '.json');
    fs.writeFileSync(file, JSON.stringify({ url: running.url, token, actorId, projectIds, selectProject: projectIds.length === 0 }));
    return file;
  };
  const claudeFile = connection('claude-desktop', claudeToken);
  const claude = await mcpClient(t, claudeFile);
  const workspace = path.join(home, 'repo');
  const project = (await claude('project_create', { name: 'Repo', root: workspace, operation_id: randomUUID() })).project;
  const task = (await claude('task_create', { project_id: project.id, title: 'Add search', operation_id: randomUUID() })).task;
  await claude('task_claim', { task_id: task.id, version: 1, operation_id: randomUUID() });
  await claude('project_checkpoint', { project_id: project.id, task_id: task.id, summary: 'Index built', next_action: 'Wire the query API', operation_id: randomUUID() });
  await claude('project_checkpoint', { project_id: project.id, summary: 'Search half done', next_action: 'Wire the query API', operation_id: randomUUID() });

  // Restart the service on the same port; the connection files stay valid.
  const port = Number(new URL(running.url).port);
  await running.close(); running = await startServer(home, port);

  // The second app's connection names the project, so project_id may be omitted.
  const codex = await mcpClient(t, connection('codex-desktop', codexToken, [project.id]));
  const found = await codex('project_discover', { root: path.join(workspace, 'src') });
  assert.deepEqual(found.projects.map((p: any) => p.id), [project.id]);
  const brief = await codex('project_resume', {});
  assert.equal(brief.next_action, 'Wire the query API');
  assert.equal(brief.active_tasks[0].owner, 'claude-desktop');
  const focused = await codex('project_resume', { task_id: task.id });
  assert.equal(focused.checkpoints[0].summary, 'Index built');
  await assert.rejects(codex('task_update', { task_id: task.id, version: 2, status: 'done', operation_id: randomUUID() }), (e: any) => e.code === 'OWNER_REQUIRED');

  // A lost response is retried with the same operation_id and returns the original result.
  const opId = randomUUID();
  const first = await call({ url: running.url, token: codexToken, actorId: 'codex-desktop' }, 'decision_record', { project_id: project.id, summary: 'Use BM25', operation_id: opId });
  const retried = await codex('decision_record', { project_id: project.id, summary: 'Use BM25', operation_id: opId });
  assert.equal(retried.decision.id, first.decision.id);

  const tools = await (async () => { const c = new Client({ name: 'list', version: '1' }); await c.connect(new StdioClientTransport({ command: process.execPath, args: ['--disable-warning=ExperimentalWarning', MCP, '--connection', claudeFile] })); try { return (await c.listTools()).tools.map(x => x.name); } finally { await c.close(); } })();
  assert(tools.includes('project_resume') && tools.includes('task_claim') && tools.includes('job_submit') && !tools.includes('routing_select'));
  await assert.rejects(call({ url: running.url, token: 'bad', actorId: 'x' }, 'project_discover'), (e: any) => e.code === 'UNAUTHENTICATED');
});

test('v1 import keeps ids and token hashes and leaves v1 unchanged', t => {
  const v1Home = tempHome(t, 'ac2-v1-'), v2Home = tempHome(t, 'ac2-v2-');
  fs.mkdirSync(path.join(v1Home, 'artifacts'));
  const v1 = new DatabaseSync(path.join(v1Home, 'commons.sqlite'));
  v1.exec(`CREATE TABLE actors(id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
    CREATE TABLE records(kind TEXT NOT NULL,id TEXT NOT NULL,project_id TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(kind,id));`);
  const token = 'claude-secret', hash = createHash('sha256').update(token).digest('hex');
  v1.prepare('INSERT INTO actors VALUES(?,?,?)').run('claude-desktop', hash, JSON.stringify({ id: 'claude-desktop', role: 'participant', projectIds: ['p1'] }));
  const at = '2026-11-01T00:00:00.000Z';
  const put = (kind: string, data: Record<string, unknown>) => v1.prepare('INSERT INTO records VALUES(?,?,?,?,?)').run(kind, data.id as string, (data.project_id ?? data.id) as string, JSON.stringify(data), at);
  put('project', { id: 'p1', name: 'Old', objective: 'Keep going', root: path.join(v1Home, 'repo'), created_at: at });
  put('task', { id: 't1', project_id: 'p1', title: 'Old task', status: 'awaiting_review', owner: 'claude-desktop', version: 7, acceptance: ['ok'], created_at: at });
  put('task', { id: 't2', project_id: 'p1', title: 'Done task', status: 'accepted', version: 3, created_at: at });
  put('decision', { id: 'd1', project_id: 'p1', task_id: 't1', actor_id: 'claude-desktop', summary: 'Keep SQLite', evidence: [{ ref: 'x' }], created_at: at });
  fs.writeFileSync(path.join(v1Home, 'artifacts', 'abc'), 'evidence');
  put('artifact', { id: 'a1', project_id: 'p1', actor_id: 'claude-desktop', name: 'log', kind: 'text', sha256: 'abc', bytes: 8, created_at: at });
  put('checkpoint', { id: 'c1', project_id: 'p1', actor_id: 'claude-desktop', summary: 'Last state', next_action: 'Review t1', revision: 'deadbeef',
    checks: [{ command: 'npm test', evidence: '10 pass', exit_code: 0 }], artifacts: ['a1'], created_at: at });
  put('message', { id: 'm1', project_id: 'p1', type: 'question', sender_id: 'codex-desktop', recipients: ['claude-desktop'], body: 'Status?', acknowledged_by: [], answered_by: [], created_at: at });
  put('message', { id: 'm2', project_id: 'p1', type: 'answer', sender_id: 'claude-desktop', recipients: ['codex-desktop'], body: 'Fine', reply_to: 'm1', acknowledged_by: ['codex-desktop'], created_at: at });
  put('job', { id: 'j1', project_id: 'p1', status: 'completed', created_at: at });
  v1.close();
  const before = fs.readFileSync(path.join(v1Home, 'commons.sqlite'));

  const store = new Store(v2Home);
  defer(t, () => store.close());
  const report = importV1(v1Home, store);
  assert.deepEqual(report.counts, { actor: 1, project: 1, task: 2, decision: 1, artifact: 1, checkpoint: 1, message: 2 });
  assert.deepEqual(fs.readFileSync(path.join(v1Home, 'commons.sqlite')), before, 'v1 database bytes are unchanged');

  const actor = store.authenticate(token);
  assert.equal(actor.id, 'claude-desktop');
  const brief = store.call(actor, 'project_resume', { project_id: 'p1' });
  assert.equal(brief.next_action, 'Review t1');
  assert.deepEqual(brief.latest_checkpoint.checks, ['npm test -> 10 pass (exit 0)']);
  assert.deepEqual(brief.active_tasks.map((row: any) => [row.id, row.status, row.version]), [['t1', 'awaiting_review', 7]]);
  assert.equal(brief.inbox.length, 1, 'unanswered question m1 stays in the inbox');
  assert.equal(store.call(actor, 'artifact_read', { artifact_id: 'a1' }).content, 'evidence');
  assert.throws(() => importV1(v1Home, store), /IMPORT_TARGET_NOT_EMPTY/);
});
