const { randomUUID } = require("node:crypto");

// A timeout is a refusal to close, never permission to kill the renderer.
function createGracefulClose({ send, close, failure, timeoutMs = 20000 }) {
  let pending = null;
  let approved = false;
  return {
    get approved() { return approved; },
    request() {
      if (approved || pending) return;
      const token = randomUUID();
      const deadline = Date.now() + timeoutMs;
      const timer = setTimeout(() => {
        if (pending?.token !== token) return;
        pending = null;
        send("desktop:cancel-close", { token });
        failure("保存退出超时，窗口保持打开；请等待当前保存完成后重试。");
      }, timeoutMs);
      pending = { token, timer };
      send("desktop:prepare-close", { token, deadline });
    },
    acknowledge(result) {
      if (!pending || result?.token !== pending.token || typeof result.ok !== "boolean") return false;
      clearTimeout(pending.timer);
      pending = null;
      if (result.ok) { approved = true; close(); }
      else failure("退出前保存未完成，窗口保持打开。请处理存档提示后重试。");
      return true;
    },
    dispose() { if (pending) clearTimeout(pending.timer); pending = null; },
  };
}
module.exports = { createGracefulClose };
