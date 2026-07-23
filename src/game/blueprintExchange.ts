import { BUILDINGS, ITEMS, RECIPES } from "./content";
import type {
  BlueprintDefinition,
  BlueprintExternalPort,
  BlueprintBeltTemplate,
  BlueprintEntityTemplate,
  BlueprintMirror,
  BlueprintRotation,
  GameState,
  ItemId,
  RecipeId,
  StationSlot,
} from "./types";

export const BLUEPRINT_EXCHANGE_FORMAT_VERSION = 1;

export interface BlueprintExchangeEnvelope {
  type: "dsp-idle-blueprint";
  formatVersion: typeof BLUEPRINT_EXCHANGE_FORMAT_VERSION;
  exportedAt: string;
  blueprint: BlueprintDefinition;
}

export interface BlueprintExchangeResult {
  valid: boolean;
  blueprint: BlueprintDefinition | null;
  issues: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9_]{1,80}$/.test(value);
}

function validNumber(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function validPosition(value: unknown): value is { x: number; y: number } {
  return isRecord(value) && validNumber(value.x, -100_000, 100_000) && validNumber(value.y, -100_000, 100_000);
}

function cloneBlueprint(blueprint: BlueprintDefinition): BlueprintDefinition {
  return {
    ...blueprint,
    entities: blueprint.entities.map((entity) => ({ ...entity, offset: { ...entity.offset }, stationSlots: entity.stationSlots?.map((slot) => ({ ...slot })) })),
    belts: blueprint.belts.map((belt) => ({ ...belt })),
    externalPorts: blueprint.externalPorts?.map((port) => ({ ...port, offset: { ...port.offset } })),
    recipeOverrides: { ...blueprint.recipeOverrides },
  };
}

function parseStationSlots(value: unknown, entityIndex: number, issues: string[]): StationSlot[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 5) {
    issues.push(`设备 ${entityIndex + 1} 的物流槽位无效`);
    return undefined;
  }
  const slots: StationSlot[] = [];
  value.forEach((entry, slotIndex) => {
    if (!isRecord(entry) || (entry.itemId !== undefined && (typeof entry.itemId !== "string" || !(entry.itemId in ITEMS))) ||
      !["supply", "demand", "storage"].includes(String(entry.localMode)) || !["supply", "demand", "storage"].includes(String(entry.remoteMode)) ||
      ![0.1, 0.25, 0.5, 1].includes(Number(entry.minimumLoad)) || !validNumber(entry.minStock, 0, 1_000_000) ||
      !validNumber(entry.maxStock, 0, 1_000_000) || Number(entry.maxStock) < Number(entry.minStock) || ![0, 1, 2].includes(Number(entry.priority)) ||
      (entry.routePolicy !== undefined && !["direct", "relay-preferred", "relay-required"].includes(String(entry.routePolicy))) ||
      (entry.warperBudget !== undefined && !validNumber(entry.warperBudget, 1, 4))) {
      issues.push(`设备 ${entityIndex + 1} 的物流槽位 ${slotIndex + 1} 无效`);
      return;
    }
    slots.push({
      ...(typeof entry.itemId === "string" ? { itemId: entry.itemId as ItemId } : {}),
      localMode: entry.localMode as StationSlot["localMode"],
      remoteMode: entry.remoteMode as StationSlot["remoteMode"],
      minimumLoad: entry.minimumLoad as StationSlot["minimumLoad"],
      minStock: Math.floor(entry.minStock),
      maxStock: Math.floor(entry.maxStock),
      priority: entry.priority as StationSlot["priority"],
      routePolicy: entry.routePolicy === "direct" || entry.routePolicy === "relay-required" ? entry.routePolicy : "relay-preferred",
      warperBudget: Math.max(1, Math.min(4, Math.floor(typeof entry.warperBudget === "number" ? entry.warperBudget : 2))),
    });
  });
  return slots;
}

