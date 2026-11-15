import { Service, type Context, type Plugin } from 'cordis';
import { CodexRuntime } from '../adapters/codex/runtime.ts';
import type { EnvironmentExecutors } from '../adapters/environments/executors.ts';
import type { AgentRuntime } from '../core/ports.ts';

declare module 'cordis' {
  interface Context {
    agentRuntime: RuntimeService;
  }
}
class RuntimeService extends Service {
  adapter: AgentRuntime;
  constructor(ctx: Context, adapter: AgentRuntime) {
    super(ctx, 'agentRuntime');
    this.adapter = adapter;
  }
}
export const codexPlugin: Plugin.Object<
  { executable?: string; args?: string[]; executors?: EnvironmentExecutors } | undefined
> = {
  name: 'codex-runtime',
  inject: ['projects'],
  apply(ctx, options) {
    const adapter = new CodexRuntime({ projects: ctx.projects.registry, ...options });
    new RuntimeService(ctx, adapter);
    ctx.effect(() => () => adapter.dispose());
  },
};
