import { expect, test, type Page } from "@playwright/test";

function syntheticSave() {
  return JSON.stringify({ savedAt: Date.now(), state: {
    version: 46, entities: [], belts: [], tray: { iron_ore: 42 }, construction: {},
    paused: true, research: { completedTechIds: [], selectedTechId: null, progressByTech: {} },
    settings: { autosaveIntervalSeconds: 0, simulationSpeed: 1, theme: "dark" },
  } });
}

async function openSaves(page: Page) {
  await page.addInitScript((raw) => {
    sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-11-07-v1.3.9");
    localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
    localStorage.setItem("dsp-idle-network.save.v1", raw);
  }, syntheticSave());
  await page.route("**/api/**", (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"isolated file review"}' }));
  await page.goto("/");
  await expect(page.locator(".factory-canvas")).toBeVisible({ timeout: 30_000 });
  await page.getByLabel("打开设置").click();
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.getByRole("tab", { name: "存档", exact: true }).click();
  return operations;
}

test("empty save file reports a readable error, resets the chooser and allows the same file again", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const operations = await openSaves(page);
  const input = operations.getByLabel("选择要导入的存档文件");
  const empty = { name: "empty.json", mimeType: "application/json", buffer: Buffer.alloc(0) };
  await input.setInputFiles(empty);
  await expect(operations.getByRole("alert").filter({ hasText: "存档文件为空" })).toBeVisible();
  await expect(input).toHaveValue("");
  await input.setInputFiles(empty);
  await expect(operations.getByRole("alert").filter({ hasText: "存档文件为空" })).toBeVisible();
  await expect(input).toHaveValue("");
  expect(errors).toEqual([]);
});

test("a corrupt gzip clears an earlier import preview and never offers its stale confirmation", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const operations = await openSaves(page);
  const input = operations.getByLabel("选择要导入的存档文件");
  await input.setInputFiles({ name: "synthetic.json", mimeType: "application/json", buffer: Buffer.from(syntheticSave()) });
  await expect(operations.getByLabel("存档导入预览")).toBeVisible();
  await input.setInputFiles({ name: "broken.json.gz", mimeType: "application/gzip", buffer: Buffer.from([0x1f, 0x8b, 0x08, 0, 0]) });
  await expect(operations.getByRole("alert").filter({ hasText: "gzip 存档损坏或无法解压" })).toBeVisible();
  await expect(operations.getByLabel("存档导入预览")).toHaveCount(0);
  await expect(operations.getByRole("button", { name: "确认导入", exact: true })).toHaveCount(0);
  await expect(input).toHaveValue("");
  expect(errors).toEqual([]);
});

test("content-pack read failures show a retryable error instead of an unhandled rejection", async ({ page }) => {
  await page.addInitScript(() => {
    const read = File.prototype.text;
    File.prototype.text = function () {
      return this.name === "unreadable-pack.json"
        ? Promise.reject(new DOMException("文件当前不可读取", "NotReadableError"))
        : read.call(this);
    };
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const operations = await openSaves(page);
  await operations.getByRole("tab", { name: "内容包", exact: true }).click();
  const input = operations.getByLabel("选择要注册的内容包");
  await input.setInputFiles({ name: "unreadable-pack.json", mimeType: "application/json", buffer: Buffer.from("{}") });
  await expect(operations.getByRole("alert").filter({ hasText: "文件当前不可读取" })).toBeVisible();
  await expect(input).toHaveValue("");
  expect(errors).toEqual([]);
});

for (const origin of ["saves", "packs"] as const) {
  test(`clears stale content-pack validation after a failed ${origin} selection across tabs`, async ({ page }) => {
    await page.addInitScript(() => {
      const read = File.prototype.text;
      File.prototype.text = function () {
        return this.name === "unreadable-pack.json"
          ? Promise.reject(new DOMException("文件当前不可读取", "NotReadableError"))
          : read.call(this);
      };
    });
    const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
    const operations = await openSaves(page);
    if (origin === "packs") await operations.getByRole("tab", { name: "内容包", exact: true }).click();
    const input = operations.getByLabel(origin === "packs" ? "选择要注册的内容包" : "选择内容包文件", { exact: true });
    const valid = { name: "old-pack.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ formatVersion: 2, id: "review_previous_pack", name: "旧校验内容包", version: "1.0.0" })) };
    await input.setInputFiles(valid);
    const preview = operations.locator(".content-pack-registration, .content-pack-result");
    await expect(preview).toContainText("旧校验内容包");
    if (origin === "packs") await expect(operations.getByRole("button", { name: "注册并启用", exact: true })).toBeEnabled();
    else await expect(preview).toContainText("内容包校验通过");
    await input.setInputFiles({ name: "unreadable-pack.json", mimeType: "application/json", buffer: Buffer.from("{}") });
    await expect(operations.getByRole("alert").filter({ hasText: "文件当前不可读取" })).toBeVisible();
    await expect(preview).toHaveCount(0);
    await operations.getByRole("tab", { name: origin === "packs" ? "存档" : "内容包", exact: true }).click();
    await expect(preview).toHaveCount(0);
    await expect(operations.getByRole("button", { name: "注册并启用", exact: true })).toHaveCount(0);
    await operations.getByRole("tab", { name: origin === "packs" ? "内容包" : "存档", exact: true }).click();
    await expect(preview).toHaveCount(0);
    await expect(input).toHaveValue("");
    // Failure invalidates the old candidate without disabling a later retry.
    await input.setInputFiles(valid);
    await expect(preview).toContainText("旧校验内容包");
    await expect(page.locator('.tray-row[title="拿取铁矿石"] strong')).toHaveText("42");
    expect(errors).toEqual([]);
  });
}
