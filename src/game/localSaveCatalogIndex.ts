import {
  LOCAL_SAVE_WRITER_LEASE_KEY,
  localSaveRevisionKey,
  parseLocalSaveRevision,
  parseLocalSaveWriterLease,
} from "./localSaveCoordination";
import {
  localSaveCatalogRecordKey,
  serializeLocalSaveCatalog,
  type LocalSaveCatalog,
} from "./localSaveCatalog";
import { buildLocalSaveCatalog } from "./localSaveCatalogBuild";

interface StoredRecord {
  key: string;
  value: string;
  updatedAt: number;
  bytes: number;
}

let workerRequestId = 0;

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  });
}

async function buildOffMain(key: string, payload: string, revision: number): Promise<{ catalog: LocalSaveCatalog; worker: boolean }> {
  if (typeof Worker === "undefined") return { catalog: buildLocalSaveCatalog(key, payload, revision), worker: false };
  const id = ++workerRequestId;
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./localSaveCatalog.worker.ts", import.meta.url), { type: "module", name: "local-save-catalog" });
    } catch {
      resolve({ catalog: buildLocalSaveCatalog(key, payload, revision), worker: false });
      return;
    }
    let settled = false;
    const finish = (catalog?: LocalSaveCatalog) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      resolve(catalog ? { catalog, worker: true } : { catalog: buildLocalSaveCatalog(key, payload, revision), worker: false });
    };
    worker.onerror = () => finish();
    worker.onmessageerror = () => finish();
    worker.onmessage = (event: MessageEvent<{ id: number; catalog?: LocalSaveCatalog; error?: string }>) => {
      if (event.data.id !== id || event.data.error || !event.data.catalog) return finish();
      finish(event.data.catalog);
    };
    try { worker.postMessage({ id, key, payload, revision }); }
    catch { finish(); }
  });
}

export async function indexLegacyLocalSaveCatalog(
  database: IDBDatabase,
  storeName: string,
  key: string,
  writer: { writerId: string; fencingToken: number },
): Promise<{ catalog: LocalSaveCatalog; updatedAt: number; worker: boolean } | null> {
  const readTransaction = database.transaction(storeName, "readonly");
  const readDone = transactionDone(readTransaction);
  const readStore = readTransaction.objectStore(storeName);
  const [payloadRecord, existingCatalog, revisionRecord] = await Promise.all([
    requestResult(readStore.get(key) as IDBRequest<StoredRecord | undefined>),
    requestResult(readStore.get(localSaveCatalogRecordKey(key)) as IDBRequest<StoredRecord | undefined>),
    requestResult(readStore.get(localSaveRevisionKey(key)) as IDBRequest<StoredRecord | undefined>),
  ]);
  await readDone;
  if (!payloadRecord || existingCatalog) return null;
  const revision = parseLocalSaveRevision(revisionRecord?.value);
  const built = await buildOffMain(key, payloadRecord.value, revision?.revision ?? 0);

  const writeTransaction = database.transaction(storeName, "readwrite");
  const writeDone = transactionDone(writeTransaction);
  const writeStore = writeTransaction.objectStore(storeName);
  const [currentPayload, currentCatalog, currentRevisionRecord, leaseRecord] = await Promise.all([
    requestResult(writeStore.get(key) as IDBRequest<StoredRecord | undefined>),
    requestResult(writeStore.get(localSaveCatalogRecordKey(key)) as IDBRequest<StoredRecord | undefined>),
    requestResult(writeStore.get(localSaveRevisionKey(key)) as IDBRequest<StoredRecord | undefined>),
    requestResult(writeStore.get(LOCAL_SAVE_WRITER_LEASE_KEY) as IDBRequest<StoredRecord | undefined>),
  ]);
  const currentRevision = parseLocalSaveRevision(currentRevisionRecord?.value);
  const lease = parseLocalSaveWriterLease(leaseRecord?.value);
  const unchangedRevision = (currentRevision?.revision ?? 0) === (revision?.revision ?? 0) &&
    (currentRevision?.checksum ?? null) === (revision?.checksum ?? null) &&
    (currentRevision?.savedAt ?? 0) === (revision?.savedAt ?? 0);
  const leaseMatches = lease?.ownerId === writer.writerId && lease.fencingToken === writer.fencingToken && lease.expiresAt > Date.now();
  if (!currentPayload || currentCatalog || currentPayload.value !== payloadRecord.value || !unchangedRevision || !leaseMatches) {
    await writeDone;
    return null;
  }
  const value = serializeLocalSaveCatalog(built.catalog);
  writeStore.put({ key: localSaveCatalogRecordKey(key), value, updatedAt: Date.now(), bytes: new TextEncoder().encode(value).byteLength } satisfies StoredRecord);
  await writeDone;
  return { catalog: built.catalog, updatedAt: payloadRecord.updatedAt, worker: built.worker };
}
