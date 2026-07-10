#!/usr/bin/env node

const { spawn, spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const crypto = require("node:crypto");

const pluginRoot = path.resolve(__dirname, "..");
const helperScript = path.join(pluginRoot, "scripts", "antigravity.ps1");
const devToolsPortFile = path.join(process.env.APPDATA || "", "Antigravity", "DevToolsActivePort");
const resourceCacheFile = path.join(process.env.LOCALAPPDATA || os.tmpdir(), "AI Mobile", "resource-cache.json");
const codexModelsCacheFile = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "models_cache.json");
const resourceCacheTtlMs = 10 * 60 * 1000;
const processIdentityCache = new Map();

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
    name: "resource-inventory",
    description: "Inspect the local AI team without starting apps or work: Codex caller state, Claude Code, Antigravity CLI/models/live quota when already running, Cursor, cooldowns, and evidence freshness.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Optional project workspace used for continuity and recent outcome evidence." },
        codexModel: { type: "string", description: "Caller-visible current Codex model label. The plugin cannot read Codex's private model/session ledger.", default: "current Codex session" },
        codexBudgetState: { type: "string", description: "Caller-visible Codex capacity, such as healthy, medium, low, critical, unknown, or exact UI text.", default: "unknown" },
        codexRemainingPercent: { type: "number", description: "Optional caller-visible Codex remaining percentage." },
        codexResetAt: { type: "string", description: "Optional caller-visible Codex reset time." },
        horizonHours: { type: "number", description: "Decision horizon for resets and cooldowns.", default: 5 },
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
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Stable short work item id." },
              objective: { type: "string", description: "Concrete outcome for this item." },
              kind: { type: "string", description: "Examples: discovery, architecture, implementation, debugging, verification, review, integration, docs." },
              complexity: { type: "string", enum: ["low", "medium", "high", "critical"], default: "medium" },
              requiredCapabilities: { type: "array", items: { type: "string" }, description: "Capabilities required from the selected model." },
              dependsOn: { type: "array", items: { type: "string" }, description: "Ids that must complete before this item can be finalized." },
              expectedFiles: { type: "array", items: { type: "string" }, description: "Optional file ownership boundary." },
              readOnly: { type: "boolean", description: "True for scouts/reviewers; false for implementation.", default: true },
              preferredPlatform: { type: "string", description: "Optional caller preference: codex, claude, antigravity, or cursor." },
              acceptanceCriteria: { type: "array", items: { type: "string" }, maxItems: 4, description: "Specific conditions that must be true before this item is accepted." },
              verification: { type: "array", items: { type: "string" }, maxItems: 4, description: "Focused checks for this item; do not run unrelated suites." },
              priority: { type: "number", description: "Higher values dispatch first.", default: 50 },
            },
            required: ["id", "objective"],
            additionalProperties: false,
          },
        },
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
        includeCursor: { type: "boolean", description: "Use Cursor only if a real headless cursor-agent is available.", default: false },
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
        printTimeout: { type: "string", description: "Antigravity CLI print timeout, such as 5m or 30s.", default: "5m" },
        start: { type: "boolean", description: "Set false to create the job without starting Antigravity CLI.", default: true },
        maxMinutes: { type: "number", description: "Maximum minutes the background Antigravity CLI worker may run.", default: 30 },
      },
      required: ["goal", "workspace"],
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
        fallbackModel: { type: "string", description: "Optional Claude Code fallback model alias or id." },
        permissionMode: { type: "string", description: "Claude Code permission mode. Defaults to plan for review and acceptEdits otherwise." },
        maxBudgetUsd: { type: "number", description: "Optional Claude Code maximum spend for this job." },
        start: { type: "boolean", description: "Set false to create the job and payload without starting Claude Code.", default: true },
        maxMinutes: { type: "number", description: "Maximum minutes the background Claude worker may run.", default: 10 },
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
        start: { type: "boolean", description: "Set false to create the job without starting Cursor agent.", default: true },
        maxMinutes: { type: "number", description: "Maximum minutes the background Cursor worker may run.", default: 30 },
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
  const readArtifacts = "result.md, changed-files.txt, diff.patch, test-output-summary.md, status.json";
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

