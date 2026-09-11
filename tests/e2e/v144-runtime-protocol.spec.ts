import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

const LARGE_SAVE_FIXTURE = process.env.DSP_V144_LARGE_SAVE;
const AUTHORITATIVE_LARGE_SAVE_SHA256 = "cd2356ea2b9a90a47cfa32ed9533e7056bfc4202f6af777fc4f3b98faa9a81b1";
// This file can receive the private 35 MiB acceptance fixture through a page
// argument. Never let Playwright copy that payload into diagnostics artifacts.
test.use({ trace: "off", screenshot: "off", video: "off" });

function outputFiles(root: string): Array<{ path: string; bytes: number }> {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = `${root}/${entry.name}`;
    return entry.isDirectory() ? outputFiles(path) : [{ path, bytes: statSync(path).size }];
  });
}

async function seedLargePrimarySave(page: Page, saveRaw: string): Promise<void> {
  await page.goto("/?storageMigration=production");
  const seeded = await page.evaluate(async (raw) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("dsp-idle-network.local-saves", 2);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("records")) request.result.createObjectStore("records", { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const write = database.transaction("records", "readwrite");
    write.objectStore("records").put({
      key: "dsp-idle-network.save.v1",
      value: raw,
      bytes: new Blob([raw]).size,
      updatedAt: Date.now(),
    });
    await new Promise<void>((resolve, reject) => {
      write.oncomplete = () => resolve();
      write.onabort = () => reject(write.error);
      write.onerror = () => reject(write.error);
    });
    const persisted = await new Promise<string | null>((resolve, reject) => {
      const request = database.transaction("records", "readonly").objectStore("records")
        .get("dsp-idle-network.save.v1") as IDBRequest<{ value?: unknown } | undefined>;
      request.onsuccess = () => resolve(typeof request.result?.value === "string" ? request.result.value : null);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return { exact: persisted === raw, bytes: persisted ? new Blob([persisted]).size : 0 };
  }, saveRaw);
  expect(seeded).toEqual({ exact: true, bytes: new Blob([saveRaw]).size });
}

test("authoritative Worker uses projection-only steady responses and exact ordered checkpoints", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const benchmark = await import("/src/game/benchmark.ts");
    const engine = await import("/src/game/engine.ts");
    const packs = await import("/src/game/contentPacks.ts");
    const projectionModule = await import("/src/game/simulationProjection.ts");
    const protocol = await import("/src/game/simulationRuntimeProtocol.ts");
    const registry = packs.createContentPackRuntimeSnapshot(packs.createContentPackRegistry());
    const source = engine.createInitialState(14_044);
    source.paused = false;
    source.entities[0].inputs.iron_ore = 20;
    source.research.completedTechIds.push("dyson_sphere_program");
    source.dysonSphere.structurePoints = 137;
    const canonicalSource = JSON.parse(JSON.stringify(source)) as typeof source;
    const oracle = engine.createPersistentSimulationRuntime(structuredClone(canonicalSource));
    const worker = new Worker(new URL("/src/game/simulation.worker.ts", location.origin), { type: "module" });
    const request = (payload: Record<string, unknown>, transfer: Transferable[] = []) => new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = payload.id as number;
      const timeout = window.setTimeout(() => reject(new Error(`runtime request ${id} timed out`)), 15_000);
      const listener = (event: MessageEvent<Record<string, unknown>>) => {
        if (event.data.id !== id) return;
        worker.removeEventListener("message", listener);
        window.clearTimeout(timeout);
        resolve(event.data);
      };
      worker.addEventListener("message", listener);
      worker.postMessage(payload, transfer);
    });

    const stateTransfer = protocol.serializeSimulationStateForTransfer(canonicalSource);
    const initialized = await request({
      id: 1,
      kind: "advance",
      stateTransfer,
      simulationSeconds: 0,
      wallSeconds: 0,
      registryFingerprint: registry.fingerprint,
      registry,
      protocol: "projection",
      stateRevision: 0,
    }, [stateTransfer.buffer]);

    engine.advancePersistentSimulationRuntime(oracle, 1, 1);
    const advanced = await request({
      id: 2,
      kind: "advance",
      simulationSeconds: 1,
      wallSeconds: 1,
      registryFingerprint: registry.fingerprint,
      protocol: "projection",
      stateRevision: initialized.stateRevision,
      profile: true,
      includeFactoryAlerts: true,
      factoryAlertsGeneration: 7,
    });
    const projection = advanced.projection as import("../../src/game/simulationProjection").SimulationProjection;
    const projected = projectionModule.applySimulationProjectionToState(canonicalSource, projection).state;
    const checkpointResponse = await request({
      id: 3,
      kind: "checkpoint",
      simulationSeconds: 0,
      wallSeconds: 0,
      registryFingerprint: registry.fingerprint,
      protocol: "projection",
      stateRevision: advanced.stateRevision,
    });
    const checkpointFromBytes = protocol.deserializeSimulationStateTransfer(
      checkpointResponse.checkpoint as import("../../src/game/simulationRuntimeProtocol").SimulationStateTransfer,
    );
    const checkpoint = protocol.validateSimulationStateCheckpoint(
      checkpointResponse.checkpoint as import("../../src/game/simulationRuntimeProtocol").SimulationStateTransfer,
      checkpointResponse.checkpointState,
    );

    const commandView = structuredClone(projected);
    commandView.entities[0].interactionLocked = true;
    commandView.settings.reducedMotion = !commandView.settings.reducedMotion;
    const command = protocol.createSimulationCommandPatch(projected, commandView, advanced.stateRevision as number)!;
    const commandCheckpointResponse = await request({
      id: 4,
      kind: "checkpoint",
      command,
      simulationSeconds: 0,
      wallSeconds: 0,
      registryFingerprint: registry.fingerprint,
      protocol: "projection",
      stateRevision: advanced.stateRevision,
    });
    const commandedCheckpoint = protocol.validateSimulationStateCheckpoint(
      commandCheckpointResponse.checkpoint as import("../../src/game/simulationRuntimeProtocol").SimulationStateTransfer,
      commandCheckpointResponse.checkpointState,
    );
    const dysonEdited = engine.addDysonLayer(commandedCheckpoint, "helios");
    const dysonCommand = protocol.createSimulationCommandPatch(
      commandedCheckpoint,
      dysonEdited,
      commandCheckpointResponse.stateRevision as number,
    )!;
    const dysonProjectionResponse = await request({
      id: 5,
      kind: "sync-projection",
      command: dysonCommand,
      simulationSeconds: 0,
      wallSeconds: 0,
      registryFingerprint: registry.fingerprint,
      protocol: "projection",
      stateRevision: commandCheckpointResponse.stateRevision,
      includeFactoryAlerts: false,
      factoryAlertsGeneration: 8,
    });
    const dysonProjection = dysonProjectionResponse.projection as import("../../src/game/simulationProjection").SimulationProjection;
    const dysonProjected = projectionModule.applySimulationProjectionToState(commandedCheckpoint, dysonProjection).state;
    const dysonCheckpointResponse = await request({
      id: 6,
      kind: "checkpoint",
      simulationSeconds: 0,
      wallSeconds: 0,
      registryFingerprint: registry.fingerprint,
      protocol: "projection",
      stateRevision: dysonProjectionResponse.stateRevision,
    });
    const dysonCheckpoint = protocol.validateSimulationStateCheckpoint(
      dysonCheckpointResponse.checkpoint as import("../../src/game/simulationRuntimeProtocol").SimulationStateTransfer,
      dysonCheckpointResponse.checkpointState,
    );
    const staleCommand = { ...dysonCommand, baseRevision: 0 };
    const rejected = await request({
      id: 7,
      kind: "advance",
      command: staleCommand,
      simulationSeconds: 1,
      wallSeconds: 1,
      registryFingerprint: registry.fingerprint,
      protocol: "projection",
      stateRevision: dysonCheckpointResponse.stateRevision,
    });
    const resyncCheckpoint = protocol.validateSimulationStateCheckpoint(
      rejected.checkpoint as import("../../src/game/simulationRuntimeProtocol").SimulationStateTransfer,
      rejected.checkpointState,
    );
    // Checkpoints use the persisted JSON contract, which intentionally drops
    // optional properties whose value is undefined (for example speedrun).
    const canonicalDysonEdited = JSON.parse(JSON.stringify(dysonEdited)) as typeof dysonEdited;
    const unexpectedDysonPatch = protocol.createSimulationCommandPatch(canonicalDysonEdited, dysonCheckpoint, 0);
    worker.terminate();

    const canonicalOracle = JSON.parse(JSON.stringify(oracle.state)) as typeof oracle.state;
    return {
      initializedHasState: "state" in initialized,
      steadyHasState: "state" in advanced,
      steadyHasDelta: "delta" in advanced,
      steadyHasCheckpointState: "checkpointState" in advanced,
      responseBytes: advanced.transferBytes as number,
      alertProjectionPublished: Array.isArray(projection.alerts?.rows),
      alertProjectionGeneration: advanced.factoryAlertsGeneration,
      projectedElapsedSeconds: projected.elapsedSeconds,
      oracleElapsedSeconds: canonicalOracle.elapsedSeconds,
      checkpointHash: benchmark.hashGameState(checkpoint),
      checkpointMirrorHash: benchmark.hashGameState(checkpointFromBytes),
      oracleHash: benchmark.hashGameState(canonicalOracle),
      commandRevision: commandCheckpointResponse.stateRevision as number,
      commandLocked: commandedCheckpoint.entities[0].interactionLocked,
      commandReducedMotion: commandedCheckpoint.settings.reducedMotion,
      dysonRevision: dysonCheckpointResponse.stateRevision as number,
      dysonProjectionHasState: "state" in dysonProjectionResponse,
      dysonProjectionHasCheckpoint: "checkpoint" in dysonProjectionResponse,
      dysonProjectionHasCheckpointState: "checkpointState" in dysonProjectionResponse,
      dysonProjectionEntityCount: dysonProjection.changedEntities.length,
      dysonProjectionTopLevelKeys: Object.keys(dysonProjection.topLevel).sort(),
      dysonProjectionHasAlerts: Boolean(dysonProjection.alerts),
      dysonProjectedLayerCount: dysonProjected.dysonPlans.helios.layers.length,
      dysonLayerCount: dysonCheckpoint.dysonPlans.helios.layers.length,
      dysonStructurePoints: dysonCheckpoint.dysonPlans.helios.structurePoints,
      dysonStructureConserved: Object.values(dysonCheckpoint.dysonPlans).reduce((sum, plan) => sum + plan.structurePoints, 0) === dysonCheckpoint.dysonSphere.structurePoints,
      dysonHash: benchmark.hashGameState(dysonCheckpoint),
      expectedDysonHash: benchmark.hashGameState(canonicalDysonEdited),
      dysonMismatchPaths: unexpectedDysonPatch?.topLevelChanges.map((change) => change.path.join(".")) ?? [],
      dysonMismatchEntityIds: unexpectedDysonPatch?.changedEntities.map((entity) => entity.id) ?? [],
      dysonMismatchBeltIds: unexpectedDysonPatch?.changedBelts.map((belt) => belt.id) ?? [],
      staleRejected: rejected.needsResync === true,
      resyncHash: benchmark.hashGameState(resyncCheckpoint),
      rejectedElapsedSeconds: resyncCheckpoint.elapsedSeconds,
      dysonElapsedSeconds: dysonCheckpoint.elapsedSeconds,
    };
  });

  expect(result.initializedHasState).toBe(false);
  expect(result.steadyHasState).toBe(false);
  expect(result.steadyHasDelta).toBe(false);
  expect(result.steadyHasCheckpointState).toBe(false);
  expect(result.responseBytes).toBeGreaterThan(0);
  expect(result.responseBytes).toBeLessThanOrEqual(1024 * 1024);
  expect(result.alertProjectionPublished).toBe(true);
  expect(result.alertProjectionGeneration).toBe(7);
  expect(result.projectedElapsedSeconds).toBeCloseTo(result.oracleElapsedSeconds, 8);
  expect(result.checkpointHash).toBe(result.oracleHash);
  expect(result.checkpointMirrorHash).toBe(result.checkpointHash);
  expect(result.commandRevision).toBe(3);
  expect(result.commandLocked).toBe(true);
  expect(result.commandReducedMotion).toBe(true);
  expect(result.dysonRevision).toBe(4);
  expect(result.dysonProjectionHasState).toBe(false);
  expect(result.dysonProjectionHasCheckpoint).toBe(false);
  expect(result.dysonProjectionHasCheckpointState).toBe(false);
  expect(result.dysonProjectionEntityCount).toBe(0);
  expect(result.dysonProjectionTopLevelKeys).toEqual(["dysonPlans", "productionHistory"]);
  expect(result.dysonProjectionHasAlerts).toBe(false);
  expect(result.dysonProjectedLayerCount).toBe(1);
  expect(result.dysonLayerCount).toBe(1);
  expect(result.dysonStructurePoints).toBe(137);
  expect(result.dysonStructureConserved).toBe(true);
  expect(result.dysonMismatchPaths).toEqual([]);
  expect(result.dysonMismatchEntityIds).toEqual([]);
  expect(result.dysonMismatchBeltIds).toEqual([]);
  expect(result.dysonHash).toBe(result.expectedDysonHash);
  expect(result.staleRejected).toBe(true);
  expect(result.rejectedElapsedSeconds).toBe(result.dysonElapsedSeconds);
  expect(result.resyncHash).toBe(result.dysonHash);
});

