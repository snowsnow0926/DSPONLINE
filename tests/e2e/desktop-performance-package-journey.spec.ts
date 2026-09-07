import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { expect, test, type ElectronApplication } from "@playwright/test";
import { assertSaveReceipt, boundary, continueExisting, enterNew, factoryContent, fixture, forceKill, holdNextPersistenceCommit, importFixture, launch, normalClose, productionFixture, profile, records, runDirectory, saveAndVerify, saveTab, sha256 } from "./desktop-journey-helpers";
import { createInitialState } from "../../src/game/engine";
import { serializeEnvelope } from "../../src/game/storage";
import { inspectSaveEnvelopeChecksum } from "../../src/game/saveEnvelopeIntegrity";

test.afterEach(async ({}, info) => {
  records.push({ event: "test-result", title: info.title, status: info.status });
  fs.appendFileSync(path.join(runDirectory, "process-and-save-events.jsonl"), records.splice(0).map((record) => JSON.stringify(record)).join("\n") + "\n");
});

test("content and receipt oracles reject same-size corruption, new game, wrong replacement and save no-op", () => {
  expect(() => factoryContent(fixture.replace("12345", "12346"))).toThrow();
  expect(fixture.replace("12345", "12346").length).toBe(fixture.length);
  expect(() => expect(factoryContent(fixture)).toEqual(factoryContent(serializeEnvelope(createInitialState(), 1788739200000)))).toThrow();
  const wrong = inspectSaveEnvelopeChecksum(fixture).state! as any;
  wrong.tray.iron_ore++;
  expect(() => expect(factoryContent(fixture)).toEqual(factoryContent(serializeEnvelope(wrong, 1788739200000)))).toThrow();
  const receipt = { raw: fixture, revision: { revision: 3, checksum: inspectSaveEnvelopeChecksum(fixture).recordedChecksum } };
  expect(() => assertSaveReceipt(receipt, receipt)).toThrow();
});

test("close during a controlled in-flight save waits for the durable commit", async () => {
  const isolated = profile(); let app: ElectronApplication | undefined;
  try {
    const opened = await launch(isolated); app = opened.app;
    await enterNew(opened.page);
    const before = await importFixture(opened.page, "inflight-input");
    await holdNextPersistenceCommit(opened.page);
    const operations = await saveTab(opened.page);
    await operations.getByRole("button", { name: "立即保存", exact: true }).click();
    await expect.poll(() => opened.page.evaluate(() => (window as any).__dspHeldCommit.held)).toBe(1);
    expect(await boundary(opened.page)).toMatchObject({ raw: before.raw, revision: before.revision });
    await expect(opened.page.locator(".game-shell")).toHaveAttribute("data-primary-save-edit-lock", "true");
    const closing = normalClose(app);
    await expect(opened.page.locator("html")).toHaveAttribute("data-desktop-closing", "true");
    expect(await boundary(opened.page)).toMatchObject({ raw: before.raw, revision: before.revision });
    records.push({ event: "close-with-save-held", revision: before.revision });
    await opened.page.evaluate(() => (window as any).__dspHeldCommit.release());
    await closing; app = undefined;
    const reopened = await launch(isolated); app = reopened.app;
    await continueExisting(reopened.page);
    const recovered = await boundary(reopened.page);
    expect(recovered.revision.revision).toBeGreaterThan(before.revision.revision);
    expect(factoryContent(recovered.raw!)).toEqual(factoryContent(before.raw!));
    await normalClose(app); app = undefined;
  } finally { if (app) await forceKill(app, "failure-cleanup"); }
});

