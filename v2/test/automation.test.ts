import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-ignore: plain .mjs helper without type declarations
import { parseTrailers, mergedJobBranch } from '../scripts/automation/ac-git-outcomes.mjs';

test('commit trailers name jobs, outcomes, reasons and a replacement', () => {
  const message = 'Fix the parser\n\nBody text.\n\nAC-Accepted: j88, j91\nAC-Rejected: j90 edited the wrong file\nAC-Redone: 1a2b3c4d by j95 first try timed out\nNot-A-Trailer: j1\n';
  assert.deepEqual(parseTrailers(message), [
    { job: 'j88', kind: 'accepted', reason: '' },
    { job: 'j91', kind: 'accepted', reason: '' },
    { job: 'j90', kind: 'rejected', reason: 'edited the wrong file' },
    { job: '1a2b3c4d', kind: 'redone', reason: 'first try timed out', replacement: 'j95' },
  ]);
});

test('trailers without a job reference record nothing', () => {
  assert.deepEqual(parseTrailers('AC-Accepted: looks good\nac-rejected:'), []);
});

test('a merge of an edit job branch is recognized from the reflog subject', () => {
  assert.equal(mergedJobBranch('merge ac/job-1a2b3c4d: Fast-forward'), '1a2b3c4d');
  assert.equal(mergedJobBranch("merge ac/job-1a2b3c4d: Merge made by the 'ort' strategy."), '1a2b3c4d');
  assert.equal(mergedJobBranch('merge claude/v2-core: Fast-forward'), null);
  assert.equal(mergedJobBranch('commit: ac/job-1a2b3c4d mentioned'), null);
});

// The release gate refuses before doing anything (no git, install or push), so these runs are side-effect free.
const releaseScript = fileURLToPath(new URL('../scripts/Release-AgentCommonsV2.ps1', import.meta.url));
const runRelease = (...args: string[]) => spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', releaseScript, ...args], { encoding: 'utf8' });

test('a release that skips tests must say why', (t) => {
  const r = runRelease('-SkipTests');
  if (r.error) { t.skip('pwsh is not available'); return; }
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /-SkipTests needs -SkipReason/);
});

test('a skip reason without -SkipTests is refused', (t) => {
  const r = runRelease('-SkipReason', 'because');
  if (r.error) { t.skip('pwsh is not available'); return; }
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /only used with -SkipTests/);
});

const backupCommon = fileURLToPath(new URL('../scripts/automation/Ac-BackupCommon.ps1', import.meta.url));

