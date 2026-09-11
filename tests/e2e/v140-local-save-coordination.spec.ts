import { expect, test, type Page } from "@playwright/test";

const SAVE_KEY = "dsp-idle-network.save.v1";
const RELEASE_NOTE_ID = "2026-08-17-v1.0.46";

async function preparePage(page: Page, disableCoordinationApis = false) {
  await page.addInitScript(({ releaseNoteId, disable }) => {
    window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", releaseNoteId);
    window.localStorage.setItem("dsp-idle-network.onboarding.v1", "dismissed");
    if (disable) {
      try { Object.defineProperty(navigator, "locks", { configurable: true, value: undefined }); } catch { /* fallback test */ }
      try { Object.defineProperty(window, "BroadcastChannel", { configurable: true, value: undefined }); } catch { /* fallback test */ }
    }
  }, { releaseNoteId: RELEASE_NOTE_ID, disable: disableCoordinationApis });
  await page.goto("/?menu=1&storageMigration=production");
  await expect(page.locator(".start-menu")).toBeVisible();
}

async function readRecord(page: Page, key: string): Promise<string | null> {
  return page.evaluate(async (recordKey) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("dsp-idle-network.local-saves");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return new Promise<string | null>((resolve, reject) => {
      const request = database.transaction("records", "readonly").objectStore("records").get(recordKey);
      request.onsuccess = () => resolve(request.result?.value ?? null);
      request.onerror = () => reject(request.error);
    });
  }, key);
}

async function writeLegacyRecord(page: Page, key: string, value: string): Promise<void> {
  await page.evaluate(async ({ recordKey, recordValue }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("dsp-idle-network.local-saves");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("records", "readwrite");
      transaction.objectStore("records").put({ key: recordKey, value: recordValue, updatedAt: Date.now(), bytes: recordValue.length });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }, { recordKey: key, recordValue: value });
}

async function seedEmergencyMirror(
  page: Page,
  metadataWriter: string | null,
): Promise<{ originalSavedAt: number; candidateSavedAt: number }> {
  return page.evaluate(async ({ writer }) => {
    const storage = await import("/src/game/storage.ts");
    const engine = await import("/src/game/engine.ts");
    const state = engine.createInitialState();
    state.elapsedSeconds = 321;
    const saved = await storage.saveGameVerified(state);
    if (!saved.success) throw new Error(saved.message);
    const store = await import("/src/game/localSaveStore.ts");
    const raw = store.getLocalSaveValue("dsp-idle-network.save.v1");
    if (!raw) throw new Error("missing seeded primary save");
    const candidate = JSON.parse(raw);
    candidate.savedAt += 1_000;
    const candidateRaw = JSON.stringify(candidate);
    localStorage.setItem("dsp-idle-network.local-save-coordination.v1.emergency-mirror.normal.payload", candidateRaw);
    if (writer !== null) {
      localStorage.setItem("dsp-idle-network.local-save-coordination.v1.emergency-mirror.normal.metadata", JSON.stringify({
        schemaVersion: 1,
        mode: "normal",
        saveKey: "dsp-idle-network.save.v1",
        writerId: writer,
        fencingToken: 1,
        candidateRevision: 999,
        savedAt: candidate.savedAt,
        checksum: candidate.checksum,
        createdAt: Date.now(),
      }));
    }
    return { originalSavedAt: JSON.parse(raw).savedAt, candidateSavedAt: candidate.savedAt };
  }, { writer: metadataWriter });
}

