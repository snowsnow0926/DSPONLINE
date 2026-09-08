import { spawn } from "node:child_process";
import { verifyBuiltPlatform } from "./verify-built-platform.mjs";
import { nativeBuildConfig } from "./native-build-config.mjs";

const platform = process.argv[2];
if (platform !== "desktop" && platform !== "android") throw new Error("Usage: node scripts/build-platform.mjs <desktop|android>");
const config = nativeBuildConfig(platform);
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("build-platform.mjs must be launched from an npm script");
const child = spawn(process.execPath, [npmCli, "run", "build"], {
  stdio: "inherit",
  env: {
    ...process.env,
    ...config,
  },
});
child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", async (code) => {
  if (code !== 0) {
    process.exitCode = code ?? 1;
    return;
  }
  try {
    await verifyBuiltPlatform(platform, undefined, [config.VITE_API_BASE_URL,
      config.VITE_ANDROID_UPDATE_MANIFEST_URL, config.VITE_PUBLIC_APP_ORIGIN].filter(Boolean));
    process.stdout.write(`built-platform-ok\t${platform}\n`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
});
