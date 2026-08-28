/**
 * Bounded, renderer-facing factory read models.
 *
 * These contracts deliberately use opaque string identifiers. Declarative
 * content-pack IDs must cross the read boundary unchanged even when the
 * receiving UI has not materialized the matching catalog definition yet.
 * No type in this file embeds GameState, FactoryEntity, or BeltConnection.
 */

export const FACTORY_READ_MODEL_SCHEMA = "factory-read-model-v1" as const;

export const FACTORY_READ_MODEL_LIMITS = Object.freeze({
  planetRows: 64,
  selectedEntityRows: 64,
  selectedBeltRows: 64,
  itemRows: 32,
  constructionQueueRows: 64,
  constructionReservationRows: 32,
  constructionTargetRows: 128,
  constructionJobRows: 64,
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
  readonly entityCount: number;
  readonly beltCount: number;
  readonly activePlanetEntityCount: number;
  readonly activePlanetBeltCount: number;
  readonly constructionQueueCount: number;
}

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
  readonly selectedCount: number;
  readonly selectedBeltCount: number;
  readonly canLock: boolean;
  readonly canUnlock: boolean;
}

/**
 * Bounded live fields rendered by the compact mobile entity/belt inspector.
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

export interface ConstructionSummaryReadModel {
  readonly schema: typeof FACTORY_READ_MODEL_SCHEMA;
  readonly activePlanetId: string;
  readonly queue: BoundedReadModelRows<ConstructionQueueRowReadModel>;
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
