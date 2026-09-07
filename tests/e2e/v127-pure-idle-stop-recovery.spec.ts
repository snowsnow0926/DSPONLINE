import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { resolveDurableSimulationRuntimeEnabled } from "../../src/game/runtimePersistenceMode";

const durableMode = resolveDurableSimulationRuntimeEnabled(process.env);

type StopProbe = {
  claims: number;
  initializes: number;
  finalizes: number;
  targets: number[];
  failPrimaryWrites: boolean;
  failedWrites: number;
  primaryWrites: number;
  failJournalCommit: boolean;
  failedJournalCommits: number;
  backgroundRuns: number;
  holdValidatingJournal: boolean;
  validatingJournalBlocked: boolean;
  terminalChecksums: string[];
};

async function installProbe(page: Page): Promise<void> {
  await page.addInitScript((durable) => {
    sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-09-08-v1.2.7");
    localStorage.setItem("dsp-idle-network.onboarding.v1", "dismissed");
    localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
    const probe: StopProbe = {
      claims: 0, initializes: 0, finalizes: 0, targets: [],
      failPrimaryWrites: sessionStorage.getItem("v127-stop-fail-next-boot") === "1",
      failedWrites: 0, primaryWrites: 0, failJournalCommit: false, failedJournalCommits: 0,
      backgroundRuns: 0, holdValidatingJournal: false, validatingJournalBlocked: false, terminalChecksums: [],
    };
    sessionStorage.removeItem("v127-stop-fail-next-boot");
    Object.assign(window, { __stopRecoveryProbe: probe });
    const nativePut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      const record = value as { key?: string; value?: unknown; committed?: boolean } | null;
      if (this.transaction.db.name === "dsp-idle-network.pure-idle-recovery" &&
          record?.key === "heartbeat" && record.committed === true && probe.failJournalCommit) {
        probe.failedJournalCommits += 1;
        throw new DOMException("injected pure-idle committed-marker failure", "QuotaExceededError");
      }
      if (this.transaction.db.name === "dsp-idle-network.local-saves" &&
          record?.key === "dsp-idle-network.save.v1") {
        probe.primaryWrites += 1;
        if (typeof record.value === "string") {
          try {
            const envelope = JSON.parse(record.value);
            if (envelope.state?.timeWarp?.enabled === false && probe.finalizes > 0) {
              probe.terminalChecksums.push(envelope.checksum);
            }
          } catch { /* Only valid primary envelopes contribute an observation. */ }
        }
        if (probe.failPrimaryWrites && (!durable || probe.finalizes > 0)) {
          probe.failedWrites += 1;
          throw new DOMException("injected pure-idle primary write failure", "QuotaExceededError");
        }
      }
      return key === undefined ? nativePut.call(this, value) : nativePut.call(this, value, key);
    } as IDBObjectStore["put"];

    const NativeWorker = window.Worker;
    class ObservedWorker extends NativeWorker {
      private readonly workerName: string;

      constructor(scriptURL: string | URL, options?: WorkerOptions) {
        super(scriptURL, options);
        this.workerName = options?.name ?? "";
        if (this.workerName === "offline-simulation" || this.workerName === "background-offline-finalize") probe.backgroundRuns += 1;
      }

      override postMessage(message: unknown, transfer?: Transferable[]): void {
        const request = message as { id?: number; type?: string; targetWallSeconds?: number; key?: string; payload?: ArrayBuffer; proof?: { stateChecksum: string } } | null;
        if (this.workerName === "pure-idle-macro") {
          if (request?.type === "initialize") probe.initializes += 1;
          if (request?.type === "finalize") {
            probe.finalizes += 1;
            probe.targets.push(request.targetWallSeconds!);
          }
        }
        // The default coordinator writes through the page's IDB boundary above.
        // Explicit durable-mode runs use a separate persistence Worker; return
        // a failed commit without transferring away its immutable payload.
        if (this.workerName === "authoritative-save-persistence" &&
            request?.type === "commit" && request.key === "dsp-idle-network.save.v1" &&
            request.proof && probe.finalizes > 0) {
          probe.primaryWrites += 1;
          probe.terminalChecksums.push(request.proof.stateChecksum);
        }
        if (this.workerName === "authoritative-save-persistence" &&
            request?.type === "commit" && request.key === "dsp-idle-network.save.v1" &&
            probe.failPrimaryWrites && probe.finalizes > 0) {
          probe.failedWrites += 1;
          queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: {
            id: request.id, type: "error", message: "injected pure-idle primary write failure",
            ...(request.payload instanceof ArrayBuffer ? { sourcePayloadTransfer: request.payload } : {}),
          } })));
          return;
        }
        super.postMessage(message, transfer ?? []);
      }
    }
    Object.defineProperty(window, "Worker", { configurable: true, writable: true, value: ObservedWorker });
  }, durableMode);

  // Observe the real boot entry without mocking claim/readback or its result.
  await page.route("**/src/game/pureIdleRecovery.ts*", async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const signature = /(async\s+function\s+claimPureIdleRecovery\s*\([\s\S]*?\)\s*\{)/;
    if (!signature.test(source)) throw new Error("pure-idle claim observation boundary changed");
    let body = source.replace(signature, "$1\nif (globalThis.__stopRecoveryProbe) globalThis.__stopRecoveryProbe.claims += 1;\n");
    const transition = "async function recordPureIdleRecoveryTransition(";
    if (!body.includes(transition)) throw new Error("pure-idle transition observation boundary changed");
    body = body.replace(transition, "async function observedRecordPureIdleRecoveryTransition(");
    body += `\nexport async function recordPureIdleRecoveryTransition(...args) {
      const result = await observedRecordPureIdleRecoveryTransition(...args);
      const probe = globalThis.__stopRecoveryProbe;
      if (probe?.holdValidatingJournal && args[2]?.phase === 'validating') {
        probe.validatingJournalBlocked = true;
        await new Promise(resolve => { globalThis.__releaseStopJournal = resolve; });
      }
      return result;
    }\n`;
    await route.fulfill({ response, body });
  });
}

