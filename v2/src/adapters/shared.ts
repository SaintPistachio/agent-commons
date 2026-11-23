/** Process helpers shared by the adapters. */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Json } from '../store.ts';
import { SECRET_VALUES } from '../context.ts';
import type { Active, ProbeResult, RouteCommand, RunContext } from './types.ts';

/** SHA-256 of a file's bytes, streamed (CLI binaries can be hundreds of megabytes). */
export function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', chunk => hash.update(chunk)).on('end', () => resolve(hash.digest('hex')));
  });
}

/** Runs a command with no stdin and no API credentials; returns its exit code and output (stdout, else stderr). */
export function runCapture(command: RouteCommand, args: string[], timeoutMs = 20000): Promise<{ code: number | null; out: string }> {
  return new Promise(resolve => {
    let child: ChildProcess;
    try { child = spawn(command.file, [...(command.prefix ?? []), ...args], { cwd: command.cwd, env: helperEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' }); }
    catch { return resolve({ code: null, out: '' }); }
    let out = '', err = '';
    child.stdout!.on('data', chunk => { if (out.length < 200000) out += chunk; });
    child.stderr!.on('data', chunk => { if (err.length < 200000) err += chunk; });
    const timer = setTimeout(() => { if (child.pid) killTree(child.pid); }, timeoutMs);
    child.on('error', () => {});
    child.on('close', code => { clearTimeout(timer); resolve({ code, out: out.trim() ? out : err }); });
  });
}

/**
 * Probe for a CLI worker: hash its program, read `--version` and its help text, and check that every flag Agent
 * Commons passes is still documented. Never sends a prompt. A test CLI run through node is identified by its script.
 */
export async function probeCli(command: RouteCommand | undefined, helpArgs: string[], flags: string[]): Promise<ProbeResult> {
  if (!command) return { state: 'unavailable', reason: 'CLI not found' };
  const target = command.prefix?.[0] && fs.existsSync(command.prefix[0]) ? command.prefix[0] : command.file;
  let binarySha256: string | null = null;
  try { binarySha256 = await hashFile(target); } catch { return { state: 'unavailable', reason: `cannot read ${target}` }; }
  const version = await runCapture(command, ['--version']), help = await runCapture(command, helpArgs);
  if (version.code !== 0 || help.code !== 0 || !help.out.trim())
    return { state: 'blocked', binarySha256, reason: `the CLI did not answer --version/${helpArgs.join(' ')} (exit ${version.code}/${help.code})` };
  const missing = flags.filter(flag => /^-[A-Za-z]$/.test(flag)
    ? !new RegExp(`(?:^|[\\s,])${flag}(?=[\\s,=<]|$)`, 'm').test(help.out)
    : !help.out.includes(flag));
  return { state: missing.length ? 'blocked' : 'verified', binarySha256, cliVersion: version.out.trim().split(/\r?\n/)[0].slice(0, 200),
    helpSha256: createHash('sha256').update(help.out).digest('hex'), reason: missing.length ? `missing flags: ${missing.join(', ')}` : null };
}

/** Never pass API credentials or endpoint overrides to a job: subscription and included-quota routes must not fall back to paid API billing or hijack endpoints. */
export const STRIPPED_ENV = /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_CUSTOM_HEADERS|OPENAI_API_KEY|OPENAI_API_BASE|CODEX_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_GENAI_USE_VERTEXAI|CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_SSE_PORT|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX|CLAUDE_CODE_USE_FOUNDRY|GH_TOKEN|GITHUB_TOKEN|GITLAB_TOKEN|VERCEL_TOKEN|NPM_TOKEN|PYPI_TOKEN|HF_TOKEN|.*_BASE_URL|GOOGLE_CLOUD_.*|GEMINI_CLI_.*|AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|BEARER_TOKEN_BEDROCK)|.+_(?:API_KEY|API_TOKEN|BOT_TOKEN|AUTH_TOKEN|ACCESS_TOKEN|SECRET|SECRET_KEY|PRIVATE_KEY)|.*PASSWORD)$/i;
export const RESULT_LIMIT = 64 * 1024;

const KEEP_SUBSCRIPTION_ENV = /^(?:CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CONFIG_DIR|CLAUDE_CODE_GIT_BASH_PATH|CODEX_HOME)$/i;
const PROXY_ENV = /^(?:HTTP|HTTPS|ALL|NO)_PROXY$/i;
const URL_CREDENTIAL = /:\/\/[^/\s:@]+:[^/\s@]+@/;

export function shouldStripEnv(key: string, value: string | undefined): boolean {
  if (value === undefined) return true;
  if (KEEP_SUBSCRIPTION_ENV.test(key)) return false;
  if (STRIPPED_ENV.test(key)) return true;
  if (SECRET_VALUES.some(pattern => pattern.test(value))) return true;
  if (!PROXY_ENV.test(key) && URL_CREDENTIAL.test(value)) return true;
  return false;
}

function cleanEnv(base: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  if (process.platform === 'win32') env.NoDefaultCurrentDirectoryInExePath = '1';
  for (const [key, value] of Object.entries(process.env)) if (!shouldStripEnv(key, value)) env[key] = value;
  return env;
}

/** The service's environment without API credentials, plus AGENT_COMMONS_JOB_ID. */
export function workerEnv(jobId: string): NodeJS.ProcessEnv {
  return cleanEnv({ AGENT_COMMONS_JOB_ID: jobId });
}

/** The helper reads its own protected credential files; nothing from this service's environment is added. */
export function helperEnv(): NodeJS.ProcessEnv {
  return cleanEnv();
}

/** Runs one helper command to completion and parses its single JSON reply. */
export function helperCall(helper: RouteCommand, args: string[], timeoutMs = 120000, onChild?: (child: ChildProcess | undefined) => void,
  extraEnv: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; reply: Json | null; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(helper.file, [...(helper.prefix ?? []), ...args], { cwd: helper.cwd, windowsHide: true, env: { ...helperEnv(), ...extraEnv } });
    onChild?.(child);
    let out = '', err = '';
    child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; });
    const timer = setTimeout(() => { if (child.pid) killTree(child.pid); }, timeoutMs);
    child.on('error', () => {});
    child.on('close', code => { clearTimeout(timer); onChild?.(undefined); let reply: Json | null = null; try { reply = JSON.parse(out); } catch {} resolve({ code, reply, stderr: err.slice(-500) }); });
  });
}

