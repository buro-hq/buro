import fs from 'node:fs/promises';
import { constants, createWriteStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { safeGit } from '../processes/safe-git.ts';
import type { WorkspacePort } from '../../core/execution-ports.ts';
import type { ProjectRegistry } from '../../core/ports.ts';
import { DomainError } from '../../core/ports.ts';
import { runProjectCommand } from '../checks/project-commands.ts';
import type { ProjectProfile, ContextMaterial } from '../../protocol/domain.ts';
import { stageContextMaterials } from './context-materials.ts';
import { NodeEnvironment } from '../dependencies/node-environment.ts';
import { sameWorkspaceRevision, type WorkspaceRevision } from '../../core/workspace-revision.ts';
import type {
  VerificationView,
  OpenVerificationViewOptions,
} from '../../core/verification-view.ts';
import { materializeVerificationView, type VerificationViewHandle } from './verification-view.ts';

function revisionChanged() {
  return new DomainError(
    'VERIFICATION_REVISION_CHANGED',
    'The source, Git index or HEAD changed after verification. Check and review the current revision again.',
  );
}

async function copyWorkspaceFile(workspace: string, root: string, file: string, copy: string) {
  const { target, stat } = await inspectWorkspacePath(workspace, root, file);
  if (!stat.isFile()) throw Error('Not a regular workspace file: ' + file);
  const handle = await fs.open(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== BigInt(stat.dev) || opened.ino !== BigInt(stat.ino))
      throw revisionChanged();
    const objectHash = createHash('sha1').update(`blob ${opened.size}\0`);
    const stream = handle.createReadStream({ autoClose: false });
    stream.on('data', (chunk) => objectHash.update(chunk));
    await pipeline(stream, createWriteStream(copy, { mode: 0o600 }));
    const after = await handle.stat({ bigint: true });
    const current = await inspectWorkspacePath(workspace, root, file);
    if (
      opened.size !== after.size ||
      opened.mtimeNs !== after.mtimeNs ||
      opened.ctimeNs !== after.ctimeNs ||
      after.dev !== BigInt(current.stat.dev) ||
      after.ino !== BigInt(current.stat.ino) ||
      (await fs.realpath(target)) !== target
    )
      throw revisionChanged();
    return { mode: stat.mode & 0o111 ? '100755' : '100644', object: objectHash.digest('hex') };
  } finally {
    await handle.close();
  }
}

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
  private verificationViews = new Map<string, VerificationViewHandle>();
  records = new Map<
    string,
    {
      projectId: string;
      runId: string;
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
      projectId,
      runId,
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
      projectId,
      runId,
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
  async captureRevision(workspace: string, base: string): Promise<WorkspaceRevision> {
    const entry = await this.validate(workspace);
    if (entry.base !== base) throw revisionChanged();
    const opts = { cwd: workspace, gitDirectory: entry.gitDirectory };
    const state = async () => {
      const head = (await safeGit(['rev-parse', '--verify', 'HEAD'], opts)).stdout.trim();
      if (head !== base) throw revisionChanged();
      try {
        await safeGit(['symbolic-ref', '-q', 'HEAD'], opts);
        throw revisionChanged();
      } catch (error) {
        if ((error as { code?: unknown }).code !== 1) throw error;
      }
      const staged = (await safeGit(['ls-files', '--stage', '-v', '-z'], opts)).stdout;
      const entries = staged.split('\0').filter(Boolean);
      if (
        entries.some(
          (record) => record.slice(0, record.indexOf('\t')).trim().split(/\s+/).at(-1) !== '0',
        )
      )
        throw revisionChanged();
      const index = createHash('sha256').update(staged).digest('hex');
      const paths = entries.map((record) => record.slice(record.indexOf('\t') + 1));
      const skipped = new Set(
        entries
          .filter((record) => /^[Ss] /.test(record))
          .map((record) => record.slice(record.indexOf('\t') + 1)),
      );
      return { head, index, paths, skipped };
    };
    const initial = await state();
    let sparseCheckout = false;
    try {
      sparseCheckout =
        (
          await safeGit(['config', '--bool', '--get', 'core.sparseCheckout'], opts)
        ).stdout.trim() === 'true';
    } catch (error) {
      if ((error as { code?: unknown }).code !== 1) throw error;
    }
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-revision-'));
    try {
      const privateOpts = { ...opts, indexFile: path.join(directory, 'index') };
      await safeGit(['read-tree', base], privateOpts);
      const source = new Map<string, { mode: string; type: string; object: string }>();
      for (const record of (await safeGit(['ls-tree', '-r', '-z', base], opts)).stdout
        .split('\0')
        .filter(Boolean)) {
        const split = record.indexOf('\t');
        const [mode, type, object] = record.slice(0, split).split(' ');
        source.set(record.slice(split + 1), { mode, type, object });
      }
      const untracked = (
        await safeGit(['ls-files', '--others', '--exclude-standard', '-z'], opts)
      ).stdout.split('\0');
      const paths = [...new Set([...source.keys(), ...initial.paths, ...untracked])].filter(
        (file) =>
          file &&
          !['node_modules', '.buro'].some((name) => file === name || file.startsWith(name + '/')) &&
          !(entry.environment && file === '.yarn/install-state.gz'),
      );
      const changes: WorkspaceRevision['changes'] = [];
      for (const file of paths) {
        const old = source.get(file);
        let object: string | undefined;
        let mode: string | undefined;
        try {
          const inspected = await inspectWorkspacePath(workspace, entry.realWorkspace, file);
          if (old?.type === 'commit' && inspected.stat.isDirectory()) {
            // Existing submodules are not an editable source capability of this adapter.
            await safeGit(['diff', '--quiet', '--ignore-submodules=none', base, '--', file], opts);
            continue;
          }
          const copy = path.join(directory, 'content');
          if (inspected.stat.isSymbolicLink()) {
            const target = await fs.readlink(inspected.target);
            await fs.writeFile(copy, target, { mode: 0o600 });
            mode = '120000';
            object = createHash('sha1')
              .update(`blob ${Buffer.byteLength(target)}\0`)
              .update(target)
              .digest('hex');
          } else
            ({ mode, object } = await copyWorkspaceFile(
              workspace,
              entry.realWorkspace,
              file,
              copy,
            ));
          if (object !== old?.object || mode !== old?.mode) {
            const stored = (
              await safeGit(['hash-object', '-w', '--no-filters', '--', copy], opts)
            ).stdout.trim();
            if (stored !== object) throw revisionChanged();
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          if (sparseCheckout && initial.skipped.has(file)) continue;
        }
        if (object === old?.object && mode === old?.mode) continue;
        if (object && mode)
          await safeGit(
            ['update-index', '--add', '--cacheinfo', `${mode},${object},${file}`],
            privateOpts,
          );
        else await safeGit(['update-index', '--force-remove', '--', file], privateOpts);
        const before = old
          ? (
              await safeGit(['show', '--no-ext-diff', '--no-textconv', old.object], {
                ...opts,
                maxBuffer: 2 * 1024 * 1024,
              })
            ).stdout
          : '';
        let after = object
          ? (
              await safeGit(['show', '--no-ext-diff', '--no-textconv', object], {
                ...opts,
                maxBuffer: 1024 * 1024,
              })
            ).stdout
          : '';
        if (mode === '120000') after = '[symlink ' + after + ']';
        changes.push({ path: file, before, after });
      }
      const tree = (await safeGit(['write-tree'], privateOpts)).stdout.trim();
      const final = await state();
      if (initial.head !== final.head || initial.index !== final.index) throw revisionChanged();
      changes.sort((a, b) => a.path.localeCompare(b.path));
      return { version: 1, base, head: initial.head, index: initial.index, tree, changes };
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
  async checkpoint(workspace: string, runId: string, expected?: WorkspaceRevision) {
    const entry = await this.validate(workspace);
    const revision = expected || (await this.captureRevision(workspace, entry.base));
    const opts = { cwd: workspace, gitDirectory: entry.gitDirectory };
    const index = path.join(entry.gitDirectory, 'index');
    const lock = index + '.lock';
    const handle = await fs.open(lock, 'wx', 0o600);
    let ownsLock = true;
    let open = true;
    let intendedCommit: string | undefined;
    let headUpdated = false;
    try {
      if (!sameWorkspaceRevision(revision, await this.captureRevision(workspace, entry.base)))
        throw revisionChanged();
      const baseTree = (
        await safeGit(['rev-parse', `${revision.head}^{tree}`], opts)
      ).stdout.trim();
      if (revision.tree === baseTree) return revision.head;
      const commit = (
        await safeGit(
          ['commit-tree', revision.tree, '-p', revision.head, '-m', `goal: ${runId}`],
          opts,
        )
      ).stdout.trim();
      intendedCommit = commit;
      // Prepare the exact captured index, never stage live paths after verification.
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-checkpoint-'));
      try {
        const privateIndex = path.join(directory, 'index');
        await safeGit(['read-tree', revision.tree], { ...opts, indexFile: privateIndex });
        const indexData = await fs.readFile(privateIndex);
        if (!sameWorkspaceRevision(revision, await this.captureRevision(workspace, entry.base)))
          throw revisionChanged();
        await handle.writeFile(indexData);
        await handle.sync();
        // Never dereference a late-written symbolic HEAD into the user's source branch.
        await safeGit(['update-ref', '--no-deref', 'HEAD', commit, revision.head], opts);
        headUpdated = true;
        await handle.close();
        open = false;
        await fs.rename(lock, index);
        ownsLock = false;
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
      return commit;
    } catch (error) {
      let observed: string | undefined;
      try {
        observed = (await safeGit(['rev-parse', 'HEAD'], opts)).stdout.trim();
      } catch {}
      if (headUpdated || (intendedCommit && observed === intendedCommit))
        throw new DomainError(
          'WORKSPACE_CHECKPOINT_RECONCILIATION_REQUIRED',
          'The verified Git commit was created but finalization did not finish. Reconcile the saved commit before continuing.',
        );
      if (observed && observed !== revision.head) throw revisionChanged();
      throw error;
    } finally {
      if (open) await handle.close();
      if (ownsLock) await fs.rm(lock, { force: true });
    }
  }

  async openVerificationView(
    workspace: string,
    revision: WorkspaceRevision,
    options: OpenVerificationViewOptions,
  ): Promise<VerificationView> {
    options.signal?.throwIfAborted();
    const entry = await this.validate(workspace);
    const project = this.projects.get(options.projectId).snapshot().project;
    if (
      (await fs.realpath(project.root)) !== (await fs.realpath(entry.contextRoot)) ||
      entry.projectId !== options.projectId ||
      entry.runId !== options.runId ||
      !sameWorkspaceRevision(revision, await this.captureRevision(workspace, entry.base))
    )
      throw new DomainError(
        'VERIFICATION_REVISION_CHANGED',
        'The verification view does not match its owning run and captured revision.',
      );
    let dependencyTarget: string | undefined;
    const modules = path.join(workspace, 'node_modules');
    try {
      const stat = await fs.lstat(modules);
      dependencyTarget = await fs.realpath(modules);
      if (
        (!stat.isDirectory() && !stat.isSymbolicLink()) ||
        (stat.isSymbolicLink()
          ? dependencyTarget !== entry.dependencyLink
          : dependencyTarget !== path.join(entry.realWorkspace, 'node_modules'))
      )
        throw new DomainError(
          'VERIFICATION_VIEW_UNAVAILABLE',
          'The dependency root is not an owned or prepared dependency directory.',
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const resource = await materializeVerificationView({
      workspace,
      gitDirectory: entry.gitDirectory,
      contextRoot: entry.contextRoot,
      materials: entry.materials,
      dependencyTarget,
      revision,
      options,
    });
    this.verificationViews.set(resource.view.id, resource);
    return resource.view;
  }

  async releaseVerificationView(view: VerificationView) {
    const resource = this.verificationViews.get(view.id);
    if (!resource) return;
    if (resource.view !== view)
      throw new DomainError(
        'VERIFICATION_VIEW_UNAVAILABLE',
        'Only the owning verification handle can release this input.',
      );
    await resource.dispose();
    this.verificationViews.delete(view.id);
  }
}
