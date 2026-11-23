#Requires -Version 7
<#
.SYNOPSIS
Initializes Agent Commons or restores an encrypted bundle on a new Windows PC.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
  [string]$BundlePath,
  [switch]$Fresh,
  [string]$DataRoot,
  [ValidateRange(1, 65535)][int]$Port = 4727,
  [switch]$RegisterTasks,
  [switch]$SkipVenv,
  [string]$PassphraseEnvVar,
  [string]$RecoveryKeyFile
)

$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Bootstrap requires Windows and PowerShell 7 or newer' }
if ([bool]$BundlePath -eq [bool]$Fresh) { throw 'Specify exactly one of -BundlePath and -Fresh' }
if ($Fresh -and ($PassphraseEnvVar -or $RecoveryKeyFile)) { throw 'Backup credentials require -BundlePath' }
if ($PassphraseEnvVar -and $RecoveryKeyFile) { throw 'Select one backup credential' }

. (Join-Path $PSScriptRoot 'automation\Ac-BackupCommon.ps1')
$sourceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
if (-not $DataRoot) { $DataRoot = Join-Path $env:LOCALAPPDATA 'AgentCommons-data' }
$DataRoot = Resolve-AcDataRoot $PSScriptRoot $DataRoot
Assert-AcNotOneDrive $sourceRoot
Assert-AcLocalDataPath $DataRoot
Assert-AcSeparatePaths $sourceRoot $DataRoot
if (Test-Path -LiteralPath (Join-Path $DataRoot 'commons.sqlite')) { throw "A database already exists at $DataRoot; use a new home" }
if ([IO.Directory]::Exists($DataRoot)) {
  if (Get-ChildItem -LiteralPath $DataRoot -Force | Select-Object -First 1) { throw "Choose an unused data directory: $DataRoot" }
  Assert-AcPrivateDirectory $DataRoot
}
if ($BundlePath) { $BundlePath = (Resolve-Path -LiteralPath $BundlePath).Path }
$standardArchive = $BundlePath -like '*.acbak.tar.gz'
if ($standardArchive -and ($RecoveryKeyFile -or $PassphraseEnvVar)) { throw 'A standard backup does not use backup credentials' }
if ($RecoveryKeyFile) {
  $RecoveryKeyFile = (Resolve-Path -LiteralPath $RecoveryKeyFile).Path
  Assert-AcNotOneDrive $RecoveryKeyFile
}

if (-not $PSCmdlet.ShouldProcess($DataRoot, 'Initialize or restore Agent Commons')) { return }

