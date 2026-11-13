import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(name: string): string {
  const path = decodeURIComponent(new URL(name, import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1");
  return readFileSync(path, "utf8");
}

describe("production Worker import boundaries", () => {
  it("initializes legacy runtime capabilities in every Worker realm", () => {
    const workers = readdirSync(new URL(".", import.meta.url)).filter((name) => name.endsWith(".worker.ts"));
    expect(workers.length).toBeGreaterThan(0);
    for (const worker of workers) {
      expect(source("./" + worker).match(/^import .+$/m)?.[0].trim(), worker).toBe('import "../compat/runtime";');
    }
  });
  it("keeps save serialization projection free of the storage Worker graph", () => {
    const worker = source("./save.worker.ts");
    const projection = source("./saveProjection.ts");
    expect(worker).toContain('from "./saveProjection"');
    expect(worker).not.toContain('from "./storage"');
    expect(projection).not.toMatch(/new\s+Worker|\.worker\.ts/);
  });

  it("keeps pure-idle Worker settlement separate from the synchronous reload gate", () => {
    const macro = source("./pureIdleMacro.ts");
    const worker = source("./pureIdleMacro.worker.ts");
    const validation = source("./pureIdleMacroValidation.ts");
    expect(macro).not.toContain('from "./storage"');
    expect(worker).toContain("finalizePureIdleMacroCandidate");
    expect(worker).not.toContain("pureIdleMacroValidation");
    expect(validation).toContain('from "./storage"');
  });
});
