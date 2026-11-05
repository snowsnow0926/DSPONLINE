import { expect, test, type Page } from "@playwright/test";
import { workflowTimeoutMs } from "./startup-timeout";
import { createInitialState, placeBuilding } from "../../src/game/engine";

const RELEASE_NOTE_ID = "2026-08-14-v1.0.42";
const PUBLIC_ID = `station_${"a".repeat(32)}`;

async function installOperationalStationSave(page: Page, options: { withTerminalContract?: boolean } = {}) {
  await page.addInitScript(({ releaseNoteId, withTerminalContract }) => {
    const now = Date.now();
    const taskDay = Math.floor((now + 8 * 60 * 60 * 1_000) / (24 * 60 * 60 * 1_000));
    const orbitalStation = {
      stateVersion: 1,
      status: "operational",
      construction: {
        costRevision: 1,
        stageRequirements: [
          {
            stageId: "core",
            costs: [
              { itemId: "titanium_alloy", amount: "200000" },
              { itemId: "frame_material", amount: "100000" },
              { itemId: "processor", amount: "200000" },
              { itemId: "universe_matrix", amount: "20000" },
            ],
            fleetCosts: {},
            delivered: { titanium_alloy: "200000", frame_material: "100000", processor: "200000", universe_matrix: "20000" },
            deliveredFleet: {},
          },
          {
            stageId: "dock",
            costs: [
              { itemId: "quantum_chip", amount: "100000" },
              { itemId: "particle_container", amount: "200000" },
              { itemId: "space_warper", amount: "20000" },
            ],
            fleetCosts: { logistics_vessel: 200 },
            delivered: { quantum_chip: "100000", particle_container: "200000", space_warper: "20000" },
            deliveredFleet: { logistics_vessel: 200 },
          },
          {
            stageId: "showcase",
            costs: [
              { itemId: "titanium_glass", amount: "300000" },
              { itemId: "particle_broadband", amount: "200000" },
              { itemId: "plastic", amount: "500000" },
              { itemId: "universe_matrix", amount: "50000" },
            ],
            fleetCosts: {},
            delivered: { titanium_glass: "300000", particle_broadband: "200000", plastic: "500000", universe_matrix: "50000" },
            deliveredFleet: {},
          },
        ],
      },
      viewport: { x: 195, y: 120, zoom: 0.72 },
      contractBoard: {
        rulesVersion: 1,
        taskDay,
        lastConfirmedWallClockMs: now,
        offers: [],
        accepted: withTerminalContract ? [{
          id: "e2e-terminal-contract",
          templateId: "origin",
          slot: 0,
          title: "原产处理器订单",
          summary: "指定来源终端，也可由量子库存手动交付。",
          taskDay,
          expiresAtTaskDay: taskDay + 3,
          special: false,
          difficulty: "P1",
          status: "accepted",
          acceptedAtTaskDay: taskDay,
          requirements: [{ itemId: "processor", amount: "100", delivered: "0", sourcePlanetIds: ["home"], channel: "terminal", weight: 3 }],
          rewards: { baseMarks: "10", baseReputation: "10", completionMarks: "5", completionReputation: "5" },
        }] : [],
        history: [],
        settledIds: [],
        featuredContractId: null,
      },
      economy: {
        orbitalMarks: "10000",
        stationReputation: "5000",
        unlockedDecorationIds: ["cargo_crate", "service_robot", "theme:nebula_violet"],
      },
      layout: {
        themeId: "nebula_violet",
        placements: [{ id: "station_test_crate", decorationId: "cargo_crate", x: 0, y: 0, rotation: 0, layer: 1, variant: 0 }],
        featuredAchievementIds: ["first_manual_mine"],
      },
      profile: {
        title: "白糖轨道港",
        motto: "让每一条生产线通向群星。",
        featuredMetricKeys: ["total-generation", "universe-matrix-produced"],
      },
      totals: { completedContracts: 12, exportedByItem: { processor: "24000" } },
    };
    const state = {
      version: 47,
      mode: "normal",
      nextId: 100,
      activePlanetId: "home",
      entities: [],
      belts: [],
      construction: { orbital_cargo_terminal: 1 },
      tray: {},
      planetTrays: { home: {} },
      portableFleet: { logistics_drone: 0, logistics_vessel: 0 },
      totalProduced: {
        titanium_alloy: 1,
        processor: 1,
        particle_container: 1,
        titanium_glass: 1,
        particle_broadband: 1,
        plastic: 1,
        space_warper: 1,
        frame_material: 1,
        solar_sail: 1,
        small_carrier_rocket: 1,
        quantum_chip: 1,
        antimatter_fuel_rod: 1,
        universe_matrix: 100,
      },
      research: {
        selectedTechId: null,
        pausedTechId: null,
        queuedTechIds: [],
        progressByTech: {},
        completedTechIds: [
          "electromagnetism", "basic_smelting", "basic_assembling", "basic_logistics",
          "titanium_alloy", "processor", "miniature_particle_collider", "information_matrix",
          "basic_chemical_engineering", "space_warp", "dyson_sphere_program", "dyson_swarm",
          "vertical_launching_silo", "quantum_chip", "artificial_star", "universe_matrix",
        ],
      },
      exploration: { unlockedSystemIds: ["helios"], colonizedPlanetIds: ["home"], surveyProgressBySystem: { helios: 1 }, missions: [] },
      quantumLogisticsNetwork: {
        enabled: true,
        inventory: { processor: "5000", universe_matrix: "5000" },
        routingCursors: {},
        itemCapacities: {},
        uploadRoutingCursors: {},
      },
      achievements: { unlockedIds: ["first_manual_mine"], progress: {} },
      orbitalStation,
      settings: { theme: "dark", fontScale: 1, simulationSpeed: 1, autosaveIntervalSeconds: 120, resourceMode: "finite" },
      paused: true,
      contentPacks: [],
    };
    sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    localStorage.setItem("dsp-idle-network.release-notes.seen.v1", releaseNoteId);
    localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
    localStorage.setItem("dsp-idle-network.onboarding.v1", "dismissed");
    localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: now, state }));
  }, { releaseNoteId: RELEASE_NOTE_ID, withTerminalContract: options.withTerminalContract ?? false });
}

