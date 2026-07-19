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
    # The app-server resume helper updates this file in another process. Merge
    # fields missing from its latest record instead of overwriting its proof
    # with the launcher's older in-memory copy.
    $latest = Get-Content -Raw -LiteralPath $script:handoffPath | ConvertFrom-Json
    foreach ($property in $script:handoff.PSObject.Properties) {
        if (-not $latest.PSObject.Properties[$property.Name]) {
            $latest | Add-Member -NotePropertyName $property.Name -NotePropertyValue $property.Value
        }
    }
    $script:handoff = $latest
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
    $serialized = $script:handoff | ConvertTo-Json -Depth 12
    [IO.File]::WriteAllText($temporaryPath, $serialized, [Text.UTF8Encoding]::new($false))
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
function Start-CodexDesktop {
    param(
        [Parameter(Mandatory = $true)]$Package,
        [Parameter(Mandatory = $true)][string]$ThreadId
    )

    if (-not $Package.Resolved) {
        throw "The exact OpenAI.Codex package could not be resolved for activation."
    }
    $appUserModelId = "{0}!{1}" -f $Package.PackageFamilyName, $Package.ApplicationId
    $appsFolderTarget = "shell:AppsFolder\$appUserModelId"
    $threadDeepLink = "codex://threads/$ThreadId"
    $explorerPath = (Get-Command explorer.exe -ErrorAction Stop).Source

    # Packaged Windows apps cannot be launched reliably by executing a binary
    # under WindowsApps. Activate the app identity through Explorer instead,
    # then let its registered codex URI open the requested thread.
    $launcher = Start-Process -FilePath $explorerPath -ArgumentList $appsFolderTarget -PassThru
    Start-Sleep -Milliseconds 250
    Start-Process -FilePath $explorerPath -ArgumentList $threadDeepLink | Out-Null
    return [pscustomobject]@{
        LauncherProcessId = $launcher.Id
        AppUserModelId = $appUserModelId
        AppsFolderTarget = $appsFolderTarget
        ThreadDeepLink = $threadDeepLink
        LaunchMethod = "shell:AppsFolder activation plus codex protocol deep link"
    }
}

function Wait-CodexDesktop {
    param(
        [Parameter(Mandatory = $true)]$Package,
        [ValidateRange(5, 60)][int]$TimeoutSeconds = 15
    )

    $packagePrefix = $Package.InstallLocation.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $processes = @()
    do {
        Start-Sleep -Milliseconds 500
        $processes = @(Get-CimInstance Win32_Process | Where-Object {
            $processPath = [string]$_.ExecutablePath
            $processPath -and
            $processPath.StartsWith($packagePrefix, [StringComparison]::OrdinalIgnoreCase) -and
            ($_.Name -ieq "ChatGPT.exe" -or $_.Name -ieq "codex-code-mode-host.exe")
        })
    } while ($processes.Count -eq 0 -and [DateTime]::UtcNow -lt $deadline)
    if ($processes.Count -eq 0) {
        throw "The OpenAI.Codex package launch returned but no package-owned desktop process became visible."
    }
    return $processes
}

