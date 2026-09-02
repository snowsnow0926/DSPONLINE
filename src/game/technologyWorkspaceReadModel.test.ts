import { describe, expect, it, vi } from "vitest";
import type { DesktopNativeCoreTechnologyProjectionResult } from "../desktop";
import {
  getDysonSailAbsorptionMultiplier,
  getInterstellarCargoCapacity,
  getLogisticsSpeedMultiplier,
  getMiningSpeedMultiplier,
  getPlanetaryCargoCapacity,
  getRayReceiverCapacityKw,
  getRecipeSpeedMultiplier,
  getSolarSailLifetimeSeconds,
  createInitialState,
} from "./engine";
import {
  createWebTechnologyWorkspaceReadModel,
  selectNativeTechnologyWorkspaceReadModel,
} from "./technologyWorkspaceReadModel";
import {
  NativeTechnologyWorkspaceStore,
  createNativePlayerAuthorityTechnologyProjectionSource,
  selectNativeTechnologyWorkspaceFrame,
} from "./nativeTechnologyWorkspaceStore";

function projection(revision = 7): DesktopNativeCoreTechnologyProjectionResult {
  return {
    schemaVersion: 1,
    projectionType: "technology-v1",
    revision,
    truncated: false,
    limits: { techRows: 512, progressItemsPerTech: 16, infiniteRows: 8 },
    counts: { completedTechIds: 4, queuedTechIds: 1, progressTechs: 1, infiniteResearch: 5 },
    selectedTechId: "research_speed_2",
    pausedTechId: null,
    completedTechIds: ["research_speed_1", "mining_speed_1", "logistics_engine_1", "universe_matrix"],
    queuedTechIds: ["research_speed_3"],
    progressByTech: [{
      techId: "research_speed_2",
      totalCount: 1,
      truncated: false,
      items: [{ itemId: "gravity_matrix", amount: 9 }],
    }],
    activeInfiniteResearchId: null,
    autoResearch: true,
    infiniteResearch: [
      { researchId: "matrix_compression", level: 2, historicalLevel: null, progress: "17" },
      { researchId: "vein_utilization", level: 1, historicalLevel: null, progress: "0" },
      { researchId: "galactic_logistics", level: 3, historicalLevel: null, progress: "0" },
      { researchId: "stellar_harnessing", level: 4, historicalLevel: null, progress: "0" },
      { researchId: "continuum_simulation", level: 0, historicalLevel: null, progress: "0" },
    ],
    settings: { technologyLayout: "compact", fontScale: 1.25, difficulty: "hard" },
    matrixStock: {
      electromagnetic_matrix: 10,
      energy_matrix: 20,
      structure_matrix: 30,
      information_matrix: 40,
      gravity_matrix: 50,
      universe_matrix: 60,
    },
  };
}

