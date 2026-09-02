import { describe, expect, it } from "vitest";
import {
  NATIVE_FACTORY_INVENTORY_PAGE_ROWS,
  NativeFactoryInventoryStore,
  selectNativeFactoryInventoryFrame,
  type NativeFactoryInventoryIdentity,
  type NativeFactoryInventoryProjection,
  type NativeFactoryInventorySource,
} from "./nativeFactoryInventoryStore";

const IDENTITY: NativeFactoryInventoryIdentity = Object.freeze({
  sessionId: "authority-session",
  runId: "authority-run",
  revision: 17,
  registryFingerprint: "builtin:test",
});

function page(
  cursor: number,
  itemIds: string[],
  totalCount = itemIds.length,
  overrides: Partial<NativeFactoryInventoryProjection> = {},
): NativeFactoryInventoryProjection {
  const rows = itemIds.map((itemId, index) => ({
    itemId,
    amount: cursor + index + 1,
    freeCapacity: 1_000_000 - cursor - index - 1,
    overLimit: false,
  }));
  const nextCursor = cursor + rows.length < totalCount ? cursor + rows.length : null;
  return {
    schemaVersion: 1,
    projectionType: "factory-inventory-v1",
    source: "native-core",
    revision: IDENTITY.revision,
    stateVersion: 47,
    registryFingerprint: IDENTITY.registryFingerprint,
    activePlanetId: "home",
    cargo: {
      itemId: "iron_ore",
      amount: 125,
      origin: { kind: "node-output", id: "source-node" },
    },
    pickupTargetAmount: 100,
    portableFleet: { logistics_drone: 3, logistics_vessel: 4 },
    productionBufferLimit: 1_000_000,
    trayItemLimit: 1_000_000,
    trayItemLimitBounds: { minimum: 1_000, default: 1_000_000, maximum: 100_000_000 },
    request: { expectedRevision: IDENTITY.revision, cursor, limit: NATIVE_FACTORY_INVENTORY_PAGE_ROWS },
    totalCount,
    rows,
    nextCursor,
    truncated: nextCursor !== null,
    limits: { rows: 256, projectionBytes: 1_048_576 },
    ...overrides,
  };
}

function source(reader: NativeFactoryInventorySource["readVerifiedFactoryInventory"]): NativeFactoryInventorySource {
  return { boundIdentity: IDENTITY, readVerifiedFactoryInventory: reader };
}

function inventoryIds(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `item-${String(index).padStart(5, "0")}`);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

