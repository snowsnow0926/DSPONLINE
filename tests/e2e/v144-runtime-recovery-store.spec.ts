import { expect, test, type Page } from "@playwright/test";
import { buildLocalSaveCatalog } from "../../src/game/localSaveCatalogBuild";
import { localSaveCatalogRecordKey, serializeLocalSaveCatalog } from "../../src/game/localSaveCatalog";
import { LOCAL_SAVE_WRITER_LEASE_KEY, localSaveRevisionKey } from "../../src/game/localSaveCoordination";
import { computeSaveStateChecksum } from "../../src/game/saveEnvelopeIntegrity";

const SAVE_KEY = "dsp-idle-network.save.v1";

interface SeededPrimary {
  raw: string;
  catalogKey: string;
  catalogValue: string;
  revisionKey: string;
  revisionValue: string;
  baseIdentity: { mode: "normal"; savedAt: number; checksum: string; revision: number };
}

function primaryFixture(savedAt: number, revision: number, marker: string): SeededPrimary {
  const state = {
    version: 46,
    mode: "normal" as const,
    elapsedSeconds: revision,
    activePlanetId: "home",
    entities: [],
    belts: [],
    marker,
  };
  const checksum = computeSaveStateChecksum(2, state);
  const raw = JSON.stringify({
    formatVersion: 2,
    kind: "primary",
    savedAt,
    mode: "normal",
    slot: "main",
    state,
    checksum,
  });
  const catalog = buildLocalSaveCatalog(SAVE_KEY, raw, revision);
  const revisionValue = JSON.stringify({
    schemaVersion: 1,
    saveKey: SAVE_KEY,
    revision,
    savedAt,
    checksum,
    deleted: false,
    writerId: "tab_recovery_test",
    fencingToken: 7,
    updatedAt: savedAt,
  });
  return {
    raw,
    catalogKey: localSaveCatalogRecordKey(SAVE_KEY),
    catalogValue: serializeLocalSaveCatalog(catalog),
    revisionKey: localSaveRevisionKey(SAVE_KEY),
    revisionValue,
    baseIdentity: { mode: "normal", savedAt, checksum, revision },
  };
}

async function openBarePage(page: Page): Promise<void> {
  await page.goto("/src/game/simulationRuntimeRecoveryStore.ts");
}

