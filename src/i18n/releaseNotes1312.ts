import type { AppLocale } from "./locale";



/** Keep the menu summary small; historical notes stay behind the dialog. */
export function getReleaseNotes1312(locale: AppLocale) {
  const en = locale === "en";
  return {
    id: "2026-11-13-v1.3.12",
    date: en ? "November 13, 2026" : "2026年11月13日",
    version: "1.3.12",
    title: en ? "Mobile Scrolling and Save Conflict Fixes" : "手机滚动与存档冲突修复",
    summary: en ? "Restores scrolling in mobile menus and pickers, moves the automatic card status clear of planet controls, and fixes repeated empty-save conflicts on Windows." : "修复手机菜单与选择列表无法下滑的问题，优化自动卡片状态的位置，并修复 Windows 空存档冲突反复弹出和处理入口无法操作的问题。",
    items: [
      { id: "v1312-mobile-scroll", title: en ? "Scroll mobile menus and lists" : "恢复手机菜单与列表滚动",
        description: en ? "New-game controls and item or recipe lists remain reachable in portrait, landscape and larger font settings." : "手机竖屏、横屏及大字号下，可上下滑动主菜单、物品与配方列表，正常找到新建存档等操作。" },
      { id: "v1312-canvas-status", title: en ? "Clearer automatic card status" : "优化自动卡片状态位置",
        description: en ? "The automatic card status has its own layout position, keeping planet navigation and mobile canvas controls accessible." : "为自动卡片状态安排独立布局位置，方便查看星球导航和操作手机画布工具。" },
      { id: "v1312-empty-conflict", title: en ? "Recover from empty-save conflicts" : "修复空存档冲突循环",
        description: en ? "Repeated deletion of an already empty save completes safely. Historical empty deletion reports no longer block creating or saving a factory." : "安全处理已为空的存档删除请求，避免历史空删除记录在重启后反复弹出，阻塞新建和保存工厂。" },
      { id: "v1312-conflict-actions", title: en ? "Resolve save conflicts from settings" : "恢复存档冲突处理入口",
        description: en ? "Settings now opens the available conflict choices. Explicit tab takeover and verification continue to protect actual save versions." : "设置页可点击“处理存档冲突”并转到版本选择，配合明确的标签页接管和存档读回校验，保护实际存档版本。" },
    ],
  } as const;
}
