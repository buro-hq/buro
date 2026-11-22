import { fixtureCapabilities } from './fixtures/backend-capabilities.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { DomainError } from '../core/ports.ts';
import { materialInstructions, type ContextMaterial } from '../protocol/context.ts';
import { teamOutputSchema } from '../protocol/execution.ts';
import { PlanningPolicySchema } from '../protocol/planning-policy.ts';
import {
  planningTurn,
  MAX_PLANNING_INPUT_BYTES,
  planningBaseline,
  planningOutputSchema,
  selectPlanningPolicy,
  assertPlanningPolicy,
} from '../core/planning-policy.ts';

const coordinator = {
  id: 'custom-coordinator',
  backendId: 'codex' as const,
  local: false,
  configurationRevision: 'configured-v1',
  capabilities: fixtureCapabilities({ structuredTurns: true, toolsFreeTurns: true }),
};
const input = () => ({
  policy: selectPlanningPolicy(coordinator),
  title: 'Preserve session data',
  goalText:
    'Make session writes atomic.\nAcceptance criteria:\nKeep the synchronous API.\nRetain old bytes after failed rename.',
  scope: {
    mode: 'advisory' as const,
    plannedPaths: ['src/session.ts'],
    protectedPaths: ['checks/', 'AGENTS.md'],
  },
  projectContext: 'Keep compatibility with the installed runtime.',
  maxWorkers: 2,
  roles: [
    {
      provenance: { origin: 'user' },
      id: 'builder',
      version: 3,
      title: 'Builder',
      description: 'Implements scoped changes',
      instructions: 'A reusable implementation role.',
      kind: 'implementation' as const,
      runtimePreference: { mode: 'fixed' as const, runtimeId: 'local-qwen' },
      createdAt: 'now',
      updatedAt: 'now',
    },
  ],
  pool: [
    {
      capabilities: fixtureCapabilities(),
      id: 'local-qwen',
      backendId: 'managed' as const,
      providerId: 'ollama',
      model: 'qwen3:4b',
      local: true,
      configurationRevision: 'saved-connection-revision',
    },
  ],
  baseline: {
    passed: 0,
    total: 1,
    results: [{ name: 'Session tests', passed: false, exitCode: 1 }],
  },
});

test('planning output grammar narrows the frozen worker bound without mutating any other constraint', () => {
  const original = structuredClone(teamOutputSchema);
  for (const [maxWorkers, cap] of [
    [0, 0],
    [1, 1],
    [2, 2],
    [50, 2],
  ]) {
    const schema = planningOutputSchema(teamOutputSchema, maxWorkers);
    const team = (schema.properties as Record<string, Record<string, unknown>>).team;
    assert.equal(team.maxItems, cap);
    team.maxItems = 2;
    assert.deepEqual(schema, original, 'Every other schema property must remain unchanged');
    assert.notEqual(schema, teamOutputSchema);
  }
  assert.deepEqual(teamOutputSchema, original);
  const uncapped = {
    type: 'object',
    properties: { team: { type: 'array', items: { type: 'string' } } },
  };
  assert.equal((planningOutputSchema(uncapped, 1).properties as any).team.maxItems, 1);
  for (const maxWorkers of [-1, 1.5, Number.NaN])
    assert.throws(() => planningOutputSchema(teamOutputSchema, maxWorkers), {
      code: 'INVALID_PLANNING_SCHEMA',
    });
});

test('planning strategy follows frozen capabilities rather than recognizable client labels', () => {
  for (const client of ['codex', 'managed'] as const) {
    const toolsFree = { ...coordinator, client, id: 'vendor-specific-runtime' };
    assert.equal(selectPlanningPolicy(toolsFree).strategy, 'tools-free-structured');
    const inspection = {
      ...toolsFree,
      capabilities: fixtureCapabilities({ structuredTurns: true, readOnlySessions: true }),
    };
    assert.equal(selectPlanningPolicy(inspection).strategy, 'read-only-inspection');
    for (const capabilities of [
      fixtureCapabilities(),
      fixtureCapabilities({ structuredTurns: true }),
      fixtureCapabilities({ readOnlySessions: true }),
    ])
      assert.throws(() => selectPlanningPolicy({ ...toolsFree, capabilities }), {
        code: 'PLANNING_UNSUPPORTED',
      });
  }
});

test('strategy bindings reject a changed backend, configuration, descriptor revision or mechanics', () => {
  const policy = selectPlanningPolicy(coordinator);
  assert.equal(Object.isFrozen(policy), true);
  assert.doesNotThrow(() => assertPlanningPolicy(policy, coordinator));
  for (const changed of [
    { ...coordinator, id: 'another-runtime' },
    { ...coordinator, configurationRevision: 'configured-v2' },
    { ...coordinator, capabilities: { ...coordinator.capabilities, revision: 'backend-v2' } },
    {
      ...coordinator,
      capabilities: fixtureCapabilities({ structuredTurns: true, readOnlySessions: true }),
    },
  ])
    assert.throws(() => assertPlanningPolicy(policy, changed), { code: 'INVALID_PLANNING_POLICY' });
});

