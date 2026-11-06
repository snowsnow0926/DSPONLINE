import { expect, test, type Locator, type Page } from "@playwright/test";

async function openReviewFactory(page: Page, withNode = false) {
  await page.addInitScript((includeNode) => {
    sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-11-07-v1.3.9");
    localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
    localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state: {
      version: 47, entities: includeNode ? [{ id: "review-vein", kind: "vein", planetId: "home", position: { x: 0, y: 0 }, resourceId: "iron_ore", minerCount: 1, resourceRemaining: 1000, resourceCapacity: 1000, inputs: {}, outputs: { iron_ore: 7 }, progress: 0, routingCursor: 0, utilization: 0, productionRate: 0 }] : [], belts: [], construction: {}, tray: {}, totalProduced: {}, paused: true,
      research: { selectedTechId: null, progressByTech: {}, completedTechIds: ["electromagnetism", "basic_smelting"] },
      blueprints: [{ id: "review-blueprint", name: "审查蓝图", revision: 1, rotation: 0, mirror: "none", entities: [{ key: "smelter", buildingId: "arc_smelter", offset: { x: 0, y: 0 }, machineCount: 1, recipeId: "iron_ingot" }], belts: [] }],
      settings: { theme: "dark", fontScale: 1, simulationSpeed: 1, autosaveIntervalSeconds: 0, resourceMode: "finite" },
    } }));
  }, withNode);
  await page.route("**/api/**", (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"isolated UI review"}' }));
  await page.goto(withNode ? "/?mobileUi=next" : "/");
  await expect(page.locator(".game-shell")).toBeVisible();
}

async function preedit(input: Locator, value: string) {
  await input.focus();
  await input.dispatchEvent("compositionstart", { data: "" });
  await input.evaluate((element, next) => {
    const native = element as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(native, next);
    native.dispatchEvent(new InputEvent("input", { bubbles: true, data: next, inputType: "insertCompositionText", isComposing: true }));
  }, value);
}

test("IME confirmation does not run a command and the following Enter still executes it", async ({ page }) => {
  await openReviewFactory(page);
  await page.getByLabel("打开命令面板").click();
  const palette = page.getByRole("dialog", { name: "命令面板" });
  const input = palette.getByRole("combobox", { name: "搜索命令" });
  await preedit(input, "科技");
  await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
  await expect(palette).toBeVisible();
  await expect(input).toBeFocused();
  await input.dispatchEvent("compositionend", { data: "科技" });
  await expect(palette.getByRole("option", { name: /打开科技树/ })).toBeVisible();
  await input.press("Enter");
  await expect(palette).toHaveCount(0);
  // A cold Vite workspace transform can exceed 15s on the deliberately Idle,
  // single-core review worker. Keep both Enter assertions; allow module mount.
  await expect(page.getByRole("dialog", { name: /科技树/ })).toBeVisible({ timeout: 60_000 });
});

test("IME candidate arrows do not change command selection", async ({ page }) => {
  await openReviewFactory(page);
  await page.getByLabel("打开命令面板").click();
  const palette = page.getByRole("dialog", { name: "命令面板" });
  const input = palette.getByRole("combobox", { name: "搜索命令" });
  const selected = await input.getAttribute("aria-activedescendant");
  await preedit(input, "ke ji");
  await input.dispatchEvent("keydown", { key: "ArrowDown", code: "ArrowDown", isComposing: true });
  await expect(input).toHaveAttribute("aria-activedescendant", selected!);
});

