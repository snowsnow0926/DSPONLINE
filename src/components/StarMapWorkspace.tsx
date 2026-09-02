import { AlertTriangle, ArrowDownToLine, ArrowRight, ArrowUpFromLine, Atom, Check, ChevronRight, Database, Factory, Gauge, LocateFixed, LockKeyhole, Navigation, Orbit, Pencil, RotateCcw, Route, Save, Search, Sparkles, Tags, Telescope, Timer, Trash2, Zap, X } from "lucide-react";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { ITEMS, PLANETS, STAR_SYSTEM_LIST, getItem, getPlanet, getStarSystem, getTechnology } from "../game/content";
import { canColonizePlanet, canExploreStarSystem, getColonizationRequirements, getPlanetFactoryResetPreview, getStationSlots, isPlanetColonized, isStarSystemUnlocked, isTechnologyCompleted } from "../game/engine";
import { getPlanetDisplayName, getPlanetIndustrialProfile, getPlanetSearchText, getPlanetSolarPowerMultiplier, getRecommendedPlanetRole, getStarSystemDisplayName, getStarSystemProfile, PLANET_CUSTOM_NAME_MAX_LENGTH, PLANET_INDUSTRY_ROLE_LABELS, PLANET_NOTE_MAX_LENGTH, PLANET_TAG_MAX_COUNT, PLANET_TAG_MAX_LENGTH, STAR_SYSTEM_CUSTOM_NAME_MAX_LENGTH } from "../game/galaxy";
import { getInterplanetaryLogisticsDiagnostics, getPlanetIndustrySummaries, getRouteDistanceLabel, getRouteEndpointLabel, getRoutePathLabel, getStarSystemIndustrySummaries, getStellarRouteSnapshots } from "../game/stellarIndustry";
import type { GameState, InterstellarRoutePolicy, ItemId, LogisticsPriority, PlanetId, PlanetIndustryRole, StarSystemId, StationMinimumLoad } from "../game/types";
import { ItemGlyph, ItemHoverCard } from "./ItemReference";
import { PowerValue } from "./PowerValue";
import { formatQuantityCompact, formatQuantityExact, formatQuantityScientific } from "../game/quantityFormat";
import { useAppLocale } from "../i18n/locale";
import { getPlanetEnglishName } from "../i18n/planetNames";
import { getQuantumBandwidthSummary, getQuantumItemCapacity, QUANTUM_ITEM_CAPACITY_MAX, QUANTUM_ITEM_CAPACITY_MIN, QUANTUM_ITEM_CAPACITY_PRESETS } from "../game/quantumLogisticsNetwork";
import { StableTextArea, StableTextInput, clearStableTextDraft, readStableTextDraft } from "./CompositionSafeInput";
import { AccessibleDialog } from "./AccessibleDialog";
import { WorkspaceFrame } from "./WorkspaceFrame";
import type { DesktopNativeCoreStellarRouteFilter } from "../desktop";
import {
  NATIVE_STELLAR_ROUTE_QUERY_BYTES,
  type NativeStellarQuantumReadModel,
  type NativeStarMapWorkspaceReadModel,
} from "../game/nativeStellarWorkspaceStore";
import type { NativeStarMapCatalogFrame } from "../game/nativeStarMapCatalogStore";

function formatDistance(distanceLy: number): string {
  return distanceLy <= 0 ? "本地" : `${distanceLy.toFixed(1)} 光年`;
}

function compactNumber(value: number): string {
  if (!Number.isFinite(value)) return "--";
  return formatQuantityCompact(Math.round(value));
}

function formatDepletion(seconds: number | null): string {
  if (seconds == null) return "稳定";
  if (seconds < 60) return "<1 分钟";
  if (seconds < 3_600) return `${Math.ceil(seconds / 60)} 分钟`;
  if (seconds < 86_400) return `${(seconds / 3_600).toFixed(1)} 小时`;
  return `${(seconds / 86_400).toFixed(1)} 天`;
}

const PLANET_ROLES = Object.keys(PLANET_INDUSTRY_ROLE_LABELS) as PlanetIndustryRole[];

export interface StarMapBatchActionResult {
  actionLabel: string;
  scopeLabel: string;
  successCount: number;
  skippedCount: number;
  skipReasons: string[];
}

export interface StarMapIndustryReadRequest {
  systemId: StarSystemId | null;
  planetId: PlanetId | null;
  routeFilter: DesktopNativeCoreStellarRouteFilter;
  query: string;
}

export type StarMapNativeReadStatus = "ready" | "loading" | "unavailable";

type StarMapBatchAction = (systemId?: StarSystemId) => Promise<StarMapBatchActionResult | null>;
type StarMapCollectorBatchAction = (enabled: boolean, systemId?: StarSystemId) => Promise<StarMapBatchActionResult | null>;
type NativePlanetRoleAction = (
  projectedRevision: number,
  planetId: PlanetId,
  currentRole: PlanetIndustryRole,
  targetRole: PlanetIndustryRole,
) => boolean;
type NativeStationPriorityAction = (
  projectedRevision: number,
  stationId: string,
  slotIndex: number,
  currentPriority: LogisticsPriority,
  targetPriority: LogisticsPriority,
) => boolean;
type NativeStationMinimumLoadAction = (
  projectedRevision: number,
  stationId: string,
  slotIndex: number,
  currentMinimumLoad: StationMinimumLoad,
  targetMinimumLoad: StationMinimumLoad,
  primarySlot: boolean,
) => boolean;
type NativeStationRoutePolicyAction = (
  projectedRevision: number,
  stationId: string,
  slotIndex: number,
  currentRoutePolicy: InterstellarRoutePolicy,
  targetRoutePolicy: InterstellarRoutePolicy,
) => boolean;
type NativeStationWarperBudgetAction = (
  projectedRevision: number,
  stationId: string,
  slotIndex: number,
  currentWarperBudget: number,
  requestedWarperBudget: number,
) => boolean;
type NativeStationLimitsAction = (
  projectedRevision: number,
  stationId: string,
  slotIndex: number,
  currentMinStock: number,
  currentMaxStock: number,
  requestedMinStock: number,
  requestedMaxStock: number,
) => boolean;
type NativeQuantumItemCapacityAction = (
  projectedRevision: number,
  itemId: ItemId,
  currentCapacity: string,
  targetCapacity: string,
) => boolean;

const OCEAN_LABELS = {
  water: "水海洋",
  "sulfuric-acid": "硫酸海洋",
  lava: "熔岩海",
  ice: "冻结海洋",
  none: "无海洋",
} as const;

function StellarMetadataManager({ game, compact = false, onPlanetMetadataChange, onSystemNameChange }: {
  game: GameState;
  compact?: boolean;
  onPlanetMetadataChange: (planetId: PlanetId, metadata: { customName: string; note: string; tags: string[] }) => void;
  onSystemNameChange: (systemId: StarSystemId, customName: string) => void;
}) {
  const { isEnglish } = useAppLocale();
  const [planetId, setPlanetId] = useState<PlanetId>(game.activePlanetId);
  const [systemId, setSystemId] = useState<StarSystemId>(getPlanet(game.activePlanetId).systemId);
  const metadata = game.galaxy.planetMetadata?.[planetId];
  const systemMetadata = game.galaxy.systemMetadata?.[systemId];
  const [planetName, setPlanetName] = useState(readStableTextDraft(`star-planet-name-${planetId}`) ?? metadata?.customName ?? "");
  const [systemName, setSystemName] = useState(readStableTextDraft(`star-system-name-${systemId}`) ?? systemMetadata?.customName ?? "");
  const [note, setNote] = useState(readStableTextDraft(`star-planet-note-${planetId}`) ?? metadata?.note ?? "");
  const [tags, setTags] = useState(readStableTextDraft(`star-planet-tags-${planetId}`) ?? (metadata?.tags ?? []).join("，"));

  useEffect(() => {
    const current = game.galaxy.planetMetadata?.[planetId];
    setPlanetName(readStableTextDraft(`star-planet-name-${planetId}`) ?? current?.customName ?? "");
    setNote(readStableTextDraft(`star-planet-note-${planetId}`) ?? current?.note ?? "");
    setTags(readStableTextDraft(`star-planet-tags-${planetId}`) ?? (current?.tags ?? []).join("，"));
  }, [game.galaxy.planetMetadata, planetId]);
  useEffect(() => setSystemName(readStableTextDraft(`star-system-name-${systemId}`) ?? game.galaxy.systemMetadata?.[systemId]?.customName ?? ""), [game.galaxy.systemMetadata, systemId]);

  const parsedTags = [...new Set(tags.split(/[，,\n]/).map((tag) => tag.trim().slice(0, PLANET_TAG_MAX_LENGTH)).filter(Boolean))].slice(0, PLANET_TAG_MAX_COUNT);
  return <details className={`stellar-metadata-manager${compact ? " stellar-metadata-manager--compact" : ""}`}>
    <summary><Pencil size={15} /><span>自定义星球资料</span><small>名称、备注与标签</small></summary>
    <div>
      <form onSubmit={(event) => { event.preventDefault(); onSystemNameChange(systemId, systemName); clearStableTextDraft(`star-system-name-${systemId}`); }}>
        <header><Sparkles size={15} /><strong>恒星系名称</strong></header>
        <label><span>恒星系</span><select value={systemId} onChange={(event) => setSystemId(event.target.value as StarSystemId)}>{STAR_SYSTEM_LIST.map((system) => <option value={system.id} key={system.id}>{getStarSystemDisplayName(game, system.id)}</option>)}</select></label>
        <label><span>自定义名称</span><StableTextInput key={systemId} draftId={`star-system-name-${systemId}`} value={systemName} maxLength={STAR_SYSTEM_CUSTOM_NAME_MAX_LENGTH} placeholder={getStarSystem(systemId).name} onValueChange={setSystemName} /></label>
        <footer><button type="button" onClick={() => { setSystemName(""); clearStableTextDraft(`star-system-name-${systemId}`); onSystemNameChange(systemId, ""); }}><RotateCcw size={14} />恢复默认</button><button className="primary" type="submit"><Save size={14} />保存星系名称</button></footer>
      </form>
      <form onSubmit={(event) => { event.preventDefault(); onPlanetMetadataChange(planetId, { customName: planetName, note, tags: parsedTags }); clearStableTextDraft(`star-planet-name-${planetId}`); clearStableTextDraft(`star-planet-note-${planetId}`); clearStableTextDraft(`star-planet-tags-${planetId}`); }}>
        <header><Orbit size={15} /><strong>行星资料</strong></header>
        <label><span>行星</span><select value={planetId} onChange={(event) => setPlanetId(event.target.value as PlanetId)}>{STAR_SYSTEM_LIST.flatMap((system) => system.planetIds).map((id) => <option value={id} key={id}>{getPlanetDisplayName(game, id)} · {getStarSystemDisplayName(game, getPlanet(id).systemId)}</option>)}</select></label>
        <label><span>自定义名称</span><StableTextInput key={`name-${planetId}`} draftId={`star-planet-name-${planetId}`} value={planetName} maxLength={PLANET_CUSTOM_NAME_MAX_LENGTH} placeholder={getPlanet(planetId).name} onValueChange={setPlanetName} /></label>
        <label><span>备注</span><StableTextArea key={`note-${planetId}`} draftId={`star-planet-note-${planetId}`} value={note} maxLength={PLANET_NOTE_MAX_LENGTH} rows={compact ? 2 : 3} placeholder={isEnglish ? "Record production purpose, logistics plans, or resource assignments" : "记录产线用途、物流计划或资源安排"} onValueChange={setNote} /></label>
        <label><span><Tags size={13} />标签</span><StableTextInput key={`tags-${planetId}`} draftId={`star-planet-tags-${planetId}`} value={tags} placeholder="例如：绿糖，出口，缺电" onValueChange={setTags} /><small>逗号分隔，最多 {PLANET_TAG_MAX_COUNT} 个</small></label>
        <footer><button type="button" onClick={() => { setPlanetName(""); clearStableTextDraft(`star-planet-name-${planetId}`); onPlanetMetadataChange(planetId, { customName: "", note, tags: parsedTags }); }}><RotateCcw size={14} />恢复默认名称</button><button className="primary" type="submit"><Save size={14} />保存行星资料</button></footer>
      </form>
    </div>
  </details>;
}

function getStellarStationSlot(game: GameState, entityId: string, slotIndex: number) {
  const station = game.entities.find((entity) => entity.id === entityId && entity.kind === "station");
  return station ? getStationSlots(station)[slotIndex] : undefined;
}

function getLocalizedPlanetDisplayName(game: GameState, planetId: PlanetId, isEnglish: boolean): string {
  const customName = game.galaxy.planetMetadata?.[planetId]?.customName;
  return customName || (isEnglish ? getPlanetEnglishName(planetId) : getPlanetDisplayName(game, planetId));
}

export function PlanetFactoryResetDialog({
  game,
  planetId,
  onCancel,
  onConfirm,
}: {
  game: GameState;
  planetId: PlanetId | null;
  onCancel: () => void;
  onConfirm: (planetId: PlanetId) => boolean;
}) {
  const { isEnglish } = useAppLocale();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [typedPlanetName, setTypedPlanetName] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const preview = useMemo(() => planetId ? getPlanetFactoryResetPreview(game, planetId) : null, [game, planetId]);
  const planetName = planetId ? getLocalizedPlanetDisplayName(game, planetId, isEnglish) : "";

  useEffect(() => {
    setStep(1);
    setTypedPlanetName("");
    setFailure(null);
  }, [planetId]);

  const finalNameMatches = typedPlanetName === planetName;
  const canAdvance = Boolean(preview?.allowed && preview.hasFactoryData && (step !== 3 || finalNameMatches));
  const actionLabel = step === 1 ? "第一次确认：继续" : step === 2 ? "第二次确认：继续" : "第三次确认并永久重置";

  return <AccessibleDialog
    open={planetId !== null}
    role="alertdialog"
    riskPolicy="explicit"
    title={`第 ${step} / 3 次确认 · 重置${planetName}`}
    description="这是永久删除操作，不能撤销，也不会返还被删除的建筑、物料或在建资源。"
    className="planet-reset-dialog"
    onRequestClose={() => undefined}
    actions={<>
      <button type="button" onClick={onCancel}>取消并保留星球</button>
      <button
        className="planet-reset-dialog__confirm"
        type="button"
        disabled={!canAdvance}
        onClick={() => {
          if (!planetId || !canAdvance) return;
          if (step < 3) {
            setStep((step + 1) as 2 | 3);
            setFailure(null);
            return;
          }
          if (onConfirm(planetId)) onCancel();
          else setFailure("星球状态已变化或主存档正在保存，本次没有执行。请关闭弹窗后重试。");
        }}
      ><Trash2 size={16} />{actionLabel}</button>
    </>}
  >
    <div className="planet-reset-dialog__steps" aria-label="三次确认进度">
      {[1, 2, 3].map((value) => <span className={value === step ? "active" : value < step ? "complete" : ""} key={value}>{value < step ? <Check size={13} /> : value}<small>{value === 1 ? "范围" : value === 2 ? "后果" : "名称"}</small></span>)}
    </div>
    {preview ? <>
      <div className="planet-reset-dialog__summary">
        <span><strong>{preview.buildingUnits.toLocaleString("zh-CN")}</strong><small>建筑设备</small></span>
        <span><strong>{preview.extractorUnits.toLocaleString("zh-CN")}</strong><small>采矿设备</small></span>
        <span><strong>{preview.beltConnections.toLocaleString("zh-CN")}</strong><small>传送带线路</small></span>
        <span><strong>{preview.trayItemTypes.toLocaleString("zh-CN")}</strong><small>本地库存种类</small></span>
        <span><strong>{preview.stationRoutes.toLocaleString("zh-CN")}</strong><small>相关物流航线</small></span>
        <span><strong>{(preview.constructionOrders + preview.handcraftOrders + preview.constructionJobs).toLocaleString("zh-CN")}</strong><small>进行中队列</small></span>
      </div>
      {step === 1 ? <div className="planet-reset-dialog__scope">
        <section><strong><Trash2 size={15} />将永久删除</strong><p>全部玩家建筑、矿机、传送带、本地物资托盘、相关物流航线、施工与手搓队列、该星球的生产计划、画布标记和近期统计。</p></section>
        <section><strong><Check size={15} />明确保留</strong><p>{preview.naturalResourceNodes} 个天然资源节点及其当前剩余量、星球殖民状态和名称标签，以及科研、戴森球、量子仓库、全局建筑库存和随身舰队。</p></section>
      </div> : step === 2 ? <div className="planet-reset-dialog__warning"><AlertTriangle size={18} /><p><strong>不会返还任何物品，也不能撤销。</strong>其他星球不会被重置；涉及本星球的跨星球航线会安全终止并清除悬空引用。</p></div> : <label className="planet-reset-dialog__name"><span>输入星球全名 <strong>{planetName}</strong> 完成第三次确认</span><input autoComplete="off" spellCheck={false} value={typedPlanetName} onChange={(event) => { setTypedPlanetName(event.target.value); setFailure(null); }} placeholder={planetName} aria-invalid={typedPlanetName.length > 0 && !finalNameMatches} /><small>{typedPlanetName.length === 0 ? "必须完全一致，不能省略或添加空格。" : finalNameMatches ? "名称匹配，可以执行最终重置。" : "名称不匹配。"}</small></label>}
      {!preview.allowed || !preview.hasFactoryData ? <div className="planet-reset-dialog__unavailable"><AlertTriangle size={16} /><span>{preview.reason}</span></div> : null}
      {failure ? <div className="planet-reset-dialog__unavailable" role="alert"><AlertTriangle size={16} /><span>{failure}</span></div> : null}
    </> : null}
  </AccessibleDialog>;
}