function runBackupCheck(t: { skip: (reason: string) => void }, body: string) {
  const dir = mkdtempSync(join(tmpdir(), 'ac-backup-test-'));
  try {
    const script = join(dir, 'check.ps1');
    writeFileSync(script, `$ErrorActionPreference = 'Stop'\n. $env:AC_TEST_BACKUP_COMMON\n${body}\n`);
    const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', script], {
      encoding: 'utf8',
      env: { ...process.env, AC_TEST_BACKUP_COMMON: backupCommon },
      timeout: 20_000,
    });
    if ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') { t.skip('pwsh is not available'); return; }
    assert.ifError(r.error);
    assert.equal(r.status, 0, r.stdout + r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('backup paths use the installed home and resolve config paths relative to it', (t) => {
  runBackupCheck(t, String.raw`
$homePath = Join-Path $PSScriptRoot 'Test Home-data'
$installed = Join-Path $homePath 'current/v2/scripts/automation'
[void][IO.Directory]::CreateDirectory($installed)
if ((Resolve-AcDataRoot $installed '') -ne $homePath) { throw 'installed home was not inferred' }
@{ offDriveDestination = 'test-offdrive'; cloudDestination = 'test cloud' } |
  ConvertTo-Json | Set-Content -LiteralPath (Join-Path $homePath 'backup-config.json')
$config = Read-AcBackupConfig $homePath
$offdrive = Get-AcBackupPath $config 'offDriveDestination' '' 'unused' $homePath
if ($offdrive -ne (Join-Path $homePath 'test-offdrive')) { throw 'wrong relative base' }
$override = Join-Path $PSScriptRoot 'override'
if ((Get-AcBackupPath $config 'cloudDestination' $override '' $homePath) -ne $override) { throw 'override did not win' }
`);
});

test('watchdog distinguishes missing key, incomplete, stale and fresh cloud backups', (t) => {
  runBackupCheck(t, String.raw`
$cloud = Join-Path $PSScriptRoot 'cloud'
$key = Join-Path $PSScriptRoot 'cloud-key.dpapi'
$now = [datetime]::new(2027, 1, 4, 12, 0, 0, [DateTimeKind]::Utc)
[void][IO.Directory]::CreateDirectory($cloud)
if (Get-AcCloudBackupProblem '' $key $now) { throw 'disabled cloud tier warned' }
if ((Get-AcCloudBackupProblem $cloud $key $now) -notmatch 'cloud-key.dpapi is missing') { throw 'missing key not reported' }
[IO.File]::WriteAllText($key, 'fake; must never be unprotected by watchdog')
function Add-Fixture([string]$Stamp, [switch]$Incomplete) {
  $archive = Join-Path $cloud "ac-backup-$Stamp.acbak.enc"
  [IO.File]::WriteAllText($archive, 'fixture')
  [IO.File]::WriteAllText("$archive.sha256", 'fixture')
  if (-not $Incomplete) { [IO.File]::WriteAllText("$archive.meta.json", '{}') }
}
Add-Fixture '20270104T110000000Z' -Incomplete
if ((Get-AcCloudBackupProblem $cloud $key $now) -notmatch 'No complete') { throw 'incomplete upload counted' }
Add-Fixture '20270103T100000000Z'
if ((Get-AcCloudBackupProblem $cloud $key $now) -notmatch 'newest complete') { throw 'exactly 26 h must warn' }
Add-Fixture '20270104T100000000Z'
if (Get-AcCloudBackupProblem $cloud $key $now) { throw 'fresh backup warned' }
$recovery = Join-Path $PSScriptRoot 'recovery.key'
if ((Get-AcCloudBackupProblem $cloud $key $now $recovery) -notmatch 'recovery key is missing or invalid') { throw 'missing recovery key not reported' }
[IO.File]::WriteAllBytes($recovery, [byte[]]::new(32))
if (Get-AcCloudBackupProblem $cloud $key $now $recovery) { throw 'valid recovery key warned' }
$archive = Join-Path $cloud 'ac-backup-20270104T110000000Z.acbak.tar.gz'
foreach ($suffix in '', '.sha256', '.meta.json') { [IO.File]::WriteAllText($archive + $suffix, 'fixture') }
if (Get-AcCloudBackupProblem $cloud '' $now '' 'standard') { throw 'standard archive must not require a key' }
if (@(Get-AcCloudBundles $cloud 'standard').Count -ne 1) { throw 'standard mode must ignore encrypted generations' }
`);
});

test('cloud retention keeps seven UTC days plus the four completed ISO weeks across New Year', (t) => {
  runBackupCheck(t, String.raw`
$now = [datetime]::new(2027, 1, 11, 12, 0, 0, [DateTimeKind]::Utc)
$bundles = @(for ($i = 0; $i -le 35; $i++) {
  $stamp = $now.Date.AddDays(-$i).AddHours(2)
  [pscustomobject]@{ Bundle = $stamp.ToString('yyyy-MM-dd'); Stamp = $stamp }
})
$bundles += [pscustomobject]@{ Bundle = 'same-day-old'; Stamp = $now.Date.AddHours(1) }
$bundles += [pscustomobject]@{ Bundle = 'future'; Stamp = $now.AddDays(1) }
$expired = @(Get-AcExpiredCloudBundles $bundles $now | ForEach-Object Bundle)
$retained = @($bundles.Bundle | Where-Object { $_ -notin $expired -and $_ -ne 'future' } | Sort-Object)
$expected = @('2026-12-20', '2026-12-27', '2027-01-03', '2027-01-05', '2027-01-06',
  '2027-01-07', '2027-01-08', '2027-01-09', '2027-01-10', '2027-01-11')
if (($retained -join ',') -ne ($expected -join ',') -or 'future' -in $expired) {
  throw "wrong retained set: $retained"
}
`);
});
