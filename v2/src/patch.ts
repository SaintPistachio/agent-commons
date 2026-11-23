import fs from 'node:fs';
import path from 'node:path';
import { isUtf8 } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { checkSecrets, deniedPath, inside, realDirectory, same, secretLike, SECRET_VALUES } from './context.ts';

export type PatchBlock = { path: string } & (
  { kind: 'edit'; old: string; text: string } | { kind: 'file'; text: string } | { kind: 'delete' }
);
export interface RejectedBlock { block: PatchBlock; reason: string; window?: string }
export interface ApplyResult { applied: number; rejected: RejectedBlock[]; files: number }
interface ApplyOptions {
  dryRun?: boolean; allowPartial?: boolean; deny?: string[];
  /** Accepted blocks, reported only after publication; changed is false for no-ops or net-zero targets. */
  onAccepted?: (block: PatchBlock, target: string, changed: boolean) => void;
}
interface VerifyFailure { stdout?: string; stderr?: string; status?: number | null }
interface Snapshot { text: string; mode: number }
interface Change { relative: string; full: string; before?: Snapshot; after?: string }

const lf = (text: string) => text.replace(/\r\n/g, '\n');
const marker = /^(?:<<<(?:EDIT|FILE|DELETE|OLD)|>>>(?:NEW|END))(?=\s|$)/;
const limit = 4 * 1024 * 1024;

export function parsePatchBlocks(text: string): PatchBlock[] {
  const lines = lf(text).split('\n'), blocks: PatchBlock[] = [];
  let i = 0;
  const invalid = (): never => { throw new Error(`Malformed patch at line ${i + 1}`); };
  const take = (expected: string) => {
    if (lines[i] !== expected) invalid();
    i++;
  };
  const body = (end: string): string => {
    const start = i;
    while (i < lines.length && !marker.test(lines[i])) i++;
    const text = lines.slice(start, i).join('\n');
    take(end);
    return text;
  };
  while (i < lines.length) {
    if (/^@air1(?:\s|$)/.test(lines[i])) break;
    const header = /^<<<(EDIT|FILE|DELETE) (.+)$/.exec(lines[i]);
    if (!header) {
      if (marker.test(lines[i])) invalid();
      i++;
      continue;
    }
    const [, kind, target] = header;
    i++;
    if (kind === 'EDIT') {
      take('<<<OLD');
      const old = body('>>>NEW');
      if (!old) invalid();
      blocks.push({ kind: 'edit', path: target, old, text: body('>>>END') });
    } else if (kind === 'FILE') {
      const text = body('>>>END');
      blocks.push({ kind: 'file', path: target, text: text && !text.endsWith('\n') ? text + '\n' : text });
    } else {
      take('>>>END');
      blocks.push({ kind: 'delete', path: target });
    }
  }
  return blocks;
}

export function summarizePatchBlocks(input: string | readonly PatchBlock[]): { edits: number; files: number; deletes: number } | null {
  const blocks = typeof input === "string" ? parsePatchBlocks(input) : input;
  if (!blocks.length) return null;
  const result = { edits: 0, files: 0, deletes: 0 };
  for (const block of blocks) {
    if (block.kind === 'edit') result.edits++;
    else if (block.kind === 'file') result.files++;
    else result.deletes++;
  }
  return result;
}

function lstat(file: string): fs.Stats | undefined {
  try { return fs.lstatSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Walk existing components so dangling links, junctions, and non-directory ancestors are refused too. */
function target(root: string, relative: string, deny: string[]): string {
  const parts = relative.split(/[\\/]/);
  if (parts.some(part => !part || part === '.' || part === '..' || secretLike(part)
    || /[:<>"|?*\x00-\x1f]|[. ]$/.test(part)
    || /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part)))
    throw new Error('Unsafe patch path');
  checkSecrets('Patch path', relative);
  const full = path.join(root, ...parts);
  if (!inside(same(root), same(full)) || deniedPath(full, full, deny)) throw new Error('Patch path is denied');
  let ancestor = root;
  for (let i = 0; i < parts.length; i++) {
    const next = path.join(ancestor, parts[i]), stat = lstat(next);
    if (!stat) break;
    if (stat.isSymbolicLink() || !(i === parts.length - 1 ? stat.isFile() : stat.isDirectory()))
      throw new Error('Patch path crosses a link or has the wrong file type');
    ancestor = next;
  }
  const real = fs.realpathSync(ancestor);
  const resolved = path.resolve(real, path.relative(ancestor, full));
  if (same(real) !== same(ancestor) || !inside(same(root), same(resolved)) || deniedPath(full, resolved, deny))
    throw new Error('Patch path resolves outside its allowed location');
  return full;
}

function snapshot(file: string): Snapshot | undefined {
  const stat = lstat(file);
  if (!stat) return undefined;
  if (!stat.isFile() || stat.size > limit) throw new Error('Patch target is not a regular file under 4 MiB');
  const bytes = fs.readFileSync(file);
  if (bytes.length > limit || bytes.includes(0) || !isUtf8(bytes)) throw new Error('Patch target is not supported UTF-8 text');
  return { text: bytes.toString('utf8'), mode: stat.mode & 0o777 };
}

function excerpt(lines: string[], center: number, radius: number): string {
  if (center < 0 || center >= lines.length) return '';
  return lines.slice(Math.max(0, center - radius), center + radius + 1)
    .map((line, i) => `${Math.max(0, center - radius) + i + 1}|${line}`).join('\n');
}

function near(text: string, block: PatchBlock): string {
  const lines = lf(text).split('\n');
  const anchor = block.kind === 'edit' ? lf(block.old).split('\n').find(line => line.trim())?.trim().slice(0, 256) : undefined;
  let best = 0, score = 0;
  if (anchor) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line === anchor) { best = i; break; }
      let common = 0;
      while (common < anchor.length && anchor[common] === line[common]) common++;
      const rank = line.includes(anchor) ? anchor.length + 1 : common;
      if (rank > score) { best = i; score = rank; }
    }
  }
  return excerpt(lines, best, 40);
}

