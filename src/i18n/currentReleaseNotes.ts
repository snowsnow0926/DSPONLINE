import type { AppLocale } from "./locale";

export const CURRENT_RELEASE_ID = "2026-11-14-v1.3.15";

/** Keep the menu summary small; historical notes stay behind the dialog. */
export function getCurrentReleaseNotes(locale: AppLocale) {
  const en = locale === "en";
  return {
    id: CURRENT_RELEASE_ID,
    date: en ? "November 14, 2026" : "2026年11月14日",
    version: "1.3.15",
    title: en ? "Mobile Web Scrolling and Save Takeover" : "手机网页滚动与存档接管修复",
    summary: en ? "Fixes recipe and item list scrolling on mobile browsers and lets a successful save takeover continue after reloading." : "修复手机浏览器中配方、物品列表无法滑动，以及接管本页后刷新仍提示只读的问题。",
    items: [
      { id: "v1315-scroll", title: en ? "Scroll recipe and item lists" : "配方与物品列表可滚动",
        description: en ? "Mobile selection panels keep a usable height in portrait, landscape and larger text settings, with their close button within reach." : "选择面板在手机横屏、竖屏和大字号下保持可用高度，可上下滑动浏览条目，关闭按钮保持可达。" },
      { id: "v1315-takeover", title: en ? "Continue after taking over a save" : "接管后继续游戏",
        description: en ? "A successful takeover keeps this page's save ownership through its reload. An abandoned page's short lease can also expire safely during startup." : "成功接管后，刷新会保留本页的存档管理身份；启动时也可等待已关闭页面遗留的短期占用安全到期。" },
      { id: "v1315-save", title: en ? "Preserve existing saves" : "保留原有存档",
        description: en ? "Existing saves stay intact during takeover. Other open pages remain read-only, protecting progress from older page state." : "接管和重新载入保留已有存档，其他页面继续受只读保护，避免旧页面覆盖新进度。" },
    ],
  } as const;
}
