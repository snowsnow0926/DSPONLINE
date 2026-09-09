const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, mkdtempSync, rmSync, realpathSync } = require("node:fs");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

function availableElectron() {
  const configured = process.env.DSP_ELECTRON_BINARY;
  const candidates = [
    configured,
    path.resolve("node_modules/electron/dist/electron.exe"),
    path.resolve("release-tools/electron-v43.1.1-win32-x64/electron.exe"),
    path.resolve("../DSPidle2/release-tools/electron-v43.1.1-win32-x64/electron.exe"),
  ].filter(Boolean);
  return candidates.find(existsSync) ?? null;
}

test("Electron MessagePort streams a 30 MiB binary payload with ACK backpressure in both directions", { skip: process.platform !== "win32" || !availableElectron() }, () => {
  const electron = availableElectron();
  assert.ok(electron);
  const profile = mkdtempSync(path.join(os.tmpdir(), "dsp-transfer-smoke-"));
  let result;
  try {
    result = spawnSync(electron, [path.resolve("desktop/message-port-transfer-smoke.cjs")], {
      windowsHide: true,
      encoding: "utf8",
      timeout: 45_000,
      env: { ...process.env, DSP_ELECTRON_TRANSFER_SMOKE_BYTES: String(30 * 1024 * 1024), DSP_ELECTRON_TRANSFER_SMOKE_PROFILE: profile },
    });
  } finally {
    // Only remove the exact directory just allocated by this fixture, after the
    // owned Electron process has exited. Never remove a caller-selected profile.
    assert.equal(realpathSync(path.dirname(profile)), realpathSync(os.tmpdir()));
    assert.match(path.basename(profile), /^dsp-transfer-smoke-[A-Za-z0-9]+$/);
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const receipt = result.stdout.split(/\r?\n/).find(line => line.startsWith("DSP_TRANSFER_BACKGROUND "));
  assert.ok(receipt, "actual Electron must report its background audit");
  assert.deepEqual(JSON.parse(receipt.slice("DSP_TRANSFER_BACKGROUND ".length)), {
    policy: "hidden-no-focus-offscreen-v2", windowsCreated: 1, initiallyVisible: 0,
    showEvents: 0, focusEvents: 0, bytes: 30 * 1024 * 1024, muted: true,
    focusable: false, frameRate: 60, isolatedProfile: true,
  });
  console.log(receipt);
});
