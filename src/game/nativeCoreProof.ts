import type { NativeCoreRevisionProof } from "./nativeCoreAuthority";
import type { GameState } from "./types";

const encoder = new TextEncoder();
const SHA256_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/**
 * Small incremental SHA-256 used only for cross-language simulation proofs.
 * WebCrypto has no streaming API, so feeding it a canonical 77 MB string
 * would recreate the very save-time memory spike that the native path removes.
 */
class IncrementalSha256 {
  private readonly state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private readonly block = new Uint8Array(64);
  private readonly blockView = new DataView(this.block.buffer);
  private readonly words = new Uint32Array(64);
  private blockLength = 0;
  private totalBytes = 0;
  private finished = false;

  update(bytes: Uint8Array): this {
    if (this.finished) throw new Error("SHA-256 proof has already been finalized");
    this.totalBytes += bytes.byteLength;
    let offset = 0;
    while (offset < bytes.byteLength) {
      const copied = Math.min(64 - this.blockLength, bytes.byteLength - offset);
      this.block.set(bytes.subarray(offset, offset + copied), this.blockLength);
      this.blockLength += copied;
      offset += copied;
      if (this.blockLength === 64) {
        this.compress();
        this.blockLength = 0;
      }
    }
    return this;
  }

  digestHex(): string {
    if (this.finished) throw new Error("SHA-256 proof has already been finalized");
    this.finished = true;
    const bitLength = this.totalBytes * 8;
    this.block[this.blockLength++] = 0x80;
    if (this.blockLength > 56) {
      this.block.fill(0, this.blockLength);
      this.compress();
      this.blockLength = 0;
    }
    this.block.fill(0, this.blockLength, 56);
    const view = this.blockView;
    view.setUint32(56, Math.floor(bitLength / 0x1_0000_0000), false);
    view.setUint32(60, bitLength >>> 0, false);
    this.compress();
    return [...this.state].map((value) => value.toString(16).padStart(8, "0")).join("");
  }

  private compress(): void {
    const words = this.words;
    const view = this.blockView;
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const x = words[index - 15];
      const y = words[index - 2];
      const sigma0 = (this.rotateRight(x, 7) ^ this.rotateRight(x, 18) ^ (x >>> 3)) >>> 0;
      const sigma1 = (this.rotateRight(y, 17) ^ this.rotateRight(y, 19) ^ (y >>> 10)) >>> 0;
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }
    let a = this.state[0];
    let b = this.state[1];
    let c = this.state[2];
    let d = this.state[3];
    let e = this.state[4];
    let f = this.state[5];
    let g = this.state[6];
    let h = this.state[7];
    for (let index = 0; index < 64; index += 1) {
      const sum1 = (this.rotateRight(e, 6) ^ this.rotateRight(e, 11) ^ this.rotateRight(e, 25)) >>> 0;
      const choose = ((e & f) ^ (~e & g)) >>> 0;
      const temporary1 = (h + sum1 + choose + SHA256_CONSTANTS[index] + words[index]) >>> 0;
      const sum0 = (this.rotateRight(a, 2) ^ this.rotateRight(a, 13) ^ this.rotateRight(a, 22)) >>> 0;
      const majority = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temporary2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    this.state[0] = (this.state[0] + a) >>> 0;
    this.state[1] = (this.state[1] + b) >>> 0;
    this.state[2] = (this.state[2] + c) >>> 0;
    this.state[3] = (this.state[3] + d) >>> 0;
    this.state[4] = (this.state[4] + e) >>> 0;
    this.state[5] = (this.state[5] + f) >>> 0;
    this.state[6] = (this.state[6] + g) >>> 0;
    this.state[7] = (this.state[7] + h) >>> 0;
  }

  private rotateRight(value: number, bits: number): number {
    return ((value >>> bits) | (value << (32 - bits))) >>> 0;
  }
}

class ProofWriter {
  private readonly hash = new IncrementalSha256();
  private readonly numericBytes = new Uint8Array(8);
  private readonly numericView = new DataView(this.numericBytes.buffer);
  private pendingText = "";

  text(value: string): void {
    if (this.pendingText.length + value.length > 64 * 1024) this.flushText();
    if (value.length > 64 * 1024) this.hash.update(encoder.encode(value));
    else this.pendingText += value;
  }

  bytes(value: Uint8Array): void {
    this.flushText();
    this.hash.update(value);
  }

  uint64LittleEndian(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("native core revision is outside the safe integer range");
    this.numericView.setUint32(0, value >>> 0, true);
    this.numericView.setUint32(4, Math.floor(value / 0x1_0000_0000), true);
    this.bytes(this.numericBytes);
  }

  float64LittleEndian(value: unknown): void {
    const numeric = typeof value === "number" && Number.isFinite(value) ? value : 0;
    this.numericView.setFloat64(0, numeric, true);
    // update() consumes these bytes synchronously before this writer reuses them.
    this.bytes(this.numericBytes);
  }

  finish(): string {
    this.flushText();
    return this.hash.digestHex();
  }

  private flushText(): void {
    if (!this.pendingText) return;
    this.hash.update(encoder.encode(this.pendingText));
    this.pendingText = "";
  }
}