async function seedMissingPrimaryConflict(page: Page, activeLeaseMs = 30_000): Promise<{
  conflictId: string;
  candidateRaw: string;
  candidateKey: string;
}> {
  return page.evaluate(async ({ saveKey, leaseMs }) => {
    const storage = await import("/src/game/storage.ts");
    const engine = await import("/src/game/engine.ts");
    const store = await import("/src/game/localSaveStore.ts");
    const coordination = await import("/src/game/localSaveCoordination.ts");
    const state = engine.createInitialState();
    state.elapsedSeconds = 918;
    const candidateRaw = storage.serializeEnvelope(state, Date.now());
    const writer = store.getLocalSaveWriterStatus();
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("dsp-idle-network.local-saves");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("records", "readwrite");
      const value = JSON.stringify({
        schemaVersion: 1,
        ownerId: "tab_external_active_writer",
        fencingToken: writer.fencingToken + 1,
        acquiredAt: Date.now(),
        heartbeatAt: Date.now(),
        expiresAt: Date.now() + leaseMs,
      });
      transaction.objectStore("records").put({
        key: coordination.LOCAL_SAVE_WRITER_LEASE_KEY,
        value,
        updatedAt: Date.now(),
        bytes: value.length,
      });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    store.setLocalSaveValue(saveKey, candidateRaw);
    try { await store.flushLocalSaveWrites(); } catch { /* expected conflict */ }
    const conflict = (await store.getLocalSaveConflicts())[0];
    if (!conflict) throw new Error("missing generated conflict");
    return {
      conflictId: conflict.conflictId,
      candidateRaw,
      candidateKey: `${saveKey}.conflict.${conflict.conflictId}.candidate`,
    };
  }, { saveKey: SAVE_KEY, leaseMs: activeLeaseMs });
}

async function expireDurableWriterLease(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const coordination = await import("/src/game/localSaveCoordination.ts");
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("dsp-idle-network.local-saves");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("records", "readwrite");
      const objectStore = transaction.objectStore("records");
      const request = objectStore.get(coordination.LOCAL_SAVE_WRITER_LEASE_KEY);
      request.onsuccess = () => {
        const lease = JSON.parse(request.result.value);
        const value = JSON.stringify({ ...lease, heartbeatAt: Date.now() - 20_000, expiresAt: Date.now() - 1 });
        objectStore.put({ ...request.result, value, updatedAt: Date.now(), bytes: value.length });
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  });
}

test("upgrades an existing IndexedDB v1 in place without changing save bytes", async ({ page }) => {
  const original = JSON.stringify({ savedAt: 1_777_777_777_000, state: { version: 1 }, checksum: "legacy-bytes" });
  await page.goto("about:blank");
  await page.goto("/?storageMigration=production", { waitUntil: "commit" });
  await page.evaluate(async ({ key, value }) => {
    await new Promise<void>((resolve, reject) => {
      const remove = indexedDB.deleteDatabase("dsp-idle-network.local-saves");
      remove.onsuccess = () => resolve();
      remove.onerror = () => reject(remove.error);
    });
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("dsp-idle-network.local-saves", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("records", { keyPath: "key" });
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction("records", "readwrite");
        transaction.objectStore("records").put({ key, value, updatedAt: 1, bytes: value.length });
        transaction.oncomplete = () => { database.close(); resolve(); };
        transaction.onerror = () => reject(transaction.error);
      };
      request.onerror = () => reject(request.error);
    });
  }, { key: SAVE_KEY, value: original });
  await page.reload();
  await expect(page.locator(".start-menu")).toBeVisible();
  expect(await readRecord(page, SAVE_KEY)).toBe(original);
  const version = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("dsp-idle-network.local-saves");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return database.version;
  });
  expect(version).toBe(2);
});

test("a future IndexedDB upgrade closes the old connection and blocks memory-only writes", async ({ page }) => {
  await preparePage(page);
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("dsp-idle-network.local-saves", 3);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
  });
  await expect(page.getByRole("alert").filter({ hasText: "本地存档连接已更新" })).toBeVisible();
  const result = await page.evaluate(async () => {
    const storage = await import("/src/game/storage.ts");
    const engine = await import("/src/game/engine.ts");
    return storage.saveGame(engine.createInitialState());
  });
  expect(result).toMatchObject({ success: false, code: "read-only" });
});

test("a second tab is read-only when Web Locks and BroadcastChannel are unavailable", async ({ context }) => {
  const primary = await context.newPage();
  const secondary = await context.newPage();
  await preparePage(primary, true);
  await preparePage(secondary, true);

  await expect(secondary.getByRole("alert").filter({ hasText: "本页面为只读" })).toBeVisible();
  const result = await secondary.evaluate(async () => {
    const storage = await import("/src/game/storage.ts");
    const engine = await import("/src/game/engine.ts");
    return storage.saveGameVerified(engine.createInitialState());
  });
  expect(result).toMatchObject({ success: false, code: "read-only" });
  expect(await readRecord(primary, SAVE_KEY)).toBeNull();
});

