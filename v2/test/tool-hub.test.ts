import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync, existsSync, lstatSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { applyInstall, claudeToolsetConfig, codexServerNames, codexServerToml, hubStatus, jobToolset, loadManifest, parseManifest, planInstall, toolsAirLines, toolsSummaryLine, type HubEnv } from '../src/tool-hub.ts';
import { Store, type Actor } from './fixtures/service.ts';
import { codexArgs } from '../src/adapters/codex.ts';
import { claudeArgs } from '../src/adapters/claude.ts';

const closers: Array<() => void> = [];
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'ac-hub-'));
  t.after(() => { while (closers.length) closers.pop()!(); rmSync(root, { recursive: true, force: true }); });
  const home = join(root, 'ac'), user = join(root, 'user'), skills = join(root, 'skills');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(root, 'proj'));
  for (const name of ['blender-3d', 'playwright']) {
    mkdirSync(join(skills, name), { recursive: true });
    writeFileSync(join(skills, name, 'SKILL.md'), `---\nname: ${name}\ndescription: Does ${name} things.\n---\nBody\n`);
  }
  mkdirSync(join(skills, 'not-a-skill'));
  const manifest = {
    schema: 1, skills_root: skills,
    servers: {
      blender_3d: { description: 'Local Blender', command: 'C:\\py\\python.exe', args: ['-B', 'C:\\b\\blender3d.py', 'mcp'], cwd: 'C:\\b', env: { BLENDER_MCP_SAFE_MODE: '1' }, apps: ['codex', 'claude', 'antigravity'] },
      google_ro: { command: 'pwsh.exe', args: [], apps: ['codex'] },
    },
    clis: { blender3d: { path: join(root, 'missing.cmd'), description: 'Blender CLI' } },
  };
  writeFileSync(join(root, 'tools.json'), JSON.stringify(manifest));
  writeFileSync(join(home, 'tools.json'), JSON.stringify({ manifest: join(root, 'tools.json') }));
  // Codex already has both servers and one linked skill; Claude has an unrelated server and a real (unlinked) folder.
  mkdirSync(join(user, '.codex', 'skills'), { recursive: true });
  writeFileSync(join(user, '.codex', 'config.toml'), 'model = "x"\n\n[mcp_servers.blender_3d]\ncommand = "a"\n\n[mcp_servers.blender_3d.env]\nA = "1"\n\n[mcp_servers.google_ro]\ncommand = "b"\n');
  symlinkSync(join(skills, 'blender-3d'), join(user, '.codex', 'skills', 'blender-3d'), 'junction');
  mkdirSync(join(user, '.claude', 'skills', 'playwright'), { recursive: true });
  writeFileSync(join(user, '.claude.json'), JSON.stringify({ mcpServers: { 'agent-commons': {} }, other: 1 }));
  mkdirSync(join(user, '.gemini', 'config', 'plugins', 'gemini-api'), { recursive: true });
  writeFileSync(join(user, '.gemini', 'config', 'plugins', 'gemini-api', 'mcp_config.json'), JSON.stringify({ mcpServers: { 'gemini-api-docs': {} } }));
  const runs: string[][] = [];
  const env: HubEnv = { userHome: user, run: (command, args) => { runs.push([command, ...args]); return { status: 0, stdout: '', stderr: '' }; } };
  return { root, home, user, skills, env, runs };
}

test('the manifest is found through a pointer and validated', t => {
  const f = fixture(t);
  const m = loadManifest(f.home)!;
  assert.equal(m.skills_root, f.skills);
  assert.deepEqual(Object.keys(m.servers), ['blender_3d', 'google_ro']);
  assert.equal(loadManifest(join(f.root, 'nowhere')), null);
  assert.throws(() => parseManifest({ schema: 1, skills_root: f.skills, servers: { x: { command: 'a', url: 'https://b', apps: [] } } }, 'm'), /exactly one of command or url/);
  assert.throws(() => parseManifest({ schema: 1, skills_root: f.skills, servers: { x: { command: 'a', apps: ['vscode'] } } }, 'm'), /known apps/);
  assert.throws(() => parseManifest({ schema: 2, skills_root: f.skills }, 'm'), /schema/);
});

