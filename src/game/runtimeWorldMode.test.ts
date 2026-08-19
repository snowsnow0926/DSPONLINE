import { describe, expect, it } from "vitest";
import { resolveRuntimeWorldBuildMode } from "./runtimeWorldMode";

describe("RuntimeWorld build mode", () => {
  it("enables RuntimeWorld without production shadow overhead by default", () => {
    expect(resolveRuntimeWorldBuildMode({ development: false })).toEqual({
      enabled: true,
      shadowEnabled: false,
    });
  });

  it("keeps the legacy engine as an explicit fallback", () => {
    expect(resolveRuntimeWorldBuildMode({ enabled: "false", development: false }).enabled).toBe(false);
  });

  it("limits shadow comparison to development or an explicit diagnostic build", () => {
    expect(resolveRuntimeWorldBuildMode({ development: true }).shadowEnabled).toBe(true);
    expect(resolveRuntimeWorldBuildMode({ shadow: "true", development: false }).shadowEnabled).toBe(true);
    expect(resolveRuntimeWorldBuildMode({ shadow: "false", development: false }).shadowEnabled).toBe(false);
  });
});
