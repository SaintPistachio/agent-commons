/**
 * Operator maintenance for the Agent Commons home (cli.ts backup, job-diff, job-drop, prune, rotate-log). These act
 * only on Agent Commons' own data: its database, job folders, job worktrees and branches, releases and log.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import type { Store, Json } from './store.ts';
import { fail } from './errors.ts';
import { editDiff, worktreeGit } from './adapters/shared.ts';
import { adapter } from './adapters/registry.ts';

const FINISHED = ['completed', 'failed', 'cancelled', 'needs_review'];
const BACKUP_NAME = /^commons-\d{8}T\d{9}Z(-\d+)?\.sqlite$/;

/**
 * Copies the database with SQLite's online backup API (safe while the service runs) to
 * backups/commons-<UTC timestamp>.sqlite, checks the copy, and keeps the newest `keep` of these timestamped copies.
 * Opens the database read-only and never through Store, so it never migrates the schema.
 */
export async function backupDatabase(home: string, keep = 10): Promise<{ file: string; removed: string[] }> {
  if (!Number.isInteger(keep) || keep < 1) throw new Error('--keep must be 1 or more');
  const dir = path.join(home, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('.', '');
  let file = path.join(dir, `commons-${stamp}.sqlite`);
  for (let n = 1; fs.existsSync(file); n++) file = path.join(dir, `commons-${stamp}-${n}.sqlite`);
  const live = new DatabaseSync(path.join(home, 'commons.sqlite'), { readOnly: true });
  try { await backup(live, file); } finally { live.close(); }
  // A backup is one self-contained file: switch the copy out of WAL mode so it leaves no -wal/-shm files beside it.
  const copy = new DatabaseSync(file);
  try {
    copy.exec('PRAGMA journal_mode=DELETE');
    if ((copy.prepare('PRAGMA integrity_check').get() as Json).integrity_check !== 'ok') throw new Error(`backup ${file} failed its integrity check`);
  } finally { copy.close(); }
  const removed = fs.readdirSync(dir).filter(name => BACKUP_NAME.test(name)).sort().reverse().slice(keep);
  for (const name of removed) for (const suffix of ['', '-wal', '-shm']) fs.rmSync(path.join(dir, name + suffix), { force: true });
  return { file, removed };
}

/**
 * cli.ts restore: copies a database backup into a new, empty home (never over a live one). Checks the backup's
 * integrity and schema first, copies it with SQLite's backup API, then makes the copy safe to start: jobs that were
 * running become needs_review (their outcome is unknown) and queued jobs are cancelled, so a restored service never
 * re-runs or replays work, paid or not. Actor tokens are kept, so the apps' existing connection files still work.
 * Connection files, artifacts kept as files and job folders are not in the database backup; copy them separately.
 */
export async function restoreDatabase(source: string, home: string, schemaVersion: number): Promise<{ file: string; schema: number; running: number; queued: number }> {
  if (!fs.existsSync(source)) fail('NOT_FOUND', 404, `no backup at ${source}`);
  const file = path.join(home, 'commons.sqlite');
  for (const f of [file, file + '-wal', file + '-shm']) if (fs.existsSync(f)) fail('HOME_NOT_EMPTY', 409, `${f} exists; restore only into a new home`);
  // Built privately and published last: the database only appears under its real name after its jobs are made safe,
  // and publishing never replaces a file (a hard link fails if the name exists), so a service that started meanwhile
  // keeps its own database.
  const staging = path.join(home, `commons.restoring-${process.pid}-${Date.now()}.sqlite`);
  const cleanup = () => { for (const f of [staging, staging + '-wal', staging + '-shm', staging + '-journal']) fs.rmSync(f, { force: true }); };
  const src = new DatabaseSync(source, { readOnly: true });
  let schema: number;
  try {
    if ((src.prepare('PRAGMA integrity_check').get() as Json).integrity_check !== 'ok') fail('BACKUP_CORRUPT', 400, `${source} failed its integrity check`);
    schema = Number((src.prepare('PRAGMA user_version').get() as Json).user_version);
    if (schema > schemaVersion) fail('SCHEMA_TOO_NEW', 400, `the backup has schema ${schema}; this release supports up to ${schemaVersion}`);
    if (schema < 1) fail('BACKUP_CORRUPT', 400, `${source} is not an Agent Commons database`);
    fs.mkdirSync(home, { recursive: true });
    await backup(src, staging);
  } catch (error) { cleanup(); throw error; }
  finally { src.close(); }
  let running = 0, queued = 0;
  const db = new DatabaseSync(staging);
  try {
    db.exec('PRAGMA journal_mode=DELETE');
    db.exec('BEGIN IMMEDIATE');
    const at = new Date().toISOString();
    running = Number(db.prepare("UPDATE jobs SET status='needs_review', error='RESTORED_FROM_BACKUP: was running when the backup was taken; outcome unknown, never replayed', finished_at=coalesce(finished_at, ?) WHERE status='running'").run(at).changes);
    queued = Number(db.prepare("UPDATE jobs SET status='cancelled', error='RESTORED_FROM_BACKUP: was queued when the backup was taken; resubmit if still needed', finished_at=coalesce(finished_at, ?) WHERE status='queued'").run(at).changes);
    db.exec('COMMIT');
    if ((db.prepare('PRAGMA integrity_check').get() as Json).integrity_check !== 'ok') fail('RESTORE_FAILED', 500, `${staging} failed its integrity check after the restore`);
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); db.close(); cleanup(); throw error; }
  db.close();
  try { fs.linkSync(staging, file); }
  catch (error) {
    cleanup();
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('HOME_NOT_EMPTY', 409, `${file} appeared during the restore; nothing was replaced`);
    throw error;
  }
  cleanup();
  return { file, schema, running, queued };
}

