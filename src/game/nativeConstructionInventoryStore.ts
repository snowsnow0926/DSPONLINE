export const NATIVE_CONSTRUCTION_INVENTORY_PAGE_ROWS = 256 as const;
export const NATIVE_CONSTRUCTION_INVENTORY_MAX_ROWS = 65_536 as const;
const NATIVE_CONSTRUCTION_INVENTORY_MAX_PAGES = NATIVE_CONSTRUCTION_INVENTORY_MAX_ROWS /
  NATIVE_CONSTRUCTION_INVENTORY_PAGE_ROWS;
const LOGICAL_ID = /^[A-Za-z0-9_.:-]+$/;
const UTF8_ENCODER = new TextEncoder();

export interface NativeConstructionInventoryRow {
  readonly buildingId: string;
  readonly amount: number;
}

export interface NativeConstructionInventoryProjection {
  readonly schemaVersion: 1;
  readonly projectionType: "construction-inventory-v1";
  readonly source: "native-core";
  readonly revision: number;
  readonly stateVersion: 47;
  readonly registryFingerprint: string;
  readonly readOnly: true;
  readonly request: {
    readonly expectedRevision: number;
    readonly expectedRegistryFingerprint: string;
    readonly cursor: number;
    readonly limit: number;
  };
  readonly totalCount: number;
  readonly rows: readonly NativeConstructionInventoryRow[];
  readonly nextCursor: number | null;
  readonly truncated: boolean;
  readonly limits: {
    readonly rows: number;
    readonly projectionBytes: number;
  };
}

export interface NativeConstructionInventoryIdentity {
  readonly sessionId: string;
  readonly runId: string;
  readonly revision: number;
  readonly registryFingerprint: string;
}

export interface NativeConstructionInventorySource {
  readonly boundIdentity: NativeConstructionInventoryIdentity;
  readVerifiedConstructionInventory(
    cursor: number,
    limit: number,
    expectedRevision: number,
    expectedRegistryFingerprint: string,
  ): Promise<NativeConstructionInventoryProjection | null>;
}

export interface NativeConstructionInventoryFrame extends NativeConstructionInventoryIdentity {
  readonly source: "native-core";
  readonly readOnly: true;
  readonly rows: readonly NativeConstructionInventoryRow[];
  readonly rowsByBuildingId: ReadonlyMap<string, NativeConstructionInventoryRow>;
  readonly totalAmount: number;
}

export interface NativeConstructionInventorySnapshot {
  readonly status: "empty" | "loading" | "ready" | "unavailable";
  readonly requestedRevision: number | null;
  readonly frame: NativeConstructionInventoryFrame | null;
}

export type NativeConstructionInventoryRefreshResult = "committed" | "superseded" | "unavailable";

const EMPTY_SNAPSHOT: NativeConstructionInventorySnapshot = Object.freeze({
  status: "empty",
  requestedRevision: null,
  frame: null,
});

function validLogicalId(value: string, maximumLength = 256): boolean {
  return value.length > 0 && value.length <= maximumLength && LOGICAL_ID.test(value);
}

function validOpaqueId(value: string, maximumBytes = 512): boolean {
  return value.length > 0 && UTF8_ENCODER.encode(value).byteLength <= maximumBytes &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function safeNonnegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function sameIdentity(
  left: NativeConstructionInventoryIdentity,
  right: NativeConstructionInventoryIdentity,
): boolean {
  return left.sessionId === right.sessionId && left.runId === right.runId &&
    left.revision === right.revision && left.registryFingerprint === right.registryFingerprint;
}

function validIdentity(identity: NativeConstructionInventoryIdentity): boolean {
  return validLogicalId(identity.sessionId, 128) && validLogicalId(identity.runId, 128) &&
    safeNonnegativeInteger(identity.revision) && validLogicalId(identity.registryFingerprint);
}

function identityKey(identity: NativeConstructionInventoryIdentity): string {
  return `${identity.sessionId}\0${identity.runId}\0${identity.revision}\0${identity.registryFingerprint}`;
}

function compareUtf8(left: string, right: string): number {
  const leftBytes = UTF8_ENCODER.encode(left);
  const rightBytes = UTF8_ENCODER.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const delta = leftBytes[index] - rightBytes[index];
    if (delta !== 0) return delta;
  }
  return leftBytes.length - rightBytes.length;
}

