#Requires -Version 7.0
[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory)][string]$DataRoot,
  [ValidateSet('Verify', 'Create', 'Repair')][string]$Action = 'Verify'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Ac-BackupCommon.ps1')

$root = [IO.Path]::GetFullPath($DataRoot)
$connections = Join-Path $root 'connections'
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$trusted = @($currentUser, 'S-1-5-18')

function Assert-NoRedirect([string]$Path) {
  for ($entryPath = $Path; $entryPath; $entryPath = [IO.Path]::GetDirectoryName($entryPath)) {
    try { $entry = Get-Item -LiteralPath $entryPath -Force -ErrorAction Stop }
    catch [System.Management.Automation.ItemNotFoundException] { continue }
    if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw "Redirected paths are not supported for token storage: $entryPath"
    }
  }
}

function Assert-TokenAcl([string]$Path) {
  $acl = Get-Acl -LiteralPath $Path
  $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  $grants = $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
  if ($owner -notin $trusted -or ($grants | Where-Object {
    $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -notin $trusted
  })) { throw "Token storage permissions are too broad: $Path" }
}

Assert-AcNotOneDrive $root
if ($root -notmatch '^[A-Za-z]:\\.+' -or [IO.DriveInfo]::new([IO.Path]::GetPathRoot($root)).DriveType -ne 'Fixed') {
  throw 'Token storage requires a local fixed drive.'
}
Assert-NoRedirect $connections
if ($Action -eq 'Create' -and -not (Test-Path -LiteralPath $root)) { Set-AcPrivateDirectory $root -Create }
if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw "Data directory does not exist: $root" }

$paths = @($root, $connections)
$files = @(foreach ($name in 'runtime.json', 'commons.sqlite', 'commons.sqlite-wal', 'commons.sqlite-shm', 'worker-policy.json') {
  $candidate = Join-Path $root $name
  if (Test-Path -LiteralPath $candidate) { Get-Item -LiteralPath $candidate -Force }
})
if (Test-Path -LiteralPath $connections) {
  if (-not (Test-Path -LiteralPath $connections -PathType Container)) { throw 'Connections path is not a directory.' }
  $files += @(Get-ChildItem -LiteralPath $connections -Force)
}
foreach ($file in $files) {
  Assert-NoRedirect $file.FullName
  if ($file.PSIsContainer -or $file.LinkType) { throw "Token storage requires regular files: $($file.FullName)" }
}

if ($Action -eq 'Repair') {
  if (-not $PSCmdlet.ShouldProcess($root, 'Restrict access to the data directory, database, and token files')) { return }
  foreach ($folder in $paths) {
    if (Test-Path -LiteralPath $folder) {
      Set-AcPrivateDirectory $folder
      $acl = Get-Acl -LiteralPath $folder
      if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trusted) {
        $acl.SetOwner([Security.Principal.SecurityIdentifier]::new($currentUser))
        Set-Acl -LiteralPath $folder -AclObject $acl
      }
    }
  }
  foreach ($file in $files) {
    $acl = [Security.AccessControl.FileSecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner([Security.Principal.SecurityIdentifier]::new($currentUser))
    foreach ($sid in $trusted | Select-Object -Unique) {
      $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        [Security.Principal.SecurityIdentifier]::new($sid), 'FullControl', 'Allow'))
    }
    [IO.FileSystemAclExtensions]::SetAccessControl($file, $acl)
  }
}
Assert-TokenAcl $root
if ($Action -eq 'Create' -and -not (Test-Path -LiteralPath $connections)) { Set-AcPrivateDirectory $connections -Create }
if (Test-Path -LiteralPath $connections) { Assert-TokenAcl $connections }
foreach ($file in $files) {
  if (Test-Path -LiteralPath $file.FullName) { Assert-TokenAcl $file.FullName }
}
