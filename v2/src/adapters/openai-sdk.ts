/** Local dependency maintenance for the central helper. Never invokes a provider operation. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { killTree } from './shared.ts';
import { pendingSdkVersion, SdkRecoveryRequired, stableSdkVersion } from './sdk-freshness.ts';
import {
  durableWrite, exists, manifests, readSdkSwap, recoverSdkSwap, renameSwap, sdkSwapPath, settleSdkSwap,
  syncDirectory, withSdkFsClaim, writeSdkSwap, type SdkRecoveryOutcome, type SdkRecoveryReporter, type SdkSwap,
} from './sdk-swap.ts';
import type { SdkSnapshot, SdkUpdateContext } from './types.ts';

const windows = process.platform === 'win32';
const VERSION_QUERY = "import importlib.metadata as m; print(m.version('openai'))";
const PYPI = 'https://pypi.org/pypi/openai/json';
const PROCESS_TIMEOUT = 10 * 60_000;

export const sdkPython = (venv: string): string => path.join(venv, windows ? 'Scripts/python.exe' : 'bin/python');

interface SdkProcess {
  file: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}
export type SdkProcessRunner = (process: SdkProcess) => Promise<{ code: number | null; out: string }>;

function sdkEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const allowed = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'TEMP', 'TMP', 'TMPDIR',
    'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'LANG', 'LC_ALL']);
  for (const [key, value] of Object.entries(process.env))
    if (allowed.has(key.toUpperCase())) env[key] = value;
  // No inherited pip settings, credentials, Python paths or provider keys.
  env.PIP_CONFIG_FILE = windows ? 'NUL' : '/dev/null';
  env.PIP_DISABLE_PIP_VERSION_CHECK = '1';
  env.PIP_NO_INPUT = '1';
  env.PYTHONDONTWRITEBYTECODE = '1';
  return env;
}

const runProcess: SdkProcessRunner = spec => new Promise((resolve, reject) => {
  const child = spawn(spec.file, spec.args, {
    cwd: spec.cwd, env: spec.env, windowsHide: true, detached: !windows, shell: false,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let out = '', timedOut = false, failed = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (child.pid) killTree(child.pid);
  }, spec.timeoutMs);
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => { out += chunk.slice(0, Math.max(0, 64 * 1024 - out.length)); });
  child.once('error', () => { failed = true; });
  child.once('close', code => {
    clearTimeout(timer);
    if (timedOut || failed) reject(new Error(timedOut ? 'process timed out' : 'process could not start'));
    else resolve({ code, out });
  });
});

function command(root: string, run: SdkProcessRunner, file: string, args: string[], timeoutMs = PROCESS_TIMEOUT) {
  return run({ cwd: root, env: sdkEnv(), file, args, timeoutMs });
}

async function installedVersion(root: string, python: string, run: SdkProcessRunner): Promise<string | null> {
  const { code, out } = await command(root, run, python, ['-c', VERSION_QUERY], 10_000);
  const version = out.trim();
  return code === 0 && /^[0-9][0-9A-Za-z.!+_-]{0,99}$/.test(version) ? version : null;
}

function recoveredVenvVerifier(root: string, run: SdkProcessRunner) {
  return async (venv: string, version: string) => {
    const python = sdkPython(venv);
    if (await installedVersion(root, python, run) !== version) throw new Error('wrong recovered SDK version');
    const { code } = await command(root, run, python, ['-m', 'unittest', 'discover', '-s', 'tests']);
    if (code !== 0) throw new Error('recovered helper tests failed');
  };
}

export function recoverInterruptedSdkSwap(root: string, home: string, run: SdkProcessRunner = runProcess,
  report?: SdkRecoveryReporter): Promise<SdkRecoveryOutcome> {
  root = path.resolve(root);
  return recoverSdkSwap(root, path.resolve(home), recoveredVenvVerifier(root, run), report);
}

// Use the adapter's existing helper-root resolver, but do not run its version/PyPI inspection in this pass.
const recoveryInspection = new AsyncLocalStorage<{
  home: string; report: SdkRecoveryReporter; outcome: SdkRecoveryOutcome;
}>();
export async function inspectSdkSwap(inspect: () => Promise<SdkSnapshot>, home: string,
  report: SdkRecoveryReporter): Promise<SdkRecoveryOutcome> {
  const request = { home, report, outcome: 'none' as SdkRecoveryOutcome };
  await recoveryInspection.run(request, inspect);
  return request.outcome;
}

// Keep the journal until the prober has finalized its lease. Direct callers need no store.
const swapFinalizer = new AsyncLocalStorage<(result: string) => void>();
export function withSdkSwapFinalizer<T>(finalize: (result: string) => void, update: () => Promise<T>): Promise<T> {
  return swapFinalizer.run(finalize, update);
}

export async function readOpenAISdk(root: string, run: SdkProcessRunner = runProcess,
  fetcher: typeof fetch = fetch): Promise<SdkSnapshot> {
  const recovery = recoveryInspection.getStore();
  if (recovery) {
    recovery.outcome = await recoverInterruptedSdkSwap(root, recovery.home, run, recovery.report);
    return { installed: null, latest: null };
  }
  const upstream = async () => {
    const response = await fetcher(PYPI, {
      signal: AbortSignal.timeout(10_000),
      headers: { Accept: 'application/json', 'User-Agent': 'Agent-Commons/2' },
    });
    if (!response.ok) return null;
    const version = (await response.json() as { info?: { version?: unknown } } | null)?.info?.version;
    return typeof version === 'string' && stableSdkVersion(version) ? version : null;
  };
  const [installed, latest] = await Promise.all([
    installedVersion(root, sdkPython(path.join(root, '.venv')), run).catch(() => null),
    upstream().catch(() => null),
  ]);
  return { installed, latest };
}

/** PEP 427 filenames encode distribution and version before the optional build and the three compatibility tags. */
const WHEEL = /^([A-Za-z0-9_.]+)-([0-9][0-9A-Za-z_.+!]*)(?:-[0-9][0-9A-Za-z_]*)?-[A-Za-z0-9_.]+-[A-Za-z0-9_.]+-[A-Za-z0-9_.]+\.whl$/;

