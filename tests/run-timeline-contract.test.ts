import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { SqliteProjectUsageAuthority } from '../adapters/sqlite/project-usage-authority.ts';

for (const kind of ['file', 'sqlite'] as const) {
  test(`${kind}: unknown run timeline rejects rather than inventing an empty existing run`, async (t) => {
    const directory = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'buro-timeline-contract-')),
    );
    const project = { id: 'p', name: 'Synthetic', root: directory };
    const authority =
      kind === 'file'
        ? await FileProjectStore.open({ directory, project })
        : await SqliteProjectUsageAuthority.open({ directory, project });
    t.after(async () => {
      await authority.close();
      await fs.rm(directory, { recursive: true, force: true });
    });
    await assert.rejects(authority.runs.timeline({ runId: 'R-missing', limit: 10 }), {
      code: 'NOT_FOUND',
    });
    await assert.rejects(
      authority.runs.timeline({
        runId: 'R-missing',
        limit: 10,
        cursor: { version: 1, projectId: 'p', runId: 'R-missing', after: 0, watermark: 0 },
      }),
      { code: 'NOT_FOUND' },
    );
    await assert.rejects(
      authority.runs.timeline({
        runId: 'R-missing',
        limit: 10,
        cursor: { version: 1, projectId: 'foreign', runId: 'R-missing', after: 0, watermark: 0 },
      }),
      { code: 'INVALID_RUN_CURSOR' },
    );
    assert.equal(await authority.runs.current('R-missing'), undefined);
    assert.equal(await authority.runs.receipt({ id: 'read', fingerprint: 'read' }), undefined);
    if (kind === 'sqlite')
      assert.deepEqual(
        (await (authority as SqliteProjectUsageAuthority).pagedEvents({ after: 0, limit: 10 }))
          .events,
        [],
      );
    else assert.equal((authority as FileProjectStore).snapshot().sequence, 0);
  });
}
