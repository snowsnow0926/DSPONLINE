export const NATIVE_BLUEPRINT_IMPORT_RAW_BYTES = 1_048_576;

const UTF8_ENCODER = new TextEncoder();
const FATAL_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export type NativeBlueprintImportInputFailure =
  | "empty"
  | "invalid-unicode"
  | "invalid-utf8"
  | "too-large"
  | "read-failed";

export type NativeBlueprintImportInputResult = Readonly<
  | { ok: true; raw: string; rawBytes: number }
  | { ok: false; reason: NativeBlueprintImportInputFailure }
>;

function hasWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

/** Validates paste input without parsing or normalizing the exchange JSON. */
export function validateNativeBlueprintImportRaw(raw: unknown): NativeBlueprintImportInputResult {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return Object.freeze({ ok: false as const, reason: "empty" as const });
  }
  if (!hasWellFormedUnicode(raw)) {
    return Object.freeze({ ok: false as const, reason: "invalid-unicode" as const });
  }
  const rawBytes = UTF8_ENCODER.encode(raw).byteLength;
  if (rawBytes > NATIVE_BLUEPRINT_IMPORT_RAW_BYTES) {
    return Object.freeze({ ok: false as const, reason: "too-large" as const });
  }
  return Object.freeze({ ok: true as const, raw, rawBytes });
}

/**
 * Refuses an oversized file from metadata before reading it, then performs a
 * fatal UTF-8 decode and exact UTF-8 round trip. No exchange parser runs here.
 */
export async function readNativeBlueprintImportFile(
  file: Pick<File, "size" | "arrayBuffer">,
): Promise<NativeBlueprintImportInputResult> {
  if (!Number.isSafeInteger(file.size) || file.size < 1) {
    return Object.freeze({ ok: false as const, reason: "empty" as const });
  }
  if (file.size > NATIVE_BLUEPRINT_IMPORT_RAW_BYTES) {
    return Object.freeze({ ok: false as const, reason: "too-large" as const });
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    return Object.freeze({ ok: false as const, reason: "read-failed" as const });
  }
  if (bytes.byteLength !== file.size || bytes.byteLength > NATIVE_BLUEPRINT_IMPORT_RAW_BYTES) {
    return Object.freeze({ ok: false as const, reason: "too-large" as const });
  }
  let raw: string;
  try {
    raw = FATAL_UTF8_DECODER.decode(bytes);
  } catch {
    return Object.freeze({ ok: false as const, reason: "invalid-utf8" as const });
  }
  if (!hasWellFormedUnicode(raw)) {
    return Object.freeze({ ok: false as const, reason: "invalid-unicode" as const });
  }
  const encoded = UTF8_ENCODER.encode(raw);
  if (!sameBytes(encoded, bytes)) {
    return Object.freeze({ ok: false as const, reason: "invalid-utf8" as const });
  }
  const validated = validateNativeBlueprintImportRaw(raw);
  return validated.ok
    ? Object.freeze({ ...validated, rawBytes: bytes.byteLength })
    : validated;
}
