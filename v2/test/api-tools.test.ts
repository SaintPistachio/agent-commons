import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store, type Actor } from './fixtures/service.ts';
import { Runner } from '../src/runner.ts';
import { busySlots, jobToolset, loadManifest } from '../src/tool-hub.ts';
import { dropOptionalNulls, mcpTools, projectTools, strictParameters } from '../src/api-tools.ts';
import { turnRequestId } from '../src/adapters/openai-api-tools.ts';
import { adapter } from '../src/adapters/registry.ts';

const FAKE_HELPER = fileURLToPath(new URL('./fixtures/fake-openai-helper.mjs', import.meta.url));
const FAKE_MCP = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const API = { route: 'openai-api', max_cost_usd: '0.25', purpose: 'Check a parser with project files', deliverable: 'Findings list' };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

type Step = { text?: string; calls?: Array<{ name: string; arguments: string }>; cost?: string | null; status?: string; sleep?: number; error_code?: string };

function fixture(t: any, opts: { manifest?: boolean } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-apitools-'));
  const home = path.join(base, 'home'), helperDir = path.join(base, 'helper'), root = path.join(base, 'repo'), mcpDir = path.join(base, 'mcp');
  for (const dir of [home, helperDir, root, mcpDir]) fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'a.txt'), 'alpha\nbeta parser\ngamma\n');
  fs.writeFileSync(path.join(root, '.env'), 'OPENAI_API_KEY=x\n');
  if (opts.manifest) {
    const manifest = { schema: 1, skills_root: path.join(base, 'skills'),
      servers: { fake_mcp: { command: process.execPath, args: [FAKE_MCP], cwd: mcpDir, apps: ['codex'] } },
      toolsets: { fake: { server: 'fake_mcp', routes: ['openai-api', 'codex'], max_concurrent: 2,
        advice_tools: ['session_start', 'get_scene_info', 'get_viewport_screenshot', 'tag_map', 'slow'], edit_tools: ['execute_blender_code'] } } };
    fs.writeFileSync(path.join(home, 'tools.json'), JSON.stringify(manifest));
  }
  const store = new Store(home);
  const actor: Actor = store.createActor('codex-desktop', 'participant', 'codex-desktop').actor;
  const call = (method: string, input: Record<string, unknown> = {}) => store.call(actor, method, input);
  const project = call('project_create', { name: 'Repo', root, operation_id: randomUUID() }).project;
  const runners: Runner[] = [];
  const helper = { file: process.execPath, prefix: [FAKE_HELPER], cwd: helperDir };
  const runner = () => { const r = new Runner(store, home, { openaiHelper: helper, tickMs: 50 }); runners.push(r); return r; };
  t.after(() => { for (const r of runners) r.stop(); store.close(); fs.rmSync(base, { recursive: true, force: true }); });
  const script = (steps: Step[]) => fs.writeFileSync(path.join(helperDir, 'tool-script.json'), JSON.stringify(steps));
  const submit = (prompt: string, extra: Record<string, unknown> = {}) => call('job_submit', { project_id: project.id, prompt, operation_id: randomUUID(), ...API, tools: 'project', ...extra }).job;
  const until = async (id: string, statuses: string[], ms = 20000) => {
    const end = Date.now() + ms;
    for (;;) { const job = call('job_status', { job_id: id }).job; if (statuses.includes(job.status)) return job; if (Date.now() > end) throw new Error(`job stuck in ${job.status}`); await sleep(50); }
  };
  const calls = () => fs.existsSync(path.join(helperDir, 'calls.log'))
    ? fs.readFileSync(path.join(helperDir, 'calls.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  const invokes = () => calls().filter(c => c.command === 'invoke');
  const mcpCalls = () => fs.existsSync(path.join(mcpDir, 'mcp-calls.log'))
    ? fs.readFileSync(path.join(mcpDir, 'mcp-calls.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  return { base, store, actor, call, project, home, helperDir, root, mcpDir, runner, script, submit, until, calls, invokes, mcpCalls };
}
const DONE = ['completed', 'failed', 'needs_review', 'cancelled'];

test('project tool loop: native function calls run locally, results go back, costs and turns add up', async t => {
  const f = fixture(t);
  f.script([
    { text: 'Looking.', calls: [{ name: 'read_file', arguments: JSON.stringify({ path: 'src/a.txt', start_line: null, end_line: null }) },
      { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) }], cost: '0.020000' },
    { text: 'The parser is on line 2.', cost: '0.015000' },
  ]);
  const job = f.submit('Where is the parser mentioned?');
  assert.equal(job.options.toolset.name, 'project');
  assert.equal(job.options.max_turns, 8);
  f.runner().start();
  const done = await f.until(job.id, DONE);
  assert.equal(done.status, 'completed', done.error);
  assert.equal(done.result, 'The parser is on line 2.');
  assert.equal(done.cost_usd, '0.035000');
  assert.equal(done.turns, 2);
  assert.equal(done.tokens_in, 3000);
  const [t1, t2, ...rest] = f.invokes().map(c => c.request);
  assert.equal(rest.length, 0);
  assert.equal(t1.external_request_id, createHash('sha256').update(`${job.id}:t1`).digest('hex'));
  assert.equal(t2.external_request_id, turnRequestId(job.id, 2));
  assert.equal(t1.max_cost_usd, '0.250000'); assert.equal(t2.max_cost_usd, '0.230000', 'each turn gets what is left');
  assert.deepEqual(t1.payload.tools.map((x: any) => x.name), ['read_file', 'grep', 'list_dir']);
  assert.ok(t1.payload.tools.every((x: any) => x.strict === true && x.parameters.additionalProperties === false));
  assert.equal(t1.payload.tool_choice, 'auto');
  assert.deepEqual(t1.payload.input[0].content[0].prompt_cache_breakpoint, { mode: 'explicit', ttl: '30m' });
  const items = t2.payload.input;
  assert.deepEqual(items[1], { role: 'assistant', content: [{ type: 'output_text', text: 'Looking.' }] });
  assert.deepEqual(items.slice(2, 4).map((x: any) => [x.type, x.call_id, x.name]), [['function_call', 'call_1_0', 'read_file'], ['function_call', 'call_1_1', 'list_dir']]);
  assert.equal(items[4].type, 'function_call_output'); assert.equal(items[4].call_id, 'call_1_0');
  assert.match(items[4].output, /2\|beta parser/);
  assert.doesNotMatch(items[5].output, /\.env/, 'secret-like names are not listed');
  // Receipt and transcript on the job line.
  const line = f.store.op_air_get(f.actor, { handles: job.id }).air as string;
  assert.match(line, / tools=project@[0-9a-f]{12}/);
  const tr = /tr=(a\d+)/.exec(line)?.[1];
  assert.ok(tr, line);
  assert.match(f.store.op_air_get(f.actor, { handles: tr! }).air as string, /call read_file/);
  const turns = f.store.jobRecord(job.id)!.options.api_turns;
  assert.deepEqual(turns.map((x: any) => [x.n, x.status, x.cost_usd]), [[1, 'completed', '0.020000'], [2, 'completed', '0.015000']]);
});

test('project tools keep the ctx= file rules: no escapes, secrets, binaries or credential text', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'src', 'keys.txt'), 'token sk-proj-' + 'a'.repeat(30) + '\n');
  fs.writeFileSync(path.join(f.root, 'src', 'blob.bin'), Buffer.from([1, 0, 2, 3]));
  fs.writeFileSync(path.join(f.base, 'outside.txt'), 'outside');
  const host = projectTools(f.root, [f.home]);
  const run = (name: string, args: unknown) => host.call(name, JSON.stringify(args));
  return (async () => {
    assert.match(await run('read_file', { path: '.env', start_line: null, end_line: null }), /^error: .*secret/);
    assert.match(await run('read_file', { path: '../outside.txt', start_line: null, end_line: null }), /^error: .*outside/);
    assert.match(await run('read_file', { path: path.join(f.base, 'outside.txt'), start_line: null, end_line: null }), /^error: .*relative/);
    assert.match(await run('read_file', { path: 'src/keys.txt', start_line: null, end_line: null }), /^error: .*credential/);
    assert.match(await run('read_file', { path: 'src/blob.bin', start_line: null, end_line: null }), /^error: .*binary/);
    assert.match(await run('read_file', { path: 'src/a.txt', start_line: 2, end_line: 2 }), /lines 2-2 of 3\n2\|beta parser$/);
    const grep = await run('grep', { path: '.', text: 'PARSER', context_lines: null });
    assert.match(grep, /src\/a\.txt:2\|beta parser/);
    assert.match(await run('grep', { path: '.', text: 'token', context_lines: 0 }), /withheld/);
    assert.match(await run('list_dir', { path: 'src' }), /a\.txt 24/);
    assert.match(await run('nope', {}), /^error: no tool/);
    assert.match(await host.call('read_file', '{bad'), /not valid JSON/);
  })();
});

