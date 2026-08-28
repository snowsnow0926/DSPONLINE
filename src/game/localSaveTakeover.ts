import { getLocalSaveWriterStatus, takeOverLocalSaveWriter } from "./localSaveStore";

export interface CurrentTabTakeoverResult {
  ok: boolean;
  message: string;
  reload: boolean;
}

type CurrentTabTakeoverHandler = () => Promise<CurrentTabTakeoverResult>;

let runtimeHandler: CurrentTabTakeoverHandler | null = null;
let activeRequest: Promise<CurrentTabTakeoverResult> | null = null;

/** Register the live factory handler that can persist the current in-memory state. */
export function registerCurrentTabTakeoverHandler(handler: CurrentTabTakeoverHandler): () => void {
  runtimeHandler = handler;
  return () => {
    if (runtimeHandler === handler) runtimeHandler = null;
  };
}

/**
 * One entry point is shared by Settings and every cross-tab warning banner.
 * The start menu can only claim the lease and reload the already-persisted
 * save; the live factory handler additionally writes and reads back the state
 * currently visible in this tab before reloading.
 */
export function requestCurrentTabTakeover(): Promise<CurrentTabTakeoverResult> {
  if (activeRequest) return activeRequest;
  const run = runtimeHandler
    ? runtimeHandler()
    : (async () => {
        if (getLocalSaveWriterStatus().role === "conflict") {
          return { ok: false, reload: false, message: "请先处理已保留的存档冲突，再接管标签页" };
        }
        const ok = await takeOverLocalSaveWriter();
        return ok
          ? { ok: true, reload: true, message: "本标签页已取得本地存档写入权，正在重新载入" }
          : { ok: false, reload: false, message: "接管失败；原存档和旧标签页均未修改" };
      })();
  activeRequest = run.finally(() => { activeRequest = null; });
  return activeRequest;
}
