import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { promisify } from 'node:util';

const exec = promisify(execFile);
type Options = {
  cwd: string;
  maxBuffer?: number;
  timeout?: number;
  signal?: AbortSignal;
  gitDirectory?: string;
  literalPathspecs?: boolean;
  /** Host-owned temporary index; never taken from a model or repository configuration. */
  indexFile?: string;
  /** Host-private raw output, e.g. binary object data. Never a model-supplied path. */
  stdoutFile?: string;
};

/** Local repository bookkeeping must never activate executable repository configuration. */
export async function safeGit(args: string[], options: Options) {
  const identity = /^GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL|DATE)$/;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_') || identity.test(name)),
  );
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    ...(options.indexFile ? { GIT_INDEX_FILE: options.indexFile } : {}),
  });
  const global = [
    '--no-optional-locks',
    '--no-pager',
    ...(options.literalPathspecs === false ? [] : ['--literal-pathspecs']),
    ...(options.gitDirectory
      ? ['--git-dir=' + options.gitDirectory, '--work-tree=' + options.cwd]
      : []),
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.untrackedCache=false',
    '-c',
    'core.attributesFile=/dev/null',
    '-c',
    'diff.external=',
    '-c',
    'commit.gpgsign=false',
    '-c',
    'tag.gpgsign=false',
    '-c',
    'gc.auto=0',
    '-c',
    'maintenance.auto=false',
    '-c',
    'submodule.recurse=false',
    '-c',
    'fetch.recurseSubmodules=false',
    '-c',
    'protocol.allow=never',
  ];
  const {
    gitDirectory: _gitDirectory,
    literalPathspecs: _literalPathspecs,
    indexFile: _indexFile,
    stdoutFile: _stdoutFile,
    ...execution
  } = options;
  const config = {
    ...execution,
    env,
    encoding: 'utf8' as const,
    maxBuffer: options.maxBuffer || 32 * 1024 * 1024,
  };
  let keys = '';
  try {
    keys = (
      await exec(
        'git',
        [
          ...global,
          'config',
          '--includes',
          '--null',
          '--name-only',
          '--get-regexp',
          '^(filter\\..*\\.(clean|process|smudge|required)|diff\\..*\\.(command|textconv|cachetextconv))$',
        ],
        config,
      )
    ).stdout;
  } catch (error) {
    // git config returns 1 when no matching keys exist; every other failure is unsafe.
    if ((error as { code?: unknown }).code !== 1) throw error;
  }
  for (const key of keys.split('\0').filter(Boolean)) {
    if (
      /[\0\r\n=]/.test(key) ||
      !/^(filter\..+\.(clean|process|smudge|required)|diff\..+\.(command|textconv|cachetextconv))$/.test(
        key,
      )
    )
      throw Error('Unsafe executable Git configuration.');
    global.push('-c', key + (/\.(required|cachetextconv)$/.test(key) ? '=false' : '='));
  }
  if (!options.stdoutFile) return exec('git', [...global, ...args], config);
  const destination = await fs.open(
    options.stdoutFile,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn('git', [...global, ...args], {
        cwd: options.cwd,
        env,
        signal: options.signal,
        timeout: options.timeout,
        stdio: ['ignore', destination.fd, 'pipe'],
      });
      let stderr = '';
      let failure: Error | undefined;
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-32768);
      });
      child.once('error', (error) => {
        failure = error;
      });
      child.once('close', (code, signal) => {
        if (failure) reject(failure);
        else if (code === 0) resolve({ stdout: '', stderr });
        else
          reject(
            Object.assign(new Error('Git object operation failed: ' + stderr), { code, signal }),
          );
      });
    });
  } finally {
    await destination.close();
  }
}
