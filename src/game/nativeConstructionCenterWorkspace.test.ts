import { describe, expect, it } from "vitest";
import type { NativeAuthoritativeFactoryWorkspaceFrame } from "./nativeFactoryWorkspaceFrame";
import type { NativeConstructionCenterWorkspaceReadModel } from "./factoryReadModels";
import { selectNativeConstructionCenterWorkspaceFrame } from "./nativeConstructionCenterWorkspace";

const emptyRows = <Row>(rows: Row[] = []) => ({ rows, totalCount: rows.length, truncated: false });
const emptyQuantities = () => ({ rows: [] as never[], totalCount: 0, totalAmount: 0, truncated: false });

function frame(): NativeAuthoritativeFactoryWorkspaceFrame {
  const workspace: NativeConstructionCenterWorkspaceReadModel = {
    schema: "construction-center-workspace-v1" as const,
    registryFingerprint: "7df8cf3a" as const,
    readOnly: true as const,
    activePlanetId: "home",
    activePlanetName: "家园星",
    paused: false,
    enabled: true,
    quantumSourceEnabled: true,
    quantumNetworkEnabled: true,
    totalCrafted: 12,
    lastCraftedId: null,
    lastCraftedName: null,
    stockLimit: 500,
    cycleSeconds: 2.5,
    materialSeconds: 0.05,
    targets: emptyRows(),
    centers: emptyRows(),
    jobs: emptyRows(),
    materials: emptyQuantities(),
    quantumBuffer: emptyQuantities(),
    destroyedByproducts: emptyQuantities(),
    limits: {
      targetRows: 128 as const,
      centerRows: 64 as const,
      jobRows: 64 as const,
      materialRows: 256 as const,
      quantumBufferRows: 256 as const,
      destroyedByproductRows: 256 as const,
      costRowsPerTarget: 32 as const,
      projectionBytes: 1048576 as const,
    },
  };
  return {
    source: "native-authoritative",
    sessionId: "session-a",
    runId: "run-a",
    revision: 9,
    simulationSpeed: 1,
    runStatus: { schema: "factory-read-model-v1", source: "native-core", revision: 9, activePlanetId: "home", paused: false },
    timeWarp: { controllerEntityId: null, enabled: false, requestedMultiplier: 1, effectiveMultiplier: 1, requiredPowerKw: 0, allocatedPowerKw: 0 },
    constructionHeadline: { schema: "factory-read-model-v1", source: "native-core", revision: 9, activePlanetId: "home", activePlanetDisplayName: "家园星", constructionQueueCount: 0 },
    constructionWorkspace: {
      schema: "factory-read-model-v1",
      source: "native-core",
      revision: 9,
      activePlanetId: "home",
      queue: emptyRows(),
      nativeCenterWorkspace: workspace,
      automation: { enabled: true, quantumSourceEnabled: true, totalCrafted: 12, lastCraftedId: null, targets: emptyRows(), jobs: emptyRows(), destroyedByproducts: emptyRows() },
    },
    planetNavigation: { schema: "factory-read-model-v1", activePlanetId: "home", planets: emptyRows() },
  };
}

describe("native construction-center workspace identity", () => {
  it("keeps session, run, revision and active planet in one frame", () => {
    expect(selectNativeConstructionCenterWorkspaceFrame(frame())).toMatchObject({
      sessionId: "session-a",
      runId: "run-a",
      revision: 9,
      activePlanetId: "home",
      workspace: { activePlanetName: "家园星", readOnly: true },
    });
  });

  it("fails closed for missing built-in data or cross-planet drift", () => {
    const current = frame();
    expect(selectNativeConstructionCenterWorkspaceFrame({
      ...current,
      constructionWorkspace: { ...current.constructionWorkspace, nativeCenterWorkspace: null },
    })).toBeNull();
    expect(selectNativeConstructionCenterWorkspaceFrame({
      ...current,
      planetNavigation: { ...current.planetNavigation, activePlanetId: "remote" },
    })).toBeNull();
  });
});
