/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SAVE_KEY = "dsp-idle-network.save.v1";

function envelope(options: {
  mode?: "normal" | "speedrun";
  kind?: "primary" | "slot" | "snapshot";
  reason?: string;
  savedAt: number;
  slot?: "main" | 1 | 2 | 3;
  payloadBytes?: number;
  checksum?: string;
}): string {
  return JSON.stringify({
    formatVersion: 2,
    kind: options.kind ?? "primary",
    ...(options.reason ? { reason: options.reason } : {}),
    savedAt: options.savedAt,
    mode: options.mode ?? "normal",
    slot: options.slot ?? "main",
    state: { payload: "界".repeat(options.payloadBytes ?? 1) },
    checksum: options.checksum ?? `sum_${options.savedAt}`,
  });
}

async function loadStore(storageManager?: Partial<StorageManager>) {
  vi.resetModules();
  Object.defineProperty(navigator, "storage", {
    configurable: true,
    value: storageManager,
  });
  return import("./localSaveStore");
}

describe("local save capacity safeguards", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(navigator, "storage", { configurable: true, value: undefined });
  });

  it("summarizes normal and speedrun categories from cached record metadata without reparsing bodies", async () => {
    const estimate = vi.fn(async () => ({ usage: 20 * 1024 * 1024, quota: 100 * 1024 * 1024 }));
    const store = await loadStore({ estimate, persisted: vi.fn(async () => false), persist: vi.fn(async () => false) });

    store.setLocalSaveValue(SAVE_KEY, envelope({ savedAt: 100, payloadBytes: 1_024 }));
    store.setLocalSaveValue("dsp-idle-network.slot.1", envelope({ kind: "slot", slot: 1, savedAt: 110 }));
    store.setLocalSaveValue(`${SAVE_KEY}.snapshot.120-1`, envelope({ kind: "snapshot", reason: "自动快照", savedAt: 120 }));
    store.setLocalSaveValue(`${SAVE_KEY}.snapshot.130-2`, envelope({ kind: "snapshot", reason: "手动快照", savedAt: 130 }));
    store.setLocalSaveValue(`${SAVE_KEY}.snapshot.140-3`, envelope({ kind: "snapshot", reason: "恢复云存档前", savedAt: 140 }));
    store.setLocalSaveValue(`${SAVE_KEY}.import-cache.normal.active`, envelope({ savedAt: 150 }));
    store.setLocalSaveValue(`${SAVE_KEY}.speedrun`, envelope({ mode: "speedrun", savedAt: 200 }));
    store.setLocalSaveValue("dsp-idle-network.slot.speedrun.2", envelope({ mode: "speedrun", kind: "slot", slot: 2, savedAt: 210 }));
    store.setLocalSaveValue(`${SAVE_KEY}.snapshot.speedrun.220-1`, envelope({ mode: "speedrun", kind: "snapshot", reason: "手动快照", savedAt: 220 }));

    const parse = vi.spyOn(JSON, "parse");
    const first = await store.getLocalSaveStorageEstimate();
    const second = await store.getLocalSaveStorageEstimate();
    expect(parse.mock.calls.every(([value]) => typeof value === "string" && value.length < 128)).toBe(true);
    expect(estimate).toHaveBeenCalledTimes(2);
    expect(second.payloadBytes).toBe(first.payloadBytes);
    expect(first.pressure).toBe("normal");
    expect(first.persistenceStatus).toBe("not-granted");
    expect(first.modes).toEqual([
      expect.objectContaining({
        mode: "normal",
        slotCount: 1,
        automaticSnapshotCount: 1,
        manualSnapshotCount: 1,
        protectedCount: 1,
        importCacheCount: 1,
      }),
      expect.objectContaining({
        mode: "speedrun",
        slotCount: 1,
        automaticSnapshotCount: 0,
        manualSnapshotCount: 1,
        protectedCount: 0,
        importCacheCount: 0,
      }),
    ]);
    expect(first.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ mode: "normal", category: "slot", slot: 1, source: "手动槽位 1" }),
      expect.objectContaining({ mode: "normal", category: "protected", reason: "恢复云存档前", protected: true }),
      expect.objectContaining({ mode: "speedrun", category: "manual-snapshot", reason: "手动快照" }),
    ]));
  });

  it("bounds automatic snapshots independently and never deletes manual, protected, or unknown recovery points", async () => {
    const store = await loadStore();
    for (const mode of ["normal", "speedrun"] as const) {
      const prefix = mode === "normal" ? `${SAVE_KEY}.snapshot` : `${SAVE_KEY}.snapshot.speedrun`;
      for (let index = 1; index <= 4; index += 1) {
        store.setLocalSaveValue(`${prefix}.${index}00-${index}`, envelope({ mode, kind: "snapshot", reason: "自动快照", savedAt: index * 100 }));
      }
      store.setLocalSaveValue(`${prefix}.manual`, envelope({ mode, kind: "snapshot", reason: "手动快照", savedAt: 500 }));
      store.setLocalSaveValue(`${prefix}.protected`, envelope({ mode, kind: "snapshot", reason: "导入外部存档前", savedAt: 600 }));
      store.setLocalSaveValue(`${prefix}.unknown`, `{"savedAt":700,"mode":"${mode}","state":{"payload":"unknown"},"checksum":"unknown_${mode}"}`);
    }

    const report = await store.getLocalSaveStorageEstimate();
    for (const mode of ["normal", "speedrun"] as const) {
      const entries = report.entries.filter((entry) => entry.mode === mode);
      expect(entries.filter((entry) => entry.category === "automatic-snapshot")).toHaveLength(2);
      expect(entries.filter((entry) => entry.category === "manual-snapshot")).toHaveLength(1);
      expect(entries.filter((entry) => entry.category === "protected")).toHaveLength(2);
      expect(entries.some((entry) => entry.reason === "导入外部存档前")).toBe(true);
      expect(entries.some((entry) => entry.key.endsWith(".unknown") && entry.protected)).toBe(true);
    }
  });

  it("reports granted, denied, and unsupported persistent-storage states without blocking saves", async () => {
    let granted = false;
    const store = await loadStore({
      estimate: vi.fn(async () => ({ usage: 1, quota: 100 })),
      persisted: vi.fn(async () => granted),
      persist: vi.fn(async () => false),
    });
    store.setLocalSaveValue(SAVE_KEY, envelope({ savedAt: 1 }));
    expect(await store.requestLocalSavePersistentStorage()).toBe("denied");
    expect((await store.getLocalSaveStorageEstimate()).persistenceStatus).toBe("denied");

    Object.defineProperty(navigator.storage, "persist", { configurable: true, value: vi.fn(async () => { granted = true; return true; }) });
    expect(await store.requestLocalSavePersistentStorage()).toBe("granted");
    expect((await store.getLocalSaveStorageEstimate()).persistenceStatus).toBe("granted");
    expect(store.getLocalSaveValue(SAVE_KEY)).not.toBeNull();

    const unsupported = await loadStore(undefined);
    unsupported.setLocalSaveValue(SAVE_KEY, envelope({ savedAt: 2 }));
    expect(await unsupported.requestLocalSavePersistentStorage()).toBe("unsupported");
    expect((await unsupported.getLocalSaveStorageEstimate()).persistenceStatus).toBe("unsupported");
    expect(unsupported.getLocalSaveValue(SAVE_KEY)).not.toBeNull();
  });

  it("never labels a memory-only fallback as persistent even when the browser origin is granted", async () => {
    const nativeSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key.endsWith(".storage-probe")) throw new DOMException("disabled", "QuotaExceededError");
      return nativeSetItem.call(this, key, value);
    });
    const store = await loadStore({
      estimate: vi.fn(async () => ({ usage: 1, quota: 100 })),
      persisted: vi.fn(async () => true),
      persist: vi.fn(async () => true),
    });
    expect(await store.requestLocalSavePersistentStorage()).toBe("unsupported");
    expect(store.getLocalSaveBackend()).toBe("memory");
    expect((await store.getLocalSaveStorageEstimate()).persistenceStatus).toBe("unsupported");
  });

  it("preserves the last checksummed main save and exposes an explicit recovery prompt after quota failure", async () => {
    const store = await loadStore({
      estimate: vi.fn(async () => ({ usage: 99, quota: 100 })),
      persisted: vi.fn(async () => true),
      persist: vi.fn(async () => true),
    });
    const previous = envelope({ savedAt: 10, checksum: "verified_main" });
    store.setLocalSaveValue(SAVE_KEY, previous);
    const nativeSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key === SAVE_KEY) throw new DOMException("quota", "QuotaExceededError");
      return nativeSetItem.call(this, key, value);
    });

    expect(() => store.setLocalSaveValue(SAVE_KEY, envelope({ savedAt: 20, checksum: "new_main" }))).toThrowError(/quota/i);
    expect(store.getLocalSaveValue(SAVE_KEY)).toBe(previous);
    const report = await store.getLocalSaveStorageEstimate();
    expect(report.pressure).toBe("critical");
    expect(report.recoveryPrompt).toMatchObject({ mode: "normal", preservedChecksummedMain: true, key: SAVE_KEY });
    expect(report.recoveryPrompt?.message).toContain("上一次带校验值的普通主存档仍原样保留");

    store.dismissLocalSaveRecoveryPrompt();
    expect((await store.getLocalSaveStorageEstimate()).recoveryPrompt).toBeNull();
  });

  it("warns about high manual/protected usage but does not remove those records", async () => {
    const store = await loadStore({
      estimate: vi.fn(async () => ({ usage: 85, quota: 100 })),
      persisted: vi.fn(async () => false),
      persist: vi.fn(async () => false),
    });
    for (let index = 0; index < 8; index += 1) {
      store.setLocalSaveValue(`${SAVE_KEY}.snapshot.manual-${index}`, envelope({ kind: "snapshot", reason: index % 2 ? "手动快照" : "恢复云存档前", savedAt: 1_000 + index }));
    }
    const report = await store.getLocalSaveStorageEstimate();
    expect(report.pressure).toBe("high");
    expect(report.warnings.join(" ")).toContain("系统不会自动删除");
    expect(report.warnings.join(" ")).toContain("超过 80%");
    expect(report.entries.filter((entry) => entry.category === "manual-snapshot" || entry.category === "protected")).toHaveLength(8);
  });

  it("uses measured UTF-8 bytes for the same quota boundary without encoding the payload again", async () => {
    let availableBytes = 0;
    const estimate = vi.fn(async () => ({ usage: 1_000, quota: 1_000 + availableBytes }));
    const store = await loadStore({ estimate });
    const previous = envelope({ savedAt: 1, payloadBytes: 100 });
    const next = envelope({ savedAt: 2, payloadBytes: 1_000 });
    store.setLocalSaveValue(SAVE_KEY, previous);
    const encoder = new TextEncoder();
    const previousBytes = encoder.encode(previous).byteLength;
    const nextBytes = encoder.encode(next).byteLength;
    const requiredBytes = nextBytes - previousBytes;
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    for (const extra of [-1, 0]) {
      availableBytes = requiredBytes + 256 * 1024 + extra;
      encode.mockClear();
      expect(await store.hasLocalSaveCapacityForBytes(SAVE_KEY, nextBytes)).toEqual({
        ok: extra === 0, requiredBytes, availableBytes,
      });
      expect(encode).not.toHaveBeenCalled();
      expect(await store.hasLocalSaveCapacity(SAVE_KEY, next)).toEqual({
        ok: extra === 0, requiredBytes, availableBytes,
      });
    }
    expect(await store.hasLocalSaveCapacityForBytes(SAVE_KEY, 0)).toMatchObject({ requiredBytes: 0 });
    expect(store.getLocalSaveValue(SAVE_KEY)).toBe(previous);
  });

  it("rejects invalid measured lengths before querying quota", async () => {
    const estimate = vi.fn(async () => ({ usage: 0, quota: 1_000_000 }));
    const store = await loadStore({ estimate });
    estimate.mockClear();
    for (const bytes of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(store.hasLocalSaveCapacityForBytes(SAVE_KEY, bytes)).rejects.toThrow("Invalid measured save byte length");
    }
    expect(estimate).not.toHaveBeenCalled();
  });

  it("deletes only explicitly selected managed recovery entries and blocks primary, slot, and automatic keys", async () => {
    const store = await loadStore();
    const primary = envelope({ savedAt: 1 });
    const slot = envelope({ kind: "slot", slot: 1, savedAt: 2 });
    const automatic = envelope({ kind: "snapshot", reason: "自动快照", savedAt: 3 });
    const manual = envelope({ kind: "snapshot", reason: "手动快照", savedAt: 4 });
    const protectedSnapshot = envelope({ kind: "snapshot", reason: "恢复云存档前", savedAt: 5 });
    const migrationBackup = envelope({ savedAt: 6 });
    store.setLocalSaveValue(SAVE_KEY, primary);
    store.setLocalSaveValue("dsp-idle-network.slot.1", slot);
    store.setLocalSaveValue(`${SAVE_KEY}.snapshot.auto`, automatic);
    store.setLocalSaveValue(`${SAVE_KEY}.snapshot.manual`, manual);
    store.setLocalSaveValue(`${SAVE_KEY}.snapshot.protected`, protectedSnapshot);
    store.setLocalSaveValue(`${SAVE_KEY}.migration-backup.v46`, migrationBackup);

    const result = await store.deleteLocalSaveManagedEntries([
      SAVE_KEY,
      "dsp-idle-network.slot.1",
      `${SAVE_KEY}.snapshot.auto`,
      `${SAVE_KEY}.snapshot.manual`,
      `${SAVE_KEY}.snapshot.protected`,
      `${SAVE_KEY}.migration-backup.v46`,
    ]);
    expect(result.removed).toEqual([`${SAVE_KEY}.snapshot.manual`, `${SAVE_KEY}.snapshot.protected`]);
    expect(result.failed).toEqual([]);
    expect(result.blocked).toEqual([SAVE_KEY, "dsp-idle-network.slot.1", `${SAVE_KEY}.snapshot.auto`, `${SAVE_KEY}.migration-backup.v46`]);
    expect(store.getLocalSaveValue(SAVE_KEY)).toBe(primary);
    expect(store.getLocalSaveValue("dsp-idle-network.slot.1")).toBe(slot);
    expect(store.getLocalSaveValue(`${SAVE_KEY}.snapshot.auto`)).toBe(automatic);
    expect(store.getLocalSaveValue(`${SAVE_KEY}.snapshot.manual`)).toBeNull();
    expect(store.getLocalSaveValue(`${SAVE_KEY}.snapshot.protected`)).toBeNull();
    expect(store.getLocalSaveValue(`${SAVE_KEY}.migration-backup.v46`)).toBe(migrationBackup);
  });
});