function temporary(full: string, text: string, mode?: number): string {
  const file = path.join(path.dirname(full), `.ac-patch-${randomUUID()}.tmp`);
  const fd = fs.openSync(file, 'wx', mode ?? 0o666);
  try {
    try {
      fs.writeFileSync(fd, text, 'utf8');
      if (mode !== undefined) fs.fchmodSync(fd, mode);
    } finally { fs.closeSync(fd); }
  } catch (error) {
    fs.rmSync(file, { force: true });
    throw error;
  }
  return file;
}

/** Stage before publishing. Each rename is atomic; a multi-file batch has best-effort rollback on I/O failure. */
function publish(root: string, changes: Change[], deny: string[]): void {
  const staged: { change: Change; next?: string; backup?: string; published?: boolean }[] = [];
  try {
    for (const change of changes) {
      target(root, change.relative, deny);
      fs.mkdirSync(path.dirname(change.full), { recursive: true });
      target(root, change.relative, deny);
      const entry: typeof staged[number] = { change };
      staged.push(entry);
      if (change.before) entry.backup = temporary(change.full, change.before.text, change.before.mode);
      if (change.after !== undefined) entry.next = temporary(change.full, change.after, change.before?.mode);
    }
    for (const entry of staged) {
      const { change } = entry;
      target(root, change.relative, deny);
      const current = snapshot(change.full);
      if (current?.text !== change.before?.text || current?.mode !== change.before?.mode)
        throw new Error('A patch target changed during application');
      if (entry.next) fs.renameSync(entry.next, change.full);
      else fs.unlinkSync(change.full);
      entry.published = true;
    }
  } catch (error) {
    let incomplete = false;
    for (const entry of staged.reverse()) {
      if (!entry.published) continue;
      try {
        target(root, entry.change.relative, deny);
        if (entry.backup) fs.renameSync(entry.backup, entry.change.full);
        else fs.unlinkSync(entry.change.full);
      } catch {
        incomplete = true;
        entry.backup = undefined; // Leave a recovery copy if restoration failed.
      }
    }
    if (incomplete) throw new Error('Patch publication failed and rollback was incomplete; inspect the workspace for recovery copies');
    throw error;
  } finally {
    for (const entry of staged) {
      for (const file of [entry.next, entry.backup]) {
        if (file) { try { fs.rmSync(file, { force: true }); } catch { /* Do not mask a publication error. */ } }
      }
    }
  }
}

