import { AirParseError, STATUS_OF_CODE, type AirItem, type AirNode, type AirOp, type AirPacket } from './types.ts';

/**
 * Field kinds: `one` a single value, `int` a non-negative integer, `conf` a probability in (0, 1),
 * `list` comma-separated values, `status` a task status. Any item may be `#k` (an earlier node).
 */
type Kind = 'one' | 'int' | 'conf' | 'list' | 'status' | 'verdict';
/** Workers (proto=air jobs) may only report: ref, dec and chk, with an optional verdict. */
export type ParseMode = 'tx' | 'worker';
const WORKER_OPS = new Set(['ref', 'dec', 'chk', 'need']);
/** Opcodes only a worker may write (Agent Commons acts on them; an AI's own air_tx may not). */
const WORKER_ONLY = new Set(['need']);
const VERDICTS = ['ok', 'chg', 'blk'];
interface OpSpec { text: 'required' | 'none'; required: string[]; fields: Record<string, Kind> }

const TASK_STATUSES = ['open', 'in_progress', 'blocked', 'awaiting_review', 'done', 'cancelled'];

/** The opcode catalog (spec 2.2). `text` is the positional value. */
export type OutcomeNode = Omit<AirNode, 'op'> & { op: 'out' };
type TransactionNode = AirNode | OutcomeNode;
type TransactionPacket = Omit<AirPacket, 'nodes'> & { nodes: TransactionNode[] };

export const OPS: Record<AirOp | 'out', OpSpec> = {
  out: { text: 'required', required: ['j', 'v'], fields: { j: 'one', v: 'one', replacement: 'one' } },
  ref: { text: 'required', required: [], fields: { status: 'one', sha: 'one' } },
  tnew: { text: 'required', required: [], fields: { obj: 'one', acc: 'list', next: 'one', rev_pol: 'one' } },
  tclm: { text: 'none', required: ['t', 'v'], fields: { t: 'one', v: 'int' } },
  tupd: { text: 'none', required: ['t', 'v'], fields: { t: 'one', v: 'int', st: 'status', next: 'one', title: 'one', obj: 'one', acc: 'list', rev_pol: 'one' } },
  trel: { text: 'none', required: ['t', 'v'], fields: { t: 'one', v: 'int' } },
  dec: { text: 'required', required: [], fields: { t: 'one', why: 'one', ev: 'list', sup: 'one', p: 'conf' } },
  chk: { text: 'required', required: [], fields: { t: 'one', rev: 'one', br: 'one', ok: 'list', q: 'list', arts: 'list', next: 'one', p: 'conf', fail: 'one' } },
  ask: { text: 'required', required: ['to'], fields: { to: 'list', t: 'one', ev: 'list', p: 'conf', wake: 'one' } },
  rep: { text: 'required', required: ['m'], fields: { m: 'one', ev: 'list', p: 'conf' } },
  ack: { text: 'none', required: ['m'], fields: { m: 'one' } },
  dopen: { text: 'required', required: ['subj'], fields: { subj: 'one', t: 'one' } },
  dpost: { text: 'required', required: ['g'], fields: { g: 'one', reply: 'one', ev: 'list', p: 'conf' } },
  dclose: { text: 'required', required: ['g'], fields: { g: 'one' } },
  ropen: { text: 'required', required: ['subj', 'seats'], fields: { subj: 'one', t: 'one', seats: 'list', mode: 'one', max_r: 'int' } },
  rstep: { text: 'required', required: ['g'], fields: { g: 'one', to: 'list', ctx: 'list', cwd: 'one' } },
  art: { text: 'required', required: ['name'], fields: { name: 'one', kind: 'one' } },
  job: { text: 'required', required: [], fields: { t: 'one', route: 'one', mode: 'one', proto: 'one', model: 'one', effort: 'one',
    timeout: 'int', task: 'one', reason: 'one', max_usd: 'one', max_tok: 'int', tier: 'one', purpose: 'one', deliv: 'one', intent: 'one', eff: 'one', ctx: 'list', cwd: 'one', cost: 'one', shell: 'one', repair: 'one', tools: 'one', max_turns: 'int', check: 'one' } },
  jcan: { text: 'none', required: ['j'], fields: { j: 'one' } },
  need: { text: 'required', required: [], fields: { to: 'one', eff: 'one', ctx: 'list' } },
};

