import type { DesktopNativeCoreRecipeWorkspaceProjectionResult } from "../desktop";
import { ITEMS, PLANET_LIST, TECHNOLOGIES, getPlanet } from "./content";
import { getDysonEngineeringSnapshot } from "./engine";
import { getPlanetIndustrialProfile, getPlanetSolarPowerMultiplier, getStarSystemProfile } from "./galaxy";
import { getProductionLineLocations } from "./productionLocator";
import type {
  GameState,
  ItemAmount,
  ItemId,
  PlanetId,
  PlanetOceanType,
  RecipeFocusMode,
  StarSystemId,
  TechId,
} from "./types";

export const RECIPE_WORKSPACE_PROJECTION_LIMITS = Object.freeze({
  itemRows: 256,
  completedTechRows: 512,
  planetRows: 64,
  profileItemRows: 256,
  colonyCostRows: 32,
  locationRows: 4096,
} as const);

export interface RecipeWorkspaceSelector {
  readonly itemIds: readonly ItemId[];
  readonly selectedItemId: ItemId;
}

export interface RecipeWorkspacePlanetProfileReadModel {
  readonly planetId: PlanetId;
  readonly climateName: string;
  readonly starTypeName: string;
  readonly oceanType: PlanetOceanType;
  readonly windMultiplier: number;
  readonly solarPowerMultiplier: number;
  readonly geothermalMultiplier: number;
  readonly miningMultiplier: number;
  readonly reserveScale: number;
  readonly tidalLocked: boolean;
  readonly resourceIds: readonly ItemId[];
  readonly orbitalYields: Readonly<Partial<Record<ItemId, number>>>;
  readonly colonyCost: readonly ItemAmount[];
}

export interface RecipeWorkspaceDysonReadModel {
  readonly systemId: StarSystemId;
  readonly orbitCount: number;
  readonly orbitSails: number;
  readonly completedStructurePoints: number;
  readonly projectedGenerationKw: number;
  readonly sailLaunchesPerMinute: number;
  readonly rocketLaunchesPerMinute: number;
  readonly receiverLoadKw: number;
  readonly criticalPhotonPerMinute: number;
  readonly shellSails: number;
  readonly shellCapacity: number;
}

export interface RecipeWorkspaceReadModel {
  readonly schema: "recipe-workspace-read-model-v1";
  readonly source: "web-game-state" | "native-core";
  readonly revision: number | null;
  readonly registryFingerprint: string;
  readonly selector: RecipeWorkspaceSelector;
  readonly catalogItemCount: number;
  readonly activePlanetId: PlanetId;
  readonly recipeFocus: { readonly itemId: ItemId | null; readonly mode: RecipeFocusMode };
  readonly completedTechIds: readonly TechId[];
  readonly beltCount: number;
  readonly metrics: {
    readonly generationKw: number;
    readonly demandKw: number;
    readonly powerFactor: number;
  };
  readonly planetProfiles: Readonly<Record<PlanetId, RecipeWorkspacePlanetProfileReadModel>>;
  readonly dyson: RecipeWorkspaceDysonReadModel;
  readonly itemStocks: Readonly<Partial<Record<ItemId, number>>>;
  readonly selectedItem: {
    readonly itemId: ItemId;
    readonly stock: number;
    readonly productionLocations: readonly { readonly planetId: PlanetId; readonly producerCount: number }[];
  };
}

export interface NativeRecipeWorkspaceFrame {
  readonly sessionId: string;
  readonly revision: number;
  readonly projection: DesktopNativeCoreRecipeWorkspaceProjectionResult;
}

export interface NativeRecipeWorkspaceBinding {
  readonly enabled: boolean;
  readonly sessionId: string | null;
  readonly expectedRevision: number;
  readonly expectedRegistryFingerprint: string;
  readonly selector: RecipeWorkspaceSelector;
}

const OCEAN_TYPES = new Set<PlanetOceanType>(["water", "sulfuric-acid", "lava", "ice", "none"]);

