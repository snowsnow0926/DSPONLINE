import { describe, expect, it, vi } from "vitest";
import type {
  DesktopBridge,
  DesktopNativeCoreDysonOrbitRow,
  DesktopNativeCoreDysonWorkspaceProjectionRequest,
  DesktopNativeCoreDysonWorkspaceProjectionResult,
} from "../desktop";
import type { FactoryEntity } from "./types";
import {
  createNativeProjectedEjectorOrbitCommand,
  createNativeProjectedTimeWarpEnabledCommand,
  createNativeProjectedTimeWarpRequestedMultiplierCommand,
  getNativeProjectedTimeWarpControllerState,
  readNativeProjectedEjectorOrbitFrame,
  type NativeProjectedEjectorOrbitIdentity,
  type NativeProjectedTimeWarpControllerBinding,
} from "./nativeProjectedTimeWarpEjectorCommands";

const REGISTRY = "7df8cf3a";

function entity(overrides: Partial<FactoryEntity> = {}): FactoryEntity {
  return {
    id: "controller-a",
    kind: "machine",
    planetId: "home",
    position: { x: 1, y: 2 },
    interactionLocked: false,
    buildingId: "time_warp_device",
    routingCursor: 0,
    machineCount: 1,
    minerCount: 0,
    inputs: {},
    outputs: {},
    progress: 0,
    utilization: 0,
    productionRate: 0,
    ...overrides,
  };
}

function timeWarpBinding(
  overrides: Partial<NativeProjectedTimeWarpControllerBinding> = {},
): NativeProjectedTimeWarpControllerBinding {
  return {
    sessionId: "session-a",
    runId: "run-a",
    revision: 41,
    activePlanetId: "home",
    registryFingerprint: REGISTRY,
    simulationSpeed: 4,
    entity: entity(),
    timeWarp: {
      controllerEntityId: "controller-a",
      enabled: false,
      requestedMultiplier: 15,
      effectiveMultiplier: 4,
      requiredPowerKw: 0,
      allocatedPowerKw: 0,
    },
    ...overrides,
  };
}

function ejectorIdentity(
  overrides: Partial<NativeProjectedEjectorOrbitIdentity> = {},
): NativeProjectedEjectorOrbitIdentity {
  return {
    sessionId: "session-a",
    runId: "run-a",
    revision: 41,
    activePlanetId: "home",
    activeSystemId: "helios",
    registryFingerprint: REGISTRY,
    entity: entity({
      id: "ejector-a",
      buildingId: "em_rail_ejector",
      recipeId: "solar_sail_launch",
      targetDysonOrbitId: "orbit-old",
    }),
    ...overrides,
  };
}

function orbit(orbitId: string): DesktopNativeCoreDysonOrbitRow {
  return {
    orbitId,
    name: orbitId === "orbit-old" ? "旧轨道" : "新轨道",
    nameTruncated: false,
    radius: orbitId === "orbit-old" ? 12_000 : 18_000,
    inclination: 0,
    longitude: 0,
    sailsInOrbit: 0,
    totalLaunched: 0,
    totalExpired: 0,
    decayProgress: 0,
    generationKw: 0,
  };
}

