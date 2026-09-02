"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

const {
  createMonotonicOrbitalContractClock,
  deriveOrbitalContractCommandIdentity,
  normalizeOrbitalContractIntent,
} = require("./native-orbital-contract-intent.cjs");
const {
  NativePlayerAuthorityOrbitalContractBroker,
} = require("./native-player-authority-orbital-contract-broker.cjs");
const {
  normalizeRendererNativeResult,
} = require("./native-renderer-boundary.cjs");

const intents = [
  { type: "accept", contractId: "station-contract-v1-7-100-0-single" },
  { type: "deliver-quantum", contractId: "station-contract-v1-7-100-0-single", itemId: "processor", requestedAmount: "75" },
  { type: "claim", contractId: "station-contract-v1-7-100-0-single" },
  { type: "abandon", contractId: "station-contract-v1-7-100-0-single" },
  { type: "feature", contractId: null },
];

function context() {
  return {
    sessionId: "core-main-1",
    runId: "run-1",
    expectedRevision: 7,
    expectedRegistryFingerprint: "7df8cf3a",
  };
}

function semanticContext() {
  return { ...context(), confirmedWallClockMs: 8_611_200_000 };
}

function projection() {
  return {
    schemaVersion: 1,
    projectionType: "orbital-contract-workspace-v1",
    source: "native-core",
    sessionId: "core-main-1",
    runId: "run-1",
    revision: 7,
    registryFingerprint: "7df8cf3a",
    stateVersion: 47,
    stationStatus: "operational",
    taskDay: 100,
    rulesVersion: 1,
    quantumEnabled: true,
    orbitalMarks: "0",
    stationReputation: "0",
    completedContracts: 0,
    featuredContractId: null,
    offers: [],
    accepted: [{
      id: "station-contract-v1-7-100-0-single",
      templateId: "single",
      slot: 0,
      title: "processor contract",
      summary: "bounded projection fixture",
      taskDay: 100,
      expiresAtTaskDay: 103,
      special: false,
      difficulty: "P1",
      status: "accepted",
      requirements: [{
        itemId: "processor",
        amount: "100",
        delivered: "25",
        channel: "any",
        sourcePlanetIds: [],
        availableQuantum: "75",
      }],
      rewardMarks: "65",
      rewardReputation: "45",
      completionBasisPoints: 2500,
    }],
    completedHistory: [],
    limits: {
      offerCount: 4,
      acceptedCount: 3,
      historyCount: 8,
      requirementsPerContract: 6,
      projectionBytes: 262144,
    },
    unsupported: ["cargo-terminal-binding", "decorations", "profile", "construction"],
  };
}

test("all five orbital-contract intents are exact bounded and command-ID bound", () => {
  for (const intent of intents) assert.deepEqual(normalizeOrbitalContractIntent(intent), intent);
  assert.throws(() => normalizeOrbitalContractIntent({ ...intents[0], reward: "999" }), /invalid/);
  assert.throws(() => normalizeOrbitalContractIntent({ ...intents[1], requestedAmount: "0" }), /invalid/);
  assert.throws(() => normalizeOrbitalContractIntent({ ...intents[1], requestedAmount: "01" }), /invalid/);
  assert.throws(() => normalizeOrbitalContractIntent({ ...intents[1], requestedAmount: "1".repeat(257) }), /invalid/);
  const identity = deriveOrbitalContractCommandIdentity({ ...semanticContext(), intent: intents[1] });
  assert.match(identity.commandId, /^orbital-contract-v1-[a-f0-9]{64}$/);
  assert.notEqual(identity.commandId, deriveOrbitalContractCommandIdentity({
    ...semanticContext(),
    intent: { ...intents[1], requestedAmount: "76" },
  }).commandId);
  assert.notEqual(identity.commandId, deriveOrbitalContractCommandIdentity({
    ...semanticContext(),
    expectedRevision: 8,
    intent: intents[1],
  }).commandId);
  assert.throws(() => deriveOrbitalContractCommandIdentity({
    ...semanticContext(),
    expectedRevision: Number.MAX_SAFE_INTEGER,
    intent: intents[0],
  }), /exhausted/);
});

test("projection and mutation can share one non-regressing main-process clock fence", () => {
  const samples = [8_697_600_000, 8_697_599_999, 8_784_000_000];
  const clock = createMonotonicOrbitalContractClock(() => samples.shift());
  assert.deepEqual([clock(), clock(), clock()], [
    8_697_600_000,
    8_697_600_000,
    8_784_000_000,
  ]);
});

