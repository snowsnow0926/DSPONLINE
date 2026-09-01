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
export interface NativeTechnologyWorkspaceIdentity {
  readonly sessionId: string;
  readonly runId: string;
  readonly revision: number;
  readonly registryFingerprint: string;
}
export interface NativeTechnologyWorkspaceSource {
  readonly boundIdentity: NativeTechnologyWorkspaceIdentity;
  readVerifiedTechnologyProjection(): Promise<DesktopNativeCoreTechnologyProjectionResult | null>;
}

export type NativeTechnologyWorkspaceRefreshResult = "committed" | "superseded" | "unavailable";

const EMPTY_SNAPSHOT: NativeTechnologyWorkspaceSnapshot = Object.freeze({
  status: "empty",
  requestedRevision: null,
  frame: null,
});
const LOGICAL_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;

function validLogicalId(value: string | null | undefined, maximum = 128): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum && LOGICAL_ID_PATTERN.test(value);
}

function validIdentity(identity: NativeTechnologyWorkspaceIdentity): boolean {
  return validLogicalId(identity.sessionId) && validLogicalId(identity.runId) &&
    Number.isSafeInteger(identity.revision) && identity.revision >= 0 &&
    validLogicalId(identity.registryFingerprint, 256);
}

function sameScope(
  left: NativeTechnologyWorkspaceIdentity,
  right: NativeTechnologyWorkspaceIdentity,
): boolean {
  return left.sessionId === right.sessionId && left.runId === right.runId &&
    left.registryFingerprint === right.registryFingerprint;
}

function exactIdentity(
  left: NativeTechnologyWorkspaceIdentity,
  right: NativeTechnologyWorkspaceIdentity,
): boolean {
  return sameScope(left, right) && left.revision === right.revision;
}

function identityKey(identity: NativeTechnologyWorkspaceIdentity): string {
  return `${identity.sessionId}\u0000${identity.runId}\u0000${identity.revision}\u0000${identity.registryFingerprint}`;
}

export function createNativePlayerAuthorityTechnologyProjectionSource(
  bridge: Pick<DesktopBridge, "getNativeCoreTechnologyProjection"> | null,
  identity: NativeTechnologyWorkspaceIdentity,
): NativeTechnologyWorkspaceSource | null {
  if (!bridge || !validIdentity(identity) || typeof bridge.getNativeCoreTechnologyProjection !== "function") return null;
  const boundIdentity = Object.freeze({ ...identity });
  return Object.freeze({
    boundIdentity,
    async readVerifiedTechnologyProjection() {
      try {
        const result = await bridge.getNativeCoreTechnologyProjection({
          sessionId: boundIdentity.sessionId,
          runId: boundIdentity.runId,
          expectedRevision: boundIdentity.revision,
          expectedRegistryFingerprint: boundIdentity.registryFingerprint,
        });
        return result.schemaVersion === 1 && result.projectionType === "technology-v1" &&
          result.revision === boundIdentity.revision ? result : null;
      } catch {
        return null;
      }
    },
  });
}

export function selectNativeTechnologyWorkspaceFrame(
  snapshot: NativeTechnologyWorkspaceSnapshot,
  identity: NativeTechnologyWorkspaceIdentity,
): NativeTechnologyWorkspaceFrame | null {
  const frame = snapshot.frame;
  if (!frame || !sameScope(frame, identity) || frame.revision > identity.revision ||
      snapshot.requestedRevision !== null && identity.revision < snapshot.requestedRevision) return null;
  if (snapshot.status === "ready" && frame.revision === identity.revision) return frame;
  return snapshot.status === "ready" || snapshot.status === "loading" || snapshot.status === "unavailable"
    ? frame
    : null;
}

export class NativeTechnologyWorkspaceStore {
  private snapshot: NativeTechnologyWorkspaceSnapshot = EMPTY_SNAPSHOT;
  private requestToken = 0;
  private currentKey: string | null = null;
  private flight: {
    readonly key: string;
    readonly promise: Promise<NativeTechnologyWorkspaceRefreshResult>;
  } | null = null;
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): NativeTechnologyWorkspaceSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  clear(): void {
    this.requestToken += 1;
    this.currentKey = null;
    this.flight = null;
    this.publish(EMPTY_SNAPSHOT);
  }

  refresh(
    source: NativeTechnologyWorkspaceSource,
    identity: NativeTechnologyWorkspaceIdentity,
  ): Promise<NativeTechnologyWorkspaceRefreshResult> {
    if (!validIdentity(identity) || !exactIdentity(source.boundIdentity, identity)) {
      this.clear();
      return Promise.resolve("unavailable");
    }
    const key = identityKey(identity);
    if (this.flight?.key === key) return this.flight.promise;
    if (this.snapshot.status === "ready" && this.snapshot.frame && exactIdentity(this.snapshot.frame, identity)) {
      return Promise.resolve("committed");
    }
    const token = ++this.requestToken;
    this.currentKey = key;
    const previousFrame = this.snapshot.frame && sameScope(this.snapshot.frame, identity) &&
        this.snapshot.frame.revision <= identity.revision &&
        identity.revision >= (this.snapshot.requestedRevision ?? this.snapshot.frame.revision)
      ? this.snapshot.frame
      : null;
    this.publish(Object.freeze({ status: "loading", requestedRevision: identity.revision, frame: previousFrame }));
    const promise = this.performRefresh(source, identity, key, token);
    this.flight = { key, promise };
    void promise.finally(() => {
      if (this.flight?.promise === promise) this.flight = null;
    });
    return promise;
  }

  private async performRefresh(
    source: NativeTechnologyWorkspaceSource,
    identity: NativeTechnologyWorkspaceIdentity,
    key: string,
    token: number,
  ): Promise<NativeTechnologyWorkspaceRefreshResult> {
    const projection = await source.readVerifiedTechnologyProjection();
    if (token !== this.requestToken || key !== this.currentKey) return "superseded";
    if (!projection || projection.schemaVersion !== 1 || projection.projectionType !== "technology-v1" ||
      projection.revision !== identity.revision) {
      this.publish(Object.freeze({
        status: "unavailable",
        requestedRevision: identity.revision,
        frame: this.snapshot.frame,
      }));
      return "unavailable";
    }
    const frame: NativeTechnologyWorkspaceFrame = Object.freeze({
      ...identity,
      projection,
    });
    this.publish(Object.freeze({ status: "ready", requestedRevision: identity.revision, frame }));
    return "committed";
  }

  private publish(next: NativeTechnologyWorkspaceSnapshot): void {
    if (this.snapshot === next) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}
