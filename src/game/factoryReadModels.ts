/**
 * Bounded, renderer-facing factory read models.
 *
 * These contracts deliberately use opaque string identifiers. Declarative
 * content-pack IDs must cross the read boundary unchanged even when the
 * receiving UI has not materialized the matching catalog definition yet.
 * No type in this file embeds GameState, FactoryEntity, or BeltConnection.
 */

export const FACTORY_READ_MODEL_SCHEMA = "factory-read-model-v1" as const;

/** Renderer-only provenance for a main-owned Rust projection. */
export interface NativeFactoryProjectionIdentity {
  readonly sessionId: string;
  readonly runId: string;
  readonly revision: number;
  readonly planetId: string;
}

export const FACTORY_READ_MODEL_LIMITS = Object.freeze({
  planetRows: 64,
  selectedEntityRows: 64,
  selectedBeltRows: 64,
  itemRows: 32,
  constructionQueueRows: 64,
  constructionReservationRows: 32,
  constructionTargetRows: 128,
  constructionJobRows: 64,
  constructionCenterRows: 64,
  constructionMaterialRows: 256,
  constructionQuantumBufferRows: 256,
  constructionDestroyedByproductRows: 256,
  constructionCostRows: 32,
  stationItemOptions: 128,
} as const);

export interface BoundedReadModelRows<Row> {
  readonly rows: readonly Row[];
  readonly totalCount: number;
  readonly truncated: boolean;
}

export interface ItemQuantityReadModel {
  readonly itemId: string;
  readonly amount: number;
}

export interface FactoryShellReadModel {
  readonly schema: typeof FACTORY_READ_MODEL_SCHEMA;
  readonly source: "web-game-state" | "native-core";
  readonly stateVersion: number;
  readonly mode: "normal" | "speedrun";
  readonly activePlanetId: string;
  readonly paused: boolean;
  readonly elapsedSeconds: number;
  readonly simulationSpeed: number;
  /**
   * Small authoritative control snapshot. Optional only for rollback shells;
   * current Web and native v1 producers always provide it.
   */
  readonly timeWarp?: FactoryTimeWarpReadModel;
  readonly entityCount: number;
  readonly beltCount: number;
  readonly activePlanetEntityCount: number;
  readonly activePlanetBeltCount: number;
  readonly constructionQueueCount: number;
}

export interface FactoryTimeWarpReadModel {
  readonly controllerEntityId: string | null;
  readonly enabled: boolean;
  readonly requestedMultiplier: number;
  readonly effectiveMultiplier: number;
  readonly requiredPowerKw: number;
  readonly allocatedPowerKw: number;
}

export type FactoryNodePresentationCoverage = "complete" | "conservative";

export type FactoryNodePresentationStatusCode =
  | "running"
  | "idle"
  | "paused"
  | "missing-recipe"
  | "missing-research"
  | "missing-input"
  | "output-blocked"
  | "no-power"
  | "low-power"
  | "missing-fuel"
  | "resource-depleted"
  | "missing-proliferator"
  | "no-fuel-selected"
  | "grid-standby"
  | "missing-route"
  | "fleet-busy"
  | "missing-vessel"
  | "missing-drone"
  | "missing-warper"
  | "missing-hub"
  | "waiting-load"
  | "waiting-route"
  | "collecting"
  | "missing-dyson-swarm"
  | "missing-dyson-orbit"
  | "launch-paused"
  | "unconfigured";

export interface FactoryNodePresentationStatusReadModel {
  readonly code: FactoryNodePresentationStatusCode;
  readonly label: string;
  readonly tone: "running" | "warning" | "blocked" | "idle";
}

export interface FactoryNodeResourceReserveReadModel {
  readonly infinite: boolean;
  readonly exhausted: boolean;
  readonly remaining: number | null;
  readonly capacity: number | null;
  readonly remainingRatio: number;
  readonly remainingPercent: number;
}

/**
 * Projection-only semantic sidecar for one viewport entity. It is never mixed
 * into FactoryEntity and therefore cannot become a save or command oracle.
 * Unknown/MOD behavior is represented explicitly instead of being guessed by
 * the renderer from its deliberately hollow JavaScript shell.
 */
