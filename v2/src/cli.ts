import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Store, type Actor } from './store.ts';
import { SCHEMA_VERSION } from './schema.ts';
import { defaultHome } from './paths.ts';
import { startServer, DEFAULT_PORT } from './server.ts';
import { importV1 } from './import-v1.ts';
import { profileOf } from './tools.ts';
import { Prober, usageIdentity } from './prober.ts';
import { allAdapters } from './adapters/registry.ts';
import { resolveOpenAIHelperRoot } from './adapters/openai-models.ts';
import { backupDatabase, restoreDatabase, consultStats, outcomeStats, dropJob, jobDiff, pruneHome, rotateLog } from './ops.ts';
import { readConnection, call, RemoteError, isRetryableTransportError } from './client.ts';
import { errLine } from './air/format.ts';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { applyPatchBlocks, buildRepairContext, parsePatchBlocks } from './patch.ts';
import { roomReport, startViewer, statusReport, VIEWER_PORT } from './viewer.ts';
import { formatCompactDuration, formatPaceSummary } from './allowance.ts';
import { codexExpiringResets } from './adapters/codex-limits.ts';
import { applyInstall, describeAction, hubStatus, loadManifest, planInstall, toolsAirLines } from './tool-hub.ts';
import { assertNotSyncedPath, createBackupBundle, verifyBackupBundle, restoreBackupBundle, type BundleCredential } from './backup-bundle.ts';
import { embeddingsStatus, loadEmbeddingsConfig, syncMemoryVectors } from './embeddings.ts';
import { graphStatus, queryGraph, refreshGraph, resolveGraphDir } from './graph.ts';
import { auditHosts, formatHostAudit, type AuditApp } from './host-audit.ts';
import { assertRegularTokenFile, connectionPath, ensureTokenHome, writePrivateJson } from './token-home.ts';

/**
 * node v2/src/cli.ts <command> [--home DIR] [--port N]
 *   init                     create the home and an operator connection
 *   add-client --name NAME [--profile air] [--family F] [--adapter A]   create a participant and its connection file
 *   rotate-client (--name ID [--profile air|full] [--url URL] | --all)   replace actor tokens and rewrite their connection files
 *   import-v1 --from DIR     copy v1 continuity records into an empty home (v1 is read-only)
 *   serve                    run the service in the foreground (rotate the log first with rotate-log)
 *   stop                     ask the running service to stop gracefully (exit 0: stopped or not running; 3: not supported)
 *   status                   service health, platforms and cooldowns, jobs needing review, inboxes, worktrees
 *   backup [--keep 10]       copy the database to backups\ with SQLite's backup API (safe while running)
 *   bundle-create --out FILE [--helper-root DIR] (--standard-archive | --recovery-key FILE | --passphrase-stdin)   create an encrypted backup and its sidecars
 *   bundle-verify --source FILE (--standard-archive | --recovery-key FILE | --passphrase-stdin)   verify an encrypted backup
 *   bundle-restore --source FILE [--helper-root DIR | --skip-helper] (--standard-archive | --recovery-key FILE | --passphrase-stdin)   restore an encrypted backup into a new home
 *   probe [--clear-cooldown [ROUTE]]   run every platform probe now (no prompt is sent); optionally end cooldowns
 *   stats                    consult value rate (verdicts by trigger and route) and each route's reliability
 *   job-diff JOB             a job's changes (its worktree, or its saved diff)
 *   restore --source BACKUP.sqlite --home NEW_HOME   copy a backup into a new empty home; running jobs become needs_review,
 *                            queued jobs are cancelled (nothing is re-run); then check it with status before swapping homes
 *   job-drop JOB [--force]   remove a finished edit job's worktree and branch (dirty or unmerged needs --force)
 *   job-settle JOB --as failed|cancelled --reason TEXT   close a needs_review job after checking it with its platform
 *                            (never re-runs it; settle a paid job's reservation in the central helper first)
 *   prune [--older-than-days 14] [--keep-releases 5] [--dry-run] [--force]   remove old job folders, releases, worktrees
 *   rotate-log [--max-mb 10] move logs\service.log to service.log.1 when it is too big (service stopped)
 *   project-create --name N [--root DIR] [--objective TEXT]   create a project (apps on the AIR profile cannot)
 *   archive-project P [--unarchive]   hide a project from discovery (or show it again)
 *   set-actor ACTOR [--family F] [--adapter A]   tag an app's actor with its model family and headless adapter
 *   air-decode --project P [--since N] [--limit N]   print the activity feed in plain English (read-only)
 *   limits [--route R --max N] [--global N] [--clear]   jobs running at once: set or clear operator limits, print the effective table
 *   route-plan --prompt TEXT [--intent I] [--eff E] [--mode M] [--route R] [--cost C] [--ctx a,b] [--tools S] [--max-usd N] [--max-tok N] [--actor A]   dry-run route/model/effort selection and cost comparison (read-only)
 *   model-access --route R --model M (--entitled | --unavailable [--reason TEXT])   record whether a model is entitled on this route
 *   tools                    the shared tool manifest (<home>\tools.json) and each app's state (read-only)
 *   tools-install --app codex|claude|antigravity [--only a,b] [--apply]   set the manifest's skills and MCP servers up for
 *                            one app; a dry run unless --apply (backups in backups\tools-install-<time>)
 *   embed-status             report opt-in loopback embeddings config and indexed vector count (read-only)
 *   embed-sync [--project P] index/prune project memory vectors via loopback embeddings (<home>\embeddings.json)
 *   graph-status [--project P]   check Graphify index availability and build receipt (read-only)
 *   graph-query --project P (--query TEXT | TEXT)   query staleness-verified Graphify code relationships (read-only)
 *   graph-refresh --project P [--force]   run local Graphify update (GRAPHIFY_BACKEND=none) for the project
 *   audit-hosts [--app codex|claude|antigravity] [--json]   read-only host MCP, connection, tool-hub, and secret-marker audit
 *   room-report G [--out FILE]   write a self-contained, read-only HTML snapshot of a room (default <home>\reports\G.html)
 *   status-report [--out FILE]   write a self-contained, read-only HTML snapshot of status and quota (default <home>\reports\status.html)
 *   view [--port 4728]       serve read-only room and status pages on 127.0.0.1 (prints a link with a per-start key; Ctrl+C stops)
 *   air-sync, air-tx, air-get, air-result, air-wait, air-wait-until, route-hints   AIR-T clients over the loopback API (--connection FILE; see below)
 */
const args = process.argv.slice(2), command = args[0];
const option = (name: string, fallback?: string) => { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : fallback; };
const flag = (name: string) => args.includes('--' + name);
/** Options that take a value; anything else starting with -- is a flag. */
const VALUED = new Set(['--home', '--port', '--keep', '--older-than-days', '--keep-releases', '--max-mb', '--family', '--adapter', '--name', '--profile', '--from', '--project', '--since', '--limit',
  '--connection', '--root', '--packet-file', '--packet', '--op', '--handles', '--grep', '--max-chars', '--out', '--out-dir', '--wait', '--exclude-family', '--mode', '--advance', '--objective',
  '--max-minutes', '--route', '--max', '--global', '--cwd', '--verify', '--app', '--only',
  '--prompt', '--intent', '--eff', '--cost', '--ctx', '--tools', '--max-usd', '--max-tok', '--model', '--reason', '--actor',
  '--source', '--helper-root', '--url', '--staging-parent', '--recovery-key', '--query']);
/** The first argument after the command that is neither an option nor an option's value. */
const positional = () => args.slice(1).find((a, i, all) => !a.startsWith('--') && !VALUED.has(all[i - 1]));

