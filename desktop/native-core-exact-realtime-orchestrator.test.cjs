"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  LEASE_FILE_NAME,
  NativeCoreExactRealtimeExperimentLeaseStore,
  NativeCoreExactRealtimeRustLeaseStore,
  STORAGE_DIRECTORY_NAME,
} = require("./native-core-exact-realtime-experiment.cjs");
const {
  NativeCoreExactRealtimeOrchestrator,
  deriveExactTickCommandId,
  deriveFinalExportId,
  derivePublicCommitId,
} = require("./native-core-exact-realtime-orchestrator.cjs");

const ERROR_FINALIZATION_RETAINED = "NATIVE_CORE_EXACT_REALTIME_E1_FINALIZATION_RETAINED";
const ERROR_LIFECYCLE_BUSY = "NATIVE_CORE_EXACT_REALTIME_E1_LIFECYCLE_BUSY";
const ERROR_PAUSED = "NATIVE_CORE_EXACT_REALTIME_E1_PAUSED";
const ERROR_PAUSE_PERSIST = "NATIVE_CORE_EXACT_REALTIME_E1_PAUSE_PERSIST_FAILED";
const RUN_ID = "e1-run-test";
const REGISTRY_FINGERPRINT = "builtin:test";
const ENTRY_REVISION = 7;
const ENTRY_DEADLINE_MS = 10_000;

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function proofForRevision(revision) {
  return {
    revision,
    canonicalSha256: sha256(`canonical:${revision}`),
    domainSha256: sha256(`domain:${revision}`),
  };
}

function summaryForRevision(revision) {
  return {
    revision,
    stateVersion: 47,
    mode: "normal",
    paused: false,
    registryFingerprint: REGISTRY_FINGERPRINT,
    ...proofForRevision(revision),
  };
}

function exportBytes(revision, savedAtMs) {
  return Buffer.from(JSON.stringify({
    formatVersion: 2,
    kind: "primary",
    mode: "normal",
    slot: "main",
    savedAt: savedAtMs,
    revision,
  }), "utf8");
}

function chunksOf(buffer) {
  const first = Math.max(1, Math.floor(buffer.length / 3));
  const second = Math.max(first + 1, Math.floor(buffer.length * 2 / 3));
  return [buffer.subarray(0, first), buffer.subarray(first, second), buffer.subarray(second)];
}

class MockRustLeaseRegistry {
  constructor(legacyStore, entryCheckpoint) {
    this.legacyStore = legacyStore;
    this.checkpoints = new Map([[entryCheckpoint.revision, clone(entryCheckpoint)]]);
  }

  upgrade(lease) {
    if (lease === null) return null;
    const checkpoint = this.checkpoints.get(lease.acknowledged.revision);
    assert.ok(checkpoint, "mock Rust lease requires a published checkpoint for every ACK");
    return {
      ...clone(lease),
      schemaVersion: 2,
      kind: "native-core-exact-realtime-experiment-lease-v2",
      acknowledged: { ...clone(lease.acknowledged), checkpoint: clone(checkpoint) },
    };
  }

  async request(request) {
    const { action, ...input } = request;
    if (action === "inspect") {
      const inspected = this.legacyStore.inspect();
      return inspected.state === "valid"
        ? { state: "valid", lease: this.upgrade(inspected.lease) }
        : inspected;
    }
    const methods = {
      prepare: "prepare",
      activate: "activate",
      pause: "pause",
      stageExactTick: "stageExactTick",
      beginFinalizing: "beginFinalizing",
      recordPublicPrimaryReadback: "recordPublicPrimaryReadback",
      clearFinalized: "clearFinalized",
    };
    const method = methods[action];
    if (!method) throw new Error(`mock Rust lease action ${action} is unsupported`);
    const result = this.legacyStore[method](input);
    return result?.state === "missing" ? result : this.upgrade(result);
  }

  acknowledgeFromHost(request, summary, checkpoint) {
    const current = this.legacyStore.readLease();
    if (current.pendingTick === null) {
      return {
        checkpoint: clone(this.checkpoints.get(current.acknowledged.revision)),
        summary: clone(summary),
        lease: this.upgrade(current),
        duplicate: true,
      };
    }
    this.checkpoints.set(checkpoint.revision, clone(checkpoint));
    const lease = this.legacyStore.acknowledgeExactTick({
      runId: request.runId,
      registryFingerprint: request.registryFingerprint,
      sequence: request.sequence,
      commandId: request.commandId,
      revision: summary.revision,
      proof: proofForRevision(summary.revision),
      checkpoint,
      settledDeadlineMs: request.settledDeadlineMs,
    });
    return {
      checkpoint: clone(checkpoint),
      summary: clone(summary),
      lease: this.upgrade(lease),
      duplicate: false,
    };
  }
}

