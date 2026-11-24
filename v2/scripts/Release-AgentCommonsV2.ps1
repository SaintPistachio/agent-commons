#Requires -Version 7
<#
.SYNOPSIS
Tests and installs the checkout's HEAD into Agent Commons.

.DESCRIPTION
Run from the work branch's checkout (a linked worktree is fine). Steps, stopping at the first failure:
  1. Checks: v2/ is committed, HEAD is a fast-forward of main, and HEAD contains the live release (so another
     branch's installed work is never dropped; -AllowDroppingLive overrides).
  2. Tests: tsc and the v2 test suite. -SkipTests needs -SkipReason "...", which goes into the release checkpoint.
  3. Install-AgentCommonsV2.ps1 (database backup, release copy, `current` swap, graceful restart), then checks that
     `current` points at HEAD and /health answers.
  4. Fast-forwards main to HEAD in the main checkout (`git merge --ff-only`; never a merge commit or a reset).
  5. With -Push, pushes main and the work branch to origin without force.
  6. With an off-drive destination configured, copies the backups off the drive.
  7. With -Project and -Connection, records a checkpoint in the specified local project.
Use -WhatIf to preview or -NoMain to upgrade without promoting main.
Use -NoCloudBackup to make only the configured private off-drive copy.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
  [string]$SourceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string]$DataRoot,
  [ValidateRange(1, 65535)][int]$Port = 4727,
  [string]$Project,
  [string]$Task,
  [string]$Connection,
  [switch]$SkipTests,
  [string]$SkipReason,
  [switch]$NoMain,
  [switch]$Push,
  [switch]$NoPush,
  [switch]$NoCloudBackup,
  [switch]$AllowDroppingLive
)
$ErrorActionPreference = 'Stop'
if ($SkipTests -and -not "$SkipReason".Trim()) { throw '-SkipTests needs -SkipReason "why the tests are skipped"; the reason is recorded in the release checkpoint.' }
if ($SkipReason -and -not $SkipTests) { throw '-SkipReason is only used with -SkipTests.' }
if ($Push -and ($NoPush -or $NoMain)) { throw '-Push requires promotion of main and is incompatible with -NoPush.' }
if ([bool]$Project -ne [bool]$Connection -or ($Task -and -not $Project)) { throw 'Recording a checkpoint requires both -Project and -Connection.' }
. (Join-Path $PSScriptRoot 'automation\Ac-BackupCommon.ps1')
function Step([string]$text) { Write-Host "== $text" -ForegroundColor Cyan }
function Invoke-Git { param([Parameter(ValueFromRemainingArguments)][string[]]$GitArgs) & git @GitArgs; if ($LASTEXITCODE) { throw "git $($GitArgs -join ' ') failed ($LASTEXITCODE)" } }

$commit = (git -C $SourceRoot rev-parse HEAD).Trim()
$branch = (git -C $SourceRoot rev-parse --abbrev-ref HEAD).Trim()
$mainCheckout = Split-Path (git -C $SourceRoot rev-parse --path-format=absolute --git-common-dir).Trim() -Parent
$DataRoot = Resolve-AcDataRoot $PSScriptRoot $DataRoot
if (-not $PSCmdlet.ShouldProcess($DataRoot, "Install commit $commit")) { return }
$node = (Get-Command node.exe).Source
$done = @()

Step "1. Checks ($branch at $($commit.Substring(0, 8)))"
$dirty = git -C $SourceRoot status --porcelain -- v2
if ($LASTEXITCODE) { throw "git status failed ($LASTEXITCODE)" }
if ($dirty) { throw 'v2/ has uncommitted changes; commit them first.' }
if ($branch -eq 'HEAD') { throw 'HEAD is detached; release from a branch.' }
git -C $SourceRoot merge-base --is-ancestor main $commit
if ($LASTEXITCODE) { throw "main is not an ancestor of $branch; rebase or merge main into it first." }
# The live release must be contained in HEAD, or installing would silently drop work another branch installed.
$liveTarget = "$((Get-Item (Join-Path $dataRoot 'current') -ErrorAction SilentlyContinue).Target)"
$liveCommit = if ($liveTarget -match '([0-9a-f]{40})\\?$') { $Matches[1] } else { $null }
if ($liveCommit -and -not $AllowDroppingLive) {
  git -C $SourceRoot merge-base --is-ancestor $liveCommit $commit
  if ($LASTEXITCODE) { throw "the live release $($liveCommit.Substring(0, 8)) is not in $branch; merge it first (or pass -AllowDroppingLive)." }
}
# A linked worktree has no node_modules of its own (ignored by git): link the main checkout's, which the tests and
# the install script's release copy need.
$modules = Join-Path $SourceRoot 'node_modules'
if (-not (Test-Path $modules)) {
  $mainModules = Join-Path $mainCheckout 'node_modules'
  if (-not (Test-Path $mainModules)) { throw "no node_modules in $SourceRoot or $mainCheckout; run npm ci first." }
  New-Item -ItemType Junction -Path $modules -Target $mainModules | Out-Null
}

