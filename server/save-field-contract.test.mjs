import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { computeSaveStateChecksum } from "./save-integrity.mjs";
import {
  SAVE_FIELD_CONTRACT,
  inspectSaveContractField,
  inspectSaveContractRecord,
  listSaveContractFields,
  omitSaveContractDefaults,
} from "./save-field-contract.mjs";

const rootContract = JSON.parse(await readFile(new URL("../save-field-contract.json", import.meta.url), "utf8"));

function envelope(state) {
  return {
    formatVersion: 2,
    savedAt: 123_456,
    mode: state.mode,
    state,
    checksum: computeSaveStateChecksum(2, state),
  };
}

test("server consumes the root save-field contract without a drifted copy", () => {
  assert.deepEqual(SAVE_FIELD_CONTRACT, rootContract);
  assert.equal(Object.isFrozen(SAVE_FIELD_CONTRACT), true);
  assert.deepEqual(listSaveContractFields("belt", 46, "missing-default"), [
    "lanes", "tier", "sorterTier", "progress", "priority", "stackSize", "monitorEnabled",
    "totalTransferred", "congestion", "lastFlow", "routeMode",
  ]);
  assert.deepEqual(listSaveContractFields("station-slot", 46, "missing-default"), [
    "localMode", "remoteMode", "minimumLoad", "minStock", "maxStock", "priority", "routePolicy", "warperBudget",
  ]);
});

test("server field reads default only missing v46 values and rejects explicit invalid values", () => {
  const sparse = {};
  assert.deepEqual(inspectSaveContractField("belt", "lanes", sparse, 46), {
    valid: true,
    status: "defaulted",
    source: "default",
    value: 1,
    reason: null,
  });
  assert.equal(inspectSaveContractField("belt", "lanes", { lanes: null }, 46).valid, false);
  assert.equal(inspectSaveContractField("belt", "lanes", { lanes: "1" }, 46).valid, false);
  assert.equal(inspectSaveContractField("belt", "lanes", { lanes: 0 }, 46).valid, false);
  assert.equal(inspectSaveContractField("belt", "lanes", { lanes: -1 }, 46).valid, false);
  assert.equal(inspectSaveContractField("belt", "lanes", { lanes: 4_097 }, 46).valid, false);
  assert.equal(inspectSaveContractField("belt", "tier", { tier: 33 }, 46).valid, false);
  assert.equal(inspectSaveContractField("belt", "progress", { progress: Number.NaN }, 46).valid, false);
  assert.equal(inspectSaveContractField("entity", "interactionLocked", { interactionLocked: "false" }, 46).valid, false);
  assert.equal(inspectSaveContractRecord("station-slot", {}, 46).valid, true);
  assert.equal(inspectSaveContractField("station-slot", "localMode", { localMode: null }, 46).valid, false);
  assert.equal(inspectSaveContractField("station-slot", "minimumLoad", { minimumLoad: 0.2 }, 46).valid, false);
  assert.equal(inspectSaveContractField("station-slot", "minStock", { minStock: 100_000_001 }, 46).valid, false);
  assert.equal(inspectSaveContractField("station-slot", "warperBudget", { warperBudget: 5 }, 46).valid, false);
});

test("v45 dense values stay valid while missing required historical fields do not receive v46 defaults", () => {
  assert.equal(inspectSaveContractField("belt", "lanes", { lanes: 1 }, 45).valid, true);
  assert.equal(inspectSaveContractField("belt", "tier", { tier: 1 }, 45).valid, true);
  assert.equal(inspectSaveContractField("belt", "progress", { progress: 0 }, 45).valid, true);
  assert.equal(inspectSaveContractField("entity", "interactionLocked", { interactionLocked: false }, 45).valid, true);
  assert.deepEqual(inspectSaveContractField("belt", "lanes", {}, 45), {
    valid: false,
    status: "missing-required",
    source: "missing",
    value: undefined,
    reason: "missing-required",
  });
});

test("contract inspection and compaction are read-only with respect to payload/checksum/revision text", () => {
  const state = {
    version: 46,
    mode: "normal",
    entities: [{ id: "entity", interactionLocked: false, inputs: {}, outputs: {} }],
    belts: [{ id: "belt", lanes: 1, tier: 1, sorterTier: 1, progress: 0 }],
  };
  const original = JSON.stringify({ revision: 17, payload: JSON.stringify(envelope(state)) });
  const parsed = JSON.parse(original);
  const payloadBefore = parsed.payload;
  const envelopeBefore = JSON.parse(parsed.payload);
  const checksumBefore = envelopeBefore.checksum;
  const revisionBefore = parsed.revision;

  assert.equal(inspectSaveContractRecord("entity", envelopeBefore.state.entities[0], 46).valid, true);
  assert.equal(inspectSaveContractRecord("belt", envelopeBefore.state.belts[0], 46).valid, true);
  assert.equal(parsed.payload, payloadBefore);
  assert.equal(envelopeBefore.checksum, checksumBefore);
  assert.equal(parsed.revision, revisionBefore);
  assert.equal(JSON.stringify({ revision: parsed.revision, payload: parsed.payload }), original);

  const projected = structuredClone(envelopeBefore.state);
  omitSaveContractDefaults(projected.entities[0], "entity", 46);
  omitSaveContractDefaults(projected.belts[0], "belt", 46);
  assert.notEqual(JSON.stringify(projected), JSON.stringify(envelopeBefore.state));
  assert.equal(parsed.payload, payloadBefore);
  assert.equal(envelopeBefore.checksum, checksumBefore);
});
