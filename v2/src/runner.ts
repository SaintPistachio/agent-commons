import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Store, Json } from './store.ts';
import type { Active, RunContext, RunnerOptions } from './adapters/types.ts';
import { adapter, adapterIds, allAdapters } from './adapters/registry.ts';
import { editDiff, git, killTree, patchWorktreeGitArgs, worktreeChangedFiles } from './adapters/shared.ts';
import { execFileSync } from 'node:child_process';
import { AIR_WORKER_PRIMER, AIR_PATCH_PRIMER } from './air/primer.ts';
import { resolveContextRoot } from './context.ts';
import { launchPatchEdit } from './patch-edit.ts';
import { removePatchCheck } from './patch-check.ts';

/** Wrap untrusted context or transcripts in a per-launch cryptographic nonce fence so embedded @ctx/@request markers cannot forge instructions. */
export function fenceUntrustedData(text: string): string {
  let nonce: string;
  do { nonce = randomBytes(16).toString('hex'); } while (text.includes(nonce));
  return `===DATA-${nonce}===\n${text}\n===END-DATA-${nonce}===`;
}

// Platform code lives in v2/src/adapters; these names stay exported here for existing callers.
export type { RouteCommand, RunnerOptions } from './adapters/types.ts';
export { resolveClaude } from './adapters/claude.ts';
export { resolveCodex } from './adapters/codex.ts';
export { resolveOpenAIHelper } from './adapters/openai-api.ts';
export { resolveAntigravity } from './adapters/antigravity.ts';

/** Runs queued jobs inside the service (so they outlive the app that submitted them), one platform adapter per route. */
export class Runner {
  private readonly active = new Map<string, Active>();
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private readonly store: Store;
  private readonly home: string;
  private readonly options: RunnerOptions;
  constructor(store: Store, home: string, options: RunnerOptions = {}) { this.store = store; this.home = home; this.options = options; }

  /** Marks jobs left running by a previous service process for review, then starts polling. */
  start(): void {
    const reconciling = allAdapters().filter(a => a.reconcile).map(a => a.capabilities.id);
    // Jobs a graceful stop() recorded for review have not been asked yet (read before the loop below adds more).
    const stopped = this.store.unreconciledJobs(reconciling);
    for (const job of this.store.runningJobs()) {
      if (job.pid && job.options?.patch_state?.phase !== 'check') killTree(job.pid); // an orphaned worker must not keep writing
      this.store.updateJob(job.id, { status: 'needs_review', error: 'SERVICE_STOPPED_DURING_JOB', finished_at: new Date().toISOString() });
      // The platform may still know the outcome (for the API: ask the helper's ledger; never a resubmission).
      this.reconcile(job);
    }
    for (const job of stopped) this.reconcile(job);
    for (const job of this.store.unresolvedPatchChecks()) this.reconcilePatchCheck(job);
    this.timer = setInterval(() => this.tick(), this.options.tickMs ?? 2000);
    this.timer.unref();
    this.tick();
  }
  private reconcile(job: Json): void {
    const route = adapter(job.route);
    if (route?.reconcile) void route.reconcile(job, { store: this.store, options: this.options, home: this.store.home });
  }

  private reconcilePatchCheck(job: Json): void {
    const state = job.options.patch_state;
    const name = `ac-check-${job.id}-${state.turn}`;
    try {
      if (state.container !== name || typeof state.docker !== 'string' || !path.isAbsolute(state.docker)) return;
      if (removePatchCheck(state.docker, path.join(this.home, 'jobs', job.id), name))
        this.store.annotateJob(job.id, { patch_state: { ...state, phase: 'check_stopped' } });
    } catch { /* Leave an unconfirmed check visible in needs_review. */ }
  }

