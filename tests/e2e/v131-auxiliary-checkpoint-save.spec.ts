import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/__auxiliary_checkpoint.html", (route) => route.fulfill({
    contentType: "text/html", body: "<!doctype html><body>isolated save test</body>",
  }));
  await page.goto("/__auxiliary_checkpoint.html");
});

for (const mode of ["normal", "speedrun"] as const) {
  test(`${mode} slots and manual snapshots reuse checkpoints with exact legacy bytes and independent primary`, async ({ page }) => {
    const result = await page.evaluate(async (mode) => {
      await import(/* @vite-ignore */ "/@vite/env");
      const engine: any = await import(/* @vite-ignore */ "/src/game/engine.ts");
      const storage: any = await import(/* @vite-ignore */ "/src/game/storage.ts");
      const store: any = await import(/* @vite-ignore */ "/src/game/localSaveStore.ts");
      const protocol: any = await import(/* @vite-ignore */ "/src/game/simulationRuntimeProtocol.ts");
      const state = engine.createInitialState(131);
      state.mode = mode;
      state.paused = true;
      state.settings.autosaveIntervalSeconds = 0;
      await store.initializeLocalSaveStore();
      const primaryKey = mode === "normal" ? "dsp-idle-network.save.v1" : "dsp-idle-network.save.v1.speedrun";
      store.setLocalSaveValue(primaryKey, storage.serializeEnvelope(state));
      await store.flushLocalSaveWrites();
      const primaryBefore = await store.readPersistedLocalSaveValue(primaryKey);
      const keysBefore = new Set(store.listLocalSaveKeys());
      state.entities[0].inputs.iron_ore = 137;
      const overlay = {
        planetViewports: [{ planetId: "home", viewport: { x: 240, y: -160, zoom: 1.25 } }],
        timeWarp: { pendingSimulationSeconds: 17, pendingWallSeconds: 11 },
      };
      const view = { ...state, planetViewports: { ...state.planetViewports, home: overlay.planetViewports[0].viewport },
        timeWarp: { ...state.timeWarp, ...overlay.timeWarp } };
      const calls: Array<{ name: string; clonedState: boolean; transfer: boolean }> = [];
      const NativeWorker = Worker;
      globalThis.Worker = class extends NativeWorker {
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          const original = this.postMessage.bind(this);
          this.postMessage = (message: any, transfers: any = []) => {
            calls.push({ name: options?.name ?? "", clonedState: Boolean(message?.state), transfer: Boolean(message?.stateTransfer) });
            original(message, transfers);
          };
        }
      };
      let slot;
      let snapshot;
      const slotTransfer = protocol.serializeSimulationStateForTransfer(state);
      const snapshotTransfer = protocol.serializeSimulationStateForTransfer(state);
      try {
        slot = await storage.saveGameSlotVerified(2, view, { stateTransfer: slotTransfer, checkpointOverlay: overlay });
        snapshot = await storage.saveGameSnapshotVerified(view, "手动快照", { stateTransfer: snapshotTransfer, checkpointOverlay: overlay });
      } finally { globalThis.Worker = NativeWorker; }
      const slotKey = mode === "normal" ? "dsp-idle-network.slot.2" : "dsp-idle-network.slot.speedrun.2";
      const snapshotKey = snapshot ? `dsp-idle-network.save.v1.snapshot.${mode === "speedrun" ? "speedrun." : ""}${snapshot.id}` : null;
      const rawSlot = await store.readPersistedLocalSaveValue(slotKey);
      const rawSnapshot = snapshotKey ? await store.readPersistedLocalSaveValue(snapshotKey) : null;
      const loadedSlot = storage.importGame(rawSlot, mode, 2);
      return {
        slot, snapshot,
        slotExact: rawSlot === storage.serializeEnvelope(view, slot.savedAt, "slot", undefined, undefined, 2),
        snapshotExact: rawSnapshot === storage.serializeEnvelope(view, snapshot?.savedAt, "snapshot", "手动快照"),
        primaryUnchanged: primaryBefore === await store.readPersistedLocalSaveValue(primaryKey),
        extraPayloads: store.listLocalSaveKeys().filter((key: string) => !keysBefore.has(key) && !key.endsWith(".sequence")),
        calls,
        restoredBuffers: slotTransfer.buffer.byteLength > 0 && snapshotTransfer.buffer.byteLength > 0,
        slotCatalog: store.getLocalSaveCatalog(slotKey),
        loaded: { iron: loadedSlot?.entities[0].inputs.iron_ore, viewport: loadedSlot?.planetViewports.home,
          pending: loadedSlot?.timeWarp.pendingSimulationSeconds, autosave: loadedSlot?.settings.autosaveIntervalSeconds },
      };
    }, mode);
    expect(result.slot.success).toBe(true);
    expect(result.snapshot).toMatchObject({ valid: true, reason: "手动快照", mode });
    expect(result).toMatchObject({ slotExact: true, snapshotExact: true, primaryUnchanged: true, restoredBuffers: true,
      loaded: { iron: 137, viewport: { x: 240, y: -160, zoom: 1.25 }, pending: 17, autosave: 0 } });
    expect(result.slotCatalog).toMatchObject({ kind: "slot", mode, slot: 2, integrity: "valid" });
    expect(result.extraPayloads).toHaveLength(2);
    expect(result.calls.filter((call) => call.transfer)).toHaveLength(2);
    expect(result.calls.some((call) => call.clonedState)).toBe(false);
  });
}

