import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { createBlueprint, createInitialState, placeBuilding } from "../../src/game/engine";
import { serializeEnvelope } from "../../src/game/storage";
import { selectSettingsCategory } from "./settings-helpers";

const CANVAS_DETAIL_KEY = "dsp-idle-network.ui.canvas-detail.v1";
const CANVAS_OVERLAP_KEY = "dsp-idle-network.ui.canvas-overlap.v1";
const CANVAS_INTERACTION_DETAIL_KEY = "dsp-idle-network.ui.canvas-interaction-detail.v1";
const BLUEPRINT_OVERLAP_KEY = "dsp-idle-network.ui.blueprint-allow-overlap.v1";
const MOBILE_UI_KEY = "dsp-idle-network.mobile-ui.v1";

function anonymousCanvasFixture(options: { count: number; exactStack?: number; blueprint?: boolean; hiddenStackAlert?: boolean; productionRecipe?: boolean; networkFocus?: boolean; spacingX?: number; zoom?: number; savedViewport?: { x: number; y: number; zoom: number } }) {
  let state = createInitialState(144_441, false);
  state.paused = true;
  state.settings.reducedMotion = true;
  state.settings.soundEnabled = false;
  state.construction.storage_mk1 = 1;
  state = placeBuilding(state, "storage_mk1", { x: 0, y: 0 });
  const template = state.entities.find((entity) => entity.buildingId === "storage_mk1")!;
  state.construction.arc_smelter = 1;
  state = placeBuilding(state, "arc_smelter", { x: 800, y: 800 });
  const alertTemplate = state.entities.find((entity) => entity.buildingId === "arc_smelter")!;
  const productionTemplate = { ...alertTemplate, recipeId: "diamond_from_kimberlite" as const };
  const columns = options.count >= 1_000 ? 50 : 25;
  const zoom = options.count >= 1_000 ? 0.2 : options.count >= 300 ? 0.32 : 0.84;
  state.entities = Array.from({ length: options.count }, (_, index) => ({
    ...(options.productionRecipe ? productionTemplate : options.hiddenStackAlert && index === 1 ? alertTemplate : template),
    id: `anonymous-node-${index}`,
    position: index < (options.exactStack ?? 0)
      ? { x: 0, y: 0 }
      : { x: (index % columns) * (options.spacingX ?? 120), y: Math.floor(index / columns) * 96 },
    inputs: { iron_ore: 0 },
    outputs: { iron_ore: index === 0 ? 500 : 0 },
    storedItemId: "iron_ore" as const,
    progress: 0.4,
    utilization: 0.8,
  }));
  state.belts = options.networkFocus
    ? [{
        id: "anonymous-edge-focus",
        planetId: "home" as const,
        source: "anonymous-node-0",
        target: "anonymous-node-1",
        itemId: "iron_ore" as const,
        lanes: 1,
        tier: 1 as const,
        sorterTier: 1 as const,
        stackSize: 1 as const,
        progress: 0,
        priority: 0,
        routeMode: "lower" as const,
        lastFlow: 0,
      }]
    : options.exactStack
    ? Array.from({ length: Math.min(3, options.exactStack - 1) }, (_, index) => ({
        id: `anonymous-edge-${index}`,
        planetId: "home" as const,
        source: `anonymous-node-${index + 1}`,
        target: "anonymous-node-0",
        itemId: "iron_ore" as const,
        lanes: 1,
        tier: 1 as const,
        sorterTier: 1 as const,
        stackSize: 1 as const,
        progress: 0,
        priority: 0,
        routeMode: "lower" as const,
        lastFlow: 0,
      }))
    : [];
  state.nextId = 900_000;
  state.planetViewports.home = options.savedViewport ?? { x: 120, y: 100, zoom: options.zoom ?? zoom };
  state.construction.storage_mk1 = options.blueprint ? 1 : 0;
  if (options.blueprint) state = createBlueprint(state, ["anonymous-node-0"], "匿名重叠蓝图");
  if (options.hiddenStackAlert) state.paused = false;
  return serializeEnvelope(state, Date.now());
}

async function seedCanvas(page: Page, options: { count: number; exactStack?: number; blueprint?: boolean; detail?: string; overlap?: string; interactionDetail?: string; hiddenStackAlert?: boolean; productionRecipe?: boolean; networkFocus?: boolean; spacingX?: number; zoom?: number; savedViewport?: { x: number; y: number; zoom: number }; viewport?: { width: number; height: number } }) {
  const raw = anonymousCanvasFixture(options);
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const fulfill = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (pathname === "/api/health") return fulfill({ ok: true, schemaVersion: 7 });
    if (pathname === "/api/public-status") return fulfill({ players: { total: 0, today: 0, online: 0, onlineWindowSeconds: 120 }, serverTime: Date.now() });
    if (pathname === "/api/analytics" || pathname === "/api/presence" || pathname === "/api/errors") return fulfill({ accepted: true }, 202);
    return fulfill({ error: `unmocked ${pathname}` }, 404);
  });
  await page.addInitScript(({ save, detail, canvasOverlap, interactionDetail, detailKey, canvasOverlapKey, interactionDetailKey, blueprintOverlapKey }) => {
    window.sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-09-10-v1.2.9");
    window.localStorage.setItem("dsp-idle-network.onboarding.v1", "dismissed");
    window.localStorage.setItem("dsp-idle-network.ui.show-run-log.v1", "true");
    window.localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
    window.localStorage.setItem("dsp-idle-network.save.v1", save);
    if (window.sessionStorage.getItem("dsp-idle-network.v144-overlap-preference-seeded") !== "1") {
      window.localStorage.removeItem(blueprintOverlapKey);
      window.sessionStorage.setItem("dsp-idle-network.v144-overlap-preference-seeded", "1");
    }
    if (window.sessionStorage.getItem("dsp-idle-network.v144-density-preference-seeded") !== "1") {
      if (detail === undefined) window.localStorage.removeItem(detailKey);
      else window.localStorage.setItem(detailKey, detail);
      window.sessionStorage.setItem("dsp-idle-network.v144-density-preference-seeded", "1");
    }
    if (window.sessionStorage.getItem("dsp-idle-network.v144-canvas-overlap-seeded") !== "1") {
      window.localStorage.setItem(canvasOverlapKey, canvasOverlap);
      window.sessionStorage.setItem("dsp-idle-network.v144-canvas-overlap-seeded", "1");
    }
    if (window.sessionStorage.getItem("dsp-idle-network.v144-canvas-interaction-seeded") !== "1") {
      window.localStorage.setItem(interactionDetailKey, interactionDetail);
      window.sessionStorage.setItem("dsp-idle-network.v144-canvas-interaction-seeded", "1");
    }
  }, {
    save: raw,
    detail: options.detail,
    canvasOverlap: options.overlap ?? "representative",
    interactionDetail: options.interactionDetail ?? "hover",
    detailKey: CANVAS_DETAIL_KEY,
    canvasOverlapKey: CANVAS_OVERLAP_KEY,
    interactionDetailKey: CANVAS_INTERACTION_DETAIL_KEY,
    blueprintOverlapKey: BLUEPRINT_OVERLAP_KEY,
  });
  await page.setViewportSize(options.viewport ?? { width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator(".game-shell")).toBeVisible();
  const offlineReport = page.getByRole("dialog", { name: "离线结算报告" });
  await offlineReport.waitFor({ state: "visible", timeout: 1_500 }).catch(() => undefined);
  if (await offlineReport.isVisible().catch(() => false)) {
    const originalDuration = await offlineReport.locator(".offline-runtime > strong").innerText();
    const seconds = Number(/^([1-9]\d*) 秒$/.exec(originalDuration)?.[1] ?? Number.NaN);
    expect(Number.isInteger(seconds) && seconds <= 10).toBe(true);
    await expect(offlineReport.locator(".offline-runtime > small")).toHaveText(`实际提交 ${seconds} 秒`);
    const method = offlineReport.locator(".offline-report-method");
    await expect(method).toHaveClass(/offline-report-method--exact/);
    await expect(method.locator("header strong")).toHaveText("精确结算");
    await expect(method.locator("dl > div").filter({ hasText: "精确校准" }).locator("dd")).toHaveText("全程精确");
    await expect(method.locator("dl > div").filter({ hasText: "宏观覆盖" }).locator("dd")).toHaveText("未使用");
    await expect(method.locator("dl > div").filter({ hasText: "估计最大误差" }).locator("dd")).toHaveText("0.00%");
    await expect(method.locator("dl > div").filter({ hasText: "算法版本" }).locator("dd")).toHaveText("deterministic-exact");
    await expect(method.locator("dl > div").filter({ hasText: "收益提交" }).locator("dd")).toHaveText("已验证提交");
    await expect(method.locator("dl > div").filter({ hasText: "结算状态" }).locator("dd")).toHaveText("精确");
    await expect(method.locator(".offline-report-warning")).toHaveCount(0);
    await offlineReport.getByRole("button", { name: "确认结算" }).click();
    await expect(offlineReport).toBeHidden();
  }
  await expect(page.locator(".game-shell")).toHaveAttribute("data-active-planet-node-count", String(options.count + 6));
}

