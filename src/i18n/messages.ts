import type { AppLocale } from "./locale";

const messages = {
  saveImportReading: {
    "zh-CN": "正在读取并检查存档文件…",
    en: "Reading and checking the save file…",
  },
  contentPackImportReading: {
    "zh-CN": "正在读取并检查内容包…",
    en: "Reading and checking the content pack…",
  },
  fileImportReadFailed: {
    "zh-CN": "文件读取失败",
    en: "Could not read the file",
  },
  localSaveSecondaryTitle: {
    "zh-CN": "本页面为只读",
    en: "This tab is read-only",
  },
  localSaveSecondaryDetail: {
    "zh-CN": "另一个标签页正在管理本地存档。你可以继续查看或导出，但本页不会自动保存或覆盖它。",
    en: "Another tab is managing local saves. You can keep viewing or export, but this tab will not autosave or overwrite it.",
  },
  localSaveConflictTitle: {
    "zh-CN": "已阻止跨标签页覆盖",
    en: "Cross-tab overwrite blocked",
  },
  localSaveConflictDetail: {
    "zh-CN": "检测到存档在别处发生变化，双方版本均已保留。请在存档管理中选择要保留的版本。",
    en: "The save changed elsewhere, so both versions were preserved. Choose which version to keep in save management.",
  },
  localSaveTakeOver: {
    "zh-CN": "强制接管本页",
    en: "Force takeover here",
  },
  localSaveTakeOverUnavailable: {
    "zh-CN": "接管失败，原存档和双方页面均未被覆盖",
    en: "Takeover failed; neither save nor tab was overwritten",
  },
  localSaveKeepPersisted: {
    "zh-CN": "保留当前存档",
    en: "Keep current save",
  },
  localSaveUseCandidate: {
    "zh-CN": "采用本页候选",
    en: "Use this tab's candidate",
  },
  localSaveConflictChoice: {
    "zh-CN": "采用候选前会再次确认当前存档未发生第三次变化；失败时不会覆盖任何版本。",
    en: "Before applying the candidate, the current save is checked again. A failed check never overwrites either version.",
  },
  localSaveUnavailableTitle: {
    "zh-CN": "本地存档连接已更新",
    en: "Local save connection changed",
  },
  localSaveTemporaryTitle: {
    "zh-CN": "当前为临时运行",
    en: "This session is temporary",
  },
  localSaveTemporaryDetail: {
    "zh-CN": "当前浏览器无法保存到本机。刷新或关闭页面会丢失本次进度，请先从存档页面导出当前进度。",
    en: "This browser cannot save locally. Reloading or closing this page will lose this session's progress. Export it from the Saves tab first.",
  },
  localSaveTemporarySaveFailure: {
    "zh-CN": "当前浏览器无法保存到本机，当前进度尚未保存。请先导出当前进度。",
    en: "Local saving is unavailable; your current progress has not been saved. Export it first.",
  },
  localSaveTemporaryExportReady: {
    "zh-CN": "临时进度导出快照已生成，尚未保存到本机。",
    en: "The temporary progress is ready for export; it has not been saved locally.",
  },
  localSaveTemporaryExportUnavailable: {
    "zh-CN": "当前恢复会话无法生成独立导出，请先安全结束恢复会话。",
    en: "This recovery session cannot produce a separate export. Safely finish recovery first.",
  },
  localSaveRescueSnapshotFailure: {
    "zh-CN": "救援前恢复快照创建失败，原工厂尚未替换。请检查本地存储后重试。",
    en: "The recovery snapshot before rescue could not be saved. Your factory has not been replaced. Check local storage and retry.",
  },
  localSaveCloudSnapshotFailure: {
    "zh-CN": "云存档恢复前快照创建失败，原工厂尚未替换。请检查本地存储后重试。",
    en: "The recovery snapshot before cloud restore could not be saved. Your factory has not been replaced. Check local storage and retry.",
  },
  localSaveUnavailableDetail: {
    "zh-CN": "另一个页面已升级本地存储。请刷新本页后继续，当前页面不会写入旧连接。",
    en: "Another page upgraded local storage. Reload this tab to continue; this page will not write through the old connection.",
  },
  localSaveReload: {
    "zh-CN": "刷新页面",
    en: "Reload",
  },
} as const;

export type AppMessageKey = keyof typeof messages;

export function appMessage(locale: AppLocale, key: AppMessageKey): string {
  return messages[key][locale];
}
