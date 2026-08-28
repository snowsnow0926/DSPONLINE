/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeStarMapWorkspaceReadModel } from "../game/nativeStellarWorkspaceStore";
import { clearStableTextDraft } from "./CompositionSafeInput";
import {
  NativeIndustryConsole,
  type StarMapIndustryReadRequest,
  type StarMapNativeReadStatus,
} from "./StarMapWorkspace";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SELECTOR: StarMapIndustryReadRequest = Object.freeze({
  systemId: null,
  planetId: null,
  routeFilter: "all",
  query: "",
});

const SYSTEM = {
  systemId: "helios",
  displayName: "原生赫利俄斯",
  starTypeName: "G 型主序星",
  luminosity: 1,
  deviceCount: 9,
  routeCount: 1,
  stationCount: 2,
  activeRouteCount: 1,
  generationKw: 20,
  demandKw: 10,
  powerFactor: 1,
} as NativeStarMapWorkspaceReadModel["systems"][number];

const PLANET = {
  planetId: "home",
  displayName: "原生家园",
  systemId: "helios",
  colonized: true,
  industryRole: "manufacturing",
  deviceCount: 9,
  stationCount: 2,
  configuredImportSlotCount: 1,
  configuredExportSlotCount: 1,
  congestedStationId: null,
  power: { generationKw: 20, demandKw: 10, powerFactor: 1, totalItemsPerMinute: 120 },
  profile: { climateName: "海洋生态" },
} as NativeStarMapWorkspaceReadModel["planets"][number];

const SOURCE_STATION = {
  stationId: "station-source",
  buildingLabel: "原生供应站",
  planetId: "home",
  congestion: 0,
} as NativeStarMapWorkspaceReadModel["stations"][number];

const TARGET_STATION = {
  stationId: "station-target",
  buildingLabel: "原生需求站",
  planetId: "home",
  congestion: 0,
} as NativeStarMapWorkspaceReadModel["stations"][number];

const ROUTE = {
  id: "native-route-1",
  scope: "remote",
  itemId: "iron_ore",
  itemLabel: "原生铁矿航线",
  sourceStationId: SOURCE_STATION.stationId,
  sourceStationLabel: "原生供应站",
  sourceBuildingLabel: "星际物流站",
  sourceSlotIndex: 0,
  sourcePlanetId: "home",
  targetStationId: TARGET_STATION.stationId,
  targetStationLabel: "原生需求站",
  targetBuildingLabel: "星际物流站",
  targetSlotIndex: 1,
  targetPlanetId: "home",
  distanceLy: 4.2,
  routePathLabel: "供应站 → 需求站",
  dispatchDirection: "supply-delivery",
  maxLegDistanceLy: 4.2,
  durationSeconds: 12,
  throughputPerMinute: 300,
  energyMjPerTrip: 2,
  warpersPerTrip: 1,
  routePolicy: "direct",
  warperBudget: 2,
  priority: 2,
  minimumLoad: 0.5,
  sourceSlotMinStock: 50,
  sourceSlotMaxStock: 500,
  targetSlotMinStock: 10,
  targetSlotMaxStock: 200,
  status: "active",
  statusLabel: "运行中",
} as NativeStarMapWorkspaceReadModel["routes"][number];

const READ_MODEL: NativeStarMapWorkspaceReadModel = Object.freeze({
  source: "native-core",
  sourceMode: "player-authority",
  sessionId: "authority-session",
  revision: 9,
  registryFingerprint: "registry-fingerprint",
  activePlanetId: "home",
  activeSystemId: "helios",
  galaxySeed: 42,
  summary: {
    systemCount: 1,
    unlockedSystemCount: 1,
    planetCount: 1,
    colonizedPlanetCount: 1,
    stationCount: 2,
  },
  routeSummary: {
    scopeTotalCount: 1,
    filteredCount: 1,
    activeCount: 1,
    blockedCount: 0,
    remoteCount: 1,
    routePlanningIncompleteCount: 0,
    powerUnprovenCount: 0,
    statusCounts: { active: 1 },
  },
  systems: Object.freeze([SYSTEM]),
  planets: Object.freeze([PLANET]),
  stations: Object.freeze([SOURCE_STATION, TARGET_STATION]),
  routes: Object.freeze([ROUTE]),
  systemRowsById: new Map([[SYSTEM.systemId, SYSTEM]]),
  planetRowsById: new Map([[PLANET.planetId, PLANET]]),
  stationRowsById: new Map([
    [SOURCE_STATION.stationId, SOURCE_STATION],
    [TARGET_STATION.stationId, TARGET_STATION],
  ]),
  routeRowsById: new Map([[ROUTE.id, ROUTE]]),
  routeRowsByTargetStationId: new Map([[TARGET_STATION.stationId, Object.freeze([ROUTE])]]),
});