/**
 * AIR-T clients for tools without MCP (hook scripts, other platforms). They call the running service over the loopback
 * API with a connection file (--connection, or AGENT_COMMONS_CONNECTION) and print the AIR-T reply; errors print as
 * an @air1 err line with exit code 1. No --home is needed.
 *   air-sync [--root DIR | --project P] [--advance false] [--spec]
 *   air-tx [--project P] (--packet-file F | --packet TEXT | stdin) [--op OPERATION_ID]
 *   air-get --handles H[,H] [--grep TEXT] [--max-chars N]
 *   air-result --handles H[,H] [--out FILE | --out-dir DIR] [--artifacts] [--force]
 *     Exact UTF-8 results; one handle to stdout by default. --artifacts requires --out-dir.
 *   air-apply --handles J[,J] [--project P] [--cwd DIR] [--dry-run] [--allow-partial] [--verify CMD] [--no-pack-repair]
 *     Applies patch blocks and records evidence in the selected project. Exit 2 means rejected blocks or failed verification.
 *   air-wait --handles J[,J] [--wait SECONDS] [--any]
 *   air-wait-until --handles J[,J] [--max-minutes 9] [--any]
 *     Loops air_wait in one process (one shell call, no model turns) until the jobs finish or the deadline (1-55 minutes)
 *     passes; prints the last reply and `@air1 waited s=N done=n/total`. Exit 0 done, 2 still running (run it again), 1 error.
 *   route-hints [--exclude-family F] [--mode advice|edit]
 */
