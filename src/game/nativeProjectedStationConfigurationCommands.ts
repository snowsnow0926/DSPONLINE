import type {
  FactoryInspectorSummaryReadModel,
  FactoryMultiSelectionSummaryReadModel,
  NativeFactoryProjectionIdentity,
  NativeStationConfigurationReadModel,
  NativeStationRoutePolicyReadModel,
  NativeStationSlotConfigurationReadModel,
  SelectedEntityReadModel,
} from "./factoryReadModels";
import {
  createNativeProjectedStationLimitsCommand,
  createNativeProjectedStationMinimumLoadCommand,
  createNativeProjectedStationPriorityCommand,
  createNativeProjectedStationRoutePolicyCommand,
  createNativeProjectedStationWarperBudgetCommand,
} from "./nativeProjectedPlayerCommands";
import {
  createNativeStationFleetTargetIntentCommand,
  createNativeStationWarperInventoryIntentCommand,
  type NativeStationFleetKind,
} from "./nativeStationInventoryIntentCommands";
import {
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
} from "./simulationRuntimeProtocol";
import type { LogisticsPriority, StationMinimumLoad } from "./types";

const BUILT_IN_REGISTRY_FINGERPRINT = "7df8cf3a";
const MAX_STOCK = 100_000_000;

export interface NativeProjectedStationConfigurationBinding {
  readonly sessionId: string;
  readonly runId: string;
  readonly revision: number;
  readonly activePlanetId: string;
  readonly entity: SelectedEntityReadModel;
  readonly configuration: NativeStationConfigurationReadModel;
}

export interface NativeProjectedStationConfigurationReadModelsInput {
  readonly commandIdentity: NativeFactoryProjectionIdentity;
  readonly inspector: FactoryInspectorSummaryReadModel;
  readonly selection: FactoryMultiSelectionSummaryReadModel;
}

export type NativeProjectedStationScalarIntent =
  | Readonly<{ field: "stationWarpEnabled" | "stationWarperAutoRefill" | "stationHubEnabled"; target: boolean }>
  | Readonly<{ field: "stationWarperTarget"; target: number }>
  | Readonly<{ field: "stationHubPriority"; target: LogisticsPriority }>;

export type NativeProjectedStationInventoryAdjustment = -10 | -1 | 1 | 10 | "zero" | "capacity";

function opaqueId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !value.includes("\0");
}

function sameIdentity(
  left: NativeFactoryProjectionIdentity | null,
  right: NativeFactoryProjectionIdentity,
): boolean {
  return left !== null && left.sessionId === right.sessionId && left.runId === right.runId &&
    left.revision === right.revision && left.planetId === right.planetId;
}

function stationConfigurationIsStrict(
  entity: SelectedEntityReadModel,
  configuration: NativeStationConfigurationReadModel,
): boolean {
  if (configuration.schema !== "station-configuration-v1" ||
      configuration.registryFingerprint !== BUILT_IN_REGISTRY_FINGERPRINT ||
      !Array.isArray(configuration.slots) || configuration.slots.length !== 5 ||
      !Number.isSafeInteger(configuration.stationDrones) || configuration.stationDrones < 0 ||
      typeof configuration.spaceWarpUnlocked !== "boolean" ||
      Object.hasOwn(configuration, "stationRoutes")) return false;
  const interstellar = configuration.stationType === "interstellar";
  if ((!interstellar && configuration.stationType !== "planetary") ||
      entity.kind !== "station" || entity.buildingId !== (interstellar
        ? "interstellar_logistics_station"
        : "planetary_logistics_station")) return false;
  const configuredItems = new Set<string>();
  for (let index = 0; index < configuration.slots.length; index += 1) {
    const slot = configuration.slots[index];
    if (!slot || slot.slotIndex !== index || Object.hasOwn(slot, "stationRoutes") ||
        slot.itemId !== null && !opaqueId(slot.itemId) ||
        !["supply", "demand", "storage"].includes(slot.localMode) ||
        !["supply", "demand", "storage"].includes(slot.remoteMode) ||
        ![0.1, 0.25, 0.5, 1].includes(slot.minimumLoad) ||
        !Number.isSafeInteger(slot.minStock) || slot.minStock < 0 || slot.minStock > MAX_STOCK ||
        !Number.isSafeInteger(slot.maxStock) || slot.maxStock < 0 || slot.maxStock > MAX_STOCK ||
        slot.maxStock > 0 && slot.minStock > slot.maxStock ||
        ![0, 1, 2].includes(slot.priority)) return false;
    if (slot.itemId !== null) {
      if (configuredItems.has(slot.itemId)) return false;
      configuredItems.add(slot.itemId);
    }
    if (interstellar) {
      if (!slot.routePolicy || !["direct", "relay-preferred", "relay-required"].includes(slot.routePolicy) ||
          !Number.isSafeInteger(slot.warperBudget) || slot.warperBudget! < 1 || slot.warperBudget! > 4) return false;
    } else if (slot.routePolicy !== undefined || slot.warperBudget !== undefined) return false;
  }
  if (!interstellar) {
    return configuration.stationVessels === null && configuration.stationWarpers === null &&
      configuration.stationWarpEnabled === null && configuration.stationWarperAutoRefill === null &&
      configuration.stationWarperTarget === null && configuration.stationHubEnabled === null &&
      configuration.stationHubPriority === null;
  }
  return Number.isSafeInteger(configuration.stationVessels) && configuration.stationVessels! >= 0 &&
    Number.isSafeInteger(configuration.stationWarpers) && configuration.stationWarpers! >= 0 &&
    typeof configuration.stationWarpEnabled === "boolean" &&
    typeof configuration.stationWarperAutoRefill === "boolean" &&
    Number.isSafeInteger(configuration.stationWarperTarget) && configuration.stationWarperTarget! >= 1 &&
    typeof configuration.stationHubEnabled === "boolean" &&
    configuration.stationHubPriority !== null && [0, 1, 2].includes(configuration.stationHubPriority);
}

