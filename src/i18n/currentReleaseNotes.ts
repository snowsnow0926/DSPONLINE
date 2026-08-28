import type { AppLocale } from "./locale";

/**
 * The start menu only needs the current release summary. Keep it in a small
 * eager module so the historical release archive stays behind the dialog's
 * lazy boundary and does not inflate the first menu render.
 */
export function getCurrentReleaseNotes(locale: AppLocale) {
  const english = locale === "en";
  return {
    id: "2026-08-28-v1.2.3",
    date: english ? "August 28, 2026" : "2026年8月28日",
    version: "1.2.3",
    title: english ? "Endgame Automation, Idle Modes, and Windows Performance" : "终局自动化、挂机模式与 Windows 性能更新",
    summary: english
      ? "Version 1.2.3 improves recursive construction, offline/time-warp settlement, and the Windows native hot paths. Eligible normal saves can opt into rate-replication idle mode, while the original conservation mode remains available. The mobile full inspector is visible in both light and dark themes. GameState v47, save envelope v2, cloud schema v8, and SQLite layout v3 remain compatible."
      : "1.2.3 优化递归建筑制造、离线/时间扭曲结算与 Windows 原生热路径；符合条件的普通存档可主动选择产率复制挂机，原守恒模式继续保留。手机完整检查器在浅色和深色主题下均可正常显示。GameState v47、存档 envelope v2、cloud schema v8 与 SQLite layout v3 保持兼容。",
    items: [
      {
        id: "construction-offline-timewarp",
        title: english ? "Construction and offline settlement stay productive" : "建筑制造与离线结算持续产出",
        description: english
          ? "Construction reserves inputs atomically and resumes unfinished dependency chains. Multi-system rocket ledgers and rolling time-warp certificates keep proven endgame production moving without losing a committed checkpoint."
          : "建筑制造会原子预留输入并续接未完成依赖链；逐恒星系火箭账本与滚动时间扭曲证书让已证明的终局产线持续运行，同时保留已提交检查点。",
      },
      {
        id: "pure-idle-rate-replication",
        title: english ? "Eligible saves can choose rate-replication idle mode" : "符合条件的存档可选择产率复制挂机",
        description: english
          ? "Normal saves whose five infinite-tech effective levels total more than 200 may copy positive 60/30-s production statistics at the locked power multiplier. It is explicitly optional and does not replace conservation idle mode."
          : "普通存档五项无限科技有效等级合计大于 200 后，可按锁定供电倍率复制最近 60/30 模拟秒的正向产率；该模式由玩家主动选择，不替代原守恒挂机。",
      },
      {
        id: "windows-native-stable-integration",
        title: english ? "Windows native hot paths retain the stable app identity" : "Windows 原生热路径接回正式版身份",
        description: english
          ? "Dirty-page saves, bounded projections, streaming v47 import/export, and deterministic native-core support ship under the existing stable app and user-data identity. JavaScript remains player-visible authority where native coverage is not eligible."
          : "脏页存档、有界投影、v47 流式导入导出与确定性原生核心能力使用既有正式应用及用户数据身份发布；原生覆盖不合格的领域仍由 JavaScript 作为玩家可见权威。",
      },
      {
        id: "mobile-light-full-inspector",
        title: english ? "The mobile full inspector works in light theme" : "手机浅色主题完整检查器不再空白",
        description: english
          ? "The empty sheet bridge no longer paints an opaque white surface over the real advanced inspector, while dark-theme layering and touch behavior remain unchanged."
          : "空白桥接抽屉不再用白色背景遮住真正的高级检查器；深色主题层级和触控行为保持不变。",
      },
      {
        id: "v123-compatibility-boundary",
        title: english ? "Save, cloud, and rollback formats remain compatible" : "存档、云端与回滚格式保持兼容",
        description: english
          ? "No GameState, envelope, cloud schema, or SQLite layout migration is introduced. Production-history windows remain runtime-only and do not enlarge saved files."
          : "本版不升级 GameState、envelope、cloud schema 或 SQLite layout；生产历史窗口仍只存在运行态，不会增大持久存档。",
      },
    ],
  } as const;
}