test('budget: a turn with less than one cent left is not attempted', async t => {
  const f = fixture(t);
  f.script([{ calls: [{ name: 'list_dir', arguments: '{"path":"."}' }], cost: '0.045000' }, { text: 'never' }]);
  const job = f.submit('Check it', { max_cost_usd: '0.05' });
  f.runner().start();
  const done = await f.until(job.id, DONE);
  assert.equal(done.status, 'failed'); assert.match(done.error, /^BUDGET_SPENT/);
  assert.equal(f.invokes().length, 1); assert.equal(done.cost_usd, '0.045000');
});

test('an uncertain turn leaves the job for review and is never replayed', async t => {
  const f = fixture(t);
  f.script([{ calls: [{ name: 'list_dir', arguments: '{"path":"."}' }] }, { status: 'uncertain' }]);
  const job = f.submit('Uncertain second turn');
  f.runner().start();
  const done = await f.until(job.id, DONE);
  assert.equal(done.status, 'needs_review'); assert.match(done.error, /turn 2 helper status uncertain/);
  await sleep(300);
  assert.equal(f.invokes().length, 2);
  assert.equal(done.cost_usd, '0.010000', 'only the settled turn is counted');
});

test('a completed turn without a recorded cost stops the loop as UNKNOWN_SPEND', async t => {
  const f = fixture(t);
  f.script([{ calls: [{ name: 'list_dir', arguments: '{"path":"."}' }], cost: null }, { text: 'never' }]);
  const job = f.submit('No usage');
  f.runner().start();
  const done = await f.until(job.id, DONE);
  assert.equal(done.status, 'needs_review'); assert.match(done.error, /^UNKNOWN_SPEND/);
  assert.equal(f.invokes().length, 1);
});

