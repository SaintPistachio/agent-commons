/**
 * Shared model capability tiers, effort output-token multipliers, and per-1M-token reference pricing.
 * All routing/cost comparisons stay in the adapter layer so store.ts and runner.ts remain platform-neutral.
 */

export interface TokenRates {
  input: number;
  output: number;
}

export interface ModelRateSpec extends TokenRates {
  /** 1=Fast/Economy, 2=Balanced/Everyday, 3=Strong/Deep, 4=Frontier/Max. */
  tier: 1 | 2 | 3 | 4;
  line: string;
  /** True for promotional/vetted frontier lines (such as fable and carbon) that require confirmed account entitlement. */
  requiresEntitlement?: boolean;
}

const LINE_SPECS: ReadonlyArray<readonly [RegExp, ModelRateSpec]> = [
  [/^(?:gpt-[\d.]+-)?luna\b/i, { line: 'luna', input: 0.10, output: 0.50, tier: 1 }],
  [/^(?:gpt-[\d.]+-)?terra\b/i, { line: 'terra', input: 1.00, output: 5.00, tier: 2 }],
  [/^(?:gpt-[\d.]+-)?sol\b/i, { line: 'sol', input: 2.00, output: 10.00, tier: 3 }],
  [/^(?:gpt-[\d.]+-)?astra\b/i, { line: 'astra', input: 8.00, output: 40.00, tier: 4 }],
  [/^gpt-5\.4-mini\b/i, { line: 'mini', input: 0.75, output: 4.50, tier: 1 }],
  [/^(?:claude-)?haiku\b/i, { line: 'haiku', input: 0.10, output: 0.50, tier: 1 }],
  [/^(?:claude-)?sonnet\b/i, { line: 'sonnet', input: 2.00, output: 10.00, tier: 2 }],
  [/^(?:claude-)?opus\b/i, { line: 'opus', input: 4.00, output: 20.00, tier: 3 }],
  [/^(?:claude-)?fable\b/i, { line: 'fable', input: 8.00, output: 40.00, tier: 4, requiresEntitlement: true }],
  [/^gemini-3\.8-flash\b/i, { line: 'gemini-3.8-flash', input: 0.15, output: 0.60, tier: 1 }],
  [/^gemini-4-hydrogen\b/i, { line: 'gemini-4-hydrogen', input: 1.50, output: 7.50, tier: 1 }],
  [/^gemini-4-argon\b/i, { line: 'gemini-4-argon', input: 2.00, output: 10.00, tier: 2 }],
  [/^gemini-4-neon\b/i, { line: 'gemini-4-neon', input: 3.00, output: 15.00, tier: 3 }],
  [/^gemini-4-carbon\b/i, { line: 'gemini-4-carbon', input: 4.00, output: 20.00, tier: 4, requiresEntitlement: true }],
];

export const EFFORT_MULTIPLIERS: Record<string, number> = {
  min: 0.8,
  minimal: 0.8,
  low: 1.0,
  med: 2.0,
  medium: 2.0,
  high: 4.0,
  xhigh: 6.0,
  max: 8.0,
  ultra: 8.0,
};

const MAX_EFFORT_ORDER = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'min'] as const;

export function modelPricing(modelOrLine: string | null | undefined): ModelRateSpec | null {
  if (!modelOrLine) return null;
  const clean = modelOrLine.trim().replace(/-(?:minimal|low|medium|high|xhigh|max|ultra)$/i, '');
  for (const [pattern, spec] of LINE_SPECS) if (pattern.test(clean) || pattern.test(modelOrLine.trim())) return spec;
  return null;
}

export function effortMultiplier(effort: string | null | undefined): number {
  return (effort ? EFFORT_MULTIPLIERS[effort.toLowerCase()] : undefined) ?? EFFORT_MULTIPLIERS.medium;
}

