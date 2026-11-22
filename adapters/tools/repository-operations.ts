import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { DomainError } from '../../core/ports.ts';
import { writeAllowed } from '../../core/execution-ports.ts';
import { dependencyManifestPreserved } from '../../core/environment-repair.ts';
import type { ToolEffect, ToolResult, ToolScope } from '../../core/model-ports.ts';
import type { RepositoryToolOperations } from '../../core/tool-contributions.ts';
import { repositoryToolSchemas as schemas } from './repository-tool-schemas.ts';
import type { EnvironmentExecutors } from '../environments/executors.ts';
import { runProjectCommand } from '../checks/project-commands.ts';
const exec = promisify(execFile);
const hidden = new Set([
  '.git',
  '.buro',
  '.codex',
  '.claude',
  '.aws',
  '.ssh',
  '.npm',
  '.cache',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.venv',
  'vendor',
  'target',
]);
function blocked(relative: string, scope: ToolScope) {
  if (scope.materials.includes(relative)) return false;
  return relative
    .split('/')
    .some(
      (part) =>
        hidden.has(part) ||
        (part.startsWith('.env') && part !== '.env.example') ||
        ['.npmrc', '.netrc', 'id_rsa', 'id_ed25519'].includes(part) ||
        /\.(pem|key|p12|pfx|keystore)$/i.test(part),
    );
}

