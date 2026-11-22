import { serviceOperationContext, operationIds } from '../core/operation-catalog.ts';
import { fixtureCapabilities } from './fixtures/backend-capabilities.ts';
import {
  virtualWorkspaceRevision,
  virtualVerificationViews,
  VIRTUAL_BASE_COMMIT,
} from './fixtures/virtual-workspace.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { ProjectStoreRegistry } from '../core/project-registry.ts';
import { ExecutionService } from '../core/execution.ts';
import type { AgentRuntime } from '../core/ports.ts';
import type { Goal, Run } from '../protocol/domain.ts';
import { parseSnapshot } from '../protocol/schema.ts';
import { sampleRun } from './fixtures/sample-run.ts';
import { selectPlanningPolicy } from '../core/planning-policy.ts';
import { defaultRoles } from '../core/defaults.ts';
import { resolveRoleResource } from '../core/role-routing.ts';

const configured = {
  id: 'local-qwen',
  backendId: 'managed' as const,
  local: true,
  configurationRevision: 'planning-fixture-v1',
  capabilities: fixtureCapabilities({ structuredTurns: true, toolsFreeTurns: true }),
};
const toolsFree = selectPlanningPolicy(configured);
const inspection = selectPlanningPolicy({
  ...configured,
  capabilities: fixtureCapabilities({
    revision: 'inspection-v1',
    structuredTurns: true,
    readOnlySessions: true,
  }),
});

