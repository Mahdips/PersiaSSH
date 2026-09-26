const { Terminal } = (window.xterm || window); // xterm UMD exposes Terminal directly on window
const FitAddon = window.FitAddon?.FitAddon || window.fitAddon?.FitAddon || window.FitAddon || window.fitAddon;

let servers = [];
let activeServerId = null;
let editingId = null;
const tabs = new Map(); // id -> { terminal, fit, sessionId, pane, serverId, status }
let activeTabId = null;
let tabSeq = 0;
let pendingProxyFocus = null;

// Persian digits for the sidebar counter
const faNum = (n) => String(n).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);

// ---------------- helpers ----------------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

function toast(message, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// ---------------- servers ----------------
async function loadServers() {
  servers = await window.api.listServers();
  renderServers();
}

function renderServers() {
  const list = $('#serverList');
  list.innerHTML = '';
  $('#serverCount').textContent = `${faNum(servers.length)} سرور`;

  if (!servers.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'color:var(--text-faint);font-size:12.5px;text-align:center;padding:28px 8px;line-height:2;';
    empty.textContent = 'هنوز سروری اضافه نشده.\nبا دکمه «سرور جدید» شروع کنید.';
    empty.style.whiteSpace = 'pre-line';
    list.appendChild(empty);
    return;
  }

  for (const s of servers) {
    const item = document.createElement('div');
    item.className = 'server-item' + (s.id === activeServerId ? ' active' : '');
    item.dataset.id = s.id;

    const proxyTag = s.proxy?.host
      ? `<span style="color:var(--accent);font-size:10px" title="از طریق ${s.proxy.type}://${s.proxy.host}:${s.proxy.port}">⇄</span>`
      : '';

    item.innerHTML = `
      <div class="server-icon">▣</div>
      <div class="server-meta">
        <div class="server-name">${escapeHtml(s.name || s.host)}</div>
        <div class="server-host">${escapeHtml(s.host)}${proxyTag}</div>
      </div>
      <div class="server-actions">
        <button class="icon-btn" data-act="sftp" title="مدیریت فایل (SFTP)">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6a1.5 1.5 0 0 1 1.06.44L8 4.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-7Z"/><path d="M5.5 9.5h5"/></svg>
        </button>
        <button class="icon-btn" data-act="edit" title="ویرایش">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 2.5a2.12 2.12 0 0 1 3 3L7 13l-4 1 1-4 7.5-7.5Z"/></svg>
        </button>
        <button class="icon-btn danger" data-act="delete" title="حذف">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4.5h11M6 4.5V3.25A.75.75 0 0 1 6.75 2.5h2.5a.75.75 0 0 1 .75.75V4.5M4.25 4.5l.6 8.1a1 1 0 0 0 1 .9h4.3a1 1 0 0 0 1-.9l.6-8.1"/></svg>
        </button>
      </div>
    `;

    item.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act) {
        e.stopPropagation();
        handleServerAction(act, s.id);
        return;
      }
      activeServerId = s.id;
      renderServers();
      openTerminalTab(s.id);
    });

    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(e, s.id);
    });

    list.appendChild(item);
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str ?? '');
  return div.innerHTML;
}

function handleServerAction(act, id) {
  if (act === 'edit') openModal(id);
  else if (act === 'delete') confirmDelete(id);
  else if (act === 'sftp') openSftp(id);
}

