import type { AppLocale } from "./locale";

/**
 * The start menu only needs the current release summary. Keep it in a small
 * eager module so the historical release archive stays behind the dialog's
 * lazy boundary and does not inflate the first menu render.
 */
export function getCurrentReleaseNotes(locale: AppLocale) {
  const english = locale === "en";
  return {
    id: "2026-08-24-v1.1.7",
    date: english ? "August 24, 2026" : "2026年8月24日",
    version: "1.1.7",
    title: english ? "Cloud Contract Repair and Mod Building Trays" : "云存档合同修复与 Mod 建筑托盘",
    summary: english
      ? "Version 1.1.7 repairs same-task-day orbital station contract reoffers that reused IDs across history and active entries and were rejected by cloud validation as SAVE_FORMAT_INVALID. Migration preserves settled rewards and removes only entries that can no longer be claimed. Content-pack buildings now appear in desktop and mobile deployment trays with generic kind-based categories. GameState v47, save envelope v2, cloud schema v8, and SQLite layout v3 remain unchanged."
      : "1.1.7 修复空间站合同在同一任务日重复生成、导致历史合同与活动合同使用同一 ID 并被云端判定 SAVE_FORMAT_INVALID 的问题；迁移时保留已结算奖励并清除不可再次领取的重复项。内容包注册的自定义建筑现在进入桌面和移动端部署托盘，按通用建筑类型归类；GameState v47、存档 envelope v2、cloud schema v8、SQLite layout v3 不变。",
    items: [
      {
        id: "station-contract-id-repair",
        title: english ? "Orbital contract ID collisions self-heal" : "空间站合同 ID 冲突可自愈",
        description: english
          ? "When an older save is loaded, settled history and settledIds form a reward fence. Duplicate offer, accepted, and history entries keep only an authoritative verifiable record, so claimed rewards are preserved and cannot be claimed again."
          : "加载旧版存档时，已结算历史和 settledIds 组成奖励围栏；重复的 offer、accepted 和 history 条目只保留可验证的权威记录，已领取奖励不会丢失，也不会被再次领取。",
      },
      {
        id: "station-contract-server-validation",
        title: english ? "Cloud validation keeps a narrow compatibility boundary" : "云端校验保留兼容边界",
        description: english
          ? "The server continues to reject forged collisions between active contracts. It accepts only a legacy offer/history overlap with settledIds and an exact identity match; altered reward fields remain invalid."
          : "服务端继续拒绝活动合同之间的伪造碰撞；仅对带 settledIds 且正文身份完全一致的旧版 offer/history 重叠保留兼容，奖励字段被篡改仍会被拒绝。",
      },
      {
        id: "custom-building-trays",
        title: english ? "Custom buildings appear in deployment trays" : "自定义建筑进入部署托盘",
        description: english
          ? "Content-pack buildings with valid costs are appended after core buildings in a stable order on desktop and mobile trays. Generic kinds map to their corresponding categories without changing core order."
          : "拥有有效成本的内容包建筑会按核心建筑之后的稳定顺序加入桌面和移动端托盘；通用 kind 会映射到对应分类，旧建筑顺序不变。",
      },
      {
        id: "declarative-mod-contract",
        title: english ? "Mod extension boundaries stay verifiable" : "Mod 扩展边界保持可验证",
        description: english
          ? "Content packs remain declarative JSON with no script injection. True conveyor tiers should use belts entries; a building with kind splitter does not automatically gain all conveyor semantics, and building/belt ID collisions fail validation."
          : "内容包仍使用声明式 JSON，不开放脚本注入；真正的传送带等级应使用 belts 条目，建筑 kind 为 splitter 的条目不会自动获得传送带全部语义，建筑 ID 与 belt ID 冲突会在校验阶段拒绝。",
      },
      {
        id: "version-upgrade",
        title: english ? "Existing saves and 1.1.6 remain readable" : "旧存档与 1.1.6 可继续读取",
        description: english
          ? "This release does not upgrade GameState, the save envelope, cloud schema, SQLite layout, or Mod JSON format. 1.1.6 saves, cloud revisions, blueprints, and core building order remain compatible."
          : "本版不升级 GameState、存档封装、云 schema、SQLite layout 或 Mod JSON 格式；1.1.6 的保存、云修订、蓝图和核心建筑顺序保持兼容。",
      },
      {
        id: "contract-mod-regression",
        title: english ? "Contracts, trays, and server validation are regression-gated" : "合同、托盘和服务端加入回归门禁",
        description: english
          ? "Regression coverage includes the affected duplicate-ID shape, reward fences, forged server collisions, custom splitter tray classification, and dynamic desktop/mobile catalogs."
          : "回归覆盖实际重复 ID 形状、奖励围栏、服务端伪造碰撞、自定义 splitter 托盘分类，以及桌面/移动端动态目录。",
      },
    ],
  } as const;
}
