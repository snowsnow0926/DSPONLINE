import { expect, test, type Locator, type Page } from "@playwright/test";
import { workflowTimeoutMs } from "./startup-timeout";

async function openProbe(page: Page) {
  await page.route("**/__draft_focus_probe__", (route) => route.fulfill({ contentType: "text/html", body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div></body></html>' }));
  await page.goto("/__draft_focus_probe__");
  await page.evaluate(async () => {
    const refresh = await import("/@react-refresh");
    refresh.default.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type;
    window.__vite_plugin_react_preamble_installed__ = true;
    const { mountDraftFocusProbe } = await import("/tests/fixtures/draftFocusProbe.tsx");
    mountDraftFocusProbe();
  });
  await expect(page.getByLabel("区域名称", { exact: true })).toBeVisible();
}

async function preedit(field: Locator, value: string) {
  await field.focus();
  await field.dispatchEvent("compositionstart");
  await field.evaluate((element, value) => {
    const native = element as HTMLInputElement | HTMLTextAreaElement;
    const prototype = native instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(native, value);
    native.setSelectionRange(1, 4, "forward");
    window.__oldReviewField = native;
  }, value);
}

for (const device of [
  { name: "desktop", viewport: { width: 1280, height: 800 }, hasTouch: false },
  { name: "portrait", viewport: { width: 390, height: 844 }, hasTouch: true },
]) {
  test.describe(device.name, () => {
    test.use({ viewport: device.viewport, hasTouch: device.hasTouch });

    test("region selection cannot transfer an unfinished name or late IME event to a different region", async ({ page }) => {
      await openProbe(page);
      const name = page.getByLabel("区域名称", { exact: true });
      await preedit(name, "甲区域未确认中文");
      await page.evaluate(() => window.__draftFocusReview.select("b"));
      await expect(page.getByTestId("selected")).toHaveText("b");
      await expect(name).toHaveValue("同名区域");
      await expect(name).toBeFocused();
      await page.evaluate(() => window.__oldReviewField.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "甲的迟到输入" })));
      await expect(page.getByTestId("commits")).toHaveText("[]");
      await name.fill("乙区域名称"); await name.press("Tab");
      await expect(page.getByTestId("commits")).toHaveText('[{"id":"b","name":"乙区域名称"}]');
      expect(await page.evaluate(() => window.__draftFocusReview.readRegion("b"))).toBeNull();
      await page.evaluate(() => window.__draftFocusReview.select("a"));
      await expect(name).toHaveValue("甲区域未确认中文");
    });

    test("responsive remount keeps a native pre-input draft, focus and selection", async ({ page }) => {
      await openProbe(page);
      const notes = page.getByLabel("备注", { exact: true });
      await preedit(notes, "尚未发送事件的中文草稿");
      await page.setViewportSize(device.hasTouch ? { width: 844, height: 390 } : { width: 390, height: 844 });
      await expect(notes).toHaveValue("尚未发送事件的中文草稿");
      await expect(notes).toBeFocused();
      expect(await notes.evaluate((field: HTMLTextAreaElement) => [field.selectionStart, field.selectionEnd])).toEqual([1, 4]);
      await page.screenshot({ path: `artifacts/review-storage-drafts-20261105/${process.env.DSP_REVIEW_CHECK_NAME || "browser"}-${device.name}-responsive-draft.png` });
    });

    test("private field mode changes and explicit draft cancellation do not resurrect old text or auto-focus a reopened field", async ({ page }) => {
      await openProbe(page);
      const privateField = page.getByLabel("隐私字段", { exact: true });
      await privateField.fill("test-only-private-buffer");
      expect(await page.evaluate(() => window.__draftFocusReview.readPrivate())).toBeNull();
      await page.evaluate(() => window.__draftFocusReview.setSensitive(false));
      await expect(privateField).toHaveValue("");
      const notes = page.getByLabel("备注", { exact: true });
      await preedit(notes, "已取消的中文");
      await page.evaluate(() => window.__draftFocusReview.clearNotes());
      await expect(notes).toHaveCount(0);
      expect(await page.evaluate(() => window.__draftFocusReview.readNotes())).toBeNull();
      await page.evaluate(() => window.__draftFocusReview.setNotesOpen(true));
      await expect(notes).toHaveValue("");
      await expect(notes).not.toBeFocused();
    });

    test("nested dialogs return focus to the current opener after parent removal and layout changes", async ({ page }) => {
      await openProbe(page);
      await page.getByRole("button", { name: "打开焦点弹窗", exact: true }).click();
      await page.getByRole("button", { name: "打开子弹窗", exact: true }).click();
      await page.evaluate(() => window.__draftFocusReview.closeOuter());
      await expect(page.getByRole("dialog", { name: "父弹窗", exact: true })).toHaveCount(0);
      await page.setViewportSize(device.hasTouch ? { width: 844, height: 390 } : { width: 390, height: 844 });
      const child = page.getByRole("dialog", { name: "子弹窗", exact: true });
      await expect(child.getByRole("button", { name: "关闭子弹窗" })).toBeFocused();
      await child.getByRole("button", { name: "关闭子弹窗" }).click();
      await expect(page.getByRole("button", { name: "打开焦点弹窗", exact: true })).toBeFocused();
      expect(await page.locator("#root").getAttribute("inert")).toBeNull();
    });
  });
}