function projection(
  request: DesktopNativeCoreDysonWorkspaceProjectionRequest,
  overrides: Partial<DesktopNativeCoreDysonWorkspaceProjectionResult> = {},
): DesktopNativeCoreDysonWorkspaceProjectionResult {
  const { sessionId: _sessionId, ...echoedRequest } = request;
  const rows = [orbit("orbit-old"), orbit("orbit-new")];
  const emptyPage = { cursor: 0, limit: 1, totalCount: 0, rows: [], nextCursor: null };
  return {
    schemaVersion: 1,
    projectionType: "dyson-workspace-v1",
    revision: request.expectedRevision,
    registryFingerprint: request.expectedRegistryFingerprint,
    stateVersion: 47,
    limits: {
      requestBytes: 32768,
      projectionBytes: 1048576,
      pageRows: 64,
      totalRows: 65536,
      idBytes: 1024,
      labelBytes: 512,
    },
    request: echoedRequest,
    activePlanetId: "home",
    activeSystemId: "helios",
    selectedSystemId: "helios",
    technology: { programReady: true, shellReady: true, swarmReady: true },
    global: {
      sphere: { structurePoints: 0, totalRocketsLaunched: 0, shellSails: 0, totalSailsAbsorbed: 0, generationKw: 0 },
      swarm: { sailsInOrbit: 0, totalLaunched: 0, totalExpired: 0, generationKw: 0, receiverLoadKw: 0 },
      launch: { mode: "balanced", throttle: 1, enabled: true, energySpentMj: 0 },
    },
    summary: { systemCount: 1, unlockedSystemCount: 1, layerCount: 0, orbitCount: 2, nodeCount: 0, frameCount: 0, shellCount: 0 },
    selectedSystem: { systemId: "helios", orbitCount: 2 } as DesktopNativeCoreDysonWorkspaceProjectionResult["selectedSystem"],
    systems: emptyPage as DesktopNativeCoreDysonWorkspaceProjectionResult["systems"],
    layers: emptyPage as DesktopNativeCoreDysonWorkspaceProjectionResult["layers"],
    orbits: { cursor: 0, limit: 8, totalCount: 2, rows, nextCursor: null },
    nodes: emptyPage as DesktopNativeCoreDysonWorkspaceProjectionResult["nodes"],
    frames: emptyPage as DesktopNativeCoreDysonWorkspaceProjectionResult["frames"],
    shells: emptyPage as DesktopNativeCoreDysonWorkspaceProjectionResult["shells"],
    ...overrides,
  };
}

describe("native projected time-warp commands", () => {
  it("emits only a controller-bound semantic intent and never renderer-derived power leaves", () => {
    const enable = createNativeProjectedTimeWarpEnabledCommand(timeWarpBinding(), true)!;
    expect(enable.topLevelChanges).toEqual([{
      path: ["timeWarp", "intent"],
      operation: "set",
      value: { controllerEntityId: "controller-a", enabled: true },
    }]);
    expect(JSON.stringify(enable)).not.toContain("requiredPowerKw");
    expect(JSON.stringify(enable)).not.toContain("effectiveMultiplier");

    const multiplier = createNativeProjectedTimeWarpRequestedMultiplierCommand(
      timeWarpBinding(),
      Number.MAX_SAFE_INTEGER,
    )!;
    expect(multiplier.topLevelChanges).toEqual([{
      path: ["timeWarp", "intent"],
      operation: "set",
      value: {
        controllerEntityId: "controller-a",
        requestedMultiplier: Number.MAX_SAFE_INTEGER,
      },
    }]);
    expect(createNativeProjectedTimeWarpEnabledCommand(timeWarpBinding(), false)).toBeNull();
    expect(createNativeProjectedTimeWarpRequestedMultiplierCommand(timeWarpBinding(), 15)).toBeNull();
  });

  it("fails closed for MOD, locked, foreign, malformed and stale-controller bindings", () => {
    const invalid = [
      timeWarpBinding({ registryFingerprint: "MOD-registry" }),
      timeWarpBinding({ entity: entity({ interactionLocked: true }) }),
      timeWarpBinding({ entity: entity({ interactionLocked: undefined as unknown as boolean }) }),
      timeWarpBinding({ entity: entity({ planetId: "ashen" }) }),
      timeWarpBinding({ entity: entity({ kind: "power" }) }),
      timeWarpBinding({ entity: entity({ buildingId: "arc_smelter" }) }),
      timeWarpBinding({ timeWarp: { ...timeWarpBinding().timeWarp, controllerEntityId: "controller-b" } }),
      timeWarpBinding({ revision: -1 }),
    ];
    for (const binding of invalid) {
      expect(getNativeProjectedTimeWarpControllerState(binding)).toBeNull();
      expect(() => createNativeProjectedTimeWarpEnabledCommand(binding, true)).toThrow(TypeError);
    }
    expect(() => createNativeProjectedTimeWarpRequestedMultiplierCommand(timeWarpBinding(), 4))
      .toThrow(TypeError);
    expect(() => createNativeProjectedTimeWarpRequestedMultiplierCommand(
      timeWarpBinding(),
      Number.MAX_SAFE_INTEGER + 1,
    )).toThrow(TypeError);
  });
});

