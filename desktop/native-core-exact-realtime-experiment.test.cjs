"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  LEASE_FILE_NAME,
  MAX_LEASE_BYTES,
  NativeCoreExactRealtimeExperimentLeaseStore,
  STORAGE_DIRECTORY_NAME,
} = require("./native-core-exact-realtime-experiment.cjs");

const ERROR_CONFLICT = "NATIVE_CORE_EXACT_REALTIME_EXPERIMENT_CONFLICT";
const ERROR_INVALID = "NATIVE_CORE_EXACT_REALTIME_EXPERIMENT_LEASE_INVALID";
const ERROR_PATH = "NATIVE_CORE_EXACT_REALTIME_EXPERIMENT_PATH_INVALID";
const ERROR_READBACK = "NATIVE_CORE_EXACT_REALTIME_EXPERIMENT_READBACK_FAILED";
const ERROR_SCHEMA = "NATIVE_CORE_EXACT_REALTIME_EXPERIMENT_SCHEMA_UNSUPPORTED";
const ERROR_TRANSITION = "NATIVE_CORE_EXACT_REALTIME_EXPERIMENT_TRANSITION_INVALID";

function hex(character) {
  return character.repeat(64);
}

function createFsProxy(overrides) {
  return new Proxy(fs, {
    get(target, property) {
      if (Object.prototype.hasOwnProperty.call(overrides, property)) return overrides[property];
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function createFixture(t, options = {}) {
  const temporaryParent = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-native-e0-"));
  const storageDirectoryPath = path.join(temporaryParent, STORAGE_DIRECTORY_NAME);
  t.after(() => fs.rmSync(temporaryParent, { recursive: true, force: true }));
  return {
    temporaryParent,
    storageDirectoryPath,
    store: new NativeCoreExactRealtimeExperimentLeaseStore({
      storageDirectoryPath,
      ...options,
    }),
  };
}

function prepareInput(overrides = {}) {
  return {
    runId: "run-e0-1",
    registryFingerprint: "builtin:test",
    checkpoint: {
      generation: 3,
      rootHash: hex("c"),
      revision: 7,
    },
    proof: {
      revision: 7,
      canonicalSha256: hex("a"),
      domainSha256: hex("b"),
    },
    settledDeadlineMs: 10_000,
    ...overrides,
  };
}

function identity(overrides = {}) {
  return {
    runId: "run-e0-1",
    registryFingerprint: "builtin:test",
    ...overrides,
  };
}

function tickInput(overrides = {}) {
  return {
    ...identity(),
    sequence: 1,
    commandId: "exact-tick-1",
    baseRevision: 7,
    expectedRevision: 8,
    simulationSeconds: 1,
    wallSeconds: 1,
    settledDeadlineMs: 11_000,
    ...overrides,
  };
}

function ackInput(overrides = {}) {
  return {
    ...identity(),
    sequence: 1,
    commandId: "exact-tick-1",
    revision: 8,
    proof: {
      revision: 8,
      canonicalSha256: hex("d"),
      domainSha256: hex("e"),
    },
    checkpoint: {
      generation: 4,
      rootHash: hex("f"),
      revision: 8,
    },
    settledDeadlineMs: 11_000,
    ...overrides,
  };
}

function publicPrimaryReadback(overrides = {}) {
  return {
    kind: "public-primary-readback-v1",
    revision: 7,
    canonicalSha256: hex("a"),
    domainSha256: hex("b"),
    registryFingerprint: "builtin:test",
    payloadSha256: hex("f"),
    baseChecksum: "deadbeef",
    byteLength: 4_096,
    savedAtMs: 10_000,
    ...overrides,
  };
}

function assertThrowsCode(callback, expectedCode) {
  assert.throws(callback, (error) => {
    assert.equal(error?.code, expectedCode);
    return true;
  });
}

function readRawLease(storageDirectoryPath) {
  return fs.readFileSync(path.join(storageDirectoryPath, LEASE_FILE_NAME), "utf8");
}

function readLeaseJson(storageDirectoryPath) {
  return JSON.parse(readRawLease(storageDirectoryPath));
}

function writeLeaseJson(storageDirectoryPath, value) {
  fs.writeFileSync(path.join(storageDirectoryPath, LEASE_FILE_NAME), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function makeActive(store) {
  store.prepare(prepareInput());
  return store.activate(identity());
}

test("store accepts only the fixed absolute main-process storage location", (t) => {
  assertThrowsCode(() => new NativeCoreExactRealtimeExperimentLeaseStore({
    storageDirectoryPath: path.join("relative", STORAGE_DIRECTORY_NAME),
  }), ERROR_PATH);
  assertThrowsCode(() => new NativeCoreExactRealtimeExperimentLeaseStore({
    storageDirectoryPath: path.join(os.tmpdir(), "renderer-selected-name"),
  }), ERROR_PATH);
  assert.throws(() => new NativeCoreExactRealtimeExperimentLeaseStore({
    storageDirectoryPath: path.join(os.tmpdir(), STORAGE_DIRECTORY_NAME),
    filePath: path.join(os.tmpdir(), "renderer.json"),
  }), /unknown field/);

  const { store, storageDirectoryPath } = createFixture(t);
  assert.equal(store.leaseFilePath, path.join(storageDirectoryPath, LEASE_FILE_NAME));
  assert.deepEqual(store.inspect(), { state: "missing" });
  assert.throws(() => {
    store.leaseFilePath = path.join(os.tmpdir(), "renderer.json");
  }, TypeError);
});

test("prepare persists a strict versioned entry checkpoint and verifies its readback", (t) => {
  const { store, storageDirectoryPath } = createFixture(t);
  const lease = store.prepare(prepareInput());
  assert.equal(lease.schemaVersion, 2);
  assert.equal(lease.phase, "prepared");
  assert.equal(lease.mode, "normal");
  assert.equal(lease.slot, "normal-main");
  assert.deepEqual(lease.acknowledged, {
    sequence: 0,
    commandId: null,
    revision: 7,
    proof: prepareInput().proof,
    checkpoint: prepareInput().checkpoint,
    settledDeadlineMs: 10_000,
  });
  assert.equal(lease.pendingTick, null);
  assert.deepEqual(store.readLease(), lease);
  assert.equal(path.basename(store.leaseFilePath), LEASE_FILE_NAME);
  assert.ok(fs.lstatSync(store.leaseFilePath).isFile());
  assert.ok(readRawLease(storageDirectoryPath).endsWith("\n"));

  assertThrowsCode(() => store.prepare({
    ...prepareInput(),
    rendererPath: "C:\\untrusted\\lease.json",
  }), ERROR_INVALID);
});

test("identical prepare is idempotent while fingerprint and revision conflicts never overwrite", (t) => {
  let renameCount = 0;
  const fileSystem = createFsProxy({
    renameSync(from, to) {
      renameCount += 1;
      return fs.renameSync(from, to);
    },
  });
  const { store } = createFixture(t, { fileSystem });
  const first = store.prepare(prepareInput());
  const second = store.prepare(prepareInput());
  assert.deepEqual(second, first);
  assert.equal(renameCount, 1);

  assertThrowsCode(() => store.prepare(prepareInput({ registryFingerprint: "builtin:other" })), ERROR_CONFLICT);
  assertThrowsCode(() => store.prepare(prepareInput({
    checkpoint: { ...prepareInput().checkpoint, revision: 8 },
    proof: { ...prepareInput().proof, revision: 8 },
  })), ERROR_CONFLICT);
  assertThrowsCode(() => store.activate(identity({ registryFingerprint: "builtin:other" })), ERROR_CONFLICT);
  assert.equal(renameCount, 1);
  assert.deepEqual(store.readLease(), first);
});

test("prepared, active, paused, and resumed transitions preserve strict phase invariants", (t) => {
  const { store } = createFixture(t);
  store.prepare(prepareInput());
  assert.equal(store.activate(identity()).phase, "active");
  assert.equal(store.activate(identity()).phase, "active");
  const paused = store.pause({ ...identity(), reasonCode: "native-host-restart" });
  assert.equal(paused.phase, "paused");
  assert.deepEqual(paused.pause, { reasonCode: "native-host-restart" });
  assert.deepEqual(store.pause({ ...identity(), reasonCode: "native-host-restart" }), paused);
  assertThrowsCode(() => store.pause({ ...identity(), reasonCode: "different-reason" }), ERROR_CONFLICT);
  const resumed = store.activate(identity());
  assert.equal(resumed.phase, "active");
  assert.equal(resumed.pause, null);
});

test("only the next exact one-second tick can be staged", (t) => {
  const { store } = createFixture(t);
  makeActive(store);
  const invalidTicks = [
    tickInput({ sequence: 2 }),
    tickInput({ baseRevision: 6 }),
    tickInput({ expectedRevision: 9 }),
    tickInput({ simulationSeconds: 2 }),
    tickInput({ wallSeconds: 2 }),
    tickInput({ settledDeadlineMs: 10_999 }),
    { ...tickInput(), rendererPath: "C:\\untrusted\\tick.json" },
  ];
  for (const invalidTick of invalidTicks) {
    assert.throws(() => store.stageExactTick(invalidTick));
    assert.equal(store.readLease().pendingTick, null);
  }
  assert.deepEqual(store.stageExactTick(tickInput()).pendingTick, {
    sequence: 1,
    commandId: "exact-tick-1",
    baseRevision: 7,
    expectedRevision: 8,
    simulationSeconds: 1,
    wallSeconds: 1,
    settledDeadlineMs: 11_000,
  });
});

test("at most one pending tick is stored and identical staging is idempotent", (t) => {
  let renameCount = 0;
  const fileSystem = createFsProxy({
    renameSync(from, to) {
      renameCount += 1;
      return fs.renameSync(from, to);
    },
  });
  const { store } = createFixture(t, { fileSystem });
  makeActive(store);
  const writesBeforeTick = renameCount;
  const pending = store.stageExactTick(tickInput());
  assert.deepEqual(store.stageExactTick(tickInput()), pending);
  assert.equal(renameCount, writesBeforeTick + 1);
  assertThrowsCode(() => store.stageExactTick(tickInput({ commandId: "exact-tick-conflict" })), ERROR_CONFLICT);

  store.pause({ ...identity(), reasonCode: "uncertain-native-result" });
  assertThrowsCode(() => store.activate(identity()), ERROR_TRANSITION);
  assert.equal(store.readLease().pendingTick.commandId, "exact-tick-1");
});

test("matching ACK and already-ACKed pending replay are idempotent without another write", (t) => {
  let renameCount = 0;
  const fileSystem = createFsProxy({
    renameSync(from, to) {
      renameCount += 1;
      return fs.renameSync(from, to);
    },
  });
  const { store } = createFixture(t, { fileSystem });
  makeActive(store);
  store.stageExactTick(tickInput());
  const acknowledged = store.acknowledgeExactTick(ackInput());
  const writesAfterAck = renameCount;
  assert.equal(acknowledged.pendingTick, null);
  assert.equal(acknowledged.acknowledged.revision, 8);
  assert.deepEqual(store.acknowledgeExactTick(ackInput()), acknowledged);
  assert.deepEqual(store.stageExactTick(tickInput()), acknowledged);
  assert.equal(renameCount, writesAfterAck);
});

test("real filesystem replacement survives repeated active, pending, and ACK revisions", (t) => {
  const { store, storageDirectoryPath } = createFixture(t);
  makeActive(store);
  for (let sequence = 1; sequence <= 8; sequence += 1) {
    const baseRevision = 6 + sequence;
    const expectedRevision = baseRevision + 1;
    const settledDeadlineMs = 10_000 + sequence * 1_000;
    const commandId = `exact-tick-${sequence}`;
    const canonicalCharacter = (sequence % 16).toString(16);
    const domainCharacter = ((sequence + 7) % 16).toString(16);
    const tick = {
      ...identity(),
      sequence,
      commandId,
      baseRevision,
      expectedRevision,
      simulationSeconds: 1,
      wallSeconds: 1,
      settledDeadlineMs,
    };
    const pending = store.stageExactTick(tick);
    assert.equal(pending.pendingTick.commandId, commandId);
    assert.equal(readLeaseJson(storageDirectoryPath).pendingTick.expectedRevision, expectedRevision);

    const proof = {
      revision: expectedRevision,
      canonicalSha256: hex(canonicalCharacter),
      domainSha256: hex(domainCharacter),
    };
    const acknowledged = store.acknowledgeExactTick({
      ...identity(),
      sequence,
      commandId,
      revision: expectedRevision,
      proof,
      checkpoint: {
        generation: 3 + sequence,
        rootHash: hex(((sequence + 3) % 16).toString(16)),
        revision: expectedRevision,
      },
      settledDeadlineMs,
    });
    assert.equal(acknowledged.pendingTick, null);
    assert.equal(acknowledged.acknowledged.revision, expectedRevision);
    assert.deepEqual(readLeaseJson(storageDirectoryPath).acknowledged.proof, proof);
  }
  assert.equal(store.readLease().acknowledged.sequence, 8);
  assert.equal(store.readLease().acknowledged.revision, 15);
});

test("ACK skips, mismatched command IDs, revisions, deadlines, proofs, and fingerprints are rejected", (t) => {
  const { store } = createFixture(t);
  makeActive(store);
  store.stageExactTick(tickInput());
  const invalidAcks = [
    ackInput({ sequence: 2 }),
    ackInput({ commandId: "exact-tick-other" }),
    ackInput({ revision: 9, proof: { ...ackInput().proof, revision: 9 } }),
    ackInput({ settledDeadlineMs: 12_000 }),
    ackInput({ proof: { ...ackInput().proof, revision: 7 } }),
    ackInput({ registryFingerprint: "builtin:other" }),
  ];
  for (const invalidAck of invalidAcks) {
    assert.throws(() => store.acknowledgeExactTick(invalidAck));
    assert.equal(store.readLease().pendingTick.commandId, "exact-tick-1");
    assert.equal(store.readLease().acknowledged.revision, 7);
  }
  store.acknowledgeExactTick(ackInput());
  assertThrowsCode(() => store.acknowledgeExactTick(ackInput({
    sequence: 2,
    commandId: "exact-tick-2",
    revision: 9,
    proof: { ...ackInput().proof, revision: 9 },
    checkpoint: { ...ackInput().checkpoint, generation: 5, revision: 9 },
    settledDeadlineMs: 12_000,
  })), ERROR_CONFLICT);
});

test("a paused uncertain tick can ACK before a safe resume", (t) => {
  const { store } = createFixture(t);
  makeActive(store);
  store.stageExactTick(tickInput());
  store.pause({ ...identity(), reasonCode: "awaiting-durable-ack" });
  const acknowledged = store.acknowledgeExactTick(ackInput());
  assert.equal(acknowledged.phase, "paused");
  assert.equal(acknowledged.pendingTick, null);
  assert.equal(store.activate(identity()).phase, "active");
});

test("finalization is blocked by pending work and clear requires an exact finalized readback proof", (t) => {
  const { store } = createFixture(t);
  makeActive(store);
  store.stageExactTick(tickInput());
  assertThrowsCode(() => store.beginFinalizing(identity()), ERROR_TRANSITION);
  store.acknowledgeExactTick(ackInput());

  const finalizing = store.beginFinalizing(identity());
  assert.equal(finalizing.phase, "finalizing");
  assert.equal(finalizing.finalization.status, "pending");
  assertThrowsCode(() => store.stageExactTick({
    ...tickInput(),
    sequence: 2,
    commandId: "exact-tick-2",
    baseRevision: 8,
    expectedRevision: 9,
    settledDeadlineMs: 12_000,
  }), ERROR_TRANSITION);
  assertThrowsCode(() => store.clearFinalized({
    ...identity(),
    publicPrimaryReadbackProof: publicPrimaryReadback({
      revision: 8,
      canonicalSha256: hex("d"),
      domainSha256: hex("e"),
    }),
  }), ERROR_TRANSITION);

  const matchingReadback = publicPrimaryReadback({
    revision: 8,
    canonicalSha256: hex("d"),
    domainSha256: hex("e"),
    savedAtMs: 11_000,
  });
  assertThrowsCode(() => store.recordPublicPrimaryReadback({
    ...identity(),
    publicPrimaryReadbackProof: { ...matchingReadback, revision: 9 },
  }), ERROR_CONFLICT);
  assertThrowsCode(() => store.recordPublicPrimaryReadback({
    ...identity(),
    publicPrimaryReadbackProof: { ...matchingReadback, canonicalSha256: hex("0") },
  }), ERROR_CONFLICT);
  assertThrowsCode(() => store.recordPublicPrimaryReadback({
    ...identity(),
    publicPrimaryReadbackProof: { ...matchingReadback, registryFingerprint: "builtin:other" },
  }), ERROR_CONFLICT);
  assertThrowsCode(() => store.recordPublicPrimaryReadback({
    ...identity(),
    publicPrimaryReadbackProof: { ...matchingReadback, savedAtMs: 11_001 },
  }), ERROR_CONFLICT);

  const finalized = store.recordPublicPrimaryReadback({
    ...identity(),
    publicPrimaryReadbackProof: matchingReadback,
  });
  assert.equal(finalized.finalization.status, "finalized");
  assert.deepEqual(store.recordPublicPrimaryReadback({
    ...identity(),
    publicPrimaryReadbackProof: matchingReadback,
  }), finalized);
  assertThrowsCode(() => store.clearFinalized({
    ...identity(),
    publicPrimaryReadbackProof: { ...matchingReadback, payloadSha256: hex("1") },
  }), ERROR_CONFLICT);
  assert.deepEqual(store.clearFinalized({
    ...identity(),
    publicPrimaryReadbackProof: matchingReadback,
  }), { state: "missing" });
  assert.deepEqual(store.inspect(), { state: "missing" });
});

test("corrupt, unknown, future, and revision-inconsistent lease files fail closed", async (t) => {
  const cases = [
    ["corrupt JSON", (raw) => raw.slice(0, 23)],
    ["unknown top-level field", (raw) => ({ ...JSON.parse(raw), unexpected: true })],
    ["unknown nested field", (raw) => {
      const value = JSON.parse(raw);
      value.acknowledged.unexpected = true;
      return value;
    }],
    ["future schema", (raw) => ({ ...JSON.parse(raw), schemaVersion: 3 })],
    ["unknown phase", (raw) => ({ ...JSON.parse(raw), phase: "finalized" })],
    ["revision chain conflict", (raw) => {
      const value = JSON.parse(raw);
      value.acknowledged.revision += 1;
      value.acknowledged.proof.revision += 1;
      return value;
    }],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, (subtest) => {
      const { store, storageDirectoryPath } = createFixture(subtest);
      store.prepare(prepareInput());
      const originalRaw = readRawLease(storageDirectoryPath);
      const mutated = mutate(originalRaw);
      const mutatedRaw = typeof mutated === "string" ? mutated : `${JSON.stringify(mutated, null, 2)}\n`;
      fs.writeFileSync(store.leaseFilePath, mutatedRaw, "utf8");
      const expectedCode = name === "future schema" ? ERROR_SCHEMA : ERROR_INVALID;
      assert.equal(store.inspect().state, "blocked");
      assert.equal(store.inspect().code, expectedCode);
      assertThrowsCode(() => store.prepare(prepareInput()), expectedCode);
      assert.equal(fs.readFileSync(store.leaseFilePath, "utf8"), mutatedRaw);
    });
  }
});

test("oversized and indirect storage objects are blocked without parsing or writing", (t) => {
  const { store, storageDirectoryPath } = createFixture(t);
  fs.mkdirSync(storageDirectoryPath, { recursive: true });
  fs.writeFileSync(store.leaseFilePath, "x".repeat(MAX_LEASE_BYTES + 1), "utf8");
  assert.equal(store.inspect().state, "blocked");

  const syntheticSymlinkStat = {
    isSymbolicLink: () => true,
    isDirectory: () => true,
    isFile: () => false,
  };
  const fileSystem = createFsProxy({
    lstatSync(target) {
      if (target === storageDirectoryPath) return syntheticSymlinkStat;
      return fs.lstatSync(target);
    },
  });
  const indirectStore = new NativeCoreExactRealtimeExperimentLeaseStore({
    storageDirectoryPath,
    fileSystem,
  });
  assert.deepEqual(indirectStore.inspect(), { state: "blocked", code: ERROR_PATH });
});

test("a pre-publish write fault preserves the previous lease and removes its private temp", (t) => {
  let rejectRename = false;
  const fileSystem = createFsProxy({
    renameSync(from, to) {
      if (rejectRename) {
        const error = new Error("injected rename crash");
        error.code = "EIO";
        throw error;
      }
      return fs.renameSync(from, to);
    },
  });
  const { store, storageDirectoryPath } = createFixture(t, { fileSystem });
  makeActive(store);
  const before = readRawLease(storageDirectoryPath);
  rejectRename = true;
  assert.throws(() => store.pause({ ...identity(), reasonCode: "injected-crash" }), /injected rename crash/);
  rejectRename = false;
  assert.equal(readRawLease(storageDirectoryPath), before);
  assert.equal(store.readLease().phase, "active");
  assert.deepEqual(
    fs.readdirSync(storageDirectoryPath).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("a post-publish readback mismatch throws but the next process can recover the committed lease", (t) => {
  let injectMismatch = false;
  let published = false;
  const fileSystem = createFsProxy({
    renameSync(from, to) {
      const result = fs.renameSync(from, to);
      if (injectMismatch) published = true;
      return result;
    },
    readFileSync(target, encoding) {
      const raw = fs.readFileSync(target, encoding);
      if (injectMismatch && published && target.endsWith(LEASE_FILE_NAME)) {
        return `${raw.slice(0, -1)} `;
      }
      return raw;
    },
  });
  const { store, storageDirectoryPath } = createFixture(t, { fileSystem });
  makeActive(store);
  injectMismatch = true;
  assertThrowsCode(() => store.pause({ ...identity(), reasonCode: "readback-mismatch" }), ERROR_READBACK);
  injectMismatch = false;

  const recovered = new NativeCoreExactRealtimeExperimentLeaseStore({ storageDirectoryPath });
  assert.equal(recovered.readLease().phase, "paused");
  assert.equal(recovered.readLease().pause.reasonCode, "readback-mismatch");
});

test("a clear readback failure never reports success and leaves the finalized lease intact", (t) => {
  const { store, storageDirectoryPath } = createFixture(t);
  makeActive(store);
  store.beginFinalizing(identity());
  const readback = publicPrimaryReadback();
  store.recordPublicPrimaryReadback({
    ...identity(),
    publicPrimaryReadbackProof: readback,
  });

  const fileSystem = createFsProxy({
    unlinkSync(target) {
      if (target === path.join(storageDirectoryPath, LEASE_FILE_NAME)) return;
      return fs.unlinkSync(target);
    },
  });
  const faultedStore = new NativeCoreExactRealtimeExperimentLeaseStore({
    storageDirectoryPath,
    fileSystem,
  });
  assertThrowsCode(() => faultedStore.clearFinalized({
    ...identity(),
    publicPrimaryReadbackProof: readback,
  }), ERROR_READBACK);
  assert.equal(store.readLease().finalization.status, "finalized");
});
