import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { selectSettingsCategory } from "./settings-helpers";

async function installTestBootstrap(page: Page) {
  await page.addInitScript(() => {
    window.sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    if (new URLSearchParams(window.location.search).get("releaseNotesTest") !== "1") {
      window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-11-v1.0.38");
    }
  });
}

async function dismissOnboarding(page: Page) {
  const control = page.getByRole("button", { name: /^(?:关闭|跳过)启动引导$/ });
  if (await control.count()) await control.first().click();
}

const testsManagingOfflineReport = new Set([
  "offline report summarizes production before entering the factory",
  "running equipment uses semantic animation and reduced motion disables it",
]);

const testsManagingOnboarding = new Set([
  "progressive onboarding reaches interstellar logistics and locates its blocker",
  "five-step basic onboarding advances only after successful factory commands",
  "manual mining feeds a powered smelter",
]);

test.beforeEach(async ({ page }, testInfo) => {
  await installTestBootstrap(page);
  if (!testsManagingOnboarding.has(testInfo.title)) {
    await page.addInitScript(() => window.localStorage.setItem("dsp-idle-network.onboarding.v1", "dismissed"));
  }
  if (!testsManagingOfflineReport.has(testInfo.title)) {
    const offlineReport = page.getByRole("dialog", { name: "离线结算报告" });
    await page.addLocatorHandler(offlineReport, async () => {
      await offlineReport.getByRole("button", { name: "确认结算" }).click();
    });
  }
});

test("start menu gates simulation and exposes saves, cloud, import and settings", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const presenceIds: string[] = [];
  await page.route("**/api/presence", async (route) => {
    const body = route.request().postDataJSON() as { playerId?: string };
    if (body.playerId) presenceIds.push(body.playerId);
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ accepted: true }) });
  });
  await page.goto("/?menu=1");

  await expect(page.locator(".start-menu")).toBeVisible();
  await expect(page.getByRole("heading", { name: "DSP极简网络" })).toBeVisible();
  await expect(page.getByRole("button", { name: /开始游戏/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "加载存档" })).toBeVisible();
  await expect(page.getByRole("button", { name: "登录与云存档" })).toBeVisible();
  await expect(page.getByRole("button", { name: "导入存档" })).toBeVisible();
  await expect(page.locator(".start-menu-project-note")).toContainText("本项目为免费个人作品，仅供交流与学习使用");
  await expect(page.locator(".start-menu-project-note")).toContainText("购买并游玩《戴森球计划》");
  await expect(page.locator(".start-menu-project-note")).toContainText("匿名标识统计游玩与在线人数");
  await expect(page.locator(".start-menu-project-note")).toContainText("1076757280");
  await expect(page.locator(".game-shell")).toHaveCount(0);
  expect(presenceIds).toHaveLength(0);
  await page.screenshot({ path: "artifacts/qa/player-presence-notice-1440.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.locator(".start-menu-project-note").scrollIntoViewIfNeeded();
  await expect(page.locator(".start-menu-project-note")).toBeVisible();
  await page.screenshot({ path: "artifacts/qa/player-presence-notice-390.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.getByRole("button", { name: "游戏设置" }).click();
  await expect(page.locator(".start-menu-settings")).toBeVisible();
  await expect(page.locator(".start-menu-community")).toContainText("1076757280");
  await page.locator(".start-menu-settings").getByRole("button", { name: "125%" }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--ui-font-scale"))).toBe("1.25");

  await page.getByRole("button", { name: /开始游戏/ }).click();
  await expect(page.locator(".game-shell")).toBeVisible();
  await expect(page.locator(".vein-node").filter({ hasText: "铁矿石" })).toBeVisible();
  await expect.poll(() => presenceIds.length).toBe(1);
  expect(presenceIds[0]).toMatch(/^player_[A-Za-z0-9_-]{16,}$/);

  await page.getByTitle("保存并返回主菜单").click();
  await expect(page.locator(".start-menu")).toBeVisible();
  await expect(page.getByRole("button", { name: /继续游戏/ })).toBeVisible();
  await page.getByRole("button", { name: /继续游戏/ }).click();
  await expect(page.locator(".game-shell")).toBeVisible({ timeout: 15_000 });
  expect(presenceIds).toHaveLength(1);
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("dsp-idle-network.player-id.v1"))).toBe(presenceIds[0]);
});

test("cancelling long offline advancement returns to the menu and preserves the pending interval", async ({ page }) => {
  await page.addInitScript(() => {
    const entities = Array.from({ length: 500 }, (_, index) => ({
      id: `offline_storage_${index}`,
      kind: "storage",
      planetId: "home",
      position: { x: index % 25 * 260, y: Math.floor(index / 25) * 190 },
      buildingId: "storage_mk1",
      storedItemId: "iron_ingot",
      machineCount: 1,
      minerCount: 0,
      inputs: {},
      outputs: { iron_ingot: index % 3 },
      progress: 0,
      routingCursor: 0,
      utilization: 0,
      productionRate: 0,
    }));
    const state = {
      version: 31,
      nextId: 501,
      activePlanetId: "home",
      entities,
      belts: [],
      construction: {},
      tray: {},
      planetTrays: { home: {} },
      totalProduced: {},
      research: { selectedTechId: null, pausedTechId: null, queuedTechIds: [], progressByTech: {}, completedTechIds: [] },
      paused: false,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now() - 7 * 24 * 60 * 60 * 1_000, state }));
  });
  await page.goto("/?menu=1");
  const original = await page.evaluate(() => {
    const raw = window.localStorage.getItem("dsp-idle-network.save.v1");
    if (!raw) throw new Error("missing offline save");
    const state = (JSON.parse(raw) as { state: { elapsedSeconds?: number; totalProduced?: Record<string, number> } }).state;
    return { elapsedSeconds: state.elapsedSeconds ?? 0, totalProduced: state.totalProduced ?? {} };
  });
  await page.evaluate(() => {
    class HangingOfflineWorker extends EventTarget {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      postMessage() { /* wait until the user cancels */ }
      terminate() { /* no process was spawned */ }
    }
    window.Worker = HangingOfflineWorker as unknown as typeof Worker;
  });
  await page.getByRole("button", { name: /继续游戏/ }).click();
  const progress = page.getByRole("dialog", { name: "正在进行离线运算" });
  await expect(progress).toBeVisible();
  await expect(progress).toContainText("完成并验证后才会一次性保存");
  await progress.getByRole("button", { name: "取消计算并返回" }).click();
  await expect(progress).toHaveCount(0);
  await expect(page.locator(".start-menu")).toBeVisible();
  await expect(page.locator(".game-shell")).toHaveCount(0);
  await expect(page.getByText(/原存档、savedAt 和离线时长均未修改/)).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const raw = window.localStorage.getItem("dsp-idle-network.save.v1");
    if (!raw) return null;
    const state = (JSON.parse(raw) as { state: { elapsedSeconds?: number; totalProduced?: Record<string, number> } }).state;
    return { elapsedSeconds: state.elapsedSeconds ?? 0, totalProduced: state.totalProduced ?? {} };
  })).toEqual(original);
  await page.getByRole("button", { name: /继续游戏/ }).click();
  await expect(progress).toContainText("604,800 模拟秒");
  await progress.getByRole("button", { name: "取消计算并返回" }).click();
  await expect(page.locator(".start-menu")).toBeVisible();
});

test("dated release notes appear once and remain available from both settings screens", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?menu=1&releaseNotesTest=1");

  const releaseNotes = page.getByRole("dialog", { name: "终局性能、存档瘦身与矿脉扩容更新" });
  await expect(releaseNotes).toBeVisible();
  await expect(releaseNotes.locator(".release-notes-scroll li")).toHaveCount(5);
  await expect(releaseNotes).toContainText("大存档只做一次权威序列化");
  await expect(releaseNotes).toContainText("终局结算复用稳定批次");
  await expect(releaseNotes).toContainText("存档默认字段可安全瘦身");
  await expect(releaseNotes).toContainText("单矿脉存档可受控补到两个");
  await expect(releaseNotes).toContainText("高密度画布减少无效刷新");
  await expect(releaseNotes).not.toContainText("单极磁石资源边界可审计");
  await page.screenshot({ path: "artifacts/qa/release-notes-2026-08-11-v138-1440.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await releaseNotes.locator(".release-notes-scroll li").last().scrollIntoViewIfNeeded();
  await expect.poll(async () => releaseNotes.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/release-notes-2026-08-11-v138-390.png", fullPage: true });

  await page.setViewportSize({ width: 360, height: 480 });
  await page.evaluate(() => {
    document.documentElement.dataset.uiFontScale = "200";
    document.documentElement.style.setProperty("--ui-font-scale", "2");
  });
  await releaseNotes.locator(".release-notes-scroll").evaluate((element) => { element.scrollTop = 0; });
  const controlsFitViewport = async () => releaseNotes.evaluate((dialog) => {
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const close = dialog.querySelector<HTMLButtonElement>(".release-notes-header > button")?.getBoundingClientRect();
    const confirm = dialog.querySelector<HTMLButtonElement>(".release-notes-footer > button")?.getBoundingClientRect();
    return Boolean(close && confirm && close.top >= 0 && close.bottom <= viewportHeight && confirm.top >= 0 && confirm.bottom <= viewportHeight);
  });
  await expect.poll(controlsFitViewport).toBe(true);
  await expect.poll(() => releaseNotes.evaluate((dialog) => {
    const scroll = dialog.querySelector<HTMLElement>(".release-notes-scroll")?.getBoundingClientRect();
    const summary = dialog.querySelector<HTMLElement>(".release-notes-summary")?.getBoundingClientRect();
    const firstItem = dialog.querySelector<HTMLElement>(".release-notes-scroll li")?.getBoundingClientRect();
    const footer = dialog.querySelector<HTMLElement>(".release-notes-footer")?.getBoundingClientRect();
    return Boolean(scroll && summary && firstItem && footer && summary.bottom <= firstItem.top + 1 && scroll.bottom <= footer.top + 1);
  })).toBe(true);
  await expect.poll(() => releaseNotes.locator(".release-notes-scroll").evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/release-notes-2026-08-11-v138-360x480-font200.png", fullPage: true });
  await page.evaluate(() => {
    document.documentElement.dataset.uiFontScale = "100";
    document.documentElement.style.setProperty("--ui-font-scale", "1");
  });
  await page.setViewportSize({ width: 1440, height: 900 });

  await releaseNotes.getByRole("button", { name: "我知道了" }).click();
  await expect(releaseNotes).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("dsp-idle-network.release-notes.seen.v1"))).toBe("2026-08-11-v1.0.38");
  await page.reload();
  await expect(releaseNotes).toHaveCount(0);

  await page.getByRole("button", { name: "游戏设置" }).click();
  await page.getByRole("button", { name: "查看2026年8月11日版本更新记录" }).click();
  await expect(releaseNotes).toBeVisible();
  await releaseNotes.getByLabel("关闭版本更新记录").click();

  await page.locator(".start-menu-primary").click();
  await page.getByTitle("打开设置").click();
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.locator(".settings-category-overview").getByRole("button", { name: /教程、版本与其他/ }).click();
  await expect(operations.getByRole("button", { name: "查看版本更新记录" })).toBeVisible();
  await operations.getByRole("button", { name: "查看版本更新记录" }).click();
  await expect(releaseNotes).toBeVisible();
  await page.setViewportSize({ width: 844, height: 390 });
  await expect.poll(async () => releaseNotes.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/release-notes-2026-08-11-v138-844x390.png", fullPage: true });
  await releaseNotes.getByLabel("关闭版本更新记录").click();
  await expect(operations).toBeVisible();
});

test("protected operations dashboard renders visit, event and service metrics", async ({ page }) => {
  const generatedAt = Date.now();
  await page.route("**/api/admin/metrics?*", async (route) => {
    expect(route.request().headers().authorization).toBe("Bearer admin-test-token");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        generatedAt,
        timeZone: "Asia/Shanghai",
        schemaVersion: 4,
        uptimeSeconds: 7200,
        storage: "sqlite",
        runtime: { requests: 320, errors: 0, rateLimited: 2, cloudConflicts: 1, p50LatencyMs: 4.2, p95LatencyMs: 18.6 },
        accounts: { users: 12, activeSessions: 4, cloudSaves: 9, submissions: 3 },
        players: { total: 48, today: 7, online: 2, onlineWindowSeconds: 120 },
        analytics: {
          today: "2026-07-22",
          totalVisitors: 56,
          retainedSessions: 20,
          range: { days: 7, uniqueVisitors: 20, sessions: 28, pageViews: 44, gameStarts: 19, activeSeconds: 14400 },
          lifetime: { uniqueVisitors: 56, sessions: 81, pageViews: 130, gameStarts: 48, activeSeconds: 58000 },
          events: [{ name: "page_view", count: 44 }, { name: "game_enter", count: 19 }, { name: "open_technology", count: 8 }],
          performance: {
            pageLoad: { samples: 20, fast: 11, acceptable: 6, slow: 2, verySlow: 1, p75Band: "1.5-3 秒" },
            lcp: { samples: 18, good: 12, needsImprovement: 4, poor: 2, p75Band: "2.5-4 秒" },
            transfer: { samples: 20, light: 14, medium: 5, heavy: 1, p75Band: "1-3 MB" },
          },
          daily: [
            { day: "2026-07-21", uniqueVisitors: 9, sessions: 12, pageViews: 20, gameStarts: 8, activeSeconds: 6000, events: {}, clients: { "desktop-web": 8 }, sources: { direct: 12 } },
            { day: "2026-07-22", uniqueVisitors: 11, sessions: 16, pageViews: 24, gameStarts: 11, activeSeconds: 8400, events: {}, clients: { "mobile-web": 9 }, sources: { community: 7 } },
          ],
        },
        reports: { feedback: 4, clientErrors: 1 },
        audit: { entries: 2, recent: [{ action: "account.password_changed", occurredAt: generatedAt - 500, clientType: "desktop-web" }] },
        backups: {
          configured: true,
          lastSuccessAt: generatedAt - 1000,
          lastErrorAt: null,
          state: "ready",
          dailyWindow: "02:00-03:00",
          offsite: { configured: true, ok: true, state: "ready", completedAt: generatedAt - 2000, transported: true, transport: "scp" },
          restoreDrill: { configured: true, ok: true, state: "ready", completedAt: generatedAt - 3000 },
        },
        infrastructure: {
          configured: true,
          ok: true,
          state: "ready",
          checkedAt: generatedAt - 500,
          endpoints: [{ url: "https://dsponline.cn/api/health", ok: true, status: 200, latencyMs: 18, contentEncoding: "gzip" }],
          disk: { ok: true, freeBytes: 20 * 1024 ** 3, totalBytes: 40 * 1024 ** 3, freeRatio: 0.5 },
          tls: { configured: true, ok: true, expiresAt: generatedAt + 60 * 86400000, daysRemaining: 60 },
        },
        governance: {
          sqlite: { layoutVersion: 2, databaseBytes: 2 * 1024 ** 3, walBytes: 4 * 1024 ** 2, appStateBytes: 512 * 1024, cloudPayloadBytes: 1.5 * 1024 ** 3, cloudPayloadRows: 120, averageRevisionsPerAccount: 10 },
          historyPrune: { runs: 2, payloadsRemoved: 9, metadataRemoved: 9, lastRunAt: generatedAt - 5000 },
          disk: { warning80Percent: false, protection90Percent: false },
        },
        daily: [],
      }),
    });
  });
  await page.setViewportSize({ width: 1366, height: 820 });
  await page.goto("/admin");
  await expect(page.getByText("运营数据后台", { exact: true })).toBeVisible();
  await page.getByLabel("管理员凭据").fill("admin-test-token");
  await page.getByRole("button", { name: "进入后台" }).click();
  await expect(page.getByText("今日访客 UV")).toBeVisible();
  await expect(page.locator(".admin-kpi-grid")).toContainText("11");
  await expect(page.locator(".admin-kpi-grid")).toContainText("24");
  await expect(page.locator(".admin-events-panel")).toContainText("打开科技树");
  await expect(page.locator(".admin-service-panel")).toContainText("12");
  await expect(page.locator(".admin-service-panel")).toContainText("异地加密备份");
  await expect(page.locator(".admin-service-panel")).toContainText("20.0 GB · 50%");
  await expect(page.locator(".admin-performance-panel")).toContainText("页面加载 P75");
  await expect(page.locator(".admin-performance-panel")).toContainText("1.5-3 秒");
  await expect(page.locator(".admin-audit-panel")).toContainText("修改密码");
  await expect(page.locator(".admin-governance-panel")).toContainText("2.00 GiB");
  await expect(page.locator(".admin-account-panel")).toContainText("精确账号 ID");
  await page.screenshot({ path: "artifacts/qa/admin-dashboard-1366.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".admin-kpi-grid")).toBeVisible();
  const hasOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(hasOverflow).toBe(false);
  await page.screenshot({ path: "artifacts/qa/admin-dashboard-390.png", fullPage: true });
});

test("anonymous analytics batches an allowlisted page view without save data", async ({ page }) => {
  const batches: Array<Record<string, unknown>> = [];
  await page.route("**/api/analytics", async (route) => {
    batches.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ accepted: true, duplicate: false, day: "2026-07-22" }) });
  });
  await page.goto("/");
  await expect.poll(() => batches.length).toBeGreaterThan(0);
  const batch = batches[0] as { playerId: string; sessionId: string; events: Array<{ name: string; count: number }> };
  expect(batch.playerId).toMatch(/^player_[A-Za-z0-9_-]+$/);
  expect(batch.sessionId).toMatch(/^session_[a-z0-9]+$/);
  expect(batch.events).toContainEqual({ name: "page_view", count: 1 });
  expect(JSON.stringify(batch)).not.toContain("entities");
  expect(JSON.stringify(batch)).not.toContain("inventory");
});

test("cloud account security exposes verification, password and device controls", async ({ page }) => {
  const requests: string[] = [];
  let user = {
    id: "user_e2e",
    username: "pilot_e2e",
    email: "pilot@example.com",
    displayName: "测试工程师",
    createdAt: Date.now() - 1000,
    emailVerified: false,
    emailVerifiedAt: null,
    passwordChangedAt: Date.now() - 1000,
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    requests.push(`${request.method()} ${pathname}`);
    const fulfill = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (pathname === "/api/health") return fulfill({ ok: true, mailProvider: "custom" });
    if (pathname === "/api/auth/login") return fulfill({ token: "e2e-cloud-token", user });
    if (pathname === "/api/account" && request.method() === "GET") return fulfill({ user, cloudSave: null });
    if (pathname === "/api/account/sessions") return fulfill({ sessions: [
      { id: "session_current", deviceName: "Chrome 桌面浏览器", clientType: "desktop-web", createdAt: Date.now() - 1000, lastSeenAt: Date.now(), expiresAt: Date.now() + 100000, current: true },
      { id: "session_mobile", deviceName: "测试手机", clientType: "mobile-web", createdAt: Date.now() - 2000, lastSeenAt: Date.now() - 500, expiresAt: Date.now() + 100000, current: false },
    ] });
    if (pathname === "/api/account/security-events") return fulfill({ events: [
      { deviceHash: "1234567890abcdef", regionHash: "fedcba0987654321", occurredAt: Date.now(), clientType: "desktop-web" },
    ] });
    if (pathname === "/api/auth/resend-verification") return fulfill({ sent: true }, 202);
    if (pathname === "/api/account/email") {
      const body = request.postDataJSON() as { email: string };
      user = { ...user, email: body.email, emailVerified: false, emailVerifiedAt: null };
      return fulfill({ sent: true, user }, 202);
    }
    if (pathname === "/api/account/password") return fulfill({ changed: true, user: { ...user, passwordChangedAt: Date.now() } });
    if (pathname === "/api/account/sessions/revoke") return fulfill({ revoked: true, currentSessionRevoked: false });
    return fulfill({ error: `unmocked ${pathname}` }, 404);
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?menu=1");
  await page.getByRole("button", { name: "登录与云存档" }).click();
  await page.getByLabel("用户名或邮箱").fill("pilot@example.com");
  await page.getByLabel("密码", { exact: true }).fill("strong-pass-123");
  await page.getByRole("button", { name: "登录云账户" }).click();

  const security = page.getByRole("region", { name: "云账号安全" });
  await expect(security).toBeVisible();
  await expect(security).toContainText("邮箱等待验证");
  await security.getByRole("button", { name: "重发" }).click();
  await expect(security).toContainText("验证邮件已发送");
  await expect(security).toContainText("Chrome 桌面浏览器");
  await expect(security).toContainText("测试手机");
  await security.getByText("最近登录安全记录", { exact: true }).click();
  await expect(security).toContainText("设备 123456");
  await expect(page.getByRole("region", { name: "云端手动存档槽位" }).locator("article")).toHaveCount(3);

  await security.getByText("更换待验证邮箱", { exact: true }).click();
  await security.getByLabel("邮箱地址").fill("new-pilot@example.com");
  await security.getByRole("button", { name: "绑定并发送验证邮件" }).click();
  await expect(security).toContainText("new-pilot@example.com");
  expect(requests).toContain("POST /api/account/email");

  await security.getByText("修改密码", { exact: true }).click();
  await security.getByLabel("当前密码").fill("strong-pass-123");
  await security.getByLabel("新密码", { exact: true }).fill("changed-pass-456");
  await security.getByLabel("确认新密码").fill("changed-pass-456");
  await security.getByRole("button", { name: "确认修改" }).click();
  await expect(security).toContainText("密码已修改");
  expect(requests).toContain("POST /api/auth/resend-verification");
  expect(requests).toContain("POST /api/account/password");

  await page.screenshot({ path: "artifacts/qa/cloud-account-security-1440.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await security.scrollIntoViewIfNeeded();
  await expect.poll(async () => security.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/cloud-account-security-390.png", fullPage: true });
});

test("cloud save divergence requires an explicit keep-local or use-cloud choice", async ({ page }) => {
  const user = {
    id: "user_conflict",
    username: "conflict_pilot",
    email: "conflict@example.com",
    displayName: "冲突测试工程师",
    createdAt: Date.now() - 1000,
    emailVerified: true,
    emailVerifiedAt: Date.now() - 900,
    passwordChangedAt: Date.now() - 1000,
  };
  const remoteSummary = {
    stateVersion: 24,
    savedAt: Date.now() - 5000,
    elapsedSeconds: 7200,
    activePlanetId: "ashen",
    entityCount: 42,
    completedTechCount: 12,
    structurePoints: 0,
    uploadedWhiteMatrix: 0,
    stateChecksum: "remote-state",
  };
  let cloudSave = { revision: 2, updatedAt: Date.now() - 5000, size: 2048, checksum: "remote-cloud", summary: remoteSummary };
  let overwriteExpectedRevision: number | null = null;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const fulfill = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (pathname === "/api/health") return fulfill({ ok: true });
    if (pathname === "/api/auth/login") return fulfill({ token: "conflict-cloud-token", user });
    if (pathname === "/api/account" && request.method() === "GET") return fulfill({ user, cloudSave });
    if (pathname === "/api/account/sessions") return fulfill({ sessions: [] });
    if (pathname === "/api/cloud-save" && request.method() === "PUT") {
      const body = request.postDataJSON() as { payload: string; expectedRevision: number };
      overwriteExpectedRevision = body.expectedRevision;
      const envelope = JSON.parse(body.payload) as { checksum?: string; savedAt?: number; state?: { elapsedSeconds?: number; entities?: unknown[]; research?: { completedTechIds?: unknown[] } } };
      cloudSave = {
        revision: 3,
        updatedAt: Date.now(),
        size: body.payload.length,
        checksum: "local-cloud",
        summary: {
          ...remoteSummary,
          savedAt: envelope.savedAt ?? Date.now(),
          elapsedSeconds: envelope.state?.elapsedSeconds ?? 0,
          entityCount: envelope.state?.entities?.length ?? 0,
          completedTechCount: envelope.state?.research?.completedTechIds?.length ?? 0,
          stateChecksum: envelope.checksum ?? null,
        },
      };
      return fulfill({ cloudSave });
    }
    return fulfill({ accepted: true });
  });

  await page.goto("/?menu=1");
  await page.getByRole("button", { name: /开始游戏/ }).click();
  await page.getByTitle("保存并返回主菜单").click();
  await page.getByRole("button", { name: "登录与云存档" }).click();
  await expect(page.getByRole("button", { name: "注册", exact: true })).toBeEnabled();
  await page.getByLabel("用户名或邮箱").fill("conflict@example.com");
  await page.getByLabel("密码", { exact: true }).fill("strong-pass-123");
  await page.getByRole("button", { name: "登录云账户" }).click();
  await expect(page.getByText("需要选择保留版本", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "上传本地存档" }).click();
  const dialog = page.getByRole("alertdialog", { name: "云存档冲突" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("当前本地工厂");
  await expect(dialog).toContainText("云端工厂");
  await expect(dialog).toContainText("42");
  await dialog.getByRole("button", { name: "保留本地并新建云修订" }).click();
  await expect(dialog).toHaveCount(0);
  expect(overwriteExpectedRevision).toBe(2);
  await expect(page.locator(".start-menu-message")).toContainText("修订 3");
});

test("cloud upload can abandon offline settlement and continue with the saved factory", async ({ page }) => {
  const user = {
    id: "user_upload_skip_offline",
    username: "upload_skip_offline",
    email: "upload-skip@example.com",
    displayName: "上传取消离线测试",
    createdAt: Date.now() - 1000,
    emailVerified: true,
    emailVerifiedAt: Date.now() - 900,
    passwordChangedAt: Date.now() - 1000,
  };
  let uploadedPayload: string | null = null;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const fulfill = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (pathname === "/api/health") return fulfill({ ok: true, schemaVersion: 7 });
    if (pathname === "/api/auth/login") return fulfill({ token: "upload-skip-token", user });
    if (pathname === "/api/account" && request.method() === "GET") return fulfill({ user, cloudSave: null, cloudSaves: { main: null, "1": null, "2": null, "3": null } });
    if (pathname === "/api/account/sessions") return fulfill({ sessions: [] });
    if (pathname === "/api/cloud-save" && request.method() === "PUT") {
      const body = request.postDataJSON() as { payload: string };
      uploadedPayload = body.payload;
      const envelope = JSON.parse(body.payload) as { checksum?: string; savedAt?: number; state?: { elapsedSeconds?: number; entities?: unknown[]; research?: { completedTechIds?: unknown[] } } };
      return fulfill({ cloudSave: {
        revision: 1,
        updatedAt: Date.now(),
        size: body.payload.length,
        checksum: envelope.checksum ?? "upload-skip-checksum",
        summary: {
          stateVersion: 46,
          savedAt: envelope.savedAt ?? Date.now(),
          elapsedSeconds: envelope.state?.elapsedSeconds ?? 0,
          activePlanetId: "home",
          entityCount: envelope.state?.entities?.length ?? 0,
          completedTechCount: envelope.state?.research?.completedTechIds?.length ?? 0,
          structurePoints: 0,
          uploadedWhiteMatrix: 0,
          stateChecksum: envelope.checksum ?? null,
        },
      } });
    }
    return fulfill({ accepted: true });
  });
  await page.addInitScript(() => {
    Object.defineProperty(window, "CompressionStream", { configurable: true, value: undefined });
    const entities = Array.from({ length: 500 }, (_, index) => ({
      id: `upload_skip_${index}`,
      kind: "storage",
      planetId: "home",
      position: { x: index % 25 * 260, y: Math.floor(index / 25) * 190 },
      buildingId: "storage_mk1",
      storedItemId: "iron_ingot",
      machineCount: 1,
      minerCount: 0,
      inputs: {},
      outputs: { iron_ingot: index % 3 },
      progress: 0,
      routingCursor: 0,
      utilization: 0,
      productionRate: 0,
    }));
    const state = {
      version: 31,
      nextId: 501,
      activePlanetId: "home",
      entities,
      belts: [],
      construction: {},
      tray: {},
      planetTrays: { home: {} },
      totalProduced: {},
      research: { selectedTechId: null, pausedTechId: null, queuedTechIds: [], progressByTech: {}, completedTechIds: [] },
      paused: false,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now() - 7 * 24 * 60 * 60 * 1_000, state }));
  });

  await page.goto("/?menu=1");
  await page.getByRole("button", { name: "登录与云存档" }).click();
  await page.getByLabel("用户名或邮箱").fill("upload-skip@example.com");
  await page.getByLabel("密码", { exact: true }).fill("strong-pass-123");
  await page.getByRole("button", { name: "登录云账户" }).click();
  await page.getByRole("button", { name: "上传本地存档" }).click();
  const skipButton = page.getByRole("button", { name: "跳过离线并继续上传" });
  await expect(skipButton).toBeVisible();
  await skipButton.click();
  await expect(page.locator(".start-menu-message")).toContainText("云存档已更新到修订 1", { timeout: 30_000 });
  expect(uploadedPayload).not.toBeNull();
  const uploaded = JSON.parse(uploadedPayload!) as { state?: { elapsedSeconds?: number; totalProduced?: Record<string, number> } };
  expect(uploaded.state?.elapsedSeconds).toBe(0);
  expect(uploaded.state?.totalProduced).toEqual({});
});

test("username registration and login preserve every local save without automatic cloud restore", async ({ page }) => {
  const user = {
    id: "user_local_save_guard",
    username: "local_save_guard",
    email: "",
    displayName: "本地存档守护测试",
    createdAt: Date.now(),
    emailVerified: false,
    emailVerifiedAt: null,
    passwordChangedAt: Date.now(),
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const fulfill = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (pathname === "/api/health") return fulfill({ ok: true, schemaVersion: 7, mailProvider: "disabled" });
    if (pathname === "/api/auth/register") return fulfill({ token: "local-save-register-token", user, mailAvailable: false }, 201);
    if (pathname === "/api/auth/login") return fulfill({ token: "local-save-login-token", user });
    if (pathname === "/api/auth/logout") return fulfill({ ok: true });
    if (pathname === "/api/account") return fulfill({ user, cloudSave: null, cloudSaves: { main: null, "1": null, "2": null, "3": null } });
    if (pathname === "/api/account/sessions") return fulfill({ sessions: [] });
    return fulfill({ error: `unmocked ${pathname}` }, 404);
  });

  await page.goto("/?menu=1");
  await page.getByRole("button", { name: /开始游戏/ }).click();
  await page.getByTitle("保存并返回主菜单").click();
  const before = await page.evaluate(() => {
    const comparable = (raw: string | null) => {
      if (!raw) return null;
      const { savedAt: _savedAt, ...envelope } = JSON.parse(raw) as Record<string, unknown>;
      return envelope;
    };
    const main = window.localStorage.getItem("dsp-idle-network.save.v1");
    if (!main) throw new Error("missing local main save");
    window.localStorage.setItem("dsp-idle-network.slot.1", main);
    window.localStorage.setItem("dsp-idle-network.slot.2", main);
    window.localStorage.setItem("dsp-idle-network.slot.3", main);
    return [
      comparable(window.localStorage.getItem("dsp-idle-network.save.v1")),
      comparable(window.localStorage.getItem("dsp-idle-network.slot.1")),
      comparable(window.localStorage.getItem("dsp-idle-network.slot.2")),
      comparable(window.localStorage.getItem("dsp-idle-network.slot.3")),
    ];
  });
  await page.reload();
  await page.getByRole("button", { name: "登录与云存档" }).click();
  await page.getByRole("button", { name: "注册", exact: true }).click();
  await page.getByLabel("显示名称").fill("本地存档守护测试");
  await page.getByLabel("用户名", { exact: true }).fill("local_save_guard");
  await page.getByLabel("密码", { exact: true }).fill("strong-pass-123");
  await page.getByRole("button", { name: "创建云账户" }).click();
  await expect(page.locator(".start-menu-message")).toContainText("云存档与自动同步已开放");
  await expect(page.getByRole("button", { name: "上传本地存档" })).toBeEnabled();
  await page.getByLabel("退出云账户").click();
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByLabel("用户名或邮箱").fill("local_save_guard");
  await page.getByLabel("密码", { exact: true }).fill("strong-pass-123");
  await page.getByRole("button", { name: "登录云账户" }).click();
  await expect(page.locator(".start-menu-message")).toContainText("本地存档保持不变");
  const after = await page.evaluate(() => {
    const comparable = (raw: string | null) => {
      if (!raw) return null;
      const { savedAt: _savedAt, ...envelope } = JSON.parse(raw) as Record<string, unknown>;
      return envelope;
    };
    return [
      comparable(window.localStorage.getItem("dsp-idle-network.save.v1")),
      comparable(window.localStorage.getItem("dsp-idle-network.slot.1")),
      comparable(window.localStorage.getItem("dsp-idle-network.slot.2")),
      comparable(window.localStorage.getItem("dsp-idle-network.slot.3")),
    ];
  });
  expect(after).toEqual(before);
});

async function freshGame(page: Page) {
  await page.goto("/");
  await expect(page.getByTitle("重置当前工厂")).toHaveCount(0);
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".vein-node").filter({ hasText: "铁矿石" })).toBeVisible({ timeout: 15_000 });
}

async function enableCoarsePointer(page: Page) {
  await page.addInitScript(() => {
    const nativeMatchMedia = window.matchMedia.bind(window);
    window.matchMedia = ((query: string) => query === "(pointer: coarse)"
      ? {
          matches: true,
          media: query,
          onchange: null,
          addListener() {},
          removeListener() {},
          addEventListener() {},
          removeEventListener() {},
          dispatchEvent() { return true; },
        } as MediaQueryList
      : nativeMatchMedia(query)) as typeof window.matchMedia;
    Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: 5 });
  });
}

async function createTouchPage(browser: Browser, viewport: { width: number; height: number }) {
  const context = await browser.newContext({
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:4319",
    hasTouch: true,
    isMobile: true,
    viewport,
  });
  const page = await context.newPage();
  await installTestBootstrap(page);
  await enableCoarsePointer(page);
  return { context, page };
}

async function placeOnCanvas(page: Page, title: string, x: number, y: number) {
  await page.getByTitle(title).click();
  const canvas = page.locator(".react-flow__pane");
  await canvas.click({ position: { x, y } });
}

async function chooseRecipe(page: Page, scope: Locator, recipeName: string) {
  await scope.locator(".catalog-picker-trigger").click();
  const dialog = page.getByRole("dialog", { name: "配方选择面板" });
  await expect(dialog).toBeVisible();
  const viewport = page.viewportSize();
  if (viewport && viewport.width >= 900 && !(viewport.height < 560 && viewport.width < 1100)) {
    await expect(dialog.getByLabel("搜索配方")).toBeFocused();
  }
  await dialog.locator(".recipe-catalog-grid > button").filter({ hasText: recipeName }).first().click();
}

async function chooseItem(page: Page, scope: Locator, itemName: string) {
  await scope.locator(".catalog-picker-trigger").click();
  const dialog = page.getByRole("dialog", { name: "物品选择面板" });
  await expect(dialog).toBeVisible();
  const viewport = page.viewportSize();
  if (viewport && viewport.width >= 900 && !(viewport.height < 560 && viewport.width < 1100)) {
    await expect(dialog.getByLabel("搜索物品")).toBeFocused();
  }
  await dialog.locator(".item-catalog-grid > button").filter({ hasText: itemName }).first().click();
}

