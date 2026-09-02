import {
  Check,
  ClipboardList,
  Coins,
  Cloud,
  Eye,
  EyeOff,
  Link2,
  LockKeyhole,
  PackageOpen,
  Pencil,
  RadioTower,
  Rocket,
  Satellite,
  ShoppingBag,
  Sparkles,
  Trophy,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ITEMS, getPlanet } from "../game/content";
import {
  deliverOrbitalQuantumInventory,
  deliverOrbitalStationFleet,
  getOrbitalStationActiveStage,
  orbitalStationStatusLabel,
  previewOrbitalQuantumDelivery,
  setOrbitalStationFeaturedAchievements,
  setOrbitalStationProfile,
  setOrbitalStationViewport,
  startOrbitalStationConstruction,
} from "../game/orbitalStation";
import type { OrbitalStationDeliveryTarget } from "../game/orbitalStation";
import {
  abandonStationContract,
  acceptStationContract,
  claimStationContract,
  getStationContractCompletionBasisPoints,
  setFeaturedStationContract,
  synchronizeStationContracts,
} from "../game/stationContracts";
import {
  STATION_DECORATIONS,
  STATION_THEMES,
  getStationDecoration,
  getStationLevel,
  placeStationDecoration,
  purchaseStationDecoration,
  purchaseStationTheme,
  removeStationDecoration,
  setStationTheme,
  updateStationDecoration,
} from "../game/stationDecorations";
import { reconcileOrbitalCargoTerminalBindings, setOrbitalCargoTerminalBinding } from "../game/stationCargoTerminal";
import {
  fetchCloudStationProfile,
  hasCloudAuthentication,
  publishCloudStation,
  setCloudStationVisibility,
  type CloudStationProfile,
} from "../game/cloud";
import { formatQuantityCompact, formatQuantityExact } from "../game/quantityFormat";
import { ACHIEVEMENTS } from "../game/progression";
import type { GameState, ItemId, PublicStationMetricKey, StationDecorationRotation } from "../game/types";
import { ItemGlyph } from "./ItemReference";
import { QuantityValue } from "./QuantityValue";
import { StableTextInput } from "./CompositionSafeInput";
import { StationCanvasRenderer } from "./StationCanvasRenderer";
import { WorkspaceFrame } from "./WorkspaceFrame";
import { useGameDialog } from "./GameDialogProvider";

export type StationTab = "overview" | "construction" | "contracts" | "decorations" | "profile";

const STATION_METRIC_OPTIONS: Array<{ id: PublicStationMetricKey; label: string }> = [
  { id: "total-generation", label: "累计发电" },
  { id: "peak-throughput", label: "实际吞吐峰值" },
  { id: "dyson-power", label: "戴森功率" },
  { id: "explored-systems", label: "探索星系" },
  { id: "colonized-planets", label: "殖民行星" },
  { id: "universe-matrix-produced", label: "宇宙矩阵" },
  { id: "solar-sails-launched", label: "太阳帆发射" },
  { id: "carrier-rockets-launched", label: "运载火箭发射" },
];

export interface OrbitalStationWorkspaceProps {
  game: GameState;
  onGameChange: (updater: (state: GameState) => GameState) => void;
  onClose: () => void;
  mobile?: boolean;
  mobileSubview?: string;
  initialTab?: StationTab;
  onOpenMobileSubview?: (subview: string) => void;
  onMobileBack?: () => void;
}

function statusRank(status: GameState["orbitalStation"]["status"]): number {
  return ["locked", "eligible", "core-building", "dock-building", "showcase-building", "operational"].indexOf(status);
}

function stageLabel(stageId: "core" | "dock" | "showcase"): string {
  return stageId === "core" ? "轨道核心" : stageId === "dock" ? "物资出口港" : "展示舱段";
}

function requirementPercent(delivered: string | undefined, required: string): number {
  const target = BigInt(required);
  if (target <= 0n) return 100;
  const current = BigInt(delivered ?? "0");
  return Number((current > target ? target : current) * 100n / target);
}

function contractTarget(contractId: string): OrbitalStationDeliveryTarget {
  return { kind: "contract", contractId };
}

