import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { checkSecrets, inside, realDirectory, same, secretLike } from './context.ts';
import { fail } from './errors.ts';

export interface PatchCheck {
  name: string;
  docker: string;
  image: string;
  argv: string[];
  timeout_seconds: number;
  protected_paths: string[];
  share_failure_output: boolean;
}

export interface PatchCheckResult {
  exitCode: number | null;
  output: string;
  error?: string;
}

/** The operator keeps check definitions under the private service home. Job input selects a name only. */
export function resolvePatchCheck(home: string, project: string, name: string): PatchCheck {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) fail('INVALID_INPUT', 400, 'check must be a configured check name');
  let config: { docker?: unknown; projects?: unknown };
  try {
    const file = path.join(home, 'patch-checks.json');
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error('invalid check config file');
    config = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fail('PATCH_CHECK_NOT_CONFIGURED', 400, 'the operator must configure patch-checks.json in the service home');
  }
  const docker = config?.docker;
  const root = realDirectory(project);
  const projects = config?.projects;
  if (typeof docker !== 'string' || !path.isAbsolute(docker) || /[\r\n\0]/.test(docker) || !Array.isArray(projects) || !root)
    return fail('PATCH_CHECK_CONFIG_INVALID', 400, 'check settings must specify an absolute Docker executable and project roots');
  const approved = projects.filter(p => typeof p?.root === 'string' && path.isAbsolute(p.root) && same(realDirectory(p.root) ?? '') === same(root));
  const checks = approved.length === 1 ? approved[0].checks : null;
  const check = checks && Object.hasOwn(checks, name) ? checks[name] : null;
  if (!check) fail('PATCH_CHECK_NOT_APPROVED', 403, `check ${name} is not approved for this project`);
  const { image, argv, timeout_seconds = 120, protected_paths = [], share_failure_output = false } = check;
  if (typeof image !== 'string' || !/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(image)
    || !Array.isArray(argv) || argv.length === 0 || argv.length > 64 || !argv.every(a => typeof a === 'string' && a.length > 0 && a.length <= 4096 && !a.includes('\0'))
    || !Number.isInteger(timeout_seconds) || timeout_seconds < 1 || timeout_seconds > 600 || typeof share_failure_output !== 'boolean'
    || !Array.isArray(protected_paths) || !protected_paths.every(p => typeof p === 'string' && p.split('/').every(s => /^[a-z0-9_.-]+$/i.test(s) && s !== '.' && s !== '..')))
    return fail('PATCH_CHECK_CONFIG_INVALID', 400, 'check needs a digest-pinned image, a nonempty argv, and a timeout of 1 to 600 seconds');
  return { name, docker, image, argv, timeout_seconds, protected_paths, share_failure_output };
}

// Leave room in the 512 MiB container tmpfs for filesystem overhead and check outputs.
const CHECK_SOURCE_LIMIT = 384 * 1024 * 1024;

/** Export plain files only. The timeout covers the copy and the container. */
async function copyForCheck(root: string, snapshot: string, signal: AbortSignal, executablePaths: readonly string[]): Promise<string[]> {
  let bytes = 0;
  const tracked = new Set(executablePaths.map(p => same(p)));
  const executable: string[] = [];
  async function visit(source: string, target: string): Promise<void> {
    signal.throwIfAborted();
    await fs.promises.mkdir(target);
    if (process.platform !== 'win32') await fs.promises.chmod(target, 0o755);
    const dir = await fs.promises.opendir(source);
    for await (const entry of dir) {
      signal.throwIfAborted();
      if (entry.name === '.git' || secretLike(entry.name) || entry.isSymbolicLink()) continue;
      const from = path.join(source, entry.name), to = path.join(target, entry.name);
      if (same(await fs.promises.realpath(from)) !== same(from) || !inside(root, from)) throw new Error('check source crosses a link');
      if (entry.isDirectory()) await visit(from, to);
      else if (entry.isFile()) {
        const stat = await fs.promises.stat(from);
        bytes += stat.size;
        if (bytes > CHECK_SOURCE_LIMIT) throw new Error('check source exceeds the 384 MiB snapshot limit');
        await pipeline(fs.createReadStream(from), fs.createWriteStream(to, { flags: 'wx', mode: 0o644 }), { signal });
        if (process.platform !== 'win32') await fs.promises.chmod(to, 0o644);
        const relative = path.relative(root, from).split(path.sep).join('/');
        if (tracked.has(same(relative)) || (process.platform !== 'win32' && (stat.mode & 0o111))) executable.push(`./${relative}`);
      }
    }
  }
  await visit(root, snapshot);
  return executable;
}

