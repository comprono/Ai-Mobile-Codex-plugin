param(
  [Parameter(Position=0)][ValidateSet('setup','resource-inventory','provider-diagnostics','start-program','run-program-campaign','program-report','start-task','reconcile-task','dispatch-round','run-task-cycle','collect-round','integrate-round','record-evidence','task-summary','material-status','complete-task','cancel-task','orchestrator-profile','prepare-restart-handoff','self-test','privacy')][string]$Command = 'setup',
  [string]$ContractFile = '',
  [string]$TaskId = '',
  [string]$PortfolioId = '',
  [switch]$Refresh
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Entry = Join-Path $PSScriptRoot 'ai-mobile-local-mcp.js'

function Invoke-Node([string[]]$Arguments) {
  & node $Entry @Arguments
  if ($LASTEXITCODE -ne 0) { throw "AI Mobile command failed with exit code $LASTEXITCODE." }
}

function Require-Contract {
  if (-not $ContractFile) { throw '-ContractFile is required.' }
  return (Resolve-Path -LiteralPath $ContractFile).Path
}

function Get-StateArguments {
  if ($PortfolioId) { return @('--portfolio-id',$PortfolioId) }
  if ($TaskId) { return @('--task-id',$TaskId) }
  throw '-TaskId or -PortfolioId is required.'
}

switch ($Command) {
  'setup' {
    [ordered]@{
      Installed = Test-Path $Entry
      NodeReady = $null -ne (Get-Command node -ErrorAction SilentlyContinue)
      Version = (Get-Content (Join-Path $Root '.codex-plugin\plugin.json') -Raw | ConvertFrom-Json).version
      PluginRoot = $Root
      StartupBehavior = 'passive; no provider desktop application is opened'
      StateRoot = '%LOCALAPPDATA%\AI Mobile\v1'
      Tools = @('start-program','run-program-campaign','program-report','start-task','reconcile-task','dispatch-round','run-task-cycle','collect-round','integrate-round','record-evidence','task-summary','material-status','complete-task','cancel-task','resource-inventory','provider-diagnostics','orchestrator-profile','prepare-restart-handoff')
    } | ConvertTo-Json -Depth 4
  }
  'resource-inventory' {
    $args = @('resource-inventory-cli')
    if ($Refresh) { $args += '--refresh' }
    Invoke-Node $args
  }
  'provider-diagnostics' {
    $args = @('provider-diagnostics-cli')
    if ($ContractFile) { $args += @('--json-file',(Require-Contract)) }
    Invoke-Node $args
  }
  'start-program' { Invoke-Node @('start-program-cli','--json-file',(Require-Contract)) }
  'run-program-campaign' { Invoke-Node @('run-program-campaign-cli','--json-file',(Require-Contract)) }
  'program-report' {
    if (-not $TaskId) { throw '-TaskId is required.' }
    Invoke-Node @('program-report-cli','--task-id',$TaskId)
  }
  'start-task' { Invoke-Node @('start-task-cli','--json-file',(Require-Contract)) }
  'reconcile-task' { Invoke-Node @('reconcile-task-cli','--json-file',(Require-Contract)) }
  'dispatch-round' { Invoke-Node @('dispatch-round-cli','--json-file',(Require-Contract)) }
  'run-task-cycle' { Invoke-Node @('run-task-cycle-cli','--json-file',(Require-Contract)) }
  'collect-round' { Invoke-Node @('collect-round-cli','--json-file',(Require-Contract)) }
  'integrate-round' { Invoke-Node @('integrate-round-cli','--json-file',(Require-Contract)) }
  'record-evidence' { Invoke-Node @('record-evidence-cli','--json-file',(Require-Contract)) }
  'task-summary' { Invoke-Node (@('task-summary-cli') + (Get-StateArguments)) }
  'material-status' { Invoke-Node (@('coordinator-status-cli') + (Get-StateArguments)) }
  'complete-task' { Invoke-Node (@('complete-task-cli') + (Get-StateArguments)) }
  'cancel-task' { Invoke-Node (@('cancel-task-cli') + (Get-StateArguments)) }
  'orchestrator-profile' { Invoke-Node @('orchestrator-profile-cli') }
  'prepare-restart-handoff' { Invoke-Node @('prepare-restart-handoff-cli','--json-file',(Require-Contract)) }
  'self-test' { Invoke-Node @('self-test') }
  'privacy' {
    [ordered]@{
      PublicRepoPolicy = 'No credentials, cookies, transcripts, quota snapshots, personal project data, or machine-specific paths.'
      LocalState = '%LOCALAPPDATA%\AI Mobile\v1'
      ProjectRuntimeFiles = 'none'
      DesktopStartup = 'never automatic'
      WriterIsolation = 'detached Git worktree by default; exact privately trusted Fable 5 and Sonnet 5 may write clean bounded primary paths with deterministic checks'
      PortfolioMode = 'one finite request can coordinate multiple independently verified projects'
      GlobalGuards = 'provider, quota pool, worker, RAM, file ownership, and worktree storage'
      WorktreeLifecycle = 'disk quota, free-space gate, maximum age, collection cleanup, cancellation cleanup, and startup crash cleanup'
    } | ConvertTo-Json -Depth 3
  }
}
