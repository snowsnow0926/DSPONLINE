import { expect, test, type Page } from "@playwright/test";

const pack = {
  formatVersion: 5, id: "feedback_pack", name: "玩家反馈测试包", version: "1.0.0",
  items: [{ id: "feedback_ore", name: "测试矿石" }],
  technologies: [{ id: "feedback_tech", name: "测试科技", costs: [{ itemId: "electromagnetic_matrix", amount: 3 }] }],
  resources: [{ itemId: "feedback_ore", extractorBuildingId: "mining_machine", planetIds: ["home"], reserve: 77 }],
};
const renderingErrors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  renderingErrors.set(page, errors);
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error" && /\[DSP runtime render error\]|Encountered two children with the same key/.test(message.text())) errors.push(message.text()); });
});
test.afterEach(async ({ page }) => expect(renderingErrors.get(page)).toEqual([]));

async function openPacks(page: Page, installed = false, stock = 0) {
  const durable = ["true", "1", "on"].includes((process.env.VITE_DURABLE_RUNTIME_RECOVERY ?? "").toLowerCase());
  await page.addInitScript(({ pack, installed, stock, durable }) => {
    if (!durable) sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-11-13-v1.3.13");
    localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
    if (sessionStorage.getItem("feedback-fixture-seeded")) return;
    sessionStorage.setItem("feedback-fixture-seeded", "1");
    if (installed) localStorage.setItem("dsp-idle-network.content-packs.v1", JSON.stringify({ version: 1, packs: { [pack.id]: { manifest: pack, enabled: true, installedAt: 1, updatedAt: 1 } } }));
    localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state: {
      version: 47, entities: installed ? [{ id: "content_vein_home_feedback_ore", kind: "vein", planetId: "home", resourceId: "feedback_ore", position: { x: -400, y: 0 }, inputs: {}, outputs: {}, minerCount: 0, resourceRemaining: 59, resourceCapacity: 77 }] : [], belts: [], tray: { iron_ingot: 17, ...(installed ? { feedback_ore: stock } : {}) }, construction: {}, paused: true,
      research: { completedTechIds: installed ? ["feedback_tech"] : [], selectedTechId: null, pausedTechId: null, queuedTechIds: [], progressByTech: {} },
      contentPacks: installed ? [{ id: pack.id, version: pack.version }] : [],
      settings: { autosaveIntervalSeconds: 0, simulationSpeed: 1, theme: "dark", resourceMode: "finite" },
    } }));
  }, { pack, installed, stock, durable });
  await page.route("**/api/**", route => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"isolated author feedback test"}' }));
  await page.goto("/");
  if (durable) await page.getByRole("button", { name: /继续游戏/ }).click();
  await expect(page.locator(".factory-canvas")).toBeVisible({ timeout: 60_000 });
  if (durable) {
    await expect(page.locator(".game-shell")).toHaveAttribute("data-runtime-recovery", "active");
  }
  return openPanel(page);
}
async function openPanel(page: Page) {
  if (await page.getByLabel("打开设置").isVisible()) await page.getByLabel("打开设置").click();
  else { await page.getByRole("button", { name: "更多工作区", exact: true }).click(); await page.getByRole("menuitem", { name: "设置", exact: true }).click(); }
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.getByRole("tab", { name: "内容包", exact: true }).click();
  return operations;
}
async function persisted(page: Page) {
  return page.evaluate(async () => {
    const store = await import("/src/game/localSaveStore.ts");
    const raw = await store.readPersistedLocalSaveValue("dsp-idle-network.save.v1");
    return raw ? JSON.parse(raw).state : null;
  });
}
async function beginRemoval(operations: Awaited<ReturnType<typeof openPanel>>) {
  await operations.getByRole("button", { name: "清理残留并移除", exact: true }).click();
  const confirmation = operations.getByRole("group", { name: "移除内容包确认" });
  await expect(confirmation.getByRole("button", { name: "确认清理并安全移除" })).toBeDisabled();
  await confirmation.getByRole("checkbox").check();
  await confirmation.getByRole("button", { name: "确认清理并安全移除" }).click();
}

async function verifyDurableRuntimeContinues(page: Page, operations: Awaited<ReturnType<typeof openPanel>>) {
  if (!["true", "1", "on"].includes((process.env.VITE_DURABLE_RUNTIME_RECOVERY ?? "").toLowerCase())) return;
  const shell = page.locator(".game-shell");
  const sequence = Number(await shell.getAttribute("data-runtime-recovery-sequence"));
  await operations.getByLabel("关闭运营中心").click();
  await expect(shell).toHaveAttribute("data-simulation-worker", "active");
  await page.getByLabel("继续模拟", { exact: true }).click();
  await expect(shell).toHaveAttribute("data-simulation-paused", "false");
  await expect.poll(async () => Number(await shell.getAttribute("data-runtime-recovery-sequence"))).toBeGreaterThan(sequence);
  await page.getByLabel("暂停模拟", { exact: true }).click();
  await expect(shell).toHaveAttribute("data-simulation-paused", "true");
  await expect(shell).toHaveAttribute("data-runtime-recovery", "active");
  await expect(page.locator(".game-notice")).not.toContainText("模拟 revision 与 durable recovery head 不一致");
}

