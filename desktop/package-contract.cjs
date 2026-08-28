const MINIMUM_GUARANTEED_SAVE_BYTES = 96 * 1024 * 1024;
const MINIMUM_SAVE_LIMIT_BYTES = 256 * 1024 * 1024;
const MINIMUM_MAXIMUM_TIMEOUT_MS = 600_000;

function validatePackagedTransferContract(actual, expected) {
  if (!actual || typeof actual !== "object" || !expected || typeof expected !== "object") {
    throw new Error("桌面安装包缺少云传输契约");
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("桌面安装包云传输契约与冻结源码不一致");
  }
  if (actual.guaranteedSavePayloadBytes < MINIMUM_GUARANTEED_SAVE_BYTES ||
      actual.savePayloadLimitBytes < MINIMUM_SAVE_LIMIT_BYTES ||
      actual.maximumTimeoutMs < MINIMUM_MAXIMUM_TIMEOUT_MS) {
    throw new Error("桌面安装包缺少当前大存档云传输契约");
  }
  return true;
}

module.exports = { validatePackagedTransferContract };
