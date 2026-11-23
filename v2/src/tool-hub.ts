/**
 * Shared tool hub: one manifest of skills, MCP servers and CLIs that every app can use, and per-app descriptors that
 * know where each app keeps its skills and MCP configuration.
 *
 * The manifest is a plain JSON file (readable without Agent Commons). AC finds it through <home>/tools.json, which is
 * either the manifest itself or a pointer {"manifest": "<path>"}. Skills live once in skills_root; apps reach them
 * through directory junctions (Codex, Claude Code) or a local plugin whose skills folder is a junction (Antigravity).
 *
 * Reading never changes anything. planInstall() lists actions; applyInstall() performs them with a backup of every file
 * it replaces, touches only entries named in the manifest, and never deletes or rewrites an app's other entries.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fail } from './errors.ts';
import { q } from './air/format.ts';

export interface ToolServer {
  description?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  /** Non-secret environment only. AIR output shows the keys, never the values. */
  env?: Record<string, string>;
  /** Remote (HTTP) server instead of a command. */
  url?: string;
  /** Apps this server should be configured in. */
  apps: string[];
  /** false: needs a desktop session (a window, a signed-in browser), so it is listed but never handed to a headless job. */
  headless?: boolean;
}
export interface ToolCli { path: string; description?: string }
/**
 * An operator-approved tool set that Agent Commons jobs may ask for (job tools=<name>). Listing it in the manifest is
 * the approval. A job gets only this server and only the tools for its mode; edit_tools usually adds the tools that
 * run code or change files, so advice jobs never get them.
 */
export interface Toolset {
  description?: string;
  server: string;
  routes: string[];
  advice_tools: string[];
  edit_tools: string[];
  /** Jobs using this set that may run at once, across all routes. */
  max_concurrent: number;
  /** Extra folders an edit job's sandbox may write (Codex --add-dir). */
  write_roots: string[];
  /**
   * Lock files of the server's own process slots (the Blender wrapper's blender-N.lock). A queued job waits while every
   * listed slot is held by another process.
   */
  slot_locks: string[];
}
/** Routes whose workers can be handed one tool set for one job (openai-api: AC runs the tools itself). */
export const TOOLSET_ROUTES = ['codex', 'claude', 'openai-api'];
/** Built-in tool sets that need no manifest server. AC runs them in-process. */
export const BUILTIN_TOOLSETS: Record<string, Toolset> = {
  project: { description: 'Read-only project files for API jobs: read_file, grep and list_dir inside the job folder, with the ctx= file rules.',
    server: 'builtin', routes: ['openai-api'], advice_tools: ['read_file', 'grep', 'list_dir'], edit_tools: [], max_concurrent: 8, write_roots: [], slot_locks: [] },
};
export const isBuiltinToolset = (name: string) => Object.hasOwn(BUILTIN_TOOLSETS, name);
/** An approved tool set by name: built-in first (manifest entries cannot shadow them), then the manifest. */
export function findToolset(manifest: ToolManifest | null, name: string): Toolset | undefined {
  return isBuiltinToolset(name) ? BUILTIN_TOOLSETS[name] : manifest && Object.hasOwn(manifest.toolsets, name) ? manifest.toolsets[name] : undefined;
}
/** The definition hash listed by air_get tools and recorded in each job's receipt: the set plus its server's launch spec. */
export function toolsetDefinitionHash(manifest: ToolManifest | null, name: string, set: Toolset): string {
  const server = isBuiltinToolset(name) ? undefined : manifest?.servers[set.server];
  const spec = server ? { command: server.command, args: server.args ?? [], cwd: server.cwd, env: server.env } : { builtin: name, version: 1 };
  return createHash('sha256').update(JSON.stringify({ name, set: { ...set, description: undefined }, server: spec })).digest('hex');
}
export interface ToolManifest {
  schema: 1;
  skills_root: string;
  servers: Record<string, ToolServer>;
  clis: Record<string, ToolCli>;
  toolsets: Record<string, Toolset>;
  /** Where the manifest was read from. */
  path: string;
}
export interface Skill { name: string; description: string }

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Server names become bare TOML keys and MCP tool prefixes, so no dots. */
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** The manifest's path, or null when this home has no tools.json. */
export function manifestPath(home: string): string | null {
  const file = path.join(home, 'tools.json');
  if (!fs.existsSync(file)) return null;
  let data: any;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fail('TOOLS_MANIFEST_INVALID', 400, `${file} is not valid JSON`); }
  return typeof data?.manifest === 'string' ? path.resolve(path.dirname(file), data.manifest) : file;
}

