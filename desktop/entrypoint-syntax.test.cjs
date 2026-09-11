"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const vm = require("node:vm");
const { createHash: nativeHash } = require("node:crypto");

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

test("bundled preload initializes with only sandbox-supported electron require", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-preload-test-"));
  const output = path.join(directory, "preload.cjs");
  const { buildDesktopPreload } = await import("../scripts/build-desktop-preload.mjs");
  await buildDesktopPreload(output);
  let exposed;
  const ipcRenderer = { on() {}, removeListener() {}, invoke: async () => true, send() {} };
  vm.runInNewContext(fs.readFileSync(output, "utf8"), {
    require(name) { assert.equal(name, "electron"); return { contextBridge: { exposeInMainWorld(name, bridge) { assert.equal(name, "dspDesktop"); exposed = bridge; } }, ipcRenderer }; },
    Buffer, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, crypto: globalThis.crypto,
    process: { platform: "win32" }, setTimeout, clearTimeout, console,
  });
  assert.equal(typeof exposed.confirmClose, "function");
  assert.equal(typeof exposed.onPrepareClose, "function");
  assert.equal(await exposed.confirmClose({ token: "test", ok: true }), true);
});

test("sandbox incremental SHA-256 matches Node for text, chunks and offset views", () => {
  const { createHash } = require("./sandbox-crypto.cjs");
  const bytes = Buffer.alloc(1024 * 1024 + 29, 137);
  const parts = ["固定工厂 😀", bytes.subarray(13, 100003), bytes.subarray(100003)];
  const browser = createHash("sha256"); const native = nativeHash("sha256");
  for (const part of parts) { browser.update(part); native.update(part); }
  assert.equal(browser.digest("hex"), native.digest("hex"));
  assert.throws(() => browser.update("after finalize"));
  assert.throws(() => createHash("md5"));
});
