import type {
  DesktopBridge,
  DesktopNativeCoreTechnologyProjectionResult,
} from "../desktop";
import type { NativeTechnologyWorkspaceFrame } from "./technologyWorkspaceReadModel";

export interface NativeTechnologyWorkspaceSnapshot {
  readonly status: "empty" | "loading" | "ready" | "unavailable";
  readonly requestedRevision: number | null;
  readonly frame: NativeTechnologyWorkspaceFrame | null;
}
export interface NativeTechnologyWorkspaceSource {
  readVerifiedTechnologyProjection(
    expectedRevision: number,
  ): Promise<DesktopNativeCoreTechnologyProjectionResult | null>;
}

const EMPTY_SNAPSHOT: NativeTechnologyWorkspaceSnapshot = Object.freeze({
  status: "empty",
  requestedRevision: null,
  frame: null,
});
const LOGICAL_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;

function validSessionId(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 128 && LOGICAL_ID_PATTERN.test(value);
}

export function createNativePlayerAuthorityTechnologyProjectionSource(
  bridge: Pick<DesktopBridge, "getNativeCoreTechnologyProjection"> | null,
  sessionId: string,
): NativeTechnologyWorkspaceSource | null {
  if (!bridge || !validSessionId(sessionId) || typeof bridge.getNativeCoreTechnologyProjection !== "function") return null;
  return Object.freeze({
    async readVerifiedTechnologyProjection(expectedRevision: number) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return null;
      try {
        const result = await bridge.getNativeCoreTechnologyProjection({ sessionId, expectedRevision });
        return result.revision === expectedRevision ? result : null;
      } catch {
        return null;
      }
    },
  });
}

export class NativeTechnologyWorkspaceStore {
  private snapshot: NativeTechnologyWorkspaceSnapshot = EMPTY_SNAPSHOT;
  private requestToken = 0;
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): NativeTechnologyWorkspaceSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  clear(): void {
    this.requestToken += 1;
    this.publish(EMPTY_SNAPSHOT);
  }

  async refresh(
    source: NativeTechnologyWorkspaceSource,
    sessionId: string,
    expectedRevision: number,
  ): Promise<"committed" | "superseded" | "unavailable"> {
    if (!validSessionId(sessionId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      this.requestToken += 1;
      this.publish(Object.freeze({ status: "unavailable", requestedRevision: null, frame: null }));
      return "unavailable";
    }
    const token = ++this.requestToken;
    const previousFrame = this.snapshot.frame;
    this.publish(Object.freeze({ status: "loading", requestedRevision: expectedRevision, frame: previousFrame }));
    const projection = await source.readVerifiedTechnologyProjection(expectedRevision);
    if (token !== this.requestToken) return "superseded";
    if (!projection || projection.schemaVersion !== 1 || projection.projectionType !== "technology-v1" ||
      projection.revision !== expectedRevision) {
      this.publish(Object.freeze({ status: "unavailable", requestedRevision: expectedRevision, frame: previousFrame }));
      return "unavailable";
    }
    const frame: NativeTechnologyWorkspaceFrame = Object.freeze({
      sessionId,
      revision: expectedRevision,
      projection,
    });
    this.publish(Object.freeze({ status: "ready", requestedRevision: expectedRevision, frame }));
    return "committed";
  }

  private publish(next: NativeTechnologyWorkspaceSnapshot): void {
    if (this.snapshot === next) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}