test("invalid checkpoint identity cannot overwrite an existing slot or fall back to another state", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await import(/* @vite-ignore */ "/@vite/env");
    const engine: any = await import(/* @vite-ignore */ "/src/game/engine.ts");
    const storage: any = await import(/* @vite-ignore */ "/src/game/storage.ts");
    const store: any = await import(/* @vite-ignore */ "/src/game/localSaveStore.ts");
    const protocol: any = await import(/* @vite-ignore */ "/src/game/simulationRuntimeProtocol.ts");
    const state = engine.createInitialState();
    await store.initializeLocalSaveStore();
    const initial = await storage.saveGameSlotVerified(1, state);
    if (!initial.success) throw new Error(initial.message);
    const key = "dsp-idle-network.slot.1";
    const before = await store.readPersistedLocalSaveValue(key);
    state.entities[0].inputs.iron_ore = 999;
    const badIdentity = { mode: state.mode, version: state.version, activePlanetId: state.activePlanetId,
      entityCount: state.entities.length + 1, beltCount: state.belts.length, elapsedSeconds: state.elapsedSeconds };
    const failed = await storage.saveGameSlotVerified(1, state, {
      stateTransfer: protocol.serializeSimulationStateForTransfer(state), expectedStateIdentity: badIdentity,
    });
    const snapshot = await storage.saveGameSnapshotVerified(state, "手动快照", {
      stateTransfer: protocol.serializeSimulationStateForTransfer(state), expectedStateIdentity: badIdentity,
    });
    return { failed: !failed.success, unchanged: before === await store.readPersistedLocalSaveValue(key), snapshot,
      snapshots: store.listLocalSaveKeys().filter((key: string) => key.includes(".snapshot.") && !key.endsWith(".sequence")) };
  });
  expect(result).toEqual({ failed: true, unchanged: true, snapshot: null, snapshots: [] });
});

