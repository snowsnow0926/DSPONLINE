import type { AppLocale } from "./locale";

export const RELEASE_137_ID = "2026-11-04-v1.3.7";

/** Immutable historical copy, loaded with the release-notes dialog. */
export function getReleaseNotes137(locale: AppLocale) {
  const en = locale === "en";
  return {
    id: RELEASE_137_ID,
    date: en ? "November 4, 2026" : "2026年11月4日",
    version: "1.3.7",
    title: en ? "Stable Search Input and Mobile Search Fixes" : "搜索输入与手机搜索修复",
    summary: en
      ? "Keep search text while the factory refreshes and make recent searches easier to use in landscape. Existing saves and backup preferences are preserved."
      : "修复打字时搜索内容自动消失，以及横屏最近搜索被底部导航遮挡的问题，保留现有存档与备份偏好。",
    items: [
      { id: "v137-ime-input", title: en ? "Keep search text while typing" : "修复搜索打字消失",
        description: en ? "Chinese input stays in the search field while the factory refreshes, even before you confirm a word. Your cursor and selection stay in place." : "中文输入法还在拼字时，工厂刷新不再清空输入内容，光标和选中文字一并保留。" },
      { id: "v137-input-actions", title: en ? "Search actions keep working" : "保留正常搜索操作",
        description: en ? "Confirming text, typing English, clearing the field and selecting a recent search continue to work. Other shared text fields receive the same input protection." : "确认汉字、英文输入、清空搜索和选择历史词继续正常使用，共用文本框同步获得输入保护。" },
      { id: "v137-search-history", title: en ? "Recent searches stay within reach" : "横屏历史搜索可见可点",
        description: en ? "Recent searches open above or below the field to fit the visible panel. Longer lists scroll so the bottom navigation does not hide their buttons." : "最近搜索根据可用空间向上或向下展开，长列表可以滚动，避免选项和清除按钮被底部导航挡住。" },
      { id: "v137-landscape-layout", title: en ? "More room in landscape" : "横屏制造布局更紧凑",
        description: en ? "Search and batch controls sit side by side in landscape, leaving more room for recipe results and keeping touch controls inside their frames." : "横屏时搜索与批次数量并排显示，为配方结果留出空间，手机输入框随内容自然增高。" },
      { id: "v137-compatibility", title: en ? "Continue with existing saves" : "现有存档可直接继续",
        description: en ? "Existing factories, inventories, research and backup preferences are preserved. Continue with your current save after updating." : "现有工厂、物资、科技和备份偏好保持不变，升级后可以继续游玩。" },
    ],
  } as const;
}