class MockNativeCore {
  constructor(options = {}) {
    this.revision = options.revision ?? ENTRY_REVISION;
    this.accepted = options.accepted ? new Map(options.accepted) : new Map();
    this.events = options.events ?? [];
    this.commitCalls = [];
    this.checkpointCalls = [];
    this.exportCalls = [];
    this.statusCalls = 0;
    this.generation = options.generation ?? 3;
    this.beforeCommit = null;
    this.afterCommit = null;
    this.receiptOverride = null;
    this.statusOverride = null;
    this.failCheckpoint = false;
    this.failExport = false;
    this.checkpointOverride = null;
    this.exportOverride = null;
    this.installCheckpointCalls = 0;
    this.checkpointAckCalls = [];
    this.leaseRegistry = options.leaseRegistry ?? null;
    this.afterCheckpointPublish = null;
    this.afterCheckpointAck = null;
    this.finalizationCheckpointReceipt = options.finalizationCheckpointReceipt
      ? clone(options.finalizationCheckpointReceipt)
      : null;
  }

  summary() {
    return summaryForRevision(this.revision);
  }

  async status() {
    this.statusCalls += 1;
    this.events.push("native-status");
    const summary = this.summary();
    return this.statusOverride ? this.statusOverride(clone(summary)) : summary;
  }

  async commitOperationExactRealtime(identity) {
    assert.deepEqual(identity, {
      runId: RUN_ID,
      registryFingerprint: REGISTRY_FINGERPRINT,
    });
    assert.ok(this.leaseRegistry, "mock Rust lease registry is required");
    const pending = this.leaseRegistry.legacyStore.readLease().pendingTick;
    assert.ok(pending, "a durable exact tick must be pending");
    return this.commitOperation({
      commandId: pending.commandId,
      baseRevision: pending.baseRevision,
      command: null,
      simulationSeconds: pending.simulationSeconds,
      wallSeconds: pending.wallSeconds,
      advanceMode: "exact",
      includeDiagnostics: true,
    });
  }

  async commitOperation(request) {
    const recorded = clone(request);
    this.commitCalls.push(recorded);
    this.events.push(`native-commit:${request.commandId}`);
    if (this.beforeCommit) await this.beforeCommit(recorded, this);

    const existing = this.accepted.get(request.commandId);
    let receipt;
    if (existing) {
      assert.deepEqual(recorded, existing.request);
      receipt = {
        commandId: request.commandId,
        baseRevision: existing.baseRevision,
        revision: existing.revision,
        currentRevision: this.revision,
        duplicate: true,
        summary: this.summary(),
      };
    } else {
      assert.equal(request.baseRevision, this.revision);
      assert.equal(request.command, null);
      assert.equal(request.simulationSeconds, 1);
      assert.equal(request.wallSeconds, 1);
      assert.equal(request.advanceMode, "exact");
      assert.equal(request.includeDiagnostics, true);
      this.revision += 1;
      receipt = {
        commandId: request.commandId,
        baseRevision: request.baseRevision,
        revision: this.revision,
        currentRevision: this.revision,
        duplicate: false,
        summary: this.summary(),
      };
      this.accepted.set(request.commandId, {
        request: recorded,
        baseRevision: request.baseRevision,
        revision: this.revision,
      });
    }
    if (this.afterCommit) await this.afterCommit(receipt, this);
    return this.receiptOverride ? this.receiptOverride(clone(receipt)) : receipt;
  }

  async checkpoint(request) {
    this.checkpointCalls.push(clone(request));
    this.events.push("native-checkpoint");
    if (this.failCheckpoint) throw new Error("injected native checkpoint failure");
    this.generation += 1;
    const receipt = {
      checkpoint: {
        slot: "normal-main",
        generation: this.generation,
        revision: this.revision,
        rootHash: sha256(`root:${this.generation}:${this.revision}`),
      },
      summary: this.summary(),
    };
    return this.checkpointOverride ? this.checkpointOverride(clone(receipt)) : receipt;
  }

  async checkpointAndAcknowledgeExactRealtime(request) {
    this.checkpointAckCalls.push(clone(request));
    this.events.push("native-checkpoint-ack");
    assert.ok(this.leaseRegistry, "mock Rust lease registry is required");
    const lease = this.leaseRegistry.legacyStore.readLease();
    if (lease.pendingTick === null) {
      return this.leaseRegistry.acknowledgeFromHost(request, this.summary(), null);
    }
    this.generation += 1;
    const checkpoint = {
      generation: this.generation,
      rootHash: sha256(`root:${this.generation}:${this.revision}`),
      revision: this.revision,
    };
    if (this.afterCheckpointPublish) await this.afterCheckpointPublish(checkpoint, this);
    const result = this.leaseRegistry.acknowledgeFromHost(request, this.summary(), checkpoint);
    if (this.afterCheckpointAck) await this.afterCheckpointAck(result, this);
    return result;
  }