const posixHost = 'unix:///var/run/docker.sock';
const windowsHost = 'npipe:////./pipe/docker_engine';
const checkScript = 'set -eu; mkdir /work/source; cp -R /input/. /work/source; cd /work/source; if [ -f /ac-executable-paths ]; then xargs -0 -r chmod -- a+x </ac-executable-paths; fi; exec "$@"';
const dockerHost = () => process.platform === 'win32' ? windowsHost : posixHost;

export function patchCheckArgs(check: PatchCheck, snapshot: string, name: string, executableFile?: string): string[] {
  if (/[\r\n,"]/.test(snapshot) || /[\r\n,"]/.test(executableFile ?? '')) throw new Error('invalid Docker snapshot path');
  return ['--host', dockerHost(),
    'run', '--rm', '--name', name, '--pull', 'never', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--label', `org.agent-commons.patch-check=${name}`,
    '--security-opt', 'no-new-privileges', '--user', '65534:65534', '--pids-limit', '128', '--memory', '1024m', '--cpus', '2',
    '--tmpfs', '/work:rw,nosuid,nodev,exec,mode=1777,size=512m', '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,mode=1777,size=128m',
    '--mount', `type=bind,source=${snapshot},target=/input,readonly`,
    ...(executableFile ? ['--mount', `type=bind,source=${executableFile},target=/ac-executable-paths,readonly`] : []),
    '--env', 'HOME=/tmp', '--entrypoint', '/bin/sh',
    check.image, '-c', checkScript, 'ac-check', ...check.argv];
}

function dockerEnv(dir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { DOCKER_CONFIG: dir };
  for (const key of ['SystemRoot', 'WINDIR', 'PATH']) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}

/** Check the local daemon and image before an inference request can be submitted. */
export function preflightPatchCheck(check: PatchCheck, dir: string): void {
  const inspect = spawnSync(check.docker, ['--host', dockerHost(), 'image', 'inspect', '--format', '{{.Os}}', check.image],
    { cwd: dir, env: dockerEnv(dir), timeout: 5000, windowsHide: true, encoding: 'utf8' });
  if (inspect.status !== 0 || inspect.stdout.trim() !== 'linux') throw new Error('approved Linux check image is unavailable locally');
}

/** A restarted runner can stop its own check by name and label without trusting a stale PID. */
export function removePatchCheck(docker: string, dir: string, name: string): boolean {
  const options = { cwd: dir, env: dockerEnv(dir), timeout: 5000, windowsHide: true, encoding: 'utf8' as const };
  const target = spawnSync(docker, ['--host', dockerHost(), 'container', 'inspect', '--format',
    '{{.Id}} {{index .Config.Labels "org.agent-commons.patch-check"}}', name], options);
  if (target.status !== 0) return /No such (object|container):/i.test(target.stderr ?? '');
  const [id, label] = target.stdout.trim().split(' ');
  if (!/^[a-f0-9]{64}$/.test(id) || label !== name) return false;
  const result = spawnSync(docker, ['--host', dockerHost(), 'rm', '-f', id], options);
  return result.status === 0 || /No such (object|container):/i.test(result.stderr ?? '');
}

