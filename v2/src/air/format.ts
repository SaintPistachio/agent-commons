/** AIR-T output: tx replies, error lines and one-line entity views for air_sync. Deterministic. */
import { TASK_CODE } from './types.ts';

type Row = Record<string, any>;
const BARE = /^[A-Za-z0-9._:\/@#~^-]+$/;  // the same set as the parser's
const LIMIT = 300;

/** A value as AIR-T: bare when safe, otherwise a JSON string. Text over `limit` characters is cut and ends "...[+N]". */
export function q(value: unknown, limit = LIMIT): string {
  let s = String(value);
  if (s.length > limit) s = s.slice(0, limit) + `...[+${s.length - limit}]`;
  return s && BARE.test(s) ? s : JSON.stringify(s);
}
const kv = (key: string, value: unknown, limit = LIMIT) => value === null || value === undefined || value === '' ? '' : ` ${key}=${q(value, limit)}`;
/** A list field, e.g. ` ok="tsc ok",48/48`; empty lists are left out. */
export const kl = (key: string, values: unknown, limit = LIMIT) => {
  const list = typeof values === 'string' ? JSON.parse(values) : values;
  return Array.isArray(list) && list.length ? ` ${key}=` + list.map(v => q(v, limit)).join(',') : '';
};
export { kv };
/** Confidence as `.92`. */
export const conf = (value: unknown) => typeof value === 'number' ? ` p=${String(Math.round(value * 1000) / 1000).replace(/^0\./, '.')}` : '';

/** Lookups the store supplies: an actor's display name and an entity's short handle. */
export interface Names { actor(id: string | null | undefined): string | null; handle(kind: string, id: string | null | undefined): string | null; route?(id: string): string }

/**
 * One line describing an entity's state (spec 2.3 "Delta sync response"). air_get passes a higher `limit` and the
 * fields air_sync leaves out as `extra`, which goes just before the positional text.
 */
export function entityLine(kind: string, row: Row, names: Names, opts: { limit?: number; extra?: string } = {}): string {
  const h = (k: string, id: unknown) => names.handle(k, id as string);
  const L = opts.limit ?? LIMIT, x = opts.extra ?? '', k = (key: string, value: unknown) => kv(key, value, L);
  switch (kind) {
    case 'project': return `P ${h('p', row.id)}${k('name', row.name)}${k('next', row.next_action)}${x}`;
    case 'task': return `T ${h('t', row.id)} v=${row.version} st=${TASK_CODE[row.status] ?? row.status}${row.review_policy && row.review_policy !== 'none' ? ` pol=${row.review_policy}` : ''}${kv('own', names.actor(row.owner))}${k('next', row.next_action)}${x} ${q(row.title, L)}`;
    case 'decision': return `D ${h('d', row.id)}${kv('t', h('t', row.task_id))}${kv('by', names.actor(row.actor_id))}${conf(row.confidence)}${kv('sup', h('d', row.supersedes))}${x} ${q(row.summary, L)}`;
    case 'checkpoint': return `C ${h('c', row.id)}${kv('t', h('t', row.task_id))}${k('rev', row.revision)}${k('br', row.branch)}${kv('by', names.actor(row.actor_id))}${conf(row.confidence)}${row.failed ? ' fail=1' : ''}${k('next', row.next_action)}${x} ${q(row.summary, L)}`;
    case 'discussion': {
      // A room adds its mode, round (used/limit), status and seats (name:route).
      const seats = row.room_mode ? (JSON.parse(row.seats ?? '[]') as Array<{ seat: string; route: string }>).map(s => `${s.seat}:${names.route?.(s.route) ?? s.route}`).join(',') : '';
      const room = row.room_mode ? ` room=${row.room_mode} r=${row.round}/${row.max_rounds} rst=${row.room_status} seats=${seats}` : '';
      return `G ${h('g', row.id)}${kv('t', h('t', row.task_id))}${kv('own', names.actor(row.owner))} st=${row.status}${room}${k('out', row.outcome)}${x} ${q(row.subject, L)}`;
    }
    case 'message': {
      const to = (Array.isArray(row.recipients) ? row.recipients : JSON.parse(row.recipients ?? '[]')).map((id: string) => names.actor(id) ?? id).join(',');
      return `M ${h('m', row.id)}${kv('t', h('t', row.task_id))}${kv('g', h('g', row.discussion_id))}${kv('from', names.actor(row.sender_id))}${kv('to', to)} type=${row.type}${kv('re', h('m', row.reply_to))}${conf(row.confidence)}${x} ${q(row.body, L)}`;
    }
    case 'artifact': return `A ${h('a', row.id)}${kv('name', row.name)}${kv('kind', row.kind)} bytes=${row.bytes}${x}`;
    case 'job': return `J ${h('j', row.id)}${kv('t', h('t', row.task_id))} route=${row.route} mode=${row.mode} st=${row.status}${kv('by', names.actor(row.created_by))}${kv('trig', row.trigger)}${kv('verdict', row.consult_verdict)}${k('err', row.error)}${x} ${q(row.prompt, 120)}`;
    default: return `? ${kind} ${row.id}`;
  }
}

/**
 * `@air1 ok op=... seq=... [replay=1] unseen=N inbox=N [review=j12|skip:CODE] [hint=consult:codex,ag]` and the node
 * results, e.g. `#2=d19 #3=t4@v4`. unseen counts other actors' changes since your read position; inbox counts
 * unanswered messages addressed to you; review names the auto review a move to rev queued (or why it did not);
 * hint follows a second failed checkpoint in a row and names idle peers of another model family.
 */
export function txReply(result: { op: string; seq: number; handles: Record<string, string>; unseen?: number; inbox?: number; review?: string; hint?: string; wake?: string; warnings?: string[] }, replayed = false): string {
  const handles = Object.entries(result.handles).map(([k, v]) => `#${k}=${v}`).join(' ');
  const counts = result.unseen === undefined ? '' : ` unseen=${result.unseen} inbox=${result.inbox ?? 0}`;
  const notes = (result.review ? ` review=${result.review}` : '') + (result.hint ? ` hint=consult:${result.hint}` : '') + (result.wake ? ` wake=${result.wake}` : '');
  return `@air1 ok op=${q(result.op)} seq=${result.seq}${replayed ? ' replay=1' : ''}${counts}${notes}`
    + (handles ? '\n' + handles : '') + (result.warnings ?? []).map(warning => `\n! edit_overlap ${q(warning)}`).join('');
}

/** `@air1 err line=5 node=3 code=VERSION_CONFLICT msg="..."`; line and node are omitted when unknown. */
export function errLine(code: string, message: string, line?: number | null, node?: number | null): string {
  return `@air1 err${line ? ` line=${line}` : ''}${node !== null && node !== undefined ? ` node=${node}` : ''} code=${code} msg=${JSON.stringify(message)}`;
}

/** Error messages from air_tx start with `line=L node=K: ` so the MCP bridge can rebuild the AIR error line. */
export function splitLocated(message: string): { line?: number; node?: number; message: string } {
  const m = /^line=(\d+)(?: node=(\d+))?: ([\s\S]*)$/.exec(message);
  return m ? { line: Number(m[1]), ...(m[2] !== undefined ? { node: Number(m[2]) } : {}), message: m[3] } : { message };
}

export function syncHeader(project: Row, handle: string, from: number, to: number, extra: Record<string, unknown> = {}): string {
  return `@air1 sync p=${handle}${kv('name', project.name)} from=${from} to=${to}` + Object.entries(extra).map(([k, v]) => kv(k, v)).join('') + kv('next', project.next_action);
}
