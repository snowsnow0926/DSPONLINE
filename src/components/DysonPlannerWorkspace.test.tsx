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
    onLaunchModeChange: vi.fn(),
    onLaunchThrottleChange: vi.fn(),
    onLaunchEnabledChange: vi.fn(),
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

  it("routes launch controls through native callbacks while structural edits stay disabled", () => {
    const onSelectSystem = vi.fn();
    const onLaunchModeChange = vi.fn();
    const onLaunchThrottleChange = vi.fn();
    const onLaunchEnabledChange = vi.fn();
    const onClose = vi.fn();
    renderNative({
      onSelectSystem,
      onLaunchModeChange,
      onLaunchThrottleChange,
      onLaunchEnabledChange,
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

    const structuralControls = host.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
      "[data-native-dyson-action]:not([data-native-dyson-action^='launch-'])",
    );
    expect(structuralControls.length).toBeGreaterThan(5);
    for (const control of structuralControls) expect(control.disabled).toBe(true);

    act(() => host.querySelector<HTMLButtonElement>("[aria-label='关闭戴森球规划']")!.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("locks native launch controls while a command is pending", () => {
    renderNative({ pending: true });

    const launchControls = host.querySelectorAll<HTMLButtonElement>("[data-native-dyson-action^='launch-']");
    expect(launchControls.length).toBeGreaterThan(3);
    for (const control of launchControls) expect(control.disabled).toBe(true);
  });

  it("does not render the retained old frame while a new revision is loading", () => {
    renderNative({ status: "loading" });

    expect(host.querySelector("[data-native-dyson-read-status='loading']")).not.toBeNull();
    expect(host.textContent).toContain("正在同步原生权威戴森球投影");
    expect(host.textContent).not.toContain("原生赫利俄斯");
    expect(host.querySelector("[data-native-dyson-node-id]")).toBeNull();
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
    expect(nativeBoundary).not.toMatch(/onAddLayer|onSave|onOrbitChange|onAddSwarmOrbit|commitGame|publishRuntimeGame/);
  });
});
