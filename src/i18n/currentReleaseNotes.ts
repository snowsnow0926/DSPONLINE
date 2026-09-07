import type { AppLocale } from "./locale";

export const CURRENT_RELEASE_ID = "2026-09-08-v1.2.7";

/**
 * The start menu only needs the current release summary. Keep it in a small
 * eager module so the historical release archive stays behind the dialog's
 * lazy boundary and does not inflate the first menu render.
 */
export function getCurrentReleaseNotes(locale: AppLocale) {
  const english = locale === "en";
  return {
    id: CURRENT_RELEASE_ID,
    date: english ? "September 8, 2026" : "2026年9月8日",
    version: "1.2.7",
    title: english ? "Web and Android: Save and Offline Preparation Improvements" : "网页版与安卓版：保存及离线准备优化",
    summary: english
      ? "Version 1.2.7 improves saving, importing, and offline preparation on Web and Android, along with recovery and save retries after stopping idle mode. Version 1.2.6 gameplay and existing saves remain compatible. The Windows download stays at its current version."
      : "1.2.7 为网页版和安卓版带来保存、导入与离线准备优化，并改进挂机停止后的恢复与保存重试。保留 1.2.6 的游戏规则与旧存档兼容性，Windows 下载版本维持现状。",
    items: [
      {
        id: "v127-save-import",
        title: english ? "Less overhead when saving and importing" : "保存与导入减少重复处理",
        description: english
          ? "Large saves require less repeated copying and checking during saving and import. JSON and gzip files remain supported, with integrity checks and recovery options preserved. Importing does not overwrite the original file."
          : "大存档保存和导入减少重复复制与检查，继续支持 JSON 和 gzip 文件，并保留完整性校验与救援选项。导入不会覆盖原始文件。",
      },
      {
        id: "v127-automatic-snapshots",
        title: english ? "Automatic recovery snapshots do less repeated work" : "自动快照减少重复处理",
        description: english
          ? "Automatic recovery snapshots reuse the save that was just verified, while keeping their own integrity checks. A failed snapshot does not undo a successful main save, and manual snapshots remain available."
          : "自动恢复快照复用刚刚验证成功的主存档，同时保留独立校验。快照失败不会撤销已成功的主存档保存，手动快照仍可正常使用。",
      },
      {
        id: "v127-offline-preparation",
        title: english ? "Lighter offline preparation" : "离线准备更轻量",
        description: english
          ? "Returning to a large factory involves fewer repeated checks and copies before offline settlement. Complex factories may still ask you to choose how to proceed; cancel and exact retry remain available, with production rules unchanged."
          : "返回大型工厂时，离线结算前减少重复检查与复制。复杂工厂仍可能需要玩家选择结算方式，取消和精确重试保持可用，产出规则不变。",
      },
      {
        id: "v127-idle-recovery",
        title: english ? "More reliable idle stopping and recovery" : "挂机停止与恢复更可靠",
        description: english
          ? "Fixes a case where stopping idle mode could reopen the recovery screen. If saving fails after settlement completes, retry reuses that result while the page remains open. Export Recovery Data stays available independently; its private diagnostic file is not a completed save and is never uploaded automatically."
          : "修复停止挂机时恢复界面可能被再次触发的问题。结算完成但保存失败时，同一页面内重试会复用本次结果；也可独立“导出恢复数据”。诊断文件包含私人数据，不代表已结算存档，不会自动上传。",
      },
      {
        id: "v127-gameplay-compatibility",
        title: english ? "Version 1.2.6 gameplay and existing saves are preserved" : "保留 1.2.6 玩法与旧存档",
        description: english
          ? "Rate replication still advances white-matrix research and per-system Dyson progress. Planet factory reset still requires three confirmations and preserves natural resource reserves and global progress. Existing saves remain usable without a format upgrade."
          : "产率复制继续直结白矩阵科研和逐恒星系戴森进度。星球工厂重置仍需三次确认，并保留天然资源储量与全局进度。旧存档可继续使用，无需升级存档格式。",
      },
      {
        id: "v127-release-scope",
        title: english ? "What this release includes" : "本次更新范围",
        description: english
          ? "Web and Android receive the shared save and offline preparation improvements. Bringing the Rust core to these platforms remains future work. The Windows download stays at its current version."
          : "网页版和安卓版采用共同的保存与离线准备优化。Rust 核心的跨端接入将继续开发，Windows 下载版本维持现状。",
      },
    ],
  } as const;
}