const MAX_NODES = 200;
/** Characters an unquoted value may hold. ~ and ^ let git ranges (HEAD~1..HEAD) go unquoted. */
const BARE = /^[A-Za-z0-9._:\/@#~|+^-]+$/;

/** Reads a JSON string literal starting at s[i] === '"'; returns the value and the index after the closing quote. */
function readQuoted(s: string, i: number, fail: (code: string, message: string) => never): [string, number] {
  let j = i + 1;
  while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
  if (j >= s.length) fail('UNTERMINATED_STRING', 'a quoted value has no closing quote');
  try { return [JSON.parse(s.slice(i, j + 1)), j + 1]; } catch { return fail('BAD_STRING', 'a quoted value is not a valid JSON string'); }
}

/** Reads `v1,v2,...` (each item quoted or bare) starting at s[i]; stops at whitespace or end of line. */
function readItems(s: string, i: number, fail: (code: string, message: string) => never): [string[], boolean[], number] {
  const items: string[] = [], quoted: boolean[] = [];
  for (;;) {
    if (s[i] === '"') { const [value, next] = readQuoted(s, i, fail); items.push(value); quoted.push(true); i = next; }
    else {
      let j = i; while (j < s.length && !/[\s,"]/.test(s[j])) j++;
      const raw = s.slice(i, j);
      if (!raw) fail('EMPTY_VALUE', 'a value is empty');
      if (!BARE.test(raw)) fail('BAD_VALUE', `unquoted value "${raw}" has characters that need quotes`);
      items.push(raw); quoted.push(false); i = j;
    }
    if (s[i] === ',') { i++; continue; }
    if (i < s.length && !/\s/.test(s[i])) fail('BAD_VALUE', 'values must be separated by spaces');
    return [items, quoted, i];
  }
}

function header(line: string, lineNo: number): Pick<AirPacket, 'project' | 'op'> {
  const fail = (code: string, message: string): never => { throw new AirParseError(lineNo, null, code, message); };
  if (!/^@air1(\s|$)/.test(line)) fail('MISSING_HEADER', 'the first line must start with @air1');
  const out: Pick<AirPacket, 'project' | 'op'> = {};
  let i = 5;
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i])) i++;
    if (i >= line.length) break;
    const key = /^([a-z]+)=/.exec(line.slice(i));
    if (!key || (key[1] !== 'p' && key[1] !== 'op')) fail('BAD_HEADER', 'the header takes only p= and op=');
    if (out[key![1] === 'p' ? 'project' : 'op'] !== undefined) fail('DUPLICATE_FIELD', `${key![1]}= appears twice`);
    const [items, , next] = readItems(line, i + key![0].length, fail);
    if (items.length !== 1) fail('BAD_HEADER', `${key![1]}= takes one value`);
    if (key![1] === 'p') out.project = items[0]; else out.op = items[0];
    i = next;
  }
  return out;
}

