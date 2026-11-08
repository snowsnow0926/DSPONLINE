import { BUILDINGS, CONSTRUCTION, FUEL_ENERGY_MJ, FUEL_ITEM_IDS, ITEMS, RECIPES, TECHNOLOGIES, TECHNOLOGY_LIST, registerRuntimeBeltDefinition, resetRuntimeBeltDefinitions, validateContentCatalog } from "./content";
import { setContentRules, type ContentRules } from "./contentRules";
import { overrideRuntimeBeltDefinition } from "./content";
import { retainPreviousContentPresentation } from "./contentPresentation";
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
import { getContentPackUpdateReport } from "./contentPackUpdates";
import { hasContentIdReference } from "./contentIdMigration";
export { getContentPackUpdateReport } from "./contentPackUpdates";

const CONTENT_PACK_STORAGE_KEY = "dsp-idle-network.content-packs.v1";
const REGISTRY_VERSION = 1;
export const CONTENT_PACK_RUNTIME_PROTOCOL_VERSION = 1 as const;

const CORE_ITEM_IDS = new Set(Object.keys(ITEMS));
const CORE_ITEM_DEFINITIONS = new Map(Object.entries(ITEMS).map(([id, item]) => [id, structuredClone(item)]));
const CORE_BUILDING_IDS = new Set(Object.keys(BUILDINGS));
const CORE_RECIPE_IDS = new Set(Object.keys(RECIPES));
const CORE_TECH_IDS = new Set(Object.keys(TECHNOLOGIES));
const CORE_BUILDING_DEFINITIONS = new Map(Object.entries(BUILDINGS).map(([id, definition]) => [id, { ...definition }]));
const CORE_RECIPE_DEFINITIONS = new Map(Object.entries(RECIPES));
const CORE_TECHNOLOGY_DEFINITIONS = [...TECHNOLOGY_LIST];
const CORE_CONSTRUCTION_DEFINITIONS = [...CONSTRUCTION];
const CORE_FUELS = { ...FUEL_ENERGY_MJ };

type RuntimeItems = Record<string, ItemDefinition>;
type RuntimeBuildings = Record<string, BuildingDefinition>;
type RuntimeRecipes = Record<string, RecipeDefinition>;
type RuntimeTechnologies = Record<string, TechnologyDefinition>;

export interface RegisteredContentPack {
  manifest: ContentPackManifest;
  enabled: boolean;
  installedAt: number;
  updatedAt: number;
  /** Exact older save versions proven compatible by a local in-place update. */
  compatibleVersions?: string[];
  previousManifests?: ContentPackManifest[];
}

export interface ContentPackRegistry {
  version: typeof REGISTRY_VERSION;
  packs: Record<string, RegisteredContentPack>;
  /** Recent removed configurations let a player restore a pre-removal snapshot. */
  removedManifests?: ContentPackManifest[];
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
  // Rules and embedded presentation are nested author data. Never share them
  // between history, editor drafts, workers and the live registry.
  manifest = structuredClone(manifest);
  return {
    ...manifest,
    dependencies: [...(manifest.dependencies ?? [])],
    items: manifest.items?.map((item) => ({ ...item })),
    buildings: manifest.buildings?.map((building) => ({ ...building, costs: building.costs?.map((cost) => ({ ...cost })) })),
    recipes: manifest.recipes?.map((recipe) => ({ ...recipe, inputs: recipe.inputs.map((input) => ({ ...input })), outputs: recipe.outputs.map((output) => ({ ...output })) })),
    technologies: manifest.technologies?.map((technology) => ({ ...technology, prerequisites: [...(technology.prerequisites ?? [])], costs: technology.costs?.map((cost) => ({ ...cost })), unlocks: technology.unlocks ? [...technology.unlocks] : undefined })),
    buildingOverrides: manifest.buildingOverrides?.map((override) => ({ ...override })),
    belts: manifest.belts?.map((belt) => ({ ...belt, costs: belt.costs.map((cost) => ({ ...cost })) })),
    recipeOverrides: manifest.recipeOverrides?.map((rule) => ({ ...rule })),
    technologyOverrides: manifest.technologyOverrides?.map((rule) => ({ ...rule, ...(rule.prerequisites ? { prerequisites: [...rule.prerequisites] } : {}), ...(rule.costs ? { costs: rule.costs.map((cost) => ({ ...cost })) } : {}), ...(rule.unlocks ? { unlocks: [...rule.unlocks] } : {}) })),
    constructionOverrides: manifest.constructionOverrides?.map((rule) => ({ ...rule })),
  };
}

