import { describe, expect, it } from "vitest";
import {
  canonicalizeNativeBlueprintName,
  createNativeBlueprintRenameIntentCommand,
} from "./nativeBlueprintRenameIntentCommands";

describe("native blueprint rename semantic intent", () => {
  it("emits one canonical kind/id/name marker and no blueprint body", () => {
    const command = createNativeBlueprintRenameIntentCommand(
      47,
      "mod:opaque/rocket",
      "新模组蓝图🚀",
    );
    expect(command).toEqual({
      protocolVersion: 1,
      baseRevision: 47,
      topLevelChanges: [{
        path: ["blueprints", "intent"],
        operation: "set",
        value: { kind: "rename", id: "mod:opaque/rocket", name: "新模组蓝图🚀" },
      }],
      changedEntities: [],
      addedEntities: [],
      removedEntityIds: [],
      changedBelts: [],
      addedBelts: [],
      removedBeltIds: [],
    });
    const encoded = JSON.stringify(command);
    expect(encoded).not.toContain('"entities":');
    expect(encoded).not.toContain('"belts":');
    expect(encoded).not.toMatch(/blueprintVersions|constructionQueue|patch/i);
  });

  it("canonicalizes Unicode whitespace and FEFF without splitting a surrogate pair", () => {
    expect(canonicalizeNativeBlueprintName(" \uFEFF  蓝图名  \uFEFF ")).toBe("蓝图名");
    expect(canonicalizeNativeBlueprintName(`${"a".repeat(30)}🚀`)).toBe(`${"a".repeat(30)}🚀`);
    expect(canonicalizeNativeBlueprintName(`${"a".repeat(31)}🚀`)).toBe("a".repeat(31));
    expect(canonicalizeNativeBlueprintName("🚀".repeat(17))).toBe("🚀".repeat(16));
    expect(canonicalizeNativeBlueprintName(`${"a".repeat(31)} x`)).toBe("a".repeat(31));
  });

  it("rejects malformed IDs, controls, empty names and noncanonical payloads", () => {
    expect(canonicalizeNativeBlueprintName("   \uFEFF ")).toBeNull();
    expect(canonicalizeNativeBlueprintName("控制\u0001字符")).toBeNull();
    expect(canonicalizeNativeBlueprintName("\ud800broken")).toBeNull();
    expect(() => createNativeBlueprintRenameIntentCommand(-1, "blueprint-a", "名字")).toThrow();
    expect(() => createNativeBlueprintRenameIntentCommand(0, "", "名字")).toThrow();
    expect(() => createNativeBlueprintRenameIntentCommand(0, "bad\u0001id", "名字")).toThrow();
    expect(() => createNativeBlueprintRenameIntentCommand(0, "x".repeat(513), "名字")).toThrow();
    expect(() => createNativeBlueprintRenameIntentCommand(0, "blueprint-a", " 名字")).toThrow();
    expect(() => createNativeBlueprintRenameIntentCommand(0, "blueprint-a", `${"a".repeat(31)}🚀`)).toThrow();
  });
});
