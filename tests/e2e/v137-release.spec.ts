import { expect, test, type Page } from "@playwright/test";

const SAVE_KEY = "dsp-idle-network.save.v1";
const REQUIRED_TIERS = [6, 16, 17, 21] as const;

async function seedTechnologyFactory(page: Page, fontScale: 1 | 1.5 | 2, layout: "standard" | "compact") {
  await page.addInitScript(() => {
    window.sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    window.localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
  });
  await page.goto("/?menu=1");
  await expect(page.locator(".start-menu")).toBeVisible({ timeout: 15_000 });
  await page.evaluate(async ({ fontScale, layout }) => {
    const engine = await import("/src/game/engine.ts");
    const storage = await import("/src/game/storage.ts");
    const localStore = await import("/src/game/localSaveStore.ts");
    const state = engine.createInitialState(20_260_810, false);
    state.settings.fontScale = fontScale;
    state.settings.technologyLayout = layout;
    const result = storage.saveGame(state);
    if (!result.success) throw new Error(result.message);
    window.localStorage.setItem("dsp-idle-network.menu-settings.v1", JSON.stringify(state.settings));
    await localStore.flushLocalSaveWrites();
  }, { fontScale, layout });
  await page.goto("/");
  await expect(page.locator(".game-shell")).toBeVisible({ timeout: 15_000 });
  await page.getByLabel("打开科技树").click();
  await expect(page.getByRole("dialog", { name: "科技树" })).toBeVisible();
}

async function seedOfflineMenu(page: Page, seconds: number) {
  await page.addInitScript(() => {
    // `?menu=1` wins for navigation while this supported test flag suppresses
    // onboarding/release overlays that are unrelated to the settlement gate.
    window.sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    window.localStorage.setItem("dsp-idle-network.offline-settlement-preference.v1", "ask");
  });
  await page.goto("/?menu=1");
  await page.evaluate(async ({ seconds, saveKey }) => {
    const engine = await import("/src/game/engine.ts");
    const storage = await import("/src/game/storage.ts");
    const state = engine.createInitialState(20_260_810, false);
    state.entities = [];
    state.belts = [];
    state.elapsedSeconds = 42;
    state.paused = false;
    window.localStorage.setItem(saveKey, storage.serializeEnvelope(state, Date.now() - seconds * 1_000));
  }, { seconds, saveKey: SAVE_KEY });
  await page.reload();
  await expect(page.locator(".start-menu")).toBeVisible();
}

async function injectOneConservativeDecision(page: Page) {
  await page.evaluate(() => {
    const NativeWorker = window.Worker;
    class OneConservativeDecisionWorker extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (options?.name !== "offline-simulation") return;
        this.terminate();
        window.Worker = NativeWorker;
        this.postMessage = ((message: { type?: string; id?: number; seconds?: number }) => {
          if (message.type !== "start" || typeof message.id !== "number") return;
          const totalSeconds = Number(message.seconds ?? 0);
          window.setTimeout(() => this.dispatchEvent(new MessageEvent("message", {
            data: {
              type: "decision-required",
              id: message.id,
              totalSeconds,
              approximation: {
                mode: "approximate",
                calibrationWindowSeconds: 0,
                approximatedSeconds: totalSeconds,
                maxEstimatedError: 1,
                fellBack: true,
                fallbackReason: "测试注入：快速 Worker 校准不稳定",
                algorithmVersion: "fast-30s-v2",
                settlementStatus: "conservative-preview",
              },
            },
          })), 0);
        }) as typeof this.postMessage;
      }
    }
    window.Worker = OneConservativeDecisionWorker as typeof Worker;
  });
}

