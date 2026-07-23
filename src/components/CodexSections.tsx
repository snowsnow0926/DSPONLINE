import {
  Atom,
  BatteryCharging,
  BookOpen,
  Box,
  Check,
  Clock3,
  Factory,
  FlaskConical,
  Gauge,
  GitFork,
  LockKeyhole,
  MapPin,
  Orbit,
  Route,
  Search,
  Sparkles,
  Zap,
} from "lucide-react";
import { useMemo, useState } from "react";
import {
  BUILDINGS,
  CONSTRUCTION,
  FUEL_ENERGY_MJ,
  ITEMS,
  PLANET_LIST,
  TECHNOLOGIES,
  getBeltTier,
  getBuilding,
  getConstructionDefinition,
  getItem,
  getPlanet,
  getRecipesForBuilding,
  getStarSystem,
  getTechnology,
  isConveyorBeltId,
} from "../game/content";
import { getBeltCapacity, getDysonEngineeringSnapshot, isTechnologyCompleted } from "../game/engine";
import { getPlanetIndustrialProfile, getPlanetSolarPowerMultiplier, getStarSystemProfile } from "../game/galaxy";
import { getRecipeRates } from "../game/recipeGraph";
import type {
  BeltConnection,
  BeltTier,
  BuildingDefinition,
  BuildingId,
  CargoStackSize,
  ConveyorBeltId,
  GameState,
  ItemId,
  PlanetId,
  RecipeDefinition,
  TechId,
} from "../game/types";
import { ItemGlyph } from "./ItemReference";
import "../styles/codex.css";

export type CodexSection = "items" | "buildings" | "logistics" | "energy" | "planets" | "dyson" | "research";

export const CODEX_SECTION_LABELS: Record<CodexSection, string> = {
  items: "物品与配方",
  buildings: "建筑设施",
  logistics: "物流运输",
  energy: "电力与能源",
  planets: "星球与资源",
  dyson: "戴森工程",
  research: "科研与机制",
};

const BUILDING_KIND_LABELS: Record<BuildingDefinition["kind"], string> = {
  machine: "生产设备",
  miner: "采集设备",
  power: "电力设施",
  storage: "仓储设施",
  splitter: "物流分配",
  station: "物流站点",
};

const OCEAN_LABELS = {
  water: "水海洋",
  "sulfuric-acid": "硫酸海洋",
  lava: "熔岩海",
  ice: "冻结海洋",
  none: "无海洋",
} as const;

const DYSON_BUILDING_IDS: BuildingId[] = ["em_rail_ejector", "ray_receiver", "vertical_launching_silo"];

function ItemButton({ itemId, suffix, onSelect }: { itemId: ItemId; suffix?: string; onSelect: (itemId: ItemId) => void }) {
  return <button className="codex-item-button" type="button" onClick={() => onSelect(itemId)}><ItemGlyph itemId={itemId} /><span>{getItem(itemId).name}</span>{suffix ? <strong>{suffix}</strong> : null}</button>;
}

function CatalogSearch({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return <label className="codex-search"><Search size={15} /><input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} /></label>;
}

function BuildingIndex({ buildings, selectedId, query, onQuery, onSelect }: {
  buildings: BuildingDefinition[];
  selectedId: BuildingId;
  query: string;
  onQuery: (value: string) => void;
  onSelect: (buildingId: BuildingId) => void;
}) {
  const term = query.trim().toLocaleLowerCase("zh-CN");
  const visible = buildings.filter((building) => !term || `${building.name} ${building.shortName} ${building.description} ${BUILDING_KIND_LABELS[building.kind]}`.toLocaleLowerCase("zh-CN").includes(term));
  return <aside className="codex-index"><CatalogSearch value={query} onChange={onQuery} placeholder="搜索建筑、用途或类型" /><small>{visible.length} 项设施</small><div>{visible.map((building) => {
    const construction = getConstructionDefinition(building.id);
    return <button className={building.id === selectedId ? "active" : ""} type="button" key={building.id} onClick={() => onSelect(building.id)}><i><Factory size={17} /></i><span><strong>{building.name}</strong><small>{BUILDING_KIND_LABELS[building.kind]}{building.tier ? ` · Mk.${building.tier}` : ""}</small></span><em>{construction?.requiredTechId ? getTechnology(construction.requiredTechId)?.name : "基础"}</em></button>;
  })}</div></aside>;
}