async function expectNodePaintedAndHitTestable(node: Locator): Promise<void> {
  await expect(node).toBeVisible();
  const samplePaintState = () => node.evaluate((wrapper) => {
    const content = wrapper.querySelector<HTMLElement>(".factory-node:not(.factory-node-stack-proxy)");
    const flow = document.querySelector<HTMLElement>(".factory-canvas .react-flow");
    if (!content || !flow || !wrapper.isConnected) return {
      connected: wrapper.isConnected,
      painted: false,
      hit: false,
      heavy: false,
      topNodeId: null,
    };
    const bounds = content.getBoundingClientRect();
    const flowBounds = flow.getBoundingClientRect();
    const left = Math.max(bounds.left, flowBounds.left);
    const right = Math.min(bounds.right, flowBounds.right);
    const top = Math.max(bounds.top, flowBounds.top);
    const bottom = Math.min(bounds.bottom, flowBounds.bottom);
    const style = getComputedStyle(content);
    const wrapperStyle = getComputedStyle(wrapper);
    const painted = right - left >= 2 && bottom - top >= 2 && style.display !== "none" &&
      style.visibility !== "hidden" && Number(style.opacity) >= 0.95 && wrapperStyle.display !== "none" &&
      wrapperStyle.visibility !== "hidden" && Number(wrapperStyle.opacity) >= 0.95;
    const hit = painted ? document.elementFromPoint((left + right) / 2, (top + bottom) / 2) : null;
    const topNode = hit?.closest<HTMLElement>(".react-flow__node[data-id]");
    return {
      connected: true,
      painted,
      hit: Boolean(hit && (wrapper === hit || wrapper.contains(hit))),
      heavy: content.dataset.heavyCard === "true",
      topNodeId: topNode?.dataset.id ?? null,
      nodeId: (wrapper as HTMLElement).dataset.id ?? null,
      wrapperZIndex: wrapperStyle.zIndex,
      topNodeZIndex: topNode ? getComputedStyle(topNode).zIndex : null,
    };
  });
  await expect.poll(samplePaintState).toMatchObject({ connected: true, painted: true, hit: true, heavy: true });
}

async function togglePauseAndMeasure(page: Page, label: "继续模拟" | "暂停模拟") {
  return page.evaluate(async (accessibleLabel) => {
    const shell = document.querySelector<HTMLElement>(".game-shell")!;
    const expected = accessibleLabel === "继续模拟" ? "false" : "true";
    const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${accessibleLabel}"]`);
    if (!button) throw new Error(`missing ${accessibleLabel}`);
    const startedAt = performance.now();
    button.click();
    if (shell.dataset.simulationPaused !== expected) await new Promise<void>((resolve) => {
        const observer = new MutationObserver(() => {
          if (shell.dataset.simulationPaused !== expected) return;
          observer.disconnect();
          resolve();
        });
        observer.observe(shell, { attributes: true, attributeFilter: ["data-simulation-paused"] });
      });
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return performance.now() - startedAt;
  }, label);
}