function parseEntity(value: unknown, index: number, issues: string[]): BlueprintEntityTemplate | null {
  if (!isRecord(value) || !validId(value.key) || typeof value.buildingId !== "string" || !(value.buildingId in BUILDINGS) || !validPosition(value.offset) || !validNumber(value.machineCount, 1, 10_000)) {
    issues.push(`设备 ${index + 1} 缺少合法的 key、建筑、位置或数量`);
    return null;
  }
  if (value.recipeId !== undefined && (typeof value.recipeId !== "string" || !(value.recipeId in RECIPES))) {
    issues.push(`设备 ${index + 1} 引用了当前目录中不存在的配方 ${String(value.recipeId)}`);
    return null;
  }
  if (value.storedItemId !== undefined && (typeof value.storedItemId !== "string" || !(value.storedItemId in ITEMS))) {
    issues.push(`设备 ${index + 1} 引用了当前目录中不存在的物品 ${String(value.storedItemId)}`);
    return null;
  }
  const recipeId = value.recipeId as RecipeId | undefined;
  if (recipeId && RECIPES[recipeId]?.buildingId !== value.buildingId && !["assembling_machine_mk2", "assembling_machine_mk3", "plane_smelter", "quantum_chemical_plant"].includes(value.buildingId)) {
    issues.push(`设备 ${index + 1} 的配方与建筑不兼容`);
    return null;
  }
  const stationSlots = parseStationSlots(value.stationSlots, index, issues);
  return {
    key: value.key,
    buildingId: value.buildingId as BlueprintEntityTemplate["buildingId"],
    offset: { x: Math.round(value.offset.x), y: Math.round(value.offset.y) },
    machineCount: Math.floor(value.machineCount),
    ...(recipeId ? { recipeId } : {}),
    ...(typeof value.storedItemId === "string" ? { storedItemId: value.storedItemId as ItemId } : {}),
    ...(value.distributionMode === "balanced" || value.distributionMode === "priority" ? { distributionMode: value.distributionMode } : {}),
    ...(typeof value.fuelItemId === "string" && value.fuelItemId in ITEMS ? { fuelItemId: value.fuelItemId as ItemId } : {}),
    ...(value.energyMode === "auto" || value.energyMode === "charge" || value.energyMode === "discharge" ? { energyMode: value.energyMode } : {}),
    ...(value.powerGridId === "grid-a" || value.powerGridId === "grid-b" || value.powerGridId === "grid-c" ? { powerGridId: value.powerGridId } : {}),
    ...(value.powerPriority === 1 || value.powerPriority === 2 || value.powerPriority === 3 ? { powerPriority: value.powerPriority } : {}),
    ...(value.generationPriority === 1 || value.generationPriority === 2 || value.generationPriority === 3 ? { generationPriority: value.generationPriority } : {}),
    ...(value.stationMode === "supply" || value.stationMode === "demand" ? { stationMode: value.stationMode } : {}),
    ...(value.stationMinimumLoad === 0.1 || value.stationMinimumLoad === 0.25 || value.stationMinimumLoad === 0.5 || value.stationMinimumLoad === 1 ? { stationMinimumLoad: value.stationMinimumLoad } : {}),
    ...(typeof value.stationWarpEnabled === "boolean" ? { stationWarpEnabled: value.stationWarpEnabled } : {}),
    ...(typeof value.stationWarperAutoRefill === "boolean" ? { stationWarperAutoRefill: value.stationWarperAutoRefill } : {}),
    ...(validNumber(value.stationWarperTarget, 1, 500_000) ? { stationWarperTarget: Math.floor(value.stationWarperTarget) } : {}),
    ...(typeof value.stationHubEnabled === "boolean" ? { stationHubEnabled: value.stationHubEnabled } : {}),
    ...([0, 1, 2].includes(Number(value.stationHubPriority)) ? { stationHubPriority: Number(value.stationHubPriority) as 0 | 1 | 2 } : {}),
    ...(stationSlots ? { stationSlots } : {}),
    ...(typeof value.sprayCoaterInstalled === "boolean" ? { sprayCoaterInstalled: value.sprayCoaterInstalled } : {}),
    ...(value.proliferatorTier === 1 || value.proliferatorTier === 2 || value.proliferatorTier === 3 ? { proliferatorTier: value.proliferatorTier } : {}),
    ...(value.proliferatorMode === "normal" || value.proliferatorMode === "extra" || value.proliferatorMode === "speed" ? { proliferatorMode: value.proliferatorMode } : {}),
  };
}

function parseBelt(value: unknown, index: number, entityKeys: Set<string>, issues: string[]): BlueprintBeltTemplate | null {
  if (!isRecord(value) || !validId(value.key) || typeof value.sourceKey !== "string" || typeof value.targetKey !== "string" ||
    !entityKeys.has(value.sourceKey) || !entityKeys.has(value.targetKey) || value.sourceKey === value.targetKey ||
    typeof value.itemId !== "string" || !(value.itemId in ITEMS) || !validNumber(value.lanes, 1, 64) ||
    (value.tier !== 1 && value.tier !== 2 && value.tier !== 3) ||
    (value.priority !== 0 && value.priority !== 1 && value.priority !== 2)) {
    issues.push(`线路 ${index + 1} 包含未知端点、物品或等级`);
    return null;
  }
  return {
    key: value.key,
    sourceKey: value.sourceKey,
    targetKey: value.targetKey,
    itemId: value.itemId as ItemId,
    lanes: Math.floor(value.lanes),
    tier: value.tier,
    sorterTier: value.tier,
    priority: value.priority,
    ...(value.stackSize === 1 || value.stackSize === 2 || value.stackSize === 4 ? { stackSize: value.stackSize } : {}),
    ...(typeof value.monitorEnabled === "boolean" ? { monitorEnabled: value.monitorEnabled } : {}),
    ...(value.routeMode === "bezier" || value.routeMode === "auto" || value.routeMode === "upper" || value.routeMode === "lower" || value.routeMode === "manual" ? { routeMode: value.routeMode } : {}),
    ...(validNumber(value.routeOffsetY, -10_000, 10_000) ? { routeOffsetY: Math.round(value.routeOffsetY) } : {}),
  };
}

