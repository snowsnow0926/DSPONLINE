/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONSTRUCTION, ITEMS, getBeltSpeed } from "./content";
import { applyContentPackRegistry, commitContentPackRegistry, createContentPackRegistry, createContentPackRuntimeSnapshot, getContentPackRegistryFingerprint, loadContentPackRegistry, registerContentPack, removeContentPack, saveContentPackRegistry } from "./contentPacks";
import { validateContentPack } from "./mods";
import { getItemPresentation, ITEM_PRESENTATIONS } from "./contentPresentation";
import type { ItemId } from "./types";
import documentedOverrides from "../../docs/examples/example-core-overrides-v5.content-pack.json";
import { createInitialState } from "./engine";
import { saveGameVerified, serializeEnvelopeInWorker } from "./storage";
import { readPersistedLocalSaveValue } from "./localSaveStore";

const empty = () => ({ formatVersion: 5, id: "author_feedback", name: "作者配置", version: "1.0.0" });
afterEach(() => { vi.unstubAllGlobals(); applyContentPackRegistry(createContentPackRegistry()); localStorage.clear(); });

describe("content-pack core item and belt authoring", () => {
  it("applies item presentation and real belt speed, manufacturing cost and unlock overrides, then restores the core", () => {
    const original = structuredClone({ item: ITEMS.iron_ore, belt: CONSTRUCTION.find(entry => entry.buildingId === "conveyor_belt_mk1"), speed: getBeltSpeed(1) });
    const validation = validateContentPack(documentedOverrides);
    expect(validation.issues).toEqual([]);
    const registration = registerContentPack(createContentPackRegistry(), validation);
    expect(applyContentPackRegistry(registration.registry).catalogValid).toBe(true);
    expect(ITEMS.iron_ore).toMatchObject({ name: "赤铁矿", symbol: "赤", color: "#c94531", kind: original.item.kind });
    expect(getBeltSpeed(1)).toBe(17);
    expect(CONSTRUCTION.find(entry => entry.buildingId === "conveyor_belt_mk1")).toMatchObject({ name: "基础运输线", outputAmount: 2, costs: [{ itemId: "iron_ingot", amount: 7 }] });
    expect(CONSTRUCTION.find(entry => entry.buildingId === "conveyor_belt_mk1")?.requiredTechId).toBeUndefined();
    applyContentPackRegistry(createContentPackRegistry());
    expect(ITEMS.iron_ore).toEqual(original.item);
    expect(getBeltSpeed(1)).toBe(original.speed);
    expect(CONSTRUCTION.find(entry => entry.buildingId === "conveyor_belt_mk1")).toEqual(original.belt);
  });

  it("rejects old-format overrides and unsafe material, tier, image and numeric changes", () => {
    const variants = [
      { formatVersion: 4, itemOverrides: [{ id: "iron_ore", name: "改名" }] },
      { itemOverrides: [{ id: "iron_ore", kind: "fluid" }] },
      { itemOverrides: [{ id: "iron_ore", icon: "https://example.invalid/image.png" }] },
      { beltOverrides: [{ id: "conveyor_belt_mk1", tier: 3, speed: 17 }] },
      { beltOverrides: [{ id: "conveyor_belt_mk1", speed: 0 }] },
      { beltOverrides: [{ id: "conveyor_belt_mk1", costs: [{ itemId: "unknown_item", amount: 1 }] }] },
      { beltOverrides: [{ id: "conveyor_belt_mk1", speed: 17 }, { id: "conveyor_belt_mk1", speed: 19 }] },
    ];
    for (const variant of variants) expect(validateContentPack({ ...empty(), ...variant }).valid, JSON.stringify(variant)).toBe(false);
  });

  it("rejects conflicting core overrides from a second pack without replacing the first", () => {
    const first = validateContentPack({ ...empty(), itemOverrides: [{ id: "iron_ore", name: "第一包矿石" }] });
    const registry = registerContentPack(createContentPackRegistry(), first).registry;
    const second = validateContentPack({ ...empty(), id: "second_pack", itemOverrides: [{ id: "iron_ore", name: "第二包矿石" }] });
    expect(registerContentPack(registry, second).registry).toBe(registry);
  });

  it("retains a removed configuration for snapshot recovery without sending archives to simulation Workers", () => {
    const validation = validateContentPack({ ...empty(), itemOverrides: [{ id: "iron_ore", name: "恢复用矿石" }] });
    const registry = registerContentPack(createContentPackRegistry(), validation).registry;
    const removed = removeContentPack(registry, "author_feedback");
    expect(removed.changed).toBe(true);
    expect(removed.registry.packs).toEqual({});
    expect(removed.registry.removedManifests?.[0].itemOverrides?.[0].name).toBe("恢复用矿石");
    expect(saveContentPackRegistry(removed.registry)).toBe(true);
    expect(loadContentPackRegistry().removedManifests).toEqual(removed.registry.removedManifests);
    expect(createContentPackRuntimeSnapshot(removed.registry).registry.removedManifests).toBeUndefined();
    expect(getContentPackRegistryFingerprint(removed.registry)).toBe(getContentPackRegistryFingerprint(createContentPackRegistry()));
  });

  it("keeps only one old presentation frame while removing the item from the actual simulation catalog", () => {
    const validation = validateContentPack({ ...empty(), items: [{ id: "transient_ore", name: "过渡矿石" }] });
    applyContentPackRegistry(registerContentPack(createContentPackRegistry(), validation).registry);
    applyContentPackRegistry(createContentPackRegistry());
    expect(ITEMS["transient_ore" as never]).toBeUndefined();
    expect(getItemPresentation("transient_ore" as never).name).toBe("过渡矿石");
    expect(ITEM_PRESENTATIONS["transient_ore" as ItemId].name).toBe("过渡矿石");
    expect(Object.keys(ITEM_PRESENTATIONS)).not.toContain("transient_ore");
    applyContentPackRegistry(createContentPackRegistry());
    expect(getItemPresentation("transient_ore" as never).name).toBe("transient_ore");
  });

  it("binds an explicit save registry without publishing it, and does not reuse that save for a different registry", async () => {
    const registry = registerContentPack(createContentPackRegistry(), validateContentPack(documentedOverrides)).registry;
    expect(commitContentPackRegistry(registry, createContentPackRegistry()).persisted).toBe(true);
    const candidate = { ...createInitialState(), contentPacks: [] };
    const saved = await saveGameVerified(candidate, undefined, undefined, { contentPackRegistry: createContentPackRegistry() });
    expect(saved.success).toBe(true);
    expect(JSON.parse((await readPersistedLocalSaveValue("dsp-idle-network.save.v1"))!).state.contentPacks).toEqual([]);
    expect(loadContentPackRegistry().packs.example_core_overrides.enabled).toBe(true);
    const ordinary = await saveGameVerified(candidate);
    expect(ordinary.success).toBe(true);
    expect(ordinary.skippedUnchanged).not.toBe(true);
    expect(JSON.parse((await readPersistedLocalSaveValue("dsp-idle-network.save.v1"))!).state.contentPacks).toEqual([{ id: "example_core_overrides", version: "1.0.0" }]);
  });

  it("retains the requested catalog when Worker creation falls back to the synchronous serializer", async () => {
    const registry = registerContentPack(createContentPackRegistry(), validateContentPack(documentedOverrides)).registry;
    commitContentPackRegistry(registry, createContentPackRegistry());
    vi.stubGlobal("Worker", class { constructor() { throw new Error("injected Worker failure"); } });
    const serialized = await serializeEnvelopeInWorker(createInitialState(), 1234, "primary", undefined, "main", false, createContentPackRegistry());
    expect(serialized.usedWorker).toBe(false);
    expect(JSON.parse(serialized.raw).state.contentPacks).toEqual([]);
    expect(loadContentPackRegistry().packs.example_core_overrides.enabled).toBe(true);
  });
});
