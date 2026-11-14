import { expect, test, type Page } from "@playwright/test";

test.use({ viewport: { width: 390, height: 700 }, hasTouch: true });

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-11-14-v1.3.14");
    localStorage.setItem("dsp-idle-network.onboarding.v1", "dismissed");
    localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
  });
  await context.route("**/api/**", route => route.fulfill({ status: 503, contentType: "application/json", body: "{}" }));
});

async function writerStatus(page: Page) {
  return page.evaluate(async () => (await import("/src/game/localSaveStore.ts")).getLocalSaveWriterStatus());
}

for (const timing of ["absent", "throws"] as const) {
  test(`takeover can enter the factory with ${timing} Navigation Timing and no unload events`, async ({ page, context }) => {
    test.setTimeout(90_000);
    await page.goto("/?menu=1&storageMigration=production");
    await expect(page.locator(".start-menu")).toBeVisible();
    const original = await page.evaluate(async () => {
      const engine = await import("/src/game/engine.ts");
      const storage = await import("/src/game/storage.ts");
      const store = await import("/src/game/localSaveStore.ts");
      const state = engine.createInitialState();
      state.paused = true;
      state.settings.autosaveEnabled = false;
      state.tray.iron_ore = 42;
      state.blueprints = [];
      const saved = await storage.saveGameVerified(state);
      if (!saved.success) throw new Error(saved.message);
      return store.readPersistedLocalSaveValue("dsp-idle-network.save.v1");
    });
    expect(original).not.toBeNull();
    const secondary = await context.newPage();
    const errors: string[] = [];
    secondary.on("pageerror", error => errors.push(error.message));
    await secondary.addInitScript((timing) => {
      Object.defineProperty(performance, "navigation", { configurable: true, value: undefined });
      Object.defineProperty(performance, "getEntriesByType", {
        configurable: true,
        value: timing === "absent" ? undefined : () => { throw new TypeError("Navigation Timing unavailable"); },
      });
      const listen = window.addEventListener.bind(window);
      window.addEventListener = ((type, ...args) => {
        if (type !== "beforeunload" && type !== "pagehide") listen(type, ...args);
      }) as typeof window.addEventListener;
    }, timing);
    await secondary.goto("/?menu=1&storageMigration=production");
    await expect(secondary.getByRole("alert").filter({ hasText: "本页面为只读" })).toBeVisible();
    const secondaryId = (await writerStatus(secondary)).writerId;
    await secondary.getByRole("button", { name: "强制接管本页", exact: true }).click();
    await Promise.all([
      secondary.waitForEvent("framenavigated", { predicate: frame => frame === secondary.mainFrame() }),
      secondary.getByRole("button", { name: "确认接管本页", exact: true }).click(),
    ]);
    await expect(secondary.locator(".start-menu")).toBeVisible();
    await expect(secondary.getByRole("alert").filter({ hasText: "本页面为只读" })).toHaveCount(0);
    expect(await writerStatus(secondary)).toMatchObject({ role: "primary", writerId: secondaryId });
    expect(await secondary.evaluate(async () => (await import("/src/game/localSaveStore.ts")).readPersistedLocalSaveValue("dsp-idle-network.save.v1"))).toBe(original);
    await expect.poll(async () => (await writerStatus(page)).role).toBe("secondary");
    const rejected = await page.evaluate(async () => {
      const engine = await import("/src/game/engine.ts");
      return (await import("/src/game/storage.ts")).saveGameVerified(engine.createInitialState());
    });
    expect(rejected).toMatchObject({ success: false, code: "read-only" });
    await secondary.getByRole("button", { name: "继续游戏", exact: false }).click();
    await expect(secondary.locator(".factory-canvas")).toBeVisible({ timeout: 60_000 });
    const loaded = await secondary.evaluate(async () => {
      const raw = await (await import("/src/game/localSaveStore.ts")).readPersistedLocalSaveValue("dsp-idle-network.save.v1");
      return JSON.parse(raw!).state;
    });
    expect(loaded.tray.iron_ore).toBe(42);
    expect(loaded.paused).toBe(true);
    expect(errors).toEqual([]);
  });
}

