import { ITEMS } from "./content";
import {
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
} from "./simulationRuntimeProtocol";
import type { ItemId, MaterialDeliverySlotMode } from "./types";
import type { NativeProjectedEntityConfigurationBinding } from "./nativeProjectedEntityConfigurationCommands";

const LOGICAL_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const MAX_LOGICAL_ID_BYTES = 256;
const MAX_OPAQUE_ID_BYTES = 512;
const TEXT_ENCODER = new TextEncoder();
const MATERIAL_DELIVERY_SLOT_COUNT = 3;
const ORBITAL_CARGO_PORT_COUNT = 4;

export interface NativeProjectedMaterialDeliverySlot {
  readonly itemId: ItemId | null;
  readonly mode: MaterialDeliverySlotMode;
}

export interface NativeProjectedMaterialDeliveryConfiguration {
  readonly slots: readonly NativeProjectedMaterialDeliverySlot[];
  readonly itemIds: readonly ItemId[];
}

export interface NativeProjectedOrbitalCargoConfiguration {
  readonly portItems: readonly (ItemId | null)[];
}

function validLogicalId(value: unknown): value is string {
  return typeof value === "string" && LOGICAL_ID_PATTERN.test(value) &&
    TEXT_ENCODER.encode(value).byteLength <= MAX_LOGICAL_ID_BYTES;
}

function validOpaqueId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    TEXT_ENCODER.encode(value).byteLength <= MAX_OPAQUE_ID_BYTES &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function validBinding(binding: NativeProjectedEntityConfigurationBinding | null): binding is NativeProjectedEntityConfigurationBinding {
  return Boolean(binding && validLogicalId(binding.sessionId) && validLogicalId(binding.runId) &&
    Number.isSafeInteger(binding.revision) && binding.revision >= 0 &&
    validOpaqueId(binding.activePlanetId) && validOpaqueId(binding.entity.id) &&
    binding.entity.planetId === binding.activePlanetId &&
    binding.entity.interactionLocked === false);
}

function validItemId(value: unknown): value is ItemId {
  return typeof value === "string" && Object.hasOwn(ITEMS, value);
}

export function getNativeProjectedMaterialDeliveryConfiguration(
  binding: NativeProjectedEntityConfigurationBinding | null,
): NativeProjectedMaterialDeliveryConfiguration | null {
  if (!validBinding(binding) || binding.entity.kind !== "storage" ||
      binding.entity.buildingId !== "material_delivery_hub" ||
      !Array.isArray(binding.entity.deliverySlots) ||
      binding.entity.deliverySlots.length !== MATERIAL_DELIVERY_SLOT_COUNT) return null;
  const slots: NativeProjectedMaterialDeliverySlot[] = [];
  for (const slot of binding.entity.deliverySlots) {
    if (!slot || !["auto", "manual", "disabled"].includes(slot.mode)) return null;
    const itemId = slot.itemId ?? null;
    if (itemId !== null && !validItemId(itemId)) return null;
    if (slot.mode === "manual" && itemId === null || slot.mode === "disabled" && itemId !== null) return null;
    slots.push(Object.freeze({ itemId, mode: slot.mode }));
  }
  return Object.freeze({
    slots: Object.freeze(slots),
    itemIds: Object.freeze(Object.keys(ITEMS) as ItemId[]),
  });
}

export function getNativeProjectedOrbitalCargoConfiguration(
  binding: NativeProjectedEntityConfigurationBinding | null,
): NativeProjectedOrbitalCargoConfiguration | null {
  if (!validBinding(binding) || binding.entity.kind !== "storage" ||
      binding.entity.buildingId !== "orbital_cargo_terminal" ||
      !Array.isArray(binding.entity.orbitalCargoPortItems) ||
      binding.entity.orbitalCargoPortItems.length !== ORBITAL_CARGO_PORT_COUNT) return null;
  const portItems: Array<ItemId | null> = [];
  for (const itemId of binding.entity.orbitalCargoPortItems) {
    if (itemId === null) portItems.push(null);
    else if (validItemId(itemId)) portItems.push(itemId);
    else return null;
  }
  return Object.freeze({ portItems: Object.freeze(portItems) });
}

function emptyCommand(baseRevision: number): SimulationCommandPatch {
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

/**
 * The UI must show its destructive confirmation before calling this helper.
 * Rust still derives every affected belt, cache refund and compatibility mirror.
 */
export function createConfirmedNativeMaterialDeliverySlotCommand(
  binding: NativeProjectedEntityConfigurationBinding,
  slotIndex: number,
  mode: MaterialDeliverySlotMode,
  itemId: ItemId | null,
): SimulationCommandPatch | null {
  const configuration = getNativeProjectedMaterialDeliveryConfiguration(binding);
  if (!configuration || !Number.isSafeInteger(slotIndex) || slotIndex < 0 ||
      slotIndex >= MATERIAL_DELIVERY_SLOT_COUNT ||
      !["auto", "manual", "disabled"].includes(mode) ||
      (mode === "manual") !== (itemId !== null) ||
      itemId !== null && !configuration.itemIds.includes(itemId)) {
    throw new TypeError("原生物资配送接口意图无效或不受支持");
  }
  const current = configuration.slots[slotIndex];
  if (current.mode === mode && current.itemId === itemId) return null;
  const command = emptyCommand(binding.revision);
  command.changedEntities = [{
    id: binding.entity.id,
    changes: [{
      path: ["materialDeliverySlot", "intent"],
      operation: "set",
      value: { slotIndex, mode, itemId, confirmed: true },
    }],
  }];
  return command;
}

/** Clears one non-empty terminal port after an explicit renderer confirmation. */
export function createConfirmedNativeOrbitalCargoPortClearCommand(
  binding: NativeProjectedEntityConfigurationBinding,
  portIndex: number,
): SimulationCommandPatch | null {
  const configuration = getNativeProjectedOrbitalCargoConfiguration(binding);
  if (!configuration || !Number.isSafeInteger(portIndex) || portIndex < 0 ||
      portIndex >= ORBITAL_CARGO_PORT_COUNT) {
    throw new TypeError("原生轨道货运接口意图无效或不受支持");
  }
  if (configuration.portItems[portIndex] === null) return null;
  const command = emptyCommand(binding.revision);
  command.changedEntities = [{
    id: binding.entity.id,
    changes: [{
      path: ["orbitalCargoPort", "clearIntent"],
      operation: "set",
      value: { portIndex, confirmed: true },
    }],
  }];
  return command;
}
