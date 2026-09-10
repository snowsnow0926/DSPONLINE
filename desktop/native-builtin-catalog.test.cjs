"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { collectBuiltinCatalogIdentity, matchesBuiltinCatalog } = require("./native-builtin-catalog.cjs");
const source = JSON.parse(fs.readFileSync(path.join(__dirname, "native-builtin-catalog-v1.json")));

test("independent main content identity covers the entire built-in runtime directory", () => {
  const identity = collectBuiltinCatalogIdentity();
  assert.deepEqual(identity, { registryFingerprint: source.registryFingerprint, catalogSha256: source.catalogSha256 });
  assert.ok(Object.isFrozen(identity));
  assert.ok(matchesBuiltinCatalog(source.catalog, source.registryFingerprint));
  const reordered = Object.fromEntries(Object.entries(source.catalog).reverse());
  assert.ok(matchesBuiltinCatalog(reordered, source.registryFingerprint));
  assert.equal(matchesBuiltinCatalog(source.catalog, "forged"), false);
});

for (const [name, mutate] of [
  ["recipe", c => { c.recipes[0].duration = 999; }],
  ["building", c => { c.buildings[0].speed = 999; }],
  ["ordering", c => { c.items.reverse(); }],
  ["unknown field", c => { c.unknownField = true; }],
  ["registry", c => { c.registryFingerprint = "forged"; }],
]) test(`same registry does not conceal changed ${name}`, () => {
  const catalog = structuredClone(source.catalog); mutate(catalog);
  assert.equal(matchesBuiltinCatalog(catalog, source.registryFingerprint), false);
});

const moduleCode = fs.readFileSync(path.join(__dirname, "native-builtin-catalog.cjs"), "utf8");
function fixture(bytes, overrides = {}) {
  const module = { exports: {} };
  const fakeFs = { lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false, size: bytes.length, ...overrides }),
    readFileSync: () => bytes };
  vm.runInNewContext(moduleCode, { module, __dirname, Buffer, TextDecoder,
    require: name => name === "node:fs" ? fakeFs : require(name) });
  return module.exports;
}
for (const [name, bytes, overrides] of [
  ["malformed", Buffer.from("{")],
  ["duplicate", Buffer.from(JSON.stringify(source).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'))],
  ["missing", Buffer.from("{}")],
  ["whitespace", Buffer.from(JSON.stringify(source, null, 2))],
  ["invalid UTF8", Buffer.from([0xff])],
  ["digest", Buffer.from(JSON.stringify({ ...source, catalogSha256: "f".repeat(64) }))],
  ["oversize", Buffer.alloc(1024 * 1024 + 1)],
  ["link", Buffer.from(JSON.stringify(source)), { isSymbolicLink: () => true }],
]) test(`invalid embedded main directory rejects ${name}`, () => {
  assert.throws(() => fixture(bytes, overrides).collectBuiltinCatalogIdentity());
});