function showContextMenu(e, id) {
  const menu = $('#contextMenu');
  const s = servers.find((x) => x.id === id);
  menu.innerHTML = `
    <button data-act="connect">▶ باز کردن ترمینال</button>
    <button data-act="sftp">⬆ مدیریت فایل (SFTP)</button>
    <button data-act="edit">✎ ویرایش سرور</button>
    <div class="menu-sep"></div>
    <button data-act="delete" class="danger">🗑 حذف سرور</button>
  `;
  menu.classList.remove('hidden');
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(e.clientX, window.innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.min(e.clientY, window.innerHeight - rect.height - 8)}px`;

  menu.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      menu.classList.add('hidden');
      handleServerAction(btn.dataset.act, id);
    });
  });
}

document.addEventListener('click', () => $('#contextMenu').classList.add('hidden'));

async function confirmDelete(id) {
  const s = servers.find((x) => x.id === id);
  const ok = window.confirm(`سرور «${s?.name || s?.host}» حذف شود؟`);
  if (!ok) return;
  await window.api.deleteServer(id);
  if (activeServerId === id) activeServerId = null;
  await loadServers();
  toast('سرور حذف شد', 'ok');
}

function openSftp(id) {
  window.api.openSftpWindow(id);
}

// ---------------- modal ----------------
function openModal(id = null) {
  editingId = id;
  const s = id ? servers.find((x) => x.id === id) : null;
  $('#modalTitle').textContent = s ? 'ویرایش سرور' : 'سرور جدید';
  $('#fName').value = s?.name || '';
  $('#fHost').value = s?.host || '';
  $('#fPort').value = s?.port || 22;
  $('#fUser').value = s?.username || 'root';
  $('#fPass').value = s ? '' : '';
  $('#fPass').placeholder = s ? 'رمز فعلی ذخیره شده (برای تغییر وارد کنید)' : 'رمز عبور';
  $('#fProxyType').value = s?.proxy?.type || '';
  $('#fProxyHost').value = s?.proxy?.host || '';
  $('#fProxyPort').value = s?.proxy?.port || '';
  $('#fProxyUser').value = s?.proxy?.username || '';
  $('#fProxyPass').value = '';
  $('#formError').textContent = '';
  $('#modalOverlay').classList.remove('hidden');
  setTimeout(() => $('#fName').focus(), 50);
}

function closeModal() {
  $('#modalOverlay').classList.add('hidden');
  editingId = null;
}

function readForm() {
  const proxyType = $('#fProxyType').value;
  const hasProxy = proxyType && $('#fProxyHost').value.trim();
  return {
    id: editingId || undefined,
    name: $('#fName').value.trim(),
    host: $('#fHost').value.trim(),
    port: Number($('#fPort').value) || 22,
    username: $('#fUser').value.trim() || 'root',
    password: $('#fPass').value,
    proxy: hasProxy
      ? {
          type: proxyType,
          aware: false,
          host: $('#fProxyHost').value.trim(),
          port: Number($('#fProxyPort').value) || 1080,
          username: $('#fProxyUser').value.trim() || undefined,
          password: $('#fProxyPass').value || undefined,
        }
      : null,
  };
}

function validateForm() {
  const f = readForm();
  if (!f.host) return 'آدرس سرور الزامی است';
  if (!f.password && !editingId) return 'رمز عبور الزامی است';
  if (f.proxy && !f.proxy.port) return 'پورت پراکسی را وارد کنید';
  return null;
}

// ---------------- tabs / terminals ----------------
function ensureTabBar() {
  $('#tabBar').classList.remove('hidden');
  $('#welcome')?.classList.add('hidden');
}

// ---------------- themes ----------------
const UI_THEMES = [
  { id: 'midnight', name: 'منظم (آبی تیره)' },
  { id: 'dim', name: 'طوسی' },
  { id: 'light', name: 'روشن' },
  { id: 'dracula', name: 'دراکولا' },
  { id: 'solarized', name: 'سولارایزد' },
  { id: 'gruvbox', name: 'گرووباکس' },
];

const TERM_THEMES = {
  midnight: {
    background: '#0d1117', foreground: '#e6edf3', cursor: '#4c8dff',
    selectionBackground: 'rgba(76,141,255,0.45)', selectionInactiveBackground: 'rgba(76,141,255,0.18)',
    black: '#0d1117', red: '#f0654a', green: '#3fb950', yellow: '#d9a64a', blue: '#4c8dff',
    magenta: '#bc8cff', cyan: '#39c5cf', white: '#e6edf3', brightBlack: '#5c6878',
    brightRed: '#ff8b75', brightGreen: '#56d364', brightYellow: '#e8c06a', brightBlue: '#6cb6ff',
    brightMagenta: '#d2a8ff', brightCyan: '#56e0e0', brightWhite: '#ffffff',
  },
  dim: {
    background: '#1e2124', foreground: '#d7dadc', cursor: '#58a6ff',
    selectionBackground: 'rgba(88,166,255,0.40)', selectionInactiveBackground: 'rgba(88,166,255,0.16)',
    black: '#1e2124', red: '#f47174', green: '#43d17c', yellow: '#e3b341', blue: '#58a6ff',
    magenta: '#c792ea', cyan: '#39c5cf', white: '#d7dadc', brightBlack: '#6a7480',
    brightRed: '#ff9496', brightGreen: '#6ce08d', brightYellow: '#f0c674', brightBlue: '#7cb7ff',
    brightMagenta: '#d9a8ff', brightCyan: '#6fe0e0', brightWhite: '#ffffff',
  },
  light: {
    background: '#f6f8fa', foreground: '#1f2328', cursor: '#0969da',
    selectionBackground: 'rgba(9,105,218,0.28)', selectionInactiveBackground: 'rgba(9,105,218,0.12)',
    black: '#24292f', red: '#cf222e', green: '#1a7f37', yellow: '#9a6700', blue: '#0969da',
    magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781', brightBlack: '#57606a',
    brightRed: '#a40e26', brightGreen: '#2da44e', brightYellow: '#bf8700', brightBlue: '#218bff',
    brightMagenta: '#a475f9', brightCyan: '#3192aa', brightWhite: '#8c959f',
  },
  dracula: {
    background: '#282a36', foreground: '#f8f8f2', cursor: '#bd93f9',
    selectionBackground: 'rgba(189,147,249,0.35)', selectionInactiveBackground: 'rgba(189,147,249,0.14)',
    black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c', blue: '#bd93f9',
    magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2', brightBlack: '#6272a4',
    brightRed: '#ff6e67', brightGreen: '#69ff94', brightYellow: '#ffffa5', brightBlue: '#d6acff',
    brightMagenta: '#ff92d0', brightCyan: '#a4ffff', brightWhite: '#ffffff',
  },
  solarized: {
    background: '#002b36', foreground: '#fdf6e3', cursor: '#268bd2',
    selectionBackground: 'rgba(38,139,210,0.38)', selectionInactiveBackground: 'rgba(38,139,210,0.15)',
    black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2',
    magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5', brightBlack: '#586e75',
    brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83', brightBlue: '#839496',
    brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
  },
  gruvbox: {
    background: '#282828', foreground: '#ebdbb2', cursor: '#fabd2f',
    selectionBackground: 'rgba(250,189,47,0.32)', selectionInactiveBackground: 'rgba(250,189,47,0.13)',
    black: '#282828', red: '#fb4934', green: '#b8bb26', yellow: '#fabd2f', blue: '#83a598',
    magenta: '#d3869b', cyan: '#8ec07c', white: '#ebdbb2', brightBlack: '#928374',
    brightRed: '#fe8019', brightGreen: '#b8bb26', brightYellow: '#fe8019', brightBlue: '#83a598',
    brightMagenta: '#d3869b', brightCyan: '#8ec07c', brightWhite: '#ebdbb2',
  },
};

function getTerminalTheme() {
  const t = localStorage.getItem('persiassh-theme') || 'midnight';
  return TERM_THEMES[t] || TERM_THEMES.midnight;
}

function applyTheme(themeId) {
  const t = UI_THEMES.find((x) => x.id === themeId) || UI_THEMES[0];
  document.body.setAttribute('data-theme', t.id);
  localStorage.setItem('persiassh-theme', t.id);
  // recolor every open terminal
  for (const [, tab] of tabs) {
    tab.terminal.options.theme = getTerminalTheme();
  }
  const select = $('#themeSelect');
  if (select) select.value = t.id;
}

function initTheme() {
  const saved = localStorage.getItem('persiassh-theme') || 'midnight';
  applyTheme(saved);
}

function openTerminalTab(serverId) {
  const server = servers.find((s) => s.id === serverId);
  if (!server) return;

  ensureTabBar();
  const id = `tab-${++tabSeq}`;
  const pane = document.createElement('div');
  pane.className = 'terminal-pane';
  pane.dataset.tabId = id;
  $('#terminalArea').appendChild(pane);

  const terminal = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: "'Cascadia Code','JetBrains Mono',Consolas,monospace",
    theme: getTerminalTheme(),
  });

  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(pane);
  setTimeout(() => fit.fit(), 0);

  terminal.write(`\x1b[36mدر حال اتصال به ${server.host}:${server.port} ...\x1b[0m\r\n`);

  const tab = { id, terminal, fit, pane, serverId, sessionId: null, status: 'connecting' };
  tabs.set(id, tab);
  renderTabs();
  activateTab(id);

  window.api
    .connectSession({ serverId, cols: terminal.cols, rows: terminal.rows })
    .then((sessionId) => {
      tab.sessionId = sessionId;
    })
    .catch((err) => {
      tab.status = 'error';
      terminal.write(`\x1b[31mخطا در ایجاد نشست: ${err.message}\x1b[0m\r\n`);
      renderTabs();
    });

  terminal.onData((data) => {
    if (tab.sessionId) window.api.inputSession(tab.sessionId, data);
  });

  // selecting text copies it to the clipboard automatically
  terminal.onSelectionChange(() => {
    const sel = terminal.getSelection();
    if (sel) {
      navigator.clipboard?.writeText(sel).catch(() => {});
    }
  });

  // refit when the pane becomes visible
  const observer = new MutationObserver(() => {
    if (pane.classList.contains('active')) fit.fit();
  });
  observer.observe(pane, { attributes: true, attributeFilter: ['class'] });
}

function renderTabs() {
  const bar = $('#tabs');
  bar.innerHTML = '';
  for (const [id, tab] of tabs) {
    const server = servers.find((s) => s.id === tab.serverId);
    const el = document.createElement('button');
    el.className = 'tab' + (id === activeTabId ? ' active' : '');
    el.innerHTML = `
      <span class="tab-close" title="بستن">
        <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>
      </span>
      <span class="tab-status ${tab.status === 'connected' ? 'connected' : tab.status === 'error' ? 'error' : ''}"></span>
      <span class="tab-name">${escapeHtml(server?.name || server?.host || 'ترمینال')}</span>
    `;
    el.addEventListener('click', (e) => {
      if (e.target.closest('.tab-close')) {
        closeTab(id);
        return;
      }
      activateTab(id);
    });
    el.addEventListener('auxclick', (e) => {
      if (e.button === 1) closeTab(id);
    });
    bar.appendChild(el);
  }
}

function activateTab(id) {
  activeTabId = id;
  for (const [tid, tab] of tabs) {
    tab.pane.classList.toggle('active', tid === id);
  }
  renderTabs();
  const tab = tabs.get(id);
  if (tab) {
    setTimeout(() => {
      tab.fit.fit();
      // focus the terminal so typing works immediately
      tab.terminal.focus();
    }, 30);
  }
}

async function closeTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  // confirm before killing a live session
  if (tab.sessionId && tab.status === 'connected') {
    const ok = window.confirm('این تب بسته شود؟ اتصال SSH قطع خواهد شد.');
    if (!ok) return;
  }
  if (tab.sessionId) {
    await window.api.disconnectSession(tab.sessionId);
  }
  tab.terminal.dispose();
  tab.pane.remove();
  tabs.delete(id);

  const remaining = [...tabs.keys()];
  if (!remaining.length) {
    $('#tabBar').classList.add('hidden');
    $('#welcome')?.classList.remove('hidden');
    activeTabId = null;
  } else {
    activateTab(remaining[remaining.length - 1]);
  }
  renderTabs();
}

// ---------------- events from main ----------------
window.api.onData((id, data) => {
  for (const [, tab] of tabs) {
    if (tab.sessionId === id) {
      tab.terminal.write(data);
    }
  }
});

window.api.onStatus((id, status, info) => {
  for (const [, tab] of tabs) {
    if (tab.sessionId !== id) continue;
    tab.status = status;
    renderTabs();
    if (status === 'error') {
      tab.terminal.write(`\x1b[31m${info || 'خطای اتصال'}\x1b[0m\r\n`);
    } else if (status === 'closed') {
      tab.terminal.write(`\x1b[33m${info || 'اتصال قطع شد'}\x1b[0m\r\n`);
    }
  }
});

window.api.onServersChanged(loadServers);

// ---------------- wire up ----------------
$('#btnNewServer').addEventListener('click', () => openModal());
$('#modalClose').addEventListener('click', closeModal);
$('#btnCancel').addEventListener('click', closeModal);
$('#modalOverlay').addEventListener('click', (e) => {
  if (e.target === $('#modalOverlay')) closeModal();
});

$('#togglePass').addEventListener('click', () => {
  const input = $('#fPass');
  input.type = input.type === 'password' ? 'text' : 'password';
});

$('#serverForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = validateForm();
  if (err) {
    $('#formError').textContent = err;
    return;
  }
  const btn = $('#btnSave');
  btn.disabled = true;
  btn.textContent = 'در حال ذخیره...';
  try {
    await window.api.saveServer(readForm());
    closeModal();
    await loadServers();
    toast(editingId ? 'سرور به‌روزرسانی شد' : 'سرور ذخیره شد', 'ok');
  } catch (err2) {
    $('#formError').textContent = err2.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'ذخیره';
  }
});

$('#btnTest').addEventListener('click', async () => {
  const err = validateForm();
  if (err) {
    $('#formError').textContent = err;
    return;
  }
  const btn = $('#btnTest');
  btn.disabled = true;
  btn.textContent = 'در حال تست...';
  $('#formError').textContent = '';
  try {
    const res = await window.api.testServer(readForm());
    if (res.ok) {
      $('#formError').style.color = 'var(--green)';
      $('#formError').textContent = '✓ ' + res.message;
      toast(res.message, 'ok');
    } else {
      $('#formError').style.color = 'var(--red)';
      $('#formError').textContent = '✕ ' + res.message;
    }
  } catch (err2) {
    $('#formError').style.color = 'var(--red)';
    $('#formError').textContent = '✕ ' + err2.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'تست اتصال';
    setTimeout(() => ($('#formError').style.color = ''), 6000);
  }
});

$('#btnNewTab').addEventListener('click', () => {
  if (activeServerId) openTerminalTab(activeServerId);
  else toast('ابتدا یک سرور انتخاب کنید');
});

window.addEventListener('resize', () => {
  for (const [, tab] of tabs) tab.fit.fit();
});

// keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    openModal();
  } else if (e.ctrlKey && e.key.toLowerCase() === 't') {
    e.preventDefault();
    if (activeServerId) openTerminalTab(activeServerId);
  } else if (e.ctrlKey && e.key.toLowerCase() === 'w') {
    e.preventDefault();
    if (activeTabId) closeTab(activeTabId);
  } else if (e.key === 'Escape') {
    closeModal();
    $('#contextMenu').classList.add('hidden');
  }
});

window.api.onMenuNewServer(() => openModal());

// ---------------- theme selector ----------------
(function initThemeSelect() {
  const select = $('#themeSelect');
  if (!select) return;
  for (const t of UI_THEMES) {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.name;
    select.appendChild(opt);
  }
  select.addEventListener('change', () => applyTheme(select.value));
  initTheme();
})();

// ---------------- boot ----------------
loadServers();
