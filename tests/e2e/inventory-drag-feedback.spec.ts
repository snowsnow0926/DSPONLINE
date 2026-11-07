import { expect, test } from "@playwright/test";
import { createInitialState } from "../../src/game/engine";
import { serializeEnvelope } from "../../src/game/storage";

for (const scenario of ["paused", "running", "full-tray"] as const) {
  test(`building inventory drag preserves bulk transfer and explains ${scenario}`, async ({ page }) => {
    const state = createInitialState();
    state.paused = scenario !== "running";
    state.settings.autosaveIntervalSeconds = 0;
    state.tray.iron_ore = scenario === "full-tray" ? 1000 : 0;
    state.planetTrayItemLimits.home = 1000;
    state.planetTrays.home = { ...state.tray };
    state.entities.find((entity) => entity.id === "vein_iron")!.outputs.iron_ore = 547;
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript((raw) => {
      sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
      localStorage.setItem("dsp-idle-network.save.v1", raw);
      localStorage.setItem("dsp-idle-network.ui.show-run-log.v1", "false");
      localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-11-07-v1.3.10");
      localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
    }, serializeEnvelope(state, Date.now()));
    await page.route("**/api/**", (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"isolated inventory test"}' }));
    await page.goto("/");
    const source = page.locator(".vein-node").filter({ hasText: "铁矿石" }).getByTitle("拿取铁矿石");
    await expect(source.locator("strong")).toHaveText("547");
    await source.dragTo(page.locator(".tray-block"));
    if (scenario === "full-tray") {
      await expect(page.getByRole("status").filter({ hasText: "物资托盘已满" })).toBeVisible();
      await expect(source.locator("strong")).toHaveText("547");
      await source.click();
      await expect(source.locator("strong")).toHaveText("447");
      await expect(page.locator(".cargo-slot")).toContainText("100");
    } else {
      await expect(source.locator("strong")).toHaveText("0");
      await expect(page.locator(".tray-row").filter({ hasText: "铁矿石" })).toContainText("547");
    }
  });
}