function enrichClaudeModelRoster(models = [], claudeCache = {}) {
  const resolutions = claudeCache.aliasResolutions || {};
  const observed = String(claudeCache.observedModel || "");
  return models.map((model) => {
    const alias = String(model.id || "").toLowerCase();
    const observedMatch = observed.toLowerCase().includes(`-${alias}-`) || observed.toLowerCase().endsWith(`-${alias}`) ? observed : "";
    const resolvedId = String(resolutions[alias] || model.resolvedId || observedMatch || "");
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
  const cursorUi = findCursorApp();
  const cursorAgent = args.includeCursor ? resolveCommandFast("cursor-agent") : { found: false, command: "" };
  const liveProbe = await probeAntigravityDevTools();

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
  if (claude.found && (refresh || !isFreshTimestamp(cache.claude?.modelsCheckedAt) || claudeModels.length === 0)) {
    const modelProbe = runClaudeCli(claude.command, ["--help"], { timeout: 10000 });
    if (modelProbe.status === 0) {
      claudeModels = parseClaudeModelRoster(`${modelProbe.stdout}\n${modelProbe.stderr}`);
      const aliasResolutions = { ...(cache.claude?.aliasResolutions || {}) };
      for (const model of claudeModels) {
        if (model.resolvedId) aliasResolutions[model.id] = model.resolvedId;
      }
      cache = updateSafeResourceCache({
        claude: { found: true, models: claudeModels, aliasResolutions, modelsCheckedAt: utcStamp() },
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
    cursor: { headlessFound: cursorAgent.found, lastSeenAt: utcStamp() },
  });

  return {
    codexModel: String(args.codexModel || "current Codex session").trim() || "current Codex session",
    codexBudget: normalizeBudgetState(args.codexBudgetState || "unknown"),
    codexRemainingPercent: Number.isFinite(Number(args.codexRemainingPercent)) ? Number(args.codexRemainingPercent) : null,
    codexResetAt: String(args.codexResetAt || ""),
    codexCatalog,
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
  }
  if (/gpt-oss/.test(text)) {
    capabilities.add("implementation");
    capabilities.add("debugging");
    capabilities.add("testing");
    quality = 76;
    speed = 70;
    cost = 80;
  }
  return { capabilities: [...capabilities], quality, speed, cost };
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
  const outcomes = context.workspaceState?.outcomes || {};
  const horizonHours = Math.max(1, Math.min(12, Number(args.horizonHours || 5)));
  const platformReliability = {
    codex: platformReliabilitySummary(outcomes, "codex", horizonHours),
    claude: platformReliabilitySummary(outcomes, "claude", horizonHours),
    antigravity: platformReliabilitySummary(outcomes, "antigravity", horizonHours),
    cursor: platformReliabilitySummary(outcomes, "cursor", horizonHours),
  };
  const codexState = ["critical", "low"].includes(context.codexBudget.state) ? "constrained" : "available";
  const candidates = [{
    id: "codex:current",
    platform: "codex",
    team: "Codex",
    model: context.codexModel,
    displayName: context.codexModel,
    dispatchable: false,
    state: codexState,
    evidence: context.codexRemainingPercent === null ? "caller-or-unknown" : "caller-measured",
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

  const claudeModels = context.claudeModels?.length
    ? context.claudeModels
    : [{ id: "sonnet", displayName: context.claudeObservedModel || "Claude Sonnet (local alias)", evidence: "detected-cli" }];
  for (const model of claudeModels) {
    const modelId = String(model.id || "sonnet").toLowerCase();
    const id = `claude:${modelId}`;
    const claudeOutcome = outcomes[id] || {};
    const measured = claudeQuotaForModel(context.claudeUsage, modelId);
    const claudeAvailability = candidateAvailability(context.claudeFound, context.claudeAuth?.loggedIn, claudeOutcome, measured);
    const profile = claudeModelProfile(modelId);
    candidates.push({
      id,
      platform: "claude",
      team: "Claude Code CLI",
      model: modelId,
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
    candidates.push({
      id,
      platform: "antigravity",
      team: "Antigravity CLI",
      model: model.id,
      displayName: model.displayName,
      dispatchable: true,
      state: availability.state,
      evidence: outcome.lastSuccessAt ? "observed-run" : measured.evidence,
      remainingPercent: measured.remainingPercent,
      resetAt: availability.resetAt,
      capabilities: profile.capabilities,
      quality: profile.quality,
      speed: profile.speed,
      cost: profile.cost,
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

function formatResourceInventory(args = {}, context = {}, candidates = buildResourceCandidates(args, context)) {
  const horizonHours = Math.max(1, Math.min(12, Number(args.horizonHours || 5)));
  const lines = [
    "AiMobileResourceInventory:",
    `GeneratedAtUtc: ${utcStamp()}`,
    `HorizonHours: ${horizonHours}`,
    `Evidence: ${context.capacityProbe}`,
    "Software:",
    `- Codex: catalog=${context.codexCatalog?.found === true}; client=${context.codexCatalog?.clientVersion || "unknown"}; current-model/limits=caller-visible-only`,
    `- Claude Code: found=${context.claudeFound}; version=${context.claudeVersion || "unknown"}; plan=${context.claudeAuth?.subscriptionType || "unknown"}; usage-windows=${context.claudeUsage?.windows?.length || 0}`,
    `- Antigravity: cli=${context.agyFound}; cli-version=${context.agyVersion || "unknown"}; desktop-live=${context.antigravityLiveReady}; live-models=${(context.rawLimits?.Models || []).filter((model) => model.DisplayName).length}`,
    `- Cursor: ui=${context.cursorUiFound}; headless-agent=${context.cursorHeadlessFound}; version=${String(context.cursorUiVersion || "unknown").split(/\r?\n/)[0]}`,
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
    lines.push(`- ${candidate.id} | ${candidate.displayName} | state=${candidate.state}; ${capacity}${reset}; evidence=${candidate.evidence}; dispatchable=${candidate.dispatchable}${policy}`);
  }
  lines.push("ClaudeQuotaWindows:");
  for (const window of context.claudeUsage?.windows || []) {
    lines.push(`- ${window.id}: used=${window.usedPercent}%; remaining=${window.remainingPercent}%; reset=${window.resetAt || window.resetText || "unknown"}; applies=${window.scope}`);
  }
  if (!(context.claudeUsage?.windows || []).length) lines.push("- unknown");
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
    "- Codex capacity is caller-visible only; this plugin cannot read Codex's private token ledger.",
    "- Claude /usage exposes shared and model-specific percentage/reset windows, not raw token allowances. Each model is gated by the most restrictive applicable window.",
    "- Claude aliases are discovered passively. Exact version ids are recorded from real modelUsage telemetry; aliases may advance when Anthropic updates them.",
    "- Antigravity percentage/reset values are measured only while its local service is already running; inventory never opens the UI just to inspect quota.",
    "- Unknown is preserved as unknown. The orchestrator uses success/failure evidence and bounded failover instead of inventing capacity.",
  );
  return lines.join("\n");
}

async function getResourceInventory(args = {}) {
  const context = await getTeamCapacityContext(args);
  const candidates = buildResourceCandidates(args, context);
  return formatResourceInventory(args, context, candidates);
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

function normalizeWorkItem(item, index, fallbackComplexity) {
  const kind = normalizeTaskLane(item.kind || "general") || "general";
  const objective = String(item.objective || "").trim();
  const inferredReadOnly = !/(implementation|implement|patch|fix|debug|migration|refactor)/.test(kind);
  return {
    id: normalizeTaskLane(item.id || `work-${index + 1}`) || `work-${index + 1}`,
    objective: objective || `Complete work item ${index + 1}`,
    kind,
    complexity: normalizeComplexity(item.complexity, fallbackComplexity),
    requiredCapabilities: [...new Set([
      ...capabilitiesForWorkItem(kind, objective),
      ...(Array.isArray(item.requiredCapabilities) ? item.requiredCapabilities.map(normalizeTaskLane).filter(Boolean) : []),
    ])],
    dependsOn: Array.isArray(item.dependsOn) ? item.dependsOn.map(normalizeTaskLane).filter(Boolean) : [],
    expectedFiles: Array.isArray(item.expectedFiles) ? item.expectedFiles.map((value) => String(value || "").trim()).filter(Boolean).slice(0, 20) : [],
    readOnly: typeof item.readOnly === "boolean" ? item.readOnly : inferredReadOnly,
    preferredPlatform: normalizeTaskLane(item.preferredPlatform || ""),
    acceptanceCriteria: Array.isArray(item.acceptanceCriteria) ? item.acceptanceCriteria.map((value) => String(value || "").trim()).filter(Boolean).slice(0, 4) : [],
    verification: Array.isArray(item.verification) ? item.verification.map((value) => String(value || "").trim()).filter(Boolean).slice(0, 4) : [],
    priority: Math.max(0, Math.min(100, Number(item.priority ?? 50))),
    state: "pending",
    failoverCount: 0,
  };
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
    if (fallbackComplexity !== "low") {
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
  return unique.map((item) => ({ ...item, dependsOn: item.dependsOn.filter((id) => validIds.has(id) && id !== item.id) }));
}

function requiredQuality(complexity) {
  return { low: 55, medium: 68, high: 82, critical: 90 }[normalizeComplexity(complexity)] || 68;
}

function hoursUntil(value) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? Math.max(0, (timestamp - Date.now()) / (60 * 60 * 1000)) : null;
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
    && resetHours <= horizon;
}

function scoreResourceForWorkItem(candidate, item, args = {}, primaryWriterId = "") {
  if (!candidate.dispatchable || candidate.state !== "available") return Number.NEGATIVE_INFINITY;
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
  if (candidate.evidence === "observed-run" || candidate.evidence === "measured-live") score += 7;
  if ((candidate.outcome?.successfulKinds || []).includes(item.kind)) score += 8;
  score -= Math.min(24, Math.max(0, Number(candidate.outcome?.consecutiveFailures || 0)) * 8);
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
  const capacityOpportunity = premiumCapacityOpportunity(candidate, item, args);
  const premiumWork = item.complexity === "critical"
    || capacityOpportunity
    || /security|incident|production|migration|release|irreversible|adversarial/.test(`${item.kind} ${item.objective}`.toLowerCase());
  const isFable = candidate.platform === "claude" && /fable/i.test(`${candidate.model} ${candidate.displayName}`);
  const fableRequested = normalizedModelText(args.claudeModel || "").includes("fable");
  if (isFable) {
    if (args.allowPremiumModels !== true && !fableRequested && !capacityOpportunity) score -= 1000;
  } else if (candidate.platform === "claude" && candidate.premium && args.allowPremiumModels !== true && !premiumWork) {
    score -= 1000;
  }
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
  if (!microTask && platformFailures > platformSuccesses) {
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

function buildResourceOrchestrationDecision(args = {}, context = {}) {
  const candidates = buildResourceCandidates(args, context);
  const workItems = buildGoalWorkGraph(args);
  const writable = workItems.filter((item) => !item.readOnly).sort((a, b) => b.priority - a.priority);
  let primaryWriterId = "";
  if (writable.length) {
    primaryWriterId = rankResourcesForWorkItem(candidates, writable[0], args)[0]?.candidate.id || "";
  }

  const decisions = [];
  const assignedItems = workItems.map((item) => {
    const ranked = rankResourcesForWorkItem(candidates, item, args, primaryWriterId);
    let selected = ranked[0];
    if (!item.readOnly && primaryWriterId) selected = ranked.find((row) => row.candidate.id === primaryWriterId) || selected;
    const assignment = selected?.candidate || null;
    const alternates = selectAlternateResourceIds(ranked, assignment, 3);
    const reason = assignment
      ? `capability/quality/capacity score ${selected.score}; ${assignment.evidence}; ${resourceCapacityReason(assignment, item, args)}; ${item.readOnly ? "independent read-only work" : "single workspace writer"}`
      : "no dispatchable resource currently satisfies the work item";
    decisions.push({
      workItemId: item.id,
      resourceId: assignment?.id || "codex:current",
      model: assignment?.model || context.codexModel,
      score: selected?.score ?? null,
      reason,
      alternates,
    });
    return {
      ...item,
      assignment: assignment?.id || "codex:current",
      assignedModel: assignment?.model || (assignment?.platform === "claude" ? String(args.claudeModel || "sonnet") : context.codexModel),
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
  const decision = buildResourceOrchestrationDecision(args, context);
  const resources = new Map(decision.candidates.map((candidate) => [candidate.id, candidate]));
  const dispatchable = decision.candidates.filter((candidate) => candidate.dispatchable && candidate.state === "available");

  return [
    "AiMobileResourceOrchestrationPlan:",
    `Goal: ${goal || "<missing>"}`,
    `Workspace: ${workspace || "<missing>"}`,
    `HorizonHours: ${horizonHours}`,
    `OperatingMode: ${dispatchable.length ? "goal-driven-team" : "codex-only-until-workers-available"}`,
    "Orchestrator: Codex owns goal interpretation, risk, feedback, integration, and final verification; workers own bounded execution.",
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
    "2. Dispatch dependency-ready work; keep one writer per workspace and parallelize independent read-only scouts/reviewers.",
    "3. Read compact artifacts and per-run telemetry, then continue dependent work automatically within the bounded wait.",
    "4. On quota, outage, timeout, auth, or model failure, cool down that resource and fail over the narrow work item once.",
    "5. Codex critiques worker output, requests a narrow correction when needed, integrates the accepted result, and performs final verification.",
    "6. Persist only compact decision/outcome evidence so the next run benefits from project continuity.",
    "",
    "NextCall:",
    "Use orchestrate-project with this goal/work graph. Existing run-team-task callers are routed through the same orchestrator.",
  ].filter(Boolean).join("\n");
}

async function buildTeamOrchestrationPlan(args = {}) {
  const context = await getTeamCapacityContext(args);
  return formatTeamOrchestrationPlan(args, context);
}

function actionSummary(action, toolName, workspace, lane = {}) {
  const jobId = valueFromResult(action, "JobId");
  const started = /\bStarted:\s*true\b/i.test(action) || /\bState:\s*running\b/i.test(action);
  const failed = /\bState:\s*failed\b/i.test(action) || /\bBlocker:/i.test(action);
  return {
    toolName,
    laneId: lane.id || toolName,
    worker: lane.worker || toolName,
    assignedTasks: lane.assignedTasks || [],
    model: lane.model || "",
    jobId,
    started: started && !failed,
    failed,
    readBack: jobId ? `ai-mobile-local.read-job with workspace=${workspace} and jobId=${jobId}` : "no JobId returned",
    action,
  };
}

function candidateFromManifest(manifest, resourceId) {
  return (manifest.resources || []).find((candidate) => candidate.id === resourceId) || null;
}

function workItemBrief(items) {
  return items.map((item) => {
    const files = item.expectedFiles?.length ? `; file boundary: ${item.expectedFiles.join(", ")}` : "";
    const acceptance = item.acceptanceCriteria?.length ? `; accept when: ${item.acceptanceCriteria.join(" | ")}` : "";
    const verification = item.verification?.length ? `; verify: ${item.verification.join(" | ")}` : "";
    return `- ${item.id} [${item.kind}, ${item.complexity}, readOnly=${item.readOnly}]: ${item.objective}${files}${acceptance}${verification}`;
  }).join("\n");
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

function launchOrchestrationGroup(manifest, resource, items, failoverOf = "") {
  const workspace = manifest.workspace;
  const readOnly = items.every((item) => item.readOnly);
  const mode = readOnly ? "review" : (manifest.mode || "patch");
  const complexityRank = Math.max(...items.map((item) => ({ low: 1, medium: 2, high: 3, critical: 4 }[item.complexity] || 2)));
  const maxResultBullets = resultBulletLimitForComplexity(complexityRank);
  const contextCharacterLimit = contextCharacterLimitForComplexity(complexityRank);
  const goal = [
    manifest.goal,
    "",
    `ResourceOrchestratorRun: ${manifest.runId}`,
    `AssignedResource: ${resource.team} / ${resource.displayName}`,
    "Assigned work items:",
    workItemBrief(items),
    "",
    "Coordinate against the common goal, stay inside these work items, and produce the required compact artifacts. Do not duplicate another worker's file ownership.",
  ].join("\n");
  const nextStep = [
    `Complete only work items: ${items.map((item) => item.id).join(", ")}.`,
    readOnly ? "Inspect and critique only; do not edit project files." : "Make one coherent narrow implementation and run targeted verification.",
    `State assumptions and blockers explicitly. Read only focused context up to ${contextCharacterLimit} characters. Keep result.md to ${maxResultBullets} bullets or fewer. Accept work only against the stated criteria and verification checks.`,
  ].join(" ");
  const expectedFiles = [...new Set(items.flatMap((item) => item.expectedFiles || []))];
  let action = "";
  let toolName = "";

  if (resource.platform === "claude") {
    toolName = "submit-claude-job";
    action = submitClaudeJob({
      goal,
      workspace,
      mode,
      nextStep,
      model: items[0]?.assignedModel || resource.model || "sonnet",
      permissionMode: readOnly ? "plan" : "acceptEdits",
      effort: complexityRank >= 4 ? "high" : complexityRank === 3 ? "medium" : "low",
      maxMinutes: complexityRank >= 4 ? 20 : complexityRank === 3 ? 10 : complexityRank === 2 ? 5 : 3,
      resourceId: resource.id,
      workItemKinds: items.map((item) => item.kind),
      expectedFiles,
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
      maxMinutes: complexityRank >= 4 ? 30 : complexityRank === 3 ? 20 : complexityRank === 2 ? 10 : 5,
      printTimeout: complexityRank >= 3 ? "8m" : complexityRank === 2 ? "4m" : "2m",
      resourceId: resource.id,
      workItemKinds: items.map((item) => item.kind),
      expectedFiles,
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
      resourceId: resource.id,
      workItemKinds: items.map((item) => item.kind),
      expectedFiles,
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
      assignedTasks: items.map((item) => item.id),
      workItemIds: items.map((item) => item.id),
      model: summary.model,
      jobId: summary.jobId,
      state: summary.failed ? "failed" : summary.started ? "running" : "queued",
      failoverOf,
      failoverDepth: failoverOf ? 1 : 0,
    },
  };
}

function failureCategoryFromText(value) {
  const text = String(value || "").toLowerCase();
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
  if (items.some((item) => ["running", "pending"].includes(item.state))) return "running";
  if (items.every((item) => ["completed", "codex"].includes(item.state))) return "ready-for-codex";
  if (items.some((item) => item.state === "blocked")) return "blocked";
  if (items.some((item) => item.state === "completed")) return "partial";
  return "failed";
}

function syncWorkItemsFromJobs(manifest) {
  if (Number(manifest.version || 1) < 2 || !Array.isArray(manifest.workItems)) return manifest;
  const jobs = manifest.jobs || [];
  const workItems = manifest.workItems.map((item) => {
    const matching = jobs.filter((job) => (job.workItemIds || job.assignedTasks || []).includes(item.id));
    const latest = matching[matching.length - 1];
    if (!latest) return item;
    if (["queued", "running", "unknown"].includes(latest.state)) return { ...item, state: "running", activeJobId: latest.jobId, failureCategory: "", blocker: "" };
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

function advanceOrchestrationRun(workspace, suppliedManifest, lockHeld = false, launchGroup = launchOrchestrationGroup) {
  if (!lockHeld) {
    return withFileLock(lastTeamRunJsonPath(workspace), () => {
      const latest = readJsonFile(lastTeamRunJsonPath(workspace), suppliedManifest) || suppliedManifest;
      const refreshed = refreshTeamRunManifest(workspace, latest);
      return advanceOrchestrationRun(workspace, refreshed, true, launchGroup);
    });
  }
  let manifest = syncWorkItemsFromJobs(suppliedManifest);
  if (Number(manifest.version || 1) < 2) return manifest;

  let changed = false;
  manifest.resources = (manifest.resources || []).map((resource) => {
    const cooldownUntil = Date.parse(String(resource.cooldownUntil || ""));
    if (resource.state === "cooldown" && Number.isFinite(cooldownUntil) && cooldownUntil <= Date.now()) {
      changed = true;
      return { ...resource, state: "available", cooldownUntil: "", evidence: "cooldown-expired" };
    }
    return resource;
  });
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
    return {
      ...item,
      state: "pending",
      assignment: alternate.id,
      assignedModel: alternate.model,
      failoverCount: 1,
      activeJobId: "",
      failureCategory: "",
      blocker: "",
      decisionReason: `Failover from ${latestJob?.resourceId || item.assignment} after ${item.failureCategory}.`,
    };
  });
  manifest = { ...manifest, workItems: recoveredItems };

  let currentById = new Map(manifest.workItems.map((item) => [item.id, item]));
  manifest.workItems = manifest.workItems.map((item) => {
    if (item.state !== "blocked" || !String(item.blocker || "").startsWith("Dependency ")) return item;
    const dependenciesRecoveringOrComplete = item.dependsOn.every((id) => ["pending", "running", "completed", "codex"].includes(currentById.get(id)?.state));
    if (!dependenciesRecoveringOrComplete) return item;
    changed = true;
    return { ...item, state: "pending", blocker: "" };
  });
  currentById = new Map(manifest.workItems.map((item) => [item.id, item]));
  manifest.workItems = manifest.workItems.map((item) => {
    if (item.state !== "pending") return item;
    const failedDependency = item.dependsOn.find((id) => ["failed", "blocked"].includes(currentById.get(id)?.state));
    if (!failedDependency) return item;
    changed = true;
    return { ...item, state: "blocked", blocker: `Dependency ${failedDependency} did not complete.` };
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
      manifest.workItems = manifest.workItems.map((item) => items.some((candidate) => candidate.id === item.id)
        ? { ...item, state: "blocked", blocker: `Assigned resource ${resourceId} is not dispatchable.` }
        : item);
      changed = true;
      continue;
    }
    const activeWriter = (manifest.jobs || []).some((job) => ["queued", "running", "unknown"].includes(job.state)
      && (job.workItemIds || []).some((id) => manifest.workItems.find((item) => item.id === id && !item.readOnly)));
    if (activeWriter && items.some((item) => !item.readOnly)) continue;
    const failedItemJob = [...(manifest.jobs || [])].reverse().find((job) => items.some((item) => (job.workItemIds || []).includes(item.id)) && job.state === "failed");
    const launch = launchGroup(manifest, resource, items, failedItemJob?.jobId || "");
    if (!launch.launched) {
      manifest.workItems = manifest.workItems.map((item) => items.some((candidate) => candidate.id === item.id)
        ? { ...item, state: "failed", blocker: launch.blocker || "Worker launch failed.", failureCategory: "worker-failure" }
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

function refreshTeamRunManifest(workspace, suppliedManifest = null) {
  const manifestPath = lastTeamRunJsonPath(workspace);
  const manifest = suppliedManifest || readJsonFile(manifestPath, null);
  if (!manifest || !Array.isArray(manifest.jobs)) {
    throw new Error(`No team run manifest found at ${manifestPath}. Start run-team-task first.`);
  }

  const jobs = manifest.jobs.map((job) => {
    if (!job.jobId) return { ...job, state: "failed", currentStep: "missing-job-id", blocker: "Worker launch did not return a JobId." };
    const jobDir = jobDirFor(workspace, job.jobId);
    const statusPath = path.join(jobDir, "status.json");
    if (!fs.existsSync(statusPath)) return { ...job, state: "failed", currentStep: "missing-status", blocker: "status.json is missing." };
    const repair = repairStaleRunningJob(workspace, job.jobId, jobDir, readJsonFile(statusPath, {}));
    const telemetry = readJsonFile(path.join(jobDir, "worker-telemetry.json"), null);
    const telemetryFailureCategory = telemetry?.success === false ? String(telemetry.failureCategory || "worker-failure") : "";
    return {
      ...job,
      state: repair.status.state || "unknown",
      currentStep: repair.status.currentStep || "",
      blocker: repair.status.blocker || "",
      warning: repair.status.warning || "",
      failureCategory: telemetryFailureCategory || repair.status.failureCategory || failureCategoryFromText(`${repair.status.currentStep || ""} ${repair.status.blocker || ""}`),
      observedModel: String(telemetry?.observedModel || repair.status.observedModel || job.observedModel || ""),
      workerPid: repair.status.workerPid || job.workerPid || null,
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

async function waitForTeamRun(workspace, waitSeconds = 0, suppliedManifest = null) {
  const boundedWait = Math.max(0, Math.min(300, Number(waitSeconds || 0)));
  const deadline = Date.now() + (boundedWait * 1000);
  let snapshot = advanceOrchestrationRun(workspace, refreshTeamRunManifest(workspace, suppliedManifest));
  while (snapshot.state === "running" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000, Math.max(100, deadline - Date.now()))));
    snapshot = advanceOrchestrationRun(workspace, refreshTeamRunManifest(workspace));
  }
  return snapshot;
}

function formatTeamRunSnapshot(workspace, snapshot, waitedSeconds = 0) {
  const orchestrated = Number(snapshot.version || 1) >= 2;
  const lines = [
    orchestrated ? "AiMobileResourceOrchestrationRun:" : "AiMobileTeamRun:",
    `State: ${snapshot.state}`,
    `Workspace: ${workspace}`,
    `WaitedSeconds: ${waitedSeconds}`,
    `Jobs: ${snapshot.counts?.total || 0}; completed=${snapshot.counts?.completed || 0}; running=${snapshot.counts?.running || 0}; failed=${snapshot.counts?.failed || 0}`,
    orchestrated ? "WorkGraph:" : null,
    ...(orchestrated ? (snapshot.workItems || []).map((item) => `- ${item.id}: ${item.state}; resource=${item.assignment}; model=${item.assignedModel}; dependsOn=${item.dependsOn.join(",") || "none"}${item.failureCategory ? `; failure=${item.failureCategory}` : ""}`) : []),
    "WorkerResults:",
  ].filter(Boolean);

  for (const [index, job] of snapshot.jobs.entries()) {
    const jobDir = jobDirFor(workspace, job.jobId);
    const workItemIds = job.workItemIds || job.assignedTasks || [];
    const supersededBySuccess = ["failed", "cancelled"].includes(job.state)
      && snapshot.jobs.slice(index + 1).some((later) => later.state === "completed"
        && (later.workItemIds || later.assignedTasks || []).some((id) => workItemIds.includes(id)));
    const result = summarizeFile(path.join(jobDir, "result.md"), 1200).trim();
    const changed = summarizeFile(path.join(jobDir, "changed-files.txt"), 500).trim();
    const tests = summarizeFile(path.join(jobDir, "test-output-summary.md"), 600).trim();
    const telemetry = readJsonFile(path.join(jobDir, "worker-telemetry.json"), null);
    lines.push(`${index + 1}. ${job.laneId || job.toolName} | ${job.state} | ${job.jobId} | model=${job.model || "default"}`);
    lines.push(`   Assigned: ${(job.assignedTasks || []).join(", ") || "unspecified"}`);
    if (job.blocker) lines.push(`   Blocker: ${truncateText(job.blocker, 300)}`);
    if (job.warning && !supersededBySuccess) lines.push(`   Warning: ${truncateText(job.warning, 300)}`);
    if (telemetry) lines.push(`   Telemetry: provider=${telemetry.provider || "unknown"}; observedModel=${telemetry.observedModel || "unknown"}; durationMs=${telemetry.durationMs ?? "unknown"}; inputTokens=${telemetry.inputTokens ?? "unknown"}; outputTokens=${telemetry.outputTokens ?? "unknown"}; category=${telemetry.failureCategory || "none"}`);
    if (supersededBySuccess) lines.push("   Recovered: a later failover completed this work item; use read-job only if the failed attempt needs diagnosis.");
    if (result && !supersededBySuccess) lines.push(`   Result: ${result.replace(/\s*\n\s*/g, " ")}`);
    if (changed && !/^NONE$/i.test(changed) && !supersededBySuccess) lines.push(`   Changed: ${changed.replace(/\s*\n\s*/g, ", ")}`);
    if (tests && !supersededBySuccess) lines.push(`   Tests: ${tests.replace(/\s*\n\s*/g, " ")}`);
  }

  if (snapshot.state === "ready-for-codex") lines.push("Next: Codex must critique and integrate the compact worker artifacts, run targeted final verification, and only then claim the goal complete.");
  else if (snapshot.state === "completed") lines.push("Next: Codex should perform targeted integration verification; all worker jobs completed successfully.");
  else if (snapshot.state === "running") lines.push(`Next: call read-team-run for ${workspace}; completion is not yet claimed.`);
  else lines.push("Next: inspect only failed/partial jobs with read-job, reassign their narrow lanes, and do not claim team completion.");
  return lines.join("\n");
}

async function readTeamRun(args = {}) {
  const workspace = safeWorkspacePath(args.workspace);
  const waitSeconds = Math.max(0, Math.min(300, Number(args.waitSeconds || 0)));
  const snapshot = await waitForTeamRun(workspace, waitSeconds);
  const output = formatTeamRunSnapshot(workspace, snapshot, waitSeconds);
  writeTextFileEnsuringDir(path.join(bridgeRootFor(workspace), "last-team-run.md"), `${output}\n`);
  return output;
}

async function orchestrateProject(args = {}) {
  const workspace = safeWorkspacePath(args.workspace);
  const goal = String(args.goal || "").trim();
  if (!goal) throw new Error("orchestrate-project requires a non-empty goal.");
  const context = await getTeamCapacityContext({ ...args, workspace });
  const decision = buildResourceOrchestrationDecision(args, context);
  const plan = formatTeamOrchestrationPlan(args, context);

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
  const workItems = decision.workItems.map((item) => ({
    ...item,
    state: item.assignment === "codex:current" ? "codex" : "pending",
  }));
  const manifest = {
    version: 2,
    runId,
    createdAt: utcStamp(),
    goal,
    workspace,
    mode: String(args.mode || "patch").trim().toLowerCase(),
    horizonHours: Math.max(1, Math.min(12, Number(args.horizonHours || 5))),
    capacityProbe: context.capacityProbe,
    codexRole: "goal owner, resource orchestrator, critic, integration owner, and final verifier",
    primaryWriterId: decision.primaryWriterId,
    resources: decision.candidates,
    decisions: decision.decisions.map((item) => ({ at: utcStamp(), type: "assignment", ...item })),
    workItems,
    state: "running",
    jobs: [],
  };
  withFileLock(lastTeamRunJsonPath(workspace), () => {
    const existingManifestPath = lastTeamRunJsonPath(workspace);
    if (fs.existsSync(existingManifestPath)) {
      const existing = refreshTeamRunManifest(workspace, readJsonFile(existingManifestPath, null));
      if (existing.state === "running") {
        throw new Error(`Workspace already has active orchestration run ${existing.runId || "<legacy>"}. Use read-team-run or cancel its running jobs before starting another run.`);
      }
    }
    writeTeamRunManifest(workspace, manifest);
  });
  persistOrchestrationDecision(workspace, goal, decision);

  const waitSeconds = Math.max(0, Math.min(300, Number(args.waitSeconds ?? 30)));
  const snapshot = await waitForTeamRun(workspace, waitSeconds, manifest);
  const compactResult = formatTeamRunSnapshot(workspace, snapshot, waitSeconds);
  const output = [
    "OrchestrateProjectResult:",
    `RunId: ${runId}`,
    `Goal: ${goal}`,
    `CapacityProbe: ${context.capacityProbe}`,
    `WorkItems: ${workItems.length}`,
    `ExternalResourcesSelected: ${[...new Set(workItems.filter((item) => item.assignment !== "codex:current").map((item) => item.assignment))].length}`,
    `WaitSeconds: ${waitSeconds}`,
    "CodexRole: understand, direct, critique, integrate, and verify; do not duplicate delegated broad work.",
    "",
    compactResult,
  ].join("\n");
  const finalOutput = args.includePlan === true ? `${plan}\n\n${output}` : output;
  writeTextFileEnsuringDir(path.join(bridgeRootFor(workspace), "last-team-run.md"), `${finalOutput}\n`);
  return finalOutput;
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

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`);
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    fs.renameSync(tempPath, filePath);
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
      if (error?.code !== "EEXIST") throw error;
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
    "Codex will read only result.md, changed-files.txt, diff.patch, test-output-summary.md, and status.json.",
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
  };
  fs.writeFileSync(path.join(jobDir, "request.md"), `${request}\n`, "utf8");
  writeJsonFile(path.join(jobDir, "status.json"), status);
  for (const file of ["result.md", "changed-files.txt", "diff.patch", "test-output-summary.md"]) {
    const target = path.join(jobDir, file);
    if (!fs.existsSync(target)) fs.writeFileSync(target, "", "utf8");
  }
  const gitBaseline = collectGitState(workspace);
  writeJsonFile(path.join(jobDir, "git-baseline.json"), {
    available: gitBaseline.available,
    status: gitBaseline.status,
    diffHash: crypto.createHash("sha256").update(gitBaseline.diff).digest("hex"),
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
  status.state = "cancelled";
  status.updatedAt = utcStamp();
  status.currentStep = "cancelled";
  status.bridgeFinalized = true;
  status.blocker = String(args.reason || "Cancelled by Codex.").trim();
  status.processTermination = termination;
  writeJsonFile(statusPath, status);
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
    .map((line) => line.length > 3 ? line.slice(3).trim() : "")
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
    if (alias) {
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
  const observedModels = Object.keys(parsed.modelUsage || {});
  const usage = parsed.usage || {};
  return {
    parsed,
    resultText: String(parsed.result || parsed.message || "").trim(),
    observedModel: observedModels[0] || "",
    durationMs: Number(parsed.duration_ms ?? parsed.durationMs),
    inputTokens: Number(usage.input_tokens ?? usage.inputTokens),
    cacheCreationInputTokens: Number(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens),
    cacheReadInputTokens: Number(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens),
    outputTokens: Number(usage.output_tokens ?? usage.outputTokens),
    reportedCostUsdEquivalent: Number(parsed.total_cost_usd ?? parsed.totalCostUsd),
    isError: parsed.is_error === true || parsed.subtype === "error",
  };
}

function finalizeWorkerGitArtifacts(workspace, jobDir, mode) {
  const current = collectGitState(workspace);
  const baseline = readJsonFile(path.join(jobDir, "git-baseline.json"), null);
  const currentHash = crypto.createHash("sha256").update(current.diff).digest("hex");
  const baselinePaths = new Set(pathsFromGitStatus(baseline?.status || ""));
  const changedDuringRun = pathsFromGitStatus(current.status).filter((file) => !baselinePaths.has(file));
  const reviewMutationDetected = String(mode || "").toLowerCase() === "review"
    && current.available
    && baseline?.available
    && (baseline.status !== current.status || baseline.diffHash !== currentHash);

  if (String(mode || "").toLowerCase() === "review") {
    fs.writeFileSync(
      path.join(jobDir, "changed-files.txt"),
      reviewMutationDetected ? "UNATTRIBUTED_WORKSPACE_CHANGE_DURING_REVIEW\n" : "NONE\n",
      "utf8",
    );
    fs.writeFileSync(path.join(jobDir, "diff.patch"), "", "utf8");
    return { reviewMutationDetected, reviewWorkspaceChanged: reviewMutationDetected, changedDuringRun };
  }
  writeGitArtifacts(workspace, jobDir, current);
  return { reviewMutationDetected, changedDuringRun };
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

function runClaudeCli(command, args, options = {}) {
  const safeArgs = args.map((arg) => String(arg));
  if (process.platform === "win32") {
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
    const where = spawnSync("where.exe", ["claude"], { encoding: "utf8", timeout: 10000, windowsHide: true });
    for (const line of String(where.stdout || "").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) candidates.push(trimmed);
    }
    candidates.sort((a, b) => Number(!a.toLowerCase().endsWith(".cmd")) - Number(!b.toLowerCase().endsWith(".cmd")));
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
      return { found: true, command: candidate, version: check.stdout || check.stderr };
    }
  }
  return { found: false, command: "", version: "", message: "Claude Code CLI was not found on PATH." };
}

function getClaudeStatusText() {
  const status = findClaudeCode();
  return [
    "ClaudeCodeStatus:",
    `Found: ${status.found}`,
    `Command: ${status.command || "<not found>"}`,
    `Version: ${status.version || "<unknown>"}`,
    "SupportedBridge: headless Claude Code CLI via claude -p",
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
  if (args.sandbox !== false) cliArgs.push("--sandbox");
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
  const observedModel = inferAgyObservedModel(stdout, args.model || "");
  const modelMismatch = Boolean(args.model && observedModel && normalizedModelText(args.model) !== normalizedModelText(observedModel));
  const failed = executionFailed || !boundary.ok || !quality.ok;
  const failureCategory = !boundary.ok
    ? "scope-violation"
    : executionFailed
      ? failureCategoryFromText(`${result.error?.message || ""} ${stderr} ${stdout}`)
      : !quality.ok ? "insufficient-result" : "";
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
    printTimeout: args.printTimeout || "5m",
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

function buildClaudeJobPrompt(workspace, jobId, args = {}) {
  const jobDir = jobDirFor(workspace, jobId);
  const request = summarizeFile(path.join(jobDir, "request.md"), 12000);
  const maxResultBullets = boundedResultBulletLimit(args, 8);
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
  const maxMinutes = Math.max(1, Math.min(180, Number(args.maxMinutes || 10)));
  const prompt = buildClaudeJobPrompt(workspace, jobId, { ...args, permissionMode });
  const cliArgs = [
    "-p",
    "--output-format",
    "json",
    "--permission-mode",
    permissionMode,
  ];
  if (permissionMode === "plan") cliArgs.push("--tools", "Read,Grep,Glob");
  const dispatchModel = normalizeClaudeDispatchModel(args.model);
  if (dispatchModel) cliArgs.push("--model", safeClaudeFlag(dispatchModel, "model"));
  if (args.effort) cliArgs.push("--effort", safeClaudeFlag(args.effort, "effort"));
  if (args.fallbackModel) cliArgs.push("--fallback-model", safeClaudeFlag(args.fallbackModel, "fallbackModel"));
  if (args.maxBudgetUsd !== undefined && args.maxBudgetUsd !== null && String(args.maxBudgetUsd).trim() !== "") {
    const budget = Number(args.maxBudgetUsd);
    if (!Number.isFinite(budget) || budget <= 0) throw new Error("maxBudgetUsd must be a positive number.");
    cliArgs.push("--max-budget-usd", String(budget));
  }

  updateJobStatus(workspace, jobId, {
    state: "running",
    worker: "claude-code",
    currentStep: "claude-code-running",
    startedAt: utcStamp(),
    claudeCommand: path.basename(status.command),
    claudeVersion: status.version,
    claudeModel: args.model || "",
    claudePermissionMode: permissionMode,
  });

  const startedMs = Date.now();
  const result = runClaudeCli(status.command, cliArgs, {
    cwd: workspace,
    input: prompt,
    timeout: maxMinutes * 60 * 1000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const descendantCleanup = result.error?.code === "ETIMEDOUT" ? terminateDescendantProcesses(process.pid) : null;

  const stdout = String(result.stdout || "");
  const stderr = String(result.stderr || "");
  const parsedOutput = parseClaudeJsonOutput(stdout);
  fs.writeFileSync(path.join(jobDir, "claude-output.txt"), truncateText(stdout, 80000), "utf8");
  fs.writeFileSync(path.join(jobDir, "claude-error.txt"), truncateText(stderr, 30000), "utf8");

  const resultPath = path.join(jobDir, "result.md");
  if (!fs.existsSync(resultPath) || fs.readFileSync(resultPath, "utf8").trim() === "") {
    fs.writeFileSync(resultPath, compactResultBullets(parsedOutput.resultText || stderr || "<Claude Code produced no output>", boundedResultBulletLimit(args, 8), resultCharacterLimit(args, 8)), "utf8");
  }
  const compactClaudeResult = compactResultArtifact(resultPath, args, 8);

  writeAuthoritativeExecutionSummary(jobDir, "claude-code", result, stderr);
  const gitOutcome = finalizeWorkerGitArtifacts(workspace, jobDir, mode);
  const boundary = validateWorkerFileBoundary(args, gitOutcome);
  const executionFailed = result.status !== 0 || Boolean(result.error) || parsedOutput.isError;
  const quality = executionFailed ? { ok: true, reason: "" } : validateWorkerResult(summarizeFile(resultPath, 8000), args);
  const failed = executionFailed || !boundary.ok || !quality.ok;
  const failureCategory = !boundary.ok
    ? "scope-violation"
    : executionFailed
      ? failureCategoryFromText(`${result.error?.message || ""} ${stderr} ${parsedOutput.resultText || stdout}`)
      : !quality.ok ? "insufficient-result" : "";
  recordWorkerTelemetry(workspace, jobDir, { ...args, resourceId: args.resourceId || "claude:sonnet" }, {
    provider: "claude",
    requestedModel: args.model || "sonnet",
    observedModel: parsedOutput.observedModel,
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
  });
  updateJobStatus(workspace, jobId, {
    state: failed ? "failed" : "completed",
    currentStep: failed ? "claude-code-failed" : "claude-code-completed",
    completedAt: utcStamp(),
    bridgeFinalized: true,
    exitCode: result.status,
    observedModel: parsedOutput.observedModel,
    failureCategory,
    descendantCleanup,
    warning: gitOutcome.reviewWorkspaceChanged ? "Workspace changed during this review, but Claude plan mode could not edit files; no diff was accepted." : "",
    blocker: !boundary.ok
      ? `Worker changed files outside its boundary: ${boundary.violations.join(", ")}`
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
  const quality = executionFailed ? { ok: true, reason: "" } : validateWorkerResult(summarizeFile(resultPath, 8000), args);
  const failed = executionFailed || !boundary.ok || !quality.ok;
  const failureCategory = !boundary.ok
    ? "scope-violation"
    : executionFailed
      ? failureCategoryFromText(`${result.error?.message || ""} ${stderr} ${stdout}`)
      : !quality.ok ? "insufficient-result" : "";
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
    "Codex follow-up: do not read the Antigravity chat. Later call read-job for result.md, changed-files.txt, diff.patch, test-output-summary.md, and status.json.",
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
  const passed = [];
  const assert = (condition, name) => {
    if (!condition) throw new Error(`Self-test failed: ${name}`);
    passed.push(name);
  };

  const split = inferTaskSplit("ignored when explicit lanes exist", "UI, backend, testing");
  assert(split.join(",") === "ui,backend,testing", "explicit task split is preserved");
  assert(teamStateFromJobs([{ state: "completed" }, { state: "running" }]) === "running", "running team never reports completion");
  assert(teamStateFromJobs([{ state: "completed" }, { state: "failed" }]) === "partial", "mixed terminal team reports partial");
  const roster = parseAgyModelRoster("Gemini 3.5 Flash (Medium)\nClaude Opus 4.6 (Thinking)\n");
  assert(roster.length === 2 && roster[0].id === "gemini-3.5-flash-medium", "Antigravity model roster is parsed without starting its UI");
  const claudeRoster = parseClaudeModelRoster("Provide an alias such as 'fable', 'opus', or 'sonnet'. Full name: claude-fable-5");
  assert(claudeRoster.some((model) => model.id === "fable" && model.resolvedId === "claude-fable-5"), "Claude Fable is discovered from CLI help without starting a job");
  assert(claudeRoster.some((model) => model.id === "haiku"), "Claude Haiku remains available even when CLI help omits its alias");
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
  const orchestrationDecision = buildResourceOrchestrationDecision({
    goal: "Implement and verify a cross-platform resource orchestrator plugin",
    mode: "patch",
    workItems: [
      { id: "implement", objective: "Implement the orchestration control loop", kind: "implementation-architecture", complexity: "high", readOnly: false },
      { id: "verify", objective: "Independently verify failure handling", kind: "testing-review", complexity: "medium", readOnly: true, dependsOn: ["implement"] },
    ],
  }, fakeContext);
  assert(orchestrationDecision.workItems.find((item) => item.id === "implement")?.assignment === "claude:sonnet", "high-value implementation selects Claude Sonnet as the single writer");
  assert(orchestrationDecision.workItems.find((item) => item.id === "verify")?.assignment.startsWith("antigravity:"), "independent verification selects a different available team");
  assert(orchestrationDecision.workItems.find((item) => item.id === "verify")?.alternates.includes("claude:sonnet"), "failover pool keeps a cross-platform alternate even when one provider has many models");
  const routineDecision = buildResourceOrchestrationDecision({
    goal: "Draft a routine project review",
    mode: "review",
    workItems: [{ id: "routine", objective: "Review the current implementation", kind: "review", complexity: "medium", readOnly: true }],
  }, fakeContext);
  assert(routineDecision.workItems[0]?.assignment !== "claude:fable", "routine work never selects premium Claude Fable");
  const criticalDecision = buildResourceOrchestrationDecision({
    goal: "Resolve a production incident safely",
    mode: "patch",
    workItems: [{ id: "incident", objective: "Resolve a production incident with adversarial verification", kind: "incident-debugging", complexity: "critical", readOnly: false }],
  }, fakeContext);
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
    workItems: [{ id: "broad-review", objective: "Review current project health and report the main blocker", kind: "verification-review", complexity: "low", readOnly: true, preferredPlatform: "antigravity" }],
  }, fakeContext);
  assert(broadReviewDecision.workItems[0]?.assignment === "antigravity:gemini-3.5-flash-medium", "broad low-risk review prefers Flash Medium over Flash Low");
  const microReviewDecision = buildResourceOrchestrationDecision({
    goal: "Read one manifest value",
    mode: "review",
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
  assert([1, 2, 3, 4].map(resultBulletLimitForComplexity).join(",") === "5,6,8,10", "result bullet budgets scale with work-item complexity");
  assert(deriveOrchestrationState({ workItems: [{ state: "completed" }, { state: "codex" }] }) === "ready-for-codex", "worker completion still requires Codex integration");
  assert(deriveOrchestrationState({ workItems: [{ state: "blocked" }, { state: "failed" }] }) === "blocked", "dependency blocks remain distinct from worker failure");
  assert(failureCategoryFromText("429 rate limit exceeded") === "rate-limit", "retryable resource failures are classified for bounded failover");
  const parsedClaude = parseClaudeJsonOutput(JSON.stringify({ result: "ok", duration_ms: 12, usage: { input_tokens: 2, output_tokens: 1 }, modelUsage: { "claude-sonnet-5": {} } }));
  assert(parsedClaude.resultText === "ok" && parsedClaude.observedModel === "claude-sonnet-5", "Claude JSON output yields compact result and per-run model telemetry");
  const flattenedGraph = buildGoalWorkGraph({ goal: "review", workItems: [[{ id: "one", objective: "first" }, { id: "two", objective: "second" }]] });
  assert(flattenedGraph.length === 2, "nested PowerShell work-item arrays are normalized defensively");
  assert(sensitiveArtifactPath("config/.env.production"), "sensitive untracked artifact paths are withheld");
  const credentialSample = ["API", "_KEY=example-sensitive-value"].join("");
  assert(!redactArtifactContent(credentialSample).includes("example-sensitive-value"), "credential-like untracked content is redacted");
  assert(validateWorkerFileBoundary({ expectedFiles: ["scripts"] }, { changedDuringRun: ["scripts/worker.js"] }).ok, "writer changes inside an assigned file boundary pass");
  assert(!validateWorkerFileBoundary({ expectedFiles: ["scripts"] }, { changedDuringRun: ["README.md"] }).ok, "writer changes outside an assigned file boundary fail closed");
  assert(compactResultBullets("- one\n- two\n- three", 2).split(/\r?\n/).length === 2, "worker result readback enforces a compact bullet limit");
  assert(!validateWorkerResult("I am currently running on Gemini 3.5 Flash (Medium).", { goal: "Review transport correctness" }).ok, "model identity alone cannot satisfy an assigned work item");
  assert(validateWorkerResult("- No transport defect found after reviewing both framing paths.\n- Verification covered initialization and tool listing.", { goal: "Review transport correctness", workItemKinds: ["architecture-review"] }).ok, "compact objective-specific review passes the result quality gate");
  assert(inferAgyObservedModel("I am currently running on **Gemini 3.5 Flash (Medium)**.", "gemini-3.5-flash-low") === "gemini-3.5-flash-medium", "Antigravity telemetry records a self-reported model instead of the requested alias");
  const agyPrintArgs = buildAgyCliArgs("EXECUTE-THIS-PROMPT", { model: "gemini-3.5-flash-low", printTimeout: "1m" });
  assert(agyPrintArgs[0] === "--print" && agyPrintArgs[1] === "EXECUTE-THIS-PROMPT", "Antigravity CLI receives the task through the verified long-form print argument");

  const tempRoot = path.resolve(os.tmpdir());
  const workspace = fs.mkdtempSync(path.join(tempRoot, "ai-mobile-self-test-"));
  let sleeper = null;
  try {
    const init = spawnSync("git", ["init", "--quiet", workspace], { encoding: "utf8", timeout: 10000, windowsHide: true });
    assert(init.status === 0, "temporary git workspace initializes");
    const samplePath = path.join(workspace, "sample.txt");
    fs.writeFileSync(samplePath, "before\n", "utf8");
    const created = createJob({ goal: "self-test", workspace, mode: "review", worker: "self-test" });
    const unchanged = finalizeWorkerGitArtifacts(workspace, created.jobDir, "review");
    assert(unchanged.reviewMutationDetected === false, "unchanged review workspace reports no worker diff");
    fs.writeFileSync(samplePath, "after\n", "utf8");
    const changed = finalizeWorkerGitArtifacts(workspace, created.jobDir, "review");
    assert(changed.reviewMutationDetected === true, "review workspace mutation is detected");

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
    assert(!compactSnapshot.includes("Changed: NONE") && compactSnapshot.length < 1800, "aggregate readback omits no-op changed markers and stays compact");
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
    assert(refreshTeamRunManifest(workspace).state === "completed", "aggregate team state reaches completed only after job completion");
    writeTeamRunManifest(workspace, { ...manifest, jobs: [] });
    assert(refreshTeamRunManifest(workspace).state === "blocked", "team with no startable jobs reports blocked");

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
      serverInfo: { name: "ai-mobile-local", version: "0.1.0" },
    });
    return;
  }

  if (method === "notifications/initialized") {
    return;
  }

  if (method === "tools/list") {
    sendResult(id, { tools });
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

if (["self-test-cli", "orchestration-plan-cli", "efficiency-flow-cli", "run-efficient-task-cli", "resource-inventory-cli", "orchestrate-project-cli", "team-orchestration-plan-cli", "run-team-task-cli", "read-team-run-cli", "submit-offload-cli", "switch-model-cli", "select-chat-cli", "create-job-cli", "submit-job-cli", "agy-status-cli", "agy-models-cli", "submit-agy-job-cli", "agy-job-worker-cli", "claude-status-cli", "claude-usage-cli", "submit-claude-job-cli", "claude-job-worker-cli", "cursor-status-cli", "open-cursor-cli", "submit-cursor-job-cli", "cursor-job-worker-cli", "list-jobs-cli", "read-job-cli", "cancel-job-cli", "retry-job-cli"].includes(process.argv[2])) {
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
    "orchestration-plan-cli": buildOrchestrationPlan,
    "efficiency-flow-cli": buildEfficiencyFlow,
    "run-efficient-task-cli": runEfficientTask,
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
