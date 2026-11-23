# Shared path, backup-generation and secret-input helpers. Dot-source; no work runs on import.
function Get-AcV2Directory([string]$ScriptRoot) {
  $dir = [IO.DirectoryInfo]::new($ScriptRoot)
  while ($dir -and $dir.Name -ne 'v2') { $dir = $dir.Parent }
  if (-not $dir) { throw "Cannot locate v2 above $ScriptRoot" }
  $dir
}

function Get-AcInstalledHome([string]$ScriptRoot) {
  $release = (Get-AcV2Directory $ScriptRoot).Parent
  if ($release.Name -eq 'current') { return $release.Parent.FullName }
  if ($release.Name -match '^[0-9a-f]{40,64}$' -and $release.Parent.Name -eq 'app') {
    return $release.Parent.Parent.FullName
  }
}

function Get-AcCheckout([string]$ScriptRoot) {
  $homePath = Get-AcInstalledHome $ScriptRoot
  if ($homePath) {
    $dir = [IO.DirectoryInfo]::new($homePath)
    return [IO.Path]::Combine($dir.Parent.FullName, ($dir.Name -replace '-data$', ''))
  }
  $checkout = (Get-AcV2Directory $ScriptRoot).Parent.FullName
  if (Get-Command git -ErrorAction SilentlyContinue) {
    $common = git -C $checkout rev-parse --path-format=absolute --git-common-dir 2>$null
    if ($LASTEXITCODE -eq 0 -and $common -and (Split-Path $common -Leaf) -eq '.git') {
      return (Split-Path $common -Parent)
    }
  }
  $checkout
}

function Resolve-AcDataRoot([string]$ScriptRoot, [string]$DataRoot) {
  if ($DataRoot) { return $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($DataRoot) }
  $installed = Get-AcInstalledHome $ScriptRoot
  if ($installed) { return $installed }
  "$(Get-AcCheckout $ScriptRoot)-data"
}

function Read-AcBackupConfig([string]$DataRoot) {
  $path = [IO.Path]::Combine($DataRoot, 'backup-config.json')
  if (-not (Test-Path -LiteralPath $path)) { return @{} }
  $config = Get-Content -Raw -LiteralPath $path | ConvertFrom-Json -AsHashtable
  if ($config -isnot [Collections.IDictionary]) { throw "$path must contain a JSON object" }
  $config
}

function Get-AcBackupPath($Config, [string]$Key, [string]$Override, [string]$Default, [string]$DataRoot) {
  if ($Override) { return $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Override) }
  $value = $Config[$Key]
  if ($null -eq $value) { return $Default }
  if ($value -isnot [string] -or [string]::IsNullOrWhiteSpace($value)) { throw "$Key must be a nonempty path" }
  [IO.Path]::GetFullPath($value, $DataRoot)
}

function Get-AcHelperSelection([string]$Node, [string]$Cli, [string]$DataRoot) {
  $reply = & $Node --disable-warning=ExperimentalWarning $Cli helper-root --home $DataRoot
  if ($LASTEXITCODE) { throw "Could not resolve the API helper root (exit $LASTEXITCODE)" }
  $reply | ConvertFrom-Json -ErrorAction Stop
}

function Resolve-AcPhysicalPath([string]$Path) {
  $full = [IO.Path]::GetFullPath($Path)
  $root = [IO.Path]::GetPathRoot($full)
  $resolved = $root
  foreach ($part in ($full.Substring($root.Length) -split '[\\/]')) {
    if (-not $part) { continue }
    $resolved = [IO.Path]::Combine($resolved, $part)
    $item = Get-Item -LiteralPath $resolved -Force -ErrorAction SilentlyContinue
    if ($item -and $item.LinkType -in 'Junction', 'SymbolicLink') {
      $target = $item.ResolveLinkTarget($true)
      if (-not $target) { throw "Cannot resolve $resolved" }
      $resolved = $target.FullName
    }
  }
  $resolved
}

