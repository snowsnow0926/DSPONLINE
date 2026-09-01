import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("native command palette thin integration", () => {
  const app = readFileSync(resolve("src/App.tsx"), "utf8");
  const palette = readFileSync(resolve("src/components/CommandPalette.tsx"), "utf8");

  it("passes no entity collection while Rust owns the factory", () => {
    expect(app).toMatch(/<CommandPalette[\s\S]*?webEntities=\{nativePlayerAuthorityOwnsRuntime \? null : game\.entities\}/);
    expect(palette).not.toMatch(/GameState|game\.entities|game\.paused|game\.settings/);
  });

  it("exposes only already-migrated workspaces in native authority mode", () => {
    expect(palette).toMatch(/nativeWorkspaceIds = new Set\(\["star-map", "statistics", "recipes", "technology", "operations", "dyson", "inspector"\]\)/);
    expect(palette).toMatch(/nativeAuthority[\s\S]*?workspaceCommands\.filter/);
  });
});
