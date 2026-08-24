import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopBridge } from "../desktop";
import { apiFetch } from "./apiTransport";
import { CLOUD_TRANSFER_CONTRACT, cloudRequestTimeoutMs } from "./cloudTransferContract";

const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;

function desktopBridge(overrides: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
    isDesktop: true,
    setFontScale: vi.fn(),
    getReleaseInfo: vi.fn(),
    requestApi: vi.fn(),
    requestApiTransfer: vi.fn(),
    cancelApiRequest: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    installUpdate: vi.fn(),
    onUpdateStatus: vi.fn(() => () => undefined),
    ...overrides,
  } as DesktopBridge;
}

afterEach(() => {
  if (originalWindow === undefined) Reflect.deleteProperty(globalThis, "window");
  else Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("apiFetch", () => {
  it("uses the restricted desktop bridge for absolute HTTPS API calls", async () => {
    const requestApi = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: JSON.stringify({ ok: true }),
      headers: { "content-type": "application/json" },
    });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { dspDesktop: desktopBridge({ requestApi }) } });
    const response = await apiFetch("https://dsponline.cn/api/account/session?full=1", {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json", "x-ignored": "client-only" },
      body: JSON.stringify({ ping: true }),
    });
    expect(requestApi).toHaveBeenCalledWith({
      path: "/account/session?full=1",
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json", "x-ignored": "client-only" },
      body: JSON.stringify({ ping: true }),
      timeoutMs: 16_500,
    });
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("retains browser fetch for web and relative requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    globalThis.fetch = fetchMock;
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    await apiFetch("/api/presence", { method: "POST" });
    expect(fetchMock).toHaveBeenCalledWith("/api/presence", { method: "POST" });
  });

  it("transfers binary desktop request bodies and responses through cancellable IPC", async () => {
    const requestApi = vi.fn();
    const requestApiTransfer = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      bodyBuffer: new TextEncoder().encode(JSON.stringify({ ok: true })).buffer,
      headers: { "content-type": "application/json" },
    });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { dspDesktop: desktopBridge({ requestApi, requestApiTransfer }) } });
    const response = await apiFetch("https://dsponline.cn/api/cloud-save", { method: "PUT", body: new Uint8Array([1, 2, 3]) });
    expect(requestApiTransfer).toHaveBeenCalledOnce();
    const [request, body] = requestApiTransfer.mock.calls[0];
    expect(request).toMatchObject({ path: "/cloud-save", method: "PUT", bodyByteLength: 3 });
    expect(request.requestId).toMatch(/^cloud_/);
    expect([...new Uint8Array(body)]).toEqual([1, 2, 3]);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(requestApi).not.toHaveBeenCalled();
  });

  it("streams a cloud-save download through the large-response desktop boundary", async () => {
    const payload = JSON.stringify({ cloudSave: { payload: "large-save" } });
    const requestApiTransfer = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      bodyBuffer: new TextEncoder().encode(payload).buffer,
      headers: { "content-type": "application/json" },
    });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { dspDesktop: desktopBridge({ requestApiTransfer }) } });
    const response = await apiFetch("https://dsponline.cn/api/cloud-save?slot=2&mode=speedrun");
    expect(requestApiTransfer).toHaveBeenCalledOnce();
    expect(requestApiTransfer.mock.calls[0][0]).toMatchObject({
      path: "/cloud-save?slot=2&mode=speedrun",
      method: "GET",
      bodyByteLength: 0,
      expectedResponseBytes: CLOUD_TRANSFER_CONTRACT.singleSaveResponseLimitBytes,
      timeoutMs: cloudRequestTimeoutMs(0, CLOUD_TRANSFER_CONTRACT.singleSaveResponseLimitBytes),
    });
    await expect(response.json()).resolves.toEqual({ cloudSave: { payload: "large-save" } });
  });

  it("normalizes an omitted bridge verb for ordinary API requests", async () => {
    const requestApi = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      body: "",
      headers: { "content-type": "application/json" },
    });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { dspDesktop: desktopBridge({ requestApi }) } });
    await apiFetch("https://dsponline.cn/api/account");
    expect(requestApi).toHaveBeenCalledWith(expect.objectContaining({ path: "/account", method: "GET" }));
  });

  it("propagates AbortSignal cancellation to the desktop main process", async () => {
    let rejectTransfer: ((reason: unknown) => void) | null = null;
    const requestApiTransfer = vi.fn(() => new Promise<never>((_resolve, reject) => { rejectTransfer = reject; }));
    const cancelApiRequest = vi.fn((requestId: string) => rejectTransfer?.(new DOMException(requestId, "AbortError")));
    Object.defineProperty(globalThis, "window", { configurable: true, value: { dspDesktop: desktopBridge({ requestApiTransfer, cancelApiRequest }) } });
    const controller = new AbortController();
    const pending = apiFetch("https://dsponline.cn/api/cloud-save", { method: "PUT", body: new Uint8Array([7]), signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelApiRequest).toHaveBeenCalledWith(expect.stringMatching(/^cloud_/));
  });
});
