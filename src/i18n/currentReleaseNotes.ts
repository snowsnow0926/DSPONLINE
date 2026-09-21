import type { AppLocale } from "./locale";

export const CURRENT_RELEASE_ID = "2026-09-22-v1.3.0";

/** Keep the menu summary small; historical notes stay behind the dialog. */
export function getCurrentReleaseNotes(locale: AppLocale) {
  const en = locale === "en";
  return {
    id: CURRENT_RELEASE_ID,
    date: en ? "September 22, 2026" : "2026年9月22日",
    version: "1.3.0",
    title: en ? "Quantum Supply and Automatic Construction Fixes" : "量子取料与建筑自动制造修复",
    summary: en
      ? "Fix construction waiting for water that is already in quantum storage. Improve shared downloads, ingredient planning, target scheduling and delivery explanations. GameState v47 and existing saves remain compatible."
      : "修复量子库有水却持续缺水停工的问题，改善共享下载分配、现成材料取料、多目标制造和配送状态说明。旧存档可直接继续游玩。",
    items: [
      { id: "v130-quantum-delivery", title: en ? "Stocked materials can be delivered" : "缺货请求不再占住下载额度",
        description: en ? "Requests without stock no longer consume the capacity needed to deliver available water or other materials." : "先按仓库实际现货分配下载额度，缺货需求不再阻止水和其他有货物料送到制造中心。" },
      { id: "v130-download-fairness", title: en ? "Fair shared downloads" : "共享下载保留优先级并轮转",
        description: en ? "Preserve priority when stock is scarce and rotate equal-priority remainders across delivery boundaries." : "库存紧张时保留需求优先级，同级下载余量随配送边界轮转，减少持续等待。" },
      { id: "v130-ready-ingredients", title: en ? "Use ready-made ingredients" : "现成中间件可直接取料",
        description: en ? "Plan with ingredients already in quantum storage, repair blocked job steps after delivery, and finish partial material sets before spreading scarce stock across centers." : "规划会利用量子库已有中间件，送达后恢复卡住的任务；多个中心优先补齐已收到的部分材料，避免唯一一套材料被分散。" },
      { id: "v130-target-scheduling", title: en ? "Continue other ready targets" : "缺料目标不再堵住后续制造",
        description: en ? "Keep blocked targets while trying other targets whose materials are ready. Resume them automatically after restocking." : "保留缺料目标，同时尝试材料齐全的其他目标；补货后继续制造，无需清空任务。" },
      { id: "v130-delivery-status", title: en ? "Clear delivery status" : "配送原因与实收数量更清楚",
        description: en ? "Show warehouse stock, the center's own cache, delivery waits and actual receipts. Keep the status readable on narrow screens." : "显示仓库现货、本中心缓存、等待原因及请求和送达数量，材料预览不再混入其他中心缓存，并修复窄屏状态区布局。" },
    ],
  } as const;
}
