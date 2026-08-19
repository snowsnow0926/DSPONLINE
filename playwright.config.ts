import { defineConfig, devices } from "@playwright/test";

const requestedPort = Number(process.env.DSP_E2E_PORT ?? 4319);
if (!Number.isSafeInteger(requestedPort) || requestedPort < 1024 || requestedPort > 65_535) {
  throw new Error("DSP_E2E_PORT must be an available user port");
}
const baseURL = `http://127.0.0.1:${requestedPort}`;
const apiProxyTarget = process.env.DSP_E2E_API_PROXY_TARGET?.trim() || "http://127.0.0.1:65534";
const webCommand = process.env.DSP_E2E_USE_PREVIEW === "1"
  ? `npm run preview -- --port ${requestedPort}`
  : `npm run dev -- --port ${requestedPort}`;
// E2E 文件间并行（fullyParallel=false 保证单文件内仍串行）。
// 本地默认 4 个 worker；CI 用 2 个避免 2 核 runner 内存过载；可用 DSP_E2E_WORKERS 覆盖。
const e2eWorkers = Number(process.env.DSP_E2E_WORKERS ?? (process.env.CI ? "2" : "4"));

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  // The development server loads the factory through a lazy module graph.
  // Four concurrent release workers can keep the explicit loading shell
  // visible beyond Playwright's 5 s matcher default even though the page is
  // healthy. Match the 15 s readiness contract already used by the current
  // journey helpers; assertions and product/performance thresholds stay exact.
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: e2eWorkers,
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report" }],
    ["json", { outputFile: "test-results/playwright-report.json" }],
  ],
  use: {
    baseURL,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    // Use Playwright's pinned Chromium revision. Driving whichever system
    // Chrome happens to be installed makes long parallel gates depend on a
    // browser/driver version pair that the lockfile does not control.
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: webCommand,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      DSP_API_PROXY_TARGET: apiProxyTarget,
    },
  },
});
