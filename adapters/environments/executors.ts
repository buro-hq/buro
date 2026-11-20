import fs from 'node:fs/promises';
import { existsSync, realpathSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { EnvironmentConfig } from '../../protocol/environment.ts';
import { DomainError } from '../../core/ports.ts';
const exec = promisify(execFile);
export type Launch = {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  terminate?: () => Promise<void>;
};
export type ExecutionWorld = {
  workspace: string;
  root: string;
  config: EnvironmentConfig;
  cacheRoot: string;
  variables: Record<string, string>;
  baseVariables: Record<string, string>;
  container?: string;
  privateDataIsolation?: boolean;
};
/** Shared coordinates for service checks and the agent; providers never silently fall back to the host. */
export class EnvironmentExecutors {
  worlds = new Map<string, ExecutionWorld>();
  readonly execute: typeof exec;
  readonly agentConfigHome: string;
  private privatePaths = new Set<string>();
  constructor(
    execute: typeof exec = exec,
    agentConfigHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  ) {
    this.execute = execute;
    this.agentConfigHome = agentConfigHome;
  }
  protectPrivatePaths(paths: string[]) {
    for (const value of paths) {
      this.privatePaths.add(path.resolve(value));
      if (existsSync(value)) this.privatePaths.add(realpathSync(value));
    }
  }
  async register(
    workspace: string,
    root: string,
    config: EnvironmentConfig,
    signal: AbortSignal,
    options: { privateDataIsolation?: boolean } = {},
  ) {
    signal.throwIfAborted();
    if (options.privateDataIsolation && config.provider === 'docker')
      throw new DomainError(
        'ENVIRONMENT_UNAVAILABLE',
        'Managed tools need private-data isolation. This Docker environment does not provide it.',
      );
    const existing = this.worlds.get(workspace);
    if (existing) {
      if (JSON.stringify(existing.config) !== JSON.stringify(config))
        throw new DomainError('ENVIRONMENT_CHANGED', 'The live execution environment changed.');
      // Reusing a prepared native workspace may tighten read isolation, never loosen it.
      existing.privateDataIsolation ||= !!options.privateDataIsolation;
      return existing;
    }
    const home = path.join(workspace, '.buro', 'environment', 'home');
    await fs.mkdir(home, { recursive: true });
    if ((await fs.realpath(home)) !== home)
      throw new DomainError(
        'UNSAFE_ENVIRONMENT',
        'Environment directories must not contain symlinks.',
      );
    const cacheKey = createHash('sha256')
      .update(JSON.stringify([config.provider, config.image, process.platform, process.arch]))
      .digest('hex')
      .slice(0, 20);
    const cacheRoot = path.join(root, '.buro', 'local', 'environment-cache', cacheKey);
    await fs.mkdir(cacheRoot, { recursive: true });
    if ((await fs.realpath(cacheRoot)) !== cacheRoot)
      throw new DomainError(
        'UNSAFE_ENVIRONMENT',
        'Shared artifact caches must not contain symlinks.',
      );
    const basePath =
      config.provider === 'docker'
        ? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
        : process.env.PATH || '/usr/bin:/bin';
    const variables = {
      CI: '1',
      PROJECT_ROOT: root,
      GOAL_WORKSPACE: workspace,
      PATH: [
        path.join(home, '.local/bin'),
        path.join(home, '.cargo/bin'),
        path.join(home, 'go/bin'),
        basePath,
      ].join(':'),
      HOME: home,
      XDG_CACHE_HOME: cacheRoot,
      npm_config_cache: path.join(cacheRoot, 'npm'),
      COREPACK_HOME: path.join(cacheRoot, 'corepack'),
      YARN_CACHE_FOLDER: path.join(cacheRoot, 'yarn'),
      PIP_CACHE_DIR: path.join(cacheRoot, 'pip'),
      UV_CACHE_DIR: path.join(cacheRoot, 'uv'),
      CARGO_HOME: path.join(home, '.cargo'),
      GOPATH: path.join(home, 'go'),
      GOCACHE: path.join(cacheRoot, 'go-build'),
      TMPDIR: path.join(home, 'tmp'),
    };
    await fs.mkdir(variables.TMPDIR, { recursive: true });
    const world: ExecutionWorld = {
      workspace,
      root,
      config,
      cacheRoot,
      variables,
      baseVariables: { ...variables },
      privateDataIsolation: !!options.privateDataIsolation,
    };
    if (config.provider === 'docker') {
      const container = 'buro-' + createHash('sha256').update(workspace).digest('hex').slice(0, 24);
      const agentHome = path.join(root, '.buro', 'local', 'agent-state', container);
      await fs.mkdir(agentHome, { recursive: true, mode: 0o700 });
      if ((await fs.realpath(agentHome)) !== agentHome)
        throw new DomainError('UNSAFE_ENVIRONMENT', 'Agent state must not contain symlinks.');
      for (const file of ['auth.json', 'config.toml']) {
        try {
          await fs.copyFile(path.join(this.agentConfigHome, file), path.join(agentHome, file));
          await fs.chmod(path.join(agentHome, file), 0o600);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      const inspected = await this.execute('docker', ['inspect', container], {
        signal,
        timeout: 15000,
      }).catch(() => undefined);
      if (inspected) {
        const saved = JSON.parse(inspected.stdout)[0];
        const mounts = saved.Mounts || [];
        const expected = [
          [root, root, false],
          [workspace, workspace, true],
          [agentHome, '/buro-agent', true],
          [cacheRoot, cacheRoot, true],
        ];
        if (
          saved.Config?.Image !== config.image ||
          saved.Config?.Labels?.['buro.workspace'] !== workspace ||
          mounts.length !== expected.length ||
          !expected.every(([source, target, writable]) =>
            mounts.some(
              (m: any) => m.Source === source && m.Destination === target && m.RW === writable,
            ),
          )
        )
          throw new DomainError(
            'ENVIRONMENT_CHANGED',
            'The retained container does not match this workspace and image.',
          );
        await this.execute('docker', ['start', container], { signal, timeout: 30000 });
      } else {
        await this.execute(
          'docker',
          [
            'run',
            '-d',
            '--name',
            container,
            '--label',
            'buro.workspace=' + workspace,
            '--mount',
            bindMount(root, root, true),
            '--mount',
            bindMount(workspace, workspace),
            '--mount',
            bindMount(agentHome, '/buro-agent'),
            '--mount',
            bindMount(cacheRoot, cacheRoot),
            '--workdir',
            workspace,
            '--entrypoint',
            '/bin/sh',
            config.image!,
            '-c',
            'while :; do sleep 3600; done',
          ],
          { signal, timeout: 180000 },
        );
      }
      world.container = container;
    } else if (process.platform !== 'darwin' && process.platform !== 'linux') {
      throw new DomainError(
        'ENVIRONMENT_UNAVAILABLE',
        'This host needs a Docker environment or a native confinement provider.',
      );
    }
    this.worlds.set(workspace, world);
    return world;
  }
  get(workspace: string) {
    return this.worlds.get(workspace);
  }
  launch(
    workspace: string,
    argv: string[],
    options: {
      agent?: boolean;
      readOnly?: boolean;
      variables?: Record<string, string>;
      privateDataIsolation?: boolean;
      allowNetwork?: boolean;
    } = {},
  ): Launch {
    const world = this.worlds.get(workspace);
    if (!world)
      throw new DomainError(
        'ENVIRONMENT_UNAVAILABLE',
        'The workspace environment has not been prepared.',
      );
    const variables = { ...world.variables, ...options.variables };
    const privateDataIsolation = options.privateDataIsolation || world.privateDataIsolation;
    if (!options.agent && privateDataIsolation) {
      if (world.container || world.config.provider === 'docker')
        throw new DomainError(
          'ENVIRONMENT_UNAVAILABLE',
          'This Docker environment does not provide managed private-data isolation.',
        );
      return this.isolatedLaunch(
        world,
        argv,
        variables,
        !!options.readOnly,
        !!options.allowNetwork,
      );
    }
    if (world.container) {
      const args = ['exec', '-i', '--workdir', workspace];
      for (const [key, value] of Object.entries(variables)) args.push('--env', `${key}=${value}`);
      if (options.agent) {
        args.push('--env', 'CODEX_HOME=/buro-agent');
        for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL'])
          if (process.env[key]) args.push('--env', key);
      }
      args.push(world.container, ...argv);
      return {
        executable: 'docker',
        args,
        cwd: workspace,
        env: process.env,
        ...(!options.agent
          ? {
              terminate: async () => {
                await this.execute('docker', ['stop', '--time', '1', world.container!], {
                  timeout: 15000,
                });
              },
            }
          : {}),
      };
    }
    // Codex app-server is a trusted controller; it confines its own tools using the same roots and variables.
    if (options.agent)
      return { executable: argv[0], args: argv.slice(1), cwd: workspace, env: process.env };
    const env = {
      PATH: process.env.PATH,
      CI: '1',
      PROJECT_ROOT: world.root,
      GOAL_WORKSPACE: workspace,
      ...variables,
    };
    if (process.platform === 'darwin') {
      const literal = (value: string) => JSON.stringify(value);
      const profile =
        '(version 1)(allow default)(deny file-write*)' +
        [workspace, world.cacheRoot]
          .map((p) => `(allow file-write* (subpath ${literal(p)}))`)
          .join('') +
        '(allow file-write* (literal "/dev/null") (literal "/dev/tty"))';
      return {
        executable: '/usr/bin/sandbox-exec',
        args: ['-p', profile, ...argv],
        cwd: workspace,
        env,
      };
    }
    return {
      executable: 'bwrap',
      args: [
        '--die-with-parent',
        '--ro-bind',
        '/',
        '/',
        '--bind',
        workspace,
        workspace,
        '--bind',
        world.cacheRoot,
        world.cacheRoot,
        '--proc',
        '/proc',
        '--dev',
        '/dev',
        '--chdir',
        workspace,
        '--',
        ...argv,
      ],
      cwd: workspace,
      env,
    };
  }
  /** Inspection works before setup and cannot write even inside the repository. */
  launchReadOnly(workspace: string, argv: string[]): Launch {
    const world = this.worlds.get(workspace) || {
      workspace,
      root: workspace,
      config: { provider: 'native' as const },
      cacheRoot: path.join(workspace, '.buro/environment/readonly-cache'),
      variables: {},
      baseVariables: {},
    };
    return this.isolatedLaunch(world, argv, world.variables, true, false);
  }
  private isolatedLaunch(
    world: ExecutionWorld,
    argv: string[],
    variables: Record<string, string>,
    readOnly: boolean,
    allowNetwork: boolean,
  ): Launch {
    const home = os.homedir();
    const protectedPaths = new Set([
      path.join(world.root, '.buro/local'),
      this.agentConfigHome,
      ...this.privatePaths,
      '/etc/npmrc',
      '/usr/local/etc/npmrc',
      '/opt/homebrew/etc/npmrc',
      path.join(path.dirname(path.dirname(process.execPath)), 'etc/npmrc'),
      ...[
        '.codex',
        '.aws',
        '.ssh',
        '.config',
        '.netrc',
        '.npmrc',
        '.git-credentials',
        'Library/Keychains',
      ].map((part) => path.join(home, part)),
    ]);
    const reads = new Set([
      '/System/Library',
      '/System/Applications',
      '/System/Volumes/Preboot',
      '/usr',
      '/bin',
      '/sbin',
      '/lib',
      '/lib64',
      '/etc',
      '/private/etc',
      '/Library/Developer',
      '/Library/Apple',
      '/opt',
      '/nix/store',
      '/dev',
      world.root,
      world.workspace,
      world.cacheRoot,
      path.dirname(process.execPath),
    ]);
    for (const value of (process.env.PATH || '').split(path.delimiter)) {
      if (!value || !path.isAbsolute(value) || !existsSync(value)) continue;
      const directory = realpathSync(value);
      if (directory === home || home.startsWith(directory + path.sep)) continue;
      reads.add(directory);
      if (
        /\/(?:\.nvm\/versions\/node|\.asdf\/installs|\.pyenv\/versions|\.volta\/tools\/image|\.local\/share\/mise\/installs)\//.test(
          directory,
        )
      )
        reads.add(path.dirname(directory));
    }
    const writable = readOnly ? [] : [world.workspace, world.cacheRoot];
    const env = {
      PATH: process.env.PATH,
      CI: '1',
      PROJECT_ROOT: world.root,
      GOAL_WORKSPACE: world.workspace,
      ...variables,
    };
    if (process.platform === 'darwin') {
      const literal = (value: string) => JSON.stringify(value);
      const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const repositorySecrets = [...new Set([world.root, world.workspace])]
        .map(
          (root) =>
            `(deny file-read-data (regex #${literal('^' + escape(root) + '/(.*/)?([.]env([.].*)?|.*[.](pem|key|p12|pfx|keystore))$')}))` +
            `(deny file-read-data (regex #${literal('^' + escape(root) + '/(.*/)?[.](aws|ssh|codex|claude)(/.*)?$')}))` +
            `(deny file-read-data (regex #${literal('^' + escape(root) + '/(.*/)?[.]buro/local(/.*)?$')}))`,
        )
        .join('');
      const rules =
        '(version 1)(allow default)(deny file-write*)(deny file-read-data)(allow file-read-data (literal "/"))' +
        [...reads]
          .filter(existsSync)
          .map((value) => `(allow file-read-data (subpath ${literal(value)}))`)
          .join('') +
        [...protectedPaths]
          .map((value) => `(deny file-read-data (subpath ${literal(value)}))`)
          .join('') +
        repositorySecrets +
        '(deny file-read-data (regex #"^(.*/)?[.](npmrc|netrc|git-credentials)$"))' +
        // Artifact caches are the one explicit exception under private project metadata.
        `(allow file-read-data (subpath ${literal(world.cacheRoot)}))` +
        writable.map((value) => `(allow file-write* (subpath ${literal(value)}))`).join('') +
        '(allow file-write* (literal "/dev/null"))' +
        (!allowNetwork ? '(deny network*)' : '');
      return {
        executable: '/usr/bin/sandbox-exec',
        args: ['-p', rules, ...argv],
        cwd: world.workspace,
        env,
      };
    }
    if (process.platform !== 'linux')
      throw new DomainError(
        'ENVIRONMENT_UNAVAILABLE',
        'This host cannot provide managed read/write isolation.',
      );
    const args = ['--die-with-parent', ...(!allowNetwork ? ['--unshare-net'] : [])];
    // Start from an empty namespace rather than exposing the host home and temporary files.
    for (const value of [...reads].filter((value) => value !== '/dev' && existsSync(value)))
      args.push('--ro-bind', value, value);
    args.push('--proc', '/proc', '--dev', '/dev');
    for (const value of writable) args.push('--bind', value, value);
    const excluded = new Set(protectedPaths);
    let visited = 0;
    const inspect = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (++visited > 10000)
          throw new DomainError(
            'ENVIRONMENT_UNAVAILABLE',
            'The repository exceeds bounded private-file isolation.',
          );
        const filename = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (
          entry.name.startsWith('.env') ||
          /\.(pem|key|p12|pfx|keystore)$/i.test(entry.name) ||
          ['.aws', '.ssh', '.codex', '.claude'].includes(entry.name)
        )
          excluded.add(filename);
        else if (entry.isDirectory() && entry.name === '.buro') {
          if (existsSync(path.join(filename, 'local'))) excluded.add(path.join(filename, 'local'));
        } else if (
          entry.isDirectory() &&
          ![
            '.git',
            'node_modules',
            'dist',
            'build',
            'target',
            'vendor',
            '.gradle',
            'coverage',
          ].includes(entry.name)
        )
          inspect(filename);
      }
    };
    for (const root of new Set([world.root, world.workspace])) inspect(root);
    for (const value of excluded)
      if (existsSync(value) && value !== world.cacheRoot)
        args.push(
          ...(statSync(value).isDirectory()
            ? ['--tmpfs', value]
            : ['--ro-bind', '/dev/null', value]),
        );
    // Re-expose only this run's artifact cache beneath the masked metadata root.
    if (existsSync(world.cacheRoot))
      args.push(readOnly ? '--ro-bind' : '--bind', world.cacheRoot, world.cacheRoot);
    args.push('--chdir', world.workspace, '--', ...argv);
    return { executable: 'bwrap', args, cwd: world.workspace, env };
  }
  async release(workspace: string) {
    const world = this.worlds.get(workspace);
    try {
      if (world?.container)
        await this.execute('docker', ['stop', '--time', '1', world.container], { timeout: 15000 });
    } finally {
      this.worlds.delete(workspace);
    }
    // Stopped containers retain their filesystem for a later resume.
  }
}

function bindMount(source: string, destination: string, readOnly = false) {
  return ['type=bind', `src=${source}`, `dst=${destination}`, ...(readOnly ? ['readonly'] : [])]
    .map((value) => (/[,"\n\r]/.test(value) ? '"' + value.replaceAll('"', '""') + '"' : value))
    .join(',');
}
