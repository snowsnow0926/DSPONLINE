import {
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
  type SimulationValuePatch,
} from "./simulationRuntimeProtocol";
import type { NativeFactoryInventoryFrame } from "./nativeFactoryInventoryStore";
import { buildingSupportsRecipe, getBuilding, getRecipe } from "./content";
import type { FactoryEntity, ItemId } from "./types";

const MAX_SAFE_QUANTITY = Number.MAX_SAFE_INTEGER;
const PORTABLE_FLEET_ITEMS = new Set(["logistics_drone", "logistics_vessel"]);
const EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT = "7df8cf3a";
const BUILTIN_ORDINARY_RECIPE_BUILDINGS = new Set([
  "arc_smelter",
  "assembling_machine_mk1",
  "assembling_machine_mk2",
  "assembling_machine_mk3",
  "chemical_plant",
  "em_rail_ejector",
  "fractionator",
  "matrix_lab",
  "miniature_particle_collider",
  "oil_refinery",
  "plane_smelter",
  "quantum_chemical_plant",
  "vertical_launching_silo",
]);
const BUILTIN_MATRIX_ITEMS = new Set([
  "electromagnetic_matrix",
  "energy_matrix",
  "structure_matrix",
  "information_matrix",
  "gravity_matrix",
  "universe_matrix",
]);

export type NativeEntityInventorySourceField = "inputs" | "outputs";

function emptyCommand(baseRevision: number): SimulationCommandPatch {
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) {
    throw new TypeError("原生物资命令 revision 无效");
  }
  return {
    protocolVersion: SIMULATION_RUNTIME_PROTOCOL_VERSION,
    baseRevision,
    topLevelChanges: [],
    changedEntities: [],
    addedEntities: [],
    removedEntityIds: [],
    changedBelts: [],
    addedBelts: [],
    removedBeltIds: [],
  };
}

function validateFrame(frame: NativeFactoryInventoryFrame): void {
  if (frame.source !== "native-core" || !Number.isSafeInteger(frame.revision) || frame.revision < 0 ||
      frame.pickupTargetAmount !== 100 || !Number.isSafeInteger(frame.trayItemLimit) ||
      !Number.isSafeInteger(frame.productionBufferLimit) || frame.productionBufferLimit < 1_000 ||
      frame.productionBufferLimit > 100_000_000 ||
      frame.trayItemLimit < frame.trayItemLimitBounds.minimum ||
      frame.trayItemLimit > frame.trayItemLimitBounds.maximum) {
    throw new TypeError("原生物资投影无效");
  }
}

function projectedOrdinaryInputRoom(
  frame: NativeFactoryInventoryFrame,
  entity: FactoryEntity,
  itemId: ItemId,
): { current: number; freeCapacity: number } {
  validateFrame(frame);
  if (frame.registryFingerprint !== EMPTY_CONTENT_PACK_REGISTRY_FINGERPRINT ||
      entity.planetId !== frame.activePlanetId || entity.kind !== "machine" || !entity.id ||
      !entity.buildingId || !BUILTIN_ORDINARY_RECIPE_BUILDINGS.has(entity.buildingId)) {
    throw new TypeError("原生普通建筑投料目标无效");
  }
  const recipe = getRecipe(entity.recipeId);
  if (!recipe || !buildingSupportsRecipe(entity.buildingId, recipe) ||
      !recipe.inputs.some((input) => input.itemId === itemId) &&
        !(recipe.id === "matrix_research" && BUILTIN_MATRIX_ITEMS.has(itemId))) {
    throw new TypeError("原生普通建筑当前配方不消耗该物料");
  }
  const building = getBuilding(entity.buildingId);
  const baseCapacity = safeQuantity(building.inputCapacity, "原生建筑基础输入容量", 1);
  const machineCount = safeQuantity(entity.machineCount, "原生建筑数量", 1);
  const ratedCapacity = baseCapacity > frame.productionBufferLimit / machineCount
    ? frame.productionBufferLimit
    : Math.min(frame.productionBufferLimit, baseCapacity * machineCount);
  if (!Number.isSafeInteger(ratedCapacity)) throw new RangeError("原生建筑输入容量超出安全整数范围");
  const current = safeQuantity(entity.inputs[itemId] ?? 0, "原生建筑当前输入库存");
  const freeCapacity = Math.max(0, ratedCapacity - current);
  if (freeCapacity < 1) throw new RangeError("原生建筑输入已满");
  return { current, freeCapacity };
}

