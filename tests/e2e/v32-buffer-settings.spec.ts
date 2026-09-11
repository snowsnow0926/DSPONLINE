import { expect, test, type Page } from "@playwright/test";
import { selectSettingsCategory } from "./settings-helpers";

const SAVE_KEY = "dsp-idle-network.save.v1";
const BACKUP_KEY = `${SAVE_KEY}.backup`;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-17-v1.0.46");
  });
  const offlineReport = page.getByRole("dialog", { name: "离线结算报告" });
  await page.addLocatorHandler(offlineReport, async () => {
    await offlineReport.getByRole("button", { name: "确认结算" }).click();
  });
});

async function openSettings(page: Page, mode: "desktop" | "legacy" | "next", route?: string) {
  const viewport = mode === "desktop" ? { width: 1440, height: 900 } : { width: 390, height: 844 };
  await page.setViewportSize(viewport);
  await page.goto(route ?? (mode === "next" ? "/?mobileUi=next" : "/"));
  await expect(page.locator(".game-shell")).toBeVisible();
  if (mode === "next") {
    await page.getByRole("button", { name: "更多", exact: true }).click();
    await page.getByRole("button", { name: /游戏设置/ }).click();
  } else if (mode === "legacy") {
    await page.getByRole("button", { name: "更多工作区" }).click();
    await page.getByRole("menuitem", { name: "设置" }).click();
  } else {
    await page.getByLabel("打开设置").click();
  }
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await expect(operations).toBeVisible();
  return operations;
}

