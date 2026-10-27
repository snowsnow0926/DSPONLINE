import example from "../../docs/examples/example-dense-materials.content-pack.json";
import clockWorkerUrl from "./canonical-owner-clock.worker.ts?worker&url";
import { createInitialState } from "../../src/game/engine";
import { applyContentPackRegistry, createContentPackRegistry, getActiveContentPackReferences,
  loadContentPackRegistry, registerContentPack, saveContentPackRegistry } from "../../src/game/contentPacks";
import { validateContentPack } from "../../src/game/mods";
import { parseTrustedWorkerEnvelope } from "../../src/game/storage";
import { decodeVerifiedSaveTransfer, serializeSaveEnvelopeToTransfer } from "../../src/game/saveTransfer";
import { CanonicalTerminalDecoder } from "../../src/game/canonicalTerminalOwnerClient";
import { serializeAuthoritativePrimarySaveInWorker } from "../../src/game/authoritativeSaveSerializationClient";
import type { AuthoritativeSerializedSaveProofPayload } from "../../src/game/authoritativeSaveSerializationClient";
import type { FactoryEntity, ItemId, RecipeId } from "../../src/game/types";

const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const digest = async (value: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
async function verifyBody(saved: AuthoritativeSerializedSaveProofPayload) {
  const body = saved.proof.transportEncoding === "gzip"
    ? await new Response(new Blob([saved.bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer() : saved.bytes;
  const sha256 = hex(await crypto.subtle.digest("SHA-256", body));
  if (sha256 !== saved.proof.payloadSha256 || body.byteLength !== saved.proof.byteLength) throw new Error("Actual compatibility payload proof differs");
  return { sha256, bytes: body.byteLength };
}

export async function runCanonicalOwnerParity() {
  const originalStorage = Object.entries(localStorage);
  const originalNow = Date.now;
  const NativeWorker = globalThis.Worker;
  Date.now = () => 1_800_000_000_000;
  function ClockWorker(url: string | URL, options?: WorkerOptions): Worker {
    return new NativeWorker(options?.name === "canonical-terminal-decoder" ? clockWorkerUrl : url, options);
  }
  globalThis.Worker = ClockWorker as unknown as typeof Worker;
  const reports = [];
  try {
    for (const scenario of ["normal", "speedrun", "enabled-pack-and-overrides"] as const) {
      let registry = createContentPackRegistry();
      if (scenario === "enabled-pack-and-overrides") {
        const validation = validateContentPack({ ...example,
          buildingOverrides: [{ id: "arc_smelter", speed: 2.5, outputCapacity: 12_345, stackLimit: 99 }] });
        if (!validation.valid) throw new Error("Public compatibility pack failed validation");
        registry = registerContentPack(registry, validation).registry;
      }
      if (!applyContentPackRegistry(registry).catalogValid || !saveContentPackRegistry(registry)) throw new Error("Compatibility registry activation failed");
      registry = loadContentPackRegistry();
      const source = createInitialState(44_249);
      source.mode = scenario === "speedrun" ? "speedrun" : "normal";
      source.orbitalStation.contractBoard.lastConfirmedWallClockMs = 1_800_000_000_000;
      source.contentPacks = getActiveContentPackReferences(registry);
      source.entities[0].inputs.iron_ore = 137;
      const entity = (id: string, buildingId: FactoryEntity["buildingId"], recipeId: FactoryEntity["recipeId"]): FactoryEntity => ({
        id, kind: "machine", planetId: "home", position: { x: 100, y: 100 }, buildingId, recipeId,
        machineCount: 1, minerCount: 0, inputs: {}, outputs: {}, progress: 0.25, routingCursor: 0,
        utilization: 0, productionRate: 0, interactionLocked: false,
      });
      const smelter = entity("compat-smelter", "arc_smelter", "iron_ingot");
      smelter.inputs.iron_ore = 31; smelter.outputs.iron_ingot = 7_000;
      source.entities.push(smelter);
      if (scenario === "enabled-pack-and-overrides") {
        source.tray["example_dense_plate" as ItemId] = 137;
        source.planetTrays.home = { ...source.tray };
        const custom = entity("compat-custom-recipe", "assembling_machine_mk1", "example_dense_plate_recipe" as RecipeId);
        custom.inputs.iron_ingot = 19; custom.inputs.copper_ingot = 11; custom.outputs["example_dense_plate" as ItemId] = 7;
        source.entities.push(custom);
      }
      const frame = serializeSaveEnvelopeToTransfer(source, { formatVersion: 2, savedAt: 1_800_000_000_000,
        kind: "primary", slot: "main", mode: source.mode });
      const verification = { integrity: "valid" as const, stateChecksum: frame.stateChecksum,
        payloadChecksum: frame.payloadChecksum, byteLength: frame.byteLength };
      const baseline = parseTrustedWorkerEnvelope(decodeVerifiedSaveTransfer(frame.bytes, verification), verification, registry);
      const before = JSON.stringify(baseline);
      const expected = await serializeAuthoritativePrimarySaveInWorker(baseline, { savedAt: 1_800_000_000_000, frozenStateIsCurrent: () => true });
      const expectedBody = await verifyBody(expected);
      const decoder = new CanonicalTerminalDecoder(new Blob([frame.bytes]), verification, registry, { isCurrent: () => true });
      try {
        const state = await decoder.state;
        if (JSON.stringify(state) !== before) {
          const differences: string[] = [];
          const compare = (left: unknown, right: unknown, path = "state") => {
            if (Object.is(left, right) || differences.length >= 8) return;
            if (!left || !right || typeof left !== "object" || typeof right !== "object") { differences.push(path); return; }
            for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) compare((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key], `${path}.${key}`);
          };
          compare(baseline, state);
          throw new Error(`Full canonical state differs: ${scenario}; ${differences.join(",")}`);
        }
        const actual = await serializeAuthoritativePrimarySaveInWorker(state, { savedAt: 1_800_000_000_000, frozenStateIsCurrent: () => true });
        const actualBody = await verifyBody(actual);
        if (actualBody.sha256 !== expectedBody.sha256 || actualBody.bytes !== expectedBody.bytes || JSON.stringify(state) !== before) {
          throw new Error(`Full saved value or caller ownership differs: ${scenario}`);
        }
        if (scenario === "enabled-pack-and-overrides" && (state.tray["example_dense_plate" as ItemId] !== 137 ||
          state.entities.find((entry) => entry.id === "compat-custom-recipe")?.recipeId !== ("example_dense_plate_recipe" as RecipeId))) {
          throw new Error("Enabled extension inventory or explicit recipe disappeared");
        }
        reports.push({ scenario, stateSha256: await digest(before), body: actualBody, inputAndOutputIntegersPreserved: true });
      } finally { decoder.close(); }
    }
    return { scope: "real production decoder and ordinary proof client under a fixed wall clock; public normal/speedrun/enabled-pack with building override fixtures",
      passed: reports.length, failed: 0, reports };
  } finally {
    globalThis.Worker = NativeWorker; Date.now = originalNow;
    applyContentPackRegistry(createContentPackRegistry());
    for (const key of Object.keys(localStorage)) localStorage.removeItem(key);
    for (const [key, value] of originalStorage) localStorage.setItem(key, value);
  }
}
Object.assign(globalThis, { runCanonicalOwnerParity });
