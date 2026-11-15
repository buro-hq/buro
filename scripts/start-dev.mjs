import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const vite = path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js');
const children = new Set();
let stopping = false;
let killTimer;

function stop(code, signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill(signal);
  killTimer = setTimeout(() => {
    for (const child of children) child.kill('SIGKILL');
  }, 10_000);
  killTimer.unref();
}

process.on('SIGINT', () => stop(130, 'SIGINT'));
process.on('SIGTERM', () => stop(143));

for (const entry of [path.join(root, 'daemon/main.ts'), vite]) {
  const args = entry === vite ? process.argv.slice(2) : [];
  const child = spawn(process.execPath, [entry, ...args], { cwd: root, stdio: 'inherit' });
  children.add(child);
  child.on('error', (error) => {
    console.error(`Could not start ${entry}:`, error.message);
    stop(1);
  });
  child.on('close', (code) => {
    children.delete(child);
    if (!stopping) stop(code ?? 1);
    if (children.size === 0) clearTimeout(killTimer);
  });
}
