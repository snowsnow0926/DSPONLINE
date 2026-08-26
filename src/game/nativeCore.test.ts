import { describe, expect, it } from "vitest";

import { partitionNativeAdvanceBudget } from "./nativeCore";

describe("Windows native core segmented advance", () => {
  it("preserves exact simulation and wall totals across cancellable boundaries", () => {
    const segments = partitionNativeAdvanceBudget(3_601, 901, 600);
    expect(segments).toHaveLength(7);
    expect(segments.slice(0, -1).every((segment) => segment.simulationSeconds === 600)).toBe(true);
    expect(segments.reduce((sum, segment) => sum + segment.simulationSeconds, 0)).toBe(3_601);
    expect(segments.reduce((sum, segment) => sum + segment.wallSeconds, 0)).toBe(901);
    expect(segments.at(-1)).toMatchObject({ simulationSeconds: 1 });
  });

  it("segments wall-only settlement and rejects unsafe budgets", () => {
    expect(partitionNativeAdvanceBudget(0, 1_201, 600)).toEqual([
      { simulationSeconds: 0, wallSeconds: 600 },
      { simulationSeconds: 0, wallSeconds: 600 },
      { simulationSeconds: 0, wallSeconds: 1 },
    ]);
    expect(() => partitionNativeAdvanceBudget(Number.NaN, 1)).toThrow(/预算无效/);
    expect(() => partitionNativeAdvanceBudget(1, 1, 0)).toThrow(/预算无效/);
  });
});
