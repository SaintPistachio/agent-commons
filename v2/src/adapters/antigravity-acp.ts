/**
 * Native Antigravity ACP client (`agy.exe acp --stdio`) for zero-inference probing,
 * structured model/effort discovery, and read-only advice job execution.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Json } from '../store.ts';
import type { SeedProfile } from './antigravity-inventory.ts';
import { ENTITLEMENT_ERROR_PATTERN } from './model-pricing.ts';
import { hashFile, helperEnv, killTree, workerEnv } from './shared.ts';
import type {
  Active,
  ModelDiscoveries,
  ModelDiscovery,
  ProbeOverrides,
  RouteCommand,
  RunContext,
  RunnerOptions,
} from './types.ts';

export interface AcpModelEntry {
  modelId: string;
  name?: string;
}

export interface AcpConfigOption {
  id: string;
  currentValue?: string;
  options?: Array<{ value: string; name?: string }>;
}

export interface AcpProbeSnapshot {
  cliVersion: string;
  tier: { id: string | null; name: string | null };
  availableModels: AcpModelEntry[];
  modelOptions: string[];
  thoughtLevels: string[];
  modes: string[];
  currentModel: string | null;
  currentEffort: string | null;
}

export interface AcpCatalogRecord {
  observedAt: string;
  cliVersion: string;
  tier: { id: string | null; name: string | null };
  modelCount: number;
}

export interface AcpLaunchHooks {
  vendor: (model: unknown) => string | null;
  classifyQuotaFailure: (
    job: Json,
    ctx: RunContext,
    message: string,
    reportedModel: string | null,
  ) => { error: string; reply: Json };
}

const ACP_CATALOG_FILE = 'acp-catalog.json';
const ACP_CATALOG_TTL_MS = 60 * 60_000;
const MAX_RESPONSE_CHARS = 2 * 1024 * 1024;
const QUOTA_ERROR_RE = /quota|rate.?limit|\b429\b|exhausted|limit reached/i;
const EXTRA_STRIPPED_ENV = new Set([
  'AGY_ACP_CCPA_PROJECT',
  'AGY_ACP_ENABLE_OAUTH',
  'AGY_ACP_FORCE_FILE_STORAGE',
  'ANTIGRAVITY_HARNESS_PATH',
  'BROWSER',
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function defaultAntigravityCliPath(overrides?: ProbeOverrides): string {
  return overrides?.antigravityCli ?? path.join(os.homedir(), 'AppData', 'Local', 'agy', 'bin', 'agy.exe');
}

export function resolveAntigravityAcp(
  options?: RunnerOptions,
  overrides?: ProbeOverrides,
): RouteCommand | undefined {
  if (overrides?.antigravityAcp) return overrides.antigravityAcp;
  if (options?.antigravityAcp) return options.antigravityAcp;
  if (options?.antigravity || overrides?.antigravityHelperRoot) return undefined;
  const cliPath = defaultAntigravityCliPath(overrides);
  return fs.existsSync(cliPath) ? { file: cliPath } : undefined;
}

export function acpEnv(jobId?: string): NodeJS.ProcessEnv {
  const base = jobId ? workerEnv(jobId) : helperEnv();
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (!EXTRA_STRIPPED_ENV.has(key.toUpperCase())) env[key] = value;
  }
  return env;
}

export function acpArgs(command: RouteCommand, mode: 'probe' | 'advice'): string[] {
  return [
    ...(command.prefix ?? []),
    'acp',
    '--stdio',
    '--include-default-customizations=false',
    ...(mode === 'advice' ? ['--sandbox'] : []),
    '--disable-telemetry',
  ];
}

export function splitAcpModelId(modelId: string): { family: string; effort?: string } {
  const match = /^(.*)-(low|medium|high|xhigh|max)$/.exec(modelId);
  return match ? { family: match[1], effort: match[2] } : { family: modelId };
}

export function projectAcpDiscoveries(
  snapshot: AcpProbeSnapshot,
  validatedModels: ReadonlySet<string>,
): ModelDiscoveries {
  const rows: ModelDiscovery[] = snapshot.availableModels.map(entry => {
    const { family, effort } = splitAcpModelId(entry.modelId);
    const hidden = !effort || family.startsWith('gpt-oss');
    return {
      model: entry.modelId,
      family,
      efforts: effort ? [effort] : [],
      hidden,
      state: hidden ? 'discovered' : validatedModels.has(entry.modelId) ? 'validated' : 'discovered',
      source: 'acp-catalog',
    };
  });
  return Object.assign(rows, {
    completeSources: [
      'acp-catalog',
      'acp-catalog:hidden',
      'guarded-catalog',
      'guarded-catalog:hidden',
      'catalog',
      'routing-state',
      'routing-seed',
    ],
  });
}

export function saveAcpCatalog(home: string, snapshot: AcpProbeSnapshot, observedAt: string): void {
  const dir = path.join(home, 'helpers', 'antigravity');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, ACP_CATALOG_FILE);
  const temp = `${target}.${randomUUID()}.tmp`;
  const payload: AcpCatalogRecord = {
    observedAt,
    cliVersion: snapshot.cliVersion,
    tier: snapshot.tier,
    modelCount: snapshot.availableModels.length,
  };
  try {
    fs.writeFileSync(temp, JSON.stringify(payload), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, target);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

export function readAcpCatalog(home: string): AcpCatalogRecord | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(home, 'helpers', 'antigravity', ACP_CATALOG_FILE), 'utf8'));
    const data = record(raw);
    if (!data || typeof data.observedAt !== 'string' || !Number.isFinite(Date.parse(data.observedAt))) return undefined;
    if (typeof data.cliVersion !== 'string' || !data.cliVersion.trim()) return undefined;
    if (typeof data.modelCount !== 'number' || !Number.isInteger(data.modelCount) || data.modelCount < 0) return undefined;
    const tier = record(data.tier);
    return {
      observedAt: data.observedAt,
      cliVersion: data.cliVersion,
      tier: {
        id: typeof tier?.id === 'string' ? tier.id : null,
        name: typeof tier?.name === 'string' ? tier.name : null,
      },
      modelCount: data.modelCount,
    };
  } catch {
    return undefined;
  }
}

export function acpInventorySummary(home: string): string | undefined {
  const cat = readAcpCatalog(home);
  if (!cat) return undefined;
  const age = Date.now() - Date.parse(cat.observedAt);
  const fresh = age >= 0 && age < ACP_CATALOG_TTL_MS;
  const tierLabel = cat.tier.name ? `, ${cat.tier.name}` : '';
  return `Antigravity ACP catalog ${fresh ? 'current' : 'stale'} (${cat.cliVersion}${tierLabel}); observed ${cat.observedAt}; ${cat.modelCount} models`;
}

function parseConfigOptions(raw: unknown): AcpConfigOption[] {
  if (!Array.isArray(raw)) return [];
  const out: AcpConfigOption[] = [];
  for (const item of raw) {
    const obj = record(item);
    if (!obj || typeof obj.id !== 'string') continue;
    const options: Array<{ value: string; name?: string }> = [];
    if (Array.isArray(obj.options)) {
      for (const opt of obj.options) {
        const o = record(opt);
        if (o && typeof o.value === 'string') {
          options.push({ value: o.value, ...(typeof o.name === 'string' ? { name: o.name } : {}) });
        }
      }
    }
    out.push({
      id: obj.id,
      ...(typeof obj.currentValue === 'string' ? { currentValue: obj.currentValue } : {}),
      options,
    });
  }
  return out;
}

function parseProbeSnapshot(initResult: unknown, sessionResult: unknown): AcpProbeSnapshot | string {
  const init = record(initResult);
  const agentInfo = record(init?.agentInfo);
  const cliVersion = typeof agentInfo?.version === 'string' && agentInfo.version.trim() ? agentInfo.version.trim() : '';
  if (!cliVersion) return 'initialize response missing agentInfo.version';

  const sess = record(sessionResult);
  if (!sess || typeof sess.sessionId !== 'string' || !sess.sessionId.trim()) {
    return 'session/new response missing sessionId';
  }

  const tierObj = record(record(record(sess._meta)?.antigravity)?.tier);
  const tier = {
    id: typeof tierObj?.id === 'string' ? tierObj.id : null,
    name: typeof tierObj?.name === 'string' ? tierObj.name : null,
  };

  const modelsObj = record(sess.models);
  const rawModels = Array.isArray(modelsObj?.availableModels) ? modelsObj.availableModels : [];
  const availableModels: AcpModelEntry[] = [];
  for (const m of rawModels) {
    const entry = record(m);
    if (entry && typeof entry.modelId === 'string' && entry.modelId.trim()) {
      availableModels.push({
        modelId: entry.modelId.trim(),
        ...(typeof entry.name === 'string' ? { name: entry.name } : {}),
      });
    }
  }

  const configOptions = parseConfigOptions(sess.configOptions);
  const findConfig = (id: string) => configOptions.find(c => c.id === id);
  const modelOpt = findConfig('model');
  const thoughtOpt = findConfig('thought_level');
  const modeOpt = findConfig('mode');

  const modelOptions = modelOpt?.options?.map(o => o.value) ?? [];
  const thoughtLevels = thoughtOpt?.options?.map(o => o.value) ?? [];
  let modes = modeOpt?.options?.map(o => o.value) ?? [];
  if (!modes.length) {
    const modesObj = record(sess.modes);
    if (Array.isArray(modesObj?.availableModes)) {
      modes = modesObj.availableModes
        .map(m => record(m)?.id)
        .filter((v): v is string => typeof v === 'string');
    }
  }

  return {
    cliVersion,
    tier,
    availableModels,
    modelOptions,
    thoughtLevels,
    modes,
    currentModel: modelOpt?.currentValue ?? null,
    currentEffort: thoughtOpt?.currentValue ?? null,
  };
}

function isAuthError(code: unknown, message: string): boolean {
  return code === -32000 || /\b(auth|sign.?in|log.?in|unauthorized|credentials)\b/i.test(message);
}

export function probeAntigravityAcp(
  command: RouteCommand,
  timeoutMs = 20_000,
): Promise<{ ok: true; snapshot: AcpProbeSnapshot } | { ok: false; state: 'blocked' | 'unavailable'; reason: string }> {
  return new Promise(resolve => {
    let settled = false;
    let stderrTail = '';
    let buf = '';
    let child: ChildProcess | undefined;
    let successResult: { ok: true; snapshot: AcpProbeSnapshot } | undefined;

    const done = (
      result: { ok: true; snapshot: AcpProbeSnapshot } | { ok: false; state: 'blocked' | 'unavailable'; reason: string },
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child?.stdin?.end(); } catch { /* ignore */ }
      if (child?.pid) killTree(child.pid);
      resolve(result);
    };

    try {
      child = spawn(command.file, acpArgs(command, 'probe'), {
        cwd: command.cwd ?? os.tmpdir(),
        env: acpEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') return resolve({ ok: false, state: 'unavailable', reason: 'Antigravity CLI not found' });
      return resolve({ ok: false, state: 'blocked', reason: `Antigravity ACP probe failed: ${err.message}` });
    }

    const timer = setTimeout(() => {
      done(successResult ?? { ok: false, state: 'blocked', reason: 'Antigravity ACP probe failed: timed out' });
    }, timeoutMs);

    child.stdin?.on('error', () => {});

    const send = (id: number, method: string, params: unknown) => {
      try { child?.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); } catch { /* ignore */ }
    };

    let initResult: unknown;

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (successResult) return done(successResult);
      if (error.code === 'ENOENT') done({ ok: false, state: 'unavailable', reason: 'Antigravity CLI not found' });
      else done({ ok: false, state: 'blocked', reason: `Antigravity ACP probe failed: ${error.message}` });
    });

    child.stderr!.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-1000);
    });

    child.stdout!.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg: Record<string, unknown> | undefined;
        try { msg = record(JSON.parse(line)); } catch { continue; }
        if (!msg) continue;

        if (msg.id === 1) {
          const err = record(msg.error);
          if (err) {
            const m = String(err.message ?? 'initialize error');
            return done({
              ok: false,
              state: 'blocked',
              reason: isAuthError(err.code, m)
                ? 'Antigravity ACP requires Google sign-in (run agy acp --login)'
                : `Antigravity ACP probe failed: ${m}`,
            });
          }
          initResult = msg.result;
          send(2, 'session/new', { cwd: command.cwd ?? os.tmpdir(), mcpServers: [] });
        } else if (msg.id === 2) {
          const err = record(msg.error);
          if (err) {
            const m = String(err.message ?? 'session/new error');
            return done({
              ok: false,
              state: 'blocked',
              reason: isAuthError(err.code, m)
                ? 'Antigravity ACP requires Google sign-in (run agy acp --login)'
                : `Antigravity ACP probe failed: ${m}`,
            });
          }
          const parsed = parseProbeSnapshot(initResult, msg.result);
          if (typeof parsed === 'string') {
            return done({ ok: false, state: 'blocked', reason: `Antigravity ACP probe failed: ${parsed}` });
          }
          const sessionId = String(record(msg.result)!.sessionId);
          successResult = { ok: true, snapshot: parsed };
          send(3, 'session/close', { sessionId });
          try { child?.stdin?.end(); } catch { /* ignore */ }
          setTimeout(() => done(successResult!), 150);
          continue;
        } else if (msg.id === 3 && successResult) {
          return done(successResult);
        }
      }
    });

    child.on('close', code => {
      if (settled) return;
      if (successResult) return done(successResult);
      const tail = stderrTail.trim().split(/\r?\n/).pop() ?? '';
      done({
        ok: false,
        state: 'blocked',
        reason: `Antigravity ACP probe failed: exited (${code ?? 'null'})${tail ? ': ' + tail.slice(0, 200) : ''}`,
      });
    });

    send(1, 'initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'agent-commons', version: '2.0' },
    });
  });
}

