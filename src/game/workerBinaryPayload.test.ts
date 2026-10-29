// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { releaseOwnedWorkerPayloadBuffer as release, workerBinaryPayloadToArrayBuffer } from "./workerBinaryPayload";

const descriptor = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "transfer");
const nativeTransfer = typeof descriptor?.value === "function";
afterEach(() => {
  if (descriptor) Object.defineProperty(ArrayBuffer.prototype, "transfer", descriptor);
  else Reflect.deleteProperty(ArrayBuffer.prototype, "transfer");
});
const override = (value: unknown) => Object.defineProperty(ArrayBuffer.prototype, "transfer", {
  configurable: true, writable: true, value,
});

describe("owned Worker payload storage release", () => {
  it.skipIf(!nativeTransfer)("detaches only the consumed fresh buffer", () => {
    const original = Uint8Array.of(8, 7, 6); const decoded = Uint8Array.of(1, 2, 3, 4).buffer;
    expect(release(decoded, original.buffer)).toBe(true);
    expect(decoded.byteLength).toBe(0); expect([...original]).toEqual([8, 7, 6]);
  });
  it("keeps raw input identity usable for return and retry", async () => {
    const original = Uint8Array.of(1, 2, 3);
    expect(await workerBinaryPayloadToArrayBuffer(original.buffer)).toBe(original.buffer);
    expect(release(original.buffer, original.buffer)).toBe(false);
    expect([...original]).toEqual([1, 2, 3]);
  });
  it.skipIf(!nativeTransfer)("preserves fully decoded Unicode JSON after releasing its bytes", () => {
    const text = '{"state":{"label":"量子🚀","amount":"12345678901234567890"}}';
    const decoded = new TextEncoder().encode(text).buffer;
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
    expect(release(decoded, Uint8Array.of(9).buffer)).toBe(true);
    expect(raw).toBe(text); expect(JSON.parse(raw).state.amount).toBe("12345678901234567890");
  });
  it.skipIf(!nativeTransfer)("retains the original immutable Blob for recovery", async () => {
    const expected = new TextEncoder().encode("完整存档🚀"); const original = new Blob([expected]);
    const decoded = await workerBinaryPayloadToArrayBuffer(original);
    expect(release(decoded, original)).toBe(true); expect(decoded.byteLength).toBe(0);
    expect(new Uint8Array(await original.arrayBuffer())).toEqual(expected);
  });
  it.skipIf(!nativeTransfer)("invalidates fresh decoded views while preserving original views", () => {
    const original = Uint8Array.of(5, 4, 3).buffer; const decoded = Uint8Array.of(1, 2).buffer;
    const decodedView = new DataView(decoded); const originalView = new DataView(original);
    expect(release(decoded, original)).toBe(true);
    expect(() => decodedView.getUint8(0)).toThrow(TypeError); expect(originalView.getUint8(0)).toBe(5);
  });
  it("leaves buffers intact when transfer is unsupported", () => {
    override(undefined); const original = Uint8Array.of(7); const decoded = Uint8Array.of(1, 2);
    expect(release(decoded.buffer, original.buffer)).toBe(false);
    expect([...decoded]).toEqual([1, 2]); expect([...original]).toEqual([7]);
  });
  it("keeps cleanup errors from failing a valid save", () => {
    override(() => { throw Error("unavailable"); });
    const original = Uint8Array.of(7); const decoded = Uint8Array.of(1, 2);
    expect(release(decoded.buffer, original.buffer)).toBe(false);
    expect([...decoded]).toEqual([1, 2]); expect([...original]).toEqual([7]);
  });
  it("handles prototype access failure without changing either payload", () => {
    Object.defineProperty(ArrayBuffer.prototype, "transfer", { configurable: true, get() { throw Error("blocked"); } });
    const original = Uint8Array.of(7); const decoded = Uint8Array.of(1, 2);
    expect(release(decoded.buffer, original.buffer)).toBe(false);
    expect([...decoded]).toEqual([1, 2]); expect([...original]).toEqual([7]);
  });
  it.skipIf(!nativeTransfer)("can release an empty fresh buffer without touching its source", () => {
    const original = Uint8Array.of(7);
    expect(release(new ArrayBuffer(0), original.buffer)).toBe(true);
    expect([...original]).toEqual([7]);
  });
  it.skipIf(!nativeTransfer)("treats an already detached fresh buffer as a nonfatal no-op", () => {
    const original = Uint8Array.of(7); const decoded = Uint8Array.of(1, 2).buffer;
    Reflect.apply(descriptor!.value, decoded, [0]);
    expect(release(decoded, original.buffer)).toBe(false); expect([...original]).toEqual([7]);
  });
});
