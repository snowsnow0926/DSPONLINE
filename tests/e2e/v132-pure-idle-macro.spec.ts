import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { expect, test } from "@playwright/test";
import { inspectSave, migrateGame } from "../../src/game/storage";

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

  test("classifies missing, live matching, and already-committed recovery journals", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const engine = await import("/src/game/engine.ts");
      const recovery = await import("/src/game/pureIdleRecovery.ts");
      const missing = await recovery.inspectPureIdleRecovery();
      const state = engine.createInitialState(20_260_806, false);
      const created = await recovery.createPureIdleRecovery(state, "stable", 1_000, "inspection-owner", 1_000);
      if (!created.ok) throw new Error(created.message);
      const live = await recovery.inspectPureIdleRecovery();
      const matches = live.status === "valid" && recovery.matchesPureIdleRecoveryCheckpoint(live.record, state);
      await recovery.recordPureIdleRecoveryTransition(created.record.sessionId, "inspection-owner", {
        stopReason: "save-finalized",
        phase: "finalizing",
        committed: true,
        committedAtMs: 1_100,
      }, 1_100);
      const committed = await recovery.inspectPureIdleRecovery();
      await recovery.clearPureIdleRecovery(created.record.sessionId, "inspection-owner");
      return { missing: missing.status, live: live.status, matches, committed: committed.status };
    });
    expect(result).toEqual({ missing: "missing", live: "valid", matches: true, committed: "committed" });
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

  test("keeps a legacy recovery checkpoint usable when telemetry contains JSON null", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const engine = await import("/src/game/engine.ts");
      const recovery = await import("/src/game/pureIdleRecovery.ts");
      const state = engine.createInitialState(20_260_809, false);
      const created = await recovery.createPureIdleRecovery(state, "stable", 1_000, "telemetry-owner", 1_000);
      if (!created.ok) throw new Error(created.message);
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("dsp-idle-network.pure-idle-recovery", 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction("records", "readwrite");
        const store = transaction.objectStore("records");
        const request = store.get("checkpoint");
        request.onsuccess = () => {
          const checkpoint = request.result;
          checkpoint.state.productionHistory = [null, {
            elapsedSeconds: 20,
            productionPerMinute: { iron_ingot: 30 },
            consumptionPerMinute: {},
            inventory: {},
          }];
          store.put(checkpoint);
        };
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      db.close();

      const read = await recovery.readPureIdleRecovery();
      const inspection = await recovery.inspectPureIdleRecovery();
      await recovery.clearPureIdleRecovery(created.record.sessionId, "telemetry-owner");
      return {
        historyLength: read?.state.productionHistory.length,
        historyElapsedSeconds: read?.state.productionHistory[0]?.elapsedSeconds,
        status: inspection.status,
      };
    });

    expect(result).toEqual({ historyLength: 1, historyElapsedSeconds: 20, status: "valid" });
  });

  test("commits a grace-limited macro candidate before settling the ordinary offline remainder", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const contentPacks = await import("/src/game/contentPacks.ts");
      const engine = await import("/src/game/engine.ts");
      const offline = await import("/src/game/offlineSimulation.ts");
      const storage = await import("/src/game/storage.ts");
      const macro = await import("/src/game/pureIdleMacroClient.ts");
      const state = engine.createInitialState(20_260_806, false);
      state.entities = [...state.entities, {
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
      state.entities = [...state.entities, {
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
      state.entities = [...state.entities, {
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
      state.entities = [...state.entities, {
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
      state.entities = [...state.entities, {
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

  test("30-day macro settlement of the configured real endgame save produces a canonical reloadable envelope", async ({ page }) => {
    test.skip(!fixturePath, "set DSP_PURE_IDLE_MACRO_FIXTURE to a read-only endgame save");
    test.setTimeout(300_000);
    const raw = readFileSync(fixturePath!, "utf8");
    const sourceHash = createHash("sha256").update(raw, "utf8").digest("hex");
    const sourceInspection = inspectSave(raw);
    const derivedState = migrateGame(sourceInspection.state);
    if (!derivedState) throw new Error("fixture migration failed");
    let derivedController = derivedState.entities.find((entity) => entity.buildingId === "time_warp_device");
    const syntheticControllerAdded = !derivedController?.id;
    if (syntheticControllerAdded) {
      derivedController = {
        id: "v115-read-only-derived-time-warp-controller",
        kind: "machine",
        planetId: derivedState.activePlanetId,
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
      };
      derivedState.entities.push(derivedController);
    }
    derivedState.paused = false;
    derivedState.speedrun = undefined;
    derivedState.timeWarp.controllerEntityId = derivedController!.id;
    derivedState.timeWarp.enabled = true;
    derivedState.timeWarp.pendingSimulationSeconds = 0;
    derivedState.timeWarp.pendingWallSeconds = 0;
    // This harness needs the normalized runtime object consumed by the macro
    // Worker, not the sparse persistent projection consumed by import/migrate.
    // Keeping migration in the Node runner avoids a second 70+ MiB migration
    // clone inside the renderer while preserving production-equivalent state.
    const derivedRaw = JSON.stringify({ state: derivedState });
    const derivedGzip = gzipSync(derivedRaw, { level: 6 });
    await page.route(fixtureRoute, (route) => route.fulfill({
      status: 200,
      contentType: "application/gzip",
      body: derivedGzip,
    }));
    page.on("console", (message) => {
      if (message.text().startsWith("PURE_IDLE_MACRO_PHASE ")) console.log(message.text());
    });
    const result = await page.evaluate(async ({ syntheticControllerAdded }) => {
      console.log("PURE_IDLE_MACRO_PHASE imports-start");
      const contentPacks = await import("/src/game/contentPacks.ts");
      const complexityModule = await import("/src/game/offlineComplexity.ts");
      const macro = await import("/src/game/pureIdleMacroClient.ts");
      console.log("PURE_IDLE_MACRO_PHASE fixture-fetch-start");
      const fixtureResponse = await fetch("/__dsp_pure_idle_macro_fixture.json");
      if (!fixtureResponse.body) throw new Error("pure-idle fixture response body missing");
      const parsed = await new Response(
        fixtureResponse.body.pipeThrough(new DecompressionStream("gzip")),
      ).json() as { state: Record<string, any> };
      const state = parsed.state;
      console.log("PURE_IDLE_MACRO_PHASE fixture-fetch-complete");
      // The authoritative fixture hash is checked in the Node test runner
      // before and after this browser operation. Avoid stableSerialize here:
      // on a 70+ MiB endgame state it creates another recursively-sorted full
      // string and measures the benchmark helper rather than pure-idle work.
      const sourceIdentity = JSON.stringify({
        elapsedSeconds: state.elapsedSeconds,
        entityCount: state.entities.length,
        beltCount: state.belts.length,
        firstEntity: state.entities[0]?.id,
        lastEntity: state.entities.at(-1)?.id,
        firstBelt: state.belts[0]?.id,
        lastBelt: state.belts.at(-1)?.id,
        uploadedWhiteMatrix: state.totalProduced?.universe_matrix,
      });
      const researchBefore = state.research.selectedTechId ?? state.endgame.activeInfiniteResearchId;
      const entities = state.entities.length;
      const belts = state.belts.length;
      const registry = contentPacks.createContentPackRuntimeSnapshot(contentPacks.createContentPackRegistry());
      const complexity = complexityModule.classifyOfflineWorkload(state as any, 30 * 24 * 60 * 60);
      const forceConservativeReason = complexity.recommendedStrategy === "conservative"
        ? complexity.warning ?? "终局存档内存占用超过精确校准边界"
        : undefined;
      const client = new macro.PureIdleMacroClient({
        onProgress: (progress) => console.log(`PURE_IDLE_MACRO_PHASE worker-${progress.operation}-${progress.phase}-${Math.round(progress.wallClockMs)}`),
      });
      const startedAt = performance.now();
      const initializeStartedAt = performance.now();
      console.log("PURE_IDLE_MACRO_PHASE initialize-start");
      await client.initialize(state, "extreme", registry, { forceConservativeReason });
      const initializeMs = performance.now() - initializeStartedAt;
      console.log(`PURE_IDLE_MACRO_PHASE initialize-complete-${Math.round(initializeMs)}`);
      const finalizeStartedAt = performance.now();
      console.log("PURE_IDLE_MACRO_PHASE finalize-start");
      const finalized = await client.finalizeEnvelope(30 * 24 * 60 * 60, { binaryTransport: "blob" });
      const finalizeRoundTripMs = performance.now() - finalizeStartedAt;
      console.log(`PURE_IDLE_MACRO_PHASE finalize-complete-${Math.round(finalizeRoundTripMs)}`);
      const durationMs = performance.now() - startedAt;
      client.close();
      const payload = finalized.finalEnvelope.payloadBytes;
      if (!(payload instanceof Blob)) throw new Error("pure-idle final envelope did not retain immutable Blob transport");
      const inspectionModuleUrl = new URL("/src/game/canonicalSaveEnvelopeInspection.ts", location.origin).href;
      const verifierSource = `self.onmessage = async (event) => {
        try {
          const inspection = await import(${JSON.stringify(inspectionModuleUrl)});
          const raw = await event.data.text();
          const result = inspection.inspectCanonicalSaveEnvelopeOrThrow(raw);
          self.postMessage({ ok: true, result: {
            formatVersion: result.formatVersion,
            mode: result.mode,
            entityCount: result.state.entityCount,
            beltCount: result.state.beltCount,
            elapsedSeconds: result.state.elapsedSeconds,
            checksum: result.computedChecksum,
          }});
        } catch (error) {
          self.postMessage({ ok: false, message: error instanceof Error ? error.message : 'verification failed' });
        }
      };`;
      const verifierUrl = URL.createObjectURL(new Blob([verifierSource], { type: "text/javascript" }));
      const verifier = new Worker(verifierUrl, { type: "module", name: "v115-pure-idle-envelope-verifier" });
      console.log("PURE_IDLE_MACRO_PHASE verify-start");
      const verification = await new Promise<Record<string, any>>((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error("pure-idle envelope verification timed out")), 60_000);
        verifier.onmessage = (event) => {
          window.clearTimeout(timeout);
          if (event.data?.ok) resolve(event.data.result);
          else reject(new Error(event.data?.message ?? "pure-idle envelope verification failed"));
        };
        verifier.onerror = () => {
          window.clearTimeout(timeout);
          reject(new Error("pure-idle envelope verifier crashed"));
        };
        verifier.postMessage(payload);
      }).finally(() => {
        verifier.terminate();
        URL.revokeObjectURL(verifierUrl);
      });
      console.log("PURE_IDLE_MACRO_PHASE verify-complete");
      return {
        durationMs,
        initializeMs,
        finalizeRoundTripMs,
        workerFinalizeDurationMs: finalized.durationMs,
        transferBytes: finalized.rawBytes,
        sourceUnchanged: sourceIdentity === JSON.stringify({
          elapsedSeconds: state.elapsedSeconds,
          entityCount: state.entities.length,
          beltCount: state.belts.length,
          firstEntity: state.entities[0]?.id,
          lastEntity: state.entities.at(-1)?.id,
          firstBelt: state.belts[0]?.id,
          lastBelt: state.belts.at(-1)?.id,
          uploadedWhiteMatrix: state.totalProduced?.universe_matrix,
        }),
        valid: verification.checksum === finalized.finalEnvelope.verification.stateChecksum,
        entityCountPreserved: verification.entityCount === entities && finalized.finalEnvelope.identity.entityCount === entities,
        beltCountPreserved: verification.beltCount === belts && finalized.finalEnvelope.identity.beltCount === belts,
        settledWallSeconds: finalized.summary.settledWallSeconds,
        algorithmVersion: finalized.summary.algorithmVersion,
        conservativeOnly: finalized.summary.conservativeOnly,
        complexityStrategy: complexity.recommendedStrategy,
        estimatedPeakBytes: complexity.estimatedPeakBytes,
        syntheticControllerAdded,
        degradedReason: finalized.summary.degradedReason,
        requestedMultiplier: finalized.summary.requestedMultiplier,
        powerLimitedMultiplier: finalized.summary.powerLimitedMultiplier,
        actualMultiplier: finalized.summary.actualMultiplier,
        researchBefore,
        researchAfter: finalized.summary.research.id,
        researchKind: finalized.summary.research.kind,
        baselineResearch: finalized.summary.baselineResearch,
        finalResearch: finalized.summary.research,
      };
    }, { syntheticControllerAdded });

    console.log(`PURE_IDLE_MACRO_REAL_SAVE ${JSON.stringify(result)}`);
    expect(createHash("sha256").update(readFileSync(fixturePath!, "utf8"), "utf8").digest("hex")).toBe(sourceHash);
    expect(result.sourceUnchanged).toBe(true);
    expect(result.valid).toBe(true);
    expect(result.entityCountPreserved).toBe(true);
    expect(result.beltCountPreserved).toBe(true);
    expect(result.settledWallSeconds).toBe(30 * 24 * 60 * 60);
    expect(result.algorithmVersion).toBe("pure-idle-macro-v3");
    expect(result.complexityStrategy).toBe("conservative");
    expect(result.requestedMultiplier).toBeGreaterThanOrEqual(1);
    expect(result.powerLimitedMultiplier).toBeGreaterThanOrEqual(1);
    expect(result.actualMultiplier).toBeGreaterThanOrEqual(1);
    if (result.researchBefore) {
      expect(result.researchKind).not.toBe("none");
      expect(result.researchAfter).toBeTruthy();
    }
    expect(result.durationMs).toBeLessThan(30_000);
  });
});
