import type { AppLocale } from "./locale";

/**
 * The start menu only needs the current release summary. Keep it in a small
 * eager module so the historical release archive stays behind the dialog's
 * lazy boundary and does not inflate the first menu render.
 */
export function getCurrentReleaseNotes(locale: AppLocale) {
  const english = locale === "en";
  return {
    id: "2026-08-26-v1.1.9",
    date: english ? "August 26, 2026" : "2026年8月26日",
    version: "1.1.9",
    title: english ? "Large-factory JavaScript Architecture Optimization" : "大型工厂 JavaScript 架构优化",
    summary: english
      ? "Version 1.1.9 adds copy-on-write edits, bounded delta history, cumulative large-factory UI projections, and back-pressured single-owner saves. Existing v47 / envelope v2 saves remain compatible."
      : "1.1.9 为大型工厂加入写时复制编辑、有界差异历史、累计 UI 投影和带回压的单所有权保存；旧版 v47 / envelope v2 存档继续兼容。",
    items: [
      {
        id: "copy-on-write-factory-edits",
        title: english ? "Factory edits copy only changed records" : "工厂编辑只复制变化记录",
        description: english
          ? "Common building, removal, belt, and blueprint commands preserve unchanged entity and belt references instead of deep-cloning the full factory."
          : "常见建造、回收、线路和蓝图命令保留未变化实体与线路的引用，不再深拷贝整个工厂。",
      },
      {
        id: "bounded-delta-history",
        title: english ? "Undo uses bounded inverse deltas" : "撤销使用有界逆向差异",
        description: english
          ? "Undo no longer retains full GameState snapshots or rewinds simulation time settled after an edit."
          : "撤销不再保留完整 GameState 快照，也不会回退操作之后已经结算的模拟时间。",
      },
      {
        id: "single-owner-chunk-save",
        title: english ? "Large autosaves stream bounded pages" : "大型自动保存流式提交有界数据页",
        description: english
          ? "The authority Worker projects bounded pages into the page-owned IndexedDB writer with ACK backpressure, without transferring a second complete checkpoint."
          : "权威 Worker 以 ACK 回压把有界数据页交给页面持有的 IndexedDB writer，不再传输第二份完整检查点。",
      },
      {
        id: "cumulative-large-factory-projection",
        title: english ? "Large-factory UI copies are coalesced" : "大型工厂界面复制合并处理",
        description: english
          ? "Exact simulation revisions continue normally while idle record projections are accumulated; commands and active editing still publish immediately."
          : "精确模拟 revision 正常推进，空闲时的记录投影合并后发布；玩家命令和活动编辑仍立即刷新。",
      },
      {
        id: "dirty-runtime-index",
        title: english ? "Simulation commands use stable dirty indexes" : "模拟命令使用稳定脏索引",
        description: english
          ? "Runtime-only leaves apply in place; recipe and topology changes retain the deterministic full-rebuild fallback."
          : "仅运行时字段在 Worker 内原地应用；配方和拓扑变化继续保留确定性的完整重建回退。",
      },
      {
        id: "memory-pause-no-rollback",
        title: english ? "Memory protection preserves visible progress" : "内存保护保留当前可见进度",
        description: english
          ? "A protection pause no longer installs an older checkpoint or drops queued simulation time."
          : "保护暂停不再安装旧检查点，也不再清空已经积累的待结算时间。",
      },
      {
        id: "version-compatibility",
        title: english ? "Existing saves and cloud protocols remain compatible" : "旧存档与云端协议保持兼容",
        description: english
          ? "GameState v47, save envelope v2, cloud schema v8, and SQLite layout v3 remain unchanged."
          : "GameState v47、存档 envelope v2、cloud schema v8 和 SQLite layout v3 保持不变。",
      },
    ],
  } as const;
}
