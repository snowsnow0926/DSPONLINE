import { expect, test } from "@playwright/test";

// This is an opt-in local acceptance check. CI never receives a player save;
// callers supply a read-only fixture path through DSP_REAL_SAVE_FIXTURE.
const fixturePath = process.env.DSP_REAL_SAVE_FIXTURE;
const constrainedRendererHeap = process.env.DSP_E2E_RENDERER_HEAP_MB !== undefined;

test.describe("real save autosave acceptance", () => {
  test.skip(!fixturePath, "requires DSP_REAL_SAVE_FIXTURE");

  test("a running imported factory remains running after verified autosaves", async ({ page }) => {
    test.setTimeout(constrainedRendererHeap ? 420_000 : 240_000);
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-25-v1.1.8");
      localStorage.setItem("dsp-idle-network.onboarding.v1", "dismissed");
      // Exercise the player's configured 30-second interval rather than the
      // optional large-save cadence throttle. The handler is called by the
      // test below so two large serializations cannot overlap by accident.
      localStorage.setItem("dsp-idle-network.ui.large-save-autosave-throttle.v1", "false");
      (window as typeof window & { __DSP_RUNTIME_TRANSITIONS__?: unknown }).__DSP_RUNTIME_TRANSITIONS__ = {
        enabled: true,
        events: [],
        active: {},
        counters: {},
      };
      const tracker: { autosaveHandler: TimerHandler | null } = { autosaveHandler: null };
      Object.assign(window, { __dspRealSaveAutosaveTracker: tracker });
      const nativeSetInterval = window.setInterval.bind(window);
      window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
        if (timeout === 30_000) {
          tracker.autosaveHandler = handler;
          return 0 as unknown as ReturnType<typeof window.setInterval>;
        }
        return nativeSetInterval(handler, timeout, ...args);
      }) as typeof window.setInterval;
    });

    await page.goto("/?menu=1");
    await page.getByLabel("选择存档文件").setInputFiles(fixturePath!);
    await expect(page.getByRole("button", { name: "确认导入并进入" })).toBeEnabled({ timeout: 60_000 });
    await page.getByRole("button", { name: "确认导入并进入" }).click();
    const shell = page.locator(".game-shell");
    const offlineChoice = page.getByRole("dialog", { name: "选择离线结算方式" });
    const skipOffline = page.getByRole("button", { name: /保守跳过本次收益/ });
    const startupOutcome = await Promise.race([
      skipOffline.waitFor({ state: "visible", timeout: 90_000 }).then(() => "skip" as const),
      offlineChoice.waitFor({ state: "visible", timeout: 90_000 }).then(() => "choice" as const),
      shell.waitFor({ state: "visible", timeout: 90_000 }).then(() => "shell" as const),
    ]);
    if (startupOutcome === "choice") {
      await offlineChoice.getByRole("button", { name: /放弃离线收益/ }).click();
      await page.getByRole("alertdialog", { name: "快速结算需要玩家选择" })
        .getByRole("button", { name: "再次确认：收益为 0" }).click();
    } else if (startupOutcome === "skip") {
      await skipOffline.click();
      await page.getByRole("button", { name: /再次确认.*收益为 0/ }).click();
    }

    await expect(shell).toBeVisible({ timeout: 60_000 });
    await expect(shell).toHaveAttribute("data-runtime-recovery", "unavailable", { timeout: 60_000 });
    await expect(shell).toHaveAttribute("data-simulation-worker", "active", { timeout: 60_000 });
    const confirmSettlement = page.getByRole("button", { name: "确认结算" });
    if (await confirmSettlement.isVisible()) {
      await confirmSettlement.click();
      await expect(confirmSettlement).toBeHidden();
    }

    const importedShape = await page.evaluate(async () => {
      const [storage, localStore] = await Promise.all([
        import("/src/game/storage.ts"),
        import("/src/game/localSaveStore.ts"),
      ]);
      const raw = await localStore.readPersistedLocalSaveValue("dsp-idle-network.save.v1");
      const inspection = raw ? storage.inspectSave(raw) : null;
      return inspection?.state ? {
        valid: inspection.valid,
        mode: inspection.mode,
        entityCount: inspection.state.entities.length,
        beltCount: inspection.state.belts.length,
      } : null;
    });
    expect(importedShape).toEqual(expect.objectContaining({ valid: true, mode: "normal" }));

    const resume = page.getByLabel("继续模拟");
    if (await resume.isVisible()) await resume.click();
    await expect(shell).toHaveAttribute("data-simulation-paused", "false", { timeout: 30_000 });
    await page.evaluate(() => {
      const shell = document.querySelector(".game-shell");
      const stateChanges: string[] = [];
      if (shell) {
        new MutationObserver(() => {
          stateChanges.push(`${shell.getAttribute("data-simulation-paused")}:${shell.getAttribute("data-simulation-worker")}`);
        }).observe(shell, {
          attributes: true,
          attributeFilter: ["data-simulation-paused", "data-simulation-worker"],
        });
      }
      (window as typeof window & { __dspAutosaveStateChanges?: string[] }).__dspAutosaveStateChanges = stateChanges;
      const transitions = (window as typeof window & {
        __DSP_RUNTIME_TRANSITIONS__?: { events: unknown[] };
      }).__DSP_RUNTIME_TRANSITIONS__;
      if (transitions) transitions.events = [];
    });

    const runAutosave = async (expectedCompleted: number) => {
      await page.evaluate(() => {
        const tracker = (window as typeof window & {
          __dspRealSaveAutosaveTracker?: { autosaveHandler: TimerHandler | null };
        }).__dspRealSaveAutosaveTracker;
        if (!tracker || typeof tracker.autosaveHandler !== "function") throw new Error("autosave interval handler missing");
        tracker.autosaveHandler();
      });
      await expect.poll(() => page.evaluate(() => {
        const events = (window as typeof window & {
          __DSP_RUNTIME_TRANSITIONS__?: { events: Array<{ phase: string; detail?: { kind?: string; phase?: string } }> };
        }).__DSP_RUNTIME_TRANSITIONS__?.events ?? [];
        return events.filter((event) => event.phase === "persistence-phase" &&
          event.detail?.kind === "autosave" && event.detail.phase === "complete").length;
      }), { timeout: 60_000 }).toBeGreaterThanOrEqual(expectedCompleted);
      await expect(shell).toHaveAttribute("data-simulation-worker", "active", { timeout: 30_000 });
      await expect(shell).toHaveAttribute("data-simulation-paused", "false", { timeout: 30_000 });
    };

    await runAutosave(1);
    await runAutosave(2);

    // Freeze autosave evidence before the later manual write. Runtime events
    // are intentionally bounded and noisy isolated-API diagnostics can evict
    // older events while a 60+ MiB manual save is in progress.
    const autosaveMetrics = await page.evaluate(() => {
      const events = (window as typeof window & {
        __DSP_RUNTIME_TRANSITIONS__?: {
          events: Array<{
            phase: string;
            startedAt: number;
            durationMs: number;
            transition?: string;
            detail?: {
              kind?: string;
              phase?: string;
              serializeMs?: number;
              primaryWriteMs?: number;
              backupMs?: number;
              automaticSnapshotMs?: number;
              compressionMs?: number;
              transportBytes?: number;
              transportEncoding?: "raw" | "gzip";
              bytes?: number;
            };
          }>;
        };
      }).__DSP_RUNTIME_TRANSITIONS__?.events ?? [];
      const completed = events.filter((event) => event.phase === "save-complete" && event.transition === "autosave");
      const serializations = events.filter((event) => event.phase === "save-serialize-idb-readback" &&
        event.detail?.kind === "autosave");
      const snapshots = completed.map((event, index) => {
        // The persistence event records the save-function entry while the
        // transition starts a fraction of a millisecond later. Pair the two
        // ordered streams directly instead of relying on an inclusive time
        // window that can reject a valid event at the leading boundary.
        const serialization = serializations[index];
        const startedAt = event.startedAt;
        const endsAt = startedAt + event.durationMs;
        const longTasks = events.filter((candidate) => candidate.phase === "main-thread-longtask" &&
          candidate.startedAt >= startedAt && candidate.startedAt <= endsAt);
        return {
          durationMs: Math.round(event.durationMs),
          serializeMs: Math.round(serialization?.detail?.serializeMs ?? 0),
          primaryWriteMs: Math.round(serialization?.detail?.primaryWriteMs ?? 0),
          backupMs: Math.round(serialization?.detail?.backupMs ?? 0),
          automaticSnapshotMs: Math.round(serialization?.detail?.automaticSnapshotMs ?? 0),
          compressionMs: Math.round(serialization?.detail?.compressionMs ?? 0),
          transportBytes: serialization?.detail?.transportBytes ?? 0,
          transportEncoding: serialization?.detail?.transportEncoding ?? "raw",
          bytes: serialization?.detail?.bytes ?? 0,
          longTaskCount: longTasks.length,
          maxLongTaskMs: Math.round(Math.max(0, ...longTasks.map((entry) => entry.durationMs))),
        };
      });
      const confirmedBoundarySources = events
        .filter((event) => event.phase === "autosave-confirmed-checkpoint")
        .map((event) => String(event.detail?.source ?? ""));
      const transferOnlyCheckpointCount = events
        .filter((event) => event.phase === "save-transfer-only-checkpoint").length;
      return { snapshots, serializationCount: serializations.length, confirmedBoundarySources, transferOnlyCheckpointCount };
    });
    console.log(`REAL_SAVE_AUTOSAVE_METRICS ${JSON.stringify(autosaveMetrics)}`);
    expect(autosaveMetrics.snapshots).toHaveLength(2);
    expect(autosaveMetrics.serializationCount).toBe(2);
    // A sidecar autosave may legitimately be a no-op when no chunk changed;
    // in that case its committed byte count is zero. The initial seed must
    // still carry a positive payload, and every save must have a real duration.
    expect(autosaveMetrics.snapshots.every((entry) => entry.durationMs > 0 && entry.bytes >= 0)).toBe(true);
    expect(autosaveMetrics.snapshots[0]?.bytes ?? 0).toBeGreaterThan(0);
    const legacyCompressedAutosave = autosaveMetrics.snapshots.every((entry) => entry.transportEncoding === "gzip" &&
      entry.transportBytes > 0 && entry.transportBytes < entry.bytes / 10);
    // 1.1.8 seeds a v1 chunk journal on the first large autosave and writes
    // only changed chunks afterwards. Its sidecar result intentionally has
    // no full-envelope gzip timing; the second write must nevertheless be
    // materially smaller than the initial seed.
    const incrementalChunkAutosave = autosaveMetrics.snapshots.length >= 2 &&
      autosaveMetrics.snapshots.every((entry) => entry.transportEncoding === "raw" && entry.transportBytes === entry.bytes) &&
      autosaveMetrics.snapshots[1].bytes < autosaveMetrics.snapshots[0].bytes / 2;
    expect(legacyCompressedAutosave || incrementalChunkAutosave).toBe(true);
    expect(autosaveMetrics.confirmedBoundarySources).toEqual([]);
    expect(autosaveMetrics.transferOnlyCheckpointCount).toBeGreaterThanOrEqual(2);

    // The report is produced asynchronously after the shell becomes visible;
    // close it at the exact UI boundary where it would otherwise intercept the
    // manual-save command (rather than racing it during startup).
    const offlineReport = page.getByRole("dialog", { name: "离线结算报告" });
    if (await offlineReport.isVisible()) {
      await offlineReport.getByRole("button", { name: "确认结算" }).click();
      await expect(offlineReport).toBeHidden();
    }
    await page.getByLabel("打开设置").click();
    const operations = page.getByRole("dialog", { name: "运营中心" });
    await operations.locator(".operations-tabs").getByRole("tab", { name: "存档" }).click();
    const manualStartedAt = await page.evaluate(() => performance.now());
    await operations.getByRole("button", { name: "立即保存" }).click();
    await expect(shell).toHaveAttribute("data-persistence-kind", "manual", { timeout: 10_000 });
    await expect(shell).toHaveAttribute("data-persistence-phase", "complete", { timeout: 60_000 });
    await expect.poll(() => page.evaluate((startedAt) => {
      const events = (window as typeof window & {
        __DSP_RUNTIME_TRANSITIONS__?: { events: Array<{ phase: string; startedAt: number }> };
      }).__DSP_RUNTIME_TRANSITIONS__?.events ?? [];
      return events.filter((event) => event.phase === "save-transfer-only-checkpoint" &&
        event.startedAt >= startedAt).length;
    }, manualStartedAt), { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
    await operations.getByLabel("关闭运营中心").click();

    await expect.poll(() => page.evaluate(async () => {
      const [storage, localStore] = await Promise.all([
        import("/src/game/storage.ts"),
        import("/src/game/localSaveStore.ts"),
      ]);
      const raw = await localStore.readPersistedLocalSaveValue("dsp-idle-network.save.v1.backup");
      const inspection = raw ? storage.inspectSave(raw) : null;
      return inspection?.state ? {
        valid: inspection.valid,
        mode: inspection.mode,
        entityCount: inspection.state.entities.length,
        beltCount: inspection.state.belts.length,
      } : null;
    }), { timeout: 60_000 }).toEqual(expect.objectContaining({
      valid: true,
      mode: importedShape!.mode,
      entityCount: importedShape!.entityCount,
      beltCount: importedShape!.beltCount,
    }));

    await expect(shell).toHaveAttribute("data-simulation-worker", "active", { timeout: 30_000 });
    await expect(shell).toHaveAttribute("data-simulation-paused", "false", { timeout: 30_000 });
    const noticeText = (await page.locator(".game-notice").allTextContents()).join(" ");
    expect(noticeText).not.toMatch(/durable recovery head|刷新后.*recovery/);
    const stateChanges = await page.evaluate(() =>
      (window as typeof window & { __dspAutosaveStateChanges?: string[] }).__dspAutosaveStateChanges ?? []);
    expect(stateChanges.filter((value) => value.startsWith("true:"))).toEqual([]);
    expect(stateChanges.filter((value) => value.endsWith(":fallback"))).toEqual([]);

    // Reload through the menu after the second verified write. The menu reads
    // the durable primary directly before it offers an offline settlement
    // choice, so this proves the persisted state without folding a separate
    // time-warp/offline calculation into the autosave contract.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("button", { name: /继续游戏/ })).toBeVisible({ timeout: 60_000 });
    const reloadedPrimary = await page.evaluate(async () => {
      const [storage, localStore] = await Promise.all([
        import("/src/game/storage.ts"),
        import("/src/game/localSaveStore.ts"),
      ]);
      const raw = await localStore.readPersistedLocalSaveValue("dsp-idle-network.save.v1");
      const inspection = raw ? storage.inspectSave(raw) : null;
      return inspection?.state ? {
        valid: inspection.valid,
        mode: inspection.mode,
        paused: inspection.state.paused,
        entityCount: inspection.state.entities.length,
        beltCount: inspection.state.belts.length,
      } : null;
    });
    expect(reloadedPrimary).toEqual(expect.objectContaining({
      valid: true,
      mode: importedShape!.mode,
      paused: false,
      entityCount: importedShape!.entityCount,
      beltCount: importedShape!.beltCount,
    }));
    expect(pageErrors).toEqual([]);
  });
});