async function openDesktopStation(page: Page, viewport = { width: 1366, height: 768 }) {
  await page.setViewportSize(viewport);
  await installOperationalStationSave(page);
  await page.goto("/");
  await expect(page.locator(".game-shell")).toBeVisible();
  const entry = page.getByRole("button", { name: /打开全星系空间站/ });
  await expect(entry).toBeVisible();
  await entry.click();
  const workspace = page.getByRole("dialog", { name: "全星系空间站" });
  await expect(workspace).toBeVisible();
  return workspace;
}

async function installInteractiveFactoryWithOperationalStation(page: Page) {
  let state = createInitialState(47_146, false);
  state.paused = true;
  state.construction.storage_mk1 = 2;
  state.construction.conveyor_belt_mk1 = 20;
  state = placeBuilding(state, "storage_mk1", { x: -180, y: -60 });
  state = placeBuilding(state, "storage_mk1", { x: 180, y: -60 });
  const storage = state.entities.filter((entity) => entity.buildingId === "storage_mk1");
  if (storage.length !== 2) throw new Error("interactive station fixture placement failed");
  storage[0].storedItemId = "iron_ore";
  storage[0].outputs.iron_ore = 100;
  storage[1].storedItemId = "iron_ore";
  state.orbitalStation = {
    ...state.orbitalStation,
    status: "operational",
    construction: {
      ...state.orbitalStation.construction,
      stageRequirements: state.orbitalStation.construction.stageRequirements.map((stage) => ({
        ...stage,
        delivered: Object.fromEntries(stage.costs.map((cost) => [cost.itemId, cost.amount])),
        deliveredFleet: { ...stage.fleetCosts },
      })),
    },
    economy: {
      ...state.orbitalStation.economy,
      stationReputation: "5000",
    },
  };
  const entityIds = storage.map((entity) => entity.id);
  const raw = JSON.stringify({ savedAt: Date.now(), state });
  await page.addInitScript(({ releaseNoteId, save }) => {
    sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    localStorage.setItem("dsp-idle-network.release-notes.seen.v1", releaseNoteId);
    localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
    localStorage.setItem("dsp-idle-network.save.v1", save);
  }, { releaseNoteId: RELEASE_NOTE_ID, save: raw });
  await page.goto("/");
  await expect(page.locator(".game-shell")).toBeVisible();
  await page.locator(".factory-canvas .react-flow__controls-fitview").click();
  for (const entityId of entityIds) {
    await expect(page.locator(`.factory-canvas .react-flow__node[data-id="${entityId}"]`)).toBeVisible();
  }
  return entityIds;
}

