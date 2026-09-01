import { describe, expect, it } from "vitest";

import type { NativeAuthoritativeFactoryCanvasFrame } from "./nativeFactoryCanvasFrame";
import { createNativeFactoryPositionCommand } from "./nativeFactoryPositionCommands";
import type { FactoryEntity } from "./types";

function entity(id: string, x: number, y: number, interactionLocked = false): FactoryEntity {
  return {
    id,
    kind: "machine",
    planetId: "home",
    position: { x, y },
    interactionLocked,
  } as FactoryEntity;
}

function frame(rows = [entity("b", 20, 40), entity("a", 0, 0)]): NativeAuthoritativeFactoryCanvasFrame {
  return {
    source: "native-authoritative",
    sessionId: "session-a",
    runId: "run-a",
    revision: 7,
    planetId: "home",
    entities: rows,
    entityById: new Map(rows.map((row) => [row.id, row] as const)),
  } as unknown as NativeAuthoritativeFactoryCanvasFrame;
}

describe("native factory position commands", () => {
  it("emits only changed axes in stable projected entity order", () => {
    expect(createNativeFactoryPositionCommand(frame(), 7, [
      { id: "a", position: { x: 0, y: 80 } },
      { id: "b", position: { x: 60, y: 40 } },
    ])?.changedEntities).toEqual([
      {
        id: "b",
        changes: [{ path: ["position", "x"], operation: "set", value: 60 }],
      },
      {
        id: "a",
        changes: [{ path: ["position", "y"], operation: "set", value: 80 }],
      },
    ]);
  });

  it("returns null when a snapped drag did not change authoritative coordinates", () => {
    expect(createNativeFactoryPositionCommand(frame(), 7, [
      { id: "a", position: { x: 0, y: 0 } },
    ])).toBeNull();
  });

  it("fails closed for stale, duplicate, missing, locked and non-finite targets", () => {
    expect(() => createNativeFactoryPositionCommand(frame(), 6, [
      { id: "a", position: { x: 20, y: 20 } },
    ])).toThrow(TypeError);
    expect(() => createNativeFactoryPositionCommand(frame(), 7, [
      { id: "a", position: { x: 20, y: 20 } },
      { id: "a", position: { x: 40, y: 40 } },
    ])).toThrow(TypeError);
    expect(() => createNativeFactoryPositionCommand(frame(), 7, [
      { id: "missing", position: { x: 20, y: 20 } },
    ])).toThrow(TypeError);
    expect(() => createNativeFactoryPositionCommand(
      frame([entity("locked", 0, 0, true)]),
      7,
      [{ id: "locked", position: { x: 20, y: 20 } }],
    )).toThrow(TypeError);
    expect(() => createNativeFactoryPositionCommand(frame(), 7, [
      { id: "a", position: { x: Number.NaN, y: 20 } },
    ])).toThrow(TypeError);
  });

  it("bounds the multi-drag target count before building a durable command", () => {
    const rows = Array.from({ length: 4_097 }, (_, index) => entity(`entity-${index}`, index, 0));
    expect(() => createNativeFactoryPositionCommand(
      frame(rows),
      7,
      rows.map((row) => ({ id: row.id, position: { x: row.position.x, y: 20 } })),
    )).toThrow(TypeError);
  });
});
