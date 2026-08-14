import { expect, test, type Page } from "@playwright/test";
import { localSaveCatalogRecordKey, serializeLocalSaveCatalog } from "../../src/game/localSaveCatalog";
import { buildLocalSaveCatalog } from "../../src/game/localSaveCatalogBuild";

const SAVE_KEY = "dsp-idle-network.save.v1";
const DATABASE_NAME = "dsp-idle-network.local-saves";
const STORE_NAME = "records";

function anonymousPayload(targetBytes: number): string {
  const envelope = {
    formatVersion: 2,
    kind: "primary",
    savedAt: 1_786_377_600_000,
    mode: "normal",
    slot: "main",
    state: {
      version: 46,
      mode: "normal",
      elapsedSeconds: 12_345,
      activePlanetId: "home",
      entities: [{ id: "anonymous-entity" }],
      belts: [{ id: "anonymous-belt" }],
      research: { completedTechIds: ["electromagnetism"] },
      dysonSphere: { structurePoints: 7 },
      padding: "",
    },
  };
  const base = JSON.stringify(envelope);
  return base.replace('"padding":""', `"padding":"${"x".repeat(targetBytes - Buffer.byteLength(base))}"`);
}

async function seedCatalogedPayload(page: Page, raw: string): Promise<number> {
  const catalog = buildLocalSaveCatalog(SAVE_KEY, raw, 0);
  const catalogValue = serializeLocalSaveCatalog(catalog);
  await page.evaluate(async ({ raw, catalogKey, catalogValue }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("dsp-idle-network.local-saves", 2);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("records")) request.result.createObjectStore("records", { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("records", "readwrite");
      const store = transaction.objectStore("records");
      store.clear();
      store.put({ key: "dsp-idle-network.save.v1", value: raw, updatedAt: Date.now(), bytes: new TextEncoder().encode(raw).byteLength });
      store.put({ key: catalogKey, value: catalogValue, updatedAt: Date.now(), bytes: new TextEncoder().encode(catalogValue).byteLength });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
  }, { raw, catalogKey: localSaveCatalogRecordKey(SAVE_KEY), catalogValue });
  return new TextEncoder().encode(catalogValue).byteLength;
}

async function seedLegacyPayload(page: Page, raw: string): Promise<void> {
  await page.evaluate(async (raw) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("dsp-idle-network.local-saves", 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("records", "readwrite");
      const store = transaction.objectStore("records");
      store.clear();
      store.put({ key: "dsp-idle-network.save.v1", value: raw, updatedAt: Date.now(), bytes: new TextEncoder().encode(raw).byteLength });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
  }, raw);
}

async function installColdReadInstrumentation(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const diagnostics = { payloadGets: [] as string[], getAllCalls: 0, largeParses: [] as number[], longTasks: [] as number[] };
    (window as any).__v144CatalogDiagnostics = diagnostics;
    const nativeGet = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (query: IDBValidKey | IDBKeyRange) {
      if (typeof query === "string" && (query === "dsp-idle-network.save.v1" ||
        query.startsWith("dsp-idle-network.save.v1.backup") ||
        query.startsWith("dsp-idle-network.save.v1.snapshot.") ||
        query.startsWith("dsp-idle-network.slot."))) {
        diagnostics.payloadGets.push(query);
      }
      return nativeGet.call(this, query);
    };
    const nativeGetAll = IDBObjectStore.prototype.getAll;
    IDBObjectStore.prototype.getAll = function (...args: Parameters<IDBObjectStore["getAll"]>) {
      diagnostics.getAllCalls += 1;
      return nativeGetAll.apply(this, args);
    };
    const nativeParse = JSON.parse;
    JSON.parse = function (value: string, reviver?: (this: any, key: string, value: any) => any) {
      const startedAt = performance.now();
      const parsed = nativeParse.call(JSON, value, reviver);
      if (typeof value === "string" && value.length >= 1024 * 1024) diagnostics.largeParses.push(performance.now() - startedAt);
      return parsed;
    };
    try {
      new PerformanceObserver((list) => diagnostics.longTasks.push(...list.getEntries().map((entry) => entry.duration)))
        .observe({ type: "longtask", buffered: true });
    } catch { /* long-task entries are optional outside Chromium */ }
  });
}

