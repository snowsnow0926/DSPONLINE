import { migrateContentPackIds } from "./contentIdMigration";
import type { IdMigration } from "./contentRules";
import { isCoreContentPackId, type ContentPackManifest } from "./mods";

/** Explicit author action: keep references and old-save aliases in one draft edit. */
export function renameContentPackEntry(manifest: ContentPackManifest, kind: IdMigration["kind"], from: string, to: string): ContentPackManifest {
  to = to.trim();
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(to) || ["constructor", "prototype"].includes(to)) throw new Error("新 ID 必须为 2～64 位小写字母、数字或下划线，并以字母开头");
  if (from === to) throw new Error("新旧 ID 相同，无需改名");
  if (isCoreContentPackId(kind, from) || isCoreContentPackId(kind, to)) throw new Error("原版 ID 保持稳定；修改原版内容请使用覆盖配置");
  if (!manifest[kind]?.some(entry => entry.id === from)) throw new Error("原内容已变化，请重新选择要改名的条目");
  if (manifest[kind]?.some(entry => entry.id === to) || manifest.idMigrations?.some(rule => rule.kind === kind && rule.from === to)) throw new Error("新 ID 已存在或属于历史 ID，请选择新的唯一 ID");
  const match = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/.exec(manifest.version);
  if (!match || !Number.isSafeInteger(Number(match[3])) || Number(match[3]) >= Number.MAX_SAFE_INTEGER) throw new Error("请先填写可提高补丁号的合法版本，如 1.0.0");
  const rule: IdMigration = { kind, from, to };
  let next = migrateContentPackIds(manifest, [rule]);
  next = { ...next, [kind]: next[kind]?.map(entry => entry.id === from ? { ...entry, id: to } : entry) };
  // These arrays are author rules rather than GameState references.
  if (kind === "recipes") {
    next.recipeGroups = next.recipeGroups?.map(group => ({ ...group, recipeIds: group.recipeIds.map(id => id === from ? to : id) }));
    next.recipePolicies = next.recipePolicies?.map(policy => ({ ...policy, recipeIds: policy.recipeIds.map(id => id === from ? to : id) }));
  }
  if (kind === "items") next.generators = next.generators?.map(generator => ({ ...generator, fuelItemIds: generator.fuelItemIds.map(id => id === from ? to : id) }));
  next.idMigrations = [...(manifest.idMigrations ?? []).map(existing => existing.kind === kind && existing.to === from ? { ...existing, to } : { ...existing }), rule];
  next.version = `${match[1]}.${match[2]}.${Number(match[3]) + 1}${match[4] ?? ""}`;
  return next;
}
