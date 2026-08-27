/**
 * Runs inside a disposable Chromium profile copied from Electron userData.
 * Keep this function self-contained: Playwright serializes it into the page.
 */
export async function extractWindows119RecordsInPage(options) {
  const databaseName = "dsp-idle-network.local-saves";
  const storeName = "records";
  const primaryKey = options.mode === "speedrun"
    ? "dsp-idle-network.save.v1.speedrun"
    : "dsp-idle-network.save.v1";
  const journalPrefix = `dsp-idle-network.internal.v1.chunked.v1.${options.mode}.`;
  const manifestKey = `${journalPrefix}manifest`;
  const transmit = globalThis.__dspWindows119Record;
  const transferChars = 512 * 1024;

  if (typeof transmit !== "function") throw new Error("离线读取桥未初始化");

  const requestResult = (request) => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB 请求失败"));
  });

  const openExistingDatabase = async () => {
    if (typeof indexedDB.databases === "function") {
      const databases = await indexedDB.databases();
      if (!databases.some((entry) => entry.name === databaseName)) return null;
    }
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName);
      let created = false;
      request.onupgradeneeded = () => {
        created = true;
      };
      request.onsuccess = () => {
        const database = request.result;
        if (created || !database.objectStoreNames.contains(storeName)) {
          database.close();
          resolve(null);
          return;
        }
        resolve(database);
      };
      request.onerror = () => reject(request.error ?? new Error("IndexedDB 打开失败"));
      request.onblocked = () => reject(new Error("IndexedDB 快照被其他进程锁定"));
    });
  };

  const database = await openExistingDatabase();
  const readValue = async (key) => {
    if (database) {
      const transaction = database.transaction(storeName, "readonly");
      const record = await requestResult(transaction.objectStore(storeName).get(key));
      if (record !== undefined) {
        if (!record || typeof record !== "object" || record.key !== key || typeof record.value !== "string") {
          return { status: "invalid", value: null };
        }
        return { status: "found", value: record.value };
      }
    }
    try {
      const value = localStorage.getItem(key);
      return value === null ? { status: "missing", value: null } : { status: "found", value };
    } catch {
      return { status: "missing", value: null };
    }
  };

  const sendRecord = async (label, key, result) => {
    if (result.status !== "found") {
      await transmit({ type: result.status, label, key });
      return;
    }
    const value = result.value;
    await transmit({ type: "start", label, key, charLength: value.length });
    let offset = 0;
    while (offset < value.length) {
      let end = Math.min(value.length, offset + transferChars);
      if (end < value.length) {
        const high = value.charCodeAt(end - 1);
        const low = value.charCodeAt(end);
        if (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) end -= 1;
      }
      await transmit({ type: "chunk", label, value: value.slice(offset, end) });
      offset = end;
    }
    await transmit({ type: "end", label, key, charLength: value.length });
  };

  const report = { databaseFound: Boolean(database), records: [] };
  try {
    const primary = await readValue(primaryKey);
    await sendRecord("primary", primaryKey, primary);
    report.records.push({ label: "primary", key: primaryKey, status: primary.status });

    const manifest = await readValue(manifestKey);
    await sendRecord("manifest", manifestKey, manifest);
    report.records.push({ label: "manifest", key: manifestKey, status: manifest.status });

    if (manifest.status === "found" && manifest.value.length <= 4 * 1024 * 1024) {
      let parsed = null;
      try { parsed = JSON.parse(manifest.value); } catch { /* core validator reports the fallback reason */ }
      const candidates = Array.isArray(parsed?.chunks) && parsed.chunks.length <= 4_096
        ? parsed.chunks
        : [];
      const ids = candidates.every((entry) => entry && typeof entry.id === "string" && entry.id.length > 0 && entry.id.length <= 512)
        ? [...new Set(candidates.map((entry) => entry.id))]
        : [];
      for (let index = 0; index < ids.length; index += 1) {
        const id = ids[index];
        const key = `${journalPrefix}chunk.${encodeURIComponent(id)}`;
        const label = `chunk-${String(index).padStart(4, "0")}`;
        const result = await readValue(key);
        await sendRecord(label, key, result);
        report.records.push({ label, key, status: result.status });
      }
    }
    return report;
  } finally {
    database?.close();
  }
}
