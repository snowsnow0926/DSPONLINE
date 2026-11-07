import { expect, test } from "@playwright/test";

function scaleBlueprintEnvelope(belts = 8_192) {
  return {
    type: "dsp-idle-blueprint", formatVersion: 2,
    blueprint: {
      id: "scale_blueprint", name: "规模蓝图", revision: 1,
      entities: Array.from({ length: 4_096 }, (_, index) => ({
        key: `node_${index + 1}`, buildingId: "storage_mk1",
        offset: { x: index % 64 * 200, y: Math.floor(index / 64) * 180 }, machineCount: 1,
      })),
      belts: Array.from({ length: belts }, (_, index) => ({
        key: `line_${index + 1}`, sourceKey: `node_${index % 4_096 + 1}`,
        targetKey: `node_${(index + 1 + Math.floor(index / 4_096)) % 4_096 + 1}`,
        itemId: "iron_ingot", lanes: 1, tier: 1, priority: 0,
      })),
    },
  };
}

function seedPendingBlueprintFixture() {
  return () => {
    const blueprint = {
      id: "pending_factory",
      name: "待建铁板单元",
      revision: 1,
      rotation: 0,
      mirror: "none",
      entities: [
        { key: "smelter", buildingId: "arc_smelter", offset: { x: 0, y: 0 }, machineCount: 1, recipeId: "iron_ingot" },
        { key: "storage", buildingId: "storage_mk1", offset: { x: 340, y: 0 }, machineCount: 1, storedItemId: "iron_ingot" },
      ],
      belts: [{
        key: "output",
        sourceKey: "smelter",
        targetKey: "storage",
        itemId: "iron_ingot",
        lanes: 1,
        tier: 1,
        sorterTier: 3,
        priority: 1,
        stackSize: 1,
        monitorEnabled: false,
        routeMode: "auto",
      }],
    };
    const state = {
      version: 45,
      nextId: 20,
      activePlanetId: "home",
      entities: [],
      belts: [],
      construction: { arc_smelter: 1, storage_mk1: 1, conveyor_belt_mk1: 1 },
      constructionAutomation: { enabled: false, targetStock: {}, cursor: 0, totalCrafted: 0, lastCraftedId: null, destroyedByproducts: {}, jobs: {} },
      tray: {},
      planetTrays: { home: {} },
      planetTrayItemLimits: { home: 100_000_000 },
      portableFleet: { logistics_drone: 0, logistics_vessel: 0 },
      totalProduced: {},
      research: { selectedTechId: null, pausedTechId: null, queuedTechIds: [], progressByTech: {}, completedTechIds: [] },
      settings: { theme: "dark", fontScale: 1, simulationSpeed: 1, autosaveIntervalSeconds: 30 },
      blueprints: [blueprint],
      constructionQueue: [{
        id: "construction_pending",
        blueprintId: blueprint.id,
        blueprintName: blueprint.name,
        planetId: "home",
        position: { x: 160, y: 180 },
        rotation: 0,
        mirror: "none",
        queuedAt: 125,
      }],
      paused: true,
    };
    window.sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-11-07-v1.3.10");
    window.localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  };
}

test("bounded factory headline preserves visible blueprint queue and planet summary", async ({ page }) => {
  await page.addInitScript(seedPendingBlueprintFixture());
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  await page.getByRole("button", { name: "打开蓝图库" }).click();
  const workspace = page.getByRole("dialog", { name: "蓝图与待建施工" });
  const headline = workspace.locator(".blueprint-headline");
  await expect(headline).toContainText("模板 1");
  await expect(headline).toContainText("施工队列 1");
  await expect(headline).toContainText("部署行星 澄海 I");
  await expect(headline.locator("[data-factory-read-model-source]"))
    .toHaveAttribute("data-factory-read-model-source", "web-game-state");
  await expect(headline.locator("[data-factory-read-model-revision]"))
    .toHaveAttribute("data-factory-read-model-revision", "web");
});

test("v134 Web imports and exports the complete 4096-node 8192-line file", async ({ page }) => {
  await page.addInitScript(seedPendingBlueprintFixture());
  await page.goto("/");
  await page.getByRole("button", { name: "打开蓝图库" }).click();
  const workspace = page.getByRole("dialog", { name: "蓝图与待建施工" });
  const input = scaleBlueprintEnvelope();
  const buffer = Buffer.from(JSON.stringify(input));
  expect(buffer.byteLength).toBeGreaterThan(1_048_576);
  await workspace.locator("input[type=file]").setInputFiles({ name: "large-blueprint.json", mimeType: "application/json", buffer });
  const card = workspace.locator(".blueprint-card").filter({ has: page.getByRole("textbox", { name: "规模蓝图名称", exact: true }) });
  await expect(card.locator("header em")).toContainText("4096 设备");
  await expect(card.locator("header em")).toContainText("8192 线路");
  const downloadEvent = page.waitForEvent("download");
  await card.getByRole("button", { name: "导出", exact: true }).click();
  const stream = await (await downloadEvent).createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const exported = JSON.parse(Buffer.concat(chunks).toString("utf8")).blueprint;
  expect(exported.entities.map((row: { key: string; buildingId: string; offset: unknown; machineCount: number }) => [row.key, row.buildingId, row.offset, row.machineCount]))
    .toEqual(input.blueprint.entities.map((row) => [row.key, row.buildingId, row.offset, row.machineCount]));
  expect(exported.belts.map((row: { key: string; sourceKey: string; targetKey: string; itemId: string; lanes: number }) => [row.key, row.sourceKey, row.targetKey, row.itemId, row.lanes]))
    .toEqual(input.blueprint.belts.map((row) => [row.key, row.sourceKey, row.targetKey, row.itemId, row.lanes]));
});

