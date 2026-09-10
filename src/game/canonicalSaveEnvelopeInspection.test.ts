import { describe, expect, it } from "vitest";
import { inspectCanonicalSaveEnvelope } from "./canonicalSaveEnvelopeInspection";
import { serializeSaveEnvelopeToTransfer } from "./saveTransfer";

function fixtureRaw(): string {
  const state = {
    version: 47,
    mode: "normal",
    activePlanetId: "home-}]-\\\"",
    entities: [
      { id: "a", nested: { text: "},] still inside string" } },
      { id: "b", values: [1, 2, { closing: "]}" }] },
    ],
    belts: [{ id: "belt-1" }],
    elapsedSeconds: 123,
    research: { completedTechIds: ["t1", "t2"] },
    dysonSphere: { structurePoints: 456 },
  };
  const serialized = serializeSaveEnvelopeToTransfer(state, {
    formatVersion: 2,
    savedAt: 1_787_488_000_000,
    kind: "primary",
    mode: "normal",
    slot: "main",
  });
  return new TextDecoder().decode(serialized.bytes);
}

describe("canonical save envelope inspection", () => {
  it("validates header/checksum and counts large collections without parsing the state object", () => {
    expect(inspectCanonicalSaveEnvelope(fixtureRaw())).toEqual({
      formatVersion: 2,
      kind: "primary",
      savedAt: 1_787_488_000_000,
      mode: "normal",
      slot: "main",
      recordedChecksum: expect.stringMatching(/^[0-9a-f]{8}$/),
      computedChecksum: expect.stringMatching(/^[0-9a-f]{8}$/),
      state: {
        mode: "normal",
        version: 47,
        activePlanetId: "home-}]-\\\"",
        entityCount: 2,
        beltCount: 1,
        elapsedSeconds: 123,
        completedTechCount: 2,
        structurePoints: 456,
      },
    });
    const inspected = inspectCanonicalSaveEnvelope(fixtureRaw());
    expect(inspected?.computedChecksum).toBe(inspected?.recordedChecksum);
  });

  it("detects a mutated state and rejects malformed or duplicate top-level fields", () => {
    const raw = fixtureRaw();
    const mutated = raw.replace('"elapsedSeconds":123', '"elapsedSeconds":124');
    const inspected = inspectCanonicalSaveEnvelope(mutated);
    expect(inspected?.computedChecksum).not.toBe(inspected?.recordedChecksum);
    expect(inspectCanonicalSaveEnvelope(raw.replace('{"formatVersion":2', '{"formatVersion":2,"formatVersion":2'))).toBeNull();
    expect(inspectCanonicalSaveEnvelope(raw.slice(0, -1))).toBeNull();
  });

  it("counts reordered and escaped collection fields without including nested arrays", () => {
    const envelope = JSON.parse(fixtureRaw());
    const { entities, belts, ...rest } = envelope.state;
    envelope.state = { belts, extra: { entities: [1, 2, 3], belts: [4, 5] }, ...rest, entities };
    const raw = JSON.stringify(envelope).replace('"state":', '"st\\u0061te":')
      .replace('"belts":', '"b\\u0065lts":');
    expect(inspectCanonicalSaveEnvelope(raw)?.state).toMatchObject({ entityCount: 2, beltCount: 1 });

    envelope.state.entities = [];
    envelope.state.belts = [];
    expect(inspectCanonicalSaveEnvelope(JSON.stringify(envelope))?.state)
      .toMatchObject({ entityCount: 0, beltCount: 0 });
  });

  it("still rejects malformed, duplicate and missing state collections", () => {
    const raw = fixtureRaw();
    for (const malformed of [
      raw.replace('"entities":[', '"entities":{},"discarded":['),
      raw.replace('"entities":[', '"entities":[],"entities":['),
      raw.replace('"entities":[', '"entities":[],"entit\\u0069es":['),
      raw.replace('"entities":[', '"missingEntities":['),
      raw.replace('"belts":[', '"belts":null,"discarded":['),
      raw.replace('"belts":[', '"belts":[,'),
      raw.replace('"belts":[{"id":"belt-1"}]', '"belts":[{"id":"belt-1"},]'),
      raw.replace('"state":{', '"state":{"invalid":"\\q",'),
      raw.replace('"state":{', '"state":{"unclosed":['),
    ]) expect(inspectCanonicalSaveEnvelope(malformed)).toBeNull();
  });
});