async function captureFrames(page: Page, action: () => Promise<void>) {
  await page.evaluate(() => {
    const target = window as typeof window & { __densityFrames?: { active: boolean; previous: number; values: number[] } };
    target.__densityFrames = { active: true, previous: performance.now(), values: [] };
    const sample = (now: number) => {
      const state = target.__densityFrames;
      if (!state?.active) return;
      state.values.push(now - state.previous);
      state.previous = now;
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  const startedAt = performance.now();
  await action();
  const actionMs = performance.now() - startedAt;
  // A fast run on a 144 Hz display can finish with only 18-19 samples, which
  // makes P95 equal to the single maximum frame. Keep observing the immediate
  // settle until there is a statistically meaningful window; the independent
  // max gate below still rejects any genuine >100 ms long frame.
  await page.evaluate(() => new Promise<void>((resolve) => {
    const waitForSamples = () => {
      const state = (window as typeof window & { __densityFrames?: { values: number[] } }).__densityFrames;
      if ((state?.values.length ?? 0) >= 30) {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        return;
      }
      requestAnimationFrame(waitForSamples);
    };
    waitForSamples();
  }));
  return page.evaluate((measuredActionMs) => {
    const state = (window as typeof window & { __densityFrames?: { active: boolean; values: number[] } }).__densityFrames!;
    state.active = false;
    const sorted = [...state.values].sort((left, right) => left - right);
    return {
      actionMs: measuredActionMs,
      samples: sorted.length,
      p95Ms: sorted[Math.max(0, Math.ceil(sorted.length * .95) - 1)] ?? 0,
      maxMs: sorted.at(-1) ?? 0,
      over21Ms: sorted.filter((value) => value > 21).length,
      over50Ms: sorted.filter((value) => value > 50).length,
      over100Ms: sorted.filter((value) => value > 100).length,
    };
  }, actionMs);
}

async function samePanZoomGesture(page: Page) {
  const pane = page.locator(".react-flow__pane");
  const bounds = await pane.boundingBox();
  if (!bounds) throw new Error("canvas pane is unavailable");
  await page.mouse.move(bounds.x + bounds.width * .55, bounds.y + bounds.height * .5);
  await page.mouse.wheel(72, 36);
  await pane.dispatchEvent("wheel", {
    clientX: bounds.x + bounds.width * .55,
    clientY: bounds.y + bounds.height * .5,
    ctrlKey: true,
    deltaY: -80,
    deltaMode: 0,
  });
  await pane.dispatchEvent("wheel", {
    clientX: bounds.x + bounds.width * .55,
    clientY: bounds.y + bounds.height * .5,
    ctrlKey: true,
    deltaY: 80,
    deltaMode: 0,
  });
}

test("minimal detail keeps one-line card and React Flow wrapper geometry at 96x32", async ({ page }) => {
  await seedCanvas(page, { count: 3, detail: "minimal", overlap: "all", interactionDetail: "base", spacingX: 340, zoom: 1 });
  const compact = page.locator('.react-flow__node[data-id="anonymous-node-0"] .factory-node-compact');
  await expect(compact).toBeVisible();
  await expect.poll(() => compact.evaluate((element) => {
    const wrapper = element.closest<HTMLElement>(".react-flow__node");
    if (!wrapper) return null;
    const style = getComputedStyle(element);
    const viewport = document.querySelector<HTMLElement>(".react-flow__viewport");
    const zoom = viewport ? new DOMMatrixReadOnly(getComputedStyle(viewport).transform).a : 1;
    const card = element.getBoundingClientRect();
    const node = wrapper.getBoundingClientRect();
    const round = (value: number) => Math.round(value * 10) / 10;
    return {
      cssWidth: style.width,
      cssMinHeight: style.minHeight,
      cardWidth: round(card.width / zoom),
      cardHeight: round(card.height / zoom),
      wrapperWidth: round(node.width / zoom),
      wrapperHeight: round(node.height / zoom),
    };
  })).toEqual({
    cssWidth: "96px",
    cssMinHeight: "32px",
    cardWidth: 96,
    cardHeight: 32,
    wrapperWidth: 96,
    wrapperHeight: 32,
  });
});

test("one-line production cards name their recipe and product instead of the host building", async ({ page }) => {
  await seedCanvas(page, {
    count: 3,
    detail: "minimal",
    overlap: "all",
    interactionDetail: "base",
    productionRecipe: true,
    spacingX: 340,
    zoom: 1,
  });
  const compact = page.locator('.react-flow__node[data-id="anonymous-node-0"] .factory-node-compact');
  await expect(compact).toBeVisible();
  await expect(compact.locator("strong")).toHaveText("金伯利矿提炼 · 金刚石");
  await expect(compact).toHaveAttribute("title", /配方：金伯利矿提炼；产物：金刚石/);
  await expect(compact).not.toContainText("电弧熔炉");
});

test("network focus keeps interaction cards opaque and permits panning from contextual nodes", async ({ page }) => {
  await seedCanvas(page, {
    count: 4,
    detail: "medium",
    overlap: "all",
    interactionDetail: "hover",
    networkFocus: true,
    spacingX: 190,
    zoom: 1,
  });
  await page.locator('.react-flow__edge[data-id="anonymous-edge-focus"]').dispatchEvent("dblclick");
  await expect(page.locator(".network-focus-indicator")).toBeVisible();

  const contextual = page.locator('.react-flow__node[data-id="anonymous-node-2"]');
  await expect(contextual).toHaveClass(/factory-flow-node--network-dim/);
  await expect.poll(() => contextual.evaluate((element) => ({
    opacity: Number(getComputedStyle(element).opacity),
    draggable: element.classList.contains("draggable"),
    noPan: element.classList.contains("nopan"),
  }))).toEqual({ opacity: 0.5, draggable: false, noPan: false });

  const visibilitySamples = await contextual.evaluate((wrapper) => {
    const target = window as typeof window & {
      __canvasLodVisibilityRecorder?: { samples: string[]; stop: () => void };
    };
    const samples: string[] = [];
    let active = true;
    const sample = () => {
      if (!active) return;
      samples.push(getComputedStyle(wrapper).visibility);
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    target.__canvasLodVisibilityRecorder = { samples, stop: () => { active = false; } };
    return samples.length;
  });
  expect(visibilitySamples).toBe(0);
  await contextual.hover();
  await expect(contextual).toHaveClass(/factory-flow-node--lod-full/);
  await expect(contextual).not.toHaveClass(/factory-flow-node--network-dim/);
  await expect.poll(() => contextual.evaluate((element) => ({
    draggable: element.classList.contains("draggable"),
    noPan: element.classList.contains("nopan"),
  }))).toEqual({ draggable: false, noPan: false });
  await expectNodePaintedAndHitTestable(contextual);
  const hiddenDuringExpansion = await page.evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const recorder = (window as typeof window & {
      __canvasLodVisibilityRecorder?: { samples: string[]; stop: () => void };
    }).__canvasLodVisibilityRecorder;
    recorder?.stop();
    return recorder?.samples.includes("hidden") ?? true;
  });
  expect(hiddenDuringExpansion).toBe(false);

  // Move to a stable target outside React Flow before switching contextual
  // cards. Expanded neighbours overlap by design, so asking Playwright to
  // hover the covered wrapper would not model a real pointer transition.
  await page.getByText("DSP极简网络", { exact: true }).hover();
  await expect(contextual).toHaveClass(/factory-flow-node--network-dim/);
  const panTarget = page.locator('.react-flow__node[data-id="anonymous-node-3"]');
  await panTarget.hover();
  await expect(panTarget).toHaveClass(/factory-flow-node--lod-full/);
  await expect(panTarget).not.toHaveClass(/factory-flow-node--network-dim/);
  await expect.poll(() => panTarget.evaluate((element) => ({
    draggable: element.classList.contains("draggable"),
    noPan: element.classList.contains("nopan"),
  }))).toEqual({ draggable: false, noPan: false });
  const beforeTransform = await page.locator(".react-flow__viewport").evaluate((element) => getComputedStyle(element).transform);
  const panBox = await panTarget.locator("article.factory-node").boundingBox();
  if (!panBox) throw new Error("contextual focus node has no pan geometry");
  await page.mouse.move(panBox.x + panBox.width / 2, panBox.y + panBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(panBox.x + panBox.width / 2 + 80, panBox.y + panBox.height / 2 + 40, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => page.locator(".react-flow__viewport").evaluate((element) => getComputedStyle(element).transform)).not.toBe(beforeTransform);

  await page.getByRole("button", { name: "关闭运输网络聚焦" }).focus();
  await expect(panTarget).toHaveClass(/factory-flow-node--network-dim/);
  await contextual.hover();
  await expectNodePaintedAndHitTestable(contextual);
  await contextual.click();
  await expect(page.locator(".network-focus-indicator")).toHaveCount(0);
  await expect(contextual).toHaveClass(/selected/);
  await expect(contextual).toHaveClass(/draggable/);
  await expectNodePaintedAndHitTestable(contextual);
});

test("dense viewport virtualization and minimap follow an in-progress pan", async ({ page }) => {
  await seedCanvas(page, {
    count: 800,
    detail: "minimal",
    overlap: "all",
    interactionDetail: "hover",
    spacingX: 500,
    savedViewport: { x: 120, y: 100, zoom: 1 },
  });
  const shell = page.locator(".game-shell");
  const pane = page.locator(".react-flow__pane");
  const viewport = page.locator(".react-flow__viewport");
  const minimap = page.getByRole("img", { name: "低频画布小地图" });
  await expect(shell).toHaveAttribute("data-canvas-viewport-culling", "true");
  await expect(minimap).toBeVisible();
  const paneBox = await pane.boundingBox();
  if (!paneBox) throw new Error("dense pan fixture has no pane geometry");

  const before = await page.evaluate(() => ({
    transform: getComputedStyle(document.querySelector<HTMLElement>(".react-flow__viewport")!).transform,
    visibleCount: Number(document.querySelector<HTMLElement>(".game-shell")!.dataset.canvasVisibleNodeCount),
    drawCount: Number(document.querySelector<HTMLCanvasElement>('canvas[aria-label="低频画布小地图"]')!.dataset.drawCount),
    mountedIds: [...document.querySelectorAll<HTMLElement>('.react-flow__node[data-id^="anonymous-node-"]')]
      .map((node) => node.dataset.id),
  }));
  await page.mouse.move(paneBox.x + paneBox.width * 0.75, paneBox.y + paneBox.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(paneBox.x + paneBox.width * 0.15, paneBox.y + paneBox.height * 0.5, { steps: 12 });
  await expect.poll(() => viewport.evaluate((element) => getComputedStyle(element).transform)).not.toBe(before.transform);
  await expect.poll(() => page.evaluate((snapshot) => {
    const visibleCount = Number(document.querySelector<HTMLElement>(".game-shell")!.dataset.canvasVisibleNodeCount);
    const drawCount = Number(document.querySelector<HTMLCanvasElement>('canvas[aria-label="低频画布小地图"]')!.dataset.drawCount);
    const mountedIds = [...document.querySelectorAll<HTMLElement>('.react-flow__node[data-id^="anonymous-node-"]')]
      .map((node) => node.dataset.id ?? "");
    return {
      visibleChanged: visibleCount !== snapshot.visibleCount,
      minimapChanged: drawCount > snapshot.drawCount,
      mountedSetChanged: mountedIds.some((id) => !snapshot.mountedIds.includes(id)),
    };
  }, before)).toEqual({ visibleChanged: true, minimapChanged: true, mountedSetChanged: true });
  await page.mouse.up();
});

test("dense canvas remains selectable, draggable and placement-aligned after panning", async ({ page }) => {
  await seedCanvas(page, {
    count: 800,
    blueprint: true,
    detail: "minimal",
    overlap: "all",
    interactionDetail: "selected",
    spacingX: 500,
    savedViewport: { x: 120, y: 100, zoom: 1 },
  });
  const pane = page.locator(".react-flow__pane");
  const paneBox = await pane.boundingBox();
  if (!paneBox) throw new Error("dense interaction fixture has no pane geometry");
  await page.mouse.move(paneBox.x + paneBox.width * 0.76, paneBox.y + paneBox.height * 0.45);
  await page.mouse.down();
  await page.mouse.move(paneBox.x + paneBox.width * 0.22, paneBox.y + paneBox.height * 0.45, { steps: 12 });
  await page.mouse.up();

  const targetId = await page.evaluate(() => {
    const flow = document.querySelector<HTMLElement>(".factory-canvas .react-flow");
    if (!flow) return null;
    const flowBounds = flow.getBoundingClientRect();
    return [...document.querySelectorAll<HTMLElement>('.react-flow__node[data-id^="anonymous-node-"]')]
      .find((node) => {
        const bounds = node.getBoundingClientRect();
        const centerX = bounds.left + bounds.width / 2;
        const centerY = bounds.top + bounds.height / 2;
        const hit = document.elementFromPoint(centerX, centerY);
        return centerX > flowBounds.left + 30 && centerX < flowBounds.right - 30 &&
          centerY > flowBounds.top + 30 && centerY < flowBounds.bottom - 120 &&
          Boolean(hit && (hit === node || node.contains(hit)));
      })?.dataset.id ?? null;
  });
  expect(targetId).not.toBeNull();
  const target = page.locator(`.react-flow__node[data-id="${targetId}"]`);
  await target.click({ force: true });
  await expect(target).toHaveClass(/selected/);
  await expect(target).toHaveClass(/factory-flow-node--lod-full/);
  await expectNodePaintedAndHitTestable(target);

  const beforeDragTransform = await target.evaluate((element) => getComputedStyle(element).transform);
  const beforeDragStopCount = Number(await page.locator(".factory-canvas").getAttribute("data-drag-stop-count") ?? 0);
  const dragBox = await target.locator(".factory-node__header").boundingBox();
  if (!dragBox) throw new Error("expanded dense node has no drag header");
  await page.mouse.move(dragBox.x + dragBox.width * 0.55, dragBox.y + dragBox.height * 0.55);
  await page.mouse.down();
  await page.mouse.move(dragBox.x + dragBox.width * 0.55 + 42, dragBox.y + dragBox.height * 0.55 + 22, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => Number(await page.locator(".factory-canvas").getAttribute("data-drag-stop-count") ?? 0))
    .toBeGreaterThan(beforeDragStopCount);
  await expect.poll(() => target.evaluate((element) => getComputedStyle(element).transform)).not.toBe(beforeDragTransform);

  await page.getByLabel("框选模式").click();
  await page.mouse.move(paneBox.x + 8, paneBox.y + 8);
  await page.mouse.down();
  await page.mouse.move(paneBox.x + paneBox.width - 8, paneBox.y + paneBox.height - 120, { steps: 10 });
  await page.mouse.up();
  await expect.poll(() => page.locator(".react-flow__node.selected").count()).toBeGreaterThan(0);
  await page.getByLabel("指针模式").click();

  const existingIds = await page.locator(".react-flow__node[data-id]").evaluateAll((nodes) =>
    nodes.map((node) => (node as HTMLElement).dataset.id ?? ""));
  await page.getByTitle("部署小型储物仓", { exact: true }).click();
  const clickPosition = { x: paneBox.width * 0.52, y: paneBox.height * 0.72 };
  const expected = await page.evaluate(({ x, y }) => {
    const flow = document.querySelector<HTMLElement>(".factory-canvas .react-flow")!;
    const viewport = document.querySelector<HTMLElement>(".react-flow__viewport")!;
    const bounds = flow.getBoundingClientRect();
    const matrix = new DOMMatrixReadOnly(getComputedStyle(viewport).transform);
    const snap = (value: number) => Math.round(value / 20) * 20;
    return {
      x: snap((bounds.left + x - bounds.left - matrix.e) / matrix.a),
      y: snap((bounds.top + y - bounds.top - matrix.f) / matrix.d),
    };
  }, clickPosition);
  await pane.click({ position: clickPosition });
  const findPlacedId = async () => {
    const ids = await page.locator(".react-flow__node[data-id]").evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLElement).dataset.id ?? ""));
    return ids.find((id) => !existingIds.includes(id)) ?? null;
  };
  await expect.poll(findPlacedId).not.toBeNull();
  const placedId = await findPlacedId();
  if (!placedId) throw new Error("placed dense node did not mount in the clicked viewport");
  const placed = page.locator(`.react-flow__node[data-id="${placedId}"]`);
  await expect.poll(() => placed.evaluate((element) => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
    return { x: matrix.e, y: matrix.f };
  })).toEqual(expected);
});

