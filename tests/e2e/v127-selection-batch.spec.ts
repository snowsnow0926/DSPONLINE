import { expect, test, type Page } from "@playwright/test";
import { selectSettingsCategory } from "./settings-helpers";

test.use({ hasTouch: true });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-27-v1.2.2");
    window.localStorage.setItem("dsp-idle-network.onboarding.v1", "dismissed");
  });
});

async function seedFactory(page: Page, fixture: "smelters" | "storage-network" = "smelters", storageTargetCount = 2) {
  // The app migrates the primary save to IndexedDB before mounting. Seed the
  // fixture before boot so the same path is exercised as a real fresh browser.
  await page.goto("/version.json");
  await page.evaluate(async ([selectedFixture, targetCount]) => {
    const { createInitialState, placeBuilding } = await import("/src/game/engine.ts");
    let state = createInitialState(27_101, false);
    state.paused = true;
    state.construction.conveyor_belt_mk1 = 12;
    if (selectedFixture === "storage-network") {
      const storageCount = Math.max(3, targetCount + 1);
      state.construction.storage_mk1 = storageCount;
      state.construction.conveyor_belt_mk1 = Math.max(12, targetCount + 2);
      for (let index = 0; index < storageCount; index += 1) {
        const position = index === 0 ? { x: -260, y: -80 }
          : index === 1 ? { x: 20, y: -160 }
            : index === 2 ? { x: 20, y: 80 }
              : { x: -1_200 + ((index - 3) % 8) * 320, y: -900 + Math.floor((index - 3) / 8) * 220 };
        state = placeBuilding(state, "storage_mk1", {
          ...position,
        });
      }
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
  }, [fixture, storageTargetCount]);
  await page.goto("/");
  await expect(page.locator(".game-shell")).toBeVisible({ timeout: 15_000 });
}

/**
 * React Flow keeps the logical handles mounted even when fit-view places some
 * of them outside the browser viewport. Dispatch the same bubbling pointer
 * sequence directly on that mounted handle instead of asking Playwright to
 * scroll an off-screen node into view (which can change the canvas viewport
 * and invalidate the pressure fixture).
 */
async function clickMountedHandle(locator: ReturnType<Page["locator"]>) {
  // React Flow's pointerdown handler also owns pan/connection gesture state;
  // synthesizing a second pointer sequence for an off-screen node can leave
  // StoreUpdater with two competing viewport transactions. A bubbling click
  // is the same connect-on-click boundary used by the product and does not
  // mutate the viewport.
  const point = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await locator.dispatchEvent("click", { bubbles: true, button: 0, clientX: point.x, clientY: point.y });
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
    await expect.poll(() => handles.count()).toBeGreaterThanOrEqual(3);
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
  await expect(preview).toContainText("小型储物仓 · 输入接口");
  await page.locator(`.react-flow__node[data-id="${seeded[1].id}"] .factory-handle--input`).first().click({ force: true });
  await expect(preview.getByRole("status")).toContainText("已在预览列表中");
  await expect(preview.getByRole("button", { name: "确认连接" })).toBeEnabled();
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

test("a duplicate target stays non-blocking and commits only the original candidate", async ({ page }) => {
  await seedFactory(page, "storage-network");
  const ids = (await readPersistedPrimaryState(page)).entities
    .filter((entity) => entity.buildingId === "storage_mk1")
    .map((entity) => entity.id);
  const beforeState = await readPersistedPrimaryState(page);
  const before = { belts: beforeState.belts.length, construction: beforeState.construction.conveyor_belt_mk1 };

  await page.getByLabel("连续拉线模式").click();
  await page.locator(`.react-flow__node[data-id="${ids[0]}"] .factory-handle--output`).first().click({ force: true });
  const target = page.locator(`.react-flow__node[data-id="${ids[1]}"] .factory-handle--input`).first();
  await target.click({ force: true });
  await target.click({ force: true });

  const preview = page.getByLabel("连续拉线预览");
  await expect(preview).toContainText("1 条");
  await expect(preview.getByRole("status")).toContainText("已在预览列表中");
  await expect(preview.getByRole("button", { name: "确认连接" })).toBeEnabled();
  await preview.getByRole("button", { name: "确认连接" }).click();
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);

  await page.getByLabel("保存并返回主菜单").click();
  await expect(page.locator(".start-menu")).toBeVisible();
  const after = await readPersistedPrimaryState(page);
  expect(after.belts).toHaveLength(before.belts + 1);
  expect(after.belts.at(-1)).toMatchObject({ source: ids[0], target: ids[1], itemId: "iron_ore" });
  expect(after.construction.conveyor_belt_mk1).toBe(before.construction - 1);
});

test("an insufficient new tap does not block an earlier valid candidate", async ({ page }) => {
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
  await expect(preview.getByRole("status")).toContainText(/缺少.*传送带/);
  await expect(preview.getByRole("button", { name: "确认连接" })).toBeEnabled();
  await expect(page.locator(".react-flow__edge")).toHaveCount(0);
  await preview.getByRole("button", { name: "确认连接" }).click();
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  await page.getByLabel("保存并返回主菜单").click();
  await expect(page.locator(".start-menu")).toBeVisible();
  await expect.poll(async () => {
    const state = await readPersistedPrimaryState(page);
    return { belts: state.belts.length, construction: state.construction.conveyor_belt_mk1 };
  }).toEqual({ belts: before.belts.length + 1, construction: before.construction - 10 });
});

test("removing any candidate and undoing the latest preserve the intended target order", async ({ page }) => {
  await seedFactory(page, "storage-network", 3);
  const ids = (await readPersistedPrimaryState(page)).entities
    .filter((entity) => entity.buildingId === "storage_mk1")
    .map((entity) => entity.id);
  expect(ids).toHaveLength(4);

  await page.getByLabel("连续拉线模式").click();
  await page.locator(`.react-flow__node[data-id="${ids[0]}"] .factory-handle--output`).first().click({ force: true });
  for (const targetId of ids.slice(1)) {
    await clickMountedHandle(page.locator(`.react-flow__node[data-id="${targetId}"] .factory-handle--input`).first());
  }
  const preview = page.getByLabel("连续拉线预览");
  await expect(preview).toContainText("3 条");

  await preview.getByRole("button", { name: "移除第 2 条候选" }).click();
  await expect(preview).toContainText("2 条");
  await preview.getByRole("button", { name: "撤销" }).click();
  await expect(preview).toContainText("1 条");
  await preview.getByRole("button", { name: "确认连接" }).click();
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);

  await page.getByLabel("保存并返回主菜单").click();
  await expect(page.locator(".start-menu")).toBeVisible();
  const after = await readPersistedPrimaryState(page);
  expect(after.belts).toHaveLength(1);
  expect(after.belts[0]).toMatchObject({ source: ids[0], target: ids[1], itemId: "iron_ore" });
});

