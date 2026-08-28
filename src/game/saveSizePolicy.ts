import { CLOUD_TRANSFER_CONTRACT } from "./cloudTransferContract";

export const MIB_BYTES = 1024 * 1024;
export const CLOUD_SAVE_RAW_SAFE_LIMIT_BYTES = CLOUD_TRANSFER_CONTRACT.rawFallbackSafeLimitBytes;
export const CLOUD_SAVE_NEAR_LIMIT_BYTES = 224 * MIB_BYTES;
export const CLOUD_SAVE_ENDGAME_WARNING_BYTES = 20 * MIB_BYTES;
export const CLOUD_SAVE_LARGE_ENDGAME_BYTES = 32 * MIB_BYTES;
export const CLOUD_SAVE_EXTREME_WARNING_BYTES = 128 * MIB_BYTES;

export type SavePayloadSizeTier = "small" | "medium" | "large" | "endgame" | "near-limit" | "large-endgame" | "extreme" | "over-server-limit";

export interface SavePayloadSizeAssessment {
  bytes: number;
  mebibytes: number;
  tier: SavePayloadSizeTier;
  warning: string | null;
  rawFallbackAllowed: boolean;
}

export function assessSavePayloadSize(bytes: number): SavePayloadSizeAssessment {
  const normalized = Number.isFinite(bytes) ? Math.max(0, Math.floor(bytes)) : 0;
  const tier: SavePayloadSizeTier = normalized > CLOUD_TRANSFER_CONTRACT.savePayloadLimitBytes
    ? "over-server-limit"
    : normalized >= CLOUD_SAVE_NEAR_LIMIT_BYTES
        ? "near-limit"
      : normalized >= CLOUD_SAVE_EXTREME_WARNING_BYTES
        ? "extreme"
        : normalized > CLOUD_SAVE_RAW_SAFE_LIMIT_BYTES
          ? "large-endgame"
      : normalized >= CLOUD_SAVE_ENDGAME_WARNING_BYTES
        ? "endgame"
        : normalized >= 7 * MIB_BYTES
          ? "large"
          : normalized >= MIB_BYTES ? "medium" : "small";
  const warning = tier === "over-server-limit"
    ? "存档已超过当前云端单修订上限；上传前会停止并保留本地与云端旧修订"
    : tier === "extreme"
      ? "这是 128 MiB 以上超大存档；必须使用 gzip，建议先导出本地备份，低内存设备可能无法安全完成压缩"
      : tier === "large-endgame"
        ? "存档已超过 30 MiB 明文回退边界；仍可通过 gzip 上传，但压缩不可用时不会发送明文请求"
    : tier === "near-limit"
      ? "存档已接近 256 MiB 云端上限；仍可通过 gzip 上传，建议立即导出备份并关注后续增长"
      : tier === "endgame"
        ? "这是 20 MiB 级终局存档；保存和上传会在 Worker 中执行并支持取消，但低内存设备可能自动降级"
        : null;
  return {
    bytes: normalized,
    mebibytes: normalized / MIB_BYTES,
    tier,
    warning,
    rawFallbackAllowed: normalized <= CLOUD_SAVE_RAW_SAFE_LIMIT_BYTES,
  };
}

export function utf8Bytes(value: string): number {
  try {
    return new TextEncoder().encode(value).byteLength;
  } catch {
    return value.length;
  }
}
