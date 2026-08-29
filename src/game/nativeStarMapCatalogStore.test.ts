import { describe, expect, it, vi } from "vitest";
import type {
  DesktopNativeCoreStarMapCatalogPlanetRow,
  DesktopNativeCoreStarMapCatalogProjectionResult,
  DesktopNativeCoreStarMapCatalogSystemRow,
} from "../desktop";
import {
  NATIVE_STAR_MAP_CATALOG_PAGE_ROWS,
  NativeStarMapCatalogStore,
  createNativePlayerAuthorityStarMapCatalogSource,
  selectNativeStarMapCatalogFrame,
  type NativeStarMapCatalogIdentity,
  type NativeStarMapCatalogSource,
} from "./nativeStarMapCatalogStore";

const identity = Object.freeze({
  sessionId: "authority-1",
  revision: 7,
  registryFingerprint: "builtin:test",
}) satisfies NativeStarMapCatalogIdentity;

function systemRow(
  systemId: string,
  planetCount: number,
  firstPlanetId: string,
  active = false,
): DesktopNativeCoreStarMapCatalogSystemRow {
  return {
    systemId,
    displayName: `系统 ${systemId}`,
    displayNameTruncated: false,
    starClassId: "g",
    starTypeName: "G",
    starTypeNameTruncated: false,
    positionX: 0,
    positionY: 0,
    distanceFromOriginLy: 0,
    luminosity: 1,
    massMultiplier: 1,
    radiusMultiplier: 1,
    active,
    discovered: true,
    missionActive: false,
    missionElapsedSeconds: 0,
    missionDurationSeconds: 0,
    surveyProgress: 1,
    firstPlanetId,
    planetCount,
    colonizedPlanetCount: active ? 1 : 0,
  };
}

function planetRow(index: number): DesktopNativeCoreStarMapCatalogPlanetRow {
  const systemId = index < 64 ? "alpha" : "beta";
  const active = index === 0;
  return {
    planetId: `planet-${index}`,
    displayName: `行星 ${index}`,
    displayNameTruncated: false,
    systemId,
    systemDisplayName: `系统 ${systemId}`,
    systemDisplayNameTruncated: false,
    kind: "terrestrial",
    orbitIndex: index,
    simulationOrder: index,
    systemPositionX: 0,
    systemPositionY: 0,
    active,
    discovered: true,
    colonized: active,
    industryRole: "auto",
    entityCount: 0,
    deviceCount: 0,
    beltCount: 0,
    metadata: {
      note: "",
      noteTruncated: false,
      tagTextTruncated: false,
      tags: { totalCount: 0, truncated: false, rows: [] },
    },
    profile: {
      climateName: "温带",
      climateNameTruncated: false,
      oceanType: "water",
      specialization: "balanced",
      specializationName: "均衡",
      specializationNameTruncated: false,
      tidalLocked: false,
      sulfuricOcean: false,
      windMultiplier: 1,
      solarMultiplier: 1,
      geothermalMultiplier: 1,
      miningMultiplier: 1,
      orbitalYieldMultiplier: 1,
      reserveScale: 1,
      travelTimeMultiplier: 1,
      productionSpeedMultiplier: 1,
      surveyDurationSeconds: 60,
      resourceIds: { totalCount: 1, truncated: false, rows: ["iron_ore"] },
      rareResourceIds: { totalCount: 0, truncated: false, rows: [] },
      orbitalYields: { totalCount: 0, truncated: false, rows: [] },
    },
  };
}

const allSystems = [systemRow("alpha", 64, "planet-0", true), systemRow("beta", 1, "planet-64")];
const allPlanets = Array.from({ length: 65 }, (_, index) => planetRow(index));

function projection(
  request: { systemCursor: number; systemLimit: number; planetCursor: number; planetLimit: number },
  boundIdentity: NativeStarMapCatalogIdentity = identity,
  mutate?: (value: DesktopNativeCoreStarMapCatalogProjectionResult) => void,
): DesktopNativeCoreStarMapCatalogProjectionResult {
  const systemRows = allSystems.slice(request.systemCursor, request.systemCursor + request.systemLimit);
  const planetRows = allPlanets.slice(request.planetCursor, request.planetCursor + request.planetLimit);
  const value: DesktopNativeCoreStarMapCatalogProjectionResult = {
    schemaVersion: 1,
    projectionType: "star-map-catalog-v1",
    revision: boundIdentity.revision,
    registryFingerprint: boundIdentity.registryFingerprint,
    stateVersion: 47,
    limits: {
      requestBytes: 32_768,
      projectionBytes: 1_048_576,
      pageRows: 64,
      labelBytes: 512,
      nestedRows: 64,
      tagRows: 32,
    },
    request: {
      expectedRevision: boundIdentity.revision,
      expectedRegistryFingerprint: boundIdentity.registryFingerprint,
      ...request,
    },
    activePlanetId: "planet-0",
    activeSystemId: "alpha",
    galaxySeed: 42,
    summary: { systemCount: 2, unlockedSystemCount: 2, planetCount: 65, colonizedPlanetCount: 1 },
    truncated: request.systemCursor + systemRows.length < 2 ||
      request.planetCursor + planetRows.length < 65,
    systems: {
      cursor: request.systemCursor,
      limit: request.systemLimit,
      totalCount: 2,
      nextCursor: request.systemCursor + systemRows.length < 2
        ? request.systemCursor + systemRows.length
        : null,
      rows: systemRows,
    },
    planets: {
      cursor: request.planetCursor,
      limit: request.planetLimit,
      totalCount: 65,
      nextCursor: request.planetCursor + planetRows.length < 65
        ? request.planetCursor + planetRows.length
        : null,
      rows: planetRows,
    },
  };
  mutate?.(value);
  return value;
}