test('admission refusal on a later turn fails the job and keeps earlier costs', async t => {
  const f = fixture(t);
  f.script([{ calls: [{ name: 'list_dir', arguments: '{"path":"."}' }] }, { status: 'blocked', error_code: 'job_cap_exceeded' }]);
  const job = f.submit('Refused later');
  f.runner().start();
  const done = await f.until(job.id, DONE);
  assert.equal(done.status, 'failed'); assert.equal(done.error, 'HELPER_BLOCKED: job_cap_exceeded (turn 2)');
  assert.equal(done.cost_usd, '0.010000');
});

test('the last allowed turn switches tools off; tool calls anyway fail as MAX_TURNS', async t => {
  const f = fixture(t);
  f.script([{ calls: [{ name: 'list_dir', arguments: '{"path":"."}' }] }]);
  const job = f.submit('Loop forever', { max_turns: 2 });
  f.runner().start();
  const done = await f.until(job.id, DONE);
  assert.equal(done.status, 'failed'); assert.match(done.error, /^MAX_TURNS/);
  assert.deepEqual(f.invokes().map(c => c.request.payload.tool_choice), ['auto', 'none']);
});

test('MCP tool set: advice tools only, strict schemas, optional nulls dropped, images noted, server stopped', async t => {
  const f = fixture(t, { manifest: true });
  f.script([
    { calls: [{ name: 'session_start', arguments: JSON.stringify({ project_root: 'C:\\p', output_root: 'C:\\o', scene: null, visible: null }) },
      { name: 'get_viewport_screenshot', arguments: JSON.stringify({ session_id: 's1', max_size: null }) },
      { name: 'get_scene_info', arguments: JSON.stringify({ session_id: 's1' }) }] },
    { text: 'Three objects.' },
  ]);
  const job = f.submit('Inspect the scene', { tools: 'fake' });
  f.runner().start();
  const done = await f.until(job.id, DONE);
  assert.equal(done.status, 'completed', done.error);
  const [t1, t2] = f.invokes().map(c => c.request);
  const names = t1.payload.tools.map((x: any) => x.name);
  assert.deepEqual(names, ['session_start', 'get_scene_info', 'get_viewport_screenshot', 'slow'], 'no edit tool, no open-map tool');
  const start = t1.payload.tools[0].parameters;
  assert.deepEqual(start.required, ['project_root', 'output_root', 'scene', 'visible']);
  assert.deepEqual(start.properties.visible.type, ['boolean', 'null']);
  assert.equal(start.properties.scene.default, undefined);
  assert.deepEqual(f.mcpCalls()[0], { name: 'session_start', args: { project_root: 'C:\\p', output_root: 'C:\\o' } });
  const outputs = t2.payload.input.filter((x: any) => x.type === 'function_call_output').map((x: any) => x.output);
  assert.match(outputs[1], /saved by Agent Commons as tool-image-1\.png/);
  assert.equal(fs.readFileSync(path.join(f.home, 'jobs', job.id, 'tool-image-1.png'), 'utf8'), 'PNGDATA');
  assert.ok(outputs[2].length < 16200 && /more characters cut/.test(outputs[2]), 'tool results are truncated');
  const pid = Number(fs.readFileSync(path.join(f.mcpDir, 'mcp.pid'), 'utf8'));
  for (let i = 0; i < 40 && alive(pid); i++) await sleep(50);
  assert.ok(!alive(pid), 'the MCP server is stopped when the job ends');
  const tr = /tr=(a\d+)/.exec(f.store.op_air_get(f.actor, { handles: job.id }).air as string)![1];
  assert.match(f.store.op_air_get(f.actor, { handles: tr }).air as string, /skipped: tag_map: an open map/);
});

