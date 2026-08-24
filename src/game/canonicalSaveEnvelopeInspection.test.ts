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
});
