"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { test } = require("node:test");

const ENTRYPOINTS = [
  "desktop/main.cjs",
  "desktop/preload.cjs",
  "desktop/native-host.cjs",
  "desktop/pack.cjs",
];

test("Electron entrypoints remain syntactically loadable after release merges", () => {
  for (const relativePath of ENTRYPOINTS) {
    const filePath = path.resolve(relativePath);
    const result = spawnSync(process.execPath, ["--check", filePath], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(
      result.status,
      0,
      `${relativePath} failed node --check\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
});
