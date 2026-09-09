import { expect, test } from "@playwright/test";

test("startup proof preference preserves the exact pre-mode migration backup before switching to Worker proofs", async ({ page }) => {
  await page.route("**/__startup_save_legacy.html", route => route.fulfill({
    contentType: "text/html; charset=utf-8",
    body: '<!doctype html><script type="module" src="/@vite/client"></script>',
  }));
  await page.goto("/__startup_save_legacy.html");
  const result = await page.evaluate(async () => {
    const engine = await import("/src/game/engine.ts");
    const storage = await import("/src/game/storage.ts");
    const local = await import("/src/game/localSaveStore.ts");
    const legacy: any = engine.createInitialState(44_128);
    delete legacy.mode;
    delete legacy.idleSettlement;
    legacy.version = 45;
    const originalRaw = JSON.stringify(legacy);
    localStorage.setItem("dsp-idle-network.save.v1", originalRaw);
    await local.initializeLocalSaveStore();
    const migrated = storage.migrateGame(legacy)!;
    const names: string[] = [];
    const OriginalWorker = window.Worker;
    window.Worker = class extends OriginalWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options); names.push(options?.name ?? "");
      }
    };
    const first = await storage.saveGameVerified(migrated, undefined, undefined, { preferWorkerProof: true });
    const firstProofWorkers = names.filter(name => name === "authoritative-save-serialization").length;
    const next = { ...migrated, elapsedSeconds: migrated.elapsedSeconds + 1 };
    const second = await storage.saveGameVerified(next, undefined, undefined, { preferWorkerProof: true });
    window.Worker = OriginalWorker;
    const raw = await local.readPersistedLocalSaveValue("dsp-idle-network.save.v1");
    return {
      first: first.success, second: second.success, firstProofWorkers,
      usedProofOnNext: names.includes("authoritative-save-serialization"),
      exactLegacyBackup: await local.readPersistedLocalSaveValue("dsp-idle-network.save.v1.migration-backup.v46") === originalRaw,
      validPrimary: storage.inspectSave(raw).valid,
      mode: storage.inspectSave(raw).mode,
    };
  });
  expect(result).toEqual({
    first: true, second: true, firstProofWorkers: 0, usedProofOnNext: true,
    exactLegacyBackup: true, validPrimary: true, mode: "normal",
  });
});

test("a cloned startup primary creates a due snapshot from the same full state", async ({ page }) => {
  await page.route("**/__startup_save_snapshot.html", route => route.fulfill({
    contentType: "text/html; charset=utf-8",
    body: '<!doctype html><script type="module" src="/@vite/client"></script>',
  }));
  await page.goto("/__startup_save_snapshot.html");
  const result = await page.evaluate(async () => {
    const engine = await import("/src/game/engine.ts");
    const storage = await import("/src/game/storage.ts");
    const local = await import("/src/game/localSaveStore.ts");
    await local.initializeLocalSaveStore();
    const state = engine.createInitialState(44_129);
    state.elapsedSeconds = 1_200;
    state.entities[0].inputs.iron_ore = 941;
    const saved = await storage.saveGameVerified(state, undefined, undefined, { preferWorkerProof: true });
    const findSnapshot = () => local.listLocalSaveKeys().find(key =>
      key.startsWith("dsp-idle-network.save.v1.snapshot.") && !key.endsWith(".sequence"));
    const deadline = performance.now() + 5_000;
    while (!findSnapshot() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    const key = findSnapshot();
    const primary = await local.readPersistedLocalSaveValue("dsp-idle-network.save.v1");
    const snapshot = key ? await local.readPersistedLocalSaveValue(key) : null;
    return {
      saved: saved.success,
      snapshotValid: storage.inspectSave(snapshot).valid,
      exactState: !!primary && !!snapshot && JSON.stringify(JSON.parse(primary).state) === JSON.stringify(JSON.parse(snapshot).state),
    };
  });
  expect(result).toEqual({ saved: true, snapshotValid: true, exactState: true });
});
