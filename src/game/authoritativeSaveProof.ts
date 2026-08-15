import { sha256Bytes } from "./payloadDigest";
import type { GameSettings } from "./types";
import type { AuthoritativeSaveCatalogSeed, AuthoritativeSavePayloadProof } from "./authoritativeSavePersistenceProtocol";

function canonicalJsonValue(value: unknown, ancestors: Set<object>): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("authoritative save binding 不接受非有限数值");
    return JSON.stringify(value);
  }
  if (!value || typeof value !== "object") {
    throw new Error(`authoritative save binding 不接受 ${typeof value}`);
  }
  if (ancestors.has(value)) throw new Error("authoritative save binding 不接受循环对象");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) throw new Error("authoritative save binding 不接受稀疏数组");
        items.push(canonicalJsonValue(value[index], ancestors));
      }
      return `[${items.join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("authoritative save binding 只接受plain JSON object");
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJsonValue(record[key], ancestors)}`).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalAuthoritativeSaveJson(value: unknown): string {
  return canonicalJsonValue(value, new Set());
}

export function canonicalizeAuthoritativeSaveSettings(value: unknown): Partial<GameSettings> | null {
  if (value === null || value === undefined) return null;
  const canonical = canonicalAuthoritativeSaveJson(value);
  const parsed = JSON.parse(canonical) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Partial<GameSettings>
    : null;
}

export async function computeAuthoritativeSaveProofBindingSha256(
  proof: Omit<AuthoritativeSavePayloadProof, "bindingSha256">,
  seed: AuthoritativeSaveCatalogSeed,
): Promise<string> {
  const payload = canonicalAuthoritativeSaveJson({ proof, seed });
  return sha256Bytes(new TextEncoder().encode(payload));
}