  async checkpointExactRealtimeFinalization(request) {
    assert.equal(request.runId, RUN_ID);
    assert.equal(request.registryFingerprint, REGISTRY_FINGERPRINT);
    if (this.finalizationCheckpointReceipt) {
      return { ...clone(this.finalizationCheckpointReceipt), duplicate: true };
    }
    const receipt = await this.checkpoint({ savedAtMs: request.savedAtMs });
    this.finalizationCheckpointReceipt = clone(receipt);
    return { ...receipt, duplicate: false };
  }

  async exportV47(request) {
    this.exportCalls.push(clone(request));
    this.events.push("native-export");
    if (this.failExport) throw new Error("injected native export failure");
    const bytes = exportBytes(this.revision, request.savedAtMs);
    const receipt = {
      exportId: request.exportId,
      mode: "normal",
      result: {
        revision: this.revision,
        savedAtMs: request.savedAtMs,
        byteLength: bytes.length,
        envelopeSha256: sha256(bytes),
        stateChecksum: sha256(`checksum:${this.revision}`).slice(0, 8),
      },
      openStream: async () => {
        this.events.push("native-export-stream");
        return (async function* stream() {
          for (const chunk of chunksOf(bytes)) yield chunk;
        }());
      },
    };
    return this.exportOverride ? this.exportOverride(receipt) : receipt;
  }

  installCheckpoint() {
    this.installCheckpointCalls += 1;
    throw new Error("old checkpoint installation is forbidden in E1");
  }

  restarted() {
    return new MockNativeCore({
      revision: this.revision,
      accepted: this.accepted,
      events: this.events,
      generation: this.generation,
      leaseRegistry: this.leaseRegistry,
      finalizationCheckpointReceipt: this.finalizationCheckpointReceipt,
    });
  }
}

class MockPublicPrimaryWriter {
  constructor(events = []) {
    this.events = events;
    this.committed = new Map();
    this.commitCalls = [];
    this.readbackCalls = [];
    this.failCommit = false;
    this.failReadback = false;
    this.skipSourceConsumption = false;
    this.corruptReadback = false;
    this.throwAfterCommitOnce = false;
    this.afterCommit = null;
    this.commitReceiptOverride = null;
    this.readbackReceiptOverride = null;
  }

  async commit(request) {
    this.events.push("public-commit");
    const identity = { ...request };
    delete identity.source;
    this.commitCalls.push(clone(identity));
    if (this.failCommit) throw new Error("injected public primary save failure");

    let bytes = Buffer.alloc(0);
    if (!this.skipSourceConsumption) {
      const chunks = [];
      for await (const chunk of request.source) chunks.push(Buffer.from(chunk));
      bytes = Buffer.concat(chunks);
    }
    const existing = this.committed.get(request.commitId);
    let duplicate = false;
    if (existing) {
      assert.deepEqual(identity, existing.identity);
      assert.deepEqual(bytes, existing.bytes);
      duplicate = true;
    } else {
      this.committed.set(request.commitId, { identity: clone(identity), bytes });
    }
    if (this.afterCommit) await this.afterCommit(identity, this);
    if (this.throwAfterCommitOnce) {
      this.throwAfterCommitOnce = false;
      throw new Error("injected crash after public primary commit");
    }
    const receipt = { ...identity, duplicate };
    return this.commitReceiptOverride ? this.commitReceiptOverride(clone(receipt)) : receipt;
  }

  async readback(request) {
    this.events.push("public-readback");
    this.readbackCalls.push(clone(request));
    if (this.failReadback) throw new Error("injected public primary readback failure");
    const existing = this.committed.get(request.commitId);
    if (!existing) throw new Error("public primary commit is missing");
    const sourceBytes = existing.bytes;
    const bytes = this.corruptReadback
      ? Buffer.concat([Buffer.from([sourceBytes[0] ^ 0xff]), sourceBytes.subarray(1)])
      : sourceBytes;
    const receipt = {
      ...clone(existing.identity),
      openStream: async () => {
        this.events.push("public-readback-stream");
        return (async function* stream() {
          yield bytes.subarray(0, 2);
          yield bytes.subarray(2, bytes.length - 1);
          yield bytes.subarray(bytes.length - 1);
        }());
      },
    };
    return this.readbackReceiptOverride ? this.readbackReceiptOverride(receipt) : receipt;
  }
}

