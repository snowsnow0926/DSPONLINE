import { describe, expect, it, vi } from "vitest";
import { createInitialState } from "./engine";
import { createContentPackRegistry } from "./contentPacks";
import type { GameState } from "./types";
import type { AuthoritativeSaveSerializationRequest } from "./authoritativeSaveSerializationProtocol";
import { SAVE_STATE_ENTITY_CHUNK_RECORDS, SaveStateChunkAssembler, SaveStateChunkProtocolError,
  SaveStateChunkSender, type SaveStateChunkRequest } from "./saveStateChunkTransfer";

type StateRequest = Extract<AuthoritativeSaveSerializationRequest, { state: GameState }>;
const request = (state = createInitialState()): StateRequest => ({ id: 1, state, formatVersion: 2,
  kind: "primary", slot: "main", savedAt: 1_800_000_000_000, contentPackRegistry: createContentPackRegistry(),
  includeAuthoritativeProof: true, includeSourceStateTransfer: false });
const begin = (value = request()): Extract<SaveStateChunkRequest, { type: "state-begin" }> => {
  const { state, ...metadata } = value;
  return { type: "state-begin", id: value.id, metadata, topLevel: { ...state, entities: undefined, belts: undefined },
    entityCount: state.entities.length, beltCount: state.belts.length };
};
const entityChunk = (value: StateRequest): SaveStateChunkRequest => ({ type: "state-records", id: value.id,
  collection: "entities", offset: 0, records: value.state.entities });
const complete: SaveStateChunkRequest = { type: "state-complete", id: 1 };