test('status reports each app: linked, missing and conflicting skills; configured and missing servers', t => {
  const f = fixture(t);
  const s = hubStatus(loadManifest(f.home)!, f.env);
  assert.deepEqual(s.skills.map(x => x.name), ['blender-3d', 'playwright']);
  assert.deepEqual(s.skills[0].apps, { codex: 'ok', claude: 'missing', antigravity: 'missing' });
  assert.equal(s.skills[1].apps.claude, 'conflict', 'a real folder is never treated as the shared skill');
  assert.deepEqual(s.servers[0].apps, { codex: 'ok', claude: 'missing', antigravity: 'missing' });
  assert.deepEqual(s.servers[1].apps, { codex: 'ok', claude: 'not-wanted', antigravity: 'not-wanted' });
  assert.equal(s.clis[0].exists, false);
  const lines = toolsAirLines(s, null, 1000);
  assert.match(lines[0], /^@air1 tools .*skills=2 servers=2 clis=1/);
  assert.ok(lines.some(l => /^V blender_3d apps=codex:ok,claude:missing,ag:missing /.test(l)));
  assert.ok(lines.some(l => l === 'V google_ro apps=codex:ok cmd=pwsh.exe ""'));
  const one = toolsAirLines(s, 'blender_3d', 1000).join('\n');
  assert.match(one, /env=BLENDER_MCP_SAFE_MODE/);
  assert.doesNotMatch(one, /BLENDER_MCP_SAFE_MODE=1|"1"/, 'env values are never shown');
  assert.throws(() => toolsAirLines(s, 'nope', 100), /NOT_FOUND/);
  assert.match(toolsSummaryLine(s), /^X tools skills=2 servers=2 clis=1 missing=claude:3,ag:3,codex:1 /, "codex lacks the playwright link");
});

test('claude install links skills, skips conflicts, adds servers through its CLI and backs up its config', t => {
  const f = fixture(t);
  const m = loadManifest(f.home)!;
  const plan = planInstall(m, 'claude', f.env);
  assert.deepEqual(plan.map(a => a.kind), ['junction', 'run'], 'playwright (conflict) is left alone; google_ro is not wanted');
  const run = plan[1] as Extract<typeof plan[number], { kind: 'run' }>;
  assert.deepEqual(run.args.slice(0, 5), ['mcp', 'add-json', '--scope', 'user', 'blender_3d']);
  assert.deepEqual(JSON.parse(run.args[5]), { type: 'stdio', command: 'C:\\py\\python.exe', args: ['-B', 'C:\\b\\blender3d.py', 'mcp'], env: { BLENDER_MCP_SAFE_MODE: '1' } });
  const backups = join(f.home, 'backups', 'b1');
  applyInstall(plan, f.env, backups);
  assert.ok(lstatSync(join(f.user, '.claude', 'skills', 'blender-3d')).isSymbolicLink());
  assert.equal(f.runs.length, 1);
  assert.deepEqual(readdirSync(backups).length, 1, 'the Claude config was copied before its CLI ran');
  assert.deepEqual(planInstall(m, 'claude', f.env).map(a => a.kind), ['run'], 'skills are now linked (the server needs the real CLI)');
});

