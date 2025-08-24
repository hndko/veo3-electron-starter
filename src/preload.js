
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (s) => ipcRenderer.invoke('settings:set', s),

  queueList: () => ipcRenderer.invoke('queue:list'),
  addJob: (job) => ipcRenderer.invoke('queue:add', job),
  retryJob: (id) => ipcRenderer.invoke('queue:retry', id),
  startQueue: () => ipcRenderer.invoke('queue:start'),
  pauseQueue: () => ipcRenderer.invoke('queue:pause'),
  setConcurrency: (n) => ipcRenderer.invoke('queue:setConcurrency', n),
  clearDone: () => ipcRenderer.invoke('queue:clearDone'),

  chooseDir: () => ipcRenderer.invoke('dialog:chooseDir'),
  chooseFile: (filters) => ipcRenderer.invoke('dialog:chooseFile', filters),
  importCSV: (filePath) => ipcRenderer.invoke('import:csv', filePath),
  importTXT: (filePath) => ipcRenderer.invoke('import:txt', filePath),

  startWatch: (dirPath) => ipcRenderer.invoke('watch:start', dirPath),
  setOutputDir: (dirPath) => ipcRenderer.invoke('output:set', dirPath),

  onQueueUpdate: (cb) => ipcRenderer.on('queue:update', (_e, payload) => cb(payload)),
  onPausedByCap: (cb) => ipcRenderer.on('queue:pausedByCap', (_e, payload) => cb(payload))
});
