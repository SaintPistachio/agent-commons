import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface InvariantViolation {
  rule: string;
  file: string;
  line?: number;
  message: string;
}

const BENIGN_SYS_BINS = new Set(['git', 'where.exe', 'taskkill']);
const MODEL_LITERAL_RE = /\b(gpt-[456][a-z0-9.-]*|claude-(?:sonnet|opus|haiku|fable)[a-z0-9.-]*|gemini-[234][a-z0-9.-]*)\b/i;

const USER_PROFILE_RE = /[A-Za-z]:[\\/]+Users[\\/]+[A-Za-z0-9._-]+/i;
const ONEDRIVE_RE = /[A-Za-z]:[\\/]+OneDrive/i;
const LOCAL_PROJECTS_RE = /[A-Za-z]:[\\/]+LocalProjects/i;
const SK_TOKEN_RE = /\bsk-[A-Za-z0-9_-]{20,}\b/;
const AIZA_TOKEN_RE = /\bAIza[0-9A-Za-z_-]{20,}\b/;
const GHP_TOKEN_RE = /\bghp_[A-Za-z0-9]{20,}\b/;
const PRIVATE_KEY_RE = /-----BEGIN (?:(?:RSA|EC|DSA|OPENSSH|PGP) )?PRIVATE KEY-----/;

function walkFiles(dir: string, filter?: (file: string) => boolean): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkFiles(full, filter));
    else if (!filter || filter(full)) results.push(full);
  }
  return results.sort();
}

function relPath(v2Root: string, file: string): string {
  return path.relative(v2Root, file).replace(/\\/g, '/');
}

