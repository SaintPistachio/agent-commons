/** claude: the Claude Code CLI on the user's subscription (never API billing). */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Json } from '../store.ts';
import { profileGrid, type PlatformAdapter, type ProbeContext, type RouteCommand, type RunContext } from './types.ts';
import { launchCli } from './shared.ts';
import { claudeToolsetAllowed, claudeToolsetConfig, claudeToolsetDenied } from '../tool-hub.ts';
import { cliCommand, launchSelectedCli, pathCopies, registryUpstream, resolveCli, retainNativeCli, retainedCliPath, runOfficialUpdater, sameCliPath, versionedCopies, type CliRoute } from './cli-freshness.ts';
import { catalogDiscoveries, catalogSelectionStatus, chooseClaudeModel, claudeFallback, cliEfforts, queuedCliSelection, readClaudeModels } from './cli-models.ts';
import { cooldownUntil } from '../cooldown.ts';
import { ENTITLEMENT_ERROR_PATTERN, estimateExpectedCostUsd, modelPricing } from './model-pricing.ts';

const ADVICE_TOOLS = ['Read', 'Grep', 'Glob'];
const EDIT_TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'MultiEdit', 'Write'];
const PACKAGE = '@anthropic-ai/claude-code';

/** Pick the highest installed Claude version that satisfies the headless CLI contract. */
export function resolveClaude(ctx: ProbeContext) { return resolveCli(cli, ctx); }

function complete(job: Json, ctx: RunContext, cwd: string, code: number | null, reason?: string): void {
  const changed = job.mode === 'edit' ? ctx.changedFiles(cwd) : [];
  if (reason === 'CANCELLED') return ctx.finish('cancelled', { exit_code: code, error: 'CANCELLED', changed_files: changed });
  if (reason) return ctx.finish('failed', { exit_code: code, error: reason, changed_files: changed });
  let output: Json | undefined;
  try { output = JSON.parse(fs.readFileSync(path.join(ctx.dir, 'stdout.json'), 'utf8')); } catch { /* reported below */ }
  const result = typeof output?.result === 'string' ? output.result : null;
  const turns = Number.isInteger(output?.num_turns) ? output!.num_turns : null;
  // Usage as the CLI reports it (absent fields stay null).
  const usage = { tokens_in: Number.isInteger(output?.usage?.input_tokens) ? output!.usage.input_tokens : null,
    tokens_out: Number.isInteger(output?.usage?.output_tokens) ? output!.usage.output_tokens : null,
    reported_model: typeof output?.model === 'string' && output.model.startsWith('claude-') ? output.model
      : Object.keys(output?.modelUsage ?? {}).find(model => model.startsWith('claude-'))
        ?? (typeof output?.model === 'string' ? output.model : Object.keys(output?.modelUsage ?? {})[0] ?? null) };
  if (code === 0 && output && output.is_error !== true) {
    if (usage.reported_model) ctx.store.markModelValidated(claude.capabilities.id, usage.reported_model);
    return ctx.finish('completed', { exit_code: code, result, turns, changed_files: changed, ...usage });
  }
  const stderrTail = fs.readFileSync(path.join(ctx.dir, 'stderr.log'), 'utf8').slice(-500).trim();
  // A usage or rate limit is a quota stop (the store records a cooldown), not a CLI fault worth re-probing.
  const said = [result ?? '', stderrTail].join('\n');
  if (QUOTA.test(said)) {
    const until = cooldownUntil(said);
    const window = /\bweek(?:ly)?\b/i.test(said) ? 'weekly' : '5h';
    return ctx.finish('failed', { exit_code: code, result, turns, changed_files: changed, ...usage,
      error: `QUOTA_EXHAUSTED: ${said.trim().split(/\r?\n/)[0].slice(0, 300)}` },
      { usage: [{ pool: 'default', window, remaining_percent: 0, resets_at: until, closed: true }] });
  }
  const errText = [stderrTail, output?.is_error === true && typeof result === 'string' ? result : ''].join('\n');
  if (ENTITLEMENT_ERROR_PATTERN.test(errText) && typeof job.model === 'string' && job.model) {
    ctx.store.markModelUnentitled(claude.capabilities.id, job.model, errText.trim().split(/\r?\n/)[0].slice(0, 200));
  }
  ctx.finish('failed', { exit_code: code, result, turns, changed_files: changed, ...usage,
    error: output ? `CLI_ERROR: ${output.subtype ?? 'error'}` : `NO_RESULT${stderrTail ? ': ' + stderrTail : ''}` });
}
const QUOTA = /\b\d+-hour limit\b|usage limit|rate limit|limit reached|quota|too many requests|\b429\b/i;

/** Flags launch() passes; the probe checks that `claude --help` still documents each one. */
const FLAGS = ['-p, --print', '--output-format', '--permission-mode', '--allowedTools', '--model', '--effort', '--no-session-persistence', '--strict-mcp-config', '--setting-sources', '--settings', '--mcp-config', '--disallowedTools', '--add-dir'];