  /** Stops polling and ends running jobs; they are recorded as needs_review, never re-run. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    for (const [id, active] of this.active) {
      active.reason = 'SERVICE_STOPPED_DURING_JOB';
      clearTimeout(active.timer);
      if (active.child?.pid) killTree(active.child.pid);
      try { active.cleanup?.(); } catch { /* best effort */ }
      let extra: Json = {};
      try { extra = active.stopFields?.() ?? {}; } catch { /* best effort */ }
      this.finish(id, 'needs_review', { ...extra, error: active.reason });
    }
  }

  tick(): void {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const job of this.store.runningJobs()) {
        const active = this.active.get(job.id);
        if (job.cancel_requested && active && !active.reason) { active.reason = 'CANCELLED'; if (active.child?.pid) killTree(active.child.pid); try { active.cleanup?.(); } catch { /* best effort */ } }
      }
      // Read on every pass, so an operator's `limits` change applies without a restart.
      const { routes: limits, global: globalLimit } = this.limits();
      for (let job = this.store.claimQueuedJob(limits, globalLimit); job; job = this.store.claimQueuedJob(limits, globalLimit)) {
        try { this.launch(job); }
        catch (error) {
          // Setup failed before a worker was tracked (nothing was started or submitted): do not leave the job running.
          if (!this.active.has(job.id)) this.finish(job.id, 'failed', { error: 'LAUNCH_FAILED: ' + String((error as Error)?.message ?? error).slice(0, 300) });
        }
      }
    } catch (error) {
      console.error(JSON.stringify({ event: 'runner.tick_failed', error: String((error as Error)?.message ?? error) }));
    } finally { this.ticking = false; }
  }

  /**
   * This pass's limits. Per route: operator override ?? routeLimits (a test seam that replaces the adapter defaults, as
   * before) ?? the adapter default. Global: operator setting ?? globalLimit option ?? 3.
   */
  limits(): { routes: Record<string, number>; global: number } {
    const effective = this.store.effectiveLimits(allAdapters().map(a => a.capabilities.id), this.options.globalLimit);
    return { routes: this.options.routeLimits ? { ...this.options.routeLimits, ...effective.overrides } : effective.routes, global: effective.global };
  }

  private observeWorkerReply(id: string, reply?: Json): void {
    if (reply) {
      try {
        const job = this.store.jobRecord(id);
        const route = job && adapter(job.route);
        if (job && route?.usage) this.store.recordUsage(job.route, route.usage(reply), 'reply');
      } catch (error) {
        console.error(JSON.stringify({ event: 'runner.usage_failed', job: id, error: String((error as Error)?.message ?? error).slice(0, 300) }));
      }
      try {
        const job = this.store.jobRecord(id);
        const route = job && adapter(job.route);
        const consumption = route?.consumption?.(reply);
        if (job && consumption) this.store.recordConsumption(job.route, consumption.family, consumption.rows, id);
      } catch (error) {
        console.error(JSON.stringify({ event: 'runner.consumption_failed', job: id, error: String((error as Error)?.message ?? error).slice(0, 300) }));
      }
    }
  }

  private finish(id: string, status: string, fields: Json = {}, reply?: Json): void {
    this.observeWorkerReply(id, reply);
    this.active.delete(id);
    this.attachEditDiff(id);
    const job = this.store.jobRecord(id);
    if (job?.options?.patch_edit && job.workdir) fields = { ...fields, changed_files: this.changedFiles(job, job.workdir) };
    if (status === 'completed' && job?.options?.patch_edit && !job.options.diff_artifact) {
      status = job.options.git_diff_error ? 'needs_review' : 'failed';
      fields = { ...fields, result: null, error: job.options.git_diff_error ? 'PATCH_EDIT_DIFF_UNAVAILABLE' : 'PATCH_EDIT_NO_DIFF' };
    }
    this.store.updateJob(id, { ...fields, status, pid: null, finished_at: new Date().toISOString() });
  }
  /** An edit job's changes against its starting commit (new files included) become a diff artifact with a short stat. */
  private attachEditDiff(id: string): void {
    const job = this.store.jobRecord(id);
    if (!job || job.mode !== 'edit' || !job.workdir || !job.base_revision || !fs.existsSync(job.workdir)) return;
    try {
      const diff = editDiff(job.workdir, job.base_revision, job.options?.git_dir, this.home, !!job.options?.patch_edit);
      if (diff) this.store.attachDiff(id, diff.patch, diff.stat);
    } catch (error) {
      const msg = String((error as Error)?.message ?? error).slice(0, 300);
      console.error(JSON.stringify({ event: 'runner.diff_failed', job: id, error: msg }));
      try { this.store.annotateJob(id, { git_diff_error: msg }); } catch { /* best effort */ }
    }
  }
  /** The worker's prompt: the protocol primer, the resolved context (ctx=), then the request. */
  private workerPrompt(job: Json): string {
    const o = job.options ?? {}, parts: string[] = [];
    if (o.proto === 'air') parts.push(AIR_WORKER_PRIMER);
    else if (o.proto === 'patch') parts.push(AIR_PATCH_PRIMER);
    if (o.ctx_artifact) {
      const ctxText = this.store.artifactContent(o.ctx_artifact) ?? (() => { throw new Error('the job context artifact is missing'); })();
      parts.push(fenceUntrustedData(ctxText));
    }
    let reqPrompt = String(job.prompt ?? '');
    if (Array.isArray(o.room_transcript_range) && o.room_transcript_range.length === 2) {
      const [start, end] = o.room_transcript_range as [number, number];
      if (Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end >= start && end <= reqPrompt.length) {
        reqPrompt = reqPrompt.slice(0, start) + fenceUntrustedData(reqPrompt.slice(start, end)) + reqPrompt.slice(end);
      }
    }
    return parts.length ? [...parts, '@request\n' + reqPrompt].join('\n\n') : reqPrompt;
  }

  private launch(job: Json): void {
    const dir = path.join(this.home, 'jobs', job.id);
    fs.mkdirSync(dir, { recursive: true });
    const route = adapter(job.route);
    if (!route) return this.finish(job.id, 'failed', { error: 'ROUTE_UNAVAILABLE: ' + job.route });
    // The CLI version the last probe saw, so results can be compared across CLI updates.
    const version = this.store.platformState(job.route)?.cli_version;
    if (version) this.store.updateJob(job.id, { adapter_version: version });
    const ctx: RunContext = {
      store: this.store, home: this.home, options: this.options, dir,
      finish: (status, fields, reply) => this.finish(job.id, status, fields, reply),
      usage: () => this.store.usageFor(job.route),
      annotate: options => this.store.annotateJob(job.id, options),
      reviewFamily: () => this.store.reviewFamily(job),
      track: active => { this.active.set(job.id, active); },
      active: () => this.active.get(job.id),
      prepareWorkdir: () => this.prepareWorkdir(job),
      changedFiles: cwd => this.changedFiles(job, cwd),
    };
    let prompt: string;
    try { prompt = this.workerPrompt(job.options?.patch_edit ? { ...job, options: { ...job.options, proto: null } } : job); }
    catch (error) { return this.finish(job.id, 'failed', { error: 'CONTEXT_FAILED: ' + String((error as Error).message).slice(0, 300) }); }
    if (job.options?.patch_edit) launchPatchEdit(job, route, ctx, { prompt, fence: fenceUntrustedData,
      observe: reply => this.observeWorkerReply(job.id, reply) });
    else route.launch({ ...job, prompt }, ctx);
  }

  /** Advice uses the selected cwd. Edit gets a new, isolated worktree based on that checkout's HEAD. */
  private prepareWorkdir(job: Json): string {
    const projectRoot = this.store.projectRoot(job.project_id);
    if (!projectRoot || !fs.existsSync(projectRoot)) throw new Error('project root not found');
    const root = job.options?.cwd ? resolveContextRoot(projectRoot, job.options.cwd, [this.home]) : projectRoot;
    if (job.mode === 'advice') { this.store.updateJob(job.id, { workdir: root }); return root; }
    const base = job.options?.patch_edit?.base ?? git(root, ['rev-parse', 'HEAD']);
    const branch = `ac/job-${job.id.slice(0, 8)}`, workdir = path.join(this.home, 'worktrees', job.id);
    fs.mkdirSync(path.dirname(workdir), { recursive: true });
    if (job.options?.patch_edit) {
      const run = (cwd: string, args: string[]) => execFileSync('git', [...patchWorktreeGitArgs(cwd, undefined, this.home), ...args],
        { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      run(root, ['worktree', 'add', '--no-checkout', '--no-track', '-b', branch, workdir, base]);
      this.store.updateJob(job.id, { workdir, branch });
      run(workdir, ['reset', '--hard', '--no-recurse-submodules', base]);
    } else git(root, ['worktree', 'add', '-b', branch, workdir, base]);
    const gitDir = git(workdir, ['rev-parse', '--absolute-git-dir']);
    this.store.annotateJob(job.id, { git_dir: gitDir });
    this.store.updateJob(job.id, { workdir, branch, base_revision: base });
    return workdir;
  }

  private changedFiles(job: Json, cwd: string): string[] {
    const latest = this.store.jobRecord(job.id);
    try { return worktreeChangedFiles(cwd, latest?.base_revision, latest?.options?.git_dir, this.home, !!latest?.options?.patch_edit); }
    catch (error) {
      const msg = String((error as Error)?.message ?? error).slice(0, 300);
      console.error(JSON.stringify({ event: 'runner.changed_files_failed', job: job.id, error: msg }));
      try { this.store.annotateJob(job.id, { git_inspect_error: msg }); } catch { /* best effort */ }
      return [];
    }
  }
}