for (const fontScale of [1, 1.5, 2] as const) {
  for (const layout of ["standard", "compact"] as const) {
    test(`desktop technology tree is vertically complete at ${fontScale * 100}% in ${layout} layout`, async ({ page }) => {
      await page.setViewportSize({ width: 1365, height: 768 });
      await seedTechnologyFactory(page, fontScale, layout);
      const tree = page.getByRole("region", { name: "科技树横向视口" });
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.uiFontScale)).toBe(String(fontScale * 100));
      await expect(tree).toHaveClass(new RegExp(`technology-tree--${layout}`));
      await expect(tree).toHaveCSS("overflow-y", "hidden");
      await expect(tree.locator('.technology-tier[data-tier="21"]')).toHaveCount(1);

      const metrics = await tree.evaluate((element) => {
        return {
          clientHeight: element.clientHeight,
          scrollHeight: element.scrollHeight,
          scrollTop: element.scrollTop,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
          documentScrollTop: document.scrollingElement?.scrollTop ?? 0,
        };
      });

      expect(metrics.clientHeight).toBeGreaterThan(80);
      expect(metrics.scrollHeight).toBeLessThanOrEqual(metrics.clientHeight + 1);
      expect(metrics.scrollTop).toBe(0);
      expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth);
      expect(metrics.documentScrollTop).toBe(0);

      for (const tier of REQUIRED_TIERS) {
        await tree.evaluate((element, tierNumber) => {
          const section = element.querySelector<HTMLElement>(`.technology-tier[data-tier="${tierNumber}"]`)!;
          element.scrollLeft = section.offsetLeft;
        }, tier);
        // `content-visibility:auto` materializes distant cards after they enter
        // the horizontal viewport, so measure after two browser frames.
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        const accessibility = await tree.evaluate((element, tierNumber) => {
          const section = element.querySelector<HTMLElement>(`.technology-tier[data-tier="${tierNumber}"]`)!;
          const treeRect = element.getBoundingClientRect();
          const nodes = [...section.querySelectorAll<HTMLElement>(".technology-node")];
          const nodeRect = nodes[0]!.getBoundingClientRect();
          const clippedNodes = nodes.filter((node) => node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1).map((node) => ({
            id: node.dataset.techId,
            clientWidth: node.clientWidth,
            scrollWidth: node.scrollWidth,
            clientHeight: node.clientHeight,
            scrollHeight: node.scrollHeight,
          }));
          const verticallyClippedNodes = nodes.filter((node) => {
            const rect = node.getBoundingClientRect();
            return rect.top < treeRect.top - 1 || rect.bottom > treeRect.bottom + 1;
          }).map((node) => {
            const rect = node.getBoundingClientRect();
            return { id: node.dataset.techId, top: rect.top, bottom: rect.bottom, treeTop: treeRect.top, treeBottom: treeRect.bottom };
          });
          return {
            verticalScroll: element.scrollTop,
            visible: nodeRect.right > treeRect.left && nodeRect.left < treeRect.right,
            nodeCount: nodes.length,
            verticallyVisible: nodes.every((node) => {
              const rect = node.getBoundingClientRect();
              return rect.top >= treeRect.top - 1 && rect.bottom <= treeRect.bottom + 1;
            }),
            clippedNodes,
            verticallyClippedNodes,
          };
        }, tier);
        expect(accessibility.verticalScroll).toBe(0);
        expect(accessibility.visible, `tier ${tier} cannot be reached horizontally`).toBe(true);
        expect(accessibility.nodeCount, `tier ${tier}`).toBeGreaterThan(0);
        expect(accessibility.verticallyVisible, `tier ${tier} is vertically clipped: ${JSON.stringify(accessibility.verticallyClippedNodes)}`).toBe(true);
        expect(accessibility.clippedNodes, `tier ${tier} contains clipped text`).toEqual([]);
      }

      await page.screenshot({ path: `artifacts/qa/v137-tech-${layout}-${fontScale * 100}.png`, fullPage: true });
    });
  }
}

test("real wheel, trackpad, drag and keyboard input only move the desktop technology tree horizontally", async ({ page }) => {
  const passiveWarnings: string[] = [];
  page.on("console", (message) => {
    if (/passive|preventDefault/i.test(message.text())) passiveWarnings.push(message.text());
  });
  await page.setViewportSize({ width: 1365, height: 768 });
  await seedTechnologyFactory(page, 1.5, "standard");
  const tree = page.getByRole("region", { name: "科技树横向视口" });
  const box = await tree.boundingBox();
  if (!box) throw new Error("technology tree viewport is unavailable");
  const read = () => tree.evaluate((element) => ({
    left: element.scrollLeft,
    top: element.scrollTop,
    documentTop: document.scrollingElement?.scrollTop ?? 0,
  }));

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 520);
  await expect.poll(async () => (await read()).left).toBeGreaterThan(0);
  let position = await read();
  expect(position.top).toBe(0);
  expect(position.documentTop).toBe(0);

  const afterWheel = position.left;
  await page.mouse.wheel(180, 0);
  await expect.poll(async () => (await read()).left).toBeGreaterThan(afterWheel);

  const beforeShiftWheel = (await read()).left;
  await page.keyboard.down("Shift");
  await page.mouse.wheel(0, 180);
  await page.keyboard.up("Shift");
  await expect.poll(async () => (await read()).left).toBeGreaterThan(beforeShiftWheel);

  const beforeDrag = (await read()).left;
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(box.x + box.width / 2 - 160, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up({ button: "middle" });
  await expect.poll(async () => (await read()).left).toBeGreaterThan(beforeDrag);

  const beforeRightDrag = (await read()).left;
  await page.mouse.down({ button: "right" });
  await page.mouse.move(box.x + box.width / 2 - 260, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up({ button: "right" });
  await expect.poll(async () => (await read()).left).toBeGreaterThan(beforeRightDrag);

  await tree.focus();
  await page.keyboard.press("End");
  const atEnd = (await read()).left;
  expect(atEnd).toBeGreaterThan(0);
  await page.keyboard.press("Home");
  await expect.poll(async () => (await read()).left).toBe(0);
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await read()).left).toBeGreaterThan(0);
  position = await read();
  expect(position.top).toBe(0);
  expect(position.documentTop).toBe(0);
  expect(passiveWarnings).toEqual([]);
});

