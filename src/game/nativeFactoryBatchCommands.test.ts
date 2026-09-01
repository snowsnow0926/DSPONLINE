import { describe, expect, it } from "vitest";

import { createNativeFactoryBatchCommand } from "./nativeFactoryBatchCommands";

describe("native factory batch commands", () => {
  it("keeps construction accounting and target derivation out of the renderer marker", () => {
    const command = createNativeFactoryBatchCommand(42, {
      kind: "increase",
      entityIds: ["machine-a", "模组:建筑/甲"],
      beltIds: ["belt-a"],
      amount: 10,
    });
    expect(command.topLevelChanges).toEqual([{
      path: ["factoryBatch", "intent"],
      operation: "set",
      value: {
        kind: "increase",
        entityIds: ["machine-a", "模组:建筑/甲"],
        beltIds: ["belt-a"],
        amount: 10,
      },
    }]);
    expect(JSON.stringify(command)).not.toMatch(/construction|machineCount|lanes/);
  });

  it("encodes remove and the two upgrade domains as disjoint semantic scopes", () => {
    expect(createNativeFactoryBatchCommand(3, {
      kind: "remove", entityIds: ["a"], beltIds: ["b"],
    }).topLevelChanges[0]?.value).toEqual({
      kind: "remove", entityIds: ["a"], beltIds: ["b"],
    });
    expect(createNativeFactoryBatchCommand(3, {
      kind: "upgrade-buildings", entityIds: ["a"],
    }).topLevelChanges[0]?.value).toEqual({
      kind: "upgrade-buildings", entityIds: ["a"], beltIds: [],
    });
    expect(createNativeFactoryBatchCommand(3, {
      kind: "upgrade-belts", beltIds: ["b"],
    }).topLevelChanges[0]?.value).toEqual({
      kind: "upgrade-belts", entityIds: [], beltIds: ["b"],
    });
  });

  it("fails closed for stale numbers, duplicates, controls and crossed upgrade scopes", () => {
    expect(() => createNativeFactoryBatchCommand(-1, { kind: "remove", entityIds: ["a"], beltIds: [] })).toThrow();
    expect(() => createNativeFactoryBatchCommand(1, { kind: "increase", entityIds: ["a"], beltIds: [], amount: 0 })).toThrow();
    expect(() => createNativeFactoryBatchCommand(1, { kind: "remove", entityIds: ["a", "a"], beltIds: [] })).toThrow();
    expect(() => createNativeFactoryBatchCommand(1, { kind: "remove", entityIds: ["bad\nid"], beltIds: [] })).toThrow();
    expect(() => createNativeFactoryBatchCommand(1, {
      kind: "upgrade-buildings", entityIds: ["a"], beltIds: ["b"],
    } as never)).toThrow();
  });
});
