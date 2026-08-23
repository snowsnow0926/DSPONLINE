import { describe, expect, it } from "vitest";
import { CLOUD_TRANSFER_CONTRACT, cloudRequestTimeoutMs, validCloudExpectedRevision } from "./cloudTransferContract";
import serverContract from "../../server/cloud-transfer-contract.json";

describe("cloud transfer contract", () => {
  it("keeps legacy 30 MiB raw uploads and 64 MiB gzip uploads inside bounded 96 MiB transport limits", () => {
    expect(CLOUD_TRANSFER_CONTRACT.guaranteedSavePayloadBytes).toBe(64 * 1024 * 1024);
    expect(CLOUD_TRANSFER_CONTRACT.rawFallbackSafeLimitBytes).toBe(30 * 1024 * 1024);
    expect(CLOUD_TRANSFER_CONTRACT.savePayloadLimitBytes).toBe(96 * 1024 * 1024 - 1024);
    expect(CLOUD_TRANSFER_CONTRACT.requestExpandedLimitBytes).toBeGreaterThan(CLOUD_TRANSFER_CONTRACT.savePayloadLimitBytes);
    expect(CLOUD_TRANSFER_CONTRACT.requestCompressedLimitBytes).toBeGreaterThan(CLOUD_TRANSFER_CONTRACT.guaranteedSavePayloadBytes);
    expect(CLOUD_TRANSFER_CONTRACT.requestCompressedLimitBytes).toBeLessThan(CLOUD_TRANSFER_CONTRACT.requestExpandedLimitBytes);
    expect(CLOUD_TRANSFER_CONTRACT.maximumConcurrentExpandedBytes).toBeGreaterThan(CLOUD_TRANSFER_CONTRACT.requestExpandedLimitBytes);
    expect(CLOUD_TRANSFER_CONTRACT.singleSaveResponseLimitBytes).toBeGreaterThan(
      CLOUD_TRANSFER_CONTRACT.guaranteedSavePayloadBytes * 2,
    );
    expect(CLOUD_TRANSFER_CONTRACT.maximumConcurrentExpandedBytes).toBe(128 * 1024 * 1024);
  });

  it("scales timeout with transfer size and caps it", () => {
    expect(cloudRequestTimeoutMs()).toBe(CLOUD_TRANSFER_CONTRACT.baseTimeoutMs);
    expect(cloudRequestTimeoutMs(30 * 1024 * 1024)).toBe(60_000);
    expect(cloudRequestTimeoutMs(48 * 1024 * 1024)).toBe(87_000);
    expect(cloudRequestTimeoutMs(96 * 1024 * 1024)).toBe(159_000);
    expect(cloudRequestTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(CLOUD_TRANSFER_CONTRACT.maximumTimeoutMs);
  });

  it("keeps the packaged API copy byte-for-byte equivalent", () => {
    expect(serverContract).toEqual(CLOUD_TRANSFER_CONTRACT);
  });

  it.each([0, 1, Number.MAX_SAFE_INTEGER])("accepts expected revision %s", (revision) => {
    expect(validCloudExpectedRevision(revision)).toBe(true);
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects expected revision %s", (revision) => {
    expect(validCloudExpectedRevision(revision)).toBe(false);
  });
});
