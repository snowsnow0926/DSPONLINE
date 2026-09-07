import { getDesktopBridge } from "../desktop";
import { closeLocalSaveWriter } from "./localSaveStore";

type CloseHandler = (signal: AbortSignal) => Promise<void>;
let handler: CloseHandler | null = null;
let completed = false;
export function desktopCloseCompleted() { return completed; }
export function registerDesktopCloseHandler(next: CloseHandler) {
  handler = next;
  return () => { if (handler === next) handler = null; };
}
export function installDesktopGracefulClose() {
  const bridge = getDesktopBridge();
  if (!bridge?.onPrepareClose || !bridge.confirmClose) return;
  let current: { token: string; controller: AbortController } | null = null;
  bridge.onCancelClose?.(({ token }) => { if (current?.token === token) current.controller.abort(); });
  bridge.onPrepareClose(({ token, deadline }) => {
    if (current) return;
    const controller = new AbortController();
    current = { token, controller };
    const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now() - 500));
    // Block actual UI input during quiescence, including menu import buttons.
    const block = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation(); };
    const events = ["pointerdown", "click", "keydown", "drop"];
    events.forEach((event) => window.addEventListener(event, block, true));
    document.documentElement.dataset.desktopClosing = "true";
    void (async () => {
      try {
        if (!completed) {
          if (handler) await handler(controller.signal);
          else await closeLocalSaveWriter(controller.signal);
          completed = true;
        }
        await bridge.confirmClose!({ token, ok: true });
      } catch {
        await bridge.confirmClose!({ token, ok: false }).catch(() => undefined);
      } finally {
        clearTimeout(timer);
        current = null;
        // A completed release remains quiescent if the ACK was lost. Retrying
        // close can acknowledge it; the former writer must never resume.
        if (!completed) {
          events.forEach((event) => window.removeEventListener(event, block, true));
          delete document.documentElement.dataset.desktopClosing;
        }
      }
    })();
  });
}
