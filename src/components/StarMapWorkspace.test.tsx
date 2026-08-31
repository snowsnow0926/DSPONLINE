/** @vitest-environment jsdom */

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialState } from "../game/engine";
import type { NativeStarMapWorkspaceReadModel, NativeStellarQuantumReadModel } from "../game/nativeStellarWorkspaceStore";
import type { NativeStarMapCatalogFrame } from "../game/nativeStarMapCatalogStore";
import type { GameState, PlanetIndustryRole } from "../game/types";
import { AppLocaleProvider } from "../i18n/locale";
import { clearStableTextDraft } from "./CompositionSafeInput";
import {
  NativeIndustryConsole,
  NativeQuantumInventoryConsole,
  NativeStarMapCatalogConsole,
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
  targetBuildingId: "interstellar_logistics_station",
  targetBuildingLabel: "星际物流站",
  targetSlotIndex: 1,
  targetSlotIsPrimary: true,
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

const QUANTUM_ITEM = Object.freeze({
  itemId: "iron_ore",
  inventory: "120000",
  capacity: "100000",
  uploaded: "300",
  downloaded: "100",
});

const QUANTUM_COLLECTOR = Object.freeze({
  collectorId: "native-collector",
  planetId: "home",
  systemId: "helios",
  machineCount: 8,
  quantumMode: "quantum",
  quantumTransitionActive: false,
  attachmentState: "connected",
}) as NativeStellarQuantumReadModel["collectors"][number];

const QUANTUM_READ_MODEL: NativeStellarQuantumReadModel = Object.freeze({
  source: "native-core",
  sourceMode: "player-authority",
  sessionId: "authority-session",
  revision: 9,
  registryFingerprint: "registry-fingerprint",
  enabled: true,
  bandwidth: {
    multiplier: 2,
    globalUploadPerMinute: 1000,
    globalDownloadPerMinute: 800,
    activeTowerCount: 2,
    activeTowerStacks: 20,
  },
  runtime: {
    boundarySecond: 55,
    globalUploadPerMinute: 300,
    globalDownloadPerMinute: 100,
    quantumTowerStacks: 20,
    quantumCollectorStacks: 8,
  },
  collectorSummary: {
    totalCount: 1,
    connectedCount: 1,
    pendingCount: 0,
    availableCount: 0,
    connectedStacks: 8,
  },
  items: Object.freeze([QUANTUM_ITEM]),
  collectors: Object.freeze([QUANTUM_COLLECTOR]),
  itemRowsById: new Map([[QUANTUM_ITEM.itemId, QUANTUM_ITEM]]),
  collectorRowsById: new Map([[QUANTUM_COLLECTOR.collectorId, QUANTUM_COLLECTOR]]),
  collectorRowsBySystemId: new Map([[QUANTUM_COLLECTOR.systemId, Object.freeze([QUANTUM_COLLECTOR])]]),
});

const CATALOG_SYSTEM = Object.freeze({
  systemId: "helios",
  displayName: "原生太阳系",
  displayNameTruncated: false,
  starClassId: "g",
  starTypeName: "G 型主序星",
  starTypeNameTruncated: false,
  positionX: 0,
  positionY: 0,
  distanceFromOriginLy: 0,
  luminosity: 1,
  massMultiplier: 1,
  radiusMultiplier: 1,
  active: true,
  discovered: true,
  missionActive: false,
  missionElapsedSeconds: 0,
  missionDurationSeconds: 0,
  surveyProgress: 1,
  firstPlanetId: "home",
  planetCount: 1,
  colonizedPlanetCount: 1,
}) as NativeStarMapCatalogFrame["systems"][number];

const CATALOG_PLANET = Object.freeze({
  planetId: "home",
  displayName: "原生蓝色家园",
  displayNameTruncated: false,
  systemId: "helios",
  systemDisplayName: "原生太阳系",
  systemDisplayNameTruncated: false,
  kind: "terrestrial",
  orbitIndex: 0,
  simulationOrder: 0,
  systemPositionX: 0,
  systemPositionY: 0,
  active: true,
  discovered: true,
  colonized: true,
  industryRole: "manufacturing",
  entityCount: 4,
  deviceCount: 3,
  beltCount: 2,
  metadata: {
    note: "原生备注",
    noteTruncated: false,
    tags: { totalCount: 1, truncated: false, rows: ["科研"] },
  },
  profile: {
    climateName: "海洋生态",
    climateNameTruncated: false,
    oceanType: "water",
    specialization: "balanced",
    specializationName: "综合工业",
    specializationNameTruncated: false,
    tidalLocked: false,
    sulfuricOcean: false,
    windMultiplier: 1,
    solarMultiplier: 1,
    geothermalMultiplier: 1,
    miningMultiplier: 1,
    orbitalYieldMultiplier: 1,
    reserveScale: 1,
    travelTimeMultiplier: 1,
    productionSpeedMultiplier: 1,
    surveyDurationSeconds: 30,
    resourceIds: { totalCount: 1, truncated: false, rows: ["iron_ore"] },
    rareResourceIds: { totalCount: 0, truncated: false, rows: [] },
    orbitalYields: { totalCount: 0, truncated: false, rows: [] },
  },
}) as NativeStarMapCatalogFrame["planets"][number];

const STAR_MAP_CATALOG_FRAME = Object.freeze({
  source: "native-core",
  sourceMode: "player-authority",
  sessionId: "authority-session",
  revision: 9,
  registryFingerprint: "registry-fingerprint",
  activePlanetId: "home",
  activeSystemId: "helios",
  galaxySeed: 42,
  summary: { systemCount: 1, unlockedSystemCount: 1, planetCount: 1, colonizedPlanetCount: 1 },
  metadataTruncated: false,
  projection: {} as NativeStarMapCatalogFrame["projection"],
  systems: Object.freeze([CATALOG_SYSTEM]),
  planets: Object.freeze([CATALOG_PLANET]),
  systemRowsById: new Map([[CATALOG_SYSTEM.systemId, CATALOG_SYSTEM]]),
  planetRowsById: new Map([[CATALOG_PLANET.planetId, CATALOG_PLANET]]),
  planetRowsBySystemId: new Map([[CATALOG_SYSTEM.systemId, Object.freeze([CATALOG_PLANET])]]),
}) as NativeStarMapCatalogFrame;

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
    const onNativeStationMinimumLoadChange = vi.fn(() => true);
    const onNativeStationRoutePolicyChange = vi.fn(() => true);
    const onNativeStationWarperBudgetChange = vi.fn(() => true);
    const onNativeStationLimitsChange = vi.fn(() => true);
    const props = renderWorkspace({
      game,
      nativeReadModel: READ_MODEL,
      nativeAuthorityRequired: true,
      onNativeRoleChange,
      onNativeStationPriorityChange,
      onNativeStationMinimumLoadChange,
      onNativeStationRoutePolicyChange,
      onNativeStationWarperBudgetChange,
      onNativeStationLimitsChange,
      onRoleChange,
      onStationPriorityChange,
      onStationMinimumLoadChange,
      onStationLimitsChange,
    });
    clickButton("星际工业");

    const role = host.querySelector<HTMLSelectElement>("[aria-label='原生家园工业角色']")!;
    const travel = host.querySelector<HTMLButtonElement>(".stellar-planet-row > button")!;
    const priority = host.querySelector<HTMLSelectElement>("[aria-label='原生铁矿航线航线优先级']")!;
    const minimumLoad = host.querySelector<HTMLSelectElement>("[aria-label='原生铁矿航线最低装载率']")!;
    const routePolicy = host.querySelector<HTMLSelectElement>("[aria-label='原生铁矿航线星际路线策略']")!;
    const warperBudget = host.querySelector<HTMLSelectElement>("[aria-label='原生铁矿航线翘曲器预算']")!;
    const sourceLimit = host.querySelector<HTMLInputElement>("[aria-label='原生铁矿航线出口保底库存']")!;
    const targetLimit = host.querySelector<HTMLInputElement>("[aria-label='原生铁矿航线进口库存上限']")!;
    expect(host.textContent).toContain("权威命令");
    expect(host.textContent).toContain("投影绑定");
    for (const control of [role, priority, minimumLoad, routePolicy, warperBudget, sourceLimit, targetLimit]) {
      expect(control.disabled).toBe(false);
      expect(control.getAttribute("aria-describedby")).toBe("native-stellar-command-boundary");
    }
    expect(travel.disabled).toBe(true);
    expect(travel.title).toContain("行星切换命令尚未接入");

    act(() => {
      priority.value = "0";
      priority.dispatchEvent(new Event("change", { bubbles: true }));
      role.value = "mining" satisfies PlanetIndustryRole;
      role.dispatchEvent(new Event("change", { bubbles: true }));
      minimumLoad.value = "0.1";
      minimumLoad.dispatchEvent(new Event("change", { bubbles: true }));
      routePolicy.value = "relay-required";
      routePolicy.dispatchEvent(new Event("change", { bubbles: true }));
      warperBudget.value = "4";
      warperBudget.dispatchEvent(new Event("change", { bubbles: true }));
      inputValue(sourceLimit, "0");
      inputValue(targetLimit, "0");
    });

    expect(onNativeStationPriorityChange).toHaveBeenCalledWith(9, TARGET_STATION.stationId, 1, 2, 0);
    expect(onNativeStationMinimumLoadChange).toHaveBeenCalledWith(9, TARGET_STATION.stationId, 1, 0.5, 0.1, true);
    expect(onNativeStationRoutePolicyChange).toHaveBeenCalledWith(9, TARGET_STATION.stationId, 1, "direct", "relay-required");
    expect(onNativeStationWarperBudgetChange).toHaveBeenCalledWith(9, TARGET_STATION.stationId, 1, 2, 4);
    expect(onNativeRoleChange).toHaveBeenCalledWith(9, "home", "manufacturing", "mining");
    expect(onNativeStationLimitsChange).toHaveBeenCalledWith(9, SOURCE_STATION.stationId, 0, 50, 500, 0, 500);
    expect(onNativeStationLimitsChange).toHaveBeenCalledWith(9, TARGET_STATION.stationId, 1, 10, 200, 10, 0);

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
    expect(onNativeStationPriorityChange).toHaveBeenLastCalledWith(10, TARGET_STATION.stationId, 1, 0, 2);

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

describe("NativeQuantumInventoryConsole", () => {
  it("renders inventory, flow, bandwidth, and collector counts only from the native read model", () => {
    act(() => root.render(<AppLocaleProvider><NativeQuantumInventoryConsole
      readModel={QUANTUM_READ_MODEL}
      status="ready"
    /></AppLocaleProvider>));

    expect(host.textContent).toContain("Rust 权威共享物资池");
    expect(host.textContent).toContain("铁矿");
    expect(host.textContent).toContain("精确 120,000");
    expect(host.textContent).toContain("上传 300");
    expect(host.textContent).toContain("下载 100");
    expect(host.textContent).toContain("超出上限，仅允许下载");
    expect(host.textContent).toContain("最近结算 55 秒");
    expect(host.querySelector("[data-native-quantum-read-status='ready']")).not.toBeNull();
    expect(host.querySelector<HTMLButtonElement>("[aria-label='铁矿石容量预设'] button")?.disabled).toBe(true);
  });

  it("binds capacity edits to the current projected capacity and fails closed without a frame", () => {
    const onNativeItemCapacityChange = vi.fn(() => true);
    act(() => root.render(<AppLocaleProvider><NativeQuantumInventoryConsole
      readModel={QUANTUM_READ_MODEL}
      status="ready"
      onNativeItemCapacityChange={onNativeItemCapacityChange}
    /></AppLocaleProvider>));
    const preset = Array.from(host.querySelectorAll<HTMLButtonElement>("[aria-label='铁矿石容量预设'] button"))
      .find((button) => button.textContent === "1亿")!;
    act(() => preset.click());
    expect(onNativeItemCapacityChange).toHaveBeenCalledWith(9, "iron_ore", "100000", "100000000");

    act(() => root.render(<AppLocaleProvider><NativeQuantumInventoryConsole
      readModel={null}
      status="loading"
    /></AppLocaleProvider>));
    expect(host.textContent).toContain("正在同步原生权威量子库存");
    expect(host.textContent).not.toContain("精确 120000");
  });
});

describe("NativeStarMapCatalogConsole", () => {
  it("renders searchable systems, planets, metadata, resources, and traits from the native frame", () => {
    const onQueryChange = vi.fn();
    const onOpenSystemSpaceStation = vi.fn();
    act(() => root.render(<AppLocaleProvider><NativeStarMapCatalogConsole
      frame={STAR_MAP_CATALOG_FRAME}
      status="ready"
      query=""
      onQueryChange={onQueryChange}
      onOpenSystemSpaceStation={onOpenSystemSpaceStation}
    /></AppLocaleProvider>));

    expect(host.textContent).toContain("原生太阳系");
    expect(host.textContent).toContain("原生蓝色家园");
    expect(host.textContent).toContain("原生备注");
    expect(host.textContent).toContain("#科研");
    expect(host.textContent).toContain("铁矿石");
    expect(host.textContent).toContain("星图资料只读");
    expect(host.querySelector("[data-native-star-map-catalog-status='ready']")).not.toBeNull();
    expect(host.querySelector<HTMLButtonElement>(".star-planet-list > button")?.disabled).toBe(true);
    const stationEntry = host.querySelector<HTMLButtonElement>("[data-native-system-space-station-entry='helios']")!;
    expect(stationEntry.disabled).toBe(false);
    act(() => stationEntry.click());
    expect(onOpenSystemSpaceStation).toHaveBeenCalledWith("helios");
  });

  it("fails closed without a complete same-revision catalog frame", () => {
    act(() => root.render(<AppLocaleProvider><NativeStarMapCatalogConsole
      frame={null}
      status="loading"
      query=""
      onQueryChange={vi.fn()}
    /></AppLocaleProvider>));
    expect(host.textContent).toContain("正在同步原生权威星图目录");
    expect(host.querySelector("[data-native-star-map-catalog-status='loading']")).not.toBeNull();
    expect(host.querySelector(".star-system-card")).toBeNull();
  });
});

describe("StarMapWorkspace authority boundaries", () => {
  it("fails closed without a catalog even when a scoped industry model exists", () => {
    renderWorkspace({
      game: playerAuthorityPoisonGame(),
      nativeReadModel: READ_MODEL,
      nativeAuthorityRequired: true,
      industryReadRequest: { systemId: "helios", planetId: "home", routeFilter: "issues", query: "铁" },
    });

    expect(host.textContent).toContain("原生权威星图目录暂不可用");
    clickButton("星际工业");
    expect(host.textContent).toContain("原生铁矿航线");
    clickButton("星图探索");

    expect(host.textContent).toContain("不会读取或显示 JavaScript 存档中的旧星图数据");
    expect(host.querySelector(".star-system-card")).toBeNull();
    expect(host.querySelector(".star-planet-list")).toBeNull();
    expect(host.querySelector("[aria-label='搜索星球资料']")).toBeNull();
    expect(host.querySelector(".stellar-metadata-manager")).toBeNull();
    expect(host.querySelector("[aria-label='星图批量物流操作']")).toBeNull();
  });

  it("uses the independent native catalog instead of scoped industry rows", () => {
    renderWorkspace({
      game: playerAuthorityPoisonGame(),
      nativeReadModel: READ_MODEL,
      nativeMapCatalogFrame: STAR_MAP_CATALOG_FRAME,
      nativeAuthorityRequired: true,
      industryReadRequest: { systemId: "helios", planetId: "home", routeFilter: "issues", query: "铁" },
    });

    expect(host.textContent).toContain("原生太阳系");
    expect(host.textContent).toContain("原生蓝色家园");
    expect(host.textContent).toContain("已勘探 1/1");
    expect(host.querySelector("[aria-label='搜索原生星球资料']")).not.toBeNull();
    expect(host.querySelector(".stellar-metadata-manager")).toBeNull();
    expect(host.querySelector("[aria-label='星图批量物流操作']")).toBeNull();
  });

  it("shows the native Quantum projection without reading the renderer GameState", () => {
    renderWorkspace({
      game: playerAuthorityPoisonGame(),
      nativeReadModel: READ_MODEL,
      nativeQuantumReadModel: QUANTUM_READ_MODEL,
      nativeAuthorityRequired: true,
    });
    clickButton("量子库存");

    expect(host.textContent).toContain("Rust 权威共享物资池");
    expect(host.textContent).toContain("精确 120,000");
    expect(host.textContent).not.toContain("原生权威量子库存暂不可用");
  });

  it("fails the native Quantum console closed and keeps GameState-backed actions unavailable without a frame", () => {
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
    expect(host.querySelector("[data-native-quantum-read-status='unavailable']")).not.toBeNull();
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

    expect(host.textContent).toContain("原生权威星图目录暂不可用");
    clickButton("星际工业");
    expect(host.textContent).toContain("原生铁矿航线");
    clickButton("量子库存");
    expect(host.textContent).toContain("原生权威量子库存暂不可用");

    act(() => root.render(<AppLocaleProvider><StarMapWorkspace {...props} mobileSubview="planet:frost" /></AppLocaleProvider>));
    expect(host.textContent).toContain("原生权威星图目录暂不可用");
    expect(host.querySelector(".mobile-planet-detail")).toBeNull();
    expect(host.querySelector(".mobile-star-system-detail")).toBeNull();
  });

  it("preserves editable map, quantum, and industry surfaces for web/legacy mode", () => {
    const onRoleChange = vi.fn();
    renderWorkspace({ onRoleChange });

    expect(host.querySelector("[aria-label='搜索星球资料']")).not.toBeNull();
    expect(host.querySelector(".stellar-metadata-manager")).not.toBeNull();
    expect(host.textContent).not.toContain("原生权威星图目录暂不可用");
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