for (const layout of ["standard", "compact"] as const) {
  test(`200% ${layout} technology cards still support research, pause, resume and cancel`, async ({ page }) => {
    await page.setViewportSize({ width: 1365, height: 768 });
    await seedTechnologyFactory(page, 2, layout);
    const technology = page.getByRole("dialog", { name: "科技树" });
    const firstAvailable = technology.locator(".technology-node:not([disabled])").first();
    const technologyName = (await firstAvailable.locator("header strong").textContent())?.trim();
    expect(technologyName).toBeTruthy();
    await firstAvailable.click();
    await expect(technology.locator(".research-focus")).toContainText(technologyName!);
    await technology.getByRole("button", { name: "暂停", exact: true }).click();
    await expect(technology.getByRole("button", { name: "继续研究" })).toBeVisible();
    await technology.getByRole("button", { name: "继续研究" }).click();
    await expect(technology.getByRole("button", { name: "取消", exact: true })).toBeVisible();
    await technology.getByRole("button", { name: "取消", exact: true }).click();
    await expect(technology.locator(".research-focus")).toContainText("未选择科技");
  });
}

test("the next mobile technology list keeps its independent vertical scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    window.sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    window.localStorage.setItem("dsp-idle-network.mobile-ui.v1", "next");
  });
  await page.goto("/?mobileUi=next");
  await expect(page.locator(".game-shell")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "科研", exact: true }).click();
  const list = page.locator(".mobile-technology > .mobile-workspace-scroll");
  await expect(list).toBeVisible();
  await page.getByRole("navigation", { name: "科技筛选" }).getByRole("button", { name: "全部" }).click();
  const before = await list.evaluate((element) => ({ top: element.scrollTop, height: element.clientHeight, scrollHeight: element.scrollHeight }));
  expect(before.scrollHeight).toBeGreaterThan(before.height);
  const box = await list.boundingBox();
  if (!box) throw new Error("mobile technology list is unavailable");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 500);
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(before.top);
});

