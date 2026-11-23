/** Local CLI inventory, selection, and process helpers for adapter-owned updaters. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Json } from '../store.ts';
import { helperEnv, killTree, probeCli, runCapture } from './shared.ts';
import type { Active, CliBinary, CliUpdateContext, CliUpstream, ProbeContext, ProbeResult, RouteCommand, RunnerOptions, RunContext } from './types.ts';

type Tag = 'stable' | 'latest';
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const DIGITS = /^\d+$/;

function semver(value: string): RegExpExecArray | null {
  const match = SEMVER.exec(value);
  if (!match || match[0] !== value || match[4]?.split('.').some(part => DIGITS.test(part) && /^0\d/.test(part))) return null;
  return match;
}

export function parseCliVersion(output: string): string | null {
  for (const token of output.split(/[\s(),:]+/)) {
    const version = token.replace(/^v(?=\d)/, '');
    if (semver(version)) return version;
  }
  return null;
}

const lexical = (a: string, b: string) => a === b ? 0 : a < b ? -1 : 1;
const numeric = (a: string, b: string) => Math.sign(a.length - b.length) || lexical(a, b);

export function compareCliVersions(a: string, b: string): number {
  const x = semver(a), y = semver(b);
  if (!x || !y) throw new RangeError(`Invalid CLI version: ${!x ? a : b}`);
  const core = numeric(x[1], y[1]) || numeric(x[2], y[2]) || numeric(x[3], y[3]);
  if (core) return core;
  if (!x[4] || !y[4]) return Number(!x[4]) - Number(!y[4]);
  const left = x[4].split('.'), right = y[4].split('.');
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const ln = DIGITS.test(left[i]), rn = DIGITS.test(right[i]);
    const order = ln && rn ? numeric(left[i], right[i])
      : ln !== rn ? Number(rn) - Number(ln) : lexical(left[i], right[i]);
    if (order) return order;
  }
  return Math.sign(left.length - right.length);
}

export function isStableCliVersion(version: string): boolean {
  const parts = semver(version);
  return parts !== null && !parts[4];
}

/** Upgrade existing stable installations only; never turn missing inventory into a fresh install. */
export function pendingStableVersion(installed: readonly CliBinary[], upstream: CliUpstream | null, track: Tag = 'latest'): string | null {
  const candidate = upstream?.[track];
  if (!candidate || !isStableCliVersion(candidate)) return null;
  const stable = installed.filter(copy => isStableCliVersion(copy.version));
  return stable.length && stable.every(copy => compareCliVersions(candidate, copy.version) > 0) ? candidate : null;
}

export function parseRegistryTags(document: unknown, source: string, tags: readonly Tag[]): CliUpstream {
  const published = (document as { 'dist-tags'?: Partial<Record<Tag, unknown>> } | null)?.['dist-tags'];
  const result: CliUpstream = { source };
  for (const tag of tags) {
    const value = published?.[tag];
    if (typeof value === 'string' && semver(value)) result[tag] = value;
  }
  return result;
}

