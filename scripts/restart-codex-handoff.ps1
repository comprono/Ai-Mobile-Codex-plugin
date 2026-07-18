[CmdletBinding(DefaultParameterSetName = "DryRun")]
param(
    [Parameter(Mandatory = $true)]
    [string]$HandoffFile,
    [Parameter(ParameterSetName = "Schedule")]
    [switch]$Schedule,
    [Parameter(ParameterSetName = "Execute")]
    [switch]$Execute,
    [Parameter(ParameterSetName = "DryRun")]
    [switch]$DryRun,
    [ValidateRange(5, 60)]
    [int]$DelaySeconds = 10
)

$ErrorActionPreference = "Stop"
$handoffPath = (Resolve-Path -LiteralPath $HandoffFile).Path
$handoff = Get-Content -Raw -LiteralPath $handoffPath | ConvertFrom-Json

function Save-RestartState {
    param(
        [Parameter(Mandatory = $true)][string]$State,
        [Parameter(Mandatory = $true)][string]$Message,
        [string]$ErrorText = ""
    )
    $now = [DateTime]::UtcNow.ToString("o")
    $entry = [pscustomobject]@{ At = $now; State = $State; Message = $Message }
    $log = @($script:handoff.restartLog) + @($entry)
    $script:handoff | Add-Member -NotePropertyName restartState -NotePropertyValue $State -Force
    $script:handoff | Add-Member -NotePropertyName restartUpdatedAt -NotePropertyValue $now -Force
    $script:handoff | Add-Member -NotePropertyName restartMessage -NotePropertyValue $Message -Force
    $script:handoff | Add-Member -NotePropertyName restartLog -NotePropertyValue @($log | Select-Object -Last 30) -Force
    if ($ErrorText) {
        $script:handoff | Add-Member -NotePropertyName restartError -NotePropertyValue $ErrorText -Force
    }
    $temporaryPath = "$script:handoffPath.tmp.$PID"
    $script:handoff | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $temporaryPath -Encoding UTF8
    Move-Item -LiteralPath $temporaryPath -Destination $script:handoffPath -Force
}
if ($handoff.oneShot -ne $true -or $handoff.userAuthorized -ne $true) {
    throw "The restart handoff is not an authorized one-shot contract."
}
if ($handoff.consumedAt) {
    throw "The restart handoff was already consumed at $($handoff.consumedAt)."
}
if ($handoff.threadId -notmatch "^[0-9a-fA-F]{8}-[0-9a-fA-F-]{27,}$") {
    throw "The restart handoff has an invalid Codex thread id."
}
$workspace = (Resolve-Path -LiteralPath ([string]$handoff.workspace)).Path
if (-not [string]$handoff.resumePrompt) {
    throw "The restart handoff has no resume prompt."
}