test("cancel keeps the pending interval and confirmed skip commits zero rewards", async ({ page }) => {
  await seedOfflineMenu(page, 3_600);
  const sourceRaw = await page.evaluate((key) => window.localStorage.getItem(key), SAVE_KEY);
  await injectOneConservativeDecision(page);
  await page.getByRole("button", { name: "继续游戏" }).first().click();
  const decision = page.getByRole("dialog", { name: "快速结算需要玩家选择" });
  await expect(decision).toBeVisible();
  await expect(decision).toContainText("实际提交时间0 秒");
  await expect(decision).toContainText("原始存档、savedAt、库存、建筑缓存和累计产量均保持不变");
  expect(await page.evaluate((key) => window.localStorage.getItem(key), SAVE_KEY)).toBe(sourceRaw);

  await page.reload();
  await expect(page.locator(".start-menu")).toBeVisible();
  expect(await page.evaluate((key) => window.localStorage.getItem(key), SAVE_KEY)).toBe(sourceRaw);

  await injectOneConservativeDecision(page);
  await page.getByRole("button", { name: "继续游戏" }).first().click();
  await expect(decision).toBeVisible();
  await decision.getByRole("button", { name: "取消并返回" }).click();
  await expect(decision).toHaveCount(0);
  await expect(page.locator(".start-menu")).toBeVisible();
  expect(await page.evaluate((key) => window.localStorage.getItem(key), SAVE_KEY)).toBe(sourceRaw);

  await injectOneConservativeDecision(page);
  await page.getByRole("button", { name: "继续游戏" }).first().click();
  const secondDecision = page.getByRole("dialog", { name: "快速结算需要玩家选择" });
  await secondDecision.getByRole("button", { name: "保守跳过本次收益" }).click();
  await expect(secondDecision).toContainText("再次确认跳过本次收益");
  expect(await page.evaluate((key) => window.localStorage.getItem(key), SAVE_KEY)).toBe(sourceRaw);
  await secondDecision.getByRole("button", { name: "再次确认：收益为 0" }).click();

  await expect(page.locator(".game-shell")).toBeVisible({ timeout: 15_000 });
  const report = page.getByRole("dialog", { name: "离线结算报告" });
  await expect(report).toBeVisible();
  await expect(report).toContainText("已确认跳过收益");
  await expect(report).toContainText("结算状态保守跳过");
  await expect(report).toContainText("实际提交 1 小时 0 分钟");
  const persisted = await page.evaluate((key) => JSON.parse(window.localStorage.getItem(key)!).state, SAVE_KEY);
  // The pending interval includes slow-runner wall time across the deliberate
  // reload/cancel cycle, but it must still be applied once from the original 42s.
  expect(persisted.elapsedSeconds).toBeGreaterThanOrEqual(3_642);
  expect(persisted.elapsedSeconds).toBeLessThan(3_652);
  expect(persisted.totalProduced).toEqual({});
});

test("the recommended exact retry restarts from the unchanged original state", async ({ page }) => {
  await seedOfflineMenu(page, 120);
  const sourceRaw = await page.evaluate((key) => window.localStorage.getItem(key), SAVE_KEY);
  await injectOneConservativeDecision(page);
  await page.getByRole("button", { name: "继续游戏" }).first().click();
  const decision = page.getByRole("dialog", { name: "快速结算需要玩家选择" });
  await expect(decision).toBeVisible();
  expect(await page.evaluate((key) => window.localStorage.getItem(key), SAVE_KEY)).toBe(sourceRaw);
  await decision.getByRole("button", { name: /使用精确结算/ }).click();

  await expect(page.locator(".game-shell")).toBeVisible({ timeout: 15_000 });
  const report = page.getByRole("dialog", { name: "离线结算报告" });
  await expect(report).toBeVisible();
  await expect(report).toContainText("精确结算");
  await expect(report).toContainText("实际提交 2 分钟 0 秒");
  const persisted = await page.evaluate((key) => JSON.parse(window.localStorage.getItem(key)!).state, SAVE_KEY);
  // The pending interval includes the sub-second wall time between fixture
  // creation and the click; it must be applied once, from the original 42s.
  expect(persisted.elapsedSeconds).toBeGreaterThanOrEqual(162);
  expect(persisted.elapsedSeconds).toBeLessThan(163);
  expect(persisted.totalProduced).toEqual({});
});

