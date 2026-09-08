import { describe, expect, it, vi } from "vitest";
import { Buffer } from "node:buffer";
import {
  androidBase64FileSupported,
  androidBlobToBase64,
  androidSessionStorageUpdate,
  bytesToBase64,
  isAndroidSecureSessionHandle,
  needsAndroidSecureSessionBridge,
  shouldClearAndroidSessionResponse,
} from "./androidApiTransport";

describe("Android cloud transport", () => {
  it("base64-encodes arbitrary gzip bytes without argument overflow", () => {
    const bytes = new Uint8Array(2 * 1024 * 1024 + 3);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
    const encoded = bytesToBase64(bytes);
    const decoded = Uint8Array.from(atob(encoded), (value) => value.charCodeAt(0));
    // Compare every byte and the complete length without expanding two million
    // typed-array entries through the assertion library's generic object walk.
    expect(Buffer.from(decoded).equals(Buffer.from(bytes))).toBe(true);
  });

  it("does not claim native Android capability in a web test runtime", async () => {
    vi.stubGlobal("__APP_PLATFORM__", "web");
    const module = await import("./androidApiTransport");
    expect(module.androidBase64RequestSupported()).toBe(false);
    vi.unstubAllGlobals();
  });

  it("uses the native base64 file path only where Android can decode it", () => {
    expect(androidBase64FileSupported("Mozilla/5.0 (Linux; Android 7.1.2)")).toBe(false);
    expect(androidBase64FileSupported("Mozilla/5.0 (Linux; Android 8.0.0)")).toBe(true);
    expect(androidBase64FileSupported("Mozilla/5.0 (Linux; Android 15)")).toBe(true);
    expect(androidBase64FileSupported("Mozilla/5.0 (Windows NT 10.0)")).toBe(false);
  });

  it("accepts only complete opaque native handles and routes authenticated calls through the secure bridge", () => {
    const handle = `dsp_android_session_v1_${"a".repeat(43)}`;
    expect(isAndroidSecureSessionHandle(handle)).toBe(true);
    expect(isAndroidSecureSessionHandle("dsp_android_session_v1_short")).toBe(false);
    expect(isAndroidSecureSessionHandle(`dsp_android_session_v1_${"a".repeat(43)}.`)).toBe(false);
    expect(needsAndroidSecureSessionBridge("https://api.example.test/api/account", { authorization: `Bearer ${handle}` })).toBe(true);
    expect(needsAndroidSecureSessionBridge("https://api.example.test/api/auth/login", {})).toBe(true);
    expect(needsAndroidSecureSessionBridge("https://api.example.test/api/health", {})).toBe(false);
    expect(needsAndroidSecureSessionBridge("not a URL", { authorization: `Bearer ${handle}` })).toBe(false);
  });

  it("replaces only the exact legacy token with its native handle and clears revoked handles", () => {
    const legacy = `legacy_${"x".repeat(40)}`;
    const handle = `dsp_android_session_v1_${"a".repeat(43)}`;
    expect(androidSessionStorageUpdate(legacy, legacy, { dspSessionHandle: handle })).toBe(handle);
    expect(androidSessionStorageUpdate("newer-token", legacy, { dspSessionHandle: handle })).toBeUndefined();
    expect(androidSessionStorageUpdate(legacy, legacy, { dspSessionHandle: "malformed" })).toBeUndefined();
    expect(androidSessionStorageUpdate(handle, handle, { dspSessionCleared: true })).toBeNull();
    expect(androidSessionStorageUpdate(handle, handle, { dspSessionCleared: true, dspSessionClearedHandle: handle })).toBeNull();
    expect(androidSessionStorageUpdate(handle, handle, {
      dspSessionCleared: true,
      dspSessionClearedHandle: `dsp_android_session_v1_${"b".repeat(43)}`,
    })).toBeUndefined();
    expect(androidSessionStorageUpdate("newer-token", legacy, { dspSessionCleared: true })).toBeUndefined();
  });

  it("distinguishes an expired session from ordinary 401 validation failures", () => {
    expect(shouldClearAndroidSessionResponse(401, "SESSION_EXPIRED")).toBe(true);
    expect(shouldClearAndroidSessionResponse(401, "CURRENT_PASSWORD_INVALID")).toBe(false);
    expect(shouldClearAndroidSessionResponse(401, "INVALID_CREDENTIALS")).toBe(false);
    expect(shouldClearAndroidSessionResponse(200, undefined, true)).toBe(true);
  });

  it("stops a gzip body that is cancelled while Blob bytes are still being read", async () => {
    let finishRead: ((bytes: ArrayBuffer) => void) | undefined;
    const blob = new Blob(["synthetic"]);
    vi.spyOn(blob, "arrayBuffer").mockImplementation(() => new Promise((resolve) => { finishRead = resolve; }));
    const controller = new AbortController();
    const pending = androidBlobToBase64(blob, controller.signal);
    controller.abort();
    finishRead?.(new TextEncoder().encode("synthetic").buffer as ArrayBuffer);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
