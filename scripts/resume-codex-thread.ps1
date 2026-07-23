[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$HandoffFile,
    [ValidateRange(0, 30)]
    [int]$DelaySeconds = 0
)

$ErrorActionPreference = "Stop"
if ($DelaySeconds -gt 0) {
    Start-Sleep -Seconds $DelaySeconds
}

$script:handoffPath = (Resolve-Path -LiteralPath $HandoffFile).Path

function Write-Handoff {
    param([Parameter(Mandatory = $true)]$Value)
    $temporaryPath = "$script:handoffPath.tmp.$PID"
    $serialized = $Value | ConvertTo-Json -Depth 12
    [IO.File]::WriteAllText($temporaryPath, $serialized, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporaryPath -Destination $script:handoffPath -Force
}

function Save-ResumeState {
    param(
        [Parameter(Mandatory = $true)][string]$State,
        [Parameter(Mandatory = $true)][string]$Message,
        [string]$ErrorText = ""
    )
    $handoff = Get-Content -Raw -LiteralPath $script:handoffPath | ConvertFrom-Json
    $now = [DateTime]::UtcNow.ToString("o")
    $entry = [pscustomobject]@{ At = $now; State = $State; Message = $Message }
    $handoff | Add-Member -NotePropertyName restartState -NotePropertyValue $State -Force
    $handoff | Add-Member -NotePropertyName restartUpdatedAt -NotePropertyValue $now -Force
    $handoff | Add-Member -NotePropertyName restartMessage -NotePropertyValue $Message -Force
    $handoff | Add-Member -NotePropertyName restartLog -NotePropertyValue @(@($handoff.restartLog) + @($entry) | Select-Object -Last 30) -Force
    if ($ErrorText) {
        $handoff | Add-Member -NotePropertyName restartError -NotePropertyValue $ErrorText -Force
    }
    Write-Handoff -Value $handoff
}

$handoff = Get-Content -Raw -LiteralPath $script:handoffPath | ConvertFrom-Json
if ($handoff.schemaVersion -ne 4 -or $handoff.oneShot -ne $true -or $handoff.userAuthorized -ne $true -or -not $handoff.consumedAt) {
    throw "App-server continuation requires one consumed, authorized, one-shot handoff."
}
if ($handoff.threadId -notmatch "^[0-9a-fA-F]{8}-[0-9a-fA-F-]{27,}$") {
    throw "The restart handoff has an invalid Codex thread id."
}
if (-not [string]$handoff.expectedRuntimeVersion) {
    throw "The restart handoff has no expected runtime version."
}
if ([string]$handoff.expectedRuntimeFingerprint -notmatch "^[a-fA-F0-9]{64}$") {
    throw "The restart handoff has no expected runtime fingerprint."
}
if (-not [string]$handoff.resumeModel -or -not [string]$handoff.resumePrompt) {
    throw "The restart handoff has no exact lightweight resume contract."
}

$client = Join-Path $PSScriptRoot "codex-app-server-resume.js"
if (-not (Test-Path -LiteralPath $client -PathType Leaf)) {
    throw "The Codex app-server continuation client is missing: $client"
}
$node = (Get-Command node -ErrorAction Stop).Source

try {
    Save-ResumeState -State "verifying-fresh-runtime" -Message "Starting the official local Codex app-server against the exact existing task."
    $resultText = (& $node $client "--handoff-file" $script:handoffPath 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) {
        throw $resultText.Trim()
    }
    $result = $resultText | ConvertFrom-Json
    if ($result.ok -ne $true -or `
        [string]$result.runtimeVersion -ne [string]$handoff.expectedRuntimeVersion -or `
        [string]$result.runtimeFingerprint -ne [string]$handoff.expectedRuntimeFingerprint -or `
        $result.continuationProof.verified -ne $true -or `
        [string]$result.continuationProof.taskId -ne [string]$handoff.taskId -or `
        [int]$result.continuationProof.campaignCalls -ne 1 -or `
        $result.continuationProof.noStartOrLegacyTools -ne $true) {
        throw "The app-server continuation did not prove the expected AI Mobile runtime."
    }
    if ([string]$handoff.handoffMode -eq "resume-program" -and [int]$result.continuationProof.reconcileCalls -ne 0) {
        throw "The existing Director-CFO program was reconciled or migrated instead of resumed in place."
    }
    if ([string]$handoff.handoffMode -eq "migrate-program" -and `
        ([int]$result.continuationProof.reconcileCalls -ne 1 -or $result.continuationProof.migrationVerified -ne $true)) {
        throw "The legacy durable task migration was not proved before campaign execution."
    }

    $handoff = Get-Content -Raw -LiteralPath $script:handoffPath | ConvertFrom-Json
    $handoff | Add-Member -NotePropertyName runningRuntimeVersion -NotePropertyValue ([string]$result.runtimeVersion) -Force
    $handoff | Add-Member -NotePropertyName runningRuntimeFingerprint -NotePropertyValue ([string]$result.runtimeFingerprint) -Force
    $handoff | Add-Member -NotePropertyName verificationTurnId -NotePropertyValue ([string]$result.verificationTurnId) -Force
    $handoff | Add-Member -NotePropertyName continuationTurnId -NotePropertyValue ([string]$result.continuationTurnId) -Force
    $handoff | Add-Member -NotePropertyName actualVerificationModel -NotePropertyValue ([string]$result.verificationModel) -Force
    $handoff | Add-Member -NotePropertyName actualResumeModel -NotePropertyValue ([string]$result.resumeModel) -Force
    $handoff | Add-Member -NotePropertyName actualResumeEffort -NotePropertyValue ([string]$result.resumeEffort) -Force
    $handoff | Add-Member -NotePropertyName continuationProof -NotePropertyValue $result.continuationProof -Force
    $handoff | Add-Member -NotePropertyName continuationProofVerified -NotePropertyValue $true -Force
    $handoff | Add-Member -NotePropertyName modelSwitchVerified -NotePropertyValue $true -Force
    $handoff | Add-Member -NotePropertyName continuationCompletedAt -NotePropertyValue ([DateTime]::UtcNow.ToString("o")) -Force
    Write-Handoff -Value $handoff
    Save-ResumeState -State "resume-complete" -Message "Fresh runtime, exact same-task campaign, and no-start-or-legacy continuation were verified through the official Codex app-server."
    $result | ConvertTo-Json -Depth 6
} catch {
    Save-ResumeState -State "resume-failed" -Message "The same-task app-server continuation failed closed before completion." -ErrorText $_.Exception.Message
    throw
}
