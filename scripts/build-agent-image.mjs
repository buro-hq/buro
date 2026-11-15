import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
const { stdout } = await exec('codex', ['--version']);
const version = stdout.match(/\b(\d+\.\d+\.\d+)\b/)?.[1];
if (!version) throw Error('Could not determine the installed Codex version.');
const root = fileURLToPath(new URL('../', import.meta.url));
const tag = process.argv[2] || `buro-agent:codex-${version}`;
const { spawn } = await import('node:child_process');
const child = spawn(
  'docker',
  [
    'build',
    '--build-arg',
    `CODEX_VERSION=${version}`,
    '-t',
    tag,
    '-f',
    'tools/environments/Dockerfile.agent',
    'tools/environments',
  ],
  { cwd: root, stdio: 'inherit' },
);
child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
  if (code === 0) console.log(`Agent image ready: ${tag}`);
});
