#Requires -Version 7
<#
.SYNOPSIS
Agent Commons health watchdog: checks the service, its scheduled tasks and the
off-drive backup, then tells AJ about problems with a Windows notification and a "! health" line in air_sync.

.DESCRIPTION
Run every 15 minutes and at logon by the AgentCommons-Watchdog scheduled task (Register-AcAutomation.ps1). Checks:
  service   GET <Url>/health answers "ready" within 5 seconds, and the AgentCommonsV2 task is running
  tasks     each AgentCommons-* task's last result is success (or still running), and the backup and tool sync
            tasks ran recently (26 hours and 2 hours); the date-check tasks only count once they have run
  backup    the newest automatic database backup in <Destination> is under 26 hours old
  cloud     when configured, the DPAPI key exists and a complete encrypted generation is under 26 hours old
  usage     every route's newest usage reading is under -UsageHours (24) old
  jobs      no Agent Commons job is waiting in needs_review (an uncertain outcome that needs a person)
  api-hold  no central API helper reservation has stayed unsettled for more than -HoldHours (read-only ledger read;
            the watchdog never writes the helper's ledger or settles anything itself)
Writes <DataRoot>\health.json ({checked_at, problems:[{id,text,since,notified_at}]}), which the service reads for
air_sync. A Windows notification goes out for each new problem, again every 6 hours while it lasts, and once when
everything is clear again. The notification uses Windows PowerShell 5.1 because PowerShell 7 cannot load the
Windows toast API. -NoToast skips notifications (tests and dry runs).
#>
[CmdletBinding()]
param(
  [string]$DataRoot,
  [string]$Destination,
  [string]$CloudDestination,
  [string]$Url = 'http://127.0.0.1:4727',
  [string]$HelperLedger,
  [ValidateRange(1, 168)][int]$HoldHours = 1,
  [ValidateRange(1, 720)][int]$UsageHours = 24,
  [switch]$NoToast,
  [int]$RepeatHours = 6
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Ac-BackupCommon.ps1')
$DataRoot = Resolve-AcDataRoot $PSScriptRoot $DataRoot
$now = Get-Date
$stateFile = Join-Path $DataRoot 'health.json'
$found = [ordered]@{}
function Add-Problem([string]$id, [string]$text) { $found[$id] = $text }
try {
  $config = Read-AcBackupConfig $DataRoot
  $Destination = Get-AcBackupPath $config 'offDriveDestination' $Destination '' $DataRoot
  $CloudDestination = Get-AcBackupPath $config 'cloudDestination' $CloudDestination '' $DataRoot
  $node = (Get-Command node.exe).Source
  $cli = Join-Path $DataRoot 'current\v2\src\cli.ts'
  $selection = Get-AcHelperSelection $node $cli $DataRoot
  $expectHelperLedger = $selection.configured -or $HelperLedger -or $config['helperLedger']
  $HelperLedger = Get-AcBackupPath $config 'helperLedger' $HelperLedger (Join-Path $selection.root '.local\usage.sqlite3') $DataRoot
  if ($expectHelperLedger -and -not (Test-Path -LiteralPath $HelperLedger -PathType Leaf)) {
    Add-Problem 'api-ledger-missing' "Configured API helper ledger is missing: $HelperLedger"
  }
} catch {
  Add-Problem 'backup-config' "Could not read backup settings: $($_.Exception.Message)"
}

# Service
try {
  $health = Invoke-RestMethod "$Url/health" -TimeoutSec 5
  if ($health.status -ne 'ready') { Add-Problem 'service' "/health answered status '$($health.status)'" }
  # Stuck jobs: an uncertain outcome waits for a person (never replayed), so say so instead of letting it sit.
  if ([int]$health.needs_review_jobs -gt 0) { Add-Problem 'needs-review' "$($health.needs_review_jobs) job(s) need review; check each with its platform, then node v2/src/cli.ts job-settle" }
} catch { Add-Problem 'service' "the service did not answer /health ($($_.Exception.Message))" }

# Usage readings: a route whose newest reading is over -UsageHours old routes on stale numbers (Claude and Codex
# readings change only when someone enters them or a job reports back). Read-only.
$usageQuery = @'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1], { readOnly: true, timeout: 5000 });
const cutoff = Date.now() - Number(process.argv[2]) * 3600000;
const rows = db.prepare('SELECT route, max(observed_at) at FROM usage_windows GROUP BY route').all()
  .filter(r => Date.parse(r.at) < cutoff);
console.log(JSON.stringify(rows));
'@
$commonsDb = Join-Path $DataRoot 'commons.sqlite'
if (Test-Path -LiteralPath $commonsDb) {
  try {
    $staleUsage = & (Get-Command node.exe).Source --disable-warning=ExperimentalWarning -e $usageQuery $commonsDb $UsageHours | ConvertFrom-Json
    if ($LASTEXITCODE) { throw "exit $LASTEXITCODE" }
    if (@($staleUsage).Count) {
      Add-Problem 'usage-stale' ("usage readings older than {0} h: {1}; update them (cli.ts usage-set) so routing uses current numbers" -f $UsageHours, ((@($staleUsage) | ForEach-Object { "$($_.route) since $(([datetime]::Parse($_.at, [Globalization.CultureInfo]::InvariantCulture)).ToLocalTime().ToString('g'))" }) -join ', '))
    }
  } catch { Add-Problem 'usage-stale' "could not read usage readings ($($_.Exception.Message))" }
}

# Central API helper: a reservation left unsettled holds funds and a slot until someone reconciles it. Read-only.
if ($HelperLedger -and (Test-Path -LiteralPath $HelperLedger)) {
  $query = @'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1], { readOnly: true, timeout: 5000 });
const cutoff = new Date(Date.now() - Number(process.argv[2]) * 3600000).toISOString();
const rows = db.prepare('SELECT job_id, status, reservation_microusd, updated_at FROM jobs WHERE actual_microusd IS NULL').all()
  .filter(r => Date.parse(r.updated_at) < Date.parse(cutoff));
console.log(JSON.stringify(rows));
'@
  try {
    $stuck = & (Get-Command node.exe).Source --disable-warning=ExperimentalWarning -e $query $HelperLedger $HoldHours | ConvertFrom-Json
    if ($LASTEXITCODE) { throw "exit $LASTEXITCODE" }
    if (@($stuck).Count) {
      $usd = (@($stuck) | Measure-Object reservation_microusd -Sum).Sum / 1e6
      Add-Problem 'api-hold' ("{0} API helper reservation(s) unsettled for over {1} h (`${2:N2} held: {3}); reconcile or write off with the operator's approval" -f @($stuck).Count, $HoldHours, $usd, ((@($stuck) | ForEach-Object { "$($_.job_id.Substring(0, 8)) $($_.status)" }) -join ', '))
    }
  } catch { Add-Problem 'api-hold' "could not read the API helper ledger ($($_.Exception.Message))" }
}
$serviceTask = Get-ScheduledTask -TaskName 'AgentCommonsV2' -ErrorAction SilentlyContinue
if (-not $serviceTask) { Add-Problem 'service-task' 'the AgentCommonsV2 scheduled task is missing' }
elseif ($serviceTask.State -ne 'Running') { Add-Problem 'service-task' "the AgentCommonsV2 task is $($serviceTask.State), not running" }

# Previous state: each problem's first-seen time and last notification, and when a never-run task was first seen.
$previous = @{}; $firstSeen = @{}
if (Test-Path -LiteralPath $stateFile) {
  try {
    $old = Get-Content -Raw -LiteralPath $stateFile | ConvertFrom-Json -DateKind String
    foreach ($p in @($old.problems)) { if ($p.id) { $previous[$p.id] = $p } }
    if ($old.never_run_seen) { foreach ($n in $old.never_run_seen.PSObject.Properties) { $firstSeen[$n.Name] = $n.Value } }
  } catch { }
}
$parseUtc = { param($s) [datetime]::Parse($s, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AdjustToUniversal) }
$neverRun = [ordered]@{}

# Scheduled tasks. 0 = success, 0x41301 (267009) = running, 0x41303 (267011) = has not run yet.
$maxAge = @{}
if ($Destination) { $maxAge['AgentCommons-OffDriveBackup'] = 26 }
foreach ($name in $maxAge.Keys) {
  $t = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if (-not $t) { Add-Problem "missing-$($name -replace '^AgentCommons-', '')" "the $name scheduled task is missing" }
  elseif ($t.State -eq 'Disabled') { Add-Problem "disabled-$($name -replace '^AgentCommons-', '')" "the $name scheduled task is disabled" }
}
foreach ($task in Get-ScheduledTask -TaskName 'AgentCommons-*' -ErrorAction SilentlyContinue) {
  if ($task.TaskName -notmatch '^AgentCommons-[A-Za-z]' -or $task.TaskName -eq 'AgentCommons-Watchdog' -or $task.State -eq 'Disabled') { continue }
  $info = $task | Get-ScheduledTaskInfo
  $ran = $info.LastRunTime -and $info.LastRunTime.Year -gt 2001
  $short = $task.TaskName -replace '^AgentCommons-', ''
  if ($ran -and $info.LastTaskResult -notin 0, 267009, 267011) {
    Add-Problem "task-$short" ("{0} last run failed with result 0x{1:X} at {2:g}" -f $short, $info.LastTaskResult, $info.LastRunTime)
  }
  if ($maxAge.ContainsKey($task.TaskName)) {
    $limit = $maxAge[$task.TaskName]
    if (-not $ran) {
      # Registration resets the run history, so count from when the watchdog first saw it unrun.
      $seen = if ($firstSeen[$task.TaskName]) { & $parseUtc $firstSeen[$task.TaskName] } else { $now.ToUniversalTime() }
      $neverRun[$task.TaskName] = $seen.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
      if ($seen -lt $now.ToUniversalTime().AddHours(-$limit)) { Add-Problem "stale-$short" "$short has not run since it was registered" }
    }
    elseif ($info.LastRunTime -lt $now.AddHours(-$limit)) { Add-Problem "stale-$short" ("{0} has not run since {1:g}" -f $short, $info.LastRunTime) }
  }
}

# Backup ages are independent of the task's exit code. Checking cloud age never reads the key.
if ($Destination) {
  try {
    if (-not [IO.Directory]::Exists($Destination)) { Add-Problem 'backup' "the backup folder $Destination is missing" }
    else {
      $newest = Get-AcAutomaticDatabases $Destination | Select-Object -First 1
      if (-not $newest) { Add-Problem 'backup' "no automatic database backup in $Destination" }
      elseif ($newest.LastWriteTimeUtc -lt $now.ToUniversalTime().AddHours(-26)) { Add-Problem 'backup' ("the newest database backup is from {0:g}" -f $newest.LastWriteTime) }
    }
  } catch { Add-Problem 'backup' "Could not inspect off-drive backups: $($_.Exception.Message)" }
}
if ($CloudDestination) {
  try {
    $recoveryKeyFile = Get-AcRecoveryKeyFile $config $DataRoot $CloudDestination
    $archiveMode = Get-AcCloudArchiveMode $config
    $cloudProblem = Get-AcCloudBackupProblem $CloudDestination (Get-AcCloudKeyPath $DataRoot) $now $recoveryKeyFile $archiveMode
    if ($cloudProblem) { Add-Problem 'cloud-backup' $cloudProblem }
  } catch { Add-Problem 'cloud-backup' "Could not inspect cloud backups: $($_.Exception.Message)" }
}

$iso = { param($d) $d.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') }
$problems = @(); $notify = @()
foreach ($id in $found.Keys) {
  $old = $previous[$id]
  $since = if ($old.since) { $old.since } else { & $iso $now }
  $notified = $old.notified_at
  $due = -not $notified -or ((& $parseUtc $notified) -lt $now.ToUniversalTime().AddHours(-$RepeatHours))
  if ($due) { $notify += $id }
  $problems += [ordered]@{ id = $id; text = $found[$id]; since = $since; notified_at = $notified }
}
$cleared = $previous.Count -gt 0 -and $found.Count -eq 0

function Send-Toast([string]$title, [string]$body) {
  if ($NoToast) { return $false }
  $esc = { param($s) [Security.SecurityElement]::Escape($s) }
  $xml = "<toast><visual><binding template='ToastGeneric'><text>$(& $esc $title)</text><text>$(& $esc $body)</text></binding></visual></toast>"
  $script = @"
`$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
`$null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
`$doc = New-Object Windows.Data.Xml.Dom.XmlDocument
`$doc.LoadXml([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($xml)))')))
`$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(`$app).Show([Windows.UI.Notifications.ToastNotification]::new(`$doc))
"@
  try {
    & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -EncodedCommand ([Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))) | Out-Null
    if ($LASTEXITCODE) { Write-Warning "notification failed (exit $LASTEXITCODE)"; return $false }
    return $true
  } catch { Write-Warning "notification failed: $($_.Exception.Message)"; return $false }
}

# Notify first; a problem counts as notified only when the notification was actually shown.
if ($notify) {
  if (Send-Toast "Agent Commons needs attention ($($found.Count))" (($notify | ForEach-Object { $found[$_] }) -join "`n")) {
    foreach ($p in $problems) { if ($p.id -in $notify) { $p.notified_at = & $iso $now } }
  }
} elseif ($cleared) { $null = Send-Toast 'Agent Commons is healthy again' 'Every watchdog check passed.' }

$state = [ordered]@{ checked_at = & $iso $now; problems = $problems; never_run_seen = $neverRun }
$tmp = "$stateFile.tmp"
$state | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $tmp -Encoding utf8NoBOM
Move-Item -LiteralPath $tmp -Destination $stateFile -Force
"$((Get-Date).ToString('s')) problems=$($found.Count)$(if ($found.Count) { ': ' + ($found.Values -join ' | ') })"
exit 0
