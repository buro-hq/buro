import { spawn } from 'node:child_process';
import os from 'node:os';
import type { Launch, EnvironmentExecutors } from '../environments/executors.ts';
import type { CheckPort } from '../../core/execution-ports.ts';
import { DomainError, type ProjectRegistry } from '../../core/ports.ts';
import { canonicalOutputPaths } from '../../core/verification-view.ts';
import type { ProjectCommand, ProjectProfile } from '../../protocol/domain.ts';
import type { VerificationView } from '../../protocol/verification.ts';
/** Run an isolated command; service checks select commands from the protected profile. */
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
  return new Promise<{
    exitCode: number | null;
    output: string;
    durationMs: number;
    truncated: boolean;
  }>((resolve, reject) => {
    const child = spawn(launch?.executable || '/bin/sh', launch?.args || ['-c', command.command], {
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
    });
    let output = '',
      truncated = false,
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
      const combined = output + String(b);
      truncated ||= combined.length > 30000;
      output = combined.slice(-30000);
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
        truncated,
      });
    });
  });
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
    options: { requirePreparedIsolation?: boolean; verificationView?: VerificationView } = {},
  ) {
    const view = options.verificationView;
    const assertView = () => {
      if (!view) return;
      const owner = this.projects
        .get(projectId)
        .snapshot()
        .runs.find((run) => run.id === view.runId);
      if (
        view.projectId !== projectId ||
        view.sourceWorkspace !== workspace ||
        !owner ||
        owner.workspace !== workspace ||
        owner.baseCommit !== view.base ||
        JSON.stringify(owner.verificationView) !== JSON.stringify(view)
      )
        throw new DomainError(
          'VERIFICATION_VIEW_CHANGED',
          'The run no longer owns this verification view.',
        );
    };
    assertView();
    if (options.requirePreparedIsolation && !profile)
      throw new DomainError(
        'STEP_CHECK_UNAVAILABLE',
        'Worker checks require their frozen profile and prepared isolation.',
      );
    if (!profile) {
      // Trusted script checks still leave the view registered for the fresh reviewer.
      if (view && this.executors) await this.executors.registerVerification(view, signal);
      return this.fallback.run(projectId, workspace, ids, signal, profile, options);
    }
    // Independent checks may opt into bounded concurrency. Default remains serial for scripts that share outputs.
    const commands = ids.map((id) => {
      const command = profile.checks.find((c) => c.id === id);
      if (!command) throw Error('The check is missing from the profile snapshot.');
      return command;
    });
    if (view) {
      const outputs = canonicalOutputPaths(
        commands.flatMap((command) => command.outputPaths || []),
      );
      if (JSON.stringify(outputs) !== JSON.stringify(canonicalOutputPaths(view.outputPaths)))
        throw new DomainError(
          'VERIFICATION_VIEW_CHANGED',
          'The view does not match the selected check outputs.',
        );
      if (!this.executors)
        throw new DomainError(
          'ENVIRONMENT_UNAVAILABLE',
          'Immutable check isolation is unavailable.',
        );
      const prepared = this.executors.get(view.sourceWorkspace);
      if (
        (prepared &&
          JSON.stringify(prepared.config) !==
            JSON.stringify(profile.environment || { provider: 'native' })) ||
        (!prepared && (profile.environment?.provider === 'docker' || profile.environment?.recipe))
      )
        throw new DomainError(
          'ENVIRONMENT_UNAVAILABLE',
          'The frozen verification environment is unavailable.',
        );
      await this.executors.registerVerification(view, signal);
    }
    const results: import('../../protocol/domain.ts').Check[] = new Array(commands.length);
    let next = 0;
    const worker = async () => {
      while (next < commands.length) {
        const index = next++,
          check = commands[index];
        signal.throwIfAborted();
        assertView();
        const root = this.projects.get(projectId).snapshot().project.root;
        let launch: Launch | undefined;
        if (view) {
          launch = this.executors!.launchVerification(view, ['/bin/sh', '-c', check.command]);
        } else if (options.requirePreparedIsolation) {
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
        const result = await runProjectCommand(
          check,
          view?.readRoot || workspace,
          view?.readRoot || root,
          signal,
          {},
          launch,
        );
        const passed = result.exitCode === 0;
        const outputHint =
          view &&
          !passed &&
          /EACCES|EROFS|permission denied|operation not permitted|read-only/i.test(result.output)
            ? '\nChecks use immutable source files. Declare build/cache output directories in check settings when this command needs writable outputs.'
            : '';
        results[index] = {
          name: check.title,
          passed,
          command: check.command,
          ...result,
          ...(!passed
            ? { error: (result.output.slice(-3000) || `exit ${result.exitCode}`) + outputHint }
            : {}),
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
  async releaseVerificationView(view: VerificationView) {
    this.executors?.releaseVerification(view);
  }
}