test('antigravity install creates one managed plugin that links every skill and holds the servers', t => {
  const f = fixture(t);
  const m = loadManifest(f.home)!;
  const plan = planInstall(m, 'antigravity', f.env);
  assert.deepEqual(plan.map(a => a.kind), ['write', 'junction', 'write']);
  applyInstall(plan, f.env, join(f.home, 'backups', 'b2'));
  const plugin = join(f.user, '.gemini', 'config', 'plugins', 'shared-tools');
  assert.ok(existsSync(join(plugin, 'skills', 'playwright', 'SKILL.md')));
  const cfg = JSON.parse(readFileSync(join(plugin, 'mcp_config.json'), 'utf8'));
  assert.deepEqual(Object.keys(cfg.mcpServers), ['blender_3d']);
  assert.equal(cfg.mcpServers.blender_3d.cwd, 'C:\\b');
  assert.deepEqual(planInstall(m, 'antigravity', f.env), [], 'a second run has nothing to do');
  const s = hubStatus(m, f.env);
  assert.deepEqual(s.skills.map(x => x.apps.antigravity), ['ok', 'ok']);
  assert.equal(s.servers[0].apps.antigravity, 'ok');
});

test('codex install appends only missing servers and never rewrites existing entries', t => {
  const f = fixture(t);
  const m = loadManifest(f.home)!;
  const before = readFileSync(join(f.user, '.codex', 'config.toml'), 'utf8');
  assert.deepEqual(planInstall(m, 'codex', f.env).map(a => a.kind), ['junction'], 'servers already configured; one skill to link');
  const extra = parseManifest({ ...JSON.parse(readFileSync(join(f.root, 'tools.json'), 'utf8')),
    servers: { docs: { url: 'https://example.test/mcp', apps: ['codex'] }, blender_3d: { command: 'x', apps: ['codex'] } } }, 'm');
  const plan = planInstall(extra, 'codex', f.env, new Set(['docs']));
  assert.deepEqual(plan.map(a => a.kind), ['append']);
  applyInstall(plan, f.env, join(f.home, 'backups', 'b3'));
  const after = readFileSync(join(f.user, '.codex', 'config.toml'), 'utf8');
  assert.ok(after.startsWith(before), 'existing text unchanged');
  assert.match(after, /\[mcp_servers\.docs\]\nurl = "https:\/\/example\.test\/mcp"/);
  assert.match(codexServerToml('b', { command: 'C:\\a b\\p.exe', args: ['x'], env: { K: 'v' }, apps: ['codex'] }), /command = "C:\\\\a b\\\\p\.exe"\nargs = \["x"\]\n\n\[mcp_servers\.b\.env\]\nK = "v"/);
});

test('air_get tools and the snapshot summary line', t => {
  const f = fixture(t);
  const store = new Store(f.home);
  closers.push(() => store.close());
  store.toolsEnv = f.env;
  store.createActor('claude-desktop', 'participant', 'claude-desktop');
  const actor: Actor = { id: 'claude-desktop', name: 'claude-desktop', role: 'participant' };
  const project = (store.op_project_create(actor, { name: 'P', root: join(f.root, 'proj') }) as any).project;
  const got = store.op_air_get(actor, { handles: 'tools,tools:blender-3d,t999' }).air as string;
  assert.match(got, /^@air1 get n=3\n@air1 tools /);
  assert.match(got, /\nS blender-3d apps=codex:ok,claude:missing,ag:missing path=/);
  const sync = store.op_air_sync(actor, { project_id: project.id, since_seq: 0, advance_cursor: false }).air as string;
  assert.match(sync, /\nX tools skills=2 servers=2 clis=1 missing=/);
});

test('without a manifest nothing changes: no summary line, and air_get tools says so', t => {
  const root = mkdtempSync(join(tmpdir(), 'ac-hub-none-'));
  const store = new Store(root);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  store.createActor('claude-desktop', 'participant', 'claude-desktop');
  const actor: Actor = { id: 'claude-desktop', name: 'claude-desktop', role: 'participant' };
  assert.match(store.op_air_get(actor, { handles: 'tools' }).air as string, /! tools err=TOOLS_MANIFEST_MISSING/);
});

