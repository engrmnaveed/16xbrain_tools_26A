const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dataflux', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  aiChat: (payload) => ipcRenderer.invoke('ai:chat', payload),
  aiModels: () => ipcRenderer.invoke('ai:models'),
  openSqlFile: () => ipcRenderer.invoke('file:openSql'),
  saveFile: (payload) => ipcRenderer.invoke('file:save', payload),
  platform: process.platform
});
