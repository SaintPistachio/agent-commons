import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { stableSdkVersion } from './sdk-freshness.ts';

export const manifests = ['requirements.txt', 'requirements.lock'] as const;
const steps = [
  'prepared', 'previous-parked', 'live-moved', 'candidate-promoted', 'lock-published',
  'manifests-published', 'verified', 'reject-promoted', 'restore-live', 'rollback-cleanup',
] as const;
type Step = typeof steps[number];
export interface SdkSwap {
  step: Step;
  venv: string;
  previous: string;
  candidate: string;
  staging: string;
  backup: string;
  oldVersion: string;
  newVersion: string;
  modes: [number, number];
}
export type SdkRecoveryEvent = { result: 'recovered'; version: string } | { result: 'recovery_failed' };
export type SdkRecoveryOutcome = 'none' | 'busy' | SdkRecoveryEvent['result'];
export type SdkRecoveryReporter = (event: SdkRecoveryEvent) => Promise<void> | void;
type Verify = (venv: string, version: string) => Promise<void>;

export const sdkSwapPath = (root: string) => path.join(root, '.venv-swap.json');

async function stat(file: string) {
  try { return await fs.lstat(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
export async function exists(file: string): Promise<boolean> {
  return (await stat(file)) !== null;
}
async function directory(file: string): Promise<boolean> {
  const info = await stat(file);
  if (info && !info.isDirectory()) throw new Error('expected a real directory');
  return info !== null;
}

export async function syncDirectory(dir: string): Promise<void> {
  // Node cannot open directory handles for fsync on Windows.
  if (process.platform === 'win32') return;
  const handle = await fs.open(dir, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function durableWrite(file: string, data: string | Uint8Array, mode = 0o600): Promise<void> {
  const temp = path.join(path.dirname(file), `.sdk-write-${randomUUID()}`);
  const handle = await fs.open(temp, 'wx', mode);
  try {
    try {
      await handle.writeFile(data);
      await handle.chmod(mode);
      await handle.sync();
    } finally { await handle.close(); }
    await fs.rename(temp, file);
    await syncDirectory(path.dirname(file));
  } finally { await fs.rm(temp, { force: true }); }
}

export async function renameSwap(from: string, to: string): Promise<void> {
  await fs.rename(from, to);
  await syncDirectory(path.dirname(to));
  if (path.dirname(from) !== path.dirname(to)) await syncDirectory(path.dirname(from));
}

/** A local process must publish its claim before checking for peers. Concurrent claimants may both defer. */
export async function withSdkFsClaim<T>(root: string, action: () => Promise<T>): Promise<T | undefined> {
  const prefix = '.sdk-fs-claim-';
  const name = `${prefix}${process.pid}-${randomUUID()}`;
  const claim = path.join(root, name);
  await fs.mkdir(claim, { mode: 0o700 });
  try {
    for (const entry of await fs.readdir(root)) {
      if (entry === name || !entry.startsWith(prefix)) continue;
      const owner = /^([1-9][0-9]*)-[a-f0-9-]{36}$/.exec(entry.slice(prefix.length));
      if (!owner) return undefined;
      const pid = Number(owner[1]);
      if (!Number.isSafeInteger(pid) || pid > 0x7fffffff) return undefined;
      try { process.kill(pid, 0); return undefined; }
      catch (error) {
        // A reused PID or an owner we cannot query must be treated as live.
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return undefined;
      }
    }
    return await action();
  } finally {
    // The claim is empty and private to this invocation. Never recursively remove it.
    await fs.rmdir(claim);
  }
}

export async function readSdkSwap(root: string, home: string): Promise<SdkSwap | null> {
  const file = sdkSwapPath(root);
  const info = await stat(file);
  if (!info) return null;
  if (!info.isFile() || info.size > 16 * 1024) throw new Error('invalid SDK swap journal');
  const s = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<SdkSwap> | null;
  const child = (p: unknown, parent: string, name: RegExp) =>
    typeof p === 'string' && name.test(path.basename(p)) && p === path.join(parent, path.basename(p));
  if (!s || !steps.includes(s.step as Step) ||
      s.venv !== path.join(root, '.venv') || s.previous !== path.join(root, '.venv-previous') ||
      s.candidate !== path.join(root, '.venv-candidate') ||
      !child(s.staging, root, /^\.sdk-swap-[A-Za-z0-9]+$/) ||
      !child(s.backup, path.join(home, 'backups'), /^helper-sdk-[A-Za-z0-9_-]+$/) ||
      typeof s.oldVersion !== 'string' || !/^[0-9][0-9A-Za-z.!+_-]{0,99}$/.test(s.oldVersion) ||
      typeof s.newVersion !== 'string' || !stableSdkVersion(s.newVersion) || s.newVersion === s.oldVersion ||
      !Array.isArray(s.modes) || s.modes.length !== 2 ||
      !s.modes.every(mode => Number.isInteger(mode) && mode >= 0 && mode <= 0o777))
    throw new Error('invalid SDK swap journal');
  return s as SdkSwap;
}

export async function writeSdkSwap(root: string, swap: SdkSwap): Promise<void> {
  await durableWrite(sdkSwapPath(root), JSON.stringify(swap) + '\n');
}

/** Replay is restartable, including a stop between a rename and the next journal write. */
export async function settleSdkSwap(root: string, home: string, swap: SdkSwap, verify: Verify,
  onSettled: (version: string) => Promise<void> | void, verifiedHere = false): Promise<void> {
  const advance = async (step: Step) => {
    swap = { ...swap, step };
    await writeSdkSwap(root, swap);
  };
  const { venv, previous, candidate, staging, backup, oldVersion, newVersion, modes } = swap;
  const older = path.join(staging, 'older-venv');
  let keepNew = swap.step === 'verified';
  if (keepNew && !verifiedHere) {
    try {
      if (!await directory(venv)) throw new Error('live venv missing');
      await verify(venv, newVersion);
    } catch { keepNew = false; }
  }

  if (!keepNew) {
    if (!await directory(path.join(home, 'backups')) || !await directory(backup))
      throw new Error('SDK swap backup missing');
    // Validate both backups before changing anything, and never follow an older-venv path through a symlink.
    const backups = await Promise.all(manifests.map(async name => {
      const file = path.join(backup, name);
      if (!(await stat(file))?.isFile()) throw new Error('SDK manifest backup missing');
      return fs.readFile(file);
    }));
    await directory(staging);
    if (swap.step !== 'reject-promoted' && swap.step !== 'restore-live' && swap.step !== 'rollback-cleanup') {
      const live = await directory(venv), pending = await directory(candidate);
      // Promotion can have happened with "live-moved" still on disk. The rename consumes the candidate.
      const promotionPossible = steps.indexOf(swap.step) >= steps.indexOf('live-moved');
      await advance(live && !pending && promotionPossible ? 'reject-promoted' : 'restore-live');
    }
    if (swap.step === 'reject-promoted') {
      const live = await directory(venv), pending = await directory(candidate);
      if (live === pending || !await directory(previous)) throw new Error('ambiguous promoted venv');
      if (live) await renameSwap(venv, candidate);
      await advance('restore-live');
    }
    if (swap.step === 'restore-live') {
      if (!await directory(venv)) {
        if (!await directory(previous)) throw new Error('previous live venv missing');
        await renameSwap(previous, venv);
      }
      if (await directory(older)) {
        if (await exists(previous)) throw new Error('previous venv path occupied');
        await renameSwap(older, previous);
      }
      for (const [i, name] of manifests.entries())
        await durableWrite(path.join(root, name), backups[i], modes[i]);
    }
    if (!await directory(venv)) throw new Error('restored live venv missing');
    await verify(venv, oldVersion);
    if (swap.step !== 'rollback-cleanup') await advance('rollback-cleanup');
  }

  if (await directory(candidate)) await fs.rm(candidate, { recursive: true });
  if (await directory(staging)) await fs.rm(staging, { recursive: true });
  await syncDirectory(root);
  // Persist the result before dropping the journal. If reporting fails, startup can retry.
  await onSettled(keepNew ? newVersion : oldVersion);
  await fs.unlink(sdkSwapPath(root));
  await syncDirectory(root);
}

export async function recoverSdkSwap(root: string, home: string, verify: Verify,
  report?: SdkRecoveryReporter): Promise<SdkRecoveryOutcome> {
  const record = async (event: SdkRecoveryEvent) => {
    const logDir = path.join(home, 'logs');
    await fs.mkdir(logDir, { recursive: true });
    const handle = await fs.open(path.join(logDir, 'sdk-recovery.log'), 'a', 0o600);
    try {
      await handle.appendFile(`${new Date().toISOString()} ${event.result}` +
        (event.result === 'recovered' ? ` SDK ${event.version}` : ': SDK swap needs operator attention') + '\n');
      await handle.sync();
    } finally { await handle.close(); }
    await syncDirectory(logDir);
    await syncDirectory(home);
    await report?.(event);
  };
  const failed = async (): Promise<'recovery_failed'> => {
    let reported = false;
    try {
      await recordFailure();
    } catch { /* The caller still gets a loud, fail-closed outcome. */ }
    if (!reported) {
      try { await report?.({ result: 'recovery_failed' }); } catch { /* store unavailable */ }
    }
    return 'recovery_failed';

    async function recordFailure() {
      await record({ result: 'recovery_failed' });
      reported = true;
    }
  };
  const journal = sdkSwapPath(root), live = path.join(root, '.venv');
  try {
    if (!await exists(journal) && await directory(live) && !await exists(journal)) return 'none';
    return (await withSdkFsClaim(root, async () => {
      try {
        const swap = await readSdkSwap(root, home);
        if (!swap) return await directory(live) ? 'none' : await failed();
        await settleSdkSwap(root, home, swap, verify, version => record({ result: 'recovered', version }));
        return 'recovered';
      } catch { return failed(); }
    })) ?? 'busy';
  } catch { return failed(); }
}
