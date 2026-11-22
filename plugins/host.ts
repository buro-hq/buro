import { Context, Service, type Plugin } from 'cordis';
import { randomUUID } from 'node:crypto';
import { CommandBus } from '../core/command-bus.ts';
import { GoalService, RoleService } from '../core/services.ts';
import { ProjectStoreRegistry } from '../core/project-registry.ts';
import { FileProjectStoreFactory } from '../adapters/files/project-store-factory.ts';
import type { Snapshot, ServiceInfo } from '../protocol/domain.ts';
import type {
  MutableProjectRegistry,
  ProjectStore,
  ProjectStoreFactory,
  ProjectStoreOpenSpec,
} from '../core/ports.ts';
import { localFilesPlugin } from './local-files.ts';
import { resourceContributionsPlugin } from './resource-contributions.ts';
import { toolContributionsPlugin } from './tool-contributions.ts';
import { projectContributionsPlugin } from './project-contributions.ts';
import type { ProjectContributionCatalogs } from './project-contributions.ts';
import type { ToolContributionCatalog } from '../core/tool-contributions.ts';

declare module 'cordis' {
  interface Events {
    'project/snapshot'(snapshot: Snapshot): void;
    'service/info'(info: ServiceInfo): void;
  }
  interface Context {
    projects: Projects;
    commands: Commands;
    goals: Goals;
    roles: Roles;
  }
}
class Commands extends Service {
  bus = new CommandBus();
  constructor(ctx: Context) {
    super(ctx, 'commands');
  }
}
class Projects extends Service {
  registry: MutableProjectRegistry;
  stores: ProjectStoreFactory;
  constructor(ctx: Context, registry: MutableProjectRegistry, stores: ProjectStoreFactory) {
    super(ctx, 'projects');
    this.registry = registry;
    this.stores = stores;
  }
}
class Goals extends Service {
  api: GoalService;
  constructor(ctx: Context) {
    super(ctx, 'goals');
    this.api = new GoalService({
      projects: ctx.projects.registry,
      now: () => new Date().toISOString(),
      id: randomUUID,
    });
  }
}
class Roles extends Service {
  api: RoleService;
  constructor(ctx: Context) {
    super(ctx, 'roles');
    this.api = new RoleService({
      projects: ctx.projects.registry,
      now: () => new Date().toISOString(),
      id: randomUUID,
    });
  }
}
const storagePlugin: Plugin.Object<{
  projects: ProjectStoreOpenSpec[];
  factory: ProjectStoreFactory;
}> = {
  name: 'project-storage',
  async apply(ctx, config) {
    const stores: ProjectStore[] = [];
    let registry: ProjectStoreRegistry;
    try {
      for (const item of config.projects) stores.push(await config.factory.open(item));
      registry = new ProjectStoreRegistry(stores);
    } catch (error) {
      await Promise.allSettled(stores.map((store) => Promise.resolve().then(() => store.close())));
      throw error;
    }
    new Projects(ctx, registry, config.factory);
    ctx.effect(() => () => registry.close());
  },
};
export const projectsPlugin: Plugin.Object = {
  name: 'projects',
  inject: ['projects', 'commands'],
  apply(ctx) {
    ctx.effect(() =>
      ctx.commands.bus.register('project.storage', (p) => {
        const store = ctx.projects.registry.get(p.projectId);
        if (!store.storageInfo) throw Error('Storage inspection unavailable');
        return store.storageInfo();
      }),
    );
    ctx.effect(() =>
      ctx.commands.bus.register('project.storage.gc', (p) => {
        const store = ctx.projects.registry.get(p.projectId);
        if (!store.collectGarbage) throw Error('Storage cleanup unavailable');
        return store.collectGarbage();
      }),
    );
    ctx.on('project/snapshot', (snapshot) => {
      if (ctx.projects.registry.get(snapshot.project.id).storageInfo)
        snapshot.capabilities.push('project.storage', 'project.storage.gc');
    });

    ctx.effect(() =>
      ctx.commands.bus.register('service.info', () => {
        const info: ServiceInfo = {
          version: 1,
          projects: ctx.projects.registry.list(),
          capabilities: ['project.list'],
        };
        ctx.emit('service/info', info);
        info.capabilities = [...new Set(info.capabilities)];
        return info;
      }),
    );
    ctx.effect(() => ctx.commands.bus.register('project.list', () => ctx.projects.registry.list()));
    ctx.effect(() =>
      ctx.commands.bus.register('project.snapshot', (p) =>
        (() => {
          const snapshot = ctx.projects.registry.get(p.projectId).snapshot();
          ctx.emit('project/snapshot', snapshot);
          return snapshot;
        })(),
      ),
    );
  },
};
export const goalsPlugin: Plugin.Object = {
  name: 'goals',
  inject: ['projects', 'commands'],
  apply(ctx) {
    new Goals(ctx);
    ctx.effect(() =>
      ctx.commands.bus.register('goal.create', (p, m) =>
        ctx.goals.api.create(m.id, m.fingerprint, p),
      ),
    );
    ctx.effect(() =>
      ctx.commands.bus.register('goal.update', (p, m) =>
        ctx.goals.api.update(m.id, m.fingerprint, p),
      ),
    );
    ctx.effect(() =>
      ctx.commands.bus.register('goal.delete', (p, m) =>
        ctx.goals.api.delete(m.id, m.fingerprint, p),
      ),
    );
  },
};
export const rolesPlugin: Plugin.Object = {
  name: 'roles',
  inject: ['projects', 'commands'],
  apply(ctx) {
    new Roles(ctx);
    ctx.effect(() =>
      ctx.commands.bus.register('role.save', (p, m) => ctx.roles.api.save(m.id, m.fingerprint, p)),
    );
  },
};
/** Cordis is confined to this composition layer; core use cases take explicit ports. */
export type HostOptions = {
  projects?: ProjectStoreOpenSpec[];
  storeFactory?: ProjectStoreFactory;
  /** Explicit catalogs replace that category's defaults before startup is sealed. */
  projectContributions?: ProjectContributionCatalogs;
  toolContributions?: ToolContributionCatalog;
  /** Trusted Cordis plugins register before tool and application catalogs are sealed. */
  configure?: (ctx: Context) => void | Promise<void>;
};
export async function createHost(options: HostOptions = {}) {
  const ctx = new Context();
  try {
    await ctx.plugin(Commands);
    await ctx.plugin(resourceContributionsPlugin);
    await ctx.plugin(toolContributionsPlugin, { catalog: options.toolContributions });
    await ctx.plugin(projectContributionsPlugin, options.projectContributions ?? {});
    await ctx.plugin(storagePlugin, {
      projects: options.projects || [],
      factory: options.storeFactory || new FileProjectStoreFactory(),
    });
    await options.configure?.(ctx);
    ctx.toolContributions.catalog.seal();
    ctx.projectContributions.seal();
    await ctx.plugin(projectsPlugin);
    await ctx.plugin(localFilesPlugin);
    await ctx.plugin(goalsPlugin);
    await ctx.plugin(rolesPlugin);
    return { ctx, dispose: () => ctx.fiber.dispose() };
  } catch (e) {
    await ctx.fiber.dispose().catch(() => {});
    throw e;
  }
}
