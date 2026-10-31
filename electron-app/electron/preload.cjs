// The page's only way to reach the main process: window.anicli.

const { contextBridge, ipcRenderer } = require("electron");

const EVENTS = ["ani:output", "ani:menu", "ani:exit", "ani:stream"];

contextBridge.exposeInMainWorld("anicli", {
  start: (id, args) => ipcRenderer.invoke("ani:start", { id, args }),
  answer: (session, text) => ipcRenderer.invoke("ani:answer", { session, text }),
  finish: (session) => ipcRenderer.invoke("ani:finish", { session }),
  stop: () => ipcRenderer.invoke("ani:stop"),
  history: () => ipcRenderer.invoke("ani:history"),
  environment: () => ipcRenderer.invoke("ani:environment"),
  /** Subscribes to one of EVENTS; returns an unsubscribe function. */
  on(event, callback) {
    if (!EVENTS.includes(event)) throw new Error(`unknown event ${event}`);
    const listener = (_e, payload) => callback(payload);
    ipcRenderer.on(event, listener);
    return () => ipcRenderer.removeListener(event, listener);
  },
});
