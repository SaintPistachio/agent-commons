#Requires -Version 7
<#
.SYNOPSIS
Registers (or removes) the per-user logon task that runs the Agent Commons v2 service.

.DESCRIPTION
Runs the installed release at <DataRoot>\current without a console window and appends its
output to <DataRoot>\logs\service.log. The service listens on 127.0.0.1:4727. Remove with
-Unregister. DataRoot defaults to the folder beside the main checkout named <checkout>-data.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
  [switch]$Unregister,
  [string]$TaskName = 'AgentCommonsV2',
  [string]$DataRoot,
  [ValidateRange(1, 65535)][int]$Port = 4727
)

$ErrorActionPreference = 'Stop'
if (-not $DataRoot) {
  $main = Split-Path (git -C (Join-Path $PSScriptRoot '..\..') rev-parse --path-format=absolute --git-common-dir).Trim() -Parent
  $DataRoot = Join-Path (Split-Path $main -Parent) ((Split-Path $main -Leaf) + '-data')
}
$home2 = [IO.Path]::GetFullPath($DataRoot)
if ($home2.StartsWith([IO.Path]::GetFullPath($env:USERPROFILE), [StringComparison]::OrdinalIgnoreCase)) { throw "DataRoot $home2 is under the user profile." }

if ($Unregister) {
  if ($PSCmdlet.ShouldProcess($TaskName, 'Stop and unregister')) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  }
  return
}

# The task runs whatever `current` points at (set by Install-AgentCommonsV2.ps1), so upgrades need no re-registration.
$app = Join-Path $home2 'current'
if (-not (Test-Path (Join-Path $app 'v2\src\cli.ts'))) { throw "No installed v2 release at $app; run Install-AgentCommonsV2.ps1 first." }
$node = (Get-Command node.exe).Source
$logs = Join-Path $home2 'logs'; New-Item -ItemType Directory -Force $logs | Out-Null
$inner = "& '$node' --disable-warning=ExperimentalWarning '$app\v2\src\cli.ts' serve --home '$home2' --port $Port *>> '$logs\service.log'"

$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "--headless pwsh.exe -NoProfile -NonInteractive -Command `"$inner`"" -WorkingDirectory $app
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew

if ($PSCmdlet.ShouldProcess($TaskName, "Register logon task for $app")) {
  # A running instance keeps the port; stop it so the re-registered action is what serves.
  $cli = Join-Path $app 'v2\src\cli.ts'
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    # Graceful stop first (closes the database cleanly), up to 5 s; force only a service that did not exit.
    $runtime = Join-Path $home2 'runtime.json'
    $servicePid = if (Test-Path $runtime) { (Get-Content $runtime -Raw | ConvertFrom-Json).pid } else { $null }
    & $node --disable-warning=ExperimentalWarning $cli stop --home $home2
    if ($servicePid) { foreach ($i in 1..10) { if (-not (Get-Process -Id $servicePid -ErrorAction SilentlyContinue)) { break }; Start-Sleep -Milliseconds 500 } }
    Stop-ScheduledTask -TaskName $TaskName
    if ($servicePid) { Get-Process -Id $servicePid -ErrorAction SilentlyContinue | Where-Object ProcessName -eq 'node' | Stop-Process -Force }
    Start-Sleep 1
  }
  & $node --disable-warning=ExperimentalWarning $cli rotate-log --home $home2
  Register-ScheduledTask -TaskName $TaskName -Description "Agent Commons v2 continuity service (127.0.0.1:$Port)" `
    -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskName $TaskName
  foreach ($i in 1..20) {
    try { $health = Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 2; "Registered and running: $($health.status) ($((Get-Item $app).Target))"; return }
    catch { Start-Sleep 1 }
  }
  Write-Warning "Registered, but no health response yet. Check $logs\service.log"
}
