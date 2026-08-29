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
    expect(catalog.constructions.length).toBeGreaterThan(20);
    expect(catalog.belts.map((belt) => belt.tier)).toEqual([1, 2, 3]);
    expect(catalog.items.map((item) => item.id)).toEqual([...catalog.items.map((item) => item.id)].sort());
    expect(catalog.recipes.find((recipe) => recipe.id === "iron_ingot")?.outputs).toEqual([{ itemId: "iron_ingot", amount: 1 }]);
    expect(catalog.constructions.find((definition) => definition.id === "construction_center")?.costs.length).toBeGreaterThan(0);
    expect(catalog.items.find((item) => item.id === "coal")?.fuelEnergyMj).toBe(2.7);
    expect(catalog.buildings.find((building) => building.id === "thermal_power_plant")).toMatchObject({
      powerGenerationKw: 2160,
      powerChargeKw: 0,
      energyCapacityMj: 0,
      fuelEfficiency: 0.8,
    });
    expect(catalog.buildings.find((building) => building.id === "energy_exchanger")).toMatchObject({
      powerGenerationKw: 45000,
      powerChargeKw: 45000,
      energyCapacityMj: 90,
      fuelItemIds: [],
    });
    expect(catalog.buildings.every((building) => building.stackLimitComplete === true)).toBe(true);
    expect(catalog.buildings.find((building) => building.id === "arc_smelter")?.stackLimit).toBeNull();
  });
});
