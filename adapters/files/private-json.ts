import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DomainError } from '../../core/ports.ts';

/** Private atomic records; consumers validate their own versioned schema. */
export class PrivateJSONFiles {
  private directory: string;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(directory: string) {
    this.directory = path.resolve(directory);
  }
  private filename(name: string) {
    if (!/^[A-Za-z0-9_-]{1,180}$/.test(name))
      throw new DomainError('INVALID_PRIVATE_RECORD', 'Invalid private record name.');
    return path.join(this.directory, name + '.json');
  }
  private async prepare() {
    let current = path.parse(this.directory).root;
    for (const part of this.directory.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try {
        if ((await fs.lstat(current)).isSymbolicLink())
          throw new DomainError('UNSAFE_CHECKPOINT', 'Private storage cannot contain symlinks.');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    if ((await fs.realpath(this.directory)) !== this.directory)
      throw new DomainError('UNSAFE_CHECKPOINT', 'Private storage cannot contain symlinks.');
    await fs.chmod(this.directory, 0o700);
  }
  async load(name: string): Promise<unknown | undefined> {
    const filename = this.filename(name);
    await this.queue;
    await this.prepare();
    try {
      if ((await fs.lstat(filename)).isSymbolicLink())
        throw new DomainError('UNSAFE_CHECKPOINT', 'A private record cannot be a symlink.');
      return JSON.parse(await fs.readFile(filename, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  save(name: string, value: unknown) {
    const filename = this.filename(name),
      bytes = JSON.stringify(structuredClone(value));
    const work = this.queue.then(async () => {
      await this.prepare();
      const temp = filename + '.' + randomUUID() + '.tmp';
      try {
        const handle = await fs.open(temp, 'wx', 0o600);
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await fs.rename(temp, filename);
      } finally {
        await fs.rm(temp, { force: true }).catch(() => {});
      }
    });
    this.queue = work.catch(() => {});
    return work;
  }
}
