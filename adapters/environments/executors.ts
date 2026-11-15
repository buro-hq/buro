import fs from 'node:fs/promises';
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
};
/** Shared coordinates for service checks and the agent; providers never silently fall back to the host. */
export class EnvironmentExecutors {
  worlds = new Map<string, ExecutionWorld>();
  readonly execute: typeof exec;
  readonly agentConfigHome: string;
  constructor(
    execute: typeof exec = exec,
    agentConfigHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  ) {
    this.execute = execute;
    this.agentConfigHome = agentConfigHome;
  }
  async register(workspace: string, root: string, config: EnvironmentConfig, signal: AbortSignal) {
    signal.throwIfAborted();
    const existing = this.worlds.get(workspace);
    if (existing) {
      if (JSON.stringify(existing.config) !== JSON.stringify(config))
        throw new DomainError('ENVIRONMENT_CHANGED', 'The live execution environment changed.');
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
    options: { agent?: boolean; readOnly?: boolean; variables?: Record<string, string> } = {},
  ): Launch {
    const world = this.worlds.get(workspace);
    if (!world)
      throw new DomainError(
        'ENVIRONMENT_UNAVAILABLE',
        'The workspace environment has not been prepared.',
      );
    const variables = { ...world.variables, ...options.variables };
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
