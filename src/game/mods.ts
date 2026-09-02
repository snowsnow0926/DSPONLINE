import { BUILDINGS, ITEMS, RECIPES, TECHNOLOGIES, validateContentCatalog } from "./content";
import type { BuildingDefinition, BuildingPortDefinition, ItemDefinition } from "./types";

export const MOD_FORMAT_VERSION = 2;

export interface ModItemDefinition {
  id: string;
  name: string;
  symbol?: string;
  color?: string;
  kind?: ItemDefinition["kind"];
  description?: string;
}

export interface ModRecipeAmount {
  itemId: string;
  amount: number;
}

export interface ModRecipeDefinition {
  id: string;
  name: string;
  buildingId: string;
  duration: number;
  requiredTechId?: string;
  inputs: ModRecipeAmount[];
  outputs: ModRecipeAmount[];
}

export interface ModBuildingDefinition {
  id: string;
  name: string;
  shortName?: string;
  kind?: BuildingDefinition["kind"];
  speed?: number;
  inputCapacity?: number;
  outputCapacity?: number;
  accepts?: BuildingDefinition["accepts"];
  /** Generic recipe family. Buildings in the same family share recipes. */
  family?: BuildingDefinition["family"];
  powerDemandKw?: number;
  powerGenerationKw?: number;
  description?: string;
  requiredTechId?: string;
  costs?: ModRecipeAmount[];
  outputAmount?: number;
  stackLimit?: number;
  megastructure?: boolean;
  unique?: boolean;
  upgradeTargetId?: string;
  layoutWidth?: number;
  layoutHeight?: number;
  layoutClearance?: number;
  ports?: BuildingPortDefinition[];
  capabilities?: string[];
  scripted?: boolean;
}

export interface ModBuildingOverride {
  id: string;
  speed?: number;
  inputCapacity?: number;
  outputCapacity?: number;
  powerDemandKw?: number;
  powerGenerationKw?: number;
  powerChargeKw?: number;
  energyCapacityMj?: number;
  stackLimit?: number;
}

export interface ModBeltDefinition {
  id: string;
  name: string;
  tier: number;
  speed: number;
  requiredTechId?: string;
  costs: ModRecipeAmount[];
  outputAmount?: number;
}

export interface ModTechnologyDefinition {
  id: string;
  name: string;
  prerequisites?: string[];
  tier?: number;
  summary?: string;
  costs?: ModRecipeAmount[];
  unlocks?: string[];
}

export interface ContentPackManifest {
  formatVersion: number;
  id: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
  dependencies?: string[];
  items?: ModItemDefinition[];
  buildings?: ModBuildingDefinition[];
  recipes?: ModRecipeDefinition[];
  technologies?: ModTechnologyDefinition[];
  buildingOverrides?: ModBuildingOverride[];
  belts?: ModBeltDefinition[];
}

export interface ParsedContentPackDependency {
  id: string;
  range?: string;
}

export interface ModValidationIssue {
  severity: "error" | "warning";
  code: string;
  path: string;
  message: string;
}

export interface ModValidationResult {
  valid: boolean;
  manifest: ContentPackManifest | null;
  issues: ModValidationIssue[];
  counts: { items: number; buildings: number; recipes: number; technologies: number };
}

export interface ContentPackValidationContext {
  itemIds?: Iterable<string>;
  buildingIds?: Iterable<string>;
  technologyIds?: Iterable<string>;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9_]{1,63}$/.test(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 120;
}

function amountList(value: unknown): value is ModRecipeAmount[] {
  return Array.isArray(value) && value.length <= 24 && value.every((entry) =>
    isRecord(entry) && validId(entry.itemId) && typeof entry.amount === "number" && Number.isFinite(entry.amount) && entry.amount > 0 && entry.amount <= 1_000_000,
  );
}

const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const VERSION_RANGE_PATTERN = /^(?:\^|~|>=|<=|>|<|=)?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function parseContentPackDependency(value: string): ParsedContentPackDependency | null {
  const match = /^([a-z][a-z0-9_]{1,63})(?:@((?:\^|~|>=|<=|>|<|=)?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?))?$/.exec(value.trim());
  return match ? { id: match[1], ...(match[2] ? { range: match[2] } : {}) } : null;
}

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

