const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createReleaseChannels, optionalHttpsUrl, resolveReleaseChannel } = require("./release-channels.cjs");
const { validatePackagedTransferContract } = require("./package-contract.cjs");
const { verifyDesktopPackageHygiene } = require("./package-hygiene.cjs");
const {
  resolveDesktopEditionIdentity,
  resolveDesktopEditionOutputDirectory,
  validateStablePackageIdentity,
  verifyPackagedDesktopEditionIdentity,
} = require("./performance-edition-identity.cjs");
const { extractFile } = require("@electron/asar");

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
const outputDirectory = resolveDesktopEditionOutputDirectory(repositoryRoot, desktopIdentity);
const releaseChannel = resolveReleaseChannel(process.env.DSP_RELEASE_CHANNEL);
const updateBaseUrl = optionalHttpsUrl(process.env.DSP_UPDATE_BASE_URL, "Desktop update base URL");
const cloudApiBaseUrl = optionalHttpsUrl(process.env.DSP_DESKTOP_API_BASE_URL, "Desktop cloud API base URL");
if (mode === "dist" && (!updateBaseUrl || !cloudApiBaseUrl)) {
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

function verifyPackagedOutput(outputDirectory) {
  const unpackedDirectory = path.join(outputDirectory, "win-unpacked");
  const asarPath = path.join(unpackedDirectory, "resources", "app.asar");
  verifyDesktopPackageHygiene(asarPath);
  verifyPackagedDesktopEditionIdentity({
    asarPath,
    unpackedDirectory,
    extractAsarFile: extractFile,
  });
  if (mode !== "dist") return;
  const metadata = JSON.parse(extractFile(asarPath, "package.json").toString("utf8"));
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
  if (!["pack", "dist"].includes(mode)) throw new Error(`Unsupported desktop build mode: ${mode}`);
  const builderArgs = [
    ...(mode === "pack" ? ["--dir"] : []),
    ...identityBuilderArgs(desktopIdentity, outputDirectory),
    `--config.extraMetadata.releaseChannel=${releaseChannel}`,
    ...(updateBaseUrl ? [`--config.extraMetadata.updateBaseUrl=${updateBaseUrl}`] : []),
    ...(cloudApiBaseUrl ? [`--config.extraMetadata.cloudApiBaseUrl=${cloudApiBaseUrl}`] : []),
  ];
  const standardResult = await runBuilder(builderArgs);
  if (standardResult === 0) {
    verifyPackagedOutput(outputDirectory);
    return;
  }

  // Some Windows security scanners briefly hold the freshly extracted Electron
  // directory, making electron-builder's final rename fail with EPERM. Reuse
  // that complete temporary distribution instead of downloading it again.
  const temporaryDist = path.join(outputDirectory, "win-unpacked.tmp");
  if (!fs.existsSync(temporaryDist)) process.exit(standardResult);

  const fallbackOutput = path.resolve(`${outputDirectory}-fallback`);
  console.warn("标准目录包被 Windows 文件锁阻塞，使用已解压 Electron 分发重试。", fallbackOutput);
  const fallbackResult = await runBuilder([
    ...(mode === "pack" ? ["--dir"] : []),
    ...identityBuilderArgs(desktopIdentity, fallbackOutput),
    `--config.extraMetadata.releaseChannel=${releaseChannel}`,
    ...(updateBaseUrl ? [`--config.extraMetadata.updateBaseUrl=${updateBaseUrl}`] : []),
    ...(cloudApiBaseUrl ? [`--config.extraMetadata.cloudApiBaseUrl=${cloudApiBaseUrl}`] : []),
    `--config.electronDist=${temporaryDist}`,
  ]);
  if (fallbackResult === 0) verifyPackagedOutput(fallbackOutput);
  process.exit(fallbackResult);
}

void main();