test("zero-time resume hydrates route indexes before publishing exact alerts", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const alerts = await import("/src/game/alerts.ts");
    const engine = await import("/src/game/engine.ts");
    const packs = await import("/src/game/contentPacks.ts");
    const protocol = await import("/src/game/simulationRuntimeProtocol.ts");
    const registry = packs.createContentPackRuntimeSnapshot(packs.createContentPackRegistry());
    let source = engine.createInitialState(14_045);
    source.construction.interstellar_logistics_station = 2;
    source = engine.placeBuilding(source, "interstellar_logistics_station", { x: 0, y: 0 });
    source = engine.placeBuilding(source, "interstellar_logistics_station", { x: 300, y: 0 });
    const [supply, demand] = source.entities.filter((entity) => entity.buildingId === "interstellar_logistics_station");
    demand.stationRoutes = [{
      id: "alert-route-in-flight",
      slotIndex: 0,
      peerId: supply.id,
      itemId: "iron_ingot",
      scope: "local",
      cargo: 100,
      vehicleCount: 1,
      progress: 0.5,
      duration: 10,
      requiresWarp: false,
      vehicleStationId: demand.id,
    }];
    source = engine.setPaused(source, true);
    const canonical = JSON.parse(JSON.stringify(source)) as typeof source;
    const resumed = engine.setPaused(structuredClone(canonical), false);
    const oracle = alerts.createFactoryAlertProjection(resumed, engine.createSimulationPlanetPhaseLookup(resumed));
    const worker = new Worker(new URL("/src/game/simulation.worker.ts", location.origin), { type: "module" });
    const request = (payload: Record<string, unknown>, transfer: Transferable[] = []) => new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = payload.id as number;
      const timeout = window.setTimeout(() => reject(new Error(`alert request ${id} timed out`)), 15_000);
      const listener = (event: MessageEvent<Record<string, unknown>>) => {
        if (event.data.id !== id) return;
        worker.removeEventListener("message", listener);
        window.clearTimeout(timeout);
        resolve(event.data);
      };
      worker.addEventListener("message", listener);
      worker.postMessage(payload, transfer);
    });
    const transfer = protocol.serializeSimulationStateForTransfer(canonical);
    const initialized = await request({
      id: 1,
      kind: "advance",
      stateTransfer: transfer,
      simulationSeconds: 0,
      wallSeconds: 0,
      registryFingerprint: registry.fingerprint,
      registry,
      protocol: "projection",
      stateRevision: 0,
      includeFactoryAlerts: true,
      factoryAlertsGeneration: 1,
    }, [transfer.buffer]);
    const resumeCommand = protocol.createSimulationCommandPatch(canonical, resumed, initialized.stateRevision as number)!;
    const resumedResponse = await request({
      id: 2,
      kind: "advance",
      command: resumeCommand,
      simulationSeconds: 0,
      wallSeconds: 0,
      registryFingerprint: registry.fingerprint,
      protocol: "projection",
      stateRevision: initialized.stateRevision,
      includeFactoryAlerts: true,
      factoryAlertsGeneration: 2,
    });
    const disabledView = { ...resumed, settings: { ...resumed.settings, reducedMotion: !resumed.settings.reducedMotion } };
    const disabledCommand = protocol.createSimulationCommandPatch(resumed, disabledView, resumedResponse.stateRevision as number)!;
    const disabledResponse = await request({
      id: 3,
      kind: "advance",
      command: disabledCommand,
      simulationSeconds: 0,
      wallSeconds: 0,
      registryFingerprint: registry.fingerprint,
      protocol: "projection",
      stateRevision: resumedResponse.stateRevision,
      includeFactoryAlerts: false,
      factoryAlertsGeneration: 3,
    });
    worker.terminate();
    const initializedProjection = initialized.projection as import("../../src/game/simulationProjection").SimulationProjection;
    const resumedProjection = resumedResponse.projection as import("../../src/game/simulationProjection").SimulationProjection;
    const disabledProjection = disabledResponse.projection as import("../../src/game/simulationProjection").SimulationProjection;
    return {
      initializedRows: initializedProjection.alerts?.rows.length ?? -1,
      resumedAlerts: resumedProjection.alerts,
      oracle,
      resumedGeneration: resumedResponse.factoryAlertsGeneration,
      disabledHasAlerts: Boolean(disabledProjection.alerts),
    };
  });

  expect(result.initializedRows).toBe(0);
  expect(result.resumedAlerts).toEqual(result.oracle);
  expect(result.resumedAlerts?.rows.length).toBeGreaterThan(0);
  expect(result.resumedGeneration).toBe(2);
  expect(result.disabledHasAlerts).toBe(false);
});

