import { expect, test, type Page } from "@playwright/test";
import { workflowTimeoutMs } from "./startup-timeout";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

async function openSaves(page: Page) {
  await page.getByLabel("打开设置", { exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "运营中心", exact: true });
  await dialog.getByRole("tab", { name: "存档", exact: true }).click();
  return dialog;
}
async function exportedEnvelope(page: Page) {
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出压缩存档", exact: true }).click();
  const download = await pending;
  const path = await download.path();
  if (!path) throw new Error("Missing isolated export");
  const bytes = await readFile(path);
  return JSON.parse((download.suggestedFilename().endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8"));
}

for (const mode of ["rescue", "import"] as const) {
test(`an earlier ${mode} cannot replace a factory subsequently loaded from a slot`, async ({ page }, testInfo) => {
  test.setTimeout(workflowTimeoutMs(240_000));
  page.setDefaultTimeout(30_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    if (sessionStorage.getItem("rescue-slot-epoch-seeded")) return;
    sessionStorage.setItem("rescue-slot-epoch-seeded", "1");
    localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-11-14-v1.3.14");
    localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
    const state = {
      version: 47, entities: [], belts: [], construction: {}, tray: { iron_ore: 42 }, paused: true,
      research: { selectedTechId: null, progressByTech: {}, completedTechIds: ["electromagnetism"] },
      blueprints: Array.from({ length: 12 }, (_, index) => ({ id: `epoch-original-${index}`, name: `original blueprint ${index}`, revision: 1, rotation: 0, mirror: "none", entities: [{ key: "smelter", buildingId: "arc_smelter", offset: { x: 0, y: 0 }, machineCount: 1, recipeId: "iron_ingot" }], belts: [] })),
      settings: { theme: "dark", fontScale: 1, simulationSpeed: 1, autosaveIntervalSeconds: 0 },
    };
    localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
    localStorage.setItem("dsp-idle-network.slot.1", JSON.stringify({ savedAt: Date.now(), kind: "slot", slot: 1, state: { ...state, tray: { iron_ore: 88 } } }));
  });
  await page.route("**/api/**", (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"isolated factory epoch review"}' }));
  await page.goto("/");
  await expect(page.locator(".factory-canvas")).toBeVisible({ timeout: 60_000 });
  let panel = await openSaves(page);
  await expect(panel.getByLabel("载入槽位 1", { exact: true })).toBeEnabled();
  const envelope = await exportedEnvelope(page);
  envelope.state.tray.iron_ore = 99;
  envelope.state.blueprints = [];
  if (mode === "import") {
    const payload = JSON.stringify({ formatVersion: envelope.formatVersion, state: envelope.state });
    let hash = 0x811c9dc5;
    for (let index = 0; index < payload.length; index += 1) hash = Math.imul(hash ^ payload.charCodeAt(index), 0x01000193);
    envelope.checksum = (hash >>> 0).toString(16).padStart(8, "0");
  }
  await page.evaluate((reason) => {
    const nativePost = Worker.prototype.postMessage;
    const gate = { pending: false, released: false, automaticRelease: false, release: () => {} };
    Object.defineProperty(window, "__rescueEpochGate", { configurable: true, value: gate });
    Worker.prototype.postMessage = function (this: Worker, ...args) {
      const message = args[0];
      if (!gate.pending && message?.kind === "snapshot" && message.reason === reason) {
        gate.pending = true;
        let timer = 0;
        gate.release = () => { if (gate.released) return; gate.released = true; clearTimeout(timer); Worker.prototype.postMessage = nativePost; Reflect.apply(nativePost, this, args); };
        timer = window.setTimeout(() => { gate.automaticRelease = true; gate.release(); }, 60_000);
        return;
      }
      Reflect.apply(nativePost, this, args);
    };
  }, mode === "rescue" ? "救援外部存档前" : "导入外部存档前");
  await panel.getByLabel("选择要导入的存档文件", { exact: true }).setInputFiles({ name: "epoch-damaged.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(envelope)) });
  const preview = panel.getByRole("region", { name: "存档导入预览", exact: true });
  if (mode === "rescue") {
    await preview.getByRole("button", { name: "救援此存档", exact: true }).click();
    const backup = page.waitForEvent("download");
    await preview.getByRole("button", { name: "再次确认并救援", exact: true }).click();
    expect((await backup).suggestedFilename()).toContain("rescue-backup");
  } else await preview.getByRole("button", { name: "确认导入", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __rescueEpochGate: { pending: boolean } }).__rescueEpochGate.pending)).toBe(true);
  await panel.getByLabel("载入槽位 1", { exact: true }).click();
  const ore = page.locator('.tray-row[title="拿取铁矿石"] strong');
  await expect(ore).toHaveText("88", { timeout: 30_000 });
  panel = await openSaves(page);
  await page.evaluate(() => (window as unknown as { __rescueEpochGate: { release(): void } }).__rescueEpochGate.release());
  await expect.poll(() => page.evaluate(() => document.querySelector(".operations-saves")?.getAttribute("aria-busy") ?? "false"), { timeout: 60_000 }).toBe("false");
  await expect(panel.getByRole("region", { name: "存档导入预览", exact: true })).toHaveCount(0);
  const gate = await page.evaluate(() => { const value = (window as unknown as { __rescueEpochGate: { released: boolean; automaticRelease: boolean } }).__rescueEpochGate; return { released: value.released, automaticRelease: value.automaticRelease }; });
  await page.reload();
  await expect(page.locator(".factory-canvas")).toBeVisible({ timeout: 60_000 });
  await openSaves(page);
  const persisted = await exportedEnvelope(page);
  await testInfo.attach("rescue-after-slot-outcome", { body: JSON.stringify({ mode, ore: persisted.state.tray.iron_ore, blueprints: persisted.state.blueprints.length, autosave: persisted.state.settings.autosaveIntervalSeconds, gate, errors }), contentType: "application/json" });
  expect.soft(persisted.state.tray.iron_ore).toBe(88);
  expect.soft(persisted.state.blueprints).toHaveLength(12);
  expect(persisted.state.settings.autosaveIntervalSeconds).toBe(0);
  expect(gate.automaticRelease).toBe(false);
  panel = page.getByRole("dialog", { name: "运营中心", exact: true });
  await panel.getByLabel("选择要导入的存档文件", { exact: true }).setInputFiles({ name: "epoch-damaged.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(envelope)) });
  const retry = panel.getByRole("region", { name: "存档导入预览", exact: true });
  if (mode === "rescue") {
    await retry.getByRole("button", { name: "救援此存档", exact: true }).click();
    const retryBackup = page.waitForEvent("download");
    await retry.getByRole("button", { name: "再次确认并救援", exact: true }).click();
    expect((await retryBackup).suggestedFilename()).toContain("rescue-backup");
  } else await retry.getByRole("button", { name: "确认导入", exact: true }).click();
  await expect(ore).toHaveText("99", { timeout: 60_000 });
  panel = await openSaves(page);
  const retried = await exportedEnvelope(page);
  expect(retried.state.tray.iron_ore).toBe(99);
  expect(retried.state.blueprints).toHaveLength(0);
  expect(retried.state.settings.autosaveIntervalSeconds).toBe(0);
  await panel.getByLabel("载入槽位 1", { exact: true }).click();
  await expect(ore).toHaveText("88", { timeout: 60_000 });
  await openSaves(page);
  const restored = await exportedEnvelope(page);
  expect(restored.state.tray.iron_ore).toBe(88);
  expect(restored.state.blueprints).toHaveLength(12);
  expect(restored.state.research.completedTechIds).toEqual(["electromagnetism"]);
  expect(restored.state.settings.autosaveIntervalSeconds).toBe(0);
  await testInfo.attach("replacement-retry-outcome", { body: JSON.stringify({ mode, retryOre: retried.state.tray.iron_ore, restoredOre: restored.state.tray.iron_ore, restoredBlueprints: restored.state.blueprints.length, errors }), contentType: "application/json" });
  expect(errors).toEqual([]);
});
}
