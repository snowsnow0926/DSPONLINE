import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  SelectionMode,
  ViewportPortal,
  useNodesState,
  useReactFlow,
  useStoreApi,
  type Connection,
  type Edge,
  type FinalConnectionState,
  type NodeMouseHandler,
  type OnConnectStartParams,
  type OnSelectionChangeParams,
} from "@xyflow/react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Activity, AlertTriangle, ArrowUp, BookOpen, Check, Copy, Download, Focus, Map as MapIcon, PanelRightClose, Route, Sparkles, Trash2, WandSparkles, X } from "lucide-react";
import {
  BuildingPlacementCursor,
  CargoCursor,
  ConstructionDock,
  HeaderControls,
  InspectorPanel,
  PlanetNavigator,
  ResourceRail,
} from "./components/GamePanels";
import { CommandPalette, type CommandWorkspace } from "./components/CommandPalette";
import { NODE_TYPES, type FactoryFlowNode, type FactoryNodeData } from "./components/FactoryNodes";
import { EDGE_TYPES, FactoryConnectionLine, type FactoryFlowEdge } from "./components/FactoryEdges";
import { BlueprintPlacementCursor, BlueprintWorkspace, CanvasRegionEditor, CanvasRegionLayer, CanvasSelectionTools, SelectionToolbar, type CanvasRegionRectangle, type CanvasRegionResizeHandle } from "./components/BlueprintWorkspace";
import { RecipeFocusPanel } from "./components/RecipeFocusPanel";
import { OnboardingCoach } from "./components/OnboardingCoach";
import { MobileGameShell } from "./components/mobile/MobileGameShell";
import { MobilePlacementBar, MobileSelectionContextBar, type MobileCanvasMode } from "./components/mobile/MobileFactoryPanels";
import type { OperationsTab } from "./components/OperationsWorkspace";
import type { StatisticsTab } from "./components/StatisticsWorkspace";
import { ITEMS, RECIPES, getBeltConstructionId, getBuilding, getBuildingUpgradeTarget, getConstructionDefinition, getExtractorBuildingId, getPlanet, getStarSystem, getTechnology } from "./game/content";
import { getFactoryAlerts, type FactoryAlert } from "./game/alerts";
import { getPlanetIndustrialProfile, getPlanetSolarPowerMultiplier } from "./game/galaxy";
import {
  addUnitToEntityGroup,
  addCanvasBookmark,
  addCanvasRegion,
  applyStationSlotTemplateToEntities,
  applyBeltConfiguration,
  addDysonLayer,
  addDysonNode,
  addDysonSwarmOrbit,
  adjustStationDrones,
  adjustStationWarpers,
  adjustStationVessels,
  advanceSimulation,
  applyBeltConfigurationToNetwork,
  canConnectBelt,
  getBeltConnectionCheck,
  connectBelt,
  canPlaceBlueprint,
  canQueueBlueprint,
  cancelHandcraftQueueEntry,
  cancelConstructionQueueEntry,
  canUpgradeEntities,
  canUpgradeBelt,
  cancelCurrentResearch,
  clearDysonShells,
  colonizePlanet,
  connectDysonNodes,
  craftConstruction,
  craftConstructionWithUpstream,
  createBlueprint,
  createStandardDysonLayer,
  dropCargoToEntity,
  dropCargoToTray,
  exploreStarSystem,
  getAcceptedInputs,
  getBeltCapacity,
  getBeltNetworkIds,
  getConstructionCraftNavigation,
  getConstructionQuickCraftPlan,
  MIN_CANVAS_REGION_SIZE,
  getEntityOperatingStatus,
  getEntityPowerFactor,
  getResourceReserveSnapshot,
  getProducedOutputs,
  getTechnologyConstructionRewards,
  handcraftRecipe,
  installSprayCoater,
  installSprayCoaters,
  installMiner,
  manualMine,
  moveEntityInputToEntity,
  moveEntityInputToTray,
  moveEntityOutputToEntity,
  moveEntityOutputToTray,
  moveEntities,
  moveTrayItemToEntity,
  pickFromEntity,
  pickFromEntityInput,
  pickFromTray,
  placeBuilding,
  placeBlueprint,
  pauseCurrentResearch,
  queueBlueprint,
  queueHandcraftRecipe,
  removeBelt,
  removeBeltNetwork,
  removeCanvasBookmark,
  removeCanvasRegion,
  removeBlueprint,
  removeDysonLayer,
  removeDysonNode,
  removeDysonSwarmOrbit,
  removeEntity,
  removeEntities,
  removeQueuedTechnology,
  resumePausedResearch,
  selectTechnology,
  setBeltPriority,
  setBeltRouteMode,
  setBeltRouteOffsetY,
  setBeltNetworkRouteMode,
  setBlueprintRecipeOverride,
  setBlueprintTransform,
  setBeltMonitorEnabled,
  setBeltStackSize,
  setConstructionAutomationEnabled,
  setConstructionAutomationTarget,
  setActivePlanet,
  setEntityRecipe,
  setEntitiesRecipe,
  setActiveDysonLayer,
  setActiveDysonSwarmOrbit,
  setDysonLaunchEnabled,
  setDysonLaunchMode,
  setDysonLaunchThrottle,
  setDysonLayerOrbit,
  setDysonSwarmOrbit,
  setEnergyMode,
  setEntityGenerationPriority,
  setEntityPowerGrid,
  setEntityPowerPriority,
  setRecipeFocus,
  setRecipeFocusMode,
  setRecipeFocusPosition,
  setFuelItem,
  setLogisticsItem,
  setPaused,
  setPlanetIndustryRole,
  setPlanetTrayItemLimit,
  setProliferatorConfiguration,
  setEntitiesProliferatorConfiguration,
  setStationMode,
  setStationHubConfiguration,
  setStationMinimumLoad,
  setStationSlotItem,
  setStationSlotLimits,
  setStationSlotMinimumLoad,
  setStationSlotMode,
  setStationSlotPriority,
  setStationSlotRoutePolicy,
  setStationSlotWarperBudget,
  setStationWarpEnabled,
  setStationWarperAutoRefill,
  setStationWarperTarget,
  setSplitterMode,
  upgradeBelt,
  upgradeBeltNetwork,
  upgradeEntities,
  upgradeEntity,
  updateCanvasRegion,
  resizeCanvasRegion,
  getBlueprintEligibleEntityIds,
  dispatchGalacticExport,
  selectInfiniteResearch,
  setGalacticDispatchAutomation,
  setGalacticDispatchThrottle,
  setGalacticExportEnabled,
  setGalacticExportPriority,
  setInfiniteResearchAutomation,
  autoConnectDysonLayer,
  planDysonShell,
  renameBlueprint,
  renameCanvasBookmark,
} from "./game/engine";
import { getAchievement, getNewAchievementIds, unlockAchievements } from "./game/progression";
import { getDifficultyDefinition } from "./game/difficulty";
import { analyzeBeltNetwork, diagnoseBelt, getBeltBundleMap, getPortOccupancy, predictBeltConnection } from "./game/network";
import { planFactoryAutoLayout } from "./game/layout";
import { createProductionPlan, removeProductionPlan, setProductionPlanRecipe, updateProductionPlan } from "./game/planning";
import { getCampaignTask, getCampaignTaskRequirements, selectCampaignTask, syncCampaignProgress, type CampaignNavigation } from "./game/campaign";
import { clearGameSlot, clearSaveSnapshot, exportGame, getSaveSlotSummaries, getSaveSnapshotSummaries, inspectSave, loadGameSlot, loadSaveSnapshot, saveGame, saveGameSnapshot, saveGameSlot, type LoadedGame, type OfflineReport, type SaveGameResult, type SaveInspection, type SaveSlotId, type SaveSnapshotSummary } from "./game/storage";
import { runAutomaticPerformanceReport, type AutomaticPerformanceReport } from "./game/benchmark";
import { importBlueprintExchange, parseBlueprintExchange, serializeBlueprintExchange } from "./game/blueprintExchange";
import { getDesktopBridge, type DesktopReleaseInfo } from "./desktop";
import { createContentPackTemplate, parseContentPack, type ModValidationResult } from "./game/mods";
import {
  applyContentPackRegistry,
  getContentPackValidationContext,
  getContentPackUsage,
  loadContentPackRegistry,
  registerContentPack,
  removeContentPack,
  saveContentPackRegistry,
  setContentPackEnabled,
  type ContentPackRegistry,
} from "./game/contentPacks";
import { baselineAccountProgress, createLocalAccount, getActiveAccount, loadAccountState, recordAccountProgress, saveAccountState, setActiveCloudBinding, switchLocalAccount, updateAccountProfile, type AccountProfileChanges } from "./game/account";
import { removeLeaderboardData, submitLeaderboardData } from "./game/leaderboard";
import { trackAnalyticsEvent } from "./game/analytics";
import { CLOUD_AUTO_SYNC_INTERVAL_MS, CloudApiError, compareCloudSave, getCloudToken, markCloudSaveSynchronized, readCloudAutoSyncStatus, resumeCloudSession, uploadCloudSave, writeCloudAutoSyncStatus } from "./game/cloud";
import type { BeltRouteMode, BeltTier, BuildingId, CampaignTaskId, CanvasBookmark, CanvasRegion, CanvasViewport, CargoStackSize, ConstructionId, DraggedItemSourceKind, DysonLaunchMode, DysonLaunchThrottle, EnergyMode, GalacticDispatchThrottle, GalacticExportProjectId, GameSettings, GameState, InfiniteResearchId, ItemId, LogisticsPriority, PlacementCount, PlanetId, PlanetIndustryRole, PowerGridId, PowerPriority, ProliferatorMode, ProliferatorTier, RecipeId, StarSystemId, StationLogisticsMode, StationLogisticsScope, StationMinimumLoad, StationSlotTemplate } from "./game/types";
import type { SimulationWorkerRequest, SimulationWorkerResponse } from "./game/simulation.worker";
import { getOnboardingFocusTarget, getOnboardingStep, type OnboardingStepId } from "./game/onboarding";
import { useCoarsePointer } from "./hooks/useCoarsePointer";
import { useCompactLayout } from "./hooks/useCompactLayout";
import { useLongPress } from "./hooks/useLongPress";
import { useLowEndMobile } from "./hooks/useLowEndMobile";
import { useResolvedTheme } from "./hooks/useResolvedTheme";
import { useMobileNavigation, type MobileWorkspaceId } from "./hooks/useMobileNavigation";
import { useMobileUiPreference } from "./hooks/useMobileUiPreference";
import { usePlayerPresence } from "./hooks/usePlayerPresence";
import { useSwipeDismiss } from "./hooks/useSwipeDismiss";

type InspectorTab = "inspect" | "fabricate";

interface AlignmentGuides {
  x: number | null;
  y: number | null;
}

interface AutoLayoutUndoSnapshot {
  planetId: PlanetId;
  positions: Array<{ id: string; position: { x: number; y: number } }>;
}

interface ConnectionDraft {
  nodeId: string;
  itemId: ItemId;
  handleType: "source" | "target";
  tier: BeltTier;
}

type BeltTierMode = "auto" | "manual";

interface ConnectionHandleTarget {
  element: HTMLElement;
  nodeId: string;
  handleId: string;
  handleType: "source" | "target";
}

interface ClickConnectionPreviewState {
  originX: number;
  originY: number;
  handleType: "source" | "target";
  draft: ConnectionDraft;
}

type ConnectionPreviewTone = "pending" | "valid" | "invalid";

type InteractionSound = "confirm" | "complete" | "alert" | "place" | "connect" | "upgrade" | "remove" | "travel" | "launch";

interface RewardFlight {
  id: string;
  symbol: string;
  label: string;
  amount: number;
  color: string;
}

interface PlanetTransition {
  id: number;
  from: PlanetId;
  to: PlanetId;
}

interface InteractionBurst {
  id: number;
  x: number;
  y: number;
  label: string;
  tone: "positive" | "warning" | "neutral";
}

const FLOW_GRID = 20;
const HISTORY_LIMIT = 40;
const BELT_TIERS_DESCENDING: readonly BeltTier[] = [3, 2, 1];

function beltTierIsAvailable(state: GameState, tier: BeltTier): boolean {
  const constructionId = getBeltConstructionId(tier);
  const requiredTechId = getConstructionDefinition(constructionId)?.requiredTechId;
  return (!requiredTechId || state.research.completedTechIds.includes(requiredTechId)) &&
    Math.floor(state.construction[constructionId] ?? 0) > 0;
}

function resolveConnectionBeltTier(
  state: GameState,
  mode: BeltTierMode,
  manualTier: BeltTier,
  originNodeId?: string,
  itemId?: ItemId,
): BeltTier {
  if (mode === "manual") return manualTier;
  if (originNodeId && itemId) {
    const attachedTiers = new Set(state.belts
      .filter((belt) => belt.itemId === itemId && (belt.source === originNodeId || belt.target === originNodeId))
      .map((belt) => belt.tier));
    const existingTier = BELT_TIERS_DESCENDING.find((tier) => attachedTiers.has(tier) && beltTierIsAvailable(state, tier));
    if (existingTier) return existingTier;
  }
  return BELT_TIERS_DESCENDING.find((tier) => beltTierIsAvailable(state, tier)) ?? manualTier;
}

function snapFlowPosition(position: { x: number; y: number }) {
  return {
    x: Math.round(position.x / FLOW_GRID) * FLOW_GRID,
    y: Math.round(position.y / FLOW_GRID) * FLOW_GRID,
  };
}

function rectangleFromPoints(start: { x: number; y: number }, end: { x: number; y: number }): CanvasRegionRectangle {
  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  return {
    x: Math.round(left),
    y: Math.round(top),
    width: Math.round(Math.abs(end.x - start.x)),
    height: Math.round(Math.abs(end.y - start.y)),
  };
}

function resizeRegionRectangle(
  region: CanvasRegion,
  handle: CanvasRegionResizeHandle,
  start: { x: number; y: number },
  current: { x: number; y: number },
): CanvasRegionRectangle {
  const deltaX = current.x - start.x;
  const deltaY = current.y - start.y;
  const initialRight = region.x + region.width;
  const initialBottom = region.y + region.height;
  let x = region.x;
  let y = region.y;
  let right = initialRight;
  let bottom = initialBottom;
  if (handle.includes("w")) x = Math.min(initialRight - MIN_CANVAS_REGION_SIZE, region.x + deltaX);
  if (handle.includes("e")) right = Math.max(region.x + MIN_CANVAS_REGION_SIZE, initialRight + deltaX);
  if (handle.includes("n")) y = Math.min(initialBottom - MIN_CANVAS_REGION_SIZE, region.y + deltaY);
  if (handle.includes("s")) bottom = Math.max(region.y + MIN_CANVAS_REGION_SIZE, initialBottom + deltaY);
  return { x, y, width: right - x, height: bottom - y };
}

function distanceToSegment(point: { x: number; y: number }, start: { x: number; y: number }, end: { x: number; y: number }): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) return Math.hypot(point.x - start.x, point.y - start.y);
  const ratio = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(point.x - (start.x + ratio * dx), point.y - (start.y + ratio * dy));
}

function beltHeatColor(utilization: number): string {
  if (utilization >= 0.9) return "#ef7f68";
  if (utilization >= 0.65) return "#e2be58";
  if (utilization >= 0.35) return "#72bd88";
  if (utilization > 0.01) return "#59a9c5";
  return "#697771";
}

const RecipeWorkspace = lazy(() => import("./components/RecipeWorkspace").then((module) => ({ default: module.RecipeWorkspace })));
const StatisticsWorkspace = lazy(() => import("./components/StatisticsWorkspace").then((module) => ({ default: module.StatisticsWorkspace })));
const StarMapWorkspace = lazy(() => import("./components/StarMapWorkspace").then((module) => ({ default: module.StarMapWorkspace })));
const DysonPlannerWorkspace = lazy(() => import("./components/DysonPlannerWorkspace").then((module) => ({ default: module.DysonPlannerWorkspace })));
const OfflineReportWorkspace = lazy(() => import("./components/OfflineReportWorkspace").then((module) => ({ default: module.OfflineReportWorkspace })));
const OperationsWorkspace = lazy(() => import("./components/OperationsWorkspace").then((module) => ({ default: module.OperationsWorkspace })));
const TechnologyWorkspace = lazy(() => import("./components/TechnologyWorkspace").then((module) => ({ default: module.TechnologyWorkspace })));
const CampaignWorkspace = lazy(() => import("./components/CampaignWorkspace").then((module) => ({ default: module.CampaignWorkspace })));
const GalaxyWorkspace = lazy(() => import("./components/GalaxyWorkspace").then((module) => ({ default: module.GalaxyWorkspace })));
const ConstructionCenterWorkspace = lazy(() => import("./components/ConstructionCenterWorkspace").then((module) => ({ default: module.ConstructionCenterWorkspace })));

// Content packs must be active before save migration reads any modded IDs.
const INITIAL_CONTENT_PACK_REGISTRY = loadContentPackRegistry();
applyContentPackRegistry(INITIAL_CONTENT_PACK_REGISTRY);

function WorkspaceLoading() {
  return <div className="workspace-loading" role="status"><i /><span>正在载入工作区</span></div>;
}

function parseHandleItem(handle: string | null | undefined): ItemId | null {
  if (!handle) return null;
  const [, itemId] = handle.split(":");
  return itemId && itemId in ITEMS ? itemId as ItemId : null;
}

function isAutoInputHandle(handle: string | null | undefined): boolean {
  return handle === "in:auto";
}

function getEventPoint(event: MouseEvent | TouchEvent): { x: number; y: number } | null {
  if ("clientX" in event) return { x: event.clientX, y: event.clientY };
  const touch = event.touches[0] ?? event.changedTouches[0];
  return touch ? { x: touch.clientX, y: touch.clientY } : null;
}

function getConnectionHandleTarget(target: EventTarget | null): ConnectionHandleTarget | null {
  const element = target instanceof Element ? target.closest<HTMLElement>(".react-flow__handle") : null;
  const nodeId = element?.dataset.nodeid;
  const handleId = element?.dataset.handleid;
  const handleType = element?.classList.contains("source") ? "source" : element?.classList.contains("target") ? "target" : null;
  return element && nodeId && handleId && handleType ? { element, nodeId, handleId, handleType } : null;
}

function findConnectionHandleAtPoint(x: number, y: number, maximumDistance = 24, preferred?: (target: ConnectionHandleTarget) => boolean): ConnectionHandleTarget | null {
  const direct = getConnectionHandleTarget(document.elementFromPoint(x, y));
  if (direct) return direct;
  let nearest: { target: ConnectionHandleTarget; distance: number } | null = null;
  let nearestPreferred: { target: ConnectionHandleTarget; distance: number } | null = null;
  for (const element of document.querySelectorAll<HTMLElement>(".factory-canvas .react-flow__handle")) {
    const target = getConnectionHandleTarget(element);
    if (!target) continue;
    const bounds = element.getBoundingClientRect();
    const dx = Math.max(bounds.left - x, 0, x - bounds.right);
    const dy = Math.max(bounds.top - y, 0, y - bounds.bottom);
    const distance = Math.hypot(dx, dy);
    if (distance <= maximumDistance && (!nearest || distance < nearest.distance)) nearest = { target, distance };
    if (distance <= maximumDistance && preferred?.(target) && (!nearestPreferred || distance < nearestPreferred.distance)) nearestPreferred = { target, distance };
  }
  return nearestPreferred?.target ?? nearest?.target ?? null;
}

function connectionFromDraft(draft: ConnectionDraft, target: ConnectionHandleTarget): Connection {
  const originHandleId = `${draft.handleType === "source" ? "out" : "in"}:${draft.itemId}`;
  return draft.handleType === "source"
    ? { source: draft.nodeId, sourceHandle: originHandleId, target: target.nodeId, targetHandle: target.handleId }
    : { source: target.nodeId, sourceHandle: target.handleId, target: draft.nodeId, targetHandle: originHandleId };
}

function ClickConnectionPreview({ preview, pointer, tone }: {
  preview: ClickConnectionPreviewState;
  pointer: { x: number; y: number };
  tone: ConnectionPreviewTone;
}) {
  const reach = Math.max(48, Math.abs(pointer.x - preview.originX) * 0.42);
  const direction = preview.handleType === "source" ? 1 : -1;
  const path = `M${preview.originX} ${preview.originY} C${preview.originX + reach * direction} ${preview.originY} ${pointer.x - reach * direction} ${pointer.y} ${pointer.x} ${pointer.y}`;
  return (
    <svg className="factory-click-connection-preview" aria-hidden="true">
      <g className={`factory-connection-preview factory-connection-preview--${tone}`}>
        <path className="factory-connection-preview__halo" d={path} />
        <path className="factory-connection-preview__path" d={path} />
        <circle className="factory-connection-preview__target" cx={pointer.x} cy={pointer.y} r="7" />
      </g>
    </svg>
  );
}

function minerPlacementHint(buildingId: BuildingId): string {
  if (buildingId === "oil_extractor") return "原油萃取站需要部署在原油涌泉上";
  if (buildingId === "water_pump") return "抽水站需要部署在水或硫酸海洋上";
  return "采矿机需要部署在固体资源矿脉上";
}

