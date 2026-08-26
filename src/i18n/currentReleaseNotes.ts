import type { AppLocale } from "./locale";

/**
 * The start menu only needs the current release summary. Keep it in a small
 * eager module so the historical release archive stays behind the dialog's
 * lazy boundary and does not inflate the first menu render.
 */
export function getCurrentReleaseNotes(locale: AppLocale) {
  const english = locale === "en";
  return {
    id: "2026-08-27-v1.2.0",
    date: english ? "August 27, 2026" : "2026年8月27日",
    version: "1.2.0",
    title: english ? "Windows Native Performance Foundation and Dyson Conservation" : "Windows 原生性能底座与戴森守恒修复",
    summary: english
      ? "Version 1.2.0 adds a private incremental-save foundation and an opt-in Rust shadow core to the Windows app, while fixing conservative time-warp settlement so rockets, sails, and Dyson structures can never be copied without material. JavaScript remains authoritative during the invitation Beta, and existing v47 / envelope v2 saves remain compatible."
      : "1.2.0 为 Windows 应用加入私有增量存档底座和可选的 Rust 影子核心，并修复保守时间扭曲结算，禁止火箭、太阳帆和戴森结构在没有物料来源时被复制。邀请测试期间 JavaScript 仍是权威；旧版 v47 / envelope v2 存档继续兼容。",
    items: [
      {
        id: "windows-native-incremental-save",
        title: english ? "Windows large saves gain a private incremental mirror" : "Windows 大型存档增加私有增量镜像",
        description: english
          ? "The sandboxed desktop host writes immutable checked chunks, an append-only revision log, and atomic generation pointers under the app data directory while the portable v47 save remains the rollback boundary."
          : "受限桌面 Host 在应用数据目录写入不可变校验区块、追加式 revision 日志和原子代际指针；可移植的 v47 存档继续作为回退边界。",
      },
      {
        id: "windows-native-shadow-core",
        title: english ? "Independent Rust simulation is available in shadow mode" : "独立 Rust 模拟核心开放影子校验",
        description: english
          ? "Invitation-Beta players can compare bounded native checkpoints and operations against the JavaScript authority. A mismatch fails closed and never replaces the visible factory or installs an older checkpoint."
          : "邀请测试玩家可以让原生核心与 JavaScript 权威对照有界检查点和操作；一旦不一致会安全停止校验，不会替换当前工厂或安装旧检查点。",
      },
      {
        id: "dyson-material-conservation",
        title: english ? "Conservative time warp can no longer copy Dyson output" : "保守时间扭曲不再复制戴森产物",
        description: english
          ? "Only a bounded exact prefix is committed. Unproven tail production, launches, exports, contracts, and research freeze instead of multiplying a one-second probe that consumed cached material."
          : "结算只提交有界精确前缀；无法证明守恒的尾段生产、发射、出口、合同和科研会冻结，不再放大已经消耗缓存物料的一秒探针。",
      },
      {
        id: "dyson-conservation-gates",
        title: english ? "Rocket and sail flows are checked transactionally" : "火箭与太阳帆流量加入事务守恒门禁",
        description: english
          ? "Client settlement validates inventory sources, global and per-system counters, and derived Dyson power before committing; failed candidates leave the source checkpoint unchanged."
          : "客户端提交前会核对库存来源、全局与各恒星系统计数以及重新派生的戴森功率；候选失败时源检查点保持不变。",
      },
      {
        id: "leaderboard-conservation-review",
        title: english ? "Leaderboard anomalies enter manual review" : "排行榜异常只进入人工复核",
        description: english
          ? "Adjacent v46/v47 revisions are checked for impossible rocket or sail growth. Unverifiable or abnormal revisions preserve the previous valid score and never trigger an automatic ban or save deletion."
          : "服务端会检查相邻 v46/v47 revision 是否出现不可能的火箭或太阳帆增长；无法验证或异常时保留上一份有效成绩，不会自动封禁或删除云档。",
      },
      {
        id: "version-compatibility",
        title: english ? "Existing saves and cloud protocols remain compatible" : "旧存档与云端协议保持兼容",
        description: english
          ? "GameState v47, save envelope v2, cloud schema v8, and SQLite layout v3 remain unchanged; historical Dyson values are not rewritten automatically."
          : "GameState v47、存档 envelope v2、cloud schema v8 和 SQLite layout v3 保持不变；历史戴森数据不会被自动改写。",
      },
    ],
  } as const;
}