test("BroadcastChannel refreshes a secondary tab after the primary commits", async ({ context }) => {
  const primary = await context.newPage();
  const secondary = await context.newPage();
  await preparePage(primary);
  await preparePage(secondary);
  await expect(secondary.getByRole("alert").filter({ hasText: "本页面为只读" })).toBeVisible();
  const saved = await primary.evaluate(async () => {
    const storage = await import("/src/game/storage.ts");
    const engine = await import("/src/game/engine.ts");
    const state = engine.createInitialState();
    state.elapsedSeconds = 444;
    return storage.saveGameVerified(state);
  });
  expect(saved.success).toBe(true);
  await expect.poll(() => secondary.evaluate(async () => {
    const store = await import("/src/game/localSaveStore.ts");
    return {
      elapsedSeconds: store.getLocalSaveCatalog("dsp-idle-network.save.v1")?.elapsedSeconds ?? null,
      rawCacheEntries: store.getLocalSaveRawCacheSize(),
    };
  })).toEqual({ elapsedSeconds: 444, rawCacheEntries: 0 });
});

test("same-tab navigation keeps its writer chain while an opened copy becomes secondary", async ({ page, context }) => {
  await preparePage(page);
  const originalWriter = await page.evaluate(async () => {
    const storage = await import("/src/game/storage.ts");
    const engine = await import("/src/game/engine.ts");
    const store = await import("/src/game/localSaveStore.ts");
    const state = engine.createInitialState();
    state.elapsedSeconds = 550;
    const saved = await storage.saveGameVerified(state);
    if (!saved.success) throw new Error(saved.message);
    return store.getLocalSaveWriterStatus().writerId;
  });

  await page.goto("/?menu=1&storageMigration=production&sameTabNavigation=1");
  await expect(page.locator(".start-menu")).toBeVisible();
  const continued = await page.evaluate(async () => {
    const storage = await import("/src/game/storage.ts");
    const store = await import("/src/game/localSaveStore.ts");
    const state = storage.loadGame().state;
    state.elapsedSeconds = 551;
    const saved = await storage.saveGameVerified(state);
    return { saved, status: store.getLocalSaveWriterStatus() };
  });
  expect(continued).toMatchObject({ saved: { success: true }, status: { role: "primary", writerId: originalWriter } });

  const opened = context.waitForEvent("page");
  await page.evaluate(() => { window.open(window.location.href, "_blank"); });
  const copy = await opened;
  await copy.waitForLoadState("domcontentloaded");
  await expect(copy.locator(".start-menu")).toBeVisible();
  const copyStatus = await copy.evaluate(async () => (await import("/src/game/localSaveStore.ts")).getLocalSaveWriterStatus());
  expect(copyStatus.writerId).not.toBe(originalWriter);
  expect(copyStatus.role).toBe("secondary");
  await expect(copy.getByRole("alert").filter({ hasText: "本页面为只读" })).toBeVisible();
  await copy.close();
});

test("a stale tab cannot overwrite a coordinated save and both versions are preserved", async ({ page }) => {
  await preparePage(page);
  const first = await page.evaluate(async () => {
    const storage = await import("/src/game/storage.ts");
    const engine = await import("/src/game/engine.ts");
    const state = engine.createInitialState();
    state.elapsedSeconds = 200;
    return storage.saveGameVerified(state);
  });
  expect(first.success).toBe(true);
  const coordinated = await readRecord(page, SAVE_KEY);
  expect(coordinated).not.toBeNull();

  const legacy = JSON.stringify({ savedAt: 100, state: { elapsedSeconds: 100 }, checksum: "legacy" });
  await writeLegacyRecord(page, SAVE_KEY, legacy);
  const result = await page.evaluate(async () => {
    const storage = await import("/src/game/storage.ts");
    const engine = await import("/src/game/engine.ts");
    const state = engine.createInitialState();
    state.elapsedSeconds = 300;
    return storage.saveGameVerified(state);
  });
  expect(result).toMatchObject({ success: false, code: "conflict" });
  expect(await readRecord(page, SAVE_KEY)).toBe(legacy);
  const conflicts = await page.evaluate(async () => (await import("/src/game/localSaveStore.ts")).getLocalSaveConflicts());
  expect(conflicts).toHaveLength(1);
  expect(conflicts[0]).toMatchObject({
    saveKey: SAVE_KEY,
    candidate: { available: true },
    persisted: { available: true, checksum: "legacy" },
  });
  const conflictKeys = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("dsp-idle-network.local-saves");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return new Promise<string[]>((resolve, reject) => {
      const request = database.transaction("records", "readonly").objectStore("records").getAllKeys();
      request.onsuccess = () => resolve(request.result.map(String).filter((key) => key.includes(".conflict.")));
      request.onerror = () => reject(request.error);
    });
  });
  expect(conflictKeys.some((key) => key.endsWith(".candidate"))).toBe(true);
  expect(conflictKeys.some((key) => key.endsWith(".persisted"))).toBe(true);
});

