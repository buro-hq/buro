import type { ExecutionEnvironmentPort } from '../core/environment-ports.ts';
import { Service, type Context, type Plugin } from 'cordis';
import { ProjectManager, policyView } from '../adapters/files/project-manager.ts';
import type { ExecutionPolicy, WorkspacePort, CheckPort } from '../core/execution-ports.ts';
declare module 'cordis' {
  interface Context {
    projectManagement: Management;
  }
}
class Management extends Service {
  api: ProjectManager;
  constructor(ctx: Context, api: ProjectManager) {
    super(ctx, 'projectManagement');
    this.api = api;
  }
}
export const projectManagementPlugin: Plugin.Object<{
  environments?: ExecutionEnvironmentPort;
  catalogFile: string;
  policies: Record<string, ExecutionPolicy>;
  workspaces: WorkspacePort;
  checks: CheckPort;
}> = {
  name: 'project-management',
  inject: ['projects', 'commands'],
  async apply(ctx, options) {
    const api = new ProjectManager({
      registry: ctx.projects.registry,
      policies: options.policies,
      catalogFile: options.catalogFile,
      environments: options.environments,
    });
    new Management(ctx, api);
    ctx.effect(() => () => api.dispose());
    await api.restore();
    const handlers = {
      'project.inspect': (p: any) => api.inspect(p.root),
      'project.connect': (p: any, m: any) => api.connect(m.id, m.fingerprint, p),
      'project.info': (p: any) => api.info(p.projectId),
      'project.configure': (p: any, m: any) => api.configure(m.id, m.fingerprint, p),
      'project.research.apply': (p: any, m: any) => api.applyResearch(m.id, m.fingerprint, p),
      'project.verify': (p: any, m: any) =>
        api.verify(p.projectId, p.checkIds, options.workspaces, options.checks, m),
      'run.apply': (p: any, m: any) => api.apply(m.id, m.fingerprint, p),
    } as const;
    for (const [method, handler] of Object.entries(handlers))
      ctx.effect(() => ctx.commands.bus.register(method as keyof typeof handlers, handler));
    ctx.on('project/snapshot', (snapshot) => {
      snapshot.capabilities.push('project.connect');
      if (snapshot.project.managed) {
        snapshot.capabilities.push(
          'project.configure',
          'project.research.apply',
          'project.verify',
          'run.apply',
        );
        if (snapshot.profile) snapshot.executionPolicy = policyView(snapshot.profile);
      }
    });
  },
};