function resolveTargetModelAndEffort(
  job: Json,
  snapshot: AcpProbeSnapshot,
  selection: { family?: string; effort?: string; availableProfiles: SeedProfile[] },
): { model?: string; effort?: string; error?: string } {
  const modelSet = new Set(snapshot.modelOptions);
  const task = String(job.options?.task ?? 'explain');
  const requestedEffort = selection.effort ?? (typeof job.effort === 'string' ? job.effort : undefined);

  let targetModel: string | undefined;
  let targetEffort = requestedEffort;

  if (typeof job.model === 'string' && job.model.trim()) {
    const raw = job.model.trim();
    if (modelSet.has(raw)) {
      targetModel = raw;
    } else {
      const split = splitAcpModelId(raw);
      targetModel = split.family;
      targetEffort ??= split.effort;
    }
    if (modelSet.size > 0 && !modelSet.has(targetModel)) {
      return { error: `MODEL_UNAVAILABLE: Antigravity ACP does not offer ${raw}` };
    }
  } else if (selection.family) {
    targetModel = selection.family;
    if (modelSet.size > 0 && !modelSet.has(targetModel)) {
      return { error: `MODEL_UNAVAILABLE: Antigravity ACP does not offer ${targetModel}` };
    }
  } else {
    const matching = selection.availableProfiles
      .filter(p => p.tasks.includes(task) && (!targetEffort || p.effort === targetEffort))
      .sort((a, b) => (a.task_preferences?.[task] ?? Infinity) - (b.task_preferences?.[task] ?? Infinity));
    const preferred = matching.find(p => modelSet.size === 0 || modelSet.has(p.family));
    if (preferred) {
      targetModel = preferred.family;
      targetEffort ??= preferred.effort;
    }
  }

  if (targetEffort === 'max' && !snapshot.thoughtLevels.includes('max') && snapshot.thoughtLevels.includes('xhigh')) {
    targetEffort = 'xhigh';
  }
  if (targetEffort && snapshot.thoughtLevels.length > 0 && !snapshot.thoughtLevels.includes(targetEffort)) {
    targetEffort = undefined;
  }

  return { model: targetModel, effort: targetEffort };
}

