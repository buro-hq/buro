import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { RepositoryTools } from '../adapters/tools/repository-tools.ts';
import { EnvironmentExecutors } from '../adapters/environments/executors.ts';
import type { ToolScope } from '../core/model-ports.ts';

async function fixture(t: any) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buro-flexible-')));
  const root = path.join(directory, 'project');
  const workspace = path.join(root, 'work');
  await fs.mkdir(workspace, { recursive: true });
  const executors = new EnvironmentExecutors();
  await executors.register(workspace, root, { provider: 'native' }, new AbortController().signal);
  const tools = new RepositoryTools(executors);
  const scope: ToolScope = {
    projectId: 'p',
    sessionId: 's',
    workspace,
    readOnly: false,
    writeScope: {
      mode: 'advisory',
      plannedPaths: [],
      protectedPaths: ['checks/', 'src/contract.txt'],
    },
    commands: [],
    materials: [],
  };
  let serial = 0;
  const invoke = (name: string, args: Record<string, unknown>) =>
    tools.execute({ id: String(++serial), name, arguments: args }, scope, {
      actionId: String(serial),
      signal: new AbortController().signal,
    });
  t.after(async () => {
    await executors.release(workspace);
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, root, workspace, scope, invoke };
}

test('explicit reads follow internal links and prepared dependencies while general scans skip generated files', async (t) => {
  const f = await fixture(t);
  const dependencies = path.join(f.directory, 'shared-dependencies');
  await fs.mkdir(path.join(dependencies, 'library'), { recursive: true });
  await fs.symlink(dependencies, path.join(f.root, 'node_modules'));
  await fs.writeFile(
    path.join(f.root, 'node_modules/library/index.js'),
    'export const value = 42;',
  );
  await fs.symlink(path.join(f.root, 'node_modules'), path.join(f.workspace, 'node_modules'));
  await fs.writeFile(path.join(f.workspace, 'source.txt'), 'source');
  await fs.symlink(path.join(f.workspace, 'source.txt'), path.join(f.workspace, 'alias.txt'));
  for (const [file, expected] of [
    ['alias.txt', 'source'],
    ['node_modules/library/index.js', 'value = 42'],
  ]) {
    const result = await f.invoke('read_file', { path: file });
    assert.equal(result.isError, undefined, result.content);
    assert.ok(JSON.parse(result.content).text.includes(expected));
  }
  const broad = JSON.parse((await f.invoke('list_files', {})).content);
  assert.ok(!broad.files.some((file: string) => file.includes('node_modules')));
  const direct = await f.invoke('list_files', { path: 'node_modules/library' });
  assert.equal(direct.isError, undefined, direct.content);
  assert.deepEqual(JSON.parse(direct.content).files, ['node_modules/library/index.js']);
  const command = await f.invoke('run_command', { command: 'cat node_modules/library/index.js' });
  assert.equal(command.exitCode, 0, command.content);
  assert.match(JSON.parse(command.content).output, /value = 42/);
  await fs.writeFile(path.join(f.workspace, '.env'), 'PRIVATE');
  await fs.symlink(path.join(f.workspace, '.env'), path.join(f.workspace, 'secret-alias.txt'));
  await fs.writeFile(path.join(f.directory, 'outside'), 'PRIVATE');
  await fs.symlink(path.join(f.directory, 'outside'), path.join(f.workspace, 'outside-alias.txt'));
  for (const file of ['secret-alias.txt', 'outside-alias.txt']) {
    const result = await f.invoke('read_file', { path: file });
    assert.equal(result.isError, true);
    assert.doesNotMatch(result.content, /PRIVATE/);
  }
});

test('large files and long UTF-8 lines can be read completely using explicit continuation cursors', async (t) => {
  const f = await fixture(t);
  const text = 'Первая строка\n' + '🙂'.repeat(180000) + '\n' + 'last\n';
  await fs.writeFile(path.join(f.workspace, 'large.txt'), text);
  let cursor: Record<string, number> = {},
    collected = '',
    pages = 0;
  do {
    const result = await f.invoke('read_file', {
      path: 'large.txt',
      maxChars: 65537,
      lineCount: 300,
      ...cursor,
    });
    assert.equal(result.isError, undefined, result.content);
    const page = JSON.parse(result.content);
    collected += page.text;
    pages++;
    if (!page.truncated) break;
    assert.ok(page.next);
    cursor = page.next;
    assert.ok(pages < 20);
  } while (true);
  assert.ok(pages > 1);
  assert.equal(collected, text);
});

test('unregistered commands run inside the workspace while protected paths, aliases and outside files stay unchanged', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.workspace, 'checks'), { recursive: true });
  await fs.mkdir(path.join(f.workspace, '.git'));
  await fs.mkdir(path.join(f.workspace, 'src'));
  await fs.writeFile(path.join(f.workspace, 'src/contract.txt'), 'original');
  await fs.mkdir(path.join(f.workspace, '.buro/local'), { recursive: true });
  const protectedFile = path.join(f.workspace, 'checks/contract.txt');
  const outside = path.join(f.directory, 'outside.txt');
  const git = path.join(f.workspace, '.git/config');
  const secret = path.join(f.workspace, '.buro/local/private.json');
  const env = path.join(f.workspace, '.env.local');
  for (const file of [protectedFile, outside, git, secret, env])
    await fs.writeFile(file, 'original');
  await fs.symlink(protectedFile, path.join(f.workspace, 'alias.txt'));
  const script = `const fs=require('node:fs');const targets=${JSON.stringify([protectedFile, outside, git, secret, env, path.join(f.workspace, 'alias.txt')])};const results=targets.map(file=>{try{fs.writeFileSync(file,'changed');return 'wrote'}catch{return 'denied'}});fs.writeFileSync('normal.txt','ok');console.log(JSON.stringify(results));`;
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const result = await f.invoke('run_command', {
    command: quote(process.execPath) + ' -e ' + quote(script),
  });
  assert.equal(result.exitCode, 0, result.content);
  assert.deepEqual(JSON.parse(JSON.parse(result.content).output), Array(6).fill('denied'));
  assert.equal(await fs.readFile(path.join(f.workspace, 'normal.txt'), 'utf8'), 'ok');
  for (const file of [protectedFile, outside, git, secret, env])
    assert.equal(await fs.readFile(file, 'utf8'), 'original');
  // Moving a protected directory must not make its contents writable under a new name.
  const move = await f.invoke('run_command', {
    command: 'mv checks moved && printf changed > moved/contract.txt',
  });
  assert.notEqual(move.exitCode, 0, move.content);
  assert.equal(await fs.readFile(protectedFile, 'utf8'), 'original');
  const parentMove = await f.invoke('run_command', {
    command: 'mv src renamed && printf changed > renamed/contract.txt',
  });
  assert.notEqual(parentMove.exitCode, 0, parentMove.content);
  assert.equal(await fs.readFile(path.join(f.workspace, 'src/contract.txt'), 'utf8'), 'original');
});

test('a one-character page still advances over a complete Unicode character', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.workspace, 'unicode.txt'), '🙂x');
  const first = JSON.parse(
    (await f.invoke('read_file', { path: 'unicode.txt', maxChars: 1 })).content,
  );
  assert.equal(first.text, '🙂');
  assert.equal(first.truncated, true);
  const second = JSON.parse(
    (await f.invoke('read_file', { path: 'unicode.txt', maxChars: 1, ...first.next })).content,
  );
  assert.equal(second.text, 'x');
  assert.equal(second.truncated, false);
});