test('review fixes: TOML table detection, dotted server names, and --only never shrinks the Antigravity plugin', t => {
  assert.deepEqual([...codexServerNames('[mcp_servers.a]\n  [ mcp_servers . "b" ] # note\n[mcp_servers.\'c\']\n[mcp_servers.a.env]\n[other]\n')], ['a', 'b', 'c']);
  const f = fixture(t);
  assert.throws(() => parseManifest({ schema: 1, skills_root: f.skills, servers: { 'a.b': { command: 'x', apps: [] } } }, 'm'), /not allowed/);
  const data = JSON.parse(readFileSync(join(f.root, 'tools.json'), 'utf8'));
  data.servers.second = { command: 'two.exe', apps: ['antigravity'] };
  writeFileSync(join(f.root, 'tools.json'), JSON.stringify(data));
  const m = loadManifest(f.home)!;
  applyInstall(planInstall(m, 'antigravity', f.env), f.env, join(f.home, 'backups', 'b4'));
  const file = join(f.user, '.gemini', 'config', 'plugins', 'shared-tools', 'mcp_config.json');
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8')).mcpServers), ['blender_3d', 'second']);
  assert.deepEqual(planInstall(m, 'antigravity', f.env, new Set(['blender_3d'])), [], 'an --only run keeps the other managed server');
});

test('a write through a symlinked config keeps the link', t => {
  const f = fixture(t);
  const real = join(f.root, 'dotfiles', 'config.toml');
  mkdirSync(join(f.root, 'dotfiles'));
  writeFileSync(real, 'model = "x"\n');
  const link = join(f.user, '.codex', 'config.toml');
  rmSync(link);
  try { symlinkSync(real, link, 'file'); } catch { t.skip('file symlinks need Developer Mode on Windows'); return; }
  applyInstall([{ kind: 'append', path: link, content: '\n[mcp_servers.z]\ncommand = "z"\n', why: 'test' }], f.env, join(f.home, 'backups', 'b5'));
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.match(readFileSync(real, 'utf8'), /\[mcp_servers\.z\]/);
});

// ---- Tool sets for Agent Commons jobs (option B) ---------------------------------------------------------------------

function withToolset(f: ReturnType<typeof fixture>, extra: Record<string, unknown> = {}) {
  const data = JSON.parse(readFileSync(join(f.root, 'tools.json'), 'utf8'));
  data.toolsets = { blender: { server: 'blender_3d', routes: ['codex', 'claude'], advice_tools: ['get_scene_info', 'session_start'],
    edit_tools: ['execute_blender_code'], max_concurrent: 2, write_roots: ['C:\\Fixtures\\AgentCommons'], ...extra } };
  writeFileSync(join(f.root, 'tools.json'), JSON.stringify(data));
  return loadManifest(f.home)!;
}

test('tool sets: validation, per-mode tools, route limits and a stable hash', t => {
  const f = fixture(t);
  const m = withToolset(f);
  const advice = jobToolset(m, 'blender', 'codex', 'advice'), edit = jobToolset(m, 'blender', 'claude', 'edit');
  assert.deepEqual(advice.tools, ['get_scene_info', 'session_start'], 'advice jobs never get the code tool');
  assert.deepEqual(advice.write_roots, [], 'advice jobs get no extra write roots');
  assert.deepEqual(edit.tools, ['get_scene_info', 'session_start', 'execute_blender_code']);
  assert.deepEqual(edit.write_roots, ['C:\\Fixtures\\AgentCommons']);
  assert.equal(advice.sha256, jobToolset(m, 'blender', 'codex', 'advice').sha256);
  assert.notEqual(advice.sha256, edit.sha256);
  assert.throws(() => jobToolset(m, 'blender', 'openai-api', 'advice'), /runs only on codex, claude/);
  assert.throws(() => jobToolset(m, 'nope', 'codex', 'advice'), /no approved tool set/);
  assert.throws(() => jobToolset(null, 'blender', 'codex', 'advice'), /needs a shared tool manifest/);
  assert.throws(() => withToolset(f, { routes: ['antigravity'] }), /routes must list/);
  assert.throws(() => withToolset(f, { server: 'missing' }), /unknown server/);
  assert.throws(() => withToolset(f, { max_concurrent: 0 }), /max_concurrent/);
  const onlyEdit = withToolset(f, { advice_tools: [] });
  assert.throws(() => jobToolset(onlyEdit, 'blender', 'codex', 'advice'), /grants no tools to advice jobs/);
});

