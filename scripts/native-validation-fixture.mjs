import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = path.join(root, "desktop/native-validation-fixture-v1.json");

// A public, deterministic new-game fixture. No player/profile input or clock.
export async function validationFixtureBytes() {
  const vite = await createServer({ root, configFile: false, appType: "custom", logLevel: "silent",
    server: { middlewareMode: true, watch: null, ws: false } });
  try {
    const packs = await vite.ssrLoadModule("/src/game/contentPacks.ts");
    const registry = packs.createContentPackRegistry();
    packs.applyContentPackRuntimeSnapshot(packs.createContentPackRuntimeSnapshot(registry));
    const { createInitialState } = await vite.ssrLoadModule("/src/game/engine.ts");
    const { serializeEnvelope } = await vite.ssrLoadModule("/src/game/storage.ts");
    const state = createInitialState(1040406, false);
    // The normal initializer seeds this UI contract clock from Date.now().
    // Pin it explicitly in this public fixture, without changing the initializer.
    state.orbitalStation.contractBoard.lastConfirmedWallClockMs = 1767225600000;
    return Buffer.from(serializeEnvelope(state, 1767225600000,
      "primary", undefined, registry, "main") + "\n");
  } finally { await vite.close(); }
}

export async function verifyValidationFixture() {
  const expected = await validationFixtureBytes();
  if (!fs.readFileSync(destination).equals(expected)) {
    throw new Error("Native validation fixture is stale; regenerate and review before building");
  }
  return { status: "PASS", bytes: expected.length };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3 || !["--write", "--verify"].includes(process.argv[2])) {
      throw new Error("Usage: native-validation-fixture.mjs --write|--verify");
    }
    if (process.argv[2] === "--write") fs.writeFileSync(destination, await validationFixtureBytes());
    else console.log(JSON.stringify(await verifyValidationFixture()));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
