/** @vitest-environment jsdom */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  NativeSystemSpaceStationInterstellarStationRow,
  NativeSystemSpaceStationInventoryRow,
  NativeSystemSpaceStationPage,
  NativeSystemSpaceStationRequirementRow,
  NativeSystemSpaceStationTrayRow,
  NativeSystemSpaceStationWorkspaceIdentity,
  NativeSystemSpaceStationWorkspaceProjection,
  NativeSystemSpaceStationWorkspaceProjectionRequest,
} from "../game/nativeSystemSpaceStationWorkspaceStore";
import { NativeSystemSpaceStationWorkspace } from "./NativeSystemSpaceStationWorkspace";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const IDENTITY: NativeSystemSpaceStationWorkspaceIdentity = {
  sessionId: "station-session",
  runId: "station-run",
  revision: 41,
  registryFingerprint: "builtin:test",
  systemId: "helios",
};

const requirements: NativeSystemSpaceStationRequirementRow[] = Array.from({ length: 65 }, (_, index) => ({
  requirementIndex: index,
  phaseName: index < 32 ? "轨道基座" : "主体框架",
  itemId: `material_${index}`,
  itemName: `施工材料 ${index}`,
  itemNameTruncated: false,
  baseAmount: 1_000 + index,
  requiredAmount: String(10_000 + index),
  deliveredAmount: index === 0 ? "10000" : "0",
  constructionBufferAmount: "0",
  complete: index === 0,
  current: index === 1,
}));
const inventory: NativeSystemSpaceStationInventoryRow[] = Array.from({ length: 65 }, (_, index) => ({
  itemId: `item_${index}`,
  itemName: `仓库物品 ${index}`,
  itemNameTruncated: false,
  amount: index === 0 ? "100000000000000000000" : String(index),
  policy: index === 0 ? { interstellarEnabled: true, reserve: "100", target: "1000" } : null,
}));
const trays: NativeSystemSpaceStationTrayRow[] = Array.from({ length: 65 }, (_, index) => ({
  planetId: index % 2 === 0 ? "home" : "forge",
  planetName: index % 2 === 0 ? "家园星" : "锻造星",
  planetNameTruncated: false,
  activePlanet: index % 2 === 0,
  itemId: `tray_item_${index}`,
  itemName: `托盘物品 ${index}`,
  itemNameTruncated: false,
  amount: index + 1,
  constructionMaterial: index < 16,
}));
const outputs = Array.from({ length: 5 }, (_, portIndex) => ({ portIndex, itemId: null, itemName: "", itemNameTruncated: false }));
const stations: NativeSystemSpaceStationInterstellarStationRow[] = Array.from({ length: 65 }, (_, index) => ({
  entityId: `station_${index}`,
  planetId: index % 2 === 0 ? "home" : "forge",
  planetName: index % 2 === 0 ? "家园星" : "锻造星",
  planetNameTruncated: false,
  machineCount: index + 1,
  stationTier: 1,
  operationMode: "legacy",
  modeTransition: null,
  effectiveTargetMode: "legacy",
  outputTargets: outputs,
  outputConfigurationEnabled: false,
}));

function page<Row>(rows: readonly Row[], cursor: number, limit: number): NativeSystemSpaceStationPage<Row> {
  const selected = rows.slice(cursor, cursor + limit);
  const consumed = cursor + selected.length;
  return { cursor, limit, totalCount: rows.length, nextCursor: consumed < rows.length ? consumed : null, rows: selected };
}

