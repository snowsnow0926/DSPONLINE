import { describe, expect, it, vi } from "vitest";
import type { DesktopNativeCoreRecipeWorkspaceProjectionResult } from "../desktop";
import { ITEMS, PLANET_LIST } from "./content";
import { createInitialState } from "./engine";
import {
  NativeRecipeWorkspaceStore,
  createNativePlayerAuthorityRecipeWorkspaceProjectionSource,
  selectNativeRecipeWorkspaceFrame,
} from "./nativeRecipeWorkspaceStore";
import {
  RECIPE_WORKSPACE_PROJECTION_LIMITS,
  createWebRecipeWorkspaceReadModel,
  selectNativeRecipeWorkspaceReadModel,
  type RecipeWorkspaceReadModel,
  type RecipeWorkspaceSelector,
} from "./recipeWorkspaceReadModel";
import type { ItemId } from "./types";

const FINGERPRINT = "builtin:recipe-test";

function selector(selectedItemId: ItemId = "iron_ingot"): RecipeWorkspaceSelector {
  return { itemIds: ["iron_ore", "iron_ingot"], selectedItemId };
}

function webModel(value = selector()): RecipeWorkspaceReadModel {
  const model = createWebRecipeWorkspaceReadModel(createInitialState(), value, FINGERPRINT);
  if (!model) throw new Error("web recipe fixture failed");
  return model;
}

function projection(
  value = selector(),
  revision = 7,
): DesktopNativeCoreRecipeWorkspaceProjectionResult {
  const model = webModel(value);
  return {
    schemaVersion: 1,
    projectionType: "recipe-workspace-v1",
    revision,
    registryFingerprint: FINGERPRINT,
    truncated: false,
    limits: { ...RECIPE_WORKSPACE_PROJECTION_LIMITS },
    counts: {
      catalogItems: Object.keys(ITEMS).length,
      completedTechIds: model.completedTechIds.length,
      planetProfiles: PLANET_LIST.length,
    },
    request: { itemIds: [...value.itemIds], selectedItemId: value.selectedItemId, location: null },
    live: {
      activePlanetId: model.activePlanetId,
      recipeFocus: { ...model.recipeFocus },
      completedTechIds: [...model.completedTechIds],
      beltCount: model.beltCount,
      metrics: { ...model.metrics },
      planetProfiles: PLANET_LIST.map((planet) => {
        const profile = model.planetProfiles[planet.id];
        return {
          planetId: planet.id,
          climateName: profile.climateName,
          starTypeName: profile.starTypeName,
          oceanType: profile.oceanType,
          windMultiplier: profile.windMultiplier,
          solarPowerMultiplier: profile.solarPowerMultiplier,
          geothermalMultiplier: profile.geothermalMultiplier,
          miningMultiplier: profile.miningMultiplier,
          reserveScale: profile.reserveScale,
          tidalLocked: profile.tidalLocked,
          resourceIds: { rows: [...profile.resourceIds], totalCount: profile.resourceIds.length, truncated: false },
          orbitalYields: {
            rows: Object.entries(profile.orbitalYields).map(([itemId, rate]) => ({ itemId, rate: rate ?? 0 })),
            totalCount: Object.keys(profile.orbitalYields).length,
            truncated: false,
          },
          colonyCost: { rows: profile.colonyCost.map((cost) => ({ ...cost })), totalCount: profile.colonyCost.length, truncated: false },
        };
      }),
      dyson: { ...model.dyson },
    },
    itemStocks: value.itemIds.map((itemId) => ({ itemId, amount: model.itemStocks[itemId] ?? 0 })),
    selectedItem: {
      itemId: value.selectedItemId,
      stock: model.selectedItem.stock,
      productionLocations: model.selectedItem.productionLocations.map((location) => ({ ...location })),
    },
    locationPage: null,
  };
}

