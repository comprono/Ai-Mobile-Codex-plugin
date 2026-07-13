"use strict";

const path = require("node:path");
const { readJson } = require("../core/utils");

function pluginVersion() {
  return readJson(path.resolve(__dirname, "..", "..", ".codex-plugin", "plugin.json"), {}).version || "unknown";
}

module.exports = { pluginVersion };