test("an integrity-valid emergency mirror from another writer remains an explicit conflict", async ({ page }) => {
  await preparePage(page);
  const seeded = await seedEmergencyMirror(page, "tab_untrusted_external_writer");

  await page.reload();
  await expect(page.getByRole("alert").filter({ hasText: "已阻止跨标签页覆盖" })).toBeVisible();
  const conflicts = await page.evaluate(async () => (await import("/src/game/localSaveStore.ts")).getLocalSaveConflicts());
  expect(conflicts).toEqual(expect.arrayContaining([
    expect.objectContaining({
      candidate: expect.objectContaining({ available: true, savedAt: seeded.candidateSavedAt }),
      persisted: expect.objectContaining({ available: true, savedAt: seeded.originalSavedAt }),
    }),
  ]));
});

test("a crash between emergency payload and metadata writes preserves both versions", async ({ page }) => {
  await preparePage(page);
  const seeded = await seedEmergencyMirror(page, null);

  await page.reload();
  await expect(page.getByRole("alert").filter({ hasText: "已阻止跨标签页覆盖" })).toBeVisible();
  const conflicts = await page.evaluate(async () => (await import("/src/game/localSaveStore.ts")).getLocalSaveConflicts());
  expect(conflicts).toEqual(expect.arrayContaining([
    expect.objectContaining({
      candidate: expect.objectContaining({ available: true, savedAt: seeded.candidateSavedAt }),
      persisted: expect.objectContaining({ available: true, savedAt: seeded.originalSavedAt }),
    }),
  ]));
});

test("a reload applies a verified emergency mirror only from its own durable writer chain", async ({ page }) => {
  await preparePage(page);
  const expected = await page.evaluate(async () => {
    const storage = await import("/src/game/storage.ts");
    const engine = await import("/src/game/engine.ts");
    const store = await import("/src/game/localSaveStore.ts");
    const state = engine.createInitialState();
    state.elapsedSeconds = 700;
    const first = await storage.saveGameVerified(state);
    if (!first.success) throw new Error(first.message);
    const persisted = store.getLocalSaveValue("dsp-idle-network.save.v1");
    if (!persisted) throw new Error("missing durable base save");
    state.elapsedSeconds = 701;
    const candidate = storage.serializeEnvelope(state, JSON.parse(persisted).savedAt + 1_000);
    const identity = JSON.parse(candidate);
    const status = store.getLocalSaveWriterStatus();
    localStorage.setItem("dsp-idle-network.local-save-coordination.v1.emergency-mirror.normal.payload", candidate);
    localStorage.setItem("dsp-idle-network.local-save-coordination.v1.emergency-mirror.normal.metadata", JSON.stringify({
      schemaVersion: 1,
      mode: "normal",
      saveKey: "dsp-idle-network.save.v1",
      writerId: status.writerId,
      fencingToken: status.fencingToken,
      candidateRevision: 2,
      savedAt: identity.savedAt,
      checksum: identity.checksum,
      createdAt: Date.now(),
    }));
    return candidate;
  });

  await page.reload();
  await expect(page.locator(".local-save-writer-banner--conflict")).toHaveCount(0);
  expect(await readRecord(page, SAVE_KEY)).toBe(expected);
  expect(await page.evaluate(() => localStorage.getItem("dsp-idle-network.local-save-coordination.v1.emergency-mirror.normal.payload"))).toBeNull();
});