function writeCanonical(writer: ProofWriter, value: unknown, arrayEntry = false): void {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    if (arrayEntry) writer.text("null");
    else throw new Error("native core canonical proof encountered a non-persisted value");
    return;
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    writer.text(JSON.stringify(value));
    return;
  }
  if (typeof value === "number") {
    writer.text(Number.isFinite(value) ? JSON.stringify(value) : "null");
    return;
  }
  if (typeof value !== "object") throw new Error(`native core canonical proof does not support ${typeof value}`);
  if (Array.isArray(value)) {
    writer.text("[");
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) writer.text(",");
      writeCanonical(writer, value[index], true);
    }
    writer.text("]");
    return;
  }
  writer.text("{");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => {
    const field = record[key];
    return field !== undefined && typeof field !== "function" && typeof field !== "symbol";
  }).sort();
  keys.forEach((key, index) => {
    if (index > 0) writer.text(",");
    writer.text(JSON.stringify(key));
    writer.text(":");
    writeCanonical(writer, record[key]);
  });
  writer.text("}");
}

export function canonicalNativeCoreSha256(value: unknown): string {
  const writer = new ProofWriter();
  writeCanonical(writer, value);
  return writer.finish();
}

function writeUint64LittleEndian(writer: ProofWriter, value: number): void {
  writer.uint64LittleEndian(value);
}

function writeFloat64LittleEndian(writer: ProofWriter, value: unknown): void {
  writer.float64LittleEndian(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function sortedInventoryEntries(
  value: unknown,
  symbols: Map<string, number>,
): Array<{ item: string; symbol: number; amount: number }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  const entries: Array<{ item: string; symbol: number; amount: number }> = [];
  for (const item of Object.keys(record).sort()) {
    const amount = record[item];
    if (typeof amount !== "number" || !Number.isFinite(amount)) continue;
    let symbol = symbols.get(item);
    if (symbol === undefined) {
      symbol = symbols.size;
      symbols.set(item, symbol);
    }
    entries.push({ item, symbol, amount });
  }
  return entries.sort((left, right) => left.symbol - right.symbol);
}

function buildNativeSymbolTable(state: GameState): Map<string, number> {
  const symbols = new Map<string, number>();
  const intern = (value: unknown) => {
    const text = optionalString(value);
    if (text !== null && !symbols.has(text)) symbols.set(text, symbols.size);
  };
  for (const entity of state.entities as unknown as Array<Record<string, unknown>>) {
    intern(entity.kind);
    intern(entity.planetId);
    intern(entity.buildingId);
    intern(entity.recipeId);
    intern(entity.resourceId);
    intern(entity.storedItemId);
  }
  for (const belt of state.belts as unknown as Array<Record<string, unknown>>) {
    intern(belt.planetId);
    intern(belt.source);
    intern(belt.target);
    intern(belt.itemId);
  }
  return symbols;
}

/** Matches CoreState::domain_sha256 without serializing the full save. */
export function nativeCoreDomainSha256(state: GameState, revision: number): string {
  const writer = new ProofWriter();
  writer.text("dsp-native-domain-v1\0");
  writeUint64LittleEndian(writer, revision);
  const base = state as unknown as Record<string, unknown>;
  for (const key of ["version", "mode", "activePlanetId", "elapsedSeconds", "paused"]) {
    if (Object.prototype.hasOwnProperty.call(base, key)) writeCanonical(writer, base[key]);
    writer.bytes(new Uint8Array([0]));
  }
  const symbols = buildNativeSymbolTable(state);
  for (const entity of state.entities as unknown as Array<Record<string, unknown>>) {
    const id = optionalString(entity.id);
    if (id === null) throw new Error("native core proof entity ID is missing");
    writer.text(id);
    writer.bytes(new Uint8Array([0]));
    for (const entry of sortedInventoryEntries(entity.inputs, symbols)) {
      writer.text(entry.item);
      writeFloat64LittleEndian(writer, entry.amount);
    }
    writer.text("|");
    for (const entry of sortedInventoryEntries(entity.outputs, symbols)) {
      writer.text(entry.item);
      writeFloat64LittleEndian(writer, entry.amount);
    }
    writeFloat64LittleEndian(writer, entity.progress);
    writeFloat64LittleEndian(writer, entity.utilization);
    writeFloat64LittleEndian(writer, entity.productionRate);
  }
  for (const belt of state.belts as unknown as Array<Record<string, unknown>>) {
    const id = optionalString(belt.id);
    if (id === null) throw new Error("native core proof belt ID is missing");
    writer.text(id);
    writeFloat64LittleEndian(writer, belt.progress);
    writeFloat64LittleEndian(writer, belt.totalTransferred);
    writeFloat64LittleEndian(writer, belt.lastFlow);
  }
  return writer.finish();
}

export function createNativeCoreRevisionProof(
  state: GameState,
  revision: number,
  rootHash: string,
  registryFingerprint: string,
): NativeCoreRevisionProof {
  if (!/^[a-f0-9]{64}$/.test(rootHash)) throw new Error("native core checkpoint root hash is invalid");
  if (!registryFingerprint) throw new Error("native core registry fingerprint is missing");
  return {
    revision,
    rootHash,
    canonicalSha256: canonicalNativeCoreSha256(state),
    domainSha256: nativeCoreDomainSha256(state, revision),
    registryFingerprint,
  };
}