describe("NativeFactoryInventoryStore", () => {
  it("publishes a complete same-revision page set and preserves oversized historical cargo", async () => {
    const calls: number[] = [];
    const itemIds = inventoryIds(257);
    const pages = [
      page(0, itemIds.slice(0, 256), itemIds.length),
      page(256, itemIds.slice(256), itemIds.length),
    ];
    const store = new NativeFactoryInventoryStore();
    await expect(store.refresh(source(async (cursor) => {
      calls.push(cursor);
      return pages.find((candidate) => candidate.request.cursor === cursor) ?? null;
    }), IDENTITY)).resolves.toBe("committed");

    expect(calls).toEqual([0, 256]);
    const frame = selectNativeFactoryInventoryFrame(store.getSnapshot(), IDENTITY);
    expect(frame?.rows.map((row) => row.itemId)).toEqual(itemIds);
    expect(frame?.cargo?.amount).toBe(125);
    expect(frame?.cargo?.origin).toEqual({ kind: "node-output", id: "source-node" });
    expect(frame?.portableFleet).toEqual({ logistics_drone: 3, logistics_vessel: 4 });
  });

  it("coalesces duplicate refreshes for the same authority identity", async () => {
    const pageDeferred = deferred<NativeFactoryInventoryProjection>();
    let reads = 0;
    const pending = source(() => {
      reads += 1;
      return pageDeferred.promise;
    });
    const store = new NativeFactoryInventoryStore();
    const first = store.refresh(pending, IDENTITY);
    const second = store.refresh(pending, IDENTITY);
    expect(first).toBe(second);
    pageDeferred.resolve(page(0, [], 0));
    await expect(first).resolves.toBe("committed");
    expect(reads).toBe(1);
  });

  it("retains only a same-lineage older frame for read-only display while R+1 settles", async () => {
    const store = new NativeFactoryInventoryStore();
    await expect(store.refresh(source(async () => page(0, ["iron_ore"], 1)), IDENTITY))
      .resolves.toBe("committed");
    const nextIdentity = { ...IDENTITY, revision: 18 };
    const pendingPage = deferred<NativeFactoryInventoryProjection | null>();
    const pending = store.refresh({
      boundIdentity: nextIdentity,
      readVerifiedFactoryInventory: () => pendingPage.promise,
    }, nextIdentity);

    expect(selectNativeFactoryInventoryFrame(store.getSnapshot(), nextIdentity)?.revision)
      .toBe(IDENTITY.revision);
    expect(selectNativeFactoryInventoryFrame(store.getSnapshot(), {
      ...nextIdentity,
      runId: "authority-run-other",
    })).toBeNull();
    expect(selectNativeFactoryInventoryFrame(store.getSnapshot(), {
      ...nextIdentity,
      registryFingerprint: "builtin:other",
    })).toBeNull();
    expect(selectNativeFactoryInventoryFrame(store.getSnapshot(), {
      ...nextIdentity,
      revision: IDENTITY.revision - 1,
    })).toBeNull();

    pendingPage.resolve(null);
    await expect(pending).resolves.toBe("unavailable");
    expect(selectNativeFactoryInventoryFrame(store.getSnapshot(), nextIdentity)?.revision)
      .toBe(IDENTITY.revision);
  });

  it("discards every page when a later header drifts", async () => {
    const itemIds = inventoryIds(257);
    const pages = [
      page(0, itemIds.slice(0, 256), itemIds.length),
      page(256, itemIds.slice(256), itemIds.length, { activePlanetId: "ashen" }),
    ];
    const store = new NativeFactoryInventoryStore();
    await expect(store.refresh(source(async (cursor) =>
      pages.find((candidate) => candidate.request.cursor === cursor) ?? null), IDENTITY)).resolves.toBe("unavailable");
    expect(store.getSnapshot().status).toBe("unavailable");
    expect(store.getSnapshot().frame).toBeNull();
  });

  it("rejects cursor stalls, cross-page duplicates, and forged row arithmetic", async () => {
    const itemIds = inventoryIds(257);
    const cases: NativeFactoryInventoryProjection[][] = [
      [page(0, itemIds.slice(0, 256), itemIds.length, { nextCursor: 0, truncated: true })],
      [page(0, itemIds.slice(0, 256), itemIds.length), page(256, [itemIds[0]], itemIds.length)],
      [page(0, ["a"], 1, { rows: [{ itemId: "a", amount: 1, freeCapacity: 7, overLimit: false }] })],
      [page(0, [], 0, { productionBufferLimit: 999 })],
    ];
    for (const pages of cases) {
      const store = new NativeFactoryInventoryStore();
      await expect(store.refresh(source(async (cursor) =>
        pages.find((candidate) => candidate.request.cursor === cursor) ?? null), IDENTITY)).resolves.toBe("unavailable");
    }
  });

  it("supersedes an old run without publishing its late page", async () => {
    const oldDeferred = deferred<NativeFactoryInventoryProjection>();
    const oldSource = source(() => oldDeferred.promise);
    const store = new NativeFactoryInventoryStore();
    const oldRefresh = store.refresh(oldSource, IDENTITY);
    const nextIdentity = { ...IDENTITY, runId: "authority-run-2", revision: 18 };
    const nextPage = { ...page(0, [], 0), revision: 18, request: {
      expectedRevision: 18,
      cursor: 0,
      limit: NATIVE_FACTORY_INVENTORY_PAGE_ROWS,
    } } as NativeFactoryInventoryProjection;
    const nextSource: NativeFactoryInventorySource = {
      boundIdentity: nextIdentity,
      readVerifiedFactoryInventory: async () => nextPage,
    };
    await expect(store.refresh(nextSource, nextIdentity)).resolves.toBe("committed");
    oldDeferred.resolve(page(0, [], 0));
    await expect(oldRefresh).resolves.toBe("superseded");
    expect(store.getSnapshot().frame?.runId).toBe("authority-run-2");
  });

  it("fails closed when the source identity does not exactly match", async () => {
    const store = new NativeFactoryInventoryStore();
    const wrongSource: NativeFactoryInventorySource = {
      boundIdentity: { ...IDENTITY, sessionId: "other" },
      readVerifiedFactoryInventory: async () => page(0, [], 0),
    };
    await expect(store.refresh(wrongSource, IDENTITY)).resolves.toBe("unavailable");
    expect(store.getSnapshot().status).toBe("unavailable");
  });

  it("fails closed instead of remaining loading when a page read rejects", async () => {
    const store = new NativeFactoryInventoryStore();
    await expect(store.refresh(source(async () => {
      throw new Error("native host stopped");
    }), IDENTITY)).resolves.toBe("unavailable");
    expect(store.getSnapshot()).toMatchObject({
      status: "unavailable",
      requestedRevision: IDENTITY.revision,
    });
  });
});
