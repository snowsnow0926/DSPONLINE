import { expect, test } from "@playwright/test";

test("persistence checkpoint returns exact transferable bytes without a full state mirror", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const engine = await import("/src/game/engine.ts");
    const packs = await import("/src/game/contentPacks.ts");
    const protocol = await import("/src/game/simulationRuntimeProtocol.ts");
    const registry = packs.createContentPackRuntimeSnapshot(packs.createContentPackRegistry());
    const state = engine.createInitialState(11_400);
    state.paused = false;
    state.elapsedSeconds = 12_345;
    state.entities[0].inputs.iron_ore = 77;
    const canonical = JSON.parse(JSON.stringify(state)) as typeof state;
    const worker = new Worker(new URL("/src/game/simulation.worker.ts", location.origin), { type: "module" });
    const request = (payload: Record<string, unknown>, transfer: Transferable[] = []) => new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = payload.id as number;
      const timeout = window.setTimeout(() => reject(new Error(`persistence checkpoint ${id} timed out`)), 15_000);
      const messages: Record<string, unknown>[] = [];
      const listener = (event: MessageEvent<Record<string, unknown>>) => {
        if (event.data.id !== id) return;
        messages.push(event.data);
        worker.removeEventListener("message", listener);
        window.clearTimeout(timeout);
        resolve({ final: event.data, messages });
      };
      worker.addEventListener("message", listener);
      worker.postMessage(payload, transfer);
    });
    const source = protocol.serializeSimulationStateForTransfer(canonical);
    const initialized = await request({
      id: 1,
      kind: "advance",
      stateTransfer: source,
      simulationSeconds: 0,
      wallSeconds: 0,
      registryFingerprint: registry.fingerprint,
      registry,
      protocol: "projection",
      stateRevision: 0,
    }, [source.buffer]) as { final: Record<string, unknown> };
    const response = await request({
      id: 2,
      kind: "checkpoint",
      checkpointIdentityOnly: true,
      simulationSeconds: 0,
      wallSeconds: 0,
      registryFingerprint: registry.fingerprint,
      protocol: "projection",
      stateRevision: initialized.final.stateRevision,
    }) as { final: Record<string, unknown>; messages: Record<string, unknown>[] };
    const transfer = response.final.checkpoint as import("../../src/game/simulationRuntimeProtocol").SimulationStateTransfer;
    const identity = protocol.validateSimulationStateTransferIdentity(
      transfer,
      response.final.checkpointIdentity as import("../../src/game/simulationRuntimeProtocol").SimulationStateIdentity,
    );
    const restored = protocol.deserializeSimulationStateTransfer(transfer);
    worker.terminate();
    return {
      messageCount: response.messages.length,
      hasStateMirror: response.messages.some((message) => "checkpointState" in message),
      hasStateChunks: response.messages.some((message) => "checkpointStateChunk" in message),
      identity,
      restoredElapsedSeconds: restored.elapsedSeconds,
      restoredInput: restored.entities[0].inputs.iron_ore,
    };
  });

  expect(result).toMatchObject({
    messageCount: 1,
    hasStateMirror: false,
    hasStateChunks: false,
    restoredElapsedSeconds: 12_345,
    restoredInput: 77,
    identity: {
      version: 47,
      mode: "normal",
      elapsedSeconds: 12_345,
      paused: false,
    },
  });
});