function parseExternalPorts(value: unknown, entityKeys: Set<string>, issues: string[]): BlueprintExternalPort[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 128) {
    issues.push("外部接口必须是最多 128 项的数组");
    return undefined;
  }
  const ports: BlueprintExternalPort[] = [];
  const keys = new Set<string>();
  value.forEach((entry, index) => {
    if (!isRecord(entry) || !validId(entry.key) || keys.has(entry.key) || typeof entry.entityKey !== "string" || !entityKeys.has(entry.entityKey) ||
      (entry.direction !== "input" && entry.direction !== "output") || typeof entry.itemId !== "string" || !(entry.itemId in ITEMS) || !validPosition(entry.offset)) {
      issues.push(`外部接口 ${index + 1} 无效`);
      return;
    }
    keys.add(entry.key);
    ports.push({ key: entry.key, entityKey: entry.entityKey, direction: entry.direction, itemId: entry.itemId as ItemId, offset: { x: Math.round(entry.offset.x), y: Math.round(entry.offset.y) } });
  });
  return ports;
}

export function validateBlueprintExchange(value: unknown): BlueprintExchangeResult {
  const issues: string[] = [];
  if (!isRecord(value) || value.type !== "dsp-idle-blueprint" || value.formatVersion !== BLUEPRINT_EXCHANGE_FORMAT_VERSION || !isRecord(value.blueprint)) {
    return { valid: false, blueprint: null, issues: ["不是支持的蓝图交换文件"] };
  }
  const source = value.blueprint;
  if (typeof source.name !== "string" || !source.name.trim() || source.name.trim().length > 48 || !Array.isArray(source.entities) || source.entities.length < 1 || source.entities.length > 256 || !Array.isArray(source.belts) || source.belts.length > 512) {
    return { valid: false, blueprint: null, issues: ["蓝图名称、设备数量或线路数量不合法"] };
  }
  const entities = source.entities.flatMap((entry, index) => {
    const entity = parseEntity(entry, index, issues);
    return entity ? [entity] : [];
  });
  const entityKeys = new Set<string>();
  for (const entity of entities) {
    if (entityKeys.has(entity.key)) issues.push(`设备 key 重复：${entity.key}`);
    entityKeys.add(entity.key);
  }
  const belts = source.belts.flatMap((entry, index) => {
    const belt = parseBelt(entry, index, entityKeys, issues);
    return belt ? [belt] : [];
  });
  const beltKeys = new Set<string>();
  for (const belt of belts) {
    if (beltKeys.has(belt.key)) issues.push(`线路 key 重复：${belt.key}`);
    beltKeys.add(belt.key);
  }
  const externalPorts = parseExternalPorts(source.externalPorts, entityKeys, issues);
  const rotation: BlueprintRotation = source.rotation === 90 || source.rotation === 180 || source.rotation === 270 ? source.rotation : 0;
  const mirror: BlueprintMirror = source.mirror === "horizontal" ? "horizontal" : "none";
  const overrides = isRecord(source.recipeOverrides)
    ? Object.fromEntries(Object.entries(source.recipeOverrides).flatMap(([from, to]) =>
      from in RECIPES && typeof to === "string" && to in RECIPES ? [[from, to as RecipeId]] : []))
    : {};
  if (entities.length !== source.entities.length || belts.length !== source.belts.length || issues.length > 0) return { valid: false, blueprint: null, issues };
  return {
    valid: true,
    blueprint: {
      id: typeof source.id === "string" ? source.id : "imported_blueprint",
      name: source.name.trim().slice(0, 48),
      entities,
      belts,
      ...(externalPorts ? { externalPorts } : {}),
      rotation,
      mirror,
      recipeOverrides: overrides,
    },
    issues: [],
  };
}

export function parseBlueprintExchange(raw: string): BlueprintExchangeResult {
  try {
    return validateBlueprintExchange(JSON.parse(raw));
  } catch {
    return { valid: false, blueprint: null, issues: ["蓝图文件不是有效 JSON"] };
  }
}

export function serializeBlueprintExchange(blueprint: BlueprintDefinition): string {
  const envelope: BlueprintExchangeEnvelope = {
    type: "dsp-idle-blueprint",
    formatVersion: BLUEPRINT_EXCHANGE_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    blueprint: cloneBlueprint(blueprint),
  };
  return JSON.stringify(envelope, null, 2);
}

export function importBlueprintExchange(state: GameState, blueprint: BlueprintDefinition): GameState {
  const imported = cloneBlueprint(blueprint);
  const existingNames = new Set(state.blueprints.map((candidate) => candidate.name));
  const baseName = imported.name || "导入蓝图";
  let name = baseName;
  let suffix = 2;
  while (existingNames.has(name)) {
    name = `${baseName} ${suffix}`.slice(0, 48);
    suffix += 1;
  }
  imported.id = `blueprint_${state.nextId}`;
  imported.name = name;
  return { ...state, nextId: state.nextId + 1, blueprints: [...state.blueprints, imported].slice(-64) };
}