test("final atomic revalidation identifies the failed candidate without creating or consuming anything", async ({ page }) => {
  await seedFactory(page, "storage-network");
  const ids = (await readPersistedPrimaryState(page)).entities
    .filter((entity) => entity.buildingId === "storage_mk1")
    .map((entity) => entity.id);
  const beforeState = await readPersistedPrimaryState(page);
  const before = { belts: beforeState.belts, construction: beforeState.construction.conveyor_belt_mk1 };

  await page.getByLabel("连续拉线模式").click();
  await page.locator(`.react-flow__node[data-id="${ids[0]}"] .factory-handle--output`).first().click({ force: true });
  for (const targetId of ids.slice(1)) {
    await page.locator(`.react-flow__node[data-id="${targetId}"] .factory-handle--input`).first().click({ force: true });
  }
  const preview = page.getByLabel("连续拉线预览");
  await expect(preview).toContainText("2 条");

  // Change a device-only preference after previewing. The final commit must
  // revalidate against the current lane count instead of trusting stale UI.
  await page.getByLabel("打开设置").click();
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await selectSettingsCategory(operations, "交互与控制", "interaction");
  const lanes = operations.locator(".settings-belt-lanes");
  await lanes.getByRole("button", { name: "自定义" }).click();
  await lanes.getByLabel("新建传送带默认并联数量自定义值").fill("10");
  await lanes.getByRole("button", { name: "应用" }).click();
  await expect(lanes).toContainText("10 / 4,096");
  await operations.getByLabel("关闭运营中心").click();

  await preview.getByRole("button", { name: "确认连接" }).click();
  await expect(preview.getByRole("alert")).toContainText(/第 2 条.*缺少.*传送带/);
  await expect(page.locator(".react-flow__edge")).toHaveCount(0);
  await preview.getByRole("button", { name: "取消" }).click();
  await page.getByLabel("保存并返回主菜单").click();
  await expect(page.locator(".start-menu")).toBeVisible();
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
  await expect(actions.getByRole("button", { name: "撤销" })).toBeVisible();
  await expect(actions.getByRole("button", { name: "确认" })).toBeDisabled();
  await expect(page.locator(".react-flow__edge")).toHaveCount(0);
  await expect(actions.getByRole("button", { name: "撤销" })).toBeDisabled();
  await actions.getByRole("button", { name: "展开候选列表" }).click();
  await expect(actions.getByRole("button", { name: "清空候选" })).toBeVisible();
  await expect(actions.getByRole("button", { name: "清空候选" })).toBeDisabled();
  await expect(actions.getByRole("button", { name: "退出连续模式" })).toBeVisible();
  await actions.getByRole("button", { name: "退出连续模式" }).click();
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

for (const candidateCount of [6, 10, 50, 100] as const) {
  test(`mobile continuous candidates stay stable at ${candidateCount} entries`, async ({ page }) => {
    test.setTimeout(120_000);
    const pageErrors: string[] = [];
    const runtimeConsoleErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" || message.text().includes("[DSP runtime render error]")) runtimeConsoleErrors.push(message.text());
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => {
      window.localStorage.setItem("dsp-idle-network.mobile-ui.v1", "next");
      // Keep every candidate handle mounted so this test exercises the real
      // list/state path instead of a canvas LOD shortcut.
      window.localStorage.setItem("dsp-idle-network.ui.canvas-detail.v1", "full");
    });
    await seedFactory(page, "storage-network", candidateCount);
    const state = await readPersistedPrimaryState(page);
    const storageIds = state.entities.filter((entity) => entity.buildingId === "storage_mk1").map((entity) => entity.id);
    expect(storageIds).toHaveLength(candidateCount + 1);

    await page.getByLabel("打开画布工具").click();
    await page.locator(".mobile-tools-sheet").getByLabel("连续拉线模式").click();
    await page.locator(".react-flow__controls-fitview").evaluate((element) => (element as HTMLButtonElement).click());
    await page.waitForTimeout(180);
    const actions = page.getByLabel("移动端连续拉线操作");
    const source = page.locator(`.react-flow__node[data-id="${storageIds[0]}"] .factory-handle--output`).first();
    await clickMountedHandle(source);
    for (const [index, targetId] of storageIds.slice(1).entries()) {
      await clickMountedHandle(page.locator(`.react-flow__node[data-id="${targetId}"] .factory-handle--input`).first());
      if ((index + 1) % 10 === 0 || index === storageIds.length - 2) {
        await expect(actions).toContainText(`${index + 1} 条候选`, { timeout: 30_000 });
      }
    }
    await expect(page.locator(".batch-connection-panel")).toHaveCount(0);
    await expect(page.locator(".dynamic-import-fatal")).toHaveCount(0);

    const compactBox = await actions.boundingBox();
    expect(compactBox).not.toBeNull();
    expect(compactBox!.y).toBeGreaterThan(844 * 0.62);

    await actions.getByRole("button", { name: "展开候选列表" }).click();
    const list = page.getByLabel("连续拉线候选列表");
    await expect(list.locator("li")).toHaveCount(candidateCount);
    await expect(list).not.toContainText(storageIds[1]);
    await list.getByRole("button", { name: "定位" }).first().click();
    await list.getByRole("button", { name: /移除第/ }).first().click();
    await expect(list.locator("li")).toHaveCount(candidateCount - 1);
    await expect(actions).toContainText(`${candidateCount - 1} 条候选`);

    await actions.locator(".mobile-batch-connection-actions__summary").click();
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 360, height: 640 },
      { width: 844, height: 390 },
    ]) {
      await page.setViewportSize(viewport);
      await expect(actions).toBeVisible();
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      const box = await actions.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.y).toBeGreaterThan(viewport.height * 0.42);
    }
    for (const scale of [0.8, 1, 1.25, 1.5] as const) {
      await page.evaluate((value) => {
        document.documentElement.dataset.uiFontScale = String(Math.round(value * 100));
        document.documentElement.style.setProperty("--ui-font-scale", String(value));
      }, scale);
      await expect.poll(() => actions.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      for (const button of await actions.locator("button").all()) {
        const box = await button.boundingBox();
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(40);
      }
    }
    expect(pageErrors).toEqual([]);
    expect(runtimeConsoleErrors.filter((message) => message.includes("ResizeObserver loop"))).toEqual([]);
    expect(runtimeConsoleErrors.filter((message) => message.includes("[DSP runtime render error]"))).toEqual([]);
  });
}

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
