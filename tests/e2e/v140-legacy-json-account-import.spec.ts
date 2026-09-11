import { expect, test, type Page, type Route } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const guard = "b".repeat(64);
const currentUser = {
  id: "synthetic-legacy-json-user",
  username: "legacy_json_user",
  email: "",
  displayName: "旧版导入测试",
  createdAt: 1_777_777_700_000,
  emailVerified: false,
  emailVerifiedAt: null,
  passwordChangedAt: 1_777_777_700_000,
  leaderboardVisible: true,
};

function cloudQuota() {
  const usage = () => ({
    logicalBytes: 0,
    uniquePayloadBytes: 0,
    revisionCount: 0,
    remainingBytes: 64 * 1024 * 1024,
  });
  const slots = { main: usage(), "1": usage(), "2": usage(), "3": usage() };
  return {
    version: "cloud-quota-v1",
    limits: {
      revisionBytes: 32 * 1024 * 1024,
      slotBytes: 64 * 1024 * 1024,
      modeBytes: 128 * 1024 * 1024,
      accountBytes: 256 * 1024 * 1024,
      historyRevisions: 20,
    },
    usage: {
      ...usage(),
      remainingBytes: 256 * 1024 * 1024,
      modes: {
        normal: { ...usage(), remainingBytes: 128 * 1024 * 1024, slots },
        speedrun: { ...usage(), remainingBytes: 128 * 1024 * 1024, slots },
      },
    },
  };
}

interface ImportObservation {
  count: number;
  body: string | null;
  headers: Record<string, string> | null;
  requests: string[];
}

async function installCloudAccount(
  page: Page,
  importResponse: (route: Route, observation: ImportObservation) => Promise<void>,
): Promise<ImportObservation> {
  const observation: ImportObservation = { count: 0, body: null, headers: null, requests: [] };
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.localStorage.setItem("dsp-idle-network.cloud-token.v1", "synthetic-legacy-import-token");
    window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-17-v1.0.46");
    window.localStorage.setItem("dsp-idle-network.onboarding.v1", "dismissed");
    window.localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, completedEvents: [], skipped: true }));
    window.localStorage.setItem("dsp-idle-network.menu-settings.v1", JSON.stringify({ fontScale: 2 }));
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    observation.requests.push(`${request.method()} ${pathname}`);
    const fulfill = (body: unknown, status = 200) => route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
    if (pathname === "/api/health") return fulfill({ ok: true, schemaVersion: 7, mailProvider: "disabled" });
    if (pathname === "/api/auth/web-session/migrate") return fulfill({ error: "旧接口" }, 404);
    if (pathname === "/api/account" && request.method() === "GET") return fulfill({
      user: currentUser,
      cloudSave: null,
      cloudSaves: { main: null, "1": null, "2": null, "3": null },
      cloudSavesByMode: {
        normal: { main: null, "1": null, "2": null, "3": null },
        speedrun: { main: null, "1": null, "2": null, "3": null },
      },
    });
    if (pathname === "/api/account/sessions") return fulfill({ sessions: [] });
    if (pathname === "/api/account/security-events") return fulfill({ events: [] });
    if (pathname === "/api/account/import/archive" && request.method() === "GET") return fulfill({
      import: {
        version: 1,
        guard,
        confirmation: `REPLACE_CLOUD_SAVES:${guard}`,
        replaces: { modes: ["normal", "speedrun"], slots: ["main", "1", "2", "3"] },
        preserves: ["account_identity", "sessions", "account_controls", "leaderboard_submissions"],
      },
      cloudQuota: cloudQuota(),
    });
    if (pathname === "/api/account/import/legacy-json" && request.method() === "POST") {
      observation.count += 1;
      observation.body = request.postData();
      observation.headers = request.headers();
      return importResponse(route, observation);
    }
    return fulfill({ error: `unexpected synthetic route ${request.method()} ${pathname}` }, 404);
  });
  return observation;
}

async function openSecurity(page: Page): Promise<ReturnType<Page["getByRole"]>> {
  await page.goto("/?menu=1");
  await page.getByRole("button", { name: "登录与云存档" }).click();
  const security = page.getByRole("region", { name: "云账号安全" });
  await expect(security).toBeVisible();
  return security;
}

