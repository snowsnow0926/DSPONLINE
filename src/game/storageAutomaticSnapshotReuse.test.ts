/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialState } from "./engine";
import { getSaveSnapshotSummaries, inspectSave, saveGameSnapshotVerified, saveGameVerified } from "./storage";
import { flushLocalSaveWrites, removeLocalSaveValue } from "./localSaveStore";
import * as saveTransfer from "./saveTransfer";

const PRIMARY_KEY = "dsp-idle-network.save.v1";
const SNAPSHOT_PREFIX = `${PRIMARY_KEY}.snapshot.`;

describe("verified primary automatic snapshot reuse", () => {
  beforeEach(async () => {
    for (const key of Object.keys(window.localStorage)) removeLocalSaveValue(key);
    await flushLocalSaveWrites();
    window.localStorage.clear();
  });
  afterEach(() => vi.restoreAllMocks());

  it("serializes state once and durably reads back a separately framed automatic snapshot", async () => {
    const serialize = vi.spyOn(saveTransfer, "serializeSaveEnvelopeToTransfer");
    let clock = 1800000000000;
    vi.spyOn(Date, "now").mockImplementation(() => clock++);
    const reads = vi.spyOn(Storage.prototype, "getItem");
    const state = createInitialState();
    state.elapsedSeconds = 321;
    state.entities[0].outputs.iron_ore = 123;
    expect(await saveGameVerified(state)).toMatchObject({ success: true });
    expect(serialize.mock.calls.map(([, options]) => options.kind)).toEqual(["primary"]);
    const key = Object.keys(window.localStorage).find((entry) => entry.startsWith(SNAPSHOT_PREFIX))!;
    expect(key).toBeDefined();
    // Capture read-back evidence before the test itself reads the new entry.
    expect(reads.mock.calls.some(([entry]) => entry === key)).toBe(true);
    const primary = JSON.parse(window.localStorage.getItem(PRIMARY_KEY)!);
    const raw = window.localStorage.getItem(key)!;
    const snapshot = JSON.parse(raw);
    expect(snapshot).toMatchObject({ kind: "snapshot", reason: "自动快照", mode: "normal", slot: "main" });
    expect(snapshot.savedAt).toBeGreaterThan(primary.savedAt);
    expect(key).toContain(`.${snapshot.savedAt}-`);
    expect(snapshot.state).toEqual(primary.state);
    expect(snapshot.checksum).toBe(primary.checksum);
    expect(inspectSave(raw)).toMatchObject({ valid: true, checksum: "valid" });
    expect(getSaveSnapshotSummaries()).toMatchObject([{ savedAt: snapshot.savedAt, elapsedSeconds: 321, reason: "自动快照", valid: true }]);
  });

  it("falls back to state serialization when a valid primary has a different header order", async () => {
    const original = saveTransfer.serializeSaveEnvelopeToTransfer;
    const serialize = vi.spyOn(saveTransfer, "serializeSaveEnvelopeToTransfer").mockImplementation((state, options) => {
      const result = original(state, options);
      if (options.kind !== "primary") return result;
      const parsed = JSON.parse(saveTransfer.decodeVerifiedSaveTransfer(result.bytes, result));
      const bytes = new TextEncoder().encode(JSON.stringify({ savedAt: parsed.savedAt, ...parsed }));
      const buffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buffer).set(bytes);
      return { ...result, bytes: buffer, byteLength: bytes.byteLength, payloadChecksum: saveTransfer.computeSavePayloadChecksum(buffer) };
    });
    expect(await saveGameVerified(createInitialState())).toMatchObject({ success: true });
    expect(serialize.mock.calls.map(([, options]) => options.kind)).toEqual(["primary", "snapshot"]);
    expect(getSaveSnapshotSummaries()).toMatchObject([{ valid: true, reason: "自动快照" }]);
  });

  it("retains snapshot timing and quotas while leaving manual snapshots independent", async () => {
    const serialize = vi.spyOn(saveTransfer, "serializeSaveEnvelopeToTransfer");
    expect(await saveGameSnapshotVerified(createInitialState(), "手动保留")).toMatchObject({ valid: true });
    for (const elapsedSeconds of [10, 20, 310, 610]) {
      const state = createInitialState();
      state.elapsedSeconds = elapsedSeconds;
      expect(await saveGameVerified(state)).toMatchObject({ success: true });
    }
    expect(serialize.mock.calls.map(([, options]) => options.kind)).toEqual(["snapshot", "primary", "primary", "primary", "primary"]);
    const summaries = getSaveSnapshotSummaries();
    expect(summaries.filter((summary) => summary.reason === "自动快照").map((summary) => summary.elapsedSeconds)).toEqual([610, 310]);
    expect(summaries.some((summary) => summary.reason === "手动保留")).toBe(true);
    expect(summaries.every((summary) => summary.valid)).toBe(true);
  });

  it("keeps the verified primary successful when the optional snapshot write fails", async () => {
    const original = Storage.prototype.setItem;
    const attempted: string[] = [];
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key.startsWith(SNAPSHOT_PREFIX)) {
        attempted.push(key);
        throw new DOMException("synthetic snapshot quota", "QuotaExceededError");
      }
      return original.call(this, key, value);
    });
    expect(await saveGameVerified(createInitialState())).toMatchObject({ success: true });
    expect(attempted.length).toBeGreaterThan(0);
    expect(inspectSave(window.localStorage.getItem(PRIMARY_KEY)!)).toMatchObject({ valid: true, checksum: "valid" });
  });

  it("keeps the verified primary successful when the written snapshot fails exact read-back", async () => {
    const originalGet = Storage.prototype.getItem;
    const mismatchedReadbacks: string[] = [];
    const serialize = vi.spyOn(saveTransfer, "serializeSaveEnvelopeToTransfer");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key) {
      const stored = originalGet.call(this, key);
      if (key.startsWith(SNAPSHOT_PREFIX) && stored !== null) {
        mismatchedReadbacks.push(key);
        return `${stored} `;
      }
      return stored;
    });
    expect(await saveGameVerified(createInitialState())).toMatchObject({ success: true });
    expect(mismatchedReadbacks.length).toBeGreaterThan(0);
    // The snapshot write really occurred; only the subsequent read-back was
    // changed. Optional recovery-point failure cannot undo the primary proof.
    expect(originalGet.call(window.localStorage, mismatchedReadbacks[0])).not.toBeNull();
    expect(serialize.mock.calls.map(([, options]) => options.kind)).toEqual(["primary"]);
    expect(inspectSave(originalGet.call(window.localStorage, PRIMARY_KEY)!)).toMatchObject({ valid: true, checksum: "valid" });
  });
});
