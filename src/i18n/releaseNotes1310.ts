import type { AppLocale } from "./locale";

export function getReleaseNotes1310(locale: AppLocale) {
  const en = locale === "en";
  return {
    id: "2026-11-07-v1.3.10",
    date: en ? "November 7, 2026" : "2026年11月7日",
    version: "1.3.10",
    title: en ? "Windows Cloud Download Hotfix" : "Windows 云存档下载热修",
    summary: en ? "Fixes the remaining Windows cloud-download request error in 1.3.9. Existing factories and content packs remain compatible; upload and cancellation protections are preserved." : "修复 1.3.9 Windows 客户端仍无法下载云存档的问题，现有工厂与内容包继续兼容，保留上传和取消保护。",
    items: [
      { id: "v1310-cloud-download", title: en ? "Cloud saves download normally" : "云存档恢复正常下载", description: en ? "Windows no longer sends an upload-only header when downloading a main save, manual slot, historical revision or speedrun save." : "修复下载时出现“当前接口不接受该 DSP 请求头”的错误，覆盖主存档、手动槽位、历史修订和速通存档。" },
      { id: "v1310-transfer-protection", title: en ? "Upload and cancellation remain protected" : "保留上传与取消保护", description: en ? "Download tracking stays local to the app. Direct uploads retain their duplicate-submission protection, and interrupted transfers remain cancellable." : "下载通信编号只在客户端内部使用；直接上传继续防止重复提交，中断传输仍可正常取消。" },
      { id: "v1310-save-compatibility", title: en ? "Existing saves remain compatible" : "现有存档继续兼容", description: en ? "Existing factories, inventories, research and content packs are preserved. This hotfix does not change save formats or production rules." : "保留已有工厂、库存、科技和内容包，本次热修不改变存档格式或生产规则，无需修改存档文件。" },
    ],
  } as const;
}
