/**
 * Runs the full integration suite: SOCKS5+SSH+shell, then HTTP-CONNECT+SFTP.
 * Both spin up real mock servers, so nothing is stubbed except the topology.
 */
const { spawnSync } = require('child_process');
const path = require('path');

const tests = ['stack_test.js', 'sftp_test.js'];
let failed = 0;

for (const t of tests) {
  console.log(`\n=== ${t} ===`);
  const res = spawnSync(process.execPath, [path.join(__dirname, t)], {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit',
    timeout: 45000,
  });
  if (res.status !== 0) {
    failed++;
    console.log(`[FAIL] ${t} exited ${res.status}`);
  }
}

console.log(`\n${failed === 0 ? 'ALL TESTS PASSED' : failed + ' TEST(S) FAILED'}`);
process.exit(failed === 0 ? 0 : 1);
