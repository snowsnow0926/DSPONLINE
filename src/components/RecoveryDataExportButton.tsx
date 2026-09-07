import { useRef, useState } from "react";
import { Download } from "lucide-react";
import type { RecoveryDataExportInput } from "../game/recoveryDataExport";
import "../styles/recovery-data-export.css";

/** Independent of settlement, persistence and recovery ownership callbacks. */
export function RecoveryDataExportButton(props: RecoveryDataExportInput) {
  const exportingRef = useRef(false);
  const [exporting, setExporting] = useState(false);
  const [message, setMessage] = useState("");
  const download = async () => {
    if (exportingRef.current) return;
    exportingRef.current = true;
    setExporting(true);
    setMessage("正在读取恢复数据，不会重新结算或改写存档…");
    try {
      const { exportRecoveryData } = await import("../game/recoveryDataExport");
      const result = await exportRecoveryData(props);
      setMessage(`${result.destination === "native" ? "已打开系统保存或分享面板" : "已发起恢复数据下载"}${result.partial ? "；部分本地日志无法读取，包内已注明" : ""}。请妥善保管私人数据。`);
    } catch {
      // Never render arbitrary storage/plugin errors: they may include payloads.
      setMessage("导出未完成，原存档与恢复日志未改变。请重试，并保留本地数据。");
    } finally {
      exportingRef.current = false;
      setExporting(false);
    }
  };
  return <section className="recovery-data-export" aria-label="恢复数据导出">
    <button type="button" disabled={exporting} onClick={() => void download()}>
      <Download size={16} /><span>{exporting ? "正在导出恢复数据…" : "导出恢复数据"}</span>
    </button>
    <small>包含私人存档和恢复日志，仅保存到本机或由你主动分享；诊断包不代表已结算结果。</small>
    {message ? <p role="status" aria-live="polite">{message}</p> : null}
  </section>;
}