test("a large translated compact viewport still paints and hit-tests its one-line card", async ({ page }) => {
  await seedCanvas(page, {
    count: 50,
    detail: "minimal",
    overlap: "all",
    interactionDetail: "base",
    spacingX: 500,
    savedViewport: { x: -9_700, y: 180, zoom: 0.84 },
  });
  const target = page.locator('.react-flow__node[data-id="anonymous-node-24"] .factory-node-compact');
  await expect(target).toBeVisible();
  await expect.poll(() => target.evaluate((element) => {
    const viewport = document.querySelector<HTMLElement>(".react-flow__viewport");
    const flow = document.querySelector<HTMLElement>(".factory-canvas .react-flow");
    if (!viewport || !flow) return { translated: false, inCanvas: false, hit: false };
    const transform = new DOMMatrixReadOnly(getComputedStyle(viewport).transform);
    const bounds = element.getBoundingClientRect();
    const flowBounds = flow.getBoundingClientRect();
    const centerX = bounds.left + bounds.width / 2;
    const centerY = bounds.top + bounds.height / 2;
    const hit = document.elementFromPoint(centerX, centerY);
    return {
      translated: Math.abs(transform.e) > 5_000,
      inCanvas: centerX > flowBounds.left && centerX < flowBounds.right && centerY > flowBounds.top && centerY < flowBounds.bottom,
      hit: hit === element || Boolean(hit && element.contains(hit)),
    };
  })).toEqual({ translated: true, inCanvas: true, hit: true });
});

test("Fit View recovers a fully deferred blank saved viewport", async ({ page }) => {
  await seedCanvas(page, {
    count: 500,
    detail: "minimal",
    overlap: "marker",
    interactionDetail: "base",
    savedViewport: { x: -1_000_000, y: -1_000_000, zoom: 0.32 },
  });
  const shell = page.locator(".game-shell");
  const canvas = page.locator(".factory-canvas");
  await expect(shell).toHaveAttribute("data-canvas-visible-node-count", "0");
  await expect(canvas).toHaveAttribute("data-flow-fully-deferred", "true");

  await page.locator(".react-flow__controls-fitview").click();
  await expect.poll(async () => Number(await shell.getAttribute("data-canvas-visible-node-count"))).toBeGreaterThan(0);
  await expect(canvas).toHaveAttribute("data-flow-fully-deferred", "false");
  await expect.poll(() => page.locator(".factory-node-compact, .factory-node-stack-marker").count()).toBeGreaterThan(0);
});

