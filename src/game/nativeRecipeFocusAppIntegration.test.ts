import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("native recipe-focus App integration", () => {
  const app = readFileSync(resolve("src/App.tsx"), "utf8");

  it("routes item, mode and position edits through exact Rust projection commands", () => {
    const start = app.indexOf("const onRecipeFocusChange");
    const end = app.indexOf("const onFuelChange", start);
    const handlers = app.slice(start, end);
    expect(start).toBeGreaterThan(0);
    expect(handlers).toMatch(/nativeFactoryProjectionIdentityRef\.current/);
    expect(handlers).toMatch(/createNativeProjectedRecipeFocusItemCommand\(identity, model, itemId\)/);
    expect(handlers).toMatch(/createNativeProjectedRecipeFocusModeCommand\(identity, model, mode\)/);
    expect(handlers).toMatch(/createNativeProjectedRecipeFocusPositionCommand\(identity, model, position\)/);
    const nativeBranches = handlers.match(/if \(nativePlayerAuthorityOwnsRuntimeRef\.current\)/g) ?? [];
    expect(nativeBranches).toHaveLength(3);
  });

  it("keeps the overlay editable only while its current native frame is ready", () => {
    const start = app.indexOf("<RecipeFocusPanel");
    const end = app.indexOf("</RecipeFocusPanel>", start);
    const panel = app.slice(start, end > start ? end : start + 1200);
    expect(panel).toMatch(/model=\{recipeFocusReadModel\}/);
    expect(panel).toMatch(/readOnly=\{nativePlayerAuthorityOwnsRuntime &&[\s\S]*?!nativeRecipeFocusReadModel[\s\S]*?nativePlayerAuthorityCommandPending/);
    expect(panel).toMatch(/onModeChange=\{onRecipeFocusModeChange\}/);
    expect(panel).toMatch(/onPositionChange=\{onRecipeFocusPositionChange\}/);
    expect(panel).not.toMatch(/rejectLegacyFactoryInteractionWhileNative/);
    expect(app).toMatch(/<RecipeWorkspace open readOnly=\{nativePlayerAuthorityOwnsRuntime && \(!nativeRecipeFocusReadModel \|\| nativePlayerAuthorityCommandPending\)\}/);
  });

  it("does not consult stale JavaScript focus while native authority owns runtime", () => {
    const start = app.indexOf("const openRecipeFocus");
    const end = app.indexOf("const onFuelChange", start);
    const handler = app.slice(start, end);
    expect(handler).toMatch(/recipeFocusReadModel\?\.itemId/);
    expect(handler).toMatch(/nativePlayerAuthorityOwnsRuntimeRef\.current \? null : gameRef\.current\.recipeFocus\.itemId/);
  });
});
