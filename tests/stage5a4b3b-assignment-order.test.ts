import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExecutionService } from '../core/execution.ts';
import { GoalService } from '../core/services.ts';
import { executionPolicy } from '../core/project-settings.ts';
import type { ProjectProfile } from '../protocol/domain.ts';
import type { ProjectStore, AgentRuntime } from '../core/ports.ts';
import type { CheckPort, WorkspacePort } from '../core/execution-ports.ts';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { SqliteProjectUsageAuthority } from '../adapters/sqlite/project-usage-authority.ts';
import { createBuiltinWorkflowRoles } from '../adapters/workflows/builtins.ts';
import {
  fixtureExecutionCapabilities,
  fixtureExecutionSelection,
} from './fixtures/execution-resources.ts';

for (const kind of ['file', 'sqlite'] as const) {
  test(`${kind}: continuation preserves the accepted serial worker order when role IDs sort differently`, async (t) => {
    const directory = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'buro-worker-order-')),
    );
    const project = { id: 'p', name: 'Serial order fixture', root: directory };
    const profile: ProjectProfile = {
      version: 1,
      revision: 1,
      context: 'Preserve serial worker order',
      scope: { mode: 'advisory', plannedPaths: [], protectedPaths: [] },
      checks: [{ id: 'test', title: 'Test', command: 'must-not-run', timeoutMs: 1000 }],
      defaultCheckIds: ['test'],
      setup: [],
      dependencies: 'none',
      maxWorkers: 2,
      maxRepairs: 0,
      turnTimeoutMs: 10000,
    };
    let authority: FileProjectStore | SqliteProjectUsageAuthority;
    const open = async () => {
      authority =
        kind === 'file'
          ? await FileProjectStore.open({ directory, project, profile })
          : await SqliteProjectUsageAuthority.open({ directory, project, profile });
    };
    await open();
    let ids = 0;
    const env = {
      projects: {
        get: () =>
          ({
            project: authority.project,
            entities: authority.entities,
            settings: authority.settings,
            materials: authority.materials,
            runs: authority.runs,
            snapshot: () => {
              throw Error('Order proof cannot hydrate a legacy Run.');
            },
            transact: () => {
              throw Error('Order proof cannot mutate a legacy Run.');
            },
          }) as ProjectStore,
        list: () => [project],
      },
      id: () => String(++ids),
      now: () => new Date(Date.UTC(2026, 0, 1) + ids * 1000).toISOString(),
    };
    const forbidden = async (): Promise<never> => {
      throw Error('Order proof dispatched an external effect.');
    };
    const service = new ExecutionService({
      ...env,
      policies: { p: executionPolicy(profile) },
      selection: fixtureExecutionSelection('fake', fixtureExecutionCapabilities()),
      workflowRoles: createBuiltinWorkflowRoles(),
      runtime: {
        id: 'fake',
        start: forbidden,
        turn: forbidden,
        submit: forbidden,
        interrupt: forbidden,
        dispose: async () => {},
      } as AgentRuntime,
      checks: { run: forbidden } as CheckPort,
      workspaces: { prepare: forbidden } as WorkspacePort,
    });
    service.schedule = () => {};
    t.after(async () => {
      await service.dispose();
      await authority.close();
      await fs.rm(directory, { recursive: true, force: true });
    });
    const goal = await new GoalService(env).create('goal', 'goal', {
      projectId: 'p',
      title: 'Serial workers',
      body: 'Keep the requested sequence.',
      criteria: 'Zeta precedes alpha.',
    });
    const { runId } = await service.start('queue', 'queue', { projectId: 'p', goalId: goal.id });
    await service.beginExecution('p', runId);
    await service.phase('p', runId, 'preparing', 'Prepare');
    await service.bindPreparedWorkspace('p', runId, {
      path: path.join(directory, 'workspace'),
      base: 'a'.repeat(40),
    });
    await service.phase('p', runId, 'planning', 'Plan');
    const accepted = await service.acceptPlan(
      'p',
      runId,
      {
        summary: 'Zeta first, alpha second',
        // Workers need not appear in steps; their team order remains the serial dispatch order.
        steps: [
          { step: 'Coordinate', owner: 'coordinator' },
          { step: 'Review', owner: 'reviewer' },
        ],
        team: ['zeta', 'alpha'].map((roleId) => ({
          roleId,
          action: 'create' as const,
          title: roleId,
          description: 'A serial worker',
          instructions: 'Preserve the serial assignment order.',
          kind: 'implementation' as const,
          paths: ['src/' + roleId + '.ts'],
          runtimeId: null,
          runtimeReason: '',
          assignment: null,
        })),
      },
      { zeta: null, alpha: null },
    );
    assert.deepEqual(
      accepted.assignments.map((value) => value.role.id),
      ['zeta', 'alpha'],
    );
    const inherited = async () =>
      (await authority.runs.currentAttempt(runId)).context.roleSnapshots
        .filter((role) => !['coordinator', 'reviewer'].includes(role.id))
        .map((role) => role.id);
    await service.finish('p', runId, 'failed', 'Stop before continuation');
    await service.resume('continue', 'continue', {
      projectId: 'p',
      runId,
      mode: 'repair',
      instructions: 'Keep serial order',
      useCurrentProfile: false,
    });
    assert.deepEqual(await inherited(), ['zeta', 'alpha']);
    await authority.close();
    await open();
    assert.deepEqual(await inherited(), ['zeta', 'alpha']);
    await service.beginExecution('p', runId);
    await service.finish('p', runId, 'failed', 'Second stopped attempt');
    await service.resume('continue-again', 'continue-again', {
      projectId: 'p',
      runId,
      mode: 'repair',
      instructions: 'Still keep serial order',
      useCurrentProfile: false,
    });
    assert.deepEqual(await inherited(), ['zeta', 'alpha']);
  });
}
