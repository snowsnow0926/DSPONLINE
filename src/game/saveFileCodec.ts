const MAXIMUM_LOCAL_SAVE_FILE_BYTES = 256 * 1024 * 1024;

export async function compressSaveTextToGzipBlob(contents: string): Promise<Blob | null> {
  if (typeof CompressionStream === "undefined" || typeof Blob === "undefined" || typeof Response === "undefined") return null;
  try {
    return await new Response(
      new Blob([contents], { type: "application/json;charset=utf-8" })
        .stream()
        .pipeThrough(new CompressionStream("gzip")),
    ).blob();
  } catch {
    return null;
  }
}

async function fileHasGzipMagic(file: File): Promise<boolean> {
  if (file.size < 2) return false;
  const header = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  return header[0] === 0x1f && header[1] === 0x8b;
}

async function readBoundedStream(stream: ReadableStream<Uint8Array>, maximumBytes: number): Promise<ArrayBuffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) throw new Error("存档解压流返回了无效数据");
      total += next.value.byteLength;
      if (total > maximumBytes) throw new Error("解压后的存档超过 256 MiB 安全上限");
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
}

/** Read legacy .json and compressed .json.gz saves through one bounded API. */
export async function readSaveFileText(file: File): Promise<string> {
  if (file.size <= 0) throw new Error("存档文件为空");
  if (file.size > MAXIMUM_LOCAL_SAVE_FILE_BYTES) throw new Error("存档文件超过 256 MiB 安全上限");
  const gzip = await fileHasGzipMagic(file);
  if (!gzip) return file.text();
  if (typeof DecompressionStream === "undefined") throw new Error("当前浏览器不支持 gzip 存档，请先解压为 JSON");
  let bytes: ArrayBuffer;
  try {
    bytes = await readBoundedStream(
      file.stream().pipeThrough(new DecompressionStream("gzip")),
      MAXIMUM_LOCAL_SAVE_FILE_BYTES,
    );
  } catch (error) {
    if (error instanceof Error && /256 MiB/.test(error.message)) throw error;
    throw new Error("gzip 存档损坏或无法解压");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("gzip 存档不是合法 UTF-8 JSON");
  }
}