function parseVersion(value: string): ParsedVersion | null {
  const match = SEMVER_PATTERN.exec(value.trim());
  return match ? {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    ...(match[4] ? { prerelease: match[4] } : {}),
  } : null;
}

function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
  }
  if (!left.prerelease && right.prerelease) return 1;
  if (left.prerelease && !right.prerelease) return -1;
  return (left.prerelease ?? "").localeCompare(right.prerelease ?? "");
}

/** Supports exact, ^, ~, and single comparator ranges used by content-pack manifests. */
export function satisfiesContentPackVersion(version: string, range?: string): boolean {
  if (!range) return Boolean(parseVersion(version));
  const actual = parseVersion(version);
  const match = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(range.trim());
  const expected = match ? parseVersion(match[2]) : null;
  if (!actual || !expected || !match) return false;
  const comparison = compareVersions(actual, expected);
  switch (match[1] ?? "=") {
    case "^": return actual.major === expected.major && comparison >= 0;
    case "~": return actual.major === expected.major && actual.minor === expected.minor && comparison >= 0;
    case ">=": return comparison >= 0;
    case "<=": return comparison <= 0;
    case ">": return comparison > 0;
    case "<": return comparison < 0;
    default: return comparison === 0;
  }
}

function uniqueIds<T extends { id: string }>(entries: T[], path: string, issues: ModValidationIssue[]): Set<string> {
  const ids = new Set<string>();
  entries.forEach((entry, index) => {
    if (ids.has(entry.id)) issues.push({ severity: "error", code: "duplicate-id", path: `${path}[${index}].id`, message: `重复的内容 ID：${entry.id}` });
    ids.add(entry.id);
  });
  return ids;
}

