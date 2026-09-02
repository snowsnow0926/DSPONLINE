import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Windows native offline startup integration", () => {
  it("routes only a normal primary fast settlement through the read-only candidate", () => {
    const source = readFileSync("src/components/StartMenu.tsx", "utf8");
    expect(source).toMatch(/import\("\.\.\/game\/nativeOfflineStartup"\)/);
    expect(source).toMatch(/tryNativeOfflineStartupSettlement\(\{[\s\S]*?loaded,[\s\S]*?runtime/);
    expect(source).toMatch(/allowNativeStartup:\s*mode === "normal" && resolved\?\.save\.source === "primary"/);
    expect(source).toMatch(/options\.forceExact !== true[\s\S]*?offlineSettlementPreference !== "exact"/);
  });

  it("keeps the original Worker fallback and finalizes the candidate's exact time window", () => {
    const source = readFileSync("src/components/StartMenu.tsx", "utf8");
    expect(source).toContain("runOfflineSimulationInWorkerDetailed");
    expect(source).toMatch(/completedByNative \? null : await runOfflineSimulationInWorkerDetailed!/);
    expect(source).toMatch(/finalizeDeferredOfflineGame\(settlementLoaded, completed/);
    expect(source).toMatch(/if \(controller\.signal\.aborted\)[\s\S]*?原存档、savedAt 和离线时长均未修改/);
  });

  it("keeps time, export identity, and filesystem paths out of the renderer request type", () => {
    const source = readFileSync("src/desktop.ts", "utf8");
    const start = source.indexOf("export interface DesktopNativeOfflineStartupRequest");
    const end = source.indexOf("export interface DesktopBridge", start);
    const request = source.slice(start, end);
    expect(request).toContain('readonly strategy: "macro-v1"');
    expect(request).not.toContain("observedNowMs");
    expect(request).not.toContain("exportId");
    expect(request).not.toContain("path");
  });
});