function createLeaseProxy(store, overrides) {
  return new Proxy(store, {
    get(target, property) {
      if (Object.prototype.hasOwnProperty.call(overrides, property)) return overrides[property];
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function createFixture(t, options = {}) {
  const temporaryParent = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-native-e1-"));
  const storageDirectoryPath = path.join(temporaryParent, STORAGE_DIRECTORY_NAME);
  t.after(() => fs.rmSync(temporaryParent, { recursive: true, force: true }));
  const leaseStore = new NativeCoreExactRealtimeExperimentLeaseStore({ storageDirectoryPath });
  const events = [];
  let nativeCore = options.nativeCore ?? new MockNativeCore({ events });
  const publicPrimaryWriter = options.publicPrimaryWriter ?? new MockPublicPrimaryWriter(events);
  const entryCheckpoint = {
    generation: 3,
    rootHash: sha256("entry-root"),
    revision: ENTRY_REVISION,
  };
  leaseStore.prepare({
    runId: RUN_ID,
    registryFingerprint: REGISTRY_FINGERPRINT,
    checkpoint: entryCheckpoint,
    proof: proofForRevision(ENTRY_REVISION),
    settledDeadlineMs: ENTRY_DEADLINE_MS,
  });
  const leaseRegistry = new MockRustLeaseRegistry(leaseStore, entryCheckpoint);
  const rustLeaseStore = new NativeCoreExactRealtimeRustLeaseStore({ leaseRegistry });
  nativeCore.leaseRegistry = leaseRegistry;
  const makeOrchestrator = (store = rustLeaseStore) => new NativeCoreExactRealtimeOrchestrator({
    leaseStore: store,
    nativeCoreProvider: async () => nativeCore,
    publicPrimaryWriter,
  });
  const orchestrator = makeOrchestrator(options.leaseStore ?? rustLeaseStore);
  return {
    events,
    leaseStore,
    leaseRegistry,
    makeOrchestrator,
    nativeCore: () => nativeCore,
    orchestrator,
    publicPrimaryWriter,
    rustLeaseStore,
    setNativeCore(value) {
      nativeCore = value;
      nativeCore.leaseRegistry = leaseRegistry;
    },
    storageDirectoryPath,
  };
}

async function activate(fixture) {
  const lease = await fixture.orchestrator.activate();
  assert.equal(lease.phase, "active");
  return lease;
}

async function assertRejectCode(promise, expectedCode) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.code, expectedCode);
    return true;
  });
}

test("E1 IDs are deterministic and the orchestrator exposes no authority or fallback surface", (t) => {
  const fixture = createFixture(t);
  assert.equal(deriveExactTickCommandId(RUN_ID, 1), deriveExactTickCommandId(RUN_ID, 1));
  assert.notEqual(deriveExactTickCommandId(RUN_ID, 1), deriveExactTickCommandId(RUN_ID, 2));
  assert.notEqual(deriveExactTickCommandId(RUN_ID, 1), deriveExactTickCommandId("other-run", 1));
  assert.match(deriveExactTickCommandId(RUN_ID, 1), /^[A-Za-z0-9_.:-]{1,128}$/);
  assert.match(deriveFinalExportId(RUN_ID, 7), /^[A-Za-z0-9_-]{1,128}$/);
  assert.match(derivePublicCommitId(RUN_ID, 7), /^[A-Za-z0-9_.:-]{1,128}$/);
  assert.equal("authorityEligible" in fixture.orchestrator, false);
  assert.equal("fallbackToJavaScript" in fixture.orchestrator, false);
  assert.equal("installCheckpoint" in fixture.orchestrator, false);
  assert.throws(() => new NativeCoreExactRealtimeOrchestrator({
    leaseStore: fixture.leaseStore,
    nativeCoreProvider: async () => fixture.nativeCore(),
    publicPrimaryWriter: fixture.publicPrimaryWriter,
  }), /leaseStore is invalid/);
  assert.throws(() => new NativeCoreExactRealtimeOrchestrator({
    leaseStore: fixture.leaseStore,
    nativeCoreProvider: async () => fixture.nativeCore(),
    publicPrimaryWriter: fixture.publicPrimaryWriter,
    rendererPath: "C:\\untrusted",
  }), /unknown field/);
});

test("activation requires the native v47 normal proof to match the prepared lease", async (t) => {
  const fixture = createFixture(t);
  const active = await fixture.orchestrator.activate();
  assert.equal(active.phase, "active");
  assert.equal(fixture.nativeCore().statusCalls, 1);

  const mismatch = createFixture(t);
  mismatch.nativeCore().statusOverride = (summary) => ({
    ...summary,
    canonicalSha256: sha256("wrong-entry-proof"),
  });
  await assertRejectCode(mismatch.orchestrator.activate(), ERROR_PAUSED);
  assert.equal(mismatch.leaseStore.readLease().phase, "prepared");
});

