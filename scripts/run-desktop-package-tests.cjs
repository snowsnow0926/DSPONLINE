"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const { preflight } = require("./desktop-package-preflight.cjs");
const root = path.resolve(__dirname, "..");
try {
  const verified = preflight(root, { channel: process.env.DSP_RELEASE_CHANNEL || "stable" });
  const runDirectory = path.join(root, "artifacts", `desktop-journey-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(runDirectory, { recursive: false });
  fs.writeFileSync(path.join(runDirectory, "run-context.json"), JSON.stringify({ ...verified, runDirectory }, null, 2));
  process.stdout.write(`Desktop evidence: ${runDirectory}\n`);
  const child = spawn(process.execPath, [require.resolve("@playwright/test/cli"), "test", "--config=playwright.desktop-package.config.ts", ...process.argv.slice(2)], {
    cwd: root, windowsHide: true, stdio: "inherit", env: { ...process.env, DSP_DESKTOP_JOURNEY_RUN_DIR: runDirectory },
  });
  child.once("error", (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 2; });
  child.once("exit", (code) => { process.exitCode = code ?? 1; });
} catch (error) { process.stderr.write(`Desktop preflight BLOCKED: ${error.message}\n`); process.exitCode = 2; }
