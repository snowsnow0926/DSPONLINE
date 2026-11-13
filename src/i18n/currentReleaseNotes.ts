import type { AppLocale } from "./locale";

export const CURRENT_RELEASE_ID = "2026-11-14-v1.3.14";

/** Keep the menu summary small; historical notes stay behind the dialog. */
export function getCurrentReleaseNotes(locale: AppLocale) {
  const en = locale === "en";
  return {
    id: CURRENT_RELEASE_ID,
    date: en ? "November 14, 2026" : "2026年11月14日",
    version: "1.3.14",
    title: en ? "Android Worker Compatibility and Recovery" : "Android 模拟兼容与恢复修复",
    summary: en ? "Adds legacy runtime support across the interface and workers, and bounds repeated recovery failures while preserving visible progress and verified saves." : "补齐旧版运行环境中主界面与 Worker 的接口兼容，限制连续恢复失败时的自动重建，保留当前画面、进度与已验证存档。",
    items: [
      { id: "v1314-runtime", title: en ? "Legacy Android runtime support" : "修复旧内核模拟报错",
        description: en ? "Legacy runtimes receive Array.at and Object.hasOwn support before the interface and all 16 workers initialize, covering simulation and save workflows." : "主界面与全部 16 类 Worker 提前初始化 Array.at、Object.hasOwn 及对象复制兼容，覆盖模拟、操作与保存流程。" },
      { id: "v1314-recovery", title: en ? "Bounded Worker recovery" : "停止异常恢复反复刷屏",
        description: en ? "Repeated runtime failures share the recovery attempt limit. After three failed recovery attempts, automatic rebuilding stops and the visible factory stays paused." : "连续运行异常共用恢复次数，累计三次恢复失败后停止自动重建并保持暂停，运行记录反馈可稳定查看。" },
      { id: "v1314-save", title: en ? "Preserved progress and verified saves" : "保留进度与已验证存档",
        description: en ? "Failure handling retains the visible factory and verified primary save. Signed Android upgrade, explicit saving and cold reopening preserve inventory and pause state." : "恢复失败时保留当前画面与已验证主档，同签名覆盖升级、显式保存和冷启动读回校验覆盖物资与暂停状态。" },
    ],
  } as const;
}