test("normal and speedrun slots keep independent coordinated revisions and tombstones", async ({ page }) => {
  await preparePage(page);
  const result = await page.evaluate(async () => {
    const storage = await import("/src/game/storage.ts");
    const engine = await import("/src/game/engine.ts");
    const normal = engine.createInitialState();
    normal.elapsedSeconds = 111;
    const speedrun = engine.createSpeedrunInitialState(1_700_000_000_000, "v140-coordination-speedrun");
    speedrun.elapsedSeconds = 222;
    const normalSave = await storage.saveGameSlotVerified(1, normal);
    const speedrunSave = await storage.saveGameSlotVerified(1, speedrun);
    const normalDelete = await storage.clearGameSlotVerified(1, "normal");
    return {
      normalSave,
      speedrunSave,
      normalDelete,
      normal: storage.loadGameSlot(1, "normal")?.state.elapsedSeconds ?? null,
      speedrun: storage.loadGameSlot(1, "speedrun")?.state.elapsedSeconds ?? null,
    };
  });
  expect(result).toMatchObject({
    normalSave: { success: true },
    speedrunSave: { success: true },
    normalDelete: true,
    normal: null,
    speedrun: 222,
  });
  const revisions = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("dsp-idle-network.local-saves");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return new Promise<Array<{ saveKey: string; revision: number; deleted: boolean }>>((resolve, reject) => {
      const request = database.transaction("records", "readonly").objectStore("records").getAll();
      request.onsuccess = () => resolve(request.result
        .filter((record) => String(record.key).includes(".revision."))
        .map((record) => JSON.parse(record.value)));
      request.onerror = () => reject(request.error);
    });
  });
  expect(revisions).toEqual(expect.arrayContaining([
    expect.objectContaining({ saveKey: "dsp-idle-network.slot.1", revision: 2, deleted: true }),
    expect.objectContaining({ saveKey: "dsp-idle-network.slot.speedrun.1", revision: 1, deleted: false }),
  ]));
});

test("a conflict can keep the persisted version without rewriting its payload", async ({ page }) => {
  await preparePage(page);
  await page.evaluate(async () => {
    const storage = await import("/src/game/storage.ts");
    const engine = await import("/src/game/engine.ts");
    const state = engine.createInitialState();
    state.elapsedSeconds = 50;
    await storage.saveGameVerified(state);
  });
  const legacy = JSON.stringify({ savedAt: 75, state: { elapsedSeconds: 75 }, checksum: "persisted_75" });
  await writeLegacyRecord(page, SAVE_KEY, legacy);
  await page.evaluate(async () => {
    const storage = await import("/src/game/storage.ts");
    const engine = await import("/src/game/engine.ts");
    const state = engine.createInitialState();
    state.elapsedSeconds = 100;
    await storage.saveGameVerified(state);
  });
  const conflictId = await page.evaluate(async () => (await (await import("/src/game/localSaveStore.ts")).getLocalSaveConflicts())[0].conflictId);
  const resolved = await page.evaluate(async (id) => (await import("/src/game/localSaveStore.ts")).resolveLocalSaveConflict(id, "persisted"), conflictId);
  expect(resolved).toBe(true);
  expect(await readRecord(page, SAVE_KEY)).toBe(legacy);
  expect(await page.evaluate(async () => (await (await import("/src/game/localSaveStore.ts")).getLocalSaveConflicts()).length)).toBe(0);
});

