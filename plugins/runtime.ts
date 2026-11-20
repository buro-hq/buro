import { Service, type Context, type Plugin } from 'cordis';
import type { AgentRuntime } from '../core/ports.ts';
import { RuntimeCatalog } from '../core/runtimes.ts';

declare module 'cordis' {
  interface Context {
    agentRuntime: RuntimeService;
  }
}

class RuntimeService extends Service {
  readonly registry: RuntimeCatalog;
  readonly defaultRuntimeId: string;

  constructor(ctx: Context, registry: RuntimeCatalog, defaultRuntimeId: string) {
    super(ctx, 'agentRuntime');
    this.registry = registry;
    this.defaultRuntimeId = defaultRuntimeId;
  }

  /** Compatibility route until project/session resource profiles are introduced. */
  get adapter() {
    return this.registry.get(this.defaultRuntimeId);
  }
}

export const runtimePlugin: Plugin.Object<{ runtimes: AgentRuntime[]; defaultRuntimeId: string }> =
  {
    name: 'agent-runtimes',
    async apply(ctx, options) {
      const registry = new RuntimeCatalog();
      ctx.effect(() => () => registry.dispose());
      for (const adapter of options.runtimes) registry.register(adapter);
      registry.get(options.defaultRuntimeId);
      new RuntimeService(ctx, registry, options.defaultRuntimeId);
    },
  };
