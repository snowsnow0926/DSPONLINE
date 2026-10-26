import { refreshTimeWarpPowerSnapshot, setPaused, setTimeWarpEnabled } from "../../src/game/engine";
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
  const started = performance.now();
  const output = refreshTimeWarpPowerSnapshot(input);
  const milliseconds = performance.now() - started;
  const raw = JSON.stringify(output);
  const bytes = new TextEncoder().encode(raw);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return { milliseconds, fullStateJsonLength: raw.length,
    fullStateSha256: [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join(""),
    entities: output.entities.length, belts: output.belts.length, timeWarp: output.timeWarp };
}

Object.assign(globalThis, { runPowerSnapshotProbe });
