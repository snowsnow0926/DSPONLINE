/** @vitest-environment jsdom */
/** @vitest-environment-options {"url":"https://public.example.test"} */

import { afterEach, describe, expect, it, vi } from "vitest";
import { uploadCloudSaveWithOptions } from "./cloud";
import { computeSaveStateChecksum } from "./saveEnvelopeIntegrity";
import { sha256Text } from "./payloadDigest";

const rawSizesMiB = [1, 7, 8, 20, 28, 30] as const;

function payloadNearSize(mebibytes: number, mode: "normal" | "speedrun"): string {
  const target = mebibytes * 1024 * 1024;
  const state = {
    version: 46,
    mode,
    elapsedSeconds: mebibytes * 60,
    entities: [],
    belts: [],
    padding: "x".repeat(Math.max(0, target - 320)),
  };
  const envelope = { formatVersion: 2, savedAt: 1_800_000_000_000 + mebibytes, mode, state };
  return JSON.stringify({ ...envelope, checksum: computeSaveStateChecksum(envelope.formatVersion, state) });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

describe("cloud transfer size matrix", () => {
  it.each(rawSizesMiB)("keeps the established %i MiB raw direct-upload path unchanged", async (mebibytes) => {
    vi.stubGlobal("CompressionStream", undefined);
    const mode = mebibytes % 2 === 0 ? "speedrun" as const : "normal" as const;
    const slot = (["main", "1", "2", "3"] as const)[mebibytes % 4];
    const source = payloadNearSize(mebibytes, mode);
    const checksum = await sha256Text(source);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      cloudSave: {
        mode,
        slot,
        revision: 1,
        updatedAt: 2,
        size: new TextEncoder().encode(source).byteLength,
        checksum,
        summary: null,
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(uploadCloudSaveWithOptions(source, 0, slot, { mode, verified: true, payloadSha256: checksum }))
      .resolves.toMatchObject({ revision: 1, mode, slot });
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(request.body).toBe(source);
    expect((request.headers as Record<string, string>)["content-type"]).toBe("application/vnd.dspidle.save+json");
    expect((request.headers as Record<string, string>)["x-dsp-expected-revision"]).toBe("0");
    expect((request.headers as Record<string, string>)["x-dsp-save-original-bytes"]).toBe(String(new TextEncoder().encode(source).byteLength));
  }, 30_000);

  it.each([33, 40, 48, 80] as const)("preflights and gzip-uploads a %i MiB endgame save", async (mebibytes) => {
    vi.stubGlobal("CompressionStream", class {
      readonly readable: ReadableStream<Uint8Array>;
      readonly writable: WritableStream<Uint8Array>;
      constructor() {
        const transform = new TransformStream<Uint8Array, Uint8Array>({
          transform(_chunk, controller) { controller.enqueue(new Uint8Array([31, 139, 8, 0])); },
        });
        this.readable = transform.readable;
        this.writable = transform.writable;
      }
    });
    const mode = mebibytes === 40 ? "speedrun" as const : "normal" as const;
    const source = payloadNearSize(mebibytes, mode);
    const checksum = await sha256Text(source);
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ plan: { accepted: true, reason: null, code: null } }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ cloudSave: { mode, slot: "main", revision: 1, updatedAt: 2, size: new TextEncoder().encode(source).byteLength, checksum, summary: null } }), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(uploadCloudSaveWithOptions(source, 0, "main", { mode, verified: true, payloadSha256: checksum })).resolves.toMatchObject({ revision: 1, mode });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/cloud-save/quota");
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).method).toBe("POST");
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).body).toBeInstanceOf(Blob);
    expect(((fetchMock.mock.calls[1]?.[1] as RequestInit).headers as Record<string, string>)["content-encoding"]).toBe("gzip");
  }, 60_000);

  it("rejects a direct payload above the 96 MiB server save boundary before fetch", async () => {
    const source = payloadNearSize(97, "normal");
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(uploadCloudSaveWithOptions(source, 0, "main", { verified: true })).rejects.toMatchObject({
      status: 413,
      payload: { code: "SAVE_SIZE_TOO_LARGE" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  }, 60_000);
});