test("active-planet command publishes a full exact snapshot for unchanged records", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const engine = await import("/src/game/engine.ts");
    const packs = await import("/src/game/contentPacks.ts");
    const projectionModule = await import("/src/game/simulationProjection.ts");
    const protocol = await import("/src/game/simulationRuntimeProtocol.ts");
    const registry = packs.createContentPackRuntimeSnapshot(packs.createContentPackRegistry());
    const source = engine.createInitialState(44_002);
    source.paused = false;
    const staticEntity = {
      ...structuredClone(source.entities[0]),
      id: "frost-unchanged-runtime-record",
      planetId: "frost" as const,
      machineCount: 0,
    };
    source.entities.push(staticEntity);
    const canonical = JSON.parse(JSON.stringify(source)) as typeof source;
    const switchedView = { ...structuredClone(canonical), activePlanetId: "frost" as const };
    const worker = new Worker(new URL("/src/game/simulation.worker.ts", location.origin), { type: "module" });
    const request = (payload: Record<string, unknown>, transfer: Transferable[] = []) => new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = payload.id as number;
      const timeout = window.setTimeout(() => reject(new Error(`planet request ${id} timed out`)), 15_000);
      const listener = (event: MessageEvent<Record<string, unknown>>) => {
        if (event.data.id !== id) return;
        worker.removeEventListener("message", listener);
        window.clearTimeout(timeout);
        resolve(event.data);
      };
      worker.addEventListener("message", listener);
      worker.postMessage(payload, transfer);
    });
    const transfer = protocol.serializeSimulationStateForTransfer(canonical);
    const initialized = await request({
      id: 1,
      kind: "advance",
      stateTransfer: transfer,
      simulationSeconds: 0,
      wallSeconds: 0,
      registryFingerprint: registry.fingerprint,
      registry,
      protocol: "projection",
    }, [transfer.buffer]);
    const command = protocol.createSimulationCommandPatch(canonical, switchedView, initialized.stateRevision as number)!;
    const advanced = await request({
      id: 2,
      kind: "advance",
      command,
      simulationSeconds: 1,
      wallSeconds: 1,
      registryFingerprint: registry.fingerprint,
      protocol: "projection",
    });
    const projection = advanced.projection as import("../../src/game/simulationProjection").SimulationProjection;
    const applied = projectionModule.applySimulationProjectionToState(switchedView, projection).state;
    const checkpointResponse = await request({
      id: 3,
      kind: "checkpoint",
      simulationSeconds: 0,
      wallSeconds: 0,
      registryFingerprint: registry.fingerprint,
      protocol: "projection",
    });
    const checkpoint = protocol.deserializeSimulationStateTransfer(
      checkpointResponse.checkpoint as import("../../src/game/simulationRuntimeProtocol").SimulationStateTransfer,
    );
    worker.terminate();
    const projectedFrost = applied.entities.filter((entity) => entity.planetId === "frost");
    const exactFrost = checkpoint.entities.filter((entity) => entity.planetId === "frost");
    return {
      requiresFullSnapshot: projection.requiresFullSnapshot,
      changedIds: projection.changedEntityIds,
      fullRecordIds: projection.changedEntities.map((entity) => entity.id),
      projectedFrost,
      exactFrost,
    };
  });
  expect(result.requiresFullSnapshot).toBe(true);
  expect(result.changedIds).toContain("frost-unchanged-runtime-record");
  expect(result.fullRecordIds).toContain("frost-unchanged-runtime-record");
  expect(result.projectedFrost).toEqual(result.exactFrost);
});

