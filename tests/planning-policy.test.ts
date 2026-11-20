import assert from 'node:assert/strict';
import test from 'node:test';
import { DomainError } from '../core/ports.ts';
import { materialInstructions, type ContextMaterial } from '../protocol/context.ts';
import {
  boundedPlanningTurn,
  MAX_PLANNING_INPUT_BYTES,
  planningBaseline,
} from '../core/planning-policy.ts';

const input = () => ({
  title: 'Preserve session data',
  goalText:
    'Make session writes atomic.\nAcceptance criteria:\nKeep the synchronous API.\nRetain old bytes after failed rename.',
  allowedPaths: ['src/session.ts'],
  protectedPaths: ['checks/', 'AGENTS.md'],
  projectContext: 'Keep compatibility with the installed runtime.',
  maxWorkers: 2,
  roles: [
    {
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
      id: 'local-qwen',
      client: 'managed' as const,
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

function brief(text: string) {
  return JSON.parse(text.split('Brief: ')[1].split('\nCorrect the previous plan: ')[0]);
}

test('bounded planning disables tools explicitly and retains goal, constraints and frozen routing', () => {
  const source = input();
  const request = boundedPlanningTurn(source);
  const saved = brief(request.text);
  assert.equal(request.toolPolicy, 'none');
  assert.match(request.text, /No tools, inspection/);
  assert.match(request.text, /Discovery is for implementation/);
  assert.equal(saved.goal, source.goalText);
  assert.equal(saved.projectContext, source.projectContext);
  assert.deepEqual(saved.scope.allowedPaths, source.allowedPaths);
  assert.deepEqual(saved.scope.protectedPaths, source.protectedPaths);
  assert.equal(saved.roles[0].id, 'builder');
  assert.equal(saved.roles[0].version, 3);
  assert.deepEqual(saved.roles[0].runtimePreference, source.roles[0].runtimePreference);
  assert.deepEqual(saved.workerRuntimes, [
    { id: 'local-qwen', client: 'managed', providerId: 'ollama', model: 'qwen3:4b', local: true },
  ]);
  assert.deepEqual(input(), source, 'Building the brief must not mutate its frozen inputs');
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
  const request = boundedPlanningTurn({ ...input(), baseline: { passed: 15, total: 16, results } });
  assert.ok(new TextEncoder().encode(request.text).length < MAX_PLANNING_INPUT_BYTES);
});

test('planning preserves required input or fails before a model request instead of truncating criteria', () => {
  for (const oversized of [
    { goalText: 'Required criterion '.repeat(MAX_PLANNING_INPUT_BYTES) },
    { projectContext: 'Required project instruction '.repeat(MAX_PLANNING_INPUT_BYTES) },
    { sessionInstructions: 'Reusable coordinator instruction '.repeat(MAX_PLANNING_INPUT_BYTES) },
    { allowedPaths: Array.from({ length: MAX_PLANNING_INPUT_BYTES }, (_, i) => 'src/' + i) },
  ])
    assert.throws(
      () => boundedPlanningTurn({ ...input(), ...oversized }),
      (error: unknown) => error instanceof DomainError && error.code === 'PLANNING_INPUT_TOO_LARGE',
    );
});

test('planning descriptions and validation corrections cannot grow the planning input without bound', () => {
  const source = input();
  source.roles[0].description = 'Role summary '.repeat(10000);
  const request = boundedPlanningTurn({ ...source, correction: 'Invalid roleId '.repeat(10000) });
  const saved = brief(request.text);
  assert.match(saved.roles[0].description, /\[shortened\]$/);
  assert.match(request.text, /Correct the previous plan: /);
  assert.ok(new TextEncoder().encode(request.text).length < MAX_PLANNING_INPUT_BYTES);
});

test('v2 same-thread correction retains exact validation error without repeating the required brief', () => {
  const source = input();
  const correction =
    'steps.owner must exactly match a worker roleId.\n' + 'Precise diagnostic '.repeat(90);
  const first = boundedPlanningTurn({ ...source, revision: 'bounded-planning-v2' });
  const retry = boundedPlanningTurn({
    ...source,
    revision: 'bounded-planning-v2',
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

test('saved v1 corrections preserve the original full-brief algorithm and first v2 turn never reuses absent history', () => {
  const source = input();
  const retry = boundedPlanningTurn({
    ...source,
    revision: 'bounded-planning-v1',
    reuseBrief: true,
    correction: 'Fix owner',
  });
  assert.equal(brief(retry.text).goal, source.goalText);
  const first = boundedPlanningTurn({
    ...source,
    revision: 'bounded-planning-v2',
    correction: 'Fix owner',
  });
  assert.equal(brief(first.text).goal, source.goalText);
});

test('a role change sends the updated pinned catalog with compact v2 correction', () => {
  const source = input();
  source.roles[0].version = 4;
  source.roles[0].runtimePreference = { mode: 'fixed', runtimeId: 'replacement-model' };
  const retry = boundedPlanningTurn({
    ...source,
    revision: 'bounded-planning-v2',
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
  assert.doesNotMatch(instructions, /Read relevant materials before planning/);
  assert.match(
    materialInstructions(materials, '/workspace', true),
    /Read relevant materials before planning/,
  );
});
