import { expect, test } from "@playwright/test";
import { selectSettingsCategory } from "./settings-helpers";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-17-v1.0.46");
    window.localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
    window.localStorage.setItem("dspidle:tutorial-progress:1.0.15", "[]");
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({
      savedAt: Date.now(),
      state: {
        version: 42,
        nextId: 1,
        activePlanetId: "home",
        entities: [],
        belts: [],
        construction: {},
        tray: {},
        planetTrays: { home: {} },
        totalProduced: {},
        settings: { theme: "dark", fontScale: 1, simulationSpeed: 1, autosaveIntervalSeconds: 30 },
        research: { selectedTechId: null, pausedTechId: null, queuedTechIds: [], progressByTech: {}, completedTechIds: [] },
        paused: true,
      },
    }));
    const NativeWorker = window.Worker;
    const tracker = { initializes: 0, finalizes: 0 };
    Object.assign(window, { __pureIdleReuseTracker: tracker });
    class TrackedPureIdleWorker extends NativeWorker {
      private readonly pureIdleMacro: boolean;

      constructor(scriptURL: string | URL, options?: WorkerOptions) {
        super(scriptURL, options);
        this.pureIdleMacro = options?.name === "pure-idle-macro";
      }

      override postMessage(message: unknown, transfer?: Transferable[]): void {
        if (this.pureIdleMacro && message && typeof message === "object" && "type" in message) {
          if ((message as { type?: unknown }).type === "initialize") tracker.initializes += 1;
          if ((message as { type?: unknown }).type === "finalize") tracker.finalizes += 1;
        }
        super.postMessage(message, transfer ?? []);
      }
    }
    Object.defineProperty(window, "Worker", { configurable: true, writable: true, value: TrackedPureIdleWorker });
  });
});

test("settings opens the complete tutorial and keeps independent reading progress", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  const onboarding = page.getByRole("button", { name: /^(?:关闭|跳过)启动引导$/ });
  if (await onboarding.count()) await onboarding.first().click();
  await page.getByLabel("打开设置").click();
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.getByRole("tab", { name: "设置" }).click();
  await selectSettingsCategory(operations, "教程、版本与其他", "other");
  await operations.getByRole("button", { name: "打开新手教程" }).click();
  const tutorial = page.getByRole("dialog", { name: "新手教程" });
  await expect(tutorial).toContainText("DSP极简网络 · v1.0.46");
  await expect(tutorial).toContainText("认识画布");
  await tutorial.getByRole("button", { name: "标记本节完成" }).click();
  await expect(tutorial.locator(".tutorial-progress")).toContainText("1/");
  await tutorial.screenshot({ path: "artifacts/qa/v115-tutorial-desktop.png", animations: "disabled" });
  await tutorial.getByRole("button", { name: "关闭新手教程" }).click();
  await expect(page.getByRole("dialog", { name: "新手教程" })).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("dspidle:tutorial-progress:1.0.15"))).toBe("[]");
  expect(await page.evaluate(() => localStorage.getItem("dspidle:tutorial-progress:2026-08-14-r1"))).toContain("canvas");
});

test("time warp starts a blocking pure-idle page and can stop safely", async ({ page }) => {
  await page.addInitScript(() => {
    (window as typeof window & { __DSP_RUNTIME_TRANSITIONS__?: unknown }).__DSP_RUNTIME_TRANSITIONS__ = {
      enabled: true,
      events: [],
      active: {},
      counters: {},
    };
    const envelope = JSON.parse(window.localStorage.getItem("dsp-idle-network.save.v1") ?? "{}");
    envelope.state.entities = [{
      id: "warp", kind: "machine", planetId: "home", position: { x: 0, y: 0 }, buildingId: "time_warp_device", machineCount: 1,
      inputs: {}, outputs: {}, progress: 0, utilization: 0, productionRate: 0, powerFactor: 1, powerInputKw: 0, interactionLocked: false,
    }];
    envelope.state.construction = { time_warp_device: 0 };
    envelope.state.research.completedTechIds = ["universe_matrix", "time_warp_engineering"];
    envelope.state.timeWarp = { controllerEntityId: "warp", enabled: false, requestedMultiplier: 5, effectiveMultiplier: 1, pendingSimulationSeconds: 0, pendingWallSeconds: 0, requiredPowerKw: 0, allocatedPowerKw: 0 };
    envelope.state.paused = true;
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify(envelope));
  });
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  const onboarding = page.getByRole("button", { name: /^(?:关闭|跳过)启动引导$/ });
  if (await onboarding.count()) await onboarding.first().click();
  const node = page.locator(".react-flow__node").filter({ hasText: "时间扭曲装置" });
  await expect(node).toBeVisible();
  await node.locator(".factory-node__header").click();
  const inspector = page.locator(".inspector-panel");
  await expect(inspector.getByRole("button", { name: "开始纯挂机" })).toBeVisible();
  await inspector.getByRole("button", { name: "开始纯挂机" }).click();
  const idle = page.getByRole("dialog", { name: "纯挂机" });
  await expect(idle).toBeVisible();
  await expect(idle).toContainText("画布已冻结");
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { __pureIdleReuseTracker?: { initializes: number } }).__pureIdleReuseTracker?.initializes ?? 0,
  )).toBe(1);
  await idle.screenshot({ path: "artifacts/qa/v115-pure-idle-desktop.png", animations: "disabled" });
  await expect(page.locator(".construction-dock")).toBeHidden();
  await idle.getByRole("button", { name: "停止并结算纯挂机" }).click();
  await expect(idle).toBeHidden();
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { __pureIdleReuseTracker?: { finalizes: number } }).__pureIdleReuseTracker?.finalizes ?? 0,
  )).toBe(1);
  expect(await page.evaluate(() =>
    (window as typeof window & { __pureIdleReuseTracker?: { initializes: number } }).__pureIdleReuseTracker?.initializes ?? 0,
  )).toBe(1);
  const persistencePhases = await page.evaluate(() => {
    const events = (window as typeof window & {
      __DSP_RUNTIME_TRANSITIONS__?: { events: Array<{ phase: string; detail?: { kind?: string; phase?: string } }> };
    }).__DSP_RUNTIME_TRANSITIONS__?.events ?? [];
    return events
      .filter((event) => event.phase === "persistence-phase" && event.detail?.kind === "pure-idle-stop")
      .map((event) => event.detail?.phase);
  });
  expect(persistencePhases).toEqual(["checkpoint", "serialize-write-readback", "complete"]);
});

