[CmdletBinding()]
param(
    [ValidateSet("user", "project", "local")]
    [string]$ClaudeScope = "user",
    [switch]$ValidateOnly
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$codexManifest = Get-Content -LiteralPath (Join-Path $root ".codex-plugin\plugin.json") -Raw | ConvertFrom-Json
$claudeManifest = Get-Content -LiteralPath (Join-Path $root ".claude-plugin\plugin.json") -Raw | ConvertFrom-Json
if ([string]$codexManifest.version -ne [string]$claudeManifest.version) {
    throw "Codex and Claude manifests must declare the same AI Mobile version."
}
$expectedVersion = [string]$codexManifest.version

function Invoke-Checked {
    param([string]$Command, [string[]]$Arguments)
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Command failed with exit code $LASTEXITCODE."
    }
}

Invoke-Checked "claude" @("plugin", "validate", "--strict", $root)
if ($ValidateOnly) {
    [pscustomobject]@{
        Valid = $true
        Repository = $root
        Version = $expectedVersion
        CodexManifest = Join-Path $root ".codex-plugin\plugin.json"
        ClaudeManifest = Join-Path $root ".claude-plugin\plugin.json"
        SharedMcp = Join-Path $root ".mcp.json"
    } | ConvertTo-Json -Depth 3
    exit 0
}

$claudeMarketplaces = (& claude plugin marketplace list 2>&1 | Out-String)
if ($claudeMarketplaces -match "(?m)^ai-mobile\b") {
    Invoke-Checked "claude" @("plugin", "marketplace", "update", "ai-mobile")
} else {
    Invoke-Checked "claude" @("plugin", "marketplace", "add", "--scope", $ClaudeScope, $root)
}
$claudePlugins = (& claude plugin list 2>&1 | Out-String)
if ($claudePlugins -match "ai-mobile@ai-mobile") {
    Invoke-Checked "claude" @("plugin", "update", "ai-mobile@ai-mobile")
} else {
    Invoke-Checked "claude" @("plugin", "install", "--scope", $ClaudeScope, "ai-mobile@ai-mobile")
}

$codexMarketplaces = (& codex plugin marketplace list --json | Out-String | ConvertFrom-Json).marketplaces
$codexMarketplace = $codexMarketplaces | Where-Object { $_.name -eq "ai-mobile" } | Select-Object -First 1
if (-not $codexMarketplace) {
    Invoke-Checked "codex" @("plugin", "marketplace", "add", $root, "--json")
} elseif ($codexMarketplace.marketplaceSource.sourceType -eq "git") {
    Invoke-Checked "codex" @("plugin", "marketplace", "upgrade", "ai-mobile", "--json")
} else {
    $configuredRoot = [IO.Path]::GetFullPath([string]$codexMarketplace.root).TrimEnd("\")
    if ($configuredRoot -ne $root.TrimEnd("\")) {
        throw "Codex marketplace ai-mobile points to $configuredRoot instead of $root. Remove that marketplace explicitly before installing this checkout."
    }
}
Invoke-Checked "codex" @("plugin", "add", "ai-mobile@ai-mobile", "--json")

$codexPluginState = ((& codex plugin list --json | Out-String | ConvertFrom-Json).installed |
    Where-Object { $_.pluginId -eq "ai-mobile@ai-mobile" } | Select-Object -First 1)
$claudePluginState = ((& claude plugin list --json | Out-String | ConvertFrom-Json) |
    Where-Object { $_.id -eq "ai-mobile@ai-mobile" } | Select-Object -First 1)
if (-not $codexPluginState -or $codexPluginState.enabled -ne $true -or [string]$codexPluginState.version -ne $expectedVersion) {
    throw "Codex did not enable the exact AI Mobile $expectedVersion release."
}
if (-not $claudePluginState -or $claudePluginState.enabled -ne $true -or [string]$claudePluginState.version -ne $expectedVersion) {
    throw "Claude Code did not enable the exact AI Mobile $expectedVersion release."
}

$userProfilePath = [Environment]::GetFolderPath("UserProfile")
$codexBase = Join-Path $userProfilePath ".codex"
if ($env:CODEX_HOME) {
    $codexBase = [IO.Path]::GetFullPath($env:CODEX_HOME)
}
$codexCacheRoot = Join-Path $codexBase "plugins\cache\ai-mobile\ai-mobile"
$codexInstallPath = Join-Path $codexCacheRoot $expectedVersion
$claudeInstallPath = [string]$claudePluginState.installPath
if (-not (Test-Path -LiteralPath $codexInstallPath -PathType Container)) {
    throw "Codex AI Mobile cache is missing at $codexInstallPath."
}
if (-not $claudeInstallPath -or -not (Test-Path -LiteralPath $claudeInstallPath -PathType Container)) {
    throw "Claude Code AI Mobile cache is missing at $claudeInstallPath."
}
Invoke-Checked "node" @(
    (Join-Path $PSScriptRoot "verify-installed-runtime.js"),
    "--source", $root,
    "--codex", $codexInstallPath,
    "--claude", $claudeInstallPath,
    "--version", $expectedVersion
)

[pscustomobject]@{
    Installed = $true
    Version = $expectedVersion
    Repository = $root
    CodexPlugin = "ai-mobile@ai-mobile"
    ClaudePlugin = "ai-mobile@ai-mobile"
    SharedMcp = Join-Path $root ".mcp.json"
    CodexInstallPath = $codexInstallPath
    ClaudeInstallPath = $claudeInstallPath
    CacheParityVerified = $true
    RestartCodex = $true
    RestartClaudeCode = $true
} | ConvertTo-Json -Depth 3
