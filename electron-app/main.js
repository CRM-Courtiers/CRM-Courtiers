const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { autoUpdater } = require('electron-updater');

// Machine fingerprint — utilisé pour empêcher l'abus de l'essai gratuit
let _machineId = null;
function getMachineFingerprint() {
  if (_machineId) return _machineId;
  try {
    const { machineIdSync } = require('node-machine-id');
    _machineId = machineIdSync();
  } catch (e) {
    // Fallback : hash de hostname + username (moins unique mais cross-platform)
    const fb = os.hostname() + '|' + os.userInfo().username + '|' + os.platform();
    _machineId = 'fb-' + crypto.createHash('sha256').update(fb).digest('hex').substring(0, 32);
  }
  return _machineId;
}

// ─── Chemins ────────────────────────────────────────────────
const DEFAULT_DIR = path.join(os.homedir(), 'Documents', 'TRI-ANGLE Backup');
let AUTOSAVE_DIR = DEFAULT_DIR;
let AUTOSAVE_PATH = path.join(AUTOSAVE_DIR, 'CRM-Pro-autosauve.json');
const SETTINGS_PATH = path.join(app.getPath('userData'), 'crm-pro-settings.json');

// Chemin du HTML : dev = ../crm-pro.html, prod = resources/crm-pro.html
function getHtmlPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'crm-pro.html');
  }
  return path.join(__dirname, '..', 'crm-pro.html');
}

// Charger le dossier personnalise si existant
try {
  if (fs.existsSync(SETTINGS_PATH)) {
    const s = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    if (s.saveDir && fs.existsSync(s.saveDir)) {
      AUTOSAVE_DIR = s.saveDir;
      AUTOSAVE_PATH = path.join(AUTOSAVE_DIR, 'CRM-Pro-autosauve.json');
    }
  }
} catch (e) {}

app.setAppUserModelId('com.crmpro.courtage');

// ─── Single instance lock ───────────────────────────────────
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

let mainWindow;

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 900,
    title: 'TRI-ANGLE — Courtage immobilier',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(getHtmlPath());
  mainWindow.setMenuBarVisibility(false);
}

