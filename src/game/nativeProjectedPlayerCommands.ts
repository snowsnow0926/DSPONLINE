import { MAX_BUILDING_BUFFER_LIMIT, STATION_SLOT_COUNT } from "./engine";
import {
  FACTORY_READ_MODEL_LIMITS,
  type BoundedReadModelRows,
  type SelectedEntityReadModel,
} from "./factoryReadModels";
import {
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
  type SimulationValuePatch,
} from "./simulationRuntimeProtocol";
import type { LogisticsPriority, PlanetIndustryRole } from "./types";

const LOGICAL_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const MAX_LOGICAL_ID_BYTES = 256;
const PLANET_INDUSTRY_ROLES = new Set<PlanetIndustryRole>([
  "auto",
  "mining",
  "smelting",
  "manufacturing",
  "chemical",
  "research",
  "logistics",
  "power",
]);

export interface NativeProjectedPlanetRoleCommandInput {
  readonly baseRevision: number;
  readonly planetId: string;
  readonly currentRole: PlanetIndustryRole;
  readonly targetRole: PlanetIndustryRole;
}

export interface NativeProjectedStationPriorityCommandInput {
  readonly baseRevision: number;
  readonly stationId: string;
  readonly slotIndex: number;
  readonly currentPriority: LogisticsPriority;
  readonly targetPriority: LogisticsPriority;
}

export interface NativeProjectedStationLimitsCommandInput {
  readonly baseRevision: number;
  readonly stationId: string;
  readonly slotIndex: number;
  readonly currentMinStock: number;
  readonly currentMaxStock: number;
  readonly requestedMinStock: number;
  readonly requestedMaxStock: number;
}

export type NativeProjectedInteractionLockEntityRow = Pick<
  SelectedEntityReadModel,
  "entityId" | "interactionLocked"
>;

export interface NativeProjectedInteractionLockCommandInput {
  readonly baseRevision: number;
  readonly entityRows: BoundedReadModelRows<NativeProjectedInteractionLockEntityRow>;
  readonly targetInteractionLocked: boolean;
}

function validateBaseRevision(baseRevision: number): void {
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) {
    throw new TypeError("原生投影命令 revision 无效");
  }
}

function validateLogicalId(value: string, label: string): void {
  if (typeof value !== "string" || !LOGICAL_ID_PATTERN.test(value) ||
      new TextEncoder().encode(value).byteLength > MAX_LOGICAL_ID_BYTES) {
    throw new TypeError(`${label}无效`);
  }
}

function validateSlotIndex(slotIndex: number): void {
  if (!Number.isSafeInteger(slotIndex) || slotIndex < 0 || slotIndex >= STATION_SLOT_COUNT) {
    throw new TypeError("原生投影命令物流槽位无效");
  }
}

function emptyCommand(baseRevision: number): SimulationCommandPatch {
  validateBaseRevision(baseRevision);
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

function validatePriority(value: LogisticsPriority): void {
  if (value !== 0 && value !== 1 && value !== 2) {
    throw new TypeError("原生投影命令物流优先级无效");
  }
}

function validateCurrentStockLimit(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_BUILDING_BUFFER_LIMIT) {
    throw new TypeError(`${label}无效`);
  }
}

function normalizeRequestedStockLimit(value: number): number {
  return Math.max(
    0,
    Math.min(MAX_BUILDING_BUFFER_LIMIT, Math.floor(Number.isFinite(value) ? value : 0)),
  );
}

function validateInteractionLockEntityRows(
  entityRows: BoundedReadModelRows<NativeProjectedInteractionLockEntityRow>,
): readonly NativeProjectedInteractionLockEntityRow[] {
  if (!entityRows || !Array.isArray(entityRows.rows) || entityRows.truncated !== false ||
      !Number.isSafeInteger(entityRows.totalCount) || entityRows.totalCount < 0 ||
      entityRows.totalCount !== entityRows.rows.length ||
      entityRows.rows.length > FACTORY_READ_MODEL_LIMITS.selectedEntityRows) {
    throw new TypeError("原生投影命令所选建筑行必须完整且未截断");
  }
  const entityIds = new Set<string>();
  for (const row of entityRows.rows) {
    if (!row || typeof row !== "object") {
      throw new TypeError("原生投影命令所选建筑行无效");
    }
    validateLogicalId(row.entityId, "原生投影命令建筑 ID");
    if (entityIds.has(row.entityId)) {
      throw new TypeError("原生投影命令建筑 ID 重复");
    }
    entityIds.add(row.entityId);
    if (typeof row.interactionLocked !== "boolean") {
      throw new TypeError("原生投影命令当前交互锁无效");
    }
  }
  return entityRows.rows;
}