interface IndustryConsoleProps {
  game: GameState;
  onTravel: (planetId: PlanetId) => boolean;
  onRoleChange: (planetId: PlanetId, role: PlanetIndustryRole) => void;
  onStationPriorityChange: (entityId: string, slotIndex: number, priority: LogisticsPriority) => void;
  onStationMinimumLoadChange: (entityId: string, slotIndex: number, minimumLoad: StationMinimumLoad) => void;
  onStationLimitsChange: (entityId: string, slotIndex: number, minStock: number, maxStock: number) => void;
  onFocusStation: (entityId: string, planetId: PlanetId) => void;
}

function IndustryConsole({ game, onTravel, onRoleChange, onStationPriorityChange, onStationMinimumLoadChange, onStationLimitsChange, onFocusStation }: IndustryConsoleProps) {
  const [query, setQuery] = useState("");
  const [routeFilter, setRouteFilter] = useState<"all" | "remote" | "issues">("all");
  const routes = useMemo(() => getStellarRouteSnapshots(game), [game]);
  const logisticsDiagnostics = useMemo(() => getInterplanetaryLogisticsDiagnostics(game, routes), [game, routes]);
  const planets = useMemo(() => getPlanetIndustrySummaries(game, routes), [game, routes]);
  const systems = useMemo(() => getStarSystemIndustrySummaries(game, routes, planets), [game, planets, routes]);
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const visibleRoutes = routes.filter((route) => {
    if (routeFilter === "remote" && route.scope !== "remote") return false;
    if (routeFilter === "issues" && (route.status === "active" || route.status === "ready" || route.status === "missing-stock" || route.status === "target-full")) return false;
    if (!normalizedQuery) return true;
    const terms = `${getRouteEndpointLabel(route.sourceStationId, game)} ${getRouteEndpointLabel(route.targetStationId, game)} ${route.itemId}`.toLocaleLowerCase("zh-CN");
    return terms.includes(normalizedQuery);
  });
  const activeRoutes = routes.filter((route) => route.status === "active").length;
  const blockedRoutes = routes.filter((route) => !["active", "ready", "missing-stock", "target-full"].includes(route.status)).length;
  const soonestDepletion = planets.flatMap((planet) => planet.depletionSeconds == null ? [] : [planet.depletionSeconds]);

  return (
    <div className="stellar-industry">
      <div className="stellar-industry-summary" aria-label="星区工业摘要">
        <div><Factory size={15} /><span>工业设备<strong>{planets.reduce((sum, planet) => sum + planet.deviceCount, 0)}</strong></span></div>
        <div><Route size={15} /><span>航线运行<strong>{activeRoutes}/{routes.length}</strong></span></div>
        <div className={blockedRoutes > 0 ? "warning" : ""}><AlertTriangle size={15} /><span>航线问题<strong>{blockedRoutes}</strong></span></div>
        <div><Timer size={15} /><span>最近枯竭<strong>{formatDepletion(soonestDepletion.length > 0 ? Math.min(...soonestDepletion) : null)}</strong></span></div>
      </div>

      <section className="stellar-system-overview" aria-label="星系统计与行星工业标签">
        {systems.map((system) => (
          <article className="stellar-system-row" key={system.systemId}>
            <header>
              <span>{getStarSystemProfile(game, system.systemId).starTypeName} · 光度 {getStarSystemProfile(game, system.systemId).luminosity.toFixed(2)} L☉</span>
              <strong>{getStarSystemDisplayName(game, system.systemId)}</strong>
              <small>{system.deviceCount} 设备 · {system.routeCount} 航线 · 储量 {compactNumber(system.reserveRemaining)}</small>
              <em className={system.blockedRouteCount > 0 ? "warning" : ""}>{system.blockedRouteCount > 0 ? `${system.blockedRouteCount} 问题` : "运行正常"}</em>
            </header>
            <div>
              {system.planetIds.map((planetId) => {
                const planet = getPlanet(planetId);
                const summary = planets.find((candidate) => candidate.planetId === planetId)!;
                const colonized = isPlanetColonized(game, planetId);
                return (
                  <div className={`stellar-planet-row${summary.issues.length > 0 ? " stellar-planet-row--warning" : ""}`} key={planetId}>
                    <button type="button" disabled={!colonized} onClick={() => onTravel(planetId)} title={colonized ? `进入${getPlanetDisplayName(game, planetId)}` : `${getPlanetDisplayName(game, planetId)}尚未殖民`}>
                      <i style={{ color: planet.color }}><Orbit size={15} /></i>
                      <span><strong>{getPlanetDisplayName(game, planetId)}</strong><small>{game.galaxy.planetMetadata?.[planetId]?.tags?.length ? game.galaxy.planetMetadata[planetId]!.tags.join(" · ") : summary.tags.length > 0 ? summary.tags.join(" · ") : planet.environment}</small></span>
                    </button>
                    <label><span>工业角色</span><select aria-label={`${getPlanetDisplayName(game, planetId)}工业角色`} value={summary.role} onChange={(event) => onRoleChange(planetId, event.target.value as PlanetIndustryRole)}>{PLANET_ROLES.map((role) => <option value={role} key={role}>{PLANET_INDUSTRY_ROLE_LABELS[role]}{role === "auto" ? ` · ${PLANET_INDUSTRY_ROLE_LABELS[summary.detectedRole]}` : ""}</option>)}</select></label>
                    <div className="stellar-planet-metrics"><span><Zap size={11} />{Math.round(summary.powerFactor * 100)}%</span><span>宜 {PLANET_INDUSTRY_ROLE_LABELS[summary.recommendedRole]}</span><span>进 {summary.configuredImports}</span><span>出 {summary.configuredExports}</span><span>储 {compactNumber(summary.reserveRemaining)}</span></div>
                    {summary.issues.length > 0 ? <button className="stellar-problem-jump" type="button" onClick={() => summary.issues[0].entityId ? onFocusStation(summary.issues[0].entityId, planetId) : onTravel(planetId)}><LocateFixed size={12} />{summary.issues[0].label}</button> : <small className="stellar-depletion"><Timer size={11} />枯竭预测 {formatDepletion(summary.depletionSeconds)}</small>}
                  </div>
                );
              })}
            </div>
            <footer><span><Gauge size={12} />发电 <PowerValue valueKw={system.generationKw} /></span><span>负载 <PowerValue valueKw={system.demandKw} /></span><span>最近枯竭 {formatDepletion(system.soonestDepletionSeconds)}</span></footer>
          </article>
        ))}
      </section>

      <section className="interplanetary-diagnostics" aria-label="跨星物流诊断">
        <header><div><AlertTriangle size={15} /><span>跨星物流诊断</span><strong>{logisticsDiagnostics.length}</strong></div><small>按可处理优先级汇总远程物流塔、运输船、翘曲和电网问题</small></header>
        {logisticsDiagnostics.length === 0 ? <div className="interplanetary-diagnostics-empty"><Check size={16} /><span>当前没有需要处理的跨星物流问题</span></div> : <div>{logisticsDiagnostics.slice(0, 12).map((diagnostic) => {
          const focusSource = diagnostic.severity === "warning" && diagnostic.sourceStationId && diagnostic.sourcePlanetId;
          const focusId = focusSource ? diagnostic.sourceStationId! : diagnostic.targetStationId;
          const focusPlanet = focusSource ? diagnostic.sourcePlanetId! : diagnostic.targetPlanetId;
          return <article className={`interplanetary-diagnostic interplanetary-diagnostic--${diagnostic.severity}`} key={diagnostic.id}>
            <ItemHoverCard itemId={diagnostic.itemId}><ItemGlyph itemId={diagnostic.itemId} /></ItemHoverCard>
            <div><strong>{diagnostic.title.replace(diagnostic.itemId, getItem(diagnostic.itemId).name)}</strong><span>{diagnostic.detail.replace(diagnostic.itemId, getItem(diagnostic.itemId).name)}</span><small>{diagnostic.recommendation}</small></div>
            <button type="button" onClick={() => onFocusStation(focusId, focusPlanet)} title="定位相关物流站"><LocateFixed size={13} />定位</button>
          </article>;
        })}</div>}
      </section>

      <section className="stellar-route-console" aria-label="全局物流航线表">
        <header>
          <div><span>全星区调度</span><strong>全局航线表</strong></div>
          <label className="stellar-route-search"><Search size={14} /><StableTextInput draftId="stellar-route-search" value={query} onValueChange={setQuery} placeholder="搜索物品或行星" aria-label="搜索全局航线" /></label>
          <div className="stellar-route-filters" role="group" aria-label="航线筛选">
            <button type="button" className={routeFilter === "all" ? "active" : ""} onClick={() => setRouteFilter("all")}>全部</button>
            <button type="button" className={routeFilter === "remote" ? "active" : ""} onClick={() => setRouteFilter("remote")}>星际</button>
            <button type="button" className={routeFilter === "issues" ? "active" : ""} onClick={() => setRouteFilter("issues")}>问题 {blockedRoutes}</button>
          </div>
        </header>
        <div className="stellar-route-list">
          {visibleRoutes.map((route) => {
            const sourceSlot = route.sourceStationId != null && route.sourceSlotIndex != null
              ? getStellarStationSlot(game, route.sourceStationId, route.sourceSlotIndex)
              : null;
            const targetSlot = getStellarStationSlot(game, route.targetStationId, route.targetSlotIndex);
            const routePath = getRoutePathLabel(route, game);
            return (
              <article className={`stellar-route-row stellar-route-row--${route.status}`} key={route.id}>
                <div className="stellar-route-item"><ItemHoverCard itemId={route.itemId}><ItemGlyph itemId={route.itemId} /></ItemHoverCard><span><strong>{getItem(route.itemId).name}</strong><small>{route.scope === "remote" ? "星际运输" : "行星运输"} · {route.statusLabel}</small></span></div>
                <div className="stellar-route-endpoints"><button type="button" disabled={!route.sourceStationId || !route.sourcePlanetId} onClick={() => route.sourceStationId && route.sourcePlanetId && onFocusStation(route.sourceStationId, route.sourcePlanetId)}>{getRouteEndpointLabel(route.sourceStationId, game)}</button><ArrowRight size={14} /><button type="button" onClick={() => onFocusStation(route.targetStationId, route.targetPlanetId)}>{getRouteEndpointLabel(route.targetStationId, game)}</button></div>
                <div className="stellar-route-metrics"><span>航程 <strong>{getRouteDistanceLabel(route)}</strong></span><span>路径 <strong title={routePath}>{routePath}</strong></span><span>派遣 <strong>{route.dispatchDirection === "supply-delivery" ? "供应端送货" : route.dispatchDirection === "demand-pickup" ? "需求端取货" : "待定"}</strong></span><span>最长段 <strong>{route.maxLegDistanceLy > 0 ? `${route.maxLegDistanceLy.toFixed(1)} ly` : "-"}</strong></span><span>周期 <strong>{route.durationSeconds.toFixed(1)}s</strong></span><span>吞吐 <strong>{compactNumber(route.throughputPerMinute)}/min</strong></span><span>能耗 <strong>{route.energyMjPerTrip.toFixed(1)} MJ</strong></span><span>翘曲 <strong>{route.warpersPerTrip > 0 ? `${route.warpersPerTrip}/航次` : "无需"}</strong></span><span>策略 <strong>{{ direct: "直达", "relay-preferred": "优先中转", "relay-required": "强制中转" }[route.routePolicy]} · {route.warperBudget}</strong></span></div>
                <div className="stellar-route-policy">
                  <label><span>优先</span><select aria-label={`${getItem(route.itemId).name}航线优先级`} value={route.priority} onChange={(event) => onStationPriorityChange(route.targetStationId, route.targetSlotIndex, Number(event.target.value) as LogisticsPriority)}><option value={2}>高</option><option value={1}>中</option><option value={0}>低</option></select></label>
                  <label><span>装载</span><select aria-label={`${getItem(route.itemId).name}最低装载率`} value={route.minimumLoad} onChange={(event) => onStationMinimumLoadChange(route.targetStationId, route.targetSlotIndex, Number(event.target.value) as StationMinimumLoad)}><option value={0.1}>10%</option><option value={0.25}>25%</option><option value={0.5}>50%</option><option value={1}>100%</option></select></label>
                  <label><span>出口保底</span><input type="number" min={0} step={10} disabled={!sourceSlot || !route.sourceStationId || route.sourceSlotIndex == null} value={sourceSlot?.minStock ?? 0} aria-label={`${getItem(route.itemId).name}出口保底库存`} onChange={(event) => route.sourceStationId && route.sourceSlotIndex != null && sourceSlot && onStationLimitsChange(route.sourceStationId, route.sourceSlotIndex, Number(event.target.value), sourceSlot.maxStock)} /></label>
                  <label><span>进口上限</span><input type="number" min={0} step={10} value={targetSlot?.maxStock ?? 0} aria-label={`${getItem(route.itemId).name}进口库存上限`} onChange={(event) => targetSlot && onStationLimitsChange(route.targetStationId, route.targetSlotIndex, targetSlot.minStock, Number(event.target.value))} /></label>
                </div>
                <button className="stellar-route-locate" type="button" onClick={() => onFocusStation(route.targetStationId, route.targetPlanetId)} title="定位需求站" aria-label={`定位${getItem(route.itemId).name}需求站`}><LocateFixed size={14} /></button>
              </article>
            );
          })}
          {visibleRoutes.length === 0 ? <div className="stellar-route-empty"><Route size={22} /><strong>没有匹配的物流航线</strong><span>在物流站把槽位设为供应与需求后，航线会自动进入此表。</span></div> : null}
        </div>
      </section>
    </div>
  );
}

const NATIVE_ROUTE_QUERY_ENCODER = new TextEncoder();

function clampNativeRouteQuery(value: string): string {
  let result = "";
  for (const character of value.replace(/[\u0000-\u001f\u007f]/g, "")) {
    if (NATIVE_ROUTE_QUERY_ENCODER.encode(result + character).byteLength > NATIVE_STELLAR_ROUTE_QUERY_BYTES) break;
    result += character;
  }
  return result;
}

function nativeRouteRecommendation(status: NativeStarMapWorkspaceReadModel["routes"][number]["status"]): string {
  switch (status) {
    case "missing-source": return "检查供应槽位、物品和物流范围";
    case "missing-vehicle": return "补充运输机或运输船";
    case "missing-hub": return "补充可用中转站或调整航线策略";
    case "missing-warper": return "补充空间翘曲器或降低翘曲预算";
    case "no-power": return "恢复航线相关物流站供电";
    case "missing-stock": return "等待供应库存达到最低装载量";
    case "target-full": return "提高进口上限或消耗目标库存";
    case "ready": return "等待调度边界派遣";
    default: return "航线正在运行";
  }
}

