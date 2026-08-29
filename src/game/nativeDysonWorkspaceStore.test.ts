import { describe, expect, it } from "vitest";

import type {
  DesktopBridge,
  DesktopNativeCoreDysonEngineeringSummary,
  DesktopNativeCoreDysonSystemRow,
  DesktopNativeCoreDysonWorkspaceProjectionRequest,
  DesktopNativeCoreDysonWorkspaceProjectionResult,
} from "../desktop";
import {
  NativeDysonWorkspaceStore,
  createNativePlayerAuthorityDysonWorkspaceSource,
  selectNativeDysonWorkspaceFrame,
  type NativeDysonWorkspaceIdentity,
} from "./nativeDysonWorkspaceStore";

const identity: NativeDysonWorkspaceIdentity = {
  sessionId: "core-dyson",
  revision: 17,
  registryFingerprint: "builtin:test",
  selectedSystemId: "helios",
};

function engineering(overrides: Partial<DesktopNativeCoreDysonEngineeringSummary> = {}): DesktopNativeCoreDysonEngineeringSummary {
  return {
    launchMode: "balanced",
    launchThrottle: 0.5,
    launchEnabled: true,
    orbitCount: 0,
    orbitSails: 0,
    queuedSails: 0,
    queuedRockets: 0,
    sailLaunchesPerMinute: 0,
    rocketLaunchesPerMinute: 0,
    launchEnergyPerSailMj: 21.6,
    launchEnergyPerRocketMj: 108,
    launchEnergyPerMinuteMj: 0,
    rayGenerationKw: 0,
    receiverCapacityKw: 0,
    operationalReceiverCapacityKw: 0,
    receiverLoadKw: 0,
    theoreticalReceptionRate: 0,
    receiverUtilization: 0,
    dysonPowerUtilization: 0,
    configuredReceiverCount: 0,
    blockedReceiverCount: 0,
    criticalPhotonPerMinute: 0,
    antimatterPerMinute: 0,
    feedbackGenerationKw: 0,
    plannedStructurePoints: 0,
    completedStructurePoints: 0,
    remainingStructurePoints: 0,
    shellCapacity: 0,
    shellSails: 0,
    projectedGenerationKw: 0,
    ...overrides,
  };
}

function systemRow(id: string, index: number): DesktopNativeCoreDysonSystemRow {
  const selected = id === "helios";
  return {
    systemId: id,
    displayName: id === "mod:星系/Ω🚀" ? "模组星系 🚀" : id,
    displayNameTruncated: false,
    starProfile: {
      available: id !== "mod:星系/Ω🚀",
      starTypeName: id === "mod:星系/Ω🚀" ? id : "G",
      starTypeNameTruncated: false,
      luminosity: 1,
      radiusMultiplier: 1,
    },
    unlocked: true,
    active: index === 0,
    activeLayerId: selected ? "layer:一" : null,
    activeOrbitId: selected ? "orbit:一" : null,
    structurePoints: selected ? 20 : 0,
    shellSails: selected ? 5 : 0,
    totals: {
      layerCount: selected ? 1 : 0,
      nodeCount: selected ? 2 : 0,
      frameCount: selected ? 1 : 0,
      shellCount: selected ? 1 : 0,
      plannedStructurePoints: selected ? 20 : 0,
      completedStructurePoints: selected ? 20 : 0,
      sailCapacity: selected ? 10 : 0,
      absorbedSails: selected ? 5 : 0,
    },
    orbitCount: selected ? 1 : 0,
    orbitSails: selected ? 30 : 0,
    projectedGenerationKw: selected ? 32_604 : 0,
    engineering: engineering(selected ? {
      orbitCount: 1,
      orbitSails: 30,
      plannedStructurePoints: 20,
      completedStructurePoints: 20,
      shellCapacity: 10,
      shellSails: 5,
      projectedGenerationKw: 32_604,
    } : {}),
  };
}