test('cancel during a tool call (no request in flight) cancels the job and stops the server', async t => {
  const f = fixture(t, { manifest: true });
  f.script([{ calls: [{ name: 'slow', arguments: '{}' }] }, { text: 'never' }]);
  const job = f.submit('Slow tool', { tools: 'fake' });
  f.runner().start();
  const end = Date.now() + 15000;
  while (!f.mcpCalls().some(c => c.name === 'slow')) { if (Date.now() > end) throw new Error('slow never called'); await sleep(50); }
  f.call('job_cancel', { job_id: job.id, operation_id: randomUUID() });
  const done = await f.until(job.id, DONE);
  assert.equal(done.status, 'cancelled'); assert.match(done.error, /no request was in flight/);
  assert.equal(f.invokes().length, 1);
  const pid = Number(fs.readFileSync(path.join(f.mcpDir, 'mcp.pid'), 'utf8'));
  for (let i = 0; i < 40 && alive(pid); i++) await sleep(50);
  assert.ok(!alive(pid));
});

test('cancel while a turn is in flight leaves the job for review', async t => {
  const f = fixture(t);
  f.script([{ text: 'late', sleep: 60000 }]);
  const job = f.submit('Slow turn');
  f.runner().start();
  const end = Date.now() + 10000;
  while (!f.invokes().length) { if (Date.now() > end) throw new Error('invoke never started'); await sleep(50); }
  f.call('job_cancel', { job_id: job.id, operation_id: randomUUID() });
  const done = await f.until(job.id, DONE);
  assert.equal(done.status, 'needs_review'); assert.match(done.error, /^CANCELLED/);
});

test('after a restart, reconcile looks up each unsettled turn and never resumes', async t => {
  const f = fixture(t);
  const job = f.submit('Interrupted loop');
  const turns = [{ n: 1, request_id: turnRequestId(job.id, 1), ceiling_usd: '0.250000', status: 'completed', cost_usd: '0.010000' },
    { n: 2, request_id: turnRequestId(job.id, 2), ceiling_usd: '0.240000', status: 'submitting' }];
  f.store.annotateJob(job.id, { api_turns: turns });
  f.store.db.prepare("UPDATE jobs SET status='running',started_at=? WHERE id=?").run(new Date().toISOString(), job.id);
  fs.writeFileSync(path.join(f.helperDir, 'lookup.json'), JSON.stringify({ status: 'completed', job_id: 'hj-t2', cost_usd: '0.020000' }));
  f.runner().start();
  const end = Date.now() + 10000;
  let row = f.store.jobRecord(job.id)!;
  while (!/SERVICE_STOPPED_DURING_TOOL_LOOP/.test(row.error ?? '')) { if (Date.now() > end) throw new Error('not reconciled: ' + row.error); await sleep(50); row = f.store.jobRecord(job.id)!; }
  assert.equal(row.status, 'needs_review'); assert.equal(row.cost_usd, '0.030000');
  assert.deepEqual(f.calls().map(c => [c.command, c.id]), [['lookup', turns[1].request_id]]);
});

