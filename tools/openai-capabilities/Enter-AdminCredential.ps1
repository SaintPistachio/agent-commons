#Requires -Version 7.0
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$apiPython = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
$entryScript = Join-Path $PSScriptRoot 'setup_credentials.py'
if (-not (Test-Path -LiteralPath $apiPython -PathType Leaf)) {
    throw 'The helper isolated Python environment is missing.'
}
Write-Output 'OpenAI API Admin credential setup - local interactive entry'
Write-Output 'Use the dedicated Admin key for the selected Personal organization.'
Write-Output 'Never enter a key in chat or as a command argument.'
& $apiPython $entryScript --kind admin
$entryExit = $LASTEXITCODE
if ($entryExit -eq 0) {
    Write-Output 'Protected credential save completed. Return to the Codex chat.'
} else {
    Write-Output "Credential entry did not complete (exit $entryExit). Return to the Codex chat."
}