function node(line: string, lineNo: number, expected: number, mode: ParseMode = 'tx'): TransactionNode {
  const head = /^#(\d+)\s+([a-z]+)(?=\s|$)/.exec(line);
  const fail = (code: string, message: string): never => { throw new AirParseError(lineNo, head ? Number(head[1]) : null, code, message); };
  if (!head) fail('BAD_NODE', 'a node line must start with #<index> <opcode>');
  const idx = Number(head![1]);
  if (idx !== expected) fail('BAD_INDEX', `expected #${expected}`);
  const op = head![2] as AirOp | 'out', spec = Object.hasOwn(OPS, op) ? OPS[op] : undefined;
  if (!spec) return fail('UNKNOWN_OPCODE', `unknown opcode ${head![2]}`);
  if (mode === 'worker' && !WORKER_OPS.has(op)) fail('DISALLOWED_OP', `workers may only use ref, dec, chk and need, not ${op}`);
  if (mode === 'tx' && WORKER_ONLY.has(op)) fail('WORKER_ONLY', `${op} is for delegated workers; ask a peer with ask or job instead`);
  const allowed: Record<string, Kind> = mode === 'worker' && op !== 'ref' ? { ...spec.fields, verdict: 'verdict' } : spec.fields;
  const fields: Record<string, AirItem[]> = {};
  let text: string | undefined;
  const toItem = (value: string, quoted: boolean): AirItem => {
    if (quoted || !value.startsWith('#')) return { text: value };
    if (!/^#\d+$/.test(value)) fail('BAD_REF', `${value} is not a node reference`);
    const k = Number(value.slice(1));
    if (k >= idx) fail('FORWARD_REF', `#${idx} may only refer to earlier nodes`);
    return { ref: k };
  };
  let i = head![0].length;
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i])) i++;
    if (i >= line.length) break;
    const key = /^([a-z_]+)=/.exec(line.slice(i));
    if (key) {
      const name = key[1], kind = allowed[name];
      if (!kind) fail('UNKNOWN_FIELD', `${op} has no field ${name}=`);
      if (fields[name]) fail('DUPLICATE_FIELD', `${name}= appears twice`);
      const [items, quoted, next] = readItems(line, i + key[0].length, fail);
      if (kind !== 'list' && items.length !== 1) fail('BAD_VALUE', `${name}= takes one value`);
      if (kind === 'int' && !/^\d{1,9}$/.test(items[0])) fail('BAD_VALUE', `${name}= must be a whole number`);
      if (kind === 'conf' && (!/^(0?\.\d+)$/.test(items[0]) || !(Number(items[0]) > 0 && Number(items[0]) < 1)))
        fail('BAD_CONFIDENCE', `${name}= must be a probability between 0 and 1, such as .92`);
      if (kind === 'status' && !TASK_STATUSES.includes(items[0]) && !STATUS_OF_CODE[items[0]]) fail('BAD_VALUE', `st= must be one of ${TASK_STATUSES.join(', ')} or ${Object.keys(STATUS_OF_CODE).join(', ')}`);
      if (kind === 'verdict' && !VERDICTS.includes(items[0])) fail('BAD_VALUE', 'verdict= must be ok, chg or blk');
      fields[name] = items.map((value, n) => kind === 'int' || kind === 'conf' || kind === 'status' || kind === 'verdict' ? { text: value } : toItem(value, quoted[n]));
      i = next;
    } else {
      if (text !== undefined) fail('DUPLICATE_TEXT', 'a node takes one positional value');
      if (line[i] === '"') { const [value, next] = readQuoted(line, i, fail); text = value; i = next; }
      else { let j = i; while (j < line.length && !/\s/.test(line[j])) j++; const raw = line.slice(i, j);
        if (!BARE.test(raw)) fail('BAD_VALUE', `unquoted value "${raw}" has characters that need quotes`); text = raw; i = j; }
      if (i < line.length && !/\s/.test(line[i])) fail('BAD_VALUE', 'values must be separated by spaces');
    }
  }
  if (spec.text === 'required' && (text === undefined || !text.trim())) fail('MISSING_TEXT', `${op} needs its quoted text`);
  if (spec.text === 'none' && text !== undefined) fail('UNEXPECTED_TEXT', `${op} takes no positional text`);
  for (const name of spec.required) if (!fields[name]) fail('MISSING_FIELD', `${op} needs ${name}=`);
  return { idx, line: lineNo, op, fields, ...(text !== undefined ? { text } : {}) };
}

/** Parses and validates a whole packet before anything touches the database. */
export function parsePacket(packet: string, mode: 'worker'): AirPacket;
export function parsePacket(packet: string, mode?: ParseMode): TransactionPacket;
export function parsePacket(packet: string, mode: ParseMode = 'tx'): TransactionPacket {
  if (packet.includes('\0')) throw new AirParseError(0, null, 'NUL_BYTE', 'the packet contains a NUL byte');
  const lines = packet.split('\n').map(l => l.replace(/\r$/, ''));
  let headerSeen = false, out: TransactionPacket = { nodes: [] };
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n].trim();
    if (!line) continue;
    if (!headerSeen) { out = { ...header(line, n + 1), nodes: [] }; headerSeen = true; continue; }
    if (out.nodes.length >= MAX_NODES) throw new AirParseError(n + 1, null, 'TOO_MANY_NODES', `a packet holds at most ${MAX_NODES} nodes`);
    out.nodes.push(node(line, n + 1, out.nodes.length, mode));
  }
  if (!headerSeen) throw new AirParseError(1, null, 'MISSING_HEADER', 'the packet is empty');
  if (!out.nodes.length) throw new AirParseError(1, null, 'NO_NODES', 'the packet has no nodes');
  return out;
}

export const one = (items: AirItem[] | undefined): AirItem | undefined => items?.[0];