const cli: CliRoute = {
  id: 'claude', helpArgs: ['--help'], flags: FLAGS,
  override: options => options.claude,
  command: (file, options) => options.claude && sameCliPath(options.claude.file, file) ? options.claude : cliCommand(file, PACKAGE),
  async binaries(ctx) {
    const local = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
    const copies = ctx.options.claude ? [{ path: ctx.options.claude.file, source: 'override' }]
      : [{ path: local, source: 'native install' }, ...(await pathCopies('claude')).map(path => ({ path, source: 'PATH' })),
        { path: retainedCliPath(ctx.home, cli.id), source: 'retained before update' }];
    if (ctx.binPath) copies.push({ path: ctx.binPath, source: 'operator pin' });
    return versionedCopies(copies, file => cli.command(file, ctx.options));
  },
};

/** mcpConfig: the per-job file holding only an approved tool set's server (strict: nothing else is loaded). */
export function claudeArgs(command: RouteCommand, job: Json, mcpConfig?: string): string[] {
  const toolset = job.options?.toolset;
  return [...(command.prefix ?? []), '-p', '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config',
    '--setting-sources', 'user', '--settings', '{"disableAllHooks":true}',
    ...(toolset && mcpConfig ? ['--mcp-config', mcpConfig] : []),
    '--permission-mode', job.mode === 'edit' ? 'acceptEdits' : 'default',
    ...(job.options?.patch_turn ? ['--tools', ''] : ['--allowedTools', ...(job.mode === 'edit' ? EDIT_TOOLS : ADVICE_TOOLS),
      ...(toolset && mcpConfig ? claudeToolsetAllowed(toolset) : [])]),
    ...(toolset && mcpConfig && claudeToolsetDenied(toolset).length ? ['--disallowedTools', ...claudeToolsetDenied(toolset)] : []),
    ...(toolset && mcpConfig ? (toolset.write_roots ?? []).flatMap((root: string) => ['--add-dir', root]) : []),
    ...(job.model ? ['--model', job.model] : []), ...(job.effort ? ['--effort', job.effort] : [])];
}

export const claude: PlatformAdapter = {
  // Ceiling 1: multiple simultaneous headless runs have not been verified.
  capabilities: { id: 'claude', family: 'anthropic', transport: 'cli', billing: 'sub', modes: ['advice', 'edit'], supportsShellInEdit: false, hasWorkspaceReadTools: true,
    maxPromptChars: 200000, maxTimeoutMinutes: 240, defaultTimeoutMinutes: 30, quotaGroup: 'claude-sub', defaultModel: null, maxConcurrent: 1, maxConcurrentCeiling: 1, short: 'claude' },
  // Trusted tracked profiles can use aliases. Without trusted metadata, leave the model to the CLI.
  profiles: profileGrid(['advice', 'edit'], claudeFallback, cliEfforts),
  probe: resolveClaude,
  binaries: cli.binaries,
  upstream: () => registryUpstream(PACKAGE, ['stable', 'latest']),
  upstreamTrack: 'stable',
  estimatedCost(model: string | null, effort: string | null, promptChars: number) {
    const spec = modelPricing(model ?? 'sonnet');
    return spec ? { expectedUsd: estimateExpectedCostUsd(spec, promptChars, effort), basis: 'weight' as const } : null;
  },
  usage: reply => Array.isArray(reply?.usage) ? reply.usage : [],
  async update(ctx) {
    if (!ctx.selected || ctx.options.claude) throw new Error('a locally verified Claude CLI is required to update');
    const command = cli.command(ctx.selected.path, ctx.options);
    if (!command) throw new Error('selected Claude CLI is no longer available');
    // A retained copy is a fallback, not the original installation's update entry point.
    if (sameCliPath(ctx.selected.path, retainedCliPath(ctx.home, cli.id)))
      throw new Error('the selected Claude CLI is a rollback copy; repair the original installation first');
    await retainNativeCli(ctx, cli);
    // Apply the stable release channel for this invocation without rewriting user settings.
    await runOfficialUpdater(ctx, command, ['--settings', '{"autoUpdatesChannel":"stable"}', 'update']);
  },
  discover: async ctx => catalogDiscoveries(readClaudeModels(ctx.cliVersion ?? null, ctx.overrides.cliModelHome)),
  selectModel: (request, version) => chooseClaudeModel(request, readClaudeModels(version)),
  modelSourceStatus: version => catalogSelectionStatus(readClaudeModels(version)),
  validate: () => ({}),
  launch(job, ctx) {
    launchSelectedCli(job, ctx, cli, resolveClaude, (command, version) => {
      const choice = queuedCliSelection(readClaudeModels(version), job);
      if (choice.error) return ctx.finish('failed', { error: `MODEL_SELECTION_UNVERIFIED: ${choice.error}; resubmit after refreshing the CLI catalog` });
      if (choice.fallback) ctx.annotate({ model_source: choice.fallback });
      const dispatched = { ...job, model: choice.model, effort: choice.effort };
      let mcpConfig: string | undefined;
      if (job.options?.toolset) { mcpConfig = path.join(ctx.dir, 'mcp-toolset.json'); fs.writeFileSync(mcpConfig, claudeToolsetConfig(job.options.toolset)); }
      launchCli(job, ctx, command, () => claudeArgs(command, dispatched, mcpConfig), (cwd, code, reason) => complete(dispatched, ctx, cwd, code, reason));
    });
  },
};
