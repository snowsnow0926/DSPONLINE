import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { execFileSync } from "node:child_process";

function gitText(args: string[]): string | null {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

const appVersion = process.env.npm_package_version ?? "0.1.0";
const gitSha = process.env.DSP_GIT_SHA?.trim() || gitText(["rev-parse", "--short=12", "HEAD"]) || "nogit";
const gitDirty = process.env.DSP_GIT_DIRTY == null
  ? Boolean(gitText(["status", "--porcelain"]))
  : process.env.DSP_GIT_DIRTY === "1";
const buildId = process.env.DSP_BUILD_ID?.trim() || `${appVersion}+${gitSha}${gitDirty ? ".dirty" : ""}`;
const requestedPlatform = process.env.VITE_APP_PLATFORM?.trim().toLowerCase();
const appPlatform = requestedPlatform === "desktop" || requestedPlatform === "android" ? requestedPlatform : "web";
const requestedReleaseChannel = process.env.VITE_RELEASE_CHANNEL?.trim().toLowerCase();
const releaseChannel = requestedReleaseChannel === "beta" || requestedReleaseChannel === "nightly" ? requestedReleaseChannel : "stable";
const devApiUrl = process.env.DSP_DEV_API_URL?.trim() || "http://127.0.0.1:4320";

function scaleUiFontSizes(): Plugin {
  return {
    name: "scale-ui-font-sizes",
    enforce: "pre",
    transform(source, id) {
      const normalizedId = id.split("?", 1)[0].replace(/\\/g, "/");
      if (!normalizedId.endsWith("/src/styles.css")) return null;
      const fontSizes = source.replace(
        /(\bfont-size\s*:\s*)(\d*\.?\d+)px\b/g,
        "$1calc($2px * var(--ui-font-scale, 1))",
      );
      const fontShorthands = fontSizes.replace(
        /(\bfont\s*:\s*)(\d*\.?\d+)px(?=\/)/g,
        "$1calc($2px * var(--ui-font-scale, 1))",
      );
      return fontShorthands === source ? null : { code: fontShorthands, map: null };
    },
  };
}

function emitVersionMetadata(): Plugin {
  return {
    name: "emit-version-metadata",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source: `${JSON.stringify({ version: appVersion, buildId, generatedAt: new Date().toISOString() })}\n`,
      });
    },
  };
}

export default defineConfig({
  // Relative assets are required by the packaged file:// Electron shell and
  // remain valid for the root-served web/PWA build.
  base: "./",
  plugins: [scaleUiFontSizes(), react(), emitVersionMetadata()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __BUILD_ID__: JSON.stringify(buildId),
    __APP_PLATFORM__: JSON.stringify(appPlatform),
    __RELEASE_CHANNEL__: JSON.stringify(releaseChannel),
  },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "react-vendor",
              test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/,
              priority: 30,
              includeDependenciesRecursively: false,
            },
            {
              name: "flow-vendor",
              test: /node_modules[\\/]@xyflow[\\/]/,
              priority: 20,
              includeDependenciesRecursively: false,
            },
            {
              name: "game-core",
              test: /src[\\/]game[\\/](?:content|engine|recipeGraph|statistics)\.ts$/,
              priority: 10,
              includeDependenciesRecursively: false,
            },
          ],
        },
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 4318,
    proxy: { "/api": devApiUrl },
  },
  preview: { proxy: { "/api": devApiUrl } },
});
