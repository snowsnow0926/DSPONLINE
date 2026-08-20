import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const fixturePath = process.env.DSP_M1_REAL_FIXTURE;
const fixtureLabel = process.env.DSP_M1_FIXTURE_LABEL ?? "anonymous";

interface CommandTrace {
  id: number;
  submittedAt: number;
  responseAt?: number;
  secondPaintedAt?: number;
  workerDurationMs?: number;
  endToEndMs?: number;
  topLevelChanges: number;
  changedEntities: number;
  addedEntities: number;
  removedEntities: number;
  changedBelts: number;
  addedBelts: number;
  removedBelts: number;
  responseChanged?: boolean;
  responseBytes?: number;
}

async function commandTraces(page: Page): Promise<CommandTrace[]> {
  return page.evaluate(() => (
    window as typeof window & { __runtimeWorldM1?: { commands: CommandTrace[] } }
  ).__runtimeWorldM1?.commands ?? []);
}

async function waitForCommand(
  page: Page,
  afterCount: number,
  domain: "top-level" | "entity" | "belt",
  minimumRecords = 1,
): Promise<CommandTrace> {
  try {
    await expect.poll(async () => {
      const traces = await commandTraces(page);
      return traces.slice(afterCount).filter((trace) => {
        if (trace.secondPaintedAt === undefined) return false;
        if (domain === "entity") return trace.changedEntities + trace.addedEntities + trace.removedEntities >= minimumRecords;
        if (domain === "belt") return trace.changedBelts + trace.addedBelts + trace.removedBelts >= minimumRecords;
        return trace.topLevelChanges >= minimumRecords;
      }).length;
    }, { timeout: 30_000 }).toBeGreaterThan(0);
  } catch (error) {
    const observed = await commandTraces(page);
    throw new Error(`missing ${domain} command after ${afterCount}; observed=${JSON.stringify(observed.slice(afterCount))}`, { cause: error });
  }
  const traces = await commandTraces(page);
  const trace = traces.slice(afterCount).find((candidate) => {
    if (candidate.secondPaintedAt === undefined) return false;
    if (domain === "entity") return candidate.changedEntities + candidate.addedEntities + candidate.removedEntities >= minimumRecords;
    if (domain === "belt") return candidate.changedBelts + candidate.addedBelts + candidate.removedBelts >= minimumRecords;
    return candidate.topLevelChanges >= minimumRecords;
  });
  if (!trace) throw new Error(`missing ${domain} command trace after ${afterCount}`);
  return trace;
}

async function runDiagnosticCommand(
  page: Page,
  command: { kind: "entity-lock"; count: number; locked: boolean } |
    { kind: "belt-route"; count: number; routeMode: "upper" | "lower" },
) {
  const before = (await commandTraces(page)).length;
  const dispatch = await page.evaluate((request) => {
    const bridge = window.__DSP_RUNTIMEWORLD_BENCHMARK__;
    if (!bridge) throw new Error("RuntimeWorld benchmark bridge is unavailable");
    return bridge.execute(request);
  }, command);
  expect(dispatch.acceptedRecords).toBe(command.count);
  const trace = await waitForCommand(page, before, command.kind === "entity-lock" ? "entity" : "belt", command.count);
  return {
    dispatch,
    trace,
    actionToWorkerPostMs: trace.submittedAt - dispatch.actionAt,
    actionToSecondPaintMs: (trace.secondPaintedAt ?? trace.submittedAt) - dispatch.actionAt,
  };
}