test("game runtime requeues a rejected slice exactly once across Pause and resume", async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-17-v1.0.46");
    localStorage.setItem("dsp-idle-network.onboarding.v1", "dismissed");
    const tracker = {
      armed: false,
      injected: false,
      rejectedId: 0,
      rejectedSeconds: 0,
      rejectedWallSeconds: 0,
      resyncSeen: false,
      resyncElapsedSeconds: 0,
      resumeAttempt: 0,
      retryIds: [] as number[],
      retrySeconds: [] as number[],
      retryWallSeconds: [] as number[],
      retryElapsedSeconds: [] as number[],
    };
    (window as typeof window & { __v144ResyncTracker?: typeof tracker }).__v144ResyncTracker = tracker;
    const pauseSoon = () => window.setTimeout(() => {
      const button = document.querySelector<HTMLButtonElement>('[aria-label="暂停模拟"]');
      button?.click();
    }, 0);
    const NativeWorker = window.Worker;
    const WrappedWorker = new Proxy(NativeWorker, {
      construct(target, args) {
        const worker = Reflect.construct(target, args) as Worker;
        const isSimulation = String(args[0]).includes("simulation.worker") && (args[1] as WorkerOptions | undefined)?.name === "factory-simulation";
        if (!isSimulation) return worker;
        worker.addEventListener("message", (event: MessageEvent<Record<string, unknown>>) => {
          if (event.data.needsResync && Number(event.data.id) === tracker.rejectedId) {
            const checkpointState = event.data.checkpointState as { elapsedSeconds?: unknown } | undefined;
            if (typeof checkpointState?.elapsedSeconds === "number") tracker.resyncElapsedSeconds = checkpointState.elapsedSeconds;
            tracker.resyncSeen = true;
            pauseSoon();
            return;
          }
          const retryIndex = tracker.retryIds.indexOf(Number(event.data.id));
          if (retryIndex < 0 || event.data.needsResync) return;
          const projection = event.data.projection as { topLevel?: { elapsedSeconds?: number } } | undefined;
          if (typeof projection?.topLevel?.elapsedSeconds === "number") {
            tracker.retryElapsedSeconds[retryIndex] = projection.topLevel.elapsedSeconds;
          }
          pauseSoon();
        });
        const nativePostMessage = worker.postMessage.bind(worker);
        worker.postMessage = ((message: Record<string, unknown>, transferOrOptions?: Transferable[] | StructuredSerializeOptions) => {
          const steadyAdvance = message.kind === "advance" && !message.stateTransfer && Number(message.simulationSeconds) > 0;
          let outgoing = message;
          if (tracker.armed && !tracker.injected && steadyAdvance) {
            tracker.injected = true;
            tracker.rejectedId = Number(message.id);
            tracker.rejectedSeconds = Number(message.simulationSeconds);
            tracker.rejectedWallSeconds = Number(message.wallSeconds);
            outgoing = {
              ...message,
              command: {
                protocolVersion: 1,
                baseRevision: -1,
                topLevelChanges: [],
                changedEntities: [],
                addedEntities: [],
                removedEntityIds: [],
                changedBelts: [],
                addedBelts: [],
                removedBeltIds: [],
              },
            };
          } else if (tracker.resyncSeen && tracker.resumeAttempt > 0 && steadyAdvance && tracker.retryIds.length < tracker.resumeAttempt) {
            tracker.retryIds.push(Number(message.id));
            tracker.retrySeconds.push(Number(message.simulationSeconds));
            tracker.retryWallSeconds.push(Number(message.wallSeconds));
          }
          if (transferOrOptions === undefined) nativePostMessage(outgoing);
          else nativePostMessage(outgoing, transferOrOptions);
        }) as typeof worker.postMessage;
        return worker;
      },
    });
    Object.defineProperty(window, "Worker", { configurable: true, writable: true, value: WrappedWorker });
  });

  await page.goto("/");
  const shell = page.locator(".game-shell");
  await expect(shell).toBeVisible({ timeout: 15_000 });
  await expect(shell).toHaveAttribute("data-simulation-worker", "active");
  await expect(page.getByLabel("暂停模拟")).toBeVisible();
  await page.evaluate(() => {
    const tracker = (window as typeof window & { __v144ResyncTracker?: { armed: boolean } }).__v144ResyncTracker!;
    tracker.armed = true;
    const until = performance.now() + 2_250;
    while (performance.now() < until) { /* force one bounded two-second scheduler slice */ }
  });
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { __v144ResyncTracker?: { resyncSeen: boolean } }
  ).__v144ResyncTracker?.resyncSeen ?? false), { timeout: 15_000 }).toBe(true);
  await expect(page.getByLabel("继续模拟")).toBeVisible();

  await page.evaluate(() => {
    (window as typeof window & { __v144ResyncTracker?: { resumeAttempt: number } }).__v144ResyncTracker!.resumeAttempt = 1;
  });
  await page.getByLabel("继续模拟").click();
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { __v144ResyncTracker?: { retryElapsedSeconds: number[] } }
  ).__v144ResyncTracker?.retryElapsedSeconds.length ?? 0), { timeout: 15_000 }).toBe(1);
  await expect(page.getByLabel("继续模拟")).toBeVisible();
  // Let one paused scheduler tick discard only the fresh wall-clock remainder
  // accumulated after the retried two-second slice was taken.
  await page.waitForTimeout(1_100);

  await page.evaluate(() => {
    (window as typeof window & { __v144ResyncTracker?: { resumeAttempt: number } }).__v144ResyncTracker!.resumeAttempt = 2;
  });
  await page.getByLabel("继续模拟").click();
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { __v144ResyncTracker?: { retryElapsedSeconds: number[] } }
  ).__v144ResyncTracker?.retryElapsedSeconds.length ?? 0), { timeout: 15_000 }).toBe(2);
  await expect(page.getByLabel("继续模拟")).toBeVisible();

  const result = await page.evaluate(() => (
    window as typeof window & {
      __v144ResyncTracker?: {
        rejectedSeconds: number;
        rejectedWallSeconds: number;
        resyncElapsedSeconds: number;
        retrySeconds: number[];
        retryWallSeconds: number[];
        retryElapsedSeconds: number[];
      };
    }
  ).__v144ResyncTracker!);
  expect(result.rejectedSeconds).toBeCloseTo(2, 6);
  expect(result.rejectedWallSeconds).toBeCloseTo(result.rejectedSeconds, 6);
  expect(result.retrySeconds[0]).toBeCloseTo(result.rejectedSeconds, 6);
  expect(result.retryWallSeconds[0]).toBeCloseTo(result.rejectedWallSeconds, 6);
  expect(result.retryElapsedSeconds[0] - result.resyncElapsedSeconds).toBeCloseTo(result.retrySeconds[0], 6);
  expect(result.retrySeconds[1]).toBeGreaterThan(0);
  expect(result.retrySeconds[1]).toBeLessThan(result.rejectedSeconds * 0.75);
  expect(result.retryElapsedSeconds[1] - result.retryElapsedSeconds[0]).toBeCloseTo(result.retrySeconds[1], 6);
});

test("game runtime replays acknowledged slices after a Worker crash and remains saveable", async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-17-v1.0.46");
    localStorage.setItem("dsp-idle-network.onboarding.v1", "dismissed");
    const tracker = { simulationWorkers: 0, steadyAdvances: 0, injectedCrashes: 0 };
    (window as typeof window & { __v144CrashTracker?: typeof tracker }).__v144CrashTracker = tracker;
    const NativeWorker = window.Worker;
    const WrappedWorker = new Proxy(NativeWorker, {
      construct(target, args) {
        const worker = Reflect.construct(target, args) as Worker;
        const isSimulation = String(args[0]).includes("simulation.worker") && (args[1] as WorkerOptions | undefined)?.name === "factory-simulation";
        if (!isSimulation) return worker;
        tracker.simulationWorkers += 1;
        const nativePostMessage = worker.postMessage.bind(worker);
        worker.postMessage = ((message: Record<string, unknown>, transferOrOptions?: Transferable[] | StructuredSerializeOptions) => {
          const steadyAdvance = message.kind === "advance" && !message.stateTransfer && Number(message.simulationSeconds) > 0;
          if (tracker.injectedCrashes === 0 && steadyAdvance) {
            tracker.steadyAdvances += 1;
            if (tracker.steadyAdvances === 3) {
              tracker.injectedCrashes += 1;
              window.setTimeout(() => {
                worker.terminate();
                worker.dispatchEvent(new ErrorEvent("error", { message: "injected v144 runtime crash" }));
              }, 0);
              return;
            }
          }
          if (transferOrOptions === undefined) nativePostMessage(message);
          else nativePostMessage(message, transferOrOptions);
        }) as typeof worker.postMessage;
        return worker;
      },
    });
    Object.defineProperty(window, "Worker", { configurable: true, writable: true, value: WrappedWorker });
  });

  await page.goto("/");
  const shell = page.locator(".game-shell");
  await expect(shell).toBeVisible({ timeout: 15_000 });
  await expect(shell).toHaveAttribute("data-simulation-worker", "active");
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { __v144CrashTracker?: { injectedCrashes: number } }
  ).__v144CrashTracker?.injectedCrashes ?? 0), { timeout: 20_000 }).toBe(1);
  await expect(page.locator(".game-notice")).toContainText("已从精确检查点恢复", { timeout: 20_000 });
  await expect(shell).toHaveAttribute("data-simulation-worker", "active");

  await page.getByLabel("暂停模拟").click();
  await page.getByLabel("打开设置").click();
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.locator(".operations-tabs").getByRole("tab", { name: "存档" }).click();
  await operations.getByRole("button", { name: "立即保存" }).click();
  await expect(page.locator(".game-notice")).toContainText("主存档已保存", { timeout: 15_000 });
  const saved = await page.evaluate(async () => {
    const store = await import("/src/game/localSaveStore.ts");
    await store.flushLocalSaveWrites();
    const raw = await store.readPersistedLocalSaveValue("dsp-idle-network.save.v1");
    if (!raw) throw new Error("recovery save missing");
    const state = JSON.parse(raw).state as { elapsedSeconds: number; paused: boolean; entities: unknown[]; belts: unknown[] };
    const tracker = (window as typeof window & { __v144CrashTracker?: { injectedCrashes: number } }).__v144CrashTracker;
    return { ...state, injectedCrashes: tracker?.injectedCrashes ?? 0 };
  });
  expect(saved.injectedCrashes).toBe(1);
  expect(saved.elapsedSeconds).toBeGreaterThan(1);
  expect(saved.paused).toBe(true);
  expect(saved.entities.length).toBeGreaterThan(0);
});