/** Effect-checked workspace operations; handlers receive a facade, never this adapter or its scope. */
export class BoundedRepositoryOperations implements RepositoryToolOperations {
  #executors: EnvironmentExecutors;
  #scope: ToolScope;
  #options: { actionId: string; signal: AbortSignal; onCommandStart?: (command: string) => void };
  #authorize: (effect: ToolEffect) => void;
  #onEffectStart: () => void;
  constructor(
    executors: EnvironmentExecutors,
    scope: ToolScope,
    options: { actionId: string; signal: AbortSignal; onCommandStart?: (command: string) => void },
    authorize: (effect: ToolEffect) => void,
    onEffectStart: () => void,
  ) {
    this.#executors = executors;
    this.#scope = scope;
    this.#options = options;
    this.#authorize = authorize;
    this.#onEffectStart = onEffectStart;
  }
  private check(effect: ToolEffect) {
    this.#options.signal.throwIfAborted();
    this.#authorize(effect);
  }
  private input<T>(schema: { parse(value: unknown): T }, value: unknown): T {
    try {
      return schema.parse(structuredClone(value));
    } catch {
      throw new DomainError('TOOL_ARGUMENTS', 'Invalid repository operation arguments.');
    }
  }
  private relative(scope: ToolScope, file: string) {
    if (file.includes('\0') || file.includes('\\') || file.split('/').includes('..'))
      throw new DomainError('TOOL_SCOPE', 'Invalid repository path.');
    const root = path.resolve(scope.workspace);
    const relative = path.relative(root, path.resolve(root, file)).split(path.sep).join('/');
    if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative))
      throw new DomainError('TOOL_SCOPE', 'The path escapes the workspace.');
    if (blocked(relative, scope))
      throw new DomainError('TOOL_SCOPE', 'This path contains private or excluded files.');
    return relative;
  }

  private async filename(scope: ToolScope, relative: string, allowMissing = false) {
    const root = path.resolve(scope.workspace);
    if ((await fs.realpath(root)) !== root)
      throw new DomainError('TOOL_SCOPE', 'Workspace paths cannot contain symlinks.');
    let current = root;
    for (const part of relative.split('/').filter(Boolean)) {
      current = path.join(current, part);
      try {
        if ((await fs.lstat(current)).isSymbolicLink())
          throw new DomainError('TOOL_SCOPE', 'Tools do not follow symlinks.');
      } catch (error) {
        if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
    }
    return path.join(root, relative);
  }

  private async read(scope: ToolScope, relative: string) {
    const filename = await this.filename(scope, relative);
    const stat = await fs.stat(filename);
    if (!stat.isFile() || stat.size > 256000)
      throw new DomainError('TOOL_LIMIT', 'Read a smaller text file (at most 256 KB).');
    const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    let text: string;
    try {
      text = await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
    if (text.includes('\0'))
      throw new DomainError('TOOL_LIMIT', 'This tool reads text files only.');
    return text;
  }

  private async git(scope: ToolScope, args: string[], signal: AbortSignal) {
    await this.filename(scope, '');
    const launch = this.#executors.launchReadOnly(scope.workspace, ['git', ...args]);
    return exec(launch.executable, launch.args, {
      cwd: launch.cwd,
      signal,
      timeout: 15000,
      maxBuffer: 1024 * 1024,
      // Do not inherit recipe-proposed loader, Git config, or credential variables.
      env: {
        PATH: process.env.PATH,
        CI: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_COUNT: '0',
        GIT_NO_LAZY_FETCH: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
    });
  }

  private async files(scope: ToolScope, relative: string, signal: AbortSignal) {
    const result: string[] = [];
    let visited = 0;
    const visit = async (directory: string) => {
      signal.throwIfAborted();
      const filename = await this.filename(scope, directory);
      const entries = await fs.readdir(filename, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (++visited > 5000 || result.length >= 300) return;
        const rel = directory ? directory + '/' + entry.name : entry.name;
        if (blocked(rel, scope) || entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await visit(rel);
        else if (entry.isFile()) result.push(rel);
      }
    };
    await visit(relative);
    return { files: result, truncated: visited > 5000 || result.length >= 300 };
  }

  async readFile(raw: Parameters<RepositoryToolOperations['readFile']>[0]): Promise<ToolResult> {
    this.check('read');
    const input = this.input(schemas.read_file, raw),
      scope = this.#scope;
    const text = await this.read(scope, this.relative(scope, input.path));
    const lines = text.split('\n'),
      start = (input.startLine || 1) - 1;
    return {
      content: JSON.stringify({
        startLine: start + 1,
        totalLines: lines.length,
        text: lines
          .slice(start, start + (input.lineCount || 120))
          .join('\n')
          .slice(0, 16000),
      }),
    };
  }
  async listFiles(raw: Parameters<RepositoryToolOperations['listFiles']>[0]): Promise<ToolResult> {
    this.check('read');
    const input = this.input(schemas.list_files, raw),
      scope = this.#scope;
    const relative = this.relative(scope, input.path || '.');
    return { content: JSON.stringify(await this.files(scope, relative, this.#options.signal)) };
  }
  async searchText(
    raw: Parameters<RepositoryToolOperations['searchText']>[0],
  ): Promise<ToolResult> {
    this.check('read');
    const input = this.input(schemas.search_text, raw),
      scope = this.#scope,
      options = this.#options;
    const relative = this.relative(scope, input.path || '.');
    const singleFile = (await fs.lstat(await this.filename(scope, relative))).isFile();
    const listed = singleFile
      ? { files: [relative], truncated: false }
      : await this.files(scope, relative, options.signal);
    const matches: { path: string; line: number; text: string }[] = [];
    for (const file of listed.files) {
      options.signal.throwIfAborted();
      // A requested file must report an unreadable/oversized target. Directory
      // searches keep skipping unsupported files while searching the others.
      const text = singleFile
        ? await this.read(scope, file)
        : await this.read(scope, file).catch(() => '');
      const lines = text.split('\n');
      for (let i = 0; i < lines.length && matches.length < 50; i++)
        if (lines[i].includes(input.query))
          matches.push({ path: file, line: i + 1, text: lines[i].slice(0, 500) });
      if (matches.length >= 50) break;
    }
    return {
      content: JSON.stringify({ matches, truncated: listed.truncated || matches.length >= 50 }),
    };
  }
  async editFile(raw: Parameters<RepositoryToolOperations['editFile']>[0]): Promise<ToolResult> {
    this.check('write');
    const input = this.input(schemas.edit_file, raw),
      scope = this.#scope,
      options = this.#options;
    const relative = this.relative(scope, input.path);
    if (!writeAllowed(relative, scope.writeScope))
      throw new DomainError('TOOL_SCOPE', 'This file is outside the assignment.');
    const filename = await this.filename(scope, relative, true);
    let before = '',
      exists = true,
      mode = 0o644;
    try {
      before = await this.read(scope, relative);
      mode = (await fs.stat(filename)).mode & 0o777;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      exists = false;
    }
    if (exists && (!input.oldText || before.split(input.oldText).length !== 2))
      throw new DomainError(
        'TOOL_EDIT_CONFLICT',
        'oldText must match exactly once in the existing file.',
      );
    if (!exists && input.oldText)
      throw new DomainError('TOOL_EDIT_CONFLICT', 'A new file needs empty oldText.');
    const after = exists ? before.replace(input.oldText, () => input.newText) : input.newText;
    if (!dependencyManifestPreserved([{ path: relative, before, after }]))
      throw new DomainError('TOOL_SCOPE', 'Preserve protected package fields and check commands.');
    options.signal.throwIfAborted();
    this.#onEffectStart();
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await this.filename(scope, relative, true);
    const temp = filename + '.' + randomUUID() + '.tmp';
    try {
      const handle = await fs.open(temp, 'wx', mode);
      try {
        await handle.writeFile(after);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temp, filename);
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {});
    }
    return { content: 'Edited ' + relative };
  }
  async runCommand(
    raw: Parameters<RepositoryToolOperations['runCommand']>[0],
  ): Promise<ToolResult> {
    this.check('command');
    const input = this.input(schemas.run_command, raw),
      scope = this.#scope,
      options = this.#options;
    const command = scope.commands.find((c) => c.command === input.command);
    if (!command)
      throw new DomainError('TOOL_SCOPE', 'Only exact configured project checks may run.');
    const launch = this.#executors.launch(scope.workspace, ['/bin/sh', '-c', command.command], {
      privateDataIsolation: true,
    });
    options.onCommandStart?.(command.command);
    options.signal.throwIfAborted();
    this.#onEffectStart();
    const result = await runProjectCommand(
      { ...command, title: command.id },
      scope.workspace,
      scope.workspace,
      options.signal,
      {},
      launch,
    );
    return {
      content: JSON.stringify({
        exitCode: result.exitCode,
        output: result.output.slice(-16000),
      }),
      isError: result.exitCode !== 0,
      exitCode: result.exitCode,
    };
  }
  async readDiff(): Promise<ToolResult> {
    this.check('read');
    const scope = this.#scope,
      options = this.#options;
    const base = scope.baseCommit || 'HEAD';
    if (!/^(HEAD|[a-f0-9]{7,64})$/.test(base))
      throw new DomainError('TOOL_SCOPE', 'Invalid saved Git base.');
    const global = [
      '--no-optional-locks',
      '--no-pager',
      '--work-tree=' + scope.workspace,
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.untrackedCache=false',
      '-c',
      'core.attributesFile=/dev/null',
    ];
    let filterKeys = '';
    try {
      filterKeys = (
        await this.git(
          scope,
          [
            ...global,
            'config',
            '--includes',
            '--name-only',
            '--null',
            '--get-regexp',
            '^filter\..*\.(clean|process|smudge|required)$',
          ],
          options.signal,
        )
      ).stdout;
    } catch (error) {
      if ((error as { code?: unknown }).code !== 1) throw error;
    }
    for (const key of filterKeys.split('\0').filter(Boolean)) {
      if (!/^filter\..+\.(clean|process|smudge|required)$/s.test(key))
        throw new DomainError('TOOL_SCOPE', 'Unsafe repository filter configuration.');
      global.push('-c', key + (key.endsWith('.required') ? '=false' : '='));
    }
    const args = [...global, 'diff', '--no-ext-diff', '--no-textconv'];
    const names = (
      await this.git(scope, [...args, '--name-only', '-z', base], options.signal)
    ).stdout
      .split('\0')
      .filter((name) => name && !blocked(name, scope));
    let content = names.length
      ? (
          await this.git(scope, [...args, base, '--', ...names.slice(0, 300)], options.signal)
        ).stdout.slice(0, 24000)
      : '';
    const untracked = (
      await this.git(
        scope,
        [...global, 'ls-files', '--others', '--exclude-standard', '-z'],
        options.signal,
      )
    ).stdout
      .split('\0')
      .filter((name) => name && !blocked(name, scope));
    for (const file of untracked.slice(0, 100)) {
      if (content.length >= 24000) break;
      content +=
        '\nNew untracked file: ' +
        file +
        '\n' +
        (await this.read(scope, file).catch(
          () => '[Content unavailable through bounded text reader]',
        ));
    }
    return { content: content.slice(0, 24000) || 'No changes.' };
  }
}
