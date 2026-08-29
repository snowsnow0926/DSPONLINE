import {
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
  type SimulationValuePatch,
} from "./simulationRuntimeProtocol";
import type { NativeFactoryInventoryFrame } from "./nativeFactoryInventoryStore";

const MAX_SAFE_QUANTITY = Number.MAX_SAFE_INTEGER;
const PORTABLE_FLEET_ITEMS = new Set(["logistics_drone", "logistics_vessel"]);

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
      frame.trayItemLimit < frame.trayItemLimitBounds.minimum ||
      frame.trayItemLimit > frame.trayItemLimitBounds.maximum) {
    throw new TypeError("原生物资投影无效");
  }
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