async function seedRecoverableRun(page: Page, startedPaused: boolean, expiredBackground = false, withOrdinaryReport = false): Promise<{ primary: string; inventory: unknown }> {
  await page.route("**/__v127_stop_seed.html", (route) => route.fulfill({
    contentType: "text/html; charset=utf-8", body: "<!doctype html><html><body>public synthetic stop recovery seed</body></html>",
  }));
  await page.goto("/__v127_stop_seed.html");
  return page.evaluate(async ({ pausedBeforeStart, background, ordinaryReport }) => {
    const engine = await import("/src/game/engine.ts");
    const storage = await import("/src/game/storage.ts");
    const local = await import("/src/game/localSaveStore.ts");
    const recovery = await import("/src/game/pureIdleRecovery.ts");
    const idle = await import("/src/game/idleSettlement.ts");
    if (background) {
      // This test targets persistence of an already-complete background
      // candidate, not the separate conservative-choice UI for an idle factory.
      (await import("/src/game/offlineApproximation.ts")).writeOfflineApproximationEnabled(false);
    }
    const state = engine.createInitialState(20_260_908, false);
    state.entities.push({
      id: "stop-recovery-warp", kind: "machine", planetId: "home", position: { x: 0, y: 0 },
      buildingId: "time_warp_device", machineCount: 1, minerCount: 0, inputs: {}, outputs: {},
      progress: 0, routingCursor: 0, utilization: 0, productionRate: 0, interactionLocked: false,
    });
    state.research.completedTechIds.push("universe_matrix", "time_warp_engineering");
    state.endgame.infiniteResearch.matrix_compression.level = 201;
    state.endgame.activeInfiniteResearchId = "matrix_compression";
    state.timeWarp.controllerEntityId = "stop-recovery-warp";
    state.timeWarp.enabled = true;
    state.timeWarp.requestedMultiplier = 16;
    state.timeWarp.pendingSimulationSeconds = 0;
    state.timeWarp.pendingWallSeconds = 0;
    // A running macro is unpaused; the journal separately remembers whether
    // ordinary simulation should return to paused after the verified stop.
    state.paused = false;
    state.settings.autosaveIntervalSeconds = 300;
    state.elapsedSeconds = 60;
    state.historyRecordedAt = 60;
    state.productionHistory = [0, 60].map((elapsedSeconds) => ({
      elapsedSeconds, sampleDurationSeconds: 1, productionPerMinute: {}, consumptionPerMinute: {},
      inventory: {}, generationKw: 0, demandKw: 0,
      pureIdleReplication: {
        researchInvestmentByItem: { universe_matrix: String(1_000 + elapsedSeconds * 2) },
        structurePointsBySystem: {}, shellSailsBySystem: {},
      },
    }));
    state.tray.iron_ingot = 123;
    state.planetTrays.home = { ...state.tray };
    const now = Date.now();
    const startedAt = now - (background ? 450_000 : 90_000);
    state.idleSettlement = idle.beginIdleRun(state.idleSettlement, startedAt);
    await local.initializeLocalSaveStore();
    const owner = recovery.getPureIdleOwnerToken();
    const created = await recovery.createPureIdleRecovery(state, "replication", startedAt, owner, now, pausedBeforeStart);
    if (!created.ok) throw new Error(created.message);
    if (background && !await recovery.markPureIdleBackground(created.record.sessionId, owner, now - 360_000)) {
      throw new Error("synthetic background boundary was not persisted");
    }
    const saved = ordinaryReport
      ? await storage.saveVerifiedPayload(storage.serializeEnvelope(state, now - 5_000), { mode: "normal" })
      : await storage.saveGameVerified(state);
    if (!saved.success) throw new Error(saved.message);
    const primary = await local.readPersistedLocalSaveValue("dsp-idle-network.save.v1");
    if (!primary) throw new Error("synthetic recovery primary was not committed");
    await recovery.releasePureIdleRecoveryLease(created.record.sessionId, owner);
    return { primary, inventory: JSON.parse(primary).state.tray };
  }, { pausedBeforeStart: startedPaused, background: expiredBackground, ordinaryReport: withOrdinaryReport });
}

