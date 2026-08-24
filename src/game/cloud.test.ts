/** @vitest-environment jsdom */
/** @vitest-environment-options {"url":"https://public.example.test"} */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLOUD_SYNC_STORAGE_KEY,
  CLOUD_TOKEN_STORAGE_KEY,
  CloudApiError,
  compareCloudSave,
  compareCloudSaveSummary,
  compressCloudRequestBody,
  deleteCloudSave,
  downloadCloudSave,
  fetchCloudLeaderboard,
  fetchCloudLeaderboardMe,
  fetchCloudPublicStatus,
  fetchCloudStationProfile,
  fetchPublicStation,
  getCloudSyncMarker,
  importLegacyJsonCloudAccountArchive,
  markCloudSaveSynchronized,
  publishCloudStation,
  readLastCloudUploadDiagnostics,
  resumeCloudSession,
  sendCloudStationSignal,
  setCloudStationFavorite,
  setCloudStationVisibility,
  summarizeCloudPayload,
  uploadCloudSave,
  uploadCloudSaveWithOptions,
  type CloudSaveMetadata,
} from "./cloud";
import type { CloudAccountArchiveImportPreview } from "./cloudAccountArchive";
import { createInitialState, createSpeedrunInitialState, placeBuilding } from "./engine";
import { exportGame, importGame } from "./storage";
import { computeSaveStateChecksum } from "./saveEnvelopeIntegrity";
import { sha256Text } from "./payloadDigest";

function payload(checksum: string, elapsedSeconds: number): string {
  return JSON.stringify({
    formatVersion: 2,
    savedAt: 1000 + elapsedSeconds,
    checksum,
    state: {
      version: 24,
      elapsedSeconds,
      activePlanetId: "home",
      entities: [{ id: "entity_1" }],
      research: { completedTechIds: ["electromagnetism"] },
      dysonSphere: { structurePoints: 2 },
      totalProduced: { universe_matrix: 3 },
    },
  });
}

function metadata(revision: number, cloudChecksum: string, source: string): CloudSaveMetadata {
  return {
    revision,
    updatedAt: 2000 + revision,
    size: new TextEncoder().encode(source).byteLength,
    checksum: cloudChecksum,
    summary: summarizeCloudPayload(source),
  };
}

async function exactMetadata(revision: number, source: string): Promise<CloudSaveMetadata> {
  return metadata(revision, await sha256Text(source), source);
}

