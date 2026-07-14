const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const isDev = !!process.env.VITE_DEV;

function getStorePath() {
  return path.join(app.getPath('userData'), 'rag-explorer-store.json');
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    title: 'RAG Explorer — 16xBrains',
    backgroundColor: '#07080f',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) {
    win.loadURL('http://localhost:5173');
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

// ---------- IPC: file open dialog ----------
ipcMain.handle('open-files', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Documents', extensions: ['txt', 'md', 'markdown', 'pdf', 'json', 'csv', 'html'] }
    ]
  });
  if (canceled) return [];
  return filePaths.map((p) => {
    const ext = path.extname(p).toLowerCase();
    const name = path.basename(p);
    if (ext === '.pdf') {
      return { name, type: 'pdf', data: fs.readFileSync(p).toString('base64') };
    }
    return { name, type: 'text', data: fs.readFileSync(p, 'utf-8') };
  });
});

// ---------- IPC: persistence (projects, settings, API key) ----------
ipcMain.handle('store-load', async () => {
  try {
    return JSON.parse(fs.readFileSync(getStorePath(), 'utf-8'));
  } catch {
    return null;
  }
});

ipcMain.handle('store-save', async (_e, data) => {
  fs.writeFileSync(getStorePath(), JSON.stringify(data), 'utf-8');
  return true;
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
