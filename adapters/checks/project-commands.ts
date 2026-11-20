import { spawn } from 'node:child_process';
import os from 'node:os';
import type { Launch, EnvironmentExecutors } from '../environments/executors.ts';
import type { CheckPort } from '../../core/execution-ports.ts';
import { DomainError, type ProjectRegistry } from '../../core/ports.ts';
import type { ProjectCommand, ProjectProfile } from '../../protocol/domain.ts';
/** Commands are chosen by the user in the protected profile, never by an agent. */
export async function runProjectCommand(
  command: ProjectCommand,
  workspace: string,
  root: string,
  signal: AbortSignal,
  environment: Record<string, string> = {},
  launch?: Launch,
) {
  if (signal.aborted) throw new DOMException('Interrupted', 'AbortError');
  const started = Date.now();
  return new Promise<{ exitCode: number | null; output: string; durationMs: number }>(
    (resolve, reject) => {
      const child = spawn(
        launch?.executable || '/bin/sh',
        launch?.args || ['-c', command.command],
        {
          cwd: workspace,
          detached: true,
          env: {
            PATH: process.env.PATH,
            HOME: os.homedir(),
            TMPDIR: process.env.TMPDIR || os.tmpdir(),
            PROJECT_ROOT: root,
            GOAL_WORKSPACE: workspace,
            CI: '1',
            ...launch?.env,
            ...environment,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let output = '',
        timedOut = false,
        killTimer: ReturnType<typeof setTimeout> | undefined;
      let termination = Promise.resolve(),
        killed = false;
      const kill = () => {
        if (killed) return;
        killed = true;
        if (launch?.terminate) termination = launch.terminate();
        // Attach immediately so a cleanup failure cannot become an unhandled rejection.
        void termination.catch(() => {});
        try {
          if (child.pid) process.kill(-child.pid, 'SIGTERM');
        } catch {}
        killTimer = setTimeout(() => {
          try {
            if (child.pid) process.kill(-child.pid, 'SIGKILL');
          } catch {}
        }, 1000);
      };
      const timer = setTimeout(() => {
          timedOut = true;
          kill();
        }, command.timeoutMs),
        abort = () => kill();
      signal.addEventListener('abort', abort, { once: true });
      const read = (b: Buffer) => {
        output = (output + String(b)).slice(-30000);
      };
      child.stdout.on('data', read);
      child.stderr.on('data', read);
      const cleanup = () => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        signal.removeEventListener('abort', abort);
      };
      child.once('error', (error) => {
        cleanup();
        reject(error);
      });
      child.once('close', async (code) => {
        cleanup();
        try {
          await termination;
        } catch (error) {
          reject(error);
          return;
        }
        if (signal.aborted) return reject(new DOMException('Interrupted', 'AbortError'));
        resolve({
          exitCode: timedOut ? -1 : code,
          output: (timedOut ? 'Command timed out.\n' : '') + output,
          durationMs: Date.now() - started,
        });
      });
    },
  );
}
export class ProjectChecks implements CheckPort {
  projects: ProjectRegistry;
  fallback: CheckPort;
  executors?: EnvironmentExecutors;
  constructor(projects: ProjectRegistry, fallback: CheckPort, executors?: EnvironmentExecutors) {
    this.projects = projects;
    this.fallback = fallback;
    this.executors = executors;
  }
  async run(
    projectId: string,
    workspace: string,
    ids: string[],
    signal: AbortSignal,
    profile?: ProjectProfile,
    options: { requirePreparedIsolation?: boolean } = {},
  ) {
    if (options.requirePreparedIsolation && !profile)
      throw new DomainError(
        'STEP_CHECK_UNAVAILABLE',
        'Worker checks require their frozen profile and prepared isolation.',
      );
    if (!profile) return this.fallback.run(projectId, workspace, ids, signal);
    // Independent checks may opt into bounded concurrency. Default remains serial for scripts that share outputs.
    const commands = ids.map((id) => {
      const command = profile.checks.find((c) => c.id === id);
      if (!command) throw Error('The check is missing from the profile snapshot.');
      return command;
    });
    const results: import('../../protocol/domain.ts').Check[] = new Array(commands.length);
    let next = 0;
    const worker = async () => {
      while (next < commands.length) {
        const index = next++,
          check = commands[index];
        signal.throwIfAborted();
        const root = this.projects.get(projectId).snapshot().project.root;
        let launch: Launch | undefined;
        if (options.requirePreparedIsolation) {
          const world = this.executors?.get(workspace);
          if (
            !this.executors ||
            !world ||
            world.workspace !== workspace ||
            world.root !== root ||
            !world.privateDataIsolation ||
            JSON.stringify(world.config) !==
              JSON.stringify(profile.environment || { provider: 'native' })
          )
            throw new DomainError(
              'STEP_CHECK_UNAVAILABLE',
              'The prepared worker check isolation is unavailable.',
            );
          // Validate at the dispatch boundary, including each subsequent command. Never fall back to the host.
          launch = this.executors.launch(workspace, ['/bin/sh', '-c', check.command], {
            privateDataIsolation: true,
          });
        } else {
          launch = this.executors?.get(workspace)
            ? this.executors.launch(workspace, ['/bin/sh', '-c', check.command])
            : undefined;
        }
        const result = await runProjectCommand(check, workspace, root, signal, {}, launch);
        const passed = result.exitCode === 0;
        results[index] = {
          name: check.title,
          passed,
          command: check.command,
          ...result,
          ...(!passed ? { error: result.output.slice(-3000) || `exit ${result.exitCode}` } : {}),
        };
      }
    };
    const settled = await Promise.allSettled(
      Array.from({ length: Math.min(profile.checkConcurrency || 1, commands.length) }, worker),
    );
    const failed = settled.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    return { passed: results.filter((r) => r.passed).length, total: results.length, results };
  }
}
