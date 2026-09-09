import { expect, test, type Page } from "@playwright/test";
import { createInitialState } from "../../src/game/engine";
import { serializeEnvelope } from "../../src/game/storage";
import type { DesktopNativePlayerAuthorityHandoffRequest, DesktopNativePlayerAuthorityHandoffResult } from "../../src/desktop";

type StartupProbe = {
  workers: number; terminations: number; clockPulls: number;
  reconcile: ((request: DesktopNativePlayerAuthorityHandoffRequest) => Promise<DesktopNativePlayerAuthorityHandoffResult>) | null;
};
declare global { interface Window { __startupOrderProbe: StartupProbe } }

async function openWaitingFactory(page: Page) {
  const state = createInitialState(1_440_901, false);
  state.paused = true;
  await page.addInitScript(raw => {
    sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-09-08-v1.2.7");
    localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({version:1,skipped:true,stepIndex:5}));
    localStorage.setItem("dsp-idle-network.save.v1", raw);
    const probe: StartupProbe = {workers:0,terminations:0,clockPulls:0,reconcile:null};
    window.__startupOrderProbe = probe;
    const OriginalWorker = window.Worker;
    window.Worker = class extends OriginalWorker {
      private simulation: boolean;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.simulation = options?.name === "factory-simulation";
        if (this.simulation) probe.workers++;
      }
      terminate() { if (this.simulation) probe.terminations++; super.terminate(); }
    };
    // Protocol ordering fixture only. No Native execution or qualification is claimed.
    Object.defineProperty(window, "dspDesktop", {configurable:true,value:{
      isDesktop:true,
      getReleaseInfo: async () => ({isDesktop:true,platform:"win32",channel:"beta",channelLabel:"测试",version:"1.2.7",update:{state:"idle"}}),
      getNativePlayerAuthorityState: async () => {
        probe.clockPulls++;
        return {schemaVersion:1,phase:"idle",sessionId:null,runId:null,revision:null,
          acknowledgedSequence:null,nextSequence:null,nextDeadlineMs:null,
          inFlight:false,currentOperation:null,queuedCommands:0,lastErrorCode:null};
      },
      onNativePlayerAuthorityState: () => () => undefined,
      onNativePlayerAuthorityHandoffRequest: (listener: StartupProbe["reconcile"]) => {
        probe.reconcile = listener;
        return () => { if(probe.reconcile === listener) probe.reconcile = null; };
      },
    }});
  }, serializeEnvelope(state, Date.now()));
  await page.goto("/");
  await expect.poll(() => page.evaluate(() => Boolean(window.__startupOrderProbe?.reconcile) &&
    window.__startupOrderProbe.clockPulls > 0)).toBe(true);
  // Let the real React effects and trusted clock reply finish before checking.
  await page.evaluate(() => new Promise<void>(resolve =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function reconcile(page: Page, state: "absent" | "unknown") {
  return page.evaluate(async leaseState => {
    const listener = window.__startupOrderProbe.reconcile;
    if (!listener) throw new Error("startup listener missing");
    return listener({kind:"native-player-authority-startup-reconcile-v1",
      handoffId:"startup-order-"+leaseState,rustLease:{state:leaseState},
      releaseAuthorized:leaseState === "absent",timeoutMs:5000});
  }, state);
}

test("a ready idle clock waits for startup reconciliation before creating one simulation Worker", async ({page}) => {
  await openWaitingFactory(page);
  expect(await page.evaluate(() => window.__startupOrderProbe.workers)).toBe(0);
  const result = await reconcile(page, "absent");
  expect(result).toMatchObject({action:"no-browser-fence",rendererInFlightCoreOperations:0,workerInFlightCoreOperations:0});
  await expect(page.locator(".game-shell")).toHaveAttribute("data-simulation-worker","active");
  expect(await page.evaluate(() => ({
    workers:window.__startupOrderProbe.workers,terminations:window.__startupOrderProbe.terminations,
  }))).toEqual({workers:1,terminations:0});
});

test("an unknown startup lease keeps simulation stopped until a verified absent retry", async ({page}) => {
  await openWaitingFactory(page);
  expect(await reconcile(page,"unknown")).toMatchObject({action:"fail-closed"});
  expect(await page.evaluate(() => window.__startupOrderProbe.workers)).toBe(0);
  expect(await reconcile(page,"absent")).toMatchObject({action:"no-browser-fence"});
  await expect(page.locator(".game-shell")).toHaveAttribute("data-simulation-worker","active");
  expect(await page.evaluate(() => window.__startupOrderProbe.workers)).toBe(1);
});
