import "../compat/runtime";
import { useMemo, useRef, useState } from "react";
import { createContentPackTemplate, MOD_FORMAT_VERSION, type ContentPackManifest } from "../game/mods";
import { TECHNOLOGY_LIST } from "../game/content";
import { getCoreBeltOverrideTargets, getCoreItemOverrideTargets } from "../game/contentPackOverrides";
import { renameContentPackEntry } from "../game/contentPackAuthoring";
import type { IdMigration } from "../game/contentRules";
import { StableTextInput } from "./CompositionSafeInput";

type Field = { key: string; label: string; type?: "number" | "list" | "amounts" | "boolean" | "techOverride"; options?: string[] };
const f = (key: string, label: string, type?: Field["type"]): Field => ({ key, label, type });
const presentation = [f("categoryId", "分类 ID")];
const costs = f("costs", "成本（物品 ID:数量，逗号分隔）", "amounts");
const coreItems = getCoreItemOverrideTargets();
const coreBelts = getCoreBeltOverrideTargets();
const sections = {
  items: { label: "物品与图标", fields: [f("id", "ID"), f("name", "名称"), f("symbol", "符号"), f("color", "颜色（#RRGGBB）"), { key: "kind", label: "类型", options: ["solid", "fluid", "matrix"] }, f("description", "说明"), ...presentation], initial: { id: "new_item", name: "新物品", kind: "solid", color: "#52b5a5" } },
  buildings: { label: "建筑", fields: [f("id", "ID"), f("name", "名称"), { key: "kind", label: "类型", options: ["machine", "miner", "power", "storage", "splitter", "station"] }, { key: "family", label: "配方族", options: ["", "smelter", "assembler", "chemical"] }, f("speed", "速度", "number"), f("inputCapacity", "输入容量", "number"), f("outputCapacity", "输出容量", "number"), f("powerDemandKw", "耗电 kW", "number"), f("powerGenerationKw", "发电 kW", "number"), f("requiredTechId", "建造解锁科技"), costs, f("description", "说明"), ...presentation], initial: { id: "new_machine", name: "新建筑", kind: "machine", speed: 1, inputCapacity: 100, outputCapacity: 100, costs: [{ itemId: "iron_ingot", amount: 10 }] } },
  recipes: { label: "配方", fields: [f("id", "ID"), f("name", "名称"), f("buildingId", "生产建筑 ID"), f("duration", "周期（秒）", "number"), f("inputs", "输入（物品 ID:数量）", "amounts"), f("outputs", "输出（物品 ID:数量）", "amounts"), f("requiredTechId", "解锁科技"), f("handcraftable", "允许手合", "boolean"), ...presentation], initial: { id: "new_recipe", name: "新配方", buildingId: "assembling_machine_mk1", duration: 1, inputs: [{ itemId: "iron_ingot", amount: 1 }], outputs: [{ itemId: "magnet", amount: 1 }], handcraftable: true } },
  technologies: { label: "科技", fields: [f("id", "ID"), f("name", "名称"), f("summary", "说明"), f("tier", "层级", "number"), f("prerequisites", "前置科技 ID", "list"), costs], initial: { id: "new_tech", name: "新科技", costs: [{ itemId: "electromagnetic_matrix", amount: 20 }], prerequisites: [], tier: 1 } },
  belts: { label: "自定义传送带", fields: [f("id", "ID"), f("name", "名称"), f("tier", "等级（4～32）", "number"), f("speed", "速度（件/秒）", "number"), f("requiredTechId", "解锁科技"), costs, f("outputAmount", "每批产量", "number")], initial: { id: "new_belt", name: "新传送带", tier: 4, speed: 60, costs: [{ itemId: "iron_ingot", amount: 1 }], outputAmount: 3 } },
  itemOverrides: { label: "原版物品覆盖", fields: [{ key: "id", label: "原版物品 ID", options: coreItems.map(item => item.id) }, f("name", "名称"), f("symbol", "符号"), f("color", "颜色（#RRGGBB）"), f("description", "说明"), ...presentation], initial: { ...coreItems[0] } },
  beltOverrides: { label: "原版传送带覆盖", fields: [{ key: "id", label: "原版传送带 ID", options: coreBelts.map(belt => belt.id) }, f("name", "名称"), f("speed", "速度（件/秒）", "number"), f("requiredTechId", "解锁科技", "techOverride"), costs, f("outputAmount", "每批产量", "number")], initial: { ...coreBelts[0] } },
  technologyEffects: { label: "科技实际加成", fields: [f("technologyId", "科技 ID"), f("productionSpeed", "生产速度倍率", "number"), f("powerConsumption", "能耗倍率", "number"), f("miningSpeed", "采矿速度倍率", "number"), f("storageCapacity", "输入/输出容量倍率", "number")], initial: { technologyId: "new_tech", productionSpeed: 1.5, powerConsumption: 0.8, miningSpeed: 1.5, storageCapacity: 2 } },
  recipeGroups: { label: "分组解锁", fields: [f("id", "分组 ID"), f("name", "名称"), f("requiredTechId", "解锁科技 ID"), f("recipeIds", "配方 ID（逗号分隔）", "list")], initial: { id: "new_group", name: "新配方组", requiredTechId: "new_tech", recipeIds: [] } },
  recipePolicies: { label: "建筑配方限制", fields: [f("buildingId", "建筑 ID"), f("recipeIds", "允许的配方 ID（空为全部禁用）", "list")], initial: { buildingId: "new_machine", recipeIds: [] } },
  fuels: { label: "自定义燃料", fields: [f("itemId", "物品 ID"), f("energyMj", "每个燃料热值 MJ", "number")], initial: { itemId: "new_item", energyMj: 10 } },
  generators: { label: "燃料发电", fields: [f("buildingId", "电力建筑 ID"), f("fuelItemIds", "接受的燃料 ID", "list"), f("efficiency", "发电效率（0～1）", "number")], initial: { buildingId: "new_generator", fuelItemIds: ["new_item"], efficiency: 0.8 } },
  resources: { label: "资源采集", fields: [f("itemId", "资源物品 ID"), f("extractorBuildingId", "采矿建筑 ID"), f("planetIds", "行星 ID（如 home, ashen）", "list"), f("reserve", "每个矿点初始储量", "number")], initial: { itemId: "new_item", extractorBuildingId: "mining_machine", planetIds: ["home"], reserve: 100000 } },
  categories: { label: "分类", fields: [f("id", "分类 ID"), f("name", "分类名称")], initial: { id: "new_category", name: "新分类" } },
  idMigrations: { label: "旧 ID 迁移", fields: [{ key: "kind", label: "内容类型", options: ["items", "buildings", "recipes", "technologies", "belts"] }, f("from", "旧 ID"), f("to", "新 ID")], initial: { kind: "items", from: "old_item", to: "new_item" } },
} satisfies Record<string, { label: string; fields: Field[]; initial: Record<string, unknown> }>;
type Section = keyof typeof sections;

