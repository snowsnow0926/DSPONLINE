import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_NATIVE_SYSTEM_SPACE_STATION_SELECTOR,
  NativeSystemSpaceStationWorkspaceStore,
  createNativeSystemSpaceStationWorkspaceSource,
  nativeSystemSpaceStationSelectorWithCursor,
  selectNativeSystemSpaceStationWorkspaceFrame,
  validNativeSystemSpaceStationSelector,
  type NativeSystemSpaceStationInterstellarStationRow,
  type NativeSystemSpaceStationInventoryRow,
  type NativeSystemSpaceStationPage,
  type NativeSystemSpaceStationRequirementRow,
  type NativeSystemSpaceStationTrayRow,
  type NativeSystemSpaceStationWorkspaceIdentity,
  type NativeSystemSpaceStationWorkspaceProjection,
  type NativeSystemSpaceStationWorkspaceProjectionRequest,
} from "./nativeSystemSpaceStationWorkspaceStore";

export const SYSTEM_STATION_IDENTITY: NativeSystemSpaceStationWorkspaceIdentity = Object.freeze({
  sessionId: "station-session",
  runId: "station-run",
  revision: 41,
  registryFingerprint: "builtin:test",
  systemId: "helios",
});

const requirements: NativeSystemSpaceStationRequirementRow[] = [
  { requirementIndex: 0, phaseName: "轨道基座", itemId: "titanium_alloy", itemName: "钛合金", itemNameTruncated: false, baseAmount: 1_000_000, requiredAmount: "900000", deliveredAmount: "900000", constructionBufferAmount: "25", complete: true, current: false },
  { requirementIndex: 1, phaseName: "主体框架", itemId: "frame_material", itemName: "框架材料", itemNameTruncated: false, baseAmount: 2_000_000, requiredAmount: "1800000", deliveredAmount: "300000", constructionBufferAmount: "100", complete: false, current: true },
  { requirementIndex: 2, phaseName: "调度核心", itemId: "processor", itemName: "处理器", itemNameTruncated: false, baseAmount: 5_000_000, requiredAmount: "4500000", deliveredAmount: "0", constructionBufferAmount: "0", complete: false, current: false },
];
const inventory: NativeSystemSpaceStationInventoryRow[] = [
  { itemId: "copper_ingot", itemName: "铜块", itemNameTruncated: false, amount: "100000000000000000000", policy: null },
  { itemId: "iron_ingot", itemName: "铁块", itemNameTruncated: false, amount: "500", policy: { interstellarEnabled: true, reserve: "100", target: "1000" } },
];
const trays: NativeSystemSpaceStationTrayRow[] = [
  { planetId: "home", planetName: "家园星", planetNameTruncated: false, activePlanet: true, itemId: "titanium_alloy", itemName: "钛合金", itemNameTruncated: false, amount: 1_000_000, constructionMaterial: true },
  { planetId: "home", planetName: "家园星", planetNameTruncated: false, activePlanet: true, itemId: "frame_material", itemName: "框架材料", itemNameTruncated: false, amount: 500_000, constructionMaterial: true },
  { planetId: "forge", planetName: "锻造星", planetNameTruncated: false, activePlanet: false, itemId: "copper_ingot", itemName: "铜块", itemNameTruncated: false, amount: 4_321, constructionMaterial: false },
];
const emptyOutputs = Array.from({ length: 5 }, (_, portIndex) => ({
  portIndex,
  itemId: null,
  itemName: "",
  itemNameTruncated: false,
}));
const stations: NativeSystemSpaceStationInterstellarStationRow[] = [
  { entityId: "station-b", planetId: "home", planetName: "家园星", planetNameTruncated: false, machineCount: 1, stationTier: 1, operationMode: "legacy", modeTransition: null, effectiveTargetMode: "legacy", outputTargets: emptyOutputs, outputConfigurationEnabled: false },
  { entityId: "station-a", planetId: "forge", planetName: "锻造星", planetNameTruncated: false, machineCount: 3, stationTier: 2, operationMode: "elevator", modeTransition: null, effectiveTargetMode: "elevator", outputTargets: emptyOutputs.map((target, index) => index === 0 ? { ...target, itemId: "iron_ingot", itemName: "铁块" } : target), outputConfigurationEnabled: true },
];