test('tool sets: Codex gets only the one server through -c overrides; Claude through a strict per-job config', t => {
  const f = fixture(t);
  const ts = jobToolset(withToolset(f), 'blender', 'codex', 'edit');
  const args = codexArgs({ file: 'codex.exe' }, { mode: 'edit', options: { toolset: ts } }, 'C:\\w', 'C:\\d');
  assert.ok(args.includes('--ignore-user-config'), 'the user config stays out');
  const c = args.filter((_, i) => args[i - 1] === '-c');
  assert.ok(c.includes('mcp_servers.blender_3d.command="C:\\\\py\\\\python.exe"'));
  assert.ok(c.includes('mcp_servers.blender_3d.args=["-B","C:\\\\b\\\\blender3d.py","mcp"]'));
  assert.ok(c.includes('mcp_servers.blender_3d.env={BLENDER_MCP_SAFE_MODE="1"}'));
  assert.ok(c.includes('mcp_servers.blender_3d.enabled_tools=["get_scene_info","session_start","execute_blender_code"]'));
  assert.ok(c.includes('mcp_servers.blender_3d.tools.execute_blender_code.approval_mode="approve"'));
  assert.deepEqual(args.slice(args.indexOf('--add-dir'), args.indexOf('--add-dir') + 2), ['--add-dir', 'C:\\Fixtures\\AgentCommons']);
  assert.ok(!codexArgs({ file: 'codex.exe' }, { mode: 'advice', options: {} }, 'C:\\w', 'C:\\d').some(a => a.includes('mcp_servers')), 'no tool set, no servers');

  const advice = jobToolset(withToolset(f), 'blender', 'claude', 'advice');
  const cargs = claudeArgs({ file: 'claude.exe' }, { mode: 'advice', options: { toolset: advice } }, 'C:\\d\\mcp-toolset.json');
  assert.ok(cargs.includes('--strict-mcp-config'));
  assert.equal(cargs[cargs.indexOf('--mcp-config') + 1], 'C:\\d\\mcp-toolset.json');
  const allowed = cargs.slice(cargs.indexOf('--allowedTools'), cargs.indexOf('--disallowedTools'));
  assert.ok(allowed.includes('mcp__blender_3d__get_scene_info') && !allowed.includes('mcp__blender_3d__execute_blender_code'));
  assert.deepEqual(cargs.slice(cargs.indexOf('--disallowedTools'), cargs.indexOf('--disallowedTools') + 2), ['--disallowedTools', 'mcp__blender_3d__execute_blender_code'],
    'the code tool is denied outright, so user or project allow rules cannot re-enable it');
  assert.ok(!cargs.includes('--add-dir'), 'advice jobs get no write roots');
  const editSet = jobToolset(withToolset(f), 'blender', 'claude', 'edit');
  const eargs = claudeArgs({ file: 'claude.exe' }, { mode: 'edit', options: { toolset: editSet } }, 'C:\\d\\mcp-toolset.json');
  assert.ok(!eargs.includes('--disallowedTools'));
  assert.deepEqual(eargs.slice(eargs.indexOf('--add-dir'), eargs.indexOf('--add-dir') + 2), ['--add-dir', 'C:\\Fixtures\\AgentCommons']);
  assert.throws(() => jobToolset(withToolset(f), 'toString', 'claude', 'advice'), /no approved tool set/, 'prototype names are unknown sets, not a crash');
  assert.deepEqual(Object.keys(JSON.parse(claudeToolsetConfig(advice)).mcpServers), ['blender_3d']);
  assert.ok(!claudeArgs({ file: 'claude.exe' }, { mode: 'advice', options: {} }).includes('--mcp-config'));
});