test("UI places power and smelter, connects ore and produces iron ingots", async () => {
  const { app, page } = await launch(profile());
  try {
    await enterNew(page);
    const initial = await importFixture(page, "production-input", productionFixture());
    await (await saveTab(page)).getByLabel("关闭运营中心").click();
    const canvas = page.locator(".react-flow__pane");
    await page.locator(".react-flow__controls-fitview").click();
    const box = (await canvas.boundingBox())!;
    await page.getByTitle("部署风力涡轮机", { exact: true }).click();
    await canvas.click({ position: { x: box.width * 0.65, y: box.height * 0.32 } });
    await page.keyboard.press("Escape");
    await expect(page.locator(".power-node")).toHaveCount(1);
    await page.getByTitle("部署电弧熔炉", { exact: true }).click();
    await canvas.click({ position: { x: box.width * 0.66, y: box.height * 0.6 } });
    await page.keyboard.press("Escape");
    await expect(page.locator(".machine-node")).toHaveCount(1);
    await page.locator(".react-flow__controls-fitview").click();
    const source = page.locator('.vein-node [data-handleid="out:iron_ore"]');
    const target = page.locator('.machine-node [data-handleid="in:iron_ore"]');
    await source.click(); await target.click();
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);
    const built = await saveAndVerify(page);
    const builtState = inspectSaveEnvelopeChecksum(built.raw!).state! as any;
    const initialState = inspectSaveEnvelopeChecksum(initial.raw!).state! as any;
    expect(builtState.construction.wind_turbine).toBe(initialState.construction.wind_turbine - 1);
    expect(builtState.construction.arc_smelter).toBe(initialState.construction.arc_smelter - 1);
    expect(builtState.construction.conveyor_belt_mk1).toBe(initialState.construction.conveyor_belt_mk1 - 1);
    await (await saveTab(page)).getByLabel("关闭运营中心").click();
    await page.getByLabel("继续模拟", { exact: true }).click();
    await expect(page.locator('.machine-node .node-slot[title="拿取铁块"]')).toBeEnabled({ timeout: 30000 });
    await page.getByLabel("暂停模拟", { exact: true }).click();
    const produced = inspectSaveEnvelopeChecksum((await saveAndVerify(page)).raw!).state! as any;
    const machine = produced.entities.find((entity: any) => entity.buildingId === "arc_smelter");
    const vein = produced.entities.find((entity: any) => entity.id === "vein_iron");
    expect(machine.outputs.iron_ingot).toBeGreaterThan(0);
    expect(vein.outputs.iron_ore).toBeLessThan(50);
    expect(produced.totalProduced.iron_ingot).toBeGreaterThan(builtState.totalProduced.iron_ingot ?? 0);
    records.push({ event: "ui-production", inputRemaining: vein.outputs.iron_ore, ironIngots: machine.outputs.iron_ingot, entities: produced.entities.length, belts: produced.belts.length });
    await page.screenshot({ path: path.join(runDirectory, "ui-production.png") });
    await normalClose(app);
  } finally { await forceKill(app, "failure-cleanup"); }
});

test("normal close immediately reopens the exact durable paused factory", async () => {
  const isolated = profile();
  let first: ElectronApplication | undefined;
  let second: ElectronApplication | undefined;
  try {
    const opened = await launch(isolated); first = opened.app;
    await enterNew(opened.page);
    const saved = await importFixture(opened.page, "normal-input");
    await normalClose(first); first = undefined;
    const reopened = await launch(isolated); second = reopened.app;
    await continueExisting(reopened.page);
    expect(factoryContent((await boundary(reopened.page)).raw!)).toEqual(factoryContent(saved.raw!));
    await reopened.page.screenshot({ path: path.join(runDirectory, "normal-immediate-reopen.png") });
    await normalClose(second); second = undefined;
  } finally { if (first) await forceKill(first, "failure-cleanup"); if (second) await forceKill(second, "failure-cleanup"); }
});

test("intentional crash retains the lease and restores the confirmed boundary", async () => {
  const isolated = profile();
  let app: ElectronApplication | undefined;
  try {
    const opened = await launch(isolated); app = opened.app;
    await enterNew(opened.page);
    const saved = await importFixture(opened.page, "crash-input");
    await forceKill(app); app = undefined;
    // The crash path retains the recorded lease. Normal close never waits.
    const delay = Math.max(0, saved.lease.expiresAt - Date.now() + 100);
    records.push({ event: "crash-lease-wait", milliseconds: delay, expiresAt: saved.lease.expiresAt });
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    const reopened = await launch(isolated); app = reopened.app;
    await continueExisting(reopened.page);
    expect(factoryContent((await boundary(reopened.page)).raw!)).toEqual(factoryContent(saved.raw!));
    await normalClose(app); app = undefined;
  } finally { if (app) await forceKill(app, "failure-cleanup"); }
});

