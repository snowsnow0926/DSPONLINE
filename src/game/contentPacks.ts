import { BUILDINGS, CONSTRUCTION, ITEMS, RECIPES, TECHNOLOGIES, TECHNOLOGY_LIST, registerRuntimeBeltDefinition, resetRuntimeBeltDefinitions, validateContentCatalog } from "./content";
import {
  parseContentPackDependency,
  satisfiesContentPackVersion,
  validateContentPack,
  type ContentPackValidationContext,
  type ContentPackManifest,
  type ModValidationResult,
} from "./mods";
import type {
  BuildingDefinition,
  BuildingId,
  ConstructionDefinition,
  GameState,
  ItemDefinition,
  ItemId,
  RecipeDefinition,
  RecipeId,
  TechnologyDefinition,
  TechId,
} from "./types";

const CONTENT_PACK_STORAGE_KEY = "dsp-idle-network.content-packs.v1";
const REGISTRY_VERSION = 1;
export const CONTENT_PACK_RUNTIME_PROTOCOL_VERSION = 1 as const;

const CORE_ITEM_IDS = new Set(Object.keys(ITEMS));
const CORE_BUILDING_IDS = new Set(Object.keys(BUILDINGS));
const CORE_RECIPE_IDS = new Set(Object.keys(RECIPES));
const CORE_TECH_IDS = new Set(Object.keys(TECHNOLOGIES));
const CORE_BUILDING_DEFINITIONS = new Map(Object.entries(BUILDINGS).map(([id, definition]) => [id, { ...definition }]));
const CORE_CONSTRUCTION_LENGTH = CONSTRUCTION.length;
const CORE_TECHNOLOGY_LENGTH = TECHNOLOGY_LIST.length;

type RuntimeItems = Record<string, ItemDefinition>;
type RuntimeBuildings = Record<string, BuildingDefinition>;
type RuntimeRecipes = Record<string, RecipeDefinition>;
type RuntimeTechnologies = Record<string, TechnologyDefinition>;

export interface RegisteredContentPack {
  manifest: ContentPackManifest;
  enabled: boolean;
  installedAt: number;
  updatedAt: number;
}

export interface ContentPackRegistry {
  version: typeof REGISTRY_VERSION;
  packs: Record<string, RegisteredContentPack>;
}

/** Serializable runtime directory sent to simulation workers; never persisted in GameState. */
export interface ContentPackRuntimeSnapshot {
  protocolVersion: typeof CONTENT_PACK_RUNTIME_PROTOCOL_VERSION;
  fingerprint: string;
  registry: ContentPackRegistry;
}

export interface ContentPackDependencyStatus {
  specifier: string;
  id: string;
  range?: string;
  installed: boolean;
  enabled: boolean;
  version?: string;
  satisfied: boolean;
  reason: string;
}

export interface ContentPackActivationReport {
  activePackIds: string[];
  blockedPackIds: string[];
  catalogValid: boolean;
  issues: string[];
}

export interface ContentPackUsage {
  total: number;
  entries: string[];
}

export function createContentPackRegistry(): ContentPackRegistry {
  return { version: REGISTRY_VERSION, packs: {} };
}

function getStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function cloneManifest(manifest: ContentPackManifest): ContentPackManifest {
  return {
    ...manifest,
    dependencies: [...(manifest.dependencies ?? [])],
    items: manifest.items?.map((item) => ({ ...item })),
    buildings: manifest.buildings?.map((building) => ({ ...building, costs: building.costs?.map((cost) => ({ ...cost })) })),
    recipes: manifest.recipes?.map((recipe) => ({ ...recipe, inputs: recipe.inputs.map((input) => ({ ...input })), outputs: recipe.outputs.map((output) => ({ ...output })) })),
    technologies: manifest.technologies?.map((technology) => ({ ...technology, prerequisites: [...(technology.prerequisites ?? [])], costs: technology.costs?.map((cost) => ({ ...cost })), unlocks: technology.unlocks ? [...technology.unlocks] : undefined })),
    buildingOverrides: manifest.buildingOverrides?.map((override) => ({ ...override })),
    belts: manifest.belts?.map((belt) => ({ ...belt, costs: belt.costs.map((cost) => ({ ...cost })) })),
  };
}