$cli = Join-Path $sourceRoot 'v2\src\cli.ts'
$helper = Join-Path $sourceRoot 'tools\openai-capabilities'
$venv = Join-Path $helper '.venv'
$pythonInVenv = Join-Path $venv 'Scripts\python.exe'
$baseUrl = "http://127.0.0.1:$Port"
$register = Join-Path $PSScriptRoot 'Register-AgentCommonsV2.ps1'
$secret = $entered = $null
try {
  if ($PassphraseEnvVar) {
    $value = [Environment]::GetEnvironmentVariable($PassphraseEnvVar, 'Process')
    try {
      # Consume the test variable before launching any child, including npm or pip.
      [Environment]::SetEnvironmentVariable($PassphraseEnvVar, $null, 'Process')
      if ([string]::IsNullOrEmpty($value) -or $value -match '[\x00\r\n]') { throw 'The test passphrase variable must contain one nonempty line' }
      $secret = [Text.UTF8Encoding]::new($false, $true).GetBytes($value)
    } finally { $value = $null }
  }

  $node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
  $git = (Get-Command git.exe -CommandType Application | Select-Object -First 1).Source
  $engines = (Get-Content -Raw -LiteralPath (Join-Path $sourceRoot 'package.json') | ConvertFrom-Json).engines.node
  $versionText = & $node --version
  if ($LASTEXITCODE -or $versionText -notmatch '^v(\d+\.\d+\.\d+)$') { throw "Cannot determine a supported Node version: $versionText" }
  $version = [version]$Matches[1]
  if ($engines -notmatch '^\s*>=\s*(\d+\.\d+\.\d+)\s+<\s*(\d+)(?:\.0\.0)?\s*$') { throw "Unsupported Node engine expression: $engines" }
  if ($version -lt [version]$Matches[1] -or $version.Major -ge [int]$Matches[2]) { throw "Node $version does not satisfy $engines" }
  & $git --version | Out-Null
  if ($LASTEXITCODE) { throw 'git is not working' }
  if (-not [IO.Directory]::Exists($helper)) { throw "The consolidated helper is missing: $helper" }

  if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot 'node_modules') -PathType Container)) {
    $npm = (Get-Command npm.cmd -CommandType Application | Select-Object -First 1).Source
    Push-Location -LiteralPath $sourceRoot
    try {
      & $npm ci
      if ($LASTEXITCODE) { throw "npm ci failed ($LASTEXITCODE)" }
    } finally { Pop-Location }
  }
  if (-not $SkipVenv) {
    $python = (Get-Command python.exe -CommandType Application | Select-Object -First 1).Source
    & $python -m venv $venv
    if ($LASTEXITCODE) { throw "Python venv creation failed ($LASTEXITCODE)" }
    & $pythonInVenv -m pip install --require-hashes -r (Join-Path $helper 'requirements.lock')
    if ($LASTEXITCODE) { throw "Helper requirements install failed ($LASTEXITCODE)" }
  }

  if ($standardArchive -or ($BundlePath -and $RecoveryKeyFile)) {
    $archiveMode = if ($standardArchive) { 'standard' } else { 'encrypted' }
    $restoreArgs = @('--disable-warning=ExperimentalWarning', $cli, 'bundle-restore',
      '--home', $DataRoot, '--source', $BundlePath, '--helper-root', $helper)
    Invoke-AcCloudBundleCli $node $restoreArgs '' $RecoveryKeyFile $archiveMode
  } elseif ($BundlePath) {
    if (-not $PassphraseEnvVar) {
      $entered = Read-Host 'Passphrase for the encrypted recovery bundle' -AsSecureString
      $secret = Get-AcSecureUtf8 $entered
    }
    try {
      Invoke-AcSecretCli $node @('--disable-warning=ExperimentalWarning', $cli, 'bundle-restore',
        '--home', $DataRoot, '--source', $BundlePath, '--helper-root', $helper, '--passphrase-stdin') $secret
    } finally {
      if ($secret) { [Array]::Clear($secret, 0, $secret.Length); $secret = $null }
      if ($entered) { $entered.Dispose(); $entered = $null }
    }
  } else {
    if (-not [IO.Directory]::Exists($DataRoot)) { Set-AcPrivateDirectory $DataRoot -Create }
    & $node --disable-warning=ExperimentalWarning $cli init --home $DataRoot --port $Port | Out-Null
    if ($LASTEXITCODE) { throw "Agent Commons init failed ($LASTEXITCODE)" }
  }

  # Seed the private policy only when this checkout has no local policy.
  $policy = Join-Path $helper 'policy.json'
  if (-not [IO.File]::Exists($policy)) {
    [IO.File]::Copy((Join-Path $helper 'policy.example.json'), $policy, $false)
  }

  # Record this checkout's helper path even with a custom data-home name.
  $configPath = Join-Path $DataRoot 'backup-config.json'
  $config = Read-AcBackupConfig $DataRoot
  $config['openaiHelperRoot'] = $helper
  if ($BundlePath) {
    # Backup destinations and ledger overrides belong to the original machine.
    foreach ($key in 'offDriveDestination', 'cloudDestination', 'cloudArchiveMode', 'cloudRecoveryKeyFile', 'scratchRoot', 'helperLedger') {
      $config.Remove($key) | Out-Null
    }
  }
  $configTmp = "$configPath.$([guid]::NewGuid().ToString('N')).tmp"
  try {
    $config | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $configTmp -Encoding utf8NoBOM
    [IO.File]::Move($configTmp, $configPath, $true)
  } finally {
    if ([IO.File]::Exists($configTmp)) { [IO.File]::Delete($configTmp) }
  }
  $connections = Join-Path $DataRoot 'connections'
  if (-not [IO.Directory]::Exists($connections)) { Set-AcPrivateDirectory $connections -Create }
  & (Join-Path $PSScriptRoot 'automation\Lock-AcData.ps1') -DataRoot $DataRoot -HomeOnly

  if (Test-Path -LiteralPath (Join-Path $helper '.local\secrets') -PathType Container) {
    $initializer = Join-Path $helper 'Initialize-PrivateStorage.ps1'
    if (-not (Test-Path -LiteralPath $initializer -PathType Leaf)) { throw '.local\secrets exists but Initialize-PrivateStorage.ps1 was not found' }
    $mySid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $initHash = (Get-FileHash -LiteralPath $initializer -Algorithm SHA256).Hash
    & $initializer -WorkspaceRoot $sourceRoot -ExpectedUserSid $mySid -ExpectedSourceSha256 $initHash -Apply
    if ($LASTEXITCODE) { throw "Initialize-PrivateStorage.ps1 failed ($LASTEXITCODE)" }
  }

  $installArgs = @{ SourceRoot = $sourceRoot; DataRoot = $DataRoot; Port = $Port; NoRestart = $true }
  & (Join-Path $PSScriptRoot 'Install-AgentCommonsV2.ps1') @installArgs

  & $node --disable-warning=ExperimentalWarning $cli rotate-client --all --home $DataRoot --url $baseUrl | Out-Null
  if ($LASTEXITCODE) { throw "Client token rotation failed ($LASTEXITCODE)" }

  if ($RegisterTasks) {
    # Rotated connections are already in place before any scheduled service starts.
    $automationArgs = @{ DataRoot = $DataRoot; MainCheckout = $sourceRoot; Port = $Port; Only = @('Scheduler', 'Tasks', 'GitHooks') }
    & (Join-Path $PSScriptRoot 'automation\Register-AcAutomation.ps1') @automationArgs
    & $register -DataRoot $DataRoot -Port $Port
  }
} finally {
  if ($secret) { [Array]::Clear($secret, 0, $secret.Length) }
  if ($entered) { $entered.Dispose() }
}

$installed = Join-Path $DataRoot 'current\v2'
$mcp = @{
  command = $node
  args = @('--disable-warning=ExperimentalWarning', (Join-Path $installed 'src\mcp.ts'),
    '--connection', (Join-Path $DataRoot 'connections\<app>.json'))
}
@"
Bootstrap complete. Finish these steps:
1. Enter OpenAI keys with the consolidated helper's setup_credentials.py (use '$pythonInVenv' if created).
2. Review '$DataRoot\backup-config.json' for this PC, run Lock-AcData.ps1 after changing the off-drive path,
   then configure the recovery key or run '$installed\scripts\automation\Set-AcBackupPassphrase.ps1'.
3. Add this stdio MCP entry to each app, replacing <app> with its connection filename.
   For a fresh home, create participant connections first with cli.ts add-client --home <DataRoot> --port $Port --name <app> --profile air.
$($mcp | ConvertTo-Json -Depth 4)
4. Check the service at ${baseUrl}:
   node "$installed\src\cli.ts" status --home "$DataRoot"
   node "$installed\src\cli.ts" probe --home "$DataRoot"
Without -RegisterTasks, start it manually first:
   node "$installed\src\cli.ts" serve --home "$DataRoot" --port $Port
"@
