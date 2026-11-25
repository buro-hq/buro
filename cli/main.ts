import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiClient } from '../modules/api/client.ts';
import { apiCredential } from '../modules/api/credentials.ts';
import { FeatureCli } from './feature-cli.ts';
import { openUi } from './open-ui.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  directory = path.resolve(process.env.PROJECT_DATA_DIR ?? path.join(root, '.buro'));
const [method = 'status', argument] = process.argv.slice(2);
const help = `Buro CLI
  status
  open
  watch RUN_ID
  METHOD [JSON | @FILE | -]

Examples:
  projects.list
  projects.connect '{"root":"/path/to/project"}'
  tasks.create @task.json
  models.discover @connection.json
  models.save @connection.json
  runs.start '{"taskId":"TASK_ID"}'
  runs.retry '{"id":"RUN_ID"}'
  results.inspect '{"runId":"RUN_ID"}'
  results.apply '{"runId":"RUN_ID"}'

The UI and CLI use the same API methods. Use @FILE or stdin for credentials.
PROJECT_DATA_DIR and PROJECT_DAEMON_URL select the local service.
`;
let client: ApiClient | undefined;
try {
  if (['help', '--help', '-h'].includes(method)) console.log(help);
  else if (method === 'open') await openUi({ directory, url: process.env.BURO_UI_URL });
  else {
    client = new ApiClient({
      url: process.env.PROJECT_DAEMON_URL,
      token: await apiCredential({ directory }),
    });
    const controller = new AbortController(),
      cancel = () => {
        controller.abort();
        client?.close();
      };
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    const cli = new FeatureCli({
      client,
      observe: (notice) => console.error(JSON.stringify(notice)),
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        client.connect(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Buro is unavailable. Run npm start.')), 4000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    let result: unknown;
    if (method === 'watch') {
      if (!argument) throw new Error('Use watch RUN_ID.');
      result = await cli.watch({ id: argument, signal: controller.signal });
    } else {
      let text = argument ?? '{}';
      if (text.startsWith('@')) text = await fs.readFile(text.slice(1), 'utf8');
      else if (text === '-') {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
        text = Buffer.concat(chunks).toString('utf8');
      }
      result = await cli.call({ method, params: JSON.parse(text) });
    }
    console.log(JSON.stringify(result ?? null, null, 2));
    if (result && typeof result === 'object' && 'ok' in result && result.ok === false)
      process.exitCode = 1;
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  client?.close();
}
