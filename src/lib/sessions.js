const { Client } = require('ssh2');
const { connectViaProxy } = require('./proxy');
const store = require('./store');

const sessions = new Map();

function fmtErr(err) {
  const m = err?.message || String(err);
  if (/ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/.test(m)) {
    return `اتصال برقرار نشد: ${m}. آیا IP و پورت درست هستند و پراکسی (در صورت استفاده) روشن است؟`;
  }
  if (/All configured authentication methods failed|authentication/i.test(m)) {
    return 'احراز هویت ناموفق بود — نام کاربری یا رمز عبور اشتباه است.';
  }
  return m;
}

/**
 * Establishes the SSH transport (optionally through a proxy), then opens a PTY.
 * Resolves with the session id once the shell is live; all later output is
 * pushed through the emit('data') callback.
 */
function create({ id, serverId, cols = 100, rows = 30 }, emit) {
  const server = store.get(serverId);
  if (!server) throw new Error('سرور یافت نشد');

  const conn = new Client();
  const session = { id, conn, stream: null, closed: false };
  sessions.set(id, session);

  const status = (s, info) => emit('status', id, s, info);

  conn.on('ready', () => {
    conn.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
      if (err) {
        status('error', fmtErr(err));
        sessions.delete(id);
        return;
      }
      session.stream = stream;
      stream.on('data', (d) => emit('data', id, d.toString('utf8')));
      stream.stderr.on('data', (d) => emit('data', id, d.toString('utf8')));
      stream.on('close', () => {
        session.closed = true;
        sessions.delete(id);
        status('closed', 'اتصال بسته شد');
      });
      status('connected', '');
    });
  });

  conn.on('error', (err) => {
    status('error', fmtErr(err));
  });
  conn.on('close', () => {
    if (!session.closed) {
      session.closed = true;
      sessions.delete(id);
      status('closed', 'اتصال قطع شد');
    }
  });

  const options = {
    host: server.host,
    port: server.port || 22,
    username: server.username || 'root',
    password: server.password,
    readyTimeout: 25000,
    keepaliveInterval: 15000,
    keepaliveCountMax: 3,
    algorithms: {
      // keep older servers reachable alongside modern defaults
      kex: ['diffie-hellman-group14-sha256', 'ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521', 'curve25519-sha256'],
      serverHostKey: ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-ed25519', 'ssh-rsa'],
    },
  };

  connectViaProxy(server.host, server.port || 22, server.proxy)
    .then((socket) => {
      status('connecting', 'در حال مذاکره با سرور...');
      conn.connect({ ...options, sock: socket });
    })
    .catch((err) => {
      status('error', fmtErr(err));
      sessions.delete(id);
    });

  return id;
}

function write(id, data) {
  sessions.get(id)?.stream?.write(data);
}

function resize(id, cols, rows) {
  sessions.get(id)?.stream?.setWindow(cols, rows, 480, 640);
}

function close(id) {
  const s = sessions.get(id);
  if (!s) return;
  s.closed = true;
  try {
    s.stream?.close();
  } catch {
    /* already gone */
  }
  try {
    s.conn.end();
  } catch {
    /* already gone */
  }
  sessions.delete(id);
}

function closeAll() {
  for (const id of [...sessions.keys()]) close(id);
}

module.exports = { create, write, resize, close, closeAll, sessions };