test("denied localStorage preferences keep the existing IndexedDB save and disabled autosave intact", async ({ page }) => {
  // Three separate application boots share one low-priority worker. Startup
  // readiness gets its own bounded wait; save-content assertions stay exact.
  test.setTimeout(workflowTimeoutMs(180_000));
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    if (sessionStorage.getItem("review-deny-preferences") === "1") {
      Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new DOMException("isolated preference denial", "SecurityError"); } });
      return;
    }
    if (sessionStorage.getItem("review-save-seeded") === "1") return;
    sessionStorage.setItem("review-save-seeded", "1");
    localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-11-13-v1.3.13");
    localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
    localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state: {
      version: 47, entities: [], belts: [], construction: {}, tray: { iron_ore: 42 }, paused: true,
      research: { selectedTechId: null, progressByTech: {}, completedTechIds: ["electromagnetism"] },
      settings: { theme: "dark", fontScale: 1, simulationSpeed: 1, autosaveIntervalSeconds: 0, resourceMode: "finite" },
    } }));
  });
  await page.route("**/api/**", (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"isolated storage review"}' }));
  await page.goto("/");
  await expect(page.locator(".factory-canvas")).toBeVisible({ timeout: 60_000 });
  const ore = page.locator('.tray-row[title="拿取铁矿石"] strong');
  await expect(ore).toHaveText("42");
  await page.evaluate(() => sessionStorage.setItem("review-deny-preferences", "1"));
  await page.reload();
  await expect(page.locator(".factory-canvas")).toBeVisible({ timeout: 60_000 });
  await expect(ore).toHaveText("42");
  const denied = await page.evaluate(async () => {
    const { readOfflineSettlementPreference } = await import("/src/game/offlineSettlementStrategy.ts");
    const { loadGame } = await import("/src/game/storage.ts");
    const game = loadGame().state;
    return { preference: readOfflineSettlementPreference(), ore: game.tray.iron_ore, autosave: game.settings.autosaveIntervalSeconds, researched: game.research.completedTechIds.includes("electromagnetism") };
  });
  expect(denied).toEqual({ preference: "ask", ore: 42, autosave: 0, researched: true });
  const releaseClose = page.getByRole("button", { name: "关闭版本更新记录" });
  if (await releaseClose.isVisible()) await releaseClose.click();
  await page.getByLabel("打开设置", { exact: true }).click();
  const operations = page.getByRole("dialog", { name: "运营中心", exact: true });
  await operations.getByRole("button", { name: "教程、版本与其他", exact: true }).click();
  await operations.getByLabel("打开新手教程", { exact: true }).click();
  const tutorial = page.getByRole("dialog", { name: "新手教程", exact: true });
  await expect(tutorial).toBeVisible();
  await tutorial.getByRole("button", { name: "标记本节完成", exact: true }).click();
  await expect(tutorial.getByRole("button", { name: "已完成", exact: true })).toBeVisible();
  await tutorial.getByRole("button", { name: "关闭新手教程", exact: true }).click();
  await page.evaluate(() => sessionStorage.removeItem("review-deny-preferences"));
  await page.reload();
  await expect(page.locator(".factory-canvas")).toBeVisible({ timeout: 60_000 });
  await expect(ore).toHaveText("42");
  expect(errors).toEqual([]);
});