test("a conflict can atomically apply the candidate only while the persisted base is unchanged", async ({ page }) => {
  await preparePage(page);
  await page.evaluate(async () => {
    const storage = await import("/src/game/storage.ts");
    const engine = await import("/src/game/engine.ts");
    const state = engine.createInitialState();
    state.elapsedSeconds = 10;
    await storage.saveGameVerified(state);
  });
  const external = JSON.stringify({ savedAt: 20, state: { elapsedSeconds: 20 }, checksum: "persisted_20" });
  await writeLegacyRecord(page, SAVE_KEY, external);
  const conflictResult = await page.evaluate(async () => {
    const storage = await import("/src/game/storage.ts");
    const engine = await import("/src/game/engine.ts");
    const state = engine.createInitialState();
    state.elapsedSeconds = 30;
    return storage.saveGameVerified(state);
  });
  expect(conflictResult).toMatchObject({ success: false, code: "conflict" });
  const conflict = await page.evaluate(async () => (await (await import("/src/game/localSaveStore.ts")).getLocalSaveConflicts())[0]);
  const applied = await page.evaluate(async (id) => (await import("/src/game/localSaveStore.ts")).resolveLocalSaveConflict(id, "candidate"), conflict.conflictId);
  expect(applied).toBe(true);
  const selected = await readRecord(page, SAVE_KEY);
  expect(selected).not.toBe(external);
  expect(JSON.parse(selected!).state.elapsedSeconds).toBe(30);
  expect(await page.evaluate(async () => (await (await import("/src/game/localSaveStore.ts")).getLocalSaveConflicts()).length)).toBe(0);
});

test("a corrupted conflict candidate is preserved but cannot become the primary save", async ({ page }) => {
  await preparePage(page);
  const persisted = await page.evaluate(async () => {
    const storage = await import("/src/game/storage.ts");
    const engine = await import("/src/game/engine.ts");
    const state = engine.createInitialState();
    state.elapsedSeconds = 10;
    const result = await storage.saveGameVerified(state);
    if (!result.success) throw new Error(result.message);
    return (await import("/src/game/localSaveStore.ts")).getLocalSaveValue("dsp-idle-network.save.v1");
  });
  const external = JSON.stringify({ formatVersion: 2, savedAt: 20, mode: "normal", state: { version: 46, mode: "normal", entities: [] }, checksum: "invalid" });
  await writeLegacyRecord(page, SAVE_KEY, external);
  await page.evaluate(async () => {
    const storage = await import("/src/game/storage.ts");
    const engine = await import("/src/game/engine.ts");
    const state = engine.createInitialState();
    state.elapsedSeconds = 30;
    await storage.saveGameVerified(state);
  });
  const conflict = await page.evaluate(async () => (await (await import("/src/game/localSaveStore.ts")).getLocalSaveConflicts())[0]);
  const candidateKey = `dsp-idle-network.save.v1.conflict.${conflict.conflictId}.candidate`;
  const candidate = JSON.parse((await readRecord(page, candidateKey))!);
  candidate.checksum = "tampered";
  await writeLegacyRecord(page, candidateKey, JSON.stringify(candidate));

  const applied = await page.evaluate(async (id) => (await import("/src/game/localSaveStore.ts")).resolveLocalSaveConflict(id, "candidate"), conflict.conflictId);
  expect(applied).toBe(false);
  expect(await readRecord(page, SAVE_KEY)).toBe(external);
  expect(await readRecord(page, candidateKey)).not.toBeNull();
  expect(await page.evaluate(async () => (await (await import("/src/game/localSaveStore.ts")).getLocalSaveConflicts()).length)).toBe(1);
  expect(persisted).not.toBeNull();
});

test("an expired secondary lease requires explicit takeover and reload", async ({ context }) => {
  const primary = await context.newPage();
  const secondary = await context.newPage();
  await preparePage(primary, true);
  await preparePage(secondary, true);
  await expect(secondary.getByRole("alert").filter({ hasText: "本页面为只读" })).toBeVisible();

  await primary.close();
  await secondary.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("dsp-idle-network.local-saves");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("records", "readwrite");
      const store = transaction.objectStore("records");
      const request = store.get("dsp-idle-network.local-save-coordination.v1.writer-lease");
      request.onsuccess = () => {
        const lease = JSON.parse(request.result.value);
        const value = JSON.stringify({ ...lease, heartbeatAt: Date.now() - 20_000, expiresAt: Date.now() - 1 });
        store.put({ ...request.result, value, updatedAt: Date.now(), bytes: value.length });
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  });
  await secondary.getByRole("button", { name: "接管保存" }).click();
  await expect(secondary.locator(".start-menu")).toBeVisible();
  await expect(secondary.getByRole("alert").filter({ hasText: "本页面为只读" })).toHaveCount(0);
});