function createNativeProjectedEntityInputDepositCommand(
  frame: NativeFactoryInventoryFrame,
  entity: FactoryEntity,
  itemId: ItemId,
  source: "cargo" | "tray",
): SimulationCommandPatch | null {
  const { current, freeCapacity } = projectedOrdinaryInputRoom(frame, entity, itemId);
  const command = emptyCommand(frame.revision);
  let available: number;
  if (source === "cargo") {
    const cargo = frame.cargo;
    if (!cargo || cargo.itemId !== itemId) return null;
    available = safeQuantity(cargo.amount, "原生手持库存", 1);
    const moved = Math.min(available, freeCapacity);
    const remaining = available - moved;
    command.topLevelChanges.push({
      path: ["cargo"],
      operation: "set",
      value: remaining === 0 ? null : {
        itemId,
        amount: remaining,
        origin: cargo.origin ? { kind: cargo.origin.kind, id: cargo.origin.id } : null,
      },
    });
  } else {
    const row = frame.rowsByItemId.get(itemId);
    if (!row) return null;
    available = safeQuantity(row.amount, "原生托盘库存", 1);
    const moved = Math.min(available, freeCapacity);
    command.topLevelChanges.push({
      path: ["tray", itemId],
      operation: "set",
      value: available - moved,
    });
  }
  const moved = Math.min(available, freeCapacity);
  if (moved < 1) return null;
  command.changedEntities.push({
    id: entity.id,
    changes: [{ path: ["inputs", itemId], operation: "set", value: current + moved }],
  });
  return command;
}

/** Deposits the held stack into one built-in ordinary recipe input. */
export function createNativeProjectedCargoToEntityInputCommand(
  frame: NativeFactoryInventoryFrame,
  entity: FactoryEntity,
): SimulationCommandPatch | null {
  return frame.cargo
    ? createNativeProjectedEntityInputDepositCommand(frame, entity, frame.cargo.itemId as ItemId, "cargo")
    : null;
}

/** Deposits one active-tray row into one built-in ordinary recipe input. */
export function createNativeProjectedTrayToEntityInputCommand(
  frame: NativeFactoryInventoryFrame,
  entity: FactoryEntity,
  itemId: ItemId,
): SimulationCommandPatch | null {
  return createNativeProjectedEntityInputDepositCommand(frame, entity, itemId, "tray");
}

function safeQuantity(value: number, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > MAX_SAFE_QUANTITY) {
    throw new TypeError(`${label}无效`);
  }
  return value;
}

/**
 * Builds the only native tray-take shape. Rust re-reads the authoritative
 * state and requires this complete two-leaf result, so the renderer cannot
 * choose an amount or preserve stale cargo metadata.
 */
export function createNativeProjectedTrayTakeCommand(
  frame: NativeFactoryInventoryFrame,
  itemId: string,
): SimulationCommandPatch | null {
  validateFrame(frame);
  const row = frame.rowsByItemId.get(itemId);
  if (!row) return null;
  const available = safeQuantity(row.amount, "原生托盘库存", 1);
  const cargo = frame.cargo;
  if (cargo && cargo.itemId !== itemId) return null;
  const heldAmount = cargo ? safeQuantity(cargo.amount, "原生手持库存", 1) : 0;
  const take = Math.min(available, Math.max(0, frame.pickupTargetAmount - heldAmount));
  if (take < 1) return null;
  const command = emptyCommand(frame.revision);
  command.topLevelChanges.push(
    { path: ["tray", itemId], operation: "set", value: available - take },
    {
      path: ["cargo"],
      operation: "set",
      value: { itemId, amount: heldAmount + take, origin: { kind: "tray" } },
    },
  );
  return command;
}

/** Returns the complete held stack without applying the automatic tray cap. */
export function createNativeProjectedCargoReturnCommand(
  frame: NativeFactoryInventoryFrame,
): SimulationCommandPatch | null {
  validateFrame(frame);
  const cargo = frame.cargo;
  if (!cargo) return null;
  const heldAmount = safeQuantity(cargo.amount, "原生手持库存", 1);
  const portable = PORTABLE_FLEET_ITEMS.has(cargo.itemId);
  const current = portable
    ? safeQuantity(frame.portableFleet[cargo.itemId as keyof typeof frame.portableFleet], "原生随身舰队库存")
    : frame.rowsByItemId.has(cargo.itemId)
      ? safeQuantity(frame.rowsByItemId.get(cargo.itemId)!.amount, "原生托盘库存", 1)
      : 0;
  const target = current + heldAmount;
  if (!Number.isSafeInteger(target) || target > MAX_SAFE_QUANTITY) {
    throw new RangeError("原生手持物资返还后将超过安全整数范围");
  }
  const root = portable ? "portableFleet" : "tray";
  const changes: SimulationValuePatch[] = [
    { path: [root, cargo.itemId], operation: "set", value: target },
    { path: ["cargo"], operation: "set", value: null },
  ];
  const command = emptyCommand(frame.revision);
  command.topLevelChanges.push(...changes);
  return command;
}

