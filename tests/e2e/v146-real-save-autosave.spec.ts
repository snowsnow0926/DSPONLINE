import { expect, test } from "@playwright/test";

// This is an opt-in local acceptance check. CI never receives a player save;
// callers supply a read-only fixture path through DSP_REAL_SAVE_FIXTURE.
const fixturePath = process.env.DSP_REAL_SAVE_FIXTURE;

test.describe("real save autosave acceptance", () => {
  test.skip(!fixturePath, "requires DSP_REAL_SAVE_FIXTURE");

  test("a running imported factory remains running after verified autosaves", async ({ page }) => {
    test.setTimeout(180_000);
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-20-v1.1.0");
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
    await expect(shell).toBeVisible({ timeout: 60_000 });
    await expect(shell).toHaveAttribute("data-runtime-recovery", "unavailable", { timeout: 60_000 });
    await expect(shell).toHaveAttribute("data-simulation-worker", "active", { timeout: 60_000 });

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
          bytes: serialization?.detail?.bytes ?? 0,
          longTaskCount: longTasks.length,
          maxLongTaskMs: Math.round(Math.max(0, ...longTasks.map((entry) => entry.durationMs))),
          longTasks: longTasks.map((entry) => {
            const eventIndex = events.indexOf(entry);
            const previous = events.slice(0, eventIndex).reverse().find((candidate) => candidate.phase !== "main-thread-longtask");
            const next = events.slice(eventIndex + 1).find((candidate) => candidate.phase !== "main-thread-longtask");
            return {
              offsetMs: Math.round(entry.startedAt - startedAt),
              durationMs: Math.round(entry.durationMs),
              previousPhase: previous?.phase ?? null,
              nextPhase: next?.phase ?? null,
            };
          }),
        };
      });
      const confirmedBoundarySources = events
        .filter((event) => event.phase === "autosave-confirmed-checkpoint")
        .map((event) => String(event.detail?.source ?? ""));
      const canvas = document.querySelector<HTMLElement>(".factory-canvas");
      const canvasDiagnostics = canvas ? {
        nodeDerivationMs: Number(canvas.dataset.nodeDerivationMs ?? 0),
        dynamicNodeCount: Number(canvas.dataset.dynamicNodeCount ?? 0),
        stableNodeCount: Number(canvas.dataset.stableNodeCount ?? 0),
        deferredNodeCount: Number(canvas.dataset.deferredNodeCount ?? 0),
        changedNodeCount: Number(canvas.dataset.changedNodeCount ?? 0),
        nodeDerivationCount: Number(canvas.dataset.nodeDerivationCount ?? 0),
        changedNodePublicationCount: Number(canvas.dataset.changedNodePublicationCount ?? 0),
        changedNodeTotal: Number(canvas.dataset.changedNodeTotal ?? 0),
        runtimeNodePublicationCount: Number(canvas.dataset.runtimeNodePublicationCount ?? 0),
      } : null;
      return { snapshots, serializationCount: serializations.length, confirmedBoundarySources, canvasDiagnostics };
    });
    console.log(`REAL_SAVE_AUTOSAVE_METRICS ${JSON.stringify(autosaveMetrics)}`);
    expect(autosaveMetrics.snapshots).toHaveLength(2);
    expect(autosaveMetrics.serializationCount).toBe(2);
    expect(autosaveMetrics.snapshots.every((entry) => entry.durationMs > 0 && entry.bytes > 0)).toBe(true);
    expect(autosaveMetrics.confirmedBoundarySources.length).toBeGreaterThanOrEqual(1);

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

    await expect.poll(() => page.evaluate(async () => {
      const storage = await import("/src/game/storage.ts");
      return storage.getSaveSnapshotSummaries().filter((entry) => entry.reason === "自动快照" && entry.valid).length;
    }), { timeout: 60_000 }).toBeGreaterThanOrEqual(1);

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
