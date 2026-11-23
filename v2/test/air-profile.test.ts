// AIR-T step 2b: the opt-in AIR-only tool profile (toolProfile: "air" in a connection file) and art_put.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startServer } from './fixtures/service.ts';
import { Store } from './fixtures/service.ts';
import { listedTools, toolsFor } from '../src/tools.ts';

const MCP = fileURLToPath(new URL('../src/mcp.ts', import.meta.url));
const AIR = ['air_sync', 'air_tx', 'air_get', 'air_wait', 'art_put'];

test('the air profile lists four terse tools; the full profile is unchanged', () => {
  assert.deepEqual(listedTools('air').map(t => t.name), AIR);
  const full = listedTools('full').map(t => t.name);
  assert.equal(full.length, 29); assert.ok(!full.includes('art_put'), 'art_put is only in the air profile');
  assert.deepEqual(listedTools().map(t => t.name), full, 'full is the default');
  const chars = JSON.stringify({ tools: listedTools('air') }).length;
  assert.ok(chars <= 3400, `the air tools/list is ${chars} characters; the budget is 3400 (about 850 tokens)`);
  assert.ok(toolsFor('air').has('art_put') && !toolsFor('air').has('task_read') && toolsFor('full').has('task_read'));
});

test('art_put stores an artifact and answers in one AIR line', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-artput-'));
  const store = new Store(home);
  t.after(() => { store.close(); fs.rmSync(home, { recursive: true, force: true }); });
  const actor = store.createActor('claude-desktop', 'participant', 'claude-desktop').actor;
  const project = store.call(actor, 'project_create', { name: 'Demo', operation_id: randomUUID() }).project;
  const put = (operation_id: string = randomUUID()) => store.call(actor, 'art_put', { project_id: project.id, name: 'log', content: 'hello', operation_id });
  assert.equal(put().air, 'A a1 name=log kind=text bytes=5');
  assert.equal(put().air, 'A a1 name=log kind=text bytes=5 dedup=1');
  const again = put('same-op'); assert.equal(put('same-op').air, again.air, 'a replay repeats the stored reply');
  assert.equal(Number((store.db.prepare("SELECT count(*) n FROM events WHERE kind='artifact'").get() as any).n), 1);
  assert.match(store.airDecode('p1').at(-1)!, /claude-desktop stored artifact a1 "log"/);
});

test('an air-profile connection sees only the AIR tools over MCP, as text', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-profile-'));
  const home = path.join(base, 'data'), repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  const seed = new Store(home);
  const token = seed.createActor('codex-desktop', 'participant', 'codex-desktop').token;
  const operator = seed.createActor('op', 'operator', 'op').actor;
  seed.call(operator, 'project_create', { name: 'Repo', root: repo, operation_id: randomUUID() });
  seed.close();
  const running = await startServer(home, 0, false);
  const clients: Client[] = [];
  t.after(async () => { for (const c of clients) await c.close(); await running.close(); fs.rmSync(base, { recursive: true, force: true }); });
  const connect = async (profile?: string) => {
    const file = path.join(home, `conn-${profile ?? 'none'}.json`);
    fs.writeFileSync(file, JSON.stringify({ url: running.url, token, actorId: 'codex-desktop', projectIds: [], selectProject: true, ...(profile ? { toolProfile: profile } : {}) }));
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--disable-warning=ExperimentalWarning', MCP, '--connection', file], stderr: 'pipe' }));
    clients.push(client);
    return client;
  };
  const air = await connect('air');
  assert.deepEqual((await air.listTools()).tools.map(tool => tool.name), AIR);
  const sync: any = await air.callTool({ name: 'air_sync', arguments: { root: path.join(repo, 'src') } });
  assert.equal(sync.structuredContent, undefined); assert.match(sync.content[0].text, /^@air1 sync p=p1 name=Repo .*snap=1/);
  const stored: any = await air.callTool({ name: 'art_put', arguments: { project_id: 'p1', name: 'notes', content: 'a\nb', operation_id: randomUUID() } });
  assert.deepEqual(stored.content, [{ type: 'text', text: 'A a1 name=notes kind=text bytes=3' }]); assert.equal(stored.structuredContent, undefined);
  const lines: any = await air.callTool({ name: 'air_get', arguments: { handles: 'a1' } });
  assert.equal(lines.content[0].text, '@air1 get n=1\nA a1 name=notes kind=text bytes=3 lines=2 show=1-2\n|a\n|b');
  const refused: any = await air.callTool({ name: 'task_read', arguments: { task_id: 't1' } });
  assert.equal(refused.isError, true); assert.equal(refused.structuredContent, undefined);
  assert.deepEqual(refused.content, [{ type: 'text', text: '@air1 err code=UNKNOWN_TOOL msg="task_read"' }], 'an air connection only ever gets AIR text');
  // No toolProfile, or "full", keeps today's catalog; anything else is refused at startup of each call.
  assert.equal((await (await connect()).listTools()).tools.length, 29);
  assert.equal((await (await connect('full')).listTools()).tools.length, 29);
  const bad = await connect('tiny');
  await assert.rejects(bad.listTools(), /INVALID_TOOL_PROFILE/);
});
