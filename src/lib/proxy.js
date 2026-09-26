const net = require('net');
const http = require('http');
const { SocksClient } = require('socks');

/**
 * Returns a net.Socket already tunneled through the configured proxy.
 * `proxy` shape: { type:'socks5'|'http', host, port, username?, password? }
 * No proxy -> direct TCP. Errors surface via the returned promise.
 */
function connectViaProxy(targetHost, targetPort, proxy, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    if (!proxy || !proxy.host || !proxy.port) {
      const socket = net.connect({ host: targetHost, port: targetPort });
      const t = setTimeout(() => socket.destroy(new Error('اتصال مستقیم ناموفق بود (timeout)')), timeoutMs);
      socket.once('connect', () => {
        clearTimeout(t);
        resolve(socket);
      });
      socket.once('error', (err) => {
        clearTimeout(t);
        reject(err);
      });
      return;
    }

    if (proxy.type === 'socks5' || proxy.type === 'socks4') {
      SocksClient.createConnection({
        proxy: {
          host: proxy.host,
          port: Number(proxy.port),
          type: proxy.type === 'socks4' ? 4 : 5,
          ...(proxy.username ? { userId: proxy.username, password: proxy.password || '' } : {}),
        },
        command: 'connect',
        destination: { host: targetHost, port: Number(targetPort) },
        timeout: timeoutMs,
      })
        .then((info) => resolve(info.socket))
        .catch((err) => reject(err));
      return;
    }

    // HTTP CONNECT — implemented on a raw net.Socket rather than http.request.
    // A socket handed back by http.request has an internal HTTP parser attached
    // to it, and ssh2's transport does not handshake reliably over it.
    const socket = net.connect(Number(proxy.port), proxy.host);
    let connected = false;
    let buffer = Buffer.alloc(0);
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    let settled = false;
    const timer = setTimeout(() => {
      socket.destroy();
      finish(() => reject(new Error('پراکسی HTTP تایم‌اوت شد')));
    }, timeoutMs);

    socket.on('connect', () => {
      let reqLine = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n`;
      if (proxy.username) {
        const cred = Buffer.from(`${proxy.username}:${proxy.password || ''}`).toString('base64');
        reqLine += `Proxy-Authorization: Basic ${cred}\r\n`;
      }
      reqLine += '\r\n';
      socket.write(reqLine);
    });

    socket.on('data', (chunk) => {
      if (connected) return; // anything after the response head belongs to SSH
      buffer = Buffer.concat([buffer, chunk]);
      const sep = buffer.indexOf('\r\n\r\n');
      if (sep === -1) return;
      const head = buffer.slice(0, sep).toString('latin1');
      const status = parseInt(head.split('\r\n')[0].split(' ')[1], 10);
      const leftover = buffer.slice(sep + 4);
      connected = true;
      clearTimeout(timer);
      if (status !== 200) {
        socket.destroy();
        return reject(new Error(`پراکسی HTTP پاسخ ${status} داد`));
      }
      // anything after the response head already belongs to the SSH protocol.
      // The server's identification banner often lands in that same chunk, so
      // push it back into the readable buffer — emitting it directly would
      // drop it, since ssh2 has not attached its data listener yet.
      socket.removeAllListeners('data');
      socket.pause();
      if (leftover.length) socket.unshift(leftover);
      finish(() => resolve(socket));
    });

    socket.on('error', (err) => {
      clearTimeout(timer);
      if (!connected) reject(err);
    });
  });
}

module.exports = { connectViaProxy };
