import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("native entity recipe App integration", () => {
  const app = readFileSync(resolve("src/App.tsx"), "utf8");
  const inspector = readFileSync(resolve("src/components/NativeFactoryInspectorPanel.tsx"), "utf8");
  const transactionHook = readFileSync(
    resolve("src/game/useNativeEntityRecipeCommandTransaction.ts"),
    "utf8",
  );

  it("pins the recipe directory to the same entity row and inventory identity", () => {
    const start = app.indexOf("const nativeEntityRecipeProjectionBinding");
    const end = app.indexOf("const nativeStationConfigurationProjectionBinding", start);
    const binding = app.slice(start, end);
    expect(start).toBeGreaterThan(0);
    expect(binding).toMatch(/nativeEntityConfigurationProjectionBinding/);
    expect(binding).toMatch(/nativeFactoryInventoryIdentity/);
    expect(binding).toMatch(/inventoryIdentity\.sessionId !== entityBinding\.sessionId/);
    expect(binding).toMatch(/inventoryIdentity\.runId !== entityBinding\.runId/);
    expect(binding).toMatch(/inventoryIdentity\.revision !== entityBinding\.revision/);
    expect(binding).toMatch(/registryFingerprint: inventoryIdentity\.registryFingerprint/);
    expect(binding).toMatch(/activePlanetId: entityBinding\.activePlanetId/);
    expect(binding).toMatch(/entity: entityBinding\.entity/);
    expect(binding).not.toMatch(/gameRef|panelGame|game\.entities|completedTechIds/);
  });

  it("routes the real App through the behavior-tested recipe transaction hook", () => {
    const hookStart = app.indexOf("useNativeEntityRecipeCommandTransaction({");
    const hookEnd = app.indexOf("const nativeStationConfigurationProjectionBinding", hookStart);
    const hookBinding = app.slice(Math.max(0, hookStart - 180), hookEnd);
    const start = app.indexOf("const changeNativeEntityRecipe");
    const end = app.indexOf("const changeNativeBlackHolePaused", start);
    const handler = app.slice(start, end);
    expect(hookStart).toBeGreaterThan(0);
    expect(hookBinding).toMatch(/authority: nativeEntityRecipeAuthorityObservation/);
    expect(hookBinding).toMatch(/projection: nativeEntityRecipeProjectionBinding/);
    expect(hookBinding).toMatch(/authorityOwnedRef: nativePlayerAuthorityOwnsRuntimeRef/);
    expect(hookBinding).toMatch(/commandInFlightRef: nativePlayerAuthorityCommandInFlightRef/);
    expect(hookBinding).toMatch(/commandSourceRef: nativePlayerAuthorityCommandBindingRef/);
    expect(hookBinding).toMatch(/pending: nativeEntityRecipePending/);
    expect(hookBinding).toMatch(/commit: commitNativeEntityRecipeCommand/);
    expect(start).toBeGreaterThan(0);
    expect(handler).toMatch(/nativePlayerAuthorityOwnsRuntimeRef\.current/);
    expect(handler).toMatch(/nativePlayerAuthorityCommandInFlightRef\.current/);
    expect(handler).toMatch(/nativeFactoryProjectionIdentityRef\.current/);
    expect(handler).toMatch(/nativePlayerAuthorityCommandBindingRef\.current\?\.source/);
    expect(handler).toMatch(/commandSource\.sessionId !== binding\.sessionId[\s\S]*?commandSource\.baseRevision !== binding\.revision/);
    expect(handler).toMatch(/selectedEntityIdsRef\.current\.length !== 1[\s\S]*?selectedBeltIdsRef\.current\.length !== 0/);
    expect(handler).toMatch(/commitNativeEntityRecipeCommand\(binding, targetRecipeId\)/);
    expect(handler).not.toMatch(/commitGame|gameRef\.current|setRecipe|changedEntities/);
  });

  it("keeps the extracted transaction free of renderer-side gameplay mutation", () => {
    expect(transactionHook).toMatch(/source\.applyCommand\(initialPending\.command\)/);
    expect(transactionHook).toMatch(/reconcileNativeEntityRecipePendingCommand/);
    expect(transactionHook).not.toMatch(/commitGame|gameRef|applySimulationCommandPatch/);
    expect(transactionHook).not.toMatch(/\.finally\([\s\S]*?commandInFlightRef\.current = false/);
  });

  it("keeps the ordinary built-in selector projected, pending-locked and fail-closed", () => {
    expect(inspector).toMatch(/data-native-entity-recipe="semantic-intent-v1"/);
    expect(inspector).toMatch(/getNativeProjectedEntityRecipeConfiguration\(recipeBinding\)/);
    expect(inspector).toMatch(/disabled=\{!recipeWritable\}/);
    expect(app).toMatch(/pending=\{nativeRemovalContextPending[\s\S]*?nativeEntityRecipePending !== null\}/);
    expect(inspector).toMatch(/setPendingRecipeChange\(\{[\s\S]*?registryFingerprint: recipeBinding\.registryFingerprint,[\s\S]*?currentRecipeId: recipeConfiguration\.currentRecipeId,[\s\S]*?targetRecipeId/);
    expect(inspector).toMatch(/pendingRecipeChange\.sessionId === recipeBinding\.sessionId[\s\S]*?pendingRecipeChange\.registryFingerprint === recipeBinding\.registryFingerprint[\s\S]*?pendingRecipeChange\.currentRecipeId === recipeConfiguration\.currentRecipeId/);
    expect(inspector).toMatch(/title="确认更换生产配方"[\s\S]*?riskPolicy="explicit"/);
    expect(inspector).toMatch(/onClick=\{confirmRecipeChange\}>确认更换配方/);
    expect(inspector).toMatch(/旧 JavaScript 存档不会作为候选来源/);
    expect(inspector).not.toMatch(/completedTechIds/);
    expect(app).toMatch(/entityRecipeBinding=\{nativeEntityRecipeProjectionBinding\}/);
    expect(app).toMatch(/onEntityRecipeChange=\{changeNativeEntityRecipe\}/);
  });
});
