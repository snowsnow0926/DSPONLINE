import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

async function openSaves(page: Page) {
  await page.getByLabel("打开设置", { exact: true }).click();
  const panel = page.getByRole("dialog", { name: "运营中心", exact: true });
  await panel.getByRole("tab", { name: "存档", exact: true }).click();
  return panel;
}

async function exportedEnvelope(page: Page) {
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出压缩存档", exact: true }).click();
  const download = await downloaded;
  const path = await download.path();
  if (!path) throw new Error("Missing isolated export");
  const bytes = await readFile(path);
  return JSON.parse((download.suggestedFilename().endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8"));
}

// The existing v108 fixture checksum lets the mock serve a valid envelope
// derived from a real public-UI export, without importing browser source.
function fixtureChecksum(formatVersion: number, state: unknown) {
  const payload = JSON.stringify({ formatVersion, state });
  let hash = 0x811c9dc5;
  for (let index = 0; index < payload.length; index += 1) {
    hash ^= payload.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

test("cloud replacement requires a verified recovery snapshot and retries safely", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(30_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    localStorage.setItem("dsp-idle-network.cloud-token.v1", "isolated-snapshot-fixture-token");
    if (sessionStorage.getItem("cloud-snapshot-seeded")) return;
    sessionStorage.setItem("cloud-snapshot-seeded", "1");
    localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-11-04-v1.3.7");
    localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
    localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state: {
      version: 47, entities: [], belts: [], construction: {}, tray: { iron_ore: 42 }, paused: true,
      research: { selectedTechId: null, progressByTech: {}, completedTechIds: ["electromagnetism"] },
      blueprints: Array.from({ length: 12 }, (_, index) => ({ id: `cloud-original-${index}`, name: `original blueprint ${index}`, revision: 1, rotation: 0, mirror: "none", entities: [{ key: "smelter", buildingId: "arc_smelter", offset: { x: 0, y: 0 }, machineCount: 1, recipeId: "iron_ingot" }], belts: [] })),
      settings: { theme: "dark", fontScale: 1, simulationSpeed: 1, autosaveIntervalSeconds: 0 },
    } }));
  });
  const now = Date.now();
  const user = { id: "isolated-snapshot-user", username: "snapshot_fixture", email: "", displayName: "回滚保护测试", createdAt: now, emailVerified: false, emailVerifiedAt: null, passwordChangedAt: now, leaderboardVisible: false };
  let remotePayload = "";
  let remoteChecksum = "";
  const metadata = () => ({ mode: "normal", slot: "main", revision: 2, updatedAt: now, size: Buffer.byteLength(remotePayload), checksum: "isolated-server-checksum", summary: { mode: "normal", stateVersion: 47, savedAt: now, elapsedSeconds: 0, activePlanetId: "home", entityCount: 0, completedTechCount: 1, structurePoints: 0, uploadedWhiteMatrix: 0, stateChecksum: remoteChecksum, integrity: "valid" } });
  const writes: string[] = [];
  await page.route("**/api/**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const fulfill = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/health") return fulfill({ ok: true, mailProvider: "disabled" });
    if (path === "/api/account" && request.method() === "GET") return fulfill({ user, cloudSave: metadata(), cloudSaves: { main: metadata(), "1": null, "2": null, "3": null } });
    if (path === "/api/account/sessions") return fulfill({ sessions: [] });
    if (path === "/api/cloud-save/history") return fulfill({ history: [metadata()] });
    if (path === "/api/cloud-save" && request.method() === "GET") return fulfill({ cloudSave: { ...metadata(), payload: remotePayload } });
    if (path.startsWith("/api/cloud-save") && request.method() !== "GET") writes.push(`${request.method()} ${path}`);
    return fulfill({ error: "isolated route unavailable" }, 404);
  });
  await page.goto("/");
  await expect(page.locator(".factory-canvas")).toBeVisible({ timeout: 60_000 });
  await openSaves(page);
  const original = await exportedEnvelope(page);
  expect(original.state.tray.iron_ore).toBe(42);
  expect(original.state.blueprints).toHaveLength(12);
  const remote = JSON.parse(JSON.stringify(original));
  remote.state.tray.iron_ore = 99;
  remote.state.blueprints = [];
  remote.checksum = fixtureChecksum(remote.formatVersion, remote.state);
  remoteChecksum = remote.checksum;
  remotePayload = JSON.stringify(remote);
  await page.getByLabel("关闭运营中心", { exact: true }).click();
  await page.evaluate(() => Object.defineProperty(navigator, "storage", { configurable: true, value: { estimate: async () => ({ quota: 1024 * 1024, usage: 1024 * 1024 - (256 * 1024 + 512) }) } }));
  await page.getByLabel("打开银河网络", { exact: true }).click();
  let galaxy = page.getByRole("dialog", { name: "银河网络", exact: true });
  await expect(galaxy).toBeVisible({ timeout: 60_000 });
  await galaxy.getByRole("tab", { name: "云存档", exact: true }).click();
  await galaxy.getByRole("button", { name: "下载到本机", exact: true }).click();
  const confirmation = page.getByRole("alertdialog", { name: "确认恢复云存档", exact: true });
  await confirmation.getByRole("button", { name: "确认恢复", exact: true }).click();
  await expect.poll(async () => (await galaxy.allTextContents()).join(";") || "factory-replaced", { timeout: 60_000 }).toMatch(/factory-replaced|云存档恢复前快照创建失败/);
  const feedback = (await galaxy.allTextContents()).join(";") || "factory-replaced";
  if (await confirmation.isVisible()) await confirmation.getByRole("button", { name: "取消", exact: true }).click();
  if (await galaxy.isVisible()) await galaxy.getByLabel("关闭银河网络", { exact: true }).click();
  let saves = await openSaves(page);
  const count = await saves.locator(".save-snapshot-row").filter({ hasText: "恢复云存档前" }).count();
  await testInfo.attach("cloud-replacement-admission", { body: JSON.stringify({ snapshotCount: count, feedback, errors, writes }), contentType: "application/json" });
  expect.soft(feedback).toContain("云存档恢复前快照创建失败");
  expect.soft(await page.locator('.tray-row[title="拿取铁矿石"] strong').textContent()).toBe("42");
  expect(count).toBe(0);
  await page.reload();
  await expect(page.locator(".factory-canvas")).toBeVisible({ timeout: 60_000 });
  saves = await openSaves(page);
  const preserved = await exportedEnvelope(page);
  expect(preserved.state.tray.iron_ore).toBe(42);
  expect(preserved.state.blueprints).toHaveLength(12);
  expect(preserved.state.research.completedTechIds).toEqual(["electromagnetism"]);
  expect(preserved.state.settings.autosaveIntervalSeconds).toBe(0);
  await page.getByLabel("关闭运营中心", { exact: true }).click();
  await page.getByLabel("打开银河网络", { exact: true }).click();
  galaxy = page.getByRole("dialog", { name: "银河网络", exact: true });
  await expect(galaxy).toBeVisible({ timeout: 60_000 });
  await galaxy.getByRole("tab", { name: "云存档", exact: true }).click();
  await galaxy.getByRole("button", { name: "下载到本机", exact: true }).click();
  await confirmation.getByRole("button", { name: "确认恢复", exact: true }).click();
  await expect(galaxy).toBeHidden({ timeout: 60_000 });
  saves = await openSaves(page);
  const recovery = saves.locator(".save-snapshot-row").filter({ hasText: "恢复云存档前" });
  await expect(recovery).toHaveCount(1);
  await expect(page.locator('.tray-row[title="拿取铁矿石"] strong')).toHaveText("99");
  await recovery.getByRole("button", { name: /^回滚到快照 / }).click();
  await expect(page.locator('.tray-row[title="拿取铁矿石"] strong')).toHaveText("42", { timeout: 60_000 });
  await openSaves(page);
  const rolledBack = await exportedEnvelope(page);
  expect(rolledBack.state.blueprints).toHaveLength(12);
  expect(rolledBack.state.settings.autosaveIntervalSeconds).toBe(0);
  expect(errors).toEqual([]);
  expect(writes).toEqual([]);
});

