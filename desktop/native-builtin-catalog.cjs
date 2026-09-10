"use strict";

// Main-only compiled content facts, independent of renderer, save and carrier.
// Matching this directory says nothing about rules, scope or authority.
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const MAX_BYTES = 1024 * 1024;
let installed;
function canonicalCatalogJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalCatalogJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalCatalogJson(value[key])}`).join(",")}}`;
  }
  const text = JSON.stringify(value);
  if (text === undefined || (typeof value === "number" && !Number.isFinite(value))) {
    throw new Error("builtin-catalog-invalid");
  }
  return text;
}
const digest = (value) => createHash("sha256").update(canonicalCatalogJson(value)).digest("hex");

function collectBuiltinCatalogIdentity() {
  if (!installed) {
    const file = path.join(__dirname, "native-builtin-catalog-v1.json");
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_BYTES) {
      throw new Error("builtin-catalog-invalid");
    }
    // The member is packaged inside the ASAR hashed by the program provider.
    // Return only derived facts; callers cannot mutate the private snapshot.
    const bytes = fs.readFileSync(file);
    if (bytes.length !== stat.size) throw new Error("builtin-catalog-invalid");
    const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (Object.keys(body).sort().join(",") !== "catalog,catalogSha256,kind,registryFingerprint,schemaVersion"
        || body.schemaVersion !== 1 || body.kind !== "native-builtin-catalog-v1"
        || typeof body.registryFingerprint !== "string" || !body.registryFingerprint
        || body.catalog?.protocolVersion !== 1 || body.catalog.registryFingerprint !== body.registryFingerprint
        || !Buffer.from(canonicalCatalogJson(body) + "\n").equals(bytes)
        || body.catalogSha256 !== digest(body.catalog)) throw new Error("builtin-catalog-invalid");
    installed = Object.freeze({ registryFingerprint: body.registryFingerprint, catalogSha256: body.catalogSha256 });
  }
  return installed;
}

function matchesBuiltinCatalog(catalog, registryFingerprint) {
  const expected = collectBuiltinCatalogIdentity();
  if (registryFingerprint !== expected.registryFingerprint || catalog?.registryFingerprint !== registryFingerprint) return false;
  try { return digest(catalog) === expected.catalogSha256; } catch { return false; }
}

module.exports = { canonicalCatalogJson, collectBuiltinCatalogIdentity, matchesBuiltinCatalog };
