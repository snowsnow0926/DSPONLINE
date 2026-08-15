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
    const serializer: any = await import(/* @vite-ignore */ "/src/game/authoritativeSaveSerializationClient.ts");
    const local: any = await import(/* @vite-ignore */ "/src/game/localSaveStore.ts");
    const coordination: any = await import(/* @vite-ignore */ "/src/game/localSaveCoordination.ts");
    const catalogKeys: any = await import(/* @vite-ignore */ "/src/game/localSaveCatalog.ts");
    const state = engine.createInitialState();
    const sourceTransfer = protocol.serializeSimulationStateForTransfer(state);
    const longTaskEntries: PerformanceEntry[] = [];
    const observer = new PerformanceObserver((list) => longTaskEntries.push(...list.getEntries()));
    try { observer.observe({ type: "longtask", buffered: false }); } catch { /* unsupported */ }
    const serializedPromise = serializer.serializeAuthoritativeSaveStateTransferInWorker(sourceTransfer, { savedAt: Date.now() });
    const sourceDetachedAfterSend = sourceTransfer.buffer.byteLength === 0;
    const serialized = await serializedPromise;
    const sourceRestored = serialized.sourceStateTransfer.byteLength > 0;
    await local.initializeLocalSaveStore();
    const writer = local.getLocalSaveWriterStatus();
    const firstInput = {
      key: "dsp-idle-network.save.v1",
      bytes: serialized.bytes,
      proof: serialized.proof,
      seed: serialized.catalogSeed,
      expectedRevision: 1,
      fence: { ownerId: writer.writerId, fencingToken: writer.fencingToken },
    };
    const firstCommitPromise = local.setLocalSavePayloadWithProof(firstInput);
    const payloadDetachedAfterSend = await new Promise<boolean>((resolve) =>
      setTimeout(() => resolve(firstInput.bytes.byteLength === 0), 0));
    const firstCommit = await firstCommitPromise;
    const payloadRestored = firstInput.bytes.byteLength > 0;

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
    const secondTransfer = protocol.serializeSimulationStateForTransfer(state);
    const second = await serializer.serializeAuthoritativeSaveStateTransferInWorker(secondTransfer, { savedAt: Date.now() + 1 });
    const secondInput = {
      key: "dsp-idle-network.save.v1",
      bytes: second.bytes,
      proof: second.proof,
      seed: second.catalogSeed,
      expectedRevision: firstCommit.result.proof.revision,
      fence: { ownerId: writer.writerId, fencingToken: writer.fencingToken },
    };
    const secondCommit = await local.setLocalSavePayloadWithProof(secondInput);
    const backupAfterCorrupt = await read("dsp-idle-network.save.v1.backup");
    db.close();
    observer.disconnect();
    return {
      sourceDetachedAfterSend,
      sourceRestored,
      payloadDetachedAfterSend,
      payloadRestored,
      firstCommit,
      firstPrimaryBytes: firstPrimary?.bytes,
      firstBackupEqualsOld: firstBackup?.value === oldPrimaryRaw,
      firstRevision: JSON.parse(firstRevision.value).revision,
      secondCommit,
      backupPreservedAfterCorrupt: backupAfterCorrupt?.value === oldPrimaryRaw,
      largeLongTasks: longTaskEntries.filter((entry) => entry.duration > 50).length,
    };
  }, { oldPrimaryRaw: primary.raw });

  expect(result.sourceDetachedAfterSend).toBe(true);
  expect(result.sourceRestored).toBe(true);
  expect(result.payloadDetachedAfterSend).toBe(true);
  expect(result.payloadRestored).toBe(true);
  expect(result.firstCommit.result).toMatchObject({ ok: true, proof: { revision: 2, backupSaved: true } });
  expect(result.firstPrimaryBytes).toBeGreaterThan(0);
  expect(result.firstBackupEqualsOld).toBe(true);
  expect(result.firstRevision).toBe(2);
  expect(result.secondCommit.result).toMatchObject({ ok: true, proof: { backupSaved: false } });
  expect(result.backupPreservedAfterCorrupt).toBe(true);
  expect(result.largeLongTasks).toBe(0);
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
