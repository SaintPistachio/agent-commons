/**
 * Encrypted, secret-free off-machine backup bundles for Agent Commons v2 (`ACBAK1`).
 *
 * Staging and plaintext extraction happen strictly in local non-synced storage; OneDrive receives only the finished
 * immutable `.acbak.enc` archive, `.sha256`, and non-secret `.meta.json`. Plaintext credentials and MCP bearer
 * tokens are excluded by allowlist and enforced by a fail-closed denylist before encryption.
 */
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { fail } from './errors.ts';
import { restoreDatabase } from './ops.ts';
import type { Json } from './store.ts';

const MAGIC = Buffer.from('ACBAK1\0\0', 'ascii'); // 8 bytes
const HEADER_LEN = 64; // 8 magic + 32 salt + 12 iv + 4 log2N + 4 r + 4 p
const TAG_LEN = 16;
const SCRYPT_LOG2_N = 17; // N = 131072
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

const FORBIDDEN_PATTERNS = [
  /(^|\/)connections(\/|$)/i,
  /(^|\/)secrets(\/|$)/i,
  /(^|\/)[^/]*\.env($|\.)/i,
  /\.dpapi$/i,
  /\.key$/i,
  /\.pem$/i,
  /\.pfx$/i,
  /\.p12$/i,
  /(^|\/)credentials\.json$/i,
];

const HOME_STATE_DIRS = ['artifacts', 'helpers', 'automation'] as const;
const HOME_STATE_FILES = ['backup-config.json', 'tools.json'] as const;
const HELPER_STATE_DIRS = ['evidence', 'billing-evidence', 'activation'] as const;
const HELPER_STATE_FILES = ['account-costs.json', 'credit-observations.json', 'limit-evidence.json', 'limits-plan.json'] as const;

export interface BundleFileEntry {
  path: string;
  bytes: number;
  sha256: string;
}

export interface BundleManifest {
  format: 1;
  created_at: string;
  ac_schema: number;
  artifact_count: number;
  has_helper_ledger: boolean;
  recovery_key_id?: string;
  encrypted?: false;
  files: BundleFileEntry[];
}

export type BundleCredential =
  | { passphrase: string; recoveryKey?: never; standardArchive?: never }
  | { recoveryKey: Buffer; passphrase?: never; standardArchive?: never }
  | { standardArchive: true; passphrase?: never; recoveryKey?: never };

export type BundleCreateOptions = BundleCredential & {
  home: string;
  outFile: string;
  helperRoot?: string;
  stagingParent?: string;
};

export interface BundleCreateResult {
  file: string;
  sha256File: string;
  metaFile: string;
  sha256: string;
  bytes: number;
  manifest: BundleManifest;
}

export interface BundleVerifyResult {
  file: string;
  sha256: string;
  manifest: BundleManifest;
}

export type BundleRestoreOptions = BundleCredential & {
  sourceFile: string;
  home: string;
  schemaVersion: number;
  helperRoot?: string;
  skipHelper?: boolean;
  stagingParent?: string;
};

export interface BundleRestoreResult {
  home: string;
  file: string;
  schema: number;
  running: number;
  queued: number;
  artifacts: number;
  helperRestored: boolean;
  manifest: BundleManifest;
}

