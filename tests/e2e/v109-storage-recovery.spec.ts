import { expect, test } from "@playwright/test";

const SNAPSHOT_KEY = "dsp-idle-network.save.v1.snapshot.manual.idb-migration";
const RELEASE_NOTE_ID = "2026-08-17-v1.0.46";

test("verified IndexedDB migration removes the legacy localStorage save copy", async ({ page }) => {
  const legacyValue = JSON.stringify({ savedAt: 1_777_777_777_000, kind: "snapshot", reason: "迁移验证" });
  await page.addInitScript(({ key, value, releaseNoteId }) => {
    window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", releaseNoteId);
    window.localStorage.setItem(key, value);
  }, { key: SNAPSHOT_KEY, value: legacyValue, releaseNoteId: RELEASE_NOTE_ID });

  await page.goto("/?menu=1&storageMigration=production");
  await expect(page.locator(".start-menu")).toBeVisible();
  await expect.poll(() => page.evaluate((key) => window.localStorage.getItem(key), SNAPSHOT_KEY)).toBeNull();

  const persisted = await page.evaluate(async ({ databaseName, storeName, key }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return await new Promise<string | null>((resolve, reject) => {
      const request = database.transaction(storeName, "readonly").objectStore(storeName).get(key);
      request.onsuccess = () => resolve(request.result?.value ?? null);
      request.onerror = () => reject(request.error);
    });
  }, { databaseName: "dsp-idle-network.local-saves", storeName: "records", key: SNAPSHOT_KEY });

  expect(persisted).toBe(legacyValue);
});

test("mobile registration preserves sibling fields during IME composition and orientation changes", async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/health") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, schemaVersion: 7, mailProvider: "disabled" }) });
      return;
    }
    await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not mocked" }) });
  });
  await page.addInitScript((releaseNoteId) => window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", releaseNoteId), RELEASE_NOTE_ID);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?menu=1");
  const releaseNotes = page.locator(".release-notes-backdrop");
  if (await releaseNotes.isVisible().catch(() => false)) {
    await releaseNotes.locator(".release-notes-footer button").click();
    await expect(releaseNotes).toHaveCount(0);
  }
  await page.getByRole("button", { name: "登录与云存档" }).click();
  await page.getByRole("button", { name: "注册", exact: true }).click();
  const displayName = page.getByLabel("显示名称");
  const username = page.getByLabel("用户名", { exact: true });
  await displayName.fill("中文玩家");

  await username.evaluate((node) => {
    const input = node as HTMLInputElement;
    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "pilot" }));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "pilot_");
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: "pilot_", inputType: "insertCompositionText", isComposing: true }));
  });
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(displayName).toHaveValue("中文玩家");
  await expect(username).toHaveValue("pilot_");

  await username.evaluate((node) => {
    const input = node as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "pilot_2026");
    input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "pilot_2026" }));
  });
  await expect(username).toHaveValue("pilot_2026");
  await expect(displayName).toHaveValue("中文玩家");
  await expect.poll(() => page.evaluate(() => JSON.parse(window.sessionStorage.getItem("dsp-idle-network.registration-draft.v1") ?? "null"))).toEqual({
    identifier: "pilot_2026",
    displayName: "中文玩家",
  });
});

test("production-library search preserves IME composition across responsive redraws", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript((releaseNoteId) => {
    window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", releaseNoteId);
    window.localStorage.setItem("dsp-idle-network.onboarding.v1", "dismissed");
    window.localStorage.setItem("dsp-idle-network.mobile-ui.v1", "next");
  }, RELEASE_NOTE_ID);
  await page.goto("/?menu=1");
  await page.getByRole("button", { name: /开始游戏/ }).click();
  await page.getByRole("button", { name: "更多", exact: true }).click();
  await page.getByRole("button", { name: /生产资料库/ }).click();
  const library = page.getByRole("dialog", { name: "生产资料库" });
  const search = library.getByLabel("搜索配方物品");
  await search.evaluate((node) => {
    const input = node as HTMLInputElement;
    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "量子" }));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "量子");
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: "量子", inputType: "insertCompositionText", isComposing: true }));
  });
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(search).toHaveValue("量子");
  await search.dispatchEvent("compositionend", { data: "量子" });
  await expect(search).toHaveValue("量子");
});

