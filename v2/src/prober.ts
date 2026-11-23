/**
 * Runs the adapters' read-only probes and records each platform's state in platform_state: at service start, once a
 * day, and again when a job on that route fails with CLI_ERROR; usage is re-read every 30 minutes. Probes and usage
 * reads don't send prompts or spend money.
 * Only scheduled checks and explicit operator requests may also invoke an official CLI updater.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Store } from './store.ts';
import { UsageContractViolation, type CliBinary, type CliUpdateContext, type ProbeContext, type ProbeOverrides, type ProbeResult, type RunnerOptions } from './adapters/types.ts';
import { adapter, adapterIds } from './adapters/registry.ts';
import { compareCliVersions, isStableCliVersion, pendingStableVersion } from './adapters/cli-freshness.ts';
import { pendingSdkVersion, SdkRecoveryRequired } from './adapters/sdk-freshness.ts';
import { inspectSdkSwap, withSdkSwapFinalizer } from './adapters/openai-sdk.ts';
import type { SdkRecoveryEvent } from './adapters/sdk-swap.ts';

type Check = 'probe' | 'daily' | 'now' | 'sdk-now';
type ProbeStore = Pick<Store, 'platformState' | 'recordProbe' | 'beginCliUpdate' | 'finishCliUpdate' |
  'recordDiscovery' | 'seedProfiles' | 'recordDiscoveryFailure' | 'recordDiscoverySummary' | 'jobEvents' | 'jobState'> &
  Partial<Pick<Store, 'db' | 'setValidationOptions' | 'recordUsage' | 'usageFor' | 'blockUsageRead' | 'recordSdkSnapshot' | 'beginSdkUpdate' | 'finishSdkUpdate'>>;
const errorText = (error: unknown) => String((error as Error)?.message ?? error).replace(/\s+/g, ' ').slice(0, 250);
export const usageIdentity = (state: ReturnType<Store['platformState']>) =>
  JSON.stringify([state?.bin_selected_path ?? null, state?.bin_version ?? null, state?.binary_sha256 ?? null]);

/** Recovery may follow a crash after the original lease was created, finalized, or already recovered. */
export function recordSdkRecovery(store: Pick<Store, 'platformState' | 'recordProbe' | 'jobEvents'> &
  Partial<Pick<Store, 'db'>>, capabilities: import('./adapters/types.ts').AdapterCapabilities, event: SdkRecoveryEvent): void {
  const id = capabilities.id;
  if (!store.db) throw new Error('SDK recovery store unavailable');
  if (!store.platformState(id))
    store.recordProbe(capabilities, { state: 'blocked', reason: 'SDK recovery: a fresh probe is required' });
  const now = new Date().toISOString();
  const update = store.db.prepare(`UPDATE platform_state SET
    sdk_version=COALESCE(?, sdk_version), sdk_last_update_at=?, sdk_last_update_result=?, updated_at=?,
    last_update_result=CASE WHEN ?='recovery_failed' THEN 'running'
      WHEN last_update_result='running' THEN NULL ELSE last_update_result END
    WHERE adapter_id=?`);
  if (!update.run(event.result === 'recovered' ? event.version : null, now, event.result, now, event.result, id).changes)
    throw new Error('SDK recovery status not recorded');
  try { store.jobEvents.emit('sdk-recovery', { route: id, at: now, ...event }); }
  catch { /* An event subscriber must not undo a recorded recovery. */ }
}

const DAY = 24 * 60 * 60 * 1000;
const CATALOG_CHECK = 60 * 1000;
/** Match the guarded Antigravity helper's catalog lifetime. */
const AG_CATALOG_TTL = 60 * 60 * 1000;
/** Usage is re-read this often without a job (see refreshUsage). */
export const USAGE_REFRESH = 30 * 60 * 1000;
/** A failed job re-probes its route at most this often. */
const RECHECK_AFTER_FAILURE = 10 * 60 * 1000;

async function fileStamp(file: string): Promise<string> {
  try {
    const stat = await fs.stat(file);
    return stat.isFile() ? `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` : 'not a file';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? 'unavailable';
  }
}

interface CatalogObservation {
  stamp: string;
  expired?: boolean;
}