test("keyboard command selection scrolls within its own result list", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 540 });
  await openReviewFactory(page);
  await page.getByLabel("打开命令面板").click();
  const palette = page.getByRole("dialog", { name: "命令面板" });
  const input = palette.getByRole("combobox", { name: "搜索命令" });
  await expect(palette.getByRole("option")).toHaveCount(12);
  const documentScroll = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
  for (let index = 0; index < 11; index++) await input.press("ArrowDown");
  const active = palette.locator('[role="option"][aria-selected="true"]');
  const isInList = () => active.evaluate((row) => {
    const list = row.parentElement!;
    const a = row.getBoundingClientRect();
    const b = list.getBoundingClientRect();
    return a.top >= b.top - 1 && a.bottom <= b.top + list.clientHeight + 1;
  });
  await expect.poll(isInList).toBe(true);
  for (let index = 0; index < 11; index++) await input.press("ArrowUp");
  await expect.poll(isInList).toBe(true);
  await expect(input).toBeFocused();
  expect(await page.evaluate(() => ({ x: scrollX, y: scrollY }))).toEqual(documentScroll);
});

test("blueprint naming does not blur or commit while Enter confirms an IME candidate", async ({ page }) => {
  await openReviewFactory(page);
  await page.getByLabel("打开蓝图库").click();
  const workspace = page.getByRole("dialog", { name: /蓝图/ });
  const input = workspace.getByRole("textbox", { name: "审查蓝图名称", exact: true });
  await preedit(input, "新的中文蓝图");
  await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute("aria-label", "审查蓝图名称");
  await input.dispatchEvent("compositionend", { data: "新的中文蓝图" });
  await input.press("Enter");
  await expect(workspace.getByRole("textbox", { name: "新的中文蓝图名称", exact: true })).toHaveValue("新的中文蓝图");
});

test("hovering a partially visible command leaves the player's scroll position unchanged", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 540 });
  await openReviewFactory(page);
  await page.getByLabel("打开命令面板").click();
  const palette = page.getByRole("dialog", { name: "命令面板" });
  const input = palette.getByRole("combobox", { name: "搜索命令" });
  await input.press("ArrowDown"); await input.press("ArrowDown");
  const list = palette.getByRole("listbox", { name: "命令结果" });
  await list.evaluate((element) => { element.scrollTop = 23; });
  const box = (await list.boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + 10);
  await expect(palette.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
  expect(await list.evaluate((element) => element.scrollTop)).toBe(23);
  await input.press("ArrowUp");
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeLessThan(23);
});

