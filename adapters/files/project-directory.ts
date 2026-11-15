import { acquireWriterLock, releaseWriterLock } from './writer-lock.ts';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { DomainError } from '../../core/ports.ts';
import {
  PROJECT_DIRECTORY,
  LEGACY_PROJECT_DIRECTORY,
  migrateMetadataPaths,
} from '../../protocol/project-directory.ts';
const exec = promisify(execFile);
async function exists(file: string) {
  try {
    return await fs.lstat(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
}
export async function findProjectDirectory(root: string) {
  const current = path.join(root, PROJECT_DIRECTORY),
    legacy = path.join(root, LEGACY_PROJECT_DIRECTORY),
    a = await exists(current),
    b = await exists(legacy);
  if (a && b)
    throw new DomainError(
      'METADATA_CONFLICT',
      'Both current and legacy metadata directories exist. Resolve the duplicate before opening this project.',
    );
  for (const stat of [a, b])
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
      throw new DomainError('UNSAFE_PATH', 'Project metadata must be a regular directory.');
  return b ? legacy : current;
}
async function atomic(file: string, data: unknown) {
  const temporary = file + '.' + randomUUID() + '.migration.tmp';
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(data, null, 2) + '\n');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
async function regularDirectory(directory: string) {
  const stat = await exists(directory);
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
    throw new DomainError('UNSAFE_PATH', 'Migration directories must be regular directories.');
}
type Manifest = {
  version: 1;
  status: 'pending' | 'completed';
  startedAt: string;
  completedAt?: string;
  files: string[];
  worktrees: string[];
};
/** Offline, backed-up migration. A pending manifest makes an interrupted migration resumable. */
export async function migrateProjectDirectory(root: string) {
  const found = await findProjectDirectory(root),
    current = path.join(root, PROJECT_DIRECTORY),
    legacy = path.join(root, LEGACY_PROJECT_DIRECTORY),
    backup = path.join(found, 'local/metadata-migration');
  await regularDirectory(path.join(found, 'local'));
  await regularDirectory(backup);
  const manifestFile = path.join(backup, 'manifest.json'),
    manifestStat = await exists(manifestFile);
  if (manifestStat && (!manifestStat.isFile() || manifestStat.isSymbolicLink()))
    throw new DomainError('UNSAFE_PATH', 'The migration manifest must be a regular file.');
  let manifest: Manifest | undefined;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(backup, 'manifest.json'), 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  if (
    manifest &&
    (manifest.version !== 1 ||
      !['pending', 'completed'].includes(manifest.status) ||
      !Array.isArray(manifest.files) ||
      !manifest.files.every(
        (file) =>
          typeof file === 'string' &&
          !path.isAbsolute(file) &&
          !file.includes('\\') &&
          !file.split('/').some((part) => part === '..' || part === '') &&
          ['control-state.json', 'project.json', 'linked-projects.json'].includes(
            path.basename(file),
          ),
      ) ||
      !Array.isArray(manifest.worktrees) ||
      !manifest.worktrees.every(
        (name) =>
          typeof name === 'string' &&
          name !== '.' &&
          name !== '..' &&
          path.basename(name) === name &&
          !name.includes('\\'),
      ))
  )
    throw new DomainError(
      'INVALID_MIGRATION',
      'Invalid metadata migration manifest. Restore its backup before retrying.',
    );
  if (found !== legacy && manifest?.status !== 'pending') return current;
  try {
    const lock = JSON.parse(await fs.readFile(path.join(found, 'writer.lock'), 'utf8'));
    if (Number.isInteger(lock.pid)) {
      try {
        process.kill(lock.pid, 0);
        throw new DomainError(
          'PROJECT_BUSY',
          'Stop the project writer before migrating its metadata.',
        );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
      }
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const nonce = await acquireWriterLock(found);
  let lockedDirectory = found;
  try {
    await fs.mkdir(backup, { recursive: true, mode: 0o700 });
    await regularDirectory(path.join(backup, 'original'));
    if (!(await exists(path.join(backup, '.gitignore'))))
      await fs.writeFile(path.join(backup, '.gitignore'), '*\n', { flag: 'wx', mode: 0o600 });
    if (!manifest) {
      const files: string[] = [];
      async function collect(folder: string, prefix = '') {
        for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
          if (['local', 'worktrees', 'node_modules'].includes(entry.name) || entry.isSymbolicLink())
            continue;
          const relative = path.posix.join(prefix, entry.name),
            file = path.join(folder, entry.name);
          if (entry.isDirectory()) await collect(file, relative);
          else if (
            ['control-state.json', 'project.json', 'linked-projects.json'].includes(entry.name)
          ) {
            JSON.parse(await fs.readFile(file, 'utf8'));
            const copy = path.join(backup, 'original', relative);
            await fs.mkdir(path.dirname(copy), { recursive: true, mode: 0o700 });
            await fs.copyFile(file, copy);
            await fs.chmod(copy, 0o600);
            files.push(relative);
          }
        }
      }
      await collect(found);
      const worktrees = (
        await fs
          .readdir(path.join(found, 'worktrees'), { withFileTypes: true })
          .catch((e: NodeJS.ErrnoException) => {
            if (e.code === 'ENOENT') return [];
            throw e;
          })
      )
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
      manifest = {
        version: 1,
        status: 'pending',
        startedAt: new Date().toISOString(),
        files,
        worktrees,
      };
      await atomic(path.join(backup, 'manifest.json'), manifest);
    }
    if (found === legacy) {
      await fs.rename(legacy, current);
      lockedDirectory = current;
    }
    const finalBackup = path.join(current, 'local/metadata-migration');
    for (const relative of manifest.files) {
      const file = path.join(current, relative);
      const stat = await exists(file);
      if (!stat?.isFile() || stat.isSymbolicLink())
        throw new DomainError('UNSAFE_PATH', 'Migration metadata files must be regular files.');
      const data = JSON.parse(await fs.readFile(file, 'utf8'));
      await atomic(file, migrateMetadataPaths(data));
    }
    const workspaces = manifest.worktrees.map((name) => path.join(current, 'worktrees', name));
    for (const workspace of workspaces) {
      await regularDirectory(workspace);
      const git = await exists(path.join(workspace, '.git'));
      if (!git?.isFile() || git.isSymbolicLink())
        throw new DomainError(
          'UNSAFE_PATH',
          'Migration requires a regular Git worktree control file.',
        );
      const old = path.join(workspace, LEGACY_PROJECT_DIRECTORY);
      if (await exists(old)) {
        if (await exists(path.join(workspace, PROJECT_DIRECTORY)))
          throw new DomainError(
            'METADATA_CONFLICT',
            'A workspace contains both metadata directory names. Resolve the duplicate and retry.',
          );
        await fs.rename(old, path.join(workspace, PROJECT_DIRECTORY));
      }
    }
    if (workspaces.length) await exec('git', ['worktree', 'repair', ...workspaces], { cwd: root });
    const ignore = path.join(current, '.gitignore');
    if (!(await exists(ignore)))
      await fs.writeFile(ignore, 'control-state.json*\nwriter.lock\nworktrees/\nlocal/\n', {
        flag: 'wx',
        mode: 0o600,
      });
    manifest.status = 'completed';
    manifest.completedAt = new Date().toISOString();
    await atomic(path.join(finalBackup, 'manifest.json'), manifest);
    return current;
  } finally {
    await releaseWriterLock(lockedDirectory, nonce);
  }
}
