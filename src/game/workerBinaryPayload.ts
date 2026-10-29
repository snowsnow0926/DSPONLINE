/**
 * Immutable bulk bytes exchanged between browser Workers.
 *
 * ArrayBuffer transfer is retained for existing one-owner protocols. Blob is
 * used by the large-save relay path because structured-cloning an immutable
 * Blob only moves a small handle through the UI event loop; the bytes are
 * materialized again only inside the destination Worker.
 */
export type WorkerBinaryPayload = ArrayBuffer | Blob;

export function isWorkerBinaryPayload(value: unknown): value is WorkerBinaryPayload {
  return value instanceof ArrayBuffer || (typeof Blob !== "undefined" && value instanceof Blob);
}

export function workerBinaryPayloadByteLength(value: WorkerBinaryPayload): number {
  return value instanceof ArrayBuffer ? value.byteLength : value.size;
}

export async function workerBinaryPayloadToArrayBuffer(value: WorkerBinaryPayload): Promise<ArrayBuffer> {
  return value instanceof ArrayBuffer ? value : value.arrayBuffer();
}

export function workerBinaryPayloadTransferables(value: WorkerBinaryPayload): Transferable[] {
  return value instanceof ArrayBuffer ? [value] : [];
}

export function createImmutableWorkerBinaryPayload(
  value: ArrayBuffer,
  transport: "array-buffer" | "blob",
): WorkerBinaryPayload {
  return transport === "blob"
    ? new Blob([value], { type: "application/json;charset=utf-8" })
    : value;
}
