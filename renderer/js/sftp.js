// ---------------- SFTP file explorer ----------------
const serverId = new URLSearchParams(location.search).get('server');
let sftpSid = null;
let cwd = '/';
const selected = new Set();

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const transfers = new Map();

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str ?? '');
  return div.innerHTML;
}

function fmtBytes(n) {
  if (n == null) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}

function fmtTime(ms) {
  if (!ms) return '';
  try {
    return new Date(ms).toLocaleString('fa-IR', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return '';
  }
}

function iconFor(entry) {
  if (entry.isDir) return '▣';
  const n = entry.name.toLowerCase();
  if (/\.zip$|\.tar|\.gz$|\.rar$|\.7z$/i.test(n)) return '🗜';
  if (/\.png$|\.jpg$|\.jpeg$|\.gif$|\.webp$|\.svg$/i.test(n)) return '🖼';
  if (/\.mp4$|\.mkv$|\.avi$|\.mov$/i.test(n)) return '🎬';
  if (/\.mp3$|\.wav$|\.flac$/i.test(n)) return '🎵';
  if (/\.sh$|\.py$|\.js$|\.ts$|\.go$|\.rs$|\.json$|\.ya?ml$|\.conf$|\.txt$|\.md$/i.test(n)) return '📄';
  return '⬚';
}

function posixJoin(base, name) {
  if (base.endsWith('/')) return base + name;
  return `${base}/${name}`;
}

function posixDir(path) {
  const parts = path.split('/').filter(Boolean);
  parts.pop();
  return '/' + parts.join('/');
}

// ---------------- connection & listing ----------------
async function connect() {
  const list = $('#fileList');
  list.innerHTML = '<div class="loading-state">در حال اتصال به سرور...</div>';
  try {
    sftpSid = await window.api.connectSftp(serverId);
    await refresh();
  } catch (err) {
    list.innerHTML = `<div class="file-empty">خطا در اتصال:<br>${escapeHtml(err.message)}</div>`;
  }
}

async function refresh() {
  if (!sftpSid) return;
  selected.clear();
  if (typeof syncSelectionButtons === 'function') syncSelectionButtons();
  const list = $('#fileList');
  list.innerHTML = '<div class="loading-state">در حال بارگذاری...</div>';
  try {
    const res = await window.api.listRemote(sftpSid, cwd);
    if (res.error) {
      list.innerHTML = `<div class="file-empty">${escapeHtml(res.error)}</div>`;
      return;
    }
    cwd = res.path;
    renderBreadcrumb();
    list.innerHTML = '';
    if (!res.entries.length) {
      list.innerHTML = '<div class="file-empty">این پوشه خالی است</div>';
      return;
    }
    for (const entry of res.entries) list.appendChild(makeRow(entry));
  } catch (err) {
    list.innerHTML = `<div class="file-empty">خطا: ${escapeHtml(err.message)}</div>`;
  }
}

function makeRow(entry) {
  const row = document.createElement('div');
  row.className = 'file-row' + (entry.isDir ? ' dir' : '');
  row.dataset.name = entry.name;
  row.innerHTML = `
    <div class="file-icon">${iconFor(entry)}</div>
    <div class="file-name">${escapeHtml(entry.name)}</div>
    <div class="file-size">${entry.isDir ? '' : fmtBytes(entry.size)}</div>
    <div class="file-mtime">${fmtTime(entry.mtime)}</div>
  `;

  row.addEventListener('click', (e) => {
    if (e.shiftKey || e.ctrlKey) {
      row.classList.toggle('selected');
      if (row.classList.contains('selected')) selected.add(entry.name);
      else selected.delete(entry.name);
    } else {
      selected.clear();
      $$('.file-row').forEach((r) => r.classList.remove('selected'));
      row.classList.add('selected');
      selected.add(entry.name);
    }
    syncSelectionButtons();
  });

  row.addEventListener('dblclick', () => {
    if (entry.isDir) {
      cwd = posixJoin(cwd, entry.name);
      refresh();
    } else {
      downloadOne(entry);
    }
  });

  return row;
}

function renderBreadcrumb() {
  const crumb = $('#pathCrumb');
  crumb.innerHTML = '';
  const root = document.createElement('span');
  root.className = 'crumb';
  root.textContent = '/';
  root.title = 'انتقال به ریشه';
  root.addEventListener('click', () => {
    cwd = '/';
    refresh();
  });
  crumb.appendChild(root);

  let current = '';
  for (const part of cwd.split('/').filter(Boolean)) {
    current = `${current}/${part}`;
    const sep = document.createElement('span');
    sep.className = 'crumb-sep';
    sep.textContent = '›';
    crumb.appendChild(sep);
    const btn = document.createElement('span');
    btn.className = 'crumb';
    btn.textContent = part;
    btn.title = current;
    btn.addEventListener('click', () => {
      cwd = current;
      refresh();
    });
    crumb.appendChild(btn);
  }
}

// ---------------- operations ----------------
async function downloadOne(entry) {
  try {
    const home = await window.api.localHome();
    const sep = navigator.platform.includes('Win') ? '\\' : '/';
    const target = [home, 'Downloads', entry.name].join(sep);
    addTransferRow(entry.name);
    await window.api.download(sftpSid, posixJoin(cwd, entry.name), target);
  } catch (err) {
    addTransferRow(`خطای دانلود ${entry.name}: ${err.message}`, true);
  }
}

async function uploadFiles(files) {
  if (!sftpSid) return;
  for (const file of files) {
    if (!file.path) continue;
    addTransferRow(file.name);
    try {
      await window.api.upload(sftpSid, file.path, cwd);
    } catch (err) {
      addTransferRow(`خطای آپلود ${file.name}: ${err.message}`, true);
    }
  }
  refresh();
}

async function newFolder() {
  const name = window.prompt('نام پوشه جدید:');
  if (!name) return;
  try {
    await window.api.mkdirRemote(sftpSid, posixJoin(cwd, name));
    refresh();
  } catch (err) {
    window.alert('خطا در ساخت پوشه: ' + err.message);
  }
}

function goUp() {
  if (cwd === '/') return;
  cwd = posixDir(cwd);
  refresh();
}

// clicking empty space clears the selection
$('#fileList').addEventListener('click', (e) => {
  if (e.target.id === 'fileList' || e.target.classList.contains('file-empty')) {
    selected.clear();
    $$('.file-row').forEach((r) => r.classList.remove('selected'));
    syncSelectionButtons();
  }
});

// ---------------- transfer progress ----------------
function addTransferRow(name, isError) {
  $('#transferBar').classList.remove('hidden');
  const el = document.createElement('div');
  el.className = 'transfer-row' + (isError ? ' error' : '');
  el.innerHTML = `
    <span class="tname">${escapeHtml(name)}</span>
    <div class="transfer-bar-track"><div class="transfer-bar-fill" style="width:${isError ? 100 : 0}%"></div></div>
    <span class="tstatus">${isError ? 'خطا' : 'در صف...'}</span>
  `;
  $('#transferList').appendChild(el);
  const row = { el, fill: el.querySelector('.transfer-bar-fill'), status: el.querySelector('.tstatus') };
  transfers.set(name + Date.now(), row);
  return row;
}

window.api.onTransfer((payload) => {
  const key = payload.name;
  let row = transfers.get(key);
  if (!row || row.el.classList.contains('done')) {
    // reuse an existing "pending" row for this filename if any
    const pending = [...transfers.values()].find((r) => r.name === key && !r.el.classList.contains('done'));
    row = pending || addTransferRow(key);
    row.name = key;
    transfers.set(key, row);
  }
  const pct = payload.total ? Math.min(100, Math.round((payload.transferred / payload.total) * 100)) : 0;
  row.fill.style.width = pct + '%';
  row.status.textContent = payload.done ? 'انجام شد' : pct + '%';
  if (payload.done) {
    row.el.classList.remove('error');
    row.el.classList.add('done');
  }
});

$('#btnClearTransfers').addEventListener('click', () => {
  transfers.clear();
  $('#transferList').innerHTML = '';
  $('#transferBar').classList.add('hidden');
});

// ---------------- drag & drop ----------------
let dragCounter = 0;

document.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragCounter++;
  if (e.dataTransfer?.types?.includes('Files')) $('#dropOverlay').classList.remove('hidden');
});

