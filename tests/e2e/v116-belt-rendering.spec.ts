import { expect, test } from "@playwright/test";
import { createInitialState, placeBuilding } from "../../src/game/engine";
import { serializeEnvelope } from "../../src/game/storage";

/**
 * A small but deliberately multi-port dense factory.  The Canvas renderer is
 * enabled by the 200 belts; the first belt targets the third input port so a
 * card-centre endpoint would be visibly wrong.
 */
function buildMultiPortDenseFactory() {
  let state = createInitialState(1_160_001, false);
  state.paused = true;
  state.settings.reducedMotion = true;
  state.construction.assembling_machine_mk1 = 2;
  state = placeBuilding(state, "assembling_machine_mk1", { x: -120, y: 120 });
  state = placeBuilding(state, "assembling_machine_mk1", { x: 180, y: 120 });
  const machines = state.entities.filter((entity) => entity.buildingId === "assembling_machine_mk1");
  const source = machines[0];
  const target = machines[1];
  if (!source || !target) throw new Error("dense multi-port fixture did not place machines");
  source.recipeId = "magnetic_coil";
  source.outputs = { magnetic_coil: 100 };
  target.recipeId = "electric_motor";
  target.inputs = { magnetic_coil: 100, iron_ingot: 100, gear: 100 };
  state.belts = Array.from({ length: 200 }, (_, index) => ({
    id: `v116-port-belt-${index}`,
    planetId: state.activePlanetId,
    source: source.id,
    target: target.id,
    itemId: "magnetic_coil" as const,
    lanes: 1,
    tier: 1 as const,
    sorterTier: 1 as const,
    progress: 0,
    priority: 1 as const,
    stackSize: 1 as const,
    totalTransferred: 0,
    lastFlow: 0,
    congestion: 0,
  }));
  return serializeEnvelope(state, Date.now());
}

test("dense belt endpoints follow measured multi-port handles", async ({ page }) => {
  const raw = buildMultiPortDenseFactory();
  await page.addInitScript((fixture) => {
    window.sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-27-v1.2.0");
    window.localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
    window.localStorage.setItem("dsp-idle-network.endgame-extreme.v1", "true");
    window.localStorage.setItem("dsp-idle-network.endgame-extreme-ack.v1", "true");
    window.localStorage.setItem("dsp-idle-network.save.v1", fixture);
  }, raw);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const releaseNotesDismiss = page.getByRole("button", { name: "我知道了", exact: true });
  if (await releaseNotesDismiss.isVisible().catch(() => false)) {
    await releaseNotesDismiss.click();
    await expect(releaseNotesDismiss).toBeHidden();
  }
  const startButton = page.getByRole("button", { name: /开始游戏|继续游戏|Continue/i }).first();
  if (await startButton.isVisible().catch(() => false)) await startButton.click();

  await expect(page.locator(".factory-canvas")).toHaveAttribute("data-batch-renderer", "true");
  const canvas = page.locator("canvas.canvas-belt-layer");
  await expect(canvas).toHaveAttribute("data-segments", "200");
  const targetHandle = page.locator('.react-flow__handle[data-handleid="in:magnetic_coil"]').first();
  await expect(targetHandle).toBeVisible();
  const targetNode = targetHandle.locator("xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' react-flow__node ')]");
  const nodeBox = await targetNode.boundingBox();
  const handleBox = await targetHandle.boundingBox();
  if (!nodeBox || !handleBox) throw new Error("multi-port target geometry is unavailable");
  const expectedTargetY = await page.evaluate(({ nodeWorldY, nodeScreenTop, handleTop, handleHeight }) => {
    const viewport = document.querySelector<HTMLElement>(".react-flow__viewport");
    if (!viewport) throw new Error("React Flow viewport is missing");
    const zoom = new DOMMatrixReadOnly(getComputedStyle(viewport).transform).a;
    return nodeWorldY + (handleTop - nodeScreenTop + handleHeight / 2) / zoom;
  }, { nodeWorldY: 120, nodeScreenTop: nodeBox.y, handleTop: handleBox.y, handleHeight: handleBox.height });
  const actualTargetY = Number(await canvas.getAttribute("data-first-target-y"));
  expect(actualTargetY).toBeCloseTo(expectedTargetY, 1);
});

