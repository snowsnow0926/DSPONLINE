/** @vitest-environment jsdom */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeDysonWorkspaceFrame } from "../game/nativeDysonWorkspaceStore";
import { NativeDysonPlannerWorkspace } from "./DysonPlannerWorkspace";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const engineering: NativeDysonWorkspaceFrame["systems"][number]["engineering"] = {
  launchMode: "balanced",
  launchThrottle: 0.5,
  launchEnabled: true,
  orbitCount: 1,
  orbitSails: 120,
  queuedSails: 40,
  queuedRockets: 12,
  sailLaunchesPerMinute: 60,
  rocketLaunchesPerMinute: 6,
  launchEnergyPerSailMj: 21.6,
  launchEnergyPerRocketMj: 108,
  launchEnergyPerMinuteMj: 2_592,
  rayGenerationKw: 12_000,
  receiverCapacityKw: 20_000,
  operationalReceiverCapacityKw: 20_000,
  receiverLoadKw: 10_000,
  theoreticalReceptionRate: 0.8,
  receiverUtilization: 0.5,
  dysonPowerUtilization: 0.25,
  configuredReceiverCount: 10,
  blockedReceiverCount: 1,
  criticalPhotonPerMinute: 30,
  antimatterPerMinute: 15,
  feedbackGenerationKw: 4_000,
  plannedStructurePoints: 150,
  completedStructurePoints: 120,
  remainingStructurePoints: 30,
  shellCapacity: 500,
  shellSails: 200,
  projectedGenerationKw: 40_000,
};

const selectedSystem: NativeDysonWorkspaceFrame["systems"][number] = {
  systemId: "helios",
  displayName: "原生赫利俄斯",
  displayNameTruncated: false,
  starProfile: {
    available: true,
    starTypeName: "G 型主序星",
    starTypeNameTruncated: false,
    luminosity: 1.25,
    radiusMultiplier: 1.1,
  },
  unlocked: true,
  active: true,
  activeLayerId: "layer:main",
  activeOrbitId: "orbit:primary",
  structurePoints: 120,
  shellSails: 200,
  totals: {
    layerCount: 1,
    nodeCount: 3,
    frameCount: 3,
    shellCount: 1,
    plannedStructurePoints: 150,
    completedStructurePoints: 120,
    sailCapacity: 500,
    absorbedSails: 200,
  },
  orbitCount: 1,
  orbitSails: 120,
  projectedGenerationKw: 40_000,
  engineering,
};

const modSystem: NativeDysonWorkspaceFrame["systems"][number] = {
  ...selectedSystem,
  systemId: "mod:system/Ω🚀",
  displayName: "",
  starProfile: {
    available: false,
    starTypeName: "",
    starTypeNameTruncated: false,
    luminosity: 2,
    radiusMultiplier: 1.5,
  },
  unlocked: false,
  active: false,
  activeLayerId: null,
  activeOrbitId: null,
  structurePoints: 0,
  shellSails: 0,
  totals: {
    layerCount: 0,
    nodeCount: 0,
    frameCount: 0,
    shellCount: 0,
    plannedStructurePoints: 0,
    completedStructurePoints: 0,
    sailCapacity: 0,
    absorbedSails: 0,
  },
  orbitCount: 0,
  orbitSails: 0,
  projectedGenerationKw: 0,
  engineering: { ...engineering, orbitCount: 0, orbitSails: 0 },
};

const layer: NativeDysonWorkspaceFrame["layers"][number] = {
  layerId: "layer:main",
  name: "原生主壳层",
  nameTruncated: false,
  radius: 20_000,
  inclination: 15,
  longitude: 45,
  structureAllocationFloor: 10,
  shellAllocationFloor: 20,
  nodeCount: 3,
  frameCount: 3,
  shellCount: 1,
  plannedStructurePoints: 150,
  completedStructurePoints: 120,
  sailCapacity: 500,
  absorbedSails: 200,
};

const orbit: NativeDysonWorkspaceFrame["orbits"][number] = {
  orbitId: "orbit:primary",
  name: "原生太阳帆轨道",
  nameTruncated: false,
  radius: 25_000,
  inclination: 20,
  longitude: 30,
  sailsInOrbit: 120,
  totalLaunched: 150,
  totalExpired: 30,
  decayProgress: 0.5,
  generationKw: 5_000,
};