export function parseManifest(data: any, file: string): ToolManifest {
  const bad = (why: string): never => fail('TOOLS_MANIFEST_INVALID', 400, `${file}: ${why}`);
  if (!data || typeof data !== 'object') bad('not an object');
  if (data.schema !== 1) bad('schema must be 1');
  if (typeof data.skills_root !== 'string' || !path.isAbsolute(data.skills_root)) bad('skills_root must be an absolute path');
  const servers: Record<string, ToolServer> = {}, clis: Record<string, ToolCli> = {};
  for (const [name, s] of Object.entries<any>(data.servers ?? {})) {
    if (!SERVER_NAME.test(name)) bad(`server name ${JSON.stringify(name)} is not allowed (letters, digits, _ and -)`);
    if (!s || typeof s !== 'object') bad(`server ${name} is not an object`);
    if (!!s.command === !!s.url) bad(`server ${name} needs exactly one of command or url`);
    if (s.command !== undefined && typeof s.command !== 'string') bad(`server ${name} command must be a string`);
    if (s.url !== undefined && (typeof s.url !== 'string' || !/^https?:\/\//.test(s.url))) bad(`server ${name} url must be http(s)`);
    if (s.args !== undefined && (!Array.isArray(s.args) || s.args.some((a: unknown) => typeof a !== 'string'))) bad(`server ${name} args must be strings`);
    if (s.cwd !== undefined && typeof s.cwd !== 'string') bad(`server ${name} cwd must be a string`);
    if (s.headless !== undefined && typeof s.headless !== 'boolean') bad(`server ${name} headless must be true or false`);
    if (s.env !== undefined && (s.env === null || typeof s.env !== 'object' || Array.isArray(s.env) || Object.values(s.env).some(v => typeof v !== 'string'))) bad(`server ${name} env values must be strings`);
    if (!Array.isArray(s.apps) || s.apps.some((a: unknown) => typeof a !== 'string' || !Object.hasOwn(APPS, a as string))) bad(`server ${name} apps must list known apps (${Object.keys(APPS).join(', ')})`);
    servers[name] = { description: s.description, command: s.command, args: s.args, cwd: s.cwd, env: s.env, url: s.url, apps: s.apps, ...(s.headless === false ? { headless: false } : {}) };
  }
  for (const [name, c] of Object.entries<any>(data.clis ?? {})) {
    if (!NAME.test(name)) bad(`cli name ${JSON.stringify(name)} is not allowed`);
    if (!c || typeof c.path !== 'string') bad(`cli ${name} needs a path`);
    clis[name] = { path: c.path, description: c.description };
  }
  const toolsets: Record<string, Toolset> = {};
  const toolNames = (v: unknown, what: string) => {
    if (!Array.isArray(v) || v.some(x => typeof x !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(x))) bad(`${what} must be a list of tool names`);
    return v as string[];
  };
  for (const [name, t] of Object.entries<any>(data.toolsets ?? {})) {
    if (!SERVER_NAME.test(name)) bad(`toolset name ${JSON.stringify(name)} is not allowed`);
    if (isBuiltinToolset(name)) bad(`toolset name ${name} is built in`);
    if (!t || typeof t !== 'object') bad(`toolset ${name} is not an object`);
    const server = (typeof t.server === 'string' && Object.hasOwn(servers, t.server) ? servers[t.server] : undefined) as ToolServer;
    if (!server) bad(`toolset ${name} names unknown server ${JSON.stringify(t.server)}`);
    if (!server.command) bad(`toolset ${name}: only command (stdio) servers can be handed to jobs`);
    if (server.headless === false) bad(`toolset ${name}: server ${t.server} needs a desktop session (headless: false), so jobs cannot use it`);
    if (!Array.isArray(t.routes) || !t.routes.length || t.routes.some((r: unknown) => !TOOLSET_ROUTES.includes(r as string))) bad(`toolset ${name} routes must list ${TOOLSET_ROUTES.join(' or ')}`);
    const advice = toolNames(t.advice_tools ?? [], `toolset ${name} advice_tools`), edit = toolNames(t.edit_tools ?? [], `toolset ${name} edit_tools`);
    if (!advice.length && !edit.length) bad(`toolset ${name} grants no tools`);
    if (!Number.isInteger(t.max_concurrent) || t.max_concurrent < 1 || t.max_concurrent > 8) bad(`toolset ${name} max_concurrent must be 1-8`);
    const roots = t.write_roots ?? [];
    if (!Array.isArray(roots) || roots.some((r: unknown) => typeof r !== 'string' || !path.isAbsolute(r))) bad(`toolset ${name} write_roots must be absolute paths`);
    const locks = t.slot_locks ?? [];
    if (!Array.isArray(locks) || locks.length > 8 || locks.some((r: unknown) => typeof r !== 'string' || !path.isAbsolute(r))) bad(`toolset ${name} slot_locks must be up to 8 absolute paths`);
    toolsets[name] = { description: t.description, server: t.server, routes: t.routes, advice_tools: advice, edit_tools: edit, max_concurrent: t.max_concurrent, write_roots: roots, slot_locks: locks };
  }
  return { schema: 1, skills_root: data.skills_root, servers, clis, toolsets, path: file };
}

export function loadManifest(home: string): ToolManifest | null {
  const file = manifestPath(home);
  if (!file) return null;
  let data: any;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error: any) { return fail('TOOLS_MANIFEST_INVALID', 400, `${file}: ${error?.code === 'ENOENT' ? 'not found' : 'not valid JSON'}`); }
  return parseManifest(data, file);
}

/** Every folder in skills_root with a SKILL.md, with the name and description from its front matter. */
export function listSkills(manifest: ToolManifest): Skill[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(manifest.skills_root, { withFileTypes: true }); } catch { return []; }
  const skills: Skill[] = [];
  for (const entry of entries) {
    if (!NAME.test(entry.name)) continue;
    const file = path.join(manifest.skills_root, entry.name, 'SKILL.md');
    let content: string;
    try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1] ?? '';
    const field = (key: string) => new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(front)?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '';
    skills.push({ name: entry.name, description: field('description') });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

// ---- Per-app descriptors ----------------------------------------------------------------------------------------

export interface HubEnv {
  /** The user profile the apps run under. */
  userHome: string;
  /** Runs an app CLI (Claude's `claude mcp add-json`). Injected by tests. */
  run?: (command: string, args: string[]) => { status: number | null; stdout: string; stderr: string };
}
export type Action =
  | { kind: 'junction'; path: string; target: string; why: string }
  | { kind: 'write'; path: string; content: string; why: string }
  | { kind: 'append'; path: string; content: string; why: string }
  | { kind: 'run'; command: string; args: string[]; why: string; backsUp?: string };
export type State = 'ok' | 'missing' | 'conflict';

interface AppDescriptor {
  skill(env: HubEnv, m: ToolManifest, name: string): State;
  servers(env: HubEnv): Set<string>;
  /** only: limit servers to these names (skills arrive already filtered). */
  plan(env: HubEnv, m: ToolManifest, skills: Skill[], only?: Set<string>): Action[];
}

/** ok when `link` is a junction or symlink resolving to `target`; conflict when something else is there. */
function linkState(link: string, target: string): State {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(link); } catch (error: any) { return error?.code === 'ENOENT' ? 'missing' : 'conflict'; }
  if (!stat.isSymbolicLink()) return 'conflict';
  try { return samePath(fs.realpathSync(link), fs.realpathSync(target)) ? 'ok' : 'conflict'; } catch { return 'conflict'; }
}
const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const readJson = (file: string): any => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; } };
const wanted = (m: ToolManifest, app: string, only?: Set<string>) => Object.entries(m.servers).filter(([n, s]) => s.apps.includes(app) && (!only || only.has(n)));
/** Table names in a Codex config.toml: [mcp_servers.x], quoted keys, inner spaces and trailing comments. */
export function codexServerNames(toml: string): Set<string> {
  return new Set([...toml.matchAll(/^[ \t]*\[[ \t]*mcp_servers[ \t]*\.[ \t]*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))[ \t]*\][ \t]*(?:#.*)?$/gm)]
    .map(m => m[1] ?? m[2] ?? m[3]));
}

/** Per-skill junctions in one skills folder (Codex, Claude Code). */
function perSkill(dir: (env: HubEnv) => string) {
  return {
    skill: (env: HubEnv, m: ToolManifest, name: string) => linkState(path.join(dir(env), name), path.join(m.skills_root, name)),
    plan: (env: HubEnv, m: ToolManifest, skills: Skill[]): Action[] => skills
      .filter(s => linkState(path.join(dir(env), s.name), path.join(m.skills_root, s.name)) === 'missing')
      .map(s => ({ kind: 'junction', path: path.join(dir(env), s.name), target: path.join(m.skills_root, s.name), why: `skill ${s.name}` })),
  };
}

const tomlString = (value: string) => JSON.stringify(value);
export function codexServerToml(name: string, s: ToolServer): string {
  const lines = ['', `# Added by Agent Commons tools-install from the shared tool manifest.`, `[mcp_servers.${name}]`];
  if (s.url) lines.push(`url = ${tomlString(s.url)}`);
  else {
    lines.push(`command = ${tomlString(s.command!)}`);
    if (s.args?.length) lines.push(`args = [${s.args.map(tomlString).join(', ')}]`);
    if (s.cwd) lines.push(`cwd = ${tomlString(s.cwd)}`);
  }
  if (s.env && Object.keys(s.env).length) {
    lines.push('', `[mcp_servers.${name}.env]`);
    for (const [k, v] of Object.entries(s.env)) lines.push(`${/^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k)} = ${tomlString(v)}`);
  }
  return lines.join('\n') + '\n';
}

const codexConfig = (env: HubEnv) => path.join(env.userHome, '.codex', 'config.toml');
const claudeConfig = (env: HubEnv) => path.join(env.userHome, '.claude.json');
const agConfig = (env: HubEnv) => path.join(env.userHome, '.gemini', 'config');
const agPlugin = (env: HubEnv) => path.join(agConfig(env), 'plugins', 'shared-tools');

export function claudeServerJson(s: ToolServer): string {
  // Claude Code's stdio entries take command, args and env (no cwd); servers must not depend on their cwd.
  return JSON.stringify(s.url ? { type: 'http', url: s.url } : { type: 'stdio', command: s.command, args: s.args ?? [], ...(s.env ? { env: s.env } : {}) });
}
export function agServerEntry(s: ToolServer): Record<string, unknown> {
  return s.url ? { serverUrl: s.url } : { command: s.command, args: s.args ?? [], ...(s.cwd ? { cwd: s.cwd } : {}), ...(s.env ? { env: s.env } : {}) };
}

/** MCP server names Antigravity loads: its global mcp_config.json and every plugin's (optionally not shared-tools). */
function agServers(env: HubEnv, excludeShared: boolean): Set<string> {
  const names = new Set<string>(Object.keys(readJson(path.join(agConfig(env), 'mcp_config.json'))?.mcpServers ?? {}));
  let plugins: string[] = [];
  try { plugins = fs.readdirSync(path.join(agConfig(env), 'plugins')); } catch { /* none */ }
  for (const p of plugins) {
    if (excludeShared && p === 'shared-tools') continue;
    for (const n of Object.keys(readJson(path.join(agConfig(env), 'plugins', p, 'mcp_config.json'))?.mcpServers ?? {})) names.add(n);
  }
  return names;
}

export const APPS: Record<string, AppDescriptor> = {
  codex: {
    ...perSkill(env => path.join(env.userHome, '.codex', 'skills')),
    servers(env) {
      let text = '';
      try { text = fs.readFileSync(codexConfig(env), 'utf8'); } catch { /* no config */ }
      return codexServerNames(text);
    },
    plan(env, m, skills, only) {
      const have = this.servers(env);
      const missing = wanted(m, 'codex', only).filter(([name]) => !have.has(name));
      return [...perSkill(e => path.join(e.userHome, '.codex', 'skills')).plan(env, m, skills),
        ...(missing.length ? [{ kind: 'append' as const, path: codexConfig(env), content: missing.map(([n, s]) => codexServerToml(n, s)).join(''),
          why: `MCP ${missing.map(([n]) => n).join(', ')}` }] : [])];
    },
  },
  claude: {
    ...perSkill(env => path.join(env.userHome, '.claude', 'skills')),
    servers(env) { return new Set(Object.keys(readJson(claudeConfig(env))?.mcpServers ?? {})); },
    plan(env, m, skills, only) {
      const have = this.servers(env);
      return [...perSkill(e => path.join(e.userHome, '.claude', 'skills')).plan(env, m, skills),
        ...wanted(m, 'claude', only).filter(([name]) => !have.has(name)).map(([name, s]) => ({ kind: 'run' as const, command: 'claude',
          args: ['mcp', 'add-json', '--scope', 'user', name, claudeServerJson(s)], why: `MCP ${name}`, backsUp: claudeConfig(env) }))];
    },
  },
  antigravity: {
    // Antigravity does not scan ~/.gemini/config/skills; it loads skills from plugins, so one local plugin links the
    // whole skills_root and every skill there appears without a per-skill link.
    skill: (env, m, name) => {
      const state = linkState(path.join(agPlugin(env), 'skills'), m.skills_root);
      return state === 'ok' && !fs.existsSync(path.join(m.skills_root, name, 'SKILL.md')) ? 'missing' : state;
    },
    servers(env) { return agServers(env, false); },
    plan(env, m) {
      const dir = agPlugin(env), actions: Action[] = [];
      if (!fs.existsSync(path.join(dir, 'plugin.json'))) actions.push({ kind: 'write', path: path.join(dir, 'plugin.json'), why: 'shared-tools plugin manifest',
        content: JSON.stringify({ name: 'shared-tools', displayName: 'Shared tools', version: '0.1.0',
          description: `Skills and MCP servers from the shared tool manifest (${m.path}). Managed by Agent Commons.` }, null, 2) + '\n' });
      const skills = linkState(path.join(dir, 'skills'), m.skills_root);
      if (skills === 'missing') actions.push({ kind: 'junction', path: path.join(dir, 'skills'), target: m.skills_root, why: 'all shared skills' });
      // The plugin's mcp_config.json belongs to Agent Commons: it mirrors every antigravity server in the whole manifest
      // (never just an --only subset, which would drop the rest) that no other config already provides.
      const file = path.join(dir, 'mcp_config.json');
      const elsewhere = agServers(env, true);
      const desired: Record<string, unknown> = {};
      for (const [name, s] of wanted(m, 'antigravity')) if (!elsewhere.has(name)) desired[name] = agServerEntry(s);
      const content = JSON.stringify({ mcpServers: desired }, null, 2) + '\n';
      let existing: string | undefined;
      try { existing = fs.readFileSync(file, 'utf8'); } catch { /* new */ }
      if ((existing !== undefined || Object.keys(desired).length) && existing !== content) actions.push({ kind: 'write', path: file, content, why: `MCP ${Object.keys(desired).join(', ')}` });
      return actions;
    },
  },
};

// ---- Status, planning, applying -----------------------------------------------------------------------------------

export interface HubStatus {
  manifest: ToolManifest;
  skills: Array<Skill & { apps: Record<string, State> }>;
  servers: Array<{ name: string; server: ToolServer; apps: Record<string, State | 'not-wanted'> }>;
  clis: Array<{ name: string; cli: ToolCli; exists: boolean }>;
}
export function hubStatus(manifest: ToolManifest, env: HubEnv): HubStatus {
  const skills = listSkills(manifest);
  const configured = Object.fromEntries(Object.entries(APPS).map(([app, d]) => [app, d.servers(env)]));
  return {
    manifest,
    skills: skills.map(s => ({ ...s, apps: Object.fromEntries(Object.entries(APPS).map(([app, d]) => [app, d.skill(env, manifest, s.name)])) })),
    servers: Object.entries(manifest.servers).map(([name, server]) => ({ name, server,
      apps: Object.fromEntries(Object.keys(APPS).map(app => [app, configured[app].has(name) ? 'ok' : server.apps.includes(app) ? 'missing' : 'not-wanted'])) })),
    clis: Object.entries(manifest.clis).map(([name, cli]) => ({ name, cli, exists: fs.existsSync(cli.path) })),
  };
}

const short = (app: string) => ({ codex: 'codex', claude: 'claude', antigravity: 'ag' } as Record<string, string>)[app] ?? app;
const appsCell = (apps: Record<string, string>) => Object.entries(apps).filter(([, s]) => s !== 'not-wanted').map(([a, s]) => `${short(a)}:${s}`).join(',');

/** One snapshot line: counts and what is still missing per app. */
export function toolsSummaryLine(status: HubStatus): string {
  const missing: Record<string, number> = {};
  for (const row of [...status.skills, ...status.servers]) for (const [app, s] of Object.entries(row.apps)) if (s === 'missing' || s === 'conflict') missing[short(app)] = (missing[short(app)] ?? 0) + 1;
  const gaps = Object.entries(missing).map(([a, n]) => `${a}:${n}`).join(',');
  const sets = Object.keys(status.manifest.toolsets ?? {}).length;
  return `X tools skills=${status.skills.length} servers=${status.servers.length} clis=${status.clis.length}${sets ? ` toolsets=${sets}` : ''}${gaps ? ` missing=${gaps}` : ''} more="air_get tools"`;
}

/** One K line: an approved tool set (built-in or from the manifest) with its definition hash. */
export function toolsetAirLine(manifest: ToolManifest | null, name: string, set: Toolset, limit = 160): string {
  return `K ${name} server=${q(set.server)} routes=${set.routes.join(',')} advice=${set.advice_tools.map(x => q(x)).join(',') || '-'} edit=${set.edit_tools.map(x => q(x)).join(',') || '-'}`
    + ` max=${set.max_concurrent}${set.slot_locks.length ? ` locks=${set.slot_locks.length}` : ''} sha=${toolsetDefinitionHash(manifest, name, set).slice(0, 12)}`
    + `${set.write_roots.length ? ` roots=${set.write_roots.map(r => q(r, limit)).join(',')}` : ''} ${q(set.description ?? '', limit)}`;
}
const allToolsets = (manifest: ToolManifest | null): Array<[string, Toolset]> => [
  ...Object.entries(BUILTIN_TOOLSETS),
  ...Object.entries(manifest?.toolsets ?? {}).filter(([k]) => !isBuiltinToolset(k)),
];

/** AIR lines for `air_get tools` (everything) or `tools:<name>` (one skill, server, CLI or job tool set in full). */
export function toolsAirLines(status: HubStatus, name: string | null, limit: number): string[] {
  const out: string[] = [];
  const env = (s: ToolServer) => s.env ? ` env=${Object.keys(s.env).join(',')}` : '';
  if (name === null) {
    const sets = allToolsets(status.manifest);
    out.push(`@air1 tools manifest=${q(status.manifest.path)} skills_root=${q(status.manifest.skills_root)} skills=${status.skills.length} servers=${status.servers.length} clis=${status.clis.length} toolsets=${sets.length}`);
    for (const s of status.servers) out.push(`V ${s.name} apps=${appsCell(s.apps)}${s.server.headless === false ? ' headless=0' : ''} ${s.server.url ? `url=${q(s.server.url)}` : `cmd=${q(s.server.command)}`} ${q(s.server.description ?? '', 160)}`);
    for (const c of status.clis) out.push(`X ${c.name} exists=${c.exists ? 1 : 0} path=${q(c.cli.path)} ${q(c.cli.description ?? '', 160)}`);
    for (const s of status.skills) out.push(`S ${s.name} apps=${appsCell(s.apps)} ${q(s.description, 120)}`);
    for (const [n, set] of sets) out.push(toolsetAirLine(status.manifest, n, set));
    return out;
  }
  const server = status.servers.find(s => s.name === name), cli = status.clis.find(c => c.name === name), skill = status.skills.find(s => s.name === name);
  const toolset = findToolset(status.manifest, name);
  if (!server && !cli && !skill && !toolset) return fail('NOT_FOUND');
  if (server) out.push(`V ${server.name} apps=${appsCell(server.apps)}${server.server.headless === false ? ' headless=0' : ''} ${server.server.url ? `url=${q(server.server.url, limit)}` : `cmd=${q(server.server.command, limit)} args=${q(JSON.stringify(server.server.args ?? []), limit)}${server.server.cwd ? ` cwd=${q(server.server.cwd, limit)}` : ''}`}${env(server.server)} ${q(server.server.description ?? '', limit)}`);
  if (cli) out.push(`X ${cli.name} exists=${cli.exists ? 1 : 0} path=${q(cli.cli.path, limit)} ${q(cli.cli.description ?? '', limit)}`);
  if (skill) out.push(`S ${skill.name} apps=${appsCell(skill.apps)} path=${q(path.join(status.manifest.skills_root, skill.name, 'SKILL.md'), limit)} ${q(skill.description, limit)}`);
  if (toolset) out.push(toolsetAirLine(status.manifest, name, toolset, limit));
  return out;
}

export function planInstall(manifest: ToolManifest, app: string, env: HubEnv, only?: Set<string>): Action[] {
  const descriptor = APPS[app] ?? fail('UNKNOWN_APP', 400, `app must be one of ${Object.keys(APPS).join(', ')}`);
  const skills = listSkills(manifest).filter(s => !only || only.has(s.name));
  return descriptor.plan(env, manifest, skills, only);
}

export function describeAction(a: Action): string {
  switch (a.kind) {
    case 'junction': return `link     ${a.path} -> ${a.target}   (${a.why})`;
    case 'write': return `write    ${a.path}   (${a.why})\n${indent(a.content)}`;
    case 'append': return `append   ${a.path}   (${a.why}; existing entries untouched)\n${indent(a.content)}`;
    case 'run': return `run      ${a.command} ${a.args.map(x => /[\s"{}]/.test(x) ? `'${x}'` : x).join(' ')}   (${a.why})`;
  }
}
const indent = (text: string) => text.trimEnd().split('\n').map(line => `           ${line}`).join('\n');

/** Performs the actions in order. Every file it writes or appends to is copied into backupDir first. */
export function applyInstall(actions: Action[], env: HubEnv, backupDir: string): string[] {
  const done: string[] = [];
  const backup = (file: string) => {
    if (!fs.existsSync(file)) return;
    fs.mkdirSync(backupDir, { recursive: true });
    const target = path.join(backupDir, file.replace(/[:\\/]+/g, '_'));
    if (fs.existsSync(target)) return;  // keep the first (original) copy when one run touches a file twice
    fs.copyFileSync(file, target);
    done.push(`backup   ${file} -> ${target}`);
  };
  for (const a of actions) {
    if (a.kind === 'junction') {
      if (fs.existsSync(a.path) || (() => { try { fs.lstatSync(a.path); return true; } catch { return false; } })()) fail('TOOLS_INSTALL_CONFLICT', 409, `${a.path} already exists`);
      fs.mkdirSync(path.dirname(a.path), { recursive: true });
      fs.symlinkSync(a.target, a.path, 'junction');
    } else if (a.kind === 'write' || a.kind === 'append') {
      // Write through a symlinked config (dotfile managers) instead of replacing the link with a file.
      let file = a.path;
      try { if (fs.lstatSync(a.path).isSymbolicLink()) file = fs.realpathSync(a.path); } catch { /* new file */ }
      backup(file);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.ac-tmp-${process.pid}`;
      const content = a.kind === 'append' ? (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '') + a.content : a.content;
      fs.writeFileSync(tmp, content, 'utf8');
      fs.renameSync(tmp, file);
    } else {
      if (a.backsUp) backup(a.backsUp);
      const run = env.run ?? ((command: string, args: string[]) => {
        // No shell, so the JSON argument is never parsed by cmd.exe. A .cmd shim install cannot run this way; that
        // fails here with a clear error rather than being retried through a shell.
        const r = spawnSync(command, args, { encoding: 'utf8', shell: false, windowsHide: true, timeout: 60000 });
        if (r.error) return { status: null, stdout: '', stderr: `${(r.error as NodeJS.ErrnoException).code ?? r.error.message}: could not start ${command} without a shell (is it a .exe on PATH?)` };
        return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
      });
      const r = run(a.command, a.args);
      if (r.status !== 0) fail('TOOLS_INSTALL_FAILED', 500, `${a.command} exited ${r.status}: ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
    }
    done.push(describeAction(a).split('\n')[0]);
  }
  return done;
}

// ---- Tool sets for Agent Commons jobs ------------------------------------------------------------------------------

/** What a job stores: a snapshot of the approved set, so the launch and the receipt do not depend on later edits. */
export interface JobToolset {
  name: string;
  server: string;
  tools: string[];
  /** Listed tools of the set this job does not get; older stored jobs may lack it. */
  denied?: string[];
  max_concurrent: number;
  write_roots: string[];
  /** Absent for a built-in set, which AC runs in-process. */
  spec?: { command: string; args: string[]; cwd?: string; env?: Record<string, string> };
  builtin?: string;
  slot_locks?: string[];
  /** This job's snapshot (mode-specific tools). */
  sha256: string;
  /** The set's definition hash as air_get tools lists it: the job receipt. */
  def_sha256: string;
}

/** Resolves tools=<name> for one job. Fails when the set is unknown, the route cannot take it, or the mode gets no tools. */
export function jobToolset(manifest: ToolManifest | null, name: string, route: string, mode: string): JobToolset {
  if (!manifest && !isBuiltinToolset(name)) return fail('TOOLS_MANIFEST_MISSING', 400, 'tools= needs a shared tool manifest (<home>\\tools.json)');
  const known = [...Object.keys(BUILTIN_TOOLSETS), ...Object.keys(manifest?.toolsets ?? {})];
  const set = findToolset(manifest, name) ?? fail('TOOLSET_UNKNOWN', 400, `no approved tool set ${JSON.stringify(name)}; known: ${known.join(', ')}`);
  if (!set.routes.includes(route)) fail('TOOLSET_ROUTE', 400, `tool set ${name} runs only on ${set.routes.join(', ')}`);
  // API jobs run their tools inside AC; code-running (edit) tool sets there wait for AJ's approval.
  if (route === 'openai-api' && mode === 'edit') fail('TOOLSET_EDIT_NOT_APPROVED', 400, 'edit tool sets are not approved on openai-api');
  // Edit jobs get the edit list; advice jobs only the advice list, never the code-running tools.
  const tools = [...new Set(mode === 'edit' ? [...set.advice_tools, ...set.edit_tools] : set.advice_tools)];
  const writeRoots = mode === 'edit' ? [...new Set(set.write_roots)] : [];
  // Listed tools this job does not get (an advice job: the code-running ones), denied explicitly on routes that can.
  const denied = [...new Set([...set.advice_tools, ...set.edit_tools])].filter(x => !tools.includes(x));
  if (!tools.length) fail('TOOLSET_MODE', 400, `tool set ${name} grants no tools to ${mode} jobs`);
  const def_sha256 = toolsetDefinitionHash(manifest, name, set);
  if (isBuiltinToolset(name)) {
    const body = JSON.stringify({ name, builtin: name, tools });
    return { name, server: set.server, tools, denied, max_concurrent: set.max_concurrent, write_roots: [], builtin: name,
      sha256: createHash('sha256').update(body).digest('hex'), def_sha256 };
  }
  const server = manifest!.servers[set.server];
  const spec = { command: server.command!, args: server.args ?? [], ...(server.cwd ? { cwd: server.cwd } : {}), ...(server.env ? { env: server.env } : {}) };
  const body = JSON.stringify({ name, server: set.server, tools, write_roots: writeRoots, spec });
  return { name, server: set.server, tools, denied, max_concurrent: set.max_concurrent, write_roots: writeRoots, spec,
    ...(set.slot_locks.length ? { slot_locks: set.slot_locks } : {}), sha256: createHash('sha256').update(body).digest('hex'), def_sha256 };
}

/**
 * How many of these lock files another process holds now. The Blender wrapper locks byte 0 of each slot file with
 * msvcrt.locking while its Blender process runs; on Windows a read of a locked byte from another handle fails with
 * EBUSY. A missing file is a free slot. Reading takes no lock, so this never blocks the wrapper.
 */
export function busySlots(locks: string[]): number {
  let busy = 0;
  for (const file of locks) {
    let fd: number | undefined;
    try { fd = fs.openSync(file, 'r'); fs.readSync(fd, Buffer.alloc(1), 0, 1, 0); }
    catch (error: any) { if (error?.code === 'EBUSY' || error?.code === 'EPERM' || error?.code === 'EACCES') busy++; }
    finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* already closed */ } }
  }
  return busy;
}

