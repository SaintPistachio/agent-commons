/**
 * Worker context (ctx=): files, artifacts, tasks and git diffs resolved by the service when a job is submitted, so
 * the calling AI never copies them into the prompt. Files must resolve (links included) inside the project root;
 * secret-like names and binary files are refused, and diffs leave such files out.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fail } from './errors.ts';
import { jobGitEnvironment } from './git-environment.ts';

export interface ContextSources {
  root: string;
  /** Folders whose contents are never sent, even when inside the root (the Agent Commons home: database, connections). */
  deny?: string[];
  /** An artifact's text by handle or ID, if it belongs to the project. */
  artifact(ref: string): string | undefined;
  /** A task's AIR block (full fields plus recent checkpoints and decisions), if it belongs to the project. */
  task(ref: string): string | undefined;
  /** The canonical output of a job in this project, including any text spilled to an artifact. */
  job?(ref: string): string | undefined;
  /** Bounded, project-scoped memory matching a query. */
  recall?(query: string): string | undefined;
  /** Bounded, staleness-verified Graphify relationships for a symbol or topic. */
  graph?(query: string): string | undefined;
}

const MAX_FILE_BYTES = 4 * 1024 * 1024;
/** A path segment that looks like a credential store, key or secret. */
export function secretLike(segment: string): boolean {
  const s = segment.toLowerCase();
  return s === '.git' || s.startsWith('.env') || ['secret', 'token', 'credential', 'password'].some(w => s.includes(w))
    || ['.pem', '.key', '.pfx', '.p12', '.keystore'].some(ext => s.endsWith(ext))
    || ['id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa'].some(p => s.startsWith(p)) || ['.npmrc', '.netrc', '.pypirc'].includes(s);
}
/** The same patterns as git pathspecs, so diffs leave those files out. */
const DIFF_EXCLUDES = ['**/.env*', '**/*secret*', '**/*token*', '**/*credential*', '**/*password*', '**/*.pem', '**/*.key', '**/*.pfx',
  '**/*.p12', '**/*.keystore', '**/id_rsa*', '**/id_ed25519*', '**/id_ecdsa*', '**/id_dsa*', '**/.npmrc', '**/.netrc', '**/.pypirc']
  .map(glob => `:(exclude,glob,icase)${glob}`);
const RANGE = /^[A-Za-z0-9._\/~^@{}-]+(\.\.\.?[A-Za-z0-9._\/~^@{}-]+)?$/;
/** Values that look like live credentials: OpenAI/Anthropic keys, Google API keys, GitHub and Slack tokens, AWS keys, private keys. */
export const SECRET_VALUES = [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/, /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/, /\bAQ\.[0-9A-Za-z._~-]{36,}/, /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, /\bAKIA[0-9A-Z]{16}\b/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/];
export const checkSecrets = (ref: string, text: string) => {
  if (SECRET_VALUES.some(pattern => pattern.test(text))) fail('CTX_SECRET', 400, `${ref} contains what looks like a credential; leave it out or redact it`);
};
/** Redact credential-shaped tokens without failing (used when wrapping auto-queued transcripts). */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_VALUES) {
    const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    out = out.replace(global, '[REDACTED]');
  }
  return out;
}

export const inside = (root: string, target: string) => {
  const rel = path.relative(root, target);
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};
export const same = (a: string) => process.platform === 'win32' ? a.toLowerCase() : a;

export function realDirectory(dir: string): string | undefined {
  try {
    const real = fs.realpathSync(dir);
    return fs.statSync(real).isDirectory() ? real : undefined;
  } catch { return undefined; }
}

export function deniedPath(full: string, real: string, deny: string[]): boolean {
  return deny.some(folder => {
    const resolved = path.resolve(folder), canonical = realDirectory(resolved);
    return inside(same(resolved), same(full)) || inside(same(resolved), same(real))
      || (canonical !== undefined && inside(same(canonical), same(real)));
  });
}

