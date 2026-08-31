import {
  readNativeBlueprintImportFile,
  type NativeBlueprintImportInputFailure,
  type NativeBlueprintImportInputResult,
} from "./nativeBlueprintImportInput";

export type BlueprintExchangeFileResult = NativeBlueprintImportInputResult;

/** Shared byte-preserving file boundary used by the Web/PWA import picker. */
export function readBlueprintExchangeFile(
  file: Pick<File, "size" | "arrayBuffer">,
): Promise<BlueprintExchangeFileResult> {
  return readNativeBlueprintImportFile(file);
}

/** Calls the exchange importer only after every byte-level file check succeeds. */
export async function dispatchBlueprintExchangeFile(
  file: Pick<File, "size" | "arrayBuffer">,
  onImport: (raw: string) => void,
): Promise<BlueprintExchangeFileResult> {
  const result = await readBlueprintExchangeFile(file);
  if (result.ok) onImport(result.raw);
  return result;
}

export function blueprintExchangeFileFailureMessage(reason: NativeBlueprintImportInputFailure): string {
  switch (reason) {
    case "empty": return "蓝图文件为空";
    case "invalid-unicode": return "蓝图文件包含无效 Unicode 字符";
    case "invalid-utf8": return "蓝图文件不是有效且可逐字往返的 UTF-8";
    case "too-large": return "蓝图文件超过 1 MiB 安全上限或读取大小发生变化";
    case "read-failed": return "无法读取蓝图文件";
  }
}
