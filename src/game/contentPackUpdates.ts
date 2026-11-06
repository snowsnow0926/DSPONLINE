import { satisfiesContentPackVersion, type ContentPackManifest, type ModBuildingOverride } from "./mods";
import { BUILDINGS } from "./content";
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
  const issues: string[] = [];
  let added = 0;
  let changed = 0;
  if (previous.id !== next.id) issues.push("更新必须保留内容包 ID");
  if (stable(previous) !== stable(next) && !satisfiesContentPackVersion(next.version, `>${previous.version}`)) issues.push("修改内容后必须提高版本号");
  for (const key of ["items", "buildings", "recipes", "technologies", "belts"] as const) {
    const before = new Map((previous[key] ?? []).map((entry) => [entry.id, entry]));
    const after = new Map((next[key] ?? []).map((entry) => [entry.id, entry]));
    added += [...after.keys()].filter((id) => !before.has(id)).length;
    for (const [id, entry] of before) {
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
  for (const key of ["buildingOverrides", "recipeOverrides", "technologyOverrides", "constructionOverrides"] as const) {
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
  return { compatible: issues.length === 0, issues, added, changed };
}
