import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Plugin } from 'cordis';
import { createRuntimeResources } from '../adapters/resources/runtime-resources.ts';
import { FileRuntimeRoutes } from '../adapters/files/runtime-routes.ts';
import type { EnvironmentExecutors } from '../adapters/environments/executors.ts';
import { RuntimeRouter } from '../core/runtime-router.ts';
import { runtimePlugin } from './runtime.ts';

export const resourcesPlugin: Plugin.Object<{
  directory: string;
  executors: EnvironmentExecutors;
  fetch?: typeof fetch;
  codex?: { executable?: string; args?: string[] };
  credentials?: (reference: string) => string | undefined;
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
    ctx.on('project/snapshot', (snapshot) => {
      snapshot.capabilities.push(
        'resources.list',
        'resources.models',
        'resources.probe',
        'resources.use',
      );
    });
  },
};
