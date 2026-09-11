import { expect, test, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

interface NewDeviceOptions {
  fontScale?: number;
  includeNormalCloud?: boolean;
  includeSpeedrunCloud?: boolean;
  includeSpeedrunManual?: boolean;
  serveNormalPayloadForSpeedrun?: boolean;
}

async function prepareNewDevice(page: Page, options: NewDeviceOptions = {}): Promise<void> {
  await page.addInitScript(({ fontScale, includeNormalCloud, includeSpeedrunCloud, includeSpeedrunManual, serveNormalPayloadForSpeedrun }) => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-17-v1.0.46");
    window.localStorage.setItem("dsp-idle-network.onboarding.v1", "dismissed");
    window.localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, completedEvents: [], skipped: true }));
    window.localStorage.setItem("dsp-idle-network.menu-settings.v1", JSON.stringify({ fontScale }));
    const now = Date.now();
    const summary = { mode: "speedrun", stateVersion: 46, savedAt: now, elapsedSeconds: 9_876, activePlanetId: "home", entityCount: 1, completedTechCount: 3, structurePoints: 0, uploadedWhiteMatrix: 0, stateChecksum: "synthetic", integrity: "valid" };
    const metadata = { mode: "speedrun", slot: "main", revision: 2, updatedAt: now, size: 1_024, checksum: "synthetic-cloud", summary };
    const manualMetadata = { ...metadata, slot: "1", revision: 3, checksum: "synthetic-manual" };
    const historyMetadata = { ...metadata, revision: 1, updatedAt: now - 60_000, checksum: "synthetic-history" };
    const normalSummary = { ...summary, mode: "normal", elapsedSeconds: 4_321, completedTechCount: 2, stateChecksum: "synthetic-normal" };
    const normalMetadata = { ...metadata, mode: "normal", revision: 7, checksum: "synthetic-normal-cloud", summary: normalSummary };
    const remoteState = { speedrunRevision: metadata.revision };
    const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const nativeFetch = window.fetch.bind(window);
    const requests: Array<{ method: string; path: string; mode: string | null; slot: string | null }> = [];
    Object.defineProperty(window, "__p108CloudRequests", { configurable: true, value: requests });
    Object.defineProperty(window, "__p108RemoteState", { configurable: true, value: remoteState });
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const parsed = new URL(url, window.location.origin);
      if (!parsed.pathname.startsWith("/api/")) return nativeFetch(input, init);
      requests.push({ method: init?.method ?? "GET", path: parsed.pathname, mode: parsed.searchParams.get("mode"), slot: parsed.searchParams.get("slot") });
      if (parsed.pathname === "/api/health") return response({ ok: true, mailProvider: "disabled" });
      if (parsed.pathname === "/api/account") return response({
        user: { id: "synthetic-user", username: "v140_speedrun_device", email: "", displayName: "速通新设备", createdAt: now, emailVerified: false, emailVerifiedAt: null, passwordChangedAt: now, leaderboardVisible: true },
        cloudSave: includeNormalCloud ? normalMetadata : null,
        cloudSaves: { main: includeNormalCloud ? normalMetadata : null, "1": null, "2": null, "3": null },
        cloudSavesByMode: {
          normal: { main: includeNormalCloud ? normalMetadata : null, "1": null, "2": null, "3": null },
          speedrun: { main: includeSpeedrunCloud ? { ...metadata, revision: remoteState.speedrunRevision } : null, "1": includeSpeedrunCloud && includeSpeedrunManual ? manualMetadata : null, "2": null, "3": null },
        },
      });
      if (parsed.pathname === "/api/cloud-save" && parsed.searchParams.get("mode") === "speedrun" && init?.method !== "DELETE") {
        const engine = await import("/src/game/engine.ts");
        const storage = await import("/src/game/storage.ts");
        const downloaded = serveNormalPayloadForSpeedrun
          ? engine.createInitialState("v140-wrong-mode-normal")
          : engine.createSpeedrunInitialState(1_777_777_777_000, "v140-new-device-speedrun");
        downloaded.paused = true;
        downloaded.elapsedSeconds = 9_876;
        return response({ cloudSave: { ...metadata, payload: storage.exportGame(downloaded) }, mode: "speedrun", slot: "main" });
      }
      if (parsed.pathname === "/api/cloud-save/history") return response({ history: [metadata, historyMetadata], mode: "speedrun", slot: parsed.searchParams.get("slot") ?? "main" });
      if (parsed.pathname === "/api/cloud-save/restore") return response({ cloudSave: { ...metadata, revision: 3, restoredFromRevision: historyMetadata.revision } });
      if (parsed.pathname === "/api/cloud-save" && init?.method === "DELETE") return response({ deleted: true, mode: "speedrun", slot: parsed.searchParams.get("slot") ?? "main" });
      return response({ error: `unexpected synthetic route ${parsed.pathname}${parsed.search}` }, 404);
    };
    window.localStorage.setItem("dsp-idle-network.cloud-token.v1", "synthetic-token");
  }, {
    fontScale: options.fontScale ?? 1,
    includeNormalCloud: options.includeNormalCloud ?? false,
    includeSpeedrunCloud: options.includeSpeedrunCloud ?? true,
    includeSpeedrunManual: options.includeSpeedrunManual ?? false,
    serveNormalPayloadForSpeedrun: options.serveNormalPayloadForSpeedrun ?? false,
  });
}

