import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["experiments/web-construction-wasm/terminal-projection-prototype.test.ts"], maxWorkers: 1 },
});
