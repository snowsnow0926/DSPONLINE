"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { createPackage, uncache } = require("@electron/asar");
const { execFileSync } = require("node:child_process");
const { writeDesktopBuildEvidence } = require("../../desktop/desktop-artifact-evidence.cjs");
const { STABLE_IDENTITY, PERFORMANCE_EDITION_IDENTITY } = require("../../desktop/performance-edition-identity.cjs");

const SOURCE = "a".repeat(40);
const VERSION = require("../../package.json").version;
function context(identity = STABLE_IDENTITY, channel = "stable", sourceSha = SOURCE) {
  return { version: VERSION, sourceSha, buildId: `${VERSION}+${sourceSha.slice(0, 12)}`, editionId: identity.editionId, channel };
}
async function writeFixture(root, relative = "release", channel = "stable", options = {}) {
  const identity = options.identity ?? (relative.includes("performance") ? PERFORMANCE_EDITION_IDENTITY : STABLE_IDENTITY);
  const expected = options.expected ?? context(identity, channel);
  const directory = path.join(root, relative);
  const source = path.join(root, `asar-input-${relative}`);
  fs.mkdirSync(path.join(source, "dist"), { recursive: true });
  fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ version: expected.version, desktopEditionId: identity.editionId, productName: identity.productName, releaseChannel: channel, cloudApiBaseUrl: "", updateBaseUrl: "" }));
  fs.writeFileSync(path.join(source, "dist/version.json"), JSON.stringify({ version: expected.version, buildId: expected.buildId, platform: "desktop" }));
  fs.writeFileSync(path.join(source, "dist/index.html"), "<!doctype html><title>Synthetic fixture; not a runnable installer</title>");
  fs.mkdirSync(path.join(directory, "win-unpacked/resources/native"), { recursive: true });
  await createPackage(source, path.join(directory, "win-unpacked/resources/app.asar"));
  uncache(path.join(directory, "win-unpacked/resources/app.asar"));
  fs.writeFileSync(path.join(directory, `win-unpacked/${identity.executableName}.exe`), "synthetic electron executable");
  fs.writeFileSync(path.join(directory, "win-unpacked/resources/native/dsp-native-host.exe"), "synthetic native host");
  const name = identity.installerArtifactName.replace("${version}", expected.version).replace("${arch}", "x64").replace("${ext}", "exe");
  const contents = Buffer.from("Synthetic installer bytes; no signing claims.");
  const digest = createHash("sha512").update(contents).digest("base64");
  fs.writeFileSync(path.join(directory, name), contents);
  fs.writeFileSync(path.join(directory, "latest.yml"), `version: ${expected.version}\nfiles:\n  - url: ${name}\n    sha512: ${digest}\n    size: ${contents.length}\npath: ${name}\nsha512: ${digest}\n`);
  execFileSync(process.execPath, [path.resolve(__dirname, "../../scripts/create-native-update-manifests.mjs"), "--channel", channel, "--base-url", "https://updates.example.test/desktop/", "--desktop-source", directory, "--output", path.join(directory, "update-feed")], { windowsHide: true, stdio: "pipe" });
  writeDesktopBuildEvidence(directory, { expected, identity, release: true });
  return { directory, expected, identity, installer: path.join(directory, name) };
}
module.exports = { context, writeFixture };
