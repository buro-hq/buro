import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { dependencyFiles } from '../../core/environment-repair.ts';
import { DomainError } from '../../core/ports.ts';
import type { Check, ProjectCommand } from '../../protocol/domain.ts';
import { runProjectCommand } from '../checks/project-commands.ts';
type Runner = typeof runProjectCommand;
/** Own dependency tree and caches; package installation is a service operation, never a model shell command. */
export class NodeEnvironment {
  cache: string;
  private fingerprint?: string;
  readonly workspace: string;
  readonly root: string;
  readonly runner: Runner;
  constructor(workspace: string, root: string, runner: Runner = runProjectCommand) {
    this.workspace = workspace;
    this.root = root;
    this.runner = runner;
    this.cache = path.join(workspace, '.buro', 'environment-cache');
  }
  async prepare(seed: boolean, signal?: AbortSignal) {
    if (signal?.aborted) throw new DOMException('Interrupted', 'AbortError');
    await this.command(); // Validate the package manager before copying dependencies.
    const destination = path.join(this.workspace, 'node_modules');
    if (seed) {
      try {
        // Copy package contents, then restore executable links inside the private dependency tree.
        await fs.cp(path.join(this.root, 'node_modules'), destination, {
          recursive: true,
          dereference: true,
          mode: constants.COPYFILE_FICLONE,
          filter: async (source) => {
            if (signal?.aborted) throw new DOMException('Interrupted', 'AbortError');
            if ((await fs.lstat(source)).isSymbolicLink()) {
              try {
                await fs.stat(source);
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
                throw error;
              }
            }
            return true;
          },
        });
        await this.restoreBinaryLinks();
        this.fingerprint = await this.digest();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await fs.rm(destination, { recursive: true, force: true });
      }
    }
    await fs.mkdir(destination, { recursive: true });
    if (signal?.aborted) throw new DOMException('Interrupted', 'AbortError');
    await this.validate();
    if (this.fingerprint) {
      await this.ensureCache();
      try {
        await fs.cp(path.join(this.root, '.yarn', 'cache'), path.join(this.cache, 'yarn'), {
          recursive: true,
          dereference: true,
          mode: constants.COPYFILE_FICLONE,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await this.save();
    }
  }
  async restoreBinaryLinks() {
    const source = path.join(this.root, 'node_modules'),
      destination = path.join(this.workspace, 'node_modules'),
      binaries = path.join(source, '.bin');
    let files: string[];
    try {
      files = await fs.readdir(binaries);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const name of files) {
      const original = path.join(binaries, name);
      if (!(await fs.lstat(original)).isSymbolicLink()) continue;
      const target = path.resolve(binaries, await fs.readlink(original)),
        relative = path.relative(source, target);
      if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
      const privateTarget = path.join(destination, relative),
        link = path.join(destination, '.bin', name);
      try {
        await fs.access(privateTarget);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      await fs.rm(link, { force: true });
      await fs.symlink(path.relative(path.dirname(link), privateTarget), link);
    }
  }
  async restore() {
    await this.validate();
    try {
      const state = JSON.parse(
        await fs.readFile(path.join(this.cache, 'dependencies.json'), 'utf8'),
      );
      if (state.version === 1 && /^[a-f0-9]{64}$/.test(state.fingerprint))
        this.fingerprint = state.fingerprint;
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw error;
    }
  }
  async ensureCache() {
    for (const directory of [path.dirname(this.cache), this.cache]) {
      try {
        const stat = await fs.lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw new DomainError('UNSAFE_CACHE', 'The environment cache must not be a symlink.');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await fs.mkdir(directory);
      }
    }
  }
  async save() {
    await this.ensureCache();
    const destination = path.join(this.cache, 'dependencies.json'),
      temporary = destination + '.tmp';
    await fs.writeFile(temporary, JSON.stringify({ version: 1, fingerprint: this.fingerprint }));
    await fs.rename(temporary, destination);
  }
  async validate() {
    const dependencies = path.join(this.workspace, 'node_modules');
    if (
      (await fs.lstat(dependencies)).isSymbolicLink() ||
      (await fs.realpath(dependencies)) !== dependencies
    )
      throw new DomainError(
        'DEPENDENCIES_CHANGED',
        'Environment repair requires a separate node_modules directory inside the workspace.',
      );
  }
  async digest() {
    const hash = createHash('sha256');
    for (const file of dependencyFiles) {
      hash.update(file);
      try {
        hash.update(await fs.readFile(path.join(this.workspace, file)));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
    return hash.digest('hex');
  }
  async command(): Promise<ProjectCommand> {
    const manifest = JSON.parse(
      await fs.readFile(path.join(this.workspace, 'package.json'), 'utf8'),
    );
    const declared = manifest.packageManager?.split('@')[0];
    if (declared && !['npm', 'yarn', 'pnpm'].includes(declared))
      throw new DomainError(
        'PACKAGE_MANAGER_UNSUPPORTED',
        'Environment repair supports npm, Yarn and pnpm.',
      );
    const exists = async (name: string) => {
      try {
        await fs.access(path.join(this.workspace, name));
        return true;
      } catch {
        return false;
      }
    };
    const manager =
      declared ||
      ((await exists('yarn.lock')) ? 'yarn' : (await exists('pnpm-lock.yaml')) ? 'pnpm' : 'npm');
    let command = 'npm install --ignore-scripts --no-audit --no-fund';
    if (manager === 'pnpm')
      command =
        'pnpm install --ignore-scripts --no-frozen-lockfile --store-dir "$GOAL_WORKSPACE/.buro/environment-cache/pnpm"';
    if (manager === 'yarn') {
      const modern =
        Number(manifest.packageManager?.split('@')[1]?.split('.')[0]) >= 2 ||
        (await exists('.yarnrc.yml')) ||
        ((await exists('yarn.lock')) &&
          (await fs.readFile(path.join(this.workspace, 'yarn.lock'), 'utf8')).includes(
            '__metadata:',
          ));
      command = modern
        ? 'yarn install --mode=skip-build'
        : 'yarn install --ignore-scripts --non-interactive --cache-folder "$GOAL_WORKSPACE/.buro/environment-cache/yarn"';
    }
    return { id: 'dependencies', title: 'Installing dependencies', command, timeoutMs: 180000 };
  }
  async synchronize(signal: AbortSignal): Promise<Check | undefined> {
    await this.validate();
    if (this.fingerprint === (await this.digest())) return;
    await this.ensureCache();
    const command = await this.command();
    const result = await this.runner(command, this.workspace, this.root, signal, {
      HOME: this.cache,
      COREPACK_HOME: path.join(this.cache, 'corepack'),
      XDG_CACHE_HOME: this.cache,
      npm_config_cache: path.join(this.cache, 'npm'),
      npm_config_userconfig: '/dev/null',
      npm_config_ignore_scripts: 'true',
      YARN_ENABLE_GLOBAL_CACHE: 'false',
      YARN_CACHE_FOLDER: path.join(this.cache, 'yarn'),
      YARN_ENABLE_SCRIPTS: 'false',
      YARN_ENABLE_IMMUTABLE_INSTALLS: 'false',
      YARN_NODE_LINKER: 'node-modules',
    });
    if (result.exitCode === 0) {
      this.fingerprint = await this.digest();
      await this.save();
    }
    return {
      name: command.title,
      command: command.command,
      passed: result.exitCode === 0,
      ...result,
      ...(result.exitCode !== 0
        ? { error: result.output.slice(-3000) || 'Could not install dependencies.' }
        : {}),
    };
  }
}