/** A job's changes: from its worktree while it exists, otherwise from its saved diff artifact. */
export function jobDiff(store: Store, ref: string): string {
  const job = store.jobByRef(ref);
  if (job.workdir && job.base_revision && fs.existsSync(job.workdir) && job.mode === 'edit') {
    const diff = editDiff(job.workdir, job.base_revision, job.options?.git_dir, !!job.options?.patch_edit);
    return diff ? `${diff.stat}\n${diff.patch}` : '(no changes)';
  }
  const saved = job.options?.diff_artifact ? store.artifactContent(job.options.diff_artifact) : undefined;
  return saved ? `${job.options.diff_stat ?? ''} (saved diff)\n${saved}` : '(no diff: not an edit job, or nothing changed)';
}

/**
 * Removes a finished edit job's worktree and deletes its ac/job-* branch. A worktree with uncommitted changes, or a
 * branch not merged into the project's HEAD, is refused unless `force` (the diff stays saved as an artifact).
 */
export function dropJob(store: Store, ref: string, force: boolean): string[] {
  const job = store.jobByRef(ref);
  if (!FINISHED.includes(job.status)) fail('JOB_NOT_FINISHED', 409, `job is ${job.status}`);
  if (job.mode !== 'edit' || !job.branch) fail('NOT_AN_EDIT_JOB', 400, 'only edit jobs have a worktree and branch');
  const root = store.approvedProjectRoot(job.project_id);
  const git = worktreeGit;
  const lines: string[] = [];
  const exists = !!job.workdir && fs.existsSync(job.workdir);
  if (exists && !force && git(job.workdir, ['status', '--porcelain', '--ignore-submodules=all'], job.options?.git_dir))
    fail('WORKTREE_DIRTY', 409, `the worktree has uncommitted changes${job.options?.diff_artifact ? ' (its diff is saved)' : ''}; review them or pass --force`);
  const branchExists = !!git(root, ['branch', '--list', job.branch]);
  if (branchExists && !force && !git(root, ['branch', '--merged', 'HEAD', '--list', job.branch]))
    fail('BRANCH_UNMERGED', 409, `${job.branch} has commits not merged into HEAD; merge them or pass --force`);
  if (exists) { git(root, ['worktree', 'remove', ...(force ? ['--force'] : []), job.workdir]); lines.push(`removed worktree ${job.workdir}`); }
  else { git(root, ['worktree', 'prune']); }
  if (branchExists) { git(root, ['branch', force ? '-D' : '-d', job.branch]); lines.push(`deleted branch ${job.branch}`); }
  return lines.length ? lines : ['nothing to remove'];
}

/**
 * Removes job folders of jobs that finished more than `olderThanDays` ago (their database rows stay), releases beyond
 * the newest `keepReleases` (never current's target), and the worktrees of such jobs when clean and merged (any, with
 * `force`). `dryRun` only reports. Unfinished jobs are never touched.
 */
