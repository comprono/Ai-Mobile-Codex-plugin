#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { DatabaseSync } = require("node:sqlite");

const DEFAULT_LIMITS = Object.freeze({
  maxBytes: 256 * 1024,
  maxTimeMs: 5000,
  maxSchemaObjects: 80,
  maxTables: 48,
  maxColumnsPerTable: 40,
  maxRowsPerTable: 6,
  maxRowsTotal: 180,
  maxCellChars: 800,
  maxSchemaSqlChars: 4000,
});

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function fileSha256(file) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!count) break;
      hash.update(buffer.subarray(0, count));
    }
    return hash.digest("hex");
  } finally {
    fs.closeSync(descriptor);
  }
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, Math.floor(parsed))) : fallback;
}

function normalizeLimits(value = {}) {
  return {
    maxBytes: boundedInteger(value.maxBytes, DEFAULT_LIMITS.maxBytes, 16 * 1024, DEFAULT_LIMITS.maxBytes),
    maxTimeMs: boundedInteger(value.maxTimeMs, DEFAULT_LIMITS.maxTimeMs, 250, DEFAULT_LIMITS.maxTimeMs),
    maxSchemaObjects: boundedInteger(value.maxSchemaObjects, DEFAULT_LIMITS.maxSchemaObjects, 1, DEFAULT_LIMITS.maxSchemaObjects),
    maxTables: boundedInteger(value.maxTables, DEFAULT_LIMITS.maxTables, 1, DEFAULT_LIMITS.maxTables),
    maxColumnsPerTable: boundedInteger(value.maxColumnsPerTable, DEFAULT_LIMITS.maxColumnsPerTable, 1, DEFAULT_LIMITS.maxColumnsPerTable),
    maxRowsPerTable: boundedInteger(value.maxRowsPerTable, DEFAULT_LIMITS.maxRowsPerTable, 1, DEFAULT_LIMITS.maxRowsPerTable),
    maxRowsTotal: boundedInteger(value.maxRowsTotal, DEFAULT_LIMITS.maxRowsTotal, 1, DEFAULT_LIMITS.maxRowsTotal),
    maxCellChars: boundedInteger(value.maxCellChars, DEFAULT_LIMITS.maxCellChars, 32, DEFAULT_LIMITS.maxCellChars),
    maxSchemaSqlChars: boundedInteger(value.maxSchemaSqlChars, DEFAULT_LIMITS.maxSchemaSqlChars, 128, DEFAULT_LIMITS.maxSchemaSqlChars),
  };
}

function clipped(value, maximum) {
  const text = String(value == null ? "" : value);
  return text.length <= maximum ? text : `${text.slice(0, Math.max(0, maximum - 20))}...[truncated:${text.length}]`;
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function quoteSqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sensitiveColumnName(value) {
  const name = String(value || "").trim().toLowerCase();
  const compact = name.replace(/[^a-z0-9]+/g, "");
  return /(?:password|passwd|passcode|pwd|token|secret|apikey|privatekey|cookie|session|credential|authentication|authorization)/.test(compact)
    || /(?:^|[^a-z0-9])auth(?:$|[^a-z0-9])/.test(name);
}

function normalizeCell(value, limits, columnName) {
  if (value !== null && sensitiveColumnName(columnName)) return { type: "redacted" };
  if (value === null || typeof value === "number") return value;
  if (typeof value === "bigint") return { type: "integer", value: String(value) };
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const bytes = Buffer.from(value);
    return { type: "blob", bytes: bytes.length, sha256: sha256(bytes) };
  }
  return clipped(value, limits.maxCellChars);
}

function serializedBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function assertWithinDeadline(deadline) {
  if (performance.now() > deadline) throw new Error("sqlite-observation-time-limit-exceeded");
}

function statementAll(database, sql, deadline) {
  assertWithinDeadline(deadline);
  const rows = database.prepare(sql).all();
  assertWithinDeadline(deadline);
  return rows;
}