async function openSeededGame(page: Page) {
  await page.addInitScript(() => {
    const state = {
      version: 2,
      entities: [],
      belts: [],
      construction: {
        thermal_power_plant: 1,
        storage_mk1: 1,
        splitter_4way: 1,
        storage_tank: 1,
        oil_extractor: 1,
        oil_refinery: 1,
      },
      tray: { coal: 5 },
      totalProduced: {},
      research: { selectedTechId: null, progressByTech: {}, completedTechIds: ["basic_logistics", "thermal_power", "high_efficiency_plasma_control"] },
      paused: false,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openDisabledHammerGame(page: Page) {
  await page.addInitScript(() => {
    const state = {
      version: 28,
      nextId: 1,
      activePlanetId: "home",
      entities: [],
      belts: [],
      construction: {},
      tray: { iron_ore: 1 },
      planetTrays: { home: { iron_ore: 1 } },
      totalProduced: {},
      research: { selectedTechId: null, pausedTechId: null, queuedTechIds: [], progressByTech: {}, completedTechIds: [] },
      exploration: { unlockedSystemIds: ["helios"], colonizedPlanetIds: ["home"], missions: [], surveyProgressBySystem: { helios: 1 } },
      paused: false,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openYellowStageGame(page: Page) {
  await page.addInitScript(() => {
    const state = {
      version: 3,
      nextId: 3,
      entities: [
        {
          id: "entity_1",
          kind: "machine",
          position: { x: 160, y: -250 },
          buildingId: "chemical_plant",
          recipeId: "plastic",
          machineCount: 1,
          minerCount: 0,
          inputs: {},
          outputs: {},
          progress: 0,
          routingCursor: 0,
          utilization: 0,
          productionRate: 0,
        },
        {
          id: "entity_2",
          kind: "machine",
          position: { x: 160, y: 120 },
          buildingId: "matrix_lab",
          recipeId: "electromagnetic_matrix",
          machineCount: 1,
          minerCount: 0,
          inputs: {},
          outputs: {},
          progress: 0,
          routingCursor: 0,
          utilization: 0,
          productionRate: 0,
        },
      ],
      belts: [],
      construction: { water_pump: 1, chemical_plant: 0 },
      tray: {},
      totalProduced: {},
      research: {
        selectedTechId: null,
        queuedTechIds: [],
        progressByTech: {},
        completedTechIds: [
          "electromagnetic_matrix",
          "electromagnetism",
          "automatic_metallurgy",
          "basic_assembling",
          "basic_logistics",
          "high_speed_logistics",
          "thermal_power",
          "high_efficiency_plasma_control",
          "energy_matrix",
          "xray_cracking",
          "high_strength_crystal",
          "basic_chemical_engineering",
          "polymer_chemistry",
          "structure_matrix",
          "titanium_alloy",
          "processor",
          "planetary_logistics",
        ],
      },
      paused: false,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openInterstellarGame(page: Page) {
  await page.addInitScript(() => {
    const entityBase = {
      minerCount: 0,
      inputs: {},
      progress: 0,
      routingCursor: 0,
      utilization: 0,
      productionRate: 0,
    };
    const state = {
      version: 5,
      nextId: 5,
      activePlanetId: "home",
      entities: [
        { ...entityBase, id: "home_wind", kind: "power", planetId: "home", position: { x: 180, y: -180 }, buildingId: "wind_turbine", machineCount: 4, outputs: {} },
        { ...entityBase, id: "home_station", kind: "station", planetId: "home", position: { x: 180, y: 80 }, buildingId: "interstellar_logistics_station", machineCount: 1, storedItemId: "titanium_ingot", stationMode: "supply", stationProgress: 0.97, stationTrips: 0, stationLastTransfer: 0, stationVessels: 0, stationMinimumLoad: 1, outputs: { titanium_ingot: 140 } },
        { ...entityBase, id: "ashen_wind", kind: "power", planetId: "ashen", position: { x: 180, y: -180 }, buildingId: "wind_turbine", machineCount: 4, outputs: {} },
        { ...entityBase, id: "ashen_station", kind: "station", planetId: "ashen", position: { x: 180, y: 80 }, buildingId: "interstellar_logistics_station", machineCount: 1, storedItemId: "titanium_ingot", stationMode: "demand", stationProgress: 0.97, stationTrips: 0, stationLastTransfer: 0, stationVessels: 1, stationMinimumLoad: 1, outputs: {} },
      ],
      belts: [],
      construction: {},
      tray: { iron_ore: 3 },
      planetTrays: { home: { iron_ore: 3 }, ashen: { titanium_ore: 4 } },
      totalProduced: {},
      research: { selectedTechId: null, queuedTechIds: [], progressByTech: {}, completedTechIds: ["interstellar_logistics"] },
      paused: false,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openPurpleStageGame(page: Page) {
  await page.addInitScript(() => {
    const entityBase = {
      planetId: "home",
      machineCount: 1,
      minerCount: 0,
      inputs: {},
      outputs: {},
      progress: 0,
      routingCursor: 0,
      utilization: 0,
      productionRate: 0,
    };
    const state = {
      version: 5,
      nextId: 6,
      activePlanetId: "home",
      entities: [
        { ...entityBase, id: "purple_wind", kind: "power", position: { x: 170, y: -430 }, buildingId: "wind_turbine", machineCount: 8 },
        { ...entityBase, id: "purple_chemical", kind: "machine", position: { x: 170, y: -250 }, buildingId: "chemical_plant", recipeId: "graphene" },
        { ...entityBase, id: "purple_smelter", kind: "machine", position: { x: 470, y: -250 }, buildingId: "arc_smelter", recipeId: "crystal_silicon" },
        { ...entityBase, id: "purple_assembler", kind: "machine", position: { x: 170, y: 80 }, buildingId: "assembling_machine_mk1", recipeId: "particle_broadband" },
        { ...entityBase, id: "purple_lab", kind: "machine", position: { x: 470, y: 20 }, buildingId: "matrix_lab", recipeId: "information_matrix" },
      ],
      belts: [],
      construction: {},
      tray: { information_matrix: 7 },
      planetTrays: { home: { information_matrix: 7 }, ashen: {} },
      totalProduced: { information_matrix: 7 },
      research: {
        selectedTechId: null,
        queuedTechIds: [],
        progressByTech: {},
        completedTechIds: ["nanomaterials", "information_matrix", "interstellar_logistics"],
      },
      paused: false,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openGreenStageGame(page: Page) {
  await page.addInitScript(() => {
    const entityBase = {
      planetId: "home",
      machineCount: 1,
      minerCount: 0,
      inputs: {},
      outputs: {},
      progress: 0,
      routingCursor: 0,
      utilization: 0,
      productionRate: 0,
    };
    const state = {
      version: 5,
      nextId: 6,
      activePlanetId: "home",
      entities: [
        { ...entityBase, id: "green_wind", kind: "power", position: { x: 170, y: -440 }, buildingId: "wind_turbine", machineCount: 50 },
        { ...entityBase, id: "green_collider", kind: "machine", position: { x: 170, y: -250 }, buildingId: "miniature_particle_collider", recipeId: "deuterium" },
        { ...entityBase, id: "green_thermal", kind: "power", position: { x: 470, y: -250 }, buildingId: "thermal_power_plant", fuelItemId: "deuteron_fuel_rod", inputs: { deuteron_fuel_rod: 1 }, fuelRemainingMj: 0, powerOutputKw: 0 },
        { ...entityBase, id: "green_assembler", kind: "machine", position: { x: 170, y: 110 }, buildingId: "assembling_machine_mk1", recipeId: "quantum_chip" },
        { ...entityBase, id: "green_lab", kind: "machine", position: { x: 470, y: 20 }, buildingId: "matrix_lab", recipeId: "gravity_matrix" },
      ],
      belts: [],
      construction: {},
      tray: { gravity_matrix: 7 },
      planetTrays: { home: { gravity_matrix: 7 }, ashen: {} },
      totalProduced: { gravity_matrix: 7 },
      research: {
        selectedTechId: null,
        queuedTechIds: [],
        progressByTech: {},
        completedTechIds: ["miniature_particle_collider", "quantum_chip", "gravity_matrix", "research_speed_1"],
      },
      paused: false,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openWhiteStageGame(page: Page) {
  await page.addInitScript(() => {
    const entityBase = {
      planetId: "home",
      machineCount: 1,
      minerCount: 0,
      inputs: {},
      outputs: {},
      progress: 0,
      routingCursor: 0,
      utilization: 0,
      productionRate: 0,
    };
    const state = {
      version: 6,
      nextId: 7,
      activePlanetId: "home",
      entities: [
        { ...entityBase, id: "white_wind", kind: "power", position: { x: 120, y: -500 }, buildingId: "wind_turbine", machineCount: 50 },
        { ...entityBase, id: "white_ejector", kind: "machine", position: { x: 120, y: -260 }, buildingId: "em_rail_ejector", recipeId: "solar_sail_launch", inputs: { solar_sail: 2 } },
        { ...entityBase, id: "white_receiver", kind: "machine", position: { x: 430, y: -260 }, buildingId: "ray_receiver", recipeId: "critical_photon", outputs: { critical_photon: 2 }, powerOutputKw: 6000 },
        { ...entityBase, id: "white_collider", kind: "machine", position: { x: 120, y: 110 }, buildingId: "miniature_particle_collider", recipeId: "antimatter" },
        { ...entityBase, id: "white_assembler", kind: "machine", position: { x: 430, y: 110 }, buildingId: "assembling_machine_mk1", recipeId: "antimatter_fuel_rod" },
        { ...entityBase, id: "white_lab", kind: "machine", position: { x: 740, y: 20 }, buildingId: "matrix_lab", recipeId: "universe_matrix" },
      ],
      belts: [],
      construction: { em_rail_ejector: 1, ray_receiver: 1 },
      tray: { universe_matrix: 7 },
      planetTrays: { home: { universe_matrix: 7 }, ashen: {} },
      totalProduced: { critical_photon: 2, antimatter: 5, antimatter_fuel_rod: 1, universe_matrix: 7 },
      research: {
        selectedTechId: null,
        queuedTechIds: [],
        progressByTech: {},
        completedTechIds: [
          "gravity_matrix",
          "research_speed_1",
          "research_speed_2",
          "dyson_swarm",
          "ray_receiver",
          "antimatter",
          "universe_matrix",
        ],
      },
      dysonSwarm: {
        sailsInOrbit: 400,
        totalLaunched: 420,
        totalExpired: 20,
        decayProgress: 0,
        generationKw: 14400,
        receiverLoadKw: 6000,
      },
      paused: false,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openDysonSphereStageGame(page: Page) {
  await page.addInitScript(() => {
    const entityBase = {
      planetId: "home",
      machineCount: 1,
      minerCount: 0,
      inputs: {},
      outputs: {},
      progress: 0,
      routingCursor: 0,
      utilization: 0,
      productionRate: 0,
    };
    const state = {
      version: 7,
      nextId: 7,
      activePlanetId: "home",
      entities: [
        { ...entityBase, id: "sphere_wind", kind: "power", position: { x: 100, y: -500 }, buildingId: "wind_turbine", machineCount: 60 },
        { ...entityBase, id: "sphere_receiver", kind: "machine", position: { x: 400, y: -500 }, buildingId: "ray_receiver", recipeId: "ray_power", powerOutputKw: 6000 },
        { ...entityBase, id: "sphere_frame", kind: "machine", position: { x: 100, y: -190 }, buildingId: "assembling_machine_mk1", recipeId: "frame_material" },
        { ...entityBase, id: "sphere_component", kind: "machine", position: { x: 400, y: -190 }, buildingId: "assembling_machine_mk1", recipeId: "dyson_sphere_component" },
        { ...entityBase, id: "sphere_rocket", kind: "machine", position: { x: -170, y: 180 }, buildingId: "assembling_machine_mk1", recipeId: "small_carrier_rocket" },
        { ...entityBase, id: "sphere_silo", kind: "machine", position: { x: 130, y: 180 }, buildingId: "vertical_launching_silo", recipeId: "carrier_rocket_launch" },
      ],
      belts: [],
      construction: { vertical_launching_silo: 1 },
      tray: { frame_material: 5, dyson_sphere_component: 3, small_carrier_rocket: 2 },
      planetTrays: { home: { frame_material: 5, dyson_sphere_component: 3, small_carrier_rocket: 2 }, ashen: {} },
      totalProduced: { frame_material: 5, dyson_sphere_component: 3, small_carrier_rocket: 2 },
      research: {
        selectedTechId: null,
        queuedTechIds: [],
        progressByTech: {},
        completedTechIds: [
          "universe_matrix",
          "dyson_swarm",
          "ray_receiver",
          "dyson_sphere_program",
          "vertical_launching_silo",
        ],
      },
      dysonSwarm: {
        sailsInOrbit: 0,
        totalLaunched: 400,
        totalExpired: 100,
        decayProgress: 0,
        generationKw: 0,
        receiverLoadKw: 6000,
      },
      dysonSphere: {
        structurePoints: 30,
        totalRocketsLaunched: 30,
        shellSails: 300,
        totalSailsAbsorbed: 300,
        absorptionProgress: 0,
        generationKw: 39600,
      },
      paused: true,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openEndgameStageGame(page: Page) {
  await page.addInitScript(() => {
    const state = {
      version: 22,
      nextId: 1,
      activePlanetId: "home",
      entities: [],
      belts: [],
      construction: {},
      tray: {
        universe_matrix: 2_200,
        solar_sail: 6_000,
        small_carrier_rocket: 1_200,
        antimatter_fuel_rod: 600,
      },
      planetTrays: {
        home: {
          universe_matrix: 2_200,
          solar_sail: 6_000,
          small_carrier_rocket: 1_200,
          antimatter_fuel_rod: 600,
        },
        ashen: {},
      },
      totalProduced: {},
      research: {
        selectedTechId: null,
        queuedTechIds: [],
        progressByTech: {},
        completedTechIds: ["universe_matrix"],
      },
      paused: true,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openHandcraftGame(page: Page) {
  await page.addInitScript(() => {
    const state = {
      version: 7,
      nextId: 1,
      activePlanetId: "home",
      entities: [],
      belts: [],
      construction: {},
      tray: {
        iron_ore: 2,
        copper_ore: 2,
        stone: 2,
        magnet: 20,
        copper_ingot: 10,
        iron_ingot: 20,
        carbon_nanotube: 4,
        titanium_alloy: 1,
        high_purity_silicon: 1,
      },
      planetTrays: {
        home: { iron_ore: 2, copper_ore: 2, stone: 2, magnet: 20, copper_ingot: 10, iron_ingot: 20, carbon_nanotube: 4, titanium_alloy: 1, high_purity_silicon: 1 },
        ashen: {},
      },
      totalProduced: {},
      research: {
        selectedTechId: null,
        queuedTechIds: [],
        progressByTech: {},
        completedTechIds: ["dyson_sphere_program"],
      },
      dysonSwarm: { sailsInOrbit: 0, totalLaunched: 0, totalExpired: 0, decayProgress: 0, generationKw: 0, receiverLoadKw: 0 },
      dysonSphere: { structurePoints: 0, totalRocketsLaunched: 0, shellSails: 0, totalSailsAbsorbed: 0, absorptionProgress: 0, generationKw: 0 },
      paused: false,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openUpgradeStageGame(page: Page) {
  await page.addInitScript(() => {
    const entityBase = {
      planetId: "home",
      machineCount: 1,
      minerCount: 0,
      inputs: {},
      outputs: {},
      progress: 0.4,
      routingCursor: 0,
      utilization: 0,
      productionRate: 0,
    };
    const state = {
      version: 8,
      nextId: 3,
      activePlanetId: "home",
      entities: [
        { ...entityBase, id: "upgrade_storage", kind: "storage", position: { x: -120, y: 0 }, buildingId: "storage_mk1", storedItemId: "iron_ingot", outputs: { iron_ingot: 20 } },
        { ...entityBase, id: "upgrade_assembler", kind: "machine", position: { x: 260, y: 0 }, buildingId: "assembling_machine_mk1", recipeId: "gear", inputs: { iron_ingot: 3 }, outputs: { gear: 2 } },
      ],
      belts: [{ id: "upgrade_belt", planetId: "home", source: "upgrade_storage", target: "upgrade_assembler", itemId: "iron_ingot", lanes: 1, tier: 1, progress: 0.5, priority: 0, lastFlow: 3 }],
      construction: { assembling_machine_mk2: 1, conveyor_belt_mk2: 1 },
      tray: {},
      planetTrays: { home: {}, ashen: {} },
      totalProduced: {},
      research: {
        selectedTechId: null,
        queuedTechIds: [],
        progressByTech: {},
        completedTechIds: ["high_speed_assembling", "high_speed_logistics"],
      },
      paused: true,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openResearchLineRegressionGame(page: Page) {
  await page.addInitScript(() => {
    const entityBase = {
      planetId: "home",
      machineCount: 1,
      minerCount: 0,
      inputs: {},
      outputs: {},
      progress: 0,
      routingCursor: 0,
      utilization: 0,
      productionRate: 0,
    };
    const state = {
      version: 8,
      nextId: 5,
      activePlanetId: "home",
      entities: [
        { ...entityBase, id: "research_wind", kind: "power", position: { x: -360, y: -230 }, buildingId: "wind_turbine", machineCount: 2 },
        { ...entityBase, id: "blue_storage", kind: "storage", position: { x: -300, y: -20 }, buildingId: "storage_mk1", storedItemId: "electromagnetic_matrix" },
        { ...entityBase, id: "red_storage", kind: "storage", position: { x: -300, y: 240 }, buildingId: "storage_mk1", storedItemId: "energy_matrix" },
        { ...entityBase, id: "research_lab", kind: "machine", position: { x: 180, y: 80 }, buildingId: "matrix_lab", recipeId: "matrix_research", inputs: { energy_matrix: 1 }, progress: 0.98 },
      ],
      belts: [
        { id: "blue_research_belt", planetId: "home", source: "blue_storage", target: "research_lab", itemId: "electromagnetic_matrix", lanes: 1, tier: 1, progress: 0, priority: 0, lastFlow: 0 },
        { id: "red_research_belt", planetId: "home", source: "red_storage", target: "research_lab", itemId: "energy_matrix", lanes: 1, tier: 1, progress: 0, priority: 0, lastFlow: 0 },
      ],
      construction: {},
      tray: {},
      planetTrays: { home: {}, ashen: {} },
      totalProduced: {},
      research: {
        selectedTechId: "xray_cracking",
        queuedTechIds: [],
        progressByTech: { xray_cracking: { electromagnetic_matrix: 10, energy_matrix: 9 } },
        completedTechIds: ["electromagnetic_matrix", "energy_matrix"],
      },
      paused: false,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openHandCarryGame(page: Page) {
  await page.addInitScript(() => {
    const state = {
      version: 8,
      nextId: 1,
      activePlanetId: "home",
      entities: [],
      belts: [],
      construction: {},
      tray: { titanium_ingot: 40 },
      planetTrays: { home: { titanium_ingot: 40 }, ashen: {} },
      totalProduced: {},
      research: { selectedTechId: null, queuedTechIds: [], progressByTech: {}, completedTechIds: [] },
      paused: true,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openProliferatorStageGame(page: Page) {
  await page.addInitScript(() => {
    const entityBase = {
      planetId: "home",
      minerCount: 0,
      progress: 0,
      routingCursor: 0,
      utilization: 0,
      productionRate: 0,
    };
    const state = {
      version: 9,
      nextId: 4,
      activePlanetId: "home",
      entities: [
        { ...entityBase, id: "spray_wind", kind: "power", position: { x: -260, y: -820 }, buildingId: "wind_turbine", machineCount: 3, inputs: {}, outputs: {} },
        { ...entityBase, id: "spray_storage", kind: "storage", position: { x: -260, y: -560 }, buildingId: "storage_mk1", storedItemId: "proliferator_mk3", machineCount: 1, inputs: {}, outputs: { proliferator_mk3: 5 } },
        { ...entityBase, id: "spray_assembler", kind: "machine", position: { x: 180, y: -560 }, buildingId: "assembling_machine_mk1", recipeId: "gear", machineCount: 1, inputs: { iron_ingot: 20 }, outputs: {} },
      ],
      belts: [],
      construction: { spray_coater: 1, conveyor_belt_mk1: 1 },
      tray: {},
      planetTrays: { home: {}, ashen: {} },
      totalProduced: {},
      research: {
        selectedTechId: null,
        queuedTechIds: [],
        progressByTech: {},
        completedTechIds: ["proliferator_1", "proliferator_2", "proliferator_3"],
      },
      paused: true,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openChemicalRoutingGame(page: Page) {
  await page.addInitScript(() => {
    const entityBase = {
      planetId: "home",
      machineCount: 1,
      minerCount: 0,
      inputs: {},
      progress: 0,
      routingCursor: 0,
      utilization: 0,
      productionRate: 0,
    };
    const state = {
      version: 10,
      nextId: 5,
      activePlanetId: "home",
      entities: [
        { ...entityBase, id: "plastic_source", kind: "machine", position: { x: 250, y: -430 }, buildingId: "chemical_plant", recipeId: "plastic", outputs: { plastic: 20 } },
        { ...entityBase, id: "oil_source", kind: "machine", position: { x: 250, y: -150 }, buildingId: "oil_refinery", recipeId: "plasma_refining", outputs: { refined_oil: 20 } },
        { ...entityBase, id: "water_source", kind: "vein", position: { x: 250, y: 130 }, resourceId: "water", outputs: { water: 20 } },
        { ...entityBase, id: "organic_chemical", kind: "machine", position: { x: 720, y: -150 }, buildingId: "chemical_plant", recipeId: "plastic", outputs: {} },
      ],
      belts: [],
      construction: { conveyor_belt_mk1: 3 },
      tray: {},
      planetTrays: { home: {}, ashen: {}, giant: {} },
      totalProduced: {},
      research: { selectedTechId: null, queuedTechIds: [], progressByTech: {}, completedTechIds: ["high_efficiency_plasma_control", "basic_chemical_engineering", "polymer_chemistry"] },
      paused: false,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openDysonPlannerGame(page: Page) {
  await page.addInitScript(() => {
    const state = {
      version: 14,
      nextId: 1,
      activePlanetId: "home",
      entities: [],
      belts: [],
      construction: {},
      tray: {},
      planetTrays: { home: {}, ashen: {}, giant: {}, frost: {}, boreal_giant: {}, magnetar: {} },
      totalProduced: {},
      research: {
        selectedTechId: null,
        queuedTechIds: [],
        progressByTech: {},
        completedTechIds: ["dyson_sphere_program", "dyson_shell", "dyson_swarm"],
      },
      exploration: { unlockedSystemIds: ["helios", "borealis"] },
      blueprints: [],
      dysonSwarm: { sailsInOrbit: 0, totalLaunched: 0, totalExpired: 0, decayProgress: 0, generationKw: 0, receiverLoadKw: 0 },
      dysonSphere: { structurePoints: 32, totalRocketsLaunched: 32, shellSails: 0, totalSailsAbsorbed: 0, absorptionProgress: 0, generationKw: 30_720 },
      paused: true,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openTechnologyUpgradeGame(page: Page) {
  await page.addInitScript(() => {
    const entityBase = {
      planetId: "home",
      machineCount: 1,
      minerCount: 0,
      inputs: {},
      outputs: {},
      progress: 0,
      routingCursor: 0,
      utilization: 0,
      productionRate: 0,
    };
    const state = {
      version: 15,
      nextId: 3,
      activePlanetId: "home",
      entities: [
        { ...entityBase, id: "upgrade_station", kind: "station", position: { x: -180, y: 0 }, buildingId: "planetary_logistics_station", storedItemId: "processor", stationMode: "demand", stationDrones: 1, stationVessels: 0, stationProgress: 0, stationTrips: 0, stationLastTransfer: 0, stationMinimumLoad: 0.5 },
        { ...entityBase, id: "upgrade_receiver", kind: "machine", position: { x: 280, y: 0 }, buildingId: "ray_receiver", recipeId: "ray_power", powerOutputKw: 0 },
      ],
      belts: [],
      construction: {},
      tray: {},
      planetTrays: { home: {}, ashen: {}, giant: {}, frost: {}, boreal_giant: {}, magnetar: {} },
      totalProduced: {},
      research: {
        selectedTechId: null,
        queuedTechIds: [],
        progressByTech: {},
        completedTechIds: [
          "mining_speed_1", "mining_speed_2", "mining_speed_3",
          "research_speed_1", "research_speed_2", "research_speed_3",
          "logistics_engine_1", "logistics_engine_2",
          "logistics_capacity_1", "logistics_capacity_2",
          "solar_sail_life_1", "solar_sail_life_2",
          "ray_transmission_1", "ray_transmission_2", "dyson_absorption_1",
          "planetary_logistics", "ray_receiver", "dyson_swarm", "dyson_shell",
        ],
      },
      exploration: { unlockedSystemIds: ["helios"] },
      blueprints: [],
      dysonSwarm: { sailsInOrbit: 0, totalLaunched: 0, totalExpired: 0, decayProgress: 0, generationKw: 0, receiverLoadKw: 0 },
      dysonSphere: { structurePoints: 0, totalRocketsLaunched: 0, shellSails: 0, totalSailsAbsorbed: 0, absorptionProgress: 0, generationKw: 0 },
      paused: true,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openCompleteLogisticsGame(page: Page) {
  await page.addInitScript(() => {
    const entityBase = {
      machineCount: 1,
      minerCount: 0,
      inputs: {},
      outputs: {},
      progress: 0,
      routingCursor: 0,
      utilization: 0,
      productionRate: 0,
    };
    const state = {
      version: 10,
      nextId: 9,
      activePlanetId: "home",
      entities: [
        { ...entityBase, id: "logistics_wind", kind: "power", planetId: "home", position: { x: -420, y: -500 }, buildingId: "wind_turbine", machineCount: 10 },
        { ...entityBase, id: "local_supply", kind: "station", planetId: "home", position: { x: -380, y: -170 }, buildingId: "planetary_logistics_station", storedItemId: "iron_ingot", stationMode: "supply", stationProgress: 0.96, stationTrips: 0, stationLastTransfer: 0, stationDrones: 0, stationMinimumLoad: 0.5, outputs: { iron_ingot: 100 } },
        { ...entityBase, id: "local_demand", kind: "station", planetId: "home", position: { x: 10, y: -170 }, buildingId: "planetary_logistics_station", storedItemId: "iron_ingot", stationMode: "demand", stationProgress: 0.96, stationTrips: 0, stationLastTransfer: 0, stationDrones: 2, stationMinimumLoad: 0.5 },
        { ...entityBase, id: "hydrogen_demand", kind: "station", planetId: "home", position: { x: 400, y: -170 }, buildingId: "interstellar_logistics_station", storedItemId: "hydrogen", stationMode: "demand", stationProgress: 0.98, stationTrips: 0, stationLastTransfer: 0, stationVessels: 1, stationWarpers: 2, stationWarpEnabled: true, stationMinimumLoad: 0.1 },
        { ...entityBase, id: "sorter_storage", kind: "storage", planetId: "home", position: { x: -210, y: 240 }, buildingId: "storage_mk1", storedItemId: "iron_ore", outputs: { iron_ore: 20 } },
        { ...entityBase, id: "sorter_smelter", kind: "machine", planetId: "home", position: { x: 190, y: 240 }, buildingId: "arc_smelter", recipeId: "iron_ingot" },
        { ...entityBase, id: "ashen_station", kind: "station", planetId: "ashen", position: { x: 0, y: 0 }, buildingId: "interstellar_logistics_station", stationProgress: 0, stationTrips: 0, stationLastTransfer: 0, stationDrones: 0, stationVessels: 0, stationWarpers: 0 },
        { ...entityBase, id: "giant_collector", kind: "station", planetId: "giant", position: { x: 0, y: 0 }, buildingId: "orbital_collector", storedItemId: "hydrogen", stationMode: "supply", stationProgress: 0, stationTrips: 0, stationLastTransfer: 0, outputs: { hydrogen: 100 } },
      ],
      belts: [{ id: "sorter_demo", planetId: "home", source: "sorter_storage", target: "sorter_smelter", itemId: "iron_ore", lanes: 1, tier: 2, sorterTier: 1, progress: 0, priority: 0, lastFlow: 0 }],
      construction: { sorter_mk2: 1 },
      tray: { space_warper: 1, logistics_drone: 3, logistics_vessel: 2 },
      planetTrays: { home: { space_warper: 1, logistics_drone: 3, logistics_vessel: 2 }, ashen: {}, giant: {} },
      totalProduced: {},
      research: {
        selectedTechId: null,
        queuedTechIds: [],
        progressByTech: {},
        completedTechIds: ["planetary_logistics", "interstellar_logistics", "space_warp", "high_speed_logistics"],
      },
      paused: true,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openCompleteEnergyGame(page: Page) {
  await page.addInitScript(() => {
    const entityBase = {
      machineCount: 1,
      minerCount: 0,
      inputs: {},
      outputs: {},
      progress: 0,
      routingCursor: 0,
      utilization: 0,
      productionRate: 0,
      powerInputKw: 0,
      powerOutputKw: 0,
    };
    const emptyMetrics = {
      generationKw: 0,
      demandKw: 0,
      powerFactor: 1,
      windGenerationKw: 0,
      solarGenerationKw: 0,
      geothermalGenerationKw: 0,
      thermalGenerationKw: 0,
      fusionGenerationKw: 0,
      artificialStarGenerationKw: 0,
      rayGenerationKw: 0,
      storageDischargeKw: 0,
      storageChargeKw: 0,
      storedEnergyMj: 0,
      storageCapacityMj: 0,
      fuelReserveSeconds: 0,
      totalItemsPerMinute: 0,
    };
    const homeMetrics = {
      ...emptyMetrics,
      generationKw: 88620,
      demandKw: 20000,
      solarGenerationKw: 720,
      fusionGenerationKw: 3324,
      artificialStarGenerationKw: 15956,
      storedEnergyMj: 45,
      storageCapacityMj: 180,
      fuelReserveSeconds: 61,
    };
    const state = {
      version: 11,
      nextId: 8,
      activePlanetId: "home",
      entities: [
        { ...entityBase, id: "energy_solar", kind: "power", planetId: "home", position: { x: 320, y: -500 }, buildingId: "solar_panel", machineCount: 2, powerOutputKw: 720, utilization: 1 },
        { ...entityBase, id: "energy_accumulator", kind: "power", planetId: "home", position: { x: 680, y: -500 }, buildingId: "accumulator", storedEnergyMj: 45, energyMode: "auto", progress: 0.5 },
        { ...entityBase, id: "energy_exchanger", kind: "power", planetId: "home", position: { x: 1040, y: -500 }, buildingId: "energy_exchanger", recipeId: "accumulator_charge", energyMode: "charge", storedEnergyMj: 0, inputs: { accumulator: 1 } },
        { ...entityBase, id: "energy_fusion", kind: "power", planetId: "home", position: { x: 520, y: -100 }, buildingId: "mini_fusion_power_plant", fuelItemId: "deuteron_fuel_rod", fuelRemainingMj: 200, inputs: { deuteron_fuel_rod: 1 }, powerOutputKw: 3324, utilization: 0.2216 },
        { ...entityBase, id: "energy_star", kind: "power", planetId: "home", position: { x: 900, y: -100 }, buildingId: "artificial_star", fuelItemId: "antimatter_fuel_rod", fuelRemainingMj: 3600, inputs: { antimatter_fuel_rod: 1 }, powerOutputKw: 15956, utilization: 0.2216 },
        { ...entityBase, id: "ashen_solar", kind: "power", planetId: "ashen", position: { x: 520, y: -320 }, buildingId: "solar_panel", powerOutputKw: 540, utilization: 1 },
        { ...entityBase, id: "ashen_geothermal", kind: "power", planetId: "ashen", position: { x: 900, y: -320 }, buildingId: "geothermal_power_station", powerOutputKw: 4800, utilization: 1 },
      ],
      belts: [],
      construction: { solar_panel: 1, geothermal_power_station: 1, thermal_power_plant: 1, mini_fusion_power_plant: 1, artificial_star: 1, accumulator: 1, energy_exchanger: 1 },
      tray: {},
      planetTrays: { home: {}, ashen: {}, giant: {} },
      totalProduced: {},
      metrics: homeMetrics,
      planetMetrics: {
        home: homeMetrics,
        ashen: { ...emptyMetrics, generationKw: 5340, solarGenerationKw: 540, geothermalGenerationKw: 4800 },
        giant: emptyMetrics,
      },
      research: {
        selectedTechId: null,
        queuedTechIds: [],
        progressByTech: {},
        completedTechIds: ["solar_energy", "energy_storage", "geothermal_power", "miniature_particle_collider", "fusion_power", "antimatter", "artificial_star"],
      },
      paused: true,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openRareResourceStageGame(page: Page) {
  await page.addInitScript(() => {
    const entityBase = {
      planetId: "home",
      machineCount: 1,
      minerCount: 0,
      inputs: {},
      outputs: {},
      progress: 0,
      routingCursor: 0,
      utilization: 0,
      productionRate: 0,
    };
    const state = {
      version: 12,
      nextId: 9,
      activePlanetId: "home",
      entities: [
        { ...entityBase, id: "rare_wind", kind: "power", position: { x: 300, y: -620 }, buildingId: "wind_turbine", machineCount: 20, powerOutputKw: 6000 },
        { ...entityBase, id: "rare_fractionator", kind: "machine", position: { x: 300, y: -300 }, buildingId: "fractionator", recipeId: "deuterium_fractionation", inputs: { hydrogen: 20 } },
        { ...entityBase, id: "rare_chemical", kind: "machine", position: { x: 650, y: -300 }, buildingId: "chemical_plant", recipeId: "graphene_from_fire_ice", inputs: { fire_ice: 4 } },
        { ...entityBase, id: "rare_quantum", kind: "machine", position: { x: 1000, y: -300 }, buildingId: "quantum_chemical_plant", recipeId: "carbon_nanotube_from_spiniform", inputs: { spiniform_stalagmite_crystal: 12 } },
        { ...entityBase, id: "rare_smelter", kind: "machine", position: { x: 300, y: 90 }, buildingId: "arc_smelter", recipeId: "diamond_from_kimberlite", inputs: { kimberlite_ore: 2 } },
        { ...entityBase, id: "rare_assembler", kind: "machine", position: { x: 650, y: 90 }, buildingId: "assembling_machine_mk1", recipeId: "particle_container_from_unipolar", inputs: { unipolar_magnet: 20, copper_ingot: 4 } },
        { ...entityBase, id: "rare_thermal", kind: "power", position: { x: 1000, y: 90 }, buildingId: "thermal_power_plant", fuelItemId: "hydrogen_fuel_rod", fuelRemainingMj: 27, inputs: { hydrogen_fuel_rod: 2 }, powerInputKw: 0, powerOutputKw: 0 },
        { ...entityBase, id: "rare_collector", kind: "station", planetId: "giant", position: { x: 0, y: 0 }, buildingId: "orbital_collector", storedItemId: "fire_ice", stationMode: "supply", stationProgress: 0, stationTrips: 0, stationLastTransfer: 0, outputs: { fire_ice: 25 } },
      ],
      belts: [],
      construction: { quantum_chemical_plant: 1, fractionator: 1, conveyor_belt_mk1: 6 },
      tray: { hydrogen_fuel_rod: 2 },
      planetTrays: { home: { hydrogen_fuel_rod: 2 }, ashen: {}, giant: {} },
      totalProduced: { hydrogen_fuel_rod: 2, fire_ice: 25 },
      research: {
        selectedTechId: null,
        queuedTechIds: [],
        progressByTech: {},
        completedTechIds: ["fractionation", "nanomaterials", "quantum_chip", "interstellar_logistics", "rare_resource_utilization", "gravity_matrix", "quantum_chemical_engineering"],
      },
      paused: true,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openStellarExplorationGame(page: Page, advancedOnboarding = false) {
  await page.addInitScript((withAdvancedOnboarding) => {
    const entityBase = {
      machineCount: 1,
      minerCount: 0,
      inputs: {},
      outputs: {},
      progress: 0,
      routingCursor: 0,
      utilization: 0,
      productionRate: 0,
    };
    const state = {
      version: 13,
      nextId: 5,
      activePlanetId: "home",
      entities: [
        { ...entityBase, id: "stellar_home_wind", kind: "power", planetId: "home", position: { x: -300, y: -220 }, buildingId: "wind_turbine", machineCount: 4 },
        { ...entityBase, id: "stellar_demand", kind: "station", planetId: "home", position: { x: 160, y: -100 }, buildingId: "interstellar_logistics_station", storedItemId: "optical_grating_crystal", stationMode: "demand", stationProgress: 0.96, stationTrips: 0, stationLastTransfer: 0, stationVessels: 1, stationWarpers: 1, stationWarpEnabled: true, stationMinimumLoad: 0.1 },
        { ...entityBase, id: "stellar_frost_wind", kind: "power", planetId: "frost", position: { x: -300, y: -220 }, buildingId: "wind_turbine", machineCount: 4 },
        { ...entityBase, id: "stellar_supply", kind: "station", planetId: "frost", position: { x: 160, y: -100 }, buildingId: "interstellar_logistics_station", storedItemId: "optical_grating_crystal", stationMode: "supply", stationProgress: 0.96, stationTrips: 0, stationLastTransfer: 0, stationVessels: 0, stationWarpers: 0, stationWarpEnabled: true, stationMinimumLoad: 0.1, outputs: { optical_grating_crystal: 20 } },
        ...(withAdvancedOnboarding ? [
          { ...entityBase, id: "onboarding_iron", kind: "vein", planetId: "home", position: { x: -520, y: 220 }, resourceId: "iron_ore", minerCount: 1, outputs: { iron_ore: 0 } },
          { ...entityBase, id: "onboarding_smelter", kind: "machine", planetId: "home", position: { x: -160, y: 220 }, buildingId: "arc_smelter", recipeId: "iron_ingot" },
        ] : []),
      ],
      belts: withAdvancedOnboarding ? [{ id: "onboarding_belt", planetId: "home", source: "onboarding_iron", target: "onboarding_smelter", itemId: "iron_ore", lanes: 1, tier: 1, sorterTier: 1, progress: 0, priority: 0, lastFlow: 0 }] : [],
      construction: {},
      tray: { space_warper: 7, information_matrix: 10, gravity_matrix: 20, titanium_ingot: 12 },
      planetTrays: { home: { space_warper: 7, information_matrix: 10, gravity_matrix: 20, titanium_ingot: 12 }, ashen: {}, giant: {}, frost: {}, boreal_giant: {}, magnetar: {} },
      totalProduced: withAdvancedOnboarding ? { electromagnetic_matrix: 1, refined_oil: 1, plastic: 1, energy_matrix: 1, structure_matrix: 1 } : {},
      manualMined: withAdvancedOnboarding ? 1 : 0,
      research: {
        selectedTechId: withAdvancedOnboarding ? "electromagnetic_matrix" : null,
        queuedTechIds: [],
        progressByTech: {},
        completedTechIds: ["space_warp", "rare_resource_utilization", "stellar_exploration"],
      },
      exploration: { unlockedSystemIds: ["helios"] },
      paused: true,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
    if (withAdvancedOnboarding) {
      window.localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({
        version: 1,
        completedEvents: ["cargo-stowed", "construction-crafted", "building-placed", "building-stacked", "belt-connected", "research-selected"],
        skipped: false,
      }));
    }
  }, advancedOnboarding);
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openBlueprintStageGame(page: Page) {
  await page.addInitScript(() => {
    const entityBase = {
      planetId: "home",
      machineCount: 1,
      minerCount: 0,
      inputs: {},
      outputs: {},
      progress: 0,
      routingCursor: 0,
      utilization: 0,
      productionRate: 0,
    };
    const state = {
      version: 14,
      nextId: 4,
      activePlanetId: "home",
      entities: [
        { ...entityBase, id: "blueprint_source", kind: "machine", position: { x: -300, y: -120 }, buildingId: "assembling_machine_mk1", recipeId: "circuit_board", outputs: { circuit_board: 12 } },
        { ...entityBase, id: "blueprint_target", kind: "machine", position: { x: 80, y: -120 }, buildingId: "assembling_machine_mk1", recipeId: "processor" },
      ],
      belts: [{ id: "blueprint_line", planetId: "home", source: "blueprint_source", target: "blueprint_target", itemId: "circuit_board", lanes: 1, tier: 1, sorterTier: 1, progress: 0, priority: 0, lastFlow: 0 }],
      construction: { assembling_machine_mk1: 2, assembling_machine_mk2: 2, conveyor_belt_mk1: 1, conveyor_belt_mk2: 2 },
      tray: {},
      planetTrays: { home: {}, ashen: {}, giant: {}, frost: {}, boreal_giant: {}, magnetar: {} },
      totalProduced: {},
      research: { selectedTechId: null, queuedTechIds: [], progressByTech: {}, completedTechIds: ["processor", "high_speed_assembling", "high_speed_logistics"] },
      exploration: { unlockedSystemIds: ["helios"] },
      blueprints: [],
      paused: true,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
  await expect(page.locator(".machine-node")).toHaveCount(2);
}

async function openStressStageGame(page: Page) {
  await page.addInitScript(() => {
    const entities = Array.from({ length: 500 }, (_, index) => ({
      id: `stress_device_${index}`,
      kind: "storage",
      planetId: "home",
      position: { x: index % 25 * 280 - 700, y: Math.floor(index / 25) * 220 - 360 },
      buildingId: "storage_mk1",
      storedItemId: "iron_ingot",
      machineCount: 1,
      minerCount: 0,
      inputs: { iron_ingot: 0 },
      outputs: { iron_ingot: index % 2 === 0 ? 1_000 : 0 },
      progress: 0,
      routingCursor: 0,
      utilization: 0,
      productionRate: 0,
    }));
    const belts = Array.from({ length: 1_000 }, (_, index) => ({
      id: `stress_belt_${index}`,
      planetId: "home",
      source: `stress_device_${index % 500}`,
      target: `stress_device_${(index + 1) % 500}`,
      itemId: "iron_ingot",
      lanes: 1,
      tier: 1,
      sorterTier: 1,
      progress: 0,
      priority: index % 2,
      lastFlow: 0,
    }));
    const state = {
      version: 18,
      nextId: 2_000,
      activePlanetId: "home",
      entities,
      belts,
      construction: { wind_turbine: 1 },
      tray: {},
      planetTrays: { home: {}, ashen: {}, giant: {}, frost: {}, boreal_giant: {}, magnetar: {} },
      totalProduced: {},
      research: { selectedTechId: null, queuedTechIds: [], progressByTech: {}, completedTechIds: [] },
      exploration: { unlockedSystemIds: ["helios"] },
      blueprints: [],
      paused: false,
      settings: { simulationSpeed: 1, performanceMode: true, reducedMotion: true, soundEnabled: false, autosaveIntervalSeconds: 300 },
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openOperationsStageGame(page: Page) {
  await page.addInitScript(() => {
    if (window.localStorage.getItem("dsp-idle-network.save.v1")) return;
    const state = {
      version: 16,
      nextId: 2,
      activePlanetId: "home",
      entities: [{
        id: "operations_iron",
        kind: "vein",
        planetId: "home",
        position: { x: -220, y: -80 },
        resourceId: "iron_ore",
        extractorBuildingId: "mining_machine",
        machineCount: 0,
        minerCount: 1,
        inputs: {},
        outputs: { iron_ore: 0 },
        progress: 0,
        routingCursor: 0,
        utilization: 0,
        productionRate: 0,
      }],
      belts: [],
      construction: {},
      tray: {},
      totalProduced: { electromagnetic_matrix: 1 },
      manualMined: 1,
      research: { selectedTechId: null, queuedTechIds: [], progressByTech: {}, completedTechIds: [] },
      exploration: { unlockedSystemIds: ["helios"] },
      paused: false,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now() + 60_000, state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openConstructionAutomationGame(page: Page) {
  await page.addInitScript(() => {
    const base = {
      planetId: "home",
      machineCount: 1,
      minerCount: 0,
      inputs: {},
      outputs: {},
      progress: 0,
      routingCursor: 0,
      utilization: 0,
      productionRate: 0,
      powerGridId: "grid-a",
    };
    const state = {
      version: 26,
      nextId: 4,
      activePlanetId: "home",
      entities: [
        { ...base, id: "automation_wind", kind: "power", position: { x: -420, y: -220 }, buildingId: "wind_turbine", machineCount: 60 },
        { ...base, id: "automation_center", kind: "machine", position: { x: 0, y: -120 }, buildingId: "construction_center" },
        {
          ...base,
          id: "delivery_hub",
          kind: "storage",
          position: { x: 420, y: 100 },
          buildingId: "material_delivery_hub",
          deliveryItemIds: ["iron_ingot", "copper_ingot", "stone_brick"],
          inputs: { iron_ingot: 5, copper_ingot: 5, stone_brick: 5 },
        },
      ],
      belts: [],
      construction: { wind_turbine: 0, construction_center: 0, material_delivery_hub: 0, arc_smelter: 0 },
      tray: { iron_ingot: 8, stone_brick: 4, circuit_board: 8, magnetic_coil: 4 },
      planetTrays: { home: { iron_ingot: 8, stone_brick: 4, circuit_board: 8, magnetic_coil: 4 } },
      totalProduced: {},
      research: {
        selectedTechId: null,
        queuedTechIds: [],
        progressByTech: {},
        completedTechIds: ["electromagnetic_matrix", "energy_matrix", "structure_matrix", "information_matrix", "construction_automation", "material_delivery_logistics"],
      },
      constructionAutomation: { enabled: true, targetStock: {}, cursor: 0, totalCrafted: 0, lastCraftedId: null },
      exploration: { unlockedSystemIds: ["helios"], colonizedPlanetIds: ["home"] },
      paused: false,
      settings: { simulationSpeed: 1, performanceMode: false, reducedMotion: false, soundEnabled: false, autosaveIntervalSeconds: 300, fontScale: 1 },
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openCampaignEndgameStageGame(page: Page) {
  await page.addInitScript(() => {
    const completedTaskIds = [
      "mine_first_ore", "smelt_iron", "deploy_miner", "lay_first_belt", "deploy_matrix_lab", "produce_blue_matrix",
      "refine_oil", "produce_plastic", "produce_red_matrix", "deploy_planetary_station", "complete_planetary_trip",
      "produce_structure_matrix", "unlock_borealis", "deploy_interstellar_station", "complete_interstellar_trip",
      "produce_information_matrix", "produce_gravity_matrix", "produce_universe_matrix", "launch_solar_sail",
      "launch_carrier_rocket", "build_dyson_structure", "absorb_shell_sail", "side_storage", "side_stable_power",
      "side_belt_upgrade", "side_rare_resource", "side_spray_coater", "side_blueprint",
    ];
    const state = {
      version: 23,
      nextId: 1,
      activePlanetId: "home",
      entities: [],
      belts: [],
      construction: {},
      tray: { universe_matrix: 250 },
      planetTrays: { home: { universe_matrix: 250 } },
      totalProduced: { universe_matrix: 250 },
      research: { selectedTechId: null, queuedTechIds: [], progressByTech: {}, completedTechIds: ["universe_matrix"] },
      exploration: { unlockedSystemIds: ["helios"], colonizedPlanetIds: ["home", "ashen", "giant"], missions: [], surveyProgressBySystem: { helios: 1 } },
      campaign: { activeChapterId: "dyson_program", activeTaskId: "absorb_shell_sail", completedTaskIds, rewardedTaskIds: completedTaskIds },
      paused: true,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openTitaniumRoutingGame(page: Page) {
  await page.addInitScript(() => {
    const base = { planetId: "home", machineCount: 1, minerCount: 0, inputs: {}, progress: 0, routingCursor: 0, utilization: 0, productionRate: 0 };
    const state = {
      version: 23,
      nextId: 8,
      activePlanetId: "home",
      entities: [
        { ...base, id: "titanium_source", kind: "machine", position: { x: 650, y: -300 }, buildingId: "arc_smelter", recipeId: "titanium_ingot", outputs: { titanium_ingot: 20 } },
        { ...base, id: "steel_source", kind: "machine", position: { x: 650, y: 0 }, buildingId: "arc_smelter", recipeId: "steel", outputs: { steel: 20 } },
        { ...base, id: "acid_source", kind: "machine", position: { x: 650, y: 300 }, buildingId: "chemical_plant", recipeId: "sulfuric_acid", outputs: { sulfuric_acid: 20 } },
        { ...base, id: "alloy_target", kind: "machine", position: { x: 1100, y: 0 }, buildingId: "arc_smelter", recipeId: "titanium_alloy", outputs: {} },
        { ...base, id: "routing_wind", kind: "power", position: { x: 900, y: -360 }, buildingId: "wind_turbine", machineCount: 8, outputs: {} },
      ],
      belts: [],
      construction: { conveyor_belt_mk1: 3 },
      tray: {},
      planetTrays: { home: {} },
      totalProduced: {},
      research: { selectedTechId: null, queuedTechIds: [], progressByTech: {}, completedTechIds: ["automatic_metallurgy", "high_strength_crystal", "high_efficiency_plasma_control", "basic_chemical_engineering", "titanium_alloy"] },
      exploration: { unlockedSystemIds: ["helios"], colonizedPlanetIds: ["home", "ashen", "giant"], missions: [], surveyProgressBySystem: { helios: 1 } },
      paused: false,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openMultiSlotStationRoutingGame(page: Page) {
  await page.addInitScript(() => {
    const slot = (itemId: string) => ({ itemId, localMode: "storage", remoteMode: "supply", minimumLoad: 1, minStock: 0, maxStock: 0, priority: 1 });
    const base = { planetId: "home", machineCount: 1, minerCount: 0, inputs: {}, outputs: {}, progress: 0, routingCursor: 0, utilization: 0, productionRate: 0 };
    const state = {
      version: 23,
      nextId: 5,
      activePlanetId: "home",
      entities: [
        {
          ...base,
          id: "multi_station",
          kind: "station",
          position: { x: 0, y: -120 },
          buildingId: "interstellar_logistics_station",
          storedItemId: "steel",
          stationSlots: [slot("steel"), slot("titanium_ingot"), slot("sulfuric_acid")],
          outputs: { steel: 20, titanium_ingot: 20, sulfuric_acid: 20 },
          stationVessels: 0,
          stationWarpers: 0,
          stationProgress: 0,
          stationTrips: 0,
        },
        { ...base, id: "multi_alloy", kind: "machine", position: { x: 420, y: -160 }, buildingId: "arc_smelter", recipeId: "titanium_alloy" },
        { ...base, id: "multi_chemical", kind: "machine", position: { x: 420, y: 180 }, buildingId: "chemical_plant", recipeId: "graphene" },
      ],
      belts: [],
      construction: { conveyor_belt_mk1: 3, conveyor_belt_mk2: 2, conveyor_belt_mk3: 1 },
      tray: {},
      planetTrays: { home: {} },
      totalProduced: {},
      research: {
        selectedTechId: null,
        queuedTechIds: [],
        progressByTech: {},
        completedTechIds: ["automatic_metallurgy", "high_strength_crystal", "basic_chemical_engineering", "energy_matrix", "nanomaterials", "titanium_alloy", "high_speed_logistics", "super_magnetic_logistics"],
      },
      paused: true,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openEdgeOverlapGame(page: Page) {
  await page.addInitScript(() => {
    const base = { planetId: "home", machineCount: 1, minerCount: 0, inputs: {}, outputs: {}, progress: 0, routingCursor: 0, utilization: 0, productionRate: 0 };
    const state = {
      version: 23,
      nextId: 5,
      activePlanetId: "home",
      entities: [
        { ...base, id: "overlap_source", kind: "machine", position: { x: 0, y: 0 }, buildingId: "arc_smelter", recipeId: "iron_ingot", outputs: { iron_ingot: 20 } },
        { ...base, id: "overlap_blocker", kind: "machine", position: { x: 380, y: 0 }, buildingId: "arc_smelter", recipeId: "copper_ingot" },
        { ...base, id: "overlap_target", kind: "machine", position: { x: 760, y: 0 }, buildingId: "assembling_machine_mk1", recipeId: "gear" },
      ],
      belts: [{ id: "overlap_belt", planetId: "home", source: "overlap_source", target: "overlap_target", itemId: "iron_ingot", lanes: 1, tier: 1, sorterTier: 1, progress: 0, priority: 0, stackSize: 1, monitorEnabled: false, totalTransferred: 0, congestion: 0, lastFlow: 0 }],
      construction: {},
      tray: {},
      planetTrays: { home: {} },
      totalProduced: {},
      research: { selectedTechId: null, queuedTechIds: [], progressByTech: {}, completedTechIds: ["automatic_metallurgy", "basic_assembling"] },
      paused: true,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openBeltNetworkGame(page: Page) {
  await page.addInitScript(() => {
    const base = { planetId: "home", machineCount: 1, minerCount: 0, inputs: {}, outputs: {}, progress: 0, routingCursor: 0, utilization: 0, productionRate: 0 };
    const storage = (id: string, x: number, outputs: Record<string, number> = {}) => ({
      ...base,
      id,
      kind: "storage",
      position: { x, y: 0 },
      buildingId: "storage_mk1",
      storedItemId: "iron_ingot",
      outputs,
    });
    const belt = (id: string, source: string, target: string) => ({
      id,
      planetId: "home",
      source,
      target,
      itemId: "iron_ingot",
      lanes: 1,
      tier: 1,
      sorterTier: 1,
      progress: 0,
      priority: 0,
      stackSize: 1,
      monitorEnabled: false,
      totalTransferred: 0,
      congestion: 0,
      lastFlow: 0,
      routeMode: "auto",
    });
    const state = {
      version: 23,
      nextId: 8,
      activePlanetId: "home",
      entities: [
        storage("network_source", -420, { iron_ingot: 40 }),
        storage("network_buffer", 0, { iron_ingot: 10 }),
        storage("network_sink", 420),
        { ...base, id: "network_unrelated", kind: "power", position: { x: 0, y: 360 }, buildingId: "wind_turbine", powerOutputKw: 0 },
      ],
      belts: [belt("network_belt_1", "network_source", "network_buffer"), belt("network_belt_2", "network_buffer", "network_sink")],
      construction: { conveyor_belt_mk1: 0 },
      tray: {},
      planetTrays: { home: {} },
      totalProduced: {},
      research: { selectedTechId: null, queuedTechIds: [], progressByTech: {}, completedTechIds: ["basic_logistics"] },
      paused: true,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openOfflineStageGame(page: Page) {
  await page.addInitScript(() => {
    const base = {
      planetId: "home",
      inputs: {},
      progress: 0,
      routingCursor: 0,
      utilization: 0,
      productionRate: 0,
    };
    const state = {
      version: 16,
      nextId: 3,
      activePlanetId: "home",
      entities: [
        { ...base, id: "offline_iron", kind: "vein", position: { x: -220, y: -80 }, resourceId: "iron_ore", extractorBuildingId: "mining_machine", machineCount: 0, minerCount: 1, outputs: { iron_ore: 0 } },
        { ...base, id: "offline_wind", kind: "power", position: { x: 120, y: -80 }, buildingId: "wind_turbine", machineCount: 3, minerCount: 0, outputs: {}, powerOutputKw: 0 },
      ],
      belts: [],
      construction: {},
      tray: {},
      totalProduced: {},
      manualMined: 0,
      research: { selectedTechId: null, queuedTechIds: [], progressByTech: {}, completedTechIds: [] },
      exploration: { unlockedSystemIds: ["helios"] },
      paused: false,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now() - 6_000, state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

test("progressive onboarding reaches interstellar logistics and locates its blocker", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openStellarExplorationGame(page, true);

  const coach = page.locator(".onboarding-coach");
  await expect(coach).toContainText("星际物流 · 渐进教学 14/18");
  await expect(coach).toContainText("完成首次星际运输");
  await expect(coach).toContainText("当前卡点");
  await coach.getByRole("button", { name: "定位卡点" }).click();
  await expect(page.locator(".station-inspector")).toBeVisible();
  await expect(page.locator(".game-notice")).toContainText("教学卡点");
  await expect(page.locator(".react-flow__node.selected .station-node")).toHaveCount(1);
  await page.screenshot({ path: "artifacts/qa/onboarding-interstellar-blocker-1280.png", fullPage: true });
});

test("five-step basic onboarding advances only after successful factory commands", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await freshGame(page);
  const coach = page.locator(".onboarding-coach");
  await expect(coach).toContainText("收纳第一组物品");
  await expect(coach).toContainText("0/18");

  await page.locator('.tray-row[title="拿取铁矿石"]').click();
  await page.getByTitle("放入物资托盘").click();
  await expect(coach).toContainText("制造一批建筑");
  await expect(coach).toContainText("1/18");

  await page.getByLabel("制造电弧熔炉").click();
  await expect(coach).toContainText("放置并堆叠建筑");
  await expect(coach).toContainText("2/18");

  const canvas = page.locator(".react-flow__pane");
  const canvasBox = await canvas.boundingBox();
  await placeOnCanvas(page, "部署风力涡轮机", Math.round(canvasBox!.width * 0.72), 180);
  const turbine = page.locator(".power-node").filter({ hasText: "风力涡轮机" }).first();
  await turbine.locator(".factory-node__header").click();
  await page.getByLabel(/快速增加 1 台建筑/).click();
  await expect(coach).toContainText("连接第一条传送带");
  await expect(coach).toContainText("3/18");

  await placeOnCanvas(page, "部署电弧熔炉", Math.round(canvasBox!.width * 0.84), 80);
  const source = page.locator(".vein-node").filter({ hasText: "铁矿石" }).locator(".factory-handle--output");
  const target = page.locator(".machine-node").filter({ hasText: "铁块" }).locator(".factory-handle--input:not(.factory-handle--auto)");
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect(coach).toContainText("选择第一项科技");
  await expect(coach).toContainText("6/18");

  await page.getByLabel("打开科技树").click();
  await page.locator(".technology-node").filter({ hasText: "电磁矩阵" }).first().click();
  await expect(coach).toContainText("取得第一份矿石");
  await expect(coach).toContainText("8/18");

  const progress = await page.evaluate(() => JSON.parse(window.localStorage.getItem("dsp-idle-network.basic-onboarding.v1") ?? "null"));
  expect(progress).toMatchObject({ version: 1, skipped: false });
  expect(progress.completedEvents).toEqual(expect.arrayContaining([
    "cargo-stowed", "construction-crafted", "building-placed", "building-stacked", "belt-connected", "research-selected",
  ]));
  await page.reload();
  await expect(page.locator(".onboarding-coach")).toContainText("8/18");
});

test("manual mining feeds a powered smelter", async ({ page }) => {
  await page.setViewportSize({ width: 1560, height: 960 });
  await freshGame(page);
  await expect(page.locator(".onboarding-coach")).toContainText("基础操作 · 渐进教学 0/18");
  const canvas = page.locator(".react-flow__pane");
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();

  await placeOnCanvas(page, "部署风力涡轮机", Math.round(box!.width * 0.75), 150);
  await placeOnCanvas(page, "部署电弧熔炉", Math.round(box!.width * 0.75), 390);

  const ironVein = page.locator(".vein-node").filter({ hasText: "铁矿石" });
  const mineButton = ironVein.getByTitle("长按采集铁矿石");
  await mineButton.hover();
  await page.mouse.down();
  await page.waitForTimeout(850);
  await page.mouse.up();
  await expect(page.locator(".campaign-reward-token")).toContainText("传送带 Mk.I");
  await page.screenshot({ path: "artifacts/qa/campaign-reward-flight-1560.png", fullPage: true });

  await mineButton.hover();
  await page.mouse.down();
  await page.waitForTimeout(850);
  await page.mouse.up();

  const ironOutput = ironVein.getByTitle("拿取铁矿石");
  await expect.poll(async () => Number(await ironOutput.locator("strong").textContent())).toBeGreaterThanOrEqual(5);
  await ironOutput.click();
  const smelter = page.locator(".machine-node").filter({ hasText: "铁块" });
  await smelter.getByTitle("投入铁矿石").click();

  await expect(page.getByText("1 / 1", { exact: true })).not.toBeVisible();
  await expect(smelter.getByRole("progressbar", { name: "生产周期" })).toBeVisible();
  await expect.poll(async () => Number(await smelter.getByRole("progressbar", { name: "生产周期" }).getAttribute("aria-valuenow"))).toBeGreaterThan(0);
  await page.waitForTimeout(1400);
  await expect(smelter.getByTitle("拿取铁块")).toBeEnabled();
  await page.screenshot({ path: "artifacts/qa/manual-smelting-1560.png", fullPage: true });
  await smelter.getByTitle("取出铁矿石").click();
  await expect(page.locator(".cargo-slot")).toContainText("铁矿石");
  await expect(smelter.getByTitle("投入铁矿石").locator("strong")).toHaveText("0");
});

test("materials drop into the resource tray", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await freshGame(page);
  const ironVein = page.locator(".vein-node").filter({ hasText: "铁矿石" });
  const mineButton = ironVein.getByTitle("长按采集铁矿石");
  await mineButton.hover();
  await page.mouse.down();
  await page.waitForTimeout(720);
  await page.mouse.up();

  await ironVein.getByTitle("拿取铁矿石").dragTo(page.locator(".tray-block"));
  await expect(page.locator(".tray-row").filter({ hasText: "铁矿石" })).toBeVisible();
  await expect(page.getByText("0 / 1", { exact: true })).toBeVisible();
});

test("automatic mining uses the real extraction cycle progress", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await freshGame(page);
  const canvas = page.locator(".react-flow__pane");
  const box = await canvas.boundingBox();
  await placeOnCanvas(page, "部署风力涡轮机", Math.round(box!.width * 0.82), 160);
  await page.getByTitle("部署风力涡轮机").click();
  await page.locator(".power-node").click();

  const ironVein = page.locator(".vein-node").filter({ hasText: "铁矿石" });
  await page.getByTitle("部署采矿机").click();
  await ironVein.click();
  const progress = ironVein.getByRole("progressbar", { name: "采矿周期" });
  await expect(progress).toBeVisible();
  await expect.poll(async () => Number(await progress.getAttribute("aria-valuenow"))).toBeGreaterThan(0);
  await expect(progress).toContainText("效率 100%");
  await page.screenshot({ path: "artifacts/qa/automatic-mining-progress-1280.png", fullPage: true });
});

test("factory nodes follow the pointer before release", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await freshGame(page);
  const canvas = page.locator(".react-flow__pane");
  const canvasBox = await canvas.boundingBox();
  await placeOnCanvas(page, "部署电弧熔炉", Math.round(canvasBox!.width * 0.8), 280);
  const node = page.locator(".machine-node").filter({ hasText: "铁块" });
  const header = node.locator(".factory-node__header");
  const before = await node.boundingBox();
  const handle = await header.boundingBox();
  await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle!.x + handle!.width / 2 + 130, handle!.y + handle!.height / 2 + 70, { steps: 12 });
  await page.waitForTimeout(120);
  const during = await node.boundingBox();
  expect(during!.x).toBeGreaterThan(before!.x + 90);
  expect(during!.y).toBeGreaterThan(before!.y + 40);
  await page.mouse.up();
  await page.waitForTimeout(500);
  await expect(page.locator(".react-flow__node")).toHaveCount(7);
  await expect.poll(async () => page.locator(".react-flow__node").evaluateAll((elements) =>
    elements.filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden";
    }).length)).toBe(7);
  await expect(node).toBeVisible();
});

test("selecting a machine card changes its production recipe directly", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await freshGame(page);
  const canvas = page.locator(".react-flow__pane");
  const box = await canvas.boundingBox();
  await placeOnCanvas(page, "部署电弧熔炉", Math.round(box!.width * 0.84), 80);
  const smelter = page.locator(".machine-node").filter({ hasText: "铁块" });
  await smelter.click();
  await chooseRecipe(page, smelter, "铜块");
  await expect(page.locator(".machine-node").filter({ hasText: "铜块" })).toContainText("铜块");
  await expect(page.locator(".inspector-panel")).toContainText("缺少铜矿石");
  await page.screenshot({ path: "artifacts/qa/direct-recipe-selection-1280.png", fullPage: true });
});

test("dragging a construction card keeps the canvas nodes visible", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await freshGame(page);
  const canvas = page.locator(".react-flow__pane");
  await page.getByTitle("部署风力涡轮机").dragTo(canvas, { targetPosition: { x: 650, y: 210 } });
  await expect(page.locator(".power-node")).toBeVisible();
  await expect(page.locator(".vein-node")).toHaveCount(6);
  await expect(page.locator(".react-flow__node")).toHaveCount(7);
});

test("construction batches place exact machine and miner groups", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await freshGame(page);
  const canvas = page.locator(".react-flow__pane");
  const box = await canvas.boundingBox();
  await page.locator(".placement-count").getByRole("button", { name: "×2", exact: true }).click();
  await placeOnCanvas(page, "部署风力涡轮机 ×2", Math.round(box!.width * 0.82), 160);
  await expect(page.locator(".power-node")).toContainText("×2");
  await expect(page.getByTitle("部署风力涡轮机 ×2")).toContainText("×1");

  await page.getByTitle("部署采矿机 ×2").click();
  const ironVein = page.locator(".vein-node").filter({ hasText: "铁矿石" });
  await ironVein.click();
  await expect(ironVein).toContainText("×2");
  await expect(page.getByTitle("部署采矿机 ×2")).toBeDisabled();

  await page.locator(".placement-count").getByRole("button", { name: "×5", exact: true }).click();
  await expect(page.getByTitle("部署风力涡轮机 ×5")).toBeDisabled();
  await page.screenshot({ path: "artifacts/qa/construction-batch-1280.png", fullPage: true });
});

test("responsive drawers keep all tools reachable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await freshGame(page);
  await expect(page.getByTitle("切换到澄海 I")).toBeVisible();
  await expect(page.getByTitle("完成星际物流系统科技后开放")).toHaveCount(2);
  await expect.poll(async () => page.locator(".planet-navigator").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/mobile-planets-390.png", fullPage: true });
  await page.getByLabel("打开物资托盘").click();
  await expect(page.locator(".resource-rail").getByText("母星物资托盘", { exact: true })).toBeVisible();
  await page.waitForTimeout(250);
  await page.screenshot({ path: "artifacts/qa/mobile-resources-390.png", fullPage: true });
  await page.mouse.click(370, 300);
  await page.getByLabel("打开检查器").click();
  await expect(page.getByRole("tab", { name: "基础制造" })).toBeVisible();
  await page.waitForTimeout(250);
  await page.screenshot({ path: "artifacts/qa/mobile-inspector-390.png", fullPage: true });
  await page.mouse.click(20, 300);
  await page.getByLabel("更多工作区").click();
  await page.getByRole("menuitem", { name: "科技树" }).click();
  await expect(page.getByRole("dialog", { name: "科技树" })).toBeVisible();
  const firstTechnology = page.locator(".technology-node").filter({ hasText: "电磁矩阵" }).first();
  await expect(firstTechnology).toBeVisible();
  await expect(page.locator(".matrix-stock")).toHaveCount(6);
  await page.screenshot({ path: "artifacts/qa/mobile-technology-390.png", fullPage: true });
  await firstTechnology.click();
  await expect(page.locator(".research-cost-list")).toContainText("0/3");
  await page.screenshot({ path: "artifacts/qa/mobile-technology-selected-390.png", fullPage: true });
});

test("phone portrait and landscape preserve a usable factory canvas", async ({ page }) => {
  const readLayout = () => page.evaluate(() => {
    const bounds = (selector: string) => document.querySelector(selector)?.getBoundingClientRect();
    const header = bounds(".game-header");
    const workspace = bounds(".game-workspace");
    const flow = bounds(".factory-canvas .react-flow");
    const dock = bounds(".construction-dock");
    return {
      headerHeight: header?.height ?? 0,
      workspaceTop: workspace?.top ?? 0,
      workspaceBottom: workspace?.bottom ?? 0,
      flowHeight: flow?.height ?? 0,
      dockTop: dock?.top ?? 0,
      dockHeight: dock?.height ?? 0,
      viewportHeight: window.innerHeight,
      hasHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await freshGame(page);
  const portrait = await readLayout();
  expect(portrait.headerHeight).toBeLessThanOrEqual(54);
  expect(portrait.dockHeight).toBeLessThanOrEqual(100);
  expect(portrait.workspaceTop).toBeGreaterThanOrEqual(portrait.headerHeight - 1);
  expect(portrait.dockTop).toBeGreaterThanOrEqual(portrait.workspaceBottom - 1);
  expect(portrait.flowHeight).toBeGreaterThan(620);
  expect(portrait.hasHorizontalOverflow).toBe(false);
  await expect(page.getByLabel("施工托盘分类")).toBeVisible();
  await expect(page.getByTitle("部署风力涡轮机").locator("span")).toHaveText("风力涡轮机");
  await page.getByTitle("部署风力涡轮机").click();
  await expect(page.getByTitle("部署风力涡轮机")).toHaveClass(/construction-item--active/);
  await page.locator(".react-flow__pane").click({ position: { x: 32, y: 250 } });
  await expect(page.locator(".power-node")).toHaveCount(1);
  await page.getByLabel("更多工作区").click();
  await expect(page.getByRole("menuitem", { name: "科技树" })).toBeVisible();
  await page.getByLabel("更多工作区").click();
  await page.screenshot({ path: "artifacts/qa/factory-phone-portrait-390.png", fullPage: true });

  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(240);
  const landscape = await readLayout();
  expect(landscape.headerHeight).toBeLessThanOrEqual(50);
  expect(landscape.dockHeight).toBeLessThanOrEqual(90);
  expect(landscape.workspaceTop).toBeGreaterThanOrEqual(landscape.headerHeight - 1);
  expect(landscape.dockTop).toBeGreaterThanOrEqual(landscape.workspaceBottom - 1);
  expect(landscape.flowHeight).toBeGreaterThan(200);
  expect(landscape.hasHorizontalOverflow).toBe(false);
  await expect(page.getByLabel("打开物资托盘")).toBeVisible();
  await page.getByLabel("打开物资托盘").click();
  await page.waitForTimeout(220);
  const resourceBounds = await page.locator(".resource-rail").boundingBox();
  expect(resourceBounds).not.toBeNull();
  expect(resourceBounds!.width).toBeLessThan(380);
  expect(resourceBounds!.y).toBeGreaterThanOrEqual(landscape.headerHeight - 1);
  expect(resourceBounds!.y + resourceBounds!.height).toBeLessThanOrEqual(landscape.dockTop + 1);
  await page.getByLabel("打开物资托盘").click();
  await expect(page.locator(".resource-rail")).not.toBeInViewport();
  await page.screenshot({ path: "artifacts/qa/factory-phone-landscape-844.png", fullPage: true });
});

test("mobile selection, long press and staged drawers survive orientation changes", async ({ page }) => {
  await enableCoarsePointer(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await freshGame(page);
  await dismissOnboarding(page);
  await placeOnCanvas(page, "部署风力涡轮机", 120, 250);

  const turbine = page.locator(".power-node").filter({ hasText: "风力涡轮机" });
  const ironVein = page.locator(".vein-node").filter({ hasText: "铁矿石" });
  await expect(turbine).toHaveCount(1);
  await expect(ironVein).toHaveCount(1);

  const firstBounds = await turbine.boundingBox();
  await turbine.dispatchEvent("pointerdown", { pointerId: 71, pointerType: "touch", isPrimary: true, button: 0, clientX: firstBounds!.x + 20, clientY: firstBounds!.y + 20 });
  await page.waitForTimeout(560);
  await turbine.dispatchEvent("pointerup", { pointerId: 71, pointerType: "touch", isPrimary: true, button: 0, clientX: firstBounds!.x + 20, clientY: firstBounds!.y + 20 });
  const actionSheet = page.getByRole("dialog", { name: "设备快捷操作" });
  await expect(actionSheet).toBeVisible();
  await expect(actionSheet.getByRole("button")).toHaveText(["", "查看配方", "复制设备", "定位检查", "升级设备", "回收设备"]);
  await actionSheet.getByLabel("关闭快捷操作").click();

  await page.getByLabel("框选模式").click();
  await ironVein.click();
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(2);
  await expect(page.getByRole("toolbar", { name: "选区操作" })).toContainText("2 节点 · 0 线路");

  await page.getByLabel("打开物资托盘").click();
  await expect(page.locator(".game-shell")).toHaveClass(/mobile-panel-stage--half/);
  const halfHeight = (await page.locator(".resource-rail").boundingBox())!.height;
  await page.getByLabel("展开为全屏面板").click();
  await expect(page.locator(".game-shell")).toHaveClass(/mobile-panel-stage--full/);
  const fullHeight = (await page.locator(".resource-rail").boundingBox())!.height;
  expect(fullHeight).toBeGreaterThan(halfHeight + 100);

  const readViewportCenter = () => page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>(".react-flow__viewport");
    const flow = document.querySelector<HTMLElement>(".factory-canvas .react-flow");
    if (!viewport || !flow) return null;
    const matrix = new DOMMatrix(getComputedStyle(viewport).transform);
    const bounds = flow.getBoundingClientRect();
    return { x: (bounds.width / 2 - matrix.e) / matrix.a, y: (bounds.height / 2 - matrix.f) / matrix.d, zoom: matrix.a };
  });
  const viewportBefore = await readViewportCenter();
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(180);
  await expect(page.getByRole("toolbar", { name: "选区操作" })).toContainText("2 节点 · 0 线路");
  await expect(page.locator(".game-shell")).toHaveClass(/mobile-panel--resources/);
  await expect(page.locator(".game-shell")).toHaveClass(/mobile-panel-stage--full/);
  const viewportAfter = await readViewportCenter();
  expect(viewportAfter!.zoom).toBeCloseTo(viewportBefore!.zoom, 2);
  expect(viewportAfter!.x).toBeCloseTo(viewportBefore!.x, 0);
  expect(viewportAfter!.y).toBeCloseTo(viewportBefore!.y, 0);

  await page.setViewportSize({ width: 390, height: 844 });
  const swipeHandle = page.getByLabel("收起为半屏面板");
  let handleBounds = await swipeHandle.boundingBox();
  await page.mouse.move(handleBounds!.x + handleBounds!.width / 2, handleBounds!.y + handleBounds!.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBounds!.x + handleBounds!.width / 2, handleBounds!.y + 100, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator(".game-shell")).toHaveClass(/mobile-panel-stage--half/);

  handleBounds = await page.getByLabel("展开为全屏面板").boundingBox();
  await page.mouse.move(handleBounds!.x + handleBounds!.width / 2, handleBounds!.y + handleBounds!.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBounds!.x + handleBounds!.width / 2, handleBounds!.y + 100, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator(".game-shell")).not.toHaveClass(/mobile-panel--resources/);
});

test("mobile pinch zoom stays responsive and does not trigger the long-press menu", async ({ browser }) => {
  const { context, page } = await createTouchPage(browser, { width: 390, height: 844 });
  try {
    await freshGame(page);
    await dismissOnboarding(page);
    const readZoom = () => page.locator(".react-flow__viewport").evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).a);
    const before = await readZoom();
    const center = await page.evaluate(() => {
      const pane = document.querySelector<HTMLElement>(".react-flow__pane");
      if (!pane) return null;
      const bounds = pane.getBoundingClientRect();
      for (let y = bounds.top + 80; y <= bounds.bottom - 80; y += 24) {
        for (let x = bounds.left + 90; x <= bounds.right - 90; x += 20) {
          const clear = [-76, -32, 32, 76].every((offset) => document.elementFromPoint(x + offset, y) === pane);
          if (clear) return { x: Math.round(x), y: Math.round(y) };
        }
      }
      return null;
    });
    expect(center).not.toBeNull();
    const session = await context.newCDPSession(page);
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [
      { x: center!.x - 32, y: center!.y, id: 1, radiusX: 4, radiusY: 4, force: 1 },
      { x: center!.x + 32, y: center!.y, id: 2, radiusX: 4, radiusY: 4, force: 1 },
    ] });
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [
      { x: center!.x - 54, y: center!.y, id: 1, radiusX: 4, radiusY: 4, force: 1 },
      { x: center!.x + 54, y: center!.y, id: 2, radiusX: 4, radiusY: 4, force: 1 },
    ] });
    await page.waitForTimeout(40);
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [
      { x: center!.x - 76, y: center!.y, id: 1, radiusX: 4, radiusY: 4, force: 1 },
      { x: center!.x + 76, y: center!.y, id: 2, radiusX: 4, radiusY: 4, force: 1 },
    ] });
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(readZoom).toBeGreaterThan(before * 1.15);
    await expect(page.getByRole("dialog", { name: "设备快捷操作" })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("a second finger takes over a pending node drag and pans or zooms the mobile canvas", async ({ browser }) => {
  const { context, page } = await createTouchPage(browser, { width: 390, height: 844 });
  try {
    await freshGame(page);
    await dismissOnboarding(page);
    await page.locator(".react-flow__controls-fitview").click();
    const nodeWrapper = page.locator(".react-flow__node").filter({ has: page.locator(".vein-node").filter({ hasText: "铁矿石" }) });
    const nodeBox = await nodeWrapper.boundingBox();
    expect(nodeBox).not.toBeNull();
    const readTransforms = () => page.evaluate(() => {
      const viewport = document.querySelector<HTMLElement>(".react-flow__viewport")!;
      const node = [...document.querySelectorAll<HTMLElement>(".react-flow__node")].find((element) => element.textContent?.includes("铁矿石"))!;
      const viewportMatrix = new DOMMatrix(getComputedStyle(viewport).transform);
      const nodeMatrix = new DOMMatrix(getComputedStyle(node).transform);
      return { viewport: { x: viewportMatrix.e, y: viewportMatrix.f, zoom: viewportMatrix.a }, node: { x: nodeMatrix.e, y: nodeMatrix.f } };
    });
    const before = await readTransforms();
    const first = { x: Math.round(nodeBox!.x + nodeBox!.width / 2), y: Math.round(nodeBox!.y + 38) };
    const second = { x: Math.min(370, first.x + 105), y: Math.min(760, first.y + 36) };
    const session = await context.newCDPSession(page);
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...first, id: 11, radiusX: 4, radiusY: 4, force: 1 }] });
    await page.waitForTimeout(45);
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [
      { ...first, id: 11, radiusX: 4, radiusY: 4, force: 1 },
      { ...second, id: 12, radiusX: 4, radiusY: 4, force: 1 },
    ] });
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [
      { x: first.x + 18, y: first.y + 42, id: 11, radiusX: 4, radiusY: 4, force: 1 },
      { x: second.x + 58, y: second.y + 52, id: 12, radiusX: 4, radiusY: 4, force: 1 },
    ] });
    await page.waitForTimeout(80);
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    const after = await readTransforms();
    expect(Math.abs(after.viewport.zoom - before.viewport.zoom) + Math.hypot(after.viewport.x - before.viewport.x, after.viewport.y - before.viewport.y)).toBeGreaterThan(5);
    expect(after.node.x).toBeCloseTo(before.node.x, 0);
    expect(after.node.y).toBeCloseTo(before.node.y, 0);
    await expect(page.getByRole("dialog", { name: "设备快捷操作" })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("coarse-pointer connection preview snaps to a nearby target port", async ({ browser }) => {
  const { context, page } = await createTouchPage(browser, { width: 844, height: 390 });
  try {
    await openMultiSlotStationRoutingGame(page);
    await page.locator(".react-flow__controls-fitview").click();
    const source = page.locator('.react-flow__node[data-id="multi_station"] .node-port').filter({ hasText: "钛块" }).locator(".factory-handle--output");
    const target = page.locator('.react-flow__node[data-id="multi_alloy"] .node-port--input').filter({ hasText: "钛块" }).locator(".factory-handle--input");
    const mobileBackdrop = page.getByRole("button", { name: "关闭侧栏" });
    await source.tap();
    if (await mobileBackdrop.isVisible()) await mobileBackdrop.tap();
    await expect(page.locator('.react-flow__node[data-id="multi_station"]')).toHaveClass(/factory-flow-node--connection-origin/);
    await expect(page.locator('.react-flow__node[data-id="multi_alloy"]')).toHaveClass(/factory-flow-node--connection-candidate/);
    await page.locator(".react-flow__controls-fitview").tap();
    await expect(page.locator(".factory-flow-node--connection-origin, .factory-flow-node--connection-candidate")).toHaveCount(0);
    await expect(page.locator(".react-flow__edge")).toHaveCount(0);
    await source.tap();
    if (await mobileBackdrop.isVisible()) await mobileBackdrop.tap();
    const targetBox = await target.boundingBox();
    const targetCenter = { x: targetBox!.x + targetBox!.width / 2, y: targetBox!.y + targetBox!.height / 2 };
    const nearPoint = { x: targetBox!.x - 40, y: targetCenter.y };
    await page.mouse.move(nearPoint.x, nearPoint.y, { steps: 6 });
    const preview = page.locator(".factory-click-connection-preview");
    await expect(preview.locator(".factory-connection-preview")).toHaveClass(/factory-connection-preview--valid/);
    await expect.poll(async () => Number(await preview.locator(".factory-connection-preview__target").getAttribute("cx"))).toBeCloseTo(targetCenter.x, 0);
    await page.touchscreen.tap(nearPoint.x, nearPoint.y);
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  } finally {
    await context.close();
  }
});

test("low-end phones automatically use the lightweight renderer", async ({ page }) => {
  await enableCoarsePointer(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "deviceMemory", { configurable: true, value: 2 });
    Object.defineProperty(navigator, "hardwareConcurrency", { configurable: true, value: 2 });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await freshGame(page);
  const shell = page.locator(".game-shell");
  await expect(shell).toHaveAttribute("data-mobile-performance", "true");
  await expect(shell).toHaveAttribute("data-performance-mode", "true");
  await expect(shell).toHaveAttribute("data-performance-auto", "true");
  await expect(shell).toHaveAttribute("data-large-factory", "true");

  const vein = page.locator(".vein-node").first();
  for (let index = 0; index < 4; index += 1) await page.locator(".react-flow__controls-zoomout").click();
  await expect(shell).toHaveAttribute("data-zoom-lod", "compact");
  await expect(vein.locator(".manual-mine")).toHaveCSS("opacity", "0.12");
  for (let index = 0; index < 7; index += 1) await page.locator(".react-flow__controls-zoomin").click();
  await expect(shell).toHaveAttribute("data-zoom-lod", "full");
  await expect(vein.locator(".manual-mine")).toHaveCSS("opacity", "1");
});

test("dragging matching ports creates a belt connection", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await freshGame(page);

  const canvas = page.locator(".react-flow__pane");
  const box = await canvas.boundingBox();
  await placeOnCanvas(page, "部署电弧熔炉", Math.round(box!.width * 0.62), 260);
  const source = page.locator(".vein-node").filter({ hasText: "铁矿石" }).locator(".factory-handle--output");
  const target = page.locator(".machine-node").filter({ hasText: "铁块" }).locator(".factory-handle--input:not(.factory-handle--auto)");
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  expect(sourceBox).not.toBeNull();
  expect(targetBox).not.toBeNull();
  expect(sourceBox!.width).toBeGreaterThanOrEqual(14.5);
  expect(targetBox!.width).toBeGreaterThanOrEqual(14.5);
  await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2, { steps: 12 });
  await page.waitForTimeout(120);
  await page.mouse.up();

  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  await expect(page.locator(".game-notice")).toContainText(/铁矿石运输线已建立|成就解锁：物流脉搏/);
  await expect(page.getByText("0.0 / 6 s⁻¹")).toBeVisible();
  await page.screenshot({ path: "artifacts/qa/belt-connection-1280.png", fullPage: true });
});

test("technology selection reaches the matrix lab research mode", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await freshGame(page);
  await page.getByLabel("打开科技树").click();
  const firstTechnology = page.locator(".technology-node").filter({ hasText: "电磁矩阵" }).first();
  await firstTechnology.click();
  await expect(page.locator(".research-focus")).toContainText("电磁矩阵");
  await page.screenshot({ path: "artifacts/qa/technology-tree-1280.png", fullPage: true });
  await page.getByLabel("关闭科技树").click();

  const canvas = page.locator(".react-flow__pane");
  const canvasBox = await canvas.boundingBox();
  await placeOnCanvas(page, "部署矩阵研究站", Math.round(canvasBox!.width * 0.63), 270);
  const lab = page.locator(".machine-node").filter({ hasText: "电磁矩阵" });
  await lab.click();
  await chooseRecipe(page, lab, "科研模式");
  await expect(lab).toContainText("科研模式");
  await expect(lab).toContainText("电磁矩阵");
  await page.screenshot({ path: "artifacts/qa/technology-research-1280.png", fullPage: true });
});

test("technology queue accepts a planned chain and cascades removals", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await freshGame(page);
  await page.getByLabel("打开科技树").click();
  await page.locator(".technology-node").filter({ hasText: "电磁矩阵" }).first().click();
  const electromagnetism = page.locator(".technology-node").filter({ has: page.getByText("电磁学", { exact: true }) });
  const basicLogistics = page.locator(".technology-node").filter({ has: page.getByText("基础物流系统", { exact: true }) });
  await electromagnetism.click();
  await basicLogistics.click();
  await expect(page.locator(".research-queue__item")).toHaveCount(2);
  await expect(page.locator(".research-queue")).toContainText("电磁学");
  await expect(page.locator(".research-queue")).toContainText("基础物流系统");

  await page.getByRole("button", { name: "暂停", exact: true }).click();
  await expect(page.locator(".technology-node--paused")).toContainText("电磁矩阵");
  await expect(page.locator(".research-focus")).toContainText("研究已暂停");
  await expect(page.locator(".research-queue__item")).toHaveCount(2);
  await page.getByRole("button", { name: "继续研究", exact: true }).click();
  await expect(page.locator(".technology-node--active")).toContainText("电磁矩阵");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.locator(".research-focus")).toContainText("未选择科技");
  await expect(page.locator(".research-queue__item")).toHaveCount(2);
  await page.locator(".technology-node").filter({ hasText: "电磁矩阵" }).first().click();

  await page.getByLabel("从科研队列移除电磁学").click();
  await expect(page.locator(".research-queue__item")).toHaveCount(0);
  await electromagnetism.click();
  await basicLogistics.click();
  await page.screenshot({ path: "artifacts/qa/technology-queue-1280.png", fullPage: true });
});

test("yellow matrix industry exposes remote resources, chemistry and three-color research", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openYellowStageGame(page);
  const water = page.locator(".vein-node").filter({ hasText: "海洋水源" });
  await expect(water).toHaveCount(1);

  await page.locator(".react-flow__controls-fitview").click();
  await page.getByTitle("部署抽水站").click();
  await water.click();
  await expect(water).toContainText("抽水站 ×1");

  await page.getByTitle("切换到烬原 II").click();
  await expect(page.locator(".planet-transition")).toContainText("烬原 II");
  await page.screenshot({ path: "artifacts/qa/planet-transition-1440.png", fullPage: true });
  await expect(page.locator(".vein-node").filter({ has: page.getByText("硅石", { exact: true }) })).toHaveCount(1);
  await expect(page.locator(".vein-node").filter({ has: page.getByText("钛石", { exact: true }) })).toHaveCount(1);
  await expect(page.locator(".vein-node").filter({ hasText: "硫酸海洋" })).toHaveCount(1);
  await expect(page.locator(".vein-node").filter({ hasText: "海洋水源" })).toHaveCount(0);
  await page.getByTitle("切换到澄海 I").click();

  const chemicalPlant = page.locator(".machine-node").filter({ hasText: "塑料" });
  await chemicalPlant.click();
  await chooseRecipe(page, chemicalPlant, "有机晶体");
  await expect(chemicalPlant).toContainText("有机晶体");
  await expect(chemicalPlant.getByTitle("投入水")).toBeVisible();

  const matrixLab = page.locator(".machine-node").filter({ hasText: "电磁矩阵" });
  await matrixLab.click();
  await chooseRecipe(page, matrixLab, "结构矩阵");
  const structureLab = page.locator(".machine-node").filter({ hasText: "结构矩阵" });
  await expect(structureLab).toContainText("结构矩阵");
  await expect(structureLab.getByTitle("投入金刚石")).toBeVisible();
  await expect(structureLab.getByTitle("投入钛晶石")).toBeVisible();
  await page.screenshot({ path: "artifacts/qa/yellow-industry-1440.png", fullPage: true });

  await page.getByLabel("打开科技树").click();
  await expect(page.locator(".matrix-stock")).toHaveCount(6);
  const interstellar = page.locator(".technology-node").filter({ has: page.getByText("星际物流系统", { exact: true }) });
  await interstellar.click();
  await expect(page.locator(".research-focus")).toContainText("星际物流系统");
  await expect(page.locator(".research-cost-list")).toContainText("0/20");
  await page.screenshot({ path: "artifacts/qa/yellow-technology-1440.png", fullPage: true });
});

test("planet navigation exposes independent factories and a live interstellar route", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openInterstellarGame(page);
  await expect(page.locator(".tray-row").filter({ hasText: "铁矿石" })).toBeVisible();
  await expect(page.locator(".tray-row").filter({ hasText: "钛石" })).toHaveCount(0);
  await expect(page.locator(".construction-item").filter({ hasText: "星际物流站" })).toHaveCount(1);
  const homeStation = page.locator(".station-node");
  await expect(homeStation).toContainText("供应");
  await expect(homeStation).toContainText("运输船航程");

  await page.getByTitle("切换到烬原 II").click();
  await expect(page.locator(".tray-row").filter({ hasText: "钛石" })).toBeVisible();
  await expect(page.locator(".tray-row").filter({ hasText: "铁矿石" })).toHaveCount(0);
  await expect(page.locator(".brand-lockup")).toContainText("DSP极简网络");
  await expect(page.locator(".vein-node").filter({ hasText: "钛石" })).toBeVisible();
  await expect(page.locator(".vein-node").filter({ hasText: "原油" })).toHaveCount(0);
  const demandStation = page.locator(".station-node");
  await expect(demandStation).toContainText("需求");
  await expect(demandStation).toContainText("1/10 舰队");
  await expect.poll(async () => Number(await demandStation.getByTitle("拿取钛块").locator("strong").textContent())).toBe(100);
  await demandStation.click();
  await expect(page.locator(".station-inspector")).toContainText("澄海 I");
  await expect(page.locator(".station-inspector")).toContainText("最近运量");
  await expect(page.locator(".station-inspector")).toContainText("100");
  await expect(page.locator(".station-fleet-control .station-fleet-summary strong")).toContainText("1 / 10");
  await expect(page.getByRole("button", { name: "100%", exact: true })).toHaveClass(/active/);
  await page.screenshot({ path: "artifacts/qa/interstellar-logistics-1440.png", fullPage: true });
});

test("cursor cargo hand-carries a titanium stack between planets", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await openHandCarryGame(page);
  await page.locator(".tray-row").filter({ hasText: "钛块" }).click();
  await expect(page.locator(".cargo-block")).toContainText("手提星际载荷");
  await expect(page.locator(".cargo-slot")).toContainText("钛块");
  await expect(page.locator(".cargo-slot")).toContainText("×40");
  await expect(page.locator(".cargo-block")).toHaveClass(/rail-block--cargo-drop/);
  await expect(page.locator(".tray-block")).toHaveClass(/rail-block--cargo-drop/);
  await expect(page.locator(".mobile-toggle--cargo")).toHaveCount(1);

  await page.getByTitle("切换到烬原 II").click();
  await expect(page.locator(".cargo-slot")).toContainText("钛块");
  await expect(page.getByRole("status")).toContainText("托钛天王：钛块 ×40 已抵达烬原 II");
  await page.screenshot({ path: "artifacts/qa/hand-carry-titanium-1280.png", fullPage: true });
  await expect(page.locator(".planet-transition")).toBeHidden({ timeout: 3_000 });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel("打开物资托盘").click();
  await expect(page.locator(".cargo-slot")).toContainText("钛块");
  await expect.poll(async () => Math.round((await page.locator(".resource-rail").boundingBox())?.x ?? -999)).toBe(0);
  await expect.poll(async () => Math.round((await page.locator(".resource-rail").boundingBox())?.width ?? 0)).toBeGreaterThan(300);
  await expect.poll(async () => Math.round((await page.locator(".inspector-panel").boundingBox())?.x ?? 0)).toBeGreaterThanOrEqual(390);
  await page.screenshot({ path: "artifacts/qa/hand-carry-titanium-390.png", fullPage: true });
  await page.locator(".cargo-slot").click();
  await expect(page.locator(".tray-row").filter({ hasText: "钛块" })).toContainText("40");

  await page.setViewportSize({ width: 1280, height: 820 });
  await page.getByTitle("切换到澄海 I").click();
  await expect(page.locator(".tray-row").filter({ hasText: "钛块" })).toHaveCount(0);
  await page.getByTitle("切换到烬原 II").click();
  await expect(page.locator(".tray-row").filter({ hasText: "钛块" })).toContainText("40");
});

test("purple matrix industry exposes its full recipe and four-color research loop", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openPurpleStageGame(page);
  await page.locator(".react-flow__controls-fitview").click();

  const chemical = page.locator(".machine-node").filter({ hasText: "石墨烯" });
  await expect(chemical.getByTitle("投入高能石墨")).toBeVisible();
  await expect(chemical.getByTitle("投入硫酸")).toBeVisible();
  await chemical.click();
  await chooseRecipe(page, chemical, "碳纳米管");
  await expect(chemical).toContainText("碳纳米管");
  await expect(chemical.getByTitle("投入钛块")).toBeVisible();

  const smelter = page.locator(".machine-node").filter({ hasText: "晶格硅" });
  await expect(smelter.getByTitle("投入高纯硅块")).toBeVisible();
  const assembler = page.locator(".machine-node").filter({ hasText: "粒子宽带" });
  await expect(assembler.getByTitle("投入碳纳米管")).toBeVisible();
  await expect(assembler.getByTitle("投入晶格硅")).toBeVisible();
  await expect(assembler.getByTitle("投入塑料")).toBeVisible();
  const lab = page.locator(".machine-node").filter({ hasText: "信息矩阵" });
  await expect(lab.getByTitle("投入粒子宽带")).toBeVisible();
  await expect(lab.getByTitle("投入处理器")).toBeVisible();
  await page.screenshot({ path: "artifacts/qa/purple-industry-1440.png", fullPage: true });

  await page.getByLabel("打开科技树").click();
  await expect(page.locator(".matrix-stock")).toHaveCount(6);
  await expect(page.locator(".matrix-stock").filter({ hasText: "Inf" })).toContainText("7");
  const researchSpeed = page.locator(".technology-node").filter({ has: page.getByText("科研速度 I", { exact: true }) });
  await researchSpeed.click();
  await expect(page.locator(".research-focus")).toContainText("科研速度 I");
  await expect(page.locator(".research-cost-list > span")).toHaveCount(4);
  await page.screenshot({ path: "artifacts/qa/purple-technology-1440.png", fullPage: true });
});

test("green matrix industry exposes particle collision, dense fuel and five-color research", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openGreenStageGame(page);
  await page.locator(".react-flow__controls-fitview").click();
  await expect(page.locator(".construction-item").filter({ hasText: "微型粒子对撞机" })).toHaveCount(1);

  const thermal = page.locator(".power-node").filter({ hasText: "火力发电厂" });
  await thermal.click();
  await expect(page.locator(".inspector-content")).toContainText("氘核燃料棒");
  await expect(page.locator(".inspector-content")).toContainText("600 MJ");

  const collider = page.locator(".machine-node").filter({ has: page.getByText("对撞机", { exact: true }) }).filter({ hasText: "氘富集" });
  await expect(collider.getByTitle("投入氢")).toBeVisible();
  await expect(collider.getByTitle("拿取氘")).toBeVisible();
  await collider.click();
  await chooseRecipe(page, collider, "奇异物质");
  const strangeCollider = page.locator(".machine-node").filter({ has: page.getByText("对撞机", { exact: true }) }).filter({ hasText: "奇异物质" });
  await expect(strangeCollider.getByTitle("投入粒子容器")).toBeVisible();
  await expect(strangeCollider.getByTitle("投入氘")).toBeVisible();

  const assembler = page.locator(".machine-node").filter({ has: page.getByText("制造台", { exact: true }) }).filter({ hasText: "量子芯片" });
  await expect(assembler.getByTitle("投入处理器")).toBeVisible();
  await expect(assembler.getByTitle("投入位面过滤器")).toBeVisible();
  await assembler.click();
  await chooseRecipe(page, assembler, "引力透镜");
  const lensAssembler = page.locator(".machine-node").filter({ has: page.getByText("制造台", { exact: true }) }).filter({ hasText: "引力透镜" });
  await expect(lensAssembler.getByTitle("投入金刚石")).toBeVisible();
  await expect(lensAssembler.getByTitle("投入奇异物质")).toBeVisible();

  const lab = page.locator(".machine-node").filter({ hasText: "引力矩阵" });
  await expect(lab.getByTitle("投入引力透镜")).toBeVisible();
  await expect(lab.getByTitle("投入量子芯片")).toBeVisible();
  await strangeCollider.click();
  await page.screenshot({ path: "artifacts/qa/green-industry-1440.png", fullPage: true });

  await page.getByLabel("打开科技树").click();
  await expect(page.locator(".matrix-stock")).toHaveCount(6);
  await expect(page.locator(".matrix-stock").filter({ hasText: "Grv" })).toContainText("7");
  const researchSpeed = page.locator(".technology-node").filter({ has: page.getByText("科研速度 II", { exact: true }) });
  await researchSpeed.click();
  await expect(page.locator(".research-focus")).toContainText("科研速度 II");
  await expect(page.locator(".research-cost-list > span")).toHaveCount(5);
  await page.screenshot({ path: "artifacts/qa/green-technology-1440.png", fullPage: true });
});

test("Dyson swarm closes the critical photon, antimatter and universe matrix loop", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWhiteStageGame(page);
  await page.locator(".react-flow__controls-fitview").click();

  await expect(page.locator(".dyson-block")).toContainText("在轨太阳帆");
  await expect(page.locator(".dyson-block .dyson-load > strong .power-value > span:first-child")).toHaveText("6 MW");
  await expect(page.locator(".dyson-block")).toContainText("理论接收");
  await expect(page.locator(".dyson-block")).toContainText("接收站利用");
  await expect(page.locator(".dyson-block")).toContainText("功率利用");
  await expect(page.locator(".construction-item").filter({ hasText: "电磁轨道弹射器" })).toHaveCount(1);
  await expect(page.locator(".construction-item").filter({ hasText: "射线接收站" })).toHaveCount(1);

  const ejector = page.locator(".machine-node").filter({ hasText: "太阳帆发射" });
  await expect(ejector.getByTitle("取出太阳帆")).toBeVisible();
  await expect(ejector).toContainText("累计");

  const receiver = page.locator(".machine-node").filter({ hasText: "戴森系统接收设施" });
  await expect(receiver.getByTitle("拿取临界光子")).toBeVisible();
  await receiver.click();
  await chooseRecipe(page, receiver, "电力接收");
  await expect(receiver.locator(".ray-reception")).toContainText("连续接收");
  await expect(receiver.locator(".ray-reception .power-value > span:first-child")).toHaveText("6 MW");
  await expect(receiver).toContainText("接收");
  await expect(receiver).not.toContainText("NaN");

  const collider = page.locator(".machine-node").filter({ hasText: "质能转换" });
  await expect(collider.getByTitle("投入临界光子")).toBeVisible();
  await expect(collider.getByTitle("拿取反物质")).toBeVisible();
  const fuelAssembler = page.locator(".machine-node").filter({ hasText: "反物质燃料棒" });
  await expect(fuelAssembler.getByTitle("投入反物质")).toBeVisible();
  await expect(fuelAssembler.getByTitle("投入湮灭约束球")).toBeVisible();
  const whiteLab = page.locator(".machine-node").filter({ hasText: "宇宙矩阵" });
  await expect(whiteLab.getByTitle("投入引力矩阵")).toBeVisible();
  await expect(whiteLab.getByTitle("投入反物质")).toBeVisible();
  await page.screenshot({ path: "artifacts/qa/white-industry-1440.png", fullPage: true });

  await page.getByLabel("打开科技树").click();
  await expect(page.locator(".matrix-stock")).toHaveCount(6);
  await expect(page.locator(".matrix-stock").filter({ hasText: "Uni" })).toContainText("7");
  const researchSpeed = page.locator(".technology-node").filter({ has: page.getByText("科研速度 III", { exact: true }) });
  await researchSpeed.click();
  await expect(page.locator(".research-focus")).toContainText("科研速度 III");
  await expect(page.locator(".research-cost-list > span")).toHaveCount(6);
  await page.screenshot({ path: "artifacts/qa/white-technology-1440.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".matrix-stock")).toHaveCount(6);
  await expect(page.getByText("科研速度 III", { exact: true }).last()).toBeVisible();
  await page.screenshot({ path: "artifacts/qa/white-technology-390.png", fullPage: true });
});

test("carrier rockets turn the Dyson cloud into a permanent sphere", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openDysonSphereStageGame(page);
  await page.locator(".react-flow__controls-fitview").click();

  const dyson = page.locator(".dyson-block");
  await expect(dyson).toContainText("永久结构运行");
  await expect(dyson).toContainText("30点");
  await expect(dyson).toContainText("300 / 1,200");
  await expect(dyson.locator(".dyson-load > span .power-value > span:first-child")).toHaveText("55.2 MW");
  await expect(dyson).toContainText("总功率");
  await expect(dyson).toContainText("运载火箭 30");
  await expect(dyson).toContainText("永久吸附 300");
  await expect(page.locator(".construction-item").filter({ hasText: "垂直发射井" })).toHaveCount(1);

  const frame = page.locator(".machine-node").filter({ hasText: "框架材料" });
  await expect(frame.getByTitle("投入碳纳米管")).toBeVisible();
  await expect(frame.getByTitle("投入钛合金")).toBeVisible();
  const component = page.locator(".machine-node").filter({ hasText: "戴森球组件" });
  await expect(component.getByTitle("投入框架材料")).toBeVisible();
  await expect(component.getByTitle("投入太阳帆")).toBeVisible();
  const rocket = page.locator(".machine-node").filter({ hasText: "小型运载火箭" });
  await expect(rocket.getByTitle("投入戴森球组件")).toBeVisible();
  await expect(rocket.getByTitle("投入氘核燃料棒")).toBeVisible();

  const silo = page.locator(".machine-node").filter({ hasText: "戴森球建造设施" });
  await expect(silo.getByTitle("投入小型运载火箭")).toBeVisible();
  await page.locator(".tray-row").filter({ hasText: "小型运载火箭" }).click();
  await expect(silo).toHaveClass(/factory-node--accepts-cargo/);
  await silo.getByTitle("投入小型运载火箭").evaluate((element: HTMLButtonElement) => element.click());
  await expect(silo.getByTitle("取出小型运载火箭")).toBeVisible();
  await expect(silo).toContainText("结构 30 点");
  await expect(silo).toContainText("累计 30 枚");
  await silo.locator(".factory-node__header").click({ force: true });
  await expect(page.locator(".inspector-content")).toContainText("永久结构点");
  await expect(page.locator(".inspector-content")).toContainText("18 MW");
  await page.screenshot({ path: "artifacts/qa/dyson-sphere-industry-1440.png", fullPage: true });

  await page.getByLabel("打开科技树").click();
  const shellTechnology = page.locator(".technology-node").filter({ has: page.getByText("戴森壳面", { exact: true }) });
  await shellTechnology.click();
  await expect(page.locator(".research-focus")).toContainText("戴森壳面");
  await expect(page.locator(".research-cost-list > span")).toHaveCount(6);
  await page.screenshot({ path: "artifacts/qa/dyson-sphere-technology-1440.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel("关闭科技树").click();
  await page.getByLabel("打开物资托盘").click();
  await expect(page.locator(".dyson-block")).toBeVisible();
  await expect(page.locator(".dyson-block")).toContainText("300 / 1,200");
  await expect.poll(async () => Math.round((await page.locator(".resource-rail").boundingBox())?.x ?? -999)).toBe(0);
  await page.screenshot({ path: "artifacts/qa/dyson-sphere-resources-390.png", fullPage: true });
});

test("basic fabrication handcrafts unlocked material recipes in a compact grid", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openHandcraftGame(page);
  await page.getByRole("tab", { name: "基础制造" }).click();
  await expect(page.getByLabel("搜索建筑制造")).toBeVisible();
  const constructionSearch = page.getByLabel("搜索建筑制造");
  for (const search of ["风力", "熔炉", "采矿", "研究站"]) {
    await constructionSearch.fill(search);
    await constructionSearch.press("Enter");
  }
  await constructionSearch.fill("");
  await constructionSearch.click();
  const constructionHistory = page.getByLabel("建筑制造最近搜索");
  await expect(constructionHistory).toBeVisible();
  await expect(constructionHistory.locator(".fabricator-search-history-options > button")).toHaveText(["研究站", "采矿", "熔炉"]);
  await expect(constructionHistory).not.toContainText("风力");
  await constructionHistory.getByRole("button", { name: "熔炉", exact: true }).click();
  await expect(constructionSearch).toHaveValue("熔炉");
  const stickyTools = page.locator(".fabricator-sticky-tools");
  const stickyY = (await stickyTools.boundingBox())!.y;
  await page.locator(".inspector-panel").evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => page.locator(".inspector-panel").evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect.poll(async () => Math.abs(((await stickyTools.boundingBox())?.y ?? -999) - stickyY)).toBeLessThan(2);
  const smelterRow = page.locator(".fabricator-row").filter({ hasText: "电弧熔炉" });
  await expect(smelterRow).toHaveCount(1);
  await smelterRow.getByLabel("手工制造石材").click();
  await expect(page.getByRole("button", { name: "物品手工" })).toHaveClass(/active/);
  await expect(page.getByLabel("搜索手工配方")).toHaveValue("石材");
  await expect(page.locator('[data-output-item="stone_brick"]')).toHaveClass(/fabricator-row--focused/);
  await expect(page.locator(".fabricator-list")).toHaveClass(/fabricator-list--compact/);
  await page.getByLabel("搜索手工配方").fill("铁块");
  const ironRow = page.locator(".handcraft-row").filter({ hasText: "铁块" });
  await expect(ironRow).toContainText("熔炉");
  await ironRow.getByTitle("立即手工制造铁块").click();
  await expect(page.locator(".tray-row").filter({ hasText: "铁块" })).toContainText("21");
  await page.getByLabel("搜索手工配方").fill("磁线圈");

  const coilRow = page.locator('[data-output-item="magnetic_coil"]');
  await expect(coilRow).toHaveCount(1);
  await page.getByLabel("手工制造批次数量").fill("5");
  await page.getByLabel("手工制造批次数量").press("Enter");
  await expect(coilRow).toContainText("20/10");
  await expect(coilRow).toContainText("10/5");
  await coilRow.getByTitle("手工制造磁线圈").click();
  await expect(page.locator(".tray-row").filter({ hasText: "磁线圈" })).toContainText("10");

  await page.getByLabel("手工制造批次数量").fill("1");
  await page.getByLabel("手工制造批次数量").press("Enter");
  await page.getByLabel("搜索手工配方").fill("框架材料");
  const frameRow = page.locator(".handcraft-row").filter({ hasText: "框架材料" });
  await expect(frameRow.getByTitle("手工制造框架材料")).toBeEnabled();
  await frameRow.getByTitle("手工制造框架材料").click();
  await expect(page.locator(".tray-row").filter({ hasText: "框架材料" })).toContainText("1");
  const handcraftSearch = page.getByLabel("搜索手工配方");
  const missingNanotube = frameRow.getByRole("button", { name: "手工制造碳纳米管" });
  await expect(missingNanotube).toBeVisible();
  await missingNanotube.click();
  await expect(handcraftSearch).toHaveValue("碳纳米管");
  const nanotubeRecipes = page.locator('[data-output-item="carbon_nanotube"]');
  await expect(nanotubeRecipes).toHaveCount(2);
  await expect(nanotubeRecipes.first()).toHaveClass(/fabricator-row--focused/);
  await expect(nanotubeRecipes.last()).toHaveClass(/fabricator-row--focused/);
  await handcraftSearch.click();
  const handcraftHistory = page.getByLabel("物品手工最近搜索");
  await expect(handcraftHistory).toBeVisible();
  await expect(handcraftHistory.locator(".fabricator-search-history-options > button")).toHaveText(["框架材料", "磁线圈", "铁块"]);
  await expect(handcraftHistory).not.toContainText("采矿");
  await expect.poll(() => page.evaluate(() => {
    const history = JSON.parse(window.localStorage.getItem("dsp-idle-network.fabricator-search-history.v1") ?? "{}");
    return JSON.stringify(history.items ?? []);
  })).toBe(JSON.stringify(["框架材料", "磁线圈", "铁块"]));
  await page.screenshot({ path: "artifacts/qa/fabricator-search-history-1440.png", fullPage: true });
  await handcraftSearch.press("Escape");

  await page.locator(".tray-row").filter({ hasText: "磁线圈" }).locator(".item-reference--tray").first().hover();
  await expect(page.locator(".item-hover-card")).toContainText("磁铁 ×2 + 铜块 ×1");
  await expect(page.locator(".item-hover-card")).toContainText("用途");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel("打开检查器").click();
  await expect(page.locator(".inspector-panel")).toBeVisible();
  await handcraftSearch.click();
  await expect(handcraftHistory).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/fabricator-search-history-390.png", fullPage: true });
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(handcraftHistory).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/fabricator-search-history-844x390.png", fullPage: true });

  await page.getByRole("tab", { name: "检查器" }).click();
  await page.getByRole("tab", { name: "基础制造" }).click();
  const restoredConstructionSearch = page.getByLabel("搜索建筑制造");
  await restoredConstructionSearch.click();
  await expect(page.getByLabel("建筑制造最近搜索").locator(".fabricator-search-history-options > button")).toHaveText(["熔炉", "研究站", "采矿"]);
  await page.getByRole("button", { name: "物品手工" }).click();
  await page.getByLabel("搜索手工配方").click();
  await expect(page.getByLabel("物品手工最近搜索").locator(".fabricator-search-history-options > button")).toHaveText(["碳纳米管", "框架材料", "磁线圈"]);
});

test("handcraft queue exposes progress, waits on inventory and keeps recipe rates visible", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openHandcraftGame(page);
  await page.getByRole("tab", { name: "基础制造" }).click();
  await page.getByRole("button", { name: "物品手工" }).click();
  await page.getByLabel("搜索手工配方").fill("齿轮");
  const gearRow = page.locator(".handcraft-row").filter({ hasText: "齿轮" });
  await gearRow.getByLabel("排队制造齿轮").click();
  await expect(page.locator(".handcraft-queue")).toContainText("齿轮");
  await expect(page.locator(".handcraft-queue").getByRole("progressbar")).toBeVisible();
  await expect.poll(async () => Number(await page.locator(".tray-row").filter({ hasText: "齿轮" }).locator("strong").textContent()), { timeout: 6_000 }).toBeGreaterThan(0);
  await page.getByLabel("打开生产资料库").click();
  const codex = page.getByRole("dialog", { name: "生产资料库" });
  await expect(codex).toContainText("数据");
  await codex.getByLabel("搜索配方物品").fill("处理器");
  await codex.locator(".recipe-index > button").filter({ hasText: "处理器" }).click();
  await expect(codex.locator(".recipe-method").filter({ hasText: "处理器" }).first()).toContainText("/min");
  await page.screenshot({ path: "artifacts/qa/handcraft-queue-rates-1440.png", fullPage: true });
});

test("recipe codex searches sources and traverses production chains", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openHandcraftGame(page);
  await page.getByLabel("打开生产资料库").click();
  const workspace = page.getByRole("dialog", { name: "生产资料库" });
  await expect(workspace).toBeVisible();

  await workspace.getByLabel("搜索配方物品").fill("硫酸");
  await workspace.locator(".recipe-index > button").filter({ hasText: "硫酸" }).click();
  await expect(workspace.locator(".recipe-item-header")).toContainText("硫酸");
  await expect(workspace.locator(".recipe-method--source")).toContainText("硫酸海洋抽取");
  await expect(workspace.locator(".recipe-method--source")).toContainText("烬原 II");
  const sulfuricRecipe = workspace.locator(".recipe-section").first().locator(".recipe-method:not(.recipe-method--source)");
  await expect(sulfuricRecipe).toContainText("硫酸");
  await expect(sulfuricRecipe).toContainText("化工厂");
  const downstream = workspace.locator(".recipe-relations > div").last();
  await expect(downstream).toContainText("钛合金");
  await expect(downstream).toContainText("石墨烯");

  await workspace.getByLabel("搜索配方物品").fill("小型运载火箭");
  await workspace.locator(".recipe-index > button").filter({ hasText: "小型运载火箭" }).click();
  await expect(workspace.locator(".recipe-item-header")).toContainText("小型运载火箭");
  const rocketRecipe = workspace.locator(".recipe-method").filter({ hasText: "小型运载火箭" }).first();
  await expect(rocketRecipe).toContainText("戴森球组件");
  await expect(rocketRecipe).toContainText("氘核燃料棒");
  await expect(rocketRecipe).toContainText("量子芯片");
  await expect(workspace.locator(".recipe-method").filter({ hasText: "运载火箭发射" })).toContainText("戴森球永久结构点");

  await workspace.getByRole("button", { name: "固定到主界面" }).click();
  await workspace.getByLabel("关闭生产资料库").click();
  const focusedChain = page.locator(".recipe-focus-panel");
  await expect(focusedChain).toContainText("小型运载火箭");
  await focusedChain.getByRole("button", { name: /完整/ }).click();
  await expect(focusedChain).toContainText("完整上游链");
  await focusedChain.getByLabel("取消聚焦材料").click();
  await expect(focusedChain).toHaveCount(0);

  await page.getByLabel("打开生产资料库").click();
  const reopenedWorkspace = page.getByRole("dialog", { name: "生产资料库" });
  await expect(reopenedWorkspace).toBeVisible();
  await reopenedWorkspace.getByLabel("搜索配方物品").fill("小型运载火箭");
  await reopenedWorkspace.locator(".recipe-index > button").filter({ hasText: "小型运载火箭" }).click();
  await reopenedWorkspace.locator(".recipe-item-header .item-reference").hover();
  await expect(page.locator(".item-hover-card")).toContainText("制造台");
  await expect(page.locator(".item-hover-card")).toContainText("1 项生产配方");
  await page.screenshot({ path: "artifacts/qa/recipe-codex-1440.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(workspace.locator(".recipe-item-header")).toBeVisible();
  await expect.poll(async () => workspace.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/recipe-codex-390.png", fullPage: true });
});

test("production library links buildings, recipes, technologies and authoritative logistics rates", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openHandcraftGame(page);
  await page.getByLabel("打开生产资料库").click();
  const library = page.getByRole("dialog", { name: "生产资料库" });
  await library.getByRole("button", { name: "建筑设施", exact: true }).click();
  await library.locator(".codex-search input").fill("制造台 Mk.I");
  await library.getByRole("button", { name: /^制造台 Mk\.I / }).click();
  const building = library.locator(".codex-building-detail");
  await expect(building).toContainText("基础速度");
  await expect(building).toContainText("输入缓存");
  await expect(building).toContainText("额定耗电");
  await expect(building).toContainText("制造材料");
  await expect(building.locator(".codex-recipe-row").first()).toContainText("单次产出 / 每分钟");
  await expect(building.locator(".codex-recipe-row").first()).toContainText("/min");
  await page.screenshot({ path: "artifacts/qa/production-library-building-1440.png", fullPage: true });

  await library.getByRole("button", { name: "物流运输", exact: true }).click();
  const belts = library.locator(".codex-belt-grid");
  await expect(belts).toContainText("6 件/秒");
  await expect(belts).toContainText("12 件/秒");
  await expect(belts).toContainText("30 件/秒");
  await expect(belts).toContainText("4 层");
  for (const section of ["电力与能源", "星球与资源", "戴森工程", "科研与机制"]) {
    await library.getByRole("button", { name: section, exact: true }).click();
    await expect(library.locator(".codex-overview, .codex-master-detail").first()).toBeVisible();
  }
  await expect.poll(() => library.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
});

test("production equipment and belt lanes upgrade in place without losing the network", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openUpgradeStageGame(page);
  await page.locator(".react-flow__controls-fitview").click();
  await page.getByRole("button", { name: "继续模拟" }).click();
  await expect(page.locator(".factory-cargo-packet").first()).toBeVisible();

  const assembler = page.locator(".machine-node").filter({ hasText: "齿轮" });
  await assembler.locator(".factory-node__header").click();
  await expect(page.getByTitle("升级为制造台 Mk.II")).toBeEnabled();
  await page.getByTitle("升级为制造台 Mk.II").click();
  await expect(assembler).toContainText("制造台 Mk.II");
  await expect(page.locator(".inspector-identity")).toContainText("制造台 Mk.II ×1");
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);

  await page.locator(".react-flow__edge").evaluate((element: SVGGElement) => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await expect(page.locator(".inspector-content")).toContainText("传送带等级");
  await expect(page.getByTitle("升级为传送带 Mk.II")).toBeEnabled();
  await page.getByTitle("升级为传送带 Mk.II").click();
  await expect(page.locator(".inspector-content")).toContainText("Mk.II");
  await expect(page.locator(".inspector-content")).toContainText("12/s");
  await expect(page.locator(".react-flow__edge-text")).toContainText("Mk.II");
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  await page.screenshot({ path: "artifacts/qa/equipment-upgrade-1440.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".equipment-upgrade--belt")).toBeVisible();
  await expect(page.locator(".inspector-panel").evaluate((element) => element.scrollWidth <= element.clientWidth)).resolves.toBe(true);
  await page.screenshot({ path: "artifacts/qa/equipment-upgrade-390.png", fullPage: true });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("tab", { name: "基础制造" }).click();
  await expect(page.locator(".fabricator-row").filter({ hasText: "位面熔炉" })).toHaveCount(1);
  await expect(page.locator(".fabricator-row").filter({ hasText: "制造台 Mk.III" })).toHaveCount(1);
  await expect(page.locator(".fabricator-row").filter({ hasText: "传送带 Mk.III" })).toHaveCount(1);

  await page.getByLabel("打开科技树").click();
  for (const technology of ["高速装配工艺", "高速物流系统", "高效采矿 I", "位面冶金", "量子打印技术", "超级磁场物流"]) {
    await expect(page.locator(".technology-node").filter({ has: page.getByText(technology, { exact: true }) })).toHaveCount(1);
  }
  await page.screenshot({ path: "artifacts/qa/industry-upgrade-technologies-1440.png", fullPage: true });
});

test("completed matrix research keeps connected color ports while the lab moves", async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1280, height: 820 });
  await openResearchLineRegressionGame(page);
  await page.locator(".react-flow__controls-fitview").click();
  const lab = page.locator(".machine-node").filter({ hasText: "科研模式" });
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
  await expect(lab.getByTitle("投入电磁矩阵")).toBeVisible();
  await expect(lab.getByTitle("投入能量矩阵")).toBeVisible();
  await expect(lab).toContainText("未选择科技", { timeout: 5000 });

  const header = lab.locator(".factory-node__header");
  const bounds = await header.boundingBox();
  await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + bounds!.width / 2 + 150, bounds!.y + bounds!.height / 2 - 100, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(300);

  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
  await expect(lab.getByTitle("投入电磁矩阵")).toBeVisible();
  await expect(lab.getByTitle("投入能量矩阵")).toBeVisible();
  await page.locator(".react-flow__controls-fitview").click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: "artifacts/qa/research-lines-persist-1280.png" });
});

test("production statistics exposes item flow, power demand and bottlenecks", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await freshGame(page);
  const canvas = page.locator(".react-flow__pane");
  const box = await canvas.boundingBox();
  await placeOnCanvas(page, "部署电弧熔炉", Math.round(box!.width * 0.84), 80);
  await page.getByLabel("打开生产统计").click();
  const workspace = page.getByRole("dialog", { name: "生产统计" });
  await expect(workspace).toBeVisible();
  await expect(workspace.locator(".statistics-row").filter({ hasText: "铁矿石" })).toBeVisible();
  await page.screenshot({ path: "artifacts/qa/production-flow-statistics-1280.png", fullPage: true });
  await workspace.getByLabel("筛选统计物品").fill("铁矿石");
  await expect(workspace.locator(".statistics-row")).toHaveCount(1);

  await workspace.getByRole("tab", { name: "电力" }).click();
  await expect(workspace.locator(".consumer-row").filter({ hasText: "电弧熔炉" })).toContainText("360 kW");
  await workspace.getByRole("tab", { name: /瓶颈/ }).click();
  await expect(workspace.locator(".issue-row").filter({ hasText: "电弧熔炉" })).toContainText("缺少铁矿石");
  await page.screenshot({ path: "artifacts/qa/production-statistics-1280.png", fullPage: true });
});

test("production statistics remains usable on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await freshGame(page);
  await page.getByLabel("更多工作区").click();
  await page.getByRole("menuitem", { name: "生产统计" }).click();
  const workspace = page.getByRole("dialog", { name: "生产统计" });
  await expect(workspace.getByRole("tab", { name: "生产" })).toBeVisible();
  await expect(workspace.locator(".statistics-filter")).toBeVisible();
  await workspace.getByLabel("筛选统计物品").fill("不存在的物品");
  const emptyState = workspace.locator(".statistics-empty");
  await expect(emptyState).toContainText("没有符合条件的物品");
  await expect.poll(async () => workspace.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect.poll(async () => emptyState.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return bounds.left >= 0 && bounds.right <= window.innerWidth;
  })).toBe(true);
  await page.screenshot({ path: "artifacts/qa/mobile-statistics-390.png", fullPage: true });
  await workspace.getByRole("tab", { name: /瓶颈/ }).click();
  await expect(workspace.locator(".statistics-empty")).toContainText("生产网络运行正常");
});

test("production management traces devices and supports cross-surface batch controls", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await freshGame(page);
  const canvas = page.locator(".react-flow__pane");
  const box = await canvas.boundingBox();
  await placeOnCanvas(page, "部署电弧熔炉", Math.round(box!.width * 0.82), 90);
  await page.getByLabel("打开生产统计").click();
  const workspace = page.getByRole("dialog", { name: "生产统计" });
  await workspace.getByRole("tab", { name: "管理" }).click();
  await expect(workspace.locator(".production-management-summary")).toContainText("全星球设备");
  const smelter = workspace.locator(".production-management-row").filter({ hasText: "电弧熔炉" });
  await expect(smelter).toContainText("未连接输入线路");
  await smelter.locator('input[type="checkbox"]').check();
  await workspace.getByLabel("选择当前配方").click();
  const picker = page.getByRole("dialog", { name: "配方选择面板" });
  await picker.locator(".recipe-catalog-grid > button").filter({ hasText: "铜块" }).click();
  await workspace.getByRole("button", { name: "应用兼容设备" }).click();
  await expect(smelter).toContainText("铜块");
  await smelter.getByText("展开物料路径").click();
  await expect(smelter).toContainText("原料源");
  await page.waitForTimeout(220);
  await page.screenshot({ path: "artifacts/qa/production-management-1440.png", fullPage: true });

  await workspace.getByLabel("定位电弧熔炉").click();
  await expect(workspace).toHaveCount(0);
  await expect(page.locator(".inspector-panel")).toContainText("电弧熔炉");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel("更多工作区").click();
  await page.getByRole("menuitem", { name: "生产统计" }).click();
  const mobileWorkspace = page.getByRole("dialog", { name: "生产统计" });
  await mobileWorkspace.getByRole("tab", { name: "管理" }).click();
  await expect(mobileWorkspace.locator(".production-management-row")).toBeVisible();
  await mobileWorkspace.locator(".production-management-row").filter({ hasText: "电弧熔炉" }).locator('input[type="checkbox"]').check();
  await mobileWorkspace.getByLabel("选择当前配方").click();
  const mobileRecipePicker = page.getByRole("dialog", { name: "配方选择面板" });
  await expect(mobileRecipePicker).toBeVisible();
  await expect(mobileRecipePicker.getByLabel("搜索配方")).not.toBeFocused();
  await mobileRecipePicker.getByRole("button", { name: "关闭配方选择" }).click();
  for (const scale of [0.8, 1, 1.25, 1.5, 2]) {
    await page.evaluate((value) => document.documentElement.style.setProperty("--ui-font-scale", String(value)), scale);
    await expect.poll(async () => mobileWorkspace.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
  await page.evaluate(() => document.documentElement.style.setProperty("--ui-font-scale", "1"));
  await expect.poll(async () => mobileWorkspace.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.waitForTimeout(220);
  await page.screenshot({ path: "artifacts/qa/production-management-390.png", fullPage: true });

  await page.setViewportSize({ width: 844, height: 390 });
  await expect(mobileWorkspace.locator(".production-management-row")).toBeVisible();
  await expect.poll(async () => mobileWorkspace.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.waitForTimeout(220);
  await page.screenshot({ path: "artifacts/qa/production-management-844x390.png", fullPage: true });
});

test("the production workspace fits a medium desktop", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await freshGame(page);
  await expect(page.locator(".factory-canvas")).toBeVisible();
  await expect(page.locator(".tray-row").filter({ hasText: "铁矿石" })).toContainText("100");
  await expect(page.locator(".tray-row").filter({ hasText: "铜矿石" })).toContainText("100");
  await expect(page.locator(".tray-row").filter({ hasText: "石矿" })).toContainText("100");
  await expect(page.getByTitle("完成星际物流系统科技后开放")).toHaveCount(2);
  await expect(page.getByTitle("部署风力涡轮机")).toBeVisible();
  await expect(page.getByRole("tab", { name: "基础制造" })).toBeVisible();
  const smelter = page.locator(".construction-item-shell").filter({ hasText: "电弧熔炉" });
  await expect(smelter.getByLabel("制造电弧熔炉")).toHaveClass(/construction-item-craft--upstream/);
  await smelter.getByLabel("制造电弧熔炉").click();
  await expect(smelter.locator(".construction-item > strong")).toHaveText("×4");
  await expect(page.locator(".interaction-burst")).toContainText("已消耗");
  await page.screenshot({ path: "artifacts/qa/factory-network-1280.png", fullPage: true });
});

test("a gray construction hammer opens the true raw-resource shortage instead of an unrelated recipe", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openDisabledHammerGame(page);
  const smelter = page.locator(".construction-item-shell").filter({ hasText: "电弧熔炉" });
  const hammer = smelter.getByLabel("制造电弧熔炉");
  await expect(hammer).toHaveClass(/construction-item-craft--disabled/);
  await expect(hammer).toHaveCSS("color", "rgb(101, 112, 107)");
  await hammer.click();
  const library = page.getByRole("dialog", { name: "生产资料库" });
  await expect(library).toBeVisible();
  await expect(library).toContainText("铁矿石");
  await expect(page.locator(".game-notice")).toContainText("铁矿石属于原始资源");
});

test("construction automation and three-input delivery stay usable across desktop and mobile", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openConstructionAutomationGame(page);
  await page.locator(".react-flow__controls-fitview").click();

  const hub = page.locator(".logistics-node").filter({ hasText: "物资配送枢纽" });
  await expect(hub.locator(".delivery-hub-target")).toHaveCount(3);
  await expect(hub).toContainText("3/3 接口");
  await expect(page.locator(".tray-row").filter({ hasText: "铜块" })).toContainText("5");

  const center = page.locator(".machine-node").filter({ hasText: "建筑制造中心" });
  await expect(center).toHaveClass(/factory-node--megastructure/);
  await expect(center.locator(".construction-center-core")).toContainText("行星建筑制造阵列 Mk.I");
  for (const scale of [80, 100, 125, 150, 200]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.uiFontScale = String(value);
      document.documentElement.style.setProperty("--ui-font-scale", String(value / 100));
    }, scale);
    const centerBounds = await center.boundingBox();
    const ordinaryBounds = await page.locator(".power-node").boundingBox();
    expect(centerBounds!.width, `${scale}% megastructure width`).toBeGreaterThanOrEqual(ordinaryBounds!.width * 1.9);
    expect(centerBounds!.height, `${scale}% megastructure height`).toBeGreaterThanOrEqual(ordinaryBounds!.height * 1.65);
    await expect(center.evaluate((element) => element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight)).resolves.toBe(true);
  }
  await page.evaluate(() => {
    document.documentElement.dataset.uiFontScale = "100";
    document.documentElement.style.setProperty("--ui-font-scale", "1");
  });
  await page.locator(".react-flow__controls-fitview").click();
  await page.screenshot({ path: "artifacts/qa/construction-center-node-1440.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    document.documentElement.dataset.uiFontScale = "200";
    document.documentElement.style.setProperty("--ui-font-scale", "2");
  });
  await page.locator(".react-flow__controls-fitview").click();
  await expect(center.locator(".construction-center-core")).toContainText("行星建筑制造阵列 Mk.I");
  await expect(center.evaluate((element) => element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight)).resolves.toBe(true);
  await page.screenshot({ path: "artifacts/qa/construction-center-node-390-font200.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    document.documentElement.dataset.uiFontScale = "100";
    document.documentElement.style.setProperty("--ui-font-scale", "1");
  });
  await page.locator(".react-flow__controls-fitview").click();
  await center.click();
  await page.locator(".construction-center-open").click();
  const workspace = page.getByRole("dialog", { name: "建筑制造中心" });
  await expect(workspace).toBeVisible();
  const smelterTarget = workspace.getByRole("textbox", { name: "电弧熔炉目标库存", exact: true });
  await smelterTarget.fill("2");
  await expect(smelterTarget).toHaveValue("2");
  await expect(workspace.locator(".construction-center-status")).toContainText("澄海 I");
  await expect.poll(async () => workspace.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/construction-center-1440.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(workspace.getByLabel("关闭建筑制造中心")).toBeVisible();
  await expect.poll(async () => workspace.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/construction-center-390.png", fullPage: true });

  await page.setViewportSize({ width: 844, height: 390 });
  await expect(workspace.getByLabel("关闭建筑制造中心")).toBeVisible();
  await expect.poll(async () => workspace.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/construction-center-844x390.png", fullPage: true });
});

test("starter kit and logistics controls are available on the production canvas", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSeededGame(page);

  await expect(page.getByTitle("部署风力涡轮机")).toContainText("×3");
  await expect(page.getByTitle("部署采矿机")).toContainText("×2");
  await expect(page.getByTitle("部署电弧熔炉")).toContainText("×3");
  await expect(page.getByTitle("部署制造台 Mk.I", { exact: true })).toContainText("×3");
  await expect(page.getByTitle("部署矩阵研究站")).toContainText("×2");
  await expect(page.getByTitle("选择传送带 Mk.I连接节点端口", { exact: true })).toContainText("×10");
  await expect(page.locator(".vein-node").filter({ hasText: "原油" })).toBeVisible();

  const canvas = page.locator(".react-flow__pane");
  const box = await canvas.boundingBox();
  await placeOnCanvas(page, "部署小型储物仓", Math.round(box!.width * 0.7), 210);
  const storage = page.locator(".logistics-node").filter({ hasText: "小型储物仓" });
  await storage.click();
  const storageInspector = page.locator(".inspector-panel .inspector-content");
  await expect(storageInspector).toContainText("小型储物仓");
  await chooseItem(page, storageInspector.locator(".recipe-select"), "铁矿石");
  await expect(storage).toContainText("铁矿石");
  await expect(storage.locator(".factory-handle--input")).toHaveCount(1);
  await expect(storage.locator('[data-handleid="in:iron_ore"]')).toHaveCount(1);
  await expect(storage.locator(".factory-handle--input.factory-handle--auto")).toHaveCount(0);
  await expect(storage.locator(".factory-handle--output")).toHaveCount(1);
  await expect(storage.locator(".factory-node__header strong")).toHaveText("小型储物仓");
  await expect(storage.locator(".node-io__label")).toHaveText(["输入", "输出"]);
  await page.evaluate(() => {
    document.documentElement.dataset.uiFontScale = "200";
    document.documentElement.style.setProperty("--ui-font-scale", "2");
  });
  await expect.poll(() => storage.evaluate((element) => {
    const name = element.querySelector<HTMLElement>(".factory-node__header strong");
    const columns = [...element.querySelectorAll<HTMLElement>(".node-io__column")].map((column) => column.getBoundingClientRect());
    const separated = columns.length === 2 && (columns[0].right <= columns[1].left + 1 || columns[0].bottom <= columns[1].top + 1);
    return Boolean(name && name.textContent === "小型储物仓" && name.scrollHeight <= name.clientHeight + 1 && separated);
  })).toBe(true);
  await page.screenshot({ path: "artifacts/qa/storage-mk1-font-200-1440.png", fullPage: true });
  await page.evaluate(() => {
    document.documentElement.dataset.uiFontScale = "100";
    document.documentElement.style.setProperty("--ui-font-scale", "1");
  });

  await placeOnCanvas(page, "部署储液罐", Math.round(box!.width * 0.42), 450);
  const tank = page.locator(".logistics-node").filter({ hasText: "储液罐" });
  await tank.locator(".factory-node__header").click();
  await chooseItem(page, page.locator(".inspector-panel .inspector-content").locator(".recipe-select"), "水");
  await expect(tank.locator(".factory-node__header strong")).toHaveText("储液罐");
  await expect(tank.locator(".node-io__label")).toHaveText(["输入", "输出"]);
  await expect(tank).toContainText("水");
  await page.evaluate(() => {
    document.documentElement.dataset.uiFontScale = "200";
    document.documentElement.style.setProperty("--ui-font-scale", "2");
  });
  await expect.poll(() => tank.evaluate((element) => {
    const name = element.querySelector<HTMLElement>(".factory-node__header strong");
    const columns = [...element.querySelectorAll<HTMLElement>(".node-io__column")].map((column) => column.getBoundingClientRect());
    const separated = columns.length === 2 && (columns[0].right <= columns[1].left + 1 || columns[0].bottom <= columns[1].top + 1);
    return Boolean(name && name.textContent === "储液罐" && name.scrollHeight <= name.clientHeight + 1 && separated);
  })).toBe(true);
  await page.evaluate(() => {
    document.documentElement.dataset.uiFontScale = "100";
    document.documentElement.style.setProperty("--ui-font-scale", "1");
  });

  await placeOnCanvas(page, "部署四向分流器", Math.round(box!.width * 0.7), 450);
  const splitter = page.locator(".logistics-node").filter({ hasText: "四向分流器" });
  await splitter.locator(".factory-node__header").click({ position: { x: 24, y: 18 } });
  const splitterInspector = page.locator(".inspector-panel .inspector-content");
  await expect(splitterInspector).toContainText("四向分流器");
  await chooseItem(page, splitterInspector.locator(".recipe-select"), "铁矿石");
  await page.getByRole("button", { name: "优先线路" }).click();
  await expect(splitter).toContainText("优先分流");

  await page.getByTitle("部署原油萃取站").click();
  const oilVein = page.locator(".vein-node").filter({ hasText: "原油" });
  await oilVein.click();
  await expect(oilVein).toContainText("×1");
  await oilVein.click();
  await page.locator(".inspector-panel").getByRole("button", { name: "回收全部采矿机 ×1" }).click();
  await expect(oilVein).toContainText("×0");
  await expect(page.getByTitle("部署原油萃取站")).toContainText("×1");
  await page.screenshot({ path: "artifacts/qa/logistics-oil-1440.png", fullPage: true });
});

test("finite resource nodes, inspector and reserve statistics use the same depletion model", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await freshGame(page);
  await page.locator(".react-flow__controls-fitview").click();
  const iron = page.locator(".vein-node").filter({ hasText: "铁矿石" }).first();
  await expect(iron.locator(".factory-node__header > small")).not.toHaveText("∞");
  await expect(iron.locator(".vein-reserve")).toContainText("储量");
  await iron.click();
  const inspector = page.locator(".inspector-panel");
  await expect(inspector).toContainText("有限资源矿脉");
  await expect(inspector).toContainText("剩余储量");
  await expect(inspector).toContainText("初始总量");
  await expect(inspector).toContainText("剩余比例");
  await page.getByLabel("打开生产统计").click();
  const statistics = page.getByRole("dialog", { name: "生产统计" });
  await statistics.getByRole("tab", { name: "电力" }).click();
  await expect(statistics).toContainText("资源储量统计");
  await expect(statistics.locator(".resource-reserve-ledger")).toContainText("有限资源");
  await page.screenshot({ path: "artifacts/qa/finite-resource-reserve-1440.png", fullPage: true });
});

test("thermal power accepts fuel and responds to mining demand", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSeededGame(page);
  const canvas = page.locator(".react-flow__pane");
  const box = await canvas.boundingBox();
  await placeOnCanvas(page, "部署火力发电厂", Math.round(box!.width * 0.7), 210);
  const plant = page.locator(".thermal-node");
  await plant.click();
  await plant.locator(".node-inline-select select").selectOption("coal");

  await page.locator(".tray-row").filter({ hasText: "煤矿" }).click();
  await plant.getByTitle("投入煤矿").click();
  const ironVein = page.locator(".vein-node").filter({ hasText: "铁矿石" });
  await page.getByTitle("部署采矿机").click();
  await ironVein.click();

  await expect.poll(async () => plant.textContent()).toContain("燃烧发电中");
  await expect.poll(async () => Number((await plant.locator(".power-output .power-value").first().getAttribute("aria-label"))?.replace(/[^\d.-]/g, ""))).toBeGreaterThan(0);
  await page.screenshot({ path: "artifacts/qa/thermal-power-1440.png", fullPage: true });
});

test("spray coating closes the Mk.III proliferator logistics and extra-output loop", async ({ page }) => {
  test.setTimeout(45_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openProliferatorStageGame(page);
  await page.locator(".react-flow__controls-fitview").click();

  const assembler = page.locator(".machine-node").filter({ hasText: "齿轮" });
  await assembler.click();
  const inspector = page.locator(".inspector-panel");
  await expect(inspector.locator(".proliferator-control")).toContainText("模块未安装");
  await inspector.getByRole("button", { name: "安装喷涂模块" }).click();
  await inspector.locator(".proliferator-tier").getByRole("button", { name: "Mk.III" }).click();
  await inspector.locator(".proliferator-mode").getByRole("button", { name: "增产" }).click();
  await expect(assembler.locator(".proliferator-readout")).toContainText("额外产出 · Mk.III");
  await expect(assembler.getByTitle("投入增产剂 Mk.III")).toBeVisible();

  const storage = page.locator(".logistics-node").filter({ hasText: "增产剂 Mk.III" });
  const source = storage.locator(".factory-handle--output");
  const target = assembler.locator(".node-port--input").filter({ hasText: "增产剂 Mk.III" }).locator(".factory-handle--input");
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  expect(sourceBox).not.toBeNull();
  expect(targetBox).not.toBeNull();
  await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2, { steps: 12 });
  await page.waitForTimeout(120);
  await page.mouse.up();
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);

  await page.getByLabel("继续模拟").click();
  const gearOutput = assembler.getByTitle("拿取齿轮");
  await expect.poll(async () => Number(await gearOutput.locator("strong").textContent()), { timeout: 12_000 }).toBeGreaterThanOrEqual(5);
  await expect.poll(async () => Number(await gearOutput.locator("strong").textContent()) % 1).toBe(0);
  await expect(assembler.locator(".proliferator-readout strong")).not.toHaveText("0 点");
  await page.locator(".react-flow__controls-zoomin").click();
  await page.locator(".react-flow__controls-zoomin").click();
  await page.screenshot({ path: "artifacts/qa/proliferator-loop-1440.png", fullPage: true });

  await page.getByLabel("打开生产统计").click();
  const statistics = page.getByRole("dialog", { name: "生产统计" });
  await expect(statistics.locator(".statistics-row").filter({ hasText: "增产剂 Mk.III" })).toBeVisible();
  await expect(statistics.locator(".statistics-row").filter({ hasText: "齿轮" })).toBeVisible();
  await statistics.getByLabel("关闭生产统计").click();

  await assembler.click();
  await expect(inspector.locator(".proliferator-control")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  if (!await inspector.locator(".proliferator-control").isVisible()) {
    await page.getByLabel("打开检查器").click();
  }
  await expect(inspector.locator(".proliferator-control")).toBeVisible();
  await inspector.locator(".proliferator-control").scrollIntoViewIfNeeded();
  await expect.poll(async () => inspector.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/proliferator-loop-390.png", fullPage: true });
});

test("a chemical plant accepts plastic, refined oil and water transport lines together", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openChemicalRoutingGame(page);
  await page.locator(".react-flow__controls-fitview").click();
  const chemical = page.locator('.react-flow__node[data-id="organic_chemical"] .machine-node');
  await chemical.click();
  await chooseRecipe(page, chemical, "有机晶体");
  await expect(chemical).toContainText("有机晶体");
  await expect(chemical.getByTitle("投入塑料")).toBeVisible();
  await expect(chemical.getByTitle("投入精炼油")).toBeVisible();
  await expect(chemical.getByTitle("投入水")).toBeVisible();

  const connect = async (sourceId: string, itemText: string, expectedEdges: number) => {
    const source = page.locator(`.react-flow__node[data-id="${sourceId}"]`).locator(".node-port").filter({ hasText: itemText }).locator(".factory-handle--output");
    const target = chemical.locator(".node-port--input").filter({ hasText: itemText }).locator(".factory-handle--input");
    const sourceBox = await source.boundingBox();
    const targetBox = await target.boundingBox();
    expect(sourceBox).not.toBeNull();
    expect(targetBox).not.toBeNull();
    await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2, { steps: 12 });
    await page.waitForTimeout(600);
    await page.mouse.up();
    await expect(page.locator(".react-flow__edge")).toHaveCount(expectedEdges);
  };

  await connect("plastic_source", "塑料", 1);
  await connect("oil_source", "精炼油", 2);
  await connect("water_source", "水", 3);
  await expect(page.locator(".factory-edge--active")).toHaveCount(3);
  await expect.poll(async () => page.locator(".factory-edge--active .react-flow__edge-path").first().evaluate((element) => getComputedStyle(element).animationName)).toContain("factory-belt-flow");
  const layerZIndexes = await page.evaluate(() => Object.fromEntries([
    ["edgeHitLayer", ".react-flow__edges"],
    ["visibleEdges", ".factory-edge-visual-layer"],
    ["labels", ".react-flow__edgelabel-renderer"],
    ["nodes", ".react-flow__nodes"],
  ].map(([key, selector]) => [key, Number.parseInt(getComputedStyle(document.querySelector(selector)!).zIndex || "0", 10)])));
  expect(layerZIndexes.edgeHitLayer).toBeLessThan(layerZIndexes.nodes);
  expect(layerZIndexes.visibleEdges).toBeLessThan(layerZIndexes.nodes);
  expect(layerZIndexes.labels).toBeLessThan(layerZIndexes.nodes);
  await expect(page.getByTitle("选择传送带 Mk.I连接节点端口", { exact: true })).toContainText("×0");
  await page.screenshot({ path: "artifacts/qa/chemical-three-input-routing-1440.png", fullPage: true });
});

test("a second titanium alloy input line transfers after the first line", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openTitaniumRoutingGame(page);
  await page.locator(".react-flow__controls-fitview").click();
  const target = page.locator('.react-flow__node[data-id="alloy_target"] .machine-node');
  const connect = async (sourceId: string, itemText: string, expectedEdges: number) => {
    const source = page.locator(`.react-flow__node[data-id="${sourceId}"]`).locator(".node-port").filter({ hasText: itemText }).locator(".factory-handle--output");
    const input = target.locator(".node-port--input").filter({ hasText: itemText }).locator(".factory-handle--input");
    const sourceBox = await source.boundingBox();
    const inputBox = await input.boundingBox();
    expect(sourceBox).not.toBeNull();
    expect(inputBox).not.toBeNull();
    await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(inputBox!.x + inputBox!.width / 2, inputBox!.y + inputBox!.height / 2, { steps: 12 });
    await page.waitForTimeout(400);
    await page.mouse.up();
    await expect(page.locator(".react-flow__edge")).toHaveCount(expectedEdges);
  };
  await connect("steel_source", "钢材", 1);
  await connect("titanium_source", "钛块", 2);
  await connect("acid_source", "硫酸", 3);
  await page.waitForTimeout(2_500);
  await expect.poll(async () => Number(await target.locator(".node-port--input").filter({ hasText: "钛块" }).locator("strong").textContent()), { timeout: 8_000 }).toBeGreaterThan(0);
  await expect.poll(async () => Number(await target.locator(".node-port--input").filter({ hasText: "钢材" }).locator("strong").textContent()), { timeout: 8_000 }).toBeGreaterThan(0);
  await expect.poll(async () => Number(await target.locator(".node-port--input").filter({ hasText: "硫酸" }).locator("strong").textContent()), { timeout: 8_000 }).toBeGreaterThan(0);
});

test("rapid consecutive belt drags keep the second connection instead of using stale stock", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openTitaniumRoutingGame(page);
  await page.locator(".react-flow__controls-fitview").click();
  const target = page.locator('.react-flow__node[data-id="alloy_target"] .machine-node');
  const dragConnection = async (sourceId: string, itemText: string) => {
    const source = page.locator(`.react-flow__node[data-id="${sourceId}"]`).locator(".node-port").filter({ hasText: itemText }).locator(".factory-handle--output");
    const input = target.locator(".node-port--input").filter({ hasText: itemText }).locator(".factory-handle--input");
    const sourceBox = await source.boundingBox();
    const inputBox = await input.boundingBox();
    await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(inputBox!.x + inputBox!.width / 2, inputBox!.y + inputBox!.height / 2, { steps: 8 });
    await page.mouse.up();
  };
  await dragConnection("steel_source", "钢材");
  await dragConnection("titanium_source", "钛块");
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
  await expect(page.getByRole("status")).not.toContainText("运输线未建立");
});

test("multi-slot station outputs connect beyond the first slot and expose belt feedback", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openMultiSlotStationRoutingGame(page);
  await page.locator(".react-flow__controls-fitview").click();
  const station = page.locator('.react-flow__node[data-id="multi_station"]');
  const alloy = page.locator('.react-flow__node[data-id="multi_alloy"]');
  const chemical = page.locator('.react-flow__node[data-id="multi_chemical"]');
  await expect(station.locator(".factory-handle--output")).toHaveCount(3);
  await expect(station.getByTitle("拿取钛块")).toBeVisible();
  await expect(station.getByTitle("拿取硫酸")).toBeVisible();

  const dragConnection = async (sourceNode: Locator, itemText: string, targetNode: Locator, expectedEdges: number, inspectGhost = false, targetItemText = itemText) => {
    const source = sourceNode.locator(".node-port").filter({ hasText: itemText }).locator(".factory-handle--output");
    const target = targetNode.locator(".node-port").filter({ hasText: targetItemText }).locator(".factory-handle--input");
    const sourceBox = await source.boundingBox();
    const targetBox = await target.boundingBox();
    expect(sourceBox).not.toBeNull();
    expect(targetBox).not.toBeNull();
    await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2);
    await page.mouse.down();
    if (inspectGhost) {
      await page.mouse.move(sourceBox!.x + 70, sourceBox!.y - 55, { steps: 6 });
      const preview = page.locator(".factory-connection-preview");
      await expect(preview).toHaveClass(/factory-connection-preview--pending/);
      await expect(preview.locator(".factory-connection-preview__path")).toHaveCSS("stroke", "rgb(121, 217, 202)");
    }
    await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2, { steps: 12 });
    const expectedTone = itemText === targetItemText ? "valid" : "invalid";
    const expectedColor = expectedTone === "valid" ? "rgb(141, 224, 169)" : "rgb(239, 155, 143)";
    const preview = page.locator(".factory-connection-preview");
    await expect(preview).toHaveClass(new RegExp(`factory-connection-preview--${expectedTone}`));
    await expect(preview.locator(".factory-connection-preview__path")).toHaveCSS("stroke", expectedColor);
    if (inspectGhost) await page.screenshot({ path: "artifacts/qa/connection-preview-valid-1440.png", fullPage: true });
    await page.mouse.up();
    await expect(page.locator(".react-flow__edge")).toHaveCount(expectedEdges);
  };

  await dragConnection(station, "钛块", alloy, 1, true);
  await expect(page.locator(".factory-edge-label > span")).toHaveText(["Mk.III"]);
  await dragConnection(station, "硫酸", chemical, 2);
  await expect(page.locator(".factory-edge-label > span")).toHaveText(["Mk.III", "Mk.II"]);
  await expect(page.getByRole("status")).toContainText("硫酸运输线已建立");

  // A mismatched release must leave an explicit failure instead of silently
  // discarding the drag.
  await dragConnection(station, "钛块", chemical, 2, false, "硫酸");
  await expect(page.getByRole("status")).toContainText("运输线未建立");
});

test("automatic belt selection reuses an existing parallel line tier", async ({ page }) => {
  await page.addInitScript(() => {
    const base = { planetId: "home", machineCount: 1, minerCount: 0, inputs: {}, outputs: {}, progress: 0, routingCursor: 0, utilization: 0, productionRate: 0 };
    const state = {
      version: 23,
      nextId: 4,
      activePlanetId: "home",
      entities: [
        { ...base, id: "parallel_source", kind: "storage", position: { x: 0, y: 0 }, buildingId: "storage_mk1", storedItemId: "iron_ingot", outputs: { iron_ingot: 20 } },
        { ...base, id: "parallel_target", kind: "machine", position: { x: 460, y: 0 }, buildingId: "assembling_machine_mk1", recipeId: "gear" },
      ],
      belts: [{ id: "parallel_belt", planetId: "home", source: "parallel_source", target: "parallel_target", itemId: "iron_ingot", lanes: 1, tier: 2, sorterTier: 1, progress: 0, priority: 0, stackSize: 1, monitorEnabled: false, totalTransferred: 0, congestion: 0, lastFlow: 0 }],
      construction: { conveyor_belt_mk1: 5, conveyor_belt_mk2: 1, conveyor_belt_mk3: 2 },
      tray: {},
      planetTrays: { home: {} },
      totalProduced: {},
      research: { selectedTechId: null, queuedTechIds: [], progressByTech: {}, completedTechIds: ["basic_assembling", "basic_logistics", "high_speed_logistics", "super_magnetic_logistics"] },
      paused: true,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.locator(".react-flow__controls-fitview").click();
  await expect(page.locator(".dock-belt-auto")).toHaveClass(/active/);
  const source = page.locator('.react-flow__node[data-id="parallel_source"] .factory-handle--output');
  const target = page.locator('.react-flow__node[data-id="parallel_target"] .factory-handle--input');
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  expect(sourceBox).not.toBeNull();
  expect(targetBox).not.toBeNull();
  await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  await expect(page.getByRole("status")).toContainText("Mk.II");
  await expect(page.locator(".factory-edge-label")).toContainText("Mk.II");
});

test("a single port click arms a live connection preview and reveals automatic targets", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openMultiSlotStationRoutingGame(page);
  await page.locator(".react-flow__controls-fitview").click();
  const station = page.locator('.react-flow__node[data-id="multi_station"]');
  const alloy = page.locator('.react-flow__node[data-id="multi_alloy"]');
  const chemical = page.locator('.react-flow__node[data-id="multi_chemical"]');
  const source = station.locator(".node-port").filter({ hasText: "钛块" }).locator(".factory-handle--output");
  const validTarget = alloy.locator(".node-port--input").filter({ hasText: "钛块" }).locator(".factory-handle--input");
  const invalidTarget = chemical.locator(".node-port--input").filter({ hasText: "硫酸" }).locator(".factory-handle--input");

  await expect(page.locator(".factory-handle--auto")).toHaveCount(0);
  await source.click();
  const clickPreview = page.locator(".factory-click-connection-preview");
  await expect(clickPreview).toBeVisible();
  await expect(clickPreview.locator(".factory-connection-preview")).toHaveClass(/factory-connection-preview--pending/);
  await expect(page.getByText("自动选择配方", { exact: true })).toHaveCount(2);
  await expect(station).toHaveClass(/factory-flow-node--connection-origin/);
  await expect(alloy).toHaveClass(/factory-flow-node--connection-candidate/);
  await expect(chemical).not.toHaveClass(/factory-flow-node--connection-candidate/);

  const blankPoint = await page.evaluate(() => {
    const pane = document.querySelector<HTMLElement>(".react-flow__pane");
    if (!pane) return null;
    const bounds = pane.getBoundingClientRect();
    for (let y = bounds.top + 30; y < bounds.bottom - 30; y += 24) {
      for (let x = bounds.left + 30; x < bounds.right - 30; x += 24) {
        if (document.elementFromPoint(x, y) === pane) return { x, y };
      }
    }
    return null;
  });
  expect(blankPoint).not.toBeNull();
  await page.mouse.click(blankPoint!.x, blankPoint!.y);
  await expect(clickPreview).toHaveCount(0);
  await expect(page.locator(".factory-flow-node--connection-origin, .factory-flow-node--connection-candidate")).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("已取消运输线连接");

  await source.click();
  await expect(clickPreview).toBeVisible();

  const invalidBox = await invalidTarget.boundingBox();
  expect(invalidBox).not.toBeNull();
  await page.mouse.move(invalidBox!.x + invalidBox!.width / 2, invalidBox!.y + invalidBox!.height / 2, { steps: 8 });
  await expect(clickPreview.locator(".factory-connection-preview")).toHaveClass(/factory-connection-preview--invalid/);

  const targetBox = await validTarget.boundingBox();
  expect(targetBox).not.toBeNull();
  const targetPoint = { x: targetBox!.x + targetBox!.width / 2, y: targetBox!.y + targetBox!.height / 2 };
  await page.mouse.move(targetPoint.x, targetPoint.y, { steps: 8 });
  await expect(clickPreview.locator(".factory-connection-preview")).toHaveClass(/factory-connection-preview--valid/);
  await expect.poll(async () => Number(await clickPreview.locator(".factory-connection-preview__target").getAttribute("cx"))).toBeCloseTo(targetPoint.x, 0);
  await page.mouse.click(targetPoint.x, targetPoint.y);

  await expect(clickPreview).toHaveCount(0);
  await expect(page.locator(".factory-handle--auto")).toHaveCount(0);
  await expect(page.locator(".factory-flow-node--connection-origin, .factory-flow-node--connection-candidate")).toHaveCount(0);
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  await expect(page.getByRole("status")).toContainText(/钛块运输线已建立|成就解锁：物流脉搏/);
});

test("a reverse input connection highlights producing cards and Escape clears every candidate", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openMultiSlotStationRoutingGame(page);
  await page.locator(".react-flow__controls-fitview").click();
  const station = page.locator('.react-flow__node[data-id="multi_station"]');
  const alloy = page.locator('.react-flow__node[data-id="multi_alloy"]');
  const chemical = page.locator('.react-flow__node[data-id="multi_chemical"]');
  const target = alloy.locator(".node-port--input").filter({ hasText: "钛块" }).locator(".factory-handle--input");

  await target.click();
  await expect(page.locator(".factory-click-connection-preview")).toBeVisible();
  await expect(alloy).toHaveClass(/factory-flow-node--connection-origin/);
  await expect(station).toHaveClass(/factory-flow-node--connection-candidate/);
  await expect(chemical).not.toHaveClass(/factory-flow-node--connection-candidate/);

  await page.keyboard.press("Escape");
  await expect(page.locator(".factory-click-connection-preview")).toHaveCount(0);
  await expect(page.locator(".factory-flow-node--connection-origin, .factory-flow-node--connection-candidate")).toHaveCount(0);
});

test("a building card owns clicks where a belt passes behind it", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openEdgeOverlapGame(page);
  await page.locator(".react-flow__controls-fitview").click();
  const sourceHandle = page.locator('.react-flow__node[data-id="overlap_source"] .factory-handle--output');
  const targetHandle = page.locator('.react-flow__node[data-id="overlap_target"] [data-handleid="in:iron_ingot"]');
  const blocker = page.locator('.react-flow__node[data-id="overlap_blocker"]');
  const sourceBox = await sourceHandle.boundingBox();
  const targetBox = await targetHandle.boundingBox();
  const blockerBox = await blocker.boundingBox();
  expect(sourceBox).not.toBeNull();
  expect(targetBox).not.toBeNull();
  expect(blockerBox).not.toBeNull();
  const point = {
    x: blockerBox!.x + blockerBox!.width / 2,
    y: (sourceBox!.y + sourceBox!.height / 2 + targetBox!.y + targetBox!.height / 2) / 2,
  };
  expect(point.y).toBeGreaterThan(blockerBox!.y);
  expect(point.y).toBeLessThan(blockerBox!.y + blockerBox!.height);
  await expect.poll(async () => page.evaluate(({ x, y }) =>
    document.elementsFromPoint(x, y).some((element) => element.closest('.react-flow__node[data-id="overlap_blocker"]')), point)).toBe(true);
  await page.mouse.click(point.x, point.y);
  await expect(blocker).toHaveClass(/selected/);
  await expect(page.locator(".react-flow__edge.selected")).toHaveCount(0);
});

test("continuous belt networks diagnose, reroute, focus, synchronize and recycle as one", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBeltNetworkGame(page);
  await page.locator(".react-flow__controls-fitview").click();

  const edges = page.locator(".react-flow__edge");
  await expect(edges).toHaveCount(2);
  await page.getByLabel("打开生产网络总览").click();
  const statistics = page.getByRole("dialog", { name: "生产统计" });
  await expect(statistics.getByRole("tab", { name: /网络/ })).toHaveAttribute("aria-selected", "true");
  await expect(statistics.locator(".network-row")).toHaveCount(1);
  await statistics.getByLabel("吞吐热力图").check();
  await expect(page.locator(".game-shell")).toHaveAttribute("data-network-heatmap", "true");
  await statistics.locator(".network-row input[type=checkbox]").check();
  await statistics.getByLabel("批量线路路由").selectOption("lower");
  await statistics.getByRole("button", { name: "批量改道" }).click();
  await statistics.getByLabel("画布书签名称").fill("铁块主干");
  await statistics.getByLabel("保存当前画布视角").click();
  await expect(statistics.getByLabel("铁块主干名称")).toHaveValue("铁块主干");
  await page.screenshot({ path: "artifacts/qa/network-overview-3-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => statistics.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(statistics.locator(".network-row")).toBeVisible();
  await page.screenshot({ path: "artifacts/qa/network-overview-3-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await statistics.getByLabel("定位铁块网络").click();
  await expect(statistics).toHaveCount(0);

  await edges.first().evaluate((element: SVGGElement) => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  const inspector = page.locator(".inspector-panel");
  await expect(inspector.locator(".belt-network-diagnostic")).toContainText("连续网络诊断");
  await expect(inspector.locator(".belt-network-diagnostic")).toContainText("线路 2");

  const beforePath = await page.locator(".factory-edge-visual-path").first().getAttribute("d");
  await inspector.getByRole("button", { name: "手动", exact: true }).click();
  await inspector.locator(".belt-route-offset input").fill("240");
  await expect(inspector.locator(".belt-route-offset output")).toHaveText("240");
  const manualPath = await page.locator(".factory-edge-visual-path").first().getAttribute("d");
  expect(manualPath).not.toBe(beforePath);
  await inspector.getByRole("button", { name: "上绕", exact: true }).click();
  const afterPath = await page.locator(".factory-edge-visual-path").first().getAttribute("d");
  expect(afterPath).not.toBe(manualPath);
  await inspector.getByRole("button", { name: "高", exact: true }).click();
  await inspector.getByRole("button", { name: "设置应用整网" }).click();

  await edges.nth(1).evaluate((element: SVGGElement) => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await expect(inspector.getByRole("button", { name: "上绕", exact: true })).toHaveClass(/active/);
  await expect(inspector.getByRole("button", { name: "高", exact: true })).toHaveClass(/active/);
  await inspector.getByRole("button", { name: "聚焦上下游" }).click();
  await expect(page.locator('.react-flow__node[data-id="network_unrelated"]')).toHaveClass(/factory-flow-node--network-dim/);
  await expect(page.locator(".network-focus-indicator")).toContainText("2 线路");
  await page.screenshot({ path: "artifacts/qa/belt-network-3-desktop.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  if (!await page.locator(".game-shell").evaluate((element) => element.classList.contains("mobile-panel--inspector"))) {
    await page.getByLabel("打开检查器").click();
  }
  await expect(inspector.locator(".belt-network-diagnostic")).toBeVisible();
  await expect.poll(async () => inspector.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/belt-network-3-mobile.png", fullPage: true });
  await inspector.getByRole("button", { name: "回收整条网络 ×2" }).click();
  await expect(page.locator(".react-flow__edge")).toHaveCount(0);
  await expect(page.getByTitle("选择传送带 Mk.I连接节点端口")).toContainText("×4");
});

test("Dyson planner builds independent orbital layers across unlocked star systems", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openDysonPlannerGame(page);
  await page.getByTitle("打开戴森球规划").click();
  const planner = page.getByRole("dialog", { name: "戴森球规划" });
  await expect(planner).toBeVisible();
  await expect(planner.getByTitle("规划赫利俄斯戴森球")).toBeVisible();
  await expect(planner.getByTitle("规划北冕座戴森球")).toBeVisible();

  await planner.getByTitle("新建八节点闭合标准壳层").click();
  const summary = planner.locator(".dyson-stage-summary");
  await expect(summary.locator("span").filter({ hasText: "节点" })).toContainText("8");
  await expect(summary.locator("span").filter({ hasText: "框架" })).toContainText("8");
  await expect(summary.locator("span").filter({ hasText: "壳面" })).toContainText("8");
  await expect(planner.locator(".dyson-layer-list > button")).toHaveCount(1);

  const shellInspector = planner.locator(".dyson-layer-inspector");
  const radius = shellInspector.locator(":scope > .dyson-orbit-control").filter({ hasText: "轨道半径" });
  const inclination = shellInspector.locator(":scope > .dyson-orbit-control").filter({ hasText: "轨道倾角" });
  const longitude = shellInspector.locator(":scope > .dyson-orbit-control").filter({ hasText: "升交点经度" });
  await radius.locator("input").fill("20000");
  await inclination.locator("input").fill("37");
  await longitude.locator("input").fill("124");
  await expect(radius).toContainText("20,000 m");
  await expect(inclination).toContainText("37°");
  await expect(longitude).toContainText("124°");

  await planner.getByTitle("规划北冕座戴森球").click();
  await expect(planner.locator(".dyson-layer-list > button")).toHaveCount(0);
  await planner.getByTitle("新建八节点闭合标准壳层").click();
  await expect(planner.locator(".dyson-layer-list > button")).toHaveCount(1);
  await expect(planner.locator(".dyson-layer-inspector > header")).toContainText("标准壳层 1");

  await planner.getByTitle("规划赫利俄斯戴森球").click();
  await expect(radius.locator("input")).toHaveValue("20000");
  await expect(inclination.locator("input")).toHaveValue("37");
  await expect(longitude.locator("input")).toHaveValue("124");
  await expect(planner.locator(".dyson-orbit-node")).toHaveCount(8);

  const swarmInspector = planner.locator(".dyson-swarm-orbit-inspector");
  await expect(planner.locator(".dyson-swarm-orbit-list > button")).toHaveCount(1);
  await planner.getByText("新增太阳帆轨道", { exact: true }).click();
  await expect(planner.locator(".dyson-swarm-orbit-list > button")).toHaveCount(2);
  const swarmRadius = swarmInspector.locator(".dyson-orbit-control").filter({ hasText: "轨道半径" });
  const swarmInclination = swarmInspector.locator(".dyson-orbit-control").filter({ hasText: "轨道倾角" });
  const swarmLongitude = swarmInspector.locator(".dyson-orbit-control").filter({ hasText: "升交点经度" });
  await swarmRadius.locator("input").fill("28000");
  await swarmInclination.locator("input").fill("31");
  await swarmLongitude.locator("input").fill("122");
  await expect(swarmRadius).toContainText("28,000 m");
  await expect(swarmInclination).toContainText("31°");
  await expect(swarmLongitude).toContainText("122°");
  await planner.getByText("太阳帆", { exact: true }).click();
  await planner.getByText("50%", { exact: true }).click();
  await expect(planner.locator(".dyson-launch-mode button.active")).toHaveText("太阳帆");
  await expect(planner.locator(".dyson-launch-throttle button.active")).toHaveText("50%");
  const launchToggle = planner.getByRole("button", { name: "暂停戴森发射" });
  await expect(launchToggle).toHaveCount(1);
  await launchToggle.click();
  await expect(planner.getByRole("button", { name: "启用戴森发射" })).toHaveCount(1);
  await expect(planner.locator(".dyson-engineering-ledger")).toContainText("发射能耗");
  await page.screenshot({ path: "artifacts/qa/dyson-planner-1440.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await planner.locator(".dyson-orbit-stage").scrollIntoViewIfNeeded();
  await expect.poll(async () => planner.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await expect(planner.locator(".dyson-orbit-canvas")).toBeVisible();
  await page.screenshot({ path: "artifacts/qa/dyson-planner-390.png", fullPage: true });
});

test("galactic industry console runs infinite research and mega exports", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openEndgameStageGame(page);
  await page.getByLabel("打开生产统计").click();
  const statistics = page.getByRole("dialog", { name: "生产统计" });
  await statistics.getByRole("tab", { name: /银河/ }).click();
  await expect(statistics.locator(".galactic-summary-grid")).toContainText("银河评分");
  await expect(statistics.locator(".galactic-industry")).toContainText("银河物资出口");
  await expect(statistics.locator(".infinite-research-list > button")).toHaveCount(5);

  await statistics.locator(".infinite-research-list > button").filter({ hasText: "矩阵压缩" }).click();
  await expect(statistics.locator(".infinite-research-list > button.active")).toContainText("矩阵压缩");
  const archive = statistics.locator(".export-project-list > article").filter({ hasText: "宇宙矩阵档案" });
  await archive.getByRole("button", { name: /启用宇宙矩阵档案/ }).click();
  await archive.getByRole("button", { name: "P3" }).click();
  await archive.locator('button[title="立即装运一批物资"]').click();
  await expect(archive).toHaveClass(/active/);
  await expect(archive.locator(".export-project-progress")).toContainText("120");
  await page.screenshot({ path: "artifacts/qa/galactic-industry-1440.png", fullPage: true });

  await statistics.getByLabel("关闭生产统计").click();
  await page.getByLabel("打开科技树").click();
  const technology = page.getByRole("dialog", { name: "科技树" });
  await technology.getByLabel("展开科研详情").click();
  await expect(technology.locator(".infinite-research-console")).toContainText("矩阵压缩");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => technology.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/galactic-industry-390.png", fullPage: true });
});

test("technology upgrades expose balanced global effects in research and equipment views", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openTechnologyUpgradeGame(page);
  await page.getByLabel("打开科技树").click();
  const technology = page.getByRole("dialog", { name: "科技树" });
  await technology.getByLabel("展开科研详情").click();
  const upgrades = technology.getByLabel("全局科技升级效果");
  await expect(upgrades).toContainText("固体采矿3.00×");
  await expect(upgrades).toContainText("科研吞吐1.75×");
  await expect(upgrades).toContainText("物流航速2.00×");
  await expect(upgrades).toContainText("机 / 船载荷50 / 200");
  await expect(upgrades).toContainText("太阳帆寿命40 min");
  await expect(upgrades).toContainText("单站接收12 MW");
  await expect(upgrades).toContainText("壳面吸附2.00×");
  await expect(technology.locator(".technology-node").filter({ hasText: "壳面吸附效率" })).toHaveClass(/technology-node--complete/);
  await page.screenshot({ path: "artifacts/qa/technology-upgrades-1440.png", fullPage: true });

  await page.getByLabel("关闭科技树").click();
  await page.locator('.react-flow__node[data-id="upgrade_station"] .station-node').evaluate((element: HTMLElement) => element.click());
  const inspector = page.locator(".inspector-panel");
  await expect(inspector).toContainText("单机载荷50 件/架");
  await expect(inspector).toContainText("最低启航货量25 件/架");
  await expect(inspector).toContainText("额定航程4.0 秒");
  await page.locator('.react-flow__node[data-id="upgrade_receiver"] .machine-node').evaluate((element: HTMLElement) => element.click());
  await expect(inspector).toContainText("额定接收12 MW");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel("更多工作区").click();
  await page.getByRole("menuitem", { name: "科技树" }).click();
  await technology.getByLabel("展开科研详情").click();
  await expect(upgrades).toBeVisible();
  await expect.poll(async () => technology.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/technology-upgrades-390.png", fullPage: true });
});

test("planetary drones, orbital collection, station warpers and direct belt logistics form a complete logistics layer", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openCompleteLogisticsGame(page);
  await expect(page.getByLabel("随身物流运输船，当前 2")).toHaveCount(1);
  await page.getByTitle("切换到烬原 II").click();
  await page.locator(".react-flow__controls-fitview").click();
  const ashenStation = page.locator(".station-node").filter({ hasText: "星际物流站" });
  await ashenStation.click();
  await expect(page.locator(".inspector-panel")).toContainText("随身 2");
  await page.getByLabel("物流运输船目标数量").fill("1");
  await page.getByLabel("物流运输船目标数量").blur();
  await expect(page.locator(".inspector-panel").locator(".station-fleet-control .station-fleet-summary strong")).toContainText("1 / 10");
  await expect(page.getByLabel("随身物流运输船，当前 1")).toHaveCount(1);
  await expect(page.locator(".planet-transition")).toHaveCount(0);
  await page.locator(".construction-items").evaluate((element) => { element.scrollLeft = element.scrollWidth; });
  await page.screenshot({ path: "artifacts/qa/portable-fleet-ashen-1440.png", fullPage: true });
  await page.getByTitle("切换到澄海 I").click();
  await page.locator(".react-flow__controls-fitview").click();

  const localDemand = page.locator(".station-node").filter({ hasText: "行星物流站" }).filter({ hasText: "需求" });
  await localDemand.click();
  const inspector = page.locator(".inspector-panel");
  await expect(inspector).toContainText("运输机泊位");
  await expect(inspector.locator(".station-fleet-summary strong")).toContainText("2 / 50");
  await page.getByLabel("继续模拟").click();
  await expect.poll(async () => Number(await localDemand.getByTitle("拿取铁块").locator("strong").textContent()), { timeout: 4_000 }).toBeGreaterThanOrEqual(50);

  const hydrogenDemand = page.locator(".station-node").filter({ hasText: "星际物流站" });
  await hydrogenDemand.click();
  await expect(inspector).toContainText("翘曲器仓");
  await expect(inspector).toContainText("2 / 50");
  await inspector.getByLabel("目标库存").fill("5");
  await inspector.getByLabel("目标库存").blur();
  await inspector.getByLabel("自动补充专用翘曲器仓").click();
  await expect.poll(async () => inspector.locator(".station-warper-control .station-fleet-stepper strong").textContent(), { timeout: 4_000 }).toContain("3 / 50");
  await expect(inspector).toContainText("塔内物流槽与本星球托盘均缺少空间翘曲器");
  await expect.poll(async () => Number(await hydrogenDemand.getByTitle("拿取氢").locator("strong").textContent()), { timeout: 4_000 }).toBeGreaterThanOrEqual(10);
  await page.screenshot({ path: "artifacts/qa/complete-logistics-home-1440.png", fullPage: true });

  await page.locator(".react-flow__edge").evaluate((element: SVGGElement) => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await expect(inspector).toContainText("传送带等级");
  await expect(inspector).toContainText("线路上限");
  await expect(inspector).toContainText("12/s");
  await expect(inspector).not.toContainText("分拣器等级");

  await page.getByTitle("切换到苍岚 III").click();
  const collector = page.locator(".station-node").filter({ hasText: "轨道采集器" });
  await collector.click();
  await expect(inspector).toContainText("气态巨星轨道设施");
  await expect(inspector).toContainText("采集资源");
  await expect(inspector).toContainText("轨道采集氢中");
  await page.screenshot({ path: "artifacts/qa/orbital-collector-1440.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(inspector).toBeVisible();
  await expect.poll(async () => inspector.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(page.getByLabel("行星切换").locator("button:not(.planet-navigator__toggle)")).toHaveCount(3);
  await page.screenshot({ path: "artifacts/qa/orbital-collector-390.png", fullPage: true });
});

test("multi-slot stations and monitored stacked lines stay operable on desktop and mobile", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openCompleteLogisticsGame(page);
  await page.locator(".react-flow__controls-fitview").click();
  const demand = page.locator(".station-node").filter({ hasText: "行星物流站" }).filter({ hasText: "需求" });
  await demand.click();
  const inspector = page.locator(".station-inspector");
  const slots = inspector.locator(".station-slot");
  await expect(slots).toHaveCount(5);
  await expect(slots.nth(1).getByRole("button", { name: "选择槽位 2 物资" })).toBeVisible();
  await expect(slots.nth(0)).not.toContainText("航路");
  await expect(slots.nth(0)).not.toContainText("翘曲预算");
  await expect(slots.nth(0)).not.toContainText("保留");
  await chooseItem(page, slots.nth(1), "铜块");
  await slots.nth(1).getByRole("button", { name: "需求", exact: true }).click();
  await slots.nth(1).getByRole("button", { name: "25%", exact: true }).click();
  await expect(inspector).toContainText("已配置槽位2 / 5");
  await page.screenshot({ path: "artifacts/qa/logistics-slots-1440.png", fullPage: true });

  await page.locator(".react-flow__edge").evaluate((element: SVGGElement) => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  const beltInspector = page.locator(".inspector-panel");
  await beltInspector.getByRole("button", { name: "×2", exact: true }).click();
  await beltInspector.getByRole("button", { name: "高", exact: true }).click();
  await beltInspector.getByLabel("启用线路流量监测").check();
  await expect(beltInspector).toContainText("货物堆叠×2");
  await expect(beltInspector).toContainText("累计运输");

  await page.setViewportSize({ width: 390, height: 844 });
  await demand.evaluate((element: HTMLElement) => element.click());
  await expect(inspector).toBeVisible();
  await expect.poll(async () => inspector.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await slots.nth(1).locator(".catalog-picker-trigger").click();
  const mobileItemPicker = page.getByRole("dialog", { name: "物品选择面板" });
  await expect(mobileItemPicker.getByLabel("搜索物品")).not.toBeFocused();
  await mobileItemPicker.getByRole("button", { name: "关闭物品选择" }).click();
  await page.screenshot({ path: "artifacts/qa/logistics-slots-390.png", fullPage: true });
});

test("renewables, storage, fusion and artificial stars form a complete energy layer", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openCompleteEnergyGame(page);
  await page.locator(".react-flow__controls-fitview").click();
  for (const building of ["太阳能板", "地热发电站", "微型聚变发电站", "人造恒星", "蓄电器", "能量枢纽"]) {
    await expect(page.locator(".construction-item").filter({ hasText: building })).toHaveCount(1);
  }

  const accumulator = page.locator(".power-node").filter({ hasText: "蓄电器" }).filter({ hasNotText: "能量枢纽" });
  await accumulator.click();
  await expect(page.locator(".energy-inspector")).toContainText("45.00 / 90 MJ");
  await expect(page.locator(".energy-meter")).toHaveAttribute("aria-valuenow", "50");

  const exchanger = page.locator(".power-node").filter({ hasText: "能量枢纽" });
  await exchanger.click();
  const inspector = page.locator(".energy-inspector");
  await expect(inspector).toContainText("蓄电器 → 蓄电器（满）");
  await inspector.getByRole("button", { name: "放电", exact: true }).click();
  await expect(inspector).toContainText("蓄电器（满） → 蓄电器");
  await expect(exchanger.getByTitle("投入蓄电器（满）")).toBeVisible();
  await expect(exchanger.getByTitle("拿取蓄电器")).toBeVisible();

  const fusion = page.locator(".power-node").filter({ hasText: "微型聚变发电站" });
  await fusion.click();
  await expect(page.locator(".inspector-content select option")).toHaveCount(2);
  await expect(page.locator(".inspector-content select")).toHaveValue("deuteron_fuel_rod");
  const star = page.locator(".power-node").filter({ hasText: "人造恒星" });
  await star.click();
  await expect(page.locator(".inspector-content select")).toHaveValue("antimatter_fuel_rod");
  await page.screenshot({ path: "artifacts/qa/complete-energy-home-1440.png", fullPage: true });

  await page.getByLabel("打开生产统计").click();
  await page.getByRole("tab", { name: "电力" }).click();
  const powerStatistics = page.locator(".statistics-power");
  await expect(powerStatistics).toContainText("太阳能容量");
  await expect(powerStatistics).toContainText("地热容量");
  await expect(powerStatistics).toContainText("聚变出力");
  await expect(powerStatistics).toContainText("人造恒星");
  await expect(powerStatistics).toContainText("储能水平");
  await page.screenshot({ path: "artifacts/qa/complete-energy-statistics-1440.png", fullPage: true });
  await page.getByLabel("关闭生产统计").click();

  await page.getByLabel("打开科技树").click();
  for (const technology of ["太阳能收集", "能量储存", "地热发电", "可控核聚变", "人造恒星"]) {
    await expect(page.locator(".technology-node").filter({ has: page.getByText(technology, { exact: true }) })).toHaveCount(1);
  }
  await page.getByLabel("关闭科技树").click();

  await page.getByTitle("切换到烬原 II").click();
  await page.locator(".react-flow__controls-fitview").click();
  const geothermal = page.locator(".power-node").filter({ hasText: "地热发电站" });
  await expect(geothermal).toBeVisible();
  await expect(page.locator(".power-node").filter({ hasText: "太阳能板" }).locator(".power-output")).toContainText("540 kW");
  await geothermal.click();
  await page.screenshot({ path: "artifacts/qa/complete-energy-1440.png", fullPage: true });

  await page.getByTitle("切换到澄海 I").click();
  await page.locator(".react-flow__controls-fitview").click();
  await exchanger.click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".inspector-panel")).toBeVisible();
  await expect(page.locator(".energy-inspector")).toContainText("能量枢纽");
  await expect(page.locator(".energy-inspector")).toContainText("蓄电器（满） → 蓄电器");
  await expect.poll(async () => page.locator(".inspector-panel").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect.poll(async () => {
    const box = await page.locator(".inspector-panel").boundingBox();
    return box ? Math.ceil(box.x + box.width) : Number.POSITIVE_INFINITY;
  }).toBeLessThanOrEqual(390);
  await expect(page.locator(".game-notice")).toBeHidden({ timeout: 6_000 });
  await page.screenshot({ path: "artifacts/qa/complete-energy-390.png", fullPage: true });
});

test("rare resources, fractionation and quantum chemistry expose every alternative chain", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openRareResourceStageGame(page);
  await page.locator(".react-flow__controls-fitview").click();

  const fractionator = page.locator(".machine-node").filter({ hasText: "分馏塔" });
  await expect(fractionator.getByTitle("取出氢")).toBeVisible();
  await expect(fractionator.getByTitle("拿取氢")).toBeVisible();
  await expect(fractionator.getByTitle("拿取氘")).toBeVisible();

  const chemical = page.locator(".machine-node").filter({ hasText: "可燃冰裂解" });
  await expect(chemical.getByTitle("取出可燃冰")).toBeVisible();
  await expect(chemical.getByTitle("拿取石墨烯")).toBeVisible();
  await chemical.click();
  const inspector = page.locator(".inspector-content");
  await expect(inspector.getByTitle("升级为量子化工厂")).toBeVisible();
  await inspector.getByTitle("升级为量子化工厂").click();
  await expect(chemical).toContainText("量子化工厂");
  await expect(chemical).toContainText("可燃冰裂解");

  const thermal = page.locator(".power-node").filter({ hasText: "火力发电厂" });
  await thermal.click();
  await expect(page.locator(".inspector-content select")).toHaveValue("hydrogen_fuel_rod");
  await expect(page.locator(".inspector-content select option").filter({ hasText: "氢燃料棒" })).toHaveCount(1);
  await page.screenshot({ path: "artifacts/qa/rare-alternatives-home-1440.png", fullPage: true });

  await page.getByLabel("打开生产资料库").click();
  const codex = page.getByRole("dialog", { name: "生产资料库" });
  await codex.getByLabel("搜索配方物品").fill("石墨烯");
  await codex.locator(".recipe-index > button").filter({ hasText: "石墨烯" }).click();
  await expect(codex.locator(".recipe-method").filter({ hasText: "可燃冰裂解" })).toContainText("可燃冰");
  await expect(codex.locator(".recipe-method").filter({ hasText: "石墨烯" }).first()).toContainText("化工厂");
  await codex.getByLabel("搜索配方物品").fill("有机晶体");
  await codex.locator(".recipe-index > button").filter({ hasText: "有机晶体" }).click();
  await expect(codex.locator(".recipe-method--source")).toContainText("烬原 II");
  await expect(codex.locator(".recipe-section").first().locator(".recipe-method:not(.recipe-method--source)").filter({ hasText: "有机晶体" })).toContainText("塑料");
  await page.screenshot({ path: "artifacts/qa/rare-recipe-codex-1440.png", fullPage: true });
  await page.getByLabel("关闭生产资料库").click();

  await page.getByLabel("打开科技树").click();
  for (const technology of ["流体分馏", "稀有资源利用", "量子化工"]) {
    await expect(page.locator(".technology-node").filter({ has: page.getByText(technology, { exact: true }) })).toHaveCount(1);
  }
  await page.getByLabel("关闭科技树").click();

  await page.getByTitle("切换到烬原 II").click();
  await page.locator(".react-flow__controls-fitview").click();
  for (const resource of ["金伯利矿石", "分形硅石", "有机晶体"]) {
    await expect(page.locator(".vein-node").filter({ hasText: resource })).toHaveCount(1);
  }

  await page.getByLabel("打开星图").click();
  await page.getByRole("dialog", { name: "星图" }).locator(".star-system-card").filter({ has: page.getByText("北冕座", { exact: true }) }).getByRole("button", { name: /霜原 I/ }).click();
  await page.locator(".react-flow__controls-fitview").click();
  for (const resource of ["光栅石", "刺笋结晶", "可燃冰"]) {
    await expect(page.locator(".vein-node").filter({ hasText: resource })).toHaveCount(1);
  }
  await page.screenshot({ path: "artifacts/qa/rare-resource-field-1440.png", fullPage: true });

  await page.getByLabel("打开星图").click();
  await page.getByRole("dialog", { name: "星图" }).locator(".star-system-card").filter({ hasText: "赫卡忒" }).getByRole("button", { name: /极夜 I/ }).click();
  await page.locator(".react-flow__controls-fitview").click();
  await expect(page.locator(".vein-node").filter({ hasText: "单极磁石" })).toHaveCount(1);

  await page.getByLabel("打开星图").click();
  await page.getByRole("dialog", { name: "星图" }).locator(".star-system-card").filter({ hasText: "赫利俄斯" }).getByRole("button", { name: /苍岚 III/ }).click();
  const collector = page.locator(".station-node").filter({ hasText: "轨道采集器" });
  await collector.click();
  await expect(page.locator(".station-inspector .catalog-picker-trigger")).toContainText("可燃冰");
  await expect(page.locator(".station-inspector").getByLabel("选择采集资源")).toBeVisible();
  await expect(collector.getByTitle("拿取可燃冰")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".station-inspector .catalog-picker-trigger")).toContainText("可燃冰");
  await expect.poll(async () => {
    const box = await page.locator(".inspector-panel").boundingBox();
    return box ? Math.ceil(box.x + box.width) : Number.POSITIVE_INFINITY;
  }).toBeLessThanOrEqual(390);
  await expect(page.locator(".game-notice")).toBeHidden({ timeout: 6_000 });
  await page.screenshot({ path: "artifacts/qa/rare-orbital-collector-390.png", fullPage: true });
});

test("stellar exploration unlocks remote planets and enables a warped logistics route", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openStellarExplorationGame(page);
  await page.getByTitle("拿取钛块").click();
  await expect(page.locator(".cargo-slot")).toContainText("钛块");

  await page.getByLabel("打开星图").click();
  const starMap = page.getByRole("dialog", { name: "星图" });
  await expect(starMap.locator(".star-system-card")).toHaveCount(8);
  await expect(starMap.locator(".star-planet-list > button")).toHaveCount(22);
  await expect(starMap.locator(".star-system-card").filter({ has: page.getByText("蔚蓝王座", { exact: true }) })).toContainText("L☉");
  const borealis = starMap.locator(".star-system-card").filter({ has: page.getByText("北冕座", { exact: true }) });
  const neutron = starMap.locator(".star-system-card").filter({ has: page.getByText("赫卡忒", { exact: true }) });
  await expect(borealis).toContainText("未勘探");
  const borealGiant = borealis.getByRole("button", { name: /青冥 II/ });
  await expect(borealGiant.locator(".planet-colony-requirements")).toContainText("殖民前哨需求");
  await expect(borealGiant.locator(".planet-colony-requirements")).toContainText("材料取自“澄海 I”物资托盘");
  await expect(borealGiant.locator(".planet-colony-requirements")).toContainText("运输载具取自随身载具栏");
  await expect(borealGiant.locator(".planet-colony-requirements")).toContainText("当前行星托盘");
  await expect(borealGiant.locator(".planet-colony-requirements")).toContainText("随身载具");
  await expect(borealGiant.locator(".planet-colony-requirements")).toContainText("北冕座");
  await expect(neutron.getByRole("button", { name: "勘探赫卡忒" })).toBeDisabled();

  await borealis.getByRole("button", { name: "勘探北冕座" }).click();
  await expect(borealis).toContainText("已发现");
  await expect(borealGiant.locator(".planet-colony-requirements")).toContainText(/材料不足|材料满足/);
  await expect(neutron.getByRole("button", { name: "勘探赫卡忒" })).toBeEnabled();
  await neutron.getByRole("button", { name: "勘探赫卡忒" }).click();
  await expect(neutron).toContainText("已发现");
  await page.screenshot({ path: "artifacts/qa/stellar-map-1440.png", fullPage: true });

  await borealis.getByRole("button", { name: /霜原 I/ }).click();
  await expect(page.locator(".canvas-status")).toContainText("霜原 I");
  await expect(page.locator(".vein-node").filter({ hasText: "光栅石" })).toBeVisible();
  await expect(page.locator(".cargo-slot")).toContainText("钛块");
  await expect(page.locator(".game-notice")).toContainText("托钛天王");

  await page.getByLabel("继续模拟").click();
  const supply = page.locator(".station-node").filter({ hasText: "星际物流站" });
  await supply.click();
  const tripRow = page.locator(".station-inspector .metric-ledger > div").filter({ hasText: "完成航次" });
  await expect(tripRow).toContainText("1", { timeout: 3_000 });
  await expect(page.locator(".station-inspector")).toContainText("跨恒星");
  await page.screenshot({ path: "artifacts/qa/stellar-frost-route-1440.png", fullPage: true });

  await page.getByLabel("打开星图").click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(starMap).toBeVisible();
  await expect(starMap.locator(".star-map-route").evaluate((element) => element.scrollWidth <= element.clientWidth)).resolves.toBe(true);
  await expect(starMap.locator(".star-system-card")).toHaveCount(8);
  await expect(starMap.locator(".star-planet-list > button")).toHaveCount(22);
  await page.screenshot({ path: "artifacts/qa/stellar-map-390.png", fullPage: true });
});

test("star map industrial console exposes global routes, planet roles and quick diagnostics", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openStellarExplorationGame(page);
  await page.getByLabel("打开星图").click();
  const starMap = page.getByRole("dialog", { name: "星图" });
  const ashenProfile = starMap.getByRole("button", { name: /烬原 II/ });
  await expect(ashenProfile).toContainText("高热冶金");
  await expect(ashenProfile.locator(".star-planet-traits")).toContainText("矿储 115%");
  await expect(ashenProfile.locator(".star-planet-traits")).toContainText("光 150%");
  await expect(ashenProfile.locator(".star-planet-traits")).toContainText("地热 100%");
  await expect(ashenProfile.locator(".star-planet-traits")).toContainText("航程 105%");
  await starMap.getByRole("tab", { name: "星际工业" }).click();
  const industry = starMap.locator(".stellar-industry");
  await expect(industry).toBeVisible();
  await expect(industry).toContainText("全局航线表");
  await expect(industry.locator(".stellar-route-row")).toHaveCount(1);
  await expect(industry.locator(".stellar-route-row")).toContainText("光栅石");
  await expect(industry.locator(".stellar-route-row")).toContainText("翘曲");
  await expect(industry.locator(".stellar-route-row")).toContainText("路径");
  await expect(industry.locator(".stellar-route-row")).toContainText("策略");
  const frostIndustry = industry.locator(".stellar-planet-row").filter({ has: page.getByText("霜原 I", { exact: true }) });
  await expect(frostIndustry.locator(".stellar-planet-metrics")).toContainText("宜 化工基地");
  await page.screenshot({ path: "artifacts/qa/stellar-industry-1440.png", fullPage: true });

  await starMap.getByRole("tab", { name: "星图探索" }).click();
  const borealis = starMap.locator(".star-system-card").filter({ has: page.getByText("北冕座", { exact: true }) });
  await borealis.getByRole("button", { name: "勘探北冕座" }).click();
  await starMap.getByRole("tab", { name: "星际工业" }).click();
  await expect(industry.locator(".stellar-route-row")).toContainText("等待发船");

  const frostRole = industry.getByLabel("霜原 I工业角色");
  await frostRole.selectOption("chemical");
  await expect(frostRole).toHaveValue("chemical");
  await industry.getByRole("button", { name: /定位光栅石需求站/ }).click();
  await expect(page.locator(".canvas-status")).toContainText("澄海 I");
  await expect(page.locator(".station-inspector")).toBeVisible();

  await page.getByLabel("打开星图").click();
  await starMap.getByRole("tab", { name: "星际工业" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(starMap.locator(".stellar-industry")).toBeVisible();
  await expect(starMap.locator(".stellar-route-row")).toHaveCount(1);
  await page.screenshot({ path: "artifacts/qa/stellar-industry-390.png", fullPage: true });
});

test("stellar workspaces stay usable at 150 percent font scale on desktop and mobile", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openStellarExplorationGame(page);
  await page.getByLabel("打开设置").click();
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.locator(".operations-tabs").getByRole("tab", { name: "设置" }).click();
  await operations.locator(".settings-category-overview").getByRole("button", { name: "画面与主题" }).click();
  await operations.getByLabel("字体大小").getByRole("button", { name: "150%" }).click();
  await operations.getByLabel("关闭运营中心").click();

  await page.getByLabel("打开星图").click();
  const starMap = page.getByRole("dialog", { name: "星图" });
  await expect(starMap.getByLabel("关闭星图")).toBeVisible();
  await expect(starMap.locator(".star-system-card")).toHaveCount(8);
  await expect(starMap.locator(".star-system-card").evaluateAll((cards) => cards.every((card) => card.scrollHeight <= card.clientHeight + 1))).resolves.toBe(true);
  await page.waitForTimeout(220);
  await page.screenshot({ path: "artifacts/qa/stellar-map-150-1440.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => {
    const box = await starMap.boundingBox();
    return box ? Math.ceil(box.x + box.width) : Number.POSITIVE_INFINITY;
  }).toBeLessThanOrEqual(390);
  await expect(starMap.getByLabel("关闭星图")).toBeVisible();
  await starMap.getByRole("tab", { name: "星际工业" }).click();
  await expect(starMap.locator(".stellar-route-row")).toHaveCount(1);
  await page.screenshot({ path: "artifacts/qa/stellar-industry-150-390.png", fullPage: true });

  await page.setViewportSize({ width: 844, height: 390 });
  await expect(starMap.getByLabel("关闭星图")).toBeVisible();
  await page.screenshot({ path: "artifacts/qa/stellar-industry-150-844x390.png", fullPage: true });
  await starMap.getByLabel("关闭星图").click();

  await page.getByLabel("打开物资托盘").click();
  await page.getByTitle("打开戴森球规划").click();
  const planner = page.getByRole("dialog", { name: "戴森球规划" });
  await expect(planner.getByLabel("关闭戴森球规划")).toBeVisible();
  await expect(planner.locator(".dyson-system-tabs button")).toHaveCount(1);
  await page.waitForTimeout(220);
  await page.screenshot({ path: "artifacts/qa/dyson-planner-150-844x390.png", fullPage: true });
});

test("interstellar station exposes relay hub and compact per-slot controls on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openStellarExplorationGame(page);
  const station = page.locator(".station-node").filter({ hasText: "星际物流站" });
  await station.click();
  const inspector = page.locator(".station-inspector");
  await inspector.getByLabel("中转物流枢纽").check();
  await inspector.getByLabel("枢纽优先级").selectOption("2");
  const slot = inspector.locator('[data-station-slot-index="0"]');
  await slot.locator(".station-slot-scope").first().getByRole("button", { name: "需求", exact: true }).click();
  await slot.getByLabel("槽位 1 优先级").selectOption("2");
  await slot.getByLabel("槽位 1 库存上限").fill("2500");
  await slot.getByLabel("槽位 1 库存上限").blur();
  await expect(inspector.getByLabel("中转物流枢纽")).toBeChecked();
  await expect(inspector.getByLabel("枢纽优先级")).toHaveValue("2");
  await expect(slot.locator(".station-slot-scope").first().getByRole("button", { name: "需求", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(slot.getByLabel("槽位 1 优先级")).toHaveValue("2");
  await expect(slot.getByLabel("槽位 1 库存上限")).toHaveValue("2500");
  await expect(inspector.getByLabel("航路")).toHaveCount(0);
  await expect(inspector.getByLabel("翘曲预算")).toHaveCount(0);

  await page.getByLabel("打开设置").click();
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.locator(".operations-tabs").getByRole("tab", { name: "设置" }).click();
  await selectSettingsCategory(operations, "画面与主题", "visual");
  await operations.getByLabel("字体大小").getByRole("button", { name: "150%" }).click();
  await operations.getByLabel("关闭运营中心").click();
  await page.setViewportSize({ width: 390, height: 844 });
  if (!await page.locator(".game-shell").evaluate((element) => element.classList.contains("mobile-panel--inspector"))) {
    await page.getByLabel("打开检查器").click();
  }
  await expect(inspector.getByLabel("中转物流枢纽")).toBeVisible();
  await expect.poll(async () => inspector.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await slot.getByLabel("槽位 1 优先级").scrollIntoViewIfNeeded();
  await expect(slot.getByLabel("槽位 1 优先级")).toBeVisible();
  await expect(slot.getByLabel("槽位 1 库存上限")).toBeVisible();
  await page.screenshot({ path: "artifacts/qa/interstellar-relay-controls-150-390.png", fullPage: true });
});

test("box selection copies, pastes, moves and upgrades a production blueprint", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBlueprintStageGame(page);
  const source = page.locator(".machine-node").filter({ hasText: "电路板" }).first();
  const target = page.locator(".machine-node").filter({ hasText: "处理器" }).first();

  const boxSelect = async () => {
    const sourceBox = await source.boundingBox();
    const targetBox = await target.boundingBox();
    expect(sourceBox).not.toBeNull();
    expect(targetBox).not.toBeNull();
    await page.getByLabel("框选模式").click();
    const left = Math.min(sourceBox!.x, targetBox!.x) - 12;
    const top = Math.min(sourceBox!.y, targetBox!.y) - 12;
    const right = Math.max(sourceBox!.x + sourceBox!.width, targetBox!.x + targetBox!.width) + 12;
    const bottom = Math.max(sourceBox!.y + sourceBox!.height, targetBox!.y + targetBox!.height) + 12;
    await page.mouse.move(right, bottom);
    await page.mouse.down();
    await page.mouse.move(left, top, { steps: 14 });
    await page.mouse.up();
    await expect(page.locator(".react-flow__node.selected")).toHaveCount(2);
    await expect(page.locator(".react-flow__edge.selected")).toHaveCount(1);
    await expect(page.getByRole("toolbar", { name: "选区操作" })).toContainText("2 节点 · 1 线路");
  };

  await boxSelect();
  await page.getByLabel("复制所选为蓝图").click();
  await expect(page.locator(".blueprint-placement-cursor")).toContainText("蓝图 01");
  await page.locator(".react-flow__pane").click({ position: { x: 700, y: 100 } });
  await expect(page.locator(".machine-node")).toHaveCount(4);
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
  await expect(page.locator(".game-notice")).toContainText("部署完成");

  await page.getByLabel("打开蓝图库").click();
  const library = page.getByRole("dialog", { name: "蓝图与待建施工" });
  await expect(library.locator(".blueprint-card")).toHaveCount(1);
  await expect(library.locator(".blueprint-card")).toContainText("2 设备 · 0 资源锚点 · 1 线路");
  await expect(library.locator(".blueprint-requirements")).toContainText("制造台 Mk.I 0/2");
  const nameInput = library.locator(".blueprint-card input");
  await nameInput.fill("处理器模块");
  await nameInput.press("Enter");
  await expect(nameInput).toHaveValue("处理器模块");
  await page.screenshot({ path: "artifacts/qa/blueprint-library-1440.png", fullPage: true });
  await page.getByLabel("关闭蓝图工作区").click();

  await boxSelect();
  const targetBeforeMove = await target.boundingBox();
  const sourceHeader = source.locator(".factory-node__header");
  const sourceHeaderBox = await sourceHeader.boundingBox();
  await page.mouse.move(sourceHeaderBox!.x + 50, sourceHeaderBox!.y + 18);
  await page.mouse.down();
  await page.mouse.move(sourceHeaderBox!.x + 130, sourceHeaderBox!.y + 68, { steps: 10 });
  await page.mouse.up();
  const targetAfterMove = await target.boundingBox();
  expect(targetAfterMove!.x).toBeGreaterThan(targetBeforeMove!.x + 55);
  expect(targetAfterMove!.y).toBeGreaterThan(targetBeforeMove!.y + 30);

  await page.getByLabel("批量升级所选设备").click();
  await expect(page.locator(".machine-node").filter({ hasText: "制造台 Mk.II" })).toHaveCount(2);
  await page.getByLabel("一键升级所选传送带").click();
  await expect(page.locator(".factory-edge-label--selected")).toContainText("Mk.II");
  await page.screenshot({ path: "artifacts/qa/blueprint-batch-upgrade-1440.png", fullPage: true });

  await page.getByLabel("打开蓝图库").click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(library).toBeVisible();
  await expect.poll(async () => library.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(library.locator(".blueprint-card input")).toHaveValue("处理器模块");
  await page.screenshot({ path: "artifacts/qa/blueprint-library-390.png", fullPage: true });
});

test("production regions persist visual boundaries without blocking normal canvas tools", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await freshGame(page);
  await page.getByLabel("生产区域模式").click();
  await expect(page.locator(".game-shell")).toHaveClass(/game-shell--regioning/);
  const drag = await page.evaluate(() => {
    const pane = document.querySelector<HTMLElement>(".react-flow__pane");
    if (!pane) return null;
    const bounds = pane.getBoundingClientRect();
    for (let y = bounds.top + 60; y < bounds.bottom - 210; y += 28) {
      for (let x = bounds.left + 60; x < bounds.right - 280; x += 28) {
        if (document.elementFromPoint(x, y) === pane) return { start: { x, y }, end: { x: x + 220, y: y + 150 } };
      }
    }
    return null;
  });
  expect(drag).not.toBeNull();
  await page.mouse.move(drag!.start.x, drag!.start.y);
  await page.mouse.down();
  await page.mouse.move(drag!.end.x, drag!.end.y, { steps: 10 });
  await expect(page.locator(".canvas-region--draft")).toBeVisible();
  await page.mouse.up();

  const region = page.locator(".canvas-region:not(.canvas-region--draft)");
  const editor = page.getByLabel("生产区域设置");
  await expect(region).toHaveCount(1);
  await expect(editor).toBeVisible();
  await editor.getByLabel("区域名称").fill("蓝糖生产区");
  await editor.getByLabel("区域名称").press("Enter");
  const colors = editor.locator('input[type="color"]');
  await colors.nth(0).evaluate((element) => {
    const input = element as HTMLInputElement;
    input.value = "#334455";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await colors.nth(1).evaluate((element) => {
    const input = element as HTMLInputElement;
    input.value = "#77CCAA";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(region.locator(".canvas-region__label")).toContainText("蓝糖生产区");
  await expect(region).toHaveCSS("border-color", "rgb(119, 204, 170)");
  const southeastHandle = page.getByLabel("调整右下角：蓝糖生产区");
  await expect(southeastHandle).toBeVisible();
  const regionBeforeResize = await region.boundingBox();
  const resizeHandleBounds = await southeastHandle.boundingBox();
  await page.mouse.move(resizeHandleBounds!.x + resizeHandleBounds!.width / 2, resizeHandleBounds!.y + resizeHandleBounds!.height / 2);
  await page.mouse.down();
  await page.mouse.move(resizeHandleBounds!.x + resizeHandleBounds!.width / 2 + 90, resizeHandleBounds!.y + resizeHandleBounds!.height / 2 + 60, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await region.boundingBox())!.width).toBeGreaterThan(regionBeforeResize!.width + 60);
  await expect.poll(async () => (await region.boundingBox())!.height).toBeGreaterThan(regionBeforeResize!.height + 35);
  await editor.getByLabel("关闭区域设置").click();
  await expect(editor).toHaveCount(0);
  await region.locator(".canvas-region__label").click();
  await expect(editor).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => editor.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return bounds.left >= 0 && bounds.right <= window.innerWidth && element.scrollWidth <= element.clientWidth;
  })).toBe(true);
  await page.screenshot({ path: "artifacts/qa/canvas-region-editor-390.png", fullPage: true });
  await editor.getByLabel("删除生产区域").click();
  await expect(region).toHaveCount(0);
});

test("mobile production regions expose touch-sized handles and resize without panning the canvas", async ({ browser }) => {
  const { context, page } = await createTouchPage(browser, { width: 390, height: 844 });
  try {
    await freshGame(page);
    await dismissOnboarding(page);
    await page.getByLabel("生产区域模式").tap();
    const drag = await page.evaluate(() => {
      const pane = document.querySelector<HTMLElement>(".react-flow__pane");
      if (!pane) return null;
      const bounds = pane.getBoundingClientRect();
      for (let y = bounds.top + 90; y < bounds.bottom - 190; y += 24) {
        for (let x = bounds.left + 45; x < bounds.right - 190; x += 24) {
          if (document.elementFromPoint(x, y) === pane) return { start: { x: Math.round(x), y: Math.round(y) }, end: { x: Math.round(x + 145), y: Math.round(y + 105) } };
        }
      }
      return null;
    });
    expect(drag).not.toBeNull();
    const session = await context.newCDPSession(page);
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...drag!.start, id: 31, radiusX: 5, radiusY: 5, force: 1 }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: Math.round((drag!.start.x + drag!.end.x) / 2), y: Math.round((drag!.start.y + drag!.end.y) / 2), id: 31, radiusX: 5, radiusY: 5, force: 1 }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...drag!.end, id: 31, radiusX: 5, radiusY: 5, force: 1 }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });

    const region = page.locator(".canvas-region:not(.canvas-region--draft)");
    await expect(region).toHaveCount(1);
    const handle = page.getByLabel(/调整右下角/);
    await expect(handle).toBeVisible();
    const handleBounds = await handle.boundingBox();
    expect(handleBounds!.width).toBeGreaterThanOrEqual(28);
    expect(handleBounds!.height).toBeGreaterThanOrEqual(28);
    const before = await region.boundingBox();
    const start = { x: Math.round(handleBounds!.x + handleBounds!.width / 2), y: Math.round(handleBounds!.y + handleBounds!.height / 2) };
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...start, id: 32, radiusX: 5, radiusY: 5, force: 1 }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: start.x + 45, y: start.y + 35, id: 32, radiusX: 5, radiusY: 5, force: 1 }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(async () => (await region.boundingBox())!.width).toBeGreaterThan(before!.width + 25);
    await expect.poll(async () => (await region.boundingBox())!.height).toBeGreaterThan(before!.height + 18);
  } finally {
    await context.close();
  }
});

test("blueprint transforms, recipe parameters and missing-stock construction queue stay persistent", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBlueprintStageGame(page);
  const nodes = page.locator(".machine-node");
  await nodes.nth(0).click();
  await nodes.nth(1).click({ modifiers: ["Shift"] });
  await page.getByLabel("复制所选为蓝图").click();
  await page.locator(".react-flow__pane").click({ position: { x: 690, y: 120 } });
  await page.getByLabel("打开蓝图库").click();
  const library = page.getByRole("dialog", { name: "蓝图与待建施工" });
  const card = library.locator(".blueprint-card");
  await card.getByRole("button", { name: "90°", exact: true }).click();
  await card.getByRole("button", { name: "水平镜像" }).click();
  await expect(card).toContainText("配方参数");
  await expect(card.getByRole("button", { name: "排队部署" })).toBeEnabled();
  await card.getByRole("button", { name: "排队部署" }).click();
  await page.locator(".react-flow__pane").click({ position: { x: 620, y: 500 }, force: true });
  await expect(page.locator(".game-notice")).toContainText("已加入施工队列");
  await page.getByLabel("打开蓝图库").click();
  await library.getByRole("button", { name: /待建与补足/ }).click();
  const pendingWorkspace = library.locator(".pending-construction-workspace");
  const pendingOrder = pendingWorkspace.locator(".pending-construction-order");
  await expect(pendingWorkspace).toContainText("施工订单");
  await expect(pendingOrder).toContainText("90° · 水平镜像");
  await page.waitForTimeout(220);
  await page.screenshot({ path: "artifacts/qa/blueprint-queue-1440.png", fullPage: true });
  await pendingOrder.getByRole("button", { name: "取消并返还" }).click();
  await page.locator(".game-dialog").getByRole("button", { name: "取消并返还" }).click();
  await expect(pendingOrder).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => library.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/blueprint-transform-390.png", fullPage: true });
});

test("industrial planner creates a recursive target and remains usable on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openCompleteEnergyGame(page);
  await page.getByLabel("打开生产统计").click();
  const workspace = page.getByRole("dialog", { name: "生产统计" });
  await workspace.getByRole("tab", { name: /规划/ }).click();
  await workspace.getByLabel("目标物品").selectOption("magnetic_coil");
  await workspace.getByLabel("目标产量").fill("120");
  await workspace.getByRole("button", { name: "新建方案" }).click();
  await expect(workspace.locator(".planning-summary-band")).toContainText("理论设备");
  await expect(workspace.locator(".planning-requirements")).toContainText("磁线圈");
  await expect(workspace.locator(".planning-requirements")).toContainText("磁铁");
  await expect(workspace.locator(".planning-requirements")).toContainText("铜块");
  await expect(workspace.locator(".planning-history")).toContainText("等待采样");
  await page.screenshot({ path: "artifacts/qa/production-planner-1440.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(workspace).toBeVisible();
  await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/production-planner-390.png", fullPage: true });
});

test("canvas placement supports toolbar and keyboard undo redo", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBlueprintStageGame(page);
  await page.getByTitle("部署制造台 Mk.I", { exact: true }).click();
  await page.locator(".react-flow__pane").click({ position: { x: 700, y: 100 } });
  await expect(page.locator(".machine-node")).toHaveCount(3);

  await page.getByLabel("撤销", { exact: true }).click();
  await expect(page.locator(".machine-node")).toHaveCount(2);
  await expect(page.getByLabel("重做")).toBeEnabled();

  await page.keyboard.press("Control+Shift+Z");
  await expect(page.locator(".machine-node")).toHaveCount(3);
  await expect(page.locator(".game-notice")).toContainText("已重做");
});

test("double-click canvas zoom is disabled by default and follows the settings toggle", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await freshGame(page);
  await page.locator(".react-flow__controls-zoomin").click();
  await page.locator(".react-flow__controls-zoomin").click();
  const viewportTransform = () => page.locator(".react-flow__viewport").evaluate((element) => (element as HTMLElement).style.transform);
  const blankPoint = async () => page.evaluate(() => {
    const pane = document.querySelector<HTMLElement>(".react-flow__pane");
    if (!pane) return null;
    const bounds = pane.getBoundingClientRect();
    for (let y = bounds.top + 40; y < bounds.bottom - 40; y += 32) {
      for (let x = bounds.left + 40; x < bounds.right - 40; x += 32) {
        if (document.elementFromPoint(x, y) === pane) return { x, y };
      }
    }
    return null;
  });
  const point = await blankPoint();
  expect(point).not.toBeNull();
  const before = await viewportTransform();
  await page.mouse.dblclick(point!.x, point!.y);
  await page.waitForTimeout(340);
  expect(await viewportTransform()).toBe(before);

  await page.getByLabel("打开设置").click();
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.locator(".operations-tabs").getByRole("tab", { name: "设置" }).click();
  await operations.locator(".settings-category-overview").getByRole("button", { name: "交互与控制" }).click();
  const doubleClickToggle = operations.locator(".setting-row").filter({ hasText: "允许双击缩放" });
  await expect(doubleClickToggle.locator('input[type="checkbox"]')).not.toBeChecked();
  await doubleClickToggle.click();
  await operations.getByLabel("关闭运营中心").click();

  const enabledPoint = await blankPoint();
  expect(enabledPoint).not.toBeNull();
  await page.mouse.dblclick(enabledPoint!.x, enabledPoint!.y);
  await expect.poll(viewportTransform).not.toBe(before);
});

test("construction cards craft in place and Ctrl-click chains building placement", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSeededGame(page);
  await page.addInitScript(() => {
    const raw = window.localStorage.getItem("dsp-idle-network.save.v1");
    const envelope = JSON.parse(raw!);
    envelope.state.tray = { iron_ingot: 20, stone_brick: 10, gear: 10, magnetic_coil: 10 };
    envelope.state.planetTrays = { ...(envelope.state.planetTrays ?? {}), home: envelope.state.tray };
    envelope.state.research.completedTechIds = [...new Set([...(envelope.state.research.completedTechIds ?? []), "thermal_power"])]
    envelope.state.construction.thermal_power_plant = 0;
    delete envelope.checksum;
    delete envelope.formatVersion;
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify(envelope));
  });
  await page.reload();
  const craftButton = page.getByLabel("制造火力发电厂");
  await expect(craftButton).toBeEnabled();
  await expect(craftButton).toHaveAttribute("data-craft-state", "direct");
  await craftButton.click();
  await expect(page.locator(".construction-item-shell").filter({ hasText: "火力发电厂" })).toContainText("×1");
  await expect(page.locator(".interaction-burst").filter({ hasText: "已消耗" })).toBeVisible();
  await craftButton.click();
  await expect(craftButton).toBeEnabled();
  await expect(craftButton).toHaveClass(/construction-item-craft--disabled/);
  await expect(craftButton).toHaveAttribute("data-craft-state", "blocked");
  await expect(craftButton).toHaveAttribute("title", /铁矿石 0\/10（缺 10）/);
  await page.screenshot({ path: "artifacts/qa/construction-shortcuts-1440.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "artifacts/qa/construction-shortcuts-390.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });

  await openBlueprintStageGame(page);
  await page.getByTitle("部署制造台 Mk.I", { exact: true }).click();
  const emptyPanePoints = await page.evaluate(() => {
    const pane = document.querySelector<HTMLElement>(".react-flow__pane");
    if (!pane) return [] as Array<{ x: number; y: number }>;
    const rect = pane.getBoundingClientRect();
    const points: Array<{ x: number; y: number }> = [];
    for (let y = rect.top + 150; y < rect.bottom - 180; y += 35) {
      for (let x = rect.left + 170; x < rect.right - 260; x += 45) {
        const target = document.elementFromPoint(x, y);
        if (target instanceof Element && target.closest(".react-flow__pane") && !target.closest(".react-flow__minimap, .react-flow__controls, .react-flow__node")) points.push({ x, y });
      }
    }
    return points;
  });
  expect(emptyPanePoints.length).toBeGreaterThan(1);
  await page.keyboard.down("Control");
  await page.mouse.click(emptyPanePoints[0].x, emptyPanePoints[0].y);
  await expect(page.getByTitle("部署制造台 Mk.I", { exact: true })).toHaveClass(/construction-item--active/);
  await expect(page.locator(".continuous-placement-indicator")).toContainText("连续扩建");
  const secondPoint = await page.evaluate(() => {
    const pane = document.querySelector<HTMLElement>(".react-flow__pane");
    if (!pane) return null;
    const rect = pane.getBoundingClientRect();
    for (let y = rect.bottom - 230; y > rect.top + 160; y -= 40) {
      for (let x = rect.right - 300; x > rect.left + 180; x -= 50) {
        const target = document.elementFromPoint(x, y);
        if (target instanceof Element && target.closest(".react-flow__pane") && !target.closest(".react-flow__minimap, .react-flow__controls, .react-flow__node")) return { x, y };
      }
    }
    return null;
  });
  expect(secondPoint).not.toBeNull();
  await page.mouse.click(secondPoint!.x, secondPoint!.y);
  await page.keyboard.up("Control");
  await expect(page.locator(".machine-node")).toHaveCount(3);
  await expect(page.locator(".machine-node").filter({ hasText: "×2" })).toHaveCount(1);
  await expect(page.getByTitle("部署制造台 Mk.I", { exact: true })).not.toHaveClass(/construction-item--active/);
  await expect(page.locator(".game-notice")).toContainText(/连续扩建|材料不足/);

  await openBlueprintStageGame(page);
  const sourceAssembler = page.locator('.react-flow__node[data-id="blueprint_source"] .machine-node');
  await page.getByLabel("批量部署数量").getByRole("button", { name: "×2" }).click();
  await page.getByTitle("部署制造台 Mk.I ×2", { exact: true }).click();
  await page.keyboard.down("Control");
  await sourceAssembler.click();
  await page.keyboard.up("Control");
  await expect(sourceAssembler).toContainText("×2");
  await expect(page.getByTitle("部署制造台 Mk.I", { exact: true })).not.toHaveClass(/construction-item--active/);

  await sourceAssembler.locator(".factory-node__header").click();
  const quickAdd = page.getByRole("button", { name: /快速增加 1 台建筑，剩余 1/ });
  await expect(quickAdd).toBeEnabled();
  await quickAdd.click();
  await expect(sourceAssembler).toContainText("×3");
  await expect(page.getByRole("button", { name: /^快速增加 1 台建筑，剩余 0$/ })).toBeDisabled();
  const batchReduction = page.locator(".entity-stack-batch-remove");
  await batchReduction.getByRole("button", { name: "减少 1 台建筑" }).click();
  await expect(sourceAssembler).toContainText("×2");
  await expect(quickAdd).toBeEnabled();
  await batchReduction.getByRole("button", { name: "减少 1 台建筑" }).click();
  await expect(sourceAssembler).toContainText("×1");
  await page.locator(".inspector-panel").getByRole("button", { name: "回收设备" }).click();
  await page.locator(".game-dialog").getByRole("button", { name: "确认回收" }).click();
  await expect(sourceAssembler).toHaveCount(0);
});

test("auto layout has a dedicated one-step position undo", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBlueprintStageGame(page);
  const source = page.locator('.react-flow__node[data-id="blueprint_source"]');
  const target = page.locator('.react-flow__node[data-id="blueprint_target"]');
  const before = await Promise.all([source, target].map((node) => node.evaluate((element) => (element as HTMLElement).style.transform)));

  await page.getByLabel("自动整理当前行星布局").click();
  await expect(page.getByLabel("撤销最近一次自动整理")).toBeEnabled();
  await expect.poll(async () => JSON.stringify(await Promise.all([source, target].map((node) => node.evaluate((element) => (element as HTMLElement).style.transform))))).not.toBe(JSON.stringify(before));

  await page.getByLabel("撤销最近一次自动整理").click();
  await expect.poll(async () => Promise.all([source, target].map((node) => node.evaluate((element) => (element as HTMLElement).style.transform)))).toEqual(before);
  await expect(page.getByLabel("撤销最近一次自动整理")).toBeDisabled();
});

test("command palette navigates workspaces, focuses recipes and preserves keyboard flow", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSeededGame(page);
  await page.keyboard.press("Control+K");
  const palette = page.getByRole("dialog", { name: "命令面板" });
  await expect(palette).toBeVisible();
  await palette.getByLabel("搜索命令").fill("暂停模拟");
  await palette.getByLabel("搜索命令").press("Enter");
  await expect(page.locator(".canvas-status")).toContainText("模拟暂停");
  await expect(page.locator(".interaction-event-feed")).toContainText("模拟已暂停");

  await page.keyboard.press("Control+K");
  await palette.getByLabel("搜索命令").fill("处理器");
  await palette.getByLabel("搜索命令").press("Enter");
  const recipes = page.getByRole("dialog", { name: "生产资料库" });
  await expect(recipes).toBeVisible();
  await expect(recipes.locator(".recipe-item-header")).toContainText("处理器");
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.keyboard.press("Control+K");
  await expect(palette).toBeVisible();
  await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/command-palette-390.png", fullPage: true });
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
});

test("operations center diagnoses equipment and records achievement progress", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/health", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) }));
  await page.route("**/api/public-status", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      ok: true,
      timeZone: "Asia/Shanghai",
      today: "2026-07-22",
      uptimeSeconds: 3600,
      players: { total: 128, today: 23, online: 7, onlineWindowSeconds: 120 },
    }),
  }));
  await openOperationsStageGame(page);
  await page.getByLabel("打开设置").click();
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await expect(operations).toBeVisible();
  await operations.locator(".operations-tabs").getByRole("tab", { name: /警报/ }).click();

  const minerAlert = operations.locator(".alert-row").filter({ hasText: "铁矿石" });
  await expect(minerAlert).toContainText("电网断电");
  await expect(minerAlert).toContainText("澄海 I");
  await page.screenshot({ path: "artifacts/qa/operations-alerts-1440.png", fullPage: true });

  await minerAlert.click();
  await expect(operations).not.toBeVisible();
  const selectedMiner = page.locator('.react-flow__node[data-id="operations_iron"] .factory-node');
  await expect(selectedMiner).toHaveClass(/factory-node--selected/);
  await expect(page.locator(".inspector-panel")).toContainText("电网断电");
  await expect.poll(async () => {
    const nodeBounds = await selectedMiner.boundingBox();
    const canvasBounds = await page.locator(".factory-canvas").boundingBox();
    if (!nodeBounds || !canvasBounds) return false;
    const nodeCenter = nodeBounds.x + nodeBounds.width / 2;
    const canvasCenter = canvasBounds.x + canvasBounds.width / 2;
    return Math.abs(nodeCenter - canvasCenter) < 90;
  }).toBe(true);

  await page.getByLabel("打开设置").click();
  await operations.locator(".operations-tabs").getByRole("tab", { name: /成就/ }).click();
  await expect(operations.locator(".achievement-row").filter({ hasText: "第一镐" })).toHaveClass(/achievement-row--complete/);
  await expect(operations.locator(".achievement-row").filter({ hasText: "自动化开端" })).toHaveClass(/achievement-row--complete/);
  await expect(operations.locator(".achievement-row").filter({ hasText: "蓝色火花" })).toHaveClass(/achievement-row--complete/);

  await operations.locator(".operations-tabs").getByRole("tab", { name: "诊断反馈" }).click();
  const playerMetrics = operations.locator(".support-status-grid");
  await expect(playerMetrics).toContainText("今日进入工厂");
  await expect(playerMetrics).toContainText("23");
  await expect(playerMetrics).toContainText("累计游玩玩家");
  await expect(playerMetrics).toContainText("128");
  await expect(playerMetrics).toContainText("当前在线游玩");
  await expect(playerMetrics).toContainText("7");
  await expect(playerMetrics).toContainText("120 秒内活跃");
  await expect(operations.getByRole("link", { name: "GitHub" })).toHaveAttribute("href", "https://github.com/snowsnow0926/DSPONLINE");
  await page.screenshot({ path: "artifacts/qa/player-metrics-1440.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => operations.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/player-metrics-390.png", fullPage: true });
});

test("operations settings and local save slots persist across reload", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openOperationsStageGame(page);
  await page.getByLabel("打开设置").click();
  let operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.locator(".operations-tabs").getByRole("tab", { name: "设置" }).click();
  await operations.locator(".settings-category-overview").getByRole("button", { name: "画面与主题" }).click();
  await expect(operations.locator(".settings-community")).toContainText("1076757280");
  const fontScale = operations.getByLabel("字体大小");
  await expect(fontScale.getByRole("button")).toHaveText(["80%", "100%", "125%", "150%", "200%"]);
  await expect(fontScale.getByRole("button", { name: "100%" })).toHaveAttribute("aria-pressed", "true");
  const fillsViewport = () => page.evaluate(() => {
    const root = document.querySelector("#root")?.getBoundingClientRect();
    const shell = document.querySelector(".game-shell")?.getBoundingClientRect();
    return Boolean(root && shell && Math.abs(root.width - window.innerWidth) < 1 && Math.abs(root.height - window.innerHeight) < 1 && Math.abs(shell.width - window.innerWidth) < 1 && Math.abs(shell.height - window.innerHeight) < 1);
  });
  await fontScale.getByRole("button", { name: "125%" }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--ui-font-scale"))).toBe("1.25");
  await expect.poll(fillsViewport).toBe(true);
  await fontScale.getByRole("button", { name: "150%" }).click();
  await expect.poll(fillsViewport).toBe(true);
  await fontScale.getByRole("button", { name: "200%" }).click();
  await expect.poll(fillsViewport).toBe(true);
  await expect.poll(async () => operations.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await fontScale.getByRole("button", { name: "125%" }).click();
  await operations.getByRole("button", { name: "4×" }).click();
  await operations.locator(".settings-category-tabs").getByRole("button", { name: "交互与控制" }).click();
  await operations.locator(".setting-row").filter({ hasText: "性能模式" }).click();
  await operations.locator(".setting-row").filter({ hasText: "减少动态效果" }).click();
  await operations.locator(".setting-row").filter({ hasText: "操作音效" }).click();
  await operations.locator(".setting-row").filter({ hasText: "允许双击缩放" }).click();
  await operations.locator(".settings-category-tabs").getByRole("button", { name: "存档与云同步" }).click();
  await operations.getByRole("button", { name: "30 秒" }).click();
  await expect(page.locator(".game-shell")).toHaveAttribute("data-performance-mode", "true");
  await expect(page.locator(".game-shell")).toHaveAttribute("data-reduced-motion", "true");

  await page.waitForTimeout(2_000);
  await operations.locator(".operations-tabs").getByRole("tab", { name: "存档" }).click();
  await operations.getByRole("button", { name: "立即保存" }).click();
  const elapsedSeconds = await page.evaluate(() => JSON.parse(window.localStorage.getItem("dsp-idle-network.save.v1")!).state.elapsedSeconds as number);
  expect(elapsedSeconds).toBeGreaterThan(1.5);

  await operations.getByLabel("保存到槽位 1").click();
  await expect(operations.locator(".save-slot").filter({ hasText: "本地槽位 1" })).toHaveClass(/save-slot--occupied/);
  const downloadPromise = page.waitForEvent("download");
  await operations.getByRole("button", { name: "导出 JSON" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^dsp-idle-save-.*\.json$/);
  await page.screenshot({ path: "artifacts/qa/operations-saves-1440.png", fullPage: true });
  await operations.getByLabel("删除槽位 1").click();
  const deleteDialog = page.getByRole("dialog", { name: "删除本地槽位 1" });
  await expect(deleteDialog).toContainText("第一次确认");
  await deleteDialog.getByRole("button", { name: /继续确认/ }).click();
  await expect(deleteDialog).toContainText("第二次确认");
  await expect(operations.locator(".save-slot").filter({ hasText: "本地槽位 1" })).toHaveClass(/save-slot--occupied/);
  await deleteDialog.getByRole("button", { name: /确认永久删除/ }).click();
  await expect(deleteDialog).toHaveCount(0);
  await expect(operations.locator(".save-slot").filter({ hasText: "本地槽位 1" })).not.toHaveClass(/save-slot--occupied/);

  await page.reload();
  await expect(page.locator(".game-shell")).toHaveAttribute("data-performance-mode", "true");
  await expect(page.locator(".game-shell")).toHaveAttribute("data-reduced-motion", "true");
  await page.getByLabel("打开设置").click();
  operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.locator(".operations-tabs").getByRole("tab", { name: "设置" }).click();
  await operations.locator(".settings-category-tabs").getByRole("button", { name: "画面与主题" }).click();
  await expect(operations.getByLabel("字体大小").getByRole("button", { name: "125%" })).toHaveAttribute("aria-pressed", "true");
  await operations.locator(".settings-category-tabs").getByRole("button", { name: "交互与控制" }).click();
  await expect(operations.locator(".setting-row").filter({ hasText: "性能模式" }).locator('input[type="checkbox"]')).toBeChecked();
  await expect(operations.locator(".setting-row").filter({ hasText: "减少动态效果" }).locator('input[type="checkbox"]')).toBeChecked();
  await expect(operations.locator(".setting-row").filter({ hasText: "操作音效" }).locator('input[type="checkbox"]')).toBeChecked();
  await expect(operations.locator(".setting-row").filter({ hasText: "允许双击缩放" }).locator('input[type="checkbox"]')).toBeChecked();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => operations.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/operations-settings-390.png", fullPage: true });
});

test("failed primary saves stay visible and never report false success", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openOperationsStageGame(page);
  await page.getByLabel("打开设置").click();
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.locator(".operations-tabs").getByRole("tab", { name: "存档" }).click();
  await page.evaluate(() => {
    const runtime = window as typeof window & { __dspNativeIdbPut?: IDBObjectStore["put"] };
    runtime.__dspNativeIdbPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      if (value && typeof value === "object" && (value as { key?: unknown }).key === "dsp-idle-network.save.v1") {
        throw new DOMException("quota", "QuotaExceededError");
      }
      return key === undefined
        ? runtime.__dspNativeIdbPut!.call(this, value)
        : runtime.__dspNativeIdbPut!.call(this, value, key);
    } as IDBObjectStore["put"];
  });

  await operations.getByRole("button", { name: "立即保存" }).click();
  const warning = page.getByRole("alert").filter({ hasText: "本地存储空间不足，当前进度尚未保存" });
  await expect(warning).toBeVisible();
  await expect(page.locator(".game-notice")).not.toContainText("主存档已保存");
  const downloadPromise = page.waitForEvent("download");
  await warning.getByRole("button", { name: "立即导出当前进度" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^dsp-idle-save-\d{4}-\d{2}-\d{2}\.json$/);

  await page.evaluate(() => {
    const runtime = window as typeof window & { __dspNativeIdbPut?: IDBObjectStore["put"] };
    if (runtime.__dspNativeIdbPut) IDBObjectStore.prototype.put = runtime.__dspNativeIdbPut;
    delete runtime.__dspNativeIdbPut;
  });
  await operations.getByRole("button", { name: "立即保存" }).click();
  await expect(warning).toBeHidden();
  await expect(page.locator(".game-notice")).toContainText("主存档已保存");
});

test("font scaling keeps rendered belt endpoints attached to their handles", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openEdgeOverlapGame(page);
  await page.locator(".react-flow__controls-fitview").click();
  await page.getByLabel("打开设置").click();
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.locator(".settings-category-overview").getByRole("button", { name: "画面与主题" }).click();
  const fontScale = operations.getByLabel("字体大小");
  const endpointDistances = () => page.evaluate(() => {
    const path = document.querySelector<SVGPathElement>(".factory-edge-visual-path");
    const source = document.querySelector<HTMLElement>('.react-flow__node[data-id="overlap_source"] .factory-handle--output');
    const target = document.querySelector<HTMLElement>('.react-flow__node[data-id="overlap_target"] [data-handleid="in:iron_ingot"]');
    const matrix = path?.getScreenCTM();
    if (!path || !source || !target || !matrix) return [999, 999];
    const start = path.getPointAtLength(0).matrixTransform(matrix);
    const end = path.getPointAtLength(path.getTotalLength()).matrixTransform(matrix);
    const sourceBounds = source.getBoundingClientRect();
    const targetBounds = target.getBoundingClientRect();
    const sourceCenter = { x: sourceBounds.left + sourceBounds.width / 2, y: sourceBounds.top + sourceBounds.height / 2 };
    const targetCenter = { x: targetBounds.left + targetBounds.width / 2, y: targetBounds.top + targetBounds.height / 2 };
    return [Math.hypot(start.x - sourceCenter.x, start.y - sourceCenter.y), Math.hypot(end.x - targetCenter.x, end.y - targetCenter.y)];
  });

  for (const scale of ["125%", "150%", "200%"] as const) {
    await fontScale.getByRole("button", { name: scale }).click();
    await expect.poll(async () => Math.max(...await endpointDistances())).toBeLessThan(10);
  }
});

test("save preview, snapshots, content-pack validation and simulation diagnostics stay recoverable", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openOperationsStageGame(page);
  await page.getByLabel("打开设置").click();
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.locator(".operations-tabs").getByRole("tab", { name: "存档" }).click();
  await operations.getByRole("button", { name: "立即保存" }).click();
  await operations.getByRole("button", { name: "创建快照" }).click();
  await expect(operations.locator(".save-snapshot-row").first()).toBeVisible();

  const savedRaw = await page.evaluate(() => window.localStorage.getItem("dsp-idle-network.save.v1"));
  expect(savedRaw).toContain("checksum");
  await operations.locator('input[aria-label="选择要导入的存档文件"]').setInputFiles({
    name: "preview.json",
    mimeType: "application/json",
    buffer: Buffer.from(savedRaw!, "utf8"),
  });
  await expect(operations.locator(".save-import-preview")).toBeVisible();
  await expect(operations.locator(".save-import-preview")).toContainText("校验通过");
  await operations.locator(".save-import-preview").getByRole("button", { name: "确认导入" }).click();
  await expect(operations.locator(".save-import-preview")).toBeHidden();
  await page.getByLabel("打开设置").click();
  const reopenedOperations = page.getByRole("dialog", { name: "运营中心" });
  await reopenedOperations.locator(".operations-tabs").getByRole("tab", { name: "存档" }).click();

  const packRaw = JSON.stringify({
    formatVersion: 1,
    id: "qa_pack",
    name: "QA 内容包",
    version: "0.1.0",
    items: [{ id: "qa_crystal", name: "QA 晶体", symbol: "Q", kind: "solid", description: "内容包回归物品" }],
  });
  await reopenedOperations.locator('input[aria-label="选择内容包文件"]').setInputFiles({
    name: "pack.json",
    mimeType: "application/json",
    buffer: Buffer.from(packRaw, "utf8"),
  });
  await expect(reopenedOperations.locator(".content-pack-result--valid")).toContainText("内容包校验通过");

  await reopenedOperations.locator(".operations-tabs").getByRole("tab", { name: "内容包" }).click();
  await reopenedOperations.locator('input[aria-label="选择要注册的内容包"]').setInputFiles({
    name: "pack.json",
    mimeType: "application/json",
    buffer: Buffer.from(packRaw, "utf8"),
  });
  await expect(reopenedOperations.locator(".content-pack-registration--valid")).toContainText("QA 内容包");
  await reopenedOperations.getByRole("button", { name: "注册并启用" }).click();
  await expect(reopenedOperations.locator(".content-pack-card--enabled")).toContainText("QA 内容包");

  await page.reload();
  await page.getByLabel("打开设置").click();
  const persistedOperations = page.getByRole("dialog", { name: "运营中心" });
  await persistedOperations.locator(".operations-tabs").getByRole("tab", { name: "内容包" }).click();
  await expect(persistedOperations.locator(".content-pack-card--enabled")).toContainText("QA 内容包");

  await persistedOperations.locator(".operations-tabs").getByRole("tab", { name: "设置" }).click();
  await selectSettingsCategory(persistedOperations, "统计与运行记录", "statistics");
  await persistedOperations.getByRole("button", { name: "运行 60 秒基准" }).click();
  await expect(page.locator(".game-notice")).toContainText("自动性能报告通过");
  await expect(persistedOperations.locator(".automatic-performance-report")).toContainText("确定性");
  await page.screenshot({ path: "artifacts/qa/save-recovery-1440.png", fullPage: true });
});

test("offline report summarizes production before entering the factory", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openOfflineStageGame(page);
  const report = page.getByRole("dialog", { name: "离线结算报告" });
  await expect(report).toBeVisible();
  await expect(report.locator(".offline-runtime")).toContainText("秒");
  await expect(report.locator(".offline-production-list")).toContainText("铁矿石");
  await expect(report.locator(".offline-production-list").getByText(/^\+\d+/).first()).toBeVisible();
  await page.screenshot({ path: "artifacts/qa/offline-report-1440.png", fullPage: true });
  await report.getByRole("button", { name: "确认结算" }).click();
  await expect(report).not.toBeVisible();
});

test("running equipment uses semantic animation and reduced motion disables it", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openOfflineStageGame(page);
  await page.getByRole("dialog", { name: "离线结算报告" }).getByRole("button", { name: "确认结算" }).click();
  await page.locator(".react-flow__controls-fitview").click();
  const runningNode = page.locator(".factory-node--status-running").first();
  await expect(runningNode).toBeVisible();
  await expect(runningNode.locator(".work-cycle--active")).toBeVisible();
  await expect.poll(async () => runningNode.evaluate((element) => getComputedStyle(element, "::after").animationName)).toContain("factory-node-scan");
  await expect.poll(async () => runningNode.locator(".work-cycle--active > i").evaluate((element) => getComputedStyle(element, "::after").animationName)).toContain("factory-cycle-sheen");
  await page.screenshot({ path: "artifacts/qa/animation-feedback-1440.png", fullPage: true });

  await page.getByLabel("打开设置").click();
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.locator(".operations-tabs").getByRole("tab", { name: "设置" }).click();
  await selectSettingsCategory(operations, "交互与控制", "interaction");
  await operations.locator(".setting-row").filter({ hasText: "减少动态效果" }).click();
  await operations.getByLabel("关闭运营中心").click();
  const durationMs = await runningNode.evaluate((element) => {
    const value = getComputedStyle(element, "::after").animationDuration;
    return value.endsWith("ms") ? Number.parseFloat(value) : Number.parseFloat(value) * 1000;
  });
  expect(durationMs).toBeLessThanOrEqual(0.02);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".react-flow__controls-fitview").click();
  await expect(page.locator(".factory-canvas").evaluate((element) => element.scrollWidth <= element.clientWidth)).resolves.toBe(true);
  await page.screenshot({ path: "artifacts/qa/animation-feedback-390.png", fullPage: true });
});

test("placement preview, selection focus and keyboard recycle keep canvas work direct", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await freshGame(page);
  await page.getByTitle("部署风力涡轮机").click();
  const canvas = page.locator(".react-flow__pane");
  const canvasBounds = await canvas.boundingBox();
  await page.mouse.move(canvasBounds!.x + canvasBounds!.width * 0.72, canvasBounds!.y + 230);
  const preview = page.locator(".building-placement-cursor");
  await expect(preview).toContainText("风力涡轮机");
  await expect(preview).toContainText("×1");
  await page.screenshot({ path: "artifacts/qa/interaction-placement-1440.png", fullPage: true });

  await canvas.click({ position: { x: Math.round(canvasBounds!.width * 0.72), y: 230 } });
  await expect(preview).not.toBeVisible();
  const turbine = page.locator(".power-node").filter({ hasText: "风力涡轮机" });
  await turbine.click();
  await page.getByLabel("定位到所选设备").click();
  await expect.poll(async () => {
    const nodeBounds = await turbine.boundingBox();
    const visibleCanvas = await page.locator(".factory-canvas").boundingBox();
    if (!nodeBounds || !visibleCanvas) return false;
    return Math.abs(nodeBounds.x + nodeBounds.width / 2 - (visibleCanvas.x + visibleCanvas.width / 2)) < 90;
  }).toBe(true);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("toolbar", { name: "选区操作" })).toBeVisible();
  await page.getByLabel("打开检查器").click();
  await expect.poll(async () => page.locator(".inspector-panel").evaluate((element) =>
    element.getBoundingClientRect().left >= window.innerWidth - 1)).toBe(true);
  await page.getByLabel("定位到所选设备").click();
  await expect.poll(async () => {
    const bounds = await turbine.boundingBox();
    return Boolean(bounds && Math.abs(bounds.x + bounds.width / 2 - 195) < 70);
  }).toBe(true);
  await expect.poll(async () => page.evaluate(() => [
    ".game-header",
    '[role="toolbar"][aria-label="选区操作"]',
    ".construction-dock",
  ].filter((selector) => {
    const bounds = document.querySelector(selector)?.getBoundingClientRect();
    return !bounds || bounds.left < -1 || bounds.right > window.innerWidth + 1;
  }))).toEqual([]);
  await page.screenshot({ path: "artifacts/qa/interaction-selection-390.png", fullPage: true });
  await page.keyboard.press("Delete");
  await expect(turbine).not.toBeVisible();
  await expect(page.getByTitle("部署风力涡轮机")).toContainText("×3");
  await expect(page.locator(".game-notice")).toContainText("已回收 1 个设备与 0 条运输线");
});

test("large workspaces load on demand with polished desktop and mobile hierarchy", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openTechnologyUpgradeGame(page);
  const technologyModuleLoaded = () => page.evaluate(() => performance.getEntriesByType("resource")
    .some((entry) => entry.name.includes("TechnologyWorkspace")));
  expect(await technologyModuleLoaded()).toBe(false);

  await page.getByLabel("打开科技树").click();
  const technology = page.getByRole("dialog", { name: "科技树" });
  await expect(technology).toBeVisible();
  await technology.getByLabel("展开科研详情").click();
  await expect.poll(technologyModuleLoaded).toBe(true);
  await expect(technology.locator(".technology-upgrade-overview")).toBeVisible();
  await page.waitForTimeout(220);
  await page.screenshot({ path: "artifacts/qa/frontend-polish-1440.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => technology.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(technology.locator(".technology-upgrade-overview")).toBeVisible();
  await page.screenshot({ path: "artifacts/qa/frontend-polish-390.png", fullPage: true });
});

test("construction dock hides locked equipment until its technology is completed", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await freshGame(page);
  await expect(page.getByTitle("部署风力涡轮机")).toBeVisible();
  await expect(page.getByTitle("部署电弧熔炉")).toBeVisible();
  await expect(page.getByTitle("部署太阳能板")).toHaveCount(0);
  await expect(page.getByTitle("部署位面熔炉")).toHaveCount(0);
  await expect(page.getByTitle("部署制造台 Mk.II", { exact: true })).toHaveCount(0);

  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("dsp-idle-network.save.v1")), { timeout: 5_000 }).not.toBeNull();
  await page.addInitScript(() => {
    const raw = window.localStorage.getItem("dsp-idle-network.save.v1");
    if (!raw) throw new Error("missing save");
    const envelope = JSON.parse(raw);
    envelope.state.research.completedTechIds = [...new Set([...(envelope.state.research.completedTechIds ?? []), "solar_energy"])];
    delete envelope.checksum;
    delete envelope.formatVersion;
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify(envelope));
  });
  await page.reload();
  await expect(page.getByTitle("部署太阳能板")).toBeVisible();
});

test("workspace hierarchy filters construction, collapses rails and adapts detail level", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await freshGame(page);
  const canvas = page.locator(".factory-canvas");
  const canvasBefore = await canvas.boundingBox();

  const category = page.getByLabel("施工托盘分类");
  await expect(category).toHaveValue("all");
  await category.selectOption("power");
  await expect(page.getByTitle("部署风力涡轮机")).toBeVisible();
  await expect(page.getByTitle("部署电弧熔炉")).toHaveCount(0);
  await category.selectOption("all");

  await page.getByLabel("开启施工托盘精简模式").click();
  await expect(page.locator(".construction-dock")).toHaveClass(/construction-dock--compact/);
  await expect.poll(() => page.locator(".construction-items").evaluate((element) => getComputedStyle(element).gridTemplateRows.split(" ").length)).toBe(2);
  const compactItem = page.locator(".construction-item").first();
  const compactLabel = compactItem.locator(":scope > span");
  const compactCount = compactItem.locator(":scope > strong");
  await expect.poll(() => compactLabel.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(10);
  await expect(compactCount).toHaveCSS("position", "absolute");
  await expect.poll(() => compactCount.evaluate((element) => Number.parseFloat(getComputedStyle(element).opacity))).toBeLessThanOrEqual(0.2);
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("dsp-idle-network.construction-compact.v1"))).toBe("true");
  await page.screenshot({ path: "artifacts/qa/construction-compact-1440.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(220);
  await expect.poll(() => compactLabel.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(9);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/construction-compact-390.png", fullPage: true });
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(220);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/construction-compact-844x390.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(220);

  await page.getByLabel("折叠物资侧栏").click();
  await expect(page.locator(".resource-rail")).toBeHidden();
  await expect.poll(async () => (await canvas.boundingBox())!.width).toBeGreaterThan(canvasBefore!.width + 180);
  await page.getByLabel("展开物资侧栏").click();
  await expect(page.locator(".resource-rail")).toBeVisible();

  const vein = page.locator(".vein-node").first();
  const nodeHeight = await vein.evaluate((element) => (element as HTMLElement).offsetHeight);
  for (let index = 0; index < 4; index += 1) await page.locator(".react-flow__controls-zoomout").click();
  await expect(page.locator(".game-shell")).toHaveAttribute("data-zoom-lod", "compact");
  await expect(vein.locator(".manual-mine")).toHaveCSS("opacity", "0.12");
  await expect.poll(async () => vein.evaluate((element) => (element as HTMLElement).offsetHeight)).toBe(nodeHeight);

  await page.getByLabel("打开主线任务中心").first().click();
  const firstChapter = page.locator(".campaign-chapter").first();
  await firstChapter.locator(".campaign-chapter-header").click();
  await expect(firstChapter.locator(".campaign-chapter-header")).toHaveAttribute("aria-expanded", "false");
  await expect(firstChapter.locator(".campaign-task-list")).toHaveCount(0);
});

test("canvas overlays fold and horizontal surfaces support direct panning", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await freshGame(page);

  const contextMenuPolicy = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLElement>(".factory-canvas")!;
    const input = document.querySelector<HTMLInputElement>(".tray-limit-control input")!;
    const canvasEvent = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    const inputEvent = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    canvas.dispatchEvent(canvasEvent);
    input.dispatchEvent(inputEvent);
    return { canvasPrevented: canvasEvent.defaultPrevented, inputPrevented: inputEvent.defaultPrevented };
  });
  expect(contextMenuPolicy).toEqual({ canvasPrevented: true, inputPrevented: false });

  await page.getByLabel("折叠行星切换").click();
  await expect(page.getByLabel("展开行星切换")).toBeVisible();
  await expect(page.locator(".planet-navigator button")).toHaveCount(1);
  await page.getByLabel("展开行星切换").click();

  await page.getByLabel("折叠画布工具").click();
  await expect(page.getByLabel("指针模式")).toHaveCount(0);
  await page.getByLabel("展开画布工具").click();
  await expect(page.getByLabel("指针模式")).toBeVisible();

  await expect(page.locator(".react-flow__minimap")).toBeVisible();
  await page.getByLabel("折叠小地图").click();
  await expect(page.locator(".react-flow__minimap")).toHaveCount(0);
  await page.getByLabel("展开小地图").click();

  const constructionItems = page.locator(".construction-items");
  await constructionItems.evaluate((element) => { element.scrollLeft = 0; });
  await constructionItems.dispatchEvent("wheel", { deltaY: 720, deltaX: 0 });
  await expect.poll(() => constructionItems.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await constructionItems.evaluate((element) => { element.scrollLeft = 0; });
  const dockBox = await constructionItems.boundingBox();
  await page.mouse.move(dockBox!.x + dockBox!.width - 40, dockBox!.y + dockBox!.height / 2);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(dockBox!.x + dockBox!.width - 320, dockBox!.y + dockBox!.height / 2, { steps: 5 });
  await page.mouse.up({ button: "right" });
  await expect.poll(() => constructionItems.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);

  await page.getByLabel("打开科技树").click();
  const technology = page.getByRole("dialog", { name: "科技树" });
  await expect(technology.getByLabel("展开科研详情")).toBeVisible();
  await expect(technology.locator(".technology-upgrade-overview")).toHaveCount(0);
  const technologyTree = technology.locator(".technology-tree");
  const scrollParentsBefore = await technology.evaluate((element) => ({
    dialog: element.scrollTop,
    document: document.scrollingElement?.scrollTop ?? 0,
  }));
  await technologyTree.evaluate((element) => { element.scrollLeft = 0; element.scrollTop = 0; });
  await technologyTree.dispatchEvent("wheel", { deltaY: 760, deltaX: 0 });
  await expect.poll(() => technologyTree.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await expect(technologyTree.evaluate((element) => element.scrollTop)).resolves.toBe(0);
  await technologyTree.dispatchEvent("wheel", { deltaY: 420, deltaX: 260 });
  await technologyTree.dispatchEvent("wheel", { deltaY: 420, deltaX: -180 });
  await expect(technologyTree.evaluate((element) => element.scrollTop)).resolves.toBe(0);
  await expect(technology.evaluate((element) => ({ dialog: element.scrollTop, document: document.scrollingElement?.scrollTop ?? 0 }))).resolves.toEqual(scrollParentsBefore);
  await technologyTree.evaluate((element) => { element.scrollLeft = element.scrollWidth; element.scrollTop = 0; });
  for (let index = 0; index < 3; index += 1) await technologyTree.dispatchEvent("wheel", { deltaY: 900, deltaX: 240 });
  await expect(technologyTree.evaluate((element) => element.scrollTop)).resolves.toBe(0);
  await expect(technology.evaluate((element) => ({ dialog: element.scrollTop, document: document.scrollingElement?.scrollTop ?? 0 }))).resolves.toEqual(scrollParentsBefore);
  await technologyTree.evaluate((element) => { element.scrollLeft = 0; });
  const treeBox = await technologyTree.boundingBox();
  await page.mouse.move(treeBox!.x + treeBox!.width - 40, treeBox!.y + 70);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(treeBox!.x + treeBox!.width - 320, treeBox!.y + 70, { steps: 5 });
  await page.mouse.up({ button: "right" });
  await expect.poll(() => technologyTree.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await technology.getByLabel("展开科研详情").click();
  await expect(technology.locator(".technology-upgrade-overview")).toBeVisible();
});

test("sub-360 header moves workspaces into an overflow menu", async ({ page }) => {
  await page.setViewportSize({ width: 350, height: 760 });
  await freshGame(page);
  await expect(page.getByLabel("更多工作区")).toBeVisible();
  await expect(page.getByLabel("打开科技树")).toBeHidden();
  await page.getByLabel("更多工作区").click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "科技树" }).click();
  await expect(page.getByRole("dialog", { name: "科技树" })).toBeVisible();
});

test("performance mode keeps a 500-device 1000-line factory responsive", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openStressStageGame(page);
  const shell = page.locator(".game-shell");
  await expect(shell).toHaveAttribute("data-performance-mode", "true");
  await expect.poll(async () => shell.getAttribute("data-simulation-worker")).toBe("active");

  const renderedNodes = await page.locator(".react-flow__node").count();
  expect(renderedNodes).toBeGreaterThan(0);
  expect(renderedNodes).toBeLessThan(120);
  const frameLatency = await page.evaluate(() => new Promise<number>((resolve) => {
    const started = performance.now();
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - started)));
  }));
  expect(frameLatency).toBeLessThan(500);

  const blankPoint = await page.evaluate(() => {
    const pane = document.querySelector<HTMLElement>(".react-flow__pane");
    if (!pane) return null;
    const rect = pane.getBoundingClientRect();
    for (let y = rect.top + 24; y < rect.bottom - 24; y += 24) {
      for (let x = rect.left + 24; x < rect.right - 24; x += 24) {
        const elements = document.elementsFromPoint(x, y);
        const blocked = elements.some((element) => element.closest(".react-flow__node, .react-flow__controls, .react-flow__minimap, .react-flow__panel"));
        if (!blocked && elements.includes(pane)) return { x, y };
      }
    }
    return null;
  });
  expect(blankPoint).not.toBeNull();
  await page.getByTitle("部署风力涡轮机").click();
  await page.mouse.click(blankPoint!.x, blankPoint!.y);
  await expect(page.locator(".power-node")).toHaveCount(1);
  await page.waitForTimeout(650);
  await expect(page.locator(".power-node")).toHaveCount(1);
  await page.screenshot({ path: "artifacts/qa/stress-factory-1440.png", fullPage: true });
});

test("campaign center shows chapter progress, deficits and direct recipe navigation", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await freshGame(page);
  await page.getByLabel("打开主线任务中心").first().click();
  const campaign = page.getByRole("dialog", { name: "主线任务中心" });
  await expect(campaign).toBeVisible();
  await expect(campaign).toContainText("母星点火");
  await expect(campaign).toContainText("采集第一份矿石");
  await expect(campaign.locator(".campaign-deficits").first()).toContainText("缺少");
  await campaign.getByRole("button", { name: "查看铁矿石配方" }).click();
  const recipes = page.getByRole("dialog", { name: "生产资料库" });
  await expect(recipes).toBeVisible();
  await expect(recipes.locator(".recipe-item-header")).toContainText("铁矿石");
  await recipes.getByLabel("关闭生产资料库").click();
  await page.getByLabel("打开主线任务中心").first().click();
  await expect(page.getByRole("dialog", { name: "主线任务中心" })).toBeVisible();
  await page.waitForTimeout(220);
  await page.screenshot({ path: "artifacts/qa/campaign-center-1440.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => campaign.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/campaign-center-390.png", fullPage: true });
});

test("campaign migration preserves legacy inventory while restoring task progress", async ({ page }) => {
  await freshGame(page);
  await page.reload();
  await page.evaluate(() => window.dispatchEvent(new Event("beforeunload")));
  await page.evaluate(() => {
    const raw = window.localStorage.getItem("dsp-idle-network.save.v1");
    const envelope = JSON.parse(raw!);
    envelope.state.version = 17;
    envelope.state.paused = true;
    envelope.state.manualMined = 1;
    delete envelope.state.campaign;
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify(envelope));
  });
  await page.reload();
  await page.getByLabel("打开主线任务中心").first().click();
  const campaign = page.getByRole("dialog", { name: "主线任务中心" });
  await expect(campaign).toContainText("铸造基础铁块");
  await expect(page.locator(".construction-item").filter({ hasText: "传送带 Mk.I" }).first()).toContainText("×10");
});

test("galaxy endgame campaign routes into the console and difficulty controls stay accessible", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openCampaignEndgameStageGame(page);
  await page.getByLabel("打开主线任务中心").first().click();
  const campaign = page.getByRole("dialog", { name: "主线任务中心" });
  await expect(campaign).toContainText("银河终局");
  await expect(campaign).toContainText("启动无限科研");
  await campaign.getByRole("button", { name: "打开银河工业控制台" }).first().click();
  const statistics = page.getByRole("dialog", { name: "生产统计" });
  await expect(statistics).toBeVisible();
  await expect(statistics.getByRole("tab", { name: /银河/ })).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("Escape");
  await expect(statistics).toHaveCount(0);
  await page.getByLabel("打开设置").click();
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.getByRole("tab", { name: "设置" }).click();
  await selectSettingsCategory(operations, "教程、版本与其他", "other");
  await expect(operations).toContainText("工业难度");
  await operations.getByRole("button", { name: "高压" }).click();
  await expect(operations.getByRole("button", { name: "高压" })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Space");
  await expect(page.getByLabel("暂停模拟")).toBeVisible();
});

test("galaxy network edits local accounts while browsing the public ranking anonymously", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const fulfill = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (pathname === "/api/leaderboard") return fulfill({ entries: [] });
    if (pathname === "/api/health") return fulfill({ ok: true, schemaVersion: 7 });
    if (pathname === "/api/public-status") return fulfill({ players: { total: 0, today: 0, online: 0, onlineWindowSeconds: 120 }, serverTime: Date.now() });
    if (pathname === "/api/analytics" || pathname === "/api/presence") return fulfill({ accepted: true }, 202);
    return fulfill({ error: `unmocked ${pathname}` }, 404);
  });
  await freshGame(page);
  await page.getByLabel("打开银河网络").click();
  const galaxy = page.getByRole("dialog", { name: "银河网络" });
  await expect(galaxy).toBeVisible();
  await expect(galaxy).toContainText("服务端真实玩家排行榜");
  await expect(galaxy).toContainText("本季还没有可公开展示的玩家排名");

  await expect(galaxy.getByRole("button", { name: "登录后刷新排名" })).toBeDisabled();
  await expect(galaxy).toContainText("访客可查看真实玩家排名");

  await galaxy.getByRole("tab", { name: "账户" }).click();
  await galaxy.getByLabel("账户显示名称").fill("赫利俄斯试验局");
  await galaxy.getByRole("button", { name: "保存名称" }).click();
  await expect(galaxy).toContainText("赫利俄斯试验局");
  await galaxy.locator(".galaxy-avatar-picker").getByRole("button", { name: "D", exact: true }).click();
  await galaxy.locator(".galaxy-privacy-setting").click();
  await expect(galaxy).toContainText("已退出排行榜");
  await galaxy.getByRole("tab", { name: "银河排行" }).click();
  await expect(galaxy.getByRole("button", { name: "已退出公开排行榜" })).toBeDisabled();
  await expect.poll(async () => page.evaluate(() => window.localStorage.getItem("dsp-idle-network.leaderboard.v1") ?? "")).not.toContain("acct_");

  await galaxy.getByRole("tab", { name: "账户" }).click();
  await galaxy.getByLabel("新账户名称").fill("北辰备用身份");
  await galaxy.getByLabel("创建本地账户").click();
  await expect(galaxy.locator(".galaxy-account-list")).toContainText("北辰备用身份");
  await page.screenshot({ path: "artifacts/qa/galaxy-account-1440.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await galaxy.getByRole("tab", { name: "银河排行" }).click();
  await expect.poll(async () => galaxy.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(galaxy.locator(".galaxy-category-tabs")).toBeVisible();
  await page.screenshot({ path: "artifacts/qa/galaxy-ranking-390.png", fullPage: true });
});

test("galaxy rankings are public to visitors and refresh from the main cloud save", async ({ page }) => {
  let refreshRequest: Record<string, unknown> | null = null;
  let leaderboardVisible = true;
  const serverMetrics = {
    energyGeneratedMj: 1_500_000_000,
    uploadedWhiteMatrix: 400_000,
    peakWhiteMatrixPerMinute: 12_000,
    peakGenerationKw: 2_300_000,
    peakThroughputPerMinute: 150_000,
    theoreticalPeakThroughputPerMinute: 700_000,
    activePlanetThroughputPerMinute: 50_000,
    galacticThroughputPerMinute: 600_000,
    nominalThroughputMetricVersion: "galactic-planet-sum-v1",
    throughputMetricVersion: "settled-total-produced-v1",
    throughputWindowSeconds: 60,
    peakDysonPowerKw: 1_500_000,
    exploredSystems: 2,
    colonizedPlanets: 4,
    galaxyScore: 6_635_517,
  };
  const cloudUser = {
    id: "user_unverified_ranker",
    username: "unverified_ranker",
    email: "",
    displayName: "矩阵档案局",
    createdAt: 1,
    emailVerified: false,
    emailVerifiedAt: null,
    passwordChangedAt: 1,
    leaderboardVisible: true,
  };
  const cloudSave = {
    revision: 1,
    updatedAt: Date.now(),
    size: 2048,
    checksum: "ranker-cloud-save",
    summary: { stateVersion: 34, savedAt: Date.now(), elapsedSeconds: 1000, activePlanetId: "home", entityCount: 1, completedTechCount: 1, structurePoints: 0, uploadedWhiteMatrix: 400_000, stateChecksum: "ranker-state" },
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const fulfill = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (pathname === "/api/health") return fulfill({ ok: true, schemaVersion: 7, mailProvider: "disabled" });
    if (pathname === "/api/account") return fulfill({ user: cloudUser, cloudSave, cloudSaves: { main: cloudSave, "1": null, "2": null, "3": null } });
    if (pathname === "/api/leaderboard/visibility") {
      leaderboardVisible = (request.postDataJSON() as { visible: boolean }).visible;
      cloudUser.leaderboardVisible = leaderboardVisible;
      return fulfill({ visible: leaderboardVisible, user: cloudUser, autoJoined: leaderboardVisible });
    }
    if (pathname === "/api/leaderboard" && request.method() === "POST") {
      refreshRequest = request.postDataJSON() as Record<string, unknown>;
      return fulfill({ verified: true });
    }
    if (pathname === "/api/leaderboard") {
      const category = new URL(request.url()).searchParams.get("category");
      const value = category === "power" ? serverMetrics.energyGeneratedMj : category === "upload" ? serverMetrics.uploadedWhiteMatrix : category === "white-rate" ? serverMetrics.peakWhiteMatrixPerMinute : category === "dyson" ? serverMetrics.peakDysonPowerKw : category === "throughput" ? serverMetrics.peakThroughputPerMinute : serverMetrics.galaxyScore;
      return fulfill({ entries: leaderboardVisible ? [{ userId: cloudUser.id, accountId: cloudUser.id, displayName: cloudUser.displayName, avatar: "矩", seasonId: "season_01", metrics: serverMetrics, submittedAt: Date.now(), value, verified: true, rank: 1 }] : [] });
    }
    if (pathname === "/api/public-status") return fulfill({ players: { total: 1, today: 1, online: 1, onlineWindowSeconds: 120 }, serverTime: Date.now() });
    if (pathname === "/api/analytics") return fulfill({ accepted: true }, 202);
    return fulfill({ error: `unmocked ${pathname}` }, 404);
  });
  await page.addInitScript(() => {
    const accountId = "acct_qa_ranker";
    window.localStorage.setItem("dsp-idle-network.account.v1", JSON.stringify({
      version: 1,
      activeAccountId: accountId,
      accounts: {
        [accountId]: {
          profile: { id: accountId, displayName: "矩阵档案局", avatar: "F", privacy: "public", createdAt: 1, updatedAt: 1 },
          ledger: {
            energyGeneratedMj: 1_500_000_000,
            uploadedWhiteMatrix: 400_000,
            peakGenerationKw: 2_300_000,
            peakThroughputPerMinute: 150_000,
            peakDysonPowerKw: 1_500_000,
            exploredSystems: 2,
            colonizedPlanets: 4,
            lastGameElapsedSeconds: 0,
            lastWhiteMatrixTotal: 0,
            lastSyncedAt: Date.now(),
          },
        },
      },
    }));
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByLabel("打开银河网络").click();
  let galaxy = page.getByRole("dialog", { name: "银河网络" });
  await expect(galaxy).toContainText("真实玩家");
  await expect(galaxy).toContainText("矩阵档案局");
  await expect(galaxy).toContainText("访客可查看真实玩家排名");

  await page.evaluate(() => window.localStorage.setItem("dsp-idle-network.cloud-token.v1", "unverified-ranker-token"));
  await page.reload();
  await page.getByLabel("打开银河网络").click();
  galaxy = page.getByRole("dialog", { name: "银河网络" });
  await galaxy.getByRole("tab", { name: /白矩阵上传/ }).click();
  const localRow = galaxy.locator(".galaxy-rank-row--local");
  await expect(localRow).toContainText("矩阵档案局");
  await expect(localRow.locator(".galaxy-rank-value")).toContainText("40万");
  await galaxy.getByRole("button", { name: "立即刷新排名" }).click();
  await expect(galaxy.getByRole("button", { name: "排名已刷新" })).toBeVisible();
  await expect(localRow).toContainText("主云存档计算");
  expect(refreshRequest).toEqual({ seasonId: "season_01" });

  await galaxy.getByRole("tab", { name: /白糖产量/ }).click();
  await expect(localRow.locator(".galaxy-rank-value")).toContainText("1.2万");
  await expect(galaxy).toContainText("白糖产量峰值");
  await expect(galaxy.locator(".galaxy-upload-panel")).toContainText("实际结算吞吐15万");
  await expect(galaxy.locator(".galaxy-upload-panel")).toContainText("当前星球理论速率5万");
  await expect(galaxy.locator(".galaxy-upload-panel")).toContainText("全星区理论速率60万");
  await expect(galaxy.locator(".galaxy-upload-panel")).toContainText("全星区理论峰值70万");

  await galaxy.getByRole("tab", { name: /累计发电/ }).click();
  await expect(localRow.locator(".galaxy-rank-value")).toContainText("15亿");
  await galaxy.locator(".galaxy-leaderboard-visibility input").click();
  await expect(galaxy.locator(".galaxy-leaderboard-visibility input")).not.toBeChecked();
  await expect(galaxy).toContainText("本季还没有可公开展示的玩家排名");
  await expect(galaxy.getByRole("button", { name: "已退出公开排行榜" })).toBeDisabled();
  await galaxy.locator(".galaxy-leaderboard-visibility input").click();
  await expect(galaxy.locator(".galaxy-leaderboard-visibility input")).toBeChecked();
  await expect(galaxy.locator(".galaxy-rank-row--local")).toContainText("矩阵档案局");
  expect(await page.evaluate(() => JSON.parse(window.localStorage.getItem("dsp-idle-network.leaderboard.v1") ?? "[]"))).toEqual([]);
  await page.screenshot({ path: "artifacts/qa/galaxy-power-1440.png", fullPage: true });
});

test("star map yields immediately to every primary workspace on desktop and mobile", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await freshGame(page);
  const starMap = page.getByRole("dialog", { name: "星图" });

  for (const target of [
    { opener: "打开生产统计", dialog: "生产统计" },
    { opener: "打开生产资料库", dialog: "生产资料库" },
    { opener: "打开科技树", dialog: "科技树" },
  ] as const) {
    await page.getByLabel("打开星图").click();
    await expect(starMap).toBeVisible();
    await page.getByLabel(target.opener).click();
    await expect(starMap).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: target.dialog })).toBeVisible();
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel("更多工作区").click();
  await page.getByRole("menuitem", { name: "星图" }).click();
  await expect(starMap).toBeVisible();
  await page.getByLabel("更多工作区").click();
  await page.getByRole("menuitem", { name: "生产资料库" }).click();
  await expect(starMap).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "生产资料库" })).toBeVisible();
});

test("all font scales keep the header and both construction-dock modes inside desktop and phone viewports", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await freshGame(page);
  await dismissOnboarding(page);

  const scales = [80, 100, 125, 150, 200] as const;
  const viewports = [
    { width: 1440, height: 900, name: "desktop" },
    { width: 390, height: 844, name: "portrait" },
    { width: 844, height: 390, name: "landscape" },
  ] as const;
  const layoutFits = () => page.evaluate(() => {
    const header = document.querySelector<HTMLElement>(".game-header");
    const dock = document.querySelector<HTMLElement>(".construction-dock");
    const itemsViewport = document.querySelector<HTMLElement>(".construction-items");
    if (!header || !dock || !itemsViewport) return { ok: false, reason: "missing shell" };
    const headerBox = header.getBoundingClientRect();
    const dockBox = dock.getBoundingClientRect();
    const itemsBox = itemsViewport.getBoundingClientRect();
    const visibleItems = [...dock.querySelectorAll<HTMLElement>(".construction-item")].filter((item) => {
      const box = item.getBoundingClientRect();
      return box.right > 0 && box.left < innerWidth && box.bottom > dockBox.top && box.top < dockBox.bottom;
    });
    const itemVerticalFit = visibleItems.every((item) => {
      const box = item.getBoundingClientRect();
      return box.top >= dockBox.top - 1 && box.bottom <= dockBox.bottom + 1;
    });
    const clickable = visibleItems.filter((item) => {
      const box = item.getBoundingClientRect();
      const center = box.left + box.width / 2;
      return center >= itemsBox.left && center <= itemsBox.right;
    }).every((item) => {
      const box = item.getBoundingClientRect();
      const hit = document.elementFromPoint(Math.max(1, Math.min(innerWidth - 1, box.left + box.width / 2)), Math.max(1, Math.min(innerHeight - 1, box.top + box.height / 2)));
      return Boolean(hit?.closest(".construction-item, .construction-item-craft"));
    });
    const metricOverlap = [...header.querySelectorAll<HTMLElement>(".header-metrics > div")].some((metric) => {
      const label = metric.querySelector<HTMLElement>(":scope > span")?.getBoundingClientRect();
      const value = metric.querySelector<HTMLElement>(":scope > strong")?.getBoundingClientRect();
      if (!label || !value || getComputedStyle(metric).display === "none") return false;
      return label.bottom > value.top + 3;
    });
    const shellFit = headerBox.top >= -1 && headerBox.bottom <= innerHeight + 1 && dockBox.top >= -1 && dockBox.bottom <= innerHeight + 1;
    return {
      ok: shellFit && itemVerticalFit && clickable && !metricOverlap && visibleItems.length > 0 && document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      shellFit,
      itemVerticalFit,
      clickable,
      metricOverlap,
      visibleItems: visibleItems.length,
      dock: { top: dockBox.top, bottom: dockBox.bottom, height: dockBox.height },
      items: visibleItems.map((item) => { const box = item.getBoundingClientRect(); return { top: box.top, bottom: box.bottom, height: box.height }; }),
    };
  });

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    for (const compact of [false, true]) {
      const dock = page.locator(".construction-dock");
      const active = await dock.evaluate((element) => element.classList.contains("construction-dock--compact"));
      if (active !== compact) await page.getByLabel(compact ? "开启施工托盘精简模式" : "关闭施工托盘精简模式").click();
      for (const scale of scales) {
        await page.evaluate((value) => {
          document.documentElement.dataset.uiFontScale = String(value);
          document.documentElement.style.setProperty("--ui-font-scale", String(value / 100));
        }, scale);
        await page.waitForTimeout(60);
        const outcome = await layoutFits();
        expect(outcome, `${viewport.name} ${compact ? "compact" : "standard"} ${scale}%: ${JSON.stringify(outcome)}`).toMatchObject({ ok: true });
        if (scale === 200) await page.screenshot({ path: `artifacts/qa/font-200-${viewport.name}-${compact ? "compact" : "standard"}.png`, fullPage: true });
      }
    }
  }
});

test("coarse-pointer edge dragging stops moving the canvas immediately after release", async ({ browser }) => {
  const { context, page } = await createTouchPage(browser, { width: 390, height: 844 });
  try {
    await freshGame(page);
    await dismissOnboarding(page);
    await page.locator(".react-flow__controls-fitview").click();
    const node = page.locator(".vein-node").filter({ hasText: "铁矿石" });
    const nodeBox = await node.boundingBox();
    const paneBox = await page.locator(".react-flow__pane").boundingBox();
    expect(nodeBox).not.toBeNull();
    expect(paneBox).not.toBeNull();
    const readTransform = () => page.locator(".react-flow__viewport").evaluate((element) => {
      const matrix = new DOMMatrix(getComputedStyle(element).transform);
      return { x: matrix.e, y: matrix.f, zoom: matrix.a };
    });
    const before = await readTransform();
    const session = await context.newCDPSession(page);
    const start = { x: Math.round(nodeBox!.x + nodeBox!.width / 2), y: Math.round(nodeBox!.y + nodeBox!.height / 2) };
    const edge = { x: Math.round(paneBox!.x + paneBox!.width - 3), y: start.y };
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...start, id: 1, radiusX: 4, radiusY: 4, force: 1 }] });
    for (let step = 1; step <= 5; step += 1) {
      await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: Math.round(start.x + (edge.x - start.x) * step / 5), y: edge.y, id: 1, radiusX: 4, radiusY: 4, force: 1 }] });
      await page.waitForTimeout(35);
    }
    await page.waitForTimeout(240);
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    const released = await readTransform();
    await page.waitForTimeout(450);
    const settled = await readTransform();
    expect(Math.hypot(released.x - before.x, released.y - before.y)).toBeLessThan(3);
    expect(Math.hypot(settled.x - released.x, settled.y - released.y)).toBeLessThan(0.5);
  } finally {
    await context.close();
  }
});

test("planet tray limits edit independently and small storage ports stay separated at 200 percent", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openInterstellarGame(page);
  const limitInput = page.locator(".tray-limit-control input");
  await limitInput.fill("2500");
  await limitInput.blur();
  await expect(limitInput).toHaveValue("2500");
  await page.getByTitle("切换到烬原 II").click();
  await expect(limitInput).toHaveValue("1000000");
  await limitInput.fill("5000");
  await limitInput.blur();
  await page.getByTitle("切换到澄海 I").click();
  await expect(limitInput).toHaveValue("2500");

  await page.reload();
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBeltNetworkGame(page);
  await page.locator(".react-flow__controls-fitview").click();
  await page.evaluate(() => {
    document.documentElement.dataset.uiFontScale = "200";
    document.documentElement.style.setProperty("--ui-font-scale", "2");
  });
  const storage = page.locator('.react-flow__node[data-id="network_buffer"] .storage-buffer-node');
  const laneGeometry = () => storage.locator(".logistics-slot-row").evaluate((row) => {
    const columns = [...row.querySelectorAll<HTMLElement>(":scope > .node-io__column")];
    if (columns.length !== 2) return { columns: columns.length, separated: false, withinCard: false };
    const input = columns[0].getBoundingClientRect();
    const output = columns[1].getBoundingClientRect();
    const article = row.closest<HTMLElement>(".storage-buffer-node")?.getBoundingClientRect();
    const separated = input.right <= output.left + 1 || input.bottom <= output.top + 1;
    const withinCard = Boolean(article
      && input.left >= article.left - 1
      && input.right <= article.right + 1
      && output.left >= article.left - 1
      && output.right <= article.right + 1);
    return {
      columns: columns.length,
      separated,
      withinCard,
      article: article && { left: article.left, right: article.right },
      input: { left: input.left, right: input.right, top: input.top, bottom: input.bottom },
      output: { left: output.left, right: output.right, top: output.top, bottom: output.bottom },
    };
  });
  await expect.poll(laneGeometry).toMatchObject({ columns: 2, separated: true, withinCard: true });
  await page.screenshot({ path: "artifacts/qa/storage-ports-font-200-desktop.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".react-flow__controls-fitview").click();
  await expect.poll(async () => (await laneGeometry()).columns).toBe(2);
  const portraitGeometry = await laneGeometry();
  expect(portraitGeometry, JSON.stringify(portraitGeometry)).toMatchObject({ columns: 2, separated: true, withinCard: true });
  await page.screenshot({ path: "artifacts/qa/storage-ports-font-200-portrait.png", fullPage: true });
});