test("v134 Web rejects an oversized file and the next line without adding a blueprint", async ({ page }) => {
  await page.addInitScript(seedPendingBlueprintFixture());
  await page.goto("/");
  await page.getByRole("button", { name: "打开蓝图库" }).click();
  const workspace = page.getByRole("dialog", { name: "蓝图与待建施工" });
  const pickerEvent = page.waitForEvent("filechooser");
  await workspace.getByRole("button", { name: "导入蓝图", exact: true }).click();
  await (await pickerEvent).setFiles({ name: "oversized.json", mimeType: "application/json", buffer: Buffer.alloc(8 * 1_048_576 + 1, 0x20) });
  const panel = workspace.getByRole("region", { name: "蓝图导入" });
  await expect(panel).toContainText("8 MiB");
  await expect(panel).toContainText("超过");
  await expect(workspace.locator(".blueprint-card")).toHaveCount(1);
  await workspace.locator("input[type=file]").setInputFiles({ name: "too-many-lines.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(scaleBlueprintEnvelope(8_193))) });
  await expect(panel).toContainText("超过上限");
  await expect(workspace.locator(".blueprint-card")).toHaveCount(1);
});

test("v134 import capacity stays readable at 150 percent in desktop and mobile orientations", async ({ page }, testInfo) => {
  await page.addInitScript(seedPendingBlueprintFixture());
  await page.addInitScript(() => {
    const key = "dsp-idle-network.save.v1";
    const raw = window.localStorage.getItem(key);
    if (!raw) return;
    const envelope = JSON.parse(raw);
    envelope.state.settings.fontScale = 1.5;
    window.localStorage.setItem(key, JSON.stringify(envelope));
  });
  await page.goto("/");
  await page.getByRole("button", { name: "打开蓝图库" }).click();
  const workspace = page.getByRole("dialog", { name: "蓝图与待建施工" });
  const picker = page.waitForEvent("filechooser");
  await workspace.getByRole("button", { name: "导入蓝图", exact: true }).click();
  await (await picker).setFiles([]);
  const panel = workspace.getByRole("region", { name: "蓝图导入" });
  for (const [name, width, height] of [["desktop", 1440, 900], ["portrait", 390, 844], ["landscape", 844, 390]] as const) {
    await page.setViewportSize({ width, height });
    await expect(panel).toContainText("4,096");
    await expect(panel).toContainText("8,192");
    await expect(panel).toContainText("8 MiB");
    await expect.poll(() => panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`blueprint-capacity-${name}.png`) });
    const confirm = panel.getByRole("button", { name: "导入到蓝图库", exact: true });
    await confirm.scrollIntoViewIfNeeded();
    await expect(confirm).toBeInViewport();
    if (name === "landscape") await page.screenshot({ path: testInfo.outputPath("blueprint-capacity-landscape-actions.png") });
  }
});

test("v45 queued blueprints render a viewport ghost and deploy atomically after funding", async ({ page }) => {
  await page.addInitScript(seedPendingBlueprintFixture());
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  await expect(page.locator(".pending-blueprint-node")).toHaveCount(2);
  await expect(page.locator(".pending-blueprint-line")).toHaveCount(1);
  await page.getByRole("button", { name: "打开蓝图库" }).click();
  await page.locator(".blueprint-tabs > button").nth(1).click();

  const order = page.locator(".pending-construction-order").filter({ hasText: "待建铁板单元" });
  await expect(order).toContainText("澄海 I · 坐标 160, 180");
  await expect(order).toContainText("电弧熔炉");
  await expect(order).toContainText("传送带 Mk.I");
  await order.getByRole("button", { name: "补足建筑与线路" }).click();
  await expect(page.locator(".pending-construction-order")).toHaveCount(0);

  await page.getByRole("button", { name: "关闭蓝图工作区" }).click();
  await expect(page.locator(".pending-blueprint-node")).toHaveCount(0);
  await expect(page.locator('.react-flow__node[data-id^="entity_"]')).toHaveCount(2);
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
});