export function NativeIndustryConsole({
  readModel,
  status,
  selector,
  onSelectorChange,
  onTravel,
  onNativeRoleChange,
  onNativeStationPriorityChange,
  onNativeStationMinimumLoadChange,
  onNativeStationRoutePolicyChange,
  onNativeStationWarperBudgetChange,
  onNativeStationLimitsChange,
  onFocusStation,
}: {
  readModel: NativeStarMapWorkspaceReadModel | null;
  status: StarMapNativeReadStatus;
  selector: StarMapIndustryReadRequest;
  onSelectorChange: (selector: StarMapIndustryReadRequest) => void;
  onTravel?: (planetId: PlanetId) => boolean;
  onNativeRoleChange?: NativePlanetRoleAction;
  onNativeStationPriorityChange?: NativeStationPriorityAction;
  onNativeStationMinimumLoadChange?: NativeStationMinimumLoadAction;
  onNativeStationRoutePolicyChange?: NativeStationRoutePolicyAction;
  onNativeStationWarperBudgetChange?: NativeStationWarperBudgetAction;
  onNativeStationLimitsChange?: NativeStationLimitsAction;
  onFocusStation: (entityId: string, planetId: PlanetId) => void;
}) {
  const scopedCatalogPlanets = selector.systemId
    ? getStarSystem(selector.systemId).planetIds
    : STAR_SYSTEM_LIST.flatMap((system) => system.planetIds);
  const visibleSystems = readModel?.systems.filter((system) =>
    selector.systemId === null || system.systemId === selector.systemId) ?? [];
  const visibleRoutes = readModel?.routes.flatMap((route) => {
    const indexed = readModel.routeRowsById.get(route.id);
    return indexed ? [indexed] : [];
  }) ?? [];
  const scopeLabel = selector.planetId
    ? readModel?.planetRowsById.get(selector.planetId)?.displayName ?? getPlanet(selector.planetId).name
    : selector.systemId
      ? readModel?.systemRowsById.get(selector.systemId)?.displayName ?? getStarSystem(selector.systemId).name
      : "全星区";
  const unavailableLabel = status === "loading"
    ? "正在同步原生权威星际工业投影…"
    : "原生权威星际工业投影暂不可用；为避免显示旧状态，当前不会回退 JavaScript 存档。";

  return (
    <div className="stellar-industry" data-native-stellar-read-status={status}>
      <div className="stellar-industry-summary" aria-label="星区工业摘要">
        <div><Factory size={15} /><span>工业设备<strong>{readModel ? readModel.planets.reduce((sum, planet) => sum + planet.deviceCount, 0) : "--"}</strong></span></div>
        <div><Route size={15} /><span>航线运行<strong>{readModel ? `${readModel.routeSummary.activeCount}/${readModel.routeSummary.scopeTotalCount}` : "--"}</strong></span></div>
        <div className={(readModel?.routeSummary.blockedCount ?? 0) > 0 ? "warning" : ""}><AlertTriangle size={15} /><span>航线问题<strong>{readModel ? readModel.routeSummary.blockedCount : "--"}</strong></span></div>
        <div id="native-stellar-command-boundary" role="status" aria-label="原生权威工业配置边界" title="工业定位、优先级、装载率、库存上下限及星际路线策略均使用当前投影 revision 的直接命令。"><LockKeyhole size={15} /><span>权威命令<strong>投影绑定</strong></span></div>
      </div>

      <section className="stellar-system-overview" aria-label="原生权威星系统计与行星工业标签">
        {!readModel ? <div className="stellar-route-empty"><Database size={22} /><strong>{unavailableLabel}</strong></div> : visibleSystems.map((system) => {
          const planets = readModel.planets.filter((planet) => planet.systemId === system.systemId);
          return <article className="stellar-system-row" key={system.systemId}>
            <header>
              <span>{system.starTypeName} · 光度 {system.luminosity.toFixed(2)} L☉</span>
              <strong>{system.displayName}</strong>
              <small>{system.deviceCount} 设备 · {system.routeCount} 航线 · {system.stationCount} 物流站</small>
              <em className={system.activeRouteCount < system.routeCount ? "warning" : ""}>{system.activeRouteCount}/{system.routeCount} 运行</em>
            </header>
            <div>{planets.map((planet) => {
              const congestedStation = planet.congestedStationId
                ? readModel.stationRowsById.get(planet.congestedStationId)
                : null;
              const matchedRouteCount = readModel.stations
                .filter((station) => station.planetId === planet.planetId)
                .reduce((sum, station) => sum + (readModel.routeRowsByTargetStationId.get(station.stationId)?.length ?? 0), 0);
              return <div className={`stellar-planet-row${congestedStation || planet.power.powerFactor < 0.999 ? " stellar-planet-row--warning" : ""}`} key={planet.planetId}>
                <button type="button" disabled={!planet.colonized || !onTravel} onClick={() => onTravel?.(planet.planetId as PlanetId)} title={!planet.colonized ? `${planet.displayName}尚未殖民` : onTravel ? `进入${planet.displayName}` : "原生权威行星切换命令尚未接入"}>
                  <i><Orbit size={15} /></i><span><strong>{planet.displayName}</strong><small>{planet.profile.climateName} · {planet.stationCount} 物流站</small></span>
                </button>
                <label><span>工业角色</span><select aria-label={`${planet.displayName}工业角色`} aria-describedby="native-stellar-command-boundary" title={onNativeRoleChange ? "由当前原生投影 revision 提交" : "原生权威命令暂不可用"} value={planet.industryRole} disabled={!onNativeRoleChange} onChange={(event) => onNativeRoleChange?.(readModel.revision, planet.planetId as PlanetId, planet.industryRole, event.target.value as PlanetIndustryRole)}>{PLANET_ROLES.map((role) => <option value={role} key={role}>{PLANET_INDUSTRY_ROLE_LABELS[role]}</option>)}</select></label>
                <div className="stellar-planet-metrics"><span><Zap size={11} />{Math.round(planet.power.powerFactor * 100)}%</span><span>设备 {planet.deviceCount}</span><span>进 {planet.configuredImportSlotCount}</span><span>出 {planet.configuredExportSlotCount}</span><span>匹配 {matchedRouteCount}</span></div>
                {congestedStation ? <button className="stellar-problem-jump" type="button" onClick={() => onFocusStation(congestedStation.stationId, congestedStation.planetId as PlanetId)}><LocateFixed size={12} />物流拥堵 {Math.round(congestedStation.congestion * 100)}%</button> : <small className="stellar-depletion"><Timer size={11} />吞吐 {compactNumber(planet.power.totalItemsPerMinute)}/min</small>}
              </div>;
            })}</div>
            <footer><span><Gauge size={12} />发电 <PowerValue valueKw={system.generationKw} /></span><span>负载 <PowerValue valueKw={system.demandKw} /></span><span>供电 {Math.round(system.powerFactor * 100)}%</span></footer>
          </article>;
        })}
      </section>

      <section className="stellar-route-console" aria-label="原生权威全局物流航线表">
        <header>
          <div><span>{scopeLabel}调度 · 匹配 {readModel?.routeSummary.filteredCount ?? "--"}</span><strong>全局航线表</strong></div>
          <label className="stellar-route-search"><Search size={14} /><StableTextInput draftId="stellar-route-search" value={selector.query} onValueChange={(query) => onSelectorChange({ ...selector, query: clampNativeRouteQuery(query) })} placeholder="搜索物品、行星或物流站" aria-label="搜索全局航线" /></label>
          <div className="stellar-route-filters" role="group" aria-label="航线范围与筛选">
            <select aria-label="星际工业恒星系筛选" value={selector.systemId ?? ""} onChange={(event) => onSelectorChange({ ...selector, systemId: event.target.value ? event.target.value as StarSystemId : null, planetId: null })}>
              <option value="">全部星系</option>{STAR_SYSTEM_LIST.map((system) => <option value={system.id} key={system.id}>{readModel?.systemRowsById.get(system.id)?.displayName ?? system.name}</option>)}
            </select>
            <select aria-label="星际工业行星筛选" value={selector.planetId ?? ""} onChange={(event) => { const planetId = event.target.value ? event.target.value as PlanetId : null; onSelectorChange({ ...selector, planetId, systemId: planetId ? getPlanet(planetId).systemId : selector.systemId }); }}>
              <option value="">全部行星</option>{scopedCatalogPlanets.map((planetId) => <option value={planetId} key={planetId}>{readModel?.planetRowsById.get(planetId)?.displayName ?? getPlanet(planetId).name}</option>)}
            </select>
            <button type="button" className={selector.routeFilter === "all" ? "active" : ""} onClick={() => onSelectorChange({ ...selector, routeFilter: "all" })}>全部</button>
            <button type="button" className={selector.routeFilter === "remote" ? "active" : ""} onClick={() => onSelectorChange({ ...selector, routeFilter: "remote" })}>星际</button>
            <button type="button" className={selector.routeFilter === "issues" ? "active" : ""} onClick={() => onSelectorChange({ ...selector, routeFilter: "issues" })}>问题 {readModel?.routeSummary.blockedCount ?? "--"}</button>
          </div>
        </header>
        <div className="stellar-route-list">
          {!readModel ? <div className="stellar-route-empty"><Database size={22} /><strong>{unavailableLabel}</strong></div> : visibleRoutes.map((route) => {
            const itemId = route.itemId as ItemId;
            const sourceStation = route.sourceStationId ? readModel.stationRowsById.get(route.sourceStationId) : null;
            const targetStation = readModel.stationRowsById.get(route.targetStationId);
            return <article className={`stellar-route-row stellar-route-row--${route.status}`} key={route.id}>
              <div className="stellar-route-item"><ItemHoverCard itemId={itemId}><ItemGlyph itemId={itemId} /></ItemHoverCard><span><strong>{route.itemLabel}</strong><small>{route.scope === "remote" ? "星际运输" : "行星运输"} · {route.statusLabel}</small></span></div>
              <div className="stellar-route-endpoints"><button type="button" disabled={!route.sourceStationId || !route.sourcePlanetId} onClick={() => route.sourceStationId && route.sourcePlanetId && onFocusStation(route.sourceStationId, route.sourcePlanetId as PlanetId)} title={sourceStation?.buildingLabel ?? route.sourceBuildingLabel ?? undefined}>{route.sourceStationLabel}</button><ArrowRight size={14} /><button type="button" onClick={() => onFocusStation(route.targetStationId, route.targetPlanetId as PlanetId)} title={targetStation?.buildingLabel ?? route.targetBuildingLabel ?? undefined}>{route.targetStationLabel}</button></div>
              <div className="stellar-route-metrics"><span>航程 <strong>{formatDistance(route.distanceLy)}</strong></span><span>路径 <strong title={route.routePathLabel}>{route.routePathLabel}</strong></span><span>派遣 <strong>{route.dispatchDirection === "supply-delivery" ? "供应端送货" : route.dispatchDirection === "demand-pickup" ? "需求端取货" : "待定"}</strong></span><span>最长段 <strong>{route.maxLegDistanceLy > 0 ? `${route.maxLegDistanceLy.toFixed(1)} ly` : "-"}</strong></span><span>周期 <strong>{route.durationSeconds.toFixed(1)}s</strong></span><span>吞吐 <strong>{compactNumber(route.throughputPerMinute)}/min</strong></span><span>能耗 <strong>{route.energyMjPerTrip.toFixed(1)} MJ</strong></span><span>翘曲 <strong>{route.warpersPerTrip > 0 ? `${route.warpersPerTrip}/航次` : "无需"}</strong></span><span>策略 <strong>{{ direct: "直达", "relay-preferred": "优先中转", "relay-required": "强制中转" }[route.routePolicy]} · {route.warperBudget}</strong></span></div>
              <div className="stellar-route-policy">
                <label><span>优先</span><select aria-label={`${route.itemLabel}航线优先级`} aria-describedby="native-stellar-command-boundary" title={onNativeStationPriorityChange ? "由当前原生投影 revision 提交" : "原生权威命令暂不可用"} value={route.priority} disabled={!onNativeStationPriorityChange} onChange={(event) => onNativeStationPriorityChange?.(readModel.revision, route.targetStationId, route.targetSlotIndex, route.priority as LogisticsPriority, Number(event.target.value) as LogisticsPriority)}><option value={2}>高</option><option value={1}>中</option><option value={0}>低</option></select></label>
                <label><span>装载</span><select aria-label={`${route.itemLabel}最低装载率`} aria-describedby="native-stellar-command-boundary" title={onNativeStationMinimumLoadChange ? "由当前原生投影 revision 提交" : "原生权威命令暂不可用"} value={route.minimumLoad} disabled={!onNativeStationMinimumLoadChange} onChange={(event) => onNativeStationMinimumLoadChange?.(readModel.revision, route.targetStationId, route.targetSlotIndex, route.minimumLoad as StationMinimumLoad, Number(event.target.value) as StationMinimumLoad, route.targetSlotIsPrimary)}><option value={0.1}>10%</option><option value={0.25}>25%</option><option value={0.5}>50%</option><option value={1}>100%</option></select></label>
                <label><span>路线</span><select aria-label={`${route.itemLabel}星际路线策略`} aria-describedby="native-stellar-command-boundary" title={onNativeStationRoutePolicyChange ? "由当前原生投影 revision 提交" : "原生权威命令暂不可用"} value={route.routePolicy} disabled={route.targetBuildingId !== "interstellar_logistics_station" || !onNativeStationRoutePolicyChange} onChange={(event) => onNativeStationRoutePolicyChange?.(readModel.revision, route.targetStationId, route.targetSlotIndex, route.routePolicy as InterstellarRoutePolicy, event.target.value as InterstellarRoutePolicy)}><option value="direct">直达</option><option value="relay-preferred">优先中转</option><option value="relay-required">强制中转</option></select></label>
                <label><span>翘曲预算</span><select aria-label={`${route.itemLabel}翘曲器预算`} aria-describedby="native-stellar-command-boundary" title={onNativeStationWarperBudgetChange ? "由当前原生投影 revision 提交" : "原生权威命令暂不可用"} value={route.warperBudget} disabled={route.targetBuildingId !== "interstellar_logistics_station" || !onNativeStationWarperBudgetChange} onChange={(event) => onNativeStationWarperBudgetChange?.(readModel.revision, route.targetStationId, route.targetSlotIndex, route.warperBudget, Number(event.target.value))}><option value={1}>1 跳</option><option value={2}>2 跳</option><option value={3}>3 跳</option><option value={4}>4 跳</option></select></label>
                <label><span>出口保底</span><input type="number" min={0} step={10} value={route.sourceSlotMinStock} aria-label={`${route.itemLabel}出口保底库存`} aria-describedby="native-stellar-command-boundary" title={onNativeStationLimitsChange ? "由当前原生投影 revision 提交" : "原生权威命令暂不可用"} disabled={!route.sourceStationId || route.sourceSlotIndex == null || !onNativeStationLimitsChange} onChange={(event) => route.sourceStationId && route.sourceSlotIndex != null && onNativeStationLimitsChange?.(readModel.revision, route.sourceStationId, route.sourceSlotIndex, route.sourceSlotMinStock, route.sourceSlotMaxStock, Number(event.target.value), route.sourceSlotMaxStock)} /></label>
                <label><span>进口上限</span><input type="number" min={0} step={10} value={route.targetSlotMaxStock} aria-label={`${route.itemLabel}进口库存上限`} aria-describedby="native-stellar-command-boundary" title={onNativeStationLimitsChange ? "由当前原生投影 revision 提交" : "原生权威命令暂不可用"} disabled={!onNativeStationLimitsChange} onChange={(event) => onNativeStationLimitsChange?.(readModel.revision, route.targetStationId, route.targetSlotIndex, route.targetSlotMinStock, route.targetSlotMaxStock, route.targetSlotMinStock, Number(event.target.value))} /></label>
              </div>
              <button className="stellar-route-locate" type="button" onClick={() => onFocusStation(route.targetStationId, route.targetPlanetId as PlanetId)} title={`${nativeRouteRecommendation(route.status)}；定位需求站`} aria-label={`定位${route.itemLabel}需求站`}><LocateFixed size={14} /></button>
            </article>;
          })}
          {readModel && visibleRoutes.length === 0 ? <div className="stellar-route-empty"><Route size={22} /><strong>没有匹配的原生权威物流航线</strong><span>调整星系、行星、筛选或搜索条件后重试。</span></div> : null}
        </div>
      </section>
    </div>
  );
}

