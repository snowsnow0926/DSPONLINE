import { expect, test, type Page } from "@playwright/test";
import { buildLocalSaveCatalog } from "../../src/game/localSaveCatalogBuild";
import { localSaveCatalogRecordKey, serializeLocalSaveCatalog } from "../../src/game/localSaveCatalog";
import { LOCAL_SAVE_WRITER_LEASE_KEY, localSaveRevisionKey } from "../../src/game/localSaveCoordination";
import { computeSaveStateChecksum } from "../../src/game/saveEnvelopeIntegrity";
import { computeSavePayloadChecksum } from "../../src/game/saveTransfer";

const SAVE_KEY = "dsp-idle-network.save.v1";

function primaryFixture(savedAt: number, revision: number, marker: string) {
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
  const raw = JSON.stringify({ formatVersion: 2, kind: "primary", savedAt, mode: "normal", slot: "main", state, checksum });
  const catalog = buildLocalSaveCatalog(SAVE_KEY, raw, revision);
  const revisionValue = JSON.stringify({
    schemaVersion: 1, saveKey: SAVE_KEY, revision, savedAt, checksum,
    deleted: false, writerId: "tab_recovery_test", fencingToken: 7, updatedAt: savedAt,
  });
  return {
    raw,
    catalogValue: serializeLocalSaveCatalog(catalog),
    revisionValue,
    baseRevision: revision,
  };
}

async function openBarePage(page: Page): Promise<void> {
  await page.goto("/src/game/authoritativeSavePersistenceClient.ts");
}

async function seedPrimary(page: Page, primary: ReturnType<typeof primaryFixture>): Promise<void> {
  await page.evaluate(async ({ primary, leaseKey, saveKey }) => {
    const catalogKey = `dsp-idle-network.local-save.catalog.v1.${encodeURIComponent(saveKey)}`;
    const revisionKey = `dsp-idle-network.local-save-coordination.v1.revision.${encodeURIComponent(saveKey)}`;
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
      store.put({ key: saveKey, value: primary.raw, updatedAt: now, bytes: new TextEncoder().encode(primary.raw).byteLength });
      store.put({ key: catalogKey, value: primary.catalogValue, updatedAt: now, bytes: primary.catalogValue.length });
      store.put({ key: revisionKey, value: primary.revisionValue, updatedAt: now, bytes: primary.revisionValue.length });
      store.put({ key: leaseKey, value: JSON.stringify({ schemaVersion: 1, ownerId: "tab_recovery_test", fencingToken: 7, heartbeatAt: now - 60_000, expiresAt: now - 1 }), updatedAt: now, bytes: 100 });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    db.close();
  }, { primary, leaseKey: LOCAL_SAVE_WRITER_LEASE_KEY, saveKey: SAVE_KEY });
}