test('planning strategies require explicit identity and reject obsolete client-bound modes', () => {
  const policy = selectPlanningPolicy(coordinator);
  for (const key of ['runtimeId', 'configurationRevision', 'capabilitiesRevision', 'strategy']) {
    const missing = { ...policy } as Record<string, unknown>;
    delete missing[key];
    assert.equal(PlanningPolicySchema.safeParse(missing).success, false, key);
  }
  for (const mode of ['bounded', 'legacy'])
    assert.equal(
      PlanningPolicySchema.safeParse({ version: 1, mode, revision: 'bounded-planning-v3' }).success,
      false,
    );
  assert.throws(() => selectPlanningPolicy({ ...coordinator, capabilities: undefined } as never), {
    code: 'INVALID_BACKEND_CAPABILITIES',
  });
});

test('inspection planning permits read-only investigation without claiming tools-free enforcement', () => {
  const policy = selectPlanningPolicy({
    ...coordinator,
    capabilities: fixtureCapabilities({ structuredTurns: true, readOnlySessions: true }),
  });
  const request = planningTurn({ ...input(), policy });
  assert.equal(request.toolPolicy, undefined);
  assert.match(request.text, /inspect the repository read-only/);
  assert.match(request.text, /Never edit files/);
  assert.equal(brief(request.text).goal, input().goalText);
  const retry = planningTurn({ ...input(), policy, reuseBrief: true, correction: 'Fix owner' });
  assert.equal(retry.toolPolicy, undefined);
  assert.match(retry.text, /read-only; no edits/);
  assert.doesNotMatch(retry.text, /Brief:/);
});

function brief(text: string) {
  return JSON.parse(text.split('Brief: ')[1].split('\nCorrect the previous plan: ')[0]);
}

test('bounded planning disables tools explicitly and retains goal, constraints and frozen routing', () => {
  const source = input();
  const request = planningTurn(source);
  const saved = brief(request.text);
  assert.equal(request.toolPolicy, 'none');
  assert.match(request.text, /No tools, inspection/);
  assert.match(request.text, /Discovery is for implementation/);
  assert.equal(saved.goal, source.goalText);
  assert.equal(saved.projectContext, source.projectContext);
  assert.deepEqual(saved.scope, source.scope);
  assert.equal(saved.roles[0].id, 'builder');
  assert.equal(saved.roles[0].version, 3);
  assert.deepEqual(saved.roles[0].runtimePreference, source.roles[0].runtimePreference);
  assert.deepEqual(saved.workerRuntimes, [
    { id: 'local-qwen', providerId: 'ollama', model: 'qwen3:4b', local: true },
  ]);
  assert.deepEqual(input(), source, 'Building the brief must not mutate its frozen inputs');
});

test('planning instructions describe advisory discovery and explicit strict authority without changing tools-free behavior', () => {
  const source = input();
  const advisory = planningTurn({ ...source, scope: { ...source.scope, plannedPaths: [] } });
  assert.match(advisory.text, /Scope is advisory/);
  assert.match(advisory.text, /empty list when discovery is needed/);
  assert.deepEqual(brief(advisory.text).scope.plannedPaths, []);
  assert.equal(advisory.toolPolicy, 'none');
  const strict = planningTurn({ ...source, scope: { ...source.scope, mode: 'strict' } });
  assert.match(strict.text, /Scope is strict/);
  assert.match(strict.text, /Protected paths are forbidden/);
  assert.deepEqual(brief(strict.text).scope, { ...source.scope, mode: 'strict' });
  assert.equal(strict.toolPolicy, 'none');
});

test('planning bounds baseline diagnostics, prioritizes failures and marks omitted evidence', () => {
  const results = [
    ...Array.from({ length: 15 }, (_, index) => ({ name: 'Passing ' + index, passed: true })),
    {
      name: 'Failure',
      passed: false,
      output: 'log '.repeat(10000),
      error: 'failure '.repeat(1000),
    },
  ];
  const summary = planningBaseline({ passed: 15, total: 16, results });
  assert.equal(summary.passed, 15);
  assert.equal(summary.total, 16);
  assert.equal(summary.results.length, 12);
  assert.equal(summary.omittedResults, 4);
  assert.equal(summary.results[0].name, 'Failure');
  assert.match(summary.results[0].output!, /\[shortened\]$/);
  assert.match(summary.results[0].error!, /\[shortened\]$/);
  assert.ok(summary.results[0].output!.length < 500);
  assert.equal(results[0].name, 'Passing 0');
  const request = planningTurn({ ...input(), baseline: { passed: 15, total: 16, results } });
  assert.ok(new TextEncoder().encode(request.text).length < MAX_PLANNING_INPUT_BYTES);
});