test("an interrupted frozen settlement exposes retry and explicit abandon actions", async ({ page }) => {
  await page.route("**/__pure_idle_recovery_harness.html", (route) => route.fulfill({
    status: 200,
    contentType: "text/html; charset=utf-8",
    body: "<!doctype html><html><body>Pure-idle recovery harness</body></html>",
  }));
  await page.goto("/__pure_idle_recovery_harness.html");
  await page.evaluate(async () => {
    const engine = await import("/src/game/engine.ts");
    const recovery = await import("/src/game/pureIdleRecovery.ts");
    const storage = await import("/src/game/storage.ts");
    const store = await import("/src/game/localSaveStore.ts");
    const state = engine.createInitialState(20_260_808, false);
    state.entities.push({
      id: "recovery-warp",
      kind: "machine",
      planetId: "home",
      position: { x: 0, y: 0 },
      buildingId: "time_warp_device",
      machineCount: 1,
      minerCount: 0,
      inputs: {},
      outputs: {},
      progress: 0,
      routingCursor: 0,
      utilization: 0,
      productionRate: 0,
      interactionLocked: false,
    });
    state.research.completedTechIds.push("universe_matrix", "time_warp_engineering");
    state.paused = false;
    state.timeWarp.controllerEntityId = "recovery-warp";
    state.timeWarp.enabled = true;
    state.timeWarp.requestedMultiplier = 5;
    const now = Date.now();
    window.sessionStorage.setItem("dsp-idle-network.pure-idle-owner.v1", "seed-owner");
    await store.initializeLocalSaveStore();
    const envelope = JSON.parse(storage.serializeEnvelope(state));
    envelope.savedAt = now + 60_000;
    store.setLocalSaveValue("dsp-idle-network.save.v1", JSON.stringify(envelope));
    await store.flushLocalSaveWrites();
    const created = await recovery.createPureIdleRecovery(state, "stable", now - 120_000, "seed-owner", now, false);
    if (!created.ok) throw new Error(created.message);
    const transitioned = await recovery.recordPureIdleRecoveryTransition(created.record.sessionId, "seed-owner", {
      stopReason: "user-stop-requested",
      phase: "finalizing",
      stopRequestedAtMs: now,
      targetWallSeconds: 120,
    }, now);
    if (!transitioned) throw new Error("failed to freeze recovery boundary");
    await recovery.releasePureIdleRecoveryLease(created.record.sessionId, "seed-owner", now + 1);
  });
  await page.goto("/");
  const idle = page.getByRole("dialog", { name: "纯挂机" });
  await expect(idle).toBeVisible();
  await expect(idle.getByRole("button", { name: "重试恢复纯挂机" })).toBeVisible();
  await expect(idle.getByRole("button", { name: /放弃约 .* 未结算时间并继续普通模拟/ })).toBeVisible();
    await idle.getByText("查看计算与恢复详情").click();
    await expect(idle).toContainText("玩家请求停止");
    await expect(idle).toContainText("尚未提交");
    await expect(idle.getByText("冻结结算边界").locator("..")).toContainText("2分 0秒");
});

test("tutorial remains readable in portrait and landscape mobile shells", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?mobileUi=next");
  const onboarding = page.getByRole("button", { name: /^(?:关闭|跳过)启动引导$/ });
  if (await onboarding.count()) await onboarding.first().click();
  await page.getByRole("button", { name: "更多" }).click();
  await page.getByRole("button", { name: /游戏设置/ }).click();
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.getByRole("tab", { name: "设置" }).click();
  await selectSettingsCategory(operations, "教程、版本与其他", "other");
  await operations.getByRole("button", { name: "打开新手教程" }).click();
  const tutorial = page.getByRole("dialog", { name: "新手教程" });
  await expect(tutorial).toBeVisible();
  await tutorial.screenshot({ path: "artifacts/qa/v115-tutorial-mobile-390x844.png", animations: "disabled" });
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(tutorial).toBeVisible();
  await tutorial.screenshot({ path: "artifacts/qa/v115-tutorial-mobile-844x390.png", animations: "disabled" });
});


