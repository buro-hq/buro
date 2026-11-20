import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { FileProjectRegistry } from '../adapters/files/registry.ts';
import { ExecutionService } from '../core/execution.ts';
import type { AgentRuntime } from '../core/ports.ts';
import type { Goal, Run } from '../protocol/domain.ts';
import { parseSnapshot } from '../protocol/schema.ts';
import { sampleRun } from './fixtures/sample-run.ts';

const bounded: NonNullable<Run['planningPolicy']> = {
  version: 1,
  mode: 'bounded',
  revision: 'bounded-planning-v1',
};
const legacy: NonNullable<Run['planningPolicy']> = {
  version: 1,
  mode: 'legacy',
  revision: 'legacy-planning-v1',
};

function savedRun(policy: Run['planningPolicy'], client: 'managed' | 'codex' = 'managed') {
  const run = sampleRun();
  const resource = {
    id: client === 'managed' ? 'local-qwen' : 'codex',
    client,
    local: client === 'managed',
    configurationRevision: 'planning-fixture-v1',
  };
  run.resources = {
    profileId: 'fixture',
    policy: 'hybrid',
    coordinator: resource,
    worker: resource,
    reviewer: resource,
  };
  run.planningPolicy = policy;
  run.status = 'failed';
  run.workspace = '/fixture/workspace';
  run.baseCommit = 'a'.repeat(40);
  run.checkIds = ['suite'];
  return run;
}

async function fixture(t: any, policy: Run['planningPolicy'] | null = bounded) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-planning-store-'));
  const project = { id: 'p', name: 'Planning fixture', root: directory };
  let store = await FileProjectStore.open({ directory, project });
  const run = savedRun(policy || undefined);
  const goal: Goal = {
    id: run.goalId!,
    projectId: project.id,
    title: run.title,
    body: run.goalText,
    criteria: 'Preserve the public contract.',
    status: 'failed',
    createdAt: run.createdAt,
  };
  await store.transact('initial', 'initial', (draft) => {
    draft.runs.push(run);
    draft.goals.push(goal);
    return { result: null, change: { type: 'run.changed', run, goal } };
  });
  t.after(async () => {
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    project,
    get store() {
      return store;
    },
    async reopen() {
      await store.close();
      store = await FileProjectStore.open({ directory, project });
    },
    mutate(id: string, change: (run: Run) => void) {
      return store.transact(id, id, (draft) => {
        change(draft.runs[0]);
        return {
          result: null,
          change: { type: 'run.changed', run: draft.runs[0], goal: draft.goals[0] },
        };
      });
    },
  };
}

test('planning policy survives wire parsing, event replay and project reopen without allowing replacement', async (t) => {
  const f = await fixture(t);
  const before = f.store.snapshot();
  assert.deepEqual(
    parseSnapshot(JSON.parse(JSON.stringify(before))).runs[0].planningPolicy,
    bounded,
  );
  await f.reopen();
  assert.deepEqual(f.store.snapshot(), before);
  for (const [index, mutate] of [
    (run: Run) => {
      run.planningPolicy = legacy;
    },
    (run: Run) => {
      run.planningPolicy!.revision = 'bounded-planning-v2';
    },
    (run: Run) => {
      delete run.planningPolicy;
    },
  ].entries()) {
    await assert.rejects(f.mutate('tamper-' + index, mutate), { code: 'INVALID_PLANNING_POLICY' });
    assert.deepEqual(f.store.snapshot(), before);
  }
  await f.reopen();
  assert.deepEqual(f.store.snapshot(), before);
});

test('historical runs without a planning policy cannot acquire one through a project transaction', async (t) => {
  const f = await fixture(t, null);
  await f.reopen();
  assert.equal(f.store.snapshot().runs[0].planningPolicy, undefined);
  for (const [index, policy] of [legacy, bounded].entries())
    await assert.rejects(
      f.mutate('attach-' + index, (run) => {
        run.planningPolicy = policy;
      }),
      { code: 'INVALID_PLANNING_POLICY' },
    );
  await f.reopen();
  assert.equal(f.store.snapshot().runs[0].planningPolicy, undefined);
});

