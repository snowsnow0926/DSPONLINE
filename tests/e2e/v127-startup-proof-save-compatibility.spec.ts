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

for (const mode of ["normal", "speedrun"] as const) {
test(`a cloned ${mode} startup primary reuses its durable payload for a due snapshot`, async ({ page }) => {
  await page.route("**/__startup_save_snapshot.html", route => route.fulfill({
    contentType: "text/html; charset=utf-8",
    body: '<!doctype html><script type="module" src="/@vite/client"></script>',
  }));
  await page.goto("/__startup_save_snapshot.html");
  const result = await page.evaluate(async mode => {
    const engine = await import("/src/game/engine.ts");
    const storage = await import("/src/game/storage.ts");
    const local = await import("/src/game/localSaveStore.ts");
    await local.initializeLocalSaveStore();
    const state = mode === "normal" ? engine.createInitialState(44_129)
      : engine.createSpeedrunInitialState(1_700_000_000_000, "snapshot_primary_reuse_001");
    state.elapsedSeconds = 1_200;
    state.entities[0].inputs.iron_ore = 941;
    const original = JSON.stringify(state);
    const requests: Array<{ kind?: string; snapshot?: boolean; omitRuntime?: boolean; sourceBytes?: number }> = [];
    const responses: Array<{ runtimeBytes: number }> = [];
    const OriginalWorker = window.Worker;
    window.Worker = class extends OriginalWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (options?.name !== "authoritative-save-serialization") return;
        const post = this.postMessage.bind(this);
        this.postMessage = ((message: any, transfer: Transferable[]) => {
          requests.push({ kind: message.kind, snapshot: !!message.snapshotSource,
            omitRuntime: message.includeSourceStateTransfer === false,
            sourceBytes: message.snapshotSource?.bytes.byteLength });
          post(message, transfer);
        }) as typeof this.postMessage;
        this.addEventListener("message", event => responses.push({ runtimeBytes: event.data.sourceStateTransfer?.byteLength ?? 0 }));
      }
    };
    const saved = await storage.saveGameVerified(state, undefined, undefined, { preferWorkerProof: true });
    const primaryKey = mode === "normal" ? "dsp-idle-network.save.v1" : "dsp-idle-network.save.v1.speedrun";
    const snapshotPrefix = mode === "normal" ? "dsp-idle-network.save.v1.snapshot." : "dsp-idle-network.save.v1.snapshot.speedrun.";
    const findSnapshot = () => local.listLocalSaveKeys().find(key =>
      key.startsWith(snapshotPrefix) && !key.endsWith(".sequence"));
    const deadline = performance.now() + 5_000;
    while (!findSnapshot() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    const key = findSnapshot();
    const primary = await local.readPersistedLocalSaveValue(primaryKey);
    const snapshot = key ? await local.readPersistedLocalSaveValue(key) : null;
    const repeated = await storage.saveGameVerified({ ...state, elapsedSeconds: state.elapsedSeconds + 1 }, undefined, undefined, { preferWorkerProof: true });
    window.Worker = OriginalWorker;
    return {
      saved: saved.success && repeated.success,
      snapshotValid: storage.inspectSave(snapshot).valid,
      exactState: !!primary && !!snapshot && JSON.stringify(JSON.parse(primary).state) === JSON.stringify(JSON.parse(snapshot).state),
      stateRetained: JSON.stringify(state) === original,
      primaryRuntimeOmitted: requests.filter(request => request.kind === "primary").length === 2 &&
        requests.filter(request => request.kind === "primary").every(request => request.omitRuntime),
      snapshotUsesPayload: requests.filter(request => request.snapshot && request.sourceBytes! > 0).length === 1,
      noRuntimeBuffers: responses.length === 3 && responses.every(response => response.runtimeBytes === 0),
    };
  }, mode);
  expect(result).toEqual({ saved: true, snapshotValid: true, exactState: true, stateRetained: true,
    primaryRuntimeOmitted: true, snapshotUsesPayload: true, noRuntimeBuffers: true });
});
}
