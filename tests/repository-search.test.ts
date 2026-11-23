import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { RepositoryTools } from '../adapters/tools/repository-tools.ts';
import { EnvironmentExecutors } from '../adapters/environments/executors.ts';
import type { ToolScope } from '../core/model-ports.ts';

async function fixture(t: any) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buro-search-')));
  const root = path.join(directory, 'repository');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'checks'));
  await fs.writeFile(
    path.join(root, 'src/value.mjs'),
    'export const priority = 0;\n// priority remains zero\n',
  );
  await fs.writeFile(path.join(root, 'checks/value.mjs'), 'assert.equal(priority, 0);\n');
  const executors = new EnvironmentExecutors();
  const tools = new RepositoryTools(executors);
  const scope: ToolScope = {
    projectId: 'p',
    sessionId: 's',
    workspace: root,
    readOnly: true,
    writeScope: { mode: 'strict', plannedPaths: ['src/'], protectedPaths: ['checks/'] },
    materials: [],
    commands: [],
  };
  let serial = 0;
  const search = (file: string, query = 'priority') =>
    tools.execute(
      { id: 'search-' + ++serial, name: 'search_text', arguments: { path: file, query } },
      scope,
      { actionId: 'action-' + serial, signal: new AbortController().signal },
    );
  t.after(async () => {
    await executors.release(root);
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, root, scope, tools, search };
}

test('literal search accepts one repository file and returns exact paths and line numbers in a read-only session', async (t) => {
  const f = await fixture(t);
  const result = await f.search('src/value.mjs');
  assert.equal(result.isError, undefined, result.content);
  assert.deepEqual(JSON.parse(result.content), {
    matches: [
      { path: 'src/value.mjs', line: 1, text: 'export const priority = 0;' },
      { path: 'src/value.mjs', line: 2, text: '// priority remains zero' },
    ],
    truncated: false,
  });
  const absolute = await f.search(path.join(f.root, 'src/value.mjs'), 'priority = 0;');
  assert.equal(absolute.isError, undefined, absolute.content);
  assert.equal(JSON.parse(absolute.content).matches.length, 1);
  const literal = await f.search('src/value.mjs', 'priority.*');
  assert.equal(literal.isError, undefined);
  assert.deepEqual(JSON.parse(literal.content).matches, [], 'The query remains literal.');
});

test('file searches report no matches for unmatched and empty text while directory searches keep their existing results', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'src/empty.mjs'), '');
  for (const [file, query] of [
    ['src/value.mjs', 'missing'],
    ['src/empty.mjs', 'priority'],
  ]) {
    const result = await f.search(file, query);
    assert.equal(result.isError, undefined, result.content);
    assert.deepEqual(JSON.parse(result.content), { matches: [], truncated: false });
  }
  const result = await f.search('src');
  assert.equal(result.isError, undefined, result.content);
  assert.deepEqual(
    JSON.parse(result.content).matches.map((match: any) => [match.path, match.line]),
    [
      ['src/value.mjs', 1],
      ['src/value.mjs', 2],
    ],
  );
});

test('searching a protected file remains readable without granting editing or command permissions', async (t) => {
  const f = await fixture(t);
  const result = await f.search('checks/value.mjs');
  assert.equal(result.isError, undefined, result.content);
  assert.equal(JSON.parse(result.content).matches[0].path, 'checks/value.mjs');
  assert.ok(f.tools.definitions(f.scope).some((tool) => tool.name === 'search_text'));
  assert.ok(
    !f.tools.definitions(f.scope).some((tool) => ['edit_file', 'run_command'].includes(tool.name)),
  );
  const before = await fs.readFile(path.join(f.root, 'checks/value.mjs'), 'utf8');
  const denied = await f.tools.execute(
    {
      id: 'edit',
      name: 'edit_file',
      arguments: { path: 'checks/value.mjs', oldText: 'priority, 0', newText: 'priority, 1' },
    },
    { ...f.scope, readOnly: false },
    { actionId: 'edit', signal: new AbortController().signal },
  );
  assert.equal(denied.isError, true);
  assert.equal(await fs.readFile(path.join(f.root, 'checks/value.mjs'), 'utf8'), before);
});

test('file search rejects secrets and outside symlink targets before reading their content', async (t) => {
  const f = await fixture(t);
  const marker = 'PRIVATE_SEARCH_MARKER';
  await fs.mkdir(path.join(f.root, '.buro/local'), { recursive: true });
  await fs.writeFile(path.join(f.root, '.env'), marker);
  await fs.writeFile(path.join(f.root, '.buro/local/checkpoint.json'), marker);
  await fs.writeFile(path.join(f.directory, 'outside.txt'), marker);
  await fs.symlink(path.join(f.directory, 'outside.txt'), path.join(f.root, 'src/link.txt'));
  await fs.symlink(path.join(f.root, 'src'), path.join(f.root, 'alias'));
  for (const file of [
    '.env',
    '.buro/local/checkpoint.json',
    '../outside.txt',
    path.join(f.directory, 'outside.txt'),
    'src/link.txt',
  ]) {
    const result = await f.search(file, marker);
    assert.equal(result.isError, true, file);
    assert.ok(!result.content.includes(marker), file);
  }
  const directory = await f.search('.', marker);
  assert.equal(directory.isError, undefined, directory.content);
  assert.deepEqual(JSON.parse(directory.content).matches, []);
});

test('direct file search accepts large text while excluding binary files and reporting match limits', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'src/oversized.mjs'), 'priority' + ' '.repeat(256000));
  await fs.writeFile(path.join(f.root, 'src/binary.mjs'), 'priority\0hidden');
  const large = await f.search('src/oversized.mjs');
  assert.equal(large.isError, undefined, large.content);
  assert.equal(JSON.parse(large.content).matches.length, 1);
  for (const file of ['src/binary.mjs']) {
    const result = await f.search(file);
    assert.equal(result.isError, true, file);
    assert.doesNotMatch(result.content, /priority|hidden/);
  }
  await fs.writeFile(
    path.join(f.root, 'src/many.mjs'),
    ('priority ' + 'x'.repeat(1000) + '\n').repeat(60),
  );
  const result = await f.search('src/many.mjs');
  assert.equal(result.isError, undefined, result.content);
  const parsed = JSON.parse(result.content);
  assert.equal(parsed.matches.length, 50);
  assert.equal(parsed.truncated, true);
  assert.ok(parsed.matches.every((match: any) => match.text.length <= 500));
  const directory = await f.search('src');
  assert.equal(directory.isError, undefined, directory.content);
  assert.ok(
    JSON.parse(directory.content).matches.every((match: any) => match.path !== 'src/binary.mjs'),
  );
});