export async function runPatchCheck(check: PatchCheck, worktree: string, dir: string, container: string, timeout: number,
  onChild: (child: ChildProcess, cancel: () => void) => void, cancellation?: AbortSignal, executablePaths: readonly string[] = []): Promise<PatchCheckResult> {
  const root = realDirectory(worktree);
  if (!root) throw new Error('check worktree is unavailable');
  const snapshot = path.join(dir, 'source');
  if (path.dirname(snapshot) !== path.resolve(dir) || !inside(path.resolve(dir), snapshot)) throw new Error('invalid check snapshot cleanup path');
  const duration = Math.min(timeout, check.timeout_seconds * 1000);
  const deadline = Date.now() + duration;
  const alarm = AbortSignal.timeout(duration);
  const signal = cancellation ? AbortSignal.any([cancellation, alarm]) : alarm;
  await fs.promises.mkdir(dir);
  try {
    const executable = await copyForCheck(root, snapshot, signal, executablePaths);
    const executableFile = executable.length ? path.join(dir, 'executable-paths') : undefined;
    if (executableFile) {
      await fs.promises.writeFile(executableFile, `${executable.join('\0')}\0`, { flag: 'wx', mode: 0o644 });
      if (process.platform !== 'win32') await fs.promises.chmod(executableFile, 0o644);
    }
    signal.throwIfAborted();
    if (Date.now() >= deadline) return { exitCode: null, output: '', error: 'PATCH_CHECK_SNAPSHOT_TIMEOUT' };
    const env = dockerEnv(dir);
    return await new Promise<PatchCheckResult>(resolve => {
      const child = spawn(check.docker, patchCheckArgs(check, snapshot, container, executableFile), { cwd: dir, env, windowsHide: true });
      let output = '', settled = false, stopped = false;
      const capture = (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(-16000); };
      const done = (outcome: PatchCheckResult) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', cancel);
        resolve(outcome);
      };
      const remove = () => {
        const cleanup = spawn(check.docker, ['--host', dockerHost(), 'rm', '-f', container],
          { cwd: dir, env, windowsHide: true, stdio: 'ignore' });
        const limit = setTimeout(() => cleanup.kill(), 5000);
        cleanup.on('error', () => {});
        cleanup.on('close', () => clearTimeout(limit));
      };
      const cancel = () => {
        if (settled || stopped) return;
        stopped = true;
        if (child.pid) { child.kill(); remove(); }
        done({ exitCode: null, output: '', error: 'PATCH_CHECK_INTERRUPTED' });
      };
      child.stdout.on('data', capture);
      child.stderr.on('data', capture);
      child.on('error', () => {
        if (child.pid) cancel();
        else done({ exitCode: null, output: '', error: 'PATCH_CHECK_UNAVAILABLE' });
      });
      signal.addEventListener('abort', cancel, { once: true });
      child.on('close', code => {
        if (stopped) { remove(); return; }
        if (code === null || code === 125 || code === 126 || code === 127)
          return done({ exitCode: code, output: '', error: 'PATCH_CHECK_UNAVAILABLE' });
        try { checkSecrets('check output', output); }
        catch { output = '[check output withheld because it resembles a credential]'; }
        done({ exitCode: code, output });
      });
      try { onChild(child, cancel); } catch { cancel(); }
    });
  } catch (error) {
    if (signal.aborted) return { exitCode: null, output: '', error: cancellation?.aborted ? 'PATCH_CHECK_INTERRUPTED' : 'PATCH_CHECK_SNAPSHOT_TIMEOUT' };
    return { exitCode: null, output: redactCheckError(error), error: 'PATCH_CHECK_PREPARATION_FAILED' };
  } finally { await fs.promises.rm(snapshot, { recursive: true, force: true }); }
}

function redactCheckError(error: unknown): string {
  const text = String((error as Error)?.message ?? error).slice(0, 500);
  try { checkSecrets('check error', text); return text; } catch { return '[check error withheld]'; }
}