async function readProbe(page: Page): Promise<StopProbe> {
  return page.evaluate(() => (window as typeof window & { __stopRecoveryProbe: StopProbe }).__stopRecoveryProbe);
}

async function armWriteFailure(page: Page, fail: boolean): Promise<void> {
  await page.evaluate((enabled) => {
    (window as typeof window & { __stopRecoveryProbe: StopProbe }).__stopRecoveryProbe.failPrimaryWrites = enabled;
  }, fail);
}

async function readRecovery(page: Page) {
  return page.evaluate(async () => {
    const record = await (await import("/src/game/pureIdleRecovery.ts")).readPureIdleRecovery();
    return record ? {
      sessionId: record.sessionId, committed: record.committed, targetWallSeconds: record.targetWallSeconds,
      stopReason: record.stopReason, stopRequestedAtMs: record.stopRequestedAtMs, startedAtMs: record.startedAtMs,
    } : null;
  });
}

async function readPrimary(page: Page) {
  return page.evaluate(async () => {
    const local = await import("/src/game/localSaveStore.ts");
    const raw = await local.readPersistedLocalSaveValue("dsp-idle-network.save.v1");
    if (!raw) throw new Error("primary is missing");
    const envelope = JSON.parse(raw);
    const state = envelope.state;
    return {
      raw, checksum: envelope.checksum, enabled: state.timeWarp.enabled, paused: state.paused,
      pending: state.timeWarp.pendingSimulationSeconds, pendingWall: state.timeWarp.pendingWallSeconds,
      currentRunStartedAt: state.idleSettlement.currentRunStartedAt,
      totalIdleTime: state.idleSettlement.totalIdleTime, inventory: state.tray,
    };
  });
}

async function continueDurableMenu(page: Page): Promise<void> {
  if (!durableMode) return;
  await expect(page.locator(".start-menu")).toBeVisible();
  await page.getByRole("button", { name: /继续游戏/ }).click();
  await expect(page.locator(".game-shell")).toHaveAttribute("data-runtime-recovery", "active", { timeout: 30_000 });
}

async function openLauncher(page: Page, seeded?: { primary: string }): Promise<void> {
  // A restored durable run needs the same verified recovery-head handshake as
  // a player entering through StartMenu. The direct development bypass does
  // not perform that handshake. Keep the accepted default path unchanged.
  await page.goto(durableMode ? "/?menu=1&storageMigration=production" : "/");
  await continueDurableMenu(page);
  if (durableMode && seeded) seeded.primary = (await readPrimary(page)).raw;
}

async function openRecovery(page: Page, seeded?: { primary: string }): Promise<void> {
  await openLauncher(page, seeded);
  const overlay = page.getByRole("dialog", { name: "纯挂机", exact: true });
  await expect(overlay).toBeVisible();
  await expect.poll(async () => (await readProbe(page)).initializes).toBe(1);
  await expect(overlay).toContainText("产率复制", { timeout: 30_000 });
  await expect(overlay.getByRole("button", { name: "停止并结算纯挂机", exact: true })).toBeVisible();
}

