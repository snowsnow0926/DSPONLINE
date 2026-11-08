import { BUILDINGS, FUEL_ENERGY_MJ, ITEMS, PLANETS, RECIPES, TECHNOLOGIES, getBeltConstructionId, getBeltTiers } from "./content";
import { EFFECT_KEYS, type ContentRules } from "./contentRules";
import type { ContentPackManifest, ModValidationIssue } from "./mods";

const core = {
  items: new Set(Object.keys(ITEMS)), buildings: new Set(Object.keys(BUILDINGS)),
  recipes: new Set(Object.keys(RECIPES)), technologies: new Set(Object.keys(TECHNOLOGIES)), belts: new Set<string>(getBeltTiers().map(getBeltConstructionId)),
};
const coreFuelIds = Object.keys(FUEL_ENERGY_MJ);
const id = (value: unknown): value is string => typeof value === "string" && /^[a-z][a-z0-9_]{1,63}$/.test(value) && !["constructor", "prototype"].includes(value);
const record = (value: unknown): value is Record<string, any> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const list = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 512 && value.every(id) && new Set(value).size === value.length;
const positive = (value: unknown, max: number) => typeof value === "number" && Number.isFinite(value) && value > 0 && value <= max;

export function validContentIcon(value: unknown): value is string {
  // Embedded raster images work offline and cannot execute SVG or fetch URLs.
  return typeof value === "string" && value.length <= 180_000 && /^data:image\/(png|webp|jpeg);base64,[a-zA-Z0-9+/]+={0,2}$/.test(value);
}

