import { describe, expect, it, vi } from "vitest";

import type { DesktopNativeCoreCommandPaletteEntitySearchResult } from "../desktop";
import { createCommandPaletteEntitySearchSelector, type CommandPaletteEntitySearchSelector } from "./commandPaletteEntitySearchReadModel";
import { NativeCommandPaletteEntitySearchStore } from "./nativeCommandPaletteEntitySearchStore";

function result(
  selector: CommandPaletteEntitySearchSelector,
  revision: number,
): DesktopNativeCoreCommandPaletteEntitySearchResult {
  return {
    schemaVersion: 1,
    projectionType: "command-palette-entity-search-v1",
    revision,
    registryFingerprint: "builtin:test",
    limits: { queryBytes: 256, selectorIds: 256, rows: 16, requestBytes: 32768, projectionBytes: 1048576 },
    request: {
      query: selector.query,
      cursor: selector.cursor,
      limit: selector.limit,
      buildingIds: [...selector.buildingIds],
      resourceIds: [...selector.resourceIds],
      planetIds: [...selector.planetIds],
    },
    totalCount: 0,
    rows: [],
    nextCursor: null,
  };
}

describe("native command palette entity-search store", () => {
  it("commits only the newest same-revision request and drops an out-of-order response", async () => {
    const firstSelector = createCommandPaletteEntitySearchSelector("熔炉", 0, 16);
    const secondSelector = createCommandPaletteEntitySearchSelector("矿石", 0, 16);
    let resolveFirst!: (value: DesktopNativeCoreCommandPaletteEntitySearchResult) => void;
    const source = {
      readVerifiedCommandPaletteEntitySearch: vi.fn()
        .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
        .mockResolvedValueOnce(result(secondSelector, 8)),
    };
    const store = new NativeCommandPaletteEntitySearchStore();
    const first = store.refresh(source, "authority-1", 7, "builtin:test", firstSelector);
    const second = store.refresh(source, "authority-1", 8, "builtin:test", secondSelector);
    await expect(second).resolves.toBe("committed");
    resolveFirst(result(firstSelector, 7));
    await expect(first).resolves.toBe("superseded");
    expect(store.getSnapshot().frame?.revision).toBe(8);
    expect(store.getSnapshot().frame?.selector.query).toBe("矿石");
  });

  it("clears prior rows while pending or unavailable and never serves stale data", async () => {
    const selector = createCommandPaletteEntitySearchSelector("熔炉", 0, 16);
    const store = new NativeCommandPaletteEntitySearchStore();
    await store.refresh({ readVerifiedCommandPaletteEntitySearch: vi.fn().mockResolvedValue(result(selector, 7)) }, "authority-1", 7, "builtin:test", selector);
    expect(store.getSnapshot().status).toBe("ready");
    let resolve!: (value: null) => void;
    const pending = store.refresh({
      readVerifiedCommandPaletteEntitySearch: vi.fn().mockImplementation(() => new Promise((done) => { resolve = done; })),
    }, "authority-1", 8, "builtin:test", selector);
    expect(store.getSnapshot()).toMatchObject({ status: "loading", requestedRevision: 8, frame: null });
    resolve(null);
    await expect(pending).resolves.toBe("unavailable");
    expect(store.getSnapshot()).toMatchObject({ status: "unavailable", frame: null });

    await store.refresh({
      readVerifiedCommandPaletteEntitySearch: vi.fn().mockResolvedValue(result(selector, 9)),
    }, "authority-1", 9, "builtin:test", selector);
    await expect(store.refresh({
      readVerifiedCommandPaletteEntitySearch: vi.fn().mockRejectedValue(new Error("host unavailable")),
    }, "authority-1", 10, "builtin:test", selector)).resolves.toBe("unavailable");
    expect(store.getSnapshot()).toMatchObject({ status: "unavailable", requestedRevision: 10, frame: null });
  });

  it("marks a truncated MOD selector without calling the source", async () => {
    const selector = createCommandPaletteEntitySearchSelector("mod", 0, 16, {
      buildings: Array.from({ length: 257 }, (_, index) => ({ id: `mod_${index}`, name: "mod building" })),
      resources: [],
      planets: [],
    });
    const read = vi.fn();
    const store = new NativeCommandPaletteEntitySearchStore();
    await expect(store.refresh({ readVerifiedCommandPaletteEntitySearch: read }, "authority-1", 7, "builtin:test", selector)).resolves.toBe("truncated");
    expect(read).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toMatchObject({ status: "truncated", frame: null });
  });
});
