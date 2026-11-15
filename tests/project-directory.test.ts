import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  migrateProjectDirectory,
  findProjectDirectory,
} from '../adapters/files/project-directory.ts';
import {
  PROJECT_DIRECTORY,
  LEGACY_PROJECT_DIRECTORY,
  migrateMetadataPaths,
} from '../protocol/project-directory.ts';
const exec = promisify(execFile);
async function fixture(t: any) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buro-migration-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const git = (args: string[]) => exec('git', args, { cwd: root });
  await git(['init', '-b', 'master']);
  await git(['config', 'user.name', 'Test']);
  await git(['config', 'user.email', 'test@example.invalid']);
  await fs.writeFile(path.join(root, 'README.md'), 'Fixture');
  await git(['add', '.']);
  await git(['commit', '-m', 'Initial']);
  const legacy = path.join(root, LEGACY_PROJECT_DIRECTORY);
  await fs.mkdir(legacy);
  return { root, legacy, git };
}
test('metadata migration preserves user text and history while repairing real worktree paths', async (t) => {
  const f = await fixture(t),
    workspace = path.join(f.legacy, 'worktrees/R-migration');
  await f.git(['worktree', 'add', '--detach', workspace, 'HEAD']);
  await fs.mkdir(path.join(workspace, LEGACY_PROJECT_DIRECTORY, 'context'), { recursive: true });
  await fs.writeFile(
    path.join(workspace, LEGACY_PROJECT_DIRECTORY, 'context/input.txt'),
    'Private input',
  );
  const userText = 'Keep the original ' + LEGACY_PROJECT_DIRECTORY + ' example';
  const original = {
    project: { root: f.root, dataDirectory: f.legacy },
    goals: [{ body: userText }],
    runs: [
      {
        workspace,
        goalText: userText,
        executionPolicySnapshot: {
          protectedPaths: [LEGACY_PROJECT_DIRECTORY + '/'],
          profile: { context: userText },
        },
      },
    ],
    sequence: 2,
    events: [{ text: userText }, { change: { type: 'run.delta', fields: { workspace } } }],
    receipts: { request: { fingerprint: 'unchanged', result: { workspace } } },
  };
  await fs.writeFile(path.join(f.legacy, 'control-state.json'), JSON.stringify(original));
  assert.equal(await findProjectDirectory(f.root), f.legacy);
  await assert.rejects(fs.access(path.join(f.root, PROJECT_DIRECTORY)));
  const current = await migrateProjectDirectory(f.root),
    after = JSON.parse(await fs.readFile(path.join(current, 'control-state.json'), 'utf8'));
  assert.equal(after.goals[0].body, userText);
  assert.equal(after.runs[0].goalText, userText);
  assert.equal(after.events[0].text, userText);
  assert.equal(after.sequence, 2);
  assert.equal(after.receipts.request.fingerprint, 'unchanged');
  assert.equal(
    after.runs[0].workspace,
    workspace.replace(LEGACY_PROJECT_DIRECTORY, PROJECT_DIRECTORY),
  );
  assert.equal(after.events[1].change.fields.workspace, after.runs[0].workspace);
  assert.equal(after.runs[0].executionPolicySnapshot.protectedPaths[0], PROJECT_DIRECTORY + '/');
  assert.equal(after.runs[0].executionPolicySnapshot.profile.context, userText);
  assert.deepEqual(
    JSON.parse(
      await fs.readFile(
        path.join(current, 'local/metadata-migration/original/control-state.json'),
        'utf8',
      ),
    ),
    original,
  );
  await assert.rejects(fs.access(f.legacy));
  const newWorkspace = after.runs[0].workspace;
  assert.equal(
    (await exec('git', ['rev-parse', '--show-toplevel'], { cwd: newWorkspace })).stdout.trim(),
    newWorkspace,
  );
  assert.equal(
    await fs.readFile(path.join(newWorkspace, PROJECT_DIRECTORY, 'context/input.txt'), 'utf8'),
    'Private input',
  );
  const saved = await fs.readFile(path.join(current, 'control-state.json'), 'utf8');
  await migrateProjectDirectory(f.root);
  assert.equal(await fs.readFile(path.join(current, 'control-state.json'), 'utf8'), saved);
  const manifestFile = path.join(current, 'local/metadata-migration/manifest.json'),
    manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  manifest.status = 'pending';
  await fs.writeFile(manifestFile, JSON.stringify(manifest));
  await migrateProjectDirectory(f.root);
  assert.equal(JSON.parse(await fs.readFile(manifestFile, 'utf8')).status, 'completed');
});
test('migration refuses conflicting directories, live writers and symlinks without modifying them', async (t) => {
  const f = await fixture(t),
    current = path.join(f.root, PROJECT_DIRECTORY);
  await fs.mkdir(current);
  await assert.rejects(migrateProjectDirectory(f.root), { code: 'METADATA_CONFLICT' });
  await fs.rmdir(current);
  await fs.writeFile(path.join(f.legacy, 'writer.lock'), JSON.stringify({ pid: process.pid }));
  await assert.rejects(migrateProjectDirectory(f.root), { code: 'PROJECT_BUSY' });
  await assert.rejects(fs.access(current));
  await fs.rm(path.join(f.legacy, 'writer.lock'));
  await fs.rmdir(f.legacy);
  await fs.symlink(os.tmpdir(), f.legacy, 'dir');
  await assert.rejects(migrateProjectDirectory(f.root), { code: 'UNSAFE_PATH' });
});
test('path migration does not rewrite arbitrary user text', () => {
  const input = {
    title: LEGACY_PROJECT_DIRECTORY,
    body: LEGACY_PROJECT_DIRECTORY,
    result: LEGACY_PROJECT_DIRECTORY,
    paths: [LEGACY_PROJECT_DIRECTORY + '/local'],
    command: 'node ' + LEGACY_PROJECT_DIRECTORY + '/tool.js',
  };
  const output = migrateMetadataPaths(input) as typeof input;
  assert.equal(output.body, input.body);
  assert.equal(output.title, input.title);
  assert.equal(output.result, input.result);
  assert.equal(output.paths[0], PROJECT_DIRECTORY + '/local');
  assert.equal(output.command, 'node ' + PROJECT_DIRECTORY + '/tool.js');
});

