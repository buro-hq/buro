import { Service, type Context, type Plugin } from 'cordis';
import { randomUUID } from 'node:crypto';
import type { ExecutionEnvironmentPort } from '../core/environment-ports.ts';
import { ExecutionService } from '../core/execution.ts';
import type { ExecutionPolicy, WorkspacePort, CheckPort } from '../core/execution-ports.ts';
declare module 'cordis' {
  interface Context {
    workflows: Workflows;
  }
}
class Workflows extends Service {
  api: ExecutionService;
  constructor(ctx: Context, api: ExecutionService) {
    super(ctx, 'workflows');
    this.api = api;
  }
}
export const executionPlugin: Plugin.Object<{
  environments?: ExecutionEnvironmentPort;
  policies: Record<string, ExecutionPolicy>;
  workspaces: WorkspacePort;
  checks: CheckPort;
}> = {
  name: 'goal-execution',
  inject: ['projects', 'commands', 'agentRuntime'],
  async apply(ctx, options) {
    const api = new ExecutionService({
      ...options,
      projects: ctx.projects.registry,
      runtime: ctx.agentRuntime.adapter,
      now: () => new Date().toISOString(),
      id: randomUUID,
      onCompleted: (projectId, runId) => ctx.emit('run/completed', projectId, runId),
    });
    new Workflows(ctx, api);
    ctx.effect(() => () => api.dispose());
    ctx.effect(() =>
      ctx.commands.bus.register('run.start', (p, m) => api.start(m.id, m.fingerprint, p)),
    );
    ctx.effect(() =>
      ctx.commands.bus.register('run.resume', (p, m) => api.resume(m.id, m.fingerprint, p)),
    );
    ctx.effect(() =>
      ctx.commands.bus.register('run.cancel', (p, m) => api.cancel(m.id, m.fingerprint, p)),
    );
    ctx.on('project/snapshot', (snapshot) => {
      const policy = options.policies[snapshot.project.id];
      if (!policy) return;
      const { turnTimeoutMs, profile: _profile, context: _context, ...view } = policy;
      snapshot.executionPolicy = view;
      snapshot.capabilities.push('run.start', 'run.cancel', 'run.resume');
      if (policy.profile && (options.environments || options.workspaces.synchronizeDependencies))
        snapshot.capabilities.push('goal.environment-repair');
    });
    await api.recover();
  },
};