for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
  test.describe(`mobile command layout ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport, hasTouch: true, isMobile: true });
    test("command layout keeps touch controls and selected results separate at every font scale", async ({ page }) => {
      await openReviewFactory(page);
      await page.keyboard.press("Control+k");
      const palette = page.getByRole("dialog", { name: "命令面板" });
      const input = palette.getByRole("combobox", { name: "搜索命令" });
      for (const scale of [80, 100, 125, 150, 200]) {
        await page.evaluate((scale) => {
          document.documentElement.dataset.uiFontScale = String(scale);
          document.documentElement.style.setProperty("--ui-font-scale", String(scale / 100));
        }, scale);
        for (let index = 0; index < 11; index++) await input.press("ArrowDown");
        await expect.poll(() => palette.evaluate((surface) => {
          const header = surface.querySelector("header")!.getBoundingClientRect();
          const search = surface.querySelector(".command-palette-search")!.getBoundingClientRect();
          const input = surface.querySelector("input")!.getBoundingClientRect();
          const list = surface.querySelector<HTMLElement>('[role="listbox"]')!;
          const bounds = list.getBoundingClientRect();
          const row = surface.querySelector('[aria-selected="true"]')!.getBoundingClientRect();
          const dialog = surface.getBoundingClientRect();
          return {
            headerClear: header.bottom <= search.top + 1,
            inputClear: input.bottom <= search.bottom + 1 && search.bottom <= bounds.top + 1,
            selectedVisible: row.top >= bounds.top - 1 && row.bottom <= bounds.top + list.clientHeight + 1,
            withinViewport: dialog.left >= -1 && dialog.right <= innerWidth + 1 && dialog.top >= -1 && dialog.bottom <= innerHeight + 1,
            geometry: { dialogTop: dialog.top, dialogBottom: dialog.bottom, inputBottom: input.bottom, searchBottom: search.bottom, listTop: bounds.top, listBottom: bounds.top + list.clientHeight, rowTop: row.top, rowBottom: row.bottom },
          };
        }), { message: `${viewport.width}x${viewport.height}, font ${scale}%` }).toMatchObject({ headerClear: true, inputClear: true, selectedVisible: true, withinViewport: true });
        await expect(input).toBeFocused();
      }
    });
  });
}

test.describe("actual mobile touch gestures", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("a real held touch opens the entity menu, while a cancelled touch does not open it later", async ({ page }) => {
    await openReviewFactory(page, true);
    await expect(page.locator(".game-shell")).toHaveAttribute("data-coarse-pointer", "true");
    // Use the player's locate action before sending coordinates: an entity
    // can exist in the canvas DOM while still being outside the viewport.
    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog", { name: "命令面板" });
    await palette.getByRole("combobox", { name: "搜索命令" }).fill("review-vein");
    await palette.getByRole("option", { name: /review-vein/ }).click();
    await expect(palette).toHaveCount(0);
    const closeInspector = async () => {
      const inspector = page.getByRole("dialog", { name: "铁矿石", exact: true });
      if (await inspector.isVisible()) {
        await inspector.getByRole("button", { name: "关闭铁矿石", exact: true }).click();
        await expect(inspector).toHaveCount(0);
      }
    };
    await closeInspector();
    const node = page.locator('.react-flow__node[data-id="review-vein"]');
    await expect(node).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => node.evaluate((element) => element.closest("[inert]") === null)).toBe(true);
    let previous = "";
    await expect.poll(async () => {
      const rect = (await node.boundingBox())!;
      const current = `${rect.x.toFixed(2)}:${rect.y.toFixed(2)}`;
      const stable = current === previous;
      previous = current;
      return stable;
    }, { intervals: [100] }).toBe(true);
    const box = (await node.boundingBox())!;
    const x = box.x + Math.min(8, box.width / 3);
    const y = box.y + Math.min(42, box.height / 2);
    expect(x).toBeGreaterThan(0); expect(x).toBeLessThan(390);
    expect(y).toBeGreaterThan(0); expect(y).toBeLessThan(844);
    expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest(".react-flow__node")?.getAttribute("data-id"), { x, y })).toBe("review-vein");
    const cdp = await page.context().newCDPSession(page);
    const menu = page.getByRole("dialog", { name: "设备快捷操作" });
    const bounded = async <T,>(promise: Promise<T>, milliseconds = 5000): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([promise, new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Touch protocol deadline exceeded")), milliseconds); })]);
      } finally { clearTimeout(timer); }
    };
    try {
      await bounded(cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] }));
      await expect(menu).toBeVisible();
      await bounded(cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }));
      await expect(menu).toBeVisible();
      await menu.getByRole("button", { name: "关闭快捷操作" }).click();
      await closeInspector();
      await expect.poll(() => node.evaluate((element) => element.closest("[inert]") === null)).toBe(true);
      await bounded(cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 2 }] }));
      await expect(menu).toBeVisible();
      await bounded(cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }));
      await expect(menu).toBeVisible();
      const dismissPoint = await menu.evaluate((element) => {
        const topbar = document.querySelector(".mobile-next-topbar")!.getBoundingClientRect();
        return { x: 20, y: (topbar.bottom + element.getBoundingClientRect().top) / 2 };
      });
      expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.classList.contains("mobile-action-backdrop"), dismissPoint)).toBe(true);
      await page.touchscreen.tap(dismissPoint.x, dismissPoint.y);
      await expect(menu).toHaveCount(0);
      await bounded(cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 3 }] }));
      await bounded(cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] }));
      await page.waitForTimeout(700);
      await expect(menu).toHaveCount(0);
    } finally {
      await bounded(cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] }), 1000).catch(() => undefined);
      await bounded(cdp.detach(), 1000).catch(() => undefined);
    }
  });
});