test("tick durably stages before native commit and ACKs only its exact proof and deadline", async (t) => {
  const fixture = createFixture(t);
  await activate(fixture);
  fixture.nativeCore().beforeCommit = async (request) => {
    const staged = fixture.leaseStore.readLease();
    assert.equal(staged.pendingTick.commandId, request.commandId);
    assert.equal(staged.pendingTick.baseRevision, request.baseRevision);
    assert.equal(staged.pendingTick.expectedRevision, request.baseRevision + 1);
    assert.equal(staged.pendingTick.simulationSeconds, 1);
    assert.equal(staged.pendingTick.wallSeconds, 1);
  };
  const result = await fixture.orchestrator.tick();
  assert.equal(result.commandId, deriveExactTickCommandId(RUN_ID, 1));
  assert.equal(result.sequence, 1);
  assert.equal(result.revision, 8);
  assert.equal(result.settledDeadlineMs, 11_000);
  assert.deepEqual(result.proof, proofForRevision(8));
  assert.equal(result.duplicate, false);
  assert.equal(result.lease.phase, "active");
  assert.equal(result.lease.pendingTick, null);
  assert.deepEqual(result.lease.acknowledged.proof, proofForRevision(8));
  assert.equal(fixture.nativeCore().commitCalls.length, 1);
  assert.deepEqual(fixture.nativeCore().commitCalls[0], {
    commandId: deriveExactTickCommandId(RUN_ID, 1),
    baseRevision: 7,
    command: null,
    simulationSeconds: 1,
    wallSeconds: 1,
    advanceMode: "exact",
    includeDiagnostics: true,
  });
});

test("concurrent tick calls coalesce and never create a second simulated second", async (t) => {
  const fixture = createFixture(t);
  await activate(fixture);
  const entered = deferred();
  const release = deferred();
  fixture.nativeCore().beforeCommit = async () => {
    entered.resolve();
    await release.promise;
  };
  const first = fixture.orchestrator.tick();
  const second = fixture.orchestrator.tick();
  assert.equal(first, second);
  await entered.promise;
  assert.equal(fixture.nativeCore().commitCalls.length, 1);
  assert.equal(fixture.leaseStore.readLease().pendingTick.sequence, 1);
  release.resolve();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.deepEqual(firstResult, secondResult);
  assert.equal(fixture.leaseStore.readLease().acknowledged.sequence, 1);
  assert.equal(fixture.nativeCore().revision, 8);
});

test("one lifecycle gate serializes tick, recovery, finalization, and activation", async (t) => {
  await t.test("an in-flight tick rejects every different transition without changing its lease", async (subtest) => {
    const fixture = createFixture(subtest);
    await activate(fixture);
    const entered = deferred();
    const release = deferred();
    fixture.nativeCore().beforeCommit = async () => {
      entered.resolve();
      await release.promise;
    };
    const tick = fixture.orchestrator.tick();
    await entered.promise;
    await Promise.all([
      assertRejectCode(fixture.orchestrator.activate(), ERROR_LIFECYCLE_BUSY),
      assertRejectCode(fixture.orchestrator.recoverPending(), ERROR_LIFECYCLE_BUSY),
      assertRejectCode(fixture.orchestrator.finalize(), ERROR_LIFECYCLE_BUSY),
    ]);
    const pending = fixture.leaseStore.readLease();
    assert.equal(pending.phase, "active");
    assert.equal(pending.pendingTick.sequence, 1);
    release.resolve();
    await tick;
  });

  await t.test("an in-flight recovery rejects every different transition", async (subtest) => {
    const fixture = createFixture(subtest);
    const active = await activate(fixture);
    await fixture.rustLeaseStore.stageExactTick({
      runId: active.runId,
      registryFingerprint: active.registryFingerprint,
      sequence: 1,
      commandId: deriveExactTickCommandId(active.runId, 1),
      baseRevision: active.acknowledged.revision,
      expectedRevision: active.acknowledged.revision + 1,
      simulationSeconds: 1,
      wallSeconds: 1,
      settledDeadlineMs: active.acknowledged.settledDeadlineMs + 1_000,
    });
    const entered = deferred();
    const release = deferred();
    fixture.nativeCore().beforeCommit = async () => {
      entered.resolve();
      await release.promise;
    };
    const recovery = fixture.orchestrator.recoverPending();
    await entered.promise;
    await Promise.all([
      assertRejectCode(fixture.orchestrator.activate(), ERROR_LIFECYCLE_BUSY),
      assertRejectCode(fixture.orchestrator.tick(), ERROR_LIFECYCLE_BUSY),
      assertRejectCode(fixture.orchestrator.finalize(), ERROR_LIFECYCLE_BUSY),
    ]);
    assert.equal(fixture.leaseStore.readLease().phase, "paused");
    release.resolve();
    await recovery;
  });

  await t.test("an in-flight finalization rejects every different transition", async (subtest) => {
    const fixture = createFixture(subtest);
    await activate(fixture);
    const entered = deferred();
    const release = deferred();
    fixture.publicPrimaryWriter.afterCommit = async () => {
      entered.resolve();
      await release.promise;
    };
    const finalization = fixture.orchestrator.finalize();
    await entered.promise;
    await Promise.all([
      assertRejectCode(fixture.orchestrator.activate(), ERROR_LIFECYCLE_BUSY),
      assertRejectCode(fixture.orchestrator.tick(), ERROR_LIFECYCLE_BUSY),
      assertRejectCode(fixture.orchestrator.recoverPending(), ERROR_LIFECYCLE_BUSY),
    ]);
    assert.equal(fixture.leaseStore.readLease().phase, "finalizing");
    release.resolve();
    await finalization;
  });
});

