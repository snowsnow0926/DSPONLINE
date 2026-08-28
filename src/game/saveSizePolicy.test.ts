import { describe, expect, it } from "vitest";
import {
  assessSavePayloadSize,
  CLOUD_SAVE_EXTREME_WARNING_BYTES,
  CLOUD_SAVE_NEAR_LIMIT_BYTES,
  CLOUD_SAVE_RAW_SAFE_LIMIT_BYTES,
  MIB_BYTES,
} from "./saveSizePolicy";

describe("save payload size policy", () => {
  it.each([
    [1 * MIB_BYTES, "medium"],
    [7 * MIB_BYTES, "large"],
    [20 * MIB_BYTES, "endgame"],
    [28 * MIB_BYTES, "endgame"],
    [CLOUD_SAVE_RAW_SAFE_LIMIT_BYTES + 1, "large-endgame"],
    [CLOUD_SAVE_NEAR_LIMIT_BYTES, "near-limit"],
    [CLOUD_SAVE_EXTREME_WARNING_BYTES, "extreme"],
    [64 * MIB_BYTES, "large-endgame"],
    [96 * MIB_BYTES, "large-endgame"],
    [256 * MIB_BYTES, "near-limit"],
    [256 * MIB_BYTES + 1, "over-server-limit"],
  ] as const)("classifies %i bytes as %s", (bytes, tier) => {
    expect(assessSavePayloadSize(bytes).tier).toBe(tier);
  });

  it("does not silently enlarge the raw fallback boundary", () => {
    expect(assessSavePayloadSize(CLOUD_SAVE_RAW_SAFE_LIMIT_BYTES).rawFallbackAllowed).toBe(true);
    expect(assessSavePayloadSize(CLOUD_SAVE_RAW_SAFE_LIMIT_BYTES + 1).rawFallbackAllowed).toBe(false);
  });
});