export class Prober {
  private readonly running = new Map<string, Promise<string>>();
  private readonly discovering = new Map<string, Promise<void>>();
  private readonly observing = new Map<string, Promise<void>>();
  /** Routes with a usage read waiting behind the current one (later requests join it). */
  private readonly observingQueued = new Set<string>();
  private readonly catalogStamps = new Map<string, string>();
  private lastAgDiscovery = -Infinity;
  private catalogRefresh?: Promise<void>;
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private usageTimer?: NodeJS.Timeout;
  private catalogTimer?: NodeJS.Timeout;
  private readonly onJob = (id: string) => this.afterJob(id);
  private readonly store: ProbeStore;
  private readonly home: string;
  private readonly options: RunnerOptions;
  private readonly overrides: ProbeOverrides;
  constructor(store: ProbeStore, home: string, options: RunnerOptions = {}, overrides: ProbeOverrides = {}) {
    this.store = store; this.home = home; this.options = options; this.overrides = overrides;
    this.store.setValidationOptions?.(options);
  }

  private ids(): string[] { return this.overrides.adapters ?? adapterIds(); }

  /** Only watch the files each route already uses as metadata, never its credentials or settings. */
  private async nativeCatalog(id: string, previousStamp?: string): Promise<CatalogObservation | undefined> {
    const homeOverride = this.overrides.cliModelHome;
    if (id === 'codex') {
      const directory = homeOverride ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
      return { stamp: path.isAbsolute(directory) ? await fileStamp(path.join(directory, 'models_cache.json')) : 'relative' };
    }
    if (id === 'claude') {
      const directory = homeOverride ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
      if (!path.isAbsolute(directory)) return { stamp: 'relative' };
      const catalog = path.join(directory, 'cache', 'model-catalog');
      try {
        const files = (await fs.readdir(catalog)).filter(name => name.endsWith('.json')).sort();
        const entries = await Promise.all(files.map(async name => [name, await fileStamp(path.join(catalog, name))]));
        return { stamp: JSON.stringify(entries) };
      } catch (error) {
        return { stamp: (error as NodeJS.ErrnoException).code ?? 'unavailable' };
      }
    }
    if (id === 'antigravity') {
      const directory = path.join(this.home, 'helpers', 'antigravity');
      const catalog = path.join(directory, 'catalog.json');
      const files = ['routing-state.json', 'candidate-attempts.json', 'acceptance.json']
        .map(name => path.join(directory, name));
      files.unshift(catalog);
      const stamp = JSON.stringify(await Promise.all(files.map(fileStamp)));
      if (stamp !== previousStamp) return { stamp };
      let fetchedAt = NaN;
      try { fetchedAt = Date.parse(JSON.parse(await fs.readFile(catalog, 'utf8')).fetched_at); }
      catch { /* A missing or unreadable cache can be refreshed by the verified helper. */ }
      const age = Date.now() - fetchedAt;
      return { stamp, expired: !Number.isFinite(age) || age < 0 || age >= AG_CATALOG_TTL };
    }
  }