function Test-AcPathWithin([string]$Path, [string]$Root) {
  $pathName = [IO.Path]::TrimEndingDirectorySeparator((Resolve-AcPhysicalPath $Path))
  $rootName = [IO.Path]::TrimEndingDirectorySeparator((Resolve-AcPhysicalPath $Root))
  $prefix = if ([IO.Path]::EndsInDirectorySeparator($rootName)) { $rootName } else { $rootName + [IO.Path]::DirectorySeparatorChar }
  $pathName -ieq $rootName -or $pathName.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
}

function Assert-AcSeparatePaths([string]$First, [string]$Second) {
  if ($First -and $Second -and ((Test-AcPathWithin $First $Second) -or (Test-AcPathWithin $Second $First))) {
    throw "Paths overlap: $First and $Second"
  }
}

function Assert-AcNotOneDrive([string]$Path) {
  foreach ($name in @([IO.Path]::GetFullPath($Path), (Resolve-AcPhysicalPath $Path))) {
    if ($name -match '(?i)(^|[\\/])OneDrive(?: - [^\\/]+)?(?:[\\/]|$)') {
      throw "This path must not be in OneDrive: $Path"
    }
  }
  foreach ($root in @($env:OneDrive, $env:OneDriveConsumer, $env:OneDriveCommercial)) {
    if ($root -and (Test-AcPathWithin $Path $root)) { throw "This path must not be in OneDrive: $Path" }
  }
}

function Assert-AcLocalDataPath([string]$Path) {
  Assert-AcNotOneDrive $Path
  $physical = Resolve-AcPhysicalPath $Path
  if ($physical -notmatch '^[A-Za-z]:\\' -or [IO.DriveInfo]::new([IO.Path]::GetPathRoot($physical)).DriveType -ne [IO.DriveType]::Fixed) {
    throw 'Choose a private data directory on a local fixed drive.'
  }
}

function Get-AcLocalTempRoot {
  if ($env:CODEX_TEMP_ROOT) { return $env:CODEX_TEMP_ROOT }
  [IO.Path]::GetTempPath()
}

function Set-AcPrivateDirectory([string]$Path, [switch]$Create) {
  $acl = [Security.AccessControl.DirectorySecurity]::new()
  $acl.SetAccessRuleProtection($true, $false)
  $me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  foreach ($sid in $me, 'S-1-5-18') {
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
      [Security.Principal.SecurityIdentifier]::new($sid), 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow'))
  }
  $dir = [IO.DirectoryInfo]::new($Path)
  if ($Create) {
    [void][IO.Directory]::CreateDirectory($dir.Parent.FullName)
    [IO.FileSystemAclExtensions]::Create($dir, $acl)
  } else {
    [IO.FileSystemAclExtensions]::SetAccessControl($dir, $acl)
  }
}

function Assert-AcPrivateDirectory([string]$Path) {
  $me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $acl = Get-Acl -LiteralPath $Path
  $others = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object {
    $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -notin $me, 'S-1-5-18'
  })
  if (-not $acl.AreAccessRulesProtected -or $others.Count) {
    throw "$Path is not private. Run Lock-AcData.ps1 for this backup destination before copying data."
  }
}

function Get-AcCloudKeyPath([string]$DataRoot) {
  [IO.Path]::Combine($DataRoot, 'backups', 'cloud-key.dpapi')
}

function Get-AcCloudArchiveMode($Config) {
  $mode = $Config['cloudArchiveMode']
  if ($null -eq $mode) { return 'encrypted' }
  if ($mode -cnotin @('standard', 'encrypted')) { throw 'cloudArchiveMode must be standard or encrypted' }
  if ($mode -eq 'standard' -and $Config['cloudRecoveryKeyFile']) { throw 'A standard cloud archive cannot use a recovery key' }
  $mode
}

function Get-AcRecoveryKeyFile($Config, [string]$DataRoot, [string]$CloudDestination) {
  $path = Get-AcBackupPath $Config 'cloudRecoveryKeyFile' '' '' $DataRoot
  if (-not $path) { return }
  Assert-AcNotOneDrive $path
  Assert-AcSeparatePaths $path $DataRoot
  Assert-AcSeparatePaths $path $CloudDestination
  $path
}