/** Expected request cost in USD for comparing model + effort alternatives (not a billing figure). */
export function estimateExpectedCostUsd(rates: TokenRates, promptChars: number, effort?: string | null, baseOutputTokens = 1500): number {
  const inputTokens = Math.max(256, Math.ceil(Math.max(0, promptChars) / 3.5));
  const outputTokens = Math.round(baseOutputTokens * effortMultiplier(effort));
  return Number((((inputTokens * rates.input) + (outputTokens * rates.output)) / 1_000_000).toFixed(6));
}

/** Conservative worst-case turn-1 reservation estimate against max_output_tokens with a 15% safety margin. */
export function estimateWorstCaseUsd(rates: TokenRates, promptChars: number, maxOutputTokens: number): number {
  const inputTokens = Math.ceil(Math.max(0, promptChars) / 3.5) + 512;
  const raw = ((inputTokens * rates.input) + (maxOutputTokens * rates.output)) / 1_000_000;
  return Number((raw * 1.15).toFixed(6));
}

export function highestSupportedEffort(efforts: readonly string[], allowUltra = false): string | null {
  if (allowUltra && efforts.includes('ultra')) return 'ultra';
  for (const candidate of MAX_EFFORT_ORDER) if (efforts.includes(candidate)) return candidate;
  return efforts[efforts.length - 1] ?? null;
}

export function modelFamilyMatches(set: ReadonlySet<string> | undefined, modelOrFamily: string): boolean {
  if (!set || !set.size) return false;
  if (set.has(modelOrFamily)) return true;
  const spec = modelPricing(modelOrFamily);
  if (spec && set.has(spec.line)) return true;
  const prefix = spec?.line;
  if (prefix) {
    for (const item of set) {
      const itemSpec = modelPricing(item);
      if (item === prefix || itemSpec?.line === prefix) return true;
    }
  }
  return false;
}

export function isModelEntitled(
  modelOrFamily: string,
  entitled?: ReadonlySet<string>,
  unentitled?: ReadonlySet<string>,
): boolean {
  if (unentitled?.has(modelOrFamily)) return false;
  const spec = modelPricing(modelOrFamily);
  if (spec?.requiresEntitlement && unentitled?.has(spec.line)) return false;
  if (spec?.requiresEntitlement) return modelFamilyMatches(entitled, modelOrFamily);
  return true;
}

export const ENTITLEMENT_ERROR_PATTERN = /\b(not entitled|not available on your (?:account|plan|tier)|requires (?:a |an )?(?:pro|max|team|enterprise|vetted|higher) (?:plan|tier|subscription|account)|unauthorized for model|model_not_found|unsupported_model|not permitted to use model|does not have access to model)\b/i;

export interface CostEfficiencyCandidate {
  model: string;
  effort: string;
  tier: number;
  expectedUsd: number;
  dominatedBy?: string;
}

/** Evaluates model/effort pairs and flags any weaker+pricier choices (e.g. terra@max dominated by sol@medium). */
export function compareCostEfficiency(
  candidates: ReadonlyArray<{ model: string; effort: string; rates?: TokenRates; tier?: number }>,
  promptChars: number,
  baseOutputTokens = 1500,
): CostEfficiencyCandidate[] {
  const scored: CostEfficiencyCandidate[] = [];
  for (const c of candidates) {
    const spec = modelPricing(c.model);
    const rates = c.rates ?? (spec ? { input: spec.input, output: spec.output } : null);
    if (!rates) continue;
    scored.push({
      model: c.model,
      effort: c.effort,
      tier: c.tier ?? spec?.tier ?? 2,
      expectedUsd: estimateExpectedCostUsd(rates, promptChars, c.effort, baseOutputTokens),
    });
  }
  for (const item of scored) {
    const better = scored.find(other =>
      other !== item && other.tier > item.tier && other.expectedUsd <= item.expectedUsd);
    if (better) item.dominatedBy = `${better.model}@${better.effort}`;
  }
  return scored.sort((a, b) => a.expectedUsd - b.expectedUsd || b.tier - a.tier);
}