test("count-marker overlap mode never leaves an exact stack visually empty", async ({ page }) => {
  await seedCanvas(page, { count: 50, exactStack: 50, overlap: "marker", interactionDetail: "selected" });
  const shell = page.locator(".game-shell");
  await expect(shell).toHaveAttribute("data-canvas-overlap-preference", "marker");
  await expect(shell).toHaveAttribute("data-canvas-interaction-detail-preference", "selected");
  await expect.poll(async () => Number(await shell.getAttribute("data-canvas-stack-hidden-count"))).toBe(49);
  await expect(shell).toHaveAttribute("data-canvas-stack-marker-count", "1");

  const marker = page.locator(".factory-node-stack-marker");
  await expect(marker).toHaveCount(1);
  await expect(marker).toContainText("50");
  const markerBox = await marker.boundingBox();
  expect(markerBox?.width).toBeCloseTo(88, 0);
  expect(markerBox?.height).toBeCloseTo(44, 0);
  expect(await marker.evaluate((element) => {
    const style = getComputedStyle(element);
    const action = element.querySelector<HTMLElement>(".factory-node-stack-marker__action");
    const visual = action ? getComputedStyle(action, "::before") : null;
    return {
      interactive: Number(style.opacity) > 0 && style.visibility !== "hidden" && style.pointerEvents !== "none" &&
        Number.parseFloat(style.minHeight) >= 44,
      visualWidth: visual ? Number.parseFloat(visual.width) + Number.parseFloat(visual.borderLeftWidth) + Number.parseFloat(visual.borderRightWidth) : 0,
      visualHeight: visual ? Number.parseFloat(visual.height) + Number.parseFloat(visual.borderTopWidth) + Number.parseFloat(visual.borderBottomWidth) : 0,
    };
  })).toEqual({ interactive: true, visualWidth: 80, visualHeight: 30 });

  const action = marker.getByRole("button", { name: /此处叠放 50 个独立建筑/ });
  await action.focus();
  await expect(action).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(shell).toHaveAttribute("data-canvas-stack-marker-count", "0");
  await expect(page.locator('.react-flow__node[data-id="anonymous-node-0"]')).toHaveClass(/selected/);
  await expect(page.locator('.react-flow__node[data-id="anonymous-node-0"]')).toHaveClass(/factory-flow-node--lod-full/);
  await expectNodePaintedAndHitTestable(page.locator('.react-flow__node[data-id="anonymous-node-0"]'));
  await expect(page.locator(".factory-node-stack-badge")).toContainText("叠 50");
  await expect(page.locator(".game-notice")).toContainText("已展开重叠建筑 1/50");

  const axe = await new AxeBuilder({ page })
    .include(".factory-canvas")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(axe.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical")).toEqual([]);
});

test("hover expansion promotes a count marker out of overlap hiding", async ({ page }) => {
  await seedCanvas(page, { count: 8, exactStack: 8, detail: "minimal", overlap: "marker", interactionDetail: "hover" });
  const marker = page.locator(".factory-node-stack-marker").first();
  await expect(marker).toBeVisible();
  const markerId = await marker.evaluate((element) => element.closest<HTMLElement>(".react-flow__node[data-id]")?.dataset.id);
  expect(markerId).toBeTruthy();
  const wrapper = page.locator(`.react-flow__node[data-id="${markerId}"]`);
  await marker.hover();
  await expect(wrapper).toHaveClass(/factory-flow-node--lod-full/);
  await expect(wrapper).not.toHaveClass(/factory-flow-node--stack-marker/);
  await expect(wrapper.locator('.factory-node[data-heavy-card="true"]')).toBeVisible();
  await expectNodePaintedAndHitTestable(wrapper);
});

test("full plus all cards uses a uniform emergency stage without disabling interaction expansion", async ({ page }) => {
  test.setTimeout(90_000);
  await seedCanvas(page, {
    count: 1_200,
    exactStack: 1_200,
    detail: "full",
    overlap: "all",
    interactionDetail: "hover",
  });
  const shell = page.locator(".game-shell");
  await expect(shell).toHaveAttribute("data-canvas-detail-preference", "full");
  await expect(shell).toHaveAttribute("data-canvas-overlap-preference", "all");
  await expect(shell).toHaveAttribute("data-canvas-full-all-safety", "compact");
  await expect(shell).toHaveAttribute("data-canvas-detail-stage", "compact");
  await expect(page.locator('.factory-node[data-heavy-card="true"]')).toHaveCount(0);
  await expect.poll(() => page.locator('.factory-node-compact[data-compact-label]').count()).toBeGreaterThan(1_000);

  const target = page.locator('.react-flow__node[data-id="anonymous-node-0"]');
  await target.hover();
  await expect(target).toHaveClass(/factory-flow-node--lod-full/);
  await expect(page.locator('.factory-node[data-heavy-card="true"]')).toHaveCount(1);
  await expectNodePaintedAndHitTestable(target);
});

test("count marker and canvas controls stay usable across target phone sizes and font scales", async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript((key) => window.localStorage.setItem(key, "next"), MOBILE_UI_KEY);
  await seedCanvas(page, {
    count: 50,
    exactStack: 50,
    overlap: "marker",
    interactionDetail: "selected",
    viewport: { width: 390, height: 844 },
  });
  const shell = page.locator(".game-shell");
  const markerAction = page.getByRole("button", { name: /此处叠放 50 个独立建筑/ });
  const viewports = [
    { width: 390, height: 844, layout: "compact-portrait" },
    { width: 360, height: 640, layout: "compact-portrait" },
    { width: 844, height: 390, layout: "compact-landscape" },
  ];

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await expect(shell).toHaveAttribute("data-compact-layout", viewport.layout);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.locator(".react-flow__controls-fitview").dispatchEvent("click");
    await expect(markerAction).toBeVisible();
    await expect.poll(() => page.evaluate(() => {
      const action = document.querySelector<HTMLElement>(".factory-node-stack-marker__action");
      if (!action) return { visible: false, touchTarget: false, overflowFree: false };
      const bounds = action.getBoundingClientRect();
      const visibleWidth = Math.max(0, Math.min(window.innerWidth, bounds.right) - Math.max(0, bounds.left));
      const visibleHeight = Math.max(0, Math.min(window.innerHeight, bounds.bottom) - Math.max(0, bounds.top));
      return {
        visible: visibleWidth >= 64 && visibleHeight >= 22,
        touchTarget: bounds.width >= 44 && bounds.height >= 43.5,
        overflowFree: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      };
    })).toEqual({ visible: true, touchTarget: true, overflowFree: true });
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.locator(".react-flow__controls-fitview").dispatchEvent("click");
  const markerBounds = await markerAction.boundingBox();
  const paneBounds = await page.locator(".react-flow__pane").boundingBox();
  if (!markerBounds || !paneBounds) throw new Error("mobile canvas marker geometry is unavailable");
  const markerCenter = { x: markerBounds.x + markerBounds.width / 2, y: markerBounds.y + markerBounds.height / 2 };
  const dragStart = { x: paneBounds.x + paneBounds.width / 2, y: paneBounds.y + paneBounds.height * .72 };
  await page.mouse.move(dragStart.x, dragStart.y);
  await page.mouse.down();
  await page.mouse.move(dragStart.x + 190 - markerCenter.x, dragStart.y + 220 - markerCenter.y, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => markerAction.evaluate((action) => {
    const bounds = action.getBoundingClientRect();
    const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
    return hit === action || Boolean(hit && action.contains(hit));
  })).toBe(true);
  await markerAction.click();
  await expect(page.locator('.react-flow__node[data-id="anonymous-node-0"]')).toHaveClass(/selected/);

  await page.evaluate(() => {
    document.documentElement.dataset.uiFontScale = "100";
    document.documentElement.style.setProperty("--ui-font-scale", "1");
  });
  await page.getByRole("button", { name: "更多", exact: true }).click();
  await page.getByRole("button", { name: /游戏设置/ }).click();
  const settings = page.locator(".operations-workspace");
  await expect(settings).toBeVisible();
  await selectSettingsCategory(settings, "终局性能", "performance");
  const groups = [
    settings.getByRole("radiogroup", { name: "画布基础卡片" }),
    settings.getByRole("radiogroup", { name: "重叠建筑显示方式" }),
    settings.getByRole("radiogroup", { name: "交互卡片展开方式" }),
  ];

  for (const scale of [80, 100, 125, 150, 200]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.uiFontScale = String(value);
      document.documentElement.style.setProperty("--ui-font-scale", String(value / 100));
    }, scale);
    await expect.poll(() => settings.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    for (const group of groups) {
      await expect(group).toBeVisible();
      expect(await group.getByRole("radio").evaluateAll((buttons) => buttons.every((button) => {
        const bounds = button.getBoundingClientRect();
        return bounds.width >= 44 && bounds.height >= 44 && button.scrollWidth <= button.clientWidth + 1 && button.scrollHeight <= button.clientHeight + 1;
      })), `${scale}% ${await group.getAttribute("aria-label")}`).toBe(true);
    }
  }

  await page.evaluate(() => {
    document.documentElement.dataset.uiFontScale = "100";
    document.documentElement.style.setProperty("--ui-font-scale", "1");
  });
});

test("all-card overlap mode keeps every entity and one explicit stack badge", async ({ page }) => {
  await seedCanvas(page, { count: 8, exactStack: 8, overlap: "all", interactionDetail: "base" });
  const shell = page.locator(".game-shell");
  await expect(shell).toHaveAttribute("data-canvas-overlap-preference", "all");
  await expect(shell).toHaveAttribute("data-canvas-stack-hidden-count", "0");
  await expect(shell).toHaveAttribute("data-canvas-stack-marker-count", "0");
  await expect(page.locator('.react-flow__node[data-id^="anonymous-node-"]')).toHaveCount(8);
  await expect(page.locator(".factory-node-stack-badge")).toHaveCount(1);
  await expect(page.locator(".factory-node-stack-badge")).toContainText("叠 8");
  await page.locator(".factory-node-stack-badge").click();
  await expect(page.locator('.react-flow__node[data-id="anonymous-node-1"]')).toHaveClass(/selected/);
  await expect(page.locator('.react-flow__node[data-id="anonymous-node-1"]')).toHaveClass(/factory-flow-node--lod-full/);
});

test("fixed medium follows the current viewport and keeps hover expansion independently configurable", async ({ page }) => {
  await seedCanvas(page, { count: 50, detail: "medium", overlap: "representative", interactionDetail: "selected", spacingX: 340 });
  const shell = page.locator(".game-shell");
  await expect(shell).toHaveAttribute("data-canvas-detail-preference", "medium");
  await expect(shell).toHaveAttribute("data-canvas-detail-stage", "medium");
  await page.locator(".react-flow__controls-fitview").click();

  await expect.poll(async () => page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>(".react-flow")?.getBoundingClientRect();
    if (!viewport) return -1;
    return [...document.querySelectorAll<HTMLElement>('.react-flow__node[data-id^="anonymous-node-"]')]
      .filter((node) => {
        const bounds = node.getBoundingClientRect();
        return bounds.right >= viewport.left && bounds.left <= viewport.right && bounds.bottom >= viewport.top && bounds.top <= viewport.bottom;
      })
      .filter((node) => node.querySelector('[data-node-lod="compact"]')).length;
  })).toBe(0);

  const visibleMedium = page.locator('.react-flow__node[data-id^="anonymous-node-"] .factory-node[data-node-lod="medium"]');
  await expect.poll(() => visibleMedium.count()).toBeGreaterThan(0);
  const visibleMediumId = await page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>(".react-flow")?.getBoundingClientRect();
    if (!viewport) return null;
    return [...document.querySelectorAll<HTMLElement>('.react-flow__node[data-id^="anonymous-node-"]')].find((candidate) => {
      const bounds = candidate.getBoundingClientRect();
      const centerX = bounds.left + bounds.width / 2;
      const centerY = bounds.top + bounds.height / 2;
      const hitNode = document.elementFromPoint(centerX, centerY)?.closest<HTMLElement>(".react-flow__node[data-id]");
      return bounds.right >= viewport.left && bounds.left <= viewport.right && bounds.bottom >= viewport.top && bounds.top <= viewport.bottom &&
        hitNode === candidate && Boolean(candidate.querySelector('[data-node-lod="medium"]'));
    })?.dataset.id ?? null;
  });
  expect(visibleMediumId).not.toBeNull();
  const node = page.locator(`.react-flow__node[data-id="${visibleMediumId}"]`);
  await node.hover();
  await expect(node).toHaveClass(/factory-flow-node--lod-medium/);
  await node.click({ force: true });
  await expect(node).toHaveClass(/factory-flow-node--lod-full/);
  await expectNodePaintedAndHitTestable(node);

  await page.getByLabel("打开设置").click();
  const settings = page.locator(".operations-workspace");
  await selectSettingsCategory(settings, "终局性能", "performance");
  await expect(settings.getByRole("radiogroup", { name: "画布基础卡片" }).getByRole("radio", { name: "中等" })).toHaveAttribute("aria-checked", "true");
  await expect(settings.getByRole("radiogroup", { name: "重叠建筑显示方式" }).getByRole("radio", { name: "代表卡片" })).toHaveAttribute("aria-checked", "true");
  await expect(settings.getByRole("radiogroup", { name: "交互卡片展开方式" }).getByRole("radio", { name: "仅选中" })).toHaveAttribute("aria-checked", "true");
  await settings.getByRole("radiogroup", { name: "交互卡片展开方式" }).getByRole("radio", { name: "悬停也展开" }).click();
  await expect(shell).toHaveAttribute("data-canvas-interaction-detail-preference", "hover");
  expect(await page.evaluate((key) => window.localStorage.getItem(key), CANVAS_INTERACTION_DETAIL_KEY)).toBe("hover");
  await page.keyboard.press("Escape");
  const hoverNodeId = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.react-flow__node[data-id^="anonymous-node-"]')].find((candidate) => {
    if (!candidate.querySelector('[data-node-lod="medium"]')) return false;
    const bounds = candidate.getBoundingClientRect();
    const hitNode = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)?.closest<HTMLElement>(".react-flow__node[data-id]");
    return hitNode === candidate;
  })?.dataset.id ?? null);
  expect(hoverNodeId).not.toBeNull();
  const hoverNode = page.locator(`.react-flow__node[data-id="${hoverNodeId}"]`);
  await hoverNode.hover();
  await expect(hoverNode).toHaveClass(/factory-flow-node--lod-full/);
  await expectNodePaintedAndHitTestable(hoverNode);
});

