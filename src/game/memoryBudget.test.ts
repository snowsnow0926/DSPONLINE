import { describe, expect, it } from "vitest";
import {
  MEMORY_CRITICAL_PENDING_SECONDS,
  MEMORY_LARGE_PENDING_SECONDS,
  evaluateMemoryGuard,
  estimateSimulationRuntimeBytes,
  isLargeMemoryWorkload,
} from "./memoryBudget";

describe("memory budget governor", () => {
  const small = { serializedBytes: 2_000_000, entityCount: 100, beltCount: 200, stationCount: 2 };
  const large = { serializedBytes: 77 * 1024 * 1024, entityCount: 80_674, beltCount: 155_746, stationCount: 36_754 };

  it("recognizes a late-game save and estimates transient runtime memory", () => {
    expect(isLargeMemoryWorkload(large)).toBe(true);
    expect(estimateSimulationRuntimeBytes(large)).toBeGreaterThan(77 * 1024 * 1024);
  });

  it("keeps a normal workload running when the browser exposes no heap API", () => {
    const decision = evaluateMemoryGuard({
      snapshot: { usedHeapBytes: null, heapLimitBytes: null, deviceMemoryGiB: null, sampledAtMs: 0 },
      workload: small,
      pendingSimulationSeconds: 0,
      workerInFlight: false,
      saveInFlight: false,
    });
    expect(decision.pressure).toBe("normal");
    expect(decision.shouldPause).toBe(false);
    expect(decision.admitSimulation).toBe(true);
  });

  it("uses one-second slices and stops admitting work at the eight-second queue", () => {
    const decision = evaluateMemoryGuard({
      snapshot: { usedHeapBytes: 500, heapLimitBytes: 1_000, deviceMemoryGiB: 4, sampledAtMs: 0 },
      workload: large,
      pendingSimulationSeconds: MEMORY_LARGE_PENDING_SECONDS + 0.1,
      workerInFlight: false,
      saveInFlight: false,
    });
    expect(decision.pressure).toBe("elevated");
    expect(decision.maxSimulationSliceSeconds).toBe(1);
    expect(decision.shouldPause).toBe(false);
    expect(decision.admitSimulation).toBe(false);
    expect(decision.maxPendingSimulationSeconds).toBe(MEMORY_LARGE_PENDING_SECONDS);
  });

  it("pauses before an allocation failure or critical backlog can become a crash", () => {
    const byBacklog = evaluateMemoryGuard({
      snapshot: { usedHeapBytes: 700, heapLimitBytes: 1_000, deviceMemoryGiB: 4, sampledAtMs: 0 },
      workload: large,
      pendingSimulationSeconds: MEMORY_CRITICAL_PENDING_SECONDS,
      workerInFlight: true,
      saveInFlight: false,
    });
    expect(byBacklog.shouldPause).toBe(true);
    expect(byBacklog.admitSimulation).toBe(false);
    const byAllocation = evaluateMemoryGuard({
      snapshot: null,
      workload: small,
      pendingSimulationSeconds: 0,
      workerInFlight: false,
      saveInFlight: false,
      allocationFailure: true,
    });
    expect(byAllocation.shouldPause).toBe(true);
    expect(byAllocation.reason).toContain("分配");
  });

  it("treats slow workers as backpressure, not a false memory crash", () => {
    const decision = evaluateMemoryGuard({
      snapshot: { usedHeapBytes: 500, heapLimitBytes: 1_000, deviceMemoryGiB: 4, sampledAtMs: 0 },
      workload: large,
      pendingSimulationSeconds: 0,
      workerInFlight: false,
      saveInFlight: false,
      slowWorkerCount: 3,
    });
    expect(decision.pressure).toBe("elevated");
    expect(decision.shouldPause).toBe(false);
    expect(decision.maxSimulationSliceSeconds).toBe(1);
  });
});
