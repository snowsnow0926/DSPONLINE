import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("native factory auto-layout App boundary", () => {
  const app = readFileSync(resolve("src/App.tsx"), "utf8");

  it("submits a compact same-revision Rust intent before touching the legacy GameState", () => {
    const start = app.indexOf("const autoLayoutEntities = useCallback");
    const end = app.indexOf("const undoAutoLayout = useCallback", start);
    const block = app.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(block).toMatch(/nativePlayerAuthorityOwnsRuntimeRef\.current/);
    expect(block).toMatch(/nativeAuthoritativeFactoryCanvasFrameRef\.current/);
    expect(block).toMatch(/nativePlayerAuthorityCommandBindingRef\.current/);
    expect(block).toMatch(/frame\.sessionId !== binding\.source\.sessionId/);
    expect(block).toMatch(/frame\.runId !== binding\.source\.runId/);
    expect(block).toMatch(/frame\.revision !== binding\.source\.baseRevision/);
    expect(block).toMatch(/commitNativeProjectedCommand\(\s*frame\.revision/);
    expect(block).toMatch(/createNativeFactoryAutoLayoutCommand\(baseRevision, selection\)/);
    expect(block.indexOf("commitNativeProjectedCommand"))
      .toBeLessThan(block.indexOf("const current = gameRef.current"));
  });

  it("does not optimistically install Rust-computed positions in the renderer", () => {
    const start = app.indexOf("const autoLayoutEntities = useCallback");
    const nativeEnd = app.indexOf("const current = gameRef.current", start);
    const nativeBlock = app.slice(start, nativeEnd);

    expect(nativeBlock).not.toMatch(/planFactoryAutoLayout|moveEntities|commitGame|setNodes/);
    expect(nativeBlock).toMatch(/setAutoLayoutUndo\(null\)/);
    expect(nativeBlock).toMatch(/正在刷新画布/);
  });

  it("enables dragging only for a same-revision native command binding", () => {
    expect(app).toMatch(/const nativeFactoryPositionWriteReady = Boolean\([\s\S]*?nativePlayerAuthorityCommandPending[\s\S]*?nativeAuthoritativeFactoryCanvasFrame\.revision === nativePlayerAuthorityCommandSource\.baseRevision/);
    expect(app).toMatch(/const draggable = \(!nativePlayerAuthorityOwnsRuntime \|\| nativeFactoryPositionWriteReady\)/);
    expect(app).toMatch(/nodesDraggable=\{\(!nativePlayerAuthorityOwnsRuntime \|\| nativeFactoryPositionWriteReady\)/);
  });

  it("rebases an unchanged drag onto the latest Rust frame and restores transient React Flow coordinates", () => {
    const start = app.indexOf("const handleFactoryNodeDragStart = useCallback");
    const end = app.indexOf("const handleFactoryFlowMove = useCallback", start);
    const block = app.slice(start, end);

    expect(block).toMatch(/nativeIdentity = \{[\s\S]*?sessionId: frame\.sessionId[\s\S]*?revision: frame\.revision/);
    expect(block).toMatch(/sourceRowsUnchanged[\s\S]*?entity\.position\.x === member\.position\.x/);
    expect(block).toMatch(/frame\.revision < identity\.revision/);
    expect(block).toMatch(/createNativeFactoryPositionCommand\(frame, baseRevision, positions\)/);
    expect(block).toMatch(/restoreCanvasEntityPositions\(\);[\s\S]*?if \(accepted\)/);
    expect(block).not.toMatch(/rejectLegacyFactoryInteractionWhileNative\("建筑位置编辑"\)/);
  });
});
