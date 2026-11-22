import { createBuiltinWorkflowRoles } from '../adapters/workflows/builtins.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkScopeSchema, ScopeObservationSchema, type WorkScope } from '../protocol/work-scope.ts';
import { ExecutionPolicySchema } from '../protocol/execution-policy.ts';
import { ProjectProfileSchema } from '../protocol/projects.ts';
import { SnapshotSchema, DomainEventSchema } from '../protocol/schema.ts';
import { TeamPlanSchema } from '../protocol/execution.ts';
import {
  hardPathAllowed,
  matchesPlannedPath,
  writeAllowed,
  planPathAllowed,
  resolveTeam,
} from '../core/execution-ports.ts';
import { executionPolicy } from '../adapters/files/project-manager.ts';
import type { ExecutionPolicy } from '../core/execution-ports.ts';
import type { ProjectProfile } from '../protocol/domain.ts';

const advisory: WorkScope = {
  mode: 'advisory',
  plannedPaths: ['src/'],
  protectedPaths: ['AGENTS.md', 'secrets/'],
};
const strict: WorkScope = { ...advisory, mode: 'strict' };
const policy: ExecutionPolicy = {
  scope: advisory,
  checks: [],
  defaultCheckIds: [],
  maxWorkers: 2,
  turnTimeoutMs: 10000,
};
const profile: ProjectProfile = {
  version: 1,
  revision: 1,
  context: '',
  scope: advisory,
  setup: [],
  dependencies: 'none',
  checks: [],
  defaultCheckIds: [],
  maxWorkers: 2,
  turnTimeoutMs: 10000,
};

test('advisory plans permit necessary adjacent changes while strict plans deny them', () => {
  for (const file of ['src/index.ts', 'src/nested/helper.ts']) {
    assert.equal(writeAllowed(file, advisory), true, file);
    assert.equal(writeAllowed(file, strict), true, file);
  }
  for (const file of ['package.json', 'tests/index.test.ts', 'src-other/entry.ts']) {
    assert.equal(matchesPlannedPath(file, advisory.plannedPaths), false, file);
    assert.equal(writeAllowed(file, advisory), true, file);
    assert.equal(writeAllowed(file, strict), false, file);
  }
  const discovered = { ...advisory, plannedPaths: [] };
  assert.equal(WorkScopeSchema.safeParse(discovered).success, true);
  assert.equal(writeAllowed('new-folder/file.ts', discovered), true);
  assert.equal(WorkScopeSchema.safeParse({ ...discovered, mode: 'strict' }).success, false);
});

test('hard boundaries survive root-wide plans and both user-selected scope modes', () => {
  const denied = [
    '/tmp/outside.ts',
    '../outside.ts',
    'src/../../outside.ts',
    'src/../package.json',
    'C:/outside.ts',
    './C:/outside.ts',
    'C:\\outside.ts',
    '\\\\server\\share',
    '.git/config',
    './.git/config',
    '.GIT/config',
    '.buro/control-state.json',
    'node_modules/pkg/index.js',
    'packages/p/node_modules/pkg/index.js',
    'src/.buro/control.json',
    'src/line\nbreak.ts',
    'src/zero\0.ts',
    '',
    'AGENTS.md',
    './AGENTS.md',
    'secrets/key',
    './secrets//key',
  ];
  for (const mode of ['advisory', 'strict'] as const)
    for (const file of denied) {
      assert.equal(
        hardPathAllowed(file, advisory.protectedPaths),
        false,
        `${mode}: ${JSON.stringify(file)}`,
      );
      assert.equal(
        writeAllowed(file, { ...advisory, mode, plannedPaths: ['./'] }),
        false,
        `${mode}: ${JSON.stringify(file)}`,
      );
    }
  for (const file of [
    'src/name..ts',
    './src/helper.ts',
    'src/./helper.ts',
    'src//helper.ts',
    'docs/architecture.md',
  ])
    assert.equal(hardPathAllowed(file, advisory.protectedPaths), true, file);
});

