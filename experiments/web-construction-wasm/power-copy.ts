import * as engine from "../../src/game/engine";
import { yieldSaveTransferWork } from "../../src/game/saveTransferDecode";
import type { GameState } from "../../src/game/types";

async function stateHash(state: GameState): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(state))))]
    .map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function runPowerCopyProbe(copyMode: "sync" | "chunked") {
  if (copyMode !== "sync" && copyMode !== "chunked") throw new Error("Unknown power copy mode");
  const source = (await (await fetch("/prepared.json")).json()).state as GameState;
  const controller = source.entities.find((entity) => entity.id === source.timeWarp.controllerEntityId &&
    entity.buildingId === "time_warp_device") ?? source.entities.find((entity) => entity.buildingId === "time_warp_device");
  if (!controller) throw new Error("No time-warp controller");
  source.timeWarp.controllerEntityId = controller.id;
  source.timeWarp.enabled = false;
  source.timeWarp.requestedMultiplier = 8;
  const input = engine.setTimeWarpEnabled(engine.setPaused(source, false), true);
  const inputSha256 = await stateHash(input);
  const chunked = Reflect.get(engine, "refreshTimeWarpPowerSnapshot" + "Chunked") as
    undefined | typeof engine.refreshTimeWarpPowerSnapshotChunked;
  if (copyMode === "chunked" && !chunked) throw new Error("Referenced runtime has no chunked copy");
  let previous = performance.now(), maxTimerGapMs = 0, timerCallbacks = 0, yields = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxTimerGapMs = Math.max(maxTimerGapMs, now - previous);
    previous = now;
    timerCallbacks++;
  }, 1);
  let output: GameState;
  let milliseconds: number;
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const started = performance.now();
    output = copyMode === "sync" ? engine.refreshTimeWarpPowerSnapshot(input)
      : await chunked!(input, { yieldControl: () => { yields++; return yieldSaveTransferWork(); } });
    milliseconds = performance.now() - started;
    // Let the already scheduled timer observe the final blocked task too.
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally { clearInterval(timer); }
  const fullStateSha256 = await stateHash(output);
  const inputUnchanged = inputSha256 === await stateHash(input);
  if (!inputUnchanged) throw new Error("Power snapshot mutated its immutable source");
  const ordinary = engine.advanceSimulation(engine.setTimeWarpEnabled(output, false), 1);
  return { probeKind: "isolated-power-copy-with-timer-response", copyMode, milliseconds, maxTimerGapMs,
    timerCallbacks, yields, entities: output.entities.length, belts: output.belts.length,
    fullStateSha256, inputSha256, inputUnchanged, ordinaryAfterSnapshotSha256: await stateHash(ordinary),
    sharedEntities: output.entities.filter((entity, index) => entity === input.entities[index]).length,
    sharedBelts: output.belts === input.belts };
}

Object.assign(globalThis, { runPowerCopyProbe });
