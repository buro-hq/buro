import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { openUi } from '../cli/open-ui.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.resolve(process.env.PROJECT_DATA_DIR ?? path.join(root, '.buro'));
let frontend;
let daemon;
let stopping;
const stop = (code = 0) => (stopping ??= (async () => {
  process.exitCode = code;
  const exited =
    daemon && daemon.exitCode === null
      ? new Promise((resolve) => daemon.once('close', resolve))
      : Promise.resolve();
  daemon?.kill('SIGTERM');
  const timer = setTimeout(() => daemon?.kill('SIGKILL'), 10000);
  timer.unref();
  try {
    await Promise.all([frontend?.close(), exited]);
  } finally {
    clearTimeout(timer);
  }
})());
process.once('SIGINT', () => void stop(130));
process.once('SIGTERM', () => void stop(143));
try {
  daemon = spawn(process.execPath, [path.join(root, 'daemon/main.ts')], {
    cwd: root,
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  });
  const ready = new Promise((resolve, reject) => {
    daemon.once('error', reject);
    daemon.on('message', (message) => {
      if (message?.type === 'buro.ready')
        resolve(message);
    });
    daemon.once('close', (code) => {
      reject(new Error('Buro service exited during startup.'));
      if (!stopping)
        void stop(code ?? 1);
    });
  });
  const address = await ready;
  if (!stopping) {
    process.env.VITE_BURO_API_URL = `ws://127.0.0.1:${address.port}`;
    frontend = await createServer({
      root,
      cacheDir: path.join(directory, 'cache/vite'),
      server: {
        host: '127.0.0.1',
        port: Number(process.env.BURO_UI_PORT ?? 4317),
        strictPort: true,
        open: false,
      },
    });
    await frontend.listen();
    const url = frontend.resolvedUrls.local[0];
    console.log(`Buro: ${url}`);
    if (process.env.BURO_OPEN_BROWSER !== '0')
      await openUi({
        directory,
        url,
      }).catch(() =>
        console.error('Could not open the browser. Run npm run cli -- open.'));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  await stop(1);
}
