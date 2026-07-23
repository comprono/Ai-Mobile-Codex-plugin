#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-mobile-sqlite-snapshot-"));
const source = path.join(root, "live.db");
const destination = path.join(root, "snapshot.db");
const helper = path.join(__dirname, "core", "sqlite-snapshot.js");
let writer;

function runSnapshot(from, to) {
  return spawnSync(process.execPath, [helper, from, to], {
    encoding: "utf8",
    timeout: 30000,
    windowsHide: true,
  });
}

try {
  writer = new DatabaseSync(source);
  writer.exec("PRAGMA journal_mode=WAL");
  writer.exec("PRAGMA wal_autocheckpoint=0");
  writer.exec("CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
  writer.exec("INSERT INTO records(value) VALUES ('checkpointed')");
  writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  writer.exec("INSERT INTO records(value) VALUES ('committed-only-in-wal')");

  const wal = `${source}-wal`;
  assert.equal(fs.existsSync(wal), true, "fixture must retain an active WAL file");
  assert.ok(fs.statSync(wal).size > 0, "fixture WAL must contain committed state");

  const copied = runSnapshot(source, destination);
  assert.equal(copied.status, 0, copied.stderr || copied.stdout);
  const receipt = JSON.parse(copied.stdout.trim());
  assert.deepEqual({ ok: receipt.ok, integrityCheck: receipt.integrityCheck }, { ok: true, integrityCheck: "ok" });

  const snapshot = new DatabaseSync(destination, { readOnly: true });
  try {
    const values = snapshot.prepare("SELECT value FROM records ORDER BY id").all().map((row) => row.value);
    assert.deepEqual(values, ["checkpointed", "committed-only-in-wal"], "online backup must include committed WAL state");
    assert.equal(snapshot.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.equal(String(snapshot.prepare("PRAGMA journal_mode").get().journal_mode).toLowerCase(), "delete", "published snapshot must be a standalone DELETE-journal database");
  } finally {
    snapshot.close();
  }
  assert.equal(fs.existsSync(`${destination}-wal`), false, "read-only snapshot access must not create a WAL sidecar");
  assert.equal(fs.existsSync(`${destination}-shm`), false, "read-only snapshot access must not create a shared-memory sidecar");
  writer.exec("INSERT INTO records(value) VALUES ('after-snapshot')");
  const immutable = new DatabaseSync(destination, { readOnly: true });
  try {
    assert.equal(immutable.prepare("SELECT COUNT(*) AS count FROM records").get().count, 2, "published snapshot must not track later source writes");
  } finally {
    immutable.close();
  }
  assert.equal(fs.existsSync(`${destination}-wal`), false, "repeated read-only access must remain sidecar-free");
  assert.equal(fs.existsSync(`${destination}-shm`), false, "repeated read-only access must remain shared-memory-free");
  assert.equal(fs.readdirSync(root).some((name) => name.includes(".sqlite-snapshot.tmp")), false, "successful publication must remove all temporary snapshot files and sidecars");

  const originalSnapshotBytes = fs.readFileSync(destination);
  const refused = runSnapshot(source, destination);
  assert.notEqual(refused.status, 0, "an existing destination must be rejected");
  assert.match(refused.stderr, /destination already exists.+refusing to overwrite/i);
  assert.deepEqual(fs.readFileSync(destination), originalSnapshotBytes, "overwrite rejection must preserve the existing destination");

  const invalidSource = path.join(root, "not-a-database.txt");
  const invalidDestination = path.join(root, "invalid-snapshot.db");
  fs.writeFileSync(invalidSource, "not sqlite\n", "utf8");
  const invalid = runSnapshot(invalidSource, invalidDestination);
  assert.notEqual(invalid.status, 0, "invalid SQLite input must fail closed");
  assert.equal(fs.existsSync(invalidDestination), false, "failed backup must not publish a destination");

  process.stdout.write(`${JSON.stringify({ ok: true, walStateCaptured: true, standaloneDeleteJournal: true, sidecarFreeReads: true, immutableAfterPublish: true, integrityChecked: true, overwriteRefused: true, invalidInputFailedClosed: true }, null, 2)}\n`);
} finally {
  if (writer) writer.close();
  fs.rmSync(root, { recursive: true, force: true });
}