test('submit rules: max_turns, edit tool sets refused on the API route, route=auto only with paid spend fields', t => {
  const f = fixture(t, { manifest: true });
  for (const id of ['claude', 'codex', 'openai-api', 'antigravity']) f.store.recordProbe(adapter(id)!.capabilities, { state: 'verified' });
  assert.throws(() => f.submit('x', { max_turns: 21 }), /max_turns must be 1-20/);
  assert.throws(() => f.call('job_submit', { project_id: f.project.id, prompt: 'x', operation_id: randomUUID(), ...API, max_turns: 3 }), /max_turns needs tools/);
  assert.throws(() => jobToolset(loadManifest(f.home), 'fake', 'openai-api', 'edit'), /TOOLSET_EDIT_NOT_APPROVED|not approved on openai-api/);
  assert.throws(() => f.call('job_submit', { project_id: f.project.id, prompt: 'x', operation_id: randomUUID(), route: 'codex', tools: 'project' }), /runs only on openai-api/);
  assert.throws(() => f.call('job_submit', { project_id: f.project.id, prompt: 'x', operation_id: randomUUID(), route: 'auto', tools: 'project' }), /NO_ELIGIBLE_ROUTE|no route can take/);
  const auto = f.call('job_submit', { project_id: f.project.id, prompt: 'x', operation_id: randomUUID(), route: 'auto', cost: 'paid', tools: 'project',
    max_cost_usd: '0.1', purpose: 'p', deliverable: 'd' }).job;
  assert.equal(auto.route, 'openai-api');
});

test('discovery: air_get tools lists tool sets as K lines and resolves tools:<set>, built-in without a manifest', t => {
  const plain = fixture(t);
  assert.match(plain.store.op_air_get(plain.actor, { handles: 'tools:project' }).air as string, /^@air1 get n=1\nK project server=builtin routes=openai-api advice=read_file,grep,list_dir edit=- max=8 sha=[0-9a-f]{12}/);
  const f = fixture(t, { manifest: true });
  const all = f.store.op_air_get(f.actor, { handles: 'tools' }).air as string;
  assert.match(all, /toolsets=2/);
  assert.match(all, /\nK project server=builtin/);
  const k = /\nK fake server=fake_mcp routes=openai-api,codex advice=\S+ edit=execute_blender_code max=2 sha=([0-9a-f]{12})/.exec(all);
  assert.ok(k, all);
  const job = f.submit('x', { tools: 'fake' });
  assert.equal(job.options.toolset.def_sha256.slice(0, 12), k![1], 'the receipt hash matches the listed definition');
  assert.match(f.store.op_air_get(f.actor, { handles: 'tools:fake' }).air as string, /K fake server=fake_mcp/);
});

test('Blender lease: a queued tool set job waits while every wrapper slot lock is held by another process', async t => {
  const python = spawnSync('python', ['-c', 'import msvcrt'], { encoding: 'utf8' });
  if (python.status !== 0) { t.skip('needs Windows Python (msvcrt) to hold a byte-range lock'); return; }
  const f = fixture(t, { manifest: true });
  const locks = [path.join(f.base, 'blender-0.lock'), path.join(f.base, 'blender-1.lock')];
  const data = JSON.parse(fs.readFileSync(path.join(f.home, 'tools.json'), 'utf8'));
  data.toolsets.fake.slot_locks = locks;
  fs.writeFileSync(path.join(f.home, 'tools.json'), JSON.stringify(data));
  assert.equal(busySlots(locks), 0, 'missing lock files are free slots');
  const hold = `import msvcrt,sys,time\nfs=[]\nfor p in sys.argv[1:]:\n s=open(p,'a+b')\n if s.seek(0,2)==0: s.write(b'\\0'); s.flush()\n s.seek(0); msvcrt.locking(s.fileno(),msvcrt.LK_NBLCK,1); fs.append(s)\nprint('locked',flush=True)\ntime.sleep(30)\n`;
  const holder = spawn('python', ['-c', hold, ...locks], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => holder.kill());
  await new Promise<void>(resolve => holder.stdout!.once('data', () => resolve()));
  assert.equal(busySlots(locks), 2);
  const job = f.call('job_submit', { project_id: f.project.id, prompt: 'x', operation_id: randomUUID(), route: 'codex', tools: 'fake' }).job;
  assert.deepEqual(job.options.toolset.slot_locks, locks);
  assert.equal(f.store.claimQueuedJob({ codex: 5 }, 10), null, 'both wrapper slots are busy');
  holder.kill();
  await new Promise(resolve => holder.once('exit', resolve));
  assert.equal(busySlots(locks), 0);
  assert.equal(f.store.claimQueuedJob({ codex: 5 }, 10)?.id, job.id);
});

