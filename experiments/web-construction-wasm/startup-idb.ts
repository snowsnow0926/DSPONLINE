import { parseTrustedWorkerEnvelope } from "../../src/game/storage";
import { serializeSaveEnvelopeToTransfer, decodeVerifiedSaveTransfer } from "../../src/game/saveTransfer";
import { createPureIdleRecovery, readPureIdleRecovery } from "../../src/game/pureIdleRecovery";
import { refreshTimeWarpPowerSnapshot, setPaused, setTimeWarpEnabled } from "../../src/game/engine";
import { beginIdleRun } from "../../src/game/idleSettlement";
import { yieldSaveTransferWork } from "../../src/game/saveTransferDecode";
import type { GameState } from "../../src/game/types";

const hash = async (value: unknown) => [...new Uint8Array(await crypto.subtle.digest("SHA-256",
  new TextEncoder().encode(JSON.stringify(value))))].map(byte => byte.toString(16).padStart(2, "0")).join("");

export async function runStartupIdbProbe(mode: string) {
  if (!["main", "worker-chunks", "worker-ack"].includes(mode)) throw Error("Invalid IDB mode");
  const initial: GameState = (await (await fetch("/prepared.json")).json()).state;
  const transfer = serializeSaveEnvelopeToTransfer(initial, { formatVersion: 2, savedAt: 1_800_000_000_000,
    kind: "primary", slot: "main", mode: initial.mode });
  const verification = { integrity: "valid" as const, stateChecksum: transfer.stateChecksum,
    payloadChecksum: transfer.payloadChecksum, byteLength: transfer.byteLength };
  const canonical = parseTrustedWorkerEnvelope(decodeVerifiedSaveTransfer(transfer.bytes, verification), verification);
  canonical.timeWarp.enabled = false; canonical.timeWarp.requestedMultiplier = 8;
  const controller = canonical.entities.find(entity => entity.buildingId === "time_warp_device");
  if (!controller) throw Error("Missing controller");
  canonical.timeWarp.controllerEntityId = controller.id;
  const state = refreshTimeWarpPowerSnapshot(setTimeWarpEnabled(setPaused(canonical, false), true));
  state.timeWarp = { ...state.timeWarp, pendingWallSeconds: 0, pendingSimulationSeconds: 0 };
  state.idleSettlement = beginIdleRun(state.idleSettlement, 1_800_000_000_000);
  const before = await hash(state);
  const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  await frame(); await frame();
  const frames: number[] = [];
  let previous = performance.now(); let capture = true; let animation = 0;
  const tick = (now: number) => { if (capture) frames.push(now - previous); previous = now; animation = requestAnimationFrame(tick); };
  animation = requestAnimationFrame(tick);
  let worker: Worker | null = null;
  let pending: { resolve: (value: { stateSha256?: string }) => void; reject: (error: Error) => void } | null = null;
  let longestSendMs = 0;
  let transferMs = 0;
  let commitMs = 0;
  const send = (message: unknown) => new Promise<{ stateSha256?: string }>((resolve, reject) => {
    const timeout = setTimeout(() => { pending = null; reject(Error("IDB probe worker timeout")); }, 90_000);
    pending = { resolve: value => { clearTimeout(timeout); pending = null; resolve(value); },
      reject: error => { clearTimeout(timeout); pending = null; reject(error); } };
    const at = performance.now(); worker!.postMessage(message); longestSendMs = Math.max(longestSendMs, performance.now() - at);
  });
  const start = performance.now();
  try {
    if (mode === "main") {
      const result = await createPureIdleRecovery(state, "replication", 1_800_000_000_000, "isolated-idb-probe", 1_800_000_000_000, true);
      if (!result.ok) throw Error(result.message);
      commitMs = performance.now() - start;
    } else {
      worker = new Worker(new URL("./startup-idb.worker.ts", import.meta.url), { type: "module", name: "startup-idb-experiment" });
      worker.onmessage = ({ data }) => data.ok ? pending?.resolve(data) : pending?.reject(Error(data.error));
      worker.onerror = () => pending?.reject(Error("IDB probe worker crashed"));
      await send({ kind: "begin", topLevel: { ...state, entities: undefined, belts: undefined }, entities: state.entities.length, belts: state.belts.length });
      for (const collection of ["entities", "belts"] as const) {
        const count = collection === "entities" ? 512 : 2048;
        for (let offset = 0; offset < state[collection].length; offset += count) {
          await send({ kind: "records", collection, offset, records: state[collection].slice(offset, offset + count) });
          // Each ACK is already a separate Worker message task. This optional
          // experiment measures whether another timer yield improves fairness.
          if (mode === "worker-chunks") await yieldSaveTransferWork();
        }
      }
      transferMs = performance.now() - start;
      const commitStart = performance.now();
      await send({ kind: "store" });
      commitMs = performance.now() - commitStart;
    }
    const elapsedMs = performance.now() - start;
    await frame(); await frame(); capture = false; cancelAnimationFrame(animation);
    const storedSha256 = mode === "main" ? await hash((await readPureIdleRecovery())!.state) : (await send({ kind: "verify" })).stateSha256;
    const callerUnchanged = await hash(state) === before;
    if (!callerUnchanged || storedSha256 !== before) throw Error("Complete checkpoint state differs");
    return { scope: "Isolated checkpoint write including transfer; excludes preparation/hash and primary save. Not whole-game timing or memory qualification.",
      mode, elapsedMs, transferMs, commitMs, maximumFrameGapMs: Math.max(...frames), longestSendMs,
      stateSha256: before, storedSha256, callerUnchanged, entities: state.entities.length, belts: state.belts.length };
  } finally { capture = false; cancelAnimationFrame(animation); worker?.terminate(); }
}
Object.assign(globalThis, { runStartupIdbProbe });
