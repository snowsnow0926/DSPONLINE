import { expect, test, type Page } from "@playwright/test";
import { startupTimeoutMs, workflowTimeoutMs } from "./startup-timeout";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

async function openSaves(page: Page) {
  await page.getByLabel("打开设置", { exact: true }).click();
  const saves = page.getByRole("dialog", { name: "运营中心", exact: true });
  await saves.getByRole("tab", { name: "存档", exact: true }).click();
  return saves;
}

async function exportEnvelope(page: Page) {
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出压缩存档", exact: true }).click();
  const download = await pending, path = await download.path();
  if (!path) throw new Error("Missing disposable namespace fixture export");
  const bytes = await readFile(path);
  return JSON.parse((download.suggestedFilename().endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8"));
}

function checksum(formatVersion: number, state: unknown) {
  const raw = JSON.stringify({ formatVersion, state });
  let hash = 0x811c9dc5;
  for (let index = 0; index < raw.length; index++) hash = Math.imul(hash ^ raw.charCodeAt(index), 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

for (const scenario of [
  { surface: "galaxy", mismatch: "body-slot", local: "empty" },
  { surface: "galaxy", mismatch: "body-main", local: "empty" },
  { surface: "galaxy", mismatch: "metadata-slot", local: "empty" },
  { surface: "galaxy", mismatch: "metadata-mode", local: "empty" },
  { surface: "galaxy", mismatch: "body-slot", local: "conflict" },
  { surface: "galaxy", mismatch: "metadata-slot", local: "conflict" },
  { surface: "menu", mismatch: "body-slot", local: "empty" },
  { surface: "menu", mismatch: "metadata-slot", local: "empty" },
  { surface: "galaxy", mismatch: "none", local: "invalid" },
  { surface: "menu", mismatch: "none", local: "invalid" },
] as const) test(`cloud download namespace ${scenario.surface} ${scenario.mismatch} ${scenario.local} preserves durable targets`, async ({ page }, testInfo) => {
  test.setTimeout(workflowTimeoutMs(180_000));
  page.setDefaultTimeout(30_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors: string[] = [], writes: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    Object.defineProperty(window, "indexedDB", { configurable: true, value: { open() { throw new DOMException("disposable fixture", "InvalidStateError"); } } });
    if (sessionStorage.getItem("namespace-seeded")) return;
    sessionStorage.setItem("namespace-seeded", "1");
    localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-11-13-v1.3.13");
    localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
    localStorage.setItem("dsp-idle-network.cloud-token.v1", "disposable-namespace-token");
    const state = { version: 47, entities: [], belts: [], construction: {}, tray: { iron_ore: 42 }, paused: true,
      research: { selectedTechId: null, progressByTech: {}, completedTechIds: ["electromagnetism"] },
      blueprints: [], settings: { theme: "dark", fontScale: 1, simulationSpeed: 1, autosaveIntervalSeconds: 0 } };
    localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  let payload = "", remoteChecksum = "", downloads = 0;
  const now = Date.now();
  const user = { id: "disposable-namespace", username: "namespace_fixture", email: "", displayName: "槽位边界测试", createdAt: now, emailVerified: false, emailVerifiedAt: null, passwordChangedAt: now, leaderboardVisible: false };
  const metadata = () => ({ mode: "normal", slot: "1", revision: 2, updatedAt: now, size: Buffer.byteLength(payload), checksum: "disposable-server-checksum", summary: { mode: "normal", stateVersion: 47, savedAt: now, elapsedSeconds: 0, activePlanetId: "home", entityCount: 0, completedTechCount: 1, structurePoints: 0, uploadedWhiteMatrix: 0, stateChecksum: remoteChecksum, integrity: "valid" } });
  await page.route("**/api/**", (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const fulfill = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/health") return fulfill({ ok: true, mailProvider: "disabled" });
    if (path === "/api/account" && request.method() === "GET") return fulfill({ user, cloudSave: null, cloudSaves: { main: null, "1": payload ? metadata() : null, "2": null, "3": null } });
    if (path === "/api/account/sessions") return fulfill({ sessions: [] });
    if (path === "/api/cloud-save/history") return fulfill({ history: [] });
    if (path === "/api/cloud-save" && request.method() === "GET") {
      downloads++;
      const response = { ...metadata(), payload };
      if (scenario.mismatch === "metadata-slot") response.slot = "2";
      if (scenario.mismatch === "metadata-mode") response.mode = "speedrun";
      return fulfill({ cloudSave: response });
    }
    if (path.startsWith("/api/cloud-save") && request.method() !== "GET") writes.push(`${request.method()} ${path}`);
    return fulfill({ error: "disposable namespace route unavailable" }, 404);
  });
  await page.goto("/");
  await expect(page.locator(".factory-canvas")).toBeVisible({ timeout: startupTimeoutMs(60_000) });
  await openSaves(page);
  const original = await exportEnvelope(page);
  expect(original.state.tray.iron_ore).toBe(42);
  const local = structuredClone(original);
  local.kind = "slot"; local.slot = 1; local.state.tray.iron_ore = 88;
  local.checksum = scenario.local === "invalid" ? "bad-checksum" : checksum(local.formatVersion, local.state);
  const localRaw = scenario.local === "empty" ? null : JSON.stringify(local);
  const other = structuredClone(local);
  other.slot = 2;
  const otherRaw = JSON.stringify(other);
  await page.evaluate(({ localRaw, otherRaw }) => {
    if (localRaw !== null) localStorage.setItem("dsp-idle-network.slot.1", localRaw);
    localStorage.setItem("dsp-idle-network.slot.2", otherRaw);
  }, { localRaw, otherRaw });
  const remote = structuredClone(original);
  remote.kind = scenario.mismatch === "body-main" ? original.kind : "slot";
  remote.slot = scenario.mismatch === "body-main" ? "main" : scenario.mismatch === "body-slot" ? 2 : 1;
  remote.state.tray.iron_ore = 99;
  remoteChecksum = remote.checksum = checksum(remote.formatVersion, remote.state);
  payload = JSON.stringify(remote);
  await page.goto(scenario.surface === "menu" ? "/?menu=1" : "/");
  if (scenario.surface === "menu") {
    await expect(page.locator(".start-menu")).toBeVisible({ timeout: startupTimeoutMs(60_000) });
    await page.getByRole("button", { name: "登录与云存档", exact: true }).click();
  } else {
    await expect(page.locator(".factory-canvas")).toBeVisible({ timeout: startupTimeoutMs(60_000) });
    await page.getByLabel("打开银河网络", { exact: true }).click();
    await page.getByRole("dialog", { name: "银河网络", exact: true }).getByRole("tab", { name: "云存档", exact: true }).click();
  }
  const target = page.locator('[data-cloud-slot="1"]');
  await target.getByRole("button", { name: "下载", exact: true }).click();
  if (scenario.surface === "menu") {
    await page.getByRole("alertdialog").getByRole("button", { name: /^确认(覆盖|恢复)$/ }).click();
  } else if (scenario.local === "conflict") {
    await page.getByRole("alertdialog", { name: "本地与云端都有不同进度", exact: true }).getByRole("button", { name: "使用云端版本", exact: true }).click();
  }
  const feedback = scenario.surface === "menu"
    ? page.getByRole("region", { name: "按模式管理云存档", exact: true }).getByRole("status")
    : page.locator(".galaxy-cloud-message");
  await expect(feedback).toContainText(/阻止|取消|无法|失败|已下载|已恢复|保留云端版本/, { timeout: 60_000 });
  const message = (await feedback.allTextContents()).join(";");
  if (scenario.local === "invalid") expect.soft(message).toContain("回滚快照创建失败，原槽位保持不变");
  else expect.soft(message).toMatch(/阻止|取消|无法/);
  const stored = await page.evaluate(() => ({ local: localStorage.getItem("dsp-idle-network.slot.1"), other: localStorage.getItem("dsp-idle-network.slot.2") }));
  expect.soft(stored.local).toBe(localRaw);
  expect(stored.other).toBe(otherRaw);
  expect(downloads).toBe(1);
  if (scenario.surface === "galaxy") {
    const conflict = page.getByRole("alertdialog", { name: "本地与云端都有不同进度", exact: true });
    if (await conflict.isVisible()) await conflict.getByRole("button", { name: "稍后处理", exact: true }).click();
    await page.getByLabel("关闭银河网络", { exact: true }).click();
  } else {
    await page.goto("/");
    await expect(page.locator(".factory-canvas")).toBeVisible({ timeout: startupTimeoutMs(60_000) });
  }
  await openSaves(page);
  const preserved = await exportEnvelope(page);
  expect(preserved.state.tray.iron_ore).toBe(42);
  expect(preserved.state.research.completedTechIds).toEqual(["electromagnetism"]);
  expect(preserved.state.settings.autosaveIntervalSeconds).toBe(0);
  await testInfo.attach("namespace-outcome", { body: JSON.stringify({ ...scenario, message, localPreserved: stored.local === localRaw, otherPreserved: stored.other === otherRaw, mainOre: preserved.state.tray.iron_ore, autosave: preserved.state.settings.autosaveIntervalSeconds, downloads, errors, writes }), contentType: "application/json" });
  expect(errors).toEqual([]);
  expect(writes).toEqual([]);
});