function RecipeRateRow({ recipe, building, onSelectItem }: { recipe: RecipeDefinition; building: BuildingDefinition; onSelectItem: (itemId: ItemId) => void }) {
  const rates = getRecipeRates(recipe, building.speed);
  return <article className="codex-recipe-row">
    <header><span><strong>{recipe.name}</strong><small><Clock3 size={12} />单次 {recipe.duration}s · {rates.cyclesPerMinute.toFixed(1)} 次/min</small></span>{recipe.requiredTechId ? <em>{getTechnology(recipe.requiredTechId)?.name}</em> : <em>基础配方</em>}</header>
    <div><section><small>单次输入</small>{recipe.inputs.length ? recipe.inputs.map((input) => <ItemButton key={input.itemId} itemId={input.itemId} suffix={`×${input.amount}`} onSelect={onSelectItem} />) : <span>无需物料</span>}</section><Route size={16} /><section><small>单次产出 / 每分钟</small>{recipe.outputs.length ? recipe.outputs.map((output) => <ItemButton key={output.itemId} itemId={output.itemId} suffix={`×${output.amount} · ${(rates.outputPerMinute[output.itemId] ?? 0).toFixed(1)}/min`} onSelect={onSelectItem} />) : <span>流程输出</span>}</section></div>
  </article>;
}

function BuildingDetail({ game, buildingId, onSelectItem, onSelectTechnology }: {
  game: GameState;
  buildingId: BuildingId;
  onSelectItem: (itemId: ItemId) => void;
  onSelectTechnology: (techId: TechId) => void;
}) {
  const building = getBuilding(buildingId);
  const construction = getConstructionDefinition(buildingId);
  const recipes = getRecipesForBuilding(buildingId);
  return <article className="codex-detail codex-building-detail">
    <header className="codex-detail-heading"><i><Factory size={22} /></i><span><small>{BUILDING_KIND_LABELS[building.kind]}{building.tier ? ` · Mk.${building.tier}` : ""}</small><strong>{building.name}</strong><p>{building.description}</p></span><b>{construction?.requiredTechId ? isTechnologyCompleted(game, construction.requiredTechId) ? "已解锁" : "未解锁" : "默认可用"}</b></header>
    <dl className="codex-metrics">
      <div><dt>基础速度</dt><dd>{building.speed.toFixed(2)}×</dd></div>
      <div><dt>输入缓存</dt><dd>{building.inputCapacity.toLocaleString("zh-CN")}</dd></div>
      <div><dt>输出缓存</dt><dd>{building.outputCapacity.toLocaleString("zh-CN")}</dd></div>
      <div><dt>额定耗电</dt><dd>{building.powerDemandKw ? `${building.powerDemandKw.toLocaleString("zh-CN")} kW` : "无"}</dd></div>
      <div><dt>额定发电</dt><dd>{building.powerGenerationKw ? `${building.powerGenerationKw.toLocaleString("zh-CN")} kW` : "无"}</dd></div>
      <div><dt>适用配方</dt><dd>{recipes.length}</dd></div>
    </dl>
    <section className="codex-section-block"><header><Box size={16} /><strong>制造材料</strong></header><div className="codex-link-grid">{construction?.costs.length ? construction.costs.map((cost) => <ItemButton key={cost.itemId} itemId={cost.itemId} suffix={`×${cost.amount}`} onSelect={onSelectItem} />) : <span>无施工制造定义</span>}</div>{construction?.requiredTechId ? <button className="codex-tech-link" type="button" onClick={() => onSelectTechnology(construction.requiredTechId!)}><FlaskConical size={15} /><span>解锁科技</span><strong>{getTechnology(construction.requiredTechId)?.name}</strong></button> : null}</section>
    <section className="codex-section-block"><header><Factory size={16} /><strong>适用配方</strong><small>{recipes.length} 条</small></header><div className="codex-recipe-list">{recipes.length ? recipes.map((recipe) => <RecipeRateRow key={recipe.id} recipe={recipe} building={building} onSelectItem={onSelectItem} />) : <p className="codex-empty">该设施不执行物品配方。</p>}</div></section>
  </article>;
}

