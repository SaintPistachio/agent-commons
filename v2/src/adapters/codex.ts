/** codex: the Codex CLI on the user's ChatGPT subscription, in Codex's own sandbox, with no user config. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Json } from '../store.ts';
import { profileGrid, type ModelDiscoveries, type PlatformAdapter, type ProbeContext, type RouteCommand, type RunContext, type UsageDiagnostic, type UsageSnapshot } from './types.ts';
import { helperEnv, killTree, launchCli, runCapture } from './shared.ts';
import { cliCommand, directoryEntries, launchSelectedCli, pathCopies, registryUpstream, resolveCli, retainNativeCli, retainedCliPath, runOfficialUpdater, sameCliPath, versionedCopies, type CliRoute } from './cli-freshness.ts';
import { catalogDiscoveries, catalogSelectionStatus, chooseCodexModel, cliEfforts, codexLine, queuedCliSelection, readCodexModels } from './cli-models.ts';
import { codexLimits, parseCodexAppServerRateLimits, parseCodexResetCredits } from './codex-limits.ts';
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
const MODEL_PAGE_LIMIT = 8;
const MODEL_PAGE_SIZE = 64;
const MODEL_LIST_SOURCES = ['app-server', 'app-server:hidden', 'cli-cache', 'cli-cache:hidden'];

type AppServerMethod = 'model/list';
type AppServerResult<T> = { value: T } | { cursor: string };

const appServerCommand = (ctx: ProbeContext): RouteCommand | undefined =>
  ctx.options.codex ?? (ctx.selected?.path ? cli.command(ctx.selected.path, ctx.options) : undefined);

const appServerArgs = (command: RouteCommand): string[] =>
  [...(command.prefix ?? []), 'app-server', '-c', 'mcp_servers={}', '-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"'];

/** Only metadata requests are sent. Each child owns one bounded observation. */
async function readAppServer<T>(ctx: ProbeContext, method: AppServerMethod,
  read: (result: unknown) => AppServerResult<T>, reset?: () => void): Promise<T | undefined> {
  const command = appServerCommand(ctx);
  if (!command) return undefined;
  const readingModels = method === 'model/list';
  return new Promise<T | undefined>((resolve, reject) => {
    const child = spawn(command.file, appServerArgs(command), {
      cwd: os.tmpdir(), env: helperEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: !windows,
    });
    let settled = false, exited = false, initialized = false, bytes = 0, responseId = 1;
    let accountChanged = false, restarted = false;
    const cursors = new Set<string>();
    const countBytes = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > APP_SERVER_MAX_BYTES) finish(undefined, 'output limit exceeded');
    };
    child.stdout.on('data', countBytes);
    child.stderr.on('data', countBytes);
    const lines = readline.createInterface({ input: child.stdout });
    const finish = (snapshot?: T, failure?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      try { child.stdin.end(); } catch { /* ignore */ }
      if (!exited && child.pid) killTree(child.pid);
      if (failure) reject(new Error(`Codex ${method}: ${failure}`));
      else resolve(snapshot);
    };
    const timer = setTimeout(() => finish(undefined, 'timed out'), APP_SERVER_TIMEOUT_MS);
    const send = (msg: object) => {
      try { child.stdin.write(JSON.stringify(msg) + '\n'); } catch { finish(undefined, 'write failed'); }
    };
    const request = (cursor?: string) => {
      if (readingModels && responseId > MODEL_PAGE_LIMIT)
        return finish(undefined, 'pagination did not finish within its bounds');
      responseId++;
      send({ id: responseId, method, ...(readingModels ? {
        params: { limit: MODEL_PAGE_SIZE, includeHidden: true, ...(cursor === undefined ? {} : { cursor }) },
      } : {}) });
    };
    child.on('error', () => finish(undefined, 'process could not start'));
    child.on('exit', () => { exited = true; });
    child.on('close', () => finish(undefined, 'process closed before a complete response'));
    child.stdin.on('error', () => finish(undefined, 'write failed'));
    child.stdout.on('error', () => finish(undefined, 'output read failed'));
    child.stderr.on('error', () => finish(undefined, 'error output read failed'));
    lines.on('line', line => {
      if (settled || !line.trim()) return;
      let msg: Json;
      try { msg = JSON.parse(line); } catch {
        if (readingModels) finish(undefined, 'malformed protocol frame');
        return;
      }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
        if (readingModels) finish(undefined, 'malformed protocol frame');
        return;
      }
      if (msg.method !== undefined) {
        if (readingModels && initialized && msg.method === 'account/updated' && msg.id === undefined)
          accountChanged = true;
        return;
      }
      if (msg.id !== responseId) return;
      if (msg.error !== undefined) {
        // Older binaries can explicitly lack model/list. Do not fall back after a partial listing.
        if (readingModels && initialized && responseId === 2 && msg.error?.code === -32601) return finish();
        return finish(undefined, 'request was rejected');
      }
      if (msg.id === 1 && !initialized) {
        if (readingModels && (!msg.result || typeof msg.result !== 'object' || Array.isArray(msg.result)))
          return finish(undefined, 'invalid initialization response');
        initialized = true;
        send({ method: 'initialized' });
        request();
        return;
      }
      // A native client can announce its account as initialization settles. Repeat the
      // whole list once, so a page from the previous account state is never carried over.
      if (accountChanged) {
        if (restarted) return finish(undefined, 'account changed during listing');
        restarted = true;
        accountChanged = false;
        cursors.clear();
        reset?.();
        request();
        return;
      }
      try {
        const result = read(msg.result);
        if ('value' in result) return finish(result.value);
        if (cursors.has(result.cursor))
          return finish(undefined, 'pagination did not finish within its bounds');
        cursors.add(result.cursor);
        request(result.cursor);
      } catch {
        finish(undefined, 'malformed metadata response');
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'agent-commons', title: 'Agent Commons', version: ctx.cliVersion ?? '2.0.0' } } });
  });
}

