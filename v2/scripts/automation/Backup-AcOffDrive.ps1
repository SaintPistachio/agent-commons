#Requires -Version 7
<#
.SYNOPSIS
Makes a private off-drive copy and optionally publishes an encrypted cloud bundle.

.DESCRIPTION
Run nightly by AgentCommons-OffDriveBackup. Reads <DataRoot>\backup-config.json.
The off-drive backup archive is additive, with retention only for automatic database copies.
The separate mirror contains recovery files and an online helper-ledger snapshot.
The cloud destination receives only an encrypted bundle and its two sidecars; retention runs after SHA-256 readback.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
  [string]$DataRoot,
  [string]$Destination,
  [ValidateRange(1, 10000)][int]$KeepDatabase = 30,
  [ValidateRange(1, 3650)][int]$KeepDays = 30,
  [switch]$NoFreshBackup
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false   # Robocopy codes 0–7 are successes.
. (Join-Path $PSScriptRoot 'Ac-BackupCommon.ps1')
$log = $null
function Write-Log([string]$Line) {
  $text = "$((Get-Date).ToString('s')) $Line"
  Write-Output $text
  if ($log -and -not $WhatIfPreference) {
    try { Add-Content -LiteralPath $log -Value $text } catch { Write-Warning "Could not write $log`: $($_.Exception.Message)" }
  }
}

