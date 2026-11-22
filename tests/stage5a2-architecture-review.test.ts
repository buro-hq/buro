import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SqliteProjectUsageAuthority } from '../adapters/sqlite/project-usage-authority.ts';

test('private authority storage rejects hard-linked database files and companions without modifying external aliases', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buro-sql-hardlink-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const state = path.join(root, 'private' + (suffix || '-main'));
    const outside = path.join(root, 'outside' + (suffix || '-main'));
    await fs.mkdir(state);
    await fs.writeFile(outside, '', { mode: 0o640 });
    await fs.chmod(outside, 0o640);
    await fs.link(outside, path.join(state, 'authority.sqlite' + suffix));
    let opened: SqliteProjectUsageAuthority | undefined;
    try {
      await assert.rejects(
        async () => {
          opened = await SqliteProjectUsageAuthority.open({ directory: state, projectId: 'p' });
        },
        { code: 'UNSAFE_USAGE_STORAGE' },
      );
      assert.equal(await fs.readFile(outside, 'utf8'), '');
      assert.equal((await fs.stat(outside)).mode & 0o777, 0o640);
    } finally {
      await opened?.close();
    }
  }
});