async function expectContained(page: Page, selector: string) {
  await expect.poll(() => page.locator(selector).evaluate((element) => ({
    own: element.scrollWidth <= element.clientWidth + 1,
    document: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
  }))).toEqual({ own: true, document: true });
}

async function selectFixtureDecoration(workspace: ReturnType<Page["getByRole"]>) {
  await workspace.locator(".react-flow__controls-fitview").click();
  const decoration = workspace.locator(".station-decoration-node").first();
  await expect(decoration).toBeInViewport();
  await decoration.click();
}

test("desktop station entry, contracts, decoration editor and factory return form one closed loop", async ({ page }) => {
  const workspace = await openDesktopStation(page);
  await expect(workspace.getByText("白糖轨道港", { exact: true })).toBeVisible();
  await expect(workspace.locator(".station-canvas-renderer")).toBeVisible();

  await workspace.getByRole("button", { name: /出口合同/ }).click();
  await expect(workspace.locator(".station-contract-grid > article")).toHaveCount(4);
  await expect(workspace.getByText("0/3 已接受")).toBeVisible();

  await workspace.getByRole("button", { name: /装饰收藏/ }).click();
  await workspace.getByRole("button", { name: "进入编辑模式" }).click();
  await selectFixtureDecoration(workspace);
  const decorationEditor = workspace.locator(".station-decoration-editor");
  const decoration = workspace.locator(".station-decoration-node").first();
  await expect(decorationEditor).toContainText("标准货柜组");
  const decorationTransformBefore = await decoration.evaluate((element) => getComputedStyle(element).transform);
  const decorationBox = await decoration.boundingBox();
  if (!decorationBox) throw new Error("station decoration has no drag geometry");
  await page.mouse.move(decorationBox.x + decorationBox.width / 2, decorationBox.y + decorationBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(decorationBox.x + decorationBox.width / 2 + 34, decorationBox.y + decorationBox.height / 2 + 22, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => decoration.evaluate((element) => getComputedStyle(element).transform)).not.toBe(decorationTransformBefore);
  await expect(decorationEditor).not.toContainText("位置 0, 0");
  await workspace.getByRole("button", { name: "切换层级" }).click();
  await expect(decorationEditor).toContainText("层级 2");
  await workspace.getByRole("button", { name: "切换样式" }).click();
  await expectContained(page, ".orbital-station-workspace");

  const returnEntry = page.locator(".orbital-station-entry");
  await expect(returnEntry).toBeVisible();
  await returnEntry.click();
  await expect(workspace).toHaveCount(0);
  await expect(page.locator(".factory-canvas")).toBeVisible();
});

test("ordinary source-restricted contracts can be completed from confirmed quantum inventory", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await installOperationalStationSave(page, { withTerminalContract: true });
  await page.goto("/");
  await expect(page.locator(".game-shell")).toBeVisible();
  await page.getByRole("button", { name: /打开全星系空间站/ }).click();
  const workspace = page.getByRole("dialog", { name: "全星系空间站" });
  await workspace.getByRole("button", { name: /出口合同/ }).click();

  const contract = workspace.locator(".station-accepted-contracts > article").filter({ hasText: "原产处理器订单" });
  await expect(contract).toBeVisible();
  const quantumDelivery = contract.getByRole("button", { name: "量子交付" });
  await expect(quantumDelivery).toBeEnabled();
  await quantumDelivery.click();
  const prompt = page.getByRole("alertdialog", { name: "量子库存手动交付" });
  await expect(prompt).toContainText("可交付上限 100 件");
  await prompt.getByRole("button", { name: "预览交付" }).click();
  const confirmation = page.getByRole("alertdialog", { name: "确认量子交付" });
  await expect(confirmation).toContainText("处理器 100 件");
  await confirmation.getByRole("button", { name: "确认交付" }).click();

  await expect(contract).toContainText("100 / 100");
  await expect(contract.getByRole("button", { name: "领取完成奖励" })).toBeEnabled();
});

