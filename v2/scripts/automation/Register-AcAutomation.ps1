#Requires -Version 7
<#
.SYNOPSIS
Registers selected Agent Commons Windows automations for the current user.
.DESCRIPTION
-Only explicitly selects the service scheduler identity, maintenance tasks, or repository outcome hooks.
Configure an off-drive backup destination before opting into backup and restore tasks.
Run with -WhatIf to preview the selected registration or removal.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
  [string]$DataRoot,
  [string]$MainCheckout,
  [ValidateRange(1, 65535)][int]$Port = 4727,
  [Parameter(Mandatory)][ValidateSet('Scheduler', 'Tasks', 'GitHooks')][string[]]$Only,
  [switch]$Unregister
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Automation registration requires Windows.' }
. (Join-Path $PSScriptRoot 'Ac-BackupCommon.ps1')
$explicitCheckout = [bool]$MainCheckout
if ($MainCheckout) { $MainCheckout = (Resolve-Path -LiteralPath $MainCheckout).Path }
else { $MainCheckout = Get-AcCheckout $PSScriptRoot }
if ($explicitCheckout -and -not $DataRoot) { $DataRoot = "$MainCheckout-data" }
$DataRoot = Resolve-AcDataRoot $PSScriptRoot $DataRoot
$auto = Join-Path $DataRoot 'current\v2\scripts\automation'
$cli = Join-Path $DataRoot 'current\v2\src\cli.ts'
$node = (Get-Command node.exe).Source
$backup = Join-Path $DataRoot "backups\automation-setup-$((Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ'))"
function Save-Backup([string]$file) {
  if (Test-Path -LiteralPath $file) {
    New-Item -ItemType Directory -Force $backup | Out-Null
    Copy-Item -LiteralPath $file -Destination (Join-Path $backup (($file -replace '[:\\/]+', '_'))) -Force
  }
}
$taskNames = 'AgentCommons-OffDriveBackup', 'AgentCommons-Watchdog', 'AgentCommons-RestoreTest'
$hookMarker = '# agent-commons: ac-git-outcomes'
if ('GitHooks' -in $Only) {
  $gitCommon = git -C $MainCheckout rev-parse --path-format=absolute --git-common-dir
  if ($LASTEXITCODE -or -not $gitCommon) { throw "Cannot locate the Git hook directory in $MainCheckout; specify -MainCheckout" }
  $hooksDir = Join-Path $gitCommon.Trim() 'hooks'
}

if ($Unregister) {
  if ('Tasks' -in $Only) { foreach ($t in $taskNames) { if ((Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) -and $PSCmdlet.ShouldProcess($t, 'Unregister scheduled task')) { Unregister-ScheduledTask -TaskName $t -Confirm:$false; "removed task $t" } } }
  if ('GitHooks' -in $Only) {
    foreach ($h in 'post-commit', 'post-merge') { $f = Join-Path $hooksDir $h; if ((Test-Path $f) -and ((Get-Content -Raw $f) -match [regex]::Escape($hookMarker))) { if ($PSCmdlet.ShouldProcess($f, "Remove installed Git hook")) { Save-Backup $f; Remove-Item -LiteralPath $f; "removed hook $h" } } }
  }
  "The scheduler identity is retained. Backups: $backup"
  return
}

if (-not (Test-Path (Join-Path $auto 'ac-client.mjs'))) { throw "The installed release has no $auto; install the release that contains v2\scripts\automation first." }

if ('Scheduler' -in $Only) {
  if (Test-Path (Join-Path $DataRoot 'connections\ac-scheduler.json')) { 'scheduler: ac-scheduler already exists' }
  elseif ($PSCmdlet.ShouldProcess('ac-scheduler', 'Create app identity')) {
    & $node --disable-warning=ExperimentalWarning $cli add-client --home $DataRoot --port $Port --name ac-scheduler --profile air
    if ($LASTEXITCODE) { throw "add-client failed ($LASTEXITCODE)" }
    'scheduler: created ac-scheduler'
  }
}

