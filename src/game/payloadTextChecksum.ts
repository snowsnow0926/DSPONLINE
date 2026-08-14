/** Hash exact UTF-8 payload bytes without allocating another full save copy. */
export function computeSavePayloadTextChecksum(value: string): { checksum: string; byteLength: number } {
  let hash = 0x811c9dc5;
  let byteLength = 0;
  const mix = (byte: number) => {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
    byteLength += 1;
  };
  for (let index = 0; index < value.length; index += 1) {
    let code = value.charCodeAt(index);
    if (code <= 0x7f) mix(code);
    else if (code <= 0x7ff) {
      mix(0xc0 | code >> 6);
      mix(0x80 | code & 0x3f);
    } else {
      if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
        const low = value.charCodeAt(index + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
          index += 1;
          mix(0xf0 | code >> 18);
          mix(0x80 | code >> 12 & 0x3f);
          mix(0x80 | code >> 6 & 0x3f);
          mix(0x80 | code & 0x3f);
          continue;
        }
      }
      if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
      mix(0xe0 | code >> 12);
      mix(0x80 | code >> 6 & 0x3f);
      mix(0x80 | code & 0x3f);
    }
  }
  return { checksum: (hash >>> 0).toString(16).padStart(8, "0"), byteLength };
}
