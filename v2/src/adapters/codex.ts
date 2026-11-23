/** codex: the Codex CLI on the user's ChatGPT subscription, in Codex's own sandbox, with no user config. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Json } from '../store.ts';
import { profileGrid, type PlatformAdapter, type ProbeContext, type RouteCommand, type RunContext, type UsageSnapshot } from './types.ts';
import { helperEnv, killTree, launchCli, runCapture } from './shared.ts';
import { cliCommand, directoryEntries, launchSelectedCli, pathCopies, registryUpstream, resolveCli, retainNativeCli, retainedCliPath, runOfficialUpdater, sameCliPath, versionedCopies, type CliRoute } from './cli-freshness.ts';
import { catalogDiscoveries, catalogSelectionStatus, chooseCodexModel, cliEfforts, codexLine, queuedCliSelection, readCodexModels } from './cli-models.ts';
import { codexLimits, parseCodexAppServerRateLimits } from './codex-limits.ts';
import { codexToolsetArgs } from '../tool-hub.ts';
import { ENTITLEMENT_ERROR_PATTERN, estimateExpectedCostUsd, modelPricing } from './model-pricing.ts';

const PACKAGE = '@openai/codex';
const windows = process.platform === 'win32';

async function knownCopies(): Promise<Array<{ path: string; source: string }>> {
  const home = os.homedir();
  const exe = windows ? 'codex.exe' : 'codex';
  const copies: Array<{ path: string; source: string }> = [];
  if (windows) {
    const local = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    const bin = path.join(local, 'OpenAI', 'Codex', 'bin');
    copies.push(
      { path: path.join(home, '.local', 'bin', exe), source: 'standalone install' },
      { path: path.join(home, '.codex', 'bin', exe), source: 'standalone install' },
      { path: path.join(local, 'Programs', 'OpenAI', 'Codex', 'bin', exe), source: 'desktop install' },
      { path: path.join(bin, exe), source: 'desktop cache' },
      ...directoryEntries(bin).map(folder => ({ path: path.join(bin, folder, exe), source: 'desktop cache' })),
    );
  }
  for (const kind of ['standalone', 'app-server-daemon']) {
    const releases = path.join(home, '.codex', 'packages', kind, 'releases');
    for (const entry of directoryEntries(releases)) copies.push({ path: path.join(releases, entry, 'bin', exe), source: kind });
  }
  const [onPath, packages, userPath] = await Promise.all([
    pathCopies('codex'),
    windows ? runCapture({ file: 'powershell.exe' }, ['-NoProfile', '-NonInteractive', '-Command',
      '(Get-AppxPackage OpenAI.Codex).InstallLocation'], 10_000) : null,
    // The installer can add a user PATH entry that is not yet in this service's inherited PATH.
    windows ? runCapture({ file: 'powershell.exe' }, ['-NoProfile', '-NonInteractive', '-Command',
      '[Environment]::ExpandEnvironmentVariables([string][Environment]::GetEnvironmentVariable("Path","User"))'], 10_000) : null,
  ]);
  if (userPath?.code === 0) for (const item of userPath.out.trim().split(';')) {
    const dir = item.trim().replace(/^"(.*)"$/, '$1');
    if (path.isAbsolute(dir)) copies.push({ path: path.join(dir, exe), source: 'user PATH' });
  }
  if (packages?.code === 0) for (const line of packages.out.split(/\r?\n/)) {
    const root = line.trim();
    if (path.isAbsolute(root)) copies.push({ path: path.join(root, 'app', 'resources', exe), source: 'app package' });
  }
  return copies.concat(onPath.map(path => ({ path, source: 'PATH' })));
}

/** Pick the highest installed Codex version that satisfies the headless CLI contract. */
export function resolveCodex(ctx: ProbeContext) { return resolveCli(cli, ctx); }

