import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { expect, test, type ElectronApplication } from "@playwright/test";
import { boundary, continueExisting, enterNew, factoryContent, fixture, forceKill, importFixture, launch, normalClose, profile, records, runDirectory, saveTab, sha256 } from "./desktop-journey-helpers";

test.afterEach(async ({}, info) => {
  records.push({ event: "test-result", title: info.title, status: info.status });
  fs.writeFileSync(path.join(runDirectory, "process-and-save-events.json"), JSON.stringify(records, null, 2));
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
    await importFixture(independent.page, "roundtrip-reimport", exported);
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
      try { require("node:https").get("https://example.invalid/dsp-isolation-probe"); } catch (error) { blocked = (error as Error).message === "DSP_ISOLATED_NETWORK_BLOCKED"; }
      return { blocked, audit: (globalThis as any).__dspIsolatedNetworkAudit };
    });
    expect(result.blocked).toBe(true);
    expect(await page.evaluate(async () => { try { await fetch("https://example.invalid/dsp-isolation-probe"); return false; } catch { return true; } })).toBe(true);
    records.push({ event: "network-probes", result });
    await normalClose(app);
  } finally { await forceKill(app, "failure-cleanup"); }
});
