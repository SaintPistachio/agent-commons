import fs from 'node:fs';
import path from 'node:path';
import { CommonsError } from './errors.ts';
import { assertRegularTokenFile, writePrivateJson } from './token-home.ts';

/** Production jobs run only through adapters with an approved boundary, unless an operator opts in locally. */
export type WorkerPolicy = (route: string, toolset: string | null, mode?: string, patchEdit?: boolean) => string | null;

export const WORKER_POLICY_FILE = 'worker-policy.json';
export const NATIVE_WORKER_ROUTES = ['claude', 'codex', 'antigravity'] as const;

export interface LocalWorkerPolicyConfig {
  schemaVersion: 1;
  allowRoutes: string[];
  allowNativeEdit: boolean;
  allowApprovedToolsets: boolean;
}

export interface LoadedWorkerPolicy {
  policy: WorkerPolicy;
  source: 'default' | 'local-file';
  file: string;
  config: LocalWorkerPolicyConfig | null;
}

const ALLOWED_KEYS = new Set(['schemaVersion', 'allowRoutes', 'allowNativeEdit', 'allowApprovedToolsets']);
const OPERATOR_ROUTES = new Set<string>([...NATIVE_WORKER_ROUTES, 'gemini-api']);

export const releaseWorkerPolicy: WorkerPolicy = (route, toolset, mode, patchEdit) => {
  if (route !== 'openai-api') return 'WORKER_ROUTE_GATED';
  if (toolset !== null && toolset !== 'project') return 'WORKER_TOOLSET_GATED';
  if ((patchEdit && (mode !== 'edit' || toolset !== null)) || (mode === 'edit' && !patchEdit)) return 'WORKER_MODE_GATED';
  return null;
};

export function parseLocalWorkerPolicy(raw: unknown): LocalWorkerPolicyConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CommonsError('WORKER_POLICY_INVALID', 'Local worker policy must be a JSON object.', 400);
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new CommonsError('WORKER_POLICY_INVALID', `Unknown worker policy key: ${key}`, 400);
    }
  }
  if (obj.schemaVersion !== 1) {
    throw new CommonsError('WORKER_POLICY_INVALID', 'Worker policy schemaVersion must be 1.', 400);
  }
  if (!Array.isArray(obj.allowRoutes)) {
    throw new CommonsError('WORKER_POLICY_INVALID', 'Worker policy allowRoutes must be an array of operator-opt-in route IDs.', 400);
  }
  const allowRoutes: string[] = [];
  const seen = new Set<string>();
  for (const entry of obj.allowRoutes) {
    if (typeof entry !== 'string' || !OPERATOR_ROUTES.has(entry)) {
      throw new CommonsError('WORKER_POLICY_INVALID', `Unsupported route in worker policy allowRoutes: ${String(entry)}`, 400);
    }
    if (seen.has(entry)) {
      throw new CommonsError('WORKER_POLICY_INVALID', `Duplicate route in worker policy allowRoutes: ${entry}`, 400);
    }
    seen.add(entry);
    allowRoutes.push(entry);
  }
  if (obj.allowNativeEdit !== undefined && typeof obj.allowNativeEdit !== 'boolean') {
    throw new CommonsError('WORKER_POLICY_INVALID', 'Worker policy allowNativeEdit must be a boolean.', 400);
  }
  if (obj.allowApprovedToolsets !== undefined && typeof obj.allowApprovedToolsets !== 'boolean') {
    throw new CommonsError('WORKER_POLICY_INVALID', 'Worker policy allowApprovedToolsets must be a boolean.', 400);
  }
  return {
    schemaVersion: 1,
    allowRoutes,
    allowNativeEdit: obj.allowNativeEdit ?? false,
    allowApprovedToolsets: obj.allowApprovedToolsets ?? false,
  };
}

export function workerPolicyFromConfig(config: LocalWorkerPolicyConfig): WorkerPolicy {
  const allowed = new Set(config.allowRoutes);
  return (route, toolset, mode, patchEdit) => {
    if (route !== 'openai-api' && !allowed.has(route)) return 'WORKER_ROUTE_GATED';
    if (route === 'gemini-api') {
      if (mode === 'edit' || patchEdit) return 'WORKER_MODE_GATED';
      return toolset === null ? null : 'WORKER_TOOLSET_GATED';
    }
    if (toolset !== null && toolset !== 'project' && !config.allowApprovedToolsets) return 'WORKER_TOOLSET_GATED';
    if (patchEdit && (mode !== 'edit' || toolset !== null)) return 'WORKER_MODE_GATED';
    if (mode === 'edit' && !patchEdit && (!config.allowNativeEdit || route === 'openai-api')) return 'WORKER_MODE_GATED';
    return null;
  };
}

export function loadWorkerPolicy(home: string): LoadedWorkerPolicy {
  const file = path.join(home, WORKER_POLICY_FILE);
  if (!assertRegularTokenFile(file)) {
    return { policy: releaseWorkerPolicy, source: 'default', file, config: null };
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new CommonsError('WORKER_POLICY_INVALID', `Invalid JSON in ${file}: ${(error as Error).message}`, 400);
  }
  const config = parseLocalWorkerPolicy(parsedJson);
  return { policy: workerPolicyFromConfig(config), source: 'local-file', file, config };
}

export function saveLocalWorkerPolicy(home: string, config: LocalWorkerPolicyConfig): string {
  const parsed = parseLocalWorkerPolicy(config);
  const file = path.join(home, WORKER_POLICY_FILE);
  writePrivateJson(file, parsed, true);
  return file;
}

export function resetLocalWorkerPolicy(home: string): boolean {
  const file = path.join(home, WORKER_POLICY_FILE);
  if (!assertRegularTokenFile(file)) return false;
  fs.unlinkSync(file);
  return true;
}

export function workerPolicyMessage(code: string): string {
  if (code === 'WORKER_MODE_GATED') return 'Delegated edits require an approved isolated patch check or local operator opt-in (cli.ts worker-policy).';
  return code === 'WORKER_TOOLSET_GATED'
    ? 'Only the built-in project tool set is enabled by default; opt in with cli.ts worker-policy.'
    : 'This delegated worker route is gated by default; enable local CLI routes with cli.ts worker-policy --allow-local-cli.';
}