// ─── IPC : Auto-save ────────────────────────────────────────
const CRM_TABS = ['cp','vp','a','pa','v','ac','vc','ra','rv','ca'];
ipcMain.handle('save-json', async (event, jsonString) => {
  try {
    if (!fs.existsSync(AUTOSAVE_DIR)) fs.mkdirSync(AUTOSAVE_DIR, { recursive: true });

    const tmpPath = AUTOSAVE_PATH + '.tmp';

    fs.writeFileSync(tmpPath, jsonString, 'utf8');

    const written = fs.statSync(tmpPath).size;
    const expected = Buffer.byteLength(jsonString, 'utf8');
    if (written !== expected) {
      try { fs.unlinkSync(tmpPath); } catch(x) {}
      return { ok: false, error: 'Taille incorrecte: ' + written + ' vs ' + expected };
    }

    const readBack = fs.readFileSync(tmpPath, 'utf8');
    try {
      const parsed = JSON.parse(readBack);
      const hasStructure = CRM_TABS.some(function(k){ return Array.isArray(parsed[k]); });
      if (!hasStructure) {
        try { fs.unlinkSync(tmpPath); } catch(x) {}
        return { ok: false, error: 'JSON valide mais structure incomplète' };
      }
    } catch (parseErr) {
      try { fs.unlinkSync(tmpPath); } catch(x) {}
      return { ok: false, error: 'JSON corrompu détecté, fichier original préservé' };
    }

    if (fs.existsSync(AUTOSAVE_PATH)) fs.unlinkSync(AUTOSAVE_PATH);
    fs.renameSync(tmpPath, AUTOSAVE_PATH);
    return { ok: true, time: new Date().toLocaleTimeString('fr-CA', { hour: '2-digit', minute: '2-digit' }) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('load-json', async () => {
  try {
    if (!fs.existsSync(AUTOSAVE_PATH)) return { ok: false, error: 'not found' };
    const txt = fs.readFileSync(AUTOSAVE_PATH, 'utf8');
    return { ok: true, data: txt };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('get-autosave-path', async () => {
  return AUTOSAVE_PATH;
});

ipcMain.handle('pick-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choisir le dossier de sauvegarde',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Choisir ce dossier'
  });
  if (result.canceled || !result.filePaths.length) return { ok: false };
  const dir = result.filePaths[0];
  AUTOSAVE_DIR = dir;
  AUTOSAVE_PATH = path.join(dir, 'CRM-Pro-autosauve.json');
  try { fs.writeFileSync(SETTINGS_PATH, JSON.stringify({ saveDir: dir }), 'utf8'); } catch (e) {}
  return { ok: true, dir: dir, name: path.basename(dir) };
});

// ─── IPC : Détecter les dossiers cloud disponibles ───────
ipcMain.handle('detect-cloud-folders', async () => {
  const home = os.homedir();
  const candidates = [
    // Dropbox — variations courantes
    { type: 'dropbox', label: 'Dropbox', icon: '📦', path: path.join(home, 'Dropbox') },
    { type: 'dropbox', label: 'Dropbox', icon: '📦', path: path.join(home, 'Dropbox (Personal)') },
    { type: 'dropbox', label: 'Dropbox', icon: '📦', path: path.join(home, 'Dropbox (Compte personnel)') },
    { type: 'dropbox', label: 'Dropbox', icon: '📦', path: path.join(home, 'Dropbox (Business)') },
    // OneDrive
    { type: 'onedrive', label: 'OneDrive', icon: '☁️', path: path.join(home, 'OneDrive') },
    { type: 'onedrive', label: 'OneDrive personnel', icon: '☁️', path: path.join(home, 'OneDrive - Personal') },
    // Google Drive
    { type: 'gdrive', label: 'Google Drive', icon: '🟢', path: path.join(home, 'Google Drive') },
    { type: 'gdrive', label: 'Google Drive', icon: '🟢', path: path.join(home, 'GoogleDrive') },
    { type: 'gdrive', label: 'My Drive (Google Drive)', icon: '🟢', path: 'G:\\My Drive' },
    // iCloud Drive (Windows)
    { type: 'icloud', label: 'iCloud Drive', icon: '☁️', path: path.join(home, 'iCloudDrive') },
    { type: 'icloud', label: 'iCloud Drive', icon: '☁️', path: path.join(home, 'iCloud Drive') }
  ];
  const found = [];
  const seenTypes = new Set();
  for (const c of candidates) {
    try {
      if (fs.existsSync(c.path) && fs.statSync(c.path).isDirectory()) {
        if (seenTypes.has(c.type)) continue; // un seul par type
        seenTypes.add(c.type);
        found.push({
          type: c.type,
          label: c.label,
          icon: c.icon,
          basePath: c.path,
          suggestedPath: path.join(c.path, 'TRI-ANGLE Backup')
        });
      }
    } catch (e) {}
  }
  const localPath = path.join(home, 'Documents', 'TRI-ANGLE Backup');
  return { cloudFolders: found, localPath: localPath };
});

// ─── IPC : Configurer le dossier de sauvegarde directement ──
ipcMain.handle('set-autosave-folder', async (event, folderPath) => {
  try {
    if (!folderPath) return { ok: false, error: 'Chemin manquant' };
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
    }
    if (!fs.statSync(folderPath).isDirectory()) {
      return { ok: false, error: 'Le chemin n\'est pas un dossier' };
    }
    AUTOSAVE_DIR = folderPath;
    AUTOSAVE_PATH = path.join(folderPath, 'CRM-Pro-autosauve.json');
    try { fs.writeFileSync(SETTINGS_PATH, JSON.stringify({ saveDir: folderPath }), 'utf8'); } catch (e) {}
    return { ok: true, dir: folderPath, name: path.basename(folderPath) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ─── IPC : Machine fingerprint (anti-abus trial) ────────────
ipcMain.handle('get-machine-id', async () => {
  return getMachineFingerprint();
});

// Étape 22 — ouvrir URL externe (mailto:, https:, etc.)
ipcMain.handle('open-external', async (event, url) => {
  try { await shell.openExternal(url); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// ─── IPC : Outlook Calendar (Microsoft Graph, Étape 21) ──────
const outlook = require('./outlook-calendar');

ipcMain.handle('outlook-status', async () => {
  try { return await outlook.getStatus(); }
  catch (e) { return { connected: false, error: e.message }; }
});
ipcMain.handle('outlook-connect', async () => {
  try { return await outlook.connect(); }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('outlook-disconnect', async () => {
  try { return await outlook.disconnect(); }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('outlook-create-event', async (event, payload) => {
  try { return await outlook.createEvent(payload); }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('outlook-update-event', async (event, payload) => {
  try { return await outlook.updateEvent(payload); }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('outlook-delete-event', async (event, payload) => {
  try { return await outlook.deleteEvent(payload); }
  catch (e) { return { ok: false, error: e.message }; }
});

// ─── IPC : Google Calendar ───────────────────────────────────
const gcal = require('./google-calendar');

ipcMain.handle('gcal-status', async () => {
  try { return await gcal.getStatus(); }
  catch (e) { return { connected: false, error: e.message }; }
});

ipcMain.handle('gcal-connect', async () => {
  try { return await gcal.connect(); }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('gcal-disconnect', async () => {
  try { return await gcal.disconnect(); }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('gcal-create-event', async (event, payload) => {
  try { return await gcal.createEvent(payload); }
  catch (e) { return { ok: false, error: e.message, code: e.code || null }; }
});

ipcMain.handle('gcal-update-event', async (event, payload) => {
  try { return await gcal.updateEvent(payload); }
  catch (e) { return { ok: false, error: e.message, code: e.code || null }; }
});

ipcMain.handle('gcal-delete-event', async (event, payload) => {
  try { return await gcal.deleteEvent(payload); }
  catch (e) { return { ok: false, error: e.message, code: e.code || null }; }
});

// ─── IPC : Version & mises à jour ───────────────────────────
ipcMain.handle('get-app-version', async () => {
  return {
    version: app.getVersion(),
    isPackaged: app.isPackaged,
    platform: process.platform
  };
});

ipcMain.handle('check-for-updates', async () => {
  try {
    const result = await autoUpdater.checkForUpdates();
    return {
      ok: true,
      updateAvailable: !!(result && result.updateInfo && result.updateInfo.version !== app.getVersion()),
      currentVersion: app.getVersion(),
      latestVersion: result && result.updateInfo ? result.updateInfo.version : app.getVersion()
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('install-update', async () => {
  autoUpdater.quitAndInstall();
  return { ok: true };
});

// ─── Auto-update : configuration ────────────────────────────
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

// Logs : capturer les événements et les relayer à la fenêtre
function sendUpdateStatus(status, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-status', { status: status, data: data || null });
  }
  console.log('[update]', status, data || '');
}

autoUpdater.on('checking-for-update', () => sendUpdateStatus('checking'));
autoUpdater.on('update-available', (info) => sendUpdateStatus('available', { version: info.version }));
autoUpdater.on('update-not-available', (info) => sendUpdateStatus('not-available', { version: info.version }));
autoUpdater.on('download-progress', (progress) => sendUpdateStatus('progress', {
  percent: Math.round(progress.percent),
  transferred: progress.transferred,
  total: progress.total,
  bytesPerSecond: progress.bytesPerSecond
}));
autoUpdater.on('update-downloaded', (info) => sendUpdateStatus('downloaded', { version: info.version }));
autoUpdater.on('error', (err) => sendUpdateStatus('error', { message: err && err.message }));

// ─── App lifecycle ──────────────────────────────────────────
app.whenReady().then(() => {
  createWindow();
  // Vérifier les mises à jour 3 secondes après le démarrage (laisse le temps à l'app de se charger)
  if (app.isPackaged) {
    setTimeout(() => {
      autoUpdater.checkForUpdatesAndNotify().catch(err => {
        console.warn('[update] check failed:', err && err.message);
      });
    }, 3000);
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
