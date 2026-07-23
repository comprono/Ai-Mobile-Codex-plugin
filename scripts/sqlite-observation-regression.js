#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { createSqliteObservationReceipt } = require("./core/sqlite-observation");

function fileHash(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-mobile-sqlite-observation-"));
const databaseFile = path.join(root, "snapshot.db");
const receiptFile = path.join(root, "receipt.json");
const helper = path.join(__dirname, "core", "sqlite-observation.js");
let database;

try {
  database = new DatabaseSync(databaseFile);
  database.exec([
    "CREATE TABLE applications (id INTEGER PRIMARY KEY, status TEXT NOT NULL, created_at TEXT NOT NULL)",
    "CREATE TABLE events (id INTEGER PRIMARY KEY, application_id INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT)",
    "CREATE TABLE binary_evidence (id INTEGER PRIMARY KEY, payload BLOB NOT NULL)",
    "CREATE TABLE privacy_evidence (id INTEGER PRIMARY KEY, password TEXT, access_token TEXT, client_secret TEXT, api_key TEXT, cookie TEXT, session_id TEXT, auth_header TEXT, credential TEXT, status TEXT, url TEXT)",
  ].join("; "));
  const insertApplication = database.prepare("INSERT INTO applications(status, created_at) VALUES (?, ?)");
  const insertEvent = database.prepare("INSERT INTO events(application_id, kind, detail) VALUES (?, ?, ?)");
  for (let index = 1; index <= 20; index += 1) {
    insertApplication.run(index === 20 ? "SUBMITTED_VERIFIED" : "DISCOVERED", `2026-07-21T20:${String(index).padStart(2, "0")}:00Z`);
    insertEvent.run(index, index === 20 ? "submitted_verified" : "observed", `detail-${index}-${"x".repeat(1000)}`);
  }
  database.prepare("INSERT INTO binary_evidence(payload) VALUES (?)").run(Buffer.from("private-binary-evidence"));
  database.prepare("INSERT INTO privacy_evidence(password, access_token, client_secret, api_key, cookie, session_id, auth_header, credential, status, url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "PASSWORD_SENTINEL_55f2",
    "TOKEN_SENTINEL_3e61",
    "SECRET_SENTINEL_77cb",
    "API_KEY_SENTINEL_194a",
    "COOKIE_SENTINEL_e803",
    "SESSION_SENTINEL_c22b",
    "AUTH_SENTINEL_9df1",
    "CREDENTIAL_SENTINEL_f60a",
    "SUBMITTED_VERIFIED",
    "https://example.test/application/42",
  );
  database.close();
  database = null;

  const beforeHash = fileHash(databaseFile);
  const limits = {
    maxBytes: 32 * 1024,
    maxTimeMs: 3000,
    maxSchemaObjects: 10,
    maxTables: 10,
    maxColumnsPerTable: 12,
    maxRowsPerTable: 3,
    maxRowsTotal: 12,
    maxCellChars: 80,
    maxSchemaSqlChars: 500,
  };
  const started = performance.now();
  const first = createSqliteObservationReceipt({
    databaseFile,
    sourceId: "job-vibhu-harness-db",
    snapshotContentHash: beforeHash,
    limits,
  });
  const elapsedMs = performance.now() - started;
  const second = createSqliteObservationReceipt({
    databaseFile,
    sourceId: "job-vibhu-harness-db",
    snapshotContentHash: beforeHash,
    limits,
  });

  assert.deepEqual(second, first, "An unchanged immutable database and limits must produce an identical receipt.");
  assert.equal(first.schemaVersion, "director-cfo/sqlite-observation-receipt@1");
  assert.equal(first.snapshot.contentHash, beforeHash);
  assert.equal(first.snapshot.integrityCheck, "ok");
  assert.ok(first.receiptFingerprint.match(/^[a-f0-9]{64}$/));
  assert.ok(first.rowsIncluded <= limits.maxRowsTotal);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= limits.maxBytes);
  assert.ok(elapsedMs <= limits.maxTimeMs + 500, `Observation exceeded its time envelope: ${elapsedMs}ms`);
  assert.equal(fileHash(databaseFile), beforeHash, "Read-only observation must not mutate the immutable database.");
  assert.equal(fs.existsSync(`${databaseFile}-wal`), false);
  assert.equal(fs.existsSync(`${databaseFile}-shm`), false);
  assert.equal(JSON.stringify(first).includes(databaseFile), false, "Receipt must not expose its host filesystem path.");

  const applications = first.tables.find((row) => row.name === "applications");
  assert.ok(applications, "Receipt omitted a bounded table observation.");
  assert.equal(applications.sampleOrder, "rowid-desc");
  assert.equal(applications.sampleRows[0].status, "SUBMITTED_VERIFIED", "Newest canonical state must be visible to Read/Glob/Grep workers.");
  const binary = first.tables.find((row) => row.name === "binary_evidence");
  assert.equal(binary.sampleRows[0].payload.type, "blob");
  assert.equal(binary.sampleRows[0].payload.bytes, Buffer.byteLength("private-binary-evidence"));
  assert.ok(binary.sampleRows[0].payload.sha256.match(/^[a-f0-9]{64}$/), "Binary content must be represented by bounded metadata, not copied into the receipt.");

  const privacy = first.tables.find((row) => row.name === "privacy_evidence");
  assert.ok(privacy, "Receipt omitted the privacy fixture table.");
  for (const column of ["password", "access_token", "client_secret", "api_key", "cookie", "session_id", "auth_header", "credential"]) {
    assert.deepEqual(privacy.sampleRows[0][column], { type: "redacted" }, `Sensitive column ${column} was copied into the observation receipt.`);
  }
  assert.equal(privacy.sampleRows[0].status, "SUBMITTED_VERIFIED", "Useful status fields must remain observable.");
  assert.equal(privacy.sampleRows[0].url, "https://example.test/application/42", "Useful URL fields must remain observable.");
  for (const sentinel of ["PASSWORD_SENTINEL", "TOKEN_SENTINEL", "SECRET_SENTINEL", "API_KEY_SENTINEL", "COOKIE_SENTINEL", "SESSION_SENTINEL", "AUTH_SENTINEL", "CREDENTIAL_SENTINEL"]) {
    assert.equal(JSON.stringify(first).includes(sentinel), false, `Receipt leaked ${sentinel}.`);
  }

  assert.throws(() => createSqliteObservationReceipt({
    databaseFile,
    sourceId: "job-vibhu-harness-db",
    snapshotContentHash: "0".repeat(64),
    limits,
  }), /snapshot hash mismatch/);

  const cli = spawnSync(process.execPath, [helper, databaseFile, receiptFile, "job-vibhu-harness-db", beforeHash], {
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true,
  });
  assert.equal(cli.status, 0, cli.stderr || cli.stdout);
  const summary = JSON.parse(cli.stdout.trim());
  const persisted = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
  assert.equal(summary.ok, true);
  assert.equal(summary.receiptFingerprint, persisted.receiptFingerprint);
  assert.equal(persisted.snapshot.contentHash, beforeHash);
  const overwrite = spawnSync(process.execPath, [helper, databaseFile, receiptFile, "job-vibhu-harness-db", beforeHash], {
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true,
  });
  assert.notEqual(overwrite.status, 0, "Observation helper must refuse to overwrite a receipt boundary.");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    deterministic: true,
    snapshotHashBound: true,
    rowCapped: true,
    byteCapped: true,
    timeCapped: true,
    readOnly: true,
    newestRowsVisible: true,
    sensitiveColumnsRedacted: true,
    usefulStatusAndUrlVisible: true,
    overwriteRefused: true,
  }, null, 2)}\n`);
} finally {
  if (database) database.close();
  fs.rmSync(root, { recursive: true, force: true });
}
