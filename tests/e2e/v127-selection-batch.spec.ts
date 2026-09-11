import { expect, test, type Page } from "@playwright/test";

test.use({ hasTouch: true });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-17-v1.0.46");
    window.localStorage.setItem("dsp-idle-network.onboarding.v1", "dismissed");
  });
});

async function seedFactory(page: Page, fixture: "smelters" | "storage-network" = "smelters") {
  // The app migrates the primary save to IndexedDB before mounting. Seed the
  // fixture before boot so the same path is exercised as a real fresh browser.
  await page.goto("/version.json");
  await page.evaluate(async (selectedFixture) => {
    const { createInitialState, placeBuilding } = await import("/src/game/engine.ts");
    let state = createInitialState(27_101, false);
    state.paused = true;
    state.construction.conveyor_belt_mk1 = 12;
    if (selectedFixture === "storage-network") {
      state.construction.storage_mk1 = 3;
      state = placeBuilding(state, "storage_mk1", { x: -260, y: -80 });
      state = placeBuilding(state, "storage_mk1", { x: 20, y: -160 });
      state = placeBuilding(state, "storage_mk1", { x: 20, y: 80 });
      const sourceStorage = state.entities.find((entity) => entity.buildingId === "storage_mk1");
      if (!sourceStorage) throw new Error("storage fixture placement failed");
      sourceStorage.storedItemId = "iron_ore";
      sourceStorage.outputs.iron_ore = 100;
    } else {
      state.construction.arc_smelter = 12;
      state = placeBuilding(state, "arc_smelter", { x: -80, y: -100 });
      state = placeBuilding(state, "arc_smelter", { x: 80, y: -100 });
    }
    const raw = JSON.stringify({ savedAt: Date.now(), state });
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("dsp-idle-network.local-saves");
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("records")) request.result.createObjectStore("records", { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("records", "readwrite");
      transaction.objectStore("records").put({
        key: "dsp-idle-network.save.v1",
        value: raw,
        updatedAt: Date.now(),
        bytes: new TextEncoder().encode(raw).byteLength,
      });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
  }, fixture);
  await page.goto("/");
  await expect(page.locator(".game-shell")).toBeVisible();
}

async function readPersistedPrimaryState(page: Page) {
  return page.evaluate(async () => {
    const { resolveMenuContinueSave } = await import("/src/game/savePreviewPayload.ts");
    const selected = await resolveMenuContinueSave("normal");
    if (!selected?.inspection.state) throw new Error("persisted primary save is unavailable");
    return selected.inspection.state;
  });
}

test("connection point preference changes visual scale and hit configuration", async ({ page }) => {
  await seedFactory(page);
  await page.getByLabel("打开设置").click();
  const settings = page.getByRole("dialog", { name: "运营中心" });
  await settings.locator(".settings-category-tabs").getByRole("button", { name: "交互与控制", exact: true }).click();
  await expect(settings.getByRole("button", { name: "放大 50%", exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "放大 50%", exact: true }).click();
  await expect(page.locator(".game-shell")).toHaveAttribute("data-connection-point-size", "large50");
  await expect.poll(() => page.locator(".react-flow__node .factory-handle").first().evaluate((element) => getComputedStyle(element).width)).toBe("27px");
  await settings.getByRole("button", { name: "自动适配", exact: true }).click();
  await expect(settings.getByRole("button", { name: "自动适配", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".game-shell")).toHaveAttribute("data-connection-point-size", "large50", "visual size must remain independent from the transparent hit-area setting");
  await expect(page.locator(".game-shell")).toHaveAttribute("data-connection-hit-area", "auto");
  expect(Number(await page.locator(".game-shell").getAttribute("data-connection-hit-diameter"))).toBeGreaterThanOrEqual(56);
});

for (const fontScale of [0.8, 1, 1.25, 1.5, 2] as const) {
  test(`connection ports remain visible and targetable at ${fontScale * 100}% text`, async ({ page }) => {
    await seedFactory(page, "storage-network");
    await page.evaluate((scale) => {
      document.documentElement.dataset.uiFontScale = String(Math.round(scale * 100));
      document.documentElement.style.setProperty("--ui-font-scale", String(scale));
    }, fontScale);
    const handles = page.locator(".react-flow__node .factory-handle");
    expect(await handles.count()).toBeGreaterThanOrEqual(3);
    for (const handle of await handles.all()) {
      await expect(handle).toBeVisible();
      const box = await handle.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(14);
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(14);
    }
    expect(Number(await page.locator(".game-shell").getAttribute("data-connection-hit-diameter"))).toBeGreaterThanOrEqual(56);
  });
}

test("continuous connection mode previews multiple targets and commits them atomically", async ({ page }) => {
  await seedFactory(page, "storage-network");
  const seeded = (await readPersistedPrimaryState(page)).entities
    .filter((entity) => entity.buildingId === "storage_mk1")
    .map((entity) => ({ id: entity.id, itemId: entity.storedItemId, outputs: entity.outputs }));
  expect(seeded).toHaveLength(3);
  expect(seeded[0]).toMatchObject({ itemId: "iron_ore", outputs: { iron_ore: 100 } });
  for (const entity of seeded) await expect(page.locator(`.react-flow__node[data-id="${entity.id}"]`)).toBeVisible();
  await page.getByLabel("连续拉线模式").click();
  const source = page.locator(`.react-flow__node[data-id="${seeded[0].id}"] .factory-handle--output`).first();
  await source.click({ force: true });
  const preview = page.getByLabel("连续拉线预览");
  await page.locator(`.react-flow__node[data-id="${seeded[1].id}"] .factory-handle--input`).first().click({ force: true });
  await expect(preview).toContainText("1 条");
  await expect(preview).toContainText(`小型储物仓 · ${seeded[0].id} → 小型储物仓 · ${seeded[1].id}`);
  await page.locator(`.react-flow__node[data-id="${seeded[1].id}"] .factory-handle--input`).first().click({ force: true });
  await expect(preview.getByRole("alert")).toContainText("已在预览列表中");
  await expect(preview.getByRole("button", { name: "确认连接" })).toBeDisabled();
  await expect(page.locator(`.react-flow__node[data-id="${seeded[2].id}"] .factory-handle--input`).first()).toBeVisible();
  const secondTarget = page.locator(`.react-flow__node[data-id="${seeded[2].id}"] .factory-handle--input`).first();
  const secondBox = await secondTarget.boundingBox();
  if (!secondBox) throw new Error("second continuous target has no geometry");
  await page.mouse.click(secondBox.x + secondBox.width / 2, secondBox.y + secondBox.height / 2);
  await expect(preview).toContainText("2 条");
  const before = (await readPersistedPrimaryState(page)).construction.conveyor_belt_mk1;
  await preview.getByRole("button", { name: "确认连接" }).click();
  await expect(preview).toHaveCount(0);
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
  await page.getByLabel("保存并返回主菜单").click();
  await expect(page.locator(".start-menu")).toBeVisible();
  const afterState = await readPersistedPrimaryState(page);
  const after = { belts: afterState.belts.length, construction: afterState.construction.conveyor_belt_mk1 };
  expect(after).toEqual({ belts: 2, construction: before - 2 });
});

test("cumulative material shortage blocks the whole preview before any belt or stock changes", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("dsp-idle-network.ui.default-belt-lanes.v1", "10"));
  await seedFactory(page, "storage-network");
  const ids = (await readPersistedPrimaryState(page)).entities
    .filter((entity) => entity.buildingId === "storage_mk1")
    .map((entity) => entity.id);
  const beforeState = await readPersistedPrimaryState(page);
  const before = { belts: beforeState.belts, construction: beforeState.construction.conveyor_belt_mk1 };
  await page.getByLabel("连续拉线模式").click();
  await page.locator(`.react-flow__node[data-id="${ids[0]}"] .factory-handle--output`).first().click({ force: true });
  await page.locator(`.react-flow__node[data-id="${ids[1]}"] .factory-handle--input`).first().click({ force: true });
  const preview = page.getByLabel("连续拉线预览");
  await expect(preview).toContainText("1 条");
  await page.locator(`.react-flow__node[data-id="${ids[2]}"] .factory-handle--input`).first().click({ force: true });
  await expect(preview.getByRole("alert")).toContainText(/缺少.*传送带/);
  await expect(preview.getByRole("button", { name: "确认连接" })).toBeDisabled();
  await expect(page.locator(".react-flow__edge")).toHaveCount(0);
  await preview.getByRole("button", { name: "取消" }).click();
  await expect.poll(async () => {
    const state = await readPersistedPrimaryState(page);
    return { belts: state.belts, construction: state.construction.conveyor_belt_mk1 };
  }).toEqual(before);
});

test("Ctrl starts a continuous preview and Enter commits without holding the modifier", async ({ page }) => {
  await seedFactory(page, "storage-network");
  const ids = (await readPersistedPrimaryState(page)).entities
    .filter((entity) => entity.buildingId === "storage_mk1")
    .map((entity) => entity.id);
  const beforeState = await readPersistedPrimaryState(page);
  const before = { belts: beforeState.belts.length, construction: beforeState.construction.conveyor_belt_mk1 };

  await page.locator(`.react-flow__node[data-id="${ids[0]}"] .factory-handle--output`).first().click({ force: true });
  await page.locator(`.react-flow__node[data-id="${ids[1]}"] .factory-handle--input`).first().click({ force: true, modifiers: ["Control"] });
  const preview = page.getByLabel("连续拉线预览");
  await expect(preview).toContainText("1 条");
  await expect(page.getByLabel("连续拉线模式")).toHaveAttribute("aria-pressed", "true");

  // Once Ctrl has promoted the interaction to continuous mode, subsequent
  // targets no longer require a held modifier.
  await page.locator(`.react-flow__node[data-id="${ids[2]}"] .factory-handle--input`).first().click({ force: true });
  await expect(preview).toContainText("2 条");
  await page.keyboard.press("Enter");
  await expect(preview).toHaveCount(0);
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
  await page.getByLabel("保存并返回主菜单").click();
  await expect(page.locator(".start-menu")).toBeVisible();
  const afterState = await readPersistedPrimaryState(page);
  const after = { belts: afterState.belts.length, construction: afterState.construction.conveyor_belt_mk1 };
  expect(after).toEqual({ belts: before.belts + 2, construction: before.construction - 2 });
});

test("Escape cancels the whole continuous preview without changing belts or materials", async ({ page }) => {
  await seedFactory(page, "storage-network");
  const ids = (await readPersistedPrimaryState(page)).entities
    .filter((entity) => entity.buildingId === "storage_mk1")
    .map((entity) => entity.id);
  const beforeState = await readPersistedPrimaryState(page);
  const before = { belts: beforeState.belts, construction: beforeState.construction.conveyor_belt_mk1 };

  await page.getByLabel("连续拉线模式").click();
  await page.locator(`.react-flow__node[data-id="${ids[0]}"] .factory-handle--output`).first().click({ force: true });
  await page.locator(`.react-flow__node[data-id="${ids[1]}"] .factory-handle--input`).first().click({ force: true });
  await expect(page.getByLabel("连续拉线预览")).toContainText("1 条");
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("连续拉线预览")).toHaveCount(0);
  await expect(page.locator(".react-flow__edge")).toHaveCount(0);
  await expect.poll(async () => {
    const state = await readPersistedPrimaryState(page);
    return { belts: state.belts, construction: state.construction.conveyor_belt_mk1 };
  }).toEqual(before);
});

