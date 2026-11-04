import type { AppLocale } from "./locale";

export const RELEASE_136_ID = "2026-11-04-v1.3.6";

/** Immutable historical copy, loaded with the release-notes dialog. */
export function getReleaseNotes136(locale: AppLocale) {
  const en = locale === "en";
  return {
    id: RELEASE_136_ID,
    date: en ? "November 4, 2026" : "2026年11月4日",
    version: "1.3.6",
    title: en ? "Resource Utilization and Mobile Display Fixes" : "全资源减耗与手机显示修复",
    summary: en
      ? "Infinite resource-utilization research now protects all natural deposits, including liquids. Mobile recipe cards and remaining light-theme controls are easier to read. Existing saves and backup preferences are preserved."
      : "无限科技的储量减耗现已覆盖水、硫酸、原油等全部天然资源；修复手机配方卡片裁切和两处亮色主题残留，保留现有存档与备份偏好。",
    items: [
      { id: "v136-all-resources", title: en ? "Resource depletion research covers liquids too" : "储量减耗覆盖全部原矿",
        description: en ? "Each research level reduces natural reserve depletion by 10%, including water, sulfuric acid, crude oil and rare deposits. Level 10 and above stop reserve depletion; previously exhausted deposits can produce again." : "每级减少 10% 天然储量消耗，水、硫酸、原油及稀有矿等全部资源点均生效。10 级及以上不再扣储量，已经枯竭的资源点也可继续采集。" },
      { id: "v136-consistent-settlement", title: en ? "Consistent settlement and reloading" : "实时、离线与重载一致",
        description: en ? "Realtime, offline and native calculations share the same depletion rule. Fractional liquid depletion progress survives saving and reloading. Recipes, fuel and construction still consume real inventory." : "实时、离线和原生计算使用一致的减耗规则，流体的储量扣除余数可以保存重载；生产配方、燃料与施工仍正常消耗库存材料。" },
      { id: "v136-mobile-recipes", title: en ? "Readable mobile recipe cards" : "修复手机配方卡片裁切",
        description: en ? "Recipe rows grow with their contents. Ingredient counts, larger fonts and portrait or landscape layouts no longer compress the cards or cut off materials." : "配方卡片随内容自然增高，材料自动换行；修复数量被裁切、字号放大和横竖屏切换时卡片挤压的问题。" },
      { id: "v136-light-controls", title: en ? "Finish two light-theme controls" : "补齐亮色主题控件",
        description: en ? "The fabricator frame and minimap switch now follow the light theme, including hover and keyboard focus." : "制造面板外框和小地图开关随亮色主题显示，鼠标悬停与键盘焦点状态一并修复。" },
      { id: "v136-compatibility", title: en ? "Continue with existing saves" : "现有存档可直接继续",
        description: en ? "GameState v47 and save envelope v2 remain compatible. Existing factories, inventories and backup preferences are preserved." : "保持 GameState v47 与存档 envelope v2 兼容，现有工厂、库存及备份偏好保留。" },
    ],
  } as const;
}
