const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');
const { connectViaProxy } = require('./proxy');
const store = require('./store');

// Each (serverId) owns exactly one connection; in-flight connect calls share
// the same promise so rapid clicks cannot open duplicate channels.
const conns = new Map(); // serverId -> { sftp, conn, sids:Set, connecting:Promise }
const idToServer = new Map(); // sid -> serverId

/** A *session* id maps to an SFTP channel bound to that server. */
function connect(serverId) {
  const existing = conns.get(serverId);
  // reuse a live connection, or an in-flight one, for this server
  if (existing?.sftp) {
    const sid = `ftp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    existing.sids.add(sid);
    idToServer.set(sid, serverId);
    return Promise.resolve(sid);
  }
  if (existing?.connecting) return existing.connecting;

  const server = store.get(serverId);
  if (!server) return Promise.reject(new Error('سرور یافت نشد'));

  const slot = { sftp: null, conn: null, sids: new Set(), connecting: null };
  conns.set(serverId, slot);

  const p = new Promise((resolve, reject) => {
    const conn = new Client();
    slot.conn = conn;
    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) {
          conns.delete(serverId);
          return reject(err);
        }
        slot.sftp = sftp;
        slot.connecting = null;
        const sid = `ftp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        slot.sids.add(sid);
        idToServer.set(sid, serverId);
        resolve(sid);
      });
    });
    // late socket errors (after ready) must not become unhandled rejections
    conn.on('error', (err) => {
      if (!slot.sftp) {
        conns.delete(serverId);
        reject(err);
      }
    });
    conn.on('close', () => {
      for (const sid of [...slot.sids]) idToServer.delete(sid);
      slot.sids.clear();
      slot.sftp = null;
      if (conns.get(serverId) === slot) conns.delete(serverId);
    });

    connectViaProxy(server.host, server.port || 22, server.proxy)
      .then((sock) =>
        conn.connect({
          sock,
          host: server.host,
          port: server.port || 22,
          username: server.username,
          password: server.password,
          readyTimeout: 25000,
          keepaliveInterval: 15000,
        })
      )
      .catch((e) => {
        conns.delete(serverId);
        reject(e);
      });
  });
  slot.connecting = p;
  return p;
}

function getSftp(sid) {
  const serverId = idToServer.get(sid);
  const entry = serverId && conns.get(serverId);
  if (!entry?.sftp) throw new Error('اتصال SFTP برقرار نیست');
  return entry.sftp;
}

function statType(sftp, absPath) {
  return new Promise((resolve) => {
    sftp.lstat(absPath, (err, st) => {
      if (err) return resolve(null);
      resolve(st);
    });
  });
}

async function list(sid, dir) {
  const sftp = getSftp(sid);
  const target = dir || '.';
  const out = { path: target, entries: [], error: null };

  const abs = await new Promise((resolve) => {
    sftp.realpath(target, (err, p) => resolve(err ? target : p));
  });
  out.path = abs;

  const list = await new Promise((resolve) => {
    sftp.readdir(abs, (err, items) => (err ? resolve(null) : resolve(items)));
  });
  if (!list) {
    out.error = 'دسترسی به این مسیر ممکن نیست';
    return out;
  }

  for (const item of list) {
    const attrs = item.attrs;
    out.entries.push({
      name: item.filename,
      isDir: attrs.isDirectory(),
      isSymlink: attrs.isSymbolicLink(),
      size: attrs.size,
      mtime: (attrs.mtime || 0) * 1000,
      mode: attrs.mode,
    });
  }
  out.entries.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name, 'fa'));
  return out;
}

function mkdir(sid, dir) {
  return new Promise((resolve, reject) => {
    getSftp(sid).mkdir(dir, (err) => (err ? reject(err) : resolve(true)));
  });
}

function rename(sid, from, to) {
  return new Promise((resolve, reject) => {
    getSftp(sid).rename(from, to, (err) => (err ? reject(err) : resolve(true)));
  });
}

function deleteSingle(sftp, absPath, isDir) {
  return new Promise((resolve, reject) => {
    if (isDir) sftp.rmdir(absPath, (err) => (err ? reject(err) : resolve()));
    else sftp.unlink(absPath, (err) => (err ? reject(err) : resolve()));
  });
}

async function removeTree(sftp, absPath, isDir) {
  if (!isDir) return deleteSingle(sftp, absPath, false);
  const items = await new Promise((resolve) =>
    sftp.readdir(absPath, (err, l) => resolve(err ? [] : l))
  );
  for (const it of items) {
    const child = path.posix.join(absPath, it.filename);
    await removeTree(sftp, child, it.attrs.isDirectory());
  }
  return deleteSingle(sftp, absPath, true);
}

function deleteSid(sid, target) {
  const sftp = getSftp(sid);
  return statType(sftp, target).then((st) => {
    if (!st) throw new Error('فایل یافت نشد');
    return removeTree(sftp, target, st.isDirectory());
  });
}