function validPage(
  page: NativeConstructionInventoryProjection,
  identity: NativeConstructionInventoryIdentity,
  cursor: number,
): boolean {
  if (page.schemaVersion !== 1 || page.projectionType !== "construction-inventory-v1" ||
      page.source !== "native-core" || page.stateVersion !== 47 || page.readOnly !== true ||
      page.revision !== identity.revision || page.registryFingerprint !== identity.registryFingerprint ||
      page.request.expectedRevision !== identity.revision ||
      page.request.expectedRegistryFingerprint !== identity.registryFingerprint ||
      page.request.cursor !== cursor || page.request.limit !== NATIVE_CONSTRUCTION_INVENTORY_PAGE_ROWS ||
      page.limits.rows !== NATIVE_CONSTRUCTION_INVENTORY_PAGE_ROWS ||
      page.limits.projectionBytes !== 1_048_576 || !safeNonnegativeInteger(page.totalCount) ||
      page.totalCount > NATIVE_CONSTRUCTION_INVENTORY_MAX_ROWS || !Array.isArray(page.rows) ||
      page.rows.length !== Math.min(page.request.limit, page.totalCount - cursor) ||
      page.truncated !== (page.nextCursor !== null)) return false;
  let previousId: string | null = null;
  for (const row of page.rows) {
    if (!validOpaqueId(row.buildingId) || !Number.isSafeInteger(row.amount) || row.amount < 1 ||
        previousId !== null && compareUtf8(previousId, row.buildingId) >= 0) return false;
    previousId = row.buildingId;
  }
  const consumed = cursor + page.rows.length;
  if (!Number.isSafeInteger(consumed) || consumed > page.totalCount) return false;
  return page.nextCursor === null
    ? consumed === page.totalCount
    : page.nextCursor === consumed && consumed < page.totalCount;
}

function sameHeader(
  left: NativeConstructionInventoryProjection,
  right: NativeConstructionInventoryProjection,
): boolean {
  return left.revision === right.revision &&
    left.registryFingerprint === right.registryFingerprint &&
    left.stateVersion === right.stateVersion && left.readOnly === right.readOnly &&
    left.totalCount === right.totalCount;
}

export function createNativePlayerAuthorityConstructionInventorySource(
  bridge: Pick<DesktopBridge, "getNativeCoreConstructionInventory"> | null,
  identity: NativeConstructionInventoryIdentity,
): NativeConstructionInventorySource | null {
  const reader = bridge?.getNativeCoreConstructionInventory;
  if (typeof reader !== "function" || !validIdentity(identity)) return null;
  const boundIdentity = Object.freeze({ ...identity });
  return Object.freeze({
    boundIdentity,
    async readVerifiedConstructionInventory(
      cursor: number,
      limit: number,
      expectedRevision: number,
      expectedRegistryFingerprint: string,
    ) {
      if (expectedRevision !== boundIdentity.revision ||
          expectedRegistryFingerprint !== boundIdentity.registryFingerprint ||
          !Number.isSafeInteger(cursor) || cursor < 0 ||
          cursor > NATIVE_CONSTRUCTION_INVENTORY_MAX_ROWS ||
          limit !== NATIVE_CONSTRUCTION_INVENTORY_PAGE_ROWS) return null;
      try {
        const page = await reader({
          sessionId: boundIdentity.sessionId,
          expectedRevision,
          expectedRegistryFingerprint,
          cursor,
          limit,
        });
        return validPage(page, boundIdentity, cursor) ? page : null;
      } catch {
        return null;
      }
    },
  });
}

export function selectNativeConstructionInventoryFrame(
  snapshot: NativeConstructionInventorySnapshot,
  identity: NativeConstructionInventoryIdentity,
): NativeConstructionInventoryFrame | null {
  return snapshot.status === "ready" && snapshot.frame && sameIdentity(snapshot.frame, identity)
    ? snapshot.frame
    : null;
}

