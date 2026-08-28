"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PERFORMANCE_EDITION_IDENTITY = Object.freeze({
  schemaVersion: 1,
  editionId: "windows-performance-development-v1",
  appId: "com.dspidle.network.performance",
  appUserModelId: "com.dspidle.network.performance",
  productName: "DSP极简网络 Windows 性能开发版",
  executableName: "dsp-idle-performance-edition",
  installerArtifactName: "dsp-idle-performance-edition-${version}-${arch}-setup.${ext}",
  outputDirectoryName: "release-performance-edition",
  userDataDirectoryName: "DSPidle2-Performance-Edition",
  sessionDataDirectoryName: "Chromium",
});

const STABLE_IDENTITY = Object.freeze({
  appId: "com.dspidle.network",
  appUserModelId: "com.dspidle.network",
  productName: "DSP极简网络",
  outputDirectoryName: "release",
});

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`Windows 性能开发版 ${label} 不符合冻结身份`);
}

function validatePerformanceEditionPackageIdentity(metadata, {
  requireBuildConfiguration = false,
  requireOfflineDefaults = false,
} = {}) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new TypeError("Windows 性能开发版缺少 package metadata");
  }
  assertEqual(metadata.desktopEditionId, PERFORMANCE_EDITION_IDENTITY.editionId, "editionId");
  assertEqual(metadata.productName, PERFORMANCE_EDITION_IDENTITY.productName, "productName");
  if (requireOfflineDefaults) {
    assertEqual(metadata.updateBaseUrl, "", "默认 updateBaseUrl");
    assertEqual(metadata.cloudApiBaseUrl, "", "默认 cloudApiBaseUrl");
  }
  if (!requireBuildConfiguration) return true;

  const build = metadata.build;
  if (!build || typeof build !== "object" || Array.isArray(build)) {
    throw new Error("Windows 性能开发版缺少 electron-builder 配置");
  }
  assertEqual(build.appId, PERFORMANCE_EDITION_IDENTITY.appId, "appId");
  assertEqual(build.productName, PERFORMANCE_EDITION_IDENTITY.productName, "build.productName");
  assertEqual(build.directories?.output, PERFORMANCE_EDITION_IDENTITY.outputDirectoryName, "输出目录");
  assertEqual(build.win?.executableName, PERFORMANCE_EDITION_IDENTITY.executableName, "可执行文件名");
  assertEqual(build.win?.artifactName, PERFORMANCE_EDITION_IDENTITY.installerArtifactName, "安装制品名");
  assertEqual(build.nsis?.shortcutName, PERFORMANCE_EDITION_IDENTITY.productName, "快捷方式名");
  assertEqual(build.nsis?.uninstallDisplayName, PERFORMANCE_EDITION_IDENTITY.productName, "卸载项名称");
  assertEqual(build.nsis?.allowToChangeInstallationDirectory, false, "安装目录锁定策略");
  assertEqual(build.nsis?.deleteAppDataOnUninstall, false, "卸载数据保留策略");
  if (Object.prototype.hasOwnProperty.call(build.nsis ?? {}, "guid")) {
    throw new Error("Windows 性能开发版 NSIS 身份必须由冻结 appId 确定生成");
  }
  return true;
}

function resolvePerformanceEditionOutputDirectory(repositoryRoot, pathModule = path) {
  if (typeof repositoryRoot !== "string" || !pathModule.isAbsolute(repositoryRoot)) {
    throw new TypeError("Windows 性能开发版仓库根目录必须是绝对路径");
  }
  const outputDirectory = pathModule.resolve(repositoryRoot, PERFORMANCE_EDITION_IDENTITY.outputDirectoryName);
  const stableDirectory = pathModule.resolve(repositoryRoot, STABLE_IDENTITY.outputDirectoryName);
  if (outputDirectory === stableDirectory) throw new Error("Windows 性能开发版不能复用稳定版输出目录");
  return outputDirectory;
}