test("renderer broker submits no patch balance or reward and rejects stale lineage", async () => {
  const calls = [];
  const runtime = {
    snapshot: () => ({ phase: "active", sessionId: "core-main-1", runId: "run-1", revision: 7 }),
    async commitOrbitalContractIntent(request) {
      calls.push(request);
      return {
        phase: "active",
        sessionId: "core-main-1",
        previousRevision: 7,
        revision: 8,
        changedEntityIds: [],
        changedBeltIds: [],
        topologyDirty: true,
      };
    },
  };
  const broker = new NativePlayerAuthorityOrbitalContractBroker({
    runtime,
    isTrustedRendererOwner: (ownerId) => ownerId === 17,
    now: () => 8_611_200_000,
  });
  const receipt = await broker.commit(17, {
    expectedSessionId: "core-main-1",
    expectedRunId: "run-1",
    expectedRevision: 7,
    expectedRegistryFingerprint: "7df8cf3a",
    intent: intents[1],
  });
  assert.equal(receipt.revision, 8);
  assert.deepEqual(Object.keys(calls[0]).sort(), [
    "baseRevision", "commandId", "confirmedWallClockMs", "expectedRegistryFingerprint", "intent",
  ]);
  assert.equal(calls[0].confirmedWallClockMs, 8_611_200_000);
  assert.equal(JSON.stringify(calls[0]).includes("topLevelChanges"), false);
  assert.equal(JSON.stringify(calls[0]).includes("rewardMarks"), false);
  assert.equal(JSON.stringify(calls[0]).includes("availableQuantum"), false);
  await assert.rejects(broker.commit(17, {
    expectedSessionId: "core-main-1",
    expectedRunId: "run-1",
    expectedRevision: 6,
    expectedRegistryFingerprint: "7df8cf3a",
    intent: intents[0],
  }), (error) => error.code === "NATIVE_PLAYER_AUTHORITY_ORBITAL_CONTRACT_STALE");
  assert.equal(calls.length, 1);
  await assert.rejects(broker.commit(17, {
    expectedSessionId: "core-main-1",
    expectedRunId: "run-1",
    expectedRevision: 7,
    expectedRegistryFingerprint: "7df8cf3a",
    confirmedWallClockMs: 1,
    intent: intents[0],
  }), /renderer request is invalid/);
});

test("renderer boundary enforces the bounded projection and fails closed on hidden state", () => {
  const valid = normalizeRendererNativeResult(
    "coreOrbitalContractWorkspaceProjection",
    projection(),
    context(),
  );
  assert.equal(valid.accepted[0].requirements[0].availableQuantum, "75");
  assert.equal(JSON.stringify(valid).includes("quantumLogisticsNetwork"), false);
  assert.throws(() => normalizeRendererNativeResult(
    "coreOrbitalContractWorkspaceProjection",
    { ...projection(), state: {} },
    context(),
  ), /invalid/);
  assert.throws(() => normalizeRendererNativeResult(
    "coreOrbitalContractWorkspaceProjection",
    { ...projection(), revision: 8 },
    context(),
  ), /invalid/);
  assert.throws(() => normalizeRendererNativeResult(
    "coreOrbitalContractWorkspaceProjection",
    { ...projection(), offers: Array.from({ length: 5 }, () => projection().accepted[0]) },
    context(),
  ), /invalid/);
  const completedHistory = Array.from({ length: 8 }, (_, index) => ({
    id: `station-contract-v1-7-${99 - index}-0-single`,
    title: `completed-${index}`,
    difficulty: "P1",
    settledAtTaskDay: 100 - index,
  }));
  const featuredOlderThanNewestSeven = completedHistory[7].id;
  const featured = normalizeRendererNativeResult(
    "coreOrbitalContractWorkspaceProjection",
    { ...projection(), completedHistory, featuredContractId: featuredOlderThanNewestSeven },
    context(),
  );
  assert.equal(featured.completedHistory.length, 8);
  assert.equal(featured.completedHistory[7].id, featuredOlderThanNewestSeven);
  assert.throws(() => normalizeRendererNativeResult(
    "coreOrbitalContractWorkspaceProjection",
    { ...projection(), completedHistory, featuredContractId: "station-contract-v1-7-1-0-single" },
    context(),
  ), /invalid/);
});

test("main preload and native route expose intent/projection only", () => {
  const main = fs.readFileSync("desktop/main.cjs", "utf8");
  const preload = fs.readFileSync("desktop/preload.cjs", "utf8");
  const component = fs.readFileSync("src/components/NativeOrbitalContractWorkspace.tsx", "utf8");
  assert.match(main, /desktop:native-player-authority-orbital-contract-intent/);
  assert.match(main, /desktop:native-core-orbital-contract-workspace-projection/);
  assert.match(preload, /commitNativeOrbitalContractIntent/);
  assert.match(preload, /getNativeCoreOrbitalContractWorkspaceProjection/);
  assert.doesNotMatch(preload, /commitPlayerAuthorityOrbitalContractCommand/);
  assert.doesNotMatch(component, /acceptStationContract|claimStationContract|abandonStationContract|deliverOrbitalQuantumInventory/);
  assert.equal((main.match(/now: samplePlayerAuthorityWallClock/g) ?? []).length, 4);
  assert.doesNotMatch(main, /sampleOrbitalContractWallClock/);
});