test("dense belt pixels stay attached after viewport pan and zoom", async ({ page }) => {
  const raw = buildMultiPortDenseFactory();
  await page.addInitScript((fixture) => {
    window.sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-27-v1.2.0");
    window.localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
    window.localStorage.setItem("dsp-idle-network.endgame-extreme.v1", "true");
    window.localStorage.setItem("dsp-idle-network.endgame-extreme-ack.v1", "true");
    window.localStorage.setItem("dsp-idle-network.save.v1", fixture);
  }, raw);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const releaseNotesDismiss = page.getByRole("button", { name: "我知道了", exact: true });
  if (await releaseNotesDismiss.isVisible().catch(() => false)) await releaseNotesDismiss.click();
  const startButton = page.getByRole("button", { name: /开始游戏|继续游戏|Continue/i }).first();
  if (await startButton.isVisible().catch(() => false)) await startButton.click();

  const canvas = page.locator("canvas.canvas-belt-layer");
  const sourceHandle = page.locator('.react-flow__handle[data-handleid="out:magnetic_coil"]').first();
  const targetHandle = page.locator('.react-flow__handle[data-handleid="in:magnetic_coil"]').first();
  await expect(canvas).toHaveAttribute("data-segments", "200");
  await expect(sourceHandle).toBeVisible();
  await expect(targetHandle).toBeVisible();

  const endpointDistances = () => page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>("canvas.canvas-belt-layer");
    const source = document.querySelector<HTMLElement>('.react-flow__handle[data-handleid="out:magnetic_coil"]');
    const target = document.querySelector<HTMLElement>('.react-flow__handle[data-handleid="in:magnetic_coil"]');
    if (!canvas || !source || !target) return { source: 999, target: 999, canvasSpace: "missing" };
    const overscan = Number(canvas.dataset.overscan);
    const drawnX = Number(canvas.dataset.drawnViewportX);
    const drawnY = Number(canvas.dataset.drawnViewportY);
    const drawnZoom = Number(canvas.dataset.drawnViewportZoom);
    const firstSourceX = Number(canvas.dataset.firstSourceX);
    const firstSourceY = Number(canvas.dataset.firstSourceY);
    const firstTargetX = Number(canvas.dataset.firstTargetX);
    const firstTargetY = Number(canvas.dataset.firstTargetY);
    const bounds = canvas.getBoundingClientRect();
    const scaleX = bounds.width / Math.max(1, canvas.offsetWidth);
    const scaleY = bounds.height / Math.max(1, canvas.offsetHeight);
    const toScreen = (x: number, y: number) => ({
      x: bounds.left + (overscan + drawnX + x * drawnZoom) * scaleX,
      y: bounds.top + (overscan + drawnY + y * drawnZoom) * scaleY,
    });
    const port = (element: HTMLElement, source: boolean) => {
      const rect = element.getBoundingClientRect();
      return { x: source ? rect.right : rect.left, y: rect.top + rect.height / 2 };
    };
    const sourcePoint = toScreen(firstSourceX, firstSourceY);
    const targetPoint = toScreen(firstTargetX, firstTargetY);
    const sourceCenter = port(source, true);
    const targetCenter = port(target, false);
    return {
      source: Math.hypot(sourcePoint.x - sourceCenter.x, sourcePoint.y - sourceCenter.y),
      target: Math.hypot(targetPoint.x - targetCenter.x, targetPoint.y - targetCenter.y),
      canvasSpace: canvas.closest(".react-flow__viewport") ? "viewport" : "screen",
    };
  });

  await expect.poll(endpointDistances).toMatchObject({ canvasSpace: "screen" });
  await expect.poll(async () => Math.max((await endpointDistances()).source, (await endpointDistances()).target)).toBeLessThan(6);
  await page.screenshot({ path: "artifacts/qa/v117-belt-viewport-initial.png", fullPage: true });

  for (let index = 0; index < 2; index += 1) {
    await page.getByRole("button", { name: "Zoom out" }).click().catch(async () => {
      await page.locator(".react-flow__controls-zoomout").click();
    });
    await expect.poll(async () => Math.max((await endpointDistances()).source, (await endpointDistances()).target)).toBeLessThan(6);
  }

  const pane = page.locator(".react-flow__pane");
  const paneBox = await pane.boundingBox();
  if (!paneBox) throw new Error("React Flow pane geometry is unavailable");
  await page.mouse.move(paneBox.x + paneBox.width * 0.75, paneBox.y + paneBox.height * 0.72);
  await page.mouse.down();
  await page.mouse.move(paneBox.x + paneBox.width * 0.75 + 140, paneBox.y + paneBox.height * 0.72 + 85, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => Math.max((await endpointDistances()).source, (await endpointDistances()).target)).toBeLessThan(6);
  await page.screenshot({ path: "artifacts/qa/v117-belt-viewport-pan-zoom.png", fullPage: true });
});
