const { contextBridge, ipcRenderer } = require('electron');

/**
 * Every renderer<->main message goes through this typed bridge.
 * `on*` methods register a listener and return a disposer.
 */
const api = {
  // ---------- servers (encrypted store) ----------
  listServers: () => ipcRenderer.invoke('servers:list'),
  saveServer: (server) => ipcRenderer.invoke('servers:save', server),
  deleteServer: (id) => ipcRenderer.invoke('servers:delete', id),
  testServer: (server) => ipcRenderer.invoke('servers:test', server),
  onServersChanged: (cb) => {
    const h = () => cb();
    ipcRenderer.on('servers:changed', h);
    return () => ipcRenderer.removeListener('servers:changed', h);
  },

  // ---------- sftp window ----------
  openSftpWindow: (serverId) => ipcRenderer.send('sftp:window', serverId),

  // ---------- terminal sessions ----------
  connectSession: (opts) => ipcRenderer.invoke('session:connect', opts),
  inputSession: (id, data) => ipcRenderer.send('session:input', id, data),
  resizeSession: (id, cols, rows) => ipcRenderer.send('session:resize', id, cols, rows),
  disconnectSession: (id) => ipcRenderer.invoke('session:disconnect', id),

  onData: (cb) => {
    const h = (_e, id, data) => cb(id, data);
    ipcRenderer.on('session:data', h);
    return () => ipcRenderer.removeListener('session:data', h);
  },
  onStatus: (cb) => {
    const h = (_e, id, status, info) => cb(id, status, info);
    ipcRenderer.on('session:status', h);
    return () => ipcRenderer.removeListener('session:status', h);
  },

  // ---------- sftp ----------
  connectSftp: (serverId) => ipcRenderer.invoke('sftp:connect', serverId),
  listRemote: (sid, path) => ipcRenderer.invoke('sftp:list', sid, path),
  listLocal: (p) => ipcRenderer.invoke('local:list', p),
  localHome: () => ipcRenderer.invoke('local:home'),
  mkdirRemote: (sid, p) => ipcRenderer.invoke('sftp:mkdir', sid, p),
  renameRemote: (sid, from, to) => ipcRenderer.invoke('sftp:rename', sid, from, to),
  deleteRemote: (sid, p) => ipcRenderer.invoke('sftp:delete', sid, p),
  upload: (sid, localPath, remotePath) => ipcRenderer.invoke('sftp:upload', sid, localPath, remotePath),
  download: (sid, remotePath, localPath) => ipcRenderer.invoke('sftp:download', sid, remotePath, localPath),
  openLocal: (p) => ipcRenderer.invoke('local:open', p),

  onTransfer: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on('sftp:transfer', h);
    return () => ipcRenderer.removeListener('sftp:transfer', h);
  },

  // ---------- menu events ----------
  onMenuNewServer: (cb) => {
    const h = () => cb();
    ipcRenderer.on('menu:new-server', h);
    return () => ipcRenderer.removeListener('menu:new-server', h);
  },

  // ---------- window ----------
  getSessionId: () => new URLSearchParams(location.search).get('session'),
};

contextBridge.exposeInMainWorld('api', api);