function parseManifest(value: unknown, issues: ModValidationIssue[], context?: ContentPackValidationContext): ContentPackManifest | null {
  if (!isRecord(value)) {
    issues.push({ severity: "error", code: "root", path: "$", message: "内容包根节点必须是对象" });
    return null;
  }
  const formatVersion = typeof value.formatVersion === "number" ? Math.floor(value.formatVersion) : 0;
  if (formatVersion !== 1 && formatVersion !== MOD_FORMAT_VERSION) {
    issues.push({ severity: "error", code: "format-version", path: "$.formatVersion", message: `内容包格式必须为 v1 或 v${MOD_FORMAT_VERSION}` });
  }
  for (const [key, label] of [["id", "内容包 ID"], ["name", "内容包名称"], ["version", "版本号"]] as const) {
    if (!nonEmpty(value[key])) issues.push({ severity: "error", code: "metadata", path: `$.${key}`, message: `${label}不能为空` });
  }
  if (value.id !== undefined && !validId(value.id)) issues.push({ severity: "error", code: "id-format", path: "$.id", message: "内容包 ID 只能使用小写字母、数字和下划线" });
  if (typeof value.version === "string" && !parseVersion(value.version)) issues.push({ severity: "error", code: "version-format", path: "$.version", message: "内容包版本必须使用语义版本号，例如 1.2.0" });
  const dependencies = value.dependencies === undefined ? [] : value.dependencies;
  if (!Array.isArray(dependencies) || dependencies.length > 32 || !dependencies.every((entry) => typeof entry === "string" && parseContentPackDependency(entry))) {
    issues.push({ severity: "error", code: "dependencies", path: "$.dependencies", message: "依赖必须是内容包 ID 或 ID@版本范围，例如 core_pack@^1.2.0" });
  }
  const items = Array.isArray(value.items) ? value.items : [];
  const buildings = Array.isArray(value.buildings) ? value.buildings : [];
  const recipes = Array.isArray(value.recipes) ? value.recipes : [];
  const technologies = Array.isArray(value.technologies) ? value.technologies : [];
  const buildingOverrides = formatVersion >= 2 && Array.isArray(value.buildingOverrides) ? value.buildingOverrides : [];
  const belts = formatVersion >= 2 && Array.isArray(value.belts) ? value.belts : [];
  if (items.length > 256 || buildings.length > 128 || recipes.length > 512 || technologies.length > 256 || buildingOverrides.length > 128 || belts.length > 29) {
    issues.push({ severity: "error", code: "size-limit", path: "$", message: "内容包超过单包内容数量上限" });
  }

  const validItems = items.filter(isRecord).flatMap((entry, index) => {
    if (!validId(entry.id) || !nonEmpty(entry.name)) {
      issues.push({ severity: "error", code: "item-shape", path: `$.items[${index}]`, message: "物品需要合法 id 和 name" });
      return [];
    }
    const kind = entry.kind;
    if (kind !== undefined && kind !== "solid" && kind !== "fluid" && kind !== "matrix") {
      issues.push({ severity: "error", code: "item-kind", path: `$.items[${index}].kind`, message: "物品类型必须是 solid、fluid 或 matrix" });
    }
    return [{ id: entry.id, name: entry.name.trim().slice(0, 80), ...(typeof entry.symbol === "string" ? { symbol: entry.symbol.slice(0, 8) } : {}), ...(typeof entry.color === "string" ? { color: entry.color.slice(0, 16) } : {}), ...(kind === "solid" || kind === "fluid" || kind === "matrix" ? { kind } : {}), ...(typeof entry.description === "string" ? { description: entry.description.trim().slice(0, 240) } : {}) }];
  });
  const validBuildings = buildings.filter(isRecord).flatMap((entry, index) => {
    if (!validId(entry.id) || !nonEmpty(entry.name)) {
      issues.push({ severity: "error", code: "building-shape", path: `$.buildings[${index}]`, message: "建筑需要合法 id 和 name" });
      return [];
    }
    const kind = entry.kind;
    if (kind !== undefined && !["machine", "miner", "power", "storage", "splitter", "station"].includes(kind)) {
      issues.push({ severity: "error", code: "building-kind", path: `$.buildings[${index}].kind`, message: "建筑类型无效" });
    }
    const accepts = entry.accepts;
    if (accepts !== undefined && !["solid", "fluid", "any"].includes(accepts)) {
      issues.push({ severity: "error", code: "building-accepts", path: `$.buildings[${index}].accepts`, message: "建筑物品类型限制无效" });
    }
    const family = entry.family;
    if (family !== undefined && family !== "smelter" && family !== "assembler" && family !== "chemical") {
      issues.push({ severity: "error", code: "building-family", path: `$.buildings[${index}].family`, message: "通用配方族只能是 smelter、assembler 或 chemical" });
    }
    const numericKeys = ["speed", "inputCapacity", "outputCapacity", "powerDemandKw", "powerGenerationKw", "outputAmount"] as const;
    for (const key of numericKeys) if (entry[key] !== undefined && (typeof entry[key] !== "number" || !Number.isFinite(entry[key]) || entry[key] < 0 || entry[key] > 1_000_000)) {
      issues.push({ severity: "error", code: "building-number", path: `$.buildings[${index}].${key}`, message: "建筑数值必须是有限的非负数" });
    }
    if (entry.requiredTechId !== undefined && !validId(entry.requiredTechId)) issues.push({ severity: "error", code: "building-tech", path: `$.buildings[${index}].requiredTechId`, message: "建筑解锁科技 ID 无效" });
    if (entry.upgradeTargetId !== undefined && !validId(entry.upgradeTargetId)) issues.push({ severity: "error", code: "building-upgrade", path: `$.buildings[${index}].upgradeTargetId`, message: "建筑升级目标 ID 无效" });
    if (entry.costs !== undefined && !amountList(entry.costs)) issues.push({ severity: "error", code: "building-costs", path: `$.buildings[${index}].costs`, message: "建筑成本必须是合法物品数量数组" });
    if (entry.stackLimit !== undefined && (!Number.isInteger(entry.stackLimit) || entry.stackLimit < 1 || entry.stackLimit > 100_000_000)) issues.push({ severity: "error", code: "building-stack-limit", path: `$.buildings[${index}].stackLimit`, message: "建筑堆叠上限必须是 1～100,000,000 的整数" });
    for (const key of ["layoutWidth", "layoutHeight", "layoutClearance"] as const) {
      const candidate = entry[key];
      if (candidate !== undefined && (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < (key === "layoutClearance" ? 0 : 1) || candidate > 10_000)) {
        issues.push({ severity: "error", code: "building-layout", path: `$.buildings[${index}].${key}`, message: "建筑布局尺寸必须位于安全范围" });
      }
    }
    const capabilities = entry.capabilities === undefined ? [] : entry.capabilities;
    if (!Array.isArray(capabilities) || capabilities.length > 64 || !capabilities.every(validId) || new Set(capabilities).size !== capabilities.length) {
      issues.push({ severity: "error", code: "building-capabilities", path: `$.buildings[${index}].capabilities`, message: "建筑能力必须是最多 64 个不重复的合法 ID" });
    }
    const ports = entry.ports === undefined ? [] : entry.ports;
    if (!Array.isArray(ports) || ports.length > 32 || !ports.every((port) => isRecord(port) &&
      Number.isInteger(port.index) && port.index >= 0 && port.index < 32 &&
      ["input", "output", "bidirectional"].includes(port.direction) &&
      ["solid", "fluid", "matrix", "any"].includes(port.accepts) &&
      (port.maxConnections === undefined || (Number.isInteger(port.maxConnections) && port.maxConnections >= 1 && port.maxConnections <= 16)) &&
      (port.special === undefined || validId(port.special)))) {
      issues.push({ severity: "error", code: "building-ports", path: `$.buildings[${index}].ports`, message: "建筑端口声明无效" });
    } else if (new Set(ports.map((port) => `${port.index}:${port.direction}`)).size !== ports.length) {
      issues.push({ severity: "error", code: "building-port-duplicate", path: `$.buildings[${index}].ports`, message: "同方向建筑端口索引不能重复" });
    }
    for (const key of ["megastructure", "unique", "scripted"] as const) if (entry[key] !== undefined && typeof entry[key] !== "boolean") {
      issues.push({ severity: "error", code: "building-flag", path: `$.buildings[${index}].${key}`, message: "建筑能力标记必须是布尔值" });
    }
    return [{
      id: entry.id,
      name: entry.name.trim().slice(0, 80),
      ...(typeof entry.shortName === "string" ? { shortName: entry.shortName.trim().slice(0, 24) } : {}),
      ...(kind ? { kind } : {}),
      ...numericKeys.reduce((result, key) => typeof entry[key] === "number" && Number.isFinite(entry[key]) ? { ...result, [key]: entry[key] } : result, {} as Record<string, number>),
      ...(accepts === "solid" || accepts === "fluid" || accepts === "any" ? { accepts } : {}),
      ...(family === "smelter" || family === "assembler" || family === "chemical" ? { family } : {}),
      ...(typeof entry.description === "string" ? { description: entry.description.trim().slice(0, 240) } : {}),
      ...(typeof entry.requiredTechId === "string" ? { requiredTechId: entry.requiredTechId } : {}),
      ...(typeof entry.upgradeTargetId === "string" ? { upgradeTargetId: entry.upgradeTargetId } : {}),
      ...(Array.isArray(entry.costs) ? { costs: entry.costs } : {}),
      ...(typeof entry.stackLimit === "number" ? { stackLimit: Math.floor(entry.stackLimit) } : {}),
      ...(typeof entry.megastructure === "boolean" ? { megastructure: entry.megastructure } : {}),
      ...(typeof entry.unique === "boolean" ? { unique: entry.unique } : {}),
      ...(typeof entry.scripted === "boolean" ? { scripted: entry.scripted } : {}),
      ...(typeof entry.layoutWidth === "number" ? { layoutWidth: entry.layoutWidth } : {}),
      ...(typeof entry.layoutHeight === "number" ? { layoutHeight: entry.layoutHeight } : {}),
      ...(typeof entry.layoutClearance === "number" ? { layoutClearance: entry.layoutClearance } : {}),
      ...(Array.isArray(ports) ? { ports: ports.map((port) => ({ ...port })) } : {}),
      ...(Array.isArray(capabilities) ? { capabilities: [...capabilities] } : {}),
    }];
  });
  const validTechnologies = technologies.filter(isRecord).flatMap((entry, index) => {
    if (!validId(entry.id) || !nonEmpty(entry.name)) {
      issues.push({ severity: "error", code: "technology-shape", path: `$.technologies[${index}]`, message: "科技需要合法 id 和 name" });
      return [];
    }
    const prerequisites = entry.prerequisites === undefined ? [] : entry.prerequisites;
    if (!Array.isArray(prerequisites) || !prerequisites.every(validId)) {
      issues.push({ severity: "error", code: "technology-prerequisites", path: `$.technologies[${index}].prerequisites`, message: "科技前置必须是合法 ID 数组" });
    }
    if (entry.tier !== undefined && (typeof entry.tier !== "number" || !Number.isFinite(entry.tier) || entry.tier < 0 || entry.tier > 99)) {
      issues.push({ severity: "error", code: "technology-tier", path: `$.technologies[${index}].tier`, message: "科技层级必须是 0 到 99 之间的数值" });
    }
    if (entry.costs !== undefined && !amountList(entry.costs)) issues.push({ severity: "error", code: "technology-costs", path: `$.technologies[${index}].costs`, message: "科技成本必须是合法物品数量数组" });
    if (entry.unlocks !== undefined && (!Array.isArray(entry.unlocks) || !entry.unlocks.every(nonEmpty))) issues.push({ severity: "error", code: "technology-unlocks", path: `$.technologies[${index}].unlocks`, message: "科技解锁说明必须是文本数组" });
    return [{ id: entry.id, name: entry.name.trim().slice(0, 80), prerequisites: Array.isArray(prerequisites) ? prerequisites : [], ...(typeof entry.tier === "number" ? { tier: Math.floor(entry.tier) } : {}), ...(typeof entry.summary === "string" ? { summary: entry.summary.trim().slice(0, 240) } : {}), ...(Array.isArray(entry.costs) ? { costs: entry.costs } : {}), ...(Array.isArray(entry.unlocks) ? { unlocks: entry.unlocks.map((unlock) => String(unlock).trim().slice(0, 80)) } : {}) }];
  });
  const validRecipes = recipes.filter(isRecord).flatMap((entry, index) => {
    if (!validId(entry.id) || !nonEmpty(entry.name) || !validId(entry.buildingId) || typeof entry.duration !== "number" || !Number.isFinite(entry.duration) || entry.duration <= 0 || entry.duration > 86_400 || !amountList(entry.inputs) || !amountList(entry.outputs)) {
      issues.push({ severity: "error", code: "recipe-shape", path: `$.recipes[${index}]`, message: "配方需要合法 id、设备、周期以及输入输出" });
      return [];
    }
    if (entry.requiredTechId !== undefined && !validId(entry.requiredTechId)) issues.push({ severity: "error", code: "recipe-tech", path: `$.recipes[${index}].requiredTechId`, message: "配方科技 ID 无效" });
    return [{ id: entry.id, name: entry.name.trim().slice(0, 80), buildingId: entry.buildingId, duration: entry.duration, ...(entry.requiredTechId ? { requiredTechId: entry.requiredTechId } : {}), inputs: entry.inputs, outputs: entry.outputs }];
  });
  const coreBuildings = new Set(Object.keys(BUILDINGS));
  const overrideRanges = {
    speed: [0.01, 1_000],
    inputCapacity: [0, 100_000_000],
    outputCapacity: [0, 100_000_000],
    powerDemandKw: [0, 1_000_000_000_000],
    powerGenerationKw: [0, 1_000_000_000_000],
    powerChargeKw: [0, 1_000_000_000_000],
    energyCapacityMj: [0, 1_000_000_000_000],
    stackLimit: [1, 1_000_000],
  } as const;
  const validBuildingOverrides = buildingOverrides.filter(isRecord).flatMap((entry, index) => {
    if (!validId(entry.id) || !coreBuildings.has(entry.id)) {
      issues.push({ severity: "error", code: "building-override-id", path: `$.buildingOverrides[${index}].id`, message: "白名单覆盖只能引用现有核心建筑" });
      return [];
    }
    const normalized: Record<string, number | string> = { id: entry.id };
    let count = 0;
    for (const [key, range] of Object.entries(overrideRanges)) {
      const candidate = entry[key];
      if (candidate === undefined) continue;
      count += 1;
      if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < range[0] || candidate > range[1] ||
        ((key === "inputCapacity" || key === "outputCapacity" || key === "stackLimit") && !Number.isInteger(candidate))) {
        issues.push({ severity: "error", code: "building-override-value", path: `$.buildingOverrides[${index}].${key}`, message: `${key} 超出安全范围` });
        continue;
      }
      normalized[key] = candidate;
    }
    if (count === 0) issues.push({ severity: "error", code: "building-override-empty", path: `$.buildingOverrides[${index}]`, message: "建筑覆盖至少需要一个白名单数值字段" });
    return [normalized as unknown as ModBuildingOverride];
  });
  const validBelts = belts.filter(isRecord).flatMap((entry, index) => {
    if (!validId(entry.id) || !nonEmpty(entry.name) || !Number.isInteger(entry.tier) || entry.tier < 4 || entry.tier > 32 ||
      typeof entry.speed !== "number" || !Number.isFinite(entry.speed) || entry.speed <= 0 || entry.speed > 1_000_000 || !amountList(entry.costs)) {
      issues.push({ severity: "error", code: "belt-shape", path: `$.belts[${index}]`, message: "自定义传送带需要合法 ID、4～32 级、速度和制造成本" });
      return [];
    }
    if (entry.requiredTechId !== undefined && !validId(entry.requiredTechId)) issues.push({ severity: "error", code: "belt-tech", path: `$.belts[${index}].requiredTechId`, message: "传送带科技 ID 无效" });
    if (entry.outputAmount !== undefined && (!Number.isInteger(entry.outputAmount) || entry.outputAmount < 1 || entry.outputAmount > 1_000)) issues.push({ severity: "error", code: "belt-output", path: `$.belts[${index}].outputAmount`, message: "传送带单批产出必须为 1～1000 的整数" });
    return [{ id: entry.id, name: entry.name.trim().slice(0, 80), tier: entry.tier, speed: entry.speed, costs: entry.costs, ...(entry.requiredTechId ? { requiredTechId: entry.requiredTechId } : {}), ...(entry.outputAmount ? { outputAmount: entry.outputAmount } : {}) }];
  });

  const itemIds = uniqueIds(validItems, "$.items", issues);
  const buildingIds = uniqueIds(validBuildings, "$.buildings", issues);
  const recipeIds = uniqueIds(validRecipes, "$.recipes", issues);
  const technologyIds = uniqueIds(validTechnologies, "$.technologies", issues);
  const coreItems = new Set(Object.keys(ITEMS));
  const coreRecipes = new Set(Object.keys(RECIPES));
  const coreTechnologies = new Set(Object.keys(TECHNOLOGIES));
  for (const id of itemIds) if (coreItems.has(id)) issues.push({ severity: "error", code: "override-item", path: "$.items", message: `不能覆盖核心物品 ${id}` });
  for (const id of buildingIds) if (coreBuildings.has(id)) issues.push({ severity: "error", code: "override-building", path: "$.buildings", message: `不能覆盖核心建筑 ${id}` });
  for (const id of recipeIds) if (coreRecipes.has(id)) issues.push({ severity: "error", code: "override-recipe", path: "$.recipes", message: `不能覆盖核心配方 ${id}` });
  for (const id of technologyIds) if (coreTechnologies.has(id)) issues.push({ severity: "error", code: "override-technology", path: "$.technologies", message: `不能覆盖核心科技 ${id}` });
  const allItems = new Set([...coreItems, ...(context?.itemIds ?? []), ...itemIds]);
  const allBuildings = new Set([...coreBuildings, ...(context?.buildingIds ?? []), ...buildingIds]);
  const allTechnologies = new Set([...coreTechnologies, ...(context?.technologyIds ?? []), ...technologyIds]);
  if (new Set(validBelts.map((belt) => belt.id)).size !== validBelts.length || new Set(validBelts.map((belt) => belt.tier)).size !== validBelts.length) {
    issues.push({ severity: "error", code: "belt-duplicate", path: "$.belts", message: "自定义传送带 ID 和等级必须唯一" });
  }
  const registeredBuildingIds = new Set(context?.buildingIds ?? []);
  for (const belt of validBelts) {
    if (buildingIds.has(belt.id)) issues.push({ severity: "error", code: "belt-building-id-conflict", path: `$.belts.${belt.id}`, message: `传送带 ID ${belt.id} 不能与同包建筑 ID 相同` });
    if (registeredBuildingIds.has(belt.id)) issues.push({ severity: "error", code: "belt-building-id-conflict", path: `$.belts.${belt.id}`, message: `传送带 ID ${belt.id} 不能与已注册建筑 ID 相同` });
    if (coreBuildings.has(belt.id) || coreItems.has(belt.id) || coreRecipes.has(belt.id) || coreTechnologies.has(belt.id)) issues.push({ severity: "error", code: "belt-id-conflict", path: `$.belts.${belt.id}`, message: `传送带 ID ${belt.id} 与核心目录冲突` });
    if (belt.requiredTechId && !allTechnologies.has(belt.requiredTechId)) issues.push({ severity: "error", code: "belt-tech", path: `$.belts.${belt.id}`, message: `传送带引用未知科技 ${belt.requiredTechId}` });
    for (const cost of belt.costs) if (!allItems.has(cost.itemId)) issues.push({ severity: "error", code: "belt-cost", path: `$.belts.${belt.id}`, message: `传送带引用未知物品 ${cost.itemId}` });
  }
  for (const recipe of validRecipes) {
    if (!allBuildings.has(recipe.buildingId)) issues.push({ severity: "error", code: "recipe-building", path: `$.recipes.${recipe.id}`, message: `配方引用未知建筑 ${recipe.buildingId}` });
    if (recipe.requiredTechId && !allTechnologies.has(recipe.requiredTechId)) issues.push({ severity: "error", code: "recipe-tech", path: `$.recipes.${recipe.id}`, message: `配方引用未知科技 ${recipe.requiredTechId}` });
    for (const entry of [...recipe.inputs, ...recipe.outputs]) if (!allItems.has(entry.itemId)) issues.push({ severity: "error", code: "recipe-item", path: `$.recipes.${recipe.id}`, message: `配方引用未知物品 ${entry.itemId}` });
  }
  for (const building of validBuildings) {
    if (building.upgradeTargetId && (!allBuildings.has(building.upgradeTargetId) || building.upgradeTargetId === building.id)) {
      issues.push({ severity: "error", code: "building-upgrade", path: `$.buildings.${building.id}`, message: `建筑升级目标 ${building.upgradeTargetId} 不存在或指向自身` });
    }
  }
  for (const technology of validTechnologies) for (const prerequisite of technology.prerequisites ?? []) if (!allTechnologies.has(prerequisite)) issues.push({ severity: "error", code: "technology-prerequisite", path: `$.technologies.${technology.id}`, message: `科技引用未知前置 ${prerequisite}` });

  return {
    formatVersion,
    id: typeof value.id === "string" ? value.id : "",
    name: typeof value.name === "string" ? value.name.trim().slice(0, 120) : "",
    version: typeof value.version === "string" ? value.version.trim().slice(0, 40) : "",
    ...(typeof value.author === "string" ? { author: value.author.trim().slice(0, 80) } : {}),
    ...(typeof value.description === "string" ? { description: value.description.trim().slice(0, 240) } : {}),
    dependencies: Array.isArray(dependencies) ? [...new Set(dependencies.filter((entry): entry is string => typeof entry === "string" && Boolean(parseContentPackDependency(entry))).map((entry) => entry.trim()))] : [],
    items: validItems,
    buildings: validBuildings,
    recipes: validRecipes,
    technologies: validTechnologies,
    buildingOverrides: validBuildingOverrides,
    belts: validBelts,
  };
}