const systemIds = [
  "helios", "borealis", "system-2", "system-3", "system-4", "system-5", "system-6",
  "system-7", "mod:星系/Ω🚀",
];
const systems = systemIds.map(systemRow);
const layers = [{
  layerId: "layer:一",
  name: "主层",
  nameTruncated: false,
  radius: 10_000,
  inclination: 0,
  longitude: 0,
  structureAllocationFloor: 0,
  shellAllocationFloor: 0,
  nodeCount: 2,
  frameCount: 1,
  shellCount: 1,
  plannedStructurePoints: 20,
  completedStructurePoints: 20,
  sailCapacity: 10,
  absorbedSails: 5,
}];
const orbits = [{
  orbitId: "orbit:一",
  name: "轨道一",
  nameTruncated: false,
  radius: 12_000,
  inclination: 0,
  longitude: 0,
  sailsInOrbit: 30,
  totalLaunched: 42,
  totalExpired: 7,
  decayProgress: 0.25,
  generationKw: 2_904,
}];
const nodes = [
  { layerId: "layer:一", nodeId: "node:a", angle: 0, requiredStructurePoints: 5, completedStructurePoints: 5 },
  { layerId: "layer:一", nodeId: "node:b", angle: 180, requiredStructurePoints: 5, completedStructurePoints: 5 },
];
const frames = [{
  layerId: "layer:一",
  frameId: "frame:a-b",
  sourceNodeId: "node:a",
  targetNodeId: "node:b",
  requiredStructurePoints: 10,
  completedStructurePoints: 10,
}];
const shells = [{
  layerId: "layer:一",
  shellId: "shell:a-b",
  sourceNodeId: "node:a",
  targetNodeId: "node:b",
  boundaryFrameCount: 1,
  active: true,
  sailCapacity: 10,
  absorbedSails: 5,
}];

function page<T>(rows: readonly T[], cursor: number, limit: number) {
  const selected = rows.slice(cursor, cursor + limit);
  const consumed = cursor + selected.length;
  return {
    cursor,
    limit,
    totalCount: rows.length,
    nextCursor: consumed < rows.length ? consumed : null,
    rows: [...selected],
  };
}

function projection(request: DesktopNativeCoreDysonWorkspaceProjectionRequest): DesktopNativeCoreDysonWorkspaceProjectionResult {
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
    request: {
      expectedRevision: request.expectedRevision,
      expectedRegistryFingerprint: request.expectedRegistryFingerprint,
      selectedSystemId: request.selectedSystemId,
      systemCursor: request.systemCursor,
      systemLimit: request.systemLimit,
      layerCursor: request.layerCursor,
      layerLimit: request.layerLimit,
      orbitCursor: request.orbitCursor,
      orbitLimit: request.orbitLimit,
      nodeCursor: request.nodeCursor,
      nodeLimit: request.nodeLimit,
      frameCursor: request.frameCursor,
      frameLimit: request.frameLimit,
      shellCursor: request.shellCursor,
      shellLimit: request.shellLimit,
    },
    activePlanetId: "home",
    activeSystemId: "helios",
    selectedSystemId: request.selectedSystemId,
    technology: { programReady: true, shellReady: true, swarmReady: true },
    global: {
      sphere: { structurePoints: 20, totalRocketsLaunched: 25, shellSails: 5, totalSailsAbsorbed: 5, generationKw: 19_640 },
      swarm: { sailsInOrbit: 30, totalLaunched: 42, totalExpired: 7, generationKw: 2_904, receiverLoadKw: 0 },
      launch: { mode: "balanced", throttle: 0.5, enabled: true, energySpentMj: 4_321 },
    },
    summary: { systemCount: 9, unlockedSystemCount: 9, layerCount: 1, orbitCount: 1, nodeCount: 2, frameCount: 1, shellCount: 1 },
    selectedSystem: systems[0],
    systems: page(systems, request.systemCursor, request.systemLimit),
    layers: page(layers, request.layerCursor, request.layerLimit),
    orbits: page(orbits, request.orbitCursor, request.orbitLimit),
    nodes: page(nodes, request.nodeCursor, request.nodeLimit),
    frames: page(frames, request.frameCursor, request.frameLimit),
    shells: page(shells, request.shellCursor, request.shellLimit),
  };
}

function bridge(
  reader: (request: DesktopNativeCoreDysonWorkspaceProjectionRequest) => Promise<DesktopNativeCoreDysonWorkspaceProjectionResult> =
    async (request) => projection(request),
): Pick<DesktopBridge, "getNativeCoreDysonWorkspaceProjection"> {
  return { getNativeCoreDysonWorkspaceProjection: reader };
}

