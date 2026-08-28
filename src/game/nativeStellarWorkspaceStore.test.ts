import { describe, expect, it, vi } from "vitest";
import type {
  DesktopBridge,
  DesktopNativeCoreStarMapOverviewProjectionResult,
  DesktopNativeCoreStellarIndustryProjectionResult,
} from "../desktop";
import {
  NATIVE_STELLAR_PAGE_ROWS,
  NativeStellarWorkspaceStore,
  createNativePlayerAuthorityStellarProjectionSource,
  validNativeStarMapOverviewSelector,
  validNativeStellarIndustrySelector,
  type NativeStellarProjectionIdentity,
  type NativeStellarWorkspaceSource,
} from "./nativeStellarWorkspaceStore";

const IDENTITY: NativeStellarProjectionIdentity = Object.freeze({
  sessionId: "authority-session-1",
  revision: 17,
  registryFingerprint: "registry-fingerprint-1",
});
const OVERVIEW_SELECTOR = Object.freeze({ cursor: 0, limit: 16 });
const INDUSTRY_SELECTOR = Object.freeze({
  systemId: null,
  planetId: null,
  planetCursor: 0,
  planetLimit: 16,
  stationCursor: 0,
  stationLimit: 16,
});

function overview(
  overrides: Partial<DesktopNativeCoreStarMapOverviewProjectionResult> = {},
): DesktopNativeCoreStarMapOverviewProjectionResult {
  return {
    schemaVersion: 1,
    projectionType: "star-map-overview-v1",
    revision: IDENTITY.revision,
    registryFingerprint: IDENTITY.registryFingerprint,
    stateVersion: 47,
    limits: { requestBytes: 32768, projectionBytes: 1048576, pageRows: 64, labelBytes: 512 },
    request: {
      expectedRevision: IDENTITY.revision,
      expectedRegistryFingerprint: IDENTITY.registryFingerprint,
      ...OVERVIEW_SELECTOR,
    },
    activePlanetId: "planet-a",
    activeSystemId: "system-a",
    galaxySeed: 42,
    summary: {
      systemCount: 0,
      unlockedSystemCount: 0,
      planetCount: 0,
      colonizedPlanetCount: 0,
      stationCount: 0,
    },
    systems: { ...OVERVIEW_SELECTOR, totalCount: 0, nextCursor: null, rows: [] },
    ...overrides,
  };
}

function industry(
  overrides: Partial<DesktopNativeCoreStellarIndustryProjectionResult> = {},
): DesktopNativeCoreStellarIndustryProjectionResult {
  return {
    schemaVersion: 1,
    projectionType: "stellar-industry-v1",
    revision: IDENTITY.revision,
    registryFingerprint: IDENTITY.registryFingerprint,
    stateVersion: 47,
    limits: { requestBytes: 32768, projectionBytes: 1048576, pageRows: 64, labelBytes: 512 },
    request: {
      expectedRevision: IDENTITY.revision,
      expectedRegistryFingerprint: IDENTITY.registryFingerprint,
      ...INDUSTRY_SELECTOR,
    },
    activePlanetId: "planet-a",
    activeSystemId: "system-a",
    scopeSystemId: null,
    scopePlanetId: null,
    truncated: false,
    planets: {
      cursor: INDUSTRY_SELECTOR.planetCursor,
      limit: INDUSTRY_SELECTOR.planetLimit,
      totalCount: 0,
      nextCursor: null,
      rows: [],
    },
    stations: {
      cursor: INDUSTRY_SELECTOR.stationCursor,
      limit: INDUSTRY_SELECTOR.stationLimit,
      totalCount: 0,
      nextCursor: null,
      rows: [],
    },
    ...overrides,
  };
}

function source(
  readOverview: NativeStellarWorkspaceSource["readVerifiedStarMapOverviewProjection"] = vi.fn(async () => overview()),
  readIndustry: NativeStellarWorkspaceSource["readVerifiedStellarIndustryProjection"] = vi.fn(async () => industry()),
): NativeStellarWorkspaceSource {
  return {
    readVerifiedStarMapOverviewProjection: readOverview,
    readVerifiedStellarIndustryProjection: readIndustry,
  };
}

describe("native stellar workspace projection source", () => {
  it("binds both requests to one main-owned session, revision, and fingerprint", async () => {
    const getOverview = vi.fn(async () => overview());
    const getIndustry = vi.fn(async () => industry());
    const projectionSource = createNativePlayerAuthorityStellarProjectionSource({
      getNativeCoreStarMapOverviewProjection: getOverview,
      getNativeCoreStellarIndustryProjection: getIndustry,
    } as Pick<DesktopBridge, "getNativeCoreStarMapOverviewProjection" | "getNativeCoreStellarIndustryProjection">, IDENTITY);
    expect(projectionSource).not.toBeNull();

    await expect(projectionSource!.readVerifiedStarMapOverviewProjection(
      OVERVIEW_SELECTOR,
      IDENTITY.revision,
    )).resolves.toEqual(overview());
    await expect(projectionSource!.readVerifiedStellarIndustryProjection(
      INDUSTRY_SELECTOR,
      IDENTITY.revision,
    )).resolves.toEqual(industry());
    expect(getOverview).toHaveBeenCalledWith({
      sessionId: IDENTITY.sessionId,
      expectedRevision: IDENTITY.revision,
      expectedRegistryFingerprint: IDENTITY.registryFingerprint,
      ...OVERVIEW_SELECTOR,
    });
    expect(getIndustry).toHaveBeenCalledWith({
      sessionId: IDENTITY.sessionId,
      expectedRevision: IDENTITY.revision,
      expectedRegistryFingerprint: IDENTITY.registryFingerprint,
      ...INDUSTRY_SELECTOR,
    });
  });

  it("fails closed for forged response identity, invalid selectors, or bridge errors", async () => {
    const getOverview = vi.fn(async () => overview({ registryFingerprint: "forged" }));
    const getIndustry = vi.fn(async () => { throw new Error("ipc lost"); });
    const projectionSource = createNativePlayerAuthorityStellarProjectionSource({
      getNativeCoreStarMapOverviewProjection: getOverview,
      getNativeCoreStellarIndustryProjection: getIndustry,
    }, IDENTITY)!;

    await expect(projectionSource.readVerifiedStarMapOverviewProjection(
      OVERVIEW_SELECTOR,
      IDENTITY.revision,
    )).resolves.toBeNull();
    await expect(projectionSource.readVerifiedStellarIndustryProjection(
      INDUSTRY_SELECTOR,
      IDENTITY.revision,
    )).resolves.toBeNull();
    await expect(projectionSource.readVerifiedStarMapOverviewProjection(
      { cursor: -1, limit: 1 },
      IDENTITY.revision,
    )).resolves.toBeNull();
    await expect(projectionSource.readVerifiedStarMapOverviewProjection(
      OVERVIEW_SELECTOR,
      IDENTITY.revision + 1,
    )).resolves.toBeNull();
  });
});

