import { Service, type Context, type Plugin } from 'cordis';
import {
  DomainError,
  type AgentRuntime,
  type RegisteredRuntime,
  type RuntimeSelection,
} from '../core/ports.ts';
import { RuntimeCatalog } from '../core/runtimes.ts';

declare module 'cordis' {
  interface Context {
    agentRuntime: RuntimeService;
  }
}

class RuntimeService extends Service {
  readonly registry: RuntimeCatalog;
  readonly defaultRuntimeId?: string;
  readonly selection?: RuntimeSelection;
  private routed?: AgentRuntime;

  constructor(
    ctx: Context,
    registry: RuntimeCatalog,
    defaultRuntimeId: string | undefined,
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
    if (this.routed) return this.routed;
    if (this.defaultRuntimeId === undefined)
      throw new DomainError(
        'RUNTIME_DEFAULT_REQUIRED',
        'An unrouted runtime needs an explicit default.',
      );
    return this.registry.get(this.defaultRuntimeId);
  }
}

export type RuntimePluginOptions = {
  runtimes: RegisteredRuntime[];
  selection?: RuntimeSelection;
  onReady?: (lifecycle: { drain: () => Promise<void> }) => void;
} & (
  | { route: (registry: RuntimeCatalog) => AgentRuntime; defaultRuntimeId?: string }
  | { route?: undefined; defaultRuntimeId: string }
);

export const runtimePlugin: Plugin.Object<RuntimePluginOptions> = {
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
      if (options.defaultRuntimeId !== undefined) registry.get(options.defaultRuntimeId);
      else if (!options.route)
        throw new DomainError(
          'RUNTIME_DEFAULT_REQUIRED',
          'An unrouted runtime needs an explicit default.',
        );
      routed = options.route?.(registry);
      if (options.route && !routed)
        throw new DomainError('INVALID_RUNTIME_ROUTER', 'The runtime router is unavailable.');
      new RuntimeService(ctx, registry, options.defaultRuntimeId, options.selection, routed);
      options.onReady?.({ drain: dispose });
    } catch (error) {
      await dispose().catch(() => {});
      throw error;
    }
  },
};