test("an exact 50-card stack paints one leader and glow while retaining hidden edge geometry", async ({ page }) => {
  test.setTimeout(60_000);
  await seedCanvas(page, { count: 50, exactStack: 50 });
  const shell = page.locator(".game-shell");
  await expect.poll(async () => Number(await shell.getAttribute("data-canvas-stack-hidden-count"))).toBe(49);
  await expect(shell).toHaveAttribute("data-canvas-detail-stage", "full");
  await expect(page.locator('.factory-node[data-heavy-card="true"]')).toHaveCount(7);
  await expect(page.locator('.react-flow__node[data-id^="anonymous-node-"] .factory-node[data-heavy-card="true"]')).toHaveCount(1);
  await expect(page.locator(".factory-node-stack-proxy")).toHaveCount(0);
  await expect(page.locator(".factory-node-stack-halo")).toHaveCount(1);
  await expect(page.locator(".factory-node-stack-badge")).toHaveCount(1);
  await expect(page.locator('.factory-node-stack-proxy[tabindex="0"]')).toHaveCount(0);
  const beltCanvas = page.locator("canvas.canvas-belt-layer");
  await expect(beltCanvas).toHaveAttribute("data-segments", "3");
  await expect(beltCanvas).toHaveAttribute("data-first-source-x", "96");
  await expect(beltCanvas).toHaveAttribute("data-first-source-y", "16");
  // The leader retains its measured full-card input port. Compare world
  // coordinates against the actual input handle, including its inset.
  const leaderInput = page.locator('.react-flow__node[data-id="anonymous-node-0"] .react-flow__handle[data-handleid="in:iron_ore"]');
  await expect(leaderInput).toBeVisible();
  await expect.poll(async () => leaderInput.evaluate((handle) => {
    const node = handle.closest<HTMLElement>(".react-flow__node")!;
    const viewport = document.querySelector<HTMLElement>(".react-flow__viewport")!;
    const canvas = document.querySelector<HTMLCanvasElement>("canvas.canvas-belt-layer")!;
    const zoom = new DOMMatrixReadOnly(getComputedStyle(viewport).transform).a;
    const nodeBox = node.getBoundingClientRect();
    const handleBox = handle.getBoundingClientRect();
    // anonymous-node-0 is fixed at world (0, 0) in this fixture.
    const expectedTargetX = (handleBox.left - nodeBox.left) / zoom;
    const expectedTargetY = (handleBox.top - nodeBox.top + handleBox.height / 2) / zoom;
    return Math.max(
      Math.abs(Number(canvas.dataset.firstTargetX) - expectedTargetX),
      Math.abs(Number(canvas.dataset.firstTargetY) - expectedTargetY),
    );
  })).toBeCloseTo(0, 1);
  await expect(beltCanvas).toHaveAttribute("data-first-route-mode", "1");
  await expect(beltCanvas).toHaveAttribute("data-first-route-center", "256");
  await expect(page.locator(".react-flow__edge")).toHaveCount(0);
  const hit = await page.evaluate(() => {
    const pane = document.querySelector<HTMLElement>(".react-flow__pane")!;
    const viewport = document.querySelector<HTMLElement>(".react-flow__viewport")!;
    const beltCanvas = document.querySelector<HTMLElement>("canvas.canvas-belt-layer")!;
    const bounds = pane.getBoundingClientRect();
    const matrix = new DOMMatrixReadOnly(getComputedStyle(viewport).transform);
    const routeCenter = Number(beltCanvas.dataset.firstRouteCenter);
    return { x: bounds.left + matrix.e + 48 * matrix.a, y: bounds.top + matrix.f + routeCenter * matrix.d };
  });
  await page.mouse.move(hit.x, hit.y);
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  const hiddenWrappers = page.locator('.react-flow__node[data-stack-hidden-wrapper="true"]');
  await expect(hiddenWrappers).toHaveCount(1);
  expect(await hiddenWrappers.evaluateAll((nodes) => nodes.every((node) =>
    !node.hasAttribute("tabindex") && node.getAttribute("aria-hidden") === "true" &&
    getComputedStyle(node).pointerEvents === "none",
  ))).toBe(true);
  expect(await hiddenWrappers.first().evaluate((node) => {
    (node as HTMLElement).focus();
    return document.activeElement !== node;
  })).toBe(true);
  await expect(page.locator('.factory-node-stack-proxy[data-retains-edge-geometry="true"]')).toHaveCount(1);
  expect(await page.locator(".factory-node-stack-proxy .react-flow__handle").count()).toBeGreaterThan(0);
  await page.mouse.click(hit.x, hit.y);
  await expect(page.locator(".react-flow__edge.selected")).toHaveCount(1);
  expect(await page.locator(".factory-node-stack-proxy").evaluateAll((nodes) => nodes.every((node) => {
    const style = getComputedStyle(node);
    return style.opacity === "0" && style.pointerEvents === "none";
  }))).toBe(true);

  const leader = page.locator('.react-flow__node[data-id="anonymous-node-0"]');
  await leader.locator("article.factory-node").click({ position: { x: 12, y: 12 } });
  await expect(leader).toHaveClass(/selected/);
  await page.locator(".factory-node-stack-badge").focus();
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement?.closest('.react-flow__node[data-stack-hidden-wrapper="true"]') === null)).toBe(true);
  const axe = await new AxeBuilder({ page })
    .include(".factory-canvas")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(axe.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical")).toEqual([]);

  const before: string | null = null;
  await page.locator(".factory-node-stack-badge").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(1);
  const after = await page.locator(".react-flow__node.selected").getAttribute("data-id");
  expect(after).not.toBe(before);
  await expect(page.locator('.factory-node[data-heavy-card="true"]')).toHaveCount(7);
  await page.getByLabel("打开设置").focus();
  await expect(page.locator('.factory-node[data-heavy-card="true"]')).toHaveCount(7);
  await expect(page.locator(".factory-node-stack-halo")).toHaveCount(1);
});

test("a hidden stack member alert is aggregated and cycling expands the alerted member", async ({ page }) => {
  await seedCanvas(page, { count: 50, exactStack: 50, hiddenStackAlert: true });
  const badge = page.locator(".factory-node-stack-badge");
  await expect(badge).toHaveAttribute("data-stack-alert-count", "1");
  await expect(badge).toContainText("⚠1");
  await expect(page.locator(".factory-node-stack-halo--alert")).toHaveCount(1);
  await badge.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator('.react-flow__node[data-id="anonymous-node-1"]')).toHaveClass(/selected/);
  await page.getByLabel("打开设置").focus();
  await expect(page.locator('.react-flow__node[data-id="anonymous-node-1"]')).toHaveClass(/factory-flow-node--lod-full/);
  await expect(page.locator(".factory-node-stack-halo")).toHaveCount(1);
  await expect(page.locator(".factory-node-stack-badge")).toHaveAttribute("data-stack-alert-count", "1");
});

