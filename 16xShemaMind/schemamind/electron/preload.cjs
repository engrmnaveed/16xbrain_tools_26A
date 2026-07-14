const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('schemamind', {
  openFile: (filters) => ipcRenderer.invoke('dialog:openFile', filters),
  saveFile: (opts) => ipcRenderer.invoke('dialog:saveFile', opts),
  writePath: (opts) => ipcRenderer.invoke('fs:writePath', opts),
  version: () => ipcRenderer.invoke('app:version'),
  onMenu: (channel, cb) => {
    const valid = ['menu:new', 'menu:open', 'menu:save', 'menu:import', 'menu:export', 'menu:undo', 'menu:redo', 'menu:docs'];
    if (!valid.includes(channel)) return () => {};
    const handler = () => cb();
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  }
});
