import { expect, test, type Page } from "@playwright/test";
import { resolveDurableSimulationRuntimeEnabled } from "../../src/game/runtimePersistenceMode";

test.skip(resolveDurableSimulationRuntimeEnabled(process.env), "targets the default startup checkpoint path");

async function install(page: Page, injectQuota = false) {
  await page.addInitScript(quotaInjection => {
    sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-10-27-v1.3.3");
    localStorage.setItem("dsp-idle-network.onboarding.v1", "dismissed");
    localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
    const probe = { active: false, begins: 0, records: 0, completes: 0, checkpoints: 0, ready: 0,
      crash: false, crashes: 0, terminations: 0, quotaWorkers: 0, hold: false, blocked: false,
      holdRecovery: false, recoveryBlocked: false, recoveryAttempts: 0, elapsed: -1,
      release: null as (() => void) | null, releaseRecovery: null as (() => void) | null };
    Object.assign(window, { __startupCheckpoint: probe });
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      private workerName: string;
      constructor(url: string | URL, options?: WorkerOptions) {
        let workerUrl = url;
        if (quotaInjection && probe.active && options?.name === "authoritative-save-persistence") {
          probe.quotaWorkers += 1;
          // The real primary write happens in this Worker, not in the page.
          workerUrl = URL.createObjectURL(new Blob([`import ${JSON.stringify(new URL(url, location.href).href)};
            const put = IDBObjectStore.prototype.put; let rejections = 2;
            IDBObjectStore.prototype.put = function(value, key) {
              if (rejections > 0 && value?.key === 'dsp-idle-network.save.v1') {
                rejections -= 1; throw new DOMException('injected startup quota failure', 'QuotaExceededError');
              }
              return key === undefined ? put.call(this, value) : put.call(this, value, key);
            };`], { type: "text/javascript" }));
        }
        super(workerUrl, options); this.workerName = options?.name ?? "";
        if (workerUrl !== url) this.addEventListener("message", () => URL.revokeObjectURL(String(workerUrl)), { once: true });
        if (this.workerName === "pure-idle-macro") this.addEventListener("message", event => {
          if (event.data.type === "ready") probe.ready += 1;
        });
        if (this.workerName === "factory-simulation") this.addEventListener("message", event => {
          const elapsed = event.data.projection?.elapsedSeconds ?? event.data.state?.elapsedSeconds ?? event.data.deferredElapsedSeconds;
          if (typeof elapsed === "number") probe.elapsed = elapsed;
        });
      }
      postMessage(message: unknown, options?: Transferable[] | StructuredSerializeOptions): void {
        const request = message as { type?: string; kind?: string };
        const send = () => Array.isArray(options) ? super.postMessage(message, options) : super.postMessage(message, options);
        if (probe.active && this.workerName === "factory-simulation" && request.kind === "checkpoint") probe.checkpoints += 1;
        if (probe.active && this.workerName === "authoritative-save-serialization") {
          if (request.type === "state-begin") probe.begins += 1;
          if (request.type === "state-complete") probe.completes += 1;
          if (request.type === "state-records") {
            probe.records += 1;
            if (probe.crash) {
              probe.crash = false; probe.crashes += 1;
              queueMicrotask(() => this.dispatchEvent(new ErrorEvent("error", { message: "injected startup chunk crash" })));
              return;
            }
            if (probe.hold) { probe.hold = false; probe.blocked = true; probe.release = send; return; }
          }
        }
        send();
      }
      terminate(): void {
        if (probe.active && this.workerName === "authoritative-save-serialization") probe.terminations += 1;
        super.terminate();
      }
    };
  }, injectQuota);
  await page.route("**/src/game/pureIdleRecovery.ts*", async route => {
    const response = await route.fetch(); const source = await response.text();
    const boundary = "async function createPureIdleRecovery(";
    if (!source.includes(boundary)) throw new Error("Startup recovery observation boundary changed");
    const body = source.replace(boundary, "async function observedCreatePureIdleRecovery(") + `
      export async function createPureIdleRecovery(...args) {
        const probe = globalThis.__startupCheckpoint;
        if (probe?.active) {
          probe.recoveryAttempts += 1;
          if (probe.holdRecovery) {
            probe.holdRecovery = false; probe.recoveryBlocked = true;
            await new Promise(resolve => { probe.releaseRecovery = resolve; });
          }
        }
        return observedCreatePureIdleRecovery(...args);
      }
    `;
    await route.fulfill({ response, body });
  });
}

