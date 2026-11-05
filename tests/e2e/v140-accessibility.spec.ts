import AxeBuilder from "@axe-core/playwright";
import { workflowTimeoutMs } from "./startup-timeout";
import { expect, test, type Page } from "@playwright/test";

const BLOCKING_IMPACTS = new Set(["serious", "critical"]);

async function closeReleaseNotes(page: Page) {
  const dialog = page.getByRole("dialog", { name: /版本|更新/ });
  await dialog.waitFor({ state: "visible", timeout: 1_500 }).catch(() => undefined);
  if (await dialog.isVisible().catch(() => false)) {
    await dialog.getByRole("button", { name: /关闭|知道了|开始/ }).first().click();
    await expect(dialog).toBeHidden();
  }
}

async function expectNoBlockingAxeViolations(page: Page, context: string) {
  // Workspace surfaces use a short opacity entrance transition. Accessibility
  // contrast must be sampled from the settled UI, not a translucent keyframe.
  await page.waitForTimeout(300);
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const blocking = result.violations
    .filter((violation) => violation.impact && BLOCKING_IMPACTS.has(violation.impact))
    .map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      targets: violation.nodes.map((node) => node.target),
      details: violation.nodes.map((node) => node.failureSummary),
    }));
  expect(blocking, `${context} 存在 serious/critical axe 违规`).toEqual([]);
}

async function seedSyntheticFactory(page: Page) {
  await page.addInitScript(() => {
    sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    localStorage.setItem("dsp-idle-network.onboarding.v1", "dismissed");
    const state = {
      version: 2,
      entities: [],
      belts: [],
      construction: { thermal_power_plant: 1, storage_mk1: 1 },
      tray: { coal: 5 },
      totalProduced: {},
      research: {
        selectedTechId: null,
        progressByTech: {},
        completedTechIds: ["basic_logistics", "thermal_power"],
      },
      paused: true,
    };
    localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
}

test("critical player surfaces have no blocking axe violations and expose stable dialog semantics", async ({ page, browser }) => {
  test.setTimeout(workflowTimeoutMs(120_000));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?menu=1");
  await closeReleaseNotes(page);
  await expect(page.locator(".start-menu")).toBeVisible();
  await expectNoBlockingAxeViolations(page, "主菜单");

  await page.close();
  const factoryContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const factoryPage = await factoryContext.newPage();
  await seedSyntheticFactory(factoryPage);
  await factoryPage.goto("/");
  await closeReleaseNotes(factoryPage);
  await expect(factoryPage.locator(".game-shell")).toBeVisible();
  await expectNoBlockingAxeViolations(factoryPage, "工厂主界面");

  await factoryPage.getByLabel("打开设置").click();
  const settings = factoryPage.getByRole("dialog", { name: "运营中心" });
  await expect(settings).toBeVisible();
  await expectNoBlockingAxeViolations(factoryPage, "设置工作区");
  await factoryPage.getByLabel("设置已打开，再次点击返回工厂").click();

  await factoryPage.getByLabel("打开命令面板").click();
  const palette = factoryPage.getByRole("dialog", { name: "命令面板" });
  await expect(palette).toBeVisible();
  const semanticSnapshot = await palette.ariaSnapshot();
  expect(semanticSnapshot).toContain('- dialog "命令面板"');
  expect(semanticSnapshot).toContain('- combobox "搜索命令"');
  expect(semanticSnapshot).toContain('- listbox "命令结果"');
  await expectNoBlockingAxeViolations(factoryPage, "命令面板");
  await factoryPage.keyboard.press("Escape");
  await expect(palette).toBeHidden();

  await factoryPage.getByLabel("打开星图").click();
  await expect(factoryPage.getByRole("dialog", { name: /星图/ })).toBeVisible();
  await expectNoBlockingAxeViolations(factoryPage, "星图工作区");
  await factoryPage.getByLabel(/星图已打开/).click();

  await factoryPage.getByLabel("打开科技树").click();
  await expect(factoryPage.getByRole("dialog", { name: /科技树/ })).toBeVisible();
  await expectNoBlockingAxeViolations(factoryPage, "科技树工作区");
  await factoryContext.close();
});