test('tool sets: submit snapshots the set, and admission holds a third Blender job across routes', t => {
  const f = fixture(t);
  withToolset(f);
  const store = new Store(f.home);
  closers.push(() => store.close());
  store.createActor('claude-desktop', 'participant', 'claude-desktop');
  const actor: Actor = { id: 'claude-desktop', name: 'claude-desktop', role: 'participant' };
  const project = (store.op_project_create(actor, { name: 'P', root: join(f.root, 'proj') }) as any).project;
  const submit = (route: string, mode = 'advice') => store.op_job_submit(actor, { project_id: project.id, route, mode, prompt: 'look', tools: 'blender' }).job;
  const a = submit('codex'), b = submit('claude', 'edit'), c = submit('codex'), plain = store.op_job_submit(actor, { project_id: project.id, route: 'codex', prompt: 'x' }).job;
  const opts = (id: string) => store.jobRecord(id)!.options;
  assert.equal(opts(a.id).toolset.name, 'blender');
  assert.match(opts(b.id).toolset.sha256, /^[0-9a-f]{64}$/);
  assert.ok(opts(b.id).toolset.tools.includes('execute_blender_code'));
  assert.equal(opts(plain.id).toolset, undefined);
  assert.throws(() => submit('openai-api'), /runs only on codex, claude/);
  const limits = { codex: 5, claude: 5 };
  const claimed = [store.claimQueuedJob(limits, 10)?.id, store.claimQueuedJob(limits, 10)?.id, store.claimQueuedJob(limits, 10)?.id];
  assert.deepEqual(claimed, [a.id, b.id, plain.id], 'the third Blender job waits; the plain job behind it still starts');
  assert.equal(store.claimQueuedJob(limits, 10), null);
  store.updateJob(a.id, { status: 'completed', finished_at: new Date().toISOString() });
  assert.equal(store.claimQueuedJob(limits, 10)?.id, c.id, 'it starts once a Blender slot frees');
  assert.match(store.op_air_get(actor, { handles: 'tools' }).air as string, /^@air1 get n=1/);
});
test('air_get tools lists approved tool sets as K lines, and tools:<set> answers for one', t => {
  const f = fixture(t);
  const s = hubStatus(withToolset(f), f.env);
  const all = toolsAirLines(s, null, 1000);
  const blenderLine = all.find(l => l.startsWith('K blender '));
  assert.ok(blenderLine && /^K blender server=blender_3d routes=codex,claude advice=get_scene_info,session_start edit=execute_blender_code max=2 sha=[0-9a-f]{12} roots="C:\\\\Fixtures\\\\AgentCommons" ""$/.test(blenderLine), all.join('\n'));
  assert.match(toolsAirLines(s, 'blender', 1000).join('\n'), /^K blender server=blender_3d /);
  assert.match(toolsSummaryLine(s), / toolsets=1 /);
  // A manifest object containing a shadowed builtin name must not produce duplicate K lines.
  s.manifest.toolsets.project = structuredClone(s.manifest.toolsets.blender);
  assert.equal(toolsAirLines(s, null, 1000).filter(l => l.startsWith('K project ')).length, 1);
});

test('a server marked headless: false is listed but can never be handed to a job', t => {
  const f = fixture(t);
  const data = JSON.parse(readFileSync(join(f.root, 'tools.json'), 'utf8'));
  data.servers.blender_3d.headless = false;
  writeFileSync(join(f.root, 'tools.json'), JSON.stringify(data));
  assert.ok(toolsAirLines(hubStatus(loadManifest(f.home)!, f.env), null, 1000).some(l => /^V blender_3d apps=\S+ headless=0 /.test(l)));
  assert.throws(() => withToolset(f), /needs a desktop session/);
  data.servers.blender_3d.headless = 'no';
  writeFileSync(join(f.root, 'tools.json'), JSON.stringify(data));
  assert.throws(() => loadManifest(f.home), /headless must be true or false/);
});
