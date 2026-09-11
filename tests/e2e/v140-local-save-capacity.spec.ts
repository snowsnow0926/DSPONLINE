import { expect, test, type Page } from "@playwright/test";

const RELEASE_NOTE_ID = "2026-08-17-v1.0.46";

async function prepareFactory(page: Page, persistence: "granted" | "denied" | "unsupported", usage = 24, quota = 100, mobile = false) {
  await page.addInitScript(({ releaseNoteId, persistenceState, storageUsage, storageQuota }) => {
    localStorage.setItem("dsp-idle-network.release-notes.seen.v1", releaseNoteId);
    localStorage.setItem("dsp-idle-network.onboarding.v1", "dismissed");
    localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, completedEvents: [], skipped: true }));
    const storage = persistenceState === "unsupported" ? { estimate: async () => ({ usage: storageUsage, quota: storageQuota }) } : {
      estimate: async () => ({ usage: storageUsage, quota: storageQuota }),
      persisted: async () => persistenceState === "granted",
      persist: async () => persistenceState === "granted",
    };
    try { Object.defineProperty(navigator, "storage", { configurable: true, value: storage }); } catch { /* embedded fallback */ }
  }, { releaseNoteId: RELEASE_NOTE_ID, persistenceState: persistence, storageUsage: usage, storageQuota: quota });
  await page.goto(`/?menu=1&storageMigration=production${mobile ? "&mobileUi=next" : ""}`);
  await page.getByRole("button", { name: /开始游戏/ }).click();
  await expect(page.locator(".factory-canvas")).toBeVisible();
  if (mobile) {
    await page.getByRole("button", { name: "更多", exact: true }).click();
    await page.getByRole("button", { name: /存档管理/ }).click();
  } else {
    await page.getByLabel("打开设置").click();
  }
  const operations = page.getByRole("dialog", { name: "运营中心" });
  if (!mobile) await operations.locator(".operations-tabs").getByRole("tab", { name: "存档" }).click();
  return operations;
}

test("capacity panel separates modes and requests persistent storage without blocking saves", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const operations = await prepareFactory(page, "denied");
  const usage = operations.getByLabel("本地存储占用");
  await expect(usage).toContainText("浏览器持久存储：尚未请求");
  await expect(usage.getByLabel("按模式存储占用")).toContainText("普通模式");
  await expect(usage.getByLabel("按模式存储占用")).toContainText("速通模式");
  await expect(usage).toContainText("自动快照");
  await expect(usage).toContainText("手动快照");
  await expect(usage).toContainText("保护快照");
  await expect(usage).toContainText("导入缓存");
  await expect(usage.locator('.save-storage-entries input[type="checkbox"]:checked')).toHaveCount(0);

  await usage.getByRole("button", { name: "请求保护" }).click();
  await expect(usage).toContainText("浏览器持久存储：浏览器未授予");
  await operations.getByRole("button", { name: "立即保存" }).click();
  const shell = page.locator(".game-shell");
  await expect(shell).toHaveAttribute("data-persistence-kind", "manual");
  await expect(shell).toHaveAttribute("data-persistence-phase", "complete", { timeout: 30_000 });
  await expect(shell).toHaveAttribute("data-primary-save-edit-lock", "false", { timeout: 15_000 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("managed cleanup starts unselected and deletes only the confirmed recovery item", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const operations = await prepareFactory(page, "granted", 1, 1_000_000_000);
  await operations.getByRole("button", { name: "创建快照" }).click();
  const usage = operations.getByLabel("本地存储占用");
  const manualEntry = usage.locator(".save-storage-entries > div").filter({ hasText: "手动快照" }).first();
  await expect(manualEntry).toBeVisible();
  const checkbox = manualEntry.getByRole("checkbox");
  await expect(checkbox).not.toBeChecked();
  await checkbox.check();
  await usage.getByRole("button", { name: "删除所选" }).click();
  const confirmation = page.getByRole("dialog", { name: "删除1 份本地恢复数据" });
  await confirmation.getByRole("button", { name: /继续确认/ }).click();
  const finalConfirmation = page.getByRole("alertdialog", { name: "删除1 份本地恢复数据" });
  await finalConfirmation.getByRole("button", { name: /确认永久删除/ }).click();
  await expect(manualEntry).toHaveCount(0);
  expect(await page.evaluate(async () => {
    const store = await import("/src/game/localSaveStore.ts");
    return store.readPersistedLocalSaveValue("dsp-idle-network.save.v1");
  })).not.toBeNull();
});

test("unsupported storage API remains explicit and usable at 200 percent mobile text", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("dsp-idle-network.menu-settings.v1", JSON.stringify({ fontScale: 2, theme: "dark" }));
  });
  await page.setViewportSize({ width: 390, height: 844 });
  const operations = await prepareFactory(page, "unsupported", 24, 100, true);
  const usage = operations.getByLabel("本地存储占用");
  await expect(usage).toContainText("浏览器持久存储：当前环境不支持");
  await expect(usage.getByRole("button", { name: /请求保护|重新请求/ })).toHaveCount(0);
  await expect(operations.getByRole("button", { name: "立即保存" })).toBeVisible();
  await expect.poll(() => operations.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/v140-local-capacity-mobile-390-font200.png", fullPage: true });
  await page.setViewportSize({ width: 844, height: 390 });
  await expect.poll(() => operations.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(usage).toBeVisible();
  await page.screenshot({ path: "artifacts/qa/v140-local-capacity-mobile-844x390-font200.png", fullPage: true });
});

test("quota failure keeps the verified main save and exposes an export recovery action", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const operations = await prepareFactory(page, "granted", 1, 1_000_000_000);
  const before = await page.evaluate(async () => {
    const store = await import("/src/game/localSaveStore.ts");
    return store.readPersistedLocalSaveValue("dsp-idle-network.save.v1");
  });
  expect(before).not.toBeNull();
  await page.evaluate(() => {
    const runtime = window as typeof window & { __capacityNativePut?: IDBObjectStore["put"] };
    runtime.__capacityNativePut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      if (value && typeof value === "object" && (value as { key?: unknown }).key === "dsp-idle-network.save.v1") {
        throw new DOMException("synthetic quota", "QuotaExceededError");
      }
      return key === undefined ? runtime.__capacityNativePut!.call(this, value) : runtime.__capacityNativePut!.call(this, value, key);
    } as IDBObjectStore["put"];
  });

  const failure = await page.evaluate(async (raw) => {
    const store = await import("/src/game/localSaveStore.ts");
    store.setLocalSaveValue("dsp-idle-network.save.v1", raw);
    try {
      await store.flushLocalSaveWrites();
      return null;
    } catch (error) {
      return error instanceof DOMException ? error.name : error instanceof Error ? error.message : "unknown";
    }
  }, before!);
  expect(failure).toBe("QuotaExceededError");
  const recovery = operations.getByLabel("本地存储占用").getByRole("alert").filter({ hasText: "旧主档已保留" });
  await expect(recovery).toBeVisible();
  await expect(recovery).toContainText("上一次带校验值的普通主存档仍原样保留");
  const after = await page.evaluate(async () => {
    const store = await import("/src/game/localSaveStore.ts");
    return store.readPersistedLocalSaveValue("dsp-idle-network.save.v1");
  });
  expect(after).toBe(before);

  const downloadPromise = page.waitForEvent("download");
  await operations.getByLabel("本地存储占用").getByRole("button", { name: "立即导出" }).click();
  expect((await downloadPromise).suggestedFilename()).toMatch(/^dsp-idle-save-.*\.json$/);
});

