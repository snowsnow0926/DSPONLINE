"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  NATIVE_CONSTRUCTION_BELT_REMOVAL_CONTEXT_CAPABILITY,
  NativeCoreSessionRegistry,
  encodeNativeProjectionTransfer,
} = require("./native-host.cjs");
const { normalizeRendererNativeResult } = require("./native-renderer-boundary.cjs");
const { PROJECTION_METHODS } = require("./native-player-authority-projection-broker.cjs");

const request = Object.freeze({
  sessionId: "core-belt-removal",
  expectedRevision: 9,
  expectedRegistryFingerprint: "mod:test",
  beltId: "MOD/传送带-一",
});

function result() {
  return {
    schemaVersion: 1,
    projectionType: "construction-belt-removal-context-v1",
    source: "native-core",
    revision: 9,
    stateVersion: 47,
    registryFingerprint: "mod:test",
    request: {
      expectedRevision: 9,
      expectedRegistryFingerprint: "mod:test",
      beltId: "MOD/传送带-一",
    },
    activePlanetId: "MOD/行星-一",
    beltId: "MOD/传送带-一",
    planetId: "MOD/行星-一",
    sourceId: "MOD/矿机-一",
    targetId: "MOD/仓库-二",
    tier: 3,
    lanes: 4097,
    constructionId: "conveyor_belt_mk3",
    currentConstruction: 5,
    refundAfterRemoval: 4102,
    support: { supported: true, reason: null },
    limits: { projectionBytes: 1048576 },
  };
}

test("ordinary belt removal capability and Host request preserve exact opaque ID", async () => {
  assert.equal(
    NATIVE_CONSTRUCTION_BELT_REMOVAL_CONTEXT_CAPABILITY,
    "native-core-construction-belt-removal-context-v1",
  );
  assert.equal(
    PROJECTION_METHODS["construction-belt-removal-context-v1"],
    "constructionBeltRemovalContext",
  );
  const calls = [];
  const registry = new NativeCoreSessionRegistry({
    hello: { capabilities: [NATIVE_CONSTRUCTION_BELT_REMOVAL_CONTEXT_CAPABILITY] },
    async request(value) { calls.push(value); return result(); },
  });
  registry.sessions.set(request.sessionId, {
    ownerId: "renderer-1", slot: "normal-main", ownerEpoch: 1, state: "owned", inFlight: 0,
  });
  await registry.constructionBeltRemovalContext("renderer-1", request);
  assert.deepEqual(calls, [{ operation: "coreConstructionBeltRemovalContext", ...request }]);
  await assert.rejects(
    Promise.resolve().then(() => registry.constructionBeltRemovalContext("renderer-1", {
      ...request, targetPortIndex: 0,
    })),
    /request is invalid/,
  );
  await assert.rejects(
    Promise.resolve().then(() => registry.constructionBeltRemovalContext("renderer-1", {
      ...request, beltId: "bad\nline",
    })),
    /request is invalid/,
  );
});

test("renderer boundary accepts exact refund and rejects forgery", () => {
  const normalized = normalizeRendererNativeResult(
    "coreConstructionBeltRemovalContext", result(), request,
  );
  assert.equal(normalized.refundAfterRemoval, 4102);
  assert.equal(normalized.request.beltId, "MOD/传送带-一");
  for (const mutate of [
    (value) => { value.revision = 10; },
    (value) => { value.request.beltId = "MOD/另一条"; },
    (value) => { value.beltId = "MOD/另一条"; },
    (value) => { value.refundAfterRemoval = 4103; },
    (value) => { value.constructionId = "conveyor_belt_mk2"; },
    (value) => { value.elevatorOutputIndex = 0; },
  ]) {
    const forged = result();
    mutate(forged);
    assert.throws(
      () => normalizeRendererNativeResult("coreConstructionBeltRemovalContext", forged, request),
      (error) => error?.code === "NATIVE_PROTOCOL_INVALID",
    );
  }
});

test("bounded MessagePort block preserves the removal projection identity", () => {
  const transfer = encodeNativeProjectionTransfer({
    sessionId: request.sessionId,
    sequence: 1,
    projectionType: "construction-belt-removal-context-v1",
    result: result(),
  });
  assert.equal(transfer.header.projectionType, "construction-belt-removal-context-v1");
  assert.equal(transfer.header.revision, 9);
  assert.ok(transfer.payload.byteLength < 1_048_576);
  assert.equal(JSON.parse(transfer.payload).beltId, "MOD/传送带-一");
});

test("unsupported context remains visible but cannot smuggle a refund", () => {
  const unsupported = result();
  unsupported.support = { supported: false, reason: "unsupported-belt-domain" };
  unsupported.refundAfterRemoval = null;
  assert.equal(normalizeRendererNativeResult(
    "coreConstructionBeltRemovalContext", unsupported, request,
  ).support.reason, "unsupported-belt-domain");
  unsupported.refundAfterRemoval = 4102;
  assert.throws(
    () => normalizeRendererNativeResult("coreConstructionBeltRemovalContext", unsupported, request),
    (error) => error?.code === "NATIVE_PROTOCOL_INVALID",
  );
});

test("direct and MessagePort surfaces are wired without App ownership", () => {
  const root = path.resolve(__dirname, "..");
  const main = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf8");
  const preload = fs.readFileSync(path.join(root, "desktop", "preload.cjs"), "utf8");
  const desktop = fs.readFileSync(path.join(root, "src", "desktop.ts"), "utf8");
  const nativeCore = fs.readFileSync(path.join(root, "src", "game", "nativeCore.ts"), "utf8");
  const rustMain = fs.readFileSync(path.join(root, "native", "dsp-native-host", "src", "rpc.rs"), "utf8");
  const rustProtocol = fs.readFileSync(path.join(root, "native", "dsp-native-host", "src", "protocol.rs"), "utf8");
  assert.match(main, /desktop:native-core-construction-belt-removal-context/);
  assert.match(main, /construction-belt-removal-context-v1/);
  assert.match(main, /coreConstructionBeltRemovalContext/);
  assert.match(preload, /getNativeCoreConstructionBeltRemovalContext/);
  assert.match(preload, /construction-belt-removal-context-v1/);
  assert.match(desktop, /DesktopNativeCoreConstructionBeltRemovalContextRequest/);
  assert.match(nativeCore, /constructionBeltRemovalContext/);
  assert.match(rustMain, /native-core-construction-belt-removal-context-v1/);
  assert.match(rustMain, /CoreConstructionBeltRemovalContext/);
  assert.match(rustProtocol, /CoreConstructionBeltRemovalContext/);
});
