const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { autoUpdater } = require('electron-updater');

// ─── Mode BAC À SABLE (dev seulement) ───────────────────────
// TRIANGLE_TEST_USERDATA=<dossier> isole complètement l'instance : localStorage,
// réglages et verrou single-instance séparés — permet de tester avec des données
// importées (ex. JSON d'un client) sans toucher la vraie base ni la sync.
if (process.env.TRIANGLE_TEST_USERDATA) {
  try { app.setPath('userData', process.env.TRIANGLE_TEST_USERDATA); } catch (e) {}
}

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
    show: false,                 // ne pas afficher avant que la page soit prête (évite le flash)
    backgroundColor: '#0F172A',  // fond slate sombre pendant le chargement (pas de flash blanc)
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(getHtmlPath());
  mainWindow.setMenuBarVisibility(false);
  // Bac à sable : titre distinctif pour ne JAMAIS confondre avec la vraie app
  if (process.env.TRIANGLE_TEST_USERDATA) {
    mainWindow.on('page-title-updated', function (e) { e.preventDefault(); });
    mainWindow.setTitle('🧪 BAC À SABLE — TRI-ANGLE (données de test isolées)');
  }
  // Afficher seulement quand le rendu est prêt → plus de prévisualisation/flash transitoire
  mainWindow.once('ready-to-show', function () {
    mainWindow.show();
  });
}

// ─── IPC : Auto-save ────────────────────────────────────────
const CRM_TABS = ['cp','vp','a','pa','v','ac','vc','ra','rv','ca'];

// ─── Backup de sécurité SILENCIEUX (filet anti-perte de données) ────────────
// Stocké en LOCAL (userData), HORS iCloud → ne pollue pas le quota cloud + protège
// contre les bugs d'écrasement. 3 protections (leçon du crash 2026-06-26) :
//   1. Backup CONDITIONNEL : on ne copie QUE si le fichier source est SAIN et non-vide
//      (JSON parseable + au moins un tableau d'onglet) → un état pourri ne peut jamais
//      écraser un bon backup.
//   2. Backup QUOTIDIEN protégé : 1 backup par jour gardé ~14 jours. Réouvrir l'app 10×
//      dans la journée ne crée pas 10 backups qui poussent les bons hors rotation, et
//      le "bon état du début de journée" survit aux réouvertures.
//   3. (côté save-json) refus de sauvegarde si CHUTE BRUTALE de taille (perte massive).
const BACKUP_DIR = path.join(app.getPath('userData'), 'Backups');
const BACKUP_KEEP_DAYS = 14;

// Vérifie qu'un contenu JSON est une sauvegarde SAINE (parseable + structure attendue)
function _isHealthyBackupContent(txt) {
  try {
    if (!txt || txt.length < 20) return false;
    const parsed = JSON.parse(txt);
    return CRM_TABS.some(function(k){ return Array.isArray(parsed[k]); });
  } catch (e) { return false; }
}

let _backupDoneThisSession = false;
function _backupBeforeOverwrite() {
  try {
    if (_backupDoneThisSession) return;
    _backupDoneThisSession = true;
    if (!fs.existsSync(AUTOSAVE_PATH)) return;            // 1er lancement, rien à sauver
    const txt = fs.readFileSync(AUTOSAVE_PATH, 'utf8');
    // Protection 1 : ne JAMAIS backupper un état non-sain (vide/corrompu/partiel)
    if (!_isHealthyBackupContent(txt)) return;
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const d = new Date();
    const p2 = (n) => (n < 10 ? '0' : '') + n;
    const dayStamp = d.getFullYear() + '-' + p2(d.getMonth()+1) + '-' + p2(d.getDate());
    // Protection 2 : 1 backup par JOUR (le premier du jour). Si déjà fait aujourd'hui, on garde celui-là.
    const dest = path.join(BACKUP_DIR, 'CRM-Pro-autosauve-' + dayStamp + '.json');
    if (!fs.existsSync(dest)) fs.copyFileSync(AUTOSAVE_PATH, dest);
    // Rotation : supprimer les backups de plus de BACKUP_KEEP_DAYS jours
    const cutoff = Date.now() - BACKUP_KEEP_DAYS * 86400000;
    fs.readdirSync(BACKUP_DIR)
      .filter(f => /^CRM-Pro-(autosauve|avant-import)-.*\.json$/.test(f))
      .forEach(f => {
        try { if (fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs < cutoff) fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch (x) {}
      });
  } catch (e) { /* best effort : un échec de backup ne doit jamais bloquer la sauvegarde */ }
}

// IPC : restauration (pour récupération assistée). Liste les backups dispo.
ipcMain.handle('backup-list', async () => {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return { ok: true, dir: BACKUP_DIR, files: [] };
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => /^CRM-Pro-autosauve-.*\.json$/.test(f))
      .map(f => { const st = fs.statSync(path.join(BACKUP_DIR, f)); return { name: f, size: st.size, mtime: st.mtimeMs }; })
      .sort((a, b) => b.mtime - a.mtime);
    return { ok: true, dir: BACKUP_DIR, files: files };
  } catch (e) { return { ok: false, error: e.message }; }
});