test("next mobile UI exposes equivalent confirm, clear, and undo controls", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => window.localStorage.setItem("dsp-idle-network.mobile-ui.v1", "next"));
  await seedFactory(page, "storage-network");
  await page.getByLabel("打开画布工具").click();
  await page.locator(".mobile-tools-sheet").getByLabel("连续拉线模式").click();
  // Port geometry and coarse-pointer snapping are covered independently in
  // game-flow.spec.ts. This case keeps the mobile control contract isolated
  // from the generated resource-vein layout.
  const actions = page.getByLabel("移动端连续拉线操作");
  await expect(actions).toContainText("0 条候选");
  await expect(actions.getByRole("button", { name: "确认" })).toBeVisible();
  await expect(actions.getByRole("button", { name: "清空" })).toBeVisible();
  await expect(actions.getByRole("button", { name: "撤销" })).toBeVisible();
  await expect(actions.getByRole("button", { name: "确认" })).toBeDisabled();
  await expect(actions.getByRole("button", { name: "清空" })).toBeDisabled();
  await expect(page.locator(".react-flow__edge")).toHaveCount(0);
  await actions.getByRole("button", { name: "撤销" }).click();
  await expect(actions).toHaveCount(0);
});

test("a mobile long press on an output port enters continuous connection without opening the inspector", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => window.localStorage.setItem("dsp-idle-network.mobile-ui.v1", "next"));
  await seedFactory(page, "storage-network");
  const sourceId = (await readPersistedPrimaryState(page)).entities
    .find((entity) => entity.buildingId === "storage_mk1" && entity.storedItemId === "iron_ore")?.id ?? null;
  expect(sourceId).not.toBeNull();
  const source = page.locator(`.react-flow__node[data-id="${sourceId}"] .factory-handle--output`).first();
  const bounds = await source.boundingBox();
  if (!bounds) throw new Error("mobile source port has no geometry");
  const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  await source.dispatchEvent("pointerdown", { pointerId: 141, pointerType: "touch", isPrimary: true, button: 0, clientX: point.x, clientY: point.y });
  await page.waitForTimeout(560);
  await source.dispatchEvent("pointerup", { pointerId: 141, pointerType: "touch", isPrimary: true, button: 0, clientX: point.x, clientY: point.y });
  // Reproduce the synthetic click emitted by mobile browsers after a long
  // press; it must be consumed instead of replacing the selected source.
  await source.dispatchEvent("click", { clientX: point.x, clientY: point.y });

  await expect(page.getByLabel("移动端连续拉线操作")).toContainText("0 条候选");
  await expect(page.locator(`.react-flow__node[data-id="${sourceId}"]`)).toHaveClass(/factory-flow-node--connection-origin/);
  await expect(page.getByRole("dialog", { name: "设备快捷操作" })).toHaveCount(0);
  await expect(page.locator(".mobile-inspector-sheet")).toHaveCount(0);
});

