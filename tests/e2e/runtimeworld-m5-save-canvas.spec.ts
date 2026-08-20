import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const fixturePath = process.env.DSP_M5_REAL_FIXTURE;
const fixtureLabel = (process.env.DSP_M5_FIXTURE_LABEL ?? "anonymous").replace(/[^a-zA-Z0-9_-]/g, "-");
const autosaveLimitMs = Number(process.env.DSP_M5_AUTOSAVE_LIMIT_MS ?? 0);

interface BrowserProbe {
  autosaveHandler: TimerHandler | null;
  longTasks: Array<{ startedAt: number; durationMs: number }>;
}

async function transitionCount(page: Page, transition: "pause" | "resume"): Promise<number> {
  return page.evaluate((expected) => window.__DSP_RUNTIME_TRANSITIONS__?.events.filter((event) =>
    event.phase === "second-painted-frame" && event.transition === expected).length ?? 0, transition);
}

async function waitForSecondPaint(page: Page, transition: "pause" | "resume", before: number): Promise<number> {
  await expect.poll(() => transitionCount(page, transition), { timeout: 30_000 }).toBeGreaterThan(before);
  return page.evaluate((expected) => {
    const matches = window.__DSP_RUNTIME_TRANSITIONS__?.events.filter((event) =>
      event.phase === "second-painted-frame" && event.transition === expected) ?? [];
    return matches.at(-1)?.durationMs ?? Number.POSITIVE_INFINITY;
  }, transition);
}

