import { z } from 'zod';
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  type ProjectComponent,
  type Run,
  type RunPreview,
} from '../protocol/domain.ts';
import type { DeliveryConfig } from '../protocol/operations.ts';
import { DomainError, type AgentRuntime, type ProjectRegistry } from './ports.ts';

export interface ResultOperations {
  preview(input: {
    root: string;
    run: Run;
    components: ProjectComponent[];
    signal: AbortSignal;
    onChange: (preview: RunPreview) => void;
  }): Promise<RunPreview>;
  stopPreview(runId: string): Promise<void>;
  previewStatus?(runId: string): RunPreview | null;
  pullRequest(input: {
    root: string;
    run: Run;
    config: DeliveryConfig;
    body: string;
    signal: AbortSignal;
  }): Promise<{ url: string; branch: string; output?: string }>;
  deploy(input: {
    root: string;
    run: Run;
    environment: DeliveryConfig['environments'][number];
    signal: AbortSignal;
  }): Promise<{ url?: string; output: string }>;
  dispose(): Promise<void>;
}
const PreparationSchema = z.object({
  ready: z.boolean(),
  summary: z.string().max(12000),
  blockers: z.array(z.string().max(2000)).max(12),
});
/** Result delivery never changes implementation acceptance. */
export class ResultService {
  projects: ProjectRegistry;
  runtime: AgentRuntime;
  operations: ResultOperations;
  jobs = new Map<string, { controller: AbortController; promise: Promise<unknown> }>();
  queues = new Map<string, Promise<unknown>>();
  closing = false;
  environmentLocks = new Set<string>();
  serialize<T>(key: string, fn: () => Promise<T>) {
    if (this.closing)
      return Promise.reject(new DomainError('STOPPING', 'The service is stopping.'));
    const result = (this.queues.get(key) || Promise.resolve()).catch(() => {}).then(fn);
    this.queues.set(key, result);
    void result
      .finally(() => {
        if (this.queues.get(key) === result) this.queues.delete(key);
      })
      .catch(() => {});
    return result;
  }
  constructor(options: {
    projects: ProjectRegistry;
    runtime: AgentRuntime;
    operations: ResultOperations;
  }) {
    this.projects = options.projects;
    this.runtime = options.runtime;
    this.operations = options.operations;
  }
  get(projectId: string, runId: string) {
    const s = this.projects.get(projectId).snapshot(),
      r = s.runs.find((r) => r.id === runId);
    if (!r || r.status !== 'completed' || !r.commit || !r.workspace)
      throw new DomainError('NOT_COMPLETED', 'Finish the implementation first.');
    return { snapshot: s, run: r };
  }
  update(
    projectId: string,
    runId: string,
    fn: (run: Run) => void,
    meta?: { id: string; fingerprint: string },
    result: unknown = null,
  ) {
    return this.projects
      .get(projectId)
      .transact(
        meta?.id || 'internal-' + crypto.randomUUID(),
        meta?.fingerprint || 'result',
        (doc) => {
          const run = doc.runs.find((r) => r.id === runId)!,
            goal = doc.goals.find((g) => g.id === run?.goalId);
          if (!run || !goal) throw new DomainError('NOT_FOUND', 'Goal not found.');
          fn(run);
          return { result, change: { type: 'run.changed', run, goal } };
        },
      );
  }
  async prepare(
    projectId: string,
    run: Run,
    roleId: string,
    context: unknown,
    signal: AbortSignal,
  ) {
    const role = this.projects
      .get(projectId)
      .snapshot()
      .roles.find((r) => r.id === roleId);
    if (!role)
      throw new DomainError('ROLE_MISSING', `Create or select role ${roleId} in the project team.`);
    const { threadId } = await this.runtime.start({
      projectId,
      workspace: run.workspace,
      readOnly: true,
      runId: 'result-' + run.id,
      instructions:
        role.instructions +
        '\nThis prepares a result after acceptance. Read only. Do not run delivery/launch commands, mutate Git, use the network, install packages or run migrations. The service performs these operations. Do not read secrets or local/. Verify the saved commit and configuration; do not invent settings.' +
        (roleId === 'local_preview'
          ? ' The service passes env from source project/component .env/.env.local files and then .buro/local/. A missing workspace .env does not mean variables are unavailable: they are passed to the process without copying files. Do not read their values.'
          : ''),
    });
    await this.update(projectId, run.id, (r) => {
      const at = new Date().toISOString();
      (r.resultAgents ??= []).push({
        threadId,
        name: roleId,
        agentPath: '/results/' + roleId,
        startedAt: at,
        completedAt: '',
        messages: [],
        commands: 0,
        status: 'running',
      });
      if (!r.roleSnapshots?.some((saved) => saved.id === role.id && saved.version === role.version))
        r.roleSnapshots = [...(r.roleSnapshots || []), role];
      r.events.push({
        at,
        type: 'result.role.started',
        threadId,
        text: `${role.title} · v${role.version}`,
      });
    });
    try {
      if (!this.runtime.turn) throw Error('The runtime does not support result preparation.');
      const answer = await this.runtime.turn(
        threadId,
        `Prepare the result for role ${roleId}. Goal: ${run.goalText}. Accepted commit: ${run.commit}. Result: ${run.result}. Checks: ${JSON.stringify(run.acceptance)}. Configuration: ${JSON.stringify(context)}. Return ready, blockers and summary: a concise delivery/result description with checks. For PRs, summary becomes the PR body. Do not read secrets to check missing credentials; the service verifies access.`,
        {
          schema: z.toJSONSchema(PreparationSchema, { target: 'draft-7' }),
          signal,
          timeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
        },
      );
      const result = PreparationSchema.parse(JSON.parse(answer.text));
      if (!result.ready || result.blockers.length)
        throw new DomainError('RESULT_BLOCKED', result.blockers.join('\n') || result.summary);
      await this.update(projectId, run.id, (r) => {
        const agent = r.resultAgents!.find((a) => a.threadId === threadId)!;
        agent.status = 'completed';
        agent.completedAt = new Date().toISOString();
        agent.messages = [result.summary];
        r.events.push({
          at: agent.completedAt,
          type: 'result.role.completed',
          threadId,
          text: result.summary,
        });
      });
      return { summary: result.summary, role };
    } catch (error) {
      await this.update(projectId, run.id, (r) => {
        const agent = r.resultAgents?.find((a) => a.threadId === threadId);
        if (agent) {
          agent.status = 'failed';
          agent.completedAt = new Date().toISOString();
          agent.messages = [error instanceof Error ? error.message : String(error)];
        }
      }).catch(() => {});
      throw error;
    } finally {
      await this.runtime.release?.(threadId);
    }
  }
  deliver(
    projectId: string,
    runId: string,
    expectedCommit: string,
    confirmed = false,
    meta?: { id: string; fingerprint: string },
    redeploy = false,
  ) {
    return this.serialize('delivery:' + runId, () =>
      this.deliverOnce(projectId, runId, expectedCommit, confirmed, meta, redeploy),
    );
  }
  async deliverOnce(
    projectId: string,
    runId: string,
    expectedCommit: string,
    confirmed = false,
    meta?: { id: string; fingerprint: string },
    redeploy = false,
  ) {
    if (meta) {
      const cached = this.projects.get(projectId).receipt(meta.id, meta.fingerprint);
      if (cached !== undefined) return cached as { status: string };
    }
    const { snapshot, run } = this.get(projectId, runId);
    run.baseBranch ||=
      run.executionPolicySnapshot?.profile?.baseBranch || snapshot.profile?.baseBranch;
    if (run.commit !== expectedCommit)
      throw new DomainError('COMMIT_CHANGED', 'The result commit changed. Refresh the view.');
    if (!redeploy && run.delivery?.status === 'completed' && run.delivery.commit === expectedCommit)
      return { status: 'completed' };
    if (this.jobs.has('delivery:' + runId)) {
      if (meta) await this.update(projectId, runId, () => {}, meta, { status: 'running' });
      return { status: 'running' };
    }
    if (redeploy && (run.delivery?.status !== 'completed' || run.delivery.kind !== 'deploy'))
      throw new DomainError(
        'REDEPLOY_UNAVAILABLE',
        'Repeat delivery is available after a successful deployment.',
      );
    const outcome = redeploy
      ? { kind: 'deploy' as const, environmentId: run.delivery!.environmentId }
      : run.outcome || { kind: 'pull-request' as const };
    if (outcome.kind === 'local') return { status: 'local' };
    const config =
      (run.delivery?.status === 'needs-attention'
        ? snapshot.profile?.delivery
        : run.delivery?.config) ||
      run.executionPolicySnapshot?.profile?.delivery ||
      snapshot.profile?.delivery;
    const current = snapshot.profile?.delivery;
    const savedEnvironment = config?.environments.find((e) => e.id === outcome.environmentId);
    const environment = savedEnvironment
      ? {
          ...savedEnvironment,
          requireConfirmation:
            savedEnvironment.requireConfirmation ||
            !!current?.environments.find((e) => e.id === savedEnvironment.id)?.requireConfirmation,
        }
      : undefined;
    const enabled =
      outcome.kind === 'pull-request'
        ? !!config?.pullRequests && !!current?.pullRequests
        : !!environment?.enabled &&
          !!current?.environments.some((e) => e.id === environment.id && e.enabled);
    const roleId =
      outcome.kind === 'pull-request'
        ? 'delivery_pr'
        : environment?.roleId || 'production_delivery';
    const status = !enabled ? 'needs-attention' : 'pending';
    if (
      confirmed &&
      environment?.requireConfirmation &&
      run.delivery?.status !== 'awaiting-confirmation'
    )
      throw new DomainError('PREPARE_FIRST', 'Prepare delivery and review its parameters first.');
    await this.update(projectId, runId, (r) => {
      if (redeploy && r.delivery) {
        (r.deliveryHistory ??= []).push(structuredClone(r.delivery));
        r.events.push({
          at: new Date().toISOString(),
          type: 'delivery.redeploy-requested',
          text: `Repeat delivery of ${expectedCommit} to ${r.delivery.environmentId}`,
        });
      }
      r.delivery = {
        kind: outcome.kind,
        environmentId: outcome.environmentId,
        status,
        commit: expectedCommit,
        summary: !enabled
          ? 'Configure and enable delivery in project settings. The implementation is ready.'
          : 'Preparing delivery',
        updatedAt: new Date().toISOString(),
        config: config
          ? {
              ...structuredClone(config),
              environments: config.environments.map((e) =>
                e.id === environment?.id ? environment : e,
              ),
            }
          : undefined,
        roleId,
      };
    });
    if (meta)
      await this.projects.get(projectId).transact(meta.id, meta.fingerprint, (doc) => {
        const live = doc.runs.find((r) => r.id === runId)!,
          goal = doc.goals.find((g) => g.id === live.goalId)!;
        return {
          result: { status: status === 'pending' ? 'running' : status },
          change: { type: 'run.changed', run: live, goal },
        };
      });
    if (status !== 'pending') return { status };
    const controller = new AbortController();
    const promise = Promise.resolve().then(async () => {
      try {
        await this.update(projectId, runId, (r) => {
          r.delivery!.status = 'running';
        });
        const prepared = await this.prepare(
          projectId,
          run,
          roleId,
          environment || config,
          controller.signal,
        );
        const latest = this.projects.get(projectId).snapshot().profile?.delivery;
        if (outcome.kind === 'deploy' && environment?.requireConfirmation && !confirmed) {
          await this.update(projectId, runId, (r) => {
            r.delivery!.status = 'awaiting-confirmation';
            r.delivery!.summary = prepared.summary;
            r.delivery!.roleVersion = prepared.role.version;
            r.delivery!.updatedAt = new Date().toISOString();
          });
          return;
        }
        if (
          outcome.kind === 'pull-request'
            ? !latest?.pullRequests
            : !latest?.environments.some((e) => e.id === environment!.id && e.enabled)
        )
          throw new DomainError('DELIVERY_DISABLED', 'Delivery is disabled in project settings.');
        const lock = outcome.kind === 'deploy' ? projectId + ':' + environment!.id : undefined;
        if (lock && this.environmentLocks.has(lock))
          throw new DomainError(
            'ENVIRONMENT_BUSY',
            'Delivery to this environment is already running. Wait for it to finish.',
          );
        if (lock) this.environmentLocks.add(lock);
        let result: { url?: string; branch?: string; output?: string };
        try {
          result =
            outcome.kind === 'pull-request'
              ? await this.operations.pullRequest({
                  root: snapshot.project.root,
                  run,
                  config: config!,
                  body: prepared.summary,
                  signal: controller.signal,
                })
              : await this.operations.deploy({
                  root: snapshot.project.root,
                  run,
                  environment: environment!,
                  signal: controller.signal,
                });
        } finally {
          if (lock) this.environmentLocks.delete(lock);
        }
        await this.update(projectId, runId, (r) => {
          Object.assign(r.delivery!, result, {
            status: 'completed',
            summary: prepared.summary,
            roleVersion: prepared.role.version,
            updatedAt: new Date().toISOString(),
          });
          r.events.push({
            at: new Date().toISOString(),
            type: 'delivery.completed',
            text: result.url || prepared.summary,
          });
        });
      } catch (error) {
        await this.update(projectId, runId, (r) => {
          r.delivery!.status = controller.signal.aborted ? 'interrupted' : 'failed';
          r.delivery!.summary = error instanceof Error ? error.message : String(error);
          r.delivery!.updatedAt = new Date().toISOString();
        }).catch(() => {});
      }
    });
    this.jobs.set('delivery:' + runId, { controller, promise });
    void promise.finally(() => this.jobs.delete('delivery:' + runId)).catch(() => {});
    return { status: 'running' };
  }
  preview(projectId: string, runId: string, meta?: { id: string; fingerprint: string }) {
    return this.serialize('preview:' + runId, () => this.previewOnce(projectId, runId, meta));
  }
  restartPreview(projectId: string, runId: string, meta?: { id: string; fingerprint: string }) {
    return this.serialize('preview:' + runId, async () => {
      if (meta) {
        const cached = this.projects.get(projectId).receipt(meta.id, meta.fingerprint);
        if (cached !== undefined) return cached as { status: string };
      }
      this.get(projectId, runId);
      await this.stopPreview(projectId, runId);
      return this.previewOnce(projectId, runId, meta);
    });
  }
  async previewOnce(projectId: string, runId: string, meta?: { id: string; fingerprint: string }) {
    if (meta) {
      const cached = this.projects.get(projectId).receipt(meta.id, meta.fingerprint);
      if (cached !== undefined) return cached as { status: string };
    }
    const { snapshot, run } = this.get(projectId, runId);
    if (this.jobs.has('preview:' + runId) || run.preview?.status === 'running')
      return { status: 'running' };
    const components = snapshot.profile?.components?.filter((c) => c.command.trim()) || [];
    if (!components.length)
      throw new DomainError(
        'PREVIEW_NOT_CONFIGURED',
        'Configure local launch commands in the project. CLI and library projects can use checks and instructions.',
      );
    const controller = new AbortController();
    await this.update(
      projectId,
      runId,
      (r) => {
        r.preview = { status: 'starting', components: [], updatedAt: new Date().toISOString() };
      },
      meta,
      { status: 'starting' },
    );
    const onChange = (preview: RunPreview) => {
      void this.update(projectId, runId, (r) => {
        r.preview = preview;
      }).catch(() => {});
    };
    const promise = Promise.resolve().then(async () => {
      try {
        await this.prepare(projectId, run, 'local_preview', components, controller.signal);
        const preview = await this.operations.preview({
          root: snapshot.project.root,
          run,
          components,
          signal: controller.signal,
          onChange,
        });
        await this.update(projectId, runId, (r) => {
          r.preview = preview;
        });
      } catch (error) {
        await this.operations.stopPreview(runId);
        await this.update(projectId, runId, (r) => {
          r.preview = {
            status: 'failed',
            components: [],
            updatedAt: new Date().toISOString(),
            error: error instanceof Error ? error.message : String(error),
          };
        }).catch(() => {});
      }
    });
    this.jobs.set('preview:' + runId, { controller, promise });
    void promise.finally(() => this.jobs.delete('preview:' + runId)).catch(() => {});
    return { status: 'starting' };
  }
  async stopPreview(projectId: string, runId: string) {
    const job = this.jobs.get('preview:' + runId);
    job?.controller.abort();
    await this.operations.stopPreview(runId);
    await job?.promise;
    await this.update(projectId, runId, (r) => {
      if (r.preview) {
        r.preview.status = 'stopped';
        r.preview.error = undefined;
      }
    });
    return { status: 'stopped' };
  }
  previewStatus(projectId: string, runId: string) {
    return this.operations.previewStatus?.(runId) || this.get(projectId, runId).run.preview || null;
  }
  async recover() {
    for (const project of this.projects.list())
      for (const run of this.projects.get(project.id).snapshot().runs) {
        if (
          ['running', 'pending'].includes(run.delivery?.status || '') ||
          ['running', 'starting'].includes(run.preview?.status || '')
        )
          await this.update(project.id, run.id, (r) => {
            if (r.delivery && ['running', 'pending'].includes(r.delivery.status)) {
              r.delivery.status = 'interrupted';
              r.delivery.summary =
                'The service stopped. Check the external result before retrying delivery.';
            }
            if (r.preview) {
              r.preview.status = 'stopped';
              r.preview.error = undefined;
            }
          });
      }
  }
  async dispose() {
    this.closing = true;
    await Promise.allSettled([...this.queues.values()]);
    for (const job of this.jobs.values()) job.controller.abort();
    await Promise.allSettled([...this.jobs.values()].map((j) => j.promise));
    await this.operations.dispose();
  }
}