test("catalog-backed current and 2x cold menus never hydrate or parse payload strings", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/?menu=1&storageMigration=production");
  await expect(page.locator(".start-menu")).toBeVisible();
  await installColdReadInstrumentation(page);

  const reports: Array<{ bytes: number; samples: number[]; catalogBytes: number }> = [];
  for (const bytes of [Math.floor(29.7 * 1024 * 1024), Math.floor(59.4 * 1024 * 1024)]) {
    const raw = anonymousPayload(bytes);
    const catalogBytes = await seedCatalogedPayload(page, raw);
    const samples: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const startedAt = Date.now();
      await page.reload();
      await expect(page.locator(".start-menu")).toBeVisible();
      await expect(page.locator(".start-menu-primary")).toContainText("继续游戏");
      samples.push(Date.now() - startedAt);
      const diagnostics = await page.evaluate(async () => ({
        instrumentation: (window as any).__v144CatalogDiagnostics,
        rawCacheEntries: (await import("/src/game/localSaveStore.ts")).getLocalSaveRawCacheSize(),
        handle: (await import("/src/game/savePreview.ts")).getMenuContinueSave("normal"),
      }));
      expect(diagnostics.instrumentation.payloadGets).toEqual([]);
      expect(diagnostics.instrumentation.getAllCalls).toBe(0);
      expect(diagnostics.instrumentation.largeParses).toEqual([]);
      expect(diagnostics.rawCacheEntries).toBe(0);
      expect(diagnostics.handle).not.toHaveProperty("raw");
      expect(diagnostics.handle).toMatchObject({ byteLength: bytes, summary: { entityCount: 1, beltCount: 1, stateVersion: 46 } });
    }
    expect(catalogBytes).toBeLessThan(4 * 1024);
    reports.push({ bytes, samples, catalogBytes });
  }
  const sorted = reports.flatMap((report) => report.samples).sort((left, right) => left - right);
  const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
  expect(p95).toBeLessThanOrEqual(500);
  console.log(`V144_COLD_CATALOG ${JSON.stringify({ p95, reports })}`);
});

test("legacy 35 MiB indexing parses one payload off-main and writes a bound small catalog", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/?menu=1&storageMigration=production");
  await expect(page.locator(".start-menu")).toBeVisible();
  await installColdReadInstrumentation(page);
  await seedLegacyPayload(page, anonymousPayload(35 * 1024 * 1024));
  await page.reload();
  await expect(page.locator(".start-menu")).toBeVisible();
  await expect.poll(() => page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("dsp-idle-network.local-saves");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const value = await new Promise<string | null>((resolve, reject) => {
      const request = database.transaction("records", "readonly").objectStore("records")
        .get("dsp-idle-network.local-save.catalog.v1.dsp-idle-network.save.v1");
      request.onsuccess = () => resolve(request.result?.value ?? null);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return value ? new TextEncoder().encode(value).byteLength : 0;
  }), { timeout: 30_000 }).toBeGreaterThan(0);
  await expect(page.locator(".start-menu-resume")).toContainText("3 小时 25 分");
  const diagnostics = await page.evaluate(async () => ({
    instrumentation: (window as any).__v144CatalogDiagnostics,
    rawCacheEntries: (await import("/src/game/localSaveStore.ts")).getLocalSaveRawCacheSize(),
    syncFallbacks: performance.getEntriesByName("local-save-catalog-sync-fallback").length,
  }));
  expect(diagnostics.instrumentation.getAllCalls).toBe(0);
  expect(diagnostics.instrumentation.largeParses).toEqual([]);
  expect(diagnostics.instrumentation.payloadGets).toHaveLength(2);
  expect(diagnostics.rawCacheEntries).toBe(0);
  expect(diagnostics.syncFallbacks).toBe(0);
});

test("a checksum-bound corrupt primary is read once before lazy Worker fallback selects backup", async ({ page }) => {
  await page.goto("/?menu=1&storageMigration=production");
  await expect(page.locator(".start-menu")).toBeVisible();
  const payloads = await page.evaluate(async () => {
    const storage = await import("/src/game/storage.ts");
    const engine = await import("/src/game/engine.ts");
    const primary = engine.createInitialState();
    primary.elapsedSeconds = 10;
    const backup = engine.createInitialState();
    backup.elapsedSeconds = 9;
    return { primary: storage.serializeEnvelope(primary, 200), backup: storage.serializeEnvelope(backup, 100) };
  });
  const primaryCatalog = serializeLocalSaveCatalog(buildLocalSaveCatalog(SAVE_KEY, payloads.primary, 0));
  const backupKey = `${SAVE_KEY}.backup`;
  const backupCatalog = serializeLocalSaveCatalog(buildLocalSaveCatalog(backupKey, payloads.backup, 0));
  const corruptedPrimary = payloads.primary.replace('"elapsedSeconds":10', '"elapsedSeconds":11');
  expect(corruptedPrimary).not.toBe(payloads.primary);
  expect(Buffer.byteLength(corruptedPrimary)).toBe(Buffer.byteLength(payloads.primary));
  await page.evaluate(async ({ primary, backup, primaryCatalog, backupCatalog, backupKey }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("dsp-idle-network.local-saves");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("records", "readwrite");
      const store = transaction.objectStore("records");
      store.clear();
      for (const [key, value] of [
        ["dsp-idle-network.save.v1", primary],
        [backupKey, backup],
        ["dsp-idle-network.local-save.catalog.v1.dsp-idle-network.save.v1", primaryCatalog],
        [`dsp-idle-network.local-save.catalog.v1.${encodeURIComponent(backupKey)}`, backupCatalog],
      ]) store.put({ key, value, updatedAt: Date.now(), bytes: new TextEncoder().encode(value).byteLength });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
  }, { primary: corruptedPrimary, backup: payloads.backup, primaryCatalog, backupCatalog, backupKey });
  await installColdReadInstrumentation(page);
  await page.reload();
  await expect(page.locator(".start-menu")).toBeVisible();
  const resolved = await page.evaluate(async () => {
    const result = await (await import("/src/game/savePreviewPayload.ts")).resolveMenuContinueSave("normal");
    return {
      source: result?.save.source ?? null,
      elapsedSeconds: result?.inspection.state?.elapsedSeconds ?? null,
      diagnostics: (window as any).__v144CatalogDiagnostics,
      rawCacheEntries: (await import("/src/game/localSaveStore.ts")).getLocalSaveRawCacheSize(),
    };
  });
  expect(resolved).toMatchObject({ source: "backup", elapsedSeconds: 9, rawCacheEntries: 0 });
  expect(resolved.diagnostics.payloadGets).toEqual([SAVE_KEY, backupKey]);
  expect(resolved.diagnostics.getAllCalls).toBe(0);
});

