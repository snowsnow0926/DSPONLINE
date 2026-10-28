import type { AppLocale } from "./locale";

export const CURRENT_RELEASE_ID = "2026-10-28-v1.3.4";

/** Keep the menu summary small; historical notes stay behind the dialog. */
export function getCurrentReleaseNotes(locale: AppLocale) {
  const en = locale === "en";
  return {
    id: CURRENT_RELEASE_ID,
    date: en ? "October 28, 2026" : "2026年10月28日",
    version: "1.3.4",
    title: en ? "Large-Factory Performance and Bigger Blueprints" : "大档性能与蓝图扩容",
    summary: en
      ? "Reduce large-factory computation, save checks and canvas pauses, and expand Web blueprint exchange capacity eightfold. Existing factories, materials and backup preferences are preserved."
      : "进一步减少终局大档的重复计算、存档检查和画面停顿，网页版蓝图交换容量扩大到原来的八倍；现有工厂、材料与备份偏好保持。",
    items: [
      { id: "v134-transitions", title: en ? "Faster time-warp transitions" : "大档进入、退出更流畅",
        description: en ? "Split large startup copies, reduce unnecessary focus and canvas work, release old display state, and speed up complete save checks. Checkpoints, independent readback and recovery stay intact." : "大档启动复制分段处理，减少无效焦点与画布计算，释放旧显示状态并加快完整存档检查；检查点、独立读回和失败恢复全部保留。" },
      { id: "v134-simulation", title: en ? "Less repeated factory computation" : "减少普通模拟与巨构制造的重复计算",
        description: en ? "Reuse stable belt inputs and repeated construction batches while continuing to check live stock, advanced recipes, quantum supply and material conservation." : "复用传送带阶段内不变的输入和重复制造批次，继续检查实时库存、高级配方、量子供料和材料守恒。" },
      { id: "v134-blueprint-capacity", title: en ? "Eightfold Web blueprint capacity" : "网页版蓝图交换容量扩大八倍",
        description: en ? "Exchange up to 4,096 building nodes, 8,192 internal belts, 1,024 external ports and 8 MiB per file. Existing larger local blueprints are preserved. Windows performance-edition native limits are separate." : "单张交换蓝图支持 4,096 个建筑节点、8,192 条内部线路、1,024 个外部端口和 8 MiB 文件；已有更大本地蓝图保留。Windows 性能版原生接口使用独立限额。" },
      { id: "v134-blueprint-workflow", title: en ? "Faster large-blueprint copying and construction" : "大蓝图复制与施工收尾更快",
        description: en ? "Avoid repeatedly searching the entire factory while capturing large selections and completing queued construction. Exact material spending, installed fleet, ports and immutable queue versions are preserved." : "大选区复制和排队施工收尾避免反复搜索整个工厂，保持精确扣料、已装载具、端口和不可变施工版本。" },
      { id: "v134-compatibility", title: en ? "Existing saves and backup preferences preserved" : "存档、材料与备份设置保持",
        description: en ? "GameState v47 remains compatible. Save and cloud formats, inventories, recipe choices and backup preferences are unchanged. Extreme memory use, conservation mode and long-idle performance still need further verification." : "旧存档可直接继续；存档与云端格式、库存、配方选择和备份偏好不变。极端内存、守恒模式和长时挂机性能仍需继续验证。" },
    ],
  } as const;
}