function BuildingSection({ game, selectedId, detailOnly, onSelect, onSelectItem, onSelectTechnology }: {
  game: GameState;
  selectedId: BuildingId;
  detailOnly: boolean;
  onSelect: (buildingId: BuildingId) => void;
  onSelectItem: (itemId: ItemId) => void;
  onSelectTechnology: (techId: TechId) => void;
}) {
  const [query, setQuery] = useState("");
  const buildings = Object.values(BUILDINGS);
  return <div className={`codex-master-detail${detailOnly ? " codex-master-detail--detail" : ""}`}>{!detailOnly ? <BuildingIndex buildings={buildings} selectedId={selectedId} query={query} onQuery={setQuery} onSelect={onSelect} /> : null}<BuildingDetail game={game} buildingId={selectedId} onSelectItem={onSelectItem} onSelectTechnology={onSelectTechnology} /></div>;
}

function LogisticsSection({ game, onSelectBuilding, onSelectItem }: { game: GameState; onSelectBuilding: (buildingId: BuildingId) => void; onSelectItem: (itemId: ItemId) => void }) {
  const beltDefinitions = CONSTRUCTION.filter((definition) => isConveyorBeltId(definition.buildingId));
  const logisticsBuildings = Object.values(BUILDINGS).filter((building) => building.kind === "storage" || building.kind === "splitter" || building.kind === "station");
  const capacity = (tier: BeltTier, stackSize: CargoStackSize) => getBeltCapacity({ tier, lanes: 1, stackSize } as BeltConnection);
  return <div className="codex-overview">
    <section className="codex-section-block"><header><Route size={17} /><strong>传送带吞吐</strong><small>数值来自当前线路引擎</small></header><div className="codex-belt-grid">{beltDefinitions.map((definition) => {
      const tier = getBeltTier(definition.buildingId as ConveyorBeltId);
      return <article key={definition.buildingId}><header><span><strong>{definition.name}</strong><small>{definition.requiredTechId ? getTechnology(definition.requiredTechId)?.name : "基础物流"}</small></span><b>{capacity(tier, 1)} 件/秒</b></header><dl><div><dt>1 层</dt><dd>{capacity(tier, 1)}/s</dd></div><div><dt>2 层</dt><dd>{capacity(tier, 2)}/s</dd></div><div><dt>4 层</dt><dd>{capacity(tier, 4)}/s</dd></div></dl><div className="codex-link-grid">{definition.costs.map((cost) => <ItemButton key={cost.itemId} itemId={cost.itemId} suffix={`×${cost.amount}`} onSelect={onSelectItem} />)}</div></article>;
    })}</div></section>
    <section className="codex-section-block"><header><GitFork size={17} /><strong>物流设施</strong><small>{logisticsBuildings.length} 类</small></header><div className="codex-card-grid">{logisticsBuildings.map((building) => <button type="button" key={building.id} onClick={() => onSelectBuilding(building.id)}><Factory size={18} /><span><strong>{building.name}</strong><small>{building.description}</small></span></button>)}</div></section>
    <small className="codex-live-note">当前已铺设 {game.belts.length.toLocaleString("zh-CN")} 条线路；堆叠吞吐会按每条线路的实际层数计算。</small>
  </div>;
}

