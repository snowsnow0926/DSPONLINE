import type { AppLocale } from "./locale";

export const CURRENT_RELEASE_ID = "2026-11-19-v1.3.16";

/** Keep the menu summary small; historical notes stay behind the dialog. */
export function getCurrentReleaseNotes(locale: AppLocale) {
  const en = locale === "en";
  return {
    id: CURRENT_RELEASE_ID,
    date: en ? "November 19, 2026" : "2026年11月19日",
    version: "1.3.16",
    title: en ? "Mobile Canvas and Building Placement Fixes" : "手机画布触控与建筑部署修复",
    summary: en ? "Restores one-finger panning after an interrupted touch and keeps pending buildings available after pinching to zoom." : "修复手机上触控中断后单指误缩放，以及双指缩放后待部署建筑消失的问题。",
    items: [
      { id: "v1316-pan", title: en ? "One-finger panning recovers" : "触控中断后恢复单指平移",
        description: en ? "Releasing a finger outside the canvas or interrupting a gesture clears stale touches. The next single-finger drag pans the canvas." : "手指在画布外抬起或触控被打断时，会清理残留触点。下一次单指拖动可正常平移画布。" },
      { id: "v1316-pinch", title: en ? "Pinch zoom follows your fingers" : "双指缩放跟随手指中心",
        description: en ? "The canvas zooms around the midpoint between your fingers in portrait and landscape, even when a pinch starts on a building." : "横屏或竖屏时，画布围绕双指的中点缩放，从建筑上起手也能正常缩放。" },
      { id: "v1316-placement", title: en ? "Continue placing after zooming" : "缩放后继续部署建筑",
        description: en ? "Pinching keeps the selected building, quantity or blueprint. Lift your fingers, then tap a spot on the canvas to place it." : "双指缩放会保留已选建筑、数量或蓝图。松手后点画布落点即可部署。" },
    ],
  } as const;
}
