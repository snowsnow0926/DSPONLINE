/** Hash exact UTF-8 payload bytes without allocating another full save copy. */
export function computeSavePayloadTextChecksum(value: string): { checksum: string; byteLength: number } {
  let hash = 0x811c9dc5;
  let byteLength = 0;
  // Keep both accumulators local to this loop. A captured per-byte callback
  // adds work to every byte of large payloads, including ordinary ASCII JSON.
  for (let index = 0; index < value.length; index += 1) {
    let code = value.charCodeAt(index);
    if (code <= 0x7f) {
      // JSON is mostly ASCII. Consume four bytes in their original FNV order
      // when all four are ASCII; Unicode still uses the exact encoder below.
      if (index + 3 < value.length) {
        const second = value.charCodeAt(index + 1);
        const third = value.charCodeAt(index + 2);
        const fourth = value.charCodeAt(index + 3);
        if ((second | third | fourth) <= 0x7f) {
          hash = Math.imul(hash ^ code, 0x01000193);
          hash = Math.imul(hash ^ second, 0x01000193);
          hash = Math.imul(hash ^ third, 0x01000193);
          hash = Math.imul(hash ^ fourth, 0x01000193);
          byteLength += 4;
          index += 3;
          continue;
        }
      }
      hash = Math.imul(hash ^ code, 0x01000193);
      byteLength += 1;
    } else if (code <= 0x7ff) {
      hash = Math.imul(hash ^ (0xc0 | code >> 6), 0x01000193);
      hash = Math.imul(hash ^ (0x80 | code & 0x3f), 0x01000193);
      byteLength += 2;
    } else {
      if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
        const low = value.charCodeAt(index + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
          index += 1;
          hash = Math.imul(hash ^ (0xf0 | code >> 18), 0x01000193);
          hash = Math.imul(hash ^ (0x80 | code >> 12 & 0x3f), 0x01000193);
          hash = Math.imul(hash ^ (0x80 | code >> 6 & 0x3f), 0x01000193);
          hash = Math.imul(hash ^ (0x80 | code & 0x3f), 0x01000193);
          byteLength += 4;
          continue;
        }
      }
      if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
      hash = Math.imul(hash ^ (0xe0 | code >> 12), 0x01000193);
      hash = Math.imul(hash ^ (0x80 | code >> 6 & 0x3f), 0x01000193);
      hash = Math.imul(hash ^ (0x80 | code & 0x3f), 0x01000193);
      byteLength += 3;
    }
  }
  return { checksum: (hash >>> 0).toString(16).padStart(8, "0"), byteLength };
}
