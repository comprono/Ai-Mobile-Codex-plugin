#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough, Writable } = require("node:stream");
const { runContinuation } = require("./codex-app-server-resume");

function fakeAppServer(runtimeVersion, observed) {
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
      if (message.method !== "turn/start") return;
      turnCount += 1;
      const turnId = "turn-" + turnCount;
      observed.turns = observed.turns || [];
      observed.turns.push(message.params);
      send({ id: message.id, result: { turn: { id: turnId, items: [], status: "inProgress" } } });
      if (turnCount === 1) {
        send({
          method: "item/completed",
          params: {
            threadId: message.params.threadId,
            turnId,
            item: {
              type: "mcpToolCall",
              id: "mcp-runtime-proof",
              server: "ai-mobile-local",
              pluginId: "ai-mobile@ai-mobile",
              tool: "resource-inventory",
              arguments: {},
              status: "completed",
              result: { structuredContent: { runtimeVersion } },
            },
          },
        });
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
  const handoff = {
    oneShot: true,
    userAuthorized: true,
    consumedAt: new Date().toISOString(),
    threadId: "01234567-89ab-cdef-0123-456789abcdef",
    workspace: process.cwd(),
    expectedRuntimeVersion: "1.2.1",
    verificationModel: "gpt-5.6-sol",
    verificationEffort: "ultra",
    resumeModel: "gpt-5.6-luna",
    resumeEffort: "low",
    resumePrompt: "Use AI Mobile as the lightweight console and dispatch the next real worker.",
  };

  const observed = {};
  const result = await runContinuation(handoff, {
    spawnAppServer: fakeAppServer("1.2.1", observed),
    verificationTimeoutMs: 1000,
    continuationTimeoutMs: 1000,
  });
  assert.equal(result.runtimeVersion, "1.2.1");
  assert.equal(result.resumeModel, "gpt-5.6-luna");
  assert.equal(observed.args.join(" "), "app-server --stdio");
  assert.equal(observed.resume.threadId, handoff.threadId);
  assert.equal(observed.turns.length, 2);
  assert.equal(observed.turns[0].model, "gpt-5.6-sol");
  assert.equal(observed.turns[0].effort, "ultra");
  assert.equal(observed.turns[1].model, "gpt-5.6-luna");
  assert.equal(observed.turns[1].effort, "low");

  const staleObserved = {};
  await assert.rejects(
    runContinuation(handoff, {
      spawnAppServer: fakeAppServer("1.1.10", staleObserved),
      verificationTimeoutMs: 1000,
      continuationTimeoutMs: 1000,
    }),
    /runtime proof was not observed/i,
  );
  assert.equal(staleObserved.turns.length, 1);

  process.stdout.write(JSON.stringify({
    ok: true,
    freshRuntimeRequiredBeforeLuna: true,
    sameThreadTurns: observed.turns.length,
    hiddenCodexExecUsed: false,
    staleRuntimeFailsClosed: true,
  }, null, 2) + "\n");
}

main().catch((error) => {
  process.stderr.write(error.stack + "\n");
  process.exitCode = 1;
});