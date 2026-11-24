import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkAdapterBoundaries,
  checkPrivateDataHygiene,
  checkSchemaMigrations,
  checkSubprocessHygiene,
  runAllInvariants,
} from '../scripts/check-invariants.ts';

function makeFixture(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-invariants-'));
  fs.mkdirSync(path.join(dir, 'src', 'adapters'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'schema.ts'), [
    'export const SCHEMA_VERSION = 2;',
    'export function migrate(db: any) {',
    '  const version = 0;',
    '  if (version < 1) db.exec("PRAGMA user_version = 1;");',
    '  if (version < 2) db.exec("PRAGMA user_version = 2;");',
    '}',
  ].join('\n'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('checkSubprocessHygiene catches bare execSync, disallowed shell: true, and unsafe adapter spawns', t => {
  const dir = makeFixture(t);

  // Clean fixture including regex.exec(), db.exec(), cli.ts shell: true, git/where.exe, and explicit helperEnv()
  fs.writeFileSync(path.join(dir, 'src', 'cli.ts'), [
    'const m = /a/.exec("a");',
    'db.exec("SELECT 1");',
    'spawnSync(cmd, { cwd, shell: true });',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'src', 'adapters', 'ok.ts'), [
    'execFileSync("git", ["status"]);',
    'execFileSync("where.exe", ["pwsh"]);',
    'spawn(bin, args, { cwd, env: helperEnv() });',
  ].join('\n'));
  assert.deepEqual(checkSubprocessHygiene(dir), []);

  // Violations
  fs.writeFileSync(path.join(dir, 'src', 'bad.ts'), [
    'execSync("echo hi");',
    'spawnSync("cmd", [], { shell: true });',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'src', 'adapters', 'bad-env.ts'), [
    'spawn(bin, args, { cwd });',
    'execFile(bin, args, { env: process.env });',
  ].join('\n'));

  const violations = checkSubprocessHygiene(dir);
  assert.equal(violations.length, 4);
  assert.ok(violations.every(v => v.rule === 'subprocess-hygiene'));
});

test('checkAdapterBoundaries forbids model literals outside src/adapters/', t => {
  const dir = makeFixture(t);
  fs.writeFileSync(path.join(dir, 'src', 'adapters', 'ok.ts'), 'export const M = "gpt-6-luna";\n');
  assert.deepEqual(checkAdapterBoundaries(dir), []);

  fs.writeFileSync(path.join(dir, 'src', 'tools.ts'), 'export const BAD = "claude-sonnet-4-6";\n');
  const violations = checkAdapterBoundaries(dir);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.rule, 'adapter-boundary');
  assert.equal(violations[0]?.file, 'src/tools.ts');
});

test('checkSchemaMigrations detects duplicate, gapped, or mismatched migration versions', t => {
  const dir = makeFixture(t);
  assert.deepEqual(checkSchemaMigrations(dir), []);

  fs.writeFileSync(path.join(dir, 'src', 'schema.ts'), [
    'export const SCHEMA_VERSION = 3;',
    'export function migrate(db: any) {',
    '  const version = 0;',
    '  if (version < 1) db.exec("PRAGMA user_version = 1;");',
    '  if (version < 3) db.exec("PRAGMA user_version = 2;");',
    '  if (version < 3) db.exec("PRAGMA user_version = 3;");',
    '}',
  ].join('\n'));
  const violations = checkSchemaMigrations(dir);
  assert.ok(violations.some(v => v.message.includes('Expected if (version < N) version 2, found 3')));
  assert.ok(violations.some(v => v.message.includes('Duplicate if (version < N) version 3')));
});

test('checkPrivateDataHygiene catches hardcoded user/OneDrive/LocalProjects paths and literal tokens without false positives on regexes', t => {
  const dir = makeFixture(t);
  fs.writeFileSync(path.join(dir, 'src', 'detector.ts'), [
    'export const PATTERNS = [/\\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/];',
  ].join('\n'));
  assert.deepEqual(checkPrivateDataHygiene(dir), []);

  const fakeSk = ['sk', 'proj', 'abcdefghijklmnopqrstuvwxyz1234'].join('-');
  fs.writeFileSync(path.join(dir, 'src', 'leak.ts'), [
    'const u = "C:\\\\Users\\\\alice\\\\secret.txt";',
    'const od = "D:\\\\OneDrive\\\\Example";',
    'const lp = "D:\\\\LocalProjects\\\\Example\\\\AgentCommons";',
    `const key = "${fakeSk}";`,
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'scripts', 'deploy.ps1'), [
    'Copy-Item "C:\\Users\\alice\\x" "D:\\OneDrive\\y"',
    'Write-Output "D:\\LocalProjects\\Example\\AgentCommons"',
  ].join('\n'));

  const violations = checkPrivateDataHygiene(dir);
  assert.equal(violations.length, 6);
  assert.ok(violations.every(v => v.rule === 'private-data'));
});

test('Agent Commons v2 repository passes all static invariants', () => {
  const v2Root = path.resolve(import.meta.dirname, '..');
  const violations = runAllInvariants(v2Root);
  assert.deepEqual(violations, []);
});
