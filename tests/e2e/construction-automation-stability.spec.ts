import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { computeSaveStateChecksum } from "../../src/game/saveEnvelopeIntegrity";

test("guarded construction automation keeps realtime Worker responses bounded without diagnostics", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const benchmark = await import("/src/game/benchmark.ts");
    const content = await import("/src/game/content.ts");
    const packs = await import("/src/game/contentPacks.ts");
    const engine = await import("/src/game/engine.ts");
    const snapshot = packs.createContentPackRuntimeSnapshot(packs.createContentPackRegistry());
    let state = engine.createInitialState(20_260_805, false);
    state.research.completedTechIds = Object.keys(content.TECHNOLOGIES) as typeof state.research.completedTechIds;
    state.construction.wind_turbine = 100_000_000;
    state.construction.construction_center = 1;
    state.construction.arc_smelter = 1;
    state = engine.placeBuilding(state, "wind_turbine", { x: -240, y: 0 }, 100_000_000);
    state = engine.placeBuilding(state, "construction_center", { x: 0, y: 0 });
    state = engine.placeBuilding(state, "arc_smelter", { x: 240, y: 0 });
    state.entities.find((entity) => entity.buildingId === "construction_center")!.machineCount = 44_311;
    const smelter = state.entities.find((entity) => entity.buildingId === "arc_smelter")!;
    smelter.recipeId = "iron_ingot";
    smelter.inputs.iron_ore = 100;
    state.tray = {};
    state.planetTrays.home = state.tray;
    state = engine.setConstructionAutomationTarget(state, "wind_turbine", 100_000_000);

    const worker = new Worker(new URL("/src/game/simulation.worker.ts", location.origin), { type: "module" });
    const request = (payload: Record<string, unknown>) => new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = payload.id as number;
      const timeout = window.setTimeout(() => reject(new Error(`Worker request ${id} timed out`)), 10_000);
      const listener = (event: MessageEvent<Record<string, unknown>>) => {
        if (event.data.id !== id) return;
        worker.removeEventListener("message", listener);
        window.clearTimeout(timeout);
        resolve(event.data);
      };
      worker.addEventListener("message", listener);
      worker.postMessage(payload);
    });
    const first = await request({
      id: 1,
      state,
      simulationSeconds: 1,
      wallSeconds: 1,
      registryFingerprint: snapshot.fingerprint,
      registry: snapshot,
    });
    const second = await request({
      id: 2,
      simulationSeconds: 1,
      wallSeconds: 1,
      registryFingerprint: snapshot.fingerprint,
    });
    const third = await request({
      id: 3,
      simulationSeconds: 1,
      wallSeconds: 1,
      profile: true,
      registryFingerprint: snapshot.fingerprint,
    });
    worker.terminate();

    const mainRuntime = engine.createPersistentSimulationRuntime(structuredClone(state));
    for (let secondIndex = 0; secondIndex < 3; secondIndex += 1) {
      engine.advancePersistentSimulationRuntime(mainRuntime, 1, 1);
    }
    const workerState = third.state as typeof state;
    const profiler = third.profiler as ReturnType<typeof engine.createSimulationProfiler>;
    return {
      durations: [first.durationMs, second.durationMs, third.durationMs],
      profilerReturnedWithoutOptIn: Boolean(first.profiler || second.profiler),
      thirdPlanBuilds: profiler.constructionPlanBuilds,
      thirdPlanCacheHits: profiler.constructionPlanCacheHits,
      thirdGuardHits: profiler.constructionGuardHits,
      workerHash: benchmark.hashGameState(workerState),
      mainHash: benchmark.hashGameState(mainRuntime.state),
      elapsedDelta: workerState.elapsedSeconds - state.elapsedSeconds,
      smelterOutput: workerState.entities.find((entity) => entity.id === smelter.id)?.outputs.iron_ingot ?? 0,
      centerStack: workerState.entities.find((entity) => entity.buildingId === "construction_center")?.machineCount ?? 0,
    };
  });

  expect(result.durations).toHaveLength(3);
  expect(result.durations.every((duration) => typeof duration === "number" && Number.isFinite(duration) && duration >= 0)).toBe(true);
  expect(Math.max(...result.durations as number[])).toBeLessThan(2_000);
  expect(result.profilerReturnedWithoutOptIn).toBe(false);
  expect(result.thirdPlanBuilds).toBe(0);
  expect(result.thirdPlanCacheHits).toBeGreaterThan(0);
  expect(result.thirdGuardHits).toBe(0);
  expect(result.workerHash).toBe(result.mainHash);
  expect(result.elapsedDelta).toBeCloseTo(3, 6);
  expect(result.smelterOutput).toBeGreaterThan(0);
  expect(result.centerStack).toBe(44_311);
});