export class NativeConstructionInventoryStore {
  private snapshot: NativeConstructionInventorySnapshot = EMPTY_SNAPSHOT;
  private token = 0;
  private currentIdentityKey: string | null = null;
  private flight: { key: string; promise: Promise<NativeConstructionInventoryRefreshResult> } | null = null;
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): NativeConstructionInventorySnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  clear(): void {
    this.token += 1;
    this.currentIdentityKey = null;
    this.flight = null;
    this.publish(EMPTY_SNAPSHOT);
  }

  refresh(
    source: NativeConstructionInventorySource,
    identity: NativeConstructionInventoryIdentity,
  ): Promise<NativeConstructionInventoryRefreshResult> {
    if (!validIdentity(identity) || !sameIdentity(source.boundIdentity, identity)) {
      this.invalidate();
      return Promise.resolve("unavailable");
    }
    const key = identityKey(identity);
    if (this.currentIdentityKey !== key) {
      this.token += 1;
      this.flight = null;
      this.currentIdentityKey = key;
      this.publish(EMPTY_SNAPSHOT);
    }
    if (this.flight?.key === key) return this.flight.promise;
    if (this.snapshot.status === "ready" && this.snapshot.frame && sameIdentity(this.snapshot.frame, identity)) {
      return Promise.resolve("committed");
    }
    const token = ++this.token;
    const previous = this.snapshot.frame;
    this.publish(Object.freeze({ status: "loading", requestedRevision: identity.revision, frame: previous }));
    const promise = this.performRefresh(source, identity, token, previous);
    this.flight = { key, promise };
    void promise.finally(() => {
      if (this.flight?.promise === promise) this.flight = null;
    });
    return promise;
  }

  private async performRefresh(
    source: NativeConstructionInventorySource,
    identity: NativeConstructionInventoryIdentity,
    token: number,
    previous: NativeConstructionInventoryFrame | null,
  ): Promise<NativeConstructionInventoryRefreshResult> {
    let cursor = 0;
    let first: NativeConstructionInventoryProjection | null = null;
    const rows: NativeConstructionInventoryRow[] = [];
    for (let pageIndex = 0; pageIndex < NATIVE_CONSTRUCTION_INVENTORY_MAX_PAGES; pageIndex += 1) {
      let page: NativeConstructionInventoryProjection | null;
      try {
        page = await source.readVerifiedConstructionInventory(
          cursor,
          NATIVE_CONSTRUCTION_INVENTORY_PAGE_ROWS,
          identity.revision,
          identity.registryFingerprint,
        );
      } catch {
        return this.fail(identity, token, previous);
      }
      if (token !== this.token) return "superseded";
      let valid = false;
      try {
        valid = Boolean(page) && validPage(page!, identity, cursor) && (!first || sameHeader(first, page!));
      } catch {
        valid = false;
      }
      if (!page || !valid) return this.fail(identity, token, previous);
      first ??= page;
      const previousBuildingId = rows.at(-1)?.buildingId ?? null;
      if (previousBuildingId !== null && page.rows.length > 0 &&
          compareUtf8(previousBuildingId, page.rows[0].buildingId) >= 0) {
        return this.fail(identity, token, previous);
      }
      rows.push(...page.rows);
      if (rows.length > NATIVE_CONSTRUCTION_INVENTORY_MAX_ROWS) return this.fail(identity, token, previous);
      if (page.nextCursor === null) {
        if (rows.length !== page.totalCount) return this.fail(identity, token, previous);
        const rowsByBuildingId = new Map<string, NativeConstructionInventoryRow>();
        let totalAmount = 0;
        for (const row of rows) {
          if (rowsByBuildingId.has(row.buildingId)) return this.fail(identity, token, previous);
          rowsByBuildingId.set(row.buildingId, row);
          totalAmount += row.amount;
          if (!Number.isSafeInteger(totalAmount)) return this.fail(identity, token, previous);
        }
        const frame: NativeConstructionInventoryFrame = Object.freeze({
          source: "native-core" as const,
          readOnly: true as const,
          ...identity,
          rows: Object.freeze([...rows]),
          rowsByBuildingId,
          totalAmount,
        });
        this.publish(Object.freeze({ status: "ready", requestedRevision: identity.revision, frame }));
        return "committed";
      }
      if (page.nextCursor <= cursor) return this.fail(identity, token, previous);
      cursor = page.nextCursor;
    }
    return this.fail(identity, token, previous);
  }

  private fail(
    identity: NativeConstructionInventoryIdentity,
    token: number,
    previous: NativeConstructionInventoryFrame | null,
  ): NativeConstructionInventoryRefreshResult {
    if (token !== this.token) return "superseded";
    this.publish(Object.freeze({ status: "unavailable", requestedRevision: identity.revision, frame: previous }));
    return "unavailable";
  }

  private invalidate(): void {
    this.token += 1;
    this.flight = null;
    this.currentIdentityKey = null;
    this.publish(Object.freeze({ status: "unavailable", requestedRevision: null, frame: this.snapshot.frame }));
  }

  private publish(next: NativeConstructionInventorySnapshot): void {
    if (this.snapshot === next) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}
import type { DesktopBridge } from "../desktop";