/**
 * Admits only one complete Rust station row from the exact live selection.
 * No GameState or viewport station fields participate in this decision.
 */
export function selectNativeProjectedStationConfigurationBinding(
  input: NativeProjectedStationConfigurationReadModelsInput,
): NativeProjectedStationConfigurationBinding | null {
  const { commandIdentity, inspector, selection } = input;
  if (!opaqueId(commandIdentity.sessionId) || !opaqueId(commandIdentity.runId) ||
      !opaqueId(commandIdentity.planetId) || !Number.isSafeInteger(commandIdentity.revision) ||
      commandIdentity.revision < 0 || inspector.source !== "native-core" ||
      inspector.revision !== commandIdentity.revision || inspector.activePlanetId !== commandIdentity.planetId ||
      inspector.belt !== null || selection.source !== "native-core" ||
      !sameIdentity(selection.projectionIdentity, commandIdentity) ||
      selection.revision !== commandIdentity.revision || selection.activePlanetId !== commandIdentity.planetId ||
      selection.requestedEntityCount !== 1 || selection.requestedBeltCount !== 0 ||
      selection.entityRows.truncated || selection.beltRows.truncated ||
      selection.entityRows.totalCount !== 1 || selection.entityRows.rows.length !== 1 ||
      selection.beltRows.totalCount !== 0 || selection.beltRows.rows.length !== 0) return null;
  const entity = inspector.entity;
  const selected = selection.entityRows.rows[0];
  if (!entity || !selected || entity.entityId !== selected.entityId ||
      entity.planetId !== commandIdentity.planetId || selected.planetId !== commandIdentity.planetId ||
      entity.kind !== selected.kind || entity.buildingId !== selected.buildingId ||
      entity.interactionLocked !== selected.interactionLocked ||
      JSON.stringify(entity.stationConfiguration) !== JSON.stringify(selected.stationConfiguration)) return null;
  const configuration = entity.stationConfiguration;
  if (!configuration || !stationConfigurationIsStrict(entity, configuration)) return null;
  return Object.freeze({
    sessionId: commandIdentity.sessionId,
    runId: commandIdentity.runId,
    revision: commandIdentity.revision,
    activePlanetId: commandIdentity.planetId,
    entity,
    configuration,
  });
}

function requireWritableBinding(
  binding: NativeProjectedStationConfigurationBinding,
): NativeStationConfigurationReadModel {
  if (!opaqueId(binding.sessionId) || !opaqueId(binding.runId) || !opaqueId(binding.activePlanetId) ||
      !Number.isSafeInteger(binding.revision) || binding.revision < 0 ||
      binding.entity.planetId !== binding.activePlanetId || binding.entity.interactionLocked ||
      binding.entity.stationConfiguration !== binding.configuration ||
      !stationConfigurationIsStrict(binding.entity, binding.configuration)) {
    throw new TypeError("原生物流站配置投影已失效或不可写");
  }
  return binding.configuration;
}

