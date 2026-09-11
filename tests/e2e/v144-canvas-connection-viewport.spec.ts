import { expect, test, type Page } from "@playwright/test";
import { createInitialState, placeBuilding } from "../../src/game/engine";
import { serializeEnvelope } from "../../src/game/storage";
import { selectSettingsCategory } from "./settings-helpers";

const CONNECT_EXPAND_ALL_KEY = "dsp-idle-network.ui.connect-expand-all.v1";
const FULL_REALTIME_SIMULATION_KEY = "dsp-idle-network.full-realtime-simulation.v1";

async function seedAnonymousCanvas(page: Page, storageCount: number, preference?: string, extreme = false) {
  let state = createInitialState(44_144, false);
  state.paused = true;
  state.settings.reducedMotion = true;
  state.construction.storage_mk1 = storageCount;
  state.construction.conveyor_belt_mk1 = 500;
  for (let index = 0; index < storageCount; index += 1) {
    state = placeBuilding(state, "storage_mk1", {
      x: -40 + (index % 10) * 380,
      y: 20 + Math.floor(index / 10) * 300,
    });
  }
  const storages = state.entities.filter((entity) => entity.planetId === "home" && entity.buildingId === "storage_mk1");
  for (const [index, entity] of storages.entries()) {
    entity.storedItemId = "iron_ore";
    entity.inputs.iron_ore = 0;
    entity.outputs.iron_ore = index === 0 ? 500 : 0;
  }
  const fixture = {
    raw: serializeEnvelope(state, Date.now()),
    ids: storages.map((entity) => entity.id),
    counts: {
      active: state.entities.filter((entity) => entity.planetId === state.activePlanetId).length,
      total: state.entities.length,
    },
  };

  await page.addInitScript(({ key, rawPreference, extremeMode, anonymousFixture }) => {
    window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-17-v1.0.46");
    window.localStorage.setItem("dsp-idle-network.onboarding.v1", "dismissed");
    window.localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
    if (extremeMode) {
      window.localStorage.setItem("dsp-idle-network.endgame-extreme.v1", "true");
      window.localStorage.setItem("dsp-idle-network.endgame-extreme-ack.v1", "true");
    } else window.localStorage.removeItem("dsp-idle-network.endgame-extreme.v1");
    if (window.sessionStorage.getItem("dsp-idle-network.v144-connect-preference-seeded") !== "1") {
      if (rawPreference === undefined) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, rawPreference);
      window.sessionStorage.setItem("dsp-idle-network.v144-connect-preference-seeded", "1");
    }
    if (window.sessionStorage.getItem("dsp-idle-network.v144-canvas-fixture-seeded") !== "1") {
      window.localStorage.setItem("dsp-idle-network.save.v1", anonymousFixture.raw);
      window.sessionStorage.setItem("dsp-idle-network.v144-storage-ids", JSON.stringify(anonymousFixture.ids));
      window.sessionStorage.setItem("dsp-idle-network.v144-fixture-counts", JSON.stringify(anonymousFixture.counts));
      window.sessionStorage.setItem("dsp-idle-network.v144-canvas-fixture-seeded", "1");
    }
  }, { key: CONNECT_EXPAND_ALL_KEY, rawPreference: preference, extremeMode: extreme, anonymousFixture: fixture });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?menu=1");
  await continueSeededCanvas(page);
}

async function continueSeededCanvas(page: Page) {
  await expect(page.locator(".start-menu")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: /继续游戏|Continue/i }).click();
  await expect(page.locator(".game-shell")).toBeVisible({ timeout: 20_000 });
}

async function reloadSeededCanvas(page: Page) {
  await page.reload({ waitUntil: "domcontentloaded" });
  await continueSeededCanvas(page);
}

async function storageIds(page: Page): Promise<string[]> {
  return page.evaluate(() => JSON.parse(window.sessionStorage.getItem("dsp-idle-network.v144-storage-ids") ?? "[]") as string[]);
}

