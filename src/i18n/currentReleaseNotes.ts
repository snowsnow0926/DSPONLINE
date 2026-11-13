import type { AppLocale } from "./locale";

export const CURRENT_RELEASE_ID = "2026-11-13-v1.3.13";

/** Keep the menu summary small; historical notes stay behind the dialog. */
export function getCurrentReleaseNotes(locale: AppLocale) {
  const en = locale === "en";
  return {
    id: CURRENT_RELEASE_ID,
    date: en ? "November 13, 2026" : "2026年11月13日",
    version: "1.3.13",
    title: en ? "Android Factory Startup Compatibility" : "Android 工厂启动兼容修复",
    summary: en ? "Fixes factory creation on Android runtimes missing structuredClone, with compatibility support across the interface, simulation and save workers." : "修复部分安卓运行环境点击“建立工厂”时报 structuredClone is not defined 的问题，兼容处理覆盖主界面、后台模拟与存档流程。",
    items: [
      { id: "v1313-factory", title: en ? "Factory creation on Android" : "修复安卓建立工厂报错",
        description: en ? "Android runtimes without structuredClone receive a compatible implementation before content-pack initialization, allowing a new factory to open." : "在缺少 structuredClone 的环境中提前提供兼容实现，支持完成内容包初始化并进入新工厂。" },
      { id: "v1313-workers", title: en ? "Simulation and save workers" : "后台模拟与存档兼容",
        description: en ? "The interface and workers initialize cloning support in their own runtime, supporting simulation, saving and reopening." : "主界面和后台 Worker 分别初始化克隆支持，覆盖模拟运行、保存和重新进入工厂。" },
      { id: "v1313-save", title: en ? "Lossless save cloning" : "完整复制与存档保护",
        description: en ? "Compatibility checks cover object graphs, shared references and ArrayBuffer transfers, including preservation when a transfer fails." : "兼容处理覆盖对象图、共享引用与 ArrayBuffer 转移，并校验复制失败时的原数据保护。" },
    ],
  } as const;
}
