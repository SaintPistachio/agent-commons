#Requires -Version 7
<#
.SYNOPSIS
Creates a passwordless backup recovery key in private local storage.
#>
[CmdletBinding(SupportsShouldProcess)]
param([Parameter(Mandatory)][string]$KeyFile)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Ac-BackupCommon.ps1')
$KeyFile = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($KeyFile)
Assert-AcNotOneDrive $KeyFile
$folder = Split-Path -Path $KeyFile -Parent
if (Test-Path -LiteralPath $KeyFile) { throw "A recovery key already exists at $KeyFile" }
if (-not $PSCmdlet.ShouldProcess($KeyFile, 'Create private backup recovery key')) { return }
if (-not [IO.Directory]::Exists($folder)) { Set-AcPrivateDirectory $folder -Create }
Assert-AcPrivateDirectory $folder
if ((Get-Item -LiteralPath $folder -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
  throw 'Use a private recovery key directory without a reparse point'
}

$key = [Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
try {
  $stream = [IO.File]::Open($KeyFile, 'CreateNew', 'Write', 'None')
  try { $stream.Write($key); $stream.Flush($true) }
  finally { $stream.Dispose() }
  if ((Get-Item -LiteralPath $KeyFile).Length -ne 32) { throw 'Recovery key readback length was incorrect' }
  "Created private recovery key at $KeyFile"
} finally {
  [Array]::Clear($key, 0, $key.Length)
}