test("returning from the station canvas preserves factory drag, selection, and connection interaction", async ({ page }) => {
  test.setTimeout(workflowTimeoutMs(90_000));
  const pageErrors: string[] = [];
  const reactFlowWarnings: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "warning" && message.text().includes("React Flow")) reactFlowWarnings.push(message.text());
  });
  const entityIds = await installInteractiveFactoryWithOperationalStation(page);
  const factoryCanvas = page.locator(".factory-canvas");

  for (let cycle = 0; cycle < 8; cycle += 1) {
    const factoryViewportBefore = await factoryCanvas.locator(".react-flow__viewport").evaluate((element) => getComputedStyle(element).transform);
    await page.getByRole("button", { name: /打开全星系空间站/ }).click();
    const workspace = page.getByRole("dialog", { name: "全星系空间站" });
    await expect(workspace.locator(".station-canvas-renderer .react-flow")).toBeVisible();
    await expect(workspace.locator('.react-flow__node[data-id^="module:"]')).toHaveCount(6);
    const stationViewport = workspace.locator(".station-canvas-renderer .react-flow__viewport");
    const stationViewportBefore = await stationViewport.evaluate((element) => getComputedStyle(element).transform);
    const zoomIn = workspace.locator(".station-canvas-renderer .react-flow__controls-zoomin");
    const zoomControl = await zoomIn.isEnabled()
      ? zoomIn
      : workspace.locator(".station-canvas-renderer .react-flow__controls-zoomout");
    await zoomControl.click();
    await expect.poll(() => stationViewport.evaluate((element) => getComputedStyle(element).transform)).not.toBe(stationViewportBefore);
    await page.locator(".orbital-station-entry").click();
    await expect(workspace).toHaveCount(0);
    await expect(factoryCanvas).not.toHaveAttribute("inert", "");
    await expect.poll(() => factoryCanvas.locator(".react-flow__viewport").evaluate((element) => getComputedStyle(element).transform)).toBe(factoryViewportBefore);
    for (const entityId of entityIds) {
      await expect(factoryCanvas.locator(`.react-flow__node[data-id="${entityId}"]`)).toBeVisible();
    }
  }

  const sourceNode = factoryCanvas.locator(`.react-flow__node[data-id="${entityIds[0]}"]`);
  const beforeDragTransform = await sourceNode.evaluate((element) => getComputedStyle(element).transform);
  const dragStopsBefore = Number(await factoryCanvas.getAttribute("data-drag-stop-count") ?? 0);
  const dragHeader = await sourceNode.locator(".factory-node__header").boundingBox();
  if (!dragHeader) throw new Error("factory source node has no drag geometry after station return");
  await page.mouse.move(dragHeader.x + dragHeader.width / 2, dragHeader.y + dragHeader.height / 2);
  await page.mouse.down();
  await page.mouse.move(dragHeader.x + dragHeader.width / 2 + 64, dragHeader.y + dragHeader.height / 2 + 32, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => Number(await factoryCanvas.getAttribute("data-drag-stop-count") ?? 0)).toBeGreaterThan(dragStopsBefore);
  await expect.poll(() => sourceNode.evaluate((element) => getComputedStyle(element).transform)).not.toBe(beforeDragTransform);

  await page.getByLabel("框选模式").click();
  const nodeBoxes = await Promise.all(entityIds.map((entityId) => factoryCanvas.locator(`.react-flow__node[data-id="${entityId}"]`).boundingBox()));
  if (nodeBoxes.some((box) => !box)) throw new Error("factory nodes have no selection geometry after station return");
  const boxes = nodeBoxes as NonNullable<(typeof nodeBoxes)[number]>[];
  const left = Math.min(...boxes.map((box) => box.x)) - 20;
  const top = Math.min(...boxes.map((box) => box.y)) - 20;
  const right = Math.max(...boxes.map((box) => box.x + box.width)) + 20;
  const bottom = Math.max(...boxes.map((box) => box.y + box.height)) + 20;
  // Start in the empty lower-right margin and drag back over the cards. This
  // mirrors the player's reverse box-select gesture without beginning on a
  // resource vein or a card handle from the generated starter planet.
  await page.mouse.move(right, bottom);
  await page.mouse.down();
  await page.mouse.move(left, top, { steps: 8 });
  await page.mouse.up();
  await expect(factoryCanvas.locator(".react-flow__node.selected")).toHaveCount(2);
  await page.getByLabel("指针模式").click();

  await sourceNode.locator(".factory-handle--output").first().click({ force: true });
  await factoryCanvas.locator(`.react-flow__node[data-id="${entityIds[1]}"] .factory-handle--input`).first().click({ force: true });
  await expect(factoryCanvas.locator(".react-flow__edge")).toHaveCount(1);

  await page.getByTitle("部署制造台 Mk.I", { exact: true }).click();
  const placementPoint = await page.evaluate(() => {
    const pane = document.querySelector<HTMLElement>(".factory-canvas .react-flow__pane");
    if (!pane) return null;
    const rect = pane.getBoundingClientRect();
    for (let y = rect.top + 150; y < rect.bottom - 180; y += 35) {
      for (let x = rect.left + 170; x < rect.right - 300; x += 45) {
        const target = document.elementFromPoint(x, y);
        if (target instanceof Element && target.closest(".react-flow__pane") && !target.closest(".react-flow__minimap, .react-flow__controls, .react-flow__node")) return { x, y };
      }
    }
    return null;
  });
  expect(placementPoint).not.toBeNull();
  await page.mouse.click(placementPoint!.x, placementPoint!.y);
  const placedNode = factoryCanvas.locator(".react-flow__node:has(.machine-node)");
  await expect(placedNode).toHaveCount(1);
  const placedBox = await placedNode.boundingBox();
  if (!placedBox) throw new Error("factory placement has no geometry after station return");
  expect(Math.abs(placedBox.x - placementPoint!.x)).toBeLessThanOrEqual(24);
  expect(Math.abs(placedBox.y - placementPoint!.y)).toBeLessThanOrEqual(24);
  expect(pageErrors).toEqual([]);
  expect(reactFlowWarnings).toEqual([]);
});

