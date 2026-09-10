import type { AppLocale } from "./locale";

/** Keep the menu summary small; historical notes stay behind the dialog. */
export function getCurrentReleaseNotes(locale: AppLocale) {
  const en = locale === "en";
  return {
    id: "2026-09-10-v1.2.9",
    date: en ? "September 10, 2026" : "2026年9月10日",
    version: "1.2.9",
    title: en ? "Shared Performance and Canvas Controls" : "多端性能优化与画布操作更新",
    summary: en
      ? "Less repeated work during simulation, loading, saving and automatic snapshots. Navigate with WASD and move selected production regions with their nodes. GameState v47 and existing saves remain compatible."
      : "减少模拟、读档、保存和自动快照中的重复扫描与复制；新增 WASD 平移视野，以及生产区域与节点一起框选移动。保持现有存档兼容。",
    items: [
      { id: "v129-shared-save", title: en ? "Background saves and snapshots" : "保存与自动快照减少重复处理",
        description: en ? "Workers process large saves and reuse verified primary data for snapshots, retaining backups and readback checks." : "后台 Worker 处理大存档，自动快照复用已验证主档；保留备份、完整校验和写入后读回。" },
      { id: "v129-shared-simulation", title: en ? "Less work in multi-planet factories" : "多星球模拟减少无效扫描",
        description: en ? "Reuse power indexes, skip empty phases, and check construction materials without copying full inventories." : "复用完整电力索引，跳过空星球机器与施工阶段，施工材料检查不再复制完整库存。" },
      { id: "v129-wasd", title: en ? "Navigate with WASD" : "WASD 平移画布视野",
        description: en ? "Hold WASD to move the view. Typing, dialogs, modifier shortcuts and focus loss stop navigation." : "按住 WASD 可连续移动视野；输入文字、弹窗、组合快捷键或切换窗口时不会误移动画布。" },
      { id: "v129-region-selection", title: en ? "Move regions with selected nodes" : "生产区域与节点一起移动",
        description: en ? "Include production regions in box selection. Fully enclosed regions follow selected nodes, with combined undo and redo. Resize boundaries separately as before." : "框选模式可开启“同时选中生产区域”；完整框住的区域随选中节点一起拖动，撤销与重做同步恢复两者。区域边界仍可单独调整。" },
      { id: "v129-android-recovery", title: en ? "Android connectivity and restart recovery" : "保留安卓云连接并改善重启恢复",
        description: en ? "Keep the 1.2.8 cloud and update fixes; wait for interrupted writer leases before resuming. Update over the existing installation to keep saves." : "保留 1.2.8 云服务和更新配置修复，异常关闭后等待旧写入租约释放再恢复。请直接覆盖安装，保留本地存档。" },
    ],
  } as const;
}