async function seedStarMapBatchFactory(page: Page, fontScale: 1 | 1.5 | 2, mobile = false) {
  await page.addInitScript(({ mobile }) => {
    window.sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    window.localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
    if (mobile) window.localStorage.setItem("dsp-idle-network.mobile-ui.v1", "next");
  }, { mobile });
  await page.goto("/?menu=1");
  await expect(page.locator(".start-menu")).toBeVisible({ timeout: 15_000 });
  await page.evaluate(async ({ fontScale }) => {
    const engine = await import("/src/game/engine.ts");
    const storage = await import("/src/game/storage.ts");
    const localStore = await import("/src/game/localSaveStore.ts");
    const state = engine.createInitialState(20_260_810, false);
    state.paused = true;
    state.settings.fontScale = fontScale;
    state.research.completedTechIds.push("orbital_elevator_engineering", "quantum_logistics_network");
    const station = (id: string, tier: 1 | 2, mode: "legacy" | "quantum" = "legacy") => ({
      id, kind: "station" as const, planetId: "home" as const, position: { x: 0, y: 0 }, interactionLocked: false,
      buildingId: "interstellar_logistics_station" as const, stationTier: tier, quantumMode: mode,
      stationSlots: [], stationRoutes: [], inputs: {}, outputs: {}, progress: 0, utilization: 0,
      productionRate: 0, routingCursor: 0, machineCount: 1, minerCount: 0,
    });
    const collector = (id: string, locked = false, mode: "legacy" | "quantum" = "legacy") => ({
      id, kind: "station" as const, planetId: "giant" as const, position: { x: 0, y: 0 }, interactionLocked: locked,
      buildingId: "orbital_collector" as const, quantumMode: mode, storedItemId: "hydrogen" as const,
      stationRoutes: [], inputs: {}, outputs: { hydrogen: 100 }, progress: 0, utilization: 0,
      productionRate: 0, routingCursor: 0, machineCount: 1, minerCount: 0,
    });
    state.entities.push(
      station("batch-upgrade-a", 1), station("batch-upgrade-b", 1),
      station("batch-quantum", 2), station("batch-quantum-done", 2, "quantum"),
      collector("batch-collector-ready"), collector("batch-collector-locked", true), collector("batch-collector-done", false, "quantum"),
    );
    const result = storage.saveGame(state);
    if (!result.success) throw new Error(result.message);
    await localStore.flushLocalSaveWrites();
  }, { fontScale });
  await page.goto(mobile ? "/?mobileUi=next" : "/");
  await expect(page.locator(".game-shell")).toBeVisible({ timeout: 15_000 });
  if (mobile) {
    await page.getByRole("button", { name: "更多", exact: true }).click();
    await page.getByRole("button", { name: /星图与星际工业/ }).click();
  } else {
    await page.getByLabel("打开星图").click();
  }
  await expect(page.getByRole("dialog", { name: "星图" })).toBeVisible();
}

for (const scenario of [
  { width: 1920, height: 1080, fontScale: 1 as const, name: "wide-100" },
  { width: 1365, height: 768, fontScale: 1.5 as const, name: "desktop-150" },
  { width: 1024, height: 768, fontScale: 2 as const, name: "narrow-200" },
]) {
  test(`star-map bulk actions stay aligned without covering search at ${scenario.name}`, async ({ page }) => {
    await page.setViewportSize({ width: scenario.width, height: scenario.height });
    await seedStarMapBatchFactory(page, scenario.fontScale);
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.uiFontScale)).toBe(String(scenario.fontScale * 100));
    const starMap = page.getByRole("dialog", { name: "星图" });
    const actions = starMap.getByRole("group", { name: "星图批量物流操作" });
    const upgrade = actions.getByRole("button", { name: /升级全部星际物流站/ });
    const quantum = actions.getByRole("button", { name: /一键切换全部量子物流站/ });
    const collectors = actions.getByRole("button", { name: /量子网络一键接入所有轨道收集器/ });
    await expect(upgrade).toBeVisible();
    await expect(quantum).toBeVisible();
    await expect(collectors).toBeVisible();
    await expect(upgrade).toBeEnabled();
    await expect(quantum).toBeEnabled();
    await expect(collectors).toBeEnabled();
    const geometry = await starMap.evaluate((element) => {
      const rect = (selector: string) => element.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
      const buttons = [...element.querySelectorAll<HTMLElement>(".star-map-batch-actions > button")];
      const search = rect(".star-map-controls__search");
      const actionGroup = rect(".star-map-controls > .star-map-batch-actions");
      const first = buttons[0]!.getBoundingClientRect();
      const second = buttons[1]!.getBoundingClientRect();
      return {
        sameRow: Math.abs(first.top - second.top) <= 1,
        overlapSearch: !(search.right <= actionGroup.left || actionGroup.right <= search.left || search.bottom <= actionGroup.top || actionGroup.bottom <= search.top),
        clippedButtons: buttons.filter((button) => button.scrollHeight > button.clientHeight + 1 || button.scrollWidth > button.clientWidth + 1).length,
        horizontalOverflow: element.scrollWidth > element.clientWidth + 1,
        routeHeight: element.querySelector<HTMLElement>(".star-map-route")!.clientHeight,
      };
    });
    expect(geometry.sameRow).toBe(true);
    expect(geometry.overlapSearch).toBe(false);
    expect(geometry.clippedButtons).toBe(0);
    expect(geometry.horizontalOverflow).toBe(false);
    expect(geometry.routeHeight).toBeGreaterThan(100);
    await page.screenshot({ path: `artifacts/qa/v137-star-map-batch-${scenario.name}.png`, fullPage: true });
  });
}

