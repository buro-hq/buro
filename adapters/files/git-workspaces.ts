import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { safeGit } from '../processes/safe-git.ts';
import type { WorkspacePort } from '../../core/execution-ports.ts';
import type { ProjectRegistry } from '../../core/ports.ts';
import { DomainError } from '../../core/ports.ts';
import { runProjectCommand } from '../checks/project-commands.ts';
import type { ProjectProfile, ContextMaterial } from '../../protocol/domain.ts';
import { stageContextMaterials } from './context-materials.ts';
import { NodeEnvironment } from '../dependencies/node-environment.ts';

async function inspectWorkspacePath(workspace: string, expectedRoot: string, file: string) {
  const parts = file.split('/');
  if (
    !file ||
    path.isAbsolute(file) ||
    parts.some((part) => !part || part === '..' || part === '.')
  )
    throw Error('Invalid workspace file path.');
  if (
    (await fs.lstat(workspace)).isSymbolicLink() ||
    (await fs.realpath(workspace)) !== expectedRoot
  )
    throw Error('The workspace path changed.');
  let target = expectedRoot;
  for (let index = 0; index < parts.length; index++) {
    target = path.join(target, parts[index]);
    const stat = await fs.lstat(target);
    if (index === parts.length - 1) return { target, stat };
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw Error('Unsafe workspace ancestor: ' + file);
  }
  throw Error('Invalid workspace file path.');
}