function EnergySection({ game, onSelectBuilding, onSelectItem }: { game: GameState; onSelectBuilding: (buildingId: BuildingId) => void; onSelectItem: (itemId: ItemId) => void }) {
  const powerBuildings = Object.values(BUILDINGS).filter((building) => building.kind === "power");
  const fuels = Object.entries(FUEL_ENERGY_MJ) as Array<[ItemId, number]>;
  return <div className="codex-overview"><section className="codex-live-summary"><div><Zap size={18} /><span>当前发电<strong>{game.metrics.generationKw.toLocaleString("zh-CN")} kW</strong></span></div><div><Gauge size={18} /><span>当前需求<strong>{game.metrics.demandKw.toLocaleString("zh-CN")} kW</strong></span></div><div><BatteryCharging size={18} /><span>供电比例<strong>{Math.round(game.metrics.powerFactor * 100)}%</strong></span></div></section><section className="codex-section-block"><header><Zap size={17} /><strong>电力设施</strong><small>{powerBuildings.length} 类</small></header><div className="codex-card-grid">{powerBuildings.map((building) => <button type="button" key={building.id} onClick={() => onSelectBuilding(building.id)}><Zap size={18} /><span><strong>{building.name}</strong><small>{building.powerGenerationKw ? `额定 ${building.powerGenerationKw.toLocaleString("zh-CN")} kW` : building.energyCapacityMj ? `储能 ${building.energyCapacityMj.toLocaleString("zh-CN")} MJ` : building.description}</small></span></button>)}</div></section><section className="codex-section-block"><header><Atom size={17} /><strong>燃料热值</strong><small>引擎实际 MJ/件</small></header><div className="codex-fuel-grid">{fuels.map(([itemId, energy]) => <ItemButton key={itemId} itemId={itemId} suffix={`${energy.toLocaleString("zh-CN")} MJ`} onSelect={onSelectItem} />)}</div></section></div>;
}

function PlanetSection({ game, selectedId, detailOnly, onSelect, onSelectItem }: { game: GameState; selectedId: PlanetId; detailOnly: boolean; onSelect: (planetId: PlanetId) => void; onSelectItem: (itemId: ItemId) => void }) {
  const planet = getPlanet(selectedId);
  const profile = getPlanetIndustrialProfile(game, selectedId);
  const system = getStarSystem(planet.systemId);
  const star = getStarSystemProfile(game, planet.systemId);
  return <div className={`codex-master-detail${detailOnly ? " codex-master-detail--detail" : ""}`}>{!detailOnly ? <aside className="codex-index"><small>{PLANET_LIST.length} 颗确定性行星</small><div>{PLANET_LIST.map((candidate) => { const candidateProfile = getPlanetIndustrialProfile(game, candidate.id); return <button className={candidate.id === selectedId ? "active" : ""} type="button" key={candidate.id} onClick={() => onSelect(candidate.id)}><i style={{ color: candidate.color }}><Orbit size={17} /></i><span><strong>{candidate.name}</strong><small>{candidateProfile.climateName} · {getStarSystem(candidate.systemId).name}</small></span></button>; })}</div></aside> : null}<article className="codex-detail"><header className="codex-detail-heading"><i style={{ color: planet.color }}><Orbit size={22} /></i><span><small>{system.name} · {star.starTypeName}</small><strong>{planet.name}</strong><p>{planet.environment}</p></span><b>{profile.tidalLocked ? "潮汐锁定" : planet.kind === "gas-giant" ? "气态巨星" : "类地行星"}</b></header><dl className="codex-metrics"><div><dt>海洋</dt><dd>{OCEAN_LABELS[profile.oceanType]}</dd></div><div><dt>矿储倍率</dt><dd>{Math.round(profile.reserveScale * 100)}%</dd></div><div><dt>采矿倍率</dt><dd>{Math.round(profile.miningMultiplier * 100)}%</dd></div><div><dt>风力倍率</dt><dd>{Math.round(profile.windMultiplier * 100)}%</dd></div><div><dt>太阳能倍率</dt><dd>{Math.round(getPlanetSolarPowerMultiplier(game, selectedId) * 100)}%</dd></div><div><dt>地热倍率</dt><dd>{Math.round(profile.geothermalMultiplier * 100)}%</dd></div></dl><section className="codex-section-block"><header><MapPin size={16} /><strong>资源目录</strong></header><div className="codex-link-grid">{profile.resourceIds.map((itemId) => <ItemButton key={itemId} itemId={itemId} onSelect={onSelectItem} />)}{Object.keys(profile.orbitalYields).map((itemId) => <ItemButton key={itemId} itemId={itemId as ItemId} suffix={`${profile.orbitalYields[itemId as ItemId]?.toFixed(2)}/s`} onSelect={onSelectItem} />)}</div></section><section className="codex-section-block"><header><Box size={16} /><strong>殖民成本</strong></header><div className="codex-link-grid">{profile.colonyCost.length ? profile.colonyCost.map((cost) => <ItemButton key={cost.itemId} itemId={cost.itemId} suffix={`×${cost.amount}`} onSelect={onSelectItem} />) : <span>无额外殖民成本</span>}</div></section></article></div>;
}