function source(
  boundIdentity: NativeStarMapCatalogIdentity = identity,
  mutate?: (value: DesktopNativeCoreStarMapCatalogProjectionResult, call: number) => void,
): NativeStarMapCatalogSource {
  let call = 0;
  return {
    mode: "player-authority",
    boundIdentity,
    async readVerifiedStarMapCatalogProjection(request) {
      const value = projection(request, boundIdentity);
      mutate?.(value, call++);
      return value;
    },
  };
}

describe("NativeStarMapCatalogStore", () => {
  it("collects independent system and planet pages into one exact-revision directory", async () => {
    const store = new NativeStarMapCatalogStore();
    const listener = vi.fn();
    store.subscribe(listener);
    await expect(store.refresh(source(), identity)).resolves.toBe("committed");
    const frame = selectNativeStarMapCatalogFrame(store.getSnapshot(), identity);
    expect(frame?.systems).toHaveLength(2);
    expect(frame?.planets).toHaveLength(65);
    expect(frame?.planetRowsBySystemId.get("alpha")).toHaveLength(64);
    expect(frame?.planetRowsById.get("planet-64")?.systemId).toBe("beta");
    expect(frame?.systemRowsById.get("alpha")?.active).toBe(true);
    expect(listener).toHaveBeenCalled();
  });

  it("binds the optional desktop reader to the exact authority identity and request", async () => {
    const read = vi.fn(async (request) => projection(request, identity));
    const catalogSource = createNativePlayerAuthorityStarMapCatalogSource({
      getNativeCoreStarMapCatalogProjection: read,
    }, identity);
    expect(catalogSource).not.toBeNull();
    const result = await catalogSource!.readVerifiedStarMapCatalogProjection({
      systemCursor: 0,
      systemLimit: NATIVE_STAR_MAP_CATALOG_PAGE_ROWS,
      planetCursor: 0,
      planetLimit: NATIVE_STAR_MAP_CATALOG_PAGE_ROWS,
    }, 7);
    expect(result?.revision).toBe(7);
    expect(read).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "authority-1",
      expectedRevision: 7,
      expectedRegistryFingerprint: "builtin:test",
    }));
    await expect(catalogSource!.readVerifiedStarMapCatalogProjection({
      systemCursor: 0,
      systemLimit: 64,
      planetCursor: 0,
      planetLimit: 64,
    }, 8)).resolves.toBeNull();
  });

  it("fails closed on cross-page identity drift and duplicate global IDs", async () => {
    const driftStore = new NativeStarMapCatalogStore();
    await expect(driftStore.refresh(source(identity, (value, call) => {
      if (call === 1) value.activeSystemId = "beta";
    }), identity)).resolves.toBe("unavailable");
    expect(driftStore.getSnapshot().status).toBe("unavailable");

    const duplicateStore = new NativeStarMapCatalogStore();
    await expect(duplicateStore.refresh(source(identity, (value, call) => {
      if (call === 1) value.planets.rows[0] = { ...value.planets.rows[0], planetId: "planet-0" };
    }), identity)).resolves.toBe("unavailable");
    expect(duplicateStore.getSnapshot().frame).toBeNull();
  });

  it("discards a late old revision instead of publishing mixed catalog rows", async () => {
    let resolveOld!: () => void;
    const oldSource: NativeStarMapCatalogSource = {
      mode: "player-authority",
      boundIdentity: identity,
      readVerifiedStarMapCatalogProjection: (request) => new Promise((resolve) => {
        resolveOld = () => resolve(projection(request, identity));
      }),
    };
    const nextIdentity = { ...identity, revision: 8 };
    const store = new NativeStarMapCatalogStore();
    const oldRefresh = store.refresh(oldSource, identity);
    const nextRefresh = store.refresh(source(nextIdentity), nextIdentity);
    resolveOld();
    await expect(oldRefresh).resolves.toBe("superseded");
    await expect(nextRefresh).resolves.toBe("committed");
    expect(store.getSnapshot().frame?.revision).toBe(8);
  });
});
