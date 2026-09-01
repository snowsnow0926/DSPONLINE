import { describe, expect, it, vi } from "vitest";

import type { DesktopNativeCoreCommandPaletteEntitySearchResult } from "../desktop";
import { createCommandPaletteEntitySearchSelector, type CommandPaletteEntitySearchSelector } from "./commandPaletteEntitySearchReadModel";
import {
  NativeCommandPaletteEntitySearchStore,
  createNativePlayerAuthorityCommandPaletteEntitySearchSource,
  selectNativeCommandPaletteEntitySearchFrame,
  type NativeCommandPaletteEntitySearchIdentity,
  type NativeCommandPaletteEntitySearchSource,
} from "./nativeCommandPaletteEntitySearchStore";

const IDENTITY: NativeCommandPaletteEntitySearchIdentity = Object.freeze({
  sessionId: "authority-1",
  runId: "run-1",
  revision: 7,
  registryFingerprint: "builtin:test",
});

function source(
  identity: NativeCommandPaletteEntitySearchIdentity,
  reader: NativeCommandPaletteEntitySearchSource["readVerifiedCommandPaletteEntitySearch"],
): NativeCommandPaletteEntitySearchSource {
  return { boundIdentity: Object.freeze({ ...identity }), readVerifiedCommandPaletteEntitySearch: reader };
}

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
    const firstIdentity = IDENTITY;
    const secondIdentity = { ...IDENTITY, revision: 8 };
    const reader = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce(result(secondSelector, 8));
    const firstSource = source(firstIdentity, reader);
    const secondSource = source(secondIdentity, reader);
    const store = new NativeCommandPaletteEntitySearchStore();
    const first = store.refresh(firstSource, firstIdentity, firstSelector);
    const second = store.refresh(secondSource, secondIdentity, secondSelector);
    await expect(second).resolves.toBe("committed");
    resolveFirst(result(firstSelector, 7));
    await expect(first).resolves.toBe("superseded");
    expect(store.getSnapshot().frame?.revision).toBe(8);
    expect(store.getSnapshot().frame?.selector.query).toBe("矿石");
  });

  it("retains only the same-lineage same-selector frame read-only while R+1 is unsettled", async () => {
    const selector = createCommandPaletteEntitySearchSelector("熔炉", 0, 16);
    const store = new NativeCommandPaletteEntitySearchStore();
    await store.refresh(source(IDENTITY, vi.fn().mockResolvedValue(result(selector, 7))), IDENTITY, selector);
    expect(store.getSnapshot().status).toBe("ready");
    let resolve!: (value: null) => void;
    const nextIdentity = { ...IDENTITY, revision: 8 };
    const pending = store.refresh(source(
      nextIdentity,
      vi.fn().mockImplementation(() => new Promise((done) => { resolve = done; })),
    ), nextIdentity, selector);
    expect(store.getSnapshot()).toMatchObject({ status: "loading", requestedRevision: 8 });
    expect(selectNativeCommandPaletteEntitySearchFrame(store.getSnapshot(), nextIdentity, selector)?.revision).toBe(7);
    resolve(null);
    await expect(pending).resolves.toBe("unavailable");
    expect(store.getSnapshot()).toMatchObject({ status: "unavailable" });
    expect(selectNativeCommandPaletteEntitySearchFrame(store.getSnapshot(), nextIdentity, selector)?.revision).toBe(7);

    const wrongRun = { ...nextIdentity, runId: "run-2" };
    expect(selectNativeCommandPaletteEntitySearchFrame(store.getSnapshot(), wrongRun, selector)).toBeNull();
    const wrongRegistry = { ...nextIdentity, registryFingerprint: "builtin:other" };
    expect(selectNativeCommandPaletteEntitySearchFrame(store.getSnapshot(), wrongRegistry, selector)).toBeNull();
    const rollback = { ...nextIdentity, revision: 6 };
    expect(selectNativeCommandPaletteEntitySearchFrame(store.getSnapshot(), rollback, selector)).toBeNull();
    const changedSelector = createCommandPaletteEntitySearchSelector("矿石", 0, 16);
    expect(selectNativeCommandPaletteEntitySearchFrame(store.getSnapshot(), nextIdentity, changedSelector))
      .toBeNull();
  });

  it("binds the desktop read to session, run, revision, registry, and the complete selector", async () => {
    const selector = createCommandPaletteEntitySearchSelector("熔炉", 0, 16);
    const read = vi.fn().mockResolvedValue(result(selector, IDENTITY.revision));
    const bound = createNativePlayerAuthorityCommandPaletteEntitySearchSource({
      getNativeCoreCommandPaletteEntitySearch: read,
    }, IDENTITY);

    await expect(bound?.readVerifiedCommandPaletteEntitySearch(
      IDENTITY.revision,
      IDENTITY.registryFingerprint,
      selector,
    )).resolves.toEqual(result(selector, IDENTITY.revision));
    expect(read).toHaveBeenCalledWith({
      sessionId: IDENTITY.sessionId,
      runId: IDENTITY.runId,
      expectedRevision: IDENTITY.revision,
      expectedRegistryFingerprint: IDENTITY.registryFingerprint,
      query: selector.query,
      cursor: selector.cursor,
      limit: selector.limit,
      buildingIds: [...selector.buildingIds],
      resourceIds: [...selector.resourceIds],
      planetIds: [...selector.planetIds],
    });
  });

  it("marks a truncated MOD selector without calling the source", async () => {
    const selector = createCommandPaletteEntitySearchSelector("mod", 0, 16, {
      buildings: Array.from({ length: 257 }, (_, index) => ({ id: `mod_${index}`, name: "mod building" })),
      resources: [],
      planets: [],
    });
    const read = vi.fn();
    const store = new NativeCommandPaletteEntitySearchStore();
    await expect(store.refresh(source(IDENTITY, read), IDENTITY, selector)).resolves.toBe("truncated");
    expect(read).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toMatchObject({ status: "truncated", frame: null });
  });
});