async function stopWithFailure(page: Page): Promise<void> {
  await armWriteFailure(page, true);
  const overlay = page.getByRole("dialog", { name: "纯挂机", exact: true });
  const retry = overlay.getByRole("button", { name: "重试恢复纯挂机", exact: true });
  if (await retry.isVisible()) await retry.click();
  else await overlay.getByRole("button", { name: "停止并结算纯挂机", exact: true }).click();
  await expect(page.locator(".game-shell")).toHaveAttribute("data-persistence-phase", "failed", { timeout: 30_000 });
  await expect(overlay).toBeVisible();
  await expect(retry).toBeEnabled();
}

for (const failures of [1, 2]) {
  test(`recovered pure idle retries ${failures} failed primary saves using one frozen terminal result`, async ({ page }) => {
    test.setTimeout(90_000);
    await installProbe(page);
    const seeded = await seedRecoverableRun(page, failures === 2);
    await openRecovery(page, seeded);
    const baseline = await readProbe(page);
    const bytesBefore = await page.locator(".game-shell").getAttribute("data-primary-save-bytes");
    let target: number | undefined;
    for (let index = 0; index < failures; index += 1) {
      await stopWithFailure(page);
      const record = await readRecovery(page);
      expect(record?.committed).toBe(false);
      expect(record?.stopReason).toBe("user-stop-requested");
      if (target === undefined) target = record!.targetWallSeconds;
      expect(record?.targetWallSeconds).toBe(target);
      expect((await readPrimary(page)).raw).toBe(seeded.primary);
      const failed = await readProbe(page);
      expect(failed.failedWrites).toBeGreaterThan(0);
      expect(failed.initializes).toBe(baseline.initializes);
      expect(failed.finalizes).toBe(1);
      expect(failed.claims).toBe(baseline.claims);
      await armWriteFailure(page, false);
    }
    await page.getByRole("button", { name: "重试恢复纯挂机", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "纯挂机", exact: true })).toBeHidden({ timeout: 30_000 });
    await expect.poll(() => readRecovery(page)).toBeNull();
    const persisted = await readPrimary(page);
    expect(persisted).toMatchObject({ enabled: false, paused: failures === 2, pending: 0, pendingWall: 0, currentRunStartedAt: null });
    expect(persisted.inventory).toEqual(seeded.inventory);
    expect(persisted.totalIdleTime).toBeCloseTo(target!, 6);
    await expect(page.locator(".game-shell")).not.toHaveAttribute("data-primary-save-bytes", bytesBefore!);
    // This crosses the save-size render that previously re-ran the boot effect.
    await expect.poll(async () => (await readProbe(page)).claims).toBe(baseline.claims);
    const final = await readProbe(page);
    expect(final.initializes).toBe(baseline.initializes);
    expect(final.finalizes).toBe(1);
    expect(final.targets).toEqual([target]);
    expect(final.terminalChecksums.length).toBeGreaterThan(0);
    expect(new Set(final.terminalChecksums)).toEqual(new Set([persisted.checksum]));
    await expect(page.getByText("上次停止结算未提交；原主存档保持不变，等待安全恢复", { exact: true })).toHaveCount(0);
  });
}

test("reload after a failed stop keeps the frozen journal recoverable and commits its time once", async ({ page }) => {
  test.setTimeout(90_000);
  await installProbe(page);
  const seeded = await seedRecoverableRun(page, true);
  await openRecovery(page, seeded);
  await stopWithFailure(page);
  const frozen = await readRecovery(page);
  expect(frozen?.targetWallSeconds).toBeGreaterThan(90);
  expect((await readPrimary(page)).raw).toBe(seeded.primary);
  await armWriteFailure(page, false);
  await page.reload();
  await continueDurableMenu(page);
  const overlay = page.getByRole("dialog", { name: "纯挂机", exact: true });
  await expect(overlay).toBeVisible();
  await expect(overlay.getByRole("button", { name: "重试恢复纯挂机", exact: true })).toBeVisible();
  expect(await readRecovery(page)).toEqual(frozen);
  await overlay.getByRole("button", { name: "重试恢复纯挂机", exact: true }).click();
  await expect(overlay).toBeHidden({ timeout: 30_000 });
  await expect.poll(() => readRecovery(page)).toBeNull();
  const primary = await readPrimary(page);
  expect(primary).toMatchObject({ enabled: false, paused: true, currentRunStartedAt: null });
  expect(primary.inventory).toEqual(seeded.inventory);
  expect(primary.totalIdleTime).toBeCloseTo(frozen!.targetWallSeconds!, 6);
  const resumed = await readProbe(page);
  expect(resumed.initializes).toBe(1);
  expect(resumed.finalizes).toBe(1);
  expect(resumed.targets).toEqual([frozen!.targetWallSeconds]);
  await page.reload();
  await continueDurableMenu(page);
  await expect(page.locator(".game-shell")).toBeVisible();
  await expect(page.getByRole("dialog", { name: "纯挂机", exact: true })).toHaveCount(0);
  expect(await readRecovery(page)).toBeNull();
  expect((await readPrimary(page)).totalIdleTime).toBe(primary.totalIdleTime);
});

