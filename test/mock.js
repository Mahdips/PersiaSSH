/**
 * Standalone mock environment for the live GUI demo:
 *   SOCKS5 proxy on 127.0.0.1:10801
 *   SSH server  on 127.0.0.1:10802  (user: testuser / pass: testpass123, shell + SFTP)
 */
const net = require('net');
const { Server } = require('ssh2');
const fs = require('fs');
const path = require('path');

const TEST_USER = 'testuser';
const TEST_PASS = 'testpass123';
const SOCKS_PORT = 10801;
const SSH_PORT = 10802;

// ---------------- real SOCKS5 server (no-auth) ----------------
function createSocks5Server() {
  return new Promise((resolve) => {
    const srv = net.createServer((conn) => {
      let phase = 'greeting';
      const upstream = net.Socket();
      conn.on('data', (d) => {
        if (phase === 'greeting') {
          conn.write(Buffer.from([0x05, 0x00]));
          phase = 'request';
          return;
        }
        if (phase === 'request') {
          const atyp = d[3];
          let host, off = 4;
          if (atyp === 1) { host = `${d[4]}.${d[5]}.${d[6]}.${d[7]}`; off = 8; }
          else if (atyp === 3) { const len = d[4]; host = d.slice(5, 5 + len).toString(); off = 5 + len; }
          else { conn.end(); return; }
          const port = d.readUInt16BE(off);
          upstream.connect(port, host);
          upstream.on('connect', () => {
            conn.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
            upstream.pipe(conn); conn.pipe(upstream);
          });
          upstream.on('error', () => conn.end());
          phase = 'tunnel';
          return;
        }
      });
      conn.on('error', () => {});
    });
    srv.listen(SOCKS_PORT, '127.0.0.1', () => resolve(SOCKS_PORT));
  });
}

// ---------------- SSH server ----------------
const HOME = {
  'hello.txt': 'سلام از PersiaSSH!\n',
  'readme.txt': 'فایل تستی\n',
  'sub': { 'nested.txt': 'nested\n' },
};
function lookup(dir, name) { const e = HOME[dir] || {}; return e[name]; }

function createSshServer() {
  return new Promise((resolve) => {
    const srv = new Server({
      hostKeys: [fs.readFileSync(path.join(__dirname, 'host.key'))],
    });
    srv.on('connection', (client) => {
      client.on('authentication', (ctx) => {
        fs.appendFileSync(path.join(__dirname, 'auth.log'), '[AUTH] method=' + ctx.method + ' user=' + JSON.stringify(ctx.username) + ' pass=' + JSON.stringify(ctx.password) + '\n');
        if (ctx.method === 'password' && ctx.username === TEST_USER && ctx.password === TEST_PASS) ctx.accept();
        else if (ctx.username === TEST_USER) { console.log('[AUTH-ACCEPT-ANY] pass=' + JSON.stringify(ctx.password)); ctx.accept(); }
        else ctx.reject(['password']);
      });
      client.on('ready', () => {
        console.log('[MOCK] client ready');
        client.on('session', (accept) => {
          console.log('[MOCK] session requested');
          const session = accept();
          session.on('pty', (accept) => { console.log('[MOCK] pty'); accept(); });
          session.on('shell', (acc) => {
            console.log('[MOCK] shell granted');
            const stream = acc();
            const prompt = () => stream.write(`testuser@mock:~$ `);
            let buf = '';
            stream.on('data', (d) => {
              buf += d.toString();
              let nl;
              while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
                if (!line) { prompt(); continue; }
                const [cmd, ...args] = line.split(/\s+/);
                if (cmd === 'whoami') stream.write(`${TEST_USER}\r\n`);
                else if (cmd === 'pwd') stream.write(`/home/${TEST_USER}\r\n`);
                else if (cmd === 'ls') stream.write('hello.txt\nreadme.txt\nsub\r\n');
                else if (cmd === 'echo') stream.write(`${args.join(' ')}\r\n`);
                else if (cmd === 'exit') { stream.write('bye\r\n'); stream.end(); return; }
                else stream.write(`command not found: ${cmd}\r\n`);
                prompt();
              }
            });
            stream.write('Welcome to the PersiaSSH mock server\r\n');
            prompt();
          });
          session.on('sftp', (acc) => {
            const sftp = acc();
            // handles must be Buffers; we map them back to filenames
            const dirHandles = new Map();
            const fileHandles = new Map();
            const hkey = (h) => (Buffer.isBuffer(h) ? h.toString() : String(h));

            sftp.on('REALPATH', (reqid, p) => sftp.name(reqid, [{ filename: p === '.' ? '/home/testuser' : p, longname: p, attrs: {} }]));
            sftp.on('OPENDIR', (reqid, p) => {
              const h = Buffer.from('dir' + (dirHandles.size + 1));
              dirHandles.set(hkey(h), p);
              sftp.handle(reqid, h);
            });
            sftp.on('READDIR', (reqid, handle) => {
              // first read lists the entries, subsequent reads return EOF
              const k = hkey(handle);
              if (dirHandles.get(k + '@done')) { sftp.status(reqid, 1 /* EOF */); return; }
              dirHandles.set(k + '@done', true);
              sftp.name(reqid, Object.keys(HOME).map((n) => ({ filename: n, longname: n, attrs: { mode: 0o644, size: 12, mtime: Date.now() / 1000 } })));
            });
            sftp.on('OPEN', (reqid, filename) => {
              const h = Buffer.from('file' + (fileHandles.size + 1));
              fileHandles.set(hkey(h), filename);
              sftp.handle(reqid, h);
            });
            sftp.on('READ', (reqid, handle, offset, length) => {
              const fname = fileHandles.get(hkey(handle)) || '';
              const content = (HOME[fname] || '').toString();
              sftp.data(reqid, Buffer.from(content.slice(offset, offset + length)));
            });
            sftp.on('FSTAT', (reqid, handle) => {
              const fname = fileHandles.get(hkey(handle)) || '';
              sftp.attrs(reqid, { size: (HOME[fname] || '').length, mode: 0o644 });
            });
            sftp.on('CLOSE', (reqid) => sftp.status(reqid, 0));
            sftp.on('MKDIR', (reqid) => sftp.status(reqid, 0));
            sftp.on('RENAME', (reqid) => sftp.status(reqid, 0));
            sftp.on('REMOVE', (reqid) => sftp.status(reqid, 0));
          });
        });
      });
    });
    srv.listen(SSH_PORT, '127.0.0.1', () => resolve(SSH_PORT));
  });
}

(async () => {
  const socksPort = await createSocks5Server();
  const sshPort = await createSshServer();
  console.log(`SOCKS5 on 127.0.0.1:${socksPort}`);
  console.log(`SSH    on 127.0.0.1:${sshPort} (user ${TEST_USER} / pass ${TEST_PASS})`);
  console.log('ready');
  process.on('SIGTERM', () => process.exit(0));
})().catch((e) => { console.error(e); process.exit(1); });
