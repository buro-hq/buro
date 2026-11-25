import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { apiCredential } from '../modules/api/credentials.ts';

/** Opens the local UI with a temporary fragment credential, removed by the browser on startup. */
export async function openUi(input: { directory: string; url?: string }): Promise<void> {
  const url = new URL(input.url ?? 'http://127.0.0.1:4317');
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  )
    throw new Error('The Buro interface must use a local HTTP URL.');

  url.hash = new URLSearchParams({
    'buro-token': await apiCredential({
      directory: input.directory,
    }),
  }).toString();
  const executable =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open';
  try {
    await promisify(execFile)(
      executable,
      [...(process.platform === 'win32' ? ['url.dll,FileProtocolHandler'] : []), url.toString()],
      {
        timeout: 10000,
      },
    );
  } catch {
    throw new Error('The browser could not be opened. Start Buro again to reconnect it.');
  }
}
