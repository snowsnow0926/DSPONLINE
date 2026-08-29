// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { NodeProps } from "@xyflow/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createInitialState } from "../game/engine";
import type { BuildingId, FactoryEntity, ItemId } from "../game/types";

vi.mock("@xyflow/react", () => ({
  Handle: ({ id, type, isConnectable, className }: {
    id?: string;
    type: "source" | "target";
    isConnectable?: boolean;
    className?: string;
  }) => <span
    className={className}
    data-factory-handle={id ?? ""}
    data-handle-type={type}
    data-connectable={isConnectable === false ? "false" : "true"}
  />,
  Position: { Left: "left", Right: "right" },
  useUpdateNodeInternals: () => () => undefined,
}));

import {
  LogisticsNode,
  MachineNode,
  NODE_TYPES,
  PowerNode,
  VeinNode,
  type FactoryFlowNode,
  type FactoryNodeData,
} from "./FactoryNodes";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type NodeComponentProps = ComponentProps<typeof MachineNode>;

type NodeCallbacks = Pick<FactoryNodeData,
  | "onMiningStart"
  | "onMiningStop"
  | "onPickOutput"
  | "onPickInput"
  | "onDropCargo"
  | "onDropDraggedItem"
  | "onInstallMiner"
  | "onAddBuilding"
  | "onRecipeChange"
  | "onFuelChange"
  | "onEnergyModeChange"
  | "onInteractionLockChange"
  | "onStackActivate"
>;

function callbacks(): NodeCallbacks {
  return {
    onMiningStart: vi.fn(),
    onMiningStop: vi.fn(),
    onPickOutput: vi.fn(),
    onPickInput: vi.fn(),
    onDropCargo: vi.fn(),
    onDropDraggedItem: vi.fn(),
    onInstallMiner: vi.fn(),
    onAddBuilding: vi.fn(),
    onRecipeChange: vi.fn(),
    onFuelChange: vi.fn(),
    onEnergyModeChange: vi.fn(),
    onInteractionLockChange: vi.fn(),
    onStackActivate: vi.fn(),
  };
}

function entityFixture(
  kind: FactoryEntity["kind"],
  buildingId?: BuildingId,
  overrides: Partial<FactoryEntity> = {},
): FactoryEntity {
  const seed = createInitialState().entities[0];
  return {
    ...seed,
    id: `readonly-${kind}-${buildingId ?? "resource"}`,
    kind,
    buildingId,
    extractorBuildingId: kind === "vein" ? "mining_machine" : undefined,
    resourceId: kind === "vein" ? "iron_ore" : undefined,
    recipeId: undefined,
    storedItemId: undefined,
    fuelItemId: undefined,
    interactionLocked: false,
    machineCount: kind === "vein" ? 0 : 2,
    minerCount: kind === "vein" ? 2 : 0,
    inputs: {},
    outputs: {},
    progress: 0.25,
    utilization: 0.75,
    productionRate: 12,
    ...overrides,
  };
}

function machineFixture(overrides: Partial<FactoryEntity> = {}): FactoryEntity {
  return entityFixture("machine", "assembling_machine_mk1", {
    recipeId: "gear",
    inputs: { iron_ingot: 8 },
    outputs: { gear: 4 },
    ...overrides,
  });
}

