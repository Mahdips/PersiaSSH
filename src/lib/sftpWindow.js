const { BrowserWindow } = require('electron');
const path = require('path');
const store = require('./store');

/**
 * Opens the SFTP file-explorer window for a given server. The window keeps a
 * reference to its own SFTP channel via the query param; main.js forwards
 * terminal-window cleanup separately.
 */
function createSftpWindow(serverId) {
  const server = store.get(serverId);
  const win = new BrowserWindow({
    width: 1000,
    height: 660,
    minWidth: 660,
    minHeight: 440,
    backgroundColor: '#0e1116',
    title: `مدیریت فایل — ${server?.name || server?.host || 'سرور'}`,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', '..', 'renderer', 'sftp.html'), { query: { server: serverId } });
  win.once('ready-to-show', () => win.show());

  // drop the OS chrome menu but keep copy/paste working inside text fields
  win.setMenuBarVisibility(false);
  win.setAutoHideMenuBar(true);

  return win;
}

module.exports = { createSftpWindow };
