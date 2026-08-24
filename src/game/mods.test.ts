import { describe, expect, it } from "vitest";
import { createContentPackTemplate, parseContentPack, validateContentPack } from "./mods";

describe("content pack validation", () => {
  it("accepts a metadata-only pack and normalizes its arrays", () => {
    const result = validateContentPack(createContentPackTemplate());
    expect(result.valid).toBe(true);
    expect(result.manifest?.formatVersion).toBe(2);
    expect(result.counts).toEqual({ items: 0, buildings: 0, recipes: 0, technologies: 0 });
  });

  it("rejects core overrides and dangling recipe references", () => {
    const result = validateContentPack({
      formatVersion: 1,
      id: "bad_pack",
      name: "坏包",
      version: "1.0.0",
      items: [{ id: "new_item", name: "新物品" }],
      recipes: [{ id: "new_recipe", name: "新配方", buildingId: "unknown_machine", duration: 1, inputs: [{ itemId: "new_item", amount: 1 }], outputs: [{ itemId: "iron_ore", amount: 1 }] }],
      technologies: [],
      buildings: [{ id: "arc_smelter", name: "覆盖熔炉" }],
    });
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(["override-building", "recipe-building"]));
  });

  it("reports malformed JSON without throwing", () => {
    const result = parseContentPack("{not json");
    expect(result.valid).toBe(false);
    expect(result.issues[0].code).toBe("json");
  });

  it("accepts v1 compatibility but rejects unsafe v2 overrides and duplicate belt tiers", () => {
    expect(validateContentPack({ formatVersion: 1, id: "legacy_pack", name: "Legacy", version: "1.0.0" }).valid).toBe(true);
    const result = validateContentPack({
      formatVersion: 2,
      id: "unsafe_pack",
      name: "Unsafe",
      version: "1.0.0",
      script: "alert(1)",
      buildingOverrides: [{ id: "arc_smelter", speed: -1 }, { id: "unknown_building", speed: 2 }],
      belts: [
        { id: "unsafe_belt_a", name: "A", tier: 4, speed: 60, costs: [{ itemId: "iron_ingot", amount: 1 }] },
        { id: "unsafe_belt_b", name: "B", tier: 4, speed: 90, costs: [{ itemId: "iron_ingot", amount: 1 }] },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(["building-override-value", "building-override-id", "belt-duplicate"]));
    expect(result.manifest).not.toHaveProperty("script");
  });

  it("rejects a belt/building ID collision before runtime registration", () => {
    const result = validateContentPack({
      formatVersion: 2,
      id: "cross_category_collision",
      name: "跨类别冲突",
      version: "1.0.0",
      buildings: [{ id: "shared_runtime_id", name: "共享建筑", costs: [{ itemId: "iron_ingot", amount: 1 }] }],
      belts: [{ id: "shared_runtime_id", name: "共享线路", tier: 4, speed: 60, costs: [{ itemId: "iron_ingot", amount: 1 }] }],
    });
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("belt-building-id-conflict");
  });
});
