"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createPackage, extractFile } = require("@electron/asar");
const { validateConfiguration } = require("app-builder-lib/out/util/config/config.js");
const { DebugLogger } = require("builder-util");
const {
  PERFORMANCE_EDITION_IDENTITY,
  STABLE_IDENTITY,
  initializePerformanceEditionIdentity,
  resolvePerformanceEditionOutputDirectory,
  validatePerformanceEditionPackageIdentity,
  verifyPackagedPerformanceEditionIdentity,
} = require("./performance-edition-identity.cjs");
const {
  createDesktopUpdateFeedArguments,
  finalizePackagedOutput,
} = require("./pack.cjs");

const packageMetadata = require("../package.json");

function directDirectoryMetadata(ino) {
  return {
    dev: 1,
    ino,
    isDirectory: () => true,
    isSymbolicLink: () => false,
  };
}

function missingPathError(value) {
  const error = new Error(`missing ${value}`);
  error.code = "ENOENT";
  return error;
}

function runtimeApp(appDataPath, calls) {
  return {
    getPath(name) {
      calls.push(["getPath", name]);
      assert.equal(name, "appData");
      return appDataPath;
    },
    setName(name) { calls.push(["setName", name]); },
    setPath(name, value) { calls.push(["setPath", name, value]); },
  };
}

function removeDirectoryRedirect(redirectPath) {
  try {
    fs.unlinkSync(redirectPath);
  } catch (error) {
    if (!error || !["EISDIR", "EPERM"].includes(error.code)) throw error;
    fs.rmdirSync(redirectPath);
  }
}

function assertOnlyOutsideSentinel(outsidePath) {
  assert.equal(fs.readFileSync(path.join(outsidePath, "stable-player-save.json"), "utf8"), "stable-data");
  assert.deepEqual(fs.readdirSync(outsidePath), ["stable-player-save.json"]);
}

test("package and NSIS metadata are frozen to a 1.2.3 identity distinct from the stable application", () => {
  assert.equal(packageMetadata.version, "1.2.3");
  assert.equal(validatePerformanceEditionPackageIdentity(packageMetadata, {
    requireBuildConfiguration: true,
    requireOfflineDefaults: true,
  }), true);
  assert.notEqual(PERFORMANCE_EDITION_IDENTITY.appId, STABLE_IDENTITY.appId);
  assert.notEqual(PERFORMANCE_EDITION_IDENTITY.appUserModelId, STABLE_IDENTITY.appUserModelId);
  assert.notEqual(PERFORMANCE_EDITION_IDENTITY.productName, STABLE_IDENTITY.productName);
  assert.notEqual(PERFORMANCE_EDITION_IDENTITY.outputDirectoryName, STABLE_IDENTITY.outputDirectoryName);
  assert.equal(Object.prototype.hasOwnProperty.call(packageMetadata.build.nsis, "guid"), false);
  assert.equal(packageMetadata.updateBaseUrl, "");
  assert.equal(packageMetadata.cloudApiBaseUrl, "");
  assert.match(packageMetadata.scripts["desktop:release"], /node desktop\/pack\.cjs release/);
  assert.doesNotMatch(packageMetadata.scripts["desktop:release"], /create-native-update-manifests/);
});

test("desktop release feed follows the exact successful standard or fallback output", () => {
  const repositoryRoot = path.resolve(__dirname, "..");
  const standardOutput = resolvePerformanceEditionOutputDirectory(repositoryRoot);
  const fallbackOutput = path.resolve(`${standardOutput}-fallback`);
  for (const sourceDirectory of [standardOutput, fallbackOutput]) {
    const args = createDesktopUpdateFeedArguments(sourceDirectory, {
      repositoryRoot,
      releaseChannel: "beta",
      updateBaseUrl: "https://updates.example.test/desktop",
    });
    assert.deepEqual(args.slice(1), [
      "--channel", "beta",
      "--base-url", "https://updates.example.test/desktop",
      "--desktop-source", sourceDirectory,
      "--output", path.join(sourceDirectory, "update-feed"),
    ]);
  }
  assert.throws(() => createDesktopUpdateFeedArguments(path.resolve(repositoryRoot, "release"), {
    repositoryRoot,
    releaseChannel: "stable",
    updateBaseUrl: "https://updates.example.test/desktop",
  }), /输出目录/);
});