const CLIENT_METHODS: Record<string, string> = { 'air-sync': 'air_sync', 'air-tx': 'air_tx', 'air-get': 'air_get', 'air-wait': 'air_wait', 'route-hints': 'route_hints' };
if (command === 'air-apply') {
  const invalid = (message: string, code = 'INVALID_INPUT'): never => {
    throw Object.assign(new Error(message), { code });
  };
  const write = (line: string) => new Promise<void>(resolve => { process.stdout.write(line + '\n', () => resolve()); });
  try {
    const file = option('connection') ?? process.env.AGENT_COMMONS_CONNECTION
      ?? invalid('air-apply needs --connection FILE (or AGENT_COMMONS_CONNECTION)');
    const handles = (option('handles') ?? '').split(',').map(handle => handle.trim());
    if (handles.length > 10 || handles.some(handle => !/^j[1-9]\d*$/.test(handle))
      || new Set(handles).size !== handles.length) invalid('handles must list 1-10 distinct job handles');
    const directory = option('cwd'), verify = option('verify');
    if (flag('cwd') && !directory) invalid('--cwd needs a directory');
    if (flag('verify') && !verify?.trim()) invalid('--verify needs a command');

    const cwd = path.resolve(directory ?? process.cwd());
    const defaultDir = defaultHome(fileURLToPath(import.meta.url));
    const deny = [...(defaultDir ? [defaultDir] : []), path.resolve(file), fs.realpathSync(file)];
    const home = option('home');
    if (home) deny.push(path.resolve(home));
    const connection = readConnection(file);
    const jobs = handles.join(',');
    const project = option('project') ?? (connection.projectIds?.length === 1 && !connection.selectProject ? connection.projectIds[0] : undefined);
    const projectInput = project ? { project_id: project } : {};
    const reply = await call(connection, 'air_get', { handles: jobs, raw: true });
    const raw = reply.raw as { handle?: string; kind?: string; status?: string; complete?: boolean; content?: unknown }[] | undefined;
    if (!Array.isArray(raw) || raw.length !== handles.length)
      invalid('Could not retrieve every job result', 'RESULT_UNAVAILABLE');
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    const perJob = handles.map(handle => {
      const entry = raw?.find(item => item?.handle === handle);
      if (entry?.kind !== 'job' || entry.status !== 'completed' || entry.complete !== true || typeof entry.content !== 'string')
        return invalid(`${handle}: full job output is unavailable`, 'RESULT_UNAVAILABLE');
      const blocks = parsePatchBlocks(entry.content);
      if (!blocks.length) invalid(`${handle}: no patch blocks found`, 'PATCH_INVALID');
      return { handle, blocks, resultHash: hash(entry.content), accepted: 0, edits: 0, deletes: 0, files: new Set<string>() };
    });
    const sources = new Map(perJob.flatMap(job => job.blocks.map(block => [block, job] as const)));
    const dryRun = flag('dry-run'), allowPartial = flag('allow-partial');
    const result = applyPatchBlocks(cwd, perJob.flatMap(job => job.blocks), { dryRun, allowPartial, deny,
      onAccepted: (block, target, changed) => {
        const job = sources.get(block)!;
        job.accepted++;
        if (!changed) return;
        job.files.add(target);
        if (block.kind === 'edit') job.edits++;
        if (block.kind === 'delete') job.deletes++;
      },
    });
    let revision: string | null = null;
    if (perJob.some(job => job.accepted)) {
      const git = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd, encoding: 'utf8', timeout: 2000, windowsHide: true });
      const head = git.stdout?.trim() ?? '';
      if (git.status === 0 && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head)) revision = head;
    }
    let verification: 'ok' | 'fail' | undefined, exitCode: number | null = null;
    let failure: { stdout?: string; stderr?: string; status?: number | null } | undefined;
    if (verify && !dryRun && (!result.rejected.length || (allowPartial && result.applied > 0))) {
      // Only the CLI caller supplies this command. Job output is never executed as a shell command.
      const run = spawnSync(verify, { cwd, shell: true, encoding: 'utf8', timeout: 120_000,
        stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024, windowsHide: true });
      verification = !run.error && run.status === 0 ? 'ok' : 'fail';
      exitCode = run.status;
      if (verification === 'fail') failure = {
        status: run.status, stdout: run.stdout ?? '',
        stderr: [run.stderr, (run.error as NodeJS.ErrnoException | undefined)?.code, run.signal].filter(Boolean).join('\n'),
      };
    }

    const observations: string[] = [];
    for (const job of perJob) {
      if (!job.accepted) continue;
      const detail = { result_sha256: job.resultHash, revision, partial: result.rejected.length > 0 };
      const add = (kind: string, evidence: object) =>
        observations.push(`#${observations.length} out j=${job.handle} v=${kind} ${JSON.stringify(JSON.stringify({ ...detail, ...evidence }))}`);
      if (job.files.size) add('applied', { edits: job.edits, files: job.files.size, deletes: job.deletes });
      if (verification) add(verification === 'ok' ? 'verify_pass' : 'verify_fail', {
        exit_code: exitCode, command_sha256: hash(verify!), environment: `${process.platform}-${process.arch}-${process.version}`,
      });
    }
    if (observations.length) {
      try {
        await call(connection, 'air_tx', { operation_id: randomUUID(), ...projectInput, packet: ['@air1', ...observations].join('\n') });
      } catch {
        // A telemetry failure cannot undo local writes or change the verifier's exit status.
        console.error('air-apply: could not record outcome evidence; check the connection and --project');
      }
    }

    const unsuccessful = result.rejected.length > 0 || verification === 'fail';
    let repair: string | undefined;
    if (unsuccessful && !dryRun && !flag('no-pack-repair')) {
      try {
        const content = buildRepairContext(cwd, result.rejected, failure, deny);
        const operation_id = randomUUID();
        const saved = await call(connection, 'air_tx', {
          operation_id, ...projectInput,
          packet: `@air1\n#0 art name="patch-repair-${operation_id}.txt" ${JSON.stringify(content)}`,
        });
        repair = /^#0=(a\d+)\s*$/m.exec(saved.air)?.[1];
        if (!repair) throw new Error('No repair artifact handle returned');
      } catch {
        console.error('air-apply: could not upload repair context');
      }
    }
    await write(`@air1 apply jobs=${jobs} applied=${result.applied} rejected=${result.rejected.length} files=${result.files}`
      + (dryRun ? ' dry_run=1' : '') + (verification ? ` verify=${verification}` : '') + (repair ? ` repair_ctx=${repair}` : ''));
    process.exitCode = unsuccessful ? 2 : 0;
  } catch (error) {
    const code = error instanceof RemoteError ? error.code : (error as { code?: string }).code ?? 'PATCH_ERROR';
    await write(errLine(code, (error as Error).message));
    process.exitCode = 1;
  }
  process.exit();
}
if (command === 'air-result') {
  type RawEntry = {
    handle: string; id: string; kind: 'job' | 'artifact'; content: string; complete: boolean; reason?: string;
    artifacts?: { handle: string; name: string; kind: string; bytes: number }[];
  };
  const resultError = (message: string, code = 'INVALID_INPUT'): never => {
    throw Object.assign(new Error(message), { code });
  };
  try {
    const file = option('connection') ?? process.env.AGENT_COMMONS_CONNECTION;
    if (!file) resultError('air-result needs --connection FILE (or AGENT_COMMONS_CONNECTION)');
    const connection = readConnection(file!);
    const handles = (option('handles') ?? '').split(',').map(handle => handle.trim()).filter(Boolean);
    if (!handles.length || handles.length > 10) resultError('handles must list 1-10 jobs or artifacts');
    const out = option('out'), outDir = option('out-dir');
    if (flag('out') && !out) resultError('--out needs a file');
    if (flag('out-dir') && !outDir) resultError('--out-dir needs a directory');
    if (out && outDir) resultError('Choose --out or --out-dir, not both');
    if (!outDir && handles.length !== 1) resultError('--out or stdout requires exactly one handle');
    if (flag('artifacts') && !outDir) resultError('--artifacts requires --out-dir');

    const fetchRaw = async (refs: string[]): Promise<RawEntry[]> => {
      const reply = await call(connection, 'air_get', { handles: refs.join(','), raw: true });
      const entries = reply.raw as RawEntry[] | undefined;
      if (!Array.isArray(entries) || entries.length !== refs.length)
        resultError(`Could not resolve every job or artifact: ${reply.air}`, 'RESULT_UNAVAILABLE');
      for (const entry of entries!) {
        if (!entry.complete || typeof entry.content !== 'string')
          resultError(`${entry.handle}: ${entry.reason ?? 'Full content is unavailable'}`, 'RESULT_UNAVAILABLE');
      }
      return entries!;
    };
    const entries = await fetchRaw(handles);
    if (!out && !outDir) {
      // Await the write before process.exit(), including when stdout is a pipe.
      await new Promise<void>((resolve, reject) => {
        process.stdout.write(entries[0].content, error => error ? reject(error) : resolve());
      });
    } else {
      const dir = outDir ? path.resolve(outDir) : undefined;
      const files = entries.map(entry => ({
        file: out ? path.resolve(out) : path.join(dir!, `${entry.handle}.txt`),
        content: entry.content,
      }));
      if (flag('artifacts')) {
        const artifacts = new Map<string, { handle: string; name: string }>();
        for (const entry of entries) {
          if (entry.kind === 'job') {
            for (const artifact of entry.artifacts ?? []) artifacts.set(artifact.handle, artifact);
          }
        }
        const pending = [...artifacts.values()];
        for (let i = 0; i < pending.length; i += 10) {
          const batch = pending.slice(i, i + 10);
          const contents = await fetchRaw(batch.map(artifact => artifact.handle));
          for (let j = 0; j < batch.length; j++) {
            const artifact = batch[j], target = path.resolve(dir!, artifact.name);
            const relative = path.relative(dir!, target);
            if (path.isAbsolute(artifact.name) || !relative || relative === '..'
              || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
              resultError(`Unsafe artifact name: ${artifact.name}`);
            const content = contents.find(entry => entry.handle === artifact.handle)?.content;
            if (content === undefined) resultError(`Artifact ${artifact.handle} was not returned`, 'RESULT_UNAVAILABLE');
            files.push({ file: target, content: content! });
          }
        }
      }

      const exists = (target: string): boolean => {
        try { fs.lstatSync(target); return true; }
        catch (error) {
          if ((error as { code?: string }).code === 'ENOENT') return false;
          throw error;
        }
      };
      const destinations = new Set<string>();
      // Check the entire plan before writing any files.
      for (const item of files) {
        const key = process.platform === 'win32' ? item.file.toLowerCase() : item.file;
        if (destinations.has(key)) resultError(`Duplicate output path: ${item.file}`, 'FILE_EXISTS');
        destinations.add(key);
        if (!flag('force') && exists(item.file)) resultError(`File exists: ${item.file}; use --force`, 'FILE_EXISTS');
      }
      for (const item of files) {
        fs.mkdirSync(path.dirname(item.file), { recursive: true });
        const temporary = `${item.file}.tmp-${randomUUID()}`;
        try {
          fs.writeFileSync(temporary, item.content, { encoding: 'utf8', flag: 'wx' });
          if (flag('force')) fs.renameSync(temporary, item.file);
          else {
            // An atomic no-clobber publish: rename would silently replace a concurrent writer.
            try { fs.linkSync(temporary, item.file); }
            catch (error) {
              if ((error as { code?: string }).code === 'EEXIST')
                resultError(`File exists: ${item.file}; use --force`, 'FILE_EXISTS');
              throw error;
            }
          }
        } finally {
          if (exists(temporary)) fs.unlinkSync(temporary);
        }
        console.log(`${JSON.stringify(item.file)} ${Buffer.byteLength(item.content, 'utf8')} bytes`);
      }
    }
  } catch (error) {
    const code = error instanceof RemoteError ? error.code : (error as { code?: string }).code ?? 'RESULT_ERROR';
    console.log(errLine(code, (error as Error).message));
    process.exitCode = 1;
  }
  process.exit();
}
import { waitDisplayOptions } from './air/wait-options.ts';

const airWaitFlags = () => waitDisplayOptions(flag('brief'), option('max-chars') ?? (flag('max-chars') ? null : undefined));

if (command === 'air-wait-until') {
  // Turn-free waiting: loop air_wait (read-only; it never touches jobs, so retrying is safe) until the jobs finish or the
  // deadline passes. AC_WAIT_SLICE_SECONDS and AC_WAIT_DEADLINE_SECONDS are hidden test-only overrides.
  const started = Date.now();
  const invalid = (message: string): never => { throw Object.assign(new Error(message), { code: 'INVALID_INPUT' }); };
  const write = (text: string) => new Promise<void>(resolve => { process.stdout.write(text + '\n', () => resolve()); });
  const envSeconds = (name: string): number | undefined => {
    const value = Number(process.env[name] ?? '');
    return process.env[name] && Number.isFinite(value) && value > 0 ? value : undefined;
  };
  try {
    const handles = (option('handles') ?? '').split(',').map(handle => handle.trim()).filter(Boolean);
    if (!handles.length || handles.length > 10) invalid('handles must list 1-10 jobs');
    if (flag('max-minutes') && option('max-minutes') === undefined) invalid('--max-minutes needs a number');
    const minutes = Number(option('max-minutes', '9'));
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 55) invalid('max-minutes must be 1-55');
    const file = option('connection') ?? process.env.AGENT_COMMONS_CONNECTION;
    if (!file) invalid('air-wait-until needs --connection FILE (or AGENT_COMMONS_CONNECTION)');
    const connection = readConnection(file!);
    const display = airWaitFlags();
    const slice = Math.min(50, Math.max(1, Math.floor(envSeconds('AC_WAIT_SLICE_SECONDS') ?? 50)));
    const deadline = started + (envSeconds('AC_WAIT_DEADLINE_SECONDS') ?? minutes * 60) * 1000;
    let reply = '', header = '', failures = 0;
    for (;;) {
      let remaining = deadline - Date.now();
      if (remaining <= 0) break;
      // air_wait takes whole seconds. Do not round up and send a request beyond the budget.
      if (remaining < 1000) {
        await new Promise(resolve => setTimeout(resolve, remaining));
        break;
      }
      const wait = Math.min(slice, Math.floor(remaining / 1000));
      let retry = false;
      try {
        const next = (await call(connection, 'air_wait', {
          handles: handles.join(','), wait_seconds: wait, ...(flag('any') ? { any: true } : {}), ...display,
        }, remaining))?.air;
        if (typeof next !== 'string') throw new Error('Invalid air_wait reply');
        const nextHeader = next.split('\n', 1)[0];
        // A closing reply is explicitly retryable, but is not a usable job-status reply.
        if (/\bclosing=1\b/.test(nextHeader)) retry = true;
        else {
          if (!nextHeader.startsWith('@air1 ') || !/\bn=\d+ done=\d+\b/.test(nextHeader))
            throw new Error('Invalid air_wait reply');
          reply = next;
          header = nextHeader;
          failures = 0;
        }
      } catch (error) {
        if (!isRetryableTransportError(error)) throw error;
        retry = true;
      }
      if (retry) {
        if (++failures > 3) break;
        remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await new Promise(resolve => setTimeout(resolve, Math.min(2000, remaining)));
        continue;
      }
      if (!/\btimeout=1\b/.test(header)) break;
    }
    if (!reply) throw Object.assign(new Error('No usable air_wait reply before waiting ended'), { code: 'SERVICE_UNAVAILABLE' });
    const counts = /\bn=(\d+) done=(\d+)/.exec(header);
    const total = counts ? Number(counts[1]) : handles.length, done = counts ? Number(counts[2]) : 0;
    const finished = !/\btimeout=1\b/.test(header);
    await write(`${reply}\n@air1 waited s=${Math.round((Date.now() - started) / 1000)} done=${done}/${total}`);
    process.exitCode = finished ? 0 : 2;
  } catch (error) {
    const raw = (error as { code?: unknown }).code;
    const code = error instanceof RemoteError ? error.code : typeof raw === 'string' ? raw : 'SERVICE_UNAVAILABLE';
    await write(errLine(code, (error as Error).message));
    process.exitCode = 1;
  }
  process.exit();
}
if (CLIENT_METHODS[command]) {
  const file = option('connection') ?? process.env.AGENT_COMMONS_CONNECTION;
  if (!file) { console.error(`${command} needs --connection FILE (or AGENT_COMMONS_CONNECTION)`); process.exit(2); }
  const connection = readConnection(file);
  const project = option('project') ?? (connection.projectIds?.length === 1 && !connection.selectProject ? connection.projectIds[0] : undefined);
  const input: Record<string, unknown> = {};
  if (command === 'air-sync') {
    if (project) input.project_id = project; else input.root = path.resolve(option('root') ?? process.cwd());
    if (option('advance') === 'false' || flag('advance=false')) input.advance_cursor = false;
    if (flag('spec')) input.include_spec = true;
  } else if (command === 'air-tx') {
    const packetFile = option('packet-file');
    input.packet = packetFile ? fs.readFileSync(packetFile, 'utf8') : option('packet') ?? (process.stdin.isTTY ? '' : fs.readFileSync(0, 'utf8'));
    if (project) input.project_id = project;
    input.operation_id = option('op') ?? randomUUID();
  } else if (command === 'air-get' || command === 'air-wait') {
    input.handles = option('handles');
    if (command === 'air-get') { if (option('grep')) input.grep = option('grep'); if (option('max-chars')) input.max_chars = Number(option('max-chars')); }
    else { input.wait_seconds = Number(option('wait', '30')); if (flag('any')) input.any = true; }
  } else {
    if (option('exclude-family')) input.exclude_family = option('exclude-family');
    if (option('mode')) input.mode = option('mode');
  }
  try {
    if (command === 'air-wait') Object.assign(input, airWaitFlags());
    console.log((await call(connection, CLIENT_METHODS[command], input)).air);
  } catch (error) {
    const code = error instanceof RemoteError ? error.code
      : (error as { code?: unknown }).code === 'INVALID_INPUT' ? 'INVALID_INPUT' : 'SERVICE_UNAVAILABLE';
    console.log(errLine(code, (error as Error).message));
    process.exitCode = 1;
  }
  process.exit();
}

