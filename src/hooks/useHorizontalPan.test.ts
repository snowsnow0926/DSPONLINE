import { describe, expect, it } from "vitest";
import { horizontalWheelDelta } from "./useHorizontalPan";

describe("technology tree horizontal wheel conversion", () => {
  it("uses vertical wheel input when the device does not report deltaX", () => {
    expect(horizontalWheelDelta(0, 120)).toBe(120);
    expect(horizontalWheelDelta(0, -80)).toBe(-80);
  });

  it("preserves a real horizontal trackpad delta", () => {
    expect(horizontalWheelDelta(32, 120)).toBe(32);
    expect(horizontalWheelDelta(-24, 6)).toBe(-24);
  });
});
