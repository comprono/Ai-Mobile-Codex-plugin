"use strict";

const { boundedList } = require("./utils");

const PERMISSION_TO_CAPABILITY = Object.freeze({
  "read-project": "source",
  "read-files": "local-files",
  "write-files": "local-files",
  "run-tests": "tests",
  "run-command": "command",
  database: "database",
  "service-control": "service-control",
  browser: "browser",
  github: "github",
  api: "api",
  "external-write": "external-write",
});

const MUTATING_PERMISSIONS = new Set([
  "write-files",
  "run-command",
  "database",
  "service-control",
  "external-write",
]);

const SIDE_EFFECT_KINDS = new Set([
  "operational-transaction",
  "external-transaction",
]);

function normalizedNames(values, maxItems = 30) {
  return boundedList(values, maxItems, 100).map((value) => value.toLowerCase());
}

function permissionSet(value) {
  if (Array.isArray(value)) return new Set(normalizedNames(value));
  if (!value || typeof value !== "object") return new Set();
  return new Set(Object.entries(value)
    .filter(([, allowed]) => allowed === true)
    .map(([name]) => String(name).toLowerCase()));
}

function capabilityAvailable(provider, name) {
  const capability = String(name || "").toLowerCase();
  if (!capability) return true;
  if (provider?.surfaces?.[capability] === true) return true;
  if (provider?.permissions?.[capability] === true) return true;
  const score = provider?.capabilities?.[capability];
  return score === true || (Number.isFinite(Number(score)) && Number(score) > 0);
}

function providerPermissionAvailable(provider, permission) {
  const key = String(permission || "").toLowerCase();
  if (Object.prototype.hasOwnProperty.call(provider?.permissions || {}, key)) {
    return provider.permissions[key] === true;
  }
  const capability = PERMISSION_TO_CAPABILITY[key] || key;
  if (Object.prototype.hasOwnProperty.call(provider?.permissions || {}, capability)) {
    return provider.permissions[capability] === true;
  }
  if (["command", "database", "service-control", "external-write"].includes(capability)) return false;
  return capabilityAvailable(provider, capability);
}

function structuredCommandsValid(commands) {
  if (!Array.isArray(commands)) return true;
  return commands.every((command) => (
    command
    && typeof command === "object"
    && !Array.isArray(command)
    && String(command.command || "").trim()
    && Array.isArray(command.args)
    && command.args.every((arg) => typeof arg === "string")
    && Number(command.timeoutSeconds || 0) > 0
  ));
}

function sideEffectErrors(workPackage) {
  const kind = String(workPackage?.kind || workPackage?.executorKind || "").toLowerCase();
  const mutatesExternalState = workPackage?.mutatesExternalState === true;
  if (!SIDE_EFFECT_KINDS.has(kind) && !mutatesExternalState) return [];
  const errors = [];
  if (!String(workPackage.sideEffectKey || "").trim()) errors.push("sideEffectKey");
  if (!String(workPackage.observedStateFingerprint || "").trim()) errors.push("observedStateFingerprint");
  if (!Array.isArray(workPackage.preconditions) || !workPackage.preconditions.length) errors.push("preconditions");
  if (!Array.isArray(workPackage.postconditions) || !workPackage.postconditions.length) errors.push("postconditions");
  if (!workPackage.rollback && !String(workPackage.recoveryAction || "").trim()) errors.push("rollback-or-recoveryAction");
  if (kind === "external-transaction" && !String(workPackage.userAuthorizationRef || "").trim()) errors.push("userAuthorizationRef");
  return errors;
}

function preflightAllocation(input = {}) {
  const workPackage = input.workPackage || {};
  const allocation = input.allocation || {};
  const provider = input.provider || {};
  const authorized = permissionSet(input.authorizedPermissions || input.mission?.authorizedPermissions);
  const granted = permissionSet(allocation.permissionGrant || workPackage.permissionGrant);
  const requiredPermissions = normalizedNames(workPackage.requiredPermissions);
  const requiredCapabilities = normalizedNames(workPackage.requiredCapabilities);

  const missingCapabilities = requiredCapabilities.filter((name) => !capabilityAvailable(provider, name));
  const missingAuthorization = requiredPermissions.filter((permission) => (
    MUTATING_PERMISSIONS.has(permission) && !authorized.has(permission)
  ));
  const missingGrant = requiredPermissions.filter((permission) => !granted.has(permission));
  const missingProviderPermissions = requiredPermissions.filter((permission) => !providerPermissionAvailable(provider, permission));
  const invalidSideEffectContract = sideEffectErrors(workPackage);
  const invalidCommands = !structuredCommandsValid(workPackage.commands);
  const providerUnavailable = provider.available !== true || provider.authenticated !== true || provider.headless === false;

  const reasons = [];
  if (providerUnavailable) reasons.push(provider.reason || "provider is unavailable, unauthenticated, or not headless");
  if (missingCapabilities.length) reasons.push("missing callable capabilities: " + missingCapabilities.join(", "));
  if (missingAuthorization.length) reasons.push("permissions exceed project authorization: " + missingAuthorization.join(", "));
  if (missingGrant.length) reasons.push("allocation omitted required permissions: " + missingGrant.join(", "));
  if (missingProviderPermissions.length) reasons.push("provider cannot exercise permissions: " + missingProviderPermissions.join(", "));
  if (invalidSideEffectContract.length) reasons.push("incomplete side-effect contract: " + invalidSideEffectContract.join(", "));
  if (invalidCommands) reasons.push("commands must be structured executable/args/timeout objects");

  return {
    ok: reasons.length === 0,
    failureClass: reasons.length
      ? missingAuthorization.length || invalidSideEffectContract.length
        ? "authorization-or-contract"
        : missingCapabilities.length || missingProviderPermissions.length
          ? "capability-preflight"
          : providerUnavailable
            ? "provider-unavailable"
            : "contract-invalid"
      : "",
    blocker: reasons.join("; "),
    requiredPermissions,
    permissionGrant: [...granted],
    requiredCapabilities,
    missingCapabilities,
    missingAuthorization,
    missingGrant,
    missingProviderPermissions,
    invalidSideEffectContract,
  };
}

function assertAllocationPreflight(input = {}) {
  const result = preflightAllocation(input);
  if (!result.ok) {
    const error = new Error("permission-preflight-failed: " + result.blocker);
    error.code = result.failureClass;
    error.preflight = result;
    throw error;
  }
  return result;
}

module.exports = {
  MUTATING_PERMISSIONS,
  PERMISSION_TO_CAPABILITY,
  assertAllocationPreflight,
  capabilityAvailable,
  permissionSet,
  preflightAllocation,
  providerPermissionAvailable,
  sideEffectErrors,
};
