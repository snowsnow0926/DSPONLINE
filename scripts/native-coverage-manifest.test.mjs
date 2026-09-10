import assert from "node:assert/strict";
import test from "node:test";

import {
  buildNativeCoverageManifest,
  parseLegacyWriteGuards,
  verifyNativeCoverageManifest,
} from "./native-coverage-manifest.mjs";

test("native coverage manifest is generated from every protected write surface", async () => {
  const manifest = await buildNativeCoverageManifest();
  assert.equal(manifest.schemaVersion, 1);
  assert.ok(manifest.hostCapabilities.includes("native-core-player-authority-command-v1"));
  assert.equal(manifest.domainCoverage.pure_idle_macro, true);
  assert.equal(manifest.domainCoverage.offline_and_time_warp, true);
  assert.equal(manifest.domainCoverage.authority_eligible, false);
  // Categories group multiple guarded call sites; previous migrations removed
  // obsolete categories while retaining more than 30 actual protected actions.
  assert.ok(manifest.playerWriteSurfaces.reduce((sum, surface) => sum + surface.occurrences, 0) >= 30);
  assert.equal(new Set(manifest.playerWriteSurfaces.map((surface) => surface.label)).size,
    manifest.playerWriteSurfaces.length);
  assert.ok(manifest.playerWriteSurfaces.every((surface) => surface.owner && surface.kind && surface.status));
  assert.ok(manifest.playerWriteSurfaces.every((surface) => surface.occurrences === surface.lines.length));
});

test("coverage finds real guarded calls across formatting without counting comments or strings", () => {
  const source = [
    '// rejectLegacyFactoryInteractionWhileNative("comment")',
    'const example = \'rejectLegacyFactoryInteractionWhileNative("string")\';',
    'rejectLegacyFactoryInteractionWhileNative(',
    '  "建筑回收",',
    ');',
    "rejectLegacyFactoryInteractionWhileNative ( '建筑回收' );",
    'const view = <button onClick={() => rejectLegacyFactoryInteractionWhileNative(`建筑回收`)} />;',
  ].join("\n");
  assert.deepEqual(parseLegacyWriteGuards(source), [
    { label: "建筑回收", occurrences: 3, lines: [3, 6, 7] },
  ]);
});

test("coverage refuses dynamic, missing, extra or malformed guarded calls", () => {
  for (const argument of ["label", '"建筑" + "回收"', "`建筑${kind}`", "", '"建筑回收", true', 'flag ? "建筑回收" : label']) {
    assert.throws(() => parseLegacyWriteGuards(`rejectLegacyFactoryInteractionWhileNative(${argument});`),
      /requires one static label/);
  }
  assert.throws(() => parseLegacyWriteGuards('rejectLegacyFactoryInteractionWhileNative("建筑回收";'),
    /cannot parse protected write surfaces/);
});

test("coverage inventories both static placement branches without duplicating a shared label", () => {
  const guards = parseLegacyWriteGuards([
    'rejectLegacyFactoryInteractionWhileNative(blueprint ? "蓝图部署" : "建筑放置与扩建");',
    'rejectLegacyFactoryInteractionWhileNative((outer ? "蓝图部署" : inner ? "蓝图部署" : "建筑放置与扩建"));',
  ].join("\n"));
  assert.equal(guards.length, 2);
  for (const label of ["蓝图部署", "建筑放置与扩建"]) {
    assert.deepEqual(guards.find(guard => guard.label === label), { label, occurrences: 2, lines: [1, 2] });
  }
});

test("checked-in native coverage manifest cannot drift", async () => {
  await verifyNativeCoverageManifest();
});