test("station workspace stays contained at both required desktop viewports", async ({ page }) => {
  test.setTimeout(workflowTimeoutMs(90_000));
  await installOperationalStationSave(page);
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto("/");
  await expect(page.locator(".game-shell")).toBeVisible();
  for (const viewport of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(viewport);
    await page.getByRole("button", { name: /打开全星系空间站/ }).click();
    const workspace = page.getByRole("dialog", { name: "全星系空间站" });
    await expect(workspace).toBeVisible();
    await expectContained(page, ".orbital-station-workspace");
    await page.screenshot({ path: `artifacts/qa/orbital-station-${viewport.width}x${viewport.height}.png`, fullPage: true });
    await workspace.getByRole("button", { name: "返回工厂画布", exact: true }).click();
    await expect(workspace).toHaveCount(0);
  }
});

test("next mobile shell reaches the station and unwinds decoration detail before the factory", async ({ page }) => {
  test.setTimeout(workflowTimeoutMs(90_000));
  await installOperationalStationSave(page);
  for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await page.goto("/?mobileUi=next");
    await expect(page.locator(".game-shell[data-mobile-shell='true']")).toBeVisible();
    await page.getByRole("button", { name: "更多", exact: true }).click();
    await page.locator("button:visible").filter({ hasText: "全星系空间站" }).first().click();
    const workspace = page.getByRole("dialog", { name: "全星系空间站" });
    await expect(workspace).toBeVisible();
    await workspace.getByRole("button", { name: /装饰收藏/ }).click();
    await workspace.getByRole("button", { name: "进入编辑模式" }).click();
    await selectFixtureDecoration(workspace);
    await expect(page.locator('.game-shell[data-mobile-subview^="decoration:"]')).toBeVisible();
    const visibleTargets = await workspace.locator("button:visible").evaluateAll((buttons) => buttons.map((button) => {
      const rect = button.getBoundingClientRect();
      return { width: rect.width, height: rect.height, label: button.getAttribute("aria-label") ?? button.textContent?.trim() };
    }));
    for (const target of visibleTargets) {
      expect(target.width, target.label).toBeGreaterThanOrEqual(24);
      expect(target.height, target.label).toBeGreaterThanOrEqual(44);
    }
    await expectContained(page, ".orbital-station-workspace");
    await page.screenshot({ path: `artifacts/qa/orbital-station-mobile-${viewport.width}x${viewport.height}.png`, fullPage: true });
    await page.locator(".mobile-next-topbar").getByRole("button", { name: /返回全星系空间站列表/ }).click();
    await expect(page.locator('.game-shell[data-mobile-subview="none"]')).toBeVisible();
    await page.locator(".mobile-next-topbar").getByRole("button", { name: /返回工厂/ }).click();
    await expect(workspace).toHaveCount(0);
  }
});