test("auto detail keeps a 500-visible paused canvas static across continue and pause", async ({ page }) => {
  await seedCanvas(page, { count: 500, detail: "damaged" });
  const shell = page.locator(".game-shell");
  const canvas = page.locator(".factory-canvas");
  await expect(shell).toHaveAttribute("data-canvas-detail-preference", "auto");
  await expect(shell).toHaveAttribute("data-canvas-detail-stage", "compact");
  await expect.poll(async () => Number(await shell.getAttribute("data-canvas-visible-node-count"))).toBeGreaterThanOrEqual(360);
  await expect(page.locator('.factory-node[data-heavy-card="true"]')).toHaveCount(0);
  await expect(page.locator(".work-cycle")).toHaveCount(0);

  const continueMs = await togglePauseAndMeasure(page, "继续模拟");
  await expect(shell).toHaveAttribute("data-simulation-paused", "false");
  await expect.poll(async () => Number(await canvas.getAttribute("data-changed-node-count"))).toBe(0);
  expect(Number(await canvas.getAttribute("data-stable-node-count"))).toBeGreaterThanOrEqual(490);
  const pauseMs = await togglePauseAndMeasure(page, "暂停模拟");
  await expect(shell).toHaveAttribute("data-simulation-paused", "true");
  await expect.poll(async () => Number(await canvas.getAttribute("data-changed-node-count"))).toBe(0);
  console.log("v144 500-visible pause gate", JSON.stringify({ continueMs, pauseMs, diagnostics: await canvas.evaluate((element) => ({ ...((element as HTMLElement).dataset) })) }));
  if (process.env.DSP_E2E_USE_PREVIEW === "1") {
    expect(continueMs).toBeLessThanOrEqual(50);
    expect(pauseMs).toBeLessThanOrEqual(50);
  }

  await page.getByLabel("打开设置").click();
  const settings = page.locator(".operations-workspace");
  await selectSettingsCategory(settings, "终局性能", "performance");
  await expect(settings.getByRole("radiogroup", { name: "画布基础卡片" }).getByRole("radio", { name: "自动" })).toHaveAttribute("aria-checked", "true");
  await expect(settings.locator(".canvas-detail-diagnostics")).toContainText(String(await shell.getAttribute("data-canvas-visible-node-count")));
});

test("a 4213-visible exact stack derives linearly with bounded heavy DOM", async ({ page }) => {
  test.setTimeout(90_000);
  await seedCanvas(page, { count: 4_213, exactStack: 4_213 });
  const shell = page.locator(".game-shell");
  const canvas = page.locator(".factory-canvas");
  await expect(shell).toHaveAttribute("data-canvas-detail-stage", "compact");
  await expect.poll(async () => Number(await shell.getAttribute("data-canvas-visible-node-count"))).toBeGreaterThanOrEqual(4_213);
  await expect(page.locator('.factory-node[data-heavy-card="true"]')).toHaveCount(0);
  await expect(page.locator(".work-cycle")).toHaveCount(0);
  await expect(page.locator(".factory-node-stack-proxy")).toHaveCount(0);
  await expect(page.locator('.react-flow__node[data-id^="anonymous-node-"]')).toHaveCount(1);
  await expect(page.locator(".factory-node-stack-halo")).toHaveCount(1);
  await expect(canvas).toHaveAttribute("data-batch-renderer", "true");
  await expect(page.locator("canvas.canvas-belt-layer")).toHaveAttribute("data-segments", "3");
  await expect(page.locator(".react-flow__edge")).toHaveCount(0);
  const pauseMs = await togglePauseAndMeasure(page, "继续模拟");
  await expect.poll(async () => Number(await canvas.getAttribute("data-changed-node-count"))).toBe(0);
  const diagnostics = await canvas.evaluate((element) => ({ ...((element as HTMLElement).dataset) }));
  expect(Number(diagnostics.stackMembershipTokenCompareCount)).toBeLessThanOrEqual(4_219);
  expect(Number(diagnostics.stackMemberIdReferenceCount)).toBeLessThanOrEqual(4_219);
  console.log("v144 4213-visible second-paint gate", JSON.stringify({ pauseMs, diagnostics }));
  if (process.env.DSP_E2E_USE_PREVIEW === "1") {
    expect(pauseMs).toBeLessThanOrEqual(100);
    expect(Number(diagnostics.nodeDerivationMs)).toBeLessThanOrEqual(100);
  }
});

test("disabling Canvas belts restores exact-stack React Flow endpoint proxies", async ({ page }) => {
  await seedCanvas(page, { count: 50, exactStack: 50 });
  await expect(page.locator(".factory-canvas")).toHaveAttribute("data-batch-renderer", "true");
  await expect(page.locator(".factory-node-stack-proxy")).toHaveCount(0);
  await expect(page.locator(".react-flow__edge")).toHaveCount(0);

  await page.getByLabel("打开设置").click();
  const settings = page.locator(".operations-workspace");
  await selectSettingsCategory(settings, "终局性能", "performance");
  const canvasBelts = settings.locator("label.setting-row").filter({ hasText: "Canvas 批量线路" });
  await expect(canvasBelts.getByRole("checkbox")).toBeChecked();
  await canvasBelts.click();
  await expect(canvasBelts.getByRole("checkbox")).not.toBeChecked();
  await page.getByLabel("设置已打开，再次点击返回工厂").click();

  await expect(page.locator(".factory-canvas")).toHaveAttribute("data-batch-renderer", "false");
  await expect(page.locator("canvas.canvas-belt-layer")).toHaveCount(0);
  await expect(page.locator(".react-flow__edge")).toHaveCount(3);
  await expect(page.locator(".factory-node-stack-proxy")).toHaveCount(3);
  await expect(page.locator('.factory-node-stack-proxy[data-retains-edge-geometry="true"]')).toHaveCount(3);
});

test("multi-drag shares the exact-overlap policy and preserves relative layout", async ({ page }) => {
  test.setTimeout(60_000);
  await seedCanvas(page, { count: 3, blueprint: true, spacingX: 340 });
  const first = page.locator('.react-flow__node[data-id="anonymous-node-0"]');
  const second = page.locator('.react-flow__node[data-id="anonymous-node-1"]');
  await page.getByLabel("框选模式").click();
  await first.click({ force: true, position: { x: 20, y: 20 } });
  await second.click({ force: true, position: { x: 20, y: 20 } });
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(2);

  const dragGroupOneCell = async () => {
    const sourceBox = await first.locator(".factory-node__header").boundingBox();
    const targetBox = await second.locator(".factory-node__header").boundingBox();
    if (!sourceBox || !targetBox) throw new Error("multi-drag headers have no geometry");
    const startX = sourceBox.x + sourceBox.width / 2;
    const startY = sourceBox.y + sourceBox.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 320, startY + targetBox.y - sourceBox.y, { steps: 12 });
    await page.waitForTimeout(50);
    await page.mouse.up();
  };

  await dragGroupOneCell();
  await expect(page.locator(".factory-canvas")).toHaveAttribute("data-drag-primary-delta-x", "340");
  await expect(page.locator(".factory-canvas")).toHaveAttribute("data-drag-overlap-blocked", "true");
  await expect(page.locator(".factory-canvas")).toHaveAttribute("data-drag-moved-node-count", "2");
  await expect(page.locator(".factory-node-stack-badge")).toHaveCount(0);

  await page.getByLabel("打开设置").click();
  const settings = page.locator(".operations-workspace");
  await selectSettingsCategory(settings, "交互与控制", "interaction");
  const overlapSetting = settings.locator(".setting-row").filter({ hasText: "允许重叠放置" });
  await overlapSetting.click();
  await expect(overlapSetting.getByRole("checkbox")).toBeChecked();
  await expect(settings.getByRole("alert")).toContainText("不会合并存档或机器数量");
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
  await expect(page.locator(".game-shell")).toHaveAttribute("data-blueprint-allow-overlap", "true");
  expect(await page.evaluate((key) => window.localStorage.getItem(key), BLUEPRINT_OVERLAP_KEY)).toBe("true");
  await dragGroupOneCell();
  await expect(page.locator(".factory-canvas")).toHaveAttribute("data-drag-overlap-blocked", "false");
  await expect(page.locator(".factory-node-stack-badge")).toContainText("叠 2");
  await expect(first).not.toHaveAttribute("style", /translate\(0px, 0px\)/);
  await page.reload();
  await expect(page.locator(".game-shell")).toHaveAttribute("data-blueprint-allow-overlap", "true");
});

