import assert from "node:assert/strict";
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
  assert.ok(manifest.playerWriteSurfaces.length >= 30);
  assert.equal(new Set(manifest.playerWriteSurfaces.map((surface) => surface.label)).size,
    manifest.playerWriteSurfaces.length);
  assert.ok(manifest.playerWriteSurfaces.every((surface) => surface.owner && surface.kind && surface.status));
});

test("checked-in native coverage manifest cannot drift", async () => {
  await verifyNativeCoverageManifest();
});