test('path conversion preserves recorded command evidence and similarly named user paths', () => {
  const command = 'node ' + LEGACY_PROJECT_DIRECTORY + '/script.js';
  const input = {
    command,
    commands: [{ command }],
    profile: { setup: [{ command }] },
    path: 'assets/' + LEGACY_PROJECT_DIRECTORY + '-example.md',
  };
  const output = migrateMetadataPaths(input) as typeof input;
  assert.equal(output.commands[0].command, command);
  assert.equal(output.profile.setup[0].command, 'node ' + PROJECT_DIRECTORY + '/script.js');
  assert.equal(output.path, input.path);
});
test('migration rejects symlinked local storage before creating a backup outside the project', async (t) => {
  const f = await fixture(t),
    outside = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-migration-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.symlink(outside, path.join(f.legacy, 'local'), 'dir');
  await assert.rejects(migrateProjectDirectory(f.root), { code: 'UNSAFE_PATH' });
  assert.deepEqual(await fs.readdir(outside), []);
  await fs.access(f.legacy);
});

test('concurrent migrations have one writer and preserve their original backup', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(
    path.join(f.legacy, 'control-state.json'),
    JSON.stringify({ path: LEGACY_PROJECT_DIRECTORY + '/local', body: 'Original content' }),
  );
  const results = await Promise.allSettled([
    migrateProjectDirectory(f.root),
    migrateProjectDirectory(f.root),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const current = path.join(f.root, PROJECT_DIRECTORY);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(current, 'control-state.json'), 'utf8')).body,
    'Original content',
  );
  assert.equal(
    JSON.parse(
      await fs.readFile(
        path.join(current, 'local/metadata-migration/original/control-state.json'),
        'utf8',
      ),
    ).path,
    LEGACY_PROJECT_DIRECTORY + '/local',
  );
  await assert.rejects(fs.access(path.join(current, 'writer.lock')));
  assert.equal(await migrateProjectDirectory(f.root), current);
});
