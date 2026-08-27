const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dspShellLab", Object.freeze({
  getConfiguration: () => ipcRenderer.invoke("shell-lab:get-configuration"),
  submitRendererMetrics: (metrics) => ipcRenderer.invoke("shell-lab:submit-renderer-metrics", metrics),
}));
