#Requires -Version 7
<#
.SYNOPSIS
Runs `cli.ts tools-install --apply` for each app when the shared tool manifest or the set of shared skills changes.

.DESCRIPTION
Run on demand for the selected clients. An apply requires -Apply.
The fingerprint is the SHA-256 of the manifest file (found through <DataRoot>\tools.json) plus the sorted names of
the top-level folders in its skills_root. Edits inside an existing skill need nothing: apps reach skills through
junctions. When the fingerprint differs from the last successful one, for each app (codex, claude, antigravity):
  1. a dry run (`tools-install --app X`); "nothing to do" skips the app;
  2. otherwise `tools-install --app X --apply`, which backs up every file it changes under
     <DataRoot>\backups\tools-install-<time> and refuses to replace anything it does not manage
     (TOOLS_INSTALL_CONFLICT), exactly as when run by hand.
Results stay in local logs. The state records which clients applied the current fingerprint.
State: <DataRoot>\automation\tool-sync.json. Log: <DataRoot>\logs\tool-sync.log.
-Force repeats a check even when the fingerprint is unchanged.
#>
[CmdletBinding()]
param(
  [string]$DataRoot,
  [Parameter(Mandatory)][ValidateSet('codex', 'claude', 'antigravity')][string[]]$Apps,
  [switch]$Force,
  [switch]$Apply
)
$ErrorActionPreference = 'Stop'
$DryRun = -not $Apply
. (Join-Path $PSScriptRoot 'Ac-BackupCommon.ps1')
$DataRoot = Resolve-AcDataRoot $PSScriptRoot $DataRoot
$node = (Get-Command node.exe).Source
$cli = Join-Path $DataRoot 'current\v2\src\cli.ts'
$stateFile = Join-Path $DataRoot 'automation\tool-sync.json'
$logFile = Join-Path $DataRoot 'logs\tool-sync.log'
if ($Apply) { New-Item -ItemType Directory -Force (Split-Path $stateFile), (Split-Path $logFile) | Out-Null }
function Write-Log([string]$line) { $text = "$((Get-Date).ToString('s')) $line"; Write-Output $text; if (-not $DryRun) { Add-Content -LiteralPath $logFile -Value $text } }
$pointer = Join-Path $DataRoot 'tools.json'
if (-not (Test-Path $pointer)) { Write-Log "no $pointer; nothing to sync"; return }
$manifestPath = (Get-Content -Raw $pointer | ConvertFrom-Json).manifest
$manifest = Get-Content -Raw $manifestPath | ConvertFrom-Json
$skillNames = if ($manifest.skills_root -and (Test-Path $manifest.skills_root)) {
  @(Get-ChildItem -LiteralPath $manifest.skills_root -Directory | ForEach-Object Name | Sort-Object)
} else { @() }
$manifestHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $manifestPath).Hash
$fingerprint = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
  [Text.Encoding]::UTF8.GetBytes("$manifestHash`n$($skillNames -join "`n")")))

$state = if (Test-Path $stateFile) { Get-Content -Raw $stateFile | ConvertFrom-Json -AsHashtable } else { @{} }
if (-not $state.apps) { $state.apps = @{} }       # per app: the last fingerprint it was synced at
$pending = @($Apps | Where-Object { $Force -or $state.apps[$_] -ne $fingerprint })
if (-not $pending) { exit 0 }  # unchanged: stay quiet

$changes = @(); $failures = @()
foreach ($app in $pending) {
  $dry = & $node --disable-warning=ExperimentalWarning $cli tools-install --home $DataRoot --app $app 2>&1 | Out-String
  if ($LASTEXITCODE) { $failures += @{ app = $app; text = "dry run failed: $($dry.Trim())" }; continue }
  if ($dry -match 'nothing to do') { if (-not $DryRun) { $state.apps[$app] = $fingerprint }; continue }
  if ($DryRun) { Write-Output $dry; continue }
  $out = & $node --disable-warning=ExperimentalWarning $cli tools-install --home $DataRoot --app $app --apply 2>&1 | Out-String
  $code = $LASTEXITCODE
  Write-Log "$app apply (exit $code):`n$($out.Trim())"
  if ($code) { $failures += @{ app = $app; text = $out.Trim() } }
  else { $changes += "${app}: $(($dry -split "`n")[0].Trim())"; $state.apps[$app] = $fingerprint }
}
foreach ($failure in $failures) { Write-Log "failed: $($failure.app): $($failure.text)" }
if ($DryRun) { exit ($failures ? 1 : 0) }
if ($changes) { Write-Log "Tool sync applied: $($changes -join '; ')" }
$state.checkedAt = (Get-Date).ToUniversalTime().ToString('o')
$temp = "$stateFile.tmp"
$state | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $temp
Move-Item -LiteralPath $temp -Destination $stateFile -Force
exit ($failures ? 1 : 0)
