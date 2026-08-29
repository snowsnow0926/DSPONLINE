import type { DesktopBridge } from "../desktop";

export const NATIVE_FACTORY_INVENTORY_PAGE_ROWS = 256 as const;
export const NATIVE_FACTORY_INVENTORY_MAX_ROWS = 65_536 as const;
const NATIVE_FACTORY_INVENTORY_MAX_PAGES = NATIVE_FACTORY_INVENTORY_MAX_ROWS /
  NATIVE_FACTORY_INVENTORY_PAGE_ROWS;
const LOGICAL_ID = /^[A-Za-z0-9_.:-]+$/;
const PORTABLE_FLEET_ITEM_IDS = ["logistics_drone", "logistics_vessel"] as const;
const UTF8_ENCODER = new TextEncoder();

export interface NativeFactoryInventoryCargoOrigin {
  readonly kind: "node-output" | "node-input" | "tray";
  readonly id: string | null;
}

export interface NativeFactoryInventoryCargo {
  readonly itemId: string;
  readonly amount: number;
  readonly origin: NativeFactoryInventoryCargoOrigin | null;
}

export interface NativeFactoryInventoryRow {
  readonly itemId: string;
  readonly amount: number;
  readonly freeCapacity: number;
  readonly overLimit: boolean;
}

export interface NativeFactoryInventoryProjection {
  readonly schemaVersion: 1;
  readonly projectionType: "factory-inventory-v1";
  readonly source: "native-core";
  readonly revision: number;
  readonly stateVersion: number;
  readonly registryFingerprint: string;
  readonly activePlanetId: string;
  readonly cargo: NativeFactoryInventoryCargo | null;
  readonly pickupTargetAmount: number;
  readonly portableFleet: Readonly<Record<(typeof PORTABLE_FLEET_ITEM_IDS)[number], number>>;
  readonly trayItemLimit: number;
  readonly trayItemLimitBounds: {
    readonly minimum: number;
    readonly default: number;
    readonly maximum: number;
  };
  readonly request: {
    readonly expectedRevision: number;
    readonly cursor: number;
    readonly limit: number;
  };
  readonly totalCount: number;
  readonly rows: readonly NativeFactoryInventoryRow[];
  readonly nextCursor: number | null;
  readonly truncated: boolean;
  readonly limits: { readonly rows: number; readonly projectionBytes: number };
}

export interface NativeFactoryInventoryIdentity {
  readonly sessionId: string;
  readonly runId: string;
  readonly revision: number;
  readonly registryFingerprint: string;
}

export interface NativeFactoryInventorySource {
  readonly boundIdentity: NativeFactoryInventoryIdentity;
  readVerifiedFactoryInventory(
    cursor: number,
    limit: number,
    expectedRevision: number,
  ): Promise<NativeFactoryInventoryProjection | null>;
}

export interface NativeFactoryInventoryFrame extends NativeFactoryInventoryIdentity {
  readonly source: "native-core";
  readonly activePlanetId: string;
  readonly cargo: NativeFactoryInventoryCargo | null;
  readonly pickupTargetAmount: number;
  readonly portableFleet: NativeFactoryInventoryProjection["portableFleet"];
  readonly trayItemLimit: number;
  readonly trayItemLimitBounds: NativeFactoryInventoryProjection["trayItemLimitBounds"];
  readonly rows: readonly NativeFactoryInventoryRow[];
  readonly rowsByItemId: ReadonlyMap<string, NativeFactoryInventoryRow>;
}

export interface NativeFactoryInventorySnapshot {
  readonly status: "empty" | "loading" | "ready" | "unavailable";
  readonly requestedRevision: number | null;
  readonly frame: NativeFactoryInventoryFrame | null;
}

export type NativeFactoryInventoryRefreshResult = "committed" | "superseded" | "unavailable";

