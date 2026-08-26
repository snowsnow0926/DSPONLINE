import {
  getDesktopBridge,
  type DesktopNativeCoreCompareResult,
  type DesktopNativeCoreOpenResult,
  type DesktopNativeCoreSummary,
  type DesktopNativeSaveCommitResult,
} from "../desktop";
import type { ContentPackRuntimeSnapshot } from "./contentPacks";
import { createNativeCoreCatalog } from "./nativeCoreCatalog";
import type { SimulationCommandPatch } from "./simulationRuntimeProtocol";
import type { SaveMode } from "./types";

export interface WindowsNativeCoreShadow {
  readonly sessionId: string;
  readonly checkpoint: DesktopNativeSaveCommitResult;
  status(): Promise<DesktopNativeCoreSummary>;
  applyCommand(command: SimulationCommandPatch): Promise<{ revision: number; topologyDirty: boolean }>;
  compare(expected: { revision: number; canonicalSha256: string; domainSha256: string }): Promise<DesktopNativeCoreCompareResult>;
  close(): Promise<void>;
}

class DesktopNativeCoreShadow implements WindowsNativeCoreShadow {
  private closed = false;

  constructor(
    readonly sessionId: string,
    readonly checkpoint: DesktopNativeSaveCommitResult,
  ) {}

  async status(): Promise<DesktopNativeCoreSummary> {
    if (this.closed) throw new Error("Windows 原生核心影子会话已关闭");
    const desktop = getDesktopBridge();
    if (!desktop) throw new Error("Windows 原生核心桥接已断开");
    return desktop.getNativeCoreStatus({ sessionId: this.sessionId });
  }

  async applyCommand(command: SimulationCommandPatch): Promise<{ revision: number; topologyDirty: boolean }> {
    if (this.closed) throw new Error("Windows 原生核心影子会话已关闭");
    const desktop = getDesktopBridge();
    if (!desktop) throw new Error("Windows 原生核心桥接已断开");
    const result = await desktop.applyNativeCoreCommand({
      sessionId: this.sessionId,
      command: command as unknown as Record<string, unknown>,
    });
    return { revision: result.revision, topologyDirty: result.topologyDirty };
  }

  compare(expected: { revision: number; canonicalSha256: string; domainSha256: string }): Promise<DesktopNativeCoreCompareResult> {
    if (this.closed) return Promise.reject(new Error("Windows 原生核心影子会话已关闭"));
    const desktop = getDesktopBridge();
    if (!desktop) return Promise.reject(new Error("Windows 原生核心桥接已断开"));
    return desktop.compareNativeCore({ sessionId: this.sessionId, ...expected });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const desktop = getDesktopBridge();
    if (!desktop) return;
    await desktop.closeNativeCore({ sessionId: this.sessionId });
  }
}

export async function openWindowsNativeCoreShadow(
  mode: SaveMode,
  checkpoint: DesktopNativeSaveCommitResult,
  runtime: ContentPackRuntimeSnapshot,
): Promise<WindowsNativeCoreShadow | null> {
  const desktop = getDesktopBridge();
  if (!desktop) return null;
  const status = await desktop.getNativePerformanceStatus();
  if (!status.available || !status.capabilities.includes("native-core-shadow-v1")) return null;
  const opened: DesktopNativeCoreOpenResult = await desktop.openNativeCore({
    slot: mode === "speedrun" ? "speedrun-main" : "normal-main",
    generation: checkpoint.generation,
    rootHash: checkpoint.rootHash,
    revision: checkpoint.revision,
    registryFingerprint: runtime.fingerprint,
    catalog: createNativeCoreCatalog(runtime),
  });
  if (opened.authority !== "shadow" || opened.summary.revision !== checkpoint.revision ||
    opened.summary.registryFingerprint !== runtime.fingerprint || opened.summary.coverage.authorityEligible) {
    await desktop.closeNativeCore({ sessionId: opened.sessionId }).catch(() => undefined);
    throw new Error("Windows 原生核心影子检查点身份无效");
  }
  return new DesktopNativeCoreShadow(opened.sessionId, checkpoint);
}