export function applyPatchBlocks(cwd: string, blocks: readonly PatchBlock[], options: ApplyOptions = {}): ApplyResult {
  const root = realDirectory(cwd), deny = options.deny ?? [];
  if (!root || deniedPath(path.resolve(cwd), root, deny)) throw new Error('Invalid or denied patch workspace');
  const changes = new Map<string, Change>();
  const failures: { rejection: RejectedBlock; change?: Change }[] = [];
  const accepted: { block: PatchBlock; change: Change; modified: boolean }[] = [];
  let applied = 0;
  for (const block of blocks) {
    let change: Change | undefined;
    try {
      const full = target(root, block.path, deny), key = same(full);
      change = changes.get(key);
      if (!change) {
        if ([...changes.keys()].some(other => other !== key && (inside(other, key) || inside(key, other))))
          throw new Error('Patch targets overlap as file and directory');
        const before = snapshot(full);
        checkSecrets('Patch target', before?.text ?? '');
        change = { relative: block.path, full, before, after: before?.text };
      }
      const current = change.after;
      let next: string | undefined;
      if (block.kind === 'file') {
        if (current !== undefined) throw new Error('FILE target already exists');
        next = lf(block.text);
      } else {
        if (current === undefined) throw new Error('Patch target does not exist');
        if (block.kind === 'edit') {
          const old = lf(block.old);
          checkSecrets('OLD text', old);
          if (!old) throw new Error('OLD text did not match');
          const escaped = old.split('\n').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\r?\\n');
          const matches = [...current.matchAll(new RegExp(escaped, 'g'))];
          if (!matches.length) throw new Error('OLD text did not match');
          if (matches.length > 1) throw new Error('OLD text matched more than once');
          const matched = matches[0][0], start = matches[0].index!;
          const eol = matched.includes('\r\n') || (!matched.includes('\n') && current.includes('\r\n')) ? '\r\n' : '\n';
          const replacement = lf(block.text).replaceAll('\n', eol);
          next = current.slice(0, start) + replacement + current.slice(start + matched.length);
        }
      }
      if (next !== undefined) {
        if (next.includes('\0') || Buffer.byteLength(next, 'utf8') > limit) throw new Error('Unsupported patch result');
        checkSecrets('Patch result', next);
      }
      change.after = next;
      changes.set(key, change);
      if (options.onAccepted) accepted.push({ block, change, modified: current !== next });
      applied++;
    } catch (error) {
      failures.push({ rejection: { block, reason: (error as Error).message }, change });
    }
  }
  const blocked = failures.length > 0 && !options.allowPartial;
  const writes = blocked ? [] : [...changes.values()].filter(change => change.before?.text !== change.after);
  if (!options.dryRun && writes.length) publish(root, writes, deny);
  if (!options.dryRun && !blocked && options.onAccepted) {
    const written = new Set(writes);
    for (const { block, change, modified } of accepted) options.onAccepted(block, change.full, modified && written.has(change));
  }
  const rejected = failures.map(({ rejection, change }) => {
    const current = blocked || options.dryRun ? change?.before?.text : change?.after;
    return current === undefined ? rejection : { ...rejection, window: near(current, rejection.block) };
  });
  return { applied: blocked ? 0 : applied, rejected, files: writes.length };
}

const redact = (text: string): string => SECRET_VALUES.reduce(
  (out, pattern) => out.replace(new RegExp(pattern.source, pattern.flags + 'g'), '[REDACTED]'), text,
);

function render(block: PatchBlock): string {
  const header = `<<<${block.kind.toUpperCase()} ${block.path}`;
  if (block.kind === 'edit') return `${header}\n<<<OLD\n${block.old}\n>>>NEW\n${block.text}\n>>>END`;
  return block.kind === 'file' ? `${header}\n${block.text}\n>>>END` : `${header}\n>>>END`;
}

export function buildRepairContext(cwd: string, rejected: readonly RejectedBlock[], verify?: VerifyFailure, deny: string[] = []): string {
  const sections = rejected.map(item =>
    `Rejected: ${item.reason}\n${render(item.block)}${item.window ? `\nCurrent file:\n${item.window}` : ''}`);
  if (verify) {
    const output = `${verify.stdout ?? ''}\n${verify.stderr ?? ''}`;
    const safe = Buffer.from(redact(output), 'utf8');
    const truncated = safe.length > 32 * 1024;
    const log = truncated ? Buffer.concat([safe.subarray(0, 16 * 1024 - 32), Buffer.from('\n[output truncated]\n'),
      safe.subarray(-16 * 1024)]) : safe;
    sections.push(`Verification failed (exit=${verify.status ?? 'unavailable'}):\n${log.toString('utf8')}`);
    const root = realDirectory(cwd), seen = new Set<string>();
    if (root) {
      for (const line of output.split(/\r?\n/)) {
        if (seen.size === 5) break;
        const frame = /^\s*at\s+(?:async\s+)?(.+?\.ts):(\d+):\d+\)?\s*$/i.exec(line);
        if (!frame) continue;
        try {
          const name = frame[1].slice(frame[1].lastIndexOf(' (') + (frame[1].includes(' (') ? 2 : 1));
          const full = path.resolve(root, name.startsWith('file:') ? fileURLToPath(name) : name);
          if (!inside(same(root), same(full)) || seen.has(same(full))) continue;
          const relative = path.relative(root, full);
          const current = snapshot(target(root, relative, deny));
          if (!current) continue;
          const window = excerpt(lf(current.text).split('\n'), Number(frame[2]) - 1, 35);
          if (window) {
            seen.add(same(full));
            sections.push(`${relative}:\n${window}`);
          }
        } catch { /* Omit invalid, unreadable, or denied stack paths. */ }
      }
    }
  }
  return redact(sections.join('\n\n'));
}
