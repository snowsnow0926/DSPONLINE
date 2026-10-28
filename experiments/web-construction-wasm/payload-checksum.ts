import { createContentPackRegistry } from "../../src/game/contentPacks";
import { projectPersistentSaveState } from "../../src/game/saveProjection";
import { computeSavePayloadChecksum, serializeSaveEnvelopeToTransfer } from "../../src/game/saveTransfer";
import type { GameState } from "../../src/game/types";

interface ChecksumExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  reserve_checksum_input(length: number): number;
  checksum_payload(): number;
  output_pointer(): number;
}

function unrolledChecksum(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  let index = 0;
  for (; index + 7 < bytes.length; index += 8) {
    hash = Math.imul(hash ^ bytes[index], 0x01000193);
    hash = Math.imul(hash ^ bytes[index + 1], 0x01000193);
    hash = Math.imul(hash ^ bytes[index + 2], 0x01000193);
    hash = Math.imul(hash ^ bytes[index + 3], 0x01000193);
    hash = Math.imul(hash ^ bytes[index + 4], 0x01000193);
    hash = Math.imul(hash ^ bytes[index + 5], 0x01000193);
    hash = Math.imul(hash ^ bytes[index + 6], 0x01000193);
    hash = Math.imul(hash ^ bytes[index + 7], 0x01000193);
  }
  for (; index < bytes.length; index++) hash = Math.imul(hash ^ bytes[index], 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

const digest = async (bytes: Uint8Array<ArrayBuffer>) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
  .map((value) => value.toString(16).padStart(2, "0")).join("");

function call(wasm: ChecksumExports, bytes: Uint8Array<ArrayBuffer>) {
  const start = performance.now();
  const memoryBeforeBytes = wasm.memory.buffer.byteLength;
  const pointer = wasm.reserve_checksum_input(bytes.byteLength);
  if (!pointer) throw new Error("WASM checksum allocation rejected");
  const allocatedAt = performance.now();
  new Uint8Array(wasm.memory.buffer, pointer, bytes.byteLength).set(bytes);
  const copiedAt = performance.now();
  const length = wasm.checksum_payload();
  const computedAt = performance.now();
  const result = JSON.parse(new TextDecoder().decode(new Uint8Array(wasm.memory.buffer, wasm.output_pointer(), length))) as { checksum: string };
  if (!/^[0-9a-f]{8}$/.test(result.checksum)) throw new Error("WASM checksum output invalid");
  const finishedAt = performance.now();
  return { checksum: result.checksum, durationMs: finishedAt - start,
    allocationMs: allocatedAt - start, inputCopyMs: copiedAt - allocatedAt,
    kernelAndOutputEncodingMs: computedAt - copiedAt, resultReadMs: finishedAt - computedAt,
    memoryBeforeBytes, memoryAfterBytes: wasm.memory.buffer.byteLength };
}

async function runPayloadChecksum() {
  const { bytes, expected } = await (async () => {
    const state = (await (await fetch("/prepared.json")).json()).state as GameState;
    const projected = projectPersistentSaveState(state, createContentPackRegistry());
    const result = serializeSaveEnvelopeToTransfer(projected, { formatVersion: 2, savedAt: 1_800_000_000_000,
      kind: "primary", mode: state.mode, slot: "main" });
    return { bytes: new Uint8Array(result.bytes), expected: result.payloadChecksum };
  })();
  const before = await digest(bytes);
  const coldStart = performance.now();
  const { instance, module } = await WebAssembly.instantiateStreaming(fetch("/kernel.wasm"));
  const loadedAt = performance.now();
  const wasm = instance.exports as ChecksumExports;
  const cold = call(wasm, bytes);
  const coldTotalMs = performance.now() - coldStart;
  if (cold.checksum !== expected) throw new Error("Cold WASM checksum changed full payload");
  const samples = [];
  for (const implementation of ["js", "unrolled", "wasm", "wasm", "unrolled", "js"] as const) {
    if (implementation === "wasm") {
      const result = call(wasm, bytes);
      if (result.checksum !== expected) throw new Error("WASM checksum changed full payload");
      samples.push({ implementation, ...result });
    } else {
      const start = performance.now();
      const checksum = implementation === "js" ? computeSavePayloadChecksum(bytes) : unrolledChecksum(bytes);
      const durationMs = performance.now() - start;
      if (checksum !== expected) throw new Error("JS checksum changed full payload");
      samples.push({ implementation, checksum, durationMs });
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  // Boundary vectors use another small instance after every timed sample.
  const vectorInstance = await WebAssembly.instantiate(module);
  const vectors: Uint8Array<ArrayBuffer>[] = [new Uint8Array(), new TextEncoder().encode("hello"),
    new TextEncoder().encode("中文🙂"), Uint8Array.from({ length: 256 }, (_, index) => index)];
  for (let size = 1; size <= 17; size++) {
    const source = Uint8Array.from({ length: size + 9 }, (_, index) => (index * 73 + size) & 255);
    vectors.push(source.subarray(3, 3 + size));
  }
  for (const vector of vectors) {
    const baseline = computeSavePayloadChecksum(vector);
    if (call(vectorInstance.exports as ChecksumExports, vector).checksum !== baseline || unrolledChecksum(vector) !== baseline) {
      throw new Error("Checksum byte/Unicode/view boundary differs");
    }
  }
  const vectorWasm = vectorInstance.exports as ChecksumExports;
  if (vectorWasm.reserve_checksum_input(128 * 1024 * 1024 + 1) !== 0) throw new Error("Oversized input accepted");
  if (call(vectorWasm, new TextEncoder().encode("hello")).checksum !== "4f9f2cab") throw new Error("Rejected allocation left stale input");
  if (before !== await digest(bytes)) throw new Error("Input bytes changed during checksum probe");
  return { scope: "raw UTF-8 payload FNV only, distinct from UTF-16 state checksum; JS/WASM allocation/copy/result read included; no IDB/UI/whole-handoff qualification",
    rawBytes: bytes.byteLength, payloadSha256: before, expectedChecksum: expected, inputUnchanged: true,
    coldWasm: { loopbackFetchCompileInstantiateMs: loadedAt - coldStart, totalWithLoadMs: coldTotalMs, ...cold },
    samples, vectorCases: vectors.length, oversizedRejected: true,
    retainedWasmLinearMemoryBytes: wasm.memory.buffer.byteLength,
    wasmFunction: "unmodified dsp_native_core::canonical::fnv1a_utf8", forcedGc: false };
}

Object.assign(globalThis, { runPayloadChecksum });