for (const scenario of ["switch", "repeat"] as const) {
test(scenario === "switch" ? "an earlier cloud restore cannot replace a factory subsequently loaded from a slot" : "cloud restore confirmation starts only one asynchronous preparation", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(30_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    localStorage.setItem("dsp-idle-network.cloud-token.v1", "isolated-cloud-epoch-token");
    if (sessionStorage.getItem("cloud-epoch-seeded")) return;
    sessionStorage.setItem("cloud-epoch-seeded", "1");
    localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-11-04-v1.3.7");
    localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
    const state = {
      version: 47, entities: [], belts: [], construction: {}, tray: { iron_ore: 42 }, paused: true,
      research: { selectedTechId: null, progressByTech: {}, completedTechIds: ["electromagnetism"] },
      blueprints: Array.from({ length: 12 }, (_, index) => ({ id: `cloud-epoch-${index}`, name: `original blueprint ${index}`, revision: 1, rotation: 0, mirror: "none", entities: [{ key: "smelter", buildingId: "arc_smelter", offset: { x: 0, y: 0 }, machineCount: 1, recipeId: "iron_ingot" }], belts: [] })),
      settings: { theme: "dark", fontScale: 1, simulationSpeed: 1, autosaveIntervalSeconds: 0 },
    };
    localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
    localStorage.setItem("dsp-idle-network.slot.1", JSON.stringify({ savedAt: Date.now(), kind: "slot", slot: 1, state: { ...state, tray: { iron_ore: 88 } } }));
  });
  const now = Date.now();
  const user = { id: "isolated-cloud-epoch", username: "cloud_epoch_fixture", email: "", displayName: "云恢复归属测试", createdAt: now, emailVerified: false, emailVerifiedAt: null, passwordChangedAt: now, leaderboardVisible: false };
  let payload = "", checksum = "";
  const metadata = () => ({ mode: "normal", slot: "main", revision: 2, updatedAt: now, size: Buffer.byteLength(payload), checksum: "isolated-epoch-server-checksum", summary: { mode: "normal", stateVersion: 47, savedAt: now, elapsedSeconds: 0, activePlanetId: "home", entityCount: 0, completedTechCount: 1, structurePoints: 0, uploadedWhiteMatrix: 0, stateChecksum: checksum, integrity: "valid" } });
  await page.route("**/api/**", (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const fulfill = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/health") return fulfill({ ok: true, mailProvider: "disabled" });
    if (path === "/api/account" && request.method() === "GET") return fulfill({ user, cloudSave: metadata(), cloudSaves: { main: metadata(), "1": null, "2": null, "3": null } });
    if (path === "/api/account/sessions") return fulfill({ sessions: [] });
    if (path === "/api/cloud-save/history") return fulfill({ history: [metadata()] });
    if (path === "/api/cloud-save" && request.method() === "GET") return fulfill({ cloudSave: { ...metadata(), payload } });
    return fulfill({ error: "isolated cloud epoch route unavailable" }, 404);
  });
  await page.goto("/");
  await expect(page.locator(".factory-canvas")).toBeVisible({ timeout: 60_000 });
  await openSaves(page);
  const envelope = await exportedEnvelope(page);
  envelope.state.tray.iron_ore = 99;
  envelope.state.blueprints = [];
  envelope.checksum = fixtureChecksum(envelope.formatVersion, envelope.state);
  checksum = envelope.checksum;
  payload = JSON.stringify(envelope);
  await page.evaluate(() => {
    const nativePost = Worker.prototype.postMessage;
    const gate = { pending: false, released: false, automaticRelease: false, requests: 0, release: () => {} };
    Object.defineProperty(window, "__cloudScopeGate", { configurable: true, value: gate });
    Worker.prototype.postMessage = function (this: Worker, ...args) {
      const message = args[0];
      if (message?.kind === "snapshot" && message.reason === "恢复云存档前") gate.requests += 1;
      if (!gate.pending && message?.kind === "snapshot" && message.reason === "恢复云存档前") {
        gate.pending = true;
        let timer = 0;
        gate.release = () => { if (gate.released) return; gate.released = true; clearTimeout(timer); Worker.prototype.postMessage = nativePost; Reflect.apply(nativePost, this, args); };
        timer = window.setTimeout(() => { gate.automaticRelease = true; gate.release(); }, 60_000);
        return;
      }
      Reflect.apply(nativePost, this, args);
    };
  });
  await page.getByLabel("关闭运营中心", { exact: true }).click();
  await page.getByLabel("打开银河网络", { exact: true }).click();
  const galaxy = page.getByRole("dialog", { name: "银河网络", exact: true });
  await expect(galaxy).toBeVisible({ timeout: 60_000 });
  await galaxy.getByRole("tab", { name: "云存档", exact: true }).click();
  await galaxy.getByRole("button", { name: "下载到本机", exact: true }).click();
  await page.getByRole("alertdialog", { name: "确认恢复云存档", exact: true }).getByRole("button", { name: "确认恢复", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __cloudScopeGate: { pending: boolean } }).__cloudScopeGate.pending)).toBe(true);
  if (scenario === "repeat") {
    const confirmation = page.getByRole("alertdialog", { name: "确认恢复云存档", exact: true });
    const offeredAgain = await confirmation.isVisible();
    if (offeredAgain) {
      await confirmation.getByRole("button", { name: "确认恢复", exact: true }).click();
      await expect.poll(() => page.evaluate(() => (window as unknown as { __cloudScopeGate: { requests: number } }).__cloudScopeGate.requests), { timeout: 30_000 }).toBeGreaterThan(1);
    }
    const requests = await page.evaluate(() => (window as unknown as { __cloudScopeGate: { requests: number } }).__cloudScopeGate.requests);
    await testInfo.attach("cloud-repeat-outcome", { body: JSON.stringify({ offeredAgain, requests }), contentType: "application/json" });
    expect.soft(offeredAgain).toBe(false);
    expect.soft(requests).toBe(1);
    await expect(galaxy.getByRole("button", { name: "下载到本机", exact: true })).toBeDisabled();
    await page.evaluate(() => (window as unknown as { __cloudScopeGate: { release(): void } }).__cloudScopeGate.release());
    await expect(galaxy).toBeHidden({ timeout: 60_000 });
    await expect(page.locator('.tray-row[title="拿取铁矿石"] strong')).toHaveText("99", { timeout: 60_000 });
    await openSaves(page);
    const persisted = await exportedEnvelope(page);
    expect(persisted.state.tray.iron_ore).toBe(99);
    expect(persisted.state.blueprints).toHaveLength(0);
    expect(persisted.state.settings.autosaveIntervalSeconds).toBe(0);
    expect(errors).toEqual([]);
    return;
  }
  await page.keyboard.press("Escape");
  await expect(galaxy).toBeHidden();
  let panel = await openSaves(page);
  await panel.getByLabel("载入槽位 1", { exact: true }).click();
  await expect(page.locator('.tray-row[title="拿取铁矿石"] strong')).toHaveText("88", { timeout: 60_000 });
  panel = await openSaves(page);
  await expect(panel.locator(".operations-saves")).toHaveAttribute("aria-busy", "true");
  await page.evaluate(() => (window as unknown as { __cloudScopeGate: { release(): void } }).__cloudScopeGate.release());
  await expect(panel.locator(".operations-saves")).toHaveAttribute("aria-busy", "false", { timeout: 60_000 });
  const gate = await page.evaluate(() => { const gate = (window as unknown as { __cloudScopeGate: { released: boolean; automaticRelease: boolean } }).__cloudScopeGate; return { released: gate.released, automaticRelease: gate.automaticRelease }; });
  const afterOldRequest = await exportedEnvelope(page);
  expect(afterOldRequest.state.tray.iron_ore).toBe(88);
  expect(afterOldRequest.state.blueprints).toHaveLength(12);
  expect(afterOldRequest.state.settings.autosaveIntervalSeconds).toBe(0);
  await page.getByLabel("关闭运营中心", { exact: true }).click();
  await page.getByLabel("打开银河网络", { exact: true }).click();
  await expect(galaxy).toBeVisible({ timeout: 60_000 });
  await galaxy.getByRole("tab", { name: "云存档", exact: true }).click();
  await galaxy.getByRole("button", { name: "下载到本机", exact: true }).click();
  await page.getByRole("alertdialog", { name: "确认恢复云存档", exact: true }).getByRole("button", { name: "确认恢复", exact: true }).click();
  await expect(galaxy).toBeHidden({ timeout: 60_000 });
  await expect(page.locator('.tray-row[title="拿取铁矿石"] strong')).toHaveText("99", { timeout: 60_000 });
  panel = await openSaves(page);
  await panel.getByLabel("载入槽位 1", { exact: true }).click();
  await expect(page.locator('.tray-row[title="拿取铁矿石"] strong')).toHaveText("88", { timeout: 60_000 });
  await page.reload();
  await expect(page.locator(".factory-canvas")).toBeVisible({ timeout: 60_000 });
  await openSaves(page);
  const persisted = await exportedEnvelope(page);
  await testInfo.attach("cloud-after-slot-outcome", { body: JSON.stringify({ ore: persisted.state.tray.iron_ore, blueprints: persisted.state.blueprints.length, autosave: persisted.state.settings.autosaveIntervalSeconds, gate, errors }), contentType: "application/json" });
  expect.soft(persisted.state.tray.iron_ore).toBe(88);
  expect.soft(persisted.state.blueprints).toHaveLength(12);
  expect(persisted.state.research.completedTechIds).toEqual(["electromagnetism"]);
  expect(persisted.state.settings.autosaveIntervalSeconds).toBe(0);
  expect(gate.automaticRelease).toBe(false);
  expect(errors).toEqual([]);
});
}
