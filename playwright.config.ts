import { defineConfig, devices } from "@playwright/test";

function readPort(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535 ? parsed : fallback;
}

const e2ePort = readPort("DSP_E2E_PORT", 4319);
const e2eApiPort = process.env.DSP_E2E_API_PORT ? readPort("DSP_E2E_API_PORT", 4392) : null;
const e2eBaseUrl = `http://127.0.0.1:${e2ePort}`;
const reuseExistingServer = process.env.DSP_E2E_REUSE_EXISTING_SERVER !== "0";
const webServers = [
  {
    command: `npx vite --host 127.0.0.1 --port ${e2ePort} --strictPort`,
    url: e2eBaseUrl,
    reuseExistingServer,
    timeout: 120_000,
  },
  ...(e2eApiPort == null ? [] : [{
    command: "node server/index.mjs",
    url: `http://127.0.0.1:${e2eApiPort}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      PORT: String(e2eApiPort),
      HOST: "127.0.0.1",
      DSP_CLOUD_DATABASE_FILE: ":memory:",
      DSP_ALLOWED_ORIGIN: e2eBaseUrl,
    },
  }]),
];

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: {
    baseURL: e2eBaseUrl,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], channel: "chrome" } },
  ],
  webServer: webServers,
});
