const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ragx', {
  openFiles: () => ipcRenderer.invoke('open-files'),
  storeLoad: () => ipcRenderer.invoke('store-load'),
  storeSave: (data) => ipcRenderer.invoke('store-save', data),
  platform: process.platform
});