const nodes: NativeDysonWorkspaceFrame["nodes"] = Object.freeze([
  { layerId: layer.layerId, nodeId: "node:alpha", angle: 0, requiredStructurePoints: 40, completedStructurePoints: 40 },
  { layerId: layer.layerId, nodeId: "node:beta", angle: 120, requiredStructurePoints: 40, completedStructurePoints: 40 },
  { layerId: layer.layerId, nodeId: "node:gamma", angle: 240, requiredStructurePoints: 40, completedStructurePoints: 20 },
]);

const frames: NativeDysonWorkspaceFrame["frames"] = Object.freeze([
  { layerId: layer.layerId, frameId: "frame:alpha-beta", sourceNodeId: "node:alpha", targetNodeId: "node:beta", requiredStructurePoints: 10, completedStructurePoints: 10 },
  { layerId: layer.layerId, frameId: "frame:beta-gamma", sourceNodeId: "node:beta", targetNodeId: "node:gamma", requiredStructurePoints: 10, completedStructurePoints: 5 },
  { layerId: layer.layerId, frameId: "frame:gamma-alpha", sourceNodeId: "node:gamma", targetNodeId: "node:alpha", requiredStructurePoints: 10, completedStructurePoints: 5 },
]);

const shells: NativeDysonWorkspaceFrame["shells"] = Object.freeze([
  { layerId: layer.layerId, shellId: "shell:alpha-beta", sourceNodeId: "node:alpha", targetNodeId: "node:beta", boundaryFrameCount: 3, active: true, sailCapacity: 500, absorbedSails: 200 },
]);

function page<T>(rows: readonly T[]) {
  return { cursor: 0, limit: 8, totalCount: rows.length, nextCursor: null, rows: [...rows] };
}

const systems = Object.freeze([selectedSystem, modSystem]);
const layers = Object.freeze([layer]);
const orbits = Object.freeze([orbit]);
const projection: NativeDysonWorkspaceFrame["projection"] = {
  schemaVersion: 1,
  projectionType: "dyson-workspace-v1",
  revision: 17,
  registryFingerprint: "builtin:test",
  stateVersion: 47,
  limits: { requestBytes: 32768, projectionBytes: 1048576, pageRows: 64, totalRows: 65536, idBytes: 1024, labelBytes: 512 },
  request: {
    expectedRevision: 17,
    expectedRegistryFingerprint: "builtin:test",
    selectedSystemId: "helios",
    systemCursor: 0,
    systemLimit: 8,
    layerCursor: 0,
    layerLimit: 8,
    orbitCursor: 0,
    orbitLimit: 8,
    nodeCursor: 0,
    nodeLimit: 8,
    frameCursor: 0,
    frameLimit: 8,
    shellCursor: 0,
    shellLimit: 8,
  },
  activePlanetId: "home",
  activeSystemId: "helios",
  selectedSystemId: "helios",
  technology: { programReady: true, shellReady: true, swarmReady: true },
  global: {
    sphere: { structurePoints: 120, totalRocketsLaunched: 144, shellSails: 200, totalSailsAbsorbed: 200, generationKw: 35_000 },
    swarm: { sailsInOrbit: 120, totalLaunched: 150, totalExpired: 30, generationKw: 5_000, receiverLoadKw: 10_000 },
    launch: { mode: "balanced", throttle: 0.5, enabled: true, energySpentMj: 9_999 },
  },
  summary: { systemCount: 2, unlockedSystemCount: 1, layerCount: 1, orbitCount: 1, nodeCount: 3, frameCount: 3, shellCount: 1 },
  selectedSystem,
  systems: page(systems),
  layers: page(layers),
  orbits: page(orbits),
  nodes: page(nodes),
  frames: page(frames),
  shells: page(shells),
};

