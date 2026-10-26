import { describe, expect, it } from "vitest";
import { inspectCanonicalSaveEnvelope } from "./canonicalSaveEnvelopeInspection";
import { computeSaveStateChecksum } from "./saveEnvelopeIntegrity";
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
  it("keeps exact checksums across string escapes, Unicode and checksum loop tails", () => {
    const texts = ["", "abc", "quote\"slash\\", "\u0000\n\t", "\\u1234", "物料🧪", "\ud800", "\udc00", "},]\\\""];
    for (let index = 0; index < 256; index++) {
      const text = texts[index % texts.length] + "x".repeat(index % 37);
      const mode = index % 2 ? "normal" : "speedrun";
      const state = {
        version: 47, mode, activePlanetId: `home-${text}`,
        entities: Array.from({ length: index % 7 }, (_, id) => ({ id, text, nested: [{ value: text }, null] })),
        belts: Array.from({ length: index % 5 }, (_, id) => ({ id, text })),
        elapsedSeconds: index + 0.5, research: { completedTechIds: texts.slice(0, index % 5) },
        dysonSphere: { structurePoints: index * 10 }, extra: { text, flags: [true, false, null, -1.5e-8] },
      };
      const checksum = computeSaveStateChecksum(2, state);
      const raw = JSON.stringify({ formatVersion: 2, kind: "primary", savedAt: 1234, mode, slot: "main", state, checksum });
      expect(inspectCanonicalSaveEnvelope(raw), `sample ${index}`).toEqual({
        formatVersion: 2, kind: "primary", savedAt: 1234, mode, slot: "main",
        recordedChecksum: checksum, computedChecksum: checksum,
        state: { version: 47, mode, activePlanetId: state.activePlanetId, entityCount: state.entities.length,
          beltCount: state.belts.length, elapsedSeconds: index, completedTechCount: state.research.completedTechIds.length,
          structurePoints: index * 10 },
      });
    }
  });

  it("does not let fast string scans skip invalid controls or escapes", () => {
    const raw = fixtureRaw();
    for (const invalid of ["bad\u0000value", "bad\nvalue", "bad\\qvalue", "bad\\u12xzvalue", "bad\\"]) {
      expect(inspectCanonicalSaveEnvelope(raw.replace('"id":"a"', `"id":"${invalid}"`))).toBeNull();
    }
  });

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
