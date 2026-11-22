import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBuroApplication } from './application.ts';
import { websocketPlugin } from './websocket.ts';
import { migrateProjectDirectory } from '../adapters/files/project-directory.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PROJECT_DAEMON_PORT || 4341);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('Invalid daemon port.');
if (!process.env.PROJECT_DATA_DIR) await migrateProjectDirectory(root);
const directory = process.env.PROJECT_DATA_DIR || path.join(root, '.buro');
const host = await createBuroApplication({ root, directory, demo: process.env.BURO_DEMO === '1' });
try {
  await host.ctx.plugin(websocketPlugin, {
    port,
    onListen: (p) => console.log(`Buro daemon: ws://127.0.0.1:${p} · data: ${directory}`),
  });
} catch (error) {
  await host.dispose().catch(() => {});
  throw error;
}
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await host.dispose();
}
process.on('SIGINT', () => void stop().then(() => process.exit(0)));
process.on('SIGTERM', () => void stop().then(() => process.exit(0)));
