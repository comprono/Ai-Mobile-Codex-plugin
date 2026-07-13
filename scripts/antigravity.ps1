param(
  [Parameter(Position=0)][ValidateSet('setup','resource-inventory','orchestrate-task','read-job','verify-job','cancel-job','orchestrator-profile','self-test','privacy')][string]$Command = 'setup',
  [string]$Workspace = (Get-Location).Path,
  [string]$ContractFile = '',
  [string]$JobId = '',
  [ValidateSet('compact','full')][string]$Detail = 'compact',
  [ValidateRange(0,60)][int]$WaitSeconds = 0,
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
      Tools = @('orchestrate-task','read-job','verify-job','cancel-job','resource-inventory','orchestrator-profile')
    } | ConvertTo-Json -Depth 4
  }
  'resource-inventory' {
    $args = @('resource-inventory-cli')
    if ($Refresh) { $args += '--refresh' }
    Invoke-Node $args
  }
  'orchestrate-task' {
    if (-not $ContractFile) { throw '-ContractFile is required and must contain the finite orchestration contract JSON.' }
    $resolved = (Resolve-Path -LiteralPath $ContractFile).Path
    Invoke-Node @('orchestrate-task-cli','--json-file',$resolved)
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
      LocalArtifacts = '<workspace>/.ai-mobile/tasks, <workspace>/.ai-mobile/jobs, and %LOCALAPPDATA%/AI Mobile'
      LegacyArtifacts = '<workspace>/.antigravity-bridge/jobs are read-only compatibility inputs'
      DesktopStartup = 'never automatic'
    } | ConvertTo-Json -Depth 3
  }
}