function Invoke-AcCloudBundleCli([string]$Node, [string[]]$CliArgs, [string]$KeyPath, [string]$RecoveryKeyFile, [string]$ArchiveMode = 'encrypted') {
  if ($ArchiveMode -eq 'standard') {
    & $Node @CliArgs --standard-archive
    if ($LASTEXITCODE) { throw "cli.ts bundle command failed (exit $LASTEXITCODE)" }
    return
  }
  if ($RecoveryKeyFile) {
    Assert-AcNotOneDrive $RecoveryKeyFile
    Assert-AcPrivateDirectory (Split-Path -Path $RecoveryKeyFile -Parent)
    & $Node @CliArgs --recovery-key $RecoveryKeyFile
    if ($LASTEXITCODE) { throw "cli.ts bundle command failed (exit $LASTEXITCODE)" }
    return
  }
  $secret = Read-AcCloudKey $KeyPath
  try { Invoke-AcSecretCli $Node ($CliArgs + '--passphrase-stdin') $secret }
  finally { [Array]::Clear($secret, 0, $secret.Length) }
}

function Get-AcSecureUtf8([Security.SecureString]$Secret) {
  $ptr = [IntPtr]::Zero
  $chars = [char[]]::new($Secret.Length)
  try {
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secret)
    [Runtime.InteropServices.Marshal]::Copy($ptr, $chars, 0, $chars.Length)
    if ([char]0 -in $chars -or [char]10 -in $chars -or [char]13 -in $chars) { throw 'Use a single-line passphrase without NUL characters' }
    return ,([Text.UTF8Encoding]::new($false, $true).GetBytes($chars))
  } finally {
    [Array]::Clear($chars, 0, $chars.Length)
    if ($ptr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
  }
}

function Initialize-AcDpapi {
  if (-not ('System.Security.Cryptography.ProtectedData' -as [type])) {
    Add-Type -AssemblyName System.Security.Cryptography.ProtectedData
  }
}

function Read-AcCloudKey([string]$Path) {
  Initialize-AcDpapi
  $protected = [IO.File]::ReadAllBytes($Path)
  try {
    return ,([System.Security.Cryptography.ProtectedData]::Unprotect($protected, $null, 'CurrentUser'))
  } finally {
    [Array]::Clear($protected, 0, $protected.Length)
  }
}

function Invoke-AcSecretCli([string]$Node, [string[]]$CliArgs, [byte[]]$Secret) {
  $info = [Diagnostics.ProcessStartInfo]::new($Node)
  $info.UseShellExecute = $false
  $info.RedirectStandardInput = $true
  $info.StandardInputEncoding = [Text.UTF8Encoding]::new($false)
  $info.WorkingDirectory = (Get-Location).ProviderPath
  foreach ($arg in $CliArgs) { $info.ArgumentList.Add($arg) }
  $proc = [Diagnostics.Process]::Start($info)
  try {
    $writeError = $null
    try { $proc.StandardInput.BaseStream.Write($Secret, 0, $Secret.Length) }
    catch { $writeError = $_ }
    finally { $proc.StandardInput.Close() }
    $proc.WaitForExit()
    if ($proc.ExitCode) { throw "cli.ts bundle command failed (exit $($proc.ExitCode))" }
    if ($writeError) { throw $writeError }
  } finally {
    $proc.Dispose()
  }
}

function Get-AcAutomaticDatabases([string]$Folder) {
  Get-ChildItem -LiteralPath $Folder -File -Filter 'commons-*.sqlite' | Where-Object {
    $_.Name -match '^commons-(\d{8}T\d{9}Z|\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.sqlite$' -and
      -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint)
  } | Sort-Object LastWriteTimeUtc, Name -Descending
}

function Get-AcBundleSidecars([string]$Bundle) {
  # Support an appended suffix or a suffix on the archive stem. Never guess between two complete pairs.
  $bases = @($Bundle, ($Bundle -replace '\.enc$', ''), ($Bundle -replace '\.acbak\.enc$', '')) | Select-Object -Unique
  $pairs = @(foreach ($base in $bases) {
    if ([IO.File]::Exists("$base.sha256") -and [IO.File]::Exists("$base.meta.json")) {
      [pscustomobject]@{ Hash = "$base.sha256"; Metadata = "$base.meta.json" }
    }
  })
  if ($pairs.Count -eq 1) { $pairs[0] }
}

