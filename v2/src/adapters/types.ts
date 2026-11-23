/**
 * The platform adapter contract. Each worker route (claude, codex, antigravity, openai-api, and any future one) is
 * one module implementing PlatformAdapter, registered in registry.ts. The store, runner and tool catalog ask the
 * registry instead of naming platforms.
 */
import type { ChildProcess } from 'node:child_process';
import type { Store, Json } from '../store.ts';
import type { preflightPatchCheck, runPatchCheck } from '../patch-check.ts';

/** How to start a route's CLI. `prefix` lets tests run a fake CLI through node. */
export interface RouteCommand { file: string; prefix?: string[]; cwd?: string }
export interface RunnerOptions {
  claude?: RouteCommand;
  codex?: RouteCommand;
  /** The original central OpenAI helper (`python run.py`); it alone admits and accounts for API spending.
   * Its status reports sync_concurrency_limit 8, the source for the openai-api route's unchanged ceiling. */
  openaiHelper?: RouteCommand;
  /** The guarded antigravity-helper (`pwsh -File Invoke-Antigravity.ps1`); reasoning only, included Google quota. */
  antigravity?: RouteCommand;
  routeLimits?: Record<string, number>;
  /** Jobs running at once across all routes when the operator set no global limit (default 3). An operator's `limits` setting wins. */
  globalLimit?: number;
  tickMs?: number;
  /** Injected only by in-process fixtures. Production checks use the local container runner. */
  patchCheck?: { preflight: typeof preflightPatchCheck; run: typeof runPatchCheck };
}

export type BillingClass = 'local' | 'sub' | 'paid';
export interface AdapterCapabilities {
  id: string;
  /** Model family, for cross-family review: 'anthropic', 'openai', 'google', 'local', ... */
  family: string;
  transport: 'cli' | 'helper' | 'http';
  billing: BillingClass;
  modes: Array<'advice' | 'edit'>;
  supportsShellInEdit: boolean;
  /** Advice jobs can inspect repository files directly without ctx= (read-only tools or sandbox). */
  hasWorkspaceReadTools?: boolean;
  maxPromptChars: number;
  maxTimeoutMinutes: number;
  defaultTimeoutMinutes: number;
  /** Routes that draw on the same quota share a group. */
  quotaGroup: string;
  /** Jobs this route runs at once (the runner's default per-route limit). */
  maxConcurrent: number;
  /** Hard upper bound for an operator's per-route limit (`cli.ts limits`); never below maxConcurrent. */
  maxConcurrentCeiling: number;
  /** Name on the R route-status line. */
  short: string;
  /** Model used when the job names none (null: the platform's own default). */
  defaultModel: string | null;
}

/** A launched job's process and why it was stopped, if it was. */
export interface Active {
  child?: ChildProcess;
  timer?: NodeJS.Timeout;
  reason?: string;
  /** Stops helpers the job owns besides child (an API job's MCP server). */
  cleanup?: () => void;
  /** Extra DB fields (recorded spend/tokens/transcript) to persist if Runner.stop() ends the job early. */
  stopFields?: () => Json;
}

export interface UsageObservation {
  pool: string;
  window: string;
  remaining_percent: number | null;
  resets_at: string | null;
  /** Omitted for a fresh observation made by the current process. */
  observed_at?: string;
  /** Positive evidence that this window blocks its pool until resets_at. */
  closed?: boolean;
}
export interface UsageWindow extends UsageObservation {
  route: string;
  observed_at: string;
  source: string;
  stale: boolean;
}

export interface ConsumptionRow {
  pool: string;
  window: string;
  consumed: boolean;
}
export interface Consumption {
  /** The model family, not its vendor. */
  family: string;
  rows: ConsumptionRow[];
}
export interface PoolEvidence {
  route: string;
  family: string;
  pool: string;
  window: string;
  runs: number;
  consumed_runs: number;
  last_seen_at: string;
  last_job_id: string;
}
/** Retained comparisons establish which pools were observed together in the same job. */
export interface ConsumptionRun extends Consumption {
  job_id: string;
  last_seen_at: string;
}

/** What the runner gives an adapter to run one job. Every method acts on that job. */
export interface RunContext {
  readonly store: Store;
  readonly home: string;
  readonly options: RunnerOptions;
  /** The job's folder under <home>/jobs (already created). */
  readonly dir: string;
  /** Records observations from a parsed reply, records the outcome, and forgets the process. */
  finish(status: string, fields?: Json, reply?: Json): void;
  /** Latest observations; expired observations have unknown remaining allowance. */
  usage(): UsageWindow[];
  /** Shallow-merges adapter annotations into this job's options. */
  annotate(options: Json): void;
  /** The tagged family of the actor whose work this job reviews, when known. */
  reviewFamily(): string | null;
  /** Starts tracking the job's process (for timeouts, cancellation and stop()). */
  track(active: Active): void;
  /** The tracked process record, if the job is still tracked. */
  active(): Active | undefined;
  /** Advice: the project root. Edit: a new git worktree on branch ac/job-<id>. Throws if it cannot be prepared. */
  prepareWorkdir(): string;
  changedFiles(cwd: string): string[];
}

