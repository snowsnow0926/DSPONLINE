import { expect, test, type Page } from "@playwright/test";
import { createBlueprint, createInitialState, placeBuilding } from "../../src/game/engine";
import { selectSettingsCategory } from "./settings-helpers";

const CANVAS_DETAIL_KEY = "dsp-idle-network.ui.canvas-detail.v1";
const BLUEPRINT_OVERLAP_KEY = "dsp-idle-network.ui.blueprint-allow-overlap.v1";

function anonymousCanvasFixture(options: { count: number; exactStack?: number; blueprint?: boolean; hiddenStackAlert?: boolean; spacingX?: number; zoom?: number }) {
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
  const columns = options.count >= 1_000 ? 50 : 25;
  const zoom = options.count >= 1_000 ? 0.2 : options.count >= 300 ? 0.32 : 0.84;
  state.entities = Array.from({ length: options.count }, (_, index) => ({
    ...(options.hiddenStackAlert && index === 1 ? alertTemplate : template),
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
  state.belts = options.exactStack
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
        lastFlow: 0,
      }))
    : [];
  state.nextId = 900_000;
  state.planetViewports.home = { x: 120, y: 100, zoom: options.zoom ?? zoom };
  state.construction.storage_mk1 = options.blueprint ? 1 : 0;
  if (options.blueprint) state = createBlueprint(state, ["anonymous-node-0"], "匿名重叠蓝图");
  if (options.hiddenStackAlert) state.paused = false;
  return JSON.stringify({ savedAt: Date.now(), state });
}