test('planned and protected matches use complete path segments and safe relative aliases', () => {
  assert.equal(matchesPlannedPath('src/helper.ts', ['./src/']), true);
  assert.equal(matchesPlannedPath('./src/helper.ts', ['src/']), true);
  assert.equal(matchesPlannedPath('src2/helper.ts', ['src/']), false);
  assert.equal(matchesPlannedPath('src/value.ts.bak', ['src/value.ts']), false);
  assert.equal(matchesPlannedPath('src/value.ts', ['src/value.ts']), true);
  assert.equal(hardPathAllowed('src/value.ts', ['./src/value.ts']), false);
  assert.equal(hardPathAllowed('./src/value.ts', ['src/value.ts']), false);
  assert.equal(hardPathAllowed('secrets-archive/key', ['secrets/']), true);
});

test('strict child selectors cannot promote an exact file grant into a directory grant', () => {
  const exact = { ...strict, plannedPaths: ['src'] };
  assert.equal(writeAllowed('src', exact), true);
  for (const selector of ['src/', './src/', 'src//', 'src/nested/', './']) {
    assert.equal(planPathAllowed(selector, exact), false, selector);
    assert.throws(
      () =>
        resolveTeam(
          plan([selector]),
          [],
          { ...policy, scope: exact },
          'now',
          createBuiltinWorkflowRoles().workflow,
        ),
      /strict work scope/,
    );
  }
  assert.equal(planPathAllowed('./src', exact), true);
  const directory = { ...strict, plannedPaths: ['./src/'] };
  for (const selector of ['src/', './src/nested/', 'src/file.ts'])
    assert.equal(planPathAllowed(selector, directory), true, selector);
  for (const selector of ['./', 'src-other/', 'src-other/file.ts'])
    assert.equal(planPathAllowed(selector, directory), false, selector);
  assert.equal(
    planPathAllowed('src/file.ts/', { ...strict, plannedPaths: ['src/file.ts'] }),
    false,
  );
  assert.equal(planPathAllowed('./', { ...strict, plannedPaths: ['./'] }), true);
  assert.equal(planPathAllowed('tests/', advisory), true);
  assert.equal(planPathAllowed('secrets/', advisory), false);
  assert.equal(planPathAllowed('../outside/', advisory), false);
});

test('scope contracts accept no legacy authorization fields or silent defaults', () => {
  for (const value of [
    { plannedPaths: [], protectedPaths: [] },
    { ...advisory, allowedPaths: ['src/'] },
    { mode: 'advisory', plannedPaths: [] },
    { mode: 'strict', plannedPaths: [], protectedPaths: [] },
  ])
    assert.equal(WorkScopeSchema.safeParse(value).success, false);
  assert.equal(ProjectProfileSchema.safeParse(profile).success, true);
  const { scope: _scope, ...rest } = profile;
  assert.equal(
    ProjectProfileSchema.safeParse({ ...rest, allowedPaths: ['src/'], protectedPaths: [] }).success,
    false,
  );
});

test('all public policy locations use the same required scope contract', () => {
  const { turnTimeoutMs: _timeout, ...view } = policy;
  const snapshot = {
    version: 1,
    project: { id: 'p', name: 'P', root: '/repo' },
    revision: 1,
    sequence: 1,
    roles: [],
    goals: [],
    runs: [],
    capabilities: [],
    executionPolicy: view,
  };
  const event = {
    version: 1,
    id: 'e',
    projectId: 'p',
    seq: 1,
    at: 'now',
    change: { type: 'project.configured', profile, executionPolicy: view },
  };
  assert.equal(ExecutionPolicySchema.safeParse(view).success, true);
  assert.equal(SnapshotSchema.safeParse(snapshot).success, true);
  assert.equal(DomainEventSchema.safeParse(event).success, true);
  const run = {
    id: 'r',
    key: 'g',
    title: 'Goal',
    summary: '',
    createdAt: 'now',
    threadId: 'session',
    executionPolicySnapshot: policy,
    agents: [],
    events: [],
    commands: [],
    plan: [],
    changedFiles: [],
    baseline: { passed: 0, total: 0, results: [] },
    acceptance: { passed: 0, total: 0, results: [] },
    specsUnchanged: true,
    scopePreserved: true,
    independentReviewer: false,
    goalText: '',
    result: '',
    sourceHash: '',
  };
  assert.equal(SnapshotSchema.safeParse({ ...snapshot, runs: [run] }).success, true);
  const invalid = { ...view, scope: { ...advisory, mode: 'strict', plannedPaths: [] } };
  assert.equal(ExecutionPolicySchema.safeParse(invalid).success, false);
  assert.equal(SnapshotSchema.safeParse({ ...snapshot, executionPolicy: invalid }).success, false);
  assert.equal(
    DomainEventSchema.safeParse({ ...event, change: { ...event.change, executionPolicy: invalid } })
      .success,
    false,
  );
  assert.equal(
    SnapshotSchema.safeParse({
      ...snapshot,
      runs: [
        { ...run, executionPolicySnapshot: { ...invalid, turnTimeoutMs: policy.turnTimeoutMs } },
      ],
    }).success,
    false,
  );
});

