import { Service, type Context, type Plugin } from 'cordis';
import type { AgentRuntime, RegisteredRuntime, RuntimeSelection } from '../core/ports.ts';
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

  /** Application session routing, or the explicitly configured backend when routing is absent. */
  get adapter() {
    return this.routed || this.registry.get(this.defaultRuntimeId);
  }
}

export const runtimePlugin: Plugin.Object<{
  runtimes: RegisteredRuntime[];
  defaultRuntimeId: string;
  selection?: RuntimeSelection;
  route?: (registry: RuntimeCatalog) => AgentRuntime;
  onReady?: (lifecycle: { drain: () => Promise<void> }) => void;
}> = {
  name: 'agent-runtimes',
  async apply(ctx, options) {
    const registry = new RuntimeCatalog();
    let routed: AgentRuntime | undefined;
    const pending = new Set(options.runtimes);
    let disposal: Promise<void> | undefined;
    const dispose = () =>
      (disposal ??= (async () => {
        const errors: unknown[] = [];
        try {
          await routed?.dispose();
        } catch (error) {
          errors.push(error);
        }
        const results = await Promise.allSettled([
          registry.dispose(),
          ...[...pending].map((runtime) => Promise.resolve().then(() => runtime.dispose())),
        ]);
        errors.push(
          ...results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : [])),
        );
        if (errors.length) throw new AggregateError(errors, 'Runtime cleanup failed.');
      })());
    ctx.effect(() => dispose);
    try {
      if (pending.size !== options.runtimes.length)
        throw Error('A runtime instance cannot be owned twice.');
      for (const adapter of options.runtimes) {
        registry.register(adapter);
        pending.delete(adapter);
      }
      registry.get(options.defaultRuntimeId);
      routed = options.route?.(registry);
      new RuntimeService(ctx, registry, options.defaultRuntimeId, options.selection, routed);
      options.onReady?.({ drain: dispose });
    } catch (error) {
      await dispose().catch(() => {});
      throw error;
    }
  },
};
