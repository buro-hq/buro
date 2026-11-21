import { PiAgentLoopRunner } from '../adapters/agents/pi-loop.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Run } from '../protocol/domain.ts';
import type { ProjectRegistry } from '../core/ports.ts';
import type { ManagedRuntimeOptions } from '../core/managed-runtime-options.ts';
import {
  prepareManagedSession,
  prepareManagedResume,
  assertManagedCurrentWorkspace,
  assertManagedReconciled,
  managedBudgetOwner,
  managedToolDefinitions,
} from '../core/managed-session-authority.ts';

function fixture() {
  const run = {
    id: 'R',
    workspace: '/writer',
    baseCommit: 'a'.repeat(40),
    contextMaterials: [],
    executionPolicySnapshot: {
      scope: { mode: 'advisory', plannedPaths: ['src/'], protectedPaths: ['checks/'] },
      profile: { checks: [{ id: 'test', command: 'node test', timeoutMs: 1000 }] },
    },
  } as unknown as Run;
  const state = { project: { id: 'p', root: '/source' }, runs: [run] };
  let effects = 0;
  const options: ManagedRuntimeOptions = {
    loopRunner: new PiAgentLoopRunner(),
    id: 'managed',
    model: 'fixture',
    idGenerator: () => {
      throw Error('Identity belongs to runtime');
    },
    limits: {
      contextTokens: 32768,
      maxOutputTokens: 1024,
      maxRequestsPerTurn: 10,
      maxToolCallsPerTurn: 10,
      maxSessionRequests: 100,
    },
    projects: {
      get: () => ({ snapshot: () => structuredClone(state) }),
    } as unknown as ProjectRegistry,
    sessions: {
      async load() {
        effects++;
        throw Error('No store ownership');
      },
      async save() {
        effects++;
        throw Error('No store ownership');
      },
    },
    provider: {
      id: 'provider',
      revision: 'wire-v1',
      local: true,
      async complete() {
        effects++;
        throw Error('No generation ownership');
      },
    },
    tools: {
      definitions: () =>
        ['read_file', 'edit_file', 'run_command'].map((name) => ({
          name,
          description: name,
          parameters: {},
        })),
      async execute() {
        effects++;
        throw Error('No tool ownership');
      },
    },
  };
  const input = {
    projectId: 'p',
    runId: 'R',
    workspace: '/writer',
    purpose: 'implementation' as const,
    instructions: 'Implement',
    assignment: {
      sessionId: 'S',
      roleId: 'builder',
      scope: {
        mode: 'advisory' as const,
        plannedPaths: ['src/owned.ts'],
        protectedPaths: ['checks/'],
      },
    },
  };
  return { run, state, options, input, effects: () => effects };
}

test('prepared session and explicit resume derive detached authority revisions without persistence or effects', () => {
  const f = fixture();
  const session = prepareManagedSession(f.options, f.input, 'M-owned');
  assert.equal(session.id, 'M-owned');
  assert.equal(session.runtimeId, 'managed');
  assert.deepEqual(session.scope.writeScope, f.input.assignment.scope);
  const before = structuredClone(session);
  f.run.executionPolicySnapshot!.scope = {
    mode: 'strict',
    plannedPaths: ['src/'],
    protectedPaths: ['checks/', 'src/private.ts'],
  };
  const resumed = prepareManagedResume(f.options, session, {
    projectId: 'p',
    runId: 'R',
    workspace: '/writer',
    threadId: session.id,
    instructions: 'Continue',
  });
  assert.deepEqual(session, before);
  assert.equal(resumed.scope.writeScope.mode, 'strict');
  assert.deepEqual(resumed.scope.writeScope.plannedPaths, ['src/owned.ts']);
  assert.deepEqual(resumed.scope.writeScope.protectedPaths, ['checks/', 'src/private.ts']);
  assert.equal(resumed.scopeRevisions!.length, 2);
  assert.equal(resumed.scopeRevisions![0].scope.writeScope.mode, 'advisory');
  resumed.scope.writeScope.protectedPaths.push('extra.ts');
  assert.deepEqual(f.run.executionPolicySnapshot!.scope.protectedPaths, [
    'checks/',
    'src/private.ts',
  ]);
  assert.equal(f.effects(), 0);
  assert.deepEqual(
    managedToolDefinitions(f.options, resumed.scope).map((tool) => tool.name),
    ['read_file', 'edit_file'],
  );
});

