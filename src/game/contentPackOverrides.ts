import "../compat/runtime";
import { CONSTRUCTION, ITEMS, getBeltConstructionId, getBeltSpeed } from "./content";
import { validContentIcon } from "./contentRulesValidation";
import type { ModRecipeAmount, ModValidationIssue } from "./mods";
import type { CatalogPresentation } from "./types";

export interface ModItemOverride extends CatalogPresentation {
  id: string;
  name?: string;
  symbol?: string;
  color?: string;
  description?: string;
}
export interface ModBeltOverride {
  id: string;
  name?: string;
  speed?: number;
  costs?: ModRecipeAmount[];
  outputAmount?: number;
  requiredTechId?: string | null;
}
const coreItems = new Map(Object.entries(ITEMS).map(([id, item]) => [id, structuredClone(item)]));
const coreBelts = new Map([1, 2, 3].map(tier => {
  const id = getBeltConstructionId(tier);
  const construction = CONSTRUCTION.find(entry => entry.buildingId === id)!;
  return [id, { id, name: construction.name, speed: getBeltSpeed(tier), costs: structuredClone(construction.costs), outputAmount: construction.outputAmount, requiredTechId: construction.requiredTechId }];
}));
export function getCoreItemOverrideTargets(): ModItemOverride[] {
  return [...coreItems.values()].map(({ kind: _kind, ...item }) => structuredClone(item));
}
export function getCoreBeltOverrideTargets(): ModBeltOverride[] { return structuredClone([...coreBelts.values()]); }

export function parseCoreContentOverrides(raw: Record<string, any>, knownTechIds: ReadonlySet<string>, issues: ModValidationIssue[], knownItemIds?: ReadonlySet<string>): { itemOverrides: ModItemOverride[]; beltOverrides: ModBeltOverride[] } {
  const output = { itemOverrides: [] as ModItemOverride[], beltOverrides: [] as ModBeltOverride[] };
  const error = (path: string, message: string) => issues.push({ severity: "error", code: "core-override", path, message });
  const categoryIds = new Set(Array.isArray(raw.categories) ? raw.categories.map((entry: any) => entry?.id) : []);
  const itemIds = knownItemIds ?? new Set([...coreItems.keys(), ...(Array.isArray(raw.items) ? raw.items.map((entry: any) => entry?.id) : [])]);
  const text = (value: unknown, max: number) => typeof value === "string" && value.trim().length > 0 && value.length <= max;
  for (const key of ["itemOverrides", "beltOverrides"] as const) {
    const entries = raw[key];
    if (entries === undefined) continue;
    if (!Array.isArray(entries) || entries.length > 256) { error(`$.${key}`, "原版覆盖必须是最多 256 项的对象数组"); continue; }
    if (entries.length && raw.formatVersion < 5) error(`$.${key}`, "原版物品与传送带覆盖需要 formatVersion: 5");
    const seen = new Set<string>();
    entries.forEach((entry, index) => {
      const path = `$.${key}[${index}]`;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) { error(path, "覆盖项必须是对象"); return; }
      const targets = key === "itemOverrides" ? coreItems : coreBelts;
      if (!targets.has(entry.id)) error(`${path}.id`, "请选择已存在的原版 ID；新增内容使用 items 或 belts");
      if (seen.has(entry.id)) error(path, "同类覆盖不能重复引用同一 ID");
      seen.add(entry.id);
      const allowed = key === "itemOverrides" ? ["id", "name", "symbol", "color", "description", "icon", "categoryId"] : ["id", "name", "speed", "costs", "outputAmount", "requiredTechId"];
      if (Object.keys(entry).some(field => !allowed.includes(field))) error(path, "含不支持字段；物品物态、传送带 ID 和等级属于存档兼容边界");
      if (Object.keys(entry).filter(field => allowed.includes(field) && field !== "id").length === 0) error(path, "至少填写一个要覆盖的字段");
      if (entry.name !== undefined && !text(entry.name, 120)) error(`${path}.name`, "名称必须是 1～120 字符的文本");
      if (key === "itemOverrides") {
        if (entry.symbol !== undefined && !text(entry.symbol, 16)) error(`${path}.symbol`, "符号必须是 1～16 字符的文本");
        if (entry.description !== undefined && (typeof entry.description !== "string" || entry.description.length > 2048)) error(`${path}.description`, "说明不能超过 2048 字符");
        if (entry.color !== undefined && (typeof entry.color !== "string" || !/^#[0-9a-f]{6}$/i.test(entry.color))) error(`${path}.color`, "颜色应为 #RRGGBB");
        if (entry.icon !== undefined && !validContentIcon(entry.icon)) error(`${path}.icon`, "图标必须是受支持的内嵌 PNG/JPEG/WebP 图片");
        if (entry.categoryId !== undefined && !categoryIds.has(entry.categoryId)) error(`${path}.categoryId`, "分类必须在本包 categories 中声明");
      } else {
        if (entry.speed !== undefined && (typeof entry.speed !== "number" || !Number.isFinite(entry.speed) || entry.speed <= 0 || entry.speed > 1_000_000)) error(`${path}.speed`, "速度必须大于 0 且不超过 1000000 件/秒");
        if (entry.outputAmount !== undefined && (!Number.isSafeInteger(entry.outputAmount) || entry.outputAmount < 1 || entry.outputAmount > 1_000_000)) error(`${path}.outputAmount`, "每批产量必须是 1～1000000 的整数");
        if (entry.requiredTechId !== undefined && entry.requiredTechId !== null && !knownTechIds.has(entry.requiredTechId)) error(`${path}.requiredTechId`, "解锁科技必须已存在；null 表示无需科技");
        if (entry.costs !== undefined && (!Array.isArray(entry.costs) || entry.costs.length > 24 || !entry.costs.every((cost: any) => cost && itemIds.has(cost.itemId) && Number.isSafeInteger(cost.amount) && cost.amount > 0 && cost.amount <= 1_000_000))) error(`${path}.costs`, "成本必须使用已知物品和正整数数量");
      }
      const normalized = Object.fromEntries(Object.entries(entry).filter(([field]) => allowed.includes(field)));
      (output[key] as object[]).push(structuredClone(normalized));
    });
  }
  return output;
}