export const git = (cwd: string, args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export function killTree(pid: number): void {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL');
  } catch { /* already gone */ }
}

/** Opens a job's stdout/stderr files; if the second open fails, the first is closed. */
export function openOutputs(dir: string): [number, number] {
  const stdout = fs.openSync(path.join(dir, 'stdout.json'), 'w');
  try { return [stdout, fs.openSync(path.join(dir, 'stderr.log'), 'w')]; }
  catch (error) { fs.closeSync(stdout); throw error; }
}

/**
 * The shared path for CLI workers that work in a directory (claude, codex): prepare the workdir, start the CLI with
 * the prompt on stdin, enforce the timeout, and hand the exit to `complete`.
 */
export function launchCli(job: Json, ctx: RunContext, command: RouteCommand | undefined, args: (cwd: string) => string[],
  complete: (cwd: string, code: number | null, reason?: string) => void): void {
  let cwd: string;
  try { cwd = ctx.prepareWorkdir(); }
  catch (error) { return ctx.finish('failed', { error: 'WORKDIR_FAILED: ' + String((error as Error).message).slice(0, 500) }); }
  if (!command) return ctx.finish('failed', { error: 'ROUTE_EXECUTABLE_NOT_FOUND' });
  const argv = args(cwd);
  const env = workerEnv(job.id);
  // A tool set's MCP server (Blender: a Python process) can take longer to start than Claude's default MCP wait.
  if (job.options?.toolset && !env.MCP_TIMEOUT) env.MCP_TIMEOUT = '60000';
  const [stdout, stderr] = openOutputs(ctx.dir);
  let child: ChildProcess;
  try {
    child = spawn(command.file, argv, { cwd, env, stdio: ['pipe', stdout, stderr], windowsHide: true, detached: process.platform !== 'win32' });
  } catch (error) {
    fs.closeSync(stdout); fs.closeSync(stderr);
    return ctx.finish('failed', { error: 'SPAWN_FAILED: ' + String((error as Error).message).slice(0, 300) });
  }
  // The prompt goes over stdin: no shell quoting and no command-line length limit.
  child.stdin!.on('error', () => {}); child.stdin!.end(job.prompt);
  const timer = setTimeout(() => { const a = ctx.active(); if (a && !a.reason) { a.reason = 'TIMEOUT'; if (child.pid) killTree(child.pid); } }, job.timeout_ms);
  const active: Active = { child, timer };
  ctx.track(active);
  ctx.store.updateJob(job.id, { pid: child.pid ?? null });
  child.on('error', error => { const a = ctx.active(); if (a && !a.reason) a.reason = 'SPAWN_FAILED: ' + error.message; });
  child.on('close', code => {
    clearTimeout(timer); fs.closeSync(stdout); fs.closeSync(stderr);
    const current = ctx.active();
    if (!current) return; // already recorded by stop()
    try { complete(cwd, code, current.reason); }
    catch (error) { ctx.finish('failed', { exit_code: code, error: 'RESULT_RECORDING_FAILED: ' + String((error as Error).message).slice(0, 300) }); }
  });
}

