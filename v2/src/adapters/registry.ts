/**
 * The platform adapter registry. Adding a platform: write v2/src/adapters/<name>.ts implementing PlatformAdapter
 * and add it to ADAPTERS below. The store, runner and tool catalog take routes from here.
 */
import type { PlatformAdapter } from './types.ts';
import { claude } from './claude.ts';
import { codex } from './codex.ts';
import { openaiApi } from './openai-api.ts';
import { antigravity } from './antigravity.ts';

/** In the order routes are listed to callers. Omitted routes default to automatic routing (`auto`). */
const ADAPTERS: PlatformAdapter[] = [claude, codex, openaiApi, antigravity];
const BY_ID = new Map(ADAPTERS.map(adapter => [adapter.capabilities.id, adapter]));

export const adapterIds = (): string[] => ADAPTERS.map(adapter => adapter.capabilities.id);
export const adapter = (id: string): PlatformAdapter | undefined => BY_ID.get(id);
export const allAdapters = (): readonly PlatformAdapter[] => ADAPTERS;
export const DEFAULT_ROUTE = 'auto';

/** Adds an adapter at run time (tests, and platforms loaded outside this list). An existing id is refused. */
export function registerAdapter(platform: PlatformAdapter): void {
  if (BY_ID.has(platform.capabilities.id)) throw new Error(`adapter ${platform.capabilities.id} is already registered`);
  ADAPTERS.push(platform); BY_ID.set(platform.capabilities.id, platform);
}
export function unregisterAdapter(id: string): void {
  const i = ADAPTERS.findIndex(a => a.capabilities.id === id);
  if (i > 0) { ADAPTERS.splice(i, 1); BY_ID.delete(id); }  // index 0 is the default route and stays
}