describe("native projected ejector target commands", () => {
  it("reads one bounded same-revision orbit page and emits only one target leaf", async () => {
    const getProjection = vi.fn(async (request: DesktopNativeCoreDysonWorkspaceProjectionRequest) =>
      projection(request));
    const frame = await readNativeProjectedEjectorOrbitFrame({
      getNativeCoreDysonWorkspaceProjection: getProjection,
    } as Pick<DesktopBridge, "getNativeCoreDysonWorkspaceProjection">, ejectorIdentity());
    expect(frame).not.toBeNull();
    expect(getProjection).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-a",
      expectedRevision: 41,
      expectedRegistryFingerprint: REGISTRY,
      selectedSystemId: "helios",
      orbitCursor: 0,
      orbitLimit: 8,
      systemLimit: 1,
      layerLimit: 1,
      nodeLimit: 1,
      frameLimit: 1,
      shellLimit: 1,
    }));
    const command = createNativeProjectedEjectorOrbitCommand(frame!, "orbit-new")!;
    expect(command).toEqual({
      protocolVersion: 1,
      baseRevision: 41,
      topLevelChanges: [],
      changedEntities: [{
        id: "ejector-a",
        changes: [{ path: ["targetDysonOrbitId"], operation: "set", value: "orbit-new" }],
      }],
      addedEntities: [],
      removedEntityIds: [],
      changedBelts: [],
      addedBelts: [],
      removedBeltIds: [],
    });
    expect(JSON.stringify(command)).not.toContain("新轨道");
    expect(createNativeProjectedEjectorOrbitCommand(frame!, "orbit-old")).toBeNull();
    expect(() => createNativeProjectedEjectorOrbitCommand(frame!, "orbit-foreign"))
      .toThrow(TypeError);
  });

  it("rejects stale, partial, duplicate, foreign-system, MOD and locked orbit projections", async () => {
    const cases: Array<{
      identity?: NativeProjectedEjectorOrbitIdentity;
      mutate?: (value: DesktopNativeCoreDysonWorkspaceProjectionResult) => DesktopNativeCoreDysonWorkspaceProjectionResult;
    }> = [
      { identity: ejectorIdentity({ registryFingerprint: "MOD-registry" }) },
      { identity: ejectorIdentity({ entity: entity({ id: "ejector-a", buildingId: "em_rail_ejector", interactionLocked: true }) }) },
      { identity: ejectorIdentity({ entity: entity({ id: "ejector-a", buildingId: "em_rail_ejector", planetId: "ashen" }) }) },
      { mutate: (value) => ({ ...value, revision: 40 }) },
      { mutate: (value) => ({ ...value, activeSystemId: "sigma" }) },
      { mutate: (value) => ({ ...value, technology: { ...value.technology, swarmReady: false } }) },
      { mutate: (value) => ({ ...value, orbits: { ...value.orbits, totalCount: 3 } }) },
      { mutate: (value) => ({ ...value, orbits: { ...value.orbits, rows: [orbit("orbit-old"), orbit("orbit-old")] } }) },
    ];
    for (const row of cases) {
      const bridge = {
        getNativeCoreDysonWorkspaceProjection: async (
          request: DesktopNativeCoreDysonWorkspaceProjectionRequest,
        ) => {
          const value = projection(request);
          return row.mutate?.(value) ?? value;
        },
      } as Pick<DesktopBridge, "getNativeCoreDysonWorkspaceProjection">;
      expect(await readNativeProjectedEjectorOrbitFrame(
        bridge,
        row.identity ?? ejectorIdentity(),
      )).toBeNull();
    }
  });
});
