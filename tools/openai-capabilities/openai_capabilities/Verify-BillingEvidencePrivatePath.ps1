#Requires -Version 7.0
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedSourceSha256,
    [switch]$Create,
    [switch]$Recurse
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$stage = 'preflight'
try {
    if (-not $IsWindows) { throw 'WINDOWS_REQUIRED' }
    if ((Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ExpectedSourceSha256) { throw 'SOURCE_CHANGED' }
    if (-not [IO.Path]::IsPathFullyQualified($Path) -or $Path -match '^(\\|//)|[\x00-\x1f"]') { throw 'LOCAL_PATH_REQUIRED' }
    $target = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    if ($target -eq [IO.Path]::GetPathRoot($target).TrimEnd('\', '/')) { throw 'CHILD_REQUIRED' }
    $cursor = $target
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'LINK_REFUSED' }
        }
        $cursor = [IO.Path]::GetDirectoryName($cursor)
    }
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $allowed = @($sid, 'S-1-5-18', 'S-1-5-32-544')
    if ($Create) {
        $stage = 'create-private-directory'
        if (Test-Path -LiteralPath $target) { throw 'NEW_DIRECTORY_REQUIRED' }
        if (-not $PSCmdlet.ShouldProcess($target, 'Create new owner-private billing evidence directory')) { throw 'CREATE_NOT_APPLIED' }
        $null = New-Item -ItemType Directory -Path $target
        $security = [Security.AccessControl.DirectorySecurity]::new()
        $security.SetAccessRuleProtection($true, $false)
        $security.SetOwner([Security.Principal.SecurityIdentifier]::new($sid))
        $inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
        foreach ($principal in $allowed) {
            $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($principal), [Security.AccessControl.FileSystemRights]::FullControl, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
        }
        Set-Acl -LiteralPath $target -AclObject $security
    }
    $pending = [Collections.Generic.Stack[string]]::new()
    $pending.Push($target)
    $count = 0
    while ($pending.Count) {
        $stage = 'inspect-entry'
        $itemPath = $pending.Pop()
        $item = Get-Item -LiteralPath $itemPath -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'LINK_REFUSED' }
        $count++
        if ($count -gt 6000) { throw 'INVENTORY_BOUND' }
        $stage = 'inspect-permissions'
        $acl = Get-Acl -LiteralPath $itemPath
        if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $allowed) { throw 'OWNER_UNVERIFIED' }
        foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
            # Python 3.14's Windows mode0700 uses OWNER RIGHTS, S-1-3-4.
            # It grants this object's owner, already verified above, rather
            # than another local account. Keep every other principal refused.
            if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $rule.IdentityReference.Value -notin ($allowed + @('S-1-3-4'))) { throw 'ADDITIONAL_PRINCIPAL' }
        }
        if ($Recurse -and $item.PSIsContainer) {
            foreach ($child in [IO.Directory]::EnumerateFileSystemEntries($itemPath)) { $pending.Push($child) }
        }
    }
    @{status='private_verified';entries=$count;created=[bool]$Create;existing_permissions_changed=$false} | ConvertTo-Json -Compress
    exit 0
} catch {
    @{status='blocked';error_code='billing_evidence_private_storage_unverified';stage=$stage;error_id=$_.FullyQualifiedErrorId} | ConvertTo-Json -Compress
    exit 2
}