test("a failed journal marker after primary commit only retries recovery closeout and blocks checkpoint rollback", async ({ page }) => {
  test.setTimeout(90_000);
  await installProbe(page);
  await seedRecoverableRun(page, true);
  await openRecovery(page);
  await page.evaluate(() => {
    (window as typeof window & { __stopRecoveryProbe: StopProbe }).__stopRecoveryProbe.failJournalCommit = true;
  });
  const overlay = page.getByRole("dialog", { name: "纯挂机", exact: true });
  await overlay.getByRole("button", { name: "停止并结算纯挂机", exact: true }).click();
  const retry = overlay.getByRole("button", { name: "重试恢复纯挂机", exact: true });
  await expect.poll(async () => (await readProbe(page)).failedJournalCommits).toBeGreaterThan(0);
  await expect(retry).toBeEnabled();
  const committed = await readPrimary(page);
  expect(committed.enabled).toBe(false);
  expect((await readRecovery(page))?.committed).toBe(false);
  const beforeRetry = await readProbe(page);
  await overlay.getByRole("button", { name: /放弃约 .* 未结算时间并继续普通模拟/ }).click();
  await expect(page.locator(".game-notice")).toContainText("不能回退到旧检查点");
  expect((await readPrimary(page)).raw).toBe(committed.raw);
  await page.evaluate(() => {
    (window as typeof window & { __stopRecoveryProbe: StopProbe }).__stopRecoveryProbe.failJournalCommit = false;
  });
  await retry.click();
  await expect(overlay).toBeHidden();
  await expect.poll(() => readRecovery(page)).toBeNull();
  const afterRetry = await readProbe(page);
  expect(afterRetry.initializes).toBe(beforeRetry.initializes);
  expect(afterRetry.finalizes).toBe(beforeRetry.finalizes);
  expect(afterRetry.primaryWrites).toBe(beforeRetry.primaryWrites);
  expect((await readPrimary(page)).raw).toBe(committed.raw);
});

test("background stop retries reuse the complete candidate and frozen ordinary-offline wall interval", async ({ page }) => {
  test.setTimeout(90_000);
  await installProbe(page);
  const seeded = await seedRecoverableRun(page, true, true);
  await page.evaluate(() => sessionStorage.setItem("v127-stop-fail-next-boot", "1"));
  await openLauncher(page, seeded);
  const overlay = page.getByRole("dialog", { name: "纯挂机", exact: true });
  await expect(overlay).toBeVisible();
  await expect.poll(async () => (await readProbe(page)).failedWrites, { timeout: 30_000 }).toBeGreaterThan(0);
  const retry = overlay.getByRole("button", { name: "重试恢复纯挂机", exact: true });
  await expect(retry).toBeEnabled();
  const frozen = await readRecovery(page);
  expect(frozen?.stopReason).toBe("background-grace-expired");
  const totalFrozenWall = (frozen!.stopRequestedAtMs! - frozen!.startedAtMs) / 1_000;
  expect(totalFrozenWall).toBeGreaterThan(frozen!.targetWallSeconds!);
  expect((await readPrimary(page)).raw).toBe(seeded.primary);
  const failed = await readProbe(page);
  expect(failed.finalizes).toBe(1);
  expect(failed.backgroundRuns).toBe(1);
  // Make the retry's live wall clock observably later than the frozen target.
  await page.waitForTimeout(1_100);
  await armWriteFailure(page, false);
  await retry.click();
  await expect(overlay).toBeHidden({ timeout: 30_000 });
  await expect.poll(() => readRecovery(page)).toBeNull();
  const result = await readPrimary(page);
  expect(result.totalIdleTime).toBeCloseTo(totalFrozenWall, 6);
  expect(result.inventory).toEqual(seeded.inventory);
  expect(result).toMatchObject({ enabled: false, paused: true, currentRunStartedAt: null });
  const completed = await readProbe(page);
  expect(completed.finalizes).toBe(failed.finalizes);
  expect(completed.initializes).toBe(failed.initializes);
  expect(completed.backgroundRuns).toBe(failed.backgroundRuns);
  expect(new Set(completed.terminalChecksums)).toEqual(new Set([result.checksum]));
});

