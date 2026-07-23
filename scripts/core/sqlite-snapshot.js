#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync, backup } = require("node:sqlite");

function existingPathKind(file) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) return "symbolic link";
    if (stat.isDirectory()) return "directory";
    if (stat.isFile()) return "file";
    return "filesystem entry";
  } catch (error) {
    if (error && error.code === "ENOENT") return "";
    throw error;
  }
}

function reserveTemporaryDatabase(destination) {
  const directory = path.dirname(destination);
  const base = path.basename(destination);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = path.join(directory, `.${base}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.sqlite-snapshot.tmp`);
    try {
      const descriptor = fs.openSync(candidate, "wx", 0o600);
      fs.closeSync(descriptor);
      return candidate;
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
    }
  }
  throw new Error("could not reserve a unique temporary snapshot file");
}

function assertIntegrity(databaseFile) {
  let database;
  try {
    database = new DatabaseSync(databaseFile, { readOnly: true });
    const rows = database.prepare("PRAGMA integrity_check").all();
    const messages = rows.flatMap((row) => Object.values(row)).map((value) => String(value));
    if (messages.length !== 1 || messages[0].toLowerCase() !== "ok") {
      throw new Error(`destination failed PRAGMA integrity_check: ${messages.join("; ") || "no result"}`);
    }
  } finally {
    if (database) database.close();
  }
}

function normalizeStandaloneDatabase(databaseFile) {
  let database;
  try {
    database = new DatabaseSync(databaseFile);
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const row = database.prepare("PRAGMA journal_mode=DELETE").get();
    const mode = String(row?.journal_mode || Object.values(row || {})[0] || "").toLowerCase();
    if (mode !== "delete") throw new Error(`snapshot journal mode remained ${mode || "unknown"}`);
  } finally {
    if (database) database.close();
  }
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try { fs.rmSync(databaseFile + suffix, { force: true }); } catch { /* final cleanup handles an orphan */ }
  }
}

async function backupSqliteSnapshot(sourceValue, destinationValue) {
  if (!sourceValue || !destinationValue) throw new Error("source and destination paths are required");
  const source = path.resolve(String(sourceValue));
  const destination = path.resolve(String(destinationValue));
  if (source === destination) throw new Error("source and destination must be different paths");

  const sourceKind = existingPathKind(source);
  if (sourceKind !== "file") {
    throw new Error(sourceKind ? `source must be a regular file, not a ${sourceKind}` : `source database does not exist: ${source}`);
  }

  const destinationKind = existingPathKind(destination);
  if (destinationKind) throw new Error(`destination already exists as a ${destinationKind}; refusing to overwrite: ${destination}`);
  const destinationDirectory = path.dirname(destination);
  const directoryStat = fs.lstatSync(destinationDirectory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error("destination parent must be an existing real directory");
  }

  const sourceRealPath = fs.realpathSync(source);
  if (sourceRealPath === destination) throw new Error("source and destination resolve to the same path");

  const temporary = reserveTemporaryDatabase(destination);
  let sourceDatabase;
  let publishedDestination = false;
  try {
    sourceDatabase = new DatabaseSync(sourceRealPath, { readOnly: true });
    await backup(sourceDatabase, temporary);
    sourceDatabase.close();
    sourceDatabase = null;

    normalizeStandaloneDatabase(temporary);
    assertIntegrity(temporary);
    const descriptor = fs.openSync(temporary, "r+");
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }

    try {
      fs.copyFileSync(temporary, destination, fs.constants.COPYFILE_EXCL);
      publishedDestination = true;
    } catch (error) {
      if (error && error.code === "EEXIST") {
        throw new Error(`destination appeared during snapshot; refusing to overwrite: ${destination}`);
      }
      throw error;
    }
    const destinationDescriptor = fs.openSync(destination, "r+");
    try {
      fs.fsyncSync(destinationDescriptor);
    } finally {
      fs.closeSync(destinationDescriptor);
    }
    assertIntegrity(destination);
    fs.rmSync(temporary, { force: true });
    return { destination, bytes: fs.statSync(destination).size, integrityCheck: "ok" };
  } catch (error) {
    if (publishedDestination) {
      try { fs.rmSync(destination, { force: true }); } catch { /* enclosing snapshot cleanup remains authoritative */ }
    }
    throw error;
  } finally {
    if (sourceDatabase) sourceDatabase.close();
    try { fs.rmSync(temporary, { force: true }); } catch { /* startup storage cleanup can remove an orphan */ }
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      try { fs.rmSync(temporary + suffix, { force: true }); } catch { /* startup storage cleanup can remove an orphan */ }
    }
  }
}

async function main() {
  if (process.argv.length !== 4) throw new Error("usage: node sqlite-snapshot.js <source> <destination>");
  const result = await backupSqliteSnapshot(process.argv[2], process.argv[3]);
  process.stdout.write(`${JSON.stringify({ ok: true, bytes: result.bytes, integrityCheck: result.integrityCheck })}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`sqlite-snapshot: ${error && error.message ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { assertIntegrity, backupSqliteSnapshot, normalizeStandaloneDatabase };
