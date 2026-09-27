const { app, BrowserWindow, Menu, shell } = require('electron');
const path = require('path');

const store = require('./lib/store');
const sftpWindow = require('./lib/sftpWindow');
const ipc = require('./lib/ipc');
const sftpManager = require('./lib/sftp');

let mainWindow = null;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 740,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#0e1116',
    title: 'PersiaSSH',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.show();

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createSftpWindow(serverId) {
  return sftpWindow.createSftpWindow(serverId);
}

function buildMenu() {
  const template = [
    {
      label: 'فایل',
      submenu: [
        {
          label: 'سرور جدید...',
          accelerator: 'CmdOrCtrl+N',
          click: () => mainWindow?.webContents.send('menu:new-server'),
        },
        { type: 'separator' },
        { role: 'quit', label: 'خروج' },
      ],
    },
    {
      label: 'ویرایش',
      submenu: [
        { role: 'copy', label: 'کپی' },
        { role: 'paste', label: 'چسباندن' },
      ],
    },
    {
      label: 'نمایش',
      submenu: [
        { role: 'reload', label: 'بارگذاری مجدد' },
        { role: 'toggleDevTools', label: 'ابزار توسعه' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'بازنشانی بزرگنمایی' },
        { role: 'zoomIn', label: 'بزرگنمایی' },
        { role: 'zoomOut', label: 'کوچکنمایی' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'تمام صفحه' },
      ],
    },
    {
      label: 'کمک',
      submenu: [
        {
          label: 'درباره PersiaSSH',
          click: () => shell.openExternal('https://github.com'),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  try {
    store.init();
  } catch (err) {
    console.error('[store] init failed, continuing with an empty store:', err.message);
  }
  ipc.register({ getMainWindow: () => mainWindow });
  buildMenu();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  sftpManager.closeAll();
  app.quit();
});

app.on('before-quit', () => {
  sftpManager.closeAll();
});
