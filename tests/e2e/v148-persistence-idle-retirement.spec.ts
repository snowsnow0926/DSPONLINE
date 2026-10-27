import { expect, test, type Page } from "@playwright/test";

async function prepare(page: Page, mode: "normal" | "speedrun" = "normal") {
  // Public fixtures exercise the same lifecycle with shorter thresholds.
  // Private production-page qualification uses the actual 16 MiB / 2 s defaults.
  await page.route("**/src/game/authoritativeSavePersistenceClient.ts*", async route => {
    const response = await route.fetch();
    const original = await response.text();
    const sizeBoundary = /const LARGE_PAYLOAD_BYTES = [^;]+;/;
    const timeBoundary = /const LARGE_PAYLOAD_IDLE_MS = [^;]+;/;
    if (!sizeBoundary.test(original) || !timeBoundary.test(original)) throw new Error("retirement test boundary changed");
    const source = original.replace(sizeBoundary, "const LARGE_PAYLOAD_BYTES = 1024;")
      .replace(timeBoundary, "const LARGE_PAYLOAD_IDLE_MS = 50;");
    await route.fulfill({ response, body: source });
  });
  await page.addInitScript(() => {
    const probe = { starts: 0, terminations: 0, hold: false, blocked: false, corruptNext: false,
      release: null as (() => void) | null, finished: null as unknown };
    (window as unknown as { __retirement: typeof probe }).__retirement = probe;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      private readonly tracked: boolean;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.tracked = options?.name === "authoritative-save-persistence";
        if (!this.tracked) return;
        probe.starts += 1;
        this.addEventListener("message", event => {
          if (!probe.hold || event.data?.type !== "result") return;
          event.stopImmediatePropagation();
          probe.blocked = true;
          probe.release = () => {
            probe.hold = false; probe.release = null;
            this.dispatchEvent(new MessageEvent("message", { data: event.data }));
          };
        });
      }
      postMessage(message: unknown, transfer: Transferable[] = []) {
        let request = message as { type?: string; proof?: object };
        if (this.tracked && request.type === "commit" && probe.corruptNext) {
          probe.corruptNext = false;
          request = { ...request, proof: { ...request.proof, payloadSha256: "0".repeat(64) } };
        }
        super.postMessage(request, transfer);
      }
      terminate() { if (this.tracked) probe.terminations += 1; super.terminate(); }
    };
  });
  await page.route("**/__retirement_test.html", route => route.fulfill({
    contentType: "text/html", body: '<!doctype html><script type="module" src="/@vite/client"></script><body>Persistence lifecycle</body>',
  }));
  await page.goto("/__retirement_test.html");
  await page.evaluate(async mode => {
    const engine = await import("/src/game/engine.ts");
    const storage = await import("/src/game/storage.ts");
    const local = await import("/src/game/localSaveStore.ts");
    await local.initializeLocalSaveStore();
    const initial = mode === "normal" ? engine.createInitialState(44_148)
      : engine.createSpeedrunInitialState(1_800_000_000_000, "public_retirement_fixture");
    initial.settings.autosaveIntervalSeconds = 0;
    const primary = mode === "normal" ? "dsp-idle-network.save.v1" : "dsp-idle-network.save.v1.speedrun";
    const backup = mode === "normal" ? "dsp-idle-network.save.v1.backup" : "dsp-idle-network.save.v1.backup.speedrun";
    const seeded = await storage.saveGameVerified(initial);
    if (!seeded.success) throw new Error("fixture primary failed");
    const snapshot = async () => {
      const raw = await local.readPersistedLocalSaveValue(primary);
      const backupRaw = await local.readPersistedLocalSaveValue(backup);
      if (!raw) throw new Error("primary missing");
      const state = JSON.parse(raw).state;
      return { raw, backupRaw, revision: local.getPrimaryLocalSaveRevision(mode),
        integrity: local.getLocalSaveCatalog(primary)?.integrity, iron: state.entities[0].inputs.iron_ore,
        autosave: state.settings.autosaveIntervalSeconds };
    };
    const api = {
      snapshot,
      save: async (step: number) => {
        const state = structuredClone(initial);
        state.elapsedSeconds = 600 + step;
        state.entities[0].inputs.iron_ore = 137 + step;
        const before = JSON.stringify(state);
        const result = await storage.saveGameVerified(state, undefined, undefined, { preferWorkerProof: true });
        const stored = await snapshot();
        return { success: result.success, exact: result.success && stored.raw === storage.serializeEnvelope(state, result.savedAt),
          callerUnchanged: before === JSON.stringify(state), ...stored };
      },
    };
    (window as unknown as { __retirementApi: typeof api }).__retirementApi = api;
  }, mode);
  await page.waitForFunction(() => {
    const p = (window as unknown as { __retirement: { starts: number; terminations: number } }).__retirement;
    return p.starts === p.terminations;
  });
}