test("compressed export validates checksum and imports into a separate profile", async () => {
  let first: ElectronApplication | undefined;
  let second: ElectronApplication | undefined;
  try {
    const opened = await launch(profile()); first = opened.app;
    await enterNew(opened.page);
    const saved = await importFixture(opened.page, "roundtrip-input");
    const exportPath = path.join(runDirectory, "roundtrip-export.json.gz");
    await first.evaluate(({ dialog, BrowserWindow }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
      dialog.showSaveDialogSync = () => filePath;
      BrowserWindow.getAllWindows()[0].webContents.session.once("will-download", (_event, item) => {
        item.setSavePath(filePath);
        item.once("done", (_doneEvent, state) => { (globalThis as any).__dspExportDone = state; });
      });
    }, exportPath);
    const operations = await saveTab(opened.page);
    await operations.getByRole("button", { name: "导出压缩存档", exact: true }).click();
    await expect.poll(async () => first!.evaluate(() => (globalThis as any).__dspExportDone), { timeout: 30000 }).toBe("completed");
    const exported = gunzipSync(fs.readFileSync(exportPath)).toString("utf8");
    expect(factoryContent(exported)).toEqual(factoryContent(saved.raw!));
    const independent = await launch(profile()); second = independent.app;
    await enterNew(independent.page);
    await importFixture(independent.page, "roundtrip-reimport", exported, exportPath);
    records.push({ event: "roundtrip", exportSha256: sha256(fs.readFileSync(exportPath)), inputSha256: sha256(fixture) });
    await normalClose(second); second = undefined;
    await normalClose(first); first = undefined;
  } finally { if (first) await forceKill(first, "failure-cleanup"); if (second) await forceKill(second, "failure-cleanup"); }
});

test("invalid import explicitly rejects and preserves full content and revision", async () => {
  const { app, page } = await launch(profile());
  try {
    await enterNew(page);
    await importFixture(page, "invalid-import-baseline");
    const before = await boundary(page);
    const operations = await saveTab(page);
    await operations.getByLabel("选择要导入的存档文件").setInputFiles({ name: "truncated.json", mimeType: "application/json", buffer: Buffer.from('{"formatVersion":2,"state":{') });
    await expect(operations).toContainText(/无法解析|无效|格式错误|校验失败|损坏|不是有效/, { timeout: 30000 });
    await expect(operations.getByRole("button", { name: "确认导入", exact: true })).toHaveCount(0);
    const after = await boundary(page);
    expect(after.raw).toBe(before.raw);
    expect(after.revision).toEqual(before.revision);
    await normalClose(app);
  } finally { await forceKill(app, "failure-cleanup"); }
});

test("main and renderer reject external probes in the isolated package", async () => {
  const { app, page } = await launch(profile());
  try {
    const result = await app.evaluate(() => {
      let blocked = false;
      try { (process as any).mainModule.require("node:https").get("https://example.invalid/dsp-isolation-probe"); } catch (error) { blocked = (error as Error).message === "DSP_ISOLATED_NETWORK_BLOCKED"; }
      return { blocked, audit: (globalThis as any).__dspIsolatedNetworkAudit };
    });
    expect(result.blocked).toBe(true);
    expect(await app.evaluate(async ({ net }) => { try { await net.fetch("https://example.invalid/dsp-isolation-probe"); return false; } catch { return true; } })).toBe(true);
    expect(await app.evaluate(() => (globalThis as any).__dspIsolatedNetworkAudit.chromiumBlocked)).toBeGreaterThan(0);
    expect(await page.evaluate(async () => { try { await fetch("https://example.invalid/dsp-isolation-probe"); return false; } catch { return true; } })).toBe(true);
    records.push({ event: "network-probes", result });
    await normalClose(app);
  } finally { await forceKill(app, "failure-cleanup"); }
});