async function seed(page: Page, large = true, pausedBeforeStart = true) {
  await page.route("**/__startup_seed.html", route => route.fulfill({ contentType: "text/html",
    body: '<!doctype html><html><head><script type="module" src="/@vite/client"></script></head><body>public startup fixture</body></html>' }));
  await page.goto("/__startup_seed.html");
  const seeded = await page.evaluate(async ({ big, paused }) => {
    const { createInitialState } = await import("/src/game/engine.ts");
    const local = await import("/src/game/localSaveStore.ts");
    const storage = await import("/src/game/storage.ts");
    const state = createInitialState(20_261_027, false);
    const base = { planetId: "home", position: { x: 0, y: 0 }, inputs: {}, outputs: {}, machineCount: 1,
      minerCount: 0, progress: 0, routingCursor: 0, utilization: 0, productionRate: 0, interactionLocked: false };
    state.entities.push({ ...base, id: "startup-wind", kind: "power", buildingId: "wind_turbine", machineCount: 10_000_000_000 });
    state.entities.push({ ...base, id: "startup-clock", kind: "machine", buildingId: "time_warp_device", position: { x: 300, y: 0 } });
    if (big) for (let i = 0; i < 10_000; i += 1) state.entities.push({ ...base, id: `startup-padding-${i}`,
      kind: "machine", buildingId: "assembling_machine_mk1", machineCount: 0, position: { x: 20_000 + i * 100, y: 20_000 } });
    state.belts = []; state.paused = paused; state.timeWarp.enabled = false;
    state.timeWarp.controllerEntityId = "startup-clock"; state.timeWarp.requestedMultiplier = 8;
    state.tray.iron_ingot = 123; state.planetTrays.home = { ...state.tray };
    state.planetViewports.home = { x: 100, y: 200, zoom: 0.8 };
    state.settings.autosaveIntervalSeconds = 0;
    await local.initializeLocalSaveStore();
    const saved = await storage.saveGameVerified(state, undefined, undefined, { preferWorkerProof: true });
    if (!saved.success) throw new Error(saved.message);
    const raw = await local.readPersistedLocalSaveValue("dsp-idle-network.save.v1");
    if (!raw) throw new Error("fixture primary missing");
    window.dispatchEvent(new Event("beforeunload"));
    return { raw, entityCount: state.entities.length };
  }, { big: large, paused: pausedBeforeStart });
  await page.goto("/?factory=1&storageMigration=production");
  await expect(page.locator('.game-shell[data-simulation-worker="active"]')).toBeVisible();
  await expect.poll(async () => Number((await probe(page)).elapsed), { timeout: 15_000 }).toBeGreaterThanOrEqual(0);
  await page.locator('.react-flow__node[data-id="startup-clock"]').click();
  await expect(page.getByRole("button", { name: "开始纯挂机（守恒模式）", exact: true })).toBeVisible();
  return seeded;
}

async function arm(page: Page, patch: Record<string, unknown> = {}) {
  await page.evaluate(update => Object.assign((window as unknown as { __startupCheckpoint: object }).__startupCheckpoint,
    { active: true }, update), patch);
}
async function probe(page: Page) {
  return page.evaluate(() => {
    const { release: _release, releaseRecovery: _recovery, ...value } = (window as unknown as { __startupCheckpoint: { release: unknown; [key: string]: unknown } }).__startupCheckpoint;
    return value;
  });
}
async function primary(page: Page) {
  return page.evaluate(async () => (await import("/src/game/localSaveStore.ts")).readPersistedLocalSaveValue("dsp-idle-network.save.v1"));
}
async function start(page: Page) {
  await page.getByRole("button", { name: "开始纯挂机（守恒模式）", exact: true }).click();
}

