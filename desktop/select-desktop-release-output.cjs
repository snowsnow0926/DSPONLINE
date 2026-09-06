"use strict";

const path = require("node:path");
const {
  resolveDesktopEditionIdentity,
  selectCompleteDesktopReleaseOutput,
} = require("./performance-edition-identity.cjs");

function selectDesktopReleaseOutputFromEnvironment({
  repositoryRoot = path.resolve(__dirname, ".."),
  environment = process.env,
  packageMetadata = require("../package.json"),
} = {}) {
  const identity = resolveDesktopEditionIdentity(
    packageMetadata,
    environment.DSP_DESKTOP_EDITION || "stable",
  );
  const channel = (environment.DSP_RELEASE_CHANNEL || "stable").toLowerCase();
  return selectCompleteDesktopReleaseOutput({
    repositoryRoot,
    identity,
    channel,
  });
}

if (require.main === module) {
  process.stdout.write(`${selectDesktopReleaseOutputFromEnvironment().relativeOutputDirectory}\n`);
}

module.exports = { selectDesktopReleaseOutputFromEnvironment };
