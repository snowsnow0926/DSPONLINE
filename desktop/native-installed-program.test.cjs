"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createHash } = require("node:crypto");
const real = require("./native-installed-program.cjs");
const code = fs.readFileSync(path.join(__dirname, "native-installed-program.cjs"), "utf8");
const root = "C:\\Program Files\\DSP\\resources";
const asar = `${root}\\app.asar`;
const host = `${root}\\native\\dsp-native-host.exe`;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

// TEST_ONLY filesystem and ASAR loader. Actual installed Electron execution
// belongs to the separately frozen package smoke, never to this VM fixture.
function fixture({ electronAsar = false } = {}) {
  const packageInfo = { version: "1.2.7", nativeBuildSourceSha: "a".repeat(40), nativeBuildId: "1.2.7+aaaaaaaaaaaa",
    desktopEditionId: "windows-performance-development-v1", releaseChannel: "beta" };
  const renderer = { version: packageInfo.version, buildId: packageInfo.nativeBuildId, platform: "desktop" };
  const files = new Map([[asar, Buffer.alloc(2 * 1024 * 1024 + 7, 0xa5)], [host, Buffer.alloc(77, 0x31)]]);
  const overrides = new Map();
  const reads = [];
  let opened = 0; let closed = 0; let yields = 0;
  let onRead = () => {};
  const process = { platform: "win32", arch: "x64", resourcesPath: root, versions: electronAsar ? { electron: "43.1.1" } : {},
    env: { DSP_NATIVE_HOST_PATH: "forged.exe", DSP_NATIVE_SOURCE_SHA: "f".repeat(40) } };
  const encode = (file) => file === `${asar}\\package.json` ? Buffer.from(JSON.stringify(packageInfo))
    : file === `${asar}\\dist\\version.json` ? Buffer.from(JSON.stringify(renderer)) : files.get(file);
  function stat(file) {
    const bytes = encode(file);
    const directory = !bytes;
    return { dev: 1, ino: file, size: bytes?.length ?? 0, nlink: 1, mtimeMs: 1, ctimeMs: 1,
      isFile: () => !directory, isDirectory: () => directory, isSymbolicLink: () => false, ...overrides.get(file) };
  }
  const fakeFs = {
    lstatSync: stat, readFileSync: (file) => { reads.push(file); return encode(file); },
    promises: { lstat: async (file) => stat(file), open: async (file) => {
      opened++;
      return { stat: async () => stat(file), close: async () => { closed++; },
        read: async (buffer, offset, length, position) => {
          reads.push(file); assert.ok(length <= 64 * 1024);
          const bytes = encode(file); const count = Math.min(length, bytes.length - position);
          bytes.copy(buffer, offset, position, position + count); onRead(file);
          return { bytesRead: count };
        } };
    } },
  };
  const module = { exports: {} };
  // Electron exposes the ASAR container as a virtual directory through fs;
  // original-fs is required to inspect/hash its actual disk bytes.
  const virtualStat = (file) => file === asar ? { ...stat(file), size: 0,
    isFile: () => false, isDirectory: () => true } : stat(file);
  const electronFs = { ...fakeFs, lstatSync: virtualStat,
    promises: { ...fakeFs.promises, lstat: async (file) => virtualStat(file) } };
  const context = { module, Buffer, TextDecoder, process, __dirname: `${asar}\\desktop`,
    require(name) {
      if (name === "node:fs") return electronAsar ? electronFs : fakeFs;
      if (name === "original-fs") { assert.equal(electronAsar, true); return fakeFs; }
      if (name === "node:path") return path.win32;
      if (name === "node:timers/promises") return { setImmediate: async () => { yields++; } };
      return require(name);
    } };
  vm.runInNewContext(code, context);
  return { ...module.exports, packageInfo, renderer, files, overrides, process, context, reads,
    setOnRead(fn) { onRead = fn; }, counters: () => ({ opened, closed, yields }) };
}

test("installed facts bind own ASAR metadata and bounded streamed Host/ASAR bytes", async () => {
  const f = fixture(); const facts = await f.collectPackagedWindowsProgramIdentity();
  assert.deepEqual(JSON.parse(JSON.stringify(facts)), {
    version: "1.2.7", sourceSha: "a".repeat(40), buildId: "1.2.7+aaaaaaaaaaaa",
    editionId: "windows-performance-development-v1", channel: "beta", platform: "win32", arch: "x64",
    hostSha256: hash(f.files.get(host)), asarSha256: hash(f.files.get(asar)),
  });
  assert.equal(Object.isFrozen(facts), true);
  assert.deepEqual(f.counters(), { opened: 2, closed: 2, yields: 2 });
  assert.ok(f.reads.every((file) => file.startsWith(root)));
  assert.equal(Object.hasOwn(facts, "authorityEligible"), false);
  assert.equal(Object.hasOwn(facts, "catalogSha256"), false);
});