const QUANTUM_CAPACITY_LABELS: Record<(typeof QUANTUM_ITEM_CAPACITY_PRESETS)[number], string> = {
  "10000": "1万",
  "100000": "10万",
  "1000000": "100万",
  "10000000": "1000万",
  "100000000": "1亿",
  "1000000000": "10亿",
  "10000000000": "100亿",
};

function QuantumCapacityEditor({ itemId, itemLabel = ITEMS[itemId]?.name ?? itemId, value, disabled = false, onChange }: {
  itemId: ItemId;
  itemLabel?: string;
  value: string;
  disabled?: boolean;
  onChange: (itemId: ItemId, value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDraft(value);
    setError(null);
  }, [itemId, value]);
  const commit = (nextValue = draft) => {
    if (disabled) return;
    const raw = nextValue.trim();
    if (!raw) {
      setError("请输入容量");
      return;
    }
    if (!/^\d+$/.test(raw)) {
      setError("只能输入正整数，不支持小数、负数或指数格式");
      return;
    }
    const normalized = raw.replace(/^0+(?=\d)/, "");
    const amount = BigInt(normalized);
    if (amount < BigInt(QUANTUM_ITEM_CAPACITY_MIN)) {
      setError("容量不能低于 1万");
      return;
    }
    if (amount > BigInt(QUANTUM_ITEM_CAPACITY_MAX)) {
      setError("容量不能高于 100亿");
      return;
    }
    setDraft(normalized);
    setError(null);
    onChange(itemId, normalized);
  };
  const presetSelected = QUANTUM_ITEM_CAPACITY_PRESETS.includes(value as (typeof QUANTUM_ITEM_CAPACITY_PRESETS)[number]);
  return <div className="quantum-capacity-editor">
    <div className="quantum-capacity-presets" aria-label={`${itemLabel}容量预设`}>
      {QUANTUM_ITEM_CAPACITY_PRESETS.map((preset) => <button className={value === preset ? "active" : ""} type="button" key={preset} disabled={disabled} onClick={() => { setDraft(preset); setError(null); onChange(itemId, preset); }}>{QUANTUM_CAPACITY_LABELS[preset]}</button>)}
      <button className={!presetSelected ? "active" : ""} type="button" disabled={disabled} onClick={() => setDraft(value)}>自定义</button>
    </div>
    <div className="quantum-capacity-custom">
      <input aria-label={`${itemLabel}自定义量子容量`} aria-invalid={Boolean(error)} inputMode="numeric" pattern="[0-9]*" value={draft} disabled={disabled} onChange={(event) => { setDraft(event.target.value); setError(null); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commit(); } }} />
      <button type="button" disabled={disabled} onClick={() => commit()}><Save size={13} />应用</button>
    </div>
    {error ? <small className="quantum-capacity-error" role="alert">{error}</small> : null}
  </div>;
}

function QuantumInventoryConsole({ game, onCollectorModeChange, onItemCapacityChange }: {
  game: GameState;
  onCollectorModeChange: (enabled: boolean, systemId?: StarSystemId) => void;
  onItemCapacityChange: (itemId: ItemId, value: string) => void;
}) {
  const { isEnglish } = useAppLocale();
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const level = game.endgame.infiniteResearch.galactic_logistics?.level ?? 0;
  const bandwidth = getQuantumBandwidthSummary(game.entities, level);
  const collectors = game.entities.filter((entity) => entity.buildingId === "orbital_collector");
  const connectedCollectors = collectors.filter((entity) => entity.quantumMode === "quantum");
  const pendingCollectors = collectors.filter((entity) => entity.quantumMode === "transitioning");
  const availableCollectors = collectors.filter((entity) => (entity.quantumMode ?? "legacy") === "legacy" && !entity.quantumTransition);
  const runtime = game.quantumLogisticsNetwork.runtimeFlow;
  const visibleItems = Object.values(ITEMS).filter((item) => !normalizedQuery || `${item.name} ${item.id}`.toLocaleLowerCase("zh-CN").includes(normalizedQuery));
  return <section className="quantum-inventory-console" aria-label="量子空间库存">
    <header className="quantum-inventory-summary">
      <div><Atom size={18} /><span><small>量子空间库存</small><strong>全星区共享物资池</strong></span></div>
      <dl>
        <div><dt>{isEnglish ? "Instant upload" : "即时上传"}</dt><dd>{isEnglish ? "Unlimited" : "不限"}</dd><small>{isEnglish ? "Deposited on delivery first" : "送达时优先入库"}</small></div>
        <div><dt>下载额度</dt><dd>{formatQuantityCompact(Math.floor(bandwidth.globalDownloadPerMinute))}<small>/min</small></dd></div>
        <div><dt>量子塔堆叠</dt><dd>{formatQuantityCompact(bandwidth.activeTowerStacks)}</dd></div>
        <div><dt>量子采集器</dt><dd>{formatQuantityCompact(connectedCollectors.reduce((sum, entity) => sum + entity.machineCount, 0))}</dd></div>
      </dl>
      <div className="quantum-collector-actions">
        <button type="button" disabled={availableCollectors.length === 0} onClick={() => onCollectorModeChange(true)}><ArrowUpFromLine size={15} />全部采集器接入{availableCollectors.length ? `（${availableCollectors.length}）` : ""}</button>
        <button type="button" disabled={connectedCollectors.length === 0} onClick={() => onCollectorModeChange(false)}><ArrowDownToLine size={15} />全部采集器关闭{connectedCollectors.length ? `（${connectedCollectors.length}）` : ""}</button>
        {pendingCollectors.length > 0 ? <small>{pendingCollectors.length} 台正在等待五秒边界或传统航线尾货</small> : null}
      </div>
    </header>
    <div className="quantum-inventory-toolbar">
      <label className="star-map-search"><Search size={15} /><StableTextInput draftId="quantum-inventory-search" value={query} onValueChange={setQuery} placeholder="搜索量子库存物品" aria-label="搜索量子库存物品" />{query ? <button type="button" onClick={() => setQuery("")} aria-label="清除量子库存搜索"><X size={14} /></button> : null}</label>
      <span>{runtime ? `最近结算 ${formatQuantityExact(runtime.boundarySecond)} 秒` : "等待首个五秒结算边界"}</span>
    </div>
    <div className="quantum-inventory-list">
      {visibleItems.map((item) => {
        const inventory = game.quantumLogisticsNetwork.inventory[item.id] ?? "0";
        const capacity = getQuantumItemCapacity(game.quantumLogisticsNetwork, item.id);
        const uploaded = runtime?.uploaded[item.id] ?? "0";
        const downloaded = runtime?.downloaded[item.id] ?? "0";
        const net = BigInt(uploaded) - BigInt(downloaded);
        const overCapacity = BigInt(inventory) > BigInt(capacity);
        return <article className={`quantum-inventory-row${overCapacity ? " quantum-inventory-row--over" : ""}`} key={item.id}>
          <div className="quantum-inventory-item"><ItemHoverCard itemId={item.id}><ItemGlyph itemId={item.id} /></ItemHoverCard><span><strong>{item.name}</strong><small>{item.id}</small></span></div>
          <div className="quantum-inventory-amount"><span>当前库存</span><strong title={formatQuantityExact(inventory)}>{formatQuantityCompact(inventory)}</strong><small>{formatQuantityScientific(inventory)} · 精确 {formatQuantityExact(inventory)}</small>{overCapacity ? <em>超出上限，仅允许下载</em> : null}</div>
          <div className="quantum-inventory-flow"><span><ArrowUpFromLine size={12} />上传 {formatQuantityCompact(uploaded)}</span><span><ArrowDownToLine size={12} />下载 {formatQuantityCompact(downloaded)}</span><strong className={net < 0n ? "negative" : net > 0n ? "positive" : ""}>净变化 {net > 0n ? "+" : ""}{formatQuantityExact(net)}</strong></div>
          <QuantumCapacityEditor itemId={item.id} value={capacity} onChange={onItemCapacityChange} />
        </article>;
      })}
      {visibleItems.length === 0 ? <div className="stellar-route-empty"><Database size={22} /><strong>没有匹配的量子物品</strong><span>清除搜索后查看全部物品。</span></div> : null}
    </div>
  </section>;
}

export function NativeQuantumInventoryConsole({
  readModel,
  status,
  onNativeItemCapacityChange,
}: {
  readModel: NativeStellarQuantumReadModel | null;
  status: StarMapNativeReadStatus;
  onNativeItemCapacityChange?: NativeQuantumItemCapacityAction;
}) {
  const { isEnglish } = useAppLocale();
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const visibleItems = readModel?.items.filter((row) => {
    const item = ITEMS[row.itemId as ItemId];
    return !normalizedQuery || `${item?.name ?? ""} ${row.itemId}`.toLocaleLowerCase("zh-CN").includes(normalizedQuery);
  }) ?? [];
  if (!readModel) {
    const emptyStatus = status === "ready" ? "unavailable" : status;
    return <section className="quantum-inventory-console" aria-label="量子空间库存" data-native-quantum-read-status={emptyStatus}>
      <div className="stellar-route-empty"><Database size={22} /><strong>{status === "loading" ? "正在同步原生权威量子库存" : "原生权威量子库存暂不可用"}</strong><span>{status === "loading" ? "等待同一 Rust revision 的全部物品与采集器分页完成。" : "当前不会读取或显示 JavaScript 存档中的旧量子数据。"}</span></div>
    </section>;
  }
  const runtime = readModel.runtime;
  return <section className="quantum-inventory-console" aria-label="量子空间库存" data-native-quantum-read-status="ready">
    <header className="quantum-inventory-summary">
      <div><Atom size={18} /><span><small>量子空间库存</small><strong>{readModel.enabled ? "Rust 权威共享物资池" : "量子网络尚未启用"}</strong></span></div>
      <dl>
        <div><dt>{isEnglish ? "Instant upload" : "即时上传"}</dt><dd>{isEnglish ? "Unlimited" : "不限"}</dd><small>{isEnglish ? "Native authority projection" : "原生权威投影"}</small></div>
        <div><dt>下载额度</dt><dd>{formatQuantityCompact(Math.floor(readModel.bandwidth.globalDownloadPerMinute))}<small>/min</small></dd></div>
        <div><dt>量子塔堆叠</dt><dd>{formatQuantityCompact(readModel.bandwidth.activeTowerStacks)}</dd></div>
        <div><dt>量子采集器</dt><dd>{formatQuantityCompact(readModel.collectorSummary.connectedStacks)}</dd></div>
      </dl>
      <div className="quantum-collector-actions" aria-describedby="native-quantum-command-boundary">
        <button type="button" disabled><ArrowUpFromLine size={15} />全部采集器接入{readModel.collectorSummary.availableCount ? `（${readModel.collectorSummary.availableCount}）` : ""}</button>
        <button type="button" disabled><ArrowDownToLine size={15} />全部采集器关闭{readModel.collectorSummary.connectedCount ? `（${readModel.collectorSummary.connectedCount}）` : ""}</button>
        {readModel.collectorSummary.pendingCount > 0 ? <small>{readModel.collectorSummary.pendingCount} 台正在等待五秒边界或传统航线尾货</small> : null}
        <small id="native-quantum-command-boundary">采集器批量切换仍只读；不会回写旧 JavaScript 存档。</small>
      </div>
    </header>
    <div className="quantum-inventory-toolbar">
      <label className="star-map-search"><Search size={15} /><StableTextInput draftId="quantum-inventory-search" value={query} onValueChange={setQuery} placeholder="搜索量子库存物品" aria-label="搜索量子库存物品" />{query ? <button type="button" onClick={() => setQuery("")} aria-label="清除量子库存搜索"><X size={14} /></button> : null}</label>
      <span>{runtime ? `最近结算 ${formatQuantityExact(runtime.boundarySecond)} 秒` : "等待首个五秒结算边界"}</span>
    </div>
    <div className="quantum-inventory-list">
      {visibleItems.map((row) => {
        const itemId = row.itemId as ItemId;
        const item = ITEMS[itemId];
        const itemLabel = item?.name ?? row.itemId;
        const net = BigInt(row.uploaded) - BigInt(row.downloaded);
        const overCapacity = BigInt(row.inventory) > BigInt(row.capacity);
        return <article className={`quantum-inventory-row${overCapacity ? " quantum-inventory-row--over" : ""}`} key={row.itemId}>
          <div className="quantum-inventory-item">{item ? <ItemHoverCard itemId={itemId}><ItemGlyph itemId={itemId} /></ItemHoverCard> : <Database size={18} />}<span><strong>{itemLabel}</strong><small>{row.itemId}</small></span></div>
          <div className="quantum-inventory-amount"><span>当前库存</span><strong title={formatQuantityExact(row.inventory)}>{formatQuantityCompact(row.inventory)}</strong><small>{formatQuantityScientific(row.inventory)} · 精确 {formatQuantityExact(row.inventory)}</small>{overCapacity ? <em>超出上限，仅允许下载</em> : null}</div>
          <div className="quantum-inventory-flow"><span><ArrowUpFromLine size={12} />上传 {formatQuantityCompact(row.uploaded)}</span><span><ArrowDownToLine size={12} />下载 {formatQuantityCompact(row.downloaded)}</span><strong className={net < 0n ? "negative" : net > 0n ? "positive" : ""}>净变化 {net > 0n ? "+" : ""}{formatQuantityExact(net)}</strong></div>
          <QuantumCapacityEditor itemId={itemId} itemLabel={itemLabel} value={row.capacity} disabled={!onNativeItemCapacityChange} onChange={(_itemId, targetCapacity) => onNativeItemCapacityChange?.(readModel.revision, itemId, row.capacity, targetCapacity)} />
        </article>;
      })}
      {visibleItems.length === 0 ? <div className="stellar-route-empty"><Database size={22} /><strong>没有匹配的量子物品</strong><span>清除搜索后查看全部物品。</span></div> : null}
    </div>
  </section>;
}

