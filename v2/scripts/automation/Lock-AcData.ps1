#Requires -Version 7
<#
.SYNOPSIS
Restricts Agent Commons connection and backup directories to the current Windows user and LocalSystem.
.DESCRIPTION
Use -HomeOnly for connections and backups. Otherwise provide a dedicated off-drive destination
with -Destination or backup-config.json. Preview changes with -WhatIf. The script saves the prior
ACLs under the data home before applying and verifying the new permissions.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
  [string]$DataRoot,
  [string]$Destination,
  [switch]$HomeOnly
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Ac-BackupCommon.ps1')
$DataRoot = Resolve-AcDataRoot $PSScriptRoot $DataRoot
if (-not [IO.Directory]::Exists($DataRoot)) { throw "Agent Commons home does not exist: $DataRoot" }
Assert-AcNotOneDrive $DataRoot
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if (-not $HomeOnly) {
  $config = Read-AcBackupConfig $DataRoot
  $Destination = Get-AcBackupPath $config 'offDriveDestination' $Destination '' $DataRoot
  $cloud = Get-AcBackupPath $config 'cloudDestination' '' '' $DataRoot
  if ($Destination) {
    Assert-AcNotOneDrive $Destination
    Assert-AcSeparatePaths $Destination $DataRoot
    Assert-AcSeparatePaths $Destination $cloud
    $item = Get-Item -LiteralPath $Destination -Force -ErrorAction SilentlyContinue
    if ($item -and (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint))) {
      throw "Use a backup directory without a reparse point: $Destination"
    }
    if (-not $item -and $PSCmdlet.ShouldProcess($Destination, 'Create private backup folder')) {
      Set-AcPrivateDirectory $Destination -Create
    }
  }
} else { $Destination = $null }
$backups = Join-Path $DataRoot 'backups'
if (-not [IO.Directory]::Exists($backups) -and $PSCmdlet.ShouldProcess($backups, 'Create private backups folder')) {
  Set-AcPrivateDirectory $backups -Create
}
$folders = @((Join-Path $DataRoot 'connections'), $backups, $Destination) |
  Where-Object { $_ -and [IO.Directory]::Exists($_) } | Select-Object -Unique
foreach ($d in $folders) {
  if ((Get-Item -LiteralPath $d -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw "Refusing to reset permissions through a reparse point: $d"
  }
}
$save = Join-Path $DataRoot "backups\acl-before-lockdown-$((Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ'))"
if ($PSCmdlet.ShouldProcess($save, 'Save current ACLs')) {
  New-Item -ItemType Directory -Force $save | Out-Null
  foreach ($d in $folders) {
    $name = ($d -replace '[:\\/]+', '_') + '.acl'
    icacls $d /save (Join-Path $save $name) /t /c /q /l | Out-Null
    if ($LASTEXITCODE) { throw "icacls /save failed for $d ($LASTEXITCODE)" }
  }
}
foreach ($d in $folders) {
  if (-not $PSCmdlet.ShouldProcess($d, 'Limit to the current user and SYSTEM')) { continue }
  Set-AcPrivateDirectory $d
  # Children drop their explicit and old inherited entries and inherit the protected parent.
  Get-ChildItem -LiteralPath $d -Force | ForEach-Object {
    icacls $_.FullName /reset /t /q /l | Out-Null
    if ($LASTEXITCODE) { throw "icacls /reset failed for $($_.FullName) ($LASTEXITCODE)" }
  }
  $others = @((Get-Acl -LiteralPath $d).Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin @($me, 'S-1-5-18') })
  if ($others) { throw "$d still grants: $(($others.IdentityReference | Sort-Object -Unique) -join ', ')" }
  "locked: $d"
}
"ACL backups: $save"
