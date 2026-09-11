// The sandbox preload has Web Crypto and Buffer, but cannot require Node
// crypto. Bundle the existing incremental SHA-256 implementation so large
// transfers keep their streaming checksum and never need a second full copy.
const { sha256 } = require("@noble/hashes/sha2.js");
function createHash(algorithm) {
  if (algorithm !== "sha256") throw new Error("Unsupported sandbox hash");
  const hash = sha256.create();
  const api = {
    update(value, encoding = "utf8") {
      if (typeof value === "string") {
        if (encoding !== "utf8") throw new Error("Unsupported sandbox text encoding");
        value = new TextEncoder().encode(value);
      }
      hash.update(value);
      return api;
    },
    digest(encoding) {
      if (encoding !== "hex") throw new Error("Unsupported sandbox digest encoding");
      return Array.from(hash.digest(), (byte) => byte.toString(16).padStart(2, "0")).join("");
    },
  };
  return api;
}
module.exports = { createHash, randomUUID: () => globalThis.crypto.randomUUID() };
