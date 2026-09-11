import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const fixturePath = process.env.DSP_PURE_IDLE_MACRO_FIXTURE;
const fixtureRoute = "**/__dsp_pure_idle_macro_fixture.json";
const harnessPath = "/__dsp_pure_idle_macro_harness.html";

async function resetPureIdleRecoveryDatabase(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase("dsp-idle-network.pure-idle-recovery");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("could not clear pure-idle recovery database"));
    request.onblocked = () => reject(new Error("pure-idle recovery database remained blocked"));
  }));
}

test.describe("1.0.34 pure-idle macro recovery", () => {
  test.beforeEach(async ({ page }) => {
    await page.route(`**${harnessPath}`, (route) => route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: "<!doctype html><html><body><main>DSP pure idle macro harness</main></body></html>",
    }));
    await page.goto(harnessPath);
    await resetPureIdleRecoveryDatabase(page);
  });

  test("keeps a durable checkpoint, rejects a second owner, and restores the starting pause state", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const engine = await import("/src/game/engine.ts");
      const recovery = await import("/src/game/pureIdleRecovery.ts");
      const state = engine.createInitialState(20_260_806, false);
      const created = await recovery.createPureIdleRecovery(state, "stable", 900, "owner-a", 1_000, true);
      if (!created.ok) throw new Error(created.message);
      const competing = await recovery.claimPureIdleRecovery("owner-b", 1_001);
      const persisted = await recovery.readPureIdleRecovery();
      await recovery.releasePureIdleRecoveryLease(created.record.sessionId, "owner-a", 1_002);
      const reclaimed = await recovery.claimPureIdleRecovery("owner-b", 1_003);
      if (!reclaimed.ok) throw new Error(reclaimed.message);
      const cleared = await recovery.clearPureIdleRecovery(reclaimed.record.sessionId, "owner-b");
      return {
        competing,
        startedPaused: persisted?.startedPaused,
        restoredOwner: reclaimed.record.ownerToken,
        cleared,
        remaining: await recovery.readPureIdleRecovery(),
      };
    });

    expect(result.competing).toMatchObject({ ok: false, reason: "owned" });
    expect(result.startedPaused).toBe(true);
    expect(result.restoredOwner).toBe("owner-b");
    expect(result.cleared).toBe(true);
    expect(result.remaining).toBeNull();
  });

  test("limits closed-page high-multiplier settlement to five minutes before ordinary offline time", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const engine = await import("/src/game/engine.ts");
      const recovery = await import("/src/game/pureIdleRecovery.ts");
      const startedAtMs = 1_000_000;
      const backgroundStartedAtMs = startedAtMs + 60_000;
      const created = await recovery.createPureIdleRecovery(
        engine.createInitialState(20_260_806, false),
        "stable",
        startedAtMs,
        "owner-a",
        startedAtMs,
      );
      if (!created.ok) throw new Error(created.message);
      await recovery.markPureIdleBackground(created.record.sessionId, "owner-a", backgroundStartedAtMs);
      const persisted = await recovery.readPureIdleRecovery();
      if (!persisted) throw new Error("background marker was not persisted");
      const plan = recovery.getPureIdleBackgroundPlan(
        persisted,
        backgroundStartedAtMs + (recovery.PURE_IDLE_BACKGROUND_GRACE_SECONDS + 600) * 1_000,
      );
      await recovery.clearPureIdleRecovery(created.record.sessionId, "owner-a");
      return plan;
    });

    expect(result.highWallSeconds).toBe(60 + 5 * 60);
    expect(result.normalOfflineSeconds).toBe(600);
    expect(result.graceExpired).toBe(true);
  });

  test("migrates a v1 recovery log and keeps a frozen settlement boundary across a new owner", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const engine = await import("/src/game/engine.ts");
      const recovery = await import("/src/game/pureIdleRecovery.ts");
      const created = await recovery.createPureIdleRecovery(
        engine.createInitialState(20_260_808, false),
        "stable",
        1_000,
        "owner-v1",
        1_000,
      );
      if (!created.ok) throw new Error(created.message);
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("dsp-idle-network.pure-idle-recovery", 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction("records", "readwrite");
        const store = transaction.objectStore("records");
        for (const key of ["checkpoint", "heartbeat"]) {
          const request = store.get(key);
          request.onsuccess = () => {
            const legacy = { ...request.result, schemaVersion: 1 };
            delete legacy.settlementId;
            delete legacy.checkpointHash;
            delete legacy.stopReason;
            delete legacy.targetWallSeconds;
            delete legacy.committed;
            delete legacy.lastTransitionAtMs;
            store.put(legacy);
          };
        }
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      db.close();

      const legacyRead = await recovery.readPureIdleRecovery();
      await recovery.recordPureIdleRecoveryTransition(created.record.sessionId, "owner-v1", {
        stopReason: "user-stop-requested",
        phase: "finalizing",
        stopRequestedAtMs: 1_100,
        targetWallSeconds: 321,
      }, 1_100);
      await recovery.releasePureIdleRecoveryLease(created.record.sessionId, "owner-v1", 1_101);
      const claimed = await recovery.claimPureIdleRecovery("owner-v2", 1_102);
      if (!claimed.ok) throw new Error(claimed.message);
      await recovery.clearPureIdleRecovery(claimed.record.sessionId, "owner-v2");
      return {
        legacySettlementId: legacyRead?.settlementId,
        legacyCheckpointHash: legacyRead?.checkpointHash,
        claimedSettlementId: claimed.record.settlementId,
        claimedCheckpointHash: claimed.record.checkpointHash,
        stopReason: claimed.record.stopReason,
        phase: claimed.record.phase,
        targetWallSeconds: claimed.record.targetWallSeconds,
        committed: claimed.record.committed,
      };
    });

    expect(result.legacySettlementId).toMatch(/^idle_/);
    expect(result.legacyCheckpointHash).toMatch(/^checkpoint-[0-9a-f]{8}$/);
    expect(result.claimedSettlementId).toBe(result.legacySettlementId);
    expect(result.claimedCheckpointHash).toBe(result.legacyCheckpointHash);
    expect(result).toMatchObject({
      stopReason: "user-stop-requested",
      phase: "finalizing",
      targetWallSeconds: 321,
      committed: false,
    });
  });

  test("commits a grace-limited macro candidate before settling the ordinary offline remainder", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const contentPacks = await import("/src/game/contentPacks.ts");
      const engine = await import("/src/game/engine.ts");
      const offline = await import("/src/game/offlineSimulation.ts");
      const storage = await import("/src/game/storage.ts");
      const macro = await import("/src/game/pureIdleMacroClient.ts");
      const state = engine.createInitialState(20_260_806, false);
      state.entities = [{
        id: "macro-controller",
        kind: "machine",
        planetId: "home",
        position: { x: 0, y: 0 },
        interactionLocked: false,
        buildingId: "time_warp_device",
        machineCount: 1,
        minerCount: 0,
        inputs: {},
        outputs: {},
        progress: 0,
        routingCursor: 0,
        utilization: 0,
        productionRate: 0,
      }];
      state.belts = [];
      state.paused = false;
      state.timeWarp = { ...state.timeWarp, controllerEntityId: "macro-controller", enabled: true };
      const registry = contentPacks.createContentPackRuntimeSnapshot(contentPacks.createContentPackRegistry());
      const client = new macro.PureIdleMacroClient();
      await client.initialize(state, "stable", registry);
      const grace = await client.finalize(5 * 60);
      client.close();
      const ordinary = await offline.runOfflineSimulationInWorkerDetailed(grace.state, 600);
      if (ordinary.status !== "complete") throw new Error("exact ordinary remainder unexpectedly requested a decision");
      const inspection = storage.inspectSave(storage.serializeEnvelope(ordinary.state));
      return {
        highWallSeconds: grace.summary.settledWallSeconds,
        timeWarpEnabled: ordinary.state.timeWarp.enabled,
        valid: inspection.valid,
      };
    });

    expect(result.highWallSeconds).toBe(5 * 60);
    expect(result.timeWarpEnabled).toBe(false);
    expect(result.valid).toBe(true);
  });

  test("rebuilds a killed macro Worker from its unchanged checkpoint and finalizes a valid save", async ({ page }) => {
    test.setTimeout(90_000);
    const result = await page.evaluate(async () => {
      const benchmark = await import("/src/game/benchmark.ts");
      const contentPacks = await import("/src/game/contentPacks.ts");
      const engine = await import("/src/game/engine.ts");
      const storage = await import("/src/game/storage.ts");
      const macro = await import("/src/game/pureIdleMacroClient.ts");
      let state = engine.createInitialState(20_260_806, false);
      state.entities = [{
        id: "macro-controller",
        kind: "machine",
        planetId: "home",
        position: { x: 0, y: 0 },
        interactionLocked: false,
        buildingId: "time_warp_device",
        machineCount: 1,
        minerCount: 0,
        inputs: {},
        outputs: {},
        progress: 0,
        routingCursor: 0,
        utilization: 0,
        productionRate: 0,
      }];
      state.belts = [];
      state.paused = false;
      state.timeWarp = {
        ...state.timeWarp,
        controllerEntityId: "macro-controller",
        enabled: true,
        pendingSimulationSeconds: 0,
        pendingWallSeconds: 0,
      };
      const sourceHash = benchmark.hashGameState(state);
      const registry = contentPacks.createContentPackRuntimeSnapshot(contentPacks.createContentPackRegistry());
      const first = new macro.PureIdleMacroClient();
      await first.initialize(state, "stable", registry);
      await first.advance(30);
      first.close();

      const recovery = new macro.PureIdleMacroClient();
      const startedAt = performance.now();
      await recovery.initialize(state, "stable", registry);
      const finalized = await recovery.finalize(24 * 60 * 60);
      const durationMs = performance.now() - startedAt;
      recovery.close();
      const raw = storage.serializeEnvelope(finalized.state);
      const inspection = storage.inspectSave(raw);
      return {
        durationMs,
        sourceHash,
        sourceHashAfter: benchmark.hashGameState(state),
        finalizedEnabled: finalized.state.timeWarp.enabled,
        valid: inspection.valid,
        settledWallSeconds: finalized.summary.settledWallSeconds,
      };
    });

    expect(result.sourceHashAfter).toBe(result.sourceHash);
    expect(result.finalizedEnabled).toBe(false);
    expect(result.valid).toBe(true);
    expect(result.settledWallSeconds).toBe(24 * 60 * 60);
    expect(result.durationMs).toBeLessThan(30_000);
  });

  test("migrates a pure-idle-macro-v2 recovery summary with active research to v3", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const contentPacks = await import("/src/game/contentPacks.ts");
      const engine = await import("/src/game/engine.ts");
      const macro = await import("/src/game/pureIdleMacroClient.ts");
      const recovery = await import("/src/game/pureIdleRecovery.ts");
      const state = engine.createInitialState(20_260_807, false);
      state.research.selectedTechId = "electromagnetic_matrix";
      state.paused = false;
      state.entities = [{
        id: "macro-controller",
        kind: "machine",
        planetId: "home",
        position: { x: 0, y: 0 },
        interactionLocked: false,
        buildingId: "time_warp_device",
        machineCount: 1,
        minerCount: 0,
        inputs: {},
        outputs: {},
        progress: 0,
        routingCursor: 0,
        utilization: 0,
        productionRate: 0,
      }];
      state.belts = [];
      state.timeWarp = { ...state.timeWarp, controllerEntityId: "macro-controller", enabled: true };
      const created = await recovery.createPureIdleRecovery(state, "stable", 1_000, "owner-v2", 1_000);
      if (!created.ok) throw new Error(created.message);

      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("dsp-idle-network.pure-idle-recovery", 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction("records", "readwrite");
        const store = transaction.objectStore("records");
        const get = store.get("heartbeat");
        get.onsuccess = () => {
          store.put({
            ...get.result,
            phase: "failed",
            summary: {
              phase: "failed",
              mode: "stable",
              algorithmVersion: "pure-idle-macro-v2",
              settledWallSeconds: 30,
            },
          });
        };
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      db.close();
      await recovery.releasePureIdleRecoveryLease(created.record.sessionId, "owner-v2", 1_001);
      const claimed = await recovery.claimPureIdleRecovery("owner-v3", 1_002);
      if (!claimed.ok) throw new Error(claimed.message);
      const client = new macro.PureIdleMacroClient();
      const summary = await client.initialize(
        claimed.record.state,
        claimed.record.mode,
        contentPacks.createContentPackRuntimeSnapshot(contentPacks.createContentPackRegistry()),
      );
      client.close();
      await recovery.clearPureIdleRecovery(claimed.record.sessionId, "owner-v3");
      return {
        oldAlgorithm: claimed.record.summary?.algorithmVersion,
        newAlgorithm: summary.algorithmVersion,
        researchKind: summary.research.kind,
        researchId: summary.research.id,
      };
    });

    expect(result.oldAlgorithm).toBe("pure-idle-macro-v2");
    expect(result.newAlgorithm).toBe("pure-idle-macro-v3");
    expect(result).toMatchObject({ researchKind: "finite", researchId: "electromagnetic_matrix" });
  });

  test("cancels a blocked macro Worker within one second and leaves the source unchanged", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const benchmark = await import("/src/game/benchmark.ts");
      const contentPacks = await import("/src/game/contentPacks.ts");
      const engine = await import("/src/game/engine.ts");
      const macroModule = await import("/src/game/pureIdleMacroClient.ts");
      const NativeWorker = window.Worker;
      class BlockedMacroWorker extends NativeWorker {
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          if (options?.name === "pure-idle-macro") this.terminate();
        }
      }
      window.Worker = BlockedMacroWorker as typeof Worker;
      const state = engine.createInitialState(20_260_807, false);
      state.paused = false;
      state.entities = [{
        id: "macro-controller",
        kind: "machine",
        planetId: "home",
        position: { x: 0, y: 0 },
        interactionLocked: false,
        buildingId: "time_warp_device",
        machineCount: 1,
        minerCount: 0,
        inputs: {},
        outputs: {},
        progress: 0,
        routingCursor: 0,
        utilization: 0,
        productionRate: 0,
      }];
      state.belts = [];
      state.timeWarp = { ...state.timeWarp, controllerEntityId: "macro-controller", enabled: true };
      const sourceHash = benchmark.hashGameState(state);
      const client = new macroModule.PureIdleMacroClient({ operationDeadlineMs: 5_000 });
      const startedAt = performance.now();
      const pending = client.initialize(
        state,
        "stable",
        contentPacks.createContentPackRuntimeSnapshot(contentPacks.createContentPackRegistry()),
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
      client.cancel("test cancellation");
      let errorName = "";
      try {
        await pending;
      } catch (error) {
        errorName = error instanceof Error ? error.name : "unknown";
      } finally {
        window.Worker = NativeWorker;
      }
      return {
        durationMs: performance.now() - startedAt,
        errorName,
        sourceUnchanged: benchmark.hashGameState(state) === sourceHash,
      };
    });

    expect(result.errorName).toBe("AbortError");
    expect(result.durationMs).toBeLessThan(1_000);
    expect(result.sourceUnchanged).toBe(true);
  });

  test("returns an uncommitted decision when an ordinary fast contract needs the conservative Worker path", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const benchmark = await import("/src/game/benchmark.ts");
      const engine = await import("/src/game/engine.ts");
      const offline = await import("/src/game/offlineSimulation.ts");
      const state = engine.createInitialState(20_260_807, false);
      state.entities = [];
      state.belts = [];
      state.paused = false;
      state.timeWarp.pendingSimulationSeconds = 1;
      state.timeWarp.pendingWallSeconds = 1;
      const sourceHash = benchmark.hashGameState(state);
      const phases: string[] = [];
      const startedAt = performance.now();
      const settled = await offline.runOfflineSimulationInWorkerDetailed(state, 7 * 24 * 60 * 60, {
        approximate: true,
        deadlineMs: 5_000,
        onProgress: (progress) => phases.push(progress.phase),
      });
      return {
        durationMs: performance.now() - startedAt,
        resultStatus: settled.status,
        settlementStatus: settled.approximation?.settlementStatus,
        phases,
        sourceUnchanged: benchmark.hashGameState(state) === sourceHash,
      };
    });

    expect(result.resultStatus).toBe("decision-required");
    expect(result.settlementStatus).toBe("conservative-preview");
    expect(result.phases).toContain("conservative");
    expect(result.phases).not.toContain("bounded-exact");
    expect(result.sourceUnchanged).toBe(true);
    expect(result.durationMs).toBeLessThan(5_000);
  });

  test("terminates a hung fast Worker and performs only one bounded conservative restart", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const benchmark = await import("/src/game/benchmark.ts");
      const engine = await import("/src/game/engine.ts");
      const offline = await import("/src/game/offlineSimulation.ts");
      const NativeWorker = window.Worker;
      let offlineWorkerCount = 0;
      class FirstOfflineWorkerHangs extends NativeWorker {
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          if (options?.name === "offline-simulation" && ++offlineWorkerCount === 1) this.terminate();
        }
      }
      window.Worker = FirstOfflineWorkerHangs as typeof Worker;
      const state = engine.createInitialState(20_260_807, false);
      state.entities = [];
      state.belts = [];
      state.paused = false;
      const sourceHash = benchmark.hashGameState(state);
      const startedAt = performance.now();
      try {
        const settled = await offline.runOfflineSimulationInWorkerDetailed(state, 30 * 24 * 60 * 60, {
          approximate: true,
          deadlineMs: 4_000,
        });
        return {
          durationMs: performance.now() - startedAt,
          offlineWorkerCount,
          resultStatus: settled.status,
          settlementStatus: settled.approximation?.settlementStatus,
          sourceUnchanged: benchmark.hashGameState(state) === sourceHash,
        };
      } finally {
        window.Worker = NativeWorker;
      }
    });

    expect(result.offlineWorkerCount).toBe(2);
    expect(result.resultStatus).toBe("decision-required");
    expect(result.settlementStatus).toBe("conservative-preview");
    expect(result.sourceUnchanged).toBe(true);
    expect(result.durationMs).toBeLessThan(4_500);
  });

  test("handles worker.onerror with exactly one conservative restart", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const benchmark = await import("/src/game/benchmark.ts");
      const engine = await import("/src/game/engine.ts");
      const offline = await import("/src/game/offlineSimulation.ts");
      const NativeWorker = window.Worker;
      let offlineWorkerCount = 0;
      class FirstOfflineWorkerErrors extends NativeWorker {
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          if (options?.name !== "offline-simulation" || ++offlineWorkerCount !== 1) return;
          this.terminate();
          this.postMessage = ((message: { type?: string }) => {
            if (message.type !== "start") return;
            window.setTimeout(() => this.dispatchEvent(new ErrorEvent("error", {
              message: "injected offline Worker crash",
            })), 0);
          }) as typeof this.postMessage;
        }
      }
      window.Worker = FirstOfflineWorkerErrors as typeof Worker;
      const state = engine.createInitialState(20_260_807, false);
      state.entities = [];
      state.belts = [];
      state.paused = false;
      const sourceHash = benchmark.hashGameState(state);
      try {
        const settled = await offline.runOfflineSimulationInWorkerDetailed(state, 30 * 24 * 60 * 60, {
          approximate: true,
          deadlineMs: 5_000,
        });
        return {
          offlineWorkerCount,
          resultStatus: settled.status,
          settlementStatus: settled.approximation?.settlementStatus,
          sourceUnchanged: benchmark.hashGameState(state) === sourceHash,
        };
      } finally {
        window.Worker = NativeWorker;
      }
    });

    expect(result.offlineWorkerCount).toBe(2);
    expect(result.resultStatus).toBe("decision-required");
    expect(result.settlementStatus).toBe("conservative-preview");
    expect(result.sourceUnchanged).toBe(true);
  });

  test("ignores progress delivered by the retired Worker after conservative restart", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const engine = await import("/src/game/engine.ts");
      const offline = await import("/src/game/offlineSimulation.ts");
      const NativeWorker = window.Worker;
      let offlineWorkerCount = 0;
      class FirstOfflineWorkerReportsLate extends NativeWorker {
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          if (options?.name !== "offline-simulation" || ++offlineWorkerCount !== 1) return;
          this.terminate();
          this.postMessage = ((message: { type?: string; id?: number }) => {
            if (message.type !== "start" || typeof message.id !== "number") return;
            const retiredOnMessage = this.onmessage;
            window.setTimeout(() => this.dispatchEvent(new ErrorEvent("error", {
              message: "retire first offline Worker",
            })), 0);
            window.setTimeout(() => retiredOnMessage?.call(this, new MessageEvent("message", {
              data: {
                type: "progress",
                id: message.id,
                completedSeconds: 1,
                totalSeconds: 2,
                progress: 0.5,
                phase: "macro",
                wallClockMs: 1,
                algorithmVersion: "late-retired-worker",
              },
            })), 50);
          }) as typeof this.postMessage;
        }
      }
      window.Worker = FirstOfflineWorkerReportsLate as typeof Worker;
      const state = engine.createInitialState(20_260_807, false);
      state.entities = [];
      state.belts = [];
      state.paused = false;
      const algorithms: string[] = [];
      try {
        const settled = await offline.runOfflineSimulationInWorkerDetailed(state, 7 * 24 * 60 * 60, {
          approximate: true,
          deadlineMs: 5_000,
          onProgress: (progress) => algorithms.push(progress.algorithmVersion ?? "unknown"),
        });
        await new Promise((resolve) => window.setTimeout(resolve, 100));
        return {
          offlineWorkerCount,
          algorithms,
          resultStatus: settled.status,
          settlementStatus: settled.approximation?.settlementStatus,
        };
      } finally {
        window.Worker = NativeWorker;
      }
    });

    expect(result.offlineWorkerCount).toBe(2);
    expect(result.resultStatus).toBe("decision-required");
    expect(result.settlementStatus).toBe("conservative-preview");
    expect(result.algorithms).not.toContain("late-retired-worker");
  });

  test("retries a recoverable Worker error response exactly once", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const engine = await import("/src/game/engine.ts");
      const offline = await import("/src/game/offlineSimulation.ts");
      const NativeWorker = window.Worker;
      let offlineWorkerCount = 0;
      class FirstOfflineWorkerRespondsWithError extends NativeWorker {
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          if (options?.name !== "offline-simulation" || ++offlineWorkerCount !== 1) return;
          this.terminate();
          this.postMessage = ((message: { type?: string; id?: number }) => {
            if (message.type !== "start" || typeof message.id !== "number") return;
            window.setTimeout(() => this.dispatchEvent(new MessageEvent("message", {
              data: {
                type: "error",
                id: message.id,
                code: "worker-failure",
                message: "injected recoverable operation error",
              },
            })), 0);
          }) as typeof this.postMessage;
        }
      }
      window.Worker = FirstOfflineWorkerRespondsWithError as typeof Worker;
      const state = engine.createInitialState(20_260_807, false);
      state.entities = [];
      state.belts = [];
      state.paused = false;
      try {
        const settled = await offline.runOfflineSimulationInWorkerDetailed(state, 7 * 24 * 60 * 60, {
          approximate: true,
          deadlineMs: 5_000,
        });
        return {
          offlineWorkerCount,
          resultStatus: settled.status,
          settlementStatus: settled.approximation?.settlementStatus,
        };
      } finally {
        window.Worker = NativeWorker;
      }
    });

    expect(result.offlineWorkerCount).toBe(2);
    expect(result.resultStatus).toBe("decision-required");
    expect(result.settlementStatus).toBe("conservative-preview");
  });

  test("does not retry a Worker response that classifies the source as invalid", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const engine = await import("/src/game/engine.ts");
      const offline = await import("/src/game/offlineSimulation.ts");
      const NativeWorker = window.Worker;
      let offlineWorkerCount = 0;
      class InvalidSourceOfflineWorker extends NativeWorker {
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          if (options?.name !== "offline-simulation") return;
          offlineWorkerCount += 1;
          this.terminate();
          this.postMessage = ((message: { type?: string; id?: number }) => {
            if (message.type !== "start" || typeof message.id !== "number") return;
            window.setTimeout(() => this.dispatchEvent(new MessageEvent("message", {
              data: {
                type: "error",
                id: message.id,
                code: "invalid-source",
                message: "injected invalid source",
              },
            })), 0);
          }) as typeof this.postMessage;
        }
      }
      window.Worker = InvalidSourceOfflineWorker as typeof Worker;
      const state = engine.createInitialState(20_260_807, false);
      state.entities = [];
      state.belts = [];
      state.paused = false;
      let message = "";
      try {
        await offline.runOfflineSimulationInWorkerDetailed(state, 7 * 24 * 60 * 60, {
          approximate: true,
          deadlineMs: 5_000,
        });
      } catch (error) {
        message = error instanceof Error ? error.message : "unknown";
      } finally {
        window.Worker = NativeWorker;
      }
      return { offlineWorkerCount, message };
    });

    expect(result.offlineWorkerCount).toBe(1);
    expect(result.message).toContain("injected invalid source");
  });

  test("persists two Worker failures across reload and keeps every macro operation zero-calibration", async ({ page }) => {
    const created = await page.evaluate(async () => {
      const engine = await import("/src/game/engine.ts");
      const recovery = await import("/src/game/pureIdleRecovery.ts");
      const state = engine.createInitialState(20_260_807, false);
      state.entities = [{
        id: "macro-controller",
        kind: "machine",
        planetId: "home",
        position: { x: 0, y: 0 },
        interactionLocked: false,
        buildingId: "time_warp_device",
        machineCount: 1,
        minerCount: 0,
        inputs: {},
        outputs: {},
        progress: 0,
        routingCursor: 0,
        utilization: 0,
        productionRate: 0,
      }];
      state.belts = [];
      state.paused = false;
      state.timeWarp = { ...state.timeWarp, controllerEntityId: "macro-controller", enabled: true };
      const claim = await recovery.createPureIdleRecovery(state, "stable", 1_000, "failure-owner-a", 1_000);
      if (!claim.ok) throw new Error(claim.message);
      const first = await recovery.recordPureIdleWorkerFailure(claim.record.sessionId, "failure-owner-a", "first", 1_001);
      const second = await recovery.recordPureIdleWorkerFailure(claim.record.sessionId, "failure-owner-a", "second", 1_002);
      await recovery.releasePureIdleRecoveryLease(claim.record.sessionId, "failure-owner-a", 1_003);
      return { sessionId: claim.record.sessionId, first, second };
    });

    expect(created.first).toBe(1);
    expect(created.second).toBe(2);
    await page.reload();

    const restored = await page.evaluate(async () => {
      const contentPacks = await import("/src/game/contentPacks.ts");
      const macro = await import("/src/game/pureIdleMacroClient.ts");
      const recovery = await import("/src/game/pureIdleRecovery.ts");
      const storage = await import("/src/game/storage.ts");
      const claim = await recovery.claimPureIdleRecovery("failure-owner-b", 1_004);
      if (!claim.ok) throw new Error(claim.message);
      const forceConservativeReason = recovery.getPureIdleForceConservativeReason(claim.record);
      const client = new macro.PureIdleMacroClient();
      try {
        const initialized = await client.initialize(
          claim.record.state,
          claim.record.mode,
          contentPacks.createContentPackRuntimeSnapshot(contentPacks.createContentPackRegistry()),
          { forceConservativeReason },
        );
        const advanced = await client.advance(60);
        const finalized = await client.finalize(60);
        const valid = storage.inspectSave(storage.serializeEnvelope(finalized.state)).valid;
        await recovery.clearPureIdleRecovery(claim.record.sessionId, "failure-owner-b");
        return {
          persistedFailures: claim.record.workerRestartCount,
          forceConservativeReason,
          initialized,
          advanced,
          finalized: finalized.summary,
          valid,
        };
      } finally {
        client.close();
      }
    });

    expect(restored.persistedFailures).toBe(2);
    expect(restored.forceConservativeReason).toContain("连续 2 次 Worker 失败");
    expect(restored.initialized).toMatchObject({ conservativeOnly: true, calibrationWindowsCompleted: 0 });
    expect(restored.advanced).toMatchObject({ conservativeOnly: true, calibrationWindowsCompleted: 0 });
    expect(restored.finalized).toMatchObject({ conservativeOnly: true, calibrationWindowsCompleted: 0 });
    expect(restored.valid).toBe(true);
  });

  test("30-day macro settlement of the configured real endgame save remains reloadable", async ({ page }) => {
    test.skip(!fixturePath, "set DSP_PURE_IDLE_MACRO_FIXTURE to a read-only endgame save");
    test.setTimeout(120_000);
    const raw = readFileSync(fixturePath!, "utf8");
    await page.route(fixtureRoute, (route) => route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: raw,
    }));
    const result = await page.evaluate(async () => {
      const benchmark = await import("/src/game/benchmark.ts");
      const contentPacks = await import("/src/game/contentPacks.ts");
      const storage = await import("/src/game/storage.ts");
      const macro = await import("/src/game/pureIdleMacroClient.ts");
      const parsed = await fetch("/__dsp_pure_idle_macro_fixture.json").then((response) => response.json());
      const state = storage.migrateGame(parsed.state ?? parsed) as Record<string, any> | null;
      if (!state) throw new Error("fixture migration failed");
      const controller = state.entities.find((entity: Record<string, unknown>) => entity.buildingId === "time_warp_device");
      if (!controller?.id) throw new Error("fixture has no time-warp controller");
      state.paused = false;
      state.speedrun = undefined;
      state.timeWarp.controllerEntityId = controller.id;
      state.timeWarp.enabled = true;
      state.timeWarp.pendingSimulationSeconds = 0;
      state.timeWarp.pendingWallSeconds = 0;
      const sourceHash = benchmark.hashGameState(state);
      const researchBefore = state.research.selectedTechId ?? state.endgame.activeInfiniteResearchId;
      const criticalBefore = {
        whiteMatrix: state.totalProduced.universe_matrix ?? 0,
        structurePoints: state.dysonSphere.structurePoints,
        rockets: state.dysonSphere.totalRocketsLaunched,
        sails: state.dysonSphere.totalSailsAbsorbed,
        generationKw: state.dysonSphere.generationKw + state.dysonSwarm.generationKw,
      };
      const entities = state.entities.length;
      const belts = state.belts.length;
      const registry = contentPacks.createContentPackRuntimeSnapshot(contentPacks.createContentPackRegistry());
      const client = new macro.PureIdleMacroClient();
      const startedAt = performance.now();
      const initializeStartedAt = performance.now();
      await client.initialize(state, "extreme", registry);
      const initializeMs = performance.now() - initializeStartedAt;
      const finalizeStartedAt = performance.now();
      const finalized = await client.finalize(30 * 24 * 60 * 60);
      const finalizeRoundTripMs = performance.now() - finalizeStartedAt;
      const durationMs = performance.now() - startedAt;
      client.close();
      const raw = storage.serializeEnvelope(finalized.state);
      const inspection = storage.inspectSave(raw);
      const routesValid = finalized.state.entities.every((entity: Record<string, any>) =>
        (entity.stationRoutes ?? []).every((route: Record<string, unknown>) =>
          Number.isSafeInteger(route.cargo) && Number(route.cargo) >= 0 &&
          typeof route.progress === "number" && route.progress >= 0 && route.progress <= 1));
      return {
        durationMs,
        initializeMs,
        finalizeRoundTripMs,
        workerFinalizeDurationMs: finalized.durationMs,
        transferBytes: finalized.rawBytes,
        sourceUnchanged: benchmark.hashGameState(state) === sourceHash,
        valid: inspection.valid,
        routesValid,
        entityCountPreserved: finalized.state.entities.length === entities,
        beltCountPreserved: finalized.state.belts.length === belts,
        settledWallSeconds: finalized.summary.settledWallSeconds,
        algorithmVersion: finalized.summary.algorithmVersion,
        conservativeOnly: finalized.summary.conservativeOnly,
        degradedReason: finalized.summary.degradedReason,
        requestedMultiplier: finalized.summary.requestedMultiplier,
        powerLimitedMultiplier: finalized.summary.powerLimitedMultiplier,
        actualMultiplier: finalized.summary.actualMultiplier,
        researchBefore,
        researchAfter: finalized.summary.research.id,
        researchKind: finalized.summary.research.kind,
        baselineResearch: finalized.summary.baselineResearch,
        finalResearch: finalized.summary.research,
        criticalDelta: {
          whiteMatrix: finalized.state.totalProduced.universe_matrix - criticalBefore.whiteMatrix,
          structurePoints: finalized.state.dysonSphere.structurePoints - criticalBefore.structurePoints,
          rockets: finalized.state.dysonSphere.totalRocketsLaunched - criticalBefore.rockets,
          sails: finalized.state.dysonSphere.totalSailsAbsorbed - criticalBefore.sails,
          generationKw: finalized.state.dysonSphere.generationKw + finalized.state.dysonSwarm.generationKw - criticalBefore.generationKw,
        },
      };
    });

    console.log(`PURE_IDLE_MACRO_REAL_SAVE ${JSON.stringify(result)}`);
    expect(result.sourceUnchanged).toBe(true);
    expect(result.valid).toBe(true);
    expect(result.routesValid).toBe(true);
    expect(result.entityCountPreserved).toBe(true);
    expect(result.beltCountPreserved).toBe(true);
    expect(result.settledWallSeconds).toBe(30 * 24 * 60 * 60);
    expect(result.algorithmVersion).toBe("pure-idle-macro-v3");
    expect(result.requestedMultiplier).toBeGreaterThanOrEqual(1);
    expect(result.powerLimitedMultiplier).toBeGreaterThanOrEqual(1);
    expect(result.actualMultiplier).toBeGreaterThanOrEqual(1);
    expect(Object.values(result.criticalDelta).every((value) => Number.isFinite(value))).toBe(true);
    if (result.researchBefore) {
      expect(result.researchKind).not.toBe("none");
      expect(result.researchAfter).toBeTruthy();
    }
    expect(result.durationMs).toBeLessThan(30_000);
  });
});