/**
 * Git arguments that pin the pre-captured git directory and disable hooks and fsmonitor so a worker cannot redirect
 * host-side git inspection by modifying `.git` or repo config inside its worktree.
 */
export function safeWorktreeGitArgs(cwd: string, gitDir?: string | null, home?: string): string[] {
  const noHooks = home ? path.join(home, 'worktrees', '.no-hooks') : path.join(os.tmpdir(), 'ac-no-hooks');
  fs.mkdirSync(noHooks, { recursive: true });
  const target = gitDir ? ['--git-dir', gitDir, '--work-tree', cwd] : ['-C', cwd];
  return [...target, '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${noHooks}`];
}

/** Discover effective filters in this checkout, including conditional includes, and disable external transforms. */
export function patchWorktreeGitArgs(cwd: string, gitDir: string | undefined, home: string): string[] {
  const safe = safeWorktreeGitArgs(cwd, gitDir, home);
  let keys = '';
  try {
    keys = execFileSync('git', [...safe, 'config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch (error) { if ((error as { status?: number }).status !== 1) throw error; }
  const filters = new Set<string>();
  for (const key of keys.split('\0').filter(Boolean)) {
    const name = /^filter\.([a-z0-9_.-]+)\.(clean|smudge|process|required)$/i.exec(key)?.[1];
    if (!name) throw new Error('Unsupported Git filter key in patch workspace');
    filters.add(name);
  }
  for (const filter of filters) {
    for (const setting of ['clean=', 'smudge=', 'process=', 'required=false']) safe.push('-c', `filter.${filter}.${setting}`);
  }
  return safe;
}

/** Git, not the Windows filesystem mode, determines which checked-out scripts are executable. */
export function patchWorktreeExecutables(cwd: string, gitDir: string | undefined, home: string): string[] {
  const args = patchWorktreeGitArgs(cwd, gitDir, home);
  return execFileSync('git', [...args, 'ls-files', '--stage', '-z'], { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).split('\0').flatMap(entry => {
    const found = /^100755 [0-9a-f]+ 0\t(.+)$/s.exec(entry);
    return found ? [found[1]] : [];
  });
}

/**
 * List changed and untracked files in an edit worktree using NUL-delimited `--no-renames` output so quoted names
 * stay verbatim and moves report both old and new paths. Throws if git fails.
 */
export function worktreeChangedFiles(cwd: string, base?: string | null, gitDir?: string | null, home?: string, patchEdit = false): string[] {
  const safe = patchEdit && home ? patchWorktreeGitArgs(cwd, gitDir ?? undefined, home) : safeWorktreeGitArgs(cwd, gitDir, home);
  const run = (args: string[]) => execFileSync('git', [...safe, ...args], {
    cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  const seen = new Set<string>();
  const add = (p: string) => { if (p && !seen.has(p) && seen.size < 500) seen.add(p); };
  if (base) {
    for (const file of run(['diff', '--name-only', '--no-renames', '-z', base]).split('\0')) add(file);
    for (const file of run(['ls-files', '--others', ...(patchEdit ? [] : ['--exclude-standard']), '-z']).split('\0')) add(file);
  } else {
    const tokens = run(['status', '--porcelain=v1', '-z', '--no-renames']).split('\0');
    for (let i = 0; i < tokens.length; i++) {
      const entry = tokens[i];
      if (!entry) continue;
      const xy = entry.slice(0, 2);
      add(entry.slice(3));
      if ((xy.includes('R') || xy.includes('C')) && i + 1 < tokens.length) add(tokens[++i]);
    }
  }
  return [...seen];
}

/**
 * An edit job's changes against `base`: tracked changes (committed or not) plus untracked files, as one unified
 * diff, with a stat such as "+42 -11 (2f)". Reads only; the worktree and its index are left as they are.
 */
export function editDiff(cwd: string, base: string, gitDir?: string | null, home?: string, patchEdit = false): { patch: string; stat: string } | null {
  const safe = patchEdit && home ? patchWorktreeGitArgs(cwd, gitDir ?? undefined, home) : safeWorktreeGitArgs(cwd, gitDir, home);
  const run = (args: string[], prefix: string[] = safe, allowDiffExit = false) => {
    const env = gitDir ? { ...process.env, GIT_DIR: gitDir } : process.env;
    try { return execFileSync('git', [...prefix, ...args], { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); }
    catch (error) {
      const status = (error as { status?: number }).status;
      const out = (error as { stdout?: string }).stdout;
      if (allowDiffExit && status === 1 && typeof out === 'string') return out; // --no-index exits 1 on differences
      throw error;
    }
  };
  let added = 0, removed = 0, files = 0;
  const count = (numstat: string) => { for (const line of numstat.split(/\r?\n/).filter(Boolean)) { const [a, d] = line.split('\t'); files++; added += Number(a) || 0; removed += Number(d) || 0; } };
  let patch = run(['diff', '--no-color', '--no-ext-diff', '--no-textconv', base]);
  count(run(['diff', '--numstat', base]));
  const noIndexPrefix = safe.slice(safe.indexOf('-c'));
  for (const file of run(['ls-files', '--others', ...(patchEdit ? [] : ['--exclude-standard']), '-z']).split('\0').filter(Boolean)) {
    patch += run(['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-index', '--', '/dev/null', file], noIndexPrefix, true);
    count(run(['diff', '--numstat', '--no-index', '--', '/dev/null', file], noIndexPrefix, true));
  }
  return patch.trim() ? { patch, stat: `+${added} -${removed} (${files}f)` } : null;
}

/** Model and token counts from a helper's JSON reply, when it reports them (absent or malformed fields stay null). */
export function replyUsage(reply: Json): { reported_model: string | null; tokens_in: number | null; tokens_out: number | null } {
  const model = [reply.reported_model, reply.model].find(v => typeof v === 'string' && v.length <= 200) ?? null;
  const count = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 ? v as number : null;
  return { reported_model: model as string | null, tokens_in: count(reply.usage?.input_tokens), tokens_out: count(reply.usage?.output_tokens) };
}