export function createExampleContentPack(): ContentPackManifest {
  return {
    ...createContentPackTemplate(), id: "crystal_industry", name: "晶体工业示例", version: "1.0.0",
    categories: [{ id: "crystal", name: "晶体工业" }],
    items: [{ id: "crystal_ore", name: "晶体矿", symbol: "晶", color: "#65c8d0", categoryId: "crystal" }, { id: "crystal_plate", name: "晶体板", symbol: "板", categoryId: "crystal" }],
    buildings: [
      { id: "crystal_drill", name: "晶体钻机", kind: "miner", speed: 1, outputCapacity: 200, powerDemandKw: 300, costs: [{ itemId: "iron_ingot", amount: 5 }] },
      { id: "crystal_furnace", name: "晶体熔炉", kind: "machine", speed: 1, powerDemandKw: 300, costs: [{ itemId: "iron_ingot", amount: 5 }] },
      { id: "crystal_generator", name: "晶体发电机", kind: "power", powerGenerationKw: 3000, inputCapacity: 200, costs: [{ itemId: "iron_ingot", amount: 5 }] },
    ],
    technologies: [{ id: "crystal_efficiency", name: "晶体工业效率", costs: [{ itemId: "electromagnetic_matrix", amount: 10 }] }],
    recipes: [{ id: "crystal_plate_recipe", name: "晶体板", buildingId: "crystal_furnace", duration: 2, handcraftable: false, inputs: [{ itemId: "crystal_ore", amount: 2 }], outputs: [{ itemId: "crystal_plate", amount: 1 }], categoryId: "crystal" }],
    technologyEffects: [{ technologyId: "crystal_efficiency", productionSpeed: 2, miningSpeed: 2, powerConsumption: 0.5, storageCapacity: 2 }],
    recipeGroups: [{ id: "crystal_processing", name: "晶体加工", requiredTechId: "crystal_efficiency", recipeIds: ["crystal_plate_recipe"] }],
    recipePolicies: [{ buildingId: "crystal_furnace", recipeIds: ["crystal_plate_recipe"] }],
    fuels: [{ itemId: "crystal_ore", energyMj: 12 }], generators: [{ buildingId: "crystal_generator", fuelItemIds: ["crystal_ore"], efficiency: 0.8 }],
    resources: [{ itemId: "crystal_ore", extractorBuildingId: "crystal_drill", planetIds: ["home"], reserve: 100000 }],
  };
}

