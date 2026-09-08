import { expect, test } from "@playwright/test";

for (const advanced of [false, true]) {
 for (const entry of ["menu", "bypass"] as const) {
  test(`${entry} loads and saves a verified journal with its original primary catalog (advanced=${advanced})`, async ({ page }) => {
    await page.goto("/?menu=1&storageMigration=production");
    await expect(page.locator(".start-menu")).toBeVisible();
    const source = await page.evaluate(async advanced => {
      const engine = await import("/src/game/engine.ts");
      const storage = await import("/src/game/storage.ts");
      const store = await import("/src/game/localSaveStore.ts");
      const journal = await import("/src/game/chunkedSaveJournal.ts");
      const state = engine.createInitialState();
      state.paused = true;
      state.settings.autosaveIntervalSeconds = 0;
      const savedAt = Date.now();
      const raw = storage.serializeEnvelope(state, savedAt);
      store.setLocalSaveValue("dsp-idle-network.save.v1", raw);
      await store.flushLocalSaveWrites();
      const changed = JSON.parse(raw).state;
      if (advanced) {
        changed.elapsedSeconds += 5;
        changed.tray.iron_ore = 25;
        changed.planetTrays.home = { ...changed.tray };
      }
      const result = await journal.persistChunkedSaveJournal(changed, {
        mode: "normal", basePrimaryChecksum: JSON.parse(raw).checksum, savedAt,
      });
      if (!result.success) throw new Error("Journal seed failed");
      const restored = await journal.restoreChunkedSavePayload(raw, "normal");
      if (!restored || restored.raw === raw) throw new Error("Expected distinct verified reconstruction bytes");
      const inspected = storage.inspectSave(restored.raw);
      if (!inspected.valid || !inspected.state) throw new Error("Invalid reconstructed fixture");
      return { raw, expectedState: JSON.parse(storage.serializeEnvelope(inspected.state, savedAt)).state };
    }, advanced);
    await page.reload();
    await expect(page.locator(".start-menu")).toBeVisible();
    const selected = await page.evaluate(async () => {
      const selected = await (await import("/src/game/savePreviewPayload.ts")).resolveMenuContinueSave("normal");
      const raw = await (await import("/src/game/localSaveStore.ts")).readLocalSavePayload("dsp-idle-network.save.v1");
      return { valid: selected?.inspection.valid, raw };
    });
    expect(selected).toEqual({ valid: true, raw: source.raw });
    const notes = page.getByRole("button", { name: "我知道了", exact: true });
    const guide = page.getByRole("button", { name: /^(?:关闭|跳过)启动引导$/ });
    await page.addLocatorHandler(notes, locator => locator.click());
    await page.addLocatorHandler(guide, locator => locator.click());
    if (entry === "menu") await page.getByRole("button", { name: /^恢复最近工厂\s*继续游戏$/ }).click();
    else await page.goto("/?factory=1&storageMigration=production");
    await expect(page.locator(".game-shell")).toHaveAttribute("data-simulation-paused", "true");
    // Save the actual loaded runtime through the UI, including the bypass
    // which intentionally does not commit on entry.
    await page.getByLabel("打开设置").click();
    const operations = page.getByRole("dialog", { name: "运营中心" });
    await operations.getByRole("tab", { name: "存档" }).click();
    const revision = await page.evaluate(async () => {
      const store = await import("/src/game/localSaveStore.ts");
      await store.flushLocalSaveWrites();
      return store.getPrimaryLocalSaveRevision();
    });
    await operations.getByRole("button", { name: "立即保存", exact: true }).click();
    await expect.poll(() => page.evaluate(async () => {
      const store = await import("/src/game/localSaveStore.ts");
      await store.flushLocalSaveWrites();
      return store.getPrimaryLocalSaveRevision();
    })).toBe(revision + 1);
    await expect(page.locator(".game-shell")).toHaveAttribute("data-persistence-phase", "complete");
    await expect(page.locator(".local-save-writer-banner--conflict")).toHaveCount(0);
    const committed = await page.evaluate(async () => {
      const raw = await (await import("/src/game/localSaveStore.ts")).readLocalSavePayload("dsp-idle-network.save.v1");
      return raw ? JSON.parse(raw).state : null;
    });
    expect(committed).toEqual(source.expectedState);
    await page.goto("/?menu=1&storageMigration=production");
    await expect(page.locator(".start-menu")).toBeVisible();
    const reopened = await page.evaluate(async () => {
      const resolved = await (await import("/src/game/savePreviewPayload.ts")).resolveMenuContinueSave("normal");
      return resolved ? JSON.parse(resolved.raw).state : null;
    });
    expect(reopened).toEqual(source.expectedState);
  });
 }
}
