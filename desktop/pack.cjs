const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createReleaseChannels, optionalHttpsUrl, resolveReleaseChannel } = require("./release-channels.cjs");
const { validatePackagedTransferContract } = require("./package-contract.cjs");
const { verifyDesktopPackageHygiene } = require("./package-hygiene.cjs");
const {
  resolveDesktopEditionIdentity,
  listDesktopEditionOutputDirectories,
  resolveAllowedDesktopEditionOutputDirectory,
  validateStablePackageIdentity,
  verifyPackagedDesktopEditionIdentity,
} = require("./performance-edition-identity.cjs");
const { extractFile } = require("@electron/asar");
const { expectedDesktopBuild, writeDesktopBuildEvidence, catalogVerifierBuildMetadata, verifyPackagedCatalogVerifier } = require("./desktop-artifact-evidence.cjs");

const repositoryRoot = path.resolve(__dirname, "..");
const packageMetadata = require("../package.json");
validateStablePackageIdentity(packageMetadata, {
  requireBuildConfiguration: true,
  requireOfflineDefaults: true,
});
const expectedTransferContract = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "cloud-transfer-contract.json"), "utf8"));

const builderEntry = require.resolve("electron-builder/cli");
const mode = process.argv[2] || "pack";
const desktopIdentity = resolveDesktopEditionIdentity(
  packageMetadata,
  process.env.DSP_DESKTOP_EDITION || "stable",
);
const desktopOutputDirectories = listDesktopEditionOutputDirectories(repositoryRoot, desktopIdentity);
const outputDirectory = desktopOutputDirectories.standard;
const buildMode = mode === "release" ? "dist" : mode;
const releaseChannel = resolveReleaseChannel(
  process.env.DSP_RELEASE_CHANNEL || packageMetadata.releaseChannel,
);
const updateBaseUrl = optionalHttpsUrl(process.env.DSP_UPDATE_BASE_URL, "Desktop update base URL");
const cloudApiBaseUrl = optionalHttpsUrl(process.env.DSP_DESKTOP_API_BASE_URL, "Desktop cloud API base URL");
if (buildMode === "dist" && (!updateBaseUrl || !cloudApiBaseUrl)) {
  throw new Error("正式桌面安装包必须同时配置 DSP_UPDATE_BASE_URL 和 DSP_DESKTOP_API_BASE_URL");
}
const channels = createReleaseChannels({
  updateBaseUrl,
  stableUrl: process.env.DSP_UPDATE_STABLE_URL,
  betaUrl: process.env.DSP_UPDATE_BETA_URL,
  nightlyUrl: process.env.DSP_UPDATE_NIGHTLY_URL,
});
const publishUrl = optionalHttpsUrl(process.env.DSP_DESKTOP_PUBLISH_URL, "Desktop publish URL")
  || channels[releaseChannel].url
  || "https://updates.invalid/dsp-idle";

function runBuilder(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [builderEntry, ...args], {
      stdio: "inherit",
      env: { ...process.env, DSP_DESKTOP_PUBLISH_URL: publishUrl },
    });
    child.on("error", () => resolve(1));
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

function runCommand(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: process.env,
      windowsHide: true,
    });
    child.on("error", () => resolve(1));
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

function createDesktopUpdateFeedArguments(sourceDirectory, {
  repositoryRoot: root = repositoryRoot,
  identity = desktopIdentity,
  releaseChannel: channel = releaseChannel,
  updateBaseUrl: baseUrl = updateBaseUrl,
} = {}) {
  const resolvedSource = resolveAllowedDesktopEditionOutputDirectory(root, identity, sourceDirectory);
  if (!baseUrl) throw new Error(`${identity.productName} 更新 feed 缺少 HTTPS 基址`);
  return [
    path.join(path.resolve(__dirname, ".."), "scripts", "create-native-update-manifests.mjs"),
    "--channel", channel,
    "--base-url", baseUrl,
    "--desktop-source", resolvedSource,
    "--output", path.join(resolvedSource, "update-feed"),
  ];
}

async function finalizePackagedOutput(sourceDirectory, {
  verify = verifyPackagedOutput,
  releaseMode = mode === "release",
  createUpdateFeed = (directory) => runCommand(
    process.execPath,
    createDesktopUpdateFeedArguments(directory),
  ),
  recordEvidence = (directory) => writeDesktopBuildEvidence(directory, {
    expected: expectedDesktopBuild(repositoryRoot, desktopIdentity, releaseChannel, { requireClean: releaseMode }),
    identity: desktopIdentity,
    release: releaseMode,
    repositoryRoot,
  }),
} = {}) {
  verify(sourceDirectory);
  if (releaseMode) {
    const result = await createUpdateFeed(sourceDirectory);
    if (result !== 0) return result;
  }
  recordEvidence(sourceDirectory);
  return 0;
}