for (const paused of [true, false]) test(`large startup streams its frozen source after the ordinary checkpoint barrier, paused=${paused}`, async ({ page }) => {
  await install(page); const seeded = await seed(page, true, paused); await arm(page); await start(page);
  // Stable calibration must credit 30 simulated seconds at the actual 8x rate.
  await expect.poll(async () => (await probe(page)).ready, { timeout: 15_000 }).toBe(1);
  const observed = await probe(page);
  expect(observed.begins).toBe(1); expect(Number(observed.records)).toBeGreaterThan(1);
  expect(observed.completes).toBe(1); expect(observed.checkpoints).toBe(1);
  const raw = await primary(page); expect(raw).not.toBeNull();
  const state = JSON.parse(raw!).state;
  expect(state.entities).toHaveLength(seeded.entityCount); expect(state.tray.iron_ingot).toBe(123);
  expect(state.timeWarp.enabled).toBe(true); expect(state.settings.autosaveIntervalSeconds).toBe(0);
  const checkpoint = await page.evaluate(async () => (await import("/src/game/pureIdleRecovery.ts")).readPureIdleRecovery());
  expect(checkpoint?.state.entities).toHaveLength(seeded.entityCount);
  expect(state.idleSettlement.currentRunStartedAt).toBe(Math.floor(checkpoint!.startedAtMs));
});

for (const failure of ["crash", "quota"] as const) test(`${failure} leaves the old primary intact and permits a fresh startup`, async ({ page }) => {
  await install(page, failure === "quota"); const seeded = await seed(page); await arm(page, { [failure]: true }); await start(page);
  await expect(page.locator(".game-shell")).toHaveAttribute("data-persistence-phase", "failed");
  await expect.poll(async () => await primary(page)).toBe(seeded.raw);
  expect((await probe(page)).ready).toBe(0);
  await arm(page, { crash: false }); await start(page);
  await expect.poll(async () => (await probe(page)).ready, { timeout: 15_000 }).toBe(1);
  expect((await probe(page)).begins).toBe(2);
  expect(JSON.parse((await primary(page))!).state.tray.iron_ingot).toBe(123);
});

test("pagehide invalidates a held startup batch before it can replace the primary", async ({ page }) => {
  await install(page); const seeded = await seed(page); await arm(page, { hold: true }); await start(page);
  await expect.poll(async () => (await probe(page)).blocked).toBe(true);
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pagehide"));
    (window as unknown as { __startupCheckpoint: { release: () => void } }).__startupCheckpoint.release();
  });
  await expect.poll(async () => (await probe(page)).terminations).toBe(1);
  expect((await probe(page)).completes).toBe(0);
  // pagehide deliberately saves the accepted ordinary UI through the existing
  // emergency path. It may refresh derived fields; the cancelled active
  // startup must never replace it or change any inventory in this fixture.
  const prior = JSON.parse(seeded.raw).state;
  const retained = JSON.parse((await primary(page))!).state;
  expect(retained.timeWarp.enabled).toBe(false); expect(retained.paused).toBe(true);
  expect(retained.elapsedSeconds).toBe(prior.elapsedSeconds);
  expect(retained.tray).toEqual(prior.tray); expect(retained.planetTrays).toEqual(prior.planetTrays);
  expect(retained.quantumLogisticsNetwork.inventory).toEqual(prior.quantumLogisticsNetwork.inventory);
  const inventories = (state: typeof prior) => state.entities.map((entity: { id: string; inputs?: object; outputs?: object; resourceRemaining?: number }) =>
    ({ id: entity.id, inputs: entity.inputs ?? {}, outputs: entity.outputs ?? {}, resourceRemaining: entity.resourceRemaining }));
  expect(inventories(retained)).toEqual(inventories(prior));
  expect((await probe(page)).ready).toBe(0);
});

test("small startup keeps the existing atomic save path", async ({ page }) => {
  await install(page); const seeded = await seed(page, false); await arm(page); await start(page);
  await expect.poll(async () => (await probe(page)).ready, { timeout: 15_000 }).toBe(1);
  expect((await probe(page)).begins).toBe(0);
  expect(JSON.parse((await primary(page))!).state.entities).toHaveLength(seeded.entityCount);
});

