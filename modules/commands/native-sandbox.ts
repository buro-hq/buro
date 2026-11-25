import fs from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import type { CommandInput } from './command.ts';
import type { CommandLaunch, CommandSandbox } from './sandbox.ts';

/** OS filesystem isolation, independent of checks, roles, manifests and acceptance. */
export class NativeSandbox implements CommandSandbox {
  private privatePaths: string[];
  private readPaths: string[];
  private directory = path.join(os.tmpdir(), 'buro-environments-' + randomUUID());
  private environments = new Map<string, Promise<{ home: string; cache: string }>>();

  /** Adds explicit application-private paths and optional toolchain read roots. */
  constructor(input: { privatePaths?: string[]; readPaths?: string[] } = {}) {
    this.privatePaths = (input.privatePaths ?? []).map((value) => path.resolve(value));
    this.readPaths = (input.readPaths ?? []).map((value) => path.resolve(value));
  }

  /** Builds an OS sandbox; unsupported hosts never fall back to unconstrained execution. */
  async prepare(input: CommandInput): Promise<CommandLaunch> {
    input.signal.throwIfAborted();
    const workspace = await fs.realpath(input.workspace);
    const source = input.source ? await fs.realpath(input.source) : workspace;
    let environment = this.environments.get(workspace);
    if (!environment) {
      environment = this.createEnvironment(workspace);
      this.environments.set(workspace, environment);
    }

    const { home, cache } = await environment;
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      CI: '1',
      HOME: home,
      TMPDIR: path.join(home, 'tmp'),
      XDG_CACHE_HOME: cache,
      npm_config_cache: path.join(cache, 'npm'),
      COREPACK_HOME: path.join(cache, 'corepack'),
      YARN_CACHE_FOLDER: path.join(cache, 'yarn'),
      UV_CACHE_DIR: path.join(cache, 'uv'),
      PIP_CACHE_DIR: path.join(cache, 'pip'),
      WORKSPACE: workspace,
      PROJECT_ROOT: source,
      ...input.env,
    };
    const userHome = os.homedir();
    const reads = new Set(
      [
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
        path.dirname(process.execPath),
        source,
        workspace,
        home,
        cache,
        ...this.readPaths,
      ].filter(existsSync),
    );
    for (const value of (process.env.PATH ?? '').split(path.delimiter)) {
      if (!path.isAbsolute(value) || !existsSync(value))
        continue;

      const directory = realpathSync(value);
      if (directory === userHome || userHome.startsWith(directory + path.sep))
        continue;

      reads.add(directory);
      if (
        /\/(?:\.nvm\/versions\/node|\.asdf\/installs|\.pyenv\/versions|\.volta\/tools\/image|\.local\/share\/mise\/installs)\//.test(
          directory,
        )
      )
        reads.add(path.dirname(directory));
    }
    const protectedPaths = new Set([
      ...this.privatePaths,
      ...[
        '.codex',
        '.aws',
        '.ssh',
        '.config',
        '.netrc',
        '.npmrc',
        '.git-credentials',
        'Library/Keychains',
      ].map((value) => path.join(userHome, value)),
    ]);
    const writable = input.readOnly ? [] : [workspace, home, cache];
    if (process.platform === 'darwin') {
      const literal = JSON.stringify;
      const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const secrets = [...new Set([source, workspace])]
        .map(
          (root) =>
            `(deny file-read-data (regex #${literal('^' + escape(root) + '/(.*/)?([.]env([.].*)?|[.]npmrc|[.]netrc|[.]git-credentials|id_rsa|id_ed25519|.*[.](pem|key|p12|pfx|keystore))$')}))` +
            `(deny file-read-data (regex #${literal('^' + escape(root) + '/(.*/)?[.](aws|ssh|codex|claude)(/.*)?$')}))`,
        )
        .join('');
      const profile =
        '(version 1)(allow default)(deny file-write*)(deny file-read-data)(allow file-read-data (literal "/"))' +
        [...reads].map((value) => `(allow file-read-data (subpath ${literal(value)}))`).join('') +
        writable.map((value) => `(allow file-write* (subpath ${literal(value)}))`).join('') +
        `(deny file-write* (subpath ${literal(path.join(workspace, '.git'))}))` +
        [...protectedPaths]
          .map(
            (value) =>
              `(deny file-read-data (subpath ${literal(value)}))(deny file-write* (subpath ${literal(value)}))`,
          )
          .join('') +
          secrets +
          [home, cache]
            .map((value) => `(deny file-write-unlink (literal ${literal(value)}))`)
            .join('') +
            '(allow file-write* (literal "/dev/null"))(deny file-link)(deny file-mount)(deny file-unmount)' +
            '(deny process-info*)(allow process-info* (target self))(allow process-info* (target children))(allow process-info* (target same-sandbox))' +
            '(deny signal)(allow signal (target self))(allow signal (target children))(allow signal (target same-sandbox))(deny appleevent-send)' +
            (input.allowNetwork ? '' : '(deny network*)');
      return {
        executable: '/usr/bin/sandbox-exec',
        args: ['-p', profile, ...input.argv],
        cwd: workspace,
        env,
      };
    }

    if (process.platform !== 'linux')
      throw new Error('This host does not provide a supported command sandbox.');

    const args = [
      '--die-with-parent',
      '--unshare-pid',
      ...(!input.allowNetwork ? ['--unshare-net'] : []),
    ];
    for (const value of reads)
      if (value !== '/dev')
        args.push('--ro-bind', value, value);
    args.push('--proc', '/proc', '--dev', '/dev');
    for (const value of writable)
      args.push('--bind', value, value);
    const gitMetadata = path.join(workspace, '.git');
    if (existsSync(gitMetadata))
      args.push('--ro-bind', gitMetadata, gitMetadata);

    const inspect = async (directory: string): Promise<void> => {
      input.signal.throwIfAborted();
      for (const entry of await fs.readdir(directory, {
        withFileTypes: true,
      })) {
        const filename = path.join(directory, entry.name);
        if (entry.isSymbolicLink())
          continue;

        if (
          /^\.env(?:\.|$)/i.test(entry.name) ||
          /\.(pem|key|p12|pfx|keystore)$/i.test(entry.name) ||
          [
            '.npmrc',
            '.netrc',
            '.git-credentials',
            'id_rsa',
            'id_ed25519',
            '.aws',
            '.ssh',
            '.codex',
            '.claude',
          ].includes(entry.name)
        )
          protectedPaths.add(filename);
        else if (
          entry.isDirectory() &&
          !['.git', 'node_modules', 'dist', 'build', 'target', 'vendor', '.buro'].includes(
            entry.name,
          )
        )
          await inspect(filename);
      }
    };
    for (const root of new Set([source, workspace]))
      await inspect(root);
    for (const value of protectedPaths)
      if (existsSync(value))
        args.push(
          ...((await fs.stat(value)).isDirectory()
            ? ['--tmpfs', value]
            : ['--ro-bind', '/dev/null', value]),
        );
    args.push('--chdir', workspace, '--', ...input.argv);
    return { executable: 'bwrap', args, cwd: workspace, env };
  }

  /** Removes only this sandbox instance's temporary environments. */
  async close(): Promise<void> {
    await Promise.allSettled([...this.environments.values()]);
    await fs.rm(this.directory, {
      recursive: true,
      force: true,
    });
  }

  private async createEnvironment(workspace: string): Promise<{ home: string; cache: string }> {
    const directory = path.join(
      this.directory,
      createHash('sha256').update(workspace).digest('hex'),
    );
    await fs.mkdir(path.join(directory, 'home', 'tmp'), {
      recursive: true,
      mode: 0o700,
    });
    await fs.mkdir(path.join(directory, 'cache'), {
      recursive: true,
      mode: 0o700,
    });
    const canonical = await fs.realpath(directory);
    return { home: path.join(canonical, 'home'), cache: path.join(canonical, 'cache') };
  }
}
