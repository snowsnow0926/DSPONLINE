import { expect, test, type Page } from "@playwright/test";

const basePack = {
  formatVersion: 3, id: "ui_rules_pack", name: "合金规则包", version: "1.0.0",
  items: [{ id: "ui_rules_alloy", name: "保留合金" }],
  recipes: [{ id: "ui_rules_recipe", name: "保留合金", buildingId: "assembling_machine_mk1", duration: 2, inputs: [{ itemId: "iron_ingot", amount: 1 }], outputs: [{ itemId: "ui_rules_alloy", amount: 1 }] }],
  technologies: [{ id: "ui_rules_tech", name: "合金学", costs: [{ itemId: "electromagnetic_matrix", amount: 2 }] }],
};

async function openPacks(page: Page, installed = false) {
  await page.addInitScript(({ pack, installed }) => {
    sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-11-05-v1.3.8");
    localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
    if (installed && !localStorage.getItem("dsp-idle-network.content-packs.v1")) localStorage.setItem("dsp-idle-network.content-packs.v1", JSON.stringify({ version: 1, packs: { [pack.id]: { manifest: pack, enabled: true, installedAt: 1, updatedAt: 1 } } }));
    if (!localStorage.getItem("dsp-idle-network.save.v1")) localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state: {
      version: 46, entities: [], belts: [], tray: { iron_ore: 42, ...(installed ? { ui_rules_alloy: 57 } : {}) }, construction: {}, paused: true,
      contentPacks: installed ? [{ id: pack.id, version: pack.version }] : [],
      research: { completedTechIds: installed ? ["ui_rules_tech"] : [], selectedTechId: null, progressByTech: {} },
      settings: { autosaveIntervalSeconds: 0, simulationSpeed: 1, theme: "dark" },
    } }));
  }, { pack: basePack, installed });
  await page.route("**/api/**", (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"isolated content pack test"}' }));
  await page.goto("/");
  await expect(page.locator(".factory-canvas")).toBeVisible({ timeout: 30_000 });
  if (await page.getByLabel("打开设置").isVisible()) await page.getByLabel("打开设置").click();
  else {
    await page.getByRole("button", { name: "更多工作区", exact: true }).click();
    await page.getByRole("menuitem", { name: "设置", exact: true }).click();
  }
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.getByRole("tab", { name: "内容包", exact: true }).click();
  return operations;
}

