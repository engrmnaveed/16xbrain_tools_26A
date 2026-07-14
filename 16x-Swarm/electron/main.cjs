const { app, BrowserWindow, ipcMain, safeStorage, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const isDev = !!process.env.VITE_DEV_SERVER_URL;
const settingsPath = () => path.join(app.getPath('userData'), 'swarm-settings.json');

// ---------- Secure settings persistence ----------
function readSettingsFile() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'));
  } catch {
    return {};
  }
}

function writeSettingsFile(data) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(data, null, 2));
}

ipcMain.handle('settings:save', (_e, settings) => {
  const toStore = { ...settings };
  // Encrypt API key at rest when the OS keychain is available
  if (toStore.apiKey && safeStorage.isEncryptionAvailable()) {
    toStore.apiKeyEnc = safeStorage.encryptString(toStore.apiKey).toString('base64');
    delete toStore.apiKey;
  }
  writeSettingsFile(toStore);
  return true;
});

ipcMain.handle('settings:load', () => {
  const data = readSettingsFile();
  if (data.apiKeyEnc && safeStorage.isEncryptionAvailable()) {
    try {
      data.apiKey = safeStorage.decryptString(Buffer.from(data.apiKeyEnc, 'base64'));
    } catch {
      data.apiKey = '';
    }
  }
  delete data.apiKeyEnc;
  return data;
});

// ---------- Trace export ----------
ipcMain.handle('trace:export', async (_e, json) => {
  const win = BrowserWindow.getFocusedWindow();
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export run trace',
    defaultPath: `swarm-trace-${Date.now()}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (canceled || !filePath) return false;
  fs.writeFileSync(filePath, json);
  return true;
});

ipcMain.handle('shell:openExternal', (_e, url) => {
  if (/^https:\/\//.test(url)) shell.openExternal(url);
});

// ---------- Window ----------
function createWindow() {
  const win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: '#07090f',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (isDev) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  // Open external links in the default browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