export function NativeStarMapCatalogConsole({
  frame,
  status,
  query,
  onQueryChange,
  onOpenSystemSpaceStation,
  pending = false,
  onExplore,
  onColonize,
  onTravel,
  onPlanetMetadataChange,
  onSystemNameChange,
  onUpgradeStations,
  onAttachQuantumStations,
  onCollectorQuantumMode,
}: {
  frame: NativeStarMapCatalogFrame | null;
  status: StarMapNativeReadStatus;
  query: string;
  onQueryChange: (query: string) => void;
  onOpenSystemSpaceStation?: (systemId: StarSystemId) => void;
  pending?: boolean;
  onExplore?: (revision: number, systemId: StarSystemId) => boolean;
  onColonize?: (revision: number, planetId: PlanetId) => boolean;
  onTravel?: (planetId: PlanetId) => boolean;
  onPlanetMetadataChange?: (revision: number, planetId: PlanetId, metadata: { customName: string; note: string; tags: string[] }) => boolean;
  onSystemNameChange?: (revision: number, systemId: StarSystemId, name: string) => boolean;
  onUpgradeStations?: (revision: number, systemId: StarSystemId | null) => boolean;
  onAttachQuantumStations?: (revision: number, systemId: StarSystemId | null) => boolean;
  onCollectorQuantumMode?: (revision: number, systemId: StarSystemId | null, enabled: boolean) => boolean;
}) {
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  if (!frame) {
    const emptyStatus = status === "ready" ? "unavailable" : status;
    return <div className="stellar-route-empty" data-native-star-map-catalog-status={emptyStatus}><Database size={22} /><strong>{emptyStatus === "loading" ? "正在同步原生权威星图目录" : "原生权威星图目录暂不可用"}</strong><span>{emptyStatus === "loading" ? "等待同一 Rust revision 的全部星系与行星分页完成。" : "当前不会读取或显示 JavaScript 存档中的旧星图数据。"}</span></div>;
  }
  const visibleSystems = frame.systems.filter((system) => {
    if (!normalizedQuery) return true;
    const systemText = `${system.systemId} ${system.displayName} ${system.starTypeName}`.toLocaleLowerCase("zh-CN");
    if (systemText.includes(normalizedQuery)) return true;
    return (frame.planetRowsBySystemId.get(system.systemId) ?? []).some((planet) => {
      const text = [
        planet.planetId,
        planet.displayName,
        planet.profile.climateName,
        planet.profile.specializationName,
        planet.metadata.note,
        ...planet.metadata.tags.rows,
        ...planet.profile.resourceIds.rows,
        ...planet.profile.rareResourceIds.rows,
        ...planet.profile.orbitalYields.rows.map((row) => row.itemId),
      ].join(" ").toLocaleLowerCase("zh-CN");
      return text.includes(normalizedQuery);
    });
  });
  const itemLabel = (itemId: string): string => ITEMS[itemId as ItemId]?.name ?? itemId;
  const writeActionsAvailable = Boolean(onExplore || onColonize || onTravel || onPlanetMetadataChange ||
    onSystemNameChange || onUpgradeStations || onAttachQuantumStations || onCollectorQuantumMode);
  return <div data-native-star-map-catalog-status="ready">
    <div className="star-map-controls">
      <div className="star-map-controls__search"><label className="star-map-search"><Search size={15} /><StableTextInput draftId="star-map-search" value={query} onValueChange={onQueryChange} placeholder="搜索名称、备注、标签或资源" aria-label="搜索原生星球资料" />{query ? <button type="button" onClick={() => onQueryChange("")} aria-label="清除星图搜索"><X size={14} /></button> : null}</label><small>{normalizedQuery ? `${visibleSystems.length} 个匹配星系` : `${frame.summary.planetCount} 颗行星由 Rust 权威提供`}</small></div>
      <div className="star-map-batch-report" id="native-star-map-command-boundary" role="status"><LockKeyhole size={13} /><strong>{writeActionsAvailable ? "Rust 权威星图" : "星图资料只读"}</strong><span>{pending ? "正在耐久提交上一项星图操作。" : writeActionsAvailable ? "勘探、殖民、改名、备注和行星切换均直接提交到当前 Rust revision。" : "当前宿主没有提供星图耐久命令通道；不会回写旧 JavaScript 存档。"}</span></div>
      {onUpgradeStations || onAttachQuantumStations || onCollectorQuantumMode ? <div className="star-map-bulk-actions" aria-label="Rust 原生全星区批量操作">
        {onUpgradeStations ? <button type="button" disabled={pending} onClick={() => onUpgradeStations(frame.revision, null)}><Sparkles size={14} />升级全部物流站</button> : null}
        {onAttachQuantumStations ? <button type="button" disabled={pending} onClick={() => onAttachQuantumStations(frame.revision, null)}><Atom size={14} />全部接入量子物流</button> : null}
        {onCollectorQuantumMode ? <><button type="button" disabled={pending} onClick={() => onCollectorQuantumMode(frame.revision, null, true)}><Atom size={14} />全部轨采接入量子</button><button type="button" disabled={pending} onClick={() => onCollectorQuantumMode(frame.revision, null, false)}>全部轨采切回传统</button></> : null}
      </div> : null}
      {frame.metadataTruncated ? <div className="star-map-batch-report" role="status"><AlertTriangle size={13} /><strong>部分扩展资料过长</strong><span>当前页只显示有界摘要，权威存档内容没有被修改。</span></div> : null}
    </div>
    <div className="star-map-route" aria-label="原生权威恒星系目录">
      {visibleSystems.map((system, index) => {
        const staticSystem = STAR_SYSTEM_LIST.find((candidate) => candidate.id === system.systemId);
        const planets = frame.planetRowsBySystemId.get(system.systemId) ?? [];
        const style = { "--system-color": staticSystem?.color ?? "#77a9c8" } as CSSProperties;
        return <div className="star-map-route__segment" key={system.systemId}>
          {index > 0 ? <div className={`star-route-link${system.discovered ? " star-route-link--open" : ""}`}><i /><ArrowRight size={16} /><span>{formatDistance(system.distanceFromOriginLy)}</span></div> : null}
          <article className={`star-system-card${system.discovered ? " star-system-card--unlocked" : " star-system-card--locked"}${system.active ? " star-system-card--active" : ""}`} style={style}>
            <header><i className="star-system-orb"><Sparkles size={20} /></i><div><span>{staticSystem?.code ?? system.systemId}</span><strong>{system.displayName}</strong><small>{system.starTypeName} · {system.luminosity.toFixed(2)} L☉ · {formatDistance(system.distanceFromOriginLy)}</small></div><em>{system.active ? <><Navigation size={12} /> 当前</> : system.discovered ? <><Check size={12} /> 已发现{system.missionActive ? " · 勘探中" : ""}</> : <><LockKeyhole size={12} /> 未勘探</>}</em></header>
            <div className="star-system-space-station-actions">
              {!system.discovered ? <button
                className="star-system-space-station-upgrade"
                type="button"
                disabled={pending || !onExplore}
                onClick={() => onExplore?.(frame.revision, system.systemId as StarSystemId)}
              ><Telescope size={14} />开始勘探</button> : null}
              {system.discovered && onUpgradeStations ? <button type="button" disabled={pending} onClick={() => onUpgradeStations(frame.revision, system.systemId as StarSystemId)}><Sparkles size={14} />升级本系物流站</button> : null}
              {system.discovered && onAttachQuantumStations ? <button type="button" disabled={pending} onClick={() => onAttachQuantumStations(frame.revision, system.systemId as StarSystemId)}><Atom size={14} />接入本系量子物流</button> : null}
              {system.discovered && onCollectorQuantumMode ? <button type="button" disabled={pending} onClick={() => onCollectorQuantumMode(frame.revision, system.systemId as StarSystemId, true)}><Atom size={14} />本系轨采接入量子</button> : null}
              <button
                className="star-system-space-station-upgrade"
                type="button"
                disabled={!system.discovered || !staticSystem || !onOpenSystemSpaceStation}
                onClick={() => staticSystem && onOpenSystemSpaceStation?.(staticSystem.id)}
                data-native-system-space-station-entry={system.systemId}
              ><Factory size={14} />管理本系空间站</button>
            </div>
            {onSystemNameChange ? <details className="stellar-metadata-manager stellar-metadata-manager--compact">
              <summary><Pencil size={14} /><span>恒星系名称</span></summary>
              <form onSubmit={(event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                onSystemNameChange?.(frame.revision, system.systemId as StarSystemId, String(data.get("name") ?? ""));
              }}>
                <label><span>自定义名称</span><input name="name" maxLength={STAR_SYSTEM_CUSTOM_NAME_MAX_LENGTH} defaultValue={staticSystem && system.displayName === staticSystem.name ? "" : system.displayName} disabled={pending || !onSystemNameChange} /></label>
                <footer><button type="submit" disabled={pending || !onSystemNameChange}><Save size={13} />保存名称</button></footer>
              </form>
            </details> : null}
            <p>{staticSystem?.description ?? `恒星质量 ${system.massMultiplier.toFixed(2)} · 半径 ${system.radiusMultiplier.toFixed(2)}`}</p>
            <div className="star-planet-list">
              {planets.map((planet) => {
                const staticPlanet = PLANETS[planet.planetId as PlanetId];
                const resources = planet.kind === "gas-giant"
                  ? planet.profile.orbitalYields.rows.map((row) => `${itemLabel(row.itemId)} ${row.rate.toFixed(2)}/min`)
                  : planet.profile.resourceIds.rows.map(itemLabel);
                const note = planet.metadata.note || `${planet.profile.specializationName} · 宜 ${PLANET_INDUSTRY_ROLE_LABELS[planet.industryRole]}`;
                if (!writeActionsAvailable) return <button type="button" key={planet.planetId} disabled aria-describedby="native-star-map-command-boundary" title="当前宿主没有提供原生星图耐久命令" className={`${planet.active ? "active" : ""}${planet.colonized ? "" : " planet-uncolonized"}`}>
                  <i style={{ color: staticPlanet?.color ?? "#77a9c8" }}><Orbit size={17} /></i>
                  <span><strong>{planet.displayName}</strong><small>{planet.profile.climateName} · {OCEAN_LABELS[planet.profile.oceanType as keyof typeof OCEAN_LABELS] ?? planet.profile.oceanType}{planet.profile.tidalLocked ? " · 潮汐锁定" : ""}</small></span>
                  <em>{planet.colonized ? planet.kind === "gas-giant" ? "轨道" : `${planet.deviceCount} 设备` : "未殖民"}</em>
                  <p>{resources.join("、") || "无地表矿脉"}{planet.profile.rareResourceIds.rows.length > 0 ? ` · 稀有 ${planet.profile.rareResourceIds.rows.map(itemLabel).join("、")}` : ""}</p>
                  <small className="star-planet-profile">{note}{planet.metadata.tags.rows.length ? ` · #${planet.metadata.tags.rows.join(" #")}` : ""}</small>
                  <span className="star-planet-traits" aria-label={`${planet.displayName}工业环境`}><b title={planet.kind === "gas-giant" ? "轨道采集产率" : "有限矿脉总储量"}>{planet.kind === "gas-giant" ? "轨采" : "矿储"} <strong>{Math.round((planet.kind === "gas-giant" ? planet.profile.orbitalYieldMultiplier : planet.profile.reserveScale) * 100)}%</strong></b><b title="风力发电倍率">风 <strong>{Math.round(planet.profile.windMultiplier * 100)}%</strong></b><b title="太阳能倍率">光 <strong>{Math.round(planet.profile.solarMultiplier * system.luminosity * (planet.profile.tidalLocked ? 1.25 : 1) * 100)}%</strong></b><b title="地热发电倍率">地热 <strong>{Math.round(planet.profile.geothermalMultiplier * 100)}%</strong></b><b title="跨行星航程时间倍率">航程 <strong>{Math.round(planet.profile.travelTimeMultiplier * 100)}%</strong></b></span>
                </button>;
                return <article key={planet.planetId} className={`star-planet-native-row${planet.active ? " active" : ""}${planet.colonized ? "" : " planet-uncolonized"}`}>
                  <button type="button" disabled={pending || !planet.colonized || !onTravel} aria-describedby="native-star-map-command-boundary" title={planet.colonized ? `进入${planet.displayName}` : "需要先建立殖民前哨"} onClick={() => onTravel?.(planet.planetId as PlanetId)}>
                    <i style={{ color: staticPlanet?.color ?? "#77a9c8" }}><Orbit size={17} /></i>
                    <span><strong>{planet.displayName}</strong><small>{planet.profile.climateName} · {OCEAN_LABELS[planet.profile.oceanType as keyof typeof OCEAN_LABELS] ?? planet.profile.oceanType}{planet.profile.tidalLocked ? " · 潮汐锁定" : ""}</small></span>
                    <em>{planet.colonized ? planet.kind === "gas-giant" ? "轨道" : `${planet.deviceCount} 设备` : "未殖民"}</em>
                    <p>{resources.join("、") || "无地表矿脉"}{planet.profile.rareResourceIds.rows.length > 0 ? ` · 稀有 ${planet.profile.rareResourceIds.rows.map(itemLabel).join("、")}` : ""}</p>
                    <small className="star-planet-profile">{note}{planet.metadata.tags.rows.length ? ` · #${planet.metadata.tags.rows.join(" #")}` : ""}</small>
                    <span className="star-planet-traits" aria-label={`${planet.displayName}工业环境`}><b title={planet.kind === "gas-giant" ? "轨道采集产率" : "有限矿脉总储量"}>{planet.kind === "gas-giant" ? "轨采" : "矿储"} <strong>{Math.round((planet.kind === "gas-giant" ? planet.profile.orbitalYieldMultiplier : planet.profile.reserveScale) * 100)}%</strong></b><b title="风力发电倍率">风 <strong>{Math.round(planet.profile.windMultiplier * 100)}%</strong></b><b title="太阳能倍率">光 <strong>{Math.round(planet.profile.solarMultiplier * system.luminosity * (planet.profile.tidalLocked ? 1.25 : 1) * 100)}%</strong></b><b title="地热发电倍率">地热 <strong>{Math.round(planet.profile.geothermalMultiplier * 100)}%</strong></b><b title="跨行星航程时间倍率">航程 <strong>{Math.round(planet.profile.travelTimeMultiplier * 100)}%</strong></b></span>
                  </button>
                  {!planet.colonized && planet.discovered ? <button type="button" disabled={pending || !onColonize} onClick={() => onColonize?.(frame.revision, planet.planetId as PlanetId)}><Navigation size={13} />建立殖民前哨</button> : null}
                  {onPlanetMetadataChange ? <details className="stellar-metadata-manager stellar-metadata-manager--compact">
                    <summary><Pencil size={13} /><span>名称、备注与标签</span></summary>
                    <form onSubmit={(event) => {
                      event.preventDefault();
                      const data = new FormData(event.currentTarget);
                      const tags = String(data.get("tags") ?? "").split(/[，,\n]/).map((tag) => tag.trim()).filter(Boolean).slice(0, PLANET_TAG_MAX_COUNT);
                      onPlanetMetadataChange?.(frame.revision, planet.planetId as PlanetId, {
                        customName: String(data.get("customName") ?? ""),
                        note: String(data.get("note") ?? ""),
                        tags,
                      });
                    }}>
                      <label><span>自定义名称</span><input name="customName" maxLength={PLANET_CUSTOM_NAME_MAX_LENGTH} defaultValue={staticPlanet && planet.displayName === staticPlanet.name ? "" : planet.displayName} disabled={pending || !onPlanetMetadataChange} /></label>
                      <label><span>备注</span><textarea name="note" maxLength={PLANET_NOTE_MAX_LENGTH} defaultValue={planet.metadata.note} disabled={pending || !onPlanetMetadataChange} /></label>
                      <label><span>标签</span><input name="tags" defaultValue={planet.metadata.tags.rows.join("，")} disabled={pending || !onPlanetMetadataChange} /></label>
                      <footer><button type="submit" disabled={pending || !onPlanetMetadataChange}><Save size={13} />保存资料</button></footer>
                    </form>
                  </details> : null}
                </article>;
              })}
            </div>
            {system.missionActive ? <footer className="star-system-ready star-system-surveying"><Telescope size={13} /><div><span>深度勘探 {Math.round(system.surveyProgress * 100)}%</span><i><b style={{ width: `${system.surveyProgress * 100}%` }} /></i></div></footer> : <footer className="star-system-ready">{system.discovered ? <Check size={13} /> : <LockKeyhole size={13} />}<span>{system.discovered ? "永久航标在线" : "等待勘探命令"}</span></footer>}
          </article>
        </div>;
      })}
      {visibleSystems.length === 0 ? <div className="stellar-route-empty"><Database size={22} /><strong>没有匹配的星系或行星</strong><span>清除搜索后查看全部原生权威星图资料。</span></div> : null}
    </div>
  </div>;
}