test("collector bulk attach previews, cancels safely, and reports success plus grouped skip reasons", async ({ page }) => {
  await page.setViewportSize({ width: 1365, height: 768 });
  await seedStarMapBatchFactory(page, 1.5);
  const starMap = page.getByRole("dialog", { name: "星图" });
  const collectors = starMap.getByRole("button", { name: /量子网络一键接入所有轨道收集器/ });
  await collectors.click();
  let confirmation = page.getByRole("alertdialog", { name: "确认批量接入轨道收集器" });
  await expect(confirmation).toContainText("可成功 1 台，跳过 2 台");
  await expect(confirmation).toContainText("轨道采集器已锁定");
  await expect(confirmation).toContainText("已经接入量子采集网络");
  await confirmation.getByRole("button", { name: "取消" }).click();
  await expect(collectors).toBeEnabled();
  await expect(starMap.locator(".star-map-batch-report")).toHaveCount(0);

  await collectors.click();
  confirmation = page.getByRole("alertdialog", { name: "确认批量接入轨道收集器" });
  await confirmation.getByRole("button", { name: "确认接入" }).click();
  const report = starMap.locator(".star-map-batch-report");
  await expect(report).toBeVisible();
  await expect(report).toContainText("成功 1 · 跳过 2");
  await expect(report).toContainText("轨道采集器已锁定");
  await expect(report).toContainText("已经接入量子采集网络");
  await expect(page.getByRole("status").filter({ hasText: "量子采集切换完成" })).toContainText("成功 1 台，跳过 2 台");
});

test("mobile 200% star-map keeps all three global batch actions visible and clickable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedStarMapBatchFactory(page, 2, true);
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.uiFontScale)).toBe("200");
  const starMap = page.getByRole("dialog", { name: "星图" });
  const actions = starMap.getByRole("group", { name: "星图批量物流操作" });
  const buttons = actions.locator(":scope > button");
  await expect(buttons).toHaveCount(3);
  for (let index = 0; index < 3; index += 1) {
    await expect(buttons.nth(index)).toBeVisible();
    await expect(buttons.nth(index)).toBeEnabled();
  }
  const geometry = await actions.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const children = [...element.querySelectorAll<HTMLElement>(":scope > button")];
    const first = children[0]!.getBoundingClientRect();
    const second = children[1]!.getBoundingClientRect();
    return {
      sameRow: Math.abs(first.top - second.top) <= 1,
      inside: children.every((button) => {
        const child = button.getBoundingClientRect();
        return child.left >= rect.left - 1 && child.right <= rect.right + 1 && button.scrollHeight <= button.clientHeight + 1;
      }),
      documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
  });
  expect(geometry.sameRow).toBe(true);
  expect(geometry.inside).toBe(true);
  expect(geometry.documentOverflow).toBe(false);
  await actions.getByRole("button", { name: /量子网络一键接入所有轨道收集器/ }).click();
  await expect(page.getByRole("alertdialog", { name: "确认批量接入轨道收集器" })).toBeVisible();
  await page.screenshot({ path: "artifacts/qa/v137-star-map-batch-mobile-390-font-200.png", fullPage: true });
});

test("cloud upload preparation preserves the generated unipolar resource catalogue exactly", async ({ page }) => {
  await page.addInitScript(() => window.sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1"));
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const engine = await import("/src/game/engine.ts");
    const offline = await import("/src/game/offlineSimulation.ts");
    const integrity = await import("/src/game/resourceIntegrity.ts");
    const storage = await import("/src/game/storage.ts");
    const state = engine.createInitialState(20_260_810, false);
    const sourceJson = JSON.stringify(state);
    const sourceAudit = integrity.auditUnipolarVeins(state);
    const now = Date.now();
    const prepared = await offline.prepareCloudUploadInWorker(storage.serializeEnvelope(state, now), {
      now,
      skipOffline: true,
    });
    const restored = storage.inspectSave(prepared.payload);
    if (!restored.valid || !restored.state) throw new Error(restored.issues.join("；"));
    return {
      sourceUnchanged: JSON.stringify(state) === sourceJson,
      sourceAudit,
      restoredAudit: integrity.auditUnipolarVeins(restored.state),
      cloudMode: prepared.summary.mode,
      integrity: prepared.summary.integrity,
    };
  });
  expect(result.sourceUnchanged).toBe(true);
  expect(result.sourceAudit.healthy).toBe(true);
  expect(result.restoredAudit).toEqual(result.sourceAudit);
  expect(result.cloudMode).toBe("normal");
  expect(result.integrity).toBe("valid");
});
