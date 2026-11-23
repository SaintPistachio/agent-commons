#Requires -Version 7
<#
.SYNOPSIS
Recovery drill for the newest off-drive database and, when configured, the encrypted cloud bundle.

.DESCRIPTION
Run every four weeks by AgentCommons-RestoreTest. Restores into separate new private scratch homes,
checks that they open, checks the restored cloud helper ledger, and removes the scratch files.
A failure exits 1 and writes a local diagnostic.
#>
[CmdletBinding()]
param(
  [string]$DataRoot,
  [string]$BackupRoot,
  [string]$CloudDestination,
  [string]$ScratchRoot,
  [string]$CliPath  # default: the installed release's cli.ts
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Ac-BackupCommon.ps1')
$node = (Get-Command node.exe).Source
function Assert-AcRestoredStatus([string]$HomePath) {
  $status = & $node --disable-warning=ExperimentalWarning $cli status --home $HomePath 2>&1 | Out-String
  if ($LASTEXITCODE -or $status -notmatch 'schema \d+') { throw "status on the restored home failed ($LASTEXITCODE)" }
}

$scratch = $null
$results = @()
$failures = @()
try {
  $DataRoot = Resolve-AcDataRoot $PSScriptRoot $DataRoot
  $config = Read-AcBackupConfig $DataRoot
  $BackupRoot = Get-AcBackupPath $config 'offDriveDestination' $BackupRoot '' $DataRoot
  if (-not $BackupRoot) { throw 'Configure an off-drive backup directory or pass -BackupRoot.' }
  $CloudDestination = Get-AcBackupPath $config 'cloudDestination' $CloudDestination '' $DataRoot
  $archiveMode = Get-AcCloudArchiveMode $config
  $recoveryKeyFile = Get-AcRecoveryKeyFile $config $DataRoot $CloudDestination
  $ScratchRoot = Get-AcBackupPath $config 'scratchRoot' $ScratchRoot '' $DataRoot
  if (-not $ScratchRoot) { $ScratchRoot = Join-Path (Get-AcLocalTempRoot) 'ac-restore-test' }
  $cli = if ($CliPath) { $CliPath } else { Join-Path $DataRoot 'current\v2\src\cli.ts' }
  Assert-AcNotOneDrive $ScratchRoot
  foreach ($root in @($DataRoot, $BackupRoot, $CloudDestination)) { Assert-AcSeparatePaths $ScratchRoot $root }
  $scratch = Join-Path $ScratchRoot ([guid]::NewGuid().ToString('N'))
  Set-AcPrivateDirectory $scratch -Create

  try {
    $newest = Get-AcAutomaticDatabases $BackupRoot | Select-Object -First 1
    if (-not $newest) { throw "no automatic database backup in $BackupRoot" }
    $offHome = Join-Path $scratch 'off-drive-home'
    & $node --disable-warning=ExperimentalWarning $cli restore --source $newest.FullName --home $offHome | Out-Null
    if ($LASTEXITCODE) { throw "restore failed ($LASTEXITCODE)" }
    Assert-AcRestoredStatus $offHome
    $results += "off-drive $($newest.Name) restored and opened"
  } catch { $failures += "off-drive: $($_.Exception.Message)" }

  if ($CloudDestination) {
    try {
      $keyPath = Get-AcCloudKeyPath $DataRoot
      if ($archiveMode -eq 'encrypted' -and -not $recoveryKeyFile -and -not [IO.File]::Exists($keyPath)) { throw 'cloud-key.dpapi is missing' }
      $newest = Get-AcCloudBundles $CloudDestination $archiveMode | Sort-Object Stamp -Descending | Select-Object -First 1
      if (-not $newest) { throw "no complete backup in $CloudDestination" }
      $cloudHome = Join-Path $scratch 'cloud-home'
      $scratchHelper = Join-Path $scratch 'cloud-helper'
      $bundleArgs = @('--disable-warning=ExperimentalWarning', $cli, 'bundle-restore',
        '--source', $newest.Bundle, '--home', $cloudHome, '--helper-root', $scratchHelper,
        '--staging-parent', $scratch)
      Invoke-AcCloudBundleCli $node $bundleArgs $keyPath $recoveryKeyFile $archiveMode
      Assert-AcRestoredStatus $cloudHome
      $integrity = @'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1], { readOnly: true });
try {
  const rows = db.prepare('PRAGMA integrity_check').all();
  if (rows.length !== 1 || rows[0].integrity_check !== 'ok') process.exitCode = 1;
} finally { db.close(); }
'@
      & $node --disable-warning=ExperimentalWarning -e $integrity (Join-Path $scratchHelper '.local\usage.sqlite3')
      if ($LASTEXITCODE) { throw "restored usage.sqlite3 integrity_check failed ($LASTEXITCODE)" }
      $results += "cloud $(Split-Path $newest.Bundle -Leaf) restored; status and helper integrity OK"
    } catch { $failures += "cloud: $($_.Exception.Message)" }
  }
} catch { $failures += $_.Exception.Message }
finally {
  if ($scratch -and [IO.Directory]::Exists($scratch)) {
    try {
      $scratchPhysical = Resolve-AcPhysicalPath $scratch
      $scratchParent = Resolve-AcPhysicalPath $ScratchRoot
      if ([IO.Path]::GetDirectoryName($scratchPhysical) -ine $scratchParent -or [IO.Path]::GetFileName($scratchPhysical) -cnotmatch "^[a-f0-9]{32}$") {
        throw "Refusing to remove an unexpected scratch directory: $scratchPhysical"
      }
      Remove-Item -LiteralPath $scratchPhysical -Recurse -Force
    }
    catch { $failures += "could not delete private scratch folder $scratch`: $($_.Exception.Message)" }
  }
}

if ($failures.Count) {
  $summary = "Restore test FAILED: $($failures -join '; ')"
  if ($results.Count) { $summary += ". Passed: $($results -join '; ')" }
  $summary
  exit 1
}
$summary = "Restore test passed: $($results -join '; ')"
$summary
exit 0