test("a single writer can commit a runtime-generated 35 MiB save after its own lease expires", async ({ page }) => {
  test.setTimeout(180_000);
  await preparePage(page);
  const result = await page.evaluate(async ({ saveKey }) => {
    const engine = await import("/src/game/engine.ts");
    const storage = await import("/src/game/storage.ts");
    const store = await import("/src/game/localSaveStore.ts");
    const coordination = await import("/src/game/localSaveCoordination.ts");
    let state = engine.createInitialState();
    state.construction.storage_mk1 = 1;
    state = engine.placeBuilding(state, "storage_mk1", { x: 0, y: 0 });
    const template = state.entities.at(-1)!;
    const entities = state.entities.slice(0, -1);
    for (let index = 0; index < 220_000; index += 1) {
      entities.push({
        ...template,
        id: `synthetic_large_storage_${index}`,
        position: { x: index % 1_000, y: Math.floor(index / 1_000) },
      });
    }
    state.entities = entities;
    state.elapsedSeconds = 35 * 60;
    const raw = storage.serializeEnvelope(state, Date.now());
    const bytes = new TextEncoder().encode(raw).byteLength;
    if (bytes <= 35 * 1024 * 1024) throw new Error(`synthetic fixture is only ${bytes} bytes`);

    const status = store.getLocalSaveWriterStatus();
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("dsp-idle-network.local-saves");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("records", "readwrite");
      const objectStore = transaction.objectStore("records");
      const request = objectStore.get(coordination.LOCAL_SAVE_WRITER_LEASE_KEY);
      request.onsuccess = () => {
        const lease = JSON.parse(request.result.value);
        if (lease.ownerId !== status.writerId || lease.fencingToken !== status.fencingToken) {
          throw new Error("test page no longer owns the durable lease");
        }
        const value = JSON.stringify({ ...lease, heartbeatAt: Date.now() - 20_000, expiresAt: Date.now() - 1 });
        objectStore.put({ ...request.result, value, updatedAt: Date.now(), bytes: value.length });
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });

    store.setLocalSaveValue(saveKey, raw);
    await store.flushLocalSaveWrites();
    const persisted = await store.readPersistedLocalSaveValue(saveKey);
    const integrity = persisted ? (await import("/src/game/saveEnvelopeIntegrity.ts")).inspectSaveEnvelopeChecksum(persisted) : null;
    return {
      bytes,
      exactReadBack: persisted === raw,
      checksum: integrity?.status,
      conflicts: (await store.getLocalSaveConflicts()).length,
      writer: store.getLocalSaveWriterStatus(),
    };
  }, { saveKey: SAVE_KEY });
  expect(result.bytes).toBeGreaterThan(35 * 1024 * 1024);
  expect(result).toMatchObject({
    exactReadBack: true,
    checksum: "valid",
    conflicts: 0,
    writer: { role: "primary" },
  });
});

test("missing-primary conflict actions expose active-writer failures, retry, and verified candidate recovery", async ({ page }) => {
  await preparePage(page);
  const seeded = await seedMissingPrimaryConflict(page);
  const banner = page.getByRole("alert").filter({ hasText: "已阻止跨标签页覆盖" });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("空（保留后没有主存档）");
  await expect(banner).toContainText("推荐：采用有效候选存档");

  const keepEmpty = banner.getByRole("button", { name: "保留空的当前状态" });
  await keepEmpty.click();
  await expect(banner.getByRole("status")).toContainText("另一个页面仍持有本地存档写入权");
  expect(await readRecord(page, seeded.candidateKey)).toBe(seeded.candidateRaw);

  const useCandidate = banner.getByRole("button", { name: "采用本页候选" });
  await useCandidate.click();
  await expect(banner.getByRole("status")).toContainText("另一个页面仍持有本地存档写入权");
  expect(await readRecord(page, seeded.candidateKey)).toBe(seeded.candidateRaw);

  await expireDurableWriterLease(page);
  await useCandidate.click();
  await expect(banner.getByRole("button", { name: "处理中…" })).toBeDisabled();
  await expect(banner.getByRole("status")).toContainText("逐字读回验证");
  await page.waitForLoadState("domcontentloaded");
  await expect(page.locator(".start-menu")).toBeVisible();
  expect(await readRecord(page, SAVE_KEY)).toBe(seeded.candidateRaw);
  expect(await readRecord(page, seeded.candidateKey)).toBeNull();
  expect(await page.evaluate(async () => (await (await import("/src/game/localSaveStore.ts")).getLocalSaveConflicts()).length)).toBe(0);
});

