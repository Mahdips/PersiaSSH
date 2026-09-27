/**
 * Copies the xterm/addon-fit browser bundles into renderer/vendor so the
 * packaged app does not depend on devDependencies surviving the install.
 * Run by `postinstall`; harmless when packages are missing.
 */
const fs = require('fs');
const path = require('path');

const pairs = [
  ['@xterm/xterm/lib/xterm.js', 'renderer/vendor/xterm/xterm.js'],
  ['@xterm/xterm/css/xterm.css', 'renderer/vendor/xterm/xterm.css'],
  ['@xterm/addon-fit/lib/addon-fit.js', 'renderer/vendor/addon-fit/addon-fit.js'],
];

const root = path.join(__dirname, '..');
let ok = 0, skip = 0;

for (const [src, dst] of pairs) {
  const from = path.join(root, 'node_modules', src);
  const to = path.join(root, dst);
  try {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    ok++;
  } catch {
    skip++;
  }
}

console.log(`[sync-vendor] copied ${ok}, skipped ${skip}`);
