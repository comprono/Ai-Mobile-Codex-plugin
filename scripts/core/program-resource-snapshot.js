"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { processAlive, readJson } = require("./utils");
const { jobDirectory, listJobIds, readTask, safeId } = require("./state-store");
const { leaseFile } = require("./resource-leases");

const SCHEMA_VERSION = "director-cfo/program-resource-snapshot@1";
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "rejected"]);

function hasOwn(value, key) {
  return Boolean(value && Object.prototype.hasOwnProperty.call(value, key));
}

function finiteNonNegative(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function positiveInteger(value) {
  const number = finiteNonNegative(value);
  return number !== null && number > 0 ? Math.floor(number) : null;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function fingerprint(value) {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

function elapsedMs(status = {}, contract = {}, nowMs = Date.now()) {
  const start = Date.parse(status.startedAt || status.createdAt || contract.createdAt || "");
  if (!Number.isFinite(start)) return null;
  const terminal = TERMINAL_STATES.has(String(status.state || ""));
  const end = terminal
    ? Date.parse(status.finishedAt || "")
    : nowMs;
  if (!Number.isFinite(end) || end < start) return null;
  return Math.floor(end - start);
}

function tokenObservation(providerValue, usage = {}) {
  const provider = String(providerValue || usage.provider || "").trim().toLowerCase();
  const reported = finiteNonNegative(usage.totalTokens ?? usage.total_tokens);
  const input = finiteNonNegative(usage.inputTokens ?? usage.input_tokens);
  const cacheCreation = finiteNonNegative(usage.cacheCreationInputTokens ?? usage.cache_creation_input_tokens);
  const cacheRead = finiteNonNegative(
    usage.cacheReadInputTokens
      ?? usage.cachedInputTokens
      ?? usage.cache_read_input_tokens
      ?? usage.cached_input_tokens,
  );
  const output = finiteNonNegative(usage.outputTokens ?? usage.output_tokens);
  let observed = reported;
  let componentsComplete = false;
  if (provider === "claude") {
    componentsComplete = [input, cacheCreation, cacheRead, output].every((value) => value !== null);
    if (observed === null && componentsComplete) observed = input + cacheCreation + cacheRead + output;
  } else {
    componentsComplete = input !== null && output !== null;
    if (observed === null && componentsComplete) observed = input + output;
  }
  const complete = usage.resourceAccountingComplete !== false
    && usage.providerResourceAccountingComplete !== false
    && (reported !== null || componentsComplete);
  return {
    observed,
    complete,
    components: {
      inputTokens: input,
      cacheCreationInputTokens: cacheCreation,
      cacheReadInputTokens: cacheRead,
      outputTokens: output,
    },
  };
}

function directoryBytes(root, options = {}) {
  let bytes = 0;
  let files = 0;
  let errorCount = 0;
  let stopped = false;
  const errors = [];
  const maxFiles = Math.max(1, Math.min(1_000_000, positiveInteger(options.maxFiles) || 10_000));
  const addError = (reason) => {
    errorCount += 1;
    if (errors.length < 25) errors.push(String(reason));
  };
  const visit = (directory) => {
    if (stopped) return;
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      addError(error.message || error);
      return;
    }
    for (const entry of entries) {
      if (stopped) break;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(target);
        continue;
      }
      if (!entry.isFile()) {
        addError("unmeasured filesystem entry: " + target);
        continue;
      }
      if (files >= maxFiles) {
        addError("durable artifact file scan limit exceeded: " + maxFiles);
        stopped = true;
        break;
      }
      try {
        bytes += fs.statSync(target).size;
        files += 1;
      } catch (error) {
        addError(error.message || error);
      }
    }
  };
  visit(root);
  return { bytes, files, errors, errorCount, complete: errorCount === 0 };
}

function artifactKey(value, prefix) {
  if (value === null || value === undefined || value === "") return "";
  return `${prefix}:${fingerprint(value)}`;
}

function jobArtifactKeys(directory, handoff = {}) {
  const keys = new Set();
  const patch = (() => {
    try { return fs.readFileSync(path.join(directory, "worker.diff"), "utf8"); }
    catch { return ""; }
  })();
  if (patch.trim()) keys.add(artifactKey(patch, "patch"));
  for (const value of [handoff.deliverable, handoff.artifact]) {
    const key = artifactKey(value, "deliverable");
    if (key) keys.add(key);
  }
  for (const name of ["deliverable.json", "artifact.json"]) {
    const value = readJson(path.join(directory, name), null);
    const key = artifactKey(value, "deliverable");
    if (key) keys.add(key);
  }
  return keys;
}

function receiptArtifacts(receipts = []) {
  const keys = new Set();
  const records = new Map();
  for (const receipt of receipts || []) {
    for (const [index, artifact] of (receipt?.artifacts || []).entries()) {
      const ref = String(artifact?.ref || artifact?.path || "").trim();
      const artifactFingerprint = String(artifact?.fingerprint || "").trim();
      const kind = String(artifact?.kind || "artifact").trim();
      const identity = artifactFingerprint
        ? kind + ":" + artifactFingerprint
        : ref || "unidentified:" + String(receipt?.receiptId || "receipt") + ":" + (index + 1);
      keys.add("receipt-artifact:" + identity);
      const recordKey = stableStringify({ ref, artifactFingerprint, kind });
      if (!records.has(recordKey)) records.set(recordKey, { ref, fingerprint: artifactFingerprint, kind });
    }
  }
  return { keys, records: [...records.values()] };
}

function pathInside(candidate, root) {
  if (!candidate || !root) return false;
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function containedLocalArtifactPath(candidate, roots = [], options = {}) {
  if (!candidate) return { ok: false, reason: "local artifact path is empty" };
  const target = path.resolve(candidate);
  const lstatSync = options.lstatSync || fs.lstatSync;
  const realpathSync = options.realpathSync || fs.realpathSync.native || fs.realpathSync;
  const lexicalRoots = [...new Set((roots || []).filter(Boolean).map((root) => path.resolve(root)))]
    .filter((root) => pathInside(target, root))
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
  if (lexicalRoots.length === 0) {
    return { ok: false, reason: "artifact path is outside the authorized project workspace" };
  }

  let reason = "local artifact path does not exist or cannot be measured";
  for (const root of lexicalRoots) {
    try {
      if (lstatSync(root).isSymbolicLink()) {
        reason = "authorized artifact root is a symbolic link";
        continue;
      }
      let current = root;
      const relative = path.relative(root, target);
      const components = relative ? relative.split(path.sep).filter(Boolean) : [];
      let symbolicLink = false;
      for (const component of components) {
        current = path.join(current, component);
        if (lstatSync(current).isSymbolicLink()) {
          symbolicLink = true;
          reason = "artifact path contains a symbolic-link component";
          break;
        }
      }
      if (symbolicLink) continue;

      const realRoot = path.resolve(realpathSync(root));
      const realTarget = path.resolve(realpathSync(target));
      if (!pathInside(realTarget, realRoot)) {
        reason = "artifact real path escapes its authorized root";
        continue;
      }
      return { ok: true, target: realTarget, root, realRoot };
    } catch {
      reason = "local artifact path does not exist or cannot be measured";
    }
  }
  return { ok: false, reason };
}

function virtualArtifactPath(ref, jobs = []) {
  const match = String(ref || "").match(/^(?:ai-mobile-(patch|job)|director-patch):(job-[A-Za-z0-9._-]+)$/);
  if (!match) return null;
  const job = jobs.find((row) => row.jobId === match[2]);
  if (!job) return null;
  return match[1] === "job"
    ? { target: job.directory, covered: true }
    : { target: path.join(job.directory, "worker.diff"), covered: true };
}

function receiptArtifactStorage(records = [], input = {}) {
  const workspace = input.workspace ? path.resolve(input.workspace) : "";
  const jobs = input.jobs || [];
  const jobRoots = jobs.map((row) => path.resolve(row.directory));
  const jobRootSet = new Set(jobRoots);
  const unknown = [];
  const candidates = new Map();
  const measured = [];
  for (const record of records) {
    const virtual = virtualArtifactPath(record.ref, jobs);
    if (virtual) {
      const resolved = containedLocalArtifactPath(virtual.target, jobRoots);
      if (resolved.ok && jobRootSet.has(resolved.root)) {
        measured.push({ ref: record.ref, path: resolved.target, bytes: 0, coveredByJobDirectory: true });
      } else {
        unknown.push({ ref: record.ref, reason: resolved.reason || "referenced durable job artifact is missing" });
      }
      continue;
    }
    const ref = String(record.ref || "").trim();
    if (!ref || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(ref)) {
      unknown.push({ ref, reason: "artifact reference is not a measurable local path" });
      continue;
    }
    const target = path.isAbsolute(ref) ? path.resolve(ref) : workspace ? path.resolve(workspace, ref) : "";
    const resolved = containedLocalArtifactPath(target, [workspace, ...jobRoots]);
    if (!resolved.ok) {
      unknown.push({ ref, reason: resolved.reason });
      continue;
    }
    if (jobRootSet.has(resolved.root)) {
      measured.push({ ref, path: resolved.target, bytes: 0, coveredByJobDirectory: true });
      continue;
    }
    if (!candidates.has(resolved.target)) candidates.set(resolved.target, { ...record, target: resolved.target });
  }

  let bytes = 0;
  let files = 0;
  const measuredRoots = [];
  const rows = [...candidates.values()].sort((left, right) => left.target.length - right.target.length || left.target.localeCompare(right.target));
  for (const row of rows) {
    if (measuredRoots.some((root) => pathInside(row.target, root))) {
      measured.push({ ref: row.ref, path: row.target, bytes: 0, coveredByLocalArtifact: true });
      continue;
    }
    let stat;
    try { stat = fs.lstatSync(row.target); }
    catch {
      unknown.push({ ref: row.ref, reason: "local artifact path does not exist or cannot be measured" });
      continue;
    }
    if (stat.isSymbolicLink()) {
      unknown.push({ ref: row.ref, reason: "symbolic-link artifact size is not durably attributable" });
      continue;
    }
    if (stat.isFile()) {
      bytes += stat.size;
      files += 1;
      measuredRoots.push(row.target);
      measured.push({ ref: row.ref, path: row.target, bytes: stat.size });
      continue;
    }
    if (!stat.isDirectory()) {
      unknown.push({ ref: row.ref, reason: "local artifact is not a regular file or directory" });
      continue;
    }
    const storage = directoryBytes(row.target);
    bytes += storage.bytes;
    files += storage.files;
    measuredRoots.push(row.target);
    measured.push({ ref: row.ref, path: row.target, bytes: storage.bytes });
    for (const reason of storage.errors) unknown.push({ ref: row.ref, reason });
  }
  return {
    bytes,
    files,
    complete: unknown.length === 0,
    unknownCount: unknown.length,
    unknown: unknown.slice(0, 25),
    measured: measured.slice(0, 100),
  };
}

function readDirectorJobs(taskId, programId, options = {}) {
  const ids = Array.isArray(options.jobIds) ? options.jobIds : listJobIds(taskId);
  const rows = [];
  for (const rawJobId of [...new Set(ids.map(String))].sort()) {
    let jobId;
    try { jobId = safeId(rawJobId, "job"); }
    catch { continue; }
    const directory = jobDirectory(taskId, jobId);
    const contract = readJson(path.join(directory, "contract.json"), null);
    if (!contract?.directorProgram) continue;
    const attemptClaim = readJson(path.join(directory, "allocation-attempt-claim.json"), null);
    if (attemptClaim?.state === "abandoned") continue;
    // Resource spend is owned by the durable program, not one mutable Mission or
    // revision fence. User corrections retain programId; filtering prior revisions
    // would reset real spend whenever the plan changes.
    if (programId && String(contract.directorProgram.programId || "") !== programId) continue;
    rows.push({
      jobId,
      directory,
      contract,
      status: readJson(path.join(directory, "status.json"), {}),
      usage: readJson(path.join(directory, "usage.json"), {}),
      handoff: readJson(path.join(directory, "handoff.json"), {}),
    });
  }
  return rows;
}

function leaseIsLive(lease = {}, nowMs = Date.now(), alive = processAlive) {
  const expiresAt = Date.parse(lease.expiresAt || "");
  if (Number.isFinite(expiresAt) && expiresAt <= nowMs) return false;
  const pid = Number(lease.pid || 0);
  if (pid > 0 && !alive(pid)) return false;
  return true;
}

function readLiveLeases(options = {}) {
  const record = readJson(leaseFile(), { active: [] });
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const alive = options.processAlive || processAlive;
  return (Array.isArray(record.active) ? record.active : []).filter((lease) => leaseIsLive(lease, nowMs, alive));
}

function measurement(value, defaultUnit = "percent") {
  if (value && typeof value === "object" && hasOwn(value, "state")) {
    const state = value.state === "known" && finiteNonNegative(value.value) !== null ? "known" : "unknown";
    return {
      state,
      unit: String(value.unit || defaultUnit),
      value: state === "known" ? finiteNonNegative(value.value) : null,
      ...(state === "unknown" ? { reason: String(value.reason || "quota capacity was not observed") } : {}),
    };
  }
  const number = finiteNonNegative(value);
  return number === null
    ? { state: "unknown", unit: defaultUnit, value: null, reason: "quota capacity was not observed" }
    : { state: "known", unit: defaultUnit, value: number };
}

function quotaSnapshot(ledger = {}, capacity = {}) {
  const providerIds = [...new Set([
    ...Object.keys(ledger?.providers || {}),
    ...Object.keys(capacity?.providers || {}),
  ])].sort();
  const providers = {};
  for (const providerId of providerIds) {
    const ledgerProvider = ledger?.providers?.[providerId] || {};
    const capacityProvider = capacity?.providers?.[providerId] || {};
    const rows = Array.isArray(ledgerProvider.quotaPools) && ledgerProvider.quotaPools.length
      ? ledgerProvider.quotaPools
      : Array.isArray(capacityProvider.quotaPools) ? capacityProvider.quotaPools : [];
    providers[providerId] = {
      pools: rows.map((row, index) => {
        const id = String(row.id || row.poolId || row.quotaPoolId || row.scope || `pool-${index + 1}`);
        const remaining = hasOwn(row, "remaining")
          ? measurement(row.remaining, row.unit || "percent")
          : measurement(row.remainingPercent, "percent");
        return {
          id,
          key: String(row.key || `${providerId}:${id}`),
          remaining,
          resetAt: row.resetAt || null,
        };
      }).sort((left, right) => left.key.localeCompare(right.key)),
    };
  }
  return { providers };
}

function observedCampaignIds(task = {}) {
  const rows = [
    ...(task.program?.campaigns || []),
    task.program?.activeCampaign,
    task.program?.contracts?.campaign,
  ].filter(Boolean);
  return [...new Set(rows.map((row) => String(row.campaignId || "").trim()).filter(Boolean))].sort();
}

function campaignCount(task = {}, supplied) {
  const supervisor = task.program?.runtime?.programSupervisor || {};
  const observedRows = [
    ...(task.program?.campaigns || []),
    task.program?.activeCampaign,
    task.program?.contracts?.campaign,
  ].filter(Boolean);
  const observedIds = observedCampaignIds(task);
  const maxEpoch = observedRows.reduce((maximum, row) => Math.max(maximum, finiteNonNegative(row.epoch) || 0), 0);
  const persisted = Math.max(
    0,
    Math.floor(finiteNonNegative(supplied) ?? 0),
    Math.floor(finiteNonNegative(supervisor.campaignCount) ?? 0),
    Math.floor(finiteNonNegative(task.program?.campaignCount) ?? 0),
  );
  return {
    count: Math.max(persisted, observedIds.length, maxEpoch),
    persistedCount: persisted,
    observedCount: observedIds.length,
    observedIds,
  };
}
function allocationAuthorization(jobs = [], workPackages = []) {
  const grants = new Map();
  const blockers = [];
  const workPackageStates = new Map((workPackages || []).map((row) => [
    String(row.workPackageId || ""),
    String(row.state || ""),
  ]));
  const retiredPackageStates = new Set(["completed", "failed", "cancelled", "superseded", "rejected"]);
  for (const job of jobs) {
    const allocation = job.allocation || {};
    const allocationId = String(job.allocationId || "").trim();
    if (!allocationId) {
      blockers.push({ code: "program-allocation-authorization-missing", jobId: job.jobId, metric: "allocation", reason: "Director job has no immutable allocationId." });
      continue;
    }
    const tokenLimit = positiveInteger(allocation.tokenLimit);
    const durationLimitMs = positiveInteger(allocation.durationLimitMs);
    const maxAttempts = positiveInteger(allocation.maxAttempts);
    if (tokenLimit === null || durationLimitMs === null || maxAttempts === null) {
      blockers.push({ code: "program-allocation-authorization-incomplete", jobId: job.jobId, allocationId, metric: "allocation", reason: "Immutable token, duration, and attempt authorization is required." });
      continue;
    }
    const binding = {
      allocationId,
      workPackageId: String(allocation.workPackageId || job.workPackageId || ""),
      candidateId: String(allocation.candidateId || ""),
      provider: String(allocation.provider || job.provider || "").trim().toLowerCase(),
      model: String(allocation.model || "").trim().toLowerCase(),
      tokenLimit,
      durationLimitMs,
      maxAttempts,
    };
    const bindingFingerprint = fingerprint(binding);
    const current = grants.get(allocationId);
    if (current && current.bindingFingerprint !== bindingFingerprint) {
      blockers.push({
        code: "program-allocation-binding-conflict",
        jobId: job.jobId,
        allocationId,
        metric: "allocation",
        reason: "The same allocationId was observed with a different immutable binding.",
      });
      continue;
    }
    if (!current) grants.set(allocationId, { allocationId, binding, bindingFingerprint, jobs: [] });
    grants.get(allocationId).jobs.push(job);
  }

  const allocations = [];
  let authorizedTokens = 0;
  let authorizedDurationMs = 0;
  let authorizedAttempts = 0;
  let capacityTokens = 0;
  let capacityDurationMs = 0;
  let capacityAttempts = 0;
  for (const grant of [...grants.values()].sort((left, right) => left.allocationId.localeCompare(right.allocationId))) {
    const authorized = {
      tokens: grant.binding.tokenLimit * grant.binding.maxAttempts,
      durationMs: grant.binding.durationLimitMs * grant.binding.maxAttempts,
      attempts: grant.binding.maxAttempts,
    };
    const committed = {
      tokens: grant.jobs.every((job) => job.tokens.committed !== null)
        ? grant.jobs.reduce((sum, job) => sum + job.tokens.committed, 0)
        : null,
      durationMs: grant.jobs.every((job) => job.durationMs.committed !== null)
        ? grant.jobs.reduce((sum, job) => sum + job.durationMs.committed, 0)
        : null,
      attempts: grant.jobs.length,
    };
    const workPackageState = workPackageStates.get(grant.binding.workPackageId) || "";
    const terminalGrant = grant.jobs.every((job) => TERMINAL_STATES.has(String(job.state || "")))
      && retiredPackageStates.has(workPackageState);
    const capacity = terminalGrant
      ? {
        tokens: committed.tokens === null ? authorized.tokens : committed.tokens,
        durationMs: committed.durationMs === null ? authorized.durationMs : committed.durationMs,
        attempts: committed.attempts,
      }
      : authorized;
    authorizedTokens += authorized.tokens;
    authorizedDurationMs += authorized.durationMs;
    authorizedAttempts += authorized.attempts;
    capacityTokens += capacity.tokens;
    capacityDurationMs += capacity.durationMs;
    capacityAttempts += capacity.attempts;
    for (const [metric, code] of [
      ["tokens", "allocation-token-authorization-exceeded"],
      ["durationMs", "allocation-duration-authorization-exceeded"],
      ["attempts", "allocation-attempt-authorization-exceeded"],
    ]) {
      if (committed[metric] !== null && committed[metric] > authorized[metric]) {
        blockers.push({ code, allocationId: grant.allocationId, metric, committed: committed[metric], authorized: authorized[metric], reason: metric + " committed for the immutable allocation exceeds its authorization." });
      }
    }
    allocations.push({
      allocationId: grant.allocationId,
      bindingFingerprint: grant.bindingFingerprint,
      binding: grant.binding,
      jobIds: grant.jobs.map((job) => job.jobId).sort(),
      authorized,
      committed,
      capacity,
      workPackageState,
      terminalGrant,
    });
  }
  return {
    allocations,
    totals: { tokens: authorizedTokens, durationMs: authorizedDurationMs, attempts: authorizedAttempts },
    capacityTotals: { tokens: capacityTokens, durationMs: capacityDurationMs, attempts: capacityAttempts },
    complete: blockers.every((row) => !["program-allocation-authorization-missing", "program-allocation-authorization-incomplete", "program-allocation-binding-conflict"].includes(row.code)),
    blockers,
  };
}

function capBlocker(code, metric, committed, limit) {
  return { code, metric, committed, limit, reason: `${metric} ${committed} exceeds program cap ${limit}` };
}

function evaluateProgramResourceCaps(snapshot, limits = {}) {
  const blockers = [];
  const exhausted = [];
  const exposure = (metric, committed) => {
    if (committed === null) return null;
    const authorized = finiteNonNegative(snapshot.authorization?.capacityTotals?.[metric] ?? snapshot.authorization?.totals?.[metric]);
    return authorized === null ? committed : Math.max(committed, authorized);
  };
  const checks = [
    ["maxTokens", "tokens", exposure("tokens", snapshot.totals.tokens.committed), "program-token-cap-exceeded"],
    ["maxDurationMs", "durationMs", exposure("durationMs", snapshot.totals.durationMs.committed), "program-duration-cap-exceeded"],
    ["maxAttempts", "attempts", exposure("attempts", snapshot.totals.attempts.committed), "program-attempt-cap-exceeded"],
    ["maxArtifacts", "artifacts", snapshot.totals.artifacts.committed, "program-artifact-cap-exceeded"],
    ["maxArtifactBytes", "durableBytes", snapshot.totals.durableBytes.committed, "program-artifact-bytes-cap-exceeded"],
    ["maxWorkers", "activeWorkers", snapshot.concurrency.programActive, "program-worker-cap-exceeded"],
    ["maxGlobalWorkers", "globalActiveWorkers", snapshot.concurrency.globalActive, "global-worker-cap-exceeded"],
    ["maxCampaigns", "campaigns", snapshot.campaign.count, "program-campaign-cap-exceeded"],
  ];
  for (const [limitKey, metric, committed, code] of checks) {
    const limit = positiveInteger(limits[limitKey]);
    if (limit === null) continue;
    if (committed === null) {
      blockers.push({ code: `program-${metric}-accounting-unknown`, metric, committed: null, limit, reason: `${metric} cannot be bounded from durable state` });
    } else if (committed > limit) {
      blockers.push(capBlocker(code, metric, committed, limit));
    } else if (committed === limit) {
      exhausted.push({
        ...capBlocker(code.replace(/-exceeded$/, "-exhausted"), metric, committed, limit),
        reason: `${metric} ${committed} has exhausted program cap ${limit}; no new consumption is authorized`,
      });
    }
  }
  return { safe: blockers.length === 0, blockers, exhausted };
}

function computeProgramResourceSnapshot(input = {}) {
  const taskId = safeId(input.taskId, "task");
  const task = input.task || {};
  const programId = String(input.programId || task.program?.programId || task.program?.contracts?.programId || "").trim();
  const nowMs = Number.isFinite(Number(input.nowMs)) ? Number(input.nowMs) : Date.now();
  const receipts = task.program?.executionReceipts || task.program?.contracts?.executionReceipts || [];
  const receiptArtifactSet = receiptArtifacts(receipts);
  const artifactKeys = new Set(receiptArtifactSet.keys);
  const accountingNotes = [];
  const blockers = [];
  const jobs = [];
  let knownTokens = 0;
  let committedTokens = 0;
  let tokenCommitComplete = true;
  let knownTokenJobs = 0;
  let knownDurationMs = 0;
  let committedDurationMs = 0;
  let durationCommitComplete = true;
  let knownDurationJobs = 0;
  let durableBytes = 0;
  let durableFiles = 0;

  const directorJobRows = (input.jobs || []).slice().sort((left, right) => left.jobId.localeCompare(right.jobId));
  for (const row of directorJobRows) {
    const { jobId, directory, contract, status = {}, usage = {}, handoff = {} } = row;
    const allocation = contract.allocation || {};
    const provider = String(usage.provider || contract.provider || allocation.provider || "").trim().toLowerCase();
    const tokenLimit = positiveInteger(allocation.tokenLimit);
    const durationLimitMs = positiveInteger(allocation.durationLimitMs);
    const maxAttempts = positiveInteger(allocation.maxAttempts);
    const tokens = tokenObservation(provider, usage);
    if (tokens.observed !== null) {
      knownTokens += tokens.observed;
      knownTokenJobs += 1;
    }
    let tokenCommitted = tokens.complete ? tokens.observed : tokenLimit === null ? null : Math.max(tokenLimit, tokens.observed || 0);
    if (tokenCommitted === null) {
      tokenCommitComplete = false;
      blockers.push({ code: "program-token-accounting-unbounded", jobId, metric: "tokens", reason: "Token telemetry is incomplete and the immutable allocation tokenLimit is missing." });
    } else {
      committedTokens += tokenCommitted;
    }
    if (!tokens.complete && tokenLimit !== null) {
      accountingNotes.push({ code: "token-limit-committed", jobId, observed: tokens.observed, committed: tokenCommitted, limit: tokenLimit });
    }

    const statusElapsedMs = elapsedMs(status, contract, nowMs);
    const usageDurationMs = finiteNonNegative(usage.durationMs ?? usage.duration_ms);
    const observedDurationMs = usageDurationMs === null
      ? statusElapsedMs
      : statusElapsedMs === null ? usageDurationMs : Math.max(usageDurationMs, statusElapsedMs);
    if (observedDurationMs !== null) {
      knownDurationMs += observedDurationMs;
      knownDurationJobs += 1;
    }
    const active = !TERMINAL_STATES.has(String(status.state || ""));
    let durationCommittedMs = observedDurationMs;
    if (active || observedDurationMs === null) {
      durationCommittedMs = durationLimitMs === null
        ? null
        : Math.max(durationLimitMs, observedDurationMs || 0);
    }
    if (durationCommittedMs === null) {
      durationCommitComplete = false;
      blockers.push({ code: "program-duration-accounting-unbounded", jobId, metric: "durationMs", reason: "Active or unmeasured work has no immutable allocation durationLimitMs." });
    } else {
      committedDurationMs += durationCommittedMs;
    }
    if ((active || observedDurationMs === null) && durationLimitMs !== null) {
      accountingNotes.push({ code: "duration-limit-committed", jobId, observed: observedDurationMs, committed: durationCommittedMs, limit: durationLimitMs });
    }

    const storage = directoryBytes(directory);
    durableBytes += storage.bytes;
    durableFiles += storage.files;
    if (storage.errors.length) {
      blockers.push({ code: "program-storage-accounting-incomplete", jobId, metric: "durableBytes", reason: storage.errors[0] });
    }
    const rowArtifactKeys = jobArtifactKeys(directory, handoff);
    for (const key of rowArtifactKeys) artifactKeys.add(key);
    jobs.push({
      jobId,
      state: String(status.state || "unknown"),
      provider,
      programId: String(contract.directorProgram?.programId || ""),
      workPackageId: String(contract.directorProgram?.workPackageId || allocation.workPackageId || ""),
      allocation: {
        tokenLimit,
        durationLimitMs,
        maxAttempts,
        workPackageId: String(allocation.workPackageId || contract.directorProgram?.workPackageId || ""),
        candidateId: String(allocation.candidateId || ""),
        provider: String(allocation.provider || provider).trim().toLowerCase(),
        model: String(allocation.model || "").trim().toLowerCase(),
      },
      allocationId: String(allocation.allocationId || ""),
      attempt: 1,
      tokens: {
        observed: tokens.observed,
        telemetryComplete: tokens.complete,
        committed: tokenCommitted,
        limit: tokenLimit,
        components: tokens.components,
      },
      durationMs: {
        observed: observedDurationMs,
        usage: usageDurationMs,
        statusElapsed: statusElapsedMs,
        committed: durationCommittedMs,
        limit: durationLimitMs,
      },
      artifacts: rowArtifactKeys.size,
      durableBytes: storage.bytes,
      durableFiles: storage.files,
    });
  }
  const receiptStorage = receiptArtifactStorage(receiptArtifactSet.records, { workspace: task.workspace, jobs: directorJobRows });
  durableBytes += receiptStorage.bytes;
  durableFiles += receiptStorage.files;
  if (!receiptStorage.complete) {
    blockers.push({
      code: "program-artifact-bytes-unknown",
      metric: "durableBytes",
      unknownCount: receiptStorage.unknownCount,
      artifacts: receiptStorage.unknown,
      reason: "One or more durable receipt artifact references cannot be measured; artifact bytes are not treated as zero.",
    });
  }
  const authorization = allocationAuthorization(jobs, task.program?.workPackages || []);
  blockers.push(...authorization.blockers);

  const liveLeases = (input.liveLeases || []).filter((lease) => leaseIsLive(lease, nowMs, input.processAlive || processAlive));
  const directorJobIds = new Set(jobs.map((row) => row.jobId));
  const programLeases = liveLeases.filter((lease) => lease.taskId === taskId && directorJobIds.has(String(lease.jobId || "")));
  const byProvider = {};
  for (const lease of programLeases) {
    const provider = String(lease.provider || "unknown");
    byProvider[provider] = Number(byProvider[provider] || 0) + 1;
  }
  const leasedPoolKeys = [...new Set(programLeases.flatMap((lease) => (lease.quotaPoolIds || []).map((poolId) => `${lease.provider}:${poolId}`)))].sort();
  const quota = quotaSnapshot(input.ledger, input.capacity);
  const relevantProviders = new Set([...jobs.map((row) => row.provider), ...programLeases.map((row) => String(row.provider || ""))]);
  const targetedProviders = new Set();
  const targetedProviderWildcards = new Set();
  const targetedPoolKeys = new Set(leasedPoolKeys);
  const targetedQuotaAllocations = new Map();
  const attemptedAllocationIds = new Set(jobs.map((row) => String(row.allocationId || "")).filter(Boolean));
  const activeCampaignAllocationIds = new Set((task.program?.activeCampaign?.allocationIds || []).map(String));
  const boundedUnknownQuotaCandidates = new Map();
  for (const lease of programLeases) {
    const provider = String(lease.provider || "").trim().toLowerCase();
    if (!provider) continue;
    targetedProviders.add(provider);
    if (!(lease.quotaPoolIds || []).length) targetedProviderWildcards.add(provider);
  }
  for (const workPackage of task.program?.workPackages || []) {
    if (!["ready", "dispatched", "running"].includes(String(workPackage.state || ""))) continue;
    const allocation = workPackage.allocation || {};
    const provider = String(allocation.provider || workPackage.assignee?.provider || "").trim().toLowerCase();
    if (!provider) continue;
    targetedProviders.add(provider);
    const reservations = allocation.quotaReservations || [];
    for (const reservation of reservations) {
      const key = String(reservation.poolKey || (reservation.poolId ? provider + ":" + reservation.poolId : "")).trim();
      if (key) targetedPoolKeys.add(key);
      const allocationId = String(allocation.allocationId || "").trim();
      if (key) {
        const targeted = targetedQuotaAllocations.get(key) || new Set();
        targeted.add(allocationId || String(workPackage.workPackageId || ""));
        targetedQuotaAllocations.set(key, targeted);
      }
      const boundedFirstAttempt = workPackage.state === "ready"
        && allocationId
        && activeCampaignAllocationIds.has(allocationId)
        && !attemptedAllocationIds.has(allocationId)
        && Number(allocation.maxAttempts || 0) === 1
        && Number(allocation.tokenLimit || 0) > 0
        && Number(allocation.durationLimitMs || 0) > 0
        && allocation.accountingBasis?.mode === "bounded-wall-time-exclusive-unknown-quota"
        && allocation.accountingBasis?.postRunQuotaRefreshRequired === true
        && reservation.unknownCapacity === true
        && reservation.exclusive === true;
      if (key && boundedFirstAttempt) {
        const candidates = boundedUnknownQuotaCandidates.get(key) || new Set();
        candidates.add(allocationId);
        boundedUnknownQuotaCandidates.set(key, candidates);
      }
    }
    const quotaPool = String(allocation.quotaPool || "").trim();
    if (quotaPool) {
      const key = provider + ":" + quotaPool;
      targetedPoolKeys.add(key);
      const targeted = targetedQuotaAllocations.get(key) || new Set();
      targeted.add(String(allocation.allocationId || workPackage.workPackageId || ""));
      targetedQuotaAllocations.set(key, targeted);
    }
    if (!reservations.length && !quotaPool) targetedProviderWildcards.add(provider);
  }
  const providerBlockers = [];
  for (const [providerId, provider] of Object.entries(quota.providers)) {
    if (!relevantProviders.has(providerId) && !targetedProviders.has(providerId)) continue;
    for (const pool of provider.pools) {
      if (pool.remaining.state !== "unknown") continue;
      const boundedCandidates = boundedUnknownQuotaCandidates.get(pool.key);
      const boundedFirstAttempt = boundedCandidates?.size === 1
        && targetedQuotaAllocations.get(pool.key)?.size === 1
        && !leasedPoolKeys.includes(pool.key);
      const hard = (targetedProviderWildcards.has(providerId) || targetedPoolKeys.has(pool.key)) && !boundedFirstAttempt;
      const row = {
        code: "quota-capacity-unknown",
        provider: providerId,
        poolKey: pool.key,
        metric: "quota",
        hard,
        boundedFirstAttempt,
        reason: boundedFirstAttempt
          ? "One active-campaign allocation has an exclusive, single-attempt wall-time and token cap; quota must be refreshed after it."
          : pool.remaining.reason,
      };
      providerBlockers.push(row);
      if (row.hard) blockers.push(row);
    }
  }
  quota.providerBlockers = providerBlockers;

  const campaign = campaignCount(task, input.campaignCount);
  const durableStorageComplete = !blockers.some((row) =>
    ["program-storage-accounting-incomplete", "program-artifact-bytes-unknown"].includes(row.code)
  );
  const totals = {
    attempts: { known: jobs.length, committed: jobs.length, complete: true },
    tokens: {
      known: knownTokens,
      knownJobs: knownTokenJobs,
      complete: knownTokenJobs === jobs.length,
      committed: tokenCommitComplete ? committedTokens : null,
      committedComplete: tokenCommitComplete,
    },
    durationMs: {
      known: knownDurationMs,
      knownJobs: knownDurationJobs,
      complete: knownDurationJobs === jobs.length,
      committed: durationCommitComplete ? committedDurationMs : null,
      committedComplete: durationCommitComplete,
    },
    artifacts: { known: artifactKeys.size, committed: artifactKeys.size, complete: true },
    durableBytes: { known: durableBytes, committed: durableStorageComplete ? durableBytes : null, complete: durableStorageComplete },
    durableFiles: { known: durableFiles, committed: durableStorageComplete ? durableFiles : null, complete: durableStorageComplete },
  };
  const base = {
    schemaVersion: SCHEMA_VERSION,
    taskId,
    programId,
    campaign,
    jobs,
    totals,
    authorization,
    artifactStorage: receiptStorage,
    concurrency: {
      programActive: programLeases.length,
      globalActive: liveLeases.length,
      byProvider: Object.fromEntries(Object.entries(byProvider).sort(([left], [right]) => left.localeCompare(right))),
      leasedPoolKeys,
      activeJobIds: programLeases.map((row) => String(row.jobId || "")).sort(),
    },
    quota,
    accountingNotes,
    blockers,
  };
  const capCheck = evaluateProgramResourceCaps(base, input.limits || {});
  const result = { ...base, capCheck, safe: blockers.length === 0 && capCheck.safe };
  return { ...result, fingerprint: fingerprint(result) };
}

function buildProgramResourceSnapshot(input = {}) {
  const taskId = safeId(input.taskId, "task");
  const task = input.task || readTask(taskId);
  const programId = String(input.programId || task.program?.programId || task.program?.contracts?.programId || "").trim();
  const jobs = input.jobs || readDirectorJobs(taskId, programId, input);
  const liveLeases = input.liveLeases || readLiveLeases(input);
  const ledger = input.ledger || task.program?.runtime?.ledger || {};
  const capacity = input.capacity || task.capacitySnapshot || {};
  return computeProgramResourceSnapshot({ ...input, taskId, task, programId, jobs, liveLeases, ledger, capacity });
}

module.exports = {
  SCHEMA_VERSION,
  buildProgramResourceSnapshot,
  campaignCount,
  computeProgramResourceSnapshot,
  containedLocalArtifactPath,
  evaluateProgramResourceCaps,
  leaseIsLive,
  allocationAuthorization,
  receiptArtifacts,
  receiptArtifactStorage,
  quotaSnapshot,
  readDirectorJobs,
  readLiveLeases,
  tokenObservation,
};