async function startContinuousConnection(page: Page, modifier: "Control" | "Shift") {
  const ids = await storageIds(page);
  const shell = page.locator(".game-shell");
  const sourceNode = page.locator(`.react-flow__node[data-id="${ids[0]}"]`);
  const source = sourceNode.locator(".factory-handle--output").first();
  const targetNode = page.locator(`.react-flow__node[data-id="${ids[1]}"]`);
  const target = targetNode.locator(".factory-handle--input").first();
  await expect(source).toBeVisible();
  await expect(target).toBeVisible();
  await source.click({ force: true });
  await expect(shell).toHaveAttribute("data-connection-active", "true");
  await expect(sourceNode).toHaveClass(/factory-flow-node--connection-origin/);

  const targetBounds = await target.boundingBox();
  if (!targetBounds) throw new Error("anonymous target port has no geometry");
  await page.mouse.move(targetBounds.x + targetBounds.width / 2, targetBounds.y + targetBounds.height / 2);
  await expect(shell).toHaveAttribute("data-connection-candidate-node", ids[1]);
  await expect(targetNode).toHaveClass(/factory-flow-node--lod-full/);
  await target.click({ force: true, modifiers: [modifier] });
  await expect(page.getByLabel("连续拉线预览")).toContainText("1 条");
  await expect(shell).toHaveAttribute("data-connection-active", "true");
  return { ids, shell, sourceNode };
}

interface CanvasFrameStats {
  samples: number;
  p95Ms: number;
  maxMs: number;
  over50Ms: number;
}

async function beginFrameCapture(page: Page) {
  await page.evaluate(() => {
    const target = window as typeof window & {
      __v144FrameCapture?: { active: boolean; previous: number; samples: number[] };
    };
    target.__v144FrameCapture = { active: true, previous: performance.now(), samples: [] };
    const tick = (now: number) => {
      const capture = target.__v144FrameCapture;
      if (!capture?.active) return;
      capture.samples.push(now - capture.previous);
      capture.previous = now;
      window.requestAnimationFrame(tick);
    };
    window.requestAnimationFrame(tick);
  });
}

async function finishFrameCapture(page: Page): Promise<CanvasFrameStats> {
  return page.evaluate(() => {
    const target = window as typeof window & {
      __v144FrameCapture?: { active: boolean; previous: number; samples: number[] };
    };
    const capture = target.__v144FrameCapture;
    if (!capture) throw new Error("frame capture was not started");
    capture.active = false;
    const sorted = [...capture.samples].sort((left, right) => left - right);
    const percentileIndex = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
    return {
      samples: sorted.length,
      p95Ms: sorted[percentileIndex] ?? 0,
      maxMs: sorted.at(-1) ?? 0,
      over50Ms: sorted.filter((duration) => duration > 50).length,
    };
  });
}

async function armConnectionEntryMeasurement(page: Page, mode: "bounded" | "all") {
  await page.evaluate((expectedMode) => {
    const target = window as typeof window & { __v144ConnectionEntryMs?: number | null };
    const shell = document.querySelector<HTMLElement>(".game-shell");
    if (!shell) throw new Error("game shell is unavailable");
    let startedAt: number | null = null;
    target.__v144ConnectionEntryMs = null;
    const markStart = (event: Event) => {
      if (!(event.target instanceof Element) || !event.target.closest(".factory-handle")) return;
      startedAt = performance.now();
      document.removeEventListener("pointerdown", markStart, true);
    };
    const observer = new MutationObserver(() => {
      if (startedAt === null) return;
      const active = shell.dataset.connectionActive === "true";
      const activeCount = Number(shell.dataset.activePlanetNodeCount ?? 0);
      const fullCount = Number(shell.dataset.connectionFullLogicalCount ?? 0);
      const ready = expectedMode === "all"
        ? active && activeCount > 0 && fullCount === activeCount
        : active && fullCount > 0 && fullCount < activeCount;
      if (!ready) return;
      target.__v144ConnectionEntryMs = performance.now() - startedAt;
      observer.disconnect();
      document.removeEventListener("pointerdown", markStart, true);
    });
    document.addEventListener("pointerdown", markStart, true);
    observer.observe(shell, { attributes: true });
  }, mode);
}

async function connectionEntryMeasurement(page: Page): Promise<number> {
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __v144ConnectionEntryMs?: number | null }).__v144ConnectionEntryMs ?? null)).not.toBeNull();
  return page.evaluate(() => (window as typeof window & { __v144ConnectionEntryMs?: number | null }).__v144ConnectionEntryMs ?? Number.POSITIVE_INFINITY);
}