function checkStandardPayload(home: string, payloadDir: string, files: string[]): void {
  const connections = path.join(home, 'connections');
  const tokens: Buffer[] = [];
  const pattern = /(?:sk-(?:proj|admin)-[A-Za-z0-9_-]{70,}|ghp_[A-Za-z0-9]{36,}|xox[baprs]-[A-Za-z0-9-]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/;
  try {
    if (fs.existsSync(connections)) {
      for (const entry of fs.readdirSync(connections, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const { token } = JSON.parse(fs.readFileSync(path.join(connections, entry.name), 'utf8'));
        if (typeof token === 'string' && token.length >= 24) tokens.push(Buffer.from(token));
      }
    }
    for (const relative of files) {
      const contents = fs.readFileSync(path.join(payloadDir, relative));
      if (tokens.some(token => contents.includes(token)) || pattern.test(contents.toString('latin1'))) {
        fail('CREDENTIAL_IN_STANDARD_BACKUP', 400, `Sensitive credential material detected in ${relative}; cloud archive was not created`);
      }
    }
  } finally {
    for (const token of tokens) token.fill(0);
  }
}

function sha256File(file: string): string {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function tarBin(): string {
  return process.platform === 'win32'
    ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
}

export function isSyncedPath(target: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const resolved = path.resolve(target);
  const segments = resolved.split(/[\\/]+/).filter(Boolean).map(s => s.toLowerCase());
  if (segments.some(s => s === 'onedrive' || s.startsWith('onedrive - '))) return true;
  const roots = [env.OneDrive, env.OneDriveConsumer, env.OneDriveCommercial, ...(env.CODEX_SYNC_ROOTS ?? '').split(';')]
    .flatMap(value => value?.trim() ? [value.trim()] : []);
  for (const r of roots) {
    const root = path.resolve(r);
    if (resolved.toLowerCase() === root.toLowerCase() || resolved.toLowerCase().startsWith(root.toLowerCase() + path.sep)) return true;
  }
  return false;
}

export function assertNotSyncedPath(target: string, label: string, env: NodeJS.ProcessEnv = process.env): void {
  const resolved = path.resolve(target);
  let ancestor = resolved;
  while (!fs.lstatSync(ancestor, { throwIfNoEntry: false })) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) fail('NOT_FOUND', 400, `Storage root is unavailable: ${parent}`);
    ancestor = parent;
  }
  const physical = path.resolve(fs.realpathSync.native(ancestor), path.relative(ancestor, resolved));
  if (isSyncedPath(resolved, env) || isSyncedPath(physical, env)) {
    fail('SYNC_PATH_FORBIDDEN', 400, `${label} (${target}) must not reside inside a synchronized folder`);
  }
}

export function assertSafeStagingPath(relPath: string): string {
  const norm = relPath.replaceAll('\\', '/');
  if (!norm || norm.startsWith('/') || norm.split('/').some(part => !part || part === '..' || part === '.' || part.includes(':'))) {
    fail('SECRET_PATH_FORBIDDEN', 400, `unsafe bundle path: ${relPath}`);
  }
  for (const re of FORBIDDEN_PATTERNS) {
    if (re.test(norm)) fail('SECRET_PATH_FORBIDDEN', 400, `forbidden secret or token path in bundle: ${norm}`);
  }
  return norm;
}

function defaultStagingParent(): string {
  const configured = process.env.CODEX_TEMP_ROOT;
  if (configured && fs.existsSync(configured) && !isSyncedPath(configured)) return configured;
  return os.tmpdir();
}

function protectWindowsBackupDirectory(dir: string): void {
  if (process.platform !== 'win32') return;
  // A new empty directory inherits its parent ACL on Windows. Restrict it before writing plaintext.
  const command = (name: string, args: string[]) => execFileSync(
    path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', name), args,
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  const sid = command('whoami.exe', ['/user', '/fo', 'csv', '/nh']).match(/S-1-(?:\d+-)+\d+/)?.[0];
  if (!sid) throw new Error('Could not determine the current Windows user SID for backup staging');
  command('icacls.exe', [dir, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F']);
}

function privateBackupStage(parent: string, prefix: string): string {
  const stage = fs.mkdtempSync(path.join(parent, prefix));
  try {
    protectWindowsBackupDirectory(stage);
    return stage;
  } catch (error) {
    fs.rmdirSync(stage);
    throw error;
  }
}

const TRANSIENT_HELPER_LOCKS = new Set([
  'helpers/antigravity/catalog.lock',
  'helpers/antigravity/candidate-attempts.lock',
  'helpers/antigravity/revalidation.lock',
]);

function copyTreeFiltered(srcDir: string, dstDir: string, relBase: string): void {
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(dstDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    assertSafeStagingPath(rel);
    const src = path.join(srcDir, entry.name);
    const dst = path.join(dstDir, entry.name);
    if (entry.isSymbolicLink()) fail('SECRET_PATH_FORBIDDEN', 400, `symlinks/junctions are forbidden in backup staging: ${rel}`);
    if (entry.isDirectory()) copyTreeFiltered(src, dst, rel);
    // The helper takes byte-range locks that Windows will refuse to copy while held.
    else if (entry.isFile() && !TRANSIENT_HELPER_LOCKS.has(rel)) fs.copyFileSync(src, dst);
  }
}

function listFilesRecursive(dir: string, base = ''): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) fail('SECRET_PATH_FORBIDDEN', 400, `symlink forbidden in staged payload: ${rel}`);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

async function onlineSqliteCopy(srcPath: string, dstPath: string): Promise<{ userVersion: number }> {
  if (!fs.existsSync(srcPath)) fail('NOT_FOUND', 404, `database not found: ${srcPath}`);
  fs.mkdirSync(path.dirname(dstPath), { recursive: true });
  const live = new DatabaseSync(srcPath, { readOnly: true });
  try { await backup(live, dstPath); } finally { live.close(); }
  const copy = new DatabaseSync(dstPath);
  try {
    copy.exec('PRAGMA journal_mode=DELETE');
    if ((copy.prepare('PRAGMA integrity_check').get() as Json).integrity_check !== 'ok') {
      fail('BACKUP_CORRUPT', 500, `database copy ${dstPath} failed PRAGMA integrity_check`);
    }
    const userVersion = Number((copy.prepare('PRAGMA user_version').get() as Json).user_version ?? 0);
    return { userVersion };
  } finally {
    copy.close();
  }
}

function recoveryKeyId(key: Buffer): string {
  return crypto.createHash('sha256').update('Agent Commons backup recovery key v1').update(key).digest('hex').slice(0, 32);
}

function validateBundleSecret(secret: string | Buffer, minimum: number): void {
  if (typeof secret === 'string') {
    if (secret.length < minimum) fail('INVALID_PASSPHRASE', 400, 'backup passphrase is missing or too short');
  } else if (!Buffer.isBuffer(secret) || secret.length !== 32) {
    fail('INVALID_RECOVERY_KEY', 400, 'backup recovery key must be exactly 32 binary bytes');
  }
}

export function encryptBuffer(plaintext: Buffer, secret: string | Buffer): Buffer {
  validateBundleSecret(secret, 8);
  const salt = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const header = Buffer.alloc(HEADER_LEN);
  MAGIC.copy(header, 0);
  salt.copy(header, 8);
  iv.copy(header, 40);
  header.writeUInt32BE(SCRYPT_LOG2_N, 52);
  header.writeUInt32BE(SCRYPT_R, 56);
  header.writeUInt32BE(SCRYPT_P, 60);
  const key = crypto.scryptSync(secret, salt, 32, { N: 1 << SCRYPT_LOG2_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM });
  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(header);
    const enc1 = cipher.update(plaintext);
    const enc2 = cipher.final();
    const tag = cipher.getAuthTag();
    return Buffer.concat([header, enc1, enc2, tag]);
  } finally {
    key.fill(0);
  }
}

export function decryptBuffer(ciphertext: Buffer, secret: string | Buffer): Buffer {
  validateBundleSecret(secret, 1);
  if (ciphertext.length < HEADER_LEN + TAG_LEN) fail('BUNDLE_CORRUPT', 400, 'encrypted bundle is truncated');
  const header = ciphertext.subarray(0, HEADER_LEN);
  if (!header.subarray(0, 8).equals(MAGIC)) fail('BUNDLE_CORRUPT', 400, 'unrecognized backup bundle header');
  const salt = header.subarray(8, 40);
  const iv = header.subarray(40, 52);
  const log2N = header.readUInt32BE(52);
  const r = header.readUInt32BE(56);
  const p = header.readUInt32BE(60);
  if (log2N < 10 || log2N > 20 || r < 1 || r > 32 || p < 1 || p > 16) {
    fail('BUNDLE_CORRUPT', 400, 'invalid scrypt parameters in bundle header');
  }
  const body = ciphertext.subarray(HEADER_LEN, ciphertext.length - TAG_LEN);
  const tag = ciphertext.subarray(ciphertext.length - TAG_LEN);
  const key = crypto.scryptSync(secret, salt, 32, { N: 1 << log2N, r, p, maxmem: SCRYPT_MAXMEM });
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    return typeof secret === 'string'
      ? fail('BAD_PASSPHRASE', 401, 'bundle decryption failed (wrong passphrase or corrupted bundle)')
      : fail('BAD_RECOVERY_KEY', 401, 'bundle decryption failed (wrong recovery key or corrupted bundle)');
  } finally {
    key.fill(0);
  }
}

export async function createBackupBundle(options: BundleCreateOptions): Promise<BundleCreateResult> {
  const home = path.resolve(options.home);
  const outFile = path.resolve(options.outFile);
  const stageBase = path.resolve(options.stagingParent ?? defaultStagingParent());
  assertNotSyncedPath(home, 'home');
  assertNotSyncedPath(outFile, 'outFile');
  assertNotSyncedPath(stageBase, 'stagingParent');

  const helperLocal = options.helperRoot ? path.join(path.resolve(options.helperRoot), '.local') : undefined;
  const helperUsage = helperLocal && path.join(helperLocal, 'usage.sqlite3');
  if (helperUsage && !fs.statSync(helperUsage, { throwIfNoEntry: false })?.isFile()) {
    fail('HELPER_LEDGER_MISSING', 404, `Configured API helper ledger is missing: ${helperUsage}`);
  }

  fs.mkdirSync(stageBase, { recursive: true });
  const stageDir = privateBackupStage(stageBase, 'ac-bundle-');
  const payloadDir = path.join(stageDir, 'payload');
  fs.mkdirSync(payloadDir, { recursive: true });

  try {
    const { userVersion } = await onlineSqliteCopy(path.join(home, 'commons.sqlite'), path.join(payloadDir, 'commons.sqlite'));
    if (userVersion < 1) fail('BACKUP_CORRUPT', 400, 'commons.sqlite has invalid schema version');

    // Copy and verify artifacts against the SQLite copy.
    const srcArtifacts = path.join(home, 'artifacts');
    const dstArtifacts = path.join(payloadDir, 'artifacts');
    fs.mkdirSync(dstArtifacts, { recursive: true });
    if (fs.existsSync(srcArtifacts)) copyTreeFiltered(srcArtifacts, dstArtifacts, 'artifacts');

    const db = new DatabaseSync(path.join(payloadDir, 'commons.sqlite'), { readOnly: true });
    let expectedArtifacts: Array<{ sha256: string }> = [];
    try {
      expectedArtifacts = db.prepare('SELECT DISTINCT sha256 FROM artifacts').all() as Array<{ sha256: string }>;
    } finally {
      db.close();
    }
    const artifactFiles = fs.readdirSync(dstArtifacts, { withFileTypes: true }).filter(e => e.isFile());
    for (const entry of artifactFiles) {
      const full = path.join(dstArtifacts, entry.name);
      if (/^[0-9a-f]{64}$/i.test(entry.name)) {
        const digest = sha256File(full);
        if (digest !== entry.name.toLowerCase()) fail('ARTIFACT_CORRUPT', 500, `artifact ${entry.name} hash mismatch (${digest})`);
      }
    }
    for (const row of expectedArtifacts) {
      const full = path.join(dstArtifacts, row.sha256);
      if (!fs.existsSync(full)) fail('ARTIFACT_MISSING', 500, `artifact ${row.sha256} referenced in DB is missing from ${srcArtifacts}`);
    }

    for (const dirName of ['helpers', 'automation']) {
      const srcDir = path.join(home, dirName);
      if (fs.existsSync(srcDir)) copyTreeFiltered(srcDir, path.join(payloadDir, dirName), dirName);
    }
    for (const fileName of HOME_STATE_FILES) {
      const srcFile = path.join(home, fileName);
      if (fs.existsSync(srcFile)) {
        assertSafeStagingPath(fileName);
        fs.copyFileSync(srcFile, path.join(payloadDir, fileName));
      }
    }

    if (helperUsage && helperLocal) {
      const helperStage = path.join(payloadDir, 'openai-helper');
      await onlineSqliteCopy(helperUsage, path.join(helperStage, 'usage.sqlite3'));
      // Account evidence can contain invoices and screenshots. Keep it local for standard archives.
      for (const dirName of options.standardArchive ? [] : HELPER_STATE_DIRS) {
        const srcDir = path.join(helperLocal, dirName);
        if (fs.existsSync(srcDir)) copyTreeFiltered(srcDir, path.join(helperStage, dirName), `openai-helper/${dirName}`);
      }
      for (const fileName of HELPER_STATE_FILES) {
        const srcFile = path.join(helperLocal, fileName);
        if (fs.existsSync(srcFile)) fs.copyFileSync(srcFile, path.join(helperStage, fileName));
      }
    }

    const relFiles = listFilesRecursive(payloadDir);
    if (options.standardArchive) checkStandardPayload(home, payloadDir, relFiles);
    const files: BundleFileEntry[] = relFiles.map(rel => {
      assertSafeStagingPath(rel);
      const full = path.join(payloadDir, rel);
      return {
        path: rel,
        bytes: fs.statSync(full).size,
        sha256: sha256File(full),
      };
    });

    const manifest: BundleManifest = {
      format: 1,
      created_at: new Date().toISOString(),
      ac_schema: userVersion,
      artifact_count: artifactFiles.length,
      has_helper_ledger: Boolean(helperUsage),
      ...(options.recoveryKey ? { recovery_key_id: recoveryKeyId(options.recoveryKey) } : {}),
      ...(options.standardArchive ? { encrypted: false as const } : {}),
      files,
    };
    fs.writeFileSync(path.join(stageDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    const tarGz = path.join(stageDir, 'bundle.tar.gz');
    execFileSync(tarBin(), ['-C', stageDir, '-czf', tarGz, 'manifest.json', 'payload'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const payload = fs.readFileSync(tarGz);
    if (options.standardArchive && !outFile.toLowerCase().endsWith('.acbak.tar.gz')) {
      fail('BACKUP_CREDENTIAL_MISMATCH', 400, 'standard backup output must end in .acbak.tar.gz');
    }
    const archive = options.standardArchive ? payload : encryptBuffer(payload, options.recoveryKey ?? options.passphrase);

    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const tmpOut = `${outFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmpOut, archive, { mode: 0o600 });
    fs.renameSync(tmpOut, outFile);

    const bundleSha = sha256File(outFile);
    const sha256Path = `${outFile}.sha256`;
    const metaPath = `${outFile}.meta.json`;
    fs.writeFileSync(sha256Path, `${bundleSha}  ${path.basename(outFile)}\n`);
    fs.writeFileSync(metaPath, JSON.stringify({
      format: 1,
      created_at: manifest.created_at,
      ac_schema: manifest.ac_schema,
      artifact_count: manifest.artifact_count,
      has_helper_ledger: manifest.has_helper_ledger,
      ...(manifest.recovery_key_id ? { recovery_key_id: manifest.recovery_key_id } : {}),
      encrypted: manifest.encrypted !== false,
      bytes: archive.length,
      sha256: bundleSha,
    }, null, 2));

    return { file: outFile, sha256File: sha256Path, metaFile: metaPath, sha256: bundleSha, bytes: archive.length, manifest };
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
}

function checkStandardArchiveEntries(file: string): void {
  const list = (flags: string) => execFileSync(tarBin(), [flags, file], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  }).split(/\r?\n/).filter(Boolean);
  const names = list('-tzf');
  const details = list('-tvzf');
  if (names.length !== details.length || details.some(detail => !/^[-d]/.test(detail))) {
    fail('BUNDLE_CORRUPT', 400, 'standard backup archive must contain only regular files and directories');
  }
  const seen = new Set<string>();
  for (const entry of names) {
    if (entry.includes('\\')) fail('BUNDLE_CORRUPT', 400, 'standard backup archive paths must use forward slashes');
    const name = assertSafeStagingPath(entry.replace(/\/$/, ''));
    const normalized = name.toLowerCase();
    if (seen.has(normalized) || (name !== 'manifest.json' && name !== 'payload' && !name.startsWith('payload/'))
        || name.split('/').some(part => /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part)
          || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
      fail('BUNDLE_CORRUPT', 400, 'standard backup contains an unexpected or unsafe archive path');
    }
    seen.add(normalized);
  }
}

function extractAndValidateBundle(sourceFile: string, credential: BundleCredential, stageDir: string): { sha256: string; manifest: BundleManifest; payloadDir: string } {
  const resolvedSource = path.resolve(sourceFile);
  if (!fs.existsSync(resolvedSource)) fail('NOT_FOUND', 404, `bundle not found: ${resolvedSource}`);

  const bundleSha = sha256File(resolvedSource);
  const shaSidecar = `${resolvedSource}.sha256`;
  if (fs.existsSync(shaSidecar)) {
    const recorded = fs.readFileSync(shaSidecar, 'utf8').trim().split(/\s+/)[0]?.toLowerCase();
    if (!recorded || recorded !== bundleSha) fail('CHECKSUM_MISMATCH', 400, `SHA-256 mismatch for ${resolvedSource}`);
  } else if (credential.standardArchive) {
    fail('CHECKSUM_MISSING', 400, 'standard backup requires its SHA-256 sidecar');
  }

  const tarGz = path.join(stageDir, 'bundle.tar.gz');
  const archive = fs.readFileSync(resolvedSource);
  if (credential.standardArchive) {
    const metaPath = `${resolvedSource}.meta.json`;
    if (!fs.existsSync(metaPath)) fail('METADATA_MISSING', 400, 'standard backup requires its metadata sidecar');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (!resolvedSource.toLowerCase().endsWith('.acbak.tar.gz') || archive[0] !== 0x1f || archive[1] !== 0x8b
        || meta.encrypted !== false || meta.sha256 !== bundleSha || meta.bytes !== archive.length) {
      fail('BACKUP_CREDENTIAL_MISMATCH', 400, 'standard backup name, signature, or metadata does not match');
    }
  }
  if (crypto.createHash('sha256').update(archive).digest('hex') !== bundleSha) {
    fail('CHECKSUM_MISMATCH', 400, 'backup archive changed while reading');
  }
  fs.writeFileSync(tarGz, credential.standardArchive ? archive : decryptBuffer(archive, credential.recoveryKey ?? credential.passphrase));
  if (credential.standardArchive) checkStandardArchiveEntries(tarGz);
  execFileSync(tarBin(), ['-C', stageDir, '-xzf', tarGz], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

  const manifestFile = path.join(stageDir, 'manifest.json');
  const payloadDir = path.join(stageDir, 'payload');
  if (!fs.lstatSync(manifestFile, { throwIfNoEntry: false })?.isFile()
      || !fs.lstatSync(payloadDir, { throwIfNoEntry: false })?.isDirectory()) {
    fail('BUNDLE_CORRUPT', 400, 'bundle missing regular manifest.json or payload directory');
  }

  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as BundleManifest;
  if (manifest.format !== 1 || !Array.isArray(manifest.files)) fail('BUNDLE_CORRUPT', 400, 'unsupported bundle manifest');
  if (Boolean(credential.standardArchive) !== (manifest.encrypted === false)
      || manifest.recovery_key_id !== (credential.recoveryKey ? recoveryKeyId(credential.recoveryKey) : undefined)) {
    fail('BACKUP_CREDENTIAL_MISMATCH', 400, 'backup credential mode does not match the archive manifest');
  }

  const expectedMap = new Map<string, BundleFileEntry>();
  for (const entry of manifest.files) {
    const safe = assertSafeStagingPath(entry.path);
    expectedMap.set(safe, entry);
  }
  const actualFiles = listFilesRecursive(payloadDir);
  const helperFiles = ['usage.sqlite3', ...HELPER_STATE_FILES];
  const recognized = (relative: string) => relative === 'commons.sqlite'
    || HOME_STATE_FILES.some(name => relative === name)
    || HOME_STATE_DIRS.some(name => relative.startsWith(name + '/'))
    || (manifest.has_helper_ledger === true && (
      helperFiles.some(name => relative === 'openai-helper/' + name)
      || (!credential.standardArchive && HELPER_STATE_DIRS.some(name => relative.startsWith('openai-helper/' + name + '/')))
    ));
  if (typeof manifest.has_helper_ledger !== 'boolean' || actualFiles.some(relative => !recognized(relative))) {
    fail('BUNDLE_CORRUPT', 400, 'bundle contains unexpected recovery files or an invalid helper ledger flag');
  }
  if (actualFiles.length !== expectedMap.size) {
    fail('BUNDLE_CORRUPT', 400, `bundle file count mismatch (manifest ${expectedMap.size}, actual ${actualFiles.length})`);
  }
  for (const rel of actualFiles) {
    const expected = expectedMap.get(rel);
    if (!expected) return fail('BUNDLE_CORRUPT', 400, `unexpected file in bundle payload: ${rel}`);
    const full = path.join(payloadDir, rel);
    const size = fs.statSync(full).size;
    const digest = sha256File(full);
    if (size !== expected.bytes || digest !== expected.sha256) {
      fail('BUNDLE_CORRUPT', 400, `payload file verification failed: ${rel}`);
    }
  }

  for (const dbRel of ['commons.sqlite', ...(manifest.has_helper_ledger ? ['openai-helper/usage.sqlite3'] : [])]) {
    const dbPath = path.join(payloadDir, dbRel);
    if (!fs.existsSync(dbPath)) fail('BUNDLE_CORRUPT', 400, `missing expected database in bundle: ${dbRel}`);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      if ((db.prepare('PRAGMA integrity_check').get() as Json).integrity_check !== 'ok') {
        fail('BACKUP_CORRUPT', 400, `${dbRel} failed PRAGMA integrity_check`);
      }
    } finally {
      db.close();
    }
  }

  return { sha256: bundleSha, manifest, payloadDir };
}

export function verifyBackupBundle(options: BundleCredential & { sourceFile: string; stagingParent?: string }): BundleVerifyResult {
  const stageBase = path.resolve(options.stagingParent ?? defaultStagingParent());
  assertNotSyncedPath(stageBase, 'stagingParent');
  fs.mkdirSync(stageBase, { recursive: true });
  const stageDir = privateBackupStage(stageBase, 'ac-verify-');
  try {
    const { sha256, manifest } = extractAndValidateBundle(options.sourceFile, options, stageDir);
    return { file: path.resolve(options.sourceFile), sha256, manifest };
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
}

export async function restoreBackupBundle(options: BundleRestoreOptions): Promise<BundleRestoreResult> {
  const home = path.resolve(options.home);
  const helperLocal = options.helperRoot ? path.join(path.resolve(options.helperRoot), '.local') : undefined;
  const stageBase = path.resolve(options.stagingParent ?? defaultStagingParent());
  assertNotSyncedPath(home, 'home');
  if (helperLocal) assertNotSyncedPath(helperLocal, 'helperRoot');
  assertNotSyncedPath(stageBase, 'stagingParent');

  const file = path.join(home, 'commons.sqlite');
  const assertDatabaseAbsent = (db: string) => {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      if (fs.lstatSync(db + suffix, { throwIfNoEntry: false })) {
        fail('HOME_NOT_EMPTY', 409, `${db + suffix} exists; restore only into a new destination`);
      }
    }
  };
  assertDatabaseAbsent(file);
  if (helperLocal) assertDatabaseAbsent(path.join(helperLocal, 'usage.sqlite3'));

  const directories: string[] = [];
  const published: { source: string; target: string }[] = [];
  const stages: string[] = [];
  const locks: string[] = [];
  const ensureDirectory = (dir: string): void => {
    if (dir !== path.dirname(dir)) ensureDirectory(path.dirname(dir));
    const existing = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (existing?.isDirectory() && !existing.isSymbolicLink()) return;
    if (existing) fail('HOME_NOT_EMPTY', 409, `Restore destination is not a regular directory: ${dir}`);
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
      directories.push(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const appeared = fs.lstatSync(dir);
      if (!appeared.isDirectory() || appeared.isSymbolicLink()) throw error;
    }
  };
  const lock = (dir: string) => {
    ensureDirectory(dir);
    if (directories.includes(dir)) protectWindowsBackupDirectory(dir);
    const lockFile = path.join(dir, '.restore.lock');
    try {
      fs.closeSync(fs.openSync(lockFile, 'wx', 0o600));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        fail('RESTORE_IN_PROGRESS', 409, `A restore lock exists at ${lockFile}. Check for a running restore before clearing it.`);
      }
      throw error;
    }
    locks.push(lockFile);
  };
  const stageAt = (parent: string, prefix: string) => {
    ensureDirectory(parent);
    const stage = privateBackupStage(parent, prefix);
    stages.push(stage);
    return stage;
  };
  const publish = (source: string, target: string) => {
    ensureDirectory(path.dirname(target));
    try {
      fs.linkSync(source, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        fail('HOME_NOT_EMPTY', 409, `Restore destination already exists: ${target}`);
      }
      throw error;
    }
    published.push({ source, target });
  };

  let failed = false;
  let failure: unknown;
  try {
    const stageDir = stageAt(stageBase, 'ac-restore-');
    const { manifest, payloadDir } = extractAndValidateBundle(options.sourceFile, options, stageDir);
    if (manifest.has_helper_ledger && !helperLocal && !options.skipHelper) {
      fail('HELPER_ROOT_REQUIRED', 400, 'The bundle includes a helper ledger. Select --helper-root DIR or explicitly use --skip-helper.');
    }
    lock(home);
    if (helperLocal && manifest.has_helper_ledger) lock(helperLocal);
    // Stage beside each destination so atomic, no-replace links work even across drives.
    const homeStage = stageAt(path.dirname(home), 'ac-restore-home-');
    const restored = await restoreDatabase(path.join(payloadDir, 'commons.sqlite'), homeStage, options.schemaVersion);
    const helperPayload = path.join(payloadDir, 'openai-helper');
    let helperRestored = false;
    if (helperLocal && manifest.has_helper_ledger) {
      const helperStage = stageAt(helperLocal, 'ac-restore-helper-');
      const usage = path.join(helperStage, 'usage.sqlite3');
      await onlineSqliteCopy(path.join(helperPayload, 'usage.sqlite3'), usage);
      for (const relative of listFilesRecursive(helperPayload)) {
        if (relative === 'usage.sqlite3') continue;
        const staged = path.join(helperStage, relative);
        fs.mkdirSync(path.dirname(staged), { recursive: true });
        fs.copyFileSync(path.join(helperPayload, relative), staged);
        publish(staged, path.join(helperLocal, relative));
      }
      assertDatabaseAbsent(path.join(helperLocal, 'usage.sqlite3'));
      publish(usage, path.join(helperLocal, 'usage.sqlite3'));
      helperRestored = true;
    }
    ensureDirectory(path.join(home, 'artifacts'));
    for (const relative of listFilesRecursive(payloadDir)) {
      if (relative === 'commons.sqlite' || relative.startsWith('openai-helper/')) continue;
      const staged = path.join(homeStage, relative);
      fs.mkdirSync(path.dirname(staged), { recursive: true });
      fs.copyFileSync(path.join(payloadDir, relative), staged);
      publish(staged, path.join(home, relative));
    }
    // A service can open the home only after the auxiliary files and any helper ledger are in place.
    assertDatabaseAbsent(file);
    publish(restored.file, file);
    return {
      home, file, schema: restored.schema, running: restored.running, queued: restored.queued,
      artifacts: manifest.artifact_count, helperRestored, manifest,
    };
  } catch (error) {
    failed = true;
    const rollbackErrors: unknown[] = [];
    for (const { source, target } of published.reverse()) {
      try {
        const owned = fs.statSync(source, { bigint: true });
        const current = fs.lstatSync(target, { bigint: true, throwIfNoEntry: false });
        if (current?.dev === owned.dev && current.ino === owned.ino) fs.unlinkSync(target);
      } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    failure = rollbackErrors.length
      ? new AggregateError([error, ...rollbackErrors], 'Restore failed and could not fully roll back')
      : error;
    throw failure;
  } finally {
    const cleanupErrors: unknown[] = [];
    const clean = (action: () => void) => {
      try { action(); } catch (error) { cleanupErrors.push(error); }
    };
    for (const stage of stages.reverse()) clean(() => fs.rmSync(stage, { recursive: true, force: true }));
    for (const lockFile of locks.reverse()) clean(() => fs.unlinkSync(lockFile));
    if (failed) {
      for (const dir of directories.reverse()) clean(() => {
        try { fs.rmdirSync(dir); }
        catch (error) {
          if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        }
      });
      if (cleanupErrors.length) throw new AggregateError([failure, ...cleanupErrors], 'Restore failed and cleanup was incomplete');
    } else {
      for (const error of cleanupErrors) process.emitWarning(String(error), { code: 'RESTORE_CLEANUP' });
    }
  }
}
