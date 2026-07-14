const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('selfheal', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (s) => ipcRenderer.invoke('settings:set', s),
  aiChat: (payload) => ipcRenderer.invoke('ai:chat', payload),
  aiModels: () => ipcRenderer.invoke('ai:models'),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  platform: process.platform,
});