test("building buffer presets and custom validation persist independently", async ({ page }) => {
  let operations = await openSettings(page, "desktop", "/?storageMigration=production");

  // Establish a durable primary before changing settings. The production
  // contract is coordinated IndexedDB; the same-name localStorage value on a
  // localhost DEV server is only a compatibility mirror and may lag the
  // asynchronous Worker serialization used by verified manual saves.
  await operations.getByRole("tab", { name: "存档" }).click();
  const initialRevision = await page.evaluate(async () => {
    const store = await import("/src/game/localSaveStore.ts");
    await store.flushLocalSaveWrites();
    return store.getPrimaryLocalSaveRevision();
  });
  await operations.getByRole("button", { name: "立即保存" }).click();
  await expect.poll(() => page.evaluate(async () => {
    const store = await import("/src/game/localSaveStore.ts");
    await store.flushLocalSaveWrites();
    return store.getPrimaryLocalSaveRevision();
  })).toBe(initialRevision + 1);
  await expect(page.locator(".game-shell")).toHaveAttribute("data-persistence-phase", "complete");
  await expect(page.locator("[data-persistence-progress]")).toContainText("存档已验证完成");

  await operations.getByRole("tab", { name: "设置" }).click();
  await selectSettingsCategory(operations, "终局性能", "performance");
  const production = operations.locator(".settings-buffer-limit").filter({ hasText: "生产建筑缓存上限" });
  const logistics = operations.locator(".settings-buffer-limit").filter({ hasText: "仓储与物流建筑缓存上限" });
  const belts = operations.locator(".settings-buffer-limit").filter({ hasText: "传送带转运额度上限" });
  const proliferator = operations.locator(".settings-buffer-limit").filter({ hasText: "增产剂缓存上限" });

  await expect(production.getByRole("button", { name: "100万" })).toHaveAttribute("aria-pressed", "true");
  await expect(logistics.getByRole("button", { name: "100万" })).toHaveAttribute("aria-pressed", "true");
  await expect(belts.getByRole("button", { name: "自定义" })).toHaveAttribute("aria-pressed", "true");
  await expect(belts.getByLabel("传送带转运额度上限自定义值")).toHaveValue("100000000");
  await expect(proliferator.getByRole("button", { name: "100万" })).toBeVisible();
  await proliferator.getByRole("button", { name: "100万" }).click();
  await expect(proliferator).toContainText("1,000,000/种");
  await proliferator.getByRole("button", { name: "自定义" }).click();
  const proliferatorInput = proliferator.getByLabel("增产剂缓存上限自定义值");
  await proliferatorInput.fill("100000001");
  await proliferator.getByRole("button", { name: "应用" }).click();
  await expect(proliferator.getByRole("alert")).toContainText("不能高于 100,000,000");
  await proliferatorInput.fill("100000000");
  await proliferator.getByRole("button", { name: "应用" }).click();
  await expect(proliferator).toContainText("100,000,000/种");
  await production.getByRole("button", { name: "1万", exact: true }).click();
  await logistics.getByRole("button", { name: "10万", exact: true }).click();
  await expect(production).toContainText("10,000/种");
  await expect(logistics).toContainText("100,000/种");

  await production.getByRole("button", { name: "自定义" }).click();
  const input = production.getByLabel("生产建筑缓存上限自定义值");
  for (const [raw, message] of [
    ["", "请输入缓存上限"],
    ["1000.5", "只接受整数"],
    ["-1000", "不能为负数"],
    ["1e6", "不接受指数格式"],
    ["999", "不能低于"],
    ["100000001", "不能高于"],
  ] as const) {
    await input.fill(raw);
    await production.getByRole("button", { name: "应用" }).click();
    await expect(production.getByRole("alert")).toContainText(message);
  }
  await input.fill("100000000");
  await production.getByRole("button", { name: "应用" }).click();
  await expect(production).toContainText("100,000,000/种");
  await expect(logistics).toContainText("100,000/种");

  await operations.getByRole("tab", { name: "存档" }).click();
  const beforeManualSave = await page.evaluate(async ({ saveKey }) => {
    const store = await import("/src/game/localSaveStore.ts");
    await store.flushLocalSaveWrites();
    const raw = await store.readPersistedLocalSaveValue(saveKey);
    if (!raw) throw new Error("authoritative primary save is missing before manual save");
    return { raw, revision: store.getPrimaryLocalSaveRevision() };
  }, { saveKey: SAVE_KEY });
  await operations.getByRole("button", { name: "立即保存" }).click();
  await expect.poll(() => page.evaluate(async () => {
    const store = await import("/src/game/localSaveStore.ts");
    await store.flushLocalSaveWrites();
    return store.getPrimaryLocalSaveRevision();
  })).toBe(beforeManualSave.revision + 1);
  await expect(page.locator(".game-shell")).toHaveAttribute("data-persistence-phase", "complete");
  await expect(page.locator("[data-persistence-progress]")).toContainText("存档已验证完成");

  const afterManualSave = await page.evaluate(async ({ saveKey, backupKey }) => {
    const store = await import("/src/game/localSaveStore.ts");
    const coordination = await import("/src/game/localSaveCoordination.ts");
    await store.flushLocalSaveWrites();
    const raw = await store.readPersistedLocalSaveValue(saveKey);
    if (!raw) throw new Error("authoritative primary save is missing after manual save");
    const mirrorKeys = coordination.localSaveEmergencyMirrorKeys("normal");
    return {
      backend: store.getLocalSaveBackend(),
      raw,
      rawCacheEntries: store.getLocalSaveRawCacheSize(),
      backup: await store.readPersistedLocalSaveValue(backupKey),
      revision: store.getPrimaryLocalSaveRevision(),
      legacyMain: window.localStorage.getItem(saveKey),
      emergencyPayload: window.localStorage.getItem(mirrorKeys.payload),
      emergencyMetadata: window.localStorage.getItem(mirrorKeys.metadata),
    };
  }, { saveKey: SAVE_KEY, backupKey: BACKUP_KEY });
  expect(afterManualSave.backend).toBe("indexeddb");
  expect(afterManualSave.rawCacheEntries).toBe(0);
  expect(afterManualSave.backup).toBe(beforeManualSave.raw);
  expect(afterManualSave.revision).toBe(beforeManualSave.revision + 1);
  expect(afterManualSave.legacyMain).toBeNull();
  expect(afterManualSave.emergencyPayload).toBeNull();
  expect(afterManualSave.emergencyMetadata).toBeNull();
  expect(JSON.parse(afterManualSave.raw).state.settings).toMatchObject({
    productionBufferLimit: 100_000_000,
    logisticsBufferLimit: 100_000,
    beltBufferLimit: 100_000_000,
    proliferatorBufferLimit: 100_000_000,
  });

  // The direct-bypass fixture uses the normal verified-save flow rather than
  // StartMenu's durable recovery checkpoint, so pagehide retains its
  // emergency-mirror coverage.
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false })));
  await expect.poll(() => page.evaluate(async () => {
    const coordination = await import("/src/game/localSaveCoordination.ts");
    const mirrorKeys = coordination.localSaveEmergencyMirrorKeys("normal");
    return {
      payload: window.localStorage.getItem(mirrorKeys.payload) !== null,
      metadata: window.localStorage.getItem(mirrorKeys.metadata) !== null,
    };
  })).toEqual({ payload: true, metadata: true });
  await page.reload();
  await expect(page.locator(".game-shell")).toBeVisible();
  await expect(page.locator(".local-save-writer-banner--conflict")).toHaveCount(0);
  await expect.poll(() => page.evaluate(async ({ saveKey }) => {
    const store = await import("/src/game/localSaveStore.ts");
    const coordination = await import("/src/game/localSaveCoordination.ts");
    const mirrorKeys = coordination.localSaveEmergencyMirrorKeys("normal");
    await store.flushLocalSaveWrites();
    const raw = await store.readPersistedLocalSaveValue(saveKey);
    if (!raw) return null;
    return {
      backend: store.getLocalSaveBackend(),
      rawCacheEntries: store.getLocalSaveRawCacheSize(),
      settings: JSON.parse(raw).state.settings,
      emergencyPayload: window.localStorage.getItem(mirrorKeys.payload),
      emergencyMetadata: window.localStorage.getItem(mirrorKeys.metadata),
    };
  }, { saveKey: SAVE_KEY })).toMatchObject({
    backend: "indexeddb",
    rawCacheEntries: expect.any(Number),
    settings: {
      productionBufferLimit: 100_000_000,
      logisticsBufferLimit: 100_000,
      beltBufferLimit: 100_000_000,
      proliferatorBufferLimit: 100_000_000,
    },
    emergencyPayload: null,
    emergencyMetadata: null,
  });
  expect(await page.evaluate(async () => (await import("/src/game/localSaveStore.ts")).getLocalSaveRawCacheSize())).toBeLessThanOrEqual(2);

  await page.getByLabel("打开设置").click();
  operations = page.getByRole("dialog", { name: "运营中心" });
  await expect(operations).toBeVisible();
  await selectSettingsCategory(operations, "终局性能", "performance");
  const reloadedProduction = operations.locator(".settings-buffer-limit").filter({ hasText: "生产建筑缓存上限" });
  const reloadedLogistics = operations.locator(".settings-buffer-limit").filter({ hasText: "仓储与物流建筑缓存上限" });
  const reloadedBelts = operations.locator(".settings-buffer-limit").filter({ hasText: "传送带转运额度上限" });
  const reloadedProliferator = operations.locator(".settings-buffer-limit").filter({ hasText: "增产剂缓存上限" });
  await expect(reloadedProduction.getByRole("button", { name: "自定义" })).toHaveAttribute("aria-pressed", "true");
  await expect(reloadedProduction.getByLabel("生产建筑缓存上限自定义值")).toHaveValue("100000000");
  await expect(reloadedLogistics.getByRole("button", { name: "10万", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(reloadedBelts.getByRole("button", { name: "自定义" })).toHaveAttribute("aria-pressed", "true");
  await expect(reloadedBelts.getByLabel("传送带转运额度上限自定义值")).toHaveValue("100000000");
  await expect(reloadedProliferator.getByRole("button", { name: "自定义" })).toHaveAttribute("aria-pressed", "true");
  await expect(reloadedProliferator.getByLabel("增产剂缓存上限自定义值")).toHaveValue("100000000");
});

test("buffer controls fit desktop and both mobile settings from 80 to 200 percent font", async ({ page }) => {
  for (const mode of ["desktop", "legacy", "next"] as const) {
    const operations = await openSettings(page, mode);
    const fontScale = operations.getByLabel("字体大小");
    const sections = operations.locator(".settings-buffer-limit");
    for (const scale of [80, 100, 125, 150, 200] as const) {
      await selectSettingsCategory(operations, "画面与主题", "visual");
      await fontScale.getByRole("button", { name: `${scale}%` }).click();
      await selectSettingsCategory(operations, "终局性能", "performance");
      await expect(sections).toHaveCount(4);
      await expect(sections.first().getByRole("button", { name: "1万", exact: true })).toBeVisible();
      await expect(sections.first().getByRole("button", { name: "自定义" })).toBeVisible();
      await expect.poll(async () => operations.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      if (mode !== "desktop") {
        const sizes = await sections.first().getByRole("button").evaluateAll((buttons) => buttons.map((button) => {
          const bounds = button.getBoundingClientRect();
          return { width: bounds.width, height: bounds.height };
        }));
        expect(sizes.every(({ height }) => height >= 44)).toBe(true);
      }
      if (scale === 80 || scale === 200) {
        await sections.first().scrollIntoViewIfNeeded();
        await operations.screenshot({ path: `artifacts/qa/v32-buffer-settings-${mode}-font-${scale}.png` });
      }
      if (scale === 200) {
        await sections.first().getByRole("button", { name: "自定义" }).click();
        const customInput = sections.first().getByLabel("生产建筑缓存上限自定义值");
        await expect(customInput).toBeVisible();
        await expect(sections.first().getByRole("button", { name: "应用" })).toBeVisible();
        await expect.poll(async () => operations.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
        await customInput.evaluate((element) => element.scrollIntoView({ block: "center" }));
        await operations.screenshot({ path: `artifacts/qa/v32-buffer-settings-${mode}-custom-font-200.png` });
        await sections.first().getByRole("button", { name: "100万" }).click();
      }
    }
  }
});

