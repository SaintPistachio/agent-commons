import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { migrate } from './schema.ts';
import { parsePacket, one, type OutcomeNode } from './air/parser.ts';
import { AirParseError, STATUS_OF_CODE, type AirItem, type AirNode, type HandleKind } from './air/types.ts';
import { acceptanceHistory, appendOutcome, applyEvidenceDetail, CALLER_OUTCOMES, recordConsultOutcome, type CallerOutcome } from './outcomes.ts';
import { entityLine, txReply, syncHeader, kv, kl, q, type Names } from './air/format.ts';
import { AIR_PRIMER, AIR_WORKER_PRIMER, AIR_PATCH_PRIMER } from './air/primer.ts';
import { applyPatchBlocks, buildRepairContext, parsePatchBlocks, summarizePatchBlocks } from './patch.ts';
import { planCorrection, repairPrompt, repairTrigger } from './repair.ts';
import { describe } from './air/decompile.ts';
import { CommonsError, fail } from './errors.ts';
import { text, optText, MAX_TEXT } from './validate.ts';
import { adapter, adapterIds, allAdapters, DEFAULT_ROUTE } from './adapters/registry.ts';
import { compareVersionParts, parseModelVersion, supersededBy } from './adapters/inventory.ts';
import { compareCostEfficiency, modelPricing } from './adapters/model-pricing.ts';
import { INTENTS, EFFORTS, type AdapterCapabilities, type ProbeResult, type UsageObservation, type UsageWindow } from './adapters/types.ts';
import { git, RESULT_LIMIT } from './adapters/shared.ts';
import { resolvePatchCheck } from './patch-check.ts';
import { buildContext, realDirectory, redactSecrets, resolveContextRoot, same } from './context.ts';
import { activeDecisionsSql, indexMemoryRow, recallProjectMemory } from './recall.ts';
import { inferSelection } from './selection.ts';
import { cooldownUntil } from './cooldown.ts';
import { checkWorkerBlock } from './air/worker.ts';
import { allowanceLabel, allowanceRank, classifyAllowance, type Allowance } from './allowance.ts';
import { healthLine } from './health.ts';
import { busySlots, findToolset, hubStatus, isBuiltinToolset, jobToolset, loadManifest, toolsAirLines, toolsetAirLine, toolsSummaryLine, type HubEnv } from './tool-hub.ts';
import os from 'node:os';

export { CommonsError } from './errors.ts';
export type Json = Record<string, any>;
export interface Actor { id: string; name: string; role: 'operator' | 'participant' }
interface OutcomeCandidate {
  id: string; billing: string; priority: number; lowQuota: number;
  running: number; limit: number; queued: number; success: number; order: number;
  /** Allowance class (expiring, neutral, scarce); absent means neutral. */
  allowance?: Allowance;
}

export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const TASK_STATUSES = ['open', 'in_progress', 'blocked', 'awaiting_review', 'done', 'cancelled'];
const ACTIVE_TASK = "('open','in_progress','blocked','awaiting_review')";
const MAX_ARTIFACT = 4 * 1024 * 1024;
function list(value: unknown, name: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 200) fail('INVALID_INPUT', 400, `${name} must be a list of up to 200 items`);
  return (value as unknown[]).map((item, i) => text(item, `${name}[${i}]`, 4096));
}
function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail('INVALID_INPUT', 400, 'version must be a positive integer');
  return value as number;
}
const json = (value: unknown) => JSON.stringify(value);
const parseLists = (row: Json | undefined, fields: string[]) => {
  if (!row) return row;
  const out: Json = { ...row }; delete out.seq;
  for (const field of fields) if (typeof out[field] === 'string') out[field] = JSON.parse(out[field]);
  return out;
};
const taskRow = (row: Json | undefined) => parseLists(row, ['acceptance']);
const decisionRow = (row: Json | undefined) => parseLists(row, ['evidence']);
const checkpointRow = (row: Json | undefined) => parseLists(row, ['checks', 'open_questions', 'artifacts']);
const messageRow = (row: Json | undefined) => parseLists(row, ['recipients', 'evidence']);

/** Mutations: replaying an operation_id returns the stored result; different input is a conflict. */
const MUTATIONS = new Set(['project_create', 'project_checkpoint', 'task_create', 'task_claim', 'task_update', 'task_release',
  'decision_record', 'team_ask', 'team_reply', 'team_ack', 'discussion_open', 'discussion_post', 'discussion_close', 'artifact_submit',
  'job_submit', 'job_cancel', 'air_tx', 'art_put', 'room_step']);

/** Entity kinds: table, short-handle letter, and which mutations produce an event for them. */
const ENTITY: Record<string, { table: string; letter: HandleKind }> = {
  project: { table: 'projects', letter: 'p' }, task: { table: 'tasks', letter: 't' }, decision: { table: 'decisions', letter: 'd' },
  checkpoint: { table: 'checkpoints', letter: 'c' }, discussion: { table: 'discussions', letter: 'g' }, message: { table: 'messages', letter: 'm' },
  artifact: { table: 'artifacts', letter: 'a' }, job: { table: 'jobs', letter: 'j' },
};
const KIND_OF_LETTER = Object.fromEntries(Object.entries(ENTITY).map(([kind, e]) => [e.letter, kind])) as Record<HandleKind, string>;
/** method -> [entity kind, key of the entity in the result]. team_ack produces no event. */
const EVENT_OF: Record<string, [string, string]> = {
  project_create: ['project', 'project'], project_checkpoint: ['checkpoint', 'checkpoint'], task_create: ['task', 'task'], task_claim: ['task', 'task'],
  task_update: ['task', 'task'], task_release: ['task', 'task'], decision_record: ['decision', 'decision'], team_ask: ['message', 'message'],
  team_reply: ['message', 'message'], discussion_open: ['discussion', 'discussion'], discussion_post: ['message', 'message'],
  discussion_close: ['discussion', 'discussion'], room_step: ['discussion', 'discussion'], artifact_submit: ['artifact', 'artifact'], art_put: ['artifact', 'artifact'], job_submit: ['job', 'job'], job_cancel: ['job', 'job'],
};
const HANDLE = /^([ptdcgmaj])(\d{1,15})$/;
function confidence(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !(value > 0 && value < 1)) fail('INVALID_INPUT', 400, 'confidence must be a number between 0 and 1');
  return value as number;
}
interface AirResult { kind: string; id: string; handle: string; reply?: string; text?: string; review?: string; hint?: string; wake?: string }

export class Store {
  readonly db: DatabaseSync;
  readonly home: string;
  /** Where the apps' own configuration lives, for the shared tool hub (tests replace it). */
  toolsEnv: HubEnv = { userHome: os.homedir() };
  constructor(home: string) {
    this.home = home;
    fs.mkdirSync(path.join(home, 'artifacts'), { recursive: true });
    this.db = new DatabaseSync(path.join(home, 'commons.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    migrate(this.db);
    this.seedProfiles();
  }
  close(): void { this.db.close(); }

  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw error; }
  }

  // ---- actors -------------------------------------------------------------
  createActor(name: string, role: Actor['role'], id: string = randomUUID()): { actor: Actor; token: string } {
    const token = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
    this.db.prepare('INSERT INTO actors(id,name,role,token_sha256,created_at) VALUES(?,?,?,?,?)').run(id, text(name, 'name', 256), role, sha256(token), now());
    return { actor: { id, name, role }, token };
  }
  rotateActorToken(actorId: string): { actor: Actor; token: string } {
    const row = this.db.prepare('SELECT id,name,role FROM actors WHERE id=?').get(text(actorId, 'actorId', 256)) as Json | undefined;
    if (!row) return fail('NOT_FOUND', 404, `actor ${actorId} not found`);
    const token = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
    this.db.prepare('UPDATE actors SET token_sha256=? WHERE id=?').run(sha256(token), row.id);
    return { actor: { id: row.id, name: row.name, role: row.role }, token };
  }
  authenticate(token: string | undefined): Actor {
    if (!token) fail('UNAUTHENTICATED', 401);
    const row = this.db.prepare('SELECT id,name,role FROM actors WHERE token_sha256=?').get(sha256(token!)) as Json | undefined;
    if (!row) fail('UNAUTHENTICATED', 401);
    return row as Actor;
  }

  // ---- dispatch -----------------------------------------------------------
  call(actor: Actor, method: string, input: Json = {}): Json {
    const handler = (this as any)['op_' + method];
    if (typeof handler !== 'function') fail('UNKNOWN_METHOD', 404);
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_INPUT');
    if (!MUTATIONS.has(method)) return handler.call(this, actor, input);
    const operationId = text(input.operation_id, 'operation_id', 256);
    const inputSha = sha256(json(input));
    return this.transaction(() => {
      const prior = this.db.prepare('SELECT input_sha256,result FROM operations WHERE actor_id=? AND method=? AND id=?').get(actor.id, method, operationId) as Json | undefined;
      if (prior) {
        if (prior.input_sha256 !== inputSha) fail('IDEMPOTENCY_CONFLICT', 409, 'operation_id was already used with different input');
        const stored = JSON.parse(prior.result);
        return { ...stored, ...(method === 'air_tx' ? { air: txReply(stored, true) } : {}), replayed: true };
      }
      const result = this.apply(actor, method, input);
      this.db.prepare('INSERT INTO operations(actor_id,method,id,input_sha256,result,created_at) VALUES(?,?,?,?,?,?)').run(actor.id, method, operationId, inputSha, json(result), now());
      return result;
    });
  }