test("a new device discovers and explicitly restores speedrun/main without creating normal", async ({ page }) => {
  await prepareNewDevice(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?menu=1");
  await page.getByRole("button", { name: "登录与云存档" }).click();

  const panel = page.getByRole("region", { name: "按模式管理云存档" });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("radio", { name: /普通模式/ })).toHaveAttribute("aria-checked", "true");
  await panel.getByRole("radio", { name: /速通模式/ }).click();
  await expect(panel).toContainText("发现新设备可恢复的速通主档");
  await expect(panel).toContainText("速通模式 · 主存档");

  await panel.getByRole("button", { name: "恢复速通主档" }).click();
  const confirmation = page.getByRole("alertdialog", { name: "确认速通模式 · 主存档恢复" });
  await expect(confirmation).toContainText("不会创建普通存档");
  await confirmation.getByRole("button", { name: "确认恢复" }).click();
  await expect(panel.getByRole("status")).toContainText("未创建或改写普通模式存档");

  const persisted = await page.evaluate(async () => {
    const storage = await import("/src/game/storage.ts");
    const preview = await import("/src/game/savePreview.ts");
    return {
      normal: preview.getMenuContinueSave("normal"),
      speedrunMode: preview.getMenuContinueSave("speedrun")?.summary.mode,
      speedrunFactoryId: storage.loadGame("speedrun").state.speedrun?.factoryId,
    };
  });
  expect(persisted.normal).toBeNull();
  expect(persisted.speedrunMode).toBe("speedrun");
  expect(persisted.speedrunFactoryId).toBe("v140-new-device-speedrun");
});

