import type {
  DesktopNativeCoreFactoryReadModelRequest,
  DesktopNativeCoreFactoryReadModelResult,
  DesktopNativeCoreViewportProjectionV2Request,
  DesktopNativeCoreViewportProjectionV2Result,
} from "../desktop";

export interface NativeFactoryThinViewFrame {
  readonly revision: number;
  readonly planetId: string;
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

function isValidRevision(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

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
    viewport.planetId === planetId;
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
    if (!isValidRevision(request.expectedRevision)) {
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
      source.readVerifiedViewportProjectionV2(request.viewport, request.expectedRevision),
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
