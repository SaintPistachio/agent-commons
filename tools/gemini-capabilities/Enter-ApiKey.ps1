#Requires -Version 7.0
<#
.SYNOPSIS
Stores the Agent Commons Gemini API key encrypted for this Windows user (DPAPI). Input is hidden.

.DESCRIPTION
Create the key in AI Studio (Get API key) in the Agent Commons project whose billing account holds the Google AI Pro
credit. Never paste the key in chat or pass it as a command argument. Expected result: "status": "saved".
#>
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\..\v2\scripts\automation\Ac-BackupCommon.ps1')
$state = Join-Path $PSScriptRoot '.local'
Assert-AcNotOneDrive $state
foreach ($storagePath in @($state, (Join-Path $state 'secrets'))) {
    if (-not (Test-Path -LiteralPath $storagePath)) { Set-AcPrivateDirectory $storagePath -Create }
    $item = Get-Item -LiteralPath $storagePath -Force
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Gemini storage requires a regular local directory.'
    }
    Assert-AcPrivateDirectory $storagePath
}
$python = (Get-Command python -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
Write-Output 'Gemini API key setup for Agent Commons - local entry only. Never enter the key in chat.'
& $python -I (Join-Path $PSScriptRoot 'run.py') set-key
$keyExitCode = $LASTEXITCODE
if ($keyExitCode -eq 0) {
    [IO.File]::WriteAllText((Join-Path $state 'python-path.txt'), $python)
    Write-Output 'Saved. Return to the Agent Commons thread.'
} else {
    Write-Output "The key was not saved (exit $keyExitCode). Return to the Agent Commons thread."
}
exit $keyExitCode