describe("frozen canonical-state save transport", () => {
  it("preserves full JSON bytes and source ownership across real clone boundaries", async () => {
    const value = request();
    const template = value.state.entities[0];
    value.state.entities = Array.from({ length: 1_031 }, (_, index) => ({ ...template, id: `chunk-${index}` }));
    // Synthetic transport records deliberately contain domain-independent fields:
    // this layer must preserve values rather than repair recipes or inventories.
    value.state.belts = Array.from({ length: 2_051 }, (_, index) => ({ id: `belt-${index}`, itemId: "iron_ore", amount: index })) as unknown as GameState["belts"];
    value.state.tray = value.state.planetTrays[value.state.activePlanetId]!;
    const before = JSON.stringify(value.state);
    Object.freeze(value.state.entities); Object.freeze(value.state.belts); Object.freeze(value.state);
    const assembler = new SaveStateChunkAssembler();
    const messages: SaveStateChunkRequest[] = [];
    let received: StateRequest | null = null;
    let sender: SaveStateChunkSender;
    const yieldControl = vi.fn(async () => {});
    sender = new SaveStateChunkSender({ postMessage(message) {
      const cloned = structuredClone(message) as SaveStateChunkRequest;
      messages.push(cloned);
      const response = assembler.accept(cloned);
      if ("ack" in response) queueMicrotask(() => sender.acknowledge(response.ack));
      else received = response.request;
    } }, yieldControl);
    await sender.send(value);
    const output = received as StateRequest | null;
    expect(output).not.toBeNull();
    expect(JSON.stringify(output!.state)).toBe(before);
    expect(JSON.stringify(value.state)).toBe(before);
    expect(Object.keys(output!.state)).toEqual(Object.keys(value.state));
    expect(output!.state.entities[0]).not.toBe(value.state.entities[0]);
    expect(output!.state.tray).toBe(output!.state.planetTrays[output!.state.activePlanetId]);
    expect(messages).toHaveLength(7);
    expect(yieldControl).toHaveBeenCalledTimes(5);
    expect(messages[0].type).toBe("state-begin");
    expect(messages.at(-1)?.type).toBe("state-complete");
    expect(sender.readyForResult).toBe(true);
  });

  it("accepts a fully empty record set only after an explicit completion", () => {
    const value = request(); value.state.entities = []; value.state.belts = [];
    const assembler = new SaveStateChunkAssembler();
    expect(assembler.accept(begin(value))).toHaveProperty("ack");
    expect(assembler.accept(complete)).toEqual({ request: value });
    expect(() => assembler.accept(complete)).toThrow(SaveStateChunkProtocolError);
  });

  it.each([
    ["bad id", (header: ReturnType<typeof begin>) => { header.id = 0; }],
    ["mismatched id", (header: ReturnType<typeof begin>) => { header.metadata.id = 2; }],
    ["wrong kind", (header: ReturnType<typeof begin>) => { header.metadata.kind = "slot"; }],
    ["wrong slot", (header: ReturnType<typeof begin>) => { header.metadata.slot = 1; }],
    ["missing proof", (header: ReturnType<typeof begin>) => { delete header.metadata.includeAuthoritativeProof; }],
    ["extra state source", (header: ReturnType<typeof begin>) => { Object.assign(header.metadata, { state: createInitialState() }); }],
    ["fractional count", (header: ReturnType<typeof begin>) => { header.entityCount = 1.5; }],
    ["negative count", (header: ReturnType<typeof begin>) => { header.beltCount = -1; }],
    ["oversized count", (header: ReturnType<typeof begin>) => { header.entityCount = 2 ** 32; }],
    ["embedded full records", (header: ReturnType<typeof begin>) => { Object.assign(header.topLevel, { entities: [] }); }],
  ])("fails closed on %s", (_name, mutate) => {
    const header = begin(); mutate(header);
    const assembler = new SaveStateChunkAssembler();
    expect(() => assembler.accept(header)).toThrow(SaveStateChunkProtocolError);
    expect(() => assembler.accept(begin())).toThrow(SaveStateChunkProtocolError);
  });

  it("rejects missing, duplicate and out-of-order records before serialization", () => {
    const value = request();
    const missing = new SaveStateChunkAssembler(); missing.accept(begin(value));
    expect(() => missing.accept(complete)).toThrow(/未完整/);
    const duplicate = new SaveStateChunkAssembler(); duplicate.accept(begin(value)); duplicate.accept(entityChunk(value));
    expect(() => duplicate.accept(entityChunk(value))).toThrow(/顺序/);
    const outOfOrder = new SaveStateChunkAssembler(); outOfOrder.accept(begin(value));
    expect(() => outOfOrder.accept({ ...entityChunk(value), offset: 1 } as SaveStateChunkRequest)).toThrow(/顺序/);
  });

  it("rejects chunks before begin and repeated begin", () => {
    expect(() => new SaveStateChunkAssembler().accept(entityChunk(request()))).toThrow();
    const assembler = new SaveStateChunkAssembler(); assembler.accept(begin());
    expect(() => assembler.accept(begin())).toThrow(/重复/);
  });

  it.each([[], [null], new Array(2), new Array(SAVE_STATE_ENTITY_CHUNK_RECORDS + 1).fill({ id: "too-many" })])("rejects malformed or unbounded records %#", (records) => {
    const assembler = new SaveStateChunkAssembler(); assembler.accept(begin());
    expect(() => assembler.accept({ ...entityChunk(request()), records } as SaveStateChunkRequest)).toThrow();
  });

  it("cancels an outstanding acknowledgement without consuming the source", async () => {
    const value = request(); const before = JSON.stringify(value.state);
    const postMessage = vi.fn(); const sender = new SaveStateChunkSender({ postMessage });
    const pending = sender.send(value);
    const failure = expect(pending).rejects.toThrow("cancel-test");
    sender.cancel(new Error("cancel-test")); await failure;
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(value.state)).toBe(before);
  });

  it("does not complete when a source lease expires between acknowledgements", async () => {
    const value = request(); const sent: SaveStateChunkRequest[] = [];
    let sender: SaveStateChunkSender;
    let current = true;
    sender = new SaveStateChunkSender({ postMessage(message) {
      const part = message as SaveStateChunkRequest; sent.push(part);
      if (part.type === "state-begin") queueMicrotask(() => {
        current = false; sender.acknowledge({ type: "state-chunk-ack", id: 1, collection: "begin", nextOffset: 0 });
      });
    } }, async () => {});
    await expect(sender.send(value, () => current)).rejects.toThrow(/失效/);
    expect(sent).toHaveLength(1);
  });

  it("rejects a wrong acknowledgement and releases its pending promise", async () => {
    const sender = new SaveStateChunkSender({ postMessage: vi.fn() });
    const pending = sender.send(request());
    const rejected = expect(pending).rejects.toThrow(/确认/);
    expect(() => sender.acknowledge({ type: "state-chunk-ack", id: 2, collection: "begin", nextOffset: 0 })).toThrow();
    await rejected;
  });

  it("propagates postMessage failure without sending completion", async () => {
    const postMessage = vi.fn(() => { throw new Error("clone-failed"); });
    const sender = new SaveStateChunkSender({ postMessage });
    await expect(sender.send(request())).rejects.toThrow("clone-failed");
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it("rejects sender reuse while preserving the first pending operation", async () => {
    const sender = new SaveStateChunkSender({ postMessage: vi.fn() });
    const first = sender.send(request());
    const cancelled = expect(first).rejects.toThrow("cleanup-first");
    await expect(sender.send(request())).rejects.toThrow(/重复/);
    sender.cancel(new Error("cleanup-first")); await cancelled;
    expect(sender.readyForResult).toBe(false);
  });

  it("rejects a replaced record array before sending records", async () => {
    const value = request();
    let sender: SaveStateChunkSender;
    const postMessage = vi.fn(() => queueMicrotask(() => {
      value.state.entities = [...value.state.entities];
      sender.acknowledge({ type: "state-chunk-ack", id: 1, collection: "begin", nextOffset: 0 });
    }));
    sender = new SaveStateChunkSender({ postMessage }, async () => {});
    await expect(sender.send(value)).rejects.toThrow(/失效/);
    expect(postMessage).toHaveBeenCalledTimes(1);
  });
});
