import type { ExecutionEnvironmentPort } from './environment-ports.ts';
import {
  DomainError,
  type ProjectDocument,
  type MutableProjectRegistry,
  type ProjectStoreFactory,
  type ProjectStore,
} from './ports.ts';
import { resultApplyReceiptId, type ResultApplyIntent } from './result-apply.ts';
import {
  terminal,
  type ExecutionPolicy,
  type WorkspacePort,
  type CheckPort,
} from './execution-ports.ts';
import { profileWithResearch } from '../protocol/research-profile.ts';
import type {
  Project,
  ProjectProfile,
  RepositoryInfo,
  ProjectVerification,
} from '../protocol/domain.ts';
import {
  executionPolicy,
  policyView,
  validateProjectIdentity,
  validateProjectProfile,
  validateProjectVerification,
  type ProjectSettings,
  type ResearchProposal,
} from './project-settings.ts';
export { executionPolicy, policyView } from './project-settings.ts';

export type ProjectCatalog = {
  version: 1;
  projects: { root: string; id: string }[];
  receipts: Record<string, { fingerprint: string; project: Project }>;
};
export interface ProjectCatalogPort {
  load(): Promise<ProjectCatalog | undefined>;
  save(catalog: ProjectCatalog): Promise<void>;
}
export type LoadedProjectRepository = {
  project: Project;
  profile: ProjectProfile;
  branch: string;
  storageAddress: string;
};
/** Repository facts and explicit I/O operations; application transactions do not own a filesystem. */
export interface ProjectRepositoryPort {
  inspect(input: string): Promise<RepositoryInfo>;
  load(root: string): Promise<LoadedProjectRepository>;
  prepareConnection(input: {
    root: string;
    name: string;
    profile: ProjectProfile;
    ignoreLocal?: boolean;
  }): Promise<{ root: string; id: string }>;
  ensureLocal(project: Project): Promise<void>;
  exportProfile(project: Project, profile: ProjectProfile): Promise<void>;
  head(root: string): Promise<string>;
  isAncestor(root: string, ancestor: string, target: string): Promise<boolean>;
  fastForward(root: string, target: string): Promise<void>;
}
export type ProjectApplicationOptions = {
  registry: MutableProjectRegistry;
  stores: ProjectStoreFactory;
  repository: ProjectRepositoryPort;
  catalog: ProjectCatalogPort;
  policies: Record<string, ExecutionPolicy>;
  environments?: ExecutionEnvironmentPort;
  id: () => string;
  now: () => string;
  report?: (message: string, error: unknown, root?: string) => void;
};

