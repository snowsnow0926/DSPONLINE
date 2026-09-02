import type {
  DesktopBridge,
  DesktopNativeCoreCommandPaletteEntitySearchResult,
} from "../desktop";
import type {
  CommandPaletteEntitySearchSelector,
  NativeCommandPaletteEntitySearchFrame,
} from "./commandPaletteEntitySearchReadModel";
import {
  validCommandPaletteEntitySearchSelector,
} from "./commandPaletteEntitySearchReadModel";

export interface NativeCommandPaletteEntitySearchSnapshot {
  readonly status: "empty" | "loading" | "ready" | "unavailable" | "truncated";
  readonly requestedRevision: number | null;
  readonly frame: NativeCommandPaletteEntitySearchFrame | null;
}

export interface NativeCommandPaletteEntitySearchIdentity {
  readonly sessionId: string;
  readonly runId: string;
  readonly revision: number;
  readonly registryFingerprint: string;
}

export interface NativeCommandPaletteEntitySearchSource {
  readonly boundIdentity: NativeCommandPaletteEntitySearchIdentity;
  readVerifiedCommandPaletteEntitySearch(
    expectedRevision: number,
    expectedRegistryFingerprint: string,
    selector: CommandPaletteEntitySearchSelector,
  ): Promise<DesktopNativeCoreCommandPaletteEntitySearchResult | null>;
}

const LOGICAL_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const EMPTY_SNAPSHOT: NativeCommandPaletteEntitySearchSnapshot = Object.freeze({
  status: "empty",
  requestedRevision: null,
  frame: null,
});

function validLogicalId(value: string | null | undefined, maximum = 256): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum && LOGICAL_ID_PATTERN.test(value);
}

function exactIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function validIdentity(identity: NativeCommandPaletteEntitySearchIdentity): boolean {
  return validLogicalId(identity.sessionId, 128) && validLogicalId(identity.runId, 128) &&
    Number.isSafeInteger(identity.revision) && identity.revision >= 0 &&
    validLogicalId(identity.registryFingerprint);
}

function sameScope(
  left: NativeCommandPaletteEntitySearchIdentity,
  right: NativeCommandPaletteEntitySearchIdentity,
): boolean {
  return left.sessionId === right.sessionId && left.runId === right.runId &&
    left.registryFingerprint === right.registryFingerprint;
}

function exactIdentity(
  left: NativeCommandPaletteEntitySearchIdentity,
  right: NativeCommandPaletteEntitySearchIdentity,
): boolean {
  return sameScope(left, right) && left.revision === right.revision;
}

function selectorKey(selector: CommandPaletteEntitySearchSelector): string {
  return JSON.stringify([
    selector.query,
    selector.cursor,
    selector.limit,
    selector.buildingIds,
    selector.resourceIds,
    selector.planetIds,
    selector.truncated,
  ]);
}

function requestKey(
  identity: NativeCommandPaletteEntitySearchIdentity,
  selector: CommandPaletteEntitySearchSelector,
): string {
  return `${identity.sessionId}\u0000${identity.runId}\u0000${identity.revision}\u0000${identity.registryFingerprint}\u0000${selectorKey(selector)}`;
}

export function createNativePlayerAuthorityCommandPaletteEntitySearchSource(
  bridge: Pick<DesktopBridge, "getNativeCoreCommandPaletteEntitySearch"> | null,
  identity: NativeCommandPaletteEntitySearchIdentity,
): NativeCommandPaletteEntitySearchSource | null {
  const readProjection = bridge?.getNativeCoreCommandPaletteEntitySearch;
  if (!validIdentity(identity) || typeof readProjection !== "function") return null;
  const boundIdentity = Object.freeze({ ...identity });
  return Object.freeze({
    boundIdentity,
    async readVerifiedCommandPaletteEntitySearch(
      expectedRevision: number,
      expectedRegistryFingerprint: string,
      selector: CommandPaletteEntitySearchSelector,
    ) {
      if (expectedRevision !== boundIdentity.revision ||
          expectedRegistryFingerprint !== boundIdentity.registryFingerprint ||
          !validCommandPaletteEntitySearchSelector(selector)) return null;
      try {
        const result = await readProjection({
          sessionId: boundIdentity.sessionId,
          runId: boundIdentity.runId,
          expectedRevision,
          expectedRegistryFingerprint,
          query: selector.query,
          cursor: selector.cursor,
          limit: selector.limit,
          buildingIds: [...selector.buildingIds],
          resourceIds: [...selector.resourceIds],
          planetIds: [...selector.planetIds],
        });
        return result.revision === expectedRevision &&
          result.registryFingerprint === expectedRegistryFingerprint &&
          result.request.query === selector.query && result.request.cursor === selector.cursor &&
          result.request.limit === selector.limit &&
          exactIds(result.request.buildingIds, selector.buildingIds) &&
          exactIds(result.request.resourceIds, selector.resourceIds) &&
          exactIds(result.request.planetIds, selector.planetIds)
          ? result
          : null;
      } catch {
        return null;
      }
    },
  });
}

