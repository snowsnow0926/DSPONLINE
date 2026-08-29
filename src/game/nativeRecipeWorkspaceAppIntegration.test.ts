import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("native recipe workspace App integration", () => {
  const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
  const workspace = readFileSync(
    fileURLToPath(new URL("../components/RecipeWorkspace.tsx", import.meta.url)),
    "utf8",
  );

  it("never constructs the Web recipe model while a native authority session is bound", () => {
    expect(app).toMatch(/recipesOpen && !nativePlayerAuthorityBoundFrame[\s\S]*?createWebRecipeWorkspaceReadModel\(game/);
    expect(app).toMatch(/const recipeWorkspaceReadModel = nativePlayerAuthorityBoundFrame[\s\S]*?nativeRecipeWorkspaceReadModel[\s\S]*?: webRecipeWorkspaceReadModel/);
    expect(app).toMatch(/<RecipeWorkspace open readOnly=\{nativePlayerAuthorityOwnsRuntime\} readModel=\{recipeWorkspaceReadModel\}[\s\S]*?onReadRequest=\{updateRecipeWorkspaceSelector\}/);
    expect(app).not.toMatch(/<RecipeWorkspace[^>]*game=\{game\}/);
  });

  it("keeps native location fail-closed on an older or mismatched preload", () => {
    expect(app).toMatch(/typeof desktopBridge\?\.getNativePlayerAuthorityState !== "function"[\s\S]*?typeof desktopBridge\.getNativeCoreRecipeWorkspaceProjection !== "function"/);
    expect(app).toMatch(/projection\.revision !== authorityRevision[\s\S]*?clock\.sessionId !== authority\.sessionId[\s\S]*?clock\.revision !== authorityRevision/);
    expect(app).toMatch(/relatedBeltIds: \[\]/);
  });

  it("keeps the component detached from GameState and rejects an old selector before rendering", () => {
    expect(workspace).toMatch(/readModel: RecipeWorkspaceReadModel \| null/);
    expect(workspace).not.toMatch(/game: GameState/);
    expect(workspace).not.toMatch(/getProductionLineLocations/);
    expect(workspace).not.toMatch(/\.entities\.(?:reduce|filter|map)/);
    expect(workspace).toMatch(/!recipeWorkspaceSelectorsEqual\(readModel\.selector, requestedSelector\)/);
  });
});
