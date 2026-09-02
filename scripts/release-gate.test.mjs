import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createCycloneDxSbom, createProvenance, verifyProvenance, verifyReleaseSource } from "./release-gate.mjs";
import { findDeclaredConditionalSkips } from "./release-gate-skip-report.mjs";

test("release gate verifies the checked-out SHA before any build output is trusted", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dsp-release-gate-source-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const expectedSha = (await import("node:child_process")).execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const result = await verifyReleaseSource({
    expectedSha,
    output: join(directory, "source.json"),
    requireClean: false,
  });
  assert.equal(result.record.gitSha, expectedSha);
  assert.equal((JSON.parse(await readFile(join(directory, "source.json"), "utf8"))).gitSha, expectedSha);
  await assert.rejects(
    verifyReleaseSource({ expectedSha: "0".repeat(40), output: join(directory, "wrong.json"), requireClean: false }),
    /does not match required release SHA/,
  );
});

test("CycloneDX SBOM is rooted in both locked npm dependency graphs", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dsp-release-gate-sbom-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const gitSha = "a".repeat(40);
  const { document } = await createCycloneDxSbom({ gitSha, output: join(directory, "bom.json") });
  assert.equal(document.bomFormat, "CycloneDX");
  assert.equal(document.specVersion, "1.5");
  assert.equal(document.metadata.component.properties[0].value, gitSha);
  assert.ok(document.components.length > 100);
  assert.ok(document.components.some((component) => component.properties.some((property) => property.value === "package-lock.json")));
  assert.ok(document.components.some((component) => component.properties.some((property) => property.value === "server/package-lock.json")));
});

test("provenance binds the release manifest, SBOM, gate report, source SHA, and lockfiles", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dsp-release-gate-provenance-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, "provenance.json");
  const gitSha = "b".repeat(40);
  const result = await createProvenance({
    gitSha,
    manifest: "package.json",
    sbom: "package-lock.json",
    gateReport: "server/package-lock.json",
    output,
  });
  assert.equal(result.document.predicateType, "https://slsa.dev/provenance/v1");
  assert.equal(result.document.subject.length, 3);
  assert.equal(result.document.predicate.buildDefinition.resolvedDependencies.length, 3);
  assert.equal(JSON.parse(await readFile(output, "utf8")).predicate.buildDefinition.externalParameters.gitSha, gitSha);

  const repositoryRoot = process.cwd();
  const localOutput = ".release-gate-test-provenance.json";
  t.after(() => rm(`${repositoryRoot}/${localOutput}`, { force: true }));
  await createProvenance({
    gitSha,
    manifest: "package.json",
    sbom: "package-lock.json",
    gateReport: "server/package-lock.json",
    output: localOutput,
  });
  assert.deepEqual(await verifyProvenance({ input: localOutput, expectedSha: gitSha }), {
    verifiedSubjects: 3,
    gitSha,
  });
  await assert.rejects(verifyProvenance({ input: localOutput, expectedSha: "c".repeat(40) }), /does not match expected SHA/);
});

test("conditional skips are enumerated with a source location and a human-readable reason", async () => {
  const skips = await findDeclaredConditionalSkips();
  assert.ok(skips.length >= 4);
  assert.ok(skips.every((entry) => entry.file && entry.line > 0 && entry.reason && entry.source.includes("test.skip(")));
  assert.ok(skips.some((entry) => entry.reason.includes("player-save") || entry.reason.includes("终局夹具")));
});

test("every workflow pins third-party Actions and the release lane retains every mandatory gate", async () => {
  const workflowDirectory = ".github/workflows";
  const workflows = (await readdir(workflowDirectory)).filter((name) => /\.ya?ml$/.test(name));
  for (const workflow of workflows) {
    const contents = await readFile(`${workflowDirectory}/${workflow}`, "utf8");
    for (const match of contents.matchAll(/^\s*(?:-\s*)?uses:\s*[^\s]+@([^\s#]+)\s*$/gm)) {
      assert.match(match[1], /^[a-f0-9]{40}$/, `${workflow} must pin Actions to a full commit SHA`);
    }
  }

  const releaseGate = await readFile(`${workflowDirectory}/release-gate.yml`, "utf8");
  for (const command of [
    "npm run typecheck",
    "npm run test:native-core:serial",
    "npm run native:build-host",
    "npm test -- --maxWorkers=1",
    "npm run test:server",
    "npm run test:ops",
    "npm run test:native",
    "npm run licenses:check",
    "npm audit --omit=dev",
    "npm --prefix server audit --omit=dev",
    "npm run build",
    "npm run test:e2e",
    "generate-synthetic-save-fixtures.test.mjs",
    "release-gate-skip-report.mjs",
    "release-gate.mjs sbom",
    "release-gate.mjs provenance",
    "release-gate.mjs verify-provenance",
  ]) assert.match(releaseGate, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.ok(
    releaseGate.indexOf("npm run native:build-host") < releaseGate.indexOf("npm test -- --maxWorkers=1"),
    "release native Host must exist before Vitest can exercise differential integration",
  );
  assert.ok(
    releaseGate.indexOf("npm run native:build-host") <
      releaseGate.indexOf("run: npm run test:native\n"),
    "release native Host must exist before native integration tests",
  );

  const desktopRelease = await readFile(`${workflowDirectory}/desktop-release.yml`, "utf8");
  assert.match(desktopRelease, /@\("release-performance-edition", "release-performance-edition-fallback"\)/);
  assert.match(desktopRelease, /DSP_DESKTOP_RELEASE_OUTPUT=\$\(\$complete\[0\]\)/);
  assert.match(desktopRelease, /\$\{\{ env\.DSP_DESKTOP_RELEASE_OUTPUT \}\}\/\*\.exe/);
  assert.match(desktopRelease, /if-no-files-found:\s*error/);
  assert.doesNotMatch(desktopRelease, /^\s+release\/\*\.(?:exe|blockmap)$/m);
});
