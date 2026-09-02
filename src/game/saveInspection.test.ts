/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { computeSavePayloadChecksum } from "./saveTransfer";
import { inspectSave } from "./storage";
import { inspectSavePayloadBytesInWorker } from "./saveInspection";

class InspectWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  terminateCount = 0;
  transferred = false;

  postMessage(message: { id: number; bytes: ArrayBuffer }, transfer: Transferable[] = []): void {
    expect(transfer).toHaveLength(1);
    expect(transfer[0]).toBe(message.bytes);
    // Model the browser's ownership transfer. The source buffer is detached;
    // the Worker receives the independent structured-cloned copy.
    const request = structuredClone(message, { transfer }) as typeof message;
    this.transferred = true;
    const raw = new TextDecoder().decode(request.bytes);
    const inspection = inspectSave(raw);
    queueMicrotask(() => this.onmessage?.({
      data: {
        id: request.id,
        inspection,
        payloadChecksum: computeSavePayloadChecksum(request.bytes),
        byteLength: request.bytes.byteLength,
      },
    } as MessageEvent));
  }

  terminate(): void {
    this.terminateCount += 1;
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("save inspection byte transfer", () => {
  it("falls back without a Worker while preserving the exact UTF-8 checksum", async () => {
    vi.stubGlobal("Worker", undefined);
    const raw = JSON.stringify({ state: { version: 47, marker: "量子🚀" } });
    const bytes = new TextEncoder().encode(raw).buffer;
    const result = await inspectSavePayloadBytesInWorker(bytes);
    expect(result.worker).toBe(false);
    expect(result.byteLength).toBe(bytes.byteLength);
    expect(result.payloadChecksum).toBe(computeSavePayloadChecksum(bytes));
    expect(result.inspection.valid).toBe(false);
  });

  it("transfers local bytes and accepts only a matching Worker length/hash envelope", async () => {
    const worker = new InspectWorker();
    vi.stubGlobal("Worker", class { constructor() { return worker; } });
    const raw = JSON.stringify({ state: { version: 47, marker: "belt" } });
    const bytes = new TextEncoder().encode(raw).buffer;
    const expectedChecksum = computeSavePayloadChecksum(bytes);
    const result = await inspectSavePayloadBytesInWorker(bytes);
    expect(worker.transferred).toBe(true);
    expect(worker.terminateCount).toBe(1);
    expect(bytes.byteLength).toBe(0);
    expect(result.worker).toBe(true);
    expect(result.byteLength).toBe(new TextEncoder().encode(raw).byteLength);
    expect(result.payloadChecksum).toBe(expectedChecksum);
  });

  it("rereads lazily when the Worker returns a malformed response", async () => {
    const fallbackWorker = new InspectWorker();
    fallbackWorker.postMessage = function postMalformed(message, transfer = []) {
      structuredClone(message, { transfer });
      queueMicrotask(() => this.onmessage?.({
        data: { id: message.id, inspection: inspectSave("{}"), payloadChecksum: "bad", byteLength: 0 },
      } as MessageEvent));
    };
    vi.stubGlobal("Worker", class { constructor() { return fallbackWorker; } });
    const raw = JSON.stringify({ state: { version: 47, marker: "fallback" } });
    const bytes = new TextEncoder().encode(raw).buffer;
    let rereads = 0;
    const result = await inspectSavePayloadBytesInWorker(bytes, undefined, async () => {
      rereads += 1;
      return raw;
    });
    expect(rereads).toBe(1);
    expect(result.worker).toBe(false);
    // The fallback rereads text only to build the inspection graph; the
    // verification identity remains the original transferred byte payload.
    expect(result.payloadChecksum).toBe(computeSavePayloadChecksum(new TextEncoder().encode(raw).buffer));
  });
});
