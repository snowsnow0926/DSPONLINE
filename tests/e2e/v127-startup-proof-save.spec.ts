import { expect, test, type Page } from "@playwright/test";

async function openSavePage(page: Page) {
  await page.route("**/__startup_proof_save.html", route => route.fulfill({
    contentType: "text/html; charset=utf-8",
    body: '<!doctype html><script type="module" src="/@vite/client"></script><body>Startup save</body>',
  }));
  await page.goto("/__startup_proof_save.html");
}

for (const mode of ["normal", "speedrun"] as const) {
  test(`cloned ${mode} startup state preserves exact envelope, runtime transfer, backup and retry`, async ({ page }) => {
    await openSavePage(page);
    const result = await page.evaluate(async mode => {
      const engine = await import("/src/game/engine.ts");
      const storage = await import("/src/game/storage.ts");
      const local = await import("/src/game/localSaveStore.ts");
      const serialization = await import("/src/game/authoritativeSaveSerializationClient.ts");
      const protocol = await import("/src/game/simulationRuntimeProtocol.ts");
      const compression = await import("/src/game/savePayloadCompression.ts");
      const state = mode === "normal" ? engine.createInitialState(44_127)
        : engine.createSpeedrunInitialState(1_700_000_000_000, "startup_proof_save_001");
      state.elapsedSeconds = 600;
      state.entities[0].inputs.iron_ore = 137;
      const original = JSON.stringify(state);
      const savedAt = 1_786_700_000_000;
      const expectedStateIdentity = {
        mode: state.mode, version: state.version, activePlanetId: state.activePlanetId,
        entityCount: state.entities.length, beltCount: state.belts.length, elapsedSeconds: state.elapsedSeconds,
      };
      const serialized = await serialization.serializeAuthoritativeSaveStateInWorker(state, { savedAt, expectedStateIdentity });
      const bytes = await compression.decodeSavePayloadTransport(serialized.bytes, serialized.proof.transportEncoding);
      const raw = new TextDecoder().decode(bytes);
      const recovered = protocol.deserializeSimulationStateTransfer({
        protocolVersion: protocol.SIMULATION_RUNTIME_PROTOCOL_VERSION,
        buffer: serialized.sourceStateTransfer, byteLength: serialized.sourceStateTransfer.byteLength,
      });
      const exactEnvelope = raw === storage.serializeEnvelope(state, savedAt);
      const exactRuntime = JSON.stringify(recovered) === original;
      let rejectsIdentity = false;
      try {
        await serialization.serializeAuthoritativeSaveStateInWorker(state, {
          savedAt, expectedStateIdentity: { ...expectedStateIdentity, elapsedSeconds: 601 },
        });
      } catch { rejectsIdentity = true; }

      await local.initializeLocalSaveStore();
      const previous = { ...state, elapsedSeconds: 0 };
      const seeded = await storage.saveGameVerified(previous);
      if (!seeded.success) throw new Error("seed primary failed");
      const primaryKey = mode === "normal" ? "dsp-idle-network.save.v1" : "dsp-idle-network.save.v1.speedrun";
      const backupKey = mode === "normal" ? "dsp-idle-network.save.v1.backup" : "dsp-idle-network.save.v1.backup.speedrun";
      const oldRaw = await local.readPersistedLocalSaveValue(primaryKey);
      const oldRevision = local.getPrimaryLocalSaveRevision(mode);
      const OriginalWorker = window.Worker;
      window.Worker = class extends OriginalWorker {
        constructor(url: string | URL, options?: WorkerOptions) {
          if (options?.name === "authoritative-save-serialization") throw new Error("controlled startup Worker failure");
          super(url, options);
        }
      };
      const failed = await storage.saveGameVerified(state, undefined, undefined, { preferWorkerProof: true });
      window.Worker = OriginalWorker;
      const failurePreserved = !failed.success && await local.readPersistedLocalSaveValue(primaryKey) === oldRaw &&
        local.getPrimaryLocalSaveRevision(mode) === oldRevision;
      const calls = { parse: 0, stringify: 0, encode: 0 };
      const originalParse = JSON.parse;
      const originalStringify = JSON.stringify;
      const originalEncode = TextEncoder.prototype.encode;
      const payloadThreshold = Math.max(16_384, Math.floor((oldRaw?.length ?? 0) / 2));
      const workerNames: string[] = [];
      window.Worker = class extends OriginalWorker {
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options); workerNames.push(options?.name ?? "");
        }
      };
      JSON.parse = ((value: string, ...args: unknown[]) => {
        if (typeof value === "string" && value.length >= payloadThreshold) calls.parse++;
        return originalParse(value, ...args);
      }) as typeof JSON.parse;
      JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
        const value = originalStringify(...args);
        if (value?.length >= payloadThreshold) calls.stringify++;
        return value;
      }) as typeof JSON.stringify;
      TextEncoder.prototype.encode = function(value?: string) {
        if (value && value.length >= payloadThreshold) calls.encode++;
        return originalEncode.call(this, value);
      };
      let saved;
      let duplicate;
      try {
        const first = storage.saveGameVerified(state, undefined, undefined, { preferWorkerProof: true });
        const second = storage.saveGameVerified(state);
        saved = await first;
        duplicate = await second;
      } finally {
        JSON.parse = originalParse; JSON.stringify = originalStringify;
        TextEncoder.prototype.encode = originalEncode; window.Worker = OriginalWorker;
      }
      const primaryRaw = await local.readPersistedLocalSaveValue(primaryKey);
      const backupRaw = await local.readPersistedLocalSaveValue(backupKey);
      const expectedRaw = storage.serializeEnvelope(state, saved.savedAt);
      const repeated = await storage.saveGameVerified(state, undefined, undefined, { preferWorkerProof: true });
      return {
        exactEnvelope, exactRuntime, rejectsIdentity, failurePreserved,
        callerUnchanged: JSON.stringify(state) === original,
        saved: saved.success, duplicate: duplicate.success,
        exactPrimary: primaryRaw === expectedRaw, exactBackup: backupRaw === oldRaw,
        revisionDelta: local.getPrimaryLocalSaveRevision(mode) - oldRevision,
        repeatedUnchanged: repeated.skippedUnchanged, calls,
        proofWorker: workerNames.includes("authoritative-save-serialization"),
      };
    }, mode);
    expect(result).toEqual({
      exactEnvelope: true, exactRuntime: true, rejectsIdentity: true, failurePreserved: true,
      callerUnchanged: true, saved: true, duplicate: true, exactPrimary: true, exactBackup: true,
      revisionDelta: 1, repeatedUnchanged: true,
      calls: { parse: 0, stringify: 0, encode: 0 }, proofWorker: true,
    });
  });
}