test('planning preserves required input or fails before a model request instead of truncating criteria', () => {
  for (const oversized of [
    { goalText: 'Required criterion '.repeat(MAX_PLANNING_INPUT_BYTES) },
    { projectContext: 'Required project instruction '.repeat(MAX_PLANNING_INPUT_BYTES) },
    { sessionInstructions: 'Reusable coordinator instruction '.repeat(MAX_PLANNING_INPUT_BYTES) },
    {
      scope: {
        ...input().scope,
        plannedPaths: Array.from({ length: MAX_PLANNING_INPUT_BYTES }, (_, i) => 'src/' + i),
      },
    },
  ])
    assert.throws(
      () => planningTurn({ ...input(), ...oversized }),
      (error: unknown) => error instanceof DomainError && error.code === 'PLANNING_INPUT_TOO_LARGE',
    );
});

test('planning descriptions and validation corrections cannot grow the planning input without bound', () => {
  const source = input();
  source.roles[0].description = 'Role summary '.repeat(10000);
  const request = planningTurn({ ...source, correction: 'Invalid roleId '.repeat(10000) });
  const saved = brief(request.text);
  assert.match(saved.roles[0].description, /\[shortened\]$/);
  assert.match(request.text, /Correct the previous plan: /);
  assert.ok(new TextEncoder().encode(request.text).length < MAX_PLANNING_INPUT_BYTES);
});

test('same-thread correction retains exact validation error without repeating the required brief', () => {
  const source = input();
  const correction =
    'steps.owner must exactly match a worker roleId.\n' + 'Precise diagnostic '.repeat(90);
  const first = planningTurn({ ...source });
  const retry = planningTurn({
    ...source,
    reuseBrief: true,
    correction,
  });
  assert.equal(brief(first.text).goal, source.goalText);
  assert.equal(retry.toolPolicy, 'none');
  assert.ok(
    retry.text.endsWith(correction),
    'The correction must retain the exact validation error',
  );
  assert.doesNotMatch(retry.text, /Brief: /);
  assert.ok(!retry.text.includes(source.goalText));
  assert.match(retry.text, /saved brief and constraints in this thread/);
  assert.match(retry.text, /complete plan, not a patch/);
});

test('the first correction includes the full brief unless this same thread already has it', () => {
  const source = input();
  const first = planningTurn({ ...source, correction: 'Fix owner' });
  assert.equal(brief(first.text).goal, source.goalText);
  assert.equal(first.toolPolicy, 'none');
});

test('a role change sends the updated pinned catalog with compact correction', () => {
  const source = input();
  source.roles[0].version = 4;
  source.roles[0].runtimePreference = { mode: 'fixed', runtimeId: 'replacement-model' };
  const retry = planningTurn({
    ...source,
    reuseBrief: true,
    roleCatalogChanged: true,
    correction: 'Role builder changed during planning.',
  });
  const catalog = JSON.parse(
    retry.text.split('Updated role catalog (replaces the previous catalog): ')[1],
  );
  assert.equal(catalog[0].version, 4);
  assert.equal(catalog[0].runtimePreference.runtimeId, 'replacement-model');
  assert.doesNotMatch(retry.text, /Brief: /);
});

test('bounded material references preserve scope and staged paths while deferring reads to implementation', () => {
  const materials: ContextMaterial[] = ['project', 'goal'].map((scope, index) => ({
    id: 'M-' + index,
    name: scope + ' requirements',
    scope: scope as 'project' | 'goal',
    mimeType: 'text/plain',
    size: 20,
    hash: String(index).repeat(64),
    relativePath: 'local/context/' + String(index).repeat(64) + '.txt',
    active: true,
    createdAt: 'now',
    note: 'Preserve requirements in this material.',
  }));
  const instructions = materialInstructions(materials, '/workspace', true, {
    deferPlanningReads: true,
  });
  assert.match(instructions, /project requirements/);
  assert.match(instructions, /\(project, text\/plain/);
  assert.match(instructions, /\(goal, text\/plain/);
  assert.ok(instructions.includes('/workspace/.buro/context/' + '0'.repeat(64) + '.txt'));
  assert.match(instructions, /explicit discovery step during implementation/);
  assert.match(instructions, /use assignment null/);
  assert.doesNotMatch(instructions, /Read relevant text materials before planning/);
  assert.match(
    materialInstructions(materials, '/workspace', true),
    /Read relevant text materials before planning/,
  );
});
