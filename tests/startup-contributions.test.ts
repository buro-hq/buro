import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import { createHost } from '../plugins/host.ts';
import { ContextLoaderCatalog } from '../core/context-loaders.ts';
import { ProjectAnalysisCatalog } from '../core/project-analysis.ts';
import { ToolContributionCatalog } from '../core/tool-contributions.ts';
import { RepositoryTools } from '../adapters/tools/repository-tools.ts';
import { EnvironmentExecutors } from '../adapters/environments/executors.ts';
import type { ContextMaterial } from '../protocol/context.ts';
import type { ToolScope } from '../core/model-ports.ts';

test('explicit startup catalogs replace defaults and execute through the same bounded host ports', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buro-startup-')));
  const contextLoaders = new ContextLoaderCatalog();
  let loads = 0;
  contextLoaders.register({
    id: 'custom-pdf',
    revision: 'pdf-v2',
    matches: ({ name }) => name.endsWith('.pdf'),
    async load(input) {
      assert.deepEqual(Object.keys(input).sort(), ['bytes', 'name']);
      assert.equal(new TextDecoder().decode(input.bytes), '%PDF-synthetic');
      loads++;
      return { mimeType: 'text/plain', representation: 'text', text: 'Custom PDF content' };
    },
  });
  const analyses = new ProjectAnalysisCatalog();
  const tools = new ToolContributionCatalog();
  tools.register({
    name: 'read_source',
    revision: 'source-v1',
    description: 'Read a source file',
    effect: 'read',
    schema: z.strictObject({ path: z.string() }),
    execute: (input, operations) => operations.readFile(input),
  });
  const host = await createHost({
    projects: [
      { storageAddress: path.join(root, '.buro'), project: { id: 'p', name: 'Synthetic', root } },
    ],
    projectContributions: { contextLoaders, analyses },
    toolContributions: tools,
  });
  t.after(async () => {
    await host.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  const materials = (await host.ctx.commands.bus.execute(
    {
      method: 'context.import',
      params: {
        projectId: 'p',
        scope: 'project',
        upload: {
          name: 'requirements.pdf',
          base64: Buffer.from('%PDF-synthetic').toString('base64'),
        },
      },
    },
    { id: 'pdf-import', fingerprint: 'pdf-import' },
  )) as ContextMaterial[];
  assert.equal(loads, 1);
  assert.deepEqual(materials[0].loader, { id: 'custom-pdf', revision: 'pdf-v2' });
  assert.deepEqual(host.ctx.projectContributions.analyses.list(), []);
  assert.throws(() => contextLoaders.register({} as any), { code: 'CONTEXT_LOADERS_SEALED' });
  assert.throws(() => analyses.register({} as any), { code: 'PROJECT_ANALYSES_SEALED' });
  assert.throws(() => tools.register({} as any), { code: 'TOOL_CONTRIBUTIONS_SEALED' });
  await fs.writeFile(path.join(root, 'source.txt'), 'Original source');
  await fs.writeFile(path.join(root, '.env'), 'PRIVATE_SENTINEL');
  const grant: ToolScope = {
    projectId: 'p',
    sessionId: 'session',
    workspace: root,
    readOnly: true,
    writeScope: { mode: 'advisory', plannedPaths: [], protectedPaths: [] },
    materials: [],
    commands: [],
  };
  const broker = new RepositoryTools(
    new EnvironmentExecutors(),
    host.ctx.toolContributions.catalog,
  );
  assert.deepEqual(
    broker.definitions(grant).map((tool) => tool.name),
    ['read_source'],
  );
  const read = (file: string) =>
    broker.execute({ id: 'wire', name: 'read_source', arguments: { path: file } }, grant, {
      actionId: 'host-action',
      signal: new AbortController().signal,
    });
  assert.match((await read('source.txt')).content, /Original source/);
  const denied = await read('.env');
  assert.equal(denied.isError, true);
  assert.doesNotMatch(denied.content, /PRIVATE_SENTINEL/);
});
