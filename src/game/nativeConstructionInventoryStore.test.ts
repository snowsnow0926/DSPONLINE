import { describe, expect, it } from "vitest";
import type { DesktopNativeCoreConstructionInventoryResult } from "../desktop";
import {
  NATIVE_CONSTRUCTION_INVENTORY_PAGE_ROWS,
  NativeConstructionInventoryStore,
  createNativePlayerAuthorityConstructionInventorySource,
  selectNativeConstructionInventoryFrame,
  type NativeConstructionInventoryIdentity,
  type NativeConstructionInventoryProjection,
  type NativeConstructionInventorySource,
} from "./nativeConstructionInventoryStore";

const IDENTITY: NativeConstructionInventoryIdentity = Object.freeze({
  sessionId: "authority-session",
  runId: "authority-run",
  revision: 23,
  registryFingerprint: "builtin:test",
});

function ids(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `building-${String(index).padStart(5, "0")}`);
}

function page(
  cursor: number,
  buildingIds: string[],
  totalCount = buildingIds.length,
  overrides: Partial<NativeConstructionInventoryProjection> = {},
): NativeConstructionInventoryProjection {
  const rows = buildingIds.map((buildingId, index) => ({ buildingId, amount: cursor + index + 1 }));
  const nextCursor = cursor + rows.length < totalCount ? cursor + rows.length : null;
  return {
    schemaVersion: 1,
    projectionType: "construction-inventory-v1",
    source: "native-core",
    revision: IDENTITY.revision,
    stateVersion: 47,
    registryFingerprint: IDENTITY.registryFingerprint,
    readOnly: true,
    request: {
      expectedRevision: IDENTITY.revision,
      expectedRegistryFingerprint: IDENTITY.registryFingerprint,
      cursor,
      limit: NATIVE_CONSTRUCTION_INVENTORY_PAGE_ROWS,
    },
    totalCount,
    rows,
    nextCursor,
    truncated: nextCursor !== null,
    limits: { rows: 256, projectionBytes: 1_048_576 },
    ...overrides,
  };
}

function source(
  reader: NativeConstructionInventorySource["readVerifiedConstructionInventory"],
): NativeConstructionInventorySource {
  return { boundIdentity: IDENTITY, readVerifiedConstructionInventory: reader };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

describe("NativeConstructionInventoryStore", () => {
  it("publishes one complete same-revision read-only frame including MOD rows", async () => {
    const buildingIds = [...ids(256), "模组/量子工厂"];
    const pages = [page(0, buildingIds.slice(0, 256), 257), page(256, buildingIds.slice(256), 257)];
    const store = new NativeConstructionInventoryStore();
    await expect(store.refresh(source(async (cursor) =>
      pages.find((candidate) => candidate.request.cursor === cursor) ?? null), IDENTITY)).resolves.toBe("committed");
    const frame = selectNativeConstructionInventoryFrame(store.getSnapshot(), IDENTITY);
    expect(frame?.readOnly).toBe(true);
    expect(frame?.rows.map((row) => row.buildingId)).toEqual(buildingIds);
    expect(frame?.rowsByBuildingId.get("模组/量子工厂")?.amount).toBe(257);
    expect(frame?.totalAmount).toBe(257 * 258 / 2);
  });

  it("coalesces duplicate refreshes and supersedes an old run", async () => {
    const pendingPage = deferred<NativeConstructionInventoryProjection>();
    let reads = 0;
    const store = new NativeConstructionInventoryStore();
    const first = store.refresh(source(() => {
      reads += 1;
      return pendingPage.promise;
    }), IDENTITY);
    expect(store.refresh(source(() => pendingPage.promise), IDENTITY)).toBe(first);
    const nextIdentity = { ...IDENTITY, runId: "authority-run-2", revision: 24 };
    const nextPage = {
      ...page(0, [], 0),
      revision: 24,
      request: { ...page(0, [], 0).request, expectedRevision: 24 },
    } as NativeConstructionInventoryProjection;
    await expect(store.refresh({
      boundIdentity: nextIdentity,
      readVerifiedConstructionInventory: async () => nextPage,
    }, nextIdentity)).resolves.toBe("committed");
    pendingPage.resolve(page(0, [], 0));
    await expect(first).resolves.toBe("superseded");
    expect(reads).toBe(1);
    expect(store.getSnapshot().frame?.runId).toBe("authority-run-2");
  });

  it("rejects page drift, sparse pages, duplicates, zero amounts, and unsafe totals", async () => {
    const buildingIds = ids(257);
    const first = page(0, buildingIds.slice(0, 256), 257);
    const cases: NativeConstructionInventoryProjection[][] = [
      [first, page(256, buildingIds.slice(256), 257, { registryFingerprint: "builtin:other" })],
      [page(0, ["a"], 2)],
      [first, page(256, [buildingIds[0]], 257)],
      [page(0, ["a"], 1, { rows: [{ buildingId: "a", amount: 0 }] })],
      [page(0, ["a", "b"], 2, { rows: [
        { buildingId: "a", amount: Number.MAX_SAFE_INTEGER },
        { buildingId: "b", amount: 1 },
      ] })],
    ];
    for (const pages of cases) {
      const store = new NativeConstructionInventoryStore();
      await expect(store.refresh(source(async (cursor) =>
        pages.find((candidate) => candidate.request.cursor === cursor) ?? null), IDENTITY)).resolves.toBe("unavailable");
      expect(selectNativeConstructionInventoryFrame(store.getSnapshot(), IDENTITY)).toBeNull();
    }
  });

  it("fails closed when the reader rejects or the bound identity differs", async () => {
    const store = new NativeConstructionInventoryStore();
    await expect(store.refresh(source(async () => {
      throw new Error("host stopped");
    }), IDENTITY)).resolves.toBe("unavailable");
    await expect(store.refresh({
      boundIdentity: { ...IDENTITY, sessionId: "other" },
      readVerifiedConstructionInventory: async () => page(0, [], 0),
    }, IDENTITY)).resolves.toBe("unavailable");
    expect(store.getSnapshot().status).toBe("unavailable");
  });

  it("binds direct desktop reads to the exact session, revision, fingerprint, and fixed page size", async () => {
    const calls: unknown[] = [];
    const projection = page(0, [], 0);
    const bound = createNativePlayerAuthorityConstructionInventorySource({
      getNativeCoreConstructionInventory: async (request) => {
        calls.push(request);
        return projection as DesktopNativeCoreConstructionInventoryResult;
      },
    }, IDENTITY);
    await expect(bound?.readVerifiedConstructionInventory(
      0,
      NATIVE_CONSTRUCTION_INVENTORY_PAGE_ROWS,
      IDENTITY.revision,
      IDENTITY.registryFingerprint,
    )).resolves.toEqual(projection);
    expect(calls).toEqual([{
      sessionId: IDENTITY.sessionId,
      expectedRevision: IDENTITY.revision,
      expectedRegistryFingerprint: IDENTITY.registryFingerprint,
      cursor: 0,
      limit: NATIVE_CONSTRUCTION_INVENTORY_PAGE_ROWS,
    }]);
    await expect(bound?.readVerifiedConstructionInventory(
      0,
      1,
      IDENTITY.revision,
      IDENTITY.registryFingerprint,
    )).resolves.toBeNull();
    expect(calls).toHaveLength(1);
  });
});