function Copy-AcDirectory([string]$From, [string]$To, [string[]]$Options) {
  if ((Get-Item -LiteralPath $From -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw "Refusing to copy a reparse-point directory: $From"
  }
  if ((Test-Path -LiteralPath $To) -and ((Get-Item -LiteralPath $To -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "Refusing to copy into a reparse-point directory: $To"
  }
  robocopy $From $To /E /XJ /SL /COPY:DAT /DCOPY:DA /R:2 /W:5 /NFL /NDL /NJH /NJS /NP @Options | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy to $To failed ($LASTEXITCODE)" }
}

function Publish-AcCloudBackup([string]$Cloud, [string]$Key, [string]$RecoveryKeyFile, [string]$ArchiveMode) {
  $tempRoot = Get-AcLocalTempRoot
  Assert-AcNotOneDrive $tempRoot
  $stage = Join-Path $tempRoot ('ac-backup-' + [guid]::NewGuid().ToString('N'))
  Assert-AcSeparatePaths $stage $Cloud
  $created = [Collections.Generic.List[string]]::new()
  $verified = $false
  try {
    Set-AcPrivateDirectory $stage -Create
    $stamp = [datetime]::UtcNow.ToString("yyyyMMdd'T'HHmmssfff'Z'", [Globalization.CultureInfo]::InvariantCulture)
    $suffix = if ($ArchiveMode -eq 'standard') { 'tar.gz' } else { 'enc' }
    $archive = Join-Path $stage "ac-backup-$stamp.acbak.$suffix"
    $bundleArgs = @('--disable-warning=ExperimentalWarning', $cli, 'bundle-create',
      '--home', $DataRoot, '--out', $archive, '--staging-parent', $stage)
    if ($helperSelection.configured -or [IO.File]::Exists($ledger)) {
      $bundleArgs += @('--helper-root', $helper)
    }
    Invoke-AcCloudBundleCli $node $bundleArgs $Key $RecoveryKeyFile $ArchiveMode
    $sidecars = Get-AcBundleSidecars $archive
    if (-not [IO.File]::Exists($archive) -or -not $sidecars) { throw 'bundle-create did not produce an archive and both sidecars' }
    $expected = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
    [void][IO.Directory]::CreateDirectory($Cloud)
    # Publish the archive last, after write completion and checksum verification.
    $published = Join-Path $Cloud (Split-Path $archive -Leaf)
    $pending = "$published.partial-$([guid]::NewGuid().ToString('N'))"
    foreach ($file in @($sidecars.Hash, $sidecars.Metadata, $archive)) {
      $target = if ($file -eq $archive) { $pending } else { Join-Path $Cloud (Split-Path $file -Leaf) }
      $inputFile = [IO.File]::OpenRead($file)
      try {
        $outputFile = [IO.File]::Open($target, 'CreateNew', 'Write', 'None')
        $created.Add($target)
        try { $inputFile.CopyTo($outputFile) }
        finally { $outputFile.Dispose() }
      } finally { $inputFile.Dispose() }
    }
    if ((Get-FileHash -LiteralPath $pending -Algorithm SHA256).Hash -ne $expected) {
      throw "SHA-256 readback failed for the pending archive at $pending"
    }
    [IO.File]::Move($pending, $published)
    $created.Add($published)
    if ((Get-FileHash -LiteralPath $published -Algorithm SHA256).Hash -ne $expected) {
      throw "SHA-256 readback failed for $published"
    }
    $verified = $true
    $bundles = @(Get-AcCloudBundles $Cloud $ArchiveMode)
    foreach ($old in (Get-AcExpiredCloudBundles $bundles ([datetime]::UtcNow))) {
      if ($old.Bundle -eq $published) { continue }
      Remove-Item -LiteralPath $old.Bundle, $old.Hash, $old.Metadata -Force
    }
    Write-Log "cloud ok: verified $published"
  } finally {
    if (-not $verified) {
      foreach ($file in $created) { Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue }
    }
    if ([IO.Directory]::Exists($stage)) { Remove-Item -LiteralPath $stage -Recurse -Force }
  }
}

try {
  $DataRoot = Resolve-AcDataRoot $PSScriptRoot $DataRoot
  $config = Read-AcBackupConfig $DataRoot
  $Destination = Get-AcBackupPath $config 'offDriveDestination' $Destination '' $DataRoot
  if (-not $Destination) { throw 'Set offDriveDestination or pass -Destination before running the backup.' }
  $cloud = Get-AcBackupPath $config 'cloudDestination' '' '' $DataRoot
  $archiveMode = Get-AcCloudArchiveMode $config
  $recoveryKeyFile = Get-AcRecoveryKeyFile $config $DataRoot $cloud
  $node = (Get-Command node.exe).Source
  $cli = Join-Path $DataRoot 'current\v2\src\cli.ts'
  $helperSelection = Get-AcHelperSelection $node $cli $DataRoot
  $helper = $helperSelection.root
  $ledger = Join-Path $helper '.local\usage.sqlite3'
  if (-not [IO.File]::Exists($ledger)) {
    if ($helperSelection.configured) { throw "Configured API helper ledger is missing: $ledger" }
    Write-Warning "No API helper ledger at $ledger. This generation backs up Agent Commons data only."
  }
  Assert-AcNotOneDrive $Destination
  foreach ($root in @($DataRoot, $helper, $cloud)) { Assert-AcSeparatePaths $Destination $root }
  Assert-AcSeparatePaths $cloud $DataRoot
  Assert-AcSeparatePaths $cloud $helper
  Assert-AcSeparatePaths $recoveryKeyFile $helper
  Assert-AcSeparatePaths $cloud (Get-AcCheckout $PSScriptRoot)

  $source = Join-Path $DataRoot 'backups'
  if (-not $NoFreshBackup -and $PSCmdlet.ShouldProcess($DataRoot, 'Back up the database')) {
    & $node --disable-warning=ExperimentalWarning $cli backup --home $DataRoot --keep 10 | Out-Null
    if ($LASTEXITCODE) { throw "cli.ts backup failed ($LASTEXITCODE)" }
  }
  if ($PSCmdlet.ShouldProcess($Destination, "Copy backups and update the private mirror")) {
    if (-not [IO.Directory]::Exists($Destination)) { Set-AcPrivateDirectory $Destination -Create }
    Assert-AcPrivateDirectory $Destination
    $log = Join-Path $Destination '_offdrive-backup.log'
    # DPAPI is machine/account-bound; never put the key or intermediate key writes in backup copies.
    Copy-AcDirectory $source $Destination @('/XO', '/FFT', '/XF', '_offdrive-backup.log', 'cloud-key.dpapi', '.cloud-key-*.tmp')

    $mirror = Join-Path $Destination 'mirror'
    foreach ($path in @($mirror, (Join-Path $mirror 'openai-capabilities'), (Join-Path $mirror 'openai-capabilities\.local'))) {
      if ((Test-Path -LiteralPath $path) -and ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Refusing to write into a reparse-point directory: $path"
      }
      [void][IO.Directory]::CreateDirectory($path)
    }
    foreach ($name in 'artifacts', 'connections', 'helpers', 'automation') {
      $from = Join-Path $DataRoot $name
      if ([IO.Directory]::Exists($from)) { Copy-AcDirectory $from (Join-Path $mirror $name) @('/PURGE') }
    }
    $tools = Join-Path $DataRoot 'tools.json'
    if ([IO.File]::Exists($tools)) { Copy-Item -LiteralPath $tools -Destination (Join-Path $mirror 'tools.json') -Force }

    $helperMirror = Join-Path $mirror 'openai-capabilities'
    if ([IO.File]::Exists($ledger)) {
      $copy = Join-Path $helperMirror '.local\usage.sqlite3'
      $tmp = "$copy.$([guid]::NewGuid().ToString('N')).tmp"
      $snapshot = @'
const { DatabaseSync, backup } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1], { readOnly: true, timeout: 5000 });
(async () => {
  try { await backup(db, process.argv[2]); }
  finally { db.close(); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
'@
      try {
        & $node --disable-warning=ExperimentalWarning -e $snapshot $ledger $tmp
        if ($LASTEXITCODE) { throw "Helper ledger snapshot failed ($LASTEXITCODE)" }
        [IO.File]::Move($tmp, $copy, $true)
      } finally {
        if ([IO.File]::Exists($tmp)) { [IO.File]::Delete($tmp) }
      }
    }
    # These directories are for redacted evidence only. Never copy the helper's .local tree wholesale.
    foreach ($name in 'evidence', '.local\evidence') {
      $from = Join-Path $helper $name
      if ([IO.Directory]::Exists($from)) {
        Copy-AcDirectory $from (Join-Path $helperMirror $name) @('/PURGE', '/XD', 'secrets', '/XF', '.env', '.env.*', '*.dpapi')
      }
    }

    $cutoff = [datetime]::UtcNow.AddDays(-$KeepDays)
    $removed = 0
    foreach ($db in (Get-AcAutomaticDatabases $Destination | Select-Object -Skip $KeepDatabase)) {
      if ($db.LastWriteTimeUtc -ge $cutoff) { continue }
      foreach ($file in @($db.FullName, "$($db.FullName)-shm", "$($db.FullName)-wal")) {
        if ([IO.File]::Exists($file) -and $PSCmdlet.ShouldProcess($file, 'Remove old database copy')) {
          Remove-Item -LiteralPath $file -Force
          $removed++
        }
      }
    }
    Write-Log "off-drive ok: copied from $source; removed $removed old database file(s)"
  }

  if ($cloud) {
    $key = Get-AcCloudKeyPath $DataRoot
    if ($archiveMode -eq 'encrypted' -and -not $recoveryKeyFile -and -not [IO.File]::Exists($key)) { Write-Warning 'Cloud backup skipped: run Set-AcBackupPassphrase.ps1 first.' }
    elseif ($PSCmdlet.ShouldProcess($cloud, 'Publish and verify cloud backup, then apply retention')) {
      Publish-AcCloudBackup $cloud $key $recoveryKeyFile $archiveMode
    }
  }
} catch {
  $message = "failed: $($_.Exception.Message)"
  Write-Log $message
  exit 1
}
exit 0