describe("technology workspace read model", () => {
  it("builds the Web fallback once without double-counting the active tray", () => {
    const state = createInitialState();
    state.entities[0]!.inputs.electromagnetic_matrix = 2;
    state.entities[0]!.outputs.electromagnetic_matrix = 3;
    state.tray.electromagnetic_matrix = 5;
    state.planetTrays[state.activePlanetId].electromagnetic_matrix = 999;
    state.cargo = { itemId: "electromagnetic_matrix", amount: 7 };
    state.research.completedTechIds.push(
      "research_speed_1", "mining_speed_1", "logistics_engine_1", "universe_matrix",
    );
    state.endgame.infiniteResearch.matrix_compression.level = 2;
    state.endgame.infiniteResearch.vein_utilization.level = 1;
    state.endgame.infiniteResearch.galactic_logistics.level = 3;
    state.endgame.infiniteResearch.stellar_harnessing.level = 4;

    const model = createWebTechnologyWorkspaceReadModel(state);

    expect(model.matrixStock.electromagnetic_matrix).toBe(17);
    expect(model.effects).toEqual({
      miningSpeedMultiplier: getMiningSpeedMultiplier(state),
      researchSpeedMultiplier: getRecipeSpeedMultiplier(state, "matrix_research"),
      logisticsSpeedMultiplier: getLogisticsSpeedMultiplier(state),
      planetaryCargoCapacity: getPlanetaryCargoCapacity(state),
      interstellarCargoCapacity: getInterstellarCargoCapacity(state),
      solarSailLifetimeSeconds: getSolarSailLifetimeSeconds(state),
      rayReceiverCapacityKw: getRayReceiverCapacityKw(state),
      dysonSailAbsorptionMultiplier: getDysonSailAbsorptionMultiplier(state),
    });
    expect(model).not.toHaveProperty("entities");
    expect(model).not.toHaveProperty("belts");
  });

  it("accepts only one complete session/revision-bound native atom", () => {
    const frame = {
      sessionId: "authority-1",
      runId: "run-1",
      revision: 7,
      registryFingerprint: "builtin:test",
      projection: projection(),
    };
    const binding = {
      enabled: true,
      sessionId: "authority-1",
      runId: "run-1",
      expectedRevision: 7,
      expectedRegistryFingerprint: "builtin:test",
    };
    const model = selectNativeTechnologyWorkspaceReadModel(frame, binding);

    expect(model).toMatchObject({
      source: "native-core",
      revision: 7,
      research: { selectedTechId: "research_speed_2", queuedTechIds: ["research_speed_3"] },
      matrixStock: { universe_matrix: 60 },
    });
    expect(selectNativeTechnologyWorkspaceReadModel(frame, { ...binding, sessionId: "authority-2" })).toBeNull();
    expect(selectNativeTechnologyWorkspaceReadModel(frame, { ...binding, expectedRevision: 8 })).toBeNull();
    expect(selectNativeTechnologyWorkspaceReadModel({ ...frame, projection: { ...projection(), truncated: true } }, binding)).toBeNull();
    expect(selectNativeTechnologyWorkspaceReadModel({
      ...frame,
      projection: { ...projection(), counts: { ...projection().counts, progressTechs: 2 } },
    }, binding)).toBeNull();
    expect(selectNativeTechnologyWorkspaceReadModel({
      ...frame,
      projection: {
        ...projection(),
        progressByTech: [{ ...projection().progressByTech[0]!, truncated: true, totalCount: 2 }],
      },
    }, binding)).toBeNull();
  });

  it("publishes no stale response after a newer revision wins", async () => {
    const store = new NativeTechnologyWorkspaceStore();
    const oldIdentity = { sessionId: "authority-1", runId: "run-1", revision: 7, registryFingerprint: "builtin:test" };
    const currentIdentity = { ...oldIdentity, revision: 8 };
    let resolveOld!: (value: DesktopNativeCoreTechnologyProjectionResult | null) => void;
    const old = store.refresh({
      boundIdentity: oldIdentity,
      readVerifiedTechnologyProjection: () => new Promise((resolve) => { resolveOld = resolve; }),
    }, oldIdentity);
    const current = await store.refresh({
      boundIdentity: currentIdentity,
      readVerifiedTechnologyProjection: vi.fn().mockResolvedValue(projection(8)),
    }, currentIdentity);
    resolveOld(projection(7));

    expect(current).toBe("committed");
    await expect(old).resolves.toBe("superseded");
    expect(store.getSnapshot()).toMatchObject({
      status: "ready",
      requestedRevision: 8,
      frame: { sessionId: "authority-1", revision: 8 },
    });
  });

  it("retains a same-run confirmed frame while the next revision loads and fails closed across lineage", async () => {
    const store = new NativeTechnologyWorkspaceStore();
    const identity7 = {
      sessionId: "authority-1",
      runId: "run-1",
      revision: 7,
      registryFingerprint: "builtin:test",
    };
    await expect(store.refresh({
      boundIdentity: identity7,
      readVerifiedTechnologyProjection: vi.fn().mockResolvedValue(projection(7)),
    }, identity7)).resolves.toBe("committed");

    const identity8 = { ...identity7, revision: 8 };
    let resolveNext!: (value: DesktopNativeCoreTechnologyProjectionResult | null) => void;
    const source = {
      boundIdentity: identity8,
      readVerifiedTechnologyProjection: vi.fn(() => new Promise<DesktopNativeCoreTechnologyProjectionResult | null>(
        (resolve) => { resolveNext = resolve; },
      )),
    };
    const first = store.refresh(source, identity8);
    const duplicate = store.refresh(source, identity8);

    expect(duplicate).toBe(first);
    expect(source.readVerifiedTechnologyProjection).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toMatchObject({ status: "loading", requestedRevision: 8 });
    expect(selectNativeTechnologyWorkspaceFrame(store.getSnapshot(), identity8)?.revision).toBe(7);
    expect(selectNativeTechnologyWorkspaceFrame(store.getSnapshot(), {
      ...identity8,
      runId: "run-2",
    })).toBeNull();
    expect(selectNativeTechnologyWorkspaceFrame(store.getSnapshot(), {
      ...identity8,
      registryFingerprint: "builtin:other",
    })).toBeNull();
    expect(selectNativeTechnologyWorkspaceFrame(store.getSnapshot(), identity7)).toBeNull();

    resolveNext(projection(8));
    await expect(first).resolves.toBe("committed");
    expect(selectNativeTechnologyWorkspaceFrame(store.getSnapshot(), identity8)?.revision).toBe(8);
  });

  it("binds the read-only authority source and rejects a revision mismatch", async () => {
    const bridge = {
      getNativeCoreTechnologyProjection: vi.fn().mockResolvedValue(projection(9)),
    };
    const identity = { sessionId: "authority-1", runId: "run-1", revision: 8, registryFingerprint: "builtin:test" };
    const source = createNativePlayerAuthorityTechnologyProjectionSource(bridge, identity);
    expect(source).not.toBeNull();
    await expect(source!.readVerifiedTechnologyProjection()).resolves.toBeNull();
    expect(bridge.getNativeCoreTechnologyProjection).toHaveBeenCalledWith({
      sessionId: "authority-1",
      runId: "run-1",
      expectedRevision: 8,
      expectedRegistryFingerprint: "builtin:test",
    });
    expect(createNativePlayerAuthorityTechnologyProjectionSource(bridge, {
      ...identity,
      sessionId: "bad session",
    })).toBeNull();
  });
});