test("Electron virtual ASAR directory uses original-fs for the real container identity", async () => {
  const f = fixture({ electronAsar: true });
  const facts = await f.collectPackagedWindowsProgramIdentity();
  assert.equal(facts.asarSha256, hash(f.files.get(asar)));
  assert.equal(facts.hostSha256, hash(f.files.get(host)));
  assert.equal(facts.sourceSha, f.packageInfo.nativeBuildSourceSha);
  assert.equal(f.counters().opened, f.counters().closed);
});

for (const [name, mutate] of [
  ["Linux", (f) => { f.process.platform = "linux"; }],
  ["other architecture", (f) => { f.process.arch = "arm64"; }],
  ["unpackaged module", (f) => { f.context.__dirname = "C:\\source\\desktop"; }],
  ["missing source", (f) => { delete f.packageInfo.nativeBuildSourceSha; }],
  ["dirty build", (f) => { f.packageInfo.nativeBuildId += ".dirty"; }],
  ["other renderer build", (f) => { f.renderer.buildId += "1"; }],
  ["other renderer version", (f) => { f.renderer.version = "1.2.6"; }],
  ["web renderer", (f) => { f.renderer.platform = "web"; }],
  ["stable edition", (f) => { f.packageInfo.desktopEditionId = "stable-v1"; }],
  ["stable channel", (f) => { f.packageInfo.releaseChannel = "stable"; }],
  ["source newline", (f) => { f.packageInfo.nativeBuildSourceSha += "\n"; }],
  ["version newline", (f) => { f.packageInfo.version += "\n"; }],
  ["hardlinked Host", (f) => { f.overrides.set(host, { nlink: 2 }); }],
  ["redirected ASAR", (f) => { f.overrides.set(asar, { isSymbolicLink: () => true }); }],
  ["redirected ancestor", (f) => { f.overrides.set("C:\\Program Files\\DSP", { isSymbolicLink: () => true }); }],
  ["oversized ASAR", (f) => { f.overrides.set(asar, { size: 256 * 1024 * 1024 + 1 }); }],
  ["oversized Host", (f) => { f.overrides.set(host, { size: 128 * 1024 * 1024 + 1 }); }],
  ["oversized metadata", (f) => { f.packageInfo.extra = "x".repeat(65536); }],
  ["empty Host", (f) => { f.files.set(host, Buffer.alloc(0)); }],
]) {
  test(`installed identity rejects ${name}`, async () => {
    const f = fixture(); mutate(f);
    await assert.rejects(f.collectPackagedWindowsProgramIdentity(), { code: "installed-program-rejected" });
    assert.equal(f.counters().opened, f.counters().closed);
  });
}

test("caller cannot redirect a module to another installation, relative path, stream or UNC share", async () => {
  for (const resourcesPath of ["C:\\other\\resources", ".", "C:\\DSP:stream", "\\\\server\\share", root + "\\..", root + " "]) {
    const f = fixture();
    await assert.rejects(f.collectPackagedWindowsProgramIdentity({ resourcesPath }), { code: "installed-program-rejected" });
    assert.equal(f.counters().opened, 0);
  }
});

test("replacement during either streaming read or between files fails and closes descriptors", async () => {
  for (const mutate of [
    (f, file) => f.overrides.set(file, { ctimeMs: 2 }),
    (f, file) => { if (file === host) f.overrides.set(asar, { ino: "replacement" }); },
    (f, file) => { if (file === host) f.overrides.set(`${root}\\native`, { ino: "replacement" }); },
  ]) {
    const f = fixture(); f.setOnRead((file) => mutate(f, file));
    await assert.rejects(f.collectPackagedWindowsProgramIdentity(), { code: "installed-program-rejected" });
    assert.equal(f.counters().opened, f.counters().closed);
  }
});

test("the actual module refuses development source without reading a user profile", async () => {
  await assert.rejects(real.collectPackagedWindowsProgramIdentity(), { code: "installed-program-rejected" });
});
