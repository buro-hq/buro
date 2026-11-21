import type { ExecutionEnvironmentPort } from '../../core/environment-ports.ts';
import { LEGACY_PROJECT_DIRECTORY } from '../../protocol/project-directory.ts';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { safeGit } from '../processes/safe-git.ts';
import { DomainError, type ProjectDocument } from '../../core/ports.ts';
import { resultApplyReceiptId, type ResultApplyIntent } from '../../core/result-apply.ts';
import {
  terminal,
  type ExecutionPolicy,
  type WorkspacePort,
  type CheckPort,
} from '../../core/execution-ports.ts';
import { defaultRoles } from '../../core/defaults.ts';
import { operationalRoles } from '../../core/operational-roles.ts';
import { profileWithResearch } from '../../protocol/research-profile.ts';
import type {
  Project,
  ProjectProfile,
  RepositoryInfo,
  ProjectVerification,
} from '../../protocol/domain.ts';
import { ProjectFileSchema, ProjectProfileSchema } from '../../protocol/projects.ts';
import { FileProjectStore } from './project-store.ts';
import { FileProjectRegistry } from './registry.ts';
import { findProjectDirectory, migrateProjectDirectory } from './project-directory.ts';
const ignoredMetadata = ['.', ':(exclude).buro', ':(exclude)' + LEGACY_PROJECT_DIRECTORY];
export function executionPolicy(profile: ProjectProfile): ExecutionPolicy {
  return {
    allowedPaths: profile.allowedPaths,
    protectedPaths: profile.protectedPaths,
    checks: profile.checks.map(({ id, title }) => ({ id, title })),
    defaultCheckIds: profile.defaultCheckIds,
    maxWorkers: profile.maxWorkers,
    maxRepairs: profile.maxRepairs,
    turnTimeoutMs: profile.turnTimeoutMs,
    context: profile.context,
    profile: structuredClone(profile),
  };
}
export function policyView(profile: ProjectProfile) {
  const {
    profile: _profile,
    context: _context,
    turnTimeoutMs: _timeout,
    ...view
  } = executionPolicy(profile);
  return view;
}
async function atomic(file: string, data: unknown) {
  const temp = file + '.' + randomUUID() + '.tmp';
  const handle = await fs.open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(data, null, 2) + '\n');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}
