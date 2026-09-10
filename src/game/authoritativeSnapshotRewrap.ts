import { computeAuthoritativeSaveProofBindingSha256 } from "./authoritativeSaveProof";
import { sha256Bytes } from "./payloadDigest";
import { decodeSavePayloadTransport, prepareSavePayloadTransport } from "./savePayloadCompression";
import { rewrapVerifiedPrimarySaveAsSnapshot } from "./saveTransfer";
import type { AuthoritativeSavePayloadProof } from "./authoritativeSavePersistenceProtocol";
import type { AuthoritativePrimarySnapshotSource } from "./authoritativeSaveSerializationProtocol";

/** Worker-only transform of an already committed primary. The persistence
 * Worker still independently validates the new envelope, catalog and CAS. */
export async function rewrapAuthoritativePrimarySnapshot(
  source: AuthoritativePrimarySnapshotSource,
  savedAt: number,
  reason: string,
): Promise<AuthoritativePrimarySnapshotSource & { compressionDurationMs: number }> {
  const { bindingSha256, ...originalProof } = source.proof;
  if (source.catalogSeed.kind !== "primary" || source.catalogSeed.slot !== "main" ||
    source.catalogSeed.reason !== null || source.summary.kind !== "primary" || source.summary.slot !== "main" ||
    source.summary.savedAt !== source.catalogSeed.savedAt || source.summary.mode !== source.catalogSeed.mode ||
    source.proof.stateChecksum !== source.catalogSeed.stateChecksum || source.summary.stateChecksum !== source.proof.stateChecksum ||
    !(source.bytes instanceof ArrayBuffer) || source.bytes.byteLength !== source.proof.storedByteLength ||
    (source.proof.transportEncoding !== "raw" && source.proof.transportEncoding !== "gzip") ||
    await computeAuthoritativeSaveProofBindingSha256(originalProof, source.catalogSeed) !== bindingSha256 ||
    await sha256Bytes(source.bytes) !== source.proof.storedSha256) {
    throw new Error("自动快照主档来源证明不匹配");
  }
  const decoded = await decodeSavePayloadTransport(source.bytes, source.proof.transportEncoding);
  if (decoded.byteLength !== source.proof.byteLength || await sha256Bytes(decoded) !== source.proof.payloadSha256) {
    throw new Error("自动快照主档来源正文不匹配");
  }
  const reframed = rewrapVerifiedPrimarySaveAsSnapshot(
    new TextDecoder("utf-8", { fatal: true }).decode(decoded), source.proof,
    { formatVersion: 2, savedAt: source.catalogSeed.savedAt, mode: source.catalogSeed.mode }, savedAt, reason,
  );
  if (!reframed) throw new Error("自动快照主档封装不匹配");
  const bytes = new TextEncoder().encode(reframed.raw).buffer;
  if (bytes.byteLength !== reframed.verification.byteLength) throw new Error("自动快照长度不匹配");
  const payloadSha256 = await sha256Bytes(bytes);
  const transport = await prepareSavePayloadTransport(bytes, payloadSha256);
  const catalogSeed = { ...source.catalogSeed, kind: "snapshot" as const, savedAt, reason };
  const summary = { ...source.summary, kind: "snapshot" as const, savedAt, reason };
  const proofWithoutBinding: Omit<AuthoritativeSavePayloadProof, "bindingSha256"> = {
    ...reframed.verification, payloadSha256, transportEncoding: transport.encoding,
    storedByteLength: transport.storedByteLength, storedSha256: transport.storedSha256,
  };
  return {
    bytes: transport.buffer, catalogSeed, summary,
    proof: { ...proofWithoutBinding, bindingSha256: await computeAuthoritativeSaveProofBindingSha256(proofWithoutBinding, catalogSeed) },
    compressionDurationMs: transport.compressionDurationMs,
  };
}