if ('Tasks' -in $Only) {
  $logs = Join-Path $DataRoot 'logs'
  if (-not $WhatIfPreference) { New-Item -ItemType Directory -Force $logs | Out-Null }
  $user = "$env:USERDOMAIN\$env:USERNAME"
  $autoArg = $auto.Replace("'", "''")
  $dataArg = $DataRoot.Replace("'", "''")
  $logsArg = $logs.Replace("'", "''")
  function New-HiddenAction([string]$inner) {
    $command = "$inner; exit `$LASTEXITCODE"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "--headless pwsh.exe -NoProfile -NonInteractive -EncodedCommand $encoded" -WorkingDirectory $DataRoot
  }
  $settingsSet = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 45) -MultipleInstances IgnoreNew
  $config = Read-AcBackupConfig $DataRoot
  $backupDestination = Get-AcBackupPath $config 'offDriveDestination' '' '' $DataRoot
  $watch = New-ScheduledTaskTrigger -Daily -At '00:02'
  $watch.Repetition = (New-ScheduledTaskTrigger -Once -At '00:02' -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Hours 23 -Minutes 59)).Repetition
  $definitions = @(@{ Name = 'AgentCommons-Watchdog'; Description = 'Checks the service and configured backups'
       Inner = "& '$autoArg\Watch-AcHealth.ps1' -DataRoot '$dataArg' -Url 'http://127.0.0.1:$Port' *>> '$logsArg\watchdog.log'"
       Triggers = @((New-ScheduledTaskTrigger -AtLogOn -User $user), $watch) })
  if ($backupDestination) {
    $definitions += @{ Name = 'AgentCommons-OffDriveBackup'; Description = 'Backs up Agent Commons to the configured destination'
       Inner = "& '$autoArg\Backup-AcOffDrive.ps1' -DataRoot '$dataArg' *>> '$logsArg\offdrive-backup.out.log'"
       Triggers = @(New-ScheduledTaskTrigger -Daily -At '02:30') }
    $definitions += @{ Name = 'AgentCommons-RestoreTest'; Description = 'Verifies configured backups in private scratch directories'
       Inner = "& '$autoArg\Test-AcRestore.ps1' -DataRoot '$dataArg' *>> '$logsArg\restore-test.log'"
       Triggers = @(New-ScheduledTaskTrigger -Weekly -WeeksInterval 4 -DaysOfWeek Sunday -At '03:30') }
  }
  foreach ($d in $definitions) {
    if ($PSCmdlet.ShouldProcess($d.Name, 'Register scheduled task')) {
      Register-ScheduledTask -TaskName $d.Name -Description $d.Description -Action (New-HiddenAction $d.Inner) `
        -Trigger $d.Triggers -Settings $settingsSet -Force | Out-Null
      "task: registered $($d.Name)"
    }
  }
}

if ('GitHooks' -in $Only) {
  if (-not $WhatIfPreference) { New-Item -ItemType Directory -Force $hooksDir | Out-Null }
  $script = ($auto -replace '\\', '/') + '/ac-git-outcomes.mjs'
  $script = "'" + $script.Replace("'", "'\''") + "'"
  foreach ($h in 'post-commit', 'post-merge') {
    $file = Join-Path $hooksDir $h
    # The event's commit, reflog subject and squash flag are captured before backgrounding, so a later git operation
    # cannot be credited; the API call runs in the background and never delays or fails git.
    $template = @'
#!/bin/sh
MARKER (records job feedback in Agent Commons; never blocks git)
sha=$(git rev-parse HEAD 2>/dev/null) || exit 0
subject=$(git reflog -1 --format=%gs HEAD 2>/dev/null)
node SCRIPT HOOK --sha "$sha" --squash "${1:-0}" --subject "$subject" >/dev/null 2>&1 &
exit 0
'@
    $body = $template.Replace('MARKER', $hookMarker).Replace('SCRIPT', $script).Replace('HOOK', $h).Replace("`r`n", "`n")
    if ((Test-Path $file) -and -not ((Get-Content -Raw $file) -match [regex]::Escape($hookMarker))) { Write-Warning "hook ${h}: an existing hook is not ours; left alone ($file)"; continue }
    if ($PSCmdlet.ShouldProcess($file, 'Install git hook')) {
      Save-Backup $file
      [IO.File]::WriteAllText($file, $body)
      "hook: installed $h"
    }
  }
}
"Done. Backups (if any): $backup"
