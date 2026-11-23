/** Checks the @air1 block a proto=air worker ends its answer with. Nothing is applied; the result is only recorded. */
import { parsePacket, one } from './parser.ts';
import { AirParseError, type AirItem } from './types.ts';

/** A worker's request for help (need): whom to ask (a route, or auto), at what effort, with what context. */
export interface WorkerNeed { to: string; eff: string | null; ctx: string[]; question: string }
export type WorkerVerdict = { ok: true; nodes: number; verdict: string | null; p: number | null; summary: string | null; need?: WorkerNeed }
  | { ok: false; code: string; line?: number };

/** The last @air1 block in the answer (code fences around it are ignored), parsed in worker mode. */
export function checkWorkerBlock(answer: string): WorkerVerdict {
  const lines = answer.split(/\r?\n/);
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (/^\s*@air1\b/.test(lines[i])) { start = i; break; }
  if (start < 0) return { ok: false, code: 'NO_BLOCK' };
  const block: string[] = [];
  for (const line of lines.slice(start)) { if (/^\s*```/.test(line)) break; block.push(line); }
  try {
    const packet = parsePacket(block.join('\n'), 'worker');
    const text = (items: AirItem[] | undefined) => { const item = one(items); return item && 'text' in item ? item.text : null; };
    // The verdict (and its confidence) is the last one given; without one, the last chk's confidence.
    const judged = [...packet.nodes].reverse().find(n => n.fields.verdict) ?? [...packet.nodes].reverse().find(n => n.op === 'chk');
    const asked = [...packet.nodes].reverse().find(n => n.op === 'need');
    const need = asked ? { to: text(asked.fields.to) ?? 'auto', eff: text(asked.fields.eff),
      ctx: (asked.fields.ctx ?? []).flatMap(item => 'text' in item ? [item.text] : []), question: asked.text! } : undefined;
    return { ok: true, nodes: packet.nodes.length, verdict: text(judged?.fields.verdict), p: judged?.fields.p ? Number(text(judged.fields.p)) : null,
      summary: judged?.text ?? null, ...(need ? { need } : {}) };
  } catch (error) {
    if (error instanceof AirParseError) return { ok: false, code: error.code, line: error.line };
    throw error;
  }
}
