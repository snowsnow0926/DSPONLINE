import type { AppLocale } from "./locale";


/** Keep the menu summary small; historical notes stay behind the dialog. */
export function getReleaseNotes1311(locale: AppLocale) {
  const en = locale === "en";
  return {
    id: "2026-11-09-v1.3.11",
    date: en ? "November 9, 2026" : "2026年11月9日",
    version: "1.3.11",
    title: en ? "Content Packs and Return to Vanilla" : "内容包升级与一键转回原版",
    summary: en ? "Adds a backed-up conversion from content packs to vanilla gameplay, core item and belt overrides, and safe ID renaming. Authors and players can manage their packs and continue existing factories." : "新增带恢复快照的一键转回原版存档，开放原版物品与传送带覆盖，以及自动维护引用的安全改名，方便作者更新内容包与玩家继续已有工厂。",
    items: [
      { id: "v1311-vanilla-conversion", title: en ? "Return an existing factory to vanilla" : "一键转回原版存档",
        description: en ? "Preview and confirm the removal of pack items, entities, research and references. Core inventories and funded construction are recovered, while core factories and research continue." : "预览并确认清理内容包物品、设备、科技和相关引用，回收设备与订单中的原版物资，继续已有原版工厂和研究进度。" },
      { id: "v1311-recovery", title: en ? "Verified recovery snapshot" : "转换前完整恢复快照",
        description: en ? "Conversion first verifies a full snapshot. Pack configurations stay available in a disabled state, ready to be enabled when restoring that snapshot." : "转换前保存并验证完整快照。内容包配置会停用并保存在本机，重新启用后可恢复转换前进度。" },
      { id: "v1311-core-overrides", title: en ? "Override core items and belts" : "重写原版物品与传送带",
        description: en ? "Authors can change core item presentation and belt speed, construction costs, output amounts and technology requirements through the editor." : "作者可在编辑器中修改原版物品的名称、图标和分类，以及传送带的实际速度、制造成本、产量和解锁科技。" },
      { id: "v1311-safe-renaming", title: en ? "Rename IDs with compatible migrations" : "安全改名与保档迁移",
        description: en ? "Renaming a pack entry updates its references and historical aliases together and increases the patch version for a compatible update." : "修改包内 ID 时同步更新物料、配方、科技和资源引用，保留旧 ID 映射并提高补丁版本，帮助已有存档读取新版。" },
      { id: "v1311-safe-removal", title: en ? "Remove unused pack records" : "清理资源点和科技残留",
        description: en ? "A separate cleanup action removes idle resource nodes, research history and empty inventory entries, with a preview and recovery snapshot." : "安全卸载入口可清理空闲资源点、科技历史和零库存索引，操作前提供清理预览与恢复快照。" },
    ],
  } as const;
}
