import type {
  DesktopNativeCoreBeltProjection,
  DesktopNativeCoreEntityProjection,
  DesktopNativeCoreFactoryReadModelRequest,
  DesktopNativeCoreFactoryReadModelResult,
  DesktopNativeCoreViewportProjectionV2Request,
  DesktopNativeCoreViewportProjectionV2Result,
} from "../desktop";

export interface NativeFactoryThinViewFrame {
  readonly revision: number;
  readonly planetId: string;
  /** Main-owned authority session for fail-closed renderer binding; null for JS shadow reads. */
  readonly authoritySessionId?: string | null;
  /** Main-owned authority run captured before this projection request started. */
  readonly authorityRunId?: string | null;
  readonly factory: DesktopNativeCoreFactoryReadModelResult;
  readonly viewport: DesktopNativeCoreViewportProjectionV2Result;
}

export interface NativeFactoryThinViewSnapshot {
  readonly status: "empty" | "loading" | "ready" | "unavailable";
  readonly requestedRevision: number | null;
  readonly frame: NativeFactoryThinViewFrame | null;
}

export interface NativeFactoryThinViewSource {
  readVerifiedFactoryReadModel(
    request: Omit<DesktopNativeCoreFactoryReadModelRequest, "sessionId" | "expectedRevision">,
    expectedRevision: number,
  ): Promise<DesktopNativeCoreFactoryReadModelResult | null>;
  readVerifiedViewportProjectionV2(
    request: Omit<DesktopNativeCoreViewportProjectionV2Request, "sessionId" | "expectedRevision">,
    expectedRevision: number,
  ): Promise<DesktopNativeCoreViewportProjectionV2Result | null>;
}

export interface NativeFactoryThinViewRequest {
  readonly expectedRevision: number;
  readonly authoritySessionId?: string | null;
  readonly authorityRunId?: string | null;
  readonly factory: Omit<DesktopNativeCoreFactoryReadModelRequest, "sessionId" | "expectedRevision">;
  readonly viewport: Omit<DesktopNativeCoreViewportProjectionV2Request, "sessionId" | "expectedRevision">;
}

export type NativeFactoryThinViewRefreshResult =
  | { readonly status: "committed"; readonly frame: NativeFactoryThinViewFrame }
  | { readonly status: "superseded" | "unavailable" };

const EMPTY_SNAPSHOT: NativeFactoryThinViewSnapshot = Object.freeze({
  status: "empty",
  requestedRevision: null,
  frame: null,
});

const MAX_COMPLETE_VIEWPORT_ENTITY_ROWS = 4_096;
const MAX_COMPLETE_VIEWPORT_BELT_ROWS = 8_192;
const MAX_COMPLETE_VIEWPORT_PAGES = 64;

