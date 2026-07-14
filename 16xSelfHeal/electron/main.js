/**
 * 16x SelfHeal — Electron main process.
 * Responsibilities: window lifecycle, settings persistence (API key encrypted
 * with safeStorage when available), and proxying OpenRouter API calls so the
 * renderer never needs direct network/CORS access.
 */
const { app, BrowserWindow, ipcMain, shell, safeStorage, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');

let win = null;

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    if (raw.apiKeyEnc && safeStorage.isEncryptionAvailable()) {
      try {
        raw.apiKey = safeStorage.decryptString(Buffer.from(raw.apiKeyEnc, 'base64'));
      } catch { raw.apiKey = ''; }
    }
    delete raw.apiKeyEnc;
    return raw;
  } catch {
    return { apiKey: '', model: 'openrouter/auto' };
  }
}

function saveSettings(s) {
  const out = { ...s };
  if (out.apiKey && safeStorage.isEncryptionAvailable()) {
    out.apiKeyEnc = safeStorage.encryptString(out.apiKey).toString('base64');
    delete out.apiKey;
  }
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(out, null, 2));
}

/** Minimal HTTPS JSON POST/GET helper (no extra deps). */
function httpsJson(method, url, headers, body, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      { method, hostname: u.hostname, path: u.pathname + u.search, headers },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (res.statusCode >= 400) {
              reject(new Error(json.error?.message || `HTTP ${res.statusCode}`));
            } else resolve(json);
          } catch {
            reject(new Error(`Bad response (HTTP ${res.statusCode})`));
          }
        });
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function registerIpc() {
  ipcMain.handle('settings:get', () => loadSettings());
  ipcMain.handle('settings:set', (_e, s) => { saveSettings(s); return true; });

  // OpenRouter chat completion (non-streaming; renderer shows progress state).
  ipcMain.handle('ai:chat', async (_e, { messages, model, temperature, maxTokens }) => {
    const s = loadSettings();
    if (!s.apiKey) throw new Error('NO_KEY');
    return httpsJson(
      'POST',
      'https://openrouter.ai/api/v1/chat/completions',
      {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${s.apiKey}`,
        'HTTP-Referer': 'https://16xbrains.com/tools/selfheal',
        'X-Title': '16x SelfHeal Visualizer',
      },
      {
        model: model || s.model || 'openrouter/auto',
        messages,
        temperature: temperature ?? 0.4,
        max_tokens: maxTokens ?? 2000,
      }
    );
  });

  ipcMain.handle('ai:models', async () => {
    const s = loadSettings();
    return httpsJson('GET', 'https://openrouter.ai/api/v1/models', {
      Authorization: s.apiKey ? `Bearer ${s.apiKey}` : undefined,
    });
  });

  ipcMain.handle('shell:open', (_e, url) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
  });
}

function createWindow() {
  nativeTheme.themeSource = 'dark';
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0a0e17',
    title: '16x SelfHeal — Self-Healing System Visualizer',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  win.on('closed', () => (win = null));
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
