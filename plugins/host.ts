import { Context, Service, type Plugin } from 'cordis';
import { randomUUID } from 'node:crypto';
import { CommandBus } from '../core/command-bus.ts';
import { GoalService, RoleService } from '../core/services.ts';
import { FileProjectRegistry } from '../adapters/files/registry.ts';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import type { Project, Run, Role, Snapshot } from '../protocol/domain.ts';
import type { ProjectRegistry } from '../core/ports.ts';
import { localFilesPlugin } from './local-files.ts';

declare module 'cordis' {
  interface Events {
    'project/snapshot'(snapshot: Snapshot): void;
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
  registry: FileProjectRegistry;
  constructor(ctx: Context, registry: FileProjectRegistry) {
    super(ctx, 'projects');
    this.registry = registry;
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
type ProjectOptions = { directory: string; project: Project; runs?: Run[]; roles?: Role[] };
const storagePlugin: Plugin.Object<ProjectOptions[]> = {
  name: 'project-storage',
  async apply(ctx, config) {
    const stores: FileProjectStore[] = [];
    try {
      for (const item of config) stores.push(await FileProjectStore.open(item));
    } catch (e) {
      await Promise.all(stores.map((s) => s.close()));
      throw e;
    }
    const registry = new FileProjectRegistry(stores);
    new Projects(ctx, registry);
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
export async function createHost(options: { projects: ProjectOptions[] }) {
  const ctx = new Context();
  try {
    await ctx.plugin(Commands);
    await ctx.plugin(storagePlugin, options.projects);
    await ctx.plugin(projectsPlugin);
    await ctx.plugin(localFilesPlugin);
    await ctx.plugin(goalsPlugin);
    await ctx.plugin(rolesPlugin);
    return { ctx, dispose: () => ctx.fiber.dispose() };
  } catch (e) {
    await ctx.fiber.dispose();
    throw e;
  }
}
