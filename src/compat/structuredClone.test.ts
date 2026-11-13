import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const guardPath = fileURLToPath(new URL("./structuredClone.ts", import.meta.url));
const guardSource = readFileSync(guardPath, "utf8").replace(/^import .*;\r?\n/, "");

describe("structuredClone compatibility", () => {
  it("retains an existing native function without calling the fallback", () => {
    const nativeClone = () => undefined;
    const fallback = vi.fn();
    const context = { structuredClone: nativeClone, cloneStructuredValue: fallback };
    runInNewContext(guardSource, context);
    expect(context.structuredClone).toBe(nativeClone);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("installs the fallback synchronously when the API is missing", () => {
    const fallback = () => undefined;
    const context: { structuredClone?: () => undefined; cloneStructuredValue: () => undefined } = { cloneStructuredValue: fallback };
    runInNewContext(guardSource, context);
    runInNewContext(guardSource, context);
    expect(context.structuredClone).toBe(fallback);
  });

  it("preserves graph values and atomic ArrayBuffer transfers with the native APIs absent", () => {
    const script = `
      const assert = require('node:assert/strict');
      (async () => {
      delete globalThis.structuredClone;
      delete globalThis.PerformanceMark;
      delete ArrayBuffer.prototype.transfer;
      delete ArrayBuffer.prototype.transferToFixedLength;
      await import(require('node:url').pathToFileURL(process.argv[1]).href);
      assert.equal(typeof structuredClone, 'function');
      const key = { id: 'shared' };
      const source = {
        missing: undefined, integer: 1234567890123456789n,
        negativeZero: -0, nan: NaN, infinity: Infinity,
        date: new Date('2026-11-13T00:00:00.000Z'),
        map: new Map([[key, { amount: 7 }]]), set: new Set([key]), key,
      };
      source.self = source;
      const copy = structuredClone(source);
      assert.notEqual(copy, source);
      assert.equal(copy.self, copy);
      assert.notEqual(copy.key, key);
      assert.equal(copy.map.get(copy.key).amount, 7);
      assert.equal(copy.set.has(copy.key), true);
      assert.equal(copy.date.getTime(), source.date.getTime());
      assert.equal(Object.hasOwn(copy, 'missing'), true);
      assert.equal(copy.missing, undefined);
      assert.equal(copy.integer, source.integer);
      assert.equal(Object.is(copy.negativeZero, -0), true);
      assert.equal(Number.isNaN(copy.nan), true);
      assert.equal(copy.infinity, Infinity);
      const buffer = new ArrayBuffer(8);
      new Uint8Array(buffer).set([3, 5, 7]);
      const transferred = structuredClone({ bytes: new Uint8Array(buffer), view: new DataView(buffer) }, { transfer: [buffer] });
      assert.equal(buffer.byteLength, 0);
      assert.deepEqual([...transferred.bytes], [3, 5, 7, 0, 0, 0, 0, 0]);
      assert.equal(transferred.bytes.buffer, transferred.view.buffer);
      const retained = new ArrayBuffer(4);
      new Uint8Array(retained)[0] = 11;
      assert.throws(() => structuredClone({ retained, invalid: () => {} }, { transfer: [retained] }), { name: 'DataCloneError' });
      assert.equal(retained.byteLength, 4);
      assert.equal(new Uint8Array(retained)[0], 11);
      assert.throws(() => structuredClone({ retained }, { transfer: [retained, retained] }), { name: 'DataCloneError' });
      assert.equal(retained.byteLength, 4);
      process.stdout.write('verified', () => process.exit(0));
      })().catch(error => { console.error(error); process.exit(1); });
    `;
    const output = execFileSync(process.execPath, ["-e", script, guardPath], {
      encoding: "utf8", timeout: 20_000, windowsHide: true,
    });
    expect(output).toBe("verified");
  });
});
