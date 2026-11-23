import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { helperEnv, killTree } from './shared.ts';
import { UsageContractViolation, type RouteCommand, type UsageObservation, type UsageSnapshot } from './types.ts';

const ENVIRONMENT = /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|LOCALAPPDATA|APPDATA|USERPROFILE|HOMEDRIVE|HOMEPATH|HOME|PATHEXT|COMSPEC|PROGRAMFILES(X86)?|PROGRAMDATA|CLAUDE_CONFIG_DIR|CLAUDE_CODE_GIT_BASH_PATH|HTTPS?_PROXY|NO_PROXY)$/i;
const MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 20_000;
const MODEL_SCOPES = new Map([
  ['fable', 'Fable'], ['haiku', 'Haiku'], ['opus', 'Opus'], ['sonnet', 'Sonnet'],
  ['claude fable', 'Fable'], ['claude haiku', 'Haiku'], ['claude opus', 'Opus'], ['claude sonnet', 'Sonnet'],
]);
const SURFACE_SCOPES = new Map([['claude code', 'Claude Code'], ['claude.ai', 'Claude.ai']]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function nonzeroUsage(value: unknown): boolean {
  const usage = record(value);
  return ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']
    .some(key => typeof usage?.[key] === 'number' && usage[key] !== 0);
}

export function parseClaudeUsage(output: string, session: string): Pick<UsageSnapshot, 'rows' | 'partial'> | undefined {
  const frames = output.split(/\r?\n/).filter(line => line.trim()).map(line => {
    try { return record(JSON.parse(line)); } catch { return undefined; }
  });
  // Even an unusable report can have a later terminal frame proving that the model loop ran.
  for (const frame of frames) {
    if (!frame) continue;
    if (nonzeroUsage(frame.usage) || nonzeroUsage(record(frame.message)?.usage)
      || (typeof frame.duration_api_ms === 'number' && frame.duration_api_ms > 0)
      || (typeof frame.total_cost_usd === 'number' && frame.total_cost_usd > 0)
      || Object.keys(record(frame.modelUsage) ?? {}).length > 0
      || (frame.type === 'result' && frame.subtype === 'success' && frame.local_command !== 'usage')) {
      throw new UsageContractViolation('Claude quota check did not remain a zero-inference local command');
    }
  }
  let initialized = false;
  let report: Record<string, unknown> | undefined;
  let finished = false;
  for (const frame of frames) {
    if (!frame || finished || frame.session_id !== session) return;
    if (frame.type === 'system' && frame.subtype === 'ui_invalidate') continue;
    if (frame.type === 'system' && frame.subtype === 'init' && !initialized) {
      if (!Array.isArray(frame.tools) || frame.tools.length || !Array.isArray(frame.mcp_servers) || frame.mcp_servers.length) return;
      initialized = true;
    } else if (initialized && frame.type === 'assistant' && !report && !frame.error && !frame.aborted) {
      report = record(frame.usage_report);
      if (!report) return;
    } else if (initialized && frame.type === 'result' && frame.subtype === 'success' && report) {
      const usage = record(frame.usage);
      if (frame.is_error !== false || frame.local_command !== 'usage' || frame.duration_api_ms !== 0 || frame.total_cost_usd !== 0
        || usage?.input_tokens !== 0 || usage.output_tokens !== 0
        || (usage.cache_read_input_tokens ?? 0) !== 0 || (usage.cache_creation_input_tokens ?? 0) !== 0
        || (Array.isArray(frame.permission_denials) && frame.permission_denials.length)) return;
      finished = true;
    } else return;
  }
  const limits = record(report?.rate_limits)?.limits;
  if (!finished || !Array.isArray(limits) || !limits.length) return;
  const rows = new Map<string, UsageObservation>();
  let partial = false;
  for (const value of limits) {
    const meter = record(value);
    if (!meter || typeof meter.percent !== 'number' || !Number.isFinite(meter.percent)
      || meter.percent < 0 || meter.percent > 100 || (meter.resets_at !== null
        && (typeof meter.resets_at !== 'string' || !Number.isFinite(Date.parse(meter.resets_at))))) return;
    const scope = record(meter.scope);
    const modelLabel = record(scope?.model)?.display_name;
    const surfaceLabel = record(scope?.surface)?.display_name;
    const model = typeof modelLabel === 'string' ? MODEL_SCOPES.get(modelLabel.trim().toLowerCase()) : undefined;
    const surface = typeof surfaceLabel === 'string' ? SURFACE_SCOPES.get(surfaceLabel.trim().toLowerCase()) : undefined;
    const labels = [model, surface].filter(Boolean);
    if (meter.kind === 'weekly_scoped' && (!labels.length
      || (scope?.model !== undefined && !model) || (scope?.surface !== undefined && !surface))) {
      partial = true;
      continue;
    }
    const pool = meter.kind === 'weekly_scoped' ? `claude / ${labels.join(' / ')}` : 'default';
    const window = meter.kind === 'session' ? '5h' : meter.kind === 'weekly_all' || pool !== 'default' ? 'weekly' : undefined;
    if (!window) { partial = true; continue; }
    const key = JSON.stringify([pool, window]);
    if (rows.has(key)) return;
    rows.set(key, { pool, window, remaining_percent: 100 - meter.percent, resets_at: meter.resets_at as string | null });
  }
  return rows.size ? { rows: [...rows.values()], partial } : undefined;
}

/** The fixed native command runs outside the model loop. An invalid model and zero turns guard the fallback path. */
export async function readClaudeUsage(command: RouteCommand): Promise<UsageSnapshot | undefined> {
  const session = randomUUID();
  const args = ['--safe-mode', '--setting-sources', '',
    '--settings', JSON.stringify({ forceLoginMethod: 'claudeai', disableAllHooks: true }),
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--print', '--verbose', '--output-format', 'stream-json',
    '--input-format', 'text', '--tools', '', '--permission-mode', 'manual', '--no-chrome', '--no-session-persistence',
    '--model', 'claude-ac-quota-metadata-only-00000000', '--session-id', session, '--max-turns', '0'];
  const env = Object.fromEntries(Object.entries(helperEnv()).filter(([key]) => ENVIRONMENT.test(key)));
  const observedAt = new Date().toISOString();
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, [...(command.prefix ?? []), ...args], {
      cwd: os.tmpdir(), env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (acceptReport: boolean) => {
      try {
        const result = parseClaudeUsage(Buffer.concat(chunks).toString('utf8'), session);
        resolve(result && acceptReport
          ? { ...result, rows: result.rows.map(row => ({ ...row, observed_at: observedAt })), source: 'claude-usage' }
          : undefined);
      } catch (error) {
        if (error instanceof UsageContractViolation) reject(error);
        else resolve(undefined);
      }
    };
    const stop = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.pid) killTree(child.pid);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      finish(false);
    };
    const timer = setTimeout(stop, TIMEOUT_MS);
    child.on('error', stop);
    child.stdin.on('error', stop);
    child.stdout.on('error', stop);
    child.stderr.on('error', stop);
    child.stdout.on('data', (chunk: Buffer) => {
      const capacity = Math.max(0, MAX_BYTES - bytes);
      if (capacity) chunks.push(chunk.subarray(0, capacity));
      bytes += chunk.length;
      if (bytes > MAX_BYTES) stop();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) stop();
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish(code === 0);
    });
    child.stdin.end('/usage');
  });
}
