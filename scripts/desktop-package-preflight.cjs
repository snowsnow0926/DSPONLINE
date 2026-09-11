"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { PERFORMANCE_EDITION_IDENTITY, listDesktopEditionOutputDirectories } = require("../desktop/performance-edition-identity.cjs");
const { EVIDENCE_FILE, expectedDesktopBuild, verifyDesktopBuildEvidence } = require("../desktop/desktop-artifact-evidence.cjs");

function preflight(repositoryRoot, { channel, expected } = {}) {
  const identity = PERFORMANCE_EDITION_IDENTITY;
  const directories = listDesktopEditionOutputDirectories(repositoryRoot, identity);
  const candidates = [directories.standard, directories.fallback].filter((directory) => fs.existsSync(directory));
  if (candidates.length !== 1) throw new Error(`BLOCKED: expected exactly one isolated performance package, found ${candidates.length}`);
  channel ??= expected?.channel ?? JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8")).releaseChannel ?? "stable";
  expected ??= expectedDesktopBuild(repositoryRoot, identity, channel);
  if (expected.channel !== channel) throw new Error("BLOCKED: trusted context has the wrong channel");
  if (expected.buildId.endsWith(".dirty")) throw new Error("BLOCKED: packaged journeys require a frozen source commit");
  const outputDirectory = candidates[0];
  const { evidence } = verifyDesktopBuildEvidence(outputDirectory, { expected, identity, requireOffline: true });
  return { expected, outputDirectory, packageDirectory: path.join(outputDirectory, "win-unpacked"), evidenceFile: path.join(outputDirectory, EVIDENCE_FILE), evidence };
}
module.exports = { preflight };
if (require.main === module) {
  try { process.stdout.write(`${JSON.stringify(preflight(path.resolve(__dirname, "..")))}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 2; }
}
