import type { Plugin } from 'cordis';
import { ProjectResearchService } from '../core/project-research.ts';
import { ResultService, type ResultOperations } from '../core/results.ts';
declare module 'cordis' {
  interface Events {
    'run/completed'(projectId: string, runId: string): void;
  }
}
export const projectOperationsPlugin: Plugin.Object<{ operations: ResultOperations }> = {
  name: 'project-operations',
  inject: ['projects', 'commands', 'agentRuntime', 'projectManagement'],
  async apply(ctx, { operations }) {
    const research = new ProjectResearchService({
      projects: ctx.projects.registry,
      runtime: ctx.agentRuntime.adapter,
      head: async (root) => (await ctx.projectManagement.api.inspect(root)).head,
    });
    const results = new ResultService({
      projects: ctx.projects.registry,
      runtime: ctx.agentRuntime.adapter,
      operations,
    });
    ctx.effect(() => async () => {
      await research.dispose();
      await results.dispose();
    });
    const handlers = {
      'project.research.status': (p: any) =>
        ctx.projects.registry.get(p.projectId).snapshot().research || null,
      'project.research': (p: any, m: any) => research.start(m.id, m.fingerprint, p.projectId),
      'project.research.cancel': (p: any) => research.cancel(p.projectId),
      'run.preview.start': (p: any, m: any) => results.preview(p.projectId, p.runId, m),
      'run.preview.restart': (p: any, m: any) => results.restartPreview(p.projectId, p.runId, m),
      'run.preview.stop': (p: any) => results.stopPreview(p.projectId, p.runId),
      'run.preview.status': (p: any) => results.previewStatus(p.projectId, p.runId),
      'run.deliver': (p: any, m: any) =>
        results.deliver(p.projectId, p.runId, p.expectedCommit, p.confirmed, m, p.redeploy),
    };
    for (const [method, handler] of Object.entries(handlers))
      ctx.effect(() => ctx.commands.bus.register(method as keyof typeof handlers, handler));
    ctx.on('service/info', (info) => info.capabilities.push('project.research'));
    ctx.on('project/snapshot', (snapshot) => {
      snapshot.capabilities.push('project.research');
      if (snapshot.project.managed) snapshot.capabilities.push(...Object.keys(handlers));
      if (snapshot.project.managed) snapshot.capabilities.push('run.redeploy');
    });
    ctx.on('run/completed', (projectId, runId) => {
      const run = ctx.projects.registry
        .get(projectId)
        .snapshot()
        .runs.find((r) => r.id === runId);
      if (run?.commit)
        void results
          .deliver(projectId, runId, run.commit)
          .catch((error) => console.error('Delivery preparation:', error));
    });
    await research.recover();
    await results.recover();
  },
};