test("explicitly abandoning a failed terminal candidate starts a new run with a fresh result", async ({ page }) => {
  test.setTimeout(90_000);
  await installProbe(page);
  const seeded = await seedRecoverableRun(page, true);
  await openRecovery(page, seeded);
  await stopWithFailure(page);
  const abandoned = await readRecovery(page);
  await armWriteFailure(page, false);
  const overlay = page.getByRole("dialog", { name: "纯挂机", exact: true });
  await overlay.getByRole("button", { name: /放弃约 .* 未结算时间并继续普通模拟/ }).click();
  await expect(overlay).toBeHidden();
  await expect.poll(() => readRecovery(page)).toBeNull();
  const checkpoint = await readPrimary(page);
  expect(checkpoint.totalIdleTime).toBe(0);
  expect(checkpoint.inventory).toEqual(seeded.inventory);
  const oldProbe = await readProbe(page);
  const node = page.locator(".react-flow__node").filter({ hasText: "时间扭曲装置" });
  await expect(node).toBeVisible();
  await node.locator(".factory-node__header").click();
  const start = page.locator(".inspector-panel").getByRole("button", { name: "开始产率复制挂机", exact: true });
  await expect(start).toBeEnabled();
  await start.click();
  await expect(overlay).toBeVisible();
  await expect.poll(async () => (await readProbe(page)).initializes).toBe(oldProbe.initializes + 1);
  const newRun = await readRecovery(page);
  expect(newRun?.sessionId).not.toBe(abandoned?.sessionId);
  await overlay.getByRole("button", { name: "停止并结算纯挂机", exact: true }).click();
  await expect(overlay).toBeHidden({ timeout: 30_000 });
  const completed = await readProbe(page);
  expect(completed.finalizes).toBe(oldProbe.finalizes + 1);
  expect(completed.targets.at(-1)).toBeLessThan(abandoned!.targetWallSeconds!);
  const primary = await readPrimary(page);
  expect(primary.totalIdleTime).toBeCloseTo(completed.targets.at(-1)!, 6);
  expect(primary.inventory).toEqual(seeded.inventory);
});

test("cancel while the finalized journal acknowledgement is pending never saves the cancelled candidate", async ({ page }) => {
  test.setTimeout(90_000);
  await installProbe(page);
  const seeded = await seedRecoverableRun(page, true);
  await openRecovery(page, seeded);
  const primaryWritesBeforeStop = (await readProbe(page)).primaryWrites;
  await page.evaluate(() => {
    (window as typeof window & { __stopRecoveryProbe: StopProbe }).__stopRecoveryProbe.holdValidatingJournal = true;
  });
  const overlay = page.getByRole("dialog", { name: "纯挂机", exact: true });
  await overlay.getByRole("button", { name: "停止并结算纯挂机", exact: true }).click();
  await expect.poll(async () => (await readProbe(page)).validatingJournalBlocked).toBe(true);
  expect((await readProbe(page)).finalizes).toBe(1);
  await overlay.getByRole("button", { name: "取消结算并保留原存档", exact: true }).click();
  await expect.poll(async () => (await readRecovery(page))?.stopReason).toBe("user-cancelled");
  await page.evaluate(() => {
    const runtime = window as typeof window & { __stopRecoveryProbe: StopProbe; __releaseStopJournal: () => void };
    runtime.__stopRecoveryProbe.holdValidatingJournal = false;
    runtime.__releaseStopJournal();
  });
  await expect(overlay.getByRole("button", { name: "取消结算并保留原存档", exact: true })).toHaveCount(0);
  expect((await readPrimary(page)).raw).toBe(seeded.primary);
  expect((await readRecovery(page))?.committed).toBe(false);
  expect((await readProbe(page)).primaryWrites).toBe(primaryWritesBeforeStop);
});