test("an invalid native proof persists pause and leaves the exact pending tick unacknowledged", async (t) => {
  const fixture = createFixture(t);
  await activate(fixture);
  fixture.nativeCore().receiptOverride = (receipt) => ({
    ...receipt,
    summary: { ...receipt.summary, domainSha256: "not-a-sha256" },
  });
  await assertRejectCode(fixture.orchestrator.tick(), ERROR_PAUSED);
  const lease = fixture.leaseStore.readLease();
  assert.equal(lease.phase, "paused");
  assert.equal(lease.pause.reasonCode, "e1-tick-failed");
  assert.equal(lease.pendingTick.commandId, deriveExactTickCommandId(RUN_ID, 1));
  assert.equal(lease.acknowledged.revision, 7);
});

test("host crash after durable commit recovers the same command ID and repeated recovery adds no second", async (t) => {
  const fixture = createFixture(t);
  await activate(fixture);
  const firstCore = fixture.nativeCore();
  firstCore.afterCommit = async () => {
    throw new Error("injected host response loss");
  };
  await assertRejectCode(fixture.orchestrator.tick(), ERROR_PAUSED);
  const pending = fixture.leaseStore.readLease().pendingTick;
  assert.equal(firstCore.revision, 8);

  const restartedCore = firstCore.restarted();
  fixture.setNativeCore(restartedCore);
  const restartedOrchestrator = fixture.makeOrchestrator();
  const recovered = await restartedOrchestrator.recoverPending();
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.duplicate, true);
  assert.equal(recovered.commandId, pending.commandId);
  assert.equal(restartedCore.commitCalls[0].commandId, pending.commandId);
  assert.equal(fixture.leaseStore.readLease().pendingTick, null);
  assert.equal(fixture.leaseStore.readLease().phase, "paused");

  const commitCount = restartedCore.commitCalls.length;
  const repeated = await restartedOrchestrator.recoverPending();
  assert.equal(repeated.recovered, false);
  assert.equal(restartedCore.commitCalls.length, commitCount);
  assert.equal((await restartedOrchestrator.activate()).phase, "active");
  assert.equal(firstCore.installCheckpointCalls + restartedCore.installCheckpointCalls, 0);
});

test("process restart converts an active durable pending tick to paused before idempotent recovery", async (t) => {
  const fixture = createFixture(t);
  await activate(fixture);
  const commandId = deriveExactTickCommandId(RUN_ID, 1);
  fixture.leaseStore.stageExactTick({
    runId: RUN_ID,
    registryFingerprint: REGISTRY_FINGERPRINT,
    sequence: 1,
    commandId,
    baseRevision: 7,
    expectedRevision: 8,
    simulationSeconds: 1,
    wallSeconds: 1,
    settledDeadlineMs: 11_000,
  });
  await fixture.nativeCore().commitOperationExactRealtime({
    runId: RUN_ID,
    registryFingerprint: REGISTRY_FINGERPRINT,
  });
  assert.equal(fixture.leaseStore.readLease().phase, "active");
  assert.equal(fixture.leaseStore.readLease().pendingTick.commandId, commandId);

  const restartedCore = fixture.nativeCore().restarted();
  fixture.setNativeCore(restartedCore);
  const recovered = await fixture.makeOrchestrator().recoverPending();
  assert.equal(recovered.duplicate, true);
  assert.equal(recovered.commandId, commandId);
  assert.equal(fixture.leaseStore.readLease().phase, "paused");
  assert.equal(fixture.leaseStore.readLease().pause.reasonCode, "e1-recovering-pending");
  assert.equal(fixture.leaseStore.readLease().pendingTick, null);
  assert.equal(restartedCore.revision, 8);
});

test("lost lease ACK retries the already accepted native command instead of inventing a tick", async (t) => {
  const fixture = createFixture(t);
  let rejectAck = true;
  fixture.nativeCore().afterCheckpointPublish = async () => {
    if (rejectAck) {
      rejectAck = false;
      throw new Error("injected crash after checkpoint before lease ACK");
    }
  };
  await fixture.orchestrator.activate();
  await assertRejectCode(fixture.orchestrator.tick(), ERROR_PAUSED);
  const pending = fixture.leaseStore.readLease().pendingTick;
  assert.equal(fixture.nativeCore().revision, 8);
  assert.equal(fixture.leaseStore.readLease().acknowledged.revision, 7);

  fixture.nativeCore().afterCheckpointPublish = null;
  const recovered = await fixture.makeOrchestrator().recoverPending();
  assert.equal(recovered.duplicate, true);
  assert.equal(recovered.commandId, pending.commandId);
  assert.equal(fixture.nativeCore().commitCalls.length, 2);
  assert.equal(fixture.nativeCore().commitCalls[0].commandId, fixture.nativeCore().commitCalls[1].commandId);
  assert.equal(fixture.leaseStore.readLease().acknowledged.revision, 8);
});

