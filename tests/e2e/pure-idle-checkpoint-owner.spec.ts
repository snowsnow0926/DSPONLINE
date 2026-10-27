import { expect, test } from "@playwright/test";

test("one frozen upload writes recovery and reuses the same Worker for an identical primary", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { createInitialState } = await import("/src/game/engine.ts");
    const { createPureIdleRecovery, readPureIdleRecovery, clearPureIdleRecovery } = await import("/src/game/pureIdleRecovery.ts");
    const { PureIdleCheckpointOwner } = await import("/src/game/pureIdleCheckpointOwnerClient.ts");
    const { serializeAuthoritativePrimarySaveInWorker } = await import("/src/game/authoritativeSaveSerializationClient.ts");
    const state = createInitialState(20261027, false);
    state.settings.autosaveIntervalSeconds = 0;
    const snapshot = JSON.stringify(state);
    const baseline = await serializeAuthoritativePrimarySaveInWorker(state, { savedAt: 1_800_000_000_000, compressTransport: false });
    const NativeWorker = window.Worker;
    const counts = { owners: 0, ordinarySaveWorkers: 0, begins: 0, serialized: 0 };
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (options?.name === "pure-idle-checkpoint-owner") counts.owners++;
        if (options?.name === "authoritative-save-serialization") counts.ordinarySaveWorkers++;
      }
      postMessage(message: unknown, options?: Transferable[] | StructuredSerializeOptions): void {
        const request = message as { type?: string };
        if (request.type === "state-begin") counts.begins++;
        if (request.type === "recovery-serialize") counts.serialized++;
        if (Array.isArray(options)) super.postMessage(message, options); else super.postMessage(message, options);
      }
    };
    const abort = new AbortController();
    const claim = await createPureIdleRecovery(state, "replication", 1_800_000_000_000, "shared-owner", 1_800_000_000_000, true,
      (source, ticket) => new PureIdleCheckpointOwner(source, ticket, { isCurrent: () => true, signal: abort.signal }).ready);
    if (!claim.ok) throw Error(claim.message);
    try {
      const written = await readPureIdleRecovery();
      const shared = await serializeAuthoritativePrimarySaveInWorker(state, {
        savedAt: 1_800_000_000_000, compressTransport: false, frozenStateIsCurrent: () => true,
      });
      const after = await readPureIdleRecovery();
      const sha = async (bytes: ArrayBuffer) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].join(",");
      return { counts, unchanged: JSON.stringify(state) === snapshot,
        journalEqual: JSON.stringify(written!.state) === snapshot && JSON.stringify(after!.state) === snapshot,
        bytesEqual: await sha(baseline.bytes) === await sha(shared.bytes),
        proofEqual: baseline.proof.payloadSha256 === shared.proof.payloadSha256 };
    } finally { abort.abort(); await clearPureIdleRecovery(claim.record.sessionId, claim.record.ownerToken); }
  });
  expect(result).toEqual({ counts: { owners: 1, ordinarySaveWorkers: 0, begins: 1, serialized: 1 },
    unchanged: true, journalEqual: true, bytesEqual: true, proofEqual: true });
});

for (const replacement of ["empty-takeover", "new-session"] as const) test(`stale upload cannot overwrite ${replacement}`, async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async replacement => {
    const { createInitialState } = await import("/src/game/engine.ts");
    const recovery = await import("/src/game/pureIdleRecovery.ts");
    const state = createInitialState(20261027, false);
    let allow!: () => void; let notify!: () => void;
    const gate = new Promise<void>(resolve => { allow = resolve; });
    const captured = new Promise<void>(resolve => { notify = resolve; });
    const pending = recovery.createPureIdleRecovery(state, "stable", 1000, "same-page-owner", 1000, false, async (source, ticket) => {
      notify(); await gate; await recovery.writePureIdleRecoveryCheckpoint(source, ticket);
    }).then(() => false, error => String(error).includes("写入权"));
    await captured;
    let replacementId: string | null = null;
    if (replacement === "empty-takeover") {
      const taken = await recovery.finalizePureIdleRecoveryForLocalTakeover("new-owner", 1100);
      if (!taken.ok) throw Error(taken.message);
    } else {
      const next = createInitialState(9, false); next.tray.iron_ingot = 777;
      const created = await recovery.createPureIdleRecovery(next, "stable", 1100, "same-page-owner", 1100);
      if (!created.ok) throw Error(created.message);
      replacementId = created.record.sessionId;
    }
    allow();
    const rejected = await pending;
    const retained = await recovery.readPureIdleRecovery();
    return { rejected, replacementKept: replacement === "empty-takeover" ? retained === null :
      retained?.sessionId === replacementId && retained.state.tray.iron_ingot === 777 };
  }, replacement);
  expect(result).toEqual({ rejected: true, replacementKept: true });
  if (replacement === "new-session") {
    const contender = await page.context().newPage();
    try {
      await contender.goto("/");
      const blocked = await contender.evaluate(async () => {
        const recovery = await import("/src/game/pureIdleRecovery.ts");
        // The synthetic heartbeat expired decades before now. Only the newer
        // same-page session's retained Web Lock can reject this foreign claim.
        const claim = await recovery.claimPureIdleRecovery("foreign-after-failed-create");
        return !claim.ok && claim.reason === "owned";
      });
      expect(blocked).toBe(true);
    } finally { await contender.close(); }
  }
});

