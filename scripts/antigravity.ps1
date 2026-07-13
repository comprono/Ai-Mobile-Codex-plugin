param(
  [Parameter(Position=0)][ValidateSet('setup','resource-inventory','run-efficient-task','read-job','verify-job','cancel-job','orchestrator-profile','self-test','privacy')][string]$Command = 'setup',
  [string]$Workspace = (Get-Location).Path,
  [string]$Goal = '',
  [string]$ProjectGoal = '',
  [string]$CurrentCodexGoal = '',
  [string]$IndependenceReason = '',
  [ValidateSet('auto','codex','claude','antigravity','cursor')][string]$Provider = 'auto',
  [string[]]$ExpectedFiles = @(),
  [switch]$ReadOnly,
  [switch]$AllowAntigravity,
  [string]$JobId = '',
  [ValidateSet('compact','full')][string]$Detail = 'compact',
  [ValidateRange(0,60)][int]$WaitSeconds = 0,
  [int]$TimeoutSeconds = 900,
  [switch]$Refresh
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Entry = Join-Path $PSScriptRoot 'ai-mobile-local-mcp.js'

function Invoke-Node([string[]]$Arguments) {
  & node $Entry @Arguments
  if ($LASTEXITCODE -ne 0) { throw "AI Mobile command failed with exit code $LASTEXITCODE." }
}

switch ($Command) {
  'setup' {
    $node = Get-Command node -ErrorAction SilentlyContinue
    [ordered]@{
      Installed = Test-Path $Entry
      NodeReady = $null -ne $node
      PluginRoot = $Root
      StartupBehavior = 'passive; no desktop application is opened'
      Tools = @('orchestrator-profile','resource-inventory','run-efficient-task','read-job','verify-job','cancel-job')
    } | ConvertTo-Json -Depth 4
  }
  'resource-inventory' {
    $args = @('resource-inventory-cli')
    if ($Refresh) { $args += '--refresh' }
    Invoke-Node $args
  }
  'run-efficient-task' {
    if (-not $Goal) { throw '-Goal is required.' }
    if (-not $CurrentCodexGoal) { throw '-CurrentCodexGoal is required so the bridge can reject duplicate work.' }
    if (-not $IndependenceReason) { throw '-IndependenceReason is required so the bridge can prove delegation value.' }
    if (-not $ReadOnly -and $ExpectedFiles.Count -eq 0) { throw 'Writer lanes require -ExpectedFiles.' }
    $payload = [ordered]@{
      workspace = (Resolve-Path -LiteralPath $Workspace).Path
      projectGoal = $ProjectGoal
      goal = $Goal
      currentCodexGoal = $CurrentCodexGoal
      independenceReason = $IndependenceReason
      preferredProvider = $Provider
      expectedFiles = @($ExpectedFiles)
      readOnly = [bool]$ReadOnly
      allowAntigravity = [bool]$AllowAntigravity
      timeoutSeconds = $TimeoutSeconds
      complexity = 'medium'
    }
    $temp = Join-Path ([IO.Path]::GetTempPath()) ("ai-mobile-{0}.json" -f [guid]::NewGuid().ToString('N'))
    try {
      $payload | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $temp -Encoding UTF8
      Invoke-Node @('run-efficient-task-cli','--json-file',$temp)
    } finally { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
  }
  'read-job' {
    if (-not $JobId) { throw '-JobId is required.' }
    Invoke-Node @('read-job-cli','--workspace',(Resolve-Path -LiteralPath $Workspace).Path,'--job-id',$JobId,'--detail',$Detail,'--wait-seconds',"$WaitSeconds")
  }
  'verify-job' {
    if (-not $JobId) { throw '-JobId is required.' }
    Invoke-Node @('verify-job-cli','--workspace',(Resolve-Path -LiteralPath $Workspace).Path,'--job-id',$JobId)
  }
  'cancel-job' {
    if (-not $JobId) { throw '-JobId is required.' }
    Invoke-Node @('cancel-job-cli','--workspace',(Resolve-Path -LiteralPath $Workspace).Path,'--job-id',$JobId)
  }
  'orchestrator-profile' { Invoke-Node @('orchestrator-profile-cli') }
  'self-test' { Invoke-Node @('self-test') }
  'privacy' {
    [ordered]@{
      PublicRepoPolicy = 'No credentials, cookies, local transcripts, quota snapshots, or personal project data.'
      LocalArtifacts = '<workspace>/.ai-mobile/jobs and %LOCALAPPDATA%/AI Mobile'
      LegacyArtifacts = '<workspace>/.antigravity-bridge/jobs are read-only compatibility inputs'
      DesktopStartup = 'never automatic'
    } | ConvertTo-Json -Depth 3
  }
}
