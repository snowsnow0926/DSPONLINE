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
import { Activity, AlertTriangle, ArrowUp, BookOpen, Check, ChevronLeft, ChevronRight, Copy, Download, Focus, Map as MapIcon, PanelRightClose, Route, Sparkles, Trash2, WandSparkles, X } from "lucide-react";
import {
  ConstructionDock,
  HeaderControls,
  InspectorPanel,
  PlanetNavigator,
  ResourceRail,
} from "./components/GamePanels";
import { CommandPalette, type CommandWorkspace } from "./components/CommandPalette";
import { NODE_TYPES, type FactoryFlowNode, type FactoryNodeData } from "./components/FactoryNodes";
import { EDGE_TYPES, FactoryConnectionLine, type FactoryFlowEdge } from "./components/FactoryEdges";
import { CanvasBeltLayer, type CanvasBeltLayerHandle } from "./components/CanvasBeltLayer";
import { CanvasMiniMap } from "./components/CanvasMiniMap";
import { BlueprintWorkspace, CanvasRegionEditor, CanvasRegionLayer, CanvasSelectionTools, PendingBlueprintLayer, SelectionToolbar, type CanvasRegionRectangle, type CanvasRegionResizeHandle } from "./components/BlueprintWorkspace";
import { CanvasInteractionOverlay, type CanvasClickConnectionPreview, type CanvasConnectionPreviewTone } from "./components/CanvasInteractionOverlay";
import { GAME_DIALOG_CLOSED_EVENT, useGameDialog } from "./components/GameDialogProvider";
import { RecipeFocusPanel } from "./components/RecipeFocusPanel";
import { ItemReferenceActionsProvider } from "./components/ItemReference";
import { OnboardingCoach } from "./components/OnboardingCoach";
import { MobileGameShell } from "./components/mobile/MobileGameShell";
import { usePerformanceMonitor } from "./hooks/usePerformanceMonitor";
import { MobilePlacementBar, MobileSelectionContextBar, type MobileCanvasMode } from "./components/mobile/MobileFactoryPanels";
import type { OperationsTab } from "./components/OperationsWorkspace";
import type { StatisticsTab } from "./components/StatisticsWorkspace";
import { ITEMS, RECIPES, getBeltConstructionId, getBeltTiers, getBuilding, getBuildingUpgradeTarget, getConstructionDefinition, getExtractorBuildingId, getPlanet, getStarSystem, getTechnology } from "./game/content";
import { getFactoryAlerts, type FactoryAlert } from "./game/alerts";
import { getSaveSummaryRefreshIntervalMs, shouldRefreshSaveSummaries } from "./game/saveRefreshPolicy";
import { getPlanetDisplayName, getPlanetIndustrialProfile, getPlanetSolarPowerMultiplier, getStarSystemDisplayName } from "./game/galaxy";
import {
  addUnitToEntityGroup,
  addCanvasBookmark,
  addCanvasRegion,
  applyStationSlotTemplateToEntities,
  applyBeltConfigurationToBelts,
  addDysonLayer,
  addDysonNode,
  addDysonSwarmOrbit,
  adjustStationDrones,
  adjustStationWarpers,
  adjustStationVessels,
  fillStationFleet,
  advanceSimulationBudget,
  attachAllInterstellarStationsToQuantumNetwork,
  attachInterstellarStationToQuantumNetwork,
  applyBeltConfigurationToNetworkResult,
  canConnectBelt,
  getBeltConnectionCheck,
  connectBeltWithResult,
  canPlaceBlueprint,
  canQueueBlueprint,
  cancelHandcraftQueueEntry,
  cancelConstructionQueueEntry,
  fundAllConstructionQueueEntries,
  fundConstructionQueueEntry,
  canUpgradeEntities,
  canUpgradeBelt,
  cancelCurrentResearch,
  clearDysonShells,
  colonizePlanet,
  connectDysonNodes,
  craftConstruction,
  craftConstructionWithUpstream,
  createSimulationProfiler,
  createBlueprint,
  createStandardDysonLayer,
  discardPlanetTrayItems,
  dropCargoToEntity,
  dropCargoToTray,
  exploreStarSystem,
  getAcceptedInputs,
  getBeltCapacity,
  getBeltLaneAdjustmentCheck,
  getBeltNetworkIds,
  getBlueprintPlacementPreview,
  getConstructionCraftNavigation,
  getConstructionQuickCraftPlan,
  getMaterialDeliverySlotChangeCheck,
  getRecursiveHandcraftPlan,
  MIN_CANVAS_REGION_SIZE,
  getEntityOutputCapacity,
  getEntityRemovalPreview,
  getEffectiveSimulationMultiplier,
  getEntityOperatingStatus,
  getEjectorOrbitTargetStatus,
  getEntityCycleRatePerSimulationSecond,
  getEntityPowerFactor,
  getQuantumAttachmentStatus,
  getResourceReserveSnapshot,
  getSprayCoaterRemovalRefund,
  getSprayCoaterInstallCheck,
  getProducedOutputs,
  getBuildingStackAdditionCheck,
  getStationSlots,
  getTechnologyConstructionRewards,
  handcraftRecipeWithUpstream,
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
  pasteDysonLayerTemplate,
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
  removeSprayCoater,
  removeQueuedTechnology,
  resumePausedResearch,
  selectTechnology,
  setBeltPriority,
  setBeltLaneCount,
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
  setEjectorTargetOrbit,
  setEjectorTargetOrbitForEntities,
  setEnergyMode,
  setEntitiesInteractionLocked,
  setEntityGenerationPriority,
  setEntityPowerGrid,
  setEntityPowerPriority,
  setRecipeFocus,
  setRecipeFocusMode,
  setRecipeFocusPosition,
  setFuelItem,
  setLogisticsItem,
  setAllOrbitalCollectorsQuantumMode,
  setOrbitalCollectorQuantumMode,
  setMaterialDeliverySlot,
  setPaused,
  setPlanetIndustryRole,
  setPlanetDisplayMetadata,
  setStarSystemDisplayName,
  setPlanetTrayItemLimit,
  setQuantumLogisticsItemCapacity,
  setProliferatorConfiguration,
  setEntitiesProliferatorConfiguration,
  setStationMode,
  setStationFleetTarget,
  setRemoteStationFleetTarget,
  adjustRemoteStationWarpers,
  setRemoteStationSlotItem,
  setRemoteBuildingStackTarget,
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
  getBlueprintFleetLoadPreview,
  dispatchGalacticExport,
  selectInfiniteResearch,
  setGalacticDispatchAutomation,
  setGalacticDispatchThrottle,
  setGalacticExportEnabled,
  setGalacticExportPriority,
  setGalacticMaterialExporterPaused,
  setBlackHolePaused,
  setTimeWarpController,
  setTimeWarpEnabled,
  setTimeWarpRequestedMultiplier,
  setInfiniteResearchAutomation,
  autoConnectDysonLayer,
  planDysonShell,
  renameBlueprint,
  renameCanvasBookmark,
} from "./game/engine";
import { formatQuantityCompact } from "./game/quantityFormat";
import { getAchievement, getNewAchievementIds, unlockAchievements } from "./game/progression";
import { deliverSystemSpaceStationMaterial, getInterstellarStationUpgradeStatus, requestStationOperationMode, setElevatorOutputItem, setSystemSpaceStationModuleCount, startSystemSpaceStationConstruction, upgradeAllInterstellarStationsToMk2, upgradeInterstellarStationToMk2 } from "./game/systemSpaceStation";
import { getDifficultyDefinition } from "./game/difficulty";
import { analyzeBeltNetwork, analyzeEntityLineTrace, diagnoseBelt, predictBeltConnection } from "./game/network";
import { buildFactoryEdgeRouteCenters, reconcileFactoryCanvasTopology, type FactoryCanvasTopology } from "./game/canvasTopology";
import { createCanvasRenderSnapshot, reconcileCanvasRenderSnapshot, type CanvasRenderSnapshot } from "./game/canvasRenderSnapshot";
import { planFactoryAutoLayout } from "./game/layout";
import { createProductionPlan, removeProductionPlan, setProductionPlanRecipe, updateProductionPlan } from "./game/planning";
import { getProductionLineLocations, type ProductionLineLocation } from "./game/productionLocator";
import { getCampaignTask, getCampaignTaskRequirements, selectCampaignTask, syncCampaignProgress, type CampaignNavigation } from "./game/campaign";
import { clearGameSlotVerified, clearSaveSnapshotVerified, clearSaveSnapshotsVerified, exportGame, getSaveSummariesInWorker, getSaveSlotSummaries, getSaveSnapshotSummaries, inspectSave, loadGameSlot, loadSaveSnapshot, repairSave, saveGame, saveGameSnapshotVerified, saveGameSlotVerified, saveGameVerified, type LoadedGame, type OfflineReport, type SaveGameResult, type SaveInspection, type SaveSlotId, type SaveSnapshotSummary } from "./game/storage";
import { runAutomaticPerformanceReport, type AutomaticPerformanceReport } from "./game/benchmark";
import { importBlueprintExchange, parseBlueprintExchange, serializeBlueprintExchange } from "./game/blueprintExchange";
import { exportTextFile } from "./game/fileExport";
import { alignToDevicePixel } from "./game/displayPixels";
import { getDesktopBridge } from "./desktop";
import { NATIVE_APP_STATE_EVENT } from "./nativeApp";
import { createContentPackTemplate, parseContentPack, type ModValidationResult } from "./game/mods";
import { importWithRecovery } from "./game/dynamicImportRecovery";
import {
  applyContentPackRegistry,
  createContentPackRuntimeSnapshot,
  getContentPackValidationContext,
  getContentPackUsage,
  getActiveContentPackReferences,
  loadContentPackRegistry,
  registerContentPack,
  removeContentPack,
  saveContentPackRegistry,
  setContentPackEnabled,
  type ContentPackRegistry,
  type ContentPackRuntimeSnapshot,
} from "./game/contentPacks";
import { baselineAccountProgress, createLocalAccount, getActiveAccount, loadAccountState, recordAccountProgress, saveAccountState, setActiveCloudBinding, switchLocalAccount, updateAccountProfile, type AccountProfileChanges } from "./game/account";
import { removeLeaderboardData } from "./game/leaderboard";
import { trackAnalyticsEvent } from "./game/analytics";
import { CLOUD_AUTO_SYNC_INTERVAL_MS, CloudApiError, compareCloudSave, fetchCloudPublicStatus, getCloudToken, markCloudSaveSynchronized, readCloudAutoSyncStatus, refreshCloudSaveMetadata, resumeCloudSession, uploadCloudSave, writeCloudAutoSyncStatus } from "./game/cloud";
import type { BeltRouteMode, BeltTier, BuildingId, CampaignTaskId, CanvasBookmark, CanvasRegion, CanvasViewport, CargoStackSize, ConstructionAutomationTargetId, ConstructionId, DraggedItemSourceKind, DysonLaunchMode, DysonLaunchThrottle, EnergyMode, FactoryEntity, GalacticDispatchThrottle, GalacticExportProjectId, GameSettings, GameState, InfiniteResearchId, ItemId, LogisticsPriority, PlacementCount, PlanetId, PlanetIndustryRole, PowerGridId, PowerPriority, ProliferatorMode, ProliferatorTier, RecipeId, StarSystemId, StationLogisticsMode, StationLogisticsScope, StationMinimumLoad, StationSlotTemplate } from "./game/types";
import type { SimulationWorkerRequest, SimulationWorkerResponse } from "./game/simulation.worker";
import { mergeSimulationProjections, type SimulationProjection } from "./game/simulationProjection";
import { applySimulationStateDelta, readExperimentalSimulationDeltaMode } from "./game/simulationDelta";
import { readMulticoreSimulationOptions } from "./game/multicoreSimulation";
import { getOnboardingFocusTarget, getOnboardingStep, recordBasicOnboardingEvent, type OnboardingActionId } from "./game/onboarding";
import { useCoarsePointer } from "./hooks/useCoarsePointer";
import { useCompactLayout } from "./hooks/useCompactLayout";
import { useLongPress } from "./hooks/useLongPress";
import { useLowEndMobile } from "./hooks/useLowEndMobile";
import { useResolvedTheme } from "./hooks/useResolvedTheme";
import { useObservedBeltFlowGame } from "./hooks/useObservedBeltFlowGame";
import { useMobileNavigation, type MobileWorkspaceId } from "./hooks/useMobileNavigation";
import { useMobileUiPreference } from "./hooks/useMobileUiPreference";
import { useProductionRefreshPreference } from "./hooks/useProductionRefreshPreference";
import { usePlayerPresence } from "./hooks/usePlayerPresence";
import { useSwipeDismiss } from "./hooks/useSwipeDismiss";
import { useAppLocale } from "./i18n/locale";
import { createAutomaticRefreshState, resolveProductionRefreshInterval, updateAutomaticRefreshState } from "./game/productionRefresh";
import { getCanvasLod, shouldVirtualizeCanvas, type CanvasLod } from "./game/canvasPerformance";
import { buildAlignmentSpatialIndex, findAlignmentGuides, type AlignmentSpatialIndex } from "./game/alignmentGuides";
import { synchronizeGalacticActivity, type GalacticActivityPublicStatus } from "./game/galacticActivity";
import { TutorialWorkspace } from "./components/TutorialWorkspace";
import { TimeWarpIdleOverlay } from "./components/TimeWarpIdleOverlay";
import {
  acknowledgeEndgameExtremeMode,
  canvasPerformanceFeatureIsActive,
  readCanvasPerformanceFeatures,
  readEndgameExtremeMode,
  writeCanvasPerformanceFeatures,
  writeEndgameExtremeMode,
  type CanvasPerformanceFeatureId,
} from "./game/endgamePerformance";
import {
  beginCanvasPointerMotion,
  canvasPointerMotionFrameIsActive,
  createCanvasPointerMotionSession,
  moveCanvasPointerMotion,
  setCanvasPointerEdgeVelocity,
  stopCanvasPointerMotion as stopCanvasPointerMotionSession,
} from "./hooks/canvasPointerMotion";
import { readShowRunLogPreference, readThemePreference, writeShowRunLogPreference, writeThemePreference } from "./game/uiPreferences";

type InspectorTab = "inspect" | "fabricate";

// Run-log visibility is a presentation preference. Keep safety-critical
// feedback visible when the routine event feed is disabled, while allowing
// ordinary success/status toasts to stay out of the player's way.
function isPersistentNotice(message: string): boolean {
  return /失败|错误|异常|损坏|未保存|冲突|无法|不能|不可|未执行|超出安全|成就解锁|研究完成|任务完成|云端已有|同步失败/.test(message);
}

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
  handleId: string;
  itemId: ItemId | null;
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

interface ClickConnectionPreviewState extends CanvasClickConnectionPreview {
  draft: ConnectionDraft;
}

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
  const tiersDescending = getBeltTiers().sort((left, right) => right - left);
  if (mode === "manual") return manualTier;
  if (originNodeId && itemId) {
    const attachedTiers = new Set(state.belts
      .filter((belt) => belt.itemId === itemId && (belt.source === originNodeId || belt.target === originNodeId))
      .map((belt) => belt.tier));
    const existingTier = tiersDescending.find((tier) => attachedTiers.has(tier) && beltTierIsAvailable(state, tier));
    if (existingTier) return existingTier;
  }
  return tiersDescending.find((tier) => beltTierIsAvailable(state, tier)) ?? manualTier;
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

const RecipeWorkspace = lazy(() => importWithRecovery(() => import("./components/RecipeWorkspace"), "生产资料库模块").then((module) => ({ default: module.RecipeWorkspace })));
const StatisticsWorkspace = lazy(() => importWithRecovery(() => import("./components/StatisticsWorkspace"), "生产统计模块").then((module) => ({ default: module.StatisticsWorkspace })));
const StarMapWorkspace = lazy(() => importWithRecovery(() => import("./components/StarMapWorkspace"), "星图模块").then((module) => ({ default: module.StarMapWorkspace })));
const DysonPlannerWorkspace = lazy(() => importWithRecovery(() => import("./components/DysonPlannerWorkspace"), "戴森规划模块").then((module) => ({ default: module.DysonPlannerWorkspace })));
const OfflineReportWorkspace = lazy(() => importWithRecovery(() => import("./components/OfflineReportWorkspace"), "离线报告模块").then((module) => ({ default: module.OfflineReportWorkspace })));
const OperationsWorkspace = lazy(() => importWithRecovery(() => import("./components/OperationsWorkspace"), "运营中心模块").then((module) => ({ default: module.OperationsWorkspace })));
const TechnologyWorkspace = lazy(() => importWithRecovery(() => import("./components/TechnologyWorkspace"), "科技树模块").then((module) => ({ default: module.TechnologyWorkspace })));
const CampaignWorkspace = lazy(() => importWithRecovery(() => import("./components/CampaignWorkspace"), "主线任务模块").then((module) => ({ default: module.CampaignWorkspace })));
const GalaxyWorkspace = lazy(() => importWithRecovery(() => import("./components/GalaxyWorkspace"), "银河工作区模块").then((module) => ({ default: module.GalaxyWorkspace })));
const ConstructionCenterWorkspace = lazy(() => importWithRecovery(() => import("./components/ConstructionCenterWorkspace"), "建筑制造中心模块").then((module) => ({ default: module.ConstructionCenterWorkspace })));
const SystemSpaceStationWorkspace = lazy(() => importWithRecovery(() => import("./components/SystemSpaceStationWorkspace"), "空间站模块").then((module) => ({ default: module.SystemSpaceStationWorkspace })));

// Content packs must be active before save migration reads any modded IDs.
const INITIAL_CONTENT_PACK_REGISTRY = loadContentPackRegistry();
applyContentPackRegistry(INITIAL_CONTENT_PACK_REGISTRY);
const SIDEBAR_PREFERENCE_KEY = "dsp-idle-network.sidebar-preferences.v1";
const LINE_FIND_PREFERENCE_KEY = "dsp-idle-network.line-find-mode.v1";

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

function parseTargetPortIndex(handle: string | null | undefined): 0 | 1 | 2 | undefined {
  const match = /^in:(?:black-hole|delivery):([0-2])$/.exec(handle ?? "");
  return match ? Number(match[1]) as 0 | 1 | 2 : undefined;
}

