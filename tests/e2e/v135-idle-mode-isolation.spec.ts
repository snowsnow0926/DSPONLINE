import { expect, test } from "@playwright/test";

const RELEASE_NOTE_ID = "2026-08-17-v1.0.46";

async function prepare(page: import("@playwright/test").Page): Promise<void> {
  await page.addInitScript((releaseNoteId) => {
    window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", releaseNoteId);
    window.localStorage.setItem("dsp-idle-network.onboarding.v1", "dismissed");
    window.localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, completedEvents: [], skipped: true }));
  }, RELEASE_NOTE_ID);
}

test("普通与速通本地槽位同时存在，速通只能单向复制到空普通槽位", async ({ page }) => {
  await prepare(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?menu=1");
  await expect(page.locator(".start-menu")).toBeVisible();

  await page.evaluate(async () => {
    const engine = await import("/src/game/engine.ts");
    const storage = await import("/src/game/storage.ts");
    const localStore = await import("/src/game/localSaveStore.ts");
    const normal = engine.createInitialState(20_260_809, false);
    normal.paused = true;
    normal.elapsedSeconds = 111;
    const speedrun = engine.createSpeedrunInitialState(1_777_777_777_000, "e2e_mode_isolation_factory");
    speedrun.paused = true;
    speedrun.elapsedSeconds = 222;
    const normalPrimary = await storage.saveGameVerified(normal);
    const speedrunPrimary = await storage.saveGameVerified(speedrun);
    const normalSlot = await storage.saveGameSlotVerified(1, normal);
    const speedrunSlot = await storage.saveGameSlotVerified(2, speedrun);
    if (!normalPrimary.success || !speedrunPrimary.success || !normalSlot.success || !speedrunSlot.success) {
      throw new Error("failed to create primary fixtures");
    }
    await localStore.flushLocalSaveWrites();
  });
  await page.reload();
  await page.getByRole("button", { name: "加载存档" }).click();

  const normalOne = page.locator("article").filter({ hasText: "普通模式 · 本地槽位 1" });
  const speedrunTwo = page.locator("article").filter({ hasText: "速通模式 · 本地槽位 2" });
  await expect(normalOne).toContainText("1 分钟");
  await expect(speedrunTwo).toContainText("3 分钟");
  await expect(page.locator(".start-menu-overview-metrics")).toHaveCount(0);
  await expect(page.locator(".start-menu-save-list")).toContainText("速通模式 · 主存档");

  await speedrunTwo.getByRole("button", { name: /复制为普通/ }).click();
  const copyDialog = page.getByRole("alertdialog", { name: "复制为普通存档" });
  await expect(copyDialog).toContainText("普通副本不会计入速通排行榜");
  await expect(copyDialog).toContainText("不能再转换回速通模式");
  await copyDialog.getByRole("button", { name: "复制到普通槽位 2" }).click();
  await expect(page.locator(".start-menu-message")).toContainText("原速通存档未改变");

  const normalTwo = page.locator("article").filter({ hasText: "普通模式 · 本地槽位 2" });
  await expect(normalTwo).toContainText("3 分钟");
  await expect(normalTwo.getByRole("button", { name: /复制为普通/ })).toHaveCount(0);
  await expect(speedrunTwo).toContainText("3 分钟");

  await normalOne.getByRole("button", { name: "删除普通模式槽位 1" }).click();
  const deleteDialog = page.getByRole("dialog", { name: "删除普通模式槽位 1" });
  await deleteDialog.getByRole("button", { name: /继续确认/ }).click();
  await page.getByRole("alertdialog", { name: "删除普通模式槽位 1" }).getByRole("button", { name: /确认永久删除/ }).click();
  await expect(page.locator(".start-menu-message")).toContainText("其他存档未受影响");

  const persisted = await page.evaluate(async () => {
    const storage = await import("/src/game/storage.ts");
    const [deletedNormal, copiedNormal, sourceSpeedrun] = await Promise.all([
      storage.loadGameSlotFromPersistence(1, "normal"),
      storage.loadGameSlotFromPersistence(2, "normal"),
      storage.loadGameSlotFromPersistence(2, "speedrun"),
    ]);
    return {
      deletedNormal,
      copiedNormalMode: copiedNormal?.state.mode,
      copiedHasSpeedrunState: Boolean(copiedNormal?.state.speedrun),
      sourceMode: sourceSpeedrun?.state.mode,
      sourceFactoryId: sourceSpeedrun?.state.speedrun?.factoryId,
    };
  });
  expect(persisted).toEqual({
    deletedNormal: null,
    copiedNormalMode: "normal",
    copiedHasSpeedrunState: false,
    sourceMode: "speedrun",
    sourceFactoryId: "e2e_mode_isolation_factory",
  });
});

