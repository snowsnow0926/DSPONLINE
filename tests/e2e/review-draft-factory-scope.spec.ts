import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

for (const editor of ["blueprint", "region"] as const) test(`factory replacement isolates a same-ID ${editor} editor with a live IME buffer`, async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(30_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors: string[] = [], writes: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    localStorage.setItem("dsp-idle-network.cloud-token.v1", "disposable-draft-scope-token");
    localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-11-04-v1.3.7");
    localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
    localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state: {
      version: 47, entities: [], belts: [], construction: {}, tray: { iron_ore: 42 }, paused: true,
      research: { selectedTechId: null, progressByTech: {}, completedTechIds: ["electromagnetism"] },
      blueprints: [{ id: "shared-blueprint", name: "甲工厂蓝图", revision: 1, rotation: 0, mirror: "none", entities: [{ key: "smelter", buildingId: "arc_smelter", offset: { x: 0, y: 0 }, machineCount: 1, recipeId: "iron_ingot" }], belts: [] }],
      canvasRegions: [{ id: "shared-region", name: "甲工厂区域", planetId: "home", x: 0, y: 0, width: 400, height: 300, fillColor: "#3c8070", borderColor: "#3c8070" }],
      settings: { theme: "dark", fontScale: 1, simulationSpeed: 1, autosaveIntervalSeconds: 0 },
    } }));
  });
  let payload = "", stateChecksum = "";
  const now = Date.now();
  const user = { id: "disposable-draft-scope", username: "draft_fixture", email: "", displayName: "草稿工厂边界测试", createdAt: now, emailVerified: false, emailVerifiedAt: null, passwordChangedAt: now, leaderboardVisible: false };
  const metadata = () => ({ mode: "normal", slot: "main", revision: 2, updatedAt: now, size: Buffer.byteLength(payload), checksum: "disposable-server-checksum", summary: { mode: "normal", stateVersion: 47, savedAt: now, elapsedSeconds: 0, activePlanetId: "home", entityCount: 0, completedTechCount: 1, structurePoints: 0, uploadedWhiteMatrix: 0, stateChecksum, integrity: "valid" } });
  await page.route("**/api/**", (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const fulfill = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/health") return fulfill({ ok: true, mailProvider: "disabled" });
    if (path === "/api/account" && request.method() === "GET") return fulfill({ user, cloudSave: metadata(), cloudSaves: { main: metadata(), "1": null, "2": null, "3": null } });
    if (path === "/api/account/sessions") return fulfill({ sessions: [] });
    if (path === "/api/cloud-save/history") return fulfill({ history: [] });
    if (path === "/api/cloud-save" && request.method() === "GET") return fulfill({ cloudSave: { ...metadata(), payload } });
    if (path.startsWith("/api/cloud-save") && request.method() !== "GET") writes.push(`${request.method()} ${path}`);
    return fulfill({ error: "disposable draft route unavailable" }, 404);
  });
  await page.goto("/");
  await expect(page.locator(".factory-canvas")).toBeVisible({ timeout: 60_000 });
  await page.getByLabel("打开设置", { exact: true }).click();
  let saves = page.getByRole("dialog", { name: "运营中心", exact: true });
  await expect(saves).toBeVisible({ timeout: 90_000 });
  await saves.getByRole("tab", { name: "存档", exact: true }).click();
  const exported = page.waitForEvent("download");
  await saves.getByRole("button", { name: "导出压缩存档", exact: true }).click();
  const download = await exported, path = await download.path();
  if (!path) throw new Error("Missing disposable factory export");
  const bytes = await readFile(path);
  const remote = JSON.parse((download.suggestedFilename().endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8"));
  remote.state.tray.iron_ore = 88;
  remote.state.blueprints[0].name = "乙工厂蓝图";
  remote.state.canvasRegions[0].name = "乙工厂区域";
  const checksumInput = JSON.stringify({ formatVersion: remote.formatVersion, state: remote.state });
  let hash = 0x811c9dc5;
  for (let index = 0; index < checksumInput.length; index++) hash = Math.imul(hash ^ checksumInput.charCodeAt(index), 0x01000193);
  stateChecksum = remote.checksum = (hash >>> 0).toString(16).padStart(8, "0");
  payload = JSON.stringify(remote);
  await page.getByLabel("关闭运营中心", { exact: true }).click();
  await page.evaluate(() => {
    const nativePost = Worker.prototype.postMessage;
    const gate = { pending: false, released: false, automaticRelease: false, release: () => {} };
    Object.defineProperty(window, "__draftFactoryGate", { configurable: true, value: gate });
    Worker.prototype.postMessage = function (this: Worker, ...args) {
      const message = args[0];
      if (!gate.pending && message?.kind === "snapshot" && message.reason === "恢复云存档前") {
        gate.pending = true;
        const worker = this;
        const timer = setTimeout(() => { gate.automaticRelease = true; gate.release(); }, 90_000);
        gate.release = () => { if (gate.released) return; gate.released = true; clearTimeout(timer); Worker.prototype.postMessage = nativePost; Reflect.apply(nativePost, worker, args); };
        return;
      }
      Reflect.apply(nativePost, this, args);
    };
  });
  await page.getByLabel("打开银河网络", { exact: true }).click();
  const galaxy = page.getByRole("dialog", { name: "银河网络", exact: true });
  await expect(galaxy).toBeVisible({ timeout: 90_000 });
  await galaxy.getByRole("tab", { name: "云存档", exact: true }).click();
  await galaxy.getByRole("button", { name: "下载到本机", exact: true }).click();
  await page.getByRole("alertdialog", { name: "确认恢复云存档", exact: true }).getByRole("button", { name: "确认恢复", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __draftFactoryGate: { pending: boolean } }).__draftFactoryGate.pending), { timeout: 60_000 }).toBe(true);
  await galaxy.getByLabel("关闭银河网络", { exact: true }).click();
  if (editor === "blueprint") await page.getByLabel("打开蓝图库", { exact: true }).first().click();
  else await page.locator('[data-region-id="shared-region"] .canvas-region__label').click();
  const field = editor === "blueprint" ? page.getByLabel("甲工厂蓝图名称", { exact: true }) : page.getByLabel("区域名称", { exact: true });
  await expect(field).toBeVisible({ timeout: 90_000 });
  await field.focus();
  await field.evaluate((element) => {
    const events: string[] = [];
    Object.defineProperty(window, "__draftFactoryEvents", { value: events });
    Object.defineProperty(window, "__oldDraftFactoryField", { value: element });
    for (const name of ["compositionstart", "compositionupdate", "compositionend", "input", "blur"]) element.addEventListener(name, () => events.push(name));
  });
  const cdp = await page.context().newCDPSession(page);
  await field.press("ControlOrMeta+A");
  await cdp.send("Input.imeSetComposition", { text: "甲工厂未确认草稿", selectionStart: 2, selectionEnd: 2 });
  await expect(field).toHaveValue("甲工厂未确认草稿");
  expect(await page.evaluate(() => (window as unknown as { __draftFactoryEvents: string[] }).__draftFactoryEvents)).toContain("compositionstart");
  await page.evaluate(() => (window as unknown as { __draftFactoryGate: { release(): void } }).__draftFactoryGate.release());
  await expect(page.locator('.tray-row[title="拿取铁矿石"] strong')).toHaveText("88", { timeout: 60_000 });
  if (editor === "region") await page.locator('[data-region-id="shared-region"] .canvas-region__label').click();
  const replacement = editor === "blueprint" ? page.getByLabel("乙工厂蓝图名称", { exact: true }) : page.getByLabel("区域名称", { exact: true });
  await expect(replacement).toBeVisible();
  const actual = await replacement.inputValue();
  expect.soft(actual).toBe(editor === "blueprint" ? "乙工厂蓝图" : "乙工厂区域");
  // A delayed event on the previous DOM editor must not rename the new factory.
  await page.evaluate(() => {
    const old = (window as unknown as { __oldDraftFactoryField: HTMLInputElement }).__oldDraftFactoryField;
    old.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "迟到的甲工厂输入" }));
  });
  await replacement.focus();
  await replacement.press("Tab");
  if (editor === "blueprint") await page.getByLabel("关闭蓝图工作区", { exact: true }).click();
  await page.getByLabel("打开设置", { exact: true }).click();
  saves = page.getByRole("dialog", { name: "运营中心", exact: true });
  await expect(saves).toBeVisible({ timeout: 90_000 });
  await saves.getByRole("tab", { name: "存档", exact: true }).click();
  const finalExport = page.waitForEvent("download");
  await saves.getByRole("button", { name: "导出压缩存档", exact: true }).click();
  const finalDownload = await finalExport, finalPath = await finalDownload.path();
  if (!finalPath) throw new Error("Missing final disposable export");
  const finalBytes = await readFile(finalPath);
  const final = JSON.parse((finalDownload.suggestedFilename().endsWith(".gz") ? gunzipSync(finalBytes) : finalBytes).toString("utf8"));
  expect.soft(final.state.blueprints[0].name).toBe("乙工厂蓝图");
  expect.soft(final.state.canvasRegions[0].name).toBe("乙工厂区域");
  expect(final.state.tray.iron_ore).toBe(88);
  expect(final.state.research.completedTechIds).toEqual(["electromagnetism"]);
  expect(final.state.settings.autosaveIntervalSeconds).toBe(0);
  const evidence = await page.evaluate(() => {
    const { pending, released, automaticRelease } = (window as unknown as { __draftFactoryGate: { pending: boolean; released: boolean; automaticRelease: boolean } }).__draftFactoryGate;
    return { pending, released, automaticRelease, events: (window as unknown as { __draftFactoryEvents: string[] }).__draftFactoryEvents };
  });
  await testInfo.attach("factory-draft-outcome", { body: JSON.stringify({ editor, actual, blueprint: final.state.blueprints[0].name, region: final.state.canvasRegions[0].name, ore: final.state.tray.iron_ore, autosave: final.state.settings.autosaveIntervalSeconds, ...evidence, errors, writes }), contentType: "application/json" });
  expect(evidence.automaticRelease).toBe(false);
  expect(errors).toEqual([]);
  expect(writes).toEqual([]);
});
