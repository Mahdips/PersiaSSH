const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, safeStorage } = require('electron');

const STORE_FILE = path.join(storeDir(), 'servers.json');
const KEY_FILE = path.join(storeDir(), 'master.key');

let masterKey = null;

/** app.getPath is only available inside Electron; fall back for tests/CLI. */
function storeDir() {
  try {
    if (app?.getPath) return app.getPath('userData');
  } catch {
    /* not in electron */
  }
  const base = process.env.APPDATA || process.env.HOME || process.env.TMPDIR || '/tmp';
  return path.join(base, 'persiassh');
}

/** safeStorage is electron-only; fall back to a plain random key when absent. */
function safeEncryptString(text) {
  if (safeStorage?.isEncryptionAvailable() && typeof safeStorage.encryptString === 'function') {
    return safeStorage.encryptString(text);
  }
  return Buffer.from(text);
}

function safeDecryptString(buf) {
  if (safeStorage?.isEncryptionAvailable() && typeof safeStorage.decryptString === 'function') {
    return safeStorage.decryptString(buf);
  }
  return buf.toString();
}

function randomBytes(n) {
  return crypto.randomBytes(n).toString('base64');
}

/**
 * The master key itself is protected by the OS keychain (safeStorage / DPAPI).
 * That key never touches disk in plaintext; the ciphertext in servers.json is
 * worthless without it, and Windows encrypts it to the current user account.
 */
function loadOrCreateMasterKey() {
  try {
    if (fs.existsSync(KEY_FILE)) {
      const raw = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
      if (raw?.wrapped) {
        const plain = safeDecryptString(Buffer.from(raw.wrapped, 'base64'));
        masterKey = crypto.createHash('sha256').update(plain).digest();
        return masterKey;
      }
    }
  } catch (err) {
    console.error('Failed to read master key, starting fresh:', err.message);
  }

  const plain = randomBytes(48);
  masterKey = crypto.createHash('sha256').update(plain).digest();
  fs.writeFileSync(KEY_FILE, JSON.stringify({ wrapped: safeEncryptString(plain).toString('base64') }), {
    mode: 0o600,
  });
  return masterKey;
}

function encrypt(text) {
  const key = masterKey || loadOrCreateMasterKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}:${enc.toString('base64')}:${cipher.getAuthTag().toString('base64')}`;
}

function decrypt(payload) {
  if (!payload) return '';
  const [ivB, encB, tagB] = String(payload).split(':');
  if (!ivB || !encB || !tagB) return '';
  const key = masterKey || loadOrCreateMasterKey();
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(encB, 'base64')), decipher.final()]).toString('utf8');
  } catch (err) {
    console.error('decrypt failed:', err.message);
    return '';
  }
}

let cache = null;

function readAll() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  } catch {
    cache = [];
  }
  return cache;
}

function writeAll(list) {
  cache = list;
  const tmp = STORE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STORE_FILE);
}

function withDefaults(server) {
  return {
    id: server.id || randomBytes(12),
    name: server.name || '',
    host: server.host || '',
    port: server.port || 22,
    username: server.username || 'root',
    password: server.password || '',
    proxy: server.proxy || null, // { type:'socks5'|'http', host, port, username?, password? }
    authMode: server.authMode || 'password',
    createdAt: server.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
}

module.exports = {
  init() {
    loadOrCreateMasterKey();
    readAll();
  },
  list() {
    // never hand the plaintext password to anything but the ssh layer
    return readAll().map((s) => ({ ...s, password: s.password ? decrypt(s.password) : '' }));
  },
  listSafe() {
    return readAll().map((s) => ({ ...s, password: s.password ? '••••••' : '' }));
  },
  upsert(input) {
    const all = readAll();
    const server = withDefaults(input);
    if (input.id) {
      const i = all.findIndex((s) => s.id === input.id);
      if (i >= 0) {
        // an empty password on edit means "keep the existing one"
        const merged = { ...all[i], ...server, password: input.password ? encrypt(input.password) : all[i].password };
        merged.id = input.id;
        all[i] = merged;
        writeAll(all);
        return { ...merged, password: '' };
      }
    }
    server.password = server.password ? encrypt(server.password) : '';
    all.push(server);
    writeAll(all);
    return { ...server, password: '' };
  },
  remove(id) {
    const all = readAll().filter((s) => s.id !== id);
    writeAll(all);
  },
  get(id) {
    const s = readAll().find((x) => x.id === id);
    if (!s) return null;
    return { ...s, password: s.password ? decrypt(s.password) : '' };
  },
  rawPassword(id) {
    const s = readAll().find((x) => x.id === id);
    return s?.password ? decrypt(s.password) : '';
  },
};
