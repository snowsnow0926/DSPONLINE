"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  NATIVE_CONSTRUCTION_BELT_PLACEMENT_CONTEXT_CAPABILITY,
  NativeCoreSessionRegistry,
} = require("./native-host.cjs");
const { normalizeRendererNativeResult } = require("./native-renderer-boundary.cjs");
const { PROJECTION_METHODS } = require("./native-player-authority-projection-broker.cjs");

const request = Object.freeze({
  sessionId: "core-belt",
  expectedRevision: 7,
  expectedRegistryFingerprint: "mod:test",
  sourceId: "MOD/源-一",
  targetId: "MOD/目标-二",
  itemId: "MOD/item-alpha",
  tier: 1,
  lanes: 3,
});

function result() {
  return {
    schemaVersion: 1,
    projectionType: "construction-belt-placement-context-v1",
    source: "native-core",
    revision: 7,
    stateVersion: 47,
    registryFingerprint: "mod:test",
    request: {
      expectedRevision: 7,
      expectedRegistryFingerprint: "mod:test",
      sourceId: "MOD/源-一",
      targetId: "MOD/目标-二",
      itemId: "MOD/item-alpha",
      tier: 1,
      lanes: 3,
    },
    activePlanetId: "home",
    constructionId: "conveyor_belt_mk1",
    available: 12,
    appendBeltIndex: 4,
    nextBeltId: "belt_42",
    support: { supported: true, reason: null },
    placement: {
      remainingConstruction: 9,
      nextIdAfterPlacement: 43,
      beltTemplate: {
        id: "belt_42",
        planetId: "home",
        source: "MOD/源-一",
        target: "MOD/目标-二",
        itemId: "MOD/item-alpha",
        lanes: 3,
        tier: 1,
        sorterTier: 1,
        progress: 0,
        priority: 1,
        stackSize: 4,
        monitorEnabled: false,
        totalTransferred: 0,
        congestion: 0,
        lastFlow: 0,
        routeMode: "upper",
      },
    },
    limits: { projectionBytes: 1048576 },
  };
}

test("ordinary belt context capability and Host request keep exact opaque identity", async () => {
  assert.equal(
    NATIVE_CONSTRUCTION_BELT_PLACEMENT_CONTEXT_CAPABILITY,
    "native-core-construction-belt-placement-context-v1",
  );
  assert.equal(
    PROJECTION_METHODS["construction-belt-placement-context-v1"],
    "constructionBeltPlacementContext",
  );
  const calls = [];
  const registry = new NativeCoreSessionRegistry({
    hello: { capabilities: [NATIVE_CONSTRUCTION_BELT_PLACEMENT_CONTEXT_CAPABILITY] },
    async request(value) {
      calls.push(value);
      return result();
    },
  });
  registry.sessions.set(request.sessionId, {
    ownerId: "renderer-1",
    slot: "normal-main",
    ownerEpoch: 1,
    state: "owned",
    inFlight: 0,
  });
  await registry.constructionBeltPlacementContext("renderer-1", request);
  assert.deepEqual(calls, [{
    operation: "coreConstructionBeltPlacementContext",
    ...request,
  }]);
  await assert.rejects(
    Promise.resolve().then(() => registry.constructionBeltPlacementContext("renderer-1", {
      ...request,
      targetPortIndex: 0,
    })),
    /request is invalid/,
  );
  await assert.rejects(
    Promise.resolve().then(() => registry.constructionBeltPlacementContext("renderer-1", {
      ...request,
      lanes: Number.MAX_SAFE_INTEGER + 1,
    })),
    /request is invalid/,
  );
});

test("renderer boundary accepts only the exact no-port belt template", () => {
  const normalized = normalizeRendererNativeResult(
    "coreConstructionBeltPlacementContext",
    result(),
    request,
  );
  assert.deepEqual(normalized.request, {
    expectedRevision: 7,
    expectedRegistryFingerprint: "mod:test",
    sourceId: "MOD/源-一",
    targetId: "MOD/目标-二",
    itemId: "MOD/item-alpha",
    tier: 1,
    lanes: 3,
  });
  assert.equal(normalized.placement.beltTemplate.stackSize, 4);
  assert.equal(normalized.placement.beltTemplate.routeMode, "upper");
  assert.equal("targetPortIndex" in normalized.placement.beltTemplate, false);

  for (const mutate of [
    (value) => { value.revision = 8; },
    (value) => { value.request.targetId = "MOD/other"; },
    (value) => { value.placement.beltTemplate.targetPortIndex = 0; },
    (value) => { value.placement.beltTemplate.lastFlow = 1; },
    (value) => { value.placement.remainingConstruction = 10; },
    (value) => { value.placement.beltTemplate.routeMode = "manual"; },
  ]) {
    const forged = result();
    mutate(forged);
    assert.throws(
      () => normalizeRendererNativeResult(
        "coreConstructionBeltPlacementContext",
        forged,
        request,
      ),
      (error) => error?.code === "NATIVE_PROTOCOL_INVALID",
    );
  }
});

test("unsupported contexts cannot smuggle a placement payload", () => {
  const unsupported = result();
  unsupported.constructionId = null;
  unsupported.available = null;
  unsupported.appendBeltIndex = null;
  unsupported.nextBeltId = null;
  unsupported.support = { supported: false, reason: "unsupported-belt-tier" };
  unsupported.placement = null;
  assert.equal(
    normalizeRendererNativeResult(
      "coreConstructionBeltPlacementContext",
      unsupported,
      request,
    ).support.reason,
    "unsupported-belt-tier",
  );
  unsupported.placement = result().placement;
  assert.throws(
    () => normalizeRendererNativeResult(
      "coreConstructionBeltPlacementContext",
      unsupported,
      request,
    ),
    (error) => error?.code === "NATIVE_PROTOCOL_INVALID",
  );
});

test("Electron direct and MessagePort surfaces are both wired without App ownership", () => {
  const root = path.resolve(__dirname, "..");
  const main = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf8");
  const preload = fs.readFileSync(path.join(root, "desktop", "preload.cjs"), "utf8");
  const desktop = fs.readFileSync(path.join(root, "src", "desktop.ts"), "utf8");
  const nativeCore = fs.readFileSync(path.join(root, "src", "game", "nativeCore.ts"), "utf8");
  const rustMain = fs.readFileSync(path.join(root, "native", "dsp-native-host", "src", "rpc.rs"), "utf8");
  const rustProtocol = fs.readFileSync(path.join(root, "native", "dsp-native-host", "src", "protocol.rs"), "utf8");
  assert.match(main, /desktop:native-core-construction-belt-placement-context/);
  assert.match(main, /construction-belt-placement-context-v1/);
  assert.match(main, /coreConstructionBeltPlacementContext/);
  assert.match(preload, /getNativeCoreConstructionBeltPlacementContext/);
  assert.match(preload, /construction-belt-placement-context-v1/);
  assert.match(desktop, /DesktopNativeCoreConstructionBeltPlacementContextRequest/);
  assert.match(desktop, /projectionType:\s*"construction-belt-placement-context-v1"/);
  assert.match(nativeCore, /constructionBeltPlacementContext/);
  assert.match(nativeCore, /projectionType:\s*"construction-belt-placement-context-v1"/);
  assert.match(rustMain, /native-core-construction-belt-placement-context-v1/);
  assert.match(rustMain, /CoreConstructionBeltPlacementContext/);
  assert.match(rustProtocol, /CoreConstructionBeltPlacementContext/);
});