const tomlKey = (k: string) => /^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k);
/** Codex: the one server as -c overrides (no user config is loaded), its enabled tools pre-approved, and extra write roots. */
export function codexToolsetArgs(t: JobToolset): string[] {
  const spec = t.spec ?? fail('TOOLSET_ROUTE', 400, `tool set ${t.name} is built in and runs only on openai-api`);
  const at = `mcp_servers.${t.server}`, out = ['-c', `${at}.command=${JSON.stringify(spec.command)}`,
    '-c', `${at}.args=[${spec.args.map(a => JSON.stringify(a)).join(',')}]`];
  if (spec.cwd) out.push('-c', `${at}.cwd=${JSON.stringify(spec.cwd)}`);
  if (spec.env && Object.keys(spec.env).length) out.push('-c', `${at}.env={${Object.entries(spec.env).map(([k, v]) => `${tomlKey(k)}=${JSON.stringify(v)}`).join(',')}}`);
  out.push('-c', `${at}.enabled_tools=[${t.tools.map(x => JSON.stringify(x)).join(',')}]`, '-c', `${at}.startup_timeout_sec=30`, '-c', `${at}.tool_timeout_sec=240`);
  for (const tool of t.tools) out.push('-c', `${at}.tools.${tool}.approval_mode="approve"`);
  for (const root of t.write_roots) out.push('--add-dir', root);
  return out;
}
/** Claude: a per-job --mcp-config file holding only this server (stdio has no cwd; servers must not depend on it). */
export function claudeToolsetConfig(t: JobToolset): string {
  const spec = t.spec ?? fail('TOOLSET_ROUTE', 400, `tool set ${t.name} is built in and runs only on openai-api`);
  return JSON.stringify({ mcpServers: { [t.server]: { type: 'stdio', command: spec.command, args: spec.args, ...(spec.env ? { env: spec.env } : {}) } } }, null, 2);
}
export const claudeToolsetAllowed = (t: JobToolset) => t.tools.map(tool => `mcp__${t.server}__${tool}`);
/** Claude: the set's tools this job does not get, denied explicitly so user or project allow rules cannot re-enable them. */
export const claudeToolsetDenied = (t: JobToolset) => (t.denied ?? []).map(tool => `mcp__${t.server}__${tool}`);