$codexArgs = @("-C", $workspace, "exec", "resume", [string]$handoff.threadId, [string]$handoff.resumePrompt)
$refreshPluginIds = @($handoff.refreshPluginIds | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
if ($refreshPluginIds.Count -eq 0) {
    $refreshPluginIds = @("ai-mobile@ai-mobile")
}
if ($DryRun -or (-not $Schedule -and -not $Execute)) {
    [pscustomobject]@{
        Valid = $true
        OneShot = $true
        HandoffFile = $handoffPath
        Command = "codex"
        Arguments = $codexArgs
        OpensProviderUi = $false
        Recurring = $false
        CleanupPluginIds = @($handoff.cleanupPluginIds)
        RefreshPluginIds = @($refreshPluginIds)
    } | ConvertTo-Json -Depth 4
    exit 0
}

if ($Schedule) {
    $powershellPath = (Get-Command powershell -ErrorAction Stop).Source
    $childArgumentLine = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -HandoffFile "{1}" -Execute -DelaySeconds {2}' -f `
        $PSCommandPath.Replace('"', '\"'), $handoffPath.Replace('"', '\"'), $DelaySeconds
    Save-RestartState -State "scheduled" -Message "External one-shot restart helper scheduled."
    $child = Start-Process -FilePath $powershellPath -ArgumentList $childArgumentLine -WindowStyle Hidden -PassThru
    $handoff = Get-Content -Raw -LiteralPath $handoffPath | ConvertFrom-Json
    $handoff | Add-Member -NotePropertyName restartProcessId -NotePropertyValue $child.Id -Force
    $handoff | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $handoffPath -Encoding UTF8
    [pscustomobject]@{
        Scheduled = $true
        OneShot = $true
        ProcessId = $child.Id
        DelaySeconds = $DelaySeconds
        HandoffFile = $handoffPath
    } | ConvertTo-Json -Depth 3
    exit 0
}

Start-Sleep -Seconds $DelaySeconds
Save-RestartState -State "stopping-codex" -Message "Locating the installed Codex desktop package processes."
$codexProcesses = Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -like "*\OpenAI.Codex_*" -and
    ($_.Name -ieq "ChatGPT.exe" -or $_.Name -ieq "codex-code-mode-host.exe")
}
if (@($codexProcesses).Count -eq 0) {
    Save-RestartState -State "failed" -Message "No running Codex desktop package process was found; no application was stopped." -ErrorText "Codex process identity was not found."
    throw "No running OpenAI.Codex desktop process was found."
}
$stoppedProcessIds = @($codexProcesses | ForEach-Object { $_.ProcessId })
foreach ($process in $codexProcesses) {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 3
Save-RestartState -State "codex-stopped" -Message "Stopped Codex process ids: $($stoppedProcessIds -join ', ')."

$resumeExitCode = 1
$caughtError = $null
try {
    Save-RestartState -State "cleanup" -Message "Inspecting obsolete plugin registrations before resume."
    $pluginListText = (& codex plugin list --json 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to inspect installed Codex plugins before resume."
    }
    $installedPlugins = ($pluginListText | ConvertFrom-Json).installed
    foreach ($pluginId in @($handoff.cleanupPluginIds)) {
        if ([string]$pluginId -notmatch "^[a-zA-Z0-9][a-zA-Z0-9-]*@[a-zA-Z0-9][a-zA-Z0-9-]*$") {
            throw "Invalid cleanup plugin identifier: $pluginId"
        }
        if ($installedPlugins.pluginId -contains [string]$pluginId) {
            & codex plugin remove ([string]$pluginId) --json | Out-Null
            if ($LASTEXITCODE -ne 0) {
                throw "Unable to remove obsolete plugin entry $pluginId before resume."
            }
        }
    }

    foreach ($pluginId in $refreshPluginIds) {
        if ([string]$pluginId -notmatch "^[a-zA-Z0-9][a-zA-Z0-9-]*@[a-zA-Z0-9][a-zA-Z0-9-]*$") {
            throw "Invalid refresh plugin identifier: $pluginId"
        }
        & codex plugin add ([string]$pluginId) --json | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "Unable to refresh plugin entry $pluginId before resume."
        }
    }

    $handoff | Add-Member -NotePropertyName consumedAt -NotePropertyValue ([DateTime]::UtcNow.ToString("o")) -Force
    Save-RestartState -State "resuming" -Message "Plugin cleanup and refresh finished; resuming the exact Codex thread."
    & codex @codexArgs
    $resumeExitCode = $LASTEXITCODE
    if ($resumeExitCode -ne 0) {
        throw "Codex resume failed with exit code $resumeExitCode."
    }
    Save-RestartState -State "resume-complete" -Message "The resumed Codex turn completed successfully."
} catch {
    $caughtError = $_
    Save-RestartState -State "failed" -Message "The one-shot restart handoff failed; Codex will still be reopened." -ErrorText $_.Exception.Message
} finally {
    $codexPath = (Get-Command codex -ErrorAction Stop).Source
    $appArgumentLine = 'app "{0}"' -f $workspace.Replace('"', '\"')
    Start-Process -FilePath $codexPath -ArgumentList $appArgumentLine
    Save-RestartState -State $(if ($caughtError) { "reopened-after-failure" } else { "reopened" }) -Message "Codex desktop reopen command was issued for the target workspace."
}
if ($caughtError) {
    throw $caughtError
}
