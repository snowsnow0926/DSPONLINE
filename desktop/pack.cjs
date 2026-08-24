const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createReleaseChannels, optionalHttpsUrl, resolveReleaseChannel } = require("./release-channels.cjs");
const { validatePackagedTransferContract } = require("./package-contract.cjs");
const { extractFile } = require("@electron/asar");

const expectedTransferContract = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "cloud-transfer-contract.json"), "utf8"));

const builderEntry = require.resolve("electron-builder/cli");
const mode = process.argv[2] || "pack";
const outputDirectory = path.resolve(process.env.DSP_DESKTOP_OUTPUT_DIR || "release");
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

function verifyPackagedMetadata(outputDirectory) {
  if (mode !== "dist") return;
  const asarPath = path.join(outputDirectory, "win-unpacked", "resources", "app.asar");
  if (!fs.existsSync(asarPath)) throw new Error(`桌面包缺少 ${asarPath}`);
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

async function main() {
  if (!["pack", "dist"].includes(mode)) throw new Error(`Unsupported desktop build mode: ${mode}`);
  const builderArgs = [
    ...(mode === "pack" ? ["--dir"] : []),
    `--config.extraMetadata.releaseChannel=${releaseChannel}`,
    `--config.directories.output=${outputDirectory}`,
    ...(updateBaseUrl ? [`--config.extraMetadata.updateBaseUrl=${updateBaseUrl}`] : []),
    ...(cloudApiBaseUrl ? [`--config.extraMetadata.cloudApiBaseUrl=${cloudApiBaseUrl}`] : []),
  ];
  const standardResult = await runBuilder(builderArgs);
  if (standardResult === 0) {
    verifyPackagedMetadata(outputDirectory);
    return;
  }

  // Some Windows security scanners briefly hold the freshly extracted Electron
  // directory, making electron-builder's final rename fail with EPERM. Reuse
  // that complete temporary distribution instead of downloading it again.
  const outputDir = path.resolve("release");
  const temporaryDist = path.join(outputDir, "win-unpacked.tmp");
  if (!fs.existsSync(temporaryDist)) process.exit(standardResult);

  const fallbackOutput = path.resolve(`${outputDirectory}-fallback`);
  console.warn("标准目录包被 Windows 文件锁阻塞，使用已解压 Electron 分发重试。", fallbackOutput);
  const fallbackResult = await runBuilder([
    ...(mode === "pack" ? ["--dir"] : []),
    `--config.extraMetadata.releaseChannel=${releaseChannel}`,
    ...(updateBaseUrl ? [`--config.extraMetadata.updateBaseUrl=${updateBaseUrl}`] : []),
    ...(cloudApiBaseUrl ? [`--config.extraMetadata.cloudApiBaseUrl=${cloudApiBaseUrl}`] : []),
    `--config.directories.output=${fallbackOutput}`,
    `--config.electronDist=${temporaryDist}`,
  ]);
  if (fallbackResult === 0) verifyPackagedMetadata(fallbackOutput);
  process.exit(fallbackResult);
}

void main();