function dataFixture(entity: FactoryEntity, spies: NodeCallbacks, overrides: Partial<FactoryNodeData> = {}): FactoryNodeData {
  const game = createInitialState();
  const acceptedInputItemIds = entity.kind === "vein"
    ? []
    : entity.buildingId === "thermal_power_plant" ? ["coal" as ItemId]
      : entity.buildingId === "energy_exchanger" ? ["accumulator" as ItemId]
        : entity.kind === "machine" ? ["iron_ingot" as ItemId]
          : ["iron_ingot" as ItemId];
  const producedOutputItemIds = entity.kind === "vein"
    ? [entity.resourceId!]
    : entity.buildingId === "energy_exchanger" ? ["charged_accumulator" as ItemId]
      : entity.kind === "machine" ? ["gear" as ItemId]
        : ["iron_ingot" as ItemId];
  return {
    readOnly: true,
    visualSignature: "visual-stable",
    presentationSignature: "presentation-stable",
    entity,
    cargo: { itemId: acceptedInputItemIds[0] ?? "iron_ingot", amount: 3 },
    placement: entity.kind === "vein" ? "mining_machine" : entity.buildingId ?? null,
    placementCount: 1,
    miningEntityId: null,
    ...spies,
    researchLabel: null,
    researchCosts: [],
    connectedInputItemIds: [],
    inputBeltCounts: {},
    outputBeltCounts: {},
    blackHolePortConnections: {},
    completedTechIds: [],
    paused: false,
    powerFactor: 1,
    resourceReserve: entity.kind === "vein"
      ? { infinite: true, exhausted: false, remaining: null, capacity: null, remainingRatio: 1, remainingPercent: 100 }
      : null,
    powerDemandMultiplier: 1,
    solarGenerationMultiplier: 1,
    windGenerationMultiplier: 1,
    geothermalGenerationMultiplier: 1,
    activeLogisticsEntityIds: [],
    connectionDraft: { nodeId: "another-node", handleId: "out:iron_ingot", itemId: "iron_ingot", handleType: "source" },
    dysonSwarm: game.dysonSwarm,
    dysonSphere: game.dysonSphere,
    timeWarp: game.timeWarp,
    simulationMultiplier: 1,
    status: { code: "running", label: "运行中", tone: "running" },
    outputCapacity: 1_000,
    cycleRatePerSecond: 1,
    lod: "full",
    extremeVisuals: false,
    acceptedInputItemIds,
    producedOutputItemIds,
    connectionViewportFull: true,
    dynamicEffects: false,
    presentationVisible: true,
    alertActive: false,
    stackHidden: false,
    stackMarker: false,
    stackHalo: false,
    stackCount: 1,
    stackGroupId: null,
    stackMembershipToken: "single",
    stackMemberIds: [entity.id],
    stackAlertCount: 0,
    stackCriticalAlertCount: 0,
    stackGeometryHandlesRequired: true,
    ...overrides,
  };
}

function nodeProps(data: FactoryNodeData, selected = true): NodeComponentProps {
  return {
    id: data.entity.id,
    data,
    type: data.entity.kind,
    dragging: false,
    zIndex: 0,
    selectable: true,
    deletable: false,
    selected,
    draggable: !data.readOnly,
    isConnectable: !data.readOnly,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
  } as NodeProps<FactoryFlowNode>;
}

function dataTransfer(values: Record<string, string>): DataTransfer {
  return {
    types: Object.keys(values),
    getData: (type: string) => values[type] ?? "",
    setData: vi.fn(),
    effectAllowed: "none",
  } as unknown as DataTransfer;
}

function dispatchDrag(target: Element, type: "dragstart" | "dragover" | "drop", transfer: DataTransfer): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: transfer });
  target.dispatchEvent(event);
  return event;
}

function expectNoGameplayWrites(spies: NodeCallbacks): void {
  for (const [name, callback] of Object.entries(spies)) {
    if (name === "onStackActivate") continue;
    expect(callback, name).not.toHaveBeenCalled();
  }
}

