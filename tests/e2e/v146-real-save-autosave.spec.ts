import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const REAL_SAVE = process.env.DSP_V146_REAL_SAVE;
const EXPECTED_SHA256 = "f832f7fb909bad1981cd8476f28dcf0f1026c62955d822904218cee270a43d2a";
const SAVE_KEY = "dsp-idle-network.save.v1";

test.use({ trace: "off", screenshot: "off", video: "off" });

async function seedPrimary(page: Page, raw: string): Promise<void> {
  await page.goto("/?storageMigration=production");
  await page.evaluate(async ({ value, key }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("dsp-idle-network.local-saves", 2);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("records")) request.result.createObjectStore("records", { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction("records", "readwrite");
    transaction.objectStore("records").clear();
    transaction.objectStore("records").put({ key, value, bytes: new Blob([value]).size, updatedAt: Date.now() });
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
  }, { value: raw, key: SAVE_KEY });
}

test("real player save survives autosave, undo, and recovery-history boundaries", async ({ page }) => {
  test.setTimeout(180_000);
  test.skip(!REAL_SAVE, "Set DSP_V146_REAL_SAVE to run the read-only player-save acceptance test.");
  const sourceRaw = readFileSync(REAL_SAVE!, "utf8");
  expect(createHash("sha256").update(sourceRaw).digest("hex")).toBe(EXPECTED_SHA256);
  const envelope = JSON.parse(sourceRaw) as Record<string, unknown>;
  const raw = JSON.stringify({ ...envelope, savedAt: Date.now() });

  await page.addInitScript(() => {
    localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-17-v1.0.46");
    localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
    localStorage.setItem("dsp-idle-network.save.allow-edits-during-save.v1", "false");
    const tracker = { historyPatchCount: 0, nullHistoryPatchCount: 0, pausedPatchValues: [] as unknown[] };
    const timerControl = { accelerateAutosave: true };
    (window as typeof window & { __v146RealSaveTracker?: typeof tracker; __v146RealSaveTimerControl?: typeof timerControl }).__v146RealSaveTracker = tracker;
    (window as typeof window & { __v146RealSaveTimerControl?: typeof timerControl }).__v146RealSaveTimerControl = timerControl;
    const NativeWorker = window.Worker;
    const WrappedWorker = new Proxy(NativeWorker, {
      construct(target, args) {
        const worker = Reflect.construct(target, args) as Worker;
        if (!String(args[0]).includes("simulation.worker")) return worker;
        const nativePostMessage = worker.postMessage.bind(worker);
        worker.postMessage = ((message: Record<string, unknown>, transferOrOptions?: Transferable[] | StructuredSerializeOptions) => {
          const command = message.command as { topLevelChanges?: Array<{ path?: unknown[]; value?: unknown }> } | undefined;
          const historyChanges = command?.topLevelChanges?.filter((change) => change.path?.[0] === "productionHistory") ?? [];
          const tracker = (window as typeof window & { __v146RealSaveTracker?: { historyPatchCount: number; nullHistoryPatchCount: number; pausedPatchValues: unknown[] } }).__v146RealSaveTracker;
          if (tracker && historyChanges.length > 0) {
            tracker.historyPatchCount += historyChanges.length;
            tracker.nullHistoryPatchCount += historyChanges.filter((change) => change.value === null || change.value === undefined).length;
          }
          if (tracker) tracker.pausedPatchValues.push(...(command?.topLevelChanges ?? [])
            .filter((change) => change.path?.[0] === "paused").map((change) => change.value));
          if (transferOrOptions === undefined) nativePostMessage(message);
          else nativePostMessage(message, transferOrOptions);
        }) as typeof worker.postMessage;
        return worker;
      },
    });
    Object.defineProperty(window, "Worker", { configurable: true, writable: true, value: WrappedWorker });
    const nativeSetInterval = window.setInterval.bind(window);
    window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (timeout !== 30_000) return nativeSetInterval(handler, timeout, ...args);
      const callback = typeof handler === "function" ? handler : () => undefined;
      return nativeSetInterval(() => {
        if (timerControl.accelerateAutosave) callback(...args);
      }, 2_500);
    }) as typeof window.setInterval;
  });

  await seedPrimary(page, raw);
  await page.reload({ waitUntil: "domcontentloaded" });
  const continueGame = page.getByRole("button", { name: /继续游戏/ });
  await expect(continueGame).toBeVisible({ timeout: 30_000 });
  await continueGame.click();
  const shell = page.locator(".game-shell");
  await expect(shell).toBeVisible({ timeout: 120_000 });
  await expect(shell).toHaveAttribute("data-runtime-recovery", "active", { timeout: 30_000 });
  await expect(shell).toHaveAttribute("data-simulation-worker", "active", { timeout: 30_000 });
  if (await shell.getAttribute("data-simulation-paused") === "true") {
    await page.getByLabel("继续模拟").click();
  }
  await expect(shell).toHaveAttribute("data-simulation-paused", "false", { timeout: 30_000 });

  // Create one real undo entry before the accelerated autosave window.
  await page.getByLabel("打开设置").click();
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.locator(".operations-tabs").getByRole("tab", { name: "设置" }).click();
  await operations.getByRole("button", { name: "教程、版本与其他", exact: true }).first().click();
  await operations.getByRole("button", { name: "舒缓", exact: true }).click();
  await expect(shell).toHaveAttribute("data-difficulty", "relaxed");
  await operations.getByLabel("关闭运营中心").click();

  await expect(shell).toHaveAttribute("data-primary-save-edit-lock", "true", { timeout: 60_000 });
  await page.keyboard.press("Control+Z");
  await expect(shell).toHaveAttribute("data-primary-save-rejected-edits", "0");
  await expect(shell).toHaveAttribute("data-persistence-kind", "autosave", { timeout: 60_000 });
  await expect(shell).toHaveAttribute("data-persistence-phase", "complete", { timeout: 60_000 });
  await expect(shell).toHaveAttribute("data-simulation-paused", "false", { timeout: 30_000 });

  const runtimeProbe = await page.evaluate(async () => {
    const tracker = (window as typeof window & { __v146RealSaveTracker?: { historyPatchCount: number; nullHistoryPatchCount: number } }).__v146RealSaveTracker;
    const local = await import("/src/game/localSaveStore.ts");
    const persistence = await import("/src/game/simulationRuntimeRecoveryPersistenceClient.ts");
    await local.flushLocalSaveWrites();
    const rawPrimary = await local.readPersistedLocalSaveValue("dsp-idle-network.save.v1");
    const identity = local.getPrimaryLocalSaveRecoveryIdentity("normal");
    const writer = local.getLocalSaveWriterStatus();
    if (!identity || writer.role !== "primary") throw new Error("primary recovery identity missing");
    const read = await persistence.readSimulationRuntimeRecoveryInPersistenceWorker(identity, {
      ownerId: writer.writerId,
      fencingToken: writer.fencingToken,
    });
    const intents = [
      ...(read.recovery?.entries ?? []).flatMap((entry) => entry.kind === "atomic" ? [entry.intent] : []),
      ...(read.recovery?.pendingIntent ? [read.recovery.pendingIntent] : []),
    ];
    return {
      paused: rawPrimary ? JSON.parse(rawPrimary).state.paused : null,
      historyLength: rawPrimary ? JSON.parse(rawPrimary).state.productionHistory?.length ?? null : null,
      historyPatchCount: tracker?.historyPatchCount ?? -1,
      nullHistoryPatchCount: tracker?.nullHistoryPatchCount ?? -1,
      durableHistoryPatchCount: intents.reduce((count, intent) => count + (intent.command?.topLevelChanges ?? [])
        .filter((change) => change.path[0] === "productionHistory").length, 0),
      recoveryPending: read.proof?.pending ?? null,
    };
  });
  expect(runtimeProbe).toMatchObject({ paused: false, historyLength: 0, historyPatchCount: 0, nullHistoryPatchCount: 0, durableHistoryPatchCount: 0 });
  await page.evaluate(() => {
    const control = (window as typeof window & { __v146RealSaveTimerControl?: { accelerateAutosave: boolean } }).__v146RealSaveTimerControl;
    if (control) control.accelerateAutosave = false;
  });
  await expect.poll(async () => page.evaluate(async () => {
    const local = await import("/src/game/localSaveStore.ts");
    const persistence = await import("/src/game/simulationRuntimeRecoveryPersistenceClient.ts");
    const identity = local.getPrimaryLocalSaveRecoveryIdentity("normal");
    const writer = local.getLocalSaveWriterStatus();
    if (!identity || writer.role !== "primary") return null;
    const read = await persistence.readSimulationRuntimeRecoveryInPersistenceWorker(identity, {
      ownerId: writer.writerId,
      fencingToken: writer.fencingToken,
    });
    return read.proof?.pending ?? null;
  }), { timeout: 30_000 }).toBe(false);

  await page.keyboard.press("Control+K");
  const palette = page.getByRole("dialog", { name: "命令面板" });
  await expect(palette).toBeVisible();
  await palette.getByRole("combobox", { name: "搜索命令" }).fill("时间扭曲装置");
  const timeWarpCommand = palette.getByRole("option", { name: /定位：时间扭曲装置/ }).first();
  await expect(timeWarpCommand).toBeVisible({ timeout: 30_000 });
  await timeWarpCommand.click({ force: true });
  const inspector = page.locator(".inspector-panel");
  const setController = inspector.getByRole("button", { name: "设为主控" });
  if (await setController.isVisible()) await setController.click();
  const startPureIdle = inspector.getByRole("button", { name: "开始纯挂机" });
  await expect(startPureIdle).toBeVisible({ timeout: 30_000 });
  console.log("V146_REAL_SAVE_PAUSE_PATCHES", await page.evaluate(() =>
    (window as typeof window & { __v146RealSaveTracker?: { pausedPatchValues: unknown[] } }).__v146RealSaveTracker?.pausedPatchValues ?? []));
  await expect(shell).toHaveAttribute("data-simulation-paused", "false", { timeout: 30_000 });
  await startPureIdle.click();
  const idle = page.getByRole("dialog", { name: "纯挂机" });
  await expect(idle).toBeVisible({ timeout: 60_000 });
  expect(await page.evaluate(async () => (await import("/src/game/pureIdleRecovery.ts")).readPureIdleRecovery()
    .then((record) => record?.startedPaused ?? null))).toBe(false);
  await expect(idle).toContainText(/正常宏观结算中|保守宏观结算中/, { timeout: 60_000 });
  await idle.getByRole("button", { name: "停止并结算纯挂机" }).click();
  await expect(idle).toBeHidden({ timeout: 60_000 });
  await expect(shell).toHaveAttribute("data-persistence-kind", "pure-idle-stop", { timeout: 60_000 });
  await expect(shell).toHaveAttribute("data-persistence-phase", "complete", { timeout: 60_000 });
  await expect(shell).toHaveAttribute("data-simulation-worker", "active", { timeout: 30_000 });
  await expect(shell).toHaveAttribute("data-runtime-recovery", "active", { timeout: 30_000 });
  await expect(shell).toHaveAttribute("data-simulation-paused", "false", { timeout: 30_000 });
  expect(createHash("sha256").update(sourceRaw).digest("hex")).toBe(EXPECTED_SHA256);
});