export function ContentPackAuthor({ raw, onChange, onValidate }: { raw: string; onChange: (raw: string) => void; onValidate: (raw: string) => void }) {
  const [section, setSection] = useState<Section>("items");
  const [error, setError] = useState("");
  const [renameDrafts, setRenameDrafts] = useState<Record<string, string>>({});
  const manifest = useMemo(() => {
    try {
      const value = JSON.parse(raw);
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      for (const key of Object.keys(sections)) if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].some((entry: unknown) => !entry || typeof entry !== "object" || Array.isArray(entry)))) return null;
      return value as ContentPackManifest;
    } catch { return null; }
  }, [raw]);
  const latest = useRef(manifest);
  latest.current = manifest;
  const availableTechnologies = Array.from(new Map([...TECHNOLOGY_LIST, ...(manifest?.technologies ?? [])].map(technology => [technology.id, technology])).values());
  const write = (next: ContentPackManifest) => onChange(JSON.stringify({ ...next, formatVersion: MOD_FORMAT_VERSION }, null, 2));
  const entries = (Array.isArray(manifest?.[section]) ? manifest[section] : []) as unknown as Record<string, any>[];
  const update = (index: number, key: string, value: unknown) => manifest && write({ ...manifest, [section]: entries.map((entry, position) => {
    if (position !== index) return entry;
    if (key === "id" && section === "itemOverrides") return coreItems.find(item => item.id === value) ?? entry;
    if (key === "id" && section === "beltOverrides") return coreBelts.find(belt => belt.id === value) ?? entry;
    return { ...entry, [key]: value };
  }) });
  const rename = (from: string, to: string) => {
    setError("");
    try {
      if (!latest.current || latest.current.id !== manifest?.id) throw new Error("内容包已变化，请重新选择条目");
      write(renameContentPackEntry(latest.current, section as IdMigration["kind"], from, to));
      setRenameDrafts({});
    } catch (failure) { setError(failure instanceof Error ? failure.message : "改名失败，原配置保持不变"); }
  };
  const renderField = (field: Field, entry: Record<string, any>, index: number) => {
    const value = entry[field.key]; const label = `${sections[section].label} ${index + 1} ${field.label}`;
    const text = field.type === "amounts" ? (Array.isArray(value) ? value : []).map((amount: any) => `${amount?.itemId ?? ""}:${amount?.amount ?? ""}`).join(", ") : field.type === "list" ? (Array.isArray(value) ? value : []).join(", ") : String(value ?? "");
    let control;
    if (field.type === "boolean") control = <input aria-label={label} type="checkbox" checked={value !== false} onChange={event => update(index, field.key, event.target.checked)} />;
    else if (field.type === "techOverride") control = <select aria-label={label} value={value === null ? "__none" : value ?? "__inherit"} onChange={event => update(index, field.key, event.target.value === "__none" ? null : event.target.value === "__inherit" ? undefined : event.target.value)}><option value="__inherit">沿用原版解锁</option><option value="__none">无需科技，初始解锁</option>{availableTechnologies.map(technology => <option key={technology.id} value={technology.id}>{technology.name} · {technology.id}</option>)}</select>;
    else if (field.options) control = <select aria-label={label} value={text} onChange={event => update(index, field.key, event.target.value || undefined)}>{field.options.map(option => <option key={option} value={option}>{option || "默认"}</option>)}</select>;
    else control = <StableTextInput aria-label={label} draftId={`pack-${manifest?.id}-${section}-${index}-${field.key}`} value={text} inputMode={field.type === "number" ? "decimal" : "text"} onValueChange={input => update(index, field.key, !input.trim() && field.type !== "list" && field.type !== "amounts" ? undefined : field.type === "number" ? Number(input) : field.type === "list" ? input.split(/[,，\s]+/).filter(Boolean) : field.type === "amounts" ? input.split(/[,，]+/).filter(part => part.trim()).map(part => { const [itemId, amount] = part.trim().split(":"); return { itemId, amount: Number(amount) }; }) : input)} />;
    return <label key={field.key}>{field.label}{control}</label>;
  };
  const icon = async (index: number, file?: File) => {
    setError("");
    if (!file) return;
    if (file.size > 132 * 1024 || !["image/png", "image/jpeg", "image/webp"].includes(file.type)) { setError("请选择不超过 132 KiB 的 PNG、JPEG 或 WebP 图片"); return; }
    const packId = manifest?.id;
    const entryId = entries[index]?.id;
    const value = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file); });
    const current = latest.current;
    const currentEntries = current?.[section] as unknown as Record<string, unknown>[] | undefined;
    if (!current || !currentEntries || !entryId || current.id !== packId || currentEntries[index]?.id !== entryId) { setError("图标目标已变化，请重新选择图片"); return; }
    write({ ...current, [section]: currentEntries.map((entry, position) => position === index ? { ...entry, icon: value } : entry) });
  };
  return <details className="content-pack-author" open={!manifest || manifest.formatVersion >= 4}>
    <summary>可视化作者工具 · v5</summary>
    <div className="content-pack-actions"><button type="button" onClick={() => write(createContentPackTemplate())}>新建空白包</button><button type="button" onClick={() => write(createExampleContentPack())}>载入晶体工业示例</button><button type="button" disabled={!manifest} onClick={() => onValidate(raw)}>校验全部配置</button></div>
    {!manifest ? <p>载入内容包或创建模板后，可以在这里逐项编辑。</p> : <>
      <div className="content-author-fields">{[f("id", "内容包 ID"), f("name", "名称"), f("version", "版本"), f("author", "作者"), f("description", "说明")].map((field) => <label key={field.key}>{field.label}<StableTextInput draftId={`pack-meta-${manifest.id}-${field.key}`} value={String(manifest[field.key as keyof ContentPackManifest] ?? "")} onValueChange={(value) => write({ ...manifest, [field.key]: value })} /></label>)}</div>
      <p>更新同一个包时保持“内容包 ID”不变并提高版本号。修改包内内容 ID 请使用“安全改名”，它会同步引用、保留旧 ID 映射并自动提高补丁版本。</p>
      <label>编辑内容<select aria-label="编辑内容类别" value={section} onChange={(event) => setSection(event.target.value as Section)}>{Object.entries(sections).map(([key, config]) => <option key={key} value={key}>{config.label}（{(manifest[key as Section] ?? []).length}）</option>)}</select></label>
      {section === "technologyEffects" ? <p>1 表示原值，产速/采矿/容量 2 表示翻倍，能耗 0.5 表示减半。已完成科技按声明顺序相乘，总倍率限制为 0.01～100。</p> : null}
      {section === "idMigrations" ? <p>旧 ID → 本包的新 ID。映射须直接到最终 ID，并保留旧映射供老存档读取；校验会检查类型、配方物料和容量兼容性。</p> : null}
      {section === "itemOverrides" ? <p>选择原版物品后可重写名称、符号、颜色、说明、图标和分类。物态保留，已有库存保持。</p> : null}
      {section === "beltOverrides" ? <p>名称、实际运输速度、制造成本、每批产量和解锁科技均可覆盖；等级与库存 ID 保持不变。停用后恢复原版规则。</p> : null}
      {entries.map((entry, index) => <details key={`${section}-${index}`} className="content-author-entry" open={entries.length < 4}><summary>{entry.name || entry.id || entry.technologyId || entry.buildingId || entry.itemId || entry.from || `第 ${index + 1} 项`}</summary>
        <div className="content-author-fields">{(sections[section].fields as Field[]).map(field => renderField(field, entry, index))}</div>
        {["items", "buildings", "recipes", "technologies", "belts"].includes(section) ? <div className="content-pack-actions"><label>新 ID<StableTextInput aria-label={`${sections[section].label} ${index + 1} 新 ID`} draftId={`rename-${manifest.id}-${section}-${entry.id}`} value={renameDrafts[`${section}:${entry.id}`] ?? ""} onValueChange={value => setRenameDrafts(current => ({ ...current, [`${section}:${entry.id}`]: value }))} /></label><button type="button" disabled={!renameDrafts[`${section}:${entry.id}`]?.trim()} onClick={() => rename(entry.id, renameDrafts[`${section}:${entry.id}`] ?? "")}>安全改名并更新引用</button></div> : null}
        {["items", "buildings", "recipes", "itemOverrides"].includes(section) ? <label>图片图标 {entry.icon ? <img className="content-author-icon" src={entry.icon} alt="图标预览" /> : null}<input aria-label={`导入第 ${index + 1} 项图标`} type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { void icon(index, event.target.files?.[0]).catch(() => setError("图片读取失败")); }} /><button type="button" onClick={() => update(index, "icon", undefined)}>清除图标</button></label> : null}
        <button type="button" onClick={() => write({ ...manifest, [section]: entries.filter((_, position) => position !== index) })}>删除此项</button>
      </details>)}
      <button type="button" onClick={() => write({ ...manifest, [section]: [...entries, structuredClone(sections[section].initial)] })}>添加{sections[section].label}</button>
    </>}
    {error ? <p role="alert">{error}</p> : null}
  </details>;
}
