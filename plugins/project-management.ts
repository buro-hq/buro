import type { ExecutionEnvironmentPort } from '../core/environment-ports.ts';
import { Service, type Context, type Plugin } from 'cordis';
import { randomUUID } from 'node:crypto';
import { FileProjectRepository, FileProjectCatalog } from '../adapters/files/project-manager.ts';
import {
  ProjectApplication,
  policyView,
  type ProjectRepositoryPort,
  type ProjectCatalogPort,
} from '../core/project-application.ts';
import type { ExecutionPolicy, WorkspacePort, CheckPort } from '../core/execution-ports.ts';
declare module 'cordis' {
  interface Context {
    projectManagement: Management;
  }
}
class Management extends Service {
  api: ProjectApplication;
  constructor(ctx: Context, api: ProjectApplication) {
    super(ctx, 'projectManagement');
    this.api = api;
  }
}
export const projectManagementPlugin: Plugin.Object<{
  environments?: ExecutionEnvironmentPort;
  catalogFile?: string;
  repository?: ProjectRepositoryPort;
  catalog?: ProjectCatalogPort;
  policies: Record<string, ExecutionPolicy>;
  workspaces: WorkspacePort;
  checks: CheckPort;
}> = {
  name: 'project-management',
  inject: ['projects', 'commands', 'projectContributions'],
  async apply(ctx, options) {
    if (!options.catalog && !options.catalogFile) throw Error('A project catalog is required.');
    const api = new ProjectApplication({
      registry: ctx.projects.registry,
      stores: ctx.projects.stores,
      policies: options.policies,
      repository:
        options.repository || new FileProjectRepository(ctx.projectContributions.checkRecipes),
      catalog: options.catalog || new FileProjectCatalog(options.catalogFile!),
      environments: options.environments,
      id: randomUUID,
      now: () => new Date().toISOString(),
      report: (message, error, root) =>
        console.error(message, root || '', error instanceof Error ? error.message : String(error)),
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
    ctx.on('service/info', (info) => {
      info.capabilities.push('project.inspect', 'project.connect');
    });
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
