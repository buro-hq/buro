import type { ExecutionEnvironmentPort } from '../../core/environment-ports.ts';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { safeGit } from '../processes/safe-git.ts';
import {
  DomainError,
  type MutableProjectRegistry,
  type ProjectStoreFactory,
} from '../../core/ports.ts';
import type { ExecutionPolicy } from '../../core/execution-ports.ts';
import type { Project, ProjectProfile, RepositoryInfo } from '../../protocol/domain.ts';
import { ProjectFileSchema, ProjectProfileSchema } from '../../protocol/projects.ts';
import {
  ProjectApplication,
  type ProjectRepositoryPort,
  type ProjectCatalogPort,
  type ProjectCatalog,
} from '../../core/project-application.ts';
import { FileProjectStoreFactory } from './project-store-factory.ts';
import { findProjectDirectory } from './project-directory.ts';
import type { CheckRecipeCatalog, CheckRecipeDiscovery } from '../../core/check-recipes.ts';
import { createBuiltinCheckRecipes } from '../discovery/check-recipes/builtins.ts';
import { captureCheckRecipeFacts } from '../discovery/check-recipes/manifest-facts.ts';
export { executionPolicy, policyView } from '../../core/project-application.ts';
const ignoredMetadata = ['.', ':(exclude).buro'];
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
export class FileProjectRepository implements ProjectRepositoryPort {
  readonly checkRecipes: CheckRecipeCatalog;
  constructor(checkRecipes: CheckRecipeCatalog = createBuiltinCheckRecipes()) {
    this.checkRecipes = checkRecipes;
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
    const discovery: CheckRecipeDiscovery = stored
      ? { checks: [], defaultCheckIds: [], setup: [], warnings: [], sources: [] }
      : this.checkRecipes.discover(await captureCheckRecipeFacts(root, head, this.checkRecipes));
    const checks = discovery.checks;
    const profile: ProjectProfile = stored?.profile || {
      version: 1,
      revision: 0,
      context:
        'Follow AGENTS.md and project documentation. Modify only the files required for the current goal.',
      scope: { mode: 'advisory', plannedPaths: [], protectedPaths: ['AGENTS.md'] },
      checks,
      defaultCheckIds: discovery.defaultCheckIds,
      setup: discovery.setup,
      dependencies: discovery.dependencies || 'none',
      ...(discovery.environmentRecipe
        ? { environment: { provider: 'native' as const, recipe: discovery.environmentRecipe } }
        : {}),
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
    const warnings = [...discovery.warnings];
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
    if ((await safeGit(['rev-parse', '--verify', 'HEAD'], { cwd: root })).stdout.trim() !== head)
      throw new DomainError(
        'REPOSITORY_CHANGED',
        'The repository changed during inspection. Inspect it again.',
      );
    return {
      root,
      name: stored?.name || discovery.projectName || path.basename(root),
      branch,
      head,
      dirty: !!status.trim(),
      checkRecipes: discovery.sources,
      dirtyFiles: status.trimEnd().split('\n').filter(Boolean),
      profile,
      warnings,
    };
  }
  async load(root: string) {
    const info = await this.inspect(root);
    const file = ProjectFileSchema.parse(
      JSON.parse(await fs.readFile(path.join(root, '.buro/project.json'), 'utf8')),
    );
    const project: Project = {
      id: file.id,
      name: file.name,
      root: info.root,
      managed: true,
      dataDirectory: path.join(root, '.buro'),
    };
    return {
      project,
      profile: info.profile,
      branch: info.branch,
      storageAddress: project.dataDirectory!,
    };
  }
  async prepareConnection(input: {
    root: string;
    name: string;
    profile: ProjectProfile;
    ignoreLocal?: boolean;
  }) {
    const info = { root: input.root };
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
    return { root: info.root, id: file.id };
  }
  async ensureLocal(project: Project) {
    await fs.mkdir(path.join(project.root, '.buro/local'), { recursive: true, mode: 0o700 });
  }
  async exportProfile(project: Project, profile: ProjectProfile) {
    await atomic(path.join(project.root, '.buro/project.json'), {
      version: 1,
      id: project.id,
      name: project.name,
      profile,
    });
  }
  async head(root: string) {
    return (await safeGit(['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
  }
  async isAncestor(root: string, ancestor: string, target: string) {
    try {
      await safeGit(['merge-base', '--is-ancestor', ancestor, target], { cwd: root });
      return true;
    } catch {
      return false;
    }
  }
  async fastForward(root: string, target: string) {
    await safeGit(['merge', '--ff-only', '--no-verify', target], { cwd: root });
  }
}
export class FileProjectCatalog implements ProjectCatalogPort {
  readonly filename: string;
  constructor(filename: string) {
    this.filename = filename;
  }
  async load(): Promise<ProjectCatalog | undefined> {
    try {
      const value = JSON.parse(await fs.readFile(this.filename, 'utf8'));
      if (value.version !== 1 || !Array.isArray(value.projects) || !value.receipts)
        throw Error('Invalid project catalog.');
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  save(value: ProjectCatalog) {
    return atomic(this.filename, value);
  }
}

/** Filesystem composition only. All project workflow and receipt ownership live in Core. */
export class ProjectManager extends ProjectApplication {
  readonly catalogFile: string;
  constructor(options: {
    registry: MutableProjectRegistry;
    policies: Record<string, ExecutionPolicy>;
    catalogFile: string;
    environments?: ExecutionEnvironmentPort;
    stores?: ProjectStoreFactory;
  }) {
    super({
      registry: options.registry,
      policies: options.policies,
      environments: options.environments,
      stores: options.stores || new FileProjectStoreFactory(),
      repository: new FileProjectRepository(),
      catalog: new FileProjectCatalog(options.catalogFile),
      id: randomUUID,
      now: () => new Date().toISOString(),
      report: (message, error, root) => {
        if (root)
          console.error(message, root, error instanceof Error ? error.message : String(error));
        else console.error(message, String(error));
      },
    });
    this.catalogFile = options.catalogFile;
  }
}
