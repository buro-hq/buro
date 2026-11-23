import test from 'node:test';
import assert from 'node:assert/strict';
import { ManagedLimitsSchema } from '../protocol/resource-builtins.ts';
import { ProjectProfileSchema } from '../protocol/projects.ts';

test('model limits accept backend-sized windows and small explicit allowances without product ceilings', () => {
  assert.deepEqual(ManagedLimitsSchema.parse({ contextTokens: 1048576, maxOutputTokens: 131072 }), {
    contextTokens: 1048576,
    maxOutputTokens: 131072,
  });
  assert.equal(
    ManagedLimitsSchema.parse({ contextTokens: 2, maxOutputTokens: 1 }).maxOutputTokens,
    1,
  );
  for (const values of [
    { contextTokens: 100, maxOutputTokens: 100 },
    { contextTokens: 100, maxOutputTokens: 0 },
    { contextTokens: Infinity, maxOutputTokens: 10 },
    { contextTokens: 100, maxOutputTokens: 1.5 },
  ])
    assert.equal(ManagedLimitsSchema.safeParse(values).success, false);
});

test('project configuration accepts more checks, setup commands and components than former fixed counts', () => {
  const commands = Array.from({ length: 20 }, (_, index) => ({
    id: 'check_' + index,
    title: 'Check ' + index,
    command: 'true',
    timeoutMs: 1000,
  }));
  const profile = ProjectProfileSchema.parse({
    version: 1,
    revision: 1,
    context: '',
    scope: { mode: 'advisory', plannedPaths: [], protectedPaths: [] },
    checks: commands,
    defaultCheckIds: commands.map((command) => command.id),
    setup: commands,
    dependencies: 'none',
    turnTimeoutMs: 10000,
    components: commands.map((command) => ({
      id: command.id,
      name: command.title,
      kind: 'library',
      path: 'src/',
      command: '',
      port: 0,
      readyPath: '',
      instructions: '',
      evidence: '',
    })),
  });
  assert.equal(profile.checks.length, 20);
  assert.equal(profile.setup.length, 20);
  assert.equal(profile.components?.length, 20);
});
