import type { Eff, Intent } from './adapters/types.ts';

export interface SelectionInput {
  intent?: Intent | null;
  eff?: Eff | null;
  mode?: string;
  /** Internal origin; absent for caller jobs. Unrecognized origins use the default policy. */
  trigger?: string;
  prompt?: string;
  contextRefs?: readonly string[];
}

export interface Selection {
  intent: Intent;
  eff: Eff;
  source: 'caller' | 'mixed' | 'inferred';
  reasons: string[];
}

const RISK_SIGNALS: ReadonlyArray<readonly [string, RegExp]> = [
  ['schema', /\bschemas?\b/i],
  ['migration', /\bmigrations?\b/i],
  ['wire_protocol', /\bwire[\s_-]+protocols?\b/i],
  ['security', /\bsecurity\b/i],
  ['auth', /\bauth\b/i],
  ['credential', /\bcredentials?\b/i],
  ['secret', /\bsecrets?\b/i],
  ['billing', /\bbilling\b/i],
  ['spend', /\bspend\b/i],
  ['payment', /\bpayments?\b/i],
  ['concurrency', /\bconcurrency\b/i],
  ['lock', /\blocks?\b/i],
  ['race', /\braces?\b/i],
  ['data_integrity', /\bdata[\s_-]+integrity\b/i],
];

/** High-specificity path signals only; generic filenames like schema.ts or lock.ts do not force deep/high on read-only lookups. */
const REF_RISK_SIGNALS: ReadonlyArray<readonly [string, RegExp]> = [
  ['migration', /\bmigrations?\b/i],
  ['security', /\bsecurity\b/i],
  ['auth', /\bauth\b/i],
  ['credential', /\bcredentials?\b/i],
  ['secret', /\bsecrets?\b/i],
  ['billing', /\bbilling\b/i],
  ['payment', /\bpayments?\b/i],
];

const HEAVY_WORK_CUES = /\b(refactor|architect|architecture|debug|root[\s_-]+cause|fix|implement|design|review|audit|migrate|migration|security|optimize|redesign|rewrite)\b/i;
const BOUNDED_LOOKUP_CUES = /\b(list|inspect|summarize|briefly|what\s+fields|check\s+status|count|report\s+briefly|read_file|show\s+the|extract|top-level\s+fields)\b/i;

/**
 * Stage A policy: explicit caller values win independently; only missing values are inferred.
 * Reasons record policy signals, including signals whose effect an explicit caller value overrides.
 * This function performs no routing, I/O, or mutation of its input.
 */
export function inferSelection(input: SelectionInput): Selection {
  const prompt = input.prompt ?? '';
  const refs = input.contextRefs ?? [];
  const reasons: string[] = [];
  let inferredIntent: Intent = 'code';
  let inferredEff: Eff = 'med';

  if (input.trigger === 'yield' || input.trigger === 'wake') {
    inferredIntent = 'deep';
    inferredEff = 'high';
    reasons.push(`trigger:${input.trigger}`);
  } else if (input.trigger === 'auto_review' || input.trigger === 'room') {
    inferredIntent = 'review';
    reasons.push(`trigger:${input.trigger}`);
  }

  // Edit mode determines the role, while a yield/wake can still raise its intensity.
  if (input.mode === 'edit') {
    inferredIntent = 'edit';
    reasons.push('mode:edit');
  }

  const matchedRisk = new Set<string>();
  for (const [word, pattern] of RISK_SIGNALS) {
    if (!pattern.test(prompt)) continue;
    matchedRisk.add(word);
  }
  for (const [word, pattern] of REF_RISK_SIGNALS) {
    if (matchedRisk.has(word) || !refs.some(ref => pattern.test(ref))) continue;
    matchedRisk.add(word);
  }
  for (const word of matchedRisk) {
    inferredIntent = 'deep';
    inferredEff = 'high';
    reasons.push(`risk:${word}`);
  }

  if (refs.length > 6 || prompt.length > 20000) {
    // Stage A starts at med or high, so one capped step always yields high.
    inferredEff = 'high';
    reasons.push('large_context');
  }

  if (input.mode !== 'edit' && !input.trigger && matchedRisk.size === 0 && refs.length <= 2 && prompt.length <= 600
      && BOUNDED_LOOKUP_CUES.test(prompt) && !HEAVY_WORK_CUES.test(prompt)) {
    inferredIntent = 'fast';
    inferredEff = 'low';
    reasons.push('bounded_lookup');
  }

  if (!reasons.length) reasons.push('default');

  const hasIntent = input.intent != null;
  const hasEff = input.eff != null;
  return {
    intent: input.intent ?? inferredIntent,
    eff: input.eff ?? inferredEff,
    source: hasIntent && hasEff ? 'caller' : hasIntent || hasEff ? 'mixed' : 'inferred',
    reasons,
  };
}