function slotAt(
  binding: NativeProjectedStationConfigurationBinding,
  slotIndex: number,
): NativeStationSlotConfigurationReadModel {
  const configuration = requireWritableBinding(binding);
  if (!Number.isSafeInteger(slotIndex) || slotIndex < 0 || slotIndex >= configuration.slots.length) {
    throw new TypeError("原生物流站槽位无效");
  }
  return configuration.slots[slotIndex];
}

export function createNativeProjectedStationSlotPriorityCommand(
  binding: NativeProjectedStationConfigurationBinding,
  slotIndex: number,
  target: LogisticsPriority,
): SimulationCommandPatch | null {
  const slot = slotAt(binding, slotIndex);
  return createNativeProjectedStationPriorityCommand({
    baseRevision: binding.revision,
    stationId: binding.entity.entityId,
    slotIndex,
    currentPriority: slot.priority,
    targetPriority: target,
  });
}

export function createNativeProjectedStationSlotMinimumLoadCommand(
  binding: NativeProjectedStationConfigurationBinding,
  slotIndex: number,
  target: StationMinimumLoad,
): SimulationCommandPatch | null {
  const slot = slotAt(binding, slotIndex);
  const primarySlotIndex = binding.configuration.slots.findIndex((candidate) => candidate.itemId !== null);
  return createNativeProjectedStationMinimumLoadCommand({
    baseRevision: binding.revision,
    stationId: binding.entity.entityId,
    slotIndex,
    currentMinimumLoad: slot.minimumLoad,
    targetMinimumLoad: target,
    primarySlot: slotIndex === primarySlotIndex,
  });
}

export function createNativeProjectedStationSlotLimitsCommand(
  binding: NativeProjectedStationConfigurationBinding,
  slotIndex: number,
  requestedMinStock: number,
  requestedMaxStock: number,
): SimulationCommandPatch | null {
  const slot = slotAt(binding, slotIndex);
  return createNativeProjectedStationLimitsCommand({
    baseRevision: binding.revision,
    stationId: binding.entity.entityId,
    slotIndex,
    currentMinStock: slot.minStock,
    currentMaxStock: slot.maxStock,
    requestedMinStock,
    requestedMaxStock,
  });
}

export function createNativeProjectedStationSlotRoutePolicyCommand(
  binding: NativeProjectedStationConfigurationBinding,
  slotIndex: number,
  target: NativeStationRoutePolicyReadModel,
): SimulationCommandPatch | null {
  const slot = slotAt(binding, slotIndex);
  if (binding.configuration.stationType !== "interstellar" || !slot.routePolicy) {
    throw new TypeError("行星物流站不支持星际路线策略");
  }
  return createNativeProjectedStationRoutePolicyCommand({
    baseRevision: binding.revision,
    stationId: binding.entity.entityId,
    slotIndex,
    currentRoutePolicy: slot.routePolicy,
    targetRoutePolicy: target,
  });
}

export function createNativeProjectedStationSlotWarperBudgetCommand(
  binding: NativeProjectedStationConfigurationBinding,
  slotIndex: number,
  target: number,
): SimulationCommandPatch | null {
  const slot = slotAt(binding, slotIndex);
  if (binding.configuration.stationType !== "interstellar" || slot.warperBudget === undefined) {
    throw new TypeError("行星物流站不支持翘曲器预算");
  }
  return createNativeProjectedStationWarperBudgetCommand({
    baseRevision: binding.revision,
    stationId: binding.entity.entityId,
    slotIndex,
    currentWarperBudget: slot.warperBudget,
    requestedWarperBudget: target,
  });
}

