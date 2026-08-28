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

export interface NativeCommandPaletteEntitySearchSource {
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

export function createNativePlayerAuthorityCommandPaletteEntitySearchSource(
  bridge: Pick<DesktopBridge, "getNativeCoreCommandPaletteEntitySearch"> | null,
  sessionId: string,
): NativeCommandPaletteEntitySearchSource | null {
  const readProjection = bridge?.getNativeCoreCommandPaletteEntitySearch;
  if (!validLogicalId(sessionId, 128) || typeof readProjection !== "function") return null;
  return Object.freeze({
    async readVerifiedCommandPaletteEntitySearch(
      expectedRevision: number,
      expectedRegistryFingerprint: string,
      selector: CommandPaletteEntitySearchSelector,
    ) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
          !validLogicalId(expectedRegistryFingerprint) ||
          !validCommandPaletteEntitySearchSelector(selector)) return null;
      try {
        const result = await readProjection({
          sessionId,
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

export class NativeCommandPaletteEntitySearchStore {
  private snapshot: NativeCommandPaletteEntitySearchSnapshot = EMPTY_SNAPSHOT;
  private requestToken = 0;
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): NativeCommandPaletteEntitySearchSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  clear(): void {
    this.requestToken += 1;
    this.publish(EMPTY_SNAPSHOT);
  }

  markTruncated(expectedRevision: number): void {
    this.requestToken += 1;
    this.publish(Object.freeze({ status: "truncated", requestedRevision: expectedRevision, frame: null }));
  }

  markUnavailable(expectedRevision: number): void {
    this.requestToken += 1;
    this.publish(Object.freeze({ status: "unavailable", requestedRevision: expectedRevision, frame: null }));
  }

  async refresh(
    source: NativeCommandPaletteEntitySearchSource,
    sessionId: string,
    expectedRevision: number,
    expectedRegistryFingerprint: string,
    selector: CommandPaletteEntitySearchSelector,
  ): Promise<"committed" | "superseded" | "unavailable" | "truncated"> {
    if (selector.truncated) {
      this.markTruncated(expectedRevision);
      return "truncated";
    }
    if (!validLogicalId(sessionId, 128) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
        !validLogicalId(expectedRegistryFingerprint) || !validCommandPaletteEntitySearchSelector(selector)) {
      this.requestToken += 1;
      this.publish(Object.freeze({ status: "unavailable", requestedRevision: expectedRevision, frame: null }));
      return "unavailable";
    }
    const token = ++this.requestToken;
    this.publish(Object.freeze({ status: "loading", requestedRevision: expectedRevision, frame: null }));
    let projection: DesktopNativeCoreCommandPaletteEntitySearchResult | null;
    try {
      projection = await source.readVerifiedCommandPaletteEntitySearch(
        expectedRevision,
        expectedRegistryFingerprint,
        selector,
      );
    } catch {
      if (token !== this.requestToken) return "superseded";
      this.publish(Object.freeze({ status: "unavailable", requestedRevision: expectedRevision, frame: null }));
      return "unavailable";
    }
    if (token !== this.requestToken) return "superseded";
    if (!projection || projection.schemaVersion !== 1 ||
        projection.projectionType !== "command-palette-entity-search-v1" ||
        projection.revision !== expectedRevision ||
        projection.registryFingerprint !== expectedRegistryFingerprint) {
      this.publish(Object.freeze({ status: "unavailable", requestedRevision: expectedRevision, frame: null }));
      return "unavailable";
    }
    const frame: NativeCommandPaletteEntitySearchFrame = Object.freeze({
      sessionId,
      revision: expectedRevision,
      selector,
      projection,
    });
    this.publish(Object.freeze({ status: "ready", requestedRevision: expectedRevision, frame }));
    return "committed";
  }

  private publish(next: NativeCommandPaletteEntitySearchSnapshot): void {
    if (this.snapshot === next) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}