test("explicit legacy JSON selection previews, confirms and uploads the original bytes once", async ({ page }) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  const legacyJson = JSON.stringify({
    exportedAt: 1_777_777_700_000,
    schemaVersion: 7,
    user: { id: currentUser.id },
    cloudSave: null,
  });
  const observation = await installCloudAccount(page, async (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      imported: true,
      revisionCount: 1,
      logicalBytes: legacyJson.length,
      guard: "c".repeat(64),
      modes: { normal: { main: { revision: 1 } }, speedrun: {} },
      leaderboardRevalidationRequired: { normal: true, speedrun: false },
    }),
  }));
  await page.setViewportSize({ width: 390, height: 844 });
  const security = await openSecurity(page);

  const legacyButton = security.getByRole("button", { name: "选择旧版 JSON（兼容）" });
  await expect(legacyButton).toBeVisible();
  expect(observation.count).toBe(0);
  const chooser = page.waitForEvent("filechooser");
  await legacyButton.click();
  await (await chooser).setFiles({
    name: "legacy-account.json",
    mimeType: "application/json",
    buffer: Buffer.from(legacyJson, "utf8"),
  });
  await expect(security.getByRole("status")).toContainText("ZIP 账号归档更完整");
  await expect(security.getByRole("status")).toContainText("独立历史修订会被拒绝");
  expect(observation.count).toBe(0);
  await expect.poll(() => page.evaluate(async () => {
    const cloud = await import("/src/game/cloud.ts");
    return {
      token: cloud.getCloudToken(),
      authenticated: cloud.hasCloudAuthentication(),
      base: cloud.cloudApiBase(),
    };
  })).toEqual({ token: "synthetic-legacy-import-token", authenticated: true, base: "/api" });
  await security.getByRole("button", { name: "检查并导入账号归档" }).click();
  await expect.poll(
    () => observation.requests.filter((entry) => entry === "GET /api/account/import/archive").length,
    { message: JSON.stringify({ requests: observation.requests, browserErrors }) },
  ).toBe(1);
  const dialog = page.getByRole("alertdialog", { name: "从旧版 JSON 替换云存档" });
  await expect(dialog).toContainText("缺少模式字段不会推断为速通");
  await expect(dialog).toContainText("请改用 ZIP 账号归档");
  expect(observation.count).toBe(0);
  await dialog.getByRole("button", { name: "确认替换并导入" }).dblclick();

  await expect(security.getByRole("status")).toContainText("旧版 JSON 账号数据已原子导入 1 个修订");
  expect(observation.count).toBe(1);
  expect(observation.body).toBe(legacyJson);
  expect(observation.headers?.["content-type"]).toBe("application/vnd.dspidle.account-export+json");
  expect(observation.headers?.authorization).toBe("Bearer synthetic-legacy-import-token");
  expect(observation.headers?.["x-dsp-account-import-guard"]).toBe(guard);
  expect(observation.headers?.["x-dsp-account-import-confirmation"]).toBe(`REPLACE_CLOUD_SAVES:${guard}`);
  if (observation.headers?.["content-length"] !== undefined) {
    expect(Number(observation.headers["content-length"])).toBe(Buffer.byteLength(legacyJson));
  }
  await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("unrecoverable legacy histories show the ZIP remedy and leave the selected source available", async ({ page }) => {
  const observation = await installCloudAccount(page, async (route) => route.fulfill({
    status: 409,
    contentType: "application/json",
    body: JSON.stringify({
      error: "history metadata has no payload",
      code: "ACCOUNT_ARCHIVE_LEGACY_JSON_HISTORY_UNRESTORABLE",
    }),
  }));
  const security = await openSecurity(page);
  const chooser = page.waitForEvent("filechooser");
  await security.getByRole("button", { name: "选择旧版 JSON（兼容）" }).click();
  await (await chooser).setFiles({
    name: "legacy-with-history.json",
    mimeType: "application/json",
    buffer: Buffer.from("{\"schemaVersion\":7,\"cloudSaveHistory\":[{}]}", "utf8"),
  });
  await security.getByRole("button", { name: "检查并导入账号归档" }).click();
  await page.getByRole("alertdialog", { name: "从旧版 JSON 替换云存档" })
    .getByRole("button", { name: "确认替换并导入" }).click();

  await expect(security.getByRole("status")).toContainText("请改用 ZIP 账号归档");
  await expect(security.getByRole("status")).toContainText("现有云存档未修改");
  await expect(security.getByRole("button", { name: "检查并导入账号归档" })).toBeVisible();
  expect(observation.count).toBe(1);
});