test("desktop fallback finalization propagates feed failure without reading the standard output", async () => {
  const repositoryRoot = path.resolve(__dirname, "..");
  const standardOutput = resolvePerformanceEditionOutputDirectory(repositoryRoot);
  const fallbackOutput = path.resolve(`${standardOutput}-fallback`);
  const calls = [];
  const result = await finalizePackagedOutput(fallbackOutput, {
    verify(sourceDirectory) {
      calls.push(["verify", sourceDirectory]);
    },
    releaseMode: true,
    async createUpdateFeed(sourceDirectory) {
      calls.push(["feed", sourceDirectory]);
      return 17;
    },
  });
  assert.equal(result, 17);
  assert.deepEqual(calls, [
    ["verify", fallbackOutput],
    ["feed", fallbackOutput],
  ]);
  assert.equal(calls.some(([, sourceDirectory]) => sourceDirectory === standardOutput), false);
});

test("electron-builder accepts the frozen performance-edition package configuration", async () => {
  await validateConfiguration(packageMetadata.build, new DebugLogger(false));
});

test("package identity validation rejects every stable or collision-prone build field", () => {
  const mutations = [
    (value) => { value.desktopEditionId = "stable"; },
    (value) => { value.productName = STABLE_IDENTITY.productName; },
    (value) => { value.updateBaseUrl = "https://updates.example.test"; },
    (value) => { value.cloudApiBaseUrl = "https://api.example.test"; },
    (value) => { value.build.appId = STABLE_IDENTITY.appId; },
    (value) => { value.build.productName = STABLE_IDENTITY.productName; },
    (value) => { value.build.directories.output = STABLE_IDENTITY.outputDirectoryName; },
    (value) => { value.build.win.executableName = "dsp-idle"; },
    (value) => { value.build.win.artifactName = "dsp-idle-${version}-${arch}-setup.${ext}"; },
    (value) => { value.build.nsis.shortcutName = STABLE_IDENTITY.productName; },
    (value) => { value.build.nsis.uninstallDisplayName = STABLE_IDENTITY.productName; },
    (value) => { value.build.nsis.allowToChangeInstallationDirectory = true; },
    (value) => { value.build.nsis.deleteAppDataOnUninstall = true; },
    (value) => { value.build.nsis.guid = "00000000-0000-0000-0000-000000000000"; },
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(packageMetadata);
    mutate(candidate);
    assert.throws(() => validatePerformanceEditionPackageIdentity(candidate, {
      requireBuildConfiguration: true,
      requireOfflineDefaults: true,
    }), /Windows 性能开发版/);
  }
});

test("runtime identity creates only fixed performance-edition userData and Chromium session directories", () => {
  const appDataPath = "C:\\Users\\player\\AppData\\Roaming";
  const operations = [];
  const app = runtimeApp(appDataPath, operations);
  const directories = new Map([[appDataPath, directDirectoryMetadata(1)]]);
  let nextIno = 2;
  const fileSystem = {
    lstatSync(value) {
      operations.push(["lstatSync", value]);
      const metadata = directories.get(value);
      if (!metadata) throw missingPathError(value);
      return metadata;
    },
    mkdirSync(value) {
      operations.push(["mkdirSync", value]);
      directories.set(value, directDirectoryMetadata(nextIno));
      nextIno += 1;
    },
  };

  const result = initializePerformanceEditionIdentity({ app, fileSystem, pathModule: path.win32 });
  const expectedUserData = path.win32.join(appDataPath, PERFORMANCE_EDITION_IDENTITY.userDataDirectoryName);
  const expectedSessionData = path.win32.join(expectedUserData, PERFORMANCE_EDITION_IDENTITY.sessionDataDirectoryName);
  assert.equal(result.userDataPath, expectedUserData);
  assert.equal(result.sessionDataPath, expectedSessionData);
  assert.equal(result.smokeIsolated, false);
  assert.notEqual(result.userDataPath, path.win32.join(appDataPath, STABLE_IDENTITY.productName));
  assert.deepEqual(operations.filter(([operation]) => operation === "mkdirSync"), [
    ["mkdirSync", expectedUserData],
    ["mkdirSync", expectedSessionData],
  ]);
  assert.deepEqual(operations.slice(-3), [
    ["setName", PERFORMANCE_EDITION_IDENTITY.productName],
    ["setPath", "userData", expectedUserData],
    ["setPath", "sessionData", expectedSessionData],
  ]);
  assert.ok(operations.filter(([operation]) => operation === "lstatSync").length >= 8);
});