export function validateContentPack(value: unknown, context?: ContentPackValidationContext): ModValidationResult {
  const issues: ModValidationIssue[] = [];
  const coreAudit = validateContentCatalog();
  for (const issue of coreAudit.issues.filter((candidate) => candidate.severity === "error")) {
    issues.push({ severity: "error", code: `core-${issue.code}`, path: issue.id, message: `核心目录异常：${issue.message}` });
  }
  const manifest = parseManifest(value, issues, context);
  return {
    valid: Boolean(manifest) && issues.every((issue) => issue.severity !== "error"),
    manifest,
    issues,
    counts: {
      items: manifest?.items?.length ?? 0,
      buildings: manifest?.buildings?.length ?? 0,
      recipes: manifest?.recipes?.length ?? 0,
      technologies: manifest?.technologies?.length ?? 0,
    },
  };
}

export function parseContentPack(raw: string, context?: ContentPackValidationContext): ModValidationResult {
  try {
    return validateContentPack(JSON.parse(raw), context);
  } catch {
    return {
      valid: false,
      manifest: null,
      issues: [{ severity: "error", code: "json", path: "$", message: "内容包不是有效 JSON" }],
      counts: { items: 0, buildings: 0, recipes: 0, technologies: 0 },
    };
  }
}

export function createContentPackTemplate(): ContentPackManifest {
  return {
    formatVersion: MOD_FORMAT_VERSION,
    id: "my_content_pack",
    name: "我的内容包",
    version: "0.1.0",
    author: "",
    description: "只扩展新 ID，不覆盖核心目录。",
    dependencies: [],
    items: [],
    buildings: [],
    recipes: [],
    technologies: [],
    buildingOverrides: [],
    belts: [],
  };
}
