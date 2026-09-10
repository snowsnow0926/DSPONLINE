import { describe, expect, it } from "vitest";
import { constructionMaterialsAvailable } from "./constructionMaterialAvailability";
import type { ItemId } from "./types";

describe("construction material availability", () => {
  it("combines reserved work, tray and quantum materials without spending any of them", () => {
    const inventory = Object.freeze({ iron_ingot: 2, copper_ingot: 1 });
    const tray = Object.freeze({ iron_ingot: 3 });
    const quantum = Object.freeze({ iron_ingot: 4, copper_ingot: 2 });
    const inputs = Object.freeze([inventory, tray, quantum] as const);
    const before = structuredClone(inputs);
    expect(constructionMaterialsAvailable(...inputs, [
      { itemId: "iron_ingot", amount: 9 }, { itemId: "copper_ingot", amount: 3 },
    ])).toBe(true);
    expect(constructionMaterialsAvailable(...inputs, [
      { itemId: "iron_ingot", amount: 9 }, { itemId: "copper_ingot", amount: 4 },
    ])).toBe(false);
    expect(inputs).toEqual(before);
  });

  it("cannot reuse stock when an extension repeats a material in its input list", () => {
    const inputs = [{ iron_ingot: 2 }, { iron_ingot: 3 }, { iron_ingot: 4 }] as const;
    const requirements: Array<{ itemId: ItemId; amount: number }> = [
      { itemId: "iron_ingot", amount: 5 }, { itemId: "iron_ingot", amount: 4 },
    ];
    expect(constructionMaterialsAvailable(...inputs, requirements)).toBe(true);
    requirements[1].amount = 5;
    expect(constructionMaterialsAvailable(...inputs, requirements)).toBe(false);
  });

  it("normalizes each source and requirement before deciding sufficiency", () => {
    const inputs = [{ iron_ingot: 1.9 }, { iron_ingot: -3 }, { iron_ingot: 2.9 }] as const;
    expect(constructionMaterialsAvailable(...inputs, [{ itemId: "iron_ingot", amount: 3.9 }])).toBe(true);
    expect(constructionMaterialsAvailable(...inputs, [{ itemId: "iron_ingot", amount: 4 }])).toBe(false);
    expect(constructionMaterialsAvailable({}, {}, {}, [{ itemId: "iron_ingot", amount: 1 }])).toBe(false);
    expect(constructionMaterialsAvailable({}, {}, {}, [
      { itemId: "iron_ingot", amount: -1 }, { itemId: "iron_ingot", amount: 0.9 },
    ])).toBe(true);
    expect(constructionMaterialsAvailable({}, {}, {}, [])).toBe(true);
  });

  it("does not enumerate or read inventory unrelated to this recipe", () => {
    const inventory = new Proxy({ iron_ingot: 1, copper_ingot: 20 }, {
      ownKeys() { throw new Error("Recipe check enumerated a whole inventory"); },
      get(target, key, receiver) {
        if (key !== "iron_ingot") throw new Error("Recipe check read unrelated stock");
        return Reflect.get(target, key, receiver);
      },
    });
    expect(constructionMaterialsAvailable(inventory, inventory, inventory, [{ itemId: "iron_ingot", amount: 3 }])).toBe(true);
    expect(constructionMaterialsAvailable(inventory, inventory, inventory, [{ itemId: "iron_ingot", amount: 4 }])).toBe(false);
  });
});
