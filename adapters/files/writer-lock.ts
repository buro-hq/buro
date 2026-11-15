import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DomainError } from '../../core/ports.ts';

/** Exclusive project writer lease, shared with offline metadata migration. */
export async function acquireWriterLock(directory: string) {
  const lock = path.join(directory, 'writer.lock'),
    nonce = randomUUID();
  try {
    await fs.writeFile(lock, JSON.stringify({ pid: process.pid, nonce }), {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const recovery = lock + '.recovery';
    let guard;
    try {
      guard = await fs.open(recovery, 'wx', 0o600);
    } catch {
      throw new DomainError('PROJECT_LOCKED', 'Another process is checking the project lock.');
    }
    try {
      let dead = false;
      try {
        const existing = JSON.parse(await fs.readFile(lock, 'utf8'));
        try {
          process.kill(existing.pid, 0);
        } catch (e) {
          dead = (e as NodeJS.ErrnoException).code === 'ESRCH';
        }
      } catch (e) {
        dead = (e as NodeJS.ErrnoException).code === 'ENOENT';
      }
      if (!dead)
        throw new DomainError('PROJECT_LOCKED', 'The project already has a writer process.');
      await fs.rm(lock, { force: true });
      try {
        await fs.writeFile(lock, JSON.stringify({ pid: process.pid, nonce }), {
          flag: 'wx',
          mode: 0o600,
        });
      } catch {
        throw new DomainError('PROJECT_LOCKED', 'Another process opened the project.');
      }
    } finally {
      await guard.close();
      await fs.rm(recovery, { force: true });
    }
  }
  return nonce;
}
export async function releaseWriterLock(directory: string, nonce: string) {
  const lock = path.join(directory, 'writer.lock');
  try {
    const existing = JSON.parse(await fs.readFile(lock, 'utf8'));
    if (existing.nonce === nonce) await fs.rm(lock);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}
