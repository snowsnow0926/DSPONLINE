import { defineConfig } from "@playwright/test";
import path from "node:path";

const runDirectory = process.env.DSP_DESKTOP_JOURNEY_RUN_DIR;
if (!runDirectory) throw new Error("BLOCKED: run npm run test:desktop-package to verify package identity first");

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "desktop-performance-package-journey.spec.ts",
  timeout: 180_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ["list"],
    ["json", { outputFile: path.join(runDirectory, "desktop-package-playwright.json") }],
  ],
  outputDir: path.join(runDirectory, "playwright-results"),
  use: {
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
