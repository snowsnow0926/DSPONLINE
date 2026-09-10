import { expect, test } from "@playwright/test";

for (const scenario of ["release", "deleted-mode", "cancel", "new-owner", "new-revision"] as const) {
  test(`graceful writer close: ${scenario}`, async ({ page }) => {
    await page.goto("/?menu=1&storageMigration=production");
    await expect(page.locator(".start-menu")).toBeVisible();
    const result = await page.evaluate(async (scenario) => {
      const store = await import("/src/game/localSaveStore.ts");
      const storage = await import("/src/game/storage.ts");
      const engine = await import("/src/game/engine.ts");
      const coordination = await import("/src/game/localSaveCoordination.ts");
      const state = engine.createInitialState(); state.paused = true; state.tray.iron_ore = 12345;
      const saved = await storage.saveGameVerified(state);
      if (!saved.success) throw new Error(saved.message);
      const leaseKey = coordination.LOCAL_SAVE_WRITER_LEASE_KEY;
      const key = "dsp-idle-network.save.v1";
      if (scenario === "deleted-mode") {
        const speedrunKey = `${key}.speedrun`;
        store.setLocalSaveValue(speedrunKey, storage.serializeEnvelope({ ...state, mode: "speedrun" }));
        await store.flushLocalSaveWrites();
        store.removeLocalSaveValue(speedrunKey);
        await store.flushLocalSaveWrites();
      }
      const revisionKey = coordination.localSaveRevisionKey(key);
      const initial = { lease: await store.readPersistedLocalSaveValue(leaseKey), raw: await store.readPersistedLocalSaveValue(key), revision: await store.readPersistedLocalSaveValue(revisionKey) };
      if (scenario === "new-owner" || scenario === "new-revision") {
        const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("dsp-idle-network.local-saves"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
        const recordKey = scenario === "new-owner" ? leaseKey : revisionKey;
        const value = scenario === "new-owner"
          ? { ...JSON.parse(initial.lease!), ownerId: "tab_controlled_new_owner", fencingToken: JSON.parse(initial.lease!).fencingToken + 1 }
          : { ...JSON.parse(initial.revision!), revision: JSON.parse(initial.revision!).revision + 1 };
        await new Promise<void>((resolve, reject) => { const tx = db.transaction("records", "readwrite"); tx.objectStore("records").put({ key: recordKey, value: JSON.stringify(value), bytes: JSON.stringify(value).length, updatedAt: Date.now() }); tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
        db.close();
      }
      const beforeLease = await store.readPersistedLocalSaveValue(leaseKey);
      const beforeRevision = await store.readPersistedLocalSaveValue(revisionKey);
      const signal = new AbortController(); if (scenario === "cancel") signal.abort();
      let ok = true;
      try { await store.closeLocalSaveWriter(signal.signal); } catch { ok = false; }
      const afterLease = await store.readPersistedLocalSaveValue(leaseKey);
      let newWriteRejected = false;
      if (scenario === "release") try { store.setLocalSaveValue(key, initial.raw!); } catch { newWriteRejected = true; }
      return { ok, leaseUnchanged: beforeLease === afterLease, primaryUnchanged: initial.raw === await store.readPersistedLocalSaveValue(key), revisionUnchanged: beforeRevision === await store.readPersistedLocalSaveValue(revisionKey), expired: JSON.parse(afterLease!).expiresAt <= Date.now(), newWriteRejected };
    }, scenario);
    expect(result.primaryUnchanged).toBe(true);
    expect(result.revisionUnchanged).toBe(true);
    const shouldRelease = scenario === "release" || scenario === "deleted-mode";
    expect(result.ok).toBe(shouldRelease);
    expect(result.leaseUnchanged).toBe(!shouldRelease);
    if (scenario === "release") { expect(result.expired).toBe(true); expect(result.newWriteRejected).toBe(true); }
  });
}
