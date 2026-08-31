import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("native Operations App integration", () => {
  const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
  const component = readFileSync(fileURLToPath(new URL("../components/NativeOperationsWorkspace.tsx", import.meta.url)), "utf8");

  it("splits the native thin UI from the unchanged Web fallback", () => {
    expect(app).toMatch(/operationsOpen && nativePlayerAuthorityOwnsRuntime[\s\S]*?<NativeOperationsWorkspace/);
    expect(app).toMatch(/operationsOpen && !nativePlayerAuthorityOwnsRuntime[\s\S]*?<OperationsWorkspace/);
    expect(app).not.toMatch(/workspace === "operations" && rejectLegacyFactoryInteractionWhileNative/);
  });

  it("does not pass GameState or dangerous persistence callbacks to the native page", () => {
    const nativeUse = app.match(/<NativeOperationsWorkspace[\s\S]*?\/>/)?.[0] ?? "";
    expect(nativeUse).not.toContain("game=");
    expect(nativeUse).not.toMatch(/onImport|onConfirmImport|onLoadSlot|onSaveSlot|onLoadSnapshot|onRegisterContentPack|onSetContentPackEnabled|onRemoveContentPack/);
    expect(component).not.toMatch(/import type .*GameState|game:\s*GameState/);
    expect(component).toContain("collectClientDiagnostics(undefined)");
  });
});