/** Codex: the answer is the last-message file; JSON events give turn count and any error (such as a usage limit). */
function complete(job: Json, ctx: RunContext, cwd: string, code: number | null, reason?: string): void {
  const changed = job.mode === 'edit' ? ctx.changedFiles(cwd) : [];
  let turns = 0, eventError: string | null = null, tokensIn: number | null = null, tokensOut: number | null = null;
  const limitEvents: Json[] = [];
  for (const line of fs.readFileSync(path.join(ctx.dir, 'stdout.json'), 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: Json; try { event = JSON.parse(line); } catch { continue; }
    if (!event || typeof event !== 'object') continue;
    if (event.rate_limits || event.payload?.rate_limits) limitEvents.push(event);
    if (event.type === 'turn.completed') {
      turns++;
      if (Number.isInteger(event.usage?.input_tokens)) tokensIn = (tokensIn ?? 0) + event.usage.input_tokens;
      if (Number.isInteger(event.usage?.output_tokens)) tokensOut = (tokensOut ?? 0) + event.usage.output_tokens;
    }
    // The first error event carries the descriptive message; turn.failed only fills in when there is none.
    if (event.type === 'error' && !eventError) eventError = String(event.message ?? event.type).slice(0, 300);
    if (event.type === 'turn.failed' && !eventError) eventError = String(event.error?.message ?? event.type).slice(0, 300);
  }
  const file = path.join(ctx.dir, 'last-message.txt');
  const result = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const limits = codexLimits(limitEvents, ctx.usage());
  // Quota observations remain useful even when the CLI chose an unknown model.
  const reply = { usage: limits.usage,
    ...(typeof job.model === 'string' && job.model ? { consumption: { family: codexLine(job.model), rows: limits.evidence } } : {}) };
  const fields = { exit_code: code, result, turns, changed_files: changed, tokens_in: tokensIn, tokens_out: tokensOut,
    cooldown_until: limits.cooldownUntil };
  if (reason) return ctx.finish(reason === 'CANCELLED' ? 'cancelled' : 'failed', { ...fields, error: reason }, reply);
  if (code === 0 && result?.trim() && !eventError) {
    if (typeof job.model === 'string' && job.model) ctx.store.markModelValidated(codex.capabilities.id, job.model);
    return ctx.finish('completed', fields, reply);
  }
  const stderrTail = fs.readFileSync(path.join(ctx.dir, 'stderr.log'), 'utf8').slice(-500).trim();
  const message = eventError ?? stderrTail;
  const quota = limits.reached || /usage limit|rate limit|quota/i.test(message);
  if (!quota && ENTITLEMENT_ERROR_PATTERN.test(message) && typeof job.model === 'string' && job.model) {
    ctx.store.markModelUnentitled(codex.capabilities.id, job.model, message.slice(0, 200));
  }
  const error = quota ? `QUOTA_EXHAUSTED: ${message || 'CLI rate limit'}`
    : message ? `CLI_ERROR: ${message}` : 'NO_RESULT';
  ctx.finish('failed', { ...fields, error }, reply);
}

/** Check the documented long names for the flags used at launch, including short aliases. */
const FLAGS = ['--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--sandbox', '--cd', '--output-last-message', '--model', '--config', '--add-dir'];

const cli: CliRoute = {
  id: 'codex', helpArgs: ['exec', '--help'], flags: FLAGS,
  override: options => options.codex,
  command: (file, options) => options.codex && sameCliPath(options.codex.file, file) ? options.codex : cliCommand(file, PACKAGE),
  async binaries(ctx) {
    const copies = ctx.options.codex ? [{ path: ctx.options.codex.file, source: 'override' }]
      : [...await knownCopies(), { path: retainedCliPath(ctx.home, cli.id), source: 'retained before update' }];
    if (ctx.binPath) copies.push({ path: ctx.binPath, source: 'operator pin' });
    return versionedCopies(copies, file => cli.command(file, ctx.options));
  },
};

export function codexArgs(command: RouteCommand, job: Json, cwd: string, dir: string): string[] {
  return [...(command.prefix ?? []), 'exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
    '-s', job.mode === 'edit' ? 'workspace-write' : 'read-only', '-C', cwd, '-o', path.join(dir, 'last-message.txt'),
    ...(job.options?.patch_turn ? ['-c', 'features.shell_tool=false', '-c', 'features.unified_exec=false', '-c', 'features.code_mode=false',
      '-c', 'features.request_permissions_tool=false', '-c', 'web_search="disabled"'] : []),
    ...(job.model ? ['-m', job.model] : []),
    ...(job.effort ? ['-c', `model_reasoning_effort="${job.effort}"`] : []),
    // An approved tool set: only its MCP server, defined by -c overrides because no user config is loaded.
    ...(job.options?.toolset ? codexToolsetArgs(job.options.toolset) : [])];
}

const APP_SERVER_TIMEOUT_MS = 15_000;
const APP_SERVER_MAX_BYTES = 512 * 1024;

/**
 * Query Codex subscription rate limits without sending a prompt via `codex app-server` (`account/rateLimits/read`).
 * Experimental RPC: any error, timeout, or schema mismatch soft-fails to `undefined` without blocking the route.
 */
async function readAppServerUsage(ctx: ProbeContext): Promise<UsageSnapshot | undefined> {
  const command = ctx.options.codex ?? (ctx.selected?.path ? cli.command(ctx.selected.path, ctx.options) : undefined);
  if (!command) return undefined;
  const startedAt = new Date().toISOString();
  try {
    return await new Promise<UsageSnapshot | undefined>(resolve => {
      const child = spawn(command.file, [...(command.prefix ?? []), 'app-server', '-c', 'mcp_servers={}'], {
        cwd: os.tmpdir(), env: helperEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: !windows,
      });
      let settled = false, exited = false, initialized = false, bytes = 0;
      const lines = readline.createInterface({ input: child.stdout });
      const finish = (snapshot?: UsageSnapshot) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        lines.close();
        try { child.stdin.end(); } catch { /* ignore */ }
        if (!exited && child.pid) killTree(child.pid);
        resolve(snapshot);
      };
      const timer = setTimeout(() => finish(), APP_SERVER_TIMEOUT_MS);
      const send = (msg: object) => {
        try { child.stdin.write(JSON.stringify(msg) + '\n'); } catch { finish(); }
      };
      child.on('error', () => finish());
      child.on('exit', () => { exited = true; finish(); });
      child.stdin.on('error', () => finish());
      child.stdout.on('error', () => finish());
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > APP_SERVER_MAX_BYTES) finish();
      });
      child.stderr.on('error', () => finish());
      child.stderr.resume();
      lines.on('line', line => {
        if (settled) return;
        let msg: Json;
        try { msg = JSON.parse(line); } catch { return; }
        if (!msg || typeof msg !== 'object' || msg.method !== undefined || (msg.id !== 1 && msg.id !== 2)) return;
        if (msg.error !== undefined) return finish();
        if (msg.id === 1 && !initialized) {
          initialized = true;
          send({ method: 'initialized' });
          send({ id: 2, method: 'account/rateLimits/read' });
        } else if (msg.id === 2) {
          const rows = parseCodexAppServerRateLimits(msg.result, ctx.usage ?? [], Date.now(), startedAt);
          finish(rows ? { rows, source: 'app-server' } : undefined);
        }
      });
      send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'agent-commons', title: 'Agent Commons', version: ctx.cliVersion ?? '2.0.0' } } });
    });
  } catch { return undefined; }
}

