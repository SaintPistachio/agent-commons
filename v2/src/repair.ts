import { EFFORTS, type Eff, type Intent } from './adapters/types.ts';

/**
 * One automatic repair per root job (j16 sections 3 and 5). Pure planning: which deliverable failure qualifies, and
 * the smallest correction. The store submits the follow-up; the original attempt stays as it was.
 *
 * Qualifying failures carry explicit evidence and a known, terminal outcome:
 * - `truncated`: the API helper reported the response `incomplete` with reason `max_output_tokens` (the provider's
 *   incomplete_details, passed through by the helper). The helper has accounted for that request, so a new request is
 *   not a replay of an uncertain one. Other incomplete reasons (such as a content filter) do not qualify.
 * - `malformed_air`: a completed proto=air or proto=patch answer whose final @air1 block is missing or invalid.
 * - `patch_invalid`: a completed proto=patch answer whose patch blocks cannot be parsed.
 * - `patch_unapplicable`: a completed proto=patch answer whose blocks would not apply (a dry run) in the job's own
 *   workspace when it finished.
 * Nothing else qualifies: not answer length, not timeouts, disconnects, restarts, cancellations, quota or auth
 * failures, and never `needs_review` (an uncertain outcome, paid or not). Edit jobs never qualify: an isolated worktree
 * does not prove the worker had no external effects.
 */
export type RepairKind = 'truncated' | 'malformed_air' | 'patch_invalid' | 'patch_unapplicable';
export interface RepairTrigger { kind: RepairKind; detail: string }

export interface RepairJob {
  status: string; mode: string; error?: string | null; route: string; trigger?: string | null;
  req_intent?: string | null; req_eff?: string | null;
  options?: Record<string, any>;
}

export function repairTrigger(job: RepairJob): RepairTrigger | null {
  const o = job.options ?? {};
  if (job.status === 'failed' && /^HELPER_INCOMPLETE: max_output_tokens\b/.test(String(job.error ?? '')))
    return { kind: 'truncated', detail: String(job.error).slice(0, 200) };
  if (job.status !== 'completed' || (o.proto !== 'air' && o.proto !== 'patch')) return null;
  if (o.air && o.air.ok === false) return { kind: 'malformed_air', detail: `${o.air.code}${o.air.line ? ` line ${o.air.line}` : ''}` };
  if (o.proto === 'patch' && typeof o.patch_error === 'string') return { kind: 'patch_invalid', detail: o.patch_error.slice(0, 200) };
  if (o.proto === 'patch' && o.patch_check && o.patch_check.rejected > 0)
    return { kind: 'patch_unapplicable', detail: `${o.patch_check.rejected} of ${o.patch_check.rejected + o.patch_check.applied} blocks would not apply` };
  return null;
}

/** API output room is bounded by the adapter's own validation (256-65536 tokens). */
export const MAX_OUTPUT_TOKENS = 65536;
const STRONGER: Partial<Record<Intent, Intent>> = { fast: 'code', code: 'deep', review: 'deep', edit: 'deep' };

export type RepairCorrection =
  | { kind: 'output'; maxOutputTokens: number }
  | { kind: 'effort'; intent: Intent; eff: Eff }
  | { kind: 'capability'; intent: Intent; eff: Eff }
  | { kind: 'route_failover'; from: string; to: string; intent: Intent; eff: Eff };

/**
 * The smallest relevant correction: more output room for truncation (no reasoning change); otherwise one effort step
 * on the same route, or, at the top effort, one capability step (a stronger profile). Returns a refusal code when no
 * correction exists.
 */
export function planCorrection(trigger: RepairTrigger, job: RepairJob): RepairCorrection | { refused: string } {
  if (trigger.kind === 'truncated') {
    const current = Number(job.options?.max_output_tokens);
    if (!Number.isInteger(current)) return { refused: 'NO_OUTPUT_LIMIT' };
    if (current >= MAX_OUTPUT_TOKENS) return { refused: 'OUTPUT_AT_MAX' };
    return { kind: 'output', maxOutputTokens: Math.min(MAX_OUTPUT_TOKENS, current * 2) };
  }
  const intent = (job.req_intent ?? 'code') as Intent, eff = (job.req_eff ?? 'med') as Eff;
  const step = EFFORTS.indexOf(eff);
  if (step < 0) return { refused: 'UNKNOWN_EFFORT' };
  if (step < EFFORTS.length - 1) return { kind: 'effort', intent, eff: EFFORTS[step + 1] };
  const stronger = STRONGER[intent];
  return stronger ? { kind: 'capability', intent: stronger, eff } : { refused: 'AT_CEILING' };
}

const INSTRUCTION: Record<RepairKind, string> = {
  truncated: 'stopped at its output limit before finishing. You have more output room now. Give the complete deliverable; be concise where you can.',
  malformed_air: 'did not end with a valid @air1 block. Give the complete answer again, fixing anything that was incomplete, and end with a valid @air1 block exactly as the primer describes.',
  patch_invalid: 'had patch blocks that could not be parsed. Give the complete change again as well-formed blocks, then the @air1 block.',
  patch_unapplicable: 'had patch blocks that would not apply to the current files (the reasons and current text are in @ctx). Give the complete, corrected set of blocks for the whole change against the current files, then the @air1 block.',
};

export function repairPrompt(originalPrompt: string, trigger: RepairTrigger, previous: string, previousIncluded: boolean): string {
  return `${originalPrompt}\n\n@repair ${trigger.kind} (${trigger.detail}): the previous attempt ${previous}`
    + `${previousIncluded ? ' (its answer is in @ctx)' : ''} ${INSTRUCTION[trigger.kind]}`;
}
