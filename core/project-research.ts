import { DEFAULT_IDLE_TIMEOUT_MS } from '../protocol/domain.ts';
import type { ProjectResearch } from '../protocol/domain.ts';
import { materialInstructions } from '../protocol/context.ts';
import {
  DomainError,
  type AgentRuntime,
  type ProjectRegistry,
  type RuntimeSelection,
} from './ports.ts';
import { ResourceSnapshotSchema } from '../protocol/resources.ts';
import { roleResourcePool } from './role-routing.ts';
import { operationIds, serviceOperationContext } from './operation-catalog.ts';
import type { WorkflowRoleResolver } from './workflow-roles.ts';
import { resolveRoleResource } from './role-routing.ts';
import type { ContextMaterial } from '../protocol/context.ts';
import type {
  ResolvedProjectAnalysis,
  ProjectAnalysisInput,
  AuthorizedMaterialTextReader,
} from './project-analysis.ts';
import { terminal } from './execution-ports.ts';

type ResearchAdmission = {
  analysis: ResolvedProjectAnalysis;
  input: Omit<ProjectAnalysisInput, 'materials'>;
  selected: ContextMaterial[];
  root: string;
};

export class ProjectResearchService {
  projects: ProjectRegistry;
  runtime: AgentRuntime;
  head: (root: string) => Promise<string>;
  #analysis: ResolvedProjectAnalysis;
  #materials: AuthorizedMaterialTextReader;
  #selection: RuntimeSelection;
  #workflowRoles: WorkflowRoleResolver;
  closing = false;
  #admissions = new Set<{
    projectId: string;
    controller: AbortController;
    promise: Promise<unknown>;
  }>();
  jobs = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  constructor(options: {
    projects: ProjectRegistry;
    runtime: AgentRuntime;
    head: (root: string) => Promise<string>;
    analysis: ResolvedProjectAnalysis;
    materials: AuthorizedMaterialTextReader;
    selection: RuntimeSelection;
    workflowRoles: WorkflowRoleResolver;
  }) {
    this.projects = options.projects;
    this.runtime = options.runtime;
    this.head = options.head;
    if (!options.selection || typeof options.selection.forProject !== 'function')
      throw new DomainError(
        'RESOURCE_PROFILE_REQUIRED',
        'Research requires an explicit execution resource selection.',
      );
    this.#selection = options.selection;
    if (!options.workflowRoles || typeof options.workflowRoles.ensureRole !== 'function')
      throw new DomainError(
        'WORKFLOW_REQUIRED',
        'Configure a workflow role resolver before research.',
      );
    this.#workflowRoles = options.workflowRoles;
    if (
      !options.analysis ||
      options.analysis.purpose !== 'project-setup' ||
      !options.analysis.id ||
      !options.analysis.revision ||
      typeof options.analysis.build !== 'function' ||
      typeof options.analysis.parse !== 'function' ||
      typeof options.materials !== 'function'
    )
      throw new DomainError(
        'INVALID_PROJECT_ANALYSIS',
        'Configure a resolved project analysis and authorized material reader.',
      );
    const { id, revision, purpose, build, parse } = options.analysis;
    this.#analysis = Object.freeze({
      id,
      revision,
      purpose,
      build: (input: ProjectAnalysisInput) => structuredClone(build(structuredClone(input))),
      parse: (text: string) => structuredClone(parse(text)),
    });
    this.#materials = options.materials;
  }
  start(id: string, fingerprint: string, projectId: string): Promise<unknown> {
    if (this.closing)
      return Promise.reject(new DomainError('STOPPING', 'The service is stopping.'));
    const controller = new AbortController();
    const promise = this.admit(id, fingerprint, projectId, controller);
    const admission = { projectId, controller, promise };
    this.#admissions.add(admission);
    void promise.then(
      () => this.#admissions.delete(admission),
      () => this.#admissions.delete(admission),
    );
    return promise;
  }
  private async admit(
    id: string,
    fingerprint: string,
    projectId: string,
    controller: AbortController,
  ) {
    if (this.closing) throw new DomainError('STOPPING', 'The service is stopping.');
    const store = this.projects.get(projectId);
    const existing = store.receipt(id, fingerprint);
    if (existing !== undefined) return existing;
    const snapshot = store.snapshot();
    if (!snapshot.project.managed)
      throw new DomainError('UNMANAGED_PROJECT', 'Connect a repository.');
    if (this.jobs.has(projectId) || snapshot.runs.some((r) => !terminal(r)))
      throw new DomainError('PROJECT_BUSY', 'Wait for current work to finish.');
    if (!snapshot.profile)
      throw new DomainError('INVALID_PROFILE', 'Configure the project before researching it.');
    const analysis = this.#analysis;
    const resources = ResourceSnapshotSchema.parse(
      structuredClone(this.#selection.forProject(projectId)),
    );
    roleResourcePool(resources);
    controller.signal.throwIfAborted();
    const sourceHead = await this.head(snapshot.project.root);
    if (this.closing) throw new DomainError('STOPPING', 'The service is stopping.');
    controller.signal.throwIfAborted();
    const admission: ResearchAdmission = {
      analysis,
      input: {
        project: { id: snapshot.project.id, name: snapshot.project.name },
        sourceHead,
        profile: structuredClone(snapshot.profile),
      },
      selected: [],
      root: snapshot.project.root,
    };
    const researchId = 'setup-' + crypto.randomUUID();
    const initial: Omit<ProjectResearch, 'roleSnapshot' | 'roleResource'> = {
      id: researchId,
      analysis: { id: analysis.id, revision: analysis.revision },
      resources,
      contextMaterials: [],
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
    const admitted = await store.transact(id, fingerprint, (doc) => {
      if (this.closing) throw new DomainError('STOPPING', 'The service is stopping.');
      controller.signal.throwIfAborted();
      if (
        doc.profile?.revision !== admission.input.profile.revision ||
        doc.project.root !== admission.root
      )
        throw new DomainError(
          'RESEARCH_STALE',
          'Project settings changed before research was admitted.',
        );
      if (doc.runs.some((run) => !terminal(run)))
        throw new DomainError('PROJECT_BUSY', 'Wait for current work to finish.');
      if (this.jobs.has(projectId) || doc.research?.status === 'running')
        throw new DomainError('PROJECT_BUSY', 'Research is already running.');
      admission.selected = structuredClone(
        (doc.contextMaterials || []).filter(
          (material) => material.active && material.scope === 'project',
        ),
      );
      const operation = serviceOperationContext(operationIds.research, admission.input.profile);
      const resolved = this.#workflowRoles.ensureRole(doc, operation, new Date().toISOString());
      const research: ProjectResearch = {
        ...initial,
        contextMaterials: structuredClone(admission.selected),
        roleSnapshot: resolved.role,
        roleResource: resolveRoleResource(resources, resolved.role, operation),
      };
      doc.research = research;
      return {
        result: { researchId: research.id },
        change: {
          type: 'project.research.changed',
          research,
          ...(resolved.created ? { roles: [resolved.role] } : {}),
        },
      };
    });
    if (admitted.researchId !== researchId) return admitted;
    if (this.closing || controller.signal.aborted) {
      await this.update(projectId, researchId, (saved) => {
        saved.status = 'interrupted';
        saved.completedAt = new Date().toISOString();
        saved.error = 'Research was stopped before model dispatch.';
      });
      return admitted;
    }
    const promise = Promise.resolve().then(() =>
      this.execute(projectId, researchId, admission, controller.signal),
    );
    this.jobs.set(projectId, { controller, promise });
    void promise
      .finally(() => {
        if (this.jobs.get(projectId)?.promise === promise) this.jobs.delete(projectId);
      })
      .catch(() => {});
    return { researchId };
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
  private async execute(
    projectId: string,
    researchId: string,
    admission: ResearchAdmission,
    signal: AbortSignal,
  ) {
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
      signal.throwIfAborted();
      const materials = await this.#materials(projectId, admission.selected, signal);
      signal.throwIfAborted();
      const request = admission.analysis.build({ ...admission.input, materials });
      const snapshot = this.projects.get(projectId).snapshot();
      if (
        snapshot.profile?.revision !== admission.input.profile.revision ||
        snapshot.research?.id !== researchId ||
        snapshot.research.analysis.id !== admission.analysis.id ||
        snapshot.research.analysis.revision !== admission.analysis.revision ||
        (await this.head(admission.root)) !== admission.input.sourceHead
      )
        throw new DomainError(
          'RESEARCH_STALE',
          'Project settings or source changed before analysis dispatch.',
        );
      signal.throwIfAborted();
      const thread = await this.runtime.start({
        projectId,
        workspace: admission.root,
        readOnly: true,
        purpose: 'research',
        operationId: operationIds.research,
        roleId: snapshot.research.roleSnapshot.id,
        runId: researchId,
        instructions:
          'This is a read-only project research operation. Returned commands are suggestions; only the application may apply settings or execute operations.\n' +
          snapshot.research.roleSnapshot.instructions +
          '\n' +
          request.instructions +
          materialInstructions(admission.selected, admission.root),
      });
      threadId = thread.threadId;
      signal.throwIfAborted();
      await this.update(projectId, researchId, (r) => {
        r.threadId = threadId;
      });
      signal.throwIfAborted();
      if (!this.runtime.turn) throw Error('The runtime does not support research.');
      const answer = await this.runtime.turn(threadId, request.prompt, {
        schema: structuredClone(request.schema),
        signal,
        timeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
      });
      const result = admission.analysis.parse(answer.text);
      signal.throwIfAborted();
      await events;
      signal.throwIfAborted();
      await this.update(projectId, researchId, (r) => {
        signal.throwIfAborted();
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
      await events;
      if (threadId) await this.runtime.release?.(threadId);
    }
  }
  cancel(projectId: string) {
    for (const admission of this.#admissions)
      if (admission.projectId === projectId) admission.controller.abort();
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
    this.closing = true;
    for (const admission of this.#admissions) admission.controller.abort();
    for (const job of this.jobs.values()) job.controller.abort();
    await Promise.allSettled([...this.#admissions].map((admission) => admission.promise));
    await Promise.allSettled([...this.jobs.values()].map((j) => j.promise));
  }
}