const chosenHome = option('home', defaultHome(fileURLToPath(import.meta.url)));
if (!chosenHome) { console.error('Pass --home DIR (or set AGENT_COMMONS_HOME) when running from a source checkout.'); process.exit(2); }
const home = path.resolve(chosenHome);
const port = Number(option('port', String(DEFAULT_PORT)));
const url = `http://127.0.0.1:${port}`;
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
const withStore = async (work: (store: Store) => unknown) => { const store = new Store(home); try { await work(store); } finally { store.close(); } };
function inventoryFreshness(store: Store, route: string): string {
  const discovery = store.modelDiscoveryState(route);
  const latest = (store.db.prepare('SELECT max(last_seen_at) AS last_seen FROM route_models WHERE route=?')
    .get(route) as { last_seen: string | null }).last_seen;
  const state = !latest ? 'unavailable' : discovery?.error || Date.now() - Date.parse(latest) > 26 * 60 * 60 * 1000
    ? 'stale' : 'current';
  return 'Model inventory ' + state + '; last successful observation ' + (latest ?? 'none') +
    (discovery?.error ? '; ' + discovery.error : '');
}
const need = (value: string | undefined, what: string) => { if (!value) { console.error(`${command} needs ${what}`); process.exit(2); } return value; };
const bundleCredential = (): BundleCredential => {
  const keySelected = flag('recovery-key');
  const standard = flag('standard-archive');
  if ([keySelected, flag('passphrase-stdin'), standard].filter(Boolean).length !== 1) {
    throw new Error('Select exactly one of --standard-archive, --recovery-key FILE and --passphrase-stdin');
  }
  if (standard) return { standardArchive: true };
  if (!keySelected) return { passphrase: fs.readFileSync(0, 'utf8').replace(/\r?\n$/, '') };
  const keyFile = path.resolve(need(option('recovery-key'), '--recovery-key FILE'));
  assertNotSyncedPath(keyFile, 'recovery key');
  const stat = fs.lstatSync(keyFile);
  if (!stat.isFile() || stat.size !== 32) throw new Error('Recovery key must be a regular 32-byte file');
  const key = fs.readFileSync(keyFile);
  if (key.length === 32) return { recoveryKey: key };
  key.fill(0);
  throw new Error('Recovery key changed while reading');
};
const withBundleCredential = async <T>(work: (credential: BundleCredential) => T | Promise<T>): Promise<T> => {
  const credential = bundleCredential();
  try { return await work(credential); }
  finally { credential.recoveryKey?.fill(0); }
};
const bundleHelperRoot = () => flag('helper-root') ? need(option('helper-root'), '--helper-root DIR') : undefined;
const bundleStagingParent = () => flag('staging-parent') ? need(option('staging-parent'), '--staging-parent DIR') : undefined;
/** The running-limits table: each route's adapter default, operator override, hard ceiling and effective limit; then the global limit. */
const printLimits = (store: Store) => {
  const limits = store.effectiveLimits(allAdapters().map(a => a.capabilities.id));
  const row = (cells: Array<string | number | null>) => console.log(cells.map((cell, i) => i === 0 ? String(cell).padEnd(12) : String(cell ?? '-').padStart(9)).join(' '));
  row(['route', 'default', 'override', 'ceiling', 'effective']);
  for (const r of limits.rows) row([r.route, r.default, r.override, r.ceiling, r.effective]);
  row(['global', limits.globalDefault, limits.globalOverride, limits.globalCeiling, limits.global]);
};

function writeConnection(name: string, value: object): string {
  const file = connectionPath(home, name + '.json');
  writePrivateJson(file, value, false);
  return file;
}