test("real large save keeps running interactions and steady Worker payloads bounded", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  test.skip(!LARGE_SAVE_FIXTURE, "Set DSP_V144_LARGE_SAVE to run the read-only 1.0.44 acceptance fixture.");
  // Keep the attachment read-only while resetting only the envelope timestamp
  // in the in-memory browser fixture. This isolates realtime simulation from
  // the separate one-day offline-settlement path.
  const sourceRaw = readFileSync(LARGE_SAVE_FIXTURE!, "utf8");
  expect(createHash("sha256").update(sourceRaw).digest("hex")).toBe(AUTHORITATIVE_LARGE_SAVE_SHA256);
  const sourceEnvelope = JSON.parse(sourceRaw) as {
    state?: { activePlanetId?: string; entities?: Array<{ planetId?: string }>; belts?: unknown[] };
    activePlanetId?: string;
    entities?: Array<{ planetId?: string }>;
    belts?: unknown[];
  };
  const sourceState = sourceEnvelope.state ?? sourceEnvelope;
  const expectedActivePlanetId = sourceState.activePlanetId ?? "home";
  const expectedActiveEntityCount = sourceState.entities?.filter((entity) => entity.planetId === expectedActivePlanetId).length ?? 0;
  const expectedEntityCount = sourceState.entities?.length ?? 0;
  const expectedBeltCount = sourceState.belts?.length ?? 0;
  expect(expectedActiveEntityCount).toBe(4_213);
  // Preserve the real v2 envelope/checksum/mode identity. Only savedAt is
  // outside the state checksum and may be refreshed in this in-memory fixture.
  const raw = JSON.stringify({ ...sourceEnvelope, savedAt: Date.now() });

  await page.addInitScript(() => {
    (window as typeof window & { __DSP_RUNTIME_TRANSITIONS__?: unknown }).__DSP_RUNTIME_TRANSITIONS__ = {
      enabled: true,
      events: [],
      active: {},
      counters: {},
    };
    localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-17-v1.0.46");
    localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
    localStorage.setItem("dsp-idle-network.onboarding.v1", "dismissed");
    // Large-factory escape hatch: this must stop the Worker scan itself, not
    // merely hide alert badges after the projection reaches the UI.
    localStorage.setItem("dsp-idle-network.ui.factory-alerts.v1", "false");
    localStorage.setItem("dsp-idle-network.canvas-performance-features.v1", JSON.stringify({
      renderProjection: true,
      topologyCache: true,
      extremeVisuals: true,
      nodeLod: true,
      canvasBelts: true,
      viewportCulling: true,
      spatialIndexes: true,
      minimapThrottle: true,
    }));
    const tracker: {
      projectionResponses: number;
      fullStateResponses: number;
      lastProjectionResponse: unknown;
      disabledAlertProjectionResponses: number;
      enabledAlertProjectionResponses: number;
      enabledAlertProjectionMaxBytes: number;
      enabledAlertRows: number;
    } = {
      projectionResponses: 0,
      fullStateResponses: 0,
      lastProjectionResponse: null,
      disabledAlertProjectionResponses: 0,
      enabledAlertProjectionResponses: 0,
      enabledAlertProjectionMaxBytes: 0,
      enabledAlertRows: 0,
    };
    (window as typeof window & { __v144LargeRuntime?: typeof tracker }).__v144LargeRuntime = tracker;
    const NativeWorker = window.Worker;
    const WrappedWorker = new Proxy(NativeWorker, {
      construct(target, args) {
        const worker = Reflect.construct(target, args) as Worker;
        if (String(args[0]).includes("simulation.worker") && (args[1] as WorkerOptions | undefined)?.name === "factory-simulation") {
          const alertModeByRequestId = new Map<number, boolean>();
          const nativePostMessage = worker.postMessage.bind(worker);
          worker.postMessage = ((message: Record<string, unknown>, transferOrOptions?: Transferable[] | StructuredSerializeOptions) => {
            alertModeByRequestId.set(Number(message.id), message.includeFactoryAlerts === true);
            if (transferOrOptions === undefined) nativePostMessage(message);
            else nativePostMessage(message, transferOrOptions);
          }) as typeof worker.postMessage;
          worker.addEventListener("message", (event: MessageEvent<Record<string, unknown>>) => {
            if (event.data.protocol !== "projection") return;
            if (event.data.projection) {
              tracker.projectionResponses += 1;
              tracker.lastProjectionResponse = event.data;
              const projection = event.data.projection as { alerts?: { rows?: unknown[] } };
              const alertMode = alertModeByRequestId.get(Number(event.data.id));
              if (alertMode === false && projection.alerts) tracker.disabledAlertProjectionResponses += 1;
              if (alertMode === true && projection.alerts) {
                tracker.enabledAlertProjectionResponses += 1;
                tracker.enabledAlertRows = Math.max(tracker.enabledAlertRows, projection.alerts.rows?.length ?? 0);
                tracker.enabledAlertProjectionMaxBytes = Math.max(
                  tracker.enabledAlertProjectionMaxBytes,
                  new TextEncoder().encode(JSON.stringify(event.data)).byteLength,
                );
              }
            }
            alertModeByRequestId.delete(Number(event.data.id));
            if (event.data.state) tracker.fullStateResponses += 1;
          });
        }
        return worker;
      },
    });
    Object.defineProperty(window, "Worker", { configurable: true, writable: true, value: WrappedWorker });
  });
  await page.goto("/?storageMigration=production");
  const seeded = await page.evaluate(async (saveRaw) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("dsp-idle-network.local-saves", 2);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("records")) request.result.createObjectStore("records", { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const write = database.transaction("records", "readwrite");
    write.objectStore("records").put({
      key: "dsp-idle-network.save.v1",
      value: saveRaw,
      bytes: new Blob([saveRaw]).size,
      updatedAt: Date.now(),
    });
    await new Promise<void>((resolve, reject) => {
      write.oncomplete = () => resolve();
      write.onabort = () => reject(write.error);
      write.onerror = () => reject(write.error);
    });
    const persisted = await new Promise<string | null>((resolve, reject) => {
      const request = database.transaction("records", "readonly").objectStore("records")
        .get("dsp-idle-network.save.v1") as IDBRequest<{ value?: unknown } | undefined>;
      request.onsuccess = () => resolve(typeof request.result?.value === "string" ? request.result.value : null);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return { exact: persisted === saveRaw, bytes: persisted ? new Blob([persisted]).size : 0 };
  }, raw);
  expect(seeded).toEqual({ exact: true, bytes: new Blob([raw]).size });
  // The menu summary is snapshotted during its initial render. Reloading this
  // menu-only page is safe and lets startup consume the verified IDB record.
  await page.reload();
  const continueGame = page.getByRole("button", { name: /继续游戏/ });
  await expect(continueGame).toBeVisible({ timeout: 30_000 });
  await continueGame.click();
  const shell = page.locator(".game-shell");
  await expect(shell).toBeVisible({ timeout: 120_000 });
  await expect(shell).toHaveAttribute("data-simulation-worker", "active");
  await expect(shell).toHaveAttribute("data-factory-alerts-enabled", "false");
  const storageProbe = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("dsp-idle-network.local-saves", 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const catalogRecord = await new Promise<{ value?: unknown } | undefined>((resolve, reject) => {
      const key = `dsp-idle-network.local-save.catalog.v1.${encodeURIComponent("dsp-idle-network.save.v1")}`;
      const request = database.transaction("records", "readonly").objectStore("records").get(key);
      request.onsuccess = () => resolve(request.result as { value?: unknown } | undefined);
      request.onerror = () => reject(request.error);
    });
    database.close();
    const catalog = typeof catalogRecord?.value === "string"
      ? JSON.parse(catalogRecord.value) as { byteLength?: number; integrity?: string }
      : null;
    const shell = document.querySelector<HTMLElement>(".game-shell")?.dataset;
    return {
      backend: shell?.localSaveBackend ?? "missing",
      rawCacheSize: Number(shell?.localSaveRawCacheSize ?? -1),
      catalogBytes: catalog?.byteLength ?? 0,
      catalogIntegrity: catalog?.integrity ?? "missing",
    };
  });
  expect(storageProbe.backend).toBe("indexeddb");
  expect(storageProbe.rawCacheSize).toBe(0);
  // 1.0.44 may keep the exact v2 source envelope or commit the verified sparse
  // v46 projection on first entry. Both identities must remain large and exact;
  // the source attachment itself is re-hashed at the end of this test.
  expect([new Blob([raw]).size, 29_572_337]).toContain(storageProbe.catalogBytes);
  expect(storageProbe.catalogIntegrity).toBe("valid");
  await expect(shell).toHaveAttribute("data-active-planet-node-count", String(expectedActiveEntityCount));
  const preResumeCanvas = await page.evaluate(() => ({
    shell: { ...document.querySelector<HTMLElement>(".game-shell")?.dataset },
    canvas: { ...document.querySelector<HTMLElement>(".factory-canvas")?.dataset },
    reactFlowNodes: document.querySelectorAll(".react-flow__node").length,
    heavyNodes: document.querySelectorAll('[data-heavy-card="true"]').length,
    stackProxies: document.querySelectorAll(".factory-node-stack-proxy").length,
  }));
  expect(preResumeCanvas.canvas.flowCommitStatic).toBe("true");
  expect(preResumeCanvas.canvas.flowFullyDeferred).toBe("true");
  expect(expectedEntityCount).toBeGreaterThan(0);
  expect(expectedBeltCount).toBeGreaterThan(0);
  const continueStartedAt = Date.now();
  const continueButton = page.getByLabel("继续模拟");
  if (await continueButton.isVisible()) {
    const continueBox = await continueButton.boundingBox();
    if (!continueBox) throw new Error("large-save Continue control has no geometry");
    await page.mouse.click(continueBox.x + continueBox.width / 2, continueBox.y + continueBox.height / 2);
  }
  const resumed = await page.waitForFunction(() =>
    document.querySelector<HTMLElement>(".game-shell")?.dataset.simulationPaused === "false",
  undefined, { timeout: 15_000 }).then(() => true, () => false);
  if (!resumed) {
    const resumeFailure = await page.evaluate(() => ({
      shell: { ...document.querySelector<HTMLElement>(".game-shell")?.dataset },
      canvas: { ...document.querySelector<HTMLElement>(".factory-canvas")?.dataset },
      notices: [...document.querySelectorAll<HTMLElement>(".game-notice")].map((element) => element.innerText),
      diagnostics: (window as typeof window & { __DSP_RUNTIME_TRANSITIONS__?: unknown }).__DSP_RUNTIME_TRANSITIONS__,
      canvasBoundary: (window as typeof window & { __DSP_CANVAS_BOUNDARY__?: unknown }).__DSP_CANVAS_BOUNDARY__,
    }));
  }
  expect(resumed).toBe(true);
  await expect(page.getByLabel("暂停模拟")).toBeVisible();
  const continueLatencyMs = Date.now() - continueStartedAt;
  await page.evaluate(() => {
    const frames: number[] = [];
    const longTasks: Array<{ startTime: number; duration: number; name: string; attribution: string[] }> = [];
    const probe: {
      done: boolean;
      metrics: null | {
        p95Ms: number;
        maxMs: number;
        longTaskMaxMs: number;
        longTasks: typeof longTasks;
        sampleCount: number;
        timedOut: boolean;
      };
    } = { done: false, metrics: null };
    Object.assign(window, { __v144RunningInteractionProbe: probe });
    const observer = new PerformanceObserver((entries) => entries.getEntries().forEach((entry) => {
      const candidate = entry as PerformanceEntry & { attribution?: Array<{ name?: string }> };
      longTasks.push({
        startTime: entry.startTime,
        duration: entry.duration,
        name: entry.name,
        attribution: (candidate.attribution ?? []).map((item) => item.name ?? "unknown"),
      });
    }));
    try { observer.observe({ type: "longtask" }); } catch { /* optional metric */ }
    const startedAt = performance.now();
    let previousAt = startedAt;
    const finish = (timedOut: boolean) => {
      if (probe.done) return;
      probe.done = true;
      observer.disconnect();
      const sorted = [...frames].sort((left, right) => left - right);
      probe.metrics = {
        p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0,
        maxMs: sorted.at(-1) ?? 0,
        longTaskMaxMs: Math.max(0, ...longTasks.map((entry) => entry.duration)),
        longTasks: longTasks.sort((left, right) => right.duration - left.duration).slice(0, 12),
        sampleCount: frames.length,
        timedOut,
      };
    };
    const sample = (now: number) => {
      frames.push(now - previousAt);
      previousAt = now;
      if (now - startedAt < 6_000) {
        requestAnimationFrame(sample);
        return;
      }
      finish(false);
    };
    window.setTimeout(() => finish(true), 8_000);
    requestAnimationFrame(sample);
  });
  const pane = page.locator(".react-flow__pane");
  const paneBox = await pane.boundingBox();
  if (!paneBox) throw new Error("large-save canvas pane is not measurable");
  const center = { x: paneBox.x + paneBox.width / 2, y: paneBox.y + paneBox.height / 2 };
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x + 140, center.y + 90, { steps: 12 });
  await page.mouse.up();
  await page.mouse.wheel(0, -420);
  await page.mouse.wheel(0, 280);
  await page.waitForTimeout(8_500);
  const frameMetrics = await Promise.race([
    page.evaluate(() => {
      const probe = (window as typeof window & {
        __v144RunningInteractionProbe?: {
          done: boolean;
          metrics: null | {
            p95Ms: number;
            maxMs: number;
            longTaskMaxMs: number;
            longTasks: Array<{ startTime: number; duration: number; name: string; attribution: string[] }>;
            sampleCount: number;
            timedOut: boolean;
          };
        };
      }).__v144RunningInteractionProbe;
      if (!probe?.done || !probe.metrics) throw new Error("large-save interaction sampler did not finish");
      return probe.metrics;
    }),
    new Promise<never>((_resolve, reject) => setTimeout(
      () => reject(new Error("large-save interaction metrics read timed out")),
      10_000,
    )),
  ]);
  const runningCanvasMetrics = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLElement>("canvas.canvas-belt-layer");
    const factoryCanvas = document.querySelector<HTMLElement>(".factory-canvas");
    const shell = document.querySelector<HTMLElement>(".game-shell");
    const minimap = document.querySelector<HTMLElement>("canvas.canvas-minimap-snapshot");
    return {
      belt: canvas ? { ...canvas.dataset } : null,
      factory: factoryCanvas ? { ...factoryCanvas.dataset } : null,
      shell: shell ? { ...shell.dataset } : null,
      reactFlowNodes: document.querySelectorAll(".react-flow__node").length,
      reactFlowEdges: document.querySelectorAll(".react-flow__edge").length,
      minimap: minimap ? { ...minimap.dataset } : null,
    };
  });
  const pauseStartedAt = Date.now();
  await page.getByLabel("暂停模拟").click();
  await expect(page.getByLabel("继续模拟")).toBeVisible();
  const pauseLatencyMs = Date.now() - pauseStartedAt;
  const workerMetrics = await page.evaluate(() => {
    const tracker = (window as typeof window & {
      __v144LargeRuntime?: { projectionResponses: number; fullStateResponses: number; lastProjectionResponse: unknown; disabledAlertProjectionResponses: number };
    }).__v144LargeRuntime!;
    return {
      projectionResponses: tracker.projectionResponses,
      fullStateResponses: tracker.fullStateResponses,
      disabledAlertProjectionResponses: tracker.disabledAlertProjectionResponses,
      lastProjectionBytes: new TextEncoder().encode(JSON.stringify(tracker.lastProjectionResponse)).byteLength,
    };
  });
  const transitionMetrics = await page.evaluate(() => {
    const diagnostics = (window as typeof window & {
      __DSP_RUNTIME_TRANSITIONS__?: {
        events: Array<{ phase: string; durationMs: number; transition?: string }>;
        counters?: Record<string, { count: number; totalMs: number; maxMs: number }>;
      };
      __DSP_RENDER_PROFILES__?: Array<{
        id: string;
        phase: string;
        actualDuration: number;
        baseDuration: number;
        startTime: number;
        commitTime: number;
      }>;
    }).__DSP_RUNTIME_TRANSITIONS__;
    const phases: Record<string, { count: number; totalMs: number; maxMs: number }> = {};
    for (const event of diagnostics?.events ?? []) {
      const current = phases[event.phase] ?? { count: 0, totalMs: 0, maxMs: 0 };
      current.count += 1;
      current.totalMs += event.durationMs;
      current.maxMs = Math.max(current.maxMs, event.durationMs);
      phases[event.phase] = current;
    }
    const secondPainted = (diagnostics?.events ?? [])
      .filter((event) => event.phase === "second-painted-frame" && (event.transition === "resume" || event.transition === "pause"))
      .map((event) => ({ transition: event.transition!, durationMs: event.durationMs }));
    const renderProfiles = ((window as typeof window & {
      __DSP_RENDER_PROFILES__?: Array<{
        id: string;
        phase: string;
        actualDuration: number;
        baseDuration: number;
        startTime: number;
        commitTime: number;
      }>;
    }).__DSP_RENDER_PROFILES__ ?? []).slice(-100);
    return { phases, counters: diagnostics?.counters ?? {}, secondPainted, renderProfiles };
  });
  // Playwright's outer action duration includes locator resolution,
  // actionability checks and browser-protocol round trips. The product gate is
  // recorded inside the click handler and ends at the second painted frame.
  const combinedMetrics = {
    continueHarnessRoundTripMs: continueLatencyMs,
    pauseHarnessRoundTripMs: pauseLatencyMs,
    ...frameMetrics,
    runningCanvasMetrics,
    ...workerMetrics,
    transitionMetrics,
  };
  expect(combinedMetrics.continueHarnessRoundTripMs).toBeGreaterThanOrEqual(0);
  expect(combinedMetrics.pauseHarnessRoundTripMs).toBeGreaterThanOrEqual(0);
  expect(transitionMetrics.secondPainted.find((entry) => entry.transition === "resume")?.durationMs).toBeLessThanOrEqual(100);
  expect(transitionMetrics.secondPainted.find((entry) => entry.transition === "pause")?.durationMs).toBeLessThanOrEqual(100);
  expect(frameMetrics.timedOut).toBe(false);
  expect(frameMetrics.sampleCount).toBeGreaterThan(0);
  expect(frameMetrics.p95Ms).toBeLessThanOrEqual(20);
  expect(frameMetrics.longTaskMaxMs).toBeLessThanOrEqual(100);
  expect(workerMetrics.projectionResponses).toBeGreaterThanOrEqual(2);
  expect(workerMetrics.fullStateResponses).toBe(0);
  expect(workerMetrics.disabledAlertProjectionResponses).toBe(0);
  expect(workerMetrics.lastProjectionBytes).toBeLessThanOrEqual(1024 * 1024);
  await page.getByLabel("打开设置").click();
  await page.getByRole("navigation", { name: "设置分类" }).getByRole("button", { name: "终局性能" }).click();
  const alertsToggle = page.getByRole("checkbox", { name: /工厂运行警报/ });
  await expect(alertsToggle).not.toBeChecked();
  await alertsToggle.locator("..").click();
  await expect(alertsToggle).toBeChecked();
  await expect(shell).toHaveAttribute("data-factory-alerts-enabled", "true");
  await page.getByRole("button", { name: "关闭运营中心" }).click();
  await page.getByLabel("继续模拟").click();
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { __v144LargeRuntime?: { enabledAlertProjectionResponses: number } }
  ).__v144LargeRuntime?.enabledAlertProjectionResponses ?? 0), { timeout: 30_000 }).toBeGreaterThan(0);
  const enabledAlertCapacity = await page.evaluate(() => {
    const tracker = (window as typeof window & {
      __v144LargeRuntime?: { enabledAlertProjectionMaxBytes: number; enabledAlertRows: number };
    }).__v144LargeRuntime!;
    return {
      responseBytes: tracker.enabledAlertProjectionMaxBytes,
      rows: tracker.enabledAlertRows,
    };
  });
  expect(enabledAlertCapacity.rows).toBeGreaterThan(0);
  expect(enabledAlertCapacity.responseBytes).toBeLessThanOrEqual(1024 * 1024);
  expect(createHash("sha256").update(readFileSync(LARGE_SAVE_FIXTURE!, "utf8")).digest("hex")).toBe(AUTHORITATIVE_LARGE_SAVE_SHA256);
  const leakedArtifacts = outputFiles(testInfo.outputDir).filter((artifact) =>
    artifact.bytes >= sourceRaw.length || /\.(?:zip|webm|png|jpe?g)$/i.test(artifact.path));
  expect(leakedArtifacts).toEqual([]);
});

