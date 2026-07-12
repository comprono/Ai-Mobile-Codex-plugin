#!/usr/bin/env node

const { spawn, spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const crypto = require("node:crypto");
const { readCodexUsageTelemetry, parseTokenCountEvent } = require("./lib/codex-telemetry");
const {
  buildCodexExecArgs,
  codexCliCandidates,
  parseCodexJsonl,
  parseCodexLoginStatus,
} = require("./lib/codex-cli");
const {
  createVerificationRunner,
  normalizeVerificationCommands: normalizeVerificationCommandList,
} = require("./lib/verification-runner");
const { buildContextCapsule, buildTaskCapsule, writeContextCapsule } = require("./lib/context-capsule");
const {
  buildHostCodexCandidates,
  chooseHostCodexAction,
  disjointWriterPair: writerItemsAreDisjoint,
  selectReasoningEffort,
  shouldFanOut,
} = require("./lib/project-manager");
const { DEFAULT_PROFILE, modelPattern, normalizeProfile, readProfile, writeProfile } = require("./lib/orchestrator-profile");

const pluginRoot = path.resolve(__dirname, "..");
const pluginVersion = (() => {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8")).version || "0.0.0");
  } catch {
    return "0.0.0";
  }
})();
const helperScript = path.join(pluginRoot, "scripts", "antigravity.ps1");
const devToolsPortFile = path.join(process.env.APPDATA || "", "Antigravity", "DevToolsActivePort");
const resourceCacheFile = path.join(process.env.LOCALAPPDATA || os.tmpdir(), "AI Mobile", "resource-cache.json");
const codexModelsCacheFile = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "models_cache.json");
const resourceCacheTtlMs = 10 * 60 * 1000;
const processIdentityCache = new Map();
const claudeCliCapabilityCache = new Map();
const claudeWorkerPluginDir = path.join(pluginRoot, "claude-plugin");
const verificationRunner = createVerificationRunner({
  collectGitState,
  isPathInside: pathIsInside,
  redact: redactArtifactContent,
  runCommand: runWindowsFriendly,
  truncate: truncateText,
  utcStamp,
  writeJson: writeJsonFile,
});

const projectWorkItemSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "Stable short work-item id." },
    objective: { type: "string", description: "Canonical concrete outcome for this item. Prefer this field." },
    description: { type: "string", description: "Accepted alias for objective." },
    title: { type: "string", description: "Short label; used as an objective fallback only." },
    kind: { type: "string", description: "Examples: discovery, architecture, implementation, debugging, verification, review, integration, docs." },
    complexity: { type: "string", enum: ["low", "medium", "high", "critical"], default: "medium" },
    requiredCapabilities: { type: "array", items: { type: "string" }, maxItems: 10 },
    capabilities: { type: "array", items: { type: "string" }, maxItems: 10, description: "Accepted alias for requiredCapabilities." },
    dependsOn: { type: "array", items: { type: "string" }, maxItems: 12 },
    expectedFiles: { type: "array", items: { type: "string" }, maxItems: 20, description: "Exact file or narrow directory ownership boundary." },
    files: { type: "array", items: { type: "string" }, maxItems: 20, description: "Accepted alias for expectedFiles." },
    readOnly: { type: "boolean", description: "True for scouts/reviewers; false for implementation." },
    executionClass: { type: "string", enum: ["analysis", "code", "operation", "integration"] },
    class: { type: "string", enum: ["analysis", "code", "operation", "integration"], description: "Accepted alias for executionClass." },
    externallyConsequential: { type: "boolean", description: "True for real submissions, sends, deploys, purchases, destructive actions, or other external effects.", default: false },
    preferredPlatform: { type: "string", description: "Optional preference: codex, claude, antigravity, or cursor." },
    platform: { type: "string", description: "Accepted alias for preferredPlatform." },
    acceptanceCriteria: { type: "array", items: { type: "string" }, maxItems: 4 },
    acceptance: { type: "array", items: { type: "string" }, maxItems: 4, description: "Accepted alias for acceptanceCriteria." },
    verification: { type: "array", items: { type: "string" }, maxItems: 4 },
    tests: { type: "array", items: { type: "string" }, maxItems: 4, description: "Accepted alias for verification." },
    verificationCommands: {
      type: "array",
      maxItems: 4,
      description: "Structured, shell-free checks the bridge must execute and record independently after the worker returns.",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short evidence label." },
          command: { type: "string", description: "Allowlisted executable name, such as git, node, python, npm, or dotnet." },
          args: { type: "array", items: { type: "string" }, maxItems: 30 },
          timeoutSeconds: { type: "number", minimum: 1, maximum: 900, default: 300 },
          expectedExitCode: { type: "number", minimum: 0, maximum: 255, default: 0 },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
    priority: { type: "number", description: "Higher values dispatch first.", default: 50 },
  },
  required: ["id"],
  additionalProperties: false,
};

const tools = [
  {
    name: "quick",
    description: "Preferred first call. Compact setup, live UI, and model-limit summary in one low-token report.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "setup",
    description: "Verify Antigravity 2.0 local setup readiness: install path, runtime, Node.js, DevTools, and model-limit API.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "doctor",
    description: "Alias for setup. Diagnose whether the local Antigravity bridge is ready.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "status",
    description: "Report whether Antigravity is installed/running and the current DevTools port.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "open",
    description: "Open Antigravity 2.0 if it is installed and not already running.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "repair-live",
    description: "Restart Antigravity and wait for an inspectable DevTools page when live UI control is not ready.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "inspect",
    description: "Inspect local Antigravity integration details, bundled helpers, and known binaries.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "live",
    description: "Report the live Chromium DevTools connection and page list for UI inspection.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "devtools-health",
    description: "Low-token fallback for ai-mobile-devtools transport errors. Reports live pages and the recommended recovery step.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "submission-guide",
    description: "Compact guidance for reliably submitting Antigravity chat prompts through DevTools without invalid key names.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "prepare-offload",
    description: "Default first call for nontrivial work. Decide offload, check live/model readiness, generate the compact handoff, and give submit instructions.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "Task goal for Antigravity." },
        workspace: { type: "string", description: "Local workspace path or Antigravity project name." },
        statusFile: { type: "string", description: "Small artifact Antigravity should write.", default: "notes/antigravity-status.md" },
        nextStep: { type: "string", description: "Specific next action.", default: "Inspect the relevant files and write a compact status checkpoint." },
        hasWorkspaceWork: { type: "boolean", description: "Whether the task needs files, diffs, logs, browser state, or project context.", default: true },
        estimatedCodexInputTokens: { type: "number", description: "Rough Codex tokens needed if handled directly.", default: 2000 },
      },
      required: ["goal"],
      additionalProperties: false,
    },
  },
  {
    name: "orchestration-plan",
    description: "Plan how Codex should orchestrate Codex, Antigravity CLI/UI, Claude Code, and Cursor based on task shape, visible budget state, Antigravity limits, and local worker availability.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "User goal to route." },
        workspace: { type: "string", description: "Local workspace path or project name." },
        codexBudgetState: { type: "string", description: "Caller-observed Codex budget state, such as healthy, medium, low, critical, unknown, or exact visible text.", default: "unknown" },
        estimatedCodexInputTokens: { type: "number", description: "Rough Codex tokens needed if handled directly.", default: 2000 },
        hasWorkspaceWork: { type: "boolean", description: "Whether the task needs files, diffs, logs, browser state, or project context.", default: true },
        needsVisibleAntigravityChat: { type: "boolean", description: "Whether the task must continue/select a visible Antigravity project/chat.", default: false },
        needsUi: { type: "boolean", description: "Whether the task needs visual desktop UI state.", default: false },
        expectedProject: { type: "string", description: "Optional visible Antigravity project text." },
        expectedChat: { type: "string", description: "Optional visible Antigravity chat/conversation title." },
      },
      required: ["goal"],
      additionalProperties: false,
    },
  },
  {
    name: "efficiency-flow",
    description: "Return the full token-saving delivery flow: plan, route, submit, wait, read compact artifacts, follow up, verify, and summarize.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "User goal to route." },
        workspace: { type: "string", description: "Local workspace path or project name." },
        codexBudgetState: { type: "string", description: "Caller-observed Codex budget state.", default: "unknown" },
        estimatedCodexInputTokens: { type: "number", description: "Rough Codex tokens needed if handled directly.", default: 2000 },
        hasWorkspaceWork: { type: "boolean", description: "Whether the task needs files, diffs, logs, browser state, or project context.", default: true },
        needsVisibleAntigravityChat: { type: "boolean", description: "Whether the task must continue/select a visible Antigravity project/chat.", default: false },
        needsUi: { type: "boolean", description: "Whether the task needs visual desktop UI state.", default: false },
        expectedProject: { type: "string", description: "Optional visible Antigravity project text." },
        expectedChat: { type: "string", description: "Optional visible Antigravity chat/conversation title." },
      },
      required: ["goal"],
      additionalProperties: false,
    },
  },
  {
    name: "run-efficient-task",
    description: "One-call efficient execution: plan the route, safely start the chosen worker when possible, and return the compact readback instruction.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "User goal to route and start." },
        workspace: { type: "string", description: "Local workspace path where durable job artifacts should be written." },
        mode: { type: "string", description: "fast, deep, review, or patch.", default: "fast" },
        nextStep: { type: "string", description: "Specific next action for the selected worker.", default: "Inspect the relevant files and write compact artifacts." },
        codexBudgetState: { type: "string", description: "Caller-observed Codex budget state.", default: "unknown" },
        estimatedCodexInputTokens: { type: "number", description: "Rough Codex tokens needed if handled directly.", default: 2000 },
        hasWorkspaceWork: { type: "boolean", description: "Whether the task needs files, diffs, logs, browser state, or project context.", default: true },
        needsVisibleAntigravityChat: { type: "boolean", description: "Whether the task must continue/select a visible Antigravity project/chat.", default: false },
        needsUi: { type: "boolean", description: "Whether the task needs visual desktop UI state.", default: false },
        expectedProject: { type: "string", description: "Optional visible Antigravity project text." },
        expectedChat: { type: "string", description: "Optional visible Antigravity chat/conversation title." },
        modelPreference: { type: "string", description: "Antigravity desktop model preference.", default: "auto" },
        agyModel: { type: "string", description: "Optional Antigravity CLI model id." },
        claudeModel: { type: "string", description: "Optional Claude Code alias override. Auto lets the route choose; routine work defaults to Sonnet.", default: "auto" },
        allowPremiumModels: { type: "boolean", description: "Explicitly allow premium Claude aliases outside the automatic policy. Auto reserves Fable for a healthy dedicated reset opportunity.", default: false },
        cursorModel: { type: "string", description: "Optional Cursor agent model." },
        start: { type: "boolean", description: "Start the selected worker when possible.", default: true },
        submit: { type: "boolean", description: "Submit into Antigravity desktop when that route is selected.", default: true },
      },
      required: ["goal", "workspace"],
      additionalProperties: false,
    },
  },
  {
    name: "team-orchestration-plan",
    description: "Compatibility planning view for the resource orchestrator. Understands the goal, inventories local AI teams/models, builds a work graph, and explains capacity-aware assignments.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "Common project goal for the team." },
        workspace: { type: "string", description: "Local workspace path all lanes should coordinate around." },
        taskSplit: { type: "string", description: "Optional desired lane split, such as UI, backend, testing, docs, review." },
        horizonHours: { type: "number", description: "Capacity planning horizon in hours.", default: 5 },
        codexBudgetState: { type: "string", description: "Caller-observed Codex budget/capacity state.", default: "unknown" },
        estimatedCodexInputTokens: { type: "number", description: "Rough Codex tokens needed if handled without team lanes.", default: 5000 },
        needsVisibleAntigravityChat: { type: "boolean", description: "Whether the Antigravity desktop project/chat must be used instead of the CLI.", default: false },
        expectedProject: { type: "string", description: "Optional visible Antigravity project text." },
        expectedChat: { type: "string", description: "Optional visible Antigravity chat/conversation title." },
        includeCursor: { type: "boolean", description: "Include Cursor as a possible lane only when a true headless cursor-agent is available.", default: false },
      },
      required: ["goal", "workspace"],
      additionalProperties: false,
    },
  },
  {
    name: "codex-usage",
    description: "Read current Codex five-hour/weekly capacity metadata and session token totals from recent local token_count events without returning prompts, responses, paths, or thread ids.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "context-capsule",
    description: "Build a bounded, transcript-free project context capsule with goal, constraints, work graph, evidence fingerprints, acceptance gates, and continuity refs.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "Complete project outcome." },
        workspace: { type: "string", description: "Local project workspace." },
        lifecycleStage: { type: "string", description: "define, plan, execute, verify, review, or ship.", default: "plan" },
        workItems: { type: "array", maxItems: 12, items: projectWorkItemSchema, description: "Task-scoped work items; expectedFiles are fingerprinted without embedding file contents." },
        constraints: { type: "array", items: { type: "string" }, maxItems: 20 },
        decisions: { type: "array", items: { type: "string" }, maxItems: 20 },
        blockers: { type: "array", items: { type: "string" }, maxItems: 12 },
        acceptanceCriteria: { type: "array", items: { type: "string" }, maxItems: 12 },
        verification: { type: "array", items: { type: "string" }, maxItems: 12 },
        continuitySummary: { type: "string", description: "Compact prior-state summary, never a transcript." },
        artifactRefs: { type: "array", items: { type: "string" }, maxItems: 20 },
      },
      required: ["goal", "workspace"],
      additionalProperties: false,
    },
  },
  {
    name: "project-manager-plan",
    description: "Plan-only diagnostic. Build a capacity-aware execution plan without dispatching work. Use run-project-manager for normal project execution.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "Complete project outcome." },
        workspace: { type: "string", description: "Local project workspace shared by workers." },
        workItems: { type: "array", maxItems: 12, items: projectWorkItemSchema, description: "Optional dependency-aware work items. Prefer objective, executionClass, and expectedFiles; common aliases are normalized defensively." },
        constraints: { type: "array", items: { type: "string" }, maxItems: 20 },
        acceptanceCriteria: { type: "array", items: { type: "string" }, maxItems: 12 },
        verification: { type: "array", items: { type: "string" }, maxItems: 12 },
        continuitySummary: { type: "string", description: "Compact prior-state summary." },
        artifactRefs: { type: "array", items: { type: "string" }, maxItems: 20 },
        horizonHours: { type: "number", description: "Capacity/reset planning horizon.", default: 5 },
        mode: { type: "string", description: "fast, deep, review, or patch.", default: "patch" },
        completionPolicy: { type: "string", enum: ["finite", "continuous-management"], description: "Root-objective lifecycle. Use continuous-management for persistent CEO control rooms; their delivery cycles never complete the root Goal.", default: "finite" },
        cycleObjective: { type: "string", description: "Bounded objective for the first delivery cycle. This never replaces the root goal." },
        cycleAcceptanceCriteria: { type: "array", items: { type: "string" }, maxItems: 12 },
        cycleVerification: { type: "array", items: { type: "string" }, maxItems: 12 },
        hostCodexAvailable: { type: "boolean", description: "True only when the current host exposes a native spawn-agent tool.", default: false },
        currentCodexModel: { type: "string", description: "Current caller model label when visible." },
        currentCodexEffort: { type: "string", description: "Current caller effort when visible." },
        includeCursor: { type: "boolean", description: "Include Cursor only when a true headless agent exists.", default: false },
        managerOnly: { type: "boolean", description: "Keep the calling Codex task as a management/reporting control room rather than an implementation worker.", default: true },
        allowAntigravityCli: { type: "boolean", description: "Explicitly allow Antigravity CLI dispatch even though its OAuth flow may open a browser window.", default: false },
        unattendedMode: { type: "boolean", description: "Plan for no-human continuity. Interactive workers are excluded unless their separately authorized non-interactive policy is active.", default: false },
        allowAntigravityPermissionBypass: { type: "boolean", description: "Explicitly allow --dangerously-skip-permissions only for sandboxed Antigravity CLI jobs. Does not authorize OAuth, authentication, CAPTCHA, or external effects.", default: false },
        runDeadlineMinutes: { type: "number", description: "Optional project deadline in minutes. Zero keeps the objective continuous until verified, blocked, or explicitly stopped.", default: 0 },
        capacityCheckpointMinutes: { type: "number", description: "Minutes between rolling capacity reviews. This is not a project deadline.", default: 20 },
        codexManagerReservePercent: { type: "number", description: "Shared Codex capacity reserved for the manager task, steering, and failover. Native Codex workers stop dispatching at or below this percentage.", default: 15 },
        maxConcurrentCodexWorkers: { type: "number", description: "Maximum simultaneous standalone-or-host Codex workers sharing the measured Codex pool. Other providers remain independently parallel.", default: 1 },
        maxParallelWriters: { type: "number", description: "Maximum concurrent writer processes with pairwise disjoint verified file boundaries. Unscoped or overlapping writers remain serialized.", default: 2 },
        maxWorkerMinutes: { type: "number", description: "Optional ceiling for one worker lease. Zero uses complexity-adaptive leases.", default: 0 },
        maxClaudeOutputTokens: { type: "number", description: "Fail closed when one Claude worker reports more output tokens than this budget.", default: 12000 },
        maxClaudeBudgetUsd: { type: "number", description: "Explicit Claude per-worker USD cap. 0 (default) selects the auth-aware automatic policy: claude.ai subscription auth (Pro/Max/Team/Enterprise, no ANTHROPIC_API_KEY) omits --max-budget-usd and relies on measured quota windows plus output-token and lease guards; API-key/PAYG/unknown billing keeps a conservative automatic cap.", default: 0 },
        refreshInventory: { type: "boolean", description: "Force fresh provider probes.", default: false },
      },
      required: ["goal", "workspace"],
      additionalProperties: false,
    },
  },
  {
    name: "run-project-manager",
    description: "Start or resume one root project objective. Inventory capacity, dispatch a bounded first cycle, and return a compact CEO result. For persistent control rooms use completionPolicy=continuous-management; later cycles use project-manager-status.nextWorkItems under the same run id and can never complete the root Goal. Manager-only keeps execution in separate standalone or host-native Codex/provider workers.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "Complete project outcome." },
        workspace: { type: "string", description: "Local project workspace shared by the team." },
        workItems: { type: "array", maxItems: 12, items: projectWorkItemSchema, description: "Optional dependency-aware work graph. Independent items should omit dependsOn so healthy workers can run concurrently." },
        constraints: { type: "array", items: { type: "string" }, maxItems: 20, description: "User and safety constraints propagated to every worker." },
        acceptanceCriteria: { type: "array", items: { type: "string" }, maxItems: 12 },
        verification: { type: "array", items: { type: "string" }, maxItems: 12 },
        taskSplit: { type: "string", description: "Legacy compatibility hint. Prefer workItems for nontrivial goals." },
        horizonHours: { type: "number", description: "Capacity/reset planning horizon.", default: 5 },
        codexModel: { type: "string", description: "Caller-visible current Codex model label.", default: "current Codex session" },
        codexBudgetState: { type: "string", description: "Caller-visible Codex capacity state.", default: "unknown" },
        codexRemainingPercent: { type: "number", description: "Optional caller-visible Codex remaining percentage." },
        codexResetAt: { type: "string", description: "Optional caller-visible Codex reset time." },
        hostCodexAvailable: { type: "boolean", description: "True only when the current Codex host exposes multi_agent_v1__spawn_agent. Enables separate native Codex worker lanes while the parent control-room task remains manager-only.", default: false },
        estimatedCodexInputTokens: { type: "number", description: "Rough direct-work cost used only as a routing signal.", default: 5000 },
        mode: { type: "string", description: "fast, deep, review, or patch.", default: "patch" },
        completionPolicy: { type: "string", enum: ["finite", "continuous-management"], description: "Root-objective lifecycle. Set continuous-management for a persistent CEO control room; worker cycles cannot complete its Codex Goal.", default: "finite" },
        cycleObjective: { type: "string", description: "Bounded objective for the first delivery cycle. The root goal remains unchanged." },
        cycleAcceptanceCriteria: { type: "array", items: { type: "string" }, maxItems: 12 },
        cycleVerification: { type: "array", items: { type: "string" }, maxItems: 12 },
        agyModel: { type: "string", description: "Optional Antigravity model override.", default: "auto" },
        claudeModel: { type: "string", description: "Optional Claude Code model override.", default: "auto" },
        allowPremiumModels: { type: "boolean", description: "Explicitly allow premium Claude aliases outside automatic policy.", default: false },
        allowAntigravityCli: { type: "boolean", description: "Explicitly allow Antigravity CLI dispatch even though its OAuth flow may open a browser window.", default: false },
        unattendedMode: { type: "boolean", description: "Run without waiting for a person at the PC. Interactive resources must be excluded or explicitly pre-authorized.", default: false },
        allowAntigravityPermissionBypass: { type: "boolean", description: "Explicitly allow --dangerously-skip-permissions only for sandboxed Antigravity CLI jobs. Does not authorize OAuth, authentication, CAPTCHA, or external effects.", default: false },
        includeCursor: { type: "boolean", description: "Use Cursor only when a true headless cursor-agent is available.", default: false },
        managerOnly: { type: "boolean", description: "Keep the calling Codex task as a reporting and management control room. When true (default), ordinary project exploration, diagnostics, implementation, tests, and worker takeovers are delegated; only explicit user-boundary or externally consequential actions may return to the current Codex session.", default: true },
        runDeadlineMinutes: { type: "number", description: "Optional project deadline in minutes. Zero keeps the objective continuous until verified, blocked, or explicitly stopped.", default: 0 },
        capacityCheckpointMinutes: { type: "number", description: "Minutes between rolling capacity reviews. This is not a project deadline.", default: 20 },
        codexManagerReservePercent: { type: "number", description: "Shared Codex capacity reserved for management and failover; standalone and host-native Codex workers stop at this threshold.", default: 15 },
        maxConcurrentCodexWorkers: { type: "number", description: "Maximum simultaneous standalone-or-host Codex workers; defaults to one to protect the shared five-hour pool.", default: 1 },
        maxParallelWriters: { type: "number", description: "Maximum concurrent writer processes with pairwise disjoint verified file boundaries. Unscoped or overlapping writers remain serialized.", default: 2 },
        maxWorkerMinutes: { type: "number", description: "Optional ceiling for one worker lease. Zero uses complexity-adaptive leases.", default: 0 },
        maxClaudeOutputTokens: { type: "number", description: "Maximum reported output tokens accepted from one Claude worker.", default: 12000 },
        maxClaudeBudgetUsd: { type: "number", description: "Explicit Claude per-worker USD cap; 0 (default) selects the auth-aware automatic policy.", default: 0 },
        start: { type: "boolean", description: "Dispatch selected workers. False returns a dry plan.", default: true },
        waitSeconds: { type: "number", description: "Initial dispatch receipt wait. Keep 0 so the manager can report assignments immediately, then poll project-manager-status in short visible intervals.", default: 0 },
        refreshInventory: { type: "boolean", description: "Force fresh provider probes before assignment.", default: false },
        includePlan: { type: "boolean", description: "Include detailed decisions. Keep false for token-efficient operation.", default: false },
      },
      required: ["goal", "workspace"],
      additionalProperties: false,
    },
  },
  {
    name: "project-manager-status",
    description: "Continue the latest AI Mobile run. Acknowledge host workers, record finite final verification or continuous cycle verification, append nextWorkItems under the same continuous run id, advance dependency-ready work, and return only CEO-relevant evidence.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Workspace containing the active or latest AI Mobile run." },
        waitSeconds: { type: "number", description: "Optional bounded transition wait. For Goal continuations use 120: the call returns early when recorded work state changes, avoiding repeated short polls.", default: 0 },
        completedCodexItems: { type: "array", items: { type: "string" }, maxItems: 12, description: "Codex-owned work item ids that this chat completed and verified, allowing dependent CLI work to start." },
        failedCodexItems: { type: "array", items: { type: "string" }, maxItems: 12, description: "Codex-owned work item ids that failed or were blocked, preventing unsafe dependent dispatch." },
        takeoverCodexItems: { type: "array", items: { type: "string" }, maxItems: 12, description: "Failed, blocked, or pending worker item ids that the current Codex session will explicitly take over." },
        hostWorkerEvents: {
          type: "array",
          maxItems: 12,
          description: "Acknowledged lifecycle events for native Codex host workers. Every event must match the run, work item, attempt, and attempt-bound dispatch token returned by HostCodexActions.",
          items: {
            type: "object",
            properties: {
              event: { type: "string", enum: ["reserved", "started", "completed", "failed", "cancelled", "cancellation-unconfirmed"] },
              runId: { type: "string" },
              workItemId: { type: "string" },
              attemptId: { type: "string" },
              dispatchToken: { type: "string" },
              agentId: { type: "string" },
              nickname: { type: "string" },
              summary: { type: "string" },
              artifactRefs: { type: "array", items: { type: "string" }, maxItems: 12 },
              changedFiles: { type: "array", items: { type: "string" }, maxItems: 20 },
              testSummary: { type: "string" },
              observedModel: { type: "string" },
              failureCategory: { type: "string" },
            },
            required: ["event", "runId", "workItemId", "attemptId", "dispatchToken"],
            additionalProperties: false,
          },
        },
        codexEvidence: {
          type: "array",
          maxItems: 12,
          description: "Required compact evidence for each completed Codex item.",
          items: {
            type: "object",
            properties: {
              workItemId: { type: "string" },
              summary: { type: "string", description: "Concise verified result; never a transcript or full log." },
              artifactRefs: { type: "array", items: { type: "string" }, maxItems: 12 },
            },
            required: ["workItemId", "summary"],
            additionalProperties: false,
          },
        },
        codexModel: { type: "string", description: "Current Codex model label used when taking over a worker item." },
        projectVerified: { type: "boolean", description: "Mark the active objective complete only after every work item and final project verification passed.", default: false },
        projectVerificationFailed: { type: "boolean", description: "Record a failed final verification after all work items finish, preserving the blocker instead of permitting completion.", default: false },
        projectVerificationSummary: { type: "string", description: "Required compact evidence when final verification is recorded as passed or failed." },
        cycleVerified: { type: "boolean", description: "Record the current continuous-management cycle as verified without completing the root objective or Codex Goal.", default: false },
        cycleVerificationFailed: { type: "boolean", description: "Record the current continuous-management cycle as failed so a bounded correction cycle can follow.", default: false },
        cycleVerificationSummary: { type: "string", description: "Required compact evidence when a continuous-management cycle is recorded as passed or failed." },
        expectedRunId: { type: "string", description: "Exact RunId from the latest status. Required for cycle verification or nextWorkItems so delayed requests cannot mutate another run." },
        expectedCycleId: { type: "string", description: "Exact ActiveCycleId from the latest status. Required for cycle verification or nextWorkItems so retries cannot advance the wrong cycle." },
        nextCycleObjective: { type: "string", description: "Bounded objective for the next cycle in the same durable continuous-management run." },
        nextWorkItems: { type: "array", maxItems: 12, items: projectWorkItemSchema, description: "Dependency-aware work for the next cycle. Requires the prior cycle to be verified or failed; keeps the same run id and root goal." },
        nextCycleAcceptanceCriteria: { type: "array", items: { type: "string" }, maxItems: 12 },
        nextCycleVerification: { type: "array", items: { type: "string" }, maxItems: 12 },
        refreshInventory: { type: "boolean", description: "Refresh provider capacity before assigning nextWorkItems.", default: false },
        addConstraints: { type: "array", items: { type: "string" }, maxItems: 20, description: "New user constraints to persist before any continuation work." },
        steeringDirective: { type: "string", description: "Latest user steering instruction or safety correction." },
        interruptRunningWorkers: { type: "boolean", description: "Cancel running external workers before applying new steering. Defaults true when constraints or a directive are supplied." },
        stopRun: { type: "boolean", description: "Stop the active objective and cancel external workers.", default: false },
        stopReason: { type: "string", description: "Required reason when stopping the run." },
      },
      required: ["workspace"],
      additionalProperties: false,
    },
  },
  {
    name: "orchestrator-profile",
    description: "Read or update the private local communication/model policy profile. Personal preferences remain outside the public plugin repository.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["get", "set"], default: "get" },
        communicationStyle: { type: "string", enum: ["professional", "royal"] },
        address: { type: "string", description: "Optional local form of address." },
        updateStyle: { type: "string", enum: ["concise-executive", "technical", "minimal"] },
        role: { type: "string", description: "Local project-manager role label." },
        codexModelAllowPattern: { type: "string", description: "Local regex policy for standalone and host-native Codex models." },
        claudeModelAllowPattern: { type: "string", description: "Local regex allow policy for Claude Code model aliases and ids." },
        claudePreferredModelPattern: { type: "string", description: "Local regex preference used to favor a Claude model when capability and quota are otherwise suitable." },
        antigravityPreferredTaskPattern: { type: "string", description: "Local regex describing task kinds and objectives that should preferentially use Antigravity." },
        modelPolicyReviewAfter: { type: "string", description: "Optional ISO date after which model policy should be reviewed." },
        adaptiveRouting: { type: "boolean", description: "Learn project affinity from verified successes and penalize recent failures.", default: true },
        cliFirst: { type: "boolean" },
        uiFallbackOnly: { type: "boolean" },
        antigravityAutoApprovePermissions: { type: "boolean", description: "Private local opt-in for Antigravity CLI --dangerously-skip-permissions during explicitly unattended, sandboxed runs. Does not authorize OAuth, CAPTCHA, authentication, or external effects.", default: false },
      },
      additionalProperties: false,
    },
  },
  {
    name: "resource-inventory",
    description: "Inspect the local AI team without starting apps or work: Codex local capacity metadata/catalog, Claude Code, Antigravity CLI/models/live quota when already running, Cursor, cooldowns, and evidence freshness.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Optional project workspace used for continuity and recent outcome evidence." },
        codexModel: { type: "string", description: "Caller-visible current Codex model label. The plugin cannot read Codex's private model/session ledger.", default: "current Codex session" },
        codexBudgetState: { type: "string", description: "Caller-visible Codex capacity, such as healthy, medium, low, critical, unknown, or exact UI text.", default: "unknown" },
        codexRemainingPercent: { type: "number", description: "Optional caller-visible Codex remaining percentage." },
        codexResetAt: { type: "string", description: "Optional caller-visible Codex reset time." },
        horizonHours: { type: "number", description: "Decision horizon for resets and cooldowns.", default: 5 },
        hostCodexAvailable: { type: "boolean", description: "True when the current host exposes native Codex subagents.", default: false },
        includeCursor: { type: "boolean", description: "Probe for a true headless Cursor agent.", default: false },
        refresh: { type: "boolean", description: "Refresh CLI model/auth probes instead of accepting a recent safe cache.", default: false },
      },
      additionalProperties: false,
    },
  },
  {
    name: "orchestrate-project",
    description: "Primary AI Mobile call. Act as a resource orchestrator: understand the goal, discover available teams/models and capacity evidence, create a dependency-aware work graph, dispatch CLI workers, monitor compact artifacts, fail over once when justified, and return Codex integration actions.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "The complete project outcome, not merely a lane name." },
        workspace: { type: "string", description: "Local project workspace shared by the team." },
        workItems: {
          type: "array",
          description: "Optional goal-derived work graph. Codex should provide this for complex work; the orchestrator creates a conservative graph when omitted.",
          maxItems: 12,
          items: projectWorkItemSchema,
        },
        constraints: { type: "array", items: { type: "string" }, maxItems: 20, description: "User and safety constraints propagated to every worker." },
        acceptanceCriteria: { type: "array", items: { type: "string" }, maxItems: 12 },
        verification: { type: "array", items: { type: "string" }, maxItems: 12 },
        taskSplit: { type: "string", description: "Legacy compatibility hint. Prefer workItems for nontrivial goals." },
        horizonHours: { type: "number", description: "Capacity and continuity decision horizon.", default: 5 },
        codexModel: { type: "string", description: "Caller-visible current Codex model label.", default: "current Codex session" },
        codexBudgetState: { type: "string", description: "Caller-visible Codex capacity state.", default: "unknown" },
        codexRemainingPercent: { type: "number", description: "Optional caller-visible Codex remaining percentage." },
        codexResetAt: { type: "string", description: "Optional caller-visible Codex reset time." },
        estimatedCodexInputTokens: { type: "number", description: "Rough direct-work cost used only as a routing signal.", default: 5000 },
        mode: { type: "string", description: "fast, deep, review, or patch.", default: "patch" },
        agyModel: { type: "string", description: "Optional Antigravity model override. Auto lets the orchestrator choose by capability and capacity.", default: "auto" },
        claudeModel: { type: "string", description: "Optional Claude Code alias override. Auto lets the orchestrator choose while routine work defaults to Sonnet.", default: "auto" },
        allowPremiumModels: { type: "boolean", description: "Explicitly allow premium Claude aliases outside the automatic policy. Routine work stays off premium models.", default: false },
        allowAntigravityCli: { type: "boolean", description: "Explicitly allow Antigravity CLI dispatch even though its OAuth flow may open a browser window.", default: false },
        unattendedMode: { type: "boolean", description: "Run without waiting for a person at the PC. Interactive resources are excluded unless separately pre-authorized.", default: false },
        allowAntigravityPermissionBypass: { type: "boolean", description: "Explicitly allow --dangerously-skip-permissions only for sandboxed Antigravity CLI jobs. Does not authorize OAuth, authentication, CAPTCHA, or external effects.", default: false },
        includeCursor: { type: "boolean", description: "Use Cursor only if a real headless cursor-agent is available.", default: false },
        runDeadlineMinutes: { type: "number", description: "Optional project deadline in minutes. Zero keeps the objective continuous until verified, blocked, or explicitly stopped.", default: 0 },
        capacityCheckpointMinutes: { type: "number", description: "Minutes between rolling capacity reviews. This is not a project deadline.", default: 20 },
        codexManagerReservePercent: { type: "number", description: "Shared Codex capacity reserved for the manager task, steering, and recovery.", default: 15 },
        maxConcurrentCodexWorkers: { type: "number", description: "Maximum simultaneous standalone-or-host Codex workers; other providers remain independently parallel.", default: 1 },
        maxParallelWriters: { type: "number", description: "Maximum concurrent writer processes with pairwise disjoint verified file boundaries.", default: 2 },
        maxWorkerMinutes: { type: "number", description: "Optional ceiling for one worker lease. Zero uses complexity-adaptive leases.", default: 0 },
        maxClaudeOutputTokens: { type: "number", description: "Maximum reported output tokens accepted from one Claude worker.", default: 12000 },
        maxClaudeBudgetUsd: { type: "number", description: "Explicit Claude per-worker USD cap; 0 (default) selects the auth-aware automatic policy.", default: 0 },
        start: { type: "boolean", description: "Dispatch selected workers. False returns the decision and work graph only.", default: true },
        waitSeconds: { type: "number", description: "Bounded wait for compact worker artifacts.", default: 30 },
        refreshInventory: { type: "boolean", description: "Force fresh CLI probes before assigning work.", default: false },
        includePlan: { type: "boolean", description: "Include detailed decisions; false returns the compact operating result.", default: false },
      },
      required: ["goal", "workspace"],
      additionalProperties: false,
    },
  },
  {
    name: "run-team-task",
    description: "Compatibility alias for orchestrate-project. Existing taskSplit callers still work; new callers should use a structured work graph.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "Common project goal for the team." },
        workspace: { type: "string", description: "Local workspace path where durable team job artifacts should be written." },
        taskSplit: { type: "string", description: "Optional desired lane split, such as UI, backend, testing, docs, review." },
        horizonHours: { type: "number", description: "Capacity planning horizon in hours.", default: 5 },
        codexBudgetState: { type: "string", description: "Caller-observed Codex budget/capacity state.", default: "unknown" },
        estimatedCodexInputTokens: { type: "number", description: "Rough Codex tokens needed if handled without team lanes.", default: 5000 },
        mode: { type: "string", description: "fast, deep, review, or patch.", default: "fast" },
        agyModel: { type: "string", description: "Optional Antigravity CLI model id. Use auto or omit it for capacity-aware Flash-first selection.", default: "auto" },
        claudeModel: { type: "string", description: "Optional Claude Code alias override. Auto lets the orchestrator choose.", default: "auto" },
        includeCursor: { type: "boolean", description: "Include Cursor as a possible lane only when a true headless cursor-agent is available.", default: false },
        start: { type: "boolean", description: "Start available worker lanes. Use false for plan-only dry runs.", default: true },
        waitSeconds: { type: "number", description: "Bounded time to wait for worker artifacts before returning a resumable running result.", default: 30 },
        includePlan: { type: "boolean", description: "Include the full five-hour plan in the launch output. Defaults false to save tokens.", default: false },
      },
      required: ["goal", "workspace"],
      additionalProperties: false,
    },
  },
  {
    name: "read-team-run",
    description: "Read and optionally wait for the latest team run as one compact aggregate. Repairs stale jobs and never reports completion while a worker is running or failed.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Workspace containing .antigravity-bridge/last-team-run.json." },
        waitSeconds: { type: "number", description: "Optional bounded wait for running jobs before returning.", default: 0 },
      },
      required: ["workspace"],
      additionalProperties: false,
    },
  },
  {
    name: "create-job",
    description: "Create a durable Antigravity bridge job folder with request/status/result/diff artifact files. Does not touch the UI.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "Task goal for Antigravity." },
        workspace: { type: "string", description: "Local workspace path where .antigravity-bridge/jobs will be created." },
        mode: { type: "string", description: "fast, deep, review, or patch.", default: "fast" },
        nextStep: { type: "string", description: "Specific next action.", default: "Inspect the relevant files and write compact artifacts." },
      },
      required: ["goal", "workspace"],
      additionalProperties: false,
    },
  },
  {
    name: "submit-job",
    description: "Create a durable job folder, then submit the standardized artifact handoff into the selected Antigravity chat.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "Task goal for Antigravity." },
        workspace: { type: "string", description: "Local workspace path where .antigravity-bridge/jobs will be created." },
        mode: { type: "string", description: "fast, deep, review, or patch.", default: "fast" },
        nextStep: { type: "string", description: "Specific next action.", default: "Inspect the relevant files and write compact artifacts." },
        expectedProject: { type: "string", description: "Optional visible project text that must be present before submit." },
        expectedChat: { type: "string", description: "Optional visible chat/conversation text that must be present before submit." },
        modelPreference: { type: "string", description: "auto, flash-high, flash-medium, flash, best-available, or exact visible model name.", default: "auto" },
        submit: { type: "boolean", description: "Set true to fill and submit the job handoff.", default: true },
      },
      required: ["goal", "workspace"],
      additionalProperties: false,
    },
  },
  {
    name: "select-chat",
    description: "Select an existing visible Antigravity project/chat and verify it before model switching or submission.",
    inputSchema: {
      type: "object",
      properties: {
        expectedProject: { type: "string", description: "Optional visible project text that should be present before selection." },
        expectedChat: { type: "string", description: "Required visible chat/conversation title to activate." },
      },
      required: ["expectedChat"],
      additionalProperties: false,
    },
  },
  {
    name: "agy-status",
    description: "Report whether the official Antigravity CLI (agy) is installed for low-RAM terminal agent work. Does not start the desktop UI.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "agy-models",
    description: "List models available to the official Antigravity CLI without opening the desktop UI.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "submit-agy-job",
    description: "Create a durable bridge job and run the official Antigravity CLI in print mode, avoiding the desktop UI unless visual project/chat state is needed.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "Task goal for Antigravity CLI." },
        workspace: { type: "string", description: "Local workspace path where .antigravity-bridge/jobs will be created." },
        mode: { type: "string", description: "fast, deep, review, or patch.", default: "fast" },
        nextStep: { type: "string", description: "Specific next action.", default: "Inspect the relevant files and write compact artifacts." },
        model: { type: "string", description: "Antigravity CLI model id/name, such as gemini-3.5-flash-low.", default: "gemini-3.5-flash-low" },
        project: { type: "string", description: "Optional Antigravity CLI project id." },
        conversation: { type: "string", description: "Optional Antigravity CLI conversation id to resume." },
        continueLatest: { type: "boolean", description: "Continue the most recent Antigravity CLI conversation.", default: false },
        sandbox: { type: "boolean", description: "Run Antigravity CLI with terminal sandbox restrictions enabled.", default: true },
        autoApprovePermissions: { type: "boolean", description: "Pass --dangerously-skip-permissions for this sandboxed worker. Requires explicit user authorization and never authorizes external effects or authentication bypass.", default: false },
        printTimeout: { type: "string", description: "Antigravity CLI print timeout, such as 30m or 90s.", default: "30m" },
        expectedFiles: { type: "array", items: { type: "string" }, maxItems: 20, description: "Enforced writer file boundary." },
        readOnly: { type: "boolean", description: "Treat this as a read-only worker assignment.", default: true },
        start: { type: "boolean", description: "Set false to create the job without starting Antigravity CLI.", default: true },
        maxMinutes: { type: "number", description: "Maximum minutes the direct background Antigravity CLI worker may run.", default: 30 },
        verificationCommands: projectWorkItemSchema.properties.verificationCommands,
      },
      required: ["goal", "workspace"],
      additionalProperties: false,
    },
  },
  {
    name: "codex-cli-status",
    description: "Report whether the official standalone Codex CLI is installed and authenticated through the ChatGPT plan. Does not run a model prompt.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "submit-codex-job",
    description: "Create a durable headless Codex worker job using the measured shared Codex capacity and manager reserve. Refuses non-ChatGPT-plan authentication.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "Bounded work-item goal for the standalone Codex worker." },
        workspace: { type: "string", description: "Local workspace path where durable bridge evidence is stored." },
        mode: { type: "string", description: "review for read-only work or patch for a bounded writer.", default: "review" },
        nextStep: { type: "string", description: "Specific next action for this worker." },
        model: { type: "string", description: "Exact model id from the local Codex catalog, such as gpt-5.6-luna." },
        effort: { type: "string", description: "Supported reasoning effort for the selected model.", default: "medium" },
        expectedFiles: { type: "array", items: { type: "string" }, maxItems: 20, description: "Enforced writer file boundary." },
        readOnly: { type: "boolean", description: "Use the read-only sandbox when true.", default: true },
        start: { type: "boolean", description: "Set false to create the durable job without starting Codex.", default: true },
        maxMinutes: { type: "number", description: "Maximum minutes the background Codex worker may run.", default: 30 },
      },
      required: ["goal", "workspace", "model"],
      additionalProperties: false,
    },
  },
  {
    name: "claude-status",
    description: "Report whether local Claude Code CLI is installed and usable for headless bridge jobs. Does not start a job.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "claude-usage",
    description: "Read Claude subscription 5-hour, all-model weekly, and model-specific weekly usage/reset windows through the built-in /usage command. Does not run a model prompt.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "submit-claude-job",
    description: "Create a durable bridge job and run local Claude Code headlessly against the workspace, writing the same compact artifacts Codex can read later.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "Task goal for Claude Code." },
        workspace: { type: "string", description: "Local workspace path where .antigravity-bridge/jobs will be created." },
        mode: { type: "string", description: "fast, deep, review, or patch.", default: "fast" },
        nextStep: { type: "string", description: "Specific next action.", default: "Inspect the relevant files and write compact artifacts." },
        model: { type: "string", description: "Claude Code model alias or id, such as sonnet or opus.", default: "sonnet" },
        effort: { type: "string", description: "Current Claude CLI effort level, such as low, medium, high, xhigh, or max." },
        fallbackModel: { type: "string", description: "Optional Claude Code fallback model alias or id." },
        permissionMode: { type: "string", description: "Claude Code permission mode. Defaults to plan for review and acceptEdits otherwise." },
        maxBudgetUsd: { type: "number", description: "Optional explicit Claude Code USD cap for this job. When omitted, the auth-aware automatic policy applies: subscription auth runs uncapped against measured quota windows; API-key/PAYG/unknown billing gets a conservative automatic cap." },
        maxOutputTokens: { type: "number", description: "Fail the worker result when Claude reports output above this token budget." },
        expectedFiles: { type: "array", items: { type: "string" }, maxItems: 20, description: "Enforced writer file boundary." },
        readOnly: { type: "boolean", description: "Treat this as a read-only worker assignment.", default: true },
        start: { type: "boolean", description: "Set false to create the job and payload without starting Claude Code.", default: true },
        maxMinutes: { type: "number", description: "Maximum minutes the direct background Claude worker may run.", default: 30 },
        verificationCommands: projectWorkItemSchema.properties.verificationCommands,
      },
      required: ["goal", "workspace"],
      additionalProperties: false,
    },
  },
  {
    name: "cursor-status",
    description: "Report whether Cursor is installed and whether a true headless cursor-agent binary is available. Does not open Cursor.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "open-cursor",
    description: "Open Cursor UI for a workspace or standalone chat when a visual Cursor workflow is needed.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Optional local workspace path to open in Cursor." },
        chat: { type: "boolean", description: "Open Cursor standalone chat UI.", default: false },
        newWindow: { type: "boolean", description: "Open in a new Cursor window.", default: false },
        reuseWindow: { type: "boolean", description: "Reuse the last active Cursor window.", default: true },
      },
      additionalProperties: false,
    },
  },
  {
    name: "submit-cursor-job",
    description: "Create a durable bridge job and run a true headless Cursor agent when cursor-agent is installed. Fails closed if only the Cursor UI launcher is available.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "Task goal for Cursor agent." },
        workspace: { type: "string", description: "Local workspace path where .antigravity-bridge/jobs will be created." },
        mode: { type: "string", description: "fast, deep, review, or patch.", default: "fast" },
        nextStep: { type: "string", description: "Specific next action.", default: "Inspect the relevant files and write compact artifacts." },
        model: { type: "string", description: "Optional Cursor agent model id or alias." },
        expectedFiles: { type: "array", items: { type: "string" }, maxItems: 20, description: "Enforced writer file boundary." },
        readOnly: { type: "boolean", description: "Treat this as a read-only worker assignment.", default: true },
        start: { type: "boolean", description: "Set false to create the job without starting Cursor agent.", default: true },
        maxMinutes: { type: "number", description: "Maximum minutes the direct background Cursor worker may run.", default: 30 },
        verificationCommands: projectWorkItemSchema.properties.verificationCommands,
      },
      required: ["goal", "workspace"],
      additionalProperties: false,
    },
  },
  {
    name: "list-jobs",
    description: "List durable Antigravity bridge jobs from a workspace without reading chats or logs.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Local workspace path containing .antigravity-bridge/jobs." },
        limit: { type: "number", description: "Maximum jobs to return.", default: 10 },
      },
      required: ["workspace"],
      additionalProperties: false,
    },
  },
  {
    name: "read-job",
    description: "Read only compact result artifacts for one Antigravity bridge job.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Local workspace path containing .antigravity-bridge/jobs." },
        jobId: { type: "string", description: "Job id. Use latest to read the newest job.", default: "latest" },
      },
      required: ["workspace"],
      additionalProperties: false,
    },
  },
  {
    name: "cancel-job",
    description: "Mark a durable Antigravity bridge job cancelled. This does not stop a running Antigravity UI task.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Local workspace path containing .antigravity-bridge/jobs." },
        jobId: { type: "string", description: "Job id. Use latest to cancel the newest job.", default: "latest" },
        reason: { type: "string", description: "Short cancellation reason.", default: "Cancelled by Codex." },
      },
      required: ["workspace"],
      additionalProperties: false,
    },
  },
  {
    name: "retry-job",
    description: "Resubmit an existing durable job request to the selected Antigravity chat.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Local workspace path containing .antigravity-bridge/jobs." },
        jobId: { type: "string", description: "Job id. Use latest to retry the newest job.", default: "latest" },
        expectedProject: { type: "string", description: "Optional visible project text that must be present before submit." },
        expectedChat: { type: "string", description: "Optional visible chat/conversation text that must be present before submit." },
        modelPreference: { type: "string", description: "auto, flash-high, flash-medium, flash, best-available, or exact visible model name.", default: "auto" },
        submit: { type: "boolean", description: "Set true to fill and submit the job handoff.", default: true },
      },
      required: ["workspace"],
      additionalProperties: false,
    },
  },
  {
    name: "submit-offload",
    description: "Fast path: prepare and submit a compact handoff into the currently selected Antigravity chat via direct CDP, avoiding repeated snapshots.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "Task goal for Antigravity." },
        workspace: { type: "string", description: "Local workspace path or Antigravity project name." },
        statusFile: { type: "string", description: "Small artifact Antigravity should write.", default: "notes/antigravity-status.md" },
        nextStep: { type: "string", description: "Specific next action.", default: "Inspect the relevant files and write a compact status checkpoint." },
        expectedProject: { type: "string", description: "Optional visible project text that must be present before submit." },
        expectedChat: { type: "string", description: "Optional visible chat/conversation text that must be present before submit." },
        modelPreference: { type: "string", description: "Model preference before submit. Use auto, flash-high, flash-medium, flash, best-available, or an exact visible model name.", default: "auto" },
        skipModelSwitch: { type: "boolean", description: "Set true only when the current model was just verified manually.", default: false },
        submit: { type: "boolean", description: "Set true to fill and click Send.", default: false },
        fillOnly: { type: "boolean", description: "Set true to fill the composer without clicking Send. Use only when the user wants a manual review before submit.", default: false },
      },
      required: ["goal", "submit"],
      additionalProperties: false,
    },
  },
  {
    name: "switch-model",
    description: "Switch the active Antigravity chat to an available model through the local CDP bridge. Use before offloads when Sonnet/Opus is exhausted or when the user asks for Flash.",
    inputSchema: {
      type: "object",
      properties: {
        modelPreference: { type: "string", description: "auto, flash-high, flash-medium, flash, best-available, or an exact visible model name.", default: "flash-medium" },
        expectedProject: { type: "string", description: "Optional visible project text that must be present before switching." },
        expectedChat: { type: "string", description: "Optional visible chat/conversation text that must be present before switching." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "limits-summary",
    description: "Preferred quota check. Compact model availability summary without dumping full per-model JSON.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "limits",
    description: "Read full Antigravity model quota/limit state from the local language server. Use limits-summary first to save tokens.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "models",
    description: "Alias for limits. Read Antigravity model quota/limit state.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "privacy",
    description: "Scan this plugin repository for obvious sensitive data before publishing.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "handoff-template",
    description: "Generate a compact Antigravity offload prompt without reading files or using DevTools UI tokens.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "Task goal for Antigravity." },
        workspace: { type: "string", description: "Local workspace path or project name." },
        statusFile: { type: "string", description: "Small artifact Antigravity should write.", default: "notes/antigravity-status.md" },
        nextStep: { type: "string", description: "Specific next action.", default: "Inspect the relevant files and write a compact status checkpoint." },
      },
      required: ["goal"],
      additionalProperties: false,
    },
  },
  {
    name: "offload-advice",
    description: "Cheap decision gate for whether Codex should offload a task to Antigravity or answer/act directly.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "User task or intended Antigravity handoff." },
        hasWorkspaceWork: { type: "boolean", description: "Whether the task needs local project files, diffs, logs, or long workspace inspection.", default: false },
        estimatedCodexInputTokens: { type: "number", description: "Rough Codex tokens needed if handled directly.", default: 0 },
      },
      required: ["goal"],
      additionalProperties: false,
    },
  },
];

const defaultMcpToolNames = new Set([
  "quick",
  "setup",
  "doctor",
  "codex-usage",
  "project-manager-plan",
  "run-project-manager",
  "project-manager-status",
  "orchestrator-profile",
  "resource-inventory",
  "privacy",
]);

function exposedMcpTools(exposeAdvanced = process.env.AI_MOBILE_EXPOSE_ADVANCED_TOOLS) {
  const advanced = /^(1|true|yes|on)$/i.test(String(exposeAdvanced || "").trim());
  return advanced ? tools : tools.filter((tool) => defaultMcpToolNames.has(tool.name));
}

let transportMode = null;

function sendMessage(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (transportMode === "content-length") {
    process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
    process.stdout.write(body);
    return;
  }
  process.stdout.write(`${body.toString("utf8")}\n`);
}

function sendResult(id, result) {
  sendMessage({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  sendMessage({ jsonrpc: "2.0", id, error: { code, message } });
}

function runHelper(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", helperScript, command],
      { windowsHide: true }
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `antigravity.ps1 ${command} exited with code ${code}`));
        return;
      }

      const text = stdout.trim();
      if (!text) {
        resolve("");
        return;
      }

      try {
        resolve(JSON.parse(text));
      } catch {
        resolve(text);
      }
    });
  });
}

function buildHandoffTemplate(args = {}) {
  const goal = String(args.goal || "<goal>").trim();
  const workspace = String(args.workspace || "<workspace/path>").trim();
  const statusFile = String(args.statusFile || "notes/antigravity-status.md").trim();
  const nextStep = String(args.nextStep || "Inspect the relevant files and write a compact status checkpoint.").trim();

  return [
    "Use this as a compact Antigravity offload handoff:",
    "",
    "```text",
    `Goal: ${goal}`,
    `Workspace: ${workspace}`,
    orchestrated ? `ControlRoomMode: ${snapshot.managerOnly === true ? "manager-only" : "manager-and-integrator"}` : null,
    orchestrated && snapshot.managerOnly === true ? "RequiredHostBehavior: use AI Mobile status/steering calls and compact worker artifacts only; do not scan project files, run project diagnostics/tests, edit source, or silently take over worker work." : null,
    "Constraints: inspect files locally; do not paste full files, full logs, or full source; use search before reading whole files.",
    `Token rule: work token-efficiently; write progress to ${statusFile}; output max 10 bullets plus changed file list.`,
    `Next step: ${nextStep}`,
    "If blocked: ask one concise question; otherwise continue autonomously.",
    "```",
    "",
    "Codex follow-up rule: do not read the full Antigravity chat. Read only the status artifact, targeted diffs, or a compact visible UI status.",
  ].join("\n");
}

function getOffloadDecision(args = {}) {
  const goal = String(args.goal || "").trim();
  const hasWorkspaceWork = Boolean(args.hasWorkspaceWork);
  const estimatedCodexInputTokens = Number(args.estimatedCodexInputTokens || 0);
  const lowerGoal = goal.toLowerCase();
  const trivialPattern = /\b(2\s*\+\s*2|add\s+2\s*\+\s*2|what\s+is|time|date|summari[sz]e\s+this\s+short|one\s+line|yes\s+or\s+no)\b/;
  const workspacePattern = /\b(repo|workspace|project|files?|diff|logs?|tests?|build|lint|implement|refactor|debug|apply|continue\s+chat|job\s+search|browser|ui|analy[sz]e|review|plan|research|inspect|investigate|fix|patch|error|failure|trace|search|compare)\b/;

  const trivial = trivialPattern.test(lowerGoal) || (!hasWorkspaceWork && estimatedCodexInputTokens > 0 && estimatedCodexInputTokens < 400);
  const workspaceLikely = hasWorkspaceWork || workspacePattern.test(lowerGoal) || estimatedCodexInputTokens >= 800;
  const shouldOffload = workspaceLikely && !trivial;

  const decision = shouldOffload ? "offload-to-antigravity" : "codex-direct";
  const reason = shouldOffload
    ? "The task appears to benefit from Antigravity inspecting the local workspace or running longer reasoning while Codex reads back a compact artifact."
    : "The task is small enough that DevTools navigation, project context scanning, and Antigravity startup/agent overhead will likely cost more time and tokens than Codex answering directly.";

  return { decision, reason, shouldOffload };
}

function buildOffloadAdvice(args = {}) {
  const { decision, reason } = getOffloadDecision(args);
  return [
    `Decision: ${decision}`,
    `Reason: ${reason}`,
    "",
    "Rules:",
    "- Use Codex direct only for arithmetic, short factual answers, tiny commands, and small summaries.",
    "- Use Antigravity by default for nontrivial workspace tasks, UI/project continuation, job-search/application work, debugging, implementation, reviews, research, planning, and analysis that would make Codex read files or long output.",
    "- In existing project chats, assume Antigravity may scan attached folders. For small tests, use a blank/no-workspace chat when available or do not offload.",
    "- If Antigravity unexpectedly starts broad folder exploration for a small task, cancel and report that offload is not token-efficient.",
    "- When offloading, send a compact handoff and ask Antigravity to write a small status artifact; Codex should read only that artifact or a targeted diff.",
  ].join("\n");
}

function buildPrepareOffload(args = {}, quick = null) {
  const decision = getOffloadDecision(args);
  const handoff = buildHandoffTemplate(args).replace(/^Use this as a compact Antigravity offload handoff:\n\n/, "");
  const setup = quick?.Setup || {};
  const live = quick?.Live || {};
  const recommended = quick?.Limits?.RecommendedAvailable?.[0] || null;
  const readiness = [
    `Installed: ${setup.Installed === true}`,
    `Running: ${setup.Running === true}`,
    `LiveReady: ${setup.ReadyForLiveUiInspection === true}`,
    `PageCount: ${live.PageCount ?? "<unknown>"}`,
    `BestModel: ${recommended ? `${recommended.DisplayName || recommended.Id} (${recommended.RemainingPercent ?? "?"}% remaining)` : "<unknown>"}`,
  ].join("\n");

  const nextAction = decision.shouldOffload
    ? "First call ai-mobile-local.switch-model with modelPreference=auto or flash-medium. Then call submit-offload with submit=true. Avoid raw DevTools choreography unless the direct tools fail."
    : "Do not open or drive Antigravity for this task. Answer or act directly in Codex.";

  return [
    "FastAntigravityOffloadPlan:",
    `Decision: ${decision.decision}`,
    `Reason: ${decision.reason}`,
    "",
    "Readiness:",
    readiness,
    "",
    "NextAction:",
    nextAction,
    "",
    "SubmitRule:",
    "Fill/type the prompt without submitKey. Prefer clicking the visible Send/arrow button. If keyboard submit is required, use a separate simple Enter key call. Never use Control+Enter unless the active tool schema explicitly accepts it.",
    "",
    "CompactHandoff:",
    handoff,
  ].join("\n");
}

function parseFoundFromStatus(text) {
  return /\bFound:\s*true\b/i.test(String(text || ""));
}

function normalizeBudgetState(value) {
  const text = String(value || "unknown").trim();
  const lower = text.toLowerCase();
  if (/\b(exhausted|blocked|zero|0%|limit reached)\b/.test(lower)) return { state: "exhausted", text };
  if (/\b(critical|very low|almost gone|near limit|running out)\b/.test(lower)) return { state: "critical", text };
  if (/\b(low|limited|mini|small budget)\b/.test(lower)) return { state: "low", text };
  if (/\b(medium|moderate|ok)\b/.test(lower)) return { state: "medium", text };
  if (/\b(healthy|high|full|plenty)\b/.test(lower)) return { state: "healthy", text };
  return { state: "unknown", text };
}

async function buildOrchestrationPlan(args = {}) {
  const goal = String(args.goal || "").trim();
  const workspace = String(args.workspace || "").trim();
  const estimatedCodexInputTokens = Number(args.estimatedCodexInputTokens || 2000);
  const hasWorkspaceWork = args.hasWorkspaceWork !== false;
  const needsVisibleAntigravityChat = Boolean(args.needsVisibleAntigravityChat || args.expectedChat);
  const needsUi = Boolean(args.needsUi || needsVisibleAntigravityChat);
  const expectedProject = String(args.expectedProject || "").trim();
  const expectedChat = String(args.expectedChat || "").trim();
  const codexBudget = normalizeBudgetState(args.codexBudgetState || "unknown");
  const offload = getOffloadDecision({ goal, hasWorkspaceWork, estimatedCodexInputTokens });

  let quick = null;
  let quickError = "";
  try {
    quick = await runHelper("quick");
  } catch (error) {
    quickError = error?.message || String(error);
  }

  const agyStatusText = getAgyStatusText();
  const claudeStatusText = getClaudeStatusText();
  const cursorStatusText = getCursorStatusText();
  const antigravitySetup = quick?.Setup || {};
  const antigravityLive = quick?.Live || {};
  const limits = quick?.Limits || {};
  const antigravityAvailable = Array.isArray(limits.RecommendedAvailable) ? limits.RecommendedAvailable : [];
  const bestAgModel = antigravityAvailable[0] || null;
  const agyFound = parseFoundFromStatus(agyStatusText);
  const claudeFound = parseFoundFromStatus(claudeStatusText);
  const cursorHeadlessFound = /\bHeadlessAgentFound:\s*true\b/i.test(cursorStatusText);
  const antigravityLimitText = bestAgModel
    ? `${bestAgModel.DisplayName || bestAgModel.Id} (${bestAgModel.RemainingPercent ?? "?"}% remaining)`
    : "no recommended available Antigravity model reported";
  const antigravityHealthy = antigravitySetup.ReadyForModelLimits === true && antigravityAvailable.length > 0;
  const visibleReady = antigravitySetup.ReadyForLiveUiInspection === true && Number(antigravityLive.PageCount || 0) > 0;

  const lowerGoal = goal.toLowerCase();
  const codeReviewLikely = /\b(code|repo|review|refactor|patch|diff|test|lint|bug|implementation|architecture)\b/.test(lowerGoal);
  const cursorLikely = /\bcursor\b/.test(lowerGoal);
  let route = "codex-direct";
  let worker = "Codex";
  let reason = "Task appears small enough for Codex direct work.";
  const nextCalls = [];
  const fallback = [];

  if (cursorLikely && cursorHeadlessFound) {
    route = "cursor-headless";
    worker = "Cursor agent";
    reason = "The task explicitly belongs in Cursor and a true headless cursor-agent is available.";
    nextCalls.push("ai-mobile-local.submit-cursor-job");
    fallback.push("If cursor-agent fails, use Codex direct for final patch or Antigravity CLI for broad review.");
  } else if (needsVisibleAntigravityChat) {
    route = "antigravity-desktop-chat";
    worker = "Antigravity desktop";
    reason = "The task names or requires a visible Antigravity project/chat; UI state is the source of truth.";
    nextCalls.push("ai-mobile-local.select-chat");
    nextCalls.push("ai-mobile-local.switch-model");
    nextCalls.push("ai-mobile-local.submit-job or submit-offload");
    fallback.push("If select-chat is not Ok, stop and report visible candidates; do not use a new or wrong chat.");
    fallback.push("If the requested model is exhausted, switch to the best available Antigravity model.");
  } else if (offload.shouldOffload && agyFound && antigravityHealthy && !needsUi) {
    route = "antigravity-cli";
    worker = "Antigravity CLI";
    reason = "Nontrivial workspace work can be done in low-RAM Antigravity CLI without desktop UI.";
    nextCalls.push("ai-mobile-local.submit-agy-job");
    nextCalls.push("ai-mobile-local.read-job");
    fallback.push("If Antigravity CLI fails, use Claude Code for code/review tasks or Antigravity desktop when UI state is needed.");
  } else if (offload.shouldOffload && codeReviewLikely && claudeFound) {
    route = "claude-code";
    worker = "Claude Code CLI";
    reason = "This is local code/review work and Claude Code is available; no Antigravity UI context is required.";
    nextCalls.push("ai-mobile-local.submit-claude-job");
    nextCalls.push("ai-mobile-local.read-job");
    fallback.push("If Claude Code is not logged in or fails, use Antigravity CLI when available; otherwise Codex does a narrow patch.");
  } else if (offload.shouldOffload && visibleReady) {
    route = "antigravity-desktop";
    worker = "Antigravity desktop";
    reason = "The task should be offloaded and desktop UI is available, but CLI/headless routes are not preferred for this shape.";
    nextCalls.push("ai-mobile-local.submit-job");
    nextCalls.push("ai-mobile-local.read-job");
    fallback.push("If submission is not confirmed, use handoff-template and stop; do not watch full chat logs.");
  } else if (codexBudget.state === "critical" || codexBudget.state === "low") {
    route = claudeFound && codeReviewLikely ? "claude-code" : (agyFound && antigravityHealthy ? "antigravity-cli" : "codex-minimal");
    worker = route === "claude-code" ? "Claude Code CLI" : (route === "antigravity-cli" ? "Antigravity CLI" : "Codex minimal");
    reason = "Codex budget was reported low, so only minimal Codex routing/synthesis should happen.";
    nextCalls.push(route === "claude-code" ? "ai-mobile-local.submit-claude-job" : route === "antigravity-cli" ? "ai-mobile-local.submit-agy-job" : "Codex: run one targeted command/read only compact files");
    fallback.push("Ask for a smaller task or wait for budget reset if no local worker is available.");
  }

  return [
    "AiMobileOrchestrationPlan:",
    `Route: ${route}`,
    `PrimaryWorker: ${worker}`,
    `Reason: ${reason}`,
    "",
    "CapacitySnapshot:",
    `CodexBudget: ${codexBudget.state} (${codexBudget.text || "caller did not provide current Codex token state"})`,
    "CodexBudgetSource: caller/UI only; this local plugin cannot read Codex's private token meter directly.",
    `AntigravityModels: ${antigravityLimitText}`,
    `AntigravityReady: ${antigravityHealthy}`,
    `AntigravityLiveReady: ${visibleReady}`,
    `AntigravityCLI: ${agyFound}`,
    `ClaudeCode: ${claudeFound}`,
    "ClaudeCodeBudget: unknown; Claude Code status exposes availability/version, not remaining usage.",
    `CursorHeadless: ${cursorHeadlessFound}`,
    quickError ? `AntigravityQuickError: ${quickError}` : null,
    "",
    "NextCalls:",
    ...(nextCalls.length ? nextCalls.map((item, index) => `${index + 1}. ${item}`) : ["1. Codex direct: keep context small and run targeted checks only."]),
    "",
    "Fallback:",
    ...(fallback.length ? fallback.map((item) => `- ${item}`) : ["- If the direct path grows beyond the estimated token budget, rerun orchestration-plan with a higher estimate and offload."]),
    "",
    "OrchestrationRule:",
    "Codex routes, safety-checks, verifies final diffs/tests, and summarizes. Workers do broad reading/reasoning and write compact artifacts. Do not paste full logs, chats, or source back into Codex.",
  ].filter(Boolean).join("\n");
}

function valueFromPlan(planText, label) {
  const line = String(planText || "").split(/\r?\n/).find((entry) => entry.startsWith(`${label}:`));
  return line ? line.slice(label.length + 1).trim() : "";
}

function valueFromResult(text, label) {
  return valueFromPlan(text, label);
}

async function buildEfficiencyFlow(args = {}) {
  const plan = await buildOrchestrationPlan(args);
  const route = valueFromPlan(plan, "Route") || "unknown";
  const worker = valueFromPlan(plan, "PrimaryWorker") || "unknown";
  const goal = String(args.goal || "").trim();
  const workspace = String(args.workspace || "").trim();
  const expectedProject = String(args.expectedProject || "").trim();
  const expectedChat = String(args.expectedChat || "").trim();
  const statusFile = ".antigravity-bridge/jobs/<jobId>/status.json";
  const readArtifacts = "result.md, changed-files.txt, diff.patch, test-output-summary.md, verification-evidence.json, status.json";
  const submitStep = (() => {
    if (route === "antigravity-cli") return "Call submit-agy-job with the compact goal, workspace, mode, and nextStep; then stop watching.";
    if (route === "antigravity-desktop-chat") return "Call select-chat, then switch-model, then submit-job or submit-offload only after the expected chat is active.";
    if (route === "antigravity-desktop") return "Call submit-job with expected project/chat when known; require Submitted: true before waiting for artifacts.";
    if (route === "claude-code") return "Call submit-claude-job with a compact review/patch goal; then stop watching.";
    if (route === "cursor-headless") return "Call submit-cursor-job only if HeadlessAgentFound is true; otherwise route back to orchestration-plan.";
    return "Keep Codex direct: run one targeted command/read and avoid broad file or log ingestion.";
  })();
  const followUpStep = (() => {
    if (route === "codex-direct" || route === "codex-minimal") {
      return "If the direct task expands beyond the estimate, rerun efficiency-flow with a higher token estimate and offload.";
    }
    return "If artifacts are weak or incomplete, send one compact retry/follow-up to the same worker with only the missing point; do not import broad context into Codex.";
  })();

  return [
    "AiMobileEfficiencyFlow:",
    `Goal: ${goal || "<missing>"}`,
    `Workspace: ${workspace || "<none>"}`,
    `Route: ${route}`,
    `PrimaryWorker: ${worker}`,
    expectedProject ? `ExpectedProject: ${expectedProject}` : null,
    expectedChat ? `ExpectedChat: ${expectedChat}` : null,
    "",
    "StageFlow:",
    "1. Budget gate: use caller-provided Codex budget state, Antigravity limits, Claude availability, and task size; do not assume hidden token meters.",
    "2. Route gate: use the route below; do not manually choose another worker unless a blocker appears.",
    `3. Submit gate: ${submitStep}`,
    "4. Wait gate: after a confirmed submit, stop watching the UI/chat; wait for a compact artifact or job status instead of streaming every step into Codex.",
    `5. Read gate: read only ${readArtifacts}. Do not paste full logs, full source, screenshots, private chats, or large transcripts into Codex.`,
    `6. Improvement gate: ${followUpStep}`,
    "7. Verification gate: Codex performs only targeted final checks, tests, diffs, or UI status needed to trust the result.",
    "8. Summary gate: report route used, model/worker used, accepted/submitted state, artifact/result status, remaining blocker, and next action.",
    "",
    "StopRules:",
    "- If expected chat/project is not verified, stop before submit.",
    "- If submit is not confirmed, do not wait for artifacts and do not claim work started.",
    "- If Antigravity/Claude/Cursor is unavailable, use the fallback from orchestration-plan rather than retrying the same broken call.",
    "- If Codex budget is low, Codex may route and summarize only; workers do broad reading/reasoning.",
    "",
    plan,
  ].filter(Boolean).join("\n");
}

async function runEfficientTask(args = {}) {
  const flow = await buildEfficiencyFlow(args);
  const route = valueFromPlan(flow, "Route") || "unknown";
  const workspace = String(args.workspace || "").trim();
  const start = args.start !== false;
  const submit = args.submit !== false;
  const base = {
    goal: args.goal,
    workspace,
    mode: args.mode || "fast",
    nextStep: args.nextStep || "Inspect the relevant files and write compact artifacts.",
  };

  if (!start) {
    return [
      flow,
      "",
      "RunEfficientTaskResult:",
      "Started: false",
      "Reason: start=false; returned only the flow.",
    ].join("\n");
  }

  let action = "";
  let selectedTool = "";
  if (route === "antigravity-cli") {
    selectedTool = "submit-agy-job";
    action = submitAgyJob({
      ...base,
      model: args.agyModel || args.model || "",
      start: true,
    });
  } else if (route === "claude-code") {
    selectedTool = "submit-claude-job";
    action = submitClaudeJob({
      ...base,
      model: normalizeClaudeDispatchModel(args.claudeModel),
      start: true,
    });
  } else if (route === "cursor-headless") {
    selectedTool = "submit-cursor-job";
    action = submitCursorJob({
      ...base,
      model: args.cursorModel || "",
      start: true,
    });
  } else if (route === "antigravity-desktop-chat" || route === "antigravity-desktop") {
    selectedTool = "submit-job";
    if (args.expectedChat) {
      const selectResult = await selectAntigravityChat({
        expectedProject: args.expectedProject || "",
        expectedChat: args.expectedChat || "",
      });
      if (!/Ok:\s*true/i.test(selectResult)) {
        return [
          flow,
          "",
          selectResult,
          "",
          "RunEfficientTaskResult:",
          "Started: false",
          "Submitted: false",
          "Reason: expected Antigravity chat was not verified; refusing to submit into the wrong chat.",
          "Next: make the target chat visible/active or rerun with the correct expectedChat.",
        ].join("\n");
      }
    }
    action = await submitJob({
      ...base,
      expectedProject: args.expectedProject || "",
      expectedChat: args.expectedChat || "",
      modelPreference: args.modelPreference || "auto",
      submit,
    });
  } else {
    return [
      flow,
      "",
      "RunEfficientTaskResult:",
      "Started: false",
      "Submitted: false",
      `Route: ${route}`,
      "Reason: route is Codex-direct/minimal or unknown; no external worker should be started.",
      "Next: Codex should perform one targeted command/read or ask for a narrower task.",
    ].join("\n");
  }

  const jobId = valueFromResult(action, "JobId");
  const started = /\bStarted:\s*true\b/i.test(action) || /\bState:\s*running\b/i.test(action);
  const submitted = /\bSubmitted:\s*true\b/i.test(action);
  const failed = /\bState:\s*failed\b/i.test(action) || /\bOk:\s*false\b/i.test(action);
  const readCommand = jobId
    ? `ai-mobile-local.read-job with workspace=${workspace} and jobId=${jobId}`
    : "read-job unavailable until a JobId is returned";
  return [
    flow,
    "",
    "SelectedAction:",
    `Tool: ${selectedTool}`,
    action,
    "",
    "RunEfficientTaskResult:",
    `Started: ${started && !failed}`,
    `Submitted: ${submitted}`,
    jobId ? `JobId: ${jobId}` : null,
    `ReadBack: ${readCommand}`,
    failed ? "Status: failed-or-unverified" : "Status: dispatched-or-ready",
    "Next: do not watch the worker chat. Wait, then read only compact artifacts via read-job.",
  ].filter(Boolean).join("\n");
}

function resolveCommandFast(command, fallbackPaths = []) {
  const resolver = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(resolver, [command], { encoding: "utf8", timeout: 2000, windowsHide: true });
  const resolved = String(result.stdout || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (result.status === 0 && resolved) return { found: true, command: resolved };
  const fallback = fallbackPaths.find((candidate) => candidate && fs.existsSync(candidate));
  return fallback ? { found: true, command: fallback } : { found: false, command: "" };
}

async function probeAntigravityDevTools(timeoutMs = 1200) {
  if (!devToolsPortFile || !fs.existsSync(devToolsPortFile)) return { live: false, pageCount: 0 };
  const port = fs.readFileSync(devToolsPortFile, "utf8").split(/\r?\n/)[0]?.trim();
  if (!/^\d+$/.test(String(port || ""))) return { live: false, pageCount: 0 };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: controller.signal });
    const pages = response.ok ? await response.json() : [];
    return { live: Array.isArray(pages) && pages.length > 0, pageCount: Array.isArray(pages) ? pages.length : 0 };
  } catch {
    return { live: false, pageCount: 0 };
  } finally {
    clearTimeout(timer);
  }
}

function isFreshTimestamp(value, ttlMs = resourceCacheTtlMs) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) && (Date.now() - timestamp) >= 0 && (Date.now() - timestamp) <= ttlMs;
}

function readSafeResourceCache() {
  return readJsonFile(resourceCacheFile, { version: 1, updatedAt: "" }) || { version: 1, updatedAt: "" };
}

function updateSafeResourceCache(patch = {}) {
  return withFileLock(resourceCacheFile, () => {
    const current = readSafeResourceCache();
    const next = {
      ...current,
      ...patch,
      antigravity: { ...(current.antigravity || {}), ...(patch.antigravity || {}) },
      claude: { ...(current.claude || {}), ...(patch.claude || {}) },
      codex: { ...(current.codex || {}), ...(patch.codex || {}) },
      cursor: { ...(current.cursor || {}), ...(patch.cursor || {}) },
      updatedAt: utcStamp(),
    };
    writeJsonFile(resourceCacheFile, next);
    return next;
  });
}

function agyModelIdFromDisplayName(displayName) {
  const normalized = String(displayName || "")
    .toLowerCase()
    .replace(/[()]/g, " ")
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.replace(/-thinking$/, "-thinking");
}

function parseAgyModelRoster(output) {
  return String(output || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(Gemini|Claude|GPT)/i.test(line))
    .map((displayName) => ({ id: agyModelIdFromDisplayName(displayName), displayName }))
    .filter((model, index, rows) => rows.findIndex((row) => row.id === model.id) === index);
}

function safeClaudeAuthProbe(command) {
  const result = runClaudeCli(command, ["auth", "status", "--json"], { timeout: 8000 });
  if (result.status !== 0) return { checked: true, loggedIn: null, error: truncateText(result.stderr || result.error?.message || "auth status unavailable", 300) };
  try {
    const parsed = JSON.parse(String(result.stdout || "{}"));
    return {
      checked: true,
      loggedIn: parsed.loggedIn === true,
      authMethod: String(parsed.authMethod || ""),
      apiProvider: String(parsed.apiProvider || ""),
      subscriptionType: String(parsed.subscriptionType || ""),
    };
  } catch {
    return { checked: true, loggedIn: null, error: "Claude auth status returned non-JSON output." };
  }
}

function compactCodexModelCatalog(cache) {
  if (!cache || !Array.isArray(cache.models)) return { found: false, models: [], fetchedAt: "", clientVersion: "" };
  return {
    found: true,
    fetchedAt: String(cache.fetched_at || ""),
    clientVersion: String(cache.client_version || ""),
    models: cache.models
      .filter((model) => model && model.visibility !== "hidden")
      .map((model) => ({
        id: String(model.slug || model.id || ""),
        displayName: String(model.display_name || model.slug || "Codex model"),
        description: String(model.description || ""),
        defaultReasoning: String(model.default_reasoning_level || ""),
        reasoningLevels: Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels.map((row) => String(row.effort || "")).filter(Boolean) : [],
        contextWindow: Number.isFinite(Number(model.context_window)) ? Number(model.context_window) : null,
      }))
      .filter((model) => model.id),
  };
}

function readCodexModelCatalog() {
  return compactCodexModelCatalog(readJsonFile(codexModelsCacheFile, null));
}

function parseClaudeModelRoster(output) {
  const text = String(output || "");
  const aliases = [...new Set((text.match(/\b(?:haiku|sonnet|opus|fable)\b/gi) || []).map((value) => value.toLowerCase()))];
  if (!aliases.includes("haiku")) aliases.push("haiku");
  const fullNames = [...new Set((text.match(/\bclaude-[a-z0-9.-]+\b/gi) || []).map((value) => value.toLowerCase()))];
  return aliases.map((alias) => {
    const resolvedId = fullNames.find((name) => name.includes(`-${alias}-`) || name.endsWith(`-${alias}`)) || "";
    return {
      id: alias,
      resolvedId,
      displayName: resolvedId || `Claude ${alias[0].toUpperCase()}${alias.slice(1)} (CLI alias)`,
      evidence: resolvedId ? "cli-help-exact" : "cli-help",
    };
  });
}

function parseClaudeEffortLevels(output) {
  const text = String(output || "").replace(/\r?\n\s+/g, " ");
  const match = text.match(/--effort\s+<level>[\s\S]{0,180}?\(([^)]+)\)/i);
  if (!match) return [];
  return [...new Set(match[1]
    .split(/[,|]/)
    .map((value) => value.trim().toLowerCase())
    .filter((value) => /^[a-z][a-z0-9_-]{0,20}$/.test(value)))];
}

function enrichClaudeModelRoster(models = [], claudeCache = {}) {
  const resolutions = claudeCache.aliasResolutions || {};
  const observed = String(claudeCache.observedModel || "");
  return models.map((model) => {
    const alias = String(model.id || "").toLowerCase();
    const observedMatch = observed.toLowerCase().includes(`-${alias}-`) || observed.toLowerCase().endsWith(`-${alias}`) ? observed : "";
    const cachedResolution = String(resolutions[alias] || "");
    const validCachedResolution = cachedResolution.toLowerCase().includes(`-${alias}-`) || cachedResolution.toLowerCase().endsWith(`-${alias}`)
      ? cachedResolution
      : "";
    const resolvedId = String(validCachedResolution || model.resolvedId || observedMatch || "");
    return {
      ...model,
      resolvedId,
      displayName: resolvedId ? `${resolvedId} (${alias} alias)` : model.displayName,
      evidence: resolvedId ? "observed-alias-resolution" : model.evidence,
    };
  });
}

function timeZoneOffsetMs(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
    return Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute, values.second) - date.getTime();
  } catch {
    return null;
  }
}

function zonedResetIso(parts, timeZone) {
  const localUtc = Date.UTC(parts.year, parts.month, parts.day, parts.hour, parts.minute, 0);
  let candidate = localUtc;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const offset = timeZoneOffsetMs(new Date(candidate), timeZone);
    if (!Number.isFinite(offset)) return "";
    candidate = localUtc - offset;
  }
  return new Date(candidate).toISOString();
}

function parseClaudeResetTime(value, now = new Date()) {
  const source = String(value || "").trim();
  const timeZone = source.match(/\(([^)]+\/[A-Za-z_+-]+)\)\s*$/)?.[1] || "";
  const raw = source.replace(/\s*\([^)]*\)\s*$/, "").trim();
  const match = raw.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (!match) return "";
  const month = new Date(`${match[1]} 1, 2000`).getMonth();
  if (!Number.isFinite(month)) return "";
  let hour = Number(match[3]) % 12;
  if (match[5].toLowerCase() === "pm") hour += 12;
  const minute = Number(match[4] || 0);
  const build = (year) => timeZone
    ? zonedResetIso({ year, month, day: Number(match[2]), hour, minute }, timeZone)
    : new Date(year, month, Number(match[2]), hour, minute, 0).toISOString();
  let parsed = build(now.getFullYear());
  if (!parsed) return "";
  if (Date.parse(parsed) < now.getTime() - 24 * 60 * 60 * 1000) parsed = build(now.getFullYear() + 1);
  return parsed;
}

function parseClaudeUsage(output, now = new Date()) {
  const windows = [];
  const cleaned = String(output || "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
  for (const line of cleaned.split(/\r?\n/)) {
    const match = line.trim().match(/^Current\s+(session|week(?:\s+\(([^)]+)\))?):\s*([\d.]+)%\s+used\s*[·-]\s*resets\s+(.+)$/i);
    if (!match) continue;
    const period = match[1].toLowerCase();
    const scopeLabel = String(match[2] || (period === "session" ? "all models" : "all models")).trim();
    const usedPercent = Math.max(0, Math.min(100, Number(match[3])));
    const scope = normalizeTaskLane(scopeLabel);
    windows.push({
      id: period === "session" ? "five_hour" : `seven_day_${scope === "all-models" ? "all" : scope}`,
      label: period === "session" ? "Current session" : `Current week${match[2] ? ` (${match[2]})` : ""}`,
      period: period === "session" ? "five_hour" : "seven_day",
      scope: scope === "all-models" ? "all" : scope,
      usedPercent,
      remainingPercent: Math.round((100 - usedPercent) * 10) / 10,
      resetText: match[4].trim(),
      resetAt: parseClaudeResetTime(match[4], now),
    });
  }
  return { checked: true, windows };
}

function safeClaudeUsageProbe(command) {
  const result = runClaudeCli(command, ["-p", "--safe-mode", "--tools", "", "--no-session-persistence", "--output-format", "text", "/usage"], { timeout: 20000 });
  if (result.status !== 0) return { checked: true, windows: [], error: truncateText(result.stderr || result.error?.message || "Claude /usage unavailable", 400) };
  return parseClaudeUsage(result.stdout);
}

function formatClaudeUsage(usage = {}) {
  const lines = ["ClaudeUsage:", `Checked: ${usage.checked === true}`];
  for (const window of usage.windows || []) {
    lines.push(`- ${window.id}: used=${window.usedPercent}%; remaining=${window.remainingPercent}%; reset=${window.resetAt || window.resetText || "unknown"}; scope=${window.scope}`);
  }
  if (!(usage.windows || []).length) lines.push(`- unavailable: ${usage.error || "no usage windows returned"}`);
  lines.push("Rule: each model is constrained by the most restrictive shared and model-specific window that applies to it.");
  return lines.join("\n");
}

function workspaceResourceStatePath(workspace) {
  return path.join(bridgeRootFor(workspace), "orchestrator", "resource-state.json");
}

function readWorkspaceResourceState(workspace) {
  if (!workspace) return { version: 1, outcomes: {}, decisions: [] };
  return readJsonFile(workspaceResourceStatePath(workspace), { version: 1, outcomes: {}, decisions: [] })
    || { version: 1, outcomes: {}, decisions: [] };
}

function writeWorkspaceResourceState(workspace, next) {
  if (!workspace) return;
  const target = workspaceResourceStatePath(workspace);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  writeJsonFile(target, { ...next, version: 1, updatedAt: utcStamp() });
}

function mutateWorkspaceResourceState(workspace, mutator) {
  const target = workspaceResourceStatePath(workspace);
  return withFileLock(target, () => {
    const current = readWorkspaceResourceState(workspace);
    const next = mutator(current) || current;
    writeWorkspaceResourceState(workspace, next);
    return next;
  });
}

function resourceCooldownState(outcome = {}) {
  const resetAt = Date.parse(String(outcome.cooldownUntil || outcome.resetAt || ""));
  if (Number.isFinite(resetAt) && resetAt > Date.now()) {
    return { state: "cooldown", resetAt: new Date(resetAt).toISOString() };
  }
  if (outcome.lastState === "unavailable" && !outcome.lastSuccessAt) return { state: "unavailable", resetAt: "" };
  return { state: "available", resetAt: "" };
}

function compactOutcome(outcome = {}) {
  const lastSuccessAt = String(outcome.lastSuccessAt || "");
  const lastFailureAt = String(outcome.lastFailureAt || "");
  const successTime = Date.parse(lastSuccessAt);
  const failureTime = Date.parse(lastFailureAt);
  const successfulKinds = Array.isArray(outcome.successfulKinds)
    ? outcome.successfulKinds.slice(-5)
    : Number.isFinite(successTime) && (!Number.isFinite(failureTime) || successTime >= failureTime) && Array.isArray(outcome.recentKinds)
      ? outcome.recentKinds.slice(-5)
      : [];
  const storedConsecutiveFailures = Number(outcome.consecutiveFailures);
  const consecutiveFailures = Number.isFinite(storedConsecutiveFailures)
    ? Math.max(0, storedConsecutiveFailures)
    : Number.isFinite(failureTime) && (!Number.isFinite(successTime) || failureTime > successTime) ? 1 : 0;
  return {
    lastState: String(outcome.lastState || "unknown"),
    lastCategory: String(outcome.lastCategory || ""),
    lastSuccessAt,
    lastFailureAt,
    cooldownUntil: String(outcome.cooldownUntil || ""),
    observedModel: String(outcome.observedModel || ""),
    recentKinds: Array.isArray(outcome.recentKinds) ? outcome.recentKinds.slice(-5) : [],
    successfulKinds,
    successCount: Math.max(0, Number(outcome.successCount || 0)),
    failureCount: Math.max(0, Number(outcome.failureCount || 0)),
    consecutiveFailures,
    lastDurationMs: Number.isFinite(Number(outcome.lastDurationMs)) ? Number(outcome.lastDurationMs) : null,
  };
}

function compactAntigravityQuickSnapshot(report = {}) {
  return {
    GeneratedAtUtc: String(report.GeneratedAtUtc || ""),
    Setup: report.Setup || {},
    Live: { PageCount: Number(report.Live?.PageCount || 0) },
    Limits: report.Limits || {},
    LimitsError: String(report.LimitsError || ""),
  };
}

async function getTeamCapacityContext(args = {}) {
  const refresh = args.refreshInventory === true || args.refresh === true;
  const workspace = args.workspace ? safeWorkspacePath(args.workspace) : "";
  let cache = readSafeResourceCache();
  const agy = resolveCommandFast("agy", [process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "agy", "bin", "agy.exe") : ""]);
  const claude = resolveCommandFast("claude");
  const codexCatalog = readCodexModelCatalog();
  const codexTelemetry = readCodexUsageTelemetry({ freshMs: refresh ? 5 * 60 * 1000 : 15 * 60 * 1000 });
  const cursorUi = findCursorApp();
  const cursorAgent = args.includeCursor ? resolveCommandFast("cursor-agent") : { found: false, command: "" };
  const liveProbe = await probeAntigravityDevTools();

  let codexCli = cache.codex?.cli || { found: false, command: "", version: "", auth: { checked: false, loggedIn: null, authMode: "unknown" } };
  if (refresh || !isFreshTimestamp(cache.codex?.cliCheckedAt) || !codexCli.found) {
    codexCli = findCodexCli();
    cache = updateSafeResourceCache({ codex: { cli: codexCli, cliCheckedAt: utcStamp() } });
  }

  let agyVersion = String(cache.antigravity?.cliVersion || "");
  if (agy.found && (refresh || !agyVersion || !isFreshTimestamp(cache.antigravity?.versionCheckedAt, 24 * 60 * 60 * 1000))) {
    const versionProbe = commandCheck(agy.command, ["--version"], { timeout: 5000 });
    if (versionProbe.ok) {
      agyVersion = versionProbe.stdout || versionProbe.stderr;
      cache = updateSafeResourceCache({ antigravity: { cliVersion: agyVersion, versionCheckedAt: utcStamp() } });
    }
  }

  let claudeVersion = String(cache.claude?.cliVersion || "");
  if (claude.found && (refresh || !claudeVersion || !isFreshTimestamp(cache.claude?.versionCheckedAt, 24 * 60 * 60 * 1000))) {
    const versionProbe = runClaudeCli(claude.command, ["--version"], { timeout: 5000 });
    if (versionProbe.status === 0) {
      claudeVersion = String(versionProbe.stdout || versionProbe.stderr || "").trim();
      cache = updateSafeResourceCache({ claude: { cliVersion: claudeVersion, versionCheckedAt: utcStamp() } });
    }
  }

  let agyModels = Array.isArray(cache.antigravity?.models) ? cache.antigravity.models : [];
  if (agy.found && (refresh || !isFreshTimestamp(cache.antigravity?.modelsCheckedAt) || agyModels.length === 0)) {
    const modelProbe = commandCheck(agy.command, ["models"], { timeout: 15000 });
    if (modelProbe.ok) {
      agyModels = parseAgyModelRoster(modelProbe.stdout);
      cache = updateSafeResourceCache({
        antigravity: { found: true, models: agyModels, modelsCheckedAt: utcStamp() },
      });
    }
  }

  let claudeAuth = cache.claude?.auth || { checked: false, loggedIn: null };
  if (claude.found && (refresh || !isFreshTimestamp(cache.claude?.authCheckedAt))) {
    claudeAuth = safeClaudeAuthProbe(claude.command);
    cache = updateSafeResourceCache({
      claude: { found: true, auth: claudeAuth, authCheckedAt: utcStamp() },
    });
  }

  let claudeModels = Array.isArray(cache.claude?.models) ? cache.claude.models : [];
  let claudeEfforts = Array.isArray(cache.claude?.effortLevels) ? cache.claude.effortLevels : [];
  if (claude.found && (refresh || !isFreshTimestamp(cache.claude?.modelsCheckedAt) || claudeModels.length === 0)) {
    const modelProbe = runClaudeCli(claude.command, ["--help"], { timeout: 10000 });
    if (modelProbe.status === 0) {
      const helpText = `${modelProbe.stdout}\n${modelProbe.stderr}`;
      claudeModels = parseClaudeModelRoster(helpText);
      claudeEfforts = parseClaudeEffortLevels(helpText);
      const aliasResolutions = { ...(cache.claude?.aliasResolutions || {}) };
      for (const model of claudeModels) {
        if (model.resolvedId) aliasResolutions[model.id] = model.resolvedId;
      }
      cache = updateSafeResourceCache({
        claude: { found: true, models: claudeModels, effortLevels: claudeEfforts, aliasResolutions, modelsCheckedAt: utcStamp() },
      });
    }
  }

  let claudeUsage = cache.claude?.usage || { checked: false, windows: [] };
  if (claude.found && claudeAuth.loggedIn !== false && (refresh || !isFreshTimestamp(cache.claude?.usageCheckedAt) || !Array.isArray(claudeUsage.windows))) {
    claudeUsage = safeClaudeUsageProbe(claude.command);
    cache = updateSafeResourceCache({
      claude: { found: true, usage: claudeUsage, usageCheckedAt: utcStamp() },
    });
  }
  claudeModels = enrichClaudeModelRoster(claudeModels, cache.claude || {});

  let quick = liveProbe.live ? (cache.antigravity?.quick || null) : null;
  let antigravityQuotaEvidence = quick ? "cached-live" : "unavailable";
  let quickError = "";
  if (liveProbe.live && (refresh || !quick || !isFreshTimestamp(cache.antigravity?.quickCheckedAt))) {
    try {
      quick = compactAntigravityQuickSnapshot(await runHelper("quick"));
      antigravityQuotaEvidence = "measured-live";
      cache = updateSafeResourceCache({ antigravity: { quick, quickCheckedAt: utcStamp() } });
    } catch (error) {
      quickError = error?.message || String(error);
    }
  }

  const limits = quick?.Limits || {};
  const recommendedAvailable = Array.isArray(limits.RecommendedAvailable) ? limits.RecommendedAvailable : [];
  const setup = quick?.Setup || {};
  const workspaceState = workspace ? readWorkspaceResourceState(workspace) : { outcomes: {}, decisions: [] };

  updateSafeResourceCache({
    antigravity: { found: agy.found, live: liveProbe.live, lastSeenAt: utcStamp() },
    claude: { found: claude.found, lastSeenAt: utcStamp() },
    codex: { cli: codexCli, lastSeenAt: utcStamp() },
    cursor: { headlessFound: cursorAgent.found, lastSeenAt: utcStamp() },
  });

  const callerBudget = normalizeBudgetState(args.codexBudgetState || "unknown");
  const measuredCodexBudget = codexTelemetry.found && codexTelemetry.fresh
    ? normalizeBudgetState(codexTelemetry.state)
    : { state: "unknown", text: "unknown" };
  const callerRemaining = Number.isFinite(Number(args.codexRemainingPercent)) ? Number(args.codexRemainingPercent) : null;
  const measuredReset = (codexTelemetry.windows || [])
    .filter((window) => Number.isFinite(window.remainingPercent))
    .sort((a, b) => a.remainingPercent - b.remainingPercent)[0]?.resetAt || "";

  return {
    codexModel: String(args.codexModel || "current Codex session").trim() || "current Codex session",
    codexBudget: callerBudget.state !== "unknown" ? callerBudget : measuredCodexBudget,
    codexRemainingPercent: callerRemaining !== null
      ? callerRemaining
      : codexTelemetry.found && codexTelemetry.fresh
        ? codexTelemetry.effectiveRemainingPercent
        : null,
    codexResetAt: String(args.codexResetAt || measuredReset || ""),
    codexTelemetry,
    codexCatalog,
    codexCliFound: codexCli.found === true,
    codexCliCommand: String(codexCli.command || ""),
    codexCliVersion: String(codexCli.version || ""),
    codexCliAuth: codexCli.auth || { checked: false, loggedIn: null, authMode: "unknown" },
    quickError,
    capacityProbe: liveProbe.live
      ? `${antigravityQuotaEvidence} Antigravity quota, Claude usage windows, and local CLI/auth evidence`
      : "Claude usage windows plus passive CLI/auth evidence; Antigravity desktop was not opened for quota inspection",
    agyFound: agy.found,
    agyVersion,
    claudeFound: claude.found,
    claudeVersion,
    claudeAuth,
    claudeModels,
    claudeEfforts,
    claudeUsage,
    claudeObservedModel: String(cache.claude?.observedModel || ""),
    cursorHeadlessFound: cursorAgent.found,
    cursorUiFound: cursorUi.found,
    cursorUiVersion: cursorUi.version || "",
    antigravityReady: setup.ReadyForModelLimits === true && recommendedAvailable.length > 0,
    antigravityLiveReady: liveProbe.live,
    antigravityQuotaEvidence,
    recommendedAvailable,
    agyModels,
    rawLimits: limits,
    workspaceState,
    cacheUpdatedAt: String(cache.updatedAt || ""),
  };
}

function normalizedModelText(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9.]+/g, " ").trim();
}

function regexMatches(value, pattern, fallback = false) {
  try {
    return new RegExp(String(pattern || ""), "i").test(String(value || ""));
  } catch {
    return fallback;
  }
}

function neutralLocalRoutingProfile() {
  return {
    codexModelAllowPattern: "^gpt-",
    claudeModelAllowPattern: ".*",
    claudePreferredModelPattern: "(?!)",
    antigravityPreferredTaskPattern: "(?!)",
    adaptiveRouting: true,
  };
}

function liveAgyEvidence(context, model) {
  const needle = normalizedModelText(`${model.id} ${model.displayName}`);
  const liveModels = [
    ...(Array.isArray(context.rawLimits?.Models) ? context.rawLimits.Models : []),
    ...(context.recommendedAvailable || []),
  ];
  const live = liveModels.find((candidate) => String(candidate.Id || candidate.id || "").toLowerCase() === String(model.id || "").toLowerCase())
    || liveModels.find((candidate) => {
    const candidateText = normalizedModelText(`${candidate.Id || ""} ${candidate.Name || ""} ${candidate.DisplayName || ""}`);
    return candidateText && (needle.includes(candidateText) || candidateText.includes(normalizedModelText(model.displayName)));
  });
  if (!live) return { remainingPercent: null, resetAt: "", evidence: context.antigravityLiveReady ? "live-unknown" : "observed-roster" };
  const quota = live.Quota || live.quota || {};
  const remaining = Number(quota.RemainingPercent ?? quota.remainingPercent ?? live.RemainingPercent ?? live.remainingPercent ?? live.remaining);
  return {
    remainingPercent: Number.isFinite(remaining) ? remaining : null,
    resetAt: String(quota.ResetTimeUtc || quota.resetTimeUtc || live.ResetTimeUtc || live.ResetAt || live.ResetTime || live.ResetUtc || live.resetAt || live.resetTime || ""),
    evidence: context.antigravityQuotaEvidence || "measured-live",
  };
}

function agyModelProfile(model) {
  const text = `${model.id} ${model.displayName}`.toLowerCase();
  const capabilities = new Set(["general-reasoning", "discovery", "review", "research", "docs"]);
  let quality = 68;
  let speed = 75;
  let cost = 85;
  let premium = false;
  if (/flash/.test(text)) {
    capabilities.add("fast-analysis");
    capabilities.add("testing");
    quality = /high/.test(text) ? 78 : /medium/.test(text) ? 74 : 69;
    speed = /low/.test(text) ? 95 : /medium/.test(text) ? 90 : 82;
    cost = 95;
  }
  if (/(pro|sonnet|opus)/.test(text)) {
    capabilities.add("architecture");
    capabilities.add("debugging");
    capabilities.add("implementation");
    capabilities.add("testing");
    quality = /opus/.test(text) ? 94 : /sonnet/.test(text) ? 90 : /high/.test(text) ? 87 : 83;
    speed = /opus/.test(text) ? 45 : /sonnet/.test(text) ? 58 : 65;
    cost = /opus/.test(text) ? 35 : /sonnet/.test(text) ? 50 : 60;
    premium = /opus/.test(text);
  }
  if (/gpt-oss/.test(text)) {
    capabilities.add("implementation");
    capabilities.add("debugging");
    capabilities.add("testing");
    quality = 76;
    speed = 70;
    cost = 80;
  }
  return { capabilities: [...capabilities], quality, speed, cost, premium };
}

function claudeModelProfile(model) {
  const text = String(model || "").toLowerCase();
  const capabilities = ["general-reasoning", "architecture", "implementation", "debugging", "testing", "review", "docs"];
  if (/fable/.test(text)) return { capabilities: [...capabilities, "critical-reasoning", "adversarial-review"], quality: 96, speed: 35, cost: 10, premium: true };
  if (/opus/.test(text)) return { capabilities: [...capabilities, "critical-reasoning", "adversarial-review"], quality: 97, speed: 45, cost: 25, premium: true };
  if (/haiku/.test(text)) return { capabilities: ["general-reasoning", "discovery", "testing", "review", "docs", "fast-analysis"], quality: 74, speed: 95, cost: 98, premium: false };
  return { capabilities, quality: 98, speed: 68, cost: 55, premium: false };
}

function claudeQuotaForModel(usage = {}, modelId = "") {
  const normalized = normalizeTaskLane(modelId);
  const windows = (usage.windows || []).filter((window) => window.scope === "all" || normalized.includes(window.scope) || window.scope.includes(normalized));
  const limiting = [...windows].sort((a, b) => Number(a.remainingPercent) - Number(b.remainingPercent))[0] || null;
  const dedicated = windows.filter((window) => window.scope !== "all").sort((a, b) => Number(a.remainingPercent) - Number(b.remainingPercent))[0] || null;
  const shared = windows.filter((window) => window.scope === "all").sort((a, b) => Number(a.remainingPercent) - Number(b.remainingPercent))[0] || null;
  return {
    windows,
    remainingPercent: limiting ? Number(limiting.remainingPercent) : null,
    resetAt: limiting?.resetAt || "",
    dedicatedRemainingPercent: dedicated ? Number(dedicated.remainingPercent) : null,
    dedicatedResetAt: dedicated?.resetAt || "",
    sharedRemainingPercent: shared ? Number(shared.remainingPercent) : null,
  };
}

function candidateAvailability(found, authState, outcome = {}, measured = {}) {
  if (!found) return { state: "unavailable", resetAt: "" };
  if (authState === false) return { state: "unavailable", resetAt: "" };
  const cooldown = resourceCooldownState(outcome);
  if (cooldown.state !== "available") return cooldown;
  if (Number.isFinite(measured.remainingPercent) && measured.remainingPercent <= 0) {
    return { state: "exhausted", resetAt: measured.resetAt || "" };
  }
  return { state: "available", resetAt: measured.resetAt || "" };
}

function platformReliabilitySummary(outcomes = {}, platform, horizonHours = 5) {
  const cutoff = Date.now() - (Math.max(1, Math.min(12, Number(horizonHours || 5))) * 60 * 60 * 1000);
  let recentFailures = 0;
  let recentSuccesses = 0;
  for (const [resourceId, outcome] of Object.entries(outcomes || {})) {
    if (!resourceId.startsWith(`${platform}:`)) continue;
    const successTime = Date.parse(String(outcome?.lastSuccessAt || ""));
    const failureTime = Date.parse(String(outcome?.lastFailureAt || ""));
    if (Number.isFinite(successTime) && successTime >= cutoff) recentSuccesses += 1;
    if (Number.isFinite(failureTime) && failureTime >= cutoff && (!Number.isFinite(successTime) || failureTime > successTime)) recentFailures += 1;
  }
  return { recentFailures, recentSuccesses };
}

function buildResourceCandidates(args = {}, context = {}) {
  const localProfile = args.localProfile || neutralLocalRoutingProfile();
  const outcomes = context.workspaceState?.outcomes || {};
  const horizonHours = Math.max(1, Math.min(12, Number(args.horizonHours || 5)));
  const platformReliability = {
    codex: platformReliabilitySummary(outcomes, "codex", horizonHours),
    claude: platformReliabilitySummary(outcomes, "claude", horizonHours),
    antigravity: platformReliabilitySummary(outcomes, "antigravity", horizonHours),
    cursor: platformReliabilitySummary(outcomes, "cursor", horizonHours),
  };
  const codexState = context.codexBudget.state === "exhausted"
    ? "exhausted"
    : ["critical", "low"].includes(context.codexBudget.state)
      ? "constrained"
      : "available";
  const candidates = [{
    id: "codex:current",
    platform: "codex",
    team: "Codex",
    model: context.codexModel,
    displayName: context.codexModel,
    dispatchable: false,
    state: codexState,
    evidence: context.codexTelemetry?.found && context.codexTelemetry?.fresh
      ? "measured-local-undocumented-schema"
      : context.codexRemainingPercent === null
        ? "caller-or-unknown"
        : "caller-measured",
    remainingPercent: context.codexRemainingPercent,
    resetAt: context.codexResetAt,
    capabilities: ["orchestration", "architecture", "risk-gating", "integration", "final-verification", "general-reasoning"],
    quality: 100,
    speed: 65,
    cost: 10,
    role: "goal owner, resource orchestrator, critic, integrator, and final verifier",
    outcome: compactOutcome(outcomes["codex:current"] || {}),
    platformReliability: platformReliability.codex,
  }];

  const discoveredClaudeModels = context.claudeModels?.length
    ? context.claudeModels
    : [{ id: "sonnet", displayName: context.claudeObservedModel || "Claude Sonnet (local alias)", evidence: "detected-cli" }];
  const explicitClaudeModel = normalizedModelText(args.claudeModel || "");
  const claudeModels = discoveredClaudeModels.filter((model) => {
    const value = `${model.id || ""} ${model.resolvedId || ""} ${model.displayName || ""}`;
    return regexMatches(value, localProfile.claudeModelAllowPattern, true)
      || (explicitClaudeModel && explicitClaudeModel !== "auto" && normalizedModelText(value).includes(explicitClaudeModel));
  });
  for (const model of claudeModels) {
    const modelId = String(model.id || "sonnet").toLowerCase();
    const resolvedModelId = String(model.resolvedId || "").trim();
    const id = `claude:${modelId}`;
    const claudeOutcome = outcomes[id] || {};
    const measured = claudeQuotaForModel(context.claudeUsage, modelId);
    const claudeAvailability = candidateAvailability(context.claudeFound, context.claudeAuth?.loggedIn, claudeOutcome, measured);
    const profile = claudeModelProfile(modelId);
    candidates.push({
      id,
      platform: "claude",
      team: "Claude Code CLI",
      model: resolvedModelId || modelId,
      modelAlias: modelId,
      displayName: model.displayName || `Claude ${modelId}`,
      dispatchable: true,
      state: claudeAvailability.state,
      evidence: claudeOutcome.lastSuccessAt ? "observed-run" : model.evidence || (context.claudeAuth?.checked ? "observed-auth" : "detected-cli"),
      remainingPercent: measured.remainingPercent,
      resetAt: claudeAvailability.resetAt,
      quotaWindows: measured.windows,
      dedicatedRemainingPercent: measured.dedicatedRemainingPercent,
      dedicatedResetAt: measured.dedicatedResetAt,
      sharedRemainingPercent: measured.sharedRemainingPercent,
      capabilities: profile.capabilities,
      reasoningLevels: context.claudeEfforts?.length ? context.claudeEfforts : ["low", "medium", "high"],
      defaultReasoning: "medium",
      quality: profile.quality,
      speed: profile.speed,
      cost: profile.cost,
      premium: profile.premium,
      role: profile.premium
        ? (/fable/i.test(modelId)
          ? "dedicated-capacity premium review when explicitly requested or near reset; never routine work"
          : "premium complex reasoning and adversarial review; never routine work")
        : /haiku/i.test(modelId)
          ? "fast bounded discovery, summaries, tests, and low-risk review"
          : "high-value implementation, architecture, debugging, and independent review",
      outcome: compactOutcome(claudeOutcome),
      platformReliability: platformReliability.claude,
    });
  }

  const agyRoster = context.agyModels?.length
    ? context.agyModels
    : (context.recommendedAvailable || []).map((model) => ({
        id: String(model.Id || model.Name || agyModelIdFromDisplayName(model.DisplayName)),
        displayName: String(model.DisplayName || model.Name || model.Id || "Antigravity model"),
      }));
  for (const model of agyRoster) {
    const id = `antigravity:${model.id}`;
    const outcome = outcomes[id] || {};
    const measured = liveAgyEvidence(context, model);
    const availability = candidateAvailability(context.agyFound, true, outcome, measured);
    const profile = agyModelProfile(model);
    const autoDispatchAllowed = args.allowAntigravityCli === true
      || (String(args.agyModel || "auto").toLowerCase() !== "auto" && String(args.agyModel || "").trim() !== "");
    const unattendedReady = args.unattendedMode !== true || args.allowAntigravityPermissionBypass === true;
    candidates.push({
      id,
      platform: "antigravity",
      team: "Antigravity CLI",
      model: model.id,
      displayName: model.displayName,
      dispatchable: autoDispatchAllowed && unattendedReady,
      state: !autoDispatchAllowed
        ? "authorization-required"
        : unattendedReady
          ? availability.state
          : "interactive-permission-required",
      evidence: !autoDispatchAllowed
        ? "explicit-cli-authorization-required"
        : !unattendedReady
          ? "unattended-run-needs-explicit-sandboxed-auto-approval"
          : outcome.lastSuccessAt ? "observed-run" : measured.evidence,
      unattendedReady,
      permissionMode: args.unattendedMode === true && args.allowAntigravityPermissionBypass === true ? "sandboxed-auto-approve" : "interactive",
      remainingPercent: measured.remainingPercent,
      resetAt: availability.resetAt,
      capabilities: profile.capabilities,
      quality: profile.quality,
      speed: profile.speed,
      cost: profile.cost,
      premium: profile.premium,
      role: /flash/i.test(model.displayName) ? "fast scout, research, drafting, and low-cost validation" : "reasoning, review, and bounded implementation",
      outcome: compactOutcome(outcome),
      platformReliability: platformReliability.antigravity,
    });
  }

  if (args.includeCursor === true) {
    const cursorOutcome = outcomes["cursor:agent"] || {};
    const cursorAvailability = candidateAvailability(context.cursorHeadlessFound, true, cursorOutcome);
    candidates.push({
      id: "cursor:agent",
      platform: "cursor",
      team: "Cursor agent",
      model: String(args.cursorModel || "default"),
      displayName: "Cursor headless agent",
      dispatchable: true,
      state: cursorAvailability.state,
      evidence: context.cursorHeadlessFound ? "detected-cli" : "missing-cli",
      remainingPercent: null,
      resetAt: cursorAvailability.resetAt,
      capabilities: ["implementation", "ui", "editor-workflow", "testing"],
      quality: 78,
      speed: 75,
      cost: 60,
      role: "editor-native UI implementation when a real headless agent exists",
      outcome: compactOutcome(cursorOutcome),
      platformReliability: platformReliability.cursor,
    });
  }
  return candidates;
}

function buildNativeCodexCandidates(args = {}, context = {}) {
  const localProfile = args.localProfile || readProfile();
  const outcomes = context.workspaceState?.outcomes || {};
  const controls = normalizedRunControls(args);
  const cliReady = context.codexCliFound === true
    && context.codexCliAuth?.loggedIn === true
    && context.codexCliAuth?.authMode === "chatgpt";
  const transportReady = cliReady || args.hostCodexAvailable === true;
  const effectiveRemainingPercent = Number.isFinite(context.codexRemainingPercent)
    ? context.codexRemainingPercent
    : Number.isFinite(context.codexTelemetry?.effectiveRemainingPercent)
      ? context.codexTelemetry.effectiveRemainingPercent
      : null;
  const effectiveTelemetry = {
    ...(context.codexTelemetry || {}),
    effectiveRemainingPercent,
    state: context.codexBudget?.state === "exhausted" ? "exhausted" : context.codexTelemetry?.state,
  };
  return buildHostCodexCandidates(context.codexCatalog || {}, effectiveTelemetry, {
    includePattern: modelPattern(localProfile),
    hostCapabilityVerified: transportReady,
  }).map((candidate) => {
    const id = cliReady ? `codex-cli:${candidate.model}` : candidate.id;
    const reserveBlocked = ["low", "critical", "exhausted"].includes(context.codexBudget?.state)
      || (Number.isFinite(candidate.remainingPercent) && candidate.remainingPercent <= controls.codexManagerReservePercent);
    const dispatchable = transportReady && candidate.state === "available" && !reserveBlocked;
    return {
      ...candidate,
      id,
      team: cliReady ? "Codex CLI worker" : candidate.team,
      dispatchMode: cliReady ? "codex-cli" : "host-subagent",
      bridgeDispatchable: cliReady,
      hostDispatchable: !cliReady && candidate.hostDispatchable && !reserveBlocked,
      hostCapabilityVerified: !cliReady && candidate.hostCapabilityVerified,
      hostTool: cliReady ? "" : candidate.hostTool,
      managerReservePercent: controls.codexManagerReservePercent,
      capacityHeadroomPercent: Number.isFinite(candidate.remainingPercent)
        ? candidate.remainingPercent - controls.codexManagerReservePercent
        : null,
      dispatchable,
      state: candidate.state === "available" && reserveBlocked ? "manager-reserve" : candidate.state,
      evidence: cliReady
        ? (outcomes[id]?.lastSuccessAt ? "observed-run" : "codex-cli-chatgpt-plan")
        : candidate.evidence,
      outcome: compactOutcome(outcomes[id] || {}),
      platformReliability: platformReliabilitySummary(outcomes, "codex", args.horizonHours || 5),
    };
  });
}

function formatResourceInventory(args = {}, context = {}, candidates = buildResourceCandidates(args, context)) {
  const horizonHours = Math.max(1, Math.min(12, Number(args.horizonHours || 5)));
  const localProfile = args.localProfile || readProfile();
  const lines = [
    "AiMobileResourceInventory:",
    `GeneratedAtUtc: ${utcStamp()}`,
    `HorizonHours: ${horizonHours}`,
    `Evidence: ${context.capacityProbe}`,
    "Software:",
    `- Codex: catalog=${context.codexCatalog?.found === true}; client=${context.codexCatalog?.clientVersion || "unknown"}; cli=${context.codexCliFound === true}; cli-version=${context.codexCliVersion || "unknown"}; cli-auth=${context.codexCliAuth?.authMode || "unknown"}; local-capacity=${context.codexTelemetry?.found === true}; fresh=${context.codexTelemetry?.fresh === true}; plan=${context.codexTelemetry?.planType || "unknown"}`,
    `- Claude Code: found=${context.claudeFound}; version=${context.claudeVersion || "unknown"}; plan=${context.claudeAuth?.subscriptionType || "unknown"}; usage-windows=${context.claudeUsage?.windows?.length || 0}; efforts=${context.claudeEfforts?.join(",") || "unknown"}`,
    `- Antigravity: cli=${context.agyFound}; cli-version=${context.agyVersion || "unknown"}; desktop-live=${context.antigravityLiveReady}; live-models=${(context.rawLimits?.Models || []).filter((model) => model.DisplayName).length}`,
    `- Cursor: ui=${context.cursorUiFound}; headless-agent=${context.cursorHeadlessFound}; version=${String(context.cursorUiVersion || "unknown").split(/\r?\n/)[0]}`,
    `LocalRoutingProfile: codex=${localProfile.codexModelAllowPattern}; claudeAllow=${localProfile.claudeModelAllowPattern}; claudePrefer=${localProfile.claudePreferredModelPattern}; antigravityTasks=${localProfile.antigravityPreferredTaskPattern}; agyAutoApprove=${localProfile.antigravityAutoApprovePermissions === true}; adaptive=${localProfile.adaptiveRouting !== false}`,
    "TeamsAndModels:",
  ];
  for (const candidate of candidates) {
    const capacity = candidate.remainingPercent === null ? "remaining=unknown" : `remaining=${candidate.remainingPercent}%`;
    const reset = candidate.resetAt ? `; reset=${candidate.resetAt}` : "";
    const policy = candidate.premium
      ? (/fable/i.test(`${candidate.model} ${candidate.displayName}`)
        ? "; policy=explicit or high-value dedicated-reset opportunity"
        : "; policy=complex premium reasoning or explicit request")
      : "";
    const runway = candidate.platform === "codex" && candidate.id !== "codex:current"
      ? `; managerReserve=${candidate.managerReservePercent ?? 15}%; headroom=${candidate.capacityHeadroomPercent ?? "unknown"}%`
      : "";
    lines.push(`- ${candidate.id} | ${candidate.displayName} | state=${candidate.state}; ${capacity}${reset}; evidence=${candidate.evidence}; dispatchable=${candidate.dispatchable}${policy}${runway}`);
  }
  lines.push("ClaudeQuotaWindows:");
  for (const window of context.claudeUsage?.windows || []) {
    lines.push(`- ${window.id}: used=${window.usedPercent}%; remaining=${window.remainingPercent}%; reset=${window.resetAt || window.resetText || "unknown"}; applies=${window.scope}`);
  }
  if (!(context.claudeUsage?.windows || []).length) lines.push("- unknown");
  lines.push(`ClaudeBudgetPolicy: ${describeClaudeBudgetPolicy({ maxClaudeBudgetUsd: Number(args.maxClaudeBudgetUsd ?? 0) }, context.claudeAuth || cachedClaudeAuth())}`);
  lines.push("CodexCapacityWindows:");
  for (const window of context.codexTelemetry?.windows || []) {
    lines.push(`- ${window.id}: used=${window.usedPercent ?? "unknown"}%; remaining=${window.remainingPercent ?? "unknown"}%; reset=${window.resetAt || "unknown"}; periodMinutes=${window.windowMinutes ?? "unknown"}`);
  }
  if (!(context.codexTelemetry?.windows || []).length) lines.push("- unknown");
  if (context.codexTelemetry?.found) {
    lines.push(`CodexSessionTokens: total=${context.codexTelemetry.currentSession?.totalTokens ?? "unknown"}; cachedInput=${context.codexTelemetry.currentSession?.cachedInputTokens ?? "unknown"}; contextWindow=${context.codexTelemetry.currentSession?.contextWindow ?? "unknown"}; ageSeconds=${context.codexTelemetry.ageSeconds ?? "unknown"}`);
  }
  lines.push("CodexCatalog:");
  for (const model of context.codexCatalog?.models || []) {
    lines.push(`- ${model.id} | ${model.displayName}; defaultReasoning=${model.defaultReasoning || "unknown"}; reasoning=${model.reasoningLevels.join(",") || "unknown"}; limits=unknown`);
  }
  if (!(context.codexCatalog?.models || []).length) lines.push("- unknown");
  lines.push("AntigravityLiveModels:");
  for (const model of (context.rawLimits?.Models || []).filter((row) => row.DisplayName && row.Disabled !== true)) {
    const quota = model.Quota || {};
    lines.push(`- ${model.Id} | ${model.DisplayName}; provider=${model.ApiProvider || "unknown"}; remaining=${Number.isFinite(Number(quota.RemainingPercent)) ? `${quota.RemainingPercent}%` : "unknown"}; reset=${quota.ResetTimeUtc || "unknown"}`);
  }
  if (!(context.rawLimits?.Models || []).some((row) => row.DisplayName && row.Disabled !== true)) lines.push("- unavailable while Antigravity is stopped");
  lines.push(
    "TruthBoundary:",
    "- Codex capacity comes from bounded local token_count events when fresh, or caller-visible values when supplied. This is agentic Codex usage metadata, not every ChatGPT product/model limit.",
    "- The Codex local event shape is undocumented and may change. The reader fails closed and discards prompts, responses, paths, and thread identifiers.",
    "- Claude /usage exposes shared and model-specific percentage/reset windows, not raw token allowances. Each model is gated by the most restrictive applicable window.",
    "- Claude aliases are discovered passively. Exact version ids are recorded from real modelUsage telemetry; aliases may advance when Anthropic updates them.",
    "- Antigravity percentage/reset values are measured only while its local service is already running; inventory never opens the UI just to inspect quota.",
    "- Unknown is preserved as unknown. The orchestrator uses success/failure evidence and bounded failover instead of inventing capacity.",
  );
  return lines.join("\n");
}

async function getResourceInventory(args = {}) {
  const context = await getTeamCapacityContext(args);
  const profiledArgs = { ...args, localProfile: readProfile() };
  const candidates = [...buildResourceCandidates(profiledArgs, context), ...buildNativeCodexCandidates(profiledArgs, context)];
  return formatResourceInventory(profiledArgs, context, candidates);
}

function formatCodexUsage(telemetry = readCodexUsageTelemetry()) {
  const lines = [
    "AiMobileCodexUsage:",
    `Found: ${telemetry.found === true}`,
    `Fresh: ${telemetry.fresh === true}`,
    `Evidence: ${telemetry.evidence || "unknown"}`,
    `ObservedAtUtc: ${telemetry.observedAt || "unknown"}`,
    `AgeSeconds: ${telemetry.ageSeconds ?? "unknown"}`,
    `PlanType: ${telemetry.planType || "unknown"}`,
    `State: ${telemetry.state || "unknown"}`,
    `EffectiveRemainingPercent: ${telemetry.effectiveRemainingPercent ?? "unknown"}`,
    "Windows:",
  ];
  for (const window of telemetry.windows || []) {
    lines.push(`- ${window.id}: used=${window.usedPercent ?? "unknown"}%; remaining=${window.remainingPercent ?? "unknown"}%; reset=${window.resetAt || "unknown"}; minutes=${window.windowMinutes ?? "unknown"}`);
  }
  if (!(telemetry.windows || []).length) lines.push("- unknown");
  lines.push(
    `SessionTokens: total=${telemetry.currentSession?.totalTokens ?? "unknown"}; input=${telemetry.currentSession?.inputTokens ?? "unknown"}; cachedInput=${telemetry.currentSession?.cachedInputTokens ?? "unknown"}; output=${telemetry.currentSession?.outputTokens ?? "unknown"}; reasoning=${telemetry.currentSession?.reasoningOutputTokens ?? "unknown"}; contextWindow=${telemetry.currentSession?.contextWindow ?? "unknown"}`,
    `Privacy: ${telemetry.privacy || "No transcript content is returned."}`,
    "Boundary: this is local Codex agentic-usage telemetry from an undocumented event shape, not a complete ChatGPT product-limit API. Unknown/stale values remain unknown.",
  );
  if (telemetry.reason) lines.push(`Reason: ${telemetry.reason}`);
  return lines.join("\n");
}

function profileSummary(profile = readProfile()) {
  const reviewAt = Date.parse(String(profile.modelPolicyReviewAfter || ""));
  return {
    communicationStyle: profile.communicationStyle,
    address: profile.address,
    updateStyle: profile.updateStyle,
    role: profile.role,
    codexModelAllowPattern: profile.codexModelAllowPattern,
    claudeModelAllowPattern: profile.claudeModelAllowPattern,
    claudePreferredModelPattern: profile.claudePreferredModelPattern,
    antigravityPreferredTaskPattern: profile.antigravityPreferredTaskPattern,
    modelPolicyReviewAfter: profile.modelPolicyReviewAfter,
    modelPolicyReviewDue: Number.isFinite(reviewAt) && reviewAt <= Date.now(),
    cliFirst: profile.cliFirst,
    uiFallbackOnly: profile.uiFallbackOnly,
    adaptiveRouting: profile.adaptiveRouting !== false,
    antigravityAutoApprovePermissions: profile.antigravityAutoApprovePermissions === true,
    source: profile.source,
    path: profile.path,
  };
}

function formatOrchestratorProfile(profile = readProfile()) {
  const safe = profileSummary(profile);
  return [
    "AiMobileOrchestratorProfile:",
    `Source: ${safe.source}`,
    `CommunicationStyle: ${safe.communicationStyle}`,
    `Address: ${safe.address || "none"}`,
    `UpdateStyle: ${safe.updateStyle}`,
    `Role: ${safe.role}`,
    `CodexModelAllowPattern: ${safe.codexModelAllowPattern}`,
    `ClaudeModelAllowPattern: ${safe.claudeModelAllowPattern}`,
    `ClaudePreferredModelPattern: ${safe.claudePreferredModelPattern}`,
    `AntigravityPreferredTaskPattern: ${safe.antigravityPreferredTaskPattern}`,
    `ModelPolicyReviewAfter: ${safe.modelPolicyReviewAfter || "not-set"}`,
    `ModelPolicyReviewDue: ${safe.modelPolicyReviewDue}`,
    `CliFirst: ${safe.cliFirst}`,
    `UiFallbackOnly: ${safe.uiFallbackOnly}`,
    `AdaptiveRouting: ${safe.adaptiveRouting}`,
    `AntigravityAutoApprovePermissions: ${safe.antigravityAutoApprovePermissions}`,
    `LocalPath: ${safe.path}`,
    "Privacy: this profile is local runtime configuration and is not stored in the public plugin repository.",
  ].join("\n");
}

function boundedWorkerPrompt(item, goal, capsulePath) {
  const criteria = (item.acceptanceCriteria || []).slice(0, 4).join("; ") || "Return objective-specific evidence, not an acknowledgement.";
  const verification = (item.verification || []).slice(0, 4).join("; ") || "Run only focused checks relevant to this work item.";
  const files = (item.expectedFiles || []).slice(0, 12).join(", ") || "discover only the minimum relevant paths";
  const complexityRank = ({ low: 1, medium: 2, high: 3, critical: 4 })[String(item.complexity || "medium").toLowerCase()] || 2;
  return [
    `Project goal: ${truncateText(goal, 1200)}`,
    `Work item ${item.id}: ${truncateText(item.objective, 900)}`,
    `Read the transcript-free context capsule at ${capsulePath}; use only the ${item.id} work item and directly relevant local files.`,
    `Ownership: ${item.readOnly ? "read-only; do not modify files" : `single writer within: ${files}`}.`,
    "You are not alone in the workspace. Do not revert unrelated or concurrent changes; adapt to them and stay within your ownership boundary.",
    `Acceptance: ${criteria}`,
    `Verification: ${verification}`,
    `Return at most ${resultBulletLimitForComplexity(complexityRank)} concise evidence bullets plus changed files and focused test results. Do not delegate to another agent.`,
  ].join(" ");
}

function projectManagerResourceScore(candidate, item, args = {}, primaryWriterId = "") {
  let score = scoreResourceForWorkItem(candidate, item, args, primaryWriterId);
  if (!Number.isFinite(score)) return score;
  const intent = `${item.kind || ""} ${item.objective || ""}`.toLowerCase();
  if (candidate.platform === "codex" && candidate.id !== "codex:current") {
    if (/architecture|integration|security|incident|migration|risk|final-verification/.test(intent)) score += 24;
    if (item.complexity === "critical") score += 16;
    if (item.complexity === "low" && item.readOnly) score -= 12;
    if (/architecture|integration|security|incident|migration|risk/.test(intent) && /\bsol\b/i.test(candidate.model)) score += 24;
    if (/implementation|debug|test|refactor|patch/.test(intent) && /\bterra\b/i.test(candidate.model)) score += 22;
    if (/discovery|summary|docs|mechanical|focused|scout/.test(intent) && /\bluna\b/i.test(candidate.model)) score += 22;
  }
  if (candidate.platform === "antigravity" && item.readOnly && /discovery|research|review|docs/.test(intent)) score += 10;
  if (candidate.platform === "claude" && item.readOnly === false && /implementation|debug|refactor|test/.test(intent)) score += 8;
  return Math.round(score * 10) / 10;
}

function selectProviderReasoningEffort(resource, item) {
  if (resource?.platform !== "claude") return selectReasoningEffort(resource || {}, item || {});
  const text = `${item?.kind || ""} ${item?.objective || ""} ${(item?.requiredCapabilities || []).join(" ")}`.toLowerCase();
  const explicitMaximum = /\b(max(?:imum)? effort|deepest reasoning|use max)\b/.test(text);
  const conservativeComplexity = explicitMaximum
    ? "critical"
    : String(item?.complexity || "medium").toLowerCase() === "critical"
      ? "high"
      : item?.complexity;
  return selectReasoningEffort(resource, {
    ...item,
    complexity: conservativeComplexity,
    objective: explicitMaximum ? `${item?.objective || ""} maximum effort frontier reasoning` : item?.objective,
  });
}

function topologicalStage(workItem, byId, memo = new Map(), stack = new Set()) {
  if (memo.has(workItem.id)) return memo.get(workItem.id);
  if (stack.has(workItem.id)) return 0;
  stack.add(workItem.id);
  const stage = (workItem.dependsOn || []).reduce((maximum, id) => {
    const dependency = byId.get(id);
    return dependency ? Math.max(maximum, topologicalStage(dependency, byId, memo, stack) + 1) : maximum;
  }, 0);
  stack.delete(workItem.id);
  memo.set(workItem.id, stage);
  return stage;
}

async function buildProjectManagerPlan(args = {}) {
  args = applyLocalRuntimePolicy(normalizeManagerOnly(args));
  const controls = normalizedRunControls(args);
  const workspace = safeWorkspacePath(args.workspace);
  const goal = String(args.goal || "").trim();
  if (!goal) throw new Error("project-manager-plan requires a non-empty goal.");
  const profile = readProfile();
  args.localProfile = profile;
  const context = await getTeamCapacityContext({ ...args, workspace, codexModel: args.currentCodexModel || args.codexModel });
  const workItems = buildGoalWorkGraph(args);
  const capsuleResult = writeContextCapsule({
    goal,
    workspace,
    lifecycleStage: "plan",
    workItems,
    constraints: args.constraints,
    acceptanceCriteria: args.acceptanceCriteria,
    verification: args.verification,
    continuitySummary: args.continuitySummary,
    artifactRefs: args.artifactRefs,
  });
  const external = buildResourceCandidates(args, context)
    .filter((candidate) => candidate.platform !== "codex" && candidate.dispatchable);
  const host = buildNativeCodexCandidates({ ...args, localProfile: profile }, context);
  const candidates = [...external, ...host];
  const writable = workItems.filter((item) => !item.readOnly && !item.externallyConsequential).sort((a, b) => b.priority - a.priority);
  const primaryWriterId = writable.length
    ? candidates
      .map((candidate) => ({ candidate, score: projectManagerResourceScore(candidate, writable[0], args) }))
      .filter((row) => Number.isFinite(row.score))
      .sort((a, b) => b.score - a.score)[0]?.candidate.id || ""
    : "";
  const byId = new Map(workItems.map((item) => [item.id, item]));
  const memo = new Map();
  const parallelWriters = parallelWriterIds(workItems);
  const stageResourceCounts = new Map();
  const stagePlatformCounts = new Map();
  const actions = workItems.map((item) => {
    const stage = topologicalStage(item, byId, memo);
    const canParallelize = item.readOnly || parallelWriters.has(item.id);
    const ranked = item.externallyConsequential ? [] : candidates
      .map((candidate) => {
        let score = projectManagerResourceScore(candidate, item, args, primaryWriterId);
        if (canParallelize && Number.isFinite(score)) {
          score -= (stageResourceCounts.get(`${stage}:${candidate.id}`) || 0) * 32;
          score -= (stagePlatformCounts.get(`${stage}:${candidate.platform}`) || 0) * 10;
        }
        return { candidate, score: Math.round(score * 10) / 10 };
      })
      .filter((row) => Number.isFinite(row.score))
      .sort((a, b) => b.score - a.score || b.candidate.quality - a.candidate.quality);
    let selected = ranked[0] || null;
    const stageAlreadyAssigned = [...stageResourceCounts.keys()].some((key) => key.startsWith(`${stage}:`));
    if (canParallelize && stageAlreadyAssigned) {
      const unusedCrossPlatform = ranked.find((row) => (stageResourceCounts.get(`${stage}:${row.candidate.id}`) || 0) === 0
        && (stagePlatformCounts.get(`${stage}:${row.candidate.platform}`) || 0) === 0);
      const unusedResource = ranked.find((row) => (stageResourceCounts.get(`${stage}:${row.candidate.id}`) || 0) === 0);
      selected = unusedCrossPlatform || unusedResource || selected;
    }
    if (!item.readOnly && primaryWriterId && !parallelWriters.has(item.id)) selected = ranked.find((row) => row.candidate.id === primaryWriterId) || selected;
    const resource = selected?.candidate || null;
    if (resource) {
      stageResourceCounts.set(`${stage}:${resource.id}`, (stageResourceCounts.get(`${stage}:${resource.id}`) || 0) + 1);
      stagePlatformCounts.set(`${stage}:${resource.platform}`, (stagePlatformCounts.get(`${stage}:${resource.platform}`) || 0) + 1);
    }
    const taskCapsulePath = capsuleResult.taskCapsules?.[item.id]?.path || capsuleResult.outputPath;
    const prompt = boundedWorkerPrompt(item, goal, taskCapsulePath);
    const structuredVerification = bridgeVerificationCommands([item], item.readOnly);
    const hostAction = resource?.dispatchMode === "host-subagent" ? chooseHostCodexAction([resource], item) : null;
    const providerEffort = hostAction?.reasoningEffort
      || (resource?.platform === "claude"
        ? selectProviderReasoningEffort(resource, item)
        : resource?.dispatchMode === "codex-cli"
          ? selectReasoningEffort(resource, item)
          : "provider-managed");
    const toolName = resource?.dispatchMode === "codex-cli"
      ? "ai-mobile-local.submit-codex-job"
      : resource?.platform === "claude"
      ? "ai-mobile-local.submit-claude-job"
      : resource?.platform === "antigravity"
        ? "ai-mobile-local.submit-agy-job"
        : resource?.platform === "cursor"
          ? "ai-mobile-local.submit-cursor-job"
          : hostAction?.hostTool || "codex-current";
    const mode = item.readOnly ? "review" : String(args.mode || "patch");
    const toolArgs = resource?.dispatchMode === "host-subagent"
      ? {
          agent_type: item.readOnly ? "explorer" : "worker",
          model: resource.model,
          reasoning_effort: providerEffort,
          message: prompt,
        }
      : resource?.dispatchMode === "codex-cli"
        ? {
            goal: prompt,
            workspace,
            mode,
            nextStep: `Complete only ${item.id} using the project capsule.`,
            model: resource.model,
            effort: providerEffort,
            expectedFiles: item.expectedFiles,
            readOnly: item.readOnly,
            verificationCommands: structuredVerification,
            resourceId: resource.id,
            workItemKinds: [item.kind],
            start: true,
          }
      : resource?.platform === "claude"
        ? {
            goal: prompt,
            workspace,
            mode,
            nextStep: `Complete only ${item.id} using the project capsule.`,
            model: resource.model,
            effort: providerEffort,
            permissionMode: item.readOnly ? "plan" : "acceptEdits",
            expectedFiles: item.expectedFiles,
            readOnly: item.readOnly,
            verificationCommands: structuredVerification,
            start: true,
          }
        : resource?.platform === "antigravity"
          ? {
              goal: prompt,
              workspace,
              mode,
              nextStep: `Complete only ${item.id} using the project capsule.`,
              model: resource.model,
              expectedFiles: item.expectedFiles,
              readOnly: item.readOnly,
              verificationCommands: structuredVerification,
              start: true,
            }
          : resource?.platform === "cursor"
            ? { goal: prompt, workspace, mode, model: resource.model, expectedFiles: item.expectedFiles, readOnly: item.readOnly, verificationCommands: structuredVerification, start: true }
          : args.managerOnly
            ? { action: "blocked-manager-only", reason: "No dispatchable worker satisfies this item; do not execute it in the parent control-room task." }
            : { action: "current-codex", prompt };
    return {
      workItemId: item.id,
      stage,
      objective: item.objective,
      readOnly: item.readOnly,
      dependsOn: item.dependsOn,
      resourceId: resource?.id || (args.managerOnly ? "resource:unavailable" : "codex-current"),
      platform: resource?.platform || (args.managerOnly ? "none" : "codex"),
      model: resource?.model || (args.managerOnly ? "none" : context.codexModel),
      reasoningEffort: providerEffort,
      dispatchMode: resource?.dispatchMode || (resource ? "external-cli" : args.managerOnly ? "blocked-manager-only" : "current-codex"),
      toolName,
      toolArgs,
      score: selected?.score ?? null,
      promptHash: crypto.createHash("sha256").update(prompt).digest("hex").slice(0, 16),
      taskCapsulePath,
      acceptanceCriteria: item.acceptanceCriteria,
      verification: item.verification,
      alternates: ranked.slice(1, 4).map((row) => row.candidate.id),
    };
  });
  const plan = {
    schemaVersion: 1,
    generatedAt: utcStamp(),
    goal,
    workspace,
    horizonHours: Math.max(1, Math.min(12, Number(args.horizonHours || 5))),
    lifecycle: { current: "plan", stages: ["define", "plan", "execute", "verify", "review", "ship"] },
    communication: profileSummary(profile),
    capacity: {
      codex: context.codexTelemetry,
      claude: context.claudeUsage,
      antigravityEvidence: context.antigravityQuotaEvidence,
      cursorHeadless: context.cursorHeadlessFound,
    },
    contextCapsule: {
      path: capsuleResult.outputPath,
      hash: capsuleResult.capsule.capsuleHash,
      transcriptIncluded: false,
      taskCapsules: capsuleResult.taskCapsules,
    },
    fanOutReadyStageZero: shouldFanOut(workItems),
    oneWriterPerWorkspace: controls.maxParallelWriters === 1,
    oneWriterPerBoundary: true,
    maxParallelWriters: controls.maxParallelWriters,
    orchestrationDepth: 1,
    controls: {
      runDeadlineMinutes: controls.runDeadlineMinutes,
      capacityCheckpointMinutes: controls.capacityCheckpointMinutes,
      codexManagerReservePercent: controls.codexManagerReservePercent,
      maxConcurrentCodexWorkers: controls.maxConcurrentCodexWorkers,
      maxParallelWriters: controls.maxParallelWriters,
      crossResetContinuity: "durable-run-resume",
    },
    mainCodexRole: args.managerOnly
      ? [
          "Own the goal, lifecycle gates, resource decisions, and user communication.",
          "Launch dependency-ready actions in parallel when ownership is disjoint; serialize overlapping or unscoped writers.",
          "Do not inspect project files, run project diagnostics or tests, edit source, or duplicate worker execution.",
          "Critique compact artifacts once, request one bounded correction or provider-diverse failover, then record the integration decision.",
          "Approve only explicit user-boundary actions and report evidence-backed state.",
        ]
      : [
          "Own the goal, lifecycle gates, and architecture/risk decisions.",
          "Launch dependency-ready actions in parallel when ownership is disjoint; serialize overlapping or unscoped writers.",
          "Work directly on the narrow integration path while independent workers run.",
          "Critique artifacts once, request one bounded correction or provider-diverse failover, then integrate.",
          "Run final focused verification and report only evidence-backed completion.",
        ],
    actions,
    gates: {
      execute: "Goal, constraints, ownership, and acceptance criteria are explicit.",
      verify: "Every worker result is objective-specific and has focused evidence.",
      ship: "The main Codex session integrated outputs and final checks passed; worker completion alone is insufficient.",
    },
  };
  const planPath = path.join(bridgeRootFor(workspace), "orchestrator", "project-manager-plan.json");
  writeJsonFile(planPath, plan);

  const lines = [
    "AiMobileProjectManagerPlan:",
    `Goal: ${goal}`,
    `Workspace: ${workspace}`,
    `PlanPath: ${planPath}`,
    `ContextCapsule: ${capsuleResult.outputPath}`,
    `CapsuleHash: ${capsuleResult.capsule.capsuleHash}`,
    `Communication: ${profile.communicationStyle}; address=${profile.address || "none"}; role=${profile.role}`,
    `CodexCapacity: state=${context.codexTelemetry?.state || "unknown"}; remaining=${context.codexTelemetry?.effectiveRemainingPercent ?? "unknown"}%; fresh=${context.codexTelemetry?.fresh === true}`,
    `HostCodex: available=${args.hostCodexAvailable === true}; eligibleModels=${host.filter((candidate) => candidate.state === "available").map((candidate) => candidate.model).join(",") || "none"}`,
    ...projectManagerRunwayLines(controls, context, candidates),
    `ControlRoomMode: ${args.managerOnly ? "manager-only" : "manager-and-integrator"}`,
    `FanOutStageZero: ${plan.fanOutReadyStageZero}`,
    "Actions:",
  ];
  for (const action of actions) {
    lines.push(`- stage=${action.stage}; item=${action.workItemId}; resource=${action.resourceId}; model=${action.model}; effort=${action.reasoningEffort}; mode=${action.dispatchMode}; tool=${action.toolName}; dependsOn=${action.dependsOn.join(",") || "none"}`);
  }
  lines.push(
    "ExecutionContract:",
    args.managerOnly
      ? "- The current Codex session is the manager and reporter. Do not inspect project files, run project diagnostics/tests, edit source, or duplicate a worker."
      : "- The current Codex session is the PM, integration owner, and an active narrow contributor; it does not wait idly while independent work runs.",
    "- Execute only stage-0 independent actions in parallel. After each dependency gate, launch the next stage.",
    "- For host-subagent actions, call the host spawn-agent tool with the exact model and reasoning effort in project-manager-plan.json. Never launch codex.exe.",
    "- For external-cli actions, call the named AI Mobile submit tool with the stored bounded prompt. Use UI only when the CLI cannot represent required visible state.",
    "- Read each result once, merge once, and verify once. Workers may not create nested workers.",
    `Next: read ${planPath} for exact bounded prompts, then execute dependency-ready actions.`,
  );
  return lines.join("\n");
}

// Single source of truth for the manager-only default: every orchestration entrypoint must call this
// before reading args.managerOnly, so an omitted/undefined value never silently falls through to the
// less-safe manager-and-integrator mode.
function normalizeManagerOnly(args = {}) {
  return { ...args, managerOnly: args.managerOnly !== false };
}

function applyLocalRuntimePolicy(args = {}) {
  const localProfile = args.localProfile || (process.env.AI_MOBILE_SELF_TEST === "1" ? neutralLocalRoutingProfile() : readProfile());
  const unattendedMode = args.unattendedMode === true;
  return {
    ...args,
    localProfile,
    unattendedMode,
    allowAntigravityPermissionBypass: args.allowAntigravityPermissionBypass === true
      || (unattendedMode && localProfile.antigravityAutoApprovePermissions === true),
  };
}

function projectManagerRunwayLines(controls = normalizedRunControls({}), context = {}, resources = []) {
  const remaining = Number.isFinite(context.codexRemainingPercent)
    ? context.codexRemainingPercent
    : Number.isFinite(context.codexTelemetry?.effectiveRemainingPercent)
      ? context.codexTelemetry.effectiveRemainingPercent
      : null;
  const checkpointDelay = capacityCheckpointDelayMinutes({ ...controls, resources });
  return [
    `CodexManagerReserve: ${controls.codexManagerReservePercent}% remaining; current=${remaining === null ? "unknown" : `${remaining}%`}`,
    `CodexWorkerConcurrency: ${controls.maxConcurrentCodexWorkers}; non-Codex CLI workers retain independent capacity`,
    `ParallelWriters: ${controls.maxParallelWriters}; only pairwise-disjoint verified boundaries may overlap`,
    `CapacityCheckpoint: ${checkpointDelay}m; accelerates near the manager reserve without ending the project`,
    "QuotaResetContinuity: durable run state persists; running external work continues and pending work is reconsidered after capacity refresh",
  ];
}

function normalizeTaskLane(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function inferTaskSplit(goal, explicitSplit) {
  const explicit = String(explicitSplit || "")
    .split(/[,;|\n]+/)
    .map(normalizeTaskLane)
    .filter(Boolean);
  if (explicit.length) return [...new Set(explicit)].slice(0, 8);

  const text = String(goal || "").toLowerCase();
  const lanes = [];
  if (/\b(ui|frontend|front-end|css|react|screen|design|dashboard|browser|ux)\b/.test(text)) lanes.push("ui-frontend");
  if (/\b(api|backend|server|database|schema|auth|worker|queue|runtime|harness)\b/.test(text)) lanes.push("backend-runtime");
  if (/\b(test|tests|testing|qa|verify|verification|lint|ci|smoke|playwright)\b/.test(text)) lanes.push("testing-verification");
  if (/\b(docs|readme|release|marketplace|seo|publish)\b/.test(text)) lanes.push("docs-release");
  if (/\b(review|architecture|plan|refactor|audit)\b/.test(text)) lanes.push("architecture-review");
  if (!lanes.length) lanes.push("architecture-review", "implementation", "testing-verification");
  return [...new Set(lanes)];
}

function scoreTaskComplexity(args, split) {
  const goal = String(args.goal || "");
  const lower = goal.toLowerCase();
  let score = 0;
  if (split.length > 2) score += 3;
  if (/\b(refactor|architecture|migration|redesign)\b/.test(lower)) score += 3;
  if (/\b(orchestrat|multi-model|cross-platform|coordination|resource manager)\w*/.test(lower)) score += 4;
  if (/\b(plugin|bridge|integration)\b/.test(lower)) score += 2;
  if (/\b(css|design system|frontend overhaul)\b/.test(lower)) score += 2;
  if (/\b(debug|error|failure|stack trace|logs?)\b/.test(lower)) score += 2;
  if (/\b(test failure|build failure|failing tests?|ci failure)\b/.test(lower)) score += 2;
  if (goal.length > 800) score += 1;
  if (Number(args.estimatedCodexInputTokens || 0) >= 5000) score += 1;
  return score;
}

function normalizeComplexity(value, fallback = "medium") {
  const normalized = String(value || fallback).trim().toLowerCase();
  return ["low", "medium", "high", "critical"].includes(normalized) ? normalized : fallback;
}

function boundedTextList(values, maxItems = 12, maxChars = 500) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => truncateText(redactArtifactContent(String(value || "").trim()), maxChars))
    .filter(Boolean))].slice(0, maxItems);
}

function defaultOperationalBoundaries() {
  return [
    "Do not install connectors, request OAuth consent, or open authentication flows unless the user explicitly authorized that integration in this run.",
    "Protect browser and account state: do not log out, clear cookies or storage, switch or create profiles, change the signed-in account, or read saved credentials.",
    "Use only task-owned automation tabs. Stop at CAPTCHA, sign-in codes, emailed or SMS verification, and other human authentication gates; never access private messages to obtain codes.",
    "Externally consequential operations remain current-Codex actions with live preflight, bounded scope, and terminal evidence.",
  ];
}

function normalizedRunConstraints(args = {}) {
  return boundedTextList([
    ...defaultOperationalBoundaries(),
    ...(args.managerOnly === true
      ? ["Manager-only control room: the parent Codex task may steer, approve user-boundary actions, review compact evidence, and report, but must not explore project files, run project diagnostics or tests, edit source, or duplicate worker execution. Provider worker sessions/jobs remain allowed."]
      : []),
    ...(args.unattendedMode === true
      ? ["Unattended mode: continue only through non-interactive CLI/host workers. Tool-permission auto-approval never authorizes OAuth, login, CAPTCHA, email/SMS verification, external submissions, destructive actions, or work outside the assigned boundary."]
      : []),
    ...(Array.isArray(args.constraints) ? args.constraints : []),
  ], 20, 600);
}

function normalizedRunControls(args = {}) {
  const requestedDeadline = Number(args.runDeadlineMinutes ?? 0);
  const requestedCheckpoint = Number(args.capacityCheckpointMinutes ?? 20);
  const requestedWorkerCap = Number(args.maxWorkerMinutes ?? 0);
  const requestedManagerReserve = Number(args.codexManagerReservePercent ?? 15);
  const requestedConcurrentCodex = Number(args.maxConcurrentCodexWorkers ?? 1);
  const requestedParallelWriters = Number(args.maxParallelWriters ?? 2);
  return {
    runDeadlineMinutes: Number.isFinite(requestedDeadline) && requestedDeadline > 0
      ? Math.max(2, Math.min(10080, requestedDeadline))
      : 0,
    capacityCheckpointMinutes: Number.isFinite(requestedCheckpoint)
      ? Math.max(5, Math.min(240, requestedCheckpoint))
      : 20,
    codexManagerReservePercent: Number.isFinite(requestedManagerReserve)
      ? Math.max(5, Math.min(50, requestedManagerReserve))
      : 15,
    maxConcurrentCodexWorkers: Number.isFinite(requestedConcurrentCodex)
      ? Math.max(1, Math.min(3, Math.round(requestedConcurrentCodex)))
      : 1,
    maxParallelWriters: Number.isFinite(requestedParallelWriters)
      ? Math.max(1, Math.min(3, Math.round(requestedParallelWriters)))
      : 2,
    maxWorkerMinutes: Number.isFinite(requestedWorkerCap) && requestedWorkerCap > 0
      ? Math.max(1, Math.min(180, requestedWorkerCap))
      : 0,
    maxClaudeOutputTokens: Math.max(2000, Math.min(50000, Number(args.maxClaudeOutputTokens ?? 12000))),
    maxClaudeBudgetUsd: Number.isFinite(Number(args.maxClaudeBudgetUsd ?? 0)) && Number(args.maxClaudeBudgetUsd ?? 0) > 0
      ? Math.max(0.1, Math.min(10, Number(args.maxClaudeBudgetUsd)))
      : 0,
  };
}

function workerMinutesFor(manifest, complexityRank, platform, readOnly = false) {
  const desired = platform === "antigravity"
    ? (readOnly
      ? ({ 1: 5, 2: 8, 3: 12, 4: 20 })[complexityRank]
      : ({ 1: 10, 2: 20, 3: 40, 4: 60 })[complexityRank])
    : (readOnly
      ? ({ 1: 8, 2: 12, 3: 20, 4: 30 })[complexityRank]
      : ({ 1: 10, 2: 20, 3: 45, 4: 90 })[complexityRank]);
  const adaptiveLease = desired || 20;
  const optionalCap = Number(manifest.maxWorkerMinutes || 0);
  return Math.max(1, optionalCap > 0 ? Math.min(optionalCap, adaptiveLease) : adaptiveLease);
}

function cachedClaudeAuth() {
  return readSafeResourceCache().claude?.auth || { checked: false, loggedIn: null };
}

function claudeSubscriptionBillingActive(auth = {}, env = process.env) {
  if (String(env.ANTHROPIC_API_KEY || "").trim()) return false;
  if (env.CLAUDE_CODE_USE_BEDROCK === "1" || env.CLAUDE_CODE_USE_VERTEX === "1") return false;
  const authMethod = String(auth.authMethod || "").trim().toLowerCase();
  const apiProvider = String(auth.apiProvider || "").trim().toLowerCase();
  return auth.loggedIn === true
    && authMethod === "claude.ai"
    && (!apiProvider || apiProvider === "firstparty")
    && /^(pro|max|team|enterprise)\b/i.test(String(auth.subscriptionType || "").trim());
}

function claudeBudgetPolicy(manifest = {}, auth = cachedClaudeAuth(), env = process.env) {
  const explicitCap = Number(manifest.maxClaudeBudgetUsd || 0);
  if (Number.isFinite(explicitCap) && explicitCap > 0) return { policy: "explicit-usd-cap", capUsd: Math.max(0.1, Math.min(10, explicitCap)) };
  if (claudeSubscriptionBillingActive(auth, env)) return { policy: "subscription-quota-windows", capUsd: null };
  return { policy: "auto-usd-cap", capUsd: 0.75 };
}

function describeClaudeBudgetPolicy(manifest = {}, auth = cachedClaudeAuth(), env = process.env) {
  const policy = claudeBudgetPolicy(manifest, auth, env);
  return policy.capUsd === null
    ? "subscription-quota-windows (included plan; no --max-budget-usd; measured 5h/weekly/model windows plus output-token and lease guards)"
    : `${policy.policy}<=$${policy.capUsd}/worker`;
}

function claudeBudgetFor(manifest, complexityRank, auth = cachedClaudeAuth(), env = process.env) {
  const policy = claudeBudgetPolicy(manifest, auth, env);
  if (policy.capUsd === null) return null;
  if (policy.policy === "explicit-usd-cap") return policy.capUsd;
  const desired = ({ 1: 0.2, 2: 0.35, 3: 0.55, 4: 0.75 })[complexityRank] || 0.35;
  return Math.max(0.1, Math.min(policy.capUsd, desired));
}

function capabilitiesForWorkItem(kind, objective) {
  const text = `${kind || ""} ${objective || ""}`.toLowerCase();
  const capabilities = new Set(["general-reasoning"]);
  if (/discover|research|inspect|context|explor|requirements?/.test(text)) capabilities.add("discovery");
  if (/architect|design|plan|system|migration|refactor/.test(text)) capabilities.add("architecture");
  if (/implement|code|patch|fix|backend|frontend|ui|api|database|schema/.test(text)) capabilities.add("implementation");
  if (/debug|failure|error|outage|root cause/.test(text)) capabilities.add("debugging");
  if (/test|verify|validation|qa|lint|build|ci/.test(text)) capabilities.add("testing");
  if (/review|audit|critique|risk/.test(text)) capabilities.add("review");
  if (/docs|readme|release|seo|marketplace/.test(text)) capabilities.add("docs");
  if (/\b(ui|frontend|css|screen|design|ux)\b/.test(text)) capabilities.add("ui");
  return [...capabilities];
}

function isExternallyConsequential(value) {
  const text = String(value || "").toLowerCase().replace(/\s+/g, " ");
  if (!text) return false;
  return [
    /\b(?:apply|submi(?:t|ssion))\w*\b.{0,48}\b(?:job|application|form|claim|request|order)\b/,
    /\b(?:job|application|form|claim|request|order)\b.{0,48}\b(?:apply|submi(?:t|ssion))\w*\b/,
    /\b(?:start|continue|perform|run|make)\w*\b.{0,64}\b(?:real|live|actual|controlled)\b.{0,32}\bjob (?:applications?|submissions?)\b/,
    /\b(?:send|email|message|post|publish|deploy|release)\w*\b.{0,48}\b(?:real|live|production|public|customer|client|recipient|github|site)\b/,
    /\b(?:real|live|production|public)\b.{0,48}\b(?:send|email|message|post|publish|deploy|release|delete|cancel|start|stop|restart)\w*\b/,
    /\b(?:purchase|buy|charge|pay|refund|transfer)\w*\b/,
    /\b(?:delete|cancel)\w*\b.{0,48}\b(?:account|subscription|data|record|production|live)\b/,
  ].some((pattern) => pattern.test(text));
}

function normalizeExecutionClass(value, readOnly, externallyConsequential, kind) {
  const requested = String(value || "").trim().toLowerCase();
  if (externallyConsequential) return "operation";
  if (["analysis", "code", "operation", "integration"].includes(requested)) return requested;
  if (/integrat|merge|ship|release/.test(String(kind || ""))) return "integration";
  return readOnly ? "analysis" : "code";
}

function normalizeVerificationCommands(value) {
  return normalizeVerificationCommandList(value, truncateText);
}

function normalizeWorkItem(item, index, fallbackComplexity) {
  const requestedClass = String(item.executionClass || item.class || "").trim().toLowerCase();
  const objective = String(item.objective || item.description || item.title || "").trim();
  const classKind = ["analysis", "code", "operation", "integration"].includes(requestedClass) ? requestedClass : "";
  const kind = normalizeTaskLane(item.kind || classKind || "general") || "general";
  const writeIntent = /(implementation|implement|patch|fix|correct|debug|migration|refactor|operation|execute|submission|integrat|reconcile|restore|reduce)/.test(`${kind} ${objective}`.toLowerCase());
  const inferredReadOnly = requestedClass === "analysis"
    ? true
    : ["code", "operation", "integration"].includes(requestedClass)
      ? false
      : !writeIntent;
  const requestedReadOnly = requestedClass === "analysis"
    ? true
    : ["code", "operation", "integration"].includes(requestedClass)
      ? false
      : typeof item.readOnly === "boolean"
        ? item.readOnly
        : inferredReadOnly;
  const externallyConsequential = item.externallyConsequential === true
    || (!requestedReadOnly && isExternallyConsequential(`${kind} ${objective}`));
  const readOnly = externallyConsequential
    ? false
    : requestedReadOnly;
  return {
    id: normalizeTaskLane(item.id || `work-${index + 1}`) || `work-${index + 1}`,
    objective: objective || `Complete work item ${index + 1}`,
    kind,
    complexity: normalizeComplexity(item.complexity, fallbackComplexity),
    requiredCapabilities: [...new Set([
      ...capabilitiesForWorkItem(kind, objective),
      ...(Array.isArray(item.requiredCapabilities || item.capabilities) ? (item.requiredCapabilities || item.capabilities).map(normalizeTaskLane).filter(Boolean) : []),
    ])],
    dependsOn: Array.isArray(item.dependsOn) ? item.dependsOn.map(normalizeTaskLane).filter(Boolean) : [],
    expectedFiles: Array.isArray(item.expectedFiles || item.files) ? (item.expectedFiles || item.files).map((value) => String(value || "").trim()).filter(Boolean).slice(0, 20) : [],
    readOnly,
    executionClass: normalizeExecutionClass(requestedClass, readOnly, externallyConsequential, kind),
    externallyConsequential,
    preferredPlatform: normalizeTaskLane(item.preferredPlatform || item.platform || ""),
    acceptanceCriteria: Array.isArray(item.acceptanceCriteria || item.acceptance) ? (item.acceptanceCriteria || item.acceptance).map((value) => String(value || "").trim()).filter(Boolean).slice(0, 4) : [],
    verification: Array.isArray(item.verification || item.tests) ? (item.verification || item.tests).map((value) => String(value || "").trim()).filter(Boolean).slice(0, 4) : [],
    verificationCommands: normalizeVerificationCommands(item.verificationCommands),
    priority: Math.max(0, Math.min(100, Number(item.priority ?? 50))),
    state: "pending",
    failoverCount: 0,
  };
}

function injectLiveOperationDependencies(items) {
  const operations = items
    .filter((item) => item.externallyConsequential && item.executionClass === "operation")
    .sort((a, b) => b.priority - a.priority);
  if (!operations.length) return items;
  return items.map((item) => {
    if (item.externallyConsequential || item.dependsOn.length) return item;
    const liveDependent = /\b(live|current|runtime|throughput|candidate|submission|dashboard|health|operator|bottleneck|unattended|runner|watchdog)\b/i
      .test(`${item.kind} ${item.objective}`);
    if (!liveDependent) return item;
    const operation = operations.find((candidate) => !(candidate.dependsOn || []).includes(item.id));
    return operation ? { ...item, dependsOn: [operation.id], dependencyPolicy: "live-operation-evidence" } : item;
  });
}

function buildGoalWorkGraph(args = {}) {
  const goal = String(args.goal || "").trim();
  const legacySplit = inferTaskSplit(goal, args.taskSplit || "");
  const score = scoreTaskComplexity(args, legacySplit);
  const fallbackComplexity = score >= 8 ? "critical" : score >= 5 ? "high" : score >= 2 ? "medium" : "low";
  let rawItems = Array.isArray(args.workItems)
    ? args.workItems.flat(1).filter((item) => item && typeof item === "object" && !Array.isArray(item))
    : [];

  if (!rawItems.length && String(args.taskSplit || "").trim()) {
    rawItems = legacySplit.map((lane, index) => ({
      id: lane,
      objective: `Own the ${lane} part of the common goal: ${goal}`,
      kind: lane,
      complexity: fallbackComplexity,
      readOnly: /review|audit|research|docs|test|verification/.test(lane),
      priority: 80 - index,
    }));
  }

  if (!rawItems.length) {
    const reviewOnly = String(args.mode || "patch").toLowerCase() === "review";
    const consequentialGoal = !reviewOnly && isExternallyConsequential(goal);
    const needsGoalContext = fallbackComplexity !== "low" || consequentialGoal;
    if (needsGoalContext) {
      rawItems.push({
        id: "goal-context",
        objective: `Inspect the project and identify the smallest high-leverage path to: ${goal}`,
        kind: "discovery-architecture",
        complexity: fallbackComplexity,
        readOnly: true,
        priority: 85,
      });
    }
    rawItems.push({
      id: reviewOnly ? "independent-review" : "goal-implementation",
      objective: reviewOnly ? `Independently review the project against this goal: ${goal}` : `Implement the safest complete change that achieves: ${goal}`,
      kind: reviewOnly ? "review" : "implementation-debugging",
      complexity: fallbackComplexity,
      readOnly: reviewOnly,
      dependsOn: !reviewOnly && needsGoalContext ? ["goal-context"] : [],
      priority: 95,
    });
    if (!reviewOnly) {
      rawItems.push({
        id: "independent-verification",
        objective: `Verify the implementation against the complete goal and report concrete gaps only: ${goal}`,
        kind: "testing-review",
        complexity: fallbackComplexity,
        readOnly: true,
        dependsOn: ["goal-implementation"],
        priority: 90,
      });
    }
  }

  const normalized = rawItems.slice(0, 12).map((item, index) => normalizeWorkItem(item, index, fallbackComplexity));
  const unique = [];
  const ids = new Set();
  for (const item of normalized) {
    let id = item.id;
    let suffix = 2;
    while (ids.has(id)) id = `${item.id}-${suffix++}`;
    ids.add(id);
    unique.push({ ...item, id });
  }
  const validIds = new Set(unique.map((item) => item.id));
  const validGraph = unique.map((item) => ({ ...item, dependsOn: item.dependsOn.filter((id) => validIds.has(id) && id !== item.id) }));
  return injectLiveOperationDependencies(validGraph);
}

function activeWriterJobs(manifest = {}) {
  return (manifest.jobs || []).filter((job) => ["queued", "running", "unknown"].includes(job.state)
    && (job.workItemIds || job.assignedTasks || []).some((id) => (manifest.workItems || []).find((item) => item.id === id && !item.readOnly)));
}

function writerGroupCanLaunch(manifest = {}, items = []) {
  const writers = items.filter((item) => !item.readOnly);
  if (!writers.length) return true;
  const activeJobs = activeWriterJobs(manifest);
  const maxParallelWriters = Math.max(1, Math.min(3, Number(manifest.maxParallelWriters || 2)));
  if (activeJobs.length >= maxParallelWriters) return false;
  const byId = new Map((manifest.workItems || []).map((item) => [item.id, item]));
  const activeWriters = activeJobs.flatMap((job) => (job.workItemIds || job.assignedTasks || [])
    .map((id) => byId.get(id))
    .filter((item) => item && !item.readOnly));
  return writers.every((writer) => activeWriters.every((active) => writerItemsAreDisjoint(writer, active)));
}

function codexWorkerCanLaunch(manifest = {}, resource = {}) {
  if (resourcePlatform(resource) !== "codex" || resource.id === "codex:current") return true;
  const limit = Math.max(1, Math.min(3, Number(manifest.maxConcurrentCodexWorkers || 1)));
  const active = (manifest.jobs || []).filter((job) => {
    if (!["queued", "running", "unknown"].includes(job.state)) return false;
    if (job.transport === "host-subagent") return true;
    return String(job.resourceId || "").startsWith("codex-cli:");
  }).length;
  return active < limit;
}

function parallelWriterIds(workItems = []) {
  const byId = new Map(workItems.map((item) => [item.id, item]));
  const memo = new Map();
  const result = new Set();
  const writers = workItems.filter((item) => !item.readOnly && !item.externallyConsequential);
  for (let index = 0; index < writers.length; index += 1) {
    for (let peerIndex = index + 1; peerIndex < writers.length; peerIndex += 1) {
      const left = writers[index];
      const right = writers[peerIndex];
      if (topologicalStage(left, byId, memo) !== topologicalStage(right, byId, memo)) continue;
      if (!writerItemsAreDisjoint(left, right)) continue;
      result.add(left.id);
      result.add(right.id);
    }
  }
  return result;
}

function requiredQuality(complexity) {
  return { low: 55, medium: 68, high: 82, critical: 90 }[normalizeComplexity(complexity)] || 68;
}

function hoursUntil(value) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? (timestamp - Date.now()) / (60 * 60 * 1000) : null;
}

function premiumCapacityOpportunity(candidate, item, args = {}) {
  if (!candidate.premium || !["high", "critical"].includes(item.complexity)) return false;
  const resetHours = hoursUntil(candidate.dedicatedResetAt);
  const horizon = Math.max(1, Math.min(12, Number(args.horizonHours || 5)));
  return Number.isFinite(candidate.dedicatedRemainingPercent)
    && candidate.dedicatedRemainingPercent >= 40
    && Number.isFinite(candidate.sharedRemainingPercent)
    && candidate.sharedRemainingPercent >= 30
    && Number.isFinite(resetHours)
    && resetHours > 0
    && resetHours <= horizon;
}

function scoreResourceForWorkItem(candidate, item, args = {}, primaryWriterId = "") {
  if (!candidate.dispatchable || candidate.state !== "available") return Number.NEGATIVE_INFINITY;
  const localProfile = args.localProfile || neutralLocalRoutingProfile();
  const availableCapabilities = new Set(candidate.capabilities || []);
  const required = item.requiredCapabilities || [];
  const matched = required.filter((capability) => availableCapabilities.has(capability));
  const capabilityScore = required.length ? (matched.length / required.length) * 42 : 25;
  const qualityFloor = requiredQuality(item.complexity);
  const qualityGap = candidate.quality - qualityFloor;
  let score = capabilityScore + Math.min(30, Math.max(-30, 18 + qualityGap));
  score += candidate.speed * (item.complexity === "low" ? 0.16 : 0.08);
  score += candidate.cost * (item.complexity === "low" || item.kind.includes("discovery") ? 0.14 : 0.05);
  if (candidate.remainingPercent !== null) score += Math.max(-20, Math.min(15, (candidate.remainingPercent - 30) / 4));
  if (candidate.platform === "codex" && candidate.id !== "codex:current" && Number.isFinite(candidate.capacityHeadroomPercent) && candidate.capacityHeadroomPercent < 30) {
    score -= Math.min(40, (30 - candidate.capacityHeadroomPercent) * 1.5);
  }
  if (candidate.evidence === "observed-run" || candidate.evidence === "measured-live") score += 7;
  if (localProfile.adaptiveRouting !== false) {
    if ((candidate.outcome?.successfulKinds || []).includes(item.kind)) score += 8;
    score -= Math.min(24, Math.max(0, Number(candidate.outcome?.consecutiveFailures || 0)) * 8);
  }
  if (item.preferredPlatform && item.preferredPlatform === candidate.platform) score += 25;
  const requestedClaudeModel = normalizedModelText(args.claudeModel || "");
  if (candidate.platform === "claude" && requestedClaudeModel && requestedClaudeModel !== "auto") {
    const candidateModelText = normalizedModelText(`${candidate.model} ${candidate.displayName}`);
    const requestedFamily = ["haiku", "sonnet", "opus", "fable"].find((family) => requestedClaudeModel.includes(family)) || "";
    const matches = candidateModelText.includes(requestedClaudeModel) || (requestedFamily && candidateModelText.includes(requestedFamily));
    if (matches) score += 60;
    else score -= 1000;
  }
  if (String(args.agyModel || "auto").toLowerCase() !== "auto" && candidate.platform === "antigravity") {
    const preference = normalizedModelText(args.agyModel);
    if (normalizedModelText(`${candidate.model} ${candidate.displayName}`).includes(preference)) score += 40;
    else score -= 20;
  }
  if (candidate.platform === "claude" && !item.readOnly) score += ["high", "critical"].includes(item.complexity) ? 22 : 14;
  if (candidate.platform === "claude" && regexMatches(`${candidate.model} ${candidate.displayName}`, localProfile.claudePreferredModelPattern, false)) {
    score += 14;
  }
  if (candidate.platform === "antigravity" && regexMatches(`${item.kind} ${item.objective}`, localProfile.antigravityPreferredTaskPattern, false)) {
    score += 14;
  }
  const capacityOpportunity = premiumCapacityOpportunity(candidate, item, args);
  const premiumWork = item.complexity === "critical"
    || capacityOpportunity
    || /security|incident|production|migration|release|irreversible|adversarial/.test(`${item.kind} ${item.objective}`.toLowerCase());
  const isFable = candidate.platform === "claude" && /fable/i.test(`${candidate.model} ${candidate.displayName}`);
  const fableRequested = normalizedModelText(args.claudeModel || "").includes("fable");
  const agyPremiumRequested = candidate.platform === "antigravity"
    && String(args.agyModel || "auto").toLowerCase() !== "auto"
    && normalizedModelText(`${candidate.model} ${candidate.displayName}`).includes(normalizedModelText(args.agyModel));
  if (isFable) {
    if (args.allowPremiumModels !== true && !fableRequested && !capacityOpportunity) score -= 1000;
  } else if (candidate.premium && args.allowPremiumModels !== true && !premiumWork && !agyPremiumRequested) {
    score -= 1000;
  }
  if (candidate.premium && candidate.remainingPercent === null && args.allowPremiumModels !== true && !agyPremiumRequested) score -= 1000;
  if (capacityOpportunity) score += 18;
  if (candidate.remainingPercent !== null && candidate.remainingPercent < 15) score -= 25;
  if (candidate.platform === "antigravity" && /flash/i.test(candidate.displayName) && item.readOnly && !["critical"].includes(item.complexity)) score += 18;
  const microTask = item.complexity === "low"
    && Array.isArray(item.expectedFiles)
    && item.expectedFiles.length > 0
    && item.expectedFiles.length <= 2
    && String(item.objective || "").length <= 280;
  const platformFailures = Math.max(0, Number(candidate.platformReliability?.recentFailures || 0));
  const platformSuccesses = Math.max(0, Number(candidate.platformReliability?.recentSuccesses || 0));
  if (localProfile.adaptiveRouting !== false && !microTask && platformFailures > platformSuccesses) {
    score -= platformFailures >= 2 && platformSuccesses === 0
      ? 35
      : Math.min(24, (platformFailures - platformSuccesses) * 10);
  }
  if (candidate.platform === "antigravity" && /flash.*low|low.*flash/i.test(candidate.displayName) && !microTask) score -= 10;
  if (candidate.platform === "antigravity" && /flash.*medium|medium.*flash/i.test(candidate.displayName) && item.readOnly && !microTask) score += 3;
  if (candidate.platform === "cursor" && item.requiredCapabilities.includes("ui")) score += 15;
  if (item.readOnly && primaryWriterId && candidate.id !== primaryWriterId) score += 10;
  if (item.readOnly && primaryWriterId === candidate.id) score -= 12;
  return Math.round(score * 10) / 10;
}

function rankResourcesForWorkItem(candidates, item, args = {}, primaryWriterId = "") {
  return candidates
    .map((candidate) => ({ candidate, score: scoreResourceForWorkItem(candidate, item, args, primaryWriterId) }))
    .filter((row) => Number.isFinite(row.score))
    .sort((a, b) => b.score - a.score || b.candidate.quality - a.candidate.quality);
}

function selectAlternateResourceIds(ranked, selectedCandidate, limit = 3) {
  const alternatives = ranked.filter((row) => row.candidate.id !== selectedCandidate?.id);
  const selected = alternatives.slice(0, limit);
  const crossPlatform = selectedCandidate
    ? alternatives.find((row) => row.candidate.platform !== selectedCandidate.platform)
    : null;
  if (crossPlatform && !selected.some((row) => row.candidate.id === crossPlatform.candidate.id)) {
    if (selected.length >= limit) selected[selected.length - 1] = crossPlatform;
    else selected.push(crossPlatform);
  }
  return selected.map((row) => row.candidate.id);
}

function resourceCapacityReason(candidate, item, args = {}) {
  const remaining = candidate.remainingPercent === null ? "remaining unknown" : `${candidate.remainingPercent}% remaining`;
  const reset = candidate.resetAt ? `reset ${candidate.resetAt}` : "reset unknown";
  if (premiumCapacityOpportunity(candidate, item, args)) return `${remaining}; ${reset}; dedicated premium window should be used for this high-value item before reset`;
  if (Array.isArray(candidate.quotaWindows) && candidate.quotaWindows.length > 1) return `${remaining}; ${reset}; most restrictive of ${candidate.quotaWindows.length} applicable quota windows`;
  return `${remaining}; ${reset}`;
}

function isRedundantOperationalReview(item, byId) {
  if (!item.readOnly || item.complexity !== "low" || (item.expectedFiles || []).length || !(item.dependsOn || []).length) return false;
  if (!/review|verify|verification|summary|closeout/.test(`${item.kind} ${item.objective}`.toLowerCase())) return false;
  return item.dependsOn.every((id) => byId.get(id)?.externallyConsequential === true);
}

function requiresProtectedLiveState(item) {
  const text = `${item.kind} ${item.objective}`.toLowerCase();
  const protectedState = /\b(authenticated|authentication|signed[- ]?in|login|session|cookie|browser profile|account|oauth|email|sms|captcha|credential)s?\b/.test(text);
  const stateAction = /\b(check|verify|inspect|confirm|open|access|use|switch|select|read|authenticate|login)\b/.test(text);
  if (!protectedState || !stateAction) return false;
  const explicitLiveState = /\b(live|current|actual|authenticated|signed[- ]?in|login state|session state)\b/.test(text);
  const sourceReview = /\b(code|source|implementation|test|module|file|function|class)\b/.test(text)
    || (Array.isArray(item.expectedFiles) && item.expectedFiles.length > 0);
  return explicitLiveState || !sourceReview;
}

function buildResourceOrchestrationDecision(args = {}, context = {}) {
  args = applyLocalRuntimePolicy(normalizeManagerOnly(args));
  const managerOnly = args.managerOnly === true;
  const localProfile = args.localProfile || (process.env.AI_MOBILE_SELF_TEST === "1" ? neutralLocalRoutingProfile() : readProfile());
  const routingArgs = { ...args, localProfile };
  const candidates = [
    ...buildResourceCandidates(routingArgs, context),
    ...buildNativeCodexCandidates(routingArgs, context),
  ];
  const workItems = buildGoalWorkGraph(args);
  const workItemsById = new Map(workItems.map((item) => [item.id, item]));
  const stageMemo = new Map();
  const parallelWriters = parallelWriterIds(workItems);
  const stageResourceCounts = new Map();
  const stagePlatformCounts = new Map();
  const writable = workItems.filter((item) => !item.readOnly && !item.externallyConsequential).sort((a, b) => b.priority - a.priority);
  let primaryWriterId = "";
  if (writable.length) {
    primaryWriterId = rankResourcesForWorkItem(candidates, writable[0], routingArgs)[0]?.candidate.id || "";
  }

  const decisions = [];
  const assignedItems = workItems.map((item) => {
    const directOperationalReview = isRedundantOperationalReview(item, workItemsById);
    const protectedLiveState = requiresProtectedLiveState(item);
    if (item.externallyConsequential || protectedLiveState || (directOperationalReview && !managerOnly)) {
      const reason = directOperationalReview
        ? "low-complexity review of current-Codex operational evidence; redundant external dispatch omitted"
        : protectedLiveState
          ? "protected live browser/account/authentication state; the current Codex session retains direct inspection and user-boundary ownership"
          : "externally consequential operation; the current Codex session retains authorization, live-state checks, and execution ownership";
      decisions.push({
        workItemId: item.id,
        resourceId: "codex:current",
        model: context.codexModel,
        score: null,
        reason,
        alternates: [],
      });
      return {
        ...item,
        assignment: "codex:current",
        assignedModel: context.codexModel,
        alternates: [],
        decisionReason: reason,
      };
    }
    const stage = topologicalStage(item, workItemsById, stageMemo);
    const canParallelize = item.readOnly || parallelWriters.has(item.id);
    const ranked = rankResourcesForWorkItem(candidates, item, routingArgs, primaryWriterId)
      .map((row) => ({
        ...row,
        score: canParallelize
          ? Math.round((row.score
            - ((stageResourceCounts.get(`${stage}:${row.candidate.id}`) || 0) * 32)
            - ((stagePlatformCounts.get(`${stage}:${row.candidate.platform}`) || 0) * 10)) * 10) / 10
          : row.score,
      }))
      .sort((a, b) => b.score - a.score || b.candidate.quality - a.candidate.quality);
    let selected = ranked[0];
    const stageAlreadyAssigned = [...stageResourceCounts.keys()].some((key) => key.startsWith(`${stage}:`));
    if (canParallelize && stageAlreadyAssigned) {
      const unusedCrossPlatform = ranked.find((row) => (stageResourceCounts.get(`${stage}:${row.candidate.id}`) || 0) === 0
        && (stagePlatformCounts.get(`${stage}:${row.candidate.platform}`) || 0) === 0);
      const unusedResource = ranked.find((row) => (stageResourceCounts.get(`${stage}:${row.candidate.id}`) || 0) === 0);
      selected = unusedCrossPlatform || unusedResource || selected;
    }
    if (!item.readOnly && primaryWriterId && !parallelWriters.has(item.id)) selected = ranked.find((row) => row.candidate.id === primaryWriterId) || selected;
    const assignment = selected?.candidate || null;
    if (assignment) {
      stageResourceCounts.set(`${stage}:${assignment.id}`, (stageResourceCounts.get(`${stage}:${assignment.id}`) || 0) + 1);
      stagePlatformCounts.set(`${stage}:${assignment.platform}`, (stagePlatformCounts.get(`${stage}:${assignment.platform}`) || 0) + 1);
    }
    const alternates = selectAlternateResourceIds(ranked, assignment, 3);
    const fallbackResourceId = managerOnly ? "resource:unavailable" : "codex:current";
    const reason = assignment
      ? `capability/quality/capacity score ${selected.score}; ${assignment.evidence}; ${resourceCapacityReason(assignment, item, routingArgs)}; ${item.readOnly ? "independent read-only work" : parallelWriters.has(item.id) ? "disjoint parallel writer boundary" : "serialized workspace writer"}`
      : managerOnly
        ? "no dispatchable worker currently satisfies the work item; manager-only mode refuses silent current-Codex execution"
        : "no dispatchable resource currently satisfies the work item";
    decisions.push({
      workItemId: item.id,
      resourceId: assignment?.id || fallbackResourceId,
      model: assignment?.model || (managerOnly ? "none" : context.codexModel),
      score: selected?.score ?? null,
      reason,
      alternates,
    });
    return {
      ...item,
      assignment: assignment?.id || fallbackResourceId,
      assignedModel: assignment?.model || (managerOnly ? "none" : context.codexModel),
      alternates,
      decisionReason: reason,
    };
  });

  return { candidates, workItems: assignedItems, decisions, primaryWriterId };
}

function persistOrchestrationDecision(workspace, goal, decision) {
  const goalHash = crypto.createHash("sha256").update(String(goal || "")).digest("hex").slice(0, 16);
  const safeDecisions = decision.decisions.map((item) => ({
    at: utcStamp(),
    goalHash,
    workItemId: item.workItemId,
    resourceId: item.resourceId,
    model: item.model,
    reason: item.reason,
  }));
  mutateWorkspaceResourceState(workspace, (state) => ({
    ...state,
    lastGoalHash: goalHash,
    decisions: [...(state.decisions || []), ...safeDecisions].slice(-50),
  }));
}

function formatTeamOrchestrationPlan(args = {}, context = {}) {
  const goal = String(args.goal || "").trim();
  const workspace = String(args.workspace || "").trim();
  const horizonHours = Math.max(1, Math.min(12, Number(args.horizonHours || 5)));
  const controls = normalizedRunControls(args);
  const decision = buildResourceOrchestrationDecision(args, context);
  const resources = new Map(decision.candidates.map((candidate) => [candidate.id, candidate]));
  const dispatchable = decision.candidates.filter((candidate) => candidate.dispatchable && candidate.state === "available");

  return [
    "AiMobileResourceOrchestrationPlan:",
    `Goal: ${goal || "<missing>"}`,
    `Workspace: ${workspace || "<missing>"}`,
    `CapacityHorizonHours: ${horizonHours} (rolling forecast, not a countdown)`,
    `ProjectDuration: ${controls.runDeadlineMinutes > 0 ? `optional deadline ${controls.runDeadlineMinutes}m` : "continuous until verified, blocked, or explicitly stopped"}`,
    `CompletionPolicy: ${completionPolicyFrom(args)}${completionPolicyFrom(args) === "continuous-management" ? "; delivery cycles cannot complete the root Goal" : ""}`,
    `CapacityCheckpointMinutes: ${controls.capacityCheckpointMinutes}`,
    `CodexManagerReserve: ${controls.codexManagerReservePercent}% remaining; native workers stop at the reserve and are penalized as headroom shrinks`,
    `CodexWorkerConcurrency: ${controls.maxConcurrentCodexWorkers}; non-Codex providers retain independent parallelism`,
    `ParallelWriters: ${controls.maxParallelWriters}; overlapping or unscoped writers remain serialized`,
    `WorkerLeasePolicy: ${controls.maxWorkerMinutes > 0 ? `adaptive with ${controls.maxWorkerMinutes}m ceiling` : "complexity-adaptive (10m to 90m), no global worker cap"}`,
    `MaxClaudeOutputTokens: ${controls.maxClaudeOutputTokens}`,
    `AntigravityCliAutoDispatch: ${args.allowAntigravityCli === true}`,
    `UnattendedMode: ${args.unattendedMode === true}; AntigravityPermissionMode: ${args.unattendedMode === true && args.allowAntigravityPermissionBypass === true ? "sandboxed-auto-approve" : args.unattendedMode === true ? "excluded-if-interactive" : "interactive"}`,
    `ControlRoomMode: ${args.managerOnly === true ? "manager-only" : "manager-and-integrator"}`,
    `OperatingMode: ${dispatchable.length ? "goal-driven-team" : "codex-only-until-workers-available"}`,
    "UtilizationPolicy: use appropriate healthy resources for distinct dependency-ready work; never duplicate a lane merely to keep every model busy.",
    args.managerOnly === true
      ? "Orchestrator: Codex owns goal interpretation, capacity decisions, steering, evidence review, and reporting; workers own project exploration, diagnostics, implementation, and tests."
      : "Orchestrator: Codex owns goal interpretation, risk, feedback, integration, and final verification; workers own bounded execution.",
    "",
    "ResourceEvidence:",
    ...decision.candidates.map((candidate) => {
      const remaining = candidate.remainingPercent === null ? "unknown" : `${candidate.remainingPercent}%`;
      return `- ${candidate.id}: state=${candidate.state}; remaining=${remaining}; evidence=${candidate.evidence}; model=${candidate.displayName}`;
    }),
    "",
    "WorkGraphAndAssignments:",
    ...decision.workItems.map((item, index) => {
      const resource = resources.get(item.assignment);
      return `${index + 1}. ${item.id}: ${item.objective}; kind=${item.kind}; complexity=${item.complexity}; readOnly=${item.readOnly}; dependsOn=${item.dependsOn.join(",") || "none"}; assigned=${resource?.team || "Codex"}/${item.assignedModel}; reason=${item.decisionReason}`;
    }),
    "",
    "ControlLoop:",
    "1. Inventory measured, observed, cached, caller-provided, and unknown capacity without opening desktop apps.",
    "2. Dispatch dependency-ready work concurrently across standalone or host-native Codex and other provider CLIs. Read-only lanes may fan out; writers overlap only with pairwise-disjoint verified boundaries.",
    "3. Read compact artifacts and per-run telemetry, then continue dependent work automatically within the bounded wait.",
    "4. On quota, outage, timeout, auth, or model failure, cool down that resource and fail over the narrow work item once.",
    "5. Protect manager runway: before the shared Codex pool reaches its reserve, route remaining work to durable external CLI jobs so the local supervisor can continue without Codex tokens.",
    args.managerOnly === true
      ? "6. Codex critiques compact worker output, requests a narrow correction when needed, records the integration decision, and reports verified state without repeating project work."
      : "6. Codex critiques worker output, requests a narrow correction when needed, integrates the accepted result, and performs final verification.",
    "7. Persist only compact decision/outcome evidence so a reset or restarted manager resumes without replaying the project.",
    "",
    "Execution:",
    "Use run-project-manager for normal dispatch and project-manager-status for continuation. Do not reconstruct provider commands from this plan.",
  ].filter(Boolean).join("\n");
}

async function buildTeamOrchestrationPlan(args = {}) {
  args = normalizeManagerOnly(args);
  const context = await getTeamCapacityContext(args);
  return formatTeamOrchestrationPlan(args, context);
}

function actionSummary(action, toolName, workspace, lane = {}) {
  const jobId = valueFromResult(action, "JobId");
  const workerPidValue = Number(valueFromResult(action, "WorkerPid"));
  const started = /\bStarted:\s*true\b/i.test(action) || /\bState:\s*running\b/i.test(action);
  const failed = /\bState:\s*failed\b/i.test(action) || /\bBlocker:/i.test(action);
  return {
    toolName,
    laneId: lane.id || toolName,
    worker: lane.worker || toolName,
    assignedTasks: lane.assignedTasks || [],
    model: lane.model || "",
    jobId,
    workerPid: Number.isInteger(workerPidValue) && workerPidValue > 0 ? workerPidValue : null,
    workerCommandMarker: jobId || "",
    started: started && !failed,
    failed,
    readBack: jobId ? `ai-mobile-local.read-job with workspace=${workspace} and jobId=${jobId}` : "no JobId returned",
    action,
  };
}

function candidateFromManifest(manifest, resourceId) {
  return (manifest.resources || []).find((candidate) => candidate.id === resourceId) || null;
}

function availableAlternateForItem(manifest, item) {
  for (const resourceId of item.alternates || []) {
    const candidate = candidateFromManifest(manifest, resourceId);
    if (candidate?.dispatchable && candidate.state === "available") return candidate;
  }
  return null;
}

function hasAvailableDispatchRoute(manifest, item) {
  const assigned = candidateFromManifest(manifest, item.assignment);
  return Boolean((assigned?.dispatchable && assigned.state === "available") || availableAlternateForItem(manifest, item));
}

function workItemBrief(items) {
  return items.map((item) => {
    const files = item.expectedFiles?.length ? `; file boundary: ${item.expectedFiles.join(", ")}` : "";
    const acceptance = item.acceptanceCriteria?.length ? `; accept when: ${item.acceptanceCriteria.join(" | ")}` : "";
    const verification = item.verification?.length ? `; verify: ${item.verification.join(" | ")}` : "";
    const commands = item.verificationCommands?.length ? `; bridge checks: ${item.verificationCommands.map((entry) => entry.name || entry.command).join(" | ")}` : "";
    return `- ${item.id} [${item.kind}, ${item.complexity}, readOnly=${item.readOnly}]: ${item.objective}${files}${acceptance}${verification}${commands}`;
  }).join("\n");
}

function dependencyEvidenceForItems(manifest, items) {
  const dependencyIds = [...new Set(items.flatMap((item) => item.dependsOn || []))];
  const workItems = new Map((manifest.workItems || []).map((item) => [item.id, item]));
  const lines = [];
  for (const dependencyId of dependencyIds) {
    const dependency = workItems.get(dependencyId);
    if (!dependency || dependency.state !== "completed") continue;
    if (dependency.codexEvidence?.summary) {
      const refs = (dependency.codexEvidence.artifactRefs || []).length
        ? `; refs=${dependency.codexEvidence.artifactRefs.join(", ")}`
        : "";
      lines.push(`- ${dependencyId} [Codex verified]: ${truncateText(dependency.codexEvidence.summary, 900)}${refs}`);
      continue;
    }
    if (dependency.hostEvidence?.summary) {
      const refs = (dependency.hostEvidence.artifactRefs || []).length
        ? `; refs=${dependency.hostEvidence.artifactRefs.join(", ")}`
        : "";
      lines.push(`- ${dependencyId} [native Codex worker; ${dependency.assignedModel || "model unknown"}]: ${truncateText(dependency.hostEvidence.summary, 900)}${refs}`);
      continue;
    }
    const completedJob = [...(manifest.jobs || [])].reverse().find((job) => job.state === "completed" && (job.workItemIds || job.assignedTasks || []).includes(dependencyId));
    if (completedJob?.jobId) {
      const result = summarizeFile(path.join(jobDirFor(manifest.workspace, completedJob.jobId), "result.md"), 1000)
        .trim()
        .replace(/\s*\n\s*/g, " ");
      if (result) lines.push(`- ${dependencyId} [${completedJob.resourceId || completedJob.worker}; ${completedJob.observedModel || completedJob.model || "model unknown"}]: ${truncateText(redactArtifactContent(result), 1000)}`);
    }
  }
  return truncateText(lines.join("\n"), 2800);
}

function pathIsInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function escapedRegexText(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function inferFileBoundaryFromEvidence(workspace, evidence, workItemId = "") {
  const extensions = "py|js|jsx|ts|tsx|json|md|html|css|scss|ps1|sh|yml|yaml|toml|sql|go|rs|java|cs|php|rb";
  const source = String(evidence || "");
  const marker = workItemId
    ? source.match(new RegExp(`(?:FILE_)?BOUNDARY\\s+${escapedRegexText(workItemId)}\\s*:\\s*([^\\r\\n]+)`, "i"))
    : null;
  if (workItemId && !marker) return [];
  const searchable = marker ? marker[1] : source;
  const matches = [];
  const regex = new RegExp("`([^`\\r\\n]+\\.(?:" + extensions + "))`", "gi");
  for (const match of searchable.matchAll(regex)) matches.push(match[1]);
  const result = [];
  for (const candidate of matches) {
    const cleaned = candidate.trim().replace(/^[./\\]+/, "").replace(/\\/g, path.sep).replace(/\//g, path.sep);
    if (!cleaned || cleaned.includes(".antigravity-bridge")) continue;
    const variants = [cleaned, path.join("Jobs Harness", cleaned)];
    const resolved = variants.find((variant) => {
      const absolute = path.resolve(workspace, variant);
      if (!pathIsInside(workspace, absolute)) return false;
      return fs.existsSync(absolute) || fs.existsSync(path.dirname(absolute));
    });
    if (resolved && !result.includes(resolved)) result.push(resolved);
    if (result.length >= 12) break;
  }
  return result;
}

function validateBoundaryEvidenceContract(args = {}, resultText = "") {
  const targets = [...new Set((Array.isArray(args.boundaryTargets) ? args.boundaryTargets : []).map(normalizeTaskLane).filter(Boolean))];
  if (!targets.length) return { ok: true, reason: "", missing: [] };
  const missing = targets.filter((target) => !inferFileBoundaryFromEvidence(args.workspace, resultText, target).length);
  return missing.length
    ? {
        ok: false,
        missing,
        reason: `Boundary discovery omitted a valid machine-readable BOUNDARY line for: ${missing.join(", ")}. Fail over or rescope; prose and incidental paths cannot authorize a writer.`,
      }
    : { ok: true, reason: "", missing: [] };
}

function downstreamWriterNeedsBoundary(manifest, completedItems) {
  const dependencyIds = new Set((completedItems || []).map((item) => item.id));
  return (manifest.workItems || []).some((item) => !item.readOnly
    && !(item.expectedFiles || []).length
    && (item.dependsOn || []).some((id) => dependencyIds.has(id)));
}

function boundaryScopeRecoveryId(item) {
  const base = normalizeTaskLane(item?.id || "writer").slice(0, 42) || "writer";
  const digest = crypto.createHash("sha256").update(String(item?.id || "writer")).digest("hex").slice(0, 8);
  return normalizeTaskLane(`scope-${base}-${digest}`);
}

function isBoundaryScopeBlocker(value) {
  return /writer dispatch refused because no verified file boundary/i.test(String(value || ""));
}

function scopeRecoveryResource(manifest, item) {
  const localProfile = process.env.AI_MOBILE_SELF_TEST === "1" ? neutralLocalRoutingProfile() : readProfile();
  const routingArgs = { ...capacityArgsFromManifest(manifest), localProfile };
  return rankResourcesForWorkItem(manifest.resources || [], item, routingArgs, manifest.primaryWriterId || "")
    .map((row) => row.candidate)
    .find((candidate) => candidate.id !== "codex:current"
      && candidate.dispatchMode !== "host-subagent"
      && candidate.dispatchable
      && candidate.state === "available") || null;
}

function addBoundaryScopeRecovery(manifest, writerItems) {
  let next = manifest;
  const additions = [];
  const handledWorkItemIds = [];
  for (const writer of writerItems.filter((item) => item && !item.readOnly && !(item.expectedFiles || []).length)) {
    const scopeId = boundaryScopeRecoveryId(writer);
    const existing = (next.workItems || []).find((item) => item.id === scopeId);
    if (existing && !["completed", "failed", "blocked"].includes(existing.state)) {
      handledWorkItemIds.push(writer.id);
      continue;
    }
    if (Number(writer.scopeRecoveryCount || 0) >= 1 || existing) continue;
    const scopeItemBase = normalizeWorkItem({
      id: scopeId,
      objective: `Identify the exact existing workspace-relative files that writer ${writer.id} may edit for: ${writer.objective}. Inspect only enough source structure and dependency evidence to produce a disjoint, minimal ownership boundary. Return exactly one line beginning BOUNDARY ${writer.id}: followed only by backtick-wrapped file paths.`,
      kind: "scope-discovery",
      complexity: "low",
      readOnly: true,
      dependsOn: writer.dependsOn || [],
      acceptanceCriteria: [`A machine-readable BOUNDARY ${writer.id}: line names only exact existing files`],
      verification: ["No directories, globs, shorthand, or project edits"],
      priority: Math.min(100, Number(writer.priority || 50) + 1),
    }, (next.workItems || []).length + additions.length, "low");
    const resource = scopeRecoveryResource(next, scopeItemBase);
    if (!resource) continue;
    const ranked = rankResourcesForWorkItem(next.resources || [], scopeItemBase, {
      ...capacityArgsFromManifest(next),
      localProfile: process.env.AI_MOBILE_SELF_TEST === "1" ? neutralLocalRoutingProfile() : readProfile(),
    }, next.primaryWriterId || "");
    const scopeItem = {
      ...scopeItemBase,
      scopeFor: writer.id,
      assignment: resource.id,
      assignedModel: resource.model,
      alternates: selectAlternateResourceIds(ranked, resource, 3),
      decisionReason: `Automatic read-only scope recovery for writer ${writer.id}; provider failover was not consumed.`,
    };
    additions.push(scopeItem);
    handledWorkItemIds.push(writer.id);
    next = {
      ...next,
      workItems: (next.workItems || []).map((item) => item.id === writer.id
        ? {
            ...item,
            state: "pending",
            dependsOn: [...new Set([...(item.dependsOn || []), scopeId])],
            scopeRecoveryCount: Number(item.scopeRecoveryCount || 0) + 1,
            failoverCount: Math.max(0, Number(item.failoverCount || 0) - (isBoundaryScopeBlocker(item.blocker) ? 1 : 0)),
            failureCategory: "",
            blocker: "",
            activeJobId: "",
          }
        : item),
    };
    next = appendOrchestrationDecision(next, {
      type: "writer-scope-recovery",
      workItemId: writer.id,
      scopeWorkItemId: scopeId,
      resourceId: resource.id,
      reason: "missing writer boundary triggered bounded read-only discovery instead of provider failover",
    });
  }
  if (additions.length) next = { ...next, workItems: [...(next.workItems || []), ...additions] };
  return { manifest: next, added: additions, handledWorkItemIds };
}

function resultBulletLimitForComplexity(complexityRank) {
  return ({ 1: 5, 2: 6, 3: 8, 4: 10 })[Math.max(1, Math.min(4, Number(complexityRank || 2)))] || 6;
}

function boundedResultBulletLimit(args = {}, fallback = 8) {
  const value = Number(args.maxResultBullets ?? fallback);
  return Math.max(3, Math.min(10, Number.isFinite(value) ? Math.round(value) : fallback));
}

function resultCharacterLimit(args = {}, fallbackBullets = 8) {
  return Math.max(1200, Math.min(4500, boundedResultBulletLimit(args, fallbackBullets) * 450));
}

function contextCharacterLimitForComplexity(complexityRank) {
  return ({ 1: 5000, 2: 8000, 3: 12000, 4: 16000 })[Math.max(1, Math.min(4, Number(complexityRank || 2)))] || 8000;
}

function bridgeVerificationCommands(items = [], readOnly = true) {
  const candidates = [
    ...(readOnly ? [] : [{
      name: "git-diff-check",
      command: "git",
      args: ["diff", "--check"],
      timeoutSeconds: 120,
      expectedExitCode: 0,
    }]),
    ...items.flatMap((item) => normalizeVerificationCommands(item.verificationCommands)),
  ];
  const seen = new Set();
  return candidates.filter((entry) => {
    const key = JSON.stringify([entry.command, entry.args, entry.expectedExitCode]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);
}

function launchOrchestrationGroup(manifest, resource, items, failoverOf = "") {
  const workspace = manifest.workspace;
  const readOnly = items.every((item) => item.readOnly);
  const mode = readOnly ? "review" : (manifest.mode || "patch");
  const complexityRank = Math.max(...items.map((item) => ({ low: 1, medium: 2, high: 3, critical: 4 }[item.complexity] || 2)));
  const maxResultBullets = resultBulletLimitForComplexity(complexityRank);
  const contextCharacterLimit = contextCharacterLimitForComplexity(complexityRank);
  const verificationCommands = bridgeVerificationCommands(items, readOnly);
  const dependencyEvidence = dependencyEvidenceForItems(manifest, items);
  const activeConstraints = boundedTextList(manifest.constraints, 20, 600);
  const projectAcceptance = boundedTextList(manifest.acceptanceCriteria, 12, 400);
  const projectVerification = boundedTextList(manifest.verification, 12, 400);
  const boundaryEvidenceNeeded = readOnly && downstreamWriterNeedsBoundary(manifest, items);
  const scopeTargets = items.map((item) => item.scopeFor).filter(Boolean);
  const dependencyIds = new Set(items.map((item) => item.id));
  const downstreamBoundaryTargets = boundaryEvidenceNeeded
    ? (manifest.workItems || [])
      .filter((item) => !item.readOnly
        && !(item.expectedFiles || []).length
        && (item.dependsOn || []).some((id) => dependencyIds.has(id)))
      .map((item) => item.id)
    : [];
  const boundaryTargets = [...new Set([...scopeTargets, ...downstreamBoundaryTargets])];
  const goal = [
    manifest.goal,
    "",
    `ResourceOrchestratorRun: ${manifest.runId}`,
    `AssignedResource: ${resource.team} / ${resource.displayName}`,
    "Assigned work items:",
    workItemBrief(items),
    activeConstraints.length ? "" : null,
    activeConstraints.length ? "Non-negotiable user and safety constraints:" : null,
    ...activeConstraints.map((constraint) => `- ${constraint}`),
    projectAcceptance.length ? "" : null,
    projectAcceptance.length ? "Project acceptance criteria:" : null,
    ...projectAcceptance.map((criterion) => `- ${criterion}`),
    projectVerification.length ? "" : null,
    projectVerification.length ? "Focused final verification:" : null,
    ...projectVerification.map((check) => `- ${check}`),
    dependencyEvidence ? "" : null,
    dependencyEvidence ? "Verified dependency evidence:" : null,
    dependencyEvidence || null,
    "",
    "Coordinate against the common goal, stay inside these work items, and produce the required compact artifacts. Do not duplicate another worker's file ownership.",
    "Runtime truth rule: git status, tracked deletions, ignored files, and source layout do not prove whether a live process or runtime state exists. Use verified dependency evidence or an explicitly allowed current health check; otherwise report runtime state as unknown.",
  ].filter((line) => line !== null).join("\n");
  const nextStep = [
    `Complete only work items: ${items.map((item) => item.id).join(", ")}.`,
    readOnly ? "Inspect and critique only; do not edit project files." : "Make one coherent narrow implementation and run targeted verification.",
    boundaryEvidenceNeeded ? "Your result must name each proposed writer file as an exact workspace-relative path wrapped in backticks; these paths become the enforced write boundary." : null,
    boundaryTargets.length ? `Return exactly one line per target using this format: ${boundaryTargets.map((target) => `BOUNDARY ${target}: \`path/to/existing-file.ext\`, \`path/to/another-file.ext\``).join(" | ")}.` : null,
    boundaryTargets.length ? "Do not return directories, globs, '+' shorthand, or prose in place of exact file paths." : null,
    `State assumptions and blockers explicitly. Stop immediately if the task conflicts with an active constraint. Read only focused context up to ${contextCharacterLimit} characters. Keep result.md to ${maxResultBullets} bullets or fewer. Accept work only against the stated criteria, verified dependency evidence, and verification checks.`,
  ].filter(Boolean).join(" ");
  let expectedFiles = [...new Set(items.flatMap((item) => item.expectedFiles || []))];
  if (!readOnly && !expectedFiles.length) {
    expectedFiles = [...new Set(items.flatMap((item) => inferFileBoundaryFromEvidence(workspace, dependencyEvidence, item.id)))];
  }
  if (!readOnly && !expectedFiles.length) {
    return {
      launched: false,
      codexTakeover: manifest.managerOnly !== true,
      blocker: manifest.managerOnly === true
        ? "External writer dispatch refused because no verified file boundary was available. Manager-only mode will not inspect or implement the item; rescope it through one bounded discovery worker."
        : "External writer dispatch refused because no verified file boundary was available. Current Codex must scope or implement this narrow item.",
    };
  }
  const maxWorkerMinutes = workerMinutesFor(manifest, complexityRank, resource.platform, readOnly);
  let action = "";
  let toolName = "";

  if (resource.dispatchMode === "codex-cli") {
    toolName = "submit-codex-job";
    action = submitCodexJob({
      goal,
      workspace,
      mode,
      nextStep,
      model: items[0]?.assignedModel || resource.model,
      effort: selectReasoningEffort(resource, {
        complexity: items.some((item) => item.complexity === "critical") ? "critical" : items.some((item) => item.complexity === "high") ? "high" : items.some((item) => item.complexity === "medium") ? "medium" : "low",
        kind: items.map((item) => item.kind).join(" "),
        objective: items.map((item) => item.objective).join(" "),
        requiredCapabilities: [...new Set(items.flatMap((item) => item.requiredCapabilities || []))],
      }),
      maxMinutes: maxWorkerMinutes,
      resourceId: resource.id,
      workItemKinds: items.map((item) => item.kind),
      expectedFiles,
      readOnly,
      boundaryTargets,
      verificationCommands,
      maxResultBullets,
      start: true,
    });
  } else if (resource.platform === "claude") {
    toolName = "submit-claude-job";
    action = submitClaudeJob({
      goal,
      workspace,
      mode,
      nextStep,
      model: items[0]?.assignedModel || resource.model || "sonnet",
      permissionMode: readOnly ? "plan" : "acceptEdits",
      effort: selectProviderReasoningEffort(resource, {
        complexity: items.some((item) => item.complexity === "critical") ? "critical" : items.some((item) => item.complexity === "high") ? "high" : items.some((item) => item.complexity === "medium") ? "medium" : "low",
        kind: items.map((item) => item.kind).join(" "),
        objective: items.map((item) => item.objective).join(" "),
      }),
      maxMinutes: maxWorkerMinutes,
      maxBudgetUsd: claudeBudgetFor(manifest, complexityRank),
      maxOutputTokens: Number(manifest.maxClaudeOutputTokens || 12000),
      resourceId: resource.id,
      workItemKinds: items.map((item) => item.kind),
      expectedFiles,
      readOnly,
      boundaryTargets,
      verificationCommands,
      maxResultBullets,
      start: true,
    });
  } else if (resource.platform === "antigravity") {
    toolName = "submit-agy-job";
    action = submitAgyJob({
      goal,
      workspace,
      mode,
      nextStep,
      model: items[0]?.assignedModel || resource.model,
      maxMinutes: maxWorkerMinutes,
      printTimeout: `${maxWorkerMinutes}m`,
      sandbox: true,
      autoApprovePermissions: manifest.unattendedMode === true && manifest.allowAntigravityPermissionBypass === true,
      resourceId: resource.id,
      workItemKinds: items.map((item) => item.kind),
      expectedFiles,
      readOnly,
      boundaryTargets,
      verificationCommands,
      maxResultBullets,
      start: true,
    });
  } else if (resource.platform === "cursor") {
    toolName = "submit-cursor-job";
    action = submitCursorJob({
      goal,
      workspace,
      mode,
      nextStep,
      model: items[0]?.assignedModel || resource.model,
      maxMinutes: maxWorkerMinutes,
      resourceId: resource.id,
      workItemKinds: items.map((item) => item.kind),
      expectedFiles,
      readOnly,
      boundaryTargets,
      verificationCommands,
      maxResultBullets,
      start: true,
    });
  } else {
    return { launched: false, blocker: `Resource ${resource.id} is not dispatchable by AI Mobile.` };
  }

  const summary = actionSummary(action, toolName, workspace, {
    id: `orchestrator-${resource.id.replace(/[^a-z0-9]+/gi, "-")}`,
    worker: resource.team,
    assignedTasks: items.map((item) => item.id),
    model: items[0]?.assignedModel || resource.model,
  });
  return {
    launched: Boolean(summary.jobId),
    blocker: summary.jobId ? "" : truncateText(action, 1000),
    job: {
      toolName,
      laneId: summary.laneId,
      worker: resource.team,
      resourceId: resource.id,
      transport: resource.dispatchMode || "external-cli",
      assignedTasks: items.map((item) => item.id),
      workItemIds: items.map((item) => item.id),
      model: summary.model,
      jobId: summary.jobId,
      state: summary.failed ? "failed" : summary.started ? "running" : "queued",
      failoverOf,
      failoverDepth: failoverOf ? 1 : 0,
      readOnly,
      leaseMinutes: maxWorkerMinutes,
    },
  };
}

function failureCategoryFromText(value) {
  const text = String(value || "").toLowerCase();
  if (/budget[- ]exceeded|output budget|token budget|error_max_budget|max[_ ]budget[_ ]usd/.test(text)) return "budget-exceeded";
  if (/verification-failed|deterministic verification failed|bridge verification failed/.test(text)) return "verification-failed";
  if (/review-worker-modified|review-only.*changed/.test(text)) return "policy-violation";
  if (/insufficient[- ]result|off[- ]task|result quality gate/.test(text)) return "insufficient-result";
  if (/rate.?limit|too many requests|429/.test(text)) return "rate-limit";
  if (/quota|usage limit|limit exceeded|exhausted|capacity/.test(text)) return "quota";
  if (/timed?\s*out|etimedout|deadline/.test(text)) return "timeout";
  if (/transport closed|connection reset|unavailable|service outage|econn/.test(text)) return "outage";
  if (/model.*(not found|unavailable|unsupported)|invalid model/.test(text)) return "model-unavailable";
  if (/auth|login|credential|unauthori[sz]ed|forbidden|401|403/.test(text)) return "auth";
  if (/cancelled|canceled/.test(text)) return "cancelled";
  return "worker-failure";
}

function failoverAllowed(category) {
  return ["rate-limit", "quota", "timeout", "outage", "model-unavailable", "auth", "worker-failure", "insufficient-result"].includes(category);
}

function deriveOrchestrationState(manifest) {
  const items = manifest.workItems || [];
  if (!items.length) return "blocked";
  if (manifest.termination?.category) return "blocked";
  if (isContinuousManagement(manifest) && ["verified", "failed"].includes(manifest.activeCycle?.state)) return "ready-for-codex";
  if (!isContinuousManagement(manifest) && manifest.finalVerification?.passed === true && items.every((item) => item.state === "completed")) return "completed";
  if (!isContinuousManagement(manifest) && manifest.finalVerification?.passed === false) return "blocked";
  if (items.some((item) => ["running", "pending", "codex-pending", "host-pending", "host-running"].includes(item.state))) return "running";
  if (items.some((item) => ["host-dispatch-required", "host-reserved", "host-cancel-required"].includes(item.state))) return "ready-for-codex";
  if (items.every((item) => ["completed", "codex"].includes(item.state))) return "ready-for-codex";
  if (items.some((item) => item.state === "blocked")) return "blocked";
  if (items.some((item) => item.state === "completed")) return "partial";
  return "failed";
}

function syncWorkItemsFromJobs(manifest) {
  if (Number(manifest.version || 1) < 2 || !Array.isArray(manifest.workItems)) return manifest;
  if (manifest.termination?.category) return manifest;
  const jobs = manifest.jobs || [];
  const workItems = manifest.workItems.map((item) => {
    // Historical worker attempts must not overwrite an explicit current-Codex
    // takeover or its evidence-backed completion.
    if (item.assignment === "codex:current" || item.codexEvidence?.summary) return item;
    const matching = jobs.filter((job) => (job.workItemIds || job.assignedTasks || []).includes(item.id));
    const latest = matching[matching.length - 1];
    if (!latest) return item;
    if (latest.transport === "host-subagent") {
      if (latest.state === "queued") {
        const state = ["host-dispatch-required", "host-reserved", "host-cancel-required"].includes(item.state)
          ? item.state
          : "host-dispatch-required";
        return { ...item, state, activeJobId: latest.jobId, failureCategory: state === "host-cancel-required" ? item.failureCategory : "", blocker: latest.blocker || item.blocker || "" };
      }
      if (latest.state === "running") return { ...item, state: item.state === "host-cancel-required" ? "host-cancel-required" : "host-running", activeJobId: latest.jobId, failureCategory: "", blocker: latest.blocker || item.blocker || "" };
      if (latest.state === "unknown") return { ...item, state: "host-cancel-required", activeJobId: latest.jobId, failureCategory: latest.failureCategory || "cancellation-pending", blocker: latest.blocker || item.blocker || "" };
    }
    if (["queued", "running", "unknown"].includes(latest.state)) return { ...item, state: "running", activeJobId: latest.jobId, failureCategory: "", blocker: latest.blocker || "" };
    if (latest.state === "completed") return { ...item, state: "completed", activeJobId: latest.jobId, failureCategory: "", blocker: "" };
    if (["failed", "cancelled"].includes(latest.state)) {
      return {
        ...item,
        state: "failed",
        activeJobId: latest.jobId,
        failureCategory: latest.failureCategory || failureCategoryFromText(`${latest.currentStep || ""} ${latest.blocker || ""}`),
      };
    }
    return item;
  });
  return { ...manifest, workItems, state: deriveOrchestrationState({ ...manifest, workItems }) };
}

function appendOrchestrationDecision(manifest, entry) {
  return {
    ...manifest,
    decisions: [...(manifest.decisions || []), { at: utcStamp(), ...entry }].slice(-100),
  };
}

function terminateOrchestrationRun(workspace, suppliedManifest, reason, category) {
  const terminationReason = truncateText(redactArtifactContent(String(reason || "Orchestration stopped.").trim()), 1000);
  const terminationCategory = normalizeTaskLane(category || "stopped") || "stopped";
  const supervisorPid = Number(suppliedManifest.supervisorPid || 0);
  const supervisorTermination = supervisorPid === process.pid
    ? { stopped: true, note: "Supervisor is stopping its own run." }
    : supervisorPid > 0
      ? terminateProcessTree(supervisorPid, suppliedManifest.supervisorMarker || suppliedManifest.runId)
      : { stopped: true, note: "No supervisor process was recorded." };
  const supervisorStopUnconfirmed = supervisorTermination.stopped ? 0 : 1;
  let targetedWorkers = 0;
  let cancelledWorkers = 0;
  let cancellationUnconfirmed = 0;
  const jobs = (suppliedManifest.jobs || []).map((job) => {
    if (!["queued", "running", "unknown"].includes(job.state) || !job.jobId) return job;
    targetedWorkers += 1;
    if (job.transport === "host-subagent") {
      cancellationUnconfirmed += 1;
      return {
        ...job,
        state: "unknown",
        failureCategory: "cancellation-pending",
        blocker: terminationReason,
        currentStep: "host-cancel-required",
      };
    }
    try {
      const cancellation = cancelJob({ workspace, jobId: job.jobId, reason: terminationReason });
      if (/ProcessTreeStopped:\s*true/i.test(cancellation)) cancelledWorkers += 1;
      else cancellationUnconfirmed += 1;
      updateJobStatus(workspace, job.jobId, {
        state: "cancelled",
        currentStep: terminationCategory,
        failureCategory: terminationCategory,
        blocker: terminationReason,
        completedAt: utcStamp(),
        bridgeFinalized: true,
      });
    } catch {
      // The manifest still fails closed even if an already-exited worker cannot be terminated.
      cancellationUnconfirmed += 1;
    }
    return {
      ...job,
      state: "cancelled",
      failureCategory: terminationCategory,
      blocker: terminationReason,
      currentStep: terminationCategory,
    };
  });
  let manifest = {
    ...suppliedManifest,
    supervisorPid: supervisorTermination.stopped ? 0 : supervisorPid,
    supervisorEndedAt: supervisorTermination.stopped ? utcStamp() : suppliedManifest.supervisorEndedAt,
    jobs,
    workItems: (suppliedManifest.workItems || []).map((item) => {
      if (item.state === "completed") return item;
      const activeHost = jobs.find((job) => job.transport === "host-subagent"
        && ["queued", "running", "unknown"].includes(job.state)
        && (job.workItemIds || []).includes(item.id));
      return activeHost
        ? { ...item, state: "host-cancel-required", blocker: terminationReason, failureCategory: "cancellation-pending", activeJobId: activeHost.jobId }
        : { ...item, state: "blocked", blocker: terminationReason, failureCategory: terminationCategory, activeJobId: "" };
    }),
    termination: {
      category: terminationCategory,
      reason: terminationReason,
      at: utcStamp(),
      targetedWorkers,
      cancelledWorkers,
      cancellationUnconfirmed,
      supervisorStopped: supervisorTermination.stopped,
      supervisorStopUnconfirmed,
      supervisorNote: supervisorTermination.note,
    },
  };
  manifest = appendOrchestrationDecision(manifest, {
    type: "run-termination",
    category: terminationCategory,
    reason: terminationReason,
    targetedWorkers,
    cancelledWorkers,
    cancellationUnconfirmed,
    supervisorStopped: supervisorTermination.stopped,
    supervisorStopUnconfirmed,
  });
  manifest.state = "blocked";
  manifest.counts = {
    total: jobs.length,
    completed: jobs.filter((job) => job.state === "completed").length,
    running: 0,
    failed: jobs.filter((job) => ["failed", "cancelled"].includes(job.state)).length,
  };
  return manifest;
}

function runDeadlineExpired(manifest, now = Date.now()) {
  const deadline = Date.parse(String(manifest.deadlineAt || ""));
  return Number.isFinite(deadline) && now >= deadline;
}

function isActiveOrchestrationRun(manifest) {
  if (!manifest || Number(manifest.version || 1) < 2) return manifest?.state === "running";
  if (isContinuousManagement(manifest) && !manifest.termination?.category) return true;
  return ["running", "ready-for-codex"].includes(String(manifest.state || ""));
}

function routingPolicyFromArgs(args = {}) {
  const requestedAgyModel = String(args.agyModel || "auto").trim().toLowerCase() || "auto";
  return {
    allowAntigravityCli: args.allowAntigravityCli === true || requestedAgyModel !== "auto",
    unattendedMode: args.unattendedMode === true,
    allowAntigravityPermissionBypass: args.allowAntigravityPermissionBypass === true,
    allowPremiumModels: args.allowPremiumModels === true,
    agyModel: requestedAgyModel,
    claudeModel: String(args.claudeModel || "auto").trim().toLowerCase() || "auto",
    includeCursor: args.includeCursor === true,
    hostCodexAvailable: args.hostCodexAvailable === true,
  };
}

function workGraphContract(items = []) {
  return (items || []).map((item) => ({
    id: item.id,
    objective: item.objective,
    kind: item.kind,
    complexity: item.complexity,
    requiredCapabilities: [...(item.requiredCapabilities || [])].sort(),
    dependsOn: [...(item.dependsOn || [])].sort(),
    expectedFiles: [...(item.expectedFiles || [])].sort(),
    readOnly: item.readOnly === true,
    executionClass: item.executionClass,
    externallyConsequential: item.externallyConsequential === true,
    acceptanceCriteria: item.acceptanceCriteria || [],
    verification: item.verification || [],
    verificationCommands: normalizeVerificationCommands(item.verificationCommands),
    priority: Number(item.priority || 0),
  }));
}

function runContractChanges(manifest, args = {}) {
  const controls = normalizedRunControls(args);
  const requested = {
    mode: String(args.mode || "patch").trim().toLowerCase(),
    completionPolicy: completionPolicyFrom(args),
    managerOnly: args.managerOnly === true,
    horizonHours: Math.max(1, Math.min(12, Number(args.horizonHours || 5))),
    controls,
    constraints: normalizedRunConstraints(args),
    acceptanceCriteria: boundedTextList(args.acceptanceCriteria, 12, 400),
    verification: boundedTextList(args.verification, 12, 400),
    routingPolicy: routingPolicyFromArgs(args),
    workGraph: workGraphContract(buildGoalWorkGraph(args)),
  };
  const existing = {
    mode: String(manifest.mode || "patch").trim().toLowerCase(),
    completionPolicy: completionPolicyFrom(manifest),
    managerOnly: manifest.managerOnly === true,
    horizonHours: Math.max(1, Math.min(12, Number(manifest.horizonHours || 5))),
    controls: {
      runDeadlineMinutes: Number(manifest.runDeadlineMinutes ?? 0),
      capacityCheckpointMinutes: Number(manifest.capacityCheckpointMinutes ?? 20),
      codexManagerReservePercent: Number(manifest.codexManagerReservePercent ?? 15),
      maxConcurrentCodexWorkers: Number(manifest.maxConcurrentCodexWorkers ?? 1),
      maxParallelWriters: Number(manifest.maxParallelWriters ?? 2),
      maxWorkerMinutes: Number(manifest.maxWorkerMinutes ?? 0),
      maxClaudeOutputTokens: Number(manifest.maxClaudeOutputTokens || 12000),
      maxClaudeBudgetUsd: Number(manifest.maxClaudeBudgetUsd ?? 0) > 0 ? Number(manifest.maxClaudeBudgetUsd) : 0,
    },
    constraints: manifest.constraints || [],
    acceptanceCriteria: manifest.acceptanceCriteria || [],
    verification: manifest.verification || [],
    routingPolicy: manifest.routingPolicy || {
      allowAntigravityCli: manifest.allowAntigravityCli === true,
      unattendedMode: manifest.unattendedMode === true,
      allowAntigravityPermissionBypass: manifest.allowAntigravityPermissionBypass === true,
      allowPremiumModels: false,
      agyModel: "auto",
      claudeModel: "auto",
      includeCursor: false,
      hostCodexAvailable: false,
    },
    workGraph: workGraphContract(manifest.workItems || []),
  };
  return Object.keys(requested).filter((key) => JSON.stringify(requested[key]) !== JSON.stringify(existing[key]));
}

function carryForwardSameGoalContract(effectiveArgs, rawArgs, manifest) {
  const next = { ...effectiveArgs };
  if (rawArgs.completionPolicy === undefined) next.completionPolicy = completionPolicyFrom(manifest);
  for (const key of ["runDeadlineMinutes", "capacityCheckpointMinutes", "codexManagerReservePercent", "maxConcurrentCodexWorkers", "maxParallelWriters", "maxWorkerMinutes", "maxClaudeOutputTokens", "maxClaudeBudgetUsd"]) {
    if (rawArgs[key] === undefined && manifest[key] !== undefined) next[key] = manifest[key];
  }
  const routing = manifest.routingPolicy || {};
  for (const key of ["allowAntigravityCli", "allowPremiumModels", "agyModel", "claudeModel", "includeCursor", "hostCodexAvailable", "unattendedMode", "allowAntigravityPermissionBypass"]) {
    if (rawArgs[key] === undefined && routing[key] !== undefined) next[key] = routing[key];
  }
  next.constraints = boundedTextList([...(manifest.constraints || []), ...(Array.isArray(rawArgs.constraints) ? rawArgs.constraints : [])], 20, 600);
  next.acceptanceCriteria = boundedTextList([...(manifest.acceptanceCriteria || []), ...(Array.isArray(rawArgs.acceptanceCriteria) ? rawArgs.acceptanceCriteria : [])], 12, 400);
  next.verification = boundedTextList([...(manifest.verification || []), ...(Array.isArray(rawArgs.verification) ? rawArgs.verification : [])], 12, 400);
  if ((!Array.isArray(rawArgs.workItems) || !rawArgs.workItems.length) && !String(rawArgs.taskSplit || "").trim()) next.workItems = manifest.workItems || [];
  return next;
}

function capacityCheckpointDue(manifest, now = Date.now()) {
  if (!isActiveOrchestrationRun(manifest)) return false;
  const interval = Number(manifest.capacityCheckpointMinutes ?? 20);
  if (!Number.isFinite(interval) || interval <= 0) return false;
  const scheduled = Date.parse(String(manifest.nextCapacityCheckpointAt || ""));
  if (Number.isFinite(scheduled)) return now >= scheduled;
  const baseline = Date.parse(String(manifest.lastCapacityCheckpointAt || manifest.createdAt || ""));
  return Number.isFinite(baseline) && now >= baseline + (interval * 60000);
}

function capacityCheckpointDelayMinutes(manifest, candidates = manifest?.resources || []) {
  const configured = Math.max(5, Math.min(240, Number(manifest?.capacityCheckpointMinutes || 20)));
  const reserve = Math.max(5, Math.min(50, Number(manifest?.codexManagerReservePercent || 15)));
  const nativeCodex = (candidates || []).filter((candidate) => candidate.platform === "codex" && candidate.id !== "codex:current");
  const remaining = nativeCodex.map((candidate) => Number(candidate.remainingPercent)).filter(Number.isFinite);
  if (nativeCodex.some((candidate) => ["manager-reserve", "exhausted", "capacity-stale"].includes(candidate.state))) return 5;
  if (!remaining.length) return configured;
  const lowest = Math.min(...remaining);
  if (lowest <= reserve + 10) return 5;
  if (lowest <= reserve + 25) return Math.min(configured, 10);
  return configured;
}

function capacityArgsFromManifest(manifest) {
  const routing = manifest.routingPolicy || {};
  return {
    goal: manifest.goal,
    workspace: manifest.workspace,
    mode: manifest.mode,
    managerOnly: manifest.managerOnly === true,
    horizonHours: manifest.horizonHours,
    allowAntigravityCli: routing.allowAntigravityCli === true || manifest.allowAntigravityCli === true,
    unattendedMode: routing.unattendedMode === true || manifest.unattendedMode === true,
    allowAntigravityPermissionBypass: routing.allowAntigravityPermissionBypass === true || manifest.allowAntigravityPermissionBypass === true,
    allowPremiumModels: routing.allowPremiumModels === true,
    agyModel: routing.agyModel || "auto",
    claudeModel: routing.claudeModel || "auto",
    includeCursor: routing.includeCursor === true,
    hostCodexAvailable: routing.hostCodexAvailable === true || manifest.hostCodexAvailable === true,
    codexManagerReservePercent: manifest.codexManagerReservePercent,
    maxConcurrentCodexWorkers: manifest.maxConcurrentCodexWorkers,
    maxParallelWriters: manifest.maxParallelWriters,
    refreshInventory: true,
  };
}

function applyCapacityCheckpointCandidates(manifest, candidates, args = {}) {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const reroutes = [];
  const workItems = (manifest.workItems || []).map((item) => {
    const resourceBlocked = item.state === "blocked" && String(item.blocker || "").startsWith("Assigned resource ");
    if (item.state !== "pending" && !resourceBlocked) return item;
    const ranked = rankResourcesForWorkItem(candidates, item, args, manifest.primaryWriterId || "");
    const current = byId.get(item.assignment);
    const currentRow = ranked.find((row) => row.candidate.id === current?.id);
    const best = ranked[0];
    const materiallyBetter = best && currentRow && best.candidate.id !== current?.id && best.score >= currentRow.score + 20;
    const selected = current?.dispatchable && current.state === "available" && !materiallyBetter
      ? current
      : best?.candidate;
    if (!selected) return { ...item, alternates: [] };
    const alternates = selectAlternateResourceIds(ranked, selected, 3);
    if (selected.id !== item.assignment) reroutes.push({ workItemId: item.id, from: item.assignment, to: selected.id });
    const reassigned = {
      ...item,
      state: resourceBlocked ? "pending" : item.state,
      assignment: selected.id,
      assignedModel: selected.model,
      alternates,
      blocker: resourceBlocked ? "" : item.blocker,
      failureCategory: resourceBlocked ? "" : item.failureCategory,
      decisionReason: selected.id === item.assignment
        ? item.decisionReason
        : "Rolling capacity checkpoint selected a healthy resource for remaining work.",
    };
    if (selected.dispatchMode === "host-subagent") {
      return item.assignment === selected.id && item.hostAttempt
        ? reassigned
        : prepareHostAssignedItem(manifest, reassigned, selected);
    }
    return { ...reassigned, hostAction: null, hostAttempt: null };
  });
  let next = { ...manifest, resources: candidates, workItems };
  const writerReroute = reroutes.find((reroute) => workItems.find((item) => item.id === reroute.workItemId && !item.readOnly));
  if (writerReroute) next.primaryWriterId = writerReroute.to;
  for (const reroute of reroutes) {
    next = appendOrchestrationDecision(next, {
      type: "capacity-checkpoint-reroute",
      ...reroute,
      reason: "prior resource was unavailable; running workers were left untouched",
    });
  }
  return { manifest: next, reroutes };
}

async function refreshCapacityCheckpoint(workspace) {
  const manifestPath = lastTeamRunJsonPath(workspace);
  const stored = readJsonFile(manifestPath, null);
  if (!stored) return null;
  const observed = refreshTeamRunManifest(workspace, stored);
  if (!capacityCheckpointDue(observed)) return observed;
  const args = capacityArgsFromManifest(observed);
  let context;
  try {
    context = await getTeamCapacityContext(args);
  } catch (error) {
    return withFileLock(manifestPath, () => {
      let latest = refreshTeamRunManifest(workspace, readJsonFile(manifestPath, observed), true);
      if (latest.runId !== observed.runId) return latest;
      if (!capacityCheckpointDue(latest)) return latest;
      latest = appendOrchestrationDecision(latest, {
        type: "capacity-checkpoint-failed",
        reason: truncateText(redactArtifactContent(error?.message || String(error)), 500),
      });
      latest.lastCapacityCheckpointAt = utcStamp();
      latest.nextCapacityCheckpointAt = new Date(Date.now() + capacityCheckpointDelayMinutes(latest) * 60000).toISOString();
      writeTeamRunManifest(workspace, latest);
      return latest;
    });
  }
  const candidates = [...buildResourceCandidates(args, context), ...buildNativeCodexCandidates(args, context)];
  return withFileLock(manifestPath, () => {
    let latest = refreshTeamRunManifest(workspace, readJsonFile(manifestPath, observed), true);
    if (latest.runId !== observed.runId) return latest;
    if (!capacityCheckpointDue(latest)) return latest;
    const refreshed = applyCapacityCheckpointCandidates(latest, candidates, args);
    latest = refreshed.manifest;
    latest.capacityProbe = context.capacityProbe;
    latest.lastCapacityCheckpointAt = utcStamp();
    latest.nextCapacityCheckpointAt = new Date(Date.now() + capacityCheckpointDelayMinutes(latest, candidates) * 60000).toISOString();
    latest.capacityCheckpointCount = Number(latest.capacityCheckpointCount || 0) + 1;
    latest = appendOrchestrationDecision(latest, {
      type: "capacity-checkpoint",
      resourceCount: candidates.length,
      reroutedItems: refreshed.reroutes.map((item) => item.workItemId),
      reason: "rolling capacity refreshed without interrupting active workers",
    });
    writeTeamRunManifest(workspace, latest);
    return latest;
  });
}

function shouldRunOrchestrationSupervisor(manifest) {
  if (Number(manifest?.version || 1) < 2 || manifest?.state !== "running" || manifest?.termination?.category) return false;
  const externalJobActive = (manifest.jobs || []).some((job) => job.transport !== "host-subagent" && ["queued", "running", "unknown"].includes(job.state));
  const externalDispatchPending = (manifest.workItems || []).some((item) => item.state === "pending" && !String(item.assignment || "").startsWith("codex-host:"));
  return externalJobActive || externalDispatchPending;
}

function orchestrationSupervisorHealthy(manifest) {
  const pid = Number(manifest?.supervisorPid || 0);
  if (!Number.isInteger(pid) || pid <= 0 || !isProcessAlive(pid)) return false;
  const commandLine = processCommandLine(pid).toLowerCase();
  return Boolean(commandLine) && commandLine.includes(String(manifest.runId || "").toLowerCase());
}

function ensureOrchestrationSupervisor(workspace, suppliedManifest = null) {
  const manifestPath = lastTeamRunJsonPath(workspace);
  return withFileLock(manifestPath, () => {
    let latest = refreshTeamRunManifest(workspace, readJsonFile(manifestPath, suppliedManifest) || suppliedManifest, true);
    if (!shouldRunOrchestrationSupervisor(latest) || orchestrationSupervisorHealthy(latest)) return latest;
    const supervisorDir = path.join(bridgeRootFor(workspace), "orchestrator");
    const payloadPath = path.join(supervisorDir, `supervisor-${latest.runId}.json`);
    writeJsonFile(payloadPath, { workspace, runId: latest.runId, pollSeconds: 3 });
    const child = spawn(process.execPath, [__filename, "orchestration-supervisor-cli", "--json-file", payloadPath], {
      cwd: pluginRoot,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    latest = {
      ...latest,
      supervisorPid: child.pid,
      supervisorMarker: latest.runId,
      supervisorStartedAt: utcStamp(),
      supervisorEndedAt: "",
    };
    latest = appendOrchestrationDecision(latest, {
      type: "supervisor-start",
      pid: child.pid,
      reason: "low-RAM CLI supervisor advances external stages without model-token use",
    });
    writeTeamRunManifest(workspace, latest);
    return latest;
  });
}

async function runOrchestrationSupervisor(args = {}) {
  const workspace = safeWorkspacePath(args.workspace);
  const runId = String(args.runId || "").trim();
  if (!runId) throw new Error("orchestration-supervisor requires runId.");
  const pollMs = Math.max(1000, Math.min(30000, Number(args.pollSeconds || 3) * 1000));
  let finalState = "unknown";
  while (true) {
    let manifest = readJsonFile(lastTeamRunJsonPath(workspace), null);
    if (!manifest || manifest.runId !== runId) {
      finalState = "replaced";
      break;
    }
    if (!shouldRunOrchestrationSupervisor(manifest)) {
      finalState = manifest.state || "stopped";
      break;
    }
    await refreshCapacityCheckpoint(workspace);
    manifest = advanceOrchestrationRun(workspace, refreshTeamRunManifest(workspace));
    finalState = manifest.state || "unknown";
    if (!shouldRunOrchestrationSupervisor(manifest)) break;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  withFileLock(lastTeamRunJsonPath(workspace), () => {
    let latest = readJsonFile(lastTeamRunJsonPath(workspace), null);
    if (!latest || latest.runId !== runId || Number(latest.supervisorPid || 0) !== process.pid) return;
    latest.supervisorPid = 0;
    latest.supervisorEndedAt = utcStamp();
    latest.supervisorLastState = finalState;
    writeTeamRunManifest(workspace, latest);
  });
  return `OrchestrationSupervisorResult:\nRunId: ${runId}\nState: ${finalState}`;
}

function advanceOrchestrationRun(workspace, suppliedManifest, lockHeld = false, launchGroup = launchOrchestrationGroup) {
  if (!lockHeld) {
    return withFileLock(lastTeamRunJsonPath(workspace), () => {
      const latest = readJsonFile(lastTeamRunJsonPath(workspace), suppliedManifest) || suppliedManifest;
      const refreshed = refreshTeamRunManifest(workspace, latest, true);
      return advanceOrchestrationRun(workspace, refreshed, true, launchGroup);
    });
  }
  let manifest = syncWorkItemsFromJobs(suppliedManifest);
  if (Number(manifest.version || 1) < 2) return manifest;
  if (manifest.termination?.category) return manifest;
  if (runDeadlineExpired(manifest)) {
    const stopped = terminateOrchestrationRun(
      workspace,
      manifest,
      `Run deadline ${manifest.deadlineAt} was reached; unfinished work was stopped instead of continuing silently.`,
      "orchestration-deadline",
    );
    writeTeamRunManifest(workspace, stopped);
    return stopped;
  }

  let changed = false;
  manifest.resources = (manifest.resources || []).map((resource) => {
    const cooldownUntil = Date.parse(String(resource.cooldownUntil || ""));
    if (resource.state === "cooldown" && Number.isFinite(cooldownUntil) && cooldownUntil <= Date.now()) {
      changed = true;
      return { ...resource, state: "available", cooldownUntil: "", evidence: "cooldown-expired" };
    }
    return resource;
  });
  const existingBoundaryFailures = (manifest.workItems || [])
    .filter((item) => item.state === "failed" && isBoundaryScopeBlocker(item.blocker));
  if (existingBoundaryFailures.length && manifest.managerOnly === true) {
    const recovery = addBoundaryScopeRecovery(manifest, existingBoundaryFailures);
    if (recovery.handledWorkItemIds.length) {
      manifest = recovery.manifest;
      changed = true;
    }
  }
  const newlyFailedJobs = (manifest.jobs || [])
    .filter((job) => ["failed", "cancelled"].includes(job.state) && failoverAllowed(job.failureCategory) && !job.cooldownApplied && job.resourceId);
  if (newlyFailedJobs.length) {
    const failuresByResource = new Map(newlyFailedJobs.map((job) => [job.resourceId, job.failureCategory || "worker-failure"]));
    manifest.resources = (manifest.resources || []).map((resource) => {
      const category = failuresByResource.get(resource.id);
      if (!category) return resource;
      const minutes = cooldownMinutesForFailure(category) || 10;
      return {
        ...resource,
        state: "cooldown",
        evidence: "observed-failure",
        cooldownUntil: new Date(Date.now() + minutes * 60000).toISOString(),
      };
    });
    manifest.jobs = (manifest.jobs || []).map((job) => newlyFailedJobs.some((failed) => failed.jobId === job.jobId)
      ? { ...job, cooldownApplied: true }
      : job);
    changed = true;
  }
  const recoveredItems = manifest.workItems.map((item) => {
    if (item.state !== "failed" || Number(item.failoverCount || 0) >= 1 || !failoverAllowed(item.failureCategory)) return item;
    const latestJob = [...(manifest.jobs || [])].reverse().find((job) => (job.workItemIds || []).includes(item.id));
    const failedResource = candidateFromManifest(manifest, latestJob?.resourceId || item.assignment);
    const alternate = (item.alternates || [])
      .map((id) => candidateFromManifest(manifest, id))
      .filter((candidate) => candidate && candidate.state === "available" && candidate.id !== latestJob?.resourceId)
      .sort((a, b) => {
        if (!["outage", "auth", "timeout", "rate-limit", "quota", "worker-failure", "insufficient-result"].includes(item.failureCategory) || !failedResource) return 0;
        return Number(b.platform !== failedResource.platform) - Number(a.platform !== failedResource.platform);
      })[0];
    if (!alternate) return item;
    changed = true;
    manifest = appendOrchestrationDecision(manifest, {
      type: "failover",
      workItemId: item.id,
      from: latestJob?.resourceId || item.assignment,
      to: alternate.id,
      reason: `${item.failureCategory}; one bounded failover`,
    });
    const reassigned = {
      ...item,
      assignment: alternate.id,
      assignedModel: alternate.model,
      failoverCount: 1,
      activeJobId: "",
      failureCategory: "",
      blocker: "",
      decisionReason: `Failover from ${latestJob?.resourceId || item.assignment} after ${item.failureCategory}.`,
    };
    return alternate.dispatchMode === "host-subagent"
      ? prepareHostAssignedItem(manifest, reassigned, alternate)
      : { ...reassigned, state: "pending", hostAction: null, hostAttempt: null };
  });
  manifest = { ...manifest, workItems: recoveredItems };

  let currentById = new Map(manifest.workItems.map((item) => [item.id, item]));
  manifest.workItems = manifest.workItems.map((item) => {
    if (item.state !== "blocked") return item;
    const blocker = String(item.blocker || "");
    if (blocker.startsWith("Dependency ")) {
      const dependenciesRecoveringOrComplete = item.dependsOn.every((id) => ["pending", "running", "completed", "codex", "codex-pending", "host-pending", "host-dispatch-required", "host-reserved", "host-running"].includes(currentById.get(id)?.state));
      if (!dependenciesRecoveringOrComplete) return item;
      changed = true;
      return { ...item, state: "pending", blocker: "" };
    }
    if (blocker.startsWith("Assigned resource ") && hasAvailableDispatchRoute(manifest, item)) {
      changed = true;
      return { ...item, state: "pending", blocker: "" };
    }
    return item;
  });
  currentById = new Map(manifest.workItems.map((item) => [item.id, item]));
  manifest.workItems = manifest.workItems.map((item) => {
    if (item.state !== "pending") return item;
    const failedDependency = item.dependsOn.find((id) => ["failed", "blocked"].includes(currentById.get(id)?.state));
    if (!failedDependency) return item;
    changed = true;
    return { ...item, state: "blocked", blocker: `Dependency ${failedDependency} did not complete.` };
  });

  currentById = new Map(manifest.workItems.map((item) => [item.id, item]));
  manifest.workItems = manifest.workItems.map((item) => {
    if (item.state !== "codex-pending") return item;
    const failedDependency = item.dependsOn.find((id) => ["failed", "blocked"].includes(currentById.get(id)?.state));
    if (failedDependency) {
      changed = true;
      return { ...item, state: "blocked", blocker: `Dependency ${failedDependency} did not complete.` };
    }
    if (item.dependsOn.every((id) => currentById.get(id)?.state === "completed")) {
      changed = true;
      return { ...item, state: "codex", blocker: "" };
    }
    return item;
  });

  currentById = new Map(manifest.workItems.map((item) => [item.id, item]));
  manifest.workItems = manifest.workItems.map((item) => {
    if (item.state !== "host-pending") return item;
    const failedDependency = item.dependsOn.find((id) => ["failed", "blocked"].includes(currentById.get(id)?.state));
    if (failedDependency) {
      changed = true;
      return { ...item, state: "blocked", blocker: `Dependency ${failedDependency} did not complete.` };
    }
    if (item.dependsOn.every((id) => currentById.get(id)?.state === "completed")) {
      changed = true;
      return { ...item, state: "host-dispatch-required", blocker: "" };
    }
    return item;
  });

  const ready = manifest.workItems
    .filter((item) => item.state === "pending" && item.dependsOn.every((id) => currentById.get(id)?.state === "completed"))
    .sort((a, b) => b.priority - a.priority);
  const groups = new Map();
  for (const item of ready) {
    if (!groups.has(item.assignment)) groups.set(item.assignment, []);
    groups.get(item.assignment).push(item);
  }

  for (const [resourceId, items] of groups.entries()) {
    const resource = candidateFromManifest(manifest, resourceId);
    if (!resource || !resource.dispatchable || resource.state !== "available") {
      const reroutes = new Map();
      for (const item of items) {
        const alternate = availableAlternateForItem(manifest, item);
        if (!alternate) continue;
        reroutes.set(item.id, alternate);
        manifest = appendOrchestrationDecision(manifest, {
          type: "pre-dispatch-reroute",
          workItemId: item.id,
          from: resourceId,
          to: alternate.id,
          reason: "assigned resource unavailable before launch",
        });
      }
      manifest.workItems = manifest.workItems.map((item) => {
        if (!items.some((candidate) => candidate.id === item.id)) return item;
        const alternate = reroutes.get(item.id);
        if (!alternate) return { ...item, state: "blocked", blocker: `Assigned resource ${resourceId} is not dispatchable and no healthy alternate is available.` };
        const reassigned = {
          ...item,
          assignment: alternate.id,
          assignedModel: alternate.model,
          alternates: (item.alternates || []).filter((id) => id !== alternate.id && id !== resourceId),
          blocker: "",
          failureCategory: "",
          decisionReason: `Rerouted before launch because ${resourceId} was unavailable.`,
        };
        return alternate.dispatchMode === "host-subagent"
          ? prepareHostAssignedItem(manifest, reassigned, alternate)
          : { ...reassigned, state: "pending", hostAction: null, hostAttempt: null };
      });
      changed = true;
      continue;
    }
    if (!codexWorkerCanLaunch(manifest, resource)) continue;
    if (!writerGroupCanLaunch(manifest, items)) continue;
    const failedItemJob = [...(manifest.jobs || [])].reverse().find((job) => items.some((item) => (job.workItemIds || []).includes(item.id)) && job.state === "failed");
    const launch = launchGroup(manifest, resource, items, failedItemJob?.jobId || "");
    if (!launch.launched) {
      if (manifest.managerOnly === true && isBoundaryScopeBlocker(launch.blocker)) {
        const recovery = addBoundaryScopeRecovery(manifest, items);
        if (recovery.handledWorkItemIds.length) {
          manifest = recovery.manifest;
          changed = true;
          continue;
        }
      }
      if (launch.codexTakeover) {
        manifest.workItems = manifest.workItems.map((item) => items.some((candidate) => candidate.id === item.id)
          ? {
              ...item,
              state: "codex",
              assignment: "codex:current",
              assignedModel: manifest.resources?.find((candidate) => candidate.id === "codex:current")?.model || "current Codex session",
              alternates: [],
              blocker: "",
              failureCategory: "",
              decisionReason: launch.blocker,
            }
          : item);
        manifest.primaryWriterId = "codex:current";
        manifest = appendOrchestrationDecision(manifest, {
          type: "codex-scope-takeover",
          workItemIds: items.map((item) => item.id),
          reason: launch.blocker,
        });
        changed = true;
        continue;
      }
      manifest.workItems = manifest.workItems.map((item) => items.some((candidate) => candidate.id === item.id)
        ? { ...item, state: "failed", blocker: launch.blocker || "Worker launch failed.", failureCategory: isBoundaryScopeBlocker(launch.blocker) ? "scope-boundary" : "worker-failure" }
        : item);
      changed = true;
      continue;
    }
    manifest.jobs = [...(manifest.jobs || []), launch.job];
    manifest.workItems = manifest.workItems.map((item) => items.some((candidate) => candidate.id === item.id)
      ? { ...item, state: launch.job.state === "failed" ? "failed" : "running", activeJobId: launch.job.jobId }
      : item);
    changed = true;
  }

  const reservedJobs = ensureHostDispatchReservations(manifest.workItems, manifest.jobs);
  if (reservedJobs.length !== (manifest.jobs || []).length) {
    manifest.jobs = reservedJobs;
    changed = true;
  }

  manifest.state = deriveOrchestrationState(manifest);
  manifest.counts = {
    total: (manifest.jobs || []).length,
    completed: (manifest.jobs || []).filter((job) => job.state === "completed").length,
    running: (manifest.jobs || []).filter((job) => ["queued", "running", "unknown"].includes(job.state)).length,
    failed: (manifest.jobs || []).filter((job) => ["failed", "cancelled"].includes(job.state)).length,
  };
  if (changed) writeTeamRunManifest(workspace, manifest);
  return manifest;
}

function lastTeamRunJsonPath(workspace) {
  return path.join(bridgeRootFor(workspace), "last-team-run.json");
}

function writeTeamRunManifest(workspace, manifest) {
  const manifestPath = lastTeamRunJsonPath(workspace);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  writeJsonFile(manifestPath, { ...manifest, updatedAt: utcStamp() });
}

function teamStateFromJobs(jobs) {
  if (!jobs.length) return "blocked";
  const states = jobs.map((job) => String(job.state || "unknown").toLowerCase());
  if (states.some((state) => ["queued", "running", "unknown"].includes(state))) return "running";
  const completed = states.filter((state) => state === "completed").length;
  if (completed === states.length) return "completed";
  if (completed > 0) return "partial";
  return "failed";
}

function bridgeStatusForManifestJob(job, statusPath) {
  const parsed = readJsonFile(statusPath, null);
  const state = String(parsed?.state || "").trim().toLowerCase();
  const validStates = new Set(["queued", "running", "completed", "failed", "cancelled"]);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && validStates.has(state)) {
    return {
      workerPid: job.workerPid || null,
      workerCommandMarker: job.workerCommandMarker || job.jobId,
      ...parsed,
    };
  }
  return {
    jobId: job.jobId,
    state: "running",
    currentStep: "invalid-status-json",
    workerPid: job.workerPid || null,
    workerCommandMarker: job.workerCommandMarker || job.jobId,
    createdAt: job.createdAt || "",
    startedAt: job.startedAt || "",
    statusCorrupt: true,
    warning: "status.json was unreadable; recovering from the recorded process identity or finalized telemetry.",
  };
}

function completionPolicyFrom(value = {}) {
  const explicit = String(value.completionPolicy || "").trim().toLowerCase();
  if (["finite", "continuous-management"].includes(explicit)) return explicit;
  const mode = String(value.mode || "").trim().toLowerCase();
  const goal = String(value.rootGoal || value.goal || "").toLowerCase();
  if (mode === "continuous" || /\b(continuous|continuously|persistent|ongoing|24\s*\/\s*7|keep improving|keep managing|control room)\b/.test(goal)) {
    return "continuous-management";
  }
  return "finite";
}

function isContinuousManagement(value = {}) {
  return completionPolicyFrom(value) === "continuous-management";
}

function cycleContract(args = {}, workItems = [], cycleNumber = 1) {
  const objective = truncateText(redactArtifactContent(String(args.cycleObjective || args.nextCycleObjective || `Delivery cycle ${cycleNumber} toward the root objective.`).trim()), 1000);
  return {
    id: `cycle-${cycleNumber}`,
    number: cycleNumber,
    objective,
    itemIds: workItems.map((item) => item.id),
    acceptanceCriteria: boundedTextList(args.cycleAcceptanceCriteria || args.nextCycleAcceptanceCriteria, 12, 400),
    verification: boundedTextList(args.cycleVerification || args.nextCycleVerification, 12, 400),
    state: "running",
    startedAt: utcStamp(),
  };
}

function activeCycleIdFrom(manifest = {}) {
  if (manifest.activeCycle?.id) return String(manifest.activeCycle.id);
  return isContinuousManagement(manifest) ? `legacy-cycle-${Math.max(1, Number(manifest.cycleNumber || 1))}` : "";
}

function cycleTransitionIdentity(manifest = {}) {
  return {
    runId: String(manifest.runId || ""),
    cycleId: activeCycleIdFrom(manifest),
  };
}

function assertCycleTransitionIdentity(manifest, expected = {}) {
  const actual = cycleTransitionIdentity(manifest);
  if (!expected.runId || !expected.cycleId) {
    throw new Error("Cycle transitions require expectedRunId and expectedCycleId from the latest project-manager-status result.");
  }
  if (actual.runId !== String(expected.runId) || actual.cycleId !== String(expected.cycleId)) {
    throw new Error(`Stale cycle transition refused: expected run=${expected.runId}, cycle=${expected.cycleId}; active run=${actual.runId || "none"}, cycle=${actual.cycleId || "none"}. Refresh status and retry against the active cycle.`);
  }
}

function cycleTransitionRevision(manifest = {}) {
  return {
    ...cycleTransitionIdentity(manifest),
    state: String(manifest.activeCycle?.state || "running"),
    verifiedAt: String(manifest.activeCycle?.verifiedAt || ""),
  };
}

function assertCycleTransitionRevision(manifest, expected = {}) {
  assertCycleTransitionIdentity(manifest, expected);
  const actual = cycleTransitionRevision(manifest);
  if (actual.state !== expected.state || actual.verifiedAt !== expected.verifiedAt) {
    throw new Error(`Stale cycle revision refused: expected ${expected.cycleId} state=${expected.state}, verifiedAt=${expected.verifiedAt || "none"}; active state=${actual.state}, verifiedAt=${actual.verifiedAt || "none"}. Refresh status before planning or advancing work.`);
  }
}

function compactCycleEvidence(activeCycle, workItems = [], jobs = []) {
  const itemIds = new Set(activeCycle.itemIds || workItems.map((item) => item.id));
  const archivedItems = workItems
    .filter((item) => itemIds.has(item.id))
    .map((item) => ({
      id: item.id,
      objective: truncateText(item.objective || "", 400),
      state: item.state,
      assignment: item.assignment || "",
      assignedModel: item.assignedModel || "",
      activeJobId: item.activeJobId || "",
      failureCategory: item.failureCategory || "",
      blocker: truncateText(item.blocker || "", 400),
      codexEvidence: item.codexEvidence ? {
        summary: truncateText(item.codexEvidence.summary || "", 800),
        artifactRefs: boundedTextList(item.codexEvidence.artifactRefs, 12, 300),
      } : null,
      hostEvidence: item.hostEvidence ? {
        summary: truncateText(item.hostEvidence.summary || "", 800),
        artifactRefs: boundedTextList(item.hostEvidence.artifactRefs, 12, 300),
        changedFiles: boundedTextList(item.hostEvidence.changedFiles, 20, 300),
        testSummary: truncateText(item.hostEvidence.testSummary || "", 500),
      } : null,
    }));
  const archivedJobs = jobs
    .filter((job) => (job.workItemIds || job.assignedTasks || []).some((id) => itemIds.has(id)))
    .map((job) => ({
      jobId: job.jobId || "",
      transport: job.transport || "",
      toolName: job.toolName || "",
      laneId: job.laneId || "",
      state: job.state || "unknown",
      model: job.model || "",
      observedModel: job.observedModel || "",
      workItemIds: [...(job.workItemIds || job.assignedTasks || [])],
      failureCategory: job.failureCategory || "",
      blocker: truncateText(job.blocker || "", 400),
      startedAt: job.startedAt || "",
      completedAt: job.completedAt || "",
      artifactRef: job.jobId ? `.antigravity-bridge/jobs/${job.jobId}/` : "",
      inlineEvidence: job.inlineEvidence ? {
        summary: truncateText(job.inlineEvidence.summary || "", 800),
        artifactRefs: boundedTextList(job.inlineEvidence.artifactRefs, 12, 300),
        changedFiles: boundedTextList(job.inlineEvidence.changedFiles, 20, 300),
        testSummary: truncateText(job.inlineEvidence.testSummary || "", 500),
      } : null,
    }));
  return { workItems: archivedItems, jobs: archivedJobs };
}

function refreshTeamRunManifest(workspace, suppliedManifest = null, lockHeld = false) {
  const manifestPath = lastTeamRunJsonPath(workspace);
  if (!lockHeld) {
    return withFileLock(manifestPath, () => {
      const latest = readJsonFile(manifestPath, suppliedManifest) || suppliedManifest;
      return refreshTeamRunManifest(workspace, latest, true);
    });
  }
  const manifest = suppliedManifest || readJsonFile(manifestPath, null);
  if (!manifest || !Array.isArray(manifest.jobs)) {
    throw new Error(`No team run manifest found at ${manifestPath}. Start run-team-task first.`);
  }

  const jobs = manifest.jobs.map((job) => {
    if (job.transport === "host-subagent") return job;
    if (!job.jobId) return { ...job, state: "failed", currentStep: "missing-job-id", blocker: "Worker launch did not return a JobId." };
    const jobDir = jobDirFor(workspace, job.jobId);
    const statusPath = path.join(jobDir, "status.json");
    if (!fs.existsSync(statusPath)) return { ...job, state: "failed", currentStep: "missing-status", blocker: "status.json is missing." };
    const repair = repairStaleRunningJob(workspace, job.jobId, jobDir, bridgeStatusForManifestJob(job, statusPath));
    const telemetry = readJsonFile(path.join(jobDir, "worker-telemetry.json"), null);
    const telemetryFailureCategory = telemetry?.success === false ? String(telemetry.failureCategory || "worker-failure") : "";
    const effectiveState = repair.status.state || "unknown";
    return {
      ...job,
      state: effectiveState,
      currentStep: repair.status.currentStep || "",
      blocker: repair.status.blocker || "",
      warning: repair.status.warning || "",
      failureCategory: ["failed", "cancelled"].includes(effectiveState)
        ? telemetryFailureCategory || repair.status.failureCategory || failureCategoryFromText(`${repair.status.currentStep || ""} ${repair.status.blocker || ""}`)
        : "",
      observedModel: String(telemetry?.observedModel || repair.status.observedModel || job.observedModel || ""),
      workerPid: repair.status.workerPid || job.workerPid || null,
      createdAt: repair.status.createdAt || job.createdAt || "",
      startedAt: repair.status.startedAt || job.startedAt || "",
      completedAt: repair.status.completedAt || job.completedAt || "",
      jobUpdatedAt: repair.status.updatedAt || "",
    };
  });
  let refreshed = {
    ...manifest,
    jobs,
    counts: {
      total: jobs.length,
      completed: jobs.filter((job) => job.state === "completed").length,
      running: jobs.filter((job) => ["queued", "running", "unknown"].includes(job.state)).length,
      failed: jobs.filter((job) => ["failed", "cancelled"].includes(job.state)).length,
    },
  };
  if (Number(manifest.version || 1) >= 2) {
    refreshed = syncWorkItemsFromJobs(refreshed);
    refreshed.state = deriveOrchestrationState(refreshed);
  } else {
    refreshed.state = teamStateFromJobs(jobs);
  }
  writeTeamRunManifest(workspace, refreshed);
  return refreshed;
}

function teamRunTransitionSignature(snapshot = {}) {
  return JSON.stringify({
    state: snapshot.state || "unknown",
    workItems: (snapshot.workItems || [])
      .map((item) => `${item.id}:${item.state}:${item.activeJobId || ""}:${item.failureCategory || ""}`)
      .sort(),
    jobs: (snapshot.jobs || [])
      .map((job) => `${job.jobId}:${job.state}:${job.currentStep || ""}:${job.completedAt || ""}`)
      .sort(),
    finalVerification: snapshot.finalVerification?.passed,
    activeCycle: `${snapshot.activeCycle?.id || ""}:${snapshot.activeCycle?.state || ""}`,
    cycleNumber: Number(snapshot.cycleNumber || 0),
    termination: snapshot.termination?.category || "",
    capacityCheckpointCount: Number(snapshot.capacityCheckpointCount || 0),
  });
}

async function waitForTeamRun(workspace, waitSeconds = 0, suppliedManifest = null) {
  const boundedWait = Math.max(0, Math.min(300, Number(waitSeconds || 0)));
  const startedAt = Date.now();
  const deadline = Date.now() + (boundedWait * 1000);
  let snapshot = advanceOrchestrationRun(workspace, refreshTeamRunManifest(workspace, suppliedManifest));
  const initialSignature = teamRunTransitionSignature(snapshot);
  let transitionDetected = false;
  let refreshError = "";
  while (snapshot.state === "running" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000, Math.max(100, deadline - Date.now()))));
    try {
      snapshot = advanceOrchestrationRun(workspace, refreshTeamRunManifest(workspace));
    } catch (error) {
      refreshError = truncateText(String(error?.message || error || "Status refresh failed."), 300);
      break;
    }
    transitionDetected = teamRunTransitionSignature(snapshot) !== initialSignature;
    if (transitionDetected) break;
  }
  return {
    ...snapshot,
    reportWait: {
      requestedSeconds: boundedWait,
      elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
      transitionDetected,
      refreshError,
    },
  };
}

function compactWorkItemIds(items, limit = 4) {
  const ids = (items || []).map((item) => item.id).filter(Boolean);
  return ids.length > limit ? `${ids.slice(0, limit).join(",")} (+${ids.length - limit})` : (ids.join(",") || "none");
}

function orchestrationProgress(snapshot) {
  const workItems = snapshot.workItems || [];
  const activeStates = new Set(["running", "codex", "host-dispatch-required", "host-reserved", "host-running", "host-cancel-required"]);
  const completed = workItems.filter((item) => item.state === "completed");
  const active = workItems.filter((item) => activeStates.has(item.state));
  const failed = workItems.filter((item) => item.state === "failed");
  const blocked = workItems.filter((item) => item.state === "blocked");
  const pending = workItems.filter((item) => ["pending", "codex-pending", "host-pending"].includes(item.state));
  const transition = [
    ...(snapshot.decisions || []).filter((entry) => entry?.at),
    ...(snapshot.jobs || []).map((job) => ({
      at: job.completedAt || job.jobUpdatedAt || job.startedAt || job.createdAt || "",
      type: `worker-${job.state || "unknown"}`,
      workItemIds: job.workItemIds || job.assignedTasks || [],
      resourceId: job.resourceId || job.laneId || "",
    })).filter((entry) => entry.at),
  ].sort((a, b) => Date.parse(String(b.at || "")) - Date.parse(String(a.at || "")))[0] || null;
  const transitionItem = transition?.workItemId || (transition?.workItemIds || []).join(",") || transition?.scopeWorkItemId || "none";
  return {
    total: workItems.length,
    completed,
    active,
    failed,
    blocked,
    pending,
    transitionText: transition
      ? `${transition.at}; type=${transition.type || "unknown"}; item=${transitionItem}; resource=${transition.resourceId || transition.to || "none"}`
      : "none recorded",
  };
}

function workGraphIntegrity(snapshot = {}) {
  const workItems = snapshot.workItems || [];
  const placeholderItems = workItems.filter((item) => /^Complete work item \d+$/i.test(String(item.objective || "").trim()));
  if (placeholderItems.length) {
    return {
      valid: false,
      reason: `placeholder objectives detected for ${placeholderItems.map((item) => item.id).join(",")}; an older caller lost title/description/class fields`,
    };
  }
  return { valid: true, reason: "canonical objectives retained" };
}

function resourcePlatform(resource = {}) {
  const explicit = String(resource.platform || "").trim().toLowerCase();
  if (explicit) return explicit;
  const prefix = String(resource.id || "").split(":")[0].toLowerCase();
  return ["codex-host", "codex-cli"].includes(prefix) ? "codex" : prefix;
}

function latestOrchestrationTransition(snapshot = {}) {
  return [
    ...(snapshot.decisions || []).filter((entry) => entry?.at),
    ...(snapshot.jobs || []).map((job) => ({
      at: job.completedAt || job.jobUpdatedAt || job.startedAt || job.createdAt || "",
      type: `worker-${job.state || "unknown"}`,
      workItemIds: job.workItemIds || job.assignedTasks || [],
      resourceId: job.resourceId || job.laneId || "",
    })).filter((entry) => entry.at),
  ].sort((left, right) => Date.parse(String(right.at || "")) - Date.parse(String(left.at || "")))[0] || null;
}

function jobForWorkItem(snapshot = {}, item = {}) {
  return [...(snapshot.jobs || [])].reverse().find((job) => {
    const ids = job.workItemIds || job.assignedTasks || [];
    return ids.includes(item.id);
  }) || null;
}

function elapsedWorkSeconds(snapshot = {}, item = {}) {
  const job = jobForWorkItem(snapshot, item);
  const started = Date.parse(String(job?.startedAt || job?.createdAt || item.startedAt || ""));
  return Number.isFinite(started) ? Math.max(0, Math.round((Date.now() - started) / 1000)) : null;
}

function workItemLeaseMinutes(snapshot = {}, item = {}) {
  const job = jobForWorkItem(snapshot, item);
  const recorded = Number(job?.leaseMinutes);
  if (Number.isFinite(recorded) && recorded > 0) return recorded;
  const resource = (snapshot.resources || []).find((candidate) => candidate.id === item.assignment) || {};
  const rank = ({ low: 1, medium: 2, high: 3, critical: 4 })[String(item.complexity || "medium").toLowerCase()] || 2;
  return workerMinutesFor(snapshot, rank, resourcePlatform(resource), item.readOnly === true);
}

function workItemActivitySummary(snapshot = {}, item = {}) {
  const job = jobForWorkItem(snapshot, item);
  const elapsedSeconds = elapsedWorkSeconds(snapshot, item);
  const leaseMinutes = workItemLeaseMinutes(snapshot, item);
  const elapsedMinutes = Number.isFinite(elapsedSeconds) ? Math.max(0, Math.ceil(elapsedSeconds / 60)) : null;
  const lease = Number.isFinite(elapsedMinutes) && Number.isFinite(leaseMinutes)
    ? `${elapsedMinutes}/${leaseMinutes}m lease`
    : formatElapsed(elapsedSeconds);
  const step = truncateText(String(job?.currentStep || "worker-active"), 60);
  return `${step}; ${lease}`;
}

function formatElapsed(seconds) {
  if (!Number.isFinite(seconds)) return "elapsed unknown";
  if (seconds < 120) return `${seconds}s`;
  return `${Math.round(seconds / 60)}m`;
}

function controlRoomTeamSummary(snapshot = {}, progress = orchestrationProgress(snapshot)) {
  const supervisor = orchestrationSupervisorHealthy(snapshot) ? "supervisor=running" : "supervisor=idle";
  if (!progress.active.length) {
    const waiting = progress.pending.length ? `; waiting=${compactWorkItemIds(progress.pending)}` : "";
    return `Codex parent=CEO/manager in this existing control-room task; ${supervisor}; workers=none active${waiting}`;
  }
  const resources = new Map((snapshot.resources || []).map((resource) => [resource.id, resource]));
  const active = progress.active.slice(0, 4).map((item) => {
    const resource = resources.get(item.assignment);
    const owner = resource?.team || item.assignment || "unassigned";
    const model = item.assignedModel || resource?.model || "default";
    return `${item.id}->${owner}/${model} (${item.state}; ${workItemActivitySummary(snapshot, item)})`;
  });
  if (progress.active.length > active.length) active.push(`+${progress.active.length - active.length} more`);
  return `Codex parent=CEO/manager in this existing control-room task; ${supervisor}; workers=${active.join("; ")}`;
}

function platformCapacitySummary(snapshot = {}, progress = orchestrationProgress(snapshot), platform = "codex") {
  const labels = { codex: "Codex", claude: "Claude", antigravity: "Antigravity", cursor: "Cursor" };
  const resources = (snapshot.resources || []).filter((resource) => resourcePlatform(resource) === platform);
  if (!resources.length) return `${labels[platform] || platform}=not recorded`;

  const activeAssignments = new Set(progress.active.map((item) => item.assignment).filter(Boolean));
  const active = resources.filter((resource) => activeAssignments.has(resource.id));
  const statePriority = { available: 6, active: 6, "manager-reserve": 5, constrained: 4, cooldown: 3, exhausted: 2, unavailable: 1 };
  const ranked = [...resources].sort((left, right) => {
    const activeDelta = Number(activeAssignments.has(right.id)) - Number(activeAssignments.has(left.id));
    if (activeDelta) return activeDelta;
    const stateDelta = Number(statePriority[right.state] || 0) - Number(statePriority[left.state] || 0);
    if (stateDelta) return stateDelta;
    return Number(right.quality || 0) - Number(left.quality || 0);
  });
  const selected = active[0]
    || (platform === "codex" ? resources.find((resource) => resource.id === "codex:current") : null)
    || ranked[0];
  const modelNames = [...new Set((active.length ? active : [selected])
    .map((resource) => resource.displayName || resource.model || resource.id)
    .filter(Boolean))].slice(0, 2);
  const availableCount = resources.filter((resource) => resource.state === "available" && resource.dispatchable !== false).length;
  const remainingValue = selected?.remainingPercent;
  const remaining = remainingValue !== null && remainingValue !== undefined && remainingValue !== "" && Number.isFinite(Number(remainingValue))
    ? `${Number(remainingValue)}%`
    : "unknown";
  const reset = selected?.resetAt ? `, reset=${selected.resetAt}` : "";
  const state = active.length ? "active" : (selected?.state || "unknown");
  const reserve = platform === "codex" ? `, reserve=${snapshot.codexManagerReservePercent ?? selected?.managerReservePercent ?? 15}%` : "";
  return `${labels[platform] || platform}=${state}, model=${modelNames.join("+") || "unknown"}, remaining=${remaining}${reset}${reserve}, available=${availableCount}/${resources.length}`;
}

function controlRoomChangedSummary(snapshot = {}, progress = orchestrationProgress(snapshot), graphIntegrity = workGraphIntegrity(snapshot), reportWait = {}) {
  if (!graphIntegrity.valid) return `work graph rejected: ${graphIntegrity.reason}`;
  if (reportWait.refreshError) return `status refresh warning; showing last verified snapshot (${reportWait.refreshError})`;
  if (Number(reportWait.requestedSeconds || 0) > 0 && !reportWait.transitionDetected) {
    return `no recorded transition during ${reportWait.elapsedSeconds || 0}s; active owners and leases are shown below`;
  }
  const transition = latestOrchestrationTransition(snapshot);
  if (!transition) return `run state is ${snapshot.state || "unknown"}; no transition recorded yet`;
  const item = transition.workItemId || (transition.workItemIds || []).join(",") || transition.scopeWorkItemId || "run";
  return `${transition.type || "state-change"}: ${item}; owner=${transition.resourceId || transition.to || "none"}; at=${transition.at}`;
}

function controlRoomBlockerSummary(snapshot = {}, progress = orchestrationProgress(snapshot), graphIntegrity = workGraphIntegrity(snapshot), reportWait = {}) {
  if (!graphIntegrity.valid) return isContinuousManagement(snapshot)
    ? "current cycle graph is malformed; fail this cycle and provide a canonical correction graph under the same root run"
    : "manager intervention required: replace the malformed graph; no user decision is needed unless an old worker cannot be stopped";
  if (reportWait.refreshError) return "monitoring evidence is stale; do not infer completion";
  if (Number(snapshot.termination?.cancellationUnconfirmed || 0) > 0) return "worker cancellation is unconfirmed; replacement is forbidden";
  if (!isContinuousManagement(snapshot) && snapshot.finalVerification?.passed === false) return `verification failed: ${truncateText(snapshot.finalVerification.summary || "recorded gate failure", 220)}`;
  const managerBoundary = (snapshot.workItems || []).filter((item) => item.state === "codex");
  if (managerBoundary.length) return `manager/user boundary pending: ${compactWorkItemIds(managerBoundary)}`;
  if (isContinuousManagement(snapshot) && snapshot.activeCycle?.state === "failed") return `cycle ${snapshot.activeCycle.number || "current"} failed; a bounded correction cycle is required while the root objective remains active`;
  if (isContinuousManagement(snapshot) && snapshot.activeCycle?.state === "verified") return "none recorded; the verified cycle is a checkpoint, not root-objective completion";
  if (progress.failed.length || progress.blocked.length) {
    return `failed=${compactWorkItemIds(progress.failed)}; blocked=${compactWorkItemIds(progress.blocked)}`;
  }
  if (snapshot.state === "blocked") return "run is blocked; inspect only the narrow failed evidence";
  if (snapshot.state === "ready-for-codex") return isContinuousManagement(snapshot)
    ? "cycle acceptance decision is pending; root-objective completion is forbidden"
    : "CEO acceptance decision and final verification are pending";
  if (!progress.active.length && progress.pending.length) return `no worker is active while ${progress.pending.length} item(s) wait for dependency or dispatch`;
  return "none recorded";
}

function controlRoomNextMove(snapshot = {}, progress = orchestrationProgress(snapshot), graphIntegrity = workGraphIntegrity(snapshot)) {
  if (!graphIntegrity.valid) return isContinuousManagement(snapshot)
    ? "record cycleVerificationFailed and nextWorkItems with canonical objectives, classes, boundaries, and real dependencies under this same run"
    : "stop the damaged contract and call run-project-manager once with canonical objectives, classes, boundaries, and real dependencies";
  if (Number(snapshot.termination?.cancellationUnconfirmed || 0) > 0) return "close and acknowledge the old host worker before any replacement";
  if ((snapshot.workItems || []).some((item) => ["host-dispatch-required", "host-reserved"].includes(item.state))) {
    return "execute the token-bound native Codex reservation/spawn action; keep the parent task manager-only";
  }
  if (isContinuousManagement(snapshot) && ["verified", "failed"].includes(snapshot.activeCycle?.state)) {
    return "pass nextWorkItems through project-manager-status for the next bounded cycle in this same run; keep the Codex Goal active";
  }
  if (!isContinuousManagement(snapshot) && snapshot.finalVerification?.passed === false) return "assign the smallest correction for the failed gate, then re-verify";
  if (snapshot.state === "ready-for-codex") return isContinuousManagement(snapshot)
    ? "review this cycle, record cycleVerified/cycleVerificationFailed, and provide nextWorkItems; never call projectVerified"
    : "review compact evidence once, request one bounded correction if needed, then record final verification";
  if (snapshot.state === "completed") return "objective verified; report completion and stop creating work";
  if (progress.failed.length || progress.blocked.length) return "rescope or reassign the narrow failed lane; ask the user only for a real authorization or irreversible decision";
  if (progress.active.length) return "monitor the existing workers once; intervene on a recorded stall, failure, capacity change, or dependency release without spawning duplicates";
  if (progress.pending.length) return "dispatch the next dependency-ready lane or resolve its recorded dependency";
  return "inspect the recorded blocker and make one evidence-based management decision";
}

function displayCycleState(snapshot = {}) {
  const state = String(snapshot.activeCycle?.state || "n/a");
  if (snapshot.state === "ready-for-codex" && state === "running") return "awaiting-acceptance";
  return state;
}

function formatCeoControlRoomBrief(snapshot = {}, progress = orchestrationProgress(snapshot), graphIntegrity = workGraphIntegrity(snapshot), reportWait = {}) {
  const capacity = (snapshot.resources || []).length
    ? ["codex", "claude", "antigravity", "cursor"].map((platform) => platformCapacitySummary(snapshot, progress, platform)).join(" | ")
    : "resource snapshot not recorded; refresh before assigning new work";
  return [
    "CEOControlRoom:",
    `Objective: ${truncateText(snapshot.rootGoal || snapshot.goal || "not recorded", 320)}`,
    `Changed: ${controlRoomChangedSummary(snapshot, progress, graphIntegrity, reportWait)}`,
    `Team now: ${controlRoomTeamSummary(snapshot, progress)}`,
    `Capacity: ${capacity}; next review=${snapshot.nextCapacityCheckpointAt || "on refresh"}`,
    `Progress: root=${isContinuousManagement(snapshot) ? "active" : snapshot.state || "unknown"}; cycle=${snapshot.activeCycle?.number || "n/a"}/${displayCycleState(snapshot)}; verifiedCycles=${(snapshot.cycles || []).filter((cycle) => cycle.passed === true).length}; items=${progress.completed.length}/${progress.total} completed; active=${progress.active.length}; pending=${progress.pending.length}; failed=${progress.failed.length}; blocked=${progress.blocked.length}`,
    `Blocker/Decision: ${controlRoomBlockerSummary(snapshot, progress, graphIntegrity, reportWait)}`,
    `Next: ${controlRoomNextMove(snapshot, progress, graphIntegrity)}`,
  ];
}

function formatTeamRunSnapshot(workspace, snapshot, waitedSeconds = 0, reportProfileOverride = null) {
  const orchestrated = Number(snapshot.version || 1) >= 2;
  const progress = orchestrationProgress(snapshot);
  const graphIntegrity = workGraphIntegrity(snapshot);
  const reportProfile = reportProfileOverride || (process.env.AI_MOBILE_SELF_TEST === "1" ? DEFAULT_PROFILE : readProfile());
  const reportAddress = truncateText(String(reportProfile.address || "").trim(), 80);
  const reportStyle = truncateText(String(reportProfile.updateStyle || "concise-executive").trim(), 40);
  const reportWait = snapshot.reportWait || {
    requestedSeconds: waitedSeconds,
    elapsedSeconds: waitedSeconds,
    transitionDetected: false,
  };
  const completionClaimAllowed = snapshot.state === "completed" && !isContinuousManagement(snapshot);
  const allWorkItems = snapshot.workItems || [];
  const visibleWorkItems = graphIntegrity.valid
    ? [...new Map([
        ...allWorkItems.filter((item) => item.state !== "completed"),
        ...allWorkItems.filter((item) => item.state === "completed").slice(-1),
      ].map((item) => [item.id, item])).values()].slice(0, 8)
    : [];
  const allConstraints = snapshot.constraints || [];
  const visibleConstraints = allConstraints.slice(-3);
  // Native Codex workers share the manager's five-hour pool. Bound concurrent host actions even when
  // several read-only items are ready; external CLI workers keep their independent parallelism.
  const maxConcurrentHostWorkers = Math.max(1, Math.min(3, Number(snapshot.maxConcurrentCodexWorkers || 1)));
  let availableHostSlots = maxConcurrentHostWorkers - (snapshot.jobs || []).filter((job) => job.transport === "host-subagent" && ["running", "unknown"].includes(job.state)).length;
  const maxParallelWriters = Math.max(1, Math.min(3, Number(snapshot.maxParallelWriters || 2)));
  // A queued host reservation is not a running writer yet. Select the bounded spawn actions in order
  // below so disjoint reservations can launch together and overlapping reservations expose only one.
  const boundaryHoldingWriterJobs = activeWriterJobs(snapshot)
    .filter((job) => !(job.transport === "host-subagent" && job.state === "queued"));
  let activeWriterCount = boundaryHoldingWriterJobs.length;
  const snapshotItemsById = new Map((snapshot.workItems || []).map((item) => [item.id, item]));
  const scheduledWriterItems = boundaryHoldingWriterJobs.flatMap((job) => (job.workItemIds || job.assignedTasks || [])
    .map((id) => snapshotItemsById.get(id))
    .filter((item) => item && !item.readOnly));
  const emittableHostDispatchItems = (snapshot.workItems || [])
    .filter((item) => ["host-dispatch-required", "host-reserved"].includes(item.state))
    .sort((left, right) => Number(right.priority || 0) - Number(left.priority || 0))
    .filter((item) => {
      if (availableHostSlots <= 0) return false;
      if (!item.readOnly && (activeWriterCount >= maxParallelWriters || scheduledWriterItems.some((writer) => !writerItemsAreDisjoint(item, writer)))) return false;
      availableHostSlots -= 1;
      if (!item.readOnly) {
        activeWriterCount += 1;
        scheduledWriterItems.push(item);
      }
      return true;
    });
  const lines = [
    orchestrated ? "AiMobileResourceOrchestrationRun:" : "AiMobileTeamRun:",
    orchestrated ? `RunId: ${snapshot.runId || "unknown"}` : null,
    orchestrated && isContinuousManagement(snapshot) ? `ActiveCycleId: ${activeCycleIdFrom(snapshot)}` : null,
    orchestrated && isContinuousManagement(snapshot) ? `ActiveCycleState: ${displayCycleState(snapshot)}` : null,
    `State: ${snapshot.state}`,
    orchestrated ? `CompletionClaimAllowed: ${completionClaimAllowed}` : null,
    orchestrated ? `RequiredUserStatus: ${reportAddress ? `${reportAddress}, ` : ""}AI Mobile run ${snapshot.runId || "unknown"}: ${snapshot.state}` : null,
    orchestrated ? "ControlRoomScope: one existing Codex control-room task; provider worker sessions/jobs are allowed and expected; never create Codex tasks/threads for workers." : null,
    ...(orchestrated ? formatCeoControlRoomBrief(snapshot, progress, graphIntegrity, reportWait) : []),
    orchestrated && !completionClaimAllowed ? `RequiredClaimBoundary: do not say the root objective or Codex Goal is done; report the exact ${snapshot.state} state and only the workers actually recorded below.` : null,
    `Workspace: ${workspace}`,
    orchestrated && !graphIntegrity.valid ? `WorkGraphIntegrity: invalid; ${graphIntegrity.reason}` : null,
    orchestrated && reportWait.requestedSeconds > 0
      ? `StatusChange: ${reportWait.transitionDetected ? "recorded transition detected; report the change now" : `none during ${reportWait.elapsedSeconds}s; report one activity checkpoint without repeating unchanged history`}`
      : null,
    orchestrated && reportWait.refreshError ? `StatusRefreshWarning: ${reportWait.refreshError}; returning the last verified snapshot. Do not infer a terminal state.` : null,
    !orchestrated ? `Jobs: ${snapshot.counts?.total || 0}; completed=${snapshot.counts?.completed || 0}; running=${snapshot.counts?.running || 0}; failed=${snapshot.counts?.failed || 0}` : null,
    orchestrated && snapshot.state === "running" && graphIntegrity.valid ? "NextCheck: one project-manager-status call with waitSeconds=120; it returns early on transition. No 20-second polling loop and no automation unless explicitly requested." : null,
    orchestrated ? `RequiredProgressReport: ${reportAddress ? `address the user as \"${reportAddress}\"; ` : ""}style=${reportStyle}. Relay CEOControlRoom exactly: Objective, Changed, Team now, Capacity, Progress, Blocker/Decision, Next. Do not freeform, omit the root objective/owners/capacity, repeat history, or answer only \"running\".` : null,
    orchestrated && !graphIntegrity.valid && snapshot.state !== "completed"
      ? (isContinuousManagement(snapshot)
        ? `RequiredManagerAction: do not integrate the malformed cycle. After its workers are terminal, call project-manager-status with expectedRunId=${snapshot.runId}, expectedCycleId=${activeCycleIdFrom(snapshot)}, cycleVerificationFailed, and canonical nextWorkItems. Preserve this root run.`
        : "RequiredManagerAction: do not resume, integrate, or verify this malformed graph. Call run-project-manager once with the same goal and canonical workItems using objective, executionClass, expectedFiles, and only real dependsOn edges. Contract replacement must stop old workers before dispatch.")
      : null,
    orchestrated && snapshot.state === "running" && graphIntegrity.valid
      ? "RequiredManagerAction: after the initial assignment receipt, make one transition-aware project-manager-status call with waitSeconds=120. Report the transition or one two-minute activity checkpoint, then yield to this task's single active Goal; do not create another Codex task, Goal, run, or automation."
      : null,
    orchestrated && isContinuousManagement(snapshot) && snapshot.state === "ready-for-codex"
      ? (["verified", "failed"].includes(snapshot.activeCycle?.state)
        ? `RequiredManagerAction: start the next bounded cycle with expectedRunId=${snapshot.runId}, expectedCycleId=${activeCycleIdFrom(snapshot)}, and project-manager-status.nextWorkItems in this same run. Never call projectVerified or update_goal complete.`
        : `RequiredManagerAction: record cycleVerified or cycleVerificationFailed with expectedRunId=${snapshot.runId}, expectedCycleId=${activeCycleIdFrom(snapshot)}, evidence, and nextWorkItems. Never call projectVerified or update_goal complete.`)
      : null,
    orchestrated && graphIntegrity.valid ? "WorkGraph:" : null,
    ...(orchestrated && graphIntegrity.valid ? visibleWorkItems.map((item) => `- ${item.id}: ${item.state}; class=${item.executionClass || (item.readOnly ? "analysis" : "code")}; resource=${item.assignment}; model=${item.assignedModel}; dependsOn=${item.dependsOn.join(",") || "none"}${item.codexEvidence?.summary || item.hostEvidence?.summary ? "; evidence=recorded" : ""}${item.externallyConsequential ? "; external-effect=current-Codex-only" : ""}${item.failureCategory ? `; failure=${item.failureCategory}` : ""}`) : []),
    orchestrated && graphIntegrity.valid && allWorkItems.length > visibleWorkItems.length ? `- ${allWorkItems.length - visibleWorkItems.length} completed or low-signal work items omitted from this checkpoint.` : null,
    ...(orchestrated && emittableHostDispatchItems.filter((item) => item.state === "host-dispatch-required").length
      ? [
          "HostCodexReservationActions:",
          ...emittableHostDispatchItems
            .filter((item) => item.state === "host-dispatch-required")
            .map((item) => `- ${item.id}: call project-manager-status with one reserved hostWorkerEvent: event=reserved; runId=${snapshot.runId}; workItemId=${item.id}; attemptId=${item.hostAttempt?.attemptId}; dispatchToken=${item.hostAttempt?.dispatchToken}. Do not spawn until the next status response still exposes this reservation.`),
        ]
      : []),
    ...(orchestrated && emittableHostDispatchItems.filter((item) => item.state === "host-reserved").length
      ? [
          "HostCodexActions:",
          ...emittableHostDispatchItems
            .filter((item) => item.state === "host-reserved")
            .flatMap((item) => [
              `- ${item.id}: runId=${snapshot.runId}; attemptId=${item.hostAttempt?.attemptId}; dispatchToken=${item.hostAttempt?.dispatchToken}; call ${item.hostAction?.toolName || "multi_agent_v1__spawn_agent"} with agent_type=${item.hostAction?.agentType || (item.readOnly ? "explorer" : "worker")}, model=${item.hostAction?.model || item.assignedModel}, reasoning_effort=${item.hostAction?.reasoningEffort || "medium"}, fork_context=false.`,
              `  Message: ${truncateText(item.hostAction?.message || item.objective, 1800)}`,
              "  Immediately acknowledge started with the returned agentId through project-manager-status using the exact runId, workItemId, attemptId, and dispatchToken. Never reuse the token for another item.",
            ]),
        ]
      : []),
    ...(orchestrated && (snapshot.workItems || []).some((item) => item.state === "host-running")
      ? [
          "HostCodexWorkers:",
          ...(snapshot.workItems || [])
            .filter((item) => item.state === "host-running")
            .map((item) => `- ${item.id}: agent=${item.hostAgent?.agentId || "unknown"}; nickname=${item.hostAgent?.nickname || "none"}; model=${item.assignedModel}`),
        ]
      : []),
    ...(orchestrated && (snapshot.workItems || []).some((item) => item.state === "host-cancel-required")
      ? [
          "HostCodexCancellationActions:",
          ...(snapshot.workItems || [])
            .filter((item) => item.state === "host-cancel-required")
            .map((item) => `- ${item.id}: call multi_agent_v1__close_agent with target=${item.hostAgent?.agentId || "unknown"}; then acknowledge cancelled or cancellation-unconfirmed through hostWorkerEvents with runId=${snapshot.runId}, attemptId=${item.hostAttempt?.attemptId}, dispatchToken=${item.hostAttempt?.dispatchToken}.`),
        ]
      : []),
    ...(orchestrated && (snapshot.workItems || []).some((item) => item.state === "codex")
      ? [
          snapshot.managerOnly === true ? "ManagerBoundaryActions:" : "CodexOwnedActions:",
          ...(snapshot.workItems || [])
            .filter((item) => item.state === "codex")
            .map((item) => `- ${item.id}: ${truncateText(item.objective || "Complete the Codex-owned integration action.", 360)}${item.externallyConsequential ? " Authorization and live safety checks remain mandatory." : ""}`),
        ]
      : []),
    ...(orchestrated && (snapshot.workItems || []).some((item) => item.codexEvidence?.summary)
      ? [
          "CodexEvidence:",
          ...(snapshot.workItems || [])
            .filter((item) => item.codexEvidence?.summary)
            .map((item) => `- ${item.id}: ${truncateText(item.codexEvidence.summary, 300)}`),
        ]
      : []),
    ...(orchestrated && (snapshot.workItems || []).some((item) => item.hostEvidence?.summary)
      ? [
          "HostCodexEvidence:",
          ...(snapshot.workItems || [])
            .filter((item) => item.hostEvidence?.summary)
            .map((item) => `- ${item.id}: ${truncateText(item.hostEvidence.summary, 300)}`),
        ]
      : []),
    ...(orchestrated && allConstraints.length
      ? [
          `ActiveConstraints: ${allConstraints.length} persisted; showing the newest ${visibleConstraints.length}.`,
          ...visibleConstraints.map((constraint) => `- ${truncateText(constraint, 180)}`),
        ].filter(Boolean)
      : []),
    ...(orchestrated && snapshot.termination?.category
      ? ["RunTermination:", `- ${snapshot.termination.category}: ${truncateText(snapshot.termination.reason, 500)}; workersTargeted=${snapshot.termination.targetedWorkers || 0}; workersStopped=${snapshot.termination.cancelledWorkers || 0}; workerStopUnconfirmed=${snapshot.termination.cancellationUnconfirmed || 0}; supervisorStopped=${snapshot.termination.supervisorStopped !== false}; supervisorStopUnconfirmed=${snapshot.termination.supervisorStopUnconfirmed || 0}`]
      : []),
    ...(orchestrated && typeof snapshot.finalVerification?.passed === "boolean"
      ? [isContinuousManagement(snapshot) ? "LegacyCycleVerificationIgnoredForRoot:" : "FinalVerification:", `- passed=${snapshot.finalVerification.passed}; ${truncateText(snapshot.finalVerification.summary, 700)}`]
      : []),
    graphIntegrity.valid ? "WorkerResults:" : "WorkerResults: omitted because the malformed graph cannot produce acceptable integration evidence.",
  ].filter(Boolean);

  const allJobs = snapshot.jobs || [];
  const activeJobStates = new Set(["queued", "running", "unknown"]);
  const activeCycleItemIds = new Set(snapshot.activeCycle?.itemIds || []);
  const currentCycleJobs = allJobs.filter((job) => (job.workItemIds || job.assignedTasks || []).some((id) => activeCycleItemIds.has(id)));
  const visibleJobs = graphIntegrity.valid
    ? [...new Map([
        ...allJobs.filter((job) => activeJobStates.has(job.state)),
        ...currentCycleJobs,
        ...allJobs.filter((job) => ["failed", "cancelled"].includes(job.state)).slice(-2),
        ...allJobs.filter((job) => job.state === "completed").slice(-1),
      ].map((job) => [job.jobId, job])).values()]
      .sort((left, right) => allJobs.indexOf(left) - allJobs.indexOf(right))
      .slice(-12)
    : [];
  if (allJobs.length > visibleJobs.length) lines.push(`- ${allJobs.length - visibleJobs.length} older or redundant worker attempts omitted; use read-job only for diagnosis.`);
  for (const job of visibleJobs) {
    const index = allJobs.indexOf(job);
    const hostTransport = job.transport === "host-subagent";
    const jobDir = hostTransport ? "" : jobDirFor(workspace, job.jobId);
    const workItemIds = job.workItemIds || job.assignedTasks || [];
    const supersededBySuccess = ["failed", "cancelled"].includes(job.state)
      && snapshot.jobs.slice(index + 1).some((later) => later.state === "completed"
        && (later.workItemIds || later.assignedTasks || []).some((id) => workItemIds.includes(id)));
    const supersededByCodex = ["failed", "cancelled"].includes(job.state)
      && workItemIds.some((id) => (snapshot.workItems || []).some((item) => item.id === id && item.assignment === "codex:current" && item.state === "completed"));
    const result = hostTransport ? String(job.inlineEvidence?.summary || "").trim() : summarizeFile(path.join(jobDir, "result.md"), 500).trim();
    const changed = hostTransport ? (job.inlineEvidence?.changedFiles || []).join(", ") : summarizeFile(path.join(jobDir, "changed-files.txt"), 250).trim();
    const tests = hostTransport ? String(job.inlineEvidence?.testSummary || "").trim() : summarizeFile(path.join(jobDir, "test-output-summary.md"), 250).trim();
    const verificationEvidence = hostTransport ? null : readJsonFile(path.join(jobDir, "verification-evidence.json"), null);
    const telemetry = hostTransport ? null : readJsonFile(path.join(jobDir, "worker-telemetry.json"), null);
    lines.push(`${index + 1}. ${job.laneId || job.toolName} | ${job.state} | ${job.jobId} | model=${job.model || "default"}`);
    lines.push(`   Assigned: ${(job.assignedTasks || []).join(", ") || "unspecified"}`);
    if (job.blocker && !supersededByCodex) lines.push(`   Blocker: ${truncateText(job.blocker, 300)}`);
    if (job.warning && !supersededBySuccess && !supersededByCodex) lines.push(`   Warning: ${truncateText(job.warning, 300)}`);
    if (telemetry) lines.push(`   Telemetry: model=${telemetry.observedModel || "unknown"}; durationSec=${Number.isFinite(Number(telemetry.durationMs)) ? Math.round(Number(telemetry.durationMs) / 1000) : "unknown"}; outputTokens=${telemetry.outputTokens ?? "unknown"}; category=${telemetry.failureCategory || "none"}`);
    if (verificationEvidence) lines.push(`   BridgeVerification: state=${verificationEvidence.state || "unknown"}; required=${verificationEvidence.required === true}; checks=${verificationEvidence.checks?.length || 0}; workspaceMutation=${verificationEvidence.workspaceMutationDetected === true}`);
    if (["queued", "running", "unknown"].includes(job.state)) {
      const started = Date.parse(String(job.startedAt || job.createdAt || ""));
      const elapsed = Number.isFinite(started) ? Math.max(0, Math.round((Date.now() - started) / 1000)) : "unknown";
      lines.push(`   Activity: started=${job.startedAt || job.createdAt || "unknown"}; elapsedSec=${elapsed}; step=${job.currentStep || "worker-active"}`);
    }
    if (supersededBySuccess) lines.push("   Recovered: a later failover completed this work item; use read-job only if the failed attempt needs diagnosis.");
    if (supersededByCodex) lines.push("   Recovered: the current Codex session explicitly took over and completed this work item with recorded evidence.");
    if (result && !supersededBySuccess && !supersededByCodex) lines.push(`   Result: ${result.replace(/\s*\n\s*/g, " ")}`);
    if (changed && !/^NONE$/i.test(changed) && !supersededBySuccess && !supersededByCodex) lines.push(`   Changed: ${changed.replace(/\s*\n\s*/g, ", ")}`);
    if (tests && !supersededBySuccess && !supersededByCodex) lines.push(`   WorkerAndBridgeSummary: ${tests.replace(/\s*\n\s*/g, " ")}`);
  }

  if (!graphIntegrity.valid && snapshot.state !== "completed" && !snapshot.termination?.category) lines.push(isContinuousManagement(snapshot)
    ? "Next: fail the malformed cycle and provide canonical nextWorkItems under this same run; do not replace or complete the root objective."
    : "Next: replace the malformed run contract with canonical work items; do not integrate, verify, or keep polling the damaged graph.");
  else if (snapshot.termination?.category) lines.push(Number(snapshot.termination?.cancellationUnconfirmed || 0) > 0
    ? "Next: execute HostCodexCancellationActions and acknowledge the result. Do not start a replacement run while any host worker stop remains unconfirmed."
    : "Next: this run is stopped. Apply the latest user constraints and start a new objective run only if the user still wants continuation.");
  else if (!isContinuousManagement(snapshot) && snapshot.finalVerification?.passed === false) lines.push("Next: final verification failed. Resolve the recorded blocker and continue or re-verify this objective; completion is not allowed.");
  else if (snapshot.state === "ready-for-codex") lines.push((snapshot.workItems || []).some((item) => ["host-dispatch-required", "host-reserved"].includes(item.state))
    ? "Next: acknowledge HostCodexReservationActions before spawning. Spawn only the returned HostCodexActions, then bind the returned agent id with hostWorkerEvents. The parent control-room task must not perform those tasks itself."
    : isContinuousManagement(snapshot)
      ? (["verified", "failed"].includes(snapshot.activeCycle?.state)
        ? "Next: pass nextWorkItems to project-manager-status for the next delivery cycle in this same run. The root objective and Codex Goal remain active."
        : "Next: record cycleVerified/cycleVerificationFailed and pass nextWorkItems. Continuous-management forbids projectVerified and Goal completion.")
      : snapshot.managerOnly === true
      ? "Next: the manager must review the compact artifacts and recorded verification evidence, request one bounded correction if needed, then call project-manager-status with projectVerified=true. Do not rerun project work in this chat."
      : "Next: Codex must critique and integrate the compact artifacts, run targeted final verification, then call project-manager-status with projectVerified=true. Completion is not yet allowed.");
  else if (snapshot.state === "completed") lines.push("Next: this finite objective is verified complete. Do not invent more work after its acceptance gates pass.");
  else if (snapshot.state === "running") lines.push(`Next: call project-manager-status once with waitSeconds=120 for ${workspace}; completion is not yet allowed.`);
  else lines.push("Next: inspect only failed/partial jobs with read-job, reassign their narrow lanes, and do not claim team completion.");
  return lines.join("\n");
}

async function readTeamRun(args = {}) {
  const workspace = safeWorkspacePath(args.workspace);
  const waitSeconds = Math.max(0, Math.min(300, Number(args.waitSeconds || 0)));
  const checkpointSnapshot = await refreshCapacityCheckpoint(workspace);
  let snapshot = await waitForTeamRun(workspace, waitSeconds, checkpointSnapshot);
  if (shouldRunOrchestrationSupervisor(snapshot)) snapshot = ensureOrchestrationSupervisor(workspace, snapshot);
  const output = formatTeamRunSnapshot(workspace, snapshot, waitSeconds);
  writeTextFileEnsuringDir(path.join(bridgeRootFor(workspace), "last-team-run.md"), `${output}\n`);
  return output;
}

async function orchestrateProject(args = {}) {
  args = applyLocalRuntimePolicy(normalizeManagerOnly(args));
  const workspace = safeWorkspacePath(args.workspace);
  const goal = String(args.goal || "").trim();
  if (!goal) throw new Error("orchestrate-project requires a non-empty goal.");
  const context = await getTeamCapacityContext({ ...args, workspace });
  const decision = buildResourceOrchestrationDecision(args, context);
  const plan = formatTeamOrchestrationPlan(args, context);
  const controls = normalizedRunControls(args);
  const constraints = normalizedRunConstraints(args);
  const acceptanceCriteria = boundedTextList(args.acceptanceCriteria, 12, 400);
  const verification = boundedTextList(args.verification, 12, 400);
  const routingPolicy = routingPolicyFromArgs(args);
  const completionPolicy = completionPolicyFrom(args);

  if (args.start === false) {
    return [
      plan,
      "",
      "OrchestrateProjectResult:",
      "Started: false",
      "Reason: start=false; inventory, work graph, and resource decisions were returned without dispatch.",
    ].join("\n");
  }

  const runId = `orc-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
  const createdAt = utcStamp();
  const initialCycleId = completionPolicy === "continuous-management" ? "cycle-1" : "";
  const stagedWorkItems = decision.workItems.map((item) => ({
    ...item,
    ...(initialCycleId ? { cycleId: initialCycleId } : {}),
    state: item.assignment === "codex:current"
      ? (item.dependsOn.length ? "codex-pending" : "codex")
      : item.assignment.startsWith("codex-host:")
        ? (item.dependsOn.length ? "host-pending" : "host-dispatch-required")
        : "pending",
  }));
  const capsule = writeContextCapsule({
    goal,
    workspace,
    lifecycleStage: "execute",
    workItems: stagedWorkItems,
    constraints,
    acceptanceCriteria,
    verification,
    continuitySummary: args.continuitySummary,
    artifactRefs: args.artifactRefs,
  });
  const workItems = stagedWorkItems.map((item) => {
    if (!item.assignment.startsWith("codex-host:")) return item;
    const resource = decision.candidates.find((candidate) => candidate.id === item.assignment);
    const hostAction = resource ? chooseHostCodexAction([resource], item) : null;
    const taskCapsulePath = capsule.taskCapsules?.[item.id]?.path || capsule.outputPath;
    const attemptId = `host-${crypto.randomBytes(6).toString("hex")}`;
    const dispatchToken = crypto.randomBytes(18).toString("hex");
    return {
      ...item,
      hostAttempt: { attemptId, dispatchToken, state: "dispatch-required", createdAt: utcStamp() },
      hostAction: hostAction ? {
        toolName: hostAction.hostTool,
        agentType: item.readOnly ? "explorer" : "worker",
        model: hostAction.model,
        reasoningEffort: hostAction.reasoningEffort,
        forkContext: false,
        message: boundedWorkerPrompt(item, goal, taskCapsulePath),
      } : null,
    };
  });
  const manifest = {
    version: 2,
    runId,
    createdAt,
    deadlineAt: controls.runDeadlineMinutes > 0
      ? new Date(Date.now() + controls.runDeadlineMinutes * 60000).toISOString()
      : "",
    projectDurationMode: controls.runDeadlineMinutes > 0 ? "optional-deadline" : "continuous",
    nextCapacityCheckpointAt: new Date(Date.now() + capacityCheckpointDelayMinutes(controls, decision.candidates) * 60000).toISOString(),
    capacityCheckpointCount: 0,
    goal,
    rootGoal: goal,
    completionPolicy,
    cycleNumber: initialCycleId ? 1 : 0,
    cycles: [],
    activeCycle: initialCycleId ? cycleContract(args, workItems, 1) : null,
    workspace,
    mode: String(args.mode || "patch").trim().toLowerCase(),
    managerOnly: args.managerOnly === true,
    hostCodexAvailable: args.hostCodexAvailable === true,
    unattendedMode: args.unattendedMode === true,
    allowAntigravityPermissionBypass: args.allowAntigravityPermissionBypass === true,
    horizonHours: Math.max(1, Math.min(12, Number(args.horizonHours || 5))),
    ...controls,
    constraints,
    acceptanceCriteria,
    verification,
    routingPolicy,
    contextCapsulePath: capsule.outputPath,
    allowAntigravityCli: routingPolicy.allowAntigravityCli,
    capacityProbe: context.capacityProbe,
    codexRole: args.managerOnly === true
      ? "manager, capacity orchestrator, critic, user-boundary owner, and reporter"
      : "goal owner, resource orchestrator, critic, integration owner, and final verifier",
    primaryWriterId: decision.primaryWriterId,
    resources: decision.candidates,
    decisions: decision.decisions.map((item) => ({ at: utcStamp(), type: "assignment", ...item })),
    workItems,
    state: "running",
    jobs: ensureHostDispatchReservations(workItems, []),
  };
  withFileLock(lastTeamRunJsonPath(workspace), () => {
    const existingManifestPath = lastTeamRunJsonPath(workspace);
    if (fs.existsSync(existingManifestPath)) {
      const existing = refreshTeamRunManifest(workspace, readJsonFile(existingManifestPath, null), true);
      if (isActiveOrchestrationRun(existing)) {
        throw new Error(`Workspace already has active orchestration run ${existing.runId || "<legacy>"}. Use read-team-run or cancel its running jobs before starting another run.`);
      }
    }
    writeTeamRunManifest(workspace, manifest);
  });
  persistOrchestrationDecision(workspace, goal, decision);

  const waitSeconds = Math.max(0, Math.min(300, Number(args.waitSeconds ?? 30)));
  const supervisedManifest = ensureOrchestrationSupervisor(workspace, manifest);
  let snapshot = await waitForTeamRun(workspace, waitSeconds, supervisedManifest);
  if (shouldRunOrchestrationSupervisor(snapshot)) snapshot = ensureOrchestrationSupervisor(workspace, snapshot);
  const compactResult = formatTeamRunSnapshot(workspace, snapshot, waitSeconds);
  const output = [
    "OrchestrateProjectResult:",
    `RunId: ${runId}`,
    `Goal: ${goal}`,
    `CompletionPolicy: ${completionPolicy}`,
    `CapacityProbe: ${context.capacityProbe}`,
    `WorkItems: ${workItems.length}`,
    `ExternalResourcesSelected: ${[...new Set(workItems.filter((item) => !["codex:current", "resource:unavailable"].includes(item.assignment)).map((item) => item.assignment))].length}`,
    `WaitSeconds: ${waitSeconds}`,
    `ControlRoomMode: ${args.managerOnly === true ? "manager-only" : "manager-and-integrator"}`,
    args.managerOnly === true
      ? "CodexRole: inventory, assign, steer, review compact evidence, and report. Do not inspect project files, run project diagnostics/tests, edit source, or duplicate worker execution."
      : "CodexRole: understand, direct, critique, integrate, and verify; do not duplicate delegated broad work.",
    "",
    compactResult,
  ].join("\n");
  const finalOutput = args.includePlan === true ? `${plan}\n\n${output}` : output;
  writeTextFileEnsuringDir(path.join(bridgeRootFor(workspace), "last-team-run.md"), `${finalOutput}\n`);
  return finalOutput;
}

async function runProjectManager(args = {}) {
  const workspace = safeWorkspacePath(args.workspace);
  let effectiveArgs = normalizeManagerOnly({
    ...args,
    workspace,
    waitSeconds: args.waitSeconds === undefined ? 0 : args.waitSeconds,
    includePlan: args.includePlan === true,
  });
  const prior = readJsonFile(lastTeamRunJsonPath(workspace), null);
  if (prior && String(prior.goal || "").trim() === String(effectiveArgs.goal || "").trim()) {
    effectiveArgs = carryForwardSameGoalContract(effectiveArgs, args, prior);
  }
  try {
    return await orchestrateProject(effectiveArgs);
  } catch (error) {
    if (!/already has active orchestration run/i.test(String(error?.message || ""))) throw error;
    const existing = refreshTeamRunManifest(workspace, readJsonFile(lastTeamRunJsonPath(workspace), null));
    const goalChanged = String(existing.goal || "").trim() !== String(effectiveArgs.goal || "").trim();
    const expired = runDeadlineExpired(existing);
    if (!goalChanged) {
      effectiveArgs = carryForwardSameGoalContract(effectiveArgs, args, existing);
    }
    const contractChanges = goalChanged ? [] : runContractChanges(existing, effectiveArgs);
    const contractChanged = contractChanges.length > 0;
    if (isContinuousManagement(existing) && !expired && (goalChanged || contractChanged)) {
      const protectedResult = [
        "RunProjectManagerResult:",
        "ContinuousRootGoalProtected: true",
        "ReplacementStarted: false",
        `RootGoal: ${existing.rootGoal || existing.goal}`,
        goalChanged
          ? "Reason: a persistent control-room run already owns this workspace. A rephrased management prompt cannot replace or shrink its root goal."
          : `Reason: the continuous run contract changed (${contractChanges.join(", ")}); use project-manager-status cycle fields instead of replacing the run.`,
        "Next: verify the current cycle with cycleVerified/cycleVerificationFailed and pass nextWorkItems for the next bounded cycle in this same run. Use stopRun only for explicit user stop or a real root-goal change.",
        "",
        formatTeamRunSnapshot(workspace, existing, 0),
      ].join("\n");
      writeTextFileEnsuringDir(path.join(bridgeRootFor(workspace), "last-team-run.md"), `${protectedResult}\n`);
      return protectedResult;
    }
    if (goalChanged || expired || contractChanged) {
      const replacementReason = goalChanged
        ? "the user goal changed"
        : expired
          ? "the previous run deadline expired"
          : `the active run contract changed (${contractChanges.join(", ")})`;
      let stoppedManifest = null;
      withFileLock(lastTeamRunJsonPath(workspace), () => {
        const latest = refreshTeamRunManifest(workspace, readJsonFile(lastTeamRunJsonPath(workspace), existing), true);
        const stopped = terminateOrchestrationRun(
          workspace,
          latest,
          goalChanged
            ? `User supplied a different project goal; run ${latest.runId || "<legacy>"} was stopped before replanning.`
            : expired
              ? `Run ${latest.runId || "<legacy>"} reached its optional deadline and was stopped before replacement.`
              : `Run contract changed (${contractChanges.join(", ")}); run ${latest.runId || "<legacy>"} was stopped before replanning.`,
          expired ? "orchestration-deadline" : "user-steering",
        );
        writeTeamRunManifest(workspace, stopped);
        stoppedManifest = stopped;
      });
      if (Number(stoppedManifest?.termination?.cancellationUnconfirmed || 0) > 0 || Number(stoppedManifest?.termination?.supervisorStopUnconfirmed || 0) > 0) {
        const refusedReplacement = [
          "RunProjectManagerResult:",
          `ReplacedRunId: ${existing.runId || "<legacy>"}`,
          "ReplacementStarted: false",
          "Reason: at least one previous worker or supervisor process could not be confirmed stopped; a new run was refused to prevent overlapping work.",
          "",
          formatTeamRunSnapshot(workspace, stoppedManifest, 0),
        ].join("\n");
        writeTextFileEnsuringDir(path.join(bridgeRootFor(workspace), "last-team-run.md"), `${refusedReplacement}\n`);
        return refusedReplacement;
      }
      const replacement = await orchestrateProject(effectiveArgs);
      const replacementResult = [
        "RunProjectManagerResult:",
        `ReplacedRunId: ${existing.runId || "<legacy>"}`,
        `Reason: ${replacementReason}, so stale workers and the prior supervisor were stopped before a new objective run started.`,
        "",
        replacement,
      ].join("\n");
      writeTextFileEnsuringDir(path.join(bridgeRootFor(workspace), "last-team-run.md"), `${replacementResult}\n`);
      return replacementResult;
    }
    const status = await readTeamRun({ workspace, waitSeconds: effectiveArgs.waitSeconds });
    const reusedResult = [
      "RunProjectManagerResult:",
      "ReusedActiveRun: true",
      "Reason: this workspace already has the same active goal and run contract; duplicate dispatch was refused.",
      "",
      status,
    ].join("\n");
    writeTextFileEnsuringDir(path.join(bridgeRootFor(workspace), "last-team-run.md"), `${reusedResult}\n`);
    return reusedResult;
  }
}

function normalizedCodexEvidence(args = {}) {
  const evidence = new Map();
  for (const entry of Array.isArray(args.codexEvidence) ? args.codexEvidence : []) {
    if (!entry || typeof entry !== "object") continue;
    const workItemId = normalizeTaskLane(entry.workItemId);
    const summary = truncateText(redactArtifactContent(String(entry.summary || "").trim()), 1200);
    if (!workItemId || !summary) continue;
    evidence.set(workItemId, {
      summary,
      artifactRefs: (Array.isArray(entry.artifactRefs) ? entry.artifactRefs : [])
        .map((value) => truncateText(redactArtifactContent(String(value || "").trim()), 300))
        .filter(Boolean)
        .slice(0, 12),
      recordedAt: utcStamp(),
    });
  }
  return evidence;
}

function hostDispatchReservationJob(item) {
  return {
    toolName: item.hostAction?.toolName || "multi_agent_v1__spawn_agent",
    laneId: `native-${item.assignment}`,
    worker: "Codex native worker",
    resourceId: item.assignment,
    assignedTasks: [item.id],
    workItemIds: [item.id],
    model: item.assignedModel,
    jobId: item.hostAttempt.attemptId,
    transport: "host-subagent",
    state: "queued",
    agentId: "",
    reservedAt: utcStamp(),
  };
}

// Reserve a token-bound job entry the moment an item becomes host-dispatch-required, before any spawn
// happens, so terminateOrchestrationRun always has a target to cancel even if "started" is never acknowledged.
function ensureHostDispatchReservations(workItems, jobs) {
  const existingIds = new Set((jobs || []).map((job) => job.jobId));
  const reservations = (workItems || [])
    .filter((item) => ["host-dispatch-required", "host-reserved"].includes(item.state) && item.hostAttempt?.attemptId && !existingIds.has(item.hostAttempt.attemptId))
    .map(hostDispatchReservationJob);
  return reservations.length ? [...(jobs || []), ...reservations] : (jobs || []);
}

function prepareHostAssignedItem(manifest, item, resource, state = "host-dispatch-required") {
  if (resource?.dispatchMode !== "host-subagent") return { ...item, state };
  const hostAction = chooseHostCodexAction([resource], item);
  const capsulePath = path.join(bridgeRootFor(manifest.workspace), "orchestrator", "task-capsules", `${item.id}.json`);
  return {
    ...item,
    state,
    hostAttempt: {
      attemptId: `host-${crypto.randomBytes(6).toString("hex")}`,
      dispatchToken: crypto.randomBytes(18).toString("hex"),
      state: "dispatch-required",
      createdAt: utcStamp(),
    },
    hostAction: hostAction ? {
      toolName: hostAction.hostTool,
      agentType: item.readOnly ? "explorer" : "worker",
      model: hostAction.model,
      reasoningEffort: hostAction.reasoningEffort,
      forkContext: false,
      message: boundedWorkerPrompt(item, manifest.goal, fs.existsSync(capsulePath) ? capsulePath : manifest.contextCapsulePath),
    } : null,
  };
}

function recordNativeCodexOutcome(workspace, item, success) {
  const resourceId = String(item?.assignment || "");
  if (!resourceId.startsWith("codex-host:")) return;
  const now = utcStamp();
  mutateWorkspaceResourceState(workspace, (state) => {
    const previous = state.outcomes?.[resourceId] || {};
    const successfulKinds = success
      ? [...(Array.isArray(previous.successfulKinds) ? previous.successfulKinds : []), item.kind].filter(Boolean).slice(-5)
      : (Array.isArray(previous.successfulKinds) ? previous.successfulKinds : []).slice(-5);
    const outcome = {
      ...previous,
      lastState: success ? "available" : "cooldown",
      lastCategory: success ? "" : "worker-failure",
      lastSuccessAt: success ? now : String(previous.lastSuccessAt || ""),
      lastFailureAt: success ? String(previous.lastFailureAt || "") : now,
      cooldownUntil: success ? "" : new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      observedModel: String(item.assignedModel || previous.observedModel || ""),
      recentKinds: successfulKinds,
      successfulKinds,
      successCount: Math.max(0, Number(previous.successCount || 0)) + (success ? 1 : 0),
      failureCount: Math.max(0, Number(previous.failureCount || 0)) + (success ? 0 : 1),
      consecutiveFailures: success ? 0 : Math.max(0, Number(previous.consecutiveFailures || 0)) + 1,
    };
    return { ...state, outcomes: { ...(state.outcomes || {}), [resourceId]: outcome } };
  });
}

function applyHostWorkerEvents(manifest, args = {}) {
  const events = Array.isArray(args.hostWorkerEvents) ? args.hostWorkerEvents : [];
  let next = { ...manifest, workItems: [...(manifest.workItems || [])], jobs: [...(manifest.jobs || [])] };
  for (const raw of events) {
    const event = String(raw?.event || "").trim().toLowerCase();
    const workItemId = normalizeTaskLane(raw?.workItemId);
    const target = next.workItems.find((item) => item.id === workItemId);
    if (String(raw?.runId || "") !== String(next.runId || "")) throw new Error(`Host worker event runId does not match active run ${next.runId}.`);
    if (!target || !String(target.assignment || "").startsWith("codex-host:")) throw new Error(`Host worker event references unknown native Codex item: ${workItemId}`);
    if (String(raw?.attemptId || "") !== String(target.hostAttempt?.attemptId || "")
      || String(raw?.dispatchToken || "") !== String(target.hostAttempt?.dispatchToken || "")) {
      throw new Error(`Host worker event token does not match ${workItemId}.`);
    }
    const existingJob = next.jobs.find((job) => job.transport === "host-subagent" && job.jobId === target.hostAttempt.attemptId);
    const agentId = truncateText(String(raw?.agentId || existingJob?.agentId || "").trim(), 160);
    if (existingJob?.agentId && agentId && existingJob.agentId !== agentId) throw new Error(`Host worker event agentId does not match ${workItemId}.`);

    if (event === "reserved") {
      if (agentId) throw new Error(`Host worker reservation must precede spawn for ${workItemId}.`);
      if (target.state === "host-reserved" && existingJob?.state === "queued") continue;
      if (target.state !== "host-dispatch-required" || !existingJob || existingJob.state !== "queued") {
        throw new Error(`Host worker ${workItemId} is not awaiting a pre-spawn reservation.`);
      }
      const reservedAt = utcStamp();
      next.workItems = next.workItems.map((item) => item.id === workItemId
        ? { ...item, state: "host-reserved", activeJobId: existingJob.jobId, hostAttempt: { ...item.hostAttempt, state: "reserved", reservedAt } }
        : item);
      next = appendOrchestrationDecision(next, { type: "host-codex-reserved", workItemId, attemptId: existingJob.jobId, resourceId: target.assignment });
      continue;
    }

    if (event === "started") {
      if (!agentId) throw new Error(`Host worker started event requires agentId for ${workItemId}.`);
      if (existingJob && ["running", "completed"].includes(existingJob.state)) continue;
      const cancelledBeforeStart = target.state === "host-cancel-required" && existingJob?.state === "unknown";
      if (existingJob && existingJob.state !== "queued" && !cancelledBeforeStart) {
        throw new Error(`Host worker attempt ${target.hostAttempt.attemptId} already has terminal state ${existingJob.state}.`);
      }
      if (target.state !== "host-reserved" && !cancelledBeforeStart) throw new Error(`Work item ${workItemId} must be reserved before host spawn.`);
      const startedAt = utcStamp();
      const nickname = truncateText(String(raw?.nickname || "").trim(), 80);
      const jobId = target.hostAttempt.attemptId;
      // Bind the pre-spawn reservation in place when present; only a manifest predating reservations falls back to inserting fresh.
      next.jobs = existingJob
        ? next.jobs.map((job) => job.jobId === jobId ? { ...job, state: "running", agentId, nickname, startedAt } : job)
        : [...next.jobs, { ...hostDispatchReservationJob(target), state: "running", agentId, nickname, startedAt }];
      next.workItems = next.workItems.map((item) => item.id === workItemId
        ? { ...item, state: cancelledBeforeStart ? "host-cancel-required" : "host-running", activeJobId: jobId, hostAgent: { agentId, nickname, startedAt }, hostAttempt: { ...item.hostAttempt, state: cancelledBeforeStart ? "cancellation-pending" : "running", acknowledgedAt: utcStamp() } }
        : item);
      next = appendOrchestrationDecision(next, { type: cancelledBeforeStart ? "host-codex-started-after-cancellation" : "host-codex-started", workItemId, attemptId: jobId, agentId, resourceId: target.assignment });
      continue;
    }

    const cancelledBeforeStart = target.state === "host-cancel-required" && existingJob?.state === "unknown";
    if (!existingJob || (existingJob.state === "queued" && !cancelledBeforeStart) || (existingJob.state === "unknown" && !cancelledBeforeStart)) throw new Error(`Host worker ${event} event has no acknowledged start for ${workItemId}.`);
    if (["completed", "failed", "cancelled"].includes(existingJob.state)) {
      if (existingJob.state === event || (event === "cancellation-unconfirmed" && existingJob.state === "cancelled")) continue;
      throw new Error(`Host worker attempt ${existingJob.jobId} is already ${existingJob.state}.`);
    }

    if (event === "completed") {
      const summary = truncateText(redactArtifactContent(String(raw?.summary || "").trim()), 1600);
      const artifactRefs = boundedTextList(raw?.artifactRefs, 12, 300);
      const changedFiles = boundedTextList(raw?.changedFiles, 20, 300);
      const testSummary = truncateText(redactArtifactContent(String(raw?.testSummary || "").trim()), 800);
      if (summary.length < 12) throw new Error(`Host worker completion requires a compact summary for ${workItemId}.`);
      if (!target.readOnly && (!changedFiles.length || testSummary.length < 3)) {
        throw new Error(`Host writer completion requires changedFiles and testSummary for ${workItemId}.`);
      }
      const hostEvidence = { summary, artifactRefs, changedFiles, testSummary, recordedAt: utcStamp() };
      next.jobs = next.jobs.map((job) => job.jobId === existingJob.jobId
        ? { ...job, state: "completed", completedAt: utcStamp(), observedModel: truncateText(String(raw?.observedModel || target.assignedModel), 160), inlineEvidence: hostEvidence }
        : job);
      next.workItems = next.workItems.map((item) => item.id === workItemId
        ? { ...item, state: "completed", hostEvidence, blocker: "", failureCategory: "", hostAttempt: { ...item.hostAttempt, state: "completed", completedAt: utcStamp() } }
        : item);
      next = appendOrchestrationDecision(next, { type: "host-codex-completed", workItemId, attemptId: existingJob.jobId, resourceId: target.assignment });
      continue;
    }

    if (["failed", "cancelled", "cancellation-unconfirmed"].includes(event)) {
      const failureCategory = normalizeTaskLane(raw?.failureCategory || (event === "cancelled" ? "cancelled" : event === "cancellation-unconfirmed" ? "cancellation-unconfirmed" : "worker-failure"));
      const state = event === "cancellation-unconfirmed" ? "unknown" : event;
      next.jobs = next.jobs.map((job) => job.jobId === existingJob.jobId
        ? { ...job, state, failureCategory, blocker: truncateText(String(raw?.summary || `Native Codex worker ${event}.`), 500), completedAt: event === "cancellation-unconfirmed" ? "" : utcStamp() }
        : job);
      next.workItems = next.workItems.map((item) => item.id === workItemId
        ? { ...item, state: event === "cancellation-unconfirmed" ? "host-cancel-required" : event, blocker: truncateText(String(raw?.summary || `Native Codex worker ${event}.`), 500), failureCategory }
        : item);
      if (next.termination && ["cancelled", "failed"].includes(event)) {
        next.termination = {
          ...next.termination,
          cancelledWorkers: Number(next.termination.cancelledWorkers || 0) + 1,
          cancellationUnconfirmed: Math.max(0, Number(next.termination.cancellationUnconfirmed || 0) - 1),
        };
      }
      next = appendOrchestrationDecision(next, { type: `host-codex-${event}`, workItemId, attemptId: existingJob.jobId, resourceId: target.assignment });
      continue;
    }
    throw new Error(`Unsupported host worker event: ${event}`);
  }
  next.counts = {
    total: next.jobs.length,
    completed: next.jobs.filter((job) => job.state === "completed").length,
    running: next.jobs.filter((job) => ["queued", "running", "unknown"].includes(job.state)).length,
    failed: next.jobs.filter((job) => ["failed", "cancelled"].includes(job.state)).length,
  };
  next.state = deriveOrchestrationState(next);
  return next;
}

function applyProjectManagerUpdates(manifest, args = {}) {
  const completed = new Set((args.completedCodexItems || []).map(normalizeTaskLane).filter(Boolean));
  const failed = new Set((args.failedCodexItems || []).map(normalizeTaskLane).filter(Boolean));
  const takeover = new Set((args.takeoverCodexItems || []).map(normalizeTaskLane).filter(Boolean));
  const evidence = normalizedCodexEvidence(args);
  let next = { ...manifest, workItems: [...(manifest.workItems || [])] };
  let codexActionChanged = false;
  const knownIds = new Set(next.workItems.map((item) => item.id));
  for (const id of [...completed, ...failed, ...takeover]) {
    if (!knownIds.has(id)) throw new Error(`Unknown project-manager work item: ${id}`);
  }

  for (const id of takeover) {
    const target = next.workItems.find((item) => item.id === id);
    if (next.managerOnly === true) {
      throw new Error(`Manager-only mode refuses current-Codex takeover of ${id}. Reassign or rescope the bounded worker item instead.`);
    }
    if (target.state === "running") throw new Error(`Work item ${id} is still running. Cancel its active worker before Codex takeover.`);
    if (target.state === "completed") continue;
    const byId = new Map(next.workItems.map((item) => [item.id, item]));
    const dependenciesComplete = (target.dependsOn || []).every((dependencyId) => byId.get(dependencyId)?.state === "completed");
    const previousAssignment = target.assignment;
    next.workItems = next.workItems.map((item) => item.id === id
      ? {
          ...item,
          assignment: "codex:current",
          assignedModel: String(args.codexModel || next.resources?.find((resource) => resource.id === "codex:current")?.model || "current Codex session"),
          state: dependenciesComplete ? "codex" : "codex-pending",
          blocker: "",
          failureCategory: "",
          alternates: [],
          activeJobId: "",
          decisionReason: `Explicit current-Codex takeover from ${previousAssignment || "unassigned"}.`,
        }
      : item);
    if (!target.readOnly) next.primaryWriterId = "codex:current";
    next = appendOrchestrationDecision(next, { type: "codex-takeover", workItemId: id, from: previousAssignment || "unassigned", to: "codex:current" });
  }

  for (const id of completed) {
    const target = next.workItems.find((item) => item.id === id);
    const itemEvidence = evidence.get(id);
    if (!itemEvidence || itemEvidence.summary.length < 12) {
      throw new Error(`Work item ${id} requires compact codexEvidence before it can be completed.`);
    }
    if (target.state === "completed") {
      const priorRefs = boundedTextList(target.codexEvidence?.artifactRefs, 12, 300);
      const nextRefs = boundedTextList(itemEvidence.artifactRefs, 12, 300);
      if (target.codexEvidence?.summary === itemEvidence.summary && JSON.stringify(priorRefs) === JSON.stringify(nextRefs)) continue;
      throw new Error(`Codex completion evidence is immutable for ${id}; refresh status instead of rewriting an accepted result.`);
    }
    if (target.state !== "codex") throw new Error(`Work item ${id} is not ready for Codex completion. Wait for dependencies or take it over first.`);
    next.workItems = next.workItems.map((item) => item.id === id
      ? { ...item, state: "completed", blocker: "", failureCategory: "", codexEvidence: itemEvidence }
      : item);
    codexActionChanged = true;
  }

  for (const id of failed) {
    const target = next.workItems.find((item) => item.id === id);
    if (target.state === "blocked" && target.blocker === "Current Codex could not complete this owned action.") continue;
    if (target.state !== "codex") throw new Error(`Work item ${id} is not an active Codex-owned action.`);
    next.workItems = next.workItems.map((item) => item.id === id
      ? { ...item, state: "blocked", blocker: "Current Codex could not complete this owned action." }
      : item);
    codexActionChanged = true;
  }

  if (codexActionChanged) {
    next = appendOrchestrationDecision(next, {
      type: "codex-action-update",
      completed: [...completed],
      failed: [...failed],
    });
  }

  if (args.cycleVerified === true && args.cycleVerificationFailed === true) {
    throw new Error("cycleVerified and cycleVerificationFailed cannot both be true.");
  }
  if (args.cycleVerified === true || args.cycleVerificationFailed === true) {
    if (!isContinuousManagement(next)) {
      throw new Error("Cycle verification is only valid for completionPolicy=continuous-management. Use project verification for a finite objective.");
    }
    const activeCycle = next.activeCycle || cycleContract({ cycleObjective: "Legacy continuous delivery cycle." }, next.workItems, Math.max(1, Number(next.cycleNumber || 1)));
    const passed = args.cycleVerified === true;
    const summary = truncateText(redactArtifactContent(String(args.cycleVerificationSummary || "").trim()), 1600);
    if (summary.length < 20) throw new Error("cycleVerificationSummary is required for a cycle verification result.");
    const alreadyRecorded = ["verified", "failed"].includes(activeCycle.state);
    if (alreadyRecorded) {
      if (activeCycle.passed === passed && String(activeCycle.summary || "") === summary) {
        // An exact retry is idempotent. Continue through the remaining guards so
        // a combined request cannot bypass the continuous completion firewall.
      } else {
        throw new Error(`Cycle result is immutable: ${activeCycle.id} is already ${activeCycle.state}. Refresh status before taking another lifecycle action.`);
      }
    }
    if (!alreadyRecorded && activeCycle.state !== "running") {
      throw new Error(`Cycle verification requires a running cycle; ${activeCycle.id} is ${activeCycle.state || "unknown"}.`);
    }
    if (!alreadyRecorded) {
      const cycleIds = new Set(activeCycle.itemIds || next.workItems.map((item) => item.id));
      const cycleItems = next.workItems.filter((item) => cycleIds.has(item.id));
      const incomplete = cycleItems.filter((item) => passed
        ? item.state !== "completed"
        : ["running", "pending", "codex", "codex-pending", "host-pending", "host-running", "host-dispatch-required", "host-reserved", "host-cancel-required"].includes(item.state));
      if (incomplete.length) {
        throw new Error(`Cycle verification cannot finish while cycle work remains active or incomplete: ${incomplete.map((item) => item.id).join(", ")}`);
      }
      const verifiedCycle = {
        ...activeCycle,
        state: passed ? "verified" : "failed",
        passed,
        summary,
        verifiedAt: utcStamp(),
        evidenceArchive: compactCycleEvidence(activeCycle, next.workItems, next.jobs),
      };
      next.activeCycle = verifiedCycle;
      next.cycles = [...(next.cycles || []).filter((cycle) => cycle.id !== verifiedCycle.id), verifiedCycle].slice(-50);
      next.finalVerification = null;
      next = appendOrchestrationDecision(next, { type: "cycle-verification", cycleId: verifiedCycle.id, passed });
    }
  }

  if (args.projectVerified === true && args.projectVerificationFailed === true) {
    throw new Error("projectVerified and projectVerificationFailed cannot both be true.");
  }
  if (args.projectVerified === true || args.projectVerificationFailed === true) {
    if (isContinuousManagement(next)) {
      throw new Error("Continuous-management completion firewall: projectVerified/projectVerificationFailed cannot close the root objective or Codex Goal. Record cycleVerified/cycleVerificationFailed, then continue with nextWorkItems in the same run. Only explicit user stop may end this control room.");
    }
    const incomplete = next.workItems.filter((item) => item.state !== "completed").map((item) => item.id);
    if (incomplete.length) throw new Error(`Project verification cannot finish while work items are incomplete: ${incomplete.join(", ")}`);
    const summary = truncateText(redactArtifactContent(String(args.projectVerificationSummary || "").trim()), 1600);
    if (summary.length < 20) throw new Error("projectVerificationSummary is required for a final verification result.");
    const passed = args.projectVerified === true;
    next.finalVerification = { passed, summary, verifiedAt: utcStamp() };
    next = appendOrchestrationDecision(next, { type: "project-verification", passed });
  }

  next.state = deriveOrchestrationState(next);
  return next;
}

function nextCyclePlanningArgs(manifest, args, workspace) {
  const cycleNumber = Math.max(1, Number(manifest.cycleNumber || manifest.activeCycle?.number || 1)) + 1;
  const cyclePrefix = `c${cycleNumber}-`;
  const idMap = new Map();
  const rawItems = (args.nextWorkItems || []).flat(1).filter((item) => item && typeof item === "object" && !Array.isArray(item));
  for (let index = 0; index < rawItems.length; index += 1) {
    const sourceId = normalizeTaskLane(rawItems[index].id || `work-${index + 1}`) || `work-${index + 1}`;
    idMap.set(sourceId, sourceId.startsWith(cyclePrefix) ? sourceId : `${cyclePrefix}${sourceId}`);
  }
  const workItems = rawItems.map((item, index) => {
    const sourceId = normalizeTaskLane(item.id || `work-${index + 1}`) || `work-${index + 1}`;
    return {
      ...item,
      id: idMap.get(sourceId),
      dependsOn: (Array.isArray(item.dependsOn) ? item.dependsOn : [])
        .map((dependency) => idMap.get(normalizeTaskLane(dependency)))
        .filter(Boolean),
    };
  });
  const routing = manifest.routingPolicy || {};
  return {
    goal: manifest.rootGoal || manifest.goal,
    workspace,
    workItems,
    managerOnly: manifest.managerOnly === true,
    completionPolicy: "continuous-management",
    mode: "patch",
    horizonHours: manifest.horizonHours || 5,
    constraints: manifest.constraints || [],
    acceptanceCriteria: manifest.acceptanceCriteria || [],
    verification: manifest.verification || [],
    cycleObjective: args.nextCycleObjective,
    cycleAcceptanceCriteria: args.nextCycleAcceptanceCriteria,
    cycleVerification: args.nextCycleVerification,
    hostCodexAvailable: manifest.hostCodexAvailable === true || routing.hostCodexAvailable === true,
    allowAntigravityCli: routing.allowAntigravityCli === true || manifest.allowAntigravityCli === true,
    unattendedMode: routing.unattendedMode === true || manifest.unattendedMode === true,
    allowAntigravityPermissionBypass: routing.allowAntigravityPermissionBypass === true || manifest.allowAntigravityPermissionBypass === true,
    allowPremiumModels: routing.allowPremiumModels === true,
    agyModel: routing.agyModel || "auto",
    claudeModel: routing.claudeModel || "auto",
    includeCursor: routing.includeCursor === true,
    runDeadlineMinutes: manifest.runDeadlineMinutes || 0,
    capacityCheckpointMinutes: manifest.capacityCheckpointMinutes || 20,
    codexManagerReservePercent: manifest.codexManagerReservePercent || 15,
    maxConcurrentCodexWorkers: manifest.maxConcurrentCodexWorkers || 1,
    maxParallelWriters: manifest.maxParallelWriters || 2,
    maxWorkerMinutes: manifest.maxWorkerMinutes || 0,
    maxClaudeOutputTokens: manifest.maxClaudeOutputTokens || 12000,
    maxClaudeBudgetUsd: manifest.maxClaudeBudgetUsd || 0,
    refreshInventory: args.refreshInventory === true,
  };
}

function appendContinuousCycle(manifest, args, decision, workspace) {
  if (!isContinuousManagement(manifest)) throw new Error("nextWorkItems requires completionPolicy=continuous-management.");
  if (manifest.termination?.category) throw new Error("A terminated run cannot accept another cycle. Start a new root objective only after explicit user direction.");
  const activeJobs = (manifest.jobs || []).filter((job) => ["queued", "running", "unknown"].includes(job.state));
  if (activeJobs.length) throw new Error(`The current cycle still has active workers: ${activeJobs.map((job) => job.jobId).join(", ")}`);
  if (!manifest.activeCycle || !["verified", "failed"].includes(manifest.activeCycle.state)) {
    throw new Error("Verify or fail the current cycle with cycleVerified/cycleVerificationFailed before passing nextWorkItems.");
  }
  if (!decision?.workItems?.length) throw new Error("nextWorkItems must contain at least one canonical work item.");

  const cycleNumber = Math.max(1, Number(manifest.cycleNumber || manifest.activeCycle.number || 1)) + 1;
  const cycleId = `cycle-${cycleNumber}`;
  const stagedItems = decision.workItems.map((item) => ({
    ...item,
    cycleId,
    state: item.assignment === "codex:current"
      ? (item.dependsOn.length ? "codex-pending" : "codex")
      : item.assignment.startsWith("codex-host:")
        ? (item.dependsOn.length ? "host-pending" : "host-dispatch-required")
        : "pending",
  }));
  const capsule = writeContextCapsule({
    goal: manifest.rootGoal || manifest.goal,
    workspace,
    lifecycleStage: `continuous-cycle-${cycleNumber}`,
    workItems: stagedItems,
    constraints: manifest.constraints || [],
    acceptanceCriteria: manifest.acceptanceCriteria || [],
    verification: manifest.verification || [],
    continuitySummary: args.cycleVerificationSummary || manifest.activeCycle.summary || "",
  });
  const workItems = stagedItems.map((item) => {
    if (!item.assignment.startsWith("codex-host:")) return item;
    const resource = decision.candidates.find((candidate) => candidate.id === item.assignment);
    const hostAction = resource ? chooseHostCodexAction([resource], item) : null;
    const taskCapsulePath = capsule.taskCapsules?.[item.id]?.path || capsule.outputPath;
    const attemptId = `host-${crypto.randomBytes(6).toString("hex")}`;
    const dispatchToken = crypto.randomBytes(18).toString("hex");
    return {
      ...item,
      hostAttempt: { attemptId, dispatchToken, state: "dispatch-required", createdAt: utcStamp() },
      hostAction: hostAction ? {
        toolName: hostAction.hostTool,
        agentType: item.readOnly ? "explorer" : "worker",
        model: hostAction.model,
        reasoningEffort: hostAction.reasoningEffort,
        forkContext: false,
        message: boundedWorkerPrompt(item, manifest.rootGoal || manifest.goal, taskCapsulePath),
      } : null,
    };
  });
  let next = {
    ...manifest,
    rootGoal: manifest.rootGoal || manifest.goal,
    completionPolicy: "continuous-management",
    cycleNumber,
    activeCycle: cycleContract({
      nextCycleObjective: args.nextCycleObjective,
      nextCycleAcceptanceCriteria: args.nextCycleAcceptanceCriteria,
      nextCycleVerification: args.nextCycleVerification,
    }, workItems, cycleNumber),
    resources: decision.candidates,
    primaryWriterId: decision.primaryWriterId,
    contextCapsulePath: capsule.outputPath,
    workItems,
    jobs: ensureHostDispatchReservations(workItems, []),
    counts: { total: 0, completed: 0, running: 0, failed: 0 },
    finalVerification: null,
    supervisorPid: 0,
    supervisorEndedAt: "",
    supervisorLastState: "",
    state: "running",
  };
  for (const assignment of decision.decisions || []) {
    next = appendOrchestrationDecision(next, { type: "cycle-assignment", cycleId, ...assignment });
  }
  next = appendOrchestrationDecision(next, { type: "cycle-start", cycleId, objective: next.activeCycle.objective });
  return next;
}

async function projectManagerStatus(args = {}) {
  const workspace = safeWorkspacePath(args.workspace);
  const wantsNextCycle = Array.isArray(args.nextWorkItems) && args.nextWorkItems.length > 0;
  const wantsCycleResult = args.cycleVerified === true || args.cycleVerificationFailed === true;
  const wantsCycleTransition = wantsCycleResult || wantsNextCycle;
  let nextCycleDecision = null;
  const expectedCycleTransition = {
    runId: String(args.expectedRunId || "").trim(),
    cycleId: String(args.expectedCycleId || "").trim(),
  };
  let expectedCycleRevision = null;
  if (wantsCycleTransition) {
    const preview = refreshTeamRunManifest(workspace, readJsonFile(lastTeamRunJsonPath(workspace), null));
    assertCycleTransitionIdentity(preview, expectedCycleTransition);
    expectedCycleRevision = cycleTransitionRevision(preview);
    if (wantsNextCycle && !wantsCycleResult && !["verified", "failed"].includes(expectedCycleRevision.state)) {
      throw new Error(`nextWorkItems cannot start while ${expectedCycleRevision.cycleId} is ${expectedCycleRevision.state}. Record cycleVerified or cycleVerificationFailed in the same request, or refresh after the cycle reaches a terminal checkpoint.`);
    }
    if (wantsNextCycle) {
      const planningArgs = nextCyclePlanningArgs(preview, args, workspace);
      const context = await getTeamCapacityContext(planningArgs);
      nextCycleDecision = buildResourceOrchestrationDecision(planningArgs, context);
    }
  }
  const addConstraints = boundedTextList(args.addConstraints, 20, 600);
  const steeringDirective = truncateText(redactArtifactContent(String(args.steeringDirective || "").trim()), 1000);
  const hasSteering = addConstraints.length > 0 || Boolean(steeringDirective) || args.stopRun === true;
  if (args.stopRun === true && !String(args.stopReason || steeringDirective).trim()) {
    throw new Error("stopReason or steeringDirective is required when stopRun=true.");
  }
  const hasUpdates = ["completedCodexItems", "failedCodexItems", "takeoverCodexItems", "codexEvidence", "hostWorkerEvents"]
    .some((key) => Array.isArray(args[key]) && args[key].length)
    || args.projectVerified === true
    || args.projectVerificationFailed === true
    || args.cycleVerified === true
    || args.cycleVerificationFailed === true
    || wantsNextCycle
    || hasSteering;
  if (hasUpdates) {
    let updatedManifest = null;
    withFileLock(lastTeamRunJsonPath(workspace), () => {
      let manifest = refreshTeamRunManifest(workspace, readJsonFile(lastTeamRunJsonPath(workspace), null), true);
      if (wantsCycleTransition) assertCycleTransitionRevision(manifest, expectedCycleRevision);
      if (hasSteering) {
        manifest = {
          ...manifest,
          constraints: boundedTextList([...(manifest.constraints || []), ...addConstraints], 20, 600),
        };
        manifest = appendOrchestrationDecision(manifest, {
          type: "user-steering",
          directive: steeringDirective || String(args.stopReason || "Constraints updated."),
          addedConstraints: addConstraints,
        });
        const interrupt = args.stopRun === true
          || args.interruptRunningWorkers !== false;
        if (interrupt) {
          const reason = String(args.stopReason || steeringDirective || `User constraints changed: ${addConstraints.join(" | ")}`);
          manifest = terminateOrchestrationRun(workspace, manifest, reason, "user-steering");
        } else {
          const capsule = writeContextCapsule({
            goal: manifest.goal,
            workspace,
            lifecycleStage: "execute",
            workItems: manifest.workItems,
            constraints: manifest.constraints,
            acceptanceCriteria: manifest.acceptanceCriteria,
            verification: manifest.verification,
          });
          manifest.contextCapsulePath = capsule.outputPath;
        }
      }
      manifest = applyHostWorkerEvents(manifest, args);
      if (!manifest.termination?.category) manifest = applyProjectManagerUpdates(manifest, args);
      if (!manifest.termination?.category && wantsNextCycle) manifest = appendContinuousCycle(manifest, args, nextCycleDecision, workspace);
      writeTeamRunManifest(workspace, manifest);
      updatedManifest = manifest;
    });
    for (const event of Array.isArray(args.hostWorkerEvents) ? args.hostWorkerEvents : []) {
      if (!event || !["completed", "failed"].includes(String(event.event || "").toLowerCase())) continue;
      const item = updatedManifest?.workItems?.find((candidate) => candidate.id === normalizeTaskLane(event.workItemId));
      recordNativeCodexOutcome(workspace, item, String(event.event).toLowerCase() === "completed");
    }
  }
  return readTeamRun({ workspace, waitSeconds: args.waitSeconds });
}

async function runTeamTask(args = {}) {
  return orchestrateProject(args);
}

function getDevToolsPort() {
  if (!devToolsPortFile || !fs.existsSync(devToolsPortFile)) {
    throw new Error(`DevToolsActivePort not found at ${devToolsPortFile}`);
  }
  const firstLine = fs.readFileSync(devToolsPortFile, "utf8").split(/\r?\n/)[0]?.trim();
  if (!firstLine) {
    throw new Error("DevToolsActivePort exists but does not contain a port.");
  }
  return firstLine;
}

async function getAntigravityPage() {
  const port = getDevToolsPort();
  const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
  const page = pages.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl)
    || pages.find((entry) => entry.webSocketDebuggerUrl);
  if (!page) {
    throw new Error(`No inspectable Antigravity page found on DevTools port ${port}.`);
  }
  return { port, page };
}

function createCdpClient(webSocketDebuggerUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(webSocketDebuggerUrl);
    let nextId = 1;
    const pending = new Map();
    const timeout = setTimeout(() => reject(new Error("Timed out connecting to Antigravity DevTools WebSocket.")), 5000);

    ws.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve({
        send(method, params = {}) {
          const id = nextId++;
          ws.send(JSON.stringify({ id, method, params }));
          return new Promise((sendResolve, sendReject) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              sendReject(new Error(`CDP command timed out: ${method}`));
            }, 10000);
            pending.set(id, { resolve: sendResolve, reject: sendReject, timer });
          });
        },
        close() {
          try {
            ws.close();
          } catch {
            // Ignore close races.
          }
        },
      });
    });

    ws.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!message.id || !pending.has(message.id)) {
        return;
      }
      const entry = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        entry.reject(new Error(message.error.message || JSON.stringify(message.error)));
      } else {
        entry.resolve(message.result);
      }
    });

    ws.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("Failed to connect to Antigravity DevTools WebSocket."));
    });
  });
}

function jsString(value) {
  return JSON.stringify(String(value ?? ""));
}

function safeWorkspacePath(workspace) {
  const resolved = path.resolve(String(workspace || "").trim());
  if (!resolved || resolved === path.parse(resolved).root) {
    throw new Error("A concrete workspace path is required for Antigravity bridge jobs.");
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Workspace does not exist or is not a directory: ${resolved}`);
  }
  return resolved;
}

function jobsRootFor(workspace) {
  return path.join(bridgeRootFor(workspace), "jobs");
}

function bridgeRootFor(workspace) {
  return path.join(safeWorkspacePath(workspace), ".antigravity-bridge");
}

function utcStamp() {
  return new Date().toISOString();
}

function datePrefix(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function nextJobId(workspace) {
  const root = jobsRootFor(workspace);
  fs.mkdirSync(root, { recursive: true });
  const prefix = datePrefix();
  const existing = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${prefix}-`))
    .map((entry) => Number.parseInt(entry.name.slice(prefix.length + 1), 10))
    .filter(Number.isFinite);
  const next = existing.length ? Math.max(...existing) + 1 : 1;
  return `${prefix}-${String(next).padStart(3, "0")}`;
}

function jobDirFor(workspace, jobId) {
  return path.join(jobsRootFor(workspace), jobId);
}

function readJsonFile(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function transientRenameError(error) {
  return ["EACCES", "EBUSY", "EPERM", "ENOTEMPTY"].includes(String(error?.code || "").toUpperCase());
}

function atomicRenameWithRetry(tempPath, filePath, attempts = 5) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      fs.renameSync(tempPath, filePath);
      return;
    } catch (error) {
      lastError = error;
      if (!transientRenameError(error) || attempt === attempts - 1) break;
      sleepSync(20 * (attempt + 1));
    }
  }
  throw lastError;
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`);
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    atomicRenameWithRetry(tempPath, filePath);
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // Preserve the original rename error.
    }
    throw error;
  }
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function transientLockError(error) {
  return ["EACCES", "EBUSY", "EEXIST", "EPERM"].includes(String(error?.code || "").toUpperCase());
}

function withFileLock(targetFile, callback, timeoutMs = 10000) {
  const lockFile = `${targetFile}.lock`;
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let handle = null;
  while (Date.now() <= deadline) {
    try {
      handle = fs.openSync(lockFile, "wx");
      fs.writeFileSync(handle, `${process.pid}\n${utcStamp()}\n`, "utf8");
      break;
    } catch (error) {
      if (!transientLockError(error)) throw error;
      try {
        const ageMs = Date.now() - fs.statSync(lockFile).mtimeMs;
        if (ageMs > 60000) fs.rmSync(lockFile, { force: true });
      } catch {
        // Another process may have released the lock between checks.
      }
      sleepSync(25);
    }
  }
  if (handle === null) throw new Error(`Timed out waiting for state lock: ${lockFile}`);
  try {
    return callback();
  } finally {
    try { fs.closeSync(handle); } catch { /* already closed */ }
    try { fs.rmSync(lockFile, { force: true }); } catch { /* another process will clear a stale lock */ }
  }
}

function writeTextFileEnsuringDir(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, String(value || ""), "utf8");
}

function modeGuidance(mode) {
  const normalized = String(mode || "fast").trim().toLowerCase();
  if (normalized === "deep") {
    return "Deep mode: inspect related modules and prior patterns, run the strongest practical tests, and include risk notes.";
  }
  if (normalized === "review") {
    return "Review mode: inspect and report only; do not edit files.";
  }
  if (normalized === "patch") {
    return "Patch mode: make a narrow safe edit, run relevant verification, and produce a diff.";
  }
  return "Fast mode: inspect only directly relevant files, make the smallest safe change, and run targeted verification only.";
}

function artifactContract(jobId, jobDir, maxResultBullets = 8) {
  const bulletLimit = boundedResultBulletLimit({ maxResultBullets }, 8);
  return [
    `JobId: ${jobId}`,
    `JobFolder: ${jobDir}`,
    "Required artifacts:",
    "- status.json is bridge-owned. Workers must not read, edit, or replace it.",
    `- result.md: max ${bulletLimit} bullets with outcome, risk, and next step.`,
    "- changed-files.txt: one changed path per line, or NONE.",
    "- diff.patch: compact patch/diff if files changed, or empty.",
    "- test-output-summary.md: commands run and pass/fail summary only.",
    "- verification-evidence.json is bridge-owned. Workers must not read, edit, or replace it.",
    "",
    "Do not paste full files, full logs, screenshots, or full chat transcripts.",
  ].join("\n");
}

function buildJobRequest(args, jobId, jobDir) {
  const goal = String(args.goal || "").trim();
  const workspace = safeWorkspacePath(args.workspace);
  const mode = String(args.mode || "fast").trim().toLowerCase();
  const nextStep = String(args.nextStep || "Inspect the relevant files and write compact artifacts.").trim();
  const expectedFiles = Array.isArray(args.expectedFiles) ? args.expectedFiles.map((value) => String(value || "").trim()).filter(Boolean) : [];
  return [
    `# Antigravity Bridge Job ${jobId}`,
    "",
    `Goal: ${goal}`,
    `Workspace: ${workspace}`,
    `Mode: ${mode}`,
    "",
    modeGuidance(mode),
    "",
    `Next step: ${nextStep}`,
    expectedFiles.length ? `Allowed file boundary: ${expectedFiles.join(", ")}` : "Allowed file boundary: not specified; keep changes narrowly scoped to the assigned objective.",
    "",
    artifactContract(jobId, jobDir, args.maxResultBullets),
    "",
    "Codex will read only result.md, changed-files.txt, diff.patch, test-output-summary.md, verification-evidence.json, and status.json.",
  ].join("\n");
}

function createJob(args = {}) {
  const workspace = safeWorkspacePath(args.workspace);
  const jobId = nextJobId(workspace);
  const jobDir = jobDirFor(workspace, jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  const createdAt = utcStamp();
  const request = buildJobRequest({ ...args, workspace }, jobId, jobDir);
  const status = {
    jobId,
    state: "queued",
    worker: String(args.worker || "antigravity").trim(),
    mode: String(args.mode || "fast").trim().toLowerCase(),
    createdAt,
    updatedAt: createdAt,
    currentStep: "created",
    maxResultBullets: boundedResultBulletLimit(args, 8),
    requestFile: "request.md",
    resultFile: "result.md",
    changedFilesFile: "changed-files.txt",
    diffFile: "diff.patch",
    testOutputSummaryFile: "test-output-summary.md",
    verificationEvidenceFile: "verification-evidence.json",
  };
  fs.writeFileSync(path.join(jobDir, "request.md"), `${request}\n`, "utf8");
  writeJsonFile(path.join(jobDir, "status.json"), status);
  for (const file of ["result.md", "changed-files.txt", "diff.patch", "test-output-summary.md"]) {
    const target = path.join(jobDir, file);
    if (!fs.existsSync(target)) fs.writeFileSync(target, "", "utf8");
  }
  const gitBaseline = collectGitState(workspace);
  const baselinePaths = pathsFromGitStatus(gitBaseline.status);
  writeJsonFile(path.join(jobDir, "git-baseline.json"), {
    available: gitBaseline.available,
    status: gitBaseline.status,
    diffHash: crypto.createHash("sha256").update(gitBaseline.diff).digest("hex"),
    pathFingerprints: collectPathFingerprints(workspace, baselinePaths),
  });
  return { workspace, jobId, jobDir, status, request };
}

function resolveJobId(workspace, jobId = "latest") {
  const root = jobsRootFor(workspace);
  if (!fs.existsSync(root)) {
    throw new Error(`No Antigravity bridge jobs found in ${root}`);
  }
  if (jobId && jobId !== "latest") {
    const dir = jobDirFor(workspace, jobId);
    if (!fs.existsSync(dir)) throw new Error(`Job not found: ${jobId}`);
    return jobId;
  }
  const jobs = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (!jobs.length) throw new Error(`No Antigravity bridge jobs found in ${root}`);
  return jobs[jobs.length - 1];
}

function summarizeFile(filePath, maxChars = 12000) {
  if (!fs.existsSync(filePath)) return "";
  const text = fs.readFileSync(filePath, "utf8");
  const nulCount = (text.match(/\u0000/g) || []).length;
  if (nulCount > Math.max(8, Math.floor(text.length / 20))) {
    return "[omitted: artifact appears binary or UTF-16 encoded; rerun the worker with UTF-8 text output if this detail is needed]";
  }
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} chars]`;
}

function listJobs(args = {}) {
  const workspace = safeWorkspacePath(args.workspace);
  const root = jobsRootFor(workspace);
  const limit = Math.max(1, Math.min(100, Number(args.limit || 10)));
  if (!fs.existsSync(root)) {
    return `JobsRoot: ${root}\nCount: 0`;
  }
  const rows = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const status = effectiveBridgeJobStatus(readJsonFile(path.join(root, entry.name, "status.json"), {}));
      return {
        jobId: entry.name,
        state: status.state || "unknown",
        mode: status.mode || "",
        updatedAt: status.updatedAt || "",
        currentStep: status.currentStep || "",
      };
    })
    .sort((a, b) => String(b.jobId).localeCompare(String(a.jobId)))
    .slice(0, limit);
  return [
    `JobsRoot: ${root}`,
    `Count: ${rows.length}`,
    ...rows.map((row) => `${row.jobId} | ${row.state} | ${row.mode} | ${row.updatedAt} | ${row.currentStep}`),
  ].join("\n");
}

function isProcessAlive(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch {
    return false;
  }
}

function isRecordedWorkerAlive(status = {}) {
  const pid = Number(status.workerPid);
  if (!isProcessAlive(pid)) return false;
  const marker = String(status.workerCommandMarker || "").trim();
  if (!marker) return true;
  const cached = processIdentityCache.get(pid);
  let commandLine = cached && (Date.now() - cached.checkedAt) < 30000 ? cached.commandLine : "";
  if (!commandLine) {
    commandLine = processCommandLine(pid);
    processIdentityCache.set(pid, { commandLine, checkedAt: Date.now() });
  }
  return Boolean(commandLine && commandLine.toLowerCase().includes(marker.toLowerCase()));
}

function minutesSinceUtc(value) {
  const time = Date.parse(String(value || ""));
  if (!Number.isFinite(time)) return null;
  return Math.max(0, Math.round((Date.now() - time) / 60000));
}

function readRunningJobHint(status) {
  const state = String(status.state || "").toLowerCase();
  if (state !== "running") return [];
  const ageMinutes = minutesSinceUtc(status.startedAt || status.updatedAt || status.createdAt);
  const alive = isRecordedWorkerAlive(status);
  const lines = [
    "RunningJobHint:",
    `WorkerPidAlive: ${alive}`,
    ageMinutes === null ? "AgeMinutes: unknown" : `AgeMinutes: ${ageMinutes}`,
  ];
  if (!alive) {
    lines.push("Action: Worker process is gone but status is still running. Retry the job or inspect test-output-summary.md.");
  } else if (ageMinutes !== null && ageMinutes >= 5) {
    lines.push("Action: Worker is still active and artifacts are empty. Wait briefly, or cancel/retry with a smaller maxMinutes and narrower nextStep.");
  } else {
    lines.push("Action: Worker has started. Read again after it writes compact artifacts.");
  }
  return lines;
}

function effectiveBridgeJobStatus(status = {}) {
  const state = String(status.state || "").toLowerCase();
  const workerStillFinalizing = ["completed", "failed", "cancelled"].includes(state)
    && status.bridgeFinalized !== true
    && isRecordedWorkerAlive(status);
  if (!workerStillFinalizing) return status;
  return {
    ...status,
    state: "running",
    currentStep: "worker-finalizing-artifacts",
    blocker: "",
  };
}

function terminalStatusFromTelemetry(jobDir, status = {}) {
  const telemetry = readJsonFile(path.join(jobDir, "worker-telemetry.json"), null);
  const resultReady = fs.existsSync(path.join(jobDir, "result.md"))
    && fs.readFileSync(path.join(jobDir, "result.md"), "utf8").trim() !== "";
  const testsReady = fs.existsSync(path.join(jobDir, "test-output-summary.md"))
    && fs.readFileSync(path.join(jobDir, "test-output-summary.md"), "utf8").trim() !== "";
  if (!telemetry?.completedAt || !resultReady || !testsReady) return null;

  const success = telemetry.success === true;
  const failureCategory = success ? "" : String(telemetry.failureCategory || "worker-failure");
  const existingBlocker = String(status.blocker || "");
  const keepExistingBlocker = existingBlocker && !/process is no longer running|worker process.*gone/i.test(existingBlocker);
  return {
    ...status,
    state: success ? "completed" : "failed",
    currentStep: success ? "worker-telemetry-completed" : "worker-telemetry-failed",
    completedAt: String(telemetry.completedAt),
    bridgeFinalized: true,
    observedModel: String(telemetry.observedModel || status.observedModel || ""),
    failureCategory,
    blocker: success ? "" : keepExistingBlocker ? existingBlocker : `Worker ended with ${failureCategory}; terminal state recovered from finalized telemetry.`,
  };
}

function repairStaleRunningJob(workspace, jobId, jobDir, status) {
  status = effectiveBridgeJobStatus(status);
  const state = String(status.state || "").toLowerCase();
  const pid = Number(status.workerPid);
  const workerAlive = Number.isInteger(pid) && pid > 0 && isRecordedWorkerAlive(status);
  const telemetryStatus = (!workerAlive && state === "running") || status.currentStep === "worker-process-gone"
    ? terminalStatusFromTelemetry(jobDir, status)
    : null;
  if (telemetryStatus) {
    writeJsonFile(path.join(jobDir, "status.json"), { ...telemetryStatus, updatedAt: utcStamp() });
    return { status: telemetryStatus, repaired: true, source: "telemetry" };
  }
  if (status.statusCorrupt === true && state === "running" && !workerAlive) {
    const repairedStatus = {
      ...status,
      state: "failed",
      currentStep: "invalid-status-json",
      completedAt: utcStamp(),
      bridgeFinalized: true,
      failureCategory: "state-corruption",
      blocker: "status.json was unreadable and neither a live recorded worker nor finalized telemetry could recover the job.",
    };
    writeJsonFile(path.join(jobDir, "status.json"), { ...repairedStatus, updatedAt: utcStamp() });
    const testsPath = path.join(jobDir, "test-output-summary.md");
    if (!fs.existsSync(testsPath) || fs.readFileSync(testsPath, "utf8").trim() === "") {
      fs.writeFileSync(testsPath, "StatusJsonRecovered: false\nResult: failed closed because bridge job state was unreadable.\n", "utf8");
    }
    return { status: repairedStatus, repaired: true, source: "state-corruption" };
  }
  if (state !== "running" || !Number.isInteger(pid) || pid <= 0 || workerAlive) {
    return { status, repaired: false };
  }

  const repairedStatus = {
    ...status,
    state: "failed",
    currentStep: "worker-process-gone",
    completedAt: utcStamp(),
    bridgeFinalized: true,
    blocker: "Worker process is no longer running, but the job status was still running.",
  };
  writeJsonFile(path.join(jobDir, "status.json"), { ...repairedStatus, updatedAt: utcStamp() });

  const testsPath = path.join(jobDir, "test-output-summary.md");
  if (!fs.existsSync(testsPath) || fs.readFileSync(testsPath, "utf8").trim() === "") {
    fs.writeFileSync(
      testsPath,
      [
        "WorkerProcessGone: true",
        `WorkerPid: ${pid}`,
        "Result: marked failed because the worker process exited before writing compact artifacts.",
        "Next: retry with a smaller nextStep/maxMinutes, or inspect the worker-specific command manually.",
      ].join("\n") + "\n",
      "utf8",
    );
  }
  return { status: repairedStatus, repaired: true, source: "process-gone" };
}

function readJob(args = {}) {
  const workspace = safeWorkspacePath(args.workspace);
  const jobId = resolveJobId(workspace, args.jobId || "latest");
  const jobDir = jobDirFor(workspace, jobId);
  const statusPath = path.join(jobDir, "status.json");
  const repair = repairStaleRunningJob(workspace, jobId, jobDir, readJsonFile(statusPath, {}));
  const statusObject = repair.status;
  const runningHint = readRunningJobHint(statusObject);
  const status = summarizeFile(statusPath, 4000);
  const result = summarizeFile(path.join(jobDir, "result.md"), 8000);
  const changed = summarizeFile(path.join(jobDir, "changed-files.txt"), 4000);
  const tests = summarizeFile(path.join(jobDir, "test-output-summary.md"), 6000);
  const verificationEvidence = summarizeFile(path.join(jobDir, "verification-evidence.json"), 6000);
  const telemetry = summarizeFile(path.join(jobDir, "worker-telemetry.json"), 4000);
  const diff = summarizeFile(path.join(jobDir, "diff.patch"), 12000);
  return [
    `JobId: ${jobId}`,
    `JobFolder: ${jobDir}`,
    "",
    "status.json:",
    status || "{}",
    repair.repaired ? "" : null,
    repair.repaired ? (repair.source === "telemetry"
      ? "StaleJobRepair: recovered terminal state from finalized worker telemetry and compact artifacts."
      : "StaleJobRepair: marked failed because worker process was gone while status was running.") : null,
    runningHint.length ? "" : null,
    ...runningHint,
    "",
    "result.md:",
    result || "<empty>",
    "",
    "changed-files.txt:",
    changed || "<empty>",
    "",
    "test-output-summary.md:",
    tests || "<empty>",
    "",
    "verification-evidence.json:",
    verificationEvidence || "<not recorded by this job version>",
    "",
    "worker-telemetry.json:",
    telemetry || "<empty>",
    "",
    "diff.patch:",
    diff || "<empty>",
  ].join("\n");
}

function cancelJob(args = {}) {
  const workspace = safeWorkspacePath(args.workspace);
  const jobId = resolveJobId(workspace, args.jobId || "latest");
  const jobDir = jobDirFor(workspace, jobId);
  const statusPath = path.join(jobDir, "status.json");
  const status = readJsonFile(statusPath, { jobId });
  const termination = terminateProcessTree(status.workerPid, status.workerCommandMarker || status.jobId);
  const reason = String(args.reason || "Cancelled by Codex.").trim();
  const classified = failureCategoryFromText(reason);
  const failureCategory = classified === "worker-failure" ? "cancelled" : classified;
  status.state = "cancelled";
  status.updatedAt = utcStamp();
  status.completedAt = utcStamp();
  status.currentStep = failureCategory === "cancelled" ? "cancelled" : `cancelled-${failureCategory}`;
  status.bridgeFinalized = true;
  status.failureCategory = failureCategory;
  status.blocker = reason;
  status.processTermination = termination;
  writeJsonFile(statusPath, status);
  const telemetryPath = path.join(jobDir, "worker-telemetry.json");
  const telemetry = readJsonFile(telemetryPath, null);
  if (telemetry) writeJsonFile(telemetryPath, { ...telemetry, success: false, failureCategory, completedAt: utcStamp() });
  return `CancelJobResult:\nJobId: ${jobId}\nState: cancelled\nProcessTreeStopped: ${termination.stopped}\nProcessNote: ${termination.note}`;
}

function markJobSubmitted(workspace, jobId) {
  const statusPath = path.join(jobDirFor(workspace, jobId), "status.json");
  const status = readJsonFile(statusPath, { jobId });
  status.state = "submitted";
  status.updatedAt = utcStamp();
  status.currentStep = "submitted-to-antigravity";
  writeJsonFile(statusPath, status);
}

function markJobSubmitFailed(workspace, jobId, reason) {
  const statusPath = path.join(jobDirFor(workspace, jobId), "status.json");
  const status = readJsonFile(statusPath, { jobId });
  status.state = "submit_failed";
  status.updatedAt = utcStamp();
  status.currentStep = "submit-failed";
  status.blocker = String(reason || "Antigravity did not confirm prompt submission.").slice(0, 1000);
  writeJsonFile(statusPath, status);
}

function updateJobStatus(workspace, jobId, patch = {}) {
  const statusPath = path.join(jobDirFor(workspace, jobId), "status.json");
  const status = readJsonFile(statusPath, { jobId });
  writeJsonFile(statusPath, { ...status, ...patch, updatedAt: utcStamp() });
}

function processCommandLine(pid) {
  if (process.platform === "win32") {
    const script = "$targetPid = [int]$env:AI_MOBILE_TARGET_PID; $p = Get-CimInstance Win32_Process -Filter (\"ProcessId = {0}\" -f $targetPid) -ErrorAction SilentlyContinue; if ($p) { $p.CommandLine }";
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], {
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
      env: { ...process.env, AI_MOBILE_TARGET_PID: String(pid) },
    });
    return result.status === 0 ? String(result.stdout || "").trim() : "";
  }
  const result = spawnSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8", timeout: 5000, windowsHide: true });
  return result.status === 0 ? String(result.stdout || "").trim() : "";
}

function terminateProcessTree(pid, expectedMarker = "") {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return { stopped: false, note: "No valid worker PID was recorded." };
  if (!isProcessAlive(numericPid)) return { stopped: true, note: "Worker process was already stopped." };
  const commandLine = processCommandLine(numericPid);
  const marker = String(expectedMarker || "").trim();
  if (!commandLine || (marker && !commandLine.toLowerCase().includes(marker.toLowerCase()))) {
    return { stopped: false, note: "Refused to stop PID because its command line did not match the recorded AI Mobile job." };
  }
  try {
    if (process.platform === "win32") {
      const result = spawnSync("taskkill.exe", ["/PID", String(numericPid), "/T", "/F"], { encoding: "utf8", timeout: 10000, windowsHide: true });
      return {
        stopped: result.status === 0 || !isProcessAlive(numericPid),
        note: truncateText(String(result.stdout || result.stderr || "taskkill completed").trim(), 500),
      };
    }
    try {
      process.kill(-numericPid, "SIGTERM");
    } catch {
      process.kill(numericPid, "SIGTERM");
    }
    return { stopped: !isProcessAlive(numericPid), note: "Sent SIGTERM to the worker process group." };
  } catch (error) {
    return { stopped: false, note: truncateText(error?.message || String(error), 500) };
  }
}

function terminateDescendantProcesses(parentPid = process.pid) {
  const numericPid = Number(parentPid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return { stopped: false, note: "Invalid parent PID." };
  if (process.platform === "win32") {
    const script = [
      "$root = [int]$env:AI_MOBILE_PARENT_PID",
      "$self = $PID",
      "$all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)",
      "$ids = New-Object System.Collections.Generic.List[int]",
      "$queue = New-Object System.Collections.Generic.Queue[int]",
      "$queue.Enqueue($root)",
      "while ($queue.Count -gt 0) { $parent = $queue.Dequeue(); foreach ($child in @($all | Where-Object { $_.ParentProcessId -eq $parent })) { if (-not $ids.Contains([int]$child.ProcessId)) { $ids.Add([int]$child.ProcessId); $queue.Enqueue([int]$child.ProcessId) } } }",
      "foreach ($id in @($ids | Sort-Object -Descending)) { if ($id -ne $self) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue } }",
      "$ids.Count",
    ].join("; ");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], {
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
      env: { ...process.env, AI_MOBILE_PARENT_PID: String(numericPid) },
    });
    return {
      stopped: result.status === 0,
      note: truncateText(String(result.stdout || result.stderr || "descendant cleanup completed").trim(), 500),
    };
  }
  const result = spawnSync("pkill", ["-TERM", "-P", String(numericPid)], { encoding: "utf8", timeout: 5000, windowsHide: true });
  return { stopped: result.status === 0 || result.status === 1, note: String(result.stderr || "descendant cleanup completed").trim() };
}

function writeJobFailureArtifacts(workspace, jobId, worker, error) {
  const jobDir = jobDirFor(workspace, jobId);
  const message = truncateText(error?.message || String(error || "Unknown worker failure."), 2000);
  const resultPath = path.join(jobDir, "result.md");
  if (!fs.existsSync(resultPath) || fs.readFileSync(resultPath, "utf8").trim() === "") {
    fs.writeFileSync(resultPath, `- ${worker} failed before producing a result.\n- Blocker: ${message}\n- Next: retry only this lane with a narrower task.\n`, "utf8");
  }
  const testsPath = path.join(jobDir, "test-output-summary.md");
  fs.writeFileSync(testsPath, `BridgeExecution:\nWorker: ${worker}\nResult: failed\nError: ${message}\n`, "utf8");
}

function writeAuthoritativeExecutionSummary(jobDir, worker, result, stderr) {
  const testsPath = path.join(jobDir, "test-output-summary.md");
  const workerSummary = fs.existsSync(testsPath) ? fs.readFileSync(testsPath, "utf8").trim() : "";
  const timedOut = Boolean(result.error && result.error.code === "ETIMEDOUT");
  const authoritative = [
    "BridgeExecution:",
    `Worker: ${worker}`,
    `ExitCode: ${result.status ?? "<unknown>"}`,
    `TimedOut: ${timedOut}`,
    `Result: ${result.status === 0 && !result.error ? "success" : "failed"}`,
    String(stderr || "").trim() ? `Stderr: ${truncateText(String(stderr).trim(), 2000)}` : "Stderr: <empty>",
    workerSummary ? "" : null,
    workerSummary ? "WorkerReportedSummary:" : null,
    workerSummary ? truncateText(workerSummary, 3000) : null,
  ].filter((line) => line !== null).join("\n");
  fs.writeFileSync(testsPath, `${authoritative}\n`, "utf8");
}

function pathsFromGitStatus(statusText) {
  return String(statusText || "")
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = String(line || "").trim();
      if (!trimmed) return "";
      // collectGitState trims the whole status block, so the first porcelain
      // line may begin with `M ` instead of the normal ` M `.
      const porcelain = trimmed.match(/^[ MADRCU?!]{1,2}\s+(.+)$/);
      return porcelain ? porcelain[1].trim() : trimmed;
    })
    .map((file) => file.includes(" -> ") ? file.split(" -> ").pop().trim() : file)
    .filter(Boolean)
    .map((file) => file.replace(/\\/g, "/"));
}

function pathMatchesBoundary(file, boundary) {
  const normalizedFile = String(file || "").replace(/\\/g, "/").replace(/^\.\//, "");
  const normalizedBoundary = String(boundary || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (!normalizedBoundary) return false;
  if (normalizedBoundary.includes("*")) {
    const escaped = normalizedBoundary.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`, "i").test(normalizedFile);
  }
  return normalizedFile.toLowerCase() === normalizedBoundary.toLowerCase()
    || normalizedFile.toLowerCase().startsWith(`${normalizedBoundary.toLowerCase()}/`);
}

function validateWorkerFileBoundary(args, gitOutcome) {
  const boundaries = Array.isArray(args.expectedFiles) ? args.expectedFiles.filter(Boolean) : [];
  if (!boundaries.length) return { ok: true, violations: [] };
  const violations = (gitOutcome.changedDuringRun || []).filter((file) => !boundaries.some((boundary) => pathMatchesBoundary(file, boundary)));
  return { ok: violations.length === 0, violations };
}

function validateWriterCompletion(args = {}, gitOutcome = {}, resultText = "") {
  // Orchestration always passes an explicit boolean. Preserve compatibility
  // for direct advanced provider jobs whose older payloads have no role flag.
  if (args.readOnly !== false) return { ok: true, reason: "" };
  const text = String(resultText || "");
  if (/(?:^|\n)\s*(?:[-*#]+\s*)?(?:outcome\s*:\s*)?blocked\b|\bno (?:code|files?) (?:was |were )?changed\b/i.test(text)) {
    return { ok: false, reason: "Writer reported a blocked/no-change outcome. Rescope the file boundary or implementation objective; do not accept this as completed code work." };
  }
  if (!(gitOutcome.changedDuringRun || []).length) {
    return { ok: false, reason: "Writer produced no attributable file changes. Treat this as an insufficient result and rescope or fail over the bounded implementation lane." };
  }
  return { ok: true, reason: "" };
}

function cooldownMinutesForFailure(category) {
  return {
    "rate-limit": 30,
    quota: 60,
    timeout: 10,
    outage: 5,
    "model-unavailable": 30,
    auth: 60,
    "worker-failure": 10,
    "insufficient-result": 10,
  }[category] || 0;
}

function recordWorkerTelemetry(workspace, jobDir, args = {}, telemetry = {}) {
  const resourceId = String(args.resourceId || telemetry.resourceId || `${telemetry.provider || "worker"}:${telemetry.requestedModel || "default"}`);
  const success = telemetry.success === true;
  const failureCategory = success ? "" : (telemetry.failureCategory || "worker-failure");
  const now = utcStamp();
  const cooldownMinutes = cooldownMinutesForFailure(failureCategory);
  const cooldownUntil = cooldownMinutes ? new Date(Date.now() + cooldownMinutes * 60000).toISOString() : "";
  const safeTelemetry = {
    version: 1,
    provider: String(telemetry.provider || "unknown"),
    resourceId,
    requestedModel: String(telemetry.requestedModel || ""),
    observedModel: String(telemetry.observedModel || ""),
    observedModels: Array.isArray(telemetry.observedModels)
      ? telemetry.observedModels.slice(0, 8).map((row) => ({
          model: String(row?.model || ""),
          costUsdEquivalent: Number.isFinite(Number(row?.costUsdEquivalent)) ? Number(row.costUsdEquivalent) : null,
          inputTokens: Number.isFinite(Number(row?.inputTokens)) ? Number(row.inputTokens) : null,
          cacheReadInputTokens: Number.isFinite(Number(row?.cacheReadInputTokens)) ? Number(row.cacheReadInputTokens) : null,
          outputTokens: Number.isFinite(Number(row?.outputTokens)) ? Number(row.outputTokens) : null,
        })).filter((row) => row.model)
      : [],
    success,
    failureCategory,
    durationMs: Number.isFinite(Number(telemetry.durationMs)) ? Number(telemetry.durationMs) : null,
    inputTokens: Number.isFinite(Number(telemetry.inputTokens)) ? Number(telemetry.inputTokens) : null,
    cacheCreationInputTokens: Number.isFinite(Number(telemetry.cacheCreationInputTokens)) ? Number(telemetry.cacheCreationInputTokens) : null,
    cacheReadInputTokens: Number.isFinite(Number(telemetry.cacheReadInputTokens)) ? Number(telemetry.cacheReadInputTokens) : null,
    outputTokens: Number.isFinite(Number(telemetry.outputTokens)) ? Number(telemetry.outputTokens) : null,
    reportedCostUsdEquivalent: Number.isFinite(Number(telemetry.reportedCostUsdEquivalent)) ? Number(telemetry.reportedCostUsdEquivalent) : null,
    promptChars: Number.isFinite(Number(telemetry.promptChars)) ? Number(telemetry.promptChars) : null,
    resultChars: Number.isFinite(Number(telemetry.resultChars)) ? Number(telemetry.resultChars) : null,
    workerRole: normalizeTaskLane(telemetry.workerRole || ""),
    sessionId: truncateText(String(telemetry.sessionId || ""), 160),
    numTurns: Number.isFinite(Number(telemetry.numTurns)) ? Number(telemetry.numTurns) : null,
    structuredOutput: telemetry.structuredOutput === true,
    workItemKinds: Array.isArray(args.workItemKinds) ? args.workItemKinds.map(normalizeTaskLane).filter(Boolean).slice(0, 12) : [],
    completedAt: now,
  };
  writeJsonFile(path.join(jobDir, "worker-telemetry.json"), safeTelemetry);

  mutateWorkspaceResourceState(workspace, (state) => {
    const previous = state.outcomes?.[resourceId] || {};
    const previousSuccessTime = Date.parse(String(previous.lastSuccessAt || ""));
    const previousFailureTime = Date.parse(String(previous.lastFailureAt || ""));
    const previousSuccessfulKinds = Array.isArray(previous.successfulKinds)
      ? previous.successfulKinds
      : Number.isFinite(previousSuccessTime) && (!Number.isFinite(previousFailureTime) || previousSuccessTime >= previousFailureTime) && Array.isArray(previous.recentKinds)
        ? previous.recentKinds
        : [];
    const successfulKinds = success
      ? [...previousSuccessfulKinds, ...safeTelemetry.workItemKinds].slice(-5)
      : previousSuccessfulKinds.slice(-5);
    const outcome = {
      ...previous,
      lastState: success ? "available" : "cooldown",
      lastCategory: failureCategory,
      lastSuccessAt: success ? now : String(previous.lastSuccessAt || ""),
      lastFailureAt: success ? String(previous.lastFailureAt || "") : now,
      cooldownUntil: success ? "" : cooldownUntil,
      observedModel: safeTelemetry.observedModel || String(previous.observedModel || ""),
      recentKinds: successfulKinds,
      successfulKinds,
      successCount: Math.max(0, Number(previous.successCount || 0)) + (success ? 1 : 0),
      failureCount: Math.max(0, Number(previous.failureCount || 0)) + (success ? 0 : 1),
      consecutiveFailures: success ? 0 : Math.max(0, Number(previous.consecutiveFailures || 0)) + 1,
      lastDurationMs: safeTelemetry.durationMs,
    };
    return {
      ...state,
      outcomes: { ...(state.outcomes || {}), [resourceId]: outcome },
    };
  });

  if (safeTelemetry.provider === "claude" && safeTelemetry.observedModel) {
    const requestedText = `${safeTelemetry.requestedModel} ${resourceId.split(":")[1] || ""}`.toLowerCase();
    const alias = ["haiku", "sonnet", "opus", "fable"].find((name) => requestedText.includes(name)) || "";
    const currentCache = readSafeResourceCache();
    const claudePatch = {
      observedModel: safeTelemetry.observedModel,
      lastOutcomeAt: now,
    };
    if (alias && success && safeTelemetry.observedModel.toLowerCase().includes(alias)) {
      claudePatch.aliasResolutions = {
        ...(currentCache.claude?.aliasResolutions || {}),
        [alias]: safeTelemetry.observedModel,
      };
    }
    if (success) claudePatch.lastSuccessAt = now;
    updateSafeResourceCache({
      claude: claudePatch,
    });
  }
  return safeTelemetry;
}

function parseClaudeJsonOutput(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return { parsed: null, resultText: "" };
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).reverse();
    for (const line of lines) {
      try {
        parsed = JSON.parse(line);
        break;
      } catch {
        // Continue until a complete JSON result line is found.
      }
    }
  }
  if (!parsed || typeof parsed !== "object") return { parsed: null, resultText: text };
  const observedModels = Object.entries(parsed.modelUsage || {}).map(([model, rawUsage]) => {
    const modelUsage = rawUsage && typeof rawUsage === "object" ? rawUsage : {};
    const inputTokens = Number(modelUsage.input_tokens ?? modelUsage.inputTokens);
    const cacheReadInputTokens = Number(modelUsage.cache_read_input_tokens ?? modelUsage.cacheReadInputTokens);
    const outputTokens = Number(modelUsage.output_tokens ?? modelUsage.outputTokens);
    const costUsdEquivalent = Number(modelUsage.cost_usd ?? modelUsage.costUSD ?? modelUsage.costUsd ?? modelUsage.cost);
    const tokenVolume = [inputTokens, cacheReadInputTokens, outputTokens]
      .filter(Number.isFinite)
      .reduce((sum, value) => sum + value, 0);
    const dominance = Number.isFinite(costUsdEquivalent) && costUsdEquivalent > 0
      ? costUsdEquivalent * 1e12
      : tokenVolume;
    return { model, costUsdEquivalent, inputTokens, cacheReadInputTokens, outputTokens, dominance };
  }).sort((a, b) => b.dominance - a.dominance || a.model.localeCompare(b.model));
  const usage = parsed.usage || {};
  const structuredOutput = parsed.structured_output && typeof parsed.structured_output === "object"
    ? parsed.structured_output
    : parsed.structuredOutput && typeof parsed.structuredOutput === "object"
      ? parsed.structuredOutput
      : null;
  return {
    parsed,
    resultText: String(parsed.result || parsed.message || "").trim() || compactClaudeStructuredOutput(structuredOutput),
    structuredOutput,
    sessionId: String(parsed.session_id ?? parsed.sessionId ?? ""),
    numTurns: Number(parsed.num_turns ?? parsed.numTurns),
    observedModel: observedModels[0]?.model || "",
    observedModels: observedModels.map(({ dominance, ...row }) => row),
    durationMs: Number(parsed.duration_ms ?? parsed.durationMs),
    inputTokens: Number(usage.input_tokens ?? usage.inputTokens),
    cacheCreationInputTokens: Number(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens),
    cacheReadInputTokens: Number(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens),
    outputTokens: Number(usage.output_tokens ?? usage.outputTokens),
    reportedCostUsdEquivalent: Number(parsed.total_cost_usd ?? parsed.totalCostUsd),
    isError: parsed.is_error === true || parsed.subtype === "error",
    errorSubtype: String(parsed.subtype || ""),
  };
}

function claudeBudgetErrorSubtype(subtype) {
  return /budget/i.test(String(subtype || ""));
}

function pathFingerprint(workspace, relativePath) {
  const normalized = String(relativePath || "").replace(/\\/g, "/").replace(/^\.\//, "");
  const root = path.resolve(workspace);
  const target = path.resolve(root, normalized);
  if (!normalized || (target !== root && !target.startsWith(`${root}${path.sep}`))) return { exists: false, unsafe: true };
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return { exists: false };
  }
  if (!stat.isFile()) return { exists: true, type: stat.isDirectory() ? "directory" : "other", size: stat.size };
  const hash = crypto.createHash("sha256");
  hash.update(String(stat.size));
  const maxFullBytes = 2 * 1024 * 1024;
  if (stat.size <= maxFullBytes) {
    hash.update(fs.readFileSync(target));
  } else {
    const chunkSize = 64 * 1024;
    const handle = fs.openSync(target, "r");
    try {
      const first = Buffer.alloc(Math.min(chunkSize, stat.size));
      fs.readSync(handle, first, 0, first.length, 0);
      hash.update(first);
      const last = Buffer.alloc(Math.min(chunkSize, stat.size));
      fs.readSync(handle, last, 0, last.length, Math.max(0, stat.size - last.length));
      hash.update(last);
    } finally {
      fs.closeSync(handle);
    }
  }
  return { exists: true, type: "file", size: stat.size, hash: hash.digest("hex") };
}

function collectPathFingerprints(workspace, relativePaths) {
  const result = {};
  for (const relativePath of [...new Set(relativePaths || [])].slice(0, 500)) {
    result[relativePath] = pathFingerprint(workspace, relativePath);
  }
  return result;
}

function fingerprintChanged(before, after) {
  return JSON.stringify(before || { exists: false }) !== JSON.stringify(after || { exists: false });
}

function claudeModelFamily(value) {
  const text = String(value || "").toLowerCase();
  return ["haiku", "sonnet", "opus", "fable"].find((family) => text.includes(family)) || "";
}

function claudeObservedModelMatches(requested, observed) {
  const requestedText = normalizeClaudeDispatchModel(requested).toLowerCase();
  const observedText = String(observed || "").toLowerCase();
  if (!observedText) return true;
  if (requestedText.startsWith("claude-")) return observedText === requestedText;
  const family = claudeModelFamily(requestedText);
  return family ? observedText.includes(family) : observedText.includes(requestedText);
}

function finalizeWorkerGitArtifacts(workspace, jobDir, mode) {
  const current = collectGitState(workspace);
  const baseline = readJsonFile(path.join(jobDir, "git-baseline.json"), null);
  const currentHash = crypto.createHash("sha256").update(current.diff).digest("hex");
  const baselinePaths = new Set(pathsFromGitStatus(baseline?.status || ""));
  const currentPaths = new Set(pathsFromGitStatus(current.status));
  const allPaths = [...new Set([...baselinePaths, ...currentPaths])];
  const baselineFingerprints = baseline?.pathFingerprints || {};
  const currentFingerprints = collectPathFingerprints(workspace, allPaths);
  const changedDuringRun = allPaths.filter((file) => {
    if (Object.prototype.hasOwnProperty.call(baselineFingerprints, file)) {
      return fingerprintChanged(baselineFingerprints[file], currentFingerprints[file]);
    }
    return !baselinePaths.has(file) && currentPaths.has(file);
  });
  const reviewMutationDetected = String(mode || "").toLowerCase() === "review"
    && current.available
    && baseline?.available
    && (changedDuringRun.length > 0 || baseline.status !== current.status || baseline.diffHash !== currentHash);

  if (String(mode || "").toLowerCase() === "review") {
    fs.writeFileSync(
      path.join(jobDir, "changed-files.txt"),
      reviewMutationDetected ? `UNATTRIBUTED_WORKSPACE_CHANGE_DURING_REVIEW\n${changedDuringRun.join("\n")}${changedDuringRun.length ? "\n" : ""}` : "NONE\n",
      "utf8",
    );
    fs.writeFileSync(path.join(jobDir, "diff.patch"), "", "utf8");
    return { reviewMutationDetected, reviewWorkspaceChanged: reviewMutationDetected, changedDuringRun };
  }
  const preExistingDirty = changedDuringRun.filter((file) => baselinePaths.has(file));
  writeWorkerGitArtifacts(workspace, jobDir, changedDuringRun, preExistingDirty);
  return { reviewMutationDetected, changedDuringRun, preExistingDirty };
}

async function runWorkerFailClosed(worker, args, runner) {
  try {
    return await runner(args);
  } catch (error) {
    try {
      const workspace = safeWorkspacePath(args.workspace);
      const jobId = resolveJobId(workspace, args.jobId);
      writeJobFailureArtifacts(workspace, jobId, worker, error);
      updateJobStatus(workspace, jobId, {
        state: "failed",
        currentStep: "worker-exception",
        completedAt: utcStamp(),
        bridgeFinalized: true,
        blocker: truncateText(error?.message || String(error), 1000),
      });
      return `${worker}WorkerResult:\nJobId: ${jobId}\nState: failed\nBlocker: ${truncateText(error?.message || String(error), 1000)}`;
    } catch {
      throw error;
    }
  }
}

function truncateText(value, maxChars = 24000) {
  const text = String(value || "");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} chars]`;
}

function safeClaudeFlag(value, name) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (!/^[A-Za-z0-9._:/@+-]+$/.test(text)) {
    throw new Error(`Unsafe Claude Code ${name} value. Use a simple model or mode id.`);
  }
  return text;
}

function normalizeClaudeDispatchModel(value) {
  const model = String(value || "").trim();
  return !model || model.toLowerCase() === "auto" ? "sonnet" : model;
}

function claudeCommandSupportsExactArgs(command) {
  return process.platform !== "win32" || /\.(?:exe|com)$/i.test(String(command || ""));
}

function claudeIsolationFlags() {
  return ["--safe-mode", "--no-session-persistence"];
}

function runClaudeCli(command, args, options = {}) {
  const safeArgs = args.map((arg) => String(arg));
  if (process.platform === "win32" && !claudeCommandSupportsExactArgs(command)) {
    const commandLine = [quoteCmdArg(command), ...safeArgs.map(quoteCmdArg)].join(" ");
    return spawnSync(commandLine, {
      ...options,
      input: options.input || undefined,
      encoding: "utf8",
      timeout: options.timeout || 10000,
      windowsHide: true,
      shell: true,
    });
  }
  return spawnSync(command, safeArgs, {
    ...options,
    encoding: "utf8",
    timeout: options.timeout || 10000,
    windowsHide: true,
  });
}

function parseClaudeCliCapabilities(helpText, command = "") {
  const help = String(helpText || "");
  const disallowedToolsFlag = /(^|\s)--disallowedTools\b/m.test(help)
    ? "--disallowedTools"
    : /(^|\s)--disallowed-tools\b/m.test(help)
      ? "--disallowed-tools"
      : "";
  return {
    exactArguments: claudeCommandSupportsExactArgs(command),
    agent: /(^|\s)--agent\s+</m.test(help),
    pluginDir: /(^|\s)--plugin-dir\s+</m.test(help),
    jsonSchema: /(^|\s)--json-schema\s+</m.test(help),
    appendSystemPrompt: /(^|\s)--append-system-prompt\s+</m.test(help),
    disallowedTools: Boolean(disallowedToolsFlag),
    disallowedToolsFlag,
    safeMode: /(^|\s)--safe-mode\b/m.test(help),
    noSessionPersistence: /(^|\s)--no-session-persistence\b/m.test(help),
  };
}

function getClaudeCliCapabilities(command) {
  const key = String(command || "").toLowerCase();
  if (claudeCliCapabilityCache.has(key)) return claudeCliCapabilityCache.get(key);
  const result = runClaudeCli(command, ["--help"], { timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
  const capabilities = parseClaudeCliCapabilities(`${result.stdout || ""}\n${result.stderr || ""}`, command);
  claudeCliCapabilityCache.set(key, capabilities);
  return capabilities;
}

function claudeWorkerRole(args = {}) {
  const permissionMode = String(args.permissionMode || "").toLowerCase();
  const readOnly = permissionMode === "plan" || String(args.mode || "").toLowerCase() === "review";
  const intent = `${(args.workItemKinds || []).join(" ")} ${args.goal || ""} ${args.nextStep || ""}`.toLowerCase();
  if (!readOnly) return { name: "ai-mobile-writer", role: "writer" };
  if (/\b(test|testing|verify|verification|qa|validation|regression)\b/.test(intent)) return { name: "ai-mobile-verifier", role: "verifier" };
  if (/\b(architecture|security|risk|audit|review|critique|incident|migration)\b/.test(intent)) return { name: "ai-mobile-reviewer", role: "reviewer" };
  return { name: "ai-mobile-scout", role: "scout" };
}

function claudeWorkerSystemPrompt(role) {
  const common = "You are a bounded AI Mobile worker. Work only on the assigned item, never launch an Agent or subagent, preserve unrelated changes, and return concise verification evidence instead of narration.";
  return {
    writer: `${common} Act as the sole writer for the declared file boundary: edit only that boundary, implement one coherent change, and run focused checks. Other disjoint boundaries may have separate workers.`,
    reviewer: `${common} Act as an independent read-only reviewer: prioritize concrete defects, risks, exact paths, and the smallest safe correction.`,
    verifier: `${common} Act as a read-only verifier: run only named checks, distinguish observation from inference, and fail closed when evidence is missing.`,
    scout: `${common} Act as a read-only scout: inspect the minimum relevant files and return exact paths, facts, assumptions, and blockers for the next worker.`,
  }[role] || common;
}

function claudeWorkerResultSchema(maxResultBullets = 8) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      status: { type: "string", enum: ["completed", "blocked"] },
      summary: { type: "array", maxItems: boundedResultBulletLimit({ maxResultBullets }, 8), items: { type: "string", maxLength: 500 } },
      changedFiles: { type: "array", maxItems: 20, items: { type: "string", maxLength: 300 } },
      tests: { type: "array", maxItems: 10, items: { type: "string", maxLength: 500 } },
      blocker: { type: "string", maxLength: 800 },
    },
    required: ["status", "summary", "changedFiles", "tests", "blocker"],
  };
}

function compactClaudeStructuredOutput(value, maxResultBullets = 8) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const lines = [];
  if (value.status) lines.push(`- Status: ${String(value.status).trim()}`);
  for (const item of Array.isArray(value.summary) ? value.summary : []) lines.push(`- ${String(item).trim()}`);
  if (Array.isArray(value.changedFiles) && value.changedFiles.length) lines.push(`- Changed files: ${value.changedFiles.join(", ")}`);
  if (Array.isArray(value.tests) && value.tests.length) lines.push(`- Tests: ${value.tests.join("; ")}`);
  if (value.blocker) lines.push(`- Blocker: ${String(value.blocker).trim()}`);
  return compactResultBullets(lines.filter((line) => line !== "- ").join("\n"), boundedResultBulletLimit({ maxResultBullets }, 8), resultCharacterLimit({ maxResultBullets }, 8));
}

function removeCliOptions(args, optionNames) {
  const names = new Set(optionNames);
  const result = [];
  for (let index = 0; index < args.length; index += 1) {
    if (names.has(args[index])) {
      index += 1;
      continue;
    }
    result.push(args[index]);
  }
  return result;
}

function commandExists(command) {
  const result = runClaudeCli(command, ["--version"], { timeout: 10000 });
  return {
    ok: result.status === 0,
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || "").trim(),
    error: result.error?.message || "",
  };
}

function findClaudeCode() {
  const candidates = [];
  if (process.platform === "win32") {
    if (process.env.APPDATA) {
      candidates.push(path.join(process.env.APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"));
    }
    const where = spawnSync("where.exe", ["claude"], { encoding: "utf8", timeout: 10000, windowsHide: true });
    for (const line of String(where.stdout || "").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (/\.cmd$/i.test(trimmed)) {
        candidates.push(path.join(path.dirname(trimmed), "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"));
      }
      candidates.push(trimmed);
    }
    candidates.push("claude.cmd", "claude");
  } else {
    candidates.push("claude");
  }

  const seen = new Set();
  for (const candidate of candidates) {
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const check = commandExists(candidate);
    if (check.ok) {
      return { found: true, command: candidate, version: check.stdout || check.stderr, capabilities: getClaudeCliCapabilities(candidate) };
    }
  }
  return { found: false, command: "", version: "", message: "Claude Code CLI was not found on PATH." };
}

function getClaudeStatusText() {
  const status = findClaudeCode();
  const capabilities = status.capabilities || {};
  return [
    "ClaudeCodeStatus:",
    `Found: ${status.found}`,
    `Command: ${status.command || "<not found>"}`,
    `Version: ${status.version || "<unknown>"}`,
    "SupportedBridge: headless Claude Code CLI via claude -p",
    `ExactArgumentTransport: ${capabilities.exactArguments === true}`,
    `SpecializedWorkerPlugin: ${capabilities.pluginDir === true && capabilities.agent === true && fs.existsSync(path.join(claudeWorkerPluginDir, ".claude-plugin", "plugin.json"))}`,
    `StructuredOutput: ${capabilities.jsonSchema === true && capabilities.exactArguments === true}`,
    "Startup: passive; no Claude job is started by this status check.",
  ].join("\n");
}

function getClaudeUsageText() {
  const status = findClaudeCode();
  if (!status.found) return "ClaudeUsage:\nChecked: false\n- unavailable: Claude Code CLI was not found.";
  const usage = safeClaudeUsageProbe(status.command);
  updateSafeResourceCache({ claude: { found: true, usage, usageCheckedAt: utcStamp() } });
  return formatClaudeUsage(usage);
}

function quoteCmdArg(value) {
  const text = String(value || "");
  return `"${text.replace(/"/g, '""')}"`;
}

function runWindowsFriendly(command, args = [], options = {}) {
  const safeArgs = args.map((arg) => String(arg));
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    const commandLine = [quoteCmdArg(command), ...safeArgs.map(quoteCmdArg)].join(" ");
    return spawnSync(commandLine, {
      ...options,
      input: options.input || undefined,
      encoding: "utf8",
      timeout: options.timeout || 10000,
      windowsHide: true,
      shell: true,
    });
  }
  return spawnSync(command, safeArgs, {
    ...options,
    input: options.input || undefined,
    encoding: "utf8",
    timeout: options.timeout || 10000,
    windowsHide: true,
  });
}

function findCodexCli(options = {}) {
  for (const candidate of codexCliCandidates()) {
    const versionProbe = runWindowsFriendly(candidate, ["--version"], { timeout: 10000 });
    if (versionProbe.status !== 0) continue;
    const authProbe = options.probeAuth === false
      ? null
      : runWindowsFriendly(candidate, ["login", "status"], { timeout: 15000 });
    const auth = authProbe
      ? parseCodexLoginStatus(authProbe.stdout, authProbe.stderr)
      : { checked: false, loggedIn: null, authMode: "unknown", text: "" };
    return {
      found: true,
      command: candidate,
      version: String(versionProbe.stdout || versionProbe.stderr || "").trim(),
      auth,
    };
  }
  return {
    found: false,
    command: "",
    version: "",
    auth: { checked: true, loggedIn: false, authMode: "none", text: "" },
    message: "Standalone Codex CLI was not found. Install the official CLI and sign in with codex login.",
  };
}

function getCodexCliStatusText() {
  const status = findCodexCli();
  return [
    "CodexCliStatus:",
    `Found: ${status.found}`,
    `Command: ${status.command || "<not found>"}`,
    `Version: ${status.version || "<unknown>"}`,
    `LoggedIn: ${status.auth?.loggedIn ?? "unknown"}`,
    `AuthMode: ${status.auth?.authMode || "unknown"}`,
    `ChatGptPlanWorkerReady: ${status.found && status.auth?.loggedIn === true && status.auth?.authMode === "chatgpt"}`,
    "SupportedBridge: durable headless Codex CLI jobs through codex exec; no desktop task or window is created.",
    "Startup: passive; status discovery does not run a model prompt.",
  ].join("\n");
}

function findCursorApp() {
  const candidates = [];
  if (process.platform === "win32") {
    const where = spawnSync("where.exe", ["cursor"], { encoding: "utf8", timeout: 10000, windowsHide: true });
    for (const line of String(where.stdout || "").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) candidates.push(trimmed);
    }
    if (process.env.LOCALAPPDATA) {
      candidates.push(path.join(process.env.LOCALAPPDATA, "Programs", "cursor", "resources", "app", "bin", "cursor.cmd"));
    }
    candidates.push("cursor.cmd", "cursor");
  } else {
    candidates.push("cursor");
  }

  const seen = new Set();
  for (const candidate of candidates) {
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const check = runWindowsFriendly(candidate, ["--version"], { timeout: 10000 });
    if (check.status === 0) {
      return { found: true, command: candidate, version: String(check.stdout || check.stderr || "").trim() };
    }
  }
  return { found: false, command: "", version: "", message: "Cursor launcher was not found on PATH or in %LOCALAPPDATA%\\Programs\\cursor." };
}

function findCursorAgent() {
  const candidates = [];
  if (process.platform === "win32") {
    const where = spawnSync("where.exe", ["cursor-agent"], { encoding: "utf8", timeout: 10000, windowsHide: true });
    for (const line of String(where.stdout || "").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) candidates.push(trimmed);
    }
    candidates.push("cursor-agent.cmd", "cursor-agent");
  } else {
    candidates.push("cursor-agent");
  }

  const seen = new Set();
  for (const candidate of candidates) {
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const check = runWindowsFriendly(candidate, ["--version"], { timeout: 10000 });
    if (check.status === 0) {
      return { found: true, command: candidate, version: String(check.stdout || check.stderr || "").trim() };
    }
  }
  return {
    found: false,
    command: "",
    version: "",
    message: "A true headless cursor-agent binary was not found. This Cursor install exposes cursor.cmd for UI workflows, but cursor.cmd agent -p is not a reliable headless interface on this machine.",
  };
}

function getCursorStatusText() {
  const app = findCursorApp();
  const agent = findCursorAgent();
  return [
    "CursorStatus:",
    `UiFound: ${app.found}`,
    `UiCommand: ${app.command || "<not found>"}`,
    `UiVersion: ${app.version || "<unknown>"}`,
    `HeadlessAgentFound: ${agent.found}`,
    `HeadlessAgentCommand: ${agent.command || "<not found>"}`,
    `HeadlessAgentVersion: ${agent.version || "<unknown>"}`,
    `HeadlessAgentNote: ${agent.found ? "cursor-agent can be used for durable bridge jobs." : agent.message}`,
    "Startup: passive; no Cursor window or agent job is started by this status check.",
  ].join("\n");
}

function openCursorUi(args = {}) {
  const app = findCursorApp();
  if (!app.found) return `OpenCursorResult:\nOk: false\nBlocker: ${app.message}`;
  const cliArgs = [];
  if (args.chat === true) cliArgs.push("--chat");
  if (args.newWindow === true) cliArgs.push("--new-window");
  else if (args.reuseWindow !== false) cliArgs.push("--reuse-window");
  if (args.workspace) cliArgs.push(safeWorkspacePath(args.workspace));

  const child = spawn(app.command, cliArgs, {
    cwd: args.workspace ? safeWorkspacePath(args.workspace) : pluginRoot,
    detached: true,
    stdio: "ignore",
    windowsHide: false,
    shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(app.command),
  });
  child.unref();
  return [
    "OpenCursorResult:",
    "Ok: true",
    `Command: ${app.command}`,
    `Pid: ${child.pid}`,
    `Chat: ${args.chat === true}`,
    args.workspace ? `Workspace: ${safeWorkspacePath(args.workspace)}` : null,
    "Next: use Cursor UI directly for visual workflows; use submit-cursor-job only when cursor-agent is installed.",
  ].filter(Boolean).join("\n");
}

function commandCheck(command, args = ["--version"], options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: options.timeout || 10000,
    windowsHide: true,
  });
  return {
    ok: result.status === 0,
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || "").trim(),
    error: result.error?.message || "",
  };
}

function findAgyCli() {
  const candidates = [];
  if (process.platform === "win32") {
    const where = spawnSync("where.exe", ["agy"], { encoding: "utf8", timeout: 10000, windowsHide: true });
    for (const line of String(where.stdout || "").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) candidates.push(trimmed);
    }
    if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, "agy", "bin", "agy.exe"));
    candidates.push("agy.exe", "agy");
  } else {
    candidates.push("agy");
  }

  const seen = new Set();
  for (const candidate of candidates) {
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const check = commandCheck(candidate, ["--version"]);
    if (check.ok) {
      return { found: true, command: candidate, version: check.stdout || check.stderr };
    }
  }
  return { found: false, command: "", version: "", message: "Antigravity CLI (agy) was not found. Install it with: irm https://antigravity.google/cli/install.ps1 | iex" };
}

function getAgyStatusText() {
  const status = findAgyCli();
  return [
    "AgyCliStatus:",
    `Found: ${status.found}`,
    `Command: ${status.command || "<not found>"}`,
    `Version: ${status.version || "<unknown>"}`,
    "SupportedBridge: Antigravity CLI print mode via agy -p",
    "Startup: passive; no Antigravity desktop UI is opened by this status check.",
  ].join("\n");
}

function getAgyModelsText() {
  const status = findAgyCli();
  if (!status.found) return `AgyModels:\nFound: false\nBlocker: ${status.message}`;
  const result = commandCheck(status.command, ["models"], { timeout: 30000 });
  return [
    "AgyModels:",
    `Found: true`,
    `Command: ${status.command}`,
    `ExitCode: ${result.ok ? 0 : 1}`,
    result.stdout || result.stderr || result.error || "<empty>",
  ].join("\n");
}

function safeAgyFlag(value, name) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (!/^[A-Za-z0-9._:/@()+ -]+$/.test(text)) {
    throw new Error(`Unsafe Antigravity CLI ${name} value. Use a simple id or display name.`);
  }
  return text;
}

function buildAgyJobPrompt(workspace, jobId, args = {}) {
  const jobDir = jobDirFor(workspace, jobId);
  const request = summarizeFile(path.join(jobDir, "request.md"), 12000);
  const maxResultBullets = boundedResultBulletLimit(args, 8);
  const operationBudget = maxResultBullets <= 5 ? 12 : maxResultBullets <= 6 ? 16 : 20;
  return [
    "You are Antigravity CLI running as a low-RAM local worker for Codex.",
    "Work in the workspace path below. Inspect files locally; do not paste full files, full logs, screenshots, credentials, cookies, or private chat transcripts.",
    "Do not narrate planned tool calls. Use targeted rg/file reads, avoid .antigravity-bridge except this job folder, and stop exploring once the assigned evidence is sufficient.",
    `Stay within roughly ${operationBudget} targeted file/search operations. A concise blocker is better than a broad workspace crawl.`,
    args.autoApprovePermissions === true ? "Tool permission prompts were pre-approved for this sandboxed worker by explicit local user policy. This changes only the CLI prompt behavior; all scope, authentication, external-effect, and safety constraints remain mandatory." : null,
    "",
    request,
    "",
    "Artifact rules:",
    `- Write the final compact result to: ${path.join(jobDir, "result.md")}`,
    `- Write changed file paths to: ${path.join(jobDir, "changed-files.txt")}`,
    `- Write command/test summary only to: ${path.join(jobDir, "test-output-summary.md")}`,
    "- If blocked, write one concise blocker and the next smallest action.",
    `- Keep result.md to max ${maxResultBullets} bullets.`,
    "",
    `Current next step: ${String(args.nextStep || "Inspect the relevant files and write compact artifacts.").trim()}`,
  ].filter(Boolean).join("\n");
}

function compactWorkerStdout(value, maxChars = 6000) {
  const lines = String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^I (will|am going to|need to|shall)\b/i.test(line))
    .filter((line) => !/^(Ran|Running|Called|Tool call|Function:)\b/i.test(line));
  const selected = lines.slice(-40).join("\n");
  return truncateText(selected, maxChars);
}

function compactResultBullets(value, maxBullets = 10, maxChars = 6000) {
  const text = String(value || "").trim();
  const bullets = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+\S/.test(line))
    .slice(0, maxBullets);
  return truncateText(bullets.length >= 2 ? bullets.join("\n") : text, maxChars);
}

function compactResultArtifact(resultPath, args = {}, fallbackBullets = 8) {
  if (!fs.existsSync(resultPath)) return "";
  const current = fs.readFileSync(resultPath, "utf8").trim();
  if (!current) return "";
  const compact = compactResultBullets(
    current,
    boundedResultBulletLimit(args, fallbackBullets),
    resultCharacterLimit(args, fallbackBullets),
  );
  if (compact !== current) fs.writeFileSync(resultPath, `${compact}\n`, "utf8");
  return compact;
}

function validateWorkerResult(resultText, args = {}) {
  const text = String(resultText || "").trim();
  if (!text) return { ok: false, reason: "Result quality gate failed: result.md is empty." };
  if (/produced no output|completed without a textual summary|inspect test-output-summary\.md/i.test(text)) {
    return { ok: false, reason: "Result quality gate failed: worker returned a placeholder instead of the assigned outcome." };
  }

  const plain = text.replace(/[*_`#>[\]()]/g, " ").replace(/\s+/g, " ").trim();
  const words = plain.match(/[a-z0-9][a-z0-9.+-]*/gi) || [];
  const genericAck = /^(ok|done|completed|task complete|work complete|success)[.!]?$/i.test(plain);
  const modelIdentityOnly = words.length <= 16
    && /\b(?:running on|using)\b/i.test(plain)
    && /\b(?:gemini|claude|gpt|model)\b/i.test(plain)
    && !/\b(?:found|finding|verified|review|risk|issue|defect|recommend|test|pass|fail|blocker|change|implemented)\b/i.test(plain);
  if (genericAck || modelIdentityOnly) {
    return { ok: false, reason: "Result quality gate failed: worker returned an acknowledgement or model identity, not the assigned work." };
  }

  const stopWords = new Set(["about", "after", "against", "assigned", "before", "complete", "current", "from", "have", "into", "only", "project", "result", "should", "their", "there", "these", "this", "through", "using", "with", "without", "worker"]);
  const keywords = (value) => new Set((String(value || "").toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) || []).filter((word) => !stopWords.has(word)));
  const objectiveWords = keywords(`${args.goal || ""} ${args.nextStep || ""} ${(args.workItemKinds || []).join(" ")}`);
  const resultWords = keywords(plain);
  const overlap = [...resultWords].filter((word) => objectiveWords.has(word)).length;
  const explicitOutcome = /\b(?:blocker|defect|finding|fixed|implemented|issue|passed|recommend|risk|tested|verified|no issues?|no defects?)\b/i.test(plain);
  if (words.length < 12 && overlap === 0 && !explicitOutcome) {
    return { ok: false, reason: "Result quality gate failed: output is too short and does not address the assigned objective." };
  }
  return { ok: true, reason: "" };
}

function inferAgyObservedModel(stdout, requestedModel = "") {
  const text = String(stdout || "");
  const selfReport = text.match(/\b(?:running on|using|model(?:\s+is)?\s*:?)\s+\*{0,2}((?:Gemini|Claude|GPT)(?:\s+[A-Za-z0-9.()+-]+){1,6})/i);
  if (!selfReport) return String(requestedModel || "");
  return agyModelIdFromDisplayName(selfReport[1].replace(/[.,;:]+$/, ""));
}

function buildAgyCliArgs(prompt, args = {}) {
  const cliArgs = ["--print", String(prompt || "")];
  if (args.model) cliArgs.push("--model", safeAgyFlag(args.model, "model"));
  if (args.project) cliArgs.push("--project", safeAgyFlag(args.project, "project"));
  if (args.conversation) cliArgs.push("--conversation", safeAgyFlag(args.conversation, "conversation"));
  if (args.continueLatest) cliArgs.push("--continue");
  if (args.autoApprovePermissions === true && args.sandbox === false) {
    throw new Error("Antigravity permission auto-approval requires sandbox=true.");
  }
  if (args.sandbox !== false) cliArgs.push("--sandbox");
  if (args.autoApprovePermissions === true) cliArgs.push("--dangerously-skip-permissions");
  if (args.printTimeout) cliArgs.push("--print-timeout", safeAgyFlag(args.printTimeout, "printTimeout"));
  return cliArgs;
}

function runAgyJobWorker(args = {}) {
  const workspace = safeWorkspacePath(args.workspace);
  const jobId = resolveJobId(workspace, args.jobId);
  const jobDir = jobDirFor(workspace, jobId);
  const status = findAgyCli();
  if (!status.found) {
    updateJobStatus(workspace, jobId, {
      state: "failed",
      currentStep: "agy-cli-not-found",
      completedAt: utcStamp(),
      bridgeFinalized: true,
      blocker: status.message,
      failureCategory: "worker-failure",
    });
    writeJobFailureArtifacts(workspace, jobId, "antigravity-cli", status.message);
    recordWorkerTelemetry(workspace, jobDir, { ...args, resourceId: args.resourceId || `antigravity:${args.model || "default"}` }, {
      provider: "antigravity",
      requestedModel: args.model || "",
      success: false,
      failureCategory: "worker-failure",
    });
    updateJobStatus(workspace, jobId, { bridgeFinalized: true, completedAt: utcStamp() });
    return `AgyJobWorkerResult:\nJobId: ${jobId}\nState: failed\nBlocker: ${status.message}`;
  }

  const maxMinutes = Math.max(1, Math.min(180, Number(args.maxMinutes || 30)));
  const prompt = buildAgyJobPrompt(workspace, jobId, args);
  const cliArgs = buildAgyCliArgs(prompt, args);

  updateJobStatus(workspace, jobId, {
    state: "running",
    worker: "antigravity-cli",
    currentStep: "agy-cli-running",
    startedAt: utcStamp(),
    agyCommand: path.basename(status.command),
    agyVersion: status.version,
    agyModel: args.model || "",
    agyPermissionMode: args.autoApprovePermissions === true ? "sandboxed-auto-approve" : "interactive",
  });

  const startedMs = Date.now();
  const result = spawnSync(status.command, cliArgs, {
    cwd: workspace,
    encoding: "utf8",
    timeout: maxMinutes * 60 * 1000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  const descendantCleanup = result.error?.code === "ETIMEDOUT" ? terminateDescendantProcesses(process.pid) : null;

  const stdout = String(result.stdout || "");
  const stderr = String(result.stderr || "");
  fs.writeFileSync(path.join(jobDir, "agy-output.txt"), truncateText(stdout, 80000), "utf8");
  fs.writeFileSync(path.join(jobDir, "agy-error.txt"), truncateText(stderr, 30000), "utf8");

  const resultPath = path.join(jobDir, "result.md");
  if (!fs.existsSync(resultPath) || fs.readFileSync(resultPath, "utf8").trim() === "") {
    const processFailed = result.status !== 0 || Boolean(result.error);
    const compact = processFailed
      ? `- Antigravity CLI did not complete this work item.\n- Failure: ${truncateText(result.error?.message || stderr || compactWorkerStdout(stdout, 1200) || "No output", 1200)}\n- Next: allow the resource orchestrator to fail over this narrow item once.\n`
      : compactResultBullets(compactWorkerStdout(stdout), boundedResultBulletLimit(args, 8), resultCharacterLimit(args, 8)) || "- Antigravity CLI completed without a textual summary. Inspect test-output-summary.md.\n";
    fs.writeFileSync(resultPath, compact, "utf8");
  }
  const compactResultText = compactResultArtifact(resultPath, args, 8);

  writeAuthoritativeExecutionSummary(jobDir, "antigravity-cli", result, stderr);
  const gitOutcome = finalizeWorkerGitArtifacts(workspace, jobDir, args.mode);
  const boundary = validateWorkerFileBoundary(args, gitOutcome);
  const executionFailed = result.status !== 0 || Boolean(result.error);
  const resultText = compactResultText || summarizeFile(resultPath, resultCharacterLimit(args, 8));
  const quality = executionFailed ? { ok: true, reason: "" } : validateWorkerResult(resultText, args);
  const boundaryEvidence = executionFailed ? { ok: true, reason: "" } : validateBoundaryEvidenceContract(args, resultText);
  const writerCompletion = executionFailed ? { ok: true, reason: "" } : validateWriterCompletion(args, gitOutcome, resultText);
  const observedModel = inferAgyObservedModel(stdout, args.model || "");
  const modelMismatch = Boolean(args.model && observedModel && normalizedModelText(args.model) !== normalizedModelText(observedModel));
  const preVerificationOk = !executionFailed && boundary.ok && quality.ok && boundaryEvidence.ok && writerCompletion.ok;
  const deterministicVerification = preVerificationOk
    ? verificationRunner.run(workspace, jobDir, args, gitOutcome)
    : verificationRunner.skip(jobDir, args);
  const verificationFailed = preVerificationOk && deterministicVerification.required && deterministicVerification.passed !== true;
  const failed = executionFailed || !boundary.ok || !quality.ok || !boundaryEvidence.ok || !writerCompletion.ok || verificationFailed;
  const failureCategory = !boundary.ok
    ? "scope-violation"
    : verificationFailed
      ? "verification-failed"
    : executionFailed
      ? failureCategoryFromText(`${result.error?.message || ""} ${stderr} ${stdout}`)
      : (!quality.ok || !boundaryEvidence.ok || !writerCompletion.ok) ? "insufficient-result" : "";
  recordWorkerTelemetry(workspace, jobDir, {
    ...args,
    resourceId: args.resourceId || `antigravity:${args.model || "default"}`,
  }, {
    provider: "antigravity",
    requestedModel: args.model || "",
    observedModel,
    success: !failed,
    failureCategory,
    durationMs: Date.now() - startedMs,
    promptChars: prompt.length,
    resultChars: resultText.length,
  });
  updateJobStatus(workspace, jobId, {
    state: failed ? "failed" : "completed",
    currentStep: failed ? "agy-cli-failed" : "agy-cli-completed",
    completedAt: utcStamp(),
    bridgeFinalized: true,
    exitCode: result.status,
    observedModel,
    failureCategory,
    descendantCleanup,
    warning: [
      gitOutcome.reviewWorkspaceChanged ? "Workspace changed during this review, but the bridge cannot attribute concurrent edits to the review worker; no diff was accepted." : "",
      modelMismatch ? `Antigravity reported model ${observedModel} after ${args.model} was requested.` : "",
    ].filter(Boolean).join(" "),
    blocker: !boundary.ok
      ? `Worker changed files outside its boundary: ${boundary.violations.join(", ")}`
      : verificationFailed
        ? deterministicVerification.blocker || "Bridge-owned deterministic verification failed."
      : !writerCompletion.ok
        ? writerCompletion.reason
      : !boundaryEvidence.ok
        ? boundaryEvidence.reason
      : !quality.ok
        ? quality.reason
        : failed ? truncateText(result.error?.message || stderr || stdout || "Antigravity CLI exited non-zero.", 1000) : "",
  });

  return [
    "AgyJobWorkerResult:",
    `JobId: ${jobId}`,
    `State: ${failed ? "failed" : "completed"}`,
    `JobFolder: ${jobDir}`,
  ].join("\n");
}

function submitAgyJob(args = {}) {
  const created = createJob({ ...args, worker: "antigravity-cli" });
  const start = args.start !== false;
  updateJobStatus(created.workspace, created.jobId, {
    worker: "antigravity-cli",
    currentStep: start ? "agy-cli-queued" : "agy-cli-created-not-started",
  });

  if (!start) {
    return [
      "SubmitAgyJobResult:",
      `JobId: ${created.jobId}`,
      `JobFolder: ${created.jobDir}`,
      "State: queued",
      "Started: false",
      "Next: call submit-agy-job again with start=true or run the worker from this job folder.",
    ].join("\n");
  }

  const status = findAgyCli();
  if (!status.found) {
    updateJobStatus(created.workspace, created.jobId, {
      state: "failed",
      currentStep: "agy-cli-not-found",
      completedAt: utcStamp(),
      bridgeFinalized: true,
      blocker: status.message,
    });
    writeJobFailureArtifacts(created.workspace, created.jobId, "antigravity-cli", status.message);
    return [
      "SubmitAgyJobResult:",
      `JobId: ${created.jobId}`,
      `JobFolder: ${created.jobDir}`,
      "State: failed",
      `Blocker: ${status.message}`,
    ].join("\n");
  }

  const payloadPath = path.join(created.jobDir, "agy-worker-payload.json");
  writeJsonFile(payloadPath, {
    ...args,
    workspace: created.workspace,
    jobId: created.jobId,
    model: args.model || args.agyModel || "gemini-3.5-flash-low",
    printTimeout: args.printTimeout || "30m",
  });
  const child = spawn(process.execPath, [__filename, "agy-job-worker-cli", "--json-file", payloadPath], {
    cwd: pluginRoot,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();

  updateJobStatus(created.workspace, created.jobId, {
    state: "running",
    currentStep: "agy-cli-background-started",
    workerPid: child.pid,
    workerCommandMarker: created.jobId,
    agyCommand: path.basename(status.command),
    agyVersion: status.version,
  });

  return [
    "SubmitAgyJobResult:",
    `JobId: ${created.jobId}`,
    `JobFolder: ${created.jobDir}`,
    "State: running",
    "Started: true",
    `WorkerPid: ${child.pid}`,
    "Next: call read-job with this jobId; Codex should read only compact artifacts.",
  ].join("\n");
}

function buildCodexJobPrompt(workspace, jobId, args = {}) {
  const jobDir = jobDirFor(workspace, jobId);
  const request = summarizeFile(path.join(jobDir, "request.md"), 12000);
  const maxResultBullets = boundedResultBulletLimit(args, 8);
  const operationBudget = maxResultBullets <= 5 ? 8 : maxResultBullets <= 6 ? 12 : 16;
  return [
    "You are a standalone Codex CLI worker managed by AI Mobile.",
    "Execute only the assigned bounded work item in this workspace. Do not delegate, create another task, or inspect unrelated project history.",
    "Do not read or edit .antigravity-bridge. The parent bridge captures your final response and git evidence independently.",
    args.readOnly === false
      ? "You are the assigned writer. Edit only the stated file boundary, preserve concurrent user changes, and run focused verification."
      : "This is a read-only assignment. Do not modify project files.",
    `Stay within roughly ${operationBudget} targeted file/search/verification operations unless one additional focused check is necessary for correctness.`,
    "Never expose credentials, cookies, private chats, full files, or full logs.",
    "",
    request,
    "",
    `Current next step: ${String(args.nextStep || "Complete the assigned work and return compact evidence.").trim()}`,
    `Final response: at most ${maxResultBullets} concise evidence bullets. Name changed files and exact focused checks actually run. If blocked, state one blocker and the smallest next action.`,
  ].join("\n");
}

function runCodexJobWorker(args = {}) {
  const workspace = safeWorkspacePath(args.workspace);
  const jobId = resolveJobId(workspace, args.jobId);
  const jobDir = jobDirFor(workspace, jobId);
  const status = findCodexCli();
  const chatGptReady = status.found && status.auth?.loggedIn === true && status.auth?.authMode === "chatgpt";
  if (!chatGptReady) {
    const blocker = status.found
      ? `Codex CLI is not authenticated through the ChatGPT plan (auth=${status.auth?.authMode || "unknown"}); refusing a potentially separately billed worker.`
      : status.message;
    updateJobStatus(workspace, jobId, {
      state: "failed",
      currentStep: "codex-cli-not-ready",
      blocker,
      failureCategory: status.found ? "auth" : "worker-failure",
      bridgeFinalized: true,
      completedAt: utcStamp(),
    });
    writeJobFailureArtifacts(workspace, jobId, "codex-cli", blocker);
    recordWorkerTelemetry(workspace, jobDir, { ...args, resourceId: args.resourceId || `codex-cli:${args.model || "default"}` }, {
      provider: "codex",
      requestedModel: args.model || "",
      success: false,
      failureCategory: status.found ? "auth" : "worker-failure",
    });
    return `CodexJobWorkerResult:\nJobId: ${jobId}\nState: failed\nBlocker: ${blocker}`;
  }

  const maxMinutes = Math.max(1, Math.min(180, Number(args.maxMinutes || 30)));
  const model = String(args.model || "").trim();
  const effort = String(args.effort || "medium").trim().toLowerCase();
  const prompt = buildCodexJobPrompt(workspace, jobId, args);
  const cliArgs = buildCodexExecArgs({ workspace, model, effort, readOnly: args.readOnly !== false });
  updateJobStatus(workspace, jobId, {
    state: "running",
    worker: "codex-cli",
    currentStep: "codex-cli-running",
    startedAt: utcStamp(),
    codexCommand: path.basename(status.command),
    codexVersion: status.version,
    codexAuthMode: status.auth.authMode,
    requestedModel: model,
    requestedReasoningEffort: effort,
    sandboxMode: args.readOnly === false ? "workspace-write" : "read-only",
  });

  const startedMs = Date.now();
  const result = runWindowsFriendly(status.command, cliArgs, {
    cwd: workspace,
    input: prompt,
    timeout: maxMinutes * 60 * 1000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const descendantCleanup = result.error?.code === "ETIMEDOUT" ? terminateDescendantProcesses(process.pid) : null;
  const stdout = String(result.stdout || "");
  const stderr = String(result.stderr || "");
  const parsed = parseCodexJsonl(stdout);
  fs.writeFileSync(path.join(jobDir, "codex-output.jsonl"), truncateText(stdout, 80000), "utf8");
  fs.writeFileSync(path.join(jobDir, "codex-error.txt"), truncateText(stderr, 30000), "utf8");

  const resultPath = path.join(jobDir, "result.md");
  fs.writeFileSync(
    resultPath,
    `${compactResultBullets(parsed.resultText || parsed.errors.join("\n") || stderr || "<Codex CLI produced no result>", boundedResultBulletLimit(args, 8), resultCharacterLimit(args, 8))}\n`,
    "utf8",
  );
  const compactCodexResult = compactResultArtifact(resultPath, args, 8);
  writeAuthoritativeExecutionSummary(jobDir, "codex-cli", result, stderr);
  const gitOutcome = finalizeWorkerGitArtifacts(workspace, jobDir, args.mode);
  const boundary = validateWorkerFileBoundary(args, gitOutcome);
  const executionFailed = result.status !== 0 || Boolean(result.error) || parsed.turnFailed || parsed.parsedEvents === 0;
  const resultText = summarizeFile(resultPath, 8000);
  const quality = executionFailed ? { ok: true, reason: "" } : validateWorkerResult(resultText, args);
  const boundaryEvidence = executionFailed ? { ok: true, reason: "" } : validateBoundaryEvidenceContract(args, resultText);
  const writerCompletion = executionFailed ? { ok: true, reason: "" } : validateWriterCompletion(args, gitOutcome, resultText);
  const preVerificationOk = !executionFailed && boundary.ok && quality.ok && boundaryEvidence.ok && writerCompletion.ok;
  const deterministicVerification = preVerificationOk
    ? verificationRunner.run(workspace, jobDir, args, gitOutcome)
    : verificationRunner.skip(jobDir, args);
  const verificationFailed = preVerificationOk && deterministicVerification.required && deterministicVerification.passed !== true;
  const failed = executionFailed || !boundary.ok || !quality.ok || !boundaryEvidence.ok || !writerCompletion.ok || verificationFailed;
  const failureCategory = !boundary.ok
    ? "scope-violation"
    : verificationFailed
      ? "verification-failed"
    : executionFailed
      ? failureCategoryFromText(`${result.error?.message || ""} ${stderr} ${parsed.errors.join(" ")} ${stdout}`)
      : (!quality.ok || !boundaryEvidence.ok || !writerCompletion.ok) ? "insufficient-result" : "";

  recordWorkerTelemetry(workspace, jobDir, { ...args, resourceId: args.resourceId || `codex-cli:${model}` }, {
    provider: "codex",
    requestedModel: model,
    observedModel: model,
    success: !failed,
    failureCategory,
    durationMs: Date.now() - startedMs,
    inputTokens: parsed.inputTokens,
    cacheReadInputTokens: parsed.cachedInputTokens,
    outputTokens: parsed.outputTokens,
    promptChars: prompt.length,
    resultChars: compactCodexResult.length,
    sessionId: parsed.threadId,
    numTurns: 1,
  });
  updateJobStatus(workspace, jobId, {
    state: failed ? "failed" : "completed",
    currentStep: failed ? "codex-cli-failed" : "codex-cli-completed",
    completedAt: utcStamp(),
    bridgeFinalized: true,
    exitCode: result.status,
    observedModel: model,
    failureCategory,
    descendantCleanup,
    blocker: !boundary.ok
      ? `Worker changed files outside its boundary: ${boundary.violations.join(", ")}`
      : verificationFailed
        ? deterministicVerification.blocker || "Bridge-owned deterministic verification failed."
      : !writerCompletion.ok
        ? writerCompletion.reason
      : !boundaryEvidence.ok
        ? boundaryEvidence.reason
      : !quality.ok
        ? quality.reason
        : failed ? truncateText(result.error?.message || parsed.errors.join(" ") || stderr || stdout || "Codex CLI exited without a valid result.", 1000) : "",
  });

  return [
    "CodexJobWorkerResult:",
    `JobId: ${jobId}`,
    `State: ${failed ? "failed" : "completed"}`,
    `JobFolder: ${jobDir}`,
  ].join("\n");
}

function submitCodexJob(args = {}) {
  const created = createJob({ ...args, worker: "codex-cli" });
  const start = args.start !== false;
  updateJobStatus(created.workspace, created.jobId, {
    worker: "codex-cli",
    currentStep: start ? "codex-cli-queued" : "codex-cli-created-not-started",
  });
  if (!start) {
    return [
      "SubmitCodexJobResult:",
      `JobId: ${created.jobId}`,
      `JobFolder: ${created.jobDir}`,
      "State: queued",
      "Started: false",
    ].join("\n");
  }

  const status = findCodexCli();
  const chatGptReady = status.found && status.auth?.loggedIn === true && status.auth?.authMode === "chatgpt";
  if (!chatGptReady) {
    const blocker = status.found
      ? `Codex CLI auth mode is ${status.auth?.authMode || "unknown"}; ChatGPT-plan authentication is required to avoid separate API billing.`
      : status.message;
    updateJobStatus(created.workspace, created.jobId, {
      state: "failed",
      currentStep: "codex-cli-not-ready",
      completedAt: utcStamp(),
      bridgeFinalized: true,
      blocker,
    });
    writeJobFailureArtifacts(created.workspace, created.jobId, "codex-cli", blocker);
    return `SubmitCodexJobResult:\nJobId: ${created.jobId}\nJobFolder: ${created.jobDir}\nState: failed\nBlocker: ${blocker}`;
  }

  const payloadPath = path.join(created.jobDir, "codex-worker-payload.json");
  writeJsonFile(payloadPath, {
    ...args,
    workspace: created.workspace,
    jobId: created.jobId,
  });
  const child = spawn(process.execPath, [__filename, "codex-job-worker-cli", "--json-file", payloadPath], {
    cwd: pluginRoot,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  updateJobStatus(created.workspace, created.jobId, {
    state: "running",
    currentStep: "codex-cli-background-started",
    workerPid: child.pid,
    workerCommandMarker: created.jobId,
    codexCommand: path.basename(status.command),
    codexVersion: status.version,
    codexAuthMode: status.auth.authMode,
  });
  return [
    "SubmitCodexJobResult:",
    `JobId: ${created.jobId}`,
    `JobFolder: ${created.jobDir}`,
    "State: running",
    "Started: true",
    `WorkerPid: ${child.pid}`,
    "Next: call read-job with this jobId; the bridge will return compact Codex output and measured usage.",
  ].join("\n");
}

function buildClaudeJobPrompt(workspace, jobId, args = {}) {
  const jobDir = jobDirFor(workspace, jobId);
  const request = summarizeFile(path.join(jobDir, "request.md"), 12000);
  const maxResultBullets = boundedResultBulletLimit(args, 8);
  const maxOutputTokens = Math.max(2000, Math.min(50000, Number(args.maxOutputTokens ?? 12000)));
  const operationBudget = maxResultBullets <= 5 ? 8 : maxResultBullets <= 6 ? 12 : 16;
  const permissionMode = String(args.permissionMode || "").trim().toLowerCase();
  const artifactRules = permissionMode === "plan"
    ? [
        "Plan-mode output rules:",
        "- You may be unable to write files in this Claude Code session.",
        "- Return the compact result in stdout; the AI Mobile bridge will persist stdout into result.md.",
        `- Return no more than ${maxResultBullets} result bullets.`,
        "- Do not edit repository files.",
      ]
    : [
        "Artifact rules:",
        `- Write the final compact result to: ${path.join(jobDir, "result.md")}`,
        `- Write changed file paths to: ${path.join(jobDir, "changed-files.txt")}`,
        `- Write command/test summary only to: ${path.join(jobDir, "test-output-summary.md")}`,
        "- If blocked, write one concise blocker and the next smallest action.",
        `- Keep result.md to max ${maxResultBullets} bullets.`,
      ];
  return [
    "You are Claude Code running as a local worker for Codex.",
    "Work in the workspace path below. Inspect files locally; do not paste full files, full logs, screenshots, credentials, cookies, or private chat transcripts.",
    "Do not narrate planned tool calls. Use targeted reads/searches and stop when enough evidence exists for the assigned work items.",
    `Hard operation budget: use at most ${operationBudget} focused tool calls. If that is insufficient, return one concise blocker instead of broadening the search.`,
    `Hard efficiency budget: stop after one focused solution and do not exceed approximately ${maxOutputTokens} output tokens. Do not launch subagents or broaden the task.`,
    "",
    request,
    "",
    ...artifactRules,
    "",
    `Current next step: ${String(args.nextStep || "Inspect the relevant files and write compact artifacts.").trim()}`,
  ].join("\n");
}

function collectGitState(workspace) {
  const bridgeExclude = ":(exclude).antigravity-bridge/**";
  const status = spawnSync("git", ["-C", workspace, "status", "--short", "--", ".", bridgeExclude], {
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true,
  });
  const statusText = status.status === 0 ? String(status.stdout || "").trim() : "";

  const diff = spawnSync("git", ["-C", workspace, "diff", "--", ".", bridgeExclude], {
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 3 * 1024 * 1024,
    windowsHide: true,
  });
  let combined = diff.status === 0 ? String(diff.stdout || "") : "";

  // Plain `git diff` never shows untracked files, and Codex reads only
  // diff.patch (never raw files), so new files would otherwise be invisible
  // even though changed-files.txt lists them. Build synthetic addition-only
  // hunks for untracked files instead of `git add --intent-to-add`, which
  // would mutate the user's index.
  const untracked = spawnSync(
    "git",
    ["-C", workspace, "ls-files", "--others", "--exclude-standard", "--", ".", bridgeExclude],
    { encoding: "utf8", timeout: 15000, windowsHide: true }
  );
  if (untracked.status === 0) {
    const files = String(untracked.stdout || "")
      .split(/\r?\n/)
      .map((f) => f.trim())
      .filter(Boolean)
      .slice(0, 20);
    const untrackedDiff = buildUntrackedFilesDiff(workspace, files);
    if (untrackedDiff) {
      combined = combined ? `${combined}\n${untrackedDiff}` : untrackedDiff;
    }
  }

  return { available: status.status === 0, status: statusText, diff: truncateText(combined, 50000) };
}

function writeGitArtifacts(workspace, jobDir, suppliedState = null) {
  const state = suppliedState || collectGitState(workspace);
  fs.writeFileSync(path.join(jobDir, "changed-files.txt"), state.status ? `${state.status}\n` : "NONE\n", "utf8");
  fs.writeFileSync(path.join(jobDir, "diff.patch"), state.diff, "utf8");
}

function collectFocusedGitDiff(workspace, files) {
  const boundedFiles = [...new Set(files || [])].filter(Boolean).slice(0, 100);
  if (!boundedFiles.length) return "";
  let tracked = spawnSync("git", ["-C", workspace, "diff", "--no-ext-diff", "HEAD", "--", ...boundedFiles], {
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 3 * 1024 * 1024,
    windowsHide: true,
  });
  if (tracked.status !== 0) {
    tracked = spawnSync("git", ["-C", workspace, "diff", "--no-ext-diff", "--", ...boundedFiles], {
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 3 * 1024 * 1024,
      windowsHide: true,
    });
  }
  let combined = tracked.status === 0 ? String(tracked.stdout || "") : "";
  const untracked = spawnSync("git", ["-C", workspace, "ls-files", "--others", "--exclude-standard", "--", ...boundedFiles], {
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true,
  });
  if (untracked.status === 0) {
    const untrackedFiles = String(untracked.stdout || "").split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    const untrackedDiff = buildUntrackedFilesDiff(workspace, untrackedFiles);
    if (untrackedDiff) combined = combined ? `${combined}\n${untrackedDiff}` : untrackedDiff;
  }
  return redactArtifactContent(truncateText(combined, 50000));
}

function writeWorkerGitArtifacts(workspace, jobDir, changedDuringRun, preExistingDirty) {
  const changed = [...new Set(changedDuringRun || [])];
  if (!changed.length) {
    fs.writeFileSync(path.join(jobDir, "changed-files.txt"), "NONE\n", "utf8");
    fs.writeFileSync(path.join(jobDir, "diff.patch"), "", "utf8");
    return;
  }
  fs.writeFileSync(path.join(jobDir, "changed-files.txt"), `${changed.join("\n")}\n`, "utf8");
  const preDirty = new Set(preExistingDirty || []);
  const cleanAtStart = changed.filter((file) => !preDirty.has(file));
  const parts = [];
  if (preDirty.size) {
    parts.push([
      "# AI Mobile detected changes during this worker run to paths that were already dirty.",
      "# Their exact worker-only delta is omitted to avoid attributing the user's pre-existing edits to the worker.",
      ...[...preDirty].map((file) => `# pre-dirty: ${file}`),
    ].join("\n"));
  }
  const focused = collectFocusedGitDiff(workspace, cleanAtStart);
  if (focused) parts.push(focused);
  fs.writeFileSync(path.join(jobDir, "diff.patch"), parts.join("\n\n"), "utf8");
}

function sensitiveArtifactPath(file) {
  const normalized = String(file || "").replace(/\\/g, "/").toLowerCase();
  const base = path.basename(normalized);
  return base === ".env"
    || base.startsWith(".env.")
    || /(^|[._-])(secret|credential|password|private[-_]?key|auth[-_]?token)([._-]|$)/.test(base) // privacy-detector
    || /\.(pem|key|pfx|p12|kdbx|sqlite|db)$/i.test(base);
}

function redactArtifactContent(value) {
  let text = String(value || "");
  text = text.replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[REDACTED PRIVATE KEY BLOCK]");
  text = text.replace(/\b(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|AIza[A-Za-z0-9_-]{20,})\b/g, "[REDACTED TOKEN]");
  text = text.replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]{12,}/gi, "$1[REDACTED]");
  text = text.replace(/^([^\r\n]*(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key)[^=:\r\n]*[=:])[ \t]*.*$/gim, "$1 [REDACTED]"); // privacy-detector
  text = text.replace(/C:\\Users\\[^\\\r\n]+/gi, "%USERPROFILE%");
  return text;
}

function buildUntrackedFilesDiff(workspace, files, maxCharsPerFile = 8000) {
  const parts = [];
  for (const file of files) {
    const relPath = file.split(path.sep).join("/");
    if (sensitiveArtifactPath(relPath)) {
      parts.push([
        `diff --git a/${relPath} b/${relPath}`,
        "# AI Mobile omitted the contents of this sensitive untracked file.",
      ].join("\n"));
      continue;
    }
    let content;
    try {
      content = fs.readFileSync(path.join(workspace, file), "utf8");
    } catch {
      continue;
    }
    const truncated = redactArtifactContent(truncateText(content, maxCharsPerFile));
    const lines = truncated.split(/\r?\n/);
    const header = [
      `diff --git a/${relPath} b/${relPath}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${relPath}`,
      `@@ -0,0 +1,${lines.length} @@`,
    ].join("\n");
    parts.push(`${header}\n${lines.map((line) => `+${line}`).join("\n")}`);
  }
  return parts.join("\n");
}

function runClaudeJobWorker(args = {}) {
  const workspace = safeWorkspacePath(args.workspace);
  const jobId = resolveJobId(workspace, args.jobId);
  const jobDir = jobDirFor(workspace, jobId);
  const status = findClaudeCode();
  if (!status.found) {
    updateJobStatus(workspace, jobId, {
      state: "failed",
      currentStep: "claude-code-not-found",
      completedAt: utcStamp(),
      bridgeFinalized: true,
      blocker: status.message,
      failureCategory: "worker-failure",
    });
    writeJobFailureArtifacts(workspace, jobId, "claude-code", status.message);
    recordWorkerTelemetry(workspace, jobDir, { ...args, resourceId: args.resourceId || "claude:sonnet" }, {
      provider: "claude",
      requestedModel: args.model || "sonnet",
      success: false,
      failureCategory: "worker-failure",
    });
    updateJobStatus(workspace, jobId, { bridgeFinalized: true, completedAt: utcStamp() });
    return `ClaudeJobWorkerResult:\nJobId: ${jobId}\nState: failed\nBlocker: ${status.message}`;
  }

  const mode = String(args.mode || "fast").trim().toLowerCase();
  const permissionMode = safeClaudeFlag(args.permissionMode || (mode === "review" ? "plan" : "acceptEdits"), "permissionMode");
  const maxMinutes = Math.max(1, Math.min(180, Number(args.maxMinutes || 30)));
  const maxOutputTokens = Math.max(2000, Math.min(50000, Number(args.maxOutputTokens ?? 12000)));
  const prompt = buildClaudeJobPrompt(workspace, jobId, { ...args, permissionMode });
  const capabilities = status.capabilities || getClaudeCliCapabilities(status.command);
  const workerRole = claudeWorkerRole({ ...args, permissionMode });
  const roleSystemPromptEnabled = capabilities.appendSystemPrompt === true && capabilities.exactArguments === true;
  const structuredOutputEnabled = capabilities.jsonSchema === true && capabilities.exactArguments === true;
  const cliArgs = [
    "-p",
    ...claudeIsolationFlags(),
    "--output-format",
    "json",
    "--permission-mode",
    permissionMode,
  ];
  if (roleSystemPromptEnabled) cliArgs.push("--append-system-prompt", claudeWorkerSystemPrompt(workerRole.role));
  if (capabilities.disallowedToolsFlag) cliArgs.push(capabilities.disallowedToolsFlag, "Agent");
  if (structuredOutputEnabled) cliArgs.push("--json-schema", JSON.stringify(claudeWorkerResultSchema(args.maxResultBullets)));
  if (permissionMode === "plan") cliArgs.push("--tools", "Read,Grep,Glob");
  const dispatchModel = normalizeClaudeDispatchModel(args.model);
  if (dispatchModel) cliArgs.push("--model", safeClaudeFlag(dispatchModel, "model"));
  if (args.effort) cliArgs.push("--effort", safeClaudeFlag(args.effort, "effort"));
  if (args.fallbackModel) cliArgs.push("--fallback-model", safeClaudeFlag(args.fallbackModel, "fallbackModel"));
  const suppliedBudgetUsd = args.maxBudgetUsd !== undefined && args.maxBudgetUsd !== null && String(args.maxBudgetUsd).trim() !== ""
    ? Number(args.maxBudgetUsd)
    : null;
  if (suppliedBudgetUsd !== null && (!Number.isFinite(suppliedBudgetUsd) || suppliedBudgetUsd <= 0)) throw new Error("maxBudgetUsd must be a positive number.");
  const autoBudgetPolicy = claudeBudgetPolicy({});
  const appliedBudgetUsd = suppliedBudgetUsd !== null ? suppliedBudgetUsd : autoBudgetPolicy.capUsd;
  if (appliedBudgetUsd !== null) cliArgs.push("--max-budget-usd", String(appliedBudgetUsd));
  const budgetPolicyLabel = suppliedBudgetUsd !== null
    ? `explicit-usd-cap<=$${suppliedBudgetUsd}`
    : appliedBudgetUsd !== null
      ? `auto-usd-cap<=$${appliedBudgetUsd}`
      : "subscription-quota-windows";

  updateJobStatus(workspace, jobId, {
    state: "running",
    worker: "claude-code",
    currentStep: "claude-code-running",
    startedAt: utcStamp(),
    claudeCommand: path.basename(status.command),
    claudeVersion: status.version,
    claudeModel: args.model || "",
    claudePermissionMode: permissionMode,
    claudeIsolationMode: "safe-mode",
    claudeWorkerRole: workerRole.role,
    claudeWorkerContract: roleSystemPromptEnabled ? "role-system-prompt" : "bounded-prompt",
    claudeStructuredOutput: structuredOutputEnabled,
    claudeBudgetPolicy: budgetPolicyLabel,
    maxOutputTokens,
  });

  const startedMs = Date.now();
  let effectiveCliArgs = cliArgs;
  let result = runClaudeCli(status.command, effectiveCliArgs, {
    cwd: workspace,
    input: prompt,
    timeout: maxMinutes * 60 * 1000,
    maxBuffer: 8 * 1024 * 1024,
  });
  let isolationMode = "safe-mode";
  let workerContractMode = roleSystemPromptEnabled ? "role-system-prompt" : "bounded-prompt";
  let structuredOutputMode = structuredOutputEnabled;
  let initialErrorText = `${result.stderr || ""} ${result.error?.message || ""}`;
  if (result.status !== 0 && /unknown (?:option|argument).*(?:safe-mode|no-session-persistence)|(?:safe-mode|no-session-persistence).*unknown (?:option|argument)/i.test(initialErrorText)) {
    isolationMode = "legacy-cli-fallback";
    effectiveCliArgs = effectiveCliArgs.filter((value) => !claudeIsolationFlags().includes(value));
    result = runClaudeCli(status.command, effectiveCliArgs, {
      cwd: workspace,
      input: prompt,
      timeout: maxMinutes * 60 * 1000,
      maxBuffer: 8 * 1024 * 1024,
    });
    initialErrorText = `${result.stderr || ""} ${result.error?.message || ""}`;
  }
  const optionalContractRejected = result.status !== 0
    && /(?:unknown (?:option|argument).*(?:append-system-prompt|json-schema|disallowedTools|disallowed-tools)|(?:system prompt|json schema|json-schema).*(?:invalid|failed|unknown))/i.test(initialErrorText);
  if (optionalContractRejected && (roleSystemPromptEnabled || structuredOutputEnabled || capabilities.disallowedTools === true)) {
    effectiveCliArgs = removeCliOptions(effectiveCliArgs, ["--append-system-prompt", "--json-schema", "--disallowedTools", "--disallowed-tools"]);
    workerContractMode = "bounded-prompt-fallback";
    structuredOutputMode = false;
    result = runClaudeCli(status.command, effectiveCliArgs, {
      cwd: workspace,
      input: prompt,
      timeout: maxMinutes * 60 * 1000,
      maxBuffer: 8 * 1024 * 1024,
    });
  }
  const descendantCleanup = result.error?.code === "ETIMEDOUT" ? terminateDescendantProcesses(process.pid) : null;

  const stdout = String(result.stdout || "");
  const stderr = String(result.stderr || "");
  const parsedOutput = parseClaudeJsonOutput(stdout);
  fs.writeFileSync(path.join(jobDir, "claude-output.txt"), truncateText(stdout, 80000), "utf8");
  fs.writeFileSync(path.join(jobDir, "claude-error.txt"), truncateText(stderr, 30000), "utf8");

  const resultPath = path.join(jobDir, "result.md");
  if (!fs.existsSync(resultPath) || fs.readFileSync(resultPath, "utf8").trim() === "") {
    const structuredResult = compactClaudeStructuredOutput(parsedOutput.structuredOutput, boundedResultBulletLimit(args, 8));
    fs.writeFileSync(resultPath, compactResultBullets(structuredResult || parsedOutput.resultText || stderr || "<Claude Code produced no output>", boundedResultBulletLimit(args, 8), resultCharacterLimit(args, 8)), "utf8");
  }
  const compactClaudeResult = compactResultArtifact(resultPath, args, 8);

  writeAuthoritativeExecutionSummary(jobDir, "claude-code", result, stderr);
  const gitOutcome = finalizeWorkerGitArtifacts(workspace, jobDir, mode);
  const boundary = validateWorkerFileBoundary(args, gitOutcome);
  const executionFailed = result.status !== 0 || Boolean(result.error) || parsedOutput.isError;
  const modelMismatch = !executionFailed && !claudeObservedModelMatches(dispatchModel, parsedOutput.observedModel);
  const tokenBudgetExceeded = Number.isFinite(parsedOutput.outputTokens) && parsedOutput.outputTokens > maxOutputTokens;
  const claudeBudgetError = claudeBudgetErrorSubtype(parsedOutput.errorSubtype);
  const resultText = summarizeFile(resultPath, 8000);
  const quality = executionFailed ? { ok: true, reason: "" } : validateWorkerResult(resultText, args);
  const boundaryEvidence = executionFailed ? { ok: true, reason: "" } : validateBoundaryEvidenceContract(args, resultText);
  const writerCompletion = executionFailed ? { ok: true, reason: "" } : validateWriterCompletion(args, gitOutcome, resultText);
  const preVerificationOk = !executionFailed && !modelMismatch && !tokenBudgetExceeded && !claudeBudgetError && boundary.ok && quality.ok && boundaryEvidence.ok && writerCompletion.ok;
  const deterministicVerification = preVerificationOk
    ? verificationRunner.run(workspace, jobDir, args, gitOutcome)
    : verificationRunner.skip(jobDir, args);
  const verificationFailed = preVerificationOk && deterministicVerification.required && deterministicVerification.passed !== true;
  const failed = executionFailed || modelMismatch || tokenBudgetExceeded || !boundary.ok || !quality.ok || !boundaryEvidence.ok || !writerCompletion.ok || verificationFailed;
  const failureCategory = !boundary.ok
    ? "scope-violation"
    : verificationFailed
      ? "verification-failed"
    : modelMismatch
      ? "model-unavailable"
    : (tokenBudgetExceeded || claudeBudgetError)
      ? "budget-exceeded"
    : executionFailed
      ? failureCategoryFromText(`${result.error?.message || ""} ${stderr} ${parsedOutput.resultText || stdout}`)
      : (!quality.ok || !boundaryEvidence.ok || !writerCompletion.ok) ? "insufficient-result" : "";
  recordWorkerTelemetry(workspace, jobDir, { ...args, resourceId: args.resourceId || "claude:sonnet" }, {
    provider: "claude",
    requestedModel: args.model || "sonnet",
    observedModel: parsedOutput.observedModel,
    observedModels: parsedOutput.observedModels,
    success: !failed,
    failureCategory,
    durationMs: Number.isFinite(parsedOutput.durationMs) ? parsedOutput.durationMs : Date.now() - startedMs,
    inputTokens: parsedOutput.inputTokens,
    cacheCreationInputTokens: parsedOutput.cacheCreationInputTokens,
    cacheReadInputTokens: parsedOutput.cacheReadInputTokens,
    outputTokens: parsedOutput.outputTokens,
    reportedCostUsdEquivalent: parsedOutput.reportedCostUsdEquivalent,
    promptChars: prompt.length,
    resultChars: compactClaudeResult.length,
    workerRole: workerRole.role,
    sessionId: parsedOutput.sessionId,
    numTurns: parsedOutput.numTurns,
    structuredOutput: structuredOutputMode && Boolean(parsedOutput.structuredOutput),
  });
  updateJobStatus(workspace, jobId, {
    state: failed ? "failed" : "completed",
    currentStep: failed ? "claude-code-failed" : "claude-code-completed",
    completedAt: utcStamp(),
    bridgeFinalized: true,
    exitCode: result.status,
    observedModel: parsedOutput.observedModel,
    observedModels: parsedOutput.observedModels,
    claudeIsolationMode: isolationMode,
    claudeWorkerRole: workerRole.role,
    claudeWorkerContract: workerContractMode,
    claudeStructuredOutput: structuredOutputMode && Boolean(parsedOutput.structuredOutput),
    claudeSessionId: parsedOutput.sessionId,
    failureCategory,
    descendantCleanup,
    warning: gitOutcome.reviewWorkspaceChanged ? "Workspace changed during this review, but Claude plan mode could not edit files; no diff was accepted." : "",
    blocker: !boundary.ok
      ? `Worker changed files outside its boundary: ${boundary.violations.join(", ")}`
      : verificationFailed
        ? deterministicVerification.blocker || "Bridge-owned deterministic verification failed."
      : tokenBudgetExceeded
        ? `Claude output budget exceeded: ${parsedOutput.outputTokens} > ${maxOutputTokens} tokens. Do not auto-fail over; inspect the bounded artifact or rescope.`
      : claudeBudgetError
        ? `Claude reported a budget-exceeded error (${parsedOutput.errorSubtype}). Do not auto-fail over; inspect the bounded artifact or rescope.`
      : modelMismatch
        ? `Requested Claude model ${dispatchModel}, but the dominant observed model was ${parsedOutput.observedModel || "unknown"}.`
      : !writerCompletion.ok
        ? writerCompletion.reason
      : !boundaryEvidence.ok
        ? boundaryEvidence.reason
      : !quality.ok
        ? quality.reason
        : failed ? truncateText(result.error?.message || stderr || stdout || "Claude Code exited non-zero.", 1000) : "",
  });

  return [
    "ClaudeJobWorkerResult:",
    `JobId: ${jobId}`,
    `State: ${failed ? "failed" : "completed"}`,
    `JobFolder: ${jobDir}`,
  ].join("\n");
}

function submitClaudeJob(args = {}) {
  const created = createJob({ ...args, worker: "claude-code" });
  const start = args.start !== false;
  updateJobStatus(created.workspace, created.jobId, {
    worker: "claude-code",
    currentStep: start ? "claude-code-queued" : "claude-code-created-not-started",
  });

  if (!start) {
    return [
      "SubmitClaudeJobResult:",
      `JobId: ${created.jobId}`,
      `JobFolder: ${created.jobDir}`,
      "State: queued",
      "Started: false",
      "Next: call submit-claude-job again with start=true or run the worker from this job folder.",
    ].join("\n");
  }

  const status = findClaudeCode();
  if (!status.found) {
    updateJobStatus(created.workspace, created.jobId, {
      state: "failed",
      currentStep: "claude-code-not-found",
      completedAt: utcStamp(),
      bridgeFinalized: true,
      blocker: status.message,
    });
    writeJobFailureArtifacts(created.workspace, created.jobId, "claude-code", status.message);
    return [
      "SubmitClaudeJobResult:",
      `JobId: ${created.jobId}`,
      `JobFolder: ${created.jobDir}`,
      "State: failed",
      `Blocker: ${status.message}`,
    ].join("\n");
  }

  const payloadPath = path.join(created.jobDir, "claude-worker-payload.json");
  writeJsonFile(payloadPath, {
    ...args,
    workspace: created.workspace,
    jobId: created.jobId,
    model: normalizeClaudeDispatchModel(args.model || args.claudeModel),
  });
  const child = spawn(process.execPath, [__filename, "claude-job-worker-cli", "--json-file", payloadPath], {
    cwd: pluginRoot,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();

  updateJobStatus(created.workspace, created.jobId, {
    state: "running",
    currentStep: "claude-code-background-started",
    workerPid: child.pid,
    workerCommandMarker: created.jobId,
    claudeCommand: path.basename(status.command),
    claudeVersion: status.version,
  });

  return [
    "SubmitClaudeJobResult:",
    `JobId: ${created.jobId}`,
    `JobFolder: ${created.jobDir}`,
    "State: running",
    "Started: true",
    `WorkerPid: ${child.pid}`,
    "Next: call read-job with this jobId; Codex should read only compact artifacts.",
  ].join("\n");
}

function safeCursorFlag(value, name) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (!/^[A-Za-z0-9._:/@()+ -]+$/.test(text)) {
    throw new Error(`Unsafe Cursor agent ${name} value. Use a simple model or mode id.`);
  }
  return text;
}

function buildCursorJobPrompt(workspace, jobId, args = {}) {
  const jobDir = jobDirFor(workspace, jobId);
  const request = summarizeFile(path.join(jobDir, "request.md"), 12000);
  const maxResultBullets = boundedResultBulletLimit(args, 8);
  return [
    "You are Cursor Agent running as a local worker for Codex.",
    "Work in the workspace path below. Inspect files locally; do not paste full files, full logs, screenshots, credentials, cookies, or private chat transcripts.",
    "",
    request,
    "",
    "Artifact rules:",
    `- Write the final compact result to: ${path.join(jobDir, "result.md")}`,
    `- Write changed file paths to: ${path.join(jobDir, "changed-files.txt")}`,
    `- Write command/test summary only to: ${path.join(jobDir, "test-output-summary.md")}`,
    "- If blocked, write one concise blocker and the next smallest action.",
    `- Keep result.md to max ${maxResultBullets} bullets.`,
    "",
    `Current next step: ${String(args.nextStep || "Inspect the relevant files and write compact artifacts.").trim()}`,
  ].join("\n");
}

function runCursorJobWorker(args = {}) {
  const workspace = safeWorkspacePath(args.workspace);
  const jobId = resolveJobId(workspace, args.jobId);
  const jobDir = jobDirFor(workspace, jobId);
  const status = findCursorAgent();
  if (!status.found) {
    const blocker = status.message;
    updateJobStatus(workspace, jobId, {
      state: "failed",
      currentStep: "cursor-agent-not-found",
      blocker,
      failureCategory: "worker-failure",
    });
    writeJobFailureArtifacts(workspace, jobId, "cursor-agent", blocker);
    recordWorkerTelemetry(workspace, jobDir, { ...args, resourceId: args.resourceId || "cursor:agent" }, {
      provider: "cursor",
      requestedModel: args.model || "default",
      success: false,
      failureCategory: "worker-failure",
    });
    updateJobStatus(workspace, jobId, { bridgeFinalized: true, completedAt: utcStamp() });
    return `CursorJobWorkerResult:\nJobId: ${jobId}\nState: failed\nBlocker: ${blocker}`;
  }

  const maxMinutes = Math.max(1, Math.min(180, Number(args.maxMinutes || 30)));
  const prompt = buildCursorJobPrompt(workspace, jobId, args);
  const cliArgs = ["-p", "--output-format", "text"];
  if (args.model) cliArgs.push("--model", safeCursorFlag(args.model, "model"));

  updateJobStatus(workspace, jobId, {
    state: "running",
    worker: "cursor-agent",
    currentStep: "cursor-agent-running",
    startedAt: utcStamp(),
    cursorCommand: path.basename(status.command),
    cursorVersion: status.version,
    cursorModel: args.model || "",
  });

  const startedMs = Date.now();
  const result = runWindowsFriendly(status.command, cliArgs, {
    cwd: workspace,
    input: prompt,
    timeout: maxMinutes * 60 * 1000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const descendantCleanup = result.error?.code === "ETIMEDOUT" ? terminateDescendantProcesses(process.pid) : null;

  const stdout = String(result.stdout || "");
  const stderr = String(result.stderr || "");
  fs.writeFileSync(path.join(jobDir, "cursor-output.txt"), truncateText(stdout, 80000), "utf8");
  fs.writeFileSync(path.join(jobDir, "cursor-error.txt"), truncateText(stderr, 30000), "utf8");

  const resultPath = path.join(jobDir, "result.md");
  if (!fs.existsSync(resultPath) || fs.readFileSync(resultPath, "utf8").trim() === "") {
    fs.writeFileSync(resultPath, compactResultBullets(stdout || stderr || "<Cursor agent produced no output>", boundedResultBulletLimit(args, 8), resultCharacterLimit(args, 8)), "utf8");
  }
  const compactCursorResult = compactResultArtifact(resultPath, args, 8);

  writeAuthoritativeExecutionSummary(jobDir, "cursor-agent", result, stderr);
  const gitOutcome = finalizeWorkerGitArtifacts(workspace, jobDir, args.mode);
  const boundary = validateWorkerFileBoundary(args, gitOutcome);
  const executionFailed = result.status !== 0 || Boolean(result.error);
  const resultText = summarizeFile(resultPath, 8000);
  const quality = executionFailed ? { ok: true, reason: "" } : validateWorkerResult(resultText, args);
  const boundaryEvidence = executionFailed ? { ok: true, reason: "" } : validateBoundaryEvidenceContract(args, resultText);
  const writerCompletion = executionFailed ? { ok: true, reason: "" } : validateWriterCompletion(args, gitOutcome, resultText);
  const preVerificationOk = !executionFailed && boundary.ok && quality.ok && boundaryEvidence.ok && writerCompletion.ok;
  const deterministicVerification = preVerificationOk
    ? verificationRunner.run(workspace, jobDir, args, gitOutcome)
    : verificationRunner.skip(jobDir, args);
  const verificationFailed = preVerificationOk && deterministicVerification.required && deterministicVerification.passed !== true;
  const failed = executionFailed || !boundary.ok || !quality.ok || !boundaryEvidence.ok || !writerCompletion.ok || verificationFailed;
  const failureCategory = !boundary.ok
    ? "scope-violation"
    : verificationFailed
      ? "verification-failed"
    : executionFailed
      ? failureCategoryFromText(`${result.error?.message || ""} ${stderr} ${stdout}`)
      : (!quality.ok || !boundaryEvidence.ok || !writerCompletion.ok) ? "insufficient-result" : "";
  recordWorkerTelemetry(workspace, jobDir, { ...args, resourceId: args.resourceId || "cursor:agent" }, {
    provider: "cursor",
    requestedModel: args.model || "default",
    observedModel: args.model || "",
    success: !failed,
    failureCategory,
    durationMs: Date.now() - startedMs,
    promptChars: prompt.length,
    resultChars: compactCursorResult.length,
  });
  updateJobStatus(workspace, jobId, {
    state: failed ? "failed" : "completed",
    currentStep: failed ? "cursor-agent-failed" : "cursor-agent-completed",
    completedAt: utcStamp(),
    bridgeFinalized: true,
    exitCode: result.status,
    failureCategory,
    descendantCleanup,
    warning: gitOutcome.reviewWorkspaceChanged ? "Workspace changed during this review, but the bridge cannot attribute concurrent edits to the review worker; no diff was accepted." : "",
    blocker: !boundary.ok
      ? `Worker changed files outside its boundary: ${boundary.violations.join(", ")}`
      : verificationFailed
        ? deterministicVerification.blocker || "Bridge-owned deterministic verification failed."
      : !writerCompletion.ok
        ? writerCompletion.reason
      : !boundaryEvidence.ok
        ? boundaryEvidence.reason
      : !quality.ok
        ? quality.reason
        : failed ? truncateText(result.error?.message || stderr || stdout || "Cursor agent exited non-zero.", 1000) : "",
  });

  return [
    "CursorJobWorkerResult:",
    `JobId: ${jobId}`,
    `State: ${failed ? "failed" : "completed"}`,
    `JobFolder: ${jobDir}`,
  ].join("\n");
}

function submitCursorJob(args = {}) {
  const created = createJob({ ...args, worker: "cursor-agent" });
  const start = args.start !== false;
  updateJobStatus(created.workspace, created.jobId, {
    worker: "cursor-agent",
    currentStep: start ? "cursor-agent-queued" : "cursor-agent-created-not-started",
  });

  if (!start) {
    return [
      "SubmitCursorJobResult:",
      `JobId: ${created.jobId}`,
      `JobFolder: ${created.jobDir}`,
      "State: queued",
      "Started: false",
      "Next: call submit-cursor-job again with start=true or run the worker from this job folder.",
    ].join("\n");
  }

  const status = findCursorAgent();
  if (!status.found) {
    updateJobStatus(created.workspace, created.jobId, {
      state: "failed",
      currentStep: "cursor-agent-not-found",
      completedAt: utcStamp(),
      bridgeFinalized: true,
      blocker: status.message,
    });
    writeJobFailureArtifacts(created.workspace, created.jobId, "cursor-agent", status.message);
    return [
      "SubmitCursorJobResult:",
      `JobId: ${created.jobId}`,
      `JobFolder: ${created.jobDir}`,
      "State: failed",
      `Blocker: ${status.message}`,
      "Fallback: call open-cursor for the visual Cursor UI path.",
    ].join("\n");
  }

  const payloadPath = path.join(created.jobDir, "cursor-worker-payload.json");
  writeJsonFile(payloadPath, {
    ...args,
    workspace: created.workspace,
    jobId: created.jobId,
  });
  const child = spawn(process.execPath, [__filename, "cursor-job-worker-cli", "--json-file", payloadPath], {
    cwd: pluginRoot,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();

  updateJobStatus(created.workspace, created.jobId, {
    state: "running",
    currentStep: "cursor-agent-background-started",
    workerPid: child.pid,
    workerCommandMarker: created.jobId,
    cursorCommand: path.basename(status.command),
    cursorVersion: status.version,
  });

  return [
    "SubmitCursorJobResult:",
    `JobId: ${created.jobId}`,
    `JobFolder: ${created.jobDir}`,
    "State: running",
    "Started: true",
    `WorkerPid: ${child.pid}`,
    "Next: call read-job with this jobId; Codex should read only compact artifacts.",
  ].join("\n");
}

function buildJobHandoff(workspace, jobId) {
  const jobDir = jobDirFor(workspace, jobId);
  const request = summarizeFile(path.join(jobDir, "request.md"), 16000);
  return [
    "Execute this Antigravity bridge job. Work locally and write artifacts; do not paste full logs/source.",
    "",
    request,
  ].join("\n");
}

function availableModelNames(limitsSummary) {
  return (limitsSummary?.RecommendedAvailable || [])
    .map((entry) => String(entry.DisplayName || entry.Id || "").trim())
    .filter(Boolean);
}

function choosePreferredModelCandidates(limitsSummary, preference = "auto") {
  const names = availableModelNames(limitsSummary);
  const requested = String(preference || "auto").trim();
  const lower = requested.toLowerCase();
  const exact = names.find((name) => name.toLowerCase() === lower);
  if (exact) return [exact];

  const matches = (patterns) => names.filter((name) => patterns.every((pattern) => pattern.test(name)));
  if (lower === "flash-high" || lower === "high-flash" || lower === "gemini-flash-high") {
    return [
      "Gemini 3.5 Flash (High)",
      ...matches([/gemini/i, /3\.5/i, /flash/i, /high/i]),
      ...matches([/gemini/i, /flash/i, /high/i]),
      ...matches([/gemini/i, /flash/i]),
      ...names,
    ].filter((name, index, all) => name && all.indexOf(name) === index);
  }
  if (lower === "auto" || lower === "flash-medium" || lower === "cheap" || lower === "cost-saving") {
    return [
      "Gemini 3.5 Flash (Medium)",
      ...matches([/gemini/i, /3\.5/i, /flash/i, /medium/i]),
      ...matches([/gemini/i, /flash/i, /medium/i]),
      ...matches([/gemini/i, /flash/i]),
      ...names,
    ].filter((name, index, all) => name && all.indexOf(name) === index);
  }
  if (lower === "flash") {
    return [
      "Gemini 3.5 Flash (Medium)",
      ...matches([/gemini/i, /flash/i]),
      ...names,
    ].filter((name, index, all) => name && all.indexOf(name) === index);
  }
  if (lower === "best-available") {
    return names;
  }
  return [requested];
}

async function selectAntigravityChat(args = {}) {
  const expectedProject = String(args.expectedProject || "").trim();
  const expectedChat = String(args.expectedChat || "").trim();
  if (!expectedChat) {
    return "SelectChatResult:\nOk: false\nStage: input\nMessage: expectedChat is required.";
  }

  const { port, page } = await getAntigravityPage();
  const client = await createCdpClient(page.webSocketDebuggerUrl);
  const expression = `
(async () => {
  const expectedProject = ${jsString(expectedProject)};
  const expectedChat = ${jsString(expectedChat)};
  const expectedChatLower = expectedChat.toLowerCase();
  const visibleText = document.body ? document.body.innerText || "" : "";
  const activeTitle = document.title || "";
  const isVisible = (el) => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  const labelFor = (el) => [el.ariaLabel, el.title, el.innerText, el.textContent].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim();
  const activeContextText = () => Array.from(document.querySelectorAll('body *'))
    .filter((el) => {
      if (el.closest('nav,aside,[role="navigation"]')) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.top < 260 && style.visibility !== "hidden" && style.display !== "none";
    })
    .map((el) => el.innerText || el.textContent || "")
    .join(" ")
    .replace(/\\s+/g, " ");
  if (expectedProject && !visibleText.includes(expectedProject)) {
    return { ok: false, stage: "verify-project", missing: ["expectedProject"], activeTitle };
  }
  if ((activeTitle + " " + activeContextText()).toLowerCase().includes(expectedChatLower) && !/new conversation|new chat/i.test(activeTitle)) {
    return { ok: true, stage: "already-active", activeTitle };
  }

  const collectCandidates = () => Array.from(document.querySelectorAll('button,[role="button"],[role="treeitem"],[role="listitem"],a,[tabindex],div,span'))
    .filter(isVisible)
    .map((el) => ({ el, label: labelFor(el), rect: el.getBoundingClientRect() }))
    .filter((item) => item.label && item.label.toLowerCase().includes(expectedChatLower))
    .sort((a, b) => {
      const aExact = a.label.trim().toLowerCase() === expectedChatLower ? 0 : 1;
      const bExact = b.label.trim().toLowerCase() === expectedChatLower ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
      return a.rect.left - b.rect.left || a.rect.top - b.rect.top;
    });
  let candidates = collectCandidates();
  if (!candidates.length) {
    const openers = Array.from(document.querySelectorAll('button,[role="button"],a,[tabindex]'))
      .filter(isVisible)
      .map((el) => ({ el, label: labelFor(el) }))
      .filter((item) => /conversation history|search|show more/i.test(item.label));
    const opener = openers.find((item) => /conversation history/i.test(item.label)) || openers[0];
    if (opener) {
      opener.el.click();
      await new Promise((resolve) => setTimeout(resolve, 700));
      candidates = collectCandidates();
      if (!candidates.length) {
        const searchBox = Array.from(document.querySelectorAll('input,textarea,[contenteditable="true"],[role="textbox"],[role="combobox"]'))
          .filter(isVisible)
          .filter((el) => {
            const rect = el.getBoundingClientRect();
            const label = labelFor(el);
            return rect.top < Math.max(520, window.innerHeight * 0.7)
              && rect.bottom < window.innerHeight - 120
              && (/search|filter|conversation|chat/i.test(label) || rect.left < window.innerWidth * 0.45);
          })
          .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
        if (searchBox) {
          searchBox.focus();
          if (searchBox.matches('textarea,input')) {
            const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(searchBox), "value")?.set;
            if (setter) setter.call(searchBox, expectedChat);
            else searchBox.value = expectedChat;
            searchBox.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: expectedChat }));
            searchBox.dispatchEvent(new Event("change", { bubbles: true }));
          } else {
            document.execCommand("selectAll", false, null);
            const inserted = document.execCommand("insertText", false, expectedChat);
            if (!inserted) searchBox.textContent = expectedChat;
            searchBox.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: expectedChat }));
          }
          await new Promise((resolve) => setTimeout(resolve, 900));
          candidates = collectCandidates();
        }
      }
    }
  }
  if (!candidates.length) {
    const visibleChatLike = Array.from(document.querySelectorAll('button,[role="button"],[role="treeitem"],[role="listitem"],a,[tabindex]'))
      .filter(isVisible)
      .map(labelFor)
      .filter(Boolean)
      .slice(0, 30);
    return { ok: false, stage: "find-chat", activeTitle, visibleChatLike };
  }

  const target = candidates[0].el;
  target.scrollIntoView({ block: "center", inline: "nearest" });
  await new Promise((resolve) => setTimeout(resolve, 150));
  target.click();
  await new Promise((resolve) => setTimeout(resolve, 900));

  const afterTitle = document.title || "";
  const afterText = activeContextText();
  const ok = (afterTitle + " " + afterText).toLowerCase().includes(expectedChatLower) && !/new conversation|new chat/i.test(afterTitle);
  return {
    ok,
    stage: ok ? "selected" : "selected-unverified",
    activeTitle: afterTitle,
    clickedLabel: candidates[0].label.slice(0, 160)
  };
})()
`;

  try {
    const result = await client.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    const value = result?.result?.value || {};
    return [
      "SelectChatResult:",
      `DevToolsPort: ${port}`,
      `PageTitle: ${page.title || "<unknown>"}`,
      `ExpectedChat: ${expectedChat}`,
      expectedProject ? `ExpectedProject: ${expectedProject}` : null,
      `Ok: ${value.ok === true}`,
      `Stage: ${value.stage || "<unknown>"}`,
      value.activeTitle ? `ActiveTitle: ${value.activeTitle}` : null,
      value.clickedLabel ? `ClickedLabel: ${value.clickedLabel}` : null,
      value.missing?.length ? `Missing: ${value.missing.join(", ")}` : null,
      value.visibleChatLike?.length ? `VisibleCandidates: ${value.visibleChatLike.slice(0, 10).join(" | ")}` : null,
      "Next: only call switch-model or submit-job if Ok is true.",
    ].filter(Boolean).join("\n");
  } finally {
    client.close();
  }
}

async function switchModelInCurrentChat(args = {}) {
  const expectedProject = String(args.expectedProject || "").trim();
  const expectedChat = String(args.expectedChat || "").trim();
  let limitsSummary = null;
  try {
    limitsSummary = await runHelper("limits-summary");
  } catch {
    // The visible model picker remains the fallback source of truth.
  }
  const targetCandidates = choosePreferredModelCandidates(limitsSummary, args.modelPreference || "flash-medium");
  if (!targetCandidates.length) {
    return "SwitchModelResult:\nOk: false\nStage: choose-model\nMessage: No available model could be chosen from limits-summary.";
  }
  const targetModel = targetCandidates[0];

  const { port, page } = await getAntigravityPage();
  const client = await createCdpClient(page.webSocketDebuggerUrl);

  const expression = `
(async () => {
  const expectedProject = ${jsString(expectedProject)};
  const expectedChat = ${jsString(expectedChat)};
  const targetCandidates = ${JSON.stringify(targetCandidates)};
  const candidateNeedles = targetCandidates.map((name) => String(name).toLowerCase());
  const visibleText = document.body ? document.body.innerText || "" : "";
  const activeTitle = document.title || "";
  const activeContextText = Array.from(document.querySelectorAll('body *'))
    .filter((el) => {
      if (el.closest('nav,aside,[role="navigation"]')) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.top < 240 && style.visibility !== "hidden" && style.display !== "none";
    })
    .map((el) => el.innerText || el.textContent || "")
    .join(" ")
    .replace(/\\s+/g, " ");
  const missing = [];
  if (expectedProject && !visibleText.includes(expectedProject)) missing.push("expectedProject");
  if (expectedChat && !(activeTitle + " " + activeContextText).toLowerCase().includes(expectedChat.toLowerCase())) missing.push("expectedChatActiveContext");
  if (missing.length) return { ok: false, stage: "verify", missing };

  const isVisible = (el) => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  const labelFor = (el) => [el.ariaLabel, el.title, el.innerText, el.textContent].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim();
  const buttons = () => Array.from(document.querySelectorAll('button,[role="button"]')).filter(isVisible);
  const currentButton = buttons().find((el) => /select model, current:/i.test(labelFor(el)));
  const currentLabel = currentButton ? labelFor(currentButton) : "";
  const currentNeedle = candidateNeedles.find((needle) => currentLabel.toLowerCase().includes(needle));
  if (currentNeedle) {
    return { ok: true, stage: "already-selected", selectedModel: targetCandidates[candidateNeedles.indexOf(currentNeedle)], currentLabel };
  }
  if (!currentButton) return { ok: false, stage: "find-selector", message: "No visible model selector found." };

  currentButton.click();
  await new Promise((resolve) => setTimeout(resolve, 350));
  let optionButtons = buttons();
  let selectedModel = "";
  let option = null;
  for (let i = 0; i < candidateNeedles.length; i += 1) {
    const needle = candidateNeedles[i];
    option = optionButtons.find((el) => labelFor(el).toLowerCase() === needle)
      || optionButtons.find((el) => labelFor(el).toLowerCase().includes(needle));
    if (option) {
      selectedModel = targetCandidates[i];
      break;
    }
  }
  if (!option) {
    const visibleOptions = optionButtons.map(labelFor).filter((text) => /gemini|claude|gpt|flash|sonnet|opus/i.test(text));
    return { ok: false, stage: "find-option", selectedModel: targetCandidates[0], visibleOptions };
  }
  option.click();
  await new Promise((resolve) => setTimeout(resolve, 600));
  const afterButton = buttons().find((el) => /select model, current:/i.test(labelFor(el)));
  const afterLabel = afterButton ? labelFor(afterButton) : "";
  const selectedNeedle = selectedModel.toLowerCase();
  return {
    ok: afterLabel.toLowerCase().includes(selectedNeedle),
    stage: afterLabel.toLowerCase().includes(selectedNeedle) ? "selected" : "selected-unverified",
    selectedModel,
    currentLabel: afterLabel
  };
})()
`;

  try {
    const result = await client.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    const value = result?.result?.value || {};
    return [
      "SwitchModelResult:",
      `DevToolsPort: ${port}`,
      `PageTitle: ${page.title || "<unknown>"}`,
      `Requested: ${String(args.modelPreference || "flash-medium")}`,
      `Chosen: ${value.selectedModel || targetModel}`,
      `Ok: ${value.ok === true}`,
      `Stage: ${value.stage || "<unknown>"}`,
      value.currentLabel ? `CurrentLabel: ${value.currentLabel}` : null,
      value.missing?.length ? `Missing: ${value.missing.join(", ")}` : null,
      value.visibleOptions?.length ? `VisibleOptions: ${value.visibleOptions.slice(0, 8).join(" | ")}` : null,
      value.message ? `Message: ${value.message}` : null,
    ].filter(Boolean).join("\n");
  } finally {
    client.close();
  }
}

async function submitOffloadToCurrentChat(args = {}) {
  const { decision } = getOffloadDecision({ ...args, hasWorkspaceWork: true, estimatedCodexInputTokens: 2000 });
  if (decision !== "offload-to-antigravity") {
    return `SubmitOffload: skipped\nDecision: ${decision}\nReason: task does not need Antigravity.`;
  }

  const handoff = args.handoffText
    ? String(args.handoffText)
    : buildHandoffTemplate(args).replace(/^Use this as a compact Antigravity offload handoff:\n\n/, "");
  const expectedProject = String(args.expectedProject || "").trim();
  const expectedChat = String(args.expectedChat || "").trim();
  const submit = Boolean(args.submit);
  const fillOnly = Boolean(args.fillOnly);
  const skipModelSwitch = Boolean(args.skipModelSwitch);
  let switchResult = "";
  if (!skipModelSwitch) {
    switchResult = await switchModelInCurrentChat({
      expectedProject,
      expectedChat,
      modelPreference: args.modelPreference || "auto",
    });
    if (!/Ok: true/.test(switchResult)) {
      return `${switchResult}\n\nSubmitOffloadResult:\nOk: false\nStage: model-switch\nSubmitted: false\nMessage: Refusing to submit while the requested/available model is not verified.`;
    }
  }
  const { port, page } = await getAntigravityPage();
  const client = await createCdpClient(page.webSocketDebuggerUrl);

  const expression = `
(() => {
  const prompt = ${jsString(handoff)};
  const expectedProject = ${jsString(expectedProject)};
  const expectedChat = ${jsString(expectedChat)};
  const shouldSubmit = ${submit ? "true" : "false"};
  const shouldFillOnly = ${fillOnly ? "true" : "false"};
  const visibleText = document.body ? document.body.innerText || "" : "";
  const activeTitle = document.title || "";
  const activeContextText = Array.from(document.querySelectorAll('body *'))
    .filter((el) => {
      if (el.closest('nav,aside,[role="navigation"]')) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.top < 240 && style.visibility !== "hidden" && style.display !== "none";
    })
    .map((el) => el.innerText || el.textContent || "")
    .join(" ")
    .replace(/\\s+/g, " ");
  const missing = [];
  if (expectedProject && !visibleText.includes(expectedProject)) missing.push("expectedProject");
  if (expectedChat && !(activeTitle + " " + activeContextText).toLowerCase().includes(expectedChat.toLowerCase())) missing.push("expectedChatActiveContext");
  if (/new conversation|new chat/i.test(activeTitle)) missing.push("activeExistingChat");
  if (missing.length) {
    return { ok: false, stage: "verify", missing, submitted: false, activeTitle };
  }

  if (!shouldSubmit && !shouldFillOnly) {
    return { ok: true, stage: "verified", submitted: false, promptLength: prompt.length };
  }

  const isVisible = (el) => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };

  const candidates = Array.from(document.querySelectorAll('textarea,input,[contenteditable="true"],[role="textbox"],[role="combobox"]'))
    .filter((el) => isVisible(el) && !el.disabled && !el.readOnly)
    .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
  const composer = candidates[0];
  if (!composer) {
    return { ok: false, stage: "composer", submitted: false, message: "No visible composer found." };
  }

  composer.focus();
  if (composer.matches('textarea,input')) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(composer), "value")?.set;
    if (setter) setter.call(composer, prompt);
    else composer.value = prompt;
    composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: prompt }));
    composer.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    document.execCommand("selectAll", false, null);
    const inserted = document.execCommand("insertText", false, prompt);
    if (!inserted) composer.textContent = prompt;
    composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: prompt }));
  }

  if (!shouldSubmit) {
    return { ok: true, stage: "filled", submitted: false, promptLength: prompt.length };
  }

  const composerRect = composer.getBoundingClientRect();
  const buttons = Array.from(document.querySelectorAll('button,[role="button"]'))
    .filter((el) => isVisible(el) && !el.disabled && el.getAttribute("aria-disabled") !== "true");
  const labeled = buttons.find((el) => /send|submit/i.test([el.ariaLabel, el.title, el.textContent].filter(Boolean).join(" ")));
  const nearby = buttons
    .filter((el) => {
      const rect = el.getBoundingClientRect();
      return rect.top >= composerRect.top - 80 && rect.bottom <= composerRect.bottom + 120 && rect.left > composerRect.left;
    })
    .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0];
  const sendButton = labeled || nearby;
  if (sendButton) {
    sendButton.click();
    return {
      ok: true,
      stage: "send-clicked",
      submitted: false,
      promptLength: prompt.length,
      submitMethod: "click"
    };
  }
  return {
    ok: true,
    stage: "filled-ready-for-enter",
    submitted: false,
    promptLength: prompt.length,
    hasSendButton: false
  };
})()
`;

  try {
    const result = await client.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    let value = result?.result?.value || {};
    if (submit && value.ok === true && value.stage === "filled-ready-for-enter") {
      await client.send("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
        unmodifiedText: "\r",
        text: "\r",
      });
      await client.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      });
      value = { ...value, submitMethod: "enter" };
    }
    if (submit && value.ok === true && (value.stage === "filled-ready-for-enter" || value.stage === "send-clicked")) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const afterEnter = await client.send("Runtime.evaluate", {
        expression: `
(() => {
  const visibleText = document.body ? document.body.innerText || "" : "";
  const runningNow = /\\b(stop|cancel|running|thinking|generating|working)\\b/i.test(visibleText);
  const composer = Array.from(document.querySelectorAll('textarea,input,[contenteditable="true"],[role="textbox"],[role="combobox"]'))
    .filter((el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    })
    .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0];
  const composerText = composer ? (composer.value || composer.innerText || composer.textContent || "") : "";
  const promptHead = ${jsString(handoff.slice(0, 80))};
  const composerStillHasPrompt = composerText.includes(promptHead);
  const visibleHasPrompt = visibleText.includes(promptHead);
  return { runningNow, composerStillHasPrompt, visibleHasPrompt, composerLength: composerText.length };
})()
`,
        awaitPromise: true,
        returnByValue: true,
      });
      const afterValue = afterEnter?.result?.value || {};
      const submitted = afterValue.composerStillHasPrompt !== true && (afterValue.visibleHasPrompt === true || afterValue.runningNow === true);
      value = {
        ...value,
        stage: submitted ? `${value.submitMethod || "submit"}-submitted` : `${value.submitMethod || "submit"}-unconfirmed`,
        submitted,
        enterDispatched: value.submitMethod === "enter",
        runningNow: afterValue.runningNow === true,
        composerStillHasPrompt: afterValue.composerStillHasPrompt === true,
        visibleHasPrompt: afterValue.visibleHasPrompt === true,
      };
      if (value.submitMethod === "click" && value.submitted !== true && value.composerStillHasPrompt === true) {
        await client.send("Runtime.evaluate", {
          expression: `
(() => {
  const isVisible = (el) => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  const composer = Array.from(document.querySelectorAll('textarea,input,[contenteditable="true"],[role="textbox"],[role="combobox"]'))
    .filter((el) => isVisible(el) && !el.disabled && !el.readOnly)
    .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0];
  if (composer) composer.focus();
  return Boolean(composer);
})()
`,
          awaitPromise: true,
          returnByValue: true,
        });
        await client.send("Input.dispatchKeyEvent", {
          type: "rawKeyDown",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
          unmodifiedText: "\r",
          text: "\r",
        });
        await client.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
        });
        await new Promise((resolve) => setTimeout(resolve, 700));
        const afterFallbackEnter = await client.send("Runtime.evaluate", {
          expression: `
(() => {
  const visibleText = document.body ? document.body.innerText || "" : "";
  const runningNow = /\\b(stop|cancel|running|thinking|generating|working)\\b/i.test(visibleText);
  const composer = Array.from(document.querySelectorAll('textarea,input,[contenteditable="true"],[role="textbox"],[role="combobox"]'))
    .filter((el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    })
    .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0];
  const composerText = composer ? (composer.value || composer.innerText || composer.textContent || "") : "";
  const promptHead = ${jsString(handoff.slice(0, 80))};
  const composerStillHasPrompt = composerText.includes(promptHead);
  const visibleHasPrompt = visibleText.includes(promptHead);
  return { runningNow, composerStillHasPrompt, visibleHasPrompt, composerLength: composerText.length };
})()
`,
          awaitPromise: true,
          returnByValue: true,
        });
        const fallbackValue = afterFallbackEnter?.result?.value || {};
        const fallbackSubmitted = fallbackValue.composerStillHasPrompt !== true && (fallbackValue.visibleHasPrompt === true || fallbackValue.runningNow === true);
        value = {
          ...value,
          stage: fallbackSubmitted ? "click-then-enter-submitted" : "click-then-enter-unconfirmed",
          submitted: fallbackSubmitted,
          submitMethod: "click-then-enter",
          enterDispatched: true,
          runningNow: fallbackValue.runningNow === true,
          composerStillHasPrompt: fallbackValue.composerStillHasPrompt === true,
          visibleHasPrompt: fallbackValue.visibleHasPrompt === true,
        };
      }
    }
    return [
      switchResult || null,
      switchResult ? "" : null,
      "SubmitOffloadResult:",
      `DevToolsPort: ${port}`,
      `PageTitle: ${page.title || "<unknown>"}`,
      `Ok: ${value.ok === true}`,
      `Stage: ${value.stage || "<unknown>"}`,
      `Submitted: ${value.submitted === true}`,
      value.activeTitle ? `ActiveTitle: ${value.activeTitle}` : null,
      value.submitMethod ? `SubmitMethod: ${value.submitMethod}` : null,
      value.composerStillHasPrompt === true ? "ComposerStillHasPrompt: true" : null,
      value.missing?.length ? `Missing: ${value.missing.join(", ")}` : null,
      value.message ? `Message: ${value.message}` : null,
      "Next: If Submitted is true, stop monitoring every UI step and read only the requested status artifact or targeted diff.",
    ].filter(Boolean).join("\n");
  } finally {
    client.close();
  }
}

async function submitJob(args = {}) {
  const created = createJob(args);
  const handoffText = buildJobHandoff(created.workspace, created.jobId);
  const submit = args.submit !== false;
  let text = "";
  try {
    text = await submitOffloadToCurrentChat({
      goal: `Execute Antigravity bridge job ${created.jobId}`,
      workspace: created.workspace,
      statusFile: path.join(created.jobDir, "status.json"),
      nextStep: `Read request.md in ${created.jobDir} and write the required bridge artifacts.`,
      expectedProject: args.expectedProject || "",
      expectedChat: args.expectedChat || "",
      modelPreference: args.modelPreference || "auto",
      submit,
      handoffText,
    });
  } catch (error) {
    text = `SubmitOffloadResult:\nOk: false\nStage: exception\nSubmitted: false\nMessage: ${error?.message || String(error)}`;
  }
  if (/Submitted: true/.test(text)) {
    markJobSubmitted(created.workspace, created.jobId);
  } else if (submit) {
    markJobSubmitFailed(created.workspace, created.jobId, text);
  }
  return [
    "SubmitJobResult:",
    `JobId: ${created.jobId}`,
    `JobFolder: ${created.jobDir}`,
    `SubmittedRequested: ${submit}`,
    "",
    text,
    "",
    "Codex follow-up: do not read the Antigravity chat. Later call read-job for result.md, changed-files.txt, diff.patch, test-output-summary.md, verification-evidence.json, and status.json.",
  ].join("\n");
}

async function retryJob(args = {}) {
  const workspace = safeWorkspacePath(args.workspace);
  const jobId = resolveJobId(workspace, args.jobId || "latest");
  const jobDir = jobDirFor(workspace, jobId);
  const handoffText = buildJobHandoff(workspace, jobId);
  const submit = args.submit !== false;
  let text = "";
  try {
    text = await submitOffloadToCurrentChat({
      goal: `Retry Antigravity bridge job ${jobId}`,
      workspace,
      statusFile: path.join(jobDir, "status.json"),
      nextStep: `Retry request.md in ${jobDir} and overwrite the required bridge artifacts.`,
      expectedProject: args.expectedProject || "",
      expectedChat: args.expectedChat || "",
      modelPreference: args.modelPreference || "auto",
      submit,
      handoffText,
    });
  } catch (error) {
    text = `SubmitOffloadResult:\nOk: false\nStage: exception\nSubmitted: false\nMessage: ${error?.message || String(error)}`;
  }
  if (/Submitted: true/.test(text)) {
    markJobSubmitted(workspace, jobId);
  } else if (submit) {
    markJobSubmitFailed(workspace, jobId, text);
  }
  return [
    "RetryJobResult:",
    `JobId: ${jobId}`,
    `JobFolder: ${jobDir}`,
    `SubmittedRequested: ${submit}`,
    "",
    text,
  ].join("\n");
}

function buildDevToolsHealthAdvice(result) {
  const pageCount = Number(result?.PageCount || 0);
  const running = Boolean(result?.Running);
  const port = result?.DevToolsPort || "<unknown>";
  const status = running && pageCount > 0 ? "ready" : "not-ready";
  const next = status === "ready"
    ? "If ai-mobile-devtools still says Transport closed, do not retry the same MCP transport. Restart Codex so the DevTools MCP server is re-created, or use handoff-template/manual paste for this turn."
    : "Run ai-mobile-local.repair-live once. If it restarts Antigravity, restart Codex before calling ai-mobile-devtools again.";

  return [
    `DevToolsHealth: ${status}`,
    `Running: ${running}`,
    `DevToolsPort: ${port}`,
    `PageCount: ${pageCount}`,
    `Next: ${next}`,
    "",
    "Rule: ai-mobile-local can report health even when ai-mobile-devtools/list_pages fails with Transport closed. A closed transport means the DevTools MCP child process died; it is not fixed by repeatedly calling list_pages in the same session.",
  ].join("\n");
}

function buildSubmissionGuide() {
  return [
    "AntigravitySubmissionGuide:",
    "1. Verify the target project, conversation, model, and idle composer first.",
    "2. Fill or type the prompt into the composer only. Do not include submitKey in the fill/type call.",
    "3. Prefer clicking the visible Send/arrow button after the composer contains the prompt.",
    "4. If a keyboard submit is required, use a separate key tool call with a simple accepted key such as Enter. Do not use Control+Enter, Ctrl+Enter, or chord strings unless the active tool schema explicitly lists that exact value.",
    "5. After submitting, verify Antigravity accepted the message by checking for a working/streaming state or a new visible user message.",
    "6. If the key or click fails once, stop retrying the same submit method. Report the blocker or use handoff-template for manual paste.",
    "",
    "Reason: some Codex DevTools tools reject chord strings like Control+Enter with Unknown key, even after the prompt was typed correctly.",
  ].join("\n");
}

function runSelfTest() {
  process.env.AI_MOBILE_SELF_TEST = "1";
  const passed = [];
  const assert = (condition, name) => {
    if (!condition) throw new Error(`Self-test failed: ${name}`);
    passed.push(name);
  };

  const split = inferTaskSplit("ignored when explicit lanes exist", "UI, backend, testing");
  assert(split.join(",") === "ui,backend,testing", "explicit task split is preserved");
  const aliasedGraph = buildGoalWorkGraph({
    goal: "repair",
    workItems: [
      { id: "inspect", title: "Inspect runtime", description: "Verify live runtime truth", class: "analysis" },
      { id: "repair", title: "Repair routing", description: "Correct safe-ready routing", class: "code", dependsOn: ["inspect"] },
      { id: "integrate", title: "Integrate correction", description: "Reconcile and verify the correction", class: "integration", dependsOn: ["repair"] },
    ],
  });
  assert(aliasedGraph[0].objective === "Verify live runtime truth" && aliasedGraph[0].readOnly === true && aliasedGraph[0].executionClass === "analysis", "work-item description/title/class aliases preserve analysis intent");
  assert(aliasedGraph[1].objective === "Correct safe-ready routing" && aliasedGraph[1].readOnly === false && aliasedGraph[1].executionClass === "code", "work-item aliases cannot collapse code into generic read-only work");
  assert(aliasedGraph[2].readOnly === false && aliasedGraph[2].executionClass === "integration", "integration aliases retain writable integration semantics");
  assert(buildGoalWorkGraph({ goal: "repair", workItems: [{ id: "contradictory", title: "Repair code", class: "code", readOnly: true }] })[0].readOnly === false, "an explicit code execution class overrides a contradictory readOnly downgrade");
  const managerWorkItemSchema = tools.find((tool) => tool.name === "run-project-manager")?.inputSchema?.properties?.workItems?.items;
  assert(managerWorkItemSchema?.properties?.objective && managerWorkItemSchema?.properties?.description && managerWorkItemSchema?.properties?.executionClass && managerWorkItemSchema?.properties?.class && managerWorkItemSchema?.properties?.verificationCommands, "manager tool publishes canonical work-item fields, defensive aliases, and structured verification");
  const managerToolSchema = tools.find((tool) => tool.name === "run-project-manager")?.inputSchema?.properties;
  const managerStatusSchema = tools.find((tool) => tool.name === "project-manager-status")?.inputSchema?.properties;
  assert(managerToolSchema?.completionPolicy
    && managerToolSchema?.cycleObjective
    && managerStatusSchema?.cycleVerified
    && managerStatusSchema?.nextWorkItems
    && managerStatusSchema?.expectedRunId
    && managerStatusSchema?.expectedCycleId,
  "manager tools expose continuous root-goal, identity-guarded, same-run cycle lifecycle fields");
  const defaultToolNames = exposedMcpTools("").map((tool) => tool.name);
  assert(defaultToolNames.length === 10 && defaultToolNames.includes("run-project-manager") && defaultToolNames.includes("project-manager-status") && !defaultToolNames.includes("submit-agy-job"), "default MCP discovery exposes only the lean manager control surface");
  assert(exposedMcpTools("true").length === tools.length, "advanced MCP discovery remains available through one explicit environment switch");
  assert(/^\d+\.\d+\.\d+/.test(pluginVersion), "MCP server version follows the plugin manifest");
  const managerSkill = fs.readFileSync(path.join(pluginRoot, "skills", "ai-mobile", "SKILL.md"), "utf8");
  assert(managerSkill.includes("do not create another Codex control-room task")
    && managerSkill.includes("Provider worker sessions/jobs are not Codex control-room tasks and remain allowed")
    && managerSkill.includes("Never use `create_thread` to create a worker")
    && managerSkill.includes("`Objective`, `Changed`, `Team now`, `Capacity`, `Progress`, `Blocker/Decision`, and `Next`")
    && managerSkill.includes("never call `update_goal complete`")
    && managerSkill.includes("Do not search the filesystem"),
  "skill preserves the root objective, skips self-discovery waste, allows provider workers, and requires the seven-field CEO brief");
  assert(teamStateFromJobs([{ state: "completed" }, { state: "running" }]) === "running", "running team never reports completion");
  assert(teamStateFromJobs([{ state: "completed" }, { state: "failed" }]) === "partial", "mixed terminal team reports partial");
  const roster = parseAgyModelRoster("Gemini 3.5 Flash (Medium)\nClaude Opus 4.6 (Thinking)\n");
  assert(roster.length === 2 && roster[0].id === "gemini-3.5-flash-medium", "Antigravity model roster is parsed without starting its UI");
  const claudeRoster = parseClaudeModelRoster("Provide an alias such as 'fable', 'opus', or 'sonnet'. Full name: claude-fable-5");
  assert(claudeRoster.some((model) => model.id === "fable" && model.resolvedId === "claude-fable-5"), "Claude Fable is discovered from CLI help without starting a job");
  assert(claudeRoster.some((model) => model.id === "haiku"), "Claude Haiku remains available even when CLI help omits its alias");
  const claudeEfforts = parseClaudeEffortLevels("--effort <level> Effort level for the current session (low, medium, high, xhigh, max)");
  assert(claudeEfforts.join(",") === "low,medium,high,xhigh,max", "Claude reasoning effort levels are discovered from the current CLI schema");
  const claudeCapabilities = parseClaudeCliCapabilities("--agent <agent> --plugin-dir <path> --json-schema <schema> --disallowedTools <tools> --safe-mode --no-session-persistence", process.platform === "win32" ? "claude.exe" : "claude");
  assert(claudeCapabilities.agent && claudeCapabilities.pluginDir && claudeCapabilities.jsonSchema && claudeCapabilities.exactArguments, "Claude CLI worker features are detected from help output instead of hard-coded versions");
  assert(parseClaudeCliCapabilities("--disallowed-tools <tools>", "claude").disallowedToolsFlag === "--disallowed-tools", "Claude dispatch preserves the deny-tools flag spelling exposed by the installed CLI");
  assert(claudeWorkerRole({ mode: "patch", permissionMode: "acceptEdits", workItemKinds: ["implementation"] }).role === "writer", "Claude implementation receives the bounded writer role");
  assert(claudeWorkerRole({ mode: "review", permissionMode: "plan", workItemKinds: ["verification-testing"] }).role === "verifier", "Claude focused checks receive the verifier role");
  const structuredClaude = parseClaudeJsonOutput(JSON.stringify({ session_id: "session-test", num_turns: 3, structured_output: { status: "completed", summary: ["Verified the bounded change."], changedFiles: [], tests: ["Focused test passed."], blocker: "" }, usage: { output_tokens: 12 } }));
  assert(structuredClaude.sessionId === "session-test" && structuredClaude.numTurns === 3 && /Verified the bounded change/.test(structuredClaude.resultText), "Claude structured output becomes compact lifecycle evidence");
  const claudeUsage = parseClaudeUsage([
    "Current session: 2% used - resets Jul 11, 8:50am (Australia/Perth)",
    "Current week (all models): 13% used - resets Jul 12, 12pm (Australia/Perth)",
    "Current week (Fable): 14% used - resets Jul 12, 12pm (Australia/Perth)",
  ].join("\n"), new Date("2026-07-10T21:30:00Z"));
  assert(claudeUsage.windows.length === 3 && claudeUsage.windows[0].resetAt === "2026-07-11T00:50:00.000Z", "Claude usage windows and timezone-aware resets are parsed without a model prompt");
  const sonnetQuota = claudeQuotaForModel(claudeUsage, "sonnet");
  const fableQuota = claudeQuotaForModel(claudeUsage, "fable");
  assert(sonnetQuota.windows.length === 2 && sonnetQuota.remainingPercent === 87, "Sonnet uses shared session and all-model weekly quota windows");
  assert(fableQuota.windows.length === 3 && fableQuota.remainingPercent === 86, "Fable uses its dedicated weekly window plus shared quota windows");
  const compactCatalog = compactCodexModelCatalog({ client_version: "test", models: [{ slug: "gpt-test", display_name: "GPT Test", visibility: "list", supported_reasoning_levels: [{ effort: "high" }] }, { slug: "hidden", visibility: "hidden" }] });
  assert(compactCatalog.models.length === 1 && compactCatalog.models[0].reasoningLevels[0] === "high", "Codex model catalog is compacted without private instructions");
  const codexEvent = parseTokenCountEvent(JSON.stringify({
    timestamp: "2026-07-11T00:00:00.000Z",
    type: "event_msg",
    privatePrompt: "SHOULD_NOT_SURVIVE",
    payload: {
      type: "token_count",
      info: { model_context_window: 200000, total_token_usage: { input_tokens: 120, cached_input_tokens: 80, output_tokens: 20, total_tokens: 140 } },
      rate_limits: {
        limit_id: "codex",
        plan_type: "test",
        primary: { used_percent: 40, window_minutes: 300, resets_at: 1783731600 },
        secondary: { used_percent: 10, window_minutes: 10080, resets_at: 1784336400 },
      },
    },
  }));
  assert(codexEvent?.windows?.[0]?.id === "five_hour" && codexEvent.windows[0].remainingPercent === 60, "Codex local rate-limit metadata normalizes five-hour capacity");
  assert(!JSON.stringify(codexEvent).includes("SHOULD_NOT_SURVIVE"), "Codex telemetry parser discards transcript and unrelated event fields");
  assert(parseCodexLoginStatus("Logged in using ChatGPT", "").authMode === "chatgpt", "Codex CLI discovery distinguishes included ChatGPT-plan authentication");
  const codexArgs = buildCodexExecArgs({ workspace: pluginRoot, model: "gpt-5.6-luna", effort: "low", readOnly: true });
  assert(codexArgs.includes("--ignore-user-config") && codexArgs.includes("read-only") && codexArgs[codexArgs.length - 1] === "-", "Codex CLI worker uses isolated JSONL stdin transport and a read-only sandbox");
  const parsedCodex = parseCodexJsonl([
    JSON.stringify({ type: "thread.started", thread_id: "codex-thread-test" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "- Verified bounded routing.\n- Focused test passed." } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 101, cached_input_tokens: 80, output_tokens: 12 } }),
  ].join("\n"));
  assert(parsedCodex.threadId === "codex-thread-test" && parsedCodex.inputTokens === 101 && parsedCodex.resultText.includes("Focused test passed"), "Codex CLI JSONL becomes compact result and measured token evidence");
  const hostCatalog = {
    models: [
      { id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", defaultReasoning: "low", reasoningLevels: ["low", "medium", "high", "xhigh", "max", "ultra"], contextWindow: 353400 },
      { id: "gpt-5.6-terra", displayName: "GPT-5.6 Terra", defaultReasoning: "medium", reasoningLevels: ["low", "medium", "high", "ultra"] },
      { id: "gpt-future-nova", displayName: "GPT Future Nova", defaultReasoning: "medium", reasoningLevels: ["low", "medium", "high"] },
    ],
  };
  const hostCandidates = buildHostCodexCandidates(hostCatalog, { found: true, fresh: true, state: "healthy", evidence: "test", effectiveRemainingPercent: 70, windows: [] }, { hostCapabilityVerified: true, includePattern: /^gpt-/i });
  assert(hostCandidates.length === 3 && hostCandidates.some((candidate) => candidate.model === "gpt-future-nova"), "future catalog models remain discoverable without code changes");
  const cliCandidateContext = {
    codexCatalog: hostCatalog,
    codexTelemetry: { found: true, fresh: true, state: "healthy", evidence: "test", effectiveRemainingPercent: 70, windows: [] },
    codexBudget: { state: "healthy" },
    codexRemainingPercent: 70,
    codexCliFound: true,
    codexCliAuth: { loggedIn: true, authMode: "chatgpt" },
    workspaceState: { outcomes: {} },
  };
  const cliCandidates = buildNativeCodexCandidates({ localProfile: neutralLocalRoutingProfile(), codexManagerReservePercent: 15 }, cliCandidateContext);
  assert(cliCandidates.length === 3 && cliCandidates.every((candidate) => candidate.dispatchMode === "codex-cli" && candidate.dispatchable), "ChatGPT-authenticated Codex CLI replaces duplicate host candidates with durable workers");
  const reserveCliCandidates = buildNativeCodexCandidates({ localProfile: neutralLocalRoutingProfile(), codexManagerReservePercent: 15 }, { ...cliCandidateContext, codexRemainingPercent: 12, codexTelemetry: { ...cliCandidateContext.codexTelemetry, effectiveRemainingPercent: 12 } });
  assert(reserveCliCandidates.every((candidate) => candidate.state === "manager-reserve" && candidate.dispatchable === false), "standalone Codex workers share the manager reserve with the parent task");
  const criticalHostAction = chooseHostCodexAction(hostCandidates.filter((candidate) => candidate.model === "gpt-5.6-sol"), { objective: "Review an irreversible architecture migration", kind: "architecture-risk", complexity: "critical", requiredCapabilities: ["frontier-reasoning"] });
  assert(criticalHostAction?.reasoningEffort === "ultra", "critical frontier work selects the strongest supported Codex effort");
  assert(selectReasoningEffort(hostCandidates.find((candidate) => candidate.model === "gpt-5.6-terra"), { complexity: "low" }) === "low", "low-complexity Codex work selects a supported low effort");
  const claudeEffortCandidate = { platform: "claude", reasoningLevels: ["low", "medium", "high", "xhigh", "max"], defaultReasoning: "high" };
  assert(selectProviderReasoningEffort(claudeEffortCandidate, { complexity: "critical", objective: "Review a risky migration" }) === "high", "Claude critical work stays at high effort unless maximum effort is explicitly justified");
  assert(selectProviderReasoningEffort(claudeEffortCandidate, { complexity: "critical", objective: "Use max effort for the deepest reasoning" }) === "max", "explicit maximum-effort Claude work may use max when supported");
  const staleHost = buildHostCodexCandidates(hostCatalog, { found: true, fresh: false, state: "healthy", effectiveRemainingPercent: 70, windows: [] }, { hostCapabilityVerified: true, includePattern: /^gpt-5\.6-/i });
  assert(staleHost.every((candidate) => candidate.state === "capacity-stale"), "stale Codex capacity evidence fails closed for new host assignments");
  assert(shouldFanOut([{ id: "a", kind: "research", readOnly: true, dependsOn: [] }, { id: "b", kind: "review", readOnly: true, dependsOn: [] }]), "independent distinct read-only work may fan out");
  assert(!shouldFanOut([{ id: "a", kind: "implementation", readOnly: false, dependsOn: [] }, { id: "b", kind: "implementation", readOnly: false, dependsOn: [] }]), "parallel shared-workspace writers are refused");
  assert(shouldFanOut([
    { id: "ui", kind: "implementation", readOnly: false, dependsOn: [], expectedFiles: ["ui/"] },
    { id: "backend", kind: "implementation", readOnly: false, dependsOn: [], expectedFiles: ["server/"] },
  ]), "pairwise-disjoint bounded writers may fan out");
  assert(!shouldFanOut([
    { id: "ui-a", kind: "implementation", readOnly: false, dependsOn: [], expectedFiles: ["ui/"] },
    { id: "ui-b", kind: "implementation", readOnly: false, dependsOn: [], expectedFiles: ["ui/App.tsx"] },
  ]), "overlapping bounded writers remain serialized");
  const defaultControls = normalizedRunControls({});
  assert(defaultControls.runDeadlineMinutes === 0 && defaultControls.capacityCheckpointMinutes === 20 && defaultControls.maxWorkerMinutes === 0 && defaultControls.maxClaudeOutputTokens === 12000, "projects default to continuous duration with rolling capacity checkpoints");
  assert(workerMinutesFor(defaultControls, 4, "antigravity", false) === 60
    && workerMinutesFor(defaultControls, 4, "antigravity", true) === 20
    && workerMinutesFor(defaultControls, 4, "claude", false) === 90
    && workerMinutesFor(defaultControls, 4, "claude", true) === 30
    && workerMinutesFor({ ...defaultControls, maxWorkerMinutes: 25 }, 4, "claude", false) === 25
    && workerMinutesFor({ ...defaultControls, maxWorkerMinutes: 7 }, 3, "antigravity", true) === 7,
  "worker leases are shorter for read-only work, preserve writer complexity budgets, and honor an explicit lower ceiling");
  assert(defaultControls.maxClaudeBudgetUsd === 0, "maxClaudeBudgetUsd defaults to 0 so the auth-aware automatic budget policy applies");
  const subscriptionAuth = { checked: true, loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" };
  const unknownAuth = { checked: true, loggedIn: true, subscriptionType: "" };
  const apiCredentialAuth = { checked: true, loggedIn: true, authMethod: "apiKey", apiProvider: "firstParty", subscriptionType: "pro" };
  assert(claudeBudgetFor(defaultControls, 4, subscriptionAuth, {}) === null, "claude.ai subscription auth without an API key omits the per-worker USD cap and relies on measured quota windows");
  assert(claudeBudgetFor(defaultControls, 4, subscriptionAuth, { ANTHROPIC_API_KEY: pluginRoot }) === 0.75, "an active ANTHROPIC_API_KEY forces the conservative automatic USD cap even with a subscription");
  assert(claudeBudgetFor(defaultControls, 4, unknownAuth, {}) === 0.75, "unknown billing keeps the conservative automatic USD cap");
  assert(claudeBudgetFor(defaultControls, 4, apiCredentialAuth, {}) === 0.75, "non-claude.ai authentication cannot be mistaken for included subscription billing");
  assert(claudeBudgetFor({ ...defaultControls, maxClaudeBudgetUsd: 0.5 }, 4, subscriptionAuth, {}) === 0.5, "an explicit user USD cap is preserved even under subscription auth");
  assert(claudeBudgetFor({ ...defaultControls, maxClaudeBudgetUsd: 2 }, 4, subscriptionAuth, {}) === 2, "an explicit user USD cap is passed unchanged instead of being reduced by automatic complexity scaling");
  assert(claudeBudgetPolicy(defaultControls, subscriptionAuth, {}).policy === "subscription-quota-windows" && claudeBudgetPolicy(defaultControls, unknownAuth, {}).policy === "auto-usd-cap" && claudeBudgetPolicy({ maxClaudeBudgetUsd: 2 }, subscriptionAuth, {}).policy === "explicit-usd-cap", "the selected Claude budget policy is classified for plan/status exposure");
  assert(/subscription-quota-windows/.test(describeClaudeBudgetPolicy(defaultControls, subscriptionAuth, {})) && /auto-usd-cap<=\$0\.75/.test(describeClaudeBudgetPolicy(defaultControls, unknownAuth, {})), "plan/status output names the selected Claude budget policy");
  assert(claudeBudgetFor(defaultControls, 4, subscriptionAuth, { CLAUDE_CODE_USE_BEDROCK: "1" }) === 0.75, "Bedrock/Vertex billing keeps the conservative automatic USD cap");
  const safetyConstraints = normalizedRunConstraints({ constraints: ["Do not access email."] });
  assert(safetyConstraints.some((item) => /OAuth consent/.test(item)) && safetyConstraints.some((item) => /browser and account state/.test(item)) && safetyConstraints.some((item) => /Do not access email/.test(item)), "default browser, account, OAuth, and user constraints are propagated together");
  const contractArgs = { goal: "Refactor a bounded module", mode: "patch", horizonHours: 5 };
  const contractManifest = {
    version: 2,
    mode: "patch",
    horizonHours: 5,
    ...normalizedRunControls(contractArgs),
    constraints: normalizedRunConstraints(contractArgs),
    acceptanceCriteria: [],
    verification: [],
    routingPolicy: routingPolicyFromArgs(contractArgs),
    workItems: buildGoalWorkGraph(contractArgs),
  };
  assert(runContractChanges(contractManifest, contractArgs).length === 0, "identical active goal contracts remain idempotent");
  assert(runContractChanges(contractManifest, { ...contractArgs, constraints: ["Do not access email."] }).includes("constraints"), "same-goal safety changes force a bounded replan");
  assert(runContractChanges(contractManifest, { ...contractArgs, hostCodexAvailable: true }).includes("routingPolicy"), "native Codex host availability is part of the idempotent routing contract");
  const carriedContract = carryForwardSameGoalContract(contractArgs, contractArgs, { ...contractManifest, constraints: [...contractManifest.constraints, "Do not access email."] });
  assert(carriedContract.constraints.some((item) => item === "Do not access email.") && carriedContract.workItems.length === contractManifest.workItems.length, "same-goal continuation preserves terminal-run constraints and work graph");
  const capsuleFixture = buildContextCapsule({
    goal: "Build a bounded project plan",
    workspace: pluginRoot,
    workItems: [{ id: "plan", objective: "Inspect the plugin", expectedFiles: ["scripts/ai-mobile-local-mcp.js", "../outside.txt"], acceptanceCriteria: ["plan is evidence-backed"] }],
    continuitySummary: "Compact prior state only.",
  });
  assert(capsuleFixture.policy.transcriptIncluded === false && capsuleFixture.fileEvidence.every((entry) => !entry.path.includes("outside")), "context capsules exclude transcripts and paths outside the workspace");
  const aliasedCapsuleFixture = buildContextCapsule({ goal: "Repair code", workspace: pluginRoot, workItems: [{ id: "repair", title: "Repair code", class: "code", readOnly: true, files: ["scripts/example.js"] }] });
  assert(aliasedCapsuleFixture.workItems[0]?.executionClass === "code" && aliasedCapsuleFixture.workItems[0]?.readOnly === false, "context capsules preserve alias-normalized writer intent even when readOnly is contradictory");
  assert(capsuleFixture.projectMap.topLevel.length > 0 && capsuleFixture.projectMap.manifests.some((entry) => entry.path === ".codex-plugin/plugin.json"), "context capsules include a lightweight project map and manifest fingerprints");
  assert(JSON.stringify(capsuleFixture).length < 12000, "context capsules remain bounded for token-efficient handoffs");
  const taskCapsuleFixture = buildTaskCapsule(capsuleFixture, capsuleFixture.workItems[0]);
  assert(JSON.stringify(taskCapsuleFixture).length < 8000 && taskCapsuleFixture.workItem.id === "plan", "workers receive a smaller selective task capsule instead of the whole work graph");
  assert(boundedWorkerPrompt({ id: "critical", objective: "review", complexity: "critical", expectedFiles: [], acceptanceCriteria: [], verification: [], readOnly: true }, "goal", "capsule.json").includes("at most 10"), "critical worker prompts preserve the intended compact result budget");
  const agyEvidence = liveAgyEvidence({ antigravityLiveReady: true, rawLimits: { Models: [{ Id: "model-x", DisplayName: "Model X", Quota: { RemainingPercent: 73, ResetTimeUtc: "2026-07-11T02:00:00Z" } }] }, recommendedAvailable: [] }, { id: "model-x", displayName: "Model X" });
  assert(agyEvidence.remainingPercent === 73 && agyEvidence.resetAt === "2026-07-11T02:00:00Z", "Antigravity live per-model quota is read from the full model inventory");
  const fakeContext = {
    codexModel: "caller model",
    codexBudget: { state: "healthy", text: "healthy" },
    codexRemainingPercent: null,
    codexResetAt: "",
    claudeFound: true,
    claudeAuth: { checked: true, loggedIn: true },
    claudeModels: [
      { id: "haiku", displayName: "Claude Haiku (CLI alias)", evidence: "cli-help" },
      { id: "sonnet", displayName: "Claude Sonnet (CLI alias)", evidence: "cli-help" },
      { id: "opus", displayName: "Claude Opus (CLI alias)", evidence: "cli-help" },
      { id: "fable", displayName: "Claude Fable 5 (CLI alias)", evidence: "cli-help" },
    ],
    claudeUsage,
    claudeObservedModel: "claude-sonnet-5",
    agyFound: true,
    agyModels: [
      { id: "gemini-3.5-flash-low", displayName: "Gemini 3.5 Flash (Low)" },
      { id: "gemini-3.5-flash-medium", displayName: "Gemini 3.5 Flash (Medium)" },
      { id: "claude-opus-4.6-thinking", displayName: "Claude Opus 4.6 (Thinking)" },
    ],
    antigravityLiveReady: false,
    recommendedAvailable: [],
    cursorHeadlessFound: false,
    workspaceState: { outcomes: {}, decisions: [] },
  };
  const gatedAgy = buildResourceCandidates({}, fakeContext).filter((candidate) => candidate.platform === "antigravity");
  assert(gatedAgy.length > 0 && gatedAgy.every((candidate) => candidate.dispatchable === false && candidate.state === "authorization-required"), "Antigravity CLI cannot auto-dispatch when an OAuth popup was not explicitly authorized");
  const enabledAgy = buildResourceCandidates({ allowAntigravityCli: true }, fakeContext).filter((candidate) => candidate.platform === "antigravity");
  assert(enabledAgy.some((candidate) => candidate.dispatchable === true), "explicit Antigravity CLI authorization enables its model roster");
  const unattendedInteractiveAgy = buildResourceCandidates({ allowAntigravityCli: true, unattendedMode: true }, fakeContext).filter((candidate) => candidate.platform === "antigravity");
  assert(unattendedInteractiveAgy.every((candidate) => candidate.dispatchable === false && candidate.state === "interactive-permission-required"), "unattended routing excludes Antigravity when tool permission prompts are not pre-authorized");
  const unattendedApprovedAgy = buildResourceCandidates({ allowAntigravityCli: true, unattendedMode: true, allowAntigravityPermissionBypass: true }, fakeContext).filter((candidate) => candidate.platform === "antigravity");
  assert(unattendedApprovedAgy.some((candidate) => candidate.dispatchable === true && candidate.permissionMode === "sandboxed-auto-approve"), "explicit sandboxed permission auto-approval makes Antigravity eligible for unattended work");
  const profiledUnattended = applyLocalRuntimePolicy({ unattendedMode: true, localProfile: { ...DEFAULT_PROFILE, antigravityAutoApprovePermissions: true } });
  assert(profiledUnattended.allowAntigravityPermissionBypass === true, "private local Antigravity permission policy is applied only to unattended runs");
  const baselineRoutingContext = {
    ...fakeContext,
    claudeUsage: {
      ...claudeUsage,
      windows: (claudeUsage.windows || []).map((window) => window.scope === "fable"
        ? { ...window, resetAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() }
        : window),
    },
  };
  const orchestrationDecision = buildResourceOrchestrationDecision({
    goal: "Implement and verify a cross-platform resource orchestrator plugin",
    mode: "patch",
    allowAntigravityCli: true,
    workItems: [
      { id: "implement", objective: "Implement the orchestration control loop", kind: "implementation-architecture", complexity: "high", readOnly: false },
      { id: "verify", objective: "Independently verify failure handling", kind: "testing-review", complexity: "medium", readOnly: true, dependsOn: ["implement"] },
    ],
  }, baselineRoutingContext);
  const implementationAssignment = orchestrationDecision.workItems.find((item) => item.id === "implement")?.assignment;
  assert(implementationAssignment === "claude:sonnet", `high-value implementation selects Claude Sonnet as the single writer (got ${implementationAssignment || "none"})`);
  assert(orchestrationDecision.workItems.find((item) => item.id === "verify")?.assignment.startsWith("antigravity:"), "independent verification selects a different available team");
  assert(orchestrationDecision.workItems.find((item) => item.id === "verify")?.alternates.includes("claude:sonnet"), "failover pool keeps a cross-platform alternate even when one provider has many models");
  const exactClaudeCandidate = buildResourceCandidates({}, {
    ...fakeContext,
    claudeModels: [{ id: "haiku", resolvedId: "claude-haiku-4-5-20251001", displayName: "Claude Haiku", evidence: "observed-alias-resolution" }],
  }).find((candidate) => candidate.id === "claude:haiku");
  assert(exactClaudeCandidate?.model === "claude-haiku-4-5-20251001" && exactClaudeCandidate.modelAlias === "haiku", "Claude workers dispatch the verified exact model id while retaining the quota alias");
  const routineDecision = buildResourceOrchestrationDecision({
    goal: "Draft a routine project review",
    mode: "review",
    workItems: [{ id: "routine", objective: "Review the current implementation", kind: "review", complexity: "medium", readOnly: true }],
  }, baselineRoutingContext);
  assert(routineDecision.workItems[0]?.assignment !== "claude:fable", "routine work never selects premium Claude Fable");
  const criticalDecision = buildResourceOrchestrationDecision({
    goal: "Resolve a production incident safely",
    mode: "patch",
    workItems: [{ id: "incident", objective: "Resolve a production incident with adversarial verification", kind: "incident-debugging", complexity: "critical", readOnly: false }],
  }, baselineRoutingContext);
  assert(criticalDecision.workItems[0]?.assignment === "claude:sonnet", "critical work keeps the strongest healthy general coding model instead of spending Fable by default");
  const resetOpportunityContext = {
    ...fakeContext,
    claudeUsage: {
      ...claudeUsage,
      windows: claudeUsage.windows.map((window) => window.scope === "fable"
        ? { ...window, resetAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() }
        : window),
    },
  };
  const resetOpportunityDecision = buildResourceOrchestrationDecision({
    goal: "Use a high-value architecture review before dedicated Fable capacity resets",
    horizonHours: 5,
    mode: "review",
    workItems: [{ id: "premium-window", objective: "Review a risky architecture decision", kind: "architecture-review", complexity: "high", readOnly: true }],
  }, resetOpportunityContext);
  assert(resetOpportunityDecision.workItems[0]?.assignment === "claude:fable", "high-value work may use healthy dedicated Fable capacity shortly before its reset");
  const explicitFableArgs = {
    goal: "Run an explicitly requested Fable review",
    claudeModel: "claude-fable-5",
    mode: "review",
    workItems: [{ id: "explicit-fable", objective: "Review a bounded architecture decision with the explicitly requested model", kind: "architecture-review", complexity: "high", readOnly: true }],
  };
  const explicitFableDecision = buildResourceOrchestrationDecision(explicitFableArgs, fakeContext);
  const explicitFableCandidate = explicitFableDecision.candidates.find((candidate) => candidate.id === "claude:fable");
  const explicitFableScore = scoreResourceForWorkItem(explicitFableCandidate, explicitFableDecision.workItems[0], explicitFableArgs);
  assert(Number.isFinite(explicitFableScore) && explicitFableScore > 100, "explicit Fable remains eligible after the automatic reserve gate");
  assert(explicitFableDecision.workItems[0]?.assignment === "claude:fable", "an explicit full Fable model id overrides the automatic reserve policy");
  const criteriaDecision = buildResourceOrchestrationDecision({
    goal: "Implement a bounded change",
    workItems: [{ id: "criteria", objective: "Implement a bounded change", kind: "implementation", acceptanceCriteria: ["test passes"], verification: ["run focused test"], readOnly: false }],
  }, fakeContext);
  assert(criteriaDecision.workItems[0]?.acceptanceCriteria?.[0] === "test passes" && criteriaDecision.workItems[0]?.verification?.[0] === "run focused test", "acceptance and focused verification criteria survive normalization");
  const broadReviewDecision = buildResourceOrchestrationDecision({
    goal: "Review current project health and report the main blocker",
    mode: "review",
    allowAntigravityCli: true,
    workItems: [{ id: "broad-review", objective: "Review current project health and report the main blocker", kind: "verification-review", complexity: "low", readOnly: true, preferredPlatform: "antigravity" }],
  }, fakeContext);
  assert(broadReviewDecision.workItems[0]?.assignment === "antigravity:gemini-3.5-flash-medium", "broad low-risk review prefers Flash Medium over Flash Low");
  const microReviewDecision = buildResourceOrchestrationDecision({
    goal: "Read one manifest value",
    mode: "review",
    allowAntigravityCli: true,
    workItems: [{ id: "micro-review", objective: "Read one manifest value", kind: "verification", complexity: "low", readOnly: true, preferredPlatform: "antigravity", expectedFiles: [".codex-plugin/plugin.json"] }],
  }, fakeContext);
  assert(microReviewDecision.workItems[0]?.assignment === "antigravity:gemini-3.5-flash-low", "file-bounded micro review may use Flash Low");
  const failedOutcome = compactOutcome({ lastFailureAt: utcStamp(), recentKinds: ["verification-review"] });
  assert(failedOutcome.successfulKinds.length === 0 && failedOutcome.consecutiveFailures === 1, "failed work does not become future capability affinity");
  const reliabilityContext = {
    ...fakeContext,
    workspaceState: {
      outcomes: {
        "claude:sonnet": { lastSuccessAt: utcStamp(), successfulKinds: ["verification-review"] },
        "antigravity:gemini-3.5-flash-low": { lastFailureAt: utcStamp(), lastCategory: "timeout" },
        "antigravity:gemini-3.5-flash-medium": { lastFailureAt: utcStamp(), lastCategory: "timeout" },
      },
      decisions: [],
    },
  };
  const reliabilityDecision = buildResourceOrchestrationDecision({
    goal: "Review current project health after repeated platform timeouts",
    mode: "review",
    workItems: [{ id: "reliability-review", objective: "Review current project health after repeated platform timeouts", kind: "verification-review", complexity: "low", readOnly: true }],
  }, reliabilityContext);
  assert(reliabilityDecision.workItems[0]?.assignment === "claude:sonnet", "repeated recent platform failures route broad work to the proven alternative");
  const consequentialDecision = buildResourceOrchestrationDecision({
    goal: "Start controlled real job submissions",
    workItems: [{ id: "submit-real-jobs", objective: "Submit real job applications through the live harness", kind: "operation", complexity: "high", readOnly: false }],
  }, fakeContext);
  assert(consequentialDecision.workItems[0]?.assignment === "codex:current" && consequentialDecision.workItems[0]?.externallyConsequential === true, "externally consequential operations remain owned by the current Codex session");
  const directReviewDecision = buildResourceOrchestrationDecision({
    goal: "Perform one controlled live operation and verify it",
    managerOnly: false,
    workItems: [
      { id: "live-operation", objective: "Perform one controlled live operation", kind: "operation", complexity: "high", readOnly: false, externallyConsequential: true },
      { id: "cycle-review", objective: "Review the terminal evidence", kind: "review", complexity: "low", readOnly: true, dependsOn: ["live-operation"] },
    ],
  }, fakeContext);
  assert(directReviewDecision.workItems.find((item) => item.id === "cycle-review")?.assignment === "codex:current", "redundant low-complexity review of direct operational evidence stays with Codex");
  const managerOnlyReviewDecision = buildResourceOrchestrationDecision({
    goal: "Manage one controlled live operation and report its evidence",
    managerOnly: true,
    workItems: [
      { id: "live-operation", objective: "Perform one controlled live operation", kind: "operation", complexity: "high", readOnly: false, externallyConsequential: true },
      { id: "cycle-review", objective: "Review the terminal evidence", kind: "review", complexity: "low", readOnly: true, dependsOn: ["live-operation"] },
    ],
  }, fakeContext);
  assert(managerOnlyReviewDecision.workItems.find((item) => item.id === "live-operation")?.assignment === "codex:current", "manager-only mode keeps the non-delegable live operation at the user boundary");
  assert(managerOnlyReviewDecision.workItems.find((item) => item.id === "cycle-review")?.assignment !== "codex:current", "manager-only mode delegates terminal evidence review instead of consuming the control-room chat");
  const unavailableManagerDecision = buildResourceOrchestrationDecision({
    goal: "Review a project while every worker is unavailable",
    managerOnly: true,
    mode: "review",
    workItems: [{ id: "review", objective: "Review the current project", kind: "review", complexity: "medium", readOnly: true }],
  }, {
    ...fakeContext,
    claudeFound: false,
    claudeAuth: { checked: true, loggedIn: false },
    claudeModels: [],
    agyFound: false,
    agyModels: [],
    recommendedAvailable: [],
  });
  assert(unavailableManagerDecision.workItems[0]?.assignment === "resource:unavailable", "manager-only mode blocks when no worker is available instead of silently making current Codex execute the task");
  const privateRoutingProfile = {
    codexModelAllowPattern: "^gpt-5\\.6-(sol|terra|luna)$",
    claudeModelAllowPattern: "^(?!.*haiku).*$",
    claudePreferredModelPattern: "sonnet",
    antigravityPreferredTaskPattern: "browser|file|read|discovery|research|review|docs|summary|scout",
    adaptiveRouting: true,
  };
  assert(DEFAULT_PROFILE.claudePreferredModelPattern === "(?!)" && DEFAULT_PROFILE.antigravityPreferredTaskPattern === "(?!)", "public routing defaults remain provider-neutral instead of publishing one user's preferences");
  const normalizedPrivateProfile = normalizeProfile(privateRoutingProfile);
  assert(normalizedPrivateProfile.codexModelAllowPattern === privateRoutingProfile.codexModelAllowPattern && normalizedPrivateProfile.claudeModelAllowPattern === privateRoutingProfile.claudeModelAllowPattern, "private model policies survive local profile normalization");
  const hostRoutingContext = {
    ...fakeContext,
    codexCatalog: {
      models: [
        { id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", defaultReasoning: "medium", reasoningLevels: ["low", "medium", "high", "xhigh", "max", "ultra"] },
        { id: "gpt-5.6-terra", displayName: "GPT-5.6 Terra", defaultReasoning: "medium", reasoningLevels: ["low", "medium", "high", "xhigh", "max", "ultra"] },
        { id: "gpt-5.6-luna", displayName: "GPT-5.6 Luna", defaultReasoning: "medium", reasoningLevels: ["low", "medium", "high", "xhigh", "max"] },
        { id: "gpt-5.5", displayName: "GPT-5.5", defaultReasoning: "medium", reasoningLevels: ["low", "medium", "high"] },
      ],
    },
    codexTelemetry: { found: true, fresh: true, state: "healthy", evidence: "test", effectiveRemainingPercent: 75, windows: [] },
    claudeFound: false,
    claudeAuth: { checked: true, loggedIn: false },
    claudeModels: [],
    agyFound: false,
    agyModels: [],
    recommendedAvailable: [],
  };
  const fullTeamParallelDecision = buildResourceOrchestrationDecision({
    goal: "Improve independent UI, backend, and verification lanes in parallel",
    managerOnly: true,
    hostCodexAvailable: true,
    allowAntigravityCli: true,
    maxParallelWriters: 2,
    localProfile: privateRoutingProfile,
    workItems: [
      { id: "ui", objective: "Improve the UI implementation", executionClass: "code", complexity: "high", expectedFiles: ["ui/"] },
      { id: "backend", objective: "Improve the backend implementation", executionClass: "code", complexity: "high", expectedFiles: ["server/"] },
      { id: "verification", objective: "Independently verify the project behavior", executionClass: "analysis", complexity: "medium", expectedFiles: ["tests/"] },
    ],
  }, {
    ...baselineRoutingContext,
    codexCatalog: hostRoutingContext.codexCatalog,
    codexTelemetry: hostRoutingContext.codexTelemetry,
  });
  const fullTeamPlatforms = new Set(fullTeamParallelDecision.workItems.map((item) => String(item.assignment || "").split(":")[0]));
  assert(fullTeamPlatforms.has("codex-host") && fullTeamPlatforms.has("claude") && fullTeamPlatforms.has("antigravity"), `independent disjoint work uses native Codex, Claude, and Antigravity together when all are healthy (got ${[...fullTeamPlatforms].join(",")})`);
  const externalParallelDecision = buildResourceOrchestrationDecision({
    goal: "Improve two independent code boundaries while native Codex is unavailable",
    managerOnly: true,
    allowAntigravityCli: true,
    localProfile: privateRoutingProfile,
    workItems: [
      { id: "ui-external", objective: "Improve the UI implementation", executionClass: "code", complexity: "high", expectedFiles: ["ui/"] },
      { id: "backend-external", objective: "Improve the backend implementation", executionClass: "code", complexity: "high", expectedFiles: ["server/"] },
    ],
  }, {
    ...baselineRoutingContext,
    agyModels: [...baselineRoutingContext.agyModels, { id: "gemini-3.1-pro-high", displayName: "Gemini 3.1 Pro (High)" }],
  });
  const externalParallelPlatforms = new Set(externalParallelDecision.workItems.map((item) => String(item.assignment || "").split(":")[0]));
  assert(externalParallelPlatforms.has("claude") && externalParallelPlatforms.has("antigravity"), `disjoint writers stay parallel across Claude and Antigravity when native Codex is unavailable (got ${[...externalParallelPlatforms].join(",")})`);
  const nativeCodexDecision = buildResourceOrchestrationDecision({
    goal: "Implement and test a bounded project change",
    managerOnly: true,
    hostCodexAvailable: true,
    localProfile: privateRoutingProfile,
    workItems: [{ id: "native-implementation", objective: "Implement and test the bounded patch", kind: "implementation-testing", complexity: "high", readOnly: false, expectedFiles: ["scripts/example.js"] }],
  }, hostRoutingContext);
  assert(nativeCodexDecision.workItems[0]?.assignment === "codex-host:gpt-5.6-terra", `manager-only routing uses a separate Terra native Codex worker for balanced implementation (got ${nativeCodexDecision.workItems[0]?.assignment || "none"})`);
  assert(!nativeCodexDecision.candidates.some((candidate) => candidate.id === "codex-host:gpt-5.5"), "private Codex allow policy excludes models outside Sol, Terra, and Luna");
  const reserveContext = {
    ...hostRoutingContext,
    codexRemainingPercent: 15,
    codexBudget: { state: "critical", text: "15% remaining" },
    codexTelemetry: { ...hostRoutingContext.codexTelemetry, effectiveRemainingPercent: 15, state: "critical" },
  };
  const reserveDecision = buildResourceOrchestrationDecision({
    goal: "Protect the manager while continuing bounded project work",
    managerOnly: true,
    hostCodexAvailable: true,
    codexManagerReservePercent: 15,
    localProfile: privateRoutingProfile,
    workItems: [{ id: "reserved-implementation", objective: "Implement the bounded patch", kind: "implementation", complexity: "high", readOnly: false, expectedFiles: ["scripts/example.js"] }],
  }, reserveContext);
  assert(reserveDecision.candidates.filter((candidate) => candidate.dispatchMode === "host-subagent").every((candidate) => candidate.state === "manager-reserve" && candidate.dispatchable === false), "native Codex dispatch stops before consuming the manager reserve");
  assert(capacityCheckpointDelayMinutes({ ...normalizedRunControls({}), resources: reserveDecision.candidates }) === 5, "capacity reviews accelerate to five minutes when the Codex manager reserve is active");
  const runwayText = projectManagerRunwayLines(normalizedRunControls({ codexManagerReservePercent: 18, maxConcurrentCodexWorkers: 1 }), reserveContext, reserveDecision.candidates).join("\n");
  assert(runwayText.includes("CodexManagerReserve: 18%") && runwayText.includes("CodexWorkerConcurrency: 1") && runwayText.includes("QuotaResetContinuity: durable run state persists"), "project-manager plans expose manager reserve, Codex worker concurrency, and reset continuity");
  const boundaryEvidence = "BOUNDARY writer-a: `scripts/ai-mobile-local-mcp.js`\nBOUNDARY writer-b: `README.md`";
  assert(inferFileBoundaryFromEvidence(pluginRoot, boundaryEvidence, "writer-a").join(",") === path.join("scripts", "ai-mobile-local-mcp.js"), "writer boundary parsing uses only the target's machine-readable boundary line");
  assert(inferFileBoundaryFromEvidence(pluginRoot, "Observed `README.md` before proposing a correction.", "writer-a").length === 0, "writer boundaries never fall back to incidental backtick paths when the target marker is missing");
  assert(!validateBoundaryEvidenceContract({ workspace: pluginRoot, boundaryTargets: ["writer-a"] }, "Proposed `README.md` in prose only.").ok, "boundary discovery without the required target marker fails its result contract");
  assert(validateBoundaryEvidenceContract({ workspace: pluginRoot, boundaryTargets: ["writer-a", "writer-b"] }, boundaryEvidence).ok, "boundary discovery passes only when every requested target has a valid machine-readable path");
  const scopeCandidate = {
    id: "antigravity:gemini-3.5-flash-medium",
    platform: "antigravity",
    team: "Antigravity CLI",
    model: "gemini-3.5-flash-medium",
    displayName: "Gemini 3.5 Flash Medium",
    dispatchable: true,
    state: "available",
    evidence: "self-test",
    remainingPercent: 80,
    resetAt: "",
    capabilities: ["general-reasoning", "discovery", "review", "docs", "fast-analysis"],
    quality: 74,
    speed: 90,
    cost: 95,
    premium: false,
  };
  const boundaryWriter = {
    ...normalizeWorkItem({ id: "writer-needing-scope", objective: "Implement a bounded change", kind: "implementation", complexity: "high", readOnly: false, dependsOn: ["discovery"] }, 1, "high"),
    state: "failed",
    assignment: "claude:sonnet",
    assignedModel: "sonnet",
    failoverCount: 1,
    blocker: "External writer dispatch refused because no verified file boundary was available. Manager-only mode will not inspect or implement the item; rescope it through one bounded discovery worker.",
    failureCategory: "worker-failure",
  };
  const scopeRecovery = addBoundaryScopeRecovery({
    version: 2,
    runId: "scope-recovery-test",
    workspace: pluginRoot,
    goal: "Test automatic writer scope recovery",
    managerOnly: true,
    resources: [scopeCandidate],
    workItems: [{ ...normalizeWorkItem({ id: "discovery", objective: "Discover scope", kind: "discovery", readOnly: true }, 0, "low"), state: "completed" }, boundaryWriter],
    decisions: [],
  }, [boundaryWriter]);
  const recoveredWriter = scopeRecovery.manifest.workItems.find((item) => item.id === boundaryWriter.id);
  const scopeWorker = scopeRecovery.manifest.workItems.find((item) => item.scopeFor === boundaryWriter.id);
  assert(recoveredWriter?.state === "pending" && recoveredWriter.failoverCount === 0 && scopeWorker?.readOnly === true && scopeWorker.assignment === scopeCandidate.id, "missing writer boundaries launch one read-only scope worker without consuming provider failover");
  const filteredClaude = buildResourceCandidates({ localProfile: privateRoutingProfile }, fakeContext).filter((candidate) => candidate.platform === "claude");
  assert(!filteredClaude.some((candidate) => /haiku/i.test(candidate.id)) && filteredClaude.some((candidate) => /sonnet/i.test(candidate.id)), "private Claude policy excludes Haiku while retaining Sonnet");
  const terraResource = nativeCodexDecision.candidates.find((candidate) => candidate.id === "codex-host:gpt-5.6-terra");
  const hostRunBase = {
    version: 2,
    runId: "host-lifecycle-test",
    workspace: pluginRoot,
    goal: "Test native Codex lifecycle",
    contextCapsulePath: path.join(pluginRoot, ".antigravity-bridge", "orchestrator", "project-capsule.json"),
    managerOnly: true,
    resources: nativeCodexDecision.candidates,
    decisions: [],
    jobs: [],
    workItems: [],
  };
  const preparedHostItem = prepareHostAssignedItem(hostRunBase, {
    ...normalizeWorkItem({ id: "native-implementation", objective: "Implement and test the bounded patch", kind: "implementation-testing", complexity: "high", readOnly: false, expectedFiles: ["scripts/example.js"] }, 0, "high"),
    assignment: terraResource.id,
    assignedModel: terraResource.model,
  }, terraResource);
  const hostLifecycleManifest = { ...hostRunBase, workItems: [preparedHostItem], jobs: ensureHostDispatchReservations([preparedHostItem], []), state: "ready-for-codex" };
  let wrongHostTokenRejected = false;
  try {
    applyHostWorkerEvents(hostLifecycleManifest, { hostWorkerEvents: [{ event: "started", runId: hostLifecycleManifest.runId, workItemId: preparedHostItem.id, attemptId: preparedHostItem.hostAttempt.attemptId, dispatchToken: "wrong", agentId: "agent-1" }] });
  } catch (error) {
    wrongHostTokenRejected = /token does not match/i.test(String(error?.message || ""));
  }
  assert(wrongHostTokenRejected, "native Codex host events reject a mismatched dispatch token");
  const hostReservedEvent = { event: "reserved", runId: hostLifecycleManifest.runId, workItemId: preparedHostItem.id, attemptId: preparedHostItem.hostAttempt.attemptId, dispatchToken: preparedHostItem.hostAttempt.dispatchToken };
  let unreservedStartRejected = false;
  try {
    applyHostWorkerEvents(hostLifecycleManifest, { hostWorkerEvents: [{ ...hostReservedEvent, event: "started", agentId: "agent-unreserved" }] });
  } catch (error) {
    unreservedStartRejected = /must be reserved/i.test(String(error?.message || ""));
  }
  assert(unreservedStartRejected, "native host spawn cannot start before the manager acknowledges its reservation");
  const hostReserved = applyHostWorkerEvents(hostLifecycleManifest, { hostWorkerEvents: [hostReservedEvent] });
  const reservedActionText = formatTeamRunSnapshot(pluginRoot, hostReserved, 0);
  assert(hostReserved.workItems[0]?.state === "host-reserved" && reservedActionText.includes("multi_agent_v1__spawn_agent"), "pre-spawn reservation is durable and continues to expose the exact spawn action");
  assert(syncWorkItemsFromJobs(hostReserved).workItems[0]?.state === "host-reserved", "host refresh preserves a reserved spawn action without reading status.json");
  const hostStartedEvent = { event: "started", runId: hostLifecycleManifest.runId, workItemId: preparedHostItem.id, attemptId: preparedHostItem.hostAttempt.attemptId, dispatchToken: preparedHostItem.hostAttempt.dispatchToken, agentId: "agent-1", nickname: "Terra worker" };
  const hostStarted = applyHostWorkerEvents(hostReserved, { hostWorkerEvents: [hostStartedEvent] });
  assert(hostStarted.workItems[0]?.state === "host-running" && hostStarted.jobs[0]?.transport === "host-subagent", "native Codex start acknowledgement enters the durable host-running state");
  assert(!formatTeamRunSnapshot(pluginRoot, hostStarted, 0).includes("HostCodexActions:"), "started native workers no longer expose a spawn action");
  assert(syncWorkItemsFromJobs(hostStarted).workItems[0]?.state === "host-running", "filesystem refresh preserves acknowledged native Codex workers without requiring status.json");
  const hostStartedAgain = applyHostWorkerEvents(hostStarted, { hostWorkerEvents: [hostStartedEvent] });
  assert(hostStartedAgain.jobs.length === 1 && hostStartedAgain.jobs[0]?.agentId === "agent-1", "duplicate native Codex start acknowledgement is idempotent");
  const hostCompleted = applyHostWorkerEvents(hostStarted, { hostWorkerEvents: [{ ...hostStartedEvent, event: "completed", summary: "Implemented the bounded native Codex test patch and verified its behavior.", changedFiles: ["scripts/example.js"], testSummary: "Focused test passed.", observedModel: "gpt-5.6-terra" }] });
  assert(hostCompleted.workItems[0]?.state === "completed" && hostCompleted.jobs[0]?.state === "completed" && hostCompleted.workItems[0]?.hostEvidence?.testSummary, "native Codex completion requires and records compact writer evidence");
  const secondPreparedHostItem = prepareHostAssignedItem({ ...hostRunBase, runId: "host-cancel-test" }, { ...preparedHostItem, hostAttempt: null, hostAction: null }, terraResource);
  const cancelBase = { ...hostRunBase, runId: "host-cancel-test", workItems: [secondPreparedHostItem], jobs: ensureHostDispatchReservations([secondPreparedHostItem], []) };
  const cancelStartedEvent = { event: "started", runId: cancelBase.runId, workItemId: secondPreparedHostItem.id, attemptId: secondPreparedHostItem.hostAttempt.attemptId, dispatchToken: secondPreparedHostItem.hostAttempt.dispatchToken, agentId: "agent-2" };
  const cancelReserved = applyHostWorkerEvents(cancelBase, { hostWorkerEvents: [{ ...cancelStartedEvent, event: "reserved", agentId: undefined }] });
  const cancelStarted = applyHostWorkerEvents(cancelReserved, { hostWorkerEvents: [cancelStartedEvent] });
  const cancellationPending = terminateOrchestrationRun(pluginRoot, cancelStarted, "User changed the goal.", "user-steering");
  assert(cancellationPending.termination?.cancellationUnconfirmed === 1 && cancellationPending.workItems[0]?.state === "host-cancel-required", "native Codex cancellation must be acknowledged before replacement");
  const cancellationConfirmed = applyHostWorkerEvents(cancellationPending, { hostWorkerEvents: [{ ...cancelStartedEvent, event: "cancelled", summary: "Host agent closure confirmed." }] });
  assert(cancellationConfirmed.termination?.cancellationUnconfirmed === 0, "confirmed native Codex cancellation clears the replacement blocker");
  const hostCheckpoint = applyCapacityCheckpointCandidates(hostStarted, nativeCodexDecision.candidates, { localProfile: privateRoutingProfile }).manifest;
  assert(hostCheckpoint.workItems[0]?.state === "host-running" && hostCheckpoint.workItems[0]?.hostAgent?.agentId === "agent-1", "capacity refresh never interrupts or reroutes a running native Codex worker");

  assert(normalizeManagerOnly({}).managerOnly === true && normalizeManagerOnly({ managerOnly: undefined }).managerOnly === true, "every orchestration entrypoint defaults managerOnly to true when the caller omits it");
  assert(normalizeManagerOnly({ managerOnly: false }).managerOnly === false, "an explicit managerOnly=false is preserved instead of being forced back to manager-only");
  const parsedActionSummary = actionSummary("SubmitWorkerResult:\nJobId: worker-test\nWorkerPid: 321\nStarted: true", "worker-tool", pluginRoot);
  assert(parsedActionSummary.workerPid === 321 && parsedActionSummary.workerCommandMarker === "worker-test", "new worker reservations retain process identity before the first status refresh");

  const reservationHostItem = prepareHostAssignedItem({ ...hostRunBase, runId: "host-reservation-test" }, { ...preparedHostItem, hostAttempt: null, hostAction: null }, terraResource);
  const reservedManifest = { ...hostRunBase, runId: "host-reservation-test", workItems: [reservationHostItem], jobs: ensureHostDispatchReservations([reservationHostItem], []) };
  assert(reservedManifest.jobs.length === 1 && reservedManifest.jobs[0]?.state === "queued" && reservedManifest.jobs[0]?.jobId === reservationHostItem.hostAttempt.attemptId, "a token-bound dispatching reservation is recorded before the host agent is ever spawned");
  const acknowledgedReservation = applyHostWorkerEvents(reservedManifest, { hostWorkerEvents: [{ event: "reserved", runId: reservedManifest.runId, workItemId: reservationHostItem.id, attemptId: reservationHostItem.hostAttempt.attemptId, dispatchToken: reservationHostItem.hostAttempt.dispatchToken }] });
  const terminatedBeforeAck = terminateOrchestrationRun(pluginRoot, acknowledgedReservation, "User changed the goal before the native worker acknowledged start.", "user-steering");
  assert(terminatedBeforeAck.workItems[0]?.state === "host-cancel-required", "termination targets an acknowledged pre-spawn reservation instead of missing it as blocked");
  const reservationBoundEvent = { event: "started", runId: reservedManifest.runId, workItemId: reservationHostItem.id, attemptId: reservationHostItem.hostAttempt.attemptId, dispatchToken: reservationHostItem.hostAttempt.dispatchToken, agentId: "agent-3" };
  const startedAfterCancellation = applyHostWorkerEvents(terminatedBeforeAck, { hostWorkerEvents: [{ ...reservationBoundEvent, agentId: "agent-raced" }] });
  assert(startedAfterCancellation.workItems[0]?.state === "host-cancel-required" && startedAfterCancellation.workItems[0]?.hostAgent?.agentId === "agent-raced", "a spawned-but-unacknowledged worker is bound for cancellation instead of escaping replacement safety");
  const cancelledBeforeStart = applyHostWorkerEvents(terminatedBeforeAck, { hostWorkerEvents: [{ event: "cancelled", runId: reservedManifest.runId, workItemId: reservationHostItem.id, attemptId: reservationHostItem.hostAttempt.attemptId, dispatchToken: reservationHostItem.hostAttempt.dispatchToken, summary: "Spawn was skipped after cancellation." }] });
  assert(cancelledBeforeStart.termination?.cancellationUnconfirmed === 0, "cancellation before host start clears the reservation safety gate");
  const reservationBound = applyHostWorkerEvents(acknowledgedReservation, { hostWorkerEvents: [reservationBoundEvent] });
  assert(reservationBound.jobs.length === 1 && reservationBound.jobs[0]?.state === "running" && reservationBound.jobs[0]?.jobId === reservationHostItem.hostAttempt.attemptId, "the started event binds the existing reservation in place instead of creating a second job entry");

  const secondWritableHostItem = prepareHostAssignedItem(
    { ...hostRunBase, runId: "host-writer-serialization-test" },
    { ...normalizeWorkItem({ id: "native-implementation-2", objective: "Implement a second bounded patch", kind: "implementation-testing", complexity: "high", readOnly: false, expectedFiles: ["scripts/example2.js"] }, 1, "high"), assignment: terraResource.id, assignedModel: terraResource.model },
    terraResource,
  );
  const firstWritableHostItem = prepareHostAssignedItem({ ...hostRunBase, runId: "host-writer-serialization-test" }, { ...preparedHostItem, hostAttempt: null, hostAction: null }, terraResource);
  const dualWriterWorkItems = [firstWritableHostItem, secondWritableHostItem];
  const dualWriterSnapshot = {
    ...hostRunBase,
    runId: "host-writer-serialization-test",
    maxConcurrentCodexWorkers: 2,
    maxParallelWriters: 2,
    workItems: dualWriterWorkItems,
    jobs: ensureHostDispatchReservations(dualWriterWorkItems, []),
    state: "ready-for-codex",
    counts: { total: 2, completed: 0, running: 2, failed: 0 },
  };
  const bothWritersReserved = applyHostWorkerEvents(dualWriterSnapshot, { hostWorkerEvents: dualWriterWorkItems.map((item) => ({ event: "reserved", runId: dualWriterSnapshot.runId, workItemId: item.id, attemptId: item.hostAttempt.attemptId, dispatchToken: item.hostAttempt.dispatchToken })) });
  const dualWriterText = formatTeamRunSnapshot(pluginRoot, bothWritersReserved, 0);
  const emittedSpawnInstructions = (dualWriterText.match(/multi_agent_v1__spawn_agent/g) || []).length;
  assert(emittedSpawnInstructions === 2, "two native writers may launch together when their verified file boundaries are disjoint and capacity allows it");
  const overlappingWriter = prepareHostAssignedItem(
    { ...hostRunBase, runId: "host-writer-overlap-test" },
    { ...normalizeWorkItem({ id: "native-overlap", objective: "Implement an overlapping patch", kind: "implementation", complexity: "high", readOnly: false, expectedFiles: ["scripts/example.js"] }, 1, "high"), assignment: terraResource.id, assignedModel: terraResource.model },
    terraResource,
  );
  const overlapItems = [firstWritableHostItem, overlappingWriter].map((item) => ({ ...item, hostAttempt: { ...item.hostAttempt, attemptId: `overlap-${item.id}`, dispatchToken: `token-${item.id}`, state: "dispatch-required" } }));
  const overlapSnapshot = {
    ...hostRunBase,
    runId: "host-writer-overlap-test",
    maxConcurrentCodexWorkers: 2,
    maxParallelWriters: 2,
    workItems: overlapItems,
    jobs: ensureHostDispatchReservations(overlapItems, []),
    state: "ready-for-codex",
    counts: { total: 2, completed: 0, running: 2, failed: 0 },
  };
  const overlapReserved = applyHostWorkerEvents(overlapSnapshot, { hostWorkerEvents: overlapItems.map((item) => ({ event: "reserved", runId: overlapSnapshot.runId, workItemId: item.id, attemptId: item.hostAttempt.attemptId, dispatchToken: item.hostAttempt.dispatchToken })) });
  assert((formatTeamRunSnapshot(pluginRoot, overlapReserved, 0).match(/multi_agent_v1__spawn_agent/g) || []).length === 1, "overlapping native writers expose only one spawn action");
  const activeWriterManifest = {
    maxParallelWriters: 2,
    workItems: [
      { id: "ui", readOnly: false, expectedFiles: ["ui/"] },
      { id: "backend", readOnly: false, expectedFiles: ["server/"] },
      { id: "ui-overlap", readOnly: false, expectedFiles: ["ui/App.tsx"] },
    ],
    jobs: [{ jobId: "ui-job", state: "running", workItemIds: ["ui"] }],
  };
  assert(writerGroupCanLaunch(activeWriterManifest, [activeWriterManifest.workItems[1]]) === true, "an external disjoint writer may launch while another boundary is active");
  assert(writerGroupCanLaunch(activeWriterManifest, [activeWriterManifest.workItems[2]]) === false, "an external overlapping writer waits for the active boundary");
  const parallelReadItems = ["native-read-1", "native-read-2"].map((id, index) => prepareHostAssignedItem(
    { ...hostRunBase, runId: "host-capacity-serialization-test" },
    { ...normalizeWorkItem({ id, objective: `Review bounded area ${index + 1}`, kind: "review", complexity: "medium", readOnly: true, priority: index === 0 ? 10 : 90, expectedFiles: [`scripts/read-${index + 1}.js`] }, index, "medium"), assignment: terraResource.id, assignedModel: terraResource.model },
    terraResource,
  ));
  const parallelReadSnapshot = {
    ...hostRunBase,
    runId: "host-capacity-serialization-test",
    maxConcurrentCodexWorkers: 1,
    workItems: parallelReadItems,
    jobs: ensureHostDispatchReservations(parallelReadItems, []),
    state: "ready-for-codex",
    counts: { total: 2, completed: 0, running: 2, failed: 0 },
  };
  const prioritizedHostText = formatTeamRunSnapshot(pluginRoot, parallelReadSnapshot, 0);
  assert((prioritizedHostText.match(/one reserved hostWorkerEvent/g) || []).length === 1, "native Codex read-only fan-out respects the shared-pool concurrency limit");
  assert(prioritizedHostText.match(/HostCodexReservationActions:\n- ([^:]+):/)?.[1] === "native-read-2", "native Codex reservations expose the highest-priority ready item first");

  const protectedSessionDecision = buildResourceOrchestrationDecision({
    goal: "Verify the current portal session before a controlled operation",
    workItems: [
      { id: "session-check", objective: "Verify the authenticated browser session without changing profiles, cookies, accounts, or credentials", kind: "analysis", complexity: "medium", readOnly: true },
      { id: "source-review", objective: "Review the browser authentication helper code", kind: "review", complexity: "medium", readOnly: true, expectedFiles: ["browser.js"] },
    ],
  }, fakeContext);
  assert(protectedSessionDecision.workItems.find((item) => item.id === "session-check")?.assignment === "codex:current", "protected live browser and authentication checks stay with current Codex");
  assert(protectedSessionDecision.workItems.find((item) => item.id === "source-review")?.assignment !== "codex:current", "bounded browser source review remains delegatable");
  const consequentialDefault = buildResourceOrchestrationDecision({ goal: "Start controlled real job submissions through the approved harness" }, fakeContext);
  assert(
    consequentialDefault.workItems.find((item) => item.id === "goal-context")?.readOnly === true
      && consequentialDefault.workItems.find((item) => item.id === "goal-implementation")?.assignment === "codex:current"
      && consequentialDefault.workItems.find((item) => item.id === "goal-implementation")?.dependsOn.includes("goal-context")
      && consequentialDefault.workItems.find((item) => item.id === "independent-verification")?.readOnly === true,
    "a consequential goal delegates preflight and verification but gates the real operation to Codex",
  );
  const defaultComplexGraph = buildGoalWorkGraph({ goal: "Refactor the plugin orchestration architecture safely", estimatedCodexInputTokens: 6000 });
  assert(defaultComplexGraph.find((item) => item.id === "goal-implementation")?.dependsOn.includes("goal-context"), "complex default implementation waits for discovery evidence and a safe file boundary");
  assert(downstreamWriterNeedsBoundary({ workItems: defaultComplexGraph }, [defaultComplexGraph.find((item) => item.id === "goal-context")]), "discovery handoff requests exact file targets when it must scope a downstream writer");
  const liveEvidenceGraph = buildGoalWorkGraph({
    goal: "Manage live job submissions",
    workItems: [
      { id: "live-control", objective: "Verify live runner health and control real submissions", kind: "operation", externallyConsequential: true, readOnly: false },
      { id: "runtime-analysis", objective: "Inspect current runtime bottlenecks", kind: "analysis", readOnly: true },
    ],
  });
  assert(liveEvidenceGraph.find((item) => item.id === "runtime-analysis")?.dependsOn.includes("live-control"), "live-state analysis is automatically gated on verified operational evidence");
  const dispatchAlternate = availableAlternateForItem({
    resources: [
      { id: "claude:haiku", dispatchable: true, state: "cooldown" },
      { id: "claude:sonnet", dispatchable: true, state: "available" },
    ],
  }, { alternates: ["claude:sonnet"] });
  assert(dispatchAlternate?.id === "claude:sonnet", "an unavailable assigned resource can reroute to a healthy pre-vetted alternate before dispatch");
  const checkpointCandidates = [
    { id: "claude:haiku", platform: "claude", dispatchable: true, state: "cooldown", model: "haiku", capabilities: ["general-reasoning"], quality: 74, speed: 95, cost: 98, remainingPercent: 50 },
    { id: "claude:sonnet", platform: "claude", dispatchable: true, state: "available", model: "sonnet", capabilities: ["general-reasoning"], quality: 98, speed: 68, cost: 55, remainingPercent: 80 },
  ];
  const checkpointRefresh = applyCapacityCheckpointCandidates({
    primaryWriterId: "claude:haiku",
    resources: checkpointCandidates,
    decisions: [],
    workItems: [
      { id: "pending", objective: "Review pending evidence", kind: "review", state: "pending", assignment: "claude:haiku", assignedModel: "haiku", readOnly: true, complexity: "medium", requiredCapabilities: ["general-reasoning"], expectedFiles: [], dependsOn: [], alternates: [], blocker: "", failureCategory: "" },
      { id: "running", objective: "Review active evidence", kind: "review", state: "running", assignment: "claude:haiku", assignedModel: "haiku", readOnly: true, complexity: "medium", requiredCapabilities: ["general-reasoning"], expectedFiles: [], dependsOn: [], alternates: [], blocker: "", failureCategory: "" },
    ],
  }, checkpointCandidates, {}).manifest;
  assert(checkpointRefresh.workItems.find((item) => item.id === "pending")?.assignment === "claude:sonnet" && checkpointRefresh.workItems.find((item) => item.id === "running")?.assignment === "claude:haiku", "capacity checkpoints reroute only unstarted work and never interrupt a running worker");
  assert(hasAvailableDispatchRoute({
    resources: [
      { id: "claude:haiku", dispatchable: true, state: "cooldown" },
      { id: "claude:sonnet", dispatchable: true, state: "available" },
    ],
  }, { assignment: "claude:haiku", alternates: ["claude:sonnet"] }), "a resource-blocked work item can resume when an alternate becomes available");
  const evidenceManifest = {
    version: 2,
    runId: "evidence-test",
    resources: [{ id: "codex:current", model: "gpt-test" }],
    decisions: [],
    jobs: [],
    workItems: [
      { id: "live", state: "codex", dependsOn: [], assignment: "codex:current", readOnly: false, externallyConsequential: true },
      { id: "patch", state: "failed", dependsOn: ["live"], assignment: "claude:sonnet", readOnly: false },
    ],
  };
  let managerTakeoverRejected = false;
  try {
    applyProjectManagerUpdates({
      ...evidenceManifest,
      managerOnly: true,
      workItems: [{ id: "patch", state: "failed", dependsOn: [], assignment: "claude:sonnet", readOnly: false }],
    }, { takeoverCodexItems: ["patch"] });
  } catch (error) {
    managerTakeoverRejected = /manager-only mode refuses/i.test(String(error?.message || ""));
  }
  assert(managerTakeoverRejected, "manager-only mode rejects silent current-Codex takeover of failed worker work");
  let missingEvidenceRejected = false;
  try {
    applyProjectManagerUpdates(evidenceManifest, { completedCodexItems: ["live"] });
  } catch {
    missingEvidenceRejected = true;
  }
  assert(missingEvidenceRejected, "Codex cannot complete an owned action without compact verification evidence");
  const liveCompleted = applyProjectManagerUpdates(evidenceManifest, {
    completedCodexItems: ["live"],
    codexEvidence: [{ workItemId: "live", summary: "Runner and dashboard health were verified from the current status API.", artifactRefs: ["status.json"] }],
  });
  const liveCompletionRetried = applyProjectManagerUpdates(liveCompleted, {
    completedCodexItems: ["live"],
    codexEvidence: [{ workItemId: "live", summary: "Runner and dashboard health were verified from the current status API.", artifactRefs: ["status.json"] }],
  });
  assert(liveCompletionRetried.workItems.find((item) => item.id === "live")?.state === "completed"
    && liveCompletionRetried.decisions.length === liveCompleted.decisions.length,
  "an exact full Codex-completion retry is idempotent and does not duplicate lifecycle decisions");
  const codexTakeover = applyProjectManagerUpdates(liveCompleted, { takeoverCodexItems: ["patch"], codexModel: "gpt-test" });
  assert(codexTakeover.workItems.find((item) => item.id === "patch")?.state === "codex" && codexTakeover.workItems.find((item) => item.id === "patch")?.assignment === "codex:current", "Codex takeover is explicit and represented in the work graph");
  const patchCompleted = applyProjectManagerUpdates(codexTakeover, {
    completedCodexItems: ["patch"],
    codexEvidence: [{ workItemId: "patch", summary: "Bounded patch was applied and four focused tests passed." }],
  });
  const takeoverRefresh = syncWorkItemsFromJobs({
    ...patchCompleted,
    jobs: [{ jobId: "old-cancelled-worker", state: "cancelled", workItemIds: ["patch"], assignedTasks: ["patch"] }],
  });
  assert(takeoverRefresh.workItems.find((item) => item.id === "patch")?.state === "completed", "a stale worker failure cannot regress an evidence-backed Codex takeover");
  const projectCompleted = applyProjectManagerUpdates(patchCompleted, { projectVerified: true, projectVerificationSummary: "All work items and focused integration checks passed." });
  assert(projectCompleted.state === "completed" && deriveOrchestrationState(projectCompleted) === "completed", "only an evidence-backed final verification permits a completed project-manager cycle");
  const projectBlocked = applyProjectManagerUpdates(patchCompleted, { projectVerificationFailed: true, projectVerificationSummary: "Focused checks passed, but the live authorization gate remains unresolved." });
  assert(projectBlocked.state === "blocked" && projectBlocked.finalVerification?.passed === false, "failed final verification records the blocker and forbids a completion claim");
  const continuousBase = {
    ...patchCompleted,
    runId: "continuous-root-test",
    goal: "Keep improving the harness until it reliably supports one unique truthful application every seven minutes around the clock.",
    rootGoal: "Keep improving the harness until it reliably supports one unique truthful application every seven minutes around the clock.",
    mode: "continuous",
    completionPolicy: "continuous-management",
    cycleNumber: 1,
    cycles: [],
    jobs: [{
      jobId: "cycle-one-worker",
      transport: "host-subagent",
      state: "completed",
      model: "gpt-5.6-terra",
      observedModel: "gpt-5.6-terra",
      workItemIds: ["live"],
      assignedTasks: ["live"],
      inlineEvidence: { summary: "The worker returned bounded lifecycle evidence.", artifactRefs: ["status.json"], changedFiles: [], testSummary: "read-only" },
    }],
    activeCycle: {
      id: "cycle-1",
      number: 1,
      objective: "Establish authoritative throughput and blocker evidence.",
      itemIds: patchCompleted.workItems.map((item) => item.id),
      state: "running",
      startedAt: utcStamp(),
    },
    finalVerification: null,
  };
  let continuousCompletionRejected = false;
  try {
    applyProjectManagerUpdates(continuousBase, { projectVerified: true, projectVerificationSummary: "This small review cycle passed but the root throughput objective remains open." });
  } catch (error) {
    continuousCompletionRejected = /completion firewall/i.test(String(error?.message || ""));
  }
  assert(continuousCompletionRejected, "continuous-management completion firewall rejects projectVerified even when every cycle item completed");
  const cycleVerified = applyProjectManagerUpdates(continuousBase, { cycleVerified: true, cycleVerificationSummary: "Cycle one established current evidence; the root throughput objective remains active and needs another delivery cycle." });
  assert(cycleVerified.state === "ready-for-codex"
    && cycleVerified.activeCycle?.state === "verified"
    && cycleVerified.cycles?.length === 1
    && cycleVerified.cycles?.[0]?.evidenceArchive?.workItems?.length === continuousBase.workItems.length
    && cycleVerified.cycles?.[0]?.evidenceArchive?.jobs?.[0]?.inlineEvidence?.summary === "The worker returned bounded lifecycle evidence."
    && cycleVerified.finalVerification === null,
  "cycle verification records immutable compact work-item and job evidence without completing the continuous root objective");
  const idempotentCycleVerification = applyProjectManagerUpdates(cycleVerified, { cycleVerified: true, cycleVerificationSummary: cycleVerified.activeCycle.summary });
  assert(idempotentCycleVerification.cycles.length === 1 && idempotentCycleVerification.activeCycle.summary === cycleVerified.activeCycle.summary, "an exact terminal cycle-verification retry is idempotent");
  let immutableCycleResultRejected = false;
  try {
    applyProjectManagerUpdates(cycleVerified, { cycleVerificationFailed: true, cycleVerificationSummary: "A delayed contradictory result must never rewrite the verified cycle evidence." });
  } catch (error) {
    immutableCycleResultRejected = /immutable/i.test(String(error?.message || ""));
  }
  assert(immutableCycleResultRejected, "a terminal cycle result cannot be rewritten by a delayed contradictory status request");
  let idempotentRetryCompletionBypassRejected = false;
  try {
    applyProjectManagerUpdates(cycleVerified, {
      cycleVerified: true,
      cycleVerificationSummary: cycleVerified.activeCycle.summary,
      projectVerified: true,
      projectVerificationSummary: "A cycle retry cannot bypass the persistent root completion firewall.",
    });
  } catch (error) {
    idempotentRetryCompletionBypassRejected = /completion firewall/i.test(String(error?.message || ""));
  }
  assert(idempotentRetryCompletionBypassRejected, "an idempotent cycle retry cannot bypass the continuous root completion firewall");
  const failedContinuousCycle = applyProjectManagerUpdates({
    ...continuousBase,
    workItems: continuousBase.workItems.map((item, index) => index === 0 ? { ...item, state: "failed", blocker: "bounded cycle failure" } : item),
  }, { cycleVerificationFailed: true, cycleVerificationSummary: "The bounded cycle failed and requires a correction, while the persistent root objective remains active." });
  assert(failedContinuousCycle.state === "ready-for-codex" && isActiveOrchestrationRun(failedContinuousCycle), "a failed continuous cycle remains an active same-run correction checkpoint");
  const readOnlyContinuousCycle = applyProjectManagerUpdates({
    version: 2,
    runId: "read-only-continuous-test",
    goal: "Continuously improve the full project outcome.",
    rootGoal: "Continuously improve the full project outcome.",
    completionPolicy: "continuous-management",
    workItems: [{ id: "read-only-health", objective: "Inspect current health only", readOnly: true, executionClass: "analysis", state: "completed", assignment: "claude:sonnet", dependsOn: [] }],
    jobs: [{ jobId: "read-only-job", state: "completed", transport: "claude-code", workItemIds: ["read-only-health"], assignedTasks: ["read-only-health"] }],
    decisions: [],
    cycleNumber: 1,
    cycles: [],
    activeCycle: { id: "cycle-1", number: 1, objective: "Read-only health review", itemIds: ["read-only-health"], state: "running", startedAt: utcStamp() },
  }, { cycleVerified: true, cycleVerificationSummary: "The read-only health review passed, but it is only a cycle checkpoint and cannot complete the root objective." });
  assert(readOnlyContinuousCycle.state === "ready-for-codex"
    && isActiveOrchestrationRun(readOnlyContinuousCycle)
    && readOnlyContinuousCycle.activeCycle.state === "verified"
    && readOnlyContinuousCycle.finalVerification == null,
  "a bounded read-only cycle cannot complete or deactivate a persistent root objective");
  assertCycleTransitionIdentity(cycleVerified, { runId: "continuous-root-test", cycleId: "cycle-1" });
  let staleCycleIdentityRejected = false;
  try {
    assertCycleTransitionIdentity(cycleVerified, { runId: "another-run", cycleId: "cycle-1" });
  } catch (error) {
    staleCycleIdentityRejected = /stale cycle transition refused/i.test(String(error?.message || ""));
  }
  assert(staleCycleIdentityRejected, "stale next-cycle planning cannot cross a run identity boundary");
  const verifiedRevision = cycleTransitionRevision(cycleVerified);
  let staleCycleRevisionRejected = false;
  try {
    assertCycleTransitionRevision({ ...cycleVerified, activeCycle: { ...cycleVerified.activeCycle, state: "failed", passed: false, verifiedAt: "2099-01-01T00:00:00.000Z" } }, verifiedRevision);
  } catch (error) {
    staleCycleRevisionRejected = /stale cycle revision refused/i.test(String(error?.message || ""));
  }
  assert(staleCycleRevisionRejected, "next-cycle planning refuses a same-id cycle whose terminal state changed before the manifest lock");
  const continuousSnapshot = formatTeamRunSnapshot(pluginRoot, cycleVerified, 0, DEFAULT_PROFILE);
  assert(continuousSnapshot.includes("CompletionClaimAllowed: false")
    && continuousSnapshot.includes(`Objective: ${continuousBase.rootGoal}`)
    && /never call projectVerified/i.test(continuousSnapshot)
    && continuousSnapshot.includes("nextWorkItems"),
  "continuous CEO status keeps the exact root objective visible and requires another cycle instead of Goal completion");
  const renamedCycleArgs = nextCyclePlanningArgs(cycleVerified, {
    nextCycleObjective: "Implement the next throughput correction.",
    nextWorkItems: [
      { id: "inspect", objective: "Inspect the bottleneck", executionClass: "analysis" },
      { id: "patch", objective: "Patch the bottleneck", executionClass: "code", dependsOn: ["inspect"], expectedFiles: ["scripts/example.js"] },
    ],
  }, pluginRoot);
  assert(renamedCycleArgs.workItems[0].id === "c2-inspect" && renamedCycleArgs.workItems[1].dependsOn[0] === "c2-inspect", "next cycle work receives collision-safe ids while preserving internal dependencies");
  const alreadyPrefixedCycleArgs = nextCyclePlanningArgs(cycleVerified, {
    nextWorkItems: [{ id: "c2-inspect", objective: "Inspect once", executionClass: "analysis" }],
  }, pluginRoot);
  assert(alreadyPrefixedCycleArgs.workItems[0].id === "c2-inspect", "next cycle ids are not double-prefixed when the caller already used the active cycle prefix");
  assert(dependencyEvidenceForItems({ ...projectCompleted, workspace: pluginRoot }, [{ dependsOn: ["live"] }]).includes("Runner and dashboard health"), "verified Codex dependency evidence is passed to downstream workers");
  assert([1, 2, 3, 4].map(resultBulletLimitForComplexity).join(",") === "5,6,8,10", "result bullet budgets scale with work-item complexity");
  assert(deriveOrchestrationState({ workItems: [{ state: "completed" }, { state: "codex" }] }) === "ready-for-codex", "worker completion still requires Codex integration");
  assert(deriveOrchestrationState({ workItems: [{ state: "completed" }, { state: "codex-pending" }] }) === "running", "dependency-gated Codex actions keep the project run active until they become ready");
  assert(deriveOrchestrationState({ workItems: [{ state: "blocked" }, { state: "failed" }] }) === "blocked", "dependency blocks remain distinct from worker failure");
  assert(failureCategoryFromText("429 rate limit exceeded") === "rate-limit", "retryable resource failures are classified for bounded failover");
  assert(failureCategoryFromText("Claude output budget exceeded") === "budget-exceeded" && !failoverAllowed("budget-exceeded"), "worker budget exhaustion stops instead of doubling cost through failover");
  assert(failureCategoryFromText("error_max_budget_usd") === "budget-exceeded", "Claude's error_max_budget_usd subtype text normalizes to budget-exceeded");
  const parsedBudgetError = parseClaudeJsonOutput(JSON.stringify({ is_error: true, subtype: "error_max_budget_usd", result: "Claude Code spend limit reached." }));
  assert(parsedBudgetError.isError === true && parsedBudgetError.errorSubtype === "error_max_budget_usd", "Claude JSON budget-error subtype is captured for classification");
  assert(claudeBudgetErrorSubtype(parsedBudgetError.errorSubtype) && !claudeBudgetErrorSubtype("error_during_execution"), "only budget-shaped Claude error subtypes are treated as budget-exceeded, ordinary failures keep single narrow failover");
  assert(inferFileBoundaryFromEvidence(pluginRoot, "Patch `scripts/ai-mobile-local-mcp.js` and verify it.").includes(path.join("scripts", "ai-mobile-local-mcp.js")), "writer file boundaries are inferred from verified dependency evidence");
  const deadlineManifest = terminateOrchestrationRun(pluginRoot, {
    version: 2,
    runId: "deadline-test",
    workItems: [{ id: "unfinished", state: "pending", assignment: "claude:sonnet" }],
    jobs: [],
    decisions: [],
  }, "Run deadline reached.", "orchestration-deadline");
  assert(deadlineManifest.state === "blocked" && deadlineManifest.workItems[0].state === "blocked" && deadlineManifest.termination.category === "orchestration-deadline", "run deadline termination blocks unfinished work without a success claim");
  assert(runDeadlineExpired({ deadlineAt: "2000-01-01T00:00:00.000Z" }), "expired run deadlines are detected deterministically");
  assert(!runDeadlineExpired({ deadlineAt: "" }), "continuous projects have no implicit wall-clock deadline");
  assert(capacityCheckpointDue({ version: 2, state: "running", capacityCheckpointMinutes: 20, nextCapacityCheckpointAt: "2000-01-01T00:00:00.000Z" }), "rolling capacity checkpoints become due without terminating the project");
  assert(
    shouldRunOrchestrationSupervisor({ version: 2, state: "running", workItems: [{ state: "pending", assignment: "claude:sonnet" }], jobs: [] })
      && !shouldRunOrchestrationSupervisor({ version: 2, state: "running", workItems: [{ state: "host-running", assignment: "codex-host:gpt-5.6-luna" }], jobs: [{ transport: "host-subagent", state: "running" }] })
      && !shouldRunOrchestrationSupervisor({ version: 2, state: "ready-for-codex" }),
    "low-RAM supervisor runs only while external CLI orchestration can advance autonomously",
  );
  assert(isActiveOrchestrationRun({ version: 2, state: "ready-for-codex" }) && !isActiveOrchestrationRun({ version: 2, state: "blocked" }), "ready-for-codex remains active until final verification or termination");
  const parsedClaude = parseClaudeJsonOutput(JSON.stringify({ result: "ok", duration_ms: 12, usage: { input_tokens: 2, output_tokens: 1 }, modelUsage: { "claude-sonnet-5": {} } }));
  assert(parsedClaude.resultText === "ok" && parsedClaude.observedModel === "claude-sonnet-5", "Claude JSON output yields compact result and per-run model telemetry");
  const mixedClaude = parseClaudeJsonOutput(JSON.stringify({
    result: "ok",
    modelUsage: {
      "claude-haiku-4-5-20251001": { costUSD: 0.001, inputTokens: 1200, outputTokens: 10 },
      "claude-sonnet-5": { costUSD: 0.63, inputTokens: 50, cacheReadInputTokens: 1100000, outputTokens: 6300 },
    },
  }));
  assert(mixedClaude.observedModel === "claude-sonnet-5" && mixedClaude.observedModels.length === 2, "Claude telemetry selects the dominant requested model instead of a background helper model");
  assert(claudeObservedModelMatches("sonnet", mixedClaude.observedModel) && !claudeObservedModelMatches("fable", mixedClaude.observedModel), "Claude model-family verification rejects a dominant model mismatch");
  assert(!claudeObservedModelMatches("claude-sonnet-4-6", "claude-sonnet-5"), "an exact Claude dispatch id must match the observed version exactly");
  assert(claudeIsolationFlags().join(",") === "--safe-mode,--no-session-persistence", "Claude workers default to isolated low-context execution flags");
  const flattenedGraph = buildGoalWorkGraph({ goal: "review", workItems: [[{ id: "one", objective: "first" }, { id: "two", objective: "second" }]] });
  assert(flattenedGraph.length === 2, "nested PowerShell work-item arrays are normalized defensively");
  assert(sensitiveArtifactPath("config/.env.production"), "sensitive untracked artifact paths are withheld");
  const credentialSample = ["API", "_KEY=example-sensitive-value"].join("");
  assert(!redactArtifactContent(credentialSample).includes("example-sensitive-value"), "credential-like untracked content is redacted");
  assert(JSON.stringify(pathsFromGitStatus(" M scripts/ai-mobile-local-mcp.js\r\n?? notes/new.md\n")) === JSON.stringify(["scripts/ai-mobile-local-mcp.js", "notes/new.md"]), "Git porcelain parsing preserves the first filename character after trimmed status output");
  assert(validateWorkerFileBoundary({ expectedFiles: ["scripts"] }, { changedDuringRun: ["scripts/worker.js"] }).ok, "writer changes inside an assigned file boundary pass");
  assert(!validateWorkerFileBoundary({ expectedFiles: ["scripts"] }, { changedDuringRun: ["README.md"] }).ok, "writer changes outside an assigned file boundary fail closed");
  assert(validateWriterCompletion({ readOnly: true, mode: "review" }, { changedDuringRun: [] }, "- Current blocker was identified.").ok, "read-only workers may complete with useful evidence and no file changes");
  assert(validateWriterCompletion({ mode: "fast" }, { changedDuringRun: [] }, "- Direct legacy analysis completed.").ok, "direct provider jobs without an explicit orchestration role preserve compatibility");
  assert(!validateWriterCompletion({ readOnly: false, mode: "patch" }, { changedDuringRun: [] }, "- Outcome: BLOCKED, no code changed.").ok, "a blocked writer with no code changes is not accepted as completed implementation");
  assert(!validateWriterCompletion({ readOnly: false, mode: "patch" }, { changedDuringRun: ["scripts/fix.js"] }, "- Outcome: BLOCKED pending a correct boundary.").ok, "a writer-declared blocked outcome remains failed even when a partial file changed");
  assert(validateWriterCompletion({ readOnly: false, mode: "patch" }, { changedDuringRun: ["scripts/fix.js"] }, "- Implemented the bounded correction and focused tests passed.").ok, "a writer completes only with attributable changes and a non-blocked result");
  assert(compactResultBullets("- one\n- two\n- three", 2).split(/\r?\n/).length === 2, "worker result readback enforces a compact bullet limit");
  assert(!validateWorkerResult("I am currently running on Gemini 3.5 Flash (Medium).", { goal: "Review transport correctness" }).ok, "model identity alone cannot satisfy an assigned work item");
  assert(validateWorkerResult("- No transport defect found after reviewing both framing paths.\n- Verification covered initialization and tool listing.", { goal: "Review transport correctness", workItemKinds: ["architecture-review"] }).ok, "compact objective-specific review passes the result quality gate");
  assert(inferAgyObservedModel("I am currently running on **Gemini 3.5 Flash (Medium)**.", "gemini-3.5-flash-low") === "gemini-3.5-flash-medium", "Antigravity telemetry records a self-reported model instead of the requested alias");
  const agyPrintArgs = buildAgyCliArgs("EXECUTE-THIS-PROMPT", { model: "gemini-3.5-flash-low", printTimeout: "1m" });
  assert(agyPrintArgs[0] === "--print" && agyPrintArgs[1] === "EXECUTE-THIS-PROMPT", "Antigravity CLI receives the task through the verified long-form print argument");
  const unattendedAgyArgs = buildAgyCliArgs("UNATTENDED", { model: "gemini-3.5-flash-low", sandbox: true, autoApprovePermissions: true });
  assert(unattendedAgyArgs.includes("--sandbox") && unattendedAgyArgs.includes("--dangerously-skip-permissions"), "sandboxed unattended Antigravity jobs use the CLI's explicit permission auto-approval flag");
  let unsafeAgyAutoApproveRejected = false;
  try { buildAgyCliArgs("UNSAFE", { sandbox: false, autoApprovePermissions: true }); } catch { unsafeAgyAutoApproveRejected = true; }
  assert(unsafeAgyAutoApproveRejected, "Antigravity permission auto-approval is refused without the sandbox");

  const tempRoot = path.resolve(os.tmpdir());
  const workspace = fs.mkdtempSync(path.join(tempRoot, "ai-mobile-self-test-"));
  let sleeper = null;
  let fakeCodexRoot = "";
  const originalCodexCliPath = process.env.CODEX_CLI_PATH;
  try {
    const init = spawnSync("git", ["init", "--quiet", workspace], { encoding: "utf8", timeout: 10000, windowsHide: true });
    assert(init.status === 0, "temporary git workspace initializes");
    assert(!verificationRunner.validate(workspace, { command: "powershell", args: ["-Command", "Write-Output unsafe"] }).ok, "deterministic verification refuses inline shell commands");
    assert(!verificationRunner.validate(workspace, { command: "node", args: ["-e", "process.exit(0)"] }).ok, "deterministic verification refuses inline runtime evaluation");
    fs.writeFileSync(path.join(workspace, "verification-fixture.js"), '"use strict";\n', "utf8");
    fakeCodexRoot = fs.mkdtempSync(path.join(tempRoot, "ai-mobile-fake-codex-"));
    const fakeCodexScript = path.join(fakeCodexRoot, "fake-codex.js");
    fs.writeFileSync(fakeCodexScript, [
      '"use strict";',
      'const args = process.argv.slice(2);',
      'if (args.includes("--version")) { process.stdout.write("codex-cli 9.9.9\\n"); }',
      'else if (args[0] === "login" && args[1] === "status") { process.stdout.write("Logged in using ChatGPT\\n"); }',
      'else {',
      '  let input = "";',
      '  process.stdin.setEncoding("utf8");',
      '  process.stdin.on("data", (chunk) => { input += chunk; });',
      '  process.stdin.on("end", () => {',
      '    process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "fake-codex-thread" }) + "\\n");',
      '    process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "- Verified the bounded Codex worker transport and read-only sandbox.\\n- Focused fake lifecycle check passed without project changes." } }) + "\\n");',
      '    process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: input.length, cached_input_tokens: 7, output_tokens: 19 } }) + "\\n");',
      '  });',
      '}',
    ].join("\n"), "utf8");
    const fakeCodexCommand = process.platform === "win32"
      ? path.join(fakeCodexRoot, "codex.cmd")
      : path.join(fakeCodexRoot, "codex");
    if (process.platform === "win32") {
      fs.writeFileSync(fakeCodexCommand, `@echo off\r\n"${process.execPath}" "${fakeCodexScript}" %*\r\n`, "utf8");
    } else {
      fs.writeFileSync(fakeCodexCommand, `#!/bin/sh\nexec "${process.execPath}" "${fakeCodexScript}" "$@"\n`, "utf8");
      fs.chmodSync(fakeCodexCommand, 0o755);
    }
    process.env.CODEX_CLI_PATH = fakeCodexCommand;
    const fakeCodexStatus = findCodexCli();
    assert(fakeCodexStatus.found && fakeCodexStatus.auth?.authMode === "chatgpt", "Codex CLI passive probe verifies version and ChatGPT-plan authentication");
    const fakeVerificationCommands = [{ name: "fake-node-check", command: "node", args: ["--check", "verification-fixture.js"], timeoutSeconds: 10, expectedExitCode: 0 }];
    const fakeCodexJob = createJob({ goal: "Verify bounded Codex worker transport", workspace, mode: "review", readOnly: true, worker: "codex-cli", verificationCommands: fakeVerificationCommands });
    const fakeCodexWorkerResult = runCodexJobWorker({
      goal: "Verify bounded Codex worker transport",
      workspace,
      jobId: fakeCodexJob.jobId,
      mode: "review",
      readOnly: true,
      model: "gpt-5.6-luna",
      effort: "low",
      maxMinutes: 1,
      resourceId: "codex-cli:gpt-5.6-luna",
      workItemKinds: ["verification"],
      verificationCommands: fakeVerificationCommands,
    });
    const fakeCodexJobStatus = readJsonFile(path.join(fakeCodexJob.jobDir, "status.json"), {});
    const fakeCodexTelemetry = readJsonFile(path.join(fakeCodexJob.jobDir, "worker-telemetry.json"), {});
    const fakeVerificationEvidence = readJsonFile(path.join(fakeCodexJob.jobDir, "verification-evidence.json"), {});
    assert(/State: completed/.test(fakeCodexWorkerResult) && fakeCodexJobStatus.state === "completed" && fakeCodexTelemetry.outputTokens === 19 && fakeVerificationEvidence.passed === true, "durable Codex worker records compact output, lifecycle state, measured usage, and bridge-owned verification without a live model call");
    if (originalCodexCliPath === undefined) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = originalCodexCliPath;
    const appendedCycle = appendContinuousCycle({
      ...cycleVerified,
      runId: "continuous-cycle-test",
      workspace,
      resources: [scopeCandidate],
      jobs: [],
      decisions: [],
    }, {
      nextCycleObjective: "Implement the next bounded throughput correction.",
      nextCycleAcceptanceCriteria: ["A concrete correction is produced."],
      nextCycleVerification: ["Run one focused check."],
      cycleVerificationSummary: cycleVerified.activeCycle.summary,
    }, {
      candidates: [scopeCandidate],
      primaryWriterId: "",
      decisions: [{ workItemId: "c2-inspect", resourceId: scopeCandidate.id, model: scopeCandidate.model, reason: "self-test" }],
      workItems: [{
        ...normalizeWorkItem({ id: "c2-inspect", objective: "Inspect the next bottleneck", executionClass: "analysis", complexity: "low" }, 0, "low"),
        assignment: scopeCandidate.id,
        assignedModel: scopeCandidate.model,
        alternates: [],
      }],
    }, workspace);
    assert(appendedCycle.runId === "continuous-cycle-test"
      && appendedCycle.rootGoal === continuousBase.rootGoal
      && appendedCycle.cycleNumber === 2
      && appendedCycle.activeCycle?.state === "running"
      && appendedCycle.workItems.length === 1
      && appendedCycle.workItems[0].cycleId === "cycle-2"
      && appendedCycle.cycles?.[0]?.evidenceArchive?.workItems?.length === continuousBase.workItems.length
      && appendedCycle.finalVerification === null,
    "verified continuous cycles append bounded work inside the same run id without shrinking the root goal or discarding prior evidence");
    if (process.platform === "win32") {
      const persistedWorkspace = path.join(workspace, "persisted-lifecycle");
      fs.mkdirSync(persistedWorkspace, { recursive: true });
      const persistedInit = spawnSync("git", ["init", "--quiet", persistedWorkspace], { encoding: "utf8", timeout: 10000, windowsHide: true });
      assert(persistedInit.status === 0, "persisted lifecycle workspace initializes");
      const helperPath = path.join(pluginRoot, "scripts", "antigravity.ps1");
      const rootGoal = "Continuously preserve one root objective while bounded read-only cycles advance under one durable run.";
      const firstItems = JSON.stringify([{
        id: "read-only-boundary",
        objective: "Verify the local authenticated browser session without changing profiles, cookies, accounts, credentials, or external state.",
        kind: "analysis",
        executionClass: "analysis",
        complexity: "low",
        readOnly: true,
        acceptanceCriteria: ["Compact evidence is recorded."],
        verification: ["The root objective remains active."],
      }]);
      const childOptions = { encoding: "utf8", timeout: 60000, windowsHide: true, env: { ...process.env, AI_MOBILE_SELF_TEST: "1" } };
      const persistedStart = spawnSync("powershell", [
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", helperPath, "run-project-manager",
        "-Goal", rootGoal,
        "-Workspace", persistedWorkspace,
        "-CompletionPolicy", "continuous-management",
        "-CycleObjective", "Verify the first bounded read-only lifecycle checkpoint.",
        "-WorkItemsJson", firstItems,
        "-ManagerOnly", "true",
        "-WaitSeconds", "0",
      ], childOptions);
      const firstManifest = readJsonFile(lastTeamRunJsonPath(persistedWorkspace), null);
      assert(persistedStart.status === 0
        && /ActiveCycleId:\s*cycle-1/i.test(persistedStart.stdout)
        && /CompletionClaimAllowed:\s*false/i.test(persistedStart.stdout)
        && firstManifest.workItems?.[0]?.readOnly === true
        && firstManifest.workItems?.[0]?.executionClass === "analysis",
      "PowerShell helper persists a genuinely read-only continuous cycle without permitting root completion");
      const prematureItems = JSON.stringify([{ id: "premature", objective: "This cycle must not start early.", executionClass: "analysis", readOnly: true }]);
      const prematureAdvance = spawnSync("powershell", [
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", helperPath, "project-manager-status",
        "-Workspace", persistedWorkspace,
        "-ExpectedRunId", firstManifest.runId,
        "-ExpectedCycleId", "cycle-1",
        "-NextCycleObjective", "Premature cycle.",
        "-NextWorkItemsJson", prematureItems,
        "-WaitSeconds", "0",
      ], childOptions);
      assert(prematureAdvance.status !== 0 && /nextWorkItems cannot start while cycle-1 is running/i.test(`${prematureAdvance.stdout}\n${prematureAdvance.stderr}`), "PowerShell lifecycle refuses next-only planning from a nonterminal cycle revision");
      const completionSummary = "The persisted read-only lifecycle checkpoint was verified without external effects or project changes.";
      const completionEvidence = JSON.stringify([{
        workItemId: "read-only-boundary",
        summary: completionSummary,
        artifactRefs: [],
      }]);
      const persistedComplete = spawnSync("powershell", [
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", helperPath, "project-manager-status",
        "-Workspace", persistedWorkspace,
        "-CompletedCodexItems", "read-only-boundary",
        "-CodexEvidenceJson", completionEvidence,
        "-WaitSeconds", "0",
      ], childOptions);
      assert(persistedComplete.status === 0, "PowerShell helper records compact read-only cycle evidence");
      const completedManifest = readJsonFile(lastTeamRunJsonPath(persistedWorkspace), null);
      const persistedCompleteRetry = spawnSync("powershell", [
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", helperPath, "project-manager-status",
        "-Workspace", persistedWorkspace,
        "-CompletedCodexItems", "read-only-boundary",
        "-CodexEvidenceJson", completionEvidence,
        "-WaitSeconds", "0",
      ], childOptions);
      const retriedManifest = readJsonFile(lastTeamRunJsonPath(persistedWorkspace), null);
      assert(persistedCompleteRetry.status === 0 && retriedManifest.decisions.length === completedManifest.decisions.length, "PowerShell lifecycle treats an exact full completion retry as idempotent");
      const secondItems = JSON.stringify([
        {
          id: "second-boundary",
          objective: "Verify the local authenticated browser-session boundary remains read-only in cycle two without changing external state.",
          kind: "analysis",
          executionClass: "analysis",
          complexity: "low",
          readOnly: true,
        },
        {
          id: "second-verifier",
          objective: "Verify the second boundary only after its dependency completes.",
          kind: "verification",
          executionClass: "analysis",
          complexity: "low",
          readOnly: true,
          dependsOn: ["second-boundary"],
        },
      ]);
      const cycleSummary = "Cycle one passed its bounded read-only checkpoint, while the persistent root objective remains active.";
      const persistedAdvance = spawnSync("powershell", [
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", helperPath, "project-manager-status",
        "-Workspace", persistedWorkspace,
        "-ExpectedRunId", firstManifest.runId,
        "-ExpectedCycleId", "cycle-1",
        "-CycleVerified", "true",
        "-CycleVerificationSummary", cycleSummary,
        "-NextCycleObjective", "Verify same-run advancement into cycle two.",
        "-NextWorkItemsJson", secondItems,
        "-WaitSeconds", "0",
      ], childOptions);
      const secondManifest = readJsonFile(lastTeamRunJsonPath(persistedWorkspace), null);
      assert(persistedAdvance.status === 0
        && secondManifest.runId === firstManifest.runId
        && secondManifest.activeCycle?.id === "cycle-2"
        && secondManifest.workItems?.find((item) => item.id === "c2-second-verifier")?.dependsOn?.[0] === "c2-second-boundary"
        && secondManifest.cycles?.[0]?.evidenceArchive?.workItems?.[0]?.codexEvidence?.summary === completionSummary
        && deriveOrchestrationState(secondManifest) !== "completed",
      "PowerShell project-manager-status preserves nested dependencies, advances the same run, and archives prior evidence");
      const staleAdvance = spawnSync("powershell", [
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", helperPath, "project-manager-status",
        "-Workspace", persistedWorkspace,
        "-ExpectedRunId", firstManifest.runId,
        "-ExpectedCycleId", "cycle-1",
        "-CycleVerified", "true",
        "-CycleVerificationSummary", cycleSummary,
        "-NextCycleObjective", "A stale retry that must not run.",
        "-NextWorkItemsJson", secondItems,
        "-WaitSeconds", "0",
      ], childOptions);
      assert(staleAdvance.status !== 0 && /Stale cycle transition refused/i.test(`${staleAdvance.stdout}\n${staleAdvance.stderr}`), "PowerShell lifecycle rejects a delayed cycle-advance retry after the active cycle changes");
      spawnSync("powershell", [
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", helperPath, "project-manager-status",
        "-Workspace", persistedWorkspace,
        "-StopRun", "true",
        "-StopReason", "Persisted lifecycle self-test completed.",
        "-WaitSeconds", "0",
      ], childOptions);
    }
    const renameTarget = path.join(workspace, "atomic-rename.json");
    const originalRenameSync = fs.renameSync;
    let renameAttempts = 0;
    fs.renameSync = (source, target) => {
      renameAttempts += 1;
      if (renameAttempts === 1) {
        const error = new Error("transient Windows file handle");
        error.code = "EPERM";
        throw error;
      }
      return originalRenameSync(source, target);
    };
    try {
      writeJsonFile(renameTarget, { retained: true });
    } finally {
      fs.renameSync = originalRenameSync;
    }
    assert(renameAttempts === 2 && readJsonFile(renameTarget, null)?.retained === true, "atomic JSON writes retry a transient Windows rename collision without weakening replacement atomicity");

    const lockTarget = path.join(workspace, "transient-lock.json");
    const lockFile = `${lockTarget}.lock`;
    const originalOpenSync = fs.openSync;
    let lockAttempts = 0;
    fs.openSync = (target, flags, ...rest) => {
      if (path.resolve(String(target)) === path.resolve(lockFile) && flags === "wx") {
        lockAttempts += 1;
        if (lockAttempts === 1) {
          const error = new Error("transient Windows lock collision");
          error.code = "EPERM";
          throw error;
        }
      }
      return originalOpenSync(target, flags, ...rest);
    };
    try {
      assert(withFileLock(lockTarget, () => "acquired") === "acquired", "state locks recover from a transient Windows EPERM collision");
    } finally {
      fs.openSync = originalOpenSync;
    }
    assert(lockAttempts === 2 && !fs.existsSync(lockFile), "retried state locks preserve exclusive acquisition and release the lock file");

    const previousLocalAppData = process.env.LOCALAPPDATA;
    const profileRoot = path.join(workspace, "profile");
    try {
      process.env.LOCALAPPDATA = profileRoot;
      writeProfile({ address: "Existing address", role: "initial role" });
      const preservedProfile = writeProfile({ role: "updated role" });
      assert(preservedProfile.address === "Existing address", "profile updates preserve an omitted Address value");
    } finally {
      if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = previousLocalAppData;
    }

    const hostFailoverItem = prepareHostAssignedItem(
      { ...hostRunBase, runId: "host-failover-test", workspace },
      { ...preparedHostItem, hostAttempt: null, hostAction: null, alternates: ["codex-host:gpt-5.6-luna"] },
      terraResource,
    );
    const hostFailoverBase = {
      ...hostRunBase,
      runId: "host-failover-test",
      workspace,
      workItems: [hostFailoverItem],
      jobs: ensureHostDispatchReservations([hostFailoverItem], []),
      state: "ready-for-codex",
    };
    const hostFailoverReserved = applyHostWorkerEvents(hostFailoverBase, { hostWorkerEvents: [{ event: "reserved", runId: hostFailoverBase.runId, workItemId: hostFailoverItem.id, attemptId: hostFailoverItem.hostAttempt.attemptId, dispatchToken: hostFailoverItem.hostAttempt.dispatchToken }] });
    const hostFailoverStarted = applyHostWorkerEvents(hostFailoverReserved, { hostWorkerEvents: [{ event: "started", runId: hostFailoverBase.runId, workItemId: hostFailoverItem.id, attemptId: hostFailoverItem.hostAttempt.attemptId, dispatchToken: hostFailoverItem.hostAttempt.dispatchToken, agentId: "agent-failover" }] });
    const hostFailed = applyHostWorkerEvents(hostFailoverStarted, { hostWorkerEvents: [{ event: "failed", runId: hostFailoverBase.runId, workItemId: hostFailoverItem.id, attemptId: hostFailoverItem.hostAttempt.attemptId, dispatchToken: hostFailoverItem.hostAttempt.dispatchToken, summary: "Native worker failed before completing the bounded patch.", failureCategory: "timeout" }] });
    const hostFailover = advanceOrchestrationRun(workspace, hostFailed, true);
    assert(hostFailover.workItems[0]?.assignment === "codex-host:gpt-5.6-luna" && hostFailover.workItems[0]?.state === "host-dispatch-required", "native host failure participates in bounded failover with a fresh reservation");

    const unconfirmedStop = terminateOrchestrationRun(workspace, {
      version: 2,
      runId: "unconfirmed-stop-test",
      workItems: [{ id: "worker", state: "running", assignment: "claude:sonnet" }],
      jobs: [{ jobId: "missing-worker-process", state: "running", workItemIds: ["worker"] }],
      decisions: [],
    }, "Stop before replacement.", "user-steering");
    assert(unconfirmedStop.termination.targetedWorkers === 1 && unconfirmedStop.termination.cancelledWorkers === 0 && unconfirmedStop.termination.cancellationUnconfirmed === 1, "unconfirmed worker termination blocks overlapping replacement");
    const firstCapsule = writeContextCapsule({ goal: "cache capsule", workspace, workItems: [{ id: "one", objective: "inspect", expectedFiles: [] }] });
    const reusedCapsule = writeContextCapsule({ goal: "cache capsule", workspace, workItems: [{ id: "one", objective: "inspect", expectedFiles: [] }] });
    assert(firstCapsule.reused === false && reusedCapsule.reused === true && firstCapsule.capsule.capsuleHash === reusedCapsule.capsule.capsuleHash, "unchanged context capsules reuse the validated local artifact");
    const samplePath = path.join(workspace, "sample.txt");
    fs.writeFileSync(samplePath, "before\n", "utf8");
    const created = createJob({ goal: "self-test", workspace, mode: "review", worker: "self-test" });
    const unchanged = finalizeWorkerGitArtifacts(workspace, created.jobDir, "review");
    assert(unchanged.reviewMutationDetected === false, "unchanged review workspace reports no worker diff");
    fs.writeFileSync(samplePath, "after\n", "utf8");
    const changed = finalizeWorkerGitArtifacts(workspace, created.jobDir, "review");
    assert(changed.reviewMutationDetected === true, "review workspace mutation is detected");

    const writerJob = createJob({ goal: "worker attribution self-test", workspace, mode: "patch", worker: "self-test" });
    const workerOnlyPath = path.join(workspace, "worker-only.txt");
    fs.writeFileSync(workerOnlyPath, "worker change\n", "utf8");
    const writerOutcome = finalizeWorkerGitArtifacts(workspace, writerJob.jobDir, "patch");
    const writerChanged = fs.readFileSync(path.join(writerJob.jobDir, "changed-files.txt"), "utf8");
    assert(writerOutcome.changedDuringRun.length === 1 && writerOutcome.changedDuringRun[0] === "worker-only.txt" && !writerChanged.includes("sample.txt"), "writer artifacts exclude unrelated dirty files that predated the worker");

    const preDirtyPath = path.join(workspace, "pre-dirty.txt");
    fs.writeFileSync(preDirtyPath, "user state\n", "utf8");
    const preDirtyJob = createJob({ goal: "pre-dirty attribution self-test", workspace, mode: "patch", worker: "self-test" });
    fs.writeFileSync(preDirtyPath, "worker state\n", "utf8");
    const preDirtyOutcome = finalizeWorkerGitArtifacts(workspace, preDirtyJob.jobDir, "patch");
    const preDirtyDiff = fs.readFileSync(path.join(preDirtyJob.jobDir, "diff.patch"), "utf8");
    assert(preDirtyOutcome.changedDuringRun.includes("pre-dirty.txt") && preDirtyDiff.includes("exact worker-only delta is omitted"), "changes to a pre-dirty path are detected without misattributing its full existing diff");

    const compactJob = createJob({ goal: "compact result self-test", workspace, mode: "review", worker: "self-test", maxResultBullets: 5 });
    fs.writeFileSync(path.join(compactJob.jobDir, "result.md"), Array.from({ length: 8 }, (_, index) => `- result ${index + 1}`).join("\n"), "utf8");
    fs.writeFileSync(path.join(compactJob.jobDir, "changed-files.txt"), "NONE\n", "utf8");
    fs.writeFileSync(path.join(compactJob.jobDir, "test-output-summary.md"), "Result: success\n", "utf8");
    const compactArtifact = compactResultArtifact(path.join(compactJob.jobDir, "result.md"), { maxResultBullets: 5 });
    assert(compactArtifact.split(/\r?\n/).length === 5, "result artifact compaction enforces the assigned bullet budget");
    const compactSnapshot = formatTeamRunSnapshot(workspace, {
      version: 2,
      state: "ready-for-codex",
      counts: { total: 1, completed: 1, running: 0, failed: 0 },
      workItems: [{ id: "compact", state: "completed", assignment: "self-test", assignedModel: "none", dependsOn: [] }],
      jobs: [{ jobId: compactJob.jobId, laneId: "compact", state: "completed", assignedTasks: ["compact"], model: "none" }],
    }, 0);
    assert(compactSnapshot.includes("CEOControlRoom:")
      && compactSnapshot.includes("workers=none active")
      && !compactSnapshot.includes("Changed: NONE")
      && compactSnapshot.length < 2100,
    `aggregate readback exposes an idle CEO brief, omits no-op changed markers, and stays compact (${compactSnapshot.length} chars)`);
    const cycleEvidenceSnapshot = formatTeamRunSnapshot(workspace, {
      version: 2,
      runId: "cycle-evidence-test",
      completionPolicy: "continuous-management",
      state: "ready-for-codex",
      activeCycle: { id: "cycle-5", number: 5, state: "running", itemIds: ["c5-one", "c5-two"] },
      workItems: [
        { id: "c5-one", state: "completed", assignment: "codex-host:luna", assignedModel: "luna", dependsOn: [], readOnly: true },
        { id: "c5-two", state: "completed", assignment: "codex-host:terra", assignedModel: "terra", dependsOn: [], readOnly: true },
      ],
      jobs: [
        { jobId: "host-one", laneId: "first-cycle-result", transport: "host-subagent", state: "completed", assignedTasks: ["c5-one"], workItemIds: ["c5-one"], model: "luna", inlineEvidence: { summary: "FIRST_CURRENT_CYCLE_RESULT" } },
        { jobId: "host-two", laneId: "second-cycle-result", transport: "host-subagent", state: "completed", assignedTasks: ["c5-two"], workItemIds: ["c5-two"], model: "terra", inlineEvidence: { summary: "SECOND_CURRENT_CYCLE_RESULT" } },
      ],
    }, 0);
    assert(cycleEvidenceSnapshot.includes("ActiveCycleState: awaiting-acceptance")
      && cycleEvidenceSnapshot.includes("cycle=5/awaiting-acceptance")
      && cycleEvidenceSnapshot.includes("FIRST_CURRENT_CYCLE_RESULT")
      && cycleEvidenceSnapshot.includes("SECOND_CURRENT_CYCLE_RESULT"),
    "ready cycles expose an awaiting-acceptance state and every current-cycle worker result");
    const activeProgressSnapshot = formatTeamRunSnapshot(workspace, {
      version: 2,
      runId: "visible-progress-test",
      state: "running",
      rootGoal: "Deliver the verified project outcome.",
      codexManagerReservePercent: 15,
      nextCapacityCheckpointAt: "2026-07-12T04:20:00.000Z",
      counts: { total: 1, completed: 0, running: 1, failed: 0 },
      workItems: [{ id: "active-review", state: "running", assignment: "claude:sonnet", assignedModel: "sonnet", dependsOn: [], readOnly: true, complexity: "medium" }],
      jobs: [{ jobId: compactJob.jobId, laneId: "active", state: "running", assignedTasks: ["active-review"], workItemIds: ["active-review"], model: "sonnet", startedAt: new Date(Date.now() - 30000).toISOString(), currentStep: "reviewing", readOnly: true, leaseMinutes: 12 }],
      resources: [
        { id: "codex:current", platform: "codex", team: "Codex", model: "gpt-test", displayName: "GPT Test", state: "manager-reserve", remainingPercent: 12, resetAt: "2026-07-12T04:00:00.000Z", dispatchable: false },
        { id: "claude:sonnet", platform: "claude", team: "Claude Code CLI", model: "sonnet", displayName: "Claude Sonnet", state: "available", remainingPercent: 80, resetAt: "2026-07-12T05:00:00.000Z", dispatchable: true },
        { id: "antigravity:flash", platform: "antigravity", team: "Antigravity CLI", model: "flash", displayName: "Gemini Flash", state: "available", remainingPercent: 65, resetAt: "2026-07-12T06:00:00.000Z", dispatchable: true },
      ],
      decisions: [{ at: utcStamp(), type: "worker-start", workItemId: "active-review", resourceId: "claude:sonnet" }],
    }, 120, { ...DEFAULT_PROFILE, address: "My Lord", updateStyle: "concise-executive" });
    assert(activeProgressSnapshot.includes("CEOControlRoom:")
      && activeProgressSnapshot.includes("Team now: Codex parent=CEO/manager")
      && activeProgressSnapshot.includes("active-review->Claude Code CLI/sonnet")
      && activeProgressSnapshot.includes("reviewing; 1/12m lease")
      && activeProgressSnapshot.includes("Capacity: Codex=manager-reserve")
      && activeProgressSnapshot.includes("Claude=active")
      && activeProgressSnapshot.includes("Antigravity=available")
      && activeProgressSnapshot.includes("remaining=12%")
      && activeProgressSnapshot.includes("reserve=15%")
      && activeProgressSnapshot.includes("Objective: Deliver the verified project outcome.")
      && activeProgressSnapshot.includes("items=0/1 completed; active=1")
      && activeProgressSnapshot.includes("Blocker/Decision:")
      && activeProgressSnapshot.includes("RequiredUserStatus: My Lord")
      && activeProgressSnapshot.includes("Objective, Changed, Team now, Capacity, Progress, Blocker/Decision, Next")
      && activeProgressSnapshot.includes("one existing Codex control-room task")
      && activeProgressSnapshot.includes("provider worker sessions/jobs are allowed and expected")
      && activeProgressSnapshot.includes("waitSeconds=120")
      && activeProgressSnapshot.includes("single active Goal")
      && activeProgressSnapshot.includes("Activity: started=")
      && activeProgressSnapshot.length < 4000,
    `running manager snapshots expose a bounded seven-field CEO brief, root goal, owners, capacity, and one transition-aware wait (${activeProgressSnapshot.length} chars)`);
    const refreshWarningSnapshot = formatTeamRunSnapshot(workspace, {
      version: 2,
      runId: "refresh-warning-test",
      state: "running",
      counts: { total: 1, completed: 0, running: 1, failed: 0 },
      workItems: [{ id: "active-review", objective: "Review active work", state: "running", assignment: "claude:sonnet", assignedModel: "sonnet", dependsOn: [], readOnly: true }],
      jobs: [],
      reportWait: { requestedSeconds: 120, elapsedSeconds: 1, transitionDetected: false, refreshError: "manifest changed during wait" },
    }, 120);
    assert(refreshWarningSnapshot.includes("StatusRefreshWarning: manifest changed during wait") && refreshWarningSnapshot.includes("last verified snapshot"), "a transition-wait refresh race returns explicit stale-snapshot evidence instead of hiding the interruption");
    assert(teamRunTransitionSignature({ state: "running", workItems: [{ id: "a", state: "running" }] }) !== teamRunTransitionSignature({ state: "running", workItems: [{ id: "a", state: "completed" }] }), "transition-aware waits detect work-item state changes without polling boilerplate");
    const malformedGraphSnapshot = formatTeamRunSnapshot(workspace, {
      version: 2,
      runId: "malformed-graph-test",
      state: "ready-for-codex",
      counts: { total: 1, completed: 1, running: 0, failed: 0 },
      workItems: [{ id: "safe-ready-recovery", objective: "Complete work item 2", state: "completed", assignment: "antigravity:gemini-3.5-flash-medium", assignedModel: "gemini-3.5-flash-medium", dependsOn: [], executionClass: "analysis", readOnly: true }],
      jobs: [],
    }, 0);
    assert(malformedGraphSnapshot.includes("WorkGraphIntegrity: invalid")
      && malformedGraphSnapshot.includes("Blocker/Decision: manager intervention required: replace the malformed graph")
      && malformedGraphSnapshot.includes("Next: stop the damaged contract and call run-project-manager once")
      && malformedGraphSnapshot.includes("Call run-project-manager once")
      && malformedGraphSnapshot.includes("do not integrate, verify")
      && !malformedGraphSnapshot.includes("NextCheck: one project-manager-status"),
    "persisted placeholder graphs surface a CEO intervention and safe canonical replacement instead of integration or repeated polling");
    const malformedContinuousSnapshot = formatTeamRunSnapshot(workspace, {
      version: 2,
      runId: "malformed-continuous-test",
      goal: "Continuously improve the root project outcome.",
      rootGoal: "Continuously improve the root project outcome.",
      completionPolicy: "continuous-management",
      cycleNumber: 3,
      activeCycle: { id: "cycle-3", number: 3, objective: "Repair malformed work", state: "running", itemIds: ["safe-ready-recovery"] },
      state: "ready-for-codex",
      counts: { total: 1, completed: 1, running: 0, failed: 0 },
      workItems: [{ id: "safe-ready-recovery", objective: "Complete work item 2", state: "completed", assignment: "antigravity:gemini-3.5-flash-medium", assignedModel: "gemini-3.5-flash-medium", dependsOn: [], executionClass: "analysis", readOnly: true }],
      jobs: [],
    }, 0);
    assert(malformedContinuousSnapshot.includes("WorkGraphIntegrity: invalid")
      && malformedContinuousSnapshot.includes("fail this cycle and provide a canonical correction graph under the same root run")
      && malformedContinuousSnapshot.includes("expectedRunId=malformed-continuous-test")
      && malformedContinuousSnapshot.includes("expectedCycleId=cycle-3")
      && malformedContinuousSnapshot.includes("canonical nextWorkItems")
      && !malformedContinuousSnapshot.includes("Call run-project-manager once"),
    "a malformed continuous cycle repairs through identity-guarded nextWorkItems without replacing the root run");
    const supersededJob = createJob({ goal: "superseded failure self-test", workspace, mode: "review", worker: "self-test" });
    fs.writeFileSync(path.join(supersededJob.jobDir, "result.md"), "- SUPERSEDED_DETAIL_SHOULD_NOT_BE_REPEATED\n", "utf8");
    fs.writeFileSync(path.join(supersededJob.jobDir, "test-output-summary.md"), "Result: failed\n", "utf8");
    const recoveredSnapshot = formatTeamRunSnapshot(workspace, {
      version: 2,
      state: "ready-for-codex",
      counts: { total: 2, completed: 1, running: 0, failed: 1 },
      workItems: [{ id: "compact", state: "completed", assignment: "self-test", assignedModel: "none", dependsOn: [] }],
      jobs: [
        { jobId: supersededJob.jobId, laneId: "failed", state: "failed", assignedTasks: ["compact"], workItemIds: ["compact"], model: "none", blocker: "timeout" },
        { jobId: compactJob.jobId, laneId: "compact", state: "completed", assignedTasks: ["compact"], workItemIds: ["compact"], model: "none" },
      ],
    }, 0);
    assert(recoveredSnapshot.includes("Recovered:") && !recoveredSnapshot.includes("SUPERSEDED_DETAIL_SHOULD_NOT_BE_REPEATED"), "successful failover collapses superseded failure detail in aggregate readback");

    updateJobStatus(workspace, created.jobId, { state: "completed", currentStep: "self-test-completed" });
    fs.writeFileSync(path.join(created.jobDir, "result.md"), "- self-test completed\n", "utf8");
    const manifest = {
      version: 1,
      createdAt: utcStamp(),
      goal: "self-test",
      workspace,
      taskSplit: ["testing"],
      state: "running",
      jobs: [{ jobId: created.jobId, laneId: "self-test", worker: "self-test", assignedTasks: ["testing"], model: "none", state: "running" }],
    };
    writeTeamRunManifest(workspace, manifest);
    const completedRefresh = refreshTeamRunManifest(workspace);
    assert(completedRefresh.state === "completed", "aggregate team state reaches completed only after job completion");
    assert(completedRefresh.jobs[0]?.failureCategory === "", "completed worker attempts never retain a synthetic failure category");
    writeTeamRunManifest(workspace, { ...manifest, jobs: [] });
    assert(refreshTeamRunManifest(workspace).state === "blocked", "team with no startable jobs reports blocked");

    const corruptStatusJob = createJob({ goal: "corrupt status recovery self-test", workspace, mode: "review", worker: "self-test" });
    const corruptStatusPath = path.join(corruptStatusJob.jobDir, "status.json");
    fs.writeFileSync(corruptStatusPath, "{", "utf8");
    const corruptFallback = bridgeStatusForManifestJob({ jobId: corruptStatusJob.jobId, state: "running" }, corruptStatusPath);
    const corruptRepair = repairStaleRunningJob(workspace, corruptStatusJob.jobId, corruptStatusJob.jobDir, corruptFallback);
    assert(corruptFallback.statusCorrupt === true && corruptRepair.status.state === "failed" && corruptRepair.status.failureCategory === "state-corruption", "unreadable status JSON fails closed instead of holding an unknown worker slot forever");

    const staleTelemetryJob = createJob({ goal: "telemetry repair self-test", workspace, mode: "review", worker: "self-test" });
    fs.writeFileSync(path.join(staleTelemetryJob.jobDir, "result.md"), "- Worker timed out before final status write.\n", "utf8");
    fs.writeFileSync(path.join(staleTelemetryJob.jobDir, "test-output-summary.md"), "Result: failed\n", "utf8");
    recordWorkerTelemetry(workspace, staleTelemetryJob.jobDir, {
      resourceId: "antigravity:self-test",
      workItemKinds: ["verification-review"],
    }, {
      provider: "antigravity",
      requestedModel: "self-test",
      observedModel: "self-test",
      success: false,
      failureCategory: "timeout",
      durationMs: 100,
      promptChars: 900,
      resultChars: 48,
    });
    updateJobStatus(workspace, staleTelemetryJob.jobId, { state: "running", currentStep: "worker-running", workerPid: 2147483647, workerCommandMarker: staleTelemetryJob.jobId });
    const telemetryRepair = repairStaleRunningJob(workspace, staleTelemetryJob.jobId, staleTelemetryJob.jobDir, readJsonFile(path.join(staleTelemetryJob.jobDir, "status.json"), {}));
    assert(telemetryRepair.status.state === "failed" && telemetryRepair.status.failureCategory === "timeout" && telemetryRepair.source === "telemetry", "stale running status recovers the authoritative failure category from finalized telemetry");
    const failedResourceOutcome = compactOutcome(readWorkspaceResourceState(workspace).outcomes["antigravity:self-test"] || {});
    assert(failedResourceOutcome.successfulKinds.length === 0 && failedResourceOutcome.consecutiveFailures === 1, "failed telemetry records reliability without creating successful task affinity");
    const efficiencyTelemetry = readJsonFile(path.join(staleTelemetryJob.jobDir, "worker-telemetry.json"), {});
    assert(efficiencyTelemetry.promptChars === 900 && efficiencyTelemetry.resultChars === 48, "worker telemetry records prompt and compact-result sizes for efficiency checks");

    let fakeLaunchCount = 0;
    const fakeLaunch = (runManifest, resource, items, failoverOf = "") => {
      fakeLaunchCount += 1;
      return {
        launched: true,
        blocker: "",
        job: {
          toolName: "self-test-launch",
          laneId: `self-test-${resource.id}`,
          worker: resource.team,
          resourceId: resource.id,
          assignedTasks: items.map((item) => item.id),
          workItemIds: items.map((item) => item.id),
          model: resource.model,
          jobId: `fake-${fakeLaunchCount}`,
          state: "running",
          failoverOf,
          failoverDepth: failoverOf ? 1 : 0,
        },
      };
    };
    let lifecycle = {
      version: 2,
      runId: "self-test-orchestration",
      goal: "implement then independently verify",
      workspace,
      mode: "patch",
      resources: [
        { id: "claude:sonnet", team: "Claude Code", displayName: "Claude Sonnet", platform: "claude", model: "sonnet", dispatchable: true, state: "available" },
        { id: "antigravity:flash", team: "Antigravity", displayName: "Gemini Flash", platform: "antigravity", model: "flash", dispatchable: true, state: "available" },
      ],
      decisions: [],
      jobs: [],
      workItems: [
        { id: "implement", objective: "implement", kind: "implementation", complexity: "high", readOnly: false, dependsOn: [], priority: 100, assignment: "claude:sonnet", assignedModel: "sonnet", alternates: ["antigravity:flash"], expectedFiles: [], state: "pending", failoverCount: 0 },
        { id: "verify", objective: "verify", kind: "testing", complexity: "medium", readOnly: true, dependsOn: ["implement"], priority: 80, assignment: "antigravity:flash", assignedModel: "flash", alternates: ["claude:sonnet"], expectedFiles: [], state: "pending", failoverCount: 0 },
      ],
    };
    lifecycle = advanceOrchestrationRun(workspace, lifecycle, true, fakeLaunch);
    assert(fakeLaunchCount === 1 && lifecycle.workItems.find((item) => item.id === "verify")?.state === "pending", "dependency-aware dispatch launches only the ready writer");
    lifecycle = advanceOrchestrationRun(workspace, lifecycle, true, fakeLaunch);
    assert(fakeLaunchCount === 1, "repeated orchestration polling does not duplicate an active dispatch");
    lifecycle.jobs[0] = { ...lifecycle.jobs[0], state: "failed", failureCategory: "timeout", blocker: "worker timed out" };
    lifecycle = advanceOrchestrationRun(workspace, lifecycle, true, fakeLaunch);
    assert(fakeLaunchCount === 2 && lifecycle.workItems.find((item) => item.id === "implement")?.assignment === "antigravity:flash", "retryable failure performs one bounded cross-team failover");
    assert(!lifecycle.workItems.find((item) => item.id === "implement")?.failureCategory, "active failover clears stale failure labels from the work item");
    assert(lifecycle.resources.find((resource) => resource.id === "claude:sonnet")?.state === "cooldown", "failed resource enters cooldown before future assignment");
    lifecycle.jobs[1] = { ...lifecycle.jobs[1], state: "completed" };
    lifecycle = advanceOrchestrationRun(workspace, lifecycle, true, fakeLaunch);
    assert(fakeLaunchCount === 3 && lifecycle.workItems.find((item) => item.id === "verify")?.state === "running", "dependent verifier starts automatically after implementation succeeds");
    lifecycle.jobs[2] = { ...lifecycle.jobs[2], state: "completed" };
    lifecycle = advanceOrchestrationRun(workspace, lifecycle, true, fakeLaunch);
    assert(lifecycle.state === "ready-for-codex" && lifecycle.decisions.filter((decision) => decision.type === "failover").length === 1, "completed workers return control to Codex with exactly one failover decision");
    assert(!lifecycle.workItems.some((item) => item.failureCategory), "successful failover completion leaves current work graph free of stale failure labels");
    lifecycle.resources = lifecycle.resources.map((resource) => resource.id === "claude:sonnet"
      ? { ...resource, state: "cooldown", cooldownUntil: new Date(Date.now() - 1000).toISOString() }
      : resource);
    lifecycle = advanceOrchestrationRun(workspace, lifecycle, true, fakeLaunch);
    assert(lifecycle.resources.find((resource) => resource.id === "claude:sonnet")?.state === "available", "expired resource cooldown is restored automatically");

    const cancellable = createJob({ goal: "cancel self-test", workspace, mode: "fast", worker: "self-test" });
    sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore", windowsHide: true });
    sleeper.unref();
    updateJobStatus(workspace, cancellable.jobId, { state: "running", currentStep: "self-test-sleeper", workerPid: sleeper.pid, workerCommandMarker: "setInterval" });
    assert(isProcessAlive(sleeper.pid), "cancellation fixture process starts");
    assert(effectiveBridgeJobStatus({ state: "completed", workerPid: sleeper.pid, workerCommandMarker: "setInterval" }).state === "running", "worker-written terminal state cannot finish a job while bridge finalization is still active");
    assert(effectiveBridgeJobStatus({ state: "completed", bridgeFinalized: true, workerPid: sleeper.pid, workerCommandMarker: "setInterval" }).state === "completed", "bridge-finalized terminal state is authoritative");
    const refused = terminateProcessTree(sleeper.pid, "not-the-worker-command");
    assert(refused.stopped === false && isProcessAlive(sleeper.pid), "cancellation refuses a mismatched process identity");
    cancelJob({ workspace, jobId: cancellable.jobId, reason: "self-test" });
    assert(!isProcessAlive(sleeper.pid), "cancel-job stops the worker process tree");
  } finally {
    if (sleeper?.pid && isProcessAlive(sleeper.pid)) terminateProcessTree(sleeper.pid);
    if (originalCodexCliPath === undefined) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = originalCodexCliPath;
    if (fakeCodexRoot && path.resolve(fakeCodexRoot).startsWith(`${tempRoot}${path.sep}`)) fs.rmSync(fakeCodexRoot, { recursive: true, force: true });
    const resolved = path.resolve(workspace);
    if (resolved.startsWith(`${tempRoot}${path.sep}`)) fs.rmSync(resolved, { recursive: true, force: true });
  }

  return ["AiMobileSelfTest:", `Passed: ${passed.length}`, ...passed.map((name) => `- ${name}`)].join("\n");
}

async function handleRequest(message) {
  const { id, method, params } = message;

  if (method === "initialize") {
    sendResult(id, {
      protocolVersion: params?.protocolVersion || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "ai-mobile-local", version: pluginVersion },
    });
    return;
  }

  if (method === "notifications/initialized") {
    return;
  }

  if (method === "tools/list") {
    sendResult(id, { tools: exposedMcpTools() });
    return;
  }

  if (method === "tools/call") {
    const name = params?.name;
    const tool = tools.find((entry) => entry.name === name);
    if (!tool) {
      sendError(id, -32602, `Unknown tool: ${name}`);
      return;
    }

    try {
      if (name === "handoff-template") {
        const text = buildHandoffTemplate(params?.arguments || {});
        sendResult(id, { content: [{ type: "text", text }] });
        return;
      }

      if (name === "offload-advice") {
        const text = buildOffloadAdvice(params?.arguments || {});
        sendResult(id, { content: [{ type: "text", text }] });
        return;
      }

      if (name === "devtools-health") {
        const result = await runHelper("live");
        const text = `${buildDevToolsHealthAdvice(result)}\n\nRaw live report:\n${JSON.stringify(result, null, 2)}`;
        sendResult(id, { content: [{ type: "text", text }] });
        return;
      }

      if (name === "submission-guide") {
        sendResult(id, { content: [{ type: "text", text: buildSubmissionGuide() }] });
        return;
      }

      if (name === "prepare-offload") {
        const quick = await runHelper("quick");
        const text = buildPrepareOffload(params?.arguments || {}, quick);
        sendResult(id, { content: [{ type: "text", text }] });
        return;
      }

      if (name === "orchestration-plan") {
        const text = await buildOrchestrationPlan(params?.arguments || {});
        sendResult(id, { content: [{ type: "text", text }] });
        return;
      }

      if (name === "efficiency-flow") {
        const text = await buildEfficiencyFlow(params?.arguments || {});
        sendResult(id, { content: [{ type: "text", text }] });
        return;
      }

      if (name === "run-efficient-task") {
        const text = await runEfficientTask(params?.arguments || {});
        sendResult(id, { content: [{ type: "text", text }] });
        return;
      }

      if (name === "codex-usage") {
        sendResult(id, { content: [{ type: "text", text: formatCodexUsage() }] });
        return;
      }

      if (name === "context-capsule") {
        const result = writeContextCapsule(params?.arguments || {});
        const text = [
          "AiMobileContextCapsule:",
          `Path: ${result.outputPath}`,
          `Hash: ${result.capsule.capsuleHash}`,
          `Reused: ${result.reused === true}`,
          `WorkItems: ${result.capsule.workItems.length}`,
          `TaskCapsules: ${Object.keys(result.taskCapsules || {}).length}`,
          `FileEvidenceEntries: ${result.capsule.fileEvidence.length}`,
          "TranscriptIncluded: false",
          "Next: pass this path to workers; do not paste the parent chat or broad logs.",
        ].join("\n");
        sendResult(id, { content: [{ type: "text", text }] });
        return;
      }

      if (name === "project-manager-plan") {
        const text = await buildProjectManagerPlan(params?.arguments || {});
        sendResult(id, { content: [{ type: "text", text }] });
        return;
      }

      if (name === "run-project-manager") {
        const text = await runProjectManager(params?.arguments || {});
        sendResult(id, { content: [{ type: "text", text }] });
        return;
      }

      if (name === "project-manager-status") {
        const text = await projectManagerStatus(params?.arguments || {});
        sendResult(id, { content: [{ type: "text", text }] });
        return;
      }

      if (name === "orchestrator-profile") {
        const values = params?.arguments || {};
        const profile = String(values.action || "get").toLowerCase() === "set"
          ? writeProfile({
              communicationStyle: values.communicationStyle,
              address: values.address,
              updateStyle: values.updateStyle,
              role: values.role,
              codexModelAllowPattern: values.codexModelAllowPattern,
              claudeModelAllowPattern: values.claudeModelAllowPattern,
              claudePreferredModelPattern: values.claudePreferredModelPattern,
              antigravityPreferredTaskPattern: values.antigravityPreferredTaskPattern,
              modelPolicyReviewAfter: values.modelPolicyReviewAfter,
              adaptiveRouting: values.adaptiveRouting,
              cliFirst: values.cliFirst,
              uiFallbackOnly: values.uiFallbackOnly,
              antigravityAutoApprovePermissions: values.antigravityAutoApprovePermissions,
            })
          : readProfile();
        sendResult(id, { content: [{ type: "text", text: formatOrchestratorProfile(profile) }] });
        return;
      }

      if (name === "resource-inventory") {
        const text = await getResourceInventory(params?.arguments || {});
        sendResult(id, { content: [{ type: "text", text }] });
        return;
      }

      if (name === "orchestrate-project") {
        const text = await orchestrateProject(params?.arguments || {});
        sendResult(id, { content: [{ type: "text", text }] });
        return;
      }

      if (name === "team-orchestration-plan") {
        const text = await buildTeamOrchestrationPlan(params?.arguments || {});
        sendResult(id, { content: [{ type: "text", text }] });
        return;
      }

      if (name === "run-team-task") {
        const text = await runTeamTask(params?.arguments || {});
        sendResult(id, { content: [{ type: "text", text }] });
        return;
      }

      if (name === "read-team-run") {
        const text = await readTeamRun(params?.arguments || {});
        sendResult(id, { content: [{ type: "text", text }] });
        return;
      }

      if (name === "create-job") {
        const created = createJob(params?.arguments || {});
        const text = [
          "CreateJobResult:",
          `JobId: ${created.jobId}`,
          `JobFolder: ${created.jobDir}`,
          "State: queued",
          "Next: call submit-job to send it to Antigravity, or read request.md for manual review.",
        ].join("\n");
        sendResult(id, { content: [{ type: "text", text }] });
        return;
      }

      if (name === "submit-job") {
        const text = await submitJob(params?.arguments || {});
        sendResult(id, { content: [{ type: "text", text }] });
        return;
      }

      if (name === "agy-status") {
        sendResult(id, { content: [{ type: "text", text: getAgyStatusText() }] });
        return;
      }

      if (name === "agy-models") {
        sendResult(id, { content: [{ type: "text", text: getAgyModelsText() }] });
        return;
      }

      if (name === "submit-agy-job") {
        const text = submitAgyJob(params?.arguments || {});
        sendResult(id, { content: [{ type: "text", text }] });
        return;
      }

      if (name === "codex-cli-status") {
        sendResult(id, { content: [{ type: "text", text: getCodexCliStatusText() }] });
        return;
      }

      if (name === "submit-codex-job") {
        const text = submitCodexJob(params?.arguments || {});
        sendResult(id, { content: [{ type: "text", text }] });
        return;
      }

      if (name === "claude-status") {
        sendResult(id, { content: [{ type: "text", text: getClaudeStatusText() }] });
        return;
      }

      if (name === "claude-usage") {
        sendResult(id, { content: [{ type: "text", text: getClaudeUsageText() }] });
        return;
      }

      if (name === "submit-claude-job") {
        const text = submitClaudeJob(params?.arguments || {});
        sendResult(id, { content: [{ type: "text", text }] });
        return;
      }

      if (name === "cursor-status") {
        sendResult(id, { content: [{ type: "text", text: getCursorStatusText() }] });
        return;
      }

      if (name === "open-cursor") {
        const text = openCursorUi(params?.arguments || {});
        sendResult(id, { content: [{ type: "text", text }] });
        return;
      }

      if (name === "submit-cursor-job") {
        const text = submitCursorJob(params?.arguments || {});
        sendResult(id, { content: [{ type: "text", text }] });
        return;
      }

      if (name === "list-jobs") {
        const text = listJobs(params?.arguments || {});
        sendResult(id, { content: [{ type: "text", text }] });
        return;
      }

      if (name === "read-job") {
        const text = readJob(params?.arguments || {});
        sendResult(id, { content: [{ type: "text", text }] });
        return;
      }

      if (name === "cancel-job") {
        const text = cancelJob(params?.arguments || {});
        sendResult(id, { content: [{ type: "text", text }] });
        return;
      }

      if (name === "retry-job") {
        const text = await retryJob(params?.arguments || {});
        sendResult(id, { content: [{ type: "text", text }] });
        return;
      }

      if (name === "select-chat") {
        const text = await selectAntigravityChat(params?.arguments || {});
        sendResult(id, { content: [{ type: "text", text }] });
        return;
      }

      if (name === "submit-offload") {
        const text = await submitOffloadToCurrentChat(params?.arguments || {});
        sendResult(id, { content: [{ type: "text", text }] });
        return;
      }

      if (name === "switch-model") {
        const text = await switchModelInCurrentChat(params?.arguments || {});
        sendResult(id, { content: [{ type: "text", text }] });
        return;
      }

      const command = name === "models" ? "limits" : name;
      const result = await runHelper(command);
      sendResult(id, {
        content: [
          {
            type: "text",
            text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
          },
        ],
      });
    } catch (error) {
      sendError(id, -32000, error?.message || String(error));
    }
    return;
  }

  if (id !== undefined) {
    sendError(id, -32601, `Method not found: ${method}`);
  }
}

if (["self-test-cli", "orchestration-supervisor-cli", "orchestration-plan-cli", "efficiency-flow-cli", "run-efficient-task-cli", "codex-usage-cli", "context-capsule-cli", "project-manager-plan-cli", "run-project-manager-cli", "project-manager-status-cli", "orchestrator-profile-cli", "resource-inventory-cli", "orchestrate-project-cli", "team-orchestration-plan-cli", "run-team-task-cli", "read-team-run-cli", "submit-offload-cli", "switch-model-cli", "select-chat-cli", "create-job-cli", "submit-job-cli", "agy-status-cli", "agy-models-cli", "submit-agy-job-cli", "agy-job-worker-cli", "codex-cli-status-cli", "submit-codex-job-cli", "codex-job-worker-cli", "claude-status-cli", "claude-usage-cli", "submit-claude-job-cli", "claude-job-worker-cli", "cursor-status-cli", "open-cursor-cli", "submit-cursor-job-cli", "cursor-job-worker-cli", "list-jobs-cli", "read-job-cli", "cancel-job-cli", "retry-job-cli"].includes(process.argv[2])) {
  let args = {};
  try {
    if (process.argv[3] === "--json-file") {
      args = JSON.parse(fs.readFileSync(process.argv[4], "utf8"));
    } else {
      args = process.argv[3] ? JSON.parse(process.argv[3]) : {};
    }
  } catch (error) {
    console.error(`Invalid submit-offload JSON: ${error?.message || String(error)}`);
    process.exit(2);
  }

  const actions = {
    "self-test-cli": async () => runSelfTest(),
    "orchestration-supervisor-cli": runOrchestrationSupervisor,
    "orchestration-plan-cli": buildOrchestrationPlan,
    "efficiency-flow-cli": buildEfficiencyFlow,
    "run-efficient-task-cli": runEfficientTask,
    "codex-usage-cli": async () => formatCodexUsage(),
    "context-capsule-cli": async (value) => {
      const result = writeContextCapsule(value);
      return `AiMobileContextCapsule:\nPath: ${result.outputPath}\nHash: ${result.capsule.capsuleHash}\nReused: ${result.reused === true}\nWorkItems: ${result.capsule.workItems.length}\nTaskCapsules: ${Object.keys(result.taskCapsules || {}).length}\nTranscriptIncluded: false`;
    },
    "project-manager-plan-cli": buildProjectManagerPlan,
    "run-project-manager-cli": runProjectManager,
    "project-manager-status-cli": projectManagerStatus,
    "orchestrator-profile-cli": async (value) => formatOrchestratorProfile(String(value.action || "get").toLowerCase() === "set" ? writeProfile(value) : readProfile()),
    "resource-inventory-cli": getResourceInventory,
    "orchestrate-project-cli": orchestrateProject,
    "team-orchestration-plan-cli": buildTeamOrchestrationPlan,
    "run-team-task-cli": runTeamTask,
    "read-team-run-cli": readTeamRun,
    "submit-offload-cli": submitOffloadToCurrentChat,
    "switch-model-cli": switchModelInCurrentChat,
    "select-chat-cli": selectAntigravityChat,
    "create-job-cli": async (value) => {
      const created = createJob(value);
      return `CreateJobResult:\nJobId: ${created.jobId}\nJobFolder: ${created.jobDir}\nState: queued`;
    },
    "submit-job-cli": submitJob,
    "agy-status-cli": async () => getAgyStatusText(),
    "agy-models-cli": async () => getAgyModelsText(),
    "submit-agy-job-cli": async (value) => submitAgyJob(value),
    "agy-job-worker-cli": async (value) => runWorkerFailClosed("antigravity-cli", value, runAgyJobWorker),
    "codex-cli-status-cli": async () => getCodexCliStatusText(),
    "submit-codex-job-cli": async (value) => submitCodexJob(value),
    "codex-job-worker-cli": async (value) => runWorkerFailClosed("codex-cli", value, runCodexJobWorker),
    "claude-status-cli": async () => getClaudeStatusText(),
    "claude-usage-cli": async () => getClaudeUsageText(),
    "submit-claude-job-cli": async (value) => submitClaudeJob(value),
    "claude-job-worker-cli": async (value) => runWorkerFailClosed("claude-code", value, runClaudeJobWorker),
    "cursor-status-cli": async () => getCursorStatusText(),
    "open-cursor-cli": async (value) => openCursorUi(value),
    "submit-cursor-job-cli": async (value) => submitCursorJob(value),
    "cursor-job-worker-cli": async (value) => runWorkerFailClosed("cursor-agent", value, runCursorJobWorker),
    "list-jobs-cli": async (value) => listJobs(value),
    "read-job-cli": async (value) => readJob(value),
    "cancel-job-cli": async (value) => cancelJob(value),
    "retry-job-cli": retryJob,
  };
  const action = actions[process.argv[2]];
  action(args)
    .then((text) => {
      fs.writeSync(process.stdout.fd, `${String(text || "")}\n`);
      process.exitCode = 0;
    })
    .catch((error) => {
      console.error(error?.message || String(error));
      process.exitCode = 1;
    });
  return;
}

let buffer = Buffer.alloc(0);

function dispatchMcpPayload(payload, mode) {
  transportMode ||= mode;
  try {
    const message = JSON.parse(payload);
    handleRequest(message).catch((error) => {
      if (message.id !== undefined) {
        sendError(message.id, -32000, error?.message || String(error));
      }
    });
  } catch (error) {
    sendError(null, -32700, error?.message || "Parse error");
  }
}

function contentLengthPrefix(bufferValue) {
  const expected = "content-length:";
  const prefix = bufferValue.slice(0, Math.min(bufferValue.length, expected.length)).toString("utf8").toLowerCase();
  return expected.startsWith(prefix);
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);

  while (buffer.length) {
    if (transportMode === "content-length" || (transportMode === null && contentLengthPrefix(buffer))) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;

      const headers = buffer.slice(0, headerEnd).toString("utf8");
      const match = headers.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        buffer = buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = Number.parseInt(match[1], 10);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + contentLength;
      if (buffer.length < messageEnd) return;

      const payload = buffer.slice(messageStart, messageEnd).toString("utf8");
      buffer = buffer.slice(messageEnd);
      dispatchMcpPayload(payload, "content-length");
      continue;
    }

    const lineEnd = buffer.indexOf("\n");
    if (lineEnd === -1) return;
    const payload = buffer.slice(0, lineEnd).toString("utf8").trim();
    buffer = buffer.slice(lineEnd + 1);
    if (!payload) continue;
    dispatchMcpPayload(payload, "ndjson");
  }
});