describe("FactoryNodes native-authority read-only boundary", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  function render(component: React.ReactNode): void {
    act(() => root.render(component));
  }

  function expectHandlesReadOnly(): void {
    const handles = [...host.querySelectorAll<HTMLElement>("[data-factory-handle]")];
    expect(handles.length).toBeGreaterThan(0);
    expect(handles.every((handle) => handle.dataset.connectable === "false")).toBe(true);
  }

  it("keeps machine recipe, cargo, stacking and line handles inert", () => {
    const spies = callbacks();
    const data = dataFixture(machineFixture(), spies);
    render(<MachineNode {...nodeProps(data)} />);

    expect(host.querySelector(".catalog-picker-trigger")).toBeNull();
    expect(host.querySelector(".factory-node__lock")).toBeNull();
    expect([...host.querySelectorAll<HTMLButtonElement>(".node-slot")].every((button) => button.disabled)).toBe(true);
    expectHandlesReadOnly();

    host.querySelector<HTMLElement>("article.factory-node")?.click();
    host.querySelectorAll<HTMLButtonElement>(".node-slot").forEach((button) => {
      button.click();
      dispatchDrag(button, "dragstart", dataTransfer({}));
      dispatchDrag(button, "drop", dataTransfer({
        "application/factory-item": "iron_ingot",
        "application/factory-source-kind": "tray",
      }));
    });
    dispatchDrag(host.querySelector("article.factory-node")!, "drop", dataTransfer({
      "application/factory-building": "assembling_machine_mk1",
      "application/factory-item": "iron_ingot",
      "application/factory-source-kind": "tray",
    }));
    expectNoGameplayWrites(spies);
  });

  it("opens only projected inventory pickup while native configuration and deposits stay closed", () => {
    const spies = callbacks();
    const data = dataFixture(machineFixture(), spies, {
      cargo: null,
      inventoryPickupEnabled: true,
    });
    const MemoMachineNode = NODE_TYPES.machine;
    render(<MemoMachineNode {...nodeProps({ ...data, inventoryPickupEnabled: false })} />);
    expect([...host.querySelectorAll<HTMLButtonElement>(".node-slot")].every((button) => button.disabled)).toBe(true);
    render(<MemoMachineNode {...nodeProps(data)} />);

    expect(host.querySelector(".catalog-picker-trigger")).toBeNull();
    expectHandlesReadOnly();
    const input = host.querySelector<HTMLButtonElement>(".node-port--input .node-slot")!;
    const output = host.querySelector<HTMLButtonElement>(".node-port--output .node-slot")!;
    expect(input.disabled).toBe(false);
    expect(output.disabled).toBe(false);
    act(() => input.click());
    act(() => output.click());
    expect(spies.onPickInput).toHaveBeenCalledWith(data.entity.id, "iron_ingot");
    expect(spies.onPickOutput).toHaveBeenCalledWith(data.entity.id, "gear");

    dispatchDrag(input, "drop", dataTransfer({
      "application/factory-item": "iron_ingot",
      "application/factory-source-kind": "tray",
    }));
    expect(spies.onDropCargo).not.toHaveBeenCalled();
    expect(spies.onDropDraggedItem).not.toHaveBeenCalled();
    expect(spies.onRecipeChange).not.toHaveBeenCalled();
  });

  it("disables manual mining, miner installation, output pickup and unlock", () => {
    const spies = callbacks();
    const entity = entityFixture("vein", undefined, {
      interactionLocked: true,
      outputs: { iron_ore: 9 },
    });
    const data = dataFixture(entity, spies);
    render(<VeinNode {...nodeProps(data)} />);

    expect(host.querySelector(".factory-node__lock")).toBeNull();
    expect(host.querySelector<HTMLButtonElement>(".manual-mine")?.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>(".node-slot")?.disabled).toBe(true);
    expectHandlesReadOnly();

    const manualMine = host.querySelector<HTMLButtonElement>(".manual-mine")!;
    for (const type of ["pointerdown", "pointerup", "pointercancel"]) {
      manualMine.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
    }
    host.querySelector<HTMLElement>("article.factory-node")?.click();
    dispatchDrag(host.querySelector("article.factory-node")!, "drop", dataTransfer({
      "application/factory-building": "mining_machine",
    }));
    host.querySelector<HTMLButtonElement>(".node-slot")?.click();
    expectNoGameplayWrites(spies);
  });

  it("keeps logistics input, output, drop and automatic handles inert", () => {
    const spies = callbacks();
    const entity = entityFixture("storage", "storage_mk1", {
      interactionLocked: true,
      storedItemId: "iron_ingot",
      inputs: { iron_ingot: 6 },
      outputs: { iron_ingot: 7 },
    });
    const data = dataFixture(entity, spies);
    render(<LogisticsNode {...nodeProps(data)} />);

    expect(host.querySelector(".factory-node__lock")).toBeNull();
    expect([...host.querySelectorAll<HTMLButtonElement>(".node-slot")].every((button) => button.disabled)).toBe(true);
    expectHandlesReadOnly();

    host.querySelectorAll<HTMLButtonElement>(".node-slot").forEach((button) => button.click());
    dispatchDrag(host.querySelector("article.factory-node")!, "drop", dataTransfer({
      "application/factory-building": "storage_mk1",
      "application/factory-item": "iron_ingot",
      "application/factory-source-kind": "tray",
    }));
    expectNoGameplayWrites(spies);
  });

  it.each([
    ["fuel selector", entityFixture("power", "thermal_power_plant", {
      fuelItemId: "coal",
      inputs: { coal: 6 },
      outputs: {},
    })],
    ["energy mode selector", entityFixture("power", "energy_exchanger", {
      recipeId: "accumulator_charge",
      energyMode: "charge",
      inputs: { accumulator: 3 },
      outputs: { charged_accumulator: 2 },
      storedEnergyMj: 0,
    })],
  ])("does not mount the power %s and keeps its cargo ports inert", (_label, entity) => {
    const spies = callbacks();
    const data = dataFixture(entity, spies);
    render(<PowerNode {...nodeProps(data)} />);

    expect(host.querySelector(".node-inline-select")).toBeNull();
    expect(host.querySelector("select")).toBeNull();
    expect([...host.querySelectorAll<HTMLButtonElement>(".node-slot")].every((button) => button.disabled)).toBe(true);
    expectHandlesReadOnly();

    host.querySelectorAll<HTMLButtonElement>(".node-slot").forEach((button) => button.click());
    dispatchDrag(host.querySelector("article.factory-node")!, "drop", dataTransfer({
      "application/factory-building": entity.buildingId ?? "",
      "application/factory-item": "coal",
      "application/factory-source-kind": "tray",
    }));
    expectNoGameplayWrites(spies);
  });

  it("marks direct black-hole and lightweight handles non-connectable", () => {
    const spies = callbacks();
    const blackHole = entityFixture("machine", "micro_black_hole_connector");
    render(<MachineNode {...nodeProps(dataFixture(blackHole, spies))} />);
    expect(host.querySelectorAll("[data-factory-handle]")).toHaveLength(3);
    expectHandlesReadOnly();

    const compact = dataFixture(machineFixture(), spies, { lod: "compact" });
    render(<MachineNode {...nodeProps(compact)} />);
    expectHandlesReadOnly();
    expectNoGameplayWrites(spies);
  });

  it("preserves editable Web controls and immediately closes them when readOnly flips without signature changes", () => {
    const spies = callbacks();
    const editable = dataFixture(machineFixture(), spies, { readOnly: false });
    const MemoMachineNode = NODE_TYPES.machine;
    render(<MemoMachineNode {...nodeProps(editable)} />);

    expect(host.querySelector(".catalog-picker-trigger")).not.toBeNull();
    expect([...host.querySelectorAll<HTMLElement>("[data-factory-handle]")].every((handle) => handle.dataset.connectable === "true")).toBe(true);
    const output = host.querySelector<HTMLButtonElement>(".node-port--output .node-slot")!;
    expect(output.disabled).toBe(false);
    output.click();
    expect(spies.onPickOutput).toHaveBeenCalledTimes(1);

    const readOnly = { ...editable, readOnly: true };
    render(<MemoMachineNode {...nodeProps(readOnly)} />);
    expect(host.querySelector(".catalog-picker-trigger")).toBeNull();
    expect([...host.querySelectorAll<HTMLButtonElement>(".node-slot")].every((button) => button.disabled)).toBe(true);
    expectHandlesReadOnly();
  });
});