test('strict schema conversion and null dropping', () => {
  const ok = strictParameters({ type: 'object', required: ['a'], properties: { a: { type: 'string', format: 'uri' }, b: { type: 'array', items: { type: 'integer', minimum: 1 } },
    c: { oneOf: [{ type: 'string' }, { type: 'object', properties: { d: { type: 'number' } } }] } } });
  assert.ok('parameters' in ok);
  const p = (ok as any).parameters;
  assert.deepEqual(p.required, ['a', 'b', 'c']);
  assert.equal(p.properties.a.format, undefined);
  assert.deepEqual(p.properties.b.type, ['array', 'null']);
  assert.equal(p.properties.c.anyOf.at(-1).type, 'null');
  assert.equal(p.properties.c.anyOf[1].additionalProperties, false);
  for (const bad of [{ type: 'object', properties: { m: { type: 'object', additionalProperties: { type: 'string' } } } },
    { type: 'object', properties: { r: { $ref: '#/x' } } }, { type: 'object', properties: { l: { type: 'array' } } }, { type: 'string' }])
    assert.ok('error' in strictParameters(bad), JSON.stringify(bad));
  assert.deepEqual(strictParameters(undefined), { parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } });
  assert.deepEqual(dropOptionalNulls({ a: null, b: null, c: { d: null } }, { required: ['a'], properties: { c: { properties: { d: {} } } } }), { a: null, c: {} });
});

test('runner.stop() mid-turn-2 preserves turn-1 spend/tokens and startup reconciles turn 2', async t => {
  const f = fixture(t);
  f.script([{ calls: [{ name: 'list_dir', arguments: '{"path":"."}' }], cost: '0.020000' }, { text: 'late', sleep: 60000 }]);
  const job = f.submit('Stop mid turn 2');
  const r1 = f.runner();
  r1.start();
  const end1 = Date.now() + 10000;
  while (f.invokes().length < 2) { if (Date.now() > end1) throw new Error('turn 2 never started'); await sleep(50); }
  r1.stop();
  const stopped = f.store.jobRecord(job.id)!;
  assert.equal(stopped.status, 'needs_review');
  assert.equal(stopped.error, 'SERVICE_STOPPED_DURING_JOB');
  assert.equal(stopped.cost_usd, '0.020000');
  assert.equal(stopped.tokens_in, 1000);
  assert.equal(stopped.tokens_out, 50);
  assert.equal(stopped.turns, 2);
  assert.equal(stopped.helper_job_id, 'hj-t1');
  assert.ok(stopped.options.transcript_artifact);
  assert.deepEqual(stopped.options.api_turns.map((x: any) => [x.n, x.status]), [[1, 'completed'], [2, 'submitting']]);

  fs.writeFileSync(path.join(f.helperDir, 'lookup.json'), JSON.stringify({
    status: 'completed', job_id: 'hj-t2', cost_usd: '0.015000', usage: { input_tokens: 2000, output_tokens: 60 },
  }));
  f.runner().start();
  const end2 = Date.now() + 10000;
  let reconciled = f.store.jobRecord(job.id)!;
  while (!/SERVICE_STOPPED_DURING_TOOL_LOOP/.test(reconciled.error ?? '')) {
    if (Date.now() > end2) throw new Error('not reconciled: ' + reconciled.error);
    await sleep(50);
    reconciled = f.store.jobRecord(job.id)!;
  }
  assert.equal(reconciled.status, 'needs_review');
  assert.equal(reconciled.cost_usd, '0.035000');
  assert.equal(reconciled.tokens_in, 3000);
  assert.equal(reconciled.tokens_out, 110);
  assert.equal(reconciled.turns, 2);
  assert.equal(reconciled.helper_job_id, 'hj-t2');
  assert.deepEqual(f.calls().filter(c => c.command === 'lookup').map(c => c.id), [turnRequestId(job.id, 2)]);
});

