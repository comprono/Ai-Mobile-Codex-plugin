[CmdletBinding()]
param(
    [ValidateSet("user", "project", "local")]
    [string]$ClaudeScope = "user",
    [switch]$ValidateOnly
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

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

[pscustomobject]@{
    Installed = $true
    Repository = $root
    CodexPlugin = "ai-mobile@ai-mobile"
    ClaudePlugin = "ai-mobile@ai-mobile"
    SharedMcp = Join-Path $root ".mcp.json"
    RestartCodex = $true
    RestartClaudeCode = $true
} | ConvertTo-Json -Depth 3
