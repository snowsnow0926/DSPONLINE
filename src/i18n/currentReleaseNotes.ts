import type { AppLocale } from "./locale";

/**
 * The start menu only needs the current release summary. Keep it in a small
 * eager module so the historical release archive stays behind the dialog's
 * lazy boundary and does not inflate the first menu render.
 */
export function getCurrentReleaseNotes(locale: AppLocale) {
  const english = locale === "en";
  return {
    id: "2026-08-27-v1.2.2",
    date: english ? "August 27, 2026" : "2026年8月27日",
    version: "1.2.2",
    title: english ? "Pure Idle Restores Production with a Lightweight 30-second Sample" : "纯挂机 30 秒轻量采样恢复产量",
    summary: english
      ? "Version 1.2.2 replaces the one-second zero-output probe for large-save conservative pure idle with three exact ten-second windows and extrapolates ordinary production and research from a lightweight material snapshot. Rockets, sails, Dyson structures, exports, contracts, and megastructure deliveries are still never copied without a ledger. Existing GameState v47 / envelope v2 saves remain compatible."
      : "1.2.2 将大型存档的保守纯挂机从 1 秒零产量探针升级为 3 个 10 秒精确窗口，并用轻量物料快照外推普通生产与科研；火箭、太阳帆、戴森结构、出口、合同和巨构交付仍不做无账本复制。旧版 GameState v47 / envelope v2 存档继续兼容。",
    items: [
      {
        id: "pure-idle-30-second-sample",
        title: english ? "Slow production cycles are no longer judged by the first second" : "慢周期产线不再被首秒误判为 0",
        description: english
          ? "The conservative path observes the 0-10, 10-20, and 20-30 second windows. Slow recipes can form an ordinary-production contract once they actually complete inside the sample."
          : "保守路径连续观察 0～10、10～20、20～30 秒三个窗口；慢配方只要在样本中真实完成，就可以形成普通产线外推合同。",
      },
      {
        id: "pure-idle-lightweight-snapshot",
        title: english ? "Large saves retain only a lightweight material sample" : "大存档只保留轻量物料样本",
        description: english
          ? "Calibration records cumulative production, inventory, and entity inputs/outputs without retaining full state and belt diagnostics for every window."
          : "校准只记录累计生产、库存和建筑输入输出，不再为每个窗口保留完整状态与线路诊断。",
      },
      {
        id: "pure-idle-material-horizons",
        title: english ? "Finite caches stop at material boundaries" : "有限缓存按物料边界停止",
        description: english
          ? "Each item receives its own net-consumption horizon, propagated through active recipes, so one exhausted cache stops affected products without zeroing the entire factory."
          : "每种物料分别计算净消耗边界并沿活动配方向下游传播；一个缓存耗尽只停止受影响的产物，不把整个工厂重新判为零。",
      },
      {
        id: "pure-idle-terminal-freeze",
        title: english ? "Dyson and terminal outcomes remain frozen in the tail" : "戴森与终局结果继续冻结尾段",
        description: english
          ? "Rockets, sails, Dyson structures, exports, contracts, and megastructure deliveries receive only the exact 30-second prefix and must still pass conservation and reload gates."
          : "火箭、太阳帆、戴森结构、出口、合同和巨构交付只获得精确 30 秒前缀，并继续通过守恒与重载门禁。",
      },
    ],
  } as const;
}
