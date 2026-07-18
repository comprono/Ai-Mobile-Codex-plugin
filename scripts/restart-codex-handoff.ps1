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

function Resolve-CodexDesktopPackage {
    param([switch]$AllowUnavailable)

    $packages = @(Get-AppxPackage -Name "OpenAI.Codex" -ErrorAction SilentlyContinue | Sort-Object Version -Descending)
    if ($packages.Count -eq 0) {
        if ($AllowUnavailable) {
            return [pscustomobject]@{
                Resolved = $false
                PackageName = "OpenAI.Codex"
                PackageFullName = ""
                PackageFamilyName = ""
                InstallLocation = ""
                ApplicationId = "App"
                Executable = ""
            }
        }
        throw "The installed OpenAI.Codex desktop package was not found. Classic ChatGPT will not be used as a fallback."
    }

    $package = $packages[0]
    $manifest = Get-AppxPackageManifest -Package $package -ErrorAction Stop
    $application = @($manifest.Package.Applications.Application | Where-Object { [string]$_.Id -eq "App" })[0]
    if (-not $application -or [string]::IsNullOrWhiteSpace([string]$application.Executable)) {
        throw "OpenAI.Codex package application App has no declared executable."
    }

    $installLocation = [IO.Path]::GetFullPath([string]$package.InstallLocation)
    $executable = [IO.Path]::GetFullPath((Join-Path $installLocation ([string]$application.Executable)))
    $installPrefix = $installLocation.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $executable.StartsWith($installPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "OpenAI.Codex declared executable resolves outside its package directory."
    }
    if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
        throw "OpenAI.Codex declared executable does not exist: $executable"
    }

    return [pscustomobject]@{
        Resolved = $true
        PackageName = [string]$package.Name
        PackageFullName = [string]$package.PackageFullName
        PackageFamilyName = [string]$package.PackageFamilyName
        InstallLocation = $installLocation
        ApplicationId = [string]$application.Id
        Executable = $executable
    }
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
$resumeModel = [string]$handoff.resumeModel
if ($resumeModel -and $resumeModel -notmatch "^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$") {
    throw "The restart handoff has an invalid resume model id."
}
$isDryRun = $DryRun -or (-not $Schedule -and -not $Execute)
$codexDesktopPackage = Resolve-CodexDesktopPackage -AllowUnavailable:$isDryRun
$desktopArguments = @("--open-project", $workspace, "codex://threads/$([string]$handoff.threadId)")

$refreshPluginIds = @($handoff.refreshPluginIds | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
if ($refreshPluginIds.Count -eq 0) {
    $refreshPluginIds = @("ai-mobile@ai-mobile")
}
if ($isDryRun) {
    [pscustomobject]@{
        Valid = $true
        OneShot = $true
        HandoffFile = $handoffPath
        ResumeSurface = "OpenAI.Codex desktop deep link"
        RequestedResumeModel = $resumeModel
        ModelSwitchVerified = $false
        PackageName = $codexDesktopPackage.PackageName
        PackageFullName = $codexDesktopPackage.PackageFullName
        DesktopResolved = $codexDesktopPackage.Resolved
        DesktopExecutable = $codexDesktopPackage.Executable
        DesktopArguments = $desktopArguments
        OpensProviderUi = $false
        DryRunOpensUi = $false
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
Save-RestartState -State "stopping-codex" -Message "Locating processes owned by the exact OpenAI.Codex package."
$installPrefix = $codexDesktopPackage.InstallLocation.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
$codexProcesses = Get-CimInstance Win32_Process | Where-Object {
    $processPath = [string]$_.ExecutablePath
    $processPath -and
    $processPath.StartsWith($installPrefix, [StringComparison]::OrdinalIgnoreCase) -and
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
    Save-RestartState -State "reopening" -Message "Plugin refresh finished; reopening the exact Codex package and thread now."
    $threadDeepLink = "codex://threads/$([string]$handoff.threadId)"
    $appArgumentLine = '--open-project "{0}" "{1}"' -f $workspace.Replace('"', '\"'), $threadDeepLink
    $desktopProcess = Start-Process -FilePath $codexDesktopPackage.Executable -ArgumentList $appArgumentLine -PassThru
    $handoff | Add-Member -NotePropertyName desktopPackage -NotePropertyValue $codexDesktopPackage.PackageFullName -Force
    $handoff | Add-Member -NotePropertyName desktopProcessId -NotePropertyValue $desktopProcess.Id -Force
    $handoff | Add-Member -NotePropertyName desktopLaunchedAt -NotePropertyValue ([DateTime]::UtcNow.ToString("o")) -Force
    $handoff | Add-Member -NotePropertyName requestedResumeModel -NotePropertyValue $resumeModel -Force
    $handoff | Add-Member -NotePropertyName modelSwitchVerified -NotePropertyValue $false -Force
    Save-RestartState -State "reopened" -Message "The exact OpenAI.Codex package was reopened for the target workspace and thread."
} catch {
    $caughtError = $_
    Save-RestartState -State "failed" -Message "The one-shot restart handoff failed; Codex will still be reopened." -ErrorText $_.Exception.Message
} finally {
    if ($caughtError) {
        $threadDeepLink = "codex://threads/$([string]$handoff.threadId)"
        $appArgumentLine = '--open-project "{0}" "{1}"' -f $workspace.Replace('"', '\"'), $threadDeepLink
        $desktopProcess = Start-Process -FilePath $codexDesktopPackage.Executable -ArgumentList $appArgumentLine -PassThru
        $handoff | Add-Member -NotePropertyName desktopPackage -NotePropertyValue $codexDesktopPackage.PackageFullName -Force
        $handoff | Add-Member -NotePropertyName desktopProcessId -NotePropertyValue $desktopProcess.Id -Force
        $handoff | Add-Member -NotePropertyName desktopLaunchedAt -NotePropertyValue ([DateTime]::UtcNow.ToString("o")) -Force
        Save-RestartState -State "reopened-after-failure" -Message "The exact OpenAI.Codex package was reopened after the refresh failure."
    }
}
if ($caughtError) {
    throw $caughtError
}
