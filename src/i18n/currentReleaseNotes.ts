import type { AppLocale } from "./locale";

export const CURRENT_RELEASE_ID = "2026-10-27-v1.3.3";

/** Keep the menu summary small; historical notes stay behind the dialog. */
export function getCurrentReleaseNotes(locale: AppLocale) {
  const en = locale === "en";
  return {
    id: CURRENT_RELEASE_ID,
    date: en ? "October 27, 2026" : "2026年10月27日",
    version: "1.3.3",
    title: en ? "Smoother Time Warp Transitions and Large Saves" : "时间扭曲切换与大档流畅度优化",
    summary: en
      ? "Reduce pauses when entering and leaving time warp, saving large factories and returning to the canvas. Existing saves, material rules and backup preferences are preserved. Very large factories can still take time and use substantial memory."
      : "减少进入和退出时间扭曲、保存大工厂及恢复画布时的停顿。现有存档、材料规则和备份偏好保持；超大工厂仍可能需要等待并占用较多内存。",
    items: [
      { id: "v133-time-warp-start", title: en ? "Smoother time-warp startup" : "时间扭曲启动更顺畅",
        description: en ? "Reduce repeated power preparation and transfer large startup checkpoints in smaller batches. Repeated clicks and page restoration cannot start the same run twice." : "减少供电准备中的重复工作，大档启动检查点分批交接；重复点击和页面恢复不会重复启动同一次挂机。" },
      { id: "v133-idle-stop", title: en ? "Fewer pauses while stopping and saving" : "停止结算与保存更少卡顿",
        description: en ? "Reduce repeated checkpoint work, split large result processing and reuse background save work. The complete saved result is still verified before success is reported." : "减少重复检查点，分段处理大档结果并复用后台保存工作；仍会完整核对保存结果，再报告成功。" },
      { id: "v133-recovery", title: en ? "Safer cancellation and recovery" : "取消、重试与恢复更可靠",
        description: en ? "Prevent late results from reviving a cancelled run, avoid repeating a completed save on retry, and restore normal simulation correctly before a new run." : "防止迟到结果重新激活已取消的挂机，重试不重复写入已完成的存档；重新开始前正确恢复普通模拟。" },
      { id: "v133-memory-canvas", title: en ? "Less retained memory and repeated canvas work" : "减少保存后的内存滞留与画布重复计算",
        description: en ? "Retire idle large-save background workers and reuse unchanged belt geometry and construction display queries when returning to the factory." : "大档保存后台空闲后及时释放，回到工厂时复用未变化的连线与建筑制造显示结果。" },
      { id: "v133-compatibility", title: en ? "Existing factories and materials preserved" : "工厂、材料和备份设置保持",
        description: en ? "GameState v47 remains compatible. Existing factories, inventories, recipe choices and backup preferences are preserved; extreme endgame memory use and long waits still need further work." : "旧存档可直接继续，工厂、库存、配方选择和备份偏好保持不变；极端终局场景的内存峰值和长等待仍需继续优化。" },
    ],
  } as const;
}