export interface ReconcileContext { readonly store: Store; readonly options: RunnerOptions; readonly home?: string }

/** Platform-neutral job intent and effort (fabric Stage 2b). Profiles map them to each platform's own model and effort. */
export const INTENTS = ['fast', 'code', 'review', 'deep', 'edit'] as const;
export const EFFORTS = ['min', 'low', 'med', 'high', 'max'] as const;
export type Intent = typeof INTENTS[number];
export type Eff = typeof EFFORTS[number];
/** One seeded row of platform_profiles. `options` fills job fields the caller left out (for example antigravity's task). */
export interface ProfileSeed {
  intent: Intent;
  eff: Eff;
  model: string | null;
  effort: string | null;
  options?: Json;
  replaces?: { native_model: string | null; native_effort: string | null };
  /** Earlier shipped seeds, including a seed whose successor moved to a different model line. */
  previousSeeds?: Array<{ native_model: string | null; native_effort: string | null }>;
}
/** Every intent (except edit unless the route can edit) crossed with every eff. */
export function profileGrid(modes: AdapterCapabilities['modes'], model: (intent: Intent, eff: Eff) => string | null, effort: Record<Eff, string | null>,
  options?: (intent: Intent) => Json | undefined, replaces?: (intent: Intent, eff: Eff) => ProfileSeed['replaces']): ProfileSeed[] {
  return INTENTS.filter(intent => intent !== 'edit' || modes.includes('edit'))
    .flatMap(intent => EFFORTS.map(eff => {
      const previous = replaces?.(intent, eff);
      return { intent, eff, model: model(intent, eff), effort: effort[eff], ...(options?.(intent) ? { options: options(intent) } : {}), ...(previous ? { replaces: previous } : {}) };
    }));
}

export const MODEL_STATES = ['discovered', 'verified', 'validated', 'preferred', 'retired'] as const;
export type ModelState = typeof MODEL_STATES[number];
export interface ModelDiscovery {
  model: string;
  family?: string;
  efforts?: string[];
  /** Registry tiers, including any tiers the adapter lists but cannot submit. */
  tiers?: string[];
  state?: ModelState;
  source: string;
  /** Discoverable and explicitly selectable, but excluded from automatic selection. */
  hidden?: boolean;
}

export interface ModelChoiceRequest {
  intent: Intent;
  eff: Eff;
  model: string | null;
  effort: string | null;
  explicitModel: boolean;
  explicitEffort: boolean;
  tracksLatest: boolean;
  /** The caller or operator deliberately requested the premium profile. */
  allowPremium: boolean;
  /** Models empirically or operator-confirmed as entitled on this route. */
  entitledModels?: ReadonlySet<string>;
  /** Models observed or marked as unentitled/unavailable on this route. */
  unentitledModels?: ReadonlySet<string>;
}
export interface ModelSourceFallback {
  state: 'fallback';
  reason: string;
}
export type ModelChoice = { model: string | null; effort: string; source: string | ModelSourceFallback; error?: never } |
  { error: string; model?: never; effort?: never; source?: never };
/**
 * A metadata snapshot. Complete sources may retire missing entries after two successful snapshots.
 * An explicit empty list means no source was completely enumerated (for example an optional catalog was absent).
 */
export type ModelDiscoveries = ModelDiscovery[] & { completeSources?: string[] };

export interface CliBinary { path: string; version: string; source: string }
export interface CliUpstream { stable?: string; latest?: string; source: string }
export interface CliFreshness {
  pin: string | null;
  installed: CliBinary[];
  upstream: CliUpstream | null;
  /** Prevent a scan started before an update from publishing stale selection data. */
  updateEpoch?: string | null;
}

export interface CliUpdateContext extends ProbeContext {
  readonly selected?: CliBinary;
  readonly targetVersion: string;
  readonly logPath: string;
}

/** A probe's finding. Probes never send a prompt to a model and never write to another app's files. */
export interface ProbeResult {
  state: 'verified' | 'drifted' | 'blocked' | 'unavailable';
  binarySha256?: string | null;
  cliVersion?: string | null;
  helpSha256?: string | null;
  reason?: string | null;
  binary?: CliBinary;
}
/** Test seams for probes that read fixed locations, and which adapters a Prober covers. */
export interface ProbeOverrides {
  antigravityHelperRoot?: string;
  antigravityCli?: string;
  adapters?: string[];
  schedule?: boolean;
  /** Test seams: production discovery always refreshes official documentation. */
  openaiModelRefresh?: boolean;
  openaiFetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Replace CLI metadata I/O in tests, including the flag contract check. */
  binaries?: (route: string) => Promise<CliBinary[]>;
  upstream?: (route: string) => Promise<CliUpstream | null>;
  cliProbe?: (route: string, binary: CliBinary) => Promise<ProbeResult>;
  /** Replace the adapter's updater process in tests. */
  cliUpdate?: (route: string, ctx: CliUpdateContext) => Promise<void>;
  /** The CLI's configuration directory, for discovery fixtures. */
  cliModelHome?: string;
  /** Local interpreter and package-index seams for helper SDK maintenance. */
  openaiSdkRun?: import('./openai-sdk.ts').SdkProcessRunner;
  openaiSdkFetch?: typeof fetch;
}
export interface ProbeContext {
  readonly home: string;
  readonly options: RunnerOptions;
  readonly overrides: ProbeOverrides;
  readonly binPath?: string | null;
  readonly installed?: CliBinary[];
  /** The version of the verified, selected executable, not an upstream or PATH version. */
  readonly cliVersion?: string | null;
  /** The verified selected CLI binary from platform_state, when available. */
  readonly selected?: CliBinary;
  /** Latest known usage windows for this route, when available. */
  readonly usage?: UsageWindow[];
}

