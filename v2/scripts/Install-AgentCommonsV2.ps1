#Requires -Version 7
<#
.SYNOPSIS
Installs the committed v2 source as a release and points <DataRoot>\current at it.

.DESCRIPTION
Copies v2/ at the checkout's HEAD into <DataRoot>\app\<commit>, with a copy of node_modules,
then swaps the `current` junction. Apps and the logon task use `current`, so an
upgrade needs no configuration changes. If the service is running, it is restarted
through the AgentCommonsV2 task unless -NoRestart is given. Data is never touched.
Reproducibility (goal g2): the Node version must satisfy package.json engines; each release gets a release.json
(commit, v2 tree hash, Node path and version, package-lock and node_modules lock hashes) that /health reports; and
the `current` swap goes through `current.next`, so an interrupted swap is finished by the next run.
DataRoot defaults to the folder beside the main checkout named <checkout>-data
Nothing is placed under the user profile.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
  [string]$SourceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string]$DataRoot,
  [switch]$NoRestart,
  [ValidateRange(1, 65535)][int]$Port = 4727,
  [string]$TaskName = 'AgentCommonsV2'
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'automation\Ac-BackupCommon.ps1')
$SourceRoot = (Resolve-Path -LiteralPath $SourceRoot).Path
if (-not $DataRoot) { $DataRoot = "$(Get-AcCheckout (Join-Path $SourceRoot 'v2'))-data" }
$home2 = Resolve-AcDataRoot $PSScriptRoot $DataRoot
Assert-AcNotOneDrive $home2
if ($env:USERPROFILE -and (Test-AcPathWithin $home2 $env:USERPROFILE)) { throw "DataRoot $home2 is under the user profile." }
$commit = (git -C $SourceRoot rev-parse HEAD).Trim()
if (git -C $SourceRoot status --porcelain -- v2) { throw 'v2/ has uncommitted changes; commit them first.' }
$app = Join-Path $home2 "app\$commit"
$current = Join-Path $home2 'current'
$next = Join-Path $home2 'current.next'

# PKG4: a swap interrupted after removing `current` left `current.next`; finish it before anything else.
if (-not (Test-Path $current) -and (Test-Path $next)) {
  Rename-Item -LiteralPath $next -NewName 'current'
  "recovered an interrupted swap: current -> $((Get-Item $current -Force).Target)"
}

# PKG3: the Node that runs the service must satisfy package.json engines (>=24.18.0 <25).
$node = (Get-Command node.exe).Source
$nodeVersion = (& $node --version).Trim().TrimStart('v')
$engines = (Get-Content -Raw (Join-Path $SourceRoot 'package.json') | ConvertFrom-Json).engines.node
$v = [version]$nodeVersion
if ($engines -match '>=\s*(\d+\.\d+\.\d+)' -and $v -lt [version]$Matches[1]) { throw "Node $nodeVersion at $node is older than package.json engines ($engines)" }
if ($engines -match '<\s*(\d+)' -and $v.Major -ge [int]$Matches[1]) { throw "Node $nodeVersion at $node is newer than package.json engines ($engines)" }

