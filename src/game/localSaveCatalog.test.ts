import { describe, expect, it } from "vitest";
import { computeSaveStateChecksum } from "./saveEnvelopeIntegrity";
import { buildLocalSaveCatalog, catalogMatchesPayload } from "./localSaveCatalogBuild";
import {
  LOCAL_SAVE_CATALOG_MAX_BYTES,
  localSaveCatalogRecordKey,
  parseLocalSaveCatalog,
  payloadKeyFromLocalSaveCatalogRecord,
  serializeLocalSaveCatalog,
} from "./localSaveCatalog";

function envelope(savedAt = 123): string {
  const state = {
    version: 46,
    mode: "normal",
    elapsedSeconds: 7_200,
    activePlanetId: "ashen",
    entities: [{ id: "entity" }],
    belts: [{ id: "belt" }, { id: "belt-2" }],
    research: { completedTechIds: ["a", "b", "c"] },
    dysonSphere: { structurePoints: 42 },
    settings: { fontScale: 1.25, simulationSpeed: 2 },
  };
  return JSON.stringify({
    formatVersion: 2,
    kind: "primary",
    savedAt,
    mode: "normal",
    slot: "main",
    state,
    checksum: computeSaveStateChecksum(2, state),
  });
}

describe("local save catalog side records", () => {
  it("keeps every side-record key outside the exact 1.0.43 payload namespaces", () => {
    const legacyV143IsSaveKey = (key: string) => key === "dsp-idle-network.save.v1" ||
      key === "dsp-idle-network.save.v1.backup" || key === "dsp-idle-network.save.v1.backup.speedrun" ||
      key.startsWith("dsp-idle-network.save.v1.migration-backup.") ||
      key.startsWith("dsp-idle-network.save.v1.normal") || key.startsWith("dsp-idle-network.save.v1.speedrun") ||
      key.startsWith("dsp-idle-network.save.v1.snapshot.") || key.startsWith("dsp-idle-network.save.v1.import-cache.") ||
      key.startsWith("dsp-idle-network.save.v1.conflict.") || key.startsWith("dsp-idle-network.slot.");
    for (const payloadKey of [
      "dsp-idle-network.save.v1",
      "dsp-idle-network.save.v1.backup",
      "dsp-idle-network.slot.2",
      "dsp-idle-network.save.v1.snapshot.500-1",
      "dsp-idle-network.save.v1.conflict.example.candidate",
    ]) {
      const catalogKey = localSaveCatalogRecordKey(payloadKey);
      expect(legacyV143IsSaveKey(catalogKey)).toBe(false);
      expect(payloadKeyFromLocalSaveCatalogRecord(catalogKey)).toBe(payloadKey);
    }
  });

  it("uses a full checksum-verified parse and stays below the 4 KiB per-item budget", () => {
    const key = "dsp-idle-network.save.v1";
    const raw = envelope();
    const catalog = buildLocalSaveCatalog(key, raw, 7);
    const encoded = serializeLocalSaveCatalog(catalog);
    expect(catalog).toMatchObject({
      key,
      mode: "normal",
      kind: "primary",
      slot: "main",
      savedAt: 123,
      byteLength: new TextEncoder().encode(raw).byteLength,
      revision: 7,
      stateVersion: 46,
      entityCount: 1,
      beltCount: 2,
      elapsedSeconds: 7_200,
      completedTechCount: 3,
      activePlanetId: "ashen",
      structurePoints: 42,
      integrity: "valid",
    });
    expect(new TextEncoder().encode(encoded).byteLength).toBeLessThan(LOCAL_SAVE_CATALOG_MAX_BYTES);
    expect(parseLocalSaveCatalog(encoded, key)).toEqual(catalog);
    expect(catalogMatchesPayload(catalog, raw)).toBe(true);
    expect(payloadKeyFromLocalSaveCatalogRecord(localSaveCatalogRecordKey(key))).toBe(key);
  });

  it("binds exact payload bytes even when duplicate keys parse to the same semantic value", () => {
    const key = "dsp-idle-network.save.v1";
    const canonical = envelope(222);
    const duplicate = canonical.replace('"savedAt":222', '"savedAt":111,"savedAt":222');
    const canonicalCatalog = buildLocalSaveCatalog(key, canonical, 1);
    const duplicateCatalog = buildLocalSaveCatalog(key, duplicate, 1);
    expect(duplicateCatalog.savedAt).toBe(canonicalCatalog.savedAt);
    expect(duplicateCatalog.integrity).toBe("valid");
    expect(duplicateCatalog.payloadChecksum).not.toBe(canonicalCatalog.payloadChecksum);
    expect(catalogMatchesPayload(canonicalCatalog, duplicate)).toBe(false);
    expect(catalogMatchesPayload(duplicateCatalog, canonical)).toBe(false);
  });

  it("does not approximate nested keys and marks malformed or truncated payloads invalid", () => {
    const key = "dsp-idle-network.save.v1";
    const raw = envelope(333).replace('"fontScale":1.25', '"savedAt":999999,"entities":[1,2,3],"fontScale":1.25');
    const catalog = buildLocalSaveCatalog(key, raw, 0);
    expect(catalog.savedAt).toBe(333);
    expect(catalog.entityCount).toBe(1);
    expect(catalog.integrity).toBe("invalid");
    expect(buildLocalSaveCatalog(key, raw.slice(0, -17), 0).integrity).toBe("invalid");
    expect(parseLocalSaveCatalog("{truncated", key)).toBeNull();
    expect(parseLocalSaveCatalog(JSON.stringify({ ...catalog, key: "other" }), key)).toBeNull();
    expect(parseLocalSaveCatalog(JSON.stringify({ ...catalog, padding: "x".repeat(4 * 1024) }), key)).toBeNull();
  });

  it("does not let a mismatched envelope namespace override the authoritative state mode", () => {
    const key = "dsp-idle-network.save.v1.speedrun";
    const mismatched = envelope().replace('"mode":"normal"', '"mode":"speedrun"');
    expect(buildLocalSaveCatalog(key, mismatched, 0)).toMatchObject({ mode: "normal", integrity: "valid" });
  });
});
