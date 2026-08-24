import type { AppLocale } from "./locale";

/**
 * The start menu only needs the current release summary. Keep it in a small
 * eager module so the historical release archive stays behind the dialog's
 * lazy boundary and does not inflate the first menu render.
 */
export function getCurrentReleaseNotes(locale: AppLocale) {
  const english = locale === "en";
  return {
    id: "2026-08-25-v1.1.8",
    date: english ? "August 25, 2026" : "2026年8月25日",
    version: "1.1.8",
    title: english ? "Memory Safety Pausing and Chunked Incremental Saves" : "内存安全暂停与分块增量存档",
    summary: english
      ? "Version 1.1.8 adds a memory budget, save/simulation fencing, chunked incremental checkpoints, and a configurable device-only memory-pressure pause. Existing v47 / envelope v2 saves remain compatible."
      : "1.1.8 为大型工厂加入内存预算、保存与模拟互斥、分块增量检查点和可配置的设备级内存保护暂停；旧版 v47 / envelope v2 存档继续兼容。",
    items: [
      {
        id: "memory-auto-pause-policy",
        title: english ? "Configurable memory-pressure auto-pause" : "内存超限自动暂停可配置",
        description: english
          ? "Use the automatic 90% browser-heap watermark, choose a fixed JS-heap threshold, or disable heap-threshold pausing. Queue, Worker, and allocation-failure safeguards remain."
          : "可使用浏览器堆上限 90% 自动档、固定 JS 堆内存阈值，或关闭堆阈值暂停；模拟积压、Worker 和内存分配失败保护仍保留。",
      },
      {
        id: "chunked-incremental-save",
        title: english ? "Large saves use chunked incremental checkpoints" : "大型存档改为分块增量检查点",
        description: english
          ? "After the first full checkpoint, autosaves write changed entity/belt chunks while verified full-save fallback remains available."
          : "首次完整检查点后，自动保存只写变化的实体/线路区块；经过验证的完整保存回退继续可用。",
      },
      {
        id: "real-save-memory-benchmark",
        title: english ? "Real endgame save long-run regression" : "真实终局存档长时回归",
        description: english
          ? "Idle, building, belt, blueprint, and autosave stress runs now have measured 1.1.8 evidence and a safe-pause stopping point."
          : "挂机、建造、拉线、蓝图和自动保存压力测试已有 1.1.8 实测证据，并能在内存压力下安全停在最近检查点。",
      },
      {
        id: "version-upgrade",
        title: english ? "Existing saves and cloud protocols remain compatible" : "旧存档与云端协议保持兼容",
        description: english
          ? "GameState v47, save envelope v2, cloud schema v8, and SQLite layout v3 remain unchanged."
          : "GameState v47、存档 envelope v2、cloud schema v8 和 SQLite layout v3 保持不变。",
      },
    ],
  } as const;
}
