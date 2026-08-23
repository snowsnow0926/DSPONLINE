export interface TextFileExport {
  contents: string;
  fileName: string;
  mimeType?: string;
  title?: string;
}

interface AndroidTextExportPlugin {
  exportAndShare(options: Required<Pick<TextFileExport, "contents" | "fileName">> & {
    mimeType: string;
    title: string;
  }): Promise<{ fileName: string; byteLength: number; chooserOpened: true }>;
  exportBase64AndShare(options: {
    contentsBase64: string;
    fileName: string;
    mimeType: string;
    title: string;
  }): Promise<{ fileName: string; byteLength: number; chooserOpened: true }>;
}

export interface BinaryFileExport {
  contents: Blob | ArrayBuffer;
  fileName: string;
  mimeType?: string;
  title?: string;
}

export function safeExportFileName(value: string): string {
  const normalized = value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/\s+/g, " ").trim();
  return (normalized || "dsp-export.json").slice(0, 120);
}

export async function exportTextFile({ contents, fileName, mimeType = "application/json", title = "导出 DSP极简网络数据" }: TextFileExport): Promise<"native" | "browser"> {
  const safeName = safeExportFileName(fileName);
  if (__APP_PLATFORM__ === "android") {
    const { Capacitor, registerPlugin } = await import("@capacitor/core");
    if (Capacitor.isNativePlatform()) {
      if (!Capacitor.isPluginAvailable("DspTextExport")) throw new Error("当前 Android 版本不支持安全文件导出");
      const result = await registerPlugin<AndroidTextExportPlugin>("DspTextExport").exportAndShare({
        contents,
        fileName: safeName,
        mimeType,
        title,
      });
      if (!result.chooserOpened) throw new Error("系统保存或分享面板未能打开");
      return "native";
    }
  }

  const blob = new Blob([contents], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = safeName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return "browser";
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkBytes = 32 * 1024;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkBytes)));
  }
  return btoa(binary);
}

export async function exportBinaryFile({
  contents,
  fileName,
  mimeType = "application/octet-stream",
  title = "导出 DSP极简网络数据",
}: BinaryFileExport): Promise<"native" | "browser"> {
  const safeName = safeExportFileName(fileName);
  const blob = contents instanceof Blob ? contents : new Blob([contents], { type: mimeType });
  if (__APP_PLATFORM__ === "android") {
    const { Capacitor, registerPlugin } = await import("@capacitor/core");
    if (Capacitor.isNativePlatform()) {
      if (!Capacitor.isPluginAvailable("DspTextExport")) throw new Error("当前 Android 版本不支持安全压缩存档导出");
      if (blob.size <= 0 || blob.size > 32 * 1024 * 1024) throw new Error("压缩导出文件超过 Android 32 MiB 安全上限");
      const result = await registerPlugin<AndroidTextExportPlugin>("DspTextExport").exportBase64AndShare({
        contentsBase64: bytesToBase64(new Uint8Array(await blob.arrayBuffer())),
        fileName: safeName,
        mimeType,
        title,
      });
      if (!result.chooserOpened) throw new Error("系统保存或分享面板未能打开");
      return "native";
    }
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = safeName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return "browser";
}
