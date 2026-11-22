import type { Plugin } from 'cordis';
import { LocalBrowser } from '../adapters/files/local-browser.ts';
import { ContextMaterials } from '../adapters/files/context-materials.ts';
const capabilities = [
  'filesystem.list',
  'context.list',
  'context.import',
  'context.remove',
] as const;
export const localFilesPlugin: Plugin.Object = {
  name: 'local-files',
  inject: ['projects', 'commands'],
  apply(ctx) {
    const browser = new LocalBrowser(ctx.projects.registry),
      materials = new ContextMaterials(ctx.projects.registry);
    ctx.effect(() => () => materials.dispose());
    ctx.effect(() => ctx.commands.bus.register('filesystem.list', (p) => browser.list(p)));
    ctx.effect(() =>
      ctx.commands.bus.register(
        'context.list',
        (p) => ctx.projects.registry.get(p.projectId).snapshot().contextMaterials || [],
      ),
    );
    ctx.effect(() =>
      ctx.commands.bus.register('context.import', (p, m) =>
        materials.import(m.id, m.fingerprint, p),
      ),
    );
    ctx.effect(() =>
      ctx.commands.bus.register('context.remove', (p, m) =>
        materials.remove(m.id, m.fingerprint, p),
      ),
    );
    ctx.on('service/info', (info) => info.capabilities.push('filesystem.list'));
    ctx.on('project/snapshot', (s) => s.capabilities.push(...capabilities));
  },
};
