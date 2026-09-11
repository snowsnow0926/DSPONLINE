import { expect, test, type Page } from "@playwright/test";
import { selectSettingsCategory } from "./settings-helpers";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-11-v1.0.38");
  });
  const offlineReport = page.getByRole("dialog", { name: "离线结算报告" });
  await page.addLocatorHandler(offlineReport, async () => {
    await offlineReport.getByRole("button", { name: "确认结算" }).click();
  });
});

async function openSettings(page: Page, mode: "desktop" | "legacy" | "next") {
  const viewport = mode === "desktop" ? { width: 1440, height: 900 } : { width: 390, height: 844 };
  await page.setViewportSize(viewport);
  await page.goto(mode === "next" ? "/?mobileUi=next" : "/");
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
  const operations = await openSettings(page, "desktop");
  await selectSettingsCategory(operations, "终局性能", "performance");
  const production = operations.locator(".settings-buffer-limit").filter({ hasText: "生产建筑缓存上限" });
  const logistics = operations.locator(".settings-buffer-limit").filter({ hasText: "仓储与物流建筑缓存上限" });
  const belts = operations.locator(".settings-buffer-limit").filter({ hasText: "传送带转运额度上限" });

  await expect(production.getByRole("button", { name: "100万" })).toHaveAttribute("aria-pressed", "true");
  await expect(logistics.getByRole("button", { name: "100万" })).toHaveAttribute("aria-pressed", "true");
  await expect(belts.getByRole("button", { name: "自定义" })).toHaveAttribute("aria-pressed", "true");
  await expect(belts.getByLabel("传送带转运额度上限自定义值")).toHaveValue("100000000");
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
  await operations.getByRole("button", { name: "立即保存" }).click();
  const persisted = await page.evaluate(() => JSON.parse(window.localStorage.getItem("dsp-idle-network.save.v1")!).state.settings);
  expect(persisted).toMatchObject({ productionBufferLimit: 100_000_000, logisticsBufferLimit: 100_000, beltBufferLimit: 100_000_000 });
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
