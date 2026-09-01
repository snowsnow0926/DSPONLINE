import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { createNativeFactoryBeltBatchCommand } from "./nativeFactoryBeltBatchCommands";

describe("native factory belt batch commands", () => {
  it("keeps generated IDs, inventory and catalog decisions out of the marker", () => {
    const command = createNativeFactoryBeltBatchCommand(17, [{
      sourceId: "mod:source/一", targetId: "target-a", itemId: "iron_ore", tier: 4, lanes: 12,
    }]);
    expect(command.topLevelChanges).toEqual([{
      path: ["factoryBeltBatch", "intent"], operation: "set", value: { requests: [{
        sourceId: "mod:source/一", targetId: "target-a", itemId: "iron_ore", tier: 4, lanes: 12,
      }] },
    }]);
    expect(JSON.stringify(command)).not.toMatch(/construction|belt_\d+|nextId/);
  });

  it("rejects duplicate routes and malformed bounded values", () => {
    const route = { sourceId: "a", targetId: "b", itemId: "iron_ore", tier: 1, lanes: 1 };
    expect(() => createNativeFactoryBeltBatchCommand(1, [route, route])).toThrow(/重复/);
    expect(() => createNativeFactoryBeltBatchCommand(1, [{ ...route, lanes: 0 }])).toThrow();
    expect(() => createNativeFactoryBeltBatchCommand(1, [{ ...route, tier: 33 }])).toThrow();
    expect(() => createNativeFactoryBeltBatchCommand(1, [{ ...route, sourceId: "bad\nid" }])).toThrow();
    expect(() => createNativeFactoryBeltBatchCommand(-1, [route])).toThrow();
  });

  it("routes native continuous gestures through one Rust-owned atomic command", () => {
    const app = readFileSync(resolve("src/App.tsx"), "utf8");
    const confirmBlock = app.slice(
      app.indexOf("const confirmBatchConnection = useCallback("),
      app.indexOf("useEffect(() => { confirmBatchConnectionRef.current", app.indexOf("const confirmBatchConnection = useCallback(")),
    );
    const connectBlock = app.slice(
      app.indexOf("const onConnect = useCallback("),
      app.indexOf("useEffect(() => { connectRequestRef.current", app.indexOf("const onConnect = useCallback(")),
    );

    expect(app).toMatch(/import \{ createNativeFactoryBeltBatchCommand \}/);
    expect(app).not.toMatch(/原生权威未接入批量拉线命令|原生模式当前只允许逐条拉线/);
    expect(confirmBlock).toMatch(/nativeAuthoritativeFactoryCanvasFrameRef\.current/);
    expect(confirmBlock).toMatch(/commitNativeProjectedCommand\(frame\.revision,[\s\S]*?createNativeFactoryBeltBatchCommand/);
    expect(confirmBlock).not.toMatch(/connectBeltsAtomically\([\s\S]*?nativePlayerAuthorityOwnsRuntimeRef\.current/);
    expect(connectBlock).toMatch(/batchConnectionModeRef\.current[\s\S]*?addBatchConnection\(connection, draft\)/);
  });
});