async function readWorkspaceFile(
  workspace: string,
  expectedRoot: string,
  file: string,
  limit: number,
) {
  const { target, stat } = await inspectWorkspacePath(workspace, expectedRoot, file);
  if (!stat.isFile()) throw Error('Not a regular workspace file: ' + file);
  const handle = await fs.open(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = await handle.stat();
    const current = await inspectWorkspacePath(workspace, expectedRoot, file);
    if (
      !opened.isFile() ||
      opened.dev !== stat.dev ||
      opened.ino !== stat.ino ||
      current.stat.dev !== opened.dev ||
      current.stat.ino !== opened.ino ||
      (await fs.realpath(target)) !== target
    )
      throw Error('The workspace file changed while opening: ' + file);
    if (opened.size > limit) throw Error('File diff exceeds size limit: ' + file);
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

export class GitWorkspaces implements WorkspacePort {
  projects: ProjectRegistry;
  records = new Map<
    string,
    {
      base: string;
      gitPointer: string;
      gitDirectory: string;
      realWorkspace: string;
      dependencyLink?: string;
      environment?: NodeEnvironment;
      contextRoot: string;
      materials: ContextMaterial[];
    }
  >();
  environmentFactory: (workspace: string, root: string) => NodeEnvironment;
  constructor(
    projects: ProjectRegistry,
    environmentFactory = (workspace: string, root: string) => new NodeEnvironment(workspace, root),
  ) {
    this.projects = projects;
    this.environmentFactory = environmentFactory;
  }
  async prepare(
    projectId: string,
    runId: string,
    base = 'HEAD',
    options?: {
      profile?: ProjectProfile;
      signal?: AbortSignal;
      repairEnvironment?: boolean;
      managedEnvironment?: boolean;
      materials?: ContextMaterial[];
    },
  ) {
    if (
      !/^[A-Za-z0-9_-]+$/.test(runId) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/.test(base) ||
      base.includes('..')
    )
      throw Error('Invalid workspace ID.');
    const root = this.projects.get(projectId).snapshot().project.root,
      workspace = path.join(root, '.buro', 'worktrees', runId);
    try {
      if ((await fs.lstat(path.join(root, '.buro'))).isSymbolicLink())
        throw Error('The .buro directory must not be a symlink.');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const sha = (
      await safeGit(['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`], {
        cwd: root,
      })
    ).stdout.trim();
    await fs.mkdir(path.dirname(workspace), { recursive: true });
    await safeGit(['worktree', 'add', '--detach', workspace, sha], { cwd: root });
    let dependencyLink: string | undefined;
    if (
      !options?.managedEnvironment &&
      !options?.repairEnvironment &&
      options?.profile?.dependencies === 'link-node-modules'
    ) {
      const source = path.join(root, 'node_modules');
      try {
        if (!(await fs.stat(source)).isDirectory()) throw Error('node_modules is not a directory.');
        dependencyLink = await fs.realpath(source);
        await fs.symlink(dependencyLink, path.join(workspace, 'node_modules'), 'dir');
      } catch (e) {
        throw new DomainError(
          'DEPENDENCIES_MISSING',
          `Could not link node_modules. Prepare source project dependencies or select another setup method. ${String(e)}`,
        );
      }
    }
    const environment =
      options?.repairEnvironment && !options?.managedEnvironment
        ? this.environmentFactory(workspace, root)
        : undefined;
    if (environment)
      await environment.prepare(
        options?.profile?.dependencies === 'link-node-modules',
        options?.signal,
      );
    const realWorkspace = await fs.realpath(workspace);
    this.records.set(workspace, {
      base: sha,
      gitPointer: await readWorkspaceFile(workspace, realWorkspace, '.git', 64 * 1024),
      realWorkspace,
      gitDirectory: (
        await safeGit(['rev-parse', '--absolute-git-dir'], { cwd: workspace })
      ).stdout.trim(),
      dependencyLink,
      environment,
      contextRoot: root,
      materials: options?.materials || [],
    });
    await stageContextMaterials(root, workspace, options?.materials || []);
    for (const command of options?.managedEnvironment ? [] : options?.profile?.setup || []) {
      const result = await runProjectCommand(
        command,
        workspace,
        root,
        options?.signal || new AbortController().signal,
      );
      if (result.exitCode !== 0)
        throw new DomainError(
          'SETUP_FAILED',
          `${command.title}: ${result.output.slice(-3000) || 'The command failed.'}`,
        );
    }
    return { path: workspace, base: sha };
  }
  async restore(
    projectId: string,
    runId: string,
    workspace: string,
    base: string,
    options?: {
      profile?: ProjectProfile;
      repairEnvironment?: boolean;
      managedEnvironment?: boolean;
      materials?: ContextMaterial[];
    },
  ) {
    const root = await fs.realpath(this.projects.get(projectId).snapshot().project.root),
      expected = path.join(root, '.buro', 'worktrees', runId);
    if (
      !/^[A-Za-z0-9_-]+$/.test(runId) ||
      !/^[a-f0-9]{40}$/.test(base) ||
      path.resolve(workspace) !== expected
    )
      throw new DomainError(
        'INVALID_WORKSPACE',
        'The workspace path does not match the saved run.',
      );
    const actual = await fs.realpath(workspace);
    if (actual !== expected)
      throw new DomainError('INVALID_WORKSPACE', 'The workspace was replaced with a symlink.');
    const gitPointer = await readWorkspaceFile(workspace, actual, '.git', 64 * 1024);
    const top = (await safeGit(['rev-parse', '--show-toplevel'], { cwd: workspace })).stdout.trim();
    if ((await fs.realpath(top)) !== actual)
      throw new DomainError('INVALID_WORKSPACE', 'The workspace is not a Git root.');
    const sourceCommon = await fs.realpath(
        (
          await safeGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], {
            cwd: root,
          })
        ).stdout.trim(),
      ),
      workCommon = await fs.realpath(
        (
          await safeGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], {
            cwd: workspace,
          })
        ).stdout.trim(),
      );
    if (
      sourceCommon !== workCommon ||
      (await safeGit(['rev-parse', 'HEAD'], { cwd: workspace })).stdout.trim() !== base
    )
      throw new DomainError(
        'WORKSPACE_CHANGED',
        'The workspace Git base changed. Automatic continuation stopped.',
      );
    let dependencyLink: string | undefined,
      privateDependencies = false;
    if (
      !options?.managedEnvironment &&
      !options?.repairEnvironment &&
      options?.profile?.dependencies === 'link-node-modules'
    ) {
      const actualDependencies = await fs.realpath(path.join(workspace, 'node_modules'));
      const sourceDependencies = await fs.realpath(path.join(root, 'node_modules'));
      privateDependencies = actualDependencies === path.join(workspace, 'node_modules');
      if (!privateDependencies && actualDependencies !== sourceDependencies)
        throw new DomainError(
          'DEPENDENCIES_CHANGED',
          'The workspace dependency directory changed.',
        );
      if (!privateDependencies) dependencyLink = sourceDependencies;
    }
    const environment =
      (options?.repairEnvironment && !options?.managedEnvironment) || privateDependencies
        ? this.environmentFactory(workspace, root)
        : undefined;
    if (environment) {
      const dependencies = path.join(workspace, 'node_modules');
      try {
        if ((await fs.lstat(dependencies)).isSymbolicLink()) {
          await fs.unlink(dependencies);
          await environment.prepare(true);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await environment.prepare(false);
      }
      await environment.restore();
    }
    if (options?.managedEnvironment) {
      const modules = path.join(workspace, 'node_modules');
      try {
        if ((await fs.lstat(modules)).isSymbolicLink()) await fs.unlink(modules);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    this.records.set(workspace, {
      base,
      gitPointer,
      realWorkspace: actual,
      gitDirectory: (
        await safeGit(['rev-parse', '--absolute-git-dir'], { cwd: workspace })
      ).stdout.trim(),
      dependencyLink,
      environment,
      contextRoot: root,
      materials: options?.materials || [],
    });
    await stageContextMaterials(root, workspace, options?.materials || []);
    return { path: workspace, base };
  }
  async validate(workspace: string) {
    const entry = this.records.get(workspace);
    if (!entry) throw Error('The workspace is not registered.');
    if (
      (await readWorkspaceFile(workspace, entry.realWorkspace, '.git', 64 * 1024)) !==
      entry.gitPointer
    )
      throw Error('Git control data changed.');
    if (
      entry.dependencyLink &&
      (await fs.readlink(path.join(workspace, 'node_modules'))) !== entry.dependencyLink
    )
      throw Error('The dependency symlink changed.');
    await entry.environment?.validate();
    await stageContextMaterials(entry.contextRoot, workspace, entry.materials);
    return entry;
  }
  async synchronizeDependencies(workspace: string, signal: AbortSignal) {
    const entry = await this.validate(workspace);
    if (!entry.environment)
      throw new DomainError(
        'ENVIRONMENT_NOT_ISOLATED',
        'Dependency installation requires an isolated environment.',
      );
    return entry.environment.synchronize(signal);
  }
  async changes(workspace: string, base: string) {
    const entry = await this.validate(workspace);
    if (entry.base !== base) throw Error('The workspace base changed.');
    const opts = { cwd: workspace, gitDirectory: entry.gitDirectory, maxBuffer: 32 * 1024 * 1024 };
    const tracked = (
        await safeGit(
          ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', base, '--'],
          opts,
        )
      ).stdout.split('\0'),
      untracked = (
        await safeGit(['ls-files', '--others', '--exclude-standard', '-z'], opts)
      ).stdout.split('\0');
    const oldFiles = new Set(
      (await safeGit(['ls-tree', '-r', '--name-only', '-z', base], opts)).stdout.split('\0'),
    );
    const files = [...new Set([...tracked, ...untracked])].filter(
      (f) =>
        f &&
        !['node_modules', '.buro'].some((dir) => f === dir || f.startsWith(dir + '/')) &&
        !(entry.environment && f === '.yarn/install-state.gz'),
    );
    const result = [];
    for (const file of files) {
      if (file.split('/').includes('..') || path.isAbsolute(file))
        throw Error('Invalid path in diff.');
      let before = '',
        after = '';
      try {
        before = (
          await safeGit(['show', '--no-ext-diff', '--no-textconv', `${base}:${file}`], {
            ...opts,
            maxBuffer: 2 * 1024 * 1024,
          })
        ).stdout;
      } catch {
        if (oldFiles.has(file)) throw Error('Could not read source file: ' + file);
      }
      try {
        const { target, stat } = await inspectWorkspacePath(workspace, entry.realWorkspace, file);
        if (stat.isSymbolicLink()) after = '[symlink ' + (await fs.readlink(target)) + ']';
        else after = await readWorkspaceFile(workspace, entry.realWorkspace, file, 1024 * 1024);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      if (before !== after) result.push({ path: file, before, after });
    }
    return result;
  }
  async checkpoint(workspace: string, runId: string) {
    const entry = await this.validate(workspace);
    const files = (await this.changes(workspace, entry.base)).map((file) => file.path);
    if (files.length)
      await safeGit(['add', '--all', '--', ...files], {
        cwd: workspace,
        gitDirectory: entry.gitDirectory,
      });
    const diff = await safeGit(
      ['diff', '--no-ext-diff', '--no-textconv', '--cached', '--name-only'],
      { cwd: workspace, gitDirectory: entry.gitDirectory },
    );
    if (diff.stdout.trim())
      await safeGit(
        [
          '-c',
          'core.hooksPath=/dev/null',
          'commit',
          '--no-gpg-sign',
          '--no-verify',
          '-m',
          `goal: ${runId}`,
        ],
        { cwd: workspace, gitDirectory: entry.gitDirectory },
      );
    return (
      await safeGit(['rev-parse', 'HEAD'], { cwd: workspace, gitDirectory: entry.gitDirectory })
    ).stdout.trim();
  }
}