test("normal and speedrun snapshots restore the same checksum, mode, slot, and state", async ({ page }) => {
  await page.addInitScript((releaseNoteId) => localStorage.setItem("dsp-idle-network.release-notes.seen.v1", releaseNoteId), RELEASE_NOTE_ID);
  await page.goto("/?menu=1&storageMigration=production");
  const result = await page.evaluate(async () => {
    const [storage, engine, store] = await Promise.all([
      import("/src/game/storage.ts"),
      import("/src/game/engine.ts"),
      import("/src/game/localSaveStore.ts"),
    ]);
    const normal = engine.createInitialState();
    normal.elapsedSeconds = 1_234;
    const speedrun = engine.createSpeedrunInitialState(1_700_000_000_000, "v140-capacity-snapshot");
    speedrun.elapsedSeconds = 5_678;
    const normalSummary = await storage.saveGameSnapshotVerified(normal, "手动快照");
    const speedrunSummary = await storage.saveGameSnapshotVerified(speedrun, "恢复云存档前");
    if (!normalSummary || !speedrunSummary) return null;
    const normalRaw = await store.readPersistedLocalSaveValue(`dsp-idle-network.save.v1.snapshot.${normalSummary.id}`);
    const speedrunRaw = await store.readPersistedLocalSaveValue(`dsp-idle-network.save.v1.snapshot.speedrun.${speedrunSummary.id}`);
    const normalEnvelope = JSON.parse(normalRaw ?? "null");
    const speedrunEnvelope = JSON.parse(speedrunRaw ?? "null");
    const normalInspection = normalRaw ? storage.inspectSave(normalRaw) : null;
    const speedrunInspection = speedrunRaw ? storage.inspectSave(speedrunRaw) : null;
    return {
      normal: {
        envelopeChecksum: normalEnvelope?.checksum,
        inspectedChecksum: normalInspection?.computedChecksum,
        mode: normalInspection?.mode,
        slot: normalInspection?.slot,
        elapsed: storage.loadSaveSnapshot(normalSummary.id, "normal")?.elapsedSeconds,
      },
      speedrun: {
        envelopeChecksum: speedrunEnvelope?.checksum,
        inspectedChecksum: speedrunInspection?.computedChecksum,
        mode: speedrunInspection?.mode,
        slot: speedrunInspection?.slot,
        elapsed: storage.loadSaveSnapshot(speedrunSummary.id, "speedrun")?.elapsedSeconds,
      },
      crossModeNormal: storage.loadSaveSnapshot(normalSummary.id, "speedrun"),
      crossModeSpeedrun: storage.loadSaveSnapshot(speedrunSummary.id, "normal"),
    };
  });
  expect(result).toMatchObject({
    normal: { mode: "normal", slot: "main", elapsed: 1_234 },
    speedrun: { mode: "speedrun", slot: "main", elapsed: 5_678 },
    crossModeNormal: null,
    crossModeSpeedrun: null,
  });
  expect(result?.normal.envelopeChecksum).toBe(result?.normal.inspectedChecksum);
  expect(result?.speedrun.envelopeChecksum).toBe(result?.speedrun.inspectedChecksum);
});