for (const failure of ["abort", "timeout", "lost-ack", "crash", "quota"] as const) test(`${failure} retires the Worker and permits a clean retry`, async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async failure => {
    const { createInitialState } = await import("/src/game/engine.ts");
    const { createPureIdleRecovery, readPureIdleRecovery, clearPureIdleRecovery } = await import("/src/game/pureIdleRecovery.ts");
    const { PureIdleCheckpointOwner } = await import("/src/game/pureIdleCheckpointOwnerClient.ts");
    const state = createInitialState(20261027, false); const snapshot = JSON.stringify(state);
    const NativeWorker = window.Worker; let inject = true; let terminations = 0;
    let faultWorker: Worker | null = null;
    let release!: () => void; let notify!: () => void;
    const blocked = new Promise<void>(resolve => { notify = resolve; });
    window.Worker = class extends NativeWorker {
      private targeted: boolean;
      constructor(url: string | URL, options?: WorkerOptions) {
        const targeted = inject && options?.name === "pure-idle-checkpoint-owner";
        const workerUrl = targeted && failure === "quota" ? URL.createObjectURL(new Blob([
          `import ${JSON.stringify(new URL(url, location.href).href)};
          const put = IDBObjectStore.prototype.put;
          IDBObjectStore.prototype.put = function(value, ...rest) {
            if (value?.key === 'checkpoint') throw new DOMException('injected recovery quota', 'QuotaExceededError');
            return put.call(this, value, ...rest);
          };`,
        ], { type: "text/javascript" })) : url;
        super(workerUrl, options); this.targeted = targeted;
        if (targeted) faultWorker = this;
        if (workerUrl !== url) this.addEventListener("message", () => URL.revokeObjectURL(String(workerUrl)), { once: true });
        if (this.targeted && failure === "quota") this.addEventListener("message", event => { if (event.data.error) notify(); });
        if (this.targeted && failure === "lost-ack") this.addEventListener("message", event => {
          if (event.data.recoveryCheckpointReady) { event.stopImmediatePropagation(); notify(); }
        });
      }
      postMessage(message: unknown, options?: Transferable[] | StructuredSerializeOptions): void {
        const send = () => Array.isArray(options) ? super.postMessage(message, options) : super.postMessage(message, options);
        if (this.targeted && failure !== "lost-ack" && failure !== "quota" && (message as { type?: string }).type === "state-begin") {
          this.targeted = false; release = send; notify(); return;
        }
        send();
      }
      terminate(): void { terminations++; super.terminate(); }
    };
    const abort = new AbortController();
    const pending = createPureIdleRecovery(state, "stable", 1000, "failure-owner", 1000, false,
      (source, ticket) => new PureIdleCheckpointOwner(source, ticket, {
        isCurrent: () => true, signal: abort.signal, timeoutMs: failure === "timeout" ? 700 : 5000,
      }).ready).then(() => false, () => true);
    await blocked;
    if (failure === "abort" || failure === "lost-ack") abort.abort();
    if (failure === "crash") {
      // A live Worker channel emits the same error consumed by the production
      // client; no primary/recovery data is changed by this fault injection.
      (faultWorker as Worker | null)?.dispatchEvent(new ErrorEvent("error", { message: "injected recovery crash" }));
    }
    const rejected = await pending;
    release?.(); inject = false;
    const noOrphan = await readPureIdleRecovery() === null;
    const nextAbort = new AbortController();
    const retry = await createPureIdleRecovery(state, "stable", 2000, "retry-owner", 2000, false,
      (source, ticket) => new PureIdleCheckpointOwner(source, ticket, { isCurrent: () => true, signal: nextAbort.signal }).ready);
    const success = retry.ok;
    nextAbort.abort();
    if (retry.ok) await clearPureIdleRecovery(retry.record.sessionId, retry.record.ownerToken);
    return { rejected, noOrphan, success, unchanged: JSON.stringify(state) === snapshot, terminated: terminations >= 2 };
  }, failure);
  expect(result).toEqual({ rejected: true, noOrphan: true, success: true, unchanged: true, terminated: true });
});