test.describe("RuntimeWorld M5 production save and canvas gate", () => {
  test.skip(!fixturePath, "requires DSP_M5_REAL_FIXTURE");
  test.skip(!Number.isFinite(autosaveLimitMs) || autosaveLimitMs <= 0, "requires DSP_M5_AUTOSAVE_LIMIT_MS");

  test("keeps running frames and an authoritative autosave within the real-save budgets", async ({ page }) => {
    test.setTimeout(300_000);
    const sourceRaw = readFileSync(fixturePath!, "utf8");
    const sourceHash = createHash("sha256").update(sourceRaw).digest("hex");
    const sourceStat = statSync(fixturePath!);
    const envelope = JSON.parse(sourceRaw) as Record<string, unknown>;
    const sourceState = (envelope.state ?? envelope) as {
      version?: number;
      entities?: unknown[];
      belts?: unknown[];
      settings?: { autosaveIntervalSeconds?: number };
    };
    const autosaveIntervalMs = Math.max(1, Number(sourceState.settings?.autosaveIntervalSeconds ?? 30)) * 1_000;
    const isolatedRaw = JSON.stringify({ ...envelope, savedAt: Date.now() });

    await page.addInitScript(({ expectedAutosaveIntervalMs }) => {
      localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-21-v1.1.2");
      localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
      localStorage.setItem("dsp-idle-network.onboarding.v1", "dismissed");
      localStorage.setItem("dsp-idle-network.ui.factory-alerts.v1", "false");
      localStorage.setItem("dsp-idle-network.ui.large-save-autosave-throttle.v1", "false");
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
      window.__DSP_RUNTIME_TRANSITIONS__ = { enabled: true, events: [], active: {}, counters: {} };
      const probe: BrowserProbe = { autosaveHandler: null, longTasks: [] };
      Object.assign(window, { __runtimeWorldM5: probe });
      const observer = new PerformanceObserver((entries) => {
        for (const entry of entries.getEntries()) probe.longTasks.push({ startedAt: entry.startTime, durationMs: entry.duration });
      });
      try { observer.observe({ type: "longtask" }); } catch { /* Chromium exposes this in production-preview. */ }
      const nativeSetInterval = window.setInterval.bind(window);
      window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
        if (timeout === expectedAutosaveIntervalMs && typeof handler === "function" && !probe.autosaveHandler) {
          probe.autosaveHandler = handler;
          return 0 as unknown as ReturnType<typeof window.setInterval>;
        }
        return nativeSetInterval(handler, timeout, ...args);
      }) as typeof window.setInterval;
    }, { expectedAutosaveIntervalMs: autosaveIntervalMs });

    await page.goto("/?storageMigration=production", { waitUntil: "domcontentloaded" });
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
      database.close();
      return true;
    }, isolatedRaw);
    expect(seeded).toBe(true);

    await page.reload({ waitUntil: "domcontentloaded" });
    const continueGame = page.getByRole("button", { name: /继续游戏/ });
    await expect(continueGame).toBeVisible({ timeout: 60_000 });
    await continueGame.click();
    const shell = page.locator(".game-shell");
    await expect(shell).toBeVisible({ timeout: 180_000 });
    await expect(shell).toHaveAttribute("data-simulation-worker", "active", { timeout: 180_000 });
    await expect(shell).toHaveAttribute("data-local-save-raw-cache-size", "0", { timeout: 180_000 });

    const resumeControl = page.getByLabel("继续模拟");
    if (await resumeControl.isVisible()) await resumeControl.dispatchEvent("click");
    await expect(shell).toHaveAttribute("data-simulation-paused", "false", { timeout: 30_000 });

    const pauseBefore = await transitionCount(page, "pause");
    await page.getByLabel("暂停模拟").dispatchEvent("click");
    await expect(shell).toHaveAttribute("data-simulation-paused", "true", { timeout: 30_000 });
    const pauseSecondPaintMs = await waitForSecondPaint(page, "pause", pauseBefore);
    const confirmSettlement = page.getByRole("button", { name: "确认结算" });
    if (await confirmSettlement.waitFor({ state: "visible", timeout: 2_000 }).then(() => true, () => false)) {
      await confirmSettlement.dispatchEvent("click");
      await expect(confirmSettlement).toHaveCount(0);
    }
    const resumeBefore = await transitionCount(page, "resume");
    await page.getByLabel("继续模拟").dispatchEvent("click");
    await expect(shell).toHaveAttribute("data-simulation-paused", "false", { timeout: 30_000 });
    const resumeSecondPaintMs = await waitForSecondPaint(page, "resume", resumeBefore);

    const frameMetrics = await page.evaluate(async () => {
      const probe = (window as typeof window & { __runtimeWorldM5?: BrowserProbe }).__runtimeWorldM5!;
      probe.longTasks.length = 0;
      const startedAt = performance.now();
      const frames: number[] = [];
      let previousAt = startedAt;
      await new Promise<void>((resolve) => {
        const sample = (now: number) => {
          frames.push(now - previousAt);
          previousAt = now;
          if (now - startedAt < 6_000) requestAnimationFrame(sample);
          else resolve();
        };
        requestAnimationFrame(sample);
      });
      const ordered = [...frames].sort((left, right) => left - right);
      const percentile = (ratio: number) => ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * ratio) - 1))] ?? 0;
      return {
        samples: ordered.length,
        p95Ms: percentile(0.95),
        p99Ms: percentile(0.99),
        maxMs: ordered.at(-1) ?? 0,
        longTaskCount: probe.longTasks.length,
        maxLongTaskMs: Math.max(0, ...probe.longTasks.map((entry) => entry.durationMs)),
      };
    });

    const autosaveBefore = await page.evaluate(() => window.__DSP_RUNTIME_TRANSITIONS__?.events.filter((event) =>
      event.phase === "persistence-phase" && event.detail?.kind === "autosave" && event.detail?.phase === "complete").length ?? 0);
    await page.evaluate(() => {
      const probe = (window as typeof window & { __runtimeWorldM5?: BrowserProbe }).__runtimeWorldM5;
      if (!probe || typeof probe.autosaveHandler !== "function") throw new Error("autosave interval handler missing");
      probe.longTasks.length = 0;
      probe.autosaveHandler();
    });
    await expect.poll(() => page.evaluate(() => window.__DSP_RUNTIME_TRANSITIONS__?.events.filter((event) =>
      event.phase === "persistence-phase" && event.detail?.kind === "autosave" && event.detail?.phase === "complete").length ?? 0),
    { timeout: 180_000 }).toBeGreaterThan(autosaveBefore);
    await expect(shell).toHaveAttribute("data-simulation-worker", "active", { timeout: 30_000 });
    await expect(shell).toHaveAttribute("data-simulation-paused", "false", { timeout: 30_000 });
    await expect(shell).toHaveAttribute("data-local-save-raw-cache-size", "0", { timeout: 180_000 });

    const autosaveMetrics = await page.evaluate(() => {
      const events = window.__DSP_RUNTIME_TRANSITIONS__?.events ?? [];
      const save = [...events].reverse().find((event) => event.phase === "save-complete" && event.transition === "autosave");
      const probe = (window as typeof window & { __runtimeWorldM5?: BrowserProbe }).__runtimeWorldM5!;
      const startedAt = save?.startedAt ?? 0;
      const endedAt = startedAt + (save?.durationMs ?? 0);
      const longTasks = probe.longTasks.filter((entry) => entry.startedAt >= startedAt && entry.startedAt <= endedAt);
      return {
        durationMs: save?.durationMs ?? Number.POSITIVE_INFINITY,
        longTaskCount: longTasks.length,
        maxLongTaskMs: Math.max(0, ...longTasks.map((entry) => entry.durationMs)),
      };
    });

    const report = {
      fixture: fixtureLabel,
      source: {
        bytes: sourceStat.size,
        sha256: sourceHash,
        gameStateVersion: sourceState.version ?? null,
        entities: sourceState.entities?.length ?? 0,
        belts: sourceState.belts?.length ?? 0,
      },
      pauseSecondPaintMs,
      resumeSecondPaintMs,
      frameMetrics,
      autosaveLimitMs,
      autosaveMetrics,
    };
    console.log(`RUNTIMEWORLD_M5_BROWSER ${JSON.stringify(report)}`);

    expect(pauseSecondPaintMs, JSON.stringify(report, null, 2)).toBeLessThanOrEqual(100);
    expect(resumeSecondPaintMs, JSON.stringify(report, null, 2)).toBeLessThanOrEqual(100);
    expect(frameMetrics.samples).toBeGreaterThan(0);
    expect(frameMetrics.p95Ms, JSON.stringify(report, null, 2)).toBeLessThanOrEqual(20);
    expect(frameMetrics.maxLongTaskMs, JSON.stringify(report, null, 2)).toBeLessThanOrEqual(100);
    expect(autosaveMetrics.durationMs, JSON.stringify(report, null, 2)).toBeLessThanOrEqual(autosaveLimitMs);
    expect(autosaveMetrics.maxLongTaskMs, JSON.stringify(report, null, 2)).toBeLessThanOrEqual(100);
    expect(createHash("sha256").update(readFileSync(fixturePath!, "utf8")).digest("hex")).toBe(sourceHash);
    const finalStat = statSync(fixturePath!);
    expect(finalStat.size).toBe(sourceStat.size);
    expect(finalStat.mtimeMs).toBe(sourceStat.mtimeMs);
  });
});