const realFixturePath = process.env.DSP_CONSTRUCTION_STABILITY_SAVE;

test("real construction-center save keeps committing sixty one-second Worker slices", async ({ page }) => {
  test.skip(!realFixturePath, "Set DSP_CONSTRUCTION_STABILITY_SAVE to run the player-save acceptance test.");
  const raw = await readFile(realFixturePath!, "utf8");
  await page.goto("/");
  const result = await page.evaluate(async (fixtureRaw) => {
    const packs = await import("/src/game/contentPacks.ts");
    const storage = await import("/src/game/storage.ts");
    const parsed = JSON.parse(fixtureRaw) as { state?: unknown };
    const initial = storage.migrateGame(parsed.state ?? parsed);
    if (!initial) throw new Error("player save could not be migrated");
    initial.paused = false;
    initial.timeWarp.pendingSimulationSeconds = 0;
    initial.timeWarp.pendingWallSeconds = 0;
    const initialElapsed = initial.elapsedSeconds;
    const initialTransferred = initial.belts.reduce((sum, belt) => sum + (belt.totalTransferred ?? 0), 0);
    const initialProduced = Object.values(initial.totalProduced).reduce((sum, amount) => sum + (amount ?? 0), 0);
    const initialTargetCount = Object.keys(initial.constructionAutomation.targetStock).length;
    const initialCenterStacks = initial.entities
      .filter((entity) => entity.buildingId === "construction_center")
      .map((entity) => ({ id: entity.id, machineCount: entity.machineCount }))
      .sort((left, right) => left.id.localeCompare(right.id));
    const snapshot = packs.createContentPackRuntimeSnapshot(packs.createContentPackRegistry());
    const worker = new Worker(new URL("/src/game/simulation.worker.ts", location.origin), { type: "module" });
    const durations: number[] = [];
    let latest = initial;
    for (let id = 1; id <= 60; id += 1) {
      const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error(`player-save Worker request ${id} timed out`)), 5_000);
        const listener = (event: MessageEvent<Record<string, unknown>>) => {
          if (event.data.id !== id) return;
          worker.removeEventListener("message", listener);
          window.clearTimeout(timeout);
          resolve(event.data);
        };
        worker.addEventListener("message", listener);
        worker.postMessage({
          id,
          ...(id === 1 ? { state: initial, registry: snapshot } : {}),
          simulationSeconds: 1,
          wallSeconds: 1,
          registryFingerprint: snapshot.fingerprint,
        });
      });
      if (!response.state) throw new Error(`player-save Worker request ${id} returned no state`);
      if (typeof response.durationMs !== "number") throw new Error(`player-save Worker request ${id} returned no duration`);
      durations.push(response.durationMs);
      latest = response.state as typeof initial;
    }
    worker.terminate();
    return {
      updates: durations.length,
      p95Ms: [...durations].sort((left, right) => left - right)[Math.ceil(durations.length * 0.95) - 1],
      maxMs: Math.max(...durations),
      elapsedDelta: latest.elapsedSeconds - initialElapsed,
      transferredDelta: latest.belts.reduce((sum, belt) => sum + (belt.totalTransferred ?? 0), 0) - initialTransferred,
      producedDelta: Object.values(latest.totalProduced).reduce((sum, amount) => sum + (amount ?? 0), 0) - initialProduced,
      initialCenterStacks,
      centerStacks: latest.entities
        .filter((entity) => entity.buildingId === "construction_center")
        .map((entity) => ({ id: entity.id, machineCount: entity.machineCount }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      initialTargetCount,
      targetCount: Object.keys(latest.constructionAutomation.targetStock).length,
    };
  }, raw);

  expect(result.updates).toBe(60);
  expect(result.maxMs).toBeLessThan(2_000);
  expect(result.elapsedDelta).toBeCloseTo(60, 6);
  expect(result.transferredDelta).toBeGreaterThan(0);
  expect(result.producedDelta).toBeGreaterThan(0);
  expect(result.centerStacks).toEqual(result.initialCenterStacks);
  expect(result.targetCount).toBe(result.initialTargetCount);
  expect(result.targetCount).toBeGreaterThan(0);
});

