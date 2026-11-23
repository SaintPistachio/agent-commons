#Requires -Version 7.0
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [Parameter(Mandatory)][string]$WorkspaceRoot,
    [Parameter(Mandatory)][ValidatePattern('^S-1-5-21-(\d+-){3}\d+$')][string]$ExpectedUserSid,
    [Parameter(Mandatory)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedSourceSha256,
    [switch]$Apply,
    [switch]$CreateStaging
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-PlainPath {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Boundary)
    $current = [System.IO.Path]::GetFullPath($Path)
    $stop = [System.IO.Path]::GetFullPath($Boundary).TrimEnd('\')
    if (-not ($current.Equals($stop, [System.StringComparison]::OrdinalIgnoreCase) -or
        $current.StartsWith($stop + '\', [System.StringComparison]::OrdinalIgnoreCase))) {
        throw 'Target is outside the approved workspace.'
    }
    while ($true) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'Reparse points are not allowed in private storage paths.'
            }
        }
        if ($current.Equals($stop, [System.StringComparison]::OrdinalIgnoreCase)) { break }
        $current = [System.IO.Path]::GetDirectoryName($current)
        if ([string]::IsNullOrEmpty($current)) { throw 'Unable to establish workspace containment.' }
    }
}

function Get-PrivateDirectorySecurity {
    param([Parameter(Mandatory)][string]$UserSid)
    $security = [System.Security.AccessControl.DirectorySecurity]::new()
    $security.SetAccessRuleProtection($true, $false)
    $security.SetOwner([System.Security.Principal.SecurityIdentifier]::new($UserSid))
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
        [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    foreach ($sid in @($UserSid, 'S-1-5-18', 'S-1-5-32-544')) {
        $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
            [System.Security.Principal.SecurityIdentifier]::new($sid),
            [System.Security.AccessControl.FileSystemRights]::FullControl,
            $inheritance, [System.Security.AccessControl.PropagationFlags]::None,
            [System.Security.AccessControl.AccessControlType]::Allow)
        $security.AddAccessRule($rule)
    }
    return $security
}

function Assert-PrivateAcl {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][bool]$Directory)
    $acl = Get-Acl -LiteralPath $Path
    $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    if ($owner -ne $ExpectedUserSid) { throw 'Private storage owner does not match the approved normal user.' }
    if ($Directory -and -not $acl.AreAccessRulesProtected) { throw 'Private directories must disable inherited permissions.' }
    $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
    $allowed = @($ExpectedUserSid, 'S-1-5-18', 'S-1-5-32-544')
    if ($rules.Count -ne 3) { throw 'Private storage must have exactly three allowlisted access rules.' }
    $seen = [System.Collections.Generic.HashSet[string]]::new()
    foreach ($rule in $rules) {
        $sid = $rule.IdentityReference.Value
        if ($sid -notin $allowed -or -not $seen.Add($sid) -or
            $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
            $rule.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl) {
            throw 'Private storage contains an unexpected principal or access rule.'
        }
        if ($Directory -and ($rule.IsInherited -or
            $rule.InheritanceFlags -ne ([System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
                [System.Security.AccessControl.InheritanceFlags]::ObjectInherit) -or
            $rule.PropagationFlags -ne [System.Security.AccessControl.PropagationFlags]::None)) {
            throw 'Private directory inheritance does not match the protected storage contract.'
        }
    }
}

try {
    if (-not $IsWindows) { throw 'Private storage initialization requires Windows.' }
    $sourceHash = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash
    if ($sourceHash -ne $ExpectedSourceSha256) { throw 'Initializer source changed after review.' }
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    if ($identity.User.Value -ne $ExpectedUserSid -or $identity.Name -match '(?i)\\CodexSandbox') {
        throw 'Run the initializer as the approved normal Windows user.'
    }
    $actualWorkspace = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..')).TrimEnd('\')
    $requestedWorkspace = [System.IO.Path]::GetFullPath($WorkspaceRoot).TrimEnd('\')
    if (-not $actualWorkspace.Equals($requestedWorkspace, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Workspace must be the repository containing this reviewed initializer.'
    }
    $localRoot = Join-Path $PSScriptRoot '.local'
    $secretRoot = Join-Path $localRoot 'secrets'
    Assert-PlainPath -Path $secretRoot -Boundary $actualWorkspace
    if (-not (Test-Path -LiteralPath $localRoot -PathType Container)) {
        throw 'Initialize the helper local-state directory before private storage.'
    }
    if (Test-Path -LiteralPath $secretRoot) {
        if (-not (Test-Path -LiteralPath $secretRoot -PathType Container)) { throw 'Private storage target is not a directory.' }
        Assert-PrivateAcl -Path $secretRoot -Directory $true
        foreach ($entry in @(Get-ChildItem -LiteralPath $secretRoot -Force)) {
            Assert-PlainPath -Path $entry.FullName -Boundary $secretRoot
            if ($entry.PSIsContainer) {
                if ($entry.Name -notmatch '^setup-[a-f0-9]{32}$') { throw 'Unexpected directory in private storage.' }
                Assert-PrivateAcl -Path $entry.FullName -Directory $true
                foreach ($staged in @(Get-ChildItem -LiteralPath $entry.FullName -Force)) {
                    Assert-PlainPath -Path $staged.FullName -Boundary $secretRoot
                    if ($staged.PSIsContainer -or $staged.Name -notin @('connector-request.json', 'recipient-private-key.jwk.json', 'synthetic.env', 'encrypted-result.json')) {
                        throw 'Unexpected content in private setup staging.'
                    }
                    Assert-PrivateAcl -Path $staged.FullName -Directory $false
                }
            } else {
                if ($entry.Name -notin @('project.env', 'admin.env')) { throw 'Unexpected file in private storage.' }
                Assert-PrivateAcl -Path $entry.FullName -Directory $false
            }
        }
    }
    $stagingPath = $null
    $status = 'dry_run'
    if ($Apply -and $PSCmdlet.ShouldProcess($secretRoot, 'Create only protected private credential storage')) {
        $security = Get-PrivateDirectorySecurity -UserSid $ExpectedUserSid
        if (-not (Test-Path -LiteralPath $secretRoot)) {
            [System.IO.FileSystemAclExtensions]::Create([System.IO.DirectoryInfo]::new($secretRoot), $security)
        }
        Assert-PlainPath -Path $secretRoot -Boundary $actualWorkspace
        Assert-PrivateAcl -Path $secretRoot -Directory $true
        if ($CreateStaging) {
            $stagingPath = Join-Path $secretRoot ('setup-' + [guid]::NewGuid().ToString('N'))
            [System.IO.FileSystemAclExtensions]::Create([System.IO.DirectoryInfo]::new($stagingPath), $security)
            Assert-PlainPath -Path $stagingPath -Boundary $secretRoot
            Assert-PrivateAcl -Path $stagingPath -Directory $true
        }
        $status = 'ready'
    }
    [ordered]@{status = $status; secret_root = $secretRoot; staging_path = $stagingPath;
        user_sid = $ExpectedUserSid; normal_user = $identity.Name; mode = $(if ($Apply) { 'apply' } else { 'dry_run' });
        source_sha256 = $sourceHash.ToLowerInvariant()} | ConvertTo-Json -Depth 4 -Compress
} catch {
    [ordered]@{status = 'blocked'; error = $_.Exception.Message} | ConvertTo-Json -Compress
    exit 1
}