test('reconcile keeps retry marker when lookup is unresolved and settles on next start', async t => {
  const f = fixture(t);
  const job = f.submit('Unresolved reconcile');
  const turns = [{ n: 1, request_id: turnRequestId(job.id, 1), ceiling_usd: '0.250000', status: 'submitting' }];
  f.store.annotateJob(job.id, { api_turns: turns });
  f.store.db.prepare("UPDATE jobs SET status='needs_review',error='SERVICE_STOPPED_DURING_JOB',finished_at=? WHERE id=?").run(new Date().toISOString(), job.id);
  fs.writeFileSync(path.join(f.helperDir, 'lookup.json'), JSON.stringify({ status: 'submitting', job_id: 'hj-t1' }));
  const r1 = f.runner();
  r1.start();
  const end1 = Date.now() + 8000;
  while (f.calls().filter(c => c.command === 'lookup').length < 1) { if (Date.now() > end1) throw new Error('no first lookup'); await sleep(50); }
  await sleep(100);
  r1.stop();
  assert.equal(f.store.jobRecord(job.id)!.error, 'SERVICE_STOPPED_DURING_JOB');
  fs.writeFileSync(path.join(f.helperDir, 'lookup.json'), JSON.stringify({ status: 'completed', job_id: 'hj-t1', cost_usd: '0.012000' }));
  f.runner().start();
  const end2 = Date.now() + 8000;
  let row = f.store.jobRecord(job.id)!;
  while (!/SERVICE_STOPPED_DURING_TOOL_LOOP/.test(row.error ?? '')) { if (Date.now() > end2) throw new Error('never settled: ' + row.error); await sleep(50); row = f.store.jobRecord(job.id)!; }
  assert.equal(row.cost_usd, '0.012000');
});

test('cancel while an MCP server hangs during startup kills the child promptly', async t => {
  const f = fixture(t, { manifest: true });
  const data = JSON.parse(fs.readFileSync(path.join(f.home, 'tools.json'), 'utf8'));
  data.servers.fake_mcp.args = [FAKE_MCP, '--hang'];
  fs.writeFileSync(path.join(f.home, 'tools.json'), JSON.stringify(data));
  const job = f.submit('Hung MCP startup', { tools: 'fake' });
  f.runner().start();
  const pidFile = path.join(f.mcpDir, 'mcp.pid');
  const end = Date.now() + 10000;
  while (!fs.existsSync(pidFile)) { if (Date.now() > end) throw new Error('MCP server never spawned'); await sleep(50); }
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  f.call('job_cancel', { job_id: job.id, operation_id: randomUUID() });
  const done = await f.until(job.id, DONE, 8000);
  assert.equal(done.status, 'cancelled');
  assert.match(done.error, /^CANCELLED/);
  for (let i = 0; i < 40 && alive(pid); i++) await sleep(50);
  assert.ok(!alive(pid), 'hanging MCP startup process was terminated');
});

test('mcpTools preserves default Windows env vars when spec.env is omitted or partial', async t => {
  const f = fixture(t, { manifest: true });
  const envFile = path.join(f.mcpDir, 'mcp-env.json');
  const data = JSON.parse(fs.readFileSync(path.join(f.home, 'tools.json'), 'utf8'));
  data.servers.fake_mcp.args = [FAKE_MCP, '--dump-env'];
  fs.writeFileSync(path.join(f.home, 'tools.json'), JSON.stringify(data));

  const set1 = jobToolset(loadManifest(f.home), 'fake', 'openai-api', 'advice');
  const host1 = await mcpTools(set1, { dir: f.base });
  try {
    const dumped1 = JSON.parse(fs.readFileSync(envFile, 'utf8'));
    assert.equal(dumped1.hasPath, true);
    if (process.platform === 'win32') assert.equal(dumped1.hasSystemRoot, true);
    assert.equal(dumped1.custom, null);
  } finally { host1.close(); }

  data.servers.fake_mcp.env = { AC_TEST_VAR: 'custom-val' };
  fs.writeFileSync(path.join(f.home, 'tools.json'), JSON.stringify(data));
  const set2 = jobToolset(loadManifest(f.home), 'fake', 'openai-api', 'advice');
  const host2 = await mcpTools(set2, { dir: f.base });
  try {
    const dumped2 = JSON.parse(fs.readFileSync(envFile, 'utf8'));
    assert.equal(dumped2.hasPath, true);
    if (process.platform === 'win32') assert.equal(dumped2.hasSystemRoot, true);
    assert.equal(dumped2.custom, 'custom-val');
  } finally { host2.close(); }
});