function page<Row>(rows: readonly Row[], cursor: number, limit: number): NativeSystemSpaceStationPage<Row> {
  const selected = rows.slice(cursor, cursor + limit);
  const consumed = cursor + selected.length;
  return { cursor, limit, totalCount: rows.length, nextCursor: consumed < rows.length ? consumed : null, rows: selected };
}

export function systemStationProjection(
  request: NativeSystemSpaceStationWorkspaceProjectionRequest,
  overrides: Partial<NativeSystemSpaceStationWorkspaceProjection> = {},
): NativeSystemSpaceStationWorkspaceProjection {
  return {
    schemaVersion: 1,
    projectionType: "system-space-station-workspace-v1",
    source: "native-core",
    sessionId: request.sessionId,
    runId: request.runId,
    revision: request.expectedRevision,
    registryFingerprint: request.expectedRegistryFingerprint,
    stateVersion: 47,
    limits: { requestBytes: 32_768, projectionBytes: 1_048_576, pageRows: 64, totalRows: 65_536, idBytes: 512, labelBytes: 512, decimalDigits: 256 },
    request,
    system: { systemId: request.systemId, displayName: "太阳联合工程区", displayNameTruncated: false, planetCount: 2, activePlanetId: "home", activePlanetInSystem: true, unlocked: true },
    technology: { constructionReady: true, moduleAssemblyReady: true, autonomousConstructionReady: true, orbitalBusReady: true },
    station: {
      persisted: true,
      status: "building",
      costRevision: 1,
      costMultiplierBasisPoints: 9_000,
      phaseIndex: 1,
      canStartConstruction: false,
      launcherPresent: true,
      modules: { backbone: 3, energy: 2, interstellar: 1 },
      progress: { basisPoints: 2_000, deliveredAmount: "1200000", requiredAmount: "7200000", constructionBufferAmount: "125" },
      inventoryAmount: "100000000000000000500",
    },
    hubNetwork: { fleetInstalled: 20, fleetBusy: 7, fleetReturnCount: 2, warpers: "98765432109876543210", warperTarget: "100000000000000000000" },
    summary: {
      requirementCount: requirements.length,
      inventoryItemCount: inventory.length,
      trayMaterialCount: trays.length,
      trayAvailableAmount: "1504321",
      interstellarStationCount: stations.length,
      mk1StationCount: 1,
      mk2StationCount: 1,
      elevatorStationCount: 1,
      transitioningStationCount: 0,
    },
    requirements: page(requirements, request.requirementCursor, request.requirementLimit),
    sharedInventory: page(inventory, request.inventoryCursor, request.inventoryLimit),
    trayMaterials: page(trays, request.trayCursor, request.trayLimit),
    interstellarStations: page(stations, request.stationCursor, request.stationLimit),
    ...overrides,
  };
}

function request(identity = SYSTEM_STATION_IDENTITY, selector = DEFAULT_NATIVE_SYSTEM_SPACE_STATION_SELECTOR): NativeSystemSpaceStationWorkspaceProjectionRequest {
  return {
    sessionId: identity.sessionId,
    runId: identity.runId,
    expectedRevision: identity.revision,
    expectedRegistryFingerprint: identity.registryFingerprint,
    systemId: identity.systemId,
    ...selector,
  };
}