test("desktop mixed selection exposes atomic batch increase controls", async ({ page }) => {
  await seedFactory(page);
  await page.getByLabel("框选模式").click();
  const nodes = page.locator('.react-flow__node').filter({ hasText: "熔炉" });
  await expect(nodes).toHaveCount(2);
  await nodes.nth(0).click();
  await nodes.nth(1).click({ modifiers: ["Shift"] });
  const toolbar = page.locator(".selection-toolbar");
  await expect(toolbar).toBeVisible();
  await toolbar.locator('button[title="批量增加 1"]').click();
  await expect(page.locator(".game-dialog")).toContainText("批量增加");
  await page.getByRole("button", { name: "批量增加" }).click();
  await expect(page.locator(".game-notice, .interaction-burst")).toContainText(/已批量增加/);
});

test("next mobile selection keeps multiple nodes selected after a canvas refresh", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => window.localStorage.setItem("dsp-idle-network.mobile-ui.v1", "next"));
  await seedFactory(page);
  await page.getByLabel("打开画布工具").click();
  await page.getByRole("button", { name: "逐点多选" }).click();
  // The mobile shell hides React Flow's visual controls; invoke fit-view
  // through the existing control so both seeded nodes receive a touch target.
  await page.locator(".react-flow__controls-fitview").evaluate((element) => (element as HTMLButtonElement).click());
  await page.waitForTimeout(120);
  const nodes = page.locator('.react-flow__node').filter({ hasText: "熔炉" });
  await nodes.nth(0).tap();
  await nodes.nth(1).tap();
  await expect(page.locator(".mobile-mode-status--select")).toContainText("2 节点");
  await page.waitForTimeout(400);
  await expect(page.locator(".mobile-mode-status--select")).toContainText("2 节点");
});

