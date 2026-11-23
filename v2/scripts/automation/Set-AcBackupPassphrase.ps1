#Requires -Version 7
<#
.SYNOPSIS
Stores the nightly cloud-backup passphrase under Windows CurrentUser DPAPI.
#>
[CmdletBinding()]
param([string]$DataRoot)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Ac-BackupCommon.ps1')
$DataRoot = Resolve-AcDataRoot $PSScriptRoot $DataRoot
if (-not [IO.Directory]::Exists($DataRoot)) { throw "Agent Commons home does not exist: $DataRoot" }
Assert-AcNotOneDrive $DataRoot
Initialize-AcDpapi
$keyPath = Get-AcCloudKeyPath $DataRoot
$folder = Split-Path $keyPath -Parent
if (-not [IO.Directory]::Exists($folder)) { Set-AcPrivateDirectory $folder -Create }
Assert-AcPrivateDirectory $folder
$tmp = Join-Path $folder ('.cloud-key-' + [guid]::NewGuid().ToString('N') + '.tmp')

$first = $second = $bytes = $confirm = $protected = $readback = $null
try {
  $first = Read-Host 'Cloud backup passphrase (at least 16 characters)' -AsSecureString
  $second = Read-Host 'Enter the same passphrase again' -AsSecureString
  if ($first.Length -lt 16) { throw 'Passphrase must be at least 16 characters' }
  $bytes = Get-AcSecureUtf8 $first
  $confirm = Get-AcSecureUtf8 $second
  if (-not [Collections.StructuralComparisons]::StructuralEqualityComparer.Equals($bytes, $confirm)) {
    throw 'Passphrases do not match'
  }
  $protected = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')
  [IO.File]::WriteAllBytes($tmp, $protected)
  $readback = Read-AcCloudKey $tmp
  if (-not [Collections.StructuralComparisons]::StructuralEqualityComparer.Equals($bytes, $readback)) {
    throw 'DPAPI readback did not match; existing key was not replaced'
  }
  [IO.File]::Move($tmp, $keyPath, $true)
} finally {

  if ($bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
  if ($confirm) { [Array]::Clear($confirm, 0, $confirm.Length) }
  if ($protected) { [Array]::Clear($protected, 0, $protected.Length) }
  if ($readback) { [Array]::Clear($readback, 0, $readback.Length) }
  if ($first) { $first.Dispose() }
  if ($second) { $second.Dispose() }
  if ([IO.File]::Exists($tmp)) { [IO.File]::Delete($tmp) }
}
'Passphrase stored and verified. Save it in your password manager; this DPAPI file is not portable.'