test("candidate recovery can retry after the selected bytes were committed but cleanup lost its lease", async ({ page }) => {
  await preparePage(page);
  const seeded = await seedMissingPrimaryConflict(page);
  const staged = await page.evaluate(async ({ saveKey, conflictId, candidateRaw }) => {
    const coordination = await import("/src/game/localSaveCoordination.ts");
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("dsp-idle-network.local-saves");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const identity = JSON.parse(candidateRaw) as { savedAt: number; checksum: string };
    const now = Date.now();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("records", "readwrite");
      const store = transaction.objectStore("records");
      const priorWriterId = "tab_previous_cleanup_attempt";
      const priorFencingToken = 41;
      const revision = coordination.createLocalSaveRevision({
        saveKey,
        previousRevision: 1,
        value: candidateRaw,
        writerId: priorWriterId,
        fencingToken: priorFencingToken,
        now,
      });
      const lease = {
        schemaVersion: 1,
        ownerId: priorWriterId,
        fencingToken: priorFencingToken,
        acquiredAt: now - 20_000,
        heartbeatAt: now - 20_000,
        expiresAt: now - 1,
      };
      const put = (key: string, value: string) => store.put({ key, value, updatedAt: now, bytes: value.length });
      put(saveKey, candidateRaw);
      put(coordination.localSaveRevisionKey(saveKey), JSON.stringify(revision));
      put(coordination.LOCAL_SAVE_WRITER_LEASE_KEY, JSON.stringify(lease));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    return {
      identity,
      conflictStillPresent: Boolean(await new Promise((resolve, reject) => {
        const request = database.transaction("records", "readonly").objectStore("records")
          .get(coordination.localSaveConflictMetadataKey(conflictId));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      })),
    };
  }, { saveKey: SAVE_KEY, conflictId: seeded.conflictId, candidateRaw: seeded.candidateRaw });
  expect(staged.conflictStillPresent).toBe(true);

  const result = await page.evaluate(async ({ conflictId }) => {
    const store = await import("/src/game/localSaveStore.ts");
    return store.resolveLocalSaveConflictDetailed(conflictId, "candidate");
  }, { conflictId: seeded.conflictId });

  expect(result).toMatchObject({
    ok: true,
    resolution: "candidate",
    savedAt: staged.identity.savedAt,
    checksum: staged.identity.checksum,
  });
  expect(await readRecord(page, SAVE_KEY)).toBe(seeded.candidateRaw);
  expect(await readRecord(page, seeded.candidateKey)).toBeNull();
  expect(await page.evaluate(async () => (await (await import("/src/game/localSaveStore.ts")).getLocalSaveConflicts()).length)).toBe(0);
});

test("missing-primary conflict can intentionally keep the clearly labelled empty current state", async ({ page }) => {
  await preparePage(page);
  const seeded = await seedMissingPrimaryConflict(page);
  await expireDurableWriterLease(page);
  const banner = page.getByRole("alert").filter({ hasText: "已阻止跨标签页覆盖" });
  await expect(banner).toContainText("保留后没有主存档");
  await banner.getByRole("button", { name: "保留空的当前状态" }).click();
  await expect(banner.getByRole("status")).toContainText("当前状态已验证");
  await page.waitForLoadState("domcontentloaded");
  await expect(page.locator(".start-menu")).toBeVisible();
  expect(await readRecord(page, SAVE_KEY)).toBeNull();
  expect(await readRecord(page, seeded.candidateKey)).toBeNull();
  expect(await page.evaluate(async () => (await (await import("/src/game/localSaveStore.ts")).getLocalSaveConflicts()).length)).toBe(0);
});