function tableColumns(database, name, limits, deadline) {
  const rows = statementAll(database, `PRAGMA table_xinfo(${quoteSqlString(name)})`, deadline);
  return rows.slice(0, limits.maxColumnsPerTable).map((row) => ({
    name: clipped(row.name, 240),
    type: clipped(row.type, 160),
    notNull: Number(row.notnull || 0) === 1,
    primaryKeyOrder: Number(row.pk || 0),
    hidden: Number(row.hidden || 0),
  }));
}

function sampleTable(database, schemaRow, columns, limits, remainingRows, deadline) {
  if (!columns.length || remainingRows <= 0) return { order: "none", rows: [], hasMore: false };
  const selected = columns.map((column) => quoteIdentifier(column.name)).join(", ");
  const wanted = Math.min(limits.maxRowsPerTable, remainingRows);
  const primary = columns.filter((column) => column.primaryKeyOrder > 0).sort((left, right) => left.primaryKeyOrder - right.primaryKeyOrder);
  const withoutRowId = /\bWITHOUT\s+ROWID\b/i.test(String(schemaRow.sql || ""));
  const candidates = [];
  if (!withoutRowId) candidates.push({ order: "rowid-desc", clause: " ORDER BY rowid DESC" });
  if (primary.length) candidates.push({
    order: "primary-key-desc",
    clause: ` ORDER BY ${primary.map((column) => `${quoteIdentifier(column.name)} DESC`).join(", ")}`,
  });
  candidates.push({ order: "storage-order", clause: "" });
  let lastError = null;
  for (const candidate of candidates) {
    try {
      const rows = statementAll(
        database,
        `SELECT ${selected} FROM ${quoteIdentifier(schemaRow.name)}${candidate.clause} LIMIT ${wanted + 1}`,
        deadline,
      );
      const hasMore = rows.length > wanted;
      return {
        order: candidate.order,
        rows: rows.slice(0, wanted).map((row) => Object.fromEntries(
          Object.entries(row).map(([key, value]) => [key, normalizeCell(value, limits, key)]),
        )),
        hasMore,
      };
    } catch (error) {
      if (String(error?.message || "").includes("time-limit-exceeded")) throw error;
      lastError = error;
    }
  }
  return { order: "unavailable", rows: [], hasMore: false, error: clipped(lastError?.message || "sample query failed", 500) };
}

function fitTable(receipt, record, limits) {
  receipt.tables.push(record);
  while (record.sampleRows.length && serializedBytes(receipt) > limits.maxBytes - 512) record.sampleRows.pop();
  if (serializedBytes(receipt) <= limits.maxBytes - 512) return true;
  receipt.tables.pop();
  return false;
}