test("native commit failure persists pause without JavaScript fallback or old checkpoint install", async (t) => {
  const fixture = createFixture(t);
  await activate(fixture);
  fixture.nativeCore().beforeCommit = async () => {
    throw new Error("injected native host unavailable");
  };
  await assertRejectCode(fixture.orchestrator.tick(), ERROR_PAUSED);
  const lease = fixture.leaseStore.readLease();
  assert.equal(lease.phase, "paused");
  assert.equal(lease.pendingTick.sequence, 1);
  assert.equal(fixture.nativeCore().revision, 7);
  assert.equal(fixture.nativeCore().installCheckpointCalls, 0);
  assert.equal(fixture.publicPrimaryWriter.commitCalls.length, 0);
});

test("finalize checkpoints, streams, commits, byte-reads, records proof, then clears", async (t) => {
  const fixture = createFixture(t);
  await activate(fixture);
  const result = await fixture.orchestrator.finalize();
  assert.deepEqual(result.cleared, { state: "missing" });
  assert.equal(result.exportId, deriveFinalExportId(RUN_ID, 7));
  assert.equal(result.commitId, derivePublicCommitId(RUN_ID, 7));
  assert.equal(result.publicCommitDuplicate, false);
  assert.deepEqual(result.publicPrimaryReadbackProof, {
    kind: "public-primary-readback-v1",
    revision: 7,
    canonicalSha256: proofForRevision(7).canonicalSha256,
    domainSha256: proofForRevision(7).domainSha256,
    registryFingerprint: REGISTRY_FINGERPRINT,
    payloadSha256: sha256(exportBytes(7, ENTRY_DEADLINE_MS)),
    baseChecksum: sha256("checksum:7").slice(0, 8),
    byteLength: exportBytes(7, ENTRY_DEADLINE_MS).length,
    savedAtMs: ENTRY_DEADLINE_MS,
  });
  assert.deepEqual(await fixture.orchestrator.inspect(), { state: "missing" });
  assert.deepEqual(fixture.nativeCore().checkpointCalls, [{ savedAtMs: ENTRY_DEADLINE_MS }]);
  assert.deepEqual(fixture.nativeCore().exportCalls, [{
    exportId: deriveFinalExportId(RUN_ID, 7),
    savedAtMs: ENTRY_DEADLINE_MS,
  }]);
  const order = [
    "native-checkpoint",
    "native-export",
    "native-export-stream",
    "public-commit",
    "public-readback",
    "public-readback-stream",
  ].map((event) => fixture.events.indexOf(event));
  assert.ok(order.every((index) => index >= 0));
  assert.deepEqual([...order].sort((left, right) => left - right), order);
});

test("checkpoint, export, public save, and readback failures or mismatched receipts retain a finalizing lease", async (t) => {
  const cases = [
    ["checkpoint", (fixture) => { fixture.nativeCore().failCheckpoint = true; }],
    ["checkpoint receipt", (fixture) => {
      fixture.nativeCore().checkpointOverride = (receipt) => ({
        ...receipt,
        checkpoint: { ...receipt.checkpoint, revision: receipt.checkpoint.revision + 1 },
      });
    }],
    ["export", (fixture) => { fixture.nativeCore().failExport = true; }],
    ["export receipt", (fixture) => {
      fixture.nativeCore().exportOverride = (receipt) => ({
        ...receipt,
        result: { ...receipt.result, savedAtMs: receipt.result.savedAtMs + 1 },
      });
    }],
    ["public save", (fixture) => { fixture.publicPrimaryWriter.failCommit = true; }],
    ["public save receipt", (fixture) => {
      fixture.publicPrimaryWriter.commitReceiptOverride = (receipt) => ({
        ...receipt,
        revision: receipt.revision + 1,
      });
    }],
    ["public readback", (fixture) => { fixture.publicPrimaryWriter.corruptReadback = true; }],
    ["public readback receipt", (fixture) => {
      fixture.publicPrimaryWriter.readbackReceiptOverride = (receipt) => ({
        ...receipt,
        byteLength: receipt.byteLength + 1,
      });
    }],
  ];
  for (const [name, configure] of cases) {
    await t.test(name, async (subtest) => {
      const fixture = createFixture(subtest);
      await activate(fixture);
      configure(fixture);
      await assertRejectCode(fixture.orchestrator.finalize(), ERROR_FINALIZATION_RETAINED);
      const lease = fixture.leaseStore.readLease();
      assert.equal(lease.phase, "finalizing");
      assert.equal(lease.finalization.status, "pending");
      assert.notEqual((await fixture.orchestrator.inspect()).state, "missing");
      assert.equal(fixture.nativeCore().installCheckpointCalls, 0);
    });
  }
});

