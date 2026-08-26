import { describe, expect, it } from "vitest";
import {
  createCanvasNodeSemanticRevisionToken,
  isCanvasNodeSemanticRevisionApplied,
} from "./canvasNodeSemanticRevision";

describe("canvas node semantic revision", () => {
  it("deduplicates identity-only rerenders after the semantic revision was applied", () => {
    const first = createCanvasNodeSemanticRevisionToken(["home", 42, 7, "full", false]);
    const equivalent = createCanvasNodeSemanticRevisionToken(["home", 42, 7, "full", false]);
    expect(equivalent).toBe(first);
    expect(isCanvasNodeSemanticRevisionApplied(null, first)).toBe(false);
    expect(isCanvasNodeSemanticRevisionApplied(first, equivalent)).toBe(true);
  });

  it.each([
    ["runtime revision", ["home", 43, 7, "full", false]],
    ["topology revision", ["home", 42, 8, "full", false]],
    ["presentation", ["home", 42, 7, "compact", false]],
    ["interaction", ["home", 42, 7, "full", true]],
  ] as const)("invalidates the gate for a changed %s", (_label, parts) => {
    const applied = createCanvasNodeSemanticRevisionToken(["home", 42, 7, "full", false]);
    const requested = createCanvasNodeSemanticRevisionToken(parts);
    expect(isCanvasNodeSemanticRevisionApplied(applied, requested)).toBe(false);
  });

  it("does not collide when an identifier contains the former join delimiter", () => {
    expect(createCanvasNodeSemanticRevisionToken(["a\u001fb", "c"]))
      .not.toBe(createCanvasNodeSemanticRevisionToken(["a", "b\u001fc"]));
  });
});
