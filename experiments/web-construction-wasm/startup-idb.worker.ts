import { createPureIdleRecovery, readPureIdleRecovery } from "../../src/game/pureIdleRecovery";
import type { GameState } from "../../src/game/types";

let state: GameState | null = null;
let entityCount = 0;
let beltCount = 0;
let entities = 0;
let belts = 0;
let stored = false;
const hash = async (value: unknown) => [...new Uint8Array(await crypto.subtle.digest("SHA-256",
  new TextEncoder().encode(JSON.stringify(value))))].map(byte => byte.toString(16).padStart(2, "0")).join("");

self.onmessage = async ({ data }) => {
  try {
    if (data.kind === "begin") {
      if (state || !Number.isSafeInteger(data.entities) || !Number.isSafeInteger(data.belts)) throw Error("Invalid begin");
      state = { ...data.topLevel };
      entityCount = data.entities; beltCount = data.belts;
      state!.entities = new Array(entityCount); state!.belts = new Array(beltCount);
    } else if (data.kind === "records") {
      if (!state || stored || !["entities", "belts"].includes(data.collection)) throw Error("Invalid collection");
      const offset = data.collection === "entities" ? entities : belts;
      const maximum = data.collection === "entities" ? entityCount : beltCount;
      const limit = data.collection === "entities" ? 512 : 2048;
      if (data.offset !== offset || !Array.isArray(data.records) || !data.records.length ||
        data.records.length > limit || offset + data.records.length > maximum) throw Error("Invalid record order");
      const target = state[data.collection as "entities" | "belts"];
      for (let index = 0; index < data.records.length; index++) target[offset + index] = data.records[index];
      if (data.collection === "entities") entities += data.records.length; else belts += data.records.length;
    } else if (data.kind === "store") {
      if (!state || stored || entities !== entityCount || belts !== beltCount) throw Error("Incomplete state");
      const result = await createPureIdleRecovery(state, "replication", 1_800_000_000_000, "isolated-idb-probe", 1_800_000_000_000, true);
      if (!result.ok) throw Error(result.message);
      stored = true;
    } else if (data.kind === "verify") {
      if (!stored) throw Error("Nothing stored");
      const record = await readPureIdleRecovery();
      if (!record || record.mode !== "replication" || !record.startedPaused || record.committed ||
        record.ownerToken !== "isolated-idb-probe" || record.startedAtMs !== 1_800_000_000_000) throw Error("Stored metadata differs");
      self.postMessage({ ok: true, stateSha256: await hash(record.state) }); return;
    } else throw Error("Unknown operation");
    self.postMessage({ ok: true });
  } catch (error) { self.postMessage({ ok: false, error: error instanceof Error ? error.message : "IDB experiment failed" }); }
};
