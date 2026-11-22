import fs from 'node:fs/promises';
import path from 'node:path';
import { DomainError } from '../../core/ports.ts';
import { PROJECT_DIRECTORY } from '../../protocol/project-directory.ts';

/** Inspect the current metadata location without creating or rewriting project data. */
export async function findProjectDirectory(root: string) {
  const directory = path.join(root, PROJECT_DIRECTORY);
  try {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new DomainError('UNSAFE_PATH', 'Project metadata must be a regular directory.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return directory;
}
