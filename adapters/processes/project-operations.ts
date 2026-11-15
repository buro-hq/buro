import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import type { ResultOperations } from '../../core/results.ts';
import type { RunPreview } from '../../protocol/operations.ts';
import { runProjectCommand } from '../checks/project-commands.ts';
import { previewEnvironment, deploymentEnvironment, environmentRedactor } from './environment.ts';
import { stageContextMaterials } from '../files/context-materials.ts';
const exec = promisify(execFile);
type Input<K extends keyof ResultOperations> = Parameters<NonNullable<ResultOperations[K]>>[0];
const now = () => new Date().toISOString();
async function unusedPort() {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  return port;
}
function kill(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM') {
  try {
    if (child.pid) process.kill(-child.pid, signal);
  } catch {}
}
export class NativeProjectOperations implements ResultOperations {
  previews = new Map<
    string,
    {
      children: ChildProcess[];
      state: RunPreview;
      stopping: boolean;
      onChange: (state: RunPreview) => void;
    }
  >();
  async verifyWorkspace(root: string, run: Input<'deploy'>['run']) {
    const realRoot = await fs.realpath(root),
      workspace = await fs.realpath(run.workspace!);
    const expected = path.join(realRoot, '.buro/worktrees', run.id);
    if (workspace !== expected) throw Error('The workspace does not belong to this run.');
    const common = async (cwd: string) =>
      fs.realpath(
        path.resolve(
          cwd,
          (await exec('git', ['rev-parse', '--git-common-dir'], { cwd })).stdout.trim(),
        ),
      );
    if ((await common(workspace)) !== (await common(realRoot)))
      throw Error('The workspace belongs to another repository.');
    const head = (await exec('git', ['rev-parse', 'HEAD'], { cwd: workspace })).stdout.trim();
    if (head !== run.commit) throw Error('The workspace commit changed. Verify the result again.');
    const tracked = (
      await exec('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: workspace })
    ).stdout.trim();
    const untracked = (
      await exec(
        'git',
        [
          'ls-files',
          '--others',
          '--exclude-standard',
          '-z',
          '--',
          '.',
          ':(exclude).buro',
          ':(exclude)node_modules',
        ],
        { cwd: workspace },
      )
    ).stdout;
    if (tracked || untracked)
      throw Error('The workspace changed after acceptance. Verify the result again.');
    await stageContextMaterials(root, workspace, run.contextMaterials || []);
    return workspace;
  }
  async preview(input: Input<'preview'>) {
    await this.stopPreview(input.run.id);
    const workspace = await this.verifyWorkspace(input.root, input.run);
    const state: RunPreview = { status: 'starting', components: [], updatedAt: now() };
    const entry = {
      children: [] as ChildProcess[],
      state,
      stopping: false,
      onChange: input.onChange,
    };
    this.previews.set(input.run.id, entry);
    const notify = () => {
      state.updatedAt = now();
      entry.onChange(structuredClone(state));
    };
    try {
      const ports = new Map<string, number>(),
        addresses: Record<string, string> = {},
        allocated = new Set<number>();
      for (const component of input.components) {
        let port = component.port > 0 ? await unusedPort() : 0;
        while (port && allocated.has(port)) port = await unusedPort();
        if (port) allocated.add(port);
        ports.set(component.id, port);
        if (port)
          addresses[
            'PROJECT_COMPONENT_' + component.id.toUpperCase().replaceAll('-', '_') + '_URL'
          ] = `http://127.0.0.1:${port}`;
      }
      for (const component of input.components) {
        if (input.signal.aborted) throw new DOMException('Interrupted', 'AbortError');
        const cwd = await fs.realpath(path.resolve(workspace, component.path));
        if (cwd !== workspace && !cwd.startsWith(workspace + path.sep))
          throw Error('The component escapes the workspace.');
        const port = ports.get(component.id)!;
        const record: RunPreview['components'][number] = {
          id: component.id,
          name: component.name,
          output: '',
          ...(port ? { url: `http://127.0.0.1:${port}/` } : {}),
        };
        state.components.push(record);
        const resolved = await previewEnvironment(input.root, component.path, component.id);
        const local = resolved.values;
        record.envFiles = resolved.sources;
        for (const key of Object.keys(local))
          local[key] = local[key].replace(
            /\$\{(PROJECT_COMPONENT_[A-Z0-9_]+_URL)\}/g,
            (match, name) => addresses[name] || match,
          );
        const env = {
          PATH: process.env.PATH,
          HOME: os.homedir(),
          TMPDIR: os.tmpdir(),
          ...local,
          ...addresses,
          ...(port ? { PORT: String(port), HOST: '127.0.0.1' } : {}),
          GOAL_WORKSPACE: workspace,
        };
        const command = component.command.replaceAll('{port}', String(port));
        const child = spawn('/bin/sh', ['-c', command], {
          cwd,
          env,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        entry.children.push(child);
        const redact = environmentRedactor(local);
        let rawOutput = '';
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        const read = (data: Buffer) => {
          rawOutput = (rawOutput + String(data)).slice(-30000);
          record.output = redact(rawOutput).slice(-8000);
        };
        child.stdout?.on('data', read);
        child.stderr?.on('data', read);
        child.once('error', (error) => {
          state.status = 'failed';
          state.error = error.message;
          notify();
        });
        child.once('exit', (code) => {
          if (!entry.stopping) {
            state.status = 'failed';
            state.error = `${component.name}: process exited (${code}).`;
            notify();
            for (const sibling of entry.children) if (sibling !== child) kill(sibling);
          }
        });
        if (record.url) {
          const deadline = Date.now() + 60000;
          let ready = false;
          while (Date.now() < deadline) {
            if (input.signal.aborted) throw new DOMException('Interrupted', 'AbortError');
            if (child.exitCode !== null || state.status === 'failed')
              throw Error(
                state.error || record.output || 'The process exited before becoming ready.',
              );
            try {
              const response = await fetch(new URL(component.readyPath || '/', record.url), {
                signal: AbortSignal.timeout(1000),
              });
              if (response.ok) {
                ready = true;
                break;
              }
            } catch {}
            await new Promise((r) => setTimeout(r, 300));
          }
          if (!ready)
            throw Error(
              `${component.name}: HTTP readiness check failed after 60 seconds. Check the command, port and readiness path.
${record.output}`,
            );
        }
        notify();
      }
      if (state.status === 'failed') throw Error(state.error);
      state.status = 'running';
      notify();
      return structuredClone(state);
    } catch (error) {
      await this.stopPreview(input.run.id);
      throw error;
    }
  }
  async stopPreview(runId: string) {
    const entry = this.previews.get(runId);
    if (!entry) return;
    entry.stopping = true;
    for (const child of entry.children) kill(child);
    await Promise.all(
      entry.children.map((child) =>
        child.exitCode !== null
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              const timer = setTimeout(() => {
                kill(child, 'SIGKILL');
                resolve();
              }, 1200);
              child.once('exit', () => {
                clearTimeout(timer);
                resolve();
              });
            }),
      ),
    );
    entry.state.status = 'stopped';
    entry.state.updatedAt = now();
    entry.onChange(structuredClone(entry.state));
    this.previews.delete(runId);
  }
  previewStatus(runId: string) {
    const preview = this.previews.get(runId);
    return preview ? structuredClone(preview.state) : null;
  }
  async pullRequest(input: Input<'pullRequest'>) {
    const workspace = await this.verifyWorkspace(input.root, input.run);
    const branch = 'goal/' + input.run.id.toLowerCase();
    const base = input.run.baseBranch || input.run.executionPolicySnapshot?.profile?.baseBranch;
    if (!base) throw Error('Set a base branch in project settings.');
    const opts = { cwd: workspace, signal: input.signal, maxBuffer: 1024 * 1024 };
    try {
      const existingHead = (
        await exec('git', ['rev-parse', '--verify', `refs/heads/${branch}`], opts)
      ).stdout.trim();
      if (existingHead !== input.run.commit)
        throw Error('The result branch already exists with another commit.');
    } catch (error) {
      if ((error as { code?: number }).code === 128)
        await exec('git', ['branch', branch, input.run.commit!], opts);
      else throw error;
    }
    // gh resolves the same configured remote as git push; no shell interpolation.
    const remote = (
      await exec('git', ['remote', 'get-url', input.config.remote], opts)
    ).stdout.trim();
    const match = remote.match(
      /^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+\/[^/]+?)(?:\.git)?$/,
    );
    if (!match)
      throw Error(
        'Automatic PR creation currently supports GitHub. Configure a GitHub remote or use a local result.',
      );
    const repo = match[1];
    await exec('gh', ['auth', 'status', '--hostname', 'github.com'], opts);
    await exec(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        'push',
        input.config.remote,
        `${input.run.commit}:refs/heads/${branch}`,
      ],
      opts,
    );
    const existing = JSON.parse(
      (
        await exec(
          'gh',
          [
            'pr',
            'list',
            '--repo',
            repo,
            '--head',
            branch,
            '--state',
            'all',
            '--json',
            'url,state,baseRefName',
          ],
          opts,
        )
      ).stdout,
    ) as { url: string; state: string; baseRefName: string }[];
    if (existing.length) {
      if (existing[0].state !== 'OPEN' || existing[0].baseRefName !== base)
        throw Error(
          'This branch already has a closed PR or a PR to another base branch. Review it before retrying.',
        );
      return { url: existing[0].url, branch };
    }
    const directory = path.join(input.root, '.buro/local');
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, 'pr-' + input.run.id + '-' + crypto.randomUUID() + '.md');
    await fs.writeFile(
      file,
      input.body + `\n\nRun: ${input.run.id}\nCommit: ${input.run.commit}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    try {
      const result = await exec(
        'gh',
        [
          'pr',
          'create',
          '--repo',
          repo,
          '--head',
          branch,
          '--base',
          base,
          '--draft',
          '--title',
          input.run.title,
          '--body-file',
          file,
        ],
        opts,
      );
      return { url: result.stdout.trim(), branch, output: result.stderr };
    } finally {
      await fs.rm(file, { force: true });
    }
  }
  async deploy(input: Input<'deploy'>) {
    const workspace = await this.verifyWorkspace(input.root, input.run);
    if (!input.environment.command.trim())
      throw Error('No delivery command is configured for this environment.');
    if (!input.environment.url.trim())
      throw Error('No result verification URL is configured for this environment.');
    const resolved = await deploymentEnvironment(input.root, input.environment.id),
      redact = environmentRedactor(resolved.values);
    const result = await runProjectCommand(
      {
        id: 'deploy',
        title: input.environment.name,
        command: input.environment.command,
        timeoutMs: 900000,
      },
      workspace,
      input.root,
      input.signal,
      {
        ...resolved.values,
        PROJECT_DELIVERY_COMMIT: input.run.commit!,
        PROJECT_DELIVERY_ENVIRONMENT: input.environment.id,
      },
    );
    if (result.exitCode !== 0)
      throw Error(redact(result.output) || `Delivery exited with code ${result.exitCode}`);
    const response = await fetch(input.environment.url, {
      signal: AbortSignal.any([input.signal, AbortSignal.timeout(15000)]),
    });
    if (!response.ok)
      throw Error(
        `The command completed, but verification of ${input.environment.url} returned HTTP ${response.status}. Check the external result before retrying deployment.`,
      );
    return { url: input.environment.url, output: redact(result.output) };
  }
  async dispose() {
    await Promise.all([...this.previews.keys()].map((id) => this.stopPreview(id)));
  }
}
