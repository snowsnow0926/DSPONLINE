/** Experimental only: preserve every UTF-16 unit while batching ASCII runs. */
export function measureSaveStateJsonAscii(formatVersion: number, stateJson: string): { stateChecksum: string; byteLength: number } {
  const prefix = `{"formatVersion":${JSON.stringify(formatVersion)},"state":`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < prefix.length; index += 1) hash = Math.imul(hash ^ prefix.charCodeAt(index), 0x01000193);
  let byteLength = 0;
  let index = 0;
  while (index < stateJson.length) {
    if (index + 3 < stateJson.length) {
      const a = stateJson.charCodeAt(index);
      const b = stateJson.charCodeAt(index + 1);
      const c = stateJson.charCodeAt(index + 2);
      const d = stateJson.charCodeAt(index + 3);
      if ((a | b | c | d) <= 0x7f) {
        hash = Math.imul(hash ^ a, 0x01000193);
        hash = Math.imul(hash ^ b, 0x01000193);
        hash = Math.imul(hash ^ c, 0x01000193);
        hash = Math.imul(hash ^ d, 0x01000193);
        byteLength += 4;
        index += 4;
        continue;
      }
    }
    const code = stateJson.charCodeAt(index++);
    hash = Math.imul(hash ^ code, 0x01000193);
    if (code <= 0x7f) byteLength += 1;
    else if (code <= 0x7ff) byteLength += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index < stateJson.length) {
      const low = stateJson.charCodeAt(index);
      if (low >= 0xdc00 && low <= 0xdfff) {
        hash = Math.imul(hash ^ low, 0x01000193);
        index += 1;
        byteLength += 4;
      } else byteLength += 3;
    } else byteLength += 3;
  }
  hash = Math.imul(hash ^ 0x7d, 0x01000193);
  return { stateChecksum: (hash >>> 0).toString(16).padStart(8, "0"), byteLength };
}