test("startup ownership prevents experimental edit-during-save from changing the frozen run", async ({ page }) => {
  await install(page);
  await page.addInitScript(() => localStorage.setItem("dsp-idle-network.save.allow-edits-during-save.v1", "true"));
  await seed(page); await arm(page, { hold: true }); await start(page);
  await expect.poll(async () => (await probe(page)).blocked).toBe(true);
  await page.locator(".time-warp-stepper input").fill("9");
  await expect(page.locator(".time-warp-stepper input")).toHaveValue("8");
  await page.evaluate(() => (window as unknown as { __startupCheckpoint: { release: () => void } }).__startupCheckpoint.release());
  await expect.poll(async () => (await probe(page)).ready, { timeout: 15_000 }).toBe(1);
  expect(JSON.parse((await primary(page))!).state.timeWarp.requestedMultiplier).toBe(8);
});

test("a real second-tab takeover revokes a held startup before any primary replacement", async ({ page, context }) => {
  await install(page); const seeded = await seed(page); await arm(page, { hold: true }); await start(page);
  await expect.poll(async () => (await probe(page)).blocked).toBe(true);
  const contender = await context.newPage();
  try {
    await contender.goto("/icon.svg");
    expect(await contender.evaluate(async () => {
      await import("/@vite/env");
      const local = await import("/src/game/localSaveStore.ts");
      await local.initializeLocalSaveStore(); return local.takeOverLocalSaveWriter();
    })).toBe(true);
    await expect.poll(async () => page.evaluate(async () => (await import("/src/game/localSaveStore.ts")).getLocalSaveWriterStatus().role)).toBe("secondary");
    await page.evaluate(() => (window as unknown as { __startupCheckpoint: { release: () => void } }).__startupCheckpoint.release());
    await expect.poll(async () => (await probe(page)).terminations).toBe(1);
    expect((await probe(page)).completes).toBe(0); expect((await probe(page)).ready).toBe(0);
    expect(await primary(page)).toBe(seeded.raw);
  } finally { await contender.close(); }
});

test("the entire startup is single-flight and read-only before recovery creation", async ({ page }) => {
  await install(page);
  await page.addInitScript(() => localStorage.setItem("dsp-idle-network.save.allow-edits-during-save.v1", "true"));
  await seed(page); await arm(page, { holdRecovery: true }); await start(page);
  await expect.poll(async () => (await probe(page)).recoveryBlocked).toBe(true);
  await page.locator(".time-warp-stepper input").fill("9");
  await expect(page.locator(".time-warp-stepper input")).toHaveValue("8");
  await start(page);
  expect((await probe(page)).recoveryAttempts).toBe(1);
  await page.evaluate(() => (window as unknown as { __startupCheckpoint: { releaseRecovery: () => void } }).__startupCheckpoint.releaseRecovery());
  await expect.poll(async () => (await probe(page)).ready, { timeout: 15_000 }).toBe(1);
  expect((await probe(page)).begins).toBe(1);
  expect(JSON.parse((await primary(page))!).state.timeWarp.requestedMultiplier).toBe(8);
});

test("a cancelled startup does not leave a macro latch after a cached-page restore", async ({ page }) => {
  await install(page); await seed(page); await arm(page, { hold: true }); await start(page);
  await expect.poll(async () => (await probe(page)).blocked).toBe(true);
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    (window as unknown as { __startupCheckpoint: { release: () => void } }).__startupCheckpoint.release();
  });
  await expect.poll(async () => (await probe(page)).terminations).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  const before = Number((await probe(page)).elapsed);
  await page.getByRole("button", { name: "继续模拟", exact: true }).click();
  await expect(page.locator(".game-shell")).toHaveAttribute("data-simulation-paused", "false");
  await expect.poll(async () => Number((await probe(page)).elapsed), { timeout: 10_000 }).toBeGreaterThan(before);
  expect((await probe(page)).ready).toBe(0);
});