export type FactoryNodePresentationReadModel =
  | Readonly<{
      entityId: string;
      supported: false;
    }>
  | Readonly<{
      entityId: string;
      supported: true;
      coverage: FactoryNodePresentationCoverage;
      status: FactoryNodePresentationStatusReadModel;
      powerFactor: number;
      resourceReserve: FactoryNodeResourceReserveReadModel | null;
      outputCapacity: number;
      cycleRatePerSecond: number;
      acceptedInputItemIds: readonly string[];
      producedOutputItemIds: readonly string[];
      targetDysonOrbitLabel: string | null;
    }>;

/** Smallest visible factory status contract; it never owns a GameState. */
export interface FactoryRunStatusReadModel {
  readonly schema: typeof FACTORY_READ_MODEL_SCHEMA;
  readonly source: "web-game-state" | "native-core";
  readonly revision: number | null;
  readonly activePlanetId: string;
  readonly paused: boolean;
}

/** Visible, read-only selection state used by the desktop canvas toolbar. */
export interface FactorySelectionToolbarReadModel {
  readonly schema: typeof FACTORY_READ_MODEL_SCHEMA;
  readonly source: "web-game-state" | "native-core";
  readonly revision: number | null;
  readonly activePlanetId: string;
  readonly projectionIdentity: NativeFactoryProjectionIdentity | null;
  readonly selectedCount: number;
  readonly selectedBeltCount: number;
  readonly canLock: boolean;
  readonly canUnlock: boolean;
}

/**
 * Bounded live fields rendered by the mobile and desktop entity/belt inspectors.
 * Command eligibility and mutations deliberately remain outside this model.
 */
export interface FactoryInspectorSummaryReadModel {
  readonly schema: typeof FACTORY_READ_MODEL_SCHEMA;
  readonly source: "web-game-state" | "native-core";
  readonly revision: number | null;
  readonly activePlanetId: string;
  readonly entity: SelectedEntityReadModel | null;
  readonly belt: SelectedBeltReadModel | null;
}

/**
 * Complete bounded rows used to derive the desktop multi-selection summary.
 * This renderer-only wrapper reuses the existing atomic selection projection;
 * it does not add fields to the native IPC contract.
 */
export interface FactoryMultiSelectionSummaryReadModel {
  readonly schema: typeof FACTORY_READ_MODEL_SCHEMA;
  readonly source: "web-game-state" | "native-core";
  readonly revision: number | null;
  readonly activePlanetId: string;
  readonly projectionIdentity: NativeFactoryProjectionIdentity | null;
  readonly requestedEntityCount: number;
  readonly requestedBeltCount: number;
  readonly entityRows: BoundedReadModelRows<SelectedEntityReadModel>;
  readonly beltRows: BoundedReadModelRows<SelectedBeltReadModel>;
}

/** Bounded headline used by the visible blueprint construction workspace. */
export interface FactoryConstructionHeadlineReadModel {
  readonly schema: typeof FACTORY_READ_MODEL_SCHEMA;
  readonly source: "web-game-state" | "native-core";
  readonly revision: number | null;
  readonly activePlanetId: string;
  readonly activePlanetDisplayName: string;
  readonly constructionQueueCount: number;
}

export interface PlanetNavigationRowReadModel {
  readonly planetId: string;
  readonly systemId: string | null;
  readonly displayName: string;
  readonly code: string;
  readonly active: boolean;
  readonly discovered: boolean;
  readonly colonized: boolean;
  readonly role: string | null;
  readonly entityCount: number;
  readonly deviceCount: number;
  readonly beltCount: number;
  readonly constructionQueueCount: number;
  readonly powerFactor: number;
}

export interface PlanetNavigationReadModel {
  readonly schema: typeof FACTORY_READ_MODEL_SCHEMA;
  readonly activePlanetId: string;
  readonly planets: BoundedReadModelRows<PlanetNavigationRowReadModel>;
}

export type NativeStationModeReadModel = "supply" | "demand" | "storage";
export type NativeStationRoutePolicyReadModel = "direct" | "relay-preferred" | "relay-required";

export interface NativeStationItemOptionReadModel {
  readonly itemId: string;
  readonly name: string;
  readonly kind: "solid" | "fluid" | "matrix";
}