test("retry after public commit response loss reuses stable export and commit IDs", async (t) => {
  const fixture = createFixture(t);
  await activate(fixture);
  fixture.publicPrimaryWriter.throwAfterCommitOnce = true;
  await assertRejectCode(fixture.orchestrator.finalize(), ERROR_FINALIZATION_RETAINED);
  assert.equal(fixture.leaseStore.readLease().finalization.status, "pending");
  assert.equal(fixture.publicPrimaryWriter.committed.size, 1);

  const result = await fixture.orchestrator.finalize();
  assert.equal(result.publicCommitDuplicate, true);
  assert.equal(fixture.publicPrimaryWriter.commitCalls.length, 2);
  assert.equal(fixture.publicPrimaryWriter.commitCalls[0].commitId, fixture.publicPrimaryWriter.commitCalls[1].commitId);
  assert.equal(fixture.nativeCore().exportCalls.length, 2);
  assert.equal(fixture.nativeCore().exportCalls[0].exportId, fixture.nativeCore().exportCalls[1].exportId);
  assert.deepEqual(await fixture.orchestrator.inspect(), { state: "missing" });
});

test("crash after recording finalized proof clears on restart without exporting or saving again", async (t) => {
  const fixture = createFixture(t);
  let failClear = true;
  const faultedStore = createLeaseProxy(fixture.rustLeaseStore, {
    async clearFinalized(value) {
      if (failClear) {
        failClear = false;
        throw new Error("injected crash before lease clear");
      }
      return fixture.rustLeaseStore.clearFinalized(value);
    },
  });
  const faulted = fixture.makeOrchestrator(faultedStore);
  await faulted.activate();
  await assertRejectCode(faulted.finalize(), ERROR_FINALIZATION_RETAINED);
  assert.equal(fixture.leaseStore.readLease().finalization.status, "finalized");
  const checkpointCalls = fixture.nativeCore().checkpointCalls.length;
  const exportCalls = fixture.nativeCore().exportCalls.length;
  const saveCalls = fixture.publicPrimaryWriter.commitCalls.length;

  const resumed = await fixture.makeOrchestrator().finalize();
  assert.equal(resumed.resumedFinalizedLease, true);
  assert.deepEqual(resumed.cleared, { state: "missing" });
  assert.equal(fixture.nativeCore().checkpointCalls.length, checkpointCalls);
  assert.equal(fixture.nativeCore().exportCalls.length, exportCalls);
  assert.equal(fixture.publicPrimaryWriter.commitCalls.length, saveCalls);
});

test("cancellation after native or public durable work retains the exact recovery state", async (t) => {
  await t.test("tick cancellation", async (subtest) => {
    const fixture = createFixture(subtest);
    await activate(fixture);
    const controller = new AbortController();
    fixture.nativeCore().afterCommit = async () => controller.abort();
    await assertRejectCode(fixture.orchestrator.tick({ signal: controller.signal }), ERROR_PAUSED);
    const lease = fixture.leaseStore.readLease();
    assert.equal(lease.phase, "paused");
    assert.equal(lease.pause.reasonCode, "e1-tick-cancelled");
    assert.equal(lease.pendingTick.commandId, deriveExactTickCommandId(RUN_ID, 1));
    assert.equal(fixture.nativeCore().revision, 8);
  });

  await t.test("finalization cancellation", async (subtest) => {
    const fixture = createFixture(subtest);
    await activate(fixture);
    const controller = new AbortController();
    fixture.publicPrimaryWriter.afterCommit = async () => controller.abort();
    await assertRejectCode(fixture.orchestrator.finalize({ signal: controller.signal }), ERROR_FINALIZATION_RETAINED);
    assert.equal(fixture.leaseStore.readLease().phase, "finalizing");
    assert.equal(fixture.leaseStore.readLease().finalization.status, "pending");
    assert.equal(fixture.publicPrimaryWriter.committed.size, 1);
  });
});

test("writer must consume the complete export before reporting a durable public commit", async (t) => {
  const fixture = createFixture(t);
  await activate(fixture);
  fixture.publicPrimaryWriter.skipSourceConsumption = true;
  await assertRejectCode(fixture.orchestrator.finalize(), ERROR_FINALIZATION_RETAINED);
  assert.equal(fixture.leaseStore.readLease().phase, "finalizing");
  assert.equal(fixture.publicPrimaryWriter.readbackCalls.length, 0);
});

test("blocked lease inspection prevents native calls and cannot be disguised as a fallback", async (t) => {
  const fixture = createFixture(t);
  await activate(fixture);
  fs.writeFileSync(
    path.join(fixture.storageDirectoryPath, LEASE_FILE_NAME),
    "{\"schemaVersion\":2}",
    "utf8",
  );
  assert.equal((await fixture.orchestrator.inspect()).state, "blocked");
  await assertRejectCode(fixture.orchestrator.tick(), ERROR_PAUSE_PERSIST);
  assert.equal(fixture.nativeCore().commitCalls.length, 0);
  assert.equal(fixture.nativeCore().installCheckpointCalls, 0);
});
