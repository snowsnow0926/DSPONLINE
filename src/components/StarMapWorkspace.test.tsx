/** @vitest-environment jsdom */

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialState } from "../game/engine";
import type { NativeStarMapWorkspaceReadModel } from "../game/nativeStellarWorkspaceStore";
import type { GameState, PlanetIndustryRole } from "../game/types";
import { AppLocaleProvider } from "../i18n/locale";
import { clearStableTextDraft } from "./CompositionSafeInput";
import {
  NativeIndustryConsole,
  StarMapWorkspace,
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
    onFocusStation={vi.fn()}
  />));
}

type WorkspaceProps = ComponentProps<typeof StarMapWorkspace>;

function createWorkspaceProps(overrides: Partial<WorkspaceProps> = {}): WorkspaceProps {
  return {
    open: true,
    game: createInitialState(),
    nativeReadModel: null,
    nativeReadStatus: "ready",
    nativeAuthorityRequired: false,
    industryReadRequest: SELECTOR,
    onIndustryReadRequest: vi.fn(),
    onClose: vi.fn(),
    onExplore: vi.fn(),
    onColonize: vi.fn(),
    onTravel: vi.fn(() => true),
    onRoleChange: vi.fn(),
    onPlanetMetadataChange: vi.fn(),
    onSystemNameChange: vi.fn(),
    onStationPriorityChange: vi.fn(),
    onStationMinimumLoadChange: vi.fn(),
    onStationLimitsChange: vi.fn(),
    onFocusStation: vi.fn(),
    onUpgradeAllStations: vi.fn(async () => null),
    onAttachAllQuantumStations: vi.fn(async () => null),
    onCollectorQuantumModeChange: vi.fn(async () => null),
    onQuantumItemCapacityChange: vi.fn(),
    ...overrides,
  };
}

function renderWorkspace(overrides: Partial<WorkspaceProps> = {}): WorkspaceProps {
  const props = createWorkspaceProps(overrides);
  act(() => root.render(<AppLocaleProvider><StarMapWorkspace {...props} /></AppLocaleProvider>));
  return props;
}

function clickButton(label: string): void {
  const button = Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
    .find((candidate) => candidate.textContent?.includes(label));
  if (!button) throw new Error(`missing button: ${label}`);
  act(() => button.click());
}

function playerAuthorityPoisonGame(): GameState {
  const game = createInitialState();
  return new Proxy(game, {
    get(_target, property) {
      throw new Error(`player-authority workspace read GameState.${String(property)}`);
    },
  });
}

