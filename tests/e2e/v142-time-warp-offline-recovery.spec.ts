import { expect, test, type Page } from "@playwright/test";

const RELEASE_NOTE_ID = "2026-08-17-v1.0.46";

async function openMenu(page: Page): Promise<void> {
  await page.addInitScript((releaseNoteId) => {
    localStorage.setItem("dsp-idle-network.release-notes.seen.v1", releaseNoteId);
    localStorage.setItem("dsp-idle-network.onboarding.v1", "dismissed");
  }, RELEASE_NOTE_ID);
  await page.goto("/?menu=1&storageMigration=production");
  await expect(page.locator(".start-menu")).toBeVisible();
}

async function seedOrphanedBudget(page: Page, pendingWallSeconds: number, pendingSimulationSeconds: number, ageSeconds: number) {
  return page.evaluate(async ({ pendingWall, pendingSimulation, age }) => {
    const engine = await import("/src/game/engine.ts");
    const storage = await import("/src/game/storage.ts");
    const state = engine.createInitialState();
    state.entities = [];
    state.belts = [];
    state.paused = false;
    state.timeWarp.enabled = true;
    state.timeWarp.pendingWallSeconds = pendingWall;
    state.timeWarp.pendingSimulationSeconds = pendingSimulation;
    state.idleSettlement.currentRunStartedAt = Date.now() - pendingWall * 1_000;
    const raw = storage.serializeEnvelope(state, Date.now() - age * 1_000);
    const saved = await storage.saveVerifiedPayload(raw, { mode: "normal" });
    if (!saved.success) throw new Error(saved.message);
    return raw;
  }, { pendingWall: pendingWallSeconds, pendingSimulation: pendingSimulationSeconds, age: ageSeconds });
}

test("an orphaned time-warp budget is converted to one ordinary offline interval before fast settlement", async ({ page }) => {
  test.setTimeout(90_000);
  await openMenu(page);
  await seedOrphanedBudget(page, 60, 720, 3_600);
  await page.reload();
  await expect(page.locator(".start-menu")).toBeVisible();

  await page.getByRole("button", { name: /继续游戏/ }).click();
  const choice = page.getByRole("dialog", { name: "选择离线结算方式" });
  await expect(choice).toBeVisible();
  await expect(choice).toContainText(/3,6[5-7][0-9] 秒/);
  await expect(page.getByText("存在未提交时间扭曲预算", { exact: false })).toHaveCount(0);
  await choice.getByRole("button", { name: /快速结算/ }).click();
  await expect(page.locator(".game-shell")).toBeVisible({ timeout: 60_000 });

  const persisted = await page.evaluate(async () => {
    const storage = await import("/src/game/storage.ts");
    const localStore = await import("/src/game/localSaveStore.ts");
    const raw = await localStore.readPersistedLocalSaveValue("dsp-idle-network.save.v1");
    const inspection = raw ? storage.inspectSave(raw) : null;
    if (!inspection?.state) throw new Error("durable primary save is missing after offline settlement");
    const state = inspection.state;
    return {
      elapsedSeconds: state.elapsedSeconds,
      enabled: state.timeWarp.enabled,
      pendingWallSeconds: state.timeWarp.pendingWallSeconds,
      pendingSimulationSeconds: state.timeWarp.pendingSimulationSeconds,
      currentRunStartedAt: state.idleSettlement.currentRunStartedAt,
    };
  });
  expect(persisted.enabled).toBe(false);
  expect(persisted.pendingWallSeconds).toBe(0);
  expect(persisted.pendingSimulationSeconds).toBe(0);
  expect(persisted.currentRunStartedAt).toBeNull();
  expect(persisted.elapsedSeconds).toBeGreaterThanOrEqual(3_650);
  expect(persisted.elapsedSeconds).toBeLessThan(4_000);

  await page.goto("/?menu=1&storageMigration=production");
  await expect(page.locator(".start-menu")).toBeVisible();
  await page.getByRole("button", { name: /继续游戏/ }).click();
  await expect(page.getByRole("dialog", { name: "选择离线结算方式" })).toHaveCount(0);
  await expect(page.locator(".game-shell")).toBeVisible();
});

test("an unavailable recovery journal offers explicit checkpoint recovery and preserves the source when cancelled", async ({ page }) => {
  test.setTimeout(90_000);
  await openMenu(page);
  const original = await seedOrphanedBudget(page, 75, 900, 0);
  await page.addInitScript(() => {
    const nativeOpen = indexedDB.open.bind(indexedDB);
    Object.defineProperty(indexedDB, "open", {
      configurable: true,
      value(name: string, version?: number) {
        if (name === "dsp-idle-network.pure-idle-recovery") throw new DOMException("injected journal unavailable", "InvalidStateError");
        return version === undefined ? nativeOpen(name) : nativeOpen(name, version);
      },
    });
  });
  await page.reload();
  await expect(page.locator(".start-menu")).toBeVisible();

  await page.getByRole("button", { name: /继续游戏/ }).click();
  let recovery = page.getByRole("dialog", { name: "时间扭曲检查点需要确认" });
  await expect(recovery).toBeVisible();
  await expect(recovery).toContainText("injected journal unavailable");
  await expect(recovery).toContainText("待恢复真实时间");
  await recovery.getByRole("button", { name: "暂不处理" }).click();
  await expect(recovery).toHaveCount(0);
  const unchanged = await page.evaluate(async () => (await import("/src/game/localSaveStore.ts")).readPersistedLocalSaveValue("dsp-idle-network.save.v1"));
  expect(unchanged).toBe(original);

  await page.getByRole("button", { name: /继续游戏/ }).click();
  recovery = page.getByRole("dialog", { name: "时间扭曲检查点需要确认" });
  await expect(recovery).toBeVisible();
  await recovery.getByRole("button", { name: "恢复检查点并快速结算" }).click();
  await expect(page.locator(".game-shell")).toBeVisible({ timeout: 60_000 });
  const settled = await page.evaluate(async () => {
    const storage = await import("/src/game/storage.ts");
    const localStore = await import("/src/game/localSaveStore.ts");
    const raw = await localStore.readPersistedLocalSaveValue("dsp-idle-network.save.v1");
    const inspection = raw ? storage.inspectSave(raw) : null;
    if (!inspection?.state) throw new Error("durable primary save is missing after recovery settlement");
    const state = inspection.state;
    return {
      elapsedSeconds: state.elapsedSeconds,
      pendingWallSeconds: state.timeWarp.pendingWallSeconds,
      pendingSimulationSeconds: state.timeWarp.pendingSimulationSeconds,
    };
  });
  expect(settled.pendingWallSeconds).toBe(0);
  expect(settled.pendingSimulationSeconds).toBe(0);
  expect(settled.elapsedSeconds).toBeGreaterThanOrEqual(75);
  expect(settled.elapsedSeconds).toBeLessThan(200);
});