const EMPTY_SNAPSHOT: NativeFactoryInventorySnapshot = Object.freeze({
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

function validIdentity(identity: NativeFactoryInventoryIdentity): boolean {
  return validLogicalId(identity.sessionId, 128) && validLogicalId(identity.runId, 128) &&
    Number.isSafeInteger(identity.revision) && identity.revision >= 0 &&
    validLogicalId(identity.registryFingerprint);
}

function sameIdentity(left: NativeFactoryInventoryIdentity, right: NativeFactoryInventoryIdentity): boolean {
  return left.sessionId === right.sessionId && left.runId === right.runId &&
    left.revision === right.revision && left.registryFingerprint === right.registryFingerprint;
}

function identityKey(identity: NativeFactoryInventoryIdentity): string {
  return `${identity.sessionId}\0${identity.runId}\0${identity.revision}\0${identity.registryFingerprint}`;
}

function safeNonnegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
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

function validProjectionPage(
  page: NativeFactoryInventoryProjection,
  identity: NativeFactoryInventoryIdentity,
  cursor: number,
): boolean {
  if (page.schemaVersion !== 1 || page.projectionType !== "factory-inventory-v1" ||
      page.source !== "native-core" || page.stateVersion !== 47 ||
      page.revision !== identity.revision || page.registryFingerprint !== identity.registryFingerprint ||
      !validOpaqueId(page.activePlanetId) || page.pickupTargetAmount !== 100 ||
      page.request.expectedRevision !== identity.revision || page.request.cursor !== cursor ||
      page.request.limit !== NATIVE_FACTORY_INVENTORY_PAGE_ROWS ||
      page.limits.rows !== NATIVE_FACTORY_INVENTORY_PAGE_ROWS || page.limits.projectionBytes !== 1_048_576 ||
      !safeNonnegativeInteger(page.totalCount) || page.totalCount > NATIVE_FACTORY_INVENTORY_MAX_ROWS ||
      !Array.isArray(page.rows) || page.rows.length > NATIVE_FACTORY_INVENTORY_PAGE_ROWS ||
      page.truncated !== (page.nextCursor !== null) ||
      !safeNonnegativeInteger(page.trayItemLimit) ||
      page.trayItemLimitBounds.minimum !== 1_000 || page.trayItemLimitBounds.default !== 1_000_000 ||
      page.trayItemLimitBounds.maximum !== 100_000_000 ||
      page.trayItemLimit < page.trayItemLimitBounds.minimum ||
      page.trayItemLimit > page.trayItemLimitBounds.maximum ||
      !safeNonnegativeInteger(page.portableFleet.logistics_drone) ||
      !safeNonnegativeInteger(page.portableFleet.logistics_vessel)) return false;
  if (page.rows.length !== Math.min(page.request.limit, page.totalCount - cursor)) return false;
  if (page.cargo !== null && (!validOpaqueId(page.cargo.itemId) ||
      !Number.isSafeInteger(page.cargo.amount) || page.cargo.amount < 1 ||
      page.cargo.origin !== null && (!validLogicalId(page.cargo.origin.kind, 32) ||
        !["node-output", "node-input", "tray"].includes(page.cargo.origin.kind) ||
        page.cargo.origin.id !== null && !validOpaqueId(page.cargo.origin.id)))) return false;
  let previousId: string | null = null;
  for (const row of page.rows) {
    if (!validOpaqueId(row.itemId) || !Number.isSafeInteger(row.amount) || row.amount < 1 ||
        !safeNonnegativeInteger(row.freeCapacity) || row.freeCapacity !== Math.max(0, page.trayItemLimit - row.amount) ||
        row.overLimit !== (row.amount > page.trayItemLimit) ||
        previousId !== null && compareUtf8(previousId, row.itemId) >= 0) return false;
    previousId = row.itemId;
  }
  const consumed = cursor + page.rows.length;
  if (!Number.isSafeInteger(consumed) || consumed > page.totalCount) return false;
  return page.nextCursor === null
    ? consumed === page.totalCount
    : page.nextCursor === consumed && consumed < page.totalCount;
}

function sameHeader(left: NativeFactoryInventoryProjection, right: NativeFactoryInventoryProjection): boolean {
  return left.revision === right.revision && left.registryFingerprint === right.registryFingerprint &&
    left.activePlanetId === right.activePlanetId && left.pickupTargetAmount === right.pickupTargetAmount &&
    left.trayItemLimit === right.trayItemLimit && left.totalCount === right.totalCount &&
    JSON.stringify(left.cargo) === JSON.stringify(right.cargo) &&
    JSON.stringify(left.portableFleet) === JSON.stringify(right.portableFleet) &&
    JSON.stringify(left.trayItemLimitBounds) === JSON.stringify(right.trayItemLimitBounds);
}

export function createNativePlayerAuthorityFactoryInventorySource(
  bridge: Pick<DesktopBridge, "getNativeCoreFactoryInventory"> | null,
  identity: NativeFactoryInventoryIdentity,
): NativeFactoryInventorySource | null {
  const reader = bridge?.getNativeCoreFactoryInventory;
  if (typeof reader !== "function" || !validIdentity(identity)) return null;
  const boundIdentity = Object.freeze({ ...identity });
  return Object.freeze({
    boundIdentity,
    async readVerifiedFactoryInventory(cursor: number, limit: number, expectedRevision: number) {
      if (expectedRevision !== boundIdentity.revision || !Number.isSafeInteger(cursor) || cursor < 0 ||
          cursor > NATIVE_FACTORY_INVENTORY_MAX_ROWS || limit !== NATIVE_FACTORY_INVENTORY_PAGE_ROWS) return null;
      try {
        const page = await reader({
          sessionId: boundIdentity.sessionId,
          expectedRevision,
          cursor,
          limit,
        });
        return validProjectionPage(page, boundIdentity, cursor) ? page : null;
      } catch {
        return null;
      }
    },
  });
}

export function selectNativeFactoryInventoryFrame(
  snapshot: NativeFactoryInventorySnapshot,
  identity: NativeFactoryInventoryIdentity,
): NativeFactoryInventoryFrame | null {
  return snapshot.status === "ready" && snapshot.frame && sameIdentity(snapshot.frame, identity)
    ? snapshot.frame
    : null;
}

export class NativeFactoryInventoryStore {
  private snapshot: NativeFactoryInventorySnapshot = EMPTY_SNAPSHOT;
  private token = 0;
  private currentIdentityKey: string | null = null;
  private flight: { key: string; promise: Promise<NativeFactoryInventoryRefreshResult> } | null = null;
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): NativeFactoryInventorySnapshot => this.snapshot;

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
    source: NativeFactoryInventorySource,
    identity: NativeFactoryInventoryIdentity,
  ): Promise<NativeFactoryInventoryRefreshResult> {
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
    source: NativeFactoryInventorySource,
    identity: NativeFactoryInventoryIdentity,
    token: number,
    previous: NativeFactoryInventoryFrame | null,
  ): Promise<NativeFactoryInventoryRefreshResult> {
    let cursor = 0;
    let first: NativeFactoryInventoryProjection | null = null;
    const rows: NativeFactoryInventoryRow[] = [];
    for (let pageIndex = 0; pageIndex < NATIVE_FACTORY_INVENTORY_MAX_PAGES; pageIndex += 1) {
      let page: NativeFactoryInventoryProjection | null;
      try {
        page = await source.readVerifiedFactoryInventory(
          cursor,
          NATIVE_FACTORY_INVENTORY_PAGE_ROWS,
          identity.revision,
        );
      } catch {
        return this.fail(identity, token, previous);
      }
      if (token !== this.token) return "superseded";
      let valid = false;
      try {
        valid = Boolean(page) && validProjectionPage(page!, identity, cursor) &&
          (!first || sameHeader(first, page!));
      } catch {
        valid = false;
      }
      if (!page || !valid) {
        return this.fail(identity, token, previous);
      }
      first ??= page;
      const previousItemId = rows.at(-1)?.itemId ?? null;
      if (previousItemId !== null && page.rows.length > 0 && compareUtf8(previousItemId, page.rows[0].itemId) >= 0) {
        return this.fail(identity, token, previous);
      }
      rows.push(...page.rows);
      if (rows.length > NATIVE_FACTORY_INVENTORY_MAX_ROWS) return this.fail(identity, token, previous);
      if (page.nextCursor === null) {
        if (rows.length !== page.totalCount) return this.fail(identity, token, previous);
        const rowsByItemId = new Map<string, NativeFactoryInventoryRow>();
        for (const row of rows) {
          if (rowsByItemId.has(row.itemId)) return this.fail(identity, token, previous);
          rowsByItemId.set(row.itemId, row);
        }
        const frame: NativeFactoryInventoryFrame = Object.freeze({
          source: "native-core" as const,
          ...identity,
          activePlanetId: first.activePlanetId,
          cargo: first.cargo,
          pickupTargetAmount: first.pickupTargetAmount,
          portableFleet: Object.freeze({ ...first.portableFleet }),
          trayItemLimit: first.trayItemLimit,
          trayItemLimitBounds: Object.freeze({ ...first.trayItemLimitBounds }),
          rows: Object.freeze([...rows]),
          rowsByItemId,
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
    identity: NativeFactoryInventoryIdentity,
    token: number,
    previous: NativeFactoryInventoryFrame | null,
  ): NativeFactoryInventoryRefreshResult {
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

  private publish(next: NativeFactoryInventorySnapshot): void {
    if (this.snapshot === next) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}