export function OrbitalStationWorkspace({ game, onGameChange, onClose, mobile = false, mobileSubview, initialTab, onOpenMobileSubview, onMobileBack }: OrbitalStationWorkspaceProps) {
  const station = game.orbitalStation;
  const [tab, setTab] = useState<StationTab>(initialTab ?? (statusRank(station.status) >= 3 ? "overview" : "construction"));
  const [selectedPlacementId, setSelectedPlacementId] = useState<string | null>(null);
  const [decorationEditing, setDecorationEditing] = useState(false);
  const [profileTitle, setProfileTitle] = useState(station.profile.title);
  const [profileMotto, setProfileMotto] = useState(station.profile.motto);
  const [cloudProfile, setCloudProfile] = useState<CloudStationProfile | null>(null);
  const [cloudProfileStatus, setCloudProfileStatus] = useState<"idle" | "loading" | "busy" | "ready" | "error">("idle");
  const [cloudProfileMessage, setCloudProfileMessage] = useState<string | null>(null);
  const level = getStationLevel(station.economy.stationReputation);
  const stage = getOrbitalStationActiveStage(station);
  const terminalEntities = game.entities.filter((entity) => entity.buildingId === "orbital_cargo_terminal");
  const canvasAvailable = statusRank(station.status) >= 3;
  const contractsAvailable = statusRank(station.status) >= 4;
  const decorationAvailable = station.status === "operational";
  const gameDialog = useGameDialog();

  const onGameChangeRef = useRef(onGameChange);
  onGameChangeRef.current = onGameChange;

  // This is an open-boundary reconciliation, not a subscription to the
  // callback identity. App intentionally supplies a lightweight inline
  // adapter; treating each new function object as a new station day creates a
  // commit -> render -> effect loop.
  useEffect(() => {
    onGameChangeRef.current((current) => {
      if (current.mode !== "normal") return current;
      const orbitalStation = synchronizeStationContracts(current, Date.now());
      return orbitalStation === current.orbitalStation
        ? reconcileOrbitalCargoTerminalBindings(current)
        : reconcileOrbitalCargoTerminalBindings({ ...current, orbitalStation });
    });
  }, []);

  useEffect(() => {
    setProfileTitle(station.profile.title);
    setProfileMotto(station.profile.motto);
  }, [station.profile.motto, station.profile.title]);

  useEffect(() => {
    if (!mobile) return;
    if (mobileSubview?.startsWith("decoration:")) {
      setTab("decorations");
      setSelectedPlacementId(mobileSubview.slice("decoration:".length));
    } else {
      setSelectedPlacementId(null);
    }
  }, [mobile, mobileSubview]);

  useEffect(() => {
    if (!decorationAvailable || !hasCloudAuthentication()) {
      setCloudProfile(null);
      setCloudProfileStatus("idle");
      return;
    }
    let cancelled = false;
    setCloudProfileStatus("loading");
    void fetchCloudStationProfile().then((profile) => {
      if (cancelled) return;
      setCloudProfile(profile);
      setCloudProfileStatus("ready");
    }).catch((error) => {
      if (cancelled) return;
      setCloudProfileStatus("error");
      setCloudProfileMessage(error instanceof Error ? error.message : "公开空间站状态读取失败");
    });
    return () => { cancelled = true; };
  }, [decorationAvailable]);

  const deliverQuantum = async (target: OrbitalStationDeliveryTarget, itemId: ItemId) => {
    const available = game.quantumLogisticsNetwork.inventory[itemId] ?? "0";
    const maximum = previewOrbitalQuantumDelivery(game, target, itemId, available);
    if (maximum.reason !== "delivered" || maximum.accepted === "0") return;
    const requested = await gameDialog.prompt(
      `输入本次从量子共享库存交付的${ITEMS[itemId].name}数量。可交付上限 ${formatQuantityExact(maximum.accepted)} 件。`,
      { title: "量子库存手动交付", defaultValue: maximum.accepted, placeholder: "严格正整数", confirmLabel: "预览交付" },
    );
    if (requested === null) return;
    const preview = previewOrbitalQuantumDelivery(game, target, itemId, requested);
    if (preview.reason !== "delivered" || preview.accepted === "0") {
      await gameDialog.alert(preview.reason === "invalid-amount" ? "请输入不带小数的严格正整数。" : "当前库存或目标状态已经变化，本次没有扣除任何物资。", { title: "无法交付" });
      return;
    }
    const confirmed = await gameDialog.confirm(`确认从量子共享库存交付${ITEMS[itemId].name} ${formatQuantityExact(preview.accepted)} 件？\n库存 ${formatQuantityExact(preview.inventory)} · 目标尚缺 ${formatQuantityExact(preview.remaining)}`, { title: "确认量子交付", confirmLabel: "确认交付" });
    if (!confirmed) return;
    onGameChange((current) => reconcileOrbitalCargoTerminalBindings(
      deliverOrbitalQuantumInventory(current, target, itemId, preview.accepted).state,
    ));
  };

  const placeDecoration = (decorationId: string) => {
    onGameChange((current) => {
      const definition = getStationDecoration(decorationId);
      if (!definition) return current;
      const currentLevel = getStationLevel(current.orbitalStation.economy.stationReputation);
      let nextStation = current.orbitalStation;
      const index = current.orbitalStation.layout.placements.length;
      for (let candidate = 0; candidate < 256 && nextStation === current.orbitalStation; candidate += 1) {
        const column = (index + candidate) % 10;
        const row = Math.floor((index + candidate) / 10) % 8;
        const x = Math.round(-currentLevel.halfWidth + 80 + column * Math.max(70, (currentLevel.halfWidth * 2 - 160) / 9));
        const y = Math.round(currentLevel.halfHeight - 70 - row * 80);
        nextStation = placeStationDecoration(current.orbitalStation, decorationId, { x, y, rotation: definition.rotations[0], layer: definition.layers[0], variant: 0 }, `station-decor-${current.nextId}-${candidate}`);
      }
      return nextStation === current.orbitalStation ? current : { ...current, nextId: current.nextId + 1, orbitalStation: nextStation };
    });
  };

  const selectedPlacement = station.layout.placements.find((placement) => placement.id === selectedPlacementId);
  const selectedDecoration = selectedPlacement ? getStationDecoration(selectedPlacement.decorationId) : undefined;
  const selectPlacement = (placementId: string | null) => {
    if (placementId) {
      setSelectedPlacementId(placementId);
      if (mobile && onOpenMobileSubview && mobileSubview !== `decoration:${placementId}`) {
        onOpenMobileSubview(`decoration:${placementId}`);
      }
      return;
    }
    if (selectedPlacementId && mobile && onMobileBack) onMobileBack();
    else setSelectedPlacementId(null);
  };
  const closeWorkspace = () => {
    if (selectedPlacementId) {
      selectPlacement(null);
      return;
    }
    onClose();
  };

  const stationProgress = useMemo(() => {
    if (!stage) return 100;
    const itemProgress = stage.costs.map((cost) => requirementPercent(stage.delivered[cost.itemId], cost.amount));
    const fleetProgress = Object.entries(stage.fleetCosts).map(([fleetId, amount]) => {
      const delivered = stage.deliveredFleet[fleetId as "logistics_vessel"] ?? 0;
      return amount ? Math.floor(delivered * 100 / amount) : 100;
    });
    const values = [...itemProgress, ...fleetProgress];
    return values.length ? Math.floor(values.reduce((sum, value) => sum + value, 0) / values.length) : 100;
  }, [stage]);

  const publishStation = async () => {
    setCloudProfileStatus("busy");
    setCloudProfileMessage(null);
    try {
      const profile = await publishCloudStation();
      setCloudProfile(profile);
      setCloudProfileStatus("ready");
      setCloudProfileMessage("已从当前普通主云存档重建脱敏公开快照");
    } catch (error) {
      setCloudProfileStatus("error");
      setCloudProfileMessage(error instanceof Error ? error.message : "空间站发布失败");
    }
  };

  const changeVisibility = async (visibility: "public" | "private") => {
    setCloudProfileStatus("busy");
    setCloudProfileMessage(null);
    try {
      const profile = await setCloudStationVisibility(visibility);
      setCloudProfile(profile);
      setCloudProfileStatus("ready");
      setCloudProfileMessage(visibility === "public" ? "空间站主页已恢复公开" : "空间站主页已隐藏；排行榜设置未改变");
    } catch (error) {
      setCloudProfileStatus("error");
      setCloudProfileMessage(error instanceof Error ? error.message : "空间站隐私设置失败");
    }
  };

  const copyPublicLink = async () => {
    if (!cloudProfile?.publicId) return;
    const link = `${window.location.origin}/station/${cloudProfile.publicId}`;
    try {
      await navigator.clipboard.writeText(link);
      setCloudProfileMessage("公开空间站链接已复制");
    } catch {
      setCloudProfileMessage(link);
    }
  };

  if (game.mode === "speedrun") return null;

  return <WorkspaceFrame className={`orbital-station-workspace${mobile ? " orbital-station-workspace--mobile" : ""}`} ariaLabel="全星系空间站" onRequestClose={closeWorkspace}>
    <header className="orbital-station-header">
      <div><i><Satellite size={22} /></i><span><small>跨恒星系唯一设施</small><strong>{station.profile.title}</strong></span></div>
      <dl>
        <div><dt>状态</dt><dd>{orbitalStationStatusLabel(station.status)}</dd></div>
        <div><dt>等级</dt><dd>Lv.{level.level} · {level.title}</dd></div>
        <div><dt>轨道徽记</dt><dd><Coins size={13} />{formatQuantityCompact(station.economy.orbitalMarks)}</dd></div>
        <div><dt>声望</dt><dd><Trophy size={13} />{formatQuantityCompact(station.economy.stationReputation)}</dd></div>
      </dl>
      <button type="button" onClick={closeWorkspace} aria-label={selectedPlacementId ? "返回空间站画布" : "返回工厂画布"}><X size={18} /></button>
    </header>

    <nav className="orbital-station-tabs" aria-label="空间站功能">
      <button className={tab === "overview" ? "active" : ""} type="button" disabled={!canvasAvailable} onClick={() => setTab("overview")}><Satellite size={16} />空间站画布</button>
      <button className={tab === "construction" ? "active" : ""} type="button" onClick={() => setTab("construction")}><PackageOpen size={16} />建设与货运</button>
      <button className={tab === "contracts" ? "active" : ""} type="button" disabled={!contractsAvailable} onClick={() => setTab("contracts")}><ClipboardList size={16} />出口合同</button>
      <button className={tab === "decorations" ? "active" : ""} type="button" disabled={!decorationAvailable} onClick={() => setTab("decorations")}><ShoppingBag size={16} />装饰收藏</button>
      <button className={tab === "profile" ? "active" : ""} type="button" disabled={!decorationAvailable} onClick={() => setTab("profile")}><RadioTower size={16} />档案与公开</button>
    </nav>

    <main className="orbital-station-main">
      {tab === "overview" && canvasAvailable ? <StationCanvasRenderer
        station={station}
        readOnly
        selectedPlacementId={selectedPlacementId}
        onSelectPlacement={selectPlacement}
        onViewportChange={(viewport) => onGameChange((current) => ({ ...current, orbitalStation: setOrbitalStationViewport(current.orbitalStation, viewport) }))}
      /> : null}

      {tab === "construction" ? <section className="orbital-station-panel station-construction-panel">
        {station.status === "locked" ? <div className="station-locked-intro"><LockKeyhole size={34} /><strong>首次生产宇宙矩阵后开放建设</strong><p>入口会始终保留；旧存档只获得建设资格，不会免费获得材料、空间站或轨道徽记。</p><span>累计宇宙矩阵：<QuantityValue value={game.totalProduced.universe_matrix ?? 0} /> / 1</span></div> : stage ? <>
          <header className="station-section-heading"><div><small>三阶段轨道施工</small><strong>{stageLabel(stage.stageId)}</strong></div><span>{stationProgress}%</span></header>
          {station.status === "eligible" ? <button className="station-primary-action" type="button" onClick={() => onGameChange((current) => ({ ...current, orbitalStation: startOrbitalStationConstruction(current.orbitalStation) }))}><Rocket size={17} />开始轨道核心施工</button> : null}
          <div className="station-requirement-list">
            {stage.costs.map((cost) => {
              const delivered = stage.delivered[cost.itemId] ?? "0";
              const done = BigInt(delivered) >= BigInt(cost.amount);
              return <article className={done ? "complete" : ""} key={cost.itemId}><ItemGlyph itemId={cost.itemId} /><div><strong>{ITEMS[cost.itemId].name}</strong><span><i style={{ width: `${requirementPercent(delivered, cost.amount)}%` }} /></span><small>{formatQuantityCompact(delivered)} / {formatQuantityCompact(cost.amount)}</small></div><button type="button" disabled={done || !game.quantumLogisticsNetwork.enabled || BigInt(game.quantumLogisticsNetwork.inventory[cost.itemId] ?? "0") < 1n} onClick={() => void deliverQuantum({ kind: "construction" }, cost.itemId)}>{done ? <Check size={14} /> : <Sparkles size={14} />}{done ? "已完成" : "量子交付"}</button></article>;
            })}
            {Object.entries(stage.fleetCosts).map(([fleetId, amount]) => {
              const delivered = stage.deliveredFleet[fleetId as "logistics_vessel"] ?? 0;
              return <article className={delivered >= amount ? "complete" : ""} key={fleetId}><Rocket size={18} /><div><strong>物流运输船</strong><span><i style={{ width: `${amount ? Math.min(100, delivered * 100 / amount) : 100}%` }} /></span><small>{delivered} / {amount} · 随身 {game.portableFleet.logistics_vessel}</small></div><button type="button" disabled={delivered >= amount || game.portableFleet.logistics_vessel < 1} onClick={() => onGameChange((current) => deliverOrbitalStationFleet(current, "logistics_vessel", amount - delivered))}>确认交付</button></article>;
            })}
          </div>
          <p className="station-quantum-note"><Sparkles size={14} />量子库存仅在你确认时扣除，不占用量子上传/下载带宽；货运终端会按模拟时间与真实供电上传。</p>
        </> : <div className="station-complete-card"><Check size={34} /><strong>三阶段施工全部完成</strong><p>合同、装饰和公开展示功能均已开放。</p></div>}

        {station.status !== "locked" ? <section className="station-terminal-management"><header><strong>行星轨道货运终端</strong><small>{terminalEntities.length} 座 · 每颗已殖民行星最多一座</small></header>{terminalEntities.length ? terminalEntities.map((entity) => {
          const bindingValue = entity.orbitalCargoBinding?.kind === "construction" ? "construction" : entity.orbitalCargoBinding?.kind === "contract" ? `contract:${entity.orbitalCargoBinding.contractId}` : "none";
          return <article key={entity.id}><div><Satellite size={17} /><span><strong>{getPlanet(entity.planetId).name}</strong><small>{entity.productionRate.toFixed(1)}/min · 累计 {formatQuantityCompact(entity.orbitalCargoTotalUploaded ?? "0")}</small></span></div><select value={bindingValue} onChange={(event) => {
            const value = event.target.value;
            onGameChange((current) => setOrbitalCargoTerminalBinding(current, entity.id, value === "construction" ? { kind: "construction" } : value.startsWith("contract:") ? { kind: "contract", contractId: value.slice("contract:".length) } : null));
          }}><option value="none">未绑定（保留缓存）</option>{stage ? <option value="construction">当前建设：{stageLabel(stage.stageId)}</option> : null}{station.contractBoard.accepted.map((contract) => <option value={`contract:${contract.id}`} key={contract.id}>{contract.title}</option>)}</select></article>;
        }) : <p>请先在已殖民行星的物流施工分类制造并放置“轨道货运终端”。</p>}</section> : null}
      </section> : null}

      {tab === "contracts" && contractsAvailable ? <section className="orbital-station-panel station-contract-panel">
        <header className="station-section-heading"><div><small>任务日 {station.contractBoard.taskDay}</small><strong>每日出口合同</strong></div><span>{station.contractBoard.accepted.length}/3 已接受</span></header>
        <div className="station-contract-grid">
          {station.contractBoard.offers.map((contract) => <article className={contract.special ? "special" : ""} key={contract.id}><header><span>{contract.special ? "特别合同" : contract.difficulty}</span><strong>{contract.title}</strong></header><p>{contract.summary}</p><ul>{contract.requirements.map((requirement, index) => <li key={`${requirement.itemId}:${index}`}><ItemGlyph itemId={requirement.itemId} /><span>{ITEMS[requirement.itemId].name}</span><strong>{formatQuantityCompact(requirement.amount)}</strong><small>{requirement.channel === "quantum" ? "仅量子" : requirement.sourcePlanetIds?.length ? `${requirement.sourcePlanetIds.map((id) => getPlanet(id).name).join("、")}终端 / 量子库存` : "任意渠道"}</small></li>)}</ul><footer><span><Coins size={13} />{formatQuantityCompact(BigInt(contract.rewards.baseMarks) + BigInt(contract.rewards.completionMarks))}</span><span><Trophy size={13} />{formatQuantityCompact(BigInt(contract.rewards.baseReputation) + BigInt(contract.rewards.completionReputation))}</span><button type="button" disabled={station.contractBoard.accepted.length >= 3} onClick={() => onGameChange((current) => ({ ...current, orbitalStation: acceptStationContract(current.orbitalStation, contract.id) }))}>接受合同</button></footer></article>)}
        </div>
        <section className="station-accepted-contracts"><header><strong>进行中的合同</strong><small>生成日后第 3 个任务日到期，已交付物资不会退回或消失</small></header>{station.contractBoard.accepted.length ? station.contractBoard.accepted.map((contract) => {
          const basis = getStationContractCompletionBasisPoints(contract);
          return <article key={contract.id}><header><div><span>{contract.difficulty} · 截止任务日 {contract.expiresAtTaskDay}</span><strong>{contract.title}</strong></div><b>{Math.floor(basis / 100)}%</b></header>{contract.requirements.map((requirement, index) => <div className="station-contract-requirement" key={`${requirement.itemId}:${index}`}><ItemGlyph itemId={requirement.itemId} /><span>{ITEMS[requirement.itemId].name}<small>{formatQuantityCompact(requirement.delivered)} / {formatQuantityCompact(requirement.amount)}</small></span><i><b style={{ width: `${requirementPercent(requirement.delivered, requirement.amount)}%` }} /></i><button type="button" disabled={contract.status === "claimable" || !game.quantumLogisticsNetwork.enabled || BigInt(game.quantumLogisticsNetwork.inventory[requirement.itemId] ?? "0") < 1n} onClick={() => void deliverQuantum(contractTarget(contract.id), requirement.itemId)}><Sparkles size={13} />量子交付</button></div>)}<footer><button type="button" disabled={contract.status !== "claimable"} onClick={() => onGameChange((current) => reconcileOrbitalCargoTerminalBindings({ ...current, orbitalStation: claimStationContract(current.orbitalStation, contract.id) }))}><Check size={14} />领取完成奖励</button><button className="danger" type="button" onClick={() => void gameDialog.confirm("放弃后将按当前加权完成比例结算基础奖励，且无法恢复。确定放弃？", { danger: true, title: "放弃出口合同", confirmLabel: "放弃并结算" }).then((confirmed) => confirmed && onGameChange((current) => reconcileOrbitalCargoTerminalBindings({ ...current, orbitalStation: abandonStationContract(current.orbitalStation, contract.id) })))}>放弃并部分结算</button></footer></article>;
        }) : <p>尚未接受合同。每日提供 3 份普通合同和 1 份特别合同。</p>}</section>
      </section> : null}

      {tab === "decorations" && decorationAvailable ? <section className="orbital-station-decoration-layout">
        <div className="station-decoration-canvas-pane"><button className={decorationEditing ? "station-decoration-edit-toggle active" : "station-decoration-edit-toggle"} type="button" aria-pressed={decorationEditing} onClick={() => setDecorationEditing((current) => !current)}><Pencil size={15} />{decorationEditing ? "退出编辑模式" : "进入编辑模式"}</button><StationCanvasRenderer station={station} readOnly={!decorationEditing} selectedPlacementId={selectedPlacementId} onSelectPlacement={selectPlacement} onMovePlacement={(placementId, position) => onGameChange((current) => ({ ...current, orbitalStation: updateStationDecoration(current.orbitalStation, placementId, position) }))} onViewportChange={(viewport) => onGameChange((current) => ({ ...current, orbitalStation: setOrbitalStationViewport(current.orbitalStation, viewport) }))} /></div>
        <aside className="station-decoration-shop"><header><ShoppingBag size={18} /><span><strong>装饰收藏</strong><small>{formatQuantityCompact(station.economy.orbitalMarks)} 轨道徽记 · {decorationEditing ? "编辑已开启" : "浏览模式"}</small></span></header>{selectedPlacement && selectedDecoration ? <section className="station-decoration-editor"><strong>{selectedDecoration.name}</strong><small>位置 {Math.round(selectedPlacement.x)}, {Math.round(selectedPlacement.y)} · 层级 {selectedPlacement.layer}</small><div><button type="button" disabled={!decorationEditing} onClick={() => {
          const rotations = selectedDecoration.rotations;
          const next = rotations[(rotations.indexOf(selectedPlacement.rotation) + 1) % rotations.length] as StationDecorationRotation;
          onGameChange((current) => ({ ...current, orbitalStation: updateStationDecoration(current.orbitalStation, selectedPlacement.id, { rotation: next }) }));
        }}>切换旋转</button><button type="button" disabled={!decorationEditing} onClick={() => {
          const layers = selectedDecoration.layers;
          const next = layers[(layers.indexOf(selectedPlacement.layer) + 1) % layers.length];
          onGameChange((current) => ({ ...current, orbitalStation: updateStationDecoration(current.orbitalStation, selectedPlacement.id, { layer: next }) }));
        }}>切换层级</button>{selectedDecoration.variantCount > 1 ? <button type="button" disabled={!decorationEditing} onClick={() => onGameChange((current) => ({ ...current, orbitalStation: updateStationDecoration(current.orbitalStation, selectedPlacement.id, { variant: (selectedPlacement.variant + 1) % selectedDecoration.variantCount }) }))}>切换样式</button> : null}<button className="danger" type="button" disabled={!decorationEditing} onClick={() => { onGameChange((current) => ({ ...current, orbitalStation: removeStationDecoration(current.orbitalStation, selectedPlacement.id) })); selectPlacement(null); }}>移除摆放</button></div></section> : null}<div className="station-theme-list">{STATION_THEMES.map((theme) => {
          const owned = theme.markCost === "0" || station.economy.unlockedDecorationIds.includes(`theme:${theme.id}`);
          return <button className={station.layout.themeId === theme.id ? "active" : ""} type="button" disabled={!decorationEditing || level.level < theme.minimumLevel || !owned && BigInt(station.economy.orbitalMarks) < BigInt(theme.markCost)} key={theme.id} onClick={() => onGameChange((current) => {
            const licensed = owned ? current.orbitalStation : purchaseStationTheme(current.orbitalStation, theme.id);
            return { ...current, orbitalStation: setStationTheme(licensed, theme.id) };
          })}><i style={{ background: theme.accent }} /><span>{theme.name}<small>{owned ? "已收藏" : `${theme.markCost} 徽记`}</small></span></button>;
        })}</div><div className="station-decoration-catalog">{STATION_DECORATIONS.map((definition) => {
          const owned = definition.markCost === "0" || station.economy.unlockedDecorationIds.includes(definition.id);
          const locked = level.level < definition.minimumLevel;
          return <article className={owned ? "owned" : ""} key={definition.id}><i style={{ color: definition.color }}>{definition.glyph}</i><div><strong>{definition.name}</strong><small>{definition.description}</small><span>{definition.repeatable ? "可重复摆放" : "唯一展品"} · Lv.{definition.minimumLevel}</span></div><button type="button" disabled={locked || owned && !decorationEditing || !owned && BigInt(station.economy.orbitalMarks) < BigInt(definition.markCost)} onClick={() => owned ? placeDecoration(definition.id) : onGameChange((current) => ({ ...current, orbitalStation: purchaseStationDecoration(current.orbitalStation, definition.id) }))}>{owned ? decorationEditing ? "摆放" : "进入编辑后摆放" : `${definition.markCost} 徽记`}</button></article>;
        })}</div></aside>
      </section> : null}

      {tab === "profile" && decorationAvailable ? <section className="orbital-station-panel station-profile-panel">
        <header className="station-section-heading"><div><small>公开主页预览资料</small><strong>空间站档案</strong></div><Eye size={20} /></header>
        <label><span>空间站名称</span><StableTextInput draftId="station-profile-title" value={profileTitle} onValueChange={setProfileTitle} maxLength={32} /></label>
        <label><span>空间站简介</span><textarea value={profileMotto} maxLength={96} onChange={(event) => setProfileMotto(event.target.value)} /></label>
        <button className="station-primary-action" type="button" onClick={() => onGameChange((current) => ({ ...current, orbitalStation: setOrbitalStationProfile(current.orbitalStation, { title: profileTitle, motto: profileMotto }) }))}>保存档案</button>
        <section className="station-profile-selector"><header><strong>精选生产数据</strong><small>最多 4 项；公开页仍只显示安全聚合值</small></header><div>{STATION_METRIC_OPTIONS.map((metric) => {
          const selected = station.profile.featuredMetricKeys.includes(metric.id);
          return <button className={selected ? "active" : ""} type="button" aria-pressed={selected} disabled={!selected && station.profile.featuredMetricKeys.length >= 4} key={metric.id} onClick={() => onGameChange((current) => {
            const keys = current.orbitalStation.profile.featuredMetricKeys;
            const featuredMetricKeys = keys.includes(metric.id) ? keys.filter((key) => key !== metric.id) : [...keys, metric.id].slice(0, 4);
            return { ...current, orbitalStation: setOrbitalStationProfile(current.orbitalStation, { featuredMetricKeys }) };
          })}>{metric.label}</button>;
        })}</div></section>
        <section className="station-profile-selector"><header><strong>公开成就展柜</strong><small>最多 8 项；仅能选择当前存档已解锁成就</small></header>{game.achievements.unlockedIds.length ? <div>{ACHIEVEMENTS.filter((achievement) => game.achievements.unlockedIds.includes(achievement.id)).map((achievement) => {
          const selected = station.layout.featuredAchievementIds.includes(achievement.id);
          return <button className={selected ? "active" : ""} type="button" aria-pressed={selected} disabled={!selected && station.layout.featuredAchievementIds.length >= 8} key={achievement.id} onClick={() => onGameChange((current) => {
            const ids = current.orbitalStation.layout.featuredAchievementIds;
            const featured = ids.includes(achievement.id) ? ids.filter((id) => id !== achievement.id) : [...ids, achievement.id].slice(0, 8);
            return { ...current, orbitalStation: setOrbitalStationFeaturedAchievements(current.orbitalStation, featured, current.achievements.unlockedIds) };
          })}>{achievement.name}</button>;
        })}</div> : <p>当前存档尚未解锁可展示成就。</p>}</section>
        <section className="station-public-data-notice"><RadioTower size={24} /><div><strong>公开与排行榜相互独立</strong><p>公开主页只会由普通主云存档生成脱敏快照；不会公开完整存档、库存、线路、蓝图、合同进度、徽记余额或账号隐私。未登录时空间站仍可完整离线游玩。</p></div></section>
        <section className="station-public-controls">
          <header><div>{cloudProfile?.visibility === "private" ? <EyeOff size={18} /> : <Cloud size={18} />}<span><strong>{cloudProfile?.published ? cloudProfile.visibility === "public" ? "公开主页已发布" : "公开主页已隐藏" : hasCloudAuthentication() ? "尚未发布公开主页" : "未登录云账号"}</strong><small>{cloudProfile?.sourceRevision ? `来源：普通主云修订 ${cloudProfile.sourceRevision}` : "发布只读取普通模式主云存档"}</small></span></div></header>
          {hasCloudAuthentication() ? <div>
            <button type="button" disabled={cloudProfileStatus === "busy" || cloudProfileStatus === "loading"} onClick={() => void publishStation()}><Cloud size={15} />{cloudProfile?.published ? "立即重建快照" : "发布当前主云空间站"}</button>
            {cloudProfile?.published ? <button type="button" disabled={cloudProfileStatus === "busy"} onClick={() => void changeVisibility(cloudProfile.visibility === "public" ? "private" : "public")}>{cloudProfile.visibility === "public" ? <EyeOff size={15} /> : <Eye size={15} />}{cloudProfile.visibility === "public" ? "设为私密" : "恢复公开"}</button> : null}
            {cloudProfile?.publicId ? <><a href={`/station/${cloudProfile.publicId}`} target="_blank" rel="noreferrer"><Eye size={15} />预览公开页</a><button type="button" onClick={() => void copyPublicLink()}><Link2 size={15} />复制链接</button></> : null}
          </div> : <p>请先在银河网络登录云账号并同步普通主存档；本地建设、合同、点数和装饰不受影响。</p>}
          {cloudProfileMessage ? <p role="status">{cloudProfileMessage}</p> : null}
        </section>
        <section className="station-showcase-history"><header><strong>已完成出口合同</strong><small>{station.totals.completedContracts} 份</small></header>{station.contractBoard.history.filter((contract) => contract.settlementReason === "completed").slice(0, 8).map((contract) => <button className={station.contractBoard.featuredContractId === contract.id ? "active" : ""} type="button" key={contract.id} onClick={() => onGameChange((current) => ({ ...current, orbitalStation: setFeaturedStationContract(current.orbitalStation, station.contractBoard.featuredContractId === contract.id ? null : contract.id) }))}><Trophy size={14} /><span>{contract.title}</span><small>{contract.difficulty}</small></button>)}</section>
      </section> : null}
    </main>
  </WorkspaceFrame>;
}