test("verified primary saves use IndexedDB and selected snapshots can be managed in bulk", async ({ page }) => {
  await page.addInitScript((releaseNoteId) => {
    window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", releaseNoteId);
    window.localStorage.setItem("dsp-idle-network.onboarding.v1", "dismissed");
    window.localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, completedEvents: [], skipped: true }));
  }, RELEASE_NOTE_ID);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?menu=1&storageMigration=production");
  await page.getByRole("button", { name: /开始游戏/ }).click();
  await expect(page.locator(".factory-canvas")).toBeVisible();
  const shell = page.locator(".game-shell");
  await expect(shell).toHaveAttribute("data-runtime-recovery", "active", { timeout: 15_000 });
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("dsp-idle-network.save.v1"))).toBeNull();
  await expect.poll(() => page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("dsp-idle-network.local-saves");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return await new Promise<boolean>((resolve, reject) => {
      const request = database.transaction("records", "readonly").objectStore("records").get("dsp-idle-network.save.v1");
      request.onsuccess = () => resolve(typeof request.result?.value === "string");
      request.onerror = () => reject(request.error);
    });
  })).toBe(true);

  await page.getByLabel("打开设置").click();
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.locator(".operations-tabs").getByRole("tab", { name: "存档" }).click();
  await expect(operations.getByLabel("本地存储占用")).toContainText("IndexedDB");
  await operations.getByRole("button", { name: "创建快照" }).click();
  await operations.getByRole("button", { name: "创建快照" }).click();
  const manualRows = operations.locator(".save-snapshot-row").filter({ hasText: "手动快照" });
  await expect(manualRows).toHaveCount(2);
  for (const checkbox of await manualRows.locator('input[type="checkbox"]').all()) await checkbox.check();
  await operations.getByRole("button", { name: "删除所选" }).click();
  const confirmation = page.getByRole("dialog", { name: /删除2 份所选快照/ });
  await confirmation.getByRole("button", { name: /继续确认/ }).click();
  await page.getByRole("alertdialog", { name: /删除2 份所选快照/ }).getByRole("button", { name: /确认永久删除/ }).click();
  await expect(manualRows).toHaveCount(0);

  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("dsp-idle-network.local-save-coordination.v1.emergency-mirror.normal.payload"))).toBeNull();
  await page.reload();
  await expect(page.locator(".start-menu")).toBeVisible();
  await page.locator(".start-menu-primary").click();
  await expect(page.locator(".factory-canvas")).toBeVisible();
  await expect(page.locator(".game-shell")).toHaveAttribute("data-runtime-recovery", "active", { timeout: 15_000 });
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("dsp-idle-network.local-save-coordination.v1.emergency-mirror.normal.payload"))).toBeNull();
});

test("prominent home language controls fit desktop and 200 percent mobile text", async ({ page }) => {
  await page.addInitScript((releaseNoteId) => {
    window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", releaseNoteId);
    window.localStorage.setItem("dsp-idle-network.menu-settings.v1", JSON.stringify({ fontScale: 2, theme: "light" }));
  }, RELEASE_NOTE_ID);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?menu=1");
  const controls = page.locator(".start-menu-language-prominent");
  await expect(controls).toBeVisible();
  await expect(controls.getByRole("button", { name: "中文" })).toBeVisible();
  await expect(controls.getByRole("button", { name: "English" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/v109-language-menu-desktop-200.png", fullPage: true });

  await page.setViewportSize({ width: 320, height: 568 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  const buttonSizes = await controls.getByRole("button").evaluateAll((buttons) => buttons.map((button) => {
    const bounds = button.getBoundingClientRect();
    return { width: bounds.width, height: bounds.height };
  }));
  expect(buttonSizes.every(({ width, height }) => width >= 44 && height >= 44)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/v109-language-menu-mobile-320x568-font200.png", fullPage: true });
});

