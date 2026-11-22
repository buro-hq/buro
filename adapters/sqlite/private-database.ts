import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { DomainError } from '../../core/ports.ts';

const unsafe = () =>
  new DomainError(
    'UNSAFE_USAGE_STORAGE',
    'Project authority storage must use private regular files and directories.',
  );

/** Prepare a private canonical directory without following an existing symlink ancestor. */
export async function preparePrivateDatabase(directory: string, filename: string) {
  const resolved = path.resolve(directory);
  let current = path.parse(resolved).root;
  for (const part of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw unsafe();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try {
        await fs.mkdir(current, { mode: 0o700 });
      } catch (creation) {
        if ((creation as NodeJS.ErrnoException).code !== 'EEXIST') throw creation;
      }
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw unsafe();
    }
  }
  if ((await fs.realpath(resolved)) !== resolved) throw unsafe();
  await fs.chmod(resolved, 0o700);
  const file = path.join(resolved, filename);
  await assertPrivateDatabaseFiles(file);
  let handle;
  try {
    handle = await fs.open(
      file,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    handle = await fs.open(file, constants.O_RDWR | constants.O_NOFOLLOW);
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw unsafe();
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
  return { directory: resolved, file };
}

/** SQLite creates WAL/SHM with the database mode; validate preexisting companions too. */
export async function assertPrivateDatabaseFiles(file: string) {
  for (const candidate of [file, file + '-wal', file + '-shm', file + '-journal']) {
    try {
      const stat = await fs.lstat(candidate);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw unsafe();
      await fs.chmod(candidate, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
