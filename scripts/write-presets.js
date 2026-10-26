// Writes the built-in presets from src/presets.js to presets/*.json.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const Presets = require("../src/presets.js");

const dir = path.join(__dirname, "..", "presets");
fs.mkdirSync(dir, { recursive: true });
for (const { id, experiment } of Presets.list) {
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(experiment, null, 2) + "\n");
  console.log(`presets/${id}.json`);
}