function isValidRevision(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isValidAuthoritySessionId(value: string | null | undefined): boolean {
  return value === undefined || value === null ||
    (value.length >= 1 && value.length <= 128 && /^[A-Za-z0-9_.:-]+$/.test(value));
}

const isValidAuthorityRunId = isValidAuthoritySessionId;

function frameMatchesRequest(
  request: NativeFactoryThinViewRequest,
  factory: DesktopNativeCoreFactoryReadModelResult,
  viewport: DesktopNativeCoreViewportProjectionV2Result,
): boolean {
  const revision = request.expectedRevision;
  const planetId = request.viewport.planetId;
  return factory.projectionType === "factory-read-model-v1" &&
    viewport.projectionType === "viewport-v2" &&
    factory.revision === revision &&
    viewport.revision === revision &&
    factory.shell.source === "native-core" &&
    factory.shell.activePlanetId === planetId &&
    factory.planetNavigation.activePlanetId === planetId &&
    factory.selection.activePlanetId === planetId &&
    factory.construction.activePlanetId === planetId &&
    viewport.planetId === planetId &&
    viewport.nextEntityCursor === null && viewport.nextBeltCursor === null;
}

function sameBounds(
  left: DesktopNativeCoreViewportProjectionV2Result["bounds"],
  right: DesktopNativeCoreViewportProjectionV2Result["bounds"],
): boolean {
  return left.minX === right.minX && left.minY === right.minY &&
    left.maxX === right.maxX && left.maxY === right.maxY;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length &&
    new Set(right).size === right.length && left.every((id) => right.includes(id));
}

function samePageIdentity(
  first: DesktopNativeCoreViewportProjectionV2Result,
  page: DesktopNativeCoreViewportProjectionV2Result,
): boolean {
  return page.schemaVersion === 2 && page.projectionType === "viewport-v2" &&
    page.revision === first.revision && page.planetId === first.planetId &&
    sameBounds(page.bounds, first.bounds) && sameBounds(page.worldBounds, first.worldBounds) &&
    page.planetTotals.entities === first.planetTotals.entities &&
    page.planetTotals.belts === first.planetTotals.belts &&
    page.viewportTotals.entities === first.viewportTotals.entities &&
    page.viewportTotals.belts === first.viewportTotals.belts &&
    page.minimap.entityCount === first.minimap.entityCount &&
    page.minimap.beltCount === first.minimap.beltCount &&
    page.minimap.occupiedCellCount === first.minimap.occupiedCellCount &&
    page.minimap.cellSize === first.minimap.cellSize &&
    sameBounds(page.minimap.bounds, first.minimap.bounds) &&
    page.broadQueryFallback === first.broadQueryFallback &&
    JSON.stringify(page.base) === JSON.stringify(first.base) &&
    sameStringSet(page.pinnedEntityIds, first.pinnedEntityIds) &&
    sameStringSet(page.pinnedBeltIds, first.pinnedBeltIds);
}

function projectionRecordEqual(left: object, right: object): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function pointWithinBounds(
  position: DesktopNativeCoreEntityProjection["position"],
  bounds: DesktopNativeCoreViewportProjectionV2Result["bounds"],
): boolean {
  return Boolean(position) && position!.x >= bounds.minX && position!.x <= bounds.maxX &&
    position!.y >= bounds.minY && position!.y <= bounds.maxY;
}

async function readCompleteViewportProjection(
  source: NativeFactoryThinViewSource,
  request: NativeFactoryThinViewRequest["viewport"],
  expectedRevision: number,
): Promise<DesktopNativeCoreViewportProjectionV2Result | null> {
  const boundValues = [request.bounds.minX, request.bounds.minY, request.bounds.maxX, request.bounds.maxY];
  if ((request.entityCursor ?? 0) !== 0 || (request.beltCursor ?? 0) !== 0 ||
    request.entityLimit < 1 || request.beltLimit < 1 ||
    boundValues.some((value) => !Number.isFinite(value)) ||
    request.bounds.minX > request.bounds.maxX || request.bounds.minY > request.bounds.maxY) {
    return null;
  }
  const requestedPinnedEntityIds = [...new Set(request.pinnedEntityIds ?? [])];
  const requestedPinnedBeltIds = [...new Set(request.pinnedBeltIds ?? [])];
  if (requestedPinnedEntityIds.length !== (request.pinnedEntityIds?.length ?? 0) ||
    requestedPinnedBeltIds.length !== (request.pinnedBeltIds?.length ?? 0) ||
    requestedPinnedEntityIds.length > 32 || requestedPinnedBeltIds.length > 64) {
    return null;
  }

  let entityCursor = 0;
  let beltCursor = 0;
  let first: DesktopNativeCoreViewportProjectionV2Result | null = null;
  let completed = false;
  const entities = new Map<string, DesktopNativeCoreEntityProjection>();
  const belts = new Map<string, DesktopNativeCoreBeltProjection>();
  for (let pageIndex = 0; pageIndex < MAX_COMPLETE_VIEWPORT_PAGES; pageIndex += 1) {
    const page = await source.readVerifiedViewportProjectionV2({
      ...request,
      entityCursor,
      beltCursor,
    }, expectedRevision);
    if (!page) return null;
    if (!first) {
      first = page;
      if (page.schemaVersion !== 2 || page.projectionType !== "viewport-v2" ||
        page.revision !== expectedRevision || page.planetId !== request.planetId ||
        !sameBounds(page.bounds, request.bounds) ||
        page.minimap.entityCount !== page.planetTotals.entities ||
        page.minimap.beltCount !== page.planetTotals.belts ||
        !sameBounds(page.minimap.bounds, page.worldBounds) ||
        page.viewportTotals.entities > MAX_COMPLETE_VIEWPORT_ENTITY_ROWS ||
        page.viewportTotals.belts > MAX_COMPLETE_VIEWPORT_BELT_ROWS ||
        page.planetTotals.entities < page.viewportTotals.entities ||
        page.planetTotals.belts < page.viewportTotals.belts ||
        !sameStringSet(page.pinnedEntityIds, requestedPinnedEntityIds) ||
        !sameStringSet(page.pinnedBeltIds, requestedPinnedBeltIds)) {
        return null;
      }
    } else if (!samePageIdentity(first, page)) {
      return null;
    }

    const pageEntityIds = new Set<string>();
    for (const entity of page.entities) {
      if (pageEntityIds.has(entity.id)) return null;
      pageEntityIds.add(entity.id);
      const previous = entities.get(entity.id);
      if (previous) {
        if (!page.pinnedEntityIds.includes(entity.id) || !projectionRecordEqual(previous, entity)) return null;
      } else {
        entities.set(entity.id, entity);
      }
    }
    const pageBeltIds = new Set<string>();
    for (const belt of page.belts) {
      if (pageBeltIds.has(belt.id)) return null;
      pageBeltIds.add(belt.id);
      const previous = belts.get(belt.id);
      if (previous) {
        if (!page.pinnedBeltIds.includes(belt.id) || !projectionRecordEqual(previous, belt)) return null;
      } else {
        belts.set(belt.id, belt);
      }
    }
    if (entities.size > MAX_COMPLETE_VIEWPORT_ENTITY_ROWS + requestedPinnedEntityIds.length ||
      belts.size > MAX_COMPLETE_VIEWPORT_BELT_ROWS + requestedPinnedBeltIds.length) {
      return null;
    }

    const nextEntityCursor = page.nextEntityCursor ?? page.viewportTotals.entities;
    const nextBeltCursor = page.nextBeltCursor ?? page.viewportTotals.belts;
    if (page.nextEntityCursor !== null &&
      (nextEntityCursor <= entityCursor || nextEntityCursor > page.viewportTotals.entities)) return null;
    if (page.nextBeltCursor !== null &&
      (nextBeltCursor <= beltCursor || nextBeltCursor > page.viewportTotals.belts)) return null;
    if (page.nextEntityCursor === null && page.nextBeltCursor === null) {
      completed = true;
      break;
    }
    if (nextEntityCursor === entityCursor && nextBeltCursor === beltCursor) return null;
    entityCursor = nextEntityCursor;
    beltCursor = nextBeltCursor;
  }
  if (!completed || !first || entityCursor > first.viewportTotals.entities || beltCursor > first.viewportTotals.belts) return null;

  const entityRows = [...entities.values()];
  const visibleEntityIds = new Set(entityRows
    .filter((entity) => pointWithinBounds(entity.position, first!.bounds))
    .map((entity) => entity.id));
  if (visibleEntityIds.size !== first.viewportTotals.entities ||
    requestedPinnedEntityIds.some((id) => !entities.has(id))) return null;
  const beltSourceEntityIds = new Set([...visibleEntityIds, ...requestedPinnedEntityIds]);
  const ordinaryBeltCount = [...belts.values()].reduce((count, belt) =>
    count + (beltSourceEntityIds.has(belt.source ?? "") || beltSourceEntityIds.has(belt.target ?? "") ? 1 : 0), 0);
  if (ordinaryBeltCount !== first.viewportTotals.belts ||
    requestedPinnedBeltIds.some((id) => !belts.has(id))) return null;
  const expectedEntityUnion = first.viewportTotals.entities + requestedPinnedEntityIds.reduce(
    (count, id) => count + (visibleEntityIds.has(id) ? 0 : 1),
    0,
  );
  const expectedBeltUnion = first.viewportTotals.belts + requestedPinnedBeltIds.reduce((count, id) => {
    const belt = belts.get(id);
    return count + (belt && (beltSourceEntityIds.has(belt.source ?? "") || beltSourceEntityIds.has(belt.target ?? "")) ? 0 : 1);
  }, 0);
  if (entities.size !== expectedEntityUnion || belts.size !== expectedBeltUnion) return null;

  return {
    ...first,
    entities: entityRows,
    belts: [...belts.values()],
    nextEntityCursor: null,
    nextBeltCursor: null,
  };
}

/**
 * Renderer-owned cache for bounded native projections only.
 *
 * The store deliberately has no GameState fallback and keeps only one complete
 * frame. A frame becomes observable after both projections for the exact same
 * native revision arrive, so React can never render a new shell over an old
 * viewport (or vice versa). The monotonically increasing request token also
 * prevents a slow, older IPC response from replacing newer UI state.
 */
export class NativeFactoryThinViewStore {
  private snapshot: NativeFactoryThinViewSnapshot = EMPTY_SNAPSHOT;
  private requestToken = 0;
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): NativeFactoryThinViewSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  clear(): void {
    this.requestToken += 1;
    this.publish(EMPTY_SNAPSHOT);
  }

  async refresh(
    source: NativeFactoryThinViewSource,
    request: NativeFactoryThinViewRequest,
  ): Promise<NativeFactoryThinViewRefreshResult> {
    if (!isValidRevision(request.expectedRevision) || !isValidAuthoritySessionId(request.authoritySessionId) ||
      !isValidAuthorityRunId(request.authorityRunId) ||
      ((request.authoritySessionId === null || request.authoritySessionId === undefined) !==
        (request.authorityRunId === null || request.authorityRunId === undefined))) {
      this.requestToken += 1;
      this.publish(Object.freeze({
        status: "unavailable",
        requestedRevision: null,
        frame: null,
      }));
      return { status: "unavailable" };
    }

    const token = ++this.requestToken;
    const previousFrame = this.snapshot.frame;
    this.publish(Object.freeze({
      status: "loading",
      requestedRevision: request.expectedRevision,
      frame: previousFrame,
    }));

    const [factory, viewport] = await Promise.all([
      source.readVerifiedFactoryReadModel(request.factory, request.expectedRevision),
      readCompleteViewportProjection(source, request.viewport, request.expectedRevision),
    ]);

    if (token !== this.requestToken) return { status: "superseded" };
    if (!factory || !viewport || !frameMatchesRequest(request, factory, viewport)) {
      this.publish(Object.freeze({
        status: "unavailable",
        requestedRevision: request.expectedRevision,
        frame: previousFrame,
      }));
      return { status: "unavailable" };
    }

    const frame: NativeFactoryThinViewFrame = Object.freeze({
      revision: request.expectedRevision,
      planetId: request.viewport.planetId,
      authoritySessionId: request.authoritySessionId ?? null,
      authorityRunId: request.authorityRunId ?? null,
      factory,
      viewport,
    });
    this.publish(Object.freeze({
      status: "ready",
      requestedRevision: request.expectedRevision,
      frame,
    }));
    return { status: "committed", frame };
  }

  private publish(next: NativeFactoryThinViewSnapshot): void {
    if (this.snapshot === next) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}