function cloneRegistry(registry: ContentPackRegistry, includeRemoved = true): ContentPackRegistry {
  return {
    version: REGISTRY_VERSION,
    ...(includeRemoved && registry.removedManifests?.length ? { removedManifests: registry.removedManifests.map(cloneManifest) } : {}),
    packs: Object.fromEntries(Object.entries(registry.packs).sort(([left], [right]) => left.localeCompare(right)).map(([id, pack]) => [id, {
      ...pack,
      manifest: cloneManifest(pack.manifest),
      ...(pack.compatibleVersions ? { compatibleVersions: [...pack.compatibleVersions] } : {}),
      ...(pack.previousManifests ? { previousManifests: pack.previousManifests.map(cloneManifest) } : {}),
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
  const runtime = cloneRegistry(registry, false);
  return hashString(stableSerialize(runtime));
}

export function createContentPackRuntimeSnapshot(registry: ContentPackRegistry): ContentPackRuntimeSnapshot {
  const normalized = cloneRegistry(registry, false);
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
      compatibleVersions: Array.isArray((candidate as RegisteredContentPack).compatibleVersions)
        ? [...new Set((candidate as RegisteredContentPack).compatibleVersions!.filter((version) => typeof version === "string" && satisfiesContentPackVersion(validation.manifest!.version, `>${version}`)))].slice(-128) : [],
      previousManifests: Array.isArray((candidate as RegisteredContentPack).previousManifests)
        ? (candidate as RegisteredContentPack).previousManifests!.filter((entry) => entry?.id === id && validateContentPack(entry).manifest).slice(-5).map(cloneManifest) : [],
    };
  }
  const rawRemoved = (value as ContentPackRegistry).removedManifests;
  const removedManifests = Array.isArray(rawRemoved) ? rawRemoved.slice(-8).flatMap(entry => {
    const checked = validateContentPack(entry);
    return checked.manifest ? [cloneManifest(checked.manifest)] : [];
  }) : [];
  return { version: REGISTRY_VERSION, packs, ...(removedManifests.length ? { removedManifests } : {}) };
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
    const serialized = JSON.stringify(cloneRegistry(registry));
    storage.setItem(CONTENT_PACK_STORAGE_KEY, serialized);
    return storage.getItem(CONTENT_PACK_STORAGE_KEY) === serialized;
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
    for (const key of ["recipeOverrides", "technologyOverrides", "constructionOverrides", "itemOverrides", "beltOverrides"] as const) {
      const targets = new Set(manifest[key]?.map((rule) => rule.id) ?? []);
      for (const rule of pack.manifest[key] ?? []) if (targets.has(rule.id)) conflicts.push(`规则 ${rule.id} 已由 ${pack.manifest.name} 调整`);
    }
    for (const key of ["recipePolicies", "generators"] as const) {
      const targets = new Set(manifest[key]?.map((rule) => rule.buildingId) ?? []);
      for (const rule of pack.manifest[key] ?? []) if (targets.has(rule.buildingId)) conflicts.push(`${rule.buildingId} 的 ${key} 已由 ${pack.manifest.name} 配置`);
    }
    for (const key of ["items", "buildings", "recipes", "technologies", "belts"] as const) {
      const aliases = new Set(manifest.idMigrations?.filter((rule) => rule.kind === key).map((rule) => rule.from) ?? []);
      const otherAliases = new Set(pack.manifest.idMigrations?.filter((rule) => rule.kind === key).map((rule) => rule.from) ?? []);
      if ((pack.manifest[key] ?? []).some((entry) => aliases.has(entry.id)) || (manifest[key] ?? []).some((entry) => otherAliases.has(entry.id)) || [...aliases].some((id) => otherAliases.has(id))) conflicts.push(`旧 ID 迁移与 ${pack.manifest.name} 的 ${key} 命名空间冲突`);
    }
  }
  return [...new Set(conflicts)];
}

/** IDs contributed by registered packages, used to validate a dependent package before enabling it. */
export function getContentPackValidationContext(registry: ContentPackRegistry, excludePackId?: string): ContentPackValidationContext {
  const itemIds = new Set<string>();
  const buildingIds = new Set<string>();
  const technologyIds = new Set<string>();
  const recipeIds = new Set<string>();
  const fuelItemIds = new Set<string>();
  const buildingKinds: Record<string, BuildingDefinition["kind"]> = {};
  const technologyPrerequisites: Record<string, readonly string[]> = {};
  for (const pack of Object.values(registry.packs)) {
    if (pack.manifest.id === excludePackId) continue;
    for (const item of pack.manifest.items ?? []) itemIds.add(item.id);
    for (const building of pack.manifest.buildings ?? []) { buildingIds.add(building.id); buildingKinds[building.id] = building.kind ?? "machine"; }
    for (const fuel of pack.manifest.fuels ?? []) fuelItemIds.add(fuel.itemId);
    for (const recipe of pack.manifest.recipes ?? []) recipeIds.add(recipe.id);
    for (const technology of pack.manifest.technologies ?? []) {
      technologyIds.add(technology.id);
      technologyPrerequisites[technology.id] = technology.prerequisites ?? [];
    }
    for (const technology of pack.manifest.technologyOverrides ?? []) if (technology.prerequisites) technologyPrerequisites[technology.id] = technology.prerequisites;
  }
  return { itemIds, buildingIds, technologyIds, recipeIds, fuelItemIds, buildingKinds, technologyPrerequisites };
}

export function registerContentPack(registry: ContentPackRegistry, validation: ModValidationResult, enable = true): { registry: ContentPackRegistry; enabled: boolean; reason?: string } {
  if (!validation.valid || !validation.manifest) return { registry, enabled: false, reason: "内容包未通过校验" };
  const conflicts = getContentPackConflicts(registry, validation.manifest);
  if (conflicts.length > 0) return { registry, enabled: false, reason: conflicts[0] };
  const next = cloneRegistry(registry);
  const previous = next.packs[validation.manifest.id];
  if (previous) {
    const update = getContentPackUpdateReport(previous.manifest, validation.manifest);
    if (!update.compatible) return { registry, enabled: previous.enabled, reason: update.issues.join("；") };
  }
  const now = Date.now();
  const compatibleVersions = [...new Set([...(validation.manifest.compatibleSaveVersions ?? []), ...(previous?.compatibleVersions ?? []), ...(previous ? [previous.manifest.version] : [])])].filter((version) => version !== validation.manifest!.version).slice(-128);
  next.packs[validation.manifest.id] = {
    manifest: cloneManifest({ ...validation.manifest, ...(validation.manifest.formatVersion >= 4 && compatibleVersions.length ? { compatibleSaveVersions: compatibleVersions } : {}) }),
    compatibleVersions,
    enabled: false,
    installedAt: previous?.installedAt ?? now,
    updatedAt: now,
    ...(previous ? {
      previousManifests: previous.manifest.version === validation.manifest.version ? previous.previousManifests ?? [] : [...(previous.previousManifests ?? []), cloneManifest(previous.manifest)].slice(-5),
    } : {}),
  };
  const dependencies = getContentPackDependencyStatuses(next, validation.manifest);
  const ready = dependencies.every((dependency) => dependency.satisfied);
  if (previous?.enabled && !ready) return { registry, enabled: true, reason: dependencies.find((dependency) => !dependency.satisfied)?.reason ?? "更新后的依赖未就绪" };
  next.packs[validation.manifest.id].enabled = enable && ready;
  for (const pack of Object.values(next.packs).filter((entry) => entry.enabled)) {
    const broken = getContentPackDependencyStatuses(next, pack.manifest).find((entry) => !entry.satisfied);
    if (broken) return { registry, enabled: previous?.enabled ?? false, reason: `更新会破坏 ${pack.manifest.name} 的依赖：${broken.specifier}` };
  }
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
  next.removedManifests = [...(next.removedManifests ?? []).filter(entry => entry.id !== packId || entry.version !== registry.packs[packId].manifest.version), cloneManifest(registry.packs[packId].manifest)].slice(-8);
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
  retainPreviousContentPresentation();
  setContentRules({});
  for (const key of Object.keys(FUEL_ENERGY_MJ)) delete FUEL_ENERGY_MJ[key as ItemId];
  Object.assign(FUEL_ENERGY_MJ, CORE_FUELS);
  FUEL_ITEM_IDS.splice(0, FUEL_ITEM_IDS.length, ...Object.keys(CORE_FUELS) as ItemId[]);
  const items = ITEMS as unknown as RuntimeItems;
  const buildings = BUILDINGS as unknown as RuntimeBuildings;
  const recipes = RECIPES as unknown as RuntimeRecipes;
  const technologies = TECHNOLOGIES as unknown as RuntimeTechnologies;
  for (const id of Object.keys(items)) if (!CORE_ITEM_IDS.has(id)) delete items[id];
  for (const [id, item] of CORE_ITEM_DEFINITIONS) items[id] = structuredClone(item);
  for (const id of Object.keys(buildings)) if (!CORE_BUILDING_IDS.has(id)) delete buildings[id];
  for (const [id, definition] of CORE_BUILDING_DEFINITIONS) buildings[id] = { ...definition };
  for (const id of Object.keys(recipes)) if (!CORE_RECIPE_IDS.has(id)) delete recipes[id];
  for (const [id, recipe] of CORE_RECIPE_DEFINITIONS) recipes[id] = { ...recipe };
  for (const id of Object.keys(technologies)) if (!CORE_TECH_IDS.has(id)) delete technologies[id];
  CONSTRUCTION.splice(0, CONSTRUCTION.length, ...CORE_CONSTRUCTION_DEFINITIONS.map((entry) => ({ ...entry })));
  TECHNOLOGY_LIST.splice(0, TECHNOLOGY_LIST.length, ...CORE_TECHNOLOGY_DEFINITIONS.map((entry) => ({ ...entry, unlocks: [...entry.unlocks] })));
  for (const entry of TECHNOLOGY_LIST) technologies[entry.id] = entry;
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
      ...(item.icon ? { icon: item.icon } : {}),
      ...(item.categoryId ? { categoryId: item.categoryId } : {}),
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
      ...(building.stackLimit !== undefined ? { stackLimit: Math.max(1, Math.floor(building.stackLimit)) } : {}),
      ...(building.megastructure !== undefined ? { megastructure: building.megastructure } : {}),
      ...(building.unique !== undefined ? { unique: building.unique } : {}),
      ...(building.upgradeTargetId ? { upgradeTargetId: building.upgradeTargetId as BuildingDefinition["upgradeTargetId"] } : {}),
      ...(building.layoutWidth !== undefined ? { layoutWidth: building.layoutWidth } : {}),
      ...(building.layoutHeight !== undefined ? { layoutHeight: building.layoutHeight } : {}),
      ...(building.layoutClearance !== undefined ? { layoutClearance: building.layoutClearance } : {}),
      ...(building.ports ? { ports: building.ports.map((port) => ({ ...port })) } : {}),
      ...(building.capabilities ? { capabilities: [...building.capabilities] } : {}),
      ...(building.scripted !== undefined ? { scripted: building.scripted } : {}),
      description: building.description?.trim() || `${pack.manifest.name} 提供的建筑。`,
      ...(building.icon ? { icon: building.icon } : {}),
      ...(building.categoryId ? { categoryId: building.categoryId } : {}),
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
      ...(recipe.handcraftable !== undefined ? { handcraftable: recipe.handcraftable } : {}),
      ...(recipe.recursivePriority !== undefined ? { recursivePriority: recipe.recursivePriority } : {}),
      ...(recipe.icon ? { icon: recipe.icon } : {}),
      ...(recipe.categoryId ? { categoryId: recipe.categoryId } : {}),
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

function applyContentRules(packs: RegisteredContentPack[]): void {
  const recipes = RECIPES as unknown as RuntimeRecipes;
  const technologies = TECHNOLOGIES as unknown as RuntimeTechnologies;
  for (const pack of packs) {
    for (const { id, requiredTechId, ...rule } of pack.manifest.recipeOverrides ?? []) {
      if (!recipes[id]) continue;
      const recipe = { ...recipes[id], ...rule };
      if (requiredTechId === null) delete recipe.requiredTechId;
      else if (requiredTechId !== undefined) recipe.requiredTechId = requiredTechId as TechId;
      recipes[id] = recipe;
    }
    for (const { id, ...rule } of pack.manifest.technologyOverrides ?? []) {
      if (!technologies[id]) continue;
      const current = technologies[id];
      const technology = {
        ...current,
        ...Object.fromEntries(Object.entries(rule).filter(([, value]) => value !== undefined)),
        prerequisites: [...(rule.prerequisites ?? current.prerequisites)],
        costs: (rule.costs ?? current.costs).map((cost) => ({ ...cost })),
        unlocks: [...(rule.unlocks ?? current.unlocks)],
      } as TechnologyDefinition;
      technologies[id] = technology;
      const index = TECHNOLOGY_LIST.findIndex((entry) => entry.id === id);
      TECHNOLOGY_LIST[index] = technology;
    }
    for (const rule of pack.manifest.constructionOverrides ?? []) {
      const entry = CONSTRUCTION.find((entry) => entry.buildingId === rule.id);
      if (!entry) continue;
      if (rule.requiredTechId === null) delete entry.requiredTechId;
      else if (rule.requiredTechId !== undefined) entry.requiredTechId = rule.requiredTechId as TechId;
    }
  }
  // The technology screen also lists actual unlocks, even if an author omits
  // optional display-only descriptions from the manifest.
  const describedRecipes = new Set(packs.flatMap((pack) => [...(pack.manifest.recipes ?? []), ...(pack.manifest.recipeOverrides ?? [])].map((entry) => entry.id)));
  const describedBuildings = new Set(packs.flatMap((pack) => [...(pack.manifest.buildings ?? []), ...(pack.manifest.belts ?? []), ...(pack.manifest.constructionOverrides ?? [])].map((entry) => entry.id)));
  for (const entry of [...Object.values(recipes).filter((entry) => describedRecipes.has(entry.id)), ...CONSTRUCTION.filter((entry) => describedBuildings.has(entry.buildingId))]) {
    if (!entry.requiredTechId) continue;
    const technology = technologies[entry.requiredTechId];
    if (technology && !technology.unlocks.includes(entry.name)) technology.unlocks.push(entry.name);
  }
}

function applyCoreContentOverrides(packs: RegisteredContentPack[]): void {
  const items = ITEMS as unknown as RuntimeItems;
  for (const pack of packs) {
    for (const override of pack.manifest.itemOverrides ?? []) items[override.id] = { ...items[override.id], ...override } as ItemDefinition;
    for (const override of pack.manifest.beltOverrides ?? []) {
      overrideRuntimeBeltDefinition(override.id, override);
      const entry = CONSTRUCTION.find(entry => entry.buildingId === override.id);
      if (!entry) continue;
      if (override.name !== undefined) entry.name = override.name;
      if (override.costs !== undefined) entry.costs = override.costs.map(cost => ({ itemId: cost.itemId as ItemId, amount: cost.amount }));
      if (override.outputAmount !== undefined) entry.outputAmount = override.outputAmount;
      if (override.requiredTechId === null) delete entry.requiredTechId;
      else if (override.requiredTechId !== undefined) entry.requiredTechId = override.requiredTechId as TechId;
    }
  }
}

/** Rebuild the live catalog from the enabled local registry. Call this before loading saves. */
export function applyContentPackRegistry(registry: ContentPackRegistry): ContentPackActivationReport {
  resetRuntimeContent();
  const { active, blocked } = activePacksInDependencyOrder(registry);
  const validationIssues = active.flatMap((pack) => [
    ...validateContentPack(pack.manifest, getContentPackValidationContext(registry, pack.manifest.id)).issues.filter((issue) => issue.severity === "error").map((issue) => `${pack.manifest.id}：${issue.message}`),
    ...getContentPackConflicts(registry, pack.manifest),
  ]);
  if (validationIssues.length > 0) return { activePackIds: [], blockedPackIds: active.map((pack) => pack.manifest.id), catalogValid: false, issues: validationIssues };
  registerItems(active);
  registerBuildings(active);
  applyBuildingOverrides(active);
  registerTechnologies(active);
  registerRecipes(active);
  registerConstruction(active);
  registerBelts(active);
  applyCoreContentOverrides(active);
  applyContentRules(active);
  const rules: ContentRules = {};
  for (const key of ["technologyEffects", "recipeGroups", "recipePolicies", "fuels", "generators", "resources", "idMigrations", "categories"] as const) {
    Object.assign(rules, { [key]: active.flatMap((pack) => (pack.manifest[key] ?? []) as unknown[]) });
  }
  setContentRules(rules);
  for (const effect of rules.technologyEffects ?? []) {
    const technology = TECHNOLOGIES[effect.technologyId as TechId];
    for (const [key, label] of [["productionSpeed", "生产速度"], ["powerConsumption", "能耗"], ["miningSpeed", "采矿速度"], ["storageCapacity", "输入/输出容量"]] as const) {
      if (effect[key] !== undefined) technology.unlocks.push(`${label} ×${effect[key]}`);
    }
  }
  for (const group of rules.recipeGroups ?? []) TECHNOLOGIES[group.requiredTechId as TechId].unlocks.push(`配方组：${group.name}`);
  for (const fuel of rules.fuels ?? []) FUEL_ENERGY_MJ[fuel.itemId as ItemId] = fuel.energyMj;
  FUEL_ITEM_IDS.splice(0, FUEL_ITEM_IDS.length, ...Object.keys(FUEL_ENERGY_MJ) as ItemId[]);
  const audit = validateContentCatalog();
  return {
    activePackIds: active.map((pack) => pack.manifest.id),
    blockedPackIds: blocked,
    catalogValid: audit.valid,
    issues: audit.issues.map((issue) => `${issue.id}：${issue.message}`),
  };
}

/** A failed catalog or durable write leaves the old runtime and registry active. */
export function commitContentPackRegistry(registry: ContentPackRegistry, previous: ContentPackRegistry): ContentPackActivationReport & { persisted: boolean } {
  let report: ContentPackActivationReport;
  try { report = applyContentPackRegistry(registry); }
  catch {
    applyContentPackRegistry(previous);
    return { activePackIds: [], blockedPackIds: [], catalogValid: false, issues: ["内容包目录无法激活，已保留原版本"], persisted: false };
  }
  if (!report.catalogValid || report.blockedPackIds.length > 0) {
    applyContentPackRegistry(previous);
    return { ...report, persisted: false };
  }
  if (!saveContentPackRegistry(registry)) {
    saveContentPackRegistry(previous);
    applyContentPackRegistry(previous);
    return { ...report, persisted: false, issues: ["本地内容包保存失败，原版本和存档保持不变"] };
  }
  return { ...report, persisted: true };
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
    if (installed.manifest.version !== requirement.version && !installed.compatibleVersions?.includes(requirement.version) && !installed.manifest.compatibleSaveVersions?.includes(requirement.version)) return [`内容包 ${requirement.id} 版本不匹配：存档需要 ${requirement.version}，当前为 ${installed.manifest.version}`];
    return [];
  });
}

export function getContentPackUsage(state: GameState, manifest: ContentPackManifest): ContentPackUsage {
  const itemIds = new Set(manifest.items?.map((item) => item.id) ?? []);
  const buildingIds = new Set(manifest.buildings?.map((building) => building.id) ?? []);
  const recipeIds = new Set(manifest.recipes?.map((recipe) => recipe.id) ?? []);
  const technologyIds = new Set(manifest.technologies?.map((technology) => technology.id) ?? []);
  const beltTiers = new Set(manifest.belts?.map(belt => belt.tier) ?? []);
  for (const belt of manifest.belts ?? []) buildingIds.add(belt.id);
  for (const alias of manifest.idMigrations ?? []) {
    const ids = alias.kind === "items" ? itemIds : alias.kind === "recipes" ? recipeIds : alias.kind === "technologies" ? technologyIds : buildingIds;
    ids.add(alias.from);
  }
  const entries: string[] = [];
  const add = (label: string, count: number) => { if (count > 0) entries.push(`${label} ${count}`); };
  add("设备", state.entities.filter((entity) => entity.buildingId && buildingIds.has(entity.buildingId)).length);
  add("配方设备", state.entities.filter((entity) => entity.recipeId && recipeIds.has(entity.recipeId)).length);
  add("运输线", state.belts.filter((belt) => itemIds.has(belt.itemId)).length);
  add("自定义传送带", state.belts.filter(belt => beltTiers.has(belt.tier)).length);
  add("资源点上的矿机", state.entities.filter(entity => entity.kind === "vein" && entity.resourceId && itemIds.has(entity.resourceId) && entity.minerCount > 0).length);
  add("科技记录", [...state.research.completedTechIds, ...state.research.queuedTechIds, state.research.selectedTechId]
    .flatMap((id) => id && technologyIds.has(id) ? [id] : []).length);
  const inventoryCount = [state.tray, ...Object.values(state.planetTrays), ...state.entities.flatMap(entity => [entity.inputs, entity.outputs]), state.quantumLogisticsNetwork.inventory]
    .reduce((sum, record) => sum + Object.entries(record).filter(([itemId, amount]) => itemIds.has(itemId) && Number(amount) > 0).length, 0);
  add("库存记录", inventoryCount);
  add("施工库存", Object.entries(state.construction).filter(([buildingId, amount]) => buildingIds.has(buildingId) && Number(amount) > 0).length);
  add("手持物品", state.cargo && itemIds.has(state.cargo.itemId) ? 1 : 0);
  add("手工队列", state.handcraftQueue.filter((entry) => recipeIds.has(entry.recipeId)).length);
  add("生产方案", state.productionPlans.filter((plan) => itemIds.has(plan.itemId) || Object.values(plan.recipeSelections).some((recipeId) => recipeId && recipeIds.has(recipeId))).length);
  add("配方聚焦", state.recipeFocus.itemId && itemIds.has(state.recipeFocus.itemId) ? 1 : 0);
  add("蓝图", state.blueprints.filter((blueprint) => blueprint.entities.some((entity) =>
    buildingIds.has(entity.buildingId) || (entity.recipeId ? recipeIds.has(entity.recipeId) : false)) || blueprint.belts.some((belt) => itemIds.has(belt.itemId))).length);
  if (entries.length === 0 && hasContentIdReference(state, new Set([...itemIds, ...buildingIds, ...recipeIds, ...technologyIds, ...(manifest.belts ?? []).map((belt) => belt.id)]))) add("其他存档引用", 1);
  return { total: entries.reduce((sum, entry) => sum + Number(entry.split(" ").at(-1) ?? 0), 0), entries };
}
