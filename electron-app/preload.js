const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Sauvegarde / chargement JSON
  saveJSON: (jsonString) => ipcRenderer.invoke('save-json', jsonString),
  loadJSON: () => ipcRenderer.invoke('load-json'),
  getAutosavePath: () => ipcRenderer.invoke('get-autosave-path'),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  detectCloudFolders: () => ipcRenderer.invoke('detect-cloud-folders'),
  setAutoSaveFolder: (folderPath) => ipcRenderer.invoke('set-autosave-folder', folderPath),
  // Machine fingerprint (anti-abus essai gratuit)
  getMachineId: () => ipcRenderer.invoke('get-machine-id'),
  // Google Calendar
  gcalStatus: () => ipcRenderer.invoke('gcal-status'),
  gcalConnect: () => ipcRenderer.invoke('gcal-connect'),
  gcalDisconnect: () => ipcRenderer.invoke('gcal-disconnect'),
  gcalCreateEvent: (payload) => ipcRenderer.invoke('gcal-create-event', payload),
  gcalUpdateEvent: (payload) => ipcRenderer.invoke('gcal-update-event', payload),
  gcalDeleteEvent: (payload) => ipcRenderer.invoke('gcal-delete-event', payload),
  // Outlook Calendar (Microsoft Graph, Étape 21)
  outlookStatus: () => ipcRenderer.invoke('outlook-status'),
  outlookConnect: () => ipcRenderer.invoke('outlook-connect'),
  outlookDisconnect: () => ipcRenderer.invoke('outlook-disconnect'),
  outlookCreateEvent: (payload) => ipcRenderer.invoke('outlook-create-event', payload),
  outlookUpdateEvent: (payload) => ipcRenderer.invoke('outlook-update-event', payload),
  outlookDeleteEvent: (payload) => ipcRenderer.invoke('outlook-delete-event', payload),
  // Version + mises à jour
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onUpdateStatus: (callback) => {
    ipcRenderer.on('update-status', (event, payload) => callback(payload));
  },
  // Étape 22 — ouvrir URL externe (mailto:, https:, etc.) via shell.openExternal
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  // Platform/arch infos (pour adapter le comportement Mac vs Windows)
  platform: process.platform, // 'darwin' (Mac), 'win32' (Windows), 'linux'
  arch: process.arch,         // 'x64' (Intel) ou 'arm64' (Apple Silicon)
  isElectron: true
});