export function pruneHome(store: Store, home: string, options: { olderThanDays?: number; keepReleases?: number; dryRun?: boolean; force?: boolean } = {}): string[] {
  const days = options.olderThanDays ?? 14, keep = options.keepReleases ?? 5, dry = options.dryRun === true;
  const cutoff = Date.now() - days * 86400000, lines: string[] = [];
  const remove = (target: string, what: string) => { lines.push(`${dry ? 'would remove' : 'removed'} ${what} ${target}`); if (!dry) fs.rmSync(target, { recursive: true, force: true }); };
  const old = (job: Json | undefined) => !!job && FINISHED.includes(job.status) && !!job.finished_at && Date.parse(job.finished_at) < cutoff;
  const jobsDir = path.join(home, 'jobs');
  if (fs.existsSync(jobsDir)) for (const id of fs.readdirSync(jobsDir)) if (old(store.jobRecord(id))) remove(path.join(jobsDir, id), 'job folder');
  const appDir = path.join(home, 'app');
  if (fs.existsSync(appDir)) {
    let currentTarget = '';
    try { currentTarget = fs.realpathSync(path.join(home, 'current')).toLowerCase(); } catch { /* no current yet */ }
    const releases = fs.readdirSync(appDir).filter(name => !name.endsWith('.staging')).map(name => path.join(appDir, name))
      .filter(dir => fs.statSync(dir).isDirectory()).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    const others = releases.filter(dir => fs.realpathSync(dir).toLowerCase() !== currentTarget);
    for (const dir of others.slice(keep)) remove(dir, 'release');
  }
  const worktrees = path.join(home, 'worktrees');
  if (fs.existsSync(worktrees)) for (const id of fs.readdirSync(worktrees)) {
    const job = store.jobRecord(id);
    if (!old(job)) continue;
    if (dry) { lines.push(`would drop job worktree ${path.join(worktrees, id)} (if clean and merged, or with --force)`); continue; }
    try { lines.push(...dropJob(store, id, options.force === true)); }
    catch (error) { lines.push(`kept worktree ${path.join(worktrees, id)}: ${(error as Error).message}`); }
  }
  return lines.length ? lines : ['nothing to prune'];
}

/**
 * Read-only. Latest decision and verification per job; applied/redone count jobs, not repeated reports.
 * Repair rate: finished caller jobs (no trigger) that got an automatic repair. Cost to acceptance: per accepted
 * assignment, the known cost of its root, everything linked to the root (yield consults and continuations, its
 * repair) and any redone predecessors; an assignment with a paid job of unknown cost is unknown, not free.
 */
