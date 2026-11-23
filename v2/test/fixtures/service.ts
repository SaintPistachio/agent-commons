import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store as ServiceStore, type Actor, type Json } from '../../src/store.ts';
import { startServer as startService, type ServerOptions } from '../../src/server.ts';
import type { RunnerOptions } from '../../src/runner.ts';

export type { Actor, Json } from '../../src/store.ts';
export { CommonsError } from '../../src/store.ts';
export { checkLoopbackHeaders, releaseInfo } from '../../src/server.ts';

const fakeWorkers = () => null;

/** Legacy feature fixtures exercise the adapters with fake executables and seed projects as the operator. */
export class Store extends ServiceStore {
  constructor(home: string) { super(home, fakeWorkers); }
  override op_project_create(actor: Actor, input: Json): Json {
    return super.op_project_create({ ...actor, role: 'operator' }, input);
  }
}

export function protectFixtureHome(home: string): void {
  if (process.platform !== 'win32') return;
  fs.mkdirSync(home, { recursive: true });
  execFileSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File',
    fileURLToPath(new URL('../../scripts/automation/Protect-AcTokenHome.ps1', import.meta.url)),
    '-DataRoot', path.resolve(home), '-Action', 'Repair'], { windowsHide: true });
}

export async function startServer(home: string, port?: number, runnerOptions?: RunnerOptions | false, options: ServerOptions = {}) {
  protectFixtureHome(home);
  return startService(home, port, runnerOptions, { workerPolicy: fakeWorkers, ...options });
}