test("beta packaged smoke can use one explicit direct temporary AppData root", (t) => {
  const temporaryRootPath = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-performance-smoke-parent-"));
  // The production contract deliberately requires the selected root to be a
  // direct child of the configured system temporary directory. Use this test's
  // temporary parent as that configured root so cleanup stays self-contained.
  const appDataPath = path.join(temporaryRootPath, "dspidle-performance-smoke-isolated-profile");
  fs.mkdirSync(appDataPath);
  t.after(() => fs.rmSync(temporaryRootPath, { recursive: true, force: true }));
  const calls = [];
  const app = runtimeApp("C:\\Users\\player\\AppData\\Roaming", calls);
  const result = initializePerformanceEditionIdentity({
    app,
    smokeIsolation: {
      enabled: true,
      releaseChannel: "beta",
      appDataRoot: appDataPath,
      temporaryRootPath,
    },
  });
  assert.equal(result.userDataPath, path.join(appDataPath, PERFORMANCE_EDITION_IDENTITY.userDataDirectoryName));
  assert.equal(result.sessionDataPath, path.join(result.userDataPath, PERFORMANCE_EDITION_IDENTITY.sessionDataDirectoryName));
  assert.equal(result.smokeIsolated, true);
  assert.equal(calls.some(([operation]) => operation === "getPath"), false);
  assert.deepEqual(calls.slice(-3), [
    ["setName", PERFORMANCE_EDITION_IDENTITY.productName],
    ["setPath", "userData", result.userDataPath],
    ["setPath", "sessionData", result.sessionDataPath],
  ]);
});