test("the primary writer fence also rejects a legacy takeover that wrote no recovery fence", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { createInitialState } = await import("/src/game/engine.ts");
    const local = await import("/src/game/localSaveStore.ts");
    const coordination = await import("/src/game/localSaveCoordination.ts");
    const recovery = await import("/src/game/pureIdleRecovery.ts");
    await local.initializeLocalSaveStore();
    const owner = local.getLocalSaveWriterStatus();
    if (owner.role !== "primary") throw Error("test writer unavailable");
    const state = createInitialState(20261027, false);
    let notify!: () => void; let release!: () => void;
    const captured = new Promise<void>(resolve => { notify = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const pending = recovery.createPureIdleRecovery(state, "stable", 1000, "pending-owner", 1000, false, async (source, ticket) => {
      notify(); await gate;
      await recovery.writePureIdleRecoveryCheckpoint(source, { ...ticket,
        primaryWriterFence: { ownerId: owner.writerId, fencingToken: owner.fencingToken } });
    }).then(() => false, error => String(error).includes("主存档写入权"));
    await captured;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("dsp-idle-network.local-saves", 2);
      open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
    });
    const tx = db.transaction("records", "readwrite"); const store = tx.objectStore("records");
    const request = store.get(coordination.LOCAL_SAVE_WRITER_LEASE_KEY);
    request.onsuccess = () => {
      const row = request.result; const lease = JSON.parse(row.value);
      store.put({ ...row, value: JSON.stringify({ ...lease, ownerId: "legacy-new-owner", fencingToken: lease.fencingToken + 1 }) });
    };
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    db.close(); release();
    return { rejected: await pending, noOrphan: await recovery.readPureIdleRecovery() === null };
  });
  expect(result).toEqual({ rejected: true, noOrphan: true });
});

test("a second-record failure rolls back the checkpoint and preserves the previous journal", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { createInitialState } = await import("/src/game/engine.ts");
    const recovery = await import("/src/game/pureIdleRecovery.ts");
    const original = createInitialState(20261027, false);
    const previous = await recovery.createPureIdleRecovery(original, "stable", 1000, "atomic-owner", 1000);
    if (!previous.ok) throw Error(previous.message);
    const prior = JSON.stringify(await recovery.readPureIdleRecovery());
    const next = createInitialState(5, false); next.tray.iron_ingot = 999;
    const put = IDBObjectStore.prototype.put;
    let rejected = false;
    try {
      await recovery.createPureIdleRecovery(next, "stable", 2000, "atomic-owner", 2000, false, async (state, ticket) => {
        IDBObjectStore.prototype.put = function(value, ...rest) {
          if (this.transaction.db.name === "dsp-idle-network.pure-idle-recovery" && value?.key === "heartbeat") {
            throw new DOMException("injected second-record failure", "QuotaExceededError");
          }
          return put.call(this, value, ...rest);
        };
        try { await recovery.writePureIdleRecoveryCheckpoint(state, ticket); }
        finally { IDBObjectStore.prototype.put = put; }
      });
    } catch { rejected = true; }
    finally { IDBObjectStore.prototype.put = put; }
    return { rejected, oldJournalUnchanged: JSON.stringify(await recovery.readPureIdleRecovery()) === prior };
  });
  expect(result).toEqual({ rejected: true, oldJournalUnchanged: true });
});
