const { app, BrowserWindow, ipcMain, dialog, shell, net } = require('electron');
const path = require('path');
const fs = require('fs');

const isDev = !!process.env.VITE_DEV_SERVER_URL;

// ---- Secure settings storage (API key lives here, never in renderer localStorage) ----
const settingsPath = () => path.join(app.getPath('userData'), 'dataflux-settings.json');

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    return {};
  }
}
function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1080,
    minHeight: 700,
    backgroundColor: '#0a0e1a',
    icon: path.join(__dirname, '../build/icon.png'),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  if (isDev) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  // External links open in the system browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ---- IPC: settings ----
ipcMain.handle('settings:get', () => {
  const s = readSettings();
  // Do not leak the raw key; renderer only needs to know if one is set + a masked hint
  return {
    hasApiKey: !!s.openrouterKey,
    keyHint: s.openrouterKey ? `sk-or-...${s.openrouterKey.slice(-4)}` : null,
    model: s.model || 'anthropic/claude-3.5-sonnet',
    temperature: typeof s.temperature === 'number' ? s.temperature : 0.3
  };
});
ipcMain.handle('settings:set', (_e, patch) => {
  const allowed = {};
  if (typeof patch.openrouterKey === 'string' && patch.openrouterKey.trim()) {
    allowed.openrouterKey = patch.openrouterKey.trim();
  }
  if (patch.clearKey) allowed.openrouterKey = '';
  if (typeof patch.model === 'string') allowed.model = patch.model;
  if (typeof patch.temperature === 'number') allowed.temperature = patch.temperature;
  const s = writeSettings(allowed);
  return { hasApiKey: !!s.openrouterKey, model: s.model, temperature: s.temperature };
});

// ---- IPC: OpenRouter proxy (key stays in main process) ----
ipcMain.handle('ai:chat', async (_e, { messages, json = false, maxTokens = 2048 }) => {
  const s = readSettings();
  if (!s.openrouterKey) return { error: 'NO_KEY' };

  const body = {
    model: s.model || 'anthropic/claude-3.5-sonnet',
    messages,
    temperature: typeof s.temperature === 'number' ? s.temperature : 0.3,
    max_tokens: maxTokens
  };
  if (json) body.response_format = { type: 'json_object' };

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${s.openrouterKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://16xbrains.com',
        'X-Title': '16xDataFlux'
      },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) {
      return { error: data?.error?.message || `HTTP ${res.status}` };
    }
    return {
      content: data.choices?.[0]?.message?.content ?? '',
      usage: data.usage || null,
      model: data.model
    };
  } catch (err) {
    return { error: err.message || 'Network error' };
  }
});

// ---- IPC: list models from OpenRouter ----
ipcMain.handle('ai:models', async () => {
  const s = readSettings();
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      headers: s.openrouterKey ? { Authorization: `Bearer ${s.openrouterKey}` } : {}
    });
    const data = await res.json();
    return (data.data || [])
      .map((m) => ({ id: m.id, name: m.name, context: m.context_length }))
      .sort((a, b) => a.id.localeCompare(b.id));
  } catch {
    return [];
  }
});

// ---- IPC: file open/save ----
ipcMain.handle('file:openSql', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    filters: [{ name: 'SQL files', extensions: ['sql', 'ddl', 'txt'] }],
    properties: ['openFile']
  });
  if (canceled || !filePaths[0]) return null;
  return {
    name: path.basename(filePaths[0]),
    content: fs.readFileSync(filePaths[0], 'utf8')
  };
});
ipcMain.handle('file:save', async (_e, { defaultName, content }) => {
  const { canceled, filePath } = await dialog.showSaveDialog({ defaultPath: defaultName });
  if (canceled || !filePath) return false;
  fs.writeFileSync(filePath, content, 'utf8');
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