test("public station direct link loads only the strict read-only snapshot", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("dsp-idle-network.save.v1", "public-route-must-not-touch-local-save"));
  await page.route(`**/api/stations/${PUBLIC_ID}`, async (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      snapshot: {
        schema: "station-showcase-v1",
        publicId: PUBLIC_ID,
        owner: { displayName: "公开工程师", avatar: "公" },
        profile: { title: "公开白糖港", motto: "只读展示，不读取工厂存档。" },
        station: {
          stage: "operational",
          reputation: "5000",
          level: 6,
          themeId: "orbital_teal",
          placements: [{ id: "public_crate", decorationId: "cargo_crate", x: 0, y: 0, rotation: 0, layer: 1, variant: 0 }],
          featuredAchievementIds: ["first_manual_mine"],
          completedContracts: 12,
          featuredContract: { id: "featured_contract", title: "终局部件特别出口", difficulty: "P3", settledAtTaskDay: 1 },
        },
        metrics: { "universe-matrix-produced": 1000 },
        aggregateMetrics: { "total-generation": 123456, "peak-throughput": 7890, "dyson-power": 4567, "explored-systems": 4, "colonized-planets": 9 },
        metricStatus: "official",
        publishedAt: Date.now(),
      },
      social: { favoriteCount: 3, viewerFavorite: false, signals: { spectacular: 2, precise: 1, industrial: 0, layout: 4 }, viewerSignal: null },
    }),
  }));
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto(`/station/${PUBLIC_ID}`);
  await expect(page.getByText("公开白糖港", { exact: true })).toBeVisible();
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
  expect(await page.evaluate(async () => (await fetch(document.querySelector<HTMLLinkElement>('link[rel="manifest"]')!.href)).status)).toBe(200);
  await expect(page.locator(".station-canvas-renderer--readonly")).toBeVisible();
  await expect(page.getByText("安全聚合数据", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /收藏/ })).toBeDisabled();
  await expect(page.locator(".game-shell")).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("dsp-idle-network.save.v1"))).toBe("public-route-must-not-touch-local-save");
});

test("private and missing public stations share the same visitor state", async ({ page }) => {
  const privateId = `station_${"b".repeat(32)}`;
  await page.route(`**/api/stations/${privateId}`, async (route) => route.fulfill({
    status: 404,
    contentType: "application/json",
    body: JSON.stringify({ error: "空间站不存在", code: "STATION_NOT_FOUND" }),
  }));
  await page.goto(`/station/${privateId}`);
  await expect(page.getByText("空间站不存在或已设为私密", { exact: true })).toBeVisible();
  await expect(page.locator(".game-shell")).toHaveCount(0);
});
