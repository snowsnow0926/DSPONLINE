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
const requestedRendererHeapMb = process.env.DSP_E2E_RENDERER_HEAP_MB === undefined
  ? null
  : Number(process.env.DSP_E2E_RENDERER_HEAP_MB);
if (requestedRendererHeapMb !== null && (!Number.isSafeInteger(requestedRendererHeapMb) || requestedRendererHeapMb < 256 || requestedRendererHeapMb > 4_096)) {
  throw new Error("DSP_E2E_RENDERER_HEAP_MB must be an integer between 256 and 4096");
}

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
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
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        channel: "chrome",
        ...(requestedRendererHeapMb === null ? {} : {
          launchOptions: { args: [`--js-flags=--max-old-space-size=${requestedRendererHeapMb}`] },
        }),
      },
    },
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
