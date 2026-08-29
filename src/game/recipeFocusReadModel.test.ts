import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import type {
  DesktopNativeCoreFactoryReadModelResult,
  DesktopNativeCoreViewportProjectionV2Result,
} from "../desktop";
import { createInitialState } from "./engine";
import type { NativeFactoryThinViewSnapshot } from "./nativeFactoryThinViewStore";
import {
  RECIPE_FOCUS_NATIVE_BASE_FIELDS,
  createWebRecipeFocusReadModel,
  selectNativeRecipeFocusReadModel,
  type NativeRecipeFocusBinding,
} from "./recipeFocusReadModel";

const REVISION = 23;
const BOUNDS = Object.freeze({ minX: 0, minY: 0, maxX: 100, maxY: 100 });

function viewport(recipeFocus: unknown): DesktopNativeCoreViewportProjectionV2Result {
  return {
    schemaVersion: 2,
    projectionType: "viewport-v2",
    revision: REVISION,
    planetId: "home",
    bounds: BOUNDS,
    base: { recipeFocus },
    entities: [],
    belts: [],
    pinnedEntityIds: [],
    pinnedBeltIds: [],
    nextEntityCursor: null,
    nextBeltCursor: null,
    planetTotals: { entities: 0, belts: 0 },
    viewportTotals: { entities: 0, belts: 0 },
    worldBounds: BOUNDS,
    minimap: { bounds: BOUNDS, entityCount: 0, beltCount: 0, occupiedCellCount: 0, cellSize: 320 },
    broadQueryFallback: false,
  };
}

function snapshot(
  recipeFocus: unknown = { itemId: "iron_ingot", mode: "two-level", position: { x: 24, y: 72 } },
  overrides: Partial<NativeFactoryThinViewSnapshot> = {},
): NativeFactoryThinViewSnapshot {
  return {
    status: "ready",
    requestedRevision: REVISION,
    frame: {
      revision: REVISION,
      planetId: "home",
      authoritySessionId: "authority-1",
      factory: {} as DesktopNativeCoreFactoryReadModelResult,
      viewport: viewport(recipeFocus),
    },
    ...overrides,
  };
}

function binding(overrides: Partial<NativeRecipeFocusBinding> = {}): NativeRecipeFocusBinding {
  return {
    enabled: true,
    sessionId: "authority-1",
    expectedRevision: REVISION,
    activePlanetId: "home",
    ...overrides,
  };
}

describe("recipe focus thin read model", () => {
  it("keeps the Web compatibility model bounded and detached from the mutable position", () => {
    const game = createInitialState();
    game.recipeFocus = { itemId: "iron_ingot", mode: "full", position: { x: 40, y: 90 } };
    const model = createWebRecipeFocusReadModel(game);

    game.recipeFocus.position.x = 999;
    expect(model).toEqual({
      schema: "recipe-focus-read-model-v1",
      source: "web-game-state",
      revision: null,
      itemId: "iron_ingot",
      mode: "full",
      position: { x: 40, y: 90 },
    });
    expect(Object.hasOwn(model, "entities")).toBe(false);
    expect(Object.hasOwn(model, "belts")).toBe(false);
  });

  it("accepts only the complete current native viewport atom", () => {
    expect(selectNativeRecipeFocusReadModel(snapshot(), binding())).toEqual({
      schema: "recipe-focus-read-model-v1",
      source: "native-core",
      revision: REVISION,
      itemId: "iron_ingot",
      mode: "two-level",
      position: { x: 24, y: 72 },
    });
    expect(selectNativeRecipeFocusReadModel(snapshot(), binding({ sessionId: "authority-2" }))).toBeNull();
    expect(selectNativeRecipeFocusReadModel(snapshot(), binding({ expectedRevision: REVISION + 1 }))).toBeNull();
    expect(selectNativeRecipeFocusReadModel(snapshot(), binding({ activePlanetId: "remote" }))).toBeNull();
    expect(selectNativeRecipeFocusReadModel(snapshot(undefined, { status: "loading" }), binding())).toBeNull();
    expect(selectNativeRecipeFocusReadModel(snapshot(undefined, { requestedRevision: REVISION - 1 }), binding())).toBeNull();
  });

  it.each([
    ["unknown focus field", { itemId: "iron_ingot", mode: "two-level", position: { x: 24, y: 72 }, extra: true }],
    ["unknown item", { itemId: "not-an-item", mode: "two-level", position: { x: 24, y: 72 } }],
    ["unknown mode", { itemId: "iron_ingot", mode: "wide", position: { x: 24, y: 72 } }],
    ["fractional position", { itemId: "iron_ingot", mode: "full", position: { x: 24.5, y: 72 } }],
    ["out-of-range position", { itemId: "iron_ingot", mode: "full", position: { x: 7, y: 72 } }],
    ["missing position field", { itemId: "iron_ingot", mode: "full", position: { x: 24 } }],
  ])("rejects %s without exposing a partial model", (_label, focus) => {
    expect(selectNativeRecipeFocusReadModel(snapshot(focus), binding())).toBeNull();
  });

  it("routes the always-mounted panel through the bounded viewport base", () => {
    const app = readFileSync(resolve("src/App.tsx"), "utf8");
    const panel = readFileSync(resolve("src/components/RecipeFocusPanel.tsx"), "utf8");

    expect(RECIPE_FOCUS_NATIVE_BASE_FIELDS).toEqual(["recipeFocus"]);
    expect(app).toMatch(/baseFields:\s*\[\.\.\.RECIPE_FOCUS_NATIVE_BASE_FIELDS\]/);
    expect(app).toMatch(/selectNativeRecipeFocusReadModel\(nativeFactoryThinViewSnapshot/);
    expect(app).toMatch(/nativePlayerAuthorityOwnsRuntime\s*\?\s*nativeRecipeFocusReadModel\s*:\s*webRecipeFocusReadModel/);
    expect(app).toMatch(/nativePlayerAuthorityOwnsRuntime \? null : createWebRecipeFocusReadModel\(game\)/);
    expect(app).toMatch(/<RecipeFocusPanel\s+model=\{recipeFocusReadModel\}/);
    expect(app).not.toMatch(/<RecipeFocusPanel\s+game=\{/);
    expect(panel).toMatch(/RecipeFocusReadModel/);
    expect(panel).toMatch(/data-recipe-focus-source=\{model\.source\}/);
    expect(panel).not.toMatch(/GameState|game\.recipeFocus/);
  });
});
