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
  it("renders all bounded read-only sections without a GameState dependency", async () => {
    renderWorkspace();
    await settle();

    expect(host.querySelector("[data-native-system-space-station='workspace-v1']")?.getAttribute("data-native-system-space-station-status")).toBe("ready");
    expect(host.textContent).toContain("Rust 权威 · 有界只读投影");
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
