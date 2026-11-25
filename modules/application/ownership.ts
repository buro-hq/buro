import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Owns one application directory until close or process exit, without stale PID files. */
export interface ApplicationOwnership {
  /** Releases the OS-backed lock. */
  close(): void;
}

/** Acquires ownership before recovery can modify records belonging to a running server. */
export function ownApplication(input: { directory: string }): ApplicationOwnership {
  const directory = path.resolve(input.directory, 'private');
  fs.mkdirSync(directory, {
    recursive: true,
    mode: 0o700,
  });
  const filename = path.join(directory, 'owner.sqlite');
  const database = new DatabaseSync(filename);
  try {
    fs.chmodSync(filename, 0o600);
    database.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
  } catch (error) {
    database.close();
    if (error instanceof Error && (error as Error & { errcode?: number }).errcode === 5)
      throw new Error('Another Buro server is using this application directory.');

    throw error;
  }
  let closed = false;
  return {
    close() {
      if (closed)
        return;

      closed = true;
      database.close();
    },
  };
}