export interface NativeStationItemOptionsReadModel extends BoundedReadModelRows<NativeStationItemOptionReadModel> {
  readonly limit: typeof FACTORY_READ_MODEL_LIMITS.stationItemOptions;
}

export interface NativeStationSlotConfigurationReadModel {
  readonly slotIndex: number;
  readonly itemId: string | null;
  /** Inventory identity and direction remain read-only in the first station slice. */
  readonly localMode: NativeStationModeReadModel;
  readonly remoteMode: NativeStationModeReadModel;
  readonly minimumLoad: 0.1 | 0.25 | 0.5 | 1;
  readonly minStock: number;
  readonly maxStock: number;
  readonly priority: 0 | 1 | 2;
  /** Present only for an interstellar station. */
  readonly routePolicy?: NativeStationRoutePolicyReadModel;
  /** Present only for an interstellar station. */
  readonly warperBudget?: 1 | 2 | 3 | 4;
}

export interface NativeStationConfigurationReadModel {
  readonly schema: "station-configuration-v1";
  readonly registryFingerprint: "7df8cf3a";
  readonly stationType: "planetary" | "interstellar";
  /** Stable built-in options projected by Rust; the renderer never fills this from GameState. */
  readonly itemOptions: NativeStationItemOptionsReadModel;
  /** Fleet and installed warpers are intentionally display-only. */
  readonly stationDrones: number;
  readonly stationVessels: number | null;
  readonly stationWarpers: number | null;
  readonly slots: readonly NativeStationSlotConfigurationReadModel[];
  readonly spaceWarpUnlocked: boolean;
  readonly stationWarpEnabled: boolean | null;
  readonly stationWarperAutoRefill: boolean | null;
  readonly stationWarperTarget: number | null;
  readonly stationHubEnabled: boolean | null;
  readonly stationHubPriority: 0 | 1 | 2 | null;
}

export interface SelectedEntityReadModel {
  readonly entityId: string;
  readonly planetId: string;
  readonly kind: string;
  readonly position: Readonly<{ x: number; y: number }>;
  readonly interactionLocked: boolean;
  readonly buildingId: string | null;
  readonly resourceId: string | null;
  readonly recipeId: string | null;
  readonly storedItemId: string | null;
  readonly fuelItemId: string | null;
  readonly machineCount: number;
  readonly minerCount: number;
  readonly progress: number;
  readonly utilization: number;
  readonly productionRate: number;
  readonly powerFactor: number | null;
  readonly inputItems: BoundedReadModelRows<ItemQuantityReadModel>;
  readonly outputItems: BoundedReadModelRows<ItemQuantityReadModel>;
  /** Null for non-stations, MOD registries and stale cross-planet selections. */
  readonly stationConfiguration: NativeStationConfigurationReadModel | null;
}

export interface SelectedBeltReadModel {
  readonly beltId: string;
  readonly planetId: string;
  readonly sourceEntityId: string;
  readonly targetEntityId: string;
  readonly itemId: string;
  readonly lanes: number;
  readonly tier: number;
  readonly sorterTier: number;
  readonly stackSize: number | null;
  readonly priority: number;
  readonly progress: number;
  readonly lastFlow: number;
  readonly totalTransferred: number | null;
  readonly congestion: number | null;
}

export interface FactorySelectionReadModel {
  readonly schema: typeof FACTORY_READ_MODEL_SCHEMA;
  readonly activePlanetId: string;
  readonly requestedEntityCount: number;
  readonly requestedBeltCount: number;
  readonly entityRows: BoundedReadModelRows<SelectedEntityReadModel>;
  readonly beltRows: BoundedReadModelRows<SelectedBeltReadModel>;
}

export interface ConstructionReservationReadModel {
  readonly constructionId: string;
  readonly amount: number;
}

export interface ConstructionQueueRowReadModel {
  readonly queueId: string;
  readonly blueprintId: string;
  readonly blueprintVersionId: string | null;
  readonly blueprintRevision: number | null;
  readonly blueprintName: string;
  readonly planetId: string;
  readonly queuedAt: number;
  readonly status: "pending-materials" | "waiting-fleet";
  readonly rotation: number;
  readonly mirror: string;
  readonly placedEntityCount: number;
  readonly reservedConstruction: BoundedReadModelRows<ConstructionReservationReadModel>;
  readonly reservedFleet: BoundedReadModelRows<ItemQuantityReadModel>;
}