  /** Re-read changed native catalogs; retry an overdue AG cache on the usage interval after a failed read. */
  refreshModelCatalogs(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.catalogRefresh) return this.catalogRefresh;
    const run = Promise.all(this.ids().map(async id => {
      const canRead = () => !this.stopped && !this.running.has(id) &&
        this.store.platformState(id)?.probe_state === 'verified' &&
        (id !== 'antigravity' || (!this.observing.has(id) && this.usageReadAllowed(id)));
      try {
        if (!canRead()) return;
        const previousStamp = this.catalogStamps.get(id);
        const observation = await this.nativeCatalog(id, previousStamp);
        if (!observation || !canRead()) return;
        const overdue = observation.expired && Date.now() - this.lastAgDiscovery >= USAGE_REFRESH;
        if (observation.stamp !== previousStamp || overdue) await this.discover(id);
      } catch { /* A concurrent stop can close the store during a read. */ }
    })).then(() => {}).finally(() => { this.catalogRefresh = undefined; });
    this.catalogRefresh = run;
    return run;
  }

  /** Ordinary probes are read-only, including probes triggered by failed jobs. */
  probe(id: string): Promise<void> { return this.check(id, 'probe').then(() => {}); }
  probeAll(): Promise<void> { return Promise.all(this.ids().map(id => this.probe(id))).then(() => {}); }
  daily(): Promise<void> { return Promise.all(this.ids().map(id => this.check(id, 'daily'))).then(() => {}); }
  updateNow(id: string): Promise<string> { return this.check(id, 'now'); }
  updateSdkNow(id: string): Promise<string> { return this.check(id, 'sdk-now'); }

  private check(id: string, mode: Check): Promise<string> {
    const pending = this.running.get(id);
    if (pending) return mode === 'probe' ? pending : pending.then(() => this.check(id, mode));
    const run = (async () => {
      const platform = adapter(id);
      if (!platform) return 'unknown route';
      const update = this.overrides.cliUpdate
        ? (ctx: CliUpdateContext) => this.overrides.cliUpdate!(id, ctx)
        : platform.update?.bind(platform);
      if (mode === 'now' && (!platform.binaries || !update)) return 'official updater unavailable';
      if (mode === 'sdk-now' && !platform.sdk) return 'SDK updater unavailable';
      if (platform.sdk) {
        const sdk = platform.sdk;
        try {
          const recoveryCtx: ProbeContext = { home: this.home, options: this.options, overrides: this.overrides, binPath: null };
          const recovery = await inspectSdkSwap(() => sdk.inspect(recoveryCtx), this.home,
            event => recordSdkRecovery(this.store, platform.capabilities, event));
          if (recovery === 'busy') return 'SDK filesystem operation already running';
          if (recovery === 'recovered') return 'SDK swap recovered; no update attempted';
          if (recovery === 'recovery_failed')
            return `SDK recovery_failed; see ${path.join(this.home, 'logs', 'sdk-recovery.log')}`;
          const state = this.store.platformState(id)?.sdk_last_update_result;
          if (state === 'running') return 'SDK update already running or interrupted';
          if (state === 'recovery_failed') return 'SDK recovery_failed; operator attention required';
        } catch { return 'SDK recovery inspection failed'; }
      }
      let pin: string | null = null, epoch: string | null = null;
      if (platform.binaries) {
        try {
          const state = this.store.platformState(id);
          if (state?.last_update_result === 'running') return 'update already running or interrupted';
          pin = state?.bin_path ?? null;
          epoch = state?.last_update_at ?? null;
        } catch { return 'store unavailable'; }
      }
      const ctx: ProbeContext = { home: this.home, options: this.options, overrides: this.overrides, binPath: pin };
      const upstream = platform.upstream
        ? Promise.resolve().then(() => this.overrides.upstream ? this.overrides.upstream(id) : platform.upstream!(ctx)).catch(() => null)
        : Promise.resolve(null);
      const scan = async () => {
        let installed: CliBinary[] | undefined, result: ProbeResult;
        try {
          if (platform.binaries) installed = await (this.overrides.binaries ? this.overrides.binaries(id) : platform.binaries(ctx));
          result = await platform.probe({ ...ctx, installed });
        } catch (error) { result = { state: 'blocked', reason: 'probe failed: ' + errorText(error) }; }
        return { installed: installed ?? [], result };
      };
      const before = await scan(), published = await upstream;
      const freshness = { pin, installed: before.installed, upstream: published, updateEpoch: epoch };
      try { this.store.recordProbe(platform.capabilities, before.result, platform.binaries ? freshness : undefined); }
      catch { return 'store unavailable'; }

      let outcome = 'no update requested';
      if ((mode === 'daily' || mode === 'now') && platform.binaries && update) {
        const target = pendingStableVersion(before.installed, published, platform.upstreamTrack);
        if (pin) outcome = 'updates paused while the executable path is pinned';
        else if (!target) outcome = 'no newer stable version for an installed stable CLI';
        else {
          let started: string | null;
          try { started = this.store.beginCliUpdate(id, target, epoch, mode === 'now'); }
          catch { return 'store unavailable'; }
          outcome = started
            ? await this.runUpdate(platform.capabilities, ctx, update, started, target, freshness, before.result)
            : 'update skipped: disabled, busy, rate limited, or route state changed';
        }
      }
      if (platform.sdk) {
        const sdkOutcome = await this.checkSdk(id, platform.sdk, ctx, mode);
        if (mode === 'sdk-now') return sdkOutcome;
      }
      await this.observeUsage(id);
      await this.discover(id);
      return outcome;
    })().finally(() => this.running.delete(id));
    this.running.set(id, run);
    return run;
  }

  private async checkSdk(id: string, sdk: NonNullable<import('./adapters/types.ts').PlatformAdapter['sdk']>,
    ctx: ProbeContext, mode: Check): Promise<string> {
    let lease: NonNullable<ReturnType<Store['beginSdkUpdate']>> | null, target: string | null;
    try {
      if (!this.store.recordSdkSnapshot || !this.store.beginSdkUpdate || !this.store.finishSdkUpdate)
        return 'SDK tracking unavailable';
      const state = this.store.platformState(id);
      if (state?.sdk_last_update_result === 'running') return 'SDK update already running or interrupted';
      if (state?.sdk_last_update_result === 'recovery_failed') return 'SDK recovery_failed; operator attention required';
      const epoch = state?.sdk_last_update_at ?? null;
      const snapshot = await sdk.inspect(ctx);
      if (!this.store.recordSdkSnapshot(id, snapshot, epoch)) return 'SDK state changed during inspection';
      if (mode !== 'daily' && mode !== 'sdk-now') return 'SDK tracked';
      target = pendingSdkVersion(snapshot);
      if (!target) return 'no newer stable SDK for the installed version';
      lease = this.store.beginSdkUpdate(id, target, epoch, mode === 'sdk-now');
    } catch { return 'SDK inspection or reservation failed'; }
    if (!lease) return 'SDK update skipped: disabled, busy, rate limited, or route state changed';

    const logPath = path.join(this.home, 'logs', `sdk-update-${lease.started.replace(/[:.]/g, '-')}.log`);
    const reservation = lease, version = target;
    let result = 'success', finalized = false;
    const finalize = (outcome: string) => {
      if (!this.store.finishSdkUpdate!(id, reservation, version, outcome)) throw new Error('lease finalization failed');
      finalized = true;
    };
    try { await withSdkSwapFinalizer(finalize, () => sdk.update({ ...ctx, targetVersion: version, logPath })); }
    catch (error) {
      if (error instanceof SdkRecoveryRequired) return `SDK update requires recovery; see ${logPath}`;
      result = 'failed: ' + errorText(error);
    }
    try { if (!finalized) finalize(result); }
    catch { return `could not finalize SDK update; see ${logPath}`; }
    return `${result} (${version}); log: ${logPath}`;
  }

  private async runUpdate(capabilities: import('./adapters/types.ts').AdapterCapabilities, ctx: ProbeContext,
    update: (ctx: CliUpdateContext) => Promise<void>, started: string, target: string,
    freshness: import('./adapters/types.ts').CliFreshness, before: ProbeResult): Promise<string> {
    const id = capabilities.id;
    const logPath = path.join(this.home, 'logs', `cli-update-${id}-${started.replace(/[:.]/g, '-')}.log`);
    let failure: string | undefined;
    try {
      await fs.mkdir(path.dirname(logPath), { recursive: true });
      await fs.writeFile(logPath, `${started} ${id}: updating to stable ${target}\n`, { flag: 'wx', mode: 0o600 });
      await update({ ...ctx, selected: before.binary, targetVersion: target, logPath });
    } catch (error) { failure = errorText(error) || 'official updater failed'; }

    // Always rescan: an installer can change files even if it exits unsuccessfully.
    let installed: CliBinary[] = [], probe: ProbeResult;
    try {
      const platform = adapter(id)!;
      installed = await (this.overrides.binaries ? this.overrides.binaries(id) : platform.binaries!(ctx));
      probe = await platform.probe({ ...ctx, installed });
    } catch (error) { probe = { state: 'blocked', reason: 'post-update probe failed: ' + errorText(error) }; }
    const selected = probe.state === 'verified' ? probe.binary?.version : undefined;
    if (!selected || !isStableCliVersion(selected) || compareCliVersions(selected, target) < 0)
      failure ??= `stable ${target} did not pass the post-update probe; selected ${selected ?? 'none'}`;
    const result = failure ? `failed: ${failure}` : 'success', version = failure ? target : selected!;
    try { await fs.appendFile(logPath, `\n${result}; selected ${selected ?? 'none'}\n`, { flag: 'a', mode: 0o600 }); }
    catch { /* The reservation must still be finalized if its log could not be written. */ }
    try { this.store.finishCliUpdate(capabilities, started, target, version, result, logPath, probe, { ...freshness, installed }); }
    catch {
      // Fail closed after interruption. A restarted process cannot assume that the installer stopped.
      return `could not finalize CLI update; see ${logPath}`;
    }
    return `${result} (${version}); log: ${logPath}`;
  }

  /** Discovery never runs a prompt, and a failed snapshot never retires any inventory entries. */
  discover(id: string): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const pending = this.discovering.get(id);
    if (pending) return pending;
    const run = (async () => {
      const platform = adapter(id);
      if (!platform?.discover) return;
      const identity = (state: ReturnType<Store['platformState']>) => JSON.stringify([
        state?.probe_state ?? null, usageIdentity(state), state?.last_update_at ?? null,
        state?.last_update_result ?? null, state?.sdk_version ?? null, state?.sdk_last_update_at ?? null,
        state?.sdk_last_update_result ?? null,
      ]);
      let before: ReturnType<Store['platformState']>;
      try { before = this.store.platformState(id); }
      catch { return; }
      const beforeIdentity = identity(before);
      const sameSelection = () => {
        return !this.stopped && identity(this.store.platformState(id)) === beforeIdentity;
      };
      const selected = platform.binaries && before?.probe_state === 'verified' && before.bin_selected_path && before.bin_version
        ? { path: before.bin_selected_path, version: before.bin_version, source: before.bin_source ?? 'selected' }
        : undefined;
      const ctx: ProbeContext = { home: this.home, options: this.options, overrides: this.overrides,
        binPath: before?.bin_path ?? null, cliVersion: selected?.version ?? null, selected };
      try {
        const observation = await this.nativeCatalog(id);
        if (!sameSelection()) return;
        if (observation) this.catalogStamps.set(id, observation.stamp);
        if (id === 'antigravity') this.lastAgDiscovery = Date.now();
        const rows = await platform.discover(ctx);
        if (!sameSelection()) return;
        this.store.recordDiscovery(id, rows);
        this.store.seedProfiles(id);
        if (id === 'codex' && selected) {
          // A successful native model/list may republish its own CLI cache. Acknowledge that write.
          const published = await this.nativeCatalog(id);
          if (published && sameSelection()) this.catalogStamps.set(id, published.stamp);
        }
      } catch (error) {
        try {
          if (sameSelection()) this.store.recordDiscoveryFailure(id, String((error as Error)?.message ?? error));
        } catch { /* the store closed meanwhile */ }
      } finally {
        if (platform.discoverySummary) {
          try {
            if (sameSelection() && this.store.platformState(id)?.probe_state === 'verified')
              this.store.recordDiscoverySummary(id, platform.discoverySummary(ctx));
          } catch { /* status must not turn a completed discovery into a failure */ }
        }
      }
    })().finally(() => this.discovering.delete(id));
    this.discovering.set(id, run);
    return run;
  }
  discoverAll(): Promise<void> { return Promise.all(this.ids().map(id => this.discover(id))).then(() => {}); }

  /** Check at startup, then daily (unless schedule is false); CLI_ERROR only triggers a read-only probe. */
  start(): void {
    if (this.overrides.schedule === false) void this.probeAll();
    else {
      void this.daily();
      this.timer = setInterval(() => void this.daily(), DAY);
      this.timer.unref();
      this.usageTimer = setInterval(() => void this.refreshUsage(), USAGE_REFRESH);
      this.usageTimer.unref();
      this.catalogTimer = setInterval(() => void this.refreshModelCatalogs(), CATALOG_CHECK);
      this.catalogTimer.unref();
    }
    this.store.jobEvents.on('job', this.onJob);
  }
  stop(): void {
    this.stopped = true;  // In-flight metadata reads record nothing after stop.
    if (this.timer) clearInterval(this.timer);
    if (this.usageTimer) clearInterval(this.usageTimer);
    if (this.catalogTimer) clearInterval(this.catalogTimer);
    this.store.jobEvents.off('job', this.onJob);
  }

  /**
   * Re-reads usage for verified routes that have no running job (a running job reports its own quota when it ends),
   * so allowance and pool steering do not rely on the last job's numbers. Never sends a prompt.
   */
  refreshUsage(): Promise<void> {
    return Promise.all(this.ids().map(id => this.observeUsage(id))).then(() => {});
  }
  /** A usage read can run past a queue held by a cooldown, since no job can start on that route yet. */
  private usageReadAllowed(id: string): boolean {
    if (this.stopped || !adapter(id)?.observeUsage) return false;
    try {
      const state = this.store.platformState(id);
      if (state?.probe_state !== 'verified') return false;
      if (state.usage_blocked_identity === usageIdentity(state)) return false;
      const held = Date.parse(state.cooldown_until ?? '') > Date.now();
      return !this.store.db?.prepare(`SELECT 1 FROM jobs WHERE route=? AND (status='running'
        OR (status='queued' AND (?=0 OR COALESCE(json_type(options,'$.auto'),'') <> 'object'))) LIMIT 1`)
        .get(id, held ? 1 : 0);
    } catch { return false; }  // unknown: do not read
  }

  /** Serialize local reads per route. A terminal event gets a new read, not an in-flight pre-job snapshot. */
  private observeUsage(id: string): Promise<void> {
    const platform = adapter(id);
    if (!platform?.observeUsage) return Promise.resolve();
    // A read already waiting covers this request too.
    if (this.observingQueued.has(id)) return this.observing.get(id) ?? Promise.resolve();
    this.observingQueued.add(id);
    const run = (this.observing.get(id) ?? Promise.resolve()).then(async () => {
      this.observingQueued.delete(id);
      // Rechecked when the read actually starts: a job may have started (or been queued) since the request.
      if (!this.usageReadAllowed(id)) return;
      const startedAt = new Date().toISOString();
      const before = this.store.platformState(id);
      const selected = before?.bin_selected_path && before.bin_version
        ? { path: before.bin_selected_path as string, version: before.bin_version as string, source: (before.bin_source as string | undefined) ?? 'selected' }
        : undefined;
      const usage = this.store.usageFor?.(id) ?? [];
      const jobWatermark = () => {
        const row = this.store.db?.prepare(
          "SELECT COALESCE(MAX(seq),0) seq, COALESCE(MAX(started_at),'') st, COALESCE(MAX(finished_at),'') fn FROM jobs WHERE route=? AND started_at IS NOT NULL"
        ).get(id) as { seq: number; st: string; fn: string } | undefined;
        return row ? `${row.seq}|${row.st}|${row.fn}` : '';
      };
      const markBefore = jobWatermark();
      try {
        const snapshot = await platform.observeUsage!({
          home: this.home, options: this.options, overrides: this.overrides,
          binPath: (before?.bin_path as string | null | undefined) ?? null,
          cliVersion: (before?.bin_version as string | null | undefined) ?? null,
          selected, usage,
        });
        if (!snapshot || this.stopped || !this.usageReadAllowed(id)) return;
        const after = this.store.platformState(id);
        if ((before?.bin_selected_path ?? null) !== (after?.bin_selected_path ?? null)
          || (before?.bin_version ?? null) !== (after?.bin_version ?? null)
          || (before?.bin_path ?? null) !== (after?.bin_path ?? null)
          || (before?.last_update_at ?? null) !== (after?.last_update_at ?? null)
          || after?.last_update_result === 'running') return;
        if (jobWatermark() !== markBefore) return;
        const rows = snapshot.rows.map(row => ({ ...row, observed_at: row.observed_at ?? startedAt }));
        this.store.recordUsage?.(id, rows, snapshot.source, startedAt, snapshot.partial);
      } catch (error) {
        if (error instanceof UsageContractViolation) {
          const identity = usageIdentity(before);
          try {
            if (usageIdentity(this.store.platformState(id)) === identity) this.store.blockUsageRead?.(id, identity);
          } catch { /* store closed */ }
          console.error(JSON.stringify({ event: 'usage.control_violation', route: id, message: errorText(error) }));
        }
      }
    }).finally(() => {
      if (this.observing.get(id) === run) this.observing.delete(id);
    });
    this.observing.set(id, run);
    return run;
  }

  private afterJob(id: string): void {
    let job;
    try { job = this.store.jobState(id); } catch { return; }
    if (!job || !this.ids().includes(job.route)) return;
    if (['completed', 'failed', 'cancelled', 'needs_review'].includes(job.status)) void this.observeUsage(job.route);
    if (job.status !== 'failed' || !String(job.error ?? '').startsWith('CLI_ERROR')) return;
    const recheck = () => {
      if (this.stopped) return;
      const last = this.store.platformState(job.route)?.last_probe_at;
      if (!last || Date.now() - Date.parse(last) >= RECHECK_AFTER_FAILURE) void this.probe(job.route);
    };
    // An active probe may already have recorded its result and still be reading usage or discovery metadata.
    const activeProbe = this.running.get(job.route);
    if (activeProbe) void activeProbe.then(recheck).catch(() => {});
    else recheck();
  }
}
