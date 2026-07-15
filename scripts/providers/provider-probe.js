#!/usr/bin/env node
"use strict";

const { discoverProvider } = require(".");

const id = process.argv[2] || "";
try {
  process.stdout.write(`${JSON.stringify({ ...discoverProvider(id), observedAt: new Date().toISOString() })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ id, available: false, authenticated: false, confidence: "unknown", models: [], reason: `Passive provider probe failed: ${error.message}` })}\n`);
}