export function createNativeProjectedStationScalarCommand(
  binding: NativeProjectedStationConfigurationBinding,
  intent: NativeProjectedStationScalarIntent,
): SimulationCommandPatch | null {
  const configuration = requireWritableBinding(binding);
  if (configuration.stationType !== "interstellar") {
    throw new TypeError("行星物流站不支持星际站级配置");
  }
  let current: boolean | number | null;
  switch (intent.field) {
    case "stationWarpEnabled":
    case "stationWarperAutoRefill":
    case "stationHubEnabled":
      if (typeof intent.target !== "boolean") throw new TypeError("原生物流站开关目标无效");
      current = configuration[intent.field];
      if (intent.target && intent.field !== "stationHubEnabled" && !configuration.spaceWarpUnlocked) {
        throw new TypeError("空间翘曲科技尚未解锁");
      }
      break;
    case "stationWarperTarget": {
      const capacity = binding.entity.machineCount * 50;
      if (!Number.isSafeInteger(intent.target) || intent.target < 1 ||
          !Number.isSafeInteger(capacity) || intent.target > capacity) {
        throw new TypeError("原生物流站翘曲器目标无效");
      }
      current = configuration.stationWarperTarget;
      break;
    }
    case "stationHubPriority":
      if (![0, 1, 2].includes(intent.target)) throw new TypeError("原生物流站枢纽优先级无效");
      current = configuration.stationHubPriority;
      break;
  }
  if (current === intent.target) return null;
  return {
    protocolVersion: SIMULATION_RUNTIME_PROTOCOL_VERSION,
    baseRevision: binding.revision,
    topLevelChanges: [],
    changedEntities: [{
      id: binding.entity.entityId,
      changes: [{ path: [intent.field], operation: "set", value: intent.target }],
    }],
    addedEntities: [],
    removedEntityIds: [],
    changedBelts: [],
    addedBelts: [],
    removedBeltIds: [],
  };
}

function stationInventoryAdjustmentTarget(
  current: number,
  capacity: number,
  adjustment: NativeProjectedStationInventoryAdjustment,
): number {
  if (!Number.isSafeInteger(current) || current < 0 || !Number.isSafeInteger(capacity) || capacity < current) {
    throw new TypeError("原生物流站库存投影无效");
  }
  if (adjustment === "zero") return 0;
  if (adjustment === "capacity") return capacity;
  if (![-10, -1, 1, 10].includes(adjustment)) {
    throw new TypeError("原生物流站数量调整无效");
  }
  if (adjustment < 0) return Math.max(0, current + adjustment);
  return Math.min(Number.MAX_SAFE_INTEGER, current + adjustment);
}

/**
 * Emits one fleet target marker derived only from the same-revision Rust row.
 * Rust remains responsible for active routes, portable stock and capacity
 * clamping; no renderer-computed inventory leaf is included.
 */
export function createNativeProjectedStationFleetAdjustmentCommand(
  binding: NativeProjectedStationConfigurationBinding,
  kind: NativeStationFleetKind,
  adjustment: NativeProjectedStationInventoryAdjustment,
): SimulationCommandPatch | null {
  const configuration = requireWritableBinding(binding);
  if (kind !== "drone" && kind !== "vessel") {
    throw new TypeError("原生物流站舰队类型无效");
  }
  if (kind === "vessel" && configuration.stationType !== "interstellar") {
    throw new TypeError("行星物流站不支持运输船");
  }
  const capacityPerBuilding = kind === "drone" ? 50 : 10;
  const capacity = binding.entity.machineCount * capacityPerBuilding;
  const current = kind === "drone" ? configuration.stationDrones : configuration.stationVessels;
  if (current === null) throw new TypeError("原生物流站舰队投影无效");
  const target = stationInventoryAdjustmentTarget(current, capacity, adjustment);
  if (target === current) return null;
  return createNativeStationFleetTargetIntentCommand(
    binding.revision,
    binding.entity.entityId,
    kind,
    target,
  );
}

/**
 * Emits one signed warper marker. Rust resolves the authoritative station,
 * capacity and owning active-planet tray before applying any material move.
 */
export function createNativeProjectedStationWarperInventoryAdjustmentCommand(
  binding: NativeProjectedStationConfigurationBinding,
  adjustment: NativeProjectedStationInventoryAdjustment,
): SimulationCommandPatch | null {
  const configuration = requireWritableBinding(binding);
  if (configuration.stationType !== "interstellar" || configuration.stationWarpers === null) {
    throw new TypeError("行星物流站不支持站内翘曲器");
  }
  if (!configuration.spaceWarpUnlocked) {
    throw new TypeError("空间翘曲科技尚未解锁");
  }
  const capacity = binding.entity.machineCount * 50;
  const current = configuration.stationWarpers;
  const target = stationInventoryAdjustmentTarget(current, capacity, adjustment);
  const delta = target - current;
  if (delta === 0) return null;
  return createNativeStationWarperInventoryIntentCommand(
    binding.revision,
    binding.entity.entityId,
    delta,
  );
}