test("safe rename rewrites the complete draft and creates a working compatible migration", async ({ page }) => {
  const operations = await openPacks(page);
  await operations.getByRole("button", { name: "载入晶体工业示例" }).click();
  await operations.getByLabel("物品与图标 1 新 ID", { exact: true }).fill("refined_crystal_ore");
  await operations.locator(".content-author-entry").first().getByRole("button", { name: "安全改名并更新引用" }).click();
  const draft = JSON.parse(await operations.getByLabel("内容包配置 JSON").inputValue());
  expect(draft.version).toBe("1.0.1");
  expect(draft.idMigrations).toEqual([{ kind: "items", from: "crystal_ore", to: "refined_crystal_ore" }]);
  expect(draft.resources[0].itemId).toBe("refined_crystal_ore");
  expect(draft.generators[0].fuelItemIds).toEqual(["refined_crystal_ore"]);
  await operations.getByRole("button", { name: "校验全部配置" }).click();
  await operations.getByRole("button", { name: "注册并启用", exact: true }).click();
  await expect(operations.locator(".content-pack-card")).toContainText("v1.0.1");
});

test("core item and belt overrides are editable without JSON and affect real manufacturing", async ({ page }) => {
  const operations = await openPacks(page);
  await operations.getByRole("button", { name: "新建空白包" }).click();
  await operations.getByLabel("编辑内容类别").selectOption("itemOverrides");
  await operations.getByRole("button", { name: "添加原版物品覆盖", exact: true }).click();
  await operations.getByLabel("原版物品覆盖 1 原版物品 ID", { exact: true }).selectOption("iron_ore");
  await operations.getByLabel("原版物品覆盖 1 名称", { exact: true }).fill("作者铁矿");
  await operations.getByLabel("编辑内容类别").selectOption("beltOverrides");
  await operations.getByRole("button", { name: "添加原版传送带覆盖", exact: true }).click();
  await operations.getByLabel("原版传送带覆盖 1 速度（件/秒）", { exact: true }).fill("17");
  await operations.getByLabel("原版传送带覆盖 1 成本（物品 ID:数量，逗号分隔）", { exact: true }).fill("iron_ingot:7");
  await operations.getByLabel("原版传送带覆盖 1 每批产量", { exact: true }).fill("2");
  await operations.getByLabel("原版传送带覆盖 1 解锁科技", { exact: true }).selectOption("__none");
  await operations.getByRole("button", { name: "校验全部配置" }).click();
  await operations.getByRole("button", { name: "注册并启用", exact: true }).click();
  await expect(operations.locator(".content-pack-card")).toContainText("我的内容包");
  await expect(operations.locator(".content-pack-card")).toContainText("原版物品/传送带覆盖 2");
  const result = await page.evaluate(async () => {
    const content = await import("/src/game/content.ts");
    const engine = await import("/src/game/engine.ts");
    const state = engine.createInitialState();
    state.tray.iron_ingot = 17;
    const crafted = engine.craftConstruction(state, "conveyor_belt_mk1", 1);
    return { name: content.ITEMS.iron_ore.name, speed: content.getBeltSpeed(1), iron: crafted.tray.iron_ingot, built: (crafted.construction.conveyor_belt_mk1 ?? 0) - (state.construction.conveyor_belt_mk1 ?? 0) };
  });
  expect(result).toEqual({ name: "作者铁矿", speed: 17, iron: 10, built: 2 });
});

test("cleans seeded resource and research records, persists the removal, and retains a usable snapshot and configuration", async ({ page }) => {
  const operations = await openPacks(page, true);
  await beginRemoval(operations);
  await expect(operations.locator(".content-pack-card")).toHaveCount(0);
  await expect(operations.getByText("已移除内容包配置备份（1）", { exact: true })).toBeVisible();
  const state = await persisted(page);
  expect(state.tray.iron_ingot).toBe(17);
  expect(state.contentPacks).toEqual([]);
  expect(state.research.completedTechIds).not.toContain("feedback_tech");
  expect(state.entities.some((entity: { resourceId?: string }) => entity.resourceId === "feedback_ore")).toBe(false);
  await verifyDurableRuntimeContinues(page, operations);
  await page.reload();
  if (["true", "1", "on"].includes((process.env.VITE_DURABLE_RUNTIME_RECOVERY ?? "").toLowerCase())) await page.getByRole("button", { name: /继续游戏/ }).click();
  await expect(page.locator(".factory-canvas")).toBeVisible({ timeout: 60_000 });
  const reopened = await openPanel(page);
  await reopened.getByText("已移除内容包配置备份（1）", { exact: true }).click();
  await reopened.getByRole("button", { name: "载入配置", exact: true }).click();
  await reopened.getByRole("button", { name: "注册并启用", exact: true }).click();
  await expect(reopened.locator(".content-pack-card")).toHaveCount(1);
  const backup = await page.evaluate(async () => {
    const storage = await import("/src/game/storage.ts");
    const snapshots = storage.getSaveSnapshotSummaries();
    const snapshot = snapshots.find(entry => entry.reason.includes("移除内容包前"));
    if (!snapshot) throw new Error("pre-removal snapshot missing");
    if (!snapshot.valid) throw new Error("snapshot summary did not recover after restoring the configuration");
    const old = await storage.loadSaveSnapshotFromPersistence(snapshot.id);
    return { valid: Boolean(old), iron: old?.tray.iron_ingot, technologies: old?.research.completedTechIds, remaining: old?.entities.find(entity => entity.resourceId === "feedback_ore")?.resourceRemaining };
  });
  expect(backup).toMatchObject({ valid: true, iron: 17, technologies: ["feedback_tech"], remaining: 59 });
});