describe("NativeDysonWorkspaceStore", () => {
  it("fetches all independent pages and commits one exact native-only frame", async () => {
    const calls: DesktopNativeCoreDysonWorkspaceProjectionRequest[] = [];
    const source = createNativePlayerAuthorityDysonWorkspaceSource(bridge(async (request) => {
      calls.push(request);
      return projection(request);
    }), identity);
    expect(source).not.toBeNull();
    const store = new NativeDysonWorkspaceStore();
    expect(await store.refresh(source!, identity)).toBe("committed");
    const frame = selectNativeDysonWorkspaceFrame(store.getSnapshot(), identity);
    expect(frame?.systems).toHaveLength(9);
    expect(frame?.systemsById.get("mod:星系/Ω🚀")?.displayName).toBe("模组星系 🚀");
    expect(frame?.nodesByLayerId.get("layer:一")).toHaveLength(2);
    expect(frame?.orbitsById.get("orbit:一")?.sailsInOrbit).toBe(30);
    expect(calls).toHaveLength(2);
    expect(calls[1].systemCursor).toBe(8);
    expect(calls[1].layerCursor).toBe(1);
    expect(store.getSnapshot().status).toBe("ready");
  });

  it("fails closed when the bridge changes revision, fingerprint or echoed cursors", async () => {
    for (const mutate of [
      (value: DesktopNativeCoreDysonWorkspaceProjectionResult) => { value.revision += 1; },
      (value: DesktopNativeCoreDysonWorkspaceProjectionResult) => { value.registryFingerprint = "builtin:other"; },
      (value: DesktopNativeCoreDysonWorkspaceProjectionResult) => { value.request.nodeCursor += 1; },
    ]) {
      const source = createNativePlayerAuthorityDysonWorkspaceSource(bridge(async (request) => {
        const value = projection(request);
        mutate(value);
        return value;
      }), identity)!;
      const store = new NativeDysonWorkspaceStore();
      expect(await store.refresh(source, identity)).toBe("unavailable");
      expect(store.getSnapshot()).toMatchObject({ status: "unavailable", frame: null });
    }
  });

  it("is latest-only when a newer selected-system identity supersedes an in-flight read", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const oldSource = createNativePlayerAuthorityDysonWorkspaceSource(bridge(async (request) => {
      await gate;
      return projection(request);
    }), identity)!;
    const nextIdentity = { ...identity, selectedSystemId: "helios-next" };
    const nextSystems = systems.map((row, index) => index === 0 ? { ...row, systemId: "helios-next" } : row);
    const nextSource: ReturnType<typeof createNativePlayerAuthorityDysonWorkspaceSource> = {
      mode: "player-authority",
      boundIdentity: nextIdentity,
      async readVerifiedDysonWorkspaceProjection(request, expectedRevision) {
        const full = projection({
          sessionId: nextIdentity.sessionId,
          expectedRevision,
          expectedRegistryFingerprint: nextIdentity.registryFingerprint,
          selectedSystemId: nextIdentity.selectedSystemId,
          ...request,
        });
        full.selectedSystemId = nextIdentity.selectedSystemId;
        full.request.selectedSystemId = nextIdentity.selectedSystemId;
        full.activeSystemId = nextIdentity.selectedSystemId;
        full.selectedSystem = nextSystems[0];
        full.systems = page(nextSystems, request.systemCursor, request.systemLimit);
        return full;
      },
    };
    const store = new NativeDysonWorkspaceStore();
    const oldRefresh = store.refresh(oldSource, identity);
    const nextRefresh = store.refresh(nextSource!, nextIdentity);
    release();
    expect(await oldRefresh).toBe("superseded");
    expect(await nextRefresh).toBe("committed");
    expect(store.getSnapshot().frame?.selectedSystemId).toBe("helios-next");
  });

  it("does not import or inspect renderer GameState", () => {
    const source = require("node:fs").readFileSync(
      "src/game/nativeDysonWorkspaceStore.ts",
      "utf8",
    ) as string;
    expect(source).not.toContain('from "./types"');
    expect(source).not.toMatch(/GameState|\.entities\b|\.belts\b/);
  });
});