beforeEach(() => {
  window.localStorage.clear();
  clearStableTextDraft("stellar-route-search");
  clearStableTextDraft("star-map-search");
  clearStableTextDraft("quantum-inventory-search");
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

  it("submits projection-bound native configuration across 2→0→2 and native-only station IDs", () => {
    const game = createInitialState();
    expect(game.entities.some((entity) => entity.id === TARGET_STATION.stationId)).toBe(false);
    const onRoleChange = vi.fn();
    const onStationPriorityChange = vi.fn();
    const onStationMinimumLoadChange = vi.fn();
    const onStationLimitsChange = vi.fn();
    const onNativeRoleChange = vi.fn(() => true);
    const onNativeStationPriorityChange = vi.fn(() => true);
    const onNativeStationLimitsChange = vi.fn(() => true);
    const props = renderWorkspace({
      game,
      nativeReadModel: READ_MODEL,
      nativeAuthorityRequired: true,
      onNativeRoleChange,
      onNativeStationPriorityChange,
      onNativeStationLimitsChange,
      onRoleChange,
      onStationPriorityChange,
      onStationMinimumLoadChange,
      onStationLimitsChange,
    });
    clickButton("星际工业");

    const role = host.querySelector<HTMLSelectElement>("[aria-label='原生家园工业角色']")!;
    const priority = host.querySelector<HTMLSelectElement>("[aria-label='原生铁矿航线航线优先级']")!;
    const minimumLoad = host.querySelector<HTMLSelectElement>("[aria-label='原生铁矿航线最低装载率']")!;
    const sourceLimit = host.querySelector<HTMLInputElement>("[aria-label='原生铁矿航线出口保底库存']")!;
    const targetLimit = host.querySelector<HTMLInputElement>("[aria-label='原生铁矿航线进口库存上限']")!;
    expect(host.textContent).toContain("权威命令");
    expect(host.textContent).toContain("装载率暂只读");
    for (const control of [role, priority, sourceLimit, targetLimit]) {
      expect(control.disabled).toBe(false);
      expect(control.getAttribute("aria-describedby")).toBe("native-stellar-command-boundary");
    }
    expect(minimumLoad.disabled).toBe(true);
    expect(minimumLoad.getAttribute("aria-describedby")).toBe("native-stellar-command-boundary");

    act(() => {
      priority.value = "0";
      priority.dispatchEvent(new Event("change", { bubbles: true }));
      role.value = "mining" satisfies PlanetIndustryRole;
      role.dispatchEvent(new Event("change", { bubbles: true }));
      minimumLoad.value = "0.1";
      minimumLoad.dispatchEvent(new Event("change", { bubbles: true }));
      inputValue(sourceLimit, "0");
      inputValue(targetLimit, "0");
    });

    expect(onNativeStationPriorityChange).toHaveBeenCalledWith(TARGET_STATION.stationId, 1, 2, 0);
    expect(onNativeRoleChange).toHaveBeenCalledWith("home", "manufacturing", "mining");
    expect(onNativeStationLimitsChange).toHaveBeenCalledWith(SOURCE_STATION.stationId, 0, 50, 500, 0, 500);
    expect(onNativeStationLimitsChange).toHaveBeenCalledWith(TARGET_STATION.stationId, 1, 10, 200, 10, 0);

    const priorityZeroRoute = Object.freeze({ ...ROUTE, priority: 0 }) as typeof ROUTE;
    const priorityZeroModel = Object.freeze({
      ...READ_MODEL,
      revision: READ_MODEL.revision + 1,
      routes: Object.freeze([priorityZeroRoute]),
      routeRowsById: new Map([[priorityZeroRoute.id, priorityZeroRoute]]),
      routeRowsByTargetStationId: new Map([[TARGET_STATION.stationId, Object.freeze([priorityZeroRoute])]]),
    }) as NativeStarMapWorkspaceReadModel;
    act(() => root.render(<AppLocaleProvider><StarMapWorkspace {...props} nativeReadModel={priorityZeroModel} /></AppLocaleProvider>));
    const refreshedPriority = host.querySelector<HTMLSelectElement>("[aria-label='原生铁矿航线航线优先级']")!;
    act(() => {
      refreshedPriority.value = "2";
      refreshedPriority.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onNativeStationPriorityChange).toHaveBeenLastCalledWith(TARGET_STATION.stationId, 1, 0, 2);

    expect(onRoleChange).not.toHaveBeenCalled();
    expect(onStationPriorityChange).not.toHaveBeenCalled();
    expect(onStationMinimumLoadChange).not.toHaveBeenCalled();
    expect(onStationLimitsChange).not.toHaveBeenCalled();
  });

  it("fails closed when projection-bound native command callbacks are unavailable", () => {
    renderWorkspace({
      game: playerAuthorityPoisonGame(),
      nativeReadModel: READ_MODEL,
      nativeAuthorityRequired: true,
    });
    clickButton("星际工业");

    for (const control of host.querySelectorAll<HTMLSelectElement | HTMLInputElement>(
      "[aria-describedby='native-stellar-command-boundary']",
    )) {
      expect(control.disabled).toBe(true);
    }
  });
});

describe("StarMapWorkspace authority boundaries", () => {
  it("fails closed when a scoped industry model returns to the map", () => {
    renderWorkspace({
      game: playerAuthorityPoisonGame(),
      nativeReadModel: READ_MODEL,
      nativeAuthorityRequired: true,
      industryReadRequest: { systemId: "helios", planetId: "home", routeFilter: "issues", query: "铁" },
    });

    expect(host.textContent).toContain("原生权威星图探索暂不可用");
    clickButton("星际工业");
    expect(host.textContent).toContain("原生铁矿航线");
    clickButton("星图探索");

    expect(host.textContent).toContain("为避免把当前筛选范围外的行星缺失解释成未殖民或 0");
    expect(host.querySelector(".star-system-card")).toBeNull();
    expect(host.querySelector(".star-planet-list")).toBeNull();
    expect(host.querySelector("[aria-label='搜索星球资料']")).toBeNull();
    expect(host.querySelector(".stellar-metadata-manager")).toBeNull();
    expect(host.querySelector("[aria-label='星图批量物流操作']")).toBeNull();
  });

  it("keeps quantum inventory and all GameState-backed actions unavailable in player authority", () => {
    const onCollectorQuantumModeChange = vi.fn(async () => null);
    const onQuantumItemCapacityChange = vi.fn();
    renderWorkspace({
      game: playerAuthorityPoisonGame(),
      nativeReadModel: READ_MODEL,
      nativeAuthorityRequired: true,
      onCollectorQuantumModeChange,
      onQuantumItemCapacityChange,
    });
    clickButton("量子库存");

    expect(host.textContent).toContain("原生权威量子库存暂不可用");
    expect(host.querySelector(".quantum-inventory-console")).toBeNull();
    expect(host.querySelector("[aria-label='搜索量子库存物品']")).toBeNull();
    expect(onCollectorQuantumModeChange).not.toHaveBeenCalled();
    expect(onQuantumItemCapacityChange).not.toHaveBeenCalled();
  });

  it("keeps the mobile authority tabs navigable without opening GameState-backed details", () => {
    const props = renderWorkspace({
      game: playerAuthorityPoisonGame(),
      nativeReadModel: READ_MODEL,
      nativeAuthorityRequired: true,
      industryReadRequest: { systemId: "helios", planetId: "home", routeFilter: "all", query: "" },
      mobile: true,
    });

    expect(host.textContent).toContain("原生权威星图探索暂不可用");
    clickButton("星际工业");
    expect(host.textContent).toContain("原生铁矿航线");
    clickButton("量子库存");
    expect(host.textContent).toContain("原生权威量子库存暂不可用");

    act(() => root.render(<AppLocaleProvider><StarMapWorkspace {...props} mobileSubview="planet:frost" /></AppLocaleProvider>));
    expect(host.textContent).toContain("原生权威星图探索暂不可用");
    expect(host.querySelector(".mobile-planet-detail")).toBeNull();
    expect(host.querySelector(".mobile-star-system-detail")).toBeNull();
  });

  it("preserves editable map, quantum, and industry surfaces for web/legacy mode", () => {
    const onRoleChange = vi.fn();
    renderWorkspace({ onRoleChange });

    expect(host.querySelector("[aria-label='搜索星球资料']")).not.toBeNull();
    expect(host.querySelector(".stellar-metadata-manager")).not.toBeNull();
    expect(host.textContent).not.toContain("原生权威星图探索暂不可用");
    clickButton("量子库存");
    expect(host.querySelector(".quantum-inventory-console")).not.toBeNull();
    expect(host.querySelector("[aria-label='搜索量子库存物品']")).not.toBeNull();
    clickButton("星际工业");

    const role = host.querySelector<HTMLSelectElement>("select[aria-label$='工业角色']")!;
    expect(role.disabled).toBe(false);
    const nextRole: PlanetIndustryRole = role.value === "mining" ? "manufacturing" : "mining";
    act(() => {
      role.value = nextRole;
      role.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onRoleChange).toHaveBeenCalledWith(expect.any(String), nextRole);
  });
});