test("updates an in-use content pack, edits handcraft/technology rules and keeps the old save readable", async ({ page }) => {
  const operations = await openPacks(page, true);
  const next = { ...basePack, version: "1.1.0" };
  await operations.getByLabel("选择要注册的内容包").setInputFiles({ name: "upgrade.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(next)) });
  await expect(operations.getByRole("status").filter({ hasText: "兼容更新" })).toBeVisible();
  await operations.getByText("配方手合与科技配置", { exact: true }).click();
  await operations.getByLabel("ui_rules_recipe允许手合").uncheck();
  await operations.getByLabel("ui_rules_recipe解锁科技").selectOption("ui_rules_tech");
  await operations.getByRole("button", { name: "兼容更新并启用", exact: true }).click();
  await expect(operations.locator(".content-pack-card")).toContainText("v1.1.0");
  await expect(operations.locator(".content-pack-card")).toContainText("可读取旧版存档：1.0.0");
  const registry = await page.evaluate(() => JSON.parse(localStorage.getItem("dsp-idle-network.content-packs.v1")!));
  expect(registry.packs.ui_rules_pack.manifest.recipes[0]).toMatchObject({ handcraftable: false, requiredTechId: "ui_rules_tech" });
  expect(registry.packs.ui_rules_pack.previousManifests[0].version).toBe("1.0.0");
  const preserved = await page.evaluate(async () => {
    const storage = await import("/src/game/storage.ts");
    const old = localStorage.getItem("dsp-idle-network.save.v1")!;
    const inspection = storage.inspectSave(old);
    return { valid: inspection.valid, amount: inspection.state?.tray["ui_rules_alloy" as never], technologies: inspection.state?.research.completedTechIds };
  });
  expect(preserved).toMatchObject({ valid: true, amount: 57, technologies: ["ui_rules_tech"] });
});

test("refuses a destructive update with an actionable reason and no registry change", async ({ page }) => {
  const operations = await openPacks(page, true);
  await operations.getByLabel("选择要注册的内容包").setInputFiles({ name: "bad-update.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ ...basePack, version: "1.1.0", items: [], recipes: [] })) });
  await expect(operations.getByRole("button", { name: "兼容更新并启用" })).toBeDisabled();
  await expect(operations.locator(".content-pack-update-preview")).toContainText("不能删除或重命名");
  const version = await page.evaluate(() => JSON.parse(localStorage.getItem("dsp-idle-network.content-packs.v1")!).packs.ui_rules_pack.manifest.version);
  expect(version).toBe("1.0.0");
});

test("v3 rules preserve queued work equally in realtime and offline Workers", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const engine = await import("/src/game/engine.ts");
    const packs = await import("/src/game/contentPacks.ts");
    const mods = await import("/src/game/mods.ts");
    const offline = await import("/src/game/offlineSimulation.ts");
    const registry = packs.registerContentPack(packs.createContentPackRegistry(), mods.validateContentPack({
      formatVersion: 3, id: "worker_handcraft_rules", name: "Worker handcraft rules", version: "1.0.0",
      recipeOverrides: [{ id: "gear", handcraftable: false }],
    })).registry;
    const snapshot = packs.createContentPackRuntimeSnapshot(registry);
    packs.applyContentPackRuntimeSnapshot(snapshot);
    const initial = engine.createInitialState();
    initial.tray.iron_ingot = 19;
    initial.handcraftQueue = [{ id: "paid", recipeId: "gear", planetId: "home", batchesTotal: 2, batchesRemaining: 2, progress: 0.5, queuedAt: 0 }];
    const main = engine.advanceSimulation(structuredClone(initial), 2);
    const worker = new Worker(new URL("/src/game/simulation.worker.ts", location.origin), { type: "module" });
    const realtime = await new Promise<typeof initial>((resolve, reject) => {
      const timer = setTimeout(() => { worker.terminate(); reject(new Error("v3 Worker timeout")); }, 10000);
      worker.onmessage = (event) => {
        clearTimeout(timer); worker.terminate();
        if (event.data.state) resolve(event.data.state); else reject(new Error(event.data.registryError ?? "missing state"));
      };
      worker.postMessage({ id: 1, state: structuredClone(initial), simulationSeconds: 2, wallSeconds: 2, registryFingerprint: snapshot.fingerprint, registry: snapshot });
    });
    const settled = await offline.runOfflineSimulationInWorker(structuredClone(initial), 2, { registry: snapshot });
    const view = (state: typeof initial) => ({ tray: state.tray, queue: state.handcraftQueue, elapsed: state.elapsedSeconds });
    return { main: view(main), realtime: view(realtime), offline: view(settled) };
  });
  expect(result.realtime).toEqual(result.main);
  expect(result.offline).toEqual(result.main);
  expect(result.main.queue[0].batchesRemaining).toBe(1);
  expect(result.main.tray.iron_ingot).toBe(19);
  expect(result.main.tray.gear).toBe(1);
});

for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
  test(`content pack editor fits ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const operations = await openPacks(page, true);
    await operations.getByRole("button", { name: "编辑配置", exact: true }).click();
    await expect(operations.getByLabel("内容包配置 JSON")).toBeVisible();
    await operations.getByRole("button", { name: "校验配置", exact: true }).click();
    await operations.getByText("配方手合与科技配置", { exact: true }).click();
    await expect(operations.getByLabel("ui_rules_recipe允许手合")).toBeVisible();
    for (const theme of ["dark", "light"]) for (const scale of [0.8, 1, 1.25, 1.5, 2]) {
      await page.evaluate(({ theme, scale }) => { document.documentElement.dataset.theme = theme; document.documentElement.style.setProperty("--ui-font-scale", String(scale)); }, { theme, scale });
      await operations.getByLabel("ui_rules_recipe允许手合").scrollIntoViewIfNeeded();
      await expect(operations.getByLabel("ui_rules_recipe解锁科技")).toBeInViewport();
      expect(await operations.locator(".content-pack-manager").evaluate((element) => element.scrollWidth <= element.clientWidth + 1), `${theme} ${scale}`).toBe(true);
      if (scale === 1 || scale === 2) await page.screenshot({ path: testInfo.outputPath(`content-pack-${theme}-${scale}.png`) });
    }
  });
}
