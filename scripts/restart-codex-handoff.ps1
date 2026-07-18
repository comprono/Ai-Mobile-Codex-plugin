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
    } | ConvertTo-Json -Depth 4
    exit 0
}

if ($Schedule) {
    $childArgs = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", $PSCommandPath,
        "-HandoffFile", $handoffPath,
        "-Execute",
        "-DelaySeconds", [string]$DelaySeconds
    )
    $child = Start-Process powershell -ArgumentList $childArgs -WindowStyle Hidden -PassThru
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
$codexProcesses = Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -like "*\OpenAI.Codex_*" -and
    ($_.Name -ieq "ChatGPT.exe" -or $_.Name -ieq "codex-code-mode-host.exe")
}
foreach ($process in $codexProcesses) {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 3

$resumeExitCode = 1
try {
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

    $handoff | Add-Member -NotePropertyName consumedAt -NotePropertyValue ([DateTime]::UtcNow.ToString("o")) -Force
    $handoff | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $handoffPath -Encoding UTF8
    & codex @codexArgs
    $resumeExitCode = $LASTEXITCODE
    if ($resumeExitCode -ne 0) {
        throw "Codex resume failed with exit code $resumeExitCode."
    }
} finally {
    Start-Process codex -ArgumentList @("app", $workspace)
}
