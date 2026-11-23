import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RepositoryTools } from '../adapters/tools/repository-tools.ts';
import type { EnvironmentExecutors } from '../adapters/environments/executors.ts';
import type { ToolScope } from '../core/model-ports.ts';

async function fixture(t: any) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buro-broker-scope-')));
  await fs.mkdir(path.join(root, 'src'));
  await fs.mkdir(path.join(root, 'checks'));
  await fs.writeFile(path.join(root, 'src/main.ts'), 'main');
  await fs.writeFile(path.join(root, 'src/adjacent.ts'), 'adjacent');
  await fs.writeFile(path.join(root, 'checks/contract.ts'), 'protected');
  const marker = path.join(root, 'command-child-marker');
  let launches = 0;
  const tools = new RepositoryTools({
    dependencyReadRoots: () => [],
    launch() {
      launches++;
      throw Error('A strict command must never be launched');
    },
  } as unknown as EnvironmentExecutors);
  const scope: ToolScope = {
    projectId: 'p',
    sessionId: 's',
    workspace: root,
    readOnly: false,
    writeScope: { mode: 'advisory', plannedPaths: ['src/main.ts'], protectedPaths: ['checks/'] },
    materials: [],
    commands: [
      {
        id: 'check',
        command: `${process.execPath} -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed')`)}`,
        timeoutMs: 1000,
      },
    ],
  };
  let serial = 0;
  const call = (name: string, args: unknown) =>
    tools.execute({ id: 'call-' + ++serial, name, arguments: args }, scope, {
      actionId: 'action-' + serial,
      signal: new AbortController().signal,
    });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, scope, tools, call, marker, launches: () => launches };
}

test('advisory plans permit adjacent edits and empty-plan work while hard protections remain active', async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await f.call('edit_file', {
        path: 'src/adjacent.ts',
        oldText: 'adjacent',
        newText: 'updated',
      })
    ).isError,
    undefined,
  );
  assert.equal(await fs.readFile(path.join(f.root, 'src/adjacent.ts'), 'utf8'), 'updated');
  f.scope.writeScope.plannedPaths = [];
  assert.ok(f.tools.definitions(f.scope).some((tool) => tool.name === 'edit_file'));
  assert.equal(
    (await f.call('edit_file', { path: 'docs/new.md', oldText: '', newText: 'created' })).isError,
    undefined,
  );
  for (const denied of ['checks/contract.ts', '.env', '.git/config', '../escape'])
    assert.equal(
      (await f.call('edit_file', { path: denied, oldText: '', newText: 'unsafe' })).isError,
      true,
    );
  assert.equal(await fs.readFile(path.join(f.root, 'checks/contract.ts'), 'utf8'), 'protected');
});

test('strict brokers reject out-of-plan edits and candidate commands before launching any child', async (t) => {
  const f = await fixture(t);
  f.scope.writeScope.mode = 'strict';
  const definitions = f.tools.definitions(f.scope);
  assert.ok(definitions.some((tool) => tool.name === 'edit_file'));
  assert.ok(!definitions.some((tool) => tool.name === 'run_command'));
  assert.equal(
    (await f.call('edit_file', { path: 'src/adjacent.ts', oldText: 'adjacent', newText: 'unsafe' }))
      .isError,
    true,
  );
  assert.equal(await fs.readFile(path.join(f.root, 'src/adjacent.ts'), 'utf8'), 'adjacent');
  const denied = await f.call('run_command', { command: f.scope.commands[0].command });
  assert.equal(denied.isError, true);
  assert.match(denied.content, /Strict scope/);
  assert.equal(f.launches(), 0);
  await assert.rejects(fs.stat(f.marker), { code: 'ENOENT' });
  assert.equal(
    (await f.call('edit_file', { path: 'src/main.ts', oldText: 'main', newText: 'allowed' }))
      .isError,
    undefined,
  );
});

test('read-only sessions keep their unconditional write prohibition in both scope modes', async (t) => {
  const f = await fixture(t);
  f.scope.readOnly = true;
  for (const mode of ['advisory', 'strict'] as const) {
    f.scope.writeScope.mode = mode;
    assert.ok(
      f.tools
        .definitions(f.scope)
        .every((tool) => !['edit_file', 'run_command'].includes(tool.name)),
    );
    assert.equal(
      (await f.call('edit_file', { path: 'src/main.ts', oldText: 'main', newText: 'unsafe' }))
        .isError,
      true,
    );
    assert.equal(
      (await f.call('run_command', { command: f.scope.commands[0].command })).isError,
      true,
    );
  }
  assert.equal(await fs.readFile(path.join(f.root, 'src/main.ts'), 'utf8'), 'main');
  assert.equal(f.launches(), 0);
});