export async function registryUpstream(pkg: string, tags: readonly Tag[]): Promise<CliUpstream> {
  const source = `https://registry.npmjs.org/${pkg}`;
  const response = await fetch(source, { signal: AbortSignal.timeout(10_000),
    headers: { 'User-Agent': 'Agent-Commons/2', Accept: 'application/vnd.npm.install-v1+json' } });
  if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`);
  return parseRegistryTags(await response.json(), source, tags);
}

const windows = process.platform === 'win32';
const pathKey = (file: string) => windows ? path.normalize(file).toLowerCase() : path.normalize(file);
export const sameCliPath = (a: string, b: string) => pathKey(a) === pathKey(b);

export function directoryEntries(dir: string): string[] {
  try { return fs.readdirSync(dir).sort(); } catch { return []; }
}

export async function pathCopies(name: string): Promise<string[]> {
  if (windows) {
    const found = await runCapture({ file: 'where.exe' }, [name], 10_000);
    return found.code === 0 ? found.out.split(/\r?\n/).map(line => line.trim()).filter(file => path.isAbsolute(file)) : [];
  }
  return (process.env.PATH ?? '').split(path.delimiter).map(dir => path.resolve(dir, name)).filter(file => {
    try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
  });
}

/** Execute native programs directly. For an npm Windows shim, use its package's Node entry point, not a shell. */
export function cliCommand(file: string, pkg: string): RouteCommand | undefined {
  if (!windows || /\.exe$/i.test(file) || /\.com$/i.test(file)) return { file };
  if (!/\.(?:cmd|bat|ps1)$/i.test(file) && path.extname(file)) return undefined;
  const root = path.join(path.dirname(file), 'node_modules', pkg);
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (manifest.name !== pkg) return undefined;
    const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[path.basename(file, path.extname(file))];
    if (typeof bin !== 'string') return undefined;
    const entry = path.resolve(root, bin), relative = path.relative(root, entry);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || !fs.statSync(entry).isFile()) return undefined;
    return { file: process.execPath, prefix: [entry] };
  } catch { return undefined; }
}

export async function versionedCopies(candidates: Array<{ path: string; source: string }>,
  commandFor: (file: string) => RouteCommand | undefined): Promise<CliBinary[]> {
  const seen = new Set<string>();
  const copies = await Promise.all(candidates.map(async candidate => {
    const key = pathKey(candidate.path);
    if (seen.has(key)) return null;
    seen.add(key);
    try { if (!fs.statSync(candidate.path).isFile()) return null; } catch { return null; }
    const command = commandFor(candidate.path);
    if (!command) return null;
    const result = await runCapture(command, ['--version'], 10_000);
    const version = result.code === 0 ? parseCliVersion(result.out) : null;
    return version ? { ...candidate, version } : null;
  }));
  return copies.filter(copy => copy !== null);
}

export interface CliRoute {
  id: string;
  binaries(ctx: ProbeContext): Promise<CliBinary[]>;
  override(options: RunnerOptions): RouteCommand | undefined;
  command(file: string, options: RunnerOptions): RouteCommand | undefined;
  helpArgs: string[];
  flags: string[];
}

export function retainedCliPath(home: string, route: string): string {
  return path.join(home, 'cli-retained', route, windows ? `${route}.exe` : route);
}

/** Keep an independently runnable copy before an official installer can replace a native executable in place. */
export async function retainNativeCli(ctx: CliUpdateContext, route: CliRoute): Promise<void> {
  if (!ctx.selected) return;
  const command = route.command(ctx.selected.path, ctx.options), destination = retainedCliPath(ctx.home, route.id);
  if (!command || command.prefix?.length) throw new Error('cannot retain this CLI as a standalone executable');
  if (sameCliPath(command.file, destination)) return;

  const p = fs.promises;
  const file = await p.open(command.file, 'r');
  const magic = Buffer.alloc(4);
  try { await file.read(magic, 0, magic.length, 0); } finally { await file.close(); }
  const native = windows ? magic.subarray(0, 2).toString('ascii') === 'MZ'
    : /^(7f454c46|feedface|cefaedfe|feedfacf|cffaedfe|cafebabe|bebafeca|cafebabf|bfbafeca)$/.test(magic.toString('hex'));
  if (!native) throw new Error('cannot safely retain a CLI script or launcher before an in-place update');

  const dir = path.dirname(destination);
  await p.mkdir(dir, { recursive: true });
  const staging = await p.mkdtemp(path.join(dir, '.staging-'));
  const copy = path.join(staging, path.basename(destination));
  try {
    await p.copyFile(command.file, copy);
    await p.chmod(copy, (await p.stat(command.file)).mode & 0o777);
    const check = await probeCli({ file: copy }, route.helpArgs, route.flags);
    if (check.state !== 'verified' || parseCliVersion(check.cliVersion ?? '') !== ctx.selected.version)
      throw new Error('the retained CLI did not pass its standalone probe');
    await p.rename(copy, destination);
  } finally {
    await p.rm(staging, { recursive: true, force: true });
  }
}

/** Stream both output streams to disk. Do not release the route while the updater is still running. */
export async function runOfficialUpdater(ctx: CliUpdateContext, command: RouteCommand, args: string[]): Promise<void> {
  const output = fs.openSync(ctx.logPath, 'a', 0o600);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command.file, [...(command.prefix ?? []), ...args], {
        cwd: command.cwd ?? ctx.home, env: helperEnv(), stdio: ['ignore', output, output],
        windowsHide: true, detached: !windows,
      });
      let error: Error | undefined;
      const timer = setTimeout(() => {
        error = new Error('official updater timed out after 10 minutes');
        if (child.pid) killTree(child.pid);
      }, 10 * 60 * 1000);
      child.on('error', cause => { error ??= cause; });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        if (error) reject(error);
        else if (code !== 0) reject(new Error(`official updater exited with ${code ?? signal ?? 'no status'}`));
        else resolve();
      });
    });
  } finally {
    fs.closeSync(output);
  }
}

export async function selectCli(installed: CliBinary[], pin: string | null | undefined,
  check: (binary: CliBinary) => Promise<ProbeResult>): Promise<ProbeResult> {
  // Prefer stable releases (user preference): the newest stable copy that passes the probe; a prerelease is used
  // only when no stable copy passes.
  const candidates = installed.filter(binary => !pin || sameCliPath(binary.path, pin))
    .sort((a, b) => Number(isStableCliVersion(b.version)) - Number(isStableCliVersion(a.version)) || compareCliVersions(b.version, a.version));
  if (!candidates.length) return { state: 'unavailable', reason: pin ? `pinned CLI missing or has no readable version: ${pin}` : 'no installed CLI with a readable version' };
  let firstFailure: ProbeResult | undefined;
  for (const binary of candidates) {
    let result: ProbeResult;
    try { result = await check(binary); } catch (error) {
      result = { state: 'blocked', reason: String((error as Error)?.message ?? error).slice(0, 200) };
    }
    if (result.state === 'verified') return { ...result, binary };
    firstFailure ??= { ...result, binary: undefined,
      reason: `${binary.path}: ${result.reason ?? 'probe did not pass'}` };
  }
  return firstFailure!;
}

export async function resolveCli(route: CliRoute, ctx: ProbeContext): Promise<ProbeResult> {
  const installed = ctx.installed ?? await (ctx.overrides.binaries?.(route.id) ?? route.binaries(ctx));
  // A configured CLI that exists but gives no readable version is present and failing, not absent.
  const configured = route.override(ctx.options);
  if (!installed.length && configured && fs.existsSync(configured.prefix?.[0] ?? configured.file))
    return { state: 'blocked', reason: `the CLI did not answer --version: ${configured.prefix?.[0] ?? configured.file}` };
  return selectCli(installed, ctx.binPath, async binary => {
    if (ctx.overrides.cliProbe) return ctx.overrides.cliProbe(route.id, binary);
    const result = await probeCli(route.command(binary.path, ctx.options), route.helpArgs, route.flags);
    if (result.state === 'verified' && parseCliVersion(result.cliVersion ?? '') !== binary.version)
      return { ...result, state: 'blocked', reason: 'CLI version changed during the probe; re-probe to select it' };
    return result;
  });
}

/** Confirm the selected executable still reports the version its model metadata was checked against. */
export function launchSelectedCli(job: Json, ctx: RunContext, route: CliRoute,
  resolve: (ctx: ProbeContext) => Promise<ProbeResult>, start: (command: RouteCommand, version: string | null) => void): void {
  const state = ctx.store.platformState(route.id);
  const pin: string | null = state?.bin_path ?? null;
  const override = route.override(ctx.options);
  const selected: CliBinary | null = state?.probe_state === 'verified' && state.bin_selected_path && state.bin_version &&
      (!pin || sameCliPath(pin, state.bin_selected_path)) &&
      (!override || pin || sameCliPath(override.file, state.bin_selected_path)) && fs.existsSync(state.bin_selected_path)
    ? { path: state.bin_selected_path, version: state.bin_version, source: state.bin_source ?? 'installed' } : null;
  const startWith = (command: RouteCommand, file: string, version: string | null) => {
    ctx.annotate({ cli: { path: file, version } });
    if (version !== null) ctx.store.updateJob(job.id, { adapter_version: version });
    start(command, version);
  };
  // Runner-only injected commands can use untrusted-metadata fallback without a Prober.
  if (!selected && override && !pin && job.options?.model_source?.state === 'fallback')
    return startWith(override, override.file, null);

  const active: Active = { timer: setTimeout(() => {
    if (ctx.active() !== active) return;
    const reason = active.reason ?? 'TIMEOUT';
    ctx.finish(reason === 'CANCELLED' ? 'cancelled' : 'failed', { error: reason });
  }, job.timeout_ms) };
  ctx.track(active);
  const verify = async (): Promise<ProbeResult> => {
    const command = selected && route.command(selected.path, ctx.options);
    if (command) {
      const version = await runCapture(command, ['--version'], 10_000);
      if (version.code === 0 && parseCliVersion(version.out) === selected!.version)
        return { state: 'verified', binary: selected! };
    }
    if (ctx.active() !== active || active.reason) return { state: 'blocked' };
    return resolve({ home: ctx.home, options: ctx.options, overrides: {}, binPath: pin });
  };
  void verify().then(result => {
    if (ctx.active() !== active) return;
    clearTimeout(active.timer);
    if (active.reason) return ctx.finish(active.reason === 'CANCELLED' ? 'cancelled' : 'failed', { error: active.reason });
    if ((ctx.store.platformState(route.id)?.bin_path ?? null) !== pin)
      return ctx.finish('failed', { error: 'CLI_SELECTION_CHANGED: retry with the new pin' });
    const binary = result.binary;
    const command = binary && route.command(binary.path, ctx.options);
    if (result.state !== 'verified' || !binary || !command)
      return ctx.finish('failed', { error: 'CLI_ERROR: ' + (result.reason ?? 'no verified CLI') });
    startWith(command, binary.path, binary.version);
  }).catch(error => {
    clearTimeout(active.timer);
    if (ctx.active() !== active) return;
    const reason = active.reason ?? ('CLI_ERROR: ' + String((error as Error)?.message ?? error).slice(0, 300));
    ctx.finish(reason === 'CANCELLED' ? 'cancelled' : 'failed', { error: reason });
  });
}

function readSnapshot<T>(value: unknown, fallback: T): T {
  try { return typeof value === 'string' ? JSON.parse(value) ?? fallback : fallback; }
  catch { return fallback; }
}

/** Shared by the status and probe commands; never performs I/O. */
export function cliFreshnessLines(row: Json, track: Tag = 'latest'): string[] {
  if (row.bin_installed == null && row.bin_path == null && row.bin_version == null) return [];
  const copies = readSnapshot<CliBinary[]>(row.bin_installed, []);
  const upstream = readSnapshot<CliUpstream | null>(row.bin_upstream, null);
  const counts = new Map<string, number>();
  for (const { version } of copies) if (semver(version)) counts.set(version, (counts.get(version) ?? 0) + 1);
  const versions = [...counts.keys()].sort(compareCliVersions);
  const summary = versions.map(version => counts.get(version)! > 1 ? `${version} x${counts.get(version)}` : version).join(', ');
  const published = (['stable', 'latest'] as const).flatMap(tag => upstream?.[tag] ? [`${tag} ${upstream[tag]}`] : []);
  const route = row.adapter_id, used = row.bin_version;
  const lines = [`${route}: using ${used ? `${used} (${row.bin_source ?? 'installed'})` : 'none'}; installed: ${summary || 'none'}` +
    `${published.length ? '; upstream ' + published.join(', ') : ''}${row.bin_path ? '; pin: ' + row.bin_path : ''}`];
  if (typeof used === 'string' && semver(used)) {
    // Stable releases are preferred, so only a newer installed stable copy is worth a warning.
    const newest = versions.filter(version => !semver(version)?.[4]).at(-1), baseline = upstream?.[track];
    if (newest && compareCliVersions(newest, used) > 0) lines.push(`WARN ${route}: newer installed stable CLI ${newest} is not used`);
    if (baseline && semver(baseline) && compareCliVersions(baseline, used) > 0) lines.push(`WARN ${route}: using ${used}, below upstream ${track} ${baseline}`);
  } else if (versions.length) {
    lines.push(`WARN ${route}: installed CLI copies found, but none is selected`);
  }
  return lines;
}

export function cliUpdateStatusLine(row: Json, track: Tag = 'latest'): string {
  const installed = readSnapshot<CliBinary[]>(row.bin_installed, []);
  const upstream = readSnapshot<CliUpstream | null>(row.bin_upstream, null);
  const pending = pendingStableVersion(installed, upstream, track);
  const result = row.last_update_result === 'running' ? 'running (or interrupted)' : row.last_update_result;
  return `${row.adapter_id}: auto-update ${row.auto_update === 1 ? 'on' : 'off'}; ` +
    `last update: ${result ? `${result} [${row.last_update_version}] at ${row.last_update_at}` : 'never'}; ` +
    `pending stable: ${pending ?? (upstream?.[track] ? 'none' : 'unknown')}` +
    `${row.bin_path ? '; updates paused while pinned' : ''}`;
}
