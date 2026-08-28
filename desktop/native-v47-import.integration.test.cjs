const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { NativeHostClient } = require("./native-host.cjs");
const { normalizeRendererNativeResult } = require("./native-renderer-boundary.cjs");

const binaryPath = path.join(__dirname, "..", "native", "target", "release", "dsp-native-host.exe");

function checksumState(state) {
  const text = JSON.stringify({ formatVersion: 2, state });
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function catalog() {
  return {
    protocolVersion: 1,
    registryFingerprint: "builtin:test",
    planets: [{
      id: "home", name: "home", systemId: "helios", kind: "terrestrial",
      orbitIndex: 1, simulationOrder: 0, orbitalYields: {},
    }],
    items: [{ id: "iron_ore", name: "iron_ore", kind: "solid" }],
    buildings: [{
      id: "mining_machine", kind: "miner", speed: 1, inputCapacity: 0,
      outputCapacity: 50, powerDemandKw: 1, powerGenerationKw: 0,
    }],
    recipes: [], constructions: [], belts: [{ tier: 1, speed: 6 }],
    proliferators: [], technologies: [],
  };
}

function envelopeBytes(statePatch = {}) {
  const state = {
    version: 47,
    mode: "normal",
    activePlanetId: "home",
    elapsedSeconds: 2,
    paused: false,
    tray: {},
    entities: [],
    belts: [],
    ...statePatch,
  };
  return Buffer.from(JSON.stringify({
    formatVersion: 2,
    kind: "primary",
    savedAt: 42,
    mode: "normal",
    slot: "main",
    state,
    checksum: checksumState(state),
  }), "utf8");
}

test("native host streams a main-selected v47 file and preserves the old checkpoint on validation failure", {
  skip: process.platform !== "win32" || !fs.existsSync(binaryPath)
    ? "release native host has not been built on Windows"
    : false,
  timeout: 60_000,
}, async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-native-v47-import-"));
  const rootPath = path.join(temporary, "native-root");
  const sourcePath = path.join(temporary, "selected-save.json");
  fs.mkdirSync(rootPath, { recursive: true });
  const bytes = envelopeBytes();
  fs.writeFileSync(sourcePath, bytes);
  const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
  const client = new NativeHostClient({ binaryPath, rootPath, requestTimeoutMs: 30_000 });
  t.after(async () => {
    await client.stop();
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  const hello = await client.start("v47-import-test");
  assert.ok(hello.capabilities.includes("native-core-v47-stream-import-v1"));
  const imported = await client.request({
    operation: "coreImportV47",
    sourcePath,
    registryFingerprint: "builtin:test",
    catalog: catalog(),
  }, 30_000);
  assert.doesNotThrow(() => normalizeRendererNativeResult("coreImport", imported));
  assert.equal(imported.authority, "shadow");
  assert.equal(imported.import.sourceSha256, sourceSha256);
  assert.equal(imported.import.sourceByteLength, bytes.byteLength);
  assert.equal(imported.summary.stateVersion, 47);
  assert.equal(imported.summary.entityCount, 0);
  assert.equal(imported.checkpoint.generation, 1);
  assert.equal(createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex"), sourceSha256);
  const published = await client.request({ operation: "saveRecover", slot: "normal-main" });
  assert.equal(published.generation, imported.checkpoint.generation);
  assert.equal(published.rootHash, imported.checkpoint.rootHash);

  const corrupt = JSON.parse(bytes.toString("utf8"));
  corrupt.state.elapsedSeconds = 3;
  fs.writeFileSync(sourcePath, JSON.stringify(corrupt));
  await assert.rejects(client.request({
    operation: "coreImportV47",
    sourcePath,
    registryFingerprint: "builtin:test",
    catalog: catalog(),
  }, 30_000), /checksum/i);
  const after = await client.request({ operation: "saveRecover", slot: "normal-main" });
  assert.equal(after.generation, published.generation);
  assert.equal(after.rootHash, published.rootHash);
  assert.equal(after.revision, published.revision);

  const loneSurrogateBytes = envelopeBytes({ modCompatibilityProbe: "\ud800" });
  assert.ok(loneSurrogateBytes.includes(Buffer.from("\\ud800", "ascii")));
  const javascriptRoundTrip = JSON.parse(loneSurrogateBytes.toString("utf8"));
  assert.equal(javascriptRoundTrip.state.modCompatibilityProbe.charCodeAt(0), 0xd800);
  fs.writeFileSync(sourcePath, loneSurrogateBytes);
  const loneSurrogateSha256 = createHash("sha256").update(loneSurrogateBytes).digest("hex");
  await assert.rejects(client.request({
    operation: "coreImportV47",
    sourcePath,
    registryFingerprint: "builtin:test",
    catalog: catalog(),
  }, 30_000), (error) => {
    assert.equal(error.code, "NATIVE_V47_IMPORT_JS_COMPATIBILITY_REQUIRED");
    assert.match(error.message, /native-unrepresentable/i);
    assert.match(error.message, /JavaScript compatibility importer/i);
    return true;
  });
  assert.equal(
    createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex"),
    loneSurrogateSha256,
  );
  const afterCompatibilityFallback = await client.request({ operation: "saveRecover", slot: "normal-main" });
  assert.equal(afterCompatibilityFallback.generation, published.generation);
  assert.equal(afterCompatibilityFallback.rootHash, published.rootHash);
  assert.equal(afterCompatibilityFallback.revision, published.revision);
});
