import { Service, type Context, type Plugin } from 'cordis';
import type { AgentRuntime, RuntimeSelection } from '../core/ports.ts';
import { RuntimeCatalog } from '../core/runtimes.ts';

declare module 'cordis' {
  interface Context {
    agentRuntime: RuntimeService;
  }
}

class RuntimeService extends Service {
  readonly registry: RuntimeCatalog;
  readonly defaultRuntimeId: string;
  readonly selection?: RuntimeSelection;
  private routed?: AgentRuntime;

  constructor(
    ctx: Context,
    registry: RuntimeCatalog,
    defaultRuntimeId: string,
    selection?: RuntimeSelection,
    routed?: AgentRuntime,
  ) {
    super(ctx, 'agentRuntime');
    this.registry = registry;
    this.defaultRuntimeId = defaultRuntimeId;
    this.selection = selection;
    this.routed = routed;
  }

  /** Compatibility route until project/session resource profiles are introduced. */
  get adapter() {
    return this.routed || this.registry.get(this.defaultRuntimeId);
  }
}

export const runtimePlugin: Plugin.Object<{
  runtimes: AgentRuntime[];
  defaultRuntimeId: string;
  selection?: RuntimeSelection;
  route?: (registry: RuntimeCatalog) => AgentRuntime;
}> = {
  name: 'agent-runtimes',
  async apply(ctx, options) {
    const registry = new RuntimeCatalog();
    let routed: AgentRuntime | undefined;
    ctx.effect(() => async () => {
      try {
        await routed?.dispose();
      } finally {
        await registry.dispose();
      }
    });
    for (const adapter of options.runtimes) registry.register(adapter);
    registry.get(options.defaultRuntimeId);
    routed = options.route?.(registry);
    new RuntimeService(ctx, registry, options.defaultRuntimeId, options.selection, routed);
  },
};
