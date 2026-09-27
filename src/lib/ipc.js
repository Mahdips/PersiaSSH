const { ipcMain, BrowserWindow, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Client } = require('ssh2');

const store = require('./store');
const sessions = require('./sessions');
const sftpManager = require('./sftp');
const sftpWindow = require('./sftpWindow');
const { connectViaProxy } = require('./proxy');

/**
 * Tiny connection probe used by the "تست اتصال" button — opens the transport
 * and immediately tears it down so the UI can report hostReachable/auth-ok.
 */
function testConnection(server) {
  return new Promise((resolve) => {
    const conn = new Client();
    let settled = false;
    const done = (ok, message) => {
      if (settled) return;
      settled = true;
      try {
        conn.end();
      } catch {
        /* noop */
      }
      resolve({ ok, message });
    };
    conn.on('ready', () => done(true, 'اتصال و احراز هویت موفق بود'));
    conn.on('error', (err) => done(false, err.message));
    setTimeout(() => done(false, 'تایم‌اوت — سرور پاسخ نداد'), 20000);

    connectViaProxy(server.host, server.port || 22, server.proxy)
      .then((sock) => conn.connect({ sock, host: server.host, port: server.port || 22, username: server.username, password: server.password }))
      .catch((e) => done(false, e.message));
  });
}

function register({ getMainWindow }) {
  // ---------------- servers ----------------
  ipcMain.handle('servers:list', () => store.listSafe());
  ipcMain.handle('servers:secrets-ok', () => !store.hasOrphanedSecrets());
  ipcMain.handle('servers:save', (_e, server) => {
    const saved = store.upsert(server);
    getMainWindow()?.webContents.send('servers:changed');
    return saved;
  });
  ipcMain.handle('servers:delete', (_e, id) => {
    store.remove(id);
    getMainWindow()?.webContents.send('servers:changed');
    return true;
  });
  ipcMain.handle('servers:test', (_e, server) => testConnection(server));

  // ---------------- terminal sessions ----------------
  ipcMain.handle('session:connect', (e, { serverId, cols, rows }) => {
    const id = `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const win = BrowserWindow.fromWebContents(e.sender);
    const emit = (channel, sid, ...args) => win?.webContents.send(`session:${channel}`, sid, ...args);
    sessions.create({ id, serverId, cols, rows }, emit);
    return id;
  });

  ipcMain.on('session:input', (_e, id, data) => sessions.write(id, data));
  ipcMain.on('session:resize', (_e, id, cols, rows) => sessions.resize(id, cols, rows));
  ipcMain.handle('session:disconnect', (_e, id) => {
    sessions.close(id);
    return true;
  });

  // ---------------- sftp window ----------------
  ipcMain.on('sftp:window', (_e, serverId) => {
    if (serverId) sftpWindow.createSftpWindow(serverId);
  });

  // ---------------- sftp ----------------
  ipcMain.handle('sftp:connect', async (_e, serverId) => sftpManager.connect(serverId));
  ipcMain.handle('sftp:list', async (_e, sid, p) => sftpManager.list(sid, p));
  ipcMain.handle('sftp:mkdir', async (_e, sid, p) => sftpManager.mkdir(sid, p));
  ipcMain.handle('sftp:rename', async (_e, sid, from, to) => sftpManager.rename(sid, from, to));
  ipcMain.handle('sftp:delete', async (_e, sid, p) => sftpManager.delete(sid, p));
  ipcMain.handle('sftp:upload', async (e, sid, localPath, remotePath) =>
    sftpManager.upload(sid, localPath, remotePath, (payload) => e.sender.send('sftp:transfer', payload))
  );
  ipcMain.handle('sftp:download', async (e, sid, remotePath, localPath) =>
    sftpManager.download(sid, remotePath, localPath, (payload) => e.sender.send('sftp:transfer', payload))
  );

  // ---------------- local filesystem ----------------
  ipcMain.handle('local:list', async (_e, p) => {
    const dir = p || os.homedir();
    const out = { path: dir, entries: [], error: null };
    try {
      for (const name of fs.readdirSync(dir)) {
        try {
          const st = fs.statSync(path.join(dir, name));
          out.entries.push({
            name,
            isDir: st.isDirectory(),
            size: st.size,
            mtime: st.mtimeMs,
          });
        } catch {
          /* skip unreadable entries */
        }
      }
      out.entries.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));
    } catch (err) {
      out.error = err.message;
    }
    return out;
  });

  ipcMain.handle('local:home', () => os.homedir());
  ipcMain.handle('local:open', (_e, p) => shell.openPath(p));
}

module.exports = { register };