export function outcomeStats(store: Store): string[] {
  const rows = store.db.prepare(`
    SELECT j.id, j.route, j.req_intent, j.req_eff, j.resolved_model, j.reported_model, j.resolved_eff,
      j.status, j.cost_usd, j.latency_ms, j.trigger,
      (SELECT count(*) FROM job_outcomes WHERE job_id=j.id) samples,
      EXISTS(SELECT 1 FROM job_outcomes WHERE job_id=j.id AND kind='applied') applied,
      EXISTS(SELECT 1 FROM job_outcomes WHERE job_id=j.id AND kind='redone') redone,
      EXISTS(SELECT 1 FROM jobs r WHERE r.repair_of=j.id) repaired,
      (SELECT kind FROM job_outcomes WHERE job_id=j.id AND kind IN ('accepted','rejected') ORDER BY id DESC LIMIT 1) decision,
      (SELECT kind FROM job_outcomes WHERE job_id=j.id AND kind IN ('verify_pass','verify_fail') ORDER BY id DESC LIMIT 1) verification
    FROM jobs j ORDER BY j.route, j.req_intent, j.req_eff, j.resolved_model, j.reported_model, j.resolved_eff
  `);
  type Group = {
    label: string; jobs: number; completed: number; samples: number; feedbackJobs: number; applied: number;
    redone: number; accepted: number; rejected: number; passed: number; verified: number; costs: number[]; latencies: number[];
    roots: number; repaired: number; toAccept: number[]; toAcceptUnknown: number;
  };
  const groups = new Map<string, Group>(), groupOf = new Map<string, Group>();
  for (const row of rows.iterate() as Iterable<Json>) {
    const key = JSON.stringify([row.route, row.req_intent, row.req_eff, row.resolved_model, row.reported_model, row.resolved_eff]);
    const label = `route=${row.route} intent=${row.req_intent ?? 'unknown'} effort=${row.req_eff ?? 'unknown'}` +
      ` resolved=${JSON.stringify(row.resolved_model)} reported=${JSON.stringify(row.reported_model)} native_effort=${JSON.stringify(row.resolved_eff)}`;
    const g = groups.get(key) ?? {
      label, jobs: 0, completed: 0, samples: 0, feedbackJobs: 0, applied: 0, redone: 0,
      accepted: 0, rejected: 0, passed: 0, verified: 0, costs: [], latencies: [], roots: 0, repaired: 0, toAccept: [], toAcceptUnknown: 0,
    };
    groups.set(key, g);
    groupOf.set(row.id, g);
    g.jobs++;
    g.completed += Number(row.status === 'completed');
    g.samples += Number(row.samples);
    g.feedbackJobs += Number(row.samples > 0);
    g.applied += Number(row.applied);
    g.redone += Number(row.redone);
    g.accepted += Number(row.decision === 'accepted');
    g.rejected += Number(row.decision === 'rejected');
    g.verified += Number(row.verification != null);
    g.passed += Number(row.verification === 'verify_pass');
    if (row.trigger == null && FINISHED.includes(row.status)) { g.roots++; g.repaired += Number(row.repaired); }
    const known = knownCost(row.cost_usd);
    if (known !== null) g.costs.push(known);
    if (typeof row.latency_ms === 'number' && row.latency_ms >= 0) g.latencies.push(row.latency_ms);
  }
  for (const assignment of acceptedAssignments(store)) {
    const g = groupOf.get(assignment.root);
    if (!g) continue;
    if (assignment.cost === null) g.toAcceptUnknown++;
    else g.toAccept.push(assignment.cost);
  }
  const median = (values: number[], digits: number) => {
    if (!values.length) return 'unknown (n=0)';
    values.sort((a, b) => a - b);
    const middle = (values[Math.floor((values.length - 1) / 2)] + values[Math.floor(values.length / 2)]) / 2;
    return `${middle.toFixed(digits)} (n=${values.length})`;
  };
  const toAccept = (g: Group) => {
    const unknown = g.toAcceptUnknown ? ` unknown=${g.toAcceptUnknown}` : '';
    if (!g.toAccept.length) return `cost_to_accept_usd=unknown (n=0${unknown ? ',' + unknown : ''})`;
    const total = g.toAccept.reduce((sum, value) => sum + value, 0);
    return `cost_to_accept_usd median=${median([...g.toAccept], 4)} total=${total.toFixed(4)}${unknown}`;
  };
  return ['answer outcomes (null model = unknown):', ...(groups.size ? [...groups.values()].map(g =>
    `  ${g.label} jobs=${g.jobs} completed=${g.completed} outcomes=${g.samples} feedback_jobs=${g.feedbackJobs}` +
    `${g.samples < 5 ? ' insufficient' : ''} applied=${g.applied} accepted=${g.accepted} rejected=${g.rejected} redone=${g.redone}` +
    ` verify_pass_rate=${g.verified ? (100 * g.passed / g.verified).toFixed(0) + '%' : 'unknown'} (${g.passed}/${g.verified})` +
    ` median_cost_usd=${median(g.costs, 4)} median_latency_ms=${median(g.latencies, 1)}` +
    ` repair_rate=${g.roots ? (100 * g.repaired / g.roots).toFixed(0) + '%' : 'unknown'} (${g.repaired}/${g.roots}) ${toAccept(g)}`) : ['  no jobs yet'])];
}

/** A recorded price: a finite, non-negative number; anything else is not a price. */
export function knownCost(value: unknown): number | null {
  return value != null && String(value).trim() && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
}

const MAX_LINEAGE = 500;

/**
 * Accepted assignments with their total known cost through acceptance, keyed by the root job whose configuration
 * they are credited to. A job is accepted when its latest decision is `accepted`. Its assignment root is found by
 * following `repair_of` and yield/resume parent links (cycle-safe). A root that was later redone with a named
 * replacement is superseded: its cost moves to the replacement's assignment (through the latest redone link only, so
 * a fork is credited once), and it is not an assignment of its own. Each assignment counts once. The cost is unknown
 * when a paid job in it has no valid price or the lineage exceeds 500 jobs.
 */
