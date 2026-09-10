import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createServer } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = path.join(root, "desktop/native-builtin-catalog-v1.json");
const require = createRequire(import.meta.url);
const { canonicalCatalogJson } = require("../desktop/native-builtin-catalog.cjs");

// Build-time only, with a fresh module graph and an explicitly empty pack
// registry. No browser, profile, save, server socket or player input is read.
export async function builtinCatalogBytes() {
  const vite = await createServer({ root, configFile: false, appType: "custom", logLevel: "silent",
    server: { middlewareMode: true, watch: null, ws: false } });
  try {
    const packs = await vite.ssrLoadModule("/src/game/contentPacks.ts");
    const { createNativeCoreCatalog } = await vite.ssrLoadModule("/src/game/nativeCoreCatalog.ts");
    const { canonicalNativeCoreSha256 } = await vite.ssrLoadModule("/src/game/nativeCoreProof.ts");
    const runtime = packs.createContentPackRuntimeSnapshot(packs.createContentPackRegistry());
    packs.applyContentPackRuntimeSnapshot(runtime);
    const catalog = createNativeCoreCatalog(runtime);
    return Buffer.from(canonicalCatalogJson({ schemaVersion: 1, kind: "native-builtin-catalog-v1",
      registryFingerprint: runtime.fingerprint, catalogSha256: canonicalNativeCoreSha256(catalog), catalog }) + "\n");
  } finally { await vite.close(); }
}

export async function verifyBuiltinCatalog() {
  const expected = await builtinCatalogBytes();
  if (!fs.readFileSync(destination).equals(expected)) {
    throw new Error("Built-in Native catalog is stale; regenerate and review it before building");
  }
  return { status: "PASS", bytes: expected.length, catalogSha256: JSON.parse(expected).catalogSha256 };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3 || !["--write", "--verify"].includes(process.argv[2])) {
      throw new Error("Usage: native-builtin-catalog.mjs --write|--verify");
    }
    if (process.argv[2] === "--write") fs.writeFileSync(destination, await builtinCatalogBytes());
    else console.log(JSON.stringify(await verifyBuiltinCatalog()));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