export function NativeStarMapWorkspace({
  open,
  mapCatalogFrame,
  mapCatalogStatus = "ready",
  readModel,
  readStatus = "ready",
  quantumReadModel,
  quantumReadStatus = "ready",
  industryReadRequest,
  onIndustryReadRequest,
  onClose,
  onNativeRoleChange,
  onNativeStationPriorityChange,
  onNativeStationMinimumLoadChange,
  onNativeStationRoutePolicyChange,
  onNativeStationWarperBudgetChange,
  onNativeStationLimitsChange,
  onFocusStation,
  onNativeQuantumItemCapacityChange,
  onOpenSystemSpaceStation,
  nativeCommandPending = false,
  onNativeExplore,
  onNativeColonize,
  onNativeTravel,
  onNativePlanetMetadataChange,
  onNativeSystemNameChange,
  onNativeUpgradeStations,
  onNativeAttachQuantumStations,
  onNativeCollectorQuantumMode,
}: {
  open: boolean;
  mapCatalogFrame: NativeStarMapCatalogFrame | null;
  mapCatalogStatus?: StarMapNativeReadStatus;
  readModel: NativeStarMapWorkspaceReadModel | null;
  readStatus?: StarMapNativeReadStatus;
  quantumReadModel: NativeStellarQuantumReadModel | null;
  quantumReadStatus?: StarMapNativeReadStatus;
  industryReadRequest: StarMapIndustryReadRequest;
  onIndustryReadRequest: (request: StarMapIndustryReadRequest) => void;
  onClose: () => void;
  onNativeRoleChange?: NativePlanetRoleAction;
  onNativeStationPriorityChange?: NativeStationPriorityAction;
  onNativeStationMinimumLoadChange?: NativeStationMinimumLoadAction;
  onNativeStationRoutePolicyChange?: NativeStationRoutePolicyAction;
  onNativeStationWarperBudgetChange?: NativeStationWarperBudgetAction;
  onNativeStationLimitsChange?: NativeStationLimitsAction;
  onFocusStation: (entityId: string, planetId: PlanetId) => void;
  onNativeQuantumItemCapacityChange?: NativeQuantumItemCapacityAction;
  onOpenSystemSpaceStation?: (systemId: StarSystemId) => void;
  nativeCommandPending?: boolean;
  onNativeExplore?: (revision: number, systemId: StarSystemId) => boolean;
  onNativeColonize?: (revision: number, planetId: PlanetId) => boolean;
  onNativeTravel?: (planetId: PlanetId) => boolean;
  onNativePlanetMetadataChange?: (revision: number, planetId: PlanetId, metadata: { customName: string; note: string; tags: string[] }) => boolean;
  onNativeSystemNameChange?: (revision: number, systemId: StarSystemId, name: string) => boolean;
  onNativeUpgradeStations?: (revision: number, systemId: StarSystemId | null) => boolean;
  onNativeAttachQuantumStations?: (revision: number, systemId: StarSystemId | null) => boolean;
  onNativeCollectorQuantumMode?: (revision: number, systemId: StarSystemId | null, enabled: boolean) => boolean;
}) {
  const [view, setView] = useState<"map" | "industry" | "quantum">("map");
  const [mapQuery, setMapQuery] = useState("");
  if (!open) return null;

  const activeSystemId = mapCatalogFrame?.activeSystemId ?? readModel?.activeSystemId ?? null;
  const activeSystemLabel = activeSystemId
    ? mapCatalogFrame?.systemRowsById.get(activeSystemId)?.displayName ??
      readModel?.systemRowsById.get(activeSystemId)?.displayName ??
      "--"
    : "--";
  const unlockedCount = mapCatalogFrame?.summary.unlockedSystemCount ?? readModel?.summary.unlockedSystemCount ?? null;
  const totalSystemCount = mapCatalogFrame?.summary.systemCount ?? readModel?.summary.systemCount ?? null;
  const farthestBeaconDistance = mapCatalogFrame
    ? Math.max(0, ...mapCatalogFrame.systems.filter((system) => system.discovered).map((system) => system.distanceFromOriginLy))
    : readModel
      ? Math.max(0, ...readModel.systems.filter((system) => system.unlocked).map((system) => system.distanceFromOriginLy))
      : null;
  const galaxySeed = mapCatalogFrame?.galaxySeed ?? readModel?.galaxySeed ?? null;

  return <WorkspaceFrame className={`star-map-workspace star-map-workspace--${view}`} ariaLabel="星图" onRequestClose={onClose}>
    <header className="star-map-header">
      <div className="star-map-title">
        <i><Telescope size={20} /></i>
        <div><span>恒星级导航阵列</span><strong>{view === "map" ? "星图与行星探索" : view === "industry" ? "星际工业调度" : "量子空间库存"}</strong></div>
      </div>
      <div className="star-map-headline">
        <span>已勘探 <strong>{unlockedCount === null ? "--" : unlockedCount}/{totalSystemCount === null ? "--" : totalSystemCount}</strong></span>
        <span>当前坐标 <strong>{activeSystemLabel}</strong></span>
        <span>最远航标 <strong>{farthestBeaconDistance === null ? "--" : `${farthestBeaconDistance.toFixed(1)} ly`}</strong></span>
        <span>星区种子 <strong>#{galaxySeed ?? "--"}</strong></span>
      </div>
      <button className="star-map-close" type="button" onClick={onClose} title="关闭星图" aria-label="关闭星图"><X size={18} /></button>
    </header>

    <nav className="star-map-tabs" role="tablist" aria-label="星图视图">
      <button type="button" role="tab" aria-selected={view === "map"} className={view === "map" ? "active" : ""} onClick={() => setView("map")}><Telescope size={14} />星图探索</button>
      <button type="button" role="tab" aria-selected={view === "industry"} className={view === "industry" ? "active" : ""} onClick={() => setView("industry")}><Factory size={14} />星际工业</button>
      <button type="button" role="tab" aria-selected={view === "quantum"} className={view === "quantum" ? "active" : ""} onClick={() => setView("quantum")}><Atom size={14} />量子库存</button>
    </nav>

    {view === "map" ? <NativeStarMapCatalogConsole frame={mapCatalogFrame} status={mapCatalogStatus} query={mapQuery} onQueryChange={setMapQuery} onOpenSystemSpaceStation={onOpenSystemSpaceStation} pending={nativeCommandPending} onExplore={onNativeExplore} onColonize={onNativeColonize} onTravel={onNativeTravel} onPlanetMetadataChange={onNativePlanetMetadataChange} onSystemNameChange={onNativeSystemNameChange} onUpgradeStations={onNativeUpgradeStations} onAttachQuantumStations={onNativeAttachQuantumStations} onCollectorQuantumMode={onNativeCollectorQuantumMode} />
      : view === "industry" ? <NativeIndustryConsole readModel={readModel} status={readStatus} selector={industryReadRequest} onSelectorChange={onIndustryReadRequest} onNativeRoleChange={onNativeRoleChange} onNativeStationPriorityChange={onNativeStationPriorityChange} onNativeStationMinimumLoadChange={onNativeStationMinimumLoadChange} onNativeStationRoutePolicyChange={onNativeStationRoutePolicyChange} onNativeStationWarperBudgetChange={onNativeStationWarperBudgetChange} onNativeStationLimitsChange={onNativeStationLimitsChange} onFocusStation={onFocusStation} />
        : <NativeQuantumInventoryConsole readModel={quantumReadModel} status={quantumReadStatus} onNativeItemCapacityChange={onNativeQuantumItemCapacityChange} />}
  </WorkspaceFrame>;
}