describe("recipe workspace read model", () => {
  it("builds a bounded Web compatibility model without retaining entity or belt arrays", () => {
    const model = webModel();
    expect(model.source).toBe("web-game-state");
    expect(model.selector).toEqual(selector());
    expect(Object.hasOwn(model, "entities")).toBe(false);
    expect(Object.hasOwn(model, "belts")).toBe(false);
    expect(Object.keys(model.itemStocks)).toEqual(["iron_ore", "iron_ingot"]);
    expect(Object.keys(model.planetProfiles)).toHaveLength(PLANET_LIST.length);
  });

  it("accepts only a complete same-session, same-revision, same-catalog native frame", () => {
    const binding = {
      enabled: true,
      sessionId: "authority-1",
      runId: "run-1",
      expectedRevision: 7,
      expectedRegistryFingerprint: FINGERPRINT,
      selector: selector(),
    };
    const frame = {
      sessionId: "authority-1",
      runId: "run-1",
      revision: 7,
      registryFingerprint: FINGERPRINT,
      projection: projection(),
    };
    expect(selectNativeRecipeWorkspaceReadModel(frame, binding)?.source).toBe("native-core");
    expect(selectNativeRecipeWorkspaceReadModel({ ...frame, revision: 8 }, binding)).toBeNull();
    expect(selectNativeRecipeWorkspaceReadModel({
      ...frame,
      projection: { ...projection(), registryFingerprint: "builtin:other" },
    }, binding)).toBeNull();
    expect(selectNativeRecipeWorkspaceReadModel({
      ...frame,
      projection: { ...projection(), truncated: true },
    }, binding)).toBeNull();
    expect(selectNativeRecipeWorkspaceReadModel({
      ...frame,
      projection: { ...projection(), itemStocks: [...projection().itemStocks].reverse() },
    }, binding)).toBeNull();
    expect(selectNativeRecipeWorkspaceReadModel({
      ...frame,
      projection: {
        ...projection(),
        live: { ...projection().live, planetProfiles: projection().live.planetProfiles.slice(1) },
      },
    }, binding)).toBeNull();
  });

  it("supersedes an older in-flight selector so revisions and pages cannot be mixed", async () => {
    const store = new NativeRecipeWorkspaceStore();
    const firstSelector = selector("iron_ingot");
    const secondSelector = selector("copper_ingot");
    const firstIdentity = { sessionId: "authority-1", runId: "run-1", revision: 7, registryFingerprint: FINGERPRINT };
    const secondIdentity = { ...firstIdentity, revision: 8 };
    let resolveFirst!: (value: DesktopNativeCoreRecipeWorkspaceProjectionResult | null) => void;
    const first = {
      boundIdentity: firstIdentity,
      readVerifiedRecipeWorkspaceProjection: vi.fn(() => new Promise<DesktopNativeCoreRecipeWorkspaceProjectionResult | null>((resolve) => {
        resolveFirst = resolve;
      })),
    };
    const second = {
      boundIdentity: secondIdentity,
      readVerifiedRecipeWorkspaceProjection: vi.fn().mockResolvedValue(projection(secondSelector, 8)),
    };
    const oldRequest = store.refresh(first, firstIdentity, firstSelector);
    await expect(store.refresh(second, secondIdentity, secondSelector)).resolves.toBe("committed");
    resolveFirst(projection(firstSelector, 7));
    await expect(oldRequest).resolves.toBe("superseded");
    expect(store.getSnapshot().frame?.revision).toBe(8);
    expect(store.getSnapshot().frame?.projection.request.selectedItemId).toBe("copper_ingot");
  });

  it("keeps a matching confirmed selector mounted while the next revision loads", async () => {
    const store = new NativeRecipeWorkspaceStore();
    const value = selector();
    const identity7 = {
      sessionId: "authority-1",
      runId: "run-1",
      revision: 7,
      registryFingerprint: FINGERPRINT,
    };
    await store.refresh({
      boundIdentity: identity7,
      readVerifiedRecipeWorkspaceProjection: vi.fn().mockResolvedValue(projection(value, 7)),
    }, identity7, value);

    const identity8 = { ...identity7, revision: 8 };
    let resolveNext!: (value: DesktopNativeCoreRecipeWorkspaceProjectionResult | null) => void;
    const source = {
      boundIdentity: identity8,
      readVerifiedRecipeWorkspaceProjection: vi.fn(() => new Promise<DesktopNativeCoreRecipeWorkspaceProjectionResult | null>(
        (resolve) => { resolveNext = resolve; },
      )),
    };
    const first = store.refresh(source, identity8, value);
    const duplicate = store.refresh(source, identity8, value);

    expect(duplicate).toBe(first);
    expect(source.readVerifiedRecipeWorkspaceProjection).toHaveBeenCalledTimes(1);
    expect(selectNativeRecipeWorkspaceFrame(store.getSnapshot(), identity8, value)?.revision).toBe(7);
    expect(selectNativeRecipeWorkspaceFrame(
      store.getSnapshot(),
      identity8,
      selector("copper_ingot"),
    )).toBeNull();
    expect(selectNativeRecipeWorkspaceFrame(
      store.getSnapshot(),
      { ...identity8, runId: "run-2" },
      value,
    )).toBeNull();
    expect(selectNativeRecipeWorkspaceFrame(store.getSnapshot(), identity7, value)).toBeNull();

    resolveNext(projection(value, 8));
    await expect(first).resolves.toBe("committed");
    expect(selectNativeRecipeWorkspaceFrame(store.getSnapshot(), identity8, value)?.revision).toBe(8);
  });

  it("binds every recipe projection read to one run and registry fingerprint", async () => {
    const identity = {
      sessionId: "authority-1",
      runId: "run-1",
      revision: 7,
      registryFingerprint: FINGERPRINT,
    };
    const bridge = {
      getNativeCoreRecipeWorkspaceProjection: vi.fn().mockResolvedValue(projection(selector(), 7)),
    };
    const source = createNativePlayerAuthorityRecipeWorkspaceProjectionSource(bridge, identity);

    await expect(source?.readVerifiedRecipeWorkspaceProjection(selector())).resolves.toMatchObject({
      revision: 7,
      registryFingerprint: FINGERPRINT,
    });
    expect(bridge.getNativeCoreRecipeWorkspaceProjection).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "authority-1",
      runId: "run-1",
      expectedRevision: 7,
      expectedRegistryFingerprint: FINGERPRINT,
    }));
    expect(createNativePlayerAuthorityRecipeWorkspaceProjectionSource(bridge, {
      ...identity,
      runId: "bad run",
    })).toBeNull();
  });
});
