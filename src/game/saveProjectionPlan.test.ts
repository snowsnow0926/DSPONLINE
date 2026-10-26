import { describe, expect, it } from "vitest";
import { getSaveFieldDefinition, listSaveContractFields, omitSaveContractDefaults,
  type SaveFieldScope } from "./saveFieldContract";

// Frozen pre-optimization behavior. Resolve every default before deleting a
// field; do not call the optimized projection from this reference.
function reference(record: Record<string, unknown>, scope: SaveFieldScope, version: number | undefined) {
  const fields = listSaveContractFields(scope, version, "projection");
  const defaults = new Map(fields.map((field) => {
    const descriptor = getSaveFieldDefinition(scope, field)!.default;
    let value: unknown;
    if (descriptor.kind === "literal") value = descriptor.value;
    else if (descriptor.kind === "empty-object") value = {};
    else if (descriptor.kind === "empty-array") value = [];
    else if (descriptor.kind === "sibling-integer-clamp") {
      const sibling = Object.getOwnPropertyDescriptor(record, descriptor.field as string);
      const raw = sibling && "value" in sibling && Number.isSafeInteger(sibling.value) ? sibling.value : descriptor.fallback;
      value = Math.max(descriptor.minimum as number, Math.min(descriptor.maximum as number, raw as number));
    } else throw new Error("Unknown reference default");
    return [field, value];
  }));
  for (const field of fields) {
    const own = Object.getOwnPropertyDescriptor(record, field);
    if (!own || !("value" in own)) continue;
    const descriptor = getSaveFieldDefinition(scope, field)!.default;
    const isDefault = descriptor.kind === "empty-object"
      ? own.value && typeof own.value === "object" && !Array.isArray(own.value) && Object.keys(own.value).length === 0
      : descriptor.kind === "empty-array" ? Array.isArray(own.value) && own.value.length === 0
        : Object.is(own.value, defaults.get(field));
    if (own.value === undefined || isDefault) delete record[field];
  }
  return record;
}

describe("compiled sparse save projection rules", () => {
  it.each(["entity", "station-slot", "belt"] as const)("preserves every field and property order for %s across versions", (scope) => {
    const versions = [undefined, 45, 46, 47, 48, NaN, Infinity];
    for (const version of versions) for (let index = 0; index < 96; index++) {
      const source: Record<string, unknown> = { id: `record-${index}`, custom: { kept: index } };
      const fields = listSaveContractFields(scope);
      fields.forEach((field, fieldIndex) => {
        const descriptor = getSaveFieldDefinition(scope, field)!.default;
        const defaultValue = descriptor.kind === "literal" ? descriptor.value
          : descriptor.kind === "empty-object" ? {} : descriptor.kind === "empty-array" ? [] : 1;
        const choices = [undefined, defaultValue, null, false, true, 0, -0, NaN, Infinity,
          1, 4, "explicit-value", {}, [], { iron_ore: 1 }, [1]];
        const choice = (index * 7 + fieldIndex * 11) % (choices.length + 1);
        if (choice < choices.length) source[field] = choices[choice];
      });
      const expected = reference(structuredClone(source), scope, version);
      const actual = structuredClone(source);
      expect(omitSaveContractDefaults(actual, scope, version!)).toBe(actual);
      expect(actual).toEqual(expected);
      expect(Object.keys(actual)).toEqual(Object.keys(expected));
      expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
    }
  });

  it("keeps sibling defaults local to each record and snapshots them before omissions", () => {
    for (const version of [47, 46, 47, undefined, 45, 47]) for (const tier of [1, 4, 2, NaN, undefined, 32, -1]) {
      const record = { tier, sorterTier: Number.isSafeInteger(tier) ? Math.max(1, Math.min(3, tier!)) : 1 };
      expect(omitSaveContractDefaults({ ...record }, "belt", version!)).toEqual(reference({ ...record }, "belt", version));
    }
  });

  it("retains accessors, inherited fields and invalid values without invoking getters", () => {
    let reads = 0;
    const getter = () => { reads++; throw new Error("getter must not run"); };
    for (const scope of ["entity", "station-slot", "belt"] as const) {
      const make = () => {
        const record = Object.create({ inputs: {}, tier: 1 });
        Object.defineProperty(record, "progress", { get: getter, enumerable: true, configurable: true });
        Object.defineProperty(record, "tier", { get: getter, enumerable: true, configurable: true });
        Object.assign(record, { sorterTier: 1, interactionLocked: null, undefinedExtension: undefined });
        return record;
      };
      const expected = reference(make(), scope, 47);
      const actual = omitSaveContractDefaults(make(), scope, 47);
      expect(Object.getOwnPropertyDescriptors(actual)).toEqual(Object.getOwnPropertyDescriptors(expected));
      expect(Object.getPrototypeOf(actual)).toEqual(Object.getPrototypeOf(expected));
    }
    expect(reads).toBe(0);
  });
});
