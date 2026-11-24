import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { SandboxedCommands } from '../modules/commands/sandboxed-commands.ts';

test(
  'workspace commands preserve Git metadata and cannot signal or inspect an unrelated host process',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-command-boundary-'));
    const commands = new SandboxedCommands();
    const marker = 'private-test-process-value';
    const canary = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      env: { BURO_TEST_CANARY: marker },
      stdio: 'ignore',
    });
    await once(canary, 'spawn');
    t.after(async () => {
      await commands.close();
      if (canary.exitCode === null && canary.signalCode === null) {
        canary.kill('SIGKILL');
        await once(canary, 'close');
      }
      await fs.rm(directory, { recursive: true, force: true });
    });
    const signal = new AbortController().signal;
    const healthy = await commands.run({
      workspace: directory,
      argv: [process.execPath, '-e', 'process.stdout.write("probe-ok")'],
      signal,
    });
    assert.equal(healthy.exitCode, 0);
    assert.equal(healthy.stdout, 'probe-ok');
    const result = await commands.run({
      workspace: directory,
      signal,
      argv: [
        process.execPath,
        '-e',
        `try { process.kill(${canary.pid}, 'SIGTERM'); process.stdout.write('allowed'); } catch (error) { if (error.code !== 'EPERM') throw error; process.stdout.write('blocked'); }`,
      ],
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'blocked');
    assert.equal(canary.signalCode, null);
    const info = await commands.run({
      workspace: directory,
      argv: ['/bin/ps', 'eww', '-p', String(canary.pid)],
      readOnly: true,
      signal,
    });
    assert.ok(!info.stdout.includes(marker));
    await fs.writeFile(path.join(directory, '.git'), 'original-git-control-data');
    const changed = await commands.run({
      workspace: directory,
      argv: ['/bin/sh', '-c', 'printf bad > .git'],
      signal,
    });
    assert.notEqual(changed.exitCode, 0);
    assert.equal(
      await fs.readFile(path.join(directory, '.git'), 'utf8'),
      'original-git-control-data',
    );
  },
);
