import { BUILDINGS, ITEMS } from "./content";
import type { NativeProjectedEntityRecipeBinding } from "./nativeProjectedEntityRecipeCommands";
import { SIMULATION_RUNTIME_PROTOCOL_VERSION, type SimulationCommandPatch } from "./simulationRuntimeProtocol";
import type { ItemId } from "./types";

/** Only IDs cross the command boundary. Rust owns inventory and belt refunds. */
export function getNativeProjectedLogisticsItemConfiguration(binding: NativeProjectedEntityRecipeBinding | null) {
  if (!binding || binding.registryFingerprint !== "7df8cf3a" ||
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(binding.sessionId) ||
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(binding.runId) ||
      !Number.isSafeInteger(binding.revision) || binding.revision < 0 ||
      !binding.entity.id || binding.entity.planetId !== binding.activePlanetId || binding.entity.interactionLocked) return null;
  const id = binding.entity.buildingId;
  if (id !== "storage_mk1" && id !== "storage_tank" && id !== "splitter_4way") return null;
  const building = BUILDINGS[id];
  if (binding.entity.kind !== building.kind) return null;
  const accepts = building.accepts ?? "any";
  const options = Object.values(ITEMS).filter(item => accepts === "any" || accepts === item.kind ||
    (accepts === "solid" && item.kind === "matrix"));
  const currentItemId = binding.entity.storedItemId ?? null;
  if (currentItemId !== null && !options.some(item => item.id === currentItemId)) return null;
  return { currentItemId, options };
}

export function createNativeProjectedLogisticsItemCommand(
  binding: NativeProjectedEntityRecipeBinding, targetItemId: ItemId,
): SimulationCommandPatch | null {
  const configuration = getNativeProjectedLogisticsItemConfiguration(binding);
  if (!configuration || !configuration.options.some(item => item.id === targetItemId)) {
    throw new TypeError("物流物品投影或目标无效");
  }
  if (configuration.currentItemId === targetItemId) return null;
  return { protocolVersion: SIMULATION_RUNTIME_PROTOCOL_VERSION, baseRevision: binding.revision,
    topLevelChanges: [{ path: ["entityLogisticsItem", "intent"], operation: "set",
      value: { entityId: binding.entity.id, targetItemId } }],
    changedEntities: [], addedEntities: [], removedEntityIds: [], changedBelts: [], addedBelts: [], removedBeltIds: [] };
}