function uploadStream(sftp, localPath, remotePath, onProgress) {
  return new Promise((resolve, reject) => {
    const read = fs.createReadStream(localPath);
    const write = sftp.createWriteStream(remotePath);
    let transferred = 0;
    const total = fs.statSync(localPath).size;
    read.on('data', (chunk) => {
      transferred += chunk.length;
      onProgress?.({ transferred, total, done: false });
    });
    write.on('close', () => {
      onProgress?.({ transferred: total, total, done: true });
      resolve(true);
    });
    write.on('error', reject);
    read.on('error', reject);
    read.pipe(write);
  });
}

function downloadStream(sftp, remotePath, localPath, onProgress) {
  return new Promise((resolve, reject) => {
    const read = sftp.createReadStream(remotePath);
    const write = fs.createWriteStream(localPath);
    let transferred = 0;
    sftp.stat(remotePath, (statErr, st) => {
      const total = statErr ? 0 : st.size;
      read.on('data', (chunk) => {
        transferred += chunk.length;
        onProgress?.({ transferred, total, done: false });
      });
      write.on('close', () => {
        onProgress?.({ transferred: total, total, done: true });
        resolve(true);
      });
      write.on('error', reject);
      read.on('error', reject);
      read.pipe(write);
    });
  });
}

function fileExists(sftp, absPath) {
  return new Promise((resolve) => {
    sftp.stat(absPath, (err) => resolve(!err));
  });
}

/** Walks a local directory and returns [files, dirs] with absolute paths. */
function walkLocal(dir, acc = { files: [], dirs: [] }) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      acc.dirs.push(full);
      walkLocal(full, acc);
    } else if (st.isFile()) {
      acc.files.push(full);
    }
  }
  return acc;
}

async function ensureRemoteDir(sftp, remoteDir) {
  const parts = remoteDir.split('/').filter(Boolean);
  let current = remoteDir.startsWith('/') ? '/' : '';
  for (const part of parts) {
    current = path.posix.join(current, part);
    const exists = await fileExists(sftp, current);
    if (!exists) {
      await new Promise((resolve, reject) => {
        sftp.mkdir(current, (err) => (err ? reject(err) : resolve()));
      });
    }
  }
}

/**
 * Upload with recursive folder support. Directories are recreated remotely,
 * files stream with per-chunk progress events.
 */
async function upload(sid, localPath, remoteDir, onProgress) {
  const sftp = getSftp(sid);
  const st = fs.statSync(localPath);
  const baseName = path.basename(localPath);

  if (st.isDirectory()) {
    const remoteBase = path.posix.join(remoteDir, baseName);
    await ensureRemoteDir(sftp, remoteBase);
    const { files, dirs } = walkLocal(localPath);

    for (const dir of dirs) {
      const rel = path.relative(localPath, dir);
      await ensureRemoteDir(sftp, path.posix.join(remoteBase, rel.split(path.sep).join('/')));
    }
    let done = 0;
    for (const file of files) {
      const rel = path.relative(localPath, file).split(path.sep).join('/');
      await uploadStream(sftp, file, path.posix.join(remoteBase, rel), (p) =>
        onProgress?.({ ...p, name: path.basename(file), index: done + 1, total: files.length })
      );
      done++;
    }
    onProgress?.({ done: true, transferred: files.length, total: files.length });
    return true;
  }

  await uploadStream(sftp, localPath, path.posix.join(remoteDir, baseName), (p) =>
    onProgress?.({ ...p, name: baseName })
  );
  return true;
}

async function download(sid, remotePath, localDir, onProgress) {
  const sftp = getSftp(sid);
  const st = await statType(sftp, remotePath);
  if (!st) throw new Error('فایل ریموت یافت نشد');

  const baseName = path.basename(remotePath);
  const localBase = path.join(localDir, baseName);

  if (st.isDirectory()) {
    fs.mkdirSync(localBase, { recursive: true });
    const items = await new Promise((resolve) =>
      sftp.readdir(remotePath, (err, l) => resolve(err ? [] : l))
    );
    for (const it of items) {
      await download(sid, path.posix.join(remotePath, it.filename), localBase, onProgress);
    }
    return true;
  }

  return downloadStream(sftp, remotePath, localBase, (p) => onProgress?.({ ...p, name: baseName }));
}

function close(sid) {
  const serverId = idToServer.get(sid);
  if (!serverId) return;
  const entry = conns.get(serverId);
  idToServer.delete(sid);
  if (!entry) return;
  entry.sids.delete(sid);
  // only tear the connection down when no session references it anymore
  if (entry.sids.size) return;
  try {
    entry.sftp?.end();
  } catch {
    /* noop */
  }
  try {
    entry.conn?.end();
  } catch {
    /* noop */
  }
  conns.delete(serverId);
}

function closeAll() {
  for (const sid of [...idToServer.keys()]) close(sid);
}

module.exports = { connect, list, mkdir, rename, delete: deleteSid, upload, download, close, closeAll };
