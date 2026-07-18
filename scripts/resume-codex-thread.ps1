[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$HandoffFile,
    [ValidateRange(0, 30)]
    [int]$DelaySeconds = 2
)

$ErrorActionPreference = "Stop"
if ($DelaySeconds -gt 0) {
    Start-Sleep -Seconds $DelaySeconds
}

$handoffPath = (Resolve-Path -LiteralPath $HandoffFile).Path
$handoff = Get-Content -Raw -LiteralPath $handoffPath | ConvertFrom-Json

function Save-ResumeState {
    param(
        [Parameter(Mandatory = $true)][string]$State,
        [Parameter(Mandatory = $true)][string]$Message,
        [string]$ErrorText = ""
    )
    $now = [DateTime]::UtcNow.ToString("o")
    $entry = [pscustomobject]@{ At = $now; State = $State; Message = $Message }
    $script:handoff = Get-Content -Raw -LiteralPath $script:handoffPath | ConvertFrom-Json
    $log = @($script:handoff.restartLog) + @($entry)
    $script:handoff | Add-Member -NotePropertyName restartState -NotePropertyValue $State -Force
    $script:handoff | Add-Member -NotePropertyName restartUpdatedAt -NotePropertyValue $now -Force
    $script:handoff | Add-Member -NotePropertyName restartMessage -NotePropertyValue $Message -Force
    $script:handoff | Add-Member -NotePropertyName restartLog -NotePropertyValue @($log | Select-Object -Last 30) -Force
    if ($State -eq "resume-complete") {
        $script:handoff | Add-Member -NotePropertyName modelSwitchVerified -NotePropertyValue ([bool]$script:handoff.resumeModel) -Force
    }
    if ($ErrorText) {
        $script:handoff | Add-Member -NotePropertyName restartError -NotePropertyValue $ErrorText -Force
    }
    $temporaryPath = "$script:handoffPath.tmp.$PID"
    $serialized = $script:handoff | ConvertTo-Json -Depth 12
    [IO.File]::WriteAllText($temporaryPath, $serialized, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporaryPath -Destination $script:handoffPath -Force
}

if ($handoff.oneShot -ne $true -or $handoff.userAuthorized -ne $true -or -not $handoff.consumedAt) {
    throw "The detached resume requires one consumed, authorized, one-shot handoff."
}
if ($handoff.threadId -notmatch "^[0-9a-fA-F]{8}-[0-9a-fA-F-]{27,}$") {
    throw "The restart handoff has an invalid Codex thread id."
}
$workspace = (Resolve-Path -LiteralPath ([string]$handoff.workspace)).Path
$resumeModel = [string]$handoff.resumeModel
if ($resumeModel -and $resumeModel -notmatch "^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$") {
    throw "The restart handoff has an invalid resume model id."
}
if (-not [string]$handoff.resumePrompt) {
    throw "The restart handoff has no resume prompt."
}

$codexArgs = @("-C", $workspace, "exec", "resume")
if ($resumeModel) {
    $codexArgs += @("-m", $resumeModel)
}
$codexArgs += @([string]$handoff.threadId, [string]$handoff.resumePrompt)

try {
    Save-ResumeState -State "resume-running" -Message "The detached exact-thread Codex continuation is running."
    & codex @codexArgs
    if ($LASTEXITCODE -ne 0) {
        throw "Codex resume failed with exit code $LASTEXITCODE."
    }
    $handoff | Add-Member -NotePropertyName modelSwitchVerified -NotePropertyValue ([bool]$resumeModel) -Force
    Save-ResumeState -State "resume-complete" -Message "The detached exact-thread Codex continuation completed successfully."
} catch {
    Save-ResumeState -State "resume-failed" -Message "The Codex desktop remains open, but the detached continuation failed." -ErrorText $_.Exception.Message
    throw
}