export function acceptedAssignments(store: Store): Array<{ root: string; cost: number | null; jobs: number }> {
  const db = store.db;
  const accepted = db.prepare(`SELECT j.id FROM jobs j WHERE (
    SELECT kind FROM job_outcomes WHERE job_id=j.id AND kind IN ('accepted','rejected') ORDER BY id DESC LIMIT 1) = 'accepted'
    ORDER BY j.seq`).all() as Json[];
  const self = db.prepare('SELECT id, route, cost_usd, trigger, parent_job_id, repair_of FROM jobs WHERE id=?');
  const children = db.prepare('SELECT id FROM jobs WHERE parent_job_id=? OR repair_of=?');
  // The latest redone outcome of each job decides its replacement.
  const latestRedone = `SELECT o.job_id, json_extract(o.detail,'$.replacement_job_id') replacement FROM job_outcomes o
    WHERE o.kind='redone' AND json_valid(o.detail) AND o.id=(SELECT max(id) FROM job_outcomes WHERE job_id=o.job_id AND kind='redone')`;
  const replacedBy = db.prepare(`SELECT replacement FROM (${latestRedone}) WHERE job_id=? AND replacement IS NOT NULL`);
  const predecessors = db.prepare(`SELECT job_id FROM (${latestRedone}) WHERE replacement=?`);
  const rootOf = (id: string): string => {
    const seen = new Set<string>();
    let current = id;
    for (;;) {
      if (seen.has(current)) return current;
      seen.add(current);
      const row = self.get(current) as Json | undefined;
      const next = !row ? null : row.repair_of ?? ((row.trigger === 'resume' || row.trigger === 'yield') ? row.parent_job_id : null);
      if (!next) return current;
      current = next;
    }
  };
  const paid = (route: string) => adapter(route)?.capabilities.billing === 'paid';
  const seen = new Set<string>(), out: Array<{ root: string; cost: number | null; jobs: number }> = [];
  for (const row of accepted) {
    const root = rootOf(row.id);
    if (seen.has(root)) continue;
    seen.add(root);
    // Superseded by a named replacement: that assignment carries this cost.
    if (replacedBy.get(root)) continue;
    const queue = [root], members = new Map<string, Json>();
    let complete = true;
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i];
      if (members.has(id)) continue;
      if (members.size >= MAX_LINEAGE) { complete = false; break; }
      const member = self.get(id) as Json | undefined;
      if (!member) continue;
      members.set(id, member);
      for (const child of children.all(id, id) as Json[]) if (!members.has(child.id)) queue.push(child.id);
      for (const p of predecessors.all(id) as Json[]) queue.push(rootOf(p.job_id));
    }
    let total: number | null = complete ? 0 : null;
    for (const member of members.values()) {
      if (total === null) break;
      const value = knownCost(member.cost_usd);
      if (value !== null) total += value;
      else if (paid(member.route)) total = null;
    }
    out.push({ root, cost: total, jobs: members.size });
  }
  return out;
}

/** Moves logs/service.log to logs/service.log.1 (replacing it) when it is over `maxBytes`. Run while the service is stopped. */
export function rotateLog(home: string, maxBytes = 10 * 1024 * 1024): string {
  const log = path.join(home, 'logs', 'service.log');
  if (!fs.existsSync(log) || fs.statSync(log).size <= maxBytes) return `no rotation needed for ${log}`;
  fs.rmSync(log + '.1', { force: true });
  fs.renameSync(log, log + '.1');
  return `rotated ${log} to service.log.1`;
}

/**
 * cli.ts stats: the consult value rate (verdicts by trigger and route: ok, chg, blk, none, unfinished) and each
 * route's reliability (outcomes, average run time). Read-only.
 */
export function consultStats(store: Store): string[] {
  const consults = store.db.prepare(`SELECT COALESCE(trigger, 'direct') trigger, route, sum(consult_verdict='ok') ok, sum(consult_verdict='chg') chg,
    sum(consult_verdict='blk') blk, sum(consult_verdict='none') none, sum(status IN ('failed','needs_review','cancelled')) unfinished
    FROM jobs WHERE trigger IS NOT NULL OR consult_verdict IS NOT NULL GROUP BY 1, route ORDER BY 1, route`).all() as Json[];
  const routes = store.db.prepare(`SELECT route, sum(status='completed') completed, sum(status='failed') failed, sum(status='needs_review') needs_review,
    sum(status='cancelled') cancelled, CAST(avg(latency_ms) AS INTEGER) latency FROM jobs GROUP BY route ORDER BY route`).all() as Json[];
  const n = (v: unknown) => Number(v ?? 0);
  return ['consults (trigger, route):', ...(consults.length ? consults.map(c => `  ${String(c.trigger).padEnd(12)} ${String(c.route).padEnd(12)} ok ${n(c.ok)}  chg ${n(c.chg)}  blk ${n(c.blk)}  none ${n(c.none)}  unfinished ${n(c.unfinished)}`) : ['  none yet']),
    'routes:', ...(routes.length ? routes.map(r => `  ${String(r.route).padEnd(12)} completed ${n(r.completed)}  failed ${n(r.failed)}  needs_review ${n(r.needs_review)}  cancelled ${n(r.cancelled)}  avg ${r.latency === null ? '-' : (n(r.latency) / 1000).toFixed(1) + 's'}`) : ['  no jobs yet'])];
}
