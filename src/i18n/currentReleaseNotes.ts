import type { AppLocale } from "./locale";

export const CURRENT_RELEASE_ID = "2026-10-29-v1.3.5";

/** Keep the menu summary small; historical notes stay behind the dialog. */
export function getCurrentReleaseNotes(locale: AppLocale) {
  const en = locale === "en";
  return {
    id: CURRENT_RELEASE_ID,
    date: en ? "October 29, 2026" : "2026年10月29日",
    version: "1.3.5",
    title: en ? "Construction and Factory Computation Improvements" : "巨构制造与工厂计算优化",
    summary: en
      ? "Reduce repeated recipe planning, material checks and power calculations in large factories. Existing saves, advanced recipe priorities and backup preferences are preserved."
      : "减少终局大工厂反复规划配方、检查材料和统计供电的计算开销，保留现有存档、高级配方优先级和备份偏好。",
    items: [
      { id: "v135-stocked-planning", title: en ? "Lighter crafting when materials are ready" : "原料齐备时制造更轻",
        description: en ? "Use a shorter planning path when the required materials are already available. Missing materials still use the complete recursive search and advanced recipe priorities." : "所需材料已经备齐时减少重复展开与临时分配；缺料时继续完整递归搜索，保留高级配方优先。" },
      { id: "v135-batch-planning", title: en ? "Less repeated batch planning" : "减少制造批次重复计算",
        description: en ? "Reuse checks within the current construction batch and read live stock again before spending materials." : "同一制造批次复用任务检查和供料轮数，实际扣料前仍重新核对实时库存。" },
      { id: "v135-quantum-context", title: en ? "Lean quantum supply calculations" : "优化量子供料计算",
        description: en ? "Reuse recipe and research context during quantum demand prediction while continuing to read live inventory and reserved materials." : "量子需求预测复用配方与科技上下文，库存和预留材料仍实时读取。" },
      { id: "v135-power-views", title: en ? "Lean large-factory power statistics" : "优化大工厂供电统计",
        description: en ? "Reduce repeated scans of construction centers, power plants and stored energy while preserving calculation order and results." : "减少制造中心、发电设施和储能数据的重复遍历，保持原有计算顺序与结果。" },
      { id: "v135-compatibility", title: en ? "Existing saves and material rules preserved" : "保留存档与材料规则",
        description: en ? "GameState v47 remains compatible. Inventories, advanced recipes, quantum sourcing and backup preferences are preserved. Extreme memory use and conservation-mode startup still need further work." : "旧存档可直接继续，库存、高级配方、量子取料与备份偏好保持。极端内存占用和守恒模式启动等待仍需继续优化。" },
    ],
  } as const;
}