function savedRun(policy: Run['planningPolicy'], client: 'managed' | 'codex' = 'managed') {
  const run = sampleRun();
  const resource = {
    capabilities: fixtureCapabilities({
      revision: policy?.capabilitiesRevision || configured.capabilities.revision,
      structuredTurns: true,
      toolsFreeTurns: policy?.strategy !== 'read-only-inspection',
      readOnlySessions: policy?.strategy === 'read-only-inspection',
    }),
    id: policy?.runtimeId || configured.id,
    backendId: client,
    local: client === 'managed',
    configurationRevision: policy?.configurationRevision || configured.configurationRevision,
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
  run.baseCommit = VIRTUAL_BASE_COMMIT;
  run.checkIds = ['suite'];
  return run;
}

async function fixture(t: any, policy: Run['planningPolicy'] | null = toolsFree) {
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
    toolsFree,
  );
  await f.reopen();
  assert.deepEqual(f.store.snapshot(), before);
  for (const [index, mutate] of [
    (run: Run) => {
      run.planningPolicy = inspection;
    },
    (run: Run) => {
      (run.planningPolicy as { revision: string }).revision = 'unregistered-revision';
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
  for (const [index, policy] of [inspection, toolsFree].entries())
    await assert.rejects(
      f.mutate('attach-' + index, (run) => {
        run.planningPolicy = policy;
      }),
      { code: 'INVALID_PLANNING_POLICY' },
    );
  await f.reopen();
  assert.equal(f.store.snapshot().runs[0].planningPolicy, undefined);
});

test('planning policy admission depends on capabilities and their revisions, not native labels', async (t) => {
  const f = await fixture(t);
  const valid = savedRun(toolsFree, 'codex');
  const snapshot = f.store.snapshot();
  snapshot.runs = [valid];
  assert.deepEqual(parseSnapshot(snapshot).runs[0].planningPolicy, toolsFree);
  for (const [index, mutate] of [
    (run: Run) => {
      run.resources!.coordinator.capabilities.toolsFreeTurns = false;
    },
    (run: Run) => {
      run.resources!.coordinator.capabilities.revision = 'different-backend-revision';
    },
    (run: Run) => {
      run.resources!.coordinator.configurationRevision = 'different-configuration';
    },
    (run: Run) => {
      run.resources!.coordinator.id = 'different-runtime';
    },
  ].entries()) {
    const invalid = structuredClone(valid);
    mutate(invalid);
    snapshot.runs = [invalid];
    assert.throws(() => parseSnapshot(snapshot), /planning/i);
    await assert.rejects(
      f.store.transact('invalid-binding-' + index, 'invalid-binding-' + index, (draft) => {
        invalid.id = 'R-invalid-' + index;
        draft.runs.push(invalid);
        return {
          result: null,
          change: { type: 'run.changed', run: invalid, goal: draft.goals[0] },
        };
      }),
      { code: 'INVALID_PLANNING_POLICY' },
    );
  }
  assert.equal(f.store.snapshot().runs.length, 1);
});

test('an invalid persisted planning revision fails reopen instead of becoming a default', async (t) => {
  const f = await fixture(t);
  await f.store.close();
  const raw = JSON.parse(await fs.readFile(f.store.file, 'utf8'));
  raw.runs[0].planningPolicy.revision = 'unknown-policy';
  await fs.writeFile(f.store.file, JSON.stringify(raw));
  await assert.rejects(f.reopen(), /capability-planning-v1/);
});

test('the selected coordinator decision owns planning even when the profile default has different mechanics', async (t) => {
  const f = await fixture(t);
  const selected = {
    ...configured,
    id: 'pinned-inspection-backend',
    configurationRevision: 'selected-v2',
    capabilities: fixtureCapabilities({
      revision: 'selected-cap-v2',
      structuredTurns: true,
      readOnlySessions: true,
    }),
  };
  const role = {
    ...defaultRoles.find((role) => role.id === 'coordinator')!,
    runtimePreference: { mode: 'fixed' as const, runtimeId: selected.id },
  };
  const run = savedRun(selectPlanningPolicy(selected));
  run.id = 'R-selected';
  run.resources = {
    profileId: 'selected-fixture',
    policy: 'hybrid',
    coordinator: configured,
    worker: configured,
    reviewer: selected,
    workerPool: [configured, selected],
  };
  run.roleSnapshots = [role];
  run.roleResources = {
    coordinator: resolveRoleResource(
      run.resources,
      role,
      serviceOperationContext(operationIds.coordination, undefined, false),
    ),
  };
  const snapshot = f.store.snapshot();
  snapshot.runs = [run];
  assert.equal(parseSnapshot(snapshot).runs[0].planningPolicy?.strategy, 'read-only-inspection');
  await f.store.transact('selected', 'selected', (draft) => {
    draft.runs.push(run);
    return { result: null, change: { type: 'run.changed', run, goal: draft.goals[0] } };
  });
  await f.reopen();
  assert.equal(f.store.snapshot().runs[1].planningPolicy?.runtimeId, selected.id);
  const invalid = {
    ...structuredClone(run),
    id: 'R-wrong-default',
    planningPolicy: selectPlanningPolicy(configured),
  };
  snapshot.runs = [invalid];
  assert.throws(() => parseSnapshot(snapshot), /planning/i);
  await assert.rejects(
    f.store.transact('wrong-default', 'wrong-default', (draft) => {
      draft.runs.push(invalid);
      return { result: null, change: { type: 'run.changed', run: invalid, goal: draft.goals[0] } };
    }),
    { code: 'INVALID_PLANNING_POLICY' },
  );
});

test('resume archives the frozen planning strategy and rejects attempt-history rewriting', async (t) => {
  for (const original of [toolsFree, inspection]) {
    const f = await fixture(t, original);
    const projects = new ProjectStoreRegistry([f.store]);
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
      policies: {
        p: {
          scope: { mode: 'advisory', plannedPaths: ['src/'], protectedPaths: [] },
          checks: [{ id: 'suite', title: 'Suite' }],
          defaultCheckIds: ['suite'],
          maxWorkers: 1,
          maxRepairs: 0,
          turnTimeoutMs: 1000,
        },
      },
      workspaces: {
        ...virtualVerificationViews,
        async prepare() {
          throw Error('No workspace creation expected during admission.');
        },
        async changes() {
          return [];
        },
        async captureRevision(workspace: string, base: string) {
          return virtualWorkspaceRevision(await this.changes(workspace, base), base);
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
        run.attempts![0].planningPolicy =
          original.strategy === 'tools-free-structured' ? inspection : toolsFree;
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
          planningPolicy: original.strategy === 'tools-free-structured' ? inspection : toolsFree,
        });
      }),
      { code: 'INVALID_PLANNING_POLICY' },
    );
    await f.reopen();
    assert.equal(f.store.snapshot().runs[0].attempts?.length, 1);
  }
});
