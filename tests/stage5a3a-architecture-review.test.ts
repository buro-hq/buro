import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { SqliteProjectUsageAuthority } from '../adapters/sqlite/project-usage-authority.ts';
import type { ProjectEntities } from '../core/project-entities.ts';
import type { Goal } from '../protocol/domain.ts';

const command = (id: string) => ({ id, fingerprint: id });
const goal = (id: string): Goal => ({
  id,
  projectId: 'p',
  title: 'Synthetic goal',
  body: 'Independent boundary proof.',
  criteria: 'No partial commit.',
  status: 'draft',
  revision: 1,
  createdAt: '2026-11-22T00:00:00Z',
});

for (const kind of ['file', 'sqlite'] as const)
  test(`${kind}: caught tombstone reuse cannot commit earlier batch mutations after reopen`, async (t) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buro-entity-reuse-')));
    const directory = path.join(root, 'state');
    let store: FileProjectStore | SqliteProjectUsageAuthority;
    const open = async () => {
      store =
        kind === 'file'
          ? await FileProjectStore.open({
              directory,
              project: { id: 'p', name: 'Synthetic', root },
            })
          : await SqliteProjectUsageAuthority.open({
              directory,
              project: { id: 'p', name: 'Synthetic project', root: directory },
            });
    };
    const close = () => store.close();
    const entities = (): ProjectEntities => store.entities;
    await open();
    t.after(async () => {
      await close();
      await fs.rm(root, { recursive: true, force: true });
    });
    await entities().transaction(command('create-old'), (tx) => tx.createGoal(goal('G-old')));
    await entities().transaction(command('delete-old'), (tx) => tx.deleteGoal('G-old', 1));
    await close();
    await open();
    await assert.rejects(
      entities().transaction(command('caught-reuse'), (tx) => {
        tx.createGoal(goal('G-new'));
        try {
          tx.createGoal(goal('G-old'));
        } catch {}
        return 'caught';
      }),
      { code: 'CONFLICT' },
    );
    assert.equal(await entities().goal('G-old'), undefined);
    assert.equal(await entities().goal('G-new'), undefined);
    await close();
    await open();
    assert.equal(await entities().goal('G-new'), undefined);
    let retryCalled = false;
    const retried = await entities().transaction(command('caught-reuse'), (tx) => {
      retryCalled = true;
      return tx.createGoal(goal('G-new'));
    });
    assert.equal(retryCalled, true, 'The rolled-back command has no success receipt.');
    assert.equal(retried.id, 'G-new');
    const replay = await entities().transaction(command('caught-reuse'), () => {
      throw Error('The committed retry must replay its original receipt.');
    });
    assert.deepEqual(replay, retried);
    assert.equal(await entities().goal('G-old'), undefined);
  });