/**
 * Bounded read-only quota handshake (`initialize` -> `account/read` -> `account/rateLimits/read`),
 * verifying account scope without persisting credentials or PII, and reporting structured diagnostics.
 */
async function readAppServerUsage(ctx: ProbeContext): Promise<UsageSnapshot | undefined> {
  const command = appServerCommand(ctx);
  if (!command) return undefined;
  const startedAt = new Date().toISOString();
  return new Promise<UsageSnapshot | undefined>(resolve => {
    const child = spawn(command.file, appServerArgs(command), {
      cwd: os.tmpdir(), env: helperEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: !windows,
    });
    let settled = false, exited = false, bytes = 0, responseId = 1;
    let stage: 'initialize' | 'account' | 'rateLimits' = 'initialize';
    let legacyRateLimits = false;
    let verifiedAccountId: string | undefined;
    let accountScope: string | undefined;

    const fail = (kind: string, method?: string, code?: number) => {
      const diagnostic: UsageDiagnostic = { kind, ...(method ? { method } : {}), ...(code !== undefined ? { code } : {}), at: new Date().toISOString() };
      finish(undefined, diagnostic);
    };
    const finish = (snapshot?: UsageSnapshot, diagnostic?: UsageDiagnostic) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      try { child.stdin.end(); } catch { /* ignore */ }
      if (!exited && child.pid) killTree(child.pid);
      if (diagnostic) ctx.onUsageError?.(diagnostic);
      resolve(snapshot);
    };
    const countBytes = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > APP_SERVER_MAX_BYTES) fail('protocol', stage === 'initialize' ? 'initialize' : stage === 'account' ? 'account/read' : 'account/rateLimits/read');
    };
    child.stdout.on('data', countBytes);
    child.stderr.on('data', countBytes);
    const lines = readline.createInterface({ input: child.stdout });
    const timer = setTimeout(() => fail('timeout', stage === 'initialize' ? 'initialize' : stage === 'account' ? 'account/read' : 'account/rateLimits/read'), APP_SERVER_TIMEOUT_MS);
    const send = (msg: object) => {
      try { child.stdin.write(JSON.stringify(msg) + '\n'); }
      catch { fail('disconnected'); }
    };
    const sendAccountRead = () => {
      stage = 'account';
      responseId++;
      send({ id: responseId, method: 'account/read', params: { refreshToken: false } });
    };
    const sendRateLimitsRead = (omitParams = false) => {
      stage = 'rateLimits';
      responseId++;
      send({ id: responseId, method: 'account/rateLimits/read', ...(omitParams ? {} : { params: { excludeResetCreditDetails: false } }) });
    };

    child.on('error', () => fail('launch'));
    child.on('exit', () => { exited = true; });
    child.on('close', code => fail('processExit', undefined, typeof code === 'number' ? code : undefined));
    child.stdin.on('error', () => fail('disconnected'));
    child.stdout.on('error', () => fail('disconnected'));
    child.stderr.on('error', () => fail('disconnected'));

    lines.on('line', line => {
      if (settled || !line.trim()) return;
      let msg: Json;
      try { msg = JSON.parse(line); } catch { return; }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
      if (msg.method !== undefined || msg.id !== responseId) return;

      if (stage === 'initialize') {
        if (msg.error !== undefined) {
          return fail('server', 'initialize', typeof msg.error?.code === 'number' ? msg.error.code : undefined);
        }
        send({ method: 'initialized' });
        sendAccountRead();
        return;
      }

      if (stage === 'account') {
        if (msg.error !== undefined) {
          if (msg.error?.code === -32601) {
            sendRateLimitsRead();
            return;
          }
          return fail('server', 'account/read', typeof msg.error?.code === 'number' ? msg.error.code : undefined);
        }
        const res = msg.result;
        if (!res || typeof res !== 'object' || Array.isArray(res)) {
          return fail('protocol', 'account/read');
        }
        if (res.account === null) {
          return fail(res.requiresOpenaiAuth === false ? 'unsupportedAccount' : 'signedOut', 'account/read');
        }
        if (res.account && typeof res.account === 'object' && typeof res.account.type === 'string') {
          const kind = res.account.type.toLowerCase();
          if (kind === 'apikey' || kind === 'amazonbedrock') {
            return fail('unsupportedAccount', 'account/read');
          }
        }
        const routing = res.workspaceRouting && typeof res.workspaceRouting === 'object' && !Array.isArray(res.workspaceRouting)
          ? res.workspaceRouting : undefined;
        if (typeof routing?.chatgptAccountId === 'string' && routing.chatgptAccountId) {
          verifiedAccountId = routing.chatgptAccountId;
          const origin = typeof routing.backendOrigin === 'string' ? routing.backendOrigin : '';
          const plan = typeof res.account?.planType === 'string' ? res.account.planType : '';
          accountScope = createHash('sha256').update(`${verifiedAccountId}|${origin}|${plan}`).digest('hex');
        }
        sendRateLimitsRead();
        return;
      }

      if (stage === 'rateLimits') {
        if (msg.error !== undefined) {
          if (msg.error?.code === -32600 && !legacyRateLimits) {
            legacyRateLimits = true;
            sendRateLimitsRead(true);
            return;
          }
          return fail('server', 'account/rateLimits/read', typeof msg.error?.code === 'number' ? msg.error.code : undefined);
        }
        const res = msg.result;
        if (!res || typeof res !== 'object' || Array.isArray(res)) {
          return fail('protocol', 'account/rateLimits/read');
        }
        if (typeof res.accountId === 'string' && res.accountId && verifiedAccountId && res.accountId !== verifiedAccountId) {
          return fail('accountMismatch', 'account/rateLimits/read');
        }
        const rows = parseCodexAppServerRateLimits(res, ctx.usage ?? [], Date.now(), startedAt);
        if (!rows) {
          return fail('protocol', 'account/rateLimits/read');
        }
        const resetCredits = parseCodexResetCredits(res, startedAt);
        finish({
          rows,
          source: 'app-server',
          ...(accountScope ? { accountScope } : {}),
          ...(resetCredits ? { meta: { resetCredits } } : {}),
        });
      }
    });

    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'agent-commons', title: 'Agent Commons', version: ctx.cliVersion ?? '2.0.0' } } });
  });
}