describe("NativeStellarWorkspaceStore", () => {
  it("commits independently verified overview and industry frames", async () => {
    const store = new NativeStellarWorkspaceStore();
    const projectionSource = source();
    const listener = vi.fn();
    store.subscribe(listener);

    await expect(store.refreshOverview(
      projectionSource,
      IDENTITY,
      OVERVIEW_SELECTOR,
    )).resolves.toBe("committed");
    await expect(store.refreshIndustry(
      projectionSource,
      IDENTITY,
      INDUSTRY_SELECTOR,
    )).resolves.toBe("committed");

    const snapshot = store.getSnapshot();
    expect(snapshot.overview).toMatchObject({ status: "ready", requestedRevision: 17 });
    expect(snapshot.overview.frame).toMatchObject(IDENTITY);
    expect(snapshot.industry).toMatchObject({ status: "ready", requestedRevision: 17 });
    expect(snapshot.industry.frame).toMatchObject(IDENTITY);
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it("does not let a late response overwrite a newer revision", async () => {
    let releaseOld: ((value: DesktopNativeCoreStarMapOverviewProjectionResult | null) => void) | null = null;
    const oldResult = new Promise<DesktopNativeCoreStarMapOverviewProjectionResult | null>((resolve) => {
      releaseOld = resolve;
    });
    const nextIdentity = { ...IDENTITY, revision: 18 };
    const oldSource = source(vi.fn(() => oldResult));
    const newSource = source(vi.fn(async () => overview({
      revision: 18,
      request: { ...overview().request, expectedRevision: 18 },
    })));
    const store = new NativeStellarWorkspaceStore();

    const pending = store.refreshOverview(oldSource, IDENTITY, OVERVIEW_SELECTOR);
    await expect(store.refreshOverview(newSource, nextIdentity, OVERVIEW_SELECTOR)).resolves.toBe("committed");
    releaseOld!(overview());
    await expect(pending).resolves.toBe("superseded");
    expect(store.getSnapshot().overview.frame?.revision).toBe(18);
  });

  it("rejects oversized pages and malformed scope IDs before reading", async () => {
    const readOverview = vi.fn(async () => overview());
    const readIndustry = vi.fn(async () => industry());
    const projectionSource = source(readOverview, readIndustry);
    const store = new NativeStellarWorkspaceStore();

    await expect(store.refreshOverview(projectionSource, IDENTITY, {
      cursor: 0,
      limit: NATIVE_STELLAR_PAGE_ROWS + 1,
    })).resolves.toBe("unavailable");
    await expect(store.refreshIndustry(projectionSource, IDENTITY, {
      ...INDUSTRY_SELECTOR,
      planetId: "planet with spaces",
    })).resolves.toBe("unavailable");
    expect(readOverview).not.toHaveBeenCalled();
    expect(readIndustry).not.toHaveBeenCalled();
  });

  it("publishes unavailable while retaining only the last immutable frame", async () => {
    const store = new NativeStellarWorkspaceStore();
    await store.refreshOverview(source(), IDENTITY, OVERVIEW_SELECTOR);
    const previous = store.getSnapshot().overview.frame;
    const missing = source(vi.fn(async () => null));

    await expect(store.refreshOverview(missing, IDENTITY, OVERVIEW_SELECTOR)).resolves.toBe("unavailable");
    expect(store.getSnapshot().overview).toEqual({
      status: "unavailable",
      requestedRevision: IDENTITY.revision,
      frame: previous,
    });
    store.clear();
    expect(store.getSnapshot()).toEqual({
      overview: { status: "empty", requestedRevision: null, frame: null },
      industry: { status: "empty", requestedRevision: null, frame: null },
    });
  });
});

describe("native stellar selector validation", () => {
  it("accepts bounded pages and rejects malformed identifiers and cursors", () => {
    expect(validNativeStarMapOverviewSelector(OVERVIEW_SELECTOR)).toBe(true);
    expect(validNativeStarMapOverviewSelector({ cursor: 0, limit: 0 })).toBe(false);
    expect(validNativeStellarIndustrySelector(INDUSTRY_SELECTOR)).toBe(true);
    expect(validNativeStellarIndustrySelector({
      ...INDUSTRY_SELECTOR,
      systemId: "system with spaces",
    })).toBe(false);
    expect(validNativeStellarIndustrySelector({
      ...INDUSTRY_SELECTOR,
      stationCursor: 0x1_0000_0000,
    })).toBe(false);
  });
});