function projection(
  request: NativeSystemSpaceStationWorkspaceProjectionRequest,
  empty = false,
): NativeSystemSpaceStationWorkspaceProjection {
  const requirementRows = empty ? [] : requirements;
  const inventoryRows = empty ? [] : inventory;
  const trayRows = empty ? [] : trays;
  const stationRows = empty ? [] : stations;
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
    system: { systemId: request.systemId, displayName: `太阳联合工程区 r${request.expectedRevision}`, displayNameTruncated: false, planetCount: 2, activePlanetId: "home", activePlanetInSystem: true, unlocked: true },
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
      inventoryAmount: empty ? "0" : "100000000000000002080",
    },
    hubNetwork: { fleetInstalled: 20, fleetBusy: 7, fleetReturnCount: 2, warpers: "98765432109876543210", warperTarget: "100000000000000000000" },
    summary: {
      requirementCount: requirementRows.length,
      inventoryItemCount: inventoryRows.length,
      trayMaterialCount: trayRows.length,
      trayAvailableAmount: empty ? "0" : "2145",
      interstellarStationCount: stationRows.length,
      mk1StationCount: stationRows.length,
      mk2StationCount: 0,
      elevatorStationCount: 0,
      transitioningStationCount: 0,
    },
    requirements: page(requirementRows, request.requirementCursor, request.requirementLimit),
    sharedInventory: page(inventoryRows, request.inventoryCursor, request.inventoryLimit),
    trayMaterials: page(trayRows, request.trayCursor, request.trayLimit),
    interstellarStations: page(stationRows, request.stationCursor, request.stationLimit),
  };
}

function startableProjection(
  request: NativeSystemSpaceStationWorkspaceProjectionRequest,
): NativeSystemSpaceStationWorkspaceProjection {
  const value = projection(request);
  return {
    ...value,
    station: {
      ...value.station,
      persisted: false,
      status: "not-started",
      phaseIndex: 0,
      canStartConstruction: true,
      progress: { basisPoints: 0, deliveredAmount: "0", requiredAmount: "7200000", constructionBufferAmount: "0" },
    },
  };
}