async function canvasPresentationCounts(page: Page) {
  return page.locator(".game-shell").evaluate((shell) => ({
    active: Number((shell as HTMLElement).dataset.activePlanetNodeCount ?? 0),
    logicalFull: Number((shell as HTMLElement).dataset.connectionFullLogicalCount ?? 0),
    viewportFull: Number((shell as HTMLElement).dataset.connectionViewportLogicalCount ?? 0),
    renderedFull: document.querySelectorAll(".react-flow__node.factory-flow-node--lod-full").length,
    renderedHandles: document.querySelectorAll(".react-flow__node.factory-flow-node--lod-full .react-flow__handle").length,
  }));
}

for (const scenario of [
  { storageCount: 10, modifier: "Control" as const, finish: "Escape" as const, extreme: false },
  { storageCount: 100, modifier: "Shift" as const, finish: "Enter" as const, extreme: true },
]) {
  test(`${scenario.modifier} continuous connection keeps ${scenario.storageCount} nodes viewport-bounded`, async ({ page }) => {
    await seedAnonymousCanvas(page, scenario.storageCount, undefined, scenario.extreme);
    const { shell, sourceNode } = await startContinuousConnection(page, scenario.modifier);
    await expect(shell).toHaveAttribute("data-endgame-extreme", String(scenario.extreme));
    const activeCount = Number(await shell.getAttribute("data-active-planet-node-count"));
    const logicalFullCount = Number(await shell.getAttribute("data-connection-full-logical-count"));
    const viewportFullCount = Number(await shell.getAttribute("data-connection-viewport-logical-count"));
    const renderedFullCount = await page.locator(".react-flow__node.factory-flow-node--lod-full").count();
    const renderedHandleCount = await page.locator(".react-flow__node.factory-flow-node--lod-full .react-flow__handle").count();

    expect(activeCount).toBeGreaterThanOrEqual(scenario.storageCount);
    expect(logicalFullCount).toBeGreaterThan(1);
    expect(logicalFullCount).toBeLessThan(activeCount);
    expect(viewportFullCount).toBeGreaterThan(0);
    expect(renderedFullCount).toBeGreaterThan(0);
    expect(renderedFullCount).toBeLessThanOrEqual(logicalFullCount);
    expect(renderedHandleCount).toBeGreaterThan(0);
    await expect(sourceNode).toHaveClass(/factory-flow-node--lod-full/);

    await page.keyboard.press(scenario.finish);
    await expect(shell).toHaveAttribute("data-connection-active", "false");
    await expect(page.getByLabel("连续拉线预览")).toHaveCount(0);
    await expect(page.locator(".react-flow__edge")).toHaveCount(scenario.finish === "Enter" ? 1 : 0);
  });
}