function plan(paths: string[], extra?: string[]) {
  const worker = (roleId: string, paths: string[]) => ({
    roleId,
    action: 'create',
    title: roleId,
    description: 'Implement selected work',
    instructions: 'Inspect and implement the goal',
    kind: 'implementation',
    paths,
  });
  return TeamPlanSchema.parse({
    summary: 'Discover and implement',
    steps: [
      { step: 'Implement', owner: 'builder' },
      { step: 'Review', owner: 'reviewer' },
    ],
    team: [worker('builder', paths), ...(extra ? [worker('second_builder', extra)] : [])],
  });
}

test('team allocation follows advisory mode without allowing protected or unsafe proposals', () => {
  for (const paths of [[], ['package.json'], ['src/index.ts']])
    assert.equal(
      resolveTeam(plan(paths), [], policy, 'now', createBuiltinWorkflowRoles().workflow).roles
        .length,
      1,
    );
  for (const paths of [[], ['package.json']])
    assert.throws(
      () =>
        resolveTeam(
          plan(paths),
          [],
          { ...policy, scope: strict },
          'now',
          createBuiltinWorkflowRoles().workflow,
        ),
      /strict work scope/,
    );
  for (const paths of [['AGENTS.md'], ['../outside'], ['.buro/'], ['secrets/key']])
    assert.throws(
      () => resolveTeam(plan(paths), [], policy, 'now', createBuiltinWorkflowRoles().workflow),
      /unauthorized/,
    );
  assert.throws(
    () =>
      resolveTeam(
        plan(['src/'], ['./src/nested/file.ts']),
        [],
        policy,
        'now',
        createBuiltinWorkflowRoles().workflow,
      ),
    /overlapping/,
  );
  assert.throws(
    () =>
      resolveTeam(
        plan(['./src/'], ['src/file.ts']),
        [],
        policy,
        'now',
        createBuiltinWorkflowRoles().workflow,
      ),
    /overlapping/,
  );
  assert.throws(
    () =>
      resolveTeam(
        plan(['./'], ['src/file.ts']),
        [],
        policy,
        'now',
        createBuiltinWorkflowRoles().workflow,
      ),
    /overlapping/,
  );
});

test('effective policies detach scope arrays from mutable project settings', () => {
  const settings = structuredClone(profile);
  const effective = executionPolicy(settings);
  settings.scope.mode = 'strict';
  settings.scope.plannedPaths.push('tests/');
  settings.scope.protectedPaths.length = 0;
  assert.deepEqual(effective.scope, advisory);
  assert.deepEqual(effective.profile?.scope, advisory);
});

test('scope observations identify a real tree and retain denied paths as evidence', () => {
  assert.equal(
    ScopeObservationSchema.safeParse({
      mode: 'advisory',
      tree: 'a'.repeat(40),
      additionalPaths: ['package.json'],
      violations: ['../outside'],
    }).success,
    true,
  );
  assert.equal(
    ScopeObservationSchema.safeParse({
      mode: 'advisory',
      tree: 'latest',
      additionalPaths: [],
      violations: [],
    }).success,
    false,
  );
});