const FRAME: NativeDysonWorkspaceFrame = Object.freeze({
  source: "native-core",
  sourceMode: "player-authority",
  sessionId: "native-dyson-session",
  runId: "native-dyson-run",
  revision: 17,
  registryFingerprint: "builtin:test",
  selectedSystemId: "helios",
  projection,
  systems,
  layers,
  orbits,
  nodes,
  frames,
  shells,
  systemsById: new Map(systems.map((system) => [system.systemId, system])),
  layersById: new Map([[layer.layerId, layer]]),
  orbitsById: new Map([[orbit.orbitId, orbit]]),
  nodesByLayerId: new Map([[layer.layerId, nodes]]),
  framesByLayerId: new Map([[layer.layerId, frames]]),
  shellsByLayerId: new Map([[layer.layerId, shells]]),
});

function frameAtRevision(revision: number): NativeDysonWorkspaceFrame {
  return {
    ...FRAME,
    revision,
    projection: {
      ...FRAME.projection,
      revision,
      request: { ...FRAME.projection.request, expectedRevision: revision },
    },
  };
}

function frameWithAlternativeTargets(): NativeDysonWorkspaceFrame {
  const alternateLayer = {
    ...layer,
    layerId: "layer:secondary",
    name: "原生第二壳层",
    nodeCount: 0,
    frameCount: 0,
    shellCount: 0,
    plannedStructurePoints: 0,
    completedStructurePoints: 0,
    sailCapacity: 0,
    absorbedSails: 0,
  } satisfies NativeDysonWorkspaceFrame["layers"][number];
  const alternateOrbit = {
    ...orbit,
    orbitId: "orbit:secondary",
    name: "原生第二太阳帆轨道",
    radius: 30_000,
    inclination: -10,
    longitude: 90,
    sailsInOrbit: 0,
    totalLaunched: 0,
    totalExpired: 0,
    decayProgress: 0,
    generationKw: 0,
  } satisfies NativeDysonWorkspaceFrame["orbits"][number];
  const selectedSystemWithAlternatives = {
    ...selectedSystem,
    totals: { ...selectedSystem.totals, layerCount: 2 },
    orbitCount: 2,
  } satisfies NativeDysonWorkspaceFrame["systems"][number];
  const systemsWithAlternatives = Object.freeze([selectedSystemWithAlternatives, modSystem]);
  const layersWithAlternatives = Object.freeze([layer, alternateLayer]);
  const orbitsWithAlternatives = Object.freeze([orbit, alternateOrbit]);
  const projectionWithAlternatives: NativeDysonWorkspaceFrame["projection"] = {
    ...projection,
    summary: { ...projection.summary, layerCount: 2, orbitCount: 2 },
    selectedSystem: selectedSystemWithAlternatives,
    systems: page(systemsWithAlternatives),
    layers: page(layersWithAlternatives),
    orbits: page(orbitsWithAlternatives),
  };
  return {
    ...FRAME,
    projection: projectionWithAlternatives,
    systems: systemsWithAlternatives,
    layers: layersWithAlternatives,
    orbits: orbitsWithAlternatives,
    systemsById: new Map(systemsWithAlternatives.map((system) => [system.systemId, system])),
    layersById: new Map(layersWithAlternatives.map((candidate) => [candidate.layerId, candidate])),
    orbitsById: new Map(orbitsWithAlternatives.map((candidate) => [candidate.orbitId, candidate])),
    nodesByLayerId: new Map([[layer.layerId, nodes], [alternateLayer.layerId, Object.freeze([])]]),
    framesByLayerId: new Map([[layer.layerId, frames], [alternateLayer.layerId, Object.freeze([])]]),
    shellsByLayerId: new Map([[layer.layerId, shells], [alternateLayer.layerId, Object.freeze([])]]),
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

function renderNative(overrides: Partial<Parameters<typeof NativeDysonPlannerWorkspace>[0]> = {}) {
  const props: Parameters<typeof NativeDysonPlannerWorkspace>[0] = {
    frame: FRAME,
    status: "ready",
    selectedSystemId: "helios",
    pending: false,
    onSelectSystem: vi.fn(),
    onSelectLayer: vi.fn(),
    onSelectOrbit: vi.fn(),
    onOrbitChange: vi.fn(),
    onLaunchModeChange: vi.fn(),
    onLaunchThrottleChange: vi.fn(),
    onLaunchEnabledChange: vi.fn(),
    onAddLayer: vi.fn(),
    onLayerChange: vi.fn(),
    onRemoveLayer: vi.fn(),
    onAddNode: vi.fn(),
    onRemoveNode: vi.fn(),
    onConnectNodes: vi.fn(),
    onAddOrbit: vi.fn(),
    onRemoveOrbit: vi.fn(),
    onAutoConnect: vi.fn(),
    onPlanShell: vi.fn(),
    onClearShell: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  act(() => root.render(<NativeDysonPlannerWorkspace {...props} />));
  return props;
}

describe("NativeDysonPlannerWorkspace", () => {
  it("renders the complete native Dyson summary and bounded structure details", () => {
    renderNative();

    expect(host.querySelector("[data-native-dyson-read-status='ready']")).not.toBeNull();
    expect(host.textContent).toContain("Rust 玩家权威");
    expect(host.textContent).toContain("原生赫利俄斯");
    expect(host.textContent).toContain("原生主壳层");
    expect(host.textContent).toContain("原生太阳帆轨道");
    expect(host.textContent).toContain("累计火箭");
    expect(host.textContent).toContain("吸附帆");
    expect(host.textContent).toContain("节点 node:alpha");
    expect(host.textContent).toContain("框架 frame:alpha-beta");
    expect(host.textContent).toContain("壳面 shell:alpha-beta");
    expect(host.querySelector("[data-native-dyson-node-id='node:alpha']")).not.toBeNull();
    expect(host.querySelector("[data-native-dyson-frame-id='frame:alpha-beta']")).not.toBeNull();
    expect(host.querySelector("[data-native-dyson-shell-id='shell:alpha-beta']")).not.toBeNull();
  });

  it("routes launch, orbit lifecycle, layer lifecycle, and shell-plan controls through native callbacks", () => {
    const onSelectSystem = vi.fn();
    const onSelectLayer = vi.fn();
    const onSelectOrbit = vi.fn();
    const onOrbitChange = vi.fn();
    const onLaunchModeChange = vi.fn();
    const onLaunchThrottleChange = vi.fn();
    const onLaunchEnabledChange = vi.fn();
    const onAddLayer = vi.fn();
    const onLayerChange = vi.fn();
    const onRemoveLayer = vi.fn();
    const onAddOrbit = vi.fn();
    const onRemoveOrbit = vi.fn();
    const onPlanShell = vi.fn();
    const onClearShell = vi.fn();
    const onClose = vi.fn();
    renderNative({
      frame: frameWithAlternativeTargets(),
      onSelectSystem,
      onSelectLayer,
      onSelectOrbit,
      onOrbitChange,
      onLaunchModeChange,
      onLaunchThrottleChange,
      onLaunchEnabledChange,
      onAddLayer,
      onLayerChange,
      onRemoveLayer,
      onAddOrbit,
      onRemoveOrbit,
      onPlanShell,
      onClearShell,
      onClose,
    });

    const modButton = Array.from(host.querySelectorAll<HTMLButtonElement>("[data-native-dyson-system-id]"))
      .find((button) => button.dataset.nativeDysonSystemId === "mod:system/Ω🚀")!;
    expect(modButton.disabled).toBe(false);
    expect(host.textContent).toContain("mod:system/Ω🚀");
    expect(host.textContent).toContain("未知 / MOD 恒星");
    act(() => modButton.click());
    expect(onSelectSystem).toHaveBeenCalledWith("mod:system/Ω🚀");

    const launchEnabled = host.querySelector<HTMLButtonElement>("[data-native-dyson-action='launch-enabled']")!;
    const launchSphere = host.querySelector<HTMLButtonElement>("[data-native-dyson-action='launch-mode-sphere']")!;
    const launchQuarter = host.querySelector<HTMLButtonElement>("[data-native-dyson-action='launch-throttle-0.25']")!;
    expect(launchEnabled.disabled).toBe(false);
    expect(launchSphere.disabled).toBe(false);
    expect(launchQuarter.disabled).toBe(false);
    act(() => launchEnabled.click());
    act(() => launchSphere.click());
    act(() => launchQuarter.click());
    expect(onLaunchEnabledChange).toHaveBeenCalledWith(false);
    expect(onLaunchModeChange).toHaveBeenCalledWith("sphere");
    expect(onLaunchThrottleChange).toHaveBeenCalledWith(0.25);

    const selectableLayer = Array.from(host.querySelectorAll<HTMLButtonElement>("[data-native-dyson-action='select-layer']"))
      .find((button) => !button.disabled)!;
    const selectableOrbit = Array.from(host.querySelectorAll<HTMLButtonElement>("[data-native-dyson-action='select-orbit']"))
      .find((button) => !button.disabled)!;
    expect(selectableLayer.textContent).toContain("原生第二壳层");
    expect(selectableOrbit.textContent).toContain("原生第二太阳帆轨道");
    act(() => selectableLayer.click());
    act(() => selectableOrbit.click());
    expect(onSelectLayer).toHaveBeenCalledWith("layer:secondary");
    expect(onSelectOrbit).toHaveBeenCalledWith("orbit:secondary");

    const radius = host.querySelector<HTMLInputElement>("[data-native-dyson-action='orbit-radius']")!;
    const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setInputValue.call(radius, "30000");
      radius.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onOrbitChange).toHaveBeenCalledWith("orbit:primary", { radius: 30_000 });

    const layerRadius = host.querySelector<HTMLInputElement>("[data-native-dyson-action='layer-radius']")!;
    act(() => {
      setInputValue.call(layerRadius, "35000");
      layerRadius.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onLayerChange).toHaveBeenCalledWith("layer:main", { radius: 35_000 });

    const addLayer = host.querySelector<HTMLButtonElement>("[data-native-dyson-action='add-layer']")!;
    const addStandardLayer = host.querySelector<HTMLButtonElement>("[data-native-dyson-action='add-standard-layer']")!;
    const addOrbit = host.querySelector<HTMLButtonElement>("[data-native-dyson-action='add-orbit']")!;
    const removeLayer = host.querySelector<HTMLButtonElement>("[data-native-dyson-action='remove-layer']")!;
    const removeOrbit = host.querySelector<HTMLButtonElement>("[data-native-dyson-action='remove-orbit']")!;
    for (const control of [addLayer, addStandardLayer, addOrbit, removeLayer, removeOrbit]) {
      expect(control.disabled).toBe(false);
    }
    act(() => addLayer.click());
    act(() => addStandardLayer.click());
    act(() => addOrbit.click());
    act(() => removeLayer.click());
    act(() => removeOrbit.click());
    expect(onAddLayer).toHaveBeenNthCalledWith(1, false);
    expect(onAddLayer).toHaveBeenNthCalledWith(2, true);
    expect(onAddOrbit).toHaveBeenCalledTimes(1);
    expect(onRemoveLayer).toHaveBeenCalledWith("layer:main");
    expect(onRemoveOrbit).toHaveBeenCalledWith("orbit:primary");

    const planShell = host.querySelector<HTMLButtonElement>("[data-native-dyson-action='plan-shell']")!;
    const clearShell = host.querySelector<HTMLButtonElement>("[data-native-dyson-action='clear-shell']")!;
    const autoConnect = host.querySelector<HTMLButtonElement>("[data-native-dyson-action='connect-frames']")!;
    expect(autoConnect.disabled).toBe(true);
    expect(planShell.disabled).toBe(false);
    expect(clearShell.disabled).toBe(false);
    act(() => planShell.click());
    act(() => clearShell.click());
    expect(onPlanShell).toHaveBeenCalledWith("layer:main");
    expect(onClearShell).toHaveBeenCalledWith("layer:main");

    expect(host.querySelector<HTMLButtonElement>("[data-native-dyson-action='design']")?.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>("[data-native-dyson-action='save']")?.disabled).toBe(true);

    act(() => host.querySelector<HTMLButtonElement>("[aria-label='关闭戴森球规划']")!.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("enables Rust auto-connect only when a ring frame is missing", () => {
    const emptyFrames = Object.freeze([]) as NativeDysonWorkspaceFrame["frames"];
    const selected = {
      ...selectedSystem,
      totals: { ...selectedSystem.totals, frameCount: 0 },
    };
    const systemsWithoutFrames = Object.freeze([selected, modSystem]);
    const onAutoConnect = vi.fn();
    renderNative({
      frame: {
        ...FRAME,
        projection: { ...projection, selectedSystem: selected },
        systems: systemsWithoutFrames,
        frames: emptyFrames,
        systemsById: new Map(systemsWithoutFrames.map((system) => [system.systemId, system])),
        framesByLayerId: new Map([[layer.layerId, emptyFrames]]),
      },
      onAutoConnect,
    });
    const autoConnect = host.querySelector<HTMLButtonElement>("[data-native-dyson-action='connect-frames']")!;
    expect(autoConnect.disabled).toBe(false);
    act(() => autoConnect.click());
    expect(onAutoConnect).toHaveBeenCalledWith("layer:main");
  });

  it("adds, selects, connects, and removes nodes through compact native callbacks", () => {
    const onAddNode = vi.fn();
    const onRemoveNode = vi.fn();
    const onConnectNodes = vi.fn();
    renderNative({ onAddNode, onRemoveNode, onConnectNodes });

    const alpha = host.querySelector<SVGCircleElement>("[data-native-dyson-node-id='node:alpha']")!;
    const beta = host.querySelector<SVGCircleElement>("[data-native-dyson-node-id='node:beta']")!;
    act(() => alpha.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(host.querySelector("[data-native-dyson-selected-node-id='node:alpha']")).not.toBeNull();
    act(() => host.querySelector<HTMLButtonElement>("[data-native-dyson-action='remove-node']")!.click());
    expect(onRemoveNode).toHaveBeenCalledWith("layer:main", "node:alpha");

    act(() => alpha.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    act(() => beta.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onConnectNodes).toHaveBeenCalledWith("layer:main", "node:alpha", "node:beta");

    const canvas = host.querySelector<SVGSVGElement>("[data-native-dyson-action='add-node-canvas']")!;
    canvas.getBoundingClientRect = vi.fn(() => ({
      x: 0, y: 0, left: 0, top: 0, right: 600, bottom: 600, width: 600, height: 600,
      toJSON: () => ({}),
    }));
    act(() => canvas.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      clientX: 600,
      clientY: 300,
    })));
    expect(onAddNode).toHaveBeenCalledWith("layer:main", 90);
  });

  it("locks native projected controls while a command is pending", () => {
    renderNative({ pending: true });

    const projectedControls = host.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
      "[data-native-dyson-action^='launch-'], [data-native-dyson-action='select-layer'], [data-native-dyson-action='select-orbit'], [data-native-dyson-action^='orbit-'], [data-native-dyson-action='connect-frames'], [data-native-dyson-action='plan-shell'], [data-native-dyson-action='clear-shell']",
    );
    expect(projectedControls.length).toBeGreaterThan(6);
    for (const control of projectedControls) expect(control.disabled).toBe(true);
  });

  it("does not render the retained old frame while a new revision is loading", () => {
    renderNative({ status: "loading" });

    expect(host.querySelector("[data-native-dyson-read-status='loading']")).not.toBeNull();
    expect(host.textContent).toContain("正在同步原生权威戴森球投影");
    expect(host.textContent).not.toContain("原生赫利俄斯");
    expect(host.querySelector("[data-native-dyson-node-id]")).toBeNull();
  });

  it("keeps a verified same-scope frame mounted during revision refresh and locks every authority command", () => {
    const props = renderNative();
    const systemButton = host.querySelector<HTMLButtonElement>("[data-native-dyson-system-id='helios']")!;
    act(() => systemButton.focus());

    const revision18 = {
      sessionId: "native-dyson-session",
      runId: "native-dyson-run",
      revision: 18,
      registryFingerprint: "builtin:test",
      selectedSystemId: "helios",
    } as const;
    renderNative({ ...props, frame: null, status: "loading", latestIdentity: revision18 });

    expect(host.querySelector<HTMLButtonElement>("[data-native-dyson-system-id='helios']")).toBe(systemButton);
    expect(document.activeElement).toBe(systemButton);
    expect(host.querySelector("[data-native-dyson-read-status='loading'][data-native-dyson-display-stale='true']")).not.toBeNull();
    expect(host.textContent).toContain("正在读取 Rust revision 18");
    expect(host.textContent).toContain("已验证的 revision 17；全部权威写入已锁定");
    const authorityControls = host.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
      "[data-native-dyson-action^='launch-'], [data-native-dyson-action='select-layer'], [data-native-dyson-action='select-orbit'], [data-native-dyson-action^='orbit-'], [data-native-dyson-action^='layer-'], [data-native-dyson-action='add-layer'], [data-native-dyson-action='add-standard-layer'], [data-native-dyson-action='add-orbit'], [data-native-dyson-action='remove-layer'], [data-native-dyson-action='remove-orbit'], [data-native-dyson-action='connect-frames'], [data-native-dyson-action='plan-shell'], [data-native-dyson-action='clear-shell']",
    );
    expect(authorityControls.length).toBeGreaterThan(6);
    for (const control of authorityControls) expect(control.disabled).toBe(true);
    act(() => host.querySelector<HTMLButtonElement>("[data-native-dyson-action='launch-enabled']")!.click());
    expect(props.onLaunchEnabledChange).not.toHaveBeenCalled();

    renderNative({ ...props, frame: frameAtRevision(18), status: "ready", latestIdentity: revision18 });
    expect(host.querySelector<HTMLButtonElement>("[data-native-dyson-system-id='helios']")).toBe(systemButton);
    expect(document.activeElement).toBe(systemButton);
    expect(host.querySelector("[data-native-dyson-revision='18'][data-native-dyson-read-status='ready']")).not.toBeNull();
    expect(host.querySelector<HTMLButtonElement>("[data-native-dyson-action='launch-enabled']")?.disabled).toBe(false);

    renderNative({
      ...props,
      frame: null,
      status: "loading",
      selectedSystemId: "mod:system/Ω🚀",
      latestIdentity: { ...revision18, revision: 19, selectedSystemId: "mod:system/Ω🚀" },
    });
    expect(host.textContent).not.toContain("原生主壳层");
    expect(host.querySelector("[data-native-dyson-node-id]")).toBeNull();

    renderNative({ ...props, frame: frameAtRevision(18), status: "ready", latestIdentity: revision18 });
    renderNative({ ...props, frame: null, status: "unavailable", latestIdentity: revision18 });
    expect(host.textContent).not.toContain("原生主壳层");
    expect(host.textContent).toContain("不会读取或显示 JavaScript 存档中的旧戴森数据");
  });

  it.each(["empty", "unavailable"] as const)("fails %s closed without legacy Dyson data", (status) => {
    renderNative({ frame: null, status, selectedSystemId: null });

    expect(host.querySelector(`[data-native-dyson-read-status='${status}']`)).not.toBeNull();
    expect(host.textContent).toContain("原生权威戴森球投影暂不可用");
    expect(host.textContent).toContain("不会读取或显示 JavaScript 存档中的旧戴森数据");
    expect(host.querySelector(".dyson-system-tabs")).toBeNull();
  });

  it("rejects a ready frame whose selected-system identity does not match", () => {
    renderNative({ status: "ready", selectedSystemId: "mod:system/Ω🚀" });

    expect(host.querySelector("[data-native-dyson-read-status='unavailable']")).not.toBeNull();
    expect(host.textContent).not.toContain("原生主壳层");
  });

  it("keeps the native component implementation detached from GameState and engine helpers", () => {
    const source = readFileSync(resolve("src/components/DysonPlannerWorkspace.tsx"), "utf8");
    const nativeBoundary = source.slice(source.indexOf("export type NativeDysonWorkspaceReadStatus"));

    expect(nativeBoundary).not.toMatch(/\bGameState\b|\bgame\.|getDysonEngineeringSnapshot|isTechnologyCompleted|createDysonLayerTemplate|getDysonPlanTotals|getStarSystemProfile|getStarSystem\(/);
    expect(nativeBoundary).toMatch(/onOrbitChange|onAddLayer|onAddOrbit/);
    expect(nativeBoundary).not.toMatch(/onSave|onAddSwarmOrbit|commitGame|publishRuntimeGame/);
  });
});