function Get-AcCloudBundles([string]$Folder, [string]$ArchiveMode = 'encrypted') {
  if (-not [IO.Directory]::Exists($Folder)) { return }
  $formats = [string[]]@("yyyyMMdd'T'HHmmssfff'Z'", "yyyyMMdd'T'HHmmss'Z'", "yyyy-MM-dd'T'HH-mm-ss-fff'Z'")
  $styles = [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
  $suffix = if ($ArchiveMode -eq 'standard') { 'tar.gz' } else { 'enc' }
  $namePattern = '^ac-backup-(.+)\.acbak\.' + [regex]::Escape($suffix) + '$'
  foreach ($file in Get-ChildItem -LiteralPath $Folder -File -Filter "ac-backup-*.acbak.$suffix") {
    if ($file.Name -notmatch $namePattern) { continue }
    $stamp = [datetime]::MinValue
    if (-not [datetime]::TryParseExact($Matches[1], $formats, [Globalization.CultureInfo]::InvariantCulture, $styles, [ref]$stamp)) { continue }
    $sidecars = Get-AcBundleSidecars $file.FullName
    if ($sidecars) { [pscustomobject]@{ Bundle = $file.FullName; Stamp = $stamp; Hash = $sidecars.Hash; Metadata = $sidecars.Metadata } }
  }
}

function Get-AcExpiredCloudBundles($Bundles, [datetime]$Now) {
  $utc = $Now.ToUniversalTime()
  $monday = $utc.Date.AddDays(-(([int]$utc.DayOfWeek + 6) % 7))
  $days = @{}
  $weeks = @{}
  foreach ($entry in ($Bundles | Sort-Object Stamp, Bundle -Descending)) {
    # A future timestamp must not displace a valid backup or be pruned automatically.
    if ($entry.Stamp -gt $utc) { continue }
    $day = $entry.Stamp.ToString('yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)
    $daily = $days.Count -lt 7 -and -not $days.ContainsKey($day)
    if ($daily) { $days[$day] = $true }
    $weekly = $false
    if ($entry.Stamp -ge $monday.AddDays(-28) -and $entry.Stamp -lt $monday) {
      $week = '{0}-{1}' -f [Globalization.ISOWeek]::GetYear($entry.Stamp), [Globalization.ISOWeek]::GetWeekOfYear($entry.Stamp)
      $weekly = -not $weeks.ContainsKey($week)
      $weeks[$week] = $true
    }
    if (-not ($daily -or $weekly)) { $entry }
  }
}

function Get-AcCloudBackupProblem([string]$Destination, [string]$KeyPath, [datetime]$Now, [string]$RecoveryKeyFile, [string]$ArchiveMode = 'encrypted') {
  if (-not $Destination) { return }
  if ($ArchiveMode -eq 'encrypted' -and $RecoveryKeyFile) {
    $key = Get-Item -LiteralPath $RecoveryKeyFile -Force -ErrorAction SilentlyContinue
    if (-not $key -or $key.PSIsContainer -or ($key.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $key.Length -ne 32) {
      return "Cloud backup recovery key is missing or invalid: $RecoveryKeyFile"
    }
  } elseif ($ArchiveMode -eq 'encrypted' -and -not [IO.File]::Exists($KeyPath)) {
    return 'Cloud backup is configured but cloud-key.dpapi is missing; run Set-AcBackupPassphrase.ps1'
  }
  $utc = $Now.ToUniversalTime()
  $latest = Get-AcCloudBundles $Destination $ArchiveMode | Where-Object Stamp -le ($utc.AddMinutes(5)) | Sort-Object Stamp -Descending | Select-Object -First 1
  if (-not $latest) { return "No complete cloud backup in $Destination" }
  if ($latest.Stamp -le $utc.AddHours(-26)) { return "The newest complete cloud backup is from $($latest.Stamp.ToString('u'))" }
}
