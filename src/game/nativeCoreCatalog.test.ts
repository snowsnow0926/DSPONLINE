import { describe, expect, it } from "vitest";
import { createContentPackRegistry, createContentPackRuntimeSnapshot } from "./contentPacks";
import { createNativeCoreCatalog } from "./nativeCoreCatalog";

describe("Windows native core catalog", () => {
  it("freezes core recipes, buildings and belts in stable ID order", () => {
    const runtime = createContentPackRuntimeSnapshot(createContentPackRegistry());
    const catalog = createNativeCoreCatalog(runtime);
    expect(catalog.protocolVersion).toBe(1);
    expect(catalog.registryFingerprint).toBe(runtime.fingerprint);
    expect(catalog.items.length).toBeGreaterThan(50);
    expect(catalog.buildings.length).toBeGreaterThan(20);
    expect(catalog.recipes.length).toBeGreaterThan(50);
    expect(catalog.belts.map((belt) => belt.tier)).toEqual([1, 2, 3]);
    expect(catalog.items.map((item) => item.id)).toEqual([...catalog.items.map((item) => item.id)].sort());
    expect(catalog.recipes.find((recipe) => recipe.id === "iron_ingot")?.outputs).toEqual([{ itemId: "iron_ingot", amount: 1 }]);
  });
});

