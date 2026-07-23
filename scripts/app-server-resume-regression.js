#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough, Writable } = require("node:stream");
const { runContinuation } = require("./codex-app-server-resume");
const { pluginVersion } = require("./lib/version");
const { runtimeFingerprint } = require("./lib/runtime-identity");

function fakeAppServer(runtimeVersion, runtimeBuildFingerprint, observed, options = {}) {
  return function spawnFake(command, args) {
    observed.command = command;
    observed.args = args;
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    let buffer = "";
    let turnCount = 0;

    function send(message) {
      setImmediate(() => child.stdout.write(JSON.stringify(message) + "\n"));
    }

    function handle(message) {
      if (message.method === "initialized") return;
      if (message.method === "initialize") {
        send({ id: message.id, result: { userAgent: "fake-app-server" } });
        return;
      }
      if (message.method === "thread/resume") {
        observed.resume = message.params;
        send({ id: message.id, result: { thread: { id: message.params.threadId, turns: [], status: { type: "idle" } } } });
        return;
      }
      if (message.method === "thread/settings/update") {
        observed.settings = message.params;
        send({ id: message.id, result: { thread: { id: message.params.threadId, turns: [], status: { type: "idle" } } } });
        return;
      }
      if (message.method !== "turn/start") return;

      function completedTool(turnId, row) {
        const defaultValue = { ok: true, taskId: row.arguments?.taskId || "" };
        let item;
        if (row.itemType === "dynamic") {
          const outputValue = row.outputValue || row.result?.structuredContent || defaultValue;
          const outputText = row.outputText || (
            "Wall time: 0.3589 seconds\nOutput:\n"
            + JSON.stringify([{ type: "text", text: JSON.stringify(outputValue) }])
          );
          item = {
            type: "dynamicToolCall",
            id: row.id || "dynamic-" + row.tool,
            namespace: row.namespace === undefined ? "mcp__ai_mobile_local" : row.namespace,
            tool: row.tool,
            arguments: row.arguments || {},
            status: row.status || "completed",
            success: row.success === undefined ? (row.status || "completed") === "completed" : row.success,
            contentItems: row.contentItems || [{ type: "inputText", text: outputText }],
          };
        } else {
          item = {
            type: "mcpToolCall",
            id: row.id || "mcp-" + row.tool,
            server: row.server || "ai-mobile-local",
            pluginId: row.pluginId || "ai-mobile@ai-mobile",
            tool: row.tool,
            arguments: row.arguments || {},
            status: row.status || "completed",
            result: row.result || { structuredContent: defaultValue },
          };
        }
        send({
          method: "item/completed",
          params: {
            threadId: message.params.threadId,
            turnId,
            item,
          },
        });
      }
      turnCount += 1;
      const turnId = "turn-" + turnCount;
      observed.turns = observed.turns || [];
      observed.turns.push(message.params);
      send({ id: message.id, result: { turn: { id: turnId, items: [], status: "inProgress" } } });
      if (turnCount === 1) {
        const verificationCalls = options.verificationCalls || [{
          id: "mcp-runtime-proof",
          itemType: options.inventoryItemType,
          namespace: options.inventoryNamespace,
          tool: options.inventoryTool || (options.inventoryItemType === "dynamic" ? "resource_inventory" : "resource-inventory"),
          outputValue: options.inventoryOutputValue,
          result: options.inventoryResult || { structuredContent: { runtimeVersion, runtimeFingerprint: runtimeBuildFingerprint } },
        }];
        for (const row of verificationCalls) completedTool(turnId, row);
      } else {
        const continuationCalls = options.continuationCalls === undefined ? [{
          id: "mcp-campaign",
          tool: "run-program-campaign",
          arguments: { taskId: options.taskId },
          result: { structuredContent: { runtimeVersion, taskId: options.taskId, state: "running" } },
        }] : options.continuationCalls;
        for (const row of continuationCalls) completedTool(turnId, row);
        for (let index = 0; index < Number(options.continuationNoiseCount || 0); index += 1) {
          send({
            method: "item/started",
            params: {
              threadId: message.params.threadId,
              turnId,
              item: { type: "agentMessage", id: "noise-" + index, status: "inProgress" },
            },
          });
        }
      }
      send({
        method: "turn/completed",
        params: {
          threadId: message.params.threadId,
          turn: { id: turnId, items: [], status: "completed" },
        },
      });
    }

    child.stdin = new Writable({
      write(chunk, encoding, callback) {
        buffer += chunk.toString();
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) handle(JSON.parse(line));
        }
        callback();
      },
    });
    child.kill = () => {
      if (child.exitCode === null) {
        child.exitCode = 0;
        setImmediate(() => child.emit("exit", 0, null));
      }
      return true;
    };
    return child;
  };
}