test("bytes-only save Worker and persistence Worker atomically commit primary/catalog/revision and preserve backup", async ({ page }) => {
  await openBarePage(page);
  const primary = primaryFixture(1_786_377_700_000, 1, "old-primary");
  await seedPrimary(page, primary);
  const result = await page.evaluate(async ({ oldPrimaryRaw }) => {
    const engine: any = await import(/* @vite-ignore */ "/src/game/engine.ts");
    const protocol: any = await import(/* @vite-ignore */ "/src/game/simulationRuntimeProtocol.ts");
    const transferApi: any = await import(/* @vite-ignore */ "/src/game/saveTransfer.ts");
    const storage: any = await import(/* @vite-ignore */ "/src/game/storage.ts");
    const localStore: any = await import(/* @vite-ignore */ "/src/game/localSaveStore.ts");
    const coordination: any = await import(/* @vite-ignore */ "/src/game/localSaveCoordination.ts");
    const catalogKeys: any = await import(/* @vite-ignore */ "/src/game/localSaveCatalog.ts");
    const state = engine.createInitialState();
    state.planetViewports.home = { x: 24, y: -16, zoom: 0.9 };
    state.timeWarp.pendingSimulationSeconds = 2;
    state.timeWarp.pendingWallSeconds = 2;
    const sourceTransfer = protocol.serializeSimulationStateForTransfer(state);
    const mainLargeCalls = { parse: 0, stringify: 0, textEncoder: 0 };
    const originalParse = JSON.parse;
    const originalStringify = JSON.stringify;
    const originalEncode = TextEncoder.prototype.encode;
    JSON.parse = ((value: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => {
      if (typeof value === "string" && value.length >= 1024 * 1024) mainLargeCalls.parse += 1;
      return originalParse.call(JSON, value, reviver);
    }) as typeof JSON.parse;
    JSON.stringify = ((value: unknown, replacer?: unknown, space?: string | number) => {
      const result = originalStringify.call(JSON, value, replacer as any, space as any);
      if (result.length >= 1024 * 1024) mainLargeCalls.stringify += 1;
      return result;
    }) as typeof JSON.stringify;
    TextEncoder.prototype.encode = function(value: string) {
      if (typeof value === "string" && value.length >= 1024 * 1024) mainLargeCalls.textEncoder += 1;
      return originalEncode.call(this, value);
    };
    const longTaskEntries: PerformanceEntry[] = [];
    const observer = new PerformanceObserver((list) => longTaskEntries.push(...list.getEntries()));
    try { observer.observe({ type: "longtask", buffered: false }); } catch { /* unsupported */ }
    const overlay = {
      planetViewports: [{ planetId: "home", viewport: { x: 240, y: -160, zoom: 1.25 } }],
      timeWarp: { pendingSimulationSeconds: 17, pendingWallSeconds: 11 },
    };
    const savedState = {
      ...state,
      planetViewports: { ...state.planetViewports, home: overlay.planetViewports[0].viewport },
      timeWarp: { ...state.timeWarp, ...overlay.timeWarp },
    };
    const firstCommit = storage.saveGameVerified(savedState, sourceTransfer, overlay);
    const sourceDetachedAfterSend = sourceTransfer.buffer.byteLength === 0;
    const duplicateCommit = storage.saveGameVerified(savedState);
    const firstResult = await firstCommit;
    const duplicateResult = await duplicateCommit;
    const repeatedResult = await storage.saveGameVerified(savedState);
    const sourceMovedToDeferredSnapshot = sourceTransfer.buffer.byteLength === 0;
    const automaticSnapshotCountAtPrimaryCompletion = localStore.listLocalSaveKeys().filter((key: string) =>
      key.startsWith("dsp-idle-network.save.v1.snapshot.") && key !== "dsp-idle-network.save.v1.snapshot.sequence").length;

    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("dsp-idle-network.local-saves", 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const read = (key: string) => new Promise<any>((resolve, reject) => {
      const req = db.transaction("records", "readonly").objectStore("records").get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const firstPrimary = await read("dsp-idle-network.save.v1");
    const firstBackup = await read("dsp-idle-network.save.v1.backup");
    const firstRevision = await read(coordination.localSaveRevisionKey("dsp-idle-network.save.v1"));
    const firstEnvelope = JSON.parse(firstPrimary.value);
    const readSnapshotKeys = () => new Promise<string[]>((resolve, reject) => {
        const transaction = db.transaction("records", "readonly");
        const request = transaction.objectStore("records").getAllKeys();
        request.onsuccess = () => resolve((request.result as string[]).filter((key) =>
          key.startsWith("dsp-idle-network.save.v1.snapshot.") && key !== "dsp-idle-network.save.v1.snapshot.sequence"));
        request.onerror = () => reject(request.error);
      });
    let snapshotKeys = await readSnapshotKeys();
    const snapshotDeadline = performance.now() + 5_000;
    while (snapshotKeys.length === 0 && performance.now() < snapshotDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      snapshotKeys = await readSnapshotKeys();
    }

    // Corrupt only the old primary envelope while keeping its catalog FNV and
    // revision metadata internally bound. Full envelope verification must then
    // skip backup replacement and preserve the already-valid backup.
    const corrupt = oldPrimaryRaw.replace("old-primary", "tampered-primary");
    const oldCatalog = JSON.parse((await read(catalogKeys.localSaveCatalogRecordKey("dsp-idle-network.save.v1"))).value);
    oldCatalog.payloadChecksum = transferApi.computeSavePayloadChecksum(new TextEncoder().encode(corrupt));
    oldCatalog.byteLength = new TextEncoder().encode(corrupt).byteLength;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("records", "readwrite");
      const store = tx.objectStore("records");
      store.put({ key: "dsp-idle-network.save.v1", value: corrupt, updatedAt: Date.now(), bytes: oldCatalog.byteLength });
      store.put({ key: catalogKeys.localSaveCatalogRecordKey("dsp-idle-network.save.v1"), value: JSON.stringify(oldCatalog), updatedAt: Date.now(), bytes: JSON.stringify(oldCatalog).length });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    // Use a distinct immutable state identity so the normal unchanged-save
    // fast path cannot mask the corrupt-old-primary backup assertion.
    const changedState = { ...state, elapsedSeconds: state.elapsedSeconds + 1 };
    const secondTransfer = protocol.serializeSimulationStateForTransfer(changedState);
    const secondCommit = await storage.saveGameVerified(changedState, secondTransfer);
    const backupAfterCorrupt = await read("dsp-idle-network.save.v1.backup");
    db.close();
    observer.disconnect();
    JSON.parse = originalParse;
    JSON.stringify = originalStringify;
    TextEncoder.prototype.encode = originalEncode;
    return {
      sourceDetachedAfterSend,
      sourceMovedToDeferredSnapshot,
      automaticSnapshotCountAtPrimaryCompletion,
      firstCommit: firstResult,
      duplicateCommit: duplicateResult,
      repeatedCommit: repeatedResult,
      firstPrimaryBytes: firstPrimary?.bytes,
      firstBackupEqualsOld: firstBackup?.value === oldPrimaryRaw,
      firstRevision: JSON.parse(firstRevision.value).revision,
      primaryViewport: firstEnvelope.state.planetViewports.home,
      primaryDebt: firstEnvelope.state.timeWarp,
      automaticSnapshotCount: snapshotKeys.length,
      secondCommit,
      backupPreservedAfterCorrupt: backupAfterCorrupt?.value === oldPrimaryRaw,
      largeLongTasks: longTaskEntries.filter((entry) => entry.duration > 50).length,
      mainLargeCalls,
    };
  }, { oldPrimaryRaw: primary.raw });

  expect(result.sourceDetachedAfterSend).toBe(true);
  expect(result.sourceMovedToDeferredSnapshot).toBe(true);
  expect(result.automaticSnapshotCountAtPrimaryCompletion).toBe(0);
  expect(result.firstCommit).toMatchObject({ success: true, backupSaved: true });
  expect(result.duplicateCommit).toMatchObject({ success: true, backupSaved: true });
  expect(result.repeatedCommit).toMatchObject({ success: true, skippedUnchanged: true, backupSaved: true });
  expect(result.firstPrimaryBytes).toBeGreaterThan(0);
  expect(result.firstBackupEqualsOld).toBe(true);
  expect(result.firstRevision).toBe(2);
  expect(result.primaryViewport).toEqual({ x: 240, y: -160, zoom: 1.25 });
  expect(result.primaryDebt).toMatchObject({ pendingSimulationSeconds: 17, pendingWallSeconds: 11 });
  expect(result.automaticSnapshotCount).toBe(1);
  expect(result.secondCommit).toMatchObject({ success: true, backupSaved: false });
  expect(result.backupPreservedAfterCorrupt).toBe(true);
  expect(result.largeLongTasks).toBe(0);
  expect(result.mainLargeCalls).toEqual({ parse: 0, stringify: 0, textEncoder: 0 });
});

test("proof-bound persistence renews an expired lease only for its exact writer fence", async ({ page }) => {
  await openBarePage(page);
  const primary = primaryFixture(1_786_377_700_500, 1, "expired-owned-fence");
  await seedPrimary(page, primary);
  const result = await page.evaluate(async () => {
    const engine: any = await import(/* @vite-ignore */ "/src/game/engine.ts");
    const protocol: any = await import(/* @vite-ignore */ "/src/game/simulationRuntimeProtocol.ts");
    const storage: any = await import(/* @vite-ignore */ "/src/game/storage.ts");
    const store: any = await import(/* @vite-ignore */ "/src/game/localSaveStore.ts");
    const coordination: any = await import(/* @vite-ignore */ "/src/game/localSaveCoordination.ts");
    await store.initializeLocalSaveStore();
    const writer = store.getLocalSaveWriterStatus();
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("dsp-idle-network.local-saves", 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("records", "readwrite");
      const objectStore = transaction.objectStore("records");
      const request = objectStore.get(coordination.LOCAL_SAVE_WRITER_LEASE_KEY);
      request.onsuccess = () => {
        const lease = JSON.parse(request.result.value);
        if (lease.ownerId !== writer.writerId || lease.fencingToken !== writer.fencingToken) {
          throw new Error("test no longer owns the durable writer fence");
        }
        const expired = JSON.stringify({ ...lease, heartbeatAt: Date.now() - 30_000, expiresAt: Date.now() - 1 });
        objectStore.put({ ...request.result, value: expired, updatedAt: Date.now(), bytes: expired.length });
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    db.close();

    const state = engine.createInitialState();
    state.elapsedSeconds = 2;
    const transfer = protocol.serializeSimulationStateForTransfer(state);
    const saved = await storage.saveGameVerified(state, transfer);
    return {
      saved,
      conflicts: (await store.getLocalSaveConflicts()).length,
      writer: store.getLocalSaveWriterStatus(),
      revision: store.getPrimaryLocalSaveRevision("normal"),
    };
  });
  expect(result.saved).toMatchObject({ success: true });
  expect(result.conflicts).toBe(0);
  expect(result.writer).toMatchObject({ role: "primary" });
  expect(result.revision).toBe(2);
});

test("a later same-page legacy primary rebases behind an admitted proof commit without a false conflict", async ({ page }) => {
  test.setTimeout(120_000);
  await openBarePage(page);
  const primary = primaryFixture(1_786_377_700_750, 1, "same-page-proof-base");
  await seedPrimary(page, primary);
  const result = await page.evaluate(async () => {
    const engine: any = await import(/* @vite-ignore */ "/src/game/engine.ts");
    const protocol: any = await import(/* @vite-ignore */ "/src/game/simulationRuntimeProtocol.ts");
    const serializer: any = await import(/* @vite-ignore */ "/src/game/authoritativeSaveSerializationClient.ts");
    const storage: any = await import(/* @vite-ignore */ "/src/game/storage.ts");
    const store: any = await import(/* @vite-ignore */ "/src/game/localSaveStore.ts");
    await store.initializeLocalSaveStore();

    let proofState = engine.createInitialState();
    proofState.construction.storage_mk1 = 1;
    proofState = engine.placeBuilding(proofState, "storage_mk1", { x: 0, y: 0 });
    const template = proofState.entities.at(-1)!;
    const entities = proofState.entities.slice(0, -1);
    for (let index = 0; index < 40_000; index += 1) {
      entities.push({
        ...template,
        id: `same_page_proof_${index}`,
        position: { x: index % 1_000, y: Math.floor(index / 1_000) },
      });
    }
    proofState.entities = entities;
    proofState.elapsedSeconds = 2;
    const transfer = protocol.serializeSimulationStateForTransfer(proofState);
    const serialized = await serializer.serializeAuthoritativeSaveStateTransferInWorker(transfer, { savedAt: Date.now() });
    const writer = store.getLocalSaveWriterStatus();
    const proofCommit = store.setLocalSavePayloadWithProof({
      key: "dsp-idle-network.save.v1",
      bytes: serialized.bytes,
      proof: serialized.proof,
      seed: serialized.catalogSeed,
      expectedRevision: store.getPrimaryLocalSaveRevision("normal"),
      fence: { ownerId: writer.writerId, fencingToken: writer.fencingToken },
    });
    // Let the proof queue take admission, then enqueue the later lifecycle
    // candidate in the same page while the large payload is still in flight.
    await Promise.resolve();
    await Promise.resolve();
    const laterState = engine.createInitialState();
    laterState.elapsedSeconds = 3;
    const laterRaw = storage.serializeEnvelope(laterState, Date.now() + 1);
    store.setLocalSaveValue("dsp-idle-network.save.v1", laterRaw);
    const proof = await proofCommit;
    let flushError: string | null = null;
    try {
      await store.flushLocalSaveWrites();
    } catch (error) {
      flushError = error instanceof Error ? error.name : "unknown";
    }
    const persisted = await store.readPersistedLocalSaveValue("dsp-idle-network.save.v1");
    return {
      proof,
      flushError,
      laterWins: persisted === laterRaw,
      persistedElapsedSeconds: persisted ? JSON.parse(persisted).state.elapsedSeconds : null,
      conflicts: (await store.getLocalSaveConflicts()).length,
      writer: store.getLocalSaveWriterStatus(),
      revision: store.getPrimaryLocalSaveRevision("normal"),
    };
  });
  expect(result.proof.result).toMatchObject({ ok: true });
  expect(result.flushError).toBeNull();
  expect(result.laterWins).toBe(true);
  expect(result.persistedElapsedSeconds).toBe(3);
  expect(result.conflicts).toBe(0);
  expect(result.writer).toMatchObject({ role: "primary" });
  expect(result.revision).toBe(3);
});

test("proof-bound persistence rejects cross-seed and stale-fence writes without changing primary", async ({ page }) => {
  await openBarePage(page);
  const primary = primaryFixture(1_786_377_701_000, 1, "cross-seed");
  await seedPrimary(page, primary);
  const result = await page.evaluate(async () => {
    const engine: any = await import(/* @vite-ignore */ "/src/game/engine.ts");
    const protocol: any = await import(/* @vite-ignore */ "/src/game/simulationRuntimeProtocol.ts");
    const serializer: any = await import(/* @vite-ignore */ "/src/game/authoritativeSaveSerializationClient.ts");
    const persistence: any = await import(/* @vite-ignore */ "/src/game/authoritativeSavePersistenceClient.ts");
    const state = engine.createInitialState();
    const transfer = protocol.serializeSimulationStateForTransfer(state);
    const serialized = await serializer.serializeAuthoritativeSaveStateTransferInWorker(transfer, { savedAt: Date.now() });
    const writer = { ownerId: "tab_recovery_test", fencingToken: 7 };
    const tamperedSeed = { ...serialized.catalogSeed, entityCount: serialized.catalogSeed.entityCount + 1 };
    const tampered = await persistence.commitAuthoritativeSavePayloadInPersistenceWorker({
      key: "dsp-idle-network.save.v1",
      bytes: serialized.bytes,
      proof: serialized.proof,
      seed: tamperedSeed,
      expectedRevision: 1,
      fence: writer,
    });
    const payload = new Uint8Array([99, 98, 97]).buffer;
    const crossPayload = await persistence.commitAuthoritativeSavePayloadInPersistenceWorker({
      key: "dsp-idle-network.save.v1",
      bytes: payload,
      proof: serialized.proof,
      seed: serialized.catalogSeed,
      expectedRevision: 1,
      fence: writer,
    });
    persistence.terminateAuthoritativeSavePersistenceWorker();
    return { tampered, crossPayload };
  });
  expect(result.tampered.result).toMatchObject({ ok: false, reason: "invalid" });
  expect(result.crossPayload.result).toMatchObject({ ok: false, reason: "invalid" });
});

test("checkpoint overlays are proof-bound and invalid overlay input never creates a primary revision", async ({ page }) => {
  await openBarePage(page);
  const primary = primaryFixture(1_786_377_702_000, 1, "overlay-base");
  await seedPrimary(page, primary);
  const result = await page.evaluate(async () => {
    const engine: any = await import(/* @vite-ignore */ "/src/game/engine.ts");
    const protocol: any = await import(/* @vite-ignore */ "/src/game/simulationRuntimeProtocol.ts");
    const storage: any = await import(/* @vite-ignore */ "/src/game/storage.ts");
    const store: any = await import(/* @vite-ignore */ "/src/game/localSaveStore.ts");
    const state = engine.createInitialState();
    const invalidTransfer = protocol.serializeSimulationStateForTransfer(state);
    const invalid = await storage.saveGameVerified(state, invalidTransfer, {
      planetViewports: [{ planetId: "missing-planet", viewport: { x: 0, y: 0, zoom: 1 } }],
    });
    const afterInvalid = await store.readPersistedLocalSaveValue("dsp-idle-network.save.v1");
    const validTransfer = protocol.serializeSimulationStateForTransfer(state);
    const saved = await storage.saveGameVerified({
      ...state,
      planetViewports: { ...state.planetViewports, home: { x: -77, y: 33, zoom: 1.4 } },
      timeWarp: { ...state.timeWarp, pendingSimulationSeconds: 9, pendingWallSeconds: 7 },
    }, validTransfer, {
      planetViewports: [{ planetId: "home", viewport: { x: -77, y: 33, zoom: 1.4 } }],
      timeWarp: { pendingSimulationSeconds: 9, pendingWallSeconds: 7 },
    });
    const afterValid = await store.readPersistedLocalSaveValue("dsp-idle-network.save.v1");
    return {
      invalid,
      unchangedAfterInvalid: afterInvalid?.includes("overlay-base") === true,
      saved,
      persisted: afterValid ? JSON.parse(afterValid).state : null,
    };
  });
  expect(result.invalid).toMatchObject({ success: false });
  expect(result.unchangedAfterInvalid).toBe(true);
  expect(result.saved).toMatchObject({ success: true });
  expect(result.persisted).toMatchObject({
    planetViewports: { home: { x: -77, y: 33, zoom: 1.4 } },
    timeWarp: { pendingSimulationSeconds: 9, pendingWallSeconds: 7 },
  });
});