test('new strict parent authority cannot widen an exact file into a retained directory on resume', () => {
  const f = fixture();
  f.input.assignment.scope.plannedPaths = ['src/'];
  const session = prepareManagedSession(f.options, f.input, 'M-owned');
  f.run.executionPolicySnapshot!.scope = {
    mode: 'strict',
    plannedPaths: ['src'],
    protectedPaths: ['checks/'],
  };
  assert.throws(
    () =>
      prepareManagedResume(f.options, session, {
        projectId: 'p',
        runId: 'R',
        workspace: '/writer',
        threadId: session.id,
        instructions: 'Continue',
      }),
    { code: 'SESSION_SCOPE_CHANGED' },
  );
  assert.equal(session.scope.writeScope.mode, 'advisory');
  assert.equal(session.scopeRevisions!.length, 1);
  assert.equal(f.effects(), 0);
});

test('frozen review authority is bound to its owning run, base and view and never grants mutable source tools', () => {
  const f = fixture();
  const view = {
    version: 1 as const,
    id: 'issued',
    projectId: 'p',
    runId: 'R',
    sourceWorkspace: '/writer',
    readRoot: '/frozen',
    outputRoot: '/outputs',
    base: f.run.baseCommit!,
    tree: 'b'.repeat(40),
    outputPaths: [],
  };
  f.run.verificationView = view;
  const review = prepareManagedSession(
    f.options,
    {
      projectId: 'p',
      runId: 'R',
      workspace: view.readRoot,
      purpose: 'review',
      readOnly: true,
      instructions: 'Review',
    },
    'M-review',
  );
  assert.deepEqual(managedBudgetOwner(f.options, review), { projectId: 'p', ownerRunId: 'R' });
  assert.deepEqual(
    managedToolDefinitions(f.options, review.scope).map((tool) => tool.name),
    ['read_file'],
  );
  f.run.baseCommit = 'c'.repeat(40);
  assert.throws(() => assertManagedCurrentWorkspace(f.options, review), {
    code: 'SESSION_MISMATCH',
  });
  f.run.baseCommit = view.base;
  f.state.runs = [];
  assert.throws(() => assertManagedCurrentWorkspace(f.options, review), {
    code: 'SESSION_MISMATCH',
  });
  assert.equal(f.effects(), 0);
});

test('explicit resume cannot erase an unknown generation or pending tool effect', () => {
  const f = fixture();
  const session = prepareManagedSession(f.options, f.input, 'M-owned');
  session.generation = { requestId: 'pending', outcome: 'unknown' };
  assert.throws(
    () =>
      prepareManagedResume(f.options, session, {
        projectId: 'p',
        runId: 'R',
        workspace: '/writer',
        threadId: session.id,
        instructions: 'Continue',
      }),
    { code: 'GENERATION_RECONCILIATION_REQUIRED' },
  );
  session.generation.outcome = 'completed';
  session.actions.push({
    id: 'A',
    turnId: 'T',
    call: { id: 'call', name: 'edit_file', arguments: {} },
    status: 'pending',
  });
  assert.throws(() => assertManagedReconciled(session), { code: 'ACTION_RECONCILIATION_REQUIRED' });
  assert.equal(f.effects(), 0);
});

test('tool declaration cannot mutate the canonical scope or remove read-only filtering', () => {
  const f = fixture();
  const session = prepareManagedSession(
    f.options,
    { projectId: 'p', runId: 'R', workspace: '/writer', readOnly: true, instructions: 'Inspect' },
    'M-reader',
  );
  const before = structuredClone(session.scope);
  f.options.tools.definitions = (scope) => {
    scope.readOnly = false;
    scope.writeScope.mode = 'advisory';
    scope.writeScope.protectedPaths = [];
    return ['read_file', 'edit_file', 'run_command'].map((name) => ({
      name,
      description: name,
      parameters: {},
    }));
  };
  assert.deepEqual(
    managedToolDefinitions(f.options, session.scope).map((tool) => tool.name),
    ['read_file'],
  );
  assert.deepEqual(session.scope, before);
});
