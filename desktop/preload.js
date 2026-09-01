const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("steamApp", {
  getState: () => ipcRenderer.invoke("get-state"),
  saveSettings: (partial) => ipcRenderer.invoke("save-settings", partial),
  login: () => ipcRenderer.invoke("steam-login"),
  logout: () => ipcRenderer.invoke("logout"),
  sync: () => ipcRenderer.invoke("sync-now"),
  createShortcuts: () => ipcRenderer.invoke("create-shortcuts"),
  pickIcon: () => ipcRenderer.invoke("pick-icon"),
  resetIcon: () => ipcRenderer.invoke("reset-icon"),
  toggleSkipped: (payload) => ipcRenderer.invoke("toggle-skipped", payload),
  phoneLinkStatus: () => ipcRenderer.invoke("phone-link-status"),
  startPhoneLink: () => ipcRenderer.invoke("phone-link-start"),
  stopPhoneLink: () => ipcRenderer.invoke("phone-link-stop"),
  hide: () => ipcRenderer.send("hide-window"),
  openUrl: (url) => ipcRenderer.send("open-url", url),
  onSync: (handler) => {
    const listen = (_event, payload) => handler(payload);
    ipcRenderer.on("sync-status", listen);
    return () => ipcRenderer.removeListener("sync-status", listen);
  },
});