test("real large save manual persistence stays off the main thread", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  test.skip(!LARGE_SAVE_FIXTURE, "Set DSP_V144_LARGE_SAVE to run the read-only 1.0.44 acceptance fixture.");
  const sourceRaw = readFileSync(LARGE_SAVE_FIXTURE!, "utf8");
  expect(createHash("sha256").update(sourceRaw).digest("hex")).toBe(AUTHORITATIVE_LARGE_SAVE_SHA256);
  const sourceEnvelope = JSON.parse(sourceRaw) as Record<string, unknown>;
  const raw = JSON.stringify({ ...sourceEnvelope, savedAt: Date.now() });

  await page.addInitScript(() => {
    localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-17-v1.0.46");
    localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
    localStorage.setItem("dsp-idle-network.ui.factory-alerts.v1", "false");
  });
  await page.goto("/?storageMigration=production");
  const seeded = await page.evaluate(async (saveRaw) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("dsp-idle-network.local-saves", 2);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("records")) request.result.createObjectStore("records", { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const write = database.transaction("records", "readwrite");
    write.objectStore("records").put({
      key: "dsp-idle-network.save.v1",
      value: saveRaw,
      bytes: new Blob([saveRaw]).size,
      updatedAt: Date.now(),
    });
    await new Promise<void>((resolve, reject) => {
      write.oncomplete = () => resolve();
      write.onabort = () => reject(write.error);
      write.onerror = () => reject(write.error);
    });
    const persisted = await new Promise<string | null>((resolve, reject) => {
      const request = database.transaction("records", "readonly").objectStore("records")
        .get("dsp-idle-network.save.v1") as IDBRequest<{ value?: unknown } | undefined>;
      request.onsuccess = () => resolve(typeof request.result?.value === "string" ? request.result.value : null);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return { exact: persisted === saveRaw, bytes: persisted ? new Blob([persisted]).size : 0 };
  }, raw);
  expect(seeded).toEqual({ exact: true, bytes: new Blob([raw]).size });

  await page.reload();
  const continueGame = page.getByRole("button", { name: /继续游戏/ });
  await expect(continueGame).toBeVisible({ timeout: 30_000 });
  await continueGame.click();
  const shell = page.locator(".game-shell");
  await expect(shell).toBeVisible({ timeout: 120_000 });
  await expect(shell).toHaveAttribute("data-simulation-worker", "active");
  await expect(shell).toHaveAttribute("data-runtime-recovery", "active");
  const pauseButton = page.getByLabel("暂停模拟");
  if (await pauseButton.isVisible()) {
    await pauseButton.click();
    await expect(page.getByLabel("继续模拟")).toBeVisible();
  }
  await page.getByLabel("打开设置").click();
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.getByRole("tab", { name: "存档" }).click();
  await expect(operations.getByRole("button", { name: "立即保存" })).toBeVisible();
  await page.evaluate(() => {
    const counters = { parse: 0, stringify: 0, textEncoder: 0, longTasks: [] as Array<{ startTime: number; duration: number }> };
    const originalParse = JSON.parse;
    const originalStringify = JSON.stringify;
    const originalEncode = TextEncoder.prototype.encode;
    const observer = new PerformanceObserver((entries) => {
      for (const entry of entries.getEntries()) counters.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
    });
    try { observer.observe({ type: "longtask" }); } catch { /* optional metric */ }
    JSON.parse = ((value: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => {
      if (typeof value === "string" && value.length >= 1024 * 1024) counters.parse += 1;
      return originalParse.call(JSON, value, reviver);
    }) as typeof JSON.parse;
    JSON.stringify = ((value: unknown, replacer?: unknown, space?: string | number) => {
      const result = originalStringify.call(JSON, value, replacer as never, space as never);
      if (result && result.length >= 1024 * 1024) counters.stringify += 1;
      return result;
    }) as typeof JSON.stringify;
    TextEncoder.prototype.encode = function(value?: string) {
      if (typeof value === "string" && value.length >= 1024 * 1024) counters.textEncoder += 1;
      return originalEncode.call(this, value);
    };
    (window as typeof window & { __v144SaveMainProbe?: unknown }).__v144SaveMainProbe = {
      counters,
      observer,
      originalParse,
      originalStringify,
      originalEncode,
    };
  });
  await operations.getByRole("button", { name: "立即保存" }).click();
  await expect(shell).toHaveAttribute("data-primary-save-edit-lock", "true", { timeout: 10_000 });
  await operations.getByRole("button", { name: "关闭运营中心" }).click();
  // A player command arriving after the T1 save boundary must be explicitly
  // rejected, not written into the stale T0 WAL and then discarded when the
  // new recovery head is published.
  await page.getByLabel("继续模拟").click();
  await expect(shell).toHaveAttribute("data-simulation-paused", "true");
  await expect(shell).toHaveAttribute("data-primary-save-rejected-edits", "1");
  await expect(shell).toHaveAttribute("data-persistence-kind", "manual", { timeout: 60_000 });
  await expect(shell).toHaveAttribute("data-persistence-phase", "complete", { timeout: 60_000 });
  const saveMainThread = await page.evaluate(() => {
    const probe = (window as typeof window & {
      __v144SaveMainProbe?: {
        counters: { parse: number; stringify: number; textEncoder: number; longTasks: Array<{ startTime: number; duration: number }> };
        observer: PerformanceObserver;
        originalParse: typeof JSON.parse;
        originalStringify: typeof JSON.stringify;
        originalEncode: typeof TextEncoder.prototype.encode;
      };
    }).__v144SaveMainProbe!;
    probe.observer.disconnect();
    JSON.parse = probe.originalParse;
    JSON.stringify = probe.originalStringify;
    TextEncoder.prototype.encode = probe.originalEncode;
    return {
      parse: probe.counters.parse,
      stringify: probe.counters.stringify,
      textEncoder: probe.counters.textEncoder,
      longTaskMaxMs: Math.max(0, ...probe.counters.longTasks.map((entry) => entry.duration)),
      longTasks: probe.counters.longTasks,
    };
  });
  expect(saveMainThread).toMatchObject({ parse: 0, stringify: 0, textEncoder: 0 });
  expect(saveMainThread.longTaskMaxMs).toBeLessThanOrEqual(100);
  expect(createHash("sha256").update(readFileSync(LARGE_SAVE_FIXTURE!, "utf8")).digest("hex")).toBe(AUTHORITATIVE_LARGE_SAVE_SHA256);
  const leakedArtifacts = outputFiles(testInfo.outputDir).filter((artifact) =>
    artifact.bytes >= sourceRaw.length || /\.(?:zip|webm|png|jpe?g)$/i.test(artifact.path));
  expect(leakedArtifacts).toEqual([]);
});

test("real large pure-idle stop persists and rebases without main-thread payload work", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  test.skip(!LARGE_SAVE_FIXTURE, "Set DSP_V144_LARGE_SAVE to run the read-only 1.0.44 acceptance fixture.");
  const sourceRaw = readFileSync(LARGE_SAVE_FIXTURE!, "utf8");
  expect(createHash("sha256").update(sourceRaw).digest("hex")).toBe(AUTHORITATIVE_LARGE_SAVE_SHA256);
  const sourceEnvelope = JSON.parse(sourceRaw) as Record<string, unknown>;
  const raw = JSON.stringify({ ...sourceEnvelope, savedAt: Date.now() });

  await page.addInitScript(() => {
    localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-17-v1.0.46");
    localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
    localStorage.setItem("dsp-idle-network.ui.factory-alerts.v1", "false");
  });
  await seedLargePrimarySave(page, raw);
  await page.reload();
  const continueGame = page.getByRole("button", { name: /继续游戏/ });
  await expect(continueGame).toBeVisible({ timeout: 30_000 });
  await continueGame.click();
  const shell = page.locator(".game-shell");
  await expect(shell).toBeVisible({ timeout: 120_000 });
  await expect(shell).toHaveAttribute("data-simulation-worker", "active");
  await expect(shell).toHaveAttribute("data-runtime-recovery", "active");

  await page.keyboard.press("Control+K");
  const palette = page.getByRole("dialog", { name: "命令面板" });
  await expect(palette).toBeVisible();
  await palette.getByRole("combobox", { name: "搜索命令" }).fill("时间扭曲装置");
  const paletteStats = await page.evaluate(() => ({
    value: document.querySelector<HTMLInputElement>('.command-palette input[aria-label="搜索命令"]')?.value ?? "missing",
    resultCount: document.querySelectorAll(".command-palette-list button").length,
    timeWarpMatches: [...document.querySelectorAll<HTMLElement>(".command-palette-list button")]
      .filter((element) => element.innerText.includes("时间扭曲装置")).length,
  }));
  const timeWarpCommand = palette.getByRole("option", { name: /定位：时间扭曲装置/ }).first();
  await expect(timeWarpCommand).toBeVisible({ timeout: 30_000 });
  await timeWarpCommand.click({ force: true });
  const inspector = page.locator(".inspector-panel");
  const startPureIdle = inspector.getByRole("button", { name: "开始纯挂机" });
  await expect(startPureIdle).toBeVisible({ timeout: 30_000 });
  await startPureIdle.click();
  const idle = page.getByRole("dialog", { name: "纯挂机" });
  await expect(idle).toBeVisible({ timeout: 120_000 });
  await expect(idle).toContainText(/正常宏观结算中|保守宏观结算中/, { timeout: 120_000 });

  await page.evaluate(() => {
    const counters = { parse: 0, stringify: 0, textEncoder: 0, longTasks: [] as Array<{ startTime: number; duration: number }> };
    const originalParse = JSON.parse;
    const originalStringify = JSON.stringify;
    const originalEncode = TextEncoder.prototype.encode;
    const observer = new PerformanceObserver((entries) => {
      for (const entry of entries.getEntries()) counters.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
    });
    try { observer.observe({ type: "longtask" }); } catch { /* optional metric */ }
    JSON.parse = ((value: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => {
      if (typeof value === "string" && value.length >= 1024 * 1024) counters.parse += 1;
      return originalParse.call(JSON, value, reviver);
    }) as typeof JSON.parse;
    JSON.stringify = ((value: unknown, replacer?: unknown, space?: string | number) => {
      const result = originalStringify.call(JSON, value, replacer as never, space as never);
      if (result && result.length >= 1024 * 1024) counters.stringify += 1;
      return result;
    }) as typeof JSON.stringify;
    TextEncoder.prototype.encode = function(value?: string) {
      if (typeof value === "string" && value.length >= 1024 * 1024) counters.textEncoder += 1;
      return originalEncode.call(this, value);
    };
    (window as typeof window & { __v144PureIdleStopProbe?: unknown }).__v144PureIdleStopProbe = {
      counters,
      observer,
      originalParse,
      originalStringify,
      originalEncode,
    };
  });
  await idle.getByRole("button", { name: "停止并结算纯挂机" }).click();
  await expect(idle).toBeHidden({ timeout: 120_000 });
  await expect(shell).toHaveAttribute("data-persistence-kind", "pure-idle-stop", { timeout: 30_000 });
  await expect(shell).toHaveAttribute("data-persistence-phase", "complete", { timeout: 30_000 });
  await expect(shell).toHaveAttribute("data-simulation-worker", "active");
  await expect(shell).toHaveAttribute("data-runtime-recovery", "active");
  const stopMainThread = await page.evaluate(() => {
    const probe = (window as typeof window & {
      __v144PureIdleStopProbe?: {
        counters: { parse: number; stringify: number; textEncoder: number; longTasks: Array<{ startTime: number; duration: number }> };
        observer: PerformanceObserver;
        originalParse: typeof JSON.parse;
        originalStringify: typeof JSON.stringify;
        originalEncode: typeof TextEncoder.prototype.encode;
      };
    }).__v144PureIdleStopProbe!;
    probe.observer.disconnect();
    JSON.parse = probe.originalParse;
    JSON.stringify = probe.originalStringify;
    TextEncoder.prototype.encode = probe.originalEncode;
    return {
      parse: probe.counters.parse,
      stringify: probe.counters.stringify,
      textEncoder: probe.counters.textEncoder,
      longTaskMaxMs: Math.max(0, ...probe.counters.longTasks.map((entry) => entry.duration)),
      longTasks: probe.counters.longTasks,
    };
  });
  expect(stopMainThread).toMatchObject({ parse: 0, stringify: 0, textEncoder: 0 });
  expect(stopMainThread.longTaskMaxMs).toBeLessThanOrEqual(100);

  await page.reload();
  const reloadContinue = page.getByRole("button", { name: /继续游戏/ });
  await expect(reloadContinue).toBeVisible({ timeout: 30_000 });
  await reloadContinue.click();
  await expect(page.locator(".game-shell")).toBeVisible({ timeout: 120_000 });
  await expect(page.getByRole("dialog", { name: "纯挂机" })).toHaveCount(0);
  expect(createHash("sha256").update(readFileSync(LARGE_SAVE_FIXTURE!, "utf8")).digest("hex")).toBe(AUTHORITATIVE_LARGE_SAVE_SHA256);
  const leakedArtifacts = outputFiles(testInfo.outputDir).filter((artifact) =>
    artifact.bytes >= sourceRaw.length || /\.(?:zip|webm|png|jpe?g)$/i.test(artifact.path));
  expect(leakedArtifacts).toEqual([]);
});