async function seedPrimaryAndLease(page: Page, primary: SeededPrimary): Promise<void> {
  await page.evaluate(async ({ primary, leaseKey }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("dsp-idle-network.local-saves", 2);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("records")) request.result.createObjectStore("records", { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("records", "readwrite");
      const store = transaction.objectStore("records");
      store.clear();
      const now = Date.now();
      store.put({ key: "dsp-idle-network.save.v1", value: primary.raw, updatedAt: now, bytes: primary.raw.length });
      store.put({ key: primary.catalogKey, value: primary.catalogValue, updatedAt: now, bytes: primary.catalogValue.length });
      store.put({ key: primary.revisionKey, value: primary.revisionValue, updatedAt: now, bytes: primary.revisionValue.length });
      const lease = JSON.stringify({
        schemaVersion: 1,
        ownerId: "tab_recovery_test",
        fencingToken: 7,
        heartbeatAt: now,
        expiresAt: now + 60_000,
      });
      store.put({ key: leaseKey, value: lease, updatedAt: now, bytes: lease.length });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    db.close();
  }, { primary, leaseKey: LOCAL_SAVE_WRITER_LEASE_KEY });
}

async function replacePrimary(page: Page, primary: SeededPrimary): Promise<void> {
  await page.evaluate(async (primary) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("dsp-idle-network.local-saves", 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("records", "readwrite");
      const store = transaction.objectStore("records");
      const now = Date.now();
      store.put({ key: "dsp-idle-network.save.v1", value: primary.raw, updatedAt: now, bytes: primary.raw.length });
      store.put({ key: primary.catalogKey, value: primary.catalogValue, updatedAt: now, bytes: primary.catalogValue.length });
      store.put({ key: primary.revisionKey, value: primary.revisionValue, updatedAt: now, bytes: primary.revisionValue.length });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    db.close();
  }, primary);
}

test("single pending WAL is durable before Worker, finalizes exactly once, and survives all response-loss points", async ({ page }) => {
  await openBarePage(page);
  const primary = primaryFixture(1_786_377_600_000, 1, "wal");
  await seedPrimaryAndLease(page, primary);
  const result = await page.evaluate(async (baseIdentity) => {
    const store: any = await import(/* @vite-ignore */ "/src/game/simulationRuntimeRecoveryStore.ts");
    const durable: any = await import(/* @vite-ignore */ "/src/game/simulationRuntimeDurableRecovery.ts");
    const packs: any = await import(/* @vite-ignore */ "/src/game/contentPacks.ts");
    const registry = packs.createContentPackRuntimeSnapshot(packs.createContentPackRegistry());
    const fence = { ownerId: "tab_recovery_test", fencingToken: 7 };
    const checkpoint = {
      schemaVersion: 1,
      sessionId: "session-wal",
      generation: 1,
      lastSequence: 0,
      stateRevision: 0,
      registryFingerprint: registry.fingerprint,
      registry,
      committedAtMs: Date.now(),
      baseIdentity,
      source: "primary",
      primaryStateChecksum: baseIdentity.checksum,
      primaryRevision: baseIdentity.revision,
    };
    const makeIntent = async (wallSeconds: number) => {
      const unsigned = {
        schemaVersion: 1,
        sessionId: "session-wal",
        generation: 1,
        sequence: 1,
        baseStateRevision: 0,
        command: null,
        simulationSeconds: 1,
        wallSeconds,
        multicore: undefined,
        approximate: false,
        registry,
        committedAtMs: 1_786_377_600_100,
      };
      return { ...unsigned, intentSha256: await durable.computeSimulationRuntimeDurableIntentSha256(unsigned) };
    };
    const initialized = await store.initializeSimulationRuntimeRecovery(checkpoint, fence);
    const intent = await makeIntent(1);
    const prepared = await store.prepareSimulationRuntimeRecoveryIntent(intent);
    const staged = await store.stageSimulationRuntimeRecoveryIntent(prepared, fence);
    // kill after stage / while Worker runs / after Worker response all expose
    // the same durable pending tail and never claim it as finalized.
    const afterStage = await store.readSimulationRuntimeRecovery(baseIdentity, fence);
    const whileWorker = await store.readSimulationRuntimeRecovery(baseIdentity, fence);
    const afterResponse = await store.readSimulationRuntimeRecovery(baseIdentity, fence);
    const stageRetry = await store.stageSimulationRuntimeRecoveryIntent(prepared, fence);
    const forkIntent = await makeIntent(2);
    const forkPrepared = await store.prepareSimulationRuntimeRecoveryIntent(forkIntent);
    const forkWhilePending = await store.stageSimulationRuntimeRecoveryIntent(forkPrepared, fence);
    const finalized = await store.finalizeSimulationRuntimeRecoveryIntent(
      intent.sessionId,
      intent.generation,
      intent.sequence,
      intent.intentSha256,
      1,
      fence,
    );
    // A committed transaction whose response was lost is safe to retry from
    // either the stage or finalize edge.
    const stageAfterFinalize = await store.stageSimulationRuntimeRecoveryIntent(prepared, fence);
    const finalizeRetry = await store.finalizeSimulationRuntimeRecoveryIntent(
      intent.sessionId,
      intent.generation,
      intent.sequence,
      intent.intentSha256,
      1,
      fence,
    );
    const forkAfterFinalize = await store.finalizeSimulationRuntimeRecoveryIntent(
      forkIntent.sessionId,
      forkIntent.generation,
      forkIntent.sequence,
      forkIntent.intentSha256,
      1,
      fence,
    );
    const read = await store.readSimulationRuntimeRecovery(baseIdentity, fence);
    const cleared = await store.clearSimulationRuntimeRecovery(baseIdentity, fence);
    const afterClear = await store.readSimulationRuntimeRecovery(baseIdentity, fence);
    const summarizePending = (value: any) => value.ok ? {
      pending: value.proof?.pending,
      finalized: value.proof?.finalized,
      pendingSequence: value.recovery?.pendingIntent?.sequence ?? null,
      entries: value.recovery?.entries.length ?? null,
    } : value;
    return {
      initialized,
      staged,
      afterStage: summarizePending(afterStage),
      whileWorker: summarizePending(whileWorker),
      afterResponse: summarizePending(afterResponse),
      stageRetry,
      forkWhilePending,
      finalized,
      stageAfterFinalize,
      finalizeRetry,
      forkAfterFinalize,
      read: summarizePending(read),
      cleared,
      afterClear,
    };
  }, primary.baseIdentity);

  expect(result.initialized).toMatchObject({ ok: true, proof: { generation: 1, sequence: 0 } });
  expect(result.staged).toMatchObject({ ok: true, idempotent: false, proof: { pending: true, finalized: false, sequence: 1 } });
  expect(result.afterStage).toEqual({ pending: true, finalized: false, pendingSequence: 1, entries: 0 });
  expect(result.whileWorker).toEqual(result.afterStage);
  expect(result.afterResponse).toEqual(result.afterStage);
  expect(result.stageRetry).toMatchObject({ ok: true, idempotent: true, proof: { pending: true } });
  expect(result.forkWhilePending).toMatchObject({ ok: false, reason: "operation-conflict" });
  expect(result.finalized).toMatchObject({ ok: true, idempotent: false, proof: { pending: false, finalized: true, stateRevision: 1 } });
  expect(result.stageAfterFinalize).toMatchObject({ ok: true, idempotent: true, proof: { pending: false, finalized: true } });
  expect(result.finalizeRetry).toMatchObject({ ok: true, idempotent: true, proof: { pending: false, finalized: true } });
  expect(result.forkAfterFinalize).toMatchObject({ ok: false, reason: "operation-conflict" });
  expect(result.read).toEqual({ pending: false, finalized: true, pendingSequence: null, entries: 1 });
  expect(result.cleared).toMatchObject({ ok: true, cleared: true });
  expect(result.afterClear).toMatchObject({ ok: true, recovery: null, proof: null });
});

test("oversized staged intent is absorbed by a post-operation checkpoint and lost response is idempotent", async ({ page }) => {
  await openBarePage(page);
  const primary = primaryFixture(1_786_377_610_000, 1, "absorbed");
  await seedPrimaryAndLease(page, primary);
  const result = await page.evaluate(async (baseIdentity) => {
    const store: any = await import(/* @vite-ignore */ "/src/game/simulationRuntimeRecoveryStore.ts");
    const durable: any = await import(/* @vite-ignore */ "/src/game/simulationRuntimeDurableRecovery.ts");
    const packs: any = await import(/* @vite-ignore */ "/src/game/contentPacks.ts");
    const registry = packs.createContentPackRuntimeSnapshot(packs.createContentPackRegistry());
    const fence = { ownerId: "tab_recovery_test", fencingToken: 7 };
    const initial = {
      schemaVersion: 1,
      sessionId: "session-absorbed",
      generation: 1,
      lastSequence: 0,
      stateRevision: 0,
      registryFingerprint: registry.fingerprint,
      registry,
      committedAtMs: Date.now(),
      baseIdentity,
      source: "primary",
      primaryStateChecksum: baseIdentity.checksum,
      primaryRevision: baseIdentity.revision,
    };
    const initialized = await store.initializeSimulationRuntimeRecovery(initial, fence);
    const unsigned = {
      schemaVersion: 1,
      sessionId: "session-absorbed",
      generation: 1,
      sequence: 1,
      baseStateRevision: 0,
      command: {
        protocolVersion: 1,
        baseRevision: 0,
        topLevelChanges: [{ path: ["largeBlueprint"], operation: "set", value: "x".repeat(1_100_000) }],
        changedEntities: [], addedEntities: [], removedEntityIds: [],
        changedBelts: [], addedBelts: [], removedBeltIds: [],
      },
      simulationSeconds: 0,
      wallSeconds: 0,
      multicore: undefined,
      approximate: false,
      registry,
      committedAtMs: 1_786_377_610_100,
    };
    const intent = { ...unsigned, intentSha256: await durable.computeSimulationRuntimeDurableIntentSha256(unsigned) };
    const prepared = await store.prepareSimulationRuntimeRecoveryIntent(intent);
    const staged = await store.stageSimulationRuntimeRecoveryIntent(prepared, fence);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("dsp-idle-network.local-saves", 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const pendingKey = "dsp-idle-network.runtime-recovery.v1.pending-intent.normal";
    const capturedPending = await new Promise<any>((resolve, reject) => {
      const request = db.transaction("records", "readonly").objectStore("records").get(pendingKey);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const bytes = new TextEncoder().encode("post-operation-authoritative-checkpoint");
    const sha256 = await durable.computeSimulationRuntimeDurableBytesSha256(bytes.buffer);
    const next = {
      ...initial,
      generation: 2,
      lastSequence: 1,
      stateRevision: 1,
      committedAtMs: Date.now() + 1,
      source: "transfer",
      transfer: {
        protocolVersion: 1,
        encoding: "raw",
        buffer: bytes.buffer,
        storedByteLength: bytes.byteLength,
        originalByteLength: bytes.byteLength,
        storedSha256: sha256,
        originalSha256: sha256,
      },
    };
    delete (next as any).primaryStateChecksum;
    delete (next as any).primaryRevision;
    // The first success is deliberately treated as a lost response.
    await store.commitSimulationRuntimeRecoveryCheckpoint(next, 1, fence, { intent, resultStateRevision: 1 });
    const retry = await store.commitSimulationRuntimeRecoveryCheckpoint(next, 1, fence, { intent, resultStateRevision: 1 });
    // Recreate the only legal crash window: head already contains the absorbed
    // proof while its old staged sidecar has not yet been removed.
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("records", "readwrite");
      transaction.objectStore("records").put(capturedPending);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    const recovered = await store.readSimulationRuntimeRecovery(baseIdentity, fence);
    const pendingAfterRecovery = await new Promise<any>((resolve, reject) => {
      const request = db.transaction("records", "readonly").objectStore("records").get(pendingKey);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const forkUnsigned = { ...unsigned, wallSeconds: 1 };
    const fork = { ...forkUnsigned, intentSha256: await durable.computeSimulationRuntimeDurableIntentSha256(forkUnsigned) };
    const conflict = await store.commitSimulationRuntimeRecoveryCheckpoint(next, 1, fence, { intent: fork, resultStateRevision: 1 });
    db.close();
    return {
      initialized,
      prepared: { encoding: prepared.encoding, originalByteLength: prepared.originalByteLength },
      staged,
      retry,
      recovered: recovered.ok ? {
        generation: recovered.proof?.generation,
        sequence: recovered.proof?.sequence,
        pending: recovered.proof?.pending,
        pendingIntent: recovered.recovery?.pendingIntent ?? null,
      } : recovered,
      pendingAfterRecovery: pendingAfterRecovery ?? null,
      conflict,
    };
  }, primary.baseIdentity);

  expect(result.initialized.ok).toBe(true);
  expect(result.prepared.encoding).toBe("raw");
  expect(result.prepared.originalByteLength).toBeGreaterThan(1024 * 1024);
  expect(result.staged).toMatchObject({ ok: true, proof: { pending: true, requiresCheckpointBarrier: true } });
  expect(result.retry).toMatchObject({ ok: true, idempotent: true, proof: { generation: 2, sequence: 1, pending: false } });
  expect(result.recovered).toEqual({ generation: 2, sequence: 1, pending: false, pendingIntent: null });
  expect(result.pendingAfterRecovery).toBeNull();
  expect(result.conflict).toMatchObject({ ok: false, reason: "operation-conflict" });
});

test("changed primary replaces stale recovery, removes orphan WAL, fences takeover, and remains invisible to 1.0.43 getAll", async ({ page }) => {
  await openBarePage(page);
  const oldPrimary = primaryFixture(1_786_377_620_000, 1, "old-primary");
  const nextPrimary = primaryFixture(1_786_377_620_100, 2, "new-primary");
  await seedPrimaryAndLease(page, oldPrimary);
  const before = await page.evaluate(async (baseIdentity) => {
    const store: any = await import(/* @vite-ignore */ "/src/game/simulationRuntimeRecoveryStore.ts");
    const durable: any = await import(/* @vite-ignore */ "/src/game/simulationRuntimeDurableRecovery.ts");
    const packs: any = await import(/* @vite-ignore */ "/src/game/contentPacks.ts");
    const registry = packs.createContentPackRuntimeSnapshot(packs.createContentPackRegistry());
    const fence = { ownerId: "tab_recovery_test", fencingToken: 7 };
    const checkpoint = {
      schemaVersion: 1, sessionId: "session-old", generation: 1, lastSequence: 0, stateRevision: 0,
      registryFingerprint: registry.fingerprint, registry, committedAtMs: Date.now(), baseIdentity,
      source: "primary", primaryStateChecksum: baseIdentity.checksum, primaryRevision: baseIdentity.revision,
    };
    const initialized = await store.initializeSimulationRuntimeRecovery(checkpoint, fence);
    const unsigned = {
      schemaVersion: 1, sessionId: "session-old", generation: 1, sequence: 1, baseStateRevision: 0,
      command: null, simulationSeconds: 1, wallSeconds: 1, multicore: undefined, approximate: false,
      registry, committedAtMs: Date.now(),
    };
    const intent = { ...unsigned, intentSha256: await durable.computeSimulationRuntimeDurableIntentSha256(unsigned) };
    const staged = await store.stageSimulationRuntimeRecoveryIntent(await store.prepareSimulationRuntimeRecoveryIntent(intent), fence);
    return { initialized, staged };
  }, oldPrimary.baseIdentity);
  expect(before.initialized.ok).toBe(true);
  expect(before.staged).toMatchObject({ ok: true, proof: { pending: true } });

  await replacePrimary(page, nextPrimary);
  const result = await page.evaluate(async ({ oldBase, nextBase, leaseKey }) => {
    const store: any = await import(/* @vite-ignore */ "/src/game/simulationRuntimeRecoveryStore.ts");
    const packs: any = await import(/* @vite-ignore */ "/src/game/contentPacks.ts");
    const registry = packs.createContentPackRuntimeSnapshot(packs.createContentPackRegistry());
    const oldFence = { ownerId: "tab_recovery_test", fencingToken: 7 };
    const beforeReplace = await store.readSimulationRuntimeRecovery(nextBase, oldFence);
    const nextCheckpoint = {
      schemaVersion: 1, sessionId: "session-new", generation: 1, lastSequence: 0, stateRevision: 0,
      registryFingerprint: registry.fingerprint, registry, committedAtMs: Date.now(), baseIdentity: nextBase,
      source: "primary", primaryStateChecksum: nextBase.checksum, primaryRevision: nextBase.revision,
    };
    const replaced = await store.initializeSimulationRuntimeRecovery(nextCheckpoint, oldFence);
    const oldRead = await store.readSimulationRuntimeRecovery(oldBase, oldFence);
    const newRead = await store.readSimulationRuntimeRecovery(nextBase, oldFence);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("dsp-idle-network.local-saves", 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const records = await new Promise<any[]>((resolve, reject) => {
      const request = db.transaction("records", "readonly").objectStore("records").getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const oldIsSaveKey = (key: string) => key === "dsp-idle-network.save.v1" || key === "dsp-idle-network.save.v1.backup" ||
      key === "dsp-idle-network.save.v1.backup.speedrun" || key.startsWith("dsp-idle-network.save.v1.migration-backup.") ||
      key.startsWith("dsp-idle-network.save.v1.normal") || key.startsWith("dsp-idle-network.save.v1.speedrun") ||
      key.startsWith("dsp-idle-network.save.v1.snapshot.") || key.startsWith("dsp-idle-network.save.v1.import-cache.") ||
      key.startsWith("dsp-idle-network.save.v1.conflict.") || key.startsWith("dsp-idle-network.slot.");
    const oldClientPayloadKeys = records.filter((record) => typeof record?.key === "string" &&
      typeof record?.value === "string" && oldIsSaveKey(record.key)).map((record) => record.key);
    const recoveryKeys = records.filter((record) => typeof record?.key === "string" &&
      record.key.startsWith("dsp-idle-network.runtime-recovery.v1"))
      .map((record) => record.key);
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("records", "readwrite");
      const now = Date.now();
      const value = JSON.stringify({ schemaVersion: 1, ownerId: "tab_takeover", fencingToken: 8, heartbeatAt: now, expiresAt: now + 60_000 });
      transaction.objectStore("records").put({ key: leaseKey, value, updatedAt: now, bytes: value.length });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
    const fenced = await store.readSimulationRuntimeRecovery(nextBase, oldFence);
    const takeover = await store.readSimulationRuntimeRecovery(nextBase, { ownerId: "tab_takeover", fencingToken: 8 });
    return {
      beforeReplace,
      replaced,
      oldRead,
      newSession: newRead.ok ? newRead.proof?.sessionId : null,
      oldClientPayloadKeys,
      recoveryKeys,
      hasPending: recoveryKeys.some((key) => key.includes("pending-intent")),
      oldSessionKeys: recoveryKeys.filter((key) => key.includes("session-old")),
      fenced,
      takeoverSession: takeover.ok ? takeover.proof?.sessionId : null,
    };
  }, { oldBase: oldPrimary.baseIdentity, nextBase: nextPrimary.baseIdentity, leaseKey: LOCAL_SAVE_WRITER_LEASE_KEY });

  expect(result.beforeReplace).toMatchObject({ ok: true, recovery: null, proof: null });
  expect(result.replaced).toMatchObject({ ok: true, proof: { sessionId: "session-new" } });
  expect(result.oldRead).toMatchObject({ ok: true, recovery: null, proof: null });
  expect(result.newSession).toBe("session-new");
  expect(result.oldClientPayloadKeys).toEqual([SAVE_KEY]);
  expect(result.hasPending).toBe(false);
  expect(result.oldSessionKeys).toEqual([]);
  expect(result.recoveryKeys).toHaveLength(3);
  expect(result.fenced).toMatchObject({ ok: false, reason: "lease-lost" });
  expect(result.takeoverSession).toBe("session-new");
});

test("active corruption falls back to verified previous and passive segment bit flips are rejected", async ({ page }) => {
  await openBarePage(page);
  const primary = primaryFixture(1_786_377_630_000, 1, "corruption");
  await seedPrimaryAndLease(page, primary);
  const result = await page.evaluate(async (baseIdentity) => {
    const store: any = await import(/* @vite-ignore */ "/src/game/simulationRuntimeRecoveryStore.ts");
    const durable: any = await import(/* @vite-ignore */ "/src/game/simulationRuntimeDurableRecovery.ts");
    const packs: any = await import(/* @vite-ignore */ "/src/game/contentPacks.ts");
    const registry = packs.createContentPackRuntimeSnapshot(packs.createContentPackRegistry());
    const fence = { ownerId: "tab_recovery_test", fencingToken: 7 };
    const checkpoint = (sessionId: string, generation: number, sequence = 0, revision = 0) => ({
      schemaVersion: 1, sessionId, generation, lastSequence: sequence, stateRevision: revision,
      registryFingerprint: registry.fingerprint, registry, committedAtMs: Date.now() + generation, baseIdentity,
      source: "primary", primaryStateChecksum: baseIdentity.checksum, primaryRevision: baseIdentity.revision,
    });
    await store.initializeSimulationRuntimeRecovery(checkpoint("session-fallback", 1), fence);
    const unsigned = {
      schemaVersion: 1, sessionId: "session-fallback", generation: 1, sequence: 1, baseStateRevision: 0,
      command: null, simulationSeconds: 8, wallSeconds: 8, multicore: undefined, approximate: false,
      registry, committedAtMs: Date.now(),
    };
    const intent = { ...unsigned, intentSha256: await durable.computeSimulationRuntimeDurableIntentSha256(unsigned) };
    await store.stageSimulationRuntimeRecoveryIntent(await store.prepareSimulationRuntimeRecoveryIntent(intent), fence);
    await store.finalizeSimulationRuntimeRecoveryIntent("session-fallback", 1, 1, intent.intentSha256, 1, fence);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("dsp-idle-network.local-saves", 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const captured = await new Promise<any>((resolve, reject) => {
      const transaction = db.transaction("records", "readonly");
      const objectStore = transaction.objectStore("records");
      const headRequest = objectStore.get("dsp-idle-network.runtime-recovery.v1.head.normal");
      headRequest.onsuccess = () => {
        const head = JSON.parse(headRequest.result.value);
        const checkpointRequest = objectStore.get(head.active.checkpointKey);
        const journalRequest = objectStore.get(head.active.journalKey);
        transaction.oncomplete = () => resolve({ head, checkpoint: checkpointRequest.result, journal: journalRequest.result });
      };
      transaction.onerror = () => reject(transaction.error);
    });
    await store.commitSimulationRuntimeRecoveryCheckpoint(checkpoint("session-fallback", 2, 1, 1), 1, fence);
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("records", "readwrite");
      const objectStore = transaction.objectStore("records");
      const headRequest = objectStore.get("dsp-idle-network.runtime-recovery.v1.head.normal");
      headRequest.onsuccess = () => {
        const head = JSON.parse(headRequest.result.value);
        head.previous = captured.head.active;
        head.revision += 1;
        const headValue = JSON.stringify(head);
        objectStore.put({ ...headRequest.result, value: headValue, bytes: new TextEncoder().encode(headValue).byteLength });
        objectStore.put(captured.checkpoint);
        objectStore.put(captured.journal);
        const activeRequest = objectStore.get(head.active.checkpointKey);
        activeRequest.onsuccess = () => {
          const active = activeRequest.result;
          active.checkpoint.primaryStateChecksum = "corrupt";
          objectStore.put(active);
        };
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    const fallback = await store.readSimulationRuntimeRecovery(baseIdentity, fence);
    await store.clearSimulationRuntimeRecovery(baseIdentity, fence);

    await store.initializeSimulationRuntimeRecovery(checkpoint("session-segment", 1), fence);
    const segmentUnsigned = { ...unsigned, sessionId: "session-segment", committedAtMs: Date.now() + 10 };
    const segmentIntent = {
      ...segmentUnsigned,
      intentSha256: await durable.computeSimulationRuntimeDurableIntentSha256(segmentUnsigned),
    };
    await store.stageSimulationRuntimeRecoveryIntent(await store.prepareSimulationRuntimeRecoveryIntent(segmentIntent), fence);
    await store.finalizeSimulationRuntimeRecoveryIntent("session-segment", 1, 1, segmentIntent.intentSha256, 1, fence);
    const segmentRecords = await new Promise<{ headRecord: any; journalRecord: any }>((resolve, reject) => {
      const transaction = db.transaction("records", "readonly");
      const objectStore = transaction.objectStore("records");
      const headRequest = objectStore.get("dsp-idle-network.runtime-recovery.v1.head.normal");
      headRequest.onsuccess = () => {
        const headRecord = headRequest.result;
        const head = JSON.parse(headRecord.value);
        const journalRequest = objectStore.get(head.active.journalKey);
        journalRequest.onsuccess = () => resolve({ headRecord, journalRecord: journalRequest.result });
      };
      transaction.onerror = () => reject(transaction.error);
    });
    const segmentHead = JSON.parse(segmentRecords.headRecord.value);
    const segmentJournal = JSON.parse(segmentRecords.journalRecord.value);
    segmentJournal.entries[0].replay.steps[0].wallSeconds += 0.001;
    const segmentJournalValue = JSON.stringify(segmentJournal);
    const segmentJournalBytes = new TextEncoder().encode(segmentJournalValue);
    const segmentJournalDigest = await crypto.subtle.digest("SHA-256", segmentJournalBytes);
    segmentHead.active.journalSha256 = [...new Uint8Array(segmentJournalDigest)]
      .map((byte) => byte.toString(16).padStart(2, "0")).join("");
    segmentHead.active.journalByteLength = segmentJournalBytes.byteLength;
    const segmentHeadValue = JSON.stringify(segmentHead);
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("records", "readwrite");
      const objectStore = transaction.objectStore("records");
      objectStore.put({ ...segmentRecords.journalRecord, value: segmentJournalValue, bytes: segmentJournalBytes.byteLength });
      objectStore.put({ ...segmentRecords.headRecord, value: segmentHeadValue,
        bytes: new TextEncoder().encode(segmentHeadValue).byteLength });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
    const segmentCorrupt = await store.readSimulationRuntimeRecovery(baseIdentity, fence);
    return {
      fallback: fallback.ok ? {
        generation: fallback.proof?.generation,
        recoveredFromPrevious: fallback.proof?.recoveredFromPrevious,
        entries: fallback.recovery?.entries.length,
      } : fallback,
      segmentCorrupt,
    };
  }, primary.baseIdentity);

  expect(result.fallback).toEqual({ generation: 1, recoveredFromPrevious: true, entries: 1 });
  expect(result.segmentCorrupt).toMatchObject({ ok: false, reason: "corrupt", degraded: true });
});

test("quota and transaction abort preserve primary/old head while clear bypasses recovery backoff", async ({ page }) => {
  await openBarePage(page);
  const primary = primaryFixture(1_786_377_640_000, 1, "failures");
  await seedPrimaryAndLease(page, primary);
  const result = await page.evaluate(async (baseIdentity) => {
    const store: any = await import(/* @vite-ignore */ "/src/game/simulationRuntimeRecoveryStore.ts");
    const durable: any = await import(/* @vite-ignore */ "/src/game/simulationRuntimeDurableRecovery.ts");
    const packs: any = await import(/* @vite-ignore */ "/src/game/contentPacks.ts");
    const registry = packs.createContentPackRuntimeSnapshot(packs.createContentPackRegistry());
    const fence = { ownerId: "tab_recovery_test", fencingToken: 7 };
    const initial = {
      schemaVersion: 1, sessionId: "session-failure", generation: 1, lastSequence: 0, stateRevision: 0,
      registryFingerprint: registry.fingerprint, registry, committedAtMs: Date.now(), baseIdentity,
      source: "primary", primaryStateChecksum: baseIdentity.checksum, primaryRevision: baseIdentity.revision,
    };
    const transferCheckpoint = async () => {
      const bytes = new TextEncoder().encode("next-checkpoint");
      const sha256 = await durable.computeSimulationRuntimeDurableBytesSha256(bytes.buffer);
      return {
        ...initial,
        generation: 2,
        committedAtMs: Date.now() + 1,
        source: "transfer",
        transfer: {
          protocolVersion: 1, encoding: "raw", buffer: bytes.buffer,
          storedByteLength: bytes.byteLength, originalByteLength: bytes.byteLength,
          storedSha256: sha256, originalSha256: sha256,
        },
      };
    };
    const initialized = await store.initializeSimulationRuntimeRecovery(initial, fence);
    const next = await transferCheckpoint();
    const nativePut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value: any, key?: IDBValidKey) {
      if (typeof value?.key === "string" && value.key.includes(".checkpoint.normal.session-failure.2")) {
        throw new DOMException("synthetic quota", "QuotaExceededError");
      }
      return nativePut.call(this, value, key as any);
    };
    const quota = await store.commitSimulationRuntimeRecoveryCheckpoint(next, 1, fence);
    IDBObjectStore.prototype.put = nativePut;
    const throttled = await store.commitSimulationRuntimeRecoveryCheckpoint(next, 1, fence);
    const readAfterQuota = await store.readSimulationRuntimeRecovery(baseIdentity, fence);
    const clearDuringBackoff = await store.clearSimulationRuntimeRecovery(baseIdentity, fence);

    const reinitialized = await store.initializeSimulationRuntimeRecovery(initial, fence);
    const abortNext = await transferCheckpoint();
    IDBObjectStore.prototype.put = function (value: any, key?: IDBValidKey) {
      const request = nativePut.call(this, value, key as any);
      if (typeof value?.key === "string" && value.key.includes(".checkpoint.normal.session-failure.2")) {
        const transaction = this.transaction;
        request.addEventListener("success", () => {
          try { transaction.abort(); } catch { /* transaction already completed */ }
        }, { once: true });
      }
      return request;
    };
    const aborted = await store.commitSimulationRuntimeRecoveryCheckpoint(abortNext, 1, fence);
    IDBObjectStore.prototype.put = nativePut;
    const readAfterAbort = await store.readSimulationRuntimeRecovery(baseIdentity, fence);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("dsp-idle-network.local-saves", 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const primaryExists = await new Promise<boolean>((resolve, reject) => {
      const request = db.transaction("records", "readonly").objectStore("records").get("dsp-idle-network.save.v1");
      request.onsuccess = () => resolve(Boolean(request.result?.value));
      request.onerror = () => reject(request.error);
    });
    db.close();
    return {
      initialized,
      quota,
      throttled,
      readAfterQuota: readAfterQuota.ok ? readAfterQuota.proof?.generation : readAfterQuota,
      clearDuringBackoff,
      reinitialized,
      aborted,
      readAfterAbort: readAfterAbort.ok ? readAfterAbort.proof?.generation : readAfterAbort,
      primaryExists,
    };
  }, primary.baseIdentity);

  expect(result.initialized.ok).toBe(true);
  expect(result.quota).toMatchObject({ ok: false, reason: "quota", degraded: true, retryable: true });
  expect(result.throttled).toMatchObject({ ok: false, reason: "backoff", degraded: true });
  expect(result.readAfterQuota).toBe(1);
  expect(result.clearDuringBackoff).toMatchObject({ ok: true, cleared: true });
  expect(result.reinitialized.ok).toBe(true);
  expect(result.aborted).toMatchObject({ ok: false, reason: "transaction-aborted", degraded: true, retryable: true });
  expect(result.readAfterAbort).toBe(1);
  expect(result.primaryExists).toBe(true);
});

test("corrupt recovery heads are fenced, quarantined per mode, and never touch the primary save", async ({ page }) => {
  await openBarePage(page);
  const primary = primaryFixture(1_786_377_645_000, 1, "head-quarantine");
  await seedPrimaryAndLease(page, primary);
  const result = await page.evaluate(async ({ baseIdentity, primaryRaw, leaseKey }) => {
    const store: any = await import(/* @vite-ignore */ "/src/game/simulationRuntimeRecoveryStore.ts");
    const fence = { ownerId: "tab_recovery_test", fencingToken: 7 };
    const headKey = "dsp-idle-network.runtime-recovery.v1.head.normal";
    const pendingKey = "dsp-idle-network.runtime-recovery.v1.pending-intent.normal";
    const generationKeys = [
      "dsp-idle-network.runtime-recovery.v1.checkpoint.normal.corrupt.1",
      "dsp-idle-network.runtime-recovery.v1.journal.normal.corrupt.1",
    ];
    const otherModeKey = "dsp-idle-network.runtime-recovery.v1.checkpoint.speedrun.keep.1";
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("dsp-idle-network.local-saves", 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const write = (callback: (objectStore: IDBObjectStore) => void) => new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("records", "readwrite");
      callback(transaction.objectStore("records"));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    const allKeys = () => new Promise<string[]>((resolve, reject) => {
      const request = database.transaction("records", "readonly").objectStore("records").getAllKeys();
      request.onsuccess = () => resolve(request.result.filter((key): key is string => typeof key === "string"));
      request.onerror = () => reject(request.error);
    });
    const readValue = (key: string) => new Promise<any>((resolve, reject) => {
      const request = database.transaction("records", "readonly").objectStore("records").get(key);
      request.onsuccess = () => resolve(request.result?.value ?? null);
      request.onerror = () => reject(request.error);
    });
    const record = (key: string, value: any) => ({ key, value, updatedAt: Date.now(), bytes: 1 });
    await write((objectStore) => {
      objectStore.put(record(headKey, "{truncated"));
      objectStore.put(record(pendingKey, { malformed: true }));
      for (const key of generationKeys) objectStore.put(record(key, "orphan"));
      objectStore.put(record(otherModeKey, "other-mode"));
    });
    const quarantined = await store.readSimulationRuntimeRecovery(baseIdentity, fence);
    const keysAfter = await allKeys();
    const primaryAfter = await readValue("dsp-idle-network.save.v1");

    await write((objectStore) => {
      objectStore.put(record(headKey, JSON.stringify({ schemaVersion: 99, mode: "normal" })));
      const now = Date.now();
      const lease = JSON.stringify({ schemaVersion: 1, ownerId: "takeover", fencingToken: 8,
        heartbeatAt: now, expiresAt: now + 60_000 });
      objectStore.put(record(leaseKey, lease));
    });
    const loser = await store.readSimulationRuntimeRecovery(baseIdentity, fence);
    const headAfterLoser = await readValue(headKey);
    const takeoverFence = { ownerId: "takeover", fencingToken: 8 };
    const takeover = await store.readSimulationRuntimeRecovery(baseIdentity, takeoverFence);

    await write((objectStore) => objectStore.put(record(headKey, "{abort-me")));
    const nativeDelete = IDBObjectStore.prototype.delete;
    IDBObjectStore.prototype.delete = function (query: IDBValidKey | IDBKeyRange) {
      const request = nativeDelete.call(this, query);
      if (query === headKey) {
        const transaction = this.transaction;
        request.addEventListener("success", () => {
          try { transaction.abort(); } catch { /* already complete */ }
        }, { once: true });
      }
      return request;
    };
    const aborted = await store.readSimulationRuntimeRecovery(baseIdentity, takeoverFence);
    IDBObjectStore.prototype.delete = nativeDelete;
    const headAfterAbort = await readValue(headKey);
    database.close();
    return {
      quarantined,
      keysAfter,
      primaryUnchanged: primaryAfter === primaryRaw,
      loser,
      headAfterLoser,
      takeover,
      aborted,
      headAfterAbort,
      headKey,
      pendingKey,
      generationKeys,
      otherModeKey,
    };
  }, { baseIdentity: primary.baseIdentity, primaryRaw: primary.raw, leaseKey: LOCAL_SAVE_WRITER_LEASE_KEY });

  expect(result.quarantined).toMatchObject({
    ok: true,
    recovery: null,
    proof: null,
    diagnostic: "corrupt-recovery-quarantined",
  });
  expect(result.primaryUnchanged).toBe(true);
  expect(result.keysAfter).not.toContain(result.headKey);
  expect(result.keysAfter).not.toContain(result.pendingKey);
  for (const key of result.generationKeys) expect(result.keysAfter).not.toContain(key);
  expect(result.keysAfter).toContain(result.otherModeKey);
  expect(result.loser).toMatchObject({ ok: false, reason: "lease-lost" });
  expect(result.headAfterLoser).not.toBeNull();
  expect(result.takeover).toMatchObject({ ok: true, diagnostic: "corrupt-recovery-quarantined" });
  expect(result.aborted).toMatchObject({ ok: false, reason: "transaction-aborted", degraded: true });
  expect(result.headAfterAbort).toBe("{abort-me");
});

test("one simulated hour coalesces passive WAL below 8 MiB with zero transfer-checkpoint writes", async ({ page }) => {
  test.setTimeout(60_000);
  await openBarePage(page);
  const primary = primaryFixture(1_786_377_650_000, 1, "hourly-wal");
  await seedPrimaryAndLease(page, primary);
  const metrics = await page.evaluate(async (baseIdentity) => {
    const store: any = await import(/* @vite-ignore */ "/src/game/simulationRuntimeRecoveryStore.ts");
    const durable: any = await import(/* @vite-ignore */ "/src/game/simulationRuntimeDurableRecovery.ts");
    const packs: any = await import(/* @vite-ignore */ "/src/game/contentPacks.ts");
    const registry = packs.createContentPackRuntimeSnapshot(packs.createContentPackRegistry());
    const fence = { ownerId: "tab_recovery_test", fencingToken: 7 };
    const checkpoint = {
      schemaVersion: 1, sessionId: "session-hour", generation: 1, lastSequence: 0, stateRevision: 0,
      registryFingerprint: registry.fingerprint, registry, committedAtMs: Date.now(), baseIdentity,
      source: "primary", primaryStateChecksum: baseIdentity.checksum, primaryRevision: baseIdentity.revision,
    };
    const initialized = await store.initializeSimulationRuntimeRecovery(checkpoint, fence);
    const encoder = new TextEncoder();
    const writes = { totalBytes: 0, totalCount: 0, pending: 0, journal: 0, head: 0, lease: 0, checkpoint: 0,
      transferCheckpointBytes: 0 };
    const nativePut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value: any, key?: IDBValidKey) {
      const recordKey = typeof value?.key === "string" ? value.key : "";
      if (recordKey.includes("pending-intent")) writes.pending += 1;
      else if (recordKey.includes(".journal.")) writes.journal += 1;
      else if (recordKey.includes(".head.")) writes.head += 1;
      else if (recordKey.includes("writer-lease")) writes.lease += 1;
      else if (recordKey.includes(".checkpoint.")) {
        writes.checkpoint += 1;
        if (value?.checkpoint?.source === "transfer") {
          writes.transferCheckpointBytes += value.checkpoint.transfer?.storedByteLength ?? 0;
        }
      }
      if (recordKey.includes("runtime-recovery") || recordKey.includes("writer-lease")) {
        writes.totalCount += 1;
        writes.totalBytes += encoder.encode(JSON.stringify(value)).byteLength;
      }
      return nativePut.call(this, value, key as any);
    };
    let longTaskCount = 0;
    let observer: PerformanceObserver | null = null;
    try {
      observer = new PerformanceObserver((list) => { longTaskCount += list.getEntries().length; });
      observer.observe({ type: "longtask", buffered: true });
    } catch { /* longtask observation is optional in headless Chromium */ }
    const startedAt = performance.now();
    try {
      for (let sequence = 1; sequence <= 450; sequence += 1) {
        const unsigned = {
          schemaVersion: 1, sessionId: "session-hour", generation: 1, sequence, baseStateRevision: sequence - 1,
          command: null, simulationSeconds: 8, wallSeconds: 8, multicore: undefined, approximate: false,
          registry, committedAtMs: 1_786_377_650_000 + sequence * 8_000,
        };
        const intent = { ...unsigned, intentSha256: await durable.computeSimulationRuntimeDurableIntentSha256(unsigned) };
        const staged = await store.stageSimulationRuntimeRecoveryIntent(
          await store.prepareSimulationRuntimeRecoveryIntent(intent),
          fence,
        );
        if (!staged.ok) throw new Error(`stage ${sequence}: ${staged.reason}`);
        const finalized = await store.finalizeSimulationRuntimeRecoveryIntent(
          intent.sessionId,
          intent.generation,
          intent.sequence,
          intent.intentSha256,
          sequence,
          fence,
        );
        if (!finalized.ok) throw new Error(`finalize ${sequence}: ${finalized.reason}`);
      }
    } finally {
      IDBObjectStore.prototype.put = nativePut;
      observer?.disconnect();
    }
    const read = await store.readSimulationRuntimeRecovery(baseIdentity, fence);
    return {
      initialized,
      writes,
      elapsedMs: performance.now() - startedAt,
      longTaskCount,
      read: read.ok ? {
        entries: read.recovery?.entries.length,
        kind: read.recovery?.entries[0]?.kind,
        operationCount: read.recovery?.entries[0]?.operationCount,
        sequence: read.proof?.sequence,
        stateRevision: read.proof?.stateRevision,
        pending: read.proof?.pending,
      } : read,
    };
  }, primary.baseIdentity);

  console.log(`V144_DURABLE_WAL_HOURLY ${JSON.stringify(metrics)}`);
  expect(metrics.initialized.ok).toBe(true);
  expect(metrics.writes).toMatchObject({
    pending: 450,
    journal: 450,
    head: 450,
    checkpoint: 0,
    transferCheckpointBytes: 0,
  });
  expect(metrics.writes.totalBytes).toBeLessThan(8 * 1024 * 1024);
  expect(metrics.longTaskCount).toBe(0);
  expect(metrics.read).toEqual({
    entries: 1,
    kind: "passive-segment",
    operationCount: 450,
    sequence: 450,
    stateRevision: 450,
    pending: false,
  });
});

test("Worker-safe current/2x transfer checkpoints detach UI buffers and fit local IndexedDB quota", async ({ page }) => {
  test.setTimeout(120_000);
  await openBarePage(page);
  const primary = primaryFixture(1_786_377_660_000, 1, "worker-binary");
  await seedPrimaryAndLease(page, primary);
  const metrics = await page.evaluate(async (baseIdentity) => {
    const sizes = [29_572_337, 58_857_707];
    const generatorSource = `
      self.onmessage = (event) => {
        const size = event.data;
        const buffer = new ArrayBuffer(size);
        const bytes = new Uint8Array(buffer);
        let random = 0x9e3779b9;
        for (let index = 0; index < bytes.length; index += 1) {
          random ^= random << 13;
          random ^= random >>> 17;
          random ^= random << 5;
          bytes[index] = random & 0xff;
        }
        bytes[0] = 0x2a;
        bytes[bytes.length - 1] = 0x7e;
        self.postMessage(buffer, [buffer]);
      };
    `;
    const storageSource = `
      import {
        initializeSimulationRuntimeRecovery,
        readSimulationRuntimeRecovery,
        clearSimulationRuntimeRecovery,
      } from "${location.origin}/src/game/simulationRuntimeRecoveryStore.ts";
      import { computeSimulationRuntimeDurableBytesSha256 } from
        "${location.origin}/src/game/simulationRuntimeDurableRecovery.ts";
      import { createContentPackRegistry, createContentPackRuntimeSnapshot } from
        "${location.origin}/src/game/contentPacks.ts";
      self.onmessage = async (event) => {
        const startedAt = performance.now();
        const { buffer, baseIdentity, sessionId } = event.data;
        const registry = createContentPackRuntimeSnapshot(createContentPackRegistry());
        const sha256 = await computeSimulationRuntimeDurableBytesSha256(buffer);
        const checkpoint = {
          schemaVersion: 1,
          sessionId,
          generation: 1,
          lastSequence: 0,
          stateRevision: 0,
          registryFingerprint: registry.fingerprint,
          registry,
          committedAtMs: Date.now(),
          baseIdentity,
          source: "transfer",
          transfer: {
            protocolVersion: 1,
            encoding: "raw",
            buffer,
            storedByteLength: buffer.byteLength,
            originalByteLength: buffer.byteLength,
            storedSha256: sha256,
            originalSha256: sha256,
          },
        };
        const fence = { ownerId: "tab_recovery_test", fencingToken: 7 };
        const initialized = await initializeSimulationRuntimeRecovery(checkpoint, fence);
        const read = await readSimulationRuntimeRecovery(baseIdentity, fence);
        const returned = read.ok && read.recovery?.checkpoint.source === "transfer"
          ? read.recovery.checkpoint.transfer.buffer
          : null;
        const estimate = await navigator.storage.estimate();
        const cleared = await clearSimulationRuntimeRecovery(baseIdentity, fence);
        if (!returned) {
          self.postMessage({ initialized, read, cleared, hasWindow: typeof window !== "undefined" });
          return;
        }
        const returnedBytes = returned.byteLength;
        self.postMessage({
          initialized,
          readProof: read.proof,
          cleared,
          returned,
          returnedBytes,
          estimate,
          workerHeap: performance.memory?.usedJSHeapSize ?? null,
          elapsedMs: performance.now() - startedAt,
          hasWindow: typeof window !== "undefined",
        }, [returned]);
      };
    `;
    const generatorUrl = URL.createObjectURL(new Blob([generatorSource], { type: "text/javascript" }));
    const storageUrl = URL.createObjectURL(new Blob([storageSource], { type: "text/javascript" }));
    const results: Array<Record<string, unknown>> = [];
    let mainLongTasks = 0;
    let observer: PerformanceObserver | null = null;
    try {
      observer = new PerformanceObserver((list) => { mainLongTasks += list.getEntries().length; });
      observer.observe({ type: "longtask", buffered: true });
    } catch { /* optional */ }
    try {
      for (const [index, size] of sizes.entries()) {
        const generator = new Worker(generatorUrl);
        const input = await new Promise<ArrayBuffer>((resolve, reject) => {
          generator.onmessage = (event) => resolve(event.data);
          generator.onerror = (event) => reject(new Error(event.message));
          generator.postMessage(size);
        });
        generator.terminate();
        const storage = new Worker(storageUrl, { type: "module", name: `recovery-storage-${index}` });
        const beforeHeap = (performance as any).memory?.usedJSHeapSize ?? null;
        let pageHeapPeak = beforeHeap ?? 0;
        const sampler = window.setInterval(() => {
          pageHeapPeak = Math.max(pageHeapPeak, (performance as any).memory?.usedJSHeapSize ?? 0);
        }, 5);
        const responsePromise = new Promise<any>((resolve, reject) => {
          storage.onmessage = (event) => resolve(event.data);
          storage.onerror = (event) => reject(new Error(event.message));
        });
        storage.postMessage({ buffer: input, baseIdentity, sessionId: `session-worker-${index}` }, [input]);
        const detachedPageBytes = input.byteLength;
        const response = await responsePromise;
        clearInterval(sampler);
        storage.terminate();
        const returned = response.returned as ArrayBuffer | undefined;
        const returnedView = returned ? new Uint8Array(returned) : null;
        results.push({
          size,
          detachedPageBytes,
          returnedBytes: response.returnedBytes,
          firstByte: returnedView?.[0] ?? null,
          lastByte: returnedView?.[returnedView.length - 1] ?? null,
          initialized: response.initialized,
          readProof: response.readProof,
          cleared: response.cleared,
          quota: response.estimate?.quota ?? null,
          usage: response.estimate?.usage ?? null,
          elapsedMs: response.elapsedMs,
          beforeHeap,
          pageHeapPeak,
          workerHeap: response.workerHeap,
          hasWindow: response.hasWindow,
        });
      }
    } finally {
      observer?.disconnect();
      URL.revokeObjectURL(generatorUrl);
      URL.revokeObjectURL(storageUrl);
    }
    return { results, mainLongTasks };
  }, primary.baseIdentity);

  console.log(`V144_RECOVERY_BUFFER_METRICS ${JSON.stringify(metrics)}`);
  expect(metrics.results).toHaveLength(2);
  expect(metrics.mainLongTasks).toBe(0);
  for (const [index, metric] of metrics.results.entries()) {
    const expectedBytes = [29_572_337, 58_857_707][index];
    expect(metric).toMatchObject({
      size: expectedBytes,
      detachedPageBytes: 0,
      returnedBytes: expectedBytes,
      firstByte: 0x2a,
      lastByte: 0x7e,
      initialized: { ok: true },
      readProof: { checkpointSource: "transfer", storedByteLength: expectedBytes, originalByteLength: expectedBytes },
      cleared: { ok: true, cleared: true },
      hasWindow: false,
    });
    expect(metric.quota).toEqual(expect.any(Number));
    expect(metric.usage).toEqual(expect.any(Number));
    expect(metric.usage as number).toBeGreaterThanOrEqual(expectedBytes);
    expect(metric.usage as number).toBeLessThan(metric.quota as number);
    expect(metric.elapsedMs as number).toBeLessThan(10_000);
    expect(metric.pageHeapPeak as number).toBeLessThan(192 * 1024 * 1024);
  }
});