test("device-only expand-all preference is strict, persistent, accessible, and active-planet-only", async ({ page }) => {
  await page.addInitScript((fullRealtimeKey) => {
    if (window.sessionStorage.getItem("dsp-idle-network.v144-full-realtime-seeded") !== "1") {
      window.localStorage.setItem(fullRealtimeKey, "damaged-value");
      window.sessionStorage.setItem("dsp-idle-network.v144-full-realtime-seeded", "1");
    }
    const tracker: { scopes: string[] } = { scopes: [] };
    (window as typeof window & { __v144ProjectionScopes?: typeof tracker }).__v144ProjectionScopes = tracker;
    const NativeWorker = window.Worker;
    const WrappedWorker = new Proxy(NativeWorker, {
      construct(target, args) {
        const worker = Reflect.construct(target, args) as Worker;
        if (!String(args[0]).includes("simulation.worker")) return worker;
        const nativePostMessage = worker.postMessage.bind(worker);
        worker.postMessage = ((message: Record<string, unknown>, transferOrOptions?: Transferable[] | StructuredSerializeOptions) => {
          if (message.kind === "advance") tracker.scopes.push(String(message.projectionScope ?? "default"));
          if (transferOrOptions === undefined) nativePostMessage(message);
          else nativePostMessage(message, transferOrOptions);
        }) as typeof worker.postMessage;
        return worker;
      },
    });
    Object.defineProperty(window, "Worker", { configurable: true, writable: true, value: WrappedWorker });
  }, FULL_REALTIME_SIMULATION_KEY);
  await seedAnonymousCanvas(page, 24, "damaged-value");
  const shell = page.locator(".game-shell");
  await expect(shell).toHaveAttribute("data-connect-expand-all", "false");
  await expect(shell).toHaveAttribute("data-full-realtime-simulation", "false");
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { __v144ProjectionScopes?: { scopes: string[] } }
  ).__v144ProjectionScopes?.scopes.includes("default") ?? false)).toBe(true);

  await page.getByLabel("打开设置").click();
  const operations = page.locator(".operations-workspace");
  await selectSettingsCategory(operations, "终局性能", "performance");
  const toggle = operations.locator("label.setting-row").filter({ hasText: "连线时展开全星球建筑" });
  await expect(toggle.getByRole("checkbox")).not.toBeChecked();
  await toggle.getByRole("checkbox").evaluate((input: HTMLInputElement) => input.click());
  await expect(toggle.getByRole("checkbox")).toBeChecked();
  await expect(operations.getByRole("alert").filter({ hasText: "超大工厂连线时可能" })).toBeVisible();
  await expect(shell).toHaveAttribute("data-connect-expand-all", "true");
  expect(await page.evaluate((key) => window.localStorage.getItem(key), CONNECT_EXPAND_ALL_KEY)).toBe("true");
  const realtimeToggle = operations.locator("label.setting-row").filter({ hasText: "完整实时刷新" });
  await expect(realtimeToggle.getByRole("checkbox")).not.toBeChecked();
  await realtimeToggle.getByRole("checkbox").evaluate((input: HTMLInputElement) => input.click());
  await expect(realtimeToggle.getByRole("checkbox")).toBeChecked();
  await expect(shell).toHaveAttribute("data-full-realtime-simulation", "true");
  const resume = page.getByLabel("继续模拟");
  const pause = page.getByLabel("暂停模拟");
  if (await resume.isVisible()) await resume.click();
  else await expect(pause).toBeVisible();
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { __v144ProjectionScopes?: { scopes: string[] } }
  ).__v144ProjectionScopes?.scopes.includes("full-top-level") ?? false), { timeout: 5_000 }).toBe(true);
  if (await pause.isVisible()) await pause.click();
  expect(await page.evaluate((key) => window.localStorage.getItem(key), FULL_REALTIME_SIMULATION_KEY)).toBe("true");

  await selectSettingsCategory(operations, "画面与主题", "visual");
  await operations.getByRole("button", { name: "English", exact: true }).click();
  await operations.locator(".settings-category-tabs").getByRole("button", { name: "Endgame Performance", exact: true }).click();
  const englishToggle = operations.locator("label.setting-row").filter({ hasText: "Expand every building while connecting" });
  await expect(englishToggle.getByRole("checkbox")).toBeChecked();
  await expect(operations.locator("label.setting-row").filter({ hasText: "Full realtime refresh" }).getByRole("checkbox")).toBeChecked();
  await expect(operations.getByRole("alert").filter({ hasText: "very large factories may pause or stutter" })).toBeVisible();

  await page.locator(".header-settings-command").click();
  await reloadSeededCanvas(page);
  await expect(shell).toHaveAttribute("data-connect-expand-all", "true");
  await expect(shell).toHaveAttribute("data-full-realtime-simulation", "true");
  const ids = await storageIds(page);
  await page.locator(`.react-flow__node[data-id="${ids[0]}"] .factory-handle--output`).first().click({ force: true });
  await expect(shell).toHaveAttribute("data-connection-active", "true");
  await expect.poll(async () => Number(await shell.getAttribute("data-connection-full-logical-count"))).toBe(
    Number(await shell.getAttribute("data-active-planet-node-count")),
  );
  const counts = await page.evaluate(async () => {
    const fixtureCounts = JSON.parse(window.sessionStorage.getItem("dsp-idle-network.v144-fixture-counts") ?? "{}") as { active?: number; total?: number };
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("dsp-idle-network.local-saves");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const primaryValue = await new Promise<string>((resolve, reject) => {
      const transaction = database.transaction("records", "readonly");
      const request = transaction.objectStore("records").get("dsp-idle-network.save.v1");
      request.onsuccess = () => resolve(String(request.result?.value ?? ""));
      request.onerror = () => reject(request.error);
    });
    database.close();
    return {
      active: fixtureCounts.active ?? 0,
      total: fixtureCounts.total ?? 0,
      primaryBytes: new TextEncoder().encode(primaryValue).byteLength,
      hasGameStateField: primaryValue.includes("connectExpandAll"),
      serializedStateMentionsPreference: primaryValue.includes("connect-expand-all"),
      hasFullRealtimeStateField: primaryValue.includes("fullRealtimeSimulation"),
      serializedStateMentionsFullRealtimePreference: primaryValue.includes("full-realtime-simulation"),
    };
  });
  expect(counts.total).toBeGreaterThan(counts.active);
  expect(counts.primaryBytes).toBeGreaterThan(0);
  expect(Number(await shell.getAttribute("data-connection-full-logical-count"))).toBe(counts.active);
  expect(counts.hasGameStateField).toBe(false);
  expect(counts.serializedStateMentionsPreference).toBe(false);
  expect(counts.hasFullRealtimeStateField).toBe(false);
  expect(counts.serializedStateMentionsFullRealtimePreference).toBe(false);
  await page.keyboard.press("Escape");
});