test("stopping pure idle terminates an unresponsive slice and restores interaction", async ({ page }) => {
  test.skip(!realFixturePath, "Set DSP_CONSTRUCTION_STABILITY_SAVE to run the player-save acceptance test.");
  test.setTimeout(120_000);
  const envelope = JSON.parse(await readFile(realFixturePath!, "utf8")) as {
    formatVersion?: number;
    checksum?: string;
    savedAt?: number;
    state?: {
      activePlanetId?: string;
      entities?: Array<{ id?: string; planetId?: string; buildingId?: string }>;
      timeWarp?: { controllerEntityId?: string | null };
    };
  };
  envelope.savedAt = Date.now();
  const timeWarpEntity = envelope.state?.entities?.find((entity) =>
    entity.id === envelope.state?.timeWarp?.controllerEntityId && entity.buildingId === "time_warp_device")
    ?? envelope.state?.entities?.find((entity) => entity.buildingId === "time_warp_device");
  if (!timeWarpEntity?.id || !timeWarpEntity.planetId || !envelope.state) {
    throw new Error("player save has no usable time-warp device");
  }
  envelope.state.activePlanetId = timeWarpEntity.planetId;
  envelope.checksum = computeSaveStateChecksum(envelope.formatVersion ?? 2, envelope.state);
  const timeWarpEntityId = timeWarpEntity.id;
  await page.addInitScript(() => {
    window.localStorage.setItem("dsp-idle-network.onboarding.v1", "dismissed");
    window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-17-v1.0.46");
    const NativeWorker = window.Worker;
    const tracker = { delayTimeWarp: false, delayedRequests: 0, terminatedWorkers: 0, createdWorkers: 0 };
    Object.assign(window, { __timeWarpStopTracker: tracker });
    class DelayedSimulationWorker extends NativeWorker {
      private readonly delayResponses: boolean;
      private readonly delayedIds = new Set<number>();
      private readonly delayedTimers = new Set<number>();
      private assignedOnMessage: ((this: Worker, event: MessageEvent) => unknown) | null = null;

      constructor(scriptURL: string | URL, options?: WorkerOptions) {
        super(scriptURL, options);
        this.delayResponses = String(scriptURL).includes("/simulation.worker") && options?.name === "factory-simulation";
        if (this.delayResponses) tracker.createdWorkers += 1;
      }

      override postMessage(message: unknown, transfer?: Transferable[]): void {
        const requestId = message && typeof message === "object" && "id" in message
          ? Number((message as { id?: unknown }).id)
          : Number.NaN;
        if (this.delayResponses && tracker.delayTimeWarp && Number.isSafeInteger(requestId)) {
          this.delayedIds.add(requestId);
          tracker.delayedRequests += 1;
        }
        super.postMessage(message, transfer ?? []);
      }

      override set onmessage(listener: ((this: Worker, event: MessageEvent) => unknown) | null) {
        this.assignedOnMessage = listener;
        super.onmessage = listener ? (event) => {
          const responseId = Number((event.data as { id?: unknown } | null)?.id);
          if (!this.delayResponses || !this.delayedIds.has(responseId)) {
            listener.call(this, event);
            return;
          }
          const timer = window.setTimeout(() => {
            this.delayedTimers.delete(timer);
            listener.call(this, event);
          }, 10_000);
          this.delayedTimers.add(timer);
        } : null;
      }

      override get onmessage(): ((this: Worker, event: MessageEvent) => unknown) | null {
        return this.assignedOnMessage;
      }

      override terminate(): void {
        for (const timer of this.delayedTimers) window.clearTimeout(timer);
        this.delayedTimers.clear();
        if (this.delayResponses) tracker.terminatedWorkers += 1;
        super.terminate();
      }
    }
    Object.defineProperty(window, "Worker", { configurable: true, writable: true, value: DelayedSimulationWorker });
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/__construction_idle_harness.html", (route) => route.fulfill({
    status: 200,
    contentType: "text/html; charset=utf-8",
    body: "<!doctype html><html><body><main>Construction idle test harness</main></body></html>",
  }));
  await page.goto("/__construction_idle_harness.html");
  await page.evaluate(async (raw) => {
    const store = await import("/src/game/localSaveStore.ts");
    await store.initializeLocalSaveStore();
    store.setLocalSaveValue("dsp-idle-network.save.v1", raw);
    await store.flushLocalSaveWrites();
    if (await store.readPersistedLocalSaveValue("dsp-idle-network.save.v1") !== raw) {
      throw new Error("IndexedDB player-save seed did not read back exactly");
    }
  }, JSON.stringify(envelope));
  await page.goto("/?menu=1");
  await page.getByRole("button", { name: /继续游戏/ }).click({ timeout: 60_000 });
  const gameShell = page.locator(".game-shell");
  const abandonOffline = page.getByRole("button", { name: "放弃离线并直接进入" });
  await Promise.race([
    gameShell.waitFor({ state: "visible", timeout: 30_000 }),
    abandonOffline.waitFor({ state: "visible", timeout: 30_000 }),
  ]);
  if (await abandonOffline.isVisible()) await abandonOffline.click();
  await expect(gameShell).toBeVisible({ timeout: 30_000 });
  await expect(gameShell).toHaveAttribute("data-simulation-worker", "active");
  const timeWarpNode = page.locator(`.react-flow__node[data-id="${timeWarpEntityId}"] .machine-node`);
  await expect(timeWarpNode).toHaveCount(1);
  await timeWarpNode.evaluate((element: HTMLElement) => element.click());
  await expect(page.locator(".time-warp-inspector")).toBeVisible();
  await page.evaluate(() => {
    (window as typeof window & { __timeWarpStopTracker?: { delayTimeWarp: boolean } }).__timeWarpStopTracker!.delayTimeWarp = true;
  });
  await page.getByRole("button", { name: "开始纯挂机" }).click();
  const overlay = page.getByRole("dialog", { name: "纯挂机" });
  await expect(overlay).toBeVisible();
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { __timeWarpStopTracker?: { delayedRequests: number } }).__timeWarpStopTracker?.delayedRequests ?? 0,
  ), { timeout: 3_000 }).toBeGreaterThan(0);

  const stopStartedAt = Date.now();
  await overlay.getByRole("button", { name: "停止并结算纯挂机" }).click();
  await expect(overlay).toHaveCount(0, { timeout: 1_000 });
  await expect(page.locator(".game-notice")).toContainText("未完成切片已丢弃", { timeout: 3_000 });
  const stopDurationMs = Date.now() - stopStartedAt;
  // The user-visible stop includes the bounded worker wait plus the verified
  // IndexedDB save commit. Keep the acceptance within a few seconds without
  // mistaking the persistence step for an unbounded simulation wait.
  expect(stopDurationMs).toBeLessThan(3_000);
  await page.evaluate(() => {
    (window as typeof window & { __timeWarpStopTracker?: { delayTimeWarp: boolean } }).__timeWarpStopTracker!.delayTimeWarp = false;
  });
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { __timeWarpStopTracker?: { terminatedWorkers: number } }).__timeWarpStopTracker?.terminatedWorkers ?? 0,
  )).toBeGreaterThan(0);
  await expect(page.locator(".game-shell")).toHaveAttribute("data-simulation-worker", "active", { timeout: 3_000 });
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { __timeWarpStopTracker?: { createdWorkers: number } }).__timeWarpStopTracker?.createdWorkers ?? 0,
  )).toBeGreaterThan(1);

  const delayedBeforeAutomaticTimeout = await page.evaluate(() =>
    (window as typeof window & { __timeWarpStopTracker?: { delayedRequests: number } }).__timeWarpStopTracker?.delayedRequests ?? 0,
  );
  await page.evaluate(() => {
    (window as typeof window & { __timeWarpStopTracker?: { delayTimeWarp: boolean } }).__timeWarpStopTracker!.delayTimeWarp = true;
  });
  await page.getByRole("button", { name: "开始纯挂机" }).click();
  await expect(page.getByRole("dialog", { name: "纯挂机" })).toBeVisible();
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { __timeWarpStopTracker?: { delayedRequests: number } }).__timeWarpStopTracker?.delayedRequests ?? 0,
  ), { timeout: 3_000 }).toBeGreaterThan(delayedBeforeAutomaticTimeout);
  await expect(page.getByRole("dialog", { name: "纯挂机" })).toHaveCount(0, { timeout: 7_000 });
  await expect(page.locator(".game-notice")).toContainText("单个切片超过安全时限", { timeout: 3_000 });
  await page.evaluate(() => {
    (window as typeof window & { __timeWarpStopTracker?: { delayTimeWarp: boolean } }).__timeWarpStopTracker!.delayTimeWarp = false;
  });
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { __timeWarpStopTracker?: { terminatedWorkers: number } }).__timeWarpStopTracker?.terminatedWorkers ?? 0,
  )).toBeGreaterThan(1);
  await expect(page.locator(".game-shell")).toHaveAttribute("data-simulation-worker", "active", { timeout: 3_000 });
  await page.getByTitle("生产统计").click();
  await expect(page.getByRole("dialog", { name: "生产统计" })).toBeVisible();
});