export interface ConstructionTargetReadModel {
  readonly targetId: string;
  readonly amount: number;
}

export interface ConstructionJobReadModel {
  readonly entityId: string;
  readonly constructionId: string;
  readonly stepIndex: number;
  readonly stepCount: number;
  readonly elapsedSeconds: number;
  readonly inventory: BoundedReadModelRows<ItemQuantityReadModel>;
}

export type NativeConstructionCenterCategoryReadModel = "power" | "production" | "logistics" | "dyson";
export type NativeConstructionCenterStatusReadModel = "game-paused" | "automation-paused" | "working" | "idle";

export interface NativeConstructionCenterNamedQuantityReadModel extends ItemQuantityReadModel {
  readonly name: string;
}

export interface NativeConstructionCenterQuantityRows<Row> extends BoundedReadModelRows<Row> {
  readonly totalAmount: number;
}

export interface NativeConstructionCenterTargetReadModel {
  readonly targetId: string;
  readonly name: string;
  readonly kind: "building" | "fleet";
  readonly category: NativeConstructionCenterCategoryReadModel;
  readonly target: number;
  readonly currentStock: number;
  readonly unlocked: boolean;
  readonly requiredTechId: string | null;
  readonly requiredTechName: string | null;
  readonly outputAmount: number;
  readonly costs: BoundedReadModelRows<NativeConstructionCenterNamedQuantityReadModel>;
}

export interface NativeConstructionCenterRowReadModel {
  readonly entityId: string;
  readonly planetId: string;
  readonly planetName: string;
  readonly machineCount: number;
  readonly status: NativeConstructionCenterStatusReadModel;
}

export interface NativeConstructionCenterJobReadModel {
  readonly entityId: string;
  readonly targetId: string;
  readonly targetName: string;
  readonly stepIndex: number;
  readonly stepCount: number;
  readonly elapsedSeconds: number;
  readonly inventory: NativeConstructionCenterQuantityRows<NativeConstructionCenterNamedQuantityReadModel>;
}

export interface NativeConstructionCenterQuantumBufferReadModel extends NativeConstructionCenterNamedQuantityReadModel {
  readonly entityId: string;
}

/**
 * Built-in-only, display-only construction-center projection emitted by Rust.
 * A null value is the required fail-closed representation for MOD/unknown
 * registries; the renderer never fills the directory from JS content tables.
 */
export interface NativeConstructionCenterWorkspaceReadModel {
  readonly schema: "construction-center-workspace-v1";
  readonly registryFingerprint: "7df8cf3a";
  readonly readOnly: true;
  readonly writeAvailable: boolean;
  readonly activePlanetId: string;
  readonly activePlanetName: string;
  readonly paused: boolean;
  readonly enabled: boolean;
  readonly quantumSourceEnabled: boolean;
  readonly quantumNetworkEnabled: boolean;
  readonly totalCrafted: number;
  readonly lastCraftedId: string | null;
  readonly lastCraftedName: string | null;
  readonly stockLimit: number;
  readonly cycleSeconds: number;
  readonly materialSeconds: number;
  readonly targets: BoundedReadModelRows<NativeConstructionCenterTargetReadModel>;
  readonly centers: BoundedReadModelRows<NativeConstructionCenterRowReadModel>;
  readonly jobs: BoundedReadModelRows<NativeConstructionCenterJobReadModel>;
  readonly materials: NativeConstructionCenterQuantityRows<NativeConstructionCenterNamedQuantityReadModel>;
  readonly quantumBuffer: NativeConstructionCenterQuantityRows<NativeConstructionCenterQuantumBufferReadModel>;
  readonly destroyedByproducts: NativeConstructionCenterQuantityRows<NativeConstructionCenterNamedQuantityReadModel>;
  readonly limits: Readonly<{
    targetRows: typeof FACTORY_READ_MODEL_LIMITS.constructionTargetRows;
    centerRows: typeof FACTORY_READ_MODEL_LIMITS.constructionCenterRows;
    jobRows: typeof FACTORY_READ_MODEL_LIMITS.constructionJobRows;
    materialRows: typeof FACTORY_READ_MODEL_LIMITS.constructionMaterialRows;
    quantumBufferRows: typeof FACTORY_READ_MODEL_LIMITS.constructionQuantumBufferRows;
    destroyedByproductRows: typeof FACTORY_READ_MODEL_LIMITS.constructionDestroyedByproductRows;
    costRowsPerTarget: typeof FACTORY_READ_MODEL_LIMITS.constructionCostRows;
    projectionBytes: 1048576;
  }>;
}