function readDirectDirectory(fileSystem, directoryPath, label) {
  let metadata;
  try {
    metadata = fileSystem.lstatSync(directoryPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  // Node reports Windows symbolic links, directory junctions, and mount-point
  // reparse entries as links from lstat. Never stat/realpath first: either would
  // follow the redirect before the performance-edition boundary is established.
  if (metadata.isSymbolicLink()) {
    throw new Error(`Windows 性能开发版 ${label} 不能是符号链接或 Windows reparse point`);
  }
  if (!metadata.isDirectory()) {
    throw new Error(`Windows 性能开发版 ${label} 必须是直接目录`);
  }
  return metadata;
}

function sameDirectoryIdentity(left, right) {
  const comparable = ["dev", "ino"].filter((key) => (
    (typeof left?.[key] === "number" || typeof left?.[key] === "bigint")
    && typeof left[key] === typeof right?.[key]
  ));
  return comparable.length === 0 || comparable.every((key) => left[key] === right[key]);
}

function requireSameDirectDirectory(fileSystem, directoryPath, expected, label) {
  const current = readDirectDirectory(fileSystem, directoryPath, label);
  if (!current) throw new Error(`Windows 性能开发版 ${label} 在初始化期间消失`);
  if (!sameDirectoryIdentity(expected, current)) {
    throw new Error(`Windows 性能开发版 ${label} 在初始化期间被替换`);
  }
  return current;
}

function createFixedDirectDirectory(fileSystem, parentPath, directoryPath, label) {
  const parent = readDirectDirectory(fileSystem, parentPath, `${label} 的父目录`);
  if (!parent) throw new Error(`Windows 性能开发版 ${label} 的父目录不存在`);
  let metadata = readDirectDirectory(fileSystem, directoryPath, label);
  if (!metadata) {
    try {
      // The parent is already verified. A non-recursive create cannot silently
      // manufacture descendants through a pre-positioned redirect.
      fileSystem.mkdirSync(directoryPath);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    metadata = readDirectDirectory(fileSystem, directoryPath, label);
    if (!metadata) throw new Error(`Windows 性能开发版 ${label} 创建失败`);
  }
  requireSameDirectDirectory(fileSystem, parentPath, parent, `${label} 的父目录`);
  return metadata;
}

function initializePerformanceEditionIdentity({
  app,
  fileSystem = fs,
  pathModule = path,
  smokeIsolation = null,
} = {}) {
  if (!app || typeof app.getPath !== "function" || typeof app.setPath !== "function" || typeof app.setName !== "function") {
    throw new TypeError("Windows 性能开发版需要完整 Electron app identity API");
  }
  let appDataPath;
  let smokeIsolated = false;
  if (smokeIsolation !== null) {
    if (
      !smokeIsolation
      || smokeIsolation.enabled !== true
      || !["beta", "nightly"].includes(smokeIsolation.releaseChannel)
      || typeof smokeIsolation.appDataRoot !== "string"
      || !pathModule.isAbsolute(smokeIsolation.appDataRoot)
    ) {
      throw new Error("Windows 性能开发版 smoke 隔离配置无效");
    }
    const temporaryRootPath = pathModule.resolve(smokeIsolation.temporaryRootPath ?? os.tmpdir());
    appDataPath = pathModule.resolve(smokeIsolation.appDataRoot);
    if (
      pathModule.dirname(appDataPath) !== temporaryRootPath
      || !pathModule.basename(appDataPath).startsWith("dspidle-performance-smoke-")
    ) {
      throw new Error("Windows 性能开发版 smoke AppData 必须是系统临时目录的直属测试目录");
    }
    if (!readDirectDirectory(fileSystem, temporaryRootPath, "smoke 临时目录")) {
      throw new Error("Windows 性能开发版 smoke 临时目录不存在");
    }
    if (!readDirectDirectory(fileSystem, appDataPath, "smoke AppData")) {
      throw new Error("Windows 性能开发版 smoke AppData 必须预先创建");
    }
    smokeIsolated = true;
  } else {
    appDataPath = app.getPath("appData");
  }
  if (typeof appDataPath !== "string" || !pathModule.isAbsolute(appDataPath)) {
    throw new Error("Windows 性能开发版无法取得独立 AppData 根目录");
  }
  const userDataPath = pathModule.join(appDataPath, PERFORMANCE_EDITION_IDENTITY.userDataDirectoryName);
  const sessionDataPath = pathModule.join(userDataPath, PERFORMANCE_EDITION_IDENTITY.sessionDataDirectoryName);
  if (
    pathModule.dirname(userDataPath) !== pathModule.resolve(appDataPath)
    || pathModule.dirname(sessionDataPath) !== userDataPath
  ) {
    throw new Error("Windows 性能开发版 userData 路径越界");
  }

  // Electron setPath requires existing directories. Failure is intentionally fatal:
  // falling back to its stable-product default could read or overwrite player data.
  const userDataIdentity = createFixedDirectDirectory(
    fileSystem,
    appDataPath,
    userDataPath,
    "userData",
  );
  requireSameDirectDirectory(fileSystem, userDataPath, userDataIdentity, "userData");
  const sessionDataIdentity = createFixedDirectDirectory(
    fileSystem,
    userDataPath,
    sessionDataPath,
    "sessionData",
  );
  // Re-check both fixed directories immediately before Electron can use them.
  // This narrows the remaining path-based TOCTOU window without native/unsafe APIs.
  requireSameDirectDirectory(fileSystem, userDataPath, userDataIdentity, "userData");
  requireSameDirectDirectory(fileSystem, sessionDataPath, sessionDataIdentity, "sessionData");
  app.setName(PERFORMANCE_EDITION_IDENTITY.productName);
  app.setPath("userData", userDataPath);
  app.setPath("sessionData", sessionDataPath);
  return Object.freeze({
    ...PERFORMANCE_EDITION_IDENTITY,
    userDataPath,
    sessionDataPath,
    smokeIsolated,
  });
}

function verifyPackagedPerformanceEditionIdentity({
  asarPath,
  unpackedDirectory,
  extractAsarFile,
  fileSystem = fs,
  pathModule = path,
}) {
  if (typeof extractAsarFile !== "function") throw new TypeError("ASAR extractor is required");
  const metadata = JSON.parse(extractAsarFile(asarPath, "package.json").toString("utf8"));
  validatePerformanceEditionPackageIdentity(metadata);
  const expectedExecutable = pathModule.join(
    unpackedDirectory,
    `${PERFORMANCE_EDITION_IDENTITY.executableName}.exe`,
  );
  if (!fileSystem.existsSync(expectedExecutable)) {
    throw new Error("Windows 性能开发版目录包缺少独立可执行文件");
  }
  for (const stableExecutableName of ["DSP极简网络.exe", "dsp-idle.exe", "dsp-idle-network.exe"]) {
    if (fileSystem.existsSync(pathModule.join(unpackedDirectory, stableExecutableName))) {
      throw new Error("Windows 性能开发版目录包混入稳定版可执行身份");
    }
  }
  return {
    editionId: PERFORMANCE_EDITION_IDENTITY.editionId,
    appId: PERFORMANCE_EDITION_IDENTITY.appId,
    productName: PERFORMANCE_EDITION_IDENTITY.productName,
    executableName: PERFORMANCE_EDITION_IDENTITY.executableName,
  };
}

module.exports = {
  PERFORMANCE_EDITION_IDENTITY,
  STABLE_IDENTITY,
  initializePerformanceEditionIdentity,
  resolvePerformanceEditionOutputDirectory,
  validatePerformanceEditionPackageIdentity,
  verifyPackagedPerformanceEditionIdentity,
};