export function selectNativeCommandPaletteEntitySearchFrame(
  snapshot: NativeCommandPaletteEntitySearchSnapshot,
  identity: NativeCommandPaletteEntitySearchIdentity,
  selector: CommandPaletteEntitySearchSelector,
): NativeCommandPaletteEntitySearchFrame | null {
  const frame = snapshot.frame;
  if (!frame || !sameScope(frame, identity) || frame.revision > identity.revision ||
      snapshot.requestedRevision !== null && identity.revision < snapshot.requestedRevision ||
      !exactIds(frame.selector.buildingIds, selector.buildingIds) ||
      !exactIds(frame.selector.resourceIds, selector.resourceIds) ||
      !exactIds(frame.selector.planetIds, selector.planetIds) ||
      frame.selector.query !== selector.query || frame.selector.cursor !== selector.cursor ||
      frame.selector.limit !== selector.limit || frame.selector.truncated !== selector.truncated) return null;
  if (snapshot.status === "ready" && exactIdentity(frame, identity)) return frame;
  return snapshot.status === "ready" || snapshot.status === "loading" || snapshot.status === "unavailable"
    ? frame
    : null;
}

export class NativeCommandPaletteEntitySearchStore {
  private snapshot: NativeCommandPaletteEntitySearchSnapshot = EMPTY_SNAPSHOT;
  private requestToken = 0;
  private currentKey: string | null = null;
  private flight: {
    readonly key: string;
    readonly promise: Promise<"committed" | "superseded" | "unavailable" | "truncated">;
  } | null = null;
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): NativeCommandPaletteEntitySearchSnapshot => this.snapshot;

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

  markTruncated(
    identity: NativeCommandPaletteEntitySearchIdentity,
    selector: CommandPaletteEntitySearchSelector,
  ): void {
    this.requestToken += 1;
    this.currentKey = validIdentity(identity) ? requestKey(identity, selector) : null;
    this.flight = null;
    this.publish(Object.freeze({ status: "truncated", requestedRevision: identity.revision, frame: null }));
  }

  markUnavailable(
    identity: NativeCommandPaletteEntitySearchIdentity,
    selector: CommandPaletteEntitySearchSelector,
  ): void {
    this.requestToken += 1;
    this.currentKey = validIdentity(identity) ? requestKey(identity, selector) : null;
    this.flight = null;
    this.publish(Object.freeze({ status: "unavailable", requestedRevision: identity.revision, frame: null }));
  }

  refresh(
    source: NativeCommandPaletteEntitySearchSource,
    identity: NativeCommandPaletteEntitySearchIdentity,
    selector: CommandPaletteEntitySearchSelector,
  ): Promise<"committed" | "superseded" | "unavailable" | "truncated"> {
    if (selector.truncated) {
      this.markTruncated(identity, selector);
      return Promise.resolve("truncated");
    }
    if (!validIdentity(identity) || !exactIdentity(source.boundIdentity, identity) ||
        !validCommandPaletteEntitySearchSelector(selector)) {
      this.clear();
      return Promise.resolve("unavailable");
    }
    const key = requestKey(identity, selector);
    if (this.flight?.key === key) return this.flight.promise;
    if (this.currentKey === key && this.snapshot.status === "ready" && this.snapshot.frame &&
        exactIdentity(this.snapshot.frame, identity)) return Promise.resolve("committed");
    const token = ++this.requestToken;
    this.currentKey = key;
    const previous = this.snapshot.frame && sameScope(this.snapshot.frame, identity) &&
        this.snapshot.frame.revision <= identity.revision &&
        identity.revision >= (this.snapshot.requestedRevision ?? this.snapshot.frame.revision) &&
        selectorKey(this.snapshot.frame.selector) === selectorKey(selector)
      ? this.snapshot.frame
      : null;
    this.publish(Object.freeze({ status: "loading", requestedRevision: identity.revision, frame: previous }));
    const promise = this.performRefresh(source, identity, selector, key, token);
    this.flight = { key, promise };
    void promise.finally(() => {
      if (this.flight?.promise === promise) this.flight = null;
    });
    return promise;
  }

  private async performRefresh(
    source: NativeCommandPaletteEntitySearchSource,
    identity: NativeCommandPaletteEntitySearchIdentity,
    selector: CommandPaletteEntitySearchSelector,
    key: string,
    token: number,
  ): Promise<"committed" | "superseded" | "unavailable"> {
    let projection: DesktopNativeCoreCommandPaletteEntitySearchResult | null;
    try {
      projection = await source.readVerifiedCommandPaletteEntitySearch(
        identity.revision,
        identity.registryFingerprint,
        selector,
      );
    } catch {
      projection = null;
    }
    if (token !== this.requestToken || key !== this.currentKey) return "superseded";
    if (!projection || projection.schemaVersion !== 1 ||
        projection.projectionType !== "command-palette-entity-search-v1" ||
        projection.revision !== identity.revision ||
        projection.registryFingerprint !== identity.registryFingerprint) {
      this.publish(Object.freeze({
        status: "unavailable",
        requestedRevision: identity.revision,
        frame: this.snapshot.frame,
      }));
      return "unavailable";
    }
    const frame: NativeCommandPaletteEntitySearchFrame = Object.freeze({
      ...identity,
      selector,
      projection,
    });
    this.publish(Object.freeze({ status: "ready", requestedRevision: identity.revision, frame }));
    return "committed";
  }

  private publish(next: NativeCommandPaletteEntitySearchSnapshot): void {
    if (this.snapshot === next) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}
