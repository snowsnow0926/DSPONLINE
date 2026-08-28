import type {
  DesktopBridge,
  DesktopNativeCoreStarMapOverviewProjectionRequest,
  DesktopNativeCoreStarMapOverviewProjectionResult,
  DesktopNativeCoreStellarIndustryProjectionRequest,
  DesktopNativeCoreStellarIndustryProjectionResult,
} from "../desktop";

export const NATIVE_STELLAR_PAGE_ROWS = 64 as const;

export interface NativeStellarProjectionIdentity {
  readonly sessionId: string;
  readonly revision: number;
  readonly registryFingerprint: string;
}

export interface NativeStarMapOverviewFrame extends NativeStellarProjectionIdentity {
  readonly projection: DesktopNativeCoreStarMapOverviewProjectionResult;
}

export interface NativeStellarIndustryFrame extends NativeStellarProjectionIdentity {
  readonly projection: DesktopNativeCoreStellarIndustryProjectionResult;
}

export interface NativeStellarWorkspaceSnapshot {
  readonly overview: {
    readonly status: "empty" | "loading" | "ready" | "unavailable";
    readonly requestedRevision: number | null;
    readonly frame: NativeStarMapOverviewFrame | null;
  };
  readonly industry: {
    readonly status: "empty" | "loading" | "ready" | "unavailable";
    readonly requestedRevision: number | null;
    readonly frame: NativeStellarIndustryFrame | null;
  };
}

export interface NativeStellarWorkspaceSource {
  readVerifiedStarMapOverviewProjection(
    request: Pick<DesktopNativeCoreStarMapOverviewProjectionRequest, "cursor" | "limit">,
    expectedRevision: number,
  ): Promise<DesktopNativeCoreStarMapOverviewProjectionResult | null>;
  readVerifiedStellarIndustryProjection(
    request: Pick<
      DesktopNativeCoreStellarIndustryProjectionRequest,
      "systemId" | "planetId" | "planetCursor" | "planetLimit" | "stationCursor" | "stationLimit"
    >,
    expectedRevision: number,
  ): Promise<DesktopNativeCoreStellarIndustryProjectionResult | null>;
}

export type NativeStarMapOverviewSelector = Pick<
  DesktopNativeCoreStarMapOverviewProjectionRequest,
  "cursor" | "limit"
>;

export type NativeStellarIndustrySelector = Pick<
  DesktopNativeCoreStellarIndustryProjectionRequest,
  "systemId" | "planetId" | "planetCursor" | "planetLimit" | "stationCursor" | "stationLimit"
>;

const LOGICAL_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const EMPTY_SNAPSHOT: NativeStellarWorkspaceSnapshot = Object.freeze({
  overview: Object.freeze({ status: "empty", requestedRevision: null, frame: null }),
  industry: Object.freeze({ status: "empty", requestedRevision: null, frame: null }),
});

function validLogicalId(value: string | null | undefined, maximum = 256): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum &&
    LOGICAL_ID_PATTERN.test(value);
}