/** Project use cases own receipts and admission; injected ports own storage, Git and processes. */
export class ProjectApplication {
  registry: MutableProjectRegistry;
  policies: Record<string, ExecutionPolicy>;
  environments?: ExecutionEnvironmentPort;
  catalog: ProjectCatalog = { version: 1, projects: [], receipts: {} };
  queue: Promise<unknown> = Promise.resolve();
  controllers = new Set<AbortController>();
  tasks = new Set<Promise<unknown>>();
  closing = false;
  verifications = new Map<string, { fingerprint: string; promise: Promise<ProjectVerification> }>();
  private options: ProjectApplicationOptions;
  constructor(options: ProjectApplicationOptions) {
    this.options = options;
    this.registry = options.registry;
    this.policies = options.policies;
    this.environments = options.environments;
  }
  private id() {
    return this.options.id();
  }
  private now() {
    return this.options.now();
  }
  private report(message: string, error: unknown, root?: string) {
    this.options.report?.(message, error, root);
  }
  serialize<T>(fn: () => Promise<T>) {
    if (this.closing)
      return Promise.reject(new DomainError('STOPPING', 'The service is stopping.'));
    const result = this.queue.then(fn);
    this.queue = result.catch(() => {});
    return result;
  }
  async inspect(input: string): Promise<RepositoryInfo> {
    const info = await this.options.repository.inspect(input);
    const existing = this.registry.list().find((project) => project.root === info.root);
    return { ...info, projectId: existing?.id };
  }
  async restore() {
    const saved = await this.options.catalog.load();
    if (saved) this.catalog = structuredClone(saved);
    for (const item of this.catalog.projects)
      try {
        await this.open(item.root, item.id);
      } catch (error) {
        this.report('Could not open project', error, item.root);
      }
  }
  private settingsContext(projectId: string, opened?: ProjectStore) {
    const store = opened ?? this.registry.get(projectId);
    const project = validateProjectIdentity(store.project);
    const settings = store.settings;
    if (project.id !== projectId || !settings || settings.projectId !== projectId)
      throw new DomainError(
        'PROJECT_STORAGE_MISMATCH',
        'The opened store belongs to a different project.',
      );
    return { store, project, settings };
  }
  private installPolicy(projectId: string, profile: ProjectProfile) {
    Object.defineProperty(this.policies, projectId, {
      value: executionPolicy(profile),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  async open(root: string, id: string) {
    const existing = this.registry.list().find((project) => project.id === id);
    if (existing) {
      this.settingsContext(id);
      if (existing.root !== root)
        throw new DomainError(
          'PROJECT_ID_CONFLICT',
          'The same project ID is used in different directories.',
        );
      return existing;
    }
    const loaded = structuredClone(await this.options.repository.load(root));
    if (loaded.project.id !== id)
      throw new DomainError(
        'PROJECT_ID_CONFLICT',
        'The profile ID differs from the saved connection.',
      );
    if (this.registry.list().some((project) => project.root === loaded.project.root))
      throw new DomainError('PROJECT_EXISTS', 'This root is already registered.');
    const requested = validateProjectIdentity(loaded.project);
    const store = await this.options.stores.open({
      storageAddress: loaded.storageAddress,
      project: requested,
      profile: loaded.profile,
    });
    let transferred = false;
    try {
      const { project, settings } = this.settingsContext(id, store);
      if (
        project.root !== requested.root ||
        project.managed !== requested.managed ||
        project.dataDirectory !== requested.dataDirectory
      )
        throw new DomainError(
          'PROJECT_STORAGE_MISMATCH',
          'The opened store belongs to a different project.',
        );
      let profile = await settings.profile();
      if (!profile) throw new DomainError('PROFILE_REQUIRED', 'The project needs saved settings.');
      if (!profile.baseBranch) {
        profile = await settings.transaction(
          { id: 'internal-base-' + this.id(), fingerprint: 'base' },
          (tx) => {
            const current = tx.profile();
            if (!current)
              throw new DomainError('PROFILE_REQUIRED', 'The project needs saved settings.');
            if (current.baseBranch) return current;
            return tx.initializeBaseBranch({
              expectedRevision: current.revision,
              baseBranch: loaded.branch || 'main',
            });
          },
        );
      }
      await this.options.repository.ensureLocal(project);
      this.registry.add(store);
      transferred = true;
      const current = await settings.profile();
      if (!current) throw new DomainError('PROFILE_REQUIRED', 'The project needs saved settings.');
      this.installPolicy(id, current);
      if (current.revision > loaded.profile.revision)
        await this.options.repository.exportProfile(project, current);
      else if (JSON.stringify(current) !== JSON.stringify(validateProjectProfile(loaded.profile)))
        this.report(
          'The project.json proposal differs from saved service settings; saved settings remain authoritative.',
          new DomainError(
            'PROFILE_PROPOSAL_DIFFERENT',
            'Import the proposal explicitly to change service settings.',
          ),
          project.root,
        );
      return project;
    } catch (error) {
      if (!transferred) {
        try {
          await store.close();
        } catch {
          /* Preserve the original admission failure. */
        }
      }
      throw error;
    }
  }
  connect(
    requestId: string,
    fingerprint: string,
    input: { root: string; name: string; profile: ProjectProfile; ignoreLocal?: boolean },
  ) {
    input = structuredClone(input);
    return this.serialize(async () => {
      const receipt = Object.hasOwn(this.catalog.receipts, requestId)
        ? this.catalog.receipts[requestId]
        : undefined;
      if (receipt) {
        if (receipt.fingerprint !== fingerprint)
          throw new DomainError('IDEMPOTENCY_CONFLICT', 'This ID was used for another connection.');
        await this.open(receipt.project.root, receipt.project.id);
        return structuredClone(receipt.project);
      }
      const info = await this.inspect(input.root),
        existing = this.registry.list().find((p) => p.root === info.root);
      if (existing) {
        const next = structuredClone(this.catalog);
        if (existing.managed && !next.projects.some((p) => p.id === existing.id))
          next.projects.push({ root: existing.root, id: existing.id });
        Object.defineProperty(next.receipts, requestId, {
          value: { fingerprint, project: existing },
          enumerable: true,
          configurable: true,
        });
        await this.options.catalog.save(structuredClone(next));
        this.catalog = next;
        return structuredClone(existing);
      }
      const prepared = await this.options.repository.prepareConnection({
        ...input,
        root: info.root,
      });
      const project = await this.open(prepared.root, prepared.id);
      const next = structuredClone(this.catalog);
      if (!next.projects.some((p) => p.id === project.id))
        next.projects.push({ root: project.root, id: project.id });
      Object.defineProperty(next.receipts, requestId, {
        value: { fingerprint, project },
        enumerable: true,
      });
      await this.options.catalog.save(structuredClone(next));
      this.catalog = next;
      return structuredClone(project);
    });
  }
  async info(projectId: string) {
    const { project, settings } = this.settingsContext(projectId);
    if (!project.managed)
      throw new DomainError('LEGACY_PROJECT', 'The demo project has no user profile.');
    const info = await this.inspect(project.root);
    const profile = await settings.profile();
    if (!profile) throw new DomainError('PROFILE_REQUIRED', 'The project needs saved settings.');
    return { ...info, profile };
  }
  private async exportCurrentProfile(context: { project: Project; settings: ProjectSettings }) {
    const current = await context.settings.profile();
    if (!current) throw new DomainError('PROFILE_REQUIRED', 'The project needs saved settings.');
    this.installPolicy(context.project.id, current);
    try {
      await this.options.repository.exportProfile(context.project, current);
    } catch (error) {
      this.report('The profile was saved by the service, but project.json export failed:', error);
      throw new DomainError(
        'PROFILE_EXPORT_FAILED',
        'Settings were saved by the service, but project.json could not be updated. Save again.',
      );
    }
  }
  private async configureSettings(
    command: { id: string; fingerprint: string },
    input: {
      projectId: string;
      profile: ProjectProfile;
      expectedRevision: number;
      researchId?: string;
    },
    context = this.settingsContext(input.projectId),
    capturedProposal?: ResearchProposal,
  ) {
    const cached = await context.settings.receipt(command);
    if (cached !== undefined) {
      await this.exportCurrentProfile(context);
      return validateProjectProfile(cached.result);
    }
    if (!context.project.managed)
      throw new DomainError('LEGACY_PROJECT', 'Settings are available for connected repositories.');
    const candidate = validateProjectProfile(input.profile);
    let expectedResearch: ResearchProposal | undefined;
    if (input.researchId) {
      expectedResearch = capturedProposal ?? (await context.settings.researchProposal());
      if (
        !expectedResearch ||
        expectedResearch.id !== input.researchId ||
        expectedResearch.status !== 'ready'
      )
        throw new DomainError('RESEARCH_STALE', 'Research changed. Refresh the suggestions.');
      const head = await this.options.repository.head(context.project.root);
      if (head !== expectedResearch.sourceHead)
        throw new DomainError(
          'RESEARCH_STALE',
          'The repository changed after research. Research again before applying suggestions.',
        );
    }
    const result = await context.settings.transaction(command, (tx) =>
      tx.configure({
        expectedRevision: input.expectedRevision,
        profile: candidate,
        ...(expectedResearch ? { expectedResearch } : {}),
      }),
    );
    await this.exportCurrentProfile(context);
    return result;
  }
  configure(
    requestId: string,
    fingerprint: string,
    input: {
      projectId: string;
      profile: ProjectProfile;
      expectedRevision: number;
      researchId?: string;
    },
  ) {
    const captured = structuredClone(input);
    const command = { id: requestId, fingerprint };
    return this.serialize(() => this.configureSettings(command, captured));
  }
  applyResearch(
    requestId: string,
    fingerprint: string,
    input: { projectId: string; researchId: string; expectedRevision: number },
  ) {
    const captured = structuredClone(input);
    const command = { id: requestId, fingerprint };
    return this.serialize(async () => {
      const context = this.settingsContext(captured.projectId);
      const cached = await context.settings.receipt(command);
      if (cached !== undefined) {
        await this.exportCurrentProfile(context);
        return validateProjectProfile(cached.result);
      }
      const proposal = await context.settings.researchProposal();
      const profile = await context.settings.profile();
      if (
        !profile ||
        !proposal ||
        proposal.id !== captured.researchId ||
        proposal.status !== 'ready'
      )
        throw new DomainError(
          'RESEARCH_STALE',
          'Ready suggestions were not found. Refresh research.',
        );
      return this.configureSettings(
        command,
        { ...captured, profile: profileWithResearch(profile, proposal) },
        context,
        proposal,
      );
    });
  }
  async verify(
    projectId: string,
    checkIds: string[],
    workspaces: WorkspacePort,
    checks: CheckPort,
    meta = { id: 'verify-' + this.id(), fingerprint: JSON.stringify(checkIds) },
  ) {
    const selected = [...checkIds],
      command = structuredClone(meta);
    const { settings } = this.settingsContext(projectId);
    const cached = await settings.receipt(command);
    if (cached !== undefined) return validateProjectVerification(cached.result);
    const key = projectId + ':' + command.id,
      active = this.verifications.get(key);
    if (active) {
      if (active.fingerprint !== command.fingerprint)
        throw new DomainError('IDEMPOTENCY_CONFLICT', 'This ID was used for another verification.');
      return active.promise;
    }
    const task = this.verification(projectId, selected, workspaces, checks).then((result) =>
      settings.transaction(command, (tx) =>
        tx.saveVerification({ ...result, id: command.id, createdAt: this.now() }),
      ),
    );
    this.tasks.add(task);
    this.verifications.set(key, { fingerprint: command.fingerprint, promise: task });
    try {
      return await task;
    } finally {
      this.tasks.delete(task);
      this.verifications.delete(key);
    }
  }
  async verification(
    projectId: string,
    checkIds: string[],
    workspaces: WorkspacePort,
    checks: CheckPort,
  ) {
    const selected = [...checkIds];
    const { settings } = this.settingsContext(projectId);
    if (this.closing) throw new DomainError('STOPPING', 'The service is stopping.');
    const info = await this.info(projectId);
    if (await settings.hasActiveRun())
      throw new DomainError('PROJECT_BUSY', 'Wait for the goal to finish first.');
    if (selected.some((id) => !info.profile.checks.some((check) => check.id === id)))
      throw new DomainError('INVALID_CHECK', 'The check is not configured.');
    if (this.closing) throw new DomainError('STOPPING', 'The service is stopping.');
    const controller = new AbortController();
    this.controllers.add(controller);
    let environmentWorkspace: string | undefined;
    const verificationId = 'V-' + this.id();
    try {
      const workspace = await workspaces.prepare(projectId, verificationId, undefined, {
        profile: info.profile,
        managedEnvironment: !!this.environments,
        signal: controller.signal,
      });
      environmentWorkspace = workspace.path;
      if (this.environments) {
        const prepared = await this.environments.prepare({
          projectId,
          runId: verificationId,
          workspace: workspace.path,
          base: workspace.base,
          profile: info.profile,
          signal: controller.signal,
          report: async () => {},
        });
        if (!prepared.passed)
          return {
            workspace: workspace.path,
            base: workspace.base,
            profileRevision: info.profile.revision,
            passed: 0,
            total: 1,
            results: [prepared],
          };
      }
      const result = await checks.run(
        projectId,
        workspace.path,
        selected,
        controller.signal,
        info.profile,
      );
      return {
        workspace: workspace.path,
        base: workspace.base,
        profileRevision: info.profile.revision,
        ...result,
      };
    } finally {
      this.controllers.delete(controller);
      if (environmentWorkspace) await this.environments?.release(environmentWorkspace);
    }
  }
  apply(
    requestId: string,
    fingerprint: string,
    input: { projectId: string; runId: string; expectedHead: string; expectedBranch: string },
  ) {
    return this.serialize(async () => {
      const store = this.registry.get(input.projectId),
        cached = store.receipt(requestId, fingerprint);
      if (cached !== undefined) return cached as { commit: string; branch: string };
      const snapshot = store.snapshot(),
        run = snapshot.runs.find((r) => r.id === input.runId);
      if (!run || run.status !== 'completed' || !run.commit || !/^[a-f0-9]{40}$/.test(run.commit))
        throw new DomainError('NOT_ACCEPTED', 'Only an accepted result can be applied.');
      if (snapshot.runs.some((r) => !terminal(r)))
        throw new DomainError('PROJECT_BUSY', 'Wait for the current goal to finish.');
      const prepareId = resultApplyReceiptId('prepare', requestId),
        dispatchId = resultApplyReceiptId('dispatch', requestId);
      let intent = store.receipt(prepareId, fingerprint) as ResultApplyIntent | undefined;
      const change = (doc: ProjectDocument) => {
        const live = doc.runs.find((r) => r.id === input.runId);
        if (!live || live.status !== 'completed' || live.commit !== run.commit)
          throw new DomainError('NOT_ACCEPTED', 'The accepted result changed.');
        const goal = doc.goals.find((g) => g.id === live.goalId);
        if (!goal) throw new DomainError('NOT_FOUND', 'Goal not found.');
        return { type: 'run.changed' as const, run: live, goal };
      };
      if (!intent) {
        const info = await this.inspect(snapshot.project.root);
        if (info.head !== input.expectedHead || info.branch !== input.expectedBranch)
          throw new DomainError(
            'BRANCH_CHANGED',
            'The branch or its commit changed. Refresh the result before applying.',
          );
        if (!info.branch)
          throw new DomainError('DETACHED_HEAD', 'Switch the source repository to a branch first.');
        if (info.dirty)
          throw new DomainError(
            'DIRTY_WORKTREE',
            'The source directory has changes. Commit them to Git first.',
          );
        if (!(await this.options.repository.isAncestor(info.root, info.head, run.commit))) {
          throw new DomainError(
            'BRANCH_DIVERGED',
            'The branch changed independently of the result. Merge or cherry-pick manually.',
          );
        }
        const prepared: ResultApplyIntent = {
          version: 1,
          requestId,
          fingerprint,
          projectId: input.projectId,
          runId: input.runId,
          root: info.root,
          branch: info.branch,
          baseHead: info.head,
          targetCommit: run.commit,
          startedAt: this.now(),
          status: 'prepared',
        };
        intent = await store.transact(prepareId, fingerprint, (doc) => {
          const event = change(doc);
          if (doc.runs.some((r) => !terminal(r)))
            throw new DomainError('PROJECT_BUSY', 'Wait for the current goal to finish.');
          doc.resultApplyIntents ||= {};
          Object.defineProperty(doc.resultApplyIntents, requestId, {
            value: prepared,
            enumerable: true,
            writable: true,
            configurable: true,
          });
          return { result: prepared, change: event };
        });
      }
      if (
        intent.requestId !== requestId ||
        intent.fingerprint !== fingerprint ||
        intent.projectId !== input.projectId ||
        intent.runId !== input.runId ||
        intent.root !== snapshot.project.root ||
        intent.baseHead !== input.expectedHead ||
        intent.branch !== input.expectedBranch ||
        intent.targetCommit !== run.commit
      )
        throw new DomainError(
          'IDEMPOTENCY_CONFLICT',
          'The saved application has different inputs.',
        );
      const saved = intent;
      const reconciliationRequired = () =>
        new DomainError(
          'APPLY_RECONCILIATION_REQUIRED',
          'The saved application outcome needs reconciliation. The branch will not be merged again automatically.',
        );
      const observe = async () => {
        const info = await this.inspect(saved.root);
        if (info.root !== saved.root || info.branch !== saved.branch)
          throw reconciliationRequired();
        return info;
      };
      const settle = () =>
        store.transact(requestId, fingerprint, (doc) => {
          const event = change(doc),
            live = event.run,
            current = doc.resultApplyIntents?.[requestId];
          if (!current || current.targetCommit !== saved.targetCommit)
            throw reconciliationRequired();
          const at = this.now();
          current.status = 'completed';
          current.completedAt = at;
          live.appliedAt = live.appliedAt || at;
          live.appliedBranch = saved.branch;
          return {
            result: { commit: saved.targetCommit, branch: saved.branch },
            change: event,
          };
        });
      let info = await observe();
      if (info.head === saved.targetCommit) return settle();
      if (info.head !== saved.baseHead) throw reconciliationRequired();
      // A prior dispatch can still have an unknown outcome, even if HEAD currently looks unchanged.
      if (store.receipt(dispatchId, fingerprint) !== undefined) throw reconciliationRequired();
      if (info.dirty)
        throw new DomainError(
          'DIRTY_WORKTREE',
          'The source directory has changes. Commit them to Git first.',
        );
      const owner = this.id();
      const grant = await store.transact(dispatchId, fingerprint, (doc) => {
        const event = change(doc),
          current = doc.resultApplyIntents?.[requestId];
        if (!current || current.status !== 'prepared') throw reconciliationRequired();
        if (
          Object.values(doc.resultApplyIntents || {}).some(
            (pending) => pending.requestId !== requestId && pending.status === 'dispatched',
          )
        )
          throw new DomainError(
            'APPLY_IN_PROGRESS',
            'Reconcile the previous result application first.',
          );
        current.status = 'dispatched';
        current.dispatchOwner = owner;
        return { result: { owner }, change: event };
      });
      // Two managers can share a store. Only the caller whose nonce was committed owns dispatch.
      if (grant.owner !== owner) {
        if ((await observe()).head === saved.targetCommit) return settle();
        throw reconciliationRequired();
      }
      info = await observe();
      if (info.head === saved.targetCommit) return settle();
      if (info.head !== saved.baseHead || info.dirty) throw reconciliationRequired();
      try {
        await this.options.repository.fastForward(saved.root, saved.targetCommit);
      } catch {
        if ((await observe()).head === saved.targetCommit) return settle();
        throw reconciliationRequired();
      }
      if ((await observe()).head !== saved.targetCommit) throw reconciliationRequired();
      return settle();
    });
  }
  async dispose() {
    this.closing = true;
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled([...this.tasks]);
    await this.queue;
  }
}
