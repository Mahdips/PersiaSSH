// Keeps the mock server alive: respawns it if it dies
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');

const MOCK = path.join(__dirname, 'mock.js');
const SOCKS_PORT = 10801;
const SSH_PORT = 10802;

function isUp(port) {
  return new Promise((res) => {
    const s = net.connect(port, '127.0.0.1');
    s.setTimeout(500);
    s.on('connect', () => { s.destroy(); res(true); });
    s.on('timeout', () => { s.destroy(); res(false); });
    s.on('error', () => res(false));
  });
}

async function waitForBoot(proc, ms = 4000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await isUp(SSH_PORT) && await isUp(SOCKS_PORT)) return true; // eslint-disable-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 250)); // eslint-disable-line no-await-in-loop
  }
  return false;
}

(async () => {
  for (;;) {
    if (!(await isUp(SSH_PORT)) || !(await isUp(SOCKS_PORT))) {
      console.log(`[watchdog] mock down, starting ${MOCK}`);
      const proc = spawn(process.execPath, [MOCK], { stdio: 'ignore', detached: false });
      proc.on('exit', (code) => console.log(`[watchdog] mock exited code=${code}`));
      const ok = await waitForBoot(proc);
      console.log(`[watchdog] boot ${ok ? 'OK' : 'FAILED'}`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
})().catch((e) => { console.error(e); process.exit(1); });