test("smoke isolation rejects stable channel, missing roots, redirects, and paths outside the temporary parent", (t) => {
  const temporaryRootPath = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-performance-smoke-policy-"));
  const validRoot = path.join(temporaryRootPath, "dspidle-performance-smoke-valid");
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dspidle-performance-smoke-outside-"));
  fs.mkdirSync(validRoot);
  t.after(() => {
    fs.rmSync(temporaryRootPath, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  });
  const invoke = (overrides) => initializePerformanceEditionIdentity({
    app: runtimeApp("C:\\Users\\player\\AppData\\Roaming", []),
    smokeIsolation: {
      enabled: true,
      releaseChannel: "beta",
      appDataRoot: validRoot,
      temporaryRootPath,
      ...overrides,
    },
  });
  assert.throws(() => invoke({ releaseChannel: "stable" }), /smoke 隔离配置无效/);
  assert.throws(() => invoke({ appDataRoot: path.join(temporaryRootPath, "dspidle-performance-smoke-missing") }), /必须预先创建/);
  assert.throws(() => invoke({ appDataRoot: outsideRoot }), /直属测试目录/);

  const redirectedRoot = path.join(temporaryRootPath, "dspidle-performance-smoke-redirect");
  try {
    fs.symlinkSync(outsideRoot, redirectedRoot, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (error && ["EACCES", "EPERM", "ENOTSUP"].includes(error.code)) return;
    throw error;
  }
  assert.throws(() => invoke({ appDataRoot: redirectedRoot }), /符号链接|reparse point/);
});

test("identity initialization fails closed instead of falling back to Electron stable defaults", () => {
  const calls = [];
  const app = {
    getPath(name) {
      calls.push(["getPath", name]);
      return "C:\\Users\\player\\AppData\\Roaming";
    },
    setName(name) { calls.push(["setName", name]); },
    setPath(name, value) { calls.push(["setPath", name, value]); },
  };
  assert.throws(() => initializePerformanceEditionIdentity({
    app,
    pathModule: path.win32,
    fileSystem: {
      lstatSync(value) {
        if (value.endsWith("Roaming")) return directDirectoryMetadata(1);
        throw missingPathError(value);
      },
      mkdirSync() { throw new Error("disk unavailable"); },
    },
  }), /disk unavailable/);
  assert.deepEqual(calls, [["getPath", "appData"]]);
});

test("runtime identity rejects cross-platform directory symlinks without touching their target", (t) => {
  const appDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-performance-symlink-root-"));
  const outsidePath = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-stable-symlink-target-"));
  const userDataPath = path.join(appDataPath, PERFORMANCE_EDITION_IDENTITY.userDataDirectoryName);
  fs.writeFileSync(path.join(outsidePath, "stable-player-save.json"), "stable-data");
  try {
    fs.symlinkSync(outsidePath, userDataPath, "dir");
  } catch (error) {
    fs.rmSync(appDataPath, { recursive: true, force: true });
    fs.rmSync(outsidePath, { recursive: true, force: true });
    if (error && ["EACCES", "EPERM", "ENOTSUP"].includes(error.code)) {
      t.skip(`directory symlink privilege unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  t.after(() => {
    removeDirectoryRedirect(userDataPath);
    fs.rmSync(appDataPath, { recursive: true, force: true });
    fs.rmSync(outsidePath, { recursive: true, force: true });
  });
  const calls = [];
  assert.throws(
    () => initializePerformanceEditionIdentity({ app: runtimeApp(appDataPath, calls) }),
    /符号链接|reparse point/,
  );
  assert.deepEqual(calls, [["getPath", "appData"]]);
  assertOnlyOutsideSentinel(outsidePath);
});

test("runtime identity rejects pre-positioned Windows userData and sessionData junctions", {
  skip: process.platform === "win32" ? false : "Windows junction semantics",
}, (t) => {
  for (const redirectedDirectory of ["userData", "sessionData"]) {
    const appDataPath = fs.mkdtempSync(path.join(os.tmpdir(), `dsp-performance-${redirectedDirectory}-root-`));
    const outsidePath = fs.mkdtempSync(path.join(os.tmpdir(), `dsp-stable-${redirectedDirectory}-target-`));
    const userDataPath = path.join(appDataPath, PERFORMANCE_EDITION_IDENTITY.userDataDirectoryName);
    const redirectPath = redirectedDirectory === "userData"
      ? userDataPath
      : path.join(userDataPath, PERFORMANCE_EDITION_IDENTITY.sessionDataDirectoryName);
    fs.writeFileSync(path.join(outsidePath, "stable-player-save.json"), "stable-data");
    if (redirectedDirectory === "sessionData") fs.mkdirSync(userDataPath);
    try {
      fs.symlinkSync(outsidePath, redirectPath, "junction");
    } catch (error) {
      fs.rmSync(appDataPath, { recursive: true, force: true });
      fs.rmSync(outsidePath, { recursive: true, force: true });
      if (error && ["EACCES", "EPERM", "ENOTSUP"].includes(error.code)) {
        t.skip(`Windows junction creation unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    try {
      assert.equal(fs.lstatSync(redirectPath).isSymbolicLink(), true);
      const calls = [];
      assert.throws(
        () => initializePerformanceEditionIdentity({ app: runtimeApp(appDataPath, calls) }),
        /符号链接|reparse point/,
      );
      assert.deepEqual(calls, [["getPath", "appData"]]);
      assertOnlyOutsideSentinel(outsidePath);
    } finally {
      removeDirectoryRedirect(redirectPath);
      fs.rmSync(appDataPath, { recursive: true, force: true });
      fs.rmSync(outsidePath, { recursive: true, force: true });
    }
  }
});

test("packaging output is fixed outside release and pack.cjs has no free output-path environment override", () => {
  const repositoryRoot = path.resolve(__dirname, "..");
  const output = resolvePerformanceEditionOutputDirectory(repositoryRoot);
  assert.equal(output, path.join(repositoryRoot, PERFORMANCE_EDITION_IDENTITY.outputDirectoryName));
  assert.notEqual(output, path.join(repositoryRoot, STABLE_IDENTITY.outputDirectoryName));

  const packSource = fs.readFileSync(path.join(__dirname, "pack.cjs"), "utf8");
  assert.equal(packSource.includes("DSP_DESKTOP_OUTPUT_DIR"), false);
  assert.match(packSource, /resolvePerformanceEditionOutputDirectory\(repositoryRoot\)/);
  assert.match(packSource, /verifyPackagedPerformanceEditionIdentity/);
  assert.match(
    packSource,
    /process\.env\.DSP_RELEASE_CHANNEL \|\| packageMetadata\.releaseChannel/,
  );
});

test("main applies isolated data identity before locks or userData reads and binds the Windows taskbar identity", () => {
  const source = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const initializeOffset = source.indexOf("initializePerformanceEditionIdentity({");
  const userDataOffset = source.indexOf('app.getPath("userData")');
  const lockOffset = source.indexOf("app.requestSingleInstanceLock()");
  const readyOffset = source.indexOf("app.whenReady()");
  assert.ok(initializeOffset >= 0);
  assert.ok(userDataOffset > initializeOffset);
  assert.ok(lockOffset > initializeOffset);
  assert.ok(readyOffset > initializeOffset);
  assert.match(source, /DSP_PERFORMANCE_SMOKE_ISOLATION/);
  assert.match(source, /releaseChannel: packageMetadata\.releaseChannel/);
  assert.match(source, /app\.setAppUserModelId\(PERFORMANCE_EDITION_IDENTITY\.appUserModelId\)/);
  assert.match(source, /window\.on\("page-title-updated"/);
  assert.match(source, /if \(!window\.isDestroyed\(\)\) window\.setTitle\(PERFORMANCE_EDITION_IDENTITY\.productName\)/);
  assert.equal(source.includes('app.setAppUserModelId("com.dspidle.network")'), false);
});

test("packaged identity verifier accepts only the dedicated executable and rejects stable executable residue", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-performance-identity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const unpackedDirectory = path.join(root, "win-unpacked");
  const resourcesDirectory = path.join(unpackedDirectory, "resources");
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(resourcesDirectory, { recursive: true });
  fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({
    name: "dsp-idle-network",
    version: "1.2.3",
    desktopEditionId: PERFORMANCE_EDITION_IDENTITY.editionId,
    productName: PERFORMANCE_EDITION_IDENTITY.productName,
  }));
  const asarPath = path.join(resourcesDirectory, "app.asar");
  await createPackage(source, asarPath);
  const expectedExecutable = path.join(unpackedDirectory, `${PERFORMANCE_EDITION_IDENTITY.executableName}.exe`);
  fs.writeFileSync(expectedExecutable, "fixture");

  assert.deepEqual(verifyPackagedPerformanceEditionIdentity({
    asarPath,
    unpackedDirectory,
    extractAsarFile: extractFile,
  }), {
    editionId: PERFORMANCE_EDITION_IDENTITY.editionId,
    appId: PERFORMANCE_EDITION_IDENTITY.appId,
    productName: PERFORMANCE_EDITION_IDENTITY.productName,
    executableName: PERFORMANCE_EDITION_IDENTITY.executableName,
  });

  const stableExecutable = path.join(unpackedDirectory, `${STABLE_IDENTITY.productName}.exe`);
  fs.writeFileSync(stableExecutable, "stable residue");
  assert.throws(() => verifyPackagedPerformanceEditionIdentity({
    asarPath,
    unpackedDirectory,
    extractAsarFile: extractFile,
  }), /混入稳定版可执行身份/);
  fs.unlinkSync(stableExecutable);
  fs.unlinkSync(expectedExecutable);
  assert.throws(() => verifyPackagedPerformanceEditionIdentity({
    asarPath,
    unpackedDirectory,
    extractAsarFile: extractFile,
  }), /缺少独立可执行文件/);
});
