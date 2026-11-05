import type { AppLocale } from "./locale";

export const CURRENT_RELEASE_ID = "2026-11-05-v1.3.8";

/** Keep the menu summary small; historical notes stay behind the dialog. */
export function getCurrentReleaseNotes(locale: AppLocale) {
  const en = locale === "en";
  return {
    id: CURRENT_RELEASE_ID,
    date: en ? "November 5, 2026" : "2026年11月5日",
    version: "1.3.8",
    title: en ? "Save Protection and Interaction Improvements" : "存档保护与操作体验更新",
    summary: en
      ? "Safer save recovery and cloud slots, clearer save feedback, reliable text drafts, and smoother keyboard, touch and large-text interfaces. Existing saves and backup preferences are preserved."
      : "补齐存档恢复和云槽位保护，明确保存状态，改善中文输入、名称草稿、菜单手势、大字号与浅色界面，保留现有存档和备份偏好。",
    items: [
      { id: "v138-save-feedback", title: en ? "Accurate save feedback" : "保存状态更准确",
        description: en ? "When browser storage is unavailable, the game clearly reports that progress has not been saved. Temporary sessions can still export their current progress." : "浏览器存储不可用时，明确提示当前进度尚未保存；临时运行仍可导出进度文件，不再把内存中的临时记录显示为保存成功。" },
      { id: "v138-recovery-points", title: en ? "Recovery points before replacement" : "恢复前保留旧进度",
        description: en ? "Cloud recovery and save rescue require a verified recovery point before replacing progress. Manual cloud slots preserve the actual old slot and reject data for a different target." : "云恢复和坏档救援先确认恢复点保存成功，再替换进度；手动云槽位保留真正被覆盖的旧槽位，拒绝写入其他位置的存档。" },
      { id: "v138-cancel-import", title: en ? "Safe cancellation and factory switching" : "取消与换档更安全",
        description: en ? "Cancelled or outdated imports and restores cannot overwrite a later factory. Failed file reads remove stale previews, and repeated confirmation starts one preparation." : "取消操作或切换工厂后，旧导入、救援和云恢复不会再覆盖后来选择的工厂；文件读取失败清除旧预览，重复确认只准备一次。" },
      { id: "v138-ime-drafts", title: en ? "Reliable Chinese input and drafts" : "中文输入与名称草稿保护",
        description: en ? "Confirming an IME word does not execute game commands. Editing text and selection survive responsive layout changes, while blueprint and region drafts stay with their own factory." : "输入法回车选字不会误执行游戏命令；同一编辑器横竖屏切换保留文字和选区，蓝图与区域名称草稿不会串到另一座工厂。" },
      { id: "v138-menu-gestures", title: en ? "Better menus and touch gestures" : "菜单与手机手势更顺手",
        description: en ? "Arrow keys, Tab, Escape and Space work within menus without toggling the simulation by accident. Closing windows restores the opener, and long-press menus remain open after release." : "菜单方向键、Tab、Esc 和空格各自处理当前操作，不误开关模拟；关闭窗口回到原入口，手机长按松手后菜单继续显示，打断的手势正确收尾。" },
      { id: "v138-update-safety", title: en ? "Safer client updates" : "客户端更新保护补丁",
        description: en ? "The Windows updater includes an upstream protection patch for unusually costly update manifests." : "更新 Windows 自动更新所用组件，补上异常更新清单可能长时间占用处理器的保护。" },
      { id: "v138-responsive-theme", title: en ? "Readable large text and light theme" : "大字号与浅色界面更清楚",
        description: en ? "Compact menus and search results remain reachable. Large-text desktop metrics scroll within the header, and cloud recovery cards use readable light surfaces. Existing factories, inventories, research and backup preferences are preserved." : "紧凑菜单和搜索结果可滚动到达；桌面大字号指标在头栏内横向查看，浅色云恢复页面文字更清晰。现有工厂、物资、科技和备份偏好保持不变。" },
    ],
  } as const;
}