function Stop-ProcessTree {
    param([Parameter(Mandatory = $true)][int]$RootProcessId)

    $all = @(Get-CimInstance Win32_Process)
    $ordered = New-Object System.Collections.Generic.List[int]
    function Add-ChildProcesses([int]$ParentProcessId) {
        foreach ($child in @($all | Where-Object { [int]$_.ParentProcessId -eq $ParentProcessId })) {
            Add-ChildProcesses -ParentProcessId ([int]$child.ProcessId)
            $ordered.Add([int]$child.ProcessId)
        }
    }
    Add-ChildProcesses -ParentProcessId $RootProcessId
    $ordered.Add($RootProcessId)
    foreach ($processId in $ordered) {
        Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
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
        ResumeSurface = "Exact OpenAI.Codex desktop reopen immediately after refresh, then visible official app-server same-task continuation"
        ExpectedRuntimeVersion = [string]$handoff.expectedRuntimeVersion
        VerificationModel = [string]$handoff.verificationModel
        VerificationEffort = [string]$handoff.verificationEffort
        RequestedResumeModel = $resumeModel
        RequestedResumeEffort = [string]$handoff.resumeEffort
        ModelSwitchVerified = $false
        ResumeHelper = (Join-Path $PSScriptRoot "resume-codex-thread.ps1")
        ResumeArguments = @("--handoff-file", $handoffPath)
        DesktopLaunchBeforeResume = $true
        ResumeDetached = $false
        ResumeTimeoutSeconds = 1200
        PackageName = $codexDesktopPackage.PackageName
        PackageFullName = $codexDesktopPackage.PackageFullName
        DesktopResolved = $codexDesktopPackage.Resolved
        DesktopExecutable = $codexDesktopPackage.Executable
        DesktopLaunchMethod = "shell:AppsFolder activation plus codex protocol deep link"
        DesktopAppUserModelId = "{0}!{1}" -f $codexDesktopPackage.PackageFamilyName, $codexDesktopPackage.ApplicationId
        DesktopAppsFolderTarget = "shell:AppsFolder\{0}!{1}" -f $codexDesktopPackage.PackageFamilyName, $codexDesktopPackage.ApplicationId
        ThreadDeepLink = "codex://threads/$([string]$handoff.threadId)"
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
    $serialized = $handoff | ConvertTo-Json -Depth 12
    [IO.File]::WriteAllText($handoffPath, $serialized, [Text.UTF8Encoding]::new($false))
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
    Save-RestartState -State "codex-already-stopped" -Message "No running OpenAI.Codex package process was found; continuing with refresh and reopen."
} else {
    $stoppedProcessIds = @($codexProcesses | ForEach-Object { $_.ProcessId })
    foreach ($process in $codexProcesses) {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 3
    Save-RestartState -State "codex-stopped" -Message "Stopped Codex process ids: $($stoppedProcessIds -join ', ')."
}

$caughtError = $null
$desktopOpened = $false
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

    $refreshedListText = (& codex plugin list --json 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to verify the refreshed Codex plugin before continuation."
    }
    $refreshedPlugin = @((($refreshedListText | ConvertFrom-Json).installed) | Where-Object { $_.pluginId -eq "ai-mobile@ai-mobile" })[0]
    if (-not $refreshedPlugin) {
        throw "AI Mobile is not installed after the requested refresh."
    }
    if ([string]$refreshedPlugin.version -ne [string]$handoff.expectedRuntimeVersion) {
        throw "Installed AI Mobile version $($refreshedPlugin.version) does not match expected $($handoff.expectedRuntimeVersion)."
    }

    $handoff | Add-Member -NotePropertyName installedRuntimeVersion -NotePropertyValue ([string]$refreshedPlugin.version) -Force
    $handoff | Add-Member -NotePropertyName consumedAt -NotePropertyValue ([DateTime]::UtcNow.ToString("o")) -Force

    Save-RestartState -State "reopening" -Message "Plugin refresh verified; reopening the exact OpenAI.Codex task before the bounded continuation so the desktop cannot remain hidden behind worker execution."
    $desktopLaunch = Start-CodexDesktop -Package $codexDesktopPackage -ThreadId ([string]$handoff.threadId)
    $verifiedDesktopProcesses = @(Wait-CodexDesktop -Package $codexDesktopPackage -TimeoutSeconds 15)
    $desktopOpened = $true
    $handoff = Get-Content -Raw -LiteralPath $handoffPath | ConvertFrom-Json
    $handoff | Add-Member -NotePropertyName desktopPackage -NotePropertyValue $codexDesktopPackage.PackageFullName -Force
    $handoff | Add-Member -NotePropertyName desktopProcessId -NotePropertyValue $desktopLaunch.LauncherProcessId -Force
    $handoff | Add-Member -NotePropertyName desktopAppUserModelId -NotePropertyValue $desktopLaunch.AppUserModelId -Force
    $handoff | Add-Member -NotePropertyName desktopLaunchMethod -NotePropertyValue $desktopLaunch.LaunchMethod -Force
    $handoff | Add-Member -NotePropertyName desktopThreadDeepLink -NotePropertyValue $desktopLaunch.ThreadDeepLink -Force
    $handoff | Add-Member -NotePropertyName verifiedDesktopProcessIds -NotePropertyValue @($verifiedDesktopProcesses | ForEach-Object { $_.ProcessId }) -Force
    $handoff | Add-Member -NotePropertyName desktopLaunchedAt -NotePropertyValue ([DateTime]::UtcNow.ToString("o")) -Force
    $handoff | Add-Member -NotePropertyName requestedResumeModel -NotePropertyValue $resumeModel -Force
    Save-RestartState -State "desktop-reopened" -Message "The exact OpenAI.Codex task is visible; starting the bounded same-task continuation."

    Save-RestartState -State "continuing-task" -Message "Starting the exact same task through the official Codex app-server before selecting the lightweight console."
    $resumeHelper = Join-Path $PSScriptRoot "resume-codex-thread.ps1"
    if (-not (Test-Path -LiteralPath $resumeHelper -PathType Leaf)) {
        throw "The Codex app-server continuation helper is missing: $resumeHelper"
    }
    $powershellPath = (Get-Command powershell -ErrorAction Stop).Source
    $resumeStdout = Join-Path ([IO.Path]::GetTempPath()) "ai-mobile-resume-$PID.out"
    $resumeStderr = Join-Path ([IO.Path]::GetTempPath()) "ai-mobile-resume-$PID.err"
    $resumeArgumentLine = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -HandoffFile "{1}" -DelaySeconds 0' -f `
        $resumeHelper.Replace('"', '\"'), $handoffPath.Replace('"', '\"')
    $resumeProcess = Start-Process -FilePath $powershellPath -ArgumentList $resumeArgumentLine -WindowStyle Hidden -RedirectStandardOutput $resumeStdout -RedirectStandardError $resumeStderr -PassThru
    $resumeDeadline = [DateTime]::UtcNow.AddSeconds(1200)
    while (-not $resumeProcess.HasExited -and [DateTime]::UtcNow -lt $resumeDeadline) {
        Start-Sleep -Seconds 1
        $resumeProcess.Refresh()
    }
    if (-not $resumeProcess.HasExited) {
        Stop-ProcessTree -RootProcessId $resumeProcess.Id
        throw "Same-task app-server continuation exceeded its 20-minute bounded timeout; the Codex desktop remains open."
    }
    $resumeProcess.WaitForExit()
    $resumeProcess.Refresh()
    $resumeStdoutText = if (Test-Path -LiteralPath $resumeStdout) { Get-Content -Raw -LiteralPath $resumeStdout } else { "" }
    $resumeStderrText = if (Test-Path -LiteralPath $resumeStderr) { Get-Content -Raw -LiteralPath $resumeStderr } else { "" }
    $resumeResult = $null
    try {
        if (-not [string]::IsNullOrWhiteSpace($resumeStdoutText)) {
            $resumeResult = $resumeStdoutText | ConvertFrom-Json
        }
    } catch {
        $resumeResult = $null
    }
    Remove-Item -LiteralPath $resumeStdout, $resumeStderr -Force -ErrorAction SilentlyContinue
    $structuredResumeSucceeded = $resumeResult -and $resumeResult.ok -eq $true -and `
        [string]$resumeResult.runtimeVersion -eq [string]$handoff.expectedRuntimeVersion
    if (-not $structuredResumeSucceeded) {
        $resumeOutput = @($resumeStdoutText, $resumeStderrText) -join [Environment]::NewLine
        throw "Same-task app-server continuation failed with exit code $($resumeProcess.ExitCode): $($resumeOutput.Trim())"
    }
    $handoff = Get-Content -Raw -LiteralPath $handoffPath | ConvertFrom-Json
    if ($handoff.modelSwitchVerified -ne $true -or [string]$handoff.runningRuntimeVersion -ne [string]$handoff.expectedRuntimeVersion) {
        throw "The same-task continuation did not prove the fresh runtime and post-proof model switch."
    }

    # The app-server turn can finish while the desktop still displays its
    # pre-restart snapshot. Re-open the exact deep link after completion so the
    # user's visible task foregrounds the newly completed lightweight turn.
    $explorerPath = (Get-Command explorer.exe -ErrorAction Stop).Source
    Start-Process -FilePath $explorerPath -ArgumentList "codex://threads/$([string]$handoff.threadId)" | Out-Null
    $handoff | Add-Member -NotePropertyName desktopForegroundedAt -NotePropertyValue ([DateTime]::UtcNow.ToString("o")) -Force
    Save-RestartState -State "completed" -Message "The exact OpenAI.Codex task was foregrounded after the fresh runtime proof and lightweight continuation completed."
} catch {
    $caughtError = $_
    Save-RestartState -State "failed" -Message "The one-shot restart handoff failed; Codex will still be reopened." -ErrorText $_.Exception.Message
} finally {
    if ($caughtError -and -not $desktopOpened) {
        $desktopLaunch = Start-CodexDesktop -Package $codexDesktopPackage -ThreadId ([string]$handoff.threadId)
        $verifiedDesktopProcesses = @(Wait-CodexDesktop -Package $codexDesktopPackage -TimeoutSeconds 15)
        $handoff | Add-Member -NotePropertyName desktopPackage -NotePropertyValue $codexDesktopPackage.PackageFullName -Force
        $handoff | Add-Member -NotePropertyName desktopProcessId -NotePropertyValue $desktopLaunch.LauncherProcessId -Force
        $handoff | Add-Member -NotePropertyName desktopAppUserModelId -NotePropertyValue $desktopLaunch.AppUserModelId -Force
        $handoff | Add-Member -NotePropertyName desktopLaunchMethod -NotePropertyValue $desktopLaunch.LaunchMethod -Force
        $handoff | Add-Member -NotePropertyName desktopThreadDeepLink -NotePropertyValue $desktopLaunch.ThreadDeepLink -Force
        $handoff | Add-Member -NotePropertyName verifiedDesktopProcessIds -NotePropertyValue @($verifiedDesktopProcesses | ForEach-Object { $_.ProcessId }) -Force
        $handoff | Add-Member -NotePropertyName desktopLaunchedAt -NotePropertyValue ([DateTime]::UtcNow.ToString("o")) -Force
        Save-RestartState -State "reopened-after-failure" -Message "The exact OpenAI.Codex package was reopened after the refresh failure."
    }
}
if ($caughtError) {
    throw $caughtError
}