function DysonSection({ game, onSelectBuilding, onSelectItem }: { game: GameState; onSelectBuilding: (buildingId: BuildingId) => void; onSelectItem: (itemId: ItemId) => void }) {
  const systemId = getPlanet(game.activePlanetId).systemId;
  const snapshot = getDysonEngineeringSnapshot(game, systemId);
  const buildings = DYSON_BUILDING_IDS.map(getBuilding);
  return <div className="codex-overview"><section className="codex-live-summary"><div><Sparkles size={18} /><span>在轨太阳帆<strong>{snapshot.orbitSails.toLocaleString("zh-CN")}</strong></span></div><div><Factory size={18} /><span>永久结构<strong>{snapshot.completedStructurePoints.toLocaleString("zh-CN")}</strong></span></div><div><Zap size={18} /><span>预计发电<strong>{snapshot.projectedGenerationKw.toLocaleString("zh-CN")} kW</strong></span></div></section><section className="codex-section-block"><header><Sparkles size={17} /><strong>本系戴森参数</strong><small>{getStarSystem(systemId).name}</small></header><dl className="codex-metrics"><div><dt>轨道数量</dt><dd>{snapshot.orbitCount}</dd></div><div><dt>太阳帆发射</dt><dd>{snapshot.sailLaunchesPerMinute.toFixed(1)}/min</dd></div><div><dt>火箭发射</dt><dd>{snapshot.rocketLaunchesPerMinute.toFixed(1)}/min</dd></div><div><dt>射线接收</dt><dd>{snapshot.receiverLoadKw.toLocaleString("zh-CN")} kW</dd></div><div><dt>临界光子</dt><dd>{snapshot.criticalPhotonPerMinute.toFixed(1)}/min</dd></div><div><dt>壳面太阳帆</dt><dd>{snapshot.shellSails.toLocaleString("zh-CN")}/{snapshot.shellCapacity.toLocaleString("zh-CN")}</dd></div></dl></section><section className="codex-section-block"><header><Factory size={17} /><strong>工程设施</strong></header><div className="codex-card-grid">{buildings.map((building) => <button type="button" key={building.id} onClick={() => onSelectBuilding(building.id)}><Factory size={18} /><span><strong>{building.name}</strong><small>{building.description}</small></span></button>)}</div></section><section className="codex-section-block"><header><Box size={17} /><strong>工程物资</strong></header><div className="codex-link-grid">{(["solar_sail", "small_carrier_rocket", "critical_photon", "antimatter"] as ItemId[]).map((itemId) => <ItemButton key={itemId} itemId={itemId} onSelect={onSelectItem} />)}</div></section></div>;
}