async function seedCanvas(page: Page, options: { count: number; exactStack?: number; blueprint?: boolean; detail?: string; hiddenStackAlert?: boolean; spacingX?: number; zoom?: number }) {
  const raw = anonymousCanvasFixture(options);
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const fulfill = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (pathname === "/api/health") return fulfill({ ok: true, schemaVersion: 7 });
    if (pathname === "/api/public-status") return fulfill({ players: { total: 0, today: 0, online: 0, onlineWindowSeconds: 120 }, serverTime: Date.now() });
    if (pathname === "/api/analytics" || pathname === "/api/presence" || pathname === "/api/errors") return fulfill({ accepted: true }, 202);
    return fulfill({ error: `unmocked ${pathname}` }, 404);
  });
  await page.addInitScript(({ save, detail, detailKey, overlapKey }) => {
    window.sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-14-v1.0.43");
    window.localStorage.setItem("dsp-idle-network.onboarding.v1", "dismissed");
    window.localStorage.setItem("dsp-idle-network.ui.show-run-log.v1", "true");
    window.localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
    window.localStorage.setItem("dsp-idle-network.save.v1", save);
    if (window.sessionStorage.getItem("dsp-idle-network.v144-overlap-preference-seeded") !== "1") {
      window.localStorage.removeItem(overlapKey);
      window.sessionStorage.setItem("dsp-idle-network.v144-overlap-preference-seeded", "1");
    }
    if (window.sessionStorage.getItem("dsp-idle-network.v144-density-preference-seeded") !== "1") {
      if (detail === undefined) window.localStorage.removeItem(detailKey);
      else window.localStorage.setItem(detailKey, detail);
      window.sessionStorage.setItem("dsp-idle-network.v144-density-preference-seeded", "1");
    }
  }, { save: raw, detail: options.detail, detailKey: CANVAS_DETAIL_KEY, overlapKey: BLUEPRINT_OVERLAP_KEY });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator(".game-shell")).toBeVisible();
  await expect(page.locator(".game-shell")).toHaveAttribute("data-active-planet-node-count", String(options.count + 6));
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
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return page.evaluate((measuredActionMs) => {
    const state = (window as typeof window & { __densityFrames?: { active: boolean; values: number[] } }).__densityFrames!;
    state.active = false;
    const sorted = [...state.values].sort((left, right) => left - right);
    return {
      actionMs: measuredActionMs,
      samples: sorted.length,
      p95Ms: sorted[Math.max(0, Math.ceil(sorted.length * .95) - 1)] ?? 0,
      maxMs: sorted.at(-1) ?? 0,
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

test("an exact 50-card stack paints one leader and glow while retaining hidden edge geometry", async ({ page }) => {
  test.setTimeout(60_000);
  await seedCanvas(page, { count: 50, exactStack: 50 });
  const shell = page.locator(".game-shell");
  await expect.poll(async () => Number(await shell.getAttribute("data-canvas-stack-hidden-count"))).toBe(49);
  await expect(shell).toHaveAttribute("data-canvas-detail-stage", "full");
  await expect(page.locator('.factory-node[data-heavy-card="true"]')).toHaveCount(7);
  await expect(page.locator('.react-flow__node[data-id^="anonymous-node-"] .factory-node[data-heavy-card="true"]')).toHaveCount(1);
  await expect(page.locator(".factory-node-stack-proxy")).toHaveCount(49);
  await expect(page.locator(".factory-node-stack-halo")).toHaveCount(1);
  await expect(page.locator(".factory-node-stack-badge")).toHaveCount(1);
  await expect(page.locator('.factory-node-stack-proxy[tabindex="0"]')).toHaveCount(0);
  await expect(page.locator('.factory-node-stack-proxy[data-retains-edge-geometry="true"]')).toHaveCount(3);
  expect(await page.locator(".factory-node-stack-proxy .react-flow__handle").count()).toBeGreaterThan(0);
  await expect(page.locator(".react-flow__edge")).toHaveCount(3);
  expect(await page.locator(".factory-node-stack-proxy").evaluateAll((nodes) => nodes.every((node) => {
    const style = getComputedStyle(node);
    return style.opacity === "0" && style.pointerEvents === "none";
  }))).toBe(true);

  const before: string | null = null;
  await page.locator(".factory-node-stack-badge").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(1);
  const after = await page.locator(".react-flow__node.selected").getAttribute("data-id");
  expect(after).not.toBe(before);
  await expect(page.locator('.factory-node[data-heavy-card="true"]')).toHaveCount(8);
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
  await expect(settings.getByRole("radiogroup", { name: "画布细节偏好" }).getByRole("radio", { name: "自动（推荐）" })).toHaveAttribute("aria-checked", "true");
  await expect(settings.locator(".canvas-detail-diagnostics")).toContainText(String(await shell.getAttribute("data-canvas-visible-node-count")));
});

test("a 2000-visible canvas remains compact with bounded heavy DOM", async ({ page }) => {
  test.setTimeout(90_000);
  await seedCanvas(page, { count: 2_000, exactStack: 2_000 });
  const shell = page.locator(".game-shell");
  const canvas = page.locator(".factory-canvas");
  await expect(shell).toHaveAttribute("data-canvas-detail-stage", "compact");
  await expect.poll(async () => Number(await shell.getAttribute("data-canvas-visible-node-count"))).toBeGreaterThanOrEqual(2_000);
  await expect(page.locator('.factory-node[data-heavy-card="true"]')).toHaveCount(0);
  await expect(page.locator(".work-cycle")).toHaveCount(0);
  await expect(page.locator(".factory-node-stack-proxy")).toHaveCount(1_999);
  await expect(page.locator(".factory-node-stack-halo")).toHaveCount(1);
  const pauseMs = await togglePauseAndMeasure(page, "继续模拟");
  await expect.poll(async () => Number(await canvas.getAttribute("data-changed-node-count"))).toBe(0);
  console.log("v144 2000-visible second-paint gate", JSON.stringify({ pauseMs, diagnostics: await canvas.evaluate((element) => ({ ...((element as HTMLElement).dataset) })) }));
  if (process.env.DSP_E2E_USE_PREVIEW === "1") expect(pauseMs).toBeLessThanOrEqual(100);
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
  await expect(page.locator(".factory-node-stack-badge")).toContainText("×2");
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
  await expect.poll(() => page.locator(".react-flow__node").count()).toBe(8);
  await expect(page.locator(".factory-node-stack-badge")).toContainText("×2");

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
    expect(run.p95Ms).toBeLessThanOrEqual(20);
    expect(run.maxMs).toBeLessThanOrEqual(100);
  }
});