function writeJobSummary(dir: string, payload: Record<string, unknown>): void {
  try {
    fs.writeFileSync(path.join(dir, 'stdout.json'), JSON.stringify(payload, null, 2));
  } catch { /* diagnostics only */ }
}

export function launchAntigravityAcp(
  job: Json,
  ctx: RunContext,
  command: RouteCommand,
  selection: { family?: string; effort?: string; availableProfiles: SeedProfile[] },
  hooks: AcpLaunchHooks,
): void {
  let cwd: string;
  try {
    cwd = ctx.prepareWorkdir();
  } catch (error) {
    return ctx.finish('failed', { error: 'WORKDIR_FAILED: ' + String((error as Error).message).slice(0, 500) });
  }

  const promptFile = path.join(ctx.dir, 'prompt.md');
  fs.writeFileSync(promptFile, job.prompt, 'utf8');
  if (!job.options?.patch_turn) ctx.store.updateJob(job.id, { workdir: cwd });

  const stderrFd = fs.openSync(path.join(ctx.dir, 'stderr.log'), 'w');
  let child: ChildProcess;
  try {
    child = spawn(command.file, acpArgs(command, 'advice'), {
      cwd,
      env: acpEnv(job.id),
      stdio: ['pipe', 'pipe', stderrFd],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
  } catch (error) {
    fs.closeSync(stderrFd);
    return ctx.finish('failed', {
      error: 'ACP_BEFORE_SUBMISSION: ' + String((error as Error).message).slice(0, 300),
    });
  }

  let finished = false;
  let promptSubmitted = false;
  let sessionId: string | undefined;
  let snapshot: AcpProbeSnapshot | undefined;
  let selectedModel: string | undefined;
  let selectedEffort: string | undefined;
  let collectedText = '';
  let tokensIn: number | null = null;
  let tokensOut: number | null = null;
  let buf = '';
  let nextId = 1;
  const pending = new Map<number, (msg: Record<string, unknown>) => void>();

  const sendRaw = (obj: unknown) => {
    try {
      if (child.stdin?.writable) child.stdin.write(JSON.stringify(obj) + '\n');
    } catch { /* ignore broken pipe */ }
  };

  const request = (method: string, params: unknown, onReply: (msg: Record<string, unknown>) => void) => {
    const id = nextId++;
    pending.set(id, onReply);
    sendRaw({ jsonrpc: '2.0', id, method, params });
  };

  const sendCancel = () => {
    if (!finished && sessionId) sendRaw({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
  };

  child.stdin?.on('error', () => {});

  const timer = setTimeout(() => {
    const a = ctx.active();
    if (a && !a.reason) {
      a.reason = 'TIMEOUT';
      sendCancel();
      if (child.pid) killTree(child.pid);
    }
  }, job.timeout_ms);

  const active: Active = {
    child,
    timer,
    cleanup: () => {
      sendCancel();
      try { child.stdin?.end(); } catch { /* ignore */ }
    },
  };
  ctx.track(active);
  ctx.store.updateJob(job.id, { pid: child.pid ?? null });

  const finalize = (
    status: string,
    fields: Json,
    reply?: Json,
    summaryExtra: Record<string, unknown> = {},
  ) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    writeJobSummary(ctx.dir, {
      status,
      model: selectedModel ?? null,
      effort: selectedEffort ?? null,
      response_chars: collectedText.length,
      ...summaryExtra,
    });
    try { child.stdin?.end(); } catch { /* ignore */ }
    if (child.pid) killTree(child.pid);
    ctx.finish(status, fields, reply);
  };

  const failBeforePrompt = (errorMsg: string) => {
    const status = active.reason === 'CANCELLED' ? 'cancelled' : 'failed';
    finalize(status, { exit_code: status === 'cancelled' ? null : 1, error: errorMsg }, undefined, { error: errorMsg });
  };

  const handleServerRequest = (msg: Record<string, unknown>) => {
    const id = msg.id;
    const method = msg.method;
    const params = record(msg.params);
    if (method === 'session/request_permission') {
      const toolCall = record(params?.toolCall);
      const toolCallId = typeof toolCall?.toolCallId === 'string' ? toolCall.toolCallId : '';
      const options = Array.isArray(params?.options) ? params.options : [];
      if (!toolCallId.startsWith('interaction_')) {
        const reject = options.map(record).find(o => o?.kind === 'reject_once' && typeof o.optionId === 'string');
        if (reject) {
          return sendRaw({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'selected', optionId: reject.optionId } } });
        }
      }
      return sendRaw({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'cancelled' } } });
    }
    sendRaw({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: 'Method disabled in read-only advice mode' },
    });
  };

  const handleNotification = (msg: Record<string, unknown>) => {
    if (msg.method !== 'session/update') return;
    const params = record(msg.params);
    const update = record(params?.update);
    if (!update) return;
    if (update.sessionUpdate === 'agent_message_chunk') {
      const content = record(update.content);
      if (content?.type === 'text' && typeof content.text === 'string') {
        const remaining = Math.max(0, MAX_RESPONSE_CHARS - collectedText.length);
        if (remaining > 0) collectedText += content.text.slice(0, remaining);
      }
    } else if (update.sessionUpdate === 'usage_update') {
      const usage = record(update.usage);
      if (Number.isInteger(usage?.inputTokens)) tokensIn = usage!.inputTokens as number;
      if (Number.isInteger(usage?.outputTokens)) tokensOut = usage!.outputTokens as number;
    }
  };

  const runPrompt = () => {
    promptSubmitted = true;
    request('session/prompt', { sessionId, prompt: [{ type: 'text', text: job.prompt }] }, msg => {
      const err = record(msg.error);
      if (err) {
        const errMsg = String(err.message ?? 'ACP prompt error');
        const activeModel = selectedModel ?? snapshot?.currentModel ?? null;
        const reportedModel = activeModel && selectedEffort && !activeModel.endsWith(`-${selectedEffort}`)
          ? `${activeModel}-${selectedEffort}` : activeModel;

        if (QUOTA_ERROR_RE.test(errMsg)) {
          const classified = hooks.classifyQuotaFailure(job, ctx, errMsg, reportedModel);
          return finalize('failed', { exit_code: 1, error: classified.error, reported_model: reportedModel }, classified.reply, { error: classified.error });
        }
        if (ENTITLEMENT_ERROR_PATTERN.test(errMsg) && reportedModel) {
          ctx.store.markModelUnentitled('antigravity', reportedModel, errMsg.slice(0, 200));
        }
        const fullErr = `ACP_ERROR: ${errMsg.slice(0, 400)}`;
        return finalize('failed', { exit_code: 1, error: fullErr, reported_model: reportedModel }, undefined, { error: fullErr });
      }

      const res = record(msg.result);
      const stopReason = typeof res?.stopReason === 'string' ? res.stopReason : null;
      const usage = record(res?.usage);
      if (Number.isInteger(usage?.inputTokens)) tokensIn = usage!.inputTokens as number;
      if (Number.isInteger(usage?.outputTokens)) tokensOut = usage!.outputTokens as number;

      if (sessionId) sendRaw({ jsonrpc: '2.0', id: nextId++, method: 'session/close', params: { sessionId } });

      if (stopReason === 'cancelled' || active.reason === 'CANCELLED') {
        const errText = 'CANCELLED: prompt may have been submitted, so it is never replayed';
        return finalize('needs_review', { exit_code: 0, error: errText }, undefined, { stopReason, error: errText });
      }

      const activeModel = selectedModel ?? snapshot?.currentModel ?? null;
      const reportedModel = activeModel && selectedEffort && !activeModel.endsWith(`-${selectedEffort}`)
        ? `${activeModel}-${selectedEffort}` : activeModel;
      const family = hooks.vendor(reportedModel);
      if (family) ctx.annotate({ effective_family: family });
      if (reportedModel) ctx.store.markModelValidated('antigravity', reportedModel);

      return finalize(
        'completed',
        {
          exit_code: 0,
          result: collectedText,
          reported_model: reportedModel,
          tokens_in: tokensIn,
          tokens_out: tokensOut,
        },
        undefined,
        { stopReason, reported_model: reportedModel },
      );
    });
  };

  const applyConfigAndPrompt = (snap: AcpProbeSnapshot) => {
    const resolved = resolveTargetModelAndEffort(job, snap, selection);
    if (resolved.error) return failBeforePrompt(resolved.error);
    selectedModel = resolved.model ?? snap.currentModel ?? undefined;
    selectedEffort = resolved.effort ?? snap.currentEffort ?? undefined;

    const steps: Array<{ configId: string; value: string }> = [];
    const targetMode = snap.modes.includes('plan') ? 'plan' : 'default';
    steps.push({ configId: 'mode', value: targetMode });
    if (resolved.model && resolved.model !== snap.currentModel) {
      steps.push({ configId: 'model', value: resolved.model });
    }
    if (resolved.effort && resolved.effort !== snap.currentEffort) {
      steps.push({ configId: 'thought_level', value: resolved.effort });
    }

    const runNextStep = (idx: number) => {
      if (idx >= steps.length) return runPrompt();
      const step = steps[idx];
      request('session/set_config_option', { sessionId, configId: step.configId, value: step.value }, msg => {
        const err = record(msg.error);
        if (err) {
          return failBeforePrompt(`ACP_BEFORE_SUBMISSION: failed setting ${step.configId}=${step.value}: ${String(err.message ?? 'error')}`);
        }
        runNextStep(idx + 1);
      });
    };
    runNextStep(0);
  };

  child.stdout!.on('data', (chunk: Buffer) => {
    if (finished || ctx.active() !== active) return;
    buf += chunk.toString('utf8');
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg: Record<string, unknown> | undefined;
      try { msg = record(JSON.parse(line)); } catch { continue; }
      if (!msg) continue;

      if (typeof msg.method === 'string' && msg.id !== undefined) {
        handleServerRequest(msg);
      } else if (typeof msg.method === 'string') {
        handleNotification(msg);
      } else if (typeof msg.id === 'number') {
        const cb = pending.get(msg.id);
        if (cb) {
          pending.delete(msg.id);
          cb(msg);
        }
      }
    }
  });

  child.on('error', error => {
    if (!active.reason && child.pid === undefined) active.reason = 'SPAWN_FAILED: ' + error.message;
  });

  child.on('close', code => {
    clearTimeout(timer);
    try { fs.closeSync(stderrFd); } catch { /* ignore */ }
    if (finished || ctx.active() !== active) return;
    if (!promptSubmitted) {
      const status = active.reason === 'CANCELLED' ? 'cancelled' : 'failed';
      const errText = `${active.reason ?? 'ACP_BEFORE_SUBMISSION'}: exited (${code ?? 'null'})`;
      return finalize(status, { exit_code: code, error: errText }, undefined, { error: errText });
    }
    const errText = `${active.reason ?? 'AG_OUTCOME_UNCLEAR'}: ACP session ended before terminal prompt response; the prompt may have been submitted, so it is never replayed`;
    return finalize('needs_review', { exit_code: code, error: errText }, undefined, { error: errText });
  });

  let initResult: unknown;
  request(
    'initialize',
    {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'agent-commons', version: '2.0' },
    },
    initMsg => {
      const err = record(initMsg.error);
      if (err) return failBeforePrompt(`ACP_BEFORE_SUBMISSION: initialize failed: ${String(err.message ?? 'error')}`);
      initResult = initMsg.result;
      request('session/new', { cwd, mcpServers: [] }, sessMsg => {
        const serr = record(sessMsg.error);
        if (serr) return failBeforePrompt(`ACP_BEFORE_SUBMISSION: session/new failed: ${String(serr.message ?? 'error')}`);
        const parsed = parseProbeSnapshot(initResult, sessMsg.result);
        if (typeof parsed === 'string') return failBeforePrompt(`ACP_BEFORE_SUBMISSION: ${parsed}`);
        sessionId = String(record(sessMsg.result)!.sessionId);
        snapshot = parsed;
        applyConfigAndPrompt(parsed);
      });
    },
  );
}