test("keeps the cleanup confirmation disabled while real pack inventory remains", async ({ page }) => {
  const operations = await openPacks(page, true, 9);
  await operations.getByRole("button", { name: "清理残留并移除", exact: true }).click();
  const confirmation = operations.getByRole("group", { name: "移除内容包确认" });
  await confirmation.getByRole("checkbox").check();
  await expect(confirmation.getByRole("alert")).toContainText("库存记录");
  await expect(confirmation.getByRole("button", { name: "确认清理并安全移除" })).toBeDisabled();
  expect((await persisted(page)).tray.feedback_ore).toBe(9);
});

for (const failure of ["snapshot", "primary", "registry"] as const) {
  test(`${failure} failure preserves the pack and the original progress`, async ({ page }) => {
    if (failure === "registry") await page.addInitScript(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key === "dsp-idle-network.content-packs.v1" && !JSON.parse(value).packs.feedback_pack) throw new DOMException("injected registry failure", "QuotaExceededError");
        return original.call(this, key, value);
      };
    });
    else await page.route("**/src/game/storage.ts*", async route => {
      const response = await route.fetch();
      const source = await response.text();
      const marker = failure === "snapshot" ? /(async function saveGameSnapshotVerified\([\s\S]*?\)\s*\{)/ : /(function saveGameVerified\([\s\S]*?\)\s*\{)/;
      if (!marker.test(source)) throw new Error("failure-injection boundary changed");
      await route.fulfill({ response, body: source.replace(marker, failure === "snapshot" ? '$1 if (typeof sessionStorage !== "undefined" && sessionStorage.getItem("feedback-removal-started")) return null;' : '$1 if (typeof sessionStorage !== "undefined" && sessionStorage.getItem("feedback-removal-started")) return Promise.resolve({success:false,code:"quota",message:"injected primary failure"});') });
    });
    const operations = await openPacks(page, true);
    const before = await persisted(page);
    await page.evaluate(() => sessionStorage.setItem("feedback-removal-started", "1"));
    await beginRemoval(operations);
    const expected = failure === "snapshot" ? "回滚快照保存失败" : failure === "primary" ? "injected primary failure" : "原主档和内容包已恢复";
    await expect(page.locator(".game-notice")).toContainText(expected);
    await expect(operations.locator(".content-pack-card")).toHaveCount(1);
    const after = await persisted(page);
    expect(after.tray).toEqual(before.tray);
    expect(after.research).toEqual(before.research);
    expect(after.contentPacks).toEqual(before.contentPacks);
    expect(await page.evaluate(() => Boolean(JSON.parse(localStorage.getItem("dsp-idle-network.content-packs.v1")!).packs.feedback_pack))).toBe(true);
    if (failure === "registry") await verifyDurableRuntimeContinues(page, operations);
  });
}

for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
  test(`override author and cleanup preview fit ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const operations = await openPacks(page, true);
    await operations.getByRole("button", { name: "编辑配置", exact: true }).click();
    await operations.getByLabel("编辑内容类别").selectOption("beltOverrides");
    await operations.getByRole("button", { name: "添加原版传送带覆盖", exact: true }).click();
    for (const theme of ["dark", "light"]) for (const scale of [0.8, 1, 1.25, 1.5, 2]) {
      await page.evaluate(({ theme, scale }) => { document.documentElement.dataset.theme = theme; document.documentElement.style.setProperty("--ui-font-scale", String(scale)); }, { theme, scale });
      await operations.getByLabel("原版传送带覆盖 1 速度（件/秒）", { exact: true }).scrollIntoViewIfNeeded();
      expect(await operations.locator(".content-pack-manager").evaluate(element => element.scrollWidth <= element.clientWidth + 1), `${theme}/${scale}`).toBe(true);
      if (scale === 2) await page.screenshot({ path: testInfo.outputPath(`overrides-${theme}.png`) });
    }
    await operations.getByRole("button", { name: "清理残留并移除", exact: true }).click();
    const confirmation = operations.getByRole("group", { name: "移除内容包确认" });
    await confirmation.scrollIntoViewIfNeeded();
    expect(await confirmation.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("cleanup-light-200.png") });
  });
}