function validRevision(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validPage(cursor: number, limit: number): boolean {
  return Number.isSafeInteger(cursor) && cursor >= 0 && cursor <= 0xffff_ffff &&
    Number.isSafeInteger(limit) && limit >= 1 && limit <= NATIVE_STELLAR_PAGE_ROWS;
}

function validNullableLogicalId(value: string | null): boolean {
  return value === null || validLogicalId(value);
}

export function validNativeStarMapOverviewSelector(
  selector: NativeStarMapOverviewSelector,
): boolean {
  return validPage(selector.cursor, selector.limit);
}

export function validNativeStellarIndustrySelector(
  selector: NativeStellarIndustrySelector,
): boolean {
  return validNullableLogicalId(selector.systemId) && validNullableLogicalId(selector.planetId) &&
    validPage(selector.planetCursor, selector.planetLimit) &&
    validPage(selector.stationCursor, selector.stationLimit);
}

function exactOverviewRequest(
  result: DesktopNativeCoreStarMapOverviewProjectionResult,
  revision: number,
  registryFingerprint: string,
  selector: NativeStarMapOverviewSelector,
): boolean {
  return result.schemaVersion === 1 && result.projectionType === "star-map-overview-v1" &&
    result.stateVersion === 47 && result.revision === revision &&
    result.registryFingerprint === registryFingerprint &&
    result.request.expectedRevision === revision &&
    result.request.expectedRegistryFingerprint === registryFingerprint &&
    result.request.cursor === selector.cursor && result.request.limit === selector.limit &&
    result.systems.cursor === selector.cursor && result.systems.limit === selector.limit &&
    result.systems.rows.length <= selector.limit;
}

function exactIndustryRequest(
  result: DesktopNativeCoreStellarIndustryProjectionResult,
  revision: number,
  registryFingerprint: string,
  selector: NativeStellarIndustrySelector,
): boolean {
  return result.schemaVersion === 1 && result.projectionType === "stellar-industry-v1" &&
    result.stateVersion === 47 && result.revision === revision &&
    result.registryFingerprint === registryFingerprint &&
    result.request.expectedRevision === revision &&
    result.request.expectedRegistryFingerprint === registryFingerprint &&
    result.request.systemId === selector.systemId && result.request.planetId === selector.planetId &&
    result.request.planetCursor === selector.planetCursor && result.request.planetLimit === selector.planetLimit &&
    result.request.stationCursor === selector.stationCursor && result.request.stationLimit === selector.stationLimit &&
    result.planets.cursor === selector.planetCursor && result.planets.limit === selector.planetLimit &&
    result.stations.cursor === selector.stationCursor && result.stations.limit === selector.stationLimit &&
    result.planets.rows.length <= selector.planetLimit && result.stations.rows.length <= selector.stationLimit;
}

export function createNativePlayerAuthorityStellarProjectionSource(
  bridge: Pick<
    DesktopBridge,
    "getNativeCoreStarMapOverviewProjection" | "getNativeCoreStellarIndustryProjection"
  > | null,
  identity: NativeStellarProjectionIdentity,
): NativeStellarWorkspaceSource | null {
  const readOverview = bridge?.getNativeCoreStarMapOverviewProjection;
  const readIndustry = bridge?.getNativeCoreStellarIndustryProjection;
  if (!validLogicalId(identity.sessionId, 128) || !validRevision(identity.revision) ||
      !validLogicalId(identity.registryFingerprint) || typeof readOverview !== "function" ||
      typeof readIndustry !== "function") return null;
  const source: NativeStellarWorkspaceSource = {
    async readVerifiedStarMapOverviewProjection(
      selector: NativeStarMapOverviewSelector,
      expectedRevision: number,
    ) {
      if (expectedRevision !== identity.revision || !validNativeStarMapOverviewSelector(selector)) return null;
      try {
        const result = await readOverview({
          sessionId: identity.sessionId,
          expectedRevision,
          expectedRegistryFingerprint: identity.registryFingerprint,
          ...selector,
        });
        return exactOverviewRequest(result, expectedRevision, identity.registryFingerprint, selector)
          ? result
          : null;
      } catch {
        return null;
      }
    },
    async readVerifiedStellarIndustryProjection(
      selector: NativeStellarIndustrySelector,
      expectedRevision: number,
    ) {
      if (expectedRevision !== identity.revision || !validNativeStellarIndustrySelector(selector)) return null;
      try {
        const result = await readIndustry({
          sessionId: identity.sessionId,
          expectedRevision,
          expectedRegistryFingerprint: identity.registryFingerprint,
          ...selector,
        });
        return exactIndustryRequest(result, expectedRevision, identity.registryFingerprint, selector)
          ? result
          : null;
      } catch {
        return null;
      }
    },
  };
  return Object.freeze(source);
}

export class NativeStellarWorkspaceStore {
  private snapshot: NativeStellarWorkspaceSnapshot = EMPTY_SNAPSHOT;
  private overviewToken = 0;
  private industryToken = 0;
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): NativeStellarWorkspaceSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  clear(): void {
    this.overviewToken += 1;
    this.industryToken += 1;
    this.publish(EMPTY_SNAPSHOT);
  }

  async refreshOverview(
    source: NativeStellarWorkspaceSource,
    identity: NativeStellarProjectionIdentity,
    selector: NativeStarMapOverviewSelector,
  ): Promise<"committed" | "superseded" | "unavailable"> {
    if (!this.validIdentity(identity) || !validNativeStarMapOverviewSelector(selector)) {
      this.invalidateOverview();
      return "unavailable";
    }
    const token = ++this.overviewToken;
    const previous = this.snapshot.overview.frame;
    this.publish(Object.freeze({
      ...this.snapshot,
      overview: Object.freeze({ status: "loading", requestedRevision: identity.revision, frame: previous }),
    }));
    const projection = await source.readVerifiedStarMapOverviewProjection(selector, identity.revision);
    if (token !== this.overviewToken) return "superseded";
    if (!projection || !exactOverviewRequest(
      projection,
      identity.revision,
      identity.registryFingerprint,
      selector,
    )) {
      this.publish(Object.freeze({
        ...this.snapshot,
        overview: Object.freeze({ status: "unavailable", requestedRevision: identity.revision, frame: previous }),
      }));
      return "unavailable";
    }
    const frame = Object.freeze({ ...identity, projection });
    this.publish(Object.freeze({
      ...this.snapshot,
      overview: Object.freeze({ status: "ready", requestedRevision: identity.revision, frame }),
    }));
    return "committed";
  }

  async refreshIndustry(
    source: NativeStellarWorkspaceSource,
    identity: NativeStellarProjectionIdentity,
    selector: NativeStellarIndustrySelector,
  ): Promise<"committed" | "superseded" | "unavailable"> {
    if (!this.validIdentity(identity) || !validNativeStellarIndustrySelector(selector)) {
      this.invalidateIndustry();
      return "unavailable";
    }
    const token = ++this.industryToken;
    const previous = this.snapshot.industry.frame;
    this.publish(Object.freeze({
      ...this.snapshot,
      industry: Object.freeze({ status: "loading", requestedRevision: identity.revision, frame: previous }),
    }));
    const projection = await source.readVerifiedStellarIndustryProjection(selector, identity.revision);
    if (token !== this.industryToken) return "superseded";
    if (!projection || !exactIndustryRequest(
      projection,
      identity.revision,
      identity.registryFingerprint,
      selector,
    )) {
      this.publish(Object.freeze({
        ...this.snapshot,
        industry: Object.freeze({ status: "unavailable", requestedRevision: identity.revision, frame: previous }),
      }));
      return "unavailable";
    }
    const frame = Object.freeze({ ...identity, projection });
    this.publish(Object.freeze({
      ...this.snapshot,
      industry: Object.freeze({ status: "ready", requestedRevision: identity.revision, frame }),
    }));
    return "committed";
  }

  private validIdentity(identity: NativeStellarProjectionIdentity): boolean {
    return validLogicalId(identity.sessionId, 128) && validRevision(identity.revision) &&
      validLogicalId(identity.registryFingerprint);
  }

  private invalidateOverview(): void {
    this.overviewToken += 1;
    this.publish(Object.freeze({
      ...this.snapshot,
      overview: Object.freeze({ status: "unavailable", requestedRevision: null, frame: null }),
    }));
  }

  private invalidateIndustry(): void {
    this.industryToken += 1;
    this.publish(Object.freeze({
      ...this.snapshot,
      industry: Object.freeze({ status: "unavailable", requestedRevision: null, frame: null }),
    }));
  }

  private publish(next: NativeStellarWorkspaceSnapshot): void {
    if (this.snapshot === next) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}
