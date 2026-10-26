import type { AppLocale } from "./locale";

const RELEASE_131_ID = "2026-10-26-v1.3.1";

/** Keep the menu summary small; historical notes stay behind the dialog. */
export function getReleaseNotes131(locale: AppLocale) {
  const en = locale === "en";
  return {
    id: RELEASE_131_ID,
    date: en ? "October 26, 2026" : "2026年10月26日",
    version: "1.3.1",
    title: en ? "Time Warp and Endgame Construction Optimization" : "时间扭曲与终局建筑制造优化",
    summary: en
      ? "Improve offline settlement, both time-warp idle modes and automatic construction together. Reduce repeated endgame calculations and show clearer progress. GameState v47 and existing saves remain compatible; large calibrations and complex construction can still take time."
      : "协同优化离线结算、两种时间扭曲挂机与建筑自动制造，减少终局大档的重复计算，并提供更清楚的进度提示。旧存档保持兼容，大档校准和复杂递归制造仍可能需要等待。",
    items: [
      { id: "v131-dual-mode-construction", title: en ? "Construction follows both time-warp modes" : "两种时间扭曲均可推进建筑制造",
        description: en ? "Conservative idle and rate-replication idle advance construction with effective simulation time. Materials, power and quantum delivery still limit actual output; replication does not create building ingredients." : "守恒纯挂机和产率复制挂机均按有效模拟时间推进建筑制造，实际产量仍受材料、供电和量子配送限制；产率复制不会凭空生成制造原料。" },
      { id: "v131-calibration", title: en ? "Clearer calibration progress and cancellation" : "校准进度可见，取消后可恢复",
        description: en ? "Conservative calibration reports its progress and supports cancellation while preserving the recovery checkpoint and uncommitted time." : "守恒校准分段显示进度，支持取消，并保留恢复检查点和未提交的结算时间。" },
      { id: "v131-recursive-planning", title: en ? "Less repeated construction planning" : "减少递归制造的重复规划",
        description: en ? "Reuse valid construction plans and avoid planning again just to display progress. Existing advanced-recipe priorities and real-material checks are preserved." : "复用仍然有效的制造方案，避免仅为刷新状态再次递归规划，保留高级配方优先级和真实材料核查。" },
      { id: "v131-endgame-settlement", title: en ? "Less duplicate endgame work" : "减少离线与加速结算的重复工作",
        description: en ? "Combine repeated research-progress resets and avoid whole-factory searches on planets without construction centers. Complex endgame settlement can still require computation time." : "合并科研进度的重复清零，无制造中心的星球不再反复搜索全厂，减少离线与加速结算的共同开销。" },
      { id: "v131-recovery-status", title: en ? "Safer startup and clearer construction status" : "启动恢复与制造等待状态更清楚",
        description: en ? "Reduce large-save copying during idle startup. Distinguish missing materials, power, quantum deliveries and computation limits without changing save formats or backup preferences." : "减少挂机启动时的大档复制，区分缺料、缺电、等待量子配送和计算受限，不改变存档格式及备份偏好。" },
    ],
  } as const;
}