async function save(page: Page, step: number) {
  return page.evaluate(async step => (window as unknown as { __retirementApi: { save: (step: number) => Promise<{
    success: boolean; exact: boolean; callerUnchanged: boolean; raw: string; backupRaw: string | null;
    revision: number; integrity: string; iron: number; autosave: number;
  }> } }).__retirementApi.save(step), step);
}

async function idle(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const p = (window as unknown as { __retirement: { starts: number; terminations: number } }).__retirement;
    return p.starts - p.terminations;
  })).toBe(0);
}

for (const mode of ["normal", "speedrun"] as const) {
  test(`${mode} primary and exact backup survive idle retirement and a fresh persistence generation`, async ({ page }) => {
    await prepare(page, mode);
    const first = await save(page, 1); await idle(page);
    const starts = await page.evaluate(() => (window as unknown as { __retirement: { starts: number } }).__retirement.starts);
    const second = await save(page, 2); await idle(page);
    expect(first).toMatchObject({ success: true, exact: true, callerUnchanged: true, integrity: "valid", iron: 138, autosave: 0 });
    expect(second).toMatchObject({ success: true, exact: true, callerUnchanged: true, integrity: "valid", iron: 139, autosave: 0 });
    expect(second.revision).toBe(first.revision + 1);
    expect(second.backupRaw).toBe(first.raw);
    expect(await page.evaluate(() => (window as unknown as { __retirement: { starts: number } }).__retirement.starts)).toBe(starts + 1);
  });
}

test("a delayed final ACK cannot retire its inflight generation or lose returned ownership", async ({ page }) => {
  await prepare(page);
  await page.evaluate(() => {
    const runtime = window as unknown as { __retirement: { hold: boolean; finished: unknown }; __retirementApi: { save: (n: number) => Promise<unknown> } };
    runtime.__retirement.hold = true;
    void runtime.__retirementApi.save(1).then(result => { runtime.__retirement.finished = result; });
  });
  await page.waitForFunction(() => (window as unknown as { __retirement: { blocked: boolean } }).__retirement.blocked);
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => {
    const p = (window as unknown as { __retirement: { starts: number; terminations: number; finished: unknown } }).__retirement;
    return { active: p.starts - p.terminations, finished: p.finished };
  })).toEqual({ active: 1, finished: null });
  await page.evaluate(() => (window as unknown as { __retirement: { release: () => void } }).__retirement.release());
  await page.waitForFunction(() => (window as unknown as { __retirement: { finished: unknown } }).__retirement.finished);
  await idle(page);
  const retried = await save(page, 2);
  expect(retried).toMatchObject({ success: true, exact: true, iron: 139 });
});

test("proof rejection preserves the old primary and exact retry works after retirement", async ({ page }) => {
  await prepare(page);
  const first = await save(page, 1); await idle(page);
  await page.evaluate(() => { (window as unknown as { __retirement: { corruptNext: boolean } }).__retirement.corruptNext = true; });
  const failed = await save(page, 2); await idle(page);
  expect(failed.success).toBe(false);
  expect(failed.raw).toBe(first.raw);
  expect(failed.revision).toBe(first.revision);
  const retry = await save(page, 2); await idle(page);
  expect(retry).toMatchObject({ success: true, exact: true, callerUnchanged: true, iron: 139 });
  expect(retry.revision).toBe(first.revision + 1);
  expect(retry.backupRaw).toBe(first.raw);
});
