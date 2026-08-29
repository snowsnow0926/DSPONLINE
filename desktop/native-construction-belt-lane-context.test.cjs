"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  NATIVE_CONSTRUCTION_BELT_LANE_CONTEXT_CAPABILITY,
  NativeCoreSessionRegistry,
  encodeNativeProjectionTransfer,
} = require("./native-host.cjs");
const { normalizeRendererNativeResult } = require("./native-renderer-boundary.cjs");
const { PROJECTION_METHODS } = require("./native-player-authority-projection-broker.cjs");

const request = Object.freeze({
  sessionId: "core-belt-lanes",
  expectedRevision: 9,
  expectedRegistryFingerprint: "mod:test",
  beltId: "MOD/传送带-一",
  targetLanes: 6,
});

function result() {
  return {
    schemaVersion: 1,
    projectionType: "construction-belt-lane-context-v1",
    source: "native-core",
    revision: 9,
    stateVersion: 47,
    registryFingerprint: "mod:test",
    request: {
      expectedRevision: 9,
      expectedRegistryFingerprint: "mod:test",
      beltId: "MOD/传送带-一",
      targetLanes: 6,
    },
    activePlanetId: "MOD/行星-一",
    beltId: "MOD/传送带-一",
    planetId: "MOD/行星-一",
    sourceId: "MOD/矿机-一",
    targetId: "MOD/仓库-二",
    itemId: "mod_item",
    tier: 3,
    currentLanes: 4,
    targetLanes: 6,
    constructionId: "conveyor_belt_mk3",
    currentConstruction: 5,
    laneDelta: 2,
    constructionAfterAdjustment: 3,
    support: { supported: true, reason: null },
    limits: { maxPlayerLanes: 4096, projectionBytes: 1048576 },
  };
}

test("ordinary belt lane capability and Host request preserve exact opaque ID", async () => {
  assert.equal(NATIVE_CONSTRUCTION_BELT_LANE_CONTEXT_CAPABILITY, "native-core-construction-belt-lane-context-v1");
  assert.equal(PROJECTION_METHODS["construction-belt-lane-context-v1"], "constructionBeltLaneContext");
  const calls = [];
  const registry = new NativeCoreSessionRegistry({
    hello: { capabilities: [NATIVE_CONSTRUCTION_BELT_LANE_CONTEXT_CAPABILITY] },
    async request(value) { calls.push(value); return result(); },
  });
  registry.sessions.set(request.sessionId, {
    ownerId: "renderer-1", slot: "normal-main", ownerEpoch: 1, state: "owned", inFlight: 0,
  });
  await registry.constructionBeltLaneContext("renderer-1", request);
  assert.deepEqual(calls, [{ operation: "coreConstructionBeltLaneContext", ...request }]);
  await assert.rejects(
    Promise.resolve().then(() => registry.constructionBeltLaneContext("renderer-1", { ...request, tier: 3 })),
    /request is invalid/,
  );
  await assert.rejects(
    Promise.resolve().then(() => registry.constructionBeltLaneContext("renderer-1", { ...request, beltId: "bad\nline" })),
    /request is invalid/,
  );
});

test("renderer boundary accepts exact debit and refund arithmetic and rejects forgery", () => {
  const normalized = normalizeRendererNativeResult("coreConstructionBeltLaneContext", result(), request);
  assert.equal(normalized.laneDelta, 2);
  assert.equal(normalized.constructionAfterAdjustment, 3);
  const reduced = result();
  reduced.request.targetLanes = 2;
  reduced.targetLanes = 2;
  reduced.laneDelta = -2;
  reduced.constructionAfterAdjustment = 7;
  assert.equal(normalizeRendererNativeResult(
    "coreConstructionBeltLaneContext", reduced, { ...request, targetLanes: 2 },
  ).constructionAfterAdjustment, 7);
  for (const mutate of [
    (value) => { value.revision = 10; },
    (value) => { value.request.targetLanes = 7; },
    (value) => { value.beltId = "MOD/另一条"; },
    (value) => { value.laneDelta = 3; },
    (value) => { value.constructionAfterAdjustment = 4; },
    (value) => { value.constructionId = "conveyor_belt_mk2"; },
    (value) => { value.elevatorOutputIndex = 0; },
  ]) {
    const forged = result();
    mutate(forged);
    assert.throws(
      () => normalizeRendererNativeResult("coreConstructionBeltLaneContext", forged, request),
      (error) => error?.code === "NATIVE_PROTOCOL_INVALID",
    );
  }
});

test("bounded MessagePort block preserves the lane projection identity", () => {
  const transfer = encodeNativeProjectionTransfer({
    sessionId: request.sessionId,
    sequence: 1,
    projectionType: "construction-belt-lane-context-v1",
    result: result(),
  });
  assert.equal(transfer.header.projectionType, "construction-belt-lane-context-v1");
  assert.ok(transfer.payload.byteLength < 1_048_576);
  assert.equal(JSON.parse(transfer.payload).targetLanes, 6);
});

test("unsupported context remains visible but cannot smuggle inventory", () => {
  const unsupported = result();
  unsupported.support = { supported: false, reason: "insufficient-construction" };
  unsupported.laneDelta = null;
  unsupported.constructionAfterAdjustment = null;
  assert.equal(normalizeRendererNativeResult(
    "coreConstructionBeltLaneContext", unsupported, request,
  ).support.reason, "insufficient-construction");
  unsupported.constructionAfterAdjustment = 3;
  assert.throws(
    () => normalizeRendererNativeResult("coreConstructionBeltLaneContext", unsupported, request),
    (error) => error?.code === "NATIVE_PROTOCOL_INVALID",
  );
});

test("direct and MessagePort surfaces are wired", () => {
  const root = path.resolve(__dirname, "..");
  for (const [file, pattern] of [
    ["desktop/main.cjs", /coreConstructionBeltLaneContext/],
    ["desktop/preload.cjs", /getNativeCoreConstructionBeltLaneContext/],
    ["src/desktop.ts", /DesktopNativeCoreConstructionBeltLaneContextRequest/],
    ["src/game/nativeCore.ts", /constructionBeltLaneContext/],
    ["native/dsp-native-host/src/main.rs", /native-core-construction-belt-lane-context-v1/],
    ["native/dsp-native-host/src/protocol.rs", /CoreConstructionBeltLaneContext/],
  ]) assert.match(fs.readFileSync(path.join(root, file), "utf8"), pattern);
});