test('bounded planning cannot be recorded for a native coordinator in transport or storage', async (t) => {
  const f = await fixture(t);
  const invalid = savedRun(bounded, 'codex');
  const snapshot = f.store.snapshot();
  snapshot.runs = [invalid];
  assert.throws(() => parseSnapshot(snapshot), /Bounded planning requires a managed coordinator/);
  await assert.rejects(
    f.store.transact('native-bounded', 'native-bounded', (draft) => {
      invalid.id = 'R-native';
      draft.runs.push(invalid);
      return { result: null, change: { type: 'run.changed', run: invalid, goal: draft.goals[0] } };
    }),
    { code: 'INVALID_PLANNING_POLICY' },
  );
  assert.equal(f.store.snapshot().runs.length, 1);
});

test('an invalid persisted planning revision fails reopen instead of becoming a default', async (t) => {
  const f = await fixture(t);
  await f.store.close();
  const raw = JSON.parse(await fs.readFile(f.store.file, 'utf8'));
  raw.runs[0].planningPolicy.revision = 'unknown-policy';
  await fs.writeFile(f.store.file, JSON.stringify(raw));
  await assert.rejects(f.reopen(), /bounded-planning-v1/);
});

test('resume archives the frozen planning policy despite changed current planning defaults', async (t) => {
  for (const original of [bounded, legacy]) {
    const f = await fixture(t, original);
    const projects = new FileProjectRegistry([f.store]);
    const runtime: AgentRuntime = {
      id: 'unused',
      async start() {
        throw Error('No model request expected during admission.');
      },
      async resume() {
        throw Error('No model request expected during admission.');
      },
      async submit() {
        throw Error('No model request expected during admission.');
      },
      async turn() {
        throw Error('No model request expected during admission.');
      },
      async interrupt() {},
      async dispose() {},
    };
    const engine = new ExecutionService({
      projects,
      runtime,
      planningMode: original.mode === 'bounded' ? 'legacy' : 'bounded',
      policies: {
        p: {
          allowedPaths: ['src/'],
          checks: [{ id: 'suite', title: 'Suite' }],
          defaultCheckIds: ['suite'],
          maxWorkers: 1,
          maxRepairs: 0,
          turnTimeoutMs: 1000,
        },
      },
      workspaces: {
        async prepare() {
          throw Error('No workspace creation expected during admission.');
        },
        async changes() {
          return [];
        },
        async checkpoint() {
          return 'a'.repeat(40);
        },
      },
      checks: {
        async run() {
          throw Error('No checks expected during admission.');
        },
      },
      now: () => '2026-11-21T10:00:00.000Z',
      id: () => 'unused',
    });
    const scheduled: string[] = [];
    engine.schedule = (_projectId, runId) => {
      scheduled.push(runId);
    };
    await engine.resume('resume', 'resume', {
      projectId: 'p',
      runId: 'R-example',
      mode: 'repair',
      instructions: 'Continue.',
      useCurrentProfile: true,
    });
    await engine.dispose();
    assert.deepEqual(scheduled, ['R-example']);
    const resumed = f.store.snapshot().runs[0];
    assert.equal(resumed.status, 'queued');
    assert.deepEqual(resumed.planningPolicy, original);
    assert.deepEqual(resumed.attempts?.[0].planningPolicy, original);
    await f.reopen();
    assert.deepEqual(f.store.snapshot().runs[0].planningPolicy, original);
    await assert.rejects(
      f.mutate('rewrite-attempt', (run) => {
        run.attempts![0].planningPolicy = original.mode === 'bounded' ? legacy : bounded;
      }),
      { code: 'INVALID_PLANNING_POLICY' },
    );
    await assert.rejects(
      f.mutate('remove-attempts', (run) => {
        delete run.attempts;
      }),
      { code: 'INVALID_PLANNING_POLICY' },
    );
    await assert.rejects(
      f.mutate('truncate-attempts', (run) => {
        run.attempts = [];
      }),
      { code: 'INVALID_PLANNING_POLICY' },
    );
    await assert.rejects(
      f.mutate('append-different-policy', (run) => {
        run.attempts!.push({
          ...run.attempts![0],
          planningPolicy: original.mode === 'bounded' ? legacy : bounded,
        });
      }),
      { code: 'INVALID_PLANNING_POLICY' },
    );
    await f.reopen();
    assert.equal(f.store.snapshot().runs[0].attempts?.length, 1);
  }
});