test("failed-stop recovery export downloads a diagnostic without mutating storage and fits both mobile orientations", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await installProbe(page);
  const seeded = await seedRecoverableRun(page, true);
  await openRecovery(page, seeded);
  await stopWithFailure(page);
  const journalBefore = await page.evaluate(async () =>
    (await import("/src/game/pureIdleRecovery.ts")).readPureIdleRecovery());
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "导出恢复数据", exact: true }).click(),
  ]);
  const journalAfter = await page.evaluate(async () =>
    (await import("/src/game/pureIdleRecovery.ts")).readPureIdleRecovery());
  expect(journalAfter).toEqual(journalBefore);
  expect((await readPrimary(page)).raw).toBe(seeded.primary);
  expect(download.suggestedFilename()).toMatch(/\.json\.gz$/);
  const output = testInfo.outputPath("public-synthetic-recovery.json.gz");
  await download.saveAs(output);
  const diagnostic = JSON.parse(gunzipSync(await readFile(output)).toString("utf8"));
  expect(diagnostic).toMatchObject({ format: "dsp-idle-recovery-diagnostic", schemaVersion: 1, settlementCompleted: false });
  expect(diagnostic.state).toBeUndefined();
  expect(diagnostic.originalSaveAndRuntimeRecovery.records.find((row: { key: string }) => row.key === "dsp-idle-network.save.v1").record.value).toBe(seeded.primary);
  expect(diagnostic.pureIdleRecovery.records.find((row: { key: string }) => row.key === "heartbeat").record.targetWallSeconds).toBe(journalBefore!.targetWallSeconds);
  expect(diagnostic.pureIdleRecovery.records.find((row: { key: string }) => row.key === "heartbeat").record.committed).toBe(false);
  for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    const exportPanel = page.getByRole("region", { name: "恢复数据导出", exact: true });
    await exportPanel.scrollIntoViewIfNeeded();
    await expect(exportPanel.getByRole("button", { name: "导出恢复数据", exact: true })).toBeVisible();
    expect(await page.evaluate(() => {
      const panel = document.querySelector(".recovery-data-export")!;
      const overlay = document.querySelector(".time-warp-idle-overlay")!;
      const rect = panel.getBoundingClientRect();
      return { panelOverflow: panel.scrollWidth > panel.clientWidth + 1, overlayOverflow: overlay.scrollWidth > overlay.clientWidth + 1,
        outsideViewport: rect.left < -1 || rect.right > innerWidth + 1 };
    })).toEqual({ panelOverflow: false, overlayOverflow: false, outsideViewport: false });
    await page.screenshot({ path: testInfo.outputPath(`public-recovery-export-${viewport.width}x${viewport.height}.png`) });
  }
});

test("legacy startup retains an ordinary offline report without hiding the active pure-idle controls", async ({ page }) => {
  test.setTimeout(90_000);
  test.skip(durableMode, "The durable menu delegates the journal interval directly; this case targets the default synchronous loader returning both dialogs.");
  await page.setViewportSize({ width: 390, height: 844 });
  await installProbe(page);
  await seedRecoverableRun(page, true, false, true);
  await openRecovery(page);
  const idle = page.getByRole("dialog", { name: "纯挂机", exact: true });
  const report = page.getByRole("dialog", { name: "离线结算报告", exact: true });
  await expect(page.locator(".offline-report")).toHaveCount(0);
  const stop = idle.getByRole("button", { name: "停止并结算纯挂机", exact: true });
  await expect(stop).toBeEnabled();
  expect(await stop.evaluate((button) => ({
    ariaHidden: button.closest('[aria-hidden="true"]') !== null,
    inert: button.closest("[inert]") !== null,
  }))).toEqual({ ariaHidden: false, inert: false });
  await stop.click();
  await expect(idle).toBeHidden({ timeout: 30_000 });
  await expect.poll(() => readRecovery(page)).toBeNull();
  await expect(report).toBeVisible();
  await expect(report).toContainText("原始离线时长");
  await expect(report).toContainText("精确结算");
  await report.getByRole("button", { name: "关闭离线结算报告", exact: true }).click();
  await expect(report).toHaveCount(0);
  const primary = await readPrimary(page);
  expect(primary).toMatchObject({ enabled: false, paused: true, currentRunStartedAt: null });
  expect((await readProbe(page)).finalizes).toBe(1);
});
