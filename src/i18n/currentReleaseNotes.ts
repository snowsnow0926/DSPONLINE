import type { AppLocale } from "./locale";

/**
 * The start menu only needs the current release summary. Keep it in a small
 * eager module so the historical release archive stays behind the dialog's
 * lazy boundary and does not inflate the first menu render.
 */
export function getCurrentReleaseNotes(locale: AppLocale) {
  const english = locale === "en";
  return {
    id: "2026-08-31-v1.2.6",
    date: english ? "August 31, 2026" : "2026年8月31日",
    version: "1.2.6",
    title: english ? "Direct Endgame Settlement and Planet Factory Reset" : "终局直结与星球工厂重置",
    summary: english
      ? "Version 1.2.6 settles rate-replication idle gains directly into research and per-system Dyson progress instead of fabricating inventory, and adds a three-confirmation planet factory reset to the star map. Reset removes the chosen planet's player factory without refilling natural resources or changing global progression. GameState v47, save envelope v2, cloud schema v8, and SQLite layout v3 remain compatible."
      : "1.2.6 将产率复制挂机的收益直接结算到科研和逐恒星系戴森进度，不再向库存或量子仓库凭空写入物品；星图新增三次确认的星球工厂重置。重置只拆除所选星球的玩家工厂，不补满天然资源，也不改变全局进度。GameState v47、存档 envelope v2、cloud schema v8 与 SQLite layout v3 保持兼容。",
    items: [
      {
        id: "v126-terminal-direct-settlement",
        title: english ? "Rate replication settles only terminal outcomes" : "产率复制只直结终局成果",
        description: english
          ? "The locked statistical window advances actual white-matrix research and the matching system's Dyson structure and shell absorption directly. It never writes copied materials, rockets, or sails into planetary trays, machine buffers, construction buffers, or quantum storage."
          : "锁定的统计窗口会直接推进真实白矩阵科研，以及对应恒星系的戴森结构和壳面吸收；不会把复制的材料、火箭或太阳帆写进行星托盘、机器缓存、施工缓存或量子仓库。",
      },
      {
        id: "v126-no-deferred-inventory",
        title: english ? "Missing terminal targets create no deferred inventory" : "没有终局目标就不生成延期库存",
        description: english
          ? "If no current research or matching Dyson plan can receive a channel, that interval's credit is discarded. Construction megastructures continue to consume only real player-owned materials."
          : "如果当前没有可接收的科研或对应戴森计划，该通道本段额度会直接舍弃；建筑制造巨构仍只消耗玩家真实拥有的材料。",
      },
      {
        id: "v126-planet-factory-reset",
        title: english ? "Reset one colonized planet from the star map" : "在星图重置一颗已殖民星球",
        description: english
          ? "After three distinct confirmations, including typing the exact displayed planet name, the game permanently removes that planet's buildings, miners, belts, local stores, queues, and related logistics routes. The action gives no refunds and cannot be undone."
          : "连续完成范围、不可撤销后果和精确星球名称三次确认后，游戏会永久删除该星球的建筑、采集设备、传送带、本地物资、队列及相关物流航线；不返料且不可撤销。",
      },
      {
        id: "v126-reset-preservation-boundary",
        title: english ? "Natural resources and global progress are preserved" : "天然资源与全局进度保持不变",
        description: english
          ? "Vein identity, location, resource type, current remaining reserves, depletion remainder, colonization metadata, research, Dyson projects, quantum storage, global construction stock, portable fleet, and blueprints are preserved. Reset never refills ore."
          : "矿脉身份、位置、类型、当前剩余储量和枯竭余数，以及殖民资料、科研、戴森工程、量子仓库、全局施工库存、随身舰队和蓝图均保留；重置不会补矿。",
      },
      {
        id: "v126-compatibility-boundary",
        title: english ? "Save and server formats remain compatible" : "存档与服务器格式保持兼容",
        description: english
          ? "This release changes settlement commands and star-map interaction without adding persisted fields or migrating cloud payloads or the production database."
          : "本版只调整结算命令和星图交互，不增加持久化字段，也不迁移云存档正文或生产数据库。",
      },
    ],
  } as const;
}