/** Resolve a caller's cwd, allowing only the registered root and its registered linked worktrees. */
export function resolveContextRoot(projectRoot: string, cwd: string, deny: string[] = []): string {
  const root = realDirectory(projectRoot) ?? fail('CTX_NOT_FOUND', 404, 'the project root is not a directory');
  const requested = path.resolve(projectRoot, cwd);
  const real = realDirectory(requested) ?? fail('CTX_NOT_FOUND', 404, 'cwd is not a directory');
  if (deniedPath(requested, real, deny)) fail('CTX_DENIED', 400, 'cwd is inside the Agent Commons data folder');

  let base = root, lexicalBase = path.resolve(projectRoot);
  if (!inside(same(root), same(real))) {
    let listing: string;
    try {
      listing = execFileSync('git', ['-C', root, '-c', 'core.fsmonitor=false', 'worktree', 'list', '--porcelain', '-z'], {
        env: jobGitEnvironment(), encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      return fail('CTX_OUTSIDE_ROOT', 400, 'cwd is outside the project root and no linked worktree could be verified');
    }
    // NUL-delimited porcelain preserves spaces and other characters in worktree paths.
    const entries = listing.split('\0\0').flatMap(record => {
      const [first, ...fields] = record.split('\0');
      if (!first.startsWith('worktree ') || fields.some(field => field === 'prunable' || field.startsWith('prunable '))) return [];
      const name = first.slice('worktree '.length), canonical = realDirectory(name);
      return canonical ? [{ name, canonical }] : [];
    });
    // Git also discovers enclosing repositories. A registered project subdirectory must not
    // gain access to that repository's other checkouts just because Git can find them.
    const linked = entries.some(entry => same(entry.canonical) === same(root))
      ? entries.find(entry => inside(same(entry.canonical), same(real)))
      : undefined;
    if (!linked) return fail('CTX_OUTSIDE_ROOT', 400, 'cwd is outside the project root and its registered worktrees');
    // The primary checkout is not a linked worktree of a project registered in a linked checkout.
    if (listing.split('\0', 1)[0] === `worktree ${linked.name}`)
      fail('CTX_OUTSIDE_ROOT', 400, 'cwd is outside the project root and its registered worktrees');
    base = linked.canonical;
    lexicalBase = linked.name;
  }
  if (path.relative(base, real).split(/[\\/]/).some(secretLike)
    || (inside(same(lexicalBase), same(requested)) && path.relative(lexicalBase, requested).split(/[\\/]/).some(secretLike)))
    fail('CTX_DENIED', 400, 'cwd looks like a secret or credential directory');
  return real;
}

function lineRange(value: string, fromText: string, toText: string): { from: number; to?: number } {
  const from = Number(fromText), to = toText ? Number(toText) : undefined;
  if (from < 1 || (to !== undefined && to < from)) fail('CTX_BAD_REF', 400, `bad line range in ${value}`);
  return { from, to };
}

/** Splits "value:start-end" (end optional) into the value and a 1-based inclusive line range. */
function withRange(value: string): { target: string; from?: number; to?: number } {
  const m = /^(.*?):(\d+)-(\d*)$/.exec(value);
  return m ? { target: m[1], ...lineRange(value, m[2], m[3]) } : { target: value };
}
function textLines(text: string): string[] {
  const all = text.split(/\r?\n/);
  if (all.length > 1 && all[all.length - 1] === '') all.pop();
  return all;
}
function sliceLines(all: string[], ref: string, from?: number, to?: number): { body: string; lines: string } {
  const a = from ?? 1, b = Math.min(to ?? all.length, all.length);
  if (a > all.length) fail('CTX_BAD_REF', 400, `${ref} has only ${all.length} lines`);
  return { body: all.slice(a - 1, b).join('\n'), lines: `${a}-${b}` };
}
function slice(text: string, ref: string, from?: number, to?: number): { body: string; lines: string } {
  return sliceLines(textLines(text), ref, from, to);
}
const block = (ref: string, body: string, lines?: string) => `@ctx ${ref}${lines ? ` lines=${lines}` : ''} chars=${body.length}\n${body}\n@ctx end`;

export function readContextFile(ref: string, target: string, root: string, deny: string[]): string {
  if (path.isAbsolute(target) || /^[A-Za-z]:/.test(target)) fail('CTX_OUTSIDE_ROOT', 400, `${ref}: give a path relative to the project root`);
  const full = path.resolve(root, target);
  if (!inside(root, full)) fail('CTX_OUTSIDE_ROOT', 400, `${ref} is outside the project root`);
  if (path.relative(root, full).split(/[\\/]/).some(secretLike)) fail('CTX_DENIED', 400, `${ref} looks like a secret or credential file`);
  if (!fs.existsSync(full)) fail('CTX_NOT_FOUND', 404, `${ref} not found`);
  const real = fs.realpathSync(full), realRoot = fs.realpathSync(root);
  if (!inside(same(realRoot), same(real))) fail('CTX_OUTSIDE_ROOT', 400, `${ref} leads outside the project root`);
  if (path.relative(realRoot, real).split(/[\\/]/).some(secretLike)) fail('CTX_DENIED', 400, `${ref} looks like a secret or credential file`);
  if (deniedPath(full, real, deny)) fail('CTX_DENIED', 400, `${ref} is inside the Agent Commons data folder`);
  const stat = fs.statSync(real);
  if (!stat.isFile()) fail('CTX_NOT_FOUND', 404, `${ref} is not a file`);
  if (stat.size > MAX_FILE_BYTES) fail('CTX_TOO_LARGE', 400, `${ref} is over 4 MB; give a line range of a smaller file`);
  const bytes = fs.readFileSync(real);
  if (bytes.subarray(0, 8192).includes(0)) fail('CTX_BINARY', 400, `${ref} is a binary file`);
  return bytes.toString('utf8');
}

function file(ref: string, value: string, root: string, deny: string[]): string {
  const multi = /^(.*?):((?:\d+-\d*\+)+\d+-\d*)$/.exec(value);
  if (multi) {
    const ranges = multi[2].split('+').map(part => {
      const [from, to] = part.split('-');
      return lineRange(value, from, to);
    });
    const all = textLines(readContextFile(ref, multi[1], root, deny));
    const slices = ranges.map(({ from, to }) => sliceLines(all, ref, from, to));
    return block(ref, slices.map(item => item.body).join('\n'), slices.map(item => item.lines).join(','));
  }
  const { target, from, to } = withRange(value);
  const { body, lines } = slice(readContextFile(ref, target, root, deny), ref, from, to);
  return block(ref, body, lines);
}

function grep(ref: string, value: string, root: string, deny: string[]): string {
  const match = /^([^:]+):([^:]+)(?::(\d+))?$/.exec(value);
  if (!match) return fail('CTX_BAD_REF', 400, `${ref}: use grep:<path>:<term>|<term>[:<context_lines>]`);
  const [, target, pattern, count] = match;
  const radius = count === undefined ? 20 : Number(count);
  const terms = pattern.split('|').map(term => term.trim().toLowerCase());
  if (radius > 80 || terms.some(term => !term))
    fail('CTX_BAD_REF', 400, `${ref}: supply nonempty terms and a context window of 0–80 lines`);
  const all = textLines(readContextFile(ref, target, root, deny));
  const windows: { from: number; to: number }[] = [];
  for (let i = 0; i < all.length; i++) {
    const text = all[i].toLowerCase();
    if (!terms.some(term => text.includes(term))) continue;
    const from = Math.max(1, i + 1 - radius), to = Math.min(all.length, i + 1 + radius);
    const last = windows[windows.length - 1];
    if (last && from <= last.to + 1) last.to = to;
    else windows.push({ from, to });
  }
  if (!windows.length) return block(ref, '(no matches)');
  const body: string[] = [];
  for (const { from, to } of windows) {
    for (let n = from; n <= to; n++) body.push(`${n}|${all[n - 1]}`);
  }
  return block(ref, body.join('\n'), windows.map(({ from, to }) => `${from}-${to}`).join(','));
}

function diff(ref: string, range: string, root: string, deny: string[]): string {
  if (!RANGE.test(range) || range.startsWith('-')) fail('CTX_BAD_REF', 400, `${ref}: give a git range such as HEAD~1..HEAD`);
  // Denied folders inside the root (the Agent Commons home) are left out of the diff too.
  const excluded = deny.filter(folder => inside(root, path.resolve(folder))).map(folder => `:(exclude)${path.relative(root, path.resolve(folder)).replaceAll('\\', '/')}`);
  let out: string;
  try {
    out = execFileSync('git', ['-C', root, '-c', 'core.fsmonitor=false', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', range, '--', '.', ...DIFF_EXCLUDES, ...excluded],
      { env: jobGitEnvironment(), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch { return fail('CTX_BAD_REF', 400, `${ref}: git could not produce that diff`); }
  return block(ref, out.replace(/\n$/, '') || '(no changes)');
}

/**
 * Resolves every ref, in order, into "@ctx <ref> ... @ctx end" blocks. Throws CommonsError (CTX_*) on the first bad
 * ref, including any block whose text looks like it holds a credential (CTX_SECRET).
 */
export function buildContext(refs: string[], sources: ContextSources): string {
  const deny = sources.deny ?? [];
  return refs.map(ref => {
    const m = /^(file|grep|job|art|task|diff|recall|graph):(.+)$/.exec(ref);
    if (!m) return fail('CTX_BAD_REF', 400, `${ref}: use file:, grep:, job:, art:, task:, diff:, recall: or graph:`);
    const [, kind, value] = m;
    let resolved: string;
    if (kind === 'recall') {
      const query = value.trim();
      if (!query) return fail('CTX_BAD_REF', 400, 'recall context requires a query');
      resolved = block(ref, sources.recall?.(query) ?? fail('CTX_NOT_ALLOWED', 400, 'recall context is unavailable'));
    } else if (kind === 'graph') {
      const query = value.trim();
      if (!query || query.length > 240) return fail('CTX_BAD_REF', 400, 'graph context requires a 1-240 character query');
      resolved = block(ref, sources.graph?.(query) ?? fail('CTX_NOT_ALLOWED', 400, 'graph context is unavailable'));
    } else if (kind === 'file') resolved = file(ref, value, sources.root, deny);
    else if (kind === 'grep') resolved = grep(ref, value, sources.root, deny);
    else if (kind === 'diff') resolved = diff(ref, value, sources.root, deny);
    else if (kind === 'job') {
      const { target, from, to } = withRange(value);
      if (!/^j[1-9]\d*$/.test(target)) fail('CTX_BAD_REF', 400, `${ref}: give a job handle such as j1`);
      if (!sources.job) return fail('CTX_NOT_ALLOWED', 400, 'job context is unavailable');
      const output = sources.job(target) ?? fail('CTX_NOT_FOUND', 404, `${ref}: no such job output in this project`);
      if (from === undefined) resolved = block(ref, output);
      else {
        const { body, lines } = slice(output, ref, from, to);
        resolved = block(ref, body, lines);
      }
    } else if (kind === 'art') {
      const { target, from, to } = withRange(value);
      const text = sources.artifact(target) ?? fail('CTX_NOT_FOUND', 404, `${ref}: no such artifact in this project`);
      const { body, lines } = slice(text, ref, from, to);
      resolved = block(ref, body, lines);
    } else resolved = block(ref, sources.task(value) ?? fail('CTX_NOT_FOUND', 404, `${ref}: no such task in this project`));
    checkSecrets(ref, resolved);
    return resolved;
  }).join('\n');
}