function cloneRegistry(registry: ContentPackRegistry): ContentPackRegistry {
  return {
    version: REGISTRY_VERSION,
    packs: Object.fromEntries(Object.entries(registry.packs).sort(([left], [right]) => left.localeCompare(right)).map(([id, pack]) => [id, {
      ...pack,
      manifest: cloneManifest(pack.manifest),
    }])),
  };
}

function stableSerialize(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(",")}}`;
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function getContentPackRegistryFingerprint(registry: ContentPackRegistry): string {
  return hashString(stableSerialize(cloneRegistry(registry)));
}

export function createContentPackRuntimeSnapshot(registry: ContentPackRegistry): ContentPackRuntimeSnapshot {
  const normalized = cloneRegistry(registry);
  return {
    protocolVersion: CONTENT_PACK_RUNTIME_PROTOCOL_VERSION,
    fingerprint: getContentPackRegistryFingerprint(normalized),
    registry: normalized,
  };
}

export function validateContentPackRuntimeSnapshot(snapshot: ContentPackRuntimeSnapshot | null | undefined): boolean {
  return Boolean(snapshot &&
    snapshot.protocolVersion === CONTENT_PACK_RUNTIME_PROTOCOL_VERSION &&
    snapshot.registry?.version === REGISTRY_VERSION &&
    snapshot.fingerprint === getContentPackRegistryFingerprint(snapshot.registry));
}

/** Validate and activate the exact catalog snapshot used for one simulation boundary. */
export function applyContentPackRuntimeSnapshot(snapshot: ContentPackRuntimeSnapshot | null | undefined): ContentPackActivationReport {
  if (!snapshot || !validateContentPackRuntimeSnapshot(snapshot)) throw new Error("内容包运行时注册表缺失或指纹不匹配");
  const report = applyContentPackRegistry(snapshot.registry);
  if (!report.catalogValid) throw new Error(`内容包运行时目录校验失败：${report.issues.join("；")}`);
  return report;
}

function normalizeRegistry(value: unknown): ContentPackRegistry {
  if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== REGISTRY_VERSION) return createContentPackRegistry();
  const rawPacks = (value as { packs?: unknown }).packs;
  if (!rawPacks || typeof rawPacks !== "object" || Array.isArray(rawPacks)) return createContentPackRegistry();
  const packs: ContentPackRegistry["packs"] = {};
  for (const [id, candidate] of Object.entries(rawPacks as Record<string, unknown>)) {
    if (!candidate || typeof candidate !== "object") continue;
    const rawManifest = (candidate as { manifest?: unknown }).manifest;
    const validation = validateContentPack(rawManifest);
    if (!validation.manifest || validation.manifest.id !== id) continue;
    packs[id] = {
      manifest: cloneManifest(validation.manifest),
      enabled: Boolean((candidate as { enabled?: unknown }).enabled),
      installedAt: Number.isFinite((candidate as { installedAt?: unknown }).installedAt) ? Math.max(0, Number((candidate as { installedAt: number }).installedAt)) : Date.now(),
      updatedAt: Number.isFinite((candidate as { updatedAt?: unknown }).updatedAt) ? Math.max(0, Number((candidate as { updatedAt: number }).updatedAt)) : Date.now(),
    };
  }
  return { version: REGISTRY_VERSION, packs };
}

export function loadContentPackRegistry(): ContentPackRegistry {
  const storage = getStorage();
  if (!storage) return createContentPackRegistry();
  try {
    const raw = storage.getItem(CONTENT_PACK_STORAGE_KEY);
    return raw ? normalizeRegistry(JSON.parse(raw)) : createContentPackRegistry();
  } catch {
    return createContentPackRegistry();
  }
}

export function saveContentPackRegistry(registry: ContentPackRegistry): boolean {
  const storage = getStorage();
  if (!storage) return false;
  try {
    storage.setItem(CONTENT_PACK_STORAGE_KEY, JSON.stringify(cloneRegistry(registry)));
    return true;
  } catch {
    return false;
  }
}

export function getContentPackDependencyStatuses(registry: ContentPackRegistry, manifest: ContentPackManifest): ContentPackDependencyStatus[] {
  return (manifest.dependencies ?? []).flatMap((specifier) => {
    const parsed = parseContentPackDependency(specifier);
    if (!parsed) return [];
    const dependency = registry.packs[parsed.id];
    const installed = Boolean(dependency);
    const enabled = Boolean(dependency?.enabled);
    const version = dependency?.manifest.version;
    const versionMatches = Boolean(version && satisfiesContentPackVersion(version, parsed.range));
    const satisfied = installed && enabled && versionMatches;
    const reason = !installed
      ? "未安装"
      : !versionMatches
        ? `版本 ${version} 不满足 ${parsed.range ?? "所需范围"}`
        : !enabled
          ? "已安装但未启用"
          : "就绪";
    return [{ specifier, id: parsed.id, range: parsed.range, installed, enabled, version, satisfied, reason }];
  });
}

function dependentPackIds(registry: ContentPackRegistry, dependencyId: string): string[] {
  return Object.values(registry.packs)
    .filter((pack) => pack.enabled && (pack.manifest.dependencies ?? []).some((specifier) => parseContentPackDependency(specifier)?.id === dependencyId))
    .map((pack) => pack.manifest.id);
}

export function getContentPackConflicts(registry: ContentPackRegistry, manifest: ContentPackManifest): string[] {
  const items = new Set(manifest.items?.map((item) => item.id) ?? []);
  const buildings = new Set(manifest.buildings?.map((building) => building.id) ?? []);
  const recipes = new Set(manifest.recipes?.map((recipe) => recipe.id) ?? []);
  const technologies = new Set(manifest.technologies?.map((technology) => technology.id) ?? []);
  const overrides = new Set(manifest.buildingOverrides?.map((override) => override.id) ?? []);
  const beltIds = new Set(manifest.belts?.map((belt) => belt.id) ?? []);
  const beltTiers = new Set(manifest.belts?.map((belt) => belt.tier) ?? []);
  const conflicts: string[] = [];
  for (const pack of Object.values(registry.packs)) {
    if (pack.manifest.id === manifest.id) continue;
    const existingBuildingIds = new Set(pack.manifest.buildings?.map((building) => building.id) ?? []);
    const existingBeltIds = new Set(pack.manifest.belts?.map((belt) => belt.id) ?? []);
    for (const item of pack.manifest.items ?? []) if (items.has(item.id)) conflicts.push(`物品 ${item.id} 已由 ${pack.manifest.name} 提供`);
    for (const building of pack.manifest.buildings ?? []) {
      if (buildings.has(building.id)) conflicts.push(`建筑 ${building.id} 已由 ${pack.manifest.name} 提供`);
      if (beltIds.has(building.id)) conflicts.push(`建筑 ${building.id} 与 ${pack.manifest.name} 的传送带 ID 冲突`);
    }
    for (const recipe of pack.manifest.recipes ?? []) if (recipes.has(recipe.id)) conflicts.push(`配方 ${recipe.id} 已由 ${pack.manifest.name} 提供`);
    for (const technology of pack.manifest.technologies ?? []) if (technologies.has(technology.id)) conflicts.push(`科技 ${technology.id} 已由 ${pack.manifest.name} 提供`);
    for (const override of pack.manifest.buildingOverrides ?? []) if (overrides.has(override.id)) conflicts.push(`建筑 ${override.id} 已由 ${pack.manifest.name} 调整`);
    for (const belt of pack.manifest.belts ?? []) {
      if (beltIds.has(belt.id)) conflicts.push(`传送带 ${belt.id} 已由 ${pack.manifest.name} 提供`);
      if (beltTiers.has(belt.tier)) conflicts.push(`传送带等级 ${belt.tier} 已由 ${pack.manifest.name} 提供`);
      if (existingBuildingIds.has(belt.id)) conflicts.push(`传送带 ${belt.id} 与 ${pack.manifest.name} 的建筑 ID 冲突`);
    }
    for (const building of manifest.buildings ?? []) if (existingBeltIds.has(building.id)) conflicts.push(`建筑 ${building.id} 与 ${pack.manifest.name} 的传送带 ID 冲突`);
  }
  return [...new Set(conflicts)];
}

/** IDs contributed by registered packages, used to validate a dependent package before enabling it. */
export function getContentPackValidationContext(registry: ContentPackRegistry, excludePackId?: string): ContentPackValidationContext {
  const itemIds = new Set<string>();
  const buildingIds = new Set<string>();
  const technologyIds = new Set<string>();
  for (const pack of Object.values(registry.packs)) {
    if (pack.manifest.id === excludePackId) continue;
    for (const item of pack.manifest.items ?? []) itemIds.add(item.id);
    for (const building of pack.manifest.buildings ?? []) buildingIds.add(building.id);
    for (const technology of pack.manifest.technologies ?? []) technologyIds.add(technology.id);
  }
  return { itemIds, buildingIds, technologyIds };
}

export function registerContentPack(registry: ContentPackRegistry, validation: ModValidationResult, enable = true): { registry: ContentPackRegistry; enabled: boolean; reason?: string } {
  if (!validation.valid || !validation.manifest) return { registry, enabled: false, reason: "内容包未通过校验" };
  const conflicts = getContentPackConflicts(registry, validation.manifest);
  if (conflicts.length > 0) return { registry, enabled: false, reason: conflicts[0] };
  const next = cloneRegistry(registry);
  const previous = next.packs[validation.manifest.id];
  const now = Date.now();
  next.packs[validation.manifest.id] = {
    manifest: cloneManifest(validation.manifest),
    enabled: false,
    installedAt: previous?.installedAt ?? now,
    updatedAt: now,
  };
  const dependencies = getContentPackDependencyStatuses(next, validation.manifest);
  const ready = dependencies.every((dependency) => dependency.satisfied);
  next.packs[validation.manifest.id].enabled = enable && ready;
  return { registry: next, enabled: enable && ready, ...(enable && !ready ? { reason: dependencies.find((dependency) => !dependency.satisfied)?.reason ?? "依赖未就绪" } : {}) };
}

export function setContentPackEnabled(registry: ContentPackRegistry, packId: string, enabled: boolean): { registry: ContentPackRegistry; changed: boolean; reason?: string } {
  const current = registry.packs[packId];
  if (!current || current.enabled === enabled) return { registry, changed: false };
  if (!enabled) {
    const dependents = dependentPackIds(registry, packId);
    if (dependents.length > 0) return { registry, changed: false, reason: `仍被已启用的 ${dependents.join("、")} 依赖` };
  }
  const next = cloneRegistry(registry);
  if (enabled) {
    const dependencies = getContentPackDependencyStatuses(next, current.manifest);
    const blocked = dependencies.find((dependency) => !dependency.satisfied);
    if (blocked) return { registry, changed: false, reason: `${blocked.id}：${blocked.reason}` };
  }
  next.packs[packId] = { ...next.packs[packId], enabled, updatedAt: Date.now() };
  return { registry: next, changed: true };
}

export function removeContentPack(registry: ContentPackRegistry, packId: string): { registry: ContentPackRegistry; changed: boolean; reason?: string } {
  if (!registry.packs[packId]) return { registry, changed: false };
  const dependents = dependentPackIds(registry, packId);
  if (dependents.length > 0) return { registry, changed: false, reason: `仍被已启用的 ${dependents.join("、")} 依赖` };
  const next = cloneRegistry(registry);
  delete next.packs[packId];
  return { registry: next, changed: true };
}

function colorFor(id: string): string {
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  return `hsl(${hue} 42% 58%)`;
}

function activePacksInDependencyOrder(registry: ContentPackRegistry): { active: RegisteredContentPack[]; blocked: string[] } {
  const pending = new Map(Object.entries(registry.packs).filter(([, pack]) => pack.enabled));
  const active: RegisteredContentPack[] = [];
  while (pending.size > 0) {
    const ready = [...pending.entries()].filter(([, pack]) => getContentPackDependencyStatuses(registry, pack.manifest).every((dependency) => dependency.satisfied && !pending.has(dependency.id)));
    if (ready.length === 0) break;
    ready.sort(([left], [right]) => left.localeCompare(right));
    for (const [id, pack] of ready) {
      active.push(pack);
      pending.delete(id);
    }
  }
  return { active, blocked: [...pending.keys()].sort() };
}

function resetRuntimeContent(): void {
  const items = ITEMS as unknown as RuntimeItems;
  const buildings = BUILDINGS as unknown as RuntimeBuildings;
  const recipes = RECIPES as unknown as RuntimeRecipes;
  const technologies = TECHNOLOGIES as unknown as RuntimeTechnologies;
  for (const id of Object.keys(items)) if (!CORE_ITEM_IDS.has(id)) delete items[id];
  for (const id of Object.keys(buildings)) if (!CORE_BUILDING_IDS.has(id)) delete buildings[id];
  for (const [id, definition] of CORE_BUILDING_DEFINITIONS) buildings[id] = { ...definition };
  for (const id of Object.keys(recipes)) if (!CORE_RECIPE_IDS.has(id)) delete recipes[id];
  for (const id of Object.keys(technologies)) if (!CORE_TECH_IDS.has(id)) delete technologies[id];
  CONSTRUCTION.splice(CORE_CONSTRUCTION_LENGTH);
  TECHNOLOGY_LIST.splice(CORE_TECHNOLOGY_LENGTH);
  resetRuntimeBeltDefinitions();
}

function applyBuildingOverrides(packs: RegisteredContentPack[]): void {
  const buildings = BUILDINGS as unknown as RuntimeBuildings;
  for (const pack of packs) for (const override of pack.manifest.buildingOverrides ?? []) {
    const current = buildings[override.id];
    if (!current) continue;
    buildings[override.id] = {
      ...current,
      ...Object.fromEntries(Object.entries(override).filter(([key, value]) => key !== "id" && typeof value === "number")),
    } as BuildingDefinition;
  }
}

function registerItems(packs: RegisteredContentPack[]): void {
  const items = ITEMS as unknown as RuntimeItems;
  for (const pack of packs) for (const item of pack.manifest.items ?? []) {
    items[item.id] = {
      id: item.id as ItemId,
      name: item.name,
      symbol: item.symbol?.trim() || item.name.slice(0, 3),
      color: item.color?.trim() || colorFor(item.id),
      kind: item.kind ?? "solid",
      description: item.description?.trim() || `${pack.manifest.name} 提供的物品。`,
    };
  }
}

function registerBuildings(packs: RegisteredContentPack[]): void {
  const buildings = BUILDINGS as unknown as RuntimeBuildings;
  for (const pack of packs) for (const building of pack.manifest.buildings ?? []) {
    buildings[building.id] = {
      id: building.id as BuildingId,
      name: building.name,
      shortName: building.shortName?.trim() || building.name.slice(0, 8),
      kind: building.kind ?? "machine",
      speed: Math.max(0.01, building.speed ?? 1),
      inputCapacity: Math.max(1, Math.floor(building.inputCapacity ?? 100)),
      outputCapacity: Math.max(1, Math.floor(building.outputCapacity ?? 100)),
      accepts: building.accepts ?? "any",
      ...(building.family ? { family: building.family } : {}),
      ...(building.powerDemandKw !== undefined ? { powerDemandKw: Math.max(0, building.powerDemandKw) } : {}),
      ...(building.powerGenerationKw !== undefined ? { powerGenerationKw: Math.max(0, building.powerGenerationKw) } : {}),
      description: building.description?.trim() || `${pack.manifest.name} 提供的建筑。`,
    };
  }
}

function registerTechnologies(packs: RegisteredContentPack[]): void {
  const technologies = TECHNOLOGIES as unknown as RuntimeTechnologies;
  for (const pack of packs) for (const technology of pack.manifest.technologies ?? []) {
    const definition: TechnologyDefinition = {
      id: technology.id as TechId,
      name: technology.name,
      summary: technology.summary?.trim() || `${pack.manifest.name} 提供的科技。`,
      costs: (technology.costs ?? []).map((cost) => ({ itemId: cost.itemId as ItemId, amount: Math.max(1, Math.floor(cost.amount)) })),
      tier: Math.max(0, Math.min(99, Math.floor(technology.tier ?? 0))),
      prerequisites: (technology.prerequisites ?? []).map((id) => id as TechId),
      unlocks: technology.unlocks?.filter(Boolean) ?? [],
    };
    technologies[technology.id] = definition;
    TECHNOLOGY_LIST.push(definition);
  }
}

function registerRecipes(packs: RegisteredContentPack[]): void {
  const recipes = RECIPES as unknown as RuntimeRecipes;
  for (const pack of packs) for (const recipe of pack.manifest.recipes ?? []) {
    recipes[recipe.id] = {
      id: recipe.id as RecipeId,
      name: recipe.name,
      buildingId: recipe.buildingId as BuildingId,
      duration: Math.max(0.05, recipe.duration),
      inputs: recipe.inputs.map((input) => ({ itemId: input.itemId as ItemId, amount: Math.max(1, Math.floor(input.amount)) })),
      outputs: recipe.outputs.map((output) => ({ itemId: output.itemId as ItemId, amount: Math.max(1, Math.floor(output.amount)) })),
      ...(recipe.requiredTechId ? { requiredTechId: recipe.requiredTechId as TechId } : {}),
    };
  }
}

function registerConstruction(packs: RegisteredContentPack[]): void {
  for (const pack of packs) for (const building of pack.manifest.buildings ?? []) {
    if (!building.costs || building.costs.length === 0) continue;
    CONSTRUCTION.push({
      buildingId: building.id as ConstructionDefinition["buildingId"],
      name: building.name,
      outputAmount: Math.max(1, Math.floor(building.outputAmount ?? 1)),
      costs: building.costs.map((cost) => ({ itemId: cost.itemId as ItemId, amount: Math.max(1, Math.floor(cost.amount)) })),
      ...(building.requiredTechId ? { requiredTechId: building.requiredTechId as TechId } : {}),
    });
  }
}

function registerBelts(packs: RegisteredContentPack[]): void {
  for (const pack of packs) for (const belt of pack.manifest.belts ?? []) {
    if (!registerRuntimeBeltDefinition({ id: belt.id, tier: belt.tier, speed: belt.speed, name: belt.name })) continue;
    CONSTRUCTION.push({
      buildingId: belt.id,
      name: belt.name,
      outputAmount: Math.max(1, Math.floor(belt.outputAmount ?? 3)),
      costs: belt.costs.map((cost) => ({ itemId: cost.itemId as ItemId, amount: Math.max(1, Math.floor(cost.amount)) })),
      ...(belt.requiredTechId ? { requiredTechId: belt.requiredTechId as TechId } : {}),
    });
  }
}

/** Rebuild the live catalog from the enabled local registry. Call this before loading saves. */
export function applyContentPackRegistry(registry: ContentPackRegistry): ContentPackActivationReport {
  resetRuntimeContent();
  const { active, blocked } = activePacksInDependencyOrder(registry);
  registerItems(active);
  registerBuildings(active);
  applyBuildingOverrides(active);
  registerTechnologies(active);
  registerRecipes(active);
  registerConstruction(active);
  registerBelts(active);
  const audit = validateContentCatalog();
  return {
    activePackIds: active.map((pack) => pack.manifest.id),
    blockedPackIds: blocked,
    catalogValid: audit.valid,
    issues: audit.issues.map((issue) => `${issue.id}：${issue.message}`),
  };
}

export function getActiveContentPackReferences(registry: ContentPackRegistry): GameState["contentPacks"] {
  const { active } = activePacksInDependencyOrder(registry);
  return active.map((pack) => ({ id: pack.manifest.id, version: pack.manifest.version }));
}

export function getMissingContentPackRequirements(
  requirements: readonly { id: string; version: string }[],
  registry: ContentPackRegistry = loadContentPackRegistry(),
): string[] {
  return requirements.flatMap((requirement) => {
    const installed = registry.packs[requirement.id];
    if (!installed) return [`缺少内容包 ${requirement.id}@${requirement.version}`];
    if (!installed.enabled) return [`内容包 ${requirement.id}@${requirement.version} 已安装但未启用`];
    if (installed.manifest.version !== requirement.version) return [`内容包 ${requirement.id} 版本不匹配：存档需要 ${requirement.version}，当前为 ${installed.manifest.version}`];
    return [];
  });
}

export function getContentPackUsage(state: GameState, manifest: ContentPackManifest): ContentPackUsage {
  const itemIds = new Set(manifest.items?.map((item) => item.id) ?? []);
  const buildingIds = new Set(manifest.buildings?.map((building) => building.id) ?? []);
  const recipeIds = new Set(manifest.recipes?.map((recipe) => recipe.id) ?? []);
  const technologyIds = new Set(manifest.technologies?.map((technology) => technology.id) ?? []);
  const entries: string[] = [];
  const add = (label: string, count: number) => { if (count > 0) entries.push(`${label} ${count}`); };
  add("设备", state.entities.filter((entity) => entity.buildingId && buildingIds.has(entity.buildingId)).length);
  add("配方设备", state.entities.filter((entity) => entity.recipeId && recipeIds.has(entity.recipeId)).length);
  add("运输线", state.belts.filter((belt) => itemIds.has(belt.itemId)).length);
  add("科技记录", [...state.research.completedTechIds, ...state.research.queuedTechIds, state.research.selectedTechId]
    .flatMap((id) => id && technologyIds.has(id) ? [id] : []).length);
  const inventoryCount = [state.tray, ...Object.values(state.planetTrays), state.totalProduced]
    .reduce((sum, record) => sum + Object.entries(record).filter(([itemId, amount]) => itemIds.has(itemId) && Number(amount) > 0).length, 0);
  add("库存记录", inventoryCount);
  add("施工库存", Object.entries(state.construction).filter(([buildingId, amount]) => buildingIds.has(buildingId) && Number(amount) > 0).length);
  add("手持物品", state.cargo && itemIds.has(state.cargo.itemId) ? 1 : 0);
  add("手工队列", state.handcraftQueue.filter((entry) => recipeIds.has(entry.recipeId)).length);
  add("生产方案", state.productionPlans.filter((plan) => itemIds.has(plan.itemId) || Object.values(plan.recipeSelections).some((recipeId) => recipeId && recipeIds.has(recipeId))).length);
  add("配方聚焦", state.recipeFocus.itemId && itemIds.has(state.recipeFocus.itemId) ? 1 : 0);
  add("蓝图", state.blueprints.filter((blueprint) => blueprint.entities.some((entity) =>
    buildingIds.has(entity.buildingId) || (entity.recipeId ? recipeIds.has(entity.recipeId) : false)) || blueprint.belts.some((belt) => itemIds.has(belt.itemId))).length);
  return { total: entries.reduce((sum, entry) => sum + Number(entry.split(" ").at(-1) ?? 0), 0), entries };
}
