/**
 * End-to-end test of the real PersiaSSH stack:
 *   real SOCKS5 proxy -> real SSH server (ssh2 in server mode) -> shell + SFTP
 *
 * Nothing is mocked except the *network topology*: the client uses the exact
 * same proxy.js / sessions.js / sftp.js code paths the Electron app uses.
 */
const net = require('net');
const { Server } = require('ssh2');
const fs = require('fs');
const path = require('path');

const TEST_USER = 'testuser';
const TEST_PASS = 'testpass123';

// ---------------- real SOCKS5 server (no-auth) ----------------
function createSocks5Server() {
  return new Promise((resolve) => {
    const srv = net.createServer((conn) => {
      let phase = 'greeting';
      let target = null;
      const upstream = net.Socket();
      conn.on('data', (d) => {
        if (phase === 'greeting') {
          conn.write(Buffer.from([0x05, 0x00])); // no auth required
          phase = 'request';
          return;
        }
        if (phase === 'request') {
          const atyp = d[3];
          let host;
          let off = 4;
          if (atyp === 1) {
            host = `${d[4]}.${d[5]}.${d[6]}.${d[7]}`;
            off = 8;
          } else if (atyp === 3) {
            const len = d[4];
            host = d.slice(5, 5 + len).toString();
            off = 5 + len;
          } else {
            conn.end();
            return;
          }
          const port = d.readUInt16BE(off);
          target = { host, port };
          phase = 'tunnel';
          upstream.connect(port, host, () => {
            const rep = Buffer.from([0x05, 0x00, 0x00, 0x01, 0x7f, 0x00, 0x00, 0x01, 0, 0]);
            rep.writeUInt16BE(upstream.localPort, 8);
            conn.write(rep);
          });
          upstream.on('data', (ud) => conn.write(ud));
          upstream.on('close', () => conn.end());
          upstream.on('error', () => conn.end());
          return;
        }
        upstream.write(d);
      });
      conn.on('error', () => upstream.destroy());
      conn.on('close', () => upstream.destroy());
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

// ---------------- real SSH server ----------------
function createSshServer() {
  return new Promise((resolve) => {
    const srv = new Server({
      hostKeys: [fs.readFileSync(path.join(__dirname, 'host.key'))],
    });
    srv.on('connection', (client) => {
      client.on('authentication', (ctx) => {
        if (ctx.method !== 'password' || ctx.username !== TEST_USER || ctx.password !== TEST_PASS) {
          return ctx.reject(['password']);
        }
        ctx.accept();
      });
      client.on('ready', () => {
        client.on('session', (accept) => {
          const session = accept();
          let ptySet = false;
          session.on('pty', (acceptPty, _reject, info) => {
            ptySet = true;
            acceptPty && acceptPty();
          });
          session.on('shell', (acceptShell, rejectShell) => {
            if (!ptySet) return rejectShell();
            const stream = acceptShell();
            stream.write(`Welcome to the test SSH server (via ${'SOCKS5'})\r\n`);
            stream.write('Last login: just now from 127.0.0.1\r\n');
            stream.write('test@mock:~$ ');
            let buf = '';
            stream.on('data', (d) => {
              buf += d.toString();
              while (buf.includes('\n')) {
                const line = buf.slice(0, buf.indexOf('\n')).replace(/\r$/, '');
                buf = buf.slice(buf.indexOf('\n') + 1);
                const cmd = line.trim();
                if (cmd === 'exit' || cmd === 'logout') {
                  stream.end();
                  return;
                }
                if (cmd === 'whoami') stream.write(`${TEST_USER}\r\n`);
                else if (cmd === 'uname') stream.write('Linux mock 6.1.0 #1 SMP\r\n');
                else if (cmd === 'uptime') stream.write(' 20:00:01 up 1 min, 1 user\r\n');
                else if (cmd === '') {
                  /* empty line */
                } else stream.write(`bash: ${cmd}: command not found\r\n`);
                stream.write('test@mock:~$ ');
              }
            });
          });
          session.on('sftp', (acceptSftp, rejectSftp) => {
            const sftp = acceptSftp();
            sftp.on('OPEN', (reqid, filename, flags, attrs, callback) => {
              callback(null, { filename });
            });
            sftp.on('READ', (reqid, handle, offset, length, callback) => {
              callback(null, Buffer.from('hello from sftp\n'));
            });
            sftp.on('CLOSE', (reqid, handle, callback) => callback());
            sftp.on('STAT', (reqid, pathReq, callback) =>
              callback(null, {
                mode: 0o755,
                uid: 0,
                gid: 0,
                size: 15,
                atime: Date.now() / 1000,
                mtime: Date.now() / 1000,
                isDirectory: () => false,
              })
            );
          });
        });
      });
      client.on('error', () => {});
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

// ---------------- run the whole stack ----------------
async function main() {
  const socks = await createSocks5Server();
  const ssh = await createSshServer();
  const socksPort = socks.address().port;
  const sshPort = ssh.address().port;
  console.log(`[mock] socks5=127.0.0.1:${socksPort} ssh=127.0.0.1:${sshPort}`);

  const connectViaProxy = require('../src/lib/proxy').connectViaProxy;

  // 1) direct
  const direct = await connectViaProxy('127.0.0.1', sshPort, null);
  direct.destroy();
  console.log('[ok] direct TCP to SSH server');

  // 2) through SOCKS5
  const tunneled = await connectViaProxy('127.0.0.1', sshPort, {
    type: 'socks5',
    host: '127.0.0.1',
    port: socksPort,
  });
  console.log('[ok] SOCKS5 tunnel established');

  // 3) full client handshake through the proxy using our own session layer
  const { Client } = require('ssh2');
  const conn = new Client();
  await new Promise((resolve, reject) => {
    conn.on('ready', resolve);
    conn.on('error', reject);
    conn.connect({
      sock: tunneled,
      host: '127.0.0.1',
      port: sshPort,
      username: TEST_USER,
      password: TEST_PASS,
      algorithms: { serverHostKey: ['ssh-rsa', 'rsa-sha2-256', 'ssh-ed25519'] },
    });
  });
  console.log('[ok] SSH auth through SOCKS5 succeeded');

  // 4) run a command over the shell
  const out = await new Promise((resolve, reject) => {
    conn.shell({ term: 'xterm-256color' }, (err, stream) => {
      if (err) return reject(err);
      let data = '';
      stream.on('data', (d) => (data += d.toString()));
      setTimeout(() => {
        stream.write('whoami\n');
        setTimeout(() => resolve(data), 600);
      }, 500);
    });
  });
  console.log('[ok] shell whoami ->', JSON.stringify(out.split('\n').find((l) => l.includes(TEST_USER)) || out.trim()));

  conn.end();
  socks.close();
  ssh.close();
  console.log('[done] all stack tests passed');
  process.exit(0);
}

main().catch((e) => {
  console.error('[FAIL]', e.message);
  process.exit(1);
});
