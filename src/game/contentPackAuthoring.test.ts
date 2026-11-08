import { describe, expect, it } from "vitest";
import { renameContentPackEntry } from "./contentPackAuthoring";
import { createExampleContentPack } from "../components/ContentPackAuthor";
import { getContentPackUpdateReport } from "./contentPackUpdates";
import { validateContentPack } from "./mods";

describe("safe content-pack author renames", () => {
  it("renames resource, recipe materials and fuel references together, preserves history and bumps the patch", () => {
    const original = createExampleContentPack();
    const bytes = JSON.stringify(original);
    const next = renameContentPackEntry(original, "items", "crystal_ore", "refined_crystal_ore");
    expect(JSON.stringify(original)).toBe(bytes);
    expect(next.version).toBe("1.0.1");
    expect(next.items![0].id).toBe("refined_crystal_ore");
    expect(next.resources![0].itemId).toBe("refined_crystal_ore");
    expect(next.recipes![0].inputs[0].itemId).toBe("refined_crystal_ore");
    expect(next.generators![0].fuelItemIds).toEqual(["refined_crystal_ore"]);
    expect(next.fuels![0].itemId).toBe("refined_crystal_ore");
    expect(validateContentPack(next).issues).toEqual([]);
    expect(getContentPackUpdateReport(original, next).compatible).toBe(true);
    const again = renameContentPackEntry(next, "items", "refined_crystal_ore", "final_crystal_ore");
    expect(again.idMigrations).toEqual([
      { kind: "items", from: "crystal_ore", to: "final_crystal_ore" },
      { kind: "items", from: "refined_crystal_ore", to: "final_crystal_ore" },
    ]);
    expect(getContentPackUpdateReport(next, again).compatible).toBe(true);
  });

  it("updates recipe groups and policies when a recipe is renamed", () => {
    const original = createExampleContentPack();
    const next = renameContentPackEntry(original, "recipes", "crystal_plate_recipe", "refined_plate_recipe");
    expect(next.recipeGroups![0].recipeIds).toEqual(["refined_plate_recipe"]);
    expect(next.recipePolicies![0].recipeIds).toEqual(["refined_plate_recipe"]);
    expect(validateContentPack(next).issues).toEqual([]);
    expect(getContentPackUpdateReport(original, next).compatible).toBe(true);
  });

  it("rejects collisions, stale targets and invalid IDs without changing the draft", () => {
    const original = createExampleContentPack();
    for (const target of ["crystal_plate", "Bad-ID", "constructor", "iron_ore"]) expect(() => renameContentPackEntry(original, "items", "crystal_ore", target)).toThrow();
    expect(() => renameContentPackEntry(original, "items", "missing_id", "valid_new_id")).toThrow();
    expect(original.version).toBe("1.0.0");
    expect(original.idMigrations).toBeUndefined();
  });
});