test("cancelled construction reservations return exactly and both dialog paths keep inputs usable", async ({ page }) => {
  await page.addInitScript(seedPendingBlueprintFixture());
  await page.addInitScript(() => {
    const raw = window.localStorage.getItem("dsp-idle-network.save.v1");
    if (!raw) return;
    const envelope = JSON.parse(raw);
    envelope.state.construction = { arc_smelter: 0, storage_mk1: 0, conveyor_belt_mk1: 0 };
    envelope.state.constructionQueue[0].reservedConstruction = { arc_smelter: 1 };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify(envelope));
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  await page.getByRole("button", { name: "打开蓝图库" }).click();
  await page.getByRole("button", { name: /待建与补足/ }).click();
  const order = page.locator(".pending-construction-order");
  await order.getByRole("button", { name: "取消并返还" }).click();
  await page.locator(".game-dialog").getByRole("button", { name: "取消", exact: true }).click();
  await expect(order).toHaveCount(1);

  await page.getByRole("button", { name: "蓝图库", exact: true }).click();
  const nameInput = page.getByLabel("待建铁板单元名称");
  await nameInput.fill("取消路径输入正常");
  await nameInput.blur();
  await expect(page.getByLabel("取消路径输入正常名称")).toHaveValue("取消路径输入正常");

  await page.getByRole("button", { name: /待建与补足/ }).click();
  await order.getByRole("button", { name: "取消并返还" }).click();
  await page.locator(".game-dialog").getByRole("button", { name: "取消并返还" }).click();
  await expect(order).toHaveCount(0);
  await expect(page.locator(".pending-blueprint-node")).toHaveCount(0);

  await page.getByRole("button", { name: "蓝图库", exact: true }).click();
  const restoredCard = page.locator(".blueprint-card");
  await expect(restoredCard).toContainText("电弧熔炉 1/1");
  await restoredCard.getByLabel("取消路径输入正常名称").fill("确认路径输入正常");
  await restoredCard.getByLabel("取消路径输入正常名称").blur();
  await expect(restoredCard.getByLabel("确认路径输入正常名称")).toHaveValue("确认路径输入正常");
});

test("missing-material blueprints stay in continuous placement until right click", async ({ page }) => {
  await page.addInitScript(seedPendingBlueprintFixture());
  await page.addInitScript(() => {
    const raw = window.localStorage.getItem("dsp-idle-network.save.v1");
    if (!raw) return;
    const envelope = JSON.parse(raw);
    envelope.state.construction = { arc_smelter: 0, storage_mk1: 0, conveyor_belt_mk1: 0 };
    envelope.state.constructionQueue = [];
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify(envelope));
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  await page.getByRole("button", { name: "打开蓝图库" }).click();
  await page.getByRole("button", { name: "排队部署" }).click();
  const pane = page.locator(".react-flow__pane");
  const paneBox = await pane.boundingBox();
  expect(paneBox).not.toBeNull();
  await pane.dispatchEvent("click", { bubbles: true, button: 0, clientX: paneBox!.x + 360, clientY: paneBox!.y + 260 });
  await pane.dispatchEvent("click", { bubbles: true, button: 0, clientX: paneBox!.x + 760, clientY: paneBox!.y + 560 });
  await expect(page.locator(".pending-blueprint-node")).toHaveCount(4);
  await expect(page.getByRole("status")).toContainText("连续放置中");

  await pane.click({ button: "right", position: { x: 760, y: 700 }, force: true });
  await expect(page.getByRole("status")).toContainText("已结束蓝图连续放置");
  await page.getByRole("button", { name: "打开蓝图库" }).click();
  await page.getByRole("button", { name: /待建与补足/ }).click();
  await expect(page.locator(".pending-construction-order")).toHaveCount(2);
});

test("pending blueprint funding remains usable in the next mobile UI at 200 percent text", async ({ page }) => {
  await page.addInitScript(seedPendingBlueprintFixture());
  await page.addInitScript(() => {
    const raw = window.localStorage.getItem("dsp-idle-network.save.v1");
    if (!raw) return;
    const envelope = JSON.parse(raw);
    envelope.state.settings.fontScale = 2;
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify(envelope));
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?mobileUi=next");

  await page.getByRole("button", { name: "更多", exact: true }).click();
  await page.getByRole("button", { name: /蓝图库/ }).click();
  const workspace = page.locator(".blueprint-workspace");
  await expect(workspace).toBeVisible();
  await workspace.getByRole("button", { name: /待建与补足/ }).click();

  const order = workspace.locator(".pending-construction-order");
  await expect(order).toContainText("待建铁板单元");
  await expect.poll(() => workspace.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  const actions = await order.locator("footer button").evaluateAll((buttons) => buttons.map((button) => {
    const rect = button.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }));
  expect(actions.length).toBe(4);
  for (const action of actions) {
    expect(action.width).toBeGreaterThanOrEqual(44);
    expect(action.height).toBeGreaterThanOrEqual(44);
  }

  await order.getByRole("button", { name: "补足建筑与线路" }).click();
  await expect(workspace.locator(".pending-construction-order")).toHaveCount(0);
  await page.locator(".mobile-next-topbar").getByRole("button", { name: /返回工厂/ }).click();
  await expect(page.locator('.react-flow__node[data-id^="entity_"]')).toHaveCount(2);
});
