import { AlertTriangle, LockKeyhole, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useAppLocale } from "../i18n/locale";
import { appMessage } from "../i18n/messages";
import { requestCurrentTabTakeover } from "../game/localSaveTakeover";
import {
  getLocalSaveWriterStatus,
  getLocalSaveConflicts,
  resolveLocalSaveConflictDetailed,
  subscribeLocalSaveWriterStatus,
  type LocalSaveConflictSummary,
} from "../game/localSaveStore";
import { useGameDialog } from "./GameDialogProvider";

export function LocalSaveWriterBanner() {
  const { locale } = useAppLocale();
  const gameDialog = useGameDialog();
  const [status, setStatus] = useState(getLocalSaveWriterStatus);
  const [takingOver, setTakingOver] = useState(false);
  const [takeOverFailed, setTakeOverFailed] = useState(false);
  const [takeOverMessage, setTakeOverMessage] = useState<string | null>(null);
  const [activeResolution, setActiveResolution] = useState<"candidate" | "persisted" | null>(null);
  const [resolutionMessage, setResolutionMessage] = useState<{ tone: "busy" | "success" | "error"; text: string } | null>(null);
  const [conflictSummary, setConflictSummary] = useState<LocalSaveConflictSummary | null>(null);

  const refreshConflict = useCallback(() => {
    void getLocalSaveConflicts().then((conflicts) => setConflictSummary(
      conflicts.find((entry) => entry.conflictId === status.conflictId) ?? conflicts[0] ?? null,
    ));
  }, [status.conflictId]);

  useEffect(() => subscribeLocalSaveWriterStatus(setStatus), []);
  useEffect(() => { if (status.role === "conflict") refreshConflict(); }, [refreshConflict, status.role]);
  if (status.role !== "secondary" && status.role !== "conflict" && status.role !== "unavailable" && !conflictSummary && !resolutionMessage) return null;

  const conflict = status.role === "conflict" || conflictSummary !== null || resolutionMessage !== null;
  const unavailable = status.role === "unavailable";
  const title = appMessage(locale, conflict ? "localSaveConflictTitle" : unavailable ? "localSaveUnavailableTitle" : "localSaveSecondaryTitle");
  const detail = appMessage(locale, conflict ? "localSaveConflictDetail" : unavailable ? "localSaveUnavailableDetail" : "localSaveSecondaryDetail");
  const canTakeOver = status.role === "secondary";
  const resolveConflict = (resolution: "candidate" | "persisted") => {
    if (!conflictSummary || takingOver) return;
    const startedAt = performance.now();
    setTakingOver(true);
    setTakeOverFailed(false);
    setActiveResolution(resolution);
    setResolutionMessage({
      tone: "busy",
      text: resolution === "candidate" ? "正在校验并采用候选存档…" : "正在校验并保留当前状态…",
    });
    void resolveLocalSaveConflictDetailed(conflictSummary.conflictId, resolution).then(async (result) => {
      const remainingFeedbackMs = Math.max(0, 300 - (performance.now() - startedAt));
      if (remainingFeedbackMs > 0) await new Promise<void>((resolve) => window.setTimeout(resolve, remainingFeedbackMs));
      if (!result.ok) {
        setTakeOverFailed(true);
        setResolutionMessage({ tone: "error", text: result.message });
        return;
      }
      setResolutionMessage({
        tone: "success",
        text: resolution === "candidate" ? "候选存档已逐字读回验证，正在进入游戏…" : "当前状态已验证，正在重新载入…",
      });
      window.setTimeout(() => window.location.reload(), 1_000);
    }).catch((error) => {
      setTakeOverFailed(true);
      setResolutionMessage({ tone: "error", text: error instanceof Error ? error.message : "恢复失败，冲突副本仍已保留" });
    }).finally(() => {
      setTakingOver(false);
      setActiveResolution(null);
    });
  };
  return (
    <aside className={`local-save-writer-banner local-save-writer-banner--${conflict ? "conflict" : status.role}`} role="alert" aria-live="assertive">
      {conflict ? <AlertTriangle size={19} /> : <LockKeyhole size={19} />}
      <span><strong>{title}</strong><small>{detail}{status.conflictId ? ` · ${status.conflictId}` : ""}</small>{conflictSummary ? <small>
        {locale === "en" ? "Current" : "当前"}: {conflictSummary.persisted.savedAt ? new Date(conflictSummary.persisted.savedAt).toLocaleString(locale) : conflictSummary.persisted.missing ? (locale === "en" ? "empty (keeping it leaves no main save)" : "空（保留后没有主存档）") : "--"}
        {" · "}{locale === "en" ? "Candidate" : "候选"}: {conflictSummary.candidate.savedAt ? new Date(conflictSummary.candidate.savedAt).toLocaleString(locale) : conflictSummary.candidate.deleted ? (locale === "en" ? "delete request" : "删除请求") : "--"}
      </small> : null}{conflictSummary?.persisted.missing && conflictSummary.candidate.available ? <small className="local-save-writer-banner__recommendation">{locale === "en" ? "Recommended: use the validated candidate." : "推荐：采用有效候选存档。"}</small> : null}</span>
      {canTakeOver ? <button type="button" disabled={takingOver} onClick={() => {
        void (async () => {
          const confirmed = await gameDialog.confirm(
            locale === "en"
              ? "Force this tab to become authoritative? The other tab will become read-only. This tab will be saved and verified first; its current progress wins, while the previous persisted save remains as a backup. Any uncommitted pure-idle time in the other tab will not be awarded."
              : "确认强制接管当前标签页？另一个标签页会立即转为只读。本页会先保存并回读校验，以本页当前进度为准；接管前的主存档仍保留为备份。另一个标签页尚未提交的纯挂机时间不会结算。",
            { danger: true, title: locale === "en" ? "Force current tab takeover" : "强制接管当前标签页", confirmLabel: locale === "en" ? "Take over this tab" : "确认接管本页" },
          );
          if (!confirmed) return;
          setTakingOver(true);
          setTakeOverFailed(false);
          setTakeOverMessage(locale === "en" ? "Taking over and verifying the save…" : "正在接管并校验存档…");
          try {
            const result = await requestCurrentTabTakeover();
            setTakeOverFailed(!result.ok);
            setTakeOverMessage(result.message);
            if (result.ok && result.reload) window.setTimeout(() => window.location.reload(), 300);
          } catch (error) {
            setTakeOverFailed(true);
            setTakeOverMessage(error instanceof Error ? error.message : appMessage(locale, "localSaveTakeOverUnavailable"));
          } finally {
            setTakingOver(false);
          }
        })();
      }} title={canTakeOver ? undefined : appMessage(locale, "localSaveTakeOverUnavailable")}>
        <RefreshCw size={14} />{appMessage(locale, "localSaveTakeOver")}
      </button> : null}
      {conflict && conflictSummary ? <div className="local-save-writer-banner__actions">
        <button type="button" disabled={takingOver} onClick={() => resolveConflict("persisted")}>{activeResolution === "persisted" ? (locale === "en" ? "Processing…" : "处理中…") : conflictSummary.persisted.missing ? (locale === "en" ? "Keep empty current state" : "保留空的当前状态") : appMessage(locale, "localSaveKeepPersisted")}</button>
        <button className={conflictSummary.persisted.missing ? "recommended" : "danger"} type="button" disabled={takingOver || !conflictSummary.candidate.available && !conflictSummary.candidate.deleted} title={appMessage(locale, "localSaveConflictChoice")} onClick={() => resolveConflict("candidate")}>{activeResolution === "candidate" ? (locale === "en" ? "Processing…" : "处理中…") : appMessage(locale, "localSaveUseCandidate")}</button>
      </div> : null}
      {unavailable ? <button type="button" onClick={() => window.location.reload()}><RefreshCw size={14} />{appMessage(locale, "localSaveReload")}</button> : null}
      {resolutionMessage ? <em className={`local-save-writer-banner__result local-save-writer-banner__result--${resolutionMessage.tone}`} role="status">{resolutionMessage.text}</em> : takeOverMessage ? <em className={`local-save-writer-banner__result local-save-writer-banner__result--${takeOverFailed ? "error" : "busy"}`} role="status">{takeOverMessage}</em> : takeOverFailed ? <em>{appMessage(locale, "localSaveTakeOverUnavailable")}</em> : null}
    </aside>
  );
}