export const codex: PlatformAdapter = {
  // Ceiling 1: multiple simultaneous headless runs have not been verified.
  capabilities: { id: 'codex', family: 'openai', transport: 'cli', billing: 'sub', modes: ['advice', 'edit'], supportsShellInEdit: true, hasWorkspaceReadTools: true,
    maxPromptChars: 200000, maxTimeoutMinutes: 240, defaultTimeoutMinutes: 30, quotaGroup: 'codex-sub', defaultModel: null, maxConcurrent: 1, maxConcurrentCeiling: 1, short: 'codex' },
  // Tracking resolves a concrete slug from the matched cache; otherwise the CLI chooses its default.
  profiles: profileGrid(['advice', 'edit'], () => null, cliEfforts),
  probe: resolveCodex,
  binaries: cli.binaries,
  upstream: () => registryUpstream(PACKAGE, ['latest']),
  estimatedCost(model: string | null, effort: string | null, promptChars: number) {
    const spec = modelPricing(model ?? 'gpt-6.2-sol');
    return spec ? { expectedUsd: estimateExpectedCostUsd(spec, promptChars, effort), basis: 'weight' as const } : null;
  },
  update: windows ? async ctx => {
    if (ctx.options.codex) throw new Error('cannot update an injected Codex command');
    // The standalone installer does not update npm packages; npm shims remain separate fallback copies.
    const selected = ctx.selected && cli.command(ctx.selected.path, ctx.options);
    if (!selected?.prefix?.length) await retainNativeCli(ctx, cli);
    await runOfficialUpdater(ctx, { file: 'powershell.exe' }, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'ByPass', '-Command',
      "$ErrorActionPreference = 'Stop'; irm https://chatgpt.com/codex/install.ps1 | iex",
    ]);
  } : undefined,
  discover: async ctx => catalogDiscoveries(readCodexModels(ctx.cliVersion ?? null, ctx.overrides.cliModelHome)),
  selectModel: (request, version) => chooseCodexModel(request, readCodexModels(version)),
  modelSourceStatus: version => catalogSelectionStatus(readCodexModels(version)),
  validate: () => ({}),
  observeUsage: readAppServerUsage,
  usage: reply => reply.usage,
  consumption: reply => reply.consumption,
  launch(job, ctx) {
    // Use the job's sandbox and do not load user config or save a session.
    launchSelectedCli(job, ctx, cli, resolveCodex, (command, version) => {
      const choice = queuedCliSelection(readCodexModels(version), job);
      if (choice.error) return ctx.finish('failed', { error: `MODEL_SELECTION_UNVERIFIED: ${choice.error}; resubmit after refreshing the CLI cache` });
      if (choice.fallback) ctx.annotate({ model_source: choice.fallback });
      const dispatched = { ...job, model: choice.model, effort: choice.effort };
      launchCli(job, ctx, command, cwd => codexArgs(command, dispatched, cwd, ctx.dir), (cwd, code, reason) => complete(dispatched, ctx, cwd, code, reason));
    });
  },
};