export interface ConstructionSummaryReadModel {
  readonly schema: typeof FACTORY_READ_MODEL_SCHEMA;
  readonly activePlanetId: string;
  readonly queue: BoundedReadModelRows<ConstructionQueueRowReadModel>;
  readonly nativeCenterWorkspace: NativeConstructionCenterWorkspaceReadModel | null;
  readonly automation: Readonly<{
    enabled: boolean;
    quantumSourceEnabled: boolean;
    totalCrafted: number;
    lastCraftedId: string | null;
    targets: BoundedReadModelRows<ConstructionTargetReadModel>;
    jobs: BoundedReadModelRows<ConstructionJobReadModel>;
    destroyedByproducts: BoundedReadModelRows<ItemQuantityReadModel>;
  }>;
}

/**
 * Renderer-only wrapper for construction workspaces. The native wire schema
 * remains `ConstructionSummaryReadModel`; source/revision are attached only
 * after the renderer proves a complete, same-revision semantic match.
 */
export interface FactoryConstructionWorkspaceReadModel extends ConstructionSummaryReadModel {
  readonly source: "web-game-state" | "native-core";
  readonly revision: number | null;
}

export interface FactoryViewportBoundsReadModel {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export interface FactoryViewportEntityReadModel {
  readonly id: string;
  readonly kind: "vein" | "machine" | "power" | "storage" | "splitter" | "station";
  readonly buildingId: string | null;
  readonly x: number;
  readonly y: number;
}

export interface FactoryViewportBeltReadModel {
  readonly id: string;
  readonly planetId: string;
  readonly source: string;
  readonly target: string;
  readonly itemId: string;
  readonly lanes: number;
  readonly tier: number;
  readonly stackSize: number;
  readonly priority: number;
  readonly targetPortIndex: number | null;
  readonly routeMode: "bezier" | "auto" | "upper" | "lower" | "manual";
  readonly routeOffsetY: number;
}

/**
 * Renderer-only, fully paged viewport topology. It is never a command model:
 * selection, dragging, connection and mutation eligibility remain GameState
 * responsibilities even when these read-only rows come from native-core.
 */
export interface FactoryViewportReadModel {
  readonly schema: "factory-viewport-read-model-v1";
  readonly source: "web-game-state" | "native-core";
  readonly revision: number | null;
  readonly planetId: string;
  readonly bounds: FactoryViewportBoundsReadModel;
  readonly pinnedEntityIds: readonly string[];
  readonly pinnedBeltIds: readonly string[];
  readonly planetTotals: Readonly<{ entities: number; belts: number }>;
  readonly viewportTotals: Readonly<{ entities: number; belts: number }>;
  readonly worldBounds: FactoryViewportBoundsReadModel;
  readonly entities: readonly FactoryViewportEntityReadModel[];
  readonly belts: readonly FactoryViewportBeltReadModel[];
  readonly broadQueryFallback: boolean;
}

export interface FactoryViewportReadModelRequest {
  readonly planetId: string;
  readonly bounds: FactoryViewportBoundsReadModel;
  readonly pinnedEntityIds: readonly string[];
  readonly pinnedBeltIds: readonly string[];
}

export interface FactoryReadModelBundle {
  readonly shell: FactoryShellReadModel;
  readonly planetNavigation: PlanetNavigationReadModel;
  readonly selection: FactorySelectionReadModel;
  readonly construction: ConstructionSummaryReadModel;
}

export interface FactoryReadModelRequest {
  readonly selectedEntityIds?: readonly string[];
  readonly selectedBeltIds?: readonly string[];
}
