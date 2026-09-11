"use strict";

function loopback(host) {
  return ["127.0.0.1", "::1", "[::1]", "localhost"].includes(String(host ?? "localhost").toLowerCase());
}
function localResource(url) {
  try {
    const parsed = new URL(url);
    return ["file:", "data:", "blob:", "devtools:", "chrome:"].includes(parsed.protocol)
      || (["http:", "https:", "ws:", "wss:"].includes(parsed.protocol) && loopback(parsed.hostname));
  } catch { return false; }
}

// Additional restrictions for the existing isolated performance smoke mode.
// The ordinary application does not install these process-local hooks.
function installIsolatedTestNetwork({ app, session, shell, metadata, environment = process.env }) {
  if (environment.DSP_PERFORMANCE_SMOKE_ISOLATION !== "1") return null;
  if (metadata.desktopEditionId !== "windows-performance-development-v1" || metadata.cloudApiBaseUrl !== "" || metadata.updateBaseUrl !== "") {
    throw new Error("Isolated desktop tests require the offline performance edition");
  }
  const audit = { policy: "loopback-only-v1", nodeBlocked: 0, chromiumBlocked: 0, externalBlocked: 0 };
  const blocked = () => { audit.nodeBlocked += 1; throw new Error("DSP_ISOLATED_NETWORK_BLOCKED"); };
  const net = require("node:net");
  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const first = args[0];
    const options = Array.isArray(first) ? first[0] : first;
    // Local named pipes are used by Chromium/Playwright, never network shares.
    if (typeof options === "string" && /^\\\\\.\\pipe\\/.test(options)) return originalConnect.apply(this, args);
    if (options && typeof options === "object" && options.path && /^\\\\\.\\pipe\\/.test(options.path)) return originalConnect.apply(this, args);
    const host = typeof options === "object" ? options.host : typeof args[1] === "string" ? args[1] : "localhost";
    if (typeof options === "string") return blocked();
    if (!loopback(host) || (typeof options === "object" && options.path)) return blocked();
    return originalConnect.apply(this, args);
  };
  for (const protocol of ["node:http", "node:https"]) {
    const module = require(protocol);
    for (const name of ["request", "get"]) {
      const original = module[name];
      module[name] = function (...args) {
        const target = args[0];
        const url = typeof target === "string" || target instanceof URL ? new URL(target) : null;
        const override = args[1] && typeof args[1] === "object" ? args[1] : {};
        if (!loopback(override.hostname ?? override.host ?? url?.hostname ?? target?.hostname ?? target?.host)) return blocked();
        return original.apply(this, args);
      };
    }
  }
  const dns = require("node:dns");
  for (const key of Object.keys(dns)) {
    if ((key === "lookup" || key.startsWith("resolve")) && typeof dns[key] === "function") {
      const original = dns[key];
      dns[key] = function (hostname, ...args) {
        if (!loopback(hostname)) return blocked();
        return original.call(this, hostname, ...args);
      };
    }
  }
  require("node:dgram").createSocket = blocked;
  shell.openExternal = async () => { audit.externalBlocked += 1; throw new Error("DSP_ISOLATED_EXTERNAL_BLOCKED"); };
  const configure = (target) => target.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    const cancel = !localResource(details.url);
    if (cancel) audit.chromiumBlocked += 1;
    callback({ cancel });
  });
  app.on("session-created", configure);
  app.whenReady().then(() => configure(session.defaultSession));
  app.commandLine.appendSwitch("disable-background-networking");
  app.commandLine.appendSwitch("force-webrtc-ip-handling-policy", "disable_non_proxied_udp");
  globalThis.__dspIsolatedNetworkAudit = audit;
  return audit;
}
module.exports = { loopback, localResource, installIsolatedTestNetwork };