function createSqliteObservationReceipt(input = {}) {
  const databaseFile = path.resolve(String(input.databaseFile || ""));
  const sourceId = String(input.sourceId || "").trim();
  const expectedSnapshotHash = String(input.snapshotContentHash || "").trim().toLowerCase();
  const limits = normalizeLimits(input.limits);
  if (!sourceId) throw new Error("sqlite observation requires sourceId");
  if (!/^[a-f0-9]{64}$/.test(expectedSnapshotHash)) throw new Error("sqlite observation requires a complete snapshot SHA-256");
  const stat = fs.lstatSync(databaseFile);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("sqlite observation source must be a regular non-link file");
  const actualSnapshotHash = fileSha256(databaseFile);
  if (actualSnapshotHash !== expectedSnapshotHash) throw new Error("sqlite observation snapshot hash mismatch");

  const started = performance.now();
  const deadline = started + limits.maxTimeMs;
  let database;
  try {
    database = new DatabaseSync(databaseFile, { readOnly: true });
    database.exec("PRAGMA query_only=ON");
    database.exec("PRAGMA trusted_schema=OFF");
    const integrity = statementAll(database, "PRAGMA integrity_check", deadline)
      .flatMap((row) => Object.values(row)).map((value) => String(value).toLowerCase());
    if (integrity.length !== 1 || integrity[0] !== "ok") throw new Error("sqlite observation integrity check failed");

    const allSchema = statementAll(database, [
      "SELECT type, name, tbl_name AS tableName, sql",
      "FROM sqlite_schema",
      "WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'view')",
      "ORDER BY type, name",
    ].join(" "), deadline);
    const selectedSchema = allSchema.slice(0, limits.maxSchemaObjects);
    const receipt = {
      schemaVersion: "director-cfo/sqlite-observation-receipt@1",
      sourceId,
      snapshot: {
        contentHash: actualSnapshotHash,
        bytes: stat.size,
        integrityCheck: "ok",
      },
      limits,
      schemaObjects: selectedSchema.map((row) => ({
        type: String(row.type),
        name: clipped(row.name, 240),
        tableName: clipped(row.tableName, 240),
        sql: clipped(row.sql, limits.maxSchemaSqlChars),
      })),
      tables: [],
      rowsIncluded: 0,
      truncated: allSchema.length > selectedSchema.length,
      truncationReasons: allSchema.length > selectedSchema.length ? ["schema-object-limit"] : [],
    };

    const tables = selectedSchema.filter((row) => row.type === "table").slice(0, limits.maxTables);
    if (selectedSchema.filter((row) => row.type === "table").length > tables.length) {
      receipt.truncated = true;
      receipt.truncationReasons.push("table-limit");
    }
    for (const schemaRow of tables) {
      assertWithinDeadline(deadline);
      if (receipt.rowsIncluded >= limits.maxRowsTotal) {
        receipt.truncated = true;
        receipt.truncationReasons.push("row-limit");
        break;
      }
      const columns = tableColumns(database, schemaRow.name, limits, deadline);
      const sample = sampleTable(database, schemaRow, columns, limits, limits.maxRowsTotal - receipt.rowsIncluded, deadline);
      const record = {
        name: clipped(schemaRow.name, 240),
        columns,
        sampleOrder: sample.order,
        sampleRows: sample.rows,
        hasMoreRows: sample.hasMore,
        sampleError: sample.error || "",
      };
      if (!fitTable(receipt, record, limits)) {
        receipt.truncated = true;
        receipt.truncationReasons.push("byte-limit");
        break;
      }
      receipt.rowsIncluded += record.sampleRows.length;
      if (record.sampleRows.length < sample.rows.length) {
        receipt.truncated = true;
        receipt.truncationReasons.push("byte-limit");
        break;
      }
    }
    receipt.truncationReasons = [...new Set(receipt.truncationReasons)].sort();
    assertWithinDeadline(deadline);
    const receiptFingerprint = sha256(Buffer.from(JSON.stringify(stable(receipt)), "utf8"));
    const complete = { ...receipt, receiptFingerprint };
    if (serializedBytes(complete) > limits.maxBytes) throw new Error("sqlite-observation-byte-limit-exceeded");
    return complete;
  } finally {
    if (database) database.close();
  }
}

function writeReceipt(destinationValue, receipt) {
  const destination = path.resolve(String(destinationValue || ""));
  const parent = path.dirname(destination);
  const parentStat = fs.lstatSync(parent);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) throw new Error("sqlite observation destination parent must be a real directory");
  const text = `${JSON.stringify(receipt)}\n`;
  fs.writeFileSync(destination, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return { bytes: Buffer.byteLength(text), fileHash: fileSha256(destination) };
}

function main() {
  if (process.argv.length !== 6) {
    throw new Error("usage: node sqlite-observation.js <database> <destination> <source-id> <snapshot-sha256>");
  }
  const receipt = createSqliteObservationReceipt({
    databaseFile: process.argv[2],
    sourceId: process.argv[4],
    snapshotContentHash: process.argv[5],
  });
  const written = writeReceipt(process.argv[3], receipt);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    receiptFingerprint: receipt.receiptFingerprint,
    snapshotContentHash: receipt.snapshot.contentHash,
    rowsIncluded: receipt.rowsIncluded,
    truncated: receipt.truncated,
    ...written,
  })}\n`);
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    process.stderr.write(`sqlite-observation: ${error?.message || String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_LIMITS,
  createSqliteObservationReceipt,
  normalizeLimits,
  sensitiveColumnName,
  writeReceipt,
};
