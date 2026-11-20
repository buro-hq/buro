import type { Plugin } from 'cordis';
import { CodexRuntime } from '../adapters/codex/runtime.ts';
import type { EnvironmentExecutors } from '../adapters/environments/executors.ts';
import { runtimePlugin } from './runtime.ts';
export const codexPlugin: Plugin.Object<
  { executable?: string; args?: string[]; executors?: EnvironmentExecutors } | undefined
> = {
  name: 'codex-runtime',
  inject: ['projects'],
  async apply(ctx, options) {
    const adapter = new CodexRuntime({ projects: ctx.projects.registry, ...options });
    await ctx.plugin(runtimePlugin, { runtimes: [adapter], defaultRuntimeId: adapter.id });
  },
};
