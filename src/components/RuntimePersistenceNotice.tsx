import { useSyncExternalStore } from "react";
import type { RuntimePersistenceViewStore } from "../game/runtimePersistenceViewStore";

function persistentNotice(message: string): boolean {
  return /失败|错误|异常|损坏|未保存|冲突|无法|不能|不可|未执行|超出安全|成就解锁|研究完成|任务完成|云端已有|同步失败/.test(message);
}

function noticeTone(message: string): "achievement" | "success" | "warning" | "danger" | "neutral" {
  if (/成就解锁/.test(message)) return "achievement";
  if (/失败|错误|异常|损坏|未保存|冲突|无法|不能|不可|超出安全|同步失败/.test(message)) return "danger";
  if (/不足|警告|暂停|尚未|等待|未执行|需要手动|需要确认/.test(message)) return "warning";
  if (/完成|成功|已保存|已更新|已创建|已放置|已回收|已升级|已定位|已开启|已切换|研究完成|任务完成/.test(message)) return "success";
  return "neutral";
}

export function RuntimePersistenceNotice({
  store,
  notice,
  showRunLog,
}: {
  store: RuntimePersistenceViewStore;
  notice: string | null;
  showRunLog: boolean;
}) {
  const progress = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  if (progress) {
    const tone = progress.phase === "failed" ? "danger" : progress.phase === "complete" ? "success" : "warning";
    return <div className={`game-notice game-notice--${tone} runtime-persistence-progress`} role="status" data-persistence-progress>{progress.message}</div>;
  }
  return notice && (showRunLog || persistentNotice(notice))
    ? <div className={`game-notice game-notice--${noticeTone(notice)}`} role="status" data-notice-tone={noticeTone(notice)}>{notice}</div>
    : null;
}
