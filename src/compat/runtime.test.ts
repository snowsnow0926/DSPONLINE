import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";
import arrayAt from "core-js-pure/actual/array/virtual/at.js";
import objectHasOwn from "core-js-pure/actual/object/has-own.js";
import { describe, expect, it } from "vitest";

const guard = readFileSync(fileURLToPath(new URL("./runtime.ts", import.meta.url)), "utf8").replace(/^import .*;\r?\n/gm, "");

describe("legacy runtime collection compatibility", () => {
  it("retains native function identities and is idempotent", () => {
    const context = createContext({ arrayAt, objectHasOwn });
    runInContext("globalThis.originalAt = Array.prototype.at; globalThis.originalHasOwn = Object.hasOwn", context);
    runInContext(guard, context);
    runInContext(guard, context);
    expect(runInContext("Array.prototype.at === originalAt && Object.hasOwn === originalHasOwn", context)).toBe(true);
  });

  it("installs non-enumerable methods with relative, sparse and generic array indexing", () => {
    const context = createContext({ arrayAt, objectHasOwn });
    runInContext("delete Array.prototype.at; delete Object.hasOwn", context);
    runInContext(guard, context);
    expect(Array.from(runInContext(
      "[[2, 4, 6].at(-1), [2, 4, 6].at(-2), [2, 4, 6].at(1.9), [2].at(Infinity), [2].at(-Infinity), [].at(-1), [, 3].at(0)]",
      context,
    ))).toEqual([6, 4, 4, undefined, undefined, undefined, undefined]);
    expect(runInContext("Array.prototype.at.call({0: 'first', 1: 'last', length: 2}, -1)", context)).toBe("last");
    expect(runInContext("Object.getOwnPropertyDescriptor(Array.prototype, 'at').enumerable", context)).toBe(false);
    expect(runInContext("Object.getOwnPropertyDescriptor(Object, 'hasOwn').enumerable", context)).toBe(false);
    expect(() => runInContext("Array.prototype.at.call(null, 0)", context)).toThrow();
  });

  it("checks own properties on null-prototype objects and rejects null receivers", () => {
    const context = createContext({ arrayAt, objectHasOwn });
    runInContext("delete Array.prototype.at; delete Object.hasOwn", context);
    runInContext(guard, context);
    runInContext("globalThis.record = Object.create(null); record.value = undefined", context);
    expect(runInContext("Object.hasOwn(record, 'value')", context)).toBe(true);
    expect(runInContext("Object.hasOwn(record, 'toString')", context)).toBe(false);
    expect(runInContext("Object.hasOwn(Object.create({inherited: 1}), 'inherited')", context)).toBe(false);
    expect(() => runInContext("Object.hasOwn(null, 'value')", context)).toThrow();
  });
});