test("a chunk-reassembled UI mirror and its original checkpoint preserve identical state values", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await import(/* @vite-ignore */ "/@vite/env");
    const engine: any = await import(/* @vite-ignore */ "/src/game/engine.ts");
    const storage: any = await import(/* @vite-ignore */ "/src/game/storage.ts");
    const store: any = await import(/* @vite-ignore */ "/src/game/localSaveStore.ts");
    const protocol: any = await import(/* @vite-ignore */ "/src/game/simulationRuntimeProtocol.ts");
    const proof: any = await import(/* @vite-ignore */ "/src/game/authoritativeSaveProof.ts");
    await store.initializeLocalSaveStore();
    const state = engine.createInitialState();
    const transfer = protocol.serializeSimulationStateForTransfer(state);
    // Large checkpoints stream these arrays separately and append them last.
    const { entities, belts, ...base } = state;
    const mirror = { ...base, entities, belts };
    const saved = await storage.saveGameSlotVerified(1, mirror, { stateTransfer: transfer });
    const raw = await store.readPersistedLocalSaveValue("dsp-idle-network.slot.1");
    const legacy = storage.serializeEnvelope(mirror, saved.savedAt, "slot", undefined, undefined, 1);
    return { success: saved.success, valid: storage.inspectSave(raw).valid,
      sameState: proof.canonicalAuthoritativeSaveJson(JSON.parse(raw).state) === proof.canonicalAuthoritativeSaveJson(JSON.parse(legacy).state) };
  });
  expect(result).toEqual({ success: true, valid: true, sameState: true });
});

test("compatibility fallback keeps the caller's checkpoint intact when Workers are unavailable", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await import(/* @vite-ignore */ "/@vite/env");
    const engine: any = await import(/* @vite-ignore */ "/src/game/engine.ts");
    const storage: any = await import(/* @vite-ignore */ "/src/game/storage.ts");
    const store: any = await import(/* @vite-ignore */ "/src/game/localSaveStore.ts");
    const protocol: any = await import(/* @vite-ignore */ "/src/game/simulationRuntimeProtocol.ts");
    await store.initializeLocalSaveStore();
    const state = engine.createInitialState();
    const transfer = protocol.serializeSimulationStateForTransfer(state);
    const bytes = transfer.buffer.byteLength;
    const NativeWorker = Worker;
    let saved;
    try {
      (globalThis as any).Worker = undefined;
      saved = await storage.saveGameSlotVerified(3, state, { stateTransfer: transfer });
    } finally { globalThis.Worker = NativeWorker; }
    return { success: saved.success, sameBufferLength: transfer.buffer.byteLength === bytes,
      valid: storage.inspectSave(await store.readPersistedLocalSaveValue("dsp-idle-network.slot.3")).valid };
  });
  expect(result).toEqual({ success: true, sameBufferLength: true, valid: true });
});

test("raw transport preserves envelope validation and Blob transport keeps compression", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await import(/* @vite-ignore */ "/@vite/env");
    const engine: any = await import(/* @vite-ignore */ "/src/game/engine.ts");
    const storage: any = await import(/* @vite-ignore */ "/src/game/storage.ts");
    const protocol: any = await import(/* @vite-ignore */ "/src/game/simulationRuntimeProtocol.ts");
    const serializer: any = await import(/* @vite-ignore */ "/src/game/authoritativeSaveSerializationClient.ts");
    const transfers: any = await import(/* @vite-ignore */ "/src/game/saveTransfer.ts");
    const compression: any = await import(/* @vite-ignore */ "/src/game/savePayloadCompression.ts");
    const state = engine.createInitialState();
    const options = { savedAt: 123456, compressTransport: false };
    const raw = await serializer.serializeAuthoritativeSaveStateTransferInWorker(
      protocol.serializeSimulationStateForTransfer(state), options);
    const source = transfers.serializeSaveEnvelopeToTransfer(state,
      { formatVersion: 2, savedAt: 123456, kind: "primary", slot: "main", mode: state.mode });
    const blob = await serializer.serializeAuthoritativeSaveEnvelopeTransferInWorker({
      buffer: new Blob([source.bytes]), byteLength: source.byteLength, stateChecksum: source.stateChecksum,
      payloadChecksum: source.payloadChecksum, integrity: "valid",
    }, options);
    const decodedBlob = await compression.decodeSavePayloadTransport(await blob.bytes.arrayBuffer(), blob.proof.transportEncoding);
    return { rawEncoding: raw.proof.transportEncoding, rawLengthMatches: raw.bytes.byteLength === raw.proof.byteLength,
      rawValid: storage.inspectSave(new TextDecoder().decode(raw.bytes)).valid,
      blobEncoding: blob.proof.transportEncoding, isBlob: blob.bytes instanceof Blob,
      blobValid: storage.inspectSave(new TextDecoder().decode(decodedBlob)).valid };
  });
  expect(result).toEqual({ rawEncoding: "raw", rawLengthMatches: true, rawValid: true,
    blobEncoding: "gzip", isBlob: true, blobValid: true });
});

