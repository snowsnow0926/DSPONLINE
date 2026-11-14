/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_SAVE_WRITER_CONTINUATION_KEY, LOCAL_SAVE_WRITER_SESSION_KEY } from "./localSaveCoordination";

const priorWriterId = "tab_previous_document";

function navigationTiming(type?: string, legacyType = 0) {
  vi.stubGlobal("performance", {
    now: () => Date.now(),
    getEntriesByType: () => type ? [{ type }] : [],
    navigation: { type: legacyType },
  });
}

describe("local save writer document identity", () => {
  beforeEach(() => {
    vi.resetModules();
    sessionStorage.clear();
    sessionStorage.setItem(LOCAL_SAVE_WRITER_SESSION_KEY, priorWriterId);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it.each([1, 2])("retains an existing tab through legacy navigation type %s", async (legacyType) => {
    navigationTiming(undefined, legacyType);
    const store = await import("./localSaveStore");
    expect(store.getLocalSaveWriterStatus().writerId).toBe(priorWriterId);
  });

  it("keeps tab storage and an explicit reload continuation when Navigation Timing throws", async () => {
    navigationTiming();
    performance.getEntriesByType = () => { throw new TypeError("Navigation Timing unavailable"); };
    const first = await import("./localSaveStore");
    const writerId = first.getLocalSaveWriterStatus().writerId;
    expect(writerId).not.toBe(priorWriterId);
    expect(sessionStorage.getItem(LOCAL_SAVE_WRITER_SESSION_KEY)).toBe(writerId);
    first.prepareLocalSaveWriterReload();

    vi.resetModules();
    const reloaded = await import("./localSaveStore");
    expect(reloaded.getLocalSaveWriterStatus().writerId).toBe(writerId);
    expect(sessionStorage.getItem(LOCAL_SAVE_WRITER_CONTINUATION_KEY)).toBeNull();
  });

  it("consumes a planned reload even when both navigation APIs and unload events are absent", async () => {
    vi.stubGlobal("performance", { now: () => Date.now() });
    const first = await import("./localSaveStore");
    first.prepareLocalSaveWriterReload();
    const writerId = first.getLocalSaveWriterStatus().writerId;
    vi.resetModules();
    expect((await import("./localSaveStore")).getLocalSaveWriterStatus().writerId).toBe(writerId);
  });

  it("assigns a new identity to a duplicated tab with copied session storage", async () => {
    navigationTiming("navigate");
    const store = await import("./localSaveStore");
    expect(store.getLocalSaveWriterStatus().writerId).not.toBe(priorWriterId);
  });

  it.each([
    { writerId: priorWriterId, createdAt: Date.now() - 180_000 },
    { writerId: "tab_another_document", createdAt: Date.now() },
  ])("rejects an expired or unrelated continuation", async (marker) => {
    navigationTiming();
    sessionStorage.setItem(LOCAL_SAVE_WRITER_CONTINUATION_KEY, JSON.stringify(marker));
    expect((await import("./localSaveStore")).getLocalSaveWriterStatus().writerId).not.toBe(priorWriterId);
  });
});
