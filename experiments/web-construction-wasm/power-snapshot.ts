import { advanceSimulation, refreshTimeWarpPowerSnapshot, setPaused, setTimeWarpEnabled } from "../../src/game/engine";
import type { GameState } from "../../src/game/types";

async function runPowerSnapshotProbe() {
  const source = (await (await fetch("/prepared.json")).json()).state as GameState;
  const controller = source.entities.find((entity) => entity.id === source.timeWarp.controllerEntityId && entity.buildingId === "time_warp_device")
    ?? source.entities.find((entity) => entity.buildingId === "time_warp_device");
  if (!controller) throw new Error("No time-warp controller in the fixture");
  source.timeWarp.controllerEntityId = controller.id;
  source.timeWarp.enabled = false;
  source.timeWarp.requestedMultiplier = 8;
  const input = setTimeWarpEnabled(setPaused(source, false), true);
  const sha = async (value: unknown) => [...new Uint8Array(await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(JSON.stringify(value))))].map((value) => value.toString(16).padStart(2, "0")).join("");
  const inputSha256 = await sha(input);
  const started = performance.now();
  const output = refreshTimeWarpPowerSnapshot(input);
  const milliseconds = performance.now() - started;
  const raw = JSON.stringify(output);
  const bytes = new TextEncoder().encode(raw);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const inputUnchanged = await sha(input) === inputSha256;
  if (!inputUnchanged) throw new Error("Power snapshot changed its immutable source");
  const ordinary = advanceSimulation(setTimeWarpEnabled(output, false), 1);
  return { milliseconds, fullStateJsonLength: raw.length,
    fullStateSha256: [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join(""),
    entities: output.entities.length, belts: output.belts.length, timeWarp: output.timeWarp,
    inputSha256, inputUnchanged, ordinaryAfterSnapshotSha256: await sha(ordinary),
    sharedEntities: output.entities.filter((entity, index) => entity === input.entities[index]).length,
    sharedBelts: output.belts === input.belts };
}

Object.assign(globalThis, { runPowerSnapshotProbe });