  /** Runs a mutation handler and records its event in the project activity feed (JSON tools and air_tx alike). */
  private apply(actor: Actor, method: string, input: Json): Json {
    const result = (this as any)['op_' + method].call(this, actor, input);
    const event = EVENT_OF[method];
    // Storing an artifact that already exists changes nothing, so it adds no event.
    if (event && result?.[event[1]]?.id && !result.dedup) {
      this.emit(event[0], method, result[event[1]].id, actor.id);
      if (method === 'art_put') {
        const projectId = result.artifact.project_id;
        const cursor = this.cursor(actor, projectId);
        if (cursor !== undefined && this.foreignUnseenCount(actor, projectId, cursor) === 0)
          this.saveCursor(actor, projectId, this.maxSeq(projectId));
      }
    }
    return result;
  }
  /** Appends one event row; assigns the short handle first for new projects and artifacts. */
  private emit(kind: string, action: string, id: string, actorId: string): void {
    const { table } = ENTITY[kind];
    if ((kind === 'project' || kind === 'artifact') && action !== 'job_status') this.assignShortId(ENTITY[kind].letter, id);
    const projection = kind === 'artifact' ? '*, rowid AS memory_seq' : '*';
    const row = this.db.prepare(`SELECT ${projection} FROM ${table} WHERE id=?`).get(id) as Json | undefined;
    if (!row) return;
    const projectId = kind === 'project' ? row.id : row.project_id, taskId = kind === 'task' ? row.id : row.task_id ?? null;
    const handle = this.handleOf(ENTITY[kind].letter, id) ?? id;
    this.db.prepare('INSERT INTO events(project_id,task_id,kind,action,entity_id,handle,actor_id,air_line,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(projectId, taskId, kind, action, id, handle, actorId, entityLine(kind, row, this.names), now());
    indexMemoryRow(this.db, kind, row, handle);
    // Wake air_wait callers after the surrounding transaction has committed.
    if (kind === 'job') setImmediate(() => this.jobEvents.emit('job', id));
  }

  /** Job state changes, for air_wait. 'close' wakes every waiter when the service stops. */
  readonly jobEvents = new EventEmitter().setMaxListeners(0);
  /** Ends every pending air_wait now (the service is stopping); each answers with the state it sees. */
  wakeWaiters(): void { this.jobEvents.emit('close'); }

  /**
   * air_wait: blocks until every listed job (or, with any, the first) reaches a finished state, the wait runs out,
   * or the service stops. Never fails because of time: the reply says timeout=1 or closing=1. The HTTP server calls
   * this directly because it is asynchronous; it changes nothing.
   */
  async airWait(actor: Actor, input: Json, signal?: AbortSignal): Promise<Json> {
    this.heartbeat(actor, null);
    const items = text(input.handles, 'handles', 4096).split(',').map(item => item.trim()).filter(Boolean);
    if (!items.length || items.length > 10) fail('INVALID_INPUT', 400, 'handles must list 1-10 jobs');
    const seconds = input.wait_seconds ?? 30;
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 50) fail('INVALID_INPUT', 400, 'wait_seconds must be 1-50');
    const limit = input.max_chars ?? 16000;
    if (!Number.isInteger(limit) || limit < 20 || limit > 200000) fail('INVALID_INPUT', 400, 'max_chars must be 20-200000');
    if (input.brief !== undefined && typeof input.brief !== 'boolean') fail('INVALID_INPUT', 400, 'brief must be a boolean');
    // A task handle stands for every job of that task (for parallel reviews); each job then counts on its own.
    const entries = items.flatMap<{ item: string; id?: string; err?: string }>(item => {
      try { return this.waitTarget(item).map(id => ({ item: this.handleOf('j', id) ?? id, id })); }
      catch (error) { if (error instanceof CommonsError) return [{ item, err: error.code }]; throw error; }
    });
    if (entries.length > 10) fail('INVALID_INPUT', 400, 'air_wait takes at most 10 jobs');
    // A job that yielded (need) is finished only when its chain is: the wait follows options.next to the last job.
    const finished = () => entries.filter(e => e.err || FINISHED_JOB.includes((this.db.prepare('SELECT status FROM jobs WHERE id=?').get(this.chainTail(e.id!)) as Json).status)).length;
    const deadline = Date.now() + seconds * 1000;
    let closing = false, done = finished();
    const satisfied = () => input.any === true ? done > 0 : done === entries.length;
    // The caller hanging up (signal) ends the wait at once and removes its listeners.
    while (!satisfied() && !closing && !signal?.aborted && Date.now() < deadline) {
      await new Promise<void>(resolve => {
        const end = () => { clearTimeout(timer); this.jobEvents.off('job', onJob); this.jobEvents.off('close', onClose); signal?.removeEventListener('abort', end); resolve(); };
        const onJob = () => end();  // any job change: recheck (chains add jobs the wait did not name)
        const onClose = () => { closing = true; end(); };
        const timer = setTimeout(end, Math.max(0, deadline - Date.now()));
        this.jobEvents.on('job', onJob); this.jobEvents.on('close', onClose); signal?.addEventListener('abort', end);
      });
      if (signal?.aborted) return { air: '@air1 wait aborted=1' };
      done = finished();
    }
    const header = `@air1 wait n=${entries.length} done=${done}${!satisfied() && !closing ? ' timeout=1' : ''}${closing ? ' closing=1' : ''}`;
    const lines = entries.map(e => {
      if (e.err) return `! ${e.item} err=${e.err}`;
      const id = this.chainTail(e.id!), handle = this.handleOf('j', id)!;
      return input.brief === true ? this.briefWaitLine(actor, id, handle, limit) : this.airItem(handle, limit, null)[0];
    });
    // Answer-quality learning needs explicit feedback: remind the submitter once its completed jobs have none.
    const unrated = entries.filter(e => !e.err).map(e => this.chainTail(e.id!)).filter(id => {
      const row = this.db.prepare('SELECT status, created_by FROM jobs WHERE id=?').get(id) as Json;
      return row.status === 'completed' && row.created_by === actor.id
        && !this.db.prepare("SELECT 1 FROM job_outcomes WHERE job_id=? AND kind IN ('accepted','rejected','redone')").get(id);
    }).map(id => this.handleOf('j', id) ?? id);
    if (unrated.length) lines.push(`hint=out: after using ${unrated.join(',')}, record "#0 out j=<job> v=accepted|rejected \"why\"" with air_tx`);
    return { air: [header, ...lines].join('\n') };
  }
  private briefWaitLine(actor: Actor, id: string, handle: string, limit: number): string {
    const cap = Math.min(limit, 240);
    const job = this.jobRecord(id)!;
    const options = job.options ?? {};
    let result = typeof job.result === 'string' ? job.result : '';
    if (typeof options.output_artifact === 'string') {
      try {
        const content = this.op_artifact_read(actor, { artifact_id: options.output_artifact }).content;
        if (typeof content === 'string') result = content;
      } catch (error) {
        // A missing artifact must not prevent reporting a job's status or its stored result.
        if (!(error instanceof CommonsError) || error.code !== 'ARTIFACT_NOT_FOUND') throw error;
      }
    }
    // Keep the normal J fields, but replace the result field. Match quoted values as units so text
    // like ` res=...` inside a different field is never mistaken for the result field.
    const base = this.airItem(handle, cap, null)[0].replace(
      / res=(?:"(?:\\.|[^"\\])*"|[^\s"]*)|"(?:\\.|[^"\\])*"/g,
      part => part.startsWith(' res=') ? '' : part,
    );
    return base + this.jobOutputs(options, { result, cap });
  }
  /** A job handle (j5) or job ID, or a task handle (t4) standing for that task's jobs, for air_wait. */
  private waitTarget(item: string): string[] {
    const handle = HANDLE.exec(item);
    if (handle?.[1] === 't') {
      const task = this.db.prepare('SELECT id FROM tasks WHERE id=?').get(this.resolveId('t', item)) as Json | undefined ?? fail('NOT_FOUND');
      const jobs = (this.db.prepare('SELECT id FROM jobs WHERE task_id=? ORDER BY seq').all(task.id) as Json[]).map(j => j.id as string);
      return jobs.length ? jobs : fail('NO_JOBS');
    }
    if (handle && handle[1] !== 'j') fail('NOT_A_JOB');
    if (!handle && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item)) fail('BAD_HANDLE');
    const row = this.db.prepare('SELECT id FROM jobs WHERE id=?').get(handle ? this.resolveId('j', item) : item) as Json | undefined;
    return [row?.id ?? fail('NOT_FOUND')];
  }
  /** Gives a project or artifact its p<n>/a<n> number; does nothing if it already has one. */
  private assignShortId(letter: HandleKind, id: string): void {
    this.db.prepare(`INSERT OR IGNORE INTO short_ids(kind,num,id) SELECT ?, COALESCE(MAX(num),0)+1, ? FROM short_ids WHERE kind=?`).run(letter, id, letter);
  }
  /** The short handle for an entity: t<seq> etc., or p<n>/a<n> from short_ids. */
  handleOf(letter: HandleKind, id: string | null | undefined): string | null {
    if (!id) return null;
    if (letter === 'p' || letter === 'a') {
      const row = this.db.prepare('SELECT num FROM short_ids WHERE kind=? AND id=?').get(letter, id) as Json | undefined;
      return row ? letter + row.num : null;
    }
    const row = this.db.prepare(`SELECT seq FROM ${ENTITY[KIND_OF_LETTER[letter]].table} WHERE id=?`).get(id) as Json | undefined;
    return row ? letter + row.seq : null;
  }
  /**
   * A short handle of the given kind becomes the entity's ID; anything else is returned unchanged.
   * An existing entity whose ID is literally "t1" (possible for imported v1 records) always wins over the handle.
   */
  private resolveId(letter: HandleKind, raw: string): string {
    const m = HANDLE.exec(raw);
    if (!m || m[1] !== letter) return raw;
    if (this.db.prepare(`SELECT 1 FROM ${ENTITY[KIND_OF_LETTER[letter]].table} WHERE id=?`).get(raw)) return raw;
    const row = (letter === 'p' || letter === 'a'
      ? this.db.prepare('SELECT id FROM short_ids WHERE kind=? AND num=?').get(letter, Number(m[2]))
      : this.db.prepare(`SELECT id FROM ${ENTITY[KIND_OF_LETTER[letter]].table} WHERE seq=?`).get(Number(m[2]))) as Json | undefined;
    return row?.id ?? raw;
  }
  private readonly names: Names = {
    actor: id => id ? ((this.db.prepare('SELECT name FROM actors WHERE id=?').get(id) as Json | undefined)?.name ?? id) : null,
    handle: (letter, id) => this.handleOf(letter as HandleKind, id),
    route: id => adapter(id)?.capabilities.short ?? id,
  };
  private maxSeq(projectId: string): number {
    return Number((this.db.prepare('SELECT COALESCE(MAX(seq),0) n FROM events WHERE project_id=?').get(projectId) as Json).n);
  }

  // ---- lookups (each accepts an ID or a short handle) -----------------------
  private project(id: unknown): Json {
    const row = this.db.prepare('SELECT * FROM projects WHERE id=?').get(this.resolveId('p', text(id, 'project_id', 256))) as Json | undefined;
    return row ?? fail('PROJECT_NOT_FOUND', 404);
  }
  private task(id: unknown): Json {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(this.resolveId('t', text(id, 'task_id', 256))) as Json | undefined;
    return taskRow(row) ?? fail('TASK_NOT_FOUND', 404);
  }
  private optionalTask(projectId: string, id: unknown): string | null {
    if (id === undefined || id === null) return null;
    const task = this.task(id);
    if (task.project_id !== projectId) fail('TASK_NOT_IN_PROJECT');
    return task.id;
  }
  private message(id: unknown): Json {
    const row = this.db.prepare('SELECT * FROM messages WHERE id=?').get(this.resolveId('m', text(id, 'message_id', 256))) as Json | undefined;
    return messageRow(row) ?? fail('MESSAGE_NOT_FOUND', 404);
  }
  private discussion(id: unknown): Json {
    const row = this.db.prepare('SELECT * FROM discussions WHERE id=?').get(this.resolveId('g', text(id, 'discussion_id', 256))) as Json | undefined;
    return row ?? fail('DISCUSSION_NOT_FOUND', 404);
  }
  private touch(projectId: string): void { this.db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(now(), projectId); }

  // ---- projects -----------------------------------------------------------
  op_project_discover(_actor: Actor, input: Json): Json {
    const root = optText(input.root, 'root', 4096);
    // Archived projects (cli.ts archive-project) are left out unless asked for.
    const rows = this.db.prepare(`SELECT id,name,objective,root,next_action,updated_at${input.include_archived === true ? ',archived' : ''} FROM projects
      ${input.include_archived === true ? '' : 'WHERE archived=0'} ORDER BY updated_at DESC`).all() as Json[];
    const norm = (value: string) => path.resolve(value).toLowerCase();
    const projects = root ? rows.filter(row => row.root && (norm(root).startsWith(norm(row.root) + path.sep) || norm(root) === norm(row.root))) : rows;
    return { projects };
  }
  op_project_create(_actor: Actor, input: Json): Json {
    const root = optText(input.root, 'root', 4096);
    const resolved = root ? path.resolve(root) : null;
    if (resolved && this.db.prepare('SELECT 1 FROM projects WHERE root=?').get(resolved)) fail('PROJECT_ROOT_EXISTS', 409);
    const at = now(), row = { id: randomUUID(), name: text(input.name, 'name', 256), objective: optText(input.objective, 'objective') ?? '',
      root: resolved, next_action: optText(input.next_action, 'next_action', 4096), created_at: at, updated_at: at };
    this.db.prepare('INSERT INTO projects(id,name,objective,root,next_action,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run(row.id, row.name, row.objective, row.root, row.next_action, at, at);
    return { project: row };
  }
  private projectDecisionTiers(projectId: string, limit: number): Json[] {
    const active = activeDecisionsSql();
    const standing = this.db.prepare(`SELECT * FROM decisions
      WHERE project_id=? AND task_id IS NULL AND ${active} ORDER BY seq DESC LIMIT ?`);
    const local = this.db.prepare(`SELECT * FROM decisions
      WHERE project_id=? AND task_id IS NOT NULL AND ${active} ORDER BY seq DESC LIMIT ?`);
    return [...standing.all(projectId, limit), ...local.all(projectId, limit)];
  }

  /** Deterministic briefing, no inference. With task_id: focused on that task. */
  op_project_resume(actor: Actor, input: Json): Json {
    const project = this.project(input.project_id);
    const limit = 10;
    if (input.task_id !== undefined) {
      const task = this.task(input.task_id);
      if (task.project_id !== project.id) fail('TASK_NOT_IN_PROJECT');
      return {
        project: { id: project.id, name: project.name, root: project.root },
        task,
        checkpoints: (this.db.prepare('SELECT * FROM checkpoints WHERE task_id=? ORDER BY seq DESC LIMIT ?').all(task.id, limit) as Json[]).map(checkpointRow),
        decisions: (this.db.prepare(`SELECT * FROM decisions WHERE task_id=? AND ${activeDecisionsSql()} ORDER BY seq DESC LIMIT ?`).all(task.id, limit) as Json[]).map(decisionRow),
        discussions: this.db.prepare("SELECT id,subject,question,status,owner FROM discussions WHERE task_id=? ORDER BY seq DESC LIMIT ?").all(task.id, limit),
        inbox: this.inbox(actor, project.id),
      };
    }
    // The overview is about the project: task checkpoints belong to the task-focused briefing.
    const latest = checkpointRow((this.db.prepare('SELECT * FROM checkpoints WHERE project_id=? AND task_id IS NULL ORDER BY seq DESC LIMIT 1').get(project.id)
      ?? this.db.prepare('SELECT * FROM checkpoints WHERE project_id=? ORDER BY seq DESC LIMIT 1').get(project.id)) as Json | undefined) ?? null;
    return {
      project: { id: project.id, name: project.name, objective: project.objective, root: project.root, next_action: project.next_action },
      next_action: project.next_action ?? latest?.next_action ?? null,
      latest_checkpoint: latest,
      // Your own tasks first, then the most recently changed; the total says how many more exist.
      active_tasks: (this.db.prepare(`SELECT id,title,status,owner,next_action,version,updated_at FROM tasks WHERE project_id=? AND status IN ${ACTIVE_TASK}
        ORDER BY (owner IS ?) DESC, updated_at DESC LIMIT 20`).all(project.id, actor.id)),
      active_task_total: Number((this.db.prepare(`SELECT count(*) n FROM tasks WHERE project_id=? AND status IN ${ACTIVE_TASK}`).get(project.id) as Json).n),
      recent_decisions: this.projectDecisionTiers(project.id, limit)
        .map(({ id, task_id, summary, actor_id, created_at }) => ({ id, task_id, summary, actor_id, created_at })),
      open_discussions: this.db.prepare("SELECT id,task_id,subject,owner FROM discussions WHERE project_id=? AND status='open' ORDER BY seq DESC LIMIT ?").all(project.id, limit),
      // Queued/running jobs, plus finished ones that need a look.
      jobs: this.db.prepare(`SELECT ${JOB_SUMMARY} FROM jobs WHERE project_id=? AND status IN ('queued','running','needs_review') ORDER BY seq DESC LIMIT ?`).all(project.id, limit),
      inbox: this.inbox(actor, project.id),
    };
  }
  op_project_status(_actor: Actor, input: Json): Json {
    const project = this.project(input.project_id);
    const counts = Object.fromEntries((this.db.prepare('SELECT status,count(*) n FROM tasks WHERE project_id=? GROUP BY status').all(project.id) as Json[]).map(r => [r.status, r.n]));
    return { project: { id: project.id, name: project.name, root: project.root, updated_at: project.updated_at }, task_counts: counts };
  }
  op_project_checkpoint(actor: Actor, input: Json): Json {
    const project = this.project(input.project_id);
    const row = { id: randomUUID(), project_id: project.id, task_id: this.optionalTask(project.id, input.task_id), actor_id: actor.id,
      revision: optText(input.revision, 'revision', 256), branch: optText(input.branch, 'branch', 256), summary: text(input.summary, 'summary'),
      next_action: optText(input.next_action, 'next_action', 4096), checks: list(input.checks, 'checks'),
      open_questions: list(input.open_questions, 'open_questions'),
      artifacts: list(input.artifacts, 'artifacts').map(id => this.resolveId('a', id)), confidence: confidence(input.confidence),
      failed: input.failed === true ? 1 : 0, created_at: now() };
    for (const id of row.artifacts) if (!this.db.prepare('SELECT 1 FROM artifacts WHERE id=? AND project_id=?').get(id, project.id)) fail('ARTIFACT_NOT_FOUND', 404);
    // The checkpoint before this one in the same scope (the task, or the project when there is none), for the streak.
    const previous = this.db.prepare(`SELECT failed FROM checkpoints WHERE project_id=? AND ${row.task_id ? 'task_id=?' : 'task_id IS NULL'} ORDER BY seq DESC LIMIT 1`)
      .get(...[project.id, ...(row.task_id ? [row.task_id] : [])]) as Json | undefined;
    this.db.prepare(`INSERT INTO checkpoints(id,project_id,task_id,actor_id,revision,branch,summary,next_action,checks,open_questions,artifacts,confidence,failed,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.id, row.project_id, row.task_id, row.actor_id, row.revision, row.branch, row.summary,
      row.next_action, json(row.checks), json(row.open_questions), json(row.artifacts), row.confidence, row.failed, row.created_at);
    if (row.next_action && !row.task_id) this.db.prepare('UPDATE projects SET next_action=? WHERE id=?').run(row.next_action, project.id);
    this.touch(project.id);
    // Two failed checkpoints in a row in the same scope: suggest idle peers of another model family (never starts a job).
    const stuck = row.failed === 1 && previous?.failed === 1;
    return { checkpoint: row, ...(stuck ? { consult_hint: this.op_route_hints(actor, {}).air || 'busy' } : {}) };
  }

  // ---- tasks --------------------------------------------------------------
  op_task_create(actor: Actor, input: Json): Json {
    const project = this.project(input.project_id), at = now();
    const row = { id: randomUUID(), project_id: project.id, title: text(input.title, 'title', 512), objective: optText(input.objective, 'objective') ?? '',
      acceptance: list(input.acceptance, 'acceptance'), status: 'open', owner: null, next_action: optText(input.next_action, 'next_action', 4096),
      review_policy: reviewPolicy(input.review_policy ?? 'none'), version: 1, created_by: actor.id, created_at: at, updated_at: at };
    this.db.prepare(`INSERT INTO tasks(id,project_id,title,objective,acceptance,status,owner,next_action,review_policy,version,created_by,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.id, row.project_id, row.title, row.objective, json(row.acceptance), row.status, null,
      row.next_action, row.review_policy, 1, actor.id, at, at);
    this.touch(project.id);
    return { task: row };
  }
  op_task_read(_actor: Actor, input: Json): Json { return { task: this.task(input.task_id) }; }
  private expectVersion(task: Json, input: Json): void {
    if (task.version !== version(input.version)) fail('VERSION_CONFLICT', 409, `task is at version ${task.version}`);
  }
  private saveTask(task: Json, changes: Json): Json {
    const next: Json = { ...task, ...changes, version: task.version + 1, updated_at: now() };
    this.db.prepare('UPDATE tasks SET title=?,objective=?,acceptance=?,status=?,owner=?,next_action=?,review_policy=?,version=?,updated_at=? WHERE id=?')
      .run(next.title, next.objective, json(next.acceptance), next.status, next.owner, next.next_action, next.review_policy ?? 'none', next.version, next.updated_at, task.id);
    this.touch(task.project_id);
    return { task: next };
  }
  op_task_claim(actor: Actor, input: Json): Json {
    const task = this.task(input.task_id); this.expectVersion(task, input);
    if (task.status === 'done' || task.status === 'cancelled') fail('TASK_CLOSED', 409);
    if (task.owner && task.owner !== actor.id) fail('TASK_OWNED', 409, `task is owned by ${task.owner}`);
    return this.saveTask(task, { owner: actor.id, status: task.status === 'open' ? 'in_progress' : task.status });
  }
  op_task_update(actor: Actor, input: Json): Json {
    const task = this.task(input.task_id); this.expectVersion(task, input);
    if (task.owner !== actor.id && actor.role !== 'operator') fail('OWNER_REQUIRED', 403, 'claim the task before updating it');
    const changes: Json = {};
    if (input.status !== undefined) {
      const status = STATUS_OF_CODE[input.status] ?? input.status;
      if (!TASK_STATUSES.includes(status)) fail('INVALID_INPUT', 400, 'unknown status');
      changes.status = status;
    }
    if (input.title !== undefined) changes.title = text(input.title, 'title', 512);
    if (input.objective !== undefined) changes.objective = text(input.objective, 'objective');
    if (input.acceptance !== undefined) changes.acceptance = list(input.acceptance, 'acceptance');
    if (input.next_action !== undefined) changes.next_action = optText(input.next_action, 'next_action', 4096);
    if (input.review_policy !== undefined) changes.review_policy = reviewPolicy(input.review_policy);
    if (!Object.keys(changes).length) fail('INVALID_INPUT', 400, 'no changes');
    const saved = this.saveTask(task, changes);
    // review_policy=cross: moving into review queues one review by another model family (never blocks the move).
    if (changes.status === 'awaiting_review' && task.status !== 'awaiting_review' && saved.task.review_policy === 'cross')
      return { ...saved, review: this.autoReview(actor, saved.task) };
    return saved;
  }
  op_task_release(actor: Actor, input: Json): Json {
    const task = this.task(input.task_id); this.expectVersion(task, input);
    if (task.owner !== actor.id && actor.role !== 'operator') fail('OWNER_REQUIRED', 403);
    return this.saveTask(task, { owner: null, status: task.status === 'in_progress' ? 'open' : task.status });
  }

  // ---- decisions ----------------------------------------------------------
  op_decision_record(actor: Actor, input: Json): Json {
    const project = this.project(input.project_id);
    const given = optText(input.supersedes, 'supersedes', 256), supersedes = given ? this.resolveId('d', given) : null;
    if (supersedes && !this.db.prepare('SELECT 1 FROM decisions WHERE id=? AND project_id=?').get(supersedes, project.id)) fail('DECISION_NOT_FOUND', 404);
    const row = { id: randomUUID(), project_id: project.id, task_id: this.optionalTask(project.id, input.task_id), actor_id: actor.id,
      summary: text(input.summary, 'summary', 4096), rationale: optText(input.rationale, 'rationale') ?? '', evidence: list(input.evidence, 'evidence'),
      supersedes, confidence: confidence(input.confidence), created_at: now() };
    this.db.prepare('INSERT INTO decisions(id,project_id,task_id,actor_id,summary,rationale,evidence,supersedes,confidence,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(row.id, row.project_id, row.task_id, row.actor_id, row.summary, row.rationale, json(row.evidence), row.supersedes, row.confidence, row.created_at);
    this.touch(project.id);
    return { decision: row };
  }

  // ---- addressed messages -------------------------------------------------
  private insertMessage(row: Json): Json {
    row.confidence = confidence(row.confidence);
    this.db.prepare('INSERT INTO messages(id,project_id,task_id,discussion_id,sender_id,recipients,type,body,reply_to,evidence,confidence,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(row.id, row.project_id, row.task_id, row.discussion_id, row.sender_id, json(row.recipients), row.type, row.body, row.reply_to, json(row.evidence), row.confidence, row.created_at);
    this.touch(row.project_id);
    return row;
  }
  private inbox(actor: Actor, projectId: string): Json[] {
    const rows = this.db.prepare(`SELECT m.* FROM messages m WHERE m.project_id=? AND m.type IN ('question','reply')
      AND EXISTS (SELECT 1 FROM json_each(m.recipients) r WHERE r.value=?)
      AND NOT EXISTS (SELECT 1 FROM message_acks a WHERE a.message_id=m.id AND a.actor_id=?) ORDER BY m.seq LIMIT 100`).all(projectId, actor.id, actor.id) as Json[];
    return rows.map(messageRow) as Json[];
  }
  op_team_ask(actor: Actor, input: Json): Json {
    const project = this.project(input.project_id);
    const recipients = list(input.to, 'to');
    if (!recipients.length) fail('INVALID_INPUT', 400, 'to must name at least one actor');
    for (const id of recipients) if (!this.db.prepare('SELECT 1 FROM actors WHERE id=?').get(id)) fail('ACTOR_NOT_FOUND', 404, `unknown actor ${id}`);
    const wake = input.wake ?? 'none';
    if (!['none', 'auto', 'force'].includes(wake)) fail('INVALID_INPUT', 400, 'wake must be none, auto or force');
    const message = this.insertMessage({ id: randomUUID(), project_id: project.id, task_id: this.optionalTask(project.id, input.task_id),
      discussion_id: null, sender_id: actor.id, recipients, type: 'question', body: text(input.body, 'body'), reply_to: null,
      evidence: list(input.evidence, 'evidence'), confidence: input.confidence, created_at: now() });
    return { message, ...(wake !== 'none' ? { wake: this.wakeRecipients(actor, message, wake === 'force') } : {}) };
  }

  // ---- presence and wake-up (Phase 5d) ------------------------------------------------
  /** Records that an app called an AIR tool just now (and in which project, when known). */
  private heartbeat(actor: Actor, projectId: string | null): void {
    const tags = this.db.prepare('SELECT family, adapter_id FROM actors WHERE id=?').get(actor.id) as Json | undefined;
    if (!tags) return;
    this.db.prepare(`INSERT INTO actor_presence(actor_id,family,adapter_id,last_seen_at,last_project_id) VALUES(?,?,?,?,?) ON CONFLICT(actor_id) DO UPDATE SET
      family=excluded.family, adapter_id=excluded.adapter_id, last_seen_at=excluded.last_seen_at, last_project_id=COALESCE(excluded.last_project_id, last_project_id)`)
      .run(actor.id, tags.family ?? null, tags.adapter_id ?? null, now(), projectId);
  }
  /**
   * ask wake=auto: each recipient not seen in the last ONLINE_MS (or every recipient, with force) gets one read-only
   * advice job on its own adapter (subscription or local, verified, not cooling), with the task and any evidence that
   * names context (file:, art:, task:, diff:). Wakes count toward the task's consults and toward the asker's hourly
   * limit. Returns one note per recipient: "<actor>:<job handle>" or "<actor>:<why not>".
   */
  private wakeRecipients(asker: Actor, message: Json, force: boolean): string {
    const notes: string[] = [];
    for (const to of message.recipients as string[]) {
      if (to === asker.id || asker.id === SYSTEM_ACTOR.id) continue;
      const note = (why: string) => notes.push(`${to}:${why}`);
      const seen = (this.db.prepare('SELECT last_seen_at FROM actor_presence WHERE actor_id=?').get(to) as Json | undefined)?.last_seen_at;
      if (!force && seen && Date.now() - Date.parse(seen) < ONLINE_MS) { note('online'); continue; }
      const adapterId = (this.db.prepare('SELECT adapter_id FROM actors WHERE id=?').get(to) as Json | undefined)?.adapter_id as string | undefined;
      if (!adapterId || !adapter(adapterId)) { note('no_adapter'); continue; }
      const route = this.routeStatus().find(r => r.id === adapterId)!;
      if (route.billing === 'paid') { note('paid'); continue; }
      if (route.state !== 'verified') { note(route.state); continue; }
      if (route.cooldownUntil) { note('cooldown'); continue; }
      if (message.task_id && Number((this.db.prepare("SELECT count(*) n FROM jobs WHERE task_id=? AND trigger IS NOT NULL AND trigger NOT IN ('room','resume')").get(message.task_id) as Json).n) >= MAX_CONSULTS_PER_TASK) { note('MAX_CONSULTS'); continue; }
      const hourAgo = new Date(Date.now() - 3600000).toISOString();
      if (Number((this.db.prepare("SELECT count(*) n FROM jobs WHERE trigger='wake' AND json_extract(options,'$.asked_by')=? AND created_at>?").get(asker.id, hourAgo) as Json).n) >= WAKES_PER_HOUR) { note('RATE'); continue; }
      const refs = [...(message.task_id ? [`task:${this.handleOf('t', message.task_id)}`] : []), ...(message.evidence as string[]).filter(e => /^(file|art|task|diff):/.test(e))];
      const why = seen && Date.now() - Date.parse(seen) < ONLINE_MS ? 'woken on request while online' : 'which is offline';
      try {
        const job = this.op_job_submit(SYSTEM_ACTOR, { project_id: message.project_id, task_id: message.task_id, route: adapterId, mode: 'advice', intent: 'deep', eff: 'med',
          protocol: 'air', context_refs: refs, prompt: `${asker.id} asked ${to} (you are answering for ${to}, ${why}):\n${message.body}\n`
            + `Answer concretely, as ${to} would. Your answer is posted on the thread as ${to}'s reply, marked as coming from this job.` },
          { trigger: 'wake', wakeDepth: 1, options: { message_id: message.id, wake_for: to, asked_by: asker.id } }).job;
        this.emit('job', 'job_submit', job.id, SYSTEM_ACTOR.id);
        note(this.handleOf('j', job.id)!);
      } catch (error) { if (error instanceof CommonsError) note(error.code); else throw error; }
    }
    return notes.join(',');
  }
  /** A finished wake job answers on the thread as the woken app ("via jN: ..."), or tells the asker it did not finish. Once. */
  private wakeReport(id: string): void {
    const job = this.job(id);
    if (job.trigger !== 'wake' || job.options?.reported || !FINISHED_JOB.includes(job.status)) return;
    const handle = this.handleOf('j', id)!, o = job.options;
    if (job.status === 'completed') {
      const answer = String(job.result ?? '').split(/\r?\n/).reduce<{ lines: string[]; done: boolean }>((acc, line) =>
        acc.done || /^\s*@air1\b/.test(line) ? { lines: acc.lines, done: true } : { lines: [...acc.lines, line], done: false }, { lines: [], done: false })
        .lines.join('\n').replace(/\s*```\s*$/, '').trim().slice(0, 20000);
      const p = o.air?.ok && typeof o.air.p === 'number' ? o.air.p : null;
      const reply = this.insertMessage({ id: randomUUID(), project_id: job.project_id, task_id: job.task_id, discussion_id: null, sender_id: o.wake_for,
        recipients: [o.asked_by], type: 'reply', body: `via ${handle}: ${answer || '(no answer text)'}`, reply_to: o.message_id, evidence: [handle], confidence: p, created_at: now() });
      this.emit('message', 'team_reply', reply.id, o.wake_for);
    } else {
      this.postSystemMessage(job.project_id, job.task_id, o.asked_by, `wake ${handle} for ${o.wake_for} did not finish (${job.status}): ${String(job.error ?? 'no error recorded').slice(0, 300)}`, [handle], null);
    }
    this.mergeJobOptions(id, { reported: true });
  }
  op_team_reply(actor: Actor, input: Json): Json {
    const question = this.message(input.message_id);
    if (question.type !== 'question' || !question.recipients.includes(actor.id)) fail('NOT_A_RECIPIENT', 403);
    const reply = this.insertMessage({ id: randomUUID(), project_id: question.project_id, task_id: question.task_id, discussion_id: null,
      sender_id: actor.id, recipients: [question.sender_id], type: 'reply', body: text(input.body, 'body'), reply_to: question.id,
      evidence: list(input.evidence, 'evidence'), confidence: input.confidence, created_at: now() });
    this.db.prepare("INSERT OR REPLACE INTO message_acks(message_id,actor_id,kind,at) VALUES(?,?,'answered',?)").run(question.id, actor.id, now());
    return { message: reply };
  }
  op_team_inbox(actor: Actor, input: Json): Json { return { messages: this.inbox(actor, this.project(input.project_id).id) }; }
  op_team_ack(actor: Actor, input: Json): Json {
    const message = this.message(input.message_id);
    if (!message.recipients.includes(actor.id)) fail('NOT_A_RECIPIENT', 403);
    this.db.prepare("INSERT OR IGNORE INTO message_acks(message_id,actor_id,kind,at) VALUES(?,?,'ack',?)").run(message.id, actor.id, now());
    return { acknowledged: message.id };
  }

  // ---- discussions --------------------------------------------------------
  op_discussion_open(actor: Actor, input: Json): Json {
    const project = this.project(input.project_id);
    // With seats, the discussion is a working room (ropen): seats, mode, round limit and status.
    const room = input.seats !== undefined ? roomSetup(input) : null;
    const row = { id: randomUUID(), project_id: project.id, task_id: this.optionalTask(project.id, input.task_id), owner: actor.id,
      subject: text(input.subject, 'subject', 512), question: text(input.question, 'question'), status: 'open', outcome: null, created_at: now(),
      ...(room ? { room_mode: room.mode, seats: room.seats, max_rounds: room.maxRounds, round: 0, room_status: 'idle' } : {}) };
    this.db.prepare('INSERT INTO discussions(id,project_id,task_id,owner,subject,question,status,outcome,created_at,room_mode,seats,max_rounds,round,room_status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(row.id, row.project_id, row.task_id, row.owner, row.subject, row.question, row.status, null, row.created_at,
        room?.mode ?? null, json(room?.seats ?? []), room?.maxRounds ?? null, 0, room ? 'idle' : null);
    this.touch(project.id);
    return { discussion: row };
  }

  // ---- working rooms (Phase 5b) ---------------------------------------------------
  /**
   * rstep: one bounded round of a room. Wakes every seat (round 1, parallel mode, or an explicit to=), or in directed
   * mode only the seats whose last outcome was not ok or that were @mentioned last round. Each woken seat gets one
   * read-only proto=air job (consult depth 1) with the question, this round's request, the room transcript, and the
   * task plus any ctx= as context. A seat whose route is unavailable or cooling is skipped and named in the reply.
   */
  op_room_step(actor: Actor, input: Json): Json {
    const room = this.discussion(input.discussion_id);
    if (!room.room_mode) fail('NOT_A_ROOM', 400, 'this discussion has no seats; open a room with ropen');
    if (room.status !== 'open') fail('DISCUSSION_CLOSED', 409);
    if (room.round >= room.max_rounds) fail('ROOM_MAX_ROUNDS', 409, `the room has used all ${room.max_rounds} rounds`);
    if (room.room_status === 'converged') fail('ROOM_CONVERGED', 409, 'every seat agreed; close the room with its outcome');
    if (room.room_status === 'running') fail('ROOM_BUSY', 409, 'the current round is still running; air_wait on its jobs');
    const seats: Seat[] = JSON.parse(room.seats), round = room.round + 1, handle = this.handleOf('g', room.id)!;
    const to = list(input.to, 'to');
    for (const name of to) if (!seats.some(s => s.seat === name)) fail('ROOM_SEATS', 400, `no seat named ${name}; seats are ${seats.map(s => s.seat).join(', ')}`);
    const posts = this.db.prepare("SELECT * FROM messages WHERE discussion_id=? ORDER BY seq").all(room.id) as Json[];
    let chosen = to.length ? seats.filter(s => to.includes(s.seat)) : seats;
    if (!to.length && room.room_mode === 'directed' && round > 1) {
      const lastRound = posts.filter(p => p.body.startsWith(`r${round - 1} `)).map(p => p.body as string).join('\n');
      const dissent = seats.filter(s => this.seatOutcome(room.id, s.seat) !== 'ok' || lastRound.includes(`@${s.seat}`));
      if (dissent.length) chosen = dissent;
    }
    const status = new Map(this.routeStatus().map(r => [r.id, r]));
    const skipped: string[] = [], ready: Seat[] = [];
    for (const seat of chosen) {
      const r = status.get(seat.route)!;
      if (r.state !== 'verified') skipped.push(`${seat.seat}:${r.state}`); else if (r.cooldownUntil) skipped.push(`${seat.seat}:cooldown`); else ready.push(seat);
    }
    if (!ready.length) fail('ROOM_SEATS_UNAVAILABLE', 409, `no seat can take this round: ${skipped.join(' ')}`);
    const rawTranscript = posts.map(p => `[${p.sender_id}] ${p.body}`).join('\n').slice(-40000);
    const transcript = rawTranscript ? redactSecrets(rawTranscript) : '(none yet)';
    const refs = [...(room.task_id ? [`task:${this.handleOf('t', room.task_id)}`] : []), ...list(input.context_refs, 'context_refs')];
    const request = text(input.prompt, 'prompt', 8000);
    const jobs: string[] = [];
    for (const seat of ready) {
      const others = seats.filter(s => s !== seat).map(s => `${s.seat}${s.role && s.role !== s.seat ? ` (${s.role})` : ''}`).join(', ');
      const prefix = `Working room ${handle} "${room.subject}", round ${round} of ${room.max_rounds}. You are seat "${seat.seat}"`
        + `${seat.role && seat.role !== seat.seat ? ` (role: ${seat.role})` : ''}; the other seats: ${others}.\nQuestion: ${room.question}\nThis round: ${request}\n`
        + `Transcript so far:\n`;
      const suffix = `\nGive your position for this round. Be concrete, and challenge other seats by name (@seat) where you disagree. `
        + `End with your @air1 block: verdict=ok if you agree with the current direction, chg if it needs changes, blk if something blocks it.`;
      const prompt = prefix + transcript + suffix;
      const transcriptRange = rawTranscript ? [prefix.length, prefix.length + transcript.length] : undefined;
      const job = this.op_job_submit(actor, { project_id: room.project_id, task_id: room.task_id, route: seat.route, mode: 'advice', intent: 'review', eff: seat.eff,
        protocol: 'air', context_refs: refs, ...(input.cwd !== undefined ? { cwd: input.cwd } : {}), prompt },
        { trigger: 'room', wakeDepth: 1, roomId: room.id, roomRound: round, options: { seat: seat.seat, seat_role: seat.role, ...(transcriptRange ? { room_transcript_range: transcriptRange } : {}) } }).job;
      this.emit('job', 'job_submit', job.id, actor.id);
      jobs.push(job.id);
    }
    this.db.prepare("UPDATE discussions SET round=?, room_status='running' WHERE id=?").run(round, room.id);
    this.touch(room.project_id);
    return { discussion: this.discussion(room.id), round, jobs, skipped };
  }
  /** A seat's latest outcome in a room: its last finished job's verdict, or failed. Null when it never ran. */
  private seatOutcome(roomId: string, seat: string): string | null {
    const job = this.db.prepare(`SELECT status, consult_verdict FROM jobs WHERE room_id=? AND json_extract(options,'$.seat')=? AND status IN ('completed','failed','cancelled','needs_review')
      ORDER BY seq DESC LIMIT 1`).get(roomId, seat) as Json | undefined;
    return !job ? null : job.status === 'completed' ? job.consult_verdict ?? 'none' : 'failed';
  }
  /**
   * A finished seat job posts its reply into the room. When the round's last seat finishes, the room converges (every
   * seat's latest verdict is ok), is capped (its last round used), or waits for the next rstep; the owner is told.
   */
  private roomProgress(id: string): void {
    const job = this.job(id);
    if (!job.room_id || !FINISHED_JOB.includes(job.status) || job.options?.posted) return;
    const room = this.db.prepare('SELECT * FROM discussions WHERE id=?').get(job.room_id) as Json, seat = job.options.seat as string;
    const air = job.options.air, p = air?.ok && typeof air.p === 'number' ? air.p : null;
    // The answer without its closing @air1 block (and the fence around it).
    const answer = String(job.result ?? '').split(/\r?\n/).reduce<{ lines: string[]; done: boolean }>((acc, line) => {
      if (acc.done || /^\s*@air1\b/.test(line)) return { lines: acc.lines, done: true };
      return { lines: [...acc.lines, line], done: false };
    }, { lines: [], done: false }).lines.join('\n').replace(/\s*```\s*$/, '').trim().slice(0, 4000);
    const body = job.status === 'completed'
      ? `r${job.room_round} ${seat} verdict=${job.consult_verdict ?? 'none'}${p !== null ? ` p=${p}` : ''}: ${air?.ok ? air.summary ?? '' : `(no valid block: ${air?.code ?? 'none'})`}${answer ? '\n' + answer : ''}`
      : `r${job.room_round} ${seat} did not finish (${job.status}): ${String(job.error ?? 'no error recorded').slice(0, 300)}`;
    const message = this.insertMessage({ id: randomUUID(), project_id: room.project_id, task_id: room.task_id, discussion_id: room.id, sender_id: `seat:${seat}`,
      recipients: [], type: 'post', body, reply_to: null, evidence: [this.handleOf('j', id)!], confidence: p, created_at: now() });
    this.emit('message', 'room_post', message.id, SYSTEM_ACTOR.id);
    this.mergeJobOptions(id, { posted: true });
    const roundJobs = this.db.prepare('SELECT status, consult_verdict FROM jobs WHERE room_id=? AND room_round=?').all(room.id, job.room_round) as Json[];
    if (roundJobs.some(j => !FINISHED_JOB.includes(j.status))) return;
    const count = (v: string) => roundJobs.filter(j => j.status === 'completed' && j.consult_verdict === v).length;
    const seats: Seat[] = JSON.parse(room.seats);
    const converged = seats.every(s => this.seatOutcome(room.id, s.seat) === 'ok');
    const state = converged ? 'converged' : room.round >= room.max_rounds ? 'capped' : 'idle', handle = this.handleOf('g', room.id)!;
    this.db.prepare('UPDATE discussions SET room_status=? WHERE id=?').run(state, room.id);
    this.emit('discussion', 'room_status', room.id, SYSTEM_ACTOR.id);
    this.postSystemMessage(room.project_id, room.task_id, room.owner, `room ${handle} round ${room.round}/${room.max_rounds} done: ok ${count('ok')} chg ${count('chg')} blk ${count('blk')} `
      + `unfinished ${roundJobs.filter(j => j.status !== 'completed').length}; ${state === 'idle' ? `next: rstep g=${handle} (or dclose with the outcome)` : state}`, [handle], null);
  }
  op_discussion_post(actor: Actor, input: Json): Json {
    const discussion = this.discussion(input.discussion_id);
    if (discussion.status !== 'open') fail('DISCUSSION_CLOSED', 409);
    const replyTo = optText(input.reply_to, 'reply_to', 256);
    if (replyTo && !this.db.prepare('SELECT 1 FROM messages WHERE id=? AND discussion_id=?').get(replyTo, discussion.id)) fail('MESSAGE_NOT_FOUND', 404);
    return { message: this.insertMessage({ id: randomUUID(), project_id: discussion.project_id, task_id: discussion.task_id, discussion_id: discussion.id,
      sender_id: actor.id, recipients: [], type: 'post', body: text(input.body, 'body'), reply_to: replyTo, evidence: list(input.evidence, 'evidence'), confidence: input.confidence, created_at: now() }) };
  }
  op_discussion_close(actor: Actor, input: Json): Json {
    const discussion = this.discussion(input.discussion_id);
    if (discussion.owner !== actor.id && actor.role !== 'operator') fail('OWNER_REQUIRED', 403);
    if (discussion.status !== 'open') fail('DISCUSSION_CLOSED', 409);
    const outcome = text(input.outcome, 'outcome', 4096);
    this.db.prepare("UPDATE discussions SET status='closed',outcome=? WHERE id=?").run(outcome, discussion.id);
    return { discussion: { ...discussion, status: 'closed', outcome } };
  }
  op_discussion_read(_actor: Actor, input: Json): Json {
    const discussion = this.discussion(input.discussion_id); delete discussion.seq;
    const messages = (this.db.prepare('SELECT * FROM messages WHERE discussion_id=? ORDER BY seq').all(discussion.id) as Json[]).map(messageRow);
    return { discussion, messages };
  }

  // ---- artifacts ----------------------------------------------------------
  op_artifact_submit(actor: Actor, input: Json): Json {
    const project = this.project(input.project_id);
    const content = typeof input.content === 'string' ? input.content : fail('INVALID_INPUT', 400, 'content must be text');
    const bytes = Buffer.from(content as string, 'utf8');
    if (bytes.length > MAX_ARTIFACT) fail('ARTIFACT_TOO_LARGE', 413);
    const digest = sha256(bytes), file = path.join(this.home, 'artifacts', digest), name = text(input.name, 'name', 256);
    // The same bytes under the same name in the same project are the same artifact: one row, one handle.
    const existing = this.db.prepare('SELECT * FROM artifacts WHERE project_id=? AND sha256=? AND name=? ORDER BY rowid LIMIT 1').get(project.id, digest, name) as Json | undefined;
    if (existing) return { artifact: existing, dedup: true };
    return { artifact: this.storeArtifact(project.id, actor.id, name, optText(input.kind, 'kind', 64) ?? 'text', bytes) };
  }
  /** Writes the content-addressed file and the row. `event` also adds it to the activity feed (system-made artifacts). */
  private storeArtifact(projectId: string, actorId: string, name: string, kind: string, content: string | Buffer, event?: string): Json {
    let bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    if (bytes.length > MAX_ARTIFACT) bytes = bytes.subarray(0, MAX_ARTIFACT);
    const digest = sha256(bytes), file = path.join(this.home, 'artifacts', digest);
    if (!fs.existsSync(file)) { fs.writeFileSync(file + '.tmp', bytes); fs.renameSync(file + '.tmp', file); }
    const row = { id: randomUUID(), project_id: projectId, actor_id: actorId, name, kind, sha256: digest, bytes: bytes.length, created_at: now() };
    this.db.prepare('INSERT INTO artifacts(id,project_id,actor_id,name,kind,sha256,bytes,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(row.id, row.project_id, row.actor_id, row.name, row.kind, row.sha256, row.bytes, row.created_at);
    if (event) this.emit('artifact', event, row.id, actorId);
    return row;
  }
  /** An artifact's text by ID or handle (the runner reads job context this way). */
  artifactContent(id: string): string | undefined {
    const row = this.db.prepare('SELECT sha256 FROM artifacts WHERE id=?').get(this.resolveId('a', id)) as Json | undefined;
    const file = row && path.join(this.home, 'artifacts', row.sha256);
    return file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
  }
  /** artifact_submit for the AIR-only profile: the same rules, answered as one AIR line (`A a12 ... [dedup=1]`). */
  op_art_put(actor: Actor, input: Json): Json {
    this.heartbeat(actor, null);
    const result = this.op_artifact_submit(actor, input);
    this.assignShortId('a', result.artifact.id);  // emit() would do this after we return; the reply needs the handle now
    return { ...result, air: entityLine('artifact', result.artifact, this.names) + (result.dedup ? ' dedup=1' : '') };
  }
  op_artifact_read(_actor: Actor, input: Json): Json {
    const row = this.db.prepare('SELECT * FROM artifacts WHERE id=?').get(this.resolveId('a', text(input.artifact_id, 'artifact_id', 256))) as Json | undefined;
    if (!row) fail('ARTIFACT_NOT_FOUND', 404);
    const file = path.join(this.home, 'artifacts', row!.sha256);
    const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    return { artifact: row, content, content_available: content !== null };
  }

  // ---- delegated jobs -----------------------------------------------------
  // The runner (runner.ts) executes queued jobs. A job interrupted by a service stop or crash
  // becomes needs_review and is never re-run automatically.
  private job(id: unknown): Json {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(this.resolveId('j', text(id, 'job_id', 256))) as Json | undefined;
    return jobRow(row) ?? fail('JOB_NOT_FOUND', 404);
  }

  /** Resolve a context reference without revealing whether the handle exists in another project. */
  private projectJobText(projectId: string, ref: string): string | undefined {
    let id: string;
    try {
      id = this.resolveId('j', ref);
    } catch (error) {
      // buildContext has already validated the handle syntax.
      if (error instanceof CommonsError && error.status < 500) return undefined;
      throw error;
    }
    const job = this.jobRecord(id);
    if (!job || job.project_id !== projectId) return undefined;
    const artifact = job.options?.output_artifact;
    if (typeof artifact === 'string') return this.projectArtifactText(projectId, artifact);
    return typeof job.result === 'string' ? job.result : undefined;
  }

  private validationOptions?: import('./adapters/types.ts').RunnerOptions;
  /** Share the service's adapter configuration with submit-time validation. */
  setValidationOptions(options: import('./adapters/types.ts').RunnerOptions): void {
    this.validationOptions = options;
  }
  /** Resolve the same current native configuration for dispatch, route=auto, and history lookup. */
  private resolveJobConfig(input: Json, route: string, profile: Json | undefined, intent: string, eff: string) {
    const platform = adapter(route)!;
    const effective: Json = { ...input };
    if (profile) {
      if (effective.model === undefined && profile.native_model !== null) effective.model = profile.native_model;
      if (effective.effort === undefined && profile.native_effort !== null) effective.effort = profile.native_effort;
      for (const [key, value] of Object.entries(JSON.parse(profile.native_options) as Json)) if (effective[key] === undefined) effective[key] = value;
    }
    let modelSource: string | import('./adapters/types.ts').ModelSourceFallback | undefined;
    let error: string | undefined;
    if (platform.selectModel) {
      const tracksLatest = !profile || profile.tracks_latest === 1;
      const seed = tracksLatest ? platform.profiles.find(p => p.intent === intent && p.eff === eff) : undefined;
      const state = this.hasTable('platform_state') ? this.platformState(route) : undefined;
      const entitlements = this.hasTable('route_models') ? this.modelEntitlements(route) : undefined;
      const choice = platform.selectModel({
        intent: intent as typeof INTENTS[number], eff: eff as typeof EFFORTS[number], tracksLatest, allowPremium: input.eff === 'max',
        model: optText(input.model, 'model', 128) ?? (seed ? seed.model : optText(effective.model, 'model', 128)),
        effort: optText(input.effort, 'effort', 32) ?? (seed ? seed.effort : optText(effective.effort, 'effort', 32)),
        explicitModel: input.model != null, explicitEffort: input.effort != null,
        ...(entitlements ? { entitledModels: entitlements.entitled, unentitledModels: entitlements.unentitled } : {}),
      }, state?.probe_state === 'verified' ? state.bin_version ?? null : null);
      if (choice.error !== undefined) error = choice.error;
      else {
        effective.model = choice.model;
        effective.effort = choice.effort;
        modelSource = choice.source;
      }
    }
    const model = error !== undefined ? null : optText(effective.model, 'model', 128) ?? (platform.selectModel ? null : platform.capabilities.defaultModel);
    const effort = optText(effective.effort, 'effort', 32);
    return { effective, model, effort, modelSource, error };
  }
  private jobConfiguration(input: Json, route: string, profile: Json | undefined, intent: string, eff: string) {
    const { error, ...resolved } = this.resolveJobConfig(input, route, profile, intent, eff);
    if (error !== undefined) return fail('INVALID_INPUT', 400, error);
    return resolved;
  }
  /** `consult` is internal (never from callers): jobs Agent Commons starts itself record their trigger, depth and parent. */
  op_job_submit(actor: Actor, input: Json, consult: { trigger?: string; wakeDepth?: number; parentJobId?: string; roomId?: string; roomRound?: number; options?: Json; repairOf?: string } = {}): Json {
    const project = this.project(input.project_id);
    const checkName = optText(input.check, 'check', 64);
    const patchEdit = checkName !== null;
    if (input.repair !== undefined && input.repair !== null && input.repair !== 'auto' && input.repair !== 'off')
      fail('INVALID_INPUT', 400, 'repair must be auto or off');
    const callerIntent = input.intent ?? null, callerEff = input.eff ?? null;
    if (callerIntent !== null && !(INTENTS as readonly string[]).includes(callerIntent)) fail('INVALID_INPUT', 400, `intent must be one of ${INTENTS.join(', ')}`);
    if (callerEff !== null && !(EFFORTS as readonly string[]).includes(callerEff)) fail('INVALID_INPUT', 400, `eff must be one of ${EFFORTS.join(', ')}`);
    const mode = input.mode ?? (callerIntent === 'edit' ? 'edit' : 'advice');
    if (patchEdit && (mode !== 'edit' || (input.protocol != null && input.protocol !== 'patch')
      || input.tools != null || [true, 'yes', 'true', '1', 1].includes(input.shell)))
      fail('INVALID_INPUT', 400, 'check requires mode=edit and the patch protocol; shell and tool sets are unavailable');
    const workerMode = patchEdit ? 'advice' : mode;
    const selection = inferSelection({
      intent: callerIntent, eff: callerEff, mode, trigger: consult.trigger,
      prompt: typeof input.prompt === 'string' ? input.prompt : '',
      contextRefs: Array.isArray(input.context_refs) ? input.context_refs.filter((ref: unknown): ref is string => typeof ref === 'string') : [],
    });
    const { intent, eff } = selection;
    const profileIntent = patchEdit && intent === 'edit' ? 'code' : intent;
    const requiresProfile = selection.source !== 'inferred';
    const requestedRoute = input.route ?? DEFAULT_ROUTE;
    // Auto routing requires profiles only for caller-directed selections; an omitted route defaults to auto.
    const picked = requestedRoute === 'auto' ? this.pickRoute(actor, input, workerMode, requiresProfile ? profileIntent : null, requiresProfile ? eff : null,
      patchEdit ? { ...selection, intent: profileIntent } : selection) : null;
    if (picked?.outcomeHistory) selection.reasons.push('outcome_history');
    if (picked?.workspaceReadPreferred) selection.reasons.push('workspace_read');
    if (picked?.allowanceDecided) selection.reasons.push(`allowance:${picked.allowance?.[picked.route] ?? 'held_back_scarce'}`);
    const requested = picked?.route ?? requestedRoute;
    // The R line shows short names (api, ag), so a job may name a route either way; it is stored by its full ID.
    const platform = adapter(requested) ?? allAdapters().find(a => a.capabilities.short === requested)
      ?? fail('ROUTE_UNAVAILABLE', 400, `route must be auto or one of ${adapterIds().join(', ')} (or ${allAdapters().map(a => a.capabilities.short).join(', ')})`);
    const route = platform.capabilities.id;
    if (mode !== 'advice' && mode !== 'edit') fail('INVALID_INPUT', 400, 'mode must be advice or edit');
    if (intent === 'edit' && mode !== 'edit') fail('INVALID_INPUT', 400, 'intent edit is an edit job; omit mode or set mode edit');
    // Each adapter's declared limits are enforced here, so a new platform gets them without code of its own.
    const caps = platform.capabilities;
    if (!caps.modes.includes(workerMode)) fail('INVALID_INPUT', 400, `${route} jobs are ${caps.modes.join(' or ')} only`);
    if (!project.root) fail('PROJECT_ROOT_REQUIRED', 400, 'jobs run in the project root; register the project with a root');
    // tools=<name>: an operator-approved tool set from the shared manifest, snapshotted (with its hash) into the job.
    const toolsName = optText(input.tools, 'tools', 64);
    const toolset = toolsName ? jobToolset(isBuiltinToolset(toolsName) ? null : loadManifest(this.home), toolsName, route, mode) : null;
    const minutes = input.timeout_minutes ?? caps.defaultTimeoutMinutes;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240) fail('INVALID_INPUT', 400, 'timeout_minutes must be 1-240');
    if (minutes > caps.maxTimeoutMinutes) fail('INVALID_INPUT', 400, `${route} jobs allow at most ${caps.maxTimeoutMinutes} minutes`);
    // Inferred selections may fall back to route defaults. Explicit native fields still win, including those copied by resume.
    const reqIntent = intent, reqEff = eff;
    const profile = this.db.prepare('SELECT * FROM platform_profiles WHERE adapter_id=? AND intent=? AND eff=? AND enabled=1').get(route, profileIntent, reqEff) as Json | undefined;
    if (!profile && requiresProfile)
      fail('PROFILE_UNAVAILABLE', 400, `${route} has no enabled profile for intent=${reqIntent} eff=${reqEff}`);
    if (!profile) selection.reasons.push('no_profile');
    const { effective, model, effort, modelSource } = this.jobConfiguration(input, route, profile, profileIntent, reqEff);
    if (model) {
      const newer = this.supersededModel(route, model);
      if (newer) fail('MODEL_SUPERSEDED', 400, `${model} on ${route} is superseded by ${newer}; use ${newer} instead`);
    }
    // The adapter checks the same resolved values that will be stored and dispatched.
    const options: Json = platform.validate(effective, { mode: workerMode, minutes, model, effort, options: this.validationOptions, home: this.home });
    if (modelSource) {
      options.model_source = modelSource;
      options.cli_explicit_model = input.model != null;
      options.cli_explicit_effort = input.effort != null;
    }
    if (picked) options.auto = {
      picked: picked.route,
      considered: picked.considered,
      ...(picked.allowance ? { allowance: picked.allowance } : {}),
      ...(picked.workspaceReadPreferred ? { workspace_read_preferred: true } : {}),
    };
    if (toolset) options.toolset = toolset;
    const row = { id: randomUUID(), project_id: project.id, task_id: this.optionalTask(project.id, input.task_id), route, mode,
      prompt: text(input.prompt, 'prompt', 200000), model, effort,
      timeout_ms: minutes * 60000, status: 'queued', created_by: actor.id, created_at: now() };
    // Structured protocols add a primer; their output is checked, never applied by the store.
    const protocol = patchEdit ? 'patch' : input.protocol ?? 'text';
    if (protocol !== 'text' && protocol !== 'air' && protocol !== 'patch') fail('INVALID_INPUT', 400, 'protocol must be text, air or patch');
    if (protocol !== 'text') options.proto = protocol;
    const primer = protocol === 'patch' ? AIR_PATCH_PRIMER : protocol === 'air' ? AIR_WORKER_PRIMER : '';
    // ctx=: the service resolves the context now (so a bad ref fails this call) and keeps it as an artifact.
    const refs = list(input.context_refs, 'context_refs');
    if (refs.length > 20) fail('INVALID_INPUT', 400, 'context_refs takes at most 20 refs');
    if (platform.capabilities.billing === 'paid' && refs.some(ref => ref.startsWith('diff:')))
      fail('CTX_NOT_ALLOWED', 400, 'paid routes take no diff context; name the files instead');
    const cwd = optText(input.cwd, 'cwd', 4096);
    const contextRoot = cwd ? resolveContextRoot(project.root, cwd, [this.home]) : project.root;
    if (cwd) options.cwd = contextRoot;
    if (patchEdit) {
      const turns = input.max_turns ?? 2;
      if (!Number.isInteger(turns) || turns < 1 || turns > 4) fail('INVALID_INPUT', 400, 'patch edit max_turns must be 1 to 4');
      const check = resolvePatchCheck(this.home, project.root, checkName!);
      let base: string;
      try {
        const top = (cwd: string) => realDirectory(git(cwd, ['rev-parse', '--show-toplevel']));
        const common = (cwd: string) => realDirectory(git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
        const projectCommon = common(project.root);
        if (same(top(project.root) ?? '') !== same(realDirectory(project.root) ?? '') || same(top(contextRoot) ?? '') !== same(contextRoot)
          || !projectCommon || same(common(contextRoot) ?? '') !== same(projectCommon))
          return fail('PATCH_BASE_OUTSIDE_PROJECT', 400, 'select the registered repository root or the root of one of its linked worktrees');
        base = git(contextRoot, ['rev-parse', '--verify', 'HEAD^{commit}']);
      }
      catch (error) { if (error instanceof CommonsError) throw error; return fail('PATCH_BASE_UNAVAILABLE', 400, 'patch edit jobs require a Git commit in the selected checkout'); }
      options.patch_edit = { check: check.name, check_hash: sha256(json(check)), base, turns };
      options.repair_policy = 'off';
    }
    const fileRefs = patchEdit ? refs.filter(ref => /^(file|grep):/.test(ref)) : [];
    const staticRefs = refs.filter(ref => !fileRefs.includes(ref));
    if (patchEdit) {
      buildContext(fileRefs, { root: contextRoot, deny: [this.home], artifact: () => undefined, task: () => undefined });
      options.patch_file_refs = fileRefs;
    }
    const context = staticRefs.length ? buildContext(staticRefs, {
      root: contextRoot,
      deny: [this.home],
      artifact: ref => this.projectArtifactText(project.id, ref),
      task: ref => this.taskContext(project.id, ref),
      job: ref => this.projectJobText(project.id, ref),
      recall: query => this.recallContext(project.id, query),
    }) : null;
    const promptChars = (primer ? primer.length + 2 : 0) + (context ? context.length + 2 : 0)
      + (primer || context ? '@request\n'.length : 0) + row.prompt.length;
    if (promptChars > platform.capabilities.maxPromptChars)
      fail('PROMPT_TOO_LARGE', 400, `the worker prompt would be ${promptChars} characters; ${route} takes at most ${platform.capabilities.maxPromptChars}`);
    platform.checkBudget?.({
      model, effort, promptChars, options,
      input: { ...input, ...(this.validationOptions?.openaiHelper ? { openaiHelper: this.validationOptions.openaiHelper } : {}) },
      home: this.home,
    });
    if (context || (patchEdit && refs.length)) options.ctx = refs;
    if (input.repair === 'off') options.repair_policy = 'off';
    Object.assign(options, consult.options ?? {});
    options.selection = selection;
    this.db.prepare(`INSERT INTO jobs(id,project_id,task_id,route,mode,prompt,model,effort,timeout_ms,status,created_by,created_at,options,req_intent,req_eff,resolved_model,resolved_eff,
      trigger,wake_depth,parent_job_id,room_id,room_round,repair_of) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(row.id, row.project_id, row.task_id, row.route, row.mode, row.prompt, row.model, row.effort, row.timeout_ms, row.status, row.created_by, row.created_at, json(options),
        reqIntent, reqEff, row.model, row.effort, consult.trigger ?? null, consult.wakeDepth ?? 0, consult.parentJobId ?? null, consult.roomId ?? null, consult.roomRound ?? null,
        consult.repairOf ?? null);
    if (context) {
      const art = this.storeArtifact(project.id, actor.id, `${this.handleOf('j', row.id)}-context.md`, 'job_context', context, 'job_context');
      this.mergeJobOptions(row.id, { ctx_artifact: art.id, ctx_chars: context.length });
    }
    this.touch(project.id);
    return { job: briefJob(this.job(row.id)) };
  }
  // ---- consult triggers (Phase 5a) ----------------------------------------------
  /**
   * review_policy=cross: one read-only review of the task by a route of another model family than the mover's
   * (route=auto, intent review, eff high, subscription only, proto=air), with the task and its latest edit diff as
   * context. Capped per task; the job runs at consult depth 1, so its verdict never triggers anything further.
   * Returns { job } or { skipped: CODE }; a skip is reported to the mover and never blocks the task's move.
   */
  private autoReview(mover: Actor, task: Json): Json {
    const taskHandle = this.handleOf('t', task.id)!;
    const skip = (code: string, detail = '') => {
      this.postSystemMessage(task.project_id, task.id, mover.id, `review skipped for ${taskHandle}: ${code}${detail ? ' ' + detail : ''}`, [], null);
      return { skipped: code };
    };
    // Room seats are bounded by the room (seats x rounds), so they do not use up the task's consults.
    const consults = Number((this.db.prepare("SELECT count(*) n FROM jobs WHERE task_id=? AND trigger IS NOT NULL AND trigger NOT IN ('room','resume','repair')").get(task.id) as Json).n);
    if (consults >= MAX_CONSULTS_PER_TASK) return skip('MAX_CONSULTS', `(${consults} of ${MAX_CONSULTS_PER_TASK} used)`);
    const lastDiff = (this.db.prepare("SELECT options FROM jobs WHERE task_id=? AND options LIKE '%diff_artifact%' ORDER BY seq DESC LIMIT 1").get(task.id) as Json | undefined);
    const diffArtifact = lastDiff ? JSON.parse(lastDiff.options).diff_artifact as string | undefined : undefined;
    const input: Json = { project_id: task.project_id, task_id: task.id, route: 'auto', intent: 'review', eff: 'high', cost: 'sub', protocol: 'air',
      context_refs: [`task:${taskHandle}`, ...(diffArtifact ? [`art:${this.handleOf('a', diffArtifact)}`] : [])],
      prompt: `Review task ${taskHandle}: does the work meet its objective and acceptance criteria? Correctness first. Name concrete problems `
        + `(file and line where you can). verdict=ok if nothing needs changing, chg if changes are needed, blk if something blocks it.` };
    try {
      // The mover's family decides "another family"; the job itself is Agent Commons'.
      const picked = this.pickRoute(mover, input, 'advice', 'review', 'high');
      const family = adapter(picked.route)!.capabilities.family, moverFamily = this.actorFamily(mover.id);
      if (moverFamily !== null && family === moverFamily) return skip('NO_CROSS_FAMILY', `(only ${picked.considered.join(', ')} can take it)`);
      const job = this.op_job_submit(SYSTEM_ACTOR, { ...input, route: picked.route },
        { trigger: 'auto_review', wakeDepth: 1, options: { review_for: mover.id, auto: { picked: picked.route, considered: picked.considered } } }).job;
      this.emit('job', 'job_submit', job.id, SYSTEM_ACTOR.id);
      return { job: job.id };
    } catch (error) {
      if (error instanceof CommonsError) return skip(error.code, error.message.replace(/^no route can take this job: /, '(') + (error.code === 'NO_ELIGIBLE_ROUTE' ? ')' : ''));
      throw error;
    }
  }
  /** A message from Agent Commons to one actor, shown in its inbox (type reply) and the activity feed. */
  private postSystemMessage(projectId: string, taskId: string | null, to: string, body: string, evidence: string[], confidence: number | null): void {
    const message = this.insertMessage({ id: randomUUID(), project_id: projectId, task_id: taskId, discussion_id: null, sender_id: SYSTEM_ACTOR.id,
      recipients: [to], type: 'reply', body, reply_to: null, evidence, confidence, created_at: now() });
    this.emit('message', 'consult_report', message.id, SYSTEM_ACTOR.id);
  }
  /** A finished consult job tells the actor it was for: the verdict and summary, or why it did not finish. Once per job. */
  private reportConsult(id: string): void {
    const job = this.job(id);
    if (!job.trigger || !job.options?.review_for || job.options.reported || !FINISHED_JOB.includes(job.status)) return;
    const handle = this.handleOf('j', id)!, air = job.options.air;
    const evidence = [handle, ...(job.options.output_artifact ? [this.handleOf('a', job.options.output_artifact)!] : [])];
    const body = job.status !== 'completed' ? `review ${handle} did not finish (${job.status}): ${String(job.error ?? 'no error recorded').slice(0, 300)}`
      : air?.ok && air.verdict ? `review ${handle} verdict=${air.verdict}${typeof air.p === 'number' ? ` p=${air.p}` : ''}: ${air.summary ?? '(no summary)'}`
      : `review ${handle} finished without a verdict (${air?.ok ? 'no verdict=' : air?.code ?? 'no block'}); see ${handle}`;
    this.postSystemMessage(job.project_id, job.task_id, job.options.review_for, body, evidence, air?.ok && typeof air.p === 'number' ? air.p : null);
    this.mergeJobOptions(id, { reported: true });
  }
  // ---- yield and resume (Phase 5c) -------------------------------------------------
  /**
   * A completed proto=air advice job that ended with `need` gets one consult job (depth 1, trigger yield) on the route
   * it named (or route=auto, subscription only). When that consult finishes, the same worker runs again (a
   * continuation, trigger resume) with its original request, its context and the answer, or the note that the consult
   * did not finish. Structured advice jobs can also request local context without a consult. Paid jobs can save
   * that context but cannot auto-resume. Refusals go in need_refused; links go in options.next.
   */
  private yieldStep(id: string): void {
    const job = this.job(id);
    if (!FINISHED_JOB.includes(job.status) || job.options?.yield_done) return;
    if (job.trigger === 'yield' && job.parent_job_id) {
      try { return this.resume(job); }
      catch (error) { if (error instanceof CommonsError) return this.mergeJobOptions(id, { yield_done: true, resume_refused: error.code }); throw error; }
    }
    const need = job.status === 'completed' && job.options?.air?.ok ? job.options.air.need : undefined;
    if (!need || job.wake_depth >= 1) return;
    const refuse = (code: string) => this.mergeJobOptions(id, { need_refused: code });
    if (job.mode !== 'advice') return refuse('EDIT_JOB');
    const paid = adapter(job.route)?.capabilities.billing === 'paid';
    if (need.to === 'ctx') return this.resolveYieldContext(job, need.ctx, paid);
    if (paid) return refuse('PAID_ROUTE');
    if ((job.options.yields ?? 0) >= MAX_YIELDS) return refuse('MAX_YIELDS');
    const target = need.to === 'auto' ? 'auto' : allAdapters().find(a => a.capabilities.id === need.to || a.capabilities.short === need.to);
    if (!target) return refuse('ROUTE_UNAVAILABLE');
    if (target !== 'auto' && target.capabilities.billing === 'paid') return refuse('PAID_ROUTE');
    const handle = this.handleOf('j', id)!;
    const creator: Actor = { id: job.created_by, name: job.created_by, role: 'participant' };
    const input: Json = { project_id: job.project_id, task_id: job.task_id, mode: 'advice', intent: 'deep', eff: need.eff ?? 'med', cost: 'sub', protocol: 'air',
      context_refs: need.ctx, cwd: job.options?.cwd,
      prompt: `A worker on job ${handle} asks: ${need.question}\nAnswer it directly and concretely; you have the context the worker named.` };
    try {
      // route=auto ranks for the job's creator (its family); the consult itself is Agent Commons'.
      const picked = target === 'auto' ? this.pickRoute(creator, input, 'advice', 'deep', input.eff) : null;
      const route = picked?.route ?? (target as { capabilities: { id: string } }).capabilities.id;
      const consult = this.op_job_submit(SYSTEM_ACTOR, { ...input, route },
        { trigger: 'yield', wakeDepth: 1, parentJobId: id, options: { question: need.question, ...(picked ? { auto: { picked: picked.route, considered: picked.considered } } : {}) } }).job;
      this.emit('job', 'job_submit', consult.id, SYSTEM_ACTOR.id);
      this.mergeJobOptions(id, { yield_done: true, next: consult.id });
    } catch (error) { if (error instanceof CommonsError) return refuse(error.code); throw error; }
  }
  /** Resolve a local context request without calling a peer or automatically submitting paid work. */
  private resolveYieldContext(job: Json, requested: string[], paid: boolean): void {
    const refuse = (code: string) => this.mergeJobOptions(job.id, { yield_done: true, need_refused: code });
    if (!requested?.length) return refuse('NO_CTX');
    const o = job.options ?? {};
    const refs = [...new Set<string>([...(o.ctx ?? []), ...requested])];
    if (refs.length > 20) return refuse('INVALID_INPUT');
    if (paid && refs.some(ref => ref.startsWith('diff:'))) return refuse('CTX_NOT_ALLOWED');
    try {
      const projectId = job.project_id, projectRoot = this.project(projectId).root;
      const root = o.cwd ? resolveContextRoot(projectRoot, o.cwd, [this.home]) : projectRoot;
      const context = buildContext(refs, {
        root,
        deny: [this.home],
        artifact: ref => this.projectArtifactText(projectId, ref),
        task: ref => this.taskContext(projectId, ref),
        job: ref => this.projectJobText(projectId, ref),
        recall: query => this.recallContext(projectId, query),
      });
      const art = this.storeArtifact(projectId, SYSTEM_ACTOR.id, `${this.handleOf('j', job.id)}-need-context.md`, 'job_context', context, 'job_context');
      this.mergeJobOptions(job.id, { need_ctx_artifact: art.id });
      if (paid) return refuse('PAID_ROUTE');
      if ((o.yields ?? 0) >= MAX_YIELDS) return refuse('MAX_YIELDS');

      const handle = this.handleOf('a', art.id)!;
      const continuation = this.op_job_submit(SYSTEM_ACTOR, {
        project_id: projectId, task_id: job.task_id, route: job.route, mode: 'advice',
        model: job.model ?? undefined, effort: job.effort ?? undefined, protocol: o.proto ?? 'text', cwd: o.cwd, context_refs: refs,
        ...(o.task ? { task: o.task } : {}), ...(o.effort_reason ? { effort_reason: o.effort_reason } : {}),
        timeout_minutes: Math.round(job.timeout_ms / 60000),
        prompt: `${job.prompt}\n\n@ctx_resolved ${handle} (${refs.length} refs): the requested context is now included in @ctx above. Continue the original request.`,
      }, { trigger: 'resume', wakeDepth: 0, parentJobId: job.parent_job_id ?? job.id, options: {
        yields: (o.yields ?? 0) + 1, resumed_from: job.id,
      } }).job;
      this.emit('job', 'job_submit', continuation.id, SYSTEM_ACTOR.id);
      this.mergeJobOptions(job.id, { yield_done: true, next: continuation.id });
    } catch (error) { if (error instanceof CommonsError) return refuse(error.code); throw error; }
  }
  /** The consult answering a yield finished: run the asking worker again with its request, context and the answer. */
  private resume(consult: Json): void {
    const parent = this.job(consult.parent_job_id), handle = this.handleOf('j', consult.id)!;
    const answer = String(consult.result ?? '').split(/\r?\n/).reduce<{ lines: string[]; done: boolean }>((acc, line) =>
      acc.done || /^\s*@air1\b/.test(line) ? { lines: acc.lines, done: true } : { lines: [...acc.lines, line], done: false }, { lines: [], done: false })
      .lines.join('\n').replace(/\s*```\s*$/, '').trim().slice(0, 20000);
    const said = consult.status === 'completed'
      ? `@consult ${handle} (${consult.route}) answered "${consult.options.question}":\n${answer || '(no answer text)'}\n\nContinue the original request with this answer.`
      : `@consult ${handle} (${consult.route}) did not finish (${consult.status}): ${String(consult.error ?? 'no error recorded').slice(0, 300)}\n\nContinue the original request without it.`;
    const o = parent.options ?? {};
    const continuation = this.op_job_submit(SYSTEM_ACTOR, { project_id: parent.project_id, task_id: parent.task_id, route: parent.route, mode: 'advice',
      model: parent.model ?? undefined, effort: parent.effort ?? undefined, protocol: o.proto ?? 'text', cwd: o.cwd, context_refs: o.ctx ?? [],
      ...(o.task ? { task: o.task } : {}), ...(o.effort_reason ? { effort_reason: o.effort_reason } : {}),
      timeout_minutes: Math.round(parent.timeout_ms / 60000), prompt: `${parent.prompt}\n\n${said}` },
      { trigger: 'resume', wakeDepth: 0, parentJobId: parent.id, options: { yields: (o.yields ?? 0) + 1, resumed_from: parent.id, consult: consult.id } }).job;
    this.emit('job', 'job_submit', continuation.id, SYSTEM_ACTOR.id);
    this.mergeJobOptions(consult.id, { yield_done: true, next: continuation.id });
  }
  /** The last job of a yield chain: follows options.next from a job (a few hops at most). */
  private chainTail(id: string): string {
    let current = id;
    // Yield hops plus one automatic repair.
    for (let hop = 0; hop < 2 * MAX_YIELDS + 3; hop++) { const next = this.job(current).options?.next; if (!next) break; current = next; }
    return current;
  }
  // ---- automatic repair (j16 sections 3 and 5) ------------------------------------
  /**
   * A finished advice job with explicit deliverable-failure evidence (see repair.ts) gets one linked follow-up per root
   * job: more output room, one effort step, or one capability step, on the same route with the same context, cwd and
   * spending fields (the caller's ceiling is reused, never raised; the central helper still admits paid work). The
   * original stays as it was; options.next links it, so air_wait on the original follows to the repair. Uncertain
   * outcomes (needs_review), timeouts, cancellations and edit jobs never qualify. Refusals go in options.repair.
   */
  private repairStep(id: string): void {
    const job = this.job(id) as Json & import('./repair.ts').RepairJob;
    if (!FINISHED_JOB.includes(job.status) || job.options?.repair || job.repair_of) return;
    const trigger = repairTrigger(job);
    if (!trigger) return;
    const refuse = (code: string) => this.mergeJobOptions(id, { repair: { trigger: trigger.kind, refused: code } });
    // The root assignment: a yield continuation belongs to the job that yielded. Jobs Agent Commons starts for its own
    // purposes (consults, automatic reviews, room seats) and repairs themselves are never repaired automatically.
    // A caller's own job is a root whatever its intent, including intent=review.
    const root = job.trigger === 'resume' && job.parent_job_id ? this.jobRecord(job.parent_job_id) : job;
    if (!root || (job.trigger !== null && job.trigger !== 'resume') || (root.id !== job.id && root.trigger !== null) || root.repair_of) return refuse('NOT_A_ROOT_JOB');
    if (job.options?.repair_policy === 'off' || root.options?.repair_policy === 'off') return refuse('REPAIR_OFF');
    if (job.mode !== 'advice') return refuse('EDIT_JOB');
    if (job.options?.next) return refuse('CHAINED');
    if (this.db.prepare('SELECT 1 FROM jobs WHERE repair_of=?').get(root.id)) return refuse('ALREADY_REPAIRED');
    let correction = planCorrection(trigger, job);
    if ('refused' in correction) return refuse(correction.refused);
    const o = job.options ?? {}, handle = this.handleOf('j', id)!;
    let targetRoute = job.route;
    if (correction.kind === 'effort' || correction.kind === 'capability') {
      const prevModel = job.resolved_model ?? job.model ?? null;
      const prevEff = String(o.ag_effort_fit?.used ?? job.resolved_eff ?? job.effort ?? job.req_eff ?? 'med');
      const effectiveFor = (route: string, intent: string, eff: string, extra: Json = {}) => {
        const prof = this.db.prepare('SELECT * FROM platform_profiles WHERE adapter_id=? AND intent=? AND eff=? AND enabled=1').get(route, intent, eff) as Json | undefined;
        const cfg = this.resolveJobConfig(extra, route, prof, intent, eff);
        const taskHint = String(extra.task ?? (prof?.native_options ? JSON.parse(prof.native_options).task : undefined) ?? intent);
        const effUsed = adapter(route)?.effectiveEffort?.(taskHint, cfg.effort ?? eff, this.home) ?? cfg.effort ?? eff;
        return { model: cfg.model ?? null, effort: String(effUsed) };
      };
      const sameAsPrev = (c: { model: string | null; effort: string }, kind: string) =>
        c.model === prevModel && c.effort === prevEff && (c.model !== null || !!adapter(job.route)?.effectiveEffort || kind === 'effort');
      const extraTask = o.task ? { task: o.task } : {};
      let resolved = effectiveFor(job.route, correction.intent, correction.eff, extraTask);
      if (sameAsPrev(resolved, correction.kind) && correction.kind === 'effort') {
        const stepped = planCorrection(trigger, { ...job, req_eff: 'max' });
        if (!('refused' in stepped) && stepped.kind === 'capability') {
          const capResolved = effectiveFor(job.route, stepped.intent, stepped.eff, extraTask);
          if (!sameAsPrev(capResolved, stepped.kind)) { correction = stepped; resolved = capResolved; }
        }
      }
      if (sameAsPrev(resolved, correction.kind)) {
        if (adapter(job.route)?.capabilities.billing === 'paid') return refuse('NO_STRONGER_PROFILE');
        const reviewActorId = typeof o.review_for === 'string' ? o.review_for : job.created_by;
        const failoverActorRow = this.db.prepare('SELECT id, name, role FROM actors WHERE id=?').get(reviewActorId) as Actor | undefined;
        const failoverActor: Actor = failoverActorRow ?? { id: reviewActorId, name: reviewActorId, role: 'participant' };
        const failoverIntent = (job.req_intent ?? 'code') as typeof INTENTS[number];
        const failoverEff = (job.req_eff ?? 'med') as typeof EFFORTS[number];
        try {
          const picked = this.pickRoute(failoverActor, {
            project_id: job.project_id, task_id: job.task_id, cost: 'sub', context_refs: o.ctx ?? [], prompt: job.prompt,
            ...(o.toolset?.name ? { tools: o.toolset.name } : {}),
          }, 'advice', failoverIntent, failoverEff, undefined, { excludeRoute: job.route });
          const reviewFamily = failoverIntent === 'review' ? this.actorFamily(failoverActor.id) : null;
          if (reviewFamily && adapter(picked.route)?.capabilities.family === reviewFamily) return refuse('NO_STRONGER_PROFILE');
          targetRoute = picked.route;
          correction = { kind: 'route_failover', from: job.route, to: picked.route, intent: failoverIntent, eff: failoverEff };
        } catch {
          return refuse('NO_STRONGER_PROFILE');
        }
      }
    }
    const previous = typeof job.result === 'string' && job.result.length > 0 && trigger.kind !== 'truncated';
    const refs = [...new Set<string>([...(o.ctx ?? []), ...(previous ? [`job:${handle}`] : []),
      ...(o.patch_check?.repair_ctx ? [`art:${this.handleOf('a', o.patch_check.repair_ctx)}`] : [])])];
    if (trigger.kind === 'patch_unapplicable' && !o.patch_check?.repair_ctx) return refuse('NO_REPAIR_CONTEXT');
    if (refs.length > 20) return refuse('CTX_FULL');
    // A paid repair spends only what is left of the caller's ceiling for this assignment (the attempt's known cost
    // is subtracted); with an unknown cost or nothing meaningful left there is no repair.
    let spend: Json = {};
    if (adapter(targetRoute)?.capabilities.billing === 'paid') {
      const ceiling = Number(o.max_cost_usd), spent = job.cost_usd == null || !String(job.cost_usd).trim() ? NaN : Number(job.cost_usd);
      if (!Number.isFinite(ceiling) || !Number.isFinite(spent) || spent < 0) return refuse('UNKNOWN_SPEND');
      const left = Math.floor((ceiling - spent) * 1e6) / 1e6;
      if (left < 0.01) return refuse('BUDGET_SPENT');
      spend = { max_cost_usd: String(left), purpose: o.purpose, deliverable: o.deliverable, tier: o.tier };
    }
    const input: Json = {
      project_id: job.project_id, task_id: job.task_id, route: targetRoute, mode: 'advice', protocol: o.proto ?? 'text', cwd: o.cwd,
      context_refs: refs, timeout_minutes: Math.round(job.timeout_ms / 60000), ...spend,
      ...(targetRoute === job.route && o.task ? { task: o.task } : {}), ...(targetRoute === job.route && o.effort_reason ? { effort_reason: o.effort_reason } : {}),
      ...(o.toolset?.name ? { tools: o.toolset.name } : {}),
      // Output room changes nothing else: the same native model and effort. Otherwise the stepped profile decides.
      ...(correction.kind === 'output'
        ? { model: job.model ?? undefined, effort: job.effort ?? undefined, max_output_tokens: correction.maxOutputTokens,
          ...(o.selection?.source !== 'inferred' ? { intent: job.req_intent ?? undefined, eff: job.req_eff ?? undefined } : {}) }
        : { intent: correction.intent, eff: correction.eff }),
      prompt: repairPrompt(job.prompt, trigger, handle, previous),
    };
    // Inserting the repair and linking it from the attempt are one unit (a savepoint nests inside any caller
    // transaction); the event is published only after both are stored.
    let repairId: string;
    this.db.exec('SAVEPOINT job_repair');
    try {
      repairId = this.op_job_submit(SYSTEM_ACTOR, input, { trigger: 'repair', wakeDepth: 0, parentJobId: root.id, repairOf: root.id,
        options: { repair_from: id, repair_trigger: trigger.kind, correction } }).job.id;
      this.mergeJobOptions(id, { repair: { trigger: trigger.kind, job: repairId, correction: correction.kind }, next: repairId });
      this.db.exec('RELEASE job_repair');
    } catch (error) {
      this.db.exec('ROLLBACK TO job_repair');
      this.db.exec('RELEASE job_repair');
      if (error instanceof CommonsError) return refuse(error.code);
      // The unique index refuses a second repair of the same root.
      if (/UNIQUE/i.test(String((error as Error)?.message))) return refuse('ALREADY_REPAIRED');
      throw error;
    }
    this.emit('job', 'job_submit', repairId, SYSTEM_ACTOR.id);
  }
  /** Adds keys to a job's options. */
  private mergeJobOptions(id: string, patch: Json): void {
    const current = JSON.parse((this.db.prepare('SELECT options FROM jobs WHERE id=?').get(id) as Json).options);
    this.db.prepare('UPDATE jobs SET options=? WHERE id=?').run(json({ ...current, ...patch }), id);
  }
  private projectArtifactText(projectId: string, ref: string): string | undefined {
    const row = this.db.prepare('SELECT id FROM artifacts WHERE id=? AND project_id=?').get(this.resolveId('a', ref), projectId) as Json | undefined;
    return row ? this.artifactContent(row.id) : undefined;
  }
  /** A task's full AIR line plus its 5 latest checkpoints and decisions, for ctx=task:tN. */
  private taskContext(projectId: string, ref: string): string | undefined {
    const task = this.db.prepare('SELECT id FROM tasks WHERE id=? AND project_id=?').get(this.resolveId('t', ref), projectId) as Json | undefined;
    if (!task) return undefined;
    const handle = this.handleOf('t', task.id)!;
    const related = [...(this.db.prepare('SELECT id FROM checkpoints WHERE task_id=? ORDER BY seq DESC LIMIT 5').all(task.id) as Json[]).map(r => this.handleOf('c', r.id)!),
      ...(this.db.prepare(`SELECT id FROM decisions WHERE task_id=? AND ${activeDecisionsSql()} ORDER BY seq DESC LIMIT 5`).all(task.id) as Json[]).map(r => this.handleOf('d', r.id)!)];
    return [handle, ...related].flatMap(h => this.airItem(h, 16000, null)).join('\n');
  }
  private recallMemory(projectId: string, query: string, maxChars: number): ReturnType<typeof recallProjectMemory> {
    return recallProjectMemory(this.db, {
      projectId, query, maxChars,
      renderEntity: (kind, id) => {
        const row = this.db.prepare(`SELECT * FROM ${ENTITY[kind].table} WHERE id=? AND project_id=?`)
          .get(id, projectId) as Json | undefined;
        if (!row) return null;
        // Metadata only: a recall hit does not expand artifact contents or discussion messages.
        const limit = Math.min(300, maxChars);
        const extra = kind === 'decision' ? this.decisionDetails(row, limit)
          : kind === 'job' ? kv('verdict', row.consult_verdict) + kv('res', row.result, limit)
          : '';
        return entityLine(kind, row, this.names, { limit, extra });
      },
    });
  }
  private recallContext(projectId: string, query: string, maxChars = 4000): string {
    return this.recallMemory(projectId, query, maxChars).lines.join('\n') || '(no matching project memory)';
  }
  /** Runner: an edit job's diff, kept as an artifact, with its short stat. */
  attachDiff(id: string, patch: string, stat: string): void {
    const job = this.job(id);
    const art = this.storeArtifact(job.project_id, 'agent-commons', `${this.handleOf('j', id)}.diff`, 'diff', patch, 'job_diff');
    this.mergeJobOptions(id, { diff_artifact: art.id, diff_stat: stat });
  }
  /** Runner: an API tool loop's transcript, kept as an artifact (tr= on the job line). */
  attachTranscript(id: string, content: string): void {
    const job = this.job(id);
    const art = this.storeArtifact(job.project_id, 'agent-commons', `${this.handleOf('j', id)}-transcript.md`, 'job_transcript', content, 'job_transcript');
    this.mergeJobOptions(id, { transcript_artifact: art.id });
  }
  /** Output fields for a J line, or just the brief result fields when the normal J line has already been rendered. */
  private jobOutputs(options: unknown, brief?: { result: string; cap: number }): string {
    const o: Json = typeof options === 'string' ? JSON.parse(options) : (options as Json) ?? {};
    if (brief) {
      const summary = o.air?.ok && typeof o.air.summary === 'string' ? o.air.summary.slice(0, 200) : '';
      const preview = summary ? ` sum=${JSON.stringify(summary)}`
        : brief.result ? ` res=${JSON.stringify(brief.result.slice(0, brief.cap))}` : '';
      return ` rchars=${brief.result.length}${preview}`;
    }
    const a = (id: unknown) => typeof id === 'string' ? this.handleOf('a', id) ?? id : null;
    const air = o.air ? (o.air.ok ? ` air=ok${kv('verdict', o.air.verdict)}${typeof o.air.p === 'number' ? kv('p', o.air.p) : ''}` : ` air=err:${o.air.code}`) : '';
    // Yield chains: the job asked for help (need=to:..), was refused (need_refused=), or links to the next job.
    const j = (id: unknown) => typeof id === 'string' ? this.handleOf('j', id) ?? id : null;
    const need = o.air?.ok && o.air.need ? ` need=to:${o.air.need.to}` : '';
    const patch = o.patch ? ` patch=${o.patch.edits}e/${o.patch.files}f${o.patch.deletes ? `/${o.patch.deletes}d` : ''}` : '';
    // Receipt: the tool set and its definition hash (as air_get tools lists it), and the API tool loop's transcript.
    const tools = o.toolset?.name ? ` tools=${o.toolset.name}@${String(o.toolset.def_sha256 ?? o.toolset.sha256 ?? '').slice(0, 12)}` : '';
    return air + patch + need + tools + kv('need_ctx', a(o.need_ctx_artifact)) + kv('need_refused', o.need_refused) + kv('next', j(o.next)) + kv('diff', a(o.diff_artifact)) + kv('stat', o.diff_stat)
      + kv('ctx', a(o.ctx_artifact)) + kv('out', a(o.output_artifact)) + kv('tr', a(o.transcript_artifact));
  }
  /** Runner: the job as stored (mode, workdir and base revision for the edit diff). */
  jobRecord(id: string): Json | undefined { const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as Json | undefined; return row ? jobRow(row) : undefined; }
  /** The prompt is shortened unless include_prompt is true: callers already have it, and it can be 200 KB. */
  op_job_status(_actor: Actor, input: Json): Json {
    const job = this.job(input.job_id);
    return { job: input.include_prompt === true ? job : briefJob(job) };
  }
  op_job_list(_actor: Actor, input: Json): Json {
    const project = this.project(input.project_id);
    const status = optText(input.status, 'status', 32);
    const rows = (status
      ? this.db.prepare(`SELECT ${JOB_SUMMARY} FROM jobs WHERE project_id=? AND status=? ORDER BY seq DESC LIMIT 50`).all(project.id, status)
      : this.db.prepare(`SELECT ${JOB_SUMMARY} FROM jobs WHERE project_id=? ORDER BY seq DESC LIMIT 50`).all(project.id)) as Json[];
    return { jobs: rows };
  }
  op_job_cancel(_actor: Actor, input: Json): Json {
    const job = this.job(input.job_id);
    if (job.status === 'queued') {
      this.db.prepare("UPDATE jobs SET status='cancelled',finished_at=?,error='CANCELLED_BEFORE_START' WHERE id=? AND status='queued'").run(now(), job.id);
    } else if (job.status === 'running') {
      this.db.prepare('UPDATE jobs SET cancel_requested=1 WHERE id=?').run(job.id);
    } else fail('JOB_FINISHED', 409, `job is ${job.status}`);
    return { job: this.job(job.id) };
  }

  /** Runner: atomically move the oldest queued job whose route has a free slot to running. */
  claimQueuedJob(routeLimits: Record<string, number>, globalLimit: number): Json | null {
    return this.transaction(() => {
      const running = this.db.prepare("SELECT route, count(*) n FROM jobs WHERE status='running' GROUP BY route").all() as Json[];
      const counts = Object.fromEntries(running.map(r => [r.route, Number(r.n)]));
      if (running.reduce((sum, r) => sum + Number(r.n), 0) >= globalLimit) return null;
      // A tool set limits its own jobs across every route (Blender: two processes).
      const toolsetRunning = Object.fromEntries((this.db.prepare(`SELECT json_extract(options,'$.toolset.name') t, count(*) n FROM jobs
        WHERE status='running' AND json_extract(options,'$.toolset.name') IS NOT NULL GROUP BY t`).all() as Json[]).map(r => [r.t, Number(r.n)]));
      for (const candidate of this.db.prepare(`SELECT id,route,json_extract(options,'$.toolset.name') toolset,
        json_extract(options,'$.toolset.max_concurrent') toolset_max, json_extract(options,'$.toolset.slot_locks') slot_locks FROM jobs WHERE status='queued'
        AND NOT EXISTS (SELECT 1 FROM platform_state
          WHERE adapter_id=jobs.route AND (last_update_result='running'
            OR (cooldown_until>? AND json_type(jobs.options,'$.auto')='object')))
        ORDER BY seq`).all(now()) as Json[]) {
        if ((counts[candidate.route] ?? 0) >= (routeLimits[candidate.route] ?? 0)) continue;
        if (candidate.toolset && (toolsetRunning[candidate.toolset] ?? 0) >= Number(candidate.toolset_max ?? 1)) continue;
        // The server's own process slots (the Blender wrapper's two), which other apps share: wait while all are held.
        if (candidate.slot_locks) {
          const locks = JSON.parse(candidate.slot_locks) as string[];
          if (locks.length && busySlots(locks) >= locks.length) continue;
        }
        this.db.prepare("UPDATE jobs SET status='running',started_at=? WHERE id=? AND status='queued'").run(now(), candidate.id);
        this.emit('job', 'job_status', candidate.id, 'agent-commons');
        return this.job(candidate.id);
      }
      return null;
    });
  }
  /** Runner: record progress or the outcome. Only listed columns can change. */
  updateJob(id: string, fields: Json): Json {
    const allowed = ['status', 'workdir', 'branch', 'base_revision', 'pid', 'exit_code', 'result', 'changed_files', 'error', 'turns', 'finished_at', 'helper_job_id', 'cost_usd',
      'tokens_in', 'tokens_out', 'reported_model', 'adapter_version'];
    const extra: Json = {};
    if (typeof fields.result === 'string') {
      const job = this.job(id);
      // Validate structured output before any result spill. Never apply it here.
      const proto = job.options?.proto;
      if (!job.options?.patch_edit && (proto === 'air' || proto === 'patch')) extra.air = checkWorkerBlock(fields.result);
      if (!job.options?.patch_edit && proto === 'patch' && fields.status === 'completed') {
        let blocks: ReturnType<typeof parsePatchBlocks> | undefined;
        try { blocks = parsePatchBlocks(fields.result); extra.patch = summarizePatchBlocks(blocks); }
        catch (error) { extra.patch_error = String((error as Error).message).slice(0, 300); /* still record the result */ }
        // A read-only dry run in the job's own workspace, so a proposal that cannot apply is known before anyone applies it.
        if (blocks?.length && job.mode === 'advice' && job.workdir && fs.existsSync(job.workdir)) {
          let check: ReturnType<typeof applyPatchBlocks> | undefined;
          try { check = applyPatchBlocks(job.workdir, blocks, { dryRun: true, deny: [this.home] }); }
          catch { /* An unreadable or denied workspace leaves the proposal unchecked, not rejected. */ }
          if (check) {
            extra.patch_check = { applied: blocks.length - check.rejected.length, rejected: check.rejected.length };
            if (check.rejected.length) {
              // Diagnostics are separate: without them the repair is refused (NO_REPAIR_CONTEXT), not sent blind.
              try {
                const content = buildRepairContext(job.workdir, check.rejected, undefined, [this.home]);
                extra.patch_check.repair_ctx = this.storeArtifact(job.project_id, 'agent-commons', `${this.handleOf('j', id)}-patch-check.txt`, 'job_context', content, 'job_context').id;
              } catch (error) { extra.patch_check.ctx_error = String((error as Error)?.message ?? error).slice(0, 200); }
            }
          }
        }
      }
      // Output over the limit is kept whole as an artifact; the result keeps the head and the tail.
      if (fields.result.length > RESULT_LIMIT) {
        extra.output_bytes = Buffer.byteLength(fields.result, 'utf8');
        const art = this.storeArtifact(job.project_id, 'agent-commons', `${this.handleOf('j', id)}-output.txt`, 'job_output', fields.result, 'job_output');
        const handle = this.handleOf('a', art.id) ?? art.id, head = 48 * 1024, tail = 12 * 1024;
        fields = { ...fields, result: fields.result.slice(0, head)
          + `\n...[${fields.result.length - head - tail} characters omitted; full output: ${handle}]...\n` + fields.result.slice(-tail) };
        extra.output_artifact = art.id;
      }
    }
    const keys = Object.keys(fields).filter(key => allowed.includes(key));
    if (Object.keys(extra).length) this.mergeJobOptions(id, extra);
    if (keys.length) this.db.prepare(`UPDATE jobs SET ${keys.map(k => k + '=?').join(',')} WHERE id=?`)
      .run(...keys.map(k => k === 'changed_files' ? json(fields[k]) : fields[k] ?? null), id);
    // Preserve the existing verdict field and record the same observation once, separately from acceptance.
    if (extra.air && fields.status === 'completed') {
      this.db.prepare('UPDATE jobs SET consult_verdict=? WHERE id=?').run(extra.air.ok && extra.air.verdict ? extra.air.verdict : 'none', id);
      recordConsultOutcome(this.db, id, SYSTEM_ACTOR.id);
    }
    // Wall-clock run time, from start to finish.
    if (keys.includes('finished_at')) this.db.prepare(`UPDATE jobs SET latency_ms=CAST(ROUND((julianday(finished_at)-julianday(started_at))*86400000) AS INTEGER)
      WHERE id=? AND started_at IS NOT NULL AND finished_at IS NOT NULL`).run(id);
    if (keys.includes('status')) {
      // A route with pool evidence can supply its own cooldown decision, including an explicit clear.
      const job = this.db.prepare('SELECT route,status,error FROM jobs WHERE id=?').get(id) as Json;
      if (Object.hasOwn(fields, 'cooldown_until')) {
        if (typeof fields.cooldown_until === 'string' && Date.parse(fields.cooldown_until) > Date.now())
          this.setCooldown(job.route, fields.cooldown_until, 'all observed quota pools are closed');
        else this.clearCooldown(job.route);
      } else if (String(job.error ?? '').startsWith('QUOTA_EXHAUSTED') && job.status !== 'completed') {
        this.setCooldown(job.route, cooldownUntil(job.error), String(job.error).slice(0, 300));
      } else if (job.status === 'completed') this.clearCooldown(job.route);
      this.yieldStep(id);
      try { this.repairStep(id); }
      catch (error) { console.error(JSON.stringify({ event: 'store.repair_failed', job: id, error: String((error as Error)?.message ?? error).slice(0, 300) })); }
      this.emit('job', 'job_status', id, 'agent-commons');
      this.reportConsult(id);
      this.roomProgress(id);
      this.wakeReport(id);
    }
    return this.job(id);
  }
  /**
   * cli.ts job-settle: the operator closes a needs_review job as failed or cancelled after checking it with its
   * platform. It never re-runs the job, starts a repair, or changes the central helper's ledger: a paid job's
   * reservation is settled in the helper, not here. The previous error and the reason stay on the job.
   */
  settleJob(ref: string, status: 'failed' | 'cancelled', reason: string, operator: string): Json {
    if (status !== 'failed' && status !== 'cancelled') fail('INVALID_INPUT', 400, 'settle as failed or cancelled');
    const text = reason.trim();
    if (!text) fail('INVALID_INPUT', 400, 'a reason is required');
    const job = this.jobByRef(ref);
    if (job.status !== 'needs_review') fail('JOB_NOT_IN_REVIEW', 409, `job is ${job.status}; only needs_review jobs can be settled`);
    const at = now();
    return this.transaction(() => {
      const changed = this.db.prepare("UPDATE jobs SET status=?, error=? WHERE id=? AND status='needs_review'")
        .run(status, `SETTLED: ${text.slice(0, 300)} (was: ${String(job.error ?? 'none').slice(0, 300)})`, job.id);
      if (!changed.changes) fail('JOB_NOT_IN_REVIEW', 409, 'job changed while settling');
      this.mergeJobOptions(job.id, { settled: { at, by: operator, from: 'needs_review', to: status, reason: text.slice(0, 300) } });
      this.emit('job', 'job_settle', job.id, operator);
      return this.job(job.id);
    });
  }
  /** Stores observations without predicting refills. Older deliveries cannot overwrite newer ones. */
  recordUsage(route: string, rows: UsageObservation[], source: string, checkStartedAt?: string, partial = false): void {
    if (!rows.length) return;
    const at = now();
    const upsert = this.db.prepare(`INSERT INTO usage_windows(route,pool,window,remaining_percent,resets_at,observed_at,source)
      VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(route,pool,window) DO UPDATE SET
        remaining_percent=excluded.remaining_percent, resets_at=excluded.resets_at,
        observed_at=excluded.observed_at, source=excluded.source
      WHERE excluded.observed_at > usage_windows.observed_at
        OR (excluded.observed_at = usage_windows.observed_at AND ?=1)`);
    const previous = this.db.prepare('SELECT * FROM usage_windows WHERE route=? AND pool=? AND window=?');
    const markEarly = this.db.prepare(`UPDATE usage_windows SET early_reset_observed_at=?, early_reset_scheduled_at=?, early_reset_remaining_percent=?
      WHERE route=? AND pool=? AND window=?`);
    const persist = () => {
      const observedWindows = new Map<string, UsageWindow>();
      const known = checkStartedAt ? this.usageFor(route) : [];
      const tracksResets = checkStartedAt && adapter(route)?.capabilities.billing === 'sub';
      for (const row of rows) {
        if (!row || typeof row.pool !== 'string' || !row.pool.trim() || typeof row.window !== 'string' || !row.window.trim()) continue;
        if (row.remaining_percent !== null && (typeof row.remaining_percent !== 'number'
          || !Number.isFinite(row.remaining_percent) || row.remaining_percent < 0 || row.remaining_percent > 100)) continue;
        const observed = row.observed_at === undefined ? at : row.observed_at;
        if (typeof observed !== 'string' || !Number.isFinite(Date.parse(observed))) continue;
        if (row.resets_at !== null && (typeof row.resets_at !== 'string' || !Number.isFinite(Date.parse(row.resets_at)))) continue;
        const observedAt = new Date(observed).toISOString();
        if (checkStartedAt && observedAt > at) continue;
        const resetsAt = row.resets_at === null ? null : new Date(row.resets_at).toISOString();
        const closed = row.closed === true && !!resetsAt;
        const before = tracksResets ? previous.get(route, row.pool, row.window) as Json | undefined : undefined;
        const written = upsert.run(route, row.pool, row.window, row.remaining_percent, resetsAt, observedAt,
          closed ? `${source}:closed` : source, checkStartedAt ? 0 : 1);
        if (!written.changes || !checkStartedAt || observedAt < checkStartedAt) continue;
        // A check straddling the scheduled reset cannot prove that replenishment occurred early.
        if (before && typeof before.resets_at === 'string' && before.resets_at > at && !closed && row.remaining_percent !== null
          && (before.source === source || before.source.endsWith(':closed') || before.source === 'reply' && before.remaining_percent === 0)) {
          // Some providers return slightly different timestamps for the same schedule. A rebound to
          // previously observed headroom in that schedule is not another newly observed refill.
          const sameSchedule = Math.abs(Date.parse(before.early_reset_scheduled_at ?? '') - Date.parse(before.resets_at)) <= 2_000;
          const alreadyObserved = sameSchedule ? before.early_reset_remaining_percent ?? 0 : 0;
          if (before.remaining_percent !== null && row.remaining_percent > Math.max(before.remaining_percent, alreadyObserved)) {
            markEarly.run(at, before.resets_at, row.remaining_percent, route, row.pool, row.window);
          }
        }
        const stale = !!resetsAt && resetsAt <= at;
        observedWindows.set(JSON.stringify([row.pool, row.window]),
          { ...row, route, resets_at: resetsAt, observed_at: observedAt, source, stale, closed,
            remaining_percent: stale ? null : row.remaining_percent });
      }
      if (checkStartedAt && !partial && observedWindows.size) this.reconcileQuotaCooldown(route, [...observedWindows.values()], known, checkStartedAt);
    };
    if (this.db.isTransaction) persist();
    else this.transaction(persist);
  }

  blockUsageRead(route: string, identity: string): void {
    this.db.prepare('UPDATE platform_state SET usage_blocked_identity=? WHERE adapter_id=?').run(identity, route);
  }

  private reconcileQuotaCooldown(route: string, snapshot: UsageWindow[], known: UsageWindow[], checkStartedAt: string): void {
    const positive = snapshot.filter(row => !row.closed && row.remaining_percent !== null && row.remaining_percent > 0);
    const pools = adapter(route)?.reopenedQuotaPools?.(snapshot, known, this.home) ?? [];
    if (!pools.length) return;
    // A fully open pool supersedes a prior reply's synthetic marker for exhaustion of an unidentified window.
    const clearMarker = this.db.prepare(`DELETE FROM usage_windows WHERE route=? AND pool=?
      AND window='exhaustion' AND observed_at < ? AND source LIKE 'reply%'`);
    for (const pool of pools) clearMarker.run(route, pool, checkStartedAt);
    const state = this.platformState(route);
    if (!state?.cooldown_started_at || checkStartedAt <= state.cooldown_started_at) return;
    if (state.cooldown_reason === 'all observed quota pools are closed') return this.clearCooldown(route);
    if (!/^QUOTA_EXHAUSTED\b/.test(state.cooldown_reason ?? '')) return;
    // A partial or unrelated reading must not erase the windows that established this cooldown.
    const blocked: Array<[string, string]> = JSON.parse(state.cooldown_quota_windows ?? '[]');
    if (blocked.length && blocked.every(([pool, window]) => pools.includes(pool) && (window === 'exhaustion'
      || positive.some(fresh => fresh.pool === pool && fresh.window === window)))) this.clearCooldown(route);
  }

  /** A passed reset is unknown, not evidence of a refill. Stored observations remain unchanged. */
  usageFor(route: string): import('./adapters/types.ts').UsageWindow[] {
    const at = Date.now();
    return (this.db.prepare('SELECT * FROM usage_windows WHERE route=? ORDER BY pool,window').all(route) as Json[]).map(row => {
      const stale = at - Date.parse(row.observed_at) > 6 * 60 * 60 * 1000
        || (row.resets_at !== null && Date.parse(row.resets_at) <= at);
      const markedClosed = row.source.endsWith(':closed');
      return { route: row.route, pool: row.pool, window: row.window,
        remaining_percent: stale ? null : row.remaining_percent, resets_at: row.resets_at,
        observed_at: row.observed_at, source: markedClosed ? row.source.slice(0, -':closed'.length) : row.source, stale,
        ...(row.early_reset_observed_at ? { early_reset_observed_at: row.early_reset_observed_at,
          early_reset_scheduled_at: row.early_reset_scheduled_at } : {}),
        closed: markedClosed && row.resets_at !== null && Date.parse(row.resets_at) > at };
    });
  }

  /**
   * air_get routes: the route adviser view (goal g1, AC-CAP1/2). One W line per route with what a caller needs to pick
   * one by hand: family, billing, probe state, running/limit, fresh usage per window, and the route's track record
   * (explicit accepted/rejected feedback, failures, median latency and average cost over the last 90 days).
   * Read-only; route=auto still makes the actual choice and the central helper still admits paid work.
   */
  routeAdviceLines(): string[] {
    const since = new Date(Date.now() - 90 * 86_400_000).toISOString();
    return ['@air1 routes window=90d', ...this.routeStatus().map(r => {
      const usage = this.usageFor(r.id).filter(u => u.remaining_percent !== null)
        .map(u => `${u.pool === 'default' || u.pool === 'prepaid' ? '' : u.pool + '/'}${u.window}:${Math.round(u.remaining_percent!)}`);
      const stats = this.db.prepare(`SELECT count(*) n, sum(status='completed') ok, sum(status IN ('failed','needs_review')) bad,
          avg(cost_usd) cost FROM jobs WHERE route=? AND created_at>=?`).get(r.id, since) as Json;
      const fb = this.db.prepare(`SELECT sum(o.kind='accepted') acc, sum(o.kind='rejected') rej FROM job_outcomes o JOIN jobs j ON j.id=o.job_id
          WHERE j.route=? AND j.created_at>=? AND o.kind IN ('accepted','rejected')`).get(r.id, since) as Json;
      const lat = (this.db.prepare(`SELECT latency_ms FROM jobs WHERE route=? AND created_at>=? AND status='completed' AND latency_ms IS NOT NULL
          ORDER BY latency_ms`).all(r.id, since) as Json[]).map(x => Number(x.latency_ms));
      const median = lat.length ? Math.round(lat[Math.floor(lat.length / 2)] / 1000) : null;
      const ws = adapter(r.id)?.capabilities.hasWorkspaceReadTools ? 1 : 0;
      const alw = classifyAllowance(this.usageFor(r.id)).cls.slice(0, 3);
      return `W ${r.short} fam=${r.family} bill=${r.billing} ws=${ws} alw=${alw} st=${r.state}${r.cooldownUntil ? ` cool@${r.cooldownUntil.slice(0, 16)}Z` : ''} run=${r.running}/${r.limit}`
        + ` left%=${usage.length ? usage.map(u => q(u)).join(',') : '?'} jobs=${Number(stats.n)} ok=${Number(stats.ok ?? 0)} bad=${Number(stats.bad ?? 0)}`
        + ` acc=${Number(fb.acc ?? 0)} rej=${Number(fb.rej ?? 0)}${median !== null ? ` p50=${median}s` : ''}${stats.cost != null ? ` avg$=${Number(stats.cost).toFixed(3)}` : ''}`;
    })];
  }

  /** Each pool is constrained by its tightest fresh window; independent pools are alternatives. */
  private routeQuotaState(routeId: string): number | null {
    const poolMins = new Map<string, number>();
    const windows = this.usageFor(routeId);
    for (const window of adapter(routeId)?.routeQuotaWindows?.(windows) ?? windows) {
      if (window.stale) continue;
      const remaining = window.closed ? 0 : window.remaining_percent;
      if (remaining === null) continue;
      poolMins.set(window.pool, Math.min(poolMins.get(window.pool) ?? remaining, remaining));
    }
    return poolMins.size ? Math.max(...poolMins.values()) : null;
  }

  /** Status surfaces use the same freshness rules as scheduling. */
  usageWindows(): import('./adapters/types.ts').UsageWindow[] {
    return (this.db.prepare('SELECT DISTINCT route FROM usage_windows ORDER BY route').all() as Json[])
      .flatMap(row => this.usageFor(row.route));
  }

  /** Counts each job once, atomically with its comparisons and aggregate counters. */
  recordConsumption(route: string, family: string, rows: import('./adapters/types.ts').ConsumptionRow[], jobId: string): boolean {
    if (typeof route !== 'string' || !route.trim() || typeof family !== 'string' || !family.trim()
      || typeof jobId !== 'string' || !jobId.trim() || !Array.isArray(rows)) return false;
    const valid = new Map<string, import('./adapters/types.ts').ConsumptionRow>();
    for (const row of rows) {
      if (!row || typeof row.pool !== 'string' || !row.pool.trim()
        || typeof row.window !== 'string' || !row.window.trim() || typeof row.consumed !== 'boolean') continue;
      const key = JSON.stringify([row.pool, row.window]);
      valid.set(key, { pool: row.pool, window: row.window, consumed: row.consumed || valid.get(key)?.consumed === true });
    }
    if (!valid.size) return false;
    const comparisons = [...valid.values()];
    const at = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const inserted = this.db.prepare(`INSERT OR IGNORE INTO pool_evidence_jobs(route,job_id,family,observations,last_seen_at)
        VALUES(?,?,?,?,?)`).run(route, jobId, family, JSON.stringify(comparisons), at);
      if (Number(inserted.changes) === 0) {
        this.db.exec('COMMIT');
        return false;
      }
      const upsert = this.db.prepare(`INSERT INTO pool_evidence(route,family,pool,window,runs,consumed_runs,last_seen_at,last_job_id)
        VALUES(?,?,?,?,1,?,?,?)
        ON CONFLICT(route,family,pool,window) DO UPDATE SET
          runs=pool_evidence.runs+1, consumed_runs=pool_evidence.consumed_runs+excluded.consumed_runs,
          last_seen_at=excluded.last_seen_at, last_job_id=excluded.last_job_id`);
      for (const row of comparisons) upsert.run(route, family, row.pool, row.window, row.consumed ? 1 : 0, at, jobId);
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  poolEvidence(route: string): import('./adapters/types.ts').PoolEvidence[] {
    return this.db.prepare('SELECT * FROM pool_evidence WHERE route=? ORDER BY family,pool,window').all(route) as unknown as import('./adapters/types.ts').PoolEvidence[];
  }

  /** Original per-job comparisons, including stable windows that did not decrease. */
  consumptionRuns(route: string): import('./adapters/types.ts').ConsumptionRun[] {
    return (this.db.prepare(`SELECT job_id,family,observations,last_seen_at FROM pool_evidence_jobs
      WHERE route=? ORDER BY last_seen_at,job_id`).all(route) as Json[]).map(row => ({
      job_id: row.job_id, family: row.family, rows: JSON.parse(row.observations), last_seen_at: row.last_seen_at,
    }));
  }

  /** Adapter annotations are data, not scheduling rules. */
  annotateJob(id: string, options: Json): void { this.mergeJobOptions(id, options); }

  /** Resolves a review target from its actor or parent job; family tags remain authoritative. */
  reviewFamily(job: Json): string | null {
    const target = job.options?.review_for;
    if (!target && job.trigger !== 'auto_review') return null;
    const actorOf = (row: Json): string | null => {
      for (const id of [row.actor_id, row.created_by, row.requested_by, row.submitted_by, row.actor]) {
        if (typeof id !== 'string') continue;
        const family = this.actorFamily(id);
        if (family) return family;
      }
      return null;
    };
    const refs = typeof target === 'string' ? [target]
      : target && typeof target === 'object' ? [target.actor_id, target.actor, target.job_id, target.id] : [];
    for (const ref of refs) {
      if (typeof ref !== 'string') continue;
      const family = this.actorFamily(ref);
      if (family) return family;
      let parent = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(ref) as Json | undefined;
      if (!parent) {
        try { parent = this.jobByRef(ref); } catch { /* not a job reference */ }
      }
      if (parent) {
        const owner = actorOf(parent);
        if (owner) return owner;
      }
    }
    if (job.parent_job_id) {
      const parent = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(job.parent_job_id) as Json | undefined;
      if (parent) {
        const family = actorOf(parent);
        if (family) return family;
      }
    }
    return actorOf(job);
  }

  /** Marks a route as out of quota until `until`. A route never probed gets a placeholder state row. */
  setCooldown(route: string, until: string, reason: string): void {
    const caps = adapter(route)?.capabilities, at = now();
    if (!this.platformState(route)) {
      if (!caps) return;
      this.db.prepare(`INSERT INTO platform_state(adapter_id,family,billing,probe_state,reason,last_probe_at,updated_at) VALUES(?,?,?,'unavailable','not probed yet',?,?)`)
        .run(route, caps.family, caps.billing, at, at);
    }
    const rows = this.usageFor(route);
    const blocked = (adapter(route)?.routeQuotaWindows?.(rows) ?? rows)
      .filter(row => !row.stale && (row.closed || row.remaining_percent === 0))
      .map(row => [row.pool, row.window]);
    this.db.prepare(`UPDATE platform_state SET cooldown_until=?, cooldown_reason=?, cooldown_started_at=?,
      cooldown_quota_windows=?, updated_at=? WHERE adapter_id=?`).run(new Date(until).toISOString(), reason, at, JSON.stringify(blocked), at, route);
  }
  /** Ends a route's cooldown (all routes when none is named). */
  clearCooldown(route?: string): void {
    const clear = `UPDATE platform_state SET cooldown_until=NULL, cooldown_reason=NULL, cooldown_started_at=NULL,
      cooldown_quota_windows=NULL, updated_at=? WHERE cooldown_until IS NOT NULL`;
    if (route) this.db.prepare(`${clear} AND adapter_id=?`).run(now(), route);
    else this.db.prepare(clear).run(now());
  }

  // ---- operator tools (cli.ts) ----------------------------------------------
  /** Hides a project from discovery and root lookup (or shows it again). */
  setArchived(ref: string, archived: boolean): Json {
    const project = this.project(ref);
    this.db.prepare('UPDATE projects SET archived=? WHERE id=?').run(archived ? 1 : 0, project.id);
    return { id: project.id, name: project.name, archived };
  }
  /** Tags an actor with its model family and the adapter that can run it headless (for cross-family review and wake-up). */
  setActorTags(actorId: string, family: string | null, adapterId: string | null): void {
    if (!this.db.prepare('SELECT 1 FROM actors WHERE id=?').get(actorId)) fail('ACTOR_NOT_FOUND', 404, `unknown actor ${actorId}`);
    if (family !== null && !/^[a-z][a-z0-9-]{0,31}$/.test(family)) fail('INVALID_INPUT', 400, 'family must be a short lowercase word such as anthropic, openai, google or local');
    if (adapterId !== null && !adapter(adapterId)) fail('ROUTE_UNAVAILABLE', 400, `adapter must be one of ${adapterIds().join(', ')}`);
    this.db.prepare('UPDATE actors SET family=?, adapter_id=? WHERE id=?').run(family, adapterId, actorId);
  }
  /** Counts for /health and cli.ts status. No secrets. */
  serviceCounts(): Json {
    const count = (status: string) => Number((this.db.prepare('SELECT count(*) n FROM jobs WHERE status=?').get(status) as Json).n);
    return { schema_version: Number((this.db.prepare('PRAGMA user_version').get() as Json).user_version),
      running_jobs: count('running'), queued_jobs: count('queued'), needs_review_jobs: count('needs_review') };
  }
  /** cli.ts job-diff / job-drop: a job by handle (j5) or ID. */
  jobByRef(ref: string): Json { const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(this.resolveId('j', ref)) as Json | undefined; return row ? jobRow(row)! : fail('JOB_NOT_FOUND', 404); }
  /** cli.ts status: unanswered messages per recipient. */
  inboxCounts(): Json[] {
    return this.db.prepare(`SELECT r.value actor, count(*) n FROM messages m, json_each(m.recipients) r WHERE m.type IN ('question','reply')
      AND NOT EXISTS (SELECT 1 FROM message_acks a WHERE a.message_id=m.id AND a.actor_id=r.value) GROUP BY r.value ORDER BY r.value`).all() as Json[];
  }
  // ---- routing (Phase 4) ------------------------------------------------------
  /** Each registered route's load, probe state and cooldown, in registry order. */
  routeStatus(): Array<{ id: string; short: string; family: string; billing: string; running: number; queued: number; limit: number; state: string; cooldownUntil: string | null }> {
    const load = new Map((this.db.prepare("SELECT route, sum(status='running') running, sum(status='queued') queued FROM jobs WHERE status IN ('running','queued') GROUP BY route").all() as Json[]).map(r => [r.route, r]));
    const at = now();
    // The limit the runner enforces (operator override within the route's ceiling), so the R line, route hints and
    // route=auto see the same capacity the runner will actually use.
    const limits = this.effectiveLimits(allAdapters().map(a => a.capabilities.id)).routes;
    return allAdapters().map(({ capabilities: c }) => {
      const s = this.platformState(c.id), l = load.get(c.id);
      return { id: c.id, short: c.short, family: c.family, billing: c.billing, running: Number(l?.running ?? 0), queued: Number(l?.queued ?? 0), limit: limits[c.id] ?? c.maxConcurrent,
        state: s?.probe_state ?? 'not_probed', cooldownUntil: s?.cooldown_until && s.cooldown_until > at ? s.cooldown_until : null };
    });
  }
  /** `R claude=0/1+1q codex=0/1:cool@2026-11-22T10:10Z api=0/1:paid ag=0/1:blk` (flags: blk drift na cool@ paid). */
  routeLine(): string {
    const flag: Record<string, string> = { blocked: 'blk', drifted: 'drift', unavailable: 'na', not_probed: 'na' };
    return 'R ' + this.routeStatus().map(r => {
      const flags = [flag[r.state], r.cooldownUntil ? `cool@${r.cooldownUntil.slice(0, 16)}Z` : '', r.billing === 'paid' ? 'paid' : ''].filter(Boolean);
      return `${r.short}=${r.running}/${r.limit}${r.queued ? `+${r.queued}q` : ''}${flags.length ? ':' + flags.join(',') : ''}`;
    }).join(' ');
  }
  /** The R line each reader last saw (per project), so a delta sync repeats it only when it changed. Kept in memory: after a restart it shows once. */
  private readonly seenRoutes = new Map<string, string>();

  /** route_hints: idle, verified, non-paid routes outside a family (default: the caller's), as short names. */
  op_route_hints(actor: Actor, input: Json): Json {
    const family = input.exclude_family ?? this.actorFamily(actor.id), mode = input.mode ?? 'advice';
    const routes = this.routeStatus().filter(r => r.state === 'verified' && !r.cooldownUntil && r.billing !== 'paid' && r.family !== family
      && r.running < r.limit && r.queued === 0 && adapter(r.id)!.capabilities.modes.includes(mode));
    return { air: routes.map(r => r.short).join(','), routes: routes.map(r => r.id) };
  }
  private actorFamily(id: string): string | null { return ((this.db.prepare('SELECT family FROM actors WHERE id=?').get(id) as Json | undefined)?.family as string | null) ?? null; }

  /**
   * route=auto: a fixed rule, no model involved. Eligible routes are verified, not cooling, support the mode (and a
   * shell for edit jobs that need one), fit the cost class (sub by default: local and subscription routes; paid only
   * with cost=paid and the spend fields), have a profile for the intent, take the prompt's size, and aren't known
   * to have exhausted all pools. Prefer routes not known to be low on quota, then billing (local, sub, paid),
   * a different family for reviews, idle routes, profile priority, allowance (expiring before neutral before scarce;
   * see allowance.ts), recent success rate, and registry order.
   */
  private pickRoute(actor: Actor, input: Json, mode: string, intent: string | null, eff: string | null,
    selection?: ReturnType<typeof inferSelection>, opts?: { excludeRoute?: string }): {
    route: string; considered: string[]; outcomeHistory?: true; allowance?: Record<string, string>;
    allowanceDecided?: true; workspaceReadPreferred?: true; costTiebreak?: true;
  } {
    let candidates: readonly OutcomeCandidate[] = [];
    const { withoutAllowance, ...baseline } = this.pickRouteByPolicy(actor, input, mode, intent, eff, list => { candidates = list; }, selection, opts);
    const task = selection?.intent ?? intent, effort = selection?.eff ?? eff;
    // History never changes the inferred intent/effort, a native pin, or a high-capability selection.
    if ((task !== 'fast' && task !== 'code' && task !== 'edit') || !effort
      || effort === 'high' || effort === 'max' || input.model != null || input.effort != null) return baseline;
    const first = candidates.find(r => r.id === baseline.route);
    if (!first) return baseline;
    const getProfile = this.db.prepare('SELECT * FROM platform_profiles WHERE adapter_id=? AND intent=? AND eff=? AND enabled=1');
    const profileFor = (r: OutcomeCandidate) => getProfile.get(r.id, task, effort) as Json | undefined;
    const incumbent = profileFor(first);
    if (!incumbent) return baseline;
    const rate = (r: OutcomeCandidate, profile: Json) => {
      try {
        const { model, effort: nativeEffort } = this.jobConfiguration(input, r.id, profile, task, effort);
        return model == null ? null : acceptanceHistory(this.db, { route: r.id, intent: task, eff: effort, mode, model, nativeEffort }).rate;
      } catch {
        // Advisory evidence must not make a valid baseline unusable.
        return null;
      }
    };
    const before = rate(first, incumbent);
    if (before === null || before >= .5) return baseline;
    const peers = candidates.filter(r => r.id !== baseline.route && r.billing === first.billing && r.lowQuota === first.lowQuota
      && (r.allowance?.cls ?? 'neutral') === (first.allowance?.cls ?? 'neutral') && r.running === first.running && r.queued === first.queued && r.limit === first.limit)
      .sort((a, b) => b.success - a.success || a.order - b.order);
    for (const peer of peers) {
      const profile = profileFor(peer);
      if (!profile || profile.priority !== incumbent.priority) continue;
      const after = rate(peer, profile);
      if (after !== null && after > .5) {
        // Peers share the incumbent's allowance class, so allowance still decided unless the peer is the route that
        // would have won without it.
        const { allowanceDecided: _, ...rest } = baseline;
        return { ...rest, route: peer.id, outcomeHistory: true, ...(withoutAllowance !== peer.id && baseline.allowanceDecided ? { allowanceDecided: true as const } : {}) };
      }
    }
    return baseline;
  }

  private evaluateRouteCandidates(actor: Actor, input: Json, mode: string, intent: string | null, eff: string | null,
    selection?: ReturnType<typeof inferSelection>, opts?: { excludeRoute?: string }) {
    const cost = input.cost ?? 'sub';
    if (!['local', 'sub', 'paid'].includes(cost)) fail('INVALID_INPUT', 400, 'cost must be local, sub or paid');
    const allowed = ({ local: ['local'], sub: ['local', 'sub'], paid: ['local', 'sub', 'paid'] } as Record<string, string[]>)[cost];
    const shell = [true, 'yes', '1', 'true', 1].includes(input.shell);
    const profileRequired = intent !== null || eff !== null;
    const profileIntent = selection?.intent ?? intent ?? (mode === 'edit' ? 'edit' : 'code'), profileEff = selection?.eff ?? eff ?? 'med';
    const promptChars = typeof input.prompt === 'string' ? input.prompt.length : 0;
    const spendFields = input.max_cost_usd !== undefined && input.purpose !== undefined && input.deliverable !== undefined;
    const refs = Array.isArray(input.context_refs) ? input.context_refs : [];
    const diffContext = refs.some((r: unknown) => String(r).startsWith('diff:'));
    const callerFamily = this.actorFamily(actor.id);
    const toolsetName = optText(input.tools, 'tools', 64);
    const toolset = toolsetName ? (findToolset(isBuiltinToolset(toolsetName) ? null : loadManifest(this.home), toolsetName) ?? fail('TOOLSET_UNKNOWN', 400, `no approved tool set ${JSON.stringify(toolsetName)}`)) : null;
    const needsWorkspaceRead = mode === 'advice' && refs.length === 0 && !toolsetName;
    type Candidate = ReturnType<Store['routeStatus']>[number] & {
      priority: number; success: number; order: number; lowQuota: number; allowance: Allowance;
      workspaceMismatch: number; expectedCost: number; resolvedModel: string | null; resolvedEffort: string | null;
    };
    const skipped: string[] = [], eligible: Candidate[] = [];
    const hasProfiles = this.hasTable('platform_profiles'), hasState = this.hasTable('platform_state');
    for (const [order, r] of this.routeStatus().entries()) {
      const caps = adapter(r.id)!.capabilities;
      const quota = r.state === 'verified' && !r.cooldownUntil ? this.routeQuotaState(r.id) : null;
      const storedProfile = hasProfiles
        ? this.db.prepare('SELECT * FROM platform_profiles WHERE adapter_id=? AND intent=? AND eff=? AND enabled=1').get(r.id, profileIntent, profileEff) as Json | undefined
        : undefined;
      const profile = profileRequired ? storedProfile : { priority: 0 };
      const resolvedCfg = hasProfiles || hasState ? this.resolveJobConfig(input, r.id, storedProfile, profileIntent, profileEff) : null;
      const candidateModel = optText(input.model, 'model', 128) ?? resolvedCfg?.model ?? null;
      const candidateEffort = optText(input.effort, 'effort', 32) ?? resolvedCfg?.effort ?? null;
      const superseded = candidateModel ? this.supersededModel(r.id, candidateModel) : null;
      const reason = opts?.excludeRoute === r.id ? 'excluded'
        : r.state !== 'verified' ? r.state : r.cooldownUntil ? 'cooldown' : quota !== null && quota <= 0 ? 'quota'
        : !caps.modes.includes(mode as 'advice' | 'edit') ? 'mode'
        : mode === 'edit' && shell && !caps.supportsShellInEdit ? 'no_shell' : !allowed.includes(r.billing) ? 'cost'
        : r.billing === 'paid' && !spendFields ? 'spend_fields' : r.billing === 'paid' && diffContext ? 'ctx_diff'
        : !profile ? 'no_profile' : superseded ? 'superseded' : promptChars > caps.maxPromptChars ? 'prompt_size'
        : toolset && !toolset.routes.includes(r.id) ? 'no_tool' : null;
      if (reason) { skipped.push(`${r.short}:${reason}`); continue; }
      const recent = this.db.prepare(`SELECT status FROM jobs WHERE route=? AND status IN ('completed','failed','needs_review') ${intent ? 'AND req_intent=?' : ''} ORDER BY seq DESC LIMIT 50`)
        .all(...[r.id, ...(intent ? [intent] : [])]) as Json[];
      const profileOpts = storedProfile?.native_options ? JSON.parse(storedProfile.native_options) as Json : {};
      const est = adapter(r.id)?.estimatedCost?.(candidateModel, candidateEffort, promptChars, {
        ...profileOpts, ...input, home: this.home, ...(this.validationOptions?.openaiHelper ? { openaiHelper: this.validationOptions.openaiHelper } : {}), ...(toolset ? { toolset } : {}),
      });
      eligible.push({
        ...r,
        lowQuota: quota !== null && quota <= 15 ? 1 : 0,
        priority: Number(profile!.priority ?? 0),
        allowance: classifyAllowance(this.usageFor(r.id)),
        workspaceMismatch: needsWorkspaceRead ? (caps.hasWorkspaceReadTools ? 0 : 1) : 0,
        expectedCost: est?.expectedUsd ?? Infinity,
        resolvedModel: candidateModel,
        resolvedEffort: candidateEffort,
        success: recent.length ? recent.filter(j => j.status === 'completed').length / recent.length : 0,
        order,
      });
    }
    return { eligible, skipped, callerFamily, needsWorkspaceRead, profileIntent, profileEff, promptChars, toolset };
  }

  private pickRouteByPolicy(actor: Actor, input: Json, mode: string, intent: string | null, eff: string | null,
    observe: (candidates: readonly OutcomeCandidate[]) => void,
    selection?: ReturnType<typeof inferSelection>, opts?: { excludeRoute?: string }): {
    route: string; considered: string[]; allowance?: Record<string, string>; allowanceDecided?: true;
    withoutAllowance?: string; workspaceReadPreferred?: true; costTiebreak?: true;
  } {
    const { eligible, skipped, callerFamily, needsWorkspaceRead } = this.evaluateRouteCandidates(actor, input, mode, intent, eff, selection, opts);
    observe(eligible);
    if (!eligible.length) fail('NO_ELIGIBLE_ROUTE', 400, `no route can take this job: ${skipped.join(' ')}`);
    const rank: Record<string, number> = { local: 0, sub: 1, paid: 2 };
    const effectiveIntent = selection?.intent ?? intent;
    const otherFamily = (r: typeof eligible[number]) => effectiveIntent === 'review' && callerFamily !== null && r.family !== callerFamily ? 0 : 1;
    const idle = (r: typeof eligible[number]) => r.running < r.limit && r.queued === 0 ? 0 : 1;
    // Allowance only reorders routes of the same billing class (the comparable-cost band) after load, workspace read match, and priority.
    const aheadBase = (a: typeof eligible[number], b: typeof eligible[number]) =>
      a.lowQuota - b.lowQuota || rank[a.billing] - rank[b.billing] || otherFamily(a) - otherFamily(b) || idle(a) - idle(b) || b.priority - a.priority;
    const ahead = (a: typeof eligible[number], b: typeof eligible[number]) => aheadBase(a, b) || a.workspaceMismatch - b.workspaceMismatch;
    const restNoCost = (a: typeof eligible[number], b: typeof eligible[number]) => b.success - a.success || a.order - b.order;
    const rest = (a: typeof eligible[number], b: typeof eligible[number]) =>
      b.success - a.success || (a.billing === 'paid' && b.billing === 'paid' ? a.expectedCost - b.expectedCost : 0) || a.order - b.order;
    const withoutWorkspace = [...eligible].sort((a, b) => aheadBase(a, b) || allowanceRank(a.allowance.cls) - allowanceRank(b.allowance.cls) || rest(a, b))[0];
    const withoutAllowance = [...eligible].sort((a, b) => ahead(a, b) || rest(a, b))[0];
    const withoutCost = [...eligible].sort((a, b) => ahead(a, b) || allowanceRank(a.allowance.cls) - allowanceRank(b.allowance.cls) || restNoCost(a, b))[0];
    eligible.sort((a, b) => ahead(a, b) || allowanceRank(a.allowance.cls) - allowanceRank(b.allowance.cls) || rest(a, b));
    const labels = Object.fromEntries(eligible.filter(r => r.allowance.cls !== 'neutral').map(r => [r.id, allowanceLabel(r.allowance)]));
    return {
      route: eligible[0].id,
      considered: eligible.map(r => r.id),
      withoutAllowance: withoutAllowance.id,
      ...(Object.keys(labels).length ? { allowance: labels } : {}),
      ...(withoutAllowance.id !== eligible[0].id ? { allowanceDecided: true as const } : {}),
      ...(needsWorkspaceRead && withoutWorkspace.id !== eligible[0].id && eligible[0].workspaceMismatch === 0 ? { workspaceReadPreferred: true as const } : {}),
      ...(withoutCost.id !== eligible[0].id ? { costTiebreak: true as const } : {}),
    };
  }

  /** Read-only dry-run of selection, routing, model/effort resolution, cost comparison, and API budget check. */
  planRoute(actor: Actor, input: Json): Json {
    const callerIntent = input.intent ?? null, callerEff = input.eff ?? null;
    const mode = input.mode ?? (callerIntent === 'edit' ? 'edit' : 'advice');
    const selection = inferSelection({
      intent: callerIntent, eff: callerEff, mode, trigger: undefined,
      prompt: typeof input.prompt === 'string' ? input.prompt : '',
      contextRefs: Array.isArray(input.context_refs) ? input.context_refs.filter((ref: unknown): ref is string => typeof ref === 'string') : [],
    });
    const requiresProfile = selection.source !== 'inferred';
    const shared = mode === 'edit' && typeof input.check === 'string';
    const workerMode = shared ? 'advice' : mode;
    const profileIntent = shared && selection.intent === 'edit' ? 'code' : selection.intent;
    const profileSelection = shared ? { ...selection, intent: profileIntent } : selection;
    const requestedRoute = input.route ?? DEFAULT_ROUTE;
    const info = this.evaluateRouteCandidates(actor, input, workerMode, requiresProfile ? profileIntent : null, requiresProfile ? selection.eff : null, profileSelection);
    let pickedRoute: string | null = null;
    let pickError: string | null = null;
    let autoMeta: Json | null = null;
    if (requestedRoute === 'auto') {
      try {
        const p = this.pickRoute(actor, input, workerMode, requiresProfile ? profileIntent : null, requiresProfile ? selection.eff : null, profileSelection);
        pickedRoute = p.route;
        autoMeta = p;
      } catch (e) { pickError = String((e as Error)?.message ?? e); }
    } else {
      const target = adapter(requestedRoute) ?? allAdapters().find(a => a.capabilities.short === requestedRoute);
      pickedRoute = target?.capabilities.id ?? null;
      if (!pickedRoute) pickError = `unknown route ${requestedRoute}`;
    }
    let resolved: Json | null = null;
    let budgetError: string | null = null;
    let costComparison: ReturnType<typeof compareCostEfficiency> = [];
    if (pickedRoute) {
      const prof = this.db.prepare('SELECT * FROM platform_profiles WHERE adapter_id=? AND intent=? AND eff=? AND enabled=1')
        .get(pickedRoute, profileIntent, selection.eff) as Json | undefined;
      const cfg = this.resolveJobConfig(input, pickedRoute, prof, profileIntent, selection.eff);
      const effUsed = adapter(pickedRoute)?.effectiveEffort?.(String(cfg.effective.task ?? selection.intent), cfg.effort ?? selection.eff, this.home) ?? cfg.effort;
      const est = adapter(pickedRoute)?.estimatedCost?.(cfg.model, effUsed ?? null, info.promptChars, {
        ...input, home: this.home, ...(this.validationOptions?.openaiHelper ? { openaiHelper: this.validationOptions.openaiHelper } : {}), ...(info.toolset ? { toolset: info.toolset } : {}),
      }) ?? null;
      resolved = { route: pickedRoute, model: cfg.model, effort: effUsed ?? null, estimated_cost: est, error: cfg.error ?? null };
      if (adapter(pickedRoute)?.checkBudget && input.max_cost_usd !== undefined) {
        try {
          adapter(pickedRoute)!.checkBudget!({
            model: cfg.model, effort: effUsed ?? null, promptChars: info.promptChars,
            options: { ...(info.toolset ? { toolset: info.toolset } : {}), ...(cfg.effective ?? {}) },
            input: { ...input, ...(this.validationOptions?.openaiHelper ? { openaiHelper: this.validationOptions.openaiHelper } : {}) },
            home: this.home,
          });
        } catch (e) { budgetError = String((e as Error)?.message ?? e); }
      }
      const modelsForRoute = this.routeModels(pickedRoute).filter(r => r.state !== 'retired' && !r.superseded_by && !r.hidden);
      const comparisonInput: Array<{ model: string; effort: string }> = [];
      for (const m of modelsForRoute) {
        if (!modelPricing(m.model)) continue;
        for (const e of (Array.isArray(m.efforts) ? m.efforts : []) as string[]) {
          if (e === 'low' || e === 'medium' || e === 'high' || e === 'max') comparisonInput.push({ model: m.model, effort: e });
        }
      }
      if (comparisonInput.length) costComparison = compareCostEfficiency(comparisonInput, info.promptChars).slice(0, 12);
    }
    return {
      selection,
      requested_route: requestedRoute,
      picked_route: pickedRoute,
      pick_error: pickError,
      auto: autoMeta,
      resolved,
      budget_error: budgetError,
      eligible: info.eligible.map(e => ({
        route: e.id, model: e.resolvedModel, effort: e.resolvedEffort,
        expected_usd: Number.isFinite(e.expectedCost) ? e.expectedCost : null,
        allowance: e.allowance.cls, workspace_read: e.workspaceMismatch === 0,
      })),
      skipped: info.skipped,
      cost_comparison: costComparison,
    };
  }
  /** Prober: a job's route, status and error. */
  jobState(id: string): Json | undefined { return this.db.prepare('SELECT route,status,error FROM jobs WHERE id=?').get(id) as Json | undefined; }

  // ---- platforms (fabric Stage 2b) ------------------------------------------
  /** Adds missing profiles and upgrades unpinned rows only within a versioned line or from a declared old seed. */
  seedProfiles(route?: string): void {
    const insert = this.db.prepare(`INSERT OR IGNORE INTO platform_profiles(adapter_id,intent,eff,native_model,native_effort,native_options,updated_at) VALUES(?,?,?,?,?,?,?)`);
    const find = this.db.prepare(`SELECT native_model,native_effort,tracks_latest FROM platform_profiles WHERE adapter_id=? AND intent=? AND eff=?`);
    const upgrade = this.db.prepare(`UPDATE platform_profiles SET native_model=?,native_effort=?,updated_at=?
      WHERE adapter_id=? AND intent=? AND eff=? AND tracks_latest=1 AND native_model IS ? AND native_effort IS ?`);
    const older = (before: unknown, after: unknown): boolean => {
      if (typeof before !== 'string' || typeof after !== 'string') return false;
      const a = parseModelVersion(before), b = parseModelVersion(after);
      return !!a && !!b && a.line === b.line && compareVersionParts(b.parts, a.parts) > 0;
    };
    const at = now();
    this.transaction(() => {
      for (const platform of allAdapters()) {
        if (route !== undefined && platform.capabilities.id !== route) continue;
        for (const p of platform.profiles) {
          const id = platform.capabilities.id;
          const row = find.get(id, p.intent, p.eff) as Json | undefined;
          if (row?.tracks_latest === 1) {
            if (p.model !== null) {
              const previous = [...(p.replaces ? [p.replaces] : []), ...(p.previousSeeds ?? [])];
              const wasSeed = previous.some(seed => row.native_model === seed.native_model && row.native_effort === seed.native_effort);
              if (older(row.native_model, p.model) || wasSeed)
                upgrade.run(p.model, p.effort, at, id, p.intent, p.eff, row.native_model, row.native_effort);
            } else if (typeof row.native_model === 'string') {
              const newer = this.supersededModel(id, row.native_model);
              if (newer) upgrade.run(newer, p.effort, at, id, p.intent, p.eff, row.native_model, row.native_effort);
            }
          }
          insert.run(id, p.intent, p.eff, p.model, p.effort, json(p.options ?? {}), at);
        }
      }
    });
  }

  /** Operator CLI only: pin a profile, or explicitly resume following the current maintained seed. */
  pinProfile(route: string, intent: string, eff: string, model?: string, unpin = false): Json {
    const platform = allAdapters().find(candidate => candidate.capabilities.id === route);
    const seed = platform?.profiles.find(candidate => candidate.intent === intent && candidate.eff === eff);
    if (!platform || !seed) fail('INVALID_INPUT', 400, 'unknown route, intent or effort');
    if (model !== undefined && (typeof model !== 'string' || !model.trim() || model !== model.trim()))
      fail('INVALID_INPUT', 400, 'model must be a nonempty model identifier');
    if (unpin && model !== undefined) fail('INVALID_INPUT', 400, '--model and --unpin cannot be combined');
    const at = now();
    if (unpin) {
      this.db.prepare(`UPDATE platform_profiles SET tracks_latest=1,native_model=?,native_effort=?,updated_at=?
        WHERE adapter_id=? AND intent=? AND eff=?`).run(seed!.model, seed!.effort, at, route, intent, eff);
    } else if (platform?.selectModel && seed) {
      const current = this.db.prepare('SELECT * FROM platform_profiles WHERE adapter_id=? AND intent=? AND eff=?')
        .get(route, intent, eff) as Json | undefined;
      if (model !== undefined || current?.tracks_latest === 1) {
        const follows = current?.tracks_latest === 1;
        const state = this.platformState(route);
        const choice = platform.selectModel({
          intent: seed.intent, eff: seed.eff, tracksLatest: follows, allowPremium: seed.eff === 'max',
          model: model ?? (follows ? seed.model : current?.native_model ?? seed.model),
          effort: follows ? seed.effort : current?.native_effort ?? seed.effort,
          explicitModel: model !== undefined, explicitEffort: false,
        }, state?.probe_state === 'verified' ? state.bin_version ?? null : null);
        if (choice.error !== undefined) return fail('INVALID_INPUT', 400, choice.error);
        if (choice.model === null)
          return fail('INVALID_INPUT', 400, 'No catalog model to pin; specify a model or refresh the CLI inventory');
        this.db.prepare(`UPDATE platform_profiles SET tracks_latest=0,native_model=?,native_effort=?,updated_at=?
          WHERE adapter_id=? AND intent=? AND eff=?`).run(choice.model, choice.effort, at, route, intent, eff);
      }
    } else if (model !== undefined) {
      this.db.prepare(`UPDATE platform_profiles SET tracks_latest=0,native_model=?,updated_at=?
        WHERE adapter_id=? AND intent=? AND eff=?`).run(model, at, route, intent, eff);
    } else {
      this.db.prepare(`UPDATE platform_profiles SET tracks_latest=0,updated_at=?
        WHERE adapter_id=? AND intent=? AND eff=?`).run(at, route, intent, eff);
    }
    return this.db.prepare(`SELECT * FROM platform_profiles WHERE adapter_id=? AND intent=? AND eff=?`).get(route, intent, eff) as Json;
  }

  /** A successful provider result is stronger evidence than a subsequent metadata-only observation. */
  markModelValidated(route: string, model: string): void {
    this.db.prepare(`UPDATE route_models SET state='validated',
      notes=CASE WHEN notes LIKE 'unentitled:%' THEN NULL ELSE notes END
      WHERE route=? AND model=? AND operator_state=0 AND state<>'preferred'`).run(route, model);
  }

  /** Runtime observation that a model is not entitled on this account/plan; keeps it out of automatic selection for 24h without demoting preferred/operator rows. */
  markModelUnentitled(route: string, model: string, reason: string): void {
    if (!this.hasTable('route_models') || !model.trim()) return;
    const note = `unentitled: ${reason.slice(0, 200)}`;
    const at = now();
    const existing = this.db.prepare('SELECT operator_state, state FROM route_models WHERE route=? AND model=?').get(route, model) as Json | undefined;
    if (!existing) {
      this.db.prepare(`INSERT INTO route_models(route,model,family,efforts,state,source,first_seen_at,last_seen_at,notes)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(route, model, modelPricing(model)?.line ?? null, '[]', 'discovered', 'runtime', at, at, note);
      return;
    }
    this.db.prepare(`UPDATE route_models SET notes=?, last_seen_at=?, state='discovered'
      WHERE route=? AND model=? AND operator_state=0 AND state<>'preferred'`).run(note, at, route, model);
  }

  /** Operator CLI override for model entitlement. */
  setModelEntitlement(route: string, model: string, entitled: boolean, reason = 'operator'): void {
    if (!this.hasTable('route_models')) return;
    const at = now();
    const existing = this.db.prepare('SELECT 1 FROM route_models WHERE route=? AND model=?').get(route, model);
    if (!existing) {
      this.db.prepare(`INSERT INTO route_models(route,model,family,efforts,state,source,first_seen_at,last_seen_at,notes,operator_state)
        VALUES(?,?,?,?,?,?,?,?,?,1)`).run(route, model, modelPricing(model)?.line ?? null, '[]',
        entitled ? 'validated' : 'discovered', 'operator', at, at, entitled ? null : `unentitled: ${reason.slice(0, 200)}`);
      return;
    }
    if (entitled) {
      this.db.prepare(`UPDATE route_models SET state='validated', operator_state=1, notes=NULL WHERE route=? AND model=?`).run(route, model);
    } else {
      this.db.prepare(`UPDATE route_models SET state='discovered', operator_state=1, notes=? WHERE route=? AND model=?`)
        .run(`unentitled: ${reason.slice(0, 200)}`, route, model);
    }
  }

  /** Entitled and unentitled sets derived from route_models (no schema migration required). */
  modelEntitlements(route: string, atMs = Date.now()): { entitled: Set<string>; unentitled: Set<string> } {
    const entitled = new Set<string>(), unentitled = new Set<string>();
    if (!this.hasTable('route_models')) return { entitled, unentitled };
    const rows = this.db.prepare('SELECT model, family, state, notes, operator_state, last_seen_at FROM route_models WHERE route=?').all(route) as Json[];
    for (const row of rows) {
      const note = typeof row.notes === 'string' ? row.notes : '';
      if (note.startsWith('unentitled:')) {
        if (row.operator_state === 0 && atMs - Date.parse(String(row.last_seen_at)) > 24 * 3600_000) continue;
        unentitled.add(row.model);
      } else if (row.state === 'validated' || row.state === 'preferred') {
        entitled.add(row.model);
        if (typeof row.family === 'string' && row.family) entitled.add(row.family);
      }
    }
    return { entitled, unentitled };
  }

  /** Inventory summaries are part of the persisted route status, not provider/account requests. */
  recordDiscoverySummary(route: string, summary: string): void {
    this.db.prepare('UPDATE platform_state SET reason=? WHERE adapter_id=?').run(summary, route);
  }
  /**
   * Upserts one successful metadata snapshot. Catalog and registry sources are complete by convention;
   * adapters can explicitly supply completeSources, including [] when optional metadata was absent.
   */
  recordDiscovery(route: string, rows: import('./adapters/types.ts').ModelDiscoveries): void {
    const at = now();
    this.db.exec('SAVEPOINT model_discovery');
    try {
      const seen = new Set<string>();
      const upsert = this.db.prepare(`INSERT INTO route_models
        (route,model,family,efforts,state,source,first_seen_at,last_seen_at)
        VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(route,model) DO UPDATE SET
          family=COALESCE(excluded.family,route_models.family),
          efforts=CASE WHEN ? THEN excluded.efforts ELSE route_models.efforts END,
          state=CASE WHEN route_models.operator_state=1 OR route_models.state='preferred'
            OR (route_models.state='validated' AND excluded.state IN ('discovered','verified'))
            THEN route_models.state ELSE excluded.state END,
          source=excluded.source,last_seen_at=excluded.last_seen_at,miss_count=0`);
      // Optional metadata is initialized on the first snapshot that supplies it.
      // Older databases remain readable without rewriting their existing inventory.
      const upsertTiers = rows.some(row => row.tiers !== undefined) ? (() => {
        this.db.exec(`CREATE TABLE IF NOT EXISTS route_model_tiers (
          route TEXT NOT NULL, model TEXT NOT NULL, tiers TEXT NOT NULL,
          PRIMARY KEY (route, model),
          FOREIGN KEY (route, model) REFERENCES route_models(route, model) ON DELETE CASCADE
        )`);
        return this.db.prepare(`INSERT INTO route_model_tiers(route,model,tiers) VALUES(?,?,?)
          ON CONFLICT(route,model) DO UPDATE SET tiers=excluded.tiers`);
      })() : undefined;
      for (const row of rows) {
        if (!row.model?.trim() || !row.source?.trim()
          || !['discovered', 'verified', 'validated', 'preferred', 'retired'].includes(row.state ?? 'discovered'))
          fail('INVALID_INPUT', 400, 'invalid model discovery row');
        const efforts = [...new Set(row.efforts ?? [])];
        if (!efforts.every(effort => typeof effort === 'string')) fail('INVALID_INPUT', 400, 'model efforts must be strings');
        seen.add(row.model);
        upsert.run(route, row.model, row.family ?? null, JSON.stringify(efforts), row.state ?? 'discovered',
          row.hidden ? `${row.source}:hidden` : row.source, at, at, row.efforts === undefined ? 0 : 1);
        if (row.tiers !== undefined) {
          if (!Array.isArray(row.tiers) || !row.tiers.every(tier => typeof tier === 'string' && tier.trim()))
            fail('INVALID_INPUT', 400, 'model tiers must be nonempty strings');
          upsertTiers!.run(route, row.model, JSON.stringify([...new Set(row.tiers)]));
        }
      }
      const existing = this.db.prepare('SELECT model,source FROM route_models WHERE route=?').all(route) as Json[];
      const complete = new Set(rows.completeSources
        ?? existing.map(row => row.source).filter(source => source === 'catalog' || source === 'registry'));
      const miss = this.db.prepare(`UPDATE route_models SET miss_count=miss_count+1,
        state=CASE WHEN miss_count+1>=2 AND operator_state=0 AND state<>'preferred' THEN 'retired' ELSE state END
        WHERE route=? AND model=?`);
      for (const row of existing) if (complete.has(row.source) && !seen.has(row.model)) miss.run(route, row.model);
      this.db.prepare(`INSERT INTO model_discovery_state(route,last_attempt_at,error) VALUES(?,?,NULL)
        ON CONFLICT(route) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,error=NULL`).run(route, at);
      this.db.exec('RELEASE model_discovery');
    } catch (error) {
      this.db.exec('ROLLBACK TO model_discovery');
      this.db.exec('RELEASE model_discovery');
      throw error;
    }
  }
  recordDiscoveryFailure(route: string, error: string): void {
    this.db.prepare(`INSERT INTO model_discovery_state(route,last_attempt_at,error) VALUES(?,?,?)
      ON CONFLICT(route) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,error=excluded.error`)
      .run(route, now(), error.slice(0, 1000));
  }
  modelDiscoveryState(route: string): Json | undefined {
    return this.db.prepare('SELECT * FROM model_discovery_state WHERE route=?').get(route) as Json | undefined;
  }
  private hasTable(name: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name);
  }
  private routeModelsRaw(route?: string): Json[] {
    if (!this.hasTable('route_models')) return [];
    const hasTiers = this.hasTable('route_model_tiers');
    const inventory = hasTiers
      ? 'SELECT m.*, t.tiers FROM route_models m LEFT JOIN route_model_tiers t ON t.route=m.route AND t.model=m.model'
      : 'SELECT m.* FROM route_models m';
    const rows = (route === undefined
      ? this.db.prepare(`${inventory} ORDER BY m.route,m.model`).all()
      : this.db.prepare(`${inventory} WHERE m.route=? ORDER BY m.model`).all(route)) as Json[];
    return rows.map(({ tiers, ...row }) => {
      const hidden = row.source.endsWith(':hidden');
      return { ...row, source: hidden ? row.source.slice(0, -':hidden'.length) : row.source, hidden,
        efforts: JSON.parse(row.efforts), ...(tiers == null ? {} : { tiers: JSON.parse(tiers) }) };
    });
  }
  private activeModelsFor(route: string, rawRows?: Json[]): Set<string> {
    const rows = (rawRows ?? this.routeModelsRaw(route)).filter(row => row.route === route);
    const active = new Set<string>(
      rows.filter(row => row.state !== 'retired' && !row.hidden).map(row => String(row.model)),
    );
    const excluded = new Set<string>(
      rows.filter(row => row.state === 'retired' || row.hidden).map(row => String(row.model)),
    );
    const platform = adapter(route);
    if (platform?.activeModels) {
      try {
        for (const m of platform.activeModels({ home: this.home, options: this.validationOptions })) {
          if (!excluded.has(m)) active.add(m);
        }
      } catch { /* optional registry */ }
    }
    return active;
  }
  /** Returns the strictly newer active model ID in the same versioned line on `route`, or null if current/unversioned. */
  supersededModel(route: string, model: string): string | null {
    if (!model || !parseModelVersion(model)) return null;
    return supersededBy(model, this.activeModelsFor(route));
  }
  /** Enabled profiles that do not resolve to a superseded model. */
  routeProfiles(route?: string): Json[] {
    const rows = (route === undefined
      ? this.db.prepare('SELECT * FROM platform_profiles WHERE enabled=1 ORDER BY adapter_id,intent,eff').all()
      : this.db.prepare('SELECT * FROM platform_profiles WHERE adapter_id=? AND enabled=1 ORDER BY intent,eff').all(route)) as Json[];
    return rows.filter(row => typeof row.native_model !== 'string' || !this.supersededModel(row.adapter_id, row.native_model));
  }
  routeModels(route?: string): Json[] {
    const rows = this.routeModelsRaw(route);
    const activeByRoute = new Map<string, Set<string>>();
    return rows.map(row => {
      let active = activeByRoute.get(row.route);
      if (!active) {
        active = this.activeModelsFor(row.route, rows);
        activeByRoute.set(row.route, active);
      }
      const sup = supersededBy(row.model, active);
      return sup ? { ...row, superseded_by: sup } : row;
    });
  }
  /** Only the local operator CLI exposes this operation; it is not a Store.call tool. */
  setModelState(route: string, model: string, state: string): void {
    if (!['discovered', 'verified', 'validated', 'preferred', 'retired'].includes(state))
      fail('INVALID_INPUT', 400, 'state must be discovered, verified, validated, preferred or retired');
    const result = this.db.prepare('UPDATE route_models SET state=?,operator_state=1 WHERE route=? AND model=?')
      .run(state, route, model);
    if (Number(result.changes) === 0) fail('NOT_FOUND', 404, 'model is not in the route inventory');
  }
  /** Version evidence is advisory: aliases and identifiers without numeric versions cannot be compared. */
  newerAvailable(route?: string): Array<{ route: string; old: string; new: string; state: string }> {
    const rows = this.routeModelsRaw(route);
    const warnings: Array<{ route: string; old: string; new: string; state: string }> = [];
    for (const preferred of rows.filter(row => row.state === 'preferred' && !row.hidden)) {
      const before = parseModelVersion(preferred.model);
      if (!before) continue;
      for (const candidate of rows) {
        if (candidate.route !== preferred.route || candidate.state === 'retired' || candidate.hidden) continue;
        const after = parseModelVersion(candidate.model);
        if (!after) continue;
        // Stored families can be broad or come from older discovery code. Compare the
        // identifier's complete version-free line, including any tier suffix.
        if (before.line === after.line && compareVersionParts(after.parts, before.parts) > 0)
          warnings.push({ route: preferred.route, old: preferred.model, new: candidate.model, state: candidate.state });
      }
    }
    return warnings;
  }

  /** Change the operator pin without treating an unprobed path as the selected program. */
  setRouteBin(capabilities: AdapterCapabilities, pin: string | null): void {
    this.transaction(() => {
      if (this.platformState(capabilities.id)?.last_update_result === 'running')
        fail('CLI_UPDATE_RUNNING', 409, 'wait for the CLI update before changing its pin');
      this.db.prepare(`INSERT INTO platform_state(adapter_id,family,billing,probe_state,bin_path,reason,last_probe_at,updated_at)
        VALUES(?,?,?,'unavailable',?,'CLI selection not yet probed',?5,?5)
        ON CONFLICT(adapter_id) DO UPDATE SET bin_path=excluded.bin_path,
        bin_selected_path=NULL, bin_version=NULL, bin_source=NULL, probe_state=excluded.probe_state,
        reason=excluded.reason, updated_at=excluded.updated_at
        WHERE platform_state.bin_path IS NOT excluded.bin_path`)
        .run(capabilities.id, capabilities.family, capabilities.billing, pin, now());
    });
  }

  setCliAutoUpdate(capabilities: AdapterCapabilities, enabled: boolean): void {
    this.db.prepare(`INSERT INTO platform_state(adapter_id,family,billing,probe_state,auto_update,last_probe_at,updated_at)
      VALUES(?1,?2,?3,'unavailable',?4,?5,?5) ON CONFLICT(adapter_id) DO UPDATE SET
      auto_update=excluded.auto_update, updated_at=excluded.updated_at`)
      .run(capabilities.id, capabilities.family, capabilities.billing, Number(enabled), now());
  }

  setSdkAutoUpdate(capabilities: AdapterCapabilities, enabled: boolean): void {
    this.db.prepare(`INSERT INTO platform_state(adapter_id,family,billing,probe_state,sdk_auto_update,last_probe_at,updated_at)
      VALUES(?1,?2,?3,'unavailable',?4,?5,?5) ON CONFLICT(adapter_id) DO UPDATE SET
      sdk_auto_update=excluded.sdk_auto_update, updated_at=excluded.updated_at`)
      .run(capabilities.id, capabilities.family, capabilities.billing, Number(enabled), now());
  }

  recordSdkSnapshot(route: string, snapshot: import('./adapters/types.ts').SdkSnapshot, epoch: string | null): boolean {
    return !!this.db.prepare(`UPDATE platform_state SET sdk_version=?, sdk_latest=?, updated_at=?
      WHERE adapter_id=? AND sdk_last_update_result IS NOT 'running' AND sdk_last_update_at IS ?`)
      .run(snapshot.installed, snapshot.latest, now(), route, epoch).changes;
  }

  /** Share the existing maintenance gate with CLI updates and job claims, but keep SDK history separate. */
  beginSdkUpdate(route: string, version: string, epoch: string | null, manual: boolean):
    { started: string; priorGate: string | null } | null {
    return this.transaction(() => {
      const priorGate = this.platformState(route)?.last_update_result ?? null;
      const time = Date.now(), started = new Date(time).toISOString();
      const cutoff = (hours: number) => new Date(time - hours * 60 * 60 * 1000).toISOString();
      const changed = this.db.prepare(`UPDATE platform_state SET
        sdk_last_update_at=?, sdk_last_update_result='running', sdk_last_update_version=?, last_update_result='running', updated_at=?
        WHERE adapter_id=? AND (?=1 OR sdk_auto_update=1)
        AND sdk_latest=? AND sdk_last_update_at IS ? AND sdk_last_update_result IS NOT 'running'
        AND last_update_result IS NOT 'running'
        AND (sdk_last_update_at IS NULL OR sdk_last_update_at <= CASE
          WHEN sdk_last_update_result='success' THEN ? ELSE ? END)
        AND NOT EXISTS (SELECT 1 FROM jobs WHERE route=? AND status IN ('running','queued'))`)
        .run(started, version, started, route, Number(manual), version, epoch, cutoff(6), cutoff(24), route);
      return changed.changes ? { started, priorGate } : null;
    });
  }

  finishSdkUpdate(route: string, lease: { started: string; priorGate: string | null }, version: string, result: string): boolean {
    const at = now();
    return !!this.db.prepare(`UPDATE platform_state SET sdk_last_update_at=?, sdk_last_update_result=?,
      sdk_last_update_version=?, sdk_version=CASE WHEN ?='success' THEN ? ELSE sdk_version END,
      last_update_result=?, updated_at=?
      WHERE adapter_id=? AND sdk_last_update_at=? AND sdk_last_update_result='running' AND last_update_result='running'`)
      .run(at, result, version, result, version, lease.priorGate, at, route, lease.started).changes;
  }

  /** Reserve the route atomically against job claims, other updaters and pin changes. */
  beginCliUpdate(route: string, version: string, epoch: string | null, manual: boolean): string | null {
    const time = Date.now(), started = new Date(time).toISOString();
    const cutoff = (hours: number) => new Date(time - hours * 60 * 60 * 1000).toISOString();
    const changed = this.db.prepare(`UPDATE platform_state SET
      last_update_at=?, last_update_result='running', last_update_version=?, updated_at=?
      WHERE adapter_id=? AND bin_path IS NULL AND (?=1 OR auto_update=1)
      AND last_update_at IS ? AND last_update_result IS NOT 'running'
      AND (last_update_at IS NULL OR last_update_at <= CASE
        WHEN last_update_result='success' THEN ? ELSE ? END)
      AND NOT EXISTS (SELECT 1 FROM jobs WHERE route=? AND status IN ('running','queued'))`)
      .run(started, version, started, route, Number(manual), epoch, cutoff(6), cutoff(24), route);
    return changed.changes ? started : null;
  }

  /** Publish the post-update probe and event before releasing the reservation to the runner. */
  finishCliUpdate(capabilities: AdapterCapabilities, started: string, target: string, version: string,
    result: string, logPath: string, probe: ProbeResult, cli: import('./adapters/types.ts').CliFreshness): void {
    this.transaction(() => {
      const at = now(), route = capabilities.id;
      const changed = this.db.prepare(`UPDATE platform_state SET last_update_at=?, last_update_result=?,
        last_update_version=?, updated_at=? WHERE adapter_id=? AND last_update_at=? AND last_update_result='running'`)
        .run(at, result, version, at, route, started);
      if (!changed.changes) return;
      this.recordProbe(capabilities, probe, { ...cli, updateEpoch: at });
      this.db.prepare(`INSERT INTO cli_update_events(route,started_at,finished_at,target_version,version,result,log_path)
        VALUES(?,?,?,?,?,?,?)`).run(route, started, at, target, version, result, logPath);
    });
  }

  /** Records a probe unless its pin or update epoch changed while the checks were in flight. */
  recordProbe(capabilities: AdapterCapabilities, result: ProbeResult, cli?: import('./adapters/types.ts').CliFreshness): void {
    const previous = this.platformState(capabilities.id), at = now();
    let reason = result.reason ?? null;
    if (previous?.binary_sha256 && result.binarySha256 && previous.binary_sha256 !== result.binarySha256)
      reason = `CLI changed (${previous.cli_version ?? '?'} -> ${result.cliVersion ?? '?'}); ${reason ?? 'contract checks pass'}`;
    this.db.prepare(`INSERT INTO platform_state(adapter_id,family,billing,probe_state,binary_sha256,cli_version,help_sha256,reason,last_probe_at,updated_at,
      bin_selected_path,bin_version,bin_source,bin_installed,bin_upstream)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(adapter_id) DO UPDATE SET family=excluded.family, billing=excluded.billing, probe_state=excluded.probe_state,
      binary_sha256=excluded.binary_sha256, cli_version=excluded.cli_version, help_sha256=excluded.help_sha256, reason=excluded.reason,
      last_probe_at=excluded.last_probe_at, updated_at=excluded.updated_at,
      bin_selected_path=excluded.bin_selected_path, bin_version=excluded.bin_version, bin_source=excluded.bin_source,
      bin_installed=excluded.bin_installed, bin_upstream=excluded.bin_upstream
      WHERE ?=0 OR (platform_state.bin_path IS ? AND platform_state.last_update_result IS NOT 'running'
        AND (?=0 OR platform_state.last_update_at IS ?))`)
      .run(capabilities.id, capabilities.family, capabilities.billing, result.state, result.binarySha256 ?? null, result.cliVersion ?? null,
        result.helpSha256 ?? null, reason, at, at, result.binary?.path ?? null, result.binary?.version ?? null, result.binary?.source ?? null,
        cli ? JSON.stringify(cli.installed) : null, cli?.upstream ? JSON.stringify(cli.upstream) : null, cli ? 1 : 0, cli?.pin ?? null,
        cli?.updateEpoch !== undefined ? 1 : 0, cli?.updateEpoch ?? null);
  }
  platformState(id: string): Json | undefined { return this.db.prepare('SELECT * FROM platform_state WHERE adapter_id=?').get(id) as Json | undefined; }
  platformStates(): Json[] { return this.db.prepare('SELECT * FROM platform_state ORDER BY adapter_id').all() as Json[]; }

  // ---- Running limits (operator-set parallelism) --------------------------------
  /** The highest global limit an operator may set. */
  private static readonly GLOBAL_LIMIT_CEILING = 16;
  /** A route's default and hard ceiling for jobs running at once, from its adapter (undefined: unknown route). */
  private routeBounds(route: string): { default: number; ceiling: number } | undefined {
    const caps = adapter(route)?.capabilities;
    return caps ? { default: caps.maxConcurrent, ceiling: Math.max(caps.maxConcurrent, caps.maxConcurrentCeiling ?? caps.maxConcurrent) } : undefined;
  }
  /** The operator's per-route override (null: the adapter default applies). */
  routeLimitOverride(route: string): number | null {
    const row = this.db.prepare('SELECT max_running FROM platform_state WHERE adapter_id=?').get(route) as Json | undefined;
    return row?.max_running == null ? null : Number(row.max_running);
  }
  /** Sets a route's override (1 to the adapter's ceiling), or clears it with null. A route never probed gets a placeholder state row. */
  setRouteLimit(route: string, max: number | null): void {
    const bounds = this.routeBounds(route) ?? fail('INVALID_INPUT', 400, `unknown route: ${route}`);
    if (max !== null && (!Number.isInteger(max) || max < 1 || max > bounds.ceiling)) fail('INVALID_INPUT', 400, `max for ${route} must be 1-${bounds.ceiling}`);
    const at = now();
    if (!this.platformState(route)) {
      if (max === null) return;
      const caps = adapter(route)!.capabilities;
      this.db.prepare(`INSERT INTO platform_state(adapter_id,family,billing,probe_state,reason,last_probe_at,updated_at) VALUES(?,?,?,'unavailable','not probed yet',?,?)`)
        .run(route, caps.family, caps.billing, at, at);
    }
    this.db.prepare('UPDATE platform_state SET max_running=?, updated_at=? WHERE adapter_id=?').run(max, at, route);
  }
  /** The operator's global limit (null: the runner option or 3 applies). */
  globalLimitSetting(): number | null {
    const row = this.db.prepare('SELECT global_max_running FROM service_settings WHERE id=1').get() as Json | undefined;
    return row?.global_max_running == null ? null : Number(row.global_max_running);
  }
  /** Sets the global limit (1-16), or clears it with null. */
  setGlobalLimit(max: number | null): void {
    if (max !== null && (!Number.isInteger(max) || max < 1 || max > Store.GLOBAL_LIMIT_CEILING)) fail('INVALID_INPUT', 400, `global must be 1-${Store.GLOBAL_LIMIT_CEILING}`);
    this.db.prepare('INSERT INTO service_settings(id, global_max_running) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET global_max_running=excluded.global_max_running').run(max);
  }
  /** Validates the whole operator request before applying any part, then commits it atomically. */
  setLimits(changes: { route?: { route: string; max: number | null }; global?: number | null; clear?: boolean }): void {
    if (changes.clear && (changes.route !== undefined || changes.global !== undefined))
      fail('INVALID_INPUT', 400, 'clear cannot be combined with limit changes');
    if (changes.route) {
      const { route, max } = changes.route;
      const bounds = this.routeBounds(route) ?? fail('INVALID_INPUT', 400, `unknown route: ${route}`);
      if (max !== null && (!Number.isInteger(max) || max < 1 || max > bounds.ceiling))
        fail('INVALID_INPUT', 400, `max for ${route} must be 1-${bounds.ceiling}`);
    }
    if (changes.global !== undefined && changes.global !== null
      && (!Number.isInteger(changes.global) || changes.global < 1 || changes.global > Store.GLOBAL_LIMIT_CEILING))
      fail('INVALID_INPUT', 400, `global must be 1-${Store.GLOBAL_LIMIT_CEILING}`);
    // A savepoint is also safe when an operator request already has a surrounding transaction.
    this.db.exec('SAVEPOINT operator_running_limits');
    try {
      if (changes.clear) this.clearLimits();
      if (changes.route) this.setRouteLimit(changes.route.route, changes.route.max);
      if (changes.global !== undefined) this.setGlobalLimit(changes.global);
      this.db.exec('RELEASE SAVEPOINT operator_running_limits');
    } catch (error) {
      this.db.exec('ROLLBACK TO SAVEPOINT operator_running_limits');
      this.db.exec('RELEASE SAVEPOINT operator_running_limits');
      throw error;
    }
  }
  /** Clears every route override and the global setting. */
  clearLimits(): void {
    this.db.prepare('UPDATE platform_state SET max_running=NULL, updated_at=? WHERE max_running IS NOT NULL').run(now());
    this.setGlobalLimit(null);
  }
  /**
   * The limits a claim pass uses: per route, the operator's override ?? the adapter default (a stored override above a
   * since-lowered ceiling is capped); globally, the operator's setting ?? fallbackGlobal (the runner's option) ?? 3.
   * `overrides` lists only operator-set routes; `rows` is the table `cli.ts limits` prints. Read fresh on every call.
   */
  effectiveLimits(routes: string[], fallbackGlobal?: number) {
    const stored = new Map((this.db.prepare('SELECT adapter_id, max_running FROM platform_state WHERE max_running IS NOT NULL').all() as Json[])
      .map(row => [String(row.adapter_id), Number(row.max_running)] as const));
    const rows: Array<{ route: string; default: number; override: number | null; ceiling: number; effective: number }> = [];
    const effective: Record<string, number> = {}, overrides: Record<string, number> = {};
    for (const route of routes) {
      const bounds = this.routeBounds(route);
      if (!bounds) continue;
      const raw = stored.get(route), override = raw === undefined ? null : Math.min(raw, bounds.ceiling);
      effective[route] = override ?? bounds.default;
      if (override !== null) overrides[route] = override;
      rows.push({ route, default: bounds.default, override, ceiling: bounds.ceiling, effective: effective[route] });
    }
    const globalOverride = this.globalLimitSetting(), globalDefault = fallbackGlobal ?? 3;
    return { routes: effective, overrides, rows, global: globalOverride ?? globalDefault, globalOverride, globalDefault, globalCeiling: Store.GLOBAL_LIMIT_CEILING };
  }

  // ---- AIR-T (M3a) ------------------------------------------------------------
  private airOutcome(actor: Actor, projectId: string, node: OutcomeNode, prior: Map<number, AirResult>): void {
    const value = (key: string) => {
      const item = one(node.fields[key]);
      return item && ('ref' in item ? prior.get(item.ref)?.handle : item.text);
    };
    const jobRef = text(value('j'), 'j', 256);
    const kind = text(value('v'), 'v', 32) as CallerOutcome;
    if (!CALLER_OUTCOMES.includes(kind)) fail('INVALID_INPUT', 400, 'unknown job outcome');
    const job = this.jobRecord(this.resolveId('j', jobRef));
    if (!job || job.project_id !== projectId) return fail('JOB_NOT_FOUND', 404);
    const manual = kind === 'accepted' || kind === 'rejected' || kind === 'redone';
    const parent = job.parent_job_id ? this.jobRecord(job.parent_job_id) : undefined;
    const responsible = job.created_by === actor.id || job.options?.review_for === actor.id
      || (parent?.project_id === projectId && parent.created_by === actor.id);
    if (manual && !responsible && actor.role !== 'operator') fail('OWNER_REQUIRED', 403);
    if (kind === 'redone' ? !FINISHED_JOB.includes(job.status) : job.status !== 'completed')
      fail('JOB_NOT_FINISHED', 409, 'this outcome requires a finished deliverable');
    const reason = text(node.text, 'outcome detail', 4096);
    let detail = applyEvidenceDetail(kind, reason);
    if (detail === null) return fail('INVALID_INPUT', 400, 'invalid apply or verification evidence');
    if (node.fields.replacement) {
      if (kind !== 'redone') fail('INVALID_INPUT', 400, 'replacement= is only valid for redone');
      const replacement = this.jobRecord(this.resolveId('j', text(value('replacement'), 'replacement', 256)));
      if (!replacement || replacement.project_id !== projectId) return fail('JOB_NOT_FOUND', 404);
      if (replacement.id === job.id) fail('INVALID_INPUT', 400, 'replacement must be a different job');
      detail = JSON.stringify({ reason, replacement_job_id: replacement.id });
    }
    appendOutcome(this.db, job.id, kind, detail, actor.id);
  }

  /** Several mutations in one call. Store.call() runs it in one transaction: any failing node rolls back all of them. */
  op_air_tx(actor: Actor, input: Json): Json {
    const operationId = text(input.operation_id, 'operation_id', 256);
    let packet: ReturnType<typeof parsePacket>;
    try { packet = parsePacket(text(input.packet, 'packet', MAX_TEXT)); }
    catch (error) {
      if (error instanceof AirParseError) fail(error.code, 400, `line=${error.line}${error.node !== null ? ` node=${error.node}` : ''}: ${error.message}`);
      throw error;
    }
    const located = (line: number, work: () => string | null) => {
      try { return work(); } catch (error) {
        if (error instanceof CommonsError) throw new CommonsError(error.code, `line=${line}: ${error.message}`, error.status);
        throw error;
      }
    };
    if (packet.op !== undefined && packet.op !== operationId) fail('OPERATION_ID_MISMATCH', 400, 'line=1: op= in the header differs from operation_id');
    const fromInput = located(1, () => input.project_id === undefined || input.project_id === null ? null : this.project(input.project_id).id);
    const fromHeader = located(1, () => packet.project === undefined ? null : this.project(packet.project).id);
    if (fromInput && fromHeader && fromInput !== fromHeader) fail('PROJECT_MISMATCH', 400, 'line=1: p= names a different project than project_id');
    const projectId = fromInput ?? fromHeader ?? fail('PROJECT_REQUIRED', 400, 'line=1: give project_id or p= in the header');
    this.heartbeat(actor, projectId);
    const results = new Map<number, AirResult>(), handles: Record<string, string> = {};
    for (const node of packet.nodes) {
      try {
        if (node.op === 'out') {
          this.airOutcome(actor, projectId, node, results);
          continue;
        }
        const out = this.airNode(actor, projectId, node, results);
        results.set(node.idx, out);
        if (out.handle) handles[node.idx] = out.reply ?? out.handle;
      } catch (error) {
        if (error instanceof CommonsError) throw new CommonsError(error.code, `line=${node.line} node=${node.idx}: ${error.message}`, error.status);
        throw error;
      }
    }
    // unseen: other actors' changes since this actor's read position. When there are none, the position moves past
    // this packet's own changes, so the next air_sync does not echo them back. An actor that never synced keeps no position.
    const seq = this.maxSeq(projectId), cursor = this.cursor(actor, projectId);
    const unseen = this.foreignUnseenCount(actor, projectId, cursor ?? 0);
    if (cursor !== undefined && unseen === 0) this.saveCursor(actor, projectId, seq);
    const notes = [...results.values()];
    const review = notes.flatMap(r => r.review ? [r.review] : []).join(',') || undefined, hint = notes.find(r => r.hint)?.hint;
    const wake = notes.flatMap(r => r.wake ? [r.wake] : []).join(',') || undefined;
    const reply = { op: operationId, seq, handles, unseen, inbox: this.inbox(actor, projectId).length, ...(review ? { review } : {}), ...(hint ? { hint } : {}), ...(wake ? { wake } : {}) };
    return { ...reply, air: txReply(reply) };
  }

  private airNode(actor: Actor, projectId: string, node: AirNode, results: Map<number, AirResult>): AirResult {
    const f = node.fields;
    const earlier = (item: AirItem & { ref: number }, kind?: string) => {
      const r = results.get(item.ref)!;
      if (kind && r.kind !== kind) fail('BAD_REF', 400, `#${item.ref} is ${r.kind === 'ref' ? 'a ref' : 'a ' + r.kind}, not a ${kind}`);
      return r;
    };
    /** One value: an earlier node's text or handle, or the literal text. */
    const str = (name: string): string | undefined => {
      const item = one(f[name]); if (!item) return undefined;
      return 'ref' in item ? (earlier(item).text ?? earlier(item).handle) : item.text;
    };
    /** List values: ref nodes expand to their text, entity nodes to their handle. */
    const texts = (name: string): string[] | undefined => f[name]?.map(item => 'ref' in item ? (earlier(item).text ?? earlier(item).handle) : item.text);
    /** An entity ID from #k (same kind) or a handle/UUID, required to be in this project. */
    const entity = (name: string, kind: string): string | undefined => {
      const item = one(f[name]); if (!item) return undefined;
      const id = 'ref' in item ? earlier(item, kind).id : this.resolveId(ENTITY[kind].letter, item.text);
      const row = this.db.prepare(`SELECT project_id FROM ${ENTITY[kind].table} WHERE id=?`).get(id) as Json | undefined;
      if (!row) fail(`${kind.toUpperCase()}_NOT_FOUND`, 404, `${item && 'text' in item ? item.text : '#' + (item as any).ref} is not a known ${kind}`);
      if (row!.project_id !== projectId) fail(`${kind.toUpperCase()}_NOT_IN_PROJECT`, 400, `that ${kind} belongs to another project`);
      return id;
    };
    /** The literal text of a field (int, conf and status fields never hold a #k reference). */
    const literal = (name: string): string | undefined => { const item = one(f[name]); return item && 'text' in item ? item.text : undefined; };
    const int = (name: string) => literal(name) === undefined ? undefined : Number(literal(name));
    const conf = literal('p') === undefined ? undefined : Number(literal('p'));
    const run = (method: string, input: Json, kind: string, key = kind): AirResult => {
      const result = this.apply(actor, method, { ...input, project_id: projectId });
      const id = result[key].id, handle = this.handleOf(ENTITY[kind].letter, id)!;
      // Consult notes for the reply header: a queued (or skipped) review, and the two-strike hint.
      const review = result.review ? (result.review.job ? this.handleOf('j', result.review.job)! : `skip:${result.review.skipped}`) : undefined;
      return { kind, id, handle, ...(kind === 'task' ? { reply: `${handle}@v${result.task.version}` } : {}),
        ...(review ? { review } : {}), ...(result.consult_hint ? { hint: result.consult_hint } : {}), ...(result.wake ? { wake: result.wake } : {}) };
    };
    const t = () => entity('t', 'task');
    switch (node.op) {
      case 'ref': {
        const status = str('status'), sha = str('sha');
        return { kind: 'ref', id: '', handle: '', text: node.text! + (status ? ` [${status}]` : '') + (sha ? ` sha=${sha}` : '') };
      }
      case 'tnew': return run('task_create', { title: node.text, objective: str('obj'), acceptance: texts('acc'), next_action: str('next'), review_policy: str('rev_pol') }, 'task');
      case 'tclm': return run('task_claim', { task_id: t(), version: int('v') }, 'task');
      case 'tupd': return run('task_update', { task_id: t(), version: int('v'), status: str('st'), next_action: str('next'), title: str('title'),
        objective: str('obj'), acceptance: texts('acc'), review_policy: str('rev_pol') }, 'task');
      case 'trel': return run('task_release', { task_id: t(), version: int('v') }, 'task');
      case 'dec': return run('decision_record', { summary: node.text, task_id: t(), rationale: str('why'), evidence: texts('ev'),
        supersedes: entity('sup', 'decision'), confidence: conf }, 'decision');
      case 'chk': {
        // A checkpoint fails with fail=1, or when any of its checks is a ref with status=fail ("... [fail]").
        const checks = texts('ok');
        const failed = ['1', 'yes', 'true'].includes(literal('fail') ?? '') || !!checks?.some(c => /\[fail\]$/.test(c));
        return run('project_checkpoint', { summary: node.text, task_id: t(), revision: str('rev'), branch: str('br'), checks,
          open_questions: texts('q'), artifacts: f.arts?.map(item => 'ref' in item ? earlier(item, 'artifact').id : this.resolveId('a', item.text)),
          next_action: str('next'), confidence: conf, failed }, 'checkpoint');
      }
      case 'ask': {
        const to = f.to.map(item => {
          if ('ref' in item) fail('BAD_REF', 400, 'to= names actors, not nodes');
          const name = (item as { text: string }).text;
          if (this.db.prepare('SELECT 1 FROM actors WHERE id=?').get(name)) return name;
          const rows = this.db.prepare('SELECT id FROM actors WHERE name=?').all(name) as Json[];
          if (rows.length !== 1) fail(rows.length ? 'ACTOR_AMBIGUOUS' : 'ACTOR_NOT_FOUND', rows.length ? 409 : 404, `unknown actor ${name}`);
          return rows[0].id as string;
        });
        return run('team_ask', { to, body: node.text, task_id: t(), evidence: texts('ev'), confidence: conf, wake: str('wake') }, 'message');
      }
      case 'rep': return run('team_reply', { message_id: entity('m', 'message'), body: node.text, evidence: texts('ev'), confidence: conf }, 'message');
      case 'ack': {
        const id = entity('m', 'message')!;
        this.apply(actor, 'team_ack', { message_id: id });
        return { kind: 'message', id, handle: this.handleOf('m', id)! };
      }
      case 'dopen': return run('discussion_open', { subject: str('subj'), question: node.text, task_id: t() }, 'discussion');
      case 'dpost': return run('discussion_post', { discussion_id: entity('g', 'discussion'), body: node.text, reply_to: entity('reply', 'message'),
        evidence: texts('ev'), confidence: conf }, 'message');
      case 'dclose': return run('discussion_close', { discussion_id: entity('g', 'discussion'), outcome: node.text }, 'discussion');
      case 'ropen': return run('discussion_open', { subject: str('subj'), question: node.text, task_id: t(), seats: texts('seats'), room_mode: str('mode'),
        max_rounds: int('max_r') }, 'discussion');
      case 'rstep': {
        // Reply: g7@r2(j14,j15) and, after a ";", seats skipped this round with why (arch:cooldown).
        const result = this.apply(actor, 'room_step', { project_id: projectId, discussion_id: entity('g', 'discussion'), to: texts('to'), context_refs: texts('ctx'), cwd: str('cwd'), prompt: node.text });
        const handle = this.handleOf('g', result.discussion.id)!;
        const jobs = (result.jobs as string[]).map(id => this.handleOf('j', id)!).join(',');
        return { kind: 'discussion', id: result.discussion.id, handle, reply: `${handle}@r${result.round}(${jobs}${result.skipped.length ? ';' + result.skipped.join(',') : ''})` };
      }
      case 'art': return run('artifact_submit', { name: str('name'), content: node.text, kind: str('kind') }, 'artifact');
      case 'job': {
        return run('job_submit', { prompt: node.text, task_id: t(), route: str('route'), mode: str('mode'), model: str('model'), effort: str('effort'),
          timeout_minutes: int('timeout'), task: str('task'), effort_reason: str('reason'), max_cost_usd: str('max_usd'), max_output_tokens: int('max_tok'),
          tier: str('tier'), purpose: str('purpose'), deliverable: str('deliv'), intent: str('intent'), eff: str('eff'),
          protocol: literal('proto'), context_refs: texts('ctx'), cwd: str('cwd'), cost: str('cost'), shell: str('shell'), repair: str('repair'), tools: str('tools'),
          max_turns: int('max_turns'), check: str('check') }, 'job');
      }
      case 'jcan': return run('job_cancel', { job_id: entity('j', 'job') }, 'job');
      case 'need': return fail('WORKER_ONLY', 400, 'need is for delegated workers');  // the parser refuses it first
    }
  }

  /** What changed since this actor's last read (or a compact snapshot on the first read). Advances the read position unless told not to. */
  op_air_sync(actor: Actor, input: Json): Json {
    const root = optText(input.root, 'root', 4096), noId = input.project_id === undefined || input.project_id === null;
    if (noId && !root) fail('PROJECT_REQUIRED', 400, 'give project_id or root');
    let project: Json = noId ? this.projectAtRoot(root!) : this.project(input.project_id);
    if (root && !noId && this.projectAtRoot(root).id !== project.id) fail('PROJECT_MISMATCH', 400, 'root belongs to a different project than project_id');
    const handle = this.handleOf('p', project.id) ?? project.id;
    this.heartbeat(actor, project.id);
    if (input.since_seq !== undefined && (!Number.isSafeInteger(input.since_seq) || input.since_seq < 0)) fail('INVALID_INPUT', 400, 'since_seq must be a whole number of 0 or more');
    let taskId: string | null = null;
    if (input.task_id !== undefined) { const task = this.task(input.task_id); if (task.project_id !== project.id) fail('TASK_NOT_IN_PROJECT'); taskId = task.id; }
    const saved = this.cursor(actor, project.id);
    const from: number = input.since_seq ?? saved ?? 0, to = this.maxSeq(project.id);
    // A snapshot on the first read (no saved position) or when since_seq 0 asks for one. A saved position of 0
    // (the feed was empty at the last read) means "everything since then", not another snapshot.
    const snapshot = input.since_seq === 0 || (input.since_seq === undefined && saved === undefined);
    let lines: string[], extra: Record<string, unknown> = {};
    if (snapshot) ({ lines, extra } = this.airSnapshot(actor, project, taskId));
    else {
      const events = this.db.prepare(`SELECT e.seq,e.entity_id,e.air_line FROM events e
        WHERE e.project_id=? AND e.seq>? ${taskId ? 'AND e.task_id=?' : ''}
          AND NOT ${this.ownJobArtifactEventSql(false)}
        ORDER BY e.seq`)
        .all(...[project.id, from, ...(taskId ? [taskId] : []), actor.id]) as Json[];
      const seen = new Set<string>(), latest: Json[] = [];
      for (let i = events.length - 1; i >= 0; i--) if (!seen.has(events[i].entity_id)) { seen.add(events[i].entity_id); latest.push(events[i]); }
      lines = latest.reverse().map(e => e.air_line);
    }
    // A task-scoped read saw only that task's events, so moving the project-wide position to `to` would hide every
    // other change before `to` from this actor's next project-wide read.
    if (input.advance_cursor !== false && !taskId) this.saveCursor(actor, project.id, to);
    const inbox = this.inbox(actor, project.id).length;
    if (inbox) extra.inbox = inbox;
    // The R route-status line: in every snapshot, and in a delta only when it differs from what this reader last saw.
    const routes = this.routeLine(), seenKey = `${actor.id}\0${project.id}`;
    const showRoutes = snapshot || this.seenRoutes.get(seenKey) !== routes;
    if (showRoutes && input.advance_cursor !== false) this.seenRoutes.set(seenKey, routes);
    // The X tools summary: snapshots only, and only when a shared tool manifest is configured.
    let toolsLine: string[] = [];
    if (snapshot) try { const manifest = loadManifest(this.home); if (manifest) toolsLine = [toolsSummaryLine(hubStatus(manifest, this.toolsEnv))]; }
    catch (error) { if (error instanceof CommonsError) toolsLine = [`X tools err=${error.code}`]; else throw error; }
    // The service-health warning, in every read while the watchdog reports a problem (agents tell the user).
    const health = healthLine(this.home);
    const air = [syncHeader(project, handle, from, to, extra), ...(health ? [health] : []), ...(showRoutes ? [routes] : []), ...toolsLine, ...lines,
      ...(input.include_spec === true ? ['@air1 spec', AIR_PRIMER] : [])].join('\n');
    return { air, from_seq: from, to_seq: to };
  }

  /** The event query uses alias e and binds the caller's ID to this predicate. */
  private ownJobArtifactEventSql(includeDiff: boolean): string {
    const actions = includeDiff ? "'job_context','job_output','job_diff'" : "'job_context','job_output'";
    return `(e.actor_id='agent-commons' AND e.kind='artifact' AND e.action IN (${actions}) AND EXISTS (
      SELECT 1 FROM jobs j WHERE j.project_id=e.project_id AND j.created_by=?
        AND (e.entity_id=CASE e.action
          WHEN 'job_context' THEN json_extract(j.options,'$.ctx_artifact')
          WHEN 'job_output' THEN json_extract(j.options,'$.output_artifact')
          WHEN 'job_diff' THEN json_extract(j.options,'$.diff_artifact')
        END OR (e.action='job_context' AND e.entity_id=json_extract(j.options,'$.need_ctx_artifact')))
    ))`;
  }
  /** Ignore the caller's own writes and system events emitted on behalf of their own jobs. */
  private foreignUnseenCount(actor: Actor, projectId: string, since: number): number {
    const row = this.db.prepare(`SELECT count(*) n FROM events e
      WHERE e.project_id=? AND e.seq>? AND e.actor_id<>?
        AND NOT (e.actor_id='agent-commons' AND e.kind='job' AND EXISTS (
          SELECT 1 FROM jobs j WHERE j.id=e.entity_id AND j.project_id=e.project_id AND j.created_by=?
        ))
        AND NOT ${this.ownJobArtifactEventSql(true)}`)
      .get(projectId, since, actor.id, actor.id, actor.id) as Json;
    return Number(row.n);
  }
  private cursor(actor: Actor, projectId: string): number | undefined {
    return (this.db.prepare('SELECT last_seq FROM actor_cursors WHERE actor_id=? AND project_id=?').get(actor.id, projectId) as Json | undefined)?.last_seq;
  }
  private saveCursor(actor: Actor, projectId: string, seq: number): void {
    this.db.prepare('INSERT INTO actor_cursors(actor_id,project_id,last_seq,updated_at) VALUES(?,?,?,?) ON CONFLICT(actor_id,project_id) DO UPDATE SET last_seq=excluded.last_seq, updated_at=excluded.updated_at')
      .run(actor.id, projectId, seq, now());
  }
  /** The project whose root contains this path; live projects before archived ones, then the deepest root. */
  private projectAtRoot(root: string): Json {
    const norm = (value: string) => path.resolve(value).toLowerCase(), want = norm(root);
    const rows = (this.db.prepare('SELECT * FROM projects WHERE root IS NOT NULL').all() as Json[])
      .filter(row => want === norm(row.root) || want.startsWith(norm(row.root) + path.sep))
      .sort((a, b) => (a.archived - b.archived) || (b.root.length - a.root.length));
    return rows[0] ?? fail('PROJECT_NOT_FOUND', 404, 'no project has a root containing that path');
  }

  /**
   * Full detail for up to 25 items: handles (p1 t4 d19 c42 g3 m11 j5 a8) or UUIDs, and artifact line ranges (a8:10-40,
   * a8:300-). Each item fails alone as `! <item> err=CODE`. Artifact lines are prefixed "|", or "<line>|" when grep
   * filters them. max_chars caps each field and the text shown for each artifact.
   */
  op_air_get(actor: Actor, input: Json): Json {
    this.heartbeat(actor, null);
    if (input.raw !== undefined && typeof input.raw !== 'boolean') fail('INVALID_INPUT', 400, 'raw must be a boolean');
    const raw = input.raw === true;
    const items = text(input.handles, 'handles', 4096).split(',').map(item => item.trim()).filter(Boolean);
    const countLimit = raw ? 10 : 25;
    if (!items.length || items.length > countLimit) fail('INVALID_INPUT', 400, `handles must list 1-${countLimit} items`);
    const limit = raw ? 16000 : input.max_chars ?? 16000;
    if (!Number.isInteger(limit) || limit < 20 || limit > 200000) fail('INVALID_INPUT', 400, 'max_chars must be 20-200000');
    const grep = raw ? null : optText(input.grep, 'grep', 256)?.toLowerCase() ?? null;
    const out = [`@air1 get n=${items.length}`], rawItems: Json[] = [];
    for (const item of items) {
      try {
        const recall = /^(?:(p[1-9]\d*):)?(?:\?|recall:)(.+)$/.exec(item);
        if (recall) {
          if (raw) fail('BAD_HANDLE', 400, 'raw supports only jobs and artifacts');
          const query = recall[2].trim();
          if (!query) fail('INVALID_INPUT', 400, 'recall requires a query');
          const project = recall[1] ? this.project(recall[1])
            : (this.db.prepare('SELECT * FROM projects ORDER BY updated_at DESC, id').all() as Json[])
              .find(row => !row.archived && !row.archived_at && row.status !== 'archived')
              ?? fail('PROJECT_NOT_FOUND', 404);
          const res = this.recallMemory(project.id, query, limit);
          out.push(`@air1 recall p=${this.handleOf('p', project.id) ?? project.id} q=${q(query)} hits=${res.hits}`, ...res.lines);
          continue;
        }
        if (item === 'routes') {
          if (raw) fail('BAD_HANDLE', 400, 'raw supports only jobs and artifacts');
          out.push(...this.routeAdviceLines());
          continue;
        }
        const tools = /^tools(?::(.+))?$/.exec(item);
        if (tools) {
          if (raw) fail('BAD_HANDLE', 400, 'raw supports only jobs and artifacts');
          const name = tools[1]?.trim();
          // A built-in tool set needs no manifest.
          if (name && isBuiltinToolset(name)) { out.push(toolsetAirLine(null, name, findToolset(null, name)!, limit)); continue; }
          const manifest = loadManifest(this.home) ?? fail('TOOLS_MANIFEST_MISSING', 404, 'no tools.json in the Agent Commons home');
          out.push(...toolsAirLines(hubStatus(manifest, this.toolsEnv), tools[1]?.trim() || null, limit));
          continue;
        }
        // Preserve an availability record even when the AIR rendering reports missing content.
        if (raw) rawItems.push(this.airRawItem(item));
        out.push(...this.airItem(item, limit, grep));
      }
      catch (error) { if (error instanceof CommonsError) out.push(`! ${item} err=${error.code}`); else throw error; }
    }
    return { air: out.join('\n'), ...(raw ? { raw: rawItems } : {}) };
  }
  private airEntity(item: string): { kind: string; row: Json; start: string | undefined; end: string | undefined } {
    const m = /^([^:]+)(?::(\d+)-(\d*))?$/.exec(item) ?? fail('BAD_HANDLE');
    const [, ref, start, end] = m;
    let kind: string | undefined, row: Json | undefined;
    const handle = HANDLE.exec(ref);
    if (handle) {
      kind = KIND_OF_LETTER[handle[1] as HandleKind];
      row = this.db.prepare(`SELECT * FROM ${ENTITY[kind].table} WHERE id=?`).get(this.resolveId(handle[1] as HandleKind, ref)) as Json | undefined;
    } else if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref)) {
      for (const [k, e] of Object.entries(ENTITY)) { row = this.db.prepare(`SELECT * FROM ${e.table} WHERE id=?`).get(ref) as Json | undefined; if (row) { kind = k; break; } }
    } else fail('BAD_HANDLE');
    if (!row) fail('NOT_FOUND');
    if (start !== undefined && kind !== 'artifact') fail('BAD_HANDLE');
    return { kind: kind!, row: row!, start, end };
  }
  private airRawArtifact(row: Json): { content: string; complete: boolean; reason?: string } {
    try {
      const bytes = fs.readFileSync(path.join(this.home, 'artifacts', row.sha256));
      const content = bytes.toString('utf8');
      return bytes.length === row.bytes ? { content, complete: true }
        : { content, complete: false, reason: 'Artifact content is truncated or has changed' };
    } catch {
      return { content: '', complete: false, reason: 'Artifact content is unavailable' };
    }
  }
  private airRawItem(item: string): Json {
    const { kind, row } = this.airEntity(item);
    if (kind !== 'job' && kind !== 'artifact') fail('BAD_HANDLE', 400, 'raw supports only jobs and artifacts');
    const base = { handle: this.handleOf(kind === 'job' ? 'j' : 'a', row.id) ?? row.id, id: row.id, kind };
    if (kind === 'artifact') return { ...base, ...this.airRawArtifact(row) };

    const job = this.job(row.id), options = job.options ?? {};
    // Job-produced artifacts are recorded on the job/options, not discovered in private job folders.
    const artifactIds = new Set<string>();
    for (const source of [job, options]) {
      for (const [key, value] of Object.entries(source)) {
        if (!/(?:^|_)artifacts?(?:_ids?)?$/.test(key)) continue;
        for (const ref of Array.isArray(value) ? value : [value]) {
          if (typeof ref === 'string') artifactIds.add(this.resolveId('a', ref));
        }
      }
    }
    const artifactRows = [...artifactIds].map(id =>
      this.db.prepare('SELECT * FROM artifacts WHERE id=?').get(id) as Json | undefined
    ).filter((artifact): artifact is Json => artifact !== undefined);
    const artifacts = artifactRows.map(artifact => ({
      handle: this.handleOf('a', artifact.id) ?? artifact.id,
      name: artifact.name, kind: artifact.kind, bytes: artifact.bytes,
    }));

    let result: { content: string; complete: boolean; reason?: string } = typeof row.result === 'string'
      ? { content: row.result, complete: true }
      : { content: '', complete: false, reason: 'Job result is unavailable' };
    if (typeof options.output_artifact === 'string') {
      const outputId = this.resolveId('a', options.output_artifact);
      const output = artifactRows.find(artifact => artifact.id === outputId);
      result = output ? this.airRawArtifact(output)
        : { content: '', complete: false, reason: 'Job output artifact is unavailable' };
      if (result.complete) {
        // System artifacts have a storage limit. Never call a truncated spill complete.
        const marker = typeof row.result === 'string'
          ? /^\n\.\.\.\[(\d+) characters omitted; full output: [^\n]+\]\.\.\.\n/.exec(row.result.slice(48 * 1024))
          : null;
        const truncated = typeof options.output_bytes === 'number'
          ? Buffer.byteLength(result.content, 'utf8') !== options.output_bytes
          : marker !== null && result.content.length !== row.result.length - marker[0].length + Number(marker[1]);
        if (truncated) result = { ...result, complete: false, reason: 'Full job output exceeds the stored artifact content' };
      }
    }
    return { ...base, status: row.status, ...result, artifacts };
  }
  private decisionDetails(row: Json, limit: number): string {
    const supByRows = this.db.prepare('SELECT id FROM decisions WHERE project_id=? AND supersedes=? ORDER BY seq')
      .all(row.project_id, row.id) as Json[];
    return kv('why', row.rationale, limit) + kl('ev', row.evidence, limit)
      + (supByRows.length ? kl('sup_by', supByRows.map(x => this.handleOf('d', x.id) ?? x.id), limit) : '');
  }
  private airItem(item: string, limit: number, grep: string | null): string[] {
    const { kind, row: r, start, end } = this.airEntity(item);
    const line = (k: string, entity: Json, extra: string) => entityLine(k, entity, this.names, { limit, extra });
    switch (kind) {
      case 'project': return [line('project', r, kv('obj', r.objective, limit) + kv('root', r.root, limit))];
      case 'task': return [line('task', r, kv('obj', r.objective, limit) + kl('acc', r.acceptance, limit))];
      case 'decision': return [line('decision', r, this.decisionDetails(r, limit))];
      case 'checkpoint': return [line('checkpoint', r, kl('ok', r.checks, limit) + kl('q', r.open_questions, limit)
        + kl('arts', (JSON.parse(r.artifacts) as string[]).map(id => this.handleOf('a', id) ?? id), limit))];
      case 'message': return [line('message', r, kl('ev', r.evidence, limit))];
      case 'discussion': return [line('discussion', r, kv('q', r.question, limit)),
        ...(this.db.prepare('SELECT * FROM messages WHERE discussion_id=? ORDER BY seq').all(r.id) as Json[]).map(msg => line('message', msg, kl('ev', msg.evidence, limit)))];
      case 'job': return [line('job', r, kv('model', r.model) + kv('effort', r.effort) + kv('br', r.branch) + kv('wd', r.workdir, limit)
        + kl('files', r.changed_files ?? '[]', limit) + kv('cost', r.cost_usd) + kv('turns', r.turns) + ` pchars=${String(r.prompt ?? '').length}`
        + this.jobOutputs(r.options) + kv('res', r.result, limit))];
      default: return this.artifactLines(r, start, end, limit, grep);
    }
  }
  private artifactLines(row: Json, start: string | undefined, end: string | undefined, limit: number, grep: string | null): string[] {
    const file = path.join(this.home, 'artifacts', row.sha256);
    if (!fs.existsSync(file)) fail('CONTENT_MISSING');
    const all = fs.readFileSync(file, 'utf8').split('\n');
    if (all.length > 1 && all[all.length - 1] === '') all.pop();
    const explicit = start !== undefined, from = explicit ? Number(start) : 1;
    const to = explicit ? (end ? Number(end) : all.length) : grep ? all.length : Math.min(200, all.length);
    if (from < 1 || to < from) fail('BAD_RANGE');
    const shown: string[] = [];
    let used = 0, last = from - 1, more = false;
    for (let n = from; n <= Math.min(to, all.length); n++) {
      if (grep && !all[n - 1].toLowerCase().includes(grep)) continue;
      if (grep && shown.length >= 200) { more = true; break; }
      const value = (grep ? String(n) : '') + '|' + all[n - 1], add = value.length + (shown.length ? 1 : 0);
      if (used + add > limit) {
        // A single line longer than the cap is cut rather than skipped, so every line can be read.
        if (!shown.length) { shown.push(value.slice(0, limit) + `...[+${value.length - limit}]`); last = n; }
        more = true; break;
      }
      shown.push(value); used += add; last = n;
    }
    if (!grep && !more && !explicit && all.length > to) more = true;
    const range = grep ? (explicit ? ` show=${from}-${to}` : '') + ` grep=${q(grep)} hits=${shown.length}` : ` show=${from}-${last}`;
    return [entityLine('artifact', row, this.names, { extra: ` lines=${all.length}${range}${more ? ' more=1' : ''}` }), ...shown];
  }

  /** The first read: the same facts project_resume returns, one line each. */
  private airSnapshot(actor: Actor, project: Json, taskId: string | null): { lines: string[]; extra: Record<string, unknown> } {
    const line = (kind: string, rows: Json[]) => rows.map(row => entityLine(kind, row, this.names));
    const all = (sql: string, ...args: unknown[]) => this.db.prepare(sql).all(...(args as any[])) as Json[];
    const inbox = line('message', this.inbox(actor, project.id));
    if (taskId) return { extra: { snap: 1 }, lines: [
      ...line('task', all('SELECT * FROM tasks WHERE id=?', taskId)),
      ...line('checkpoint', all('SELECT * FROM checkpoints WHERE task_id=? ORDER BY seq DESC LIMIT 5', taskId)),
      ...line('decision', all(`SELECT * FROM decisions WHERE task_id=? AND ${activeDecisionsSql()} ORDER BY seq DESC LIMIT 5`, taskId)),
      ...line('discussion', all("SELECT * FROM discussions WHERE task_id=? AND status='open' ORDER BY seq DESC LIMIT 5", taskId)), ...inbox] };
    const total = Number((this.db.prepare(`SELECT count(*) n FROM tasks WHERE project_id=? AND status IN ${ACTIVE_TASK}`).get(project.id) as Json).n);
    const latest = all('SELECT * FROM checkpoints WHERE project_id=? AND task_id IS NULL ORDER BY seq DESC LIMIT 1', project.id);
    return { extra: { snap: 1, tasks: total }, lines: [
      ...line('checkpoint', latest.length ? latest : all('SELECT * FROM checkpoints WHERE project_id=? ORDER BY seq DESC LIMIT 1', project.id)),
      ...line('task', all(`SELECT * FROM tasks WHERE project_id=? AND status IN ${ACTIVE_TASK} ORDER BY (owner IS ?) DESC, updated_at DESC LIMIT 20`, project.id, actor.id)),
      ...line('decision', this.projectDecisionTiers(project.id, 10)),
      ...line('discussion', all("SELECT * FROM discussions WHERE project_id=? AND status='open' ORDER BY seq DESC LIMIT 10", project.id)),
      ...line('job', all("SELECT * FROM jobs WHERE project_id=? AND status IN ('queued','running','needs_review') ORDER BY seq DESC LIMIT 10", project.id)),
      ...inbox] };
  }

  /** air-decode: the activity feed in plain US English, oldest first. */
  airDecode(projectRef: string, since = 0, limit = 200): string[] {
    const project = this.project(projectRef);
    const events = this.db.prepare('SELECT * FROM events WHERE project_id=? AND seq>? ORDER BY seq LIMIT ?').all(project.id, since, limit) as Json[];
    return events.map(event => describe(event, this.db.prepare(`SELECT * FROM ${ENTITY[event.kind].table} WHERE id=?`).get(event.entity_id) as Json | undefined,
      this.names.actor(event.actor_id) ?? event.actor_id));
  }
  /** Jobs on these routes that a graceful stop left for review and that have not been checked with their platform yet. */
  unreconciledJobs(routes: string[]): Json[] {
    if (!routes.length) return [];
    return (this.db.prepare(`SELECT * FROM jobs WHERE route IN (${routes.map(() => '?').join(',')}) AND status='needs_review' AND error='SERVICE_STOPPED_DURING_JOB' ORDER BY seq`)
      .all(...routes) as Json[]).map(jobRow) as Json[];
  }
  runningJobs(): Json[] { return (this.db.prepare("SELECT * FROM jobs WHERE status='running' ORDER BY seq").all() as Json[]).map(jobRow) as Json[]; }
  unresolvedPatchChecks(): Json[] {
    return (this.db.prepare("SELECT * FROM jobs WHERE status='needs_review' AND json_extract(options, '$.patch_state.phase')='check'")
      .all() as Json[]).map(jobRow) as Json[];
  }
  projectRoot(projectId: string): string | null { return (this.project(projectId).root as string | null) ?? null; }

  recordPatchTurnContext(job: Json, turn: number, context: string): void {
    const artifact = this.storeArtifact(job.project_id, SYSTEM_ACTOR.id, `${this.handleOf('j', job.id)}-patch-turn-${turn}.md`,
      'job_context', context, 'job_context');
    const previous = this.job(job.id).options.patch_contexts ?? [];
    this.mergeJobOptions(job.id, { patch_contexts: [...previous, artifact.id] });
  }
}

const FINISHED_JOB = ['completed', 'failed', 'cancelled', 'needs_review'];
/** Agent Commons itself, as the creator of jobs it starts and the sender of its reports. Not a login: it has no token. */
const SYSTEM_ACTOR: Actor = { id: 'agent-commons', name: 'agent-commons', role: 'participant' };
/** Consult jobs (auto reviews and, later, wake-ups) one task may start. */
const MAX_CONSULTS_PER_TASK = 5;
/** Times one worker chain may stop to ask a peer (need) before it must finish on its own. */
const MAX_YIELDS = 2;
/** An app seen this recently is online: wake=auto leaves its questions in its inbox. */
const ONLINE_MS = 2 * 60 * 1000;
/** Wake jobs one asker may start per hour. */
const WAKES_PER_HOUR = 10;
const REVIEW_POLICIES = ['none', 'cross'];
function reviewPolicy(value: unknown): string {
  if (!REVIEW_POLICIES.includes(value as string)) fail('INVALID_INPUT', 400, 'review_policy must be none or cross');
  return value as string;
}
const JOB_SUMMARY = 'id,task_id,route,mode,status,model,error,cost_usd,created_by,created_at,started_at,finished_at,branch';
const jobRow = (row: Json | undefined) => { const out = parseLists(row, ['changed_files', 'options']); if (out) out.cancel_requested = !!out.cancel_requested; return out; };
const PROMPT_PREVIEW = 500;
/** A job as returned to callers: the prompt cut to a preview, with its full length. */
const briefJob = (job: Json): Json => typeof job.prompt === 'string' && job.prompt.length > PROMPT_PREVIEW
  ? { ...job, prompt: job.prompt.slice(0, PROMPT_PREVIEW) + ' [...]', prompt_chars: job.prompt.length } : { ...job, prompt_chars: job.prompt?.length ?? 0 };

/** A room seat: its name (the role, or the route's short name), route, effort tier and optional role. */
interface Seat { seat: string; route: string; eff: string; role: string | null }
/**
 * ropen's room fields: seats as "route[:eff[:role]]" (2-4, distinct names, subscription or local routes only), mode
 * parallel (every seat every round) or directed (later rounds wake only dissenting or mentioned seats), and a round
 * limit of 1-5 (default 3).
 */
function roomSetup(input: Json): { mode: string; seats: Seat[]; maxRounds: number } {
  const specs = Array.isArray(input.seats) ? input.seats as unknown[] : [];
  if (specs.length < 2 || specs.length > 4) fail('ROOM_SEATS', 400, 'a room has 2 to 4 seats (route[:eff[:role]])');
  const seats = specs.map(spec => {
    const [routeName, eff = '', role = ''] = String(spec).split(':');
    const platform = allAdapters().find(a => a.capabilities.id === routeName || a.capabilities.short === routeName)
      ?? fail('ROUTE_UNAVAILABLE', 400, `no route ${routeName}; routes are ${allAdapters().map(a => a.capabilities.short).join(', ')}`);
    if (platform.capabilities.billing === 'paid') fail('ROOM_SEAT_PAID', 400, `${routeName} is a paid route; room seats use subscription or local routes`);
    if (eff && !(EFFORTS as readonly string[]).includes(eff)) fail('INVALID_INPUT', 400, `seat effort must be one of ${EFFORTS.join(', ')}`);
    return { seat: role || platform.capabilities.short, route: platform.capabilities.id, eff: eff || 'med', role: role || null };
  });
  if (new Set(seats.map(s => s.seat)).size !== seats.length) fail('ROOM_SEATS', 400, 'seat names must differ: give roles (route:eff:role)');
  const mode = input.room_mode ?? 'parallel';
  if (mode !== 'parallel' && mode !== 'directed') fail('INVALID_INPUT', 400, 'room mode must be parallel or directed');
  const maxRounds = input.max_rounds ?? 3;
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 5) fail('INVALID_INPUT', 400, 'max_r must be 1-5');
  return { mode, seats, maxRounds };
}
