import { expect, test, type Page } from "@playwright/test";

const durable = ["true", "1", "on"].includes((process.env.VITE_DURABLE_RUNTIME_RECOVERY ?? "").toLowerCase());
const errors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const messages: string[] = [];
  errors.set(page, messages);
  page.on("pageerror", error => messages.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && /\[DSP runtime render error\]|Encountered two children/.test(message.text())) messages.push(message.text());
  });
  await page.route("**/api/**", route => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"isolated conversion test"}' }));
});
test.afterEach(async ({ page }) => expect(errors.get(page)).toEqual([]));

async function seed(page: Page) {
  await page.goto("/?menu=1");
  await expect(page.locator(".start-menu")).toBeVisible({ timeout: 60_000 });
  await page.evaluate(async () => {
    const packs = await import("/src/game/contentPacks.ts");
    const mods = await import("/src/game/mods.ts");
    const engine = await import("/src/game/engine.ts");
    const storage = await import("/src/game/storage.ts");
    const release = await import("/src/i18n/currentReleaseNotes.ts");
    const manifest = {
      formatVersion: 5, id: "return_pack", name: "转换测试包", version: "1.0.0",
      items: [{ id: "return_ore", name: "转换测试矿石" }],
      buildings: [{ id: "return_box", name: "转换测试设备", kind: "storage", inputCapacity: 1000, outputCapacity: 1000, costs: [{ itemId: "iron_ingot", amount: 1 }] }],
      recipes: [{ id: "return_recipe", name: "转换测试配方", buildingId: "arc_smelter", duration: 2, inputs: [{ itemId: "return_ore", amount: 1 }, { itemId: "iron_ingot", amount: 2 }], outputs: [{ itemId: "copper_ingot", amount: 1 }] }],
      technologies: [{ id: "return_tech", name: "转换测试科技", costs: [{ itemId: "electromagnetic_matrix", amount: 3 }] }],
      resources: [{ itemId: "return_ore", extractorBuildingId: "mining_machine", planetIds: ["home"], reserve: 77 }],
      belts: [{ id: "return_belt", name: "转换测试带", tier: 4, speed: 80, costs: [{ itemId: "iron_ingot", amount: 1 }] }],
      itemOverrides: [{ id: "iron_ore", name: "重写铁矿" }], beltOverrides: [{ id: "conveyor_belt_mk1", speed: 17 }],
    };
    const empty = packs.createContentPackRegistry();
    const checked = mods.validateContentPack(manifest);
    if (!checked.valid) throw new Error(JSON.stringify(checked.issues));
    const registry = packs.registerContentPack(empty, checked).registry;
    if (!packs.commitContentPackRegistry(registry, empty).persisted) throw new Error("fixture registry write failed");
    let state = engine.createInitialState();
    state.settings.autosaveIntervalSeconds = 0;
    state.settings.resourceMode = "finite";
    state.tray.iron_ingot = 17;
    state.tray.return_ore = 9;
    state.construction.return_box = 1;
    state = engine.placeBuilding(state, "return_box", { x: 0, y: 200 });
    const custom = state.entities.find(entity => entity.buildingId === "return_box")!;
    custom.storedItemId = "iron_ingot";
    custom.inputs = { return_ore: 3 };
    custom.outputs = { copper_ingot: 4, iron_ingot: 7 };
    const vein = state.entities.find(entity => entity.resourceId === "return_ore")!;
    vein.minerCount = 2;
    vein.extractorBuildingId = "mining_machine";
    vein.resourceRemaining = 59;
    vein.resourceCapacity = 77;
    state.construction.arc_smelter = 1;
    state = engine.placeBuilding(state, "arc_smelter", { x: 200, y: 200 });
    const core = state.entities.find(entity => entity.buildingId === "arc_smelter")!;
    core.recipeId = "return_recipe";
    core.inputs = { iron_ingot: 5, return_ore: 1 };
    core.progress = 0.4;
    state.belts = [{ id: "return_line", source: custom.id, target: core.id, planetId: "home", itemId: "iron_ingot", tier: 1, sorterTier: 1, lanes: 2, progress: 0.2, priority: 2, lastFlow: 0 }];
    state.research.completedTechIds.push("return_tech");
    state.research.progressByTech.return_tech = { electromagnetic_matrix: 3 };
    state.quantumLogisticsNetwork.inventory.return_ore = "900719925474099312345";
    state.handcraftQueue = [{ id: "return_craft", recipeId: "return_recipe", planetId: "home", batchesTotal: 3, batchesRemaining: 3, progress: 0.5, queuedAt: 0 }];
    const blueprint = { id: "mixed", name: "转换混合蓝图", revision: 1, entities: [{ key: "core", buildingId: "wind_turbine", machineCount: 1, offset: { x: 0, y: 0 } }, { key: "custom", buildingId: "return_box", machineCount: 1, offset: { x: 100, y: 0 } }], belts: [] };
    state.blueprints = [blueprint];
    state.blueprintVersions = [{ id: "mixed_v1", blueprintId: "mixed", revision: 1, definition: structuredClone(blueprint) }];
    state.constructionQueue = [{ id: "return_order", blueprintId: "mixed", blueprintVersionId: "mixed_v1", blueprintName: blueprint.name, planetId: "home", position: { x: 500, y: 500 }, rotation: 0, mirror: "none", queuedAt: 0, reservedConstruction: { wind_turbine: 2, return_box: 1 } }];
    state.paused = true;
    const saved = await storage.saveGameVerified(state);
    if (!saved.success) throw new Error(saved.message);
    localStorage.setItem("dsp-idle-network.release-notes.seen.v1", release.CURRENT_RELEASE_ID);
    localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
  });
  if (!durable) await page.evaluate(() => sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1"));
  await page.goto("/");
  if (durable) await page.getByRole("button", { name: /继续游戏/ }).click();
  await expect(page.locator(".factory-canvas")).toBeVisible({ timeout: 60_000 });
  if (durable) await expect(page.locator(".game-shell")).toHaveAttribute("data-runtime-recovery", "active");
  return openPacks(page);
}

async function openPacks(page: Page) {
  if (await page.getByLabel("打开设置", { exact: true }).isVisible()) await page.getByLabel("打开设置", { exact: true }).click();
  else { await page.getByRole("button", { name: "更多工作区", exact: true }).click(); await page.getByRole("menuitem", { name: "设置", exact: true }).click(); }
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.getByRole("tab", { name: "内容包", exact: true }).click();
  return operations;
}

async function stored(page: Page) {
  return page.evaluate(async () => {
    const store = await import("/src/game/localSaveStore.ts");
    const raw = await store.readPersistedLocalSaveValue("dsp-idle-network.save.v1");
    if (!raw) throw new Error("primary missing");
    return JSON.parse(raw).state;
  });
}

async function convert(operations: Awaited<ReturnType<typeof openPacks>>) {
  await operations.getByRole("button", { name: "转回原版存档", exact: true }).click();
  const confirmation = operations.getByRole("group", { name: "转回原版存档确认" });
  await expect(confirmation.getByRole("button", { name: "确认转换并保存" })).toBeDisabled();
  await confirmation.getByRole("checkbox").check();
  await confirmation.getByRole("button", { name: "确认转换并保存" }).click();
}

test("clears occupied pack data, resumes vanilla gameplay, reloads and retains the exact original snapshot", async ({ page }) => {
  const operations = await seed(page);
  const before = await stored(page);
  await convert(operations);
  await expect(operations.locator(".content-pack-card").getByRole("button", { name: "启用", exact: true })).toBeVisible();
  await expect(page.locator(".game-notice")).toContainText("已转回原版玩法");
  const after = await stored(page);
  expect(after.contentPacks).toEqual([]);
  expect(after.tray.iron_ingot).toBe(26);
  expect(after.tray.copper_ingot).toBe((before.tray.copper_ingot ?? 0) + 4);
  expect(after.tray.return_ore).toBeUndefined();
  expect(after.entities.some((entity: { buildingId?: string }) => entity.buildingId === "return_box")).toBe(false);
  expect(after.constructionQueue).toEqual([]);
  expect(after.handcraftQueue).toEqual([]);
  expect(after.blueprints[0].entities).toHaveLength(1);
  const shell = page.locator(".game-shell");
  await operations.getByLabel("关闭运营中心").click();
  await expect(shell).toHaveAttribute("data-simulation-worker", "active");
  await page.getByLabel("继续模拟", { exact: true }).click();
  await expect(shell).toHaveAttribute("data-simulation-paused", "false");
  if (durable) await expect.poll(async () => Number(await shell.getAttribute("data-runtime-recovery-sequence"))).toBeGreaterThan(0);
  await page.getByLabel("暂停模拟", { exact: true }).click();
  await page.reload();
  if (durable) await page.getByRole("button", { name: /继续游戏/ }).click();
  await expect(page.locator(".factory-canvas")).toBeVisible({ timeout: 60_000 });
  const reopened = await openPacks(page);
  await reopened.locator(".content-pack-card").getByRole("button", { name: "启用", exact: true }).click();
  const recovered = await page.evaluate(async () => {
    const storage = await import("/src/game/storage.ts");
    const summary = storage.getSaveSnapshotSummaries().find(snapshot => snapshot.reason.includes("转回原版前"));
    if (!summary?.valid) throw new Error("conversion snapshot unavailable after enabling the pack");
    const snapshot = await storage.loadSaveSnapshotFromPersistence(summary.id);
    return { iron: snapshot?.tray.iron_ingot, ore: snapshot?.tray.return_ore, remaining: snapshot?.entities.find(entity => entity.resourceId === "return_ore")?.resourceRemaining, custom: snapshot?.entities.find(entity => entity.buildingId === "return_box")?.outputs.iron_ingot };
  });
  expect(recovered).toEqual({ iron: 17, ore: 9, remaining: 59, custom: 7 });
  await page.reload();
  if (durable) await page.getByRole("button", { name: /继续游戏/ }).click();
  await expect(page.locator(".factory-canvas")).toBeVisible({ timeout: 60_000 });
  const recoveryOperations = await openPacks(page);
  await recoveryOperations.getByRole("tab", { name: "存档", exact: true }).click();
  const recoveryRow = recoveryOperations.locator(".save-snapshot-row").filter({ hasText: "转回原版前" });
  await recoveryRow.getByRole("button", { name: /^回滚到快照/ }).click();
  await expect(page.locator(".game-notice")).toContainText("已回滚到自动快照");
  const restored = await stored(page);
  expect(restored.tray.iron_ingot).toBe(17);
  expect(restored.tray.return_ore).toBe(9);
  expect(restored.entities.find((entity: { buildingId?: string }) => entity.buildingId === "return_box").outputs.iron_ingot).toBe(7);
});

test("cancel keeps every occupied pack record and requires explicit confirmation", async ({ page }) => {
  const operations = await seed(page);
  const before = await stored(page);
  await operations.getByRole("button", { name: "转回原版存档", exact: true }).click();
  const confirmation = operations.getByRole("group", { name: "转回原版存档确认" });
  await expect(confirmation).toContainText("全部内容包数据");
  await expect(confirmation.getByRole("button", { name: "确认转换并保存" })).toBeDisabled();
  await confirmation.getByRole("button", { name: "取消", exact: true }).click();
  expect((await stored(page)).tray).toEqual(before.tray);
  await expect(operations.locator(".content-pack-card").getByRole("button", { name: "停用", exact: true })).toBeVisible();
});

for (const failure of ["snapshot", "primary", "registry"] as const) {
  test(`${failure} failure retains all occupied content and the source configuration`, async ({ page }) => {
    if (failure === "registry") await page.addInitScript(() => {
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key === "dsp-idle-network.content-packs.v1" && JSON.parse(value).packs.return_pack?.enabled === false) throw new DOMException("injected registry failure", "QuotaExceededError");
        return setItem.call(this, key, value);
      };
    });
    else await page.route("**/src/game/storage.ts*", async route => {
      const response = await route.fetch();
      const source = await response.text();
      const marker = failure === "snapshot" ? /(async function saveGameSnapshotVerified\([\s\S]*?\)\s*\{)/ : /(function saveGameVerified\([\s\S]*?\)\s*\{)/;
      if (!marker.test(source)) throw new Error("conversion failure-injection boundary changed");
      const injected = failure === "snapshot" ? '$1 if (typeof sessionStorage !== "undefined" && sessionStorage.getItem("conversion-failure-active")) return null;' : '$1 if (typeof sessionStorage !== "undefined" && sessionStorage.getItem("conversion-failure-active")) return Promise.resolve({success:false,code:"quota",message:"injected primary failure"});';
      await route.fulfill({ response, body: source.replace(marker, injected) });
    });
    const operations = await seed(page);
    const before = await stored(page);
    await page.evaluate(() => sessionStorage.setItem("conversion-failure-active", "1"));
    await convert(operations);
    const expected = failure === "snapshot" ? "回滚快照保存失败" : failure === "primary" ? "injected primary failure" : "原主档和内容包已恢复";
    await expect(page.locator(".game-notice")).toContainText(expected);
    const after = await stored(page);
    expect(after.tray).toEqual(before.tray);
    expect(after.contentPacks).toEqual(before.contentPacks);
    expect(after.research).toEqual(before.research);
    expect(after.entities).toEqual(before.entities);
    await expect(operations.locator(".content-pack-card").getByRole("button", { name: "停用", exact: true })).toBeVisible();
  });
}

for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
  test(`conversion preview fits ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const operations = await seed(page);
    await operations.getByRole("button", { name: "转回原版存档", exact: true }).click();
    const confirmation = operations.getByRole("group", { name: "转回原版存档确认" });
    for (const theme of ["dark", "light"]) for (const scale of [0.8, 1, 1.25, 1.5, 2]) {
      await page.evaluate(({ theme, scale }) => { document.documentElement.dataset.theme = theme; document.documentElement.style.setProperty("--ui-font-scale", String(scale)); }, { theme, scale });
      await confirmation.scrollIntoViewIfNeeded();
      expect(await confirmation.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await confirmation.getByRole("button", { name: "确认转换并保存" }).scrollIntoViewIfNeeded();
      if (scale === 2) await page.screenshot({ path: info.outputPath(`conversion-${theme}-200.png`) });
    }
  });
}
