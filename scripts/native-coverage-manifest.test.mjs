import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildNativeCoverageManifest,
  verifyNativeCoverageManifest,
} from "./native-coverage-manifest.mjs";

test("native coverage manifest is generated from every protected write surface", async () => {
  const manifest = await buildNativeCoverageManifest();
  assert.equal(manifest.schemaVersion, 1);
  assert.ok(manifest.hostCapabilities.includes("native-core-player-authority-command-v1"));
  assert.equal(manifest.domainCoverage.pure_idle_macro, true);
  assert.equal(manifest.domainCoverage.offline_and_time_warp, true);
  assert.equal(manifest.domainCoverage.authority_eligible, false);
  const registry = JSON.parse(await readFile(new URL("../native/native-surface-registry.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.playerWriteSurfaces.map((surface) => surface.label).sort(),
    registry.surfaces.map((surface) => surface.label).sort());
  assert.ok(manifest.playerWriteSurfaces.every((surface) => surface.occurrences > 0 &&
    surface.occurrences === surface.lines.length && surface.lines.every((line) => Number.isSafeInteger(line) && line > 0)));
  assert.equal(new Set(manifest.playerWriteSurfaces.map((surface) => surface.label)).size,
    manifest.playerWriteSurfaces.length);
  assert.ok(manifest.playerWriteSurfaces.every((surface) => surface.owner && surface.kind && surface.status));
});

test("checked-in native coverage manifest cannot drift", async () => {
  await verifyNativeCoverageManifest();
});
