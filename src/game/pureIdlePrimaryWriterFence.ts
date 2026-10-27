import { LOCAL_SAVE_WRITER_LEASE_KEY, parseLocalSaveWriterLease } from "./localSaveCoordination";

export interface PureIdlePrimaryWriterFence { ownerId: string; fencingToken: number }

function verifyPrimaryWriter(fence: PureIdlePrimaryWriterFence): Promise<void> {
  return new Promise((resolve, reject) => {
    let finished = false;
    const fail = (error: Error) => { if (!finished) { finished = true; reject(error); } };
    const request = indexedDB.open("dsp-idle-network.local-saves", 2);
    request.onerror = () => fail(request.error ?? new Error("无法核对主存档写入权"));
    request.onblocked = () => fail(new Error("主存档数据库正在升级"));
    request.onupgradeneeded = () => { request.transaction?.abort(); fail(new Error("主存档数据库尚未准备")); };
    request.onsuccess = () => {
      const db = request.result;
      if (finished) { db.close(); return; }
      try {
        const read = db.transaction("records").objectStore("records").get(LOCAL_SAVE_WRITER_LEASE_KEY);
        read.onerror = () => { db.close(); fail(read.error ?? new Error("无法读取主存档写入权")); };
        read.onsuccess = () => {
          db.close();
          const lease = parseLocalSaveWriterLease(read.result?.value ?? null);
          if (!lease || lease.ownerId !== fence.ownerId || lease.fencingToken !== fence.fencingToken || lease.expiresAt <= Date.now()) {
            fail(new Error("主存档写入权已变化，旧纯挂机检查点未写入"));
          } else { finished = true; resolve(); }
        };
      } catch (error) { db.close(); fail(error instanceof Error ? error : new Error(String(error))); }
    };
  });
}

/** Keep the recovery write transaction locked during the short, read-only
 * primary lease check. A legacy takeover either precedes this check (reject)
 * or finalizes the new journal after this transaction (never a late orphan).
 * The write runs in our next IDB success callback, where the transaction is
 * active; running it directly in the other database's callback is invalid. */
export function writeBehindPrimaryWriterFence(
  transaction: IDBTransaction, store: IDBObjectStore, fence: PureIdlePrimaryWriterFence, write: () => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let decision: true | Error | null = null;
    let finished = false;
    const fail = (error: Error) => {
      if (finished) return;
      finished = true; clearTimeout(deadline);
      try { transaction.abort(); } catch { /* already aborted */ }
      reject(error);
    };
    const deadline = setTimeout(() => fail(new Error("主存档写入权核对超时")), 5000);
    void verifyPrimaryWriter(fence).then(() => { decision = true; }, error => {
      decision = error instanceof Error ? error : new Error(String(error));
    });
    const pulse = () => {
      if (finished) return;
      try {
        const request = store.get("takeover-fence");
        request.onerror = () => fail(request.error ?? new Error("恢复日志事务已中断"));
        request.onsuccess = () => {
          if (finished) return;
          if (decision === null) { pulse(); return; }
          if (decision instanceof Error) { fail(decision); return; }
          try {
            write(); finished = true; clearTimeout(deadline); resolve();
          } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
        };
      } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
    };
    pulse();
  });
}
