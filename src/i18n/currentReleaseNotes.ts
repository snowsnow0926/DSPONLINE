import type { AppLocale } from "./locale";

/**
 * The start menu only needs the current release summary. Keep it in a small
 * eager module so the historical release archive stays behind the dialog's
 * lazy boundary and does not inflate the first menu render.
 */
export function getCurrentReleaseNotes(locale: AppLocale) {
  const english = locale === "en";
  return {
    id: "2026-08-30-v1.2.5",
    date: english ? "August 30, 2026" : "2026年8月30日",
    version: "1.2.5",
    title: english ? "Continuous Pure Idle, No-Rollback Recovery, and Blueprint Layout Fixes" : "纯挂机连续运行、无回档恢复与蓝图布局修复",
    summary: english
      ? "Version 1.2.5 keeps construction megastructures productive in both pure-idle modes and replaces the conservative mode's global stop with terminal-domain settlement: certified matrices, research, and rockets continue while ordinary materials keep their existing bounds. Failed simulation Workers are rebuilt without silently installing an older checkpoint, and dense blueprint detail layouts no longer overlap. GameState v47, save envelope v2, cloud schema v8, and SQLite layout v3 remain compatible."
      : "1.2.5 让建筑制造巨构在两种纯挂机模式中持续工作，并把守恒模式从“一处边界耗尽就全停”改为按终局产出域独立结算：有闭合证书的白矩阵、科研和火箭继续，普通材料仍遵守原边界。模拟 Worker 故障会自动重建，不再静默安装旧检查点，并修复密集蓝图详细卡片错位。GameState v47、存档 envelope v2、cloud schema v8 与 SQLite layout v3 保持兼容。",
    items: [
      {
        id: "v125-conservative-continuity",
        title: english ? "Conservative pure idle uses independent terminal boundaries" : "守恒纯挂机改为终局产出独立边界",
        description: english
          ? "Exhausting an ordinary-material, cache, or finite power-tail estimate no longer zeros every rate. Matrices, research, rockets, and construction proven closed by all three exact windows keep independent credit. Startup still requires the requested multiplier to be actually powered; no-power, missing same-grid proof, cross-grid borrowing, negative stores, and save-integrity failures remain blocked."
          : "普通材料、缓存或有限供电尾段估算耗尽时，不再把全部产率清零；三个精确窗口已证明闭合的白矩阵、科研、火箭和建筑制造继续独立结算。启动时仍要求实际供电达到请求倍率；无电、缺少同电网证明、跨电网借电、负库存和存档完整性失败仍会阻止。",
      },
      {
        id: "v125-replication-construction",
        title: english ? "Rate replication also advances construction" : "产率复制挂机也会推进建筑制造",
        description: english
          ? "Before copied endgame outputs are awarded, construction centers recursively consume the player's real inventory and advance active projects at the locked runtime power factor. No construction material is fabricated."
          : "复制终局产出前，建筑制造中心会按锁定的实际供电倍率递归消耗玩家真实库存并推进正在施工的项目；不会凭空生成施工材料。",
      },
      {
        id: "v125-worker-auto-resume",
        title: english ? "Simulation Worker faults recover in place" : "模拟 Worker 故障可原地恢复",
        description: english
          ? "Runtime failures, timeouts, and durable-recovery faults refund uncommitted idle time, rebuild the Worker, and resume from the current committed state. Content-pack validation errors remain separate and do not poison the runtime recovery path."
          : "运行异常、超时和 durable 恢复故障会退还尚未提交的挂机时间，重建 Worker 并从当前已提交状态继续；内容包校验错误与运行故障分离，不再污染自动恢复。",
      },
      {
        id: "v125-no-automatic-rollback",
        title: english ? "Automatic safeguards never roll the save backward" : "后台保护不再自动把存档回退",
        description: english
          ? "Memory guards, Worker recovery, timeout handling, and pure-idle repair may stop or retry, but cannot install a historical authoritative checkpoint. Older checkpoints remain available only through an explicit player restore action."
          : "内存保护、Worker 恢复、超时处理和纯挂机修复可以停止或重试，但不能安装历史权威检查点；旧检查点只允许玩家明确点击恢复时使用。",
      },
      {
        id: "v125-blueprint-detail-layout",
        title: english ? "Dense blueprint details no longer overlap" : "密集蓝图详细信息不再错位重叠",
        description: english
          ? "Detailed blueprint cards use natural-height rows and bounded overflow, keeping large counts, long parameters and port lists readable at dense desktop layouts and enlarged UI font scales."
          : "蓝图详细卡片改用自然高度行布局和有界溢出；超大数量、长参数、端口列表以及放大界面字号时都能保持可读，不再相互覆盖。",
      },
      {
        id: "v125-compatibility-boundary",
        title: english ? "Save and server formats remain compatible" : "存档与服务器格式保持兼容",
        description: english
          ? "This release changes pure-idle settlement, runtime recovery, and blueprint presentation only. It does not migrate player state, cloud payloads, or the production database layout."
          : "本版只调整纯挂机结算、运行时恢复和蓝图显示，不迁移玩家状态、云存档正文或生产数据库布局。",
      },
    ],
  } as const;
}