function isUniversalInputHandle(handle: string | null | undefined): boolean {
  return isAutoInputHandle(handle) || parseTargetPortIndex(handle) !== undefined;
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

interface ConnectionHandleSpatialEntry {
  target: ConnectionHandleTarget;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface ConnectionHandleSpatialIndex {
  cellSize: number;
  viewport: CanvasViewport;
  buckets: Map<string, ConnectionHandleSpatialEntry[]>;
}

function buildConnectionHandleSpatialIndex(viewport: CanvasViewport): ConnectionHandleSpatialIndex {
  const cellSize = 128;
  const buckets = new Map<string, ConnectionHandleSpatialEntry[]>();
  const zoom = Math.max(0.01, viewport.zoom);
  const elements = document.querySelectorAll<HTMLElement>(".factory-canvas .react-flow__handle");
  for (const element of elements) {
    const target = getConnectionHandleTarget(element);
    if (!target) continue;
    const bounds = element.getBoundingClientRect();
    const left = (bounds.left - viewport.x) / zoom;
    const right = (bounds.right - viewport.x) / zoom;
    const top = (bounds.top - viewport.y) / zoom;
    const bottom = (bounds.bottom - viewport.y) / zoom;
    const entry = { target, left, right, top, bottom } satisfies ConnectionHandleSpatialEntry;
    const minX = Math.floor(left / cellSize);
    const maxX = Math.floor(right / cellSize);
    const minY = Math.floor(top / cellSize);
    const maxY = Math.floor(bottom / cellSize);
    for (let cellX = minX; cellX <= maxX; cellX += 1) {
      for (let cellY = minY; cellY <= maxY; cellY += 1) {
        const key = `${cellX}:${cellY}`;
        const bucket = buckets.get(key) ?? [];
        bucket.push(entry);
        buckets.set(key, bucket);
      }
    }
  }
  return { cellSize, viewport, buckets };
}

function findConnectionHandleAtPoint(
  x: number,
  y: number,
  maximumDistance = 24,
  preferred?: (target: ConnectionHandleTarget) => boolean,
  spatialIndex?: ConnectionHandleSpatialIndex | null,
): ConnectionHandleTarget | null {
  const direct = getConnectionHandleTarget(document.elementFromPoint(x, y));
  if (direct) return direct;
  let nearest: { target: ConnectionHandleTarget; distance: number } | null = null;
  let nearestPreferred: { target: ConnectionHandleTarget; distance: number } | null = null;
  const entries = spatialIndex
    ? (() => {
      const zoom = Math.max(0.01, spatialIndex.viewport.zoom);
      const flowX = (x - spatialIndex.viewport.x) / zoom;
      const flowY = (y - spatialIndex.viewport.y) / zoom;
      const radius = maximumDistance / zoom;
      const minX = Math.floor((flowX - radius) / spatialIndex.cellSize);
      const maxX = Math.floor((flowX + radius) / spatialIndex.cellSize);
      const minY = Math.floor((flowY - radius) / spatialIndex.cellSize);
      const maxY = Math.floor((flowY + radius) / spatialIndex.cellSize);
      const candidates: ConnectionHandleSpatialEntry[] = [];
      const seen = new Set<HTMLElement>();
      for (let cellX = minX; cellX <= maxX; cellX += 1) {
        for (let cellY = minY; cellY <= maxY; cellY += 1) {
          for (const entry of spatialIndex.buckets.get(`${cellX}:${cellY}`) ?? []) {
            if (seen.has(entry.target.element)) continue;
            seen.add(entry.target.element);
            candidates.push(entry);
          }
        }
      }
      return candidates;
    })()
    : Array.from(document.querySelectorAll<HTMLElement>(".factory-canvas .react-flow__handle")).flatMap((element) => {
      const target = getConnectionHandleTarget(element);
      if (!target) return [];
      const bounds = element.getBoundingClientRect();
      return [{ target, left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom } satisfies ConnectionHandleSpatialEntry];
    });
  for (const entry of entries) {
    const target = entry.target;
    const dx = Math.max(entry.left - (spatialIndex ? (x - spatialIndex.viewport.x) / spatialIndex.viewport.zoom : x), 0,
      (spatialIndex ? (x - spatialIndex.viewport.x) / spatialIndex.viewport.zoom : x) - entry.right);
    const dy = Math.max(entry.top - (spatialIndex ? (y - spatialIndex.viewport.y) / spatialIndex.viewport.zoom : y), 0,
      (spatialIndex ? (y - spatialIndex.viewport.y) / spatialIndex.viewport.zoom : y) - entry.bottom);
    const distance = Math.hypot(dx, dy) * (spatialIndex?.viewport.zoom ?? 1);
    if (distance <= maximumDistance && (!nearest || distance < nearest.distance)) nearest = { target, distance };
    if (distance <= maximumDistance && preferred?.(target) && (!nearestPreferred || distance < nearestPreferred.distance)) nearestPreferred = { target, distance };
  }
  return nearestPreferred?.target ?? nearest?.target ?? null;
}

function connectionFromDraft(draft: ConnectionDraft, target: ConnectionHandleTarget): Connection {
  const originHandleId = draft.handleId;
  return draft.handleType === "source"
    ? { source: draft.nodeId, sourceHandle: originHandleId, target: target.nodeId, targetHandle: target.handleId }
    : { source: target.nodeId, sourceHandle: target.handleId, target: draft.nodeId, targetHandle: originHandleId };
}

function visualEntitySignature(entity: FactoryEntity): string {
  const scalarKeys: Array<keyof FactoryEntity> = [
    "id", "kind", "buildingId", "resourceId", "recipeId", "machineCount", "minerCount", "progress",
    "utilization", "productionRate", "powerInputKw", "powerOutputKw", "fuelItemId", "storedItemId",
    "stationTier", "stationOperationMode", "stationModeTransition", "quantumMode", "quantumTransition",
    "stationDrones", "stationVessels", "stationWarpers", "stationWarpEnabled", "stationWarperAutoRefill", "stationWarperTarget", "stationHubEnabled", "stationHubPriority", "stationMinimumLoad", "stationProgress", "stationTrips", "stationLastTransfer", "stationPeerId", "stationDispatchCursor", "stationCongestion", "interactionLocked",
    "distributionMode", "deliveryItemIds", "deliverySlots", "elevatorOutputItems", "targetDysonOrbitId", "fuelRemainingMj", "storedEnergyMj", "resourceRemaining", "resourceCapacity", "sprayCoaterInstalled", "proliferatorTier", "proliferatorMode", "proliferatorPoints", "galacticExporterPaused", "blackHolePaused", "blackHoleActivationConfirmed",
  ];
  const scalars = scalarKeys.map((key) => `${String(key)}=${String(entity[key] ?? "")}`).join(";");
  const mapToken = (value: Record<string, number> | undefined) => Object.keys(value ?? {}).sort().map((key) => `${key}:${value![key]}`).join(",");
  const slots = (entity.stationSlots ?? []).map((slot) => `${slot.itemId ?? ""}:${slot.localMode}:${slot.remoteMode}:${slot.minimumLoad}:${slot.minStock}:${slot.maxStock}:${slot.priority}:${slot.routePolicy ?? ""}:${slot.warperBudget ?? ""}`).join("|");
  const nested = [entity.stationModeTransition, entity.quantumTransition, entity.deliverySlots, entity.stationRoutes, entity.blackHolePorts].map((value) => JSON.stringify(value ?? null)).join("|");
  return `${scalars}|inputs=${mapToken(entity.inputs)}|outputs=${mapToken(entity.outputs)}|slots=${slots}|nested=${nested}`;
}

function serializedPayloadBytes(value: unknown): number {
  try {
    const raw = JSON.stringify(value);
    return typeof TextEncoder === "undefined" ? raw.length : new TextEncoder().encode(raw).byteLength;
  } catch {
    return 0;
  }
}

function minerPlacementHint(buildingId: BuildingId): string {
  if (buildingId === "oil_extractor") return "原油萃取站需要部署在原油涌泉上";
  if (buildingId === "water_pump") return "抽水站需要部署在水或硫酸海洋上";
  return "采矿机需要部署在固体资源矿脉上";
}

export function FactoryGame({ initialLoad, onReturnToMenu, onOpenReleaseNotes }: { initialLoad: LoadedGame; onReturnToMenu: () => void; onOpenReleaseNotes: () => void }) {
  usePlayerPresence();
  const { isEnglish } = useAppLocale();
  const gameDialog = useGameDialog();
  const compactLayout = useCompactLayout();
  const coarsePointer = useCoarsePointer();
  const [mobileUiPreference, setMobileUiPreference] = useMobileUiPreference();
  const [productionRefreshPreference, setProductionRefreshPreference] = useProductionRefreshPreference();
  const [endgameExtremeMode, setEndgameExtremeMode] = useState(readEndgameExtremeMode);
  const [canvasPerformanceFeatures, setCanvasPerformanceFeatures] = useState(readCanvasPerformanceFeatures);
  const [loaded] = useState(initialLoad);
  const [game, setGame] = useState(loaded.state);
  const observedGame = useObservedBeltFlowGame(game, !game.paused);
  const [themeMode, setThemeMode] = useState(() => readThemePreference() ?? loaded.state.settings.theme);
  const [showRunLog, setShowRunLog] = useState(readShowRunLogPreference);
  const resolvedTheme = useResolvedTheme(themeMode);
  const [canvasRenderSnapshot, setCanvasRenderSnapshot] = useState<CanvasRenderSnapshot>(() => createCanvasRenderSnapshot(loaded.state));
  const canvasGameSnapshot = canvasRenderSnapshot.game;
  const canvasGame = useObservedBeltFlowGame(canvasGameSnapshot, !canvasGameSnapshot.paused);
  const [selectedEntityIds, setSelectedEntityIds] = useState<string[]>([]);
  const [selectedBeltId, setSelectedBeltId] = useState<string | null>(null);
  const [selectedBeltIds, setSelectedBeltIds] = useState<string[]>([]);
  const [focusedBeltNetworkId, setFocusedBeltNetworkId] = useState<string | null>(null);
  const [lineFindMode, setLineFindMode] = useState(() => {
    try { return window.localStorage.getItem(LINE_FIND_PREFERENCE_KEY) === "true"; } catch { return false; }
  });
  useEffect(() => {
    try { window.localStorage.setItem(LINE_FIND_PREFERENCE_KEY, String(lineFindMode)); } catch { /* optional local preference */ }
  }, [lineFindMode]);
  const [productionLineFocus, setProductionLineFocus] = useState<(ProductionLineLocation & { itemId: ItemId; activeIndex: number }) | null>(null);
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
  const [leftSidebarCollapsed, setLeftSidebarCollapsed] = useState(() => {
    try { return JSON.parse(window.localStorage.getItem(SIDEBAR_PREFERENCE_KEY) ?? "null")?.left === true; } catch { return false; }
  });
  const [rightSidebarCollapsed, setRightSidebarCollapsed] = useState(() => {
    try { return JSON.parse(window.localStorage.getItem(SIDEBAR_PREFERENCE_KEY) ?? "null")?.right === true; } catch { return false; }
  });
  const [minimapCollapsed, setMinimapCollapsed] = useState(false);
  useEffect(() => {
    try { window.localStorage.setItem(SIDEBAR_PREFERENCE_KEY, JSON.stringify({ left: leftSidebarCollapsed, right: rightSidebarCollapsed })); } catch { /* optional local preference */ }
  }, [leftSidebarCollapsed, rightSidebarCollapsed]);
  const [autoLayoutUndo, setAutoLayoutUndo] = useState<AutoLayoutUndoSnapshot | null>(null);
  const [technologyOpen, setTechnologyOpen] = useState(false);
  const [statisticsOpen, setStatisticsOpen] = useState(false);
  const [statisticsFocusTab, setStatisticsFocusTab] = useState<StatisticsTab | null>(null);
  const [recipesOpen, setRecipesOpen] = useState(false);
  const [starMapOpen, setStarMapOpen] = useState(false);
  const [systemSpaceStationOpen, setSystemSpaceStationOpen] = useState(false);
  const [systemSpaceStationId, setSystemSpaceStationId] = useState<StarSystemId | null>(null);
  const [blueprintsOpen, setBlueprintsOpen] = useState(false);
  const [dysonPlannerOpen, setDysonPlannerOpen] = useState(false);
  const [operationsOpen, setOperationsOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [campaignOpen, setCampaignOpen] = useState(false);
  const [galaxyOpen, setGalaxyOpen] = useState(false);
  const [galaxyFocusTab, setGalaxyFocusTab] = useState<"ranking" | "cloud" | "account" | null>(null);
  const [constructionCenterOpen, setConstructionCenterOpen] = useState(false);
  const [tutorialOpen, setTutorialOpen] = useState(false);
  const [tutorialSectionId, setTutorialSectionId] = useState<string | undefined>();
  const [pureIdleActive, setPureIdleActive] = useState(() => loaded.state.timeWarp.enabled);
  const [pureIdleStartedAt, setPureIdleStartedAt] = useState<number | null>(() => loaded.state.timeWarp.enabled ? Date.now() : null);
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
  const [pendingImportRaw, setPendingImportRaw] = useState<string | null>(null);
  const [importRescueArmed, setImportRescueArmed] = useState(false);
  const [modValidation, setModValidation] = useState<ModValidationResult | null>(null);
  const [contentPackRegistry, setContentPackRegistry] = useState<ContentPackRegistry>(INITIAL_CONTENT_PACK_REGISTRY);
  const [performanceReport, setPerformanceReport] = useState<AutomaticPerformanceReport | null>(null);
  const [blueprintPlacementId, setBlueprintPlacementId] = useState<string | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [deleteMode, setDeleteMode] = useState(false);
  const [regionMode, setRegionMode] = useState(false);
  const [regionDraft, setRegionDraft] = useState<CanvasRegionRectangle | null>(null);
  const [regionResizePreview, setRegionResizePreview] = useState<{ regionId: string; rectangle: CanvasRegionRectangle } | null>(null);
  const [selectedRegionId, setSelectedRegionId] = useState<string | null>(null);
  const [miningEntityId, setMiningEntityId] = useState<string | null>(null);
  const [alignmentGuides, setAlignmentGuides] = useState<AlignmentGuides>({ x: null, y: null });
  const [connectionDraft, setConnectionDraft] = useState<ConnectionDraft | null>(null);
  const [clickConnectionPreview, setClickConnectionPreview] = useState<ClickConnectionPreviewState | null>(null);
  const [clickConnectionTone, setClickConnectionTone] = useState<CanvasConnectionPreviewTone>("pending");
  const [clickConnectionSnapPoint, setClickConnectionSnapPoint] = useState<{ x: number; y: number } | null>(null);
  const [connectionHint, setConnectionHint] = useState<{ label: string; tone: "ready" | "blocked" | "warning" } | null>(null);
  const initialViewport = loaded.state.planetViewports[loaded.state.activePlanetId] ?? { x: 510, y: 250, zoom: 0.84 };
  const [viewportZoom, setViewportZoom] = useState(initialViewport.zoom);
  const [canvasGeometryRevision, setCanvasGeometryRevision] = useState(0);
  const [hoveredBeltId, setHoveredBeltId] = useState<string | null>(null);
  const [canvasBatchFailed, setCanvasBatchFailed] = useState(false);
  const [minimapCanvasFailed, setMinimapCanvasFailed] = useState(false);
  const [pendingBlueprintViewport, setPendingBlueprintViewport] = useState<CanvasViewport>({ ...initialViewport });
  const [minimapViewport, setMinimapViewport] = useState<CanvasViewport>({ ...initialViewport });
  const [canvasViewportSize, setCanvasViewportSize] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const [highlightedTaskId, setHighlightedTaskId] = useState<CampaignTaskId | null>(null);
  const [rewardFlights, setRewardFlights] = useState<RewardFlight[]>([]);
  const [planetTransition, setPlanetTransition] = useState<PlanetTransition | null>(null);
  const [simulationWorkerActive, setSimulationWorkerActive] = useState(false);
  const [pageHidden, setPageHidden] = useState(document.visibilityState === "hidden");
  const [lowFrameRateMode, setLowFrameRateMode] = useState(false);
  const [automaticRefreshState, setAutomaticRefreshState] = useState(() => createAutomaticRefreshState(coarsePointer));
  const [galacticActivityStatus, setGalacticActivityStatus] = useState<GalacticActivityPublicStatus | null>(null);
  const [, setHistoryRevision] = useState(0);
  const [nodes, setNodes, onNodesChange] = useNodesState<FactoryFlowNode>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [saveFailure, setSaveFailure] = useState<SaveGameResult | null>(null);
  const [eventHistory, setEventHistory] = useState<Array<{ id: number; text: string }>>([]);
  const [interactionBursts, setInteractionBursts] = useState<InteractionBurst[]>([]);
  const [ctrlHeld, setCtrlHeld] = useState(false);
  const gameRef = useRef(game);
  const latestCanvasGameRef = useRef(game);
  const lastCanvasPublishedGameRef = useRef(game);
  const canvasRenderSnapshotRef = useRef(canvasRenderSnapshot);
  const pendingCanvasProjectionRef = useRef<SimulationProjection | null>(null);
  const canvasTopologyRef = useRef<FactoryCanvasTopology | null>(null);
  const edgeRouteCacheRef = useRef<{ topologyRevision: number; geometryRevision: number; simplified: boolean; centers: ReadonlyMap<string, number | undefined> } | null>(null);
  const edgeRenderCacheRef = useRef<Map<string, FactoryFlowEdge>>(new Map());
  const accountStateRef = useRef(accountState);
  const completedTechCountRef = useRef(game.research.completedTechIds.length);
  const achievementCountRef = useRef(game.achievements.unlockedIds.length);
  const campaignCompletedCountRef = useRef(game.campaign.completedTaskIds.length);
  const launchCountRef = useRef({ sails: game.dysonSwarm.totalLaunched, rockets: game.dysonSphere.totalRocketsLaunched });
  const miningTimerRef = useRef<number | null>(null);
  const nodeDragActiveRef = useRef(false);
  const factoryCanvasRef = useRef<HTMLElement | null>(null);
  const pointerRef = useRef({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
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
  const pendingPlanetViewportRef = useRef(new Map<PlanetId, { viewport: CanvasViewport; timer: number }>());
  const viewportOnlyGameStateRef = useRef<GameState | null>(null);
  const canvasSizeRef = useRef<{ width: number; height: number } | null>(null);
  const canvasPointerMotionRef = useRef(createCanvasPointerMotionSession());
  const canvasPointerMotionFrameRef = useRef<number | null>(null);
  const canvasPointerCaptureRef = useRef<{ element: HTMLElement; pointerId: number } | null>(null);
  const canvasBeltLayerRef = useRef<CanvasBeltLayerHandle | null>(null);
  const connectionHandleSpatialIndexRef = useRef<ConnectionHandleSpatialIndex | null>(null);
  const alignmentSpatialIndexRef = useRef<AlignmentSpatialIndex | null>(null);
  const dragAlignmentSpatialIndexRef = useRef<AlignmentSpatialIndex | null>(null);
  const canvasPinchLodRef = useRef<CanvasLod>(getCanvasLod(initialViewport.zoom));
  const continuousPlacementRef = useRef<{ entityId: string; buildingId: BuildingId; planetId: PlanetId } | null>(null);
  const ctrlHeldRef = useRef(false);
  const undoStackRef = useRef<GameState[]>([]);
  const redoStackRef = useRef<GameState[]>([]);
  const selectedEntityIdsRef = useRef<string[]>([]);
  const selectedBeltIdRef = useRef<string | null>(null);
  const selectedBeltIdsRef = useRef<string[]>([]);
  const selectionModeRef = useRef(false);
  const deleteModeRef = useRef(false);
  const lineFindTraceCacheRef = useRef<{ planetId: PlanetId; revision: number; traces: Map<string, ReturnType<typeof analyzeEntityLineTrace>> } | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const simulationWorkerRef = useRef<Worker | null>(null);
  const simulationWorkerDisabledRef = useRef(false);
  const contentPackRuntimeSnapshotRef = useRef<ContentPackRuntimeSnapshot>(createContentPackRuntimeSnapshot(INITIAL_CONTENT_PACK_REGISTRY));
  const simulationWorkerRegistryFingerprintRef = useRef<string | null>(null);
  const simulationSubmissionRef = useRef<{ id: number; state: GameState; simulationSeconds: number; wallSeconds: number; registryFingerprint: string; submittedAt: number; baseStateRevision: number | null; requestBytes: number } | null>(null);
  const simulationStateRevisionRef = useRef(0);
  const experimentalSimulationDeltaRef = useRef(readExperimentalSimulationDeltaMode());
  const multicoreSimulationOptionsRef = useRef(readMulticoreSimulationOptions());
  const lastSimulationResultRef = useRef<GameState | null>(null);
  const simulationPendingSecondsRef = useRef(game.timeWarp.pendingSimulationSeconds);
  const simulationPendingWallSecondsRef = useRef(game.timeWarp.pendingWallSeconds);
  const simulationRequestIdRef = useRef(0);
  const pureIdleActiveRef = useRef(loaded.state.timeWarp.enabled);
  const pureIdleStoppingRef = useRef(false);
  const workerLatencyMsRef = useRef(0);
  const eventSequenceRef = useRef(0);
  const burstSequenceRef = useRef(0);
  const getCurrentGame = useCallback(() => gameRef.current, []);
  const performanceMonitor = usePerformanceMonitor(getCurrentGame, game.paused);
  const { screenToFlowPosition, setCenter, setViewport, fitView, getViewport, zoomIn, zoomOut } = useReactFlow();
  const flowStore = useStoreApi<FactoryFlowNode, FactoryFlowEdge>();
  useEffect(() => {
    const resetAfterDialog = () => {
      const capture = canvasPointerCaptureRef.current;
      if (capture) {
        try { if (capture.element.hasPointerCapture(capture.pointerId)) capture.element.releasePointerCapture(capture.pointerId); } catch { /* WebView can invalidate the pointer during modal focus changes. */ }
      }
      canvasPointerCaptureRef.current = null;
      if (canvasPointerMotionFrameRef.current != null) window.cancelAnimationFrame(canvasPointerMotionFrameRef.current);
      canvasPointerMotionFrameRef.current = null;
      activeCanvasTouchesRef.current.clear();
      canvasMultiTouchRef.current = null;
      regionPointerRef.current = null;
      regionResizeRef.current = null;
      nodeDragActiveRef.current = false;
      dragAlignmentSpatialIndexRef.current = null;
      blockCanvasTouchRef.current = false;
      syntheticTouchCancelRef.current = false;
      ctrlHeldRef.current = false;
      setCtrlHeld(false);
      setAlignmentGuides({ x: null, y: null });
      setRegionDraft(null);
      flowStore.getState().cancelConnection();
      flowStore.setState({ connectionClickStartHandle: null });
      clickConnectionPreviewRef.current = null;
      clickConnectionSucceededRef.current = false;
      setClickConnectionPreview(null);
      setClickConnectionTone("pending");
      setClickConnectionSnapPoint(null);
      connectionDraftRef.current = null;
      setConnectionDraft(null);
      setConnectionHint(null);
    };
    window.addEventListener(GAME_DIALOG_CLOSED_EVENT, resetAfterDialog);
    return () => window.removeEventListener(GAME_DIALOG_CLOSED_EVENT, resetAfterDialog);
  }, [flowStore]);
  const lowEndMobile = useLowEndMobile();
  const nextMobileShell = mobileUiPreference === "next";
  const productionRefreshIntervalMs = endgameExtremeMode
    ? Math.max(5_000, resolveProductionRefreshInterval(productionRefreshPreference, automaticRefreshState))
    : resolveProductionRefreshInterval(productionRefreshPreference, automaticRefreshState);
  const projectionFeatureActive = canvasPerformanceFeatureIsActive(canvasPerformanceFeatures, "renderProjection", endgameExtremeMode);
  const topologyCacheFeatureActive = canvasPerformanceFeatureIsActive(canvasPerformanceFeatures, "topologyCache", endgameExtremeMode);
  const extremeVisualsActive = canvasPerformanceFeatureIsActive(canvasPerformanceFeatures, "extremeVisuals", endgameExtremeMode);
  const nodeLodFeatureActive = canvasPerformanceFeatureIsActive(canvasPerformanceFeatures, "nodeLod", endgameExtremeMode);
  const canvasBeltsFeatureActive = canvasPerformanceFeatureIsActive(canvasPerformanceFeatures, "canvasBelts", endgameExtremeMode);
  const viewportCullingFeatureActive = canvasPerformanceFeatureIsActive(canvasPerformanceFeatures, "viewportCulling", endgameExtremeMode);
  const spatialIndexesFeatureActive = canvasPerformanceFeatureIsActive(canvasPerformanceFeatures, "spatialIndexes", endgameExtremeMode);
  const minimapThrottleFeatureActive = canvasPerformanceFeatureIsActive(canvasPerformanceFeatures, "minimapThrottle", endgameExtremeMode);
  const activeMobileCanvasMode: MobileCanvasMode = placement
    ? "place"
    : connectionDraft || clickConnectionPreview
      ? "connect"
      : mobileCanvasMode;
  const pointerOverlayActive = Boolean(placement || blueprintPlacementId || connectionDraft || clickConnectionPreview || game.cargo || connectionHint);
  const closeAllWorkspaces = useCallback(() => {
    setTechnologyOpen(false);
    setStatisticsOpen(false);
    setStatisticsFocusTab(null);
    setRecipesOpen(false);
    setStarMapOpen(false);
    setSystemSpaceStationOpen(false);
    setSystemSpaceStationId(null);
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
  const offlineMobileModalRef = useRef(false);
  useEffect(() => {
    if (!nextMobileShell) {
      offlineMobileModalRef.current = false;
      return;
    }
    if (offlineReport && !offlineMobileModalRef.current) {
      offlineMobileModalRef.current = true;
      mobileNavigation.openModal("offline");
      return;
    }
    if (offlineReport && offlineMobileModalRef.current &&
      !(mobileNavigation.overlay?.kind === "modal" && mobileNavigation.overlay.id === "offline")) {
      offlineMobileModalRef.current = false;
      setOfflineReport(null);
    }
  }, [mobileNavigation.openModal, mobileNavigation.overlay, nextMobileShell, offlineReport]);
  const closeOfflineReport = useCallback(() => {
    if (nextMobileShell && mobileNavigation.overlay?.kind === "modal" && mobileNavigation.overlay.id === "offline") {
      mobileNavigation.requestBack();
      return;
    }
    offlineMobileModalRef.current = false;
    setOfflineReport(null);
  }, [mobileNavigation.overlay, mobileNavigation.requestBack, nextMobileShell]);
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
  const canvasWorkspacePaused = pageHidden || technologyOpen || statisticsOpen || recipesOpen || starMapOpen ||
    systemSpaceStationOpen ||
    blueprintsOpen || dysonPlannerOpen || operationsOpen || campaignOpen || galaxyOpen || constructionCenterOpen ||
    (nextMobileShell && mobileNavigation.route.kind === "hub");
  const canvasRefreshPaused = canvasWorkspacePaused || game.paused;
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
      setCanvasViewportSize((current) => Math.abs(current.width - nextSize.width) < 1 && Math.abs(current.height - nextSize.height) < 1 ? current : nextSize);
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
        setPendingBlueprintViewport(preserved);
        setMinimapViewport(preserved);
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
    if (!coarsePointer || game.paused) {
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
  }, [coarsePointer, game.paused]);

  useEffect(() => {
    if (productionRefreshPreference !== "auto" || game.paused) return;
    setAutomaticRefreshState(createAutomaticRefreshState(coarsePointer));
  }, [coarsePointer, productionRefreshPreference]);

  useEffect(() => {
    if (productionRefreshPreference !== "auto") return;
    let frame = 0;
    let frames = 0;
    let sampledAt = performance.now();
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
        const fps = frames * 1_000 / elapsed;
        setAutomaticRefreshState((current) => updateAutomaticRefreshState(current, {
          fps,
          workerLatencyMs: workerLatencyMsRef.current,
          pendingTaskMs: simulationPendingSecondsRef.current * 1_000,
        }));
        frames = 0;
        sampledAt = now;
      }
      frame = window.requestAnimationFrame(sample);
    };
    frame = window.requestAnimationFrame(sample);
    return () => window.cancelAnimationFrame(frame);
  }, [game.paused, productionRefreshPreference]);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const response = await fetchCloudPublicStatus().catch(() => null);
      if (cancelled || !response?.activity) return;
      setGalacticActivityStatus(response.activity);
      if (!response.activity.enabled) return;
      setGame((current) => {
        const existing = current.endgame.constructionActivity.participantId;
        const participantId = existing ?? (typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : Array.from(crypto.getRandomValues(new Uint32Array(4)), (value) => value.toString(16).padStart(8, "0")).join(""));
        return synchronizeGalacticActivity(current, response.activity!, participantId);
      });
    };
    void refresh();
    const timer = window.setInterval(refresh, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const publishCanvasSnapshot = useCallback((state: GameState, force = false) => {
    if (!force && lastCanvasPublishedGameRef.current === state) return;
    const startedAt = performanceMonitor.isActive() ? performance.now() : 0;
    const result = reconcileCanvasRenderSnapshot(
      canvasRenderSnapshotRef.current,
      state,
      pendingCanvasProjectionRef.current,
      { force, enabled: projectionFeatureActive },
    );
    pendingCanvasProjectionRef.current = null;
    lastCanvasPublishedGameRef.current = state;
    canvasRenderSnapshotRef.current = result.snapshot;
    setCanvasRenderSnapshot(result.snapshot);
    if (performanceMonitor.isActive()) {
      performanceMonitor.recordCanvas({
        snapshotMs: performance.now() - startedAt,
        refreshIntervalMs: productionRefreshIntervalMs,
        lod: getCanvasLod(viewportRef.current.zoom),
        endgameExtremeMode,
        projectionEnabled: projectionFeatureActive,
        topologyRevision: result.snapshot.topologyRevision,
        runtimeRevision: result.snapshot.runtimeRevision,
      });
    }
  }, [endgameExtremeMode, performanceMonitor.isActive, performanceMonitor.recordCanvas, productionRefreshIntervalMs, projectionFeatureActive]);

  useEffect(() => {
    gameRef.current = game;
    latestCanvasGameRef.current = game;
    if (viewportOnlyGameStateRef.current === game) {
      viewportOnlyGameStateRef.current = null;
      lastCanvasPublishedGameRef.current = game;
      return;
    }
    // Editing while paused must still update the canvas immediately. Simulation
    // snapshots remain frozen because no new game state is published.
    if (!canvasWorkspacePaused && (game !== lastSimulationResultRef.current || game.paused)) {
      pendingCanvasProjectionRef.current = null;
      publishCanvasSnapshot(game, true);
    }
  }, [canvasWorkspacePaused, game, publishCanvasSnapshot]);
  useEffect(() => {
    if (canvasRefreshPaused) return;
    const timer = window.setInterval(() => {
      publishCanvasSnapshot(latestCanvasGameRef.current);
    }, productionRefreshIntervalMs);
    return () => window.clearInterval(timer);
  }, [canvasRefreshPaused, productionRefreshIntervalMs, publishCanvasSnapshot]);
  useEffect(() => {
    if (canvasWorkspacePaused || (selectedEntityIds.length === 0 && !selectedBeltId && selectedBeltIds.length === 0)) return;
    publishCanvasSnapshot(game);
  }, [canvasWorkspacePaused, game, publishCanvasSnapshot, selectedBeltId, selectedBeltIds.length, selectedEntityIds.length]);
  useEffect(() => {
    pendingCanvasProjectionRef.current = null;
    publishCanvasSnapshot(gameRef.current, true);
  }, [projectionFeatureActive, publishCanvasSnapshot]);
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
  useEffect(() => { selectionModeRef.current = selectionMode; deleteModeRef.current = deleteMode; }, [deleteMode, selectionMode]);
  useEffect(() => {
    if (!selectionMode && deleteMode) setDeleteMode(false);
  }, [deleteMode, selectionMode]);
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

  const stateWithSimulationDebt = useCallback((state: GameState): GameState => {
    let current = state;
    const pendingViewports = pendingPlanetViewportRef.current;
    if (pendingViewports.size > 0) {
      let planetViewports = state.planetViewports;
      for (const [planetId, pending] of pendingViewports) {
        const previous = planetViewports[planetId];
        if (previous?.x === pending.viewport.x && previous.y === pending.viewport.y && previous.zoom === pending.viewport.zoom) continue;
        if (planetViewports === state.planetViewports) planetViewports = { ...state.planetViewports };
        planetViewports[planetId] = pending.viewport;
      }
      if (planetViewports !== state.planetViewports) current = { ...state, planetViewports };
    }
    const submitted = simulationSubmissionRef.current;
    const pendingSimulationSeconds = simulationPendingSecondsRef.current + (submitted?.simulationSeconds ?? 0);
    const pendingWallSeconds = simulationPendingWallSecondsRef.current + (submitted?.wallSeconds ?? 0);
    if (pendingSimulationSeconds === current.timeWarp.pendingSimulationSeconds && pendingWallSeconds === current.timeWarp.pendingWallSeconds) return current;
    return {
      ...current,
      timeWarp: {
        ...current.timeWarp,
        pendingSimulationSeconds,
        pendingWallSeconds,
      },
    };
  }, []);

  const persistPrimarySave = useCallback(async (state?: GameState): Promise<SaveGameResult> => {
    const monitorSave = performanceMonitor.isActive();
    const startedAt = monitorSave ? performance.now() : 0;
    const result = await saveGameVerified(state ?? stateWithSimulationDebt(gameRef.current));
    if (monitorSave) performanceMonitor.recordSave({ durationMs: performance.now() - startedAt, bytes: result.bytes ?? 0, stages: result.timings ?? null });
    setSaveFailure(result.success ? null : result);
    return result;
  }, [performanceMonitor.isActive, performanceMonitor.recordSave, stateWithSimulationDebt]);

  useEffect(() => {
    const bridge = getDesktopBridge();
    if (!bridge?.onPrepareForUpdate) return;
    return bridge.onPrepareForUpdate(() => {
      void persistPrimarySave().finally(() => {
        void bridge.confirmUpdateReady();
      });
    });
  }, [persistPrimarySave]);

  const togglePause = useCallback(() => {
    if (gameRef.current.timeWarp.enabled) return;
    const wasPaused = gameRef.current.paused;
    setGame((current) => {
      const next = setPaused(current, !current.paused);
      gameRef.current = next;
      return next;
    });
    setNotice(wasPaused ? "模拟已继续" : "模拟已暂停");
  }, []);

  const handleTimeWarpEnabledChange = useCallback((enabled: boolean) => {
    if (enabled) {
      setPureIdleActive(true);
      pureIdleActiveRef.current = true;
      setPureIdleStartedAt(Date.now());
      setGame((current) => {
        const next = setTimeWarpEnabled(setPaused(current, false), true);
        gameRef.current = next;
        return next;
      });
      setNotice("纯挂机已开始，工厂画布已冻结");
      return;
    }
    setGame((current) => {
      const next = setTimeWarpEnabled(current, false);
      gameRef.current = next;
      return next;
    });
    pureIdleActiveRef.current = false;
    setPureIdleActive(false);
    setPureIdleStartedAt(null);
    setNotice("纯挂机已停止");
  }, []);

  const stopPureIdle = useCallback(async () => {
    pureIdleStoppingRef.current = true;
    // Let one already-running worker segment reach its safe boundary before
    // taking the final snapshot. The timer will not submit another segment.
    const waitStartedAt = performance.now();
    while (simulationSubmissionRef.current && performance.now() - waitStartedAt < 15_000) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
    }
    if (simulationSubmissionRef.current) {
      const inFlight = simulationSubmissionRef.current;
      simulationSubmissionRef.current = null;
      simulationPendingSecondsRef.current += inFlight.simulationSeconds;
      simulationPendingWallSecondsRef.current += inFlight.wallSeconds;
    }
    const pendingSimulationSeconds = simulationPendingSecondsRef.current;
    const pendingWallSeconds = simulationPendingWallSecondsRef.current;
    simulationPendingSecondsRef.current = 0;
    simulationPendingWallSecondsRef.current = 0;
    let settled = gameRef.current;
    if (!settled.paused && (pendingSimulationSeconds > 0 || pendingWallSeconds > 0)) {
      settled = advanceSimulationBudget(settled, pendingSimulationSeconds, pendingWallSeconds);
    }
    const next = setTimeWarpEnabled(settled, false);
    gameRef.current = next;
    setGame(next);
    pureIdleActiveRef.current = false;
    setPureIdleActive(false);
    setPureIdleStartedAt(null);
    const result = await persistPrimarySave(next);
    if (!result.success) {
      setSaveFailure(result);
      setNotice("挂机结果尚未完成保存，请先导出当前进度");
      pureIdleStoppingRef.current = false;
      return;
    }
    setNotice("纯挂机已停止，进度已校验保存");
    pureIdleStoppingRef.current = false;
  }, [persistPrimarySave]);

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

  const returnToMenuSafely = useCallback(async () => {
    const result = await persistPrimarySave();
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
      x: alignToDevicePixel(viewport.x),
      y: alignToDevicePixel(viewport.y),
      zoom: Math.max(0.25, Math.min(1.8, Math.round(viewport.zoom * 1000) / 1000)),
    };
    const pending = pendingPlanetViewportRef.current.get(planetId);
    if (pending) window.clearTimeout(pending.timer);
    const timer = window.setTimeout(() => {
      const latest = pendingPlanetViewportRef.current.get(planetId);
      if (!latest || latest.timer !== timer) return;
      pendingPlanetViewportRef.current.delete(planetId);
      setGame((current) => {
        const previous = current.planetViewports[planetId];
        if (previous && previous.x === latest.viewport.x && previous.y === latest.viewport.y && previous.zoom === latest.viewport.zoom) return current;
        const next = { ...current, planetViewports: { ...current.planetViewports, [planetId]: latest.viewport } };
        viewportOnlyGameStateRef.current = next;
        gameRef.current = next;
        return next;
      });
    }, 160);
    pendingPlanetViewportRef.current.set(planetId, { viewport: normalized, timer });
  }, []);
  useEffect(() => () => {
    for (const pending of pendingPlanetViewportRef.current.values()) window.clearTimeout(pending.timer);
    pendingPlanetViewportRef.current.clear();
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
      const latency = Math.max(0, performance.now() - submission.submittedAt);
      workerLatencyMsRef.current = workerLatencyMsRef.current > 0 ? workerLatencyMsRef.current * 0.75 + latency * 0.25 : latency;
      if (typeof event.data.durationMs === "number") {
        performanceMonitor.recordWorker({
          durationMs: event.data.durationMs,
          latencyMs: latency,
          pendingTaskMs: simulationPendingSecondsRef.current * 1_000,
          profiler: event.data.profiler ?? null,
          requestBytes: submission.requestBytes,
          responseBytes: event.data.transferBytes ?? 0,
        });
      }
      simulationSubmissionRef.current = null;
      const currentRegistryFingerprint = contentPackRuntimeSnapshotRef.current.fingerprint;
      if (event.data.needsRegistry || event.data.registryError) {
        simulationPendingSecondsRef.current += submission.simulationSeconds;
        simulationPendingWallSecondsRef.current += submission.wallSeconds;
        lastSimulationResultRef.current = null;
        simulationWorkerRegistryFingerprintRef.current = null;
        simulationWorkerDisabledRef.current = true;
        simulationWorkerRef.current = null;
        setSimulationWorkerActive(false);
        worker.terminate();
        setNotice(`模拟 Worker 内容包同步失败：${event.data.registryError ?? "注册表需要刷新"}，已切换到安全模拟`);
        return;
      }
      if (submission.registryFingerprint !== currentRegistryFingerprint || event.data.registryFingerprint !== submission.registryFingerprint) {
        simulationPendingSecondsRef.current += submission.simulationSeconds;
        simulationPendingWallSecondsRef.current += submission.wallSeconds;
        lastSimulationResultRef.current = null;
        simulationWorkerRegistryFingerprintRef.current = event.data.registryFingerprint ?? null;
        return;
      }
      simulationWorkerRegistryFingerprintRef.current = event.data.registryFingerprint;
      if (event.data.needsState) {
        simulationPendingSecondsRef.current += submission.simulationSeconds;
        simulationPendingWallSecondsRef.current += submission.wallSeconds;
        lastSimulationResultRef.current = null;
        return;
      }
      setGame((current) => {
        if (current !== submission.state) {
          if (current.paused) {
            // A pause is a hard simulation boundary. Drop an in-flight
            // segment rather than turning it into paused-time debt.
            simulationPendingSecondsRef.current = 0;
            simulationPendingWallSecondsRef.current = 0;
            return current;
          }
          simulationPendingSecondsRef.current += submission.simulationSeconds;
          simulationPendingWallSecondsRef.current += submission.wallSeconds;
          return current;
        }
        if (!event.data.changed) {
          lastSimulationResultRef.current = current;
          if (typeof event.data.stateRevision === "number") simulationStateRevisionRef.current = event.data.stateRevision;
          return current;
        }
        if (event.data.delta) {
          if (submission.baseStateRevision === null || event.data.delta.baseRevision !== simulationStateRevisionRef.current) {
            simulationPendingSecondsRef.current += submission.simulationSeconds;
            simulationPendingWallSecondsRef.current += submission.wallSeconds;
            lastSimulationResultRef.current = null;
            return current;
          }
          const next = applySimulationStateDelta(current, event.data.delta);
          simulationStateRevisionRef.current = event.data.delta.nextRevision;
          lastSimulationResultRef.current = next;
          gameRef.current = next;
          if (event.data.projection) {
            pendingCanvasProjectionRef.current = mergeSimulationProjections(pendingCanvasProjectionRef.current, event.data.projection);
          }
          return next;
        }
        if (!event.data.state) {
          simulationPendingSecondsRef.current += submission.simulationSeconds;
          simulationPendingWallSecondsRef.current += submission.wallSeconds;
          lastSimulationResultRef.current = null;
          return current;
        }
        if (typeof event.data.stateRevision === "number") simulationStateRevisionRef.current = event.data.stateRevision;
        lastSimulationResultRef.current = event.data.state;
        gameRef.current = event.data.state;
        if (event.data.projection) {
          pendingCanvasProjectionRef.current = mergeSimulationProjections(pendingCanvasProjectionRef.current, event.data.projection);
        }
        return event.data.state;
      });
    };
    worker.onerror = () => {
      const submission = simulationSubmissionRef.current;
      if (submission) {
        simulationPendingSecondsRef.current += submission.simulationSeconds;
        simulationPendingWallSecondsRef.current += submission.wallSeconds;
      }
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
      const currentState = gameRef.current;
      if (pureIdleStoppingRef.current) {
        previous = now;
        return;
      }
      // Paused means no simulation budget at all. In particular, do not turn
      // wall-clock time spent in a menu into catch-up production on resume.
      if (currentState.paused) {
        previous = now;
        simulationPendingSecondsRef.current = 0;
        simulationPendingWallSecondsRef.current = 0;
        return;
      }
      const wallSeconds = Math.max(0, (now - previous) / 1000);
      const elapsedSimulationSeconds = wallSeconds * getEffectiveSimulationMultiplier(currentState);
      previous = now;
      simulationPendingSecondsRef.current += elapsedSimulationSeconds;
      simulationPendingWallSecondsRef.current += wallSeconds;
      // Pure idle mode deliberately publishes less often. The worker still
      // advances the exact accumulated budget, while the covered canvas stays
      // frozen and avoids copying/rendering the full factory every second.
      if (currentState.timeWarp.enabled && simulationPendingWallSecondsRef.current < 5) return;
      const worker = simulationWorkerRef.current;
      if (worker && !simulationWorkerDisabledRef.current) {
        if (simulationSubmissionRef.current) return;
        const simulationSeconds = simulationPendingSecondsRef.current;
        const pendingWallSeconds = simulationPendingWallSecondsRef.current;
        simulationPendingSecondsRef.current = 0;
        simulationPendingWallSecondsRef.current = 0;
        const mainState = gameRef.current;
        const registrySnapshot = contentPackRuntimeSnapshotRef.current;
        const request: SimulationWorkerRequest = {
          id: simulationRequestIdRef.current + 1,
          ...(mainState !== lastSimulationResultRef.current ? { state: mainState } : {}),
          simulationSeconds,
          wallSeconds: pendingWallSeconds,
          profile: performanceMonitor.isActive(),
          registryFingerprint: registrySnapshot.fingerprint,
          protocol: experimentalSimulationDeltaRef.current ? "delta" : "full",
          multicore: multicoreSimulationOptionsRef.current,
          ...(experimentalSimulationDeltaRef.current ? { stateRevision: simulationStateRevisionRef.current } : {}),
          ...(simulationWorkerRegistryFingerprintRef.current !== registrySnapshot.fingerprint ? { registry: registrySnapshot } : {}),
        };
        simulationRequestIdRef.current = request.id;
        simulationSubmissionRef.current = {
          id: request.id,
          state: mainState,
          simulationSeconds,
          wallSeconds: pendingWallSeconds,
          registryFingerprint: registrySnapshot.fingerprint,
          baseStateRevision: mainState === lastSimulationResultRef.current && experimentalSimulationDeltaRef.current ? simulationStateRevisionRef.current : null,
          submittedAt: performance.now(),
          requestBytes: performanceMonitor.isActive() ? serializedPayloadBytes(request) : 0,
        };
        try {
          worker.postMessage(request);
        } catch {
          simulationSubmissionRef.current = null;
          simulationWorkerDisabledRef.current = true;
          simulationWorkerRef.current = null;
          setSimulationWorkerActive(false);
          worker.terminate();
          setGame((current) => {
            const profiler = performanceMonitor.isActive() ? createSimulationProfiler() : undefined;
            const startedAt = profiler ? performance.now() : 0;
            const next = advanceSimulationBudget(current, simulationSeconds, pendingWallSeconds, profiler);
            if (profiler) performanceMonitor.recordWorker({ durationMs: performance.now() - startedAt, latencyMs: 0, pendingTaskMs: 0, profiler });
            lastSimulationResultRef.current = next;
            return next;
          });
        }
        return;
      }
      const simulationSeconds = simulationPendingSecondsRef.current;
      const pendingWallSeconds = simulationPendingWallSecondsRef.current;
      simulationPendingSecondsRef.current = 0;
      simulationPendingWallSecondsRef.current = 0;
      setGame((current) => {
        const profiler = performanceMonitor.isActive() ? createSimulationProfiler() : undefined;
        const startedAt = profiler ? performance.now() : 0;
        const next = advanceSimulationBudget(current, simulationSeconds, pendingWallSeconds, profiler);
        if (profiler) performanceMonitor.recordWorker({ durationMs: performance.now() - startedAt, latencyMs: 0, pendingTaskMs: 0, profiler });
        lastSimulationResultRef.current = next;
        return next;
      });
    }, 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = game.settings.autosaveIntervalSeconds > 0
      ? window.setInterval(() => void persistPrimarySave(), game.settings.autosaveIntervalSeconds * 1000)
      : null;
    const saveNow = () => { void persistPrimarySave(); };
    const saveBeforeUnload = () => { saveGame(stateWithSimulationDebt(gameRef.current), { emergencyMirror: true }); };
    const saveWhenHidden = () => { if (document.visibilityState === "hidden") saveNow(); };
    const saveWhenNativeInactive = (event: Event) => {
      if ((event as CustomEvent<{ isActive?: boolean }>).detail?.isActive === false) saveNow();
    };
    window.addEventListener("beforeunload", saveBeforeUnload);
    window.addEventListener("pagehide", saveBeforeUnload);
    document.addEventListener("visibilitychange", saveWhenHidden);
    window.addEventListener(NATIVE_APP_STATE_EVENT, saveWhenNativeInactive);
    return () => {
      if (timer !== null) window.clearInterval(timer);
      window.removeEventListener("beforeunload", saveBeforeUnload);
      window.removeEventListener("pagehide", saveBeforeUnload);
      document.removeEventListener("visibilitychange", saveWhenHidden);
      window.removeEventListener(NATIVE_APP_STATE_EVENT, saveWhenNativeInactive);
      saveGame(stateWithSimulationDebt(gameRef.current));
    };
  }, [game.settings.autosaveIntervalSeconds, persistPrimarySave, stateWithSimulationDebt]);

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
        const uploaded = await uploadCloudSave(payload, session.cloudSave?.revision ?? 0, "main");
        const cloudSave = await refreshCloudSaveMetadata("main").catch(() => uploaded) ?? uploaded;
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
    if (!notice) return;
    if (showRunLog) {
      const id = eventSequenceRef.current + 1;
      eventSequenceRef.current = id;
      setEventHistory((current) => [...current, { id, text: notice }].slice(-4));
    }
    if (!showRunLog && !isPersistentNotice(notice)) return;
    const timer = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [notice, showRunLog]);

  useEffect(() => {
    if (showRunLog || !notice || isPersistentNotice(notice)) return;
    setNotice(null);
  }, [notice, showRunLog]);

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
      } else if (gameRef.current.timeWarp.enabled) {
        // The idle overlay owns the interaction surface. Do not let global
        // shortcuts mutate the hidden factory while it is active.
        event.preventDefault();
      } else if (!editing && !document.querySelector('[role="dialog"]') && (event.code === "Space" || key === "p")) {
        event.preventDefault();
        togglePause();
      } else if (event.key === "Delete" && !editing && !document.querySelector('[role="dialog"]')) {
        const entityIds = selectedEntityIdsRef.current.filter((entityId) =>
          gameRef.current.entities.some((entity) => entity.id === entityId && (entity.kind !== "vein" || entity.minerCount > 0)));
        const beltIds = [...new Set([...selectedBeltIdsRef.current, ...(selectedBeltIdRef.current ? [selectedBeltIdRef.current] : [])])];
        if (entityIds.length > 0 || beltIds.length > 0) {
          event.preventDefault();
          const current = gameRef.current;
          const next = beltIds.reduce((candidate, beltId) => removeBelt(candidate, beltId), removeEntities(current, entityIds));
          if (next === current) {
            setNotice("回收未执行：目标可能已锁定，或返还数量超出安全整数范围，请先导出备份");
            playTone("alert");
            return;
          }
          commitGame(() => next);
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
  }, [closeCommandPalette, commandPaletteOpen, commitGame, flowStore, mobileNavigation.overlay, mobileNavigation.requestBack, mobileNavigation.route.kind, nextMobileShell, openCommandPalette, playTone, redoGame, togglePause, undoGame]);

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

  const handleStowCargo = useCallback(() => {
    const before = gameRef.current;
    const next = dropCargoToTray(before);
    if (next === before) return;
    commitGame(() => next);
    recordBasicOnboardingEvent("cargo-stowed");
  }, [commitGame]);

  const handleDraggedItemToTray = useCallback((itemId: ItemId, sourceKind: DraggedItemSourceKind, sourceId?: string) => {
    if (!sourceId || (sourceKind !== "node" && sourceKind !== "node-input")) return;
    const before = gameRef.current;
    const next = sourceKind === "node"
      ? moveEntityOutputToTray(before, sourceId, itemId)
      : moveEntityInputToTray(before, sourceId, itemId);
    if (next === before) return;
    commitGame(() => next);
    recordBasicOnboardingEvent("cargo-stowed");
  }, [commitGame]);

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
    const currentCount = entity.kind === "vein" ? entity.minerCount : entity.machineCount;
    const stackCheck = getBuildingStackAdditionCheck(currentCount, amount, name);
    if (!stackCheck.ok) {
      setNotice(stackCheck.label);
      playTone("alert");
      return null;
    }
    const next = addUnitToEntityGroup(current, entityId, amount);
    if (next === current) {
      setNotice(`施工托盘中没有足够的${name}（需要 ${amount} 台）`);
      playTone("alert");
      return null;
    }
    const nextEntity = next.entities.find((candidate) => candidate.id === entityId)!;
    const count = nextEntity.kind === "vein" ? nextEntity.minerCount : nextEntity.machineCount;
    commitGame((state) => addUnitToEntityGroup(state, entityId, amount));
    if (entity.kind !== "vein") recordBasicOnboardingEvent("building-stacked");
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

  const handleRemoveEntity = useCallback(async (entityId: string, count?: number) => {
    const entity = gameRef.current.entities.find((candidate) => candidate.id === entityId);
    if (!entity) return;
    const availableCount = entity.kind === "vein" ? entity.minerCount : entity.machineCount;
    const removedCount = Math.min(availableCount, count ?? availableCount);
    const removesNode = entity.kind !== "vein" && removedCount >= entity.machineCount;
    if (removesNode) {
      const warning = entity.buildingId === "micro_black_hole_connector"
        ? "回收微型黑洞连接装置会移除该实体的累计销毁统计。已经销毁的物资无法恢复，确认继续吗？"
        : `确认完整回收${getBuilding(entity.buildingId!).name} ×${entity.machineCount}？输入、输出、燃料和线路物资会按现有回收规则返还。`;
      if (!await gameDialog.confirm(warning, { danger: true, confirmLabel: "确认回收" })) return;
    }
    const before = gameRef.current;
    const next = removeEntity(before, entityId, count);
    if (next === before) {
      setNotice("回收未执行：返还后数量将超出安全整数范围，请先导出备份并联系存档救援");
      playTone("alert");
      return;
    }
    commitGame(() => next);
    if (removesNode) setSelectedEntityIds((current) => current.filter((id) => id !== entityId));
    if (entity.kind === "vein" && entity.resourceId) {
      const recovered = Math.min(entity.minerCount, count ?? entity.minerCount);
      setNotice(`已回收${getBuilding(getExtractorBuildingId(entity.resourceId)).name} ×${recovered}，矿脉与运输线保持不变`);
    } else if (entity.buildingId && !removesNode) {
      setNotice(`${getBuilding(entity.buildingId).name}堆叠已减少至 ×${entity.machineCount - removedCount}，缓存、进度与线路保持不变`);
    } else if (entity.buildingId) {
      setNotice(`已完整回收${getBuilding(entity.buildingId).name} ×${entity.machineCount}`);
    }
    playTone("remove");
  }, [commitGame, gameDialog, playTone]);

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
    setPendingBlueprintViewport({ ...destinationViewport });
    setMinimapViewport({ ...destinationViewport });
    setViewport(destinationViewport, { duration: gameRef.current.settings.reducedMotion ? 0 : 180 });
    if (cargo) {
      const titanium = cargo.itemId === "titanium_ore" || cargo.itemId === "titanium_ingot";
      setNotice(`${titanium ? "托钛天王" : "手提星际运输"}：${ITEMS[cargo.itemId].name} ×${cargo.amount} 已抵达${getPlanetDisplayName(gameRef.current, planetId)}`);
    } else {
      setNotice(`已切换至${getPlanetDisplayName(gameRef.current, planetId)}`);
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
    setNotice(`${getPlanetDisplayName(gameRef.current, planetId)} 前哨建立完成`);
    playTone("place");
  }, [commitGame, playTone]);

  const alerts = useMemo(() => getFactoryAlerts(game, {
    // The top bar and planet sheet need only the count while the panel is
    // closed. Expensive labels, route descriptions and locations are built
    // when the player opens the alert workspace.
    details: operationsOpen && operationsTab === "alerts",
  }), [game, operationsOpen, operationsTab]);
  const activePlanetEntityCount = canvasRenderSnapshot.planetId === game.activePlanetId
    ? canvasRenderSnapshot.entityById.size
    : game.entities.filter((entity) => entity.planetId === game.activePlanetId).length;
  const automaticPerformanceMode = activePlanetEntityCount >= 300 || constrainedMobile || lowFrameRateMode;
  const performanceVisualMode = endgameExtremeMode || game.settings.performanceMode || automaticPerformanceMode;
  const largeFactoryMode = performanceVisualMode && (activePlanetEntityCount >= 150 || constrainedMobile);

  const toggleEndgameExtremeMode = useCallback(async (enabled: boolean) => {
    if (enabled) {
      const confirmed = await gameDialog.confirm("终局·极限模式将减少动画、线路标签和普通数据刷新，以换取更高的画布流畅度。不会改变生产、物流、库存或存档数据。", {
        confirmLabel: "开启极限模式",
        cancelLabel: "暂不开启",
      });
      if (!confirmed) return;
      acknowledgeEndgameExtremeMode();
    }
    writeEndgameExtremeMode(enabled);
    setEndgameExtremeMode(enabled);
    setNotice(enabled ? "终局优化·极限模式已开启：模拟结果不变，视觉刷新已降级" : "终局优化·极限模式已关闭");
  }, [gameDialog]);

  const updateCanvasPerformanceFeature = useCallback((id: CanvasPerformanceFeatureId, enabled: boolean) => {
    setCanvasPerformanceFeatures((current) => {
      const next = { ...current, [id]: enabled };
      writeCanvasPerformanceFeatures(next);
      return next;
    });
    if (id === "canvasBelts") setCanvasBatchFailed(false);
  }, []);

  const updateSettings = useCallback((settings: Partial<GameSettings>) => {
    setGame((current) => ({ ...current, settings: { ...current.settings, ...settings } }));
    if (settings.theme) {
      setThemeMode(settings.theme);
      writeThemePreference(settings.theme);
    }
    if (settings.soundEnabled === true) playTone("confirm", true);
  }, [playTone]);

  const updateRunLogPreference = useCallback((enabled: boolean) => {
    setShowRunLog(enabled);
    writeShowRunLogPreference(enabled);
    if (!enabled) {
      setEventHistory([]);
      setNotice((current) => current && isPersistentNotice(current) ? current : null);
    }
  }, []);

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

  const openSystemSpaceStation = useCallback((systemId: StarSystemId) => {
    closeAllWorkspaces();
    setSystemSpaceStationId(systemId);
    setSystemSpaceStationOpen(true);
    setNotice(null);
  }, [closeAllWorkspaces]);

  const handleUpgradeInterstellarStation = useCallback((entityId: string) => {
    const status = getInterstellarStationUpgradeStatus(gameRef.current, entityId);
    if (status.blocker !== "ready") {
      setNotice(`升级失败：${status.reason}`);
      playTone("alert");
      return;
    }
    commitGame((current) => upgradeInterstellarStationToMk2(current, entityId));
    setNotice("星际物流站已原地升级为 Mk.II，传统航线继续运行");
    playTone("upgrade");
  }, [commitGame, playTone]);

  const handleUpgradeAllInterstellarStations = useCallback((systemId?: StarSystemId) => {
    const result = upgradeAllInterstellarStationsToMk2(gameRef.current, systemId);
    if (result.upgradedIds.length > 0) commitGame((current) => upgradeAllInterstellarStationsToMk2(current, systemId).state);
    const scope = systemId ? `${getStarSystem(systemId).name}内` : "全星区";
    if (result.upgradedIds.length === 0) {
      const firstReason = result.skipped[0]?.reason ?? "没有找到待升级的星际物流站";
      setNotice(`${scope}升级未执行：${firstReason}`);
      playTone("alert");
      return;
    }
    const skippedText = result.skipped.length > 0 ? `，跳过 ${result.skipped.length} 座（${result.skipped.slice(0, 2).map((entry) => entry.reason).join("；")}${result.skipped.length > 2 ? "…" : ""}）` : "";
    setNotice(`${scope}已升级 ${result.upgradedIds.length} 座星际物流站${skippedText}`);
    playTone("upgrade");
  }, [commitGame, playTone]);

  const handleAttachAllQuantumStations = useCallback((systemId?: StarSystemId) => {
    const preview = attachAllInterstellarStationsToQuantumNetwork(gameRef.current, systemId);
    const scope = systemId ? `${getStarSystem(systemId).name}内` : "全星区";
    if (preview.startedIds.length === 0) {
      const firstReason = preview.skipped[0]?.reason ?? "没有找到可切换的 Mk.II 星际物流站";
      setNotice(`${scope}量子切换未执行：${firstReason}`);
      playTone("alert");
      return;
    }
    commitGame((current) => attachAllInterstellarStationsToQuantumNetwork(current, systemId).state);
    const skippedText = preview.skipped.length > 0
      ? `，跳过 ${preview.skipped.length} 座（${preview.skipped.slice(0, 2).map((entry) => entry.reason).join("；")}${preview.skipped.length > 2 ? "…" : ""}）`
      : "";
    setNotice(`${scope}已提交 ${preview.startedIds.length} 座物流站接入量子网络，仅等待旧星际航线和五秒边界；本地运输机继续运行${skippedText}`);
    playTone("confirm");
  }, [commitGame, playTone]);

  const handleAllOrbitalCollectorsQuantumMode = useCallback((enabled: boolean, systemId?: StarSystemId) => {
    const preview = setAllOrbitalCollectorsQuantumMode(gameRef.current, enabled, systemId);
    const scope = systemId ? `${getStarSystem(systemId).name}内` : "全星区";
    if (preview.startedIds.length === 0) {
      const firstReason = preview.skipped[0]?.reason ?? "没有找到可切换的轨道采集器";
      setNotice(`${scope}量子采集切换未执行：${firstReason}`);
      playTone("alert");
      return;
    }
    commitGame((current) => setAllOrbitalCollectorsQuantumMode(current, enabled, systemId).state);
    const skippedText = preview.skipped.length > 0 ? `，跳过 ${preview.skipped.length} 台` : "";
    setNotice(`${scope}已提交 ${preview.startedIds.length} 台轨道采集器${enabled ? "接入" : "关闭"}量子采集网络${skippedText}`);
    playTone("confirm");
  }, [commitGame, playTone]);

  const restoreGame = useCallback((state: GameState, report: OfflineReport | null = null) => {
    onMiningStop();
    simulationPendingSecondsRef.current = state.timeWarp.pendingSimulationSeconds;
    simulationPendingWallSecondsRef.current = state.timeWarp.pendingWallSeconds;
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
    setPendingBlueprintViewport({ ...viewport });
    setMinimapViewport({ ...viewport });
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

  const locateProductionLine = useCallback((itemId: ItemId, planetId: PlanetId) => {
    const location = getProductionLineLocations(gameRef.current, itemId).find((candidate) => candidate.planetId === planetId);
    if (!location) {
      setNotice(`${ITEMS[itemId].name}在${getPlanetDisplayName(gameRef.current, planetId)}没有可定位的生产设备`);
      return;
    }
    closeAllWorkspaces();
    setCommandPaletteOpen(false);
    setMobilePanel(null);
    setHighlightedTaskId(null);
    setFocusedBeltNetworkId(null);
    setProductionLineFocus({ ...location, itemId, activeIndex: 0 });
    if (gameRef.current.activePlanetId !== planetId) onPlanetChange(planetId);
    if (nextMobileShell) mobileNavigation.goFactory();
    window.setTimeout(() => focusEntityIds(location.producerEntityIds), gameRef.current.settings.reducedMotion ? 0 : 50);
    setNotice(`已定位${getPlanetDisplayName(gameRef.current, planetId)}的${ITEMS[itemId].name}产线 · ${location.producerEntityIds.length} 个生产节点`);
  }, [closeAllWorkspaces, focusEntityIds, mobileNavigation.goFactory, nextMobileShell, onPlanetChange]);

  const itemReferenceActions = useMemo(() => ({
    getLocateAvailability: (itemId: ItemId) => {
      const locations = getProductionLineLocations(gameRef.current, itemId);
      return locations.length > 0
        ? { available: true }
        : { available: false, reason: `${ITEMS[itemId].name}在当前存档中没有生产来源` };
    },
    onLocate: (itemId: ItemId) => {
      const locations = getProductionLineLocations(gameRef.current, itemId);
      const target = locations.find((location) => location.planetId === gameRef.current.activePlanetId) ?? locations[0];
      if (!target) {
        setNotice(`${ITEMS[itemId].name}在当前存档中没有可定位的生产设备`);
        return;
      }
      locateProductionLine(itemId, target.planetId);
    },
    onOpenCodex: (itemId: ItemId) => openRecipeFocus(itemId),
  }), [locateProductionLine, openRecipeFocus]);

  const cycleProductionLineTarget = useCallback((direction: -1 | 1) => {
    setProductionLineFocus((current) => {
      if (!current || current.producerEntityIds.length === 0) return current;
      const activeIndex = (current.activeIndex + direction + current.producerEntityIds.length) % current.producerEntityIds.length;
      const entityId = current.producerEntityIds[activeIndex];
      window.requestAnimationFrame(() => focusEntityIds([entityId]));
      return { ...current, activeIndex };
    });
  }, [focusEntityIds]);

  const quickAddEntity = useCallback((entityId: string, requestedCount = 1) => {
    const result = expandEntityGroup(entityId, requestedCount);
    if (result) setNotice(`${result.name}已增加 ${result.added} 台 · 当前 ×${result.count}`);
  }, [expandEntityGroup]);

  const updateBeltLaneCount = useCallback((beltId: string, targetLanes: number) => {
    const check = getBeltLaneAdjustmentCheck(gameRef.current, beltId, targetLanes);
    if (!check.ok) {
      setNotice(`并联数量调整失败：${check.label}`);
      playTone("alert");
      return;
    }
    if (check.delta === 0) {
      setNotice(check.label);
      return;
    }
    commitGame((current) => setBeltLaneCount(current, beltId, targetLanes));
    setNotice(`并联线路已调整为 ×${targetLanes} · ${check.label}`);
    playTone(check.delta > 0 ? "confirm" : "remove");
  }, [commitGame, playTone]);

  const updateMaterialDeliverySlot = useCallback(async (entityId: string, slotIndex: number, mode: import("./game/types").MaterialDeliverySlotMode, itemId: ItemId | null) => {
    const check = getMaterialDeliverySlotChangeCheck(gameRef.current, entityId, slotIndex, mode, itemId);
    if (!check.ok) {
      setNotice(check.label);
      return;
    }
    if (check.requiresDisconnect && !await gameDialog.confirm(`${check.label}。枢纽缓存会安全退回本行星物资托盘，是否继续？`, { danger: true, confirmLabel: "断开并重置" })) return;
    commitGame((current) => setMaterialDeliverySlot(current, entityId, slotIndex, mode, itemId, check.requiresDisconnect));
    setNotice(mode === "manual" && itemId
      ? `接口 ${slotIndex + 1} 已指定为${ITEMS[itemId].name}`
      : mode === "auto" ? `接口 ${slotIndex + 1} 已恢复自动识别` : `接口 ${slotIndex + 1} 已清空`);
  }, [commitGame, gameDialog]);

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
    setNotice(`已定位星际物流问题：${getPlanetDisplayName(gameRef.current, planetId)}`);
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
        setNotice(`${getPlanetDisplayName(gameRef.current, navigation.planetId)}尚未解锁，请先完成恒星勘探`);
        return;
      }
      onPlanetChange(navigation.planetId);
      return;
    }
    if (navigation.kind === "system") {
      setStarMapOpen(true);
      setNotice(`已打开${getStarSystemDisplayName(gameRef.current, navigation.systemId)}星图`);
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

  const runOnboardingAction = useCallback((stepId: OnboardingActionId) => {
    closeAllWorkspaces();
    if (stepId === "basic-cargo") {
      if (nextMobileShell) mobileNavigation.openSheet("inventory", "half");
      setNotice(nextMobileShell ? "拿起物品后，在物资抽屉点击全部放回" : "从节点拿起物品，再点击左侧物资托盘放下");
      return;
    }
    if (stepId === "basic-craft") {
      setInspectorTab("fabricate");
      if (nextMobileShell) mobileNavigation.openSheet("build", "full");
      else setMobilePanel("inspector");
      setNotice("选择批次数量并成功制造一批建筑");
      return;
    }
    if (stepId === "basic-place-stack") {
      if (gameRef.current.activePlanetId !== "home") onPlanetChange("home");
      setPlacement("wind_turbine");
      setPlacementCount(1);
      if (nextMobileShell) mobileNavigation.goFactory();
      setNotice(nextMobileShell ? "放置建筑后，从检查器增加一台设备" : "放置建筑后，使用数量控件或 Ctrl 连续扩建");
      return;
    }
    if (stepId === "basic-belt") {
      setPlacement(null);
      setBeltTierMode("auto");
      setNotice("依次点击输出端口和绿色高亮输入端口建立传送带");
      return;
    }
    if (stepId === "basic-research") {
      setTechnologyOpen(true);
      setNotice("选择一项可研究科技");
      return;
    }
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
  }, [closeAllWorkspaces, focusBeltNetwork, focusEntityIds, focusPlacedEntity, mobileNavigation.goFactory, mobileNavigation.openSheet, navigateFromCampaign, nextMobileShell, onPlanetChange, openCampaign]);

  const onSelectCampaignTask = useCallback((taskId: CampaignTaskId) => {
    setGame((current) => selectCampaignTask(current, taskId));
    setHighlightedTaskId(taskId);
    setFocusedBeltNetworkId(null);
  }, []);

  const saveSummaryRefreshIdRef = useRef(0);
  const refreshSaveData = useCallback(async () => {
    const refreshId = ++saveSummaryRefreshIdRef.current;
    const summaries = await getSaveSummariesInWorker();
    if (refreshId !== saveSummaryRefreshIdRef.current) return;
    setSaveSlots(summaries.slots);
    setSaveSnapshots(summaries.snapshots);
  }, []);

  const manualSave = useCallback(async () => {
    // Explicit user saves keep the existing immediate local mirror contract so
    // the save panel can reflect the new runtime without waiting for the
    // IndexedDB/Worker verification round trip. Automatic saves stay fully
    // asynchronous through persistPrimarySave().
    const immediate = saveGame(stateWithSimulationDebt(gameRef.current));
    const result = immediate.success ? await persistPrimarySave() : immediate;
    void refreshSaveData();
    setNotice(result.message);
    playTone(result.success ? "confirm" : "alert");
  }, [persistPrimarySave, playTone, refreshSaveData, stateWithSimulationDebt]);

  const downloadSave = useCallback(() => {
    void exportTextFile({
      contents: exportGame(gameRef.current),
      fileName: `dsp-idle-save-${new Date().toISOString().slice(0, 10)}.json`,
      title: "导出当前游戏存档",
    }).then(() => {
      setNotice("存档 JSON 已导出");
      playTone("confirm");
    }).catch((error) => {
      setNotice(error instanceof Error ? `存档导出失败：${error.message}` : "存档导出失败");
      playTone("alert");
    });
  }, [playTone]);

  const importSave = useCallback((raw: string) => {
    const inspection = inspectSave(raw);
    if ((!inspection.valid && !inspection.repairable) || !inspection.state) {
      setNotice(`存档导入失败：${inspection.issues[0] ?? "文件格式或版本无效"}`);
      playTone("alert");
      return;
    }
    setImportPreview(inspection);
    setPendingImportState(inspection.valid ? inspection.state : null);
    setPendingImportRaw(raw);
    setImportRescueArmed(false);
    setNotice(inspection.valid
      ? inspection.integrity === "valid" ? "已读取存档，请确认导入" : "存档可迁移，请确认导入"
      : "完整性校验失败但结构完整，可使用双确认救援");
  }, [playTone]);

  const cancelImport = useCallback(() => {
    setImportPreview(null);
    setPendingImportState(null);
    setPendingImportRaw(null);
    setImportRescueArmed(false);
  }, []);

  const confirmImport = useCallback(async () => {
    if (!pendingImportState) return;
    await saveGameSnapshotVerified(gameRef.current, "导入外部存档前");
    const result = await persistPrimarySave(pendingImportState);
    if (!result.success) {
      setNotice(result.message);
      playTone("alert");
      return;
    }
    restoreGame(pendingImportState);
    void refreshSaveData();
    setImportPreview(null);
    setPendingImportState(null);
    setPendingImportRaw(null);
    setImportRescueArmed(false);
    setNotice("存档导入完成，已自动创建回滚快照");
    playTone("complete");
  }, [pendingImportState, persistPrimarySave, playTone, refreshSaveData, restoreGame]);

  const confirmImportRescue = useCallback(() => {
    if (!importPreview?.repairable || importPreview.valid || !pendingImportRaw) return;
    if (!importRescueArmed) {
      setImportRescueArmed(true);
      setNotice("二次确认：再次点击后将先导出原始异常文件，再重新校验并导入");
      return;
    }
    const repaired = repairSave(pendingImportRaw);
    if (!repaired.success || !repaired.inspection.state) {
      setNotice(repaired.message);
      playTone("alert");
      return;
    }
    void exportTextFile({
      contents: pendingImportRaw,
      fileName: `dsp-idle-save-rescue-backup-${new Date().toISOString().slice(0, 10)}.json`,
      title: "备份救援前的原始异常存档",
    }).then(async () => {
      await saveGameSnapshotVerified(gameRef.current, "救援外部存档前");
      const result = await persistPrimarySave(repaired.inspection.state!);
      if (!result.success) {
        setNotice(result.message);
        playTone("alert");
        return;
      }
      restoreGame(repaired.inspection.state!);
      refreshSaveData();
      setImportPreview(null);
      setPendingImportState(null);
      setPendingImportRaw(null);
      setImportRescueArmed(false);
      setNotice("存档救援完成，原始异常文件与当前工厂回滚快照均已保留");
      playTone("complete");
    }).catch((error) => {
      setNotice(error instanceof Error ? `原始存档备份失败：${error.message}` : "原始存档备份失败，未执行救援");
      playTone("alert");
    });
  }, [importPreview, importRescueArmed, pendingImportRaw, persistPrimarySave, playTone, refreshSaveData, restoreGame]);

  const restoreCloudSave = useCallback(async (raw: string): Promise<{ success: boolean; message: string }> => {
    const inspection = inspectSave(raw);
    if (!inspection.valid || !inspection.state) {
      if (inspection.repairable && inspection.state) {
        setImportPreview(inspection);
        setPendingImportRaw(raw);
        setPendingImportState(null);
        setImportRescueArmed(false);
        setOperationsTab("saves");
        setOperationsOpen(true);
        return { success: false, message: "云存档校验失败，已转到存档管理的受控救援入口" };
      }
      playTone("alert");
      return { success: false, message: `云存档无效：${inspection.issues[0] ?? "格式或版本无法识别"}` };
    }
    await saveGameSnapshotVerified(gameRef.current, "恢复云存档前");
    const result = await persistPrimarySave(inspection.state);
    if (!result.success) {
      playTone("alert");
      return { success: false, message: result.message };
    }
    restoreGame(inspection.state);
    refreshSaveData();
    playTone("complete");
    return { success: true, message: "云存档已恢复，原工厂已保留为本地快照" };
  }, [persistPrimarySave, playTone, refreshSaveData, restoreGame]);

  const saveToSlot = useCallback(async (slotId: SaveSlotId) => {
    const result = await saveGameSlotVerified(slotId, gameRef.current);
    refreshSaveData();
    setNotice(result.message);
    playTone(result.success ? "confirm" : "alert");
  }, [playTone, refreshSaveData]);

  const loadFromSlot = useCallback(async (slotId: SaveSlotId) => {
    const slot = loadGameSlot(slotId);
    if (!slot) {
      setNotice(`槽位 ${slotId} 没有可用存档`);
      return;
    }
    const result = await persistPrimarySave(slot.state);
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

  const deleteSlot = useCallback(async (slotId: SaveSlotId) => {
    const removed = await clearGameSlotVerified(slotId);
    refreshSaveData();
    setNotice(removed ? `本地槽位 ${slotId} 已清空` : `本地槽位 ${slotId} 删除失败`);
  }, [refreshSaveData]);

  const createSnapshot = useCallback(async () => {
    const snapshot = await saveGameSnapshotVerified(gameRef.current, "手动快照");
    refreshSaveData();
    setNotice(snapshot ? "手动快照已创建" : "快照创建失败：本地存储空间不足");
    playTone(snapshot ? "confirm" : "alert");
  }, [playTone, refreshSaveData]);

  const loadSnapshot = useCallback(async (snapshotId: string) => {
    const state = loadSaveSnapshot(snapshotId);
    if (!state) {
      setNotice("快照不可用，可能已损坏");
      playTone("alert");
      return;
    }
    const result = await persistPrimarySave(state);
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

  const deleteSnapshot = useCallback(async (snapshotId: string) => {
    const removed = await clearSaveSnapshotVerified(snapshotId);
    refreshSaveData();
    setNotice(removed ? "快照已删除" : "快照删除失败");
  }, [refreshSaveData]);

  const deleteSnapshots = useCallback(async (snapshotIds: string[]) => {
    const result = await clearSaveSnapshotsVerified(snapshotIds);
    refreshSaveData();
    setNotice(result.failed.length === 0
      ? `已删除 ${result.removed} 份所选快照`
      : `已删除 ${result.removed} 份，${result.failed.length} 份删除失败`);
  }, [refreshSaveData]);

  const runBenchmark = useCallback(() => {
    const report = runAutomaticPerformanceReport(gameRef.current);
    setPerformanceReport(report);
    const passed = report.benchmark.deterministic && report.idleStress.completed && report.idleStress.integrityPassed;
    setNotice(`自动性能报告${passed ? "通过" : "发现异常"} · 60 秒 ${report.benchmark.durationMs}ms · ${report.idleStress.simulatedHours}h 压测 ${report.idleStress.durationMs}ms`);
    playTone(passed ? "confirm" : "alert");
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
    contentPackRuntimeSnapshotRef.current = createContentPackRuntimeSnapshot(registry);
    simulationWorkerRegistryFingerprintRef.current = null;
    lastSimulationResultRef.current = null;
    setContentPackRegistry(registry);
    // Re-render catalog-driven panels after the live registry changes.
    const contentPacks = getActiveContentPackReferences(registry);
    setGame((current) => ({ ...current, contentPacks }));
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
    void exportTextFile({ contents: JSON.stringify(createContentPackTemplate(), null, 2), fileName: "dsp-content-pack-template.json", title: "导出内容包模板" })
      .then(() => { setNotice("内容包模板已导出"); playTone("confirm"); })
      .catch((error) => { setNotice(error instanceof Error ? `模板导出失败：${error.message}` : "模板导出失败"); playTone("alert"); });
  }, [playTone]);

  const downloadBlueprint = useCallback((blueprintId: string) => {
    const blueprint = gameRef.current.blueprints.find((candidate) => candidate.id === blueprintId);
    if (!blueprint) return;
    void exportTextFile({
      contents: serializeBlueprintExchange(blueprint),
      fileName: `${blueprint.name.replace(/[\\/:*?"<>|]/g, "-").slice(0, 40) || "dsp-blueprint"}.dspblueprint.json`,
      title: `导出蓝图：${blueprint.name}`,
    }).then(() => {
      setNotice(`蓝图已导出：${blueprint.name}`);
      playTone("confirm");
    }).catch((error) => {
      setNotice(error instanceof Error ? `蓝图导出失败：${error.message}` : "蓝图导出失败");
      playTone("alert");
    });
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
    const message = `已导入蓝图：${importedName} · ${result.blueprint.entities.length} 个建筑 · ${result.blueprint.belts.length} 条传送带`;
    setNotice(message);
    playTone("complete");
    return { success: true, message };
  }, [commitGame, playTone]);

  useEffect(() => {
    if (!shouldRefreshSaveSummaries(operationsOpen, operationsTab)) return;
    refreshSaveData();
    const timer = window.setInterval(() => {
      refreshSaveData();
    }, getSaveSummaryRefreshIntervalMs(coarsePointer));
    return () => window.clearInterval(timer);
  }, [coarsePointer, operationsOpen, operationsTab, refreshSaveData]);

  useEffect(() => {
    if (!connectionHint || connectionDraft) return;
    const timer = window.setTimeout(() => setConnectionHint(null), 1800);
    return () => window.clearTimeout(timer);
  }, [connectionDraft, connectionHint]);

  const stopCanvasPointerMotion = useCallback(() => {
    canvasPointerMotionRef.current = stopCanvasPointerMotionSession(canvasPointerMotionRef.current);
    if (canvasPointerMotionFrameRef.current != null) {
      window.cancelAnimationFrame(canvasPointerMotionFrameRef.current);
      canvasPointerMotionFrameRef.current = null;
    }
    const capture = canvasPointerCaptureRef.current;
    canvasPointerCaptureRef.current = null;
    if (!capture) return;
    try {
      if (capture.element.hasPointerCapture(capture.pointerId)) capture.element.releasePointerCapture(capture.pointerId);
    } catch {
      // Browsers can release pointer capture before cancellation reaches React.
    }
  }, []);

  const scheduleCanvasEdgePan = useCallback((generation: number) => {
    if (canvasPointerMotionFrameRef.current != null) return;
    const edgePan = () => {
      canvasPointerMotionFrameRef.current = null;
      const motion = canvasPointerMotionRef.current;
      if (!canvasPointerMotionFrameIsActive(motion, generation)) return;
      const viewport = getViewport();
      const nextViewport = {
        ...viewport,
        x: viewport.x + motion.edgeVelocityX,
        y: viewport.y + motion.edgeVelocityY,
      };
      viewportRef.current = nextViewport;
      void setViewport(nextViewport, { duration: 0 });
      canvasPointerMotionFrameRef.current = window.requestAnimationFrame(edgePan);
    };
    canvasPointerMotionFrameRef.current = window.requestAnimationFrame(edgePan);
  }, [getViewport, setViewport]);

  const beginPlacementPointerMotion = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if ((!placement && !blueprintPlacementId) || event.button !== 0 || !event.isPrimary) return;
    canvasPointerMotionRef.current = beginCanvasPointerMotion(
      canvasPointerMotionRef.current,
      event.pointerId,
      event.clientX,
      event.clientY,
    );
  }, [blueprintPlacementId, placement]);

  const movePlacementPointerMotion = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const previousMotion = canvasPointerMotionRef.current;
    let motion = moveCanvasPointerMotion(
      previousMotion,
      event.pointerId,
      event.clientX,
      event.clientY,
      event.pointerType === "touch" ? 12 : 8,
    );
    if (motion === previousMotion || !motion.pointerDown) return;
    if (motion.dragging && !previousMotion.dragging && !canvasPointerCaptureRef.current) {
      canvasPointerCaptureRef.current = { element: event.currentTarget, pointerId: event.pointerId };
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Safari may reject capture during gesture transfer. */ }
    }
    const canvas = factoryCanvasRef.current;
    if (!canvas) {
      canvasPointerMotionRef.current = setCanvasPointerEdgeVelocity(motion, 0, 0);
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const margin = Math.min(72, rect.width * 0.16, rect.height * 0.16);
    const inside = event.clientX >= rect.left && event.clientX <= rect.right &&
      event.clientY >= rect.top && event.clientY <= rect.bottom;
    const hovered = document.elementFromPoint(event.clientX, event.clientY);
    const overCanvasUi = hovered instanceof Element && Boolean(hovered.closest(
      ".canvas-selection-tools, .selection-toolbar, .planet-navigator, .react-flow__controls, .react-flow__minimap, .canvas-minimap-toggle, .task-path-indicator",
    ));
    let x = 0;
    let y = 0;
    if (inside && !overCanvasUi) {
      if (event.clientX < rect.left + margin) x = 4;
      else if (event.clientX > rect.right - margin) x = -4;
      if (event.clientY < rect.top + margin) y = 4;
      else if (event.clientY > rect.bottom - margin) y = -4;
    }
    motion = setCanvasPointerEdgeVelocity(motion, x, y);
    canvasPointerMotionRef.current = motion;
    if (canvasPointerMotionFrameIsActive(motion, motion.generation)) scheduleCanvasEdgePan(motion.generation);
  }, [scheduleCanvasEdgePan]);

  useEffect(() => {
    stopCanvasPointerMotion();
  }, [blueprintPlacementId, placement, stopCanvasPointerMotion]);

  useEffect(() => {
    const stopWhenHidden = () => {
      if (document.visibilityState === "hidden") stopCanvasPointerMotion();
    };
    const stop = () => stopCanvasPointerMotion();
    window.addEventListener("blur", stop);
    window.addEventListener("orientationchange", stop);
    window.addEventListener("touchend", stop);
    document.addEventListener("visibilitychange", stopWhenHidden);
    document.addEventListener("fullscreenchange", stop);
    return () => {
      window.removeEventListener("blur", stop);
      window.removeEventListener("orientationchange", stop);
      window.removeEventListener("touchend", stop);
      document.removeEventListener("visibilitychange", stopWhenHidden);
      document.removeEventListener("fullscreenchange", stop);
      stopCanvasPointerMotion();
    };
  }, [stopCanvasPointerMotion]);

  useEffect(() => {
    if (canvasWorkspacePaused) stopCanvasPointerMotion();
  }, [canvasWorkspacePaused, game.activePlanetId, stopCanvasPointerMotion]);

  const activePlanetEntities = useMemo(
    () => canvasGame.entities.filter((entity) => entity.planetId === canvasGame.activePlanetId),
    [canvasGame.activePlanetId, canvasGame.entities],
  );
  const activePlanetBelts = useMemo(
    () => canvasGame.belts.filter((belt) => belt.planetId === canvasGame.activePlanetId),
    [canvasGame.activePlanetId, canvasGame.belts],
  );
  const canvasBatchRendererEnabled = canvasBeltsFeatureActive && !canvasBatchFailed && activePlanetBelts.length >= 180;
  const activeEntityById = useMemo(
    () => canvasRenderSnapshot.planetId === canvasGame.activePlanetId
      ? canvasRenderSnapshot.entityById
      : new Map(activePlanetEntities.map((entity) => [entity.id, entity])),
    [activePlanetEntities, canvasGame.activePlanetId, canvasRenderSnapshot.entityById, canvasRenderSnapshot.planetId],
  );

  const canvasTopology = useMemo(() => {
    const next = reconcileFactoryCanvasTopology(
      canvasTopologyRef.current,
      canvasGame.activePlanetId,
      activePlanetEntities,
      activePlanetBelts,
      topologyCacheFeatureActive ? canvasRenderSnapshot.topologyRevision : undefined,
    );
    canvasTopologyRef.current = next;
    return next;
  }, [activePlanetBelts, activePlanetEntities, canvasGame.activePlanetId, canvasRenderSnapshot.topologyRevision, topologyCacheFeatureActive]);

  const beltDiagnosticIndex = useMemo(() => ({ entityById: activeEntityById }), [activeEntityById]);

  const beltNodeIndex = useMemo(() => {
    const activeEntityIds = new Set<string>();
    for (const belt of activePlanetBelts) {
      if (belt.lastFlow > 0.001) {
        activeEntityIds.add(belt.source);
        activeEntityIds.add(belt.target);
      }
    }
    return {
      connectedInputsByTarget: canvasTopology.connectedInputsByTarget,
      activeEntityIds: [...activeEntityIds],
      occupancy: canvasTopology.occupancy,
    };
  }, [activePlanetBelts, canvasTopology]);

  const beltBundleMap = canvasTopology.bundleByBeltId;
  const activeLogisticsEntityIdSet = useMemo(() => new Set(beltNodeIndex.activeEntityIds), [beltNodeIndex.activeEntityIds]);
  const focusedBeltNetwork = useMemo(() => focusedBeltNetworkId
    ? analyzeBeltNetwork(canvasGame, focusedBeltNetworkId)
    : null, [focusedBeltNetworkId, canvasGame]);
  const focusedNetworkBeltIds = useMemo(() => new Set(focusedBeltNetwork?.beltIds ?? []), [focusedBeltNetwork]);
  const focusedNetworkEntityIds = useMemo(() => new Set(focusedBeltNetwork?.entityIds ?? []), [focusedBeltNetwork]);
  const lineFindTrace = useMemo(() => {
    if (!lineFindMode || selectedEntityIds.length !== 1) return null;
    const revision = canvasTopology.revision;
    const planetId = canvasGame.activePlanetId;
    const cached = lineFindTraceCacheRef.current;
    if (!cached || cached.planetId !== planetId || cached.revision !== revision) {
      lineFindTraceCacheRef.current = { planetId, revision, traces: new Map() };
    }
    const traceCache = lineFindTraceCacheRef.current;
    if (!traceCache) return null;
    const traces = traceCache.traces;
    const entityId = selectedEntityIds[0];
    if (!traces.has(entityId)) traces.set(entityId, analyzeEntityLineTrace(canvasGame, entityId));
    return traces.get(entityId) ?? null;
  }, [canvasGame.activePlanetId, canvasTopology.revision, lineFindMode, selectedEntityIds]);
  const lineFindUpstreamEntityIds = useMemo(() => new Set(lineFindTrace?.upstreamEntityIds ?? []), [lineFindTrace]);
  const lineFindDownstreamEntityIds = useMemo(() => new Set(lineFindTrace?.downstreamEntityIds ?? []), [lineFindTrace]);
  const lineFindUpstreamBeltIds = useMemo(() => new Set(lineFindTrace?.upstreamBeltIds ?? []), [lineFindTrace]);
  const lineFindDownstreamBeltIds = useMemo(() => new Set(lineFindTrace?.downstreamBeltIds ?? []), [lineFindTrace]);
  const locatedProductionEntityIds = useMemo(() => new Set(productionLineFocus?.relatedEntityIds ?? []), [productionLineFocus]);
  const locatedProductionBeltIds = useMemo(() => new Set(productionLineFocus?.relatedBeltIds ?? []), [productionLineFocus]);
  const selectedBeltIdSet = useMemo(() => new Set([...selectedBeltIds, ...(selectedBeltId ? [selectedBeltId] : [])]), [selectedBeltId, selectedBeltIds]);

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
    const entityIds = new Set(activePlanetEntities.flatMap((entity) => {
      const directBuilding = task.navigation?.kind === "building" && entity.buildingId === task.navigation.buildingId;
      const relevantItem = (entity.resourceId && itemIds.has(entity.resourceId)) ||
        getProducedOutputs(entity).some((itemId) => itemIds.has(itemId)) ||
        getAcceptedInputs(entity, canvasGame).some((itemId) => itemIds.has(itemId));
      return directBuilding || relevantItem ? [entity.id] : [];
    }));
    const beltIds = new Set(activePlanetBelts.flatMap((belt) => {
      if (!itemIds.has(belt.itemId)) return [];
      entityIds.add(belt.source);
      entityIds.add(belt.target);
      return [belt.id];
    }));
    return { entityIds, beltIds, itemIds };
  }, [activePlanetBelts, activePlanetEntities, canvasGame, highlightedTaskId]);

  const commonNodeData = useMemo<Omit<FactoryNodeData, "visualSignature" | "entity" | "status" | "powerFactor" | "resourceReserve" | "connectedInputItemIds" | "inputBeltCounts" | "outputBeltCounts" | "blackHolePortConnections" | "cycleRatePerSecond" | "lod" | "acceptedInputItemIds" | "producedOutputItemIds">>(() => {
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
      onInteractionLockChange: (entityId: string, locked: boolean) => {
        commitGame((current) => setEntitiesInteractionLocked(current, [entityId], locked));
        setNotice(locked ? "建筑已锁定" : "建筑已解锁");
      },
      researchLabel: technology?.name ?? null,
      researchCosts: technology?.costs.filter((cost) => (progress[cost.itemId] ?? 0) < cost.amount) ?? [],
      completedTechIds: canvasGame.research.completedTechIds,
      paused: canvasGame.paused,
      powerDemandMultiplier: getDifficultyDefinition(canvasGame.settings.difficulty).powerDemandMultiplier,
      solarGenerationMultiplier: getPlanetSolarPowerMultiplier(canvasGame, canvasGame.activePlanetId),
      windGenerationMultiplier: planetProfile.windMultiplier,
      geothermalGenerationMultiplier: planetProfile.geothermalMultiplier,
      activeLogisticsEntityIds: beltNodeIndex.activeEntityIds,
      connectionDraft,
      dysonSwarm: canvasGame.dysonSwarm,
      dysonSphere: canvasGame.dysonSphere,
      timeWarp: canvasGame.timeWarp,
      simulationMultiplier: getEffectiveSimulationMultiplier(canvasGame),
      extremeVisuals: extremeVisualsActive,
    };
  }, [beltNodeIndex.activeEntityIds, canvasGame.activePlanetId, canvasGame.cargo, canvasGame.dysonSphere, canvasGame.dysonSwarm, canvasGame.galaxy, canvasGame.paused, canvasGame.research.completedTechIds, canvasGame.research.progressByTech, canvasGame.research.selectedTechId, canvasGame.settings.difficulty, canvasGame.settings.simulationSpeed, canvasGame.timeWarp, commitGame, connectionDraft, extremeVisualsActive, miningEntityId, onAddBuilding, onDropCargo, onDropDraggedItem, onEnergyModeChange, onFuelChange, onInstallMiner, onMiningStart, onMiningStop, onPickInput, onPickOutput, onRecipeChange, placement, placementCount]);

  useEffect(() => {
    if (nodeDragActiveRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      const derivationStartedAt = performanceMonitor.isActive() ? performance.now() : 0;
      setNodes((current) => {
        const existing = new Map(current.map((node) => [node.id, node]));
        const next = activePlanetEntities.map((entity) => {
          const previous = existing.get(entity.id);
          const ejectorTarget = entity.buildingId === "em_rail_ejector" ? getEjectorOrbitTargetStatus(canvasGame, entity) : null;
          const connectedInputItemIds = beltNodeIndex.connectedInputsByTarget.get(entity.id) ?? [];
          const inputBeltCounts = beltNodeIndex.occupancy.input.get(entity.id) ?? {};
          const outputBeltCounts = beltNodeIndex.occupancy.output.get(entity.id) ?? {};
          const blackHolePortConnections = canvasTopology.targetPortItemsByEntity.get(entity.id) ?? {};
          const targetDysonOrbitLabel = ejectorTarget?.valid ? `轨道：${ejectorTarget.orbit!.name}` : ejectorTarget ? "轨道失效" : undefined;
          const powerFactor = getEntityPowerFactor(canvasGame, entity);
          const resourceReserve = getResourceReserveSnapshot(canvasGame, entity);
          const status = getEntityOperatingStatus(canvasGame, entity);
          const outputCapacity = getEntityOutputCapacity(canvasGame, entity);
          const cycleRatePerSecond = getEntityCycleRatePerSimulationSecond(canvasGame, entity);
          const selected = selectedEntityIds.includes(entity.id);
          const interactionNeedsFullNode = selected || !nodeLodFeatureActive || Boolean(placement || blueprintPlacementId || connectionDraft);
          const zoomLod = getCanvasLod(viewportZoom);
          const lod: CanvasLod = interactionNeedsFullNode ? "full" : zoomLod === "full" ? "medium" : zoomLod;
          const acceptedInputItemIds = getAcceptedInputs(entity, canvasGame);
          const producedOutputItemIds = getProducedOutputs(entity);
          const lineTraceActive = Boolean(lineFindTrace && lineFindTrace.planetId === canvasGame.activePlanetId);
          const className = lineTraceActive
            ? entity.id === lineFindTrace?.entityId
              ? "factory-flow-node--line-find-center"
              : lineFindUpstreamEntityIds.has(entity.id)
                ? "factory-flow-node--line-find-upstream"
                : lineFindDownstreamEntityIds.has(entity.id)
                  ? "factory-flow-node--line-find-downstream"
                  : "factory-flow-node--line-find-dim"
            : highlightedTaskId
            ? taskHighlight.entityIds.has(entity.id) ? "factory-flow-node--task-focus" : "factory-flow-node--task-dim"
            : productionLineFocus?.planetId === canvasGame.activePlanetId
              ? locatedProductionEntityIds.has(entity.id) ? "factory-flow-node--network-focus" : "factory-flow-node--network-dim"
            : focusedBeltNetwork
              ? focusedNetworkEntityIds.has(entity.id) ? "factory-flow-node--network-focus" : "factory-flow-node--network-dim"
              : undefined;
          const draggable = !placement && !blueprintPlacementId && !entity.interactionLocked;
          const visualSignature = [
            visualEntitySignature(entity),
            connectedInputItemIds,
            inputBeltCounts,
            outputBeltCounts,
            blackHolePortConnections,
            targetDysonOrbitLabel,
            powerFactor,
            resourceReserve,
            status,
            outputCapacity,
            cycleRatePerSecond,
            commonNodeData.cargo,
            commonNodeData.placement,
            commonNodeData.placementCount,
            commonNodeData.miningEntityId === entity.id,
            commonNodeData.paused,
            commonNodeData.simulationMultiplier,
            commonNodeData.connectionDraft,
            activeLogisticsEntityIdSet.has(entity.id),
            entity.kind === "machine" || entity.kind === "power" ? commonNodeData.completedTechIds : null,
            entity.recipeId === "matrix_research" ? [commonNodeData.researchLabel, commonNodeData.researchCosts] : null,
            entity.buildingId === "em_rail_ejector" ? commonNodeData.dysonSwarm : null,
            entity.buildingId === "vertical_launching_silo" ? commonNodeData.dysonSphere : null,
            entity.buildingId === "time_warp_device" ? commonNodeData.timeWarp : null,
            entity.kind === "power" ? [commonNodeData.solarGenerationMultiplier, commonNodeData.windGenerationMultiplier, commonNodeData.geothermalGenerationMultiplier] : null,
            commonNodeData.powerDemandMultiplier,
            selected,
            className,
            draggable,
            lod,
            commonNodeData.extremeVisuals,
            acceptedInputItemIds,
            producedOutputItemIds,
          ].join("|");
          if (previous?.data.visualSignature === visualSignature &&
            previous.position.x === entity.position.x && previous.position.y === entity.position.y &&
            previous.selected === selected && previous.className === className && previous.draggable === draggable) return previous;
          return {
            id: entity.id,
            type: entity.kind,
            position: { ...entity.position },
            measured: previous?.measured,
            data: {
              ...commonNodeData,
              visualSignature,
              entity,
              connectedInputItemIds,
              inputBeltCounts,
              outputBeltCounts,
              blackHolePortConnections,
              targetDysonOrbitLabel,
              powerFactor,
              resourceReserve,
              status,
              outputCapacity,
              cycleRatePerSecond,
              lod,
              acceptedInputItemIds,
              producedOutputItemIds,
            } as unknown as FactoryNodeData,
            selected,
            className,
            draggable,
          } satisfies FactoryFlowNode;
        });
        if (performanceMonitor.isActive()) {
          performanceMonitor.recordCanvas({
            nodeDerivationMs: performance.now() - derivationStartedAt,
            reactFlowNodeCount: next.length,
          });
        }
        return next.length === current.length && next.every((node, index) => node === current[index]) ? current : next;
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeLogisticsEntityIdSet, activePlanetEntities, beltNodeIndex.connectedInputsByTarget, beltNodeIndex.occupancy.input, beltNodeIndex.occupancy.output, blueprintPlacementId, canvasGame, canvasTopology.targetPortItemsByEntity, commonNodeData, connectionDraft, focusedBeltNetwork, focusedNetworkEntityIds, highlightedTaskId, lineFindDownstreamEntityIds, lineFindTrace, lineFindUpstreamEntityIds, locatedProductionEntityIds, nodeLodFeatureActive, performanceMonitor.isActive, performanceMonitor.recordCanvas, placement, productionLineFocus, selectedEntityIds, setNodes, taskHighlight.entityIds, viewportZoom]);

  const handleNodesChange = useCallback((changes: Parameters<typeof onNodesChange>[0]) => {
    onNodesChange(changes);
    if (changes.some((change) => change.type === "dimensions" || change.type === "add" || change.type === "remove" ||
      (change.type === "position" && !nodeDragActiveRef.current))) {
      setCanvasGeometryRevision((revision) => revision + 1);
    }
  }, [onNodesChange]);
  const connectionGeometryToken: number | readonly FactoryFlowNode[] = spatialIndexesFeatureActive ? canvasGeometryRevision : nodes;

  useEffect(() => {
    if (nodeDragActiveRef.current) return;
    let frame = 0;
    frame = window.requestAnimationFrame(() => {
      connectionHandleSpatialIndexRef.current = buildConnectionHandleSpatialIndex(viewportRef.current);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [canvasGame.activePlanetId, canvasRenderSnapshot.topologyRevision, connectionGeometryToken, viewportZoom]);

  const edgeRouteCenters = useMemo(() => {
    if (nodeDragActiveRef.current && edgeRouteCacheRef.current) return edgeRouteCacheRef.current.centers;
    if (topologyCacheFeatureActive && edgeRouteCacheRef.current?.topologyRevision === canvasTopology.revision &&
      edgeRouteCacheRef.current.geometryRevision === canvasGeometryRevision && edgeRouteCacheRef.current.simplified === largeFactoryMode) {
      return edgeRouteCacheRef.current.centers;
    }
    const rects = nodes.map((node) => ({
      id: node.id,
      x: node.position.x,
      y: node.position.y,
      width: node.measured?.width ?? 256,
      height: node.measured?.height ?? 180,
    }));
    const centers = buildFactoryEdgeRouteCenters(canvasTopology, rects, largeFactoryMode);
    edgeRouteCacheRef.current = { topologyRevision: canvasTopology.revision, geometryRevision: canvasGeometryRevision, simplified: largeFactoryMode, centers };
    return centers;
  }, [canvasGeometryRevision, canvasTopology, largeFactoryMode, nodes, topologyCacheFeatureActive]);
  const canvasLineNodeGeometry = useMemo(() => nodes.map((node) => ({
    id: node.id,
    x: node.position.x,
    y: node.position.y,
    width: node.measured?.width ?? 256,
    height: node.measured?.height ?? 180,
  })), [canvasGeometryRevision, canvasTopology.revision]);

  const edges = useMemo<FactoryFlowEdge[]>(() => {
    const derivationStartedAt = performanceMonitor.isActive() ? performance.now() : 0;
    const nextCache = new Map<string, FactoryFlowEdge>();
    const next = activePlanetBelts.map((belt) => {
      const item = ITEMS[belt.itemId];
      const capacity = getBeltCapacity(belt);
      const flowRatio = capacity > 0 ? Math.min(1, belt.lastFlow / capacity) : 0;
      const bundle = beltBundleMap.get(belt.id) ?? { index: 0, size: 1 };
      const diagnostic = diagnoseBelt(canvasGame, belt, beltDiagnosticIndex);
      const routeColor = canvasGame.settings.beltHeatmapEnabled ? beltHeatColor(diagnostic.utilization) : item.color;
      const lineTraceActive = Boolean(lineFindTrace && lineFindTrace.planetId === canvasGame.activePlanetId);
      const focusTone = lineTraceActive
        ? lineFindUpstreamBeltIds.has(belt.id) ? "line-upstream" : lineFindDownstreamBeltIds.has(belt.id) ? "line-downstream" : "line-dim"
        : highlightedTaskId
        ? taskHighlight.beltIds.has(belt.id) ? "focus" : "dim"
        : productionLineFocus?.planetId === canvasGame.activePlanetId
          ? locatedProductionBeltIds.has(belt.id) ? "focus" : "dim"
        : focusedBeltNetwork
          ? focusedNetworkBeltIds.has(belt.id) ? "focus" : "dim"
          : "normal";
      const selected = selectedBeltId === belt.id || selectedBeltIdSet.has(belt.id);
      const detailBypass = selected || hoveredBeltId === belt.id || focusTone === "focus";
      const targetHandle = belt.targetPortIndex === undefined
        ? `in:${belt.itemId}`
        : activeEntityById.get(belt.target)?.buildingId === "material_delivery_hub"
          ? `in:delivery:${belt.targetPortIndex}`
          : `in:black-hole:${belt.targetPortIndex}`;
      const className = `factory-edge factory-edge--health-${diagnostic.health}${canvasGame.settings.beltHeatmapEnabled ? " factory-edge--heatmap" : ""}${diagnostic.flow > 0.001 ? " factory-edge--active" : ""}${focusTone === "focus" ? " factory-edge--task-focus" : focusTone === "dim" ? " factory-edge--task-dim" : ""}${focusTone === "line-upstream" ? " factory-edge--line-find-upstream" : focusTone === "line-downstream" ? " factory-edge--line-find-downstream" : focusTone === "line-dim" ? " factory-edge--line-find-dim" : ""}`;
      const routeCenterY = edgeRouteCenters.get(belt.id);
      const detailVisible = extremeVisualsActive ? detailBypass : viewportZoom >= 0.55;
      const motionEnabled = !extremeVisualsActive && !coarsePointer && !performanceVisualMode && !canvasGame.settings.reducedMotion;
      const batched = canvasBatchRendererEnabled && !detailBypass;
      const strokeWidth = selected ? 3.5 : canvasGame.settings.beltHeatmapEnabled ? 1.8 + diagnostic.utilization * 2.4 : 2;
      const visualSignature = [
        belt.id, belt.source, belt.target, belt.itemId, belt.tier, belt.stackSize ?? 1, belt.routeMode ?? "auto",
        targetHandle, diagnostic.health, diagnostic.flow, diagnostic.utilization, belt.congestion ?? 0,
        belt.monitorEnabled ?? false, routeColor, focusTone, selected, routeCenterY, detailVisible, motionEnabled, batched, bundle, strokeWidth,
      ].join("|");
      const previous = edgeRenderCacheRef.current.get(belt.id);
      if (previous?.data?.visualSignature === visualSignature) {
        nextCache.set(belt.id, previous);
        return previous;
      }
      const edge = {
        id: belt.id,
        type: "factory",
        source: belt.source,
        target: belt.target,
        sourceHandle: `out:${belt.itemId}`,
        targetHandle,
        className,
        selected,
        zIndex: selected ? 1 : 0,
        interactionWidth: 36,
        markerEnd: { type: MarkerType.ArrowClosed, color: routeColor },
        data: {
          visualSignature,
          itemId: belt.itemId,
          itemName: item.name,
          itemSymbol: item.symbol,
          color: item.color,
          tier: belt.tier,
          flow: diagnostic.flow,
          capacity,
          stackSize: belt.stackSize ?? 1,
          congestion: belt.congestion ?? 0,
          monitored: belt.monitorEnabled ?? false,
          durationSeconds: Math.max(0.55, 1.65 - flowRatio * 0.9),
          detailVisible,
          motionEnabled,
          batched,
          routeMode: belt.routeMode ?? "auto",
          routeCenterY,
          bundleIndex: bundle.index,
          bundleSize: bundle.size,
          health: diagnostic.health,
          taskTone: focusTone,
        },
        style: {
          stroke: routeColor,
          strokeWidth,
        },
      } satisfies FactoryFlowEdge;
      nextCache.set(belt.id, edge);
      return edge;
    });
    edgeRenderCacheRef.current = nextCache;
    if (performanceMonitor.isActive()) {
      performanceMonitor.recordCanvas({
        edgeDerivationMs: performance.now() - derivationStartedAt,
        reactFlowEdgeCount: next.length,
        canvasLineSegments: canvasBatchRendererEnabled ? next.filter((edge) => edge.data?.batched).length : 0,
      });
    }
    return next;
  }, [activeEntityById, activePlanetBelts, beltBundleMap, beltDiagnosticIndex, canvasBatchRendererEnabled, canvasGame, coarsePointer, edgeRouteCenters, extremeVisualsActive, focusedBeltNetwork, focusedNetworkBeltIds, highlightedTaskId, hoveredBeltId, lineFindDownstreamBeltIds, lineFindTrace, lineFindUpstreamBeltIds, locatedProductionBeltIds, performanceMonitor.isActive, performanceMonitor.recordCanvas, performanceVisualMode, productionLineFocus, selectedBeltId, selectedBeltIdSet, taskHighlight.beltIds, viewportZoom]);
  const detailedCanvasBeltIds = useMemo(() => {
    const ids = new Set(selectedBeltIdSet);
    if (hoveredBeltId) ids.add(hoveredBeltId);
    for (const id of focusedNetworkBeltIds) ids.add(id);
    for (const id of taskHighlight.beltIds) ids.add(id);
    for (const id of locatedProductionBeltIds) ids.add(id);
    return ids;
  }, [focusedNetworkBeltIds, hoveredBeltId, locatedProductionBeltIds, selectedBeltIdSet, taskHighlight.beltIds]);
  const handleCanvasBatchUnavailable = useCallback(() => {
    setCanvasBatchFailed(true);
    setNotice("批量线路画布不可用，已自动回退到完整 SVG 线路");
  }, []);
  const handleMinimapCanvasUnavailable = useCallback(() => {
    setMinimapCanvasFailed(true);
    setNotice("低频小地图不可用，已自动回退到完整小地图");
  }, []);
  const centerCanvasFromMinimap = useCallback((x: number, y: number) => {
    void setCenter(x, y, { zoom: viewportRef.current.zoom, duration: gameRef.current.settings.reducedMotion ? 0 : 100 });
  }, [setCenter]);
  const zoomCanvasFromMinimap = useCallback((direction: 1 | -1) => {
    void (direction > 0 ? zoomIn({ duration: 0 }) : zoomOut({ duration: 0 }));
  }, [zoomIn, zoomOut]);
  useEffect(() => {
    if (!performanceMonitor.snapshot.active) return;
    performanceMonitor.recordCanvas({
      reactFlowNodeCount: nodes.length,
      reactFlowEdgeCount: edges.length,
      canvasLineSegments: canvasBatchRendererEnabled ? edges.filter((edge) => edge.data?.batched).length : 0,
      refreshIntervalMs: productionRefreshIntervalMs,
      lod: getCanvasLod(viewportRef.current.zoom),
      endgameExtremeMode,
      projectionEnabled: projectionFeatureActive,
      topologyRevision: canvasRenderSnapshot.topologyRevision,
      runtimeRevision: canvasRenderSnapshot.runtimeRevision,
    });
  }, [canvasBatchRendererEnabled, canvasRenderSnapshot.runtimeRevision, canvasRenderSnapshot.topologyRevision, edges, endgameExtremeMode, nodes, performanceMonitor.recordCanvas, performanceMonitor.snapshot.active, productionRefreshIntervalMs, projectionFeatureActive]);

  const isValidConnection = useCallback((connection: Connection | Edge) => {
    const sourceItem = parseHandleItem(connection.sourceHandle);
    const targetItem = parseHandleItem(connection.targetHandle);
    if (!connection.source || !connection.target || connection.source === connection.target ||
      !sourceItem || (!isUniversalInputHandle(connection.targetHandle) && sourceItem !== targetItem)) return false;
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
      canConnectBelt(state, connection.source, connection.target, sourceItem, tier, parseTargetPortIndex(connection.targetHandle)) &&
      (state.construction[constructionId] ?? 0) >= 1);
  }, [beltTier, beltTierMode]);

  const beginConnectionDraft = useCallback((params: OnConnectStartParams): ConnectionDraft | null => {
    const itemId = parseHandleItem(params.handleId);
    const universalPort = parseTargetPortIndex(params.handleId);
    if (!params.nodeId || !params.handleType || !params.handleId || (!itemId && universalPort === undefined)) return null;
    const tier = resolveConnectionBeltTier(gameRef.current, beltTierMode, beltTier, params.nodeId, itemId ?? undefined);
    const draft = { nodeId: params.nodeId, handleId: params.handleId, itemId, handleType: params.handleType, tier } satisfies ConnectionDraft;
    updateConnectionDraft(draft);
    const universalLabel = params.handleId.startsWith("in:delivery:") ? `物资配送接口 ${universalPort! + 1}` : `微型黑洞接口 ${universalPort! + 1}`;
    setConnectionHint({
      label: `${itemId ? ITEMS[itemId].name : universalLabel} · Mk.${tier === 3 ? "III" : tier === 2 ? "II" : "I"} 已锁定 · 连接到${params.handleType === "source" ? "输入" : "输出"}端口`,
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

  const handleCanvasPointerPosition = useCallback((point: { x: number; y: number }) => {
    pointerRef.current = point;
    const preview = clickConnectionPreviewRef.current;
    if (!preview) return;
    const handle = findConnectionHandleAtPoint(
      point.x,
      point.y,
      coarsePointer ? 56 : 24,
      (candidate) => isValidConnection(connectionFromDraft(preview.draft, candidate)),
      connectionHandleSpatialIndexRef.current,
    );
    const overOrigin = handle?.nodeId === preview.draft.nodeId && handle.handleType === preview.draft.handleType &&
      handle.handleId === preview.draft.handleId;
    const tone = !handle || overOrigin
      ? "pending"
      : isValidConnection(connectionFromDraft(preview.draft, handle)) ? "valid" : "invalid";
    setClickConnectionTone((current) => current === tone ? current : tone);
    if (!handle || overOrigin) {
      setClickConnectionSnapPoint(null);
      setConnectionHint({ label: preview.draft.itemId
        ? `${ITEMS[preview.draft.itemId].name} · 选择高亮输入端口`
        : "选择任意物资的输出端口", tone: "ready" });
      return;
    }
    const bounds = handle.element.getBoundingClientRect();
    const snapPoint = { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
    setClickConnectionSnapPoint((current) => current && Math.abs(current.x - snapPoint.x) < 0.5 && Math.abs(current.y - snapPoint.y) < 0.5 ? current : snapPoint);
    const connection = connectionFromDraft(preview.draft, handle);
    const connectionItem = parseHandleItem(connection.sourceHandle) ?? preview.draft.itemId;
    if (tone !== "valid" || !connection.source || !connection.target) {
      const check = connection.source && connection.target && connectionItem
        ? getBeltConnectionCheck(gameRef.current, connection.source, connection.target, connectionItem, preview.draft.tier,
          parseTargetPortIndex(connection.targetHandle))
        : null;
      setConnectionHint({ label: check && !check.ok ? check.label : "当前端口不可连接", tone: "blocked" });
      return;
    }
    if (!connectionItem) return;
    const forecast = predictBeltConnection(gameRef.current, connection.source, connection.target, connectionItem, preview.draft.tier);
    setConnectionHint({
      label: forecast ? `${ITEMS[connectionItem].name} · ${forecast.label}` : `${ITEMS[connectionItem].name} · 可以连接`,
      tone: forecast?.tone === "capacity" || forecast?.tone === "starved" ? "blocked" : "ready",
    });
  }, [coarsePointer, isValidConnection]);

  const onConnectEnd = useCallback((event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
    const endPoint = getEventPoint(event);
    const draft = connectionDraftRef.current ?? connectionDraft;
    const releaseHandle = getConnectionHandleTarget(event.target) ?? (endPoint ? findConnectionHandleAtPoint(
      endPoint.x,
      endPoint.y,
      coarsePointer ? 56 : 24,
      draft ? (candidate) => isValidConnection(connectionFromDraft(draft, candidate)) : undefined,
      connectionHandleSpatialIndexRef.current,
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
        setConnectionHint({ label: `${draft.itemId ? ITEMS[draft.itemId].name : "物资"}运输线已建立`, tone: "ready" });
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
    else if (state.toHandle && !isUniversalInputHandle(state.toHandle.id) && fromItem !== toItem) label = `物品不兼容：需要${fromItem ? ITEMS[fromItem].name : "同一种物品"}`;
    else if (state.toHandle && state.fromHandle?.type === state.toHandle.type) label = "输出端口必须连接输入端口";
    else if ((current.construction[getBeltConstructionId(lockedTier)] ?? 0) < 1) label = "施工托盘中没有本次锁定等级的传送带";
    else if (!source || !target) label = "请释放到设备的同色输入端口";
    else if (source.planetId !== target.planetId) label = "两端必须位于同一行星";
    else if (!fromItem || !getProducedOutputs(source).includes(fromItem)) label = `${fromItem ? ITEMS[fromItem].name : "该物品"}不是当前输出`;
    else {
      const existing = current.belts.find((belt) => belt.source === source.id && belt.target === target.id && belt.itemId === fromItem);
      if (existing && existing.tier !== lockedTier) label = `已有并行线路使用 Mk.${existing.tier === 3 ? "III" : existing.tier === 2 ? "II" : "I"}，请手动指定同级传送带`;
      else {
        const check = getBeltConnectionCheck(current, source.id, target.id, fromItem, lockedTier, parseTargetPortIndex(state.toHandle?.id));
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
      connectionHandleSpatialIndexRef.current,
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
      const connectedItem = parseHandleItem(connection?.sourceHandle) ?? preview.draft.itemId;
      setConnectionHint({ label: `${connectedItem ? ITEMS[connectedItem].name : "物资"}运输线已建立`, tone: "ready" });
      return;
    }

    const current = gameRef.current;
    const sourceItem = parseHandleItem(connection?.sourceHandle) ?? preview.draft.itemId;
    const source = connection?.source ? current.entities.find((entity) => entity.id === connection.source) : undefined;
    const target = connection?.target ? current.entities.find((entity) => entity.id === connection.target) : undefined;
    let label = "请选择设备的高亮端口";
    if (targetHandle?.handleType === preview.draft.handleType) label = "输出端口必须连接输入端口";
    else if (connection?.source === connection?.target) label = "设备不能连接到自身";
    else if (targetHandle && preview.draft.itemId && !isUniversalInputHandle(connection?.targetHandle) && parseHandleItem(targetHandle.handleId) !== preview.draft.itemId) label = `物品不兼容：需要${ITEMS[preview.draft.itemId].name}`;
    else if ((current.construction[getBeltConstructionId(preview.draft.tier)] ?? 0) < 1) label = "施工托盘中没有本次锁定等级的传送带";
    else if (!source || !target) label = "请选择设备的高亮端口";
    else if (source.planetId !== target.planetId) label = "两端必须位于同一行星";
    else if (!sourceItem || !getProducedOutputs(source).includes(sourceItem)) label = `${sourceItem ? ITEMS[sourceItem].name : "该物品"}不是当前输出`;
    else {
      const targetPortIndex = parseTargetPortIndex(connection?.targetHandle);
      const existing = current.belts.find((belt) => belt.source === source.id && belt.target === target.id && belt.itemId === sourceItem &&
        belt.targetPortIndex === targetPortIndex);
      if (existing && existing.tier !== preview.draft.tier) label = `已有并行线路使用 Mk.${existing.tier === 3 ? "III" : existing.tier === 2 ? "II" : "I"}，请手动指定同级传送带`;
      else {
        const check = getBeltConnectionCheck(current, source.id, target.id, sourceItem!, preview.draft.tier, targetPortIndex);
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
      (!isUniversalInputHandle(connection.targetHandle) && sourceItem !== targetItem)) {
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
    const targetPortIndex = parseTargetPortIndex(connection.targetHandle);
    const matchingEndpoint = gameRef.current.belts.find((belt) =>
      belt.source === connection.source && belt.target === connection.target && belt.itemId === sourceItem &&
      belt.targetPortIndex === targetPortIndex);
    if (matchingEndpoint && matchingEndpoint.tier !== activeTier) {
      setNotice(`已有并行线路使用 Mk.${matchingEndpoint.tier === 3 ? "III" : matchingEndpoint.tier === 2 ? "II" : "I"}，请手动选择同级传送带`);
      return;
    }
    const before = gameRef.current;
    const source = before.entities.find((entity) => entity.id === connection.source);
    const target = before.entities.find((entity) => entity.id === connection.target);
    const result = connectBeltWithResult(before, connection.source, connection.target, sourceItem, activeTier, targetPortIndex);
    if (result.state === before || !result.beltId) {
      const reason = !source || !target
        ? "节点已不存在"
        : source.planetId !== target.planetId
          ? "两端必须位于同一行星"
          : !getProducedOutputs(source).includes(sourceItem)
            ? `${ITEMS[sourceItem].name}不是当前输出`
           : !getBeltConnectionCheck(before, source.id, target.id, sourceItem, activeTier, targetPortIndex).ok
              ? getBeltConnectionCheck(before, source.id, target.id, sourceItem, activeTier, targetPortIndex).label
              : "施工托盘中没有可用传送带";
      setNotice(`运输线未建立：${reason}`);
      setConnectionHint({ label: `未建立 · ${reason}`, tone: "blocked" });
      spawnInteractionBurst(pointerRef.current.x, pointerRef.current.y, "连接失败", "warning");
      playTone("alert");
      return;
    }
    if (clickConnectionPreviewRef.current) clickConnectionSucceededRef.current = true;
    flowStore.getState().resetSelectedElements();
    commitGame(() => result.state);
    setSelectedEntityIds([]);
    setSelectedBeltId(result.beltId);
    setSelectedBeltIds([result.beltId]);
    setInspectorTab("inspect");
    setRightSidebarCollapsed(false);
    if (nextMobileShell) mobileNavigation.openSheet("inspector", "peek");
    else if (coarsePointer) setMobilePanel("inspector");
    recordBasicOnboardingEvent("belt-connected");
    trackAnalyticsEvent("belt_connect");
    setNotice(`${ITEMS[sourceItem].name}运输线已建立 · Mk.${tierName}`);
    spawnInteractionBurst(pointerRef.current.x, pointerRef.current.y, "运输线已建立", "positive");
    playTone("connect");
  }, [beltTier, beltTierMode, coarsePointer, commitGame, flowStore, mobileNavigation.openSheet, nextMobileShell, playTone, spawnInteractionBurst]);

  useEffect(() => { connectRequestRef.current = onConnect; }, [onConnect]);

  const completeClickConnectionAtPoint = useCallback((x: number, y: number) => {
    const preview = clickConnectionPreviewRef.current;
    if (!preview) return false;
    const targetHandle = findConnectionHandleAtPoint(
      x,
      y,
      coarsePointer ? 56 : 24,
      (candidate) => isValidConnection(connectionFromDraft(preview.draft, candidate)),
      connectionHandleSpatialIndexRef.current,
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

  const alignmentIndexNodes = spatialIndexesFeatureActive ? canvasLineNodeGeometry : nodes.map((node) => ({
    id: node.id,
    x: node.position.x,
    y: node.position.y,
    width: node.measured?.width ?? 256,
    height: node.measured?.height ?? 180,
  }));
  const alignmentSpatialIndex = useMemo<AlignmentSpatialIndex>(() => buildAlignmentSpatialIndex(alignmentIndexNodes.map((candidate) => ({
    id: candidate.id,
    x: candidate.x,
    y: candidate.y,
    width: candidate.width,
    height: candidate.height,
    selected: selectedEntityIds.includes(candidate.id),
  }))), [alignmentIndexNodes, selectedEntityIds]);

  useEffect(() => {
    alignmentSpatialIndexRef.current = alignmentSpatialIndex;
  }, [alignmentSpatialIndex]);

  const onNodeDrag = useCallback((_event: MouseEvent | TouchEvent, node: FactoryFlowNode, draggedNodes: FactoryFlowNode[]) => {
    const threshold = 7 / Math.max(0.3, viewportZoom);
    const index = dragAlignmentSpatialIndexRef.current ?? alignmentSpatialIndex;
    const moving = (draggedNodes.length > 0 ? draggedNodes : [node]).map((candidate) => ({
      id: candidate.id,
      x: candidate.position.x,
      y: candidate.position.y,
      width: candidate.measured?.width ?? 256,
      height: candidate.measured?.height ?? 180,
    }));
    const guides = findAlignmentGuides(index, moving, threshold);
    setAlignmentGuides((current) => current.x === guides.x && current.y === guides.y ? current : guides);
  }, [alignmentSpatialIndex, viewportZoom]);

  const onSelectionChange = useCallback(({ nodes: selectedNodes, edges: selectedEdges }: OnSelectionChangeParams<FactoryFlowNode, Edge>) => {
    const ids = selectedNodes.map((node) => node.id);
    // React Flow can emit a transient empty selection while node objects are
    // replaced by a simulation refresh. Pane clicks remain the explicit
    // cancellation path, so preserve a stable browse-mode selection here.
    if (ids.length === 0 && selectedEdges.length === 0 && selectedEntityIdsRef.current.length > 0 && !selectionModeRef.current && !deleteModeRef.current) return;
    const nodeIds = new Set(ids);
    const beltIds = new Set(selectedEdges.map((edge) => edge.id));
    for (const belt of gameRef.current.belts) {
      if (belt.planetId === gameRef.current.activePlanetId && nodeIds.has(belt.source) && nodeIds.has(belt.target)) beltIds.add(belt.id);
    }
    setSelectedEntityIds((current) => current.length === ids.length && current.every((id, index) => id === ids[index]) ? current : ids);
    const nextBeltIds = [...beltIds];
    setSelectedBeltIds((current) => current.length === beltIds.size && current.every((id) => beltIds.has(id)) ? current : nextBeltIds);
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
    const clickedEntity = gameRef.current.entities.find((entity) => entity.id === node.id);
    setSelectedEntityIds((current) => {
      const nextIds = event.shiftKey || selectionMode || mobileSelecting
        ? current.includes(node.id) ? current.filter((id) => id !== node.id) : [...current, node.id]
        : [node.id];
      selectedEntityIdsRef.current = nextIds;
      return nextIds;
    });
    setSelectedBeltId(null);
    setSelectedBeltIds([]);
    setInspectorTab("inspect");
    if (!selectionMode && !mobileSelecting) {
      if (clickedEntity?.buildingId === "galactic_material_exporter") {
        openCommandWorkspace("statistics");
        setStatisticsFocusTab("galaxy");
        setNotice("已打开宇宙联合空间站建设任务");
      } else if (nextMobileShell) mobileNavigation.openSheet("inspector", "peek");
      else setMobilePanel("inspector");
    }
  }, [blueprintPlacementId, completeClickConnectionAtPoint, expandEntityGroup, mobileCanvasMode, mobileContinuousPlacement, mobileNavigation.openSheet, nextMobileShell, openCommandWorkspace, placement, placementCount, selectionMode]);

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
    stopCanvasPointerMotion();
    blockCanvasTouchRef.current = true;
    nodeDragActiveRef.current = false;
    dragAlignmentSpatialIndexRef.current = null;
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
  }, [flowStore, onMiningStop, restoreCanvasEntityPositions, stopCanvasPointerMotion, updateConnectionDraft]);

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
    canvasPinchLodRef.current = getCanvasLod(viewportRef.current.zoom);
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
    const nextLod = getCanvasLod(zoom);
    if (nextLod !== canvasPinchLodRef.current) {
      canvasPinchLodRef.current = nextLod;
      setViewportZoom(zoom);
    }
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
      const blueprint = gameRef.current.blueprints.find((candidate) => candidate.id === blueprintPlacementId);
      const preview = getBlueprintPlacementPreview(gameRef.current, blueprintPlacementId, position);
      const compatible = canQueueBlueprint(gameRef.current, blueprintPlacementId, gameRef.current.activePlanetId, position) &&
        Boolean(blueprint?.entities.length || preview.matchedResourceAnchors > 0);
      const deployable = preview.canPlace && compatible;
      const fleetPreview = deployable ? getBlueprintFleetLoadPreview(gameRef.current, blueprintPlacementId) : null;
      const blueprintName = blueprint?.name ?? "蓝图";
      commitGame((current) => {
        const currentPreview = getBlueprintPlacementPreview(current, blueprintPlacementId, position);
        const currentCompatible = canQueueBlueprint(current, blueprintPlacementId, current.activePlanetId, position) &&
          Boolean(current.blueprints.find((candidate) => candidate.id === blueprintPlacementId)?.entities.length || currentPreview.matchedResourceAnchors > 0);
        const next = currentPreview.canPlace && currentCompatible
          ? placeBlueprint(current, blueprintPlacementId, position)
          : currentCompatible
            ? queueBlueprint(current, blueprintPlacementId, position)
            : current;
        return next;
      });
      if (deployable) playTone("place");
      setSelectedEntityIds([]);
      const fleetShortfall = fleetPreview
        ? [fleetPreview.drones.shortfall > 0 ? `运输机缺 ${fleetPreview.drones.shortfall}` : "", fleetPreview.vessels.shortfall > 0 ? `运输船缺 ${fleetPreview.vessels.shortfall}` : ""].filter(Boolean).join("、")
        : "";
      const resourceSummary = preview.skippedResourceAnchors.length > 0
        ? ` · 跳过 ${preview.skippedResourceAnchors.length} 个无兼容矿脉的采矿锚点`
        : preview.matchedResourceAnchors > 0
          ? ` · 匹配 ${preview.matchedResourceAnchors} 个矿脉并安装 ${preview.extractorInstallCount} 台采集设备`
          : "";
      setNotice(deployable
        ? `${blueprintName}部署完成${resourceSummary}${fleetShortfall ? ` · 载具已部分装载（${fleetShortfall}）` : ""} · 连续放置中`
        : compatible ? `${blueprintName}已加入施工队列${resourceSummary} · 连续放置中`
          : preview.skippedResourceAnchors.length > 0
            ? `${blueprintName}未部署：附近没有对应类型的资源点，矿脉和采集设备均未改动`
            : `${blueprintName}与当前行星不兼容`);
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
      recordBasicOnboardingEvent("building-placed");
      if (placementCount > 1) recordBasicOnboardingEvent("building-stacked");
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
      recordBasicOnboardingEvent("building-placed");
      if (placementCount > 1) recordBasicOnboardingEvent("building-stacked");
    }
    commitGame((current) => placeBuilding(current, buildingId, position, placementCount));
    setPlacement(null);
  }, [commitGame, placementCount, playTone, screenToFlowPosition]);

  const selectedEntities = game.entities.filter((entity) => selectedEntityIds.includes(entity.id) && entity.planetId === game.activePlanetId);
  const selectedEntity = selectedEntities.length === 1 ? selectedEntities[0] : null;
  const selectedBelt = observedGame.belts.find((belt) => belt.id === selectedBeltId && belt.planetId === observedGame.activePlanetId) ?? null;
  const selectedBelts = game.belts.filter((belt) => selectedBeltIds.includes(belt.id) && belt.planetId === game.activePlanetId);
  const dockBeltTier = resolveConnectionBeltTier(game, beltTierMode, beltTier);
  const blueprintEligibleIds = getBlueprintEligibleEntityIds(game, selectedEntityIds);
  const activeBlueprint = game.blueprints.find((blueprint) => blueprint.id === blueprintPlacementId) ?? null;
  const mobileActionEntity = game.entities.find((entity) => entity.id === mobileActionEntityId) ?? null;

  const confirmRemoveSelection = useCallback(async () => {
    const entityIds = [...selectedEntityIdsRef.current];
    const beltIds = [...new Set([
      ...selectedBeltIdsRef.current,
      ...(selectedBeltIdRef.current ? [selectedBeltIdRef.current] : []),
    ])];
    const preview = getEntityRemovalPreview(gameRef.current, entityIds, beltIds);
    if (preview.entityCount === 0 && preview.relatedBeltCount === 0) {
      setNotice("当前选区没有可回收内容；已锁定建筑不会被删除");
      playTone("alert");
      return;
    }
    if (!preview.refundSafe) {
      setNotice("回收未执行：预计返还会超出安全整数范围，请先导出备份并联系存档救援");
      playTone("alert");
      return;
    }
    const returnLabels = preview.returns.slice(0, 6).map((entry) =>
      `${getConstructionDefinition(entry.constructionId)?.name ?? entry.constructionId} ×${formatQuantityCompact(entry.amount)}`);
    const returnSummary = returnLabels.length > 0
      ? `预计返还：${returnLabels.join("、")}${preview.returns.length > returnLabels.length ? `等 ${preview.returns.length} 类物资` : ""}。`
      : "没有可返还的施工物资。";
    const confirmed = await gameDialog.confirm(
      `确认回收 ${preview.entityCount} 个建筑节点（合计堆叠 ${preview.buildingCount.toLocaleString("zh-CN")}）和 ${preview.relatedBeltCount} 条相关传送带？${returnSummary}`,
      { danger: true, confirmLabel: "确认回收" },
    );
    if (!confirmed) return;
    const current = gameRef.current;
    const next = beltIds.reduce((state, beltId) => removeBelt(state, beltId), removeEntities(current, entityIds));
    if (next === current) {
      setNotice("回收未执行：目标可能已锁定、已删除，或返还数量超出安全整数范围");
      playTone("alert");
      return;
    }
    commitGame(() => next);
    setSelectedEntityIds([]);
    setSelectedBeltIds([]);
    setSelectedBeltId(null);
    setNotice(`已回收 ${preview.entityCount} 个建筑节点和 ${preview.relatedBeltCount} 条相关传送带`);
    playTone("remove");
  }, [commitGame, gameDialog, playTone]);

  const changeRemoteStationSlotItem = useCallback(async (entityId: string, slotIndex: number, itemId: ItemId | null) => {
    const station = gameRef.current.entities.find((entity) => entity.id === entityId);
    const previousItemId = station ? getStationSlots(station)[slotIndex]?.itemId : undefined;
    if (!station || previousItemId === itemId) return;
    const previousLabel = previousItemId ? ITEMS[previousItemId].name : "空槽位";
    const nextLabel = itemId ? ITEMS[itemId].name : "清空槽位";
    const confirmed = await gameDialog.confirm(
      `确认将${getPlanetDisplayName(gameRef.current, station.planetId)}的槽位 ${slotIndex + 1} 从“${previousLabel}”改为“${nextLabel}”？原槽位缓存会退回该行星物资托盘，相关传送带会拆除并返还，相关运输任务会安全取消。`,
      { danger: Boolean(previousItemId), confirmLabel: "确认修改" },
    );
    if (!confirmed) return;
    const before = gameRef.current;
    const next = setRemoteStationSlotItem(before, entityId, slotIndex, itemId);
    if (next === before) {
      setNotice("槽位物品未修改：目标已锁定、配置重复或状态已变化");
      playTone("alert");
      return;
    }
    commitGame(() => next);
    setNotice(`已远程修改${getPlanetDisplayName(next, station.planetId)}的物流槽位`);
  }, [commitGame, gameDialog, playTone]);

  const changeRemoteCollectorItem = useCallback(async (entityId: string, itemId: ItemId) => {
    const collector = gameRef.current.entities.find((entity) => entity.id === entityId && entity.buildingId === "orbital_collector");
    if (!collector || collector.storedItemId === itemId) return;
    const confirmed = await gameDialog.confirm(
      `确认将${getPlanetDisplayName(gameRef.current, collector.planetId)}的轨道采集器切换为${ITEMS[itemId].name}？已有本地缓存、线路和运输任务会按现有物流切换规则处理。`,
      { confirmLabel: "确认切换" },
    );
    if (!confirmed) return;
    const before = gameRef.current;
    const next = setLogisticsItem(before, entityId, itemId);
    if (next === before) {
      setNotice("轨道采集物品未修改：目标已锁定或该气体不可用");
      playTone("alert");
      return;
    }
    commitGame(() => next);
    setNotice(`轨道采集器已切换为${ITEMS[itemId].name}`);
  }, [commitGame, gameDialog, playTone]);

  const changeRemoteFleetTarget = useCallback((entityId: string, kind: "drone" | "vessel", target: number) => {
    const result = setRemoteStationFleetTarget(gameRef.current, entityId, kind, target);
    if (result.state !== gameRef.current) commitGame(() => result.state);
    const label = kind === "drone" ? "物流运输机" : "物流运输船";
    setNotice(result.reason === "busy-vehicles"
      ? `${label}目标不能低于执行中数量 ${result.busy}`
      : result.reason === "portable-stock"
        ? `${label}已调整为 ${result.final}/${result.capacity}，随身库存不足，仍缺 ${result.shortfall}`
        : result.reason ? `${label}数量调整失败` : `${label}已调整为 ${result.final}/${result.capacity}`);
  }, [commitGame]);

  const changeRemoteStackTarget = useCallback((entityId: string, target: number) => {
    const before = gameRef.current;
    const entity = before.entities.find((candidate) => candidate.id === entityId && candidate.buildingId);
    if (!entity || !Number.isSafeInteger(target) || target < 1) {
      setNotice("堆叠数量必须是正安全整数");
      playTone("alert");
      return;
    }
    if (target > entity.machineCount) {
      const check = getBuildingStackAdditionCheck(entity.machineCount, target - entity.machineCount, getBuilding(entity.buildingId!).name);
      if (!check.ok) {
        setNotice(check.label);
        playTone("alert");
        return;
      }
    }
    const next = setRemoteBuildingStackTarget(before, entityId, target);
    if (next === before && target !== entity.machineCount) {
      setNotice(target > entity.machineCount ? "扩建失败：施工托盘库存不足或建筑不可编辑" : "减堆失败：返还数量超出安全范围或建筑不可编辑");
      playTone("alert");
      return;
    }
    if (next !== before) commitGame(() => next);
    setNotice(`${getBuilding(entity.buildingId!).name}堆叠已调整为 ×${target.toLocaleString("zh-CN")}`);
  }, [commitGame, playTone]);

  const copyEntitiesAsBlueprint = (entityIds: readonly string[]) => {
    const eligibleIds = getBlueprintEligibleEntityIds(gameRef.current, [...entityIds]);
    if (eligibleIds.length === 0) {
      setNotice("选区中没有可复制的设备");
      return;
    }
    const before = gameRef.current;
    const blueprintId = `blueprint_${gameRef.current.nextId}`;
    const next = createBlueprint(before, eligibleIds);
    if (next === before) {
      setNotice("蓝图未创建：建筑或采矿设备堆叠必须是 1～100,000,000 的安全整数；历史超限建筑仍会保留");
      playTone("alert");
      return;
    }
    commitGame(() => next);
    setBlueprintPlacementId(blueprintId);
    setPlacement(null);
    setSelectionMode(false);
    setDeleteMode(false);
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
    setDeleteMode(false);
    setRegionMode(false);
    setSelectedEntityIds([]);
    setNotice("点击画布确定蓝图部署位置");
  };

  const handleQuickCraftConstruction = (buildingId: ConstructionId, batches = 1) => {
    const before = gameRef.current;
    const plan = getConstructionQuickCraftPlan(before, buildingId, batches);
    const after = craftConstructionWithUpstream(before, buildingId, batches);
    if (after === before) {
      setNotice(plan.blocker
        ? `制造暂停：${ITEMS[plan.blocker.itemId].name}预计 ${plan.blocker.expected}，超过安全上限 ${plan.blocker.limit}`
        : "制造失败：材料或科技不足");
      if (before.settings.autoShortageNavigation) handleMissingConstructionCraft(buildingId);
      playTone("alert");
      return;
    }
    commitGame((current) => craftConstructionWithUpstream(current, buildingId, batches));
    recordBasicOnboardingEvent("construction-crafted");
    const consumed = plan.consumedItems.map((item) => `${ITEMS[item.itemId].name}×${item.amount}`);
    const consumedLabel = consumed.length > 3 ? `${consumed.slice(0, 3).join("、")}等${consumed.length}种材料` : consumed.join("、");
    setNotice(`${getConstructionDefinition(buildingId)?.name ?? "建筑"}已制造 ×${plan.outputAmount}（${plan.batches} 批）${consumedLabel ? ` · 已消耗${consumedLabel}` : ""}`);
    spawnInteractionBurst(pointerRef.current.x, pointerRef.current.y, consumedLabel ? `已消耗 ${consumedLabel}` : "制造完成", "positive");
    playTone("confirm");
  };

  const handleQuickCraftFleet = (recipeId: RecipeId, batches = 1) => {
    const before = gameRef.current;
    const plan = getRecursiveHandcraftPlan(before, recipeId, batches);
    const after = handcraftRecipeWithUpstream(before, recipeId, batches);
    if (after === before) {
      const blocker = plan.blocker;
      const blockerLabel = blocker?.reason === "technology"
        ? `缺少科技：${blocker.technologyId ? getTechnology(blocker.technologyId)?.name ?? blocker.technologyId : "未解锁"}`
        : blocker?.reason === "capacity"
          ? `${ITEMS[blocker.itemId].name}缓存已满（${blocker.current}/${blocker.limit}）`
          : blocker ? `缺少${ITEMS[blocker.itemId].name} ${Math.max(0, blocker.required - blocker.current)}` : "材料或科技不足";
      setNotice(`制造失败：${blockerLabel}`);
      if (before.settings.autoShortageNavigation && blocker?.itemId) openRecipeFocus(blocker.itemId);
      playTone("alert");
      return;
    }
    commitGame((current) => handcraftRecipeWithUpstream(current, recipeId, batches));
    const produced = plan.outputAmount;
    const recursiveLabel = plan.decisions.length > 1 ? ` · 递归加工 ${plan.decisions.length - 1} 段` : "";
    setNotice(`${RECIPES[recipeId]?.name ?? "物品"}已制造 ×${produced}（${plan.batches} 批）${recursiveLabel}`);
    spawnInteractionBurst(pointerRef.current.x, pointerRef.current.y, `制造 ×${produced}`, "positive");
    playTone("confirm");
  };

  const handleRemoveSprayCoater = async (entityId: string) => {
    const refund = getSprayCoaterRemovalRefund(gameRef.current, entityId);
    const confirmation = isEnglish
      ? `Remove the spray module? The module and ${refund?.proliferatorItems ?? 0} remaining proliferator item(s) will be returned.`
      : `确认拆卸喷涂模块？将返还喷涂模块 ×${refund?.sprayCoaters ?? 1}${refund?.proliferatorItemId && refund.proliferatorItems > 0 ? `、${ITEMS[refund.proliferatorItemId].name} ×${refund.proliferatorItems}` : ""}。`;
    if (!refund || !await gameDialog.confirm(confirmation, { confirmLabel: isEnglish ? "Remove" : "确认拆卸" })) return;
    commitGame((current) => removeSprayCoater(current, entityId));
    setNotice(`喷涂模块已拆卸并返还${refund.proliferatorItems > 0 ? ` · 未消耗增产剂 ×${refund.proliferatorItems}` : ""}`);
    playTone("remove");
  };

  const handleMissingConstructionCraft = (buildingId: ConstructionId) => {
    setFabricatorFocusItemId(null);
    setCampaignFocusItemId(null);
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
      if (result.status === "raw-shortage") {
        setCampaignFocusItemId(result.itemId);
        openCommandWorkspace("recipes");
        if (nextMobileShell) mobileNavigation.openWorkspace("recipes");
        setMobilePanel(null);
      }
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
                  : dysonPlannerOpen ? "dyson"
                  : null;

  useEffect(() => {
    if (game.timeWarp.enabled && !pureIdleActiveRef.current) {
      pureIdleActiveRef.current = true;
      setPureIdleActive(true);
      setPureIdleStartedAt((current) => current ?? Date.now());
    } else if (!game.timeWarp.enabled && pureIdleActiveRef.current) {
      pureIdleActiveRef.current = false;
      setPureIdleActive(false);
      setPureIdleStartedAt(null);
    }
  }, [game.timeWarp.enabled]);

  return (
    <ItemReferenceActionsProvider actions={itemReferenceActions}>
    <main
      className={`game-shell${placement || blueprintPlacementId ? " game-shell--placing" : ""}${selectionMode ? " game-shell--selecting" : ""}${deleteMode ? " game-shell--deleting" : ""}${regionMode ? " game-shell--regioning" : ""}${mobilePanel ? ` mobile-panel--${mobilePanel} mobile-panel-stage--${mobilePanelStage}` : ""}${leftSidebarCollapsed ? " sidebar-left-collapsed" : ""}${rightSidebarCollapsed ? " sidebar-right-collapsed" : ""}${pureIdleActive ? " game-shell--pure-idle" : ""}`}
      onContextMenuCapture={(event) => {
        const target = event.target as HTMLElement | null;
        if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
        event.preventDefault();
        if (blueprintPlacementId) {
          setBlueprintPlacementId(null);
          setNotice("已结束蓝图连续放置");
        }
      }}
      data-reduced-motion={game.settings.reducedMotion ? "true" : "false"}
      data-performance-mode={performanceVisualMode ? "true" : "false"}
      data-performance-auto={automaticPerformanceMode ? "true" : "false"}
      data-mobile-performance={mobilePerformanceMode ? "true" : "false"}
      data-simulation-paused={game.paused ? "true" : "false"}
      data-simulation-worker={simulationWorkerActive ? "active" : "fallback"}
      data-production-refresh={productionRefreshPreference}
      data-production-refresh-ms={productionRefreshIntervalMs}
      data-difficulty={game.settings.difficulty}
      data-zoom-lod={viewportZoom < 0.55 ? "compact" : viewportZoom < 0.86 ? "medium" : "full"}
      data-large-factory={largeFactoryMode ? "true" : "false"}
      data-endgame-extreme={endgameExtremeMode ? "true" : "false"}
      data-canvas-extreme-visuals={extremeVisualsActive ? "true" : "false"}
      data-canvas-node-lod={nodeLodFeatureActive ? "true" : "false"}
      data-canvas-viewport-culling={viewportCullingFeatureActive ? "true" : "false"}
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
      data-mobile-panel-dragging={mobilePanelSwipe.dragging ? "true" : "false"}
      data-minimap-open={!minimapCollapsed ? "true" : "false"}
      style={mobilePanelSwipe.dragging ? { "--mobile-panel-drag": `${mobilePanelSwipe.offset}px` } as CSSProperties : undefined}
    >
      <HeaderControls
        game={observedGame}
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
        onOpenDysonPlanner={() => {
          if (dysonPlannerOpen) closeAllWorkspaces();
          else openCommandWorkspace("dyson");
          setNotice(null);
        }}
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
        game={observedGame}
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
          onDropCargo: handleStowCargo,
          onDiscardTrayItems: (requests) => commitGame((current) => discardPlanetTrayItems(current, current.activePlanetId, requests)),
          onSetTrayItemLimit: (value) => commitGame((current) => setPlanetTrayItemLimit(current, current.activePlanetId, value)),
          onFocusSelection: () => {
            if (selectedEntityIds.length > 0) focusEntityIds(selectedEntityIds);
            else if (selectedBeltId) focusBeltNetwork(selectedBeltId);
          },
          onAddEntity: quickAddEntity,
          onRemoveEntity: handleRemoveEntity,
          onUpgradeEntity: (entityId) => {
            commitGame((current) => upgradeEntity(current, entityId));
            setNotice("设备升级完成");
            playTone("upgrade");
          },
          onUpgradeInterstellarStation: handleUpgradeInterstellarStation,
          onQuantumAttachment: (entityId) => {
            const status = getQuantumAttachmentStatus(gameRef.current, entityId);
            if (!status || status.blocker) {
              setNotice(status?.mode === "transitioning" ? "量子网络仍在等待传统航线尾货完成" : "请先将星际物流站升级到 Mk.II");
              playTone("alert");
              return;
            }
            commitGame((current) => attachInterstellarStationToQuantumNetwork(current, entityId));
            setNotice("已提交量子网络接入，仅等待旧星际航线和五秒边界；本地运输机继续运行");
            playTone("confirm");
          },
          onOrbitalCollectorQuantumMode: (entityId, enabled) => {
            const before = gameRef.current;
            const next = setOrbitalCollectorQuantumMode(before, entityId, enabled);
            if (next === before) {
              setNotice("量子采集模式未切换，请检查科技、锁定状态或交接进度");
              playTone("alert");
              return;
            }
            commitGame(() => next);
            setNotice(`已提交轨道采集器${enabled ? "接入" : "关闭"}量子采集网络`);
            playTone("confirm");
          },
          onUpgradeBelt: (beltId) => {
            commitGame((current) => upgradeBelt(current, beltId));
            setNotice("运输线升级完成");
            playTone("upgrade");
          },
          onBeltLaneCountChange: updateBeltLaneCount,
          onEntityLockChange: (entityId, locked) => {
            commitGame((current) => setEntitiesInteractionLocked(current, [entityId], locked));
            setNotice(locked ? "建筑已锁定" : "建筑已解锁");
          },
          onRemoveSprayCoater: handleRemoveSprayCoater,
          onOpenResourceSettings: () => openMobileOperations("settings"),
          onMaterialDeliverySlotChange: updateMaterialDeliverySlot,
          onEjectorOrbitChange: (entityId, orbitId) => {
            commitGame((current) => setEjectorTargetOrbit(current, entityId, orbitId));
            setNotice("太阳帆目标轨道已更新");
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
        connectionLabel={connectionHint?.label ?? (connectionDraft ? `${connectionDraft.itemId ? ITEMS[connectionDraft.itemId].name : "任意物资"}${connectionDraft.handleType === "source" ? "输出" : "输入"}：请选择匹配端口` : null)}
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
        canLock={selectedEntities.some((entity) => !entity.interactionLocked)}
        canUnlock={selectedEntities.some((entity) => entity.interactionLocked)}
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
        onLock={() => {
          const ids = selectedEntities.filter((entity) => !entity.interactionLocked).map((entity) => entity.id);
          commitGame((current) => setEntitiesInteractionLocked(current, ids, true));
          setNotice(`已锁定 ${ids.length} 个建筑`);
        }}
        onUnlock={() => {
          const ids = selectedEntities.filter((entity) => entity.interactionLocked).map((entity) => entity.id);
          commitGame((current) => setEntitiesInteractionLocked(current, ids, false));
          setNotice(`已解锁 ${ids.length} 个建筑`);
        }}
        onRemove={async () => {
          await confirmRemoveSelection();
        }}
        onClear={() => { setSelectedEntityIds([]); setSelectedBeltIds([]); setSelectedBeltId(null); }}
      /> : null}
      <div className="game-workspace">
        <ResourceRail
          game={observedGame}
          onOpenCampaign={openCampaign}
          onOpenDysonPlanner={() => {
            if (dysonPlannerOpen) closeAllWorkspaces();
            else openCommandWorkspace("dyson");
          }}
          onPickTray={(itemId) => setGame((current) => pickFromTray(current, itemId))}
          onDropCargo={handleStowCargo}
          onSetTrayItemLimit={(value) => setGame((current) => setPlanetTrayItemLimit(current, current.activePlanetId, value))}
          onDiscardTrayItems={(requests) => commitGame((current) => discardPlanetTrayItems(current, current.activePlanetId, requests))}
          onDropDraggedItem={handleDraggedItemToTray}
        />
        <button className={`sidebar-edge-toggle sidebar-edge-toggle--left${leftSidebarCollapsed ? " is-collapsed" : ""}`} type="button" onClick={() => setLeftSidebarCollapsed((collapsed) => !collapsed)} title={leftSidebarCollapsed ? "边缘按钮：展开左侧物资面板" : "边缘按钮：收起左侧物资面板"} aria-label={leftSidebarCollapsed ? "边缘按钮：展开左侧物资面板" : "边缘按钮：收起左侧物资面板"}>{leftSidebarCollapsed ? <ChevronRight size={15} /> : <ChevronLeft size={15} />}</button>
        <section
            className="factory-canvas"
            data-batch-renderer={canvasBatchRendererEnabled ? "true" : "false"}
            data-minimap-throttled={minimapThrottleFeatureActive && !minimapCanvasFailed ? "true" : "false"}
            aria-label="生产网络画布"
            ref={factoryCanvasRef}
            onPointerDownCapture={(event) => {
              longPressBindings.onPointerDownCapture?.(event);
              if (beginCanvasMultiTouch(event)) return;
              beginPlacementPointerMotion(event);
              onRegionPointerDown(event);
            }}
            onPointerMoveCapture={(event) => {
              if (moveCanvasMultiTouch(event)) return;
              movePlacementPointerMotion(event);
              longPressBindings.onPointerMoveCapture?.(event);
              onRegionPointerMove(event);
            }}
            onPointerUpCapture={(event) => {
              longPressBindings.onPointerUpCapture?.(event);
              stopCanvasPointerMotion();
              if (endCanvasMultiTouch(event)) return;
              finishRegionPointer(event);
            }}
            onPointerCancelCapture={(event) => {
              if (syntheticTouchCancelRef.current) return;
              longPressBindings.onPointerCancelCapture?.(event);
              stopCanvasPointerMotion();
              if (endCanvasMultiTouch(event)) return;
              finishRegionPointer(event, true);
            }}
            onLostPointerCaptureCapture={() => stopCanvasPointerMotion()}
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
            onNodesChange={handleNodesChange}
            onSelectionChange={onSelectionChange}
            onConnect={onConnect}
            onConnectStart={onConnectStart}
            onConnectEnd={onConnectEnd}
            onClickConnectStart={onClickConnectStart}
            onClickConnectEnd={onClickConnectEnd}
            isValidConnection={isValidConnection}
            onNodeClick={onNodeClick}
            onNodeDoubleClick={onNodeDoubleClick}
            onNodeDragStart={() => {
              if (blockCanvasTouchRef.current) return;
              nodeDragActiveRef.current = true;
              dragAlignmentSpatialIndexRef.current = alignmentSpatialIndexRef.current ?? alignmentSpatialIndex;
            }}
            onNodeDrag={onNodeDrag}
            onNodeDragStop={(_event, node, draggedNodes) => {
              nodeDragActiveRef.current = false;
              dragAlignmentSpatialIndexRef.current = null;
              setCanvasGeometryRevision((revision) => revision + 1);
              setAlignmentGuides({ x: null, y: null });
              if (blockCanvasTouchRef.current) {
                restoreCanvasEntityPositions();
                return;
              }
              const moved = draggedNodes.length > 0 ? draggedNodes : [node];
              const positions = moved.map((candidate) => ({ id: candidate.id, position: snapFlowPosition(candidate.position) }));
              commitGame((current) => moveEntities(current, positions));
              window.requestAnimationFrame(() => {
                connectionHandleSpatialIndexRef.current = buildConnectionHandleSpatialIndex(viewportRef.current);
              });
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
            onEdgeMouseEnter={(_event, edge) => setHoveredBeltId(edge.id)}
            onEdgeMouseLeave={(_event, edge) => setHoveredBeltId((current) => current === edge.id ? null : current)}
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
              if (connectionHandleSpatialIndexRef.current) connectionHandleSpatialIndexRef.current.viewport = viewport;
              canvasBeltLayerRef.current?.setViewport(viewport);
              if (blueprintPlacementId) setPendingBlueprintViewport(viewport);
              const currentLod = getCanvasLod(viewportZoom);
              const nextLod = getCanvasLod(viewport.zoom);
              canvasPinchLodRef.current = nextLod;
              if (currentLod !== nextLod) setViewportZoom(viewport.zoom);
            }}
            onMoveEnd={(_event, viewport) => {
              viewportRef.current = viewport;
              if (connectionHandleSpatialIndexRef.current) connectionHandleSpatialIndexRef.current.viewport = viewport;
              canvasPinchLodRef.current = getCanvasLod(viewport.zoom);
              setViewportZoom(viewport.zoom);
              setPendingBlueprintViewport(viewport);
              setMinimapViewport(viewport);
              persistPlanetViewport(gameRef.current.activePlanetId, viewport);
            }}
            panOnScroll
            panOnDrag={regionMode ? false : coarsePointer ? true : selectionMode ? [1, 2] : [0, 1, 2]}
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
            onlyRenderVisibleElements={viewportCullingFeatureActive || shouldVirtualizeCanvas(activePlanetEntityCount, activePlanetBelts.length)}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1.1} color={resolvedTheme === "light" ? "#b7c8bf" : "#3c4743"} />
            {canvasBatchRendererEnabled ? <CanvasBeltLayer
              ref={canvasBeltLayerRef}
              belts={activePlanetBelts}
              nodes={canvasLineNodeGeometry}
              routeCenters={edgeRouteCenters}
              planetId={canvasGame.activePlanetId}
              viewport={pendingBlueprintViewport}
              width={canvasViewportSize.width}
              height={canvasViewportSize.height}
              selectedBeltIds={selectedBeltIdSet}
              detailedBeltIds={detailedCanvasBeltIds}
              onUnavailable={handleCanvasBatchUnavailable}
            /> : null}
            <ViewportPortal>
              <PendingBlueprintLayer
                game={observedGame}
                planetId={canvasGame.activePlanetId}
                viewport={pendingBlueprintViewport}
                canvasSize={canvasViewportSize}
              />
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
            {!minimapCollapsed ? minimapThrottleFeatureActive && !minimapCanvasFailed ? <CanvasMiniMap
              nodes={canvasTopology.entities}
              viewport={minimapViewport}
              canvasWidth={canvasViewportSize.width}
              canvasHeight={canvasViewportSize.height}
              lightTheme={resolvedTheme === "light"}
              onCenter={centerCanvasFromMinimap}
              onZoom={zoomCanvasFromMinimap}
              onUnavailable={handleMinimapCanvasUnavailable}
            /> : <MiniMap
              pannable
              zoomable
              nodeColor={(node) => node.type === "vein" ? ITEMS[(node.data as FactoryNodeData).entity.resourceId!].color : node.type === "power" ? "#e1b452" : node.type === "station" ? "#d8794d" : node.type === "storage" ? "#8aa69d" : node.type === "splitter" ? "#d2aa5b" : "#61a9a4"}
              maskColor={resolvedTheme === "light" ? "rgba(218, 229, 223, 0.76)" : "rgba(8, 11, 10, 0.76)"}
            /> : null}
            <Controls position="bottom-left" showInteractive={false} />
          </ReactFlow>
          <button className={`canvas-minimap-toggle nodrag nopan${minimapCollapsed ? " canvas-minimap-toggle--collapsed" : ""}`} type="button" onClick={() => setMinimapCollapsed((collapsed) => !collapsed)} title={minimapCollapsed ? "展开小地图" : "折叠小地图"} aria-label={minimapCollapsed ? "展开小地图" : "折叠小地图"} aria-expanded={!minimapCollapsed}>
            {minimapCollapsed ? <MapIcon size={16} /> : <PanelRightClose size={16} />}
          </button>
          <PlanetNavigator game={observedGame} onPlanetChange={onPlanetChange} />
          <CanvasSelectionTools
            selectionMode={selectionMode}
            regionMode={regionMode}
            lineFindMode={lineFindMode}
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
            onToggleLineFindMode={() => {
              setLineFindMode((enabled) => !enabled);
              if (!lineFindMode) setNotice("寻线模式已开启：选中建筑后显示上下游线路");
              else setNotice("寻线模式已关闭");
            }}
            onModeChange={(enabled) => {
              setSelectionMode(enabled);
              setDeleteMode(false);
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
              setDeleteMode(false);
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
              setDeleteMode(false);
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
              setDeleteMode(false);
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
            canLock={selectedEntities.some((entity) => !entity.interactionLocked)}
            canUnlock={selectedEntities.some((entity) => entity.interactionLocked)}
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
            onLock={() => {
              const ids = selectedEntities.filter((entity) => !entity.interactionLocked).map((entity) => entity.id);
              commitGame((current) => setEntitiesInteractionLocked(current, ids, true));
              setNotice(`已锁定 ${ids.length} 个建筑`);
            }}
            onUnlock={() => {
              const ids = selectedEntities.filter((entity) => entity.interactionLocked).map((entity) => entity.id);
              commitGame((current) => setEntitiesInteractionLocked(current, ids, false));
              setNotice(`已解锁 ${ids.length} 个建筑`);
            }}
            onRemove={() => void confirmRemoveSelection()}
            onClear={() => { setSelectedEntityIds([]); setSelectedBeltIds([]); setSelectedBeltId(null); }}
            onDone={() => {
              setSelectionMode(false);
              setDeleteMode(false);
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
          {productionLineFocus?.planetId === game.activePlanetId ? (
            <div className="production-line-focus-indicator nodrag nopan">
              <span>物品产线定位</span>
              <strong>{ITEMS[productionLineFocus.itemId].name}</strong>
              <em>{productionLineFocus.producerEntityIds.length} 个生产节点 · {productionLineFocus.relatedBeltIds.length} 条上游线路</em>
              <div>
                <button type="button" disabled={productionLineFocus.producerEntityIds.length < 2} onClick={() => cycleProductionLineTarget(-1)} title="上一个生产节点" aria-label="上一个生产节点"><ChevronLeft size={15} /></button>
                <b>{productionLineFocus.activeIndex + 1}/{productionLineFocus.producerEntityIds.length}</b>
                <button type="button" disabled={productionLineFocus.producerEntityIds.length < 2} onClick={() => cycleProductionLineTarget(1)} title="下一个生产节点" aria-label="下一个生产节点"><ChevronRight size={15} /></button>
                <button type="button" onClick={() => focusEntityIds(productionLineFocus.producerEntityIds)} title="显示全部生产节点" aria-label="显示全部生产节点"><Focus size={15} /></button>
                <button type="button" onClick={() => setProductionLineFocus(null)} title="清除产线高亮" aria-label="清除产线高亮"><X size={15} /></button>
              </div>
            </div>
          ) : null}
          <div className="canvas-status">
            <span className={game.paused ? "paused" : "running"}>{game.paused ? "模拟暂停" : "实时运行"}</span>
            <strong>{getPlanetDisplayName(game, game.activePlanetId)} · {getPlanet(game.activePlanetId).code}工厂区</strong>
          </div>
          <RecipeFocusPanel
            game={observedGame}
            onClear={() => onRecipeFocusChange(null)}
            onModeChange={(mode) => commitGame((current) => setRecipeFocusMode(current, mode))}
            onOpen={openRecipeFocus}
            onPositionChange={(position) => commitGame((current) => setRecipeFocusPosition(current, position))}
          />
        </section>
        <InspectorPanel
          game={observedGame}
          fabricatorFocusItemId={fabricatorFocusItemId}
          selectedEntities={selectedEntities}
          selectedEntity={selectedEntity}
          selectedBelt={selectedBelt}
          onEntityLockChange={(entityId, locked) => {
            commitGame((current) => setEntitiesInteractionLocked(current, [entityId], locked));
            setNotice(locked ? "建筑已锁定" : "建筑已解锁");
          }}
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
          onEjectorOrbitChange={(entityId, orbitId) => {
            commitGame((current) => setEjectorTargetOrbit(current, entityId, orbitId));
            setNotice("太阳帆目标轨道已更新");
          }}
          onFuelChange={onFuelChange}
          onEnergyModeChange={onEnergyModeChange}
          onPowerGridChange={onPowerGridChange}
          onPowerPriorityChange={onPowerPriorityChange}
          onGenerationPriorityChange={onGenerationPriorityChange}
          onStationModeChange={(entityId, mode) => commitGame((current) => setStationMode(current, entityId, mode))}
          onStationVesselAdjust={(entityId, delta) => commitGame((current) => adjustStationVessels(current, entityId, delta))}
          onStationDroneAdjust={(entityId, delta) => commitGame((current) => adjustStationDrones(current, entityId, delta))}
          onStationFleetTarget={(entityId, kind, target) => {
            const result = setStationFleetTarget(gameRef.current, entityId, kind, target);
            if (result.state !== gameRef.current) commitGame(() => result.state);
            const label = kind === "drone" ? "物流运输机" : "物流运输船";
            const unit = kind === "drone" ? "架" : "艘";
            setNotice(result.reason === "busy-vehicles"
              ? `${label}目标不能低于执行中数量 ${result.busy}，请等待返航后再卸载`
              : result.reason === "portable-stock"
                ? `${label}已调整为 ${result.final}/${result.capacity} ${unit} · 随身库存不足，仍缺 ${result.shortfall}`
                : result.reason === "invalid-target" || result.reason === "invalid-station"
                  ? `${label}数量调整失败`
                  : `${label}已调整为 ${result.final}/${result.capacity} ${unit}${result.loaded > 0 ? ` · 装入 ${result.loaded}` : result.unloaded > 0 ? ` · 返还 ${result.unloaded}` : ""}`);
          }}
          onStationFleetFill={(entityId, kind) => {
            const result = fillStationFleet(gameRef.current, entityId, kind);
            if (result.state !== gameRef.current) commitGame(() => result.state);
            const label = kind === "drone" ? "物流运输机" : "物流运输船";
            setNotice(result.loaded > 0
              ? `已装入 ${result.loaded} ${kind === "drone" ? "架" : "艘"}${label}${result.shortfall > 0 ? ` · 随身库存不足，仍缺 ${result.shortfall}` : " · 泊位已补满"}`
              : result.shortfall > 0 ? `随身载具栏没有可用${label} · 仍缺 ${result.shortfall}` : `${label}泊位已满`);
          }}
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
          onMaterialDeliverySlotChange={updateMaterialDeliverySlot}
          onGalacticExporterPausedChange={(entityId, paused) => commitGame((current) => setGalacticMaterialExporterPaused(current, entityId, paused))}
          onBlackHolePausedChange={(entityId, paused, confirmActivation) => commitGame((current) => setBlackHolePaused(current, entityId, paused, confirmActivation))}
          onTimeWarpControllerChange={(entityId) => commitGame((current) => setTimeWarpController(current, entityId))}
          onTimeWarpEnabledChange={handleTimeWarpEnabledChange}
          onTimeWarpRequestedMultiplierChange={(multiplier) => commitGame((current) => setTimeWarpRequestedMultiplier(current, multiplier))}
          onOpenTutorial={(sectionId) => { setTutorialSectionId(sectionId); setTutorialOpen(true); }}
          galacticActivityStatus={galacticActivityStatus}
          onSplitterModeChange={(entityId, mode) => commitGame((current) => setSplitterMode(current, entityId, mode))}
          onBeltPriorityChange={(beltId, priority) => commitGame((current) => setBeltPriority(current, beltId, priority))}
          onBeltLaneCountChange={updateBeltLaneCount}
          onBeltStackSizeChange={(beltId, stackSize: CargoStackSize) => commitGame((current) => setBeltStackSize(current, beltId, stackSize))}
          onBeltMonitorChange={(beltId, enabled) => commitGame((current) => setBeltMonitorEnabled(current, beltId, enabled))}
          onBeltRouteModeChange={(beltId, routeMode: BeltRouteMode) => commitGame((current) => setBeltRouteMode(current, beltId, routeMode))}
          onBeltRouteOffsetChange={(beltId, routeOffsetY) => commitGame((current) => setBeltRouteOffsetY(current, beltId, routeOffsetY))}
          onApplyBeltConfigurationToNetwork={(beltId) => {
            const result = applyBeltConfigurationToNetworkResult(gameRef.current, beltId);
            if (result.error) {
              setNotice(`同步失败：${result.error}`);
              playTone("alert");
              return;
            }
            if (result.state !== gameRef.current) commitGame(() => result.state);
            setNotice(result.applied > 0 ? `当前线路设置已同步到整条连续网络 · ${result.applied} 条` : "连续网络设置已经一致");
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
            const result = applyBeltConfigurationToBelts(gameRef.current, copiedBeltConfigurationId, [beltId]);
            if (result.error) {
              setNotice(`线路设置应用失败：${result.error}`);
              playTone("alert");
              return;
            }
            if (result.state !== gameRef.current) commitGame(() => result.state);
            setNotice(result.applied > 0 ? "线路设置已应用（含并联数量）" : "线路设置已经一致");
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
          onUpgradeInterstellarStation={handleUpgradeInterstellarStation}
          onQuantumAttachment={(entityId) => {
            const status = getQuantumAttachmentStatus(gameRef.current, entityId);
            if (!status || status.blocker) {
              setNotice(status?.mode === "transitioning" ? "量子网络仍在等待传统航线尾货完成" : status?.mode === "quantum" ? "该物流站已经接入量子网络" : "请先将星际物流站升级到 Mk.II");
              playTone("alert");
              return;
            }
            commitGame((current) => attachInterstellarStationToQuantumNetwork(current, entityId));
            setNotice("已提交量子网络接入，旧星际航线将在五秒边界安全交接；本地运输机继续运行");
            playTone("confirm");
          }}
          onOrbitalCollectorQuantumMode={(entityId, enabled) => {
            const before = gameRef.current;
            const next = setOrbitalCollectorQuantumMode(before, entityId, enabled);
            if (next === before) {
              setNotice("量子采集模式未切换，请检查科技、锁定状态或交接进度");
              playTone("alert");
              return;
            }
            commitGame(() => next);
            setNotice(`已提交轨道采集器${enabled ? "接入" : "关闭"}量子采集网络`);
            playTone("confirm");
          }}
          onUpgradeBelt={(beltId) => {
            commitGame((current) => upgradeBelt(current, beltId));
            setNotice("运输线升级完成");
            playTone("upgrade");
          }}
          onInstallSprayCoater={(entityId) => {
            const check = getSprayCoaterInstallCheck(gameRef.current, entityId);
            if (!check.ready) {
              setNotice(`喷涂机安装失败：${check.reason}`);
              playTone("alert");
              return;
            }
            commitGame((current) => installSprayCoater(current, entityId));
            setNotice("喷涂模块安装完成，可接入增产剂并选择生产模式");
            playTone("confirm");
          }}
          onOpenResourceSettings={() => openMobileOperations("settings")}
          onRemoveSprayCoater={handleRemoveSprayCoater}
          onProliferatorConfiguration={(entityId, tier: ProliferatorTier, mode: ProliferatorMode) => {
            commitGame((current) => setProliferatorConfiguration(current, entityId, tier, mode));
            const modeName = mode === "extra" ? "额外产出" : mode === "speed" ? "生产加速" : "正常生产";
            setNotice(`喷涂配置已切换：Mk.${tier === 3 ? "III" : tier === 2 ? "II" : "I"} · ${modeName}`);
          }}
          onBatchRecipeChange={(entityIds, recipeId) => {
            commitGame((current) => setEntitiesRecipe(current, entityIds, recipeId));
            setNotice(`已为 ${entityIds.length} 个设备切换生产配方`);
          }}
          onBatchEjectorOrbitChange={(entityIds, orbitId) => {
            commitGame((current) => setEjectorTargetOrbitForEntities(current, entityIds, orbitId));
            setNotice(`已为 ${entityIds.length} 台弹射器同步太阳帆目标轨道`);
          }}
          onBatchInstallSprayCoater={(entityIds) => {
            commitGame((current) => installSprayCoaters(current, entityIds));
            setNotice("已为选区安装可用喷涂模块");
          }}
          onBatchProliferatorConfiguration={(entityIds, tier, mode) => {
            commitGame((current) => setEntitiesProliferatorConfiguration(current, entityIds, tier, mode));
            setNotice(`已同步 ${entityIds.length} 个设备的增产配置`);
          }}
          onCraft={handleQuickCraftConstruction}
          onCraftItem={handleQuickCraftFleet}
          onQueueCraftItem={(recipeId, batches) => setGame((current) => queueHandcraftRecipe(current, recipeId, batches))}
          onCancelCraftQueue={(entryId) => setGame((current) => cancelHandcraftQueueEntry(current, entryId))}
          onRemoveEntity={handleRemoveEntity}
          onRemoveBelt={(beltId) => {
            commitGame((current) => removeBelt(current, beltId));
            setSelectedBeltId(null);
            playTone("remove");
          }}
        />
        <button className={`sidebar-edge-toggle sidebar-edge-toggle--right${rightSidebarCollapsed ? " is-collapsed" : ""}`} type="button" onClick={() => setRightSidebarCollapsed((collapsed) => !collapsed)} title={rightSidebarCollapsed ? "边缘按钮：展开右侧检查器面板" : "边缘按钮：收起右侧检查器面板"} aria-label={rightSidebarCollapsed ? "边缘按钮：展开右侧检查器面板" : "边缘按钮：收起右侧检查器面板"}>{rightSidebarCollapsed ? <ChevronLeft size={15} /> : <ChevronRight size={15} />}</button>
      </div>
      <ConstructionDock
        game={observedGame}
        deleteMode={deleteMode}
        placement={placement}
        beltTier={dockBeltTier}
        beltTierMode={beltTierMode}
        placementCount={placementCount}
        onPlacementChange={(buildingId) => {
          setPlacement(buildingId);
          setBlueprintPlacementId(null);
          setSelectionMode(false);
          setDeleteMode(false);
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
        onStowCargo={handleStowCargo}
        onMissingCraftNavigate={handleMissingConstructionCraft}
        onDeleteModeChange={(enabled) => {
          setDeleteMode(enabled);
          setSelectionMode(enabled);
          setRegionMode(false);
          setRegionDraft(null);
          setPlacement(null);
          setBlueprintPlacementId(null);
          setSelectedEntityIds([]);
          setSelectedBeltIds([]);
          setSelectedBeltId(null);
          if (nextMobileShell) setMobileCanvasMode(enabled ? "select" : "browse");
          setNotice(enabled ? "回收模式：单击、Shift 多选、框选或手机逐点选择建筑，再点击回收确认" : "已退出建筑回收模式");
        }}
      />
      <OnboardingCoach game={observedGame} onAction={runOnboardingAction} compact={nextMobileShell} />
      <BlueprintWorkspace
        open={blueprintsOpen}
        game={observedGame}
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
        onFundQueue={(entryId, scope) => commitGame((current) => fundConstructionQueueEntry(current, entryId, scope))}
        onFundAllQueues={() => commitGame((current) => fundAllConstructionQueueEntries(current))}
        onCancelQueue={(entryId) => commitGame((current) => cancelConstructionQueueEntry(current, entryId))}
        onExport={downloadBlueprint}
        onImport={importBlueprint}
      />
      <CommandPalette
        open={commandPaletteOpen}
        game={observedGame}
        onClose={closeCommandPalette}
        onOpenWorkspace={openCommandWorkspace}
        onFocusRecipe={openRecipeFocus}
        onFocusEntity={focusPlacedEntity}
        onAutoLayout={() => autoLayoutEntities()}
        onPauseToggle={togglePause}
        onTogglePerformance={() => updateSettings({ performanceMode: !gameRef.current.settings.performanceMode })}
        onToggleReducedMotion={() => updateSettings({ reducedMotion: !gameRef.current.settings.reducedMotion })}
      />
      <Suspense fallback={<WorkspaceLoading />}>
        {constructionCenterOpen ? (
          <ConstructionCenterWorkspace
            open
            game={observedGame}
            onClose={() => nextMobileShell ? mobileNavigation.requestBack() : setConstructionCenterOpen(false)}
            onEnabledChange={(enabled) => commitGame((current) => setConstructionAutomationEnabled(current, enabled))}
            onTargetChange={(constructionId: ConstructionAutomationTargetId, target: number) => commitGame((current) => setConstructionAutomationTarget(current, constructionId, target))}
          />
        ) : null}
        {galaxyOpen ? (
          <GalaxyWorkspace
            open
            accountState={accountState}
            game={observedGame}
            focusTab={galaxyFocusTab}
            onClose={() => nextMobileShell ? mobileNavigation.requestBack() : setGalaxyOpen(false)}
            onUpdateProfile={updateGalaxyProfile}
            onUpdateCloudBinding={updateGalaxyCloudBinding}
            onCreateAccount={createGalaxyAccount}
            onSwitchAccount={switchGalaxyAccount}
            onRestoreCloudSave={restoreCloudSave}
          />
        ) : null}
        {technologyOpen ? (
          <TechnologyWorkspace
            open
            game={observedGame}
            mobile={nextMobileShell}
            mobileSubview={mobileWorkspaceSubview}
            onMobileOpenDetail={mobileNavigation.openWorkspaceSubview}
            focusTechId={campaignFocusTechId}
            onClose={() => nextMobileShell ? mobileNavigation.requestBack() : setTechnologyOpen(false)}
            onSelect={(techId) => {
              const before = gameRef.current;
              const next = selectTechnology(before, techId);
              if (next === before) return;
              trackAnalyticsEvent("research_queue");
              commitGame(() => next);
              recordBasicOnboardingEvent("research-selected");
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
          game={observedGame}
          mobile={nextMobileShell}
          galacticActivityStatus={galacticActivityStatus}
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
          onGalacticExporterPausedChange={(entityId, paused) => commitGame((current) => setGalacticMaterialExporterPaused(current, entityId, paused))}
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
          onBulkBeltConfiguration={(templateBeltId, targetNetworkIds) => {
            const targetIds = [...new Set(targetNetworkIds.flatMap((originId) => getBeltNetworkIds(gameRef.current, originId)))];
            const result = applyBeltConfigurationToBelts(gameRef.current, templateBeltId, targetIds);
            if (result.error) {
              setNotice(`批量同步失败：${result.error}`);
              playTone("alert");
              return result;
            }
            if (result.state !== gameRef.current) commitGame(() => result.state);
            setNotice(result.applied > 0
              ? `模板设置同步完成：成功 ${result.applied} 条，跳过 ${result.skipped} 条，失败 ${result.failed} 条`
              : `所选线路设置已经一致 · 跳过 ${result.skipped} 条`);
            return result;
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
        {recipesOpen ? <RecipeWorkspace open game={observedGame} mobile={nextMobileShell} mobileSubview={mobileWorkspaceSubview} onMobileOpenDetail={mobileNavigation.openWorkspaceSubview} onMobileReplaceDetail={(subview) => mobileNavigation.replaceWorkspaceSubview(subview)} focusItemId={campaignFocusItemId} onClose={() => nextMobileShell ? mobileNavigation.requestBack() : setRecipesOpen(false)} onFocus={onRecipeFocusChange} onLocateProductionLine={locateProductionLine} /> : null}
        {campaignOpen ? (
          <CampaignWorkspace
            open
            game={observedGame}
            onClose={() => nextMobileShell ? mobileNavigation.requestBack() : setCampaignOpen(false)}
            onNavigate={navigateFromCampaign}
            onSelectTask={onSelectCampaignTask}
          />
        ) : null}
        {starMapOpen ? (
          <StarMapWorkspace
            open
            game={observedGame}
            mobile={nextMobileShell}
            mobileSubview={mobileWorkspaceSubview}
            onMobileOpenDetail={mobileNavigation.openWorkspaceSubview}
            onClose={() => nextMobileShell ? mobileNavigation.requestBack() : setStarMapOpen(false)}
            onExplore={onExploreSystem}
            onColonize={onColonizePlanet}
            onTravel={(planetId) => { onPlanetChange(planetId); setStarMapOpen(false); }}
            onRoleChange={(planetId: PlanetId, role: PlanetIndustryRole) => commitGame((current) => setPlanetIndustryRole(current, planetId, role))}
            onPlanetMetadataChange={(planetId, metadata) => commitGame((current) => setPlanetDisplayMetadata(current, planetId, metadata))}
            onSystemNameChange={(systemId, customName) => commitGame((current) => setStarSystemDisplayName(current, systemId, customName))}
            onUpgradeAllStations={handleUpgradeAllInterstellarStations}
            onAttachAllQuantumStations={handleAttachAllQuantumStations}
            onCollectorQuantumModeChange={handleAllOrbitalCollectorsQuantumMode}
            onQuantumItemCapacityChange={(itemId, value) => commitGame((current) => setQuantumLogisticsItemCapacity(current, itemId, value))}
            onStationPriorityChange={(entityId: string, slotIndex: number, priority: LogisticsPriority) => commitGame((current) => setStationSlotPriority(current, entityId, slotIndex, priority))}
            onStationMinimumLoadChange={(entityId: string, slotIndex: number, minimumLoad: StationMinimumLoad) => commitGame((current) => setStationSlotMinimumLoad(current, entityId, slotIndex, minimumLoad))}
            onStationLimitsChange={(entityId: string, slotIndex: number, minStock: number, maxStock: number) => commitGame((current) => setStationSlotLimits(current, entityId, slotIndex, minStock, maxStock))}
            onFocusStation={focusStellarStation}
          />
        ) : null}
        {systemSpaceStationOpen && systemSpaceStationId ? <SystemSpaceStationWorkspace
          open
          game={observedGame}
          systemId={systemSpaceStationId}
          mobile={nextMobileShell}
          onClose={() => { setSystemSpaceStationOpen(false); setSystemSpaceStationId(null); }}
          onStartConstruction={(systemId) => commitGame((current) => startSystemSpaceStationConstruction(current, systemId))}
          onDeliverMaterial={(systemId, planetId, itemId, amount) => commitGame((current) => deliverSystemSpaceStationMaterial(current, systemId, planetId, itemId, amount))}
          onUpgradeStation={handleUpgradeInterstellarStation}
          onUpgradeAllStations={handleUpgradeAllInterstellarStations}
          onRequestMode={(entityId, mode) => commitGame((current) => requestStationOperationMode(current, entityId, mode))}
          onSetOutput={(entityId, portIndex, itemId) => commitGame((current) => setElevatorOutputItem(current, entityId, portIndex, itemId, 2))}
          onSetModuleCount={(systemId, module, count) => commitGame((current) => setSystemSpaceStationModuleCount(current, systemId, module, count))}
        /> : null}
        {dysonPlannerOpen ? (
          <DysonPlannerWorkspace
            open
            game={observedGame}
            onSave={() => persistPrimarySave()}
            onClose={() => nextMobileShell ? mobileNavigation.requestBack() : setDysonPlannerOpen(false)}
            onAddLayer={(systemId) => setGame((current) => addDysonLayer(current, systemId))}
            onAddStandardLayer={(systemId) => setGame((current) => createStandardDysonLayer(current, systemId))}
            onSelectLayer={(systemId, layerId) => setGame((current) => setActiveDysonLayer(current, systemId, layerId))}
            onOrbitChange={(systemId, layerId, orbit) => setGame((current) => setDysonLayerOrbit(current, systemId, layerId, orbit))}
            onRemoveLayer={(systemId, layerId) => setGame((current) => removeDysonLayer(current, systemId, layerId))}
            onPasteLayer={(systemId, template) => {
              const result = pasteDysonLayerTemplate(gameRef.current, systemId, template);
              if (result.error) {
                setNotice(result.error);
                playTone("alert");
                return;
              }
              commitGame(() => result.state);
              setNotice("壳层设计已作为新副本添加，施工进度从 0 开始");
              playTone("confirm");
            }}
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
            game={observedGame}
            alerts={alerts}
            slots={saveSlots}
            snapshots={saveSnapshots}
            importPreview={importPreview}
            modValidation={modValidation}
            contentPackRegistry={contentPackRegistry}
            performanceReport={performanceReport}
            performanceMonitor={performanceMonitor.snapshot}
            productionRefreshPreference={productionRefreshPreference}
            productionRefreshIntervalMs={productionRefreshIntervalMs}
            endgameExtremeMode={endgameExtremeMode}
            canvasPerformanceFeatures={canvasPerformanceFeatures}
            lineFindMode={lineFindMode}
            showRunLog={showRunLog}
            onEndgameExtremeModeChange={toggleEndgameExtremeMode}
            onCanvasPerformanceFeatureChange={updateCanvasPerformanceFeature}
            onLineFindModeChange={setLineFindMode}
            onRunLogChange={updateRunLogPreference}
            onProductionRefreshPreferenceChange={setProductionRefreshPreference}
            onStartPerformanceMonitor={performanceMonitor.start}
            onStopPerformanceMonitor={performanceMonitor.stop}
            onClearPerformanceMonitor={performanceMonitor.clear}
            onExportPerformanceMonitor={() => void performanceMonitor.exportAnonymous()}
            onClose={() => nextMobileShell ? mobileNavigation.requestBack() : setOperationsOpen(false)}
            onTabChange={setOperationsTab}
            onAlertSelect={selectAlert}
            onSettingsChange={updateSettings}
            onManualSave={manualSave}
            onExport={downloadSave}
            onImport={importSave}
            onConfirmImport={confirmImport}
            onConfirmImportRescue={confirmImportRescue}
            importRescueArmed={importRescueArmed}
            onCancelImport={cancelImport}
            onSaveSlot={saveToSlot}
            onLoadSlot={loadFromSlot}
            onDeleteSlot={deleteSlot}
            onCreateSnapshot={createSnapshot}
            onLoadSnapshot={loadSnapshot}
            onDeleteSnapshot={deleteSnapshot}
            onDeleteSnapshots={deleteSnapshots}
            onRunBenchmark={runBenchmark}
            onOpenReleaseNotes={onOpenReleaseNotes}
            onOpenTutorial={(sectionId) => { setTutorialSectionId(sectionId); setTutorialOpen(true); }}
            onValidateMod={validateMod}
            onExportModTemplate={downloadModTemplate}
            onRegisterContentPack={registerValidatedContentPack}
            onSetContentPackEnabled={toggleRegisteredContentPack}
            onRemoveContentPack={removeRegisteredContentPack}
            logisticsActions={{
              onSlotItemChange: (entityId, slotIndex, itemId) => void changeRemoteStationSlotItem(entityId, slotIndex, itemId),
              onSlotModeChange: (entityId, slotIndex, scope, mode) => commitGame((current) => setStationSlotMode(current, entityId, slotIndex, scope, mode)),
              onSlotMinimumLoadChange: (entityId, slotIndex, minimumLoad) => commitGame((current) => setStationSlotMinimumLoad(current, entityId, slotIndex, minimumLoad)),
              onSlotLimitsChange: (entityId, slotIndex, minStock, maxStock) => commitGame((current) => setStationSlotLimits(current, entityId, slotIndex, minStock, maxStock)),
              onSlotPriorityChange: (entityId, slotIndex, priority) => commitGame((current) => setStationSlotPriority(current, entityId, slotIndex, priority)),
              onFleetTargetChange: changeRemoteFleetTarget,
              onWarperAdjust: (entityId, delta) => commitGame((current) => adjustRemoteStationWarpers(current, entityId, delta)),
              onWarpEnabledChange: (entityId, enabled) => commitGame((current) => setStationWarpEnabled(current, entityId, enabled)),
              onWarperAutoRefillChange: (entityId, enabled) => commitGame((current) => setStationWarperAutoRefill(current, entityId, enabled)),
              onWarperTargetChange: (entityId, target) => commitGame((current) => setStationWarperTarget(current, entityId, target)),
              onStackTargetChange: changeRemoteStackTarget,
              onQuantumAttach: (entityId) => {
                const before = gameRef.current;
                const next = attachInterstellarStationToQuantumNetwork(before, entityId);
                if (next !== before) {
                  commitGame(() => next);
                  setNotice("量子网络接入已开始，旧星际航线会先安全完成");
                } else setNotice(getQuantumAttachmentStatus(before, entityId)?.blocker === "not-upgraded" ? "需要先升级到 Mk.II" : "当前物流塔无法接入量子网络");
              },
              onCollectorQuantumModeChange: (entityId, enabled) => commitGame((current) => setOrbitalCollectorQuantumMode(current, entityId, enabled)),
              onCollectorItemChange: (entityId, itemId) => void changeRemoteCollectorItem(entityId, itemId),
            }}
          />
        ) : null}
        {offlineReport ? <OfflineReportWorkspace report={offlineReport} onClose={closeOfflineReport} /> : null}
        {tutorialOpen ? <TutorialWorkspace open mobile={nextMobileShell} initialSectionId={tutorialSectionId} onClose={() => { setTutorialOpen(false); setTutorialSectionId(undefined); }} /> : null}
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
            <button type="button" disabled={getBlueprintEligibleEntityIds(game, [mobileActionEntity.id]).length === 0} onClick={() => { copyEntitiesAsBlueprint([mobileActionEntity.id]); setMobileActionEntityId(null); }}><Copy size={17} /><span>{mobileActionEntity.kind === "vein" ? "收录采矿布局" : "复制设备"}</span></button>
            <button type="button" onClick={() => { focusPlacedEntity(mobileActionEntity.id); setMobileActionEntityId(null); }}><Focus size={17} /><span>定位检查</span></button>
            <button type="button" disabled={!canUpgradeEntities(game, [mobileActionEntity.id])} onClick={() => { commitGame((current) => upgradeEntities(current, [mobileActionEntity.id])); setMobileActionEntityId(null); playTone("upgrade"); }}><ArrowUp size={17} /><span>升级设备</span></button>
            <button className="danger" type="button" disabled={mobileActionEntity.kind === "vein" && mobileActionEntity.minerCount < 1} onClick={() => { handleRemoveEntity(mobileActionEntity.id); setSelectedEntityIds([]); setMobileActionEntityId(null); }}><Trash2 size={17} /><span>{mobileActionEntity.kind === "vein" ? `回收采集设备 ×${mobileActionEntity.minerCount}` : "回收设备"}</span></button>
          </div>
        </section>
      </div> : null}
      {planetTransition ? (
        <div className="planet-transition" key={planetTransition.id} aria-live="polite">
          <span>{getPlanetDisplayName(game, planetTransition.from)}</span>
          <i><b /></i>
          <strong>{getPlanetDisplayName(game, planetTransition.to)}</strong>
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
      <CanvasInteractionOverlay
        active={pointerOverlayActive}
        placement={placement}
        placementCount={placementCount}
        cargo={game.cargo}
        blueprint={activeBlueprint}
        ctrlHeld={ctrlHeld}
        clickConnectionPreview={clickConnectionPreview}
        clickConnectionTone={clickConnectionTone}
        clickConnectionSnapPoint={clickConnectionSnapPoint}
        connectionHint={connectionHint}
        onPointerPosition={handleCanvasPointerPosition}
      />
      {interactionBursts.map((burst) => <div className={`interaction-burst interaction-burst--${burst.tone}`} style={{ left: burst.x, top: burst.y }} key={burst.id}><i>{burst.tone === "warning" ? <Sparkles size={13} /> : <Check size={13} />}</i><span>{burst.label}</span></div>)}
      {saveFailure ? <aside className="save-emergency-warning" role="alert" aria-live="assertive">
        <AlertTriangle size={20} />
        <span><strong>{saveFailure.code === "quota" ? "本地存储空间不足，当前进度尚未保存。请立即导出存档。" : saveFailure.message}</strong><small>自动保存会继续重试，导出文件不会删除或覆盖现有存档。</small></span>
        <button type="button" onClick={downloadSave}><Download size={15} /><span>立即导出当前进度</span></button>
      </aside> : null}
      {showRunLog && eventHistory.length > 0 ? <aside className="interaction-event-feed" role="log" aria-label="运行事件" aria-live="polite">
        <header><Activity size={13} /><span>运行记录</span><button type="button" onClick={() => setEventHistory([])} title="清空运行记录" aria-label="清空运行记录"><X size={12} /></button></header>
        <div>{eventHistory.map((event) => <p key={event.id}>{event.text}</p>)}</div>
      </aside> : null}
      {notice && (showRunLog || isPersistentNotice(notice)) ? <div className="game-notice" role="status">{notice}</div> : null}
      {pureIdleActive ? <TimeWarpIdleOverlay game={observedGame} startedAt={pureIdleStartedAt} saveFailure={saveFailure} workerActive={simulationWorkerActive} onStop={stopPureIdle} /> : null}
    </main>
    </ItemReferenceActionsProvider>
  );
}
