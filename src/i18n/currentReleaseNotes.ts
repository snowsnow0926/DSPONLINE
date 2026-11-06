import type { AppLocale } from "./locale";

export const CURRENT_RELEASE_ID = "2026-11-07-v1.3.9";

/** Keep the menu summary small; historical notes stay behind the dialog. */
export function getCurrentReleaseNotes(locale: AppLocale) {
  const en = locale === "en";
  return {
    id: CURRENT_RELEASE_ID,
    date: en ? "November 7, 2026" : "2026年11月7日",
    version: "1.3.9",
    title: en ? "Content Pack Upgrade and Cloud Save Fixes" : "内容包全面升级与云存档修复",
    summary: en ? "Create and update content packs with visual tools, real technology effects and custom production rules. Windows cloud downloads and full-tray feedback are improved while existing saves remain compatible." : "新增内容包可视化作者工具、实际科技加成和自定义生产规则，支持保档更新与旧 ID 迁移，并修复 Windows 云存档下载、完善满仓取料反馈。",
    items: [
      { id: "v139-cloud-download", title: en ? "Windows cloud-save downloads" : "Windows 云存档下载修复",
        description: en ? "Windows can download main, manual-slot and speedrun cloud saves without the incorrect upload-only header." : "修复 Windows 桌面版下载云存档时被接入规则拒绝的问题，覆盖主存档、手动槽位和速通存档。" },
      { id: "v139-author-tools", title: en ? "Visual content-pack authoring" : "可视化内容包作者工具",
        description: en ? "Edit items, buildings, recipes, technologies and rules in forms, with embedded icons, categories and a working crystal-industry example." : "通过表单编辑物品、建筑、配方、科技和规则，支持内嵌图标、分类与可运行的晶体工业示例。" },
      { id: "v139-recipe-rules", title: en ? "Handcraft and recipe unlock rules" : "手合、配方限制与分组解锁",
        description: en ? "Authors can control handcrafting, assign allowed recipes to buildings and unlock recipe groups through technology." : "作者可设置配方是否允许手合、指定建筑可用配方，并通过科技统一解锁一组配方。" },
      { id: "v139-technology-effects", title: en ? "Technology changes actual production" : "科技加成实际生效",
        description: en ? "Researched effects change production speed, power consumption, mining speed and building input/output capacity in realtime and offline simulation." : "科技完成后实际影响生产速度、能耗、采矿效率和建筑输入输出容量，实时与离线结算遵守相同规则。" },
      { id: "v139-production-rules", title: en ? "Custom fuel, power and resources" : "自定义燃料、发电与资源",
        description: en ? "Content packs can declare fuel energy, generator efficiency and custom resource deposits with their mining buildings. Loading a save does not refill depleted deposits." : "内容包可配置燃料热值、发电效率、资源矿点和对应采矿建筑；读档和更新不会补满已消耗矿量。" },
      { id: "v139-inventory-feedback", title: en ? "Clearer feedback when taking items" : "建筑取料反馈更明确",
        description: en ? "Dragging items into a full material tray now explains why the transfer cannot complete and how to make room." : "向已满的物资托盘拖取建筑物品时，会明确提示容量不足和处理办法，保留建筑中的原有库存。" },
      { id: "v139-safe-updates", title: en ? "Update content packs without clearing stock" : "内容包保档更新与旧 ID 迁移",
        description: en ? "Compatible updates preserve stock, buildings and research. Explicit old-ID mappings support safe renaming, and previous configurations can be exported. Existing factories and save formats remain compatible." : "兼容更新保留库存、建筑和研究进度，旧 ID 显式映射支持安全改名，历史配置可导出备份；现有工厂和存档格式继续兼容。" },
    ],
  } as const;
}