// IPC : snapshot horodaté AVANT un import. Distinct du backup quotidien (CRM-Pro-autosauve-*)
// qui est bridé à 1×/session → insuffisant comme filet juste avant un écrasement volontaire.
// Best-effort : ne copie QUE si le contenu source est sain ; couvert par la rotation 14 j.
ipcMain.handle('backup-now', async () => {
  try {
    if (!fs.existsSync(AUTOSAVE_PATH)) return { ok: false, error: 'aucune sauvegarde source à copier' };
    const txt = fs.readFileSync(AUTOSAVE_PATH, 'utf8');
    if (!_isHealthyBackupContent(txt)) return { ok: false, error: 'contenu source non sain — copie annulée' };
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const d = new Date();
    const p2 = (n) => (n < 10 ? '0' : '') + n;
    const stamp = d.getFullYear() + '-' + p2(d.getMonth()+1) + '-' + p2(d.getDate()) + '-' + p2(d.getHours()) + p2(d.getMinutes());
    const name = 'CRM-Pro-avant-import-' + stamp + '.json';
    fs.copyFileSync(AUTOSAVE_PATH, path.join(BACKUP_DIR, name));
    return { ok: true, file: name };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('save-json', async (event, jsonString) => {
  try {
    if (!fs.existsSync(AUTOSAVE_DIR)) fs.mkdirSync(AUTOSAVE_DIR, { recursive: true });

    _backupBeforeOverwrite(); // filet : copie l'état sain du jour (1×/jour) avant écrasement

    // ── Protection 3 : refus si CHUTE BRUTALE de taille (perte massive de données) ──
    // Si le fichier actuel est sain et que le nouveau contenu est < 50% de sa taille,
    // on REFUSE d'écraser (probable corruption/réinitialisation accidentelle).
    try {
      if (fs.existsSync(AUTOSAVE_PATH)) {
        const oldTxt = fs.readFileSync(AUTOSAVE_PATH, 'utf8');
        if (_isHealthyBackupContent(oldTxt)) {
          const oldLen = Buffer.byteLength(oldTxt, 'utf8');
          const newLen = Buffer.byteLength(jsonString, 'utf8');
          if (oldLen > 2000 && newLen < oldLen * 0.5) {
            return { ok: false, error: 'Sauvegarde refusée : chute anormale de taille (' + oldLen + '→' + newLen + ' octets). Données préservées. Redémarrez l\'app ; si le problème persiste, contactez le support.' };
          }
        }
      }
    } catch (gErr) { /* si le garde-fou échoue, on continue (ne pas bloquer une vraie sauvegarde) */ }

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

// ─── IPC : Sync 2 postes (Étape 32) ─────────────────────────
// Journaux append-only par appareil dans <dossier de sauvegarde>/TRI-ANGLE-sync/.
// Chaque poste n'écrit QUE son propre fichier (journal-<deviceId>.jsonl) → aucun
// conflit de fichier ; OneDrive/Dropbox propage les journaux entre les postes.
function _syncDir() { return path.join(AUTOSAVE_DIR, 'TRI-ANGLE-sync'); }
const SYNC_FILE_RE = /^journal-[A-Za-z0-9_-]{1,40}\.jsonl$/;
ipcMain.handle('sync-append', async (event, payload) => {
  try {
    const fileName = (payload && payload.fileName) || '';
    const text = (payload && payload.text) || '';
    if (!SYNC_FILE_RE.test(fileName)) return { ok: false, error: 'nom de fichier invalide' };
    const dir = _syncDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, fileName), text, 'utf8');
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('sync-list', async () => {
  try {
    const dir = _syncDir();
    if (!fs.existsSync(dir)) return { ok: true, files: [] };
    const files = fs.readdirSync(dir).filter(f => SYNC_FILE_RE.test(f)).map(f => {
      try {
        const p = path.join(dir, f);
        const st = fs.statSync(p);
        // head = début de la 1re ligne : stable sur un journal append-only, change à la
        // compaction (réécriture) → permet aux lecteurs de détecter et relire depuis 0
        let head = '';
        try {
          const fd = fs.openSync(p, 'r');
          try {
            const buf = Buffer.alloc(Math.min(96, st.size));
            fs.readSync(fd, buf, 0, buf.length, 0);
            head = buf.toString('utf8').split('\n')[0];
          } finally { fs.closeSync(fd); }
        } catch (e) {}
        return { name: f, size: st.size, head: head };
      }
      catch (e) { return { name: f, size: 0, head: '' }; }
    });
    return { ok: true, files: files };
  } catch (e) { return { ok: false, error: e.message }; }
});
// Compaction (2026-07) : réécrit ATOMIQUEMENT le journal du poste (tmp + rename).
// N'accepte que les noms journal-*.jsonl — chaque poste ne réécrit que le sien.
ipcMain.handle('sync-rewrite', async (event, payload) => {
  try {
    const fileName = (payload && payload.fileName) || '';
    const text = (payload && payload.text) || '';
    if (!SYNC_FILE_RE.test(fileName)) return { ok: false, error: 'nom de fichier invalide' };
    const dir = _syncDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const finalPath = path.join(dir, fileName);
    const tmpPath = finalPath + '.tmp';
    fs.writeFileSync(tmpPath, text, 'utf8');
    fs.renameSync(tmpPath, finalPath);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('sync-read', async (event, payload) => {
  try {
    const fileName = (payload && payload.fileName) || '';
    const fromByte = Math.max(0, parseInt((payload && payload.fromByte) || 0, 10) || 0);
    if (!SYNC_FILE_RE.test(fileName)) return { ok: false, error: 'nom de fichier invalide' };
    const p = path.join(_syncDir(), fileName);
    if (!fs.existsSync(p)) return { ok: true, data: '', size: 0 };
    const st = fs.statSync(p);
    if (fromByte >= st.size) return { ok: true, data: '', size: st.size };
    const len = st.size - fromByte;
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(p, 'r');
    try { fs.readSync(fd, buf, 0, len, fromByte); } finally { fs.closeSync(fd); }
    return { ok: true, data: buf.toString('utf8'), size: st.size };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ─── IPC : Collaboration entre courtiers (Étape 33) ─────────
// Mêmes journaux, mais dans un dossier-CANAL choisi par l'utilisateur (partagé entre
// les courtiers d'une équipe via OneDrive/Dropbox), distinct du dossier de sauvegarde.
function _collabOk(dir, fileName) {
  return dir && typeof dir === 'string' && path.isAbsolute(dir) && SYNC_FILE_RE.test(fileName || 'journal-x.jsonl');
}
ipcMain.handle('collab-pick-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choisir le dossier de collaboration (partagé avec le/la collègue)',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Choisir ce dossier'
  });
  if (result.canceled || !result.filePaths.length) return { ok: false };
  return { ok: true, path: result.filePaths[0] };
});
ipcMain.handle('collab-append', async (event, payload) => {
  try {
    const dir = (payload && payload.dir) || '';
    const fileName = (payload && payload.fileName) || '';
    const text = (payload && payload.text) || '';
    if (!_collabOk(dir, fileName) || !SYNC_FILE_RE.test(fileName)) return { ok: false, error: 'paramètres invalides' };
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, fileName), text, 'utf8');
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('collab-list', async (event, payload) => {
  try {
    const dir = (payload && payload.dir) || '';
    if (!dir || !path.isAbsolute(dir)) return { ok: false, error: 'dossier invalide' };
    if (!fs.existsSync(dir)) return { ok: true, files: [] };
    const files = fs.readdirSync(dir).filter(f => SYNC_FILE_RE.test(f)).map(f => {
      try { const st = fs.statSync(path.join(dir, f)); return { name: f, size: st.size }; }
      catch (e) { return { name: f, size: 0 }; }
    });
    return { ok: true, files: files };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('collab-read', async (event, payload) => {
  try {
    const dir = (payload && payload.dir) || '';
    const fileName = (payload && payload.fileName) || '';
    const fromByte = Math.max(0, parseInt((payload && payload.fromByte) || 0, 10) || 0);
    if (!_collabOk(dir, fileName) || !SYNC_FILE_RE.test(fileName)) return { ok: false, error: 'paramètres invalides' };
    const p = path.join(dir, fileName);
    if (!fs.existsSync(p)) return { ok: true, data: '', size: 0 };
    const st = fs.statSync(p);
    if (fromByte >= st.size) return { ok: true, data: '', size: st.size };
    const len = st.size - fromByte;
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(p, 'r');
    try { fs.readSync(fd, buf, 0, len, fromByte); } finally { fs.closeSync(fd); }
    return { ok: true, data: buf.toString('utf8'), size: st.size };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ─── IPC : Pièces jointes (Étape 25) ────────────────────────
// Les fichiers vivent dans <dossier de sauvegarde>/PiecesJointes/<propertyId>/
// → synchronisés par Dropbox/OneDrive en même temps que la sauvegarde JSON.
function _attachBaseDir() { return path.join(AUTOSAVE_DIR, 'PiecesJointes'); }
function _attachPropDir(propertyId) {
  var safeId = String(propertyId || '').replace(/[^a-zA-Z0-9_-]/g, '_') || 'sans-id';
  return path.join(_attachBaseDir(), safeId);
}
function _safeFileName(n) { return String(n || '').replace(/[\\/:*?"<>|]/g, '_'); }

// Migration auto du dossier PiecesJointes quand l'utilisateur change de dossier de sauvegarde.
// Déplace <ancien>/PiecesJointes → <nouveau>/PiecesJointes (gère le cross-disque via copie + suppression).
function _migrateAttachments(oldDir, newDir) {
  try {
    if (!oldDir || !newDir || oldDir === newDir) return;
    var src = path.join(oldDir, 'PiecesJointes');
    var dst = path.join(newDir, 'PiecesJointes');
    if (!fs.existsSync(src)) return;            // rien à migrer
    if (path.resolve(src) === path.resolve(dst)) return;
    if (!fs.existsSync(dst)) {
      // Cible absente : tenter un déplacement direct (rapide), sinon copie + suppression (cross-disque)
      try {
        fs.renameSync(src, dst);
        return;
      } catch (e) {
        fs.cpSync(src, dst, { recursive: true });
        fs.rmSync(src, { recursive: true, force: true });
        return;
      }
    }
    // Cible déjà présente : fusionner sous-dossier par sous-dossier (ne pas écraser un dossier existant)
    var entries = fs.readdirSync(src);
    entries.forEach(function (name) {
      var s = path.join(src, name);
      var d = path.join(dst, name);
      if (fs.existsSync(d)) return;             // garde la version déjà au nouvel emplacement
      try { fs.renameSync(s, d); }
      catch (e) { fs.cpSync(s, d, { recursive: true }); fs.rmSync(s, { recursive: true, force: true }); }
    });
    // Retirer l'ancien dossier s'il est devenu vide
    try { if (fs.readdirSync(src).length === 0) fs.rmdirSync(src); } catch (e) {}
  } catch (e) { /* migration best-effort : ne jamais bloquer le changement de dossier */ }
}

ipcMain.handle('attachment-save', async (event, args) => {
  try {
    var dir = _attachPropDir(args.propertyId);
    fs.mkdirSync(dir, { recursive: true });
    var safe = _safeFileName(args.fileName);
    var full = path.join(dir, safe);
    var buf = Buffer.from(args.base64 || '', 'base64');
    fs.writeFileSync(full, buf);
    return { ok: true, file: safe, size: buf.length };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('attachment-open', async (event, args) => {
  try {
    var full = path.join(_attachPropDir(args.propertyId), _safeFileName(args.fileName));
    if (!fs.existsSync(full)) return { ok: false, error: 'Fichier introuvable' };
    var r = await shell.openPath(full);
    return r ? { ok: false, error: r } : { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('attachment-delete', async (event, args) => {
  try {
    var full = path.join(_attachPropDir(args.propertyId), _safeFileName(args.fileName));
    if (fs.existsSync(full)) fs.unlinkSync(full);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('attachment-delete-property', async (event, args) => {
  try {
    var dir = _attachPropDir(args.propertyId);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('attachment-open-folder', async (event, args) => {
  try {
    var dir = _attachPropDir(args.propertyId);
    fs.mkdirSync(dir, { recursive: true });
    var r = await shell.openPath(dir);
    return r ? { ok: false, error: r } : { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ─── IPC : Courriel avec PJ (.eml auto-joint, Étape 25) ─────
// Génère un brouillon .eml (RFC822) avec X-Unsent:1 → s'ouvre dans l'app de
// courriel par défaut (Outlook desktop / Apple Mail) prêt à envoyer, PJ jointes.
function _encWord(s) { return '=?UTF-8?B?' + Buffer.from(String(s || ''), 'utf8').toString('base64') + '?='; }
function _wrap76(b64) { return String(b64).replace(/(.{76})/g, '$1\r\n'); }
function _attHdrName(name) {
  name = String(name || 'fichier');
  if (/^[\x20-\x7E]+$/.test(name) && name.indexOf('"') < 0 && name.indexOf('\\') < 0) return '"' + name + '"';
  return _encWord(name);
}
function _mimeForName(name) {
  var ext = (String(name).split('.').pop() || '').toLowerCase();
  var map = { pdf:'application/pdf', png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif', webp:'image/webp',
    doc:'application/msword', docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls:'application/vnd.ms-excel', xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    txt:'text/plain', csv:'text/csv', zip:'application/zip' };
  return map[ext] || 'application/octet-stream';
}
ipcMain.handle('email-create-eml', async (event, args) => {
  try {
    var CRLF = '\r\n';
    var boundary = '=_TRIANGLE_' + Date.now().toString(36);
    var lines = [];
    lines.push('X-Unsent: 1');
    if (args.to) lines.push('To: ' + args.to);
    if (args.bcc) lines.push('Bcc: ' + args.bcc);
    lines.push('Subject: ' + _encWord(args.subject));
    lines.push('MIME-Version: 1.0');
    lines.push('Content-Type: multipart/mixed; boundary="' + boundary + '"');
    lines.push('');
    lines.push('--' + boundary);
    lines.push('Content-Type: text/plain; charset="UTF-8"');
    lines.push('Content-Transfer-Encoding: base64');
    lines.push('');
    lines.push(_wrap76(Buffer.from(String(args.body || ''), 'utf8').toString('base64')));
    var attached = 0;
    (args.attachments || []).forEach(function (a) {
      var bucket = a.bucket || args.propertyId;
      var full = path.join(_attachPropDir(bucket), _safeFileName(a.file));
      if (!fs.existsSync(full)) return;
      var data = fs.readFileSync(full).toString('base64');
      var nm = _attHdrName(a.name || a.file);
      lines.push('--' + boundary);
      lines.push('Content-Type: ' + _mimeForName(a.name || a.file) + '; name=' + nm);
      lines.push('Content-Transfer-Encoding: base64');
      lines.push('Content-Disposition: attachment; filename=' + nm);
      lines.push('');
      lines.push(_wrap76(data));
      attached++;
    });
    lines.push('--' + boundary + '--');
    lines.push('');
    // ─── Mac : piloter Outlook / Apple Mail par AppleScript pour un VRAI brouillon éditable ───
    // Le .eml ouvre en lecture (Répondre/Transférer) dans le nouveau Outlook Mac → on crée plutôt
    // un brouillon natif avec destinataire + sujet + corps + PJ. Repli sur .eml si l'AppleScript échoue.
    if (process.platform === 'darwin' && (args.app === 'outlook' || args.app === 'applemail')) {
      // Résoudre les chemins absolus des PJ (existantes). Le nom de fichier sur disque contient
      // parfois un préfixe technique anti-collision (ex. "autres__m9k3x-Fiche.pdf"). On copie donc
      // chaque PJ dans un dossier temp SOUS SON VRAI NOM (a.name) pour qu'Outlook l'affiche correctement.
      var attTmpDir = path.join(app.getPath('temp'), 'TRI-ANGLE-pj-' + Date.now().toString(36));
      var attPaths = [];
      var usedNames = {};
      (args.attachments || []).forEach(function (a) {
        var bucket = a.bucket || args.propertyId;
        var full = path.join(_attachPropDir(bucket), _safeFileName(a.file));
        if (!fs.existsSync(full)) return;
        var realName = _safeFileName(a.name || a.file);
        // éviter une collision de noms dans le dossier temp (2 PJ avec le même vrai nom)
        if (usedNames[realName]) {
          var dot = realName.lastIndexOf('.');
          var base = dot > 0 ? realName.slice(0, dot) : realName;
          var ext = dot > 0 ? realName.slice(dot) : '';
          realName = base + ' (' + usedNames[realName] + ')' + ext;
        }
        usedNames[_safeFileName(a.name || a.file)] = (usedNames[_safeFileName(a.name || a.file)] || 0) + 1;
        try {
          if (!fs.existsSync(attTmpDir)) fs.mkdirSync(attTmpDir, { recursive: true });
          var dest = path.join(attTmpDir, realName);
          fs.copyFileSync(full, dest);
          attPaths.push(dest);
        } catch (e) {
          attPaths.push(full); // repli : au pire le préfixe reste, mais la PJ est jointe
        }
      });
      var recipients = String(args.to || args.bcc || '').split(/[;,]/).map(function (s) { return s.trim(); }).filter(Boolean);
      var isBcc = !args.to && !!args.bcc;
      var script = (args.app === 'outlook')
        ? _buildOutlookScript(args.subject || '', args.body || '', recipients, isBcc, attPaths)
        : _buildAppleMailScript(args.subject || '', args.body || '', recipients, isBcc, attPaths);
      var ok = await new Promise(function (resolve) {
        require('child_process').execFile('osascript', ['-e', script], function (err) { resolve(!err); });
      });
      if (ok) return { ok: true, attached: attPaths.length, via: 'applescript' };
      // AppleScript a échoué → repli sur le .eml ouvert dans l'app ciblée
      var emlPathF = path.join(app.getPath('temp'), 'TRI-ANGLE-' + Date.now().toString(36) + '.eml');
      fs.writeFileSync(emlPathF, lines.join(CRLF), 'utf8');
      var appNameF = args.app === 'outlook' ? 'Microsoft Outlook' : 'Mail';
      var openedF = await new Promise(function (resolve) {
        require('child_process').execFile('open', ['-a', appNameF, emlPathF], function (err) { resolve(!err); });
      });
      if (openedF) return { ok: true, attached: attached, via: 'eml-fallback' };
    }
    var emlPath = path.join(app.getPath('temp'), 'TRI-ANGLE-' + Date.now().toString(36) + '.eml');
    fs.writeFileSync(emlPath, lines.join(CRLF), 'utf8');
    var r = await shell.openPath(emlPath);
    return r ? { ok: false, error: r } : { ok: true, attached: attached };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Échappe une chaîne pour un littéral AppleScript "sur une ligne" (sujet, courriel, chemin).
// AppleScript n'interprète PAS les séquences \n — on remplace donc tout saut de ligne par une espace.
function _asEsc(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, ' ');
}
// Construit une EXPRESSION AppleScript pour un texte multi-ligne (corps du courriel).
// AppleScript n'a pas de \n dans les littéraux : on découpe par ligne et on concatène
// avec le mot-clé `linefeed` → "ligne1" & linefeed & "ligne2" & linefeed & ...
// (utilisé pour Apple Mail, dont le corps est en texte brut)
function _asLit(s) {
  s = String(s == null ? '' : s).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (s === '') return '""';
  return s.split('\n').map(function (line) {
    return '"' + line.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }).join(' & linefeed & ');
}
// Outlook Mac compose en HTML → les sauts de ligne texte sont écrasés. On envoie donc
// le corps en HTML avec des <br> (et <br><br> pour les lignes vides). Retourne un
// littéral AppleScript mono-ligne (plus aucun vrai saut de ligne dedans).
function _asHtmlLit(s) {
  s = String(s == null ? '' : s).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  var html = s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
  return '"' + html.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}
// Construit le script AppleScript pour créer un brouillon Microsoft Outlook
function _buildOutlookScript(subject, body, recipients, isBcc, attPaths) {
  var L = [];
  L.push('tell application "Microsoft Outlook"');
  L.push('set newMsg to make new outgoing message with properties {subject:"' + _asEsc(subject) + '", content:' + _asHtmlLit(body) + '}');
  recipients.forEach(function (r) {
    var kind = isBcc ? 'bcc recipient' : 'to recipient';
    L.push('make new ' + kind + ' at newMsg with properties {email address:{address:"' + _asEsc(r) + '"}}');
  });
  attPaths.forEach(function (p) {
    L.push('make new attachment at newMsg with properties {file:POSIX file "' + _asEsc(p) + '"}');
  });
  L.push('open newMsg');
  L.push('activate');
  L.push('end tell');
  return L.join('\n');
}
// Construit le script AppleScript pour créer un brouillon Apple Mail
function _buildAppleMailScript(subject, body, recipients, isBcc, attPaths) {
  var L = [];
  L.push('tell application "Mail"');
  L.push('set newMsg to make new outgoing message with properties {subject:"' + _asEsc(subject) + '", content:' + _asLit(body) + ', visible:true}');
  L.push('tell newMsg');
  recipients.forEach(function (r) {
    var kind = isBcc ? 'bcc recipient' : 'to recipient';
    L.push('make new ' + kind + ' at end of ' + (isBcc ? 'bcc recipients' : 'to recipients') + ' with properties {address:"' + _asEsc(r) + '"}');
  });
  attPaths.forEach(function (p) {
    L.push('make new attachment with properties {file name:POSIX file "' + _asEsc(p) + '"} at after the last paragraph');
  });
  L.push('end tell');
  L.push('activate');
  L.push('end tell');
  return L.join('\n');
}

ipcMain.handle('pick-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choisir le dossier de sauvegarde',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Choisir ce dossier'
  });
  if (result.canceled || !result.filePaths.length) return { ok: false };
  const dir = result.filePaths[0];
  _migrateAttachments(AUTOSAVE_DIR, dir);
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
    _migrateAttachments(AUTOSAVE_DIR, folderPath);
    AUTOSAVE_DIR = folderPath;
    AUTOSAVE_PATH = path.join(folderPath, 'CRM-Pro-autosauve.json');
    try { fs.writeFileSync(SETTINGS_PATH, JSON.stringify({ saveDir: folderPath }), 'utf8'); } catch (e) {}
    return { ok: true, dir: folderPath, name: path.basename(folderPath) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('get-autosave-folder', async () => {
  return { ok: true, dir: AUTOSAVE_DIR, name: path.basename(AUTOSAVE_DIR) };
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
// Mac réactivé depuis v0.3.45 : les builds sont signés + notarisés (v0.3.44+), donc
// quitAndInstall est sûr — Squirrel.Mac refuse d'installer une mise à jour non signée
// (échec de validation, l'app reste sur la version courante) au lieu de la casser.
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
autoUpdater.on('update-downloaded', (info) => {
  sendUpdateStatus('downloaded', { version: info.version });
  // Mise à jour OBLIGATOIRE (Windows + Mac depuis v0.3.45), anti-perte v2 (13 juillet) :
  // le RENDERER pilote le redémarrage — si un formulaire est ouvert, il affiche un bandeau
  // et attend sa fermeture avant le compte à rebours (sauvegarde finale incluse).
  // Filet de sécurité : si le renderer n'a pas redémarré après 10 min (page morte, etc.),
  // on force ici : sauvegarde finale + quit.
  const delaySec = 15;
  sendUpdateStatus('force-install', { version: info.version, seconds: delaySec });
  setTimeout(() => {
    sendUpdateStatus('final-save');
    setTimeout(() => {
      try { autoUpdater.quitAndInstall(true, true); }
      catch (e) { console.warn('[update] quitAndInstall failed:', e && e.message); }
    }, 2000);
  }, 10 * 60 * 1000);
});
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
  if (app.isReady() && BrowserWindow.getAllWindows().length === 0) createWindow();
});
