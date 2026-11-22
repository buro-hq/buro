import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  ToolContributionCatalog,
  type RepositoryToolOperations,
} from '../core/tool-contributions.ts';
import type { ToolScope } from '../core/model-ports.ts';

test('retained nested schemas cannot silently retarget a registered tool before its first invocation', async () => {
  const schema = z.strictObject({ target: z.object({ path: z.string() }) });
  const catalog = new ToolContributionCatalog();
  let calls = 0;
  catalog.register({
    name: 'nested_probe',
    revision: 'v1',
    description: 'Validate nested arguments without invoking a workspace operation.',
    effect: 'read',
    schema,
    async execute(input) {
      calls++;
      return { content: input.target.path };
    },
  });
  catalog.seal();
  const registered = catalog.get('nested_probe');
  const revision = catalog.revision;
  const parameters = structuredClone(registered.parameters);
  // A plugin retained its own source schema. The host must detach it or reject drift explicitly.
  (schema.shape.target.def.shape as Record<string, unknown>).path = z.number();
  const operations = {} as RepositoryToolOperations;
  const changed = (error: unknown) =>
    ['TOOL_CONFIGURATION_CHANGED', 'TOOL_CONTRIBUTION_CHANGED'].includes(
      (error as { code?: string })?.code || '',
    );
  let driftRejected = false;
  try {
    assert.deepEqual(await registered.invoke({ target: { path: 'src/value.ts' } }, operations), {
      content: 'src/value.ts',
    });
  } catch (error) {
    assert.ok(
      changed(error),
      'A retained schema change must be an explicit configuration failure.',
    );
    driftRejected = true;
  }
  await assert.rejects(
    registered.invoke({ target: { path: 42 } }, operations),
    (error: unknown) => changed(error) || (error as { code?: string })?.code === 'TOOL_ARGUMENTS',
  );
  assert.equal(calls, driftRejected ? 0 : 1);
  assert.deepEqual(registered.parameters, parameters);
  try {
    assert.equal(catalog.revision, revision);
  } catch (error) {
    assert.ok(changed(error));
  }
});

test('catalog liveness checks do not evaluate a schema default factory as a host side effect', async () => {
  let defaults = 0;
  const catalog = new ToolContributionCatalog();
  catalog.register({
    name: 'default_probe',
    revision: 'v1',
    description: 'Use a default only when parsing an actual tool invocation.',
    effect: 'read',
    schema: z.strictObject({
      value: z.string().default(() => {
        defaults++;
        return 'fallback';
      }),
    }),
    async execute(input) {
      return { content: input.value };
    },
  });
  catalog.seal();
  const afterRegistration = defaults;
  const scope: ToolScope = {
    projectId: 'p',
    sessionId: 'S',
    workspace: '/unused',
    readOnly: true,
    writeScope: { mode: 'advisory', plannedPaths: [], protectedPaths: [] },
    commands: [],
    materials: [],
  };
  for (let i = 0; i < 3; i++) {
    assert.ok(catalog.revision);
    assert.equal(catalog.get('default_probe').name, 'default_probe');
    assert.equal(catalog.definitions(scope).length, 1);
  }
  assert.equal(defaults, afterRegistration);
  assert.deepEqual(await catalog.get('default_probe').invoke({}, {} as RepositoryToolOperations), {
    content: 'fallback',
  });
  assert.equal(defaults, afterRegistration + 1);
});