type VerifyWheel = (filename: string, name: string, version: string, digest: string) => Promise<void>;

export async function wheelLock(wheels: string, verify?: VerifyWheel): Promise<string> {
  const entries = await fs.readdir(wheels, { withFileTypes: true });
  const rows = new Map<string, string>();
  for (const entry of entries) {
    const match = entry.isFile() && WHEEL.exec(entry.name);
    if (!match || match[0] !== entry.name) throw new Error('unexpected entry in wheel directory');
    const name = match[1].toLowerCase().replace(/[-_.]+/g, '-'), version = match[2];
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name) || rows.has(name))
      throw new Error('invalid or duplicate wheel distribution');
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(path.join(wheels, entry.name))) hash.update(bytes);
    const digest = hash.digest('hex');
    await verify?.(entry.name, name, version, digest);
    rows.set(name, `${name}==${version} --hash=sha256:${digest}`);
  }
  if (!rows.size) throw new Error('no wheels downloaded');
  return [...rows.keys()].sort().map(name => rows.get(name)).join('\n') + '\n';
}

function nextRequirements(source: string, target: string, date: string): { text: string; tzdata: string } {
  const lines = source.split(/\r?\n/);
  const sdk = /^(\s*)openai==[0-9][0-9A-Za-z.!+_-]*\s*(?:#.*)?$/;
  const tz = /^\s*tzdata==([0-9][0-9A-Za-z.!+_-]*)\s*(?:#.*)?$/;
  const pins = lines.filter(line => !/^\s*(?:#|$)/.test(line));
  const tzPin = pins.find(line => tz.test(line))?.match(tz)?.[1];
  if (pins.length !== 2 || !pins.some(line => sdk.test(line)) || !tzPin)
    throw new Error('expected exactly one openai and one tzdata pin');
  const note = '# Official SDK, Apache-2.0. Verified by AC on ' + date + ' (tests + dry run).';
  const comment = /^\s*#\s*Official SDK, Apache-2\.0\./;
  const updated = lines.filter(line => !comment.test(line)).flatMap(line => {
    const match = sdk.exec(line);
    return match ? [match[1] + note, `${match[1]}openai==${target}`] : [line];
  });
  return { text: updated.join(source.includes('\r\n') ? '\r\n' : '\n'), tzdata: tzPin };
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validDryRun(value: unknown): boolean {
  if (!object(value) || value.status !== 'dry_run' || 'error' in value || 'error_code' in value) return false;
  const amount = value.reservation_usd;
  const positive = typeof amount === 'string'
    ? /^[0-9]+(?:\.[0-9]+)?$(?![\s\S])/.test(amount) && /[1-9]/.test(amount)
    : typeof amount === 'number' && Number.isFinite(amount) && amount > 0;
  if (!positive) return false;
  if (!('reservation_admission' in value)) return true;
  const admission = value.reservation_admission;
  if (!object(admission) || 'error' in admission) return false;
  return admission.status === 'blocked' ? admission.error_code === 'account_costs_stale'
    : admission.status === 'admitted' && !('error_code' in admission);
}

export async function updateOpenAISdk(root: string, ctx: SdkUpdateContext, run: SdkProcessRunner = runProcess,
  fetcher: typeof fetch = fetch): Promise<void> {
  root = path.resolve(root);
  ctx = { ...ctx, home: path.resolve(ctx.home) };
  const recovery = await recoverInterruptedSdkSwap(root, ctx.home, run);
  if (recovery !== 'none') throw new SdkRecoveryRequired(`SDK update deferred: ${recovery}; see logs/sdk-recovery.log`);
  const ran = await withSdkFsClaim(root, async () => {
    // Recheck under the claim in case another process interrupted a swap after the preflight.
    if (await exists(sdkSwapPath(root)) || !await exists(path.join(root, '.venv')))
      throw new SdkRecoveryRequired('SDK swap state changed before update');
    await updateClaimedSdk(root, ctx, run, fetcher);
    return true;
  });
  if (!ran) throw new Error('SDK filesystem operation already running');
}

async function updateClaimedSdk(root: string, ctx: SdkUpdateContext, run: SdkProcessRunner,
  fetcher: typeof fetch): Promise<void> {
  const venv = path.join(root, '.venv'), candidate = path.join(root, '.venv-candidate'), previous = path.join(root, '.venv-previous');
  const target = ctx.targetVersion, python = sdkPython(venv), candidatePython = sdkPython(candidate);
  const stamp = path.basename(ctx.logPath).replace(/^sdk-update-/, '').replace(/\.log$/, '');
  const backup = path.join(ctx.home, 'backups', `helper-sdk-${stamp}`);
  let step = 'create update log';
  let temp: string | undefined, staging: string | undefined;
  let ownsCandidate = false, ownsBackup = false, journalStarted = false, verificationDone = false;
  let exitCode: number | null | undefined;
  const finalize = swapFinalizer.getStore();

  const log = (message: string) => fs.appendFile(ctx.logPath, `${new Date().toISOString()} ${message}\n`, { flag: 'a', mode: 0o600 });
  const bestEffortLog = async (message: string) => { try { await log(message); } catch { /* never interrupt recovery */ } };
  const begin = async (label: string) => { step = label; exitCode = undefined; await log(label); };
  const runStep = async (label: string, file: string, args: string[]) => {
    await begin(label);
    const result = await command(root, run, file, args);
    exitCode = result.code;
    await log(`${label}: ${exitCode === null ? 'terminated' : `exit ${exitCode}`}`);
    if (exitCode !== 0) throw new Error('command failed');
    return result.out;
  };

  try {
    await fs.mkdir(path.dirname(ctx.logPath), { recursive: true });
    await fs.writeFile(ctx.logPath, '', { flag: 'wx', mode: 0o600 });
  } catch { throw new Error('create update log failed'); }

  try {
    await begin('check current SDK and read helper pins');
    if (!stableSdkVersion(target) || !(await fs.lstat(venv)).isDirectory())
      throw new Error('not an upgrade of the installed SDK');
    const oldVersion = await installedVersion(root, python, run);
    if (!oldVersion || pendingSdkVersion({ installed: oldVersion, latest: target }) !== target)
      throw new Error('not an upgrade of the installed SDK');

    const cfg = await fs.readFile(path.join(venv, 'pyvenv.cfg'), 'utf8');
    const baseHome = /^home[ \t]*=[ \t]*(.+)$/mi.exec(cfg)?.[1].trim();
    if (!baseHome || !path.isAbsolute(baseHome)) throw new Error('base Python home is missing');
    const base = path.join(baseHome, windows ? 'python.exe' : 'python');
    const originals = await Promise.all(manifests.map(async name => {
      const file = path.join(root, name), stat = await fs.lstat(file);
      if (!stat.isFile()) throw new Error('expected a regular manifest file');
      return { name, bytes: await fs.readFile(file), mode: stat.mode & 0o777 };
    }));
    const requirements = nextRequirements(originals[0].bytes.toString('utf8'), target, new Date().toISOString().slice(0, 10));

    await begin('create temporary wheel directory');
    temp = await fs.mkdtemp(path.join(ctx.home, 'sdk-update-'));
    const wheels = path.join(temp, 'wheels'), lockFile = path.join(temp, 'requirements.lock');
    await fs.mkdir(wheels);
    await runStep('download binary wheels from PyPI', base, [
      '-m', 'pip', 'download', `openai==${target}`, `tzdata==${requirements.tzdata}`,
      '--only-binary=:all:', '--index-url', 'https://pypi.org/simple', '--dest', wheels,
    ]);
    await begin('verify wheel hashes against PyPI');
    const lock = await wheelLock(wheels, async (filename, name, version, digest) => {
      await log(`${filename} sha256:${digest}`);
      const response = await fetcher(`https://pypi.org/pypi/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`, {
        signal: AbortSignal.timeout(10_000), redirect: 'error',
        headers: { Accept: 'application/json', 'User-Agent': 'Agent-Commons/2' },
      });
      if (!response.ok) throw new Error('release metadata unavailable');
      const release: unknown = await response.json();
      if (!object(release) || !Array.isArray(release.urls) || !release.urls.some(entry =>
        object(entry) && entry.filename === filename && entry.yanked === false &&
        object(entry.digests) && entry.digests.sha256 === digest))
        throw new Error('wheel missing, yanked, or digest mismatch');
    });
    await begin('write verified candidate lock');
    if (!lock.startsWith(`openai==${target} --hash=`) && !lock.includes(`\nopenai==${target} --hash=`))
      throw new Error('download did not include the target SDK');
    if (!lock.includes(`\ntzdata==${requirements.tzdata} --hash=`))
      throw new Error('download did not include the pinned tzdata');
    await fs.writeFile(lockFile, lock, { flag: 'wx', mode: 0o600 });

    await begin('reserve candidate venv directory');
    await fs.mkdir(candidate); // Do not overwrite or clean an unowned candidate.
    ownsCandidate = true;
    await runStep('create candidate venv', base, ['-m', 'venv', candidate]);
    await runStep('install locked wheels offline', candidatePython, [
      '-m', 'pip', 'install', '--require-hashes', '--no-deps', '--requirement', lockFile,
      '--no-index', '--find-links', wheels,
    ]);
    await runStep('check candidate dependencies', candidatePython, ['-m', 'pip', 'check']);
    await begin('verify candidate SDK version');
    if (await installedVersion(root, candidatePython, run) !== target) throw new Error('wrong SDK version');
    await runStep('run helper tests with candidate', candidatePython, ['-m', 'unittest', 'discover', '-s', 'tests']);
    await begin('write synthetic dry-run request');
    const request = path.join(temp, 'dry-run.json');
    await fs.writeFile(request, JSON.stringify({
      capability: 'responses', external_request_id: randomUUID(), model: 'gpt-6.2-sol', tier: 'default',
      max_cost_usd: '1.00', local_timeout_seconds: 30,
      purpose: { kind: 'coding_assistance', description: 'Verify the helper SDK update locally', deliverable: 'Dry-run admission result' },
      payload: { input: 'Synthetic SDK maintenance check.', max_output_tokens: 256 },
    }), { flag: 'wx', mode: 0o600 });
    const reply: unknown = JSON.parse(await runStep('run local helper dry run', candidatePython,
      ['run.py', 'dry-run', '--request', request]));
    if (!validDryRun(reply)) throw new Error('invalid dry-run reply');

    await begin('back up manifests and stage replacements');
    await fs.mkdir(path.dirname(backup), { recursive: true });
    await fs.mkdir(backup, { mode: 0o700 });
    ownsBackup = true;
    staging = await fs.mkdtemp(path.join(root, '.sdk-swap-')); // Same filesystem as the live venv and manifests.
    for (const [i, original] of originals.entries()) {
      if (!(await fs.readFile(path.join(root, original.name))).equals(original.bytes))
        throw new Error('helper manifest changed during verification');
      await durableWrite(path.join(backup, original.name), original.bytes);
      await durableWrite(path.join(staging, original.name), i === 0 ? requirements.text : lock, original.mode);
    }
    await syncDirectory(path.dirname(backup));
    await syncDirectory(ctx.home);

    let swap: SdkSwap = {
      step: 'prepared', venv, previous, candidate, staging, backup, oldVersion, newVersion: target,
      modes: [originals[0].mode, originals[1].mode],
    };
    const advance = async (next: SdkSwap['step']) => {
      swap = { ...swap, step: next };
      await writeSdkSwap(root, swap);
    };
    await begin('write SDK swap journal');
    journalStarted = true; // Even a failed directory sync may have published the journal.
    await advance('prepared');
    if (await exists(previous)) {
      await begin('park the older previous venv');
      await renameSwap(previous, path.join(staging, 'older-venv'));
      await advance('previous-parked');
    }
    await begin('move live venv to previous');
    await renameSwap(venv, previous);
    await advance('live-moved');
    await begin('promote candidate venv');
    await renameSwap(candidate, venv);
    await advance('candidate-promoted');
    for (const name of ['requirements.lock', 'requirements.txt'] as const) {
      await begin(`publish ${name}`);
      await renameSwap(path.join(staging, name), path.join(root, name));
      await advance(name === 'requirements.lock' ? 'lock-published' : 'manifests-published');
    }
    await runStep('run helper tests with promoted venv', python, ['-m', 'unittest', 'discover', '-s', 'tests']);
    await begin('verify promoted SDK version');
    if (await installedVersion(root, python, run) !== target) throw new Error('wrong SDK version after promotion');
    verificationDone = true;
    await advance('verified');
    await begin('finalize verified SDK swap');
    await settleSdkSwap(root, ctx.home, swap, recoveredVenvVerifier(root, run), async () => {
      await log(`success: SDK ${target}`);
      finalize?.('success');
    }, true);
  } catch {
    // Never echo interpreter output, request replies or raw exceptions into logs or status.
    const failure = `${step} failed${exitCode !== undefined && exitCode !== 0 ? ` (exit ${exitCode ?? 'unknown'})` : ''}`;
    await bestEffortLog(failure);
    if (journalStarted) {
      try {
        // Once verification passed, leave the commit decision to the durable journal on restart.
        if (verificationDone) throw new Error('verified swap finalization interrupted');
        const swap = await readSdkSwap(root, ctx.home);
        if (!swap) throw new Error('SDK swap journal unavailable');
        await bestEffortLog('restore previous live venv and manifests from swap journal');
        await settleSdkSwap(root, ctx.home, swap, recoveredVenvVerifier(root, run), () => finalize?.(`failed: ${failure}`));
      } catch {
        await bestEffortLog('SDK recovery required; recovery files retained');
        throw new SdkRecoveryRequired(failure);
      }
    }
    throw new Error(failure);
  } finally {
    const cleanup = async (label: string, dir: string) => {
      await bestEffortLog(label);
      try { await fs.rm(dir, { recursive: true, force: true }); }
      catch { await bestEffortLog(`WARN ${label} failed`); }
    };
    if (!journalStarted) {
      if (ownsCandidate) await cleanup('remove rejected candidate', candidate);
      if (staging) await cleanup('remove swap staging directory', staging);
      if (ownsBackup) await cleanup('remove unused backup', backup);
    }
    if (temp) await cleanup('remove temporary wheel directory', temp);
  }
}