/** Mirrors setPlanetTrayItemLimit without changing existing excess stock. */
export function createNativeProjectedTrayItemLimitCommand(
  frame: NativeFactoryInventoryFrame,
  requestedValue: number,
): SimulationCommandPatch | null {
  validateFrame(frame);
  if (!Number.isFinite(requestedValue)) return null;
  const target = Math.max(
    frame.trayItemLimitBounds.minimum,
    Math.min(frame.trayItemLimitBounds.maximum, Math.floor(requestedValue)),
  );
  if (target === frame.trayItemLimit) return null;
  const command = emptyCommand(frame.revision);
  command.topLevelChanges.push({
    path: ["planetTrayItemLimits", frame.activePlanetId],
    operation: "set",
    value: target,
  });
  return command;
}

/** Changes the global ordinary-machine buffer cap without touching existing stock. */
export function createNativeProjectedProductionBufferLimitCommand(
  frame: NativeFactoryInventoryFrame,
  requestedValue: number,
): SimulationCommandPatch | null {
  validateFrame(frame);
  if (!Number.isFinite(requestedValue)) return null;
  const target = Math.max(1_000, Math.min(100_000_000, Math.floor(requestedValue)));
  if (target === frame.productionBufferLimit) return null;
  const command = emptyCommand(frame.revision);
  command.topLevelChanges.push({
    path: ["settings", "productionBufferLimit"],
    operation: "set",
    value: target,
  });
  return command;
}

function validateProjectedEntity(
  frame: NativeFactoryInventoryFrame,
  entity: FactoryEntity,
  itemId: ItemId,
  sourceField: NativeEntityInventorySourceField,
): number {
  validateFrame(frame);
  if (!entity || entity.planetId !== frame.activePlanetId || typeof entity.id !== "string" || !entity.id ||
      !Object.prototype.hasOwnProperty.call(entity[sourceField], itemId)) {
    throw new TypeError("原生建筑库存投影无效");
  }
  if (sourceField === "outputs" && entity.kind === "station") {
    throw new TypeError("原生站点输出仍需在途预留证明");
  }
  return safeQuantity(entity[sourceField][itemId] ?? 0, "原生建筑库存", 1);
}

/**
 * Takes up to the canonical 100-item cursor limit from one projected entity
 * input/output. Rust re-reads the entity and reconstructs the same two-leaf
 * accounting transition before it accepts the command.
 */
export function createNativeProjectedEntityInventoryTakeCommand(
  frame: NativeFactoryInventoryFrame,
  entity: FactoryEntity,
  sourceField: NativeEntityInventorySourceField,
  itemId: ItemId,
): SimulationCommandPatch | null {
  const available = validateProjectedEntity(frame, entity, itemId, sourceField);
  const cargo = frame.cargo;
  if (cargo && cargo.itemId !== itemId) return null;
  const heldAmount = cargo ? safeQuantity(cargo.amount, "原生手持库存", 1) : 0;
  const take = Math.min(available, Math.max(0, frame.pickupTargetAmount - heldAmount));
  if (take < 1) return null;
  const command = emptyCommand(frame.revision);
  command.topLevelChanges.push({
    path: ["cargo"],
    operation: "set",
    value: {
      itemId,
      amount: heldAmount + take,
      origin: { kind: sourceField === "outputs" ? "node-output" : "node-input", id: entity.id },
    },
  });
  command.changedEntities.push({
    id: entity.id,
    changes: [{ path: [sourceField, itemId], operation: "set", value: available - take }],
  });
  return command;
}

/**
 * Moves one complete integral entity stack into the active tray (or portable
 * fleet) without materializing a GameState. Automatic tray capacity remains
 * enforced; station outputs stay fail-closed until their route ledger is part
 * of the command proof.
 */
export function createNativeProjectedEntityInventoryStowCommand(
  frame: NativeFactoryInventoryFrame,
  entity: FactoryEntity,
  sourceField: NativeEntityInventorySourceField,
  itemId: ItemId,
): SimulationCommandPatch | null {
  const available = validateProjectedEntity(frame, entity, itemId, sourceField);
  const portable = PORTABLE_FLEET_ITEMS.has(itemId);
  const row = frame.rowsByItemId.get(itemId);
  const current = portable
    ? safeQuantity(frame.portableFleet[itemId as keyof typeof frame.portableFleet], "原生随身舰队库存")
    : row ? safeQuantity(row.amount, "原生托盘库存", 1) : 0;
  const freeCapacity = portable
    ? MAX_SAFE_QUANTITY - current
    : row ? safeQuantity(row.freeCapacity, "原生托盘剩余容量") : frame.trayItemLimit;
  const moved = Math.min(available, freeCapacity);
  if (moved < 1) return null;
  const target = current + moved;
  if (!Number.isSafeInteger(target) || target > MAX_SAFE_QUANTITY) {
    throw new RangeError("原生建筑物资返还后将超过安全整数范围");
  }
  const command = emptyCommand(frame.revision);
  command.topLevelChanges.push({
    path: [portable ? "portableFleet" : "tray", itemId],
    operation: "set",
    value: target,
  });
  command.changedEntities.push({
    id: entity.id,
    changes: [{ path: [sourceField, itemId], operation: "set", value: available - moved }],
  });
  return command;
}
