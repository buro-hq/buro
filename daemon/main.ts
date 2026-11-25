import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApplication } from '../modules/application/create-application.ts';
import { startApiServer } from '../modules/api/server.ts';
import { apiCredential } from '../modules/api/credentials.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PROJECT_DAEMON_PORT ?? 4341);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid daemon port.');
const directory = path.resolve(process.env.PROJECT_DATA_DIR ?? path.join(root, '.buro'));
const report = (error: unknown) => console.error(error);
const application = await createApplication({ directory, report });
let server: Awaited<ReturnType<typeof startApiServer>>;
try {
  server = await startApiServer({
    application,
    token: await apiCredential({ directory }),
    port,
    report,
    onClosing: () => application.stopWork(),
  });
} catch (error) {
  await application.close();
  throw error;
}
console.log(`Buro daemon: ws://127.0.0.1:${server.port}`);
process.send?.({ type: 'buro.ready', port: server.port });
let stopping: Promise<void> | undefined;
function stop(): Promise<void> {
  return (stopping ??= (async () => {
    try {
      await server.close();
    } finally {
      await application.close();
    }
  })());
}
const shutdown = () =>
  void stop().then(
    () => process.exit(0),
    (error) => {
      report(error);
      process.exit(1);
    },
  );
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