test("mode selection stays readable and clickable at 390x844 from 80 to 200 percent font", async ({ page }) => {
  await prepareNewDevice(page, { fontScale: 2 });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?menu=1");
  await page.getByRole("button", { name: "登录与云存档" }).click();

  const panel = page.getByRole("region", { name: "按模式管理云存档" });
  await panel.getByRole("radio", { name: /速通模式/ }).click();
  const restore = panel.getByRole("button", { name: "恢复速通主档" });
  await expect(restore).toBeVisible();
  for (const percentage of [80, 100, 125, 150, 200]) {
    await page.getByRole("button", { name: "游戏设置" }).click();
    await page.getByRole("button", { name: `${percentage}%`, exact: true }).click();
    await page.getByRole("button", { name: "登录与云存档" }).click();
    await expect(panel).toBeVisible();
    const layout = await panel.evaluate((element) => ({
      panelLeft: element.getBoundingClientRect().left,
      panelRight: element.getBoundingClientRect().right,
      restoreWidth: (element.querySelector(".cloud-save-primary-recovery button.primary") as HTMLElement | null)?.getBoundingClientRect().width ?? 0,
      viewport: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    const scale = percentage / 100;
    expect(layout.panelLeft, `${scale * 100}% panel left`).toBeGreaterThanOrEqual(-1);
    expect(layout.panelRight, `${scale * 100}% panel right`).toBeLessThanOrEqual(layout.viewport + 1);
    expect(layout.scrollWidth, `${scale * 100}% horizontal overflow`).toBeLessThanOrEqual(layout.viewport + 1);
    expect(layout.restoreWidth, `${scale * 100}% restore touch target`).toBeGreaterThanOrEqual(40);
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  for (const percentage of [80, 100, 125, 150, 200]) {
    await page.getByRole("button", { name: "游戏设置" }).click();
    await page.getByRole("button", { name: `${percentage}%`, exact: true }).click();
    await page.getByRole("button", { name: "登录与云存档" }).click();
    await expect(panel).toBeVisible();
    const layout = await panel.evaluate((element) => ({
      panelLeft: element.getBoundingClientRect().left,
      panelRight: element.getBoundingClientRect().right,
      modeButtons: Array.from(element.querySelectorAll<HTMLElement>(".cloud-save-mode-selector button")).map((button) => button.getBoundingClientRect().height),
      restoreHeight: (element.querySelector(".cloud-save-primary-recovery button.primary") as HTMLElement | null)?.getBoundingClientRect().height ?? 0,
      viewport: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(layout.panelLeft, `${percentage}% desktop panel left`).toBeGreaterThanOrEqual(-1);
    expect(layout.panelRight, `${percentage}% desktop panel right`).toBeLessThanOrEqual(layout.viewport + 1);
    expect(layout.scrollWidth, `${percentage}% desktop horizontal overflow`).toBeLessThanOrEqual(layout.viewport + 1);
    expect(layout.modeButtons.every((height) => height >= 40), `${percentage}% desktop mode targets`).toBe(true);
    expect(layout.restoreHeight, `${percentage}% desktop restore target`).toBeGreaterThanOrEqual(34);
  }
});

test("normal and speedrun cloud saves coexist while mode selection remains read-only", async ({ page }) => {
  await prepareNewDevice(page, { includeNormalCloud: true, includeSpeedrunManual: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?menu=1");
  await page.getByRole("button", { name: "登录与云存档" }).click();

  const panel = page.getByRole("region", { name: "按模式管理云存档" });
  await expect(panel.locator('[data-cloud-slot="main"]')).toContainText("修订 7");
  await panel.getByRole("radio", { name: /速通模式/ }).click();
  await expect(panel.locator('[data-cloud-slot="main"]')).toContainText("修订 2");
  await expect(panel.locator('[data-cloud-slot="1"]').getByRole("button", { name: "上传" })).toBeDisabled();
  await page.evaluate(() => {
    (window as typeof window & { __p108RemoteState: { speedrunRevision: number } }).__p108RemoteState.speedrunRevision = 9;
  });
  await panel.getByRole("radio", { name: /普通模式/ }).click();
  await expect(panel.locator('[data-cloud-slot="main"]')).toContainText("修订 7");
  await panel.getByRole("radio", { name: /速通模式/ }).click();
  await expect(panel.locator('[data-cloud-slot="main"]')).toContainText("修订 9");

  const mutationRequests = await page.evaluate(() => {
    const requests = (window as typeof window & { __p108CloudRequests: Array<{ method: string; path: string }> }).__p108CloudRequests;
    return requests.filter((request) => request.method !== "GET" && request.path.startsWith("/api/cloud-save"));
  });
  expect(mutationRequests).toEqual([]);
});

test("a normal-only account stays normal and does not invent a speedrun save", async ({ page }) => {
  await prepareNewDevice(page, { includeNormalCloud: true, includeSpeedrunCloud: false });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/?menu=1");
  await page.getByRole("button", { name: "登录与云存档" }).click();
  const panel = page.getByRole("region", { name: "按模式管理云存档" });
  await expect(panel.locator('[data-cloud-slot="main"]')).toContainText("普通模式 · 主存档");
  await expect(panel.locator('[data-cloud-slot="main"]')).toContainText("修订 7");
  await panel.getByRole("radio", { name: /速通模式/ }).click();
  await expect(panel.locator('[data-cloud-slot="main"]')).toContainText("速通模式 · 主存档");
  await expect(panel.locator('[data-cloud-slot="main"]')).toContainText("云端为空");
  await expect(panel.getByRole("button", { name: "恢复速通主档" })).toBeDisabled();
});

test("a normal payload cannot be restored through the speedrun cloud namespace", async ({ page }) => {
  await prepareNewDevice(page, { serveNormalPayloadForSpeedrun: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/?menu=1");
  await page.getByRole("button", { name: "登录与云存档" }).click();
  const panel = page.getByRole("region", { name: "按模式管理云存档" });
  await panel.getByRole("radio", { name: /速通模式/ }).click();
  await panel.getByRole("button", { name: "恢复速通主档" }).click();
  await page.getByRole("alertdialog", { name: "确认速通模式 · 主存档恢复" }).getByRole("button", { name: "确认恢复" }).click();
  await expect(panel.getByRole("status")).toContainText("云存档模式与当前工厂不匹配");

  const persisted = await page.evaluate(async () => {
    const preview = await import("/src/game/savePreview.ts");
    return {
      normal: preview.getMenuContinueSave("normal"),
      speedrun: preview.getMenuContinueSave("speedrun"),
    };
  });
  expect(persisted.normal).toBeNull();
  expect(persisted.speedrun).toBeNull();
});

test("an existing local speedrun save gets an explicit same-mode overwrite warning and remains isolated", async ({ page }) => {
  await prepareNewDevice(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/?menu=1");
  await page.evaluate(async () => {
    const engine = await import("/src/game/engine.ts");
    const storage = await import("/src/game/storage.ts");
    const existing = engine.createSpeedrunInitialState(1_700_000_000_000, "v140-existing-speedrun");
    existing.paused = true;
    existing.elapsedSeconds = 123;
    const result = await storage.saveGameVerified(existing);
    if (!result.success) throw new Error(result.message);
  });
  await page.getByRole("button", { name: "登录与云存档" }).click();
  const panel = page.getByRole("region", { name: "按模式管理云存档" });
  await panel.getByRole("radio", { name: /速通模式/ }).click();
  await panel.getByRole("button", { name: "恢复到本机" }).click();

  const confirmation = page.getByRole("alertdialog", { name: "确认速通模式 · 主存档覆盖" });
  await expect(confirmation).toContainText("先创建同模式恢复快照");
  await expect(confirmation).toContainText("普通存档不会受到影响");
  await expect(confirmation.getByRole("button", { name: "取消", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", { name: "确认覆盖" }).click();
  await expect(panel.getByRole("status")).toContainText("已恢复到本机");

  const state = await page.evaluate(async () => {
    const localSaveStore = await import("/src/game/localSaveStore.ts");
    const storage = await import("/src/game/storage.ts");
    const preview = await import("/src/game/savePreview.ts");
    const primaryRaw = await localSaveStore.readPersistedLocalSaveValue("dsp-idle-network.save.v1.speedrun");
    const emergencyRaw = await localSaveStore.readPersistedLocalSaveValue("dsp-idle-network.save.v1.speedrun.emergency");
    return {
      normal: preview.getMenuContinueSave("normal"),
      primaryFactoryId: primaryRaw ? storage.inspectSave(primaryRaw).state?.speedrun?.factoryId : null,
      emergencyFactoryId: emergencyRaw ? storage.inspectSave(emergencyRaw).state?.speedrun?.factoryId : null,
      speedrunFactoryId: storage.loadGame("speedrun").state.speedrun?.factoryId,
      speedrunSnapshots: storage.getSaveSnapshotSummaries("speedrun").map((snapshot) => snapshot.reason),
    };
  });
  expect(state.normal).toBeNull();
  expect(state.primaryFactoryId).toBe("v140-new-device-speedrun");
  expect(state.emergencyFactoryId).toBeNull();
  expect(state.speedrunFactoryId).toBe("v140-new-device-speedrun");
  expect(state.speedrunSnapshots).toContain("恢复速通模式 · 主存档前");
});

test("speedrun history and delete confirmations name their exact mode and slot", async ({ page }) => {
  await prepareNewDevice(page, { includeSpeedrunManual: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/?menu=1");
  await page.getByRole("button", { name: "登录与云存档" }).click();
  const panel = page.getByRole("region", { name: "按模式管理云存档" });
  await panel.getByRole("radio", { name: /速通模式/ }).click();

  const primary = panel.locator('[data-cloud-slot="main"]');
  await primary.getByRole("button", { name: "历史" }).click();
  const history = panel.getByRole("region", { name: "速通模式 · 主存档历史修订" });
  await expect(history).toContainText("速通模式 · 主存档 · 修订 1");
  await history.locator("article").filter({ hasText: "修订 1" }).getByRole("button", { name: "恢复云端" }).click();
  const restore = page.getByRole("alertdialog", { name: "确认速通模式 · 主存档恢复" });
  await expect(restore).toContainText("只在上方模式与槽位创建一个新的云端修订");
  await restore.getByRole("button", { name: "确认恢复" }).click();
  await expect(panel.getByRole("status")).toContainText("修订 1 已恢复为新修订 3");

  const manual = panel.locator('[data-cloud-slot="1"]');
  await manual.getByRole("button", { name: "下载" }).click();
  const manualDownload = page.getByRole("alertdialog", { name: "确认速通模式 · 槽位 1恢复" });
  await expect(manualDownload).toContainText("本次唯一目标");
  await expect(manualDownload).toContainText("速通模式 · 槽位 1");
  await manualDownload.getByRole("button", { name: "取消", exact: true }).click();
  await manual.getByRole("button", { name: "删除" }).click();
  const deletion = page.getByRole("alertdialog", { name: "确认速通模式 · 槽位 1删除" });
  await expect(deletion).toContainText("另一模式、本机存档及其他槽位不会受到影响");
  await deletion.getByRole("button", { name: "确认删除" }).click();
  await expect(panel.getByRole("status")).toContainText("速通模式 · 槽位 1已删除");

  const mutations = await page.evaluate(() => {
    const requests = (window as typeof window & { __p108CloudRequests: Array<{ method: string; path: string; mode: string | null; slot: string | null }> }).__p108CloudRequests;
    return requests.filter((request) => request.method !== "GET" && request.path.startsWith("/api/cloud-save"));
  });
  expect(mutations).toEqual([
    { method: "POST", path: "/api/cloud-save/restore", mode: "speedrun", slot: null },
    { method: "DELETE", path: "/api/cloud-save", mode: "speedrun", slot: "1" },
  ]);
});