describe("NativeSystemSpaceStationWorkspaceStore", () => {
  it("commits one bounded page set with exact authority lineage", async () => {
    const fetchProjection = vi.fn(async (input: NativeSystemSpaceStationWorkspaceProjectionRequest) => systemStationProjection(input));
    const source = createNativeSystemSpaceStationWorkspaceSource(fetchProjection, SYSTEM_STATION_IDENTITY)!;
    const store = new NativeSystemSpaceStationWorkspaceStore();
    await expect(store.refresh(source, SYSTEM_STATION_IDENTITY)).resolves.toBe("committed");
    expect(fetchProjection).toHaveBeenCalledWith(request(), expect.any(AbortSignal));
    const frame = selectNativeSystemSpaceStationWorkspaceFrame(
      store.getSnapshot(),
      SYSTEM_STATION_IDENTITY,
      DEFAULT_NATIVE_SYSTEM_SPACE_STATION_SELECTOR,
    );
    expect(frame).toMatchObject({ source: "native-core", sourceMode: "player-authority", revision: 41, systemId: "helios" });
    expect(frame?.projection.requirements.rows.map((row) => row.itemId)).toEqual(["titanium_alloy", "frame_material", "processor"]);
    expect(frame?.projection.sharedInventory.rows[0]?.amount).toBe("100000000000000000000");
    expect(store.getSnapshot()).toMatchObject({ status: "ready", requestedRevision: 41, error: null });
  });

  it("pages all four lanes independently without accumulating the full save", async () => {
    const selector = {
      requirementCursor: 1, requirementLimit: 1,
      inventoryCursor: 1, inventoryLimit: 1,
      trayCursor: 2, trayLimit: 1,
      stationCursor: 1, stationLimit: 1,
    };
    const fetchProjection = vi.fn(async (input: NativeSystemSpaceStationWorkspaceProjectionRequest) => systemStationProjection(input));
    const source = createNativeSystemSpaceStationWorkspaceSource(fetchProjection, SYSTEM_STATION_IDENTITY)!;
    const store = new NativeSystemSpaceStationWorkspaceStore();
    await expect(store.refresh(source, SYSTEM_STATION_IDENTITY, selector)).resolves.toBe("committed");
    const projection = store.getSnapshot().frame?.projection;
    expect(projection?.requirements.rows[0]?.itemId).toBe("frame_material");
    expect(projection?.sharedInventory.rows[0]?.itemId).toBe("iron_ingot");
    expect(projection?.trayMaterials.rows[0]?.planetId).toBe("forge");
    expect(projection?.interstellarStations.rows[0]?.entityId).toBe("station-a");
    expect(fetchProjection).toHaveBeenCalledWith(request(SYSTEM_STATION_IDENTITY, selector), expect.any(AbortSignal));
  });

  it("fails closed for response lineage, echoed selector, schema, and decimal drift", async () => {
    const mutations = [
      (value: NativeSystemSpaceStationWorkspaceProjection) => ({ ...value, runId: "forged-run" }),
      (value: NativeSystemSpaceStationWorkspaceProjection) => ({ ...value, request: { ...value.request, stationCursor: 1 } }),
      (value: NativeSystemSpaceStationWorkspaceProjection) => ({ ...value, unexpected: true }),
      (value: NativeSystemSpaceStationWorkspaceProjection) => ({ ...value, hubNetwork: { ...value.hubNetwork, warpers: "0007" } }),
    ];
    for (const mutate of mutations) {
      const fetchProjection = vi.fn(async (input: NativeSystemSpaceStationWorkspaceProjectionRequest) => mutate(systemStationProjection(input)));
      const source = createNativeSystemSpaceStationWorkspaceSource(fetchProjection, SYSTEM_STATION_IDENTITY)!;
      const store = new NativeSystemSpaceStationWorkspaceStore();
      await expect(store.refresh(source, SYSTEM_STATION_IDENTITY)).resolves.toBe("unavailable");
      expect(store.getSnapshot()).toMatchObject({ status: "unavailable", frame: null, error: "projection-unavailable" });
    }
  });

  it("aborts and supersedes a late response when run or revision changes", async () => {
    let resolveOld!: (value: NativeSystemSpaceStationWorkspaceProjection) => void;
    let oldSignal: AbortSignal | undefined;
    const oldFetch = vi.fn((input: NativeSystemSpaceStationWorkspaceProjectionRequest, signal?: AbortSignal) => {
      oldSignal = signal;
      return new Promise<NativeSystemSpaceStationWorkspaceProjection>((resolve) => { resolveOld = resolve; });
    });
    const oldSource = createNativeSystemSpaceStationWorkspaceSource(oldFetch, SYSTEM_STATION_IDENTITY)!;
    const nextIdentity = { ...SYSTEM_STATION_IDENTITY, runId: "station-run-next", revision: 42 };
    const nextSource = createNativeSystemSpaceStationWorkspaceSource(
      vi.fn(async (input: NativeSystemSpaceStationWorkspaceProjectionRequest) => systemStationProjection(input)),
      nextIdentity,
    )!;
    const store = new NativeSystemSpaceStationWorkspaceStore();
    const old = store.refresh(oldSource, SYSTEM_STATION_IDENTITY);
    await expect(store.refresh(nextSource, nextIdentity)).resolves.toBe("committed");
    expect(oldSignal?.aborted).toBe(true);
    resolveOld(systemStationProjection(request()));
    await expect(old).resolves.toBe("superseded");
    expect(store.getSnapshot().frame).toMatchObject({ runId: "station-run-next", revision: 42 });
  });

  it("makes an in-flight response inert when the workspace closes", async () => {
    let resolve!: (value: NativeSystemSpaceStationWorkspaceProjection) => void;
    let signal: AbortSignal | undefined;
    const source = createNativeSystemSpaceStationWorkspaceSource((input, currentSignal) => {
      signal = currentSignal;
      return new Promise((finish) => { resolve = finish as (value: NativeSystemSpaceStationWorkspaceProjection) => void; });
    }, SYSTEM_STATION_IDENTITY)!;
    const store = new NativeSystemSpaceStationWorkspaceStore();
    const pending = store.refresh(source, SYSTEM_STATION_IDENTITY);
    store.close();
    expect(signal?.aborted).toBe(true);
    resolve(systemStationProjection(request()));
    await expect(pending).resolves.toBe("superseded");
    expect(store.getSnapshot()).toEqual({ status: "empty", requestedRevision: null, requestedSelector: null, frame: null, error: null });
  });

  it("single-flights duplicate reads and notifies subscribers only on observable transitions", async () => {
    let resolve!: (value: NativeSystemSpaceStationWorkspaceProjection) => void;
    const fetchProjection = vi.fn((input: NativeSystemSpaceStationWorkspaceProjectionRequest) =>
      new Promise<NativeSystemSpaceStationWorkspaceProjection>((finish) => { resolve = finish; }));
    const source = createNativeSystemSpaceStationWorkspaceSource(fetchProjection, SYSTEM_STATION_IDENTITY)!;
    const store = new NativeSystemSpaceStationWorkspaceStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const first = store.refresh(source, SYSTEM_STATION_IDENTITY);
    const duplicate = store.refresh(source, SYSTEM_STATION_IDENTITY);
    expect(first).toBe(duplicate);
    expect(fetchProjection).toHaveBeenCalledTimes(1);
    resolve(systemStationProjection(request()));
    await expect(first).resolves.toBe("committed");
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("validates selector bounds and creates immutable lane cursor updates", () => {
    expect(validNativeSystemSpaceStationSelector(DEFAULT_NATIVE_SYSTEM_SPACE_STATION_SELECTOR)).toBe(true);
    expect(validNativeSystemSpaceStationSelector({ ...DEFAULT_NATIVE_SYSTEM_SPACE_STATION_SELECTOR, trayLimit: 65 })).toBe(false);
    expect(nativeSystemSpaceStationSelectorWithCursor(DEFAULT_NATIVE_SYSTEM_SPACE_STATION_SELECTOR, "tray", 64))
      .toEqual({ ...DEFAULT_NATIVE_SYSTEM_SPACE_STATION_SELECTOR, trayCursor: 64 });
    expect(nativeSystemSpaceStationSelectorWithCursor(DEFAULT_NATIVE_SYSTEM_SPACE_STATION_SELECTOR, "tray", -1)).toBeNull();
    expect(createNativeSystemSpaceStationWorkspaceSource(vi.fn(), { ...SYSTEM_STATION_IDENTITY, sessionId: "bad\nlineage" })).toBeNull();
  });
});
