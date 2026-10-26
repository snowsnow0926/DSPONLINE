import type { AppLocale } from "./locale";

export const CURRENT_RELEASE_ID = "2026-10-27-v1.3.2";

/** Keep the menu summary small; historical notes stay behind the dialog. */
export function getCurrentReleaseNotes(locale: AppLocale) {
  const en = locale === "en";
  return {
    id: CURRENT_RELEASE_ID,
    date: en ? "October 27, 2026" : "2026年10月27日",
    version: "1.3.2",
    title: en ? "Large-Save Performance and Saving Improvements" : "终局大档性能与保存体验优化",
    summary: en
      ? "Reduce repeated quantum logistics, construction and large-save work. Improve simulation, saving and idle transitions while preserving existing saves. Complex endgame factories can still require time to process."
      : "减少量子物流、建筑制造和大档保存的重复计算，改善运行、保存与挂机切换的等待。旧存档可直接继续游玩；复杂终局场景仍可能需要等待。",
    items: [
      { id: "v132-quantum-deposits", title: en ? "Lighter quantum uploads" : "量子入库计算更轻",
        description: en ? "Process successive tower uploads together to reduce repeated work in large factories, while preserving upload order, capacity limits and material balances." : "同一轮物流塔入库一起处理，减少大工厂的重复计算；原有入库顺序、仓库容量和物资数量规则保持不变。" },
      { id: "v132-construction-planning", title: en ? "Less repeated construction planning" : "建筑制造减少重复规划",
        description: en ? "Reuse construction planning data during accelerated production. Keep advanced-recipe priorities, real-material checks and quantum delivery rules." : "加速制造时复用有效的规划资料，保留高级配方优先级、真实材料核查和量子配送规则。" },
      { id: "v132-save-response", title: en ? "More responsive large saves" : "大档保存更少阻塞操作",
        description: en ? "Reduce repeated save preparation and move more verification work away from the interface. Saving still validates the complete result before committing it." : "减少保存前的重复准备，把更多校验工作移出界面线程；存档仍在完整校验后才会正式写入。" },
      { id: "v132-checkpoint-reuse", title: en ? "Faster snapshots and idle transitions" : "快照与挂机切换减少大档复制",
        description: en ? "Reuse verified checkpoints for manual saves and snapshots. Large idle-start saves can be verified in the background even when no reusable binary checkpoint is available." : "手动存档和快照复用已验证的检查点；挂机启动时，即使没有可复用的二进制检查点，大档也能在后台完成校验。" },
      { id: "v132-compatibility", title: en ? "Existing saves and material rules preserved" : "原有存档与材料规则保留",
        description: en ? "GameState v47 remains compatible. Existing factories, inventories and backup preferences are preserved. Occasional pauses and high memory use in very large factories still need further optimization." : "旧存档可继续使用，工厂、库存和备份偏好保持不变。超大工厂的偶发停顿与较高内存占用仍有后续优化空间。" },
    ],
  } as const;
}
