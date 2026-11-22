import { createBuiltinExecutionActions } from '../adapters/workflows/actions.ts';
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
import type { ExecutionPolicy, CheckPort, WorkspacePort } from '../core/execution-ports.ts';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { SqliteProjectUsageAuthority } from '../adapters/sqlite/project-usage-authority.ts';
import { createBuiltinWorkflowRoles } from '../adapters/workflows/builtins.ts';
import {
  fixtureExecutionCapabilities,
  fixtureExecutionSelection,
} from './fixtures/execution-resources.ts';

for (const kind of ['file', 'sqlite'] as const) {
  for (const hostContext of ['override', 'missing'] as const) {
    test(`${kind}: ${hostContext} host context retains its real policy source without a settings profile`, async (t) => {
      const directory = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), 'buro-policy-source-')),
      );
      const project = { id: 'p', name: 'Configured host source fixture', root: directory };
      const embedded: ProjectProfile = {
        version: 1,
        revision: 1,
        context: 'Embedded profile context',
        scope: { mode: 'advisory', plannedPaths: [], protectedPaths: [] },
        checks: [{ id: 'test', title: 'Test', command: 'must-not-run', timeoutMs: 1000 }],
        defaultCheckIds: ['test'],
        setup: [],
        dependencies: 'none',
        maxWorkers: 1,
        turnTimeoutMs: 10000,
      };
      const original: ExecutionPolicy = executionPolicy(embedded);
      if (hostContext === 'missing') delete original.context;
      else original.context = 'Explicit host context overrides embedded profile';
      assert.notEqual(original.context, original.profile!.context);
      let authority: FileProjectStore | SqliteProjectUsageAuthority;
      const open = async () => {
        // The embedded execution metadata is deliberately not a project settings row.
        authority =
          kind === 'file'
            ? await FileProjectStore.open({ directory, project })
            : await SqliteProjectUsageAuthority.open({ directory, project });
      };
      await open();
      let ids = 0,
        effects = 0;
      const env = {
        projects: {
          get: () =>
            ({
              project: authority.project,
              entities: authority.entities,
              materials: authority.materials,
              settings: authority.settings,
              runs: authority.runs,
              snapshot: () => {
                throw Error('Policy-source proof cannot hydrate an aggregate.');
              },
              transact: () => {
                throw Error('Policy-source proof cannot mutate an aggregate.');
              },
            }) as ProjectStore,
          list: () => [project],
        },
        id: () => String(++ids),
        now: () => new Date(Date.UTC(2026, 0, 1) + ids * 1000).toISOString(),
      };
      const forbidden = async (): Promise<never> => {
        effects++;
        throw Error('Policy-source proof dispatched an external effect.');
      };
      const service = new ExecutionService({
        actions: createBuiltinExecutionActions(),
        ...env,
        policies: { p: structuredClone(original) },
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
      assert.equal(await authority.settings.profile(), undefined);
      const goal = await new GoalService(env).create('goal', 'goal', {
        projectId: 'p',
        title: 'Retain the host policy',
        body: 'A complete task.',
        criteria: 'Preserve policy provenance.',
      });
      const { runId } = await service.start('queue', 'queue', { projectId: 'p', goalId: goal.id });
      const initial = await authority.runs.currentAttempt(runId);
      assert.equal(initial.context.policySource, 'admission');
      assert.deepEqual(initial.context.policy, original);
      await service.beginExecution('p', runId);
      await service.phase('p', runId, 'preparing', 'Prepare');
      await service.bindPreparedWorkspace('p', runId, {
        path: path.join(directory, 'workspace'),
        base: 'a'.repeat(40),
      });
      await service.finish('p', runId, 'failed', 'Original attempt stopped');

      const configured = { ...structuredClone(original), maxWorkers: 2 };
      service.env.policies.p = configured;
      await service.resume('retain', 'retain', {
        projectId: 'p',
        runId,
        mode: 'repair',
        instructions: 'Keep original policy',
        useCurrentProfile: false,
      });
      const retained = await authority.runs.currentAttempt(runId);
      assert.equal(retained.context.policySource, 'retained-attempt');
      assert.deepEqual(retained.context.policy, original);
      await service.beginExecution('p', runId);
      await service.finish('p', runId, 'failed', 'Retained-policy attempt stopped');

      await service.resume('configure', 'configure', {
        projectId: 'p',
        runId,
        mode: 'repair',
        instructions: 'Use configured host policy',
        useCurrentProfile: true,
      });
      const current = await authority.runs.currentAttempt(runId);
      assert.equal(current.context.policySource, 'configured-host');
      assert.deepEqual(current.context.policy, configured);
      assert.notEqual(
        current.context.policy.maxWorkers,
        current.context.policy.profile!.maxWorkers,
      );
      assert.equal(Object.hasOwn(current.context.policy, 'context'), hostContext === 'override');
      assert.equal(await authority.settings.profile(), undefined);
      await authority.close();
      await open();
      assert.deepEqual(await authority.runs.currentAttempt(runId), current);
      assert.equal(await authority.settings.profile(), undefined);
      assert.equal(effects, 0);
    });
  }
}
