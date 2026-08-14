import { expect, test } from "@playwright/test";

test("legacy catalog repair replaces stale/corrupt sidecars but never crosses revision or writer fences", async ({ page }) => {
  await page.goto("/src/game/localSaveCatalogIndex.ts");
  const result = await page.evaluate(async () => {
    const indexer = await import("/src/game/localSaveCatalogIndex.ts");
    const catalogModule = await import("/src/game/localSaveCatalog.ts");
    const catalogBuild = await import("/src/game/localSaveCatalogBuild.ts");
    const coordination = await import("/src/game/localSaveCoordination.ts");
    const storage = await import("/src/game/storage.ts");
    const engine = await import("/src/game/engine.ts");
    const key = "dsp-idle-network.save.v1";
    const catalogKey = catalogModule.localSaveCatalogRecordKey(key);
    const writer = { writerId: "catalog-repair-writer", fencingToken: 7 };
    const makePayload = (elapsedSeconds: number, savedAt: number) => {
      const state = engine.createInitialState();
      state.elapsedSeconds = elapsedSeconds;
      return storage.serializeEnvelope(state, savedAt);
    };
    const rawA = makePayload(10, 1_786_377_700_000);
    const rawB = makePayload(20, 1_786_377_700_100);
    const catalogA = catalogBuild.buildLocalSaveCatalog(key, rawA, 1);
    const catalogB = catalogBuild.buildLocalSaveCatalog(key, rawB, 2);
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("dsp-idle-network.local-saves", 2);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("records")) request.result.createObjectStore("records", { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const stored = (recordKey: string, value: string) => ({
      key: recordKey,
      value,
      updatedAt: Date.now(),
      bytes: new TextEncoder().encode(value).byteLength,
    });
    const revision = (revisionNumber: number, catalog: any, owner = writer.writerId, token = writer.fencingToken) => JSON.stringify({
      schemaVersion: 1,
      saveKey: key,
      revision: revisionNumber,
      savedAt: catalog.savedAt,
      checksum: catalog.stateChecksum,
      deleted: false,
      writerId: owner,
      fencingToken: token,
      updatedAt: Date.now(),
    });
    const lease = (owner: string, token: number) => JSON.stringify({
      schemaVersion: 1,
      ownerId: owner,
      fencingToken: token,
      heartbeatAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    const write = (actions: (store: IDBObjectStore) => void) => new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("records", "readwrite");
      actions(transaction.objectStore("records"));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    const readValue = (recordKey: string) => new Promise<string | null>((resolve, reject) => {
      const request = database.transaction("records", "readonly").objectStore("records").get(recordKey);
      request.onsuccess = () => resolve(request.result?.value ?? null);
      request.onerror = () => reject(request.error);
    });

    // Exact 1.0.43 rollback shape: payload+revision advance while the unknown
    // 1.0.44 sidecar is left untouched.
    await write((store) => {
      store.clear();
      store.put(stored(key, rawB));
      store.put(stored(catalogKey, catalogModule.serializeLocalSaveCatalog(catalogA)));
      store.put(stored(coordination.localSaveRevisionKey(key), revision(2, catalogB)));
      store.put(stored(coordination.LOCAL_SAVE_WRITER_LEASE_KEY, lease(writer.writerId, writer.fencingToken)));
    });
    const repairedStale = await indexer.indexLegacyLocalSaveCatalog(database, "records", key, writer);
    const staleValue = await readValue(catalogKey);
    const staleCatalog = catalogModule.parseLocalSaveCatalog(staleValue, key);

    await write((store) => store.put(stored(catalogKey, "{broken-catalog")));
    const repairedCorrupt = await indexer.indexLegacyLocalSaveCatalog(database, "records", key, writer);
    const corruptValue = await readValue(catalogKey);
    const corruptCatalog = catalogModule.parseLocalSaveCatalog(corruptValue, key);

    await write((store) => {
      store.put(stored(catalogKey, "{must-remain-while-fenced"));
      store.put(stored(coordination.LOCAL_SAVE_WRITER_LEASE_KEY, lease("takeover-writer", 8)));
    });
    const fenced = await indexer.indexLegacyLocalSaveCatalog(database, "records", key, writer);
    const valueWhileFenced = await readValue(catalogKey);
    const takeoverWriter = { writerId: "takeover-writer", fencingToken: 8 };
    const repairedAfterTakeover = await indexer.indexLegacyLocalSaveCatalog(database, "records", key, takeoverWriter);
    const takeoverCatalog = catalogModule.parseLocalSaveCatalog(await readValue(catalogKey), key);

    // Delay only the Worker response so a rollback client can change payload
    // and revision between the off-main build and the fenced write CAS.
    await write((store) => {
      store.put(stored(key, rawA));
      store.put(stored(catalogKey, "{concurrent-stale"));
      store.put(stored(coordination.localSaveRevisionKey(key), revision(3, catalogA, takeoverWriter.writerId, takeoverWriter.fencingToken)));
      store.put(stored(coordination.LOCAL_SAVE_WRITER_LEASE_KEY, lease(takeoverWriter.writerId, takeoverWriter.fencingToken)));
    });
    const NativeWorker = window.Worker;
    class DelayedWorker {
      private readonly inner: Worker;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      onmessageerror: ((event: MessageEvent) => void) | null = null;
      constructor(url: URL, options?: WorkerOptions) {
        this.inner = new NativeWorker(url, options);
        this.inner.onmessage = (event) => window.setTimeout(() => this.onmessage?.(event), 50);
        this.inner.onerror = (event) => { this.onerror?.(event); };
        this.inner.onmessageerror = (event) => { this.onmessageerror?.(event); };
      }
      postMessage(message: unknown, transfer?: Transferable[]): void {
        this.inner.postMessage(message, transfer ?? []);
      }
      terminate(): void { this.inner.terminate(); }
    }
    (window as any).Worker = DelayedWorker;
    const concurrentPromise = indexer.indexLegacyLocalSaveCatalog(database, "records", key, takeoverWriter);
    await new Promise((resolve) => window.setTimeout(resolve, 5));
    await write((store) => {
      store.put(stored(key, rawB));
      store.put(stored(coordination.localSaveRevisionKey(key), revision(4, catalogB, takeoverWriter.writerId, takeoverWriter.fencingToken)));
    });
    const concurrent = await concurrentPromise;
    (window as any).Worker = NativeWorker;
    const valueAfterConcurrentChange = await readValue(catalogKey);
    const repairedAfterConcurrent = await indexer.indexLegacyLocalSaveCatalog(database, "records", key, takeoverWriter);
    const finalCatalog = catalogModule.parseLocalSaveCatalog(await readValue(catalogKey), key);
    database.close();
    return {
      repairedStale,
      staleCatalog,
      repairedCorrupt,
      corruptCatalog,
      fenced,
      valueWhileFenced,
      repairedAfterTakeover,
      takeoverCatalog,
      concurrent,
      valueAfterConcurrentChange,
      repairedAfterConcurrent,
      finalCatalog,
    };
  });

  expect(result.repairedStale).toMatchObject({ catalog: { revision: 2, elapsedSeconds: 20, integrity: "valid" } });
  expect(result.staleCatalog).toMatchObject({ revision: 2, elapsedSeconds: 20, integrity: "valid" });
  expect(result.repairedCorrupt).toMatchObject({ catalog: { revision: 2, elapsedSeconds: 20 } });
  expect(result.corruptCatalog).toMatchObject({ revision: 2, elapsedSeconds: 20 });
  expect(result.fenced).toBeNull();
  expect(result.valueWhileFenced).toBe("{must-remain-while-fenced");
  expect(result.repairedAfterTakeover).toMatchObject({ catalog: { revision: 2, elapsedSeconds: 20 } });
  expect(result.takeoverCatalog).toMatchObject({ revision: 2, elapsedSeconds: 20 });
  expect(result.concurrent).toBeNull();
  expect(result.valueAfterConcurrentChange).toBe("{concurrent-stale");
  expect(result.repairedAfterConcurrent).toMatchObject({ catalog: { revision: 4, elapsedSeconds: 20 } });
  expect(result.finalCatalog).toMatchObject({ revision: 4, elapsedSeconds: 20, integrity: "valid" });
});