export function FactoryGame({ initialLoad, onReturnToMenu, onOpenReleaseNotes }: { initialLoad: LoadedGame; onReturnToMenu: () => void; onOpenReleaseNotes: () => void }) {
  usePlayerPresence();
  const compactLayout = useCompactLayout();
  const [mobileUiPreference, setMobileUiPreference] = useMobileUiPreference();
  const [loaded] = useState(initialLoad);
  const [game, setGame] = useState(loaded.state);
  const resolvedTheme = useResolvedTheme(game.settings.theme);
  const [canvasGame, setCanvasGame] = useState(loaded.state);
  const [selectedEntityIds, setSelectedEntityIds] = useState<string[]>([]);
  const [selectedBeltId, setSelectedBeltId] = useState<string | null>(null);
  const [selectedBeltIds, setSelectedBeltIds] = useState<string[]>([]);
  const [focusedBeltNetworkId, setFocusedBeltNetworkId] = useState<string | null>(null);
  const [copiedBeltConfigurationId, setCopiedBeltConfigurationId] = useState<string | null>(null);
  const [placement, setPlacement] = useState<BuildingId | null>(null);
  const [beltTier, setBeltTier] = useState<BeltTier>(1);
  const [beltTierMode, setBeltTierMode] = useState<BeltTierMode>("auto");
  const [placementCount, setPlacementCount] = useState<PlacementCount>(1);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("inspect");
  const [mobilePanel, setMobilePanel] = useState<"resources" | "inspector" | null>(null);
  const [mobilePanelStage, setMobilePanelStage] = useState<"half" | "full">("half");
  const [mobileActionEntityId, setMobileActionEntityId] = useState<string | null>(null);
  const [mobileCanvasMode, setMobileCanvasMode] = useState<MobileCanvasMode>("browse");
  const [mobileContinuousPlacement, setMobileContinuousPlacement] = useState(false);
  const [leftSidebarCollapsed, setLeftSidebarCollapsed] = useState(false);
  const [rightSidebarCollapsed, setRightSidebarCollapsed] = useState(false);
  const [minimapCollapsed, setMinimapCollapsed] = useState(false);
  const [autoLayoutUndo, setAutoLayoutUndo] = useState<AutoLayoutUndoSnapshot | null>(null);
  const [technologyOpen, setTechnologyOpen] = useState(false);
  const [statisticsOpen, setStatisticsOpen] = useState(false);
  const [statisticsFocusTab, setStatisticsFocusTab] = useState<StatisticsTab | null>(null);
  const [recipesOpen, setRecipesOpen] = useState(false);
  const [starMapOpen, setStarMapOpen] = useState(false);
  const [blueprintsOpen, setBlueprintsOpen] = useState(false);
  const [dysonPlannerOpen, setDysonPlannerOpen] = useState(false);
  const [operationsOpen, setOperationsOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [campaignOpen, setCampaignOpen] = useState(false);
  const [galaxyOpen, setGalaxyOpen] = useState(false);
  const [galaxyFocusTab, setGalaxyFocusTab] = useState<"ranking" | "cloud" | "account" | null>(null);
  const [constructionCenterOpen, setConstructionCenterOpen] = useState(false);
  const [fabricatorFocusItemId, setFabricatorFocusItemId] = useState<ItemId | null>(null);
  const [accountState, setAccountState] = useState(loadAccountState);
  const [campaignFocusItemId, setCampaignFocusItemId] = useState<ItemId | null>(null);
  const [campaignFocusTechId, setCampaignFocusTechId] = useState<GameState["research"]["selectedTechId"]>(null);
  const [operationsTab, setOperationsTab] = useState<OperationsTab>("alerts");
  const [offlineReport, setOfflineReport] = useState<OfflineReport | null>(loaded.offlineReport);
  const [saveSlots, setSaveSlots] = useState(getSaveSlotSummaries);
  const [saveSnapshots, setSaveSnapshots] = useState<SaveSnapshotSummary[]>(getSaveSnapshotSummaries);
  const [importPreview, setImportPreview] = useState<SaveInspection | null>(null);
  const [pendingImportState, setPendingImportState] = useState<GameState | null>(null);
  const [modValidation, setModValidation] = useState<ModValidationResult | null>(null);
  const [contentPackRegistry, setContentPackRegistry] = useState<ContentPackRegistry>(INITIAL_CONTENT_PACK_REGISTRY);
  const [performanceReport, setPerformanceReport] = useState<AutomaticPerformanceReport | null>(null);
  const [desktopRelease, setDesktopRelease] = useState<DesktopReleaseInfo | null>(null);
  const [blueprintPlacementId, setBlueprintPlacementId] = useState<string | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [regionMode, setRegionMode] = useState(false);
  const [regionDraft, setRegionDraft] = useState<CanvasRegionRectangle | null>(null);
  const [regionResizePreview, setRegionResizePreview] = useState<{ regionId: string; rectangle: CanvasRegionRectangle } | null>(null);
  const [selectedRegionId, setSelectedRegionId] = useState<string | null>(null);
  const [miningEntityId, setMiningEntityId] = useState<string | null>(null);
  const [alignmentGuides, setAlignmentGuides] = useState<AlignmentGuides>({ x: null, y: null });
  const [connectionDraft, setConnectionDraft] = useState<ConnectionDraft | null>(null);
  const [clickConnectionPreview, setClickConnectionPreview] = useState<ClickConnectionPreviewState | null>(null);
  const [clickConnectionTone, setClickConnectionTone] = useState<ConnectionPreviewTone>("pending");
  const [clickConnectionSnapPoint, setClickConnectionSnapPoint] = useState<{ x: number; y: number } | null>(null);
  const [connectionHint, setConnectionHint] = useState<{ label: string; tone: "ready" | "blocked" | "warning" } | null>(null);
  const initialViewport = loaded.state.planetViewports[loaded.state.activePlanetId] ?? { x: 510, y: 250, zoom: 0.84 };
  const [viewportZoom, setViewportZoom] = useState(initialViewport.zoom);
  const [highlightedTaskId, setHighlightedTaskId] = useState<CampaignTaskId | null>(null);
  const [rewardFlights, setRewardFlights] = useState<RewardFlight[]>([]);
  const [planetTransition, setPlanetTransition] = useState<PlanetTransition | null>(null);
  const [simulationWorkerActive, setSimulationWorkerActive] = useState(false);
  const [pageHidden, setPageHidden] = useState(document.visibilityState === "hidden");
  const [lowFrameRateMode, setLowFrameRateMode] = useState(false);
  const [, setHistoryRevision] = useState(0);
  const [nodes, setNodes, onNodesChange] = useNodesState<FactoryFlowNode>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [saveFailure, setSaveFailure] = useState<SaveGameResult | null>(null);
  const [eventHistory, setEventHistory] = useState<Array<{ id: number; text: string }>>([]);
  const [interactionBursts, setInteractionBursts] = useState<InteractionBurst[]>([]);
  const [ctrlHeld, setCtrlHeld] = useState(false);
  const [pointer, setPointer] = useState({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  const gameRef = useRef(game);
  const latestCanvasGameRef = useRef(game);
  const accountStateRef = useRef(accountState);
  const completedTechCountRef = useRef(game.research.completedTechIds.length);
  const achievementCountRef = useRef(game.achievements.unlockedIds.length);
  const campaignCompletedCountRef = useRef(game.campaign.completedTaskIds.length);
  const launchCountRef = useRef({ sails: game.dysonSwarm.totalLaunched, rockets: game.dysonSphere.totalRocketsLaunched });
  const miningTimerRef = useRef<number | null>(null);
  const nodeDragActiveRef = useRef(false);
  const factoryCanvasRef = useRef<HTMLElement | null>(null);
  const pointerRef = useRef(pointer);
  const clickConnectionPreviewRef = useRef<ClickConnectionPreviewState | null>(null);
  const clickConnectionSucceededRef = useRef(false);
  const dragConnectionStartRef = useRef<{ x: number; y: number } | null>(null);
  const regionPointerRef = useRef<{ pointerId: number; start: { x: number; y: number } } | null>(null);
  const regionResizeRef = useRef<{
    pointerId: number;
    region: CanvasRegion;
    handle: CanvasRegionResizeHandle;
    start: { x: number; y: number };
  } | null>(null);
  const activeCanvasTouchesRef = useRef(new Map<number, { x: number; y: number; target: EventTarget | null }>());
  const canvasMultiTouchRef = useRef<{
    pointerIds: [number, number];
    initialCenter: { x: number; y: number };
    initialDistance: number;
    initialViewport: { x: number; y: number; zoom: number };
  } | null>(null);
  const blockCanvasTouchRef = useRef(false);
  const syntheticTouchCancelRef = useRef(false);
  const connectRequestRef = useRef<(connection: Connection, tier?: BeltTier) => void>(() => undefined);
  const connectionDraftRef = useRef<ConnectionDraft | null>(null);
  const suppressConnectionClickRef = useRef(false);
  const suppressConnectionClickTimerRef = useRef(0);
  const viewportRef = useRef<CanvasViewport>({ ...initialViewport });
  const canvasSizeRef = useRef<{ width: number; height: number } | null>(null);
  const continuousPlacementRef = useRef<{ entityId: string; buildingId: BuildingId; planetId: PlanetId } | null>(null);
  const ctrlHeldRef = useRef(false);
  const undoStackRef = useRef<GameState[]>([]);
  const redoStackRef = useRef<GameState[]>([]);
  const selectedEntityIdsRef = useRef<string[]>([]);
  const selectedBeltIdRef = useRef<string | null>(null);
  const selectedBeltIdsRef = useRef<string[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const simulationWorkerRef = useRef<Worker | null>(null);
  const simulationWorkerDisabledRef = useRef(false);
  const simulationSubmissionRef = useRef<{ id: number; state: GameState; seconds: number } | null>(null);
  const simulationPendingSecondsRef = useRef(0);
  const simulationRequestIdRef = useRef(0);
  const eventSequenceRef = useRef(0);
  const burstSequenceRef = useRef(0);
  const { screenToFlowPosition, setCenter, setViewport, fitView, getViewport, zoomIn, zoomOut } = useReactFlow();
  const flowStore = useStoreApi<FactoryFlowNode, FactoryFlowEdge>();
  const coarsePointer = useCoarsePointer();
  const lowEndMobile = useLowEndMobile();
  const nextMobileShell = compactLayout.isMobileShell && mobileUiPreference === "next";
  const activeMobileCanvasMode: MobileCanvasMode = placement
    ? "place"
    : connectionDraft || clickConnectionPreview
      ? "connect"
      : mobileCanvasMode;
  const closeAllWorkspaces = useCallback(() => {
    setTechnologyOpen(false);
    setStatisticsOpen(false);
    setStatisticsFocusTab(null);
    setRecipesOpen(false);
    setStarMapOpen(false);
    setBlueprintsOpen(false);
    setDysonPlannerOpen(false);
    setOperationsOpen(false);
    setCampaignOpen(false);
    setGalaxyOpen(false);
    setConstructionCenterOpen(false);
  }, []);
  const returnMobileToFactory = useCallback(() => {
    closeAllWorkspaces();
    setMobilePanel(null);
    setMobileActionEntityId(null);
    setCommandPaletteOpen(false);
  }, [closeAllWorkspaces]);
  const mobileNavigation = useMobileNavigation({ enabled: nextMobileShell, onFactoryRequested: returnMobileToFactory });
  const activeMobileWorkspace: MobileWorkspaceId | null = technologyOpen ? "technology"
    : statisticsOpen ? "statistics"
      : recipesOpen ? "recipes"
        : starMapOpen ? "star-map"
          : blueprintsOpen ? "blueprints"
            : dysonPlannerOpen ? "dyson"
              : operationsOpen ? "operations"
                : campaignOpen ? "campaign"
                  : galaxyOpen ? "galaxy"
                    : constructionCenterOpen ? "construction-center"
                      : null;
  const mobilePerformanceMode = coarsePointer;
  const constrainedMobile = coarsePointer && lowEndMobile;
  const mobileSimulationConstrained = constrainedMobile || lowFrameRateMode;
  const canvasWorkspacePaused = pageHidden || technologyOpen || statisticsOpen || recipesOpen || starMapOpen ||
    blueprintsOpen || dysonPlannerOpen || operationsOpen || campaignOpen || galaxyOpen || constructionCenterOpen ||
    (nextMobileShell && mobileNavigation.route.kind === "hub");
  const updateConnectionDraft = useCallback((draft: ConnectionDraft | null) => {
    connectionDraftRef.current = draft;
    setConnectionDraft(draft);
  }, []);
  const mobilePanelSwipe = useSwipeDismiss<HTMLButtonElement>({
    axis: "y",
    direction: 1,
    onDismiss: () => {
      if (mobilePanelStage === "full") setMobilePanelStage("half");
      else setMobilePanel(null);
    },
  });
  const longPressBindings = useLongPress<HTMLElement>({
    getTarget: (event) => {
      if (!coarsePointer || placement || blueprintPlacementId) return null;
      const element = event.target instanceof Element ? event.target.closest<HTMLElement>(".react-flow__node") : null;
      return element?.dataset.id ?? null;
    },
    onLongPress: (entityId) => {
      setSelectedEntityIds([entityId]);
      setSelectedBeltId(null);
      setSelectedBeltIds([]);
      setMobileActionEntityId(entityId);
      setMobilePanel(null);
    },
  });

  useEffect(() => {
    const canvas = factoryCanvasRef.current;
    const flow = canvas?.querySelector<HTMLElement>(".react-flow") ?? canvas;
    if (!flow || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const observer = new ResizeObserver(([entry]) => {
      const nextSize = { width: entry.contentRect.width, height: entry.contentRect.height };
      const previousSize = canvasSizeRef.current;
      canvasSizeRef.current = nextSize;
      if ((!coarsePointer && !nextMobileShell) || !previousSize || nextSize.width <= 0 || nextSize.height <= 0 ||
        (Math.abs(previousSize.width - nextSize.width) < 1 && Math.abs(previousSize.height - nextSize.height) < 1)) return;
      const viewport = viewportRef.current;
      const worldCenter = {
        x: (previousSize.width / 2 - viewport.x) / viewport.zoom,
        y: (previousSize.height / 2 - viewport.y) / viewport.zoom,
      };
      const preserved = {
        x: nextSize.width / 2 - worldCenter.x * viewport.zoom,
        y: nextSize.height / 2 - worldCenter.y * viewport.zoom,
        zoom: viewport.zoom,
      };
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        viewportRef.current = preserved;
        void setViewport(preserved, { duration: 0 });
      });
    });
    observer.observe(flow);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [coarsePointer, nextMobileShell, setViewport]);

  useEffect(() => {
    if (mobilePerformanceMode || nextMobileShell) setMinimapCollapsed(true);
  }, [mobilePerformanceMode, nextMobileShell]);

  useEffect(() => {
    const updateVisibility = () => setPageHidden(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", updateVisibility);
    return () => document.removeEventListener("visibilitychange", updateVisibility);
  }, []);

  useEffect(() => {
    if (!coarsePointer) {
      setLowFrameRateMode(false);
      return;
    }
    let frame = 0;
    let frames = 0;
    let sampledAt = performance.now();
    let recoveryWindows = 0;
    const sample = (now: number) => {
      if (document.visibilityState === "hidden") {
        frames = 0;
        sampledAt = now;
        frame = window.requestAnimationFrame(sample);
        return;
      }
      frames += 1;
      const elapsed = now - sampledAt;
      if (elapsed >= 3_000) {
        const fps = frames * 1000 / elapsed;
        if (fps < 36) {
          recoveryWindows = 0;
          setLowFrameRateMode(true);
        } else if (fps >= 50) {
          recoveryWindows += 1;
          if (recoveryWindows >= 2) setLowFrameRateMode(false);
        } else {
          recoveryWindows = 0;
        }
        frames = 0;
        sampledAt = now;
      }
      frame = window.requestAnimationFrame(sample);
    };
    frame = window.requestAnimationFrame(sample);
    return () => window.cancelAnimationFrame(frame);
  }, [coarsePointer]);

  useEffect(() => {
    gameRef.current = game;
    latestCanvasGameRef.current = game;
    if (!coarsePointer && !canvasWorkspacePaused) setCanvasGame(game);
  }, [canvasWorkspacePaused, coarsePointer, game]);
  useEffect(() => {
    if (!coarsePointer || canvasWorkspacePaused) return;
    setCanvasGame(latestCanvasGameRef.current);
    const timer = window.setInterval(() => {
      setCanvasGame((current) => current === latestCanvasGameRef.current ? current : latestCanvasGameRef.current);
    }, mobileSimulationConstrained ? 750 : 450);
    return () => window.clearInterval(timer);
  }, [canvasWorkspacePaused, coarsePointer, mobileSimulationConstrained]);
  useEffect(() => {
    if (mobilePanel) setMobilePanelStage("half");
  }, [mobilePanel]);
  useEffect(() => {
    if (!nextMobileShell) return;
    mobileNavigation.syncWorkspace(activeMobileWorkspace);
  }, [activeMobileWorkspace, mobileNavigation.syncWorkspace, nextMobileShell]);
  useEffect(() => {
    if (!nextMobileShell) return;
    if (mobilePanel === "resources") mobileNavigation.syncBridgeSheet("inventory");
    else if (mobilePanel === "inspector") mobileNavigation.syncBridgeSheet("inspector");
  }, [mobileNavigation.syncBridgeSheet, mobilePanel, nextMobileShell]);
  useEffect(() => { accountStateRef.current = accountState; }, [accountState]);
  useEffect(() => { selectedEntityIdsRef.current = selectedEntityIds; }, [selectedEntityIds]);
  useEffect(() => { selectedBeltIdRef.current = selectedBeltId; }, [selectedBeltId]);
  useEffect(() => { selectedBeltIdsRef.current = selectedBeltIds; }, [selectedBeltIds]);
  useEffect(() => { pointerRef.current = pointer; }, [pointer]);
  useEffect(() => { if (technologyOpen) trackAnalyticsEvent("open_technology"); }, [technologyOpen]);
  useEffect(() => { if (recipesOpen) trackAnalyticsEvent("open_recipes"); }, [recipesOpen]);
  useEffect(() => { if (statisticsOpen) trackAnalyticsEvent("open_statistics"); }, [statisticsOpen]);
  useEffect(() => { if (starMapOpen) trackAnalyticsEvent("open_star_map"); }, [starMapOpen]);
  useEffect(() => { if (campaignOpen) trackAnalyticsEvent("open_campaign"); }, [campaignOpen]);
  useEffect(() => {
    if (constructionCenterOpen && (technologyOpen || statisticsOpen || recipesOpen || starMapOpen || blueprintsOpen || dysonPlannerOpen || operationsOpen || campaignOpen || galaxyOpen)) {
      setConstructionCenterOpen(false);
    }
  }, [blueprintsOpen, campaignOpen, constructionCenterOpen, dysonPlannerOpen, galaxyOpen, operationsOpen, recipesOpen, starMapOpen, statisticsOpen, technologyOpen]);
  useEffect(() => {
    const bridge = getDesktopBridge();
    if (!bridge) return;
    let active = true;
    void bridge.getReleaseInfo().then((info) => { if (active) setDesktopRelease(info); }).catch(() => undefined);
    const unsubscribe = bridge.onUpdateStatus((update) => {
      if (!active) return;
      setDesktopRelease((current) => current ? { ...current, update } : current);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  useEffect(() => {
    const bridge = getDesktopBridge();
    const root = document.documentElement;
    root.dataset.uiFontScale = String(Math.round(game.settings.fontScale * 100));
    if (bridge && typeof bridge.setFontScale === "function") {
      root.dataset.nativeUiScale = "true";
      root.style.removeProperty("--ui-font-scale");
      void bridge.setFontScale(game.settings.fontScale).catch(() => undefined);
      return;
    }
    delete root.dataset.nativeUiScale;
    root.style.setProperty("--ui-font-scale", String(game.settings.fontScale));
  }, [game.settings.fontScale]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Control") {
        const held = event.type === "keydown";
        ctrlHeldRef.current = held;
        setCtrlHeld(held);
        if (!held) {
          continuousPlacementRef.current = null;
          if (placement) setPlacement(null);
        }
      }
    };
    const onBlur = () => {
      ctrlHeldRef.current = false;
      setCtrlHeld(false);
      continuousPlacementRef.current = null;
      if (placement) setPlacement(null);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("blur", onBlur);
    };
  }, [placement]);
  useEffect(() => {
    if (!loaded.recovery || loaded.recovery.source === "primary") return;
    setNotice(loaded.recovery.issues[0] ?? "已从备用存档恢复");
  }, [loaded.recovery]);

  const playTone = useCallback((kind: InteractionSound, force = false) => {
    if (!force && !gameRef.current.settings.soundEnabled) return;
    const context = audioContextRef.current ?? new AudioContext();
    audioContextRef.current = context;
    if (context.state === "suspended") void context.resume();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const profile: Record<InteractionSound, { frequency: number; target: number; duration: number; type: OscillatorType; gain: number }> = {
      confirm: { frequency: 560, target: 640, duration: 0.18, type: "sine", gain: 0.05 },
      complete: { frequency: 780, target: 1040, duration: 0.22, type: "sine", gain: 0.055 },
      alert: { frequency: 310, target: 250, duration: 0.24, type: "triangle", gain: 0.05 },
      place: { frequency: 210, target: 360, duration: 0.12, type: "square", gain: 0.032 },
      connect: { frequency: 420, target: 720, duration: 0.16, type: "sine", gain: 0.05 },
      upgrade: { frequency: 480, target: 920, duration: 0.24, type: "triangle", gain: 0.045 },
      remove: { frequency: 360, target: 150, duration: 0.16, type: "sawtooth", gain: 0.026 },
      travel: { frequency: 180, target: 620, duration: 0.42, type: "sine", gain: 0.045 },
      launch: { frequency: 130, target: 880, duration: 0.34, type: "sawtooth", gain: 0.035 },
    };
    const sound = profile[kind];
    const frequency = sound.frequency;
    oscillator.type = sound.type;
    oscillator.frequency.setValueAtTime(frequency, context.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(sound.target, context.currentTime + sound.duration * 0.78);
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(sound.gain, context.currentTime + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + sound.duration);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + sound.duration + 0.02);
  }, []);

  const persistPrimarySave = useCallback((state: GameState = gameRef.current): SaveGameResult => {
    const result = saveGame(state);
    setSaveFailure(result.success ? null : result);
    return result;
  }, []);

  const togglePause = useCallback(() => {
    const wasPaused = gameRef.current.paused;
    setGame((current) => setPaused(current, !current.paused));
    setNotice(wasPaused ? "模拟已继续" : "模拟已暂停");
  }, []);

  const openCommandPalette = useCallback(() => {
    if (nextMobileShell) mobileNavigation.openModal("command");
    setCommandPaletteOpen(true);
  }, [mobileNavigation.openModal, nextMobileShell]);

  const closeCommandPalette = useCallback(() => {
    setCommandPaletteOpen(false);
    if (nextMobileShell && mobileNavigation.overlay?.kind === "modal" && mobileNavigation.overlay.id === "command") {
      mobileNavigation.requestBack();
    }
  }, [mobileNavigation.overlay, mobileNavigation.requestBack, nextMobileShell]);

  const returnToMenuSafely = useCallback(() => {
    const result = persistPrimarySave();
    if (!result.success) {
      setNotice(result.message);
      playTone("alert");
      return;
    }
    onReturnToMenu();
  }, [onReturnToMenu, persistPrimarySave, playTone]);

  const spawnInteractionBurst = useCallback((x: number, y: number, label: string, tone: InteractionBurst["tone"] = "positive") => {
    const id = burstSequenceRef.current + 1;
    burstSequenceRef.current = id;
    setInteractionBursts((current) => [...current, { id, x, y, label, tone }].slice(-6));
    window.setTimeout(() => setInteractionBursts((current) => current.filter((burst) => burst.id !== id)), 900);
    if ("vibrate" in navigator && typeof navigator.vibrate === "function") navigator.vibrate(tone === "warning" ? [12, 18, 12] : 10);
  }, []);

  const commitGame = useCallback((updater: (current: GameState) => GameState) => {
    setGame((current) => {
      const next = updater(current);
      if (next === current) return current;
      undoStackRef.current.push(current);
      if (undoStackRef.current.length > HISTORY_LIMIT) undoStackRef.current.shift();
      redoStackRef.current = [];
      setHistoryRevision((revision) => revision + 1);
      // Keep imperative canvas handlers in the same state revision as React.
      // Without this, a second belt drag in the same frame can validate
      // against stale construction stock and report a connection that the
      // simulation subsequently rejects.
      gameRef.current = next;
      return next;
    });
  }, []);

  const persistPlanetViewport = useCallback((planetId: PlanetId, viewport: CanvasViewport) => {
    const normalized = {
      x: Math.round(viewport.x * 100) / 100,
      y: Math.round(viewport.y * 100) / 100,
      zoom: Math.max(0.25, Math.min(1.8, Math.round(viewport.zoom * 1000) / 1000)),
    };
    setGame((current) => {
      const previous = current.planetViewports[planetId];
      if (previous && previous.x === normalized.x && previous.y === normalized.y && previous.zoom === normalized.zoom) return current;
      const next = { ...current, planetViewports: { ...current.planetViewports, [planetId]: normalized } };
      gameRef.current = next;
      return next;
    });
  }, []);

  const undoGame = useCallback(() => {
    setGame((current) => {
      const previous = undoStackRef.current.pop();
      if (!previous) return current;
      redoStackRef.current.push(current);
      setHistoryRevision((revision) => revision + 1);
      setNotice("已撤销上一步工厂操作");
      return previous;
    });
  }, []);

  const redoGame = useCallback(() => {
    setGame((current) => {
      const next = redoStackRef.current.pop();
      if (!next) return current;
      undoStackRef.current.push(current);
      setHistoryRevision((revision) => revision + 1);
      setNotice("已重做工厂操作");
      return next;
    });
  }, []);

  const clearHistory = useCallback(() => {
    undoStackRef.current = [];
    redoStackRef.current = [];
    setHistoryRevision((revision) => revision + 1);
  }, []);

  useEffect(() => {
    if (typeof Worker === "undefined") {
      simulationWorkerDisabledRef.current = true;
      return;
    }
    const worker = new Worker(new URL("./game/simulation.worker.ts", import.meta.url), { type: "module", name: "factory-simulation" });
    simulationWorkerRef.current = worker;
    setSimulationWorkerActive(true);
    worker.onmessage = (event: MessageEvent<SimulationWorkerResponse>) => {
      const submission = simulationSubmissionRef.current;
      if (!submission || event.data.id !== submission.id) return;
      simulationSubmissionRef.current = null;
      setGame((current) => {
        if (current !== submission.state) {
          simulationPendingSecondsRef.current += submission.seconds;
          return current;
        }
        if (!event.data.changed) return current;
        gameRef.current = event.data.state;
        return event.data.state;
      });
    };
    worker.onerror = () => {
      const submission = simulationSubmissionRef.current;
      if (submission) simulationPendingSecondsRef.current += submission.seconds;
      simulationSubmissionRef.current = null;
      simulationWorkerDisabledRef.current = true;
      simulationWorkerRef.current = null;
      setSimulationWorkerActive(false);
      worker.terminate();
    };
    return () => {
      worker.terminate();
      simulationWorkerRef.current = null;
      simulationSubmissionRef.current = null;
    };
  }, []);

  useEffect(() => {
    let previous = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      const seconds = Math.max(0, (now - previous) / 1000) * game.settings.simulationSpeed;
      previous = now;
      simulationPendingSecondsRef.current += seconds;
      const worker = simulationWorkerRef.current;
      if (worker && !simulationWorkerDisabledRef.current) {
        if (simulationSubmissionRef.current) return;
        const simulationSeconds = simulationPendingSecondsRef.current;
        simulationPendingSecondsRef.current = 0;
        const request: SimulationWorkerRequest = {
          id: simulationRequestIdRef.current + 1,
          state: gameRef.current,
          seconds: simulationSeconds,
        };
        simulationRequestIdRef.current = request.id;
        simulationSubmissionRef.current = request;
        try {
          worker.postMessage(request);
        } catch {
          simulationSubmissionRef.current = null;
          simulationWorkerDisabledRef.current = true;
          simulationWorkerRef.current = null;
          setSimulationWorkerActive(false);
          worker.terminate();
          setGame((current) => advanceSimulation(current, simulationSeconds));
        }
        return;
      }
      const simulationSeconds = simulationPendingSecondsRef.current;
      simulationPendingSecondsRef.current = 0;
      setGame((current) => advanceSimulation(current, simulationSeconds));
    }, game.settings.performanceMode ? 750 : mobileSimulationConstrained ? 750 : coarsePointer ? 500 : 100);
    return () => window.clearInterval(timer);
  }, [coarsePointer, game.settings.performanceMode, game.settings.simulationSpeed, mobileSimulationConstrained]);

  useEffect(() => {
    const timer = window.setInterval(() => persistPrimarySave(), game.settings.autosaveIntervalSeconds * 1000);
    const saveNow = () => persistPrimarySave();
    const saveBeforeUnload = () => { saveGame(gameRef.current); };
    const saveWhenHidden = () => { if (document.visibilityState === "hidden") saveNow(); };
    window.addEventListener("beforeunload", saveBeforeUnload);
    window.addEventListener("pagehide", saveBeforeUnload);
    document.addEventListener("visibilitychange", saveWhenHidden);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("beforeunload", saveBeforeUnload);
      window.removeEventListener("pagehide", saveBeforeUnload);
      document.removeEventListener("visibilitychange", saveWhenHidden);
      saveGame(gameRef.current);
    };
  }, [game.settings.autosaveIntervalSeconds, persistPrimarySave]);

  useEffect(() => {
    let active = true;
    let syncing = false;
    const synchronizeMainSave = async () => {
      if (syncing || !getCloudToken()) return;
      syncing = true;
      const attemptedAt = Date.now();
      let syncUserId = readCloudAutoSyncStatus()?.userId ?? null;
      let syncRevision: number | null = null;
      try {
        const session = await resumeCloudSession();
        if (session.status !== "authenticated" || !session.user) return;
        syncUserId = session.user.id;
        syncRevision = session.cloudSave?.revision ?? null;
        if (!session.user.emailVerified) {
          writeCloudAutoSyncStatus({ userId: session.user.id, state: "skipped", attemptedAt, uploadedAt: null, revision: session.cloudSave?.revision ?? null, message: "邮箱尚未验证，未上传" });
          return;
        }
        const payload = exportGame(gameRef.current);
        const comparison = compareCloudSave(session.user.id, payload, session.cloudSave, "main");
        if (session.cloudSave && ["cloud-newer", "conflict", "unbound"].includes(comparison.state)) {
          writeCloudAutoSyncStatus({ userId: session.user.id, state: "conflict", attemptedAt, uploadedAt: null, revision: session.cloudSave.revision, message: "检测到版本冲突，等待玩家选择" });
          if (active) setNotice("自动云同步已暂停：本地与云端存档需要手动选择版本");
          return;
        }
        if (comparison.state === "synced") {
          writeCloudAutoSyncStatus({ userId: session.user.id, state: "skipped", attemptedAt, uploadedAt: session.cloudSave?.updatedAt ?? null, revision: session.cloudSave?.revision ?? null, message: "本地与云端已一致" });
          return;
        }
        const cloudSave = await uploadCloudSave(payload, session.cloudSave?.revision ?? 0, "main");
        markCloudSaveSynchronized(session.user.id, cloudSave, payload, "main");
        writeCloudAutoSyncStatus({ userId: session.user.id, state: "success", attemptedAt, uploadedAt: cloudSave.updatedAt, revision: cloudSave.revision, message: "主存档自动上传成功" });
        if (active) setNotice(`主存档已自动同步到云端修订 ${cloudSave.revision}`);
      } catch (error) {
        const conflict = error instanceof CloudApiError && error.status === 409;
        if (syncUserId) writeCloudAutoSyncStatus({
          userId: syncUserId,
          state: conflict ? "conflict" : "error",
          attemptedAt,
          uploadedAt: null,
          revision: syncRevision,
          message: conflict ? "云端已有新版本，等待玩家选择" : error instanceof Error ? error.message : "自动同步失败",
        });
        if (active && conflict) setNotice("自动云同步已暂停：云端已有更新版本");
      } finally {
        syncing = false;
      }
    };
    const timer = window.setInterval(() => void synchronizeMainSave(), CLOUD_AUTO_SYNC_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const syncAccount = () => {
      const current = accountStateRef.current;
      const next = recordAccountProgress(current, gameRef.current);
      if (next === current) return;
      accountStateRef.current = next;
      saveAccountState(next);
      setAccountState(next);
    };
    syncAccount();
    const timer = window.setInterval(syncAccount, 2_000);
    window.addEventListener("beforeunload", syncAccount);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("beforeunload", syncAccount);
      syncAccount();
    };
  }, []);

  useEffect(() => () => { if (audioContextRef.current) void audioContextRef.current.close(); }, []);

  useEffect(() => {
    const updatePointer = (event: PointerEvent | DragEvent) => setPointer({ x: event.clientX, y: event.clientY });
    window.addEventListener("pointermove", updatePointer);
    window.addEventListener("dragover", updatePointer);
    return () => {
      window.removeEventListener("pointermove", updatePointer);
      window.removeEventListener("dragover", updatePointer);
    };
  }, []);

  useEffect(() => {
    if (!notice) return;
    const id = eventSequenceRef.current + 1;
    eventSequenceRef.current = id;
    setEventHistory((current) => [...current, { id, text: notice }].slice(-4));
    const timer = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (eventHistory.length === 0) return;
    const timer = window.setTimeout(() => setEventHistory((current) => current.slice(1)), 7_500);
    return () => window.clearTimeout(timer);
  }, [eventHistory]);

  useEffect(() => {
    const count = game.research.completedTechIds.length;
    if (count > completedTechCountRef.current) {
      const technology = getTechnology(game.research.completedTechIds.at(-1));
      if (technology) {
        const rewards = getTechnologyConstructionRewards(technology.id);
        const rewardLabel = rewards.length > 0
          ? ` · 获得${rewards.map((constructionId) => `${getConstructionDefinition(constructionId)?.name ?? constructionId}×2`).join("、")}`
          : "";
        setNotice(`${technology.name}研究完成${rewardLabel}`);
        playTone("complete");
      }
    }
    completedTechCountRef.current = count;
  }, [game.research.completedTechIds, playTone]);

  useEffect(() => {
    if (getNewAchievementIds(game).length === 0) return;
    setGame((current) => unlockAchievements(current).state);
  }, [game]);

  useEffect(() => {
    const count = game.achievements.unlockedIds.length;
    if (count > achievementCountRef.current) {
      const achievement = getAchievement(game.achievements.unlockedIds.at(-1));
      if (achievement) setNotice(`成就解锁：${achievement.name}`);
      playTone("complete");
    }
    achievementCountRef.current = count;
  }, [game.achievements.unlockedIds, playTone]);

  useEffect(() => {
    const synced = syncCampaignProgress(game);
    if (synced !== game) setGame(synced);
  }, [game]);

  useEffect(() => {
    const completed = game.campaign.completedTaskIds;
    if (completed.length > campaignCompletedCountRef.current) {
      const task = getCampaignTask(completed.at(-1));
      if (task) {
        setNotice(`任务完成：${task.title}`);
        setRewardFlights((task.rewards ?? []).map((reward, index) => {
          const item = reward.itemId ? ITEMS[reward.itemId] : null;
          const construction = reward.constructionId ? getConstructionDefinition(reward.constructionId) : null;
          return {
            id: `${task.id}_${index}_${completed.length}`,
            symbol: item?.symbol ?? "建",
            label: item?.name ?? construction?.name ?? "任务奖励",
            amount: reward.amount,
            color: item?.color ?? "#d7b85d",
          };
        }));
        playTone("complete");
      }
    }
    campaignCompletedCountRef.current = completed.length;
  }, [game.campaign.completedTaskIds, playTone]);

  useEffect(() => {
    if (rewardFlights.length === 0) return;
    const timer = window.setTimeout(() => setRewardFlights([]), 1500);
    return () => window.clearTimeout(timer);
  }, [rewardFlights]);

  useEffect(() => {
    const current = { sails: game.dysonSwarm.totalLaunched, rockets: game.dysonSphere.totalRocketsLaunched };
    if (current.sails > launchCountRef.current.sails || current.rockets > launchCountRef.current.rockets) playTone("launch");
    launchCountRef.current = current;
  }, [game.dysonSphere.totalRocketsLaunched, game.dysonSwarm.totalLaunched, playTone]);

  useEffect(() => {
    if (!planetTransition) return;
    const timer = window.setTimeout(() => setPlanetTransition(null), 760);
    return () => window.clearTimeout(timer);
  }, [planetTransition]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement || Boolean(target?.isContentEditable);
      const commandKey = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (commandPaletteOpen && event.key === "Escape") {
        event.preventDefault();
        closeCommandPalette();
      } else if (nextMobileShell && event.key === "Escape" && (mobileNavigation.overlay || mobileNavigation.route.kind !== "factory")) {
        event.preventDefault();
        mobileNavigation.requestBack();
      } else if (!editing && commandKey && key === "k") {
        event.preventDefault();
        if (commandPaletteOpen) closeCommandPalette();
        else openCommandPalette();
      } else if (!editing && commandKey && key === "z") {
        event.preventDefault();
        if (event.shiftKey) redoGame();
        else undoGame();
      } else if (!editing && commandKey && key === "y") {
        event.preventDefault();
        redoGame();
      } else if (event.key === "Escape") {
        flowStore.getState().cancelConnection();
        flowStore.setState({ connectionClickStartHandle: null });
        clickConnectionPreviewRef.current = null;
        clickConnectionSucceededRef.current = false;
        setClickConnectionPreview(null);
        setClickConnectionTone("pending");
        setClickConnectionSnapPoint(null);
        updateConnectionDraft(null);
        setConnectionHint(null);
        setPlacement(null);
        setTechnologyOpen(false);
        setStatisticsOpen(false);
        setRecipesOpen(false);
        setStarMapOpen(false);
        setBlueprintsOpen(false);
        setDysonPlannerOpen(false);
        setOperationsOpen(false);
        setCampaignOpen(false);
        setGalaxyOpen(false);
        setConstructionCenterOpen(false);
        setCampaignFocusItemId(null);
        setCampaignFocusTechId(null);
        setOfflineReport(null);
        setBlueprintPlacementId(null);
        setSelectionMode(false);
        setRegionMode(false);
        setRegionDraft(null);
        setRegionResizePreview(null);
        setSelectedRegionId(null);
        regionPointerRef.current = null;
        regionResizeRef.current = null;
        setMobileActionEntityId(null);
        setSelectedEntityIds([]);
        setSelectedBeltId(null);
        setSelectedBeltIds([]);
        setGame((current) => dropCargoToTray(current));
      } else if (!editing && !document.querySelector('[role="dialog"]') && (event.code === "Space" || key === "p")) {
        event.preventDefault();
        setGame((current) => setPaused(current, !current.paused));
        setNotice(gameRef.current.paused ? "模拟已继续" : "模拟已暂停");
      } else if (event.key === "Delete" && !editing && !document.querySelector('[role="dialog"]')) {
        const entityIds = selectedEntityIdsRef.current.filter((entityId) =>
          gameRef.current.entities.some((entity) => entity.id === entityId && (entity.kind !== "vein" || entity.minerCount > 0)));
        const beltIds = [...new Set([...selectedBeltIdsRef.current, ...(selectedBeltIdRef.current ? [selectedBeltIdRef.current] : [])])];
        if (entityIds.length > 0 || beltIds.length > 0) {
          event.preventDefault();
          commitGame((current) => beltIds.reduce((next, beltId) => removeBelt(next, beltId), removeEntities(current, entityIds)));
          setSelectedEntityIds([]);
          setSelectedBeltId(null);
          setSelectedBeltIds([]);
          setNotice(`已回收 ${entityIds.length} 个设备与 ${beltIds.length} 条运输线`);
          playTone("remove");
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeCommandPalette, commandPaletteOpen, commitGame, flowStore, mobileNavigation.overlay, mobileNavigation.requestBack, mobileNavigation.route.kind, nextMobileShell, openCommandPalette, playTone, redoGame, undoGame]);

  // Move keyboard focus into a newly opened workspace so keyboard and screen
  // reader users do not remain behind a modal overlay.
  useEffect(() => {
    if (!technologyOpen && !statisticsOpen && !recipesOpen && !starMapOpen && !blueprintsOpen &&
      !dysonPlannerOpen && !operationsOpen && !campaignOpen && !galaxyOpen && !constructionCenterOpen && !offlineReport) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const timer = window.setTimeout(() => {
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
      if (!dialog) return;
      if (!dialog.hasAttribute("tabindex")) dialog.tabIndex = -1;
      dialog.focus({ preventScroll: true });
    }, 0);
    return () => {
      window.clearTimeout(timer);
      if (previous?.isConnected && !previous.closest('[role="dialog"]')) previous.focus({ preventScroll: true });
    };
  }, [blueprintsOpen, campaignOpen, constructionCenterOpen, dysonPlannerOpen, galaxyOpen, offlineReport, operationsOpen, recipesOpen, starMapOpen, statisticsOpen, technologyOpen]);

  const onMiningStop = useCallback(() => {
    if (miningTimerRef.current != null) window.clearInterval(miningTimerRef.current);
    miningTimerRef.current = null;
    setMiningEntityId(null);
  }, []);

  const onMiningStart = useCallback((entityId: string) => {
    if (miningTimerRef.current != null) window.clearInterval(miningTimerRef.current);
    setMiningEntityId(entityId);
    setGame((current) => manualMine(current, entityId, 1));
    miningTimerRef.current = window.setInterval(() => {
      setGame((current) => manualMine(current, entityId, 1));
    }, 320);
  }, []);

  useEffect(() => {
    window.addEventListener("pointerup", onMiningStop);
    window.addEventListener("pointercancel", onMiningStop);
    window.addEventListener("blur", onMiningStop);
    return () => {
      window.removeEventListener("pointerup", onMiningStop);
      window.removeEventListener("pointercancel", onMiningStop);
      window.removeEventListener("blur", onMiningStop);
      if (miningTimerRef.current != null) window.clearInterval(miningTimerRef.current);
    };
  }, [onMiningStop]);

  const onPickOutput = useCallback((entityId: string, itemId: ItemId) => {
    setGame((current) => pickFromEntity(current, entityId, itemId));
  }, []);

  const onPickInput = useCallback((entityId: string, itemId: ItemId) => {
    setGame((current) => pickFromEntityInput(current, entityId, itemId));
  }, []);

  const onDropCargo = useCallback((entityId: string) => {
    setGame((current) => dropCargoToEntity(current, entityId));
  }, []);

  const onDropDraggedItem = useCallback((
    targetEntityId: string,
    itemId: ItemId,
    sourceKind: DraggedItemSourceKind,
    sourceId?: string,
  ) => {
    setGame((current) => sourceKind === "node" && sourceId
      ? moveEntityOutputToEntity(current, sourceId, targetEntityId, itemId)
      : sourceKind === "node-input" && sourceId
        ? moveEntityInputToEntity(current, sourceId, targetEntityId, itemId)
        : moveTrayItemToEntity(current, targetEntityId, itemId));
  }, []);

  const expandEntityGroup = useCallback((entityId: string, requestedCount = 1, point?: { x: number; y: number }) => {
    const current = gameRef.current;
    const entity = current.entities.find((candidate) => candidate.id === entityId);
    if (!entity) return null;
    const constructionId = entity.kind === "vein" && entity.resourceId
      ? getExtractorBuildingId(entity.resourceId)
      : entity.buildingId;
    if (!constructionId) return null;
    const name = getBuilding(constructionId).name;
    const amount = Math.max(1, Math.floor(requestedCount));
    const next = addUnitToEntityGroup(current, entityId, amount);
    if (next === current) {
      setNotice(`施工托盘中没有足够的${name}（需要 ${amount} 台）`);
      playTone("alert");
      return null;
    }
    const nextEntity = next.entities.find((candidate) => candidate.id === entityId)!;
    const count = nextEntity.kind === "vein" ? nextEntity.minerCount : nextEntity.machineCount;
    commitGame((state) => addUnitToEntityGroup(state, entityId, amount));
    if (point) spawnInteractionBurst(point.x, point.y, `扩建 +${amount} · ×${count}`, "positive");
    playTone("place");
    return {
      constructionId,
      name,
      count,
      added: amount,
      planetId: nextEntity.planetId,
      remaining: next.construction[constructionId] ?? 0,
    };
  }, [commitGame, playTone, spawnInteractionBurst]);

  const expandPlacedEntity = useCallback((entityId: string, requestedCount: PlacementCount) => {
    const keepContinuous = ctrlHeldRef.current;
    const result = expandEntityGroup(entityId, keepContinuous ? 1 : requestedCount);
    if (!result) {
      continuousPlacementRef.current = null;
      setPlacement(null);
      return;
    }
    if (keepContinuous && result.remaining >= 1) {
      continuousPlacementRef.current = { entityId, buildingId: result.constructionId, planetId: result.planetId };
      setPlacement(result.constructionId);
      setPlacementCount(1);
      setNotice(`${result.name}已扩建至 ×${result.count} · Ctrl 连续扩建中`);
      return;
    }
    continuousPlacementRef.current = null;
    setPlacement(null);
    setNotice(`${result.name}已扩建至 ×${result.count}${keepContinuous ? " · 施工库存已用完" : ""}`);
  }, [expandEntityGroup]);

  const onInstallMiner = useCallback((entityId: string, count: PlacementCount) => {
    expandPlacedEntity(entityId, count);
  }, [expandPlacedEntity]);

  const onAddBuilding = useCallback((entityId: string, _buildingId: BuildingId, count: PlacementCount) => {
    expandPlacedEntity(entityId, count);
  }, [expandPlacedEntity]);

  const onRecipeChange = useCallback((entityId: string, recipeId: RecipeId) => {
    commitGame((current) => setEntityRecipe(current, entityId, recipeId));
  }, [commitGame]);

  const onRecipeFocusChange = useCallback((itemId: ItemId | null) => {
    commitGame((current) => setRecipeFocus(current, itemId));
  }, [commitGame]);

  const openRecipeFocus = useCallback((itemId?: ItemId) => {
    const focused = itemId ?? gameRef.current.recipeFocus.itemId;
    if (focused) setCampaignFocusItemId(focused);
    closeAllWorkspaces();
    setRecipesOpen(true);
    setMobilePanel(null);
    setNotice(null);
    mobileNavigation.openWorkspace("recipes");
  }, [closeAllWorkspaces, mobileNavigation.openWorkspace]);

  const onFuelChange = useCallback((entityId: string, itemId: ItemId) => {
    commitGame((current) => setFuelItem(current, entityId, itemId));
  }, [commitGame]);

  const onEnergyModeChange = useCallback((entityId: string, mode: EnergyMode) => {
    commitGame((current) => setEnergyMode(current, entityId, mode));
  }, [commitGame]);

  const onPowerGridChange = useCallback((entityId: string, gridId: PowerGridId) => {
    commitGame((current) => setEntityPowerGrid(current, entityId, gridId));
  }, [commitGame]);

  const onPowerPriorityChange = useCallback((entityId: string, priority: PowerPriority) => {
    commitGame((current) => setEntityPowerPriority(current, entityId, priority));
  }, [commitGame]);

  const onGenerationPriorityChange = useCallback((entityId: string, priority: PowerPriority) => {
    commitGame((current) => setEntityGenerationPriority(current, entityId, priority));
  }, [commitGame]);

  const onPlanetChange = useCallback((planetId: PlanetId) => {
    onMiningStop();
    const cargo = gameRef.current.cargo;
    const previousPlanetId = gameRef.current.activePlanetId;
    if (previousPlanetId === planetId) return;
    const leavingViewport = { ...viewportRef.current };
    const destinationViewport = gameRef.current.planetViewports[planetId] ?? { x: 510, y: 250, zoom: 0.84 };
    if (!gameRef.current.settings.reducedMotion) setPlanetTransition({ id: Date.now(), from: previousPlanetId, to: planetId });
    playTone("travel");
    setGame((current) => {
      const withViewport = {
        ...current,
        planetViewports: { ...current.planetViewports, [current.activePlanetId]: leavingViewport },
      };
      const next = setActivePlanet(withViewport, planetId);
      gameRef.current = next;
      return next;
    });
    setSelectedEntityIds([]);
    setSelectedBeltId(null);
    setSelectedBeltIds([]);
    setSelectedBeltIds([]);
    setFocusedBeltNetworkId(null);
    setPlacement(null);
    setBlueprintPlacementId(null);
    setRegionMode(false);
    setRegionDraft(null);
    setRegionResizePreview(null);
    setSelectedRegionId(null);
    regionPointerRef.current = null;
    regionResizeRef.current = null;
    setNodes([]);
    viewportRef.current = { ...destinationViewport };
    setViewportZoom(destinationViewport.zoom);
    setViewport(destinationViewport, { duration: gameRef.current.settings.reducedMotion ? 0 : 180 });
    if (cargo) {
      const titanium = cargo.itemId === "titanium_ore" || cargo.itemId === "titanium_ingot";
      setNotice(`${titanium ? "托钛天王" : "手提星际运输"}：${ITEMS[cargo.itemId].name} ×${cargo.amount} 已抵达${getPlanet(planetId).name}`);
    } else {
      setNotice(`已切换至${getPlanet(planetId).name}`);
    }
  }, [onMiningStop, playTone, setNodes, setViewport]);

  const onExploreSystem = useCallback((systemId: StarSystemId) => {
    setGame((current) => exploreStarSystem(current, systemId));
    setNotice("恒星勘探任务已启动，星图会显示实时进度");
  }, []);

  const onColonizePlanet = useCallback((planetId: PlanetId) => {
    const before = gameRef.current;
    const next = colonizePlanet(before, planetId);
    if (next === before) {
      setNotice("殖民补给不足，请查看行星前哨成本");
      return;
    }
    commitGame(() => next);
    setNotice(`${getPlanet(planetId).name} 前哨建立完成`);
    playTone("place");
  }, [commitGame, playTone]);

  const alerts = useMemo(() => getFactoryAlerts(game), [game]);
  const activePlanetEntityCount = useMemo(() => game.entities.filter((entity) => entity.planetId === game.activePlanetId).length, [game.activePlanetId, game.entities]);
  const automaticPerformanceMode = activePlanetEntityCount >= 300 || constrainedMobile || lowFrameRateMode;
  const performanceVisualMode = game.settings.performanceMode || automaticPerformanceMode;
  const largeFactoryMode = performanceVisualMode && (activePlanetEntityCount >= 150 || constrainedMobile);

  const updateSettings = useCallback((settings: Partial<GameSettings>) => {
    setGame((current) => ({ ...current, settings: { ...current.settings, ...settings } }));
    if (settings.soundEnabled === true) playTone("confirm", true);
  }, [playTone]);

  const updateGalaxyProfile = useCallback((changes: AccountProfileChanges) => {
    const current = accountStateRef.current;
    const active = getActiveAccount(current);
    if (changes.privacy === "private") removeLeaderboardData(active.profile.id);
    const next = updateAccountProfile(current, changes);
    accountStateRef.current = next;
    setAccountState(next);
  }, []);

  const updateGalaxyCloudBinding = useCallback((cloud: { id: string; email: string } | null) => {
    const next = setActiveCloudBinding(accountStateRef.current, cloud);
    accountStateRef.current = next;
    setAccountState(next);
    setNotice(cloud ? "当前本地身份已绑定云账号" : "当前本地身份已解除云账号绑定");
  }, []);

  const createGalaxyAccount = useCallback((displayName: string) => {
    const synced = recordAccountProgress(accountStateRef.current, gameRef.current);
    saveAccountState(synced);
    const next = baselineAccountProgress(createLocalAccount(synced, displayName), gameRef.current);
    accountStateRef.current = next;
    setAccountState(next);
    playTone("confirm");
  }, [playTone]);

  const switchGalaxyAccount = useCallback((accountId: string) => {
    const current = accountStateRef.current;
    if (current.activeAccountId === accountId) return;
    const synced = recordAccountProgress(current, gameRef.current);
    saveAccountState(synced);
    const next = baselineAccountProgress(switchLocalAccount(synced, accountId), gameRef.current);
    accountStateRef.current = next;
    setAccountState(next);
  }, []);

  const uploadGalaxyData = useCallback((seasonId: string) => {
    const current = accountStateRef.current;
    const synced = recordAccountProgress(current, gameRef.current);
    if (synced !== current) {
      accountStateRef.current = synced;
      saveAccountState(synced);
      setAccountState(synced);
    }
    const active = getActiveAccount(synced);
    const submission = submitLeaderboardData(active.profile, active.ledger, seasonId);
    if (!submission) {
      playTone("alert");
      return false;
    }
    playTone("confirm");
    return true;
  }, [playTone]);

  const openCommandWorkspace = useCallback((workspace: CommandWorkspace) => {
    setCommandPaletteOpen(false);
    closeAllWorkspaces();
    setMobilePanel(null);
    if (workspace === "inspector" || workspace === "resources") {
      mobileNavigation.openSheet(workspace === "resources" ? "inventory" : "inspector");
      if (!nextMobileShell) setMobilePanel(workspace);
    } else if (workspace === "technology") {
      setTechnologyOpen(true);
      mobileNavigation.openWorkspace("technology");
    } else if (workspace === "statistics") {
      setStatisticsOpen(true);
      mobileNavigation.openWorkspace("statistics");
    } else if (workspace === "recipes") {
      setRecipesOpen(true);
      mobileNavigation.openWorkspace("recipes");
    } else if (workspace === "star-map") {
      setStarMapOpen(true);
      mobileNavigation.openWorkspace("star-map");
    } else if (workspace === "blueprints") {
      setBlueprintsOpen(true);
      mobileNavigation.openWorkspace("blueprints");
    } else if (workspace === "dyson") {
      setDysonPlannerOpen(true);
      mobileNavigation.openWorkspace("dyson");
    } else if (workspace === "campaign") {
      setCampaignOpen(true);
      mobileNavigation.openWorkspace("campaign");
    } else if (workspace === "operations") {
      setOperationsOpen(true);
      setOperationsTab("alerts");
      mobileNavigation.openWorkspace("operations");
    } else if (workspace === "galaxy") {
      setGalaxyOpen(true);
      mobileNavigation.openWorkspace("galaxy");
    }
  }, [closeAllWorkspaces, mobileNavigation.openSheet, mobileNavigation.openWorkspace, nextMobileShell]);

  const restoreGame = useCallback((state: GameState, report: OfflineReport | null = null) => {
    onMiningStop();
    gameRef.current = state;
    completedTechCountRef.current = state.research.completedTechIds.length;
    achievementCountRef.current = state.achievements.unlockedIds.length;
    campaignCompletedCountRef.current = state.campaign.completedTaskIds.length;
    launchCountRef.current = { sails: state.dysonSwarm.totalLaunched, rockets: state.dysonSphere.totalRocketsLaunched };
    setGame(state);
    setOfflineReport(report);
    setSelectedEntityIds([]);
    setSelectedBeltId(null);
    setFocusedBeltNetworkId(null);
    setPlacement(null);
    setBlueprintPlacementId(null);
    setSelectionMode(false);
    setRegionMode(false);
    setMobileCanvasMode("browse");
    setMobileContinuousPlacement(false);
    setRegionDraft(null);
    setRegionResizePreview(null);
    setSelectedRegionId(null);
    regionPointerRef.current = null;
    regionResizeRef.current = null;
    setNodes([]);
    setOperationsOpen(false);
    setCampaignOpen(false);
    setGalaxyOpen(false);
    setCampaignFocusItemId(null);
    setCampaignFocusTechId(null);
    setHighlightedTaskId(null);
    setEventHistory([]);
    setCommandPaletteOpen(false);
    clearHistory();
    const viewport = state.planetViewports[state.activePlanetId] ?? { x: 510, y: 250, zoom: 0.84 };
    viewportRef.current = { ...viewport };
    setViewportZoom(viewport.zoom);
    setViewport(viewport, { duration: state.settings.reducedMotion ? 0 : 180 });
  }, [clearHistory, onMiningStop, setNodes, setViewport]);

  const focusEntityIds = useCallback((entityIds: string[]) => {
    const selected = gameRef.current.entities.filter((entity) => entityIds.includes(entity.id));
    if (selected.length === 0) return;
    const center = selected.reduce((total, entity) => ({
      x: total.x + entity.position.x + 128,
      y: total.y + entity.position.y + 90,
    }), { x: 0, y: 0 });
    const duration = gameRef.current.settings.reducedMotion ? 0 : 260;
    setCenter(center.x / selected.length, center.y / selected.length, {
      zoom: selected.length === 1 ? 1.05 : selected.length <= 3 ? 0.85 : 0.65,
      duration,
    });
  }, [setCenter]);

  const focusPlacedEntity = useCallback((entityId: string) => {
    const entity = gameRef.current.entities.find((candidate) => candidate.id === entityId);
    if (!entity) return;
    if (gameRef.current.activePlanetId !== entity.planetId) onPlanetChange(entity.planetId);
    setSelectedEntityIds([entityId]);
    setSelectedBeltId(null);
    setSelectedBeltIds([]);
    setInspectorTab("inspect");
    setMobilePanel("inspector");
    window.setTimeout(() => focusEntityIds([entityId]), gameRef.current.settings.reducedMotion ? 0 : 50);
    setNotice(`已定位：${entity.buildingId ? getBuilding(entity.buildingId).name : entity.resourceId ? ITEMS[entity.resourceId].name : entity.id}`);
  }, [focusEntityIds, onPlanetChange]);

  const quickAddEntity = useCallback((entityId: string) => {
    const result = expandEntityGroup(entityId, 1);
    if (result) setNotice(`${result.name}已快速增加至 ×${result.count}`);
  }, [expandEntityGroup]);

  const autoLayoutEntities = useCallback((entityIds?: readonly string[]) => {
    const current = gameRef.current;
    const moves = planFactoryAutoLayout(current, current.activePlanetId, entityIds);
    if (moves.length === 0) {
      setNotice("当前范围没有可整理的生产设备");
      return;
    }
    const movedIds = new Set(moves.map((move) => move.id));
    setAutoLayoutUndo({
      planetId: current.activePlanetId,
      positions: current.entities
        .filter((entity) => movedIds.has(entity.id))
        .map((entity) => ({ id: entity.id, position: { ...entity.position } })),
    });
    const positionById = new Map(moves.map((move) => [move.id, move.position]));
    setNodes((currentNodes) => currentNodes.map((node) => {
      const position = positionById.get(node.id);
      return position ? { ...node, position } : node;
    }));
    commitGame((current) => moveEntities(current, moves));
    setNotice(`已按物流上下游整理 ${moves.length} 个设备`);
    window.requestAnimationFrame(() => void fitView({ padding: 0.2, duration: gameRef.current.settings.reducedMotion ? 0 : 280 }));
  }, [commitGame, fitView, setNodes]);

  const undoAutoLayout = useCallback(() => {
    if (!autoLayoutUndo || autoLayoutUndo.planetId !== gameRef.current.activePlanetId) return;
    const existingIds = new Set(gameRef.current.entities.map((entity) => entity.id));
    const positions = autoLayoutUndo.positions.filter((entry) => existingIds.has(entry.id));
    setAutoLayoutUndo(null);
    if (positions.length === 0) {
      setNotice("最近一次自动整理的设备已不存在");
      return;
    }
    const positionById = new Map(positions.map((entry) => [entry.id, entry.position]));
    setNodes((currentNodes) => currentNodes.map((node) => {
      const position = positionById.get(node.id);
      return position ? { ...node, position } : node;
    }));
    commitGame((current) => moveEntities(current, positions));
    setNotice(`已撤销最近一次自动整理 · 恢复 ${positions.length} 个设备`);
    window.requestAnimationFrame(() => void fitView({ padding: 0.2, duration: gameRef.current.settings.reducedMotion ? 0 : 280 }));
  }, [autoLayoutUndo, commitGame, fitView, setNodes]);

  const focusBeltNetwork = useCallback((beltId: string, planetId?: PlanetId) => {
    const snapshot = analyzeBeltNetwork(gameRef.current, beltId);
    if (!snapshot) return;
    const destination = planetId ?? snapshot.planetId;
    if (gameRef.current.activePlanetId !== destination) onPlanetChange(destination);
    setFocusedBeltNetworkId(beltId);
    setHighlightedTaskId(null);
    setSelectedBeltId(beltId);
    setSelectedBeltIds([beltId]);
    setSelectedEntityIds([]);
    setInspectorTab("inspect");
    setStatisticsOpen(false);
    setMobilePanel(null);
    window.setTimeout(() => focusEntityIds(snapshot.entityIds), gameRef.current.settings.reducedMotion ? 0 : 40);
  }, [focusEntityIds, onPlanetChange]);

  const openCanvasBookmark = useCallback((bookmark: CanvasBookmark) => {
    if (gameRef.current.activePlanetId !== bookmark.planetId) onPlanetChange(bookmark.planetId);
    setStatisticsOpen(false);
    setFocusedBeltNetworkId(null);
    setHighlightedTaskId(null);
    window.setTimeout(() => setViewport(bookmark.viewport, { duration: gameRef.current.settings.reducedMotion ? 0 : 260 }), gameRef.current.settings.reducedMotion ? 0 : 40);
    setNotice(`已打开画布书签：${bookmark.name}`);
  }, [onPlanetChange, setViewport]);

  const selectAlert = useCallback((alert: FactoryAlert) => {
    if (gameRef.current.activePlanetId !== alert.planetId) onPlanetChange(alert.planetId);
    setSelectedEntityIds([alert.entityId]);
    setSelectedBeltId(null);
    setSelectedBeltIds([]);
    setInspectorTab("inspect");
    setMobilePanel("inspector");
    setOperationsOpen(false);
    setCampaignOpen(false);
    setCampaignFocusItemId(null);
    setCampaignFocusTechId(null);
    focusEntityIds([alert.entityId]);
    setNotice(`已定位：${alert.title} · ${alert.reason}`);
    playTone("alert");
  }, [focusEntityIds, onPlanetChange, playTone]);

  const focusStellarStation = useCallback((entityId: string, planetId: PlanetId) => {
    if (gameRef.current.activePlanetId !== planetId) onPlanetChange(planetId);
    setSelectedEntityIds([entityId]);
    setSelectedBeltId(null);
    setSelectedBeltIds([]);
    setFocusedBeltNetworkId(null);
    setInspectorTab("inspect");
    setMobilePanel("inspector");
    setStarMapOpen(false);
    window.setTimeout(() => focusEntityIds([entityId]), gameRef.current.settings.reducedMotion ? 0 : 40);
    setNotice(`已定位星际物流问题：${getPlanet(planetId).name}`);
  }, [focusEntityIds, onPlanetChange]);

  const openCampaign = useCallback(() => {
    closeAllWorkspaces();
    setCampaignOpen(true);
    setMobilePanel(null);
    setPlacement(null);
    setBlueprintPlacementId(null);
    setSelectionMode(false);
    setSelectedEntityIds([]);
    setSelectedBeltId(null);
    setSelectedBeltIds([]);
    setNotice(null);
    mobileNavigation.openWorkspace("campaign");
  }, [closeAllWorkspaces, mobileNavigation.openWorkspace]);

  const navigateFromCampaign = useCallback((navigation: CampaignNavigation, taskId?: CampaignTaskId) => {
    if (taskId) {
      setHighlightedTaskId(taskId);
      setFocusedBeltNetworkId(null);
    }
    closeAllWorkspaces();
    setCampaignFocusItemId(null);
    setCampaignFocusTechId(null);
    setMobilePanel(null);
    setPlacement(null);
    setBlueprintPlacementId(null);
    setSelectionMode(false);
    setSelectedEntityIds([]);
    setSelectedBeltId(null);
    setSelectedBeltIds([]);
    if (navigation.kind === "recipe") {
      setCampaignFocusItemId(navigation.itemId);
      setRecipesOpen(true);
      setNotice(`已打开${ITEMS[navigation.itemId].name}配方`);
      return;
    }
    if (navigation.kind === "technology") {
      setCampaignFocusTechId(navigation.techId);
      setTechnologyOpen(true);
      setNotice(`已定位科技：${getTechnology(navigation.techId)?.name ?? "科研项目"}`);
      return;
    }
    if (navigation.kind === "planet") {
      if (!gameRef.current.exploration.unlockedSystemIds.includes(getPlanet(navigation.planetId).systemId)) {
        setStarMapOpen(true);
        setNotice(`${getPlanet(navigation.planetId).name}尚未解锁，请先完成恒星勘探`);
        return;
      }
      onPlanetChange(navigation.planetId);
      return;
    }
    if (navigation.kind === "system") {
      setStarMapOpen(true);
      setNotice(`已打开${getStarSystem(navigation.systemId).name}星图`);
      return;
    }
    if (navigation.kind === "dyson") {
      setDysonPlannerOpen(true);
      setNotice("已打开戴森球规划");
      return;
    }
    if (navigation.kind === "galactic") {
      setStatisticsFocusTab("galaxy");
      setStatisticsOpen(true);
      setNotice("已打开银河工业控制台");
      return;
    }
    if (navigation.kind === "construction") {
      setInspectorTab("fabricate");
      setMobilePanel("inspector");
      setNotice("请在施工托盘中选择传送带");
      return;
    }
    const entity = gameRef.current.entities.find((candidate) => candidate.buildingId === navigation.buildingId);
    if (entity) {
      if (gameRef.current.activePlanetId !== entity.planetId) onPlanetChange(entity.planetId);
      setSelectedEntityIds([entity.id]);
      setSelectedBeltId(null);
      setInspectorTab("inspect");
      setMobilePanel("inspector");
      window.setTimeout(() => focusEntityIds([entity.id]), 30);
      setNotice(`已定位：${getBuilding(navigation.buildingId).name}`);
      return;
    }
    setPlacement(navigation.buildingId);
    setInspectorTab("fabricate");
    setMobilePanel("inspector");
    setNotice(`施工托盘已切换到${getBuilding(navigation.buildingId).name}`);
  }, [closeAllWorkspaces, focusEntityIds, onPlanetChange]);

  const runOnboardingAction = useCallback((stepId: OnboardingStepId) => {
    closeAllWorkspaces();
    if (stepId === "research") {
      setTechnologyOpen(true);
      setNotice("选择一项可研究科技加入队列");
      return;
    }
    if (gameRef.current.activePlanetId !== "home") onPlanetChange("home");
    if (stepId === "mine") {
      setSelectedEntityIds(["vein_iron"]);
      window.setTimeout(() => focusEntityIds(["vein_iron"]), 40);
      setNotice("在铁矿脉上按住指针即可持续采矿");
      return;
    }
    if (stepId === "miner") {
      setPlacement("mining_machine");
      setSelectedEntityIds([]);
      window.setTimeout(() => focusEntityIds(["vein_iron"]), 40);
      setNotice("采矿机已选中，点击铁矿脉完成安装");
      return;
    }
    if (stepId === "smelter") {
      const smelter = gameRef.current.entities.find((entity) => entity.buildingId === "arc_smelter");
      if (smelter) focusPlacedEntity(smelter.id);
      else {
        setPlacement("arc_smelter");
        setNotice("熔炉开局已解锁，点击画布放置");
      }
      return;
    }
    if (stepId === "belt") {
      setPlacement(null);
      setBeltTierMode("auto");
      window.setTimeout(() => focusEntityIds(["vein_iron"]), 40);
      setNotice("点击物品输出端口，再点击绿色高亮输入端口建立传送带");
      return;
    }
    const step = getOnboardingStep(stepId);
    if (!step) return;
    const focusTarget = getOnboardingFocusTarget(gameRef.current, step);
    if (focusTarget?.kind === "belt") {
      focusBeltNetwork(focusTarget.id, focusTarget.planetId);
      setNotice(`教学卡点：${focusTarget.reason}`);
      return;
    }
    if (focusTarget?.kind === "entity") {
      if (step.campaignTaskId) setHighlightedTaskId(step.campaignTaskId);
      focusPlacedEntity(focusTarget.id);
      setNotice(`教学卡点：${focusTarget.reason}`);
      return;
    }
    if (step.navigation) {
      navigateFromCampaign(step.navigation, step.campaignTaskId);
      return;
    }
    openCampaign();
  }, [closeAllWorkspaces, focusBeltNetwork, focusEntityIds, focusPlacedEntity, navigateFromCampaign, onPlanetChange, openCampaign]);

  const onSelectCampaignTask = useCallback((taskId: CampaignTaskId) => {
    setGame((current) => selectCampaignTask(current, taskId));
    setHighlightedTaskId(taskId);
    setFocusedBeltNetworkId(null);
  }, []);

  const refreshSaveData = useCallback(() => {
    setSaveSlots(getSaveSlotSummaries());
    setSaveSnapshots(getSaveSnapshotSummaries());
  }, []);

  const manualSave = useCallback(() => {
    const result = persistPrimarySave();
    refreshSaveData();
    setNotice(result.message);
    playTone(result.success ? "confirm" : "alert");
  }, [persistPrimarySave, playTone, refreshSaveData]);

  const downloadSave = useCallback(() => {
    const blob = new Blob([exportGame(gameRef.current)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `dsp-idle-save-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setNotice("存档 JSON 已导出");
    playTone("confirm");
  }, [playTone]);

  const importSave = useCallback((raw: string) => {
    const inspection = inspectSave(raw);
    if (!inspection.valid || !inspection.state) {
      setNotice(`存档导入失败：${inspection.issues[0] ?? "文件格式或版本无效"}`);
      playTone("alert");
      return;
    }
    setImportPreview(inspection);
    setPendingImportState(inspection.state);
    setNotice(inspection.integrity === "valid" ? "已读取存档，请确认导入" : "存档可修复，请确认导入");
  }, [playTone]);

  const cancelImport = useCallback(() => {
    setImportPreview(null);
    setPendingImportState(null);
  }, []);

  const confirmImport = useCallback(() => {
    if (!pendingImportState) return;
    const result = persistPrimarySave(pendingImportState);
    if (!result.success) {
      setNotice(result.message);
      playTone("alert");
      return;
    }
    restoreGame(pendingImportState);
    refreshSaveData();
    setImportPreview(null);
    setPendingImportState(null);
    setNotice("存档导入完成，已自动创建回滚快照");
    playTone("complete");
  }, [pendingImportState, persistPrimarySave, playTone, refreshSaveData, restoreGame]);

  const restoreCloudSave = useCallback((raw: string): { success: boolean; message: string } => {
    const inspection = inspectSave(raw);
    if (!inspection.valid || !inspection.state) {
      playTone("alert");
      return { success: false, message: `云存档无效：${inspection.issues[0] ?? "格式或版本无法识别"}` };
    }
    saveGameSnapshot(gameRef.current, "恢复云存档前");
    const result = persistPrimarySave(inspection.state);
    if (!result.success) {
      playTone("alert");
      return { success: false, message: result.message };
    }
    restoreGame(inspection.state);
    refreshSaveData();
    playTone("complete");
    return { success: true, message: "云存档已恢复，原工厂已保留为本地快照" };
  }, [persistPrimarySave, playTone, refreshSaveData, restoreGame]);

  const saveToSlot = useCallback((slotId: SaveSlotId) => {
    saveGameSlot(slotId, gameRef.current);
    refreshSaveData();
    setNotice(`已保存到本地槽位 ${slotId}`);
    playTone("confirm");
  }, [playTone, refreshSaveData]);

  const loadFromSlot = useCallback((slotId: SaveSlotId) => {
    const slot = loadGameSlot(slotId);
    if (!slot) {
      setNotice(`槽位 ${slotId} 没有可用存档`);
      return;
    }
    const result = persistPrimarySave(slot.state);
    if (!result.success) {
      setNotice(result.message);
      playTone("alert");
      return;
    }
    restoreGame(slot.state, slot.offlineReport);
    refreshSaveData();
    setNotice(`已载入本地槽位 ${slotId}`);
    playTone("complete");
  }, [persistPrimarySave, playTone, refreshSaveData, restoreGame]);

  const deleteSlot = useCallback((slotId: SaveSlotId) => {
    clearGameSlot(slotId);
    refreshSaveData();
    setNotice(`本地槽位 ${slotId} 已清空`);
  }, [refreshSaveData]);

  const createSnapshot = useCallback(() => {
    const snapshot = saveGameSnapshot(gameRef.current, "手动快照");
    refreshSaveData();
    setNotice(snapshot ? "手动快照已创建" : "快照创建失败：本地存储空间不足");
    playTone(snapshot ? "confirm" : "alert");
  }, [playTone, refreshSaveData]);

  const loadSnapshot = useCallback((snapshotId: string) => {
    const state = loadSaveSnapshot(snapshotId);
    if (!state) {
      setNotice("快照不可用，可能已损坏");
      playTone("alert");
      return;
    }
    const result = persistPrimarySave(state);
    if (!result.success) {
      setNotice(result.message);
      playTone("alert");
      return;
    }
    restoreGame(state);
    refreshSaveData();
    setNotice("已回滚到自动快照");
    playTone("complete");
  }, [persistPrimarySave, playTone, refreshSaveData, restoreGame]);

  const deleteSnapshot = useCallback((snapshotId: string) => {
    clearSaveSnapshot(snapshotId);
    refreshSaveData();
    setNotice("自动快照已删除");
  }, [refreshSaveData]);

  const runBenchmark = useCallback(() => {
    const report = runAutomaticPerformanceReport(gameRef.current);
    setPerformanceReport(report);
    const passed = report.benchmark.deterministic && report.idleStress.completed && report.idleStress.integrityPassed;
    setNotice(`自动性能报告${passed ? "通过" : "发现异常"} · 60 秒 ${report.benchmark.durationMs}ms · ${report.idleStress.simulatedHours}h 压测 ${report.idleStress.durationMs}ms`);
    playTone(passed ? "confirm" : "alert");
  }, [playTone]);

  const checkDesktopUpdate = useCallback(async () => {
    const bridge = getDesktopBridge();
    if (!bridge) return;
    const update = await bridge.checkForUpdates().catch(() => null);
    if (!update) {
      setNotice("桌面更新检查失败");
      playTone("alert");
      return;
    }
    setDesktopRelease((current) => current ? { ...current, update } : current);
    setNotice(update.message);
    playTone(update.state === "error" ? "alert" : "confirm");
  }, [playTone]);

  const installDesktopUpdate = useCallback(async () => {
    const bridge = getDesktopBridge();
    if (!bridge) return;
    const result = await bridge.installUpdate().catch(() => ({ accepted: false }));
    setNotice(result.accepted ? "正在重启并安装桌面更新" : "当前没有已下载的桌面更新");
    playTone(result.accepted ? "complete" : "alert");
  }, [playTone]);

  const validateMod = useCallback((raw: string) => {
    const result = parseContentPack(raw, getContentPackValidationContext(contentPackRegistry));
    setModValidation(result);
    setNotice(result.valid ? "内容包校验通过" : `内容包校验失败：${result.issues.find((issue) => issue.severity === "error")?.message ?? "请检查定义"}`);
    playTone(result.valid ? "confirm" : "alert");
  }, [contentPackRegistry, playTone]);

  const applyRegisteredContentPacks = useCallback((registry: ContentPackRegistry) => {
    const report = applyContentPackRegistry(registry);
    saveContentPackRegistry(registry);
    setContentPackRegistry(registry);
    // Re-render catalog-driven panels after the live registry changes.
    setGame((current) => ({ ...current }));
    return report;
  }, []);

  const registerValidatedContentPack = useCallback(() => {
    if (!modValidation?.valid || !modValidation.manifest) {
      setNotice("请先选择并校验内容包 JSON");
      playTone("alert");
      return;
    }
    const existing = contentPackRegistry.packs[modValidation.manifest.id];
    if (existing) {
      const usage = getContentPackUsage(gameRef.current, existing.manifest);
      if (usage.total > 0) {
        setNotice(`无法更新内容包：当前存档仍在使用${usage.entries.join("、")}`);
        playTone("alert");
        return;
      }
    }
    const result = registerContentPack(contentPackRegistry, modValidation, true);
    if (result.registry === contentPackRegistry) {
      setNotice(`内容包未注册：${result.reason ?? "定义冲突"}`);
      playTone("alert");
      return;
    }
    const report = applyRegisteredContentPacks(result.registry);
    setNotice(result.enabled
      ? `内容包已注册并启用：${modValidation.manifest.name}`
      : `内容包已注册，等待依赖：${result.reason ?? "未满足"}`);
    playTone(result.enabled && report.catalogValid ? "complete" : "alert");
  }, [applyRegisteredContentPacks, contentPackRegistry, modValidation, playTone]);

  const toggleRegisteredContentPack = useCallback((packId: string, enabled: boolean) => {
    const pack = contentPackRegistry.packs[packId];
    if (!pack) return;
    if (!enabled) {
      const usage = getContentPackUsage(gameRef.current, pack.manifest);
      if (usage.total > 0) {
        setNotice(`不能停用${pack.manifest.name}：当前存档仍在使用${usage.entries.join("、")}`);
        playTone("alert");
        return;
      }
    }
    const result = setContentPackEnabled(contentPackRegistry, packId, enabled);
    if (!result.changed) {
      setNotice(`内容包状态未改变：${result.reason ?? "无需操作"}`);
      if (result.reason) playTone("alert");
      return;
    }
    const report = applyRegisteredContentPacks(result.registry);
    setNotice(`${pack.manifest.name}已${enabled ? "启用" : "停用"}${report.catalogValid ? "" : "，目录存在校验问题"}`);
    playTone(enabled && report.catalogValid ? "confirm" : "alert");
  }, [applyRegisteredContentPacks, contentPackRegistry, playTone]);

  const removeRegisteredContentPack = useCallback((packId: string) => {
    const pack = contentPackRegistry.packs[packId];
    if (!pack) return;
    const usage = getContentPackUsage(gameRef.current, pack.manifest);
    if (usage.total > 0) {
      setNotice(`不能移除${pack.manifest.name}：当前存档仍在使用${usage.entries.join("、")}`);
      playTone("alert");
      return;
    }
    const result = removeContentPack(contentPackRegistry, packId);
    if (!result.changed) {
      setNotice(`内容包未移除：${result.reason ?? "无需操作"}`);
      if (result.reason) playTone("alert");
      return;
    }
    applyRegisteredContentPacks(result.registry);
    setNotice(`内容包已移除：${pack.manifest.name}`);
    playTone("remove");
  }, [applyRegisteredContentPacks, contentPackRegistry, playTone]);

  const downloadModTemplate = useCallback(() => {
    const blob = new Blob([JSON.stringify(createContentPackTemplate(), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "dsp-content-pack-template.json";
    anchor.click();
    URL.revokeObjectURL(url);
    setNotice("内容包模板已导出");
    playTone("confirm");
  }, [playTone]);

  const downloadBlueprint = useCallback((blueprintId: string) => {
    const blueprint = gameRef.current.blueprints.find((candidate) => candidate.id === blueprintId);
    if (!blueprint) return;
    const blob = new Blob([serializeBlueprintExchange(blueprint)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${blueprint.name.replace(/[\\/:*?"<>|]/g, "-").slice(0, 40) || "dsp-blueprint"}.dspblueprint.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setNotice(`蓝图已导出：${blueprint.name}`);
    playTone("confirm");
  }, [playTone]);

  const importBlueprint = useCallback((raw: string) => {
    const result = parseBlueprintExchange(raw);
    if (!result.valid || !result.blueprint) {
      const message = `蓝图导入失败：${result.issues[0] ?? "格式无效"}`;
      setNotice(message);
      playTone("alert");
      return { success: false, message };
    }
    const importedName = result.blueprint.name;
    commitGame((current) => importBlueprintExchange(current, result.blueprint!));
    const message = `已导入蓝图：${importedName}`;
    setNotice(message);
    playTone("complete");
    return { success: true, message };
  }, [commitGame, playTone]);

  useEffect(() => {
    const timer = window.setInterval(refreshSaveData, coarsePointer ? 30_000 : 5_000);
    return () => window.clearInterval(timer);
  }, [coarsePointer, refreshSaveData]);

  useEffect(() => {
    if (!connectionHint || connectionDraft) return;
    const timer = window.setTimeout(() => setConnectionHint(null), 1800);
    return () => window.clearTimeout(timer);
  }, [connectionDraft, connectionHint]);

  useEffect(() => {
    if (!placement && !blueprintPlacementId) return;
    let frame = 0;
    const edgePan = () => {
      const canvas = factoryCanvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const point = pointerRef.current;
      const margin = Math.min(72, rect.width * 0.16, rect.height * 0.16);
      const inside = point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
      const hovered = document.elementFromPoint(point.x, point.y);
      const overCanvasUi = hovered instanceof Element && Boolean(hovered.closest(".canvas-selection-tools, .selection-toolbar, .planet-navigator, .react-flow__controls, .react-flow__minimap, .canvas-minimap-toggle, .task-path-indicator"));
      let dx = 0;
      let dy = 0;
      if (inside && !overCanvasUi) {
        if (point.x < rect.left + margin) dx = 4;
        else if (point.x > rect.right - margin) dx = -4;
        if (point.y < rect.top + margin) dy = 4;
        else if (point.y > rect.bottom - margin) dy = -4;
      }
      if (dx || dy) {
        const viewport = getViewport();
        void setViewport({ ...viewport, x: viewport.x + dx, y: viewport.y + dy });
      }
      frame = window.requestAnimationFrame(edgePan);
    };
    frame = window.requestAnimationFrame(edgePan);
    return () => window.cancelAnimationFrame(frame);
  }, [blueprintPlacementId, getViewport, placement, setViewport]);

  const beltNodeIndex = useMemo(() => {
    const connectedInputsByTarget = new Map<string, ItemId[]>();
    const activeEntityIds = new Set<string>();
    for (const belt of canvasGame.belts) {
      const inputs = connectedInputsByTarget.get(belt.target) ?? [];
      inputs.push(belt.itemId);
      connectedInputsByTarget.set(belt.target, inputs);
      if (belt.lastFlow > 0.001) {
        activeEntityIds.add(belt.source);
        activeEntityIds.add(belt.target);
      }
    }
    return { connectedInputsByTarget, activeEntityIds: [...activeEntityIds], occupancy: getPortOccupancy(canvasGame) };
  }, [canvasGame]);

  const beltBundleMap = useMemo(() => getBeltBundleMap(canvasGame), [canvasGame.activePlanetId, canvasGame.belts]);
  const focusedBeltNetwork = useMemo(() => focusedBeltNetworkId
    ? analyzeBeltNetwork(canvasGame, focusedBeltNetworkId)
    : null, [focusedBeltNetworkId, canvasGame]);
  const focusedNetworkBeltIds = useMemo(() => new Set(focusedBeltNetwork?.beltIds ?? []), [focusedBeltNetwork]);
  const focusedNetworkEntityIds = useMemo(() => new Set(focusedBeltNetwork?.entityIds ?? []), [focusedBeltNetwork]);
  const selectedBeltIdSet = useMemo(() => new Set(selectedBeltIds), [selectedBeltIds]);

  useEffect(() => {
    if (focusedBeltNetworkId && !game.belts.some((belt) => belt.id === focusedBeltNetworkId)) {
      setFocusedBeltNetworkId(null);
    }
  }, [focusedBeltNetworkId, game.belts]);

  const taskHighlight = useMemo(() => {
    const task = highlightedTaskId ? getCampaignTask(highlightedTaskId) : undefined;
    if (!task) return { entityIds: new Set<string>(), beltIds: new Set<string>(), itemIds: new Set<ItemId>() };
    const itemIds = new Set<ItemId>(getCampaignTaskRequirements(task).map((requirement) => requirement.itemId));
    if (task.navigation?.kind === "recipe") itemIds.add(task.navigation.itemId);
    for (let depth = 0; depth < 8; depth += 1) {
      let changed = false;
      for (const recipe of Object.values(RECIPES)) {
        if (!recipe.outputs.some((output) => itemIds.has(output.itemId))) continue;
        for (const input of recipe.inputs) {
          if (!itemIds.has(input.itemId)) {
            itemIds.add(input.itemId);
            changed = true;
          }
        }
      }
      if (!changed) break;
    }
    const entityIds = new Set(canvasGame.entities.flatMap((entity) => {
      if (entity.planetId !== canvasGame.activePlanetId) return [];
      const directBuilding = task.navigation?.kind === "building" && entity.buildingId === task.navigation.buildingId;
      const relevantItem = (entity.resourceId && itemIds.has(entity.resourceId)) ||
        getProducedOutputs(entity).some((itemId) => itemIds.has(itemId)) ||
        getAcceptedInputs(entity, canvasGame).some((itemId) => itemIds.has(itemId));
      return directBuilding || relevantItem ? [entity.id] : [];
    }));
    const beltIds = new Set(canvasGame.belts.flatMap((belt) => {
      if (belt.planetId !== canvasGame.activePlanetId || !itemIds.has(belt.itemId)) return [];
      entityIds.add(belt.source);
      entityIds.add(belt.target);
      return [belt.id];
    }));
    return { entityIds, beltIds, itemIds };
  }, [canvasGame, highlightedTaskId]);

  const commonNodeData = useMemo<Omit<FactoryNodeData, "entity" | "status" | "powerFactor" | "resourceReserve" | "connectedInputItemIds" | "inputBeltCounts" | "outputBeltCounts">>(() => {
    const technology = getTechnology(canvasGame.research.selectedTechId);
    const progress = technology ? canvasGame.research.progressByTech[technology.id] ?? {} : {};
    const planetProfile = getPlanetIndustrialProfile(canvasGame, canvasGame.activePlanetId);
    return {
      cargo: canvasGame.cargo,
      placement,
      placementCount,
      miningEntityId,
      onMiningStart,
      onMiningStop,
      onPickOutput,
      onPickInput,
      onDropCargo,
      onDropDraggedItem,
      onInstallMiner,
      onAddBuilding,
      onRecipeChange,
      onFuelChange,
      onEnergyModeChange,
      researchLabel: technology?.name ?? null,
      researchCosts: technology?.costs.filter((cost) => (progress[cost.itemId] ?? 0) < cost.amount) ?? [],
      completedTechIds: canvasGame.research.completedTechIds,
      networkTime: canvasGame.elapsedSeconds,
      paused: canvasGame.paused,
      powerDemandMultiplier: getDifficultyDefinition(canvasGame.settings.difficulty).powerDemandMultiplier,
      solarGenerationMultiplier: getPlanetSolarPowerMultiplier(canvasGame, canvasGame.activePlanetId),
      windGenerationMultiplier: planetProfile.windMultiplier,
      geothermalGenerationMultiplier: planetProfile.geothermalMultiplier,
      activeLogisticsEntityIds: beltNodeIndex.activeEntityIds,
      connectionDraft,
      dysonSwarm: canvasGame.dysonSwarm,
      dysonSphere: canvasGame.dysonSphere,
    };
  }, [beltNodeIndex.activeEntityIds, canvasGame.activePlanetId, canvasGame.cargo, canvasGame.dysonSphere, canvasGame.dysonSwarm, canvasGame.elapsedSeconds, canvasGame.galaxy, canvasGame.paused, canvasGame.research.completedTechIds, canvasGame.research.progressByTech, canvasGame.research.selectedTechId, canvasGame.settings.difficulty, connectionDraft, miningEntityId, onAddBuilding, onDropCargo, onDropDraggedItem, onEnergyModeChange, onFuelChange, onInstallMiner, onMiningStart, onMiningStop, onPickInput, onPickOutput, onRecipeChange, placement, placementCount]);

  useEffect(() => {
    if (nodeDragActiveRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      setNodes((current) => {
        const existing = new Map(current.map((node) => [node.id, node]));
        return canvasGame.entities.filter((entity) => entity.planetId === canvasGame.activePlanetId).map((entity) => {
          const previous = existing.get(entity.id);
          return {
            id: entity.id,
            type: entity.kind,
            position: previous?.position ?? entity.position,
            measured: previous?.measured,
            data: {
              ...commonNodeData,
              entity,
              connectedInputItemIds: beltNodeIndex.connectedInputsByTarget.get(entity.id) ?? [],
              inputBeltCounts: beltNodeIndex.occupancy.input.get(entity.id) ?? {},
              outputBeltCounts: beltNodeIndex.occupancy.output.get(entity.id) ?? {},
              powerFactor: getEntityPowerFactor(canvasGame, entity),
              resourceReserve: getResourceReserveSnapshot(canvasGame, entity),
              status: getEntityOperatingStatus(canvasGame, entity),
            } as FactoryNodeData,
            selected: selectedEntityIds.includes(entity.id),
            className: highlightedTaskId
              ? taskHighlight.entityIds.has(entity.id) ? "factory-flow-node--task-focus" : "factory-flow-node--task-dim"
              : focusedBeltNetwork
                ? focusedNetworkEntityIds.has(entity.id) ? "factory-flow-node--network-focus" : "factory-flow-node--network-dim"
                : undefined,
            draggable: !placement && !blueprintPlacementId,
          } satisfies FactoryFlowNode;
        });
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [beltNodeIndex.connectedInputsByTarget, beltNodeIndex.occupancy.input, beltNodeIndex.occupancy.output, blueprintPlacementId, canvasGame.activePlanetId, canvasGame.entities, canvasGame.galaxy, canvasGame.settings.resourceMode, commonNodeData, focusedBeltNetwork, focusedNetworkEntityIds, highlightedTaskId, placement, selectedEntityIds, setNodes, taskHighlight.entityIds]);

  const edges = useMemo<FactoryFlowEdge[]>(() => {
    const rects = nodes.map((node) => ({
      id: node.id,
      x: node.position.x,
      y: node.position.y,
      width: node.measured?.width ?? 256,
      height: node.measured?.height ?? 180,
    }));
    const rectById = new Map(rects.map((rect) => [rect.id, rect]));
    const routeCenterFor = (belt: GameState["belts"][number], bundleIndex: number, bundleSize: number) => {
      const mode = belt.routeMode ?? "auto";
      if (mode === "bezier" || largeFactoryMode) return undefined;
      const source = rectById.get(belt.source);
      const target = rectById.get(belt.target);
      if (!source || !target) return undefined;
      const sourceY = source.y + source.height / 2;
      const targetY = target.y + target.height / 2;
      const bundleOffset = (bundleIndex - (bundleSize - 1) / 2) * 18;
      if (mode === "manual") return (sourceY + targetY) / 2 + (belt.routeOffsetY ?? 0) + bundleOffset;
      if (mode === "upper") return Math.min(source.y, target.y) - 64 + bundleOffset;
      if (mode === "lower") return Math.max(source.y + source.height, target.y + target.height) + 64 + bundleOffset;
      const sourceX = source.x + source.width;
      const targetX = target.x;
      const left = Math.min(sourceX, targetX);
      const right = Math.max(sourceX, targetX);
      const blockers = rects.filter((rect) => {
        if (rect.id === source.id || rect.id === target.id || rect.x > right || rect.x + rect.width < left) return false;
        const ratio = right - left > 0.001 ? (rect.x + rect.width / 2 - left) / (right - left) : 0.5;
        const routeY = sourceY + (targetY - sourceY) * Math.max(0, Math.min(1, ratio));
        return routeY >= rect.y - 18 && routeY <= rect.y + rect.height + 18;
      });
      if (blockers.length === 0) return (sourceY + targetY) / 2 + bundleOffset;
      const upper = Math.min(sourceY, targetY, ...blockers.map((rect) => rect.y)) - 52;
      const lower = Math.max(sourceY, targetY, ...blockers.map((rect) => rect.y + rect.height)) + 52;
      const midpoint = (sourceY + targetY) / 2;
      return (Math.abs(midpoint - upper) <= Math.abs(lower - midpoint) ? upper : lower) + bundleOffset;
    };
    return canvasGame.belts.filter((belt) => belt.planetId === canvasGame.activePlanetId).map((belt) => {
      const item = ITEMS[belt.itemId];
      const capacity = getBeltCapacity(belt);
      const flowRatio = capacity > 0 ? Math.min(1, belt.lastFlow / capacity) : 0;
      const bundle = beltBundleMap.get(belt.id) ?? { index: 0, size: 1 };
      const diagnostic = diagnoseBelt(canvasGame, belt);
      const routeColor = canvasGame.settings.beltHeatmapEnabled ? beltHeatColor(diagnostic.utilization) : item.color;
      const focusTone = highlightedTaskId
        ? taskHighlight.beltIds.has(belt.id) ? "focus" : "dim"
        : focusedBeltNetwork
          ? focusedNetworkBeltIds.has(belt.id) ? "focus" : "dim"
          : "normal";
      return {
        id: belt.id,
        type: "factory",
        source: belt.source,
        target: belt.target,
        sourceHandle: `out:${belt.itemId}`,
        targetHandle: `in:${belt.itemId}`,
        className: `factory-edge factory-edge--health-${diagnostic.health}${canvasGame.settings.beltHeatmapEnabled ? " factory-edge--heatmap" : ""}${belt.lastFlow > 0.001 ? " factory-edge--active" : ""}${focusTone === "focus" ? " factory-edge--task-focus" : focusTone === "dim" ? " factory-edge--task-dim" : ""}`,
        selected: selectedBeltId === belt.id || selectedBeltIdSet.has(belt.id),
        zIndex: selectedBeltId === belt.id || selectedBeltIdSet.has(belt.id) ? 1 : 0,
        interactionWidth: 36,
        markerEnd: { type: MarkerType.ArrowClosed, color: routeColor },
        data: {
          itemId: belt.itemId,
          itemName: item.name,
          itemSymbol: item.symbol,
          color: item.color,
          tier: belt.tier,
          flow: belt.lastFlow,
          capacity,
          stackSize: belt.stackSize ?? 1,
          congestion: belt.congestion ?? 0,
          monitored: belt.monitorEnabled ?? false,
          durationSeconds: Math.max(0.55, 1.65 - flowRatio * 0.9),
          detailVisible: !largeFactoryMode && viewportZoom >= 0.55,
          motionEnabled: !coarsePointer && !performanceVisualMode && !canvasGame.settings.reducedMotion,
          routeMode: belt.routeMode ?? "auto",
          routeCenterY: routeCenterFor(belt, bundle.index, bundle.size),
          bundleIndex: bundle.index,
          bundleSize: bundle.size,
          health: diagnostic.health,
          taskTone: focusTone,
        },
        style: {
          stroke: routeColor,
          strokeWidth: selectedBeltId === belt.id || selectedBeltIdSet.has(belt.id) ? 3.5 : canvasGame.settings.beltHeatmapEnabled ? 1.8 + diagnostic.utilization * 2.4 : 2,
        },
      } satisfies FactoryFlowEdge;
    });
  }, [beltBundleMap, canvasGame, coarsePointer, focusedBeltNetwork, focusedNetworkBeltIds, highlightedTaskId, largeFactoryMode, nodes, performanceVisualMode, selectedBeltId, selectedBeltIdSet, taskHighlight.beltIds, viewportZoom]);

  const isValidConnection = useCallback((connection: Connection | Edge) => {
    const sourceItem = parseHandleItem(connection.sourceHandle);
    const targetItem = parseHandleItem(connection.targetHandle);
    if (!connection.source || !connection.target || connection.source === connection.target ||
      !sourceItem || (!isAutoInputHandle(connection.targetHandle) && sourceItem !== targetItem)) return false;
    const state = gameRef.current;
    const source = state.entities.find((entity) => entity.id === connection.source);
    const target = state.entities.find((entity) => entity.id === connection.target);
    const draft = connectionDraftRef.current;
    const tier = draft?.tier ?? resolveConnectionBeltTier(state, beltTierMode, beltTier, connection.source, sourceItem);
    const constructionId = getBeltConstructionId(tier);
    const existing = state.belts.find((belt) => belt.source === connection.source && belt.target === connection.target && belt.itemId === sourceItem);
    return Boolean(source && target && source.planetId === target.planetId &&
      getProducedOutputs(source).includes(sourceItem) &&
      (!existing || existing.tier === tier) &&
      canConnectBelt(state, connection.source, connection.target, sourceItem, tier) &&
      (state.construction[constructionId] ?? 0) >= 1);
  }, [beltTier, beltTierMode]);

  const beginConnectionDraft = useCallback((params: OnConnectStartParams): ConnectionDraft | null => {
    const itemId = parseHandleItem(params.handleId);
    if (!params.nodeId || !params.handleType || !itemId) return null;
    const tier = resolveConnectionBeltTier(gameRef.current, beltTierMode, beltTier, params.nodeId, itemId);
    const draft = { nodeId: params.nodeId, itemId, handleType: params.handleType, tier } satisfies ConnectionDraft;
    updateConnectionDraft(draft);
    setConnectionHint({
      label: `${ITEMS[itemId].name} · Mk.${tier === 3 ? "III" : tier === 2 ? "II" : "I"} 已锁定 · 连接到同色${params.handleType === "source" ? "输入" : "输出"}端口`,
      tone: "ready",
    });
    return draft;
  }, [beltTier, beltTierMode, updateConnectionDraft]);

  const onConnectStart = useCallback((event: MouseEvent | TouchEvent, params: OnConnectStartParams) => {
    if (clickConnectionPreviewRef.current) return;
    dragConnectionStartRef.current = getEventPoint(event);
    beginConnectionDraft(params);
  }, [beginConnectionDraft]);

  const onClickConnectStart = useCallback((event: MouseEvent | TouchEvent, params: OnConnectStartParams) => {
    const draft = beginConnectionDraft(params);
    const handle = getConnectionHandleTarget(event.target);
    if (!draft || !handle) return;
    const bounds = handle.element.getBoundingClientRect();
    const preview = {
      originX: bounds.left + bounds.width / 2,
      originY: bounds.top + bounds.height / 2,
      handleType: draft.handleType,
      draft,
    } satisfies ClickConnectionPreviewState;
    clickConnectionPreviewRef.current = preview;
    clickConnectionSucceededRef.current = false;
    setClickConnectionTone("pending");
    setClickConnectionSnapPoint(null);
    setClickConnectionPreview(preview);
  }, [beginConnectionDraft]);

  useEffect(() => {
    const preview = clickConnectionPreview;
    if (!preview) return;
    const handle = findConnectionHandleAtPoint(
      pointer.x,
      pointer.y,
      coarsePointer ? 56 : 24,
      (candidate) => isValidConnection(connectionFromDraft(preview.draft, candidate)),
    );
    const overOrigin = handle?.nodeId === preview.draft.nodeId && handle.handleType === preview.draft.handleType &&
      parseHandleItem(handle.handleId) === preview.draft.itemId;
    const tone = !handle || overOrigin
      ? "pending"
      : isValidConnection(connectionFromDraft(preview.draft, handle)) ? "valid" : "invalid";
    setClickConnectionTone((current) => current === tone ? current : tone);
    if (!handle || overOrigin) {
      setClickConnectionSnapPoint(null);
      setConnectionHint({ label: `${ITEMS[preview.draft.itemId].name} · 选择高亮输入端口`, tone: "ready" });
      return;
    }
    const bounds = handle.element.getBoundingClientRect();
    const snapPoint = { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
    setClickConnectionSnapPoint((current) => current && Math.abs(current.x - snapPoint.x) < 0.5 && Math.abs(current.y - snapPoint.y) < 0.5 ? current : snapPoint);
    const connection = connectionFromDraft(preview.draft, handle);
    if (tone !== "valid" || !connection.source || !connection.target) {
      const check = connection.source && connection.target
        ? getBeltConnectionCheck(gameRef.current, connection.source, connection.target, preview.draft.itemId, preview.draft.tier)
        : null;
      setConnectionHint({ label: check && !check.ok ? check.label : "当前端口不可连接", tone: "blocked" });
      return;
    }
    const forecast = predictBeltConnection(gameRef.current, connection.source, connection.target, preview.draft.itemId, preview.draft.tier);
    setConnectionHint({
      label: forecast ? `${ITEMS[preview.draft.itemId].name} · ${forecast.label}` : `${ITEMS[preview.draft.itemId].name} · 可以连接`,
      tone: forecast?.tone === "capacity" || forecast?.tone === "starved" ? "blocked" : "ready",
    });
  }, [clickConnectionPreview, coarsePointer, isValidConnection, pointer]);

  const onConnectEnd = useCallback((event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
    const endPoint = getEventPoint(event);
    const draft = connectionDraftRef.current ?? connectionDraft;
    const releaseHandle = getConnectionHandleTarget(event.target) ?? (endPoint ? findConnectionHandleAtPoint(
      endPoint.x,
      endPoint.y,
      coarsePointer ? 56 : 24,
      draft ? (candidate) => isValidConnection(connectionFromDraft(draft, candidate)) : undefined,
    ) : null);
    const startPoint = dragConnectionStartRef.current;
    dragConnectionStartRef.current = null;
    const releasedOnFromHandle = Boolean(releaseHandle && state.fromNode && state.fromHandle &&
      releaseHandle.nodeId === state.fromNode.id && releaseHandle.handleId === state.fromHandle.id && releaseHandle.handleType === state.fromHandle.type);
    const stationaryClick = Boolean(startPoint && endPoint && Math.hypot(endPoint.x - startPoint.x, endPoint.y - startPoint.y) <= 8);
    if (!state.isValid && releasedOnFromHandle && (stationaryClick || clickConnectionPreviewRef.current)) return;
    if (!state.isValid && draft && releaseHandle) {
      const snappedConnection = connectionFromDraft(draft, releaseHandle);
      if (isValidConnection(snappedConnection)) {
        updateConnectionDraft(null);
        setClickConnectionSnapPoint(null);
        connectRequestRef.current(snappedConnection, draft.tier);
        setConnectionHint({ label: `${ITEMS[draft.itemId].name}运输线已建立`, tone: "ready" });
        return;
      }
    }
    updateConnectionDraft(null);
    setClickConnectionSnapPoint(null);
    if (state.isValid) {
      const itemId = parseHandleItem(state.fromHandle?.id) ?? draft?.itemId ?? null;
      setConnectionHint(itemId ? { label: `${ITEMS[itemId].name}运输线已建立`, tone: "ready" } : null);
      return;
    }
    const fromItem = parseHandleItem(state.fromHandle?.id) ?? draft?.itemId ?? null;
    const toItem = parseHandleItem(state.toHandle?.id);
    const fromNodeId = state.fromNode?.id ?? draft?.nodeId;
    const toNodeId = state.toNode?.id;
    const fromType = state.fromHandle?.type ?? draft?.handleType;
    const sourceId = fromType === "source" ? fromNodeId : toNodeId;
    const targetId = fromType === "target" ? fromNodeId : toNodeId;
    const current = gameRef.current;
    const lockedTier = draft?.tier ?? resolveConnectionBeltTier(current, beltTierMode, beltTier, fromNodeId, fromItem ?? undefined);
    const source = sourceId ? current.entities.find((entity) => entity.id === sourceId) : undefined;
    const target = targetId ? current.entities.find((entity) => entity.id === targetId) : undefined;
    let label = "请释放到设备的同色输入端口";
    if (state.toNode && state.fromNode?.id === state.toNode.id) label = "设备不能连接到自身";
    else if (state.toHandle && !isAutoInputHandle(state.toHandle.id) && fromItem !== toItem) label = `物品不兼容：需要${fromItem ? ITEMS[fromItem].name : "同一种物品"}`;
    else if (state.toHandle && state.fromHandle?.type === state.toHandle.type) label = "输出端口必须连接输入端口";
    else if ((current.construction[getBeltConstructionId(lockedTier)] ?? 0) < 1) label = "施工托盘中没有本次锁定等级的传送带";
    else if (!source || !target) label = "请释放到设备的同色输入端口";
    else if (source.planetId !== target.planetId) label = "两端必须位于同一行星";
    else if (!fromItem || !getProducedOutputs(source).includes(fromItem)) label = `${fromItem ? ITEMS[fromItem].name : "该物品"}不是当前输出`;
    else {
      const existing = current.belts.find((belt) => belt.source === source.id && belt.target === target.id && belt.itemId === fromItem);
      if (existing && existing.tier !== lockedTier) label = `已有并行线路使用 Mk.${existing.tier === 3 ? "III" : existing.tier === 2 ? "II" : "I"}，请手动指定同级传送带`;
      else {
        const check = getBeltConnectionCheck(current, source.id, target.id, fromItem, lockedTier);
        if (!check.ok) label = check.label;
      }
    }
    setNotice(`运输线未建立：${label}`);
    setConnectionHint({ label, tone: "blocked" });
    spawnInteractionBurst(pointerRef.current.x, pointerRef.current.y, "连接失败", "warning");
    playTone("alert");
  }, [beltTier, beltTierMode, coarsePointer, connectionDraft, isValidConnection, playTone, spawnInteractionBurst, updateConnectionDraft]);

  const onClickConnectEnd = useCallback((event: MouseEvent | TouchEvent) => {
    const preview = clickConnectionPreviewRef.current;
    if (!preview) return;
    const point = getEventPoint(event);
    const targetHandle = getConnectionHandleTarget(event.target) ?? (point ? findConnectionHandleAtPoint(
      point.x,
      point.y,
      coarsePointer ? 56 : 24,
      (candidate) => isValidConnection(connectionFromDraft(preview.draft, candidate)),
    ) : null);
    const connection = targetHandle ? connectionFromDraft(preview.draft, targetHandle) : null;
    let succeeded = clickConnectionSucceededRef.current;
    if (!succeeded && connection && isValidConnection(connection)) {
      connectRequestRef.current(connection, preview.draft.tier);
      succeeded = true;
    }
    clickConnectionPreviewRef.current = null;
    clickConnectionSucceededRef.current = false;
    setClickConnectionPreview(null);
    setClickConnectionTone("pending");
    setClickConnectionSnapPoint(null);
    updateConnectionDraft(null);
    const releasedOnPane = !targetHandle && event.target instanceof Element && Boolean(event.target.closest(".react-flow__pane"));
    if (releasedOnPane) {
      setConnectionHint(null);
      setNotice("已取消运输线连接");
      return;
    }
    if (succeeded) {
      setConnectionHint({ label: `${ITEMS[preview.draft.itemId].name}运输线已建立`, tone: "ready" });
      return;
    }

    const current = gameRef.current;
    const sourceItem = parseHandleItem(connection?.sourceHandle) ?? preview.draft.itemId;
    const source = connection?.source ? current.entities.find((entity) => entity.id === connection.source) : undefined;
    const target = connection?.target ? current.entities.find((entity) => entity.id === connection.target) : undefined;
    let label = "请选择设备的高亮端口";
    if (targetHandle?.handleType === preview.draft.handleType) label = "输出端口必须连接输入端口";
    else if (connection?.source === connection?.target) label = "设备不能连接到自身";
    else if (targetHandle && !isAutoInputHandle(connection?.targetHandle) && parseHandleItem(targetHandle.handleId) !== preview.draft.itemId) label = `物品不兼容：需要${ITEMS[preview.draft.itemId].name}`;
    else if ((current.construction[getBeltConstructionId(preview.draft.tier)] ?? 0) < 1) label = "施工托盘中没有本次锁定等级的传送带";
    else if (!source || !target) label = "请选择设备的高亮端口";
    else if (source.planetId !== target.planetId) label = "两端必须位于同一行星";
    else if (!getProducedOutputs(source).includes(sourceItem)) label = `${ITEMS[sourceItem].name}不是当前输出`;
    else {
      const existing = current.belts.find((belt) => belt.source === source.id && belt.target === target.id && belt.itemId === sourceItem);
      if (existing && existing.tier !== preview.draft.tier) label = `已有并行线路使用 Mk.${existing.tier === 3 ? "III" : existing.tier === 2 ? "II" : "I"}，请手动指定同级传送带`;
      else {
        const check = getBeltConnectionCheck(current, source.id, target.id, sourceItem, preview.draft.tier);
        if (!check.ok) label = check.label;
      }
    }
    setNotice(`运输线未建立：${label}`);
    setConnectionHint({ label, tone: "blocked" });
    spawnInteractionBurst(pointerRef.current.x, pointerRef.current.y, "连接失败", "warning");
    playTone("alert");
  }, [coarsePointer, isValidConnection, playTone, spawnInteractionBurst, updateConnectionDraft]);

  const onConnect = useCallback((connection: Connection, lockedTier?: BeltTier) => {
    const sourceItem = parseHandleItem(connection.sourceHandle);
    const targetItem = parseHandleItem(connection.targetHandle);
    if (!connection.source || !connection.target || !sourceItem ||
      (!isAutoInputHandle(connection.targetHandle) && sourceItem !== targetItem)) {
      setNotice("运输线两端必须使用同一种物品");
      return;
    }
    const activeTier = lockedTier ?? connectionDraftRef.current?.tier ?? resolveConnectionBeltTier(gameRef.current, beltTierMode, beltTier, connection.source, sourceItem);
    const constructionId = getBeltConstructionId(activeTier);
    const tierName = activeTier === 3 ? "III" : activeTier === 2 ? "II" : "I";
    if ((gameRef.current.construction[constructionId] ?? 0) < 1) {
      setNotice(`施工托盘中没有可用的 Mk.${tierName} 传送带`);
      setInspectorTab("fabricate");
      return;
    }
    const existing = gameRef.current.belts.find((belt) =>
      belt.source === connection.source && belt.target === connection.target && belt.itemId === sourceItem);
    if (existing && existing.tier !== activeTier) {
      setNotice(`已有并行线路使用 Mk.${existing.tier === 3 ? "III" : existing.tier === 2 ? "II" : "I"}，请手动选择同级传送带`);
      return;
    }
    const before = gameRef.current;
    const source = before.entities.find((entity) => entity.id === connection.source);
    const target = before.entities.find((entity) => entity.id === connection.target);
    const next = connectBelt(before, connection.source, connection.target, sourceItem, activeTier);
    if (next === before) {
      const reason = !source || !target
        ? "节点已不存在"
        : source.planetId !== target.planetId
          ? "两端必须位于同一行星"
          : !getProducedOutputs(source).includes(sourceItem)
            ? `${ITEMS[sourceItem].name}不是当前输出`
           : !getBeltConnectionCheck(before, source.id, target.id, sourceItem, activeTier).ok
              ? getBeltConnectionCheck(before, source.id, target.id, sourceItem, activeTier).label
              : "施工托盘中没有可用传送带";
      setNotice(`运输线未建立：${reason}`);
      setConnectionHint({ label: `未建立 · ${reason}`, tone: "blocked" });
      spawnInteractionBurst(pointerRef.current.x, pointerRef.current.y, "连接失败", "warning");
      playTone("alert");
      return;
    }
    if (clickConnectionPreviewRef.current) clickConnectionSucceededRef.current = true;
    commitGame(() => next);
    trackAnalyticsEvent("belt_connect");
    setNotice(`${ITEMS[sourceItem].name}运输线已建立 · Mk.${tierName}`);
    spawnInteractionBurst(pointerRef.current.x, pointerRef.current.y, "运输线已建立", "positive");
    playTone("connect");
  }, [beltTier, beltTierMode, commitGame, playTone, spawnInteractionBurst]);

  useEffect(() => { connectRequestRef.current = onConnect; }, [onConnect]);

  const completeClickConnectionAtPoint = useCallback((x: number, y: number) => {
    const preview = clickConnectionPreviewRef.current;
    if (!preview) return false;
    const targetHandle = findConnectionHandleAtPoint(
      x,
      y,
      coarsePointer ? 56 : 24,
      (candidate) => isValidConnection(connectionFromDraft(preview.draft, candidate)),
    );
    const connection = targetHandle ? connectionFromDraft(preview.draft, targetHandle) : null;
    if (!connection || !isValidConnection(connection)) return false;
    connectRequestRef.current(connection, preview.draft.tier);
    flowStore.getState().cancelConnection();
    flowStore.setState({ connectionClickStartHandle: null });
    clickConnectionPreviewRef.current = null;
    clickConnectionSucceededRef.current = false;
    setClickConnectionPreview(null);
    setClickConnectionTone("pending");
    setClickConnectionSnapPoint(null);
    updateConnectionDraft(null);
    return true;
  }, [coarsePointer, flowStore, isValidConnection, updateConnectionDraft]);

  useEffect(() => {
    const completeSnappedConnection = (event: PointerEvent) => {
      if (event.pointerType === "touch" && !event.isPrimary) return;
      if (placement || blueprintPlacementId || !clickConnectionPreviewRef.current) return;
      if (completeClickConnectionAtPoint(event.clientX, event.clientY)) {
        suppressConnectionClickRef.current = true;
        window.clearTimeout(suppressConnectionClickTimerRef.current);
        suppressConnectionClickTimerRef.current = window.setTimeout(() => {
          suppressConnectionClickRef.current = false;
        }, 250);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest(".factory-canvas") || target.closest(".react-flow__handle")) return;
      flowStore.getState().cancelConnection();
      flowStore.setState({ connectionClickStartHandle: null });
      clickConnectionPreviewRef.current = null;
      clickConnectionSucceededRef.current = false;
      setClickConnectionPreview(null);
      setClickConnectionTone("pending");
      setClickConnectionSnapPoint(null);
      updateConnectionDraft(null);
      setConnectionHint(null);
      setNotice("已取消运输线连接");
    };
    const suppressCompletedConnectionClick = (event: MouseEvent) => {
      if (!suppressConnectionClickRef.current) return;
      suppressConnectionClickRef.current = false;
      window.clearTimeout(suppressConnectionClickTimerRef.current);
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    document.addEventListener("pointerdown", completeSnappedConnection, { capture: true });
    document.addEventListener("click", suppressCompletedConnectionClick, { capture: true });
    return () => {
      document.removeEventListener("pointerdown", completeSnappedConnection, { capture: true });
      document.removeEventListener("click", suppressCompletedConnectionClick, { capture: true });
      window.clearTimeout(suppressConnectionClickTimerRef.current);
    };
  }, [blueprintPlacementId, completeClickConnectionAtPoint, flowStore, placement]);

  const onNodeDrag = useCallback((_event: MouseEvent | TouchEvent, node: FactoryFlowNode) => {
    const width = node.measured?.width ?? 256;
    const height = node.measured?.height ?? 180;
    const centerX = node.position.x + width / 2;
    const centerY = node.position.y + height / 2;
    const threshold = 7 / Math.max(0.3, viewportZoom);
    let guideX: number | null = null;
    let guideY: number | null = null;
    let nearestX = Number.POSITIVE_INFINITY;
    let nearestY = Number.POSITIVE_INFINITY;
    for (const candidate of nodes) {
      if (candidate.id === node.id || candidate.selected) continue;
      const candidateWidth = candidate.measured?.width ?? 256;
      const candidateHeight = candidate.measured?.height ?? 180;
      const candidateX = candidate.position.x + candidateWidth / 2;
      const candidateY = candidate.position.y + candidateHeight / 2;
      const distanceX = Math.abs(candidateX - centerX);
      const distanceY = Math.abs(candidateY - centerY);
      if (distanceX < threshold && distanceX < nearestX) {
        nearestX = distanceX;
        guideX = candidateX;
      }
      if (distanceY < threshold && distanceY < nearestY) {
        nearestY = distanceY;
        guideY = candidateY;
      }
    }
    setAlignmentGuides((current) => current.x === guideX && current.y === guideY ? current : { x: guideX, y: guideY });
  }, [nodes, viewportZoom]);

  const onSelectionChange = useCallback(({ nodes: selectedNodes, edges: selectedEdges }: OnSelectionChangeParams<FactoryFlowNode, Edge>) => {
    const ids = selectedNodes.map((node) => node.id);
    const nodeIds = new Set(ids);
    const beltIds = new Set(selectedEdges.map((edge) => edge.id));
    for (const belt of gameRef.current.belts) {
      if (belt.planetId === gameRef.current.activePlanetId && nodeIds.has(belt.source) && nodeIds.has(belt.target)) beltIds.add(belt.id);
    }
    setSelectedEntityIds((current) => current.length === ids.length && current.every((id, index) => id === ids[index]) ? current : ids);
    setSelectedBeltIds([...beltIds]);
    if (ids.length > 0 || beltIds.size > 1) setSelectedBeltId(null);
    else if (beltIds.size === 1) setSelectedBeltId([...beltIds][0]);
  }, []);

  const onNodeClick: NodeMouseHandler<FactoryFlowNode> = useCallback((event, node) => {
    if (blueprintPlacementId) return;
    if (!placement && completeClickConnectionAtPoint(event.clientX, event.clientY)) return;
    if (nextMobileShell && mobileCanvasMode === "layout" && !placement) return;
    if (placement) {
      const entity = gameRef.current.entities.find((candidate) => candidate.id === node.id);
      const constructionId = entity?.kind === "vein" && entity.resourceId
        ? getExtractorBuildingId(entity.resourceId)
        : entity?.buildingId;
      if (!entity || constructionId !== placement) {
        setNotice(`请选择已放置的${getBuilding(placement).name}进行扩建`);
        return;
      }
      const keepContinuous = nextMobileShell ? mobileContinuousPlacement : event.ctrlKey || ctrlHeldRef.current;
      const result = expandEntityGroup(node.id, keepContinuous ? 1 : placementCount, { x: event.clientX, y: event.clientY });
      if (!result) {
        continuousPlacementRef.current = null;
        setPlacement(null);
        return;
      }
      setPlacementCount(1);
      if (keepContinuous && result.remaining >= 1) {
        continuousPlacementRef.current = { entityId: node.id, buildingId: placement, planetId: gameRef.current.activePlanetId };
        setNotice(`${result.name}已扩建至 ×${result.count} · Ctrl 连续扩建中`);
      } else {
        continuousPlacementRef.current = null;
        setPlacement(null);
        setNotice(`${result.name}已扩建至 ×${result.count}${keepContinuous ? " · 施工库存已用完" : ""}`);
      }
      return;
    }
    const mobileSelecting = nextMobileShell && mobileCanvasMode === "select";
    setSelectedEntityIds((current) => event.shiftKey || selectionMode || mobileSelecting
      ? current.includes(node.id) ? current.filter((id) => id !== node.id) : [...current, node.id]
      : [node.id]);
    setSelectedBeltId(null);
    setSelectedBeltIds([]);
    setInspectorTab("inspect");
    if (!selectionMode && !mobileSelecting) {
      if (nextMobileShell) mobileNavigation.openSheet("inspector", "peek");
      else setMobilePanel("inspector");
    }
  }, [blueprintPlacementId, completeClickConnectionAtPoint, expandEntityGroup, mobileCanvasMode, mobileContinuousPlacement, mobileNavigation.openSheet, nextMobileShell, placement, placementCount, selectionMode]);

  const onNodeDoubleClick: NodeMouseHandler<FactoryFlowNode> = useCallback((_event, node) => {
    if (placement || blueprintPlacementId || !gameRef.current.settings.allowDoubleClickZoom) return;
    setSelectedEntityIds([node.id]);
    setSelectedBeltId(null);
    setSelectedBeltIds([]);
    focusEntityIds([node.id]);
  }, [blueprintPlacementId, focusEntityIds, placement]);

  const onRegionPointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (!regionMode || event.button !== 0 || placement || blueprintPlacementId || connectionDraftRef.current) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest(".react-flow__pane") || target.closest(".canvas-region__label")) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const start = snapFlowPosition(screenToFlowPosition({ x: event.clientX, y: event.clientY }));
    regionPointerRef.current = { pointerId: event.pointerId, start };
    setRegionDraft({ ...start, width: 0, height: 0 });
    setSelectedRegionId(null);
  }, [blueprintPlacementId, placement, regionMode, screenToFlowPosition]);

  const onRegionResizeStart = useCallback((event: React.PointerEvent<HTMLButtonElement>, region: CanvasRegion, handle: CanvasRegionResizeHandle) => {
    const start = snapFlowPosition(screenToFlowPosition({ x: event.clientX, y: event.clientY }));
    regionResizeRef.current = { pointerId: event.pointerId, region: { ...region }, handle, start };
    setRegionResizePreview({ regionId: region.id, rectangle: { x: region.x, y: region.y, width: region.width, height: region.height } });
    setRegionMode(false);
    setRegionDraft(null);
  }, [screenToFlowPosition]);

  const onRegionPointerMove = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const resize = regionResizeRef.current;
    if (resize && resize.pointerId === event.pointerId) {
      event.preventDefault();
      event.stopPropagation();
      const current = snapFlowPosition(screenToFlowPosition({ x: event.clientX, y: event.clientY }));
      setRegionResizePreview({
        regionId: resize.region.id,
        rectangle: resizeRegionRectangle(resize.region, resize.handle, resize.start, current),
      });
      return;
    }
    const drag = regionPointerRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const end = snapFlowPosition(screenToFlowPosition({ x: event.clientX, y: event.clientY }));
    setRegionDraft(rectangleFromPoints(drag.start, end));
  }, [screenToFlowPosition]);

  const finishRegionPointer = useCallback((event: React.PointerEvent<HTMLElement>, cancelled = false) => {
    const resize = regionResizeRef.current;
    if (resize && resize.pointerId === event.pointerId) {
      event.preventDefault();
      event.stopPropagation();
      regionResizeRef.current = null;
      const current = snapFlowPosition(screenToFlowPosition({ x: event.clientX, y: event.clientY }));
      const rectangle = resizeRegionRectangle(resize.region, resize.handle, resize.start, current);
      setRegionResizePreview(null);
      if (!cancelled) {
        commitGame((currentGame) => resizeCanvasRegion(currentGame, resize.region.id, rectangle));
        setNotice(`生产区域已调整为 ${Math.round(rectangle.width)} × ${Math.round(rectangle.height)}`);
      }
      return;
    }
    const drag = regionPointerRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    regionPointerRef.current = null;
    const end = snapFlowPosition(screenToFlowPosition({ x: event.clientX, y: event.clientY }));
    const rectangle = rectangleFromPoints(drag.start, end);
    setRegionDraft(null);
    if (cancelled) return;
    if (rectangle.width < 40 || rectangle.height < 40) {
      setNotice("生产区域至少需要 40 × 40 画布单位");
      return;
    }
    const regionId = `region_${gameRef.current.nextId}`;
    commitGame((current) => addCanvasRegion(current, current.activePlanetId, rectangle));
    setRegionMode(false);
    setSelectedRegionId(regionId);
    setNotice("生产区域已创建，可设置名称、背景色和边框色");
    playTone("place");
  }, [commitGame, playTone, screenToFlowPosition]);

  const restoreCanvasEntityPositions = useCallback(() => {
    setNodes((current) => current.map((node) => {
      const entity = gameRef.current.entities.find((candidate) => candidate.id === node.id);
      return entity ? { ...node, position: { ...entity.position }, dragging: false } : node;
    }));
  }, [setNodes]);

  const cancelPendingTouchAction = useCallback(() => {
    blockCanvasTouchRef.current = true;
    nodeDragActiveRef.current = false;
    onMiningStop();
    continuousPlacementRef.current = null;
    regionPointerRef.current = null;
    regionResizeRef.current = null;
    dragConnectionStartRef.current = null;
    flowStore.getState().cancelConnection();
    flowStore.setState({ connectionClickStartHandle: null });
    clickConnectionPreviewRef.current = null;
    clickConnectionSucceededRef.current = false;
    setClickConnectionPreview(null);
    setClickConnectionTone("pending");
    setClickConnectionSnapPoint(null);
    updateConnectionDraft(null);
    setConnectionHint(null);
    setPlacement(null);
    setBlueprintPlacementId(null);
    setSelectionMode(false);
    setRegionMode(false);
    setMobileCanvasMode("browse");
    setMobileContinuousPlacement(false);
    setRegionDraft(null);
    setRegionResizePreview(null);
    setMobileActionEntityId(null);
    setAlignmentGuides({ x: null, y: null });
    restoreCanvasEntityPositions();
  }, [flowStore, onMiningStop, restoreCanvasEntityPositions, updateConnectionDraft]);

  const beginCanvasMultiTouch = useCallback((event: React.PointerEvent<HTMLElement>): boolean => {
    if (!coarsePointer || event.pointerType !== "touch") return false;
    activeCanvasTouchesRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY, target: event.target });
    if (activeCanvasTouchesRef.current.size < 2) return blockCanvasTouchRef.current;
    const points = [...activeCanvasTouchesRef.current.entries()].slice(0, 2);
    const [firstId, first] = points[0];
    const [secondId, second] = points[1];
    const initialCenter = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
    canvasMultiTouchRef.current = {
      pointerIds: [firstId, secondId],
      initialCenter,
      initialDistance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)),
      initialViewport: { ...viewportRef.current },
    };
    cancelPendingTouchAction();
    for (const pointerId of [firstId, secondId]) {
      try { event.currentTarget.setPointerCapture(pointerId); } catch { /* Safari can reject transfer from a child capture. */ }
    }
    if (first.target instanceof Element && typeof PointerEvent !== "undefined") {
      syntheticTouchCancelRef.current = true;
      first.target.dispatchEvent(new PointerEvent("pointercancel", {
        bubbles: true,
        pointerId: firstId,
        pointerType: "touch",
        clientX: first.x,
        clientY: first.y,
      }));
      syntheticTouchCancelRef.current = false;
    }
    event.preventDefault();
    event.stopPropagation();
    return true;
  }, [cancelPendingTouchAction, coarsePointer]);

  const moveCanvasMultiTouch = useCallback((event: React.PointerEvent<HTMLElement>): boolean => {
    if (event.pointerType !== "touch") return false;
    const existing = activeCanvasTouchesRef.current.get(event.pointerId);
    if (existing) activeCanvasTouchesRef.current.set(event.pointerId, { ...existing, x: event.clientX, y: event.clientY });
    const gesture = canvasMultiTouchRef.current;
    if (!gesture) {
      if (!blockCanvasTouchRef.current) return false;
      event.preventDefault();
      event.stopPropagation();
      return true;
    }
    const first = activeCanvasTouchesRef.current.get(gesture.pointerIds[0]);
    const second = activeCanvasTouchesRef.current.get(gesture.pointerIds[1]);
    if (!first || !second) return true;
    const center = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
    const distance = Math.max(1, Math.hypot(second.x - first.x, second.y - first.y));
    const zoom = Math.max(0.25, Math.min(1.8, gesture.initialViewport.zoom * distance / gesture.initialDistance));
    const worldCenter = {
      x: (gesture.initialCenter.x - gesture.initialViewport.x) / gesture.initialViewport.zoom,
      y: (gesture.initialCenter.y - gesture.initialViewport.y) / gesture.initialViewport.zoom,
    };
    const viewport = {
      x: center.x - worldCenter.x * zoom,
      y: center.y - worldCenter.y * zoom,
      zoom,
    };
    viewportRef.current = viewport;
    setViewportZoom(zoom);
    void setViewport(viewport, { duration: 0 });
    event.preventDefault();
    event.stopPropagation();
    return true;
  }, [setViewport]);

  const endCanvasMultiTouch = useCallback((event: React.PointerEvent<HTMLElement>): boolean => {
    if (event.pointerType !== "touch") return false;
    activeCanvasTouchesRef.current.delete(event.pointerId);
    if (!canvasMultiTouchRef.current && !blockCanvasTouchRef.current) return false;
    if (activeCanvasTouchesRef.current.size < 2) canvasMultiTouchRef.current = null;
    if (activeCanvasTouchesRef.current.size === 0) blockCanvasTouchRef.current = false;
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    } catch { /* The browser may already have released capture on cancellation. */ }
    event.preventDefault();
    event.stopPropagation();
    return true;
  }, []);

  const onPaneClick = useCallback((event: React.MouseEvent) => {
    if (regionMode) {
      setSelectedRegionId(null);
      return;
    }
    const preview = clickConnectionPreviewRef.current;
    if (!placement && !blueprintPlacementId && completeClickConnectionAtPoint(event.clientX, event.clientY)) return;
    if (!placement && !blueprintPlacementId && (preview || connectionDraft)) {
      flowStore.getState().cancelConnection();
      flowStore.setState({ connectionClickStartHandle: null });
      clickConnectionPreviewRef.current = null;
      clickConnectionSucceededRef.current = false;
      setClickConnectionPreview(null);
      setClickConnectionTone("pending");
      setClickConnectionSnapPoint(null);
      updateConnectionDraft(null);
      setConnectionHint(null);
      setNotice("已取消运输线连接");
      return;
    }
    if (blueprintPlacementId) {
      const position = snapFlowPosition(screenToFlowPosition({ x: event.clientX, y: event.clientY }));
      const deployable = canPlaceBlueprint(gameRef.current, blueprintPlacementId);
      const compatible = canQueueBlueprint(gameRef.current, blueprintPlacementId);
      const canContinue = deployable && canPlaceBlueprint(placeBlueprint(gameRef.current, blueprintPlacementId, position), blueprintPlacementId);
      const blueprintName = gameRef.current.blueprints.find((blueprint) => blueprint.id === blueprintPlacementId)?.name ?? "蓝图";
      commitGame((current) => {
        const next = canPlaceBlueprint(current, blueprintPlacementId)
          ? placeBlueprint(current, blueprintPlacementId, position)
          : canQueueBlueprint(current, blueprintPlacementId)
            ? queueBlueprint(current, blueprintPlacementId, position)
            : current;
        if (next !== current && !canPlaceBlueprint(next, blueprintPlacementId)) setBlueprintPlacementId(null);
        return next;
      });
      if (deployable) playTone("place");
      else if (compatible) setBlueprintPlacementId(null);
      setSelectedEntityIds([]);
      setNotice(deployable
        ? `${blueprintName}部署完成${canContinue ? " · 可继续粘贴" : ""}`
        : compatible ? `${blueprintName}已加入施工队列，材料齐备后自动部署` : `${blueprintName}与当前行星不兼容`);
      return;
    }
    if (!selectionMode && !connectionDraft && !placement) {
      const flowPoint = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const nodeById = new Map(nodes.map((node) => [node.id, node]));
      let nearest: { beltId: string; distance: number } | null = null;
      for (const belt of gameRef.current.belts.filter((candidate) => candidate.planetId === gameRef.current.activePlanetId)) {
        const source = nodeById.get(belt.source);
        const target = nodeById.get(belt.target);
        if (!source || !target) continue;
        const sourceWidth = source.measured?.width ?? 256;
        const sourceHeight = source.measured?.height ?? 180;
        const targetWidth = target.measured?.width ?? 256;
        const targetHeight = target.measured?.height ?? 180;
        const start = { x: source.position.x + sourceWidth / 2, y: source.position.y + sourceHeight / 2 };
        const end = { x: target.position.x + targetWidth / 2, y: target.position.y + targetHeight / 2 };
        const distance = distanceToSegment(flowPoint, start, end);
        if (!nearest || distance < nearest.distance) nearest = { beltId: belt.id, distance };
      }
      if (nearest && nearest.distance <= 42 / Math.max(0.3, viewportZoom)) {
        setSelectedBeltId(nearest.beltId);
        setSelectedBeltIds([nearest.beltId]);
        setSelectedEntityIds([]);
        setInspectorTab("inspect");
        if (nextMobileShell) mobileNavigation.openSheet("inspector", "peek");
        else setMobilePanel("inspector");
        return;
      }
    }
    if (placement) {
      const continuousTarget = (nextMobileShell ? mobileContinuousPlacement : event.ctrlKey || ctrlHeldRef.current) ? continuousPlacementRef.current : null;
      if (continuousTarget && continuousTarget.buildingId === placement && continuousTarget.planetId === gameRef.current.activePlanetId) {
        const result = expandEntityGroup(continuousTarget.entityId, 1, { x: event.clientX, y: event.clientY });
        if (!result) {
          continuousPlacementRef.current = null;
          setPlacement(null);
          setNotice(`材料不足，${getBuilding(placement).name}连续扩建结束`);
          return;
        }
        setPlacementCount(1);
        if (result.remaining >= 1) {
          setNotice(`${result.name}已扩建至 ×${result.count} · Ctrl 连续扩建中`);
        } else {
          continuousPlacementRef.current = null;
          setPlacement(null);
          setNotice(`${result.name}已扩建至 ×${result.count} · 材料不足，连续扩建结束`);
        }
        return;
      }
      if (getBuilding(placement).kind === "miner") {
        setNotice(minerPlacementHint(placement));
        return;
      }
      const position = snapFlowPosition(screenToFlowPosition({ x: event.clientX, y: event.clientY }));
      const placedState = placeBuilding(gameRef.current, placement, position, placementCount);
      if (placedState === gameRef.current) {
        setNotice("材料不足或当前位置无法放置");
        setPlacement(null);
        playTone("alert");
        return;
      }
      playTone("place");
      trackAnalyticsEvent("building_place", placementCount);
      spawnInteractionBurst(event.clientX, event.clientY, "建筑已放置", "positive");
      const placedEntityId = `entity_${gameRef.current.nextId}`;
      commitGame((current) => placeBuilding(current, placement, position, placementCount));
      const keepContinuous = nextMobileShell ? mobileContinuousPlacement : event.ctrlKey || ctrlHeldRef.current;
      const remaining = placedState.construction[placement] ?? 0;
      if (keepContinuous && remaining >= 1) {
        continuousPlacementRef.current = { entityId: placedEntityId, buildingId: placement, planetId: gameRef.current.activePlanetId };
        setPlacementCount(1);
        setNotice(`已放置${getBuilding(placement).name} ×${placementCount} · Ctrl 连续扩建中`);
      } else {
        continuousPlacementRef.current = null;
        setPlacement(null);
        if (keepContinuous) setNotice(`已放置${getBuilding(placement).name} · 材料不足，连续扩建结束`);
      }
      return;
    }
    setSelectedEntityIds([]);
    setSelectedBeltId(null);
    setSelectedBeltIds([]);
    if (nextMobileShell && mobileNavigation.overlay?.kind === "sheet" && mobileNavigation.overlay.id === "inspector") mobileNavigation.requestBack();
  }, [blueprintPlacementId, commitGame, completeClickConnectionAtPoint, connectionDraft, expandEntityGroup, flowStore, mobileContinuousPlacement, mobileNavigation.openSheet, mobileNavigation.overlay, mobileNavigation.requestBack, nextMobileShell, nodes, placement, placementCount, playTone, regionMode, screenToFlowPosition, selectionMode, spawnInteractionBurst, viewportZoom]);

  const onCanvasDrop = useCallback((event: React.DragEvent) => {
    const buildingId = event.dataTransfer.getData("application/factory-building") as BuildingId;
    if (!buildingId) return;
    event.preventDefault();
    if (getBuilding(buildingId).kind === "miner") {
      setNotice(minerPlacementHint(buildingId));
      return;
    }
    const position = snapFlowPosition(screenToFlowPosition({ x: event.clientX, y: event.clientY }));
    if (placeBuilding(gameRef.current, buildingId, position, placementCount) !== gameRef.current) {
      playTone("place");
      trackAnalyticsEvent("building_place", placementCount);
    }
    commitGame((current) => placeBuilding(current, buildingId, position, placementCount));
    setPlacement(null);
  }, [commitGame, placementCount, playTone, screenToFlowPosition]);

  const selectedEntities = game.entities.filter((entity) => selectedEntityIds.includes(entity.id) && entity.planetId === game.activePlanetId);
  const selectedEntity = selectedEntities.length === 1 ? selectedEntities[0] : null;
  const selectedBelt = game.belts.find((belt) => belt.id === selectedBeltId && belt.planetId === game.activePlanetId) ?? null;
  const selectedBelts = game.belts.filter((belt) => selectedBeltIds.includes(belt.id) && belt.planetId === game.activePlanetId);
  const dockBeltTier = resolveConnectionBeltTier(game, beltTierMode, beltTier);
  const blueprintEligibleIds = getBlueprintEligibleEntityIds(game, selectedEntityIds);
  const activeBlueprint = game.blueprints.find((blueprint) => blueprint.id === blueprintPlacementId) ?? null;
  const mobileActionEntity = game.entities.find((entity) => entity.id === mobileActionEntityId) ?? null;

  const copyEntitiesAsBlueprint = (entityIds: readonly string[]) => {
    const eligibleIds = getBlueprintEligibleEntityIds(gameRef.current, [...entityIds]);
    if (eligibleIds.length === 0) {
      setNotice("选区中没有可复制的设备");
      return;
    }
    const blueprintId = `blueprint_${gameRef.current.nextId}`;
    commitGame((current) => createBlueprint(current, eligibleIds));
    setBlueprintPlacementId(blueprintId);
    setPlacement(null);
    setSelectionMode(false);
    setRegionMode(false);
    setNotice(`已复制 ${eligibleIds.length} 个设备，点击画布粘贴蓝图`);
  };

  const copySelectionAsBlueprint = () => copyEntitiesAsBlueprint(selectedEntityIds);

  const deployBlueprint = (blueprintId: string) => {
    setBlueprintPlacementId(blueprintId);
    setBlueprintsOpen(false);
    setDysonPlannerOpen(false);
    setPlacement(null);
    setSelectionMode(false);
    setRegionMode(false);
    setSelectedEntityIds([]);
    setNotice("点击画布确定蓝图部署位置");
  };

  const handleQuickCraftConstruction = (buildingId: ConstructionId) => {
    const before = gameRef.current;
    const plan = getConstructionQuickCraftPlan(before, buildingId);
    const after = craftConstructionWithUpstream(before, buildingId);
    if (after === before) {
      setNotice("制造失败：材料或科技不足");
      playTone("alert");
      return;
    }
    commitGame((current) => craftConstructionWithUpstream(current, buildingId));
    const consumed = plan.consumedItems.map((item) => `${ITEMS[item.itemId].name}×${item.amount}`);
    const consumedLabel = consumed.length > 3 ? `${consumed.slice(0, 3).join("、")}等${consumed.length}种材料` : consumed.join("、");
    setNotice(`${getConstructionDefinition(buildingId)?.name ?? "建筑"}已制造${consumedLabel ? ` · 已消耗${consumedLabel}` : ""}`);
    spawnInteractionBurst(pointerRef.current.x, pointerRef.current.y, consumedLabel ? `已消耗 ${consumedLabel}` : "制造完成", "positive");
    playTone("confirm");
  };

  const handleQuickCraftFleet = (recipeId: RecipeId) => {
    const before = gameRef.current;
    const after = handcraftRecipe(before, recipeId, 1);
    if (after === before) {
      setNotice("制造失败：材料或科技不足");
      playTone("alert");
      return;
    }
    commitGame((current) => handcraftRecipe(current, recipeId, 1));
    setNotice(`${RECIPES[recipeId]?.name ?? "载具"}已制造并收入随身载具栏`);
    spawnInteractionBurst(pointerRef.current.x, pointerRef.current.y, "载具入库", "positive");
    playTone("confirm");
  };

  const handleMissingConstructionCraft = (buildingId: ConstructionId) => {
    const result = getConstructionCraftNavigation(gameRef.current, buildingId);
    if (result.status !== "target") {
      const message = result.status === "technology"
        ? `缺少科技：${result.technologyName}`
        : result.status === "raw-shortage"
          ? `${ITEMS[result.itemId].name}属于原始资源，当前 ${result.current}/${result.required}，请先采集`
          : result.status === "no-handcraft"
            ? `${ITEMS[result.itemId].name}没有可用的手工配方`
            : "材料已经满足，可直接制造建筑";
      setNotice(message);
      playTone(result.status === "ready" ? "confirm" : "alert");
      return;
    }
    setFabricatorFocusItemId(result.itemId);
    setInspectorTab("fabricate");
    if (nextMobileShell) mobileNavigation.openSheet("inspector", "full");
    else setMobilePanel("inspector");
    setNotice(`已定位可手工补足的上游材料：${ITEMS[result.itemId].name}`);
  };

  const openMobileSheet = (id: "build" | "inventory" | "inspector" | "planet" | "tools") => {
    if (nextMobileShell && mobileNavigation.overlay?.kind === "sheet" && mobileNavigation.overlay.id === id) {
      mobileNavigation.requestBack();
      setNotice(null);
      return;
    }
    mobileNavigation.openSheet(id);
    if (!nextMobileShell) setMobilePanel(id === "inventory" ? "resources" : id === "inspector" ? "inspector" : null);
    setNotice(null);
  };

  const openMobileWorkspace = (id: MobileWorkspaceId) => {
    setNotice(null);
    if (nextMobileShell && activeMobileWorkspace === id) {
      closeAllWorkspaces();
      mobileNavigation.goFactory();
      return;
    }
    if (id === "construction-center") {
      closeAllWorkspaces();
      setConstructionCenterOpen(true);
      setMobilePanel(null);
      mobileNavigation.openWorkspace(id);
      return;
    }
    openCommandWorkspace(id);
    if (id === "technology") setCampaignFocusTechId(null);
    if (id === "statistics") setStatisticsFocusTab(null);
    if (id === "recipes") setCampaignFocusItemId(null);
  };

  const openMobileStatistics = (tab: StatisticsTab) => {
    setNotice(null);
    if (statisticsOpen && statisticsFocusTab === tab) {
      closeAllWorkspaces();
      mobileNavigation.goFactory();
      return;
    }
    openCommandWorkspace("statistics");
    setStatisticsFocusTab(tab);
  };

  const openMobileOperations = (tab: OperationsTab) => {
    setNotice(null);
    if (operationsOpen && operationsTab === tab) {
      closeAllWorkspaces();
      mobileNavigation.goFactory();
      return;
    }
    openCommandWorkspace("operations");
    setOperationsTab(tab);
  };

  const openMobileGalaxy = (tab: "ranking" | "cloud" | "account") => {
    setNotice(null);
    if (galaxyOpen && galaxyFocusTab === tab) {
      closeAllWorkspaces();
      mobileNavigation.goFactory();
      return;
    }
    setGalaxyFocusTab(tab);
    openCommandWorkspace("galaxy");
  };

  const switchToLegacyMobileUi = () => {
    mobileNavigation.goFactory();
    setMobileUiPreference("legacy");
    setNotice("已切换到经典手机界面，可随时再次体验新版");
  };

  const mobileOverlayId = mobileNavigation.overlay?.kind === "sheet" ? mobileNavigation.overlay.id : mobileNavigation.overlay?.kind === "modal" ? "exit" : "none";
  const mobileSheetSnap = mobileNavigation.overlay?.kind === "sheet" ? mobileNavigation.overlay.snap : "none";
  const mobileRouteId = mobileNavigation.route.kind;
  const mobileWorkspaceSubview = mobileNavigation.route.kind === "workspace" ? mobileNavigation.route.subview ?? null : null;
  const headerActiveWorkspace = operationsOpen && operationsTab === "settings" ? "settings"
    : galaxyOpen ? "galaxy"
      : campaignOpen ? "campaign"
        : constructionCenterOpen ? "construction-center"
          : starMapOpen ? "star-map"
            : statisticsOpen ? "statistics"
              : recipesOpen ? "recipes"
                : technologyOpen ? "technology"
                  : null;

  return (
    <main
      className={`game-shell${placement || blueprintPlacementId ? " game-shell--placing" : ""}${selectionMode ? " game-shell--selecting" : ""}${regionMode ? " game-shell--regioning" : ""}${mobilePanel ? ` mobile-panel--${mobilePanel} mobile-panel-stage--${mobilePanelStage}` : ""}${leftSidebarCollapsed ? " sidebar-left-collapsed" : ""}${rightSidebarCollapsed ? " sidebar-right-collapsed" : ""}`}
      onContextMenuCapture={(event) => {
        const target = event.target as HTMLElement | null;
        if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
        event.preventDefault();
      }}
      data-reduced-motion={game.settings.reducedMotion ? "true" : "false"}
      data-performance-mode={performanceVisualMode ? "true" : "false"}
      data-performance-auto={automaticPerformanceMode ? "true" : "false"}
      data-mobile-performance={mobilePerformanceMode ? "true" : "false"}
      data-simulation-worker={simulationWorkerActive ? "active" : "fallback"}
      data-difficulty={game.settings.difficulty}
      data-zoom-lod={largeFactoryMode || viewportZoom < 0.55 ? "compact" : viewportZoom < 0.86 ? "medium" : "full"}
      data-large-factory={largeFactoryMode ? "true" : "false"}
      data-network-heatmap={game.settings.beltHeatmapEnabled ? "true" : "false"}
      data-coarse-pointer={coarsePointer ? "true" : "false"}
      data-mobile-ui={mobileUiPreference}
      data-mobile-shell={nextMobileShell ? "true" : "false"}
      data-compact-layout={compactLayout.mode}
      data-mobile-route={mobileRouteId}
      data-mobile-subview={mobileWorkspaceSubview ?? "none"}
      data-mobile-overlay={mobileOverlayId}
      data-mobile-sheet-snap={mobileSheetSnap}
      data-mobile-canvas-mode={activeMobileCanvasMode}
      data-minimap-open={!minimapCollapsed ? "true" : "false"}
      style={{ "--mobile-panel-drag": `${mobilePanelSwipe.offset}px` } as CSSProperties}
    >
      <HeaderControls
        game={game}
        activeWorkspace={headerActiveWorkspace}
        onReturnToMenu={returnToMenuSafely}
        onOpenCampaign={() => {
          if (campaignOpen) closeAllWorkspaces();
          else openCampaign();
        }}
        onPauseToggle={togglePause}
        showMobileUiSwitch={compactLayout.isMobileShell && mobileUiPreference === "legacy"}
        onMobileUiSwitch={() => {
          setMobileUiPreference("next");
          setNotice("新版手机界面已启用，可在更多工作区切回经典界面");
        }}
        onOpenConstructionCenter={() => {
          if (constructionCenterOpen) {
            closeAllWorkspaces();
            setNotice(null);
            return;
          }
          closeAllWorkspaces();
          setConstructionCenterOpen(true);
          setMobilePanel(null);
        }}
        onOpenGalaxy={() => {
          if (galaxyOpen) {
            closeAllWorkspaces();
            setNotice(null);
            return;
          }
          openCommandWorkspace("galaxy");
          setMobilePanel(null);
          setNotice(null);
        }}
        onOpenSettings={() => {
          if (operationsOpen && operationsTab === "settings") {
            closeAllWorkspaces();
            setNotice(null);
            return;
          }
          openCommandWorkspace("operations");
          setOperationsTab("settings");
          setMobilePanel(null);
          setNotice(null);
        }}
        onOpenCommandPalette={openCommandPalette}
        onOpenResources={() => { setMobilePanel((current) => current === "resources" ? null : "resources"); setNotice(null); }}
        onOpenInspector={() => { setMobilePanel((current) => current === "inspector" ? null : "inspector"); setNotice(null); }}
        onOpenRecipes={() => { if (recipesOpen) closeAllWorkspaces(); else openCommandWorkspace("recipes"); setCampaignFocusItemId(null); setNotice(null); }}
        onOpenTechnology={() => { if (technologyOpen) closeAllWorkspaces(); else openCommandWorkspace("technology"); setCampaignFocusTechId(null); setNotice(null); }}
        onOpenStatistics={() => { if (statisticsOpen) closeAllWorkspaces(); else openCommandWorkspace("statistics"); setStatisticsFocusTab(null); setNotice(null); }}
        onOpenStarMap={() => { if (starMapOpen) closeAllWorkspaces(); else openCommandWorkspace("star-map"); setNotice(null); }}
      />
      <MobileGameShell
        enabled={nextMobileShell}
        layout={compactLayout}
        game={game}
        alerts={alerts}
        route={mobileNavigation.route}
        overlay={mobileNavigation.overlay}
        hasConstructionCenter={game.entities.some((entity) => entity.buildingId === "construction_center")}
        tools={{
          mode: activeMobileCanvasMode,
          blueprintCount: game.blueprints.length,
          beltCount: game.belts.filter((belt) => belt.planetId === game.activePlanetId).length,
          regionCount: game.canvasRegions.filter((region) => region.planetId === game.activePlanetId).length,
          canUndo: undoStackRef.current.length > 0,
          canRedo: redoStackRef.current.length > 0,
          canUndoAutoLayout: Boolean(autoLayoutUndo && autoLayoutUndo.planetId === game.activePlanetId),
          minimapOpen: !minimapCollapsed,
        }}
        toolActions={{
          onBrowse: () => {
            setMobileCanvasMode("browse");
            setSelectionMode(false);
            setRegionMode(false);
            setRegionDraft(null);
            setPlacement(null);
            setBlueprintPlacementId(null);
          },
          onSelect: () => {
            setMobileCanvasMode("select");
            setSelectionMode(true);
            setRegionMode(false);
            setRegionDraft(null);
            setPlacement(null);
            setBlueprintPlacementId(null);
          },
          onRegion: () => {
            setMobileCanvasMode("region");
            setRegionMode(true);
            setRegionDraft(null);
            setSelectionMode(false);
            setPlacement(null);
            setBlueprintPlacementId(null);
            setSelectedEntityIds([]);
            setSelectedBeltIds([]);
            setSelectedBeltId(null);
            setNotice("在空白画布拖拽创建生产区域");
          },
          onLayout: () => {
            setMobileCanvasMode("layout");
            setSelectionMode(false);
            setRegionMode(false);
            setRegionDraft(null);
            setPlacement(null);
            setBlueprintPlacementId(null);
            setNotice("布局模式：拖动节点可调整位置，空白区域仍可平移画布");
          },
          onOpenBlueprints: () => openMobileWorkspace("blueprints"),
          onOpenNetworks: () => openMobileStatistics("networks"),
          onAutoLayout: () => autoLayoutEntities(),
          onUndoAutoLayout: undoAutoLayout,
          onUndo: undoGame,
          onRedo: redoGame,
          onZoomIn: () => void zoomIn({ duration: game.settings.reducedMotion ? 0 : 140 }),
          onZoomOut: () => void zoomOut({ duration: game.settings.reducedMotion ? 0 : 140 }),
          onFitView: () => void fitView({ padding: .18, duration: game.settings.reducedMotion ? 0 : 220 }),
          onToggleMinimap: () => setMinimapCollapsed((collapsed) => !collapsed),
        }}
        factory={{
          placement,
          beltTier: dockBeltTier,
          beltTierMode,
          selectedEntity,
          selectedBelt,
          selectedCount: selectedEntities.length,
        }}
        factoryActions={{
          onPlacement: (buildingId) => {
            setPlacement(buildingId);
            setBlueprintPlacementId(null);
            setSelectionMode(false);
            setRegionMode(false);
            setRegionDraft(null);
            setSelectedEntityIds([]);
            setMobileCanvasMode("browse");
            mobileNavigation.goFactory();
          },
          onBelt: (tier) => {
            setBeltTierMode("manual");
            setBeltTier(tier);
            setPlacement(null);
            setMobileCanvasMode("browse");
            mobileNavigation.goFactory();
            setNotice(`已选择传送带 Mk.${tier === 3 ? "III" : tier === 2 ? "II" : "I"}，点击输出端口开始连接`);
          },
          onCraft: handleQuickCraftConstruction,
          onCraftFleet: handleQuickCraftFleet,
          onMissingCraft: handleMissingConstructionCraft,
          onPickTray: (itemId) => setGame((current) => pickFromTray(current, itemId)),
          onDropCargo: () => setGame((current) => dropCargoToTray(current)),
          onFocusSelection: () => {
            if (selectedEntityIds.length > 0) focusEntityIds(selectedEntityIds);
            else if (selectedBeltId) focusBeltNetwork(selectedBeltId);
          },
          onAddEntity: quickAddEntity,
          onUpgradeEntity: (entityId) => {
            commitGame((current) => upgradeEntity(current, entityId));
            setNotice("设备升级完成");
            playTone("upgrade");
          },
          onUpgradeBelt: (beltId) => {
            commitGame((current) => upgradeBelt(current, beltId));
            setNotice("运输线升级完成");
            playTone("upgrade");
          },
        }}
        onFactory={() => {
          if (mobileNavigation.route.kind === "factory" && !mobileNavigation.overlay) {
            void fitView({ padding: .18, duration: game.settings.reducedMotion ? 0 : 220 });
          } else {
            mobileNavigation.goFactory();
          }
        }}
        onOpenHub={() => { setNotice(null); if (mobileNavigation.route.kind === "hub") mobileNavigation.goFactory(); else mobileNavigation.openHub(); }}
        onOpenSheet={openMobileSheet}
        onSheetSnap={mobileNavigation.setSheetSnap}
        onOpenWorkspace={openMobileWorkspace}
        onOpenStatistics={openMobileStatistics}
        onOpenOperations={openMobileOperations}
        onOpenGalaxy={openMobileGalaxy}
        onOpenCommandPalette={() => {
          openCommandPalette();
        }}
        onBack={mobileNavigation.requestBack}
        onTogglePause={togglePause}
        onPlanetChange={onPlanetChange}
        onConfirmExit={returnToMenuSafely}
        onDismissExit={mobileNavigation.dismissExit}
        onRequestExit={mobileNavigation.requestExit}
        onSwitchLegacy={switchToLegacyMobileUi}
      />
      {nextMobileShell && mobileNavigation.route.kind === "factory" && !mobileNavigation.overlay ? <MobilePlacementBar
        mode={activeMobileCanvasMode}
        buildingId={placement}
        inventory={placement ? Math.floor(game.construction[placement] ?? 0) : 0}
        placementCount={placementCount}
        continuous={mobileContinuousPlacement}
        connectionLabel={connectionHint?.label ?? (connectionDraft ? `${ITEMS[connectionDraft.itemId].name}${connectionDraft.handleType === "source" ? "输出" : "输入"}：请选择匹配端口` : null)}
        selectionCount={selectedEntityIds.length}
        beltCount={selectedBeltIds.length}
        onCountChange={setPlacementCount}
        onContinuousChange={setMobileContinuousPlacement}
        onCancel={() => {
          if (activeMobileCanvasMode === "connect") {
            flowStore.getState().cancelConnection();
            flowStore.setState({ connectionClickStartHandle: null });
            clickConnectionPreviewRef.current = null;
            setClickConnectionPreview(null);
            setClickConnectionTone("pending");
            setClickConnectionSnapPoint(null);
            updateConnectionDraft(null);
            setConnectionHint(null);
          }
          setPlacement(null);
          setMobileContinuousPlacement(false);
          setMobileCanvasMode("browse");
        }}
        onDone={() => {
          setSelectionMode(false);
          setRegionMode(false);
          setRegionDraft(null);
          setMobileCanvasMode("browse");
        }}
        onOpenInspector={() => mobileNavigation.openSheet("inspector", "half")}
      /> : null}
      {nextMobileShell && mobileNavigation.route.kind === "factory" && !mobileNavigation.overlay && activeMobileCanvasMode === "select" ? <MobileSelectionContextBar
        selectedCount={selectedEntityIds.length}
        beltCount={selectedBeltIds.length}
        canUpgrade={canUpgradeEntities(game, selectedEntityIds)}
        canUpgradeBelts={selectedBelts.some((belt) => canUpgradeBelt(game, belt.id))}
        onFocus={() => focusEntityIds(selectedEntityIds)}
        onCopy={copySelectionAsBlueprint}
        onUpgrade={() => {
          commitGame((current) => upgradeEntities(current, selectedEntityIds));
          setNotice("已批量升级选区内可升级设备");
          playTone("upgrade");
        }}
        onUpgradeBelts={() => {
          commitGame((current) => selectedBeltIds.reduce((next, beltId) => upgradeBelt(next, beltId), current));
          setNotice(`已升级选区内 ${selectedBeltIds.length} 条传送带`);
          playTone("upgrade");
        }}
        onRemove={() => {
          if (!window.confirm(`确认回收 ${selectedEntityIds.length} 个节点和 ${selectedBeltIds.length} 条线路？`)) return;
          commitGame((current) => selectedBeltIds.reduce((next, beltId) => removeBelt(next, beltId), removeEntities(current, selectedEntityIds)));
          setSelectedEntityIds([]);
          setSelectedBeltIds([]);
          setSelectedBeltId(null);
          setNotice("选区设备与运输线已回收至施工托盘");
          playTone("remove");
        }}
        onClear={() => { setSelectedEntityIds([]); setSelectedBeltIds([]); setSelectedBeltId(null); }}
      /> : null}
      <div className="game-workspace">
        <ResourceRail
          game={game}
          onOpenCampaign={openCampaign}
          onOpenDysonPlanner={() => {
            if (dysonPlannerOpen) closeAllWorkspaces();
            else openCommandWorkspace("dyson");
          }}
          onPickTray={(itemId) => setGame((current) => pickFromTray(current, itemId))}
          onDropCargo={() => setGame((current) => dropCargoToTray(current))}
          onSetTrayItemLimit={(value) => setGame((current) => setPlanetTrayItemLimit(current, current.activePlanetId, value))}
          onDropDraggedItem={(itemId, sourceKind, sourceId) => {
            if (sourceKind === "node" && sourceId) {
              setGame((current) => moveEntityOutputToTray(current, sourceId, itemId));
            } else if (sourceKind === "node-input" && sourceId) {
              setGame((current) => moveEntityInputToTray(current, sourceId, itemId));
            }
          }}
        />
        <section
            className="factory-canvas"
            aria-label="生产网络画布"
            ref={factoryCanvasRef}
            onPointerDownCapture={(event) => {
              longPressBindings.onPointerDownCapture?.(event);
              if (beginCanvasMultiTouch(event)) return;
              onRegionPointerDown(event);
            }}
            onPointerMoveCapture={(event) => {
              if (moveCanvasMultiTouch(event)) return;
              longPressBindings.onPointerMoveCapture?.(event);
              onRegionPointerMove(event);
            }}
            onPointerUpCapture={(event) => {
              longPressBindings.onPointerUpCapture?.(event);
              if (endCanvasMultiTouch(event)) return;
              finishRegionPointer(event);
            }}
            onPointerCancelCapture={(event) => {
              if (syntheticTouchCancelRef.current) return;
              longPressBindings.onPointerCancelCapture?.(event);
              if (endCanvasMultiTouch(event)) return;
              finishRegionPointer(event, true);
            }}
          onClickCapture={(event) => {
            if (!placement && !blueprintPlacementId && clickConnectionPreviewRef.current &&
              completeClickConnectionAtPoint(event.clientX, event.clientY)) {
              event.preventDefault();
              event.stopPropagation();
              return;
            }
            if (!placement && !blueprintPlacementId) return;
            const target = event.target instanceof Element ? event.target : null;
            if (!target?.closest(".react-flow") || target.closest(".react-flow__node, .react-flow__controls, .react-flow__minimap, .canvas-selection-tools, .planet-navigator")) return;
            event.preventDefault();
            event.stopPropagation();
            onPaneClick(event);
          }}
          onDoubleClick={(event) => {
            if (game.settings.allowDoubleClickZoom && !regionMode && event.target instanceof Element && event.target.classList.contains("react-flow__pane") && !placement && !blueprintPlacementId) {
              void fitView({ padding: 0.18, duration: game.settings.reducedMotion ? 0 : 260 });
            }
          }}
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            onNodesChange={onNodesChange}
            onSelectionChange={onSelectionChange}
            onConnect={onConnect}
            onConnectStart={onConnectStart}
            onConnectEnd={onConnectEnd}
            onClickConnectStart={onClickConnectStart}
            onClickConnectEnd={onClickConnectEnd}
            isValidConnection={isValidConnection}
            onNodeClick={onNodeClick}
            onNodeDoubleClick={onNodeDoubleClick}
            onNodeDragStart={() => { if (!blockCanvasTouchRef.current) nodeDragActiveRef.current = true; }}
            onNodeDrag={onNodeDrag}
            onNodeDragStop={(_event, node, draggedNodes) => {
              nodeDragActiveRef.current = false;
              setAlignmentGuides({ x: null, y: null });
              if (blockCanvasTouchRef.current) {
                restoreCanvasEntityPositions();
                return;
              }
              const moved = draggedNodes.length > 0 ? draggedNodes : [node];
              const positions = moved.map((candidate) => ({ id: candidate.id, position: snapFlowPosition(candidate.position) }));
              window.requestAnimationFrame(() => commitGame((current) => moveEntities(current, positions)));
            }}
            onEdgeClick={(_event, edge) => {
              if (nextMobileShell && mobileCanvasMode === "select") {
                setSelectedBeltIds((current) => current.includes(edge.id) ? current.filter((id) => id !== edge.id) : [...current, edge.id]);
                setSelectedBeltId(null);
                return;
              }
              setSelectedBeltId(edge.id);
              setSelectedBeltIds([edge.id]);
              setSelectedEntityIds([]);
              setInspectorTab("inspect");
              if (nextMobileShell) mobileNavigation.openSheet("inspector", "peek");
              else setMobilePanel("inspector");
            }}
            onEdgeDoubleClick={(_event, edge) => {
              setFocusedBeltNetworkId((current) => current === edge.id ? null : edge.id);
              setHighlightedTaskId(null);
              const snapshot = analyzeBeltNetwork(gameRef.current, edge.id);
              if (snapshot) focusEntityIds(snapshot.entityIds);
            }}
            onPaneClick={onPaneClick}
            onDrop={onCanvasDrop}
            onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }}
            minZoom={0.25}
            maxZoom={1.8}
            connectionRadius={coarsePointer ? 56 : 30}
            snapToGrid
            snapGrid={[FLOW_GRID, FLOW_GRID]}
            autoPanOnConnect={!coarsePointer}
            autoPanOnNodeDrag={!coarsePointer}
            connectionLineStyle={{ stroke: "#62b5ae", strokeWidth: 2, strokeDasharray: "6 5" }}
            connectionLineComponent={FactoryConnectionLine}
            connectOnClick
            defaultViewport={initialViewport}
            onMove={(_event, viewport) => {
              viewportRef.current = viewport;
              setViewportZoom(viewport.zoom);
            }}
            onMoveEnd={(_event, viewport) => persistPlanetViewport(gameRef.current.activePlanetId, viewport)}
            panOnScroll
            panOnDrag={regionMode ? false : coarsePointer ? true : [1, 2]}
            zoomOnPinch={!coarsePointer}
            selectionOnDrag={selectionMode && !coarsePointer}
            selectionMode={SelectionMode.Full}
            selectionKeyCode={null}
            multiSelectionKeyCode="Shift"
            elementsSelectable={!(coarsePointer && selectionMode)}
            nodesDraggable={nextMobileShell ? mobileCanvasMode === "layout" : !(coarsePointer && selectionMode)}
            zoomOnDoubleClick={false}
            deleteKeyCode={null}
            fitViewOptions={{ padding: 0.18 }}
            onlyRenderVisibleElements={performanceVisualMode}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1.1} color={resolvedTheme === "light" ? "#b7c8bf" : "#3c4743"} />
            <ViewportPortal>
              <CanvasRegionLayer
                regions={canvasGame.canvasRegions.filter((region) => region.planetId === canvasGame.activePlanetId)}
                draft={regionDraft}
                selectedRegionId={selectedRegionId}
                resizePreview={regionResizePreview}
                resizeHandleSize={(coarsePointer ? 34 : 14) / Math.max(0.25, viewportZoom)}
                onSelect={(regionId) => { setSelectedRegionId(regionId); setRegionMode(false); }}
                onResizeStart={onRegionResizeStart}
              />
              {alignmentGuides.x != null ? <i className="alignment-guide alignment-guide--vertical" style={{ left: alignmentGuides.x }} /> : null}
              {alignmentGuides.y != null ? <i className="alignment-guide alignment-guide--horizontal" style={{ top: alignmentGuides.y }} /> : null}
            </ViewportPortal>
            {!minimapCollapsed ? <MiniMap
              pannable
              zoomable
              nodeColor={(node) => node.type === "vein" ? ITEMS[(node.data as FactoryNodeData).entity.resourceId!].color : node.type === "power" ? "#e1b452" : node.type === "station" ? "#d8794d" : node.type === "storage" ? "#8aa69d" : node.type === "splitter" ? "#d2aa5b" : "#61a9a4"}
              maskColor={resolvedTheme === "light" ? "rgba(218, 229, 223, 0.76)" : "rgba(8, 11, 10, 0.76)"}
            /> : null}
            <Controls position="bottom-left" showInteractive={false} />
          </ReactFlow>
          {clickConnectionPreview ? <ClickConnectionPreview preview={clickConnectionPreview} pointer={clickConnectionSnapPoint ?? pointer} tone={clickConnectionTone} /> : null}
          <button className={`canvas-minimap-toggle nodrag nopan${minimapCollapsed ? " canvas-minimap-toggle--collapsed" : ""}`} type="button" onClick={() => setMinimapCollapsed((collapsed) => !collapsed)} title={minimapCollapsed ? "展开小地图" : "折叠小地图"} aria-label={minimapCollapsed ? "展开小地图" : "折叠小地图"} aria-expanded={!minimapCollapsed}>
            {minimapCollapsed ? <MapIcon size={16} /> : <PanelRightClose size={16} />}
          </button>
          <PlanetNavigator game={game} onPlanetChange={onPlanetChange} />
          <CanvasSelectionTools
            selectionMode={selectionMode}
            regionMode={regionMode}
            blueprintCount={game.blueprints.length}
            beltCount={game.belts.filter((belt) => belt.planetId === game.activePlanetId).length}
            regionCount={game.canvasRegions.filter((region) => region.planetId === game.activePlanetId).length}
            canUndo={undoStackRef.current.length > 0}
            canRedo={redoStackRef.current.length > 0}
            canUndoAutoLayout={Boolean(autoLayoutUndo && autoLayoutUndo.planetId === game.activePlanetId)}
            leftSidebarCollapsed={leftSidebarCollapsed}
            rightSidebarCollapsed={rightSidebarCollapsed}
            onUndo={undoGame}
            onRedo={redoGame}
            onToggleLeftSidebar={() => setLeftSidebarCollapsed((collapsed) => !collapsed)}
            onToggleRightSidebar={() => setRightSidebarCollapsed((collapsed) => !collapsed)}
            onModeChange={(enabled) => {
              setSelectionMode(enabled);
              setRegionMode(false);
              setRegionDraft(null);
              setPlacement(null);
              setBlueprintPlacementId(null);
              if (!enabled) {
                setSelectedEntityIds([]);
                setSelectedBeltIds([]);
                setSelectedBeltId(null);
              }
            }}
            onRegionModeChange={(enabled) => {
              setRegionMode(enabled);
              setRegionDraft(null);
              setSelectionMode(false);
              setPlacement(null);
              setBlueprintPlacementId(null);
              setSelectedEntityIds([]);
              setSelectedBeltIds([]);
              setSelectedBeltId(null);
              if (enabled) setNotice("在空白画布拖拽创建生产区域");
            }}
            onOpenBlueprints={() => {
              if (blueprintsOpen) closeAllWorkspaces();
              else openCommandWorkspace("blueprints");
              setSelectionMode(false);
              setRegionMode(false);
              setMobilePanel(null);
            }}
            onOpenNetworks={() => {
              if (statisticsOpen && statisticsFocusTab === "networks") closeAllWorkspaces();
              else {
                openCommandWorkspace("statistics");
                setStatisticsFocusTab("networks");
              }
              setSelectionMode(false);
              setRegionMode(false);
              setMobilePanel(null);
              setNotice(null);
            }}
            onAutoLayout={() => autoLayoutEntities()}
            onUndoAutoLayout={undoAutoLayout}
          />
          {game.canvasRegions.find((region) => region.id === selectedRegionId && region.planetId === game.activePlanetId) ? <CanvasRegionEditor
            region={game.canvasRegions.find((region) => region.id === selectedRegionId && region.planetId === game.activePlanetId)!}
            onChange={(changes) => commitGame((current) => updateCanvasRegion(current, selectedRegionId!, changes))}
            onRemove={() => {
              commitGame((current) => removeCanvasRegion(current, selectedRegionId!));
              setSelectedRegionId(null);
              setNotice("生产区域已删除");
              playTone("remove");
            }}
            onClose={() => setSelectedRegionId(null)}
          /> : null}
          <SelectionToolbar
            selectedCount={selectedEntityIds.length}
            selectedBeltCount={selectedBelts.length}
            eligibleCount={blueprintEligibleIds.length}
            canUpgrade={canUpgradeEntities(game, selectedEntityIds)}
            canUpgradeBelts={selectedBelts.some((belt) => canUpgradeBelt(game, belt.id))}
            onFocus={() => focusEntityIds(selectedEntityIds)}
            onAutoLayout={() => autoLayoutEntities(selectedEntityIds)}
            onCopy={copySelectionAsBlueprint}
            onUpgrade={() => {
              commitGame((current) => upgradeEntities(current, selectedEntityIds));
              setNotice("已批量升级选区内可升级设备");
              playTone("upgrade");
            }}
            onUpgradeBelts={() => {
              commitGame((current) => selectedBeltIds.reduce((next, beltId) => upgradeBelt(next, beltId), current));
              setNotice(`已升级选区内 ${selectedBeltIds.length} 条可升级传送带，原连接保持不变`);
              playTone("upgrade");
            }}
            onRemove={() => {
              commitGame((current) => selectedBeltIds.reduce((next, beltId) => removeBelt(next, beltId), removeEntities(current, selectedEntityIds)));
              setSelectedEntityIds([]);
              setSelectedBeltIds([]);
              setSelectedBeltId(null);
              setNotice("选区设备与运输线已回收至施工托盘");
              playTone("remove");
            }}
            onClear={() => { setSelectedEntityIds([]); setSelectedBeltIds([]); setSelectedBeltId(null); }}
            onDone={() => {
              setSelectionMode(false);
              setSelectedEntityIds([]);
              setSelectedBeltIds([]);
              setSelectedBeltId(null);
            }}
          />
          {highlightedTaskId ? (
            <div className="task-path-indicator nodrag nopan">
              <span>任务生产路径</span>
              <strong>{getCampaignTask(highlightedTaskId)?.title}</strong>
              <em>{taskHighlight.entityIds.size} 节点 · {taskHighlight.beltIds.size} 线路</em>
              <button type="button" onClick={() => setHighlightedTaskId(null)} aria-label="关闭任务路径高亮">×</button>
            </div>
          ) : null}
          {focusedBeltNetwork ? (
            <div className={`network-focus-indicator network-focus-indicator--${focusedBeltNetwork.health} nodrag nopan`}>
              <span>连续运输网络</span>
              <strong>{ITEMS[focusedBeltNetwork.itemId].name}</strong>
              <em>{focusedBeltNetwork.beltIds.length} 线路 · {focusedBeltNetwork.entityIds.length} 节点 · {focusedBeltNetwork.label}</em>
              <button type="button" onClick={() => setFocusedBeltNetworkId(null)} aria-label="关闭运输网络聚焦">×</button>
            </div>
          ) : null}
          <div className="canvas-status">
            <span className={game.paused ? "paused" : "running"}>{game.paused ? "模拟暂停" : "实时运行"}</span>
            <strong>{getPlanet(game.activePlanetId).name} · {getPlanet(game.activePlanetId).code}工厂区</strong>
          </div>
          <RecipeFocusPanel
            game={game}
            onClear={() => onRecipeFocusChange(null)}
            onModeChange={(mode) => commitGame((current) => setRecipeFocusMode(current, mode))}
            onOpen={openRecipeFocus}
            onPositionChange={(position) => commitGame((current) => setRecipeFocusPosition(current, position))}
          />
        </section>
        <InspectorPanel
          game={game}
          fabricatorFocusItemId={fabricatorFocusItemId}
          selectedEntities={selectedEntities}
          selectedEntity={selectedEntity}
          selectedBelt={selectedBelt}
          focusedBeltNetworkId={focusedBeltNetworkId}
          tab={inspectorTab}
          onTabChange={setInspectorTab}
          onOpenConstructionCenter={() => {
            if (constructionCenterOpen) closeAllWorkspaces();
            else {
              closeAllWorkspaces();
              setConstructionCenterOpen(true);
            }
            setMobilePanel(null);
          }}
          onRecipeChange={onRecipeChange}
          onFuelChange={onFuelChange}
          onEnergyModeChange={onEnergyModeChange}
          onPowerGridChange={onPowerGridChange}
          onPowerPriorityChange={onPowerPriorityChange}
          onGenerationPriorityChange={onGenerationPriorityChange}
          onStationModeChange={(entityId, mode) => commitGame((current) => setStationMode(current, entityId, mode))}
          onStationVesselAdjust={(entityId, delta) => commitGame((current) => adjustStationVessels(current, entityId, delta))}
          onStationDroneAdjust={(entityId, delta) => commitGame((current) => adjustStationDrones(current, entityId, delta))}
          onStationWarperAdjust={(entityId, delta) => commitGame((current) => adjustStationWarpers(current, entityId, delta))}
          onStationWarpEnabled={(entityId, enabled) => commitGame((current) => setStationWarpEnabled(current, entityId, enabled))}
          onStationWarperAutoRefillChange={(entityId, enabled) => commitGame((current) => setStationWarperAutoRefill(current, entityId, enabled))}
          onStationWarperTargetChange={(entityId, target) => commitGame((current) => setStationWarperTarget(current, entityId, target))}
          onStationHubChange={(entityId, enabled, priority) => commitGame((current) => setStationHubConfiguration(current, entityId, enabled, priority))}
          onStationMinimumLoadChange={(entityId, minimumLoad: StationMinimumLoad) => commitGame((current) => setStationMinimumLoad(current, entityId, minimumLoad))}
          onStationSlotItemChange={(entityId, slotIndex, itemId) => commitGame((current) => setStationSlotItem(current, entityId, slotIndex, itemId))}
          onStationSlotModeChange={(entityId, slotIndex, scope: StationLogisticsScope, mode: StationLogisticsMode) => commitGame((current) => setStationSlotMode(current, entityId, slotIndex, scope, mode))}
          onStationSlotMinimumLoadChange={(entityId, slotIndex, minimumLoad: StationMinimumLoad) => commitGame((current) => setStationSlotMinimumLoad(current, entityId, slotIndex, minimumLoad))}
          onStationSlotLimitsChange={(entityId, slotIndex, minStock, maxStock) => commitGame((current) => setStationSlotLimits(current, entityId, slotIndex, minStock, maxStock))}
          onStationSlotPriorityChange={(entityId, slotIndex, priority) => commitGame((current) => setStationSlotPriority(current, entityId, slotIndex, priority))}
          onStationSlotRoutePolicyChange={(entityId, slotIndex, routePolicy) => commitGame((current) => setStationSlotRoutePolicy(current, entityId, slotIndex, routePolicy))}
          onStationSlotWarperBudgetChange={(entityId, slotIndex, warperBudget) => commitGame((current) => setStationSlotWarperBudget(current, entityId, slotIndex, warperBudget))}
          onLogisticsItemChange={(entityId, itemId) => commitGame((current) => setLogisticsItem(current, entityId, itemId))}
          onSplitterModeChange={(entityId, mode) => commitGame((current) => setSplitterMode(current, entityId, mode))}
          onBeltPriorityChange={(beltId, priority) => commitGame((current) => setBeltPriority(current, beltId, priority))}
          onBeltStackSizeChange={(beltId, stackSize: CargoStackSize) => commitGame((current) => setBeltStackSize(current, beltId, stackSize))}
          onBeltMonitorChange={(beltId, enabled) => commitGame((current) => setBeltMonitorEnabled(current, beltId, enabled))}
          onBeltRouteModeChange={(beltId, routeMode: BeltRouteMode) => commitGame((current) => setBeltRouteMode(current, beltId, routeMode))}
          onBeltRouteOffsetChange={(beltId, routeOffsetY) => commitGame((current) => setBeltRouteOffsetY(current, beltId, routeOffsetY))}
          onApplyBeltConfigurationToNetwork={(beltId) => {
            commitGame((current) => applyBeltConfigurationToNetwork(current, beltId));
            setNotice("当前线路设置已同步到整条连续网络");
          }}
          onFocusBeltNetwork={(beltId) => {
            if (focusedBeltNetworkId === beltId) setFocusedBeltNetworkId(null);
            else focusBeltNetwork(beltId);
          }}
          onRemoveBeltNetwork={(beltId) => {
            const count = analyzeBeltNetwork(gameRef.current, beltId)?.beltIds.length ?? 0;
            commitGame((current) => removeBeltNetwork(current, beltId));
            setSelectedBeltId(null);
            setFocusedBeltNetworkId(null);
            setNotice(`已回收连续运输网络 · ${count} 条线路`);
            playTone("remove");
          }}
          onUpgradeBeltNetwork={(beltId) => {
            commitGame((current) => upgradeBeltNetwork(current, beltId));
            setNotice("已升级当前物品的连续运输网络");
            playTone("upgrade");
          }}
          onCopyBeltConfiguration={(beltId) => {
            setCopiedBeltConfigurationId(beltId);
            setNotice("线路优先级、堆叠和监测设置已复制");
          }}
          onPasteBeltConfiguration={(beltId) => {
            if (!copiedBeltConfigurationId) return;
            commitGame((current) => applyBeltConfiguration(current, copiedBeltConfigurationId, beltId));
            setNotice("线路设置已应用");
          }}
          hasCopiedBeltConfiguration={Boolean(copiedBeltConfigurationId && game.belts.some((belt) => belt.id === copiedBeltConfigurationId))}
          onAddEntity={quickAddEntity}
          onUpgradeEntity={(entityId) => {
            const entity = gameRef.current.entities.find((candidate) => candidate.id === entityId);
            const targetId = entity?.buildingId ? getBuildingUpgradeTarget(entity.buildingId) : undefined;
            commitGame((current) => upgradeEntity(current, entityId));
            if (targetId) {
              setNotice(`设备已升级为${getBuilding(targetId).name}`);
              playTone("upgrade");
            }
          }}
          onUpgradeBelt={(beltId) => {
            commitGame((current) => upgradeBelt(current, beltId));
            setNotice("运输线升级完成");
            playTone("upgrade");
          }}
          onInstallSprayCoater={(entityId) => {
            commitGame((current) => installSprayCoater(current, entityId));
            setNotice("喷涂模块安装完成，可接入增产剂并选择生产模式");
          }}
          onProliferatorConfiguration={(entityId, tier: ProliferatorTier, mode: ProliferatorMode) => {
            commitGame((current) => setProliferatorConfiguration(current, entityId, tier, mode));
            const modeName = mode === "extra" ? "额外产出" : mode === "speed" ? "生产加速" : "正常生产";
            setNotice(`喷涂配置已切换：Mk.${tier === 3 ? "III" : tier === 2 ? "II" : "I"} · ${modeName}`);
          }}
          onBatchRecipeChange={(entityIds, recipeId) => {
            commitGame((current) => setEntitiesRecipe(current, entityIds, recipeId));
            setNotice(`已为 ${entityIds.length} 个设备切换生产配方`);
          }}
          onBatchInstallSprayCoater={(entityIds) => {
            commitGame((current) => installSprayCoaters(current, entityIds));
            setNotice("已为选区安装可用喷涂模块");
          }}
          onBatchProliferatorConfiguration={(entityIds, tier, mode) => {
            commitGame((current) => setEntitiesProliferatorConfiguration(current, entityIds, tier, mode));
            setNotice(`已同步 ${entityIds.length} 个设备的增产配置`);
          }}
          onCraft={(buildingId) => setGame((current) => craftConstruction(current, buildingId))}
          onCraftItem={(recipeId, batches) => setGame((current) => handcraftRecipe(current, recipeId, batches))}
          onQueueCraftItem={(recipeId, batches) => setGame((current) => queueHandcraftRecipe(current, recipeId, batches))}
          onCancelCraftQueue={(entryId) => setGame((current) => cancelHandcraftQueueEntry(current, entryId))}
          onRemoveEntity={(entityId, count) => {
            const entity = gameRef.current.entities.find((candidate) => candidate.id === entityId);
            const removedCount = entity ? Math.min(entity.kind === "vein" ? entity.minerCount : entity.machineCount, count ?? (entity.kind === "vein" ? entity.minerCount : entity.machineCount)) : 0;
            const removesNode = Boolean(entity && entity.kind !== "vein" && removedCount >= entity.machineCount);
            commitGame((current) => removeEntity(current, entityId, count));
            if (removesNode) setSelectedEntityIds((current) => current.filter((id) => id !== entityId));
            if (entity?.kind === "vein" && entity.resourceId) {
              const recovered = Math.min(entity.minerCount, count ?? entity.minerCount);
              setNotice(`已回收${getBuilding(getExtractorBuildingId(entity.resourceId)).name} ×${recovered}，矿脉与运输线保持不变`);
            } else if (entity?.buildingId && !removesNode) {
              setNotice(`${getBuilding(entity.buildingId).name}堆叠已减少至 ×${entity.machineCount - removedCount}，缓存、进度与线路保持不变`);
            } else if (entity?.buildingId) {
              setNotice(`已完整回收${getBuilding(entity.buildingId).name} ×${entity.machineCount}`);
            }
            playTone("remove");
          }}
          onRemoveBelt={(beltId) => {
            commitGame((current) => removeBelt(current, beltId));
            setSelectedBeltId(null);
            playTone("remove");
          }}
        />
      </div>
      <ConstructionDock
        game={game}
        placement={placement}
        beltTier={dockBeltTier}
        beltTierMode={beltTierMode}
        placementCount={placementCount}
        onPlacementChange={(buildingId) => {
          setPlacement(buildingId);
          setBlueprintPlacementId(null);
          setSelectionMode(false);
          setRegionMode(false);
          setRegionDraft(null);
          setSelectedEntityIds([]);
          if (nextMobileShell) mobileNavigation.goFactory();
        }}
        onBeltTierChange={setBeltTier}
        onBeltTierModeChange={setBeltTierMode}
        onPlacementCountChange={(count) => { setPlacementCount(count); setPlacement(null); }}
        onOpenFabricator={() => {
          setFabricatorFocusItemId(null);
          setInspectorTab("fabricate");
          if (nextMobileShell) openMobileSheet("inspector");
          else setMobilePanel("inspector");
        }}
        onCraft={handleQuickCraftConstruction}
        onCraftItem={handleQuickCraftFleet}
        onStowCargo={() => setGame((current) => dropCargoToTray(current))}
        onMissingCraftNavigate={handleMissingConstructionCraft}
      />
      <OnboardingCoach game={game} onAction={runOnboardingAction} compact={nextMobileShell} />
      <BlueprintWorkspace
        open={blueprintsOpen}
        game={game}
        mobile={nextMobileShell}
        mobileSubview={mobileWorkspaceSubview}
        onMobileOpenDetail={mobileNavigation.openWorkspaceSubview}
        onClose={() => nextMobileShell ? mobileNavigation.requestBack() : setBlueprintsOpen(false)}
        onDeploy={deployBlueprint}
        onRemove={(blueprintId) => {
          commitGame((current) => removeBlueprint(current, blueprintId));
          if (blueprintPlacementId === blueprintId) setBlueprintPlacementId(null);
        }}
        onRename={(blueprintId, name) => commitGame((current) => renameBlueprint(current, blueprintId, name))}
        onTransform={(blueprintId, rotation, mirror) => commitGame((current) => setBlueprintTransform(current, blueprintId, rotation, mirror))}
        onRecipeOverride={(blueprintId, sourceRecipeId, targetRecipeId) => commitGame((current) => setBlueprintRecipeOverride(current, blueprintId, sourceRecipeId, targetRecipeId))}
        onCancelQueue={(entryId) => commitGame((current) => cancelConstructionQueueEntry(current, entryId))}
        onExport={downloadBlueprint}
        onImport={importBlueprint}
      />
      <CommandPalette
        open={commandPaletteOpen}
        game={game}
        onClose={closeCommandPalette}
        onOpenWorkspace={openCommandWorkspace}
        onFocusRecipe={openRecipeFocus}
        onFocusEntity={focusPlacedEntity}
        onAutoLayout={() => autoLayoutEntities()}
        onPauseToggle={() => {
          const wasPaused = gameRef.current.paused;
          setGame((current) => setPaused(current, !current.paused));
          setNotice(wasPaused ? "模拟已继续" : "模拟已暂停");
        }}
        onTogglePerformance={() => updateSettings({ performanceMode: !gameRef.current.settings.performanceMode })}
        onToggleReducedMotion={() => updateSettings({ reducedMotion: !gameRef.current.settings.reducedMotion })}
      />
      <Suspense fallback={<WorkspaceLoading />}>
        {constructionCenterOpen ? (
          <ConstructionCenterWorkspace
            open
            game={game}
            onClose={() => nextMobileShell ? mobileNavigation.requestBack() : setConstructionCenterOpen(false)}
            onEnabledChange={(enabled) => commitGame((current) => setConstructionAutomationEnabled(current, enabled))}
            onTargetChange={(constructionId: ConstructionId, target: number) => commitGame((current) => setConstructionAutomationTarget(current, constructionId, target))}
          />
        ) : null}
        {galaxyOpen ? (
          <GalaxyWorkspace
            open
            accountState={accountState}
            game={game}
            focusTab={galaxyFocusTab}
            onClose={() => nextMobileShell ? mobileNavigation.requestBack() : setGalaxyOpen(false)}
            onUpdateProfile={updateGalaxyProfile}
            onUpdateCloudBinding={updateGalaxyCloudBinding}
            onCreateAccount={createGalaxyAccount}
            onSwitchAccount={switchGalaxyAccount}
            onUpload={uploadGalaxyData}
            onRestoreCloudSave={restoreCloudSave}
          />
        ) : null}
        {technologyOpen ? (
          <TechnologyWorkspace
            open
            game={game}
            mobile={nextMobileShell}
            mobileSubview={mobileWorkspaceSubview}
            onMobileOpenDetail={mobileNavigation.openWorkspaceSubview}
            focusTechId={campaignFocusTechId}
            onClose={() => nextMobileShell ? mobileNavigation.requestBack() : setTechnologyOpen(false)}
            onSelect={(techId) => {
              trackAnalyticsEvent("research_queue");
              setGame((current) => selectTechnology(current, techId));
            }}
            onPauseResearch={() => {
              setGame((current) => pauseCurrentResearch(current));
              setNotice("科研已暂停，已投入矩阵与科技进度均已保留");
            }}
            onCancelResearch={() => {
              setGame((current) => cancelCurrentResearch(current));
              setNotice("当前科研已取消，重新选择时会从已有进度继续");
            }}
            onResumeResearch={() => {
              setGame((current) => resumePausedResearch(current));
              setNotice("已从保留进度继续科研");
            }}
            onRemoveQueued={(techId) => setGame((current) => removeQueuedTechnology(current, techId))}
            onSelectInfiniteResearch={(researchId: InfiniteResearchId) => setGame((current) => selectInfiniteResearch(current, researchId))}
            onInfiniteResearchAutomation={(enabled) => setGame((current) => setInfiniteResearchAutomation(current, enabled))}
            onLayoutChange={(technologyLayout) => updateSettings({ technologyLayout })}
          />
        ) : null}
        {statisticsOpen ? <StatisticsWorkspace
          open
          game={game}
          mobile={nextMobileShell}
          focusTab={statisticsFocusTab}
          onClose={() => nextMobileShell ? mobileNavigation.requestBack() : setStatisticsOpen(false)}
          onCreatePlan={(itemId, targetPerMinute, planetId) => commitGame((current) => createProductionPlan(current, itemId, targetPerMinute, planetId))}
          onUpdatePlan={(planId, changes) => commitGame((current) => updateProductionPlan(current, planId, changes))}
          onSetPlanRecipe={(planId, itemId, recipeId) => commitGame((current) => setProductionPlanRecipe(current, planId, itemId, recipeId))}
          onRemovePlan={(planId) => commitGame((current) => removeProductionPlan(current, planId))}
          onSelectInfiniteResearch={(researchId: InfiniteResearchId) => commitGame((current) => selectInfiniteResearch(current, researchId))}
          onInfiniteResearchAutomation={(enabled) => commitGame((current) => setInfiniteResearchAutomation(current, enabled))}
          onGalacticDispatchAutomation={(enabled) => commitGame((current) => setGalacticDispatchAutomation(current, enabled))}
          onGalacticDispatchThrottle={(throttle: GalacticDispatchThrottle) => commitGame((current) => setGalacticDispatchThrottle(current, throttle))}
          onGalacticExportEnabled={(projectId: GalacticExportProjectId, enabled) => commitGame((current) => setGalacticExportEnabled(current, projectId, enabled))}
          onGalacticExportPriority={(projectId: GalacticExportProjectId, priority: LogisticsPriority) => commitGame((current) => setGalacticExportPriority(current, projectId, priority))}
          onDispatchGalacticExport={(projectId: GalacticExportProjectId) => commitGame((current) => dispatchGalacticExport(current, projectId))}
          onFocusEntity={(entityId) => {
            setStatisticsOpen(false);
            setStatisticsFocusTab(null);
            focusPlacedEntity(entityId);
          }}
          onFocusBeltNetwork={focusBeltNetwork}
          onBulkRecipeChange={(entityIds, recipeId) => {
            commitGame((current) => setEntitiesRecipe(current, entityIds, recipeId));
            setNotice(`已为 ${entityIds.length} 个兼容设备批量切换配方`);
            playTone("upgrade");
          }}
          onBulkStationSlotApply={(entityIds, slotIndex, template: StationSlotTemplate) => {
            commitGame((current) => applyStationSlotTemplateToEntities(current, entityIds, slotIndex, template));
            setNotice(`已为 ${entityIds.length} 个物流站同步槽位 ${slotIndex + 1}`);
          }}
          onBulkBeltUpgrade={(beltIds) => {
            commitGame((current) => beltIds.reduce((next, beltId) => upgradeBeltNetwork(next, beltId), current));
            setNotice(`已批量升级 ${beltIds.length} 个连续运输网络`);
            playTone("upgrade");
          }}
          onBulkBeltRoute={(beltIds, routeMode) => {
            commitGame((current) => beltIds.reduce((next, beltId) => setBeltNetworkRouteMode(next, beltId, routeMode), current));
            setNotice(`已为 ${beltIds.length} 个连续网络批量改道`);
          }}
          onBulkBeltConfiguration={(beltIds) => {
            if (beltIds.length < 2) return;
            commitGame((current) => {
              const sourceId = beltIds[0];
              return beltIds.slice(1).reduce((next, originId) => getBeltNetworkIds(next, originId)
                .reduce((configured, targetId) => applyBeltConfiguration(configured, sourceId, targetId), next), current);
            });
            setNotice(`已将首个网络的配置同步到其余 ${beltIds.length - 1} 个网络`);
          }}
          onBulkBeltRemove={(beltIds) => {
            commitGame((current) => beltIds.reduce((next, beltId) => removeBeltNetwork(next, beltId), current));
            setSelectedBeltId(null);
            setFocusedBeltNetworkId(null);
            setNotice(`已批量回收 ${beltIds.length} 个连续网络`);
            playTone("remove");
          }}
          onBeltHeatmapChange={(enabled) => updateSettings({ beltHeatmapEnabled: enabled })}
          onAddCanvasBookmark={(name) => {
            commitGame((current) => addCanvasBookmark(current, current.activePlanetId, getViewport(), name));
            setNotice("当前画布视角已加入书签");
          }}
          onRenameCanvasBookmark={(bookmarkId, name) => commitGame((current) => renameCanvasBookmark(current, bookmarkId, name))}
          onOpenCanvasBookmark={openCanvasBookmark}
          onRemoveCanvasBookmark={(bookmarkId) => commitGame((current) => removeCanvasBookmark(current, bookmarkId))}
        /> : null}
        {recipesOpen ? <RecipeWorkspace open game={game} mobile={nextMobileShell} mobileSubview={mobileWorkspaceSubview} onMobileOpenDetail={mobileNavigation.openWorkspaceSubview} onMobileReplaceDetail={(subview) => mobileNavigation.replaceWorkspaceSubview(subview)} focusItemId={campaignFocusItemId} onClose={() => nextMobileShell ? mobileNavigation.requestBack() : setRecipesOpen(false)} onFocus={onRecipeFocusChange} /> : null}
        {campaignOpen ? (
          <CampaignWorkspace
            open
            game={game}
            onClose={() => nextMobileShell ? mobileNavigation.requestBack() : setCampaignOpen(false)}
            onNavigate={navigateFromCampaign}
            onSelectTask={onSelectCampaignTask}
          />
        ) : null}
        {starMapOpen ? (
          <StarMapWorkspace
            open
            game={game}
            mobile={nextMobileShell}
            mobileSubview={mobileWorkspaceSubview}
            onMobileOpenDetail={mobileNavigation.openWorkspaceSubview}
            onClose={() => nextMobileShell ? mobileNavigation.requestBack() : setStarMapOpen(false)}
            onExplore={onExploreSystem}
            onColonize={onColonizePlanet}
            onTravel={(planetId) => { onPlanetChange(planetId); setStarMapOpen(false); }}
            onRoleChange={(planetId: PlanetId, role: PlanetIndustryRole) => commitGame((current) => setPlanetIndustryRole(current, planetId, role))}
            onStationPriorityChange={(entityId: string, slotIndex: number, priority: LogisticsPriority) => commitGame((current) => setStationSlotPriority(current, entityId, slotIndex, priority))}
            onStationMinimumLoadChange={(entityId: string, slotIndex: number, minimumLoad: StationMinimumLoad) => commitGame((current) => setStationSlotMinimumLoad(current, entityId, slotIndex, minimumLoad))}
            onStationLimitsChange={(entityId: string, slotIndex: number, minStock: number, maxStock: number) => commitGame((current) => setStationSlotLimits(current, entityId, slotIndex, minStock, maxStock))}
            onFocusStation={focusStellarStation}
          />
        ) : null}
        {dysonPlannerOpen ? (
          <DysonPlannerWorkspace
            open
            game={game}
            onClose={() => nextMobileShell ? mobileNavigation.requestBack() : setDysonPlannerOpen(false)}
            onAddLayer={(systemId) => setGame((current) => addDysonLayer(current, systemId))}
            onAddStandardLayer={(systemId) => setGame((current) => createStandardDysonLayer(current, systemId))}
            onSelectLayer={(systemId, layerId) => setGame((current) => setActiveDysonLayer(current, systemId, layerId))}
            onOrbitChange={(systemId, layerId, orbit) => setGame((current) => setDysonLayerOrbit(current, systemId, layerId, orbit))}
            onRemoveLayer={(systemId, layerId) => setGame((current) => removeDysonLayer(current, systemId, layerId))}
            onAddNode={(systemId, layerId, angle) => setGame((current) => addDysonNode(current, systemId, layerId, angle))}
            onRemoveNode={(systemId, layerId, nodeId) => setGame((current) => removeDysonNode(current, systemId, layerId, nodeId))}
            onConnectNodes={(systemId, layerId, sourceNodeId, targetNodeId) => setGame((current) => connectDysonNodes(current, systemId, layerId, sourceNodeId, targetNodeId))}
            onAutoConnect={(systemId, layerId) => setGame((current) => autoConnectDysonLayer(current, systemId, layerId))}
            onPlanShell={(systemId, layerId) => setGame((current) => planDysonShell(current, systemId, layerId))}
            onClearShell={(systemId, layerId) => setGame((current) => clearDysonShells(current, systemId, layerId))}
            onLaunchModeChange={(mode: DysonLaunchMode) => setGame((current) => setDysonLaunchMode(current, mode))}
            onLaunchThrottleChange={(throttle: DysonLaunchThrottle) => setGame((current) => setDysonLaunchThrottle(current, throttle))}
            onLaunchEnabledChange={(enabled) => setGame((current) => setDysonLaunchEnabled(current, enabled))}
            onAddSwarmOrbit={(systemId) => setGame((current) => addDysonSwarmOrbit(current, systemId))}
            onSelectSwarmOrbit={(systemId, orbitId) => setGame((current) => setActiveDysonSwarmOrbit(current, systemId, orbitId))}
            onSwarmOrbitChange={(systemId, orbitId, changes) => setGame((current) => setDysonSwarmOrbit(current, systemId, orbitId, changes))}
            onRemoveSwarmOrbit={(systemId, orbitId) => setGame((current) => removeDysonSwarmOrbit(current, systemId, orbitId))}
          />
        ) : null}
        {operationsOpen ? (
          <OperationsWorkspace
            open
            tab={operationsTab}
            game={game}
            alerts={alerts}
            slots={saveSlots}
            snapshots={saveSnapshots}
            importPreview={importPreview}
            modValidation={modValidation}
            contentPackRegistry={contentPackRegistry}
            performanceReport={performanceReport}
            desktopRelease={desktopRelease}
            onClose={() => nextMobileShell ? mobileNavigation.requestBack() : setOperationsOpen(false)}
            onTabChange={setOperationsTab}
            onAlertSelect={selectAlert}
            onSettingsChange={updateSettings}
            onManualSave={manualSave}
            onExport={downloadSave}
            onImport={importSave}
            onConfirmImport={confirmImport}
            onCancelImport={cancelImport}
            onSaveSlot={saveToSlot}
            onLoadSlot={loadFromSlot}
            onDeleteSlot={deleteSlot}
            onCreateSnapshot={createSnapshot}
            onLoadSnapshot={loadSnapshot}
            onDeleteSnapshot={deleteSnapshot}
            onRunBenchmark={runBenchmark}
            onCheckDesktopUpdate={checkDesktopUpdate}
            onInstallDesktopUpdate={installDesktopUpdate}
            onOpenReleaseNotes={onOpenReleaseNotes}
            onValidateMod={validateMod}
            onExportModTemplate={downloadModTemplate}
            onRegisterContentPack={registerValidatedContentPack}
            onSetContentPackEnabled={toggleRegisteredContentPack}
            onRemoveContentPack={removeRegisteredContentPack}
          />
        ) : null}
        {offlineReport ? <OfflineReportWorkspace report={offlineReport} onClose={() => setOfflineReport(null)} /> : null}
      </Suspense>
      <button className="mobile-backdrop" type="button" aria-label="关闭侧栏" onClick={() => setMobilePanel(null)} />
      {mobilePanel && coarsePointer ? <button
        className={`mobile-panel-swipe-handle${mobilePanelSwipe.dragging ? " mobile-panel-swipe-handle--dragging" : ""}`}
        type="button"
        aria-label={mobilePanelStage === "half" ? "展开为全屏面板" : "收起为半屏面板"}
        title={mobilePanelStage === "half" ? "展开为全屏，或向下滑动关闭" : "收起为半屏，或向下滑动收起"}
        aria-expanded={mobilePanelStage === "full"}
        onClick={() => {
          if (mobilePanelSwipe.consumeSwipeClick()) return;
          setMobilePanelStage((stage) => stage === "half" ? "full" : "half");
        }}
        {...mobilePanelSwipe.bindings}
      ><i /></button> : null}
      {mobileActionEntity ? <div className="mobile-action-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) setMobileActionEntityId(null); }}>
        <section className="mobile-action-sheet" role="dialog" aria-modal="true" aria-label="设备快捷操作">
          <header><span><small>长按快捷操作</small><strong>{mobileActionEntity.buildingId ? getBuilding(mobileActionEntity.buildingId).name : mobileActionEntity.resourceId ? ITEMS[mobileActionEntity.resourceId].name : mobileActionEntity.id}</strong></span><button type="button" onClick={() => setMobileActionEntityId(null)} aria-label="关闭快捷操作"><X size={16} /></button></header>
          <div>
            <button type="button" onClick={() => {
              const recipe = mobileActionEntity.recipeId ? RECIPES[mobileActionEntity.recipeId] : Object.values(RECIPES).find((candidate) => candidate.buildingId === mobileActionEntity.buildingId);
              const itemId = mobileActionEntity.resourceId ?? recipe?.outputs[0]?.itemId;
              if (itemId) openRecipeFocus(itemId);
              setMobileActionEntityId(null);
            }} disabled={!mobileActionEntity.resourceId && !mobileActionEntity.recipeId && !Object.values(RECIPES).some((candidate) => candidate.buildingId === mobileActionEntity.buildingId)}><BookOpen size={17} /><span>查看配方</span></button>
            <button type="button" disabled={getBlueprintEligibleEntityIds(game, [mobileActionEntity.id]).length === 0} onClick={() => { copyEntitiesAsBlueprint([mobileActionEntity.id]); setMobileActionEntityId(null); }}><Copy size={17} /><span>复制设备</span></button>
            <button type="button" onClick={() => { focusPlacedEntity(mobileActionEntity.id); setMobileActionEntityId(null); }}><Focus size={17} /><span>定位检查</span></button>
            <button type="button" disabled={!canUpgradeEntities(game, [mobileActionEntity.id])} onClick={() => { commitGame((current) => upgradeEntities(current, [mobileActionEntity.id])); setMobileActionEntityId(null); playTone("upgrade"); }}><ArrowUp size={17} /><span>升级设备</span></button>
            <button className="danger" type="button" disabled={mobileActionEntity.kind === "vein" && mobileActionEntity.minerCount < 1} onClick={() => { commitGame((current) => removeEntities(current, [mobileActionEntity.id])); setSelectedEntityIds([]); setMobileActionEntityId(null); playTone("remove"); }}><Trash2 size={17} /><span>{mobileActionEntity.kind === "vein" ? `回收采集设备 ×${mobileActionEntity.minerCount}` : "回收设备"}</span></button>
          </div>
        </section>
      </div> : null}
      {planetTransition ? (
        <div className="planet-transition" key={planetTransition.id} aria-live="polite">
          <span>{getPlanet(planetTransition.from).name}</span>
          <i><b /></i>
          <strong>{getPlanet(planetTransition.to).name}</strong>
        </div>
      ) : null}
      {rewardFlights.length > 0 ? (
        <div className="campaign-reward-flight" aria-label="任务奖励已入库">
          {rewardFlights.map((reward, index) => (
            <div
              className="campaign-reward-token"
              style={{ "--reward-index": index, "--reward-color": reward.color } as React.CSSProperties}
              title={`${reward.label} ×${reward.amount}`}
              key={reward.id}
            >
              <i>{reward.symbol}</i><span>{reward.label}</span><strong>×{reward.amount}</strong>
            </div>
          ))}
        </div>
      ) : null}
      <BuildingPlacementCursor buildingId={game.cargo ? null : placement} count={placementCount} x={pointer.x} y={pointer.y} />
      <CargoCursor cargo={game.cargo} x={pointer.x} y={pointer.y} />
      {activeBlueprint ? <BlueprintPlacementCursor blueprint={activeBlueprint} x={pointer.x} y={pointer.y + (game.cargo ? 42 : 0)} /> : null}
      {connectionHint ? <div className={`connection-hint connection-hint--${connectionHint.tone}`} style={{ transform: `translate3d(${pointer.x + 18}px, ${pointer.y + 18}px, 0)` }}>{connectionHint.label}</div> : null}
      {placement && ctrlHeld ? <div className="continuous-placement-indicator" style={{ left: pointer.x + 18, top: pointer.y - 34 }}><span>Ctrl</span><b>连续扩建</b></div> : null}
      {interactionBursts.map((burst) => <div className={`interaction-burst interaction-burst--${burst.tone}`} style={{ left: burst.x, top: burst.y }} key={burst.id}><i>{burst.tone === "warning" ? <Sparkles size={13} /> : <Check size={13} />}</i><span>{burst.label}</span></div>)}
      {saveFailure ? <aside className="save-emergency-warning" role="alert" aria-live="assertive">
        <AlertTriangle size={20} />
        <span><strong>{saveFailure.code === "quota" ? "本地存储空间不足，当前进度尚未保存。请立即导出存档。" : saveFailure.message}</strong><small>自动保存会继续重试，导出文件不会删除或覆盖现有存档。</small></span>
        <button type="button" onClick={downloadSave}><Download size={15} /><span>立即导出当前进度</span></button>
      </aside> : null}
      {eventHistory.length > 0 ? <aside className="interaction-event-feed" role="log" aria-label="运行事件" aria-live="polite">
        <header><Activity size={13} /><span>运行记录</span><button type="button" onClick={() => setEventHistory([])} title="清空运行记录" aria-label="清空运行记录"><X size={12} /></button></header>
        <div>{eventHistory.map((event) => <p key={event.id}>{event.text}</p>)}</div>
      </aside> : null}
      {notice ? <div className="game-notice" role="status">{notice}</div> : null}
    </main>
  );
}
