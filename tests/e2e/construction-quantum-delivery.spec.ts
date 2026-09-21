import { expect, test } from "@playwright/test";

async function waterFactory() {
  const engine = await import("/src/game/engine.ts");
  const content = await import("/src/game/content.ts");
  const s = engine.createPlayerInitialState();
  s.entities = []; s.belts = []; s.tray = { steel: 23, titanium_ingot: 8, refined_oil: 24, stone: 32, processor: 4 }; s.planetTrays.home = s.tray;
  s.research.completedTechIds = Object.values(content.TECHNOLOGIES).map(t => t.id);
  s.construction.geothermal_power_station = 0;
  s.constructionAutomation.quantumSourceEnabled = true;
  s.constructionAutomation.targetStock = { geothermal_power_station: 1 };
  s.quantumLogisticsNetwork.enabled = true; s.quantumLogisticsNetwork.inventory = { water: "1000000" };
  const base = { planetId: "home", position: { x: 0, y: 0 }, interactionLocked: false, inputs: {}, outputs: {}, progress: 0, utilization: 0, productionRate: 0, routingCursor: 0, machineCount: 1, minerCount: 0 } as const;
  s.entities.push(
    { ...base, id: "entity_1", kind: "machine", buildingId: "construction_center" },
    { ...base, id: "entity_2", kind: "station", buildingId: "interstellar_logistics_station", stationTier: 2, quantumMode: "quantum", stationRoutes: [], stationSlots: [{ itemId: "hydrogen", localMode: "storage", remoteMode: "demand", minimumLoad: 1, minStock: 0, maxStock: 0, priority: 2, routePolicy: "direct", warperBudget: 2 }] },
    { ...base, id: "entity_3", kind: "power", buildingId: "wind_turbine", machineCount: 10000 },
  );
  return s;
}

test("online Worker supplies stocked water despite an empty high-priority demand and matches main-thread simulation", async ({ page }) => {
  await page.goto("/");
  const initial = await page.evaluate(waterFactory);
  const result = await page.evaluate(async (state) => {
    const engine = await import("/src/game/engine.ts");
    const benchmark = await import("/src/game/benchmark.ts");
    const packs = await import("/src/game/contentPacks.ts");
    const registry = packs.createContentPackRuntimeSnapshot(packs.createContentPackRegistry());
    const worker = new Worker(new URL("/src/game/simulation.worker.ts", location.origin), { type: "module" });
    try {
      let final = state;
      let receipt: unknown;
      for (let second = 1; second <= 12; second += 1) {
        const response = await new Promise<{ state: typeof state; error?: string }>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("simulation Worker timeout")), 10000);
          worker.onmessage = event => { clearTimeout(timer); resolve(event.data); };
          worker.onerror = event => { clearTimeout(timer); reject(new Error(event.message)); };
          worker.postMessage({ id: second, ...(second === 1 ? { state, registry } : {}), simulationSeconds: 1, wallSeconds: 1, registryFingerprint: registry.fingerprint });
        });
        if (response.error || !response.state) throw new Error(String(response.error));
        final = response.state;
        if (second === 5) receipt = final.quantumLogisticsNetwork.runtimeFlow?.constructionDeliveries?.entity_1;
      }
      const runtime = engine.createPersistentSimulationRuntime(structuredClone(state));
      for (let second = 0; second < 12; second += 1) engine.advancePersistentSimulationRuntime(runtime, 1, 1);
      return { water: final.quantumLogisticsNetwork.inventory.water, built: final.construction.geothermal_power_station, receipt, workerHash: benchmark.hashGameState(final), mainHash: benchmark.hashGameState(runtime.state) };
    } finally { worker.terminate(); }
  }, initial);
  expect(result.water).toBe("999984");
  expect(result.built).toBe(1);
  expect(result.receipt).toMatchObject({ requested: { water: 16 }, delivered: { water: 16 } });
  expect(result.workerHash).toBe(result.mainHash);
});

for (const [layout, viewport] of Object.entries({ desktop: { width: 1440, height: 900 }, portrait: { width: 390, height: 844 }, landscape: { width: 844, height: 390 } })) {
  for (const scale of [0.8, 1, 1.25, 1.5]) {
    test(`construction delivery explanation fits ${layout} at ${scale * 100}%`, async ({ page }, testInfo) => {
      await page.goto("/");
      const state = await page.evaluate(waterFactory);
      state.entities.find(e => e.id === "entity_2")!.quantumMode = "legacy";
      state.settings.fontScale = scale;
      await page.addInitScript((seed) => {
        sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
        localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-09-22-v1.3.0");
        localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
        localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state: seed }));
      }, state);
      await page.reload();
      await expect(page.locator(".game-shell")).toBeVisible();
      await page.getByLabel("打开建筑制造中心", { exact: true }).click();
      await page.setViewportSize(viewport);
      const dialog = page.getByRole("dialog", { name: "建筑制造中心", exact: true });
      const delivery = dialog.getByLabel("量子配送状态");
      await expect(delivery).toBeVisible();
      await delivery.scrollIntoViewIfNeeded();
      await expect(delivery).toBeInViewport();
      await expect(delivery).toContainText("量子下载额度为零");
      await expect(delivery).toContainText("量子库水 100万");
      const geometry = await dialog.evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth, right: el.getBoundingClientRect().right, innerWidth: innerWidth }));
      expect(geometry.scroll).toBeLessThanOrEqual(geometry.width + 2);
      expect(geometry.right).toBeLessThanOrEqual(geometry.innerWidth + 2);
      await page.screenshot({ path: testInfo.outputPath(`construction-${layout}-${scale}.png`), fullPage: true });
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
    });
  }
}
