import { compareCliVersions, isStableCliVersion } from './cli-freshness.ts';
import type { SdkSnapshot } from './types.ts';

export function stableSdkVersion(value: string): boolean {
  return !value.includes('+') && isStableCliVersion(value);
}

export function pendingSdkVersion({ installed, latest }: SdkSnapshot): string | null {
  if (!installed || !latest || !stableSdkVersion(latest)) return null;
  // Recognize Python's usual alpha, beta and RC spelling as well as stable releases.
  const comparable = installed.replace(/^(\d+\.\d+\.\d+)(a|b|rc)(\d+)$/, '$1-$2.$3');
  if (!stableSdkVersion(installed) && comparable === installed) return null;
  try { return compareCliVersions(latest, comparable) > 0 ? latest : null; }
  catch { return null; }
}

/** The updater could not restore a known-good disk state. Do not release its reservation. */
export class SdkRecoveryRequired extends Error {}

export function sdkStatusLine(row: {
  sdk_version?: string | null;
  sdk_latest?: string | null;
  sdk_auto_update?: number;
  sdk_last_update_at?: string | null;
  sdk_last_update_result?: string | null;
  sdk_last_update_version?: string | null;
}): string {
  const installed = row.sdk_version ?? null, latest = row.sdk_latest ?? null;
  const result = row.sdk_last_update_result === 'running'
    ? 'running (or interrupted; see SDK update log)' : row.sdk_last_update_result;
  return `SDK: installed ${installed ?? 'unknown'}, latest stable ${latest ?? 'unknown'}; ` +
    `auto-update ${row.sdk_auto_update === 1 ? 'on' : 'off'}; ` +
    `last update: ${result ? `${result} [${row.sdk_last_update_version}] at ${row.sdk_last_update_at}` : 'never'}` +
    (pendingSdkVersion({ installed, latest }) ? `; WARN newer stable SDK ${latest} is available` : '');
}