export function validateContentRules(raw: Record<string, any>, manifest: ContentPackManifest, issues: ModValidationIssue[], context: { recipeIds?: Iterable<string>; itemIds?: Iterable<string>; buildingIds?: Iterable<string>; technologyIds?: Iterable<string>; fuelItemIds?: Iterable<string>; buildingKinds?: Record<string, string> } = {}): ContentRules {
  const output: Record<string, unknown> = {};
  const known = {
    items: new Set([...Object.keys(ITEMS), ...(context.itemIds ?? []), ...(manifest.items ?? []).map((entry) => entry.id)]),
    buildings: new Set([...Object.keys(BUILDINGS), ...(context.buildingIds ?? []), ...(manifest.buildings ?? []).map((entry) => entry.id)]),
    recipes: new Set([...Object.keys(RECIPES), ...(context.recipeIds ?? []), ...(manifest.recipes ?? []).map((entry) => entry.id)]),
    technologies: new Set([...Object.keys(TECHNOLOGIES), ...(context.technologyIds ?? []), ...(manifest.technologies ?? []).map((entry) => entry.id)]),
    belts: new Set((manifest.belts ?? []).map((entry) => entry.id)),
  };
  const fuelIds = new Set([...coreFuelIds, ...(context.fuelItemIds ?? []), ...(Array.isArray(raw.fuels) ? raw.fuels.filter(record).map((fuel: any) => fuel.itemId) : [])]);
  const kindOf = (buildingId: string) => {
    const own = manifest.buildings?.find((building) => building.id === buildingId);
    return own ? own.kind ?? "machine" : context.buildingKinds?.[buildingId] ?? BUILDINGS[buildingId as keyof typeof BUILDINGS]?.kind;
  };
  const error = (path: string, message: string) => issues.push({ severity: "error", code: "content-rule", path, message });
  const keys = ["technologyEffects", "recipeGroups", "recipePolicies", "fuels", "generators", "resources", "idMigrations", "categories"] as const;
  for (const key of keys) {
    const entries = raw[key];
    if (entries === undefined) continue;
    if (!Array.isArray(entries) || entries.length > 512 || !entries.every(record)) { error(`$.${key}`, "规则必须是最多 512 项的对象数组"); continue; }
    if (entries.length && raw.formatVersion < 4) error(`$.${key}`, "此规则需要 formatVersion: 4");
    const seen = new Set<string>();
    entries.forEach((entry, index) => {
      const path = `$.${key}[${index}]`;
      const identity = key === "technologyEffects" ? entry.technologyId : ["recipePolicies", "generators"].includes(key) ? entry.buildingId : ["fuels", "resources"].includes(key) ? entry.itemId : key === "idMigrations" ? `${entry.kind}:${entry.from}` : entry.id;
      if (seen.has(identity)) error(path, "同类规则不能重复引用同一 ID");
      seen.add(identity);
      switch (key) {
        case "technologyEffects":
          if (!known.technologies.has(entry.technologyId) || !EFFECT_KEYS.some((field) => entry[field] !== undefined) || EFFECT_KEYS.some((field) => entry[field] !== undefined && (!positive(entry[field], 100) || entry[field] < 0.01))) error(path, "科技效果需要已知科技和 0.01～100 倍的产速、能耗、采矿或容量系数");
          if (Object.keys(entry).some((field) => field !== "technologyId" && !EFFECT_KEYS.includes(field as never))) error(path, "科技效果含未知字段");
          break;
        case "recipeGroups":
          if (!id(entry.id) || typeof entry.name !== "string" || !entry.name.trim() || !known.technologies.has(entry.requiredTechId) || !list(entry.recipeIds) || !entry.recipeIds.length || entry.recipeIds.some((value: string) => !known.recipes.has(value))) error(path, "配方组需要合法 ID、名称、解锁科技和已知配方列表");
          break;
        case "recipePolicies":
          if (!known.buildings.has(entry.buildingId) || !list(entry.recipeIds) || entry.recipeIds.some((value: string) => !known.recipes.has(value))) error(path, "配方限制需要已知建筑和配方列表（空列表表示禁用全部配方）");
          if (kindOf(entry.buildingId) !== "machine") error(path, "配方限制只能用于生产建筑");
          break;
        case "fuels":
          if (!known.items.has(entry.itemId) || !positive(entry.energyMj, 1e9)) error(path, "燃料需要已知物品和有效热值（MJ）");
          break;
        case "generators": {
          if (kindOf(entry.buildingId) !== "power" || !list(entry.fuelItemIds) || !entry.fuelItemIds.length || entry.fuelItemIds.some((value: string) => !known.items.has(value)) || !positive(entry.efficiency, 1)) error(path, "燃料发电规则需要电力建筑、燃料列表和大于 0、不超过 1 的效率");
          if (Array.isArray(entry.fuelItemIds) && entry.fuelItemIds.some((value: string) => !fuelIds.has(value))) error(path, "发电机燃料必须先定义热值");
          break;
        }
        case "resources": {
          if (!known.items.has(entry.itemId) || core.items.has(entry.itemId) || manifest.items?.find((item) => item.id === entry.itemId)?.kind === "matrix" || kindOf(entry.extractorBuildingId) !== "miner" || !list(entry.planetIds) || !entry.planetIds.length || entry.planetIds.some((value: string) => !PLANETS[value as keyof typeof PLANETS] || PLANETS[value as keyof typeof PLANETS].kind === "gas-giant") || !Number.isInteger(entry.reserve) || !positive(entry.reserve, 1e12)) error(path, "采集规则需要包内资源、采矿建筑、类地行星和整数储量");
          break;
        }
        case "idMigrations":
          if (!Object.hasOwn(core, entry.kind) || !id(entry.from) || !id(entry.to) || entry.from === entry.to || core[entry.kind as keyof typeof core]?.has(entry.from) || !known[entry.kind as keyof typeof known]?.has(entry.to) || !(manifest[entry.kind as "items"] ?? []).some((candidate) => candidate.id === entry.to)) error(path, "迁移只能把包内旧 ID 映射到本包同类现存 ID，不能改核心 ID");
          break;
        case "categories":
          if (!id(entry.id) || typeof entry.name !== "string" || !entry.name.trim() || entry.name.length > 80) error(path, "分类需要合法 ID 和不超过 80 字的名称");
          break;
      }
    });
    output[key] = structuredClone(entries);
  }
  const categoryIds = new Set((Array.isArray(raw.categories) ? raw.categories : []).filter(record).map((entry: any) => entry.id));
  for (const key of ["items", "buildings", "recipes"] as const) (raw[key] ?? []).forEach?.((entry: any, index: number) => {
    if (!record(entry)) return;
    if (entry.icon !== undefined && !validContentIcon(entry.icon)) error(`$.${key}[${index}].icon`, "图标必须是小于 132 KiB 的内嵌 PNG、JPEG 或 WebP");
    if (entry.categoryId !== undefined && !categoryIds.has(entry.categoryId)) error(`$.${key}[${index}].categoryId`, "分类必须引用本包 categories 中的 ID");
    if ((entry.icon || entry.categoryId) && raw.formatVersion < 4) error(`$.${key}[${index}]`, "图标与分类需要 formatVersion: 4");
  });
  const migrations = (output.idMigrations ?? []) as ContentRules["idMigrations"];
  for (const migration of migrations ?? []) if (migrations?.some((next) => next.kind === migration.kind && next.from === migration.to)) error("$.idMigrations", "迁移必须直接指向最终 ID，不允许链式或循环映射");
  return output as ContentRules;
}