export function recipeWorkspaceSelectorsEqual(
  left: RecipeWorkspaceSelector,
  right: RecipeWorkspaceSelector,
): boolean {
  return left.selectedItemId === right.selectedItemId && left.itemIds.length === right.itemIds.length &&
    left.itemIds.every((itemId, index) => itemId === right.itemIds[index]);
}

export function validRecipeWorkspaceSelector(value: RecipeWorkspaceSelector): boolean {
  return Boolean(ITEMS[value.selectedItemId]) && value.itemIds.length <= RECIPE_WORKSPACE_PROJECTION_LIMITS.itemRows &&
    new Set(value.itemIds).size === value.itemIds.length && value.itemIds.every((itemId) => Boolean(ITEMS[itemId]));
}

function webPlanetProfiles(game: GameState): Record<PlanetId, RecipeWorkspacePlanetProfileReadModel> {
  return Object.fromEntries(PLANET_LIST.map((planet) => {
    const profile = getPlanetIndustrialProfile(game, planet.id);
    const star = getStarSystemProfile(game, planet.systemId);
    return [planet.id, Object.freeze({
      planetId: planet.id,
      climateName: profile.climateName,
      starTypeName: star.starTypeName,
      oceanType: profile.oceanType,
      windMultiplier: profile.windMultiplier,
      solarPowerMultiplier: getPlanetSolarPowerMultiplier(game, planet.id),
      geothermalMultiplier: profile.geothermalMultiplier,
      miningMultiplier: profile.miningMultiplier,
      reserveScale: profile.reserveScale,
      tidalLocked: profile.tidalLocked,
      resourceIds: Object.freeze([...profile.resourceIds]),
      orbitalYields: Object.freeze({ ...profile.orbitalYields }),
      colonyCost: Object.freeze(profile.colonyCost.map((cost) => Object.freeze({ ...cost }))),
    })];
  })) as Record<PlanetId, RecipeWorkspacePlanetProfileReadModel>;
}

export function createWebRecipeWorkspaceReadModel(
  game: GameState,
  selector: RecipeWorkspaceSelector,
  registryFingerprint: string,
): RecipeWorkspaceReadModel | null {
  if (!validRecipeWorkspaceSelector(selector)) return null;
  const trackedItems = new Set<ItemId>([...selector.itemIds, selector.selectedItemId]);
  const stocks = Object.fromEntries([...trackedItems].map((itemId) => [itemId, 0])) as Partial<Record<ItemId, number>>;
  for (const entity of game.entities) {
    for (const inventory of [entity.inputs, entity.outputs]) {
      for (const [itemId, amount] of Object.entries(inventory) as Array<[ItemId, number]>) {
        if (trackedItems.has(itemId)) stocks[itemId] = (stocks[itemId] ?? 0) + amount;
      }
    }
  }
  for (const planet of PLANET_LIST) {
    const tray = planet.id === game.activePlanetId ? game.tray : game.planetTrays[planet.id];
    for (const itemId of trackedItems) stocks[itemId] = (stocks[itemId] ?? 0) + (tray?.[itemId] ?? 0);
  }
  if (game.cargo?.itemId && trackedItems.has(game.cargo.itemId)) {
    stocks[game.cargo.itemId] = (stocks[game.cargo.itemId] ?? 0) + game.cargo.amount;
  }
  const productionLocations = getProductionLineLocations(game, selector.selectedItemId).map((location) => Object.freeze({
    planetId: location.planetId,
    producerCount: location.producerEntityIds.length,
  }));
  const systemId = getPlanet(game.activePlanetId).systemId;
  const dyson = getDysonEngineeringSnapshot(game, systemId);
  return Object.freeze({
    schema: "recipe-workspace-read-model-v1",
    source: "web-game-state",
    revision: null,
    registryFingerprint,
    selector: Object.freeze({ itemIds: Object.freeze([...selector.itemIds]), selectedItemId: selector.selectedItemId }),
    catalogItemCount: Object.keys(ITEMS).length,
    activePlanetId: game.activePlanetId,
    recipeFocus: Object.freeze({ itemId: game.recipeFocus.itemId, mode: game.recipeFocus.mode }),
    completedTechIds: Object.freeze([...game.research.completedTechIds]),
    beltCount: game.belts.length,
    metrics: Object.freeze({
      generationKw: game.metrics.generationKw,
      demandKw: game.metrics.demandKw,
      powerFactor: game.metrics.powerFactor,
    }),
    planetProfiles: Object.freeze(webPlanetProfiles(game)),
    dyson: Object.freeze({
      systemId,
      orbitCount: dyson.orbitCount,
      orbitSails: dyson.orbitSails,
      completedStructurePoints: dyson.completedStructurePoints,
      projectedGenerationKw: dyson.projectedGenerationKw,
      sailLaunchesPerMinute: dyson.sailLaunchesPerMinute,
      rocketLaunchesPerMinute: dyson.rocketLaunchesPerMinute,
      receiverLoadKw: dyson.receiverLoadKw,
      criticalPhotonPerMinute: dyson.criticalPhotonPerMinute,
      shellSails: dyson.shellSails,
      shellCapacity: dyson.shellCapacity,
    }),
    itemStocks: Object.freeze(Object.fromEntries(selector.itemIds.map((itemId) => [itemId, Math.floor(stocks[itemId] ?? 0)]))),
    selectedItem: Object.freeze({
      itemId: selector.selectedItemId,
      stock: Math.floor(stocks[selector.selectedItemId] ?? 0),
      productionLocations: Object.freeze(productionLocations),
    }),
  });
}

function exactStringArrayEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function selectNativeRecipeWorkspaceReadModel(
  frame: NativeRecipeWorkspaceFrame | null,
  binding: NativeRecipeWorkspaceBinding,
): RecipeWorkspaceReadModel | null {
  if (!frame || !binding.enabled || !binding.sessionId || !validRecipeWorkspaceSelector(binding.selector) ||
      frame.sessionId !== binding.sessionId || frame.revision !== binding.expectedRevision ||
      frame.projection.revision !== binding.expectedRevision) return null;
  const projection = frame.projection;
  if (projection.schemaVersion !== 1 || projection.projectionType !== "recipe-workspace-v1" ||
      projection.registryFingerprint !== binding.expectedRegistryFingerprint || projection.truncated ||
      projection.limits.itemRows !== RECIPE_WORKSPACE_PROJECTION_LIMITS.itemRows ||
      projection.limits.completedTechRows !== RECIPE_WORKSPACE_PROJECTION_LIMITS.completedTechRows ||
      projection.limits.planetRows !== RECIPE_WORKSPACE_PROJECTION_LIMITS.planetRows ||
      projection.limits.profileItemRows !== RECIPE_WORKSPACE_PROJECTION_LIMITS.profileItemRows ||
      projection.limits.colonyCostRows !== RECIPE_WORKSPACE_PROJECTION_LIMITS.colonyCostRows ||
      projection.limits.locationRows !== RECIPE_WORKSPACE_PROJECTION_LIMITS.locationRows ||
      projection.counts.catalogItems !== Object.keys(ITEMS).length ||
      projection.counts.completedTechIds !== projection.live.completedTechIds.length ||
      projection.counts.planetProfiles !== PLANET_LIST.length ||
      projection.locationPage !== null || projection.request.location !== null ||
      projection.request.selectedItemId !== binding.selector.selectedItemId ||
      !exactStringArrayEqual(projection.request.itemIds, binding.selector.itemIds) ||
      projection.itemStocks.length !== binding.selector.itemIds.length ||
      projection.itemStocks.some((row, index) => row.itemId !== binding.selector.itemIds[index] || !ITEMS[row.itemId as ItemId]) ||
      projection.selectedItem.itemId !== binding.selector.selectedItemId ||
      (projection.live.recipeFocus.itemId !== null && !ITEMS[projection.live.recipeFocus.itemId as ItemId]) ||
      !PLANET_LIST.some((planet) => planet.id === projection.live.activePlanetId) ||
      projection.live.completedTechIds.some((techId) => !TECHNOLOGIES[techId as TechId]) ||
      new Set(projection.live.completedTechIds).size !== projection.live.completedTechIds.length) return null;

  const knownPlanets = new Set(PLANET_LIST.map((planet) => planet.id));
  const planetProfiles = {} as Record<PlanetId, RecipeWorkspacePlanetProfileReadModel>;
  for (const row of projection.live.planetProfiles) {
    if (!knownPlanets.has(row.planetId as PlanetId) || planetProfiles[row.planetId as PlanetId] ||
        !OCEAN_TYPES.has(row.oceanType as PlanetOceanType) || row.resourceIds.truncated ||
        row.orbitalYields.truncated || row.colonyCost.truncated ||
        row.resourceIds.rows.some((itemId) => !ITEMS[itemId as ItemId]) ||
        row.orbitalYields.rows.some((entry) => !ITEMS[entry.itemId as ItemId]) ||
        row.colonyCost.rows.some((entry) => !ITEMS[entry.itemId as ItemId])) return null;
    const planetId = row.planetId as PlanetId;
    planetProfiles[planetId] = Object.freeze({
      planetId,
      climateName: row.climateName,
      starTypeName: row.starTypeName,
      oceanType: row.oceanType as PlanetOceanType,
      windMultiplier: row.windMultiplier,
      solarPowerMultiplier: row.solarPowerMultiplier,
      geothermalMultiplier: row.geothermalMultiplier,
      miningMultiplier: row.miningMultiplier,
      reserveScale: row.reserveScale,
      tidalLocked: row.tidalLocked,
      resourceIds: Object.freeze([...row.resourceIds.rows] as ItemId[]),
      orbitalYields: Object.freeze(Object.fromEntries(row.orbitalYields.rows.map((entry) => [entry.itemId, entry.rate]))),
      colonyCost: Object.freeze(row.colonyCost.rows.map((entry) => Object.freeze({
        itemId: entry.itemId as ItemId,
        amount: entry.amount,
      }))),
    });
  }
  if (Object.keys(planetProfiles).length !== PLANET_LIST.length ||
      projection.selectedItem.productionLocations.some((location) => !knownPlanets.has(location.planetId as PlanetId))) {
    return null;
  }
  const systemIds = new Set(PLANET_LIST.map((planet) => planet.systemId));
  if (!systemIds.has(projection.live.dyson.systemId as StarSystemId)) return null;
  const itemStocks = Object.fromEntries(projection.itemStocks.map((row) => [row.itemId, row.amount]));
  return Object.freeze({
    schema: "recipe-workspace-read-model-v1",
    source: "native-core",
    revision: projection.revision,
    registryFingerprint: projection.registryFingerprint,
    selector: Object.freeze({
      itemIds: Object.freeze([...binding.selector.itemIds]),
      selectedItemId: binding.selector.selectedItemId,
    }),
    catalogItemCount: projection.counts.catalogItems,
    activePlanetId: projection.live.activePlanetId as PlanetId,
    recipeFocus: Object.freeze({
      itemId: projection.live.recipeFocus.itemId as ItemId | null,
      mode: projection.live.recipeFocus.mode,
    }),
    completedTechIds: Object.freeze([...projection.live.completedTechIds] as TechId[]),
    beltCount: projection.live.beltCount,
    metrics: Object.freeze({ ...projection.live.metrics }),
    planetProfiles: Object.freeze(planetProfiles),
    dyson: Object.freeze({ ...projection.live.dyson, systemId: projection.live.dyson.systemId as StarSystemId }),
    itemStocks: Object.freeze(itemStocks as Partial<Record<ItemId, number>>),
    selectedItem: Object.freeze({
      itemId: projection.selectedItem.itemId as ItemId,
      stock: projection.selectedItem.stock,
      productionLocations: Object.freeze(projection.selectedItem.productionLocations.map((location) => Object.freeze({
        planetId: location.planetId as PlanetId,
        producerCount: location.producerCount,
      }))),
    }),
  });
}