test("dense Chromium connection viewport meets the desktop frame gate and reports expand-all cost", async ({ page }) => {
  test.skip(process.env.DSP_E2E_USE_PREVIEW !== "1", "frame budgets are measured against the production preview build");
  await seedAnonymousCanvas(page, 100, undefined, true);
  const shell = page.locator(".game-shell");
  const ids = await storageIds(page);
  const source = () => page.locator(`.react-flow__node[data-id="${ids[0]}"] .factory-handle--output`).first();

  await beginFrameCapture(page);
  await armConnectionEntryMeasurement(page, "bounded");
  await source().click({ force: true });
  await expect(shell).toHaveAttribute("data-connection-active", "true");
  const boundedEntryMs = await connectionEntryMeasurement(page);
  const boundedCounts = await canvasPresentationCounts(page);
  const paneBounds = await page.locator(".react-flow__pane").boundingBox();
  if (!paneBounds) throw new Error("dense anonymous canvas has no pane geometry");
  await page.mouse.move(paneBounds.x + paneBounds.width * 0.55, paneBounds.y + paneBounds.height * 0.55);
  for (let index = 0; index < 8; index += 1) await page.mouse.wheel(45, 24);
  await page.locator(".react-flow__controls-zoomin").click();
  await page.locator(".react-flow__controls-zoomout").click();
  await page.keyboard.press("Escape");
  await expect(shell).toHaveAttribute("data-connection-active", "false");
  await page.waitForTimeout(650);
  const boundedFrames = await finishFrameCapture(page);

  await page.evaluate((key) => window.localStorage.setItem(key, "true"), CONNECT_EXPAND_ALL_KEY);
  await reloadSeededCanvas(page);
  await expect(shell).toHaveAttribute("data-connect-expand-all", "true");
  await beginFrameCapture(page);
  await armConnectionEntryMeasurement(page, "all");
  await source().click({ force: true });
  const expandAllEntryMs = await connectionEntryMeasurement(page);
  const expandAllCounts = await canvasPresentationCounts(page);
  await page.waitForTimeout(650);
  const expandAllFrames = await finishFrameCapture(page);
  await page.keyboard.press("Escape");

  console.log("v144 canvas connection perf", JSON.stringify({
    bounded: { entryMs: boundedEntryMs, frames: boundedFrames, counts: boundedCounts },
    expandAll: { entryMs: expandAllEntryMs, frames: expandAllFrames, counts: expandAllCounts },
  }));
  expect(boundedEntryMs).toBeLessThanOrEqual(50);
  expect(boundedFrames.samples).toBeGreaterThanOrEqual(30);
  expect(boundedFrames.p95Ms).toBeLessThanOrEqual(33);
  expect(boundedCounts.logicalFull).toBeLessThan(boundedCounts.active);
  expect(boundedCounts.renderedHandles).toBeGreaterThan(0);
  expect(expandAllCounts.logicalFull).toBe(expandAllCounts.active);
  expect(expandAllCounts.logicalFull).toBeGreaterThan(boundedCounts.logicalFull);
});

