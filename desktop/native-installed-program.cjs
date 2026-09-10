"use strict";

// Main-only installed program facts. These identify bytes, not publisher trust,
// qualification, producer provenance, or permission to own a player's state.
const fs = require("node:fs");
// Electron's fs presents app.asar itself as a directory. Use the original
// disk API for container/Host bytes, and its ASAR-aware fs only for members.
const diskFs = process.versions?.electron ? require("original-fs") : fs;
const path = require("node:path");
const { createHash } = require("node:crypto");
const { setImmediate: yieldToMain } = require("node:timers/promises");

const reject = () => { throw Object.assign(new Error("installed-program-rejected"), { code: "installed-program-rejected" }); };
const match = (value, pattern) => typeof value === "string" && pattern.exec(value)?.[0] === value;
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size
  && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.nlink === b.nlink;

function directDirectories(root) {
  let current = path.parse(root).root;
  const result = [];
  for (const part of root.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = diskFs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) reject();
    result.push([current, stat]);
  }
  return result;
}

async function fingerprint(file, maxBytes) {
  const before = await diskFs.promises.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
      || before.size < 1 || before.size > maxBytes) reject();
  const handle = await diskFs.promises.open(file, "r");
  try {
    const opened = await handle.stat();
    if (!same(before, opened)) reject();
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    while (total < opened.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, opened.size - total), total);
      if (bytesRead === 0) reject();
      hash.update(buffer.subarray(0, bytesRead));
      total += bytesRead;
      // Bound individual main-thread work even for a large installed ASAR.
      if (total % (1024 * 1024) === 0) await yieldToMain();
    }
    if (!same(opened, await handle.stat()) || !same(opened, await diskFs.promises.lstat(file))) reject();
    return { sha256: hash.digest("hex"), stat: opened };
  } finally { await handle.close(); }
}

function metadata(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 64 * 1024) reject();
  const bytes = fs.readFileSync(file);
  if (bytes.length !== stat.size) reject();
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

async function collectPackagedWindowsProgramIdentity({ resourcesPath = process.resourcesPath } = {}) {
  try {
    // Only trusted main code may choose an installation. The provider must
    // itself have been loaded from that installation's ASAR. No renderer IPC,
    // environment override, qualification body, save or report supplies facts.
    if (process.platform !== "win32" || process.arch !== "x64"
        || typeof resourcesPath !== "string" || Buffer.byteLength(resourcesPath) > 4096
        || !/^[a-z]:\\/i.test(resourcesPath) || path.resolve(resourcesPath) !== resourcesPath
        || resourcesPath.slice(3).split(path.sep).some((part) => /[.:\s]$|[:\0]/.test(part))
        || path.resolve(__dirname, "..") !== path.join(resourcesPath, "app.asar")) reject();
    const directories = directDirectories(path.join(resourcesPath, "native"));
    const asar = path.join(resourcesPath, "app.asar");
    const host = path.join(resourcesPath, "native", "dsp-native-host.exe");
    const asarIdentity = await fingerprint(asar, 256 * 1024 * 1024);
    const packageInfo = metadata(path.join(asar, "package.json"));
    const renderer = metadata(path.join(asar, "dist", "version.json"));
    const version = packageInfo.version;
    const sourceSha = packageInfo.nativeBuildSourceSha;
    if (!match(version, /^\d{1,5}\.\d{1,5}\.\d{1,5}$/) || !match(sourceSha, /^[a-f0-9]{40}$/)
        || packageInfo.nativeBuildId !== `${version}+${sourceSha.slice(0, 12)}`
        || renderer.version !== version || renderer.buildId !== packageInfo.nativeBuildId
        || renderer.platform !== "desktop" || packageInfo.desktopEditionId !== "windows-performance-development-v1"
        || packageInfo.releaseChannel !== "beta") reject();
    const hostIdentity = await fingerprint(host, 128 * 1024 * 1024);
    if (!same(asarIdentity.stat, await diskFs.promises.lstat(asar))) reject();
    for (const [directory, before] of directories) {
      const after = await diskFs.promises.lstat(directory);
      if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino) reject();
    }
    return Object.freeze({ version, sourceSha, buildId: packageInfo.nativeBuildId,
      editionId: packageInfo.desktopEditionId, channel: packageInfo.releaseChannel,
      platform: "win32", arch: "x64", hostSha256: hostIdentity.sha256, asarSha256: asarIdentity.sha256 });
  } catch { reject(); }
}

module.exports = { collectPackagedWindowsProgramIdentity };
