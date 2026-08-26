import { getDesktopBridge, type DesktopNativeSaveBeginRequest, type DesktopNativeSaveCommitResult } from "../desktop";
import type { LocalSaveInternalWrite } from "./localSaveStore";
import type { SaveMode } from "./types";

export const WINDOWS_NATIVE_SAVE_FORMAT_VERSION = 1;
const seededSlots = new Set<"normal-main" | "speedrun-main">();

export interface NativeSaveTransaction {
  readonly transactionId: string;
  readonly request: DesktopNativeSaveBeginRequest;
  write(records: LocalSaveInternalWrite[]): Promise<void>;
  commit(): Promise<DesktopNativeSaveCommitResult>;
  abort(): Promise<void>;
}

class DesktopNativeSaveTransaction implements NativeSaveTransaction {
  private settled = false;

  constructor(
    readonly transactionId: string,
    readonly request: DesktopNativeSaveBeginRequest,
  ) {}

  async write(records: LocalSaveInternalWrite[]): Promise<void> {
    if (this.settled) throw new Error("Windows 原生存档事务已结束");
    const desktop = getDesktopBridge();
    if (!desktop) throw new Error("Windows 原生存档桥接已断开");
    await desktop.writeNativeSave({ transactionId: this.transactionId, records });
  }

  async commit(): Promise<DesktopNativeSaveCommitResult> {
    if (this.settled) throw new Error("Windows 原生存档事务已结束");
    this.settled = true;
    const desktop = getDesktopBridge();
    if (!desktop) throw new Error("Windows 原生存档桥接已断开");
    const result = await desktop.commitNativeSave({ transactionId: this.transactionId });
    if (result.revision !== this.request.revision || result.slot !== this.request.slot || !/^[a-f0-9]{64}$/.test(result.rootHash)) {
      throw new Error("Windows 原生存档提交回执与权威 revision 不一致");
    }
    seededSlots.add(this.request.slot);
    globalThis.setTimeout(() => {
      void getDesktopBridge()?.compactNativeSave({ slot: this.request.slot, retainGenerations: 2 }).catch(() => undefined);
    }, 15_000);
    return result;
  }

  async abort(): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    const desktop = getDesktopBridge();
    if (!desktop) return;
    try { await desktop.abortNativeSave({ transactionId: this.transactionId }); } catch { /* renderer teardown may close IPC */ }
  }
}

export function markWindowsNativeSaveSeeded(mode: SaveMode): void {
  seededSlots.add(mode === "speedrun" ? "speedrun-main" : "normal-main");
}

export async function appendWindowsNativeWal(
  mode: SaveMode,
  baseRevision: number,
  revision: number,
  commandId: string,
  payload: Record<string, unknown>,
): Promise<"appended" | "not-seeded" | "fallback"> {
  const desktop = getDesktopBridge();
  if (!desktop) return "fallback";
  const slot = mode === "speedrun" ? "speedrun-main" : "normal-main";
  if (!seededSlots.has(slot)) {
    const recovery = await desktop.recoverNativeSave({ slot }).catch(() => null);
    if (!recovery) return "not-seeded";
    seededSlots.add(slot);
  }
  await desktop.appendNativeWal({ slot, baseRevision, revision, commandId, payload });
  return "appended";
}

/**
 * Windows desktop requires the private native save during the 1.2.x beta.
 * Web and Android return null and continue to use the compatible v47 path.
 */
export async function beginWindowsNativeSave(
  request: DesktopNativeSaveBeginRequest,
): Promise<NativeSaveTransaction | null> {
  const desktop = getDesktopBridge();
  if (!desktop) return null;
  const status = await desktop.getNativePerformanceStatus();
  if (!status.available || status.nativeFormatVersion !== WINDOWS_NATIVE_SAVE_FORMAT_VERSION) {
    throw new Error(status.message || "Windows 原生存档服务不可用");
  }
  const result = await desktop.beginNativeSave(request);
  return new DesktopNativeSaveTransaction(result.transactionId, request);
}
