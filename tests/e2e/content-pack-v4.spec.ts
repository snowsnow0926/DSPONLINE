import { expect, test, type Page } from "@playwright/test";

async function openAuthor(page: Page) {
  await page.addInitScript(() => {
    sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-11-13-v1.3.13");
    localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, done: true }));
    localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state: { version: 47, entities: [], belts: [], tray: { iron_ore: 42 }, construction: {}, paused: true, research: { completedTechIds: [], selectedTechId: null, progressByTech: {} }, settings: { autosaveIntervalSeconds: 0, simulationSpeed: 1, theme: "dark" } } }));
  });
  await page.route("**/api/**", (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"isolated v4 test"}' }));
  await page.goto("/");
  await expect(page.locator(".factory-canvas")).toBeVisible({ timeout: 30_000 });
  if (await page.getByLabel("打开设置").isVisible()) await page.getByLabel("打开设置").click();
  else { await page.getByRole("button", { name: "更多工作区", exact: true }).click(); await page.getByRole("menuitem", { name: "设置", exact: true }).click(); }
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.getByRole("tab", { name: "内容包", exact: true }).click();
  await operations.getByRole("button", { name: "载入晶体工业示例" }).click();
  return operations;
}

test("authors, validates and registers a v4 pack with embedded icon without editing JSON", async ({ page }) => {
  const operations = await openAuthor(page);
  await operations.getByLabel("编辑内容类别").selectOption("technologyEffects");
  await operations.getByLabel("科技实际加成 1 生产速度倍率", { exact: true }).fill("2.5");
  await operations.getByLabel("编辑内容类别").selectOption("items");
  await operations.getByLabel("导入第 1 项图标").setInputFiles({ name: "icon.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT+4AAAAASUVORK5CYII=", "base64") });
  await expect(operations.getByAltText("图标预览")).toBeVisible();
  await operations.getByRole("button", { name: "校验全部配置" }).click();
  await operations.getByRole("button", { name: "注册并启用", exact: true }).click();
  await expect(operations.locator(".content-pack-card")).toContainText("晶体工业示例");
  const pack = await page.evaluate(() => JSON.parse(localStorage.getItem("dsp-idle-network.content-packs.v1")!).packs.crystal_industry.manifest);
  expect(pack.technologyEffects[0].productionSpeed).toBe(2.5);
  expect(pack.items[0].icon).toMatch(/^data:image\/png;base64,/);
  expect(pack.resources[0].extractorBuildingId).toBe("crystal_drill");
});

test("v4 rules match main thread, realtime Worker and offline Worker", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const engine = await import("/src/game/engine.ts");
    const packs = await import("/src/game/contentPacks.ts");
    const mods = await import("/src/game/mods.ts");
    const example = await import("/src/components/ContentPackAuthor.tsx");
    const offline = await import("/src/game/offlineSimulation.ts");
    const registry = packs.registerContentPack(packs.createContentPackRegistry(), mods.validateContentPack(example.createExampleContentPack())).registry;
    const snapshot = packs.createContentPackRuntimeSnapshot(registry);
    packs.applyContentPackRuntimeSnapshot(snapshot);
    let initial = engine.createInitialState();
    initial.research.completedTechIds.push("crystal_efficiency");
    const vein = initial.entities.find((entity) => entity.resourceId === "crystal_ore")!;
    initial.construction.crystal_drill = 1;
    initial.construction.crystal_generator = 1;
    initial = engine.installMiner(initial, vein.id);
    initial = engine.placeBuilding(initial, "crystal_generator", { x: vein.position.x + 50, y: vein.position.y });
    const generator = initial.entities.find((entity) => entity.buildingId === "crystal_generator")!;
    initial = engine.setFuelItem(initial, generator.id, "crystal_ore");
    initial.entities.find((entity) => entity.id === generator.id)!.inputs.crystal_ore = 100;
    const main = engine.advanceSimulation(structuredClone(initial), 10);
    const worker = new Worker(new URL("/src/game/simulation.worker.ts", location.origin), { type: "module" });
    const realtime = await new Promise<typeof initial>((resolve, reject) => {
      const timer = setTimeout(() => { worker.terminate(); reject(new Error("v4 Worker timeout")); }, 10000);
      worker.onmessage = (event) => { clearTimeout(timer); worker.terminate(); event.data.state ? resolve(event.data.state) : reject(new Error(event.data.registryError ?? "missing state")); };
      worker.postMessage({ id: 1, state: structuredClone(initial), simulationSeconds: 10, wallSeconds: 10, registryFingerprint: snapshot.fingerprint, registry: snapshot });
    });
    const settled = await offline.runOfflineSimulationInWorker(structuredClone(initial), 10, { registry: snapshot });
    const view = (state: typeof initial) => ({ entities: state.entities, produced: state.totalProduced, metrics: state.metrics });
    return { main: view(main), realtime: view(realtime), offline: view(settled), produced: main.totalProduced.crystal_ore };
  });
  expect(result.realtime).toEqual(result.main);
  expect(result.offline).toEqual(result.main);
  expect(result.produced).toBeGreaterThan(0);
});

for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
  test(`v4 author layout ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const operations = await openAuthor(page);
    await operations.getByLabel("编辑内容类别").selectOption("technologyEffects");
    const field = operations.getByLabel("科技实际加成 1 生产速度倍率", { exact: true });
    for (const theme of ["dark", "light"]) for (const scale of [0.8, 1, 1.25, 1.5, 2]) {
      await page.evaluate(({ theme, scale }) => { document.documentElement.dataset.theme = theme; document.documentElement.style.setProperty("--ui-font-scale", String(scale)); }, { theme, scale });
      await field.scrollIntoViewIfNeeded();
      await expect(field).toBeInViewport();
      expect(await operations.locator(".content-pack-manager").evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      if (scale === 2) await page.screenshot({ path: testInfo.outputPath(`author-${theme}.png`) });
    }
  });
}