async function discoverModels(ctx: ProbeContext): Promise<ModelDiscoveries> {
  const selected = ctx.cliVersion ?? ctx.selected?.version ?? null;
  const catalogId = /^[a-z0-9][a-z0-9._:/-]{0,199}(?![\s\S])/iu;
  const effortId = /^[a-z][a-z0-9_-]{0,63}(?![\s\S])/u;
  const catalogIds = new Set<string>();
  const modelIds = new Set<string>();
  const rows: ModelDiscoveries = [];
  const native = await readAppServer<ModelDiscoveries>(ctx, 'model/list', result => {
    const page = result as Json | null;
    if (!page || !Array.isArray(page.data) || page.data.length > MODEL_PAGE_SIZE * 2)
      throw new Error('invalid model page');
    for (const entry of page.data) {
      const id = entry?.id, model = entry?.model;
      if (typeof id !== 'string' || !catalogId.test(id) || catalogIds.has(id)
        || typeof model !== 'string' || !catalogId.test(model) || modelIds.has(model)
        || typeof entry.hidden !== 'boolean' || !Array.isArray(entry.supportedReasoningEfforts)
        || entry.supportedReasoningEfforts.length > 32) throw new Error('invalid model entry');
      const efforts = entry.supportedReasoningEfforts.map((row: Json | null) => row?.reasoningEffort);
      if (!efforts.every((effort: unknown) => typeof effort === 'string' && effortId.test(effort))
        || new Set(efforts).size !== efforts.length) throw new Error('invalid model efforts');
      catalogIds.add(id);
      modelIds.add(model);
      rows.push({ model, family: codexLine(model), efforts, hidden: entry.hidden, source: 'app-server', state: 'discovered' });
    }
    if (page.nextCursor === null) {
      rows.completeSources = MODEL_LIST_SOURCES;
      return { value: rows };
    }
    if (typeof page.nextCursor !== 'string' || !page.nextCursor || page.nextCursor.length > 4096
      || /[\u0000-\u001f\u007f-\u009f]/u.test(page.nextCursor)) throw new Error('invalid pagination cursor');
    return { cursor: page.nextCursor };
  }, () => {
    rows.length = 0;
    catalogIds.clear();
    modelIds.clear();
  });
  const cache = readCodexModels(selected, ctx.overrides.cliModelHome);
  if (!native) return catalogDiscoveries(cache);
  // The native list can include bundled or newly advertised entries. Existing selection
  // consults the version-matched cache and requires separate entitlement evidence.
  const cachedIds = new Set(cache.state === 'trusted' ? cache.models.map(model => model.id) : []);
  for (const row of native) {
    if (cachedIds.has(row.model)) row.state = 'verified';
    else row.hidden = true; // Display in inventory without treating it as a runnable successor.
  }
  return native;
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
  discover: discoverModels,
  selectModel: (request, version) => chooseCodexModel(request, readCodexModels(version)),
  modelSourceStatus: version => catalogSelectionStatus(readCodexModels(version)),
  validate: () => ({}),
  observeUsage: readAppServerUsage,
  reopenedQuotaPools(rows, known) {
    const primary = rows.filter(row => row.pool === 'codex');
    if (primary.some(row => row.closed || row.remaining_percent === null || row.remaining_percent <= 0)) return [];
    const windows = new Set(primary.map(row => row.window));
    if (known.some(row => row.pool === 'codex' && row.window === 'exhaustion')) {
      if (!windows.has('300m') || rows.some(row => row.closed || row.remaining_percent === null || row.remaining_percent <= 0)) return [];
      if (known.some(row => !row.stale && row.window !== 'exhaustion'
        && !rows.some(fresh => fresh.pool === row.pool && fresh.window === row.window))) return [];
    }
    return windows.has('10080m') && known.filter(row => row.pool === 'codex' && row.window !== 'exhaustion')
      .every(row => windows.has(row.window)) ? ['codex'] : [];
  },
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