if (-not (Test-Path (Join-Path $app 'v2\src\cli.ts'))) {
  if ($PSCmdlet.ShouldProcess($app, 'Install release')) {
    $modules = Join-Path $SourceRoot 'node_modules'
    if (-not (Test-Path -LiteralPath $modules -PathType Container)) {
      if (-not (Test-Path -LiteralPath (Join-Path $SourceRoot 'package-lock.json') -PathType Leaf)) {
        throw 'node_modules is missing and there is no package-lock.json for npm ci'
      }
      $npm = (Get-Command npm.cmd -CommandType Application).Source
      Push-Location -LiteralPath $SourceRoot
      try {
        & $npm ci
        if ($LASTEXITCODE) { throw "npm ci failed ($LASTEXITCODE)" }
      } finally { Pop-Location }
    }
    $staging = "$app.staging"
    if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
    New-Item -ItemType Directory -Force $staging | Out-Null
    $tar = "$staging.tar"
    git -C $SourceRoot archive --format=tar -o $tar HEAD v2
    if ($LASTEXITCODE) { throw "git archive failed ($LASTEXITCODE)" }
    # Windows' own tar: Git's GNU tar (first on PATH under Git Bash) reads 'T:\...' as a remote host.
    $tarExe = if ($IsWindows) { Join-Path $env:SystemRoot 'System32\tar.exe' } else { 'tar' }
    & $tarExe -xf $tar -C $staging
    if ($LASTEXITCODE) { throw "release extraction failed ($LASTEXITCODE)" }
    Remove-Item $tar
    robocopy (Join-Path $SourceRoot 'node_modules') (Join-Path $staging 'node_modules') /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "node_modules copy failed (robocopy $LASTEXITCODE)" }
    if (-not (Test-Path (Join-Path $staging 'v2\src\cli.ts'))) { throw "release at $staging is incomplete" }
    # PKG1/PKG2: what this release is and which dependencies it carries.
    $sha = { param($file) if (Test-Path -LiteralPath $file) { (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() } else { $null } }
    $lockHash = & $sha (Join-Path $SourceRoot 'package-lock.json')
    $modulesHash = & $sha (Join-Path $staging 'node_modules\.package-lock.json')
    if (-not $modulesHash) { Write-Warning 'node_modules has no .package-lock.json; its dependency versions are unrecorded' }
    [ordered]@{
      commit = $commit; v2_tree = (git -C $SourceRoot rev-parse 'HEAD:v2').Trim(); installed_at = (Get-Date).ToUniversalTime().ToString('o')
      node = [ordered]@{ path = $node; version = $nodeVersion; engines = $engines }
      package_lock_sha256 = $lockHash; node_modules_lock_sha256 = $modulesHash
    } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $staging 'release.json') -Encoding utf8NoBOM
    Rename-Item $staging (Split-Path $app -Leaf)
  }
}

if ($PSCmdlet.ShouldProcess($current, "Point at $commit")) {
  # Build the new junction beside the old one, then swap: an interruption leaves `current.next`, which the next run
  # (or a manual rename) finishes; `current` is missing only between the two quick steps below.
  if (Test-Path $next) { [IO.Directory]::Delete($next) }
  New-Item -ItemType Junction -Path $next -Target $app | Out-Null
  if (Test-Path $current) {
    $item = Get-Item $current -Force
    if (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { [IO.Directory]::Delete($next); throw "$current exists and is not a junction" }
    [IO.Directory]::Delete($current)  # removes the junction only, never its target
  }
  Rename-Item -LiteralPath $next -NewName 'current'
  "current -> $commit"
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($NoRestart -or -not $task) { if (-not $task) { "Task $TaskName is not registered; run Register-AgentCommonsV2.ps1." }; return }
if ($PSCmdlet.ShouldProcess($TaskName, 'Restart service')) {
  $cli = Join-Path $app 'v2\src\cli.ts'
  # 1. Back up the database before the new release can migrate it (SQLite's online backup; safe while running).
  & $node --disable-warning=ExperimentalWarning $cli backup --home $home2 --keep 10
  if ($LASTEXITCODE) { throw "Backup failed ($LASTEXITCODE); the service was not restarted." }
  # 2. Ask the service to stop gracefully (it closes the database and records running jobs), then wait up to 5 s.
  $runtime = Join-Path $home2 'runtime.json'
  $servicePid = if (Test-Path $runtime) { (Get-Content $runtime -Raw | ConvertFrom-Json).pid } else { $null }
  & $node --disable-warning=ExperimentalWarning $cli stop --home $home2
  if ($servicePid) { foreach ($i in 1..10) { if (-not (Get-Process -Id $servicePid -ErrorAction SilentlyContinue)) { break }; Start-Sleep -Milliseconds 500 } }
  # 3. Only then end the task, and force-stop a service that did not exit (an older release has no graceful stop).
  Stop-ScheduledTask -TaskName $TaskName
  if ($servicePid) { Get-Process -Id $servicePid -ErrorAction SilentlyContinue | Where-Object ProcessName -eq 'node' | Stop-Process -Force }
  Start-Sleep 1
  & $node --disable-warning=ExperimentalWarning $cli rotate-log --home $home2
  Start-ScheduledTask -TaskName $TaskName
  foreach ($i in 1..20) {
    try { $health = Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 2; "Restarted: $($health.status) ($commit)"; return } catch { Start-Sleep 1 }
  }
  Write-Warning "No health response after restart; check $home2\logs\service.log"
}