test.describe("RuntimeWorld M-1 production browser baseline", () => {
  test.skip(!fixturePath, "requires DSP_M1_REAL_FIXTURE");

  test("real save covers load, run, commands, persistence, and second paint", async ({ page }) => {
    test.setTimeout(900_000);
    const originalRaw = readFileSync(fixturePath!, "utf8");
    const originalHash = createHash("sha256").update(originalRaw).digest("hex");
    const originalStat = statSync(fixturePath!);
    const sourceEnvelope = JSON.parse(originalRaw) as Record<string, unknown>;
    const sourceState = ((sourceEnvelope.state ?? sourceEnvelope) as {
      version?: number;
      entities?: unknown[];
      belts?: unknown[];
    });
    const seededRaw = JSON.stringify({ ...sourceEnvelope, savedAt: Date.now() });

    await page.addInitScript(() => {
      (window as typeof window & { __DSP_RUNTIME_TRANSITIONS__?: unknown }).__DSP_RUNTIME_TRANSITIONS__ = {
        enabled: true,
        events: [],
        active: {},
        counters: {},
      };
      localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-20-v1.1.1");
      localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
      localStorage.setItem("dsp-idle-network.onboarding.v1", "dismissed");
      localStorage.setItem("dsp-idle-network.ui.factory-alerts.v1", "false");
      localStorage.setItem("dsp-idle-network.canvas-performance-features.v1", JSON.stringify({
        renderProjection: true,
        topologyCache: true,
        extremeVisuals: true,
        nodeLod: true,
        canvasBelts: true,
        viewportCulling: true,
        spatialIndexes: true,
        minimapThrottle: true,
      }));
      try { Object.defineProperty(console, "timeStamp", { configurable: true, value: undefined }); } catch { /* optional browser API */ }

      const tracker: {
        commands: CommandTrace[];
        projectionResponses: number;
        fullStateResponses: number;
      } = { commands: [], projectionResponses: 0, fullStateResponses: 0 };
      (window as typeof window & { __runtimeWorldM1?: typeof tracker }).__runtimeWorldM1 = tracker;
      const NativeWorker = window.Worker;
      const WrappedWorker = new Proxy(NativeWorker, {
        construct(target, args) {
          const worker = Reflect.construct(target, args) as Worker;
          if (!String(args[0]).includes("simulation.worker") || (args[1] as WorkerOptions | undefined)?.name !== "factory-simulation") {
            return worker;
          }
          const traceById = new Map<number, CommandTrace>();
          const nativePostMessage = worker.postMessage.bind(worker);
          worker.postMessage = ((message: Record<string, unknown>, transferOrOptions?: Transferable[] | StructuredSerializeOptions) => {
            const command = message.command as {
              topLevelChanges?: unknown[];
              changedEntities?: unknown[];
              addedEntities?: unknown[];
              removedEntityIds?: unknown[];
              changedBelts?: unknown[];
              addedBelts?: unknown[];
              removedBeltIds?: unknown[];
            } | undefined;
            if (message.kind === "advance" && command) {
              const trace: CommandTrace = {
                id: Number(message.id),
                submittedAt: performance.now(),
                topLevelChanges: command.topLevelChanges?.length ?? 0,
                changedEntities: command.changedEntities?.length ?? 0,
                addedEntities: command.addedEntities?.length ?? 0,
                removedEntities: command.removedEntityIds?.length ?? 0,
                changedBelts: command.changedBelts?.length ?? 0,
                addedBelts: command.addedBelts?.length ?? 0,
                removedBelts: command.removedBeltIds?.length ?? 0,
              };
              tracker.commands.push(trace);
              traceById.set(trace.id, trace);
            }
            if (transferOrOptions === undefined) nativePostMessage(message);
            else nativePostMessage(message, transferOrOptions);
          }) as typeof worker.postMessage;
          worker.addEventListener("message", (event: MessageEvent<Record<string, unknown>>) => {
            if (event.data.protocol === "projection") tracker.projectionResponses += 1;
            if (event.data.state) tracker.fullStateResponses += 1;
            const trace = traceById.get(Number(event.data.id));
            if (!trace) return;
            trace.responseAt = performance.now();
            trace.workerDurationMs = typeof event.data.durationMs === "number" ? event.data.durationMs : undefined;
            trace.responseChanged = event.data.changed === true;
            trace.responseBytes = typeof event.data.transferBytes === "number" ? event.data.transferBytes : undefined;
            traceById.delete(trace.id);
            requestAnimationFrame(() => requestAnimationFrame((paintedAt) => {
              trace.secondPaintedAt = paintedAt;
              trace.endToEndMs = paintedAt - trace.submittedAt;
            }));
          });
          return worker;
        },
      });
      Object.defineProperty(window, "Worker", { configurable: true, writable: true, value: WrappedWorker });
    });

    await page.goto("/?storageMigration=production");
    const seeded = await page.evaluate(async (saveRaw) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("dsp-idle-network.local-saves", 2);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains("records")) request.result.createObjectStore("records", { keyPath: "key" });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const transaction = database.transaction("records", "readwrite");
      transaction.objectStore("records").put({
        key: "dsp-idle-network.save.v1",
        value: saveRaw,
        bytes: new Blob([saveRaw]).size,
        updatedAt: Date.now(),
      });
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error);
        transaction.onerror = () => reject(transaction.error);
      });
      const read = database.transaction("records", "readonly").objectStore("records").get("dsp-idle-network.save.v1");
      const persisted = await new Promise<string | null>((resolve, reject) => {
        read.onsuccess = () => resolve(typeof (read.result as { value?: unknown } | undefined)?.value === "string"
          ? (read.result as { value: string }).value
          : null);
        read.onerror = () => reject(read.error);
      });
      database.close();
      return { exact: persisted === saveRaw, bytes: persisted ? new Blob([persisted]).size : 0 };
    }, seededRaw);
    expect(seeded).toEqual({ exact: true, bytes: new Blob([seededRaw]).size });

    await page.reload();
    const continueGame = page.getByRole("button", { name: /继续游戏/ });
    await expect(continueGame).toBeVisible({ timeout: 60_000 });
    const loadStartedAt = Date.now();
    await continueGame.click();
    const shell = page.locator(".game-shell");
    await expect(shell).toBeVisible({ timeout: 180_000 });
    await expect(shell).toHaveAttribute("data-simulation-worker", "active", { timeout: 180_000 });
    await expect(shell).toHaveAttribute("data-local-save-raw-cache-size", "0", { timeout: 180_000 });
    await expect.poll(() => page.evaluate(() => Boolean(window.__DSP_RUNTIMEWORLD_BENCHMARK__)), { timeout: 30_000 }).toBe(true);
    console.log(`RUNTIMEWORLD_M1_STAGE ${fixtureLabel} loaded`);
    const loadToActiveMs = Date.now() - loadStartedAt;
    await expect(shell).toHaveAttribute("data-active-planet-node-count", /\d+/);

    await page.evaluate(() => {
      const frames: number[] = [];
      const longTasks: number[] = [];
      const probe = { done: false, frames, longTasks };
      (window as typeof window & { __runtimeWorldM1FrameProbe?: typeof probe }).__runtimeWorldM1FrameProbe = probe;
      const observer = new PerformanceObserver((entries) => {
        for (const entry of entries.getEntries()) longTasks.push(entry.duration);
      });
      try { observer.observe({ type: "longtask" }); } catch { /* optional metric */ }
      const startedAt = performance.now();
      let previousAt = startedAt;
      const sample = (now: number) => {
        frames.push(now - previousAt);
        previousAt = now;
        if (now - startedAt < 6_000) requestAnimationFrame(sample);
        else {
          probe.done = true;
          observer.disconnect();
        }
      };
      requestAnimationFrame(sample);
    });
    const resumeBefore = (await commandTraces(page)).length;
    const resume = page.getByLabel("继续模拟");
    if (await resume.isVisible()) await resume.click();
    await expect(shell).toHaveAttribute("data-simulation-paused", "false", { timeout: 30_000 });
    if ((await commandTraces(page)).length > resumeBefore) await waitForCommand(page, resumeBefore, "top-level");
    await expect.poll(() => page.evaluate(() => (
      window as typeof window & { __runtimeWorldM1FrameProbe?: { done: boolean } }
    ).__runtimeWorldM1FrameProbe?.done ?? false), { timeout: 20_000 }).toBe(true);
    const frameMetrics = await page.evaluate(() => {
      const probe = (window as typeof window & {
        __runtimeWorldM1FrameProbe?: { frames: number[]; longTasks: number[] };
      }).__runtimeWorldM1FrameProbe!;
      const ordered = [...probe.frames].sort((left, right) => left - right);
      const percentile = (ratio: number) => ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * ratio) - 1))] ?? 0;
      return {
        samples: ordered.length,
        p95Ms: percentile(0.95),
        p99Ms: percentile(0.99),
        maxMs: ordered.at(-1) ?? 0,
        longTaskMaxMs: Math.max(0, ...probe.longTasks),
        longTaskCount: probe.longTasks.length,
      };
    });
    console.log(`RUNTIMEWORLD_M1_STAGE ${fixtureLabel} steady-frames`);

    const entity = await runDiagnosticCommand(page, { kind: "entity-lock", count: 1, locked: true });
    console.log(`RUNTIMEWORLD_M1_STAGE ${fixtureLabel} entity-1`);
    const entity100 = await runDiagnosticCommand(page, { kind: "entity-lock", count: 100, locked: true });
    console.log(`RUNTIMEWORLD_M1_STAGE ${fixtureLabel} entity-100`);
    const entity1000 = await runDiagnosticCommand(page, { kind: "entity-lock", count: 1_000, locked: true });
    console.log(`RUNTIMEWORLD_M1_STAGE ${fixtureLabel} entity-1000`);

    const belt = await runDiagnosticCommand(page, { kind: "belt-route", count: 1, routeMode: "upper" });
    console.log(`RUNTIMEWORLD_M1_STAGE ${fixtureLabel} belt-1`);
    const batch100 = await runDiagnosticCommand(page, { kind: "belt-route", count: 100, routeMode: "upper" });
    console.log(`RUNTIMEWORLD_M1_STAGE ${fixtureLabel} belt-100`);
    const batch1000 = await runDiagnosticCommand(page, { kind: "belt-route", count: 1_000, routeMode: "lower" });
    console.log(`RUNTIMEWORLD_M1_STAGE ${fixtureLabel} belt-1000`);

    await page.getByLabel("暂停模拟").dispatchEvent("click");
    await expect(shell).toHaveAttribute("data-simulation-paused", "true", { timeout: 30_000 });
    await expect.poll(() => page.evaluate(() => (
      window.__DSP_RUNTIME_TRANSITIONS__?.events.filter((event) =>
        event.phase === "second-painted-frame" && event.transition === "pause").length ?? 0
    )), { timeout: 30_000 }).toBeGreaterThan(0);
    console.log(`RUNTIMEWORLD_M1_STAGE ${fixtureLabel} paused`);
    const confirmSettlement = page.getByRole("button", { name: "确认结算" });
    const settlementAppeared = await confirmSettlement.waitFor({ state: "visible", timeout: 3_000 }).then(() => true, () => false);
    if (settlementAppeared) {
      await confirmSettlement.dispatchEvent("click");
      await expect(confirmSettlement).toHaveCount(0);
      console.log(`RUNTIMEWORLD_M1_STAGE ${fixtureLabel} settlement-confirmed`);
    }
    await page.getByLabel("打开设置").dispatchEvent("click");
    const operations = page.getByRole("dialog", { name: "运营中心" });
    await expect(operations).toBeVisible({ timeout: 30_000 });
    await operations.getByRole("tab", { name: "存档" }).dispatchEvent("click");
    console.log(`RUNTIMEWORLD_M1_STAGE ${fixtureLabel} save-open`);
    const saveStartedAt = performance.now();
    await operations.getByRole("button", { name: "立即保存" }).click();
    await expect(shell).toHaveAttribute("data-persistence-kind", "manual", { timeout: 120_000 });
    await expect(shell).toHaveAttribute("data-persistence-phase", "complete", { timeout: 180_000 });
    await expect(shell).toHaveAttribute("data-local-save-raw-cache-size", "0", { timeout: 180_000 });
    const saveHarnessMs = performance.now() - saveStartedAt;
    console.log(`RUNTIMEWORLD_M1_STAGE ${fixtureLabel} manual-save`);

    const browserMetrics = await page.evaluate(() => {
      const diagnostics = (window as typeof window & {
        __DSP_RUNTIME_TRANSITIONS__?: {
          events: Array<{ phase: string; startedAt: number; durationMs: number; transition?: string; detail?: Record<string, unknown> }>;
        };
        __runtimeWorldM1?: { commands: CommandTrace[]; projectionResponses: number; fullStateResponses: number };
      });
      const events = diagnostics.__DSP_RUNTIME_TRANSITIONS__?.events ?? [];
      const save = [...events].reverse().find((event) => event.phase === "save-complete" && event.transition === "autosave") ??
        [...events].reverse().find((event) => event.phase === "persistence-phase" && event.detail?.kind === "manual" && event.detail?.phase === "complete");
      const serialization = [...events].reverse().find((event) => event.phase === "save-serialize-idb-readback" && event.detail?.kind === "manual");
      const secondPainted = events
        .filter((event) => event.phase === "second-painted-frame" && (event.transition === "resume" || event.transition === "pause"))
        .map((event) => ({ transition: event.transition, durationMs: event.durationMs }));
      return {
        commands: diagnostics.__runtimeWorldM1?.commands ?? [],
        projectionResponses: diagnostics.__runtimeWorldM1?.projectionResponses ?? 0,
        fullStateResponses: diagnostics.__runtimeWorldM1?.fullStateResponses ?? 0,
        saveDurationMs: save?.durationMs ?? 0,
        saveDetail: serialization?.detail ?? null,
        secondPainted,
        transitionEventCount: events.length,
        rawCacheSize: Number(document.querySelector<HTMLElement>(".game-shell")?.dataset.localSaveRawCacheSize ?? -1),
      };
    });
    const report = {
      fixture: fixtureLabel,
      source: {
        bytes: originalStat.size,
        sha256: originalHash,
        gameStateVersion: sourceState.version ?? null,
        entities: sourceState.entities?.length ?? 0,
        belts: sourceState.belts?.length ?? 0,
      },
      loadToActiveMs,
      frameMetrics,
      entity,
      entity100,
      entity1000,
      belt,
      batch100,
      batch1000,
      saveHarnessMs,
      ...browserMetrics,
    };
    console.log(`RUNTIMEWORLD_M1_BROWSER ${JSON.stringify(report)}`);

    expect(frameMetrics.samples).toBeGreaterThan(0);
    expect(frameMetrics.p95Ms, JSON.stringify(report, null, 2)).toBeLessThanOrEqual(20);
    expect(frameMetrics.longTaskMaxMs, JSON.stringify(report, null, 2)).toBeLessThanOrEqual(100);
    expect(browserMetrics.fullStateResponses).toBe(0);
    expect(browserMetrics.projectionResponses).toBeGreaterThan(0);
    expect(browserMetrics.rawCacheSize).toBe(0);
    expect(browserMetrics.saveDurationMs).toBeGreaterThanOrEqual(0);
    expect(createHash("sha256").update(readFileSync(fixturePath!, "utf8")).digest("hex")).toBe(originalHash);
    const finalStat = statSync(fixturePath!);
    expect(finalStat.size).toBe(originalStat.size);
    expect(finalStat.mtimeMs).toBe(originalStat.mtimeMs);
  });
});
