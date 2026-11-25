/** AIR-T v0.1 packet types. The codec has no HTTP, MCP or database dependencies. */

/** One value item: plain text, or a back-reference to an earlier node (`#k`). */
export type AirItem = { ref: number; git?: true } | { text: string };

export interface AirNode {
  idx: number;
  /** 1-based physical line in the packet, for error replies. */
  line: number;
  op: AirOp;
  fields: Record<string, AirItem[]>;
  /** The quoted or bare positional value (title, summary, body, prompt, or a ref's URI). */
  text?: string;
}

export interface AirPacket { project?: string; op?: string; nodes: AirNode[] }

export type AirOp = 'ref' | 'tnew' | 'tclm' | 'tupd' | 'trel' | 'dec' | 'chk' | 'ask' | 'rep' | 'ack'
  | 'dopen' | 'dpost' | 'dclose' | 'art' | 'job' | 'jcan' | 'ropen' | 'rstep' | 'need';

/** Handle letters: project, task, decision, checkpoint, discussion (g), message, artifact, job. */
export type HandleKind = 'p' | 't' | 'd' | 'c' | 'g' | 'm' | 'a' | 'j';

export class AirParseError extends Error {
  readonly line: number; readonly node: number | null; readonly code: string;
  constructor(line: number, node: number | null, code: string, message: string) { super(message); this.line = line; this.node = node; this.code = code; }
}

/** Short task status codes: written on new AIR lines and accepted wherever a status is (open and done stay as they are). */
export const TASK_CODE: Record<string, string> = { in_progress: 'wip', blocked: 'blk', awaiting_review: 'rev', cancelled: 'can' };
export const STATUS_OF_CODE: Record<string, string> = Object.fromEntries(Object.entries(TASK_CODE).map(([status, code]) => [code, status]));
