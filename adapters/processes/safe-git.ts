import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
type Options = {
  cwd: string;
  maxBuffer?: number;
  timeout?: number;
  signal?: AbortSignal;
  gitDirectory?: string;
  literalPathspecs?: boolean;
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
  return exec('git', [...global, ...args], config);
}