test("bulk selection keeps a 500-node drag compact except for its primary interaction target", async ({ page }) => {
  test.setTimeout(90_000);
  await seedCanvas(page, { count: 500 });
  await page.getByLabel("框选模式").click();
  const pane = page.locator(".react-flow__pane");
  const paneBox = await pane.boundingBox();
  if (!paneBox) throw new Error("bulk-selection pane has no geometry");
  await page.mouse.move(paneBox.x + 4, paneBox.y + 4);
  await page.mouse.down();
  await page.mouse.move(paneBox.x + paneBox.width - 4, paneBox.y + paneBox.height - 4, { steps: 8 });
  await page.mouse.up();
  const selected = page.locator(".react-flow__node.selected");
  await expect.poll(() => selected.count()).toBeGreaterThanOrEqual(300);
  await expect(page.locator('.factory-node[data-heavy-card="true"]')).toHaveCount(0);

  const primary = selected.first();
  const primaryBox = await primary.locator(".factory-node-compact > span").boundingBox();
  if (!primaryBox) throw new Error("bulk-drag primary has no compact geometry");
  await page.mouse.move(primaryBox.x + primaryBox.width / 2, primaryBox.y + primaryBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(primaryBox.x + primaryBox.width / 2 + 10, primaryBox.y + primaryBox.height / 2, { steps: 4 });
  await expect.poll(async () => Number(await page.locator(".factory-canvas").getAttribute("data-drag-active-count"))).toBeGreaterThanOrEqual(300);
  expect(await page.locator('.factory-node[data-heavy-card="true"]').count()).toBeLessThanOrEqual(1);
  await page.mouse.up();
  await expect.poll(async () => Number(await page.locator(".factory-canvas").getAttribute("data-drag-moved-node-count"))).toBeGreaterThanOrEqual(300);
});

test("compact commit boundary applies live connection geometry without a reload", async ({ page }) => {
  test.setTimeout(60_000);
  await seedCanvas(page, { count: 500 });
  const shell = page.locator(".game-shell");
  await expect(shell).toHaveAttribute("data-canvas-detail-stage", "compact");

  await page.getByLabel("打开设置").click();
  const settings = page.locator(".operations-workspace");
  await selectSettingsCategory(settings, "交互与控制", "interaction");
  await settings.getByRole("radiogroup", { name: "建筑连接点尺寸" }).getByRole("button", { name: "放大 50%" }).click();
  await settings.getByRole("radiogroup", { name: "建筑接口真实命中范围" }).getByRole("button", { name: "超大" }).click();
  await expect(shell).toHaveAttribute("data-connection-point-size", "large50");
  await expect(shell).toHaveAttribute("data-connection-hit-area", "huge");
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);

  const source = page.locator('.react-flow__node[data-id="anonymous-node-0"] .factory-handle--output').first();
  const target = page.locator('.react-flow__node[data-id="anonymous-node-1"] .factory-handle--input').first();
  await source.dispatchEvent("click", { button: 0 });
  await expect(shell).toHaveAttribute("data-connection-active", "true");
  const targetBox = await target.boundingBox();
  if (!targetBox) throw new Error("compact connection target has no geometry");
  const targetCenter = { x: targetBox.x + targetBox.width / 2, y: targetBox.y + targetBox.height / 2 };
  await page.mouse.move(targetCenter.x - 38, targetCenter.y, { steps: 6 });
  const preview = page.locator(".factory-click-connection-preview .factory-connection-preview");
  await expect(preview).toHaveClass(/factory-connection-preview--valid/);
  await page.mouse.click(targetCenter.x - 38, targetCenter.y);
  await expect(shell).toHaveAttribute("data-connection-active", "false");
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
});

test("blueprint exact overlap is rejected by default and explicit opt-in covers immediate and queued repeats", async ({ page }) => {
  await seedCanvas(page, { count: 1, blueprint: true, detail: "minimal" });
  await expect(page.locator(".game-shell")).toHaveAttribute("data-canvas-detail-stage", "compact");
  await page.getByLabel("打开蓝图库").click();
  const workspace = page.getByRole("dialog", { name: "蓝图与待建施工" });
  await workspace.locator(".blueprint-card").getByRole("button", { name: "部署", exact: true }).click();
  const option = page.locator(".canvas-placement-options");
  const checkbox = option.getByRole("checkbox", { name: /允许重叠放置/ });
  await expect(checkbox).not.toBeChecked();
  const nodeBounds = await page.locator('.react-flow__node[data-id="anonymous-node-0"]').boundingBox();
  if (!nodeBounds) throw new Error("blueprint collision fixture node has no geometry");
  const pane = page.locator(".react-flow__pane");
  await pane.dispatchEvent("click", { clientX: nodeBounds.x, clientY: nodeBounds.y, button: 0 });
  await expect(page.locator(".game-notice")).toContainText("目标吸附坐标已有建筑");
  await expect(page.locator(".react-flow__node")).toHaveCount(7);

  await checkbox.check();
  await expect(page.locator(".game-shell")).toHaveAttribute("data-blueprint-allow-overlap", "true");
  await expect(option.getByRole("alert")).toContainText("不会合并存档或机器数量");
  await pane.dispatchEvent("click", { clientX: nodeBounds.x, clientY: nodeBounds.y, button: 0 });
  await expect(page.locator(".game-shell")).toHaveAttribute("data-active-planet-node-count", "8");
  await expect(page.locator(".game-shell")).toHaveAttribute("data-canvas-stack-hidden-count", "1");
  await expect(page.locator(".react-flow__node")).toHaveCount(7);
  await expect(page.locator(".factory-node-stack-badge")).toContainText("叠 2");

  await pane.dispatchEvent("click", { clientX: nodeBounds.x, clientY: nodeBounds.y, button: 0 });
  await expect(page.locator(".game-notice")).toContainText("已加入施工队列");
  await expect(page.locator(".pending-blueprint-node")).toHaveCount(1);
  expect(await page.evaluate((key) => window.localStorage.getItem(key), BLUEPRINT_OVERLAP_KEY)).toBe("true");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(option).toBeVisible();
  expect((await option.getByRole("checkbox").boundingBox())!.height).toBeGreaterThanOrEqual(18);
  expect(await option.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
});

test("production preview records three identical pan/zoom runs for auto, full and expand-all", async ({ page }) => {
  test.skip(process.env.DSP_E2E_USE_PREVIEW !== "1", "frame budgets are measured against the production preview build");
  test.setTimeout(180_000);
  await seedCanvas(page, { count: 500, detail: "auto" });
  const shell = page.locator(".game-shell");
  await page.locator(".react-flow__controls-fitview").click();
  await expect.poll(async () => Number(await shell.getAttribute("data-canvas-visible-node-count"))).toBeGreaterThanOrEqual(500);
  await expect(shell).toHaveAttribute("data-canvas-detail-stage", "compact");
  // Let initial IndexedDB persistence and menu/account probes settle so the
  // three runs measure the steady paused-canvas gesture, not startup I/O.
  await page.waitForTimeout(2_500);

  const results: Record<string, Array<Record<string, number>>> = { auto: [], full: [], expandAll: [] };
  for (let run = 0; run < 3; run += 1) results.auto.push(await captureFrames(page, () => samePanZoomGesture(page)));

  await page.evaluate((key) => window.localStorage.setItem(key, "full"), CANVAS_DETAIL_KEY);
  await page.reload();
  await expect(shell).toHaveAttribute("data-canvas-detail-stage", "full");
  for (let run = 0; run < 3; run += 1) results.full.push(await captureFrames(page, () => samePanZoomGesture(page)));

  await page.evaluate(({ detailKey, connectKey }) => {
    window.localStorage.setItem(detailKey, "auto");
    window.localStorage.setItem(connectKey, "true");
  }, { detailKey: CANVAS_DETAIL_KEY, connectKey: "dsp-idle-network.ui.connect-expand-all.v1" });
  await page.reload();
  await expect(shell).toHaveAttribute("data-connect-expand-all", "true");
  await page.locator(".react-flow__controls-fitview").click();
  const sourceNode = page.locator('.react-flow__node[data-id="anonymous-node-499"]');
  const source = sourceNode.locator(".factory-handle--output").first();
  await expect(source).toHaveCount(1);
  await source.dispatchEvent("click", { button: 0 });
  await expect(shell).toHaveAttribute("data-connection-active", "true");
  await expect(sourceNode).toHaveClass(/factory-flow-node--lod-full/);
  await expect.poll(async () => Number(await shell.getAttribute("data-connection-full-logical-count"))).toBe(506);
  for (let run = 0; run < 3; run += 1) {
    results.expandAll.push(await captureFrames(page, () => samePanZoomGesture(page)));
    await expect(shell).toHaveAttribute("data-connection-active", "true");
    await expect.poll(async () => Number(await shell.getAttribute("data-connection-full-logical-count"))).toBe(506);
  }
  const counts = await page.locator(".factory-canvas").evaluate((canvas) => ({
    wrappers: canvas.querySelectorAll(".react-flow__node").length,
    heavy: canvas.querySelectorAll('[data-heavy-card="true"]').length,
    handles: canvas.querySelectorAll(".react-flow__handle").length,
    glow: canvas.querySelectorAll("[data-stack-glow=true]").length,
  }));
  await page.keyboard.press("Escape");
  console.log("v144 canvas density raw3", JSON.stringify({ results, counts }));

  for (const run of results.auto) {
    expect(run.samples).toBeGreaterThanOrEqual(20);
    expect(run.maxMs).toBeLessThanOrEqual(100);
  }
  // Windows Chrome reports rAF timestamps on the active display cadence. A
  // single 144 Hz run contains only about 34 samples, so two otherwise bounded
  // four-refresh intervals (27.8 ms) make that short run's discrete P95 equal
  // to 27.8 ms. Treat the three identical gestures as the intended sample
  // population: at most five percent may exceed the unchanged 21 ms budget,
  // while every individual run still has the independent 100 ms hard ceiling.
  const autoSamples = results.auto.reduce((sum, run) => sum + run.samples, 0);
  const autoOver21Ms = results.auto.reduce((sum, run) => sum + run.over21Ms, 0);
  expect(autoSamples).toBeGreaterThanOrEqual(60);
  expect(autoOver21Ms).toBeLessThanOrEqual(Math.floor(autoSamples * .05));
});