/**
 * Builds the Rust interaction-lock batch from one complete bounded selection.
 * Rows already at the target are omitted, while changed rows retain the exact
 * projection order. Rust rechecks the revision, IDs, current leaves and shared
 * boolean target before the command reaches durable staging.
 */
export function createNativeProjectedInteractionLockCommand(
  input: NativeProjectedInteractionLockCommandInput,
): SimulationCommandPatch | null {
  validateBaseRevision(input.baseRevision);
  if (typeof input.targetInteractionLocked !== "boolean") {
    throw new TypeError("原生投影命令目标交互锁无效");
  }
  const rows = validateInteractionLockEntityRows(input.entityRows);
  const command = emptyCommand(input.baseRevision);
  for (const row of rows) {
    if (row.interactionLocked === input.targetInteractionLocked) continue;
    command.changedEntities.push({
      id: row.entityId,
      changes: [{
        path: ["interactionLocked"],
        operation: "set",
        value: input.targetInteractionLocked,
      }],
    });
  }
  return command.changedEntities.length === 0 ? null : command;
}

/**
 * Builds one top-level leaf command from an exact native projection row.
 * The renderer never predicts the result: Rust rechecks the current revision,
 * planet catalog and current role before applying the patch.
 */
export function createNativeProjectedPlanetRoleCommand(
  input: NativeProjectedPlanetRoleCommandInput,
): SimulationCommandPatch | null {
  validateBaseRevision(input.baseRevision);
  validateLogicalId(input.planetId, "原生投影命令行星 ID");
  if (!PLANET_INDUSTRY_ROLES.has(input.currentRole) ||
      !PLANET_INDUSTRY_ROLES.has(input.targetRole)) {
    throw new TypeError("原生投影命令行星工业定位无效");
  }
  if (input.currentRole === input.targetRole) return null;
  const command = emptyCommand(input.baseRevision);
  command.topLevelChanges.push({
    path: ["galaxy", "planetRoles", input.planetId],
    operation: "set",
    value: input.targetRole,
  });
  return command;
}

/** Builds a station-slot priority leaf without consulting the stale JS state. */
export function createNativeProjectedStationPriorityCommand(
  input: NativeProjectedStationPriorityCommandInput,
): SimulationCommandPatch | null {
  validateBaseRevision(input.baseRevision);
  validateLogicalId(input.stationId, "原生投影命令物流站 ID");
  validateSlotIndex(input.slotIndex);
  validatePriority(input.currentPriority);
  validatePriority(input.targetPriority);
  if (input.currentPriority === input.targetPriority) return null;
  const command = emptyCommand(input.baseRevision);
  command.changedEntities.push({
    id: input.stationId,
    changes: [{
      path: ["stationSlots", input.slotIndex, "priority"],
      operation: "set",
      value: input.targetPriority,
    }],
  });
  return command;
}

/**
 * Mirrors `setStationSlotLimits()` exactly, including finite-number fallback,
 * integer clamping and lowering minStock when a non-zero maxStock drops below
 * it. The projected current pair is validated before a minimal patch is built.
 */
export function createNativeProjectedStationLimitsCommand(
  input: NativeProjectedStationLimitsCommandInput,
): SimulationCommandPatch | null {
  validateBaseRevision(input.baseRevision);
  validateLogicalId(input.stationId, "原生投影命令物流站 ID");
  validateSlotIndex(input.slotIndex);
  validateCurrentStockLimit(input.currentMinStock, "原生投影当前最低库存");
  validateCurrentStockLimit(input.currentMaxStock, "原生投影当前最高库存");
  if (input.currentMaxStock > 0 && input.currentMinStock > input.currentMaxStock) {
    throw new TypeError("原生投影当前库存上下限不一致");
  }

  let targetMinStock = normalizeRequestedStockLimit(input.requestedMinStock);
  const targetMaxStock = normalizeRequestedStockLimit(input.requestedMaxStock);
  if (targetMaxStock > 0 && targetMinStock > targetMaxStock) {
    targetMinStock = targetMaxStock;
  }
  const changes: SimulationValuePatch[] = [];
  if (targetMinStock !== input.currentMinStock) {
    changes.push({
      path: ["stationSlots", input.slotIndex, "minStock"],
      operation: "set",
      value: targetMinStock,
    });
  }
  if (targetMaxStock !== input.currentMaxStock) {
    changes.push({
      path: ["stationSlots", input.slotIndex, "maxStock"],
      operation: "set",
      value: targetMaxStock,
    });
  }
  if (changes.length === 0) return null;
  const command = emptyCommand(input.baseRevision);
  command.changedEntities.push({ id: input.stationId, changes });
  return command;
}
