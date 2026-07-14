const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('swarm', {
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  exportTrace: (json) => ipcRenderer.invoke('trace:export', json),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  platform: process.platform,
});