async function safeMetadata(root: string) {
  const directory = await findProjectDirectory(root);
  try {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new DomainError('UNSAFE_PATH', 'The .buro directory must be a regular directory.');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  for (const name of [
    'project.json',
    'control-state.json',
    'writer.lock',
    'worktrees',
    'local',
    '.gitignore',
  ])
    try {
      if ((await fs.lstat(path.join(directory, name))).isSymbolicLink())
        throw new DomainError('UNSAFE_PATH', 'Service files must not be symlinks.');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  return directory;
}
type Catalog = {
  version: 1;
  projects: { root: string; id: string }[];
  receipts: Record<string, { fingerprint: string; project: Project }>;
};
export class ProjectManager {
  registry: FileProjectRegistry;
  policies: Record<string, ExecutionPolicy>;
  catalogFile: string;
  environments?: ExecutionEnvironmentPort;
  catalog: Catalog = { version: 1, projects: [], receipts: {} };
  queue: Promise<unknown> = Promise.resolve();
  controllers = new Set<AbortController>();
  tasks = new Set<Promise<unknown>>();
  closing = false;
  verifications = new Map<string, { fingerprint: string; promise: Promise<ProjectVerification> }>();
  constructor(options: {
    registry: FileProjectRegistry;
    policies: Record<string, ExecutionPolicy>;
    catalogFile: string;
    environments?: ExecutionEnvironmentPort;
  }) {
    this.registry = options.registry;
    this.policies = options.policies;
    this.catalogFile = options.catalogFile;
    this.environments = options.environments;
  }
  serialize<T>(fn: () => Promise<T>) {
    if (this.closing)
      return Promise.reject(new DomainError('STOPPING', 'The service is stopping.'));
    const result = this.queue.then(fn);
    this.queue = result.catch(() => {});
    return result;
  }
  async inspect(input: string): Promise<RepositoryInfo> {
    let root: string;
    try {
      root = await fs.realpath(
        input.startsWith('~/') ? path.join(os.homedir(), input.slice(2)) : path.resolve(input),
      );
    } catch {
      throw new DomainError('INVALID_REPOSITORY', 'Directory not found.');
    }
    let top: string, head: string;
    try {
      top = await fs.realpath(
        (await safeGit(['rev-parse', '--show-toplevel'], { cwd: root })).stdout.trim(),
      );
      head = (await safeGit(['rev-parse', '--verify', 'HEAD'], { cwd: root })).stdout.trim();
    } catch {
      throw new DomainError(
        'INVALID_REPOSITORY',
        'A Git repository with at least one commit is required.',
      );
    }
    if (root !== top)
      throw new DomainError('NOT_REPOSITORY_ROOT', 'Select the repository root: ' + top);
    const directory = await safeMetadata(root);
    let branch = '';
    try {
      branch = (await safeGit(['symbolic-ref', '--short', 'HEAD'], { cwd: root })).stdout.trim();
    } catch {}
    const status = (
      await safeGit(
        ['status', '--porcelain', '--untracked-files=normal', '--', ...ignoredMetadata],
        { cwd: root, literalPathspecs: false },
      )
    ).stdout;
    let stored: ReturnType<typeof ProjectFileSchema.parse> | undefined;
    try {
      stored = ProjectFileSchema.parse(
        JSON.parse(await fs.readFile(path.join(directory, 'project.json'), 'utf8')),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new DomainError(
          'INVALID_PROFILE',
          'Could not read .buro/project.json. Check the profile format.',
        );
    }
    let pkg: {
      name?: string;
      packageManager?: string;
      scripts?: Record<string, string>;
      workspaces?: unknown;
    } = {};
    try {
      pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    } catch {}
    const exists = async (name: string) =>
      !!(await fs.stat(path.join(root, name)).catch(() => null));
    const manager =
      pkg.packageManager?.split('@')[0] ||
      ((await exists('yarn.lock')) ? 'yarn' : (await exists('pnpm-lock.yaml')) ? 'pnpm' : 'npm');
    const checks = ['test', 'typecheck', 'check', 'lint']
      .filter((id) => typeof pkg.scripts?.[id] === 'string')
      .map((id) => ({
        id,
        title: (
          {
            test: 'Tests',
            typecheck: 'Type check',
            check: 'Project check',
            lint: 'Lint',
          } as Record<string, string>
        )[id],
        command: `${manager} run ${id}`,
        timeoutMs: 180000,
      }));
    const profile: ProjectProfile = stored?.profile || {
      version: 1,
      revision: 0,
      context:
        'Follow AGENTS.md and project documentation. Modify only the files required for the current goal.',
      allowedPaths: (await exists('src')) ? ['src/'] : ['./'],
      protectedPaths: ['AGENTS.md'],
      checks,
      defaultCheckIds: checks.length ? [checks[0].id] : [],
      setup: [],
      dependencies:
        !pkg.workspaces && (await exists('node_modules')) ? 'link-node-modules' : 'none',
      maxWorkers: 2,
      maxRepairs: 2,
      turnTimeoutMs: 360000,
      baseBranch: branch || 'main',
      components: [],
      delivery: { remote: 'origin', pullRequests: true, environments: [] },
    };
    if (!stored) {
      try {
        profile.baseBranch = (
          await safeGit(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: root })
        ).stdout
          .trim()
          .replace(/^origin\//, '');
      } catch {}
    }
    const existing = this.registry.list().find((p) => p.root === root);
    const warnings = [];
    if (pkg.workspaces && !stored)
      warnings.push(
        'This is a monorepo. Configure workspace dependency setup to verify changed packages; shared node_modules may point to the source checkout.',
      );
    if (status.trim())
      warnings.push(
        'The source directory has uncommitted changes. Execution uses the selected commit without those changes.',
      );
    if (!branch)
      warnings.push(
        'The repository is in detached HEAD; applying the result to a branch is unavailable.',
      );
    if (!checks.length && !stored)
      warnings.push('No check commands were found. Add at least one before starting a goal.');
    return {
      root,
      name: stored?.name || pkg.name || path.basename(root),
      branch,
      head,
      dirty: !!status.trim(),
      dirtyFiles: status.trimEnd().split('\n').filter(Boolean),
      profile,
      projectId: existing?.id,
      warnings,
    };
  }
  async restore() {
    try {
      const value = JSON.parse(await fs.readFile(this.catalogFile, 'utf8'));
      if (value.version !== 1 || !Array.isArray(value.projects) || !value.receipts)
        throw Error('Invalid project catalog.');
      this.catalog = value;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    for (const item of this.catalog.projects)
      try {
        await this.open(item.root, item.id);
      } catch (e) {
        console.error(
          'Could not open project',
          item.root,
          e instanceof Error ? e.message : String(e),
        );
      }
  }
  async open(root: string, id: string) {
    const existing = this.registry.list().find((p) => p.id === id);
    if (existing) {
      if (existing.root !== root)
        throw new DomainError(
          'PROJECT_ID_CONFLICT',
          'The same project ID is used in different directories.',
        );
      return existing;
    }
    await this.inspect(root);
    await migrateProjectDirectory(root);
    const info = await this.inspect(root),
      file = ProjectFileSchema.parse(
        JSON.parse(await fs.readFile(path.join(root, '.buro/project.json'), 'utf8')),
      );
    if (file.id !== id)
      throw new DomainError(
        'PROJECT_ID_CONFLICT',
        'The profile ID differs from the saved connection.',
      );
    if (this.registry.list().some((p) => p.root === info.root))
      throw new DomainError('PROJECT_EXISTS', 'This root is already registered.');
    const project: Project = {
      id,
      name: file.name,
      root: info.root,
      managed: true,
      dataDirectory: path.join(root, '.buro'),
    };
    const store = await FileProjectStore.open({
      directory: project.dataDirectory!,
      project,
      profile: info.profile,
      roles: defaultRoles.filter((r) => ['coordinator', 'reviewer'].includes(r.id)),
    });
    if (!store.snapshot().profile?.baseBranch) {
      await store.transact('internal-base-' + randomUUID(), 'base', (doc) => {
        doc.profile = {
          ...doc.profile!,
          baseBranch: info.profile.baseBranch || info.branch || 'main',
          revision: doc.profile!.revision + 1,
        };
        return {
          result: null,
          change: {
            type: 'project.configured',
            profile: doc.profile,
            executionPolicy: policyView(doc.profile),
          },
        };
      });
    }
    for (const role of operationalRoles) {
      if (!store.snapshot().roles.some((r) => r.id === role.id))
        await store.transact('internal-role-' + randomUUID(), 'template', (doc) => {
          doc.roleVersions.push(role);
          return { result: null, change: { type: 'role.saved', role } };
        });
    }
    await fs.mkdir(path.join(root, '.buro/local'), { recursive: true, mode: 0o700 });
    this.registry.add(store);
    Object.defineProperty(this.policies, id, {
      value: executionPolicy(store.snapshot().profile!),
      enumerable: true,
      configurable: true,
      writable: true,
    });
    if (store.snapshot().profile!.revision > info.profile.revision)
      await atomic(path.join(root, '.buro/project.json'), {
        ...file,
        profile: store.snapshot().profile,
      });
    return project;
  }
  connect(
    requestId: string,
    fingerprint: string,
    input: { root: string; name: string; profile: ProjectProfile; ignoreLocal?: boolean },
  ) {
    return this.serialize(async () => {
      const receipt = Object.hasOwn(this.catalog.receipts, requestId)
        ? this.catalog.receipts[requestId]
        : undefined;
      if (receipt) {
        if (receipt.fingerprint !== fingerprint)
          throw new DomainError('IDEMPOTENCY_CONFLICT', 'This ID was used for another connection.');
        await this.open(receipt.project.root, receipt.project.id);
        return receipt.project;
      }
      const info = await this.inspect(input.root),
        existing = this.registry.list().find((p) => p.root === info.root);
      if (existing) {
        if (existing.managed && !this.catalog.projects.some((p) => p.id === existing.id))
          this.catalog.projects.push({ root: existing.root, id: existing.id });
        Object.defineProperty(this.catalog.receipts, requestId, {
          value: { fingerprint, project: existing },
          enumerable: true,
          configurable: true,
        });
        await atomic(this.catalogFile, this.catalog);
        return existing;
      }
      await migrateProjectDirectory(info.root);
      const directory = await safeMetadata(info.root);
      await fs.mkdir(directory, { recursive: true });
      let file: ReturnType<typeof ProjectFileSchema.parse>;
      try {
        file = ProjectFileSchema.parse(
          JSON.parse(await fs.readFile(path.join(directory, 'project.json'), 'utf8')),
        );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        file = {
          version: 1,
          id: 'p-' + randomUUID(),
          name: input.name,
          profile: { ...ProjectProfileSchema.parse(input.profile), revision: 1 },
        };
        await atomic(path.join(directory, 'project.json'), file);
      }
      // The nested ignore file keeps local history/worktrees private while the profile can be committed.
      try {
        await fs.writeFile(
          path.join(directory, '.gitignore'),
          `control-state.json*\nwriter.lock\nworktrees/\n${input.ignoreLocal !== false ? 'local/\n' : ''}`,
          {
            flag: 'wx',
          },
        );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      if (input.ignoreLocal !== false) {
        const ignoreFile = path.join(directory, '.gitignore'),
          content = await fs.readFile(ignoreFile, 'utf8');
        if (!content.split(/\r?\n/).includes('local/'))
          await fs.appendFile(ignoreFile, (content.endsWith('\n') ? '' : '\n') + 'local/\n');
      }
      const project = await this.open(info.root, file.id);
      const next = structuredClone(this.catalog);
      if (!next.projects.some((p) => p.id === project.id))
        next.projects.push({ root: project.root, id: project.id });
      Object.defineProperty(next.receipts, requestId, {
        value: { fingerprint, project },
        enumerable: true,
      });
      await atomic(this.catalogFile, next);
      this.catalog = next;
      return project;
    });
  }
  async info(projectId: string) {
    const project = this.registry.get(projectId).snapshot().project;
    if (!project.managed)
      throw new DomainError('LEGACY_PROJECT', 'The demo project has no user profile.');
    const info = await this.inspect(project.root);
    return { ...info, profile: this.registry.get(projectId).snapshot().profile! };
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
    return this.serialize(async () => {
      const store = this.registry.get(input.projectId),
        snapshot = store.snapshot();
      if (!snapshot.project.managed)
        throw new DomainError(
          'LEGACY_PROJECT',
          'Settings are available for connected repositories.',
        );
      const profile = {
        ...ProjectProfileSchema.parse(input.profile),
        revision: input.expectedRevision + 1,
      };
      const file = path.join(snapshot.project.root, '.buro/project.json');
      if (input.researchId) {
        const research = snapshot.research;
        if (!research || research.id !== input.researchId || research.status !== 'ready')
          throw new DomainError('RESEARCH_STALE', 'Research changed. Refresh the suggestions.');
        const head = (
          await safeGit(['rev-parse', 'HEAD'], { cwd: snapshot.project.root })
        ).stdout.trim();
        if (head !== research.sourceHead)
          throw new DomainError(
            'RESEARCH_STALE',
            'The repository changed after research. Research again before applying suggestions.',
          );
      }
      // Store receipts also cover a lost configuration response.
      const result = await store.transact(requestId, fingerprint, (doc) => {
        if (doc.runs.some((r) => !terminal(r)))
          throw new DomainError('PROJECT_BUSY', 'Settings can be changed after the goal finishes.');
        if (doc.profile?.revision !== input.expectedRevision)
          throw new DomainError('CONFLICT', 'Settings changed. Reload the profile.');
        if (input.researchId && doc.research?.id !== input.researchId)
          throw new DomainError('RESEARCH_STALE', 'Research has already been replaced.');
        doc.profile = profile;
        if (doc.research?.status === 'ready')
          doc.research.reviewedProfileRevision = profile.revision;
        if (input.researchId && doc.research)
          doc.research.appliedProfileRevision = profile.revision;
        return {
          result: profile,
          change: {
            type: 'project.configured',
            profile,
            executionPolicy: policyView(profile),
            research: doc.research,
          },
        };
      });
      const current = store.snapshot().profile!;
      Object.defineProperty(this.policies, input.projectId, {
        value: executionPolicy(current),
        enumerable: true,
        configurable: true,
        writable: true,
      });
      try {
        await atomic(file, {
          version: 1,
          id: snapshot.project.id,
          name: snapshot.project.name,
          profile: current,
        });
      } catch (e) {
        console.error(
          'The profile was saved in control-state, but project.json export failed:',
          String(e),
        );
        throw new DomainError(
          'PROFILE_EXPORT_FAILED',
          'Settings were saved by the service, but project.json could not be updated. Save again.',
        );
      }
      return result;
    });
  }
  applyResearch(
    requestId: string,
    fingerprint: string,
    input: { projectId: string; researchId: string; expectedRevision: number },
  ) {
    const store = this.registry.get(input.projectId),
      snapshot = store.snapshot();
    if (store.receipt(requestId, fingerprint) !== undefined)
      return this.configure(requestId, fingerprint, {
        projectId: input.projectId,
        profile: snapshot.profile!,
        expectedRevision: input.expectedRevision,
      });
    if (
      !snapshot.profile ||
      snapshot.research?.id !== input.researchId ||
      snapshot.research.status !== 'ready'
    )
      throw new DomainError(
        'RESEARCH_STALE',
        'Ready suggestions were not found. Refresh research.',
      );
    return this.configure(requestId, fingerprint, {
      ...input,
      profile: profileWithResearch(snapshot.profile, snapshot.research),
    });
  }
  async verify(
    projectId: string,
    checkIds: string[],
    workspaces: WorkspacePort,
    checks: CheckPort,
    meta = { id: 'verify-' + randomUUID(), fingerprint: JSON.stringify(checkIds) },
  ) {
    const store = this.registry.get(projectId),
      cached = store.receipt(meta.id, meta.fingerprint);
    if (cached !== undefined) return cached as ProjectVerification;
    const key = projectId + ':' + meta.id,
      active = this.verifications.get(key);
    if (active) {
      if (active.fingerprint !== meta.fingerprint)
        throw new DomainError('IDEMPOTENCY_CONFLICT', 'This ID was used for another verification.');
      return active.promise;
    }
    const task = this.verification(projectId, checkIds, workspaces, checks).then(async (result) => {
      const verification: ProjectVerification = {
        ...result,
        id: meta.id,
        createdAt: new Date().toISOString(),
      };
      return store.transact(meta.id, meta.fingerprint, (doc) => {
        doc.verification = verification;
        return { result: verification, change: { type: 'project.verified', verification } };
      });
    });
    this.tasks.add(task);
    this.verifications.set(key, { fingerprint: meta.fingerprint, promise: task });
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
    if (this.closing) throw new DomainError('STOPPING', 'The service is stopping.');
    const info = await this.info(projectId);
    if (
      this.registry
        .get(projectId)
        .snapshot()
        .runs.some((r) => !terminal(r))
    )
      throw new DomainError('PROJECT_BUSY', 'Wait for the goal to finish first.');
    if (checkIds.some((id) => !info.profile.checks.some((c) => c.id === id)))
      throw new DomainError('INVALID_CHECK', 'The check is not configured.');
    const controller = new AbortController();
    this.controllers.add(controller);
    let environmentWorkspace: string | undefined;
    const verificationId = 'V-' + randomUUID();
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
        checkIds,
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
        try {
          await safeGit(['merge-base', '--is-ancestor', info.head, run.commit], { cwd: info.root });
        } catch {
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
          startedAt: new Date().toISOString(),
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
          const at = new Date().toISOString();
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
      const owner = randomUUID();
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
        await safeGit(['merge', '--ff-only', '--no-verify', saved.targetCommit], {
          cwd: saved.root,
        });
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
