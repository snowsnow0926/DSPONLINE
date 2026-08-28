import type { AppLocale } from "./locale";

/**
 * The start menu only needs the current release summary. Keep it in a small
 * eager module so the historical release archive stays behind the dialog's
 * lazy boundary and does not inflate the first menu render.
 */
export function getCurrentReleaseNotes(locale: AppLocale) {
  const english = locale === "en";
  return {
    id: "2026-08-28-v1.2.4",
    date: english ? "August 28, 2026" : "2026年8月28日",
    version: "1.2.4",
    title: english ? "Large Saves, Tab Takeover, and Content Pack Compatibility" : "大存档、标签页接管与内容包兼容更新",
    summary: english
      ? "Version 1.2.4 raises the cloud revision hard limit to 256 MiB, adds explicit current-tab takeover for embedded browsers, and lets content-pack buildings reuse recipes by family. Rate-replication idle copies endgame outputs only, while memory/backlog auto-pause is now off by default per device. GameState v47, save envelope v2, cloud schema v8, and SQLite layout v3 remain compatible."
      : "1.2.4 将云端单修订硬上限提高到 256 MiB，为内置浏览器提供明确的当前标签页强制接管，并让内容包建筑按配方族复用通用配方。产率复制挂机只复制终局成果；内存与积压自动暂停改为设备默认关闭。GameState v47、存档 envelope v2、cloud schema v8 与 SQLite layout v3 保持兼容。",
    items: [
      {
        id: "v124-cloud-256m",
        title: english ? "Compressed saves above 96 MiB can upload" : "96 MiB 以上大存档可压缩上传",
        description: english
          ? "Web, Windows, Android, the API, and Nginx share a 256 MiB per-revision hard limit and a bounded ten-minute transfer timeout. The 96 MiB guaranteed boundary, 30 MiB raw compatibility fallback, and account quotas remain in place."
          : "Web、Windows、Android、API 与 Nginx 共用 256 MiB 单修订硬上限和有界 10 分钟传输超时；96 MiB 保证线、30 MiB 明文兼容兜底及账号总配额仍保留。",
      },
      {
        id: "v124-tab-takeover",
        title: english ? "The current tab can explicitly take authority" : "当前标签页可明确强制接管",
        description: english
          ? "Settings and the read-only banner can advance the fencing token after confirmation, save and read back this tab's current state, and make the former tab read-only. The former primary remains a backup and its uncommitted pure-idle tail is not awarded."
          : "设置和只读提示均可在确认后推进防覆盖令牌，以本页当前状态保存并回读；旧标签页立即只读，旧主存档仍作备份，旧页未提交的纯挂机尾段不结算。",
      },
      {
        id: "v124-content-family",
        title: english ? "Dark Fog buildings can reuse generic recipes" : "黑雾建筑可复用通用配方",
        description: english
          ? "Content packs may declare a smelter, assembler, or chemical recipe family. Negentropy smelters and re-composing assemblers can use matching generic recipes without duplicating the core catalog."
          : "内容包可声明 smelter、assembler 或 chemical 配方族；负熵熔炉和重组式制造台无需复制整套基础配方即可使用对应通用配方。",
      },
      {
        id: "v124-endgame-replication",
        title: english ? "Rate replication awards endgame outputs only" : "产率复制只发放终局成果",
        description: english
          ? "The material allowlist contains only universe matrices, small carrier rockets, and solar sails. Research and per-system Dyson events remain separate while ordinary inventory no longer expands."
          : "材料白名单仅含白矩阵、小型运载火箭和太阳帆；科研与逐恒星系戴森事件继续独立复制，普通库存不再膨胀。",
      },
      {
        id: "v124-memory-guard-default-off",
        title: english ? "Memory and backlog auto-pause defaults off" : "内存与积压自动暂停默认关闭",
        description: english
          ? "New devices and browsers without a saved preference keep running instead of auto-pausing on heap or simulation backlog pressure. An explicit existing device choice is preserved, while Worker, checkpoint, and allocation-failure safeguards remain."
          : "新设备或没有保存过该偏好的浏览器默认继续运行，不因堆水位或模拟积压自动暂停；曾明确开启或关闭的设备选择继续保留，Worker、检查点和分配失败保护不变。",
      },
      {
        id: "v124-compatibility-boundary",
        title: english ? "Save and server data formats do not change" : "存档与服务器数据格式不升级",
        description: english
          ? "This release changes bounded transfer, tab write authority, runtime content catalogs, and an optional idle algorithm only; it does not migrate player state, the cloud schema, or the SQLite layout."
          : "本版仅调整有界传输、标签页写入权、运行时内容目录与可选挂机算法；不迁移玩家状态、云 schema 或 SQLite layout。",
      },
    ],
  } as const;
}
