import type { AppLocale } from "./locale";

/**
 * The start menu only needs the current release summary. Keep it in a small
 * eager module so the historical release archive stays behind the dialog's
 * lazy boundary and does not inflate the first menu render.
 */
export function getCurrentReleaseNotes(locale: AppLocale) {
  const english = locale === "en";
  return {
    id: "2026-08-27-v1.2.3",
    date: english ? "August 27, 2026" : "2026年8月27日",
    version: "1.2.3",
    title: english ? "Windows Native Incremental Hot-path Optimization" : "Windows 原生增量热路径优化",
    summary: english
      ? "Version 1.2.3 adds active-revision dirty-page saves, a provably wakeable belt queue, bounded viewport/statistics projections, and streaming v47 export to the Windows native candidate. Dense factories retain exact full scans, and native authority remains gated. Existing GameState v47 / envelope v2 saves remain compatible."
      : "1.2.3 为 Windows 原生候选增加活动 revision 脏页保存、可证明唤醒的线路队列、有界视口/统计投影和 v47 流式导出。高密度活动工厂继续精确全扫描，原生权威仍受门禁限制；旧版 GameState v47 / envelope v2 存档保持兼容。",
    items: [
      {
        id: "native-active-dirty-pages",
        title: english ? "Active saves encode only genuinely dirty pages" : "活动存档只编码真实脏页",
        description: english
          ? "Entity, belt, top-level, and topology dirtiness clears only after the complete durable checkpoint commits; failed attempts remain retryable."
          : "实体、线路、顶层和拓扑脏标记只在完整检查点持久提交后清除；失败重试不会漏掉变化。",
      },
      {
        id: "native-event-driven-belts",
        title: english ? "Stable belts sleep and wake exactly" : "稳定线路可休眠并准确唤醒",
        description: english
          ? "Closed wake signals skip genuinely stable routes, while dense active factories automatically retain the exact full scan."
          : "闭合唤醒信号只跳过真正稳定的路由；活动比例高的极限档会自动保留精确全扫描。",
      },
      {
        id: "native-bounded-projections",
        title: english ? "The UI requests bounded projection pages" : "UI 只请求有界投影页",
        description: english
          ? "Viewport and statistics responses are capped at 1 MiB and carry session, revision, sequence, length, and SHA-256 identity."
          : "视口和统计响应上限为 1 MiB，并携带 session、revision、sequence、长度与 SHA-256 身份。",
      },
      {
        id: "native-streaming-v47-export",
        title: english ? "The native core streams v47 exports" : "原生核心流式导出 v47",
        description: english
          ? "Compatible envelope v2 files are generated and verified outside the renderer without first building a second complete JSON body there."
          : "兼容 envelope v2 文件在 renderer 外生成并复核，不要求页面先构造第二份完整 JSON 正文。",
      },
      {
        id: "native-authority-gate",
        title: english ? "Native authority remains fail-closed" : "原生权威继续失败关闭",
        description: english
          ? "JavaScript remains player-visible authority until the full 24-hour, multi-hardware, signing, and rollout gates finish."
          : "完整 24 小时、多硬件、签名和灰度门禁完成前，JavaScript 仍是玩家可见权威。",
      },
    ],
  } as const;
}