if (-not $SkipTests) {
  Step '2. Tests'
  Push-Location $SourceRoot
  try {
    & (Join-Path $SourceRoot 'node_modules\.bin\tsc.cmd') -p v2/tsconfig.json
    if ($LASTEXITCODE) { throw "tsc failed ($LASTEXITCODE)" }
    & $node --disable-warning=ExperimentalWarning (Join-Path $SourceRoot 'v2\scripts\check-invariants.ts')
    if ($LASTEXITCODE) { throw "v2 invariant checks failed ($LASTEXITCODE)" }
    & $node --disable-warning=ExperimentalWarning --test (Get-ChildItem v2/test -Filter '*.test.ts' | ForEach-Object FullName)
    if ($LASTEXITCODE) { throw "v2 tests failed ($LASTEXITCODE)" }
  } finally { Pop-Location }
  $done += 'tests passed'
} else { $done += "tests skipped ($($SkipReason.Trim()))" }

Step '3. Install into live Agent Commons'
& (Join-Path $PSScriptRoot 'Install-AgentCommonsV2.ps1') -SourceRoot $SourceRoot -DataRoot $DataRoot -Port $Port
$expected = [IO.Path]::GetFullPath((Join-Path $dataRoot "app\$commit")).TrimEnd('\')
$target = [IO.Path]::GetFullPath("$((Get-Item (Join-Path $dataRoot 'current')).Target)").TrimEnd('\')
if ($target -ne $expected) { throw "current points at $target, not $expected" }
$health = Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 5
$done += "installed (schema $($health.schema_version))"

if (-not $NoMain) {
  Step '4. Fast-forward main'
  $mainBranch = (git -C $mainCheckout rev-parse --abbrev-ref HEAD).Trim()
  if ($mainBranch -eq 'main') { Invoke-Git -C $mainCheckout merge --ff-only $commit }
  else { Invoke-Git -C $SourceRoot fetch . "${commit}:main" }  # main is not checked out: move the ref, fast-forward only
  if ((git -C $SourceRoot rev-parse main).Trim() -ne $commit) { throw "main is not at the tested commit $commit after the fast-forward" }
  $done += 'main fast-forwarded'
  if ($Push) {
    Step '5. Push main and the work branch'
    # Push the pinned, tested commit to explicit destinations: no '+', no configured push refspecs, no tags.
    foreach ($ref in @('main', $branch) | Select-Object -Unique) {
      $pushed = $false
      foreach ($delay in 0, 2, 4, 8, 16) {
        if ($delay) { Start-Sleep $delay }
        git -C $SourceRoot push --no-follow-tags origin "${commit}:refs/heads/$ref"
        if (-not $LASTEXITCODE) { $pushed = $true; break }
      }
      if (-not $pushed) { throw "push of $ref failed after retries" }
    }
    $done += 'pushed'
  }
}

$backupConfig = Read-AcBackupConfig $DataRoot
if ($backupConfig.offDriveDestination) {
  Step '6. Off-drive backup copy'
  & (Join-Path $PSScriptRoot 'automation\Backup-AcOffDrive.ps1') -DataRoot $DataRoot -NoFreshBackup -SkipCloud:$NoCloudBackup
  if ($LASTEXITCODE) { Write-Warning 'off-drive copy failed (see its log)'; $done += 'off-drive copy FAILED' } else { $done += 'backed up off-drive' }
}

if ($Project) {
  Step '7. Record in Agent Commons'
  $reportArgs = @((Join-Path $PSScriptRoot 'automation\ac-report.mjs'), '--home', $DataRoot, '--project', $Project,
    '--connection', $Connection, '--rev', $commit, '--br', $branch, '--summary', "Released $($commit.Substring(0, 8)) from ${branch}: $($done -join ', ').")
  if ($Task) { $reportArgs += @('--task', $Task) }
  & $node @reportArgs
  if ($LASTEXITCODE) { Write-Warning 'the Agent Commons checkpoint was not recorded' }
}
"Release complete: $($done -join ', ')"
