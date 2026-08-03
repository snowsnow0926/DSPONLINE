import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-01-v1.0.19");
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
  await operations.getByRole("button", { name: "教程、版本与其他", exact: true }).first().click();
  await operations.getByRole("button", { name: "打开新手教程" }).click();
  const tutorial = page.getByRole("dialog", { name: "新手教程" });
  await expect(tutorial).toContainText("认识画布");
  await tutorial.getByRole("button", { name: "标记本节完成" }).click();
  await expect(tutorial.locator(".tutorial-progress")).toContainText("1/");
  await tutorial.screenshot({ path: "artifacts/qa/v115-tutorial-desktop.png", animations: "disabled" });
  await tutorial.getByRole("button", { name: "关闭新手教程" }).click();
  await expect(page.getByRole("dialog", { name: "新手教程" })).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("dspidle:tutorial-progress:1.0.15"))).toContain("canvas");
});

test("time warp starts a blocking pure-idle page and can stop safely", async ({ page }) => {
  await page.addInitScript(() => {
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
  await idle.screenshot({ path: "artifacts/qa/v115-pure-idle-desktop.png", animations: "disabled" });
  await expect(page.locator(".construction-dock")).toBeHidden();
  await idle.getByRole("button", { name: "停止挂机" }).click();
  await expect(idle).toBeHidden();
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
  await operations.getByRole("button", { name: "教程、版本与其他", exact: true }).first().click();
  await operations.getByRole("button", { name: "打开新手教程" }).click();
  const tutorial = page.getByRole("dialog", { name: "新手教程" });
  await expect(tutorial).toBeVisible();
  await tutorial.screenshot({ path: "artifacts/qa/v115-tutorial-mobile-390x844.png", animations: "disabled" });
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(tutorial).toBeVisible();
  await tutorial.screenshot({ path: "artifacts/qa/v115-tutorial-mobile-844x390.png", animations: "disabled" });
});