let host: HTMLDivElement;
let root: Root;

function inputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function renderConsole({
  readModel = READ_MODEL,
  status = "ready",
  selector = SELECTOR,
  onSelectorChange = vi.fn<(selector: StarMapIndustryReadRequest) => void>(),
}: {
  readModel?: NativeStarMapWorkspaceReadModel | null;
  status?: StarMapNativeReadStatus;
  selector?: StarMapIndustryReadRequest;
  onSelectorChange?: (selector: StarMapIndustryReadRequest) => void;
} = {}) {
  act(() => root.render(<NativeIndustryConsole
    readModel={readModel}
    status={status}
    selector={selector}
    onSelectorChange={onSelectorChange}
    onTravel={vi.fn(() => true)}
    onRoleChange={vi.fn()}
    onStationPriorityChange={vi.fn()}
    onStationMinimumLoadChange={vi.fn()}
    onStationLimitsChange={vi.fn()}
    onFocusStation={vi.fn()}
  />));
}

beforeEach(() => {
  clearStableTextDraft("stellar-route-search");
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("NativeIndustryConsole", () => {
  it("renders the complete native read model and indexed route rows", () => {
    renderConsole();

    expect(host.textContent).toContain("原生赫利俄斯");
    expect(host.textContent).toContain("原生家园");
    expect(host.textContent).toContain("原生铁矿航线");
    expect(host.textContent).toContain("1/1");
    expect(host.querySelector("[data-native-stellar-read-status='ready']")).not.toBeNull();
  });

  it("fails closed without hiding the controls needed to request another selector", () => {
    renderConsole({ readModel: null, status: "loading" });

    expect(host.textContent).toContain("正在同步原生权威星际工业投影");
    expect(host.textContent).not.toContain("原生铁矿航线");
    expect(host.querySelector("[aria-label='星际工业恒星系筛选']")).not.toBeNull();
    expect(host.querySelector("[aria-label='星际工业行星筛选']")).not.toBeNull();
    expect(host.querySelector("[aria-label='搜索全局航线']")).not.toBeNull();
  });

  it("emits system, planet, filter, and UTF-8 bounded query requests on demand", () => {
    const onSelectorChange = vi.fn<(selector: StarMapIndustryReadRequest) => void>();
    renderConsole({ onSelectorChange });
    const systemSelect = host.querySelector<HTMLSelectElement>("[aria-label='星际工业恒星系筛选']")!;
    const planetSelect = host.querySelector<HTMLSelectElement>("[aria-label='星际工业行星筛选']")!;
    const issueButton = Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.startsWith("问题"))!;
    const queryInput = host.querySelector<HTMLInputElement>("[aria-label='搜索全局航线']")!;

    act(() => {
      systemSelect.value = "helios";
      systemSelect.dispatchEvent(new Event("change", { bubbles: true }));
      planetSelect.value = "home";
      planetSelect.dispatchEvent(new Event("change", { bubbles: true }));
      issueButton.click();
      inputValue(queryInput, "界".repeat(300));
    });

    expect(onSelectorChange).toHaveBeenCalledWith(expect.objectContaining({ systemId: "helios", planetId: null }));
    expect(onSelectorChange).toHaveBeenCalledWith(expect.objectContaining({ systemId: "helios", planetId: "home" }));
    expect(onSelectorChange).toHaveBeenCalledWith(expect.objectContaining({ routeFilter: "issues" }));
    const queryRequest = onSelectorChange.mock.calls.find(([request]) => request.query)?.[0] as StarMapIndustryReadRequest;
    expect(new TextEncoder().encode(queryRequest.query).byteLength).toBeLessThanOrEqual(512);
    expect(queryRequest.query.length).toBeGreaterThan(0);
  });
});