test("catalog-backed slots and snapshots stay visible and hydrate only the selected payload", async ({ page }) => {
  await page.goto("/?menu=1&storageMigration=production");
  await expect(page.locator(".start-menu")).toBeVisible();
  const payloads = await page.evaluate(async () => {
    const storage = await import("/src/game/storage.ts");
    const engine = await import("/src/game/engine.ts");
    const slot = engine.createInitialState();
    slot.paused = true;
    slot.elapsedSeconds = 321;
    const snapshot = engine.createInitialState();
    snapshot.paused = true;
    snapshot.elapsedSeconds = 654;
    return {
      slot: storage.serializeEnvelope(slot, Date.now(), "slot", undefined, undefined, 2),
      snapshot: storage.serializeEnvelope(snapshot, Date.now(), "snapshot", "自动快照"),
    };
  });
  const slotKey = "dsp-idle-network.slot.2";
  const snapshotKey = `${SAVE_KEY}.snapshot.500-1`;
  const records = [
    { key: slotKey, value: payloads.slot },
    { key: snapshotKey, value: payloads.snapshot },
    { key: localSaveCatalogRecordKey(slotKey), value: serializeLocalSaveCatalog(buildLocalSaveCatalog(slotKey, payloads.slot, 0)) },
    { key: localSaveCatalogRecordKey(snapshotKey), value: serializeLocalSaveCatalog(buildLocalSaveCatalog(snapshotKey, payloads.snapshot, 0)) },
  ];
  await page.evaluate(async (records) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("dsp-idle-network.local-saves");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("records", "readwrite");
      const store = transaction.objectStore("records");
      store.clear();
      for (const record of records) store.put({ ...record, updatedAt: Date.now(), bytes: new TextEncoder().encode(record.value).byteLength });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
  }, records);
  await installColdReadInstrumentation(page);
  await page.reload();
  await expect(page.locator(".start-menu")).toBeVisible();
  const result = await page.evaluate(async () => {
    const storage = await import("/src/game/storage.ts");
    const store = await import("/src/game/localSaveStore.ts");
    const before = store.getLocalSaveRawCacheSize();
    const slots = storage.getSaveSlotSummaries("normal");
    const snapshots = storage.getSaveSnapshotSummaries("normal");
    const loadedSlot = await storage.loadGameSlotFromPersistence(2, "normal");
    const loadedSnapshot = await storage.loadSaveSnapshotFromPersistence("500-1", "normal");
    return {
      before,
      after: store.getLocalSaveRawCacheSize(),
      slots,
      snapshots,
      slotElapsed: loadedSlot?.state.elapsedSeconds ?? null,
      snapshotElapsed: loadedSnapshot?.elapsedSeconds ?? null,
      diagnostics: (window as any).__v144CatalogDiagnostics,
    };
  });
  expect(result).toMatchObject({
    before: 0,
    after: 0,
    slots: [expect.objectContaining({ slotId: 2, elapsedSeconds: 321, valid: true })],
    snapshots: [expect.objectContaining({ id: "500-1", elapsedSeconds: 654, valid: true })],
    slotElapsed: 321,
    snapshotElapsed: 654,
  });
  expect(result.diagnostics.payloadGets).toEqual([slotKey, snapshotKey]);
  expect(result.diagnostics.getAllCalls).toBe(0);
});
