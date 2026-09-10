import { expect, test, type Page } from "@playwright/test";

async function seed(page: Page) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => {
    sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    localStorage.setItem("dsp-idle-network.onboarding.v1", "dismissed");
  });
  await page.goto("/version.json");
  const ids = await page.evaluate(async () => {
    const { createInitialState, placeBuilding, addCanvasRegion } = await import("/src/game/engine.ts");
    let state = createInitialState(129_001, false);
    state.paused = true;
    state.entities.forEach((entity, index) => { entity.position = { x: 2000 + index * 300, y: 1800 }; });
    state.belts = [];
    state.construction.arc_smelter = 2;
    state = placeBuilding(state, "arc_smelter", { x: 0, y: 0 });
    state = placeBuilding(state, "arc_smelter", { x: 360, y: 0 });
    state = addCanvasRegion(state, state.activePlanetId, { x: -60, y: -60, width: 760, height: 460 }, "钢铁区域");
    state.planetViewports.home = { x: 100, y: 180, zoom: 0.7 };
    const raw = JSON.stringify({ savedAt: Date.now(), state });
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("dsp-idle-network.local-saves");
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains("records")) request.result.createObjectStore("records", { keyPath: "key" }); };
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("records", "readwrite");
      tx.objectStore("records").put({ key: "dsp-idle-network.save.v1", value: raw,
        updatedAt: Date.now(), bytes: new TextEncoder().encode(raw).byteLength });
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    });
    db.close();
    return state.entities.filter((entity) => entity.buildingId === "arc_smelter").map((entity) => entity.id);
  });
  await page.goto("/");
  await expect(page.locator(".game-shell")).toBeVisible();
  expect(ids).toHaveLength(2);
  for (const id of ids) await expect(page.locator(`.react-flow__node[data-id="${id}"]`)).toBeVisible();
}

async function view(page: Page) {
  return page.locator(".react-flow__viewport").evaluate((element) => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
    return { x: matrix.e, y: matrix.f, zoom: matrix.a };
  });
}

test("WASD moves only the view, stops after release, and leaves region inputs and dialogs alone", async ({ page }) => {
  await seed(page);
  const before = await view(page);
  await page.keyboard.down("d");
  await expect.poll(async () => (await view(page)).x).toBeLessThan(before.x - 35);
  await page.keyboard.up("d");
  const stopped = await view(page);
  await page.waitForTimeout(100);
  expect((await view(page)).x).toBeCloseTo(stopped.x, 1);
  expect((await view(page)).zoom).toBe(before.zoom);
  await page.keyboard.down("a");
  await expect.poll(async () => (await view(page)).x).toBeGreaterThanOrEqual(before.x);
  await page.keyboard.up("a");
  await page.locator(".canvas-region__label").click();
  const name = page.getByLabel("生产区域设置").getByRole("textbox");
  await name.fill("wasd 区域");
  const editing = await view(page);
  await name.press("w");
  expect(await view(page)).toEqual(editing);
  await name.blur();
  await page.getByLabel("关闭区域设置").click();
  await page.getByLabel("打开设置").click();
  const dialogView = await view(page);
  await page.keyboard.down("w"); await page.waitForTimeout(80); await page.keyboard.up("w");
  expect(await view(page)).toEqual(dialogView);
});

test("box selection moves the region and nodes together with undo, redo and persisted reopen", async ({ page }) => {
  await seed(page);
  await page.getByLabel("框选模式", { exact: true }).click();
  await page.getByLabel("同时选中生产区域").click();
  const region = page.locator(".canvas-region[data-region-id]");
  const box = (await region.boundingBox())!;
  await page.mouse.move(box.x - 8, box.y - 8);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width + 8, box.y + box.height + 8, { steps: 16 });
  await page.mouse.up();
  await expect(region).toHaveAttribute("data-group-selected", "true");
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(2);
  const node = page.locator(".react-flow__node.selected").first();
  const beforeNode = await node.getAttribute("style");
  const start = (await node.boundingBox())!;
  const beforeRegion = await region.getAttribute("style");
  await page.mouse.move(start.x + start.width / 2, start.y + 20);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2 + 70, start.y + 70, { steps: 12 });
  await expect.poll(() => region.getAttribute("style")).not.toBe(beforeRegion);
  await page.mouse.up();
  await expect.poll(() => node.getAttribute("style")).not.toBe(beforeNode);
  const movedRegion = await region.getAttribute("style");
  await page.keyboard.press("Control+z");
  await expect(region).toHaveAttribute("style", beforeRegion!);
  await page.keyboard.press("Control+y");
  await expect(region).toHaveAttribute("style", movedRegion!);
  await page.screenshot({ path: "artifacts/qa/v129-region-selection-desktop.png" });
  await page.getByLabel("打开设置").click();
  await page.getByRole("dialog", { name: "运营中心" }).getByRole("tab", { name: "存档", exact: true }).click();
  await page.getByRole("button", { name: "立即保存", exact: true }).click();
  await expect.poll(() => page.evaluate(async () => {
    const { resolveMenuContinueSave } = await import("/src/game/savePreviewPayload.ts");
    return (await resolveMenuContinueSave("normal"))?.inspection.state?.canvasRegions[0].x;
  })).not.toBe(-60);
  await page.reload();
  await expect(page.locator(".game-shell")).toBeVisible();
  await expect(page.locator(".canvas-region[data-region-id]")).toHaveAttribute("style", movedRegion!);
});

test("region editor can select its contents and small-screen controls stay reachable", async ({ page }) => {
  await seed(page);
  await page.locator(".canvas-region__label").click();
  await page.getByLabel("选中区域与内部节点", { exact: true }).click();
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(2);
  await expect(page.locator(".canvas-region")).toHaveAttribute("data-group-selected", "true");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".canvas-region__label").click();
  const editor = page.getByLabel("生产区域设置");
  await expect(editor.getByLabel("选中区域与内部节点", { exact: true })).toBeVisible();
  await expect.poll(() => editor.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/v129-region-selection-portrait.png" });
});
