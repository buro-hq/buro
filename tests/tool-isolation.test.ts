import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EnvironmentExecutors } from '../adapters/environments/executors.ts';
import { RepositoryTools } from '../adapters/tools/repository-tools.ts';
import type { ToolScope } from '../core/model-ports.ts';
const exec = promisify(execFile);
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

async function fixture(t: any) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-tool-isolation-')),
  );
  const root = path.join(directory, 'repository');
  await fs.mkdir(root);
  const executors = new EnvironmentExecutors();
  const tools = new RepositoryTools(executors);
  const scope: ToolScope = {
    projectId: 'p',
    sessionId: 's',
    workspace: root,
    readOnly: true,
    allowedPaths: ['src/'],
    protectedPaths: [],
    materials: [],
    commands: [],
  };
  t.after(async () => {
    await executors.release(root);
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, root, executors, tools, scope };
}

test('read_diff does not execute repository clean/process filters or fsmonitor hooks', async (t) => {
  const f = await fixture(t);
  const git = (args: string[]) => exec('git', args, { cwd: f.root });
  await git(['init', '-b', 'main']);
  await git(['config', 'user.name', 'Test']);
  await git(['config', 'user.email', 'test@example.invalid']);
  await fs.writeFile(path.join(f.root, 'file.txt'), 'before\n');
  await git(['add', 'file.txt']);
  await git(['commit', '-m', 'Initial']);
  const filterMarker = path.join(f.directory, 'filter-executed'),
    monitorMarker = path.join(f.directory, 'monitor-executed');
  const filter = path.join(f.directory, 'filter.sh'),
    monitor = path.join(f.directory, 'monitor.sh');
  await fs.writeFile(filter, '#!/bin/sh\nprintf touched > ' + quote(filterMarker) + '\ncat\n', {
    mode: 0o755,
  });
  await fs.writeFile(
    monitor,
    '#!/bin/sh\nprintf touched > ' + quote(monitorMarker) + '\nprintf "\\0"\n',
    { mode: 0o755 },
  );
  await git(['config', 'filter.sideeffect.clean', quote(filter)]);
  await git(['config', 'filter.sideeffect.process', quote(filter)]);
  await git(['config', 'filter.sideeffect.required', 'true']);
  await git(['config', 'core.fsmonitor', monitor]);
  await fs.writeFile(path.join(f.root, '.gitattributes'), '*.txt filter=sideeffect\n');
  await fs.writeFile(path.join(f.root, 'file.txt'), 'after\n');
  const result = await f.tools.execute({ id: 'diff', name: 'read_diff', arguments: {} }, f.scope, {
    actionId: 'action',
    signal: new AbortController().signal,
  });
  assert.equal(result.isError, undefined, result.content);
  assert.match(result.content, /-before/);
  assert.match(result.content, /\+after/);
  await assert.rejects(fs.stat(filterMarker), { code: 'ENOENT' });
  await assert.rejects(fs.stat(monitorMarker), { code: 'ENOENT' });
});

test('read-only process confinement denies writes even inside the inspected repository', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, '.buro/local'), { recursive: true });
  const secret = path.join(f.root, '.buro/local/secret');
  await fs.writeFile(secret, 'PRIVATE_READ_ONLY_SECRET');
  const targets = [path.join(f.root, 'inside'), path.join(f.directory, 'outside')];
  const script = `const fs=require('node:fs');const writes=${JSON.stringify(targets)}.map(p=>{try{fs.writeFileSync(p,'bad');return 'wrote'}catch{return 'denied'}});let privateRead;try{privateRead=fs.readFileSync(${JSON.stringify(secret)},'utf8')}catch{privateRead='denied'}console.log(JSON.stringify({writes,privateRead}));`;
  const launch = f.executors.launchReadOnly(f.root, [process.execPath, '-e', script]);
  const result = await exec(launch.executable, launch.args, { cwd: launch.cwd, env: launch.env });
  assert.deepEqual(JSON.parse(result.stdout), {
    writes: ['denied', 'denied'],
    privateRead: 'denied',
  });
  for (const target of targets) await assert.rejects(fs.stat(target), { code: 'ENOENT' });
});

