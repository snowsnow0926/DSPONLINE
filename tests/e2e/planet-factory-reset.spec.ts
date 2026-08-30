import { expect, test } from "@playwright/test";
import { createInitialState, placeBuilding } from "../../src/game/engine";
import { getPlanetDisplayName } from "../../src/game/galaxy";
import { serializeEnvelope } from "../../src/game/storage";

test("star map resets one planet only after three confirmations", async ({ page }) => {
  let state = createInitialState();
  state.construction.wind_turbine = 2;
  state = placeBuilding(state, "wind_turbine", { x: 120, y: 120 }, 2);
  const planetName = getPlanetDisplayName(state, "home");
  const rawSave = serializeEnvelope(state, Date.now());

  await page.addInitScript(({ rawSave }) => {
    window.sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    window.localStorage.setItem("dsp-idle-network.onboarding.v1", "dismissed");
    window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-31-v1.2.6");
    window.localStorage.setItem("dsp-idle-network.save.v1", rawSave);
  }, { rawSave });
  await page.goto("/");

  await expect(page.locator(".factory-node:not(.vein-node)")).toHaveCount(1);
  await page.getByLabel("打开星图").click();
  const starMap = page.getByRole("dialog", { name: "星图" });
  await starMap.getByRole("group", { name: `${planetName}行星操作` }).getByRole("button", { name: "重置此星球工厂" }).click();

  let resetDialog = page.getByRole("alertdialog", { name: /第 1 \/ 3 次确认/ });
  await expect(resetDialog).toContainText("不会返还");
  await resetDialog.getByRole("button", { name: "第一次确认：继续" }).click();
  resetDialog = page.getByRole("alertdialog", { name: /第 2 \/ 3 次确认/ });
  await expect(resetDialog).toContainText("不能撤销");
  await resetDialog.getByRole("button", { name: "第二次确认：继续" }).click();
  resetDialog = page.getByRole("alertdialog", { name: /第 3 \/ 3 次确认/ });
  const finalButton = resetDialog.getByRole("button", { name: "第三次确认并永久重置" });
  await expect(finalButton).toBeDisabled();
  await resetDialog.getByRole("textbox").fill(planetName);
  await expect(finalButton).toBeEnabled();
  await finalButton.click();

  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(starMap).toBeVisible();
  await starMap.getByLabel("关闭星图").click();
  await expect(page.locator(".factory-node:not(.vein-node)")).toHaveCount(0);
  await expect(page.locator(".vein-node")).toHaveCount(6);
  await expect(page.getByRole("button", { name: "撤销", exact: true })).toBeDisabled();
  await expect(page.locator(".game-notice")).toContainText(`已永久重置${planetName}`);
});
