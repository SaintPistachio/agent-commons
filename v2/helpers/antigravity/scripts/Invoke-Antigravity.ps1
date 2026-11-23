#Requires -Version 7.0
[CmdletBinding()]
param(
    [ValidateSet('Run', 'Status', 'Probe', 'Catalog', 'Evaluate', 'Activity', 'ToolProbe', 'StructuredProbe', 'VisualProbe', 'Capabilities', 'Prepare', 'Validate', 'QualificationPrepare', 'QualificationStage', 'QualificationPublishBase')][string]$Action = 'Run',
    [string]$PromptPath,
    [ValidateSet('transform', 'explain', 'coding', 'complex', 'review', 'followup')]
    [string]$Task = 'coding',
    [string]$Model,
    [string]$ModelFamily,
    [string]$EffortReason,
    [ValidateSet('low', 'medium', 'high', 'xhigh', 'max')][string]$Effort,
    [ValidateRange(5, 3600)][int]$TimeoutSeconds = 600,
    [string]$ChatId = $env:CODEX_THREAD_ID,
    [string]$PreviousModel,
    [string]$CapabilityProfilePath,
    [switch]$RefreshCatalog,
    [switch]$RetryCandidate,
    [switch]$HardDeadline,
    [string]$RunId,
    [string]$ToolProfilePath,
    [string]$ContextBundlePath,
    [string]$PreparedContextPath,
    [string]$OutputContractPath,
    [string]$ResponsePath,
    [string]$RouterSessionState,
    [string]$RouterAttemptId,
    [string]$RouterScope,
    [string]$ConversationId,
    [ValidatePattern('^[a-f0-9]{64}$')][string]$RouterExpectedCliSha256,
    [string]$QualificationRunDirectory,
    [string]$QualificationId,
    [string]$QualificationRuntimeSha256,
    [string]$QualificationBundlePath,
    [string]$QualificationBundleSha256,
    [ValidateSet('base-control','base-gemini','base-claude-gpt','session-create','session-resume','session-isolation','cancellation')][string]$QualificationStage,
    [string]$QualificationCallbackFile,
    [string]$QualificationAttemptId
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$python = (Get-Command python -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$qualificationValues = @($QualificationRunDirectory, $QualificationId, $QualificationRuntimeSha256, $QualificationBundlePath,
    $QualificationBundleSha256, $QualificationStage, $QualificationCallbackFile, $QualificationAttemptId)
if ($Action -in @('QualificationPrepare', 'QualificationStage', 'QualificationPublishBase')) {
    if ($PromptPath -or $RouterSessionState -or $RouterAttemptId -or $RouterScope -or $ConversationId -or $RouterExpectedCliSha256 -or
        $ToolProfilePath -or $CapabilityProfilePath -or $ContextBundlePath -or $PreparedContextPath -or $OutputContractPath -or
        $ResponsePath -or $RefreshCatalog -or $RetryCandidate) { throw 'Fixed qualification does not accept task, tool, context or retry input.' }
    $qualificationArguments = @((Join-Path $PSScriptRoot 'qualification_bridge.py'), '--helper-root', (Split-Path -Parent $PSScriptRoot))
    if ($Action -eq 'QualificationPrepare') {
        if (-not $QualificationRunDirectory -or -not $QualificationId -or -not $QualificationRuntimeSha256 -or
            $QualificationBundlePath -or $QualificationBundleSha256 -or $QualificationStage -or $QualificationCallbackFile -or $QualificationAttemptId) {
            throw 'QualificationPrepare requires only its fixed preparation binding.'
        }
        $qualificationArguments += @('--prepare', '--run-directory', $QualificationRunDirectory, '--qualification-id', $QualificationId,
            '--runtime-sha256', $QualificationRuntimeSha256)
        if ($Model) { $qualificationArguments += @('--model', $Model) }
        if ($Effort) { $qualificationArguments += @('--effort', $Effort) }
    } elseif ($Action -eq 'QualificationStage') {
        if (-not $QualificationBundlePath -or -not $QualificationBundleSha256 -or -not $QualificationStage -or
            -not $QualificationCallbackFile -or -not $QualificationAttemptId -or $QualificationRunDirectory -or $QualificationId -or $QualificationRuntimeSha256 -or $Model -or $Effort) {
            throw 'QualificationStage requires the prepared bundle and exact admitted stage.'
        }
        $qualificationArguments += @('--execute-stage', '--bundle', $QualificationBundlePath, '--expected-bundle-sha256', $QualificationBundleSha256,
            '--stage', $QualificationStage, '--callback-file', $QualificationCallbackFile, '--attempt-id', $QualificationAttemptId)
    } else {
        if (-not $QualificationBundlePath -or -not $QualificationBundleSha256 -or $QualificationStage -or
            $QualificationCallbackFile -or $QualificationAttemptId -or $QualificationRunDirectory -or $QualificationId -or $QualificationRuntimeSha256 -or $Model -or $Effort) {
            throw 'QualificationPublishBase accepts only its retained fixed bundle.'
        }
        $qualificationArguments += @('--publish-base', '--bundle', $QualificationBundlePath, '--expected-bundle-sha256', $QualificationBundleSha256)
    }
    & $python @qualificationArguments
    exit $LASTEXITCODE
}
if (@($qualificationValues | Where-Object { $_ }).Count) { throw 'Qualification parameters require a qualification action.' }
if ($RouterExpectedCliSha256 -and ($Action -ne 'Run' -or -not $RouterSessionState)) { throw 'RouterExpectedCliSha256 requires a router Run.' }
$arguments = @((Join-Path $PSScriptRoot 'antigravity.py'), '--action', $Action.ToLowerInvariant(), '--task', $Task,
    '--timeout', [string]$TimeoutSeconds)
if ($Action -eq 'ToolProbe') { $arguments[2] = 'tool-probe' }
if ($Action -eq 'StructuredProbe') { $arguments[2] = 'structured-probe' }
if ($Action -eq 'VisualProbe') { $arguments[2] = 'visual-probe' }
foreach ($pair in @(@('--prompt-file', $PromptPath), @('--model', $Model), @('--effort', $Effort),
    @('--model-family', $ModelFamily), @('--effort-reason', $EffortReason),
    @('--chat-id', $ChatId), @('--previous-model', $PreviousModel),
    @('--capability-profile', $CapabilityProfilePath), @('--run-id', $RunId), @('--tool-profile', $ToolProfilePath),
    @('--context-bundle', $ContextBundlePath), @('--prepared-context', $PreparedContextPath),
    @('--output-contract', $OutputContractPath), @('--response-file', $ResponsePath),
    @('--router-session-state', $RouterSessionState), @('--router-attempt-id', $RouterAttemptId),
    @('--router-scope', $RouterScope), @('--router-expected-cli-sha256', $RouterExpectedCliSha256), @('--conversation-id', $ConversationId))) {
    if ($pair[1]) { $arguments += $pair }
}
if ($RefreshCatalog) { $arguments += '--refresh-catalog' }
if ($HardDeadline) { $arguments += '--hard-deadline' }
if ($RetryCandidate) { $arguments += '--retry-candidate' }
& $python @arguments
exit $LASTEXITCODE
