import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Plugin } from 'cordis';
import { createRuntimeResources } from '../adapters/resources/runtime-resources.ts';
import { FileRuntimeRoutes } from '../adapters/files/runtime-routes.ts';
import type { EnvironmentExecutors } from '../adapters/environments/executors.ts';
import { RuntimeRouter } from '../core/runtime-router.ts';
import { runtimePlugin } from './runtime.ts';
import type { ManagedRequestPolicy } from '../core/request-policy.ts';
import type { ManagedRunBudgetPort } from '../core/run-budget.ts';
import type { WorkspacePort } from '../core/execution-ports.ts';
import type { SegmentEvidencePort, WorkSegmentPolicy } from '../core/work-segments.ts';

export const resourcesPlugin: Plugin.Object<{
  directory: string;
  executors: EnvironmentExecutors;
  fetch?: typeof fetch;
  codex?: { executable?: string; args?: string[] };
  credentials?: (reference: string) => string | undefined;
  requestPolicy?: ManagedRequestPolicy;
  budgets?: ManagedRunBudgetPort;
  workspaces?: Pick<WorkspacePort, 'changes'>;
  segmentPolicy?: WorkSegmentPolicy;
  segmentEvidence?: SegmentEvidencePort;
}> = {
  name: 'execution-resources',
  inject: ['projects', 'commands'],
  async apply(ctx, options) {
    const resources = await createRuntimeResources({ ...options, projects: ctx.projects.registry });
    ctx.effect(() => () => resources.dispose());
    const config = resources.configuration.snapshot();
    const defaultRuntimeId = config.profiles.find(
      (profile) => profile.id === config.defaultProfile,
    )!.coordinator;
    await ctx.plugin(runtimePlugin, {
      runtimes: resources.runtimes,
      defaultRuntimeId,
      selection: resources.selection,
      route: (registry) =>
        new RuntimeRouter({
          registry,
          selection: resources.selection,
          projects: ctx.projects.registry,
          resources: resources.resources,
          routes: new FileRuntimeRoutes(path.join(options.directory, 'local/runtime-routes')),
          id: randomUUID,
        }),
    });
    ctx.effect(() =>
      ctx.commands.bus.register('resources.list', (params) => resources.list(params.projectId)),
    );
    ctx.effect(() =>
      ctx.commands.bus.register('resources.init', () => resources.configuration.init()),
    );
    ctx.effect(() =>
      ctx.commands.bus.register('resources.models', (params) =>
        resources.models(params.connectionId),
      ),
    );
    ctx.effect(() =>
      ctx.commands.bus.register('resources.probe', (params, meta) =>
        resources.probe(params.runtimeId, meta),
      ),
    );
    ctx.effect(() =>
      ctx.commands.bus.register('resources.use', (params, meta) =>
        resources.configuration.use(meta.id, meta.fingerprint, params.profileId),
      ),
    );
    ctx.effect(() =>
      ctx.commands.bus.register('resources.connection.save', (params, meta) =>
        resources.saveConnection(params.connection, params.expectedRevision, meta),
      ),
    );
    ctx.on('project/snapshot', (snapshot) => {
      snapshot.capabilities.push(
        'resources.list',
        'resources.models',
        'resources.probe',
        'resources.use',
        'resources.connection.save',
      );
    });
  },
};
