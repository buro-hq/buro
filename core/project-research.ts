import { z } from 'zod';
import { DEFAULT_IDLE_TIMEOUT_MS } from '../protocol/domain.ts';
import type { ProjectResearch } from '../protocol/domain.ts';
import { ResearchResultSchema } from '../protocol/operations.ts';
import { materialInstructions } from '../protocol/context.ts';
import { DomainError, type AgentRuntime, type ProjectRegistry } from './ports.ts';
import { operationIds } from './operation-catalog.ts';
import { terminal } from './execution-ports.ts';

export class ProjectResearchService {
  projects: ProjectRegistry;
  runtime: AgentRuntime;
  head: (root: string) => Promise<string>;
  jobs = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  constructor(options: {
    projects: ProjectRegistry;
    runtime: AgentRuntime;
    head: (root: string) => Promise<string>;
  }) {
    Object.assign(this, options);
    this.projects = options.projects;
    this.runtime = options.runtime;
    this.head = options.head;
  }
  async start(id: string, fingerprint: string, projectId: string) {
    const store = this.projects.get(projectId);
    const existing = store.receipt(id, fingerprint);
    if (existing !== undefined) return existing;
    const snapshot = store.snapshot();
    if (!snapshot.project.managed)
      throw new DomainError('UNMANAGED_PROJECT', 'Connect a repository.');
    if (this.jobs.has(projectId) || snapshot.runs.some((r) => !terminal(r)))
      throw new DomainError('PROJECT_BUSY', 'Wait for current work to finish.');
    const sourceHead = await this.head(snapshot.project.root);
    const research: ProjectResearch = {
      id: 'setup-' + crypto.randomUUID(),
      status: 'running',
      startedAt: new Date().toISOString(),
      sourceHead,
      profileRevision: snapshot.profile!.revision,
      summary: 'Agent is researching the project',
      events: [
        {
          at: new Date().toISOString(),
          text: 'Repository research started without source changes',
        },
      ],
    };
    await store.transact(id, fingerprint, (doc) => {
      if (doc.research?.status === 'running')
        throw new DomainError('PROJECT_BUSY', 'Research is already running.');
      doc.research = research;
      return {
        result: { researchId: research.id },
        change: { type: 'project.research.changed', research },
      };
    });
    const controller = new AbortController();
    const promise = Promise.resolve().then(() =>
      this.execute(projectId, research.id, controller.signal),
    );
    this.jobs.set(projectId, { controller, promise });
    void promise.finally(() => this.jobs.delete(projectId)).catch(() => {});
    return { researchId: research.id };
  }
  async update(projectId: string, researchId: string, change: (r: ProjectResearch) => void) {
    return this.projects
      .get(projectId)
      .transact('internal-' + crypto.randomUUID(), 'research', (doc) => {
        if (doc.research?.id !== researchId) throw Error('Research has already been replaced.');
        change(doc.research);
        return {
          result: null,
          change: { type: 'project.research.changed', research: doc.research },
        };
      });
  }
  async execute(projectId: string, researchId: string, signal: AbortSignal) {
    let threadId: string | undefined;
    let events = Promise.resolve();
    const unsubscribe = this.runtime.subscribe?.((event) => {
      if (event.runId !== researchId || event.type !== 'command.started') return;
      const text = (event.command || 'Reading files').slice(0, 500);
      events = events
        .then(() =>
          this.update(projectId, researchId, (r) => {
            r.events.push({ at: new Date().toISOString(), text });
            if (r.events.length > 40) r.events.splice(1, 1);
          }),
        )
        .then(() => {})
        .catch(() => {});
    });
    try {
      const snapshot = this.projects.get(projectId).snapshot();
      const thread = await this.runtime.start({
        projectId,
        workspace: snapshot.project.root,
        readOnly: true,
        purpose: 'research',
        operationId: operationIds.research,
        runId: researchId,
        instructions:
          'You are the project setup engineer. Inspect the repository only. Do not edit files, start servers, install dependencies, run migrations, mutate Git or deploy. Do not use the network. Do not traverse .buro/, .git/, node_modules/, dist/, build/ or caches, including nested directories. The current profile is supplied in the request. Do not open secrets (.env, keys, local/); .env.example without secret values is allowed. Follow AGENTS.md. Suggest launch commands only, with evidence from actual files; never invent them. Do not start child agents.' +
          materialInstructions(
            (snapshot.contextMaterials || []).filter((m) => m.active && m.scope === 'project'),
            snapshot.project.root,
          ),
      });
      threadId = thread.threadId;
      await this.update(projectId, researchId, (r) => {
        r.threadId = threadId;
      });
      if (!this.runtime.turn) throw Error('The runtime does not support research.');
      const answer = await this.runtime.turn(
        threadId,
        `Inspect the project and existing settings. Identify web/api/worker/cli/library/other components, their relative working directories (./ for the root), long-running local launch commands (empty when not applicable), HTTP ports (0 when unknown or non-HTTP), readyPath (empty for non-HTTP), result verification instructions, startup dependencies in instructions, and evidence files. Order components by startup dependency. HTTP commands must accept PORT/HOST or {port}: the service allocates free ports. Each HTTP component address is available as PROJECT_COMPONENT_<UPPERCASE_ID>_URL; use it in commands when a frontend requires an API address. Do not suggest migrations, package installation, production commands or shared database changes. Suggest test/typecheck/lint commands only from existing configuration. Ask about missing variables and infrastructure without including secret values. Describe discovered environments and CI in summary; do not enable delivery automatically. Current profile: preserve manual values during repeated research:
${JSON.stringify(snapshot.profile)}
Return the structured result.`,
        {
          schema: z.toJSONSchema(ResearchResultSchema, { target: 'draft-7' }),
          signal,
          timeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
        },
      );
      const result = ResearchResultSchema.parse(JSON.parse(answer.text));
      if (
        new Set(result.components.map((c) => c.id)).size !== result.components.length ||
        new Set(result.checks.map((c) => c.id)).size !== result.checks.length
      )
        throw Error('The agent returned duplicate IDs.');
      await events;
      await this.update(projectId, researchId, (r) => {
        Object.assign(r, result, { status: 'ready', completedAt: new Date().toISOString() });
        r.events.push({
          at: new Date().toISOString(),
          text: 'Suggestions are ready. Commands have not been executed; review and save the settings.',
        });
      });
    } catch (error) {
      await events;
      await this.update(projectId, researchId, (r) => {
        r.status = signal.aborted ? 'interrupted' : 'failed';
        r.completedAt = new Date().toISOString();
        r.error = error instanceof Error ? error.message : String(error);
      }).catch(() => {});
    } finally {
      unsubscribe?.();
      if (threadId) await this.runtime.release?.(threadId);
    }
  }
  cancel(projectId: string) {
    this.jobs.get(projectId)?.controller.abort();
    return { requested: true };
  }
  async recover() {
    for (const project of this.projects.list()) {
      const r = this.projects.get(project.id).snapshot().research;
      if (r?.status === 'running')
        await this.update(project.id, r.id, (r) => {
          r.status = 'interrupted';
          r.error = 'The service stopped. Suggestions are preserved; research can be repeated.';
        });
    }
  }
  async dispose() {
    for (const job of this.jobs.values()) job.controller.abort();
    await Promise.allSettled([...this.jobs.values()].map((j) => j.promise));
  }
}