export interface UsageSnapshot {
  rows: UsageObservation[];
  source: string;
}

export interface SdkSnapshot {
  installed: string | null;
  latest: string | null;
}

export interface SdkUpdateContext extends ProbeContext {
  readonly targetVersion: string;
  readonly logPath: string;
}

export interface RouteValidationContext {
  mode: string;
  minutes: number;
  /** Values actually stored on the job, after resolving profiles and defaults. */
  model?: string | null;
  effort?: string | null;
  options?: RunnerOptions;
  home?: string;
}

export interface PlatformAdapter {
  readonly capabilities: AdapterCapabilities;
  /** Seed rows for platform_profiles; only an exact declared replaces model/effort pair may be upgraded. */
  readonly profiles: ProfileSeed[];
  /** Read-only health check: CLI identity and the flags Agent Commons relies on, or the platform's own approval record. */
  probe(ctx: ProbeContext): Promise<ProbeResult>;
  binaries?(ctx: ProbeContext): Promise<CliBinary[]>;
  upstream?(ctx: ProbeContext): Promise<CliUpstream>;
  /** Which upstream tag is the supported baseline. Defaults to latest. */
  readonly upstreamTrack?: 'stable' | 'latest';
  /** Run the official stable-channel updater. Throw on failure; append process output to ctx.logPath. */
  update?(ctx: CliUpdateContext): Promise<void>;
  /** Optional helper dependency maintenance. Neither hook may invoke the provider. */
  sdk?: {
    inspect(ctx: ProbeContext): Promise<SdkSnapshot>;
    update(ctx: SdkUpdateContext): Promise<void>;
  };
  /** Metadata only: never submits a prompt or invokes a model. */
  discover?(ctx: ProbeContext): Promise<ModelDiscoveries>;
  /** Resolves a tracked profile or checks a pinned/explicit choice using current local metadata. */
  selectModel?(request: ModelChoiceRequest, cliVersion: string | null): ModelChoice;
  /** Effective native effort after adapter-specific fitting/clamping, when constrained. */
  effectiveEffort?(taskOrIntent: string, nativeEffort: string): string | null;
  /** Estimated USD cost for routing tie-breaking and dry-run planning (read-only). */
  estimatedCost?(model: string | null, effort: string | null, promptChars: number, options?: Json): {
    expectedUsd: number; worstCaseUsd?: number; basis: 'pricing' | 'weight';
  } | null;
  /** Pre-flight budget check after prompt and context sizes are known; throws CommonsError when over cap. */
  checkBudget?(ctx: { model: string | null; effort: string | null; promptChars: number; options: Json; input: Json; home?: string }): void;
  /** Read-only current source health; does not refresh another application's cache. */
  modelSourceStatus?(cliVersion: string | null): string;
  /** Persisted, read-only inventory summary for the route's status line, including refresh failures. */
  discoverySummary?(ctx: ProbeContext): string;
  /** Active routable model IDs from the adapter's authoritative local registry, if any (read-only). */
  activeModels?(ctx: { home: string; options?: RunnerOptions }): Iterable<string>;
  /**
   * Route-specific job_submit rules, after the store's general checks (route known, mode advice/edit, project root,
   * timeout 1-240). Throws CommonsError; returns the options stored on the job.
   */
  validate(input: Json, job: RouteValidationContext): Json;
  launch(job: Json, ctx: RunContext): void;
  /**
   * Reads usage at probe time, after terminal job events and on the usage refresh timer. Never sends a prompt or
   * spends money: local evidence, or a read-only quota report such as Antigravity's `/usage`.
   */
  observeUsage?(ctx: ProbeContext): Promise<UsageSnapshot | undefined>;
  /** Extracts observations from a reply already received during a job; never performs I/O. */
  usage?(reply: Json): UsageObservation[];
  /** Compares quota windows in an existing reply. Resets and missing comparisons are not evidence. */
  consumption?(reply: Json): Consumption | undefined;
  /** Reads only this adapter's saved output for a finished job. Never launches or resubmits work. */
  backfillConsumption?(job: { id: string }, home: string): Consumption | undefined;
  /** Human-readable interpretation of recorded evidence, including conflicts with local metadata. */
  poolEvidenceStatus?(evidence: PoolEvidence[], runs: ConsumptionRun[]): string[];
  /** After a service restart: record an outcome the platform still knows about. Never resubmits. */
  reconcile?(job: Json, ctx: ReconcileContext): Promise<void>;
}