document.addEventListener('dragover', (e) => e.preventDefault());

document.addEventListener('dragleave', () => {
  dragCounter = Math.max(0, dragCounter - 1);
  if (dragCounter === 0) $('#dropOverlay').classList.add('hidden');
});

document.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragCounter = 0;
  $('#dropOverlay').classList.add('hidden');
  const files = [...(e.dataTransfer?.files || [])];
  if (files.length) await uploadFiles(files);
});

// ---------------- toolbar ----------------
$('#btnUp').addEventListener('click', goUp);
$('#btnHome').addEventListener('click', () => {
  cwd = '/';
  refresh();
});
$('#btnRefresh').addEventListener('click', refresh);
$('#btnNewFolder').addEventListener('click', newFolder);
$('#btnUploadHere').addEventListener('click', () => {
  window.alert('برای آپلود، فایل‌ها را از ویندوز اکسپلورر داخل این پنجره بکشید و رها کنید (drag & drop).');
});

// ---------------- selection toolbar buttons ----------------
function selectedNames() { return [...selected]; }

function syncSelectionButtons() {
  const n = selected.size;
  const single = n === 1;
  $('#btnDownload').disabled = !single;
  $('#btnRename').disabled = !single;
  $('#btnDelete').disabled = n === 0;
}

$('#btnDownload').addEventListener('click', () => {
  const name = selectedNames()[0];
  if (name) downloadOne({ name });
});

$('#btnRename').addEventListener('click', () => {
  const from = selectedNames()[0];
  if (!from) return;
  const to = window.prompt('نام جدید:', from);
  if (to && to !== from) {
    window.api
      .renameRemote(sftpSid, posixJoin(cwd, from), posixJoin(cwd, to))
      .then(refresh)
      .catch((err) => alert(err.message));
  }
});

$('#btnDelete').addEventListener('click', async () => {
  const names = selectedNames();
  if (!names.length) return;
  const msg = names.length === 1 ? `«${names[0]}» حذف شود؟` : `${names.length} مورد حذف شوند؟`;
  if (!window.confirm(msg)) return;
  for (const name of names) {
    try {
      await window.api.deleteRemote(sftpSid, posixJoin(cwd, name));
    } catch (err) {
      alert(`${name}: ${err.message}`);
    }
  }
  refresh();
});

// right-click still selects the row so the toolbar buttons apply to it
document.addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.file-row');
  if (!row) return;
  e.preventDefault();
  row.click();
});

connect();
