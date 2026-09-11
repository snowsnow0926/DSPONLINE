import type { Page } from "@playwright/test";

/**
 * Inject one conservative Worker response for decision/cancel/zero-reward UI
 * tests. A 33-second fixture can finish successfully, so its duration must
 * not be used as a guarantee that real calibration will require a decision.
 * Other Workers pass through, and the next offline Worker restores the native
 * constructor immediately. Normal exact/approximate settlement tests do not
 * use this helper.
 */
export async function injectOneConservativeDecision(page: Page): Promise<void> {
  await page.evaluate(() => {
    const NativeWorker = window.Worker;
    class OneConservativeDecisionWorker extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (options?.name !== "offline-simulation") return;
        this.terminate();
        window.Worker = NativeWorker;
        this.postMessage = ((message: { type?: string; id?: number; seconds?: number }) => {
          if (message.type !== "start" || typeof message.id !== "number") return;
          const totalSeconds = Number(message.seconds ?? 0);
          window.setTimeout(() => this.dispatchEvent(new MessageEvent("message", {
            data: {
              type: "decision-required",
              id: message.id,
              totalSeconds,
              approximation: {
                mode: "approximate",
                calibrationWindowSeconds: 0,
                approximatedSeconds: totalSeconds,
                maxEstimatedError: 1,
                fellBack: true,
                fallbackReason: "测试注入：快速 Worker 校准不稳定",
                algorithmVersion: "fast-30s-v2",
                settlementStatus: "conservative-preview",
              },
            },
          })), 0);
        }) as Worker["postMessage"];
      }
    }
    window.Worker = OneConservativeDecisionWorker as typeof Worker;
  });
}