export function StarMapWorkspace({
  open,
  game,
  nativeMapCatalogFrame,
  nativeMapCatalogStatus = "ready",
  nativeReadModel,
  nativeReadStatus = "ready",
  nativeQuantumReadModel,
  nativeQuantumReadStatus = "ready",
  nativeAuthorityRequired = false,
  industryReadRequest,
  onIndustryReadRequest,
  onClose,
  onExplore,
  onColonize,
  onTravel,
  onNativeRoleChange,
  onRoleChange,
  onPlanetMetadataChange,
  onSystemNameChange,
  onStationPriorityChange,
  onStationMinimumLoadChange,
  onStationLimitsChange,
  onNativeStationPriorityChange,
  onNativeStationMinimumLoadChange,
  onNativeStationRoutePolicyChange,
  onNativeStationWarperBudgetChange,
  onNativeStationLimitsChange,
  onFocusStation,
  onUpgradeAllStations,
  onAttachAllQuantumStations,
  onCollectorQuantumModeChange,
  onQuantumItemCapacityChange,
  onResetPlanetFactory,
  onNativeQuantumItemCapacityChange,
  onOpenSystemSpaceStation,
  mobile = false,
  mobileSubview,
  onMobileOpenDetail,
}: {
  open: boolean;
  game: GameState;
  nativeMapCatalogFrame?: NativeStarMapCatalogFrame | null;
  nativeMapCatalogStatus?: StarMapNativeReadStatus;
  nativeReadModel?: NativeStarMapWorkspaceReadModel | null;
  nativeReadStatus?: StarMapNativeReadStatus;
  nativeQuantumReadModel?: NativeStellarQuantumReadModel | null;
  nativeQuantumReadStatus?: StarMapNativeReadStatus;
  nativeAuthorityRequired?: boolean;
  industryReadRequest: StarMapIndustryReadRequest;
  onIndustryReadRequest: (request: StarMapIndustryReadRequest) => void;
  onClose: () => void;
  onExplore: (systemId: StarSystemId) => void;
  onColonize: (planetId: PlanetId) => void;
  onTravel: (planetId: PlanetId) => boolean;
  onNativeRoleChange?: NativePlanetRoleAction;
  onRoleChange: (planetId: PlanetId, role: PlanetIndustryRole) => void;
  onPlanetMetadataChange: (planetId: PlanetId, metadata: { customName: string; note: string; tags: string[] }) => void;
  onSystemNameChange: (systemId: StarSystemId, customName: string) => void;
  onStationPriorityChange: (entityId: string, slotIndex: number, priority: LogisticsPriority) => void;
  onStationMinimumLoadChange: (entityId: string, slotIndex: number, minimumLoad: StationMinimumLoad) => void;
  onStationLimitsChange: (entityId: string, slotIndex: number, minStock: number, maxStock: number) => void;
  onNativeStationPriorityChange?: NativeStationPriorityAction;
  onNativeStationMinimumLoadChange?: NativeStationMinimumLoadAction;
  onNativeStationRoutePolicyChange?: NativeStationRoutePolicyAction;
  onNativeStationWarperBudgetChange?: NativeStationWarperBudgetAction;
  onNativeStationLimitsChange?: NativeStationLimitsAction;
  onFocusStation: (entityId: string, planetId: PlanetId) => void;
  onUpgradeAllStations: StarMapBatchAction;
  onAttachAllQuantumStations: StarMapBatchAction;
  onCollectorQuantumModeChange: StarMapCollectorBatchAction;
  onQuantumItemCapacityChange: (itemId: ItemId, value: string) => void;
  onResetPlanetFactory: (planetId: PlanetId) => boolean;
  onNativeQuantumItemCapacityChange?: NativeQuantumItemCapacityAction;
  onOpenSystemSpaceStation?: (systemId: StarSystemId) => void;
  mobile?: boolean;
  mobileSubview?: string | null;
  onMobileOpenDetail?: (subview: string) => void;
}) {
  const { isEnglish } = useAppLocale();
  const [view, setView] = useState<"map" | "industry" | "quantum">("map");
  const [mapQuery, setMapQuery] = useState("");
  const [batchBusy, setBatchBusy] = useState<"upgrade" | "quantum" | "collectors" | null>(null);
  const [batchReport, setBatchReport] = useState<StarMapBatchActionResult | null>(null);
  const [resetPlanetId, setResetPlanetId] = useState<PlanetId | null>(null);
  const normalizedMapQuery = mapQuery.trim().toLocaleLowerCase("zh-CN");
  const nativeSystemRows = nativeReadModel?.systemRowsById ?? null;
  const nativePlanetRows = nativeReadModel?.planetRowsById ?? null;
  const nativeStationRows = nativeReadModel?.stations ?? null;
  const visibleSystems = useMemo(() => STAR_SYSTEM_LIST.filter((system) => {
    if (nativeAuthorityRequired && !nativeSystemRows?.has(system.id)) return false;
    if (!normalizedMapQuery) return true;
    const nativeSystemName = nativeSystemRows?.get(system.id)?.displayName ?? "";
    const systemText = `${system.name} ${system.code} ${system.description} ${nativeSystemName} ${nativeAuthorityRequired ? "" : getStarSystemDisplayName(game, system.id)}`.toLocaleLowerCase("zh-CN");
    return systemText.includes(normalizedMapQuery) || system.planetIds.some((planetId) => nativeAuthorityRequired
      ? (nativePlanetRows?.get(planetId)?.displayName ?? "").toLocaleLowerCase("zh-CN").includes(normalizedMapQuery)
      : getPlanetSearchText(game, planetId).includes(normalizedMapQuery));
  }), [game, nativeAuthorityRequired, nativePlanetRows, nativeSystemRows, normalizedMapQuery]);
  if (!open) return null;
  const projectedActiveSystemId = nativeMapCatalogFrame?.activeSystemId ?? nativeReadModel?.activeSystemId ?? null;
  const nativeActiveSystemId = projectedActiveSystemId && (nativeMapCatalogFrame?.systemRowsById.has(projectedActiveSystemId) ||
      STAR_SYSTEM_LIST.some((system) => system.id === projectedActiveSystemId))
    ? projectedActiveSystemId as StarSystemId
    : null;
  const activeSystemId = nativeActiveSystemId ?? (nativeAuthorityRequired ? null : getPlanet(game.activePlanetId).systemId);
  const unlockedCount = nativeAuthorityRequired
    ? nativeMapCatalogFrame?.summary.unlockedSystemCount ?? nativeReadModel?.summary.unlockedSystemCount ?? null
    : STAR_SYSTEM_LIST.filter((system) => isStarSystemUnlocked(game, system.id)).length;
  const totalSystemCount = nativeAuthorityRequired
    ? nativeMapCatalogFrame?.summary.systemCount ?? nativeReadModel?.summary.systemCount ?? null
    : STAR_SYSTEM_LIST.length;
  const pendingUpgradeCount = nativeAuthorityRequired
    ? nativeReadModel?.systems.reduce((sum, system) => sum + system.legacyStationCount, 0) ?? 0
    : nativeStationRows
    ? nativeStationRows.filter((station) => station.buildingId === "interstellar_logistics_station" && station.stationTier < 2).length
    : game.entities.filter((entity) => entity.buildingId === "interstellar_logistics_station" && (entity.stationTier ?? 1) < 2).length;
  const pendingQuantumCount = nativeAuthorityRequired
    ? nativeReadModel?.systems.reduce((sum, system) => sum + system.quantumAttachableCount, 0) ?? 0
    : nativeStationRows
    ? nativeStationRows.filter((station) => station.buildingId === "interstellar_logistics_station" && station.stationTier >= 2 && station.quantumMode !== "quantum" && !station.quantumTransitionActive).length
    : game.entities.filter((entity) => entity.buildingId === "interstellar_logistics_station" && (entity.stationTier ?? 1) >= 2 && entity.quantumMode !== "quantum" && !entity.quantumTransition).length;
  const pendingCollectorCount = nativeAuthorityRequired
    ? nativeReadModel?.systems.reduce((sum, system) => sum + system.orbitalCollectorCount, 0) ?? 0
    : isTechnologyCompleted(game, "quantum_logistics_network")
    ? nativeStationRows
      ? nativeStationRows.filter((station) => station.buildingId === "orbital_collector" && (station.quantumMode ?? "legacy") === "legacy" && !station.quantumTransitionActive).length
      : game.entities.filter((entity) => entity.buildingId === "orbital_collector" && !entity.interactionLocked && (entity.quantumMode ?? "legacy") === "legacy" && !entity.quantumTransition).length
    : 0;
  const pendingSystemUpgradeCount = (systemId: StarSystemId): number => nativeAuthorityRequired
    ? nativeSystemRows?.get(systemId)?.legacyStationCount ?? 0
    : nativeStationRows
    ? nativeStationRows.filter((station) => station.systemId === systemId &&
      station.buildingId === "interstellar_logistics_station" && station.stationTier < 2).length
    : game.entities.filter((entity) => entity.buildingId === "interstellar_logistics_station" &&
      getPlanet(entity.planetId).systemId === systemId && (entity.stationTier ?? 1) < 2).length;
  const pendingSystemQuantumCount = (systemId: StarSystemId): number => nativeAuthorityRequired
    ? nativeSystemRows?.get(systemId)?.quantumAttachableCount ?? 0
    : nativeStationRows
    ? nativeStationRows.filter((station) => station.systemId === systemId &&
      station.buildingId === "interstellar_logistics_station" && station.stationTier >= 2 &&
      station.quantumMode !== "quantum" && !station.quantumTransitionActive).length
    : game.entities.filter((entity) => entity.buildingId === "interstellar_logistics_station" &&
      getPlanet(entity.planetId).systemId === systemId && (entity.stationTier ?? 1) >= 2 &&
      entity.quantumMode !== "quantum" && !entity.quantumTransition).length;
  const runBatchAction = async (
    kind: "upgrade" | "quantum" | "collectors",
    action: () => Promise<StarMapBatchActionResult | null>,
  ) => {
    if (batchBusy) return;
    setBatchBusy(kind);
    try {
      const report = await action();
      if (report) setBatchReport(report);
    } finally {
      setBatchBusy(null);
    }
  };
  const bulkActions = <div className={`star-map-batch-actions${mobile ? " star-map-batch-actions--mobile" : ""}`} role="group" aria-label="星图批量物流操作">
    <button type="button" disabled={batchBusy !== null || pendingUpgradeCount === 0} onClick={() => void runBatchAction("upgrade", () => onUpgradeAllStations())}><Sparkles size={14} /><span>升级全部星际物流站{pendingUpgradeCount > 0 ? `（${pendingUpgradeCount}）` : ""}</span></button>
    <button className="star-map-batch-actions__quantum" type="button" disabled={batchBusy !== null || pendingQuantumCount === 0} onClick={() => void runBatchAction("quantum", () => onAttachAllQuantumStations())}><Atom size={14} /><span>一键切换全部量子物流站{pendingQuantumCount > 0 ? `（${pendingQuantumCount}）` : ""}</span></button>
    <button className="star-map-batch-actions__collectors" type="button" disabled={batchBusy !== null || pendingCollectorCount === 0} onClick={() => void runBatchAction("collectors", () => onCollectorQuantumModeChange(true))}><ArrowUpFromLine size={14} /><span>量子网络一键接入所有轨道收集器{pendingCollectorCount > 0 ? `（${pendingCollectorCount}）` : ""}</span></button>
    {batchReport ? <div className="star-map-batch-report" role="status" aria-live="polite"><strong>{batchReport.scopeLabel} · {batchReport.actionLabel}</strong><span>成功 {batchReport.successCount} · 跳过 {batchReport.skippedCount}</span>{batchReport.skipReasons.length > 0 ? <small>跳过原因：{batchReport.skipReasons.join("；")}</small> : <small>全部符合条件的目标均已提交</small>}<button type="button" onClick={() => setBatchReport(null)} aria-label="关闭批量操作结果"><X size={12} /></button></div> : null}
  </div>;
  const resetDialog = <PlanetFactoryResetDialog
    game={game}
    planetId={resetPlanetId}
    onCancel={() => setResetPlanetId(null)}
    onConfirm={onResetPlanetFactory}
  />;
  const nativeMapCatalogConsole = <NativeStarMapCatalogConsole frame={nativeMapCatalogFrame ?? null} status={nativeMapCatalogStatus} query={mapQuery} onQueryChange={setMapQuery} onOpenSystemSpaceStation={onOpenSystemSpaceStation} />;
  const nativeQuantumConsole = <NativeQuantumInventoryConsole readModel={nativeQuantumReadModel ?? null} status={nativeQuantumReadStatus} onNativeItemCapacityChange={onNativeQuantumItemCapacityChange} />;
  const industryConsole = nativeAuthorityRequired
    ? <NativeIndustryConsole readModel={nativeReadModel ?? null} status={nativeReadStatus} selector={industryReadRequest} onSelectorChange={onIndustryReadRequest} onNativeRoleChange={onNativeRoleChange} onNativeStationPriorityChange={onNativeStationPriorityChange} onNativeStationMinimumLoadChange={onNativeStationMinimumLoadChange} onNativeStationRoutePolicyChange={onNativeStationRoutePolicyChange} onNativeStationWarperBudgetChange={onNativeStationWarperBudgetChange} onNativeStationLimitsChange={onNativeStationLimitsChange} onFocusStation={onFocusStation} />
    : <IndustryConsole game={game} onTravel={onTravel} onRoleChange={onRoleChange} onStationPriorityChange={onStationPriorityChange} onStationMinimumLoadChange={onStationMinimumLoadChange} onStationLimitsChange={onStationLimitsChange} onFocusStation={onFocusStation} />;

  if (mobile && nativeAuthorityRequired) {
    return <WorkspaceFrame className={`star-map-workspace star-map-workspace--${view} mobile-workspace mobile-star-map${mobileSubview ? " mobile-workspace--detail" : ""}`} ariaLabel="星图" onRequestClose={onClose}>
      {!mobileSubview ? <nav className="star-map-tabs mobile-workspace-sticky" role="tablist" aria-label="星图视图"><button type="button" role="tab" aria-selected={view === "map"} className={view === "map" ? "active" : ""} onClick={() => setView("map")}><Telescope size={14} />星图探索</button><button type="button" role="tab" aria-selected={view === "industry"} className={view === "industry" ? "active" : ""} onClick={() => setView("industry")}><Factory size={14} />星际工业</button><button type="button" role="tab" aria-selected={view === "quantum"} className={view === "quantum" ? "active" : ""} onClick={() => setView("quantum")}><Atom size={14} />量子库存</button></nav> : null}
      <div className="mobile-workspace-scroll">{mobileSubview || view === "map"
        ? nativeMapCatalogConsole
        : view === "industry"
          ? industryConsole
          : nativeQuantumConsole}</div>
    </WorkspaceFrame>;
  }

  if (mobile) {
    const detailSystemId = mobileSubview?.startsWith("system:") ? mobileSubview.slice(7) as StarSystemId : null;
    const detailPlanetId = mobileSubview?.startsWith("planet:") ? mobileSubview.slice(7) as PlanetId : null;
    const detailPlanet = detailPlanetId ? getPlanet(detailPlanetId) : null;
    const systemForPlanet = detailPlanet ? getStarSystem(detailPlanet.systemId) : null;
    const detailSystem = detailSystemId ? getStarSystem(detailSystemId) : systemForPlanet;
    const systemProfile = detailSystem ? getStarSystemProfile(game, detailSystem.id) : null;
    const planetProfile = detailPlanet ? getPlanetIndustrialProfile(game, detailPlanet.id) : null;
    const colonized = detailPlanet
      ? nativePlanetRows?.get(detailPlanet.id)?.colonized ?? (nativeAuthorityRequired ? false : isPlanetColonized(game, detailPlanet.id))
      : false;
    const colonyRequirements = detailPlanet ? getColonizationRequirements(game, detailPlanet.id) : null;
    return <><WorkspaceFrame className={`star-map-workspace star-map-workspace--${view} mobile-workspace mobile-star-map${mobileSubview ? " mobile-workspace--detail" : ""}`} ariaLabel="星图" onRequestClose={onClose}>
      {!mobileSubview ? <><nav className="star-map-tabs mobile-workspace-sticky" role="tablist" aria-label="星图视图"><button type="button" role="tab" aria-selected={view === "map"} className={view === "map" ? "active" : ""} onClick={() => setView("map")}><Telescope size={14} />星图探索</button><button type="button" role="tab" aria-selected={view === "industry"} className={view === "industry" ? "active" : ""} onClick={() => setView("industry")}><Factory size={14} />星际工业</button><button type="button" role="tab" aria-selected={view === "quantum"} className={view === "quantum" ? "active" : ""} onClick={() => setView("quantum")}><Atom size={14} />量子库存</button></nav>{view === "industry" ? <div className="mobile-workspace-scroll"><IndustryConsole game={game} onTravel={onTravel} onRoleChange={onRoleChange} onStationPriorityChange={onStationPriorityChange} onStationMinimumLoadChange={onStationMinimumLoadChange} onStationLimitsChange={onStationLimitsChange} onFocusStation={onFocusStation} /></div> : view === "quantum" ? <div className="mobile-workspace-scroll"><QuantumInventoryConsole game={game} onCollectorModeChange={onCollectorQuantumModeChange} onItemCapacityChange={onQuantumItemCapacityChange} /></div> : <div className="mobile-workspace-scroll mobile-star-system-list"><header><span>已勘探 {unlockedCount}/{STAR_SYSTEM_LIST.length}</span><strong>星区种子 #{game.galaxy.seed}</strong></header><label className="star-map-search"><Search size={15} /><StableTextInput draftId="star-map-search" value={mapQuery} onValueChange={setMapQuery} placeholder="搜索名称、备注或标签" aria-label="搜索星球资料" />{mapQuery ? <button type="button" onClick={() => setMapQuery("")} aria-label="清除星图搜索"><X size={14} /></button> : null}</label>{bulkActions}<StellarMetadataManager game={game} compact onPlanetMetadataChange={onPlanetMetadataChange} onSystemNameChange={onSystemNameChange} />{visibleSystems.map((system) => {
         const nativeSystem = nativeSystemRows?.get(system.id);
        const profile = getStarSystemProfile(game, system.id);
        const unlocked = nativeSystem?.unlocked ?? isStarSystemUnlocked(game, system.id);
        const mission = game.exploration.missions.find((candidate) => candidate.systemId === system.id);
        const missionActive = nativeSystem?.missionActive ?? Boolean(mission);
        const stationCount = pendingSystemUpgradeCount(system.id);
        const quantumCount = pendingSystemQuantumCount(system.id);
        return <div className="mobile-star-system-list__row" key={system.id}><button type="button" onClick={() => onMobileOpenDetail?.(`system:${system.id}`)}><i style={{ color: system.color }}><Sparkles size={21} /></i><span><small>{system.code} · {nativeSystem?.starTypeName ?? profile.starTypeName}</small><strong>{nativeSystem?.displayName ?? getStarSystemDisplayName(game, system.id)}</strong><em>{nativeSystem?.planetCount ?? system.planetIds.length} 颗行星 · {(nativeSystem?.luminosity ?? profile.luminosity).toFixed(2)} L☉ · {formatDistance(nativeSystem?.distanceFromOriginLy ?? profile.distanceFromOriginLy)}</em></span><b>{unlocked ? missionActive ? "勘探中" : "已发现" : "未勘探"}</b><ArrowRight size={18} /></button>{unlocked ? <button className="mobile-star-system-list__upgrade" type="button" onClick={() => onOpenSystemSpaceStation?.(system.id)}><Factory size={15} />管理本系空间站</button> : null}{stationCount > 0 ? <button className="mobile-star-system-list__upgrade" type="button" onClick={() => onUpgradeAllStations(system.id)}><Sparkles size={15} />升级本系物流站（{stationCount}）</button> : null}{quantumCount > 0 ? <button className="mobile-star-system-list__upgrade mobile-star-system-list__upgrade--quantum" type="button" onClick={() => onAttachAllQuantumStations(system.id)}><Sparkles size={15} />切换本系量子物流站（{quantumCount}）</button> : null}</div>;
      })}</div>}</> : detailPlanet && planetProfile && colonyRequirements ? <div className="mobile-workspace-scroll mobile-planet-detail">
        <header className="mobile-detail-heading"><i style={{ color: detailPlanet.color }}><Orbit size={22} /></i><span><small>{systemForPlanet ? getStarSystemDisplayName(game, systemForPlanet.id) : ""} · {detailPlanet.code}</small><strong>{getPlanetDisplayName(game, detailPlanet.id)}</strong></span><b>{colonized ? "已殖民" : "殖民候选"}</b></header>
        <StellarMetadataManager game={game} compact onPlanetMetadataChange={onPlanetMetadataChange} onSystemNameChange={onSystemNameChange} />
        <section className="mobile-planet-environment"><div><span>生态模板</span><strong>{planetProfile.climateName}</strong></div><div><span>海洋</span><strong>{OCEAN_LABELS[planetProfile.oceanType]}</strong></div><div><span>矿储倍率</span><strong>{Math.round(planetProfile.reserveScale * 100)}%</strong></div><div><span>采矿效率</span><strong>{Math.round(planetProfile.miningMultiplier * 100)}%</strong></div><div><span>风力</span><strong>{Math.round(planetProfile.windMultiplier * 100)}%</strong></div><div><span>太阳能</span><strong>{Math.round(getPlanetSolarPowerMultiplier(game, detailPlanet.id) * 100)}%</strong></div><div><span>地热</span><strong>{Math.round(planetProfile.geothermalMultiplier * 100)}%</strong></div><div><span>航程</span><strong>{Math.round(planetProfile.travelTimeMultiplier * 100)}%</strong></div></section>
        <section className="mobile-detail-section"><header>资源与工业定位</header><p>{detailPlanet.kind === "gas-giant" ? Object.keys(planetProfile.orbitalYields).map((id) => getItem(id as ItemId).name).join("、") : planetProfile.resourceIds.map((id) => getItem(id).name).join("、") || "无地表矿脉"}</p><div className="mobile-tech-unlocks"><span><Factory size={15} />{planetProfile.specializationName}</span><span><Gauge size={15} />推荐：{PLANET_INDUSTRY_ROLE_LABELS[getRecommendedPlanetRole(game, detailPlanet.id)]}</span>{planetProfile.tidalLocked ? <span><Timer size={15} />潮汐锁定</span> : null}</div></section>
        {!colonized ? <section className={`mobile-colony-requirements mobile-colony-requirements--${colonyRequirements.status}`}><header><strong>殖民前哨需求</strong><small>材料取自{getPlanetDisplayName(game, colonyRequirements.sourcePlanetId)}，运输载具取自随身载具栏</small></header><p>{colonyRequirements.reason}</p><div>{colonyRequirements.costs.map((cost) => <span className={cost.missing === 0 ? "ready" : "missing"} key={cost.itemId}><ItemGlyph itemId={cost.itemId} /><em>{getItem(cost.itemId).name}<small>{cost.source === "portable-fleet" ? "随身载具" : "当前行星托盘"}</small></em><strong>{cost.current.toLocaleString("zh-CN")}/{cost.required.toLocaleString("zh-CN")}</strong></span>)}</div></section> : null}
        <div className="mobile-detail-spacer" /><footer className="mobile-detail-actionbar">{colonized ? <button className="mobile-planet-reset-button" type="button" onClick={() => setResetPlanetId(detailPlanet.id)}><Trash2 size={17} />{isEnglish ? "Reset Planet Factory" : "重置星球工厂"}</button> : null}<button className="primary" type="button" disabled={!colonized && !canColonizePlanet(game, detailPlanet.id)} onClick={() => colonized ? onTravel(detailPlanet.id) : onColonize(detailPlanet.id)}>{colonized ? <Navigation size={18} /> : <Factory size={18} />}{colonized ? "进入行星工厂" : "建立殖民前哨"}</button></footer>
      </div> : detailSystem && systemProfile ? <div className="mobile-workspace-scroll mobile-star-system-detail">
        <header className="mobile-detail-heading"><i style={{ color: detailSystem.color }}><Sparkles size={22} /></i><span><small>{detailSystem.code} · {systemProfile.starTypeName}</small><strong>{getStarSystemDisplayName(game, detailSystem.id)}</strong></span><b>{systemProfile.luminosity.toFixed(2)} L☉</b></header><p className="mobile-detail-summary">{detailSystem.description}</p><div className="mobile-detail-system-actions"><button className="mobile-detail-system-upgrade" type="button" onClick={() => onOpenSystemSpaceStation?.(detailSystem.id)}><Factory size={16} />管理本系空间站</button>{pendingSystemUpgradeCount(detailSystem.id) > 0 ? <button className="mobile-detail-system-upgrade" type="button" onClick={() => onUpgradeAllStations(detailSystem.id)}><Sparkles size={16} />一键升级本系物流站</button> : null}{pendingSystemQuantumCount(detailSystem.id) > 0 ? <button className="mobile-detail-system-upgrade mobile-detail-system-upgrade--quantum" type="button" onClick={() => onAttachAllQuantumStations(detailSystem.id)}><Sparkles size={16} />一键切换本系量子物流站</button> : null}</div>
        <StellarMetadataManager game={game} compact onPlanetMetadataChange={onPlanetMetadataChange} onSystemNameChange={onSystemNameChange} />
        <section className="mobile-detail-section"><header>行星</header><div className="mobile-system-planets">{detailSystem.planetIds.map((planetId) => { const planet = getPlanet(planetId); const profile = getPlanetIndustrialProfile(game, planetId); const ready = isPlanetColonized(game, planetId); return <button type="button" key={planetId} onClick={() => onMobileOpenDetail?.(`planet:${planetId}`)}><i style={{ color: planet.color }}><Orbit size={20} /></i><span><strong>{getPlanetDisplayName(game, planetId)}</strong><small>{profile.climateName} · {OCEAN_LABELS[profile.oceanType]}</small></span><b>{ready ? "已殖民" : "查看需求"}</b><ArrowRight size={18} /></button>; })}</div></section>
        {!isStarSystemUnlocked(game, detailSystem.id) ? <section className="mobile-colony-requirements"><header><strong>恒星系勘探</strong><small>{formatDistance(systemProfile.distanceFromOriginLy)}</small></header><div>{detailSystem.explorationCost.map((cost) => <span className={(game.tray[cost.itemId] ?? 0) >= cost.amount ? "ready" : "missing"} key={cost.itemId}><ItemGlyph itemId={cost.itemId} /><em>{getItem(cost.itemId).name}</em><strong>{Math.floor(game.tray[cost.itemId] ?? 0)}/{cost.amount}</strong></span>)}</div><button type="button" disabled={!canExploreStarSystem(game, detailSystem.id)} onClick={() => onExplore(detailSystem.id)}><Telescope size={18} />开始勘探</button></section> : null}
      </div> : null}
    </WorkspaceFrame>{resetDialog}</>;
  }

  const activeSystemLabel = activeSystemId
    ? nativeAuthorityRequired
      ? nativeMapCatalogFrame?.systemRowsById.get(activeSystemId)?.displayName ?? nativeSystemRows?.get(activeSystemId)?.displayName ?? "--"
      : getStarSystemDisplayName(game, activeSystemId)
    : "--";
  const farthestBeaconDistance = nativeAuthorityRequired
    ? nativeMapCatalogFrame
      ? Math.max(0, ...nativeMapCatalogFrame.systems.filter((system) => system.discovered).map((system) => system.distanceFromOriginLy))
      : nativeReadModel
        ? Math.max(0, ...nativeReadModel.systems.filter((system) => system.unlocked).map((system) => system.distanceFromOriginLy))
      : null
    : Math.max(...STAR_SYSTEM_LIST.filter((system) => isStarSystemUnlocked(game, system.id)).map((system) => getStarSystemProfile(game, system.id).distanceFromOriginLy));
  return (
    <><WorkspaceFrame className={`star-map-workspace star-map-workspace--${view}`} ariaLabel="星图" onRequestClose={onClose}>
      <header className="star-map-header">
        <div className="star-map-title">
          <i><Telescope size={20} /></i>
          <div><span>恒星级导航阵列</span><strong>{view === "map" ? "星图与行星探索" : view === "industry" ? "星际工业调度" : "量子空间库存"}</strong></div>
        </div>
        <div className="star-map-headline">
          <span>已勘探 <strong>{unlockedCount === null ? "--" : unlockedCount}/{totalSystemCount === null ? "--" : totalSystemCount}</strong></span>
          <span>当前坐标 <strong>{activeSystemLabel}</strong></span>
          <span>最远航标 <strong>{farthestBeaconDistance === null ? "--" : `${farthestBeaconDistance.toFixed(1)} ly`}</strong></span>
          <span>星区种子 <strong>#{nativeAuthorityRequired ? nativeMapCatalogFrame?.galaxySeed ?? nativeReadModel?.galaxySeed ?? "--" : game.galaxy.seed}</strong></span>
        </div>
        <button className="star-map-close" type="button" onClick={onClose} title="关闭星图" aria-label="关闭星图"><X size={18} /></button>
      </header>

      <nav className="star-map-tabs" role="tablist" aria-label="星图视图">
        <button type="button" role="tab" aria-selected={view === "map"} className={view === "map" ? "active" : ""} onClick={() => setView("map")}><Telescope size={14} />星图探索</button>
        <button type="button" role="tab" aria-selected={view === "industry"} className={view === "industry" ? "active" : ""} onClick={() => setView("industry")}><Factory size={14} />星际工业</button>
        <button type="button" role="tab" aria-selected={view === "quantum"} className={view === "quantum" ? "active" : ""} onClick={() => setView("quantum")}><Atom size={14} />量子库存</button>
      </nav>

      {view === "map" && !nativeAuthorityRequired ? <div className="star-map-controls">
        <div className="star-map-controls__search"><label className="star-map-search"><Search size={15} /><StableTextInput draftId="star-map-search" value={mapQuery} onValueChange={setMapQuery} placeholder="搜索名称、备注或标签" aria-label="搜索星球资料" />{mapQuery ? <button type="button" onClick={() => setMapQuery("")} aria-label="清除星图搜索"><X size={14} /></button> : null}</label><small>{normalizedMapQuery ? `${visibleSystems.length} 个匹配星系` : "可按名称、备注或标签搜索"}</small></div>
        {bulkActions}
        <StellarMetadataManager game={game} onPlanetMetadataChange={onPlanetMetadataChange} onSystemNameChange={onSystemNameChange} />
      </div> : null}

      {view === "map" ? nativeAuthorityRequired ? nativeMapCatalogConsole : <div className="star-map-route" aria-label="恒星系航线">
        {visibleSystems.map((system, index) => {
          const nativeSystem = nativeSystemRows?.get(system.id);
          const systemProfile = getStarSystemProfile(game, system.id);
          const unlocked = nativeAuthorityRequired ? nativeSystem?.unlocked === true : isStarSystemUnlocked(game, system.id);
          const missionActive = nativeAuthorityRequired
            ? nativeSystem?.missionActive === true
            : game.exploration.missions.some((candidate) => candidate.systemId === system.id);
          const surveyProgress = nativeAuthorityRequired
            ? nativeSystem?.surveyProgress ?? 0
            : game.exploration.surveyProgressBySystem[system.id] ?? (unlocked ? 1 : 0);
          const active = activeSystemId === system.id;
          const technologyReady = !system.requiredTechId || isTechnologyCompleted(game, system.requiredTechId);
          const prerequisiteReady = !system.prerequisiteSystemId || isStarSystemUnlocked(game, system.prerequisiteSystemId);
          const suppliesReady = system.explorationCost.every((cost) => (game.tray[cost.itemId] ?? 0) >= cost.amount);
          const style = { "--system-color": system.color } as CSSProperties;
          return (
            <div className="star-map-route__segment" key={system.id}>
              {index > 0 ? <div className={`star-route-link${unlocked ? " star-route-link--open" : ""}`}><i /><ArrowRight size={16} /><span>{formatDistance(nativeSystem?.distanceFromOriginLy ?? systemProfile.distanceFromOriginLy)}</span></div> : null}
              <article className={`star-system-card${unlocked ? " star-system-card--unlocked" : " star-system-card--locked"}${active ? " star-system-card--active" : ""}`} style={style}>
                <header>
                  <i className="star-system-orb"><Sparkles size={20} /></i>
                  <div><span>{system.code}</span><strong>{nativeSystem?.displayName ?? getStarSystemDisplayName(game, system.id)}</strong><small>{nativeSystem?.starTypeName ?? systemProfile.starTypeName} · {(nativeSystem?.luminosity ?? systemProfile.luminosity).toFixed(2)} L☉ · {formatDistance(nativeSystem?.distanceFromOriginLy ?? systemProfile.distanceFromOriginLy)}</small></div>
                  <em>{active ? <><Navigation size={12} /> 当前</> : unlocked ? <><Check size={12} /> 已发现{missionActive ? " · 勘探中" : ""}</> : <><LockKeyhole size={12} /> 未勘探</>}</em>
                </header>
                <div className="star-system-space-station-actions">{unlocked ? <button className="star-system-space-station-upgrade" type="button" onClick={() => onOpenSystemSpaceStation?.(system.id)}><Factory size={14} />管理本系空间站</button> : null}{pendingSystemUpgradeCount(system.id) > 0 ? <button className="star-system-space-station-upgrade" type="button" onClick={() => onUpgradeAllStations(system.id)}><Sparkles size={14} />一键升级本系物流站</button> : null}{pendingSystemQuantumCount(system.id) > 0 ? <button className="star-system-space-station-upgrade star-system-space-station-upgrade--quantum" type="button" onClick={() => onAttachAllQuantumStations(system.id)}><Sparkles size={14} />一键切换本系量子物流站</button> : null}</div>
                <p>{system.description}</p>
                <div className="star-planet-list">
                  {system.planetIds.map((planetId) => {
                    const planet = getPlanet(planetId);
                    const localizedPlanetName = getLocalizedPlanetDisplayName(game, planet.id, isEnglish);
                    const profile = getPlanetIndustrialProfile(game, planet.id);
                    const recommendedRole = getRecommendedPlanetRole(game, planet.id);
                    const nativePlanet = nativePlanetRows?.get(planetId);
                    const current = nativeAuthorityRequired
                      ? nativeReadModel?.activePlanetId === planetId
                      : game.activePlanetId === planetId;
                    const deviceCount = nativeAuthorityRequired
                      ? nativePlanet?.deviceCount ?? 0
                      : game.entities.reduce((sum, entity) => entity.planetId === planetId
                          ? sum + entity.machineCount + entity.minerCount
                          : sum, 0);
                    const resources = planet.kind === "gas-giant"
                      ? Object.keys(profile.orbitalYields).map((itemId) => getItem(itemId as ItemId).name)
                      : profile.resourceIds.map((itemId) => getItem(itemId).name);
                    const colonized = nativeAuthorityRequired
                      ? nativePlanet?.colonized === true
                      : isPlanetColonized(game, planet.id);
                    const colonyRequirements = getColonizationRequirements(game, planet.id);
                    return (
                      <div className="star-planet-entry" role="group" aria-label={isEnglish ? `${localizedPlanetName} planet actions` : `${localizedPlanetName}行星操作`} key={planet.id}>
                      <button
                        type="button"
                         disabled={!unlocked || (!colonized && !canColonizePlanet(game, planet.id))}
                         className={`star-planet-entry__travel ${current ? "active" : ""}${colonized ? "" : " planet-uncolonized"}${colonyRequirements.status === "ready" ? " planet-colony-ready" : ""}`}
                         onClick={() => colonized ? onTravel(planet.id) : onColonize(planet.id)}
                         title={colonized ? `进入${getPlanetDisplayName(game, planet.id)}` : colonyRequirements.reason}
                      >
                        <i style={{ color: planet.color }}><Orbit size={17} /></i>
                        <span><strong>{getPlanetDisplayName(game, planet.id)}</strong><small>{profile.climateName} · {OCEAN_LABELS[profile.oceanType]}{profile.tidalLocked ? " · 潮汐锁定" : ""}</small></span>
                         <em>{colonized ? planet.kind === "gas-giant" ? "轨道" : `${deviceCount} 设备` : "未殖民"}</em>
                         <p>{resources.join("、") || "无地表矿脉"}{profile.rareResourceIds.length > 0 ? ` · 稀有 ${profile.rareResourceIds.map((itemId) => getItem(itemId).name).join("、")}` : ""}</p>
                         <small className="star-planet-profile">{game.galaxy.planetMetadata?.[planet.id]?.note || `${profile.specializationName} · 宜 ${PLANET_INDUSTRY_ROLE_LABELS[recommendedRole]}`}{game.galaxy.planetMetadata?.[planet.id]?.tags?.length ? ` · #${game.galaxy.planetMetadata[planet.id]!.tags.join(" #")}` : ""}</small>
                         <span className="star-planet-traits" aria-label={`${getPlanetDisplayName(game, planet.id)}工业环境`}>
                           <b title={planet.kind === "gas-giant" ? "轨道采集产率" : "有限矿脉总储量"}>{planet.kind === "gas-giant" ? "轨采" : "矿储"} <strong>{Math.round((planet.kind === "gas-giant" ? profile.orbitalYieldMultiplier : profile.reserveScale) * 100)}%</strong></b>
                           <b title="风力发电倍率">风 <strong>{Math.round(profile.windMultiplier * 100)}%</strong></b>
                           <b title={`太阳能综合倍率：行星 ${profile.solarMultiplier.toFixed(2)} × 恒星 ${systemProfile.luminosity.toFixed(2)}${profile.tidalLocked ? " × 潮汐锁定 1.25" : ""}`}>光 <strong>{Math.round(getPlanetSolarPowerMultiplier(game, planet.id) * 100)}%</strong></b>
                           <b title="地热发电倍率">地热 <strong>{Math.round(profile.geothermalMultiplier * 100)}%</strong></b>
                           <b title="跨行星航程时间倍率">航程 <strong>{Math.round(profile.travelTimeMultiplier * 100)}%</strong></b>
                         </span>
                         {!colonized ? <div className={`planet-colony-requirements planet-colony-requirements--${colonyRequirements.status}`}>
                           <header><strong>殖民前哨需求</strong><small>材料取自“{getPlanetDisplayName(game, colonyRequirements.sourcePlanetId)}”物资托盘；运输载具取自随身载具栏</small></header>
                           <p>{colonyRequirements.reason}</p>
                           {colonyRequirements.costs.length > 0 ? <div>{colonyRequirements.costs.map((cost) => <span className={cost.missing === 0 ? "ready" : "missing"} key={cost.itemId}>
                             <ItemHoverCard itemId={cost.itemId}><ItemGlyph itemId={cost.itemId} /></ItemHoverCard><b>{getItem(cost.itemId).name}<small>{cost.source === "portable-fleet" ? "随身载具" : "当前行星托盘"}</small></b><strong>{cost.current.toLocaleString("zh-CN")}/{cost.required.toLocaleString("zh-CN")}</strong>
                           </span>)}</div> : null}
                          </div> : null}
                       </button>
                       {colonized ? <button className="star-planet-entry__reset" type="button" onClick={() => setResetPlanetId(planet.id)} title={isEnglish ? `Reset ${localizedPlanetName} factory` : `重置${localizedPlanetName}工厂`} aria-label={isEnglish ? "Reset this planet's factory" : "重置此星球工厂"}><Trash2 size={15} /><span>{isEnglish ? "Reset" : "重置"}</span></button> : null}
                       </div>
                    );
                  })}
                </div>
                 {!unlocked ? (
                  <footer className="star-exploration">
                    <div className="star-exploration-requirements">
                      {system.requiredTechId ? (
                        <span className={technologyReady ? "ready" : ""}>
                          {technologyReady ? <Check size={12} /> : <LockKeyhole size={12} />}{getTechnology(system.requiredTechId)?.name}
                        </span>
                      ) : null}
                      {system.prerequisiteSystemId ? (
                        <span className={prerequisiteReady ? "ready" : ""}>
                          {prerequisiteReady ? <Check size={12} /> : <LockKeyhole size={12} />}先勘探{getStarSystemDisplayName(game, system.prerequisiteSystemId)}
                        </span>
                      ) : null}
                    </div>
                    <div className="star-exploration-costs">
                      {system.explorationCost.map((cost) => {
                        const stock = Math.floor(game.tray[cost.itemId] ?? 0);
                        return (
                          <span className={stock >= cost.amount ? "ready" : ""} key={cost.itemId}>
                            <ItemHoverCard itemId={cost.itemId}><ItemGlyph itemId={cost.itemId} /></ItemHoverCard>
                            <b>{stock}/{cost.amount}</b>
                          </span>
                        );
                      })}
                    </div>
                        {missionActive ? <div className="star-survey-progress" role="progressbar" aria-label={`${nativeSystem?.displayName ?? getStarSystemDisplayName(game, system.id)}勘探进度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(surveyProgress * 100)}><i><b style={{ width: `${surveyProgress * 100}%` }} /></i><span>勘探中 {Math.round(surveyProgress * 100)}%</span></div> : <button type="button" disabled={!canExploreStarSystem(game, system.id)} onClick={() => onExplore(system.id)} title={`消耗当前行星托盘补给勘探${nativeSystem?.displayName ?? getStarSystemDisplayName(game, system.id)}`}>
                       <Telescope size={15} />开始勘探{getStarSystemDisplayName(game, system.id)}
                     </button>}
                    {!technologyReady ? <small>需要完成{getTechnology(system.requiredTechId)?.name}</small>
                      : !prerequisiteReady ? <small>尚未建立前置航标</small>
                        : !suppliesReady ? <small>当前行星托盘补给不足</small>
                          : null}
                  </footer>
                 ) : missionActive ? (
                   <footer className="star-system-ready star-system-surveying"><Telescope size={13} /><div><span>永久航标在线 · 深度勘探 {Math.round(surveyProgress * 100)}%</span><i><b style={{ width: `${surveyProgress * 100}%` }} /></i></div></footer>
                 ) : (
                   <footer className="star-system-ready"><Check size={13} /><span>永久航标在线 · 未殖民行星需建立前哨</span></footer>
                )}
              </article>
            </div>
          );
        })}
      </div> : view === "industry" ? <IndustryConsole game={game} onTravel={onTravel} onRoleChange={onRoleChange} onStationPriorityChange={onStationPriorityChange} onStationMinimumLoadChange={onStationMinimumLoadChange} onStationLimitsChange={onStationLimitsChange} onFocusStation={onFocusStation} /> : <QuantumInventoryConsole game={game} onCollectorModeChange={onCollectorQuantumModeChange} onItemCapacityChange={onQuantumItemCapacityChange} />}
    </WorkspaceFrame>{resetDialog}</>
  );
}