switch (command) {
  case 'init':
    ensureTokenHome(home, true);
    await withStore(store => print(store.transaction(() => {
      if (store.db.prepare("SELECT 1 FROM actors WHERE role='operator'").get()) return { status: 'exists', home };
      const { actor, token } = store.createActor('operator', 'operator', 'local-operator');
      return { status: 'initialized', home, connection: writeConnection('operator', { url, token, actorId: actor.id, projectIds: [], selectProject: true }) };
    })));
    break;
  case 'add-client': {
    const name = need(option('name'), '--name');
    const profile = profileOf(option('profile'));
    ensureTokenHome(home, true);
    await withStore(store => print(store.transaction(() => {
      const { actor, token } = store.createActor(name, 'participant', name);
      if (option('family') || option('adapter')) store.setActorTags(actor.id, option('family') ?? null, option('adapter') ?? null);
      return { status: 'created', actor: actor.id, connection: writeConnection(name, { url, token, actorId: actor.id, projectIds: [], selectProject: true,
        ...(profile === 'air' ? { toolProfile: 'air' } : {}) }) };
    })));
    break;
  }
  case 'rotate-client': {
    const all = flag('all'), name = option('name'), profile = option('profile');
    if (all ? flag('name') || flag('profile') : !name)
      need(undefined, '--name ID [--profile air|full] [--url URL] or --all [--url URL]');
    if (flag('profile') && profile !== 'air' && profile !== 'full')
      need(undefined, '--profile air|full');
    const connectionUrl = flag('url') ? need(option('url'), '--url URL') : url;
    ensureTokenHome(home, true);

    await withStore(store => {
      const { db } = store;
      const actors = db.prepare('SELECT id FROM actors ORDER BY id').all() as { id: string }[];
      const selected = all ? actors : actors.filter(actor => actor.id === name);
      if (!all && !selected.length) throw new Error(`actor ${name} not found`);

      const filename = (id: string) => id === 'local-operator' ? 'operator.json' : `${id}.json`;
      const fileKey = (id: string) => process.platform === 'win32' ? filename(id).toLowerCase() : filename(id);
      const plan = selected.map(({ id }) => {
        const basename = filename(id);
        const connection = connectionPath(home, basename);
        if (actors.some(other => other.id !== id && fileKey(other.id) === fileKey(id)))
          throw new Error(`actor ${id} shares a connection filename with another actor`);
        let settings: { projectIds?: string[]; selectProject?: boolean } = {};
        if (assertRegularTokenFile(connection)) {
          const content = fs.readFileSync(connection, 'utf8');
          try { settings = JSON.parse(content) ?? {}; }
          catch { throw new Error(`Invalid connection JSON: ${connection}`); }
        }
        return { id, connection, settings };
      });

      const rotated = plan.map(({ id, connection, settings }) => store.transaction(() => {
        const { actor, token } = store.rotateActorToken(id);
        const value = {
          url: connectionUrl, token, actorId: actor.id,
          projectIds: settings.projectIds ?? [], selectProject: settings.selectProject ?? true,
          ...(actor.role === 'participant' && profile !== 'full' ? { toolProfile: 'air' } : {}),
        };
        writePrivateJson(connection, value, true);
        return { actor: actor.id, connection };
      }));
      print(rotated);
    });
    break;
  }
  case 'import-v1': {
    const from = option('from', path.join(os.homedir(), '.agent-commons'))!;
    await withStore(store => print({ status: 'imported', from, home, ...importV1(from, store) }));
    break;
  }
  case 'air-decode': {
    // Read-only: the project activity feed in plain US English (AIR-T is never shown to people).
    const project = need(option('project'), '--project (a handle such as p1, or a project ID)');
    await withStore(store => { for (const line of store.airDecode(project, Number(option('since', '0')), Number(option('limit', '200')))) console.log(line); });
    break;
  }
  case 'pool-evidence': {
    await withStore(store => {
      for (const route of allAdapters().filter(a => a.backfillConsumption)) {
        let recorded = 0;
        if (flag('backfill')) {
          // The adapter reads its own saved output. No helper is started and no job is requeued.
          const jobs = store.db.prepare(`SELECT id FROM jobs
            WHERE route=? AND finished_at IS NOT NULL
              AND status IN ('completed','failed','cancelled','needs_review')
              AND NOT EXISTS (
                SELECT 1 FROM pool_evidence_jobs e WHERE e.route=jobs.route AND e.job_id=jobs.id
              )
            ORDER BY seq`).all(route.capabilities.id) as Array<{ id: string }>;
          for (const job of jobs) {
            const result = route.backfillConsumption!(job, home);
            if (result && store.recordConsumption(route.capabilities.id, result.family, result.rows, job.id)) recorded++;
          }
        }
        const evidence = store.poolEvidence(route.capabilities.id);
        print({ route: route.capabilities.id, recorded_jobs: recorded, pool_evidence: evidence });
        for (const line of route.poolEvidenceStatus?.(evidence, store.consumptionRuns(route.capabilities.id)) ?? []) console.log(line);
      }
    });
    break;
  }
  case 'usage-set': {
    const route = need(option('route'), '--route');
    const pool = need(option('pool'), '--pool');
    const window = need(option('window'), '--window');
    const percent = Number(need(option('percent'), '--percent'));
    const reset = option('resets-at');
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new Error('--percent must be between 0 and 100');
    if (reset && (!reset.includes('T') || !Number.isFinite(Date.parse(reset)))) throw new Error('--resets-at must be an ISO timestamp');
    await withStore(store => {
      store.recordUsage(route, [{ pool, window, remaining_percent: percent,
        resets_at: reset ? new Date(reset).toISOString() : null }], 'operator');
      print({ route, usage_windows: store.usageFor(route) });
    });
    break;
  }
  case 'profile-pin': await withStore(async store => {
    const route = need(option('route'), '--route R');
    const intent = need(option('intent'), '--intent I');
    const eff = need(option('eff'), '--eff E');
    const row = store.pinProfile(route, intent, eff, option('model'), flag('unpin'));
    console.log(`${route} ${intent}/${eff}: ${row.native_model ?? '-'} ${row.native_effort ?? '-'}; ${row.tracks_latest ? 'tracks latest' : 'pinned'}`);
  }); break;
  case 'models': await withStore(async store => {
    const route = option('route');
    const { antigravityInventoryLines } = await import('./adapters/antigravity-inventory.ts');
    const { readPublicInventory, openAIPublicModelLines, publicInventorySummary } = await import('./adapters/openai-public-inventory.ts');
    const { isRestrictedOpenAIModel, defaultOpenAIHelperRoot, openAIModelSummary } = await import('./adapters/openai-models.ts');
    if (flag('refresh')) {
      const prober = new Prober(store, home);
      if (route) await prober.discover(route);
      else await prober.discoverAll();
    }
    const setIndex = process.argv.indexOf('--set-state');
    if (setIndex !== -1) {
      const model = need(process.argv[setIndex + 1], '--set-state MODEL STATE');
      const state = need(process.argv[setIndex + 2], '--set-state MODEL STATE');
      const matches = store.routeModels(route).filter(row => row.model === model);
      if (matches.length !== 1) throw new Error(matches.length
        ? '--route is required when a model occurs on more than one route'
        : 'model is not in the route inventory; use models --refresh first');
      store.setModelState(matches[0].route, model, state);
    }
    const excluded = new Set(readPublicInventory(home).excluded ?? []);
    const rows = store.routeModels(route).filter(row => row.route !== 'openai-api' ||
      (!row.superseded_by && row.state !== 'retired' && !isRestrictedOpenAIModel(row.model) && !excluded.has(row.model)));
    const ag = route === undefined || route === 'antigravity' ? antigravityInventoryLines(home, store.usageFor('antigravity')) : [];
    if (!rows.length) console.log('no models recorded; run models --refresh');
    let previous: string | undefined;
    for (const row of rows) {
      if (previous !== row.route) {
        console.log(row.route + ':');
        console.log('  ' + inventoryFreshness(store, row.route));
        if (row.route === 'antigravity') for (const line of ag) console.log(line);
        previous = row.route;
      }
      if (row.route === 'antigravity' && ag.length > 1) continue;
      const tiers = row.tiers?.map((tier: string) => row.route === 'openai-api' && tier === 'batch' ? 'batch (async; not selectable)' : tier);
      console.log(`  ${row.model} ${row.state}; efforts ${row.efforts.length ? row.efforts.join(', ') : '-'}` +
        `${tiers ? `; tiers ${tiers.join(', ') || '-'}` : ''}; last seen ${row.last_seen_at}; source ${row.source}` +
        `${row.superseded_by ? `; superseded by ${row.superseded_by}` : ''}`);
    }
    if (ag.length && !rows.some(row => row.route === 'antigravity')) {
      console.log('antigravity:');
      for (const line of ag) console.log(line);
    }
    if (route === undefined || route === 'openai-api') {
      const routable = new Set<string>(rows.filter(row => row.route === 'openai-api').map(row => row.model));
      console.log(openAIModelSummary(home));
      for (const line of publicInventorySummary(home)) console.log(line);
      for (const line of openAIPublicModelLines(home, defaultOpenAIHelperRoot(home), routable)) console.log(line);
    }
    for (const warning of store.newerAvailable(route))
      if (!isRestrictedOpenAIModel(warning.old) && !isRestrictedOpenAIModel(warning.new))
        console.log(`NEWER AVAILABLE: ${warning.old} -> ${warning.new} (${warning.state})`);
  }); break;
  case 'route-bin': await withStore(async store => {
    const route = option('route', '') ?? '', file = option('path', '') ?? '', clear = flag('clear');
    const platform = allAdapters().find(a => a.capabilities.id === route && a.capabilities.transport === 'cli' && a.binaries);
    if (!platform) throw new Error('route-bin requires --route for a direct CLI route');
    if ((file && clear) || (flag('path') && (!file || file.startsWith('--'))))
      throw new Error('use --path P or --clear, not both');
    if (file || clear) {
      store.setRouteBin(platform.capabilities, file ? path.resolve(file) : null);
      await new Prober(store, home).probe(route);
    }
    const s = store.platformState(route);
    console.log(`${route}: ${s?.bin_path ? 'pinned to ' + s.bin_path : 'automatic selection'}; selected ${s?.bin_selected_path ?? 'none'}`);
    if (s?.reason) console.log(s.reason);
  }); break;
  case 'cli-update': await withStore(async store => {
    const { cliUpdateCommand } = await import('./cli-update-command.ts');
    const platform = allAdapters().find(a => a.capabilities.id === option('route', ''));
    console.log(await cliUpdateCommand(platform, { on: flag('on'), off: flag('off'), now: flag('now') },
      store, route => new Prober(store, home).updateNow(route)));
  }); break;
  case 'sdk-update': await withStore(async store => {
    const { sdkUpdateCommand } = await import('./sdk-update-command.ts');
    const requested = option('route', '');
    const platforms = allAdapters().filter(a => a.sdk);
    const platform = requested ? platforms.find(a => a.capabilities.id === requested)
      : platforms.length === 1 ? platforms[0] : undefined;
    console.log(await sdkUpdateCommand(platform, { on: flag('on'), off: flag('off'), now: flag('now') },
      store, route => new Prober(store, home).updateSdkNow(route)));
  }); break;
  case 'probe': await withStore(async store => {
    const { cliFreshnessLines, cliUpdateStatusLine } = await import('./adapters/cli-freshness.ts');
    if (flag('clear-cooldown')) { const route = positional(); store.clearCooldown(route); console.log(`cooldown cleared for ${route ?? 'all routes'}`); }
    await new Prober(store, home).probeAll();
    for (const s of store.platformStates()) {
      console.log(`${s.adapter_id.padEnd(12)} ${s.probe_state.padEnd(11)} ${(s.cli_version ?? '-').padEnd(24)} ${s.cooldown_until ? `cooldown until ${s.cooldown_until} ` : ''}${s.reason ?? ''}`);
      const platform = allAdapters().find(a => a.capabilities.id === s.adapter_id);
      for (const line of cliFreshnessLines(s, platform?.upstreamTrack)) console.log(line);
      if (platform?.update) console.log(cliUpdateStatusLine(s, platform.upstreamTrack));
    }
  }); break;
  case 'backup': {
    // Never through Store: the backup must not migrate the schema while an older service still runs.
    const { file, removed } = await backupDatabase(home, Number(option('keep', '10')));
    console.log(`backed up ${file} (integrity ok)${removed.length ? `; removed ${removed.length} older backup(s)` : ''}`);
    break;
  }
  case 'helper-root': print(resolveOpenAIHelperRoot(home)); break;
  case 'bundle-create': {
    const outFile = need(option('out'), '--out FILE');
    const helperRoot = bundleHelperRoot();
    const { file, sha256File, metaFile, sha256, bytes, manifest } = await withBundleCredential(credential => createBackupBundle({
      home, outFile, helperRoot, stagingParent: bundleStagingParent(), ...credential,
    }));
    print({ file, sha256File, metaFile, sha256, bytes, schema: manifest.ac_schema,
      artifacts: manifest.artifact_count, hasHelperLedger: manifest.has_helper_ledger });
    break;
  }
  case 'bundle-verify': {
    const sourceFile = need(option('source'), '--source FILE');
    const { file, sha256, manifest } = await withBundleCredential(credential => verifyBackupBundle({ sourceFile, stagingParent: bundleStagingParent(), ...credential }));
    print({ file, sha256, schema: manifest.ac_schema, artifacts: manifest.artifact_count,
      hasHelperLedger: manifest.has_helper_ledger });
    break;
  }
  case 'bundle-restore': {
    const sourceFile = need(option('source'), '--source FILE');
    const helperRoot = bundleHelperRoot();
    const skipHelper = flag('skip-helper');
    if (helperRoot && skipHelper) throw new Error('Use --helper-root or --skip-helper, not both');
    const { file, schema, running, queued, artifacts, helperRestored } = await withBundleCredential(credential => restoreBackupBundle({
      sourceFile, home, helperRoot, skipHelper, stagingParent: bundleStagingParent(), schemaVersion: SCHEMA_VERSION, ...credential,
    }));
    print({ home, file, schema, running, queued, artifacts, helperRestored });
    break;
  }
  case 'restore': {
    // Never through Store until the copy is made safe: Store would start migrating a home that is still being written.
    const r = await restoreDatabase(path.resolve(need(option('source'), '--source')), home, SCHEMA_VERSION);
    console.log(`restored ${r.file} (schema ${r.schema}, integrity ok); ${r.running} running job(s) set to needs_review, ${r.queued} queued job(s) cancelled`);
    await withStore(store => console.log(`opened with this release (schema ${SCHEMA_VERSION}); projects: ${(store.db.prepare('SELECT count(*) n FROM projects').get() as any).n}`));
    break;
  }
  case 'stop': {
    const runtimeFile = path.join(home, 'runtime.json');
    if (!fs.existsSync(runtimeFile)) { console.log('not running (no runtime.json)'); break; }
    ensureTokenHome(home);
    assertRegularTokenFile(runtimeFile);
    const runtime = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
    if (!runtime.shutdown_token) { console.log('the running service has no graceful stop (older release)'); process.exit(3); }
    try {
      const response = await fetch(runtime.url + '/api/v1/shutdown', { method: 'POST', headers: { authorization: 'Bearer ' + runtime.shutdown_token }, signal: AbortSignal.timeout(5000) });
      if (response.status === 404) { console.log('the running service has no graceful stop (older release)'); process.exit(3); }
      if (!response.ok) { console.error(`stop refused: HTTP ${response.status}`); process.exit(1); }
      console.log(`stopping (pid ${runtime.pid})`);
    } catch { console.log('not running (no answer)'); }
    break;
  }
  case 'limits': {
    // The running service reads limits on every claim pass, so a change here applies without a restart.
    let refused: string | undefined;
    await withStore(store => {
      try {
        const route = option('route'), max = option('max'), globalMax = option('global');
        const changes: Parameters<Store['setLimits']>[0] = {};
        if (flag('route') && !route) throw new Error('--route needs a route');
        if (flag('clear')) {
          if (flag('max') || globalMax !== undefined) throw new Error('--clear takes no number');
          if (route) changes.route = { route, max: null };
          if (flag('global')) changes.global = null;
          if (!route && !flag('global')) changes.clear = true;
        } else {
          if (flag('route') || flag('max')) {
            if (!route || max === undefined) throw new Error('--route R and --max N go together');
            changes.route = { route, max: Number(max) };
          }
          if (flag('global')) {
            if (globalMax === undefined) throw new Error('--global needs a number');
            changes.global = Number(globalMax);
          }
        }
        store.setLimits(changes);
      } catch (error) { refused = (error as Error).message; return; }
      printLimits(store);
    });
    if (refused) { console.error(`limits refused: ${refused}`); process.exit(2); }
    break;
  }
  case 'status': await withStore(async store => {
    const { antigravityInventorySummary } = await import('./adapters/antigravity-inventory.ts');
    const { publicInventorySummary } = await import('./adapters/openai-public-inventory.ts');
    const { cliFreshnessLines, cliUpdateStatusLine } = await import('./adapters/cli-freshness.ts');
    const { sdkStatusLine } = await import('./adapters/sdk-freshness.ts');
    const counts = store.serviceCounts();
    let live = 'not running';
    try { const runtime = JSON.parse(fs.readFileSync(path.join(home, 'runtime.json'), 'utf8')); live = `running at ${runtime.url} (pid ${runtime.pid}, since ${runtime.started_at})`; } catch { /* stopped */ }
    console.log(`service: ${live}; schema ${counts.schema_version}; jobs running ${counts.running_jobs}, queued ${counts.queued_jobs}, needs review ${counts.needs_review_jobs}`);
    const perRoute = store.db.prepare("SELECT route, sum(status='running') running, sum(status='queued') queued FROM jobs GROUP BY route").all() as Array<Record<string, any>>;
    console.log('platforms:');
    for (const s of store.platformStates()) {
      const q = perRoute.find(r => r.route === s.adapter_id);
      console.log(`  ${s.adapter_id.padEnd(12)} ${s.probe_state.padEnd(11)} ${(s.cli_version ?? '-').padEnd(24)} running ${q?.running ?? 0}, queued ${q?.queued ?? 0}${s.cooldown_until ? `; cooldown until ${s.cooldown_until}` : ''}`);
      const platform = allAdapters().find(a => a.capabilities.id === s.adapter_id);
      console.log('    ' + inventoryFreshness(store, s.adapter_id));
      if (s.adapter_id === 'antigravity') console.log('    ' + antigravityInventorySummary(home));
      if (s.adapter_id === 'openai-api') for (const line of publicInventorySummary(home)) console.log('    ' + line);
      for (const line of cliFreshnessLines(s, platform?.upstreamTrack)) console.log(`    ${line}`);
      if (s.usage_blocked_identity === usageIdentity(s)) console.log('    quota polling suspended: local command reported model work');
      if (s.usage_last_error) {
        try {
          const err = JSON.parse(s.usage_last_error);
          if (err?.kind) console.log(`    last usage read failed: ${err.kind}${err.method ? ` (${err.method})` : ''}${err.at ? ` at ${err.at}` : ''}`);
        } catch { /* ignore malformed diagnostic */ }
      }
      if (s.usage_meta) {
        try {
          const meta = JSON.parse(s.usage_meta);
          if (meta?.resetCredits) {
            const report = codexExpiringResets(meta.resetCredits);
            if (report.remainingCount > 0) {
              const soon = report.expiring.length
                ? `; ${report.expiring[0].count} expiring in ${formatCompactDuration(report.expiring[0].remainingMs)} (${report.expiring[0].expiresAt})`
                : report.nextExpiry ? `; next expires ${report.nextExpiry}` : '';
              console.log(`    banked resets: ${report.remainingCount} available${soon}`);
            }
          }
        } catch { /* ignore malformed metadata */ }
      }
      if (platform?.update) console.log(`    ${cliUpdateStatusLine(s, platform.upstreamTrack)}`);
      if (platform?.sdk) console.log(`    ${sdkStatusLine(s)}`);
      if (platform?.modelSourceStatus) {
        console.log(`    ${platform.modelSourceStatus(s.probe_state === 'verified' ? s.bin_version ?? null : null)}`);
      }
    }
    const newerCount = store.newerAvailable().length;
    console.log(`model freshness: ${newerCount} newer-version warning${newerCount === 1 ? '' : 's'}`);
    const windows = store.usageWindows();
    if (windows.length) {
      console.log('usage windows:');
      for (const w of windows) {
        const pace = formatPaceSummary(w);
        console.log(`  ${w.route} / ${w.pool} / ${w.window}: ${w.stale || w.remaining_percent === null ? 'unknown' : w.remaining_percent + '%'}` +
          `${w.resets_at ? `, ${w.route === 'openai-api' ? 'expires' : 'scheduled reset'} ${w.resets_at}` : ''}`
          + `${pace ? `, ${pace}` : ''}`
          + `${w.early_reset_observed_at ? `, early replenishment seen ${w.early_reset_observed_at} (previous schedule ${w.early_reset_scheduled_at})` : ''}`
          + `${w.closed ? ', closed' : ''} (${w.source}, seen ${w.observed_at})`);
      }
    }
    for (const route of allAdapters().filter(a => a.poolEvidenceStatus)) {
      const lines = route.poolEvidenceStatus!(store.poolEvidence(route.capabilities.id), store.consumptionRuns(route.capabilities.id));
      if (lines.length) {
        console.log(`${route.capabilities.id} pool evidence:`);
        for (const line of lines) console.log(`  ${line}`);
      }
    }
    const review = store.db.prepare("SELECT seq, route, error FROM jobs WHERE status='needs_review' ORDER BY seq").all() as Array<Record<string, any>>;
    if (review.length) { console.log('needs review:'); for (const j of review) console.log(`  j${j.seq} ${j.route}: ${String(j.error ?? '').slice(0, 120)}`); }
    const inbox = store.inboxCounts();
    console.log(`unanswered messages: ${inbox.length ? inbox.map(r => `${r.actor} ${r.n}`).join(', ') : 'none'}`);
    const worktrees = path.join(home, 'worktrees');
    console.log(`job worktrees: ${fs.existsSync(worktrees) ? fs.readdirSync(worktrees).length : 0}`);
    const seen = store.db.prepare('SELECT actor_id, last_seen_at FROM actor_presence ORDER BY last_seen_at DESC').all() as Array<Record<string, any>>;
    const ago = (at: string) => { const m = Math.round((Date.now() - Date.parse(at)) / 60000); return m < 2 ? 'online' : m < 120 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };
    console.log(`apps last seen: ${seen.length ? seen.map(s => `${s.actor_id} ${ago(s.last_seen_at)}`).join(', ') : 'none yet'}`);
    const limits = store.effectiveLimits(allAdapters().map(a => a.capabilities.id));
    console.log(`running limits: ${limits.rows.map(r => `${r.route} ${r.effective}${r.override === null ? '' : '*'}`).join(', ')}; global ${limits.global}${limits.globalOverride === null ? '' : '*'} (* set by the operator; change with limits)`);
  }); break;
  case 'job-diff': await withStore(store => console.log(jobDiff(store, need(positional(), 'a job (j5 or its ID)')))); break;
  case 'job-settle': await withStore(store => {
    const operator = store.db.prepare("SELECT id FROM actors WHERE role='operator' LIMIT 1").get() as any;
    if (!operator) { console.error('job-settle needs an initialized home'); process.exit(2); }
    const as = option('as'), reason = option('reason');
    if (as !== 'failed' && as !== 'cancelled') { console.error('job-settle needs --as failed|cancelled'); process.exit(2); }
    if (!reason?.trim()) { console.error('job-settle needs --reason "what was checked"'); process.exit(2); }
    const job = store.settleJob(need(positional(), 'a job (j5 or its ID)'), as, reason, operator.id);
    console.log(`settled ${job.id} as ${job.status}`);
  }); break;
  case 'job-drop': await withStore(store => { for (const line of dropJob(store, need(positional(), 'a job (j5 or its ID)'), flag('force'))) console.log(line); }); break;
  case 'prune': await withStore(store => {
    for (const line of pruneHome(store, home, { olderThanDays: Number(option('older-than-days', '14')), keepReleases: Number(option('keep-releases', '5')),
      dryRun: flag('dry-run'), force: flag('force') })) console.log(line);
  }); break;
  case 'rotate-log': console.log(rotateLog(home, Number(option('max-mb', '10')) * 1024 * 1024)); break;
  case 'stats': await withStore(store => {
    for (const line of [...consultStats(store), ...outcomeStats(store)]) console.log(line);
  }); break;
  case 'route-plan': await withStore(store => {
    const prompt = need(option('prompt'), '--prompt "..."');
    const actorId = option('actor') ?? 'local-operator';
    const actorRow = store.db.prepare('SELECT id, name, role FROM actors WHERE id=?').get(actorId) as any;
    const actor = actorRow ?? { id: actorId, name: actorId, role: 'participant' as const };
    const ctx = option('ctx') ? option('ctx')!.split(',').map(x => x.trim()).filter(Boolean) : undefined;
    const maxTok = option('max-tok') ? Number(option('max-tok')) : undefined;
    const plan = store.planRoute(actor, {
      prompt,
      ...(option('route') ? { route: option('route') } : {}),
      ...(option('intent') ? { intent: option('intent') } : {}),
      ...(option('eff') ? { eff: option('eff') } : {}),
      ...(option('mode') ? { mode: option('mode') } : {}),
      ...(option('check') ? { check: option('check') } : {}),
      ...(option('cost') ? { cost: option('cost') } : {}),
      ...(option('tools') ? { tools: option('tools') } : {}),
      ...(option('model') ? { model: option('model') } : {}),
      ...(option('max-usd') ? { max_cost_usd: option('max-usd') } : {}),
      ...(maxTok !== undefined && Number.isFinite(maxTok) ? { max_output_tokens: maxTok } : {}),
      ...(ctx?.length ? { context_refs: ctx } : {}),
    });
    print(plan);
  }); break;
  case 'model-access': await withStore(store => {
    const route = need(option('route'), '--route R');
    const model = need(option('model'), '--model M');
    const entitled = flag('entitled'), unavailable = flag('unavailable');
    if (entitled === unavailable) { console.error('model-access needs exactly one of --entitled or --unavailable'); process.exit(2); }
    store.setModelEntitlement(route, model, entitled, option('reason') ?? 'operator');
    print(store.routeModels(route).find(m => m.model === model) ?? { route, model, entitled });
  }); break;
  case 'project-create': await withStore(store => {
    const operator = store.db.prepare("SELECT id, name, role FROM actors WHERE role='operator' LIMIT 1").get() as any;
    if (!operator) { console.error('project-create needs an initialized home (run init first)'); process.exit(2); }
    const root = option('root');
    print(store.call({ id: operator.id, name: operator.name, role: 'operator' }, 'project_create', { name: need(option('name'), '--name'),
      ...(root ? { root: path.resolve(root) } : {}), ...(option('objective') ? { objective: option('objective') } : {}), operation_id: randomUUID() }).project);
  }); break;
  case 'project-approve-root': await withStore(store => {
    const operator = store.db.prepare("SELECT id, name, role FROM actors WHERE role='operator' LIMIT 1").get() as Actor | undefined;
    if (!operator) throw new Error('project-approve-root needs an initialized home (run init first)');
    print(store.approveProjectRoot(operator, need(option('project'), '--project ID'), need(option('root'), '--root DIR')));
  }); break;
  case 'archive-project': await withStore(store => print(store.setArchived(need(positional(), 'a project (p3 or its ID)'), !flag('unarchive')))); break;
  case 'set-actor': await withStore(store => {
    const actor = need(positional(), 'an actor ID');
    store.setActorTags(actor, option('family') ?? null, option('adapter') ?? null);
    print(store.db.prepare('SELECT id, family, adapter_id FROM actors WHERE id=?').get(actor));
  }); break;
  case 'tools': {
    const manifest = loadManifest(home) ?? (console.error(`no tools.json in ${home}`), process.exit(1));
    console.log(toolsAirLines(hubStatus(manifest, { userHome: os.homedir() }), positional() ?? null, 16000).join('\n'));
    break;
  }
  case 'tools-install': {
    const app = need(option('app'), '--app codex|claude|antigravity');
    const manifest = loadManifest(home) ?? (console.error(`no tools.json in ${home}`), process.exit(1));
    const only = option('only') ? new Set(option('only')!.split(',').map(x => x.trim()).filter(Boolean)) : undefined;
    const env = { userHome: os.homedir() };
    const actions = planInstall(manifest, app, env, only);
    if (!actions.length) { console.log(`${app}: nothing to do; every manifest item for this app is already set up`); break; }
    if (!flag('apply')) {
      console.log(`${app}: dry run, ${actions.length} change(s); nothing written. Rerun with --apply to make them.`);
      for (const a of actions) console.log(describeAction(a));
      break;
    }
    const backupDir = path.join(home, 'backups', `tools-install-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    for (const line of applyInstall(actions, env, backupDir)) console.log(line);
    console.log(`${app}: done. Restart the app (or start a new session) so it loads the new tools.`);
    break;
  }
  case 'embed-status': await withStore(store => {
    print(embeddingsStatus(store.db, home));
  }); break;
  case 'embed-sync': await withStore(async store => {
    let cfg;
    try { cfg = loadEmbeddingsConfig(home); } catch (error) {
      console.error((error as Error).message);
      process.exit(2);
    }
    if (!cfg) {
      console.error(`embeddings are disabled (create ${path.join(home, 'embeddings.json')} with {"enabled":true,"model":"..."} to enable)`);
      process.exit(2);
    }
    const projectRef = option('project');
    const projectId = projectRef ? store.resolveProject(projectRef).id : undefined;
    print(await syncMemoryVectors(store.db, cfg, { projectId }));
  }); break;
  case 'graph-status': await withStore(store => {
    const projectRef = option('project');
    if (projectRef) {
      const p = store.resolveProject(projectRef);
      if (!p.root) { console.error(`project ${projectRef} has no root`); process.exit(2); }
      print({ project: store.handleOf('p', p.id) ?? p.id, name: p.name, root: p.root, ...graphStatus(p.root, resolveGraphDir(home, p.root)) });
      return;
    }
    const rows = (store.db.prepare('SELECT id, name, root FROM projects WHERE archived = 0 AND root IS NOT NULL ORDER BY updated_at DESC, id').all() as Array<{ id: string; name: string; root: string }>)
      .map(p => ({ project: store.handleOf('p', p.id) ?? p.id, name: p.name, root: p.root, ...graphStatus(p.root, resolveGraphDir(home, p.root)) }));
    print(rows);
  }); break;
  case 'graph-query': await withStore(store => {
    const projectRef = need(option('project'), '--project P');
    const p = store.resolveProject(projectRef);
    if (!p.root) { console.error(`project ${projectRef} has no root`); process.exit(2); }
    const qText = need(option('query') ?? positional(), '--query TEXT');
    print(queryGraph(p.root, resolveGraphDir(home, p.root), qText, [home]));
  }); break;
  case 'graph-refresh': await withStore(store => {
    const projectRef = need(option('project'), '--project P');
    const p = store.resolveProject(projectRef);
    if (!p.root) { console.error(`project ${projectRef} has no root`); process.exit(2); }
    print(refreshGraph(p.root, resolveGraphDir(home, p.root), { force: flag('force') }));
  }); break;
  case 'audit-hosts': {
    const appOpt = option('app');
    let apps: AuditApp[] | undefined;
    if (appOpt) {
      const valid: AuditApp[] = ['codex', 'claude', 'antigravity'];
      const parts = appOpt.split(',').map(s => s.trim()).filter(Boolean);
      if (!parts.length || parts.some(p => !valid.includes(p as AuditApp))) {
        console.error('--app must list codex, claude, or antigravity');
        process.exit(2);
      }
      apps = parts as AuditApp[];
    }
    const report = auditHosts({ home, userHome: os.homedir(), apps });
    if (flag('json')) print(report);
    else console.log(formatHostAudit(report));
    if (!report.clean) process.exit(2);
    break;
  }
  case 'room-report': {
    const ref = need(positional(), 'a room (g7 or its ID)');
    const out = path.resolve(option('out', path.join(home, 'reports', ref + '.html'))!);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, roomReport(home, ref), 'utf8');
    console.log(out);
    break;
  }
  case 'status-report': {
    const out = path.resolve(option('out', path.join(home, 'reports', 'status.html'))!);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, statusReport(home), 'utf8');
    console.log(out);
    break;
  }
  case 'view': {
    const viewer = await startViewer(home, Number(option('port', String(VIEWER_PORT))));
    console.log(JSON.stringify({ event: 'viewing', url: viewer.url, home, read_only: true }));
    const stop = () => { void viewer.close().then(() => process.exit(0)); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    break;
  }
  case 'serve': {
    const running = await startServer(home, port, {}, { probe: true, onShutdown: () => process.exit(0) });
    console.log(JSON.stringify({ event: 'serving', url: running.url, home }));
    const stop = () => { void running.close().then(() => process.exit(0)); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    break;
  }
  default:
    console.error('usage: cli.ts init|add-client|rotate-client|import-v1|serve|stop|status|stats|backup|restore|helper-root|bundle-create|bundle-verify|bundle-restore|probe|tools|tools-install|embed-status|embed-sync|graph-status|graph-query|graph-refresh|audit-hosts|job-diff|job-drop|job-settle|prune|rotate-log|project-create|archive-project|set-actor|air-decode|room-report|view [--home DIR] [--port N]');
    process.exit(2);
}