export function checkSubprocessHygiene(v2Root: string): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  const srcDir = path.join(v2Root, 'src');
  const files = walkFiles(srcDir, f => f.endsWith('.ts'));

  for (const file of files) {
    const rel = relPath(v2Root, file);
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Forbid bare exec( or execSync( (must not match obj.exec( or identifierExec()
      const execRe = /\b(exec|execSync)\s*\(/g;
      let m: RegExpExecArray | null;
      while ((m = execRe.exec(line)) !== null) {
        const before = m.index > 0 ? line[m.index - 1] : '';
        if (before !== '.' && !/[A-Za-z0-9_$]/.test(before)) {
          violations.push({
            rule: 'subprocess-hygiene',
            file: rel,
            line: i + 1,
            message: `Bare ${m[1]}() is forbidden; use execFile/spawn with explicit args.`,
          });
        }
      }

      // Forbid shell: true anywhere in src/ except cli.ts operator --verify
      if (/\bshell\s*:\s*true\b/.test(line) && rel !== 'src/cli.ts') {
        violations.push({
          rule: 'subprocess-hygiene',
          file: rel,
          line: i + 1,
          message: 'shell: true is forbidden outside src/cli.ts operator --verify.',
        });
      }

      // Adapter spawn/execFile env discipline
      if (rel.startsWith('src/adapters/')) {
        const spawnRe = /\b(spawn|spawnSync|execFile|execFileSync)\s*\(/g;
        let sm: RegExpExecArray | null;
        while ((sm = spawnRe.exec(line)) !== null) {
          const before = sm.index > 0 ? line[sm.index - 1] : '';
          if (before === '.' || /[A-Za-z0-9_$]/.test(before)) continue;

          // Inspect call window across up to 6 lines from the match
          const snippet = [line.slice(sm.index), ...lines.slice(i + 1, i + 6)].join('\n');
          const firstArgMatch = /^(?:spawn|spawnSync|execFile|execFileSync)\s*\(\s*(['"`])([^'"`]+)\1/.exec(snippet);
          if (firstArgMatch && BENIGN_SYS_BINS.has(firstArgMatch[2])) continue;

          if (!/\benv\b/.test(snippet)) {
            violations.push({
              rule: 'subprocess-hygiene',
              file: rel,
              line: i + 1,
              message: `Adapter ${sm[1]}() must specify an explicit allowlisted env option.`,
            });
          } else if (/\benv\s*:\s*process\.env\b/.test(snippet)) {
            violations.push({
              rule: 'subprocess-hygiene',
              file: rel,
              line: i + 1,
              message: `Adapter ${sm[1]}() must not pass bare process.env.`,
            });
          }
        }
      }
    }
  }
  return violations;
}

export function checkAdapterBoundaries(v2Root: string): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  const srcDir = path.join(v2Root, 'src');
  const files = walkFiles(srcDir, f => f.endsWith('.ts'));

  for (const file of files) {
    const rel = relPath(v2Root, file);
    if (rel.startsWith('src/adapters/')) continue;
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const m = MODEL_LITERAL_RE.exec(lines[i]);
      if (m) {
        violations.push({
          rule: 'adapter-boundary',
          file: rel,
          line: i + 1,
          message: `Provider model literal "${m[1]}" must stay inside src/adapters/.`,
        });
      }
    }
  }
  return violations;
}

export function checkSchemaMigrations(v2Root: string): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  const schemaFile = path.join(v2Root, 'src', 'schema.ts');
  const rel = 'src/schema.ts';
  if (!fs.existsSync(schemaFile)) {
    return [{ rule: 'schema-migrations', file: rel, message: 'Missing src/schema.ts.' }];
  }

  const text = fs.readFileSync(schemaFile, 'utf8');
  const versionMatch = /export\s+const\s+SCHEMA_VERSION\s*=\s*(\d+)\s*;/.exec(text);
  if (!versionMatch) {
    return [{ rule: 'schema-migrations', file: rel, message: 'Could not find export const SCHEMA_VERSION = <N>;.' }];
  }
  const declaredVersion = Number(versionMatch[1]);

  const guards: Array<{ n: number; line: number }> = [];
  const pragmas: Array<{ n: number; line: number }> = [];
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const guardRe = /\bif\s*\(\s*version\s*<\s*(\d+)\s*\)/g;
    let gm: RegExpExecArray | null;
    while ((gm = guardRe.exec(line)) !== null) {
      guards.push({ n: Number(gm[1]), line: i + 1 });
    }
    const pragmaRe = /PRAGMA\s+user_version\s*=\s*(\d+)/gi;
    let pm: RegExpExecArray | null;
    while ((pm = pragmaRe.exec(line)) !== null) {
      pragmas.push({ n: Number(pm[1]), line: i + 1 });
    }
  }

  const checkSequence = (label: string, items: Array<{ n: number; line: number }>) => {
    if (items.length !== declaredVersion) {
      violations.push({
        rule: 'schema-migrations',
        file: rel,
        message: `Expected ${declaredVersion} ${label} entries for SCHEMA_VERSION=${declaredVersion}, found ${items.length}.`,
      });
    }
    const seen = new Set<number>();
    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx];
      if (seen.has(item.n)) {
        violations.push({
          rule: 'schema-migrations',
          file: rel,
          line: item.line,
          message: `Duplicate ${label} version ${item.n}.`,
        });
      }
      seen.add(item.n);
      if (item.n !== idx + 1) {
        violations.push({
          rule: 'schema-migrations',
          file: rel,
          line: item.line,
          message: `Expected ${label} version ${idx + 1}, found ${item.n}.`,
        });
      }
    }
  };

  checkSequence('if (version < N)', guards);
  checkSequence('PRAGMA user_version = N', pragmas);
  return violations;
}

export function checkPrivateDataHygiene(v2Root: string): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  const srcFiles = walkFiles(path.join(v2Root, 'src'), f => f.endsWith('.ts'));
  const scriptFiles = walkFiles(path.join(v2Root, 'scripts'));

  const scanFile = (file: string, checkLocalProjects: boolean) => {
    const rel = relPath(v2Root, file);
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (USER_PROFILE_RE.test(line)) {
        violations.push({ rule: 'private-data', file: rel, line: i + 1, message: 'Hardcoded Windows user profile path is forbidden.' });
      }
      if (ONEDRIVE_RE.test(line)) {
        violations.push({ rule: 'private-data', file: rel, line: i + 1, message: 'Hardcoded OneDrive path is forbidden.' });
      }
      if (checkLocalProjects && LOCAL_PROJECTS_RE.test(line)) {
        violations.push({ rule: 'private-data', file: rel, line: i + 1, message: 'Hardcoded LocalProjects path is forbidden in src/.' });
      }
      if (SK_TOKEN_RE.test(line) || AIZA_TOKEN_RE.test(line) || GHP_TOKEN_RE.test(line) || PRIVATE_KEY_RE.test(line)) {
        violations.push({ rule: 'private-data', file: rel, line: i + 1, message: 'Potential literal secret or private key block detected.' });
      }
    }
  };

  for (const f of srcFiles) scanFile(f, true);
  for (const f of scriptFiles) scanFile(f, false);
  return violations;
}

export function runAllInvariants(v2Root: string): InvariantViolation[] {
  return [
    ...checkSubprocessHygiene(v2Root),
    ...checkAdapterBoundaries(v2Root),
    ...checkSchemaMigrations(v2Root),
    ...checkPrivateDataHygiene(v2Root),
  ];
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const v2Root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const violations = runAllInvariants(v2Root);
  if (violations.length === 0) {
    console.log('invariants: ok');
    process.exit(0);
  }
  for (const v of violations) {
    const loc = v.line !== undefined ? `${v.file}:${v.line}` : v.file;
    console.error(`[${v.rule}] ${loc} ${v.message}`);
  }
  process.exit(1);
}