test('managed check commands cannot read private checkpoints or host siblings and keep workspace writes', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, '.buro/local'), { recursive: true });
  const checkpoint = path.join(f.root, '.buro/local/private-checkpoint.json'),
    hostSecret = path.join(f.directory, 'host-secret'),
    envFile = path.join(f.root, '.env.local');
  await fs.writeFile(checkpoint, 'PRIVATE_CHECKPOINT');
  await fs.writeFile(hostSecret, 'HOST_SECRET');
  await fs.writeFile(envFile, 'SOURCE_ENV_SECRET');
  await f.executors.register(f.root, f.root, { provider: 'native' }, new AbortController().signal, {
    privateDataIsolation: true,
  });
  const cacheFile = path.join(f.executors.get(f.root)!.cacheRoot, 'artifact.txt');
  const script = `const fs=require('node:fs');const reads=${JSON.stringify([checkpoint, hostSecret, envFile])}.map(p=>{try{return fs.readFileSync(p,'utf8')}catch{return 'denied'}});fs.writeFileSync('generated.txt','ok');fs.writeFileSync(${JSON.stringify(cacheFile)},'artifact');reads.push(fs.readFileSync(${JSON.stringify(cacheFile)},'utf8'));console.log(JSON.stringify(reads));`;
  const command = quote(process.execPath) + ' -e ' + quote(script);
  f.scope.readOnly = false;
  f.scope.commands = [{ id: 'check', command, timeoutMs: 10000 }];
  const result = await f.tools.execute(
    { id: 'check', name: 'run_command', arguments: { command } },
    f.scope,
    { actionId: 'a', signal: new AbortController().signal },
  );
  assert.equal(result.exitCode, 0, result.content);
  const observed = JSON.parse(result.content);
  assert.deepEqual(JSON.parse(observed.output), ['denied', 'denied', 'denied', 'artifact']);
  assert.doesNotMatch(result.content, /PRIVATE_CHECKPOINT|HOST_SECRET|SOURCE_ENV_SECRET/);
  assert.equal(await fs.readFile(path.join(f.root, 'generated.txt'), 'utf8'), 'ok');
});

test('managed commands deny network while explicitly authorized setup can use it', async (t) => {
  const f = await fixture(t);
  const server = net.createServer((socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as net.AddressInfo).port;
  await f.executors.register(f.root, f.root, { provider: 'native' }, new AbortController().signal, {
    privateDataIsolation: true,
  });
  const script = `const s=require('node:net').connect(${port},'127.0.0.1');s.on('connect',()=>{console.log('connected');s.end()});s.on('error',()=>console.log('denied'));`;
  const run = async (allowNetwork: boolean) => {
    const launch = f.executors.launch(f.root, [process.execPath, '-e', script], { allowNetwork });
    return (
      await exec(launch.executable, launch.args, {
        cwd: launch.cwd,
        env: launch.env,
        timeout: 10000,
      })
    ).stdout.trim();
  };
  assert.equal(await run(false), 'denied');
  assert.equal(await run(true), 'connected');
});

test('managed Docker preparation fails before credentials or a container are touched', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const executors = new EnvironmentExecutors(async () => {
    calls++;
    throw Error('Unexpected Docker call');
  });
  await assert.rejects(
    executors.register(
      f.root,
      f.root,
      { provider: 'docker', image: 'fixture' },
      new AbortController().signal,
      { privateDataIsolation: true },
    ),
    { code: 'ENVIRONMENT_UNAVAILABLE' },
  );
  assert.equal(calls, 0);
  await assert.rejects(fs.stat(path.join(f.root, '.buro')), { code: 'ENOENT' });
});
