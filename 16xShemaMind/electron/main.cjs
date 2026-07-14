const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const isDev = !!process.env.VITE_DEV_SERVER_URL;
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#0d1117',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (isDev) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ---------- IPC: file dialogs & disk I/O ----------
ipcMain.handle('dialog:openFile', async (_e, filters) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: filters || [{ name: 'All Files', extensions: ['*'] }]
  });
  if (canceled || !filePaths.length) return null;
  const filePath = filePaths[0];
  // Excel and binary files are read as base64; everything else as utf8
  const binary = /\.(xlsx|xls)$/i.test(filePath);
  const content = fs.readFileSync(filePath, binary ? 'base64' : 'utf8');
  return { path: filePath, name: path.basename(filePath), content, encoding: binary ? 'base64' : 'utf8' };
});

ipcMain.handle('dialog:saveFile', async (_e, { defaultName, content, encoding, filters }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName,
    filters: filters || [{ name: 'All Files', extensions: ['*'] }]
  });
  if (canceled || !filePath) return null;
  if (encoding === 'base64') {
    fs.writeFileSync(filePath, Buffer.from(content, 'base64'));
  } else {
    fs.writeFileSync(filePath, content, 'utf8');
  }
  return { path: filePath };
});

ipcMain.handle('fs:writePath', async (_e, { filePath, content, encoding }) => {
  fs.writeFileSync(filePath, encoding === 'base64' ? Buffer.from(content, 'base64') : content, encoding === 'base64' ? undefined : 'utf8');
  return true;
});

ipcMain.handle('app:version', () => app.getVersion());

// ---------- Menu ----------
function buildMenu() {
  const send = (ch) => () => mainWindow && mainWindow.webContents.send(ch);
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Project', accelerator: 'CmdOrCtrl+N', click: send('menu:new') },
        { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: send('menu:open') },
        { label: 'Save Project', accelerator: 'CmdOrCtrl+S', click: send('menu:save') },
        { type: 'separator' },
        { label: 'Import…', accelerator: 'CmdOrCtrl+I', click: send('menu:import') },
        { label: 'Export…', accelerator: 'CmdOrCtrl+E', click: send('menu:export') },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: send('menu:undo') },
        { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', click: send('menu:redo') },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }
      ]
    },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'SchemaMind Docs', click: send('menu:docs') },
        { label: '16xbrains.com', click: () => shell.openExternal('https://16xbrains.com') }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  createWindow();
  buildMenu();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
