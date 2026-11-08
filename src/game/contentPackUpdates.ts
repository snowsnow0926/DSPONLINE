import { satisfiesContentPackVersion, type ContentPackManifest, type ModBuildingOverride } from "./mods";
import { BUILDINGS } from "./content";
import { migrateContentPackIds } from "./contentIdMigration";
const CORE_BUILDINGS = new Map(Object.entries(BUILDINGS));

export interface ContentPackUpdateReport {
  compatible: boolean;
  issues: string[];
  added: number;
  changed: number;
}

function stable(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.entries(value).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${JSON.stringify(key)}:${stable(value)}`).join(",")}}`;
}

/** Conservative compatibility proof; never rewrites or removes player state. */
export function getContentPackUpdateReport(previous: ContentPackManifest, next: ContentPackManifest): ContentPackUpdateReport {
  const original = previous;
  // Compare structural contracts after an explicit, validated rename. This
  // permits ID repair while retaining all existing recipe/material semantics.
  previous = migrateContentPackIds(previous, next.idMigrations ?? []);
  for (const key of ["items", "buildings", "recipes", "technologies", "belts"] as const) {
    previous = { ...previous, [key]: previous[key]?.map((entry) => ({ ...entry, id: next.idMigrations?.find((rule) => rule.kind === key && rule.from === entry.id)?.to ?? entry.id })) };
  }
  const issues: string[] = [];
  let added = 0;
  let changed = 0;
  for (const old of original.idMigrations ?? []) {
    const finalTarget = next.idMigrations?.find((rule) => rule.kind === old.kind && rule.from === old.to)?.to ?? old.to;
    if (!next.idMigrations?.some((rule) => rule.kind === old.kind && rule.from === old.from && rule.to === finalTarget)) issues.push("必须保留已有旧 ID 的最终映射，确保旧存档仍可读取");
  }
  if (previous.id !== next.id) issues.push("更新必须保留内容包 ID");
  if (stable({ ...previous, compatibleSaveVersions: undefined }) !== stable({ ...next, compatibleSaveVersions: undefined }) && !satisfiesContentPackVersion(next.version, `>${previous.version}`)) issues.push("修改内容后必须提高版本号");
  for (const key of ["items", "buildings", "recipes", "technologies", "belts"] as const) {
    const before = new Map((previous[key] ?? []).map((entry) => [entry.id, entry]));
    const after = new Map((next[key] ?? []).map((entry) => [entry.id, entry]));
    added += [...after.keys()].filter((id) => !before.has(id)).length;
    // Every source definition must remain compatible, including multiple old
    // IDs mapped to one final ID; a Map alone would hide all but the last one.
    for (const entry of previous[key] ?? []) {
      const id = entry.id;
      const replacement = after.get(id);
      if (!replacement) { issues.push(`不能删除或重命名 ${key}：${id}，请保留旧定义`); continue; }
      if (stable(entry) !== stable(replacement)) changed += 1;
      const a = entry as unknown as Record<string, unknown>;
      const b = replacement as unknown as Record<string, unknown>;
      const shape = key === "items" ? ["kind"] : key === "buildings" ? ["kind", "family", "accepts", "ports", "capabilities", "scripted", "unique", "megastructure", "upgradeTargetId"] : key === "recipes" ? ["buildingId", "inputs", "outputs"] : key === "belts" ? ["tier"] : [];
      for (const field of shape) {
        const fallback = field === "kind" ? (key === "items" ? "solid" : "machine") : field === "accepts" ? "any" : field === "ports" || field === "capabilities" ? [] : undefined;
        if (stable(a[field] ?? fallback) !== stable(b[field] ?? fallback)) issues.push(`${id} 的 ${field} 与旧存档不兼容，请使用新的内容 ID`);
      }
      if (key === "buildings") for (const field of ["inputCapacity", "outputCapacity", "stackLimit"]) {
        const fallback = field === "stackLimit" ? 1 : 100;
        if (Number(b[field] ?? fallback) < Number(a[field] ?? fallback)) issues.push(`${id} 不能降低 ${field}，以免截断旧库存或堆叠`);
      }
    }
  }
  for (const resource of previous.resources ?? []) {
    const replacement = next.resources?.find((entry) => entry.itemId === resource.itemId);
    if (!replacement || replacement.extractorBuildingId !== resource.extractorBuildingId) issues.push(`${resource.itemId} 的资源采集映射必须保留，不能无偿转换已安装矿机`);
  }
  for (const key of ["buildingOverrides", "recipeOverrides", "technologyOverrides", "constructionOverrides", "itemOverrides", "beltOverrides"] as const) {
    const before = new Map((previous[key] ?? []).map((entry) => [entry.id, entry]));
    const after = new Map((next[key] ?? []).map((entry) => [entry.id, entry]));
    added += [...after.keys()].filter((id) => !before.has(id)).length;
    changed += [...before].filter(([id, entry]) => stable(after.get(id)) !== stable(entry)).length;
    if (key !== "buildingOverrides") continue;
    for (const [id, entry] of before) for (const field of ["inputCapacity", "outputCapacity", "stackLimit"] as const) {
      const original = CORE_BUILDINGS.get(id)?.[field] ?? (field === "stackLimit" ? 1 : 100);
      if (Number((after.get(id) as ModBuildingOverride | undefined)?.[field] ?? original) < Number((entry as ModBuildingOverride)[field] ?? original)) issues.push(`${id} 不能降低 ${field}，以免截断旧库存或堆叠`);
    }
  }
  const ruleIdentityFields = {
    technologyEffects: ["technologyId"], recipeGroups: ["id"], recipePolicies: ["buildingId"],
    fuels: ["itemId"], generators: ["buildingId"], resources: ["itemId"],
    idMigrations: ["kind", "from"], categories: ["id"],
  } as const;
  for (const key of Object.keys(ruleIdentityFields) as (keyof typeof ruleIdentityFields)[]) {
    const identity = (entry: object) => ruleIdentityFields[key].map((field) => String((entry as Record<string, unknown>)[field])).join(":");
    const before = new Map((previous[key] ?? []).map((entry) => [identity(entry), entry]));
    const after = new Map((next[key] ?? []).map((entry) => [identity(entry), entry]));
    added += [...after.keys()].filter((id) => !before.has(id)).length;
    changed += [...before].filter(([id, entry]) => stable(after.get(id)) !== stable(entry)).length;
  }
  return { compatible: issues.length === 0, issues, added, changed };
}
