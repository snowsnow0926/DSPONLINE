import { defineConfig, devices } from "@playwright/test";
import baseConfig from "./playwright.config";

export default defineConfig({
  ...baseConfig,
  testMatch: [
    "**/v140-browser-compatibility.spec.ts",
    "**/v140-local-save-coordination.spec.ts",
    "**/v144-runtime-protocol.spec.ts",
    "**/v144-canvas-connection-viewport.spec.ts",
  ],
  grep: /nightly browsers preserve the core factory|same-tab navigation keeps its writer chain|a reload applies a verified emergency mirror|game runtime replays acknowledged slices after a Worker crash|device-only expand-all preference/,
  timeout: 45_000,
  projects: [
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