test("raw persistence checks actual bytes and rejects forged SHA proofs before replacing a slot", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await import(/* @vite-ignore */ "/@vite/env");
    const engine: any = await import(/* @vite-ignore */ "/src/game/engine.ts");
    const storage: any = await import(/* @vite-ignore */ "/src/game/storage.ts");
    const store: any = await import(/* @vite-ignore */ "/src/game/localSaveStore.ts");
    const protocol: any = await import(/* @vite-ignore */ "/src/game/simulationRuntimeProtocol.ts");
    const serializer: any = await import(/* @vite-ignore */ "/src/game/authoritativeSaveSerializationClient.ts");
    const proofApi: any = await import(/* @vite-ignore */ "/src/game/authoritativeSaveProof.ts");
    await store.initializeLocalSaveStore();
    const state = engine.createInitialState();
    if (!(await storage.saveGameSlotVerified(1, state)).success) throw new Error("Cannot seed slot");
    const key = "dsp-idle-network.slot.1";
    const original = await store.readPersistedLocalSaveValue(key);
    state.entities[0].inputs.iron_ore = 123;
    const serialized = await serializer.serializeAuthoritativeSaveStateTransferInWorker(
      protocol.serializeSimulationStateForTransfer(state), { kind: "slot", slot: 1, compressTransport: false });
    const sourceBytes = serialized.bytes.slice(0);
    const writer = store.getLocalSaveWriterStatus();
    const request = { key, seed: serialized.catalogSeed, expectedRevision: store.getLocalSaveRevision(key),
      fence: { ownerId: writer.writerId, fencingToken: writer.fencingToken } };
    const { bindingSha256: _binding, ...baseProof } = serialized.proof;
    const forgedPartial = { ...baseProof, storedSha256: "0".repeat(64), payloadSha256: "0".repeat(64) };
    const forged = { ...forgedPartial,
      bindingSha256: await proofApi.computeAuthoritativeSaveProofBindingSha256(forgedPartial, serialized.catalogSeed) };
    const forgedResult = await store.setLocalSavePayloadWithProof({ ...request, bytes: sourceBytes.slice(0), proof: forged });
    const corruptedBytes = sourceBytes.slice(0);
    new Uint8Array(corruptedBytes)[0] ^= 1;
    const corruptResult = await store.setLocalSavePayloadWithProof({ ...request, bytes: corruptedBytes, proof: serialized.proof });
    const unchanged = original === await store.readPersistedLocalSaveValue(key);
    const committed = await store.setLocalSavePayloadWithProof({ ...request, bytes: sourceBytes, proof: serialized.proof });
    const loaded = storage.importGame(await store.readPersistedLocalSaveValue(key));
    return { forged: forgedResult.result, corrupt: corruptResult.result, unchanged,
      committed: committed.result.ok, iron: loaded?.entities[0].inputs.iron_ore };
  });
  expect(result.forged).toMatchObject({ ok: false, reason: "invalid" });
  expect(result.corrupt).toMatchObject({ ok: false, reason: "invalid" });
  expect(result).toMatchObject({ unchanged: true, committed: true, iron: 123 });
});