function verifyPackagedOutput(outputDirectory) {
  const unpackedDirectory = path.join(outputDirectory, "win-unpacked");
  const asarPath = path.join(unpackedDirectory, "resources", "app.asar");
  verifyDesktopPackageHygiene(asarPath);
  verifyPackagedDesktopEditionIdentity({
    asarPath,
    unpackedDirectory,
    extractAsarFile: extractFile,
  });
  const metadata = JSON.parse(extractFile(asarPath, "package.json").toString("utf8"));
  verifyPackagedCatalogVerifier(outputDirectory, metadata);
  if (buildMode !== "dist") return;
  if (metadata.cloudApiBaseUrl !== cloudApiBaseUrl || metadata.updateBaseUrl !== updateBaseUrl) {
    throw new Error("桌面安装包元数据中的云 API 或更新地址与发布配置不一致");
  }
  if (!/^https:\/\//.test(metadata.cloudApiBaseUrl) || !/^https:\/\//.test(metadata.updateBaseUrl)) {
    throw new Error("桌面安装包元数据必须包含 HTTPS 云 API 和更新地址");
  }
  const transferContract = JSON.parse(extractFile(asarPath, "cloud-transfer-contract.json").toString("utf8"));
  validatePackagedTransferContract(transferContract, expectedTransferContract);
}

function identityBuilderArgs(identity, targetOutputDirectory) {
  const performanceEdition = identity.editionId === "windows-performance-development-v1";
  return [
    `--config.extraMetadata.desktopEditionId=${identity.editionId}`,
    ...(performanceEdition ? [`--config.extraMetadata.productName=${identity.productName}`] : []),
    `--config.appId=${identity.appId}`,
    `--config.productName=${identity.productName}`,
    `--config.directories.output=${targetOutputDirectory}`,
    `--config.win.executableName=${identity.executableName}`,
    `--config.win.artifactName=${identity.installerArtifactName}`,
    `--config.nsis.allowToChangeInstallationDirectory=${performanceEdition ? "false" : "true"}`,
    `--config.nsis.shortcutName=${identity.productName}`,
    `--config.nsis.uninstallDisplayName=${identity.productName}`,
    "--config.nsis.deleteAppDataOnUninstall=false",
  ];
}

async function main() {
  if (!["pack", "dist", "release"].includes(mode)) throw new Error(`Unsupported desktop build mode: ${mode}`);
  await (await import("../scripts/build-desktop-preload.mjs")).buildDesktopPreload();
  // Freeze the helper identity before either builder attempt. It is embedded
  // in app.asar, independently of the external qualification carrier.
  const helperMetadata = catalogVerifierBuildMetadata(repositoryRoot);
  const helperArguments = [`--config.extraMetadata.nativeCatalogVerifierSha256=${helperMetadata.nativeCatalogVerifierSha256}`];
  const builderArgs = [
    ...(mode === "pack" ? ["--dir"] : []),
    ...identityBuilderArgs(desktopIdentity, outputDirectory),
    ...helperArguments,
    `--config.extraMetadata.releaseChannel=${releaseChannel}`,
    ...(updateBaseUrl ? [`--config.extraMetadata.updateBaseUrl=${updateBaseUrl}`] : []),
    ...(cloudApiBaseUrl ? [`--config.extraMetadata.cloudApiBaseUrl=${cloudApiBaseUrl}`] : []),
  ];
  const standardResult = await runBuilder(builderArgs);
  if (standardResult === 0) {
    const finalizeResult = await finalizePackagedOutput(outputDirectory);
    if (finalizeResult !== 0) process.exitCode = finalizeResult;
    return;
  }

  // Some Windows security scanners briefly hold the freshly extracted Electron
  // directory, making electron-builder's final rename fail with EPERM. Reuse
  // that complete temporary distribution instead of downloading it again.
  const temporaryDist = path.join(outputDirectory, "win-unpacked.tmp");
  if (!fs.existsSync(temporaryDist)) process.exit(standardResult);

  const fallbackOutput = desktopOutputDirectories.fallback;
  console.warn("标准目录包被 Windows 文件锁阻塞，使用已解压 Electron 分发重试。", fallbackOutput);
  const fallbackResult = await runBuilder([
    ...(mode === "pack" ? ["--dir"] : []),
    ...identityBuilderArgs(desktopIdentity, fallbackOutput),
    ...helperArguments,
    `--config.extraMetadata.releaseChannel=${releaseChannel}`,
    ...(updateBaseUrl ? [`--config.extraMetadata.updateBaseUrl=${updateBaseUrl}`] : []),
    ...(cloudApiBaseUrl ? [`--config.extraMetadata.cloudApiBaseUrl=${cloudApiBaseUrl}`] : []),
    `--config.electronDist=${temporaryDist}`,
  ]);
  if (fallbackResult !== 0) {
    process.exitCode = fallbackResult;
    return;
  }
  const finalizeResult = await finalizePackagedOutput(fallbackOutput);
  if (finalizeResult !== 0) process.exitCode = finalizeResult;
}

if (require.main === module) void main();

module.exports = { createDesktopUpdateFeedArguments, finalizePackagedOutput, identityBuilderArgs };
