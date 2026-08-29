import { describe, expect, it } from "vitest";
import type { NativeFactoryProjectionIdentity } from "./factoryReadModels";
import {
  createNativeProjectedRecipeFocusItemCommand,
  createNativeProjectedRecipeFocusModeCommand,
  createNativeProjectedRecipeFocusPositionCommand,
} from "./nativeProjectedRecipeFocusCommands";
import type { RecipeFocusReadModel } from "./recipeFocusReadModel";

const identity: NativeFactoryProjectionIdentity = {
  sessionId: "session-a", runId: "run-a", revision: 14, planetId: "home",
};
const model: RecipeFocusReadModel = {
  schema: "recipe-focus-read-model-v1",
  source: "native-core",
  revision: 14,
  itemId: "iron_ore",
  mode: "two-level",
  position: { x: 24, y: 72 },
};

describe("native projected recipe-focus commands", () => {
  it("builds exact item, mode, and one/two-axis position leaves", () => {
    expect(createNativeProjectedRecipeFocusItemCommand(identity, model, null)?.topLevelChanges)
      .toEqual([{ path: ["recipeFocus", "itemId"], operation: "set", value: null }]);
    expect(createNativeProjectedRecipeFocusModeCommand(identity, model, "full")?.topLevelChanges)
      .toEqual([{ path: ["recipeFocus", "mode"], operation: "set", value: "full" }]);
    expect(createNativeProjectedRecipeFocusPositionCommand(identity, model, { x: 40, y: 72 })?.topLevelChanges)
      .toEqual([{ path: ["recipeFocus", "position", "x"], operation: "set", value: 40 }]);
    expect(createNativeProjectedRecipeFocusPositionCommand(identity, model, { x: 40, y: 96 })?.topLevelChanges)
      .toEqual([
        { path: ["recipeFocus", "position", "x"], operation: "set", value: 40 },
        { path: ["recipeFocus", "position", "y"], operation: "set", value: 96 },
      ]);
  });

  it("returns null for unchanged values", () => {
    expect(createNativeProjectedRecipeFocusItemCommand(identity, model, "iron_ore")).toBeNull();
    expect(createNativeProjectedRecipeFocusModeCommand(identity, model, "two-level")).toBeNull();
    expect(createNativeProjectedRecipeFocusPositionCommand(identity, model, { x: 24, y: 72 })).toBeNull();
  });

  it("fails closed for stale/legacy projections and malformed targets", () => {
    expect(() => createNativeProjectedRecipeFocusItemCommand(identity, { ...model, revision: 13 }, null)).toThrow(TypeError);
    expect(() => createNativeProjectedRecipeFocusModeCommand(identity, { ...model, source: "web-game-state" }, "full")).toThrow(TypeError);
    expect(() => createNativeProjectedRecipeFocusItemCommand(identity, model, "missing" as "iron_ore")).toThrow(TypeError);
    expect(() => createNativeProjectedRecipeFocusModeCommand(identity, model, "wide" as "full")).toThrow(TypeError);
    expect(() => createNativeProjectedRecipeFocusPositionCommand(identity, model, { x: 7, y: 72 })).toThrow(TypeError);
  });
});