function largePayload(targetPaddingBytes = 320_000): string {
  const envelope = JSON.parse(payload("state-large", 100)) as { formatVersion: number; state: Record<string, unknown> } & Record<string, unknown>;
  envelope.state.padding = "repeated-upload-data-".repeat(Math.ceil(targetPaddingBytes / 22));
  envelope.checksum = computeSaveStateChecksum(envelope.formatVersion, envelope.state as any);
  return JSON.stringify(envelope);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const LEGACY_IMPORT_PREVIEW = {
  version: 1,
  guard: "b".repeat(64),
  confirmation: `REPLACE_CLOUD_SAVES:${"b".repeat(64)}`,
} as CloudAccountArchiveImportPreview;

class TestCompressionStream {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;

  constructor() {
    const transform = new TransformStream<Uint8Array, Uint8Array>({
      transform(_chunk, controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
      },
    });
    this.readable = transform.readable;
    this.writable = transform.writable;
  }
}

describe("cloud save synchronization markers", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("allows anonymous public status discovery on HTTP without opening account transport", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      activity: { enabled: false, status: "disabled", serverNow: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(fetchCloudPublicStatus()).resolves.toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith("/api/public-status", expect.any(Object));
    fetchMock.mockClear();
    await expect(resumeCloudSession()).resolves.toMatchObject({ status: "anonymous", message: null });
    expect(fetchMock).toHaveBeenCalledWith("/api/health", expect.any(Object));
  });

  it("keeps the public Top 100 read anonymous and requests /leaderboard/me with authentication", async () => {
    const entry = {
      userId: "cloud-user",
      accountId: "cloud-user",
      displayName: "当前账户",
      avatar: "当",
      seasonId: "season_01",
      metrics: { peakThroughputPerMinute: 123 },
      submittedAt: 100,
      value: 123,
      verified: true,
      rank: 137,
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ entries: [] }))
      .mockResolvedValueOnce(jsonResponse({
        status: "ranked",
        entry,
        rank: 137,
        totalEntries: 150,
        serverMetrics: entry.metrics,
        latestWindowState: { status: "ranked", valid: true, value: 123, metricVersion: "settled-total-produced-v1", requiredSeconds: 60, observedSeconds: 60, remainingSeconds: 0, productionDelta: 123, fromRevision: 1, toRevision: 2 },
        mode: "normal",
        slot: "main",
        latestCloudRevision: 2,
        reviewResumeAfterRevision: null,
      }));

    await expect(fetchCloudLeaderboard("throughput", "season_01")).resolves.toEqual([]);
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("authorization")).toBeNull();

    window.localStorage.setItem(CLOUD_TOKEN_STORAGE_KEY, "leaderboard-self-token");
    const result = await fetchCloudLeaderboardMe("throughput", "season_01");
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get("authorization")).toBe("Bearer leaderboard-self-token");
    expect(result).toMatchObject({
      status: "ranked",
      rank: 137,
      totalEntries: 150,
      entry: { rank: 137, metrics: { peakThroughputPerMinute: 123, uploadedWhiteMatrix: 0 } },
      serverMetrics: { peakThroughputPerMinute: 123, uploadedWhiteMatrix: 0 },
      latestWindowState: { status: "ranked", observedSeconds: 60 },
    });
  });

  it("uses strict station routes and never uploads a client-authored public snapshot", async () => {
    const publicId = `station_${"a".repeat(32)}`;
    const social = { favoriteCount: 0, viewerFavorite: false, signals: { spectacular: 0, precise: 0, industrial: 0, layout: 0 }, viewerSignal: null };
    const profile = { visibility: "public", publicId, published: true, sourceRevision: 3, snapshot: null, social };
    window.localStorage.setItem(CLOUD_TOKEN_STORAGE_KEY, "station-client-token");
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ snapshot: { schema: "station-showcase-v1", publicId }, social }))
      .mockResolvedValueOnce(jsonResponse(profile))
      .mockResolvedValueOnce(jsonResponse({ ...profile, snapshot: { schema: "station-showcase-v1", publicId } }))
      .mockResolvedValueOnce(jsonResponse(profile))
      .mockResolvedValueOnce(jsonResponse({ ...profile, visibility: "private" }))
      .mockResolvedValueOnce(jsonResponse({ ...profile, visibility: "private" }))
      .mockResolvedValueOnce(jsonResponse({ social: { ...social, favoriteCount: 1, viewerFavorite: true } }))
      .mockResolvedValueOnce(jsonResponse({ social }))
      .mockResolvedValueOnce(jsonResponse({ social: { ...social, signals: { ...social.signals, layout: 1 }, viewerSignal: "layout" } }));

    await expect(fetchPublicStation(publicId)).resolves.toMatchObject({ snapshot: { publicId } });
    await expect(fetchCloudStationProfile()).resolves.toMatchObject({ sourceRevision: 3 });
    await expect(publishCloudStation()).resolves.toMatchObject({ published: true, publicId });
    await expect(setCloudStationVisibility("private")).resolves.toMatchObject({ visibility: "private" });
    await expect(setCloudStationFavorite(publicId, true)).resolves.toMatchObject({ viewerFavorite: true });
    await expect(setCloudStationFavorite(publicId, false)).resolves.toMatchObject({ viewerFavorite: false });
    await expect(sendCloudStationSignal(publicId, "layout")).resolves.toMatchObject({ viewerSignal: "layout" });

    const requests = fetchMock.mock.calls.map(([url, init]) => ({ url: String(url), init: init as RequestInit }));
    expect(requests[0].url).toBe(`/api/stations/${publicId}`);
    expect(new Headers(requests[0].init.headers).get("authorization")).toBe("Bearer station-client-token");
    expect(requests[2]).toMatchObject({ url: "/api/station/publish", init: { method: "POST", body: "{}" } });
    expect(requests[2].init.body).not.toContain("snapshot");
    expect(requests[4]).toMatchObject({ url: "/api/station/visibility", init: { method: "POST", body: JSON.stringify({ visibility: "private" }) } });
    expect(requests[6]).toMatchObject({ url: `/api/stations/${publicId}/favorite`, init: { method: "POST", body: "{}" } });
    expect(requests[7]).toMatchObject({ url: `/api/stations/${publicId}/favorite`, init: { method: "DELETE" } });
    expect(requests[8]).toMatchObject({ url: `/api/stations/${publicId}/signal`, init: { method: "POST", body: JSON.stringify({ signalId: "layout" }) } });
    fetchMock.mockClear();
    await expect(fetchPublicStation("station_bad")).rejects.toMatchObject({ status: 404 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the original legacy JSON Blob with Bearer auth and the guarded replacement contract", async () => {
    window.localStorage.setItem(CLOUD_TOKEN_STORAGE_KEY, "legacy-json-import-token");
    const archive = new Blob(["{\"schemaVersion\":7}"], { type: "application/json" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      imported: true,
      revisionCount: 2,
      logicalBytes: archive.size,
      guard: "c".repeat(64),
      modes: { normal: { main: { revision: 1 } }, speedrun: { main: { revision: 2 } } },
      leaderboardRevalidationRequired: { normal: true, speedrun: false },
    }));

    await expect(importLegacyJsonCloudAccountArchive(archive, LEGACY_IMPORT_PREVIEW)).resolves.toMatchObject({
      imported: true,
      revisionCount: 2,
      leaderboardRevalidationRequired: { normal: true, speedrun: false },
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/account/import/legacy-json");
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(request.headers);
    expect(request.method).toBe("POST");
    expect(request.body).toBe(archive);
    expect(headers.get("content-type")).toBe("application/vnd.dspidle.account-export+json");
    expect(headers.get("authorization")).toBe("Bearer legacy-json-import-token");
    expect(headers.get("x-dsp-account-import-guard")).toBe(LEGACY_IMPORT_PREVIEW.guard);
    expect(headers.get("x-dsp-account-import-confirmation")).toBe(LEGACY_IMPORT_PREVIEW.confirmation);
    // Browser fetch generates Content-Length from Blob.size when the transport
    // supports it; script code must not try to set this forbidden header.
    expect(headers.has("content-length")).toBe(false);
  });

  it("explains unrecoverable legacy histories and never retries or rewrites the selected body", async () => {
    window.localStorage.setItem(CLOUD_TOKEN_STORAGE_KEY, "legacy-json-import-token");
    const archive = new Blob(["{\"history\":true}"], { type: "application/json" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      error: "history metadata has no payload",
      code: "ACCOUNT_ARCHIVE_LEGACY_JSON_HISTORY_UNRESTORABLE",
    }, 409));

    await expect(importLegacyJsonCloudAccountArchive(archive, LEGACY_IMPORT_PREVIEW)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("请改用 ZIP 账号归档"),
      payload: { code: "ACCOUNT_ARCHIVE_LEGACY_JSON_HISTORY_UNRESTORABLE" },
    } satisfies Partial<CloudApiError>);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).body).toBe(archive);
  });

  it("does not infer speedrun for a legacy JSON mode mismatch and reports old-server incompatibility", async () => {
    window.localStorage.setItem(CLOUD_TOKEN_STORAGE_KEY, "legacy-json-import-token");
    const archive = new Blob(["{}"], { type: "application/json" });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({
        error: "mode mismatch",
        code: "ACCOUNT_ARCHIVE_MODE_MISMATCH",
      }, 400))
      .mockResolvedValueOnce(jsonResponse({ error: "接口不存在" }, 404));

    await expect(importLegacyJsonCloudAccountArchive(archive, LEGACY_IMPORT_PREVIEW)).rejects.toMatchObject({
      message: expect.stringContaining("缺少模式不会被推断为速通"),
      payload: { code: "ACCOUNT_ARCHIVE_MODE_MISMATCH" },
    } satisfies Partial<CloudApiError>);
    await expect(importLegacyJsonCloudAccountArchive(archive, LEGACY_IMPORT_PREVIEW)).rejects.toMatchObject({
      message: expect.stringContaining("当前云节点尚不支持"),
      payload: { code: "LEGACY_JSON_IMPORT_UNSUPPORTED" },
    } satisfies Partial<CloudApiError>);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects an empty legacy JSON file or stale confirmation before any request", async () => {
    window.localStorage.setItem(CLOUD_TOKEN_STORAGE_KEY, "legacy-json-import-token");
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(importLegacyJsonCloudAccountArchive(new Blob([]), LEGACY_IMPORT_PREVIEW)).rejects.toMatchObject({
      payload: { code: "ACCOUNT_ARCHIVE_IMPORT_FILE_INVALID" },
    } satisfies Partial<CloudApiError>);
    await expect(importLegacyJsonCloudAccountArchive(new Blob(["{}"]), {
      ...LEGACY_IMPORT_PREVIEW,
      confirmation: "REPLACE_CLOUD_SAVES:stale",
    })).rejects.toMatchObject({
      payload: { code: "ACCOUNT_ARCHIVE_IMPORT_CONFIRMATION_INVALID" },
    } satisfies Partial<CloudApiError>);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("compares unbound, synchronized and one-sided changes", () => {
    const local = payload("state-a", 100);
    const cloud = metadata(1, "cloud-a", local);
    expect(compareCloudSave("user_a", local, cloud).state).toBe("synced");

    markCloudSaveSynchronized("user_a", cloud, local);
    expect(compareCloudSave("user_a", local, cloud).state).toBe("synced");
    expect(compareCloudSave("user_a", payload("state-b", 200), cloud).state).toBe("local-newer");
    expect(compareCloudSave("user_a", local, { ...cloud, revision: 2, checksum: "cloud-b" }).state).toBe("cloud-newer");
  });

  it("compares a Worker-provided summary without parsing the payload again", () => {
    const local = payload("state-a", 100);
    const cloud = metadata(1, "cloud-a", local);
    const summary = summarizeCloudPayload(local)!;
    expect(compareCloudSaveSummary("user_summary", summary, cloud).state).toBe("synced");
    markCloudSaveSynchronized("user_summary", cloud);
    expect(compareCloudSaveSummary("user_summary", { ...summary, elapsedSeconds: 101 }, cloud).state).toBe("synced");
  });

  it("requires an explicit choice when local and cloud both changed", () => {
    const original = payload("state-a", 100);
    const cloud = metadata(1, "cloud-a", original);
    markCloudSaveSynchronized("user_a", cloud, original);
    const changedCloud = metadata(2, "cloud-b", payload("state-c", 300));
    const comparison = compareCloudSave("user_a", payload("state-b", 200), changedCloud);
    expect(comparison.state).toBe("conflict");
    expect(comparison.localChanged).toBe(true);
    expect(comparison.cloudChanged).toBe(true);
  });

  it("keeps markers isolated per cloud account", () => {
    const local = payload("state-a", 100);
    const cloud = metadata(1, "cloud-a", local);
    markCloudSaveSynchronized("user_a", cloud, local);
    expect(JSON.parse(window.localStorage.getItem(CLOUD_SYNC_STORAGE_KEY) ?? "{}")["user_a:main"].revision).toBe(1);
    expect(compareCloudSave("user_b", payload("state-b", 200), cloud).state).toBe("unbound");
  });

  it("keeps all four save-slot markers independent while reading a legacy main marker", () => {
    const mainPayload = payload("state-main", 100);
    const slotPayload = payload("state-slot-1", 250);
    const main = metadata(3, "cloud-main", mainPayload);
    const manual = { ...metadata(1, "cloud-slot-1", slotPayload), slot: "1" as const };
    markCloudSaveSynchronized("user_slots", main, mainPayload, "main");
    markCloudSaveSynchronized("user_slots", manual, slotPayload, "1");

    expect(compareCloudSave("user_slots", mainPayload, main, "main").state).toBe("synced");
    expect(compareCloudSave("user_slots", slotPayload, manual, "1").state).toBe("synced");
    expect(getCloudSyncMarker("user_slots", "main")?.revision).toBe(3);
    expect(getCloudSyncMarker("user_slots", "1")?.revision).toBe(1);

    window.localStorage.setItem(CLOUD_SYNC_STORAGE_KEY, JSON.stringify({
      legacy_user: { userId: "legacy_user", revision: 4, cloudChecksum: "legacy-cloud", stateChecksum: "state-main", syncedAt: 1 },
    }));
    expect(getCloudSyncMarker("legacy_user", "main")).toMatchObject({ revision: 4, slot: "main" });
    expect(getCloudSyncMarker("legacy_user", "1")).toBeNull();
  });

  it("keeps normal and speedrun synchronization markers independent for the same slot", () => {
    const normalPayload = exportGame(createInitialState());
    const speedrunPayload = exportGame(createSpeedrunInitialState(1_700_000_000_000, "cloud_mode_marker_factory"));
    const normal = { ...metadata(2, "normal-cloud", normalPayload), mode: "normal" as const, slot: "1" as const };
    const speedrun = { ...metadata(5, "speedrun-cloud", speedrunPayload), mode: "speedrun" as const, slot: "1" as const };
    markCloudSaveSynchronized("mode_user", normal, normalPayload, "1", "normal");
    markCloudSaveSynchronized("mode_user", speedrun, speedrunPayload, "1", "speedrun");

    expect(getCloudSyncMarker("mode_user", "1", "normal")?.revision).toBe(2);
    expect(getCloudSyncMarker("mode_user", "1", "speedrun")?.revision).toBe(5);
    expect(compareCloudSave("mode_user", normalPayload, normal, "1", "normal").state).toBe("synced");
    expect(compareCloudSave("mode_user", speedrunPayload, speedrun, "1", "speedrun").state).toBe("synced");
    expect(compareCloudSave("mode_user", normalPayload, speedrun, "1", "normal").state).toBe("unbound");
  });

  it("rejects a downloaded payload whose mode differs from the requested cloud namespace", async () => {
    const normalPayload = exportGame(createInitialState());
    const cloudSave = { ...metadata(1, "normal-cloud", normalPayload), mode: "normal" as const, payload: normalPayload };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ cloudSave }));
    await expect(downloadCloudSave(undefined, "main", "speedrun")).rejects.toMatchObject({
      status: 409,
      payload: { code: "SAVE_MODE_MISMATCH", expectedMode: "speedrun", receivedMode: "normal" },
    });
  });

  it("downloads and deletes only the requested speedrun cloud slot", async () => {
    const speedrunPayload = exportGame(createSpeedrunInitialState(1_700_000_000_000, "cloud_mode_download_factory"));
    const cloudSave = { ...metadata(4, "speedrun-cloud", speedrunPayload), mode: "speedrun" as const, slot: "2" as const, payload: speedrunPayload };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ cloudSave }))
      .mockResolvedValueOnce(jsonResponse({ deleted: true, mode: "speedrun", slot: "2" }));

    await expect(downloadCloudSave(undefined, "2", "speedrun")).resolves.toMatchObject({ mode: "speedrun", slot: "2", revision: 4 });
    await expect(deleteCloudSave("2", 4, "speedrun")).resolves.toBeUndefined();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("slot=2&mode=speedrun");
    const deletion = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(deletion.method).toBe("DELETE");
    expect(JSON.parse(String(deletion.body))).toEqual({
      expectedRevision: 4,
      confirmation: "DELETE_CLOUD_SAVE:speedrun:2",
    });
  });

  it("reads once, re-saves, and uploads a legacy ordinary-building quantumTarget save", async () => {
    let state = createInitialState();
    state.construction.storage_mk1 = 1;
    state.construction.interstellar_logistics_station = 1;
    state = placeBuilding(state, "storage_mk1", { x: 0, y: 0 });
    state = placeBuilding(state, "interstellar_logistics_station", { x: 300, y: 0 });
    const ordinary = state.entities.find((entity) => entity.buildingId === "storage_mk1")!;
    const legacy = JSON.parse(exportGame(state));
    legacy.state.entities.find((entity: Record<string, unknown>) => entity.id === ordinary.id).quantumTarget = false;
    legacy.checksum = computeSaveStateChecksum(legacy.formatVersion, legacy.state);
    const loaded = importGame(JSON.stringify(legacy));
    expect(loaded).not.toBeNull();
    const payload = exportGame(loaded!);
    const saved = JSON.parse(payload);
    expect(saved.state.entities.find((entity: Record<string, unknown>) => entity.id === ordinary.id)).not.toHaveProperty("quantumTarget");

    const cloudSave = { revision: 1, updatedAt: 2, size: payload.length, checksum: "server-checksum", summary: null };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ cloudSave }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await expect(uploadCloudSave(payload, 0)).resolves.toMatchObject({ revision: 1 });
    expect(fetchMock).toHaveBeenCalledWith("/api/cloud-save", expect.objectContaining({ method: "PUT" }));
    const request = fetchMock.mock.calls.at(-1)?.[1] as RequestInit;
    expect(request.body).toBe(payload);
    expect((request.headers as Record<string, string>)["content-type"]).toBe("application/vnd.dspidle.save+json");
    expect((request.headers as Record<string, string>)["x-dsp-expected-revision"]).toBe("0");
  });

  it("streams gzip output before waiting for the compressed body", async () => {
    vi.stubGlobal("CompressionStream", TestCompressionStream);
    const source = largePayload();
    const cloudSave = await exactMetadata(1, source);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ cloudSave }));

    await expect(uploadCloudSaveWithOptions(source, 0, "main", { verified: true })).resolves.toMatchObject({ revision: 1 });
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((request.headers as Record<string, string>)["content-encoding"]).toBe("gzip");
    expect(typeof (request.body as Blob).size).toBe("number");
    expect((request.body as Blob).size).toBeGreaterThan(0);
    expect(readLastCloudUploadDiagnostics()).toMatchObject({
      status: "success",
      attempts: 1,
      usedCompression: true,
    });
  });

  it("falls back to one raw payload request when CompressionStream is unavailable", async () => {
    vi.stubGlobal("CompressionStream", undefined);
    const source = largePayload();
    const cloudSave = await exactMetadata(1, source);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ cloudSave }));

    await expect(uploadCloudSaveWithOptions(source, 0, "main", { verified: true })).resolves.toMatchObject({ revision: 1 });
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((request.headers as Record<string, string>)?.["content-encoding"]).toBeUndefined();
    expect(typeof request.body).toBe("string");
  });

  it.each([256 * 1024, 1024 * 1024, 7 * 1024 * 1024, 20 * 1024 * 1024])(
    "produces bounded gzip for an Android native %i-byte request",
    async (size) => {
      vi.stubGlobal("CompressionStream", TestCompressionStream);
      const compressed = await compressCloudRequestBody("x".repeat(size), undefined, "android", true);
      expect(compressed?.headers["content-encoding"]).toBe("gzip");
      expect(compressed?.body.size).toBeGreaterThan(0);
      expect(compressed?.body.size).toBeLessThan(size);
    },
  );

  it("sends Android native cloud uploads with gzip when available", async () => {
    vi.stubGlobal("CompressionStream", TestCompressionStream);
    const source = largePayload();
    const cloudSave = await exactMetadata(1, source);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ cloudSave }));

    await expect(uploadCloudSaveWithOptions(source, 0, "main", {
      verified: true,
      runtimePlatform: "android",
      androidGzipSupported: true,
    })).resolves.toMatchObject({ revision: 1 });
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(request.body).toBeInstanceOf(Blob);
    expect((request.headers as Record<string, string>)?.["content-encoding"]).toBe("gzip");
    expect((request.headers as Record<string, string>)["x-dsp-expected-revision"]).toBe("0");
  });

  it("retries exactly once as a raw payload after an actual gzip encoding rejection", async () => {
    vi.stubGlobal("CompressionStream", TestCompressionStream);
    const source = largePayload();
    const cloudSave = await exactMetadata(1, source);
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ error: "请求压缩内容无效", code: "REQUEST_ENCODING_INVALID" }, 400))
      .mockResolvedValueOnce(jsonResponse({ cloudSave }));

    await expect(uploadCloudSaveWithOptions(source, 0, "main", { verified: true })).resolves.toMatchObject({ revision: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const compressedRequest = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const rawRequest = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect((compressedRequest.headers as Record<string, string>)["content-encoding"]).toBe("gzip");
    expect(typeof rawRequest.body).toBe("string");
    expect((rawRequest.headers as Record<string, string>)?.["content-encoding"]).toBeUndefined();
    expect(rawRequest.body).toBe(source);
    expect((rawRequest.headers as Record<string, string>)["x-dsp-expected-revision"]).toBe("0");
    expect(readLastCloudUploadDiagnostics()).toMatchObject({
      status: "success",
      attempts: 2,
      usedRawFallback: true,
      fallbackReason: "server-rejected-content-encoding",
    });
  });

  it("falls back once to the legacy JSON envelope when an older API rejects direct payloads", async () => {
    vi.stubGlobal("CompressionStream", undefined);
    const source = largePayload();
    const cloudSave = await exactMetadata(1, source);
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ error: "云存档格式无效，服务器已拒绝上传", code: "SAVE_FORMAT_INVALID" }, 400))
      .mockResolvedValueOnce(jsonResponse({ cloudSave }));

    await expect(uploadCloudSaveWithOptions(source, 0, "main", { verified: true })).resolves.toMatchObject({ revision: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const direct = fetchMock.mock.calls[0][1] as RequestInit;
    const legacy = fetchMock.mock.calls[1][1] as RequestInit;
    expect(direct.body).toBe(source);
    expect((direct.headers as Record<string, string>)["content-type"]).toBe("application/vnd.dspidle.save+json");
    expect((legacy.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect((legacy.headers as Record<string, string>)["x-dsp-expected-revision"]).toBeUndefined();
    expect((legacy.headers as Record<string, string>)["x-dsp-request-id"]).toBeUndefined();
    expect(JSON.parse(String(legacy.body))).toEqual({ payload: source, expectedRevision: 0 });
    expect(readLastCloudUploadDiagnostics()).toMatchObject({
      status: "success",
      attempts: 2,
      usedRawFallback: true,
      fallbackReason: "legacy-api-direct-payload-unsupported",
    });
  });

  it("does not legacy-retry a non-format server rejection", async () => {
    vi.stubGlobal("CompressionStream", undefined);
    const source = largePayload();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ error: "内部完整性校验失败", code: "SAVE_INTEGRITY_INVALID" }, 400),
    );

    await expect(uploadCloudSaveWithOptions(source, 0, "main", { verified: true })).rejects.toMatchObject({
      status: 400,
      payload: { code: "SAVE_INTEGRITY_INVALID" },
    } satisfies Partial<CloudApiError>);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not legacy-retry a format rejection from an API that advertises direct payload support", async () => {
    vi.stubGlobal("CompressionStream", undefined);
    const source = largePayload();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ error: "云存档格式无效", code: "SAVE_FORMAT_INVALID", directPayloadSupported: true }, 400),
    );
    await expect(uploadCloudSaveWithOptions(source, 0, "main", { verified: true })).rejects.toMatchObject({
      status: 400,
      payload: { code: "SAVE_FORMAT_INVALID", directPayloadSupported: true },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("confirms a committed raw fallback after its response times out without sending a third upload", async () => {
    vi.stubGlobal("CompressionStream", TestCompressionStream);
    const source = largePayload();
    const cloudSave = await exactMetadata(1, source);
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ error: "请求压缩内容无效", code: "REQUEST_ENCODING_INVALID" }, 400))
      .mockRejectedValueOnce(new DOMException("timed out", "AbortError"))
      .mockResolvedValueOnce(jsonResponse({ cloudSave }));

    await expect(uploadCloudSaveWithOptions(source, 0, "main", { verified: true })).resolves.toMatchObject({ revision: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(typeof (fetchMock.mock.calls[1]?.[1] as RequestInit).body).toBe("string");
    const compressedHeaders = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    const rawHeaders = (fetchMock.mock.calls[1]?.[1] as RequestInit).headers as Record<string, string>;
    expect(rawHeaders["x-dsp-request-id"]).toBe(compressedHeaders["x-dsp-request-id"]);
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("/api/account");
  });

  it("falls back to a raw payload when the compression reader exceeds its safety timeout", async () => {
    vi.stubGlobal("CompressionStream", TestCompressionStream);
    const descriptor = Object.getOwnPropertyDescriptor(Blob.prototype, "stream");
    Object.defineProperty(Blob.prototype, "stream", {
      configurable: true,
      value: () => new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => undefined) }),
    });
    const source = largePayload();
    const cloudSave = await exactMetadata(1, source);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ cloudSave }));
    const startedAt = Date.now();
    try {
      await expect(uploadCloudSaveWithOptions(source, 0, "main", { verified: true })).resolves.toMatchObject({ revision: 1 });
    } finally {
      if (descriptor) Object.defineProperty(Blob.prototype, "stream", descriptor);
      else delete (Blob.prototype as unknown as { stream?: unknown }).stream;
    }
    expect(Date.now() - startedAt).toBeLessThan(32_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(typeof (fetchMock.mock.calls[0]?.[1] as RequestInit).body).toBe("string");
  }, 35_000);

  it("honors cancellation during compression without sending a raw fallback", async () => {
    vi.stubGlobal("CompressionStream", TestCompressionStream);
    const descriptor = Object.getOwnPropertyDescriptor(Blob.prototype, "stream");
    Object.defineProperty(Blob.prototype, "stream", {
      configurable: true,
      value: () => new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => undefined) }),
    });
    const controller = new AbortController();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    try {
      const pending = uploadCloudSaveWithOptions(largePayload(), 0, "main", { verified: true, signal: controller.signal });
      setTimeout(() => controller.abort(), 20);
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      if (descriptor) Object.defineProperty(Blob.prototype, "stream", descriptor);
      else delete (Blob.prototype as unknown as { stream?: unknown }).stream;
    }
    expect(fetchMock).not.toHaveBeenCalled();
  }, 12_000);

  it("confirms a committed request after a network timeout without creating a second revision", async () => {
    const source = largePayload();
    const cloudSave = await exactMetadata(1, source);
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new DOMException("timed out", "AbortError"))
      .mockResolvedValueOnce(jsonResponse({ cloudSave }));

    await expect(uploadCloudSaveWithOptions(source, 0, "main", { verified: true })).resolves.toMatchObject({ revision: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/api/account");
  });

  it("returns an unknown status without a second PUT when a timed-out request is not yet observed", async () => {
    const source = largePayload();
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new DOMException("timed out", "AbortError"))
      .mockResolvedValueOnce(jsonResponse({ cloudSave: null, cloudSaves: {} }))
      .mockResolvedValueOnce(jsonResponse({ error: "接口不存在" }, 404));

    await expect(uploadCloudSaveWithOptions(source, 0, "main", { verified: true })).rejects.toMatchObject({
      payload: { code: "CLOUD_UPLOAD_STATUS_UNKNOWN" },
    } satisfies Partial<CloudApiError>);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/api/account");
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("/api/operations/");
  });

  it("confirms a timed-out upload from its persisted operation receipt before any retry", async () => {
    const source = largePayload();
    const cloudSave = await exactMetadata(1, source);
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new DOMException("timed out", "AbortError"))
      .mockResolvedValueOnce(jsonResponse({ cloudSave: null, cloudSaves: {} }))
      .mockResolvedValueOnce(jsonResponse({
        receipt: {
          requestId: "cloud_synthetic_receipt",
          status: "succeeded",
          result: { cloudSave },
        },
      }));

    await expect(uploadCloudSaveWithOptions(source, 0, "main", { verified: true })).resolves.toMatchObject({ revision: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).method).toBe("PUT");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/api/account");
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("/api/operations/");
  });

  it("does not send a raw retry above 30 MiB after a timed-out gzip request is not observed", async () => {
    vi.stubGlobal("CompressionStream", TestCompressionStream);
    const source = "x".repeat(30 * 1024 * 1024 + 1);
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new DOMException("timed out", "AbortError"))
      .mockResolvedValueOnce(jsonResponse({ cloudSave: null, cloudSaves: {} }))
      .mockResolvedValueOnce(jsonResponse({ error: "接口不存在" }, 404));

    await expect(uploadCloudSaveWithOptions(source, 0, "main", { verified: true })).rejects.toMatchObject({
      payload: { code: "CLOUD_UPLOAD_STATUS_UNKNOWN" },
    } satisfies Partial<CloudApiError>);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const initialUpload = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((initialUpload.headers as Record<string, string>)["content-encoding"]).toBe("gzip");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/api/account");
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("/api/operations/");
  });

  it("uses an independent confirmation read after cancellation once sending has started", async () => {
    const source = largePayload();
    const cloudSave = await exactMetadata(1, source);
    const controller = new AbortController();
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce((_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
        setTimeout(() => controller.abort(), 0);
      }))
      .mockImplementationOnce((_input, init) => {
        expect(init?.signal?.aborted).toBe(false);
        return Promise.resolve(jsonResponse({ cloudSave }));
      });

    await expect(uploadCloudSaveWithOptions(source, 0, "main", { verified: true, signal: controller.signal })).resolves.toMatchObject({ revision: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects an adjacent revision with the same summary but a different exact payload checksum", async () => {
    const source = largePayload();
    const other = { ...metadata(1, "f".repeat(64), source), summary: summarizeCloudPayload(source) };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new DOMException("timed out", "AbortError"))
      .mockResolvedValueOnce(jsonResponse({ cloudSave: other }))
      .mockResolvedValueOnce(jsonResponse({ error: "操作记录不存在", code: "OPERATION_NOT_FOUND" }, 404));

    await expect(uploadCloudSaveWithOptions(source, 0, "main", { verified: true })).rejects.toMatchObject({
      status: 409,
      payload: { cloudSave: other },
    } satisfies Partial<CloudApiError>);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("turns an unrelated newer cloud revision into a conflict after timeout", async () => {
    const source = largePayload();
    const other = metadata(1, "other-checksum", payload("different", 900));
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new DOMException("timed out", "AbortError"))
      .mockResolvedValueOnce(jsonResponse({ cloudSave: other }))
      .mockResolvedValueOnce(jsonResponse({ error: "操作记录不存在", code: "OPERATION_NOT_FOUND" }, 404));

    await expect(uploadCloudSaveWithOptions(source, 0, "main", { verified: true })).rejects.toMatchObject({
      status: 409,
      payload: { cloudSave: other },
    } satisfies Partial<CloudApiError>);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("honors cancellation before compression and never sends a fallback request", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(compressCloudRequestBody(largePayload(), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

});