function ResearchSection({ game, selectedId, detailOnly, onSelect, onSelectItem }: { game: GameState; selectedId: TechId; detailOnly: boolean; onSelect: (techId: TechId) => void; onSelectItem: (itemId: ItemId) => void }) {
  const [query, setQuery] = useState("");
  const technologies = useMemo(() => Object.values(TECHNOLOGIES).sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name, "zh-CN")), []);
  const term = query.trim().toLocaleLowerCase("zh-CN");
  const visible = technologies.filter((technology) => !term || `${technology.name} ${technology.summary} ${technology.unlocks.join(" ")}`.toLocaleLowerCase("zh-CN").includes(term));
  const technology = getTechnology(selectedId)!;
  return <div className={`codex-master-detail${detailOnly ? " codex-master-detail--detail" : ""}`}>{!detailOnly ? <aside className="codex-index"><CatalogSearch value={query} onChange={setQuery} placeholder="搜索科技或解锁内容" /><small>{visible.length} 项科技</small><div>{visible.map((candidate) => <button className={candidate.id === selectedId ? "active" : ""} type="button" key={candidate.id} onClick={() => onSelect(candidate.id)}><i>{isTechnologyCompleted(game, candidate.id) ? <Check size={17} /> : <FlaskConical size={17} />}</i><span><strong>{candidate.name}</strong><small>层级 {candidate.tier} · {candidate.costs.reduce((sum, cost) => sum + cost.amount, 0).toLocaleString("zh-CN")} 矩阵</small></span></button>)}</div></aside> : null}<article className="codex-detail"><header className="codex-detail-heading"><i><FlaskConical size={22} /></i><span><small>科技层级 {technology.tier}</small><strong>{technology.name}</strong><p>{technology.summary}</p></span><b>{isTechnologyCompleted(game, technology.id) ? "已完成" : "未完成"}</b></header><section className="codex-section-block"><header><Atom size={16} /><strong>研究成本</strong></header><div className="codex-link-grid">{technology.costs.map((cost) => <ItemButton key={cost.itemId} itemId={cost.itemId} suffix={`×${cost.amount}`} onSelect={onSelectItem} />)}</div></section><section className="codex-section-block"><header><LockKeyhole size={16} /><strong>前置科技</strong></header><div className="codex-card-grid">{technology.prerequisites.length ? technology.prerequisites.map((techId) => <button type="button" key={techId} onClick={() => onSelect(techId)}><FlaskConical size={17} /><span><strong>{getTechnology(techId)?.name}</strong><small>{isTechnologyCompleted(game, techId) ? "已完成" : "尚未完成"}</small></span></button>) : <span>无前置科技</span>}</div></section><section className="codex-section-block"><header><BookOpen size={16} /><strong>主要解锁</strong></header><ul className="codex-unlock-list">{technology.unlocks.map((unlock) => <li key={unlock}>{unlock}</li>)}</ul></section></article></div>;
}

export function CodexSections({ section, game, selectedBuildingId, selectedTechId, selectedPlanetId, detailOnly, onSelectBuilding, onSelectTechnology, onSelectPlanet, onSelectItem }: {
  section: Exclude<CodexSection, "items">;
  game: GameState;
  selectedBuildingId: BuildingId;
  selectedTechId: TechId;
  selectedPlanetId: PlanetId;
  detailOnly: boolean;
  onSelectBuilding: (buildingId: BuildingId) => void;
  onSelectTechnology: (techId: TechId) => void;
  onSelectPlanet: (planetId: PlanetId) => void;
  onSelectItem: (itemId: ItemId) => void;
}) {
  if (section === "buildings") return <BuildingSection game={game} selectedId={selectedBuildingId} detailOnly={detailOnly} onSelect={onSelectBuilding} onSelectItem={onSelectItem} onSelectTechnology={onSelectTechnology} />;
  if (section === "logistics") return <LogisticsSection game={game} onSelectBuilding={onSelectBuilding} onSelectItem={onSelectItem} />;
  if (section === "energy") return <EnergySection game={game} onSelectBuilding={onSelectBuilding} onSelectItem={onSelectItem} />;
  if (section === "planets") return <PlanetSection game={game} selectedId={selectedPlanetId} detailOnly={detailOnly} onSelect={onSelectPlanet} onSelectItem={onSelectItem} />;
  if (section === "dyson") return <DysonSection game={game} onSelectBuilding={onSelectBuilding} onSelectItem={onSelectItem} />;
  return <ResearchSection game={game} selectedId={selectedTechId} detailOnly={detailOnly} onSelect={onSelectTechnology} onSelectItem={onSelectItem} />;
}