async function main() {
  const version = pluginVersion();
  const fingerprint = runtimeFingerprint();
  const taskId = "task-restart-fixture";
  const handoff = {
    schemaVersion: 4,
    oneShot: true,
    userAuthorized: true,
    consumedAt: new Date().toISOString(),
    threadId: "01234567-89ab-cdef-0123-456789abcdef",
    workspace: process.cwd(),
    expectedRuntimeVersion: version,
    expectedRuntimeFingerprint: fingerprint,
    verificationModel: "gpt-5.6-sol",
    verificationEffort: "ultra",
    resumeModel: "gpt-5.6-luna",
    resumeEffort: "low",
    taskId,
    handoffMode: "resume-program",
    reconcileContract: null,
    campaignContract: { taskId, maxRounds: 3, maxMinutes: 15, noProgressLimit: 2, horizonHours: 5 },
    resumePrompt: "Use AI Mobile as the lightweight console and dispatch the next real worker.",
  };
  const inventoryCall = (id = "mcp-runtime-proof") => ({
    id,
    tool: "resource-inventory",
    arguments: {},
    result: { structuredContent: { runtimeVersion: version, runtimeFingerprint: fingerprint } },
  });
  const dynamicInventoryCall = (id = "dynamic-runtime-proof", overrides = {}) => ({
    itemType: "dynamic",
    id,
    namespace: "mcp__ai_mobile_local",
    tool: "resource_inventory",
    arguments: {},
    outputValue: { runtimeVersion: version, runtimeFingerprint: fingerprint },
    ...overrides,
  });
  const campaignCall = (id = "mcp-campaign", targetTaskId = taskId) => ({
    id,
    tool: "run-program-campaign",
    arguments: { taskId: targetTaskId },
    result: { structuredContent: { runtimeVersion: version, taskId: targetTaskId, state: "running" } },
  });
  const dynamicCampaignCall = (id = "dynamic-campaign", targetTaskId = taskId, overrides = {}) => ({
    itemType: "dynamic",
    id,
    namespace: "mcp__ai_mobile_local",
    tool: "run_program_campaign",
    arguments: { taskId: targetTaskId },
    outputValue: { runtimeVersion: version, taskId: targetTaskId, state: "running" },
    ...overrides,
  });
  const programReportCall = (id = "mcp-program-report", targetTaskId = taskId, overrides = {}) => ({
    id,
    tool: "program-report",
    arguments: { taskId: targetTaskId },
    result: { structuredContent: { runtimeVersion: version, taskId: targetTaskId, emit: true } },
    ...overrides,
  });

  const observed = {};
  const result = await runContinuation(handoff, {
    spawnAppServer: fakeAppServer(version, fingerprint, observed, { taskId }),
    verificationTimeoutMs: 1000,
    continuationTimeoutMs: 1000,
  });
  assert.equal(result.runtimeVersion, version);
  assert.equal(result.runtimeFingerprint, fingerprint);
  assert.equal(result.continuationProof.reportCalls, 0);
  assert.equal(result.resumeModel, "gpt-5.6-luna");
  assert.equal(observed.args.join(" "), "app-server --stdio");
  assert.equal(observed.resume.threadId, handoff.threadId);
  assert.equal(observed.turns.length, 2);
  assert.equal(observed.turns[0].model, "gpt-5.6-sol");
  assert.equal(observed.turns[0].effort, "ultra");
  assert.equal(observed.turns[1].model, "gpt-5.6-luna");
  assert.equal(observed.turns[1].effort, "low");
  assert.equal(observed.settings.threadId, handoff.threadId);
  assert.equal(observed.settings.model, "gpt-5.6-luna");
  assert.equal(observed.settings.effort, "low");
  assert.equal(result.threadSettingsUpdated, true);
  assert.equal(result.continuationProof.verified, true);
  assert.equal(result.continuationProof.taskId, taskId);
  assert.equal(result.continuationProof.campaignCalls, 1);
  assert.equal(result.continuationProof.reconcileCalls, 0);

  const dynamicObserved = {};
  const dynamicResult = await runContinuation(handoff, {
    spawnAppServer: fakeAppServer(version, fingerprint, dynamicObserved, {
      taskId,
      continuationCalls: [dynamicCampaignCall()],
    }),
    verificationTimeoutMs: 1000,
    continuationTimeoutMs: 1000,
  });
  assert.equal(dynamicResult.continuationProof.campaignCalls, 1);
  assert.equal(dynamicResult.continuationProof.taskId, taskId);

  const dynamicInventoryObserved = {};
  const dynamicInventoryResult = await runContinuation(handoff, {
    spawnAppServer: fakeAppServer(version, fingerprint, dynamicInventoryObserved, {
      taskId,
      inventoryItemType: "dynamic",
    }),
    verificationTimeoutMs: 1000,
    continuationTimeoutMs: 1000,
  });
  assert.equal(dynamicInventoryResult.runtimeFingerprint, fingerprint);
  assert.equal(dynamicInventoryResult.continuationProof.campaignCalls, 1);

  const mixedInventoryObserved = {};
  const mixedInventoryResult = await runContinuation(handoff, {
    spawnAppServer: fakeAppServer(version, fingerprint, mixedInventoryObserved, {
      taskId,
      verificationCalls: [
        inventoryCall("same-runtime-proof"),
        dynamicInventoryCall("same-runtime-proof"),
      ],
    }),
    verificationTimeoutMs: 1000,
    continuationTimeoutMs: 1000,
  });
  assert.equal(mixedInventoryResult.runtimeFingerprint, fingerprint);

  const extraVerificationObserved = {};
  await assert.rejects(
    runContinuation(handoff, {
      spawnAppServer: fakeAppServer(version, fingerprint, extraVerificationObserved, {
        taskId,
        verificationCalls: [
          inventoryCall(),
          {
            itemType: "dynamic",
            id: "extra-verification-report",
            tool: "program_report",
            arguments: { taskId },
            outputValue: { taskId, emit: false },
          },
        ],
      }),
      verificationTimeoutMs: 1000,
      continuationTimeoutMs: 1000,
    }),
    /exactly one AI Mobile resource-inventory call and no other AI Mobile calls/i,
  );
  assert.equal(extraVerificationObserved.turns.length, 1);

  const duplicateInventoryObserved = {};
  await assert.rejects(
    runContinuation(handoff, {
      spawnAppServer: fakeAppServer(version, fingerprint, duplicateInventoryObserved, {
        taskId,
        verificationCalls: [inventoryCall("inventory-1"), dynamicInventoryCall("inventory-2")],
      }),
      verificationTimeoutMs: 1000,
      continuationTimeoutMs: 1000,
    }),
    /exactly one AI Mobile resource-inventory call and no other AI Mobile calls/i,
  );
  assert.equal(duplicateInventoryObserved.turns.length, 1);

  const mixedRepresentationObserved = {};
  const mixedRepresentationResult = await runContinuation(handoff, {
    spawnAppServer: fakeAppServer(version, fingerprint, mixedRepresentationObserved, {
      taskId,
      continuationCalls: [
        campaignCall("same-campaign-call"),
        dynamicCampaignCall("same-campaign-call"),
      ],
    }),
    verificationTimeoutMs: 1000,
    continuationTimeoutMs: 1000,
  });
  assert.equal(mixedRepresentationResult.continuationProof.campaignCalls, 1);
  assert.equal(mixedRepresentationResult.continuationProof.campaignToolCallId, "same-campaign-call");

  const reportedContinuationObserved = {};
  const reportedContinuationResult = await runContinuation(handoff, {
    spawnAppServer: fakeAppServer(version, fingerprint, reportedContinuationObserved, {
      taskId,
      continuationCalls: [
        campaignCall("reported-campaign"),
        programReportCall("reported-progress"),
      ],
    }),
    verificationTimeoutMs: 1000,
    continuationTimeoutMs: 1000,
  });
  assert.equal(reportedContinuationResult.continuationProof.campaignCalls, 1);
  assert.equal(reportedContinuationResult.continuationProof.reportCalls, 1);
  assert.equal(reportedContinuationResult.continuationProof.reportToolCallId, "reported-progress");

  const reportBeforeCampaignObserved = {};
  await assert.rejects(
    runContinuation(handoff, {
      spawnAppServer: fakeAppServer(version, fingerprint, reportBeforeCampaignObserved, {
        taskId,
        continuationCalls: [
          programReportCall("early-progress"),
          campaignCall("late-campaign"),
        ],
      }),
      verificationTimeoutMs: 1000,
      continuationTimeoutMs: 1000,
    }),
    /program-report must follow/i,
  );

  const duplicateReportObserved = {};
  await assert.rejects(
    runContinuation(handoff, {
      spawnAppServer: fakeAppServer(version, fingerprint, duplicateReportObserved, {
        taskId,
        continuationCalls: [
          campaignCall("single-campaign"),
          programReportCall("progress-1"),
          programReportCall("progress-2"),
        ],
      }),
      verificationTimeoutMs: 1000,
      continuationTimeoutMs: 1000,
    }),
    /at most one program-report/i,
  );

  const wrongDynamicNamespaceObserved = {};
  await assert.rejects(
    runContinuation(handoff, {
      spawnAppServer: fakeAppServer(version, fingerprint, wrongDynamicNamespaceObserved, {
        taskId,
        continuationCalls: [dynamicCampaignCall("wrong-namespace", taskId, { namespace: "mcp__not_ai_mobile" })],
      }),
      verificationTimeoutMs: 1000,
      continuationTimeoutMs: 1000,
    }),
    /exactly one run-program-campaign.*observed 0/i,
  );

  const failedDynamicObserved = {};
  await assert.rejects(
    runContinuation(handoff, {
      spawnAppServer: fakeAppServer(version, fingerprint, failedDynamicObserved, {
        taskId,
        continuationCalls: [dynamicCampaignCall("failed-dynamic", taskId, { status: "failed", success: false })],
      }),
      verificationTimeoutMs: 1000,
      continuationTimeoutMs: 1000,
    }),
    /did not return a successful receipt/i,
  );

  for (const extraTool of [
    "cancel_task",
    "complete_task",
    "record_evidence",
    "prepare_restart_handoff",
  ]) {
    const extraToolObserved = {};
    await assert.rejects(
      runContinuation(handoff, {
        spawnAppServer: fakeAppServer(version, fingerprint, extraToolObserved, {
          taskId,
          continuationCalls: [
            dynamicCampaignCall(),
            {
              itemType: "dynamic",
              id: "extra-" + extraTool,
              tool: extraTool,
              arguments: { taskId },
              outputValue: { ok: true, taskId },
            },
          ],
        }),
        verificationTimeoutMs: 1000,
        continuationTimeoutMs: 1000,
      }),
      /unauthorized AI Mobile tools/i,
    );
  }
  const noisyObserved = {};
  const noisyResult = await runContinuation(handoff, {
    spawnAppServer: fakeAppServer(version, fingerprint, noisyObserved, { taskId, continuationNoiseCount: 250 }),
    verificationTimeoutMs: 1000,
    continuationTimeoutMs: 1000,
  });
  assert.equal(noisyResult.continuationProof.verified, true);
  assert.equal(noisyResult.continuationProof.campaignCalls, 1);

  const overflowObserved = {};
  await assert.rejects(
    runContinuation(handoff, {
      spawnAppServer: fakeAppServer(version, fingerprint, overflowObserved, {
        taskId,
        continuationNoiseCount: 10_000,
      }),
      verificationTimeoutMs: 1000,
      continuationTimeoutMs: 5000,
    }),
    /notification capture exceeded 10000 events/i,
  );


  const staleObserved = {};
  await assert.rejects(
    runContinuation(handoff, {
      spawnAppServer: fakeAppServer("1.1.10", fingerprint, staleObserved, { taskId }),
      verificationTimeoutMs: 1000,
      continuationTimeoutMs: 1000,
    }),
    /runtime proof was not observed/i,
  );
  assert.equal(staleObserved.turns.length, 1);

  const wrongBuildObserved = {};
  await assert.rejects(
    runContinuation(handoff, {
      spawnAppServer: fakeAppServer(version, "0".repeat(64), wrongBuildObserved, { taskId }),
      verificationTimeoutMs: 1000,
      continuationTimeoutMs: 1000,
    }),
    /runtime proof was not observed/i,
  );
  assert.equal(wrongBuildObserved.turns.length, 1);

  const wrongInventoryObserved = {};
  await assert.rejects(
    runContinuation(handoff, {
      spawnAppServer: fakeAppServer(version, fingerprint, wrongInventoryObserved, { taskId, inventoryTool: "orchestrator-profile" }),
      verificationTimeoutMs: 1000,
      continuationTimeoutMs: 1000,
    }),
    /exactly one AI Mobile resource-inventory call and no other AI Mobile calls/i,
  );
  assert.equal(wrongInventoryObserved.turns.length, 1);

  const noCampaignObserved = {};
  await assert.rejects(
    runContinuation(handoff, {
      spawnAppServer: fakeAppServer(version, fingerprint, noCampaignObserved, { taskId, continuationCalls: [] }),
      verificationTimeoutMs: 1000,
      continuationTimeoutMs: 1000,
    }),
    /exactly one run-program-campaign.*observed 0/i,
  );

  const duplicateCampaignObserved = {};
  await assert.rejects(
    runContinuation(handoff, {
      spawnAppServer: fakeAppServer(version, fingerprint, duplicateCampaignObserved, {
        taskId,
        continuationCalls: [campaignCall("campaign-1"), campaignCall("campaign-2")],
      }),
      verificationTimeoutMs: 1000,
      continuationTimeoutMs: 1000,
    }),
    /exactly one run-program-campaign.*observed 2/i,
  );

  const wrongTaskObserved = {};
  await assert.rejects(
    runContinuation(handoff, {
      spawnAppServer: fakeAppServer(version, fingerprint, wrongTaskObserved, {
        taskId,
        continuationCalls: [campaignCall("wrong-task-campaign", "task-another-fixture")],
      }),
      verificationTimeoutMs: 1000,
      continuationTimeoutMs: 1000,
    }),
    /did not target durable task/i,
  );

  const legacyObserved = {};
  await assert.rejects(
    runContinuation(handoff, {
      spawnAppServer: fakeAppServer(version, fingerprint, legacyObserved, {
        taskId,
        continuationCalls: [
          { id: "legacy-cycle", tool: "run-task-cycle", arguments: { taskId } },
          campaignCall(),
        ],
      }),
      verificationTimeoutMs: 1000,
      continuationTimeoutMs: 1000,
    }),
    /unauthorized AI Mobile tools/i,
  );

  const reconciledResumeObserved = {};
  await assert.rejects(
    runContinuation(handoff, {
      spawnAppServer: fakeAppServer(version, fingerprint, reconciledResumeObserved, {
        taskId,
        continuationCalls: [
          { id: "unexpected-reconcile", tool: "reconcile-task", arguments: { taskId } },
          campaignCall(),
        ],
      }),
      verificationTimeoutMs: 1000,
      continuationTimeoutMs: 1000,
    }),
    /unauthorized AI Mobile tools/i,
  );

  const migrationHandoff = {
    ...handoff,
    handoffMode: "migrate-program",
    reconcileContract: { taskId, migrateToDirector: true },
  };
  const migrationObserved = {};
  const migrationResult = await runContinuation(migrationHandoff, {
    spawnAppServer: fakeAppServer(version, fingerprint, migrationObserved, {
      taskId,
      continuationCalls: [
        { id: "migration", tool: "reconcile-task", arguments: { taskId, migrateToDirector: true } },
        campaignCall(),
      ],
    }),
    verificationTimeoutMs: 1000,
    continuationTimeoutMs: 1000,
  });
  assert.equal(migrationResult.continuationProof.migrationVerified, true);
  assert.equal(migrationResult.continuationProof.reconcileCalls, 1);

  process.stdout.write(JSON.stringify({
    ok: true,
    freshRuntimeRequiredBeforeLuna: true,
    persistentThreadModelUpdated: true,
    sameThreadTurns: observed.turns.length,
    hiddenCodexExecUsed: false,
    staleRuntimeFailsClosed: true,
    sameVersionWrongBuildFailsClosed: true,
    exactInventoryToolRequired: true,
    exactSingleCampaignRequired: true,
    perTurnNotificationCaptureSurvivesRingEviction: true,
    notificationCaptureOverflowFailsClosed: true,
    resumeNeverReconciles: true,
    legacyToolsRejected: true,
  }, null, 2) + "\n");
}

main().catch((error) => {
  process.stderr.write(error.stack + "\n");
  process.exitCode = 1;
});
