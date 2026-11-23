import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const protectionScript = fileURLToPath(new URL('../scripts/automation/Protect-AcTokenHome.ps1', import.meta.url));

export function ensureTokenHome(home: string, create = false): void {
  if (process.platform !== 'win32') return;
  const powershell = (process.env.PATH ?? '').split(path.delimiter).filter(path.isAbsolute)
    .map(folder => path.join(folder, 'pwsh.exe')).find(file => fs.existsSync(file));
  if (!powershell) throw new Error('AC_POWERSHELL_UNAVAILABLE: Install PowerShell 7 and add its directory to the service account PATH.');
  try {
    execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-File', protectionScript,
      '-DataRoot', path.resolve(home), '-Action', create ? 'Create' : 'Verify'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 30000,
      env: { ...process.env, NoDefaultCurrentDirectoryInExePath: '1' },
    });
  } catch (error) {
    const reason = String((error as { stderr?: string }).stderr || (error as Error).message).trim();
    throw new Error(`AC_HOME_NOT_PRIVATE: ${reason}\nUse Protect-AcTokenHome.ps1 -DataRoot <directory> -Action Repair on the intended local home before retrying.`);
  }
}

export function connectionPath(home: string, basename: string): string {
  if (basename.length <= 5 || !basename.endsWith('.json') || /[<>:"/\\|?*\u0000-\u001f]/.test(basename)
    || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$|clock\$)(?:[ .]|$)/i.test(basename))
    throw new Error('Invalid connection filename');
  return path.join(home, 'connections', basename);
}

export function assertRegularTokenFile(file: string): boolean {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.nlink !== 1)) throw new Error(`Token path is not a regular unlinked file: ${file}`);
  return stat !== undefined;
}

export function writePrivateJson(file: string, value: object, replace: boolean): void {
  const parent = path.dirname(file);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(parent).isDirectory()) throw new Error(`Token directory is redirected: ${parent}`);
  if (assertRegularTokenFile(file) && !replace) throw new Error(`Connection already exists: ${file}`);
  const temp = path.join(parent, `.token-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx', flush: true });
    if (replace) fs.renameSync(temp, file);
    else fs.linkSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
}