function operationalProjection(
  request: NativeSystemSpaceStationWorkspaceProjectionRequest,
): NativeSystemSpaceStationWorkspaceProjection {
  const value = projection(request);
  const first = value.interstellarStations.rows[0]!;
  const rows = [{
    ...first,
    stationTier: 2 as const,
    operationMode: "elevator" as const,
    effectiveTargetMode: "elevator" as const,
    outputConfigurationEnabled: true,
    outputTargets: first.outputTargets.map((target) => target.portIndex === 0
      ? { ...target, itemId: "iron_ingot", itemName: "铁块" }
      : target),
  }, ...value.interstellarStations.rows.slice(1)];
  return {
    ...value,
    station: {
      ...value.station,
      status: "operational",
      phaseIndex: 16,
      progress: { ...value.station.progress, basisPoints: 10_000, deliveredAmount: "7200000" },
    },
    summary: { ...value.summary, mk1StationCount: 64, mk2StationCount: 1, elevatorStationCount: 1 },
    interstellarStations: { ...value.interstellarStations, rows },
  };
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  document.body.innerHTML = "";
  host = document.createElement("div");
  host.dataset.testAppRoot = "true";
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function renderWorkspace(
  overrides: Partial<Parameters<typeof NativeSystemSpaceStationWorkspace>[0]> = {},
) {
  const props: Parameters<typeof NativeSystemSpaceStationWorkspace>[0] = {
    open: true,
    identity: IDENTITY,
    fetchProjection: vi.fn(async (request) => projection(request)),
    onClose: vi.fn(),
    ...overrides,
  };
  act(() => root.render(<NativeSystemSpaceStationWorkspace {...props} />));
  return props;
}

describe("NativeSystemSpaceStationWorkspace", () => {
  it("renders all bounded thin-UI sections without a GameState dependency", async () => {
    renderWorkspace();
    await settle();

    expect(host.querySelector("[data-native-system-space-station='workspace-v1']")?.getAttribute("data-native-system-space-station-status")).toBe("ready");
    expect(host.textContent).toContain("Rust 权威 · 有界投影与意图命令");
    expect(host.textContent).toContain("太阳联合工程区 r41");
    expect(host.textContent).toContain("施工材料 0");
    expect(host.textContent).toContain("100,000,000,000,000,000,000");
    expect(host.textContent).toContain("托盘物品 0");
    expect(host.textContent).toContain("家园星 · 1 座");
    expect(host.textContent).toContain("物流主干");
    expect(host.querySelectorAll("[data-native-system-space-station-section]")).toHaveLength(5);
    expect(host.querySelectorAll("[data-native-system-station-pagination]")).toHaveLength(4);
    expect(host.querySelectorAll("button:not([disabled])")).toHaveLength(6);

    const source = readFileSync(resolve(process.cwd(), "src/components/NativeSystemSpaceStationWorkspace.tsx"), "utf8");
    expect(source).not.toMatch(/import[^\n]+GameState|game\s*:\s*GameState|from\s+["']\.\.\/game\/content["']/);
  });

  it("submits start and tray delivery as bounded domain arguments", async () => {
    const onStartConstruction = vi.fn(() => true);
    renderWorkspace({
      fetchProjection: vi.fn(async (request) => startableProjection(request)),
      onStartConstruction,
    });
    await settle();
    const start = host.querySelector<HTMLButtonElement>("[data-native-system-station-command='start']")!;
    expect(start.disabled).toBe(false);
    act(() => start.click());
    expect(onStartConstruction).toHaveBeenCalledWith("helios");

    const onDeliverMaterial = vi.fn(() => true);
    const nextIdentity = { ...IDENTITY, revision: 42 };
    act(() => root.render(<NativeSystemSpaceStationWorkspace
      open
      identity={nextIdentity}
      fetchProjection={async (request) => projection(request)}
      onClose={vi.fn()}
      onDeliverMaterial={onDeliverMaterial}
    />));
    await settle();
    const deliver = host.querySelector<HTMLButtonElement>("[data-native-system-station-command='deliver']")!;
    expect(deliver.disabled).toBe(false);
    act(() => deliver.click());
    expect(onDeliverMaterial).toHaveBeenCalledWith("helios", "home", "tray_item_0", 1);
  });

  it("submits module, upgrade, mode and twice-confirmed output intents without a GameState patch", async () => {
    const onSetModuleCount = vi.fn(() => true);
    const onUpgradeStation = vi.fn(() => true);
    const onUpgradeAllStations = vi.fn(() => true);
    const onRequestMode = vi.fn(() => true);
    const onSetOutput = vi.fn(() => true);
    renderWorkspace({
      fetchProjection: vi.fn(async (request) => operationalProjection(request)),
      onSetModuleCount,
      onUpgradeStation,
      onUpgradeAllStations,
      onRequestMode,
      onSetOutput,
    });
    await settle();

    act(() => host.querySelector<HTMLButtonElement>("[data-native-system-station-command='module-backbone-increase']")!.click());
    expect(onSetModuleCount).toHaveBeenCalledWith("helios", "backbone", 4);
    act(() => host.querySelector<HTMLButtonElement>("[data-native-system-station-command='upgrade-all']")!.click());
    expect(onUpgradeAllStations).toHaveBeenCalledWith("helios");
    act(() => host.querySelector<HTMLButtonElement>("[data-native-system-station-command='upgrade-one']")!.click());
    expect(onUpgradeStation).toHaveBeenCalledWith("station_1");
    act(() => host.querySelector<HTMLButtonElement>("[data-native-system-station-command='mode-legacy']")!.click());
    expect(onRequestMode).toHaveBeenCalledWith("station_0", "legacy");

    const output = host.querySelector<HTMLInputElement>("[data-native-system-station-output='0'] input")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(output, "copper_ingot");
      output.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const submit = host.querySelector<HTMLButtonElement>("[data-native-system-station-output-submit='0']")!;
    act(() => submit.click());
    expect(onSetOutput).not.toHaveBeenCalled();
    expect(submit.textContent).toContain("再次确认");
    act(() => submit.click());
    expect(onSetOutput).toHaveBeenCalledWith("station_0", 0, "copper_ingot");

  });

  it("keeps every mutation control disabled when the durable intent bridge is unavailable", async () => {
    const onSetModuleCount = vi.fn(() => true);
    const onUpgradeStation = vi.fn(() => true);
    const onUpgradeAllStations = vi.fn(() => true);
    const onRequestMode = vi.fn(() => true);
    const onSetOutput = vi.fn(() => true);
    renderWorkspace({
      commandsAvailable: false,
      fetchProjection: vi.fn(async (request) => operationalProjection(request)),
      onSetModuleCount,
      onUpgradeStation,
      onUpgradeAllStations,
      onRequestMode,
      onSetOutput,
    });
    await settle();

    expect(host.querySelector("[data-native-system-space-station-command-unavailable]")).not.toBeNull();
    const mutationControls = host.querySelectorAll<HTMLButtonElement>(
      "[data-native-system-station-command], [data-native-system-station-output-submit]",
    );
    expect(mutationControls.length).toBeGreaterThan(0);
    expect(Array.from(mutationControls).every((button) => button.disabled)).toBe(true);

    act(() => mutationControls[0]!.click());
    expect(onSetModuleCount).not.toHaveBeenCalled();
    expect(onUpgradeStation).not.toHaveBeenCalled();
    expect(onUpgradeAllStations).not.toHaveBeenCalled();
    expect(onRequestMode).not.toHaveBeenCalled();
    expect(onSetOutput).not.toHaveBeenCalled();
  });

  it("moves each page lane independently and preserves the other three cursors", async () => {
    const fetchProjection = vi.fn(async (request: NativeSystemSpaceStationWorkspaceProjectionRequest) => projection(request));
    renderWorkspace({ fetchProjection });
    await settle();

    for (const lane of ["requirement", "inventory", "tray", "station"] as const) {
      const next = host.querySelector<HTMLButtonElement>(`[data-native-system-station-page='${lane}:next']`)!;
      expect(next.disabled).toBe(false);
      act(() => next.click());
      await settle();
    }
    const last = fetchProjection.mock.calls.at(-1)?.[0];
    expect(last).toMatchObject({ requirementCursor: 64, inventoryCursor: 64, trayCursor: 64, stationCursor: 64 });
    expect(host.textContent).toContain("施工材料 64");
    expect(host.textContent).toContain("仓库物品 64");
    expect(host.textContent).toContain("托盘物品 64");
    expect(host.textContent).toContain("家园星 · 65 座");
    expect(host.textContent).not.toContain("施工材料 0");
  });

  it("keeps the verified DOM and page cursors read-only across a normal revision refresh", async () => {
    let finishNext!: () => void;
    const fetchProjection = vi.fn((request: NativeSystemSpaceStationWorkspaceProjectionRequest) => {
      if (request.expectedRevision === 41) return Promise.resolve(projection(request));
      return new Promise<NativeSystemSpaceStationWorkspaceProjection>((resolve) => {
        finishNext = () => resolve(projection(request));
      });
    });
    renderWorkspace({ fetchProjection });
    await settle();
    act(() => host.querySelector<HTMLButtonElement>(
      "[data-native-system-station-page='requirement:next']",
    )!.click());
    await settle();
    expect(host.textContent).toContain("施工材料 64");
    const overview = host.querySelector("[data-native-system-space-station-overview]");
    expect(overview).not.toBeNull();

    const nextIdentity = { ...IDENTITY, revision: 42 };
    act(() => root.render(<NativeSystemSpaceStationWorkspace
      open
      identity={nextIdentity}
      fetchProjection={fetchProjection}
      onClose={vi.fn()}
      onSetModuleCount={vi.fn(() => true)}
      onUpgradeStation={vi.fn(() => true)}
      onUpgradeAllStations={vi.fn(() => true)}
      onRequestMode={vi.fn(() => true)}
      onSetOutput={vi.fn(() => true)}
    />));
    await settle();

    expect(fetchProjection.mock.calls.at(-1)?.[0]).toMatchObject({
      expectedRevision: 42,
      requirementCursor: 64,
    });
    expect(host.querySelector("[data-native-system-space-station-overview]")).toBe(overview);
    expect(host.textContent).toContain("施工材料 64");
    expect(host.querySelector("[data-native-system-space-station='workspace-v1']")
      ?.getAttribute("data-native-system-space-station-status")).toBe("loading");
    expect(Array.from(host.querySelectorAll<HTMLButtonElement>(
      "[data-native-system-station-command], [data-native-system-station-output-submit], [data-native-system-station-pagination] button",
    )).every((button) => button.disabled)).toBe(true);

    finishNext();
    await settle();
    expect(host.textContent).toContain("太阳联合工程区 r42");
    expect(host.textContent).toContain("施工材料 64");
    expect(host.querySelector("[data-native-system-space-station='workspace-v1']")
      ?.getAttribute("data-native-system-space-station-status")).toBe("ready");
  });

  it("shows a fail-closed error and retries from the same lineage", async () => {
    const fetchProjection = vi.fn()
      .mockRejectedValueOnce(new Error("host unavailable"))
      .mockImplementation(async (request: NativeSystemSpaceStationWorkspaceProjectionRequest) => projection(request));
    renderWorkspace({ fetchProjection });
    await settle();
    expect(host.querySelector("[data-native-system-space-station-error]")).not.toBeNull();
    expect(host.textContent).toContain("不会回退读取 JavaScript GameState");

    const retry = Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.includes("重新读取"))!;
    act(() => retry.click());
    await settle();
    expect(fetchProjection).toHaveBeenCalledTimes(2);
    expect(host.querySelector("[data-native-system-space-station-overview]")).not.toBeNull();
  });

  it("renders explicit empty states for all four valid zero-row pages", async () => {
    renderWorkspace({ fetchProjection: vi.fn(async (request) => projection(request, true)) });
    await settle();
    expect(host.querySelectorAll("[data-native-system-station-empty]")).toHaveLength(4);
    expect(host.textContent).toContain("当前页没有施工材料");
    expect(host.textContent).toContain("共享仓库当前为空");
    expect(host.textContent).toContain("当前页没有行星托盘物料");
    expect(host.textContent).toContain("当前恒星系没有星际物流站");
  });

  it("keeps a late old-run response out after a new authority identity renders", async () => {
    let resolveOld!: (value: NativeSystemSpaceStationWorkspaceProjection) => void;
    const oldFetch = vi.fn((request: NativeSystemSpaceStationWorkspaceProjectionRequest) =>
      new Promise<NativeSystemSpaceStationWorkspaceProjection>((resolve) => { resolveOld = resolve; }));
    const onClose = vi.fn();
    renderWorkspace({ fetchProjection: oldFetch, onClose });
    await settle();
    const nextIdentity = { ...IDENTITY, runId: "station-run-next", revision: 42 };
    const nextFetch = vi.fn(async (request: NativeSystemSpaceStationWorkspaceProjectionRequest) => projection(request));
    act(() => root.render(<NativeSystemSpaceStationWorkspace open identity={nextIdentity} fetchProjection={nextFetch} onClose={onClose} />));
    await settle();
    expect(host.textContent).toContain("太阳联合工程区 r42");
    resolveOld(projection({
      sessionId: IDENTITY.sessionId,
      runId: IDENTITY.runId,
      expectedRevision: IDENTITY.revision,
      expectedRegistryFingerprint: IDENTITY.registryFingerprint,
      systemId: IDENTITY.systemId,
      requirementCursor: 0, requirementLimit: 64, inventoryCursor: 0, inventoryLimit: 64,
      trayCursor: 0, trayLimit: 64, stationCursor: 0, stationLimit: 64,
    }));
    await settle();
    expect(host.textContent).toContain("太阳联合工程区 r42");
    expect(host.textContent).not.toContain("太阳联合工程区 r41");
  });

  it("aborts pending work and requests close on Escape", async () => {
    let signal: AbortSignal | undefined;
    const fetchProjection = vi.fn((_request: NativeSystemSpaceStationWorkspaceProjectionRequest, current?: AbortSignal) => {
      signal = current;
      return new Promise(() => undefined);
    });
    const onClose = vi.fn();
    renderWorkspace({ fetchProjection, onClose });
    await settle();
    expect(signal?.aborted).toBe(false);
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(true);
  });
});
