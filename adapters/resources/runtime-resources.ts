import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { AgentRuntime, ProjectRegistry, RuntimeSelection } from '../../core/ports.ts';
import { DomainError } from '../../core/ports.ts';
import { ManagedAgentRuntime } from '../../core/managed-runtime.ts';
import { conservativeRequestPolicy, type ManagedRequestPolicy } from '../../core/request-policy.ts';
import { ResourceSelection } from '../../core/resource-selection.ts';
import { CapabilityProbeService, type ProbeReceipt } from '../../core/capability-probe.ts';
import type { ResourceConnection, RuntimeResource } from '../../protocol/resources.ts';
import { CodexRuntime } from '../codex/runtime.ts';
import { OllamaProvider } from '../models/ollama.ts';
import { DeepSeekProvider } from '../models/deepseek.ts';
import { RequestGate, endpointURL } from '../models/http.ts';
import { FileManagedSessions } from '../files/managed-sessions.ts';
import {
  FileResourceConfiguration,
  connectionConfigurationRevision,
} from '../files/resource-configuration.ts';
import { PrivateJSONFiles } from '../files/private-json.ts';
import { loadModelCredentials } from '../files/model-credentials.ts';
import { RepositoryTools } from '../tools/repository-tools.ts';
import type { EnvironmentExecutors } from '../environments/executors.ts';
import { ProjectRunBudgets } from '../files/project-run-budgets.ts';
import type { ManagedRunBudgetPort } from '../../core/run-budget.ts';
import type { CheckPort, WorkspacePort } from '../../core/execution-ports.ts';
import {
  WORKER_STEP_CHECK_REVISION,
  type WorkerStepCheckPort,
} from '../../core/worker-step-checks.ts';
import {
  boundedWorkSegmentPolicy,
  validateSegmentLimits,
  type SegmentEvidencePort,
  type WorkSegmentPolicy,
} from '../../core/work-segments.ts';
import { RepositorySegmentEvidence } from '../tools/segment-evidence.ts';
import { WorkerStepChecks } from '../checks/worker-step-checks.ts';

export async function createRuntimeResources(options: {
  directory: string;
  projects: ProjectRegistry;
  executors: EnvironmentExecutors;
  fetch?: typeof fetch;
  codex?: { executable?: string; args?: string[] };
  credentials?: (reference: string) => string | undefined;
  requestPolicy?: ManagedRequestPolicy;
  budgets?: ManagedRunBudgetPort;
  workspaces?: Pick<WorkspacePort, 'changes'>;
  segmentPolicy?: WorkSegmentPolicy;
  segmentEvidence?: SegmentEvidencePort;
  checks?: CheckPort;
  workerStepChecks?: WorkerStepCheckPort;
}) {
  const local = path.join(options.directory, 'local');
  options.executors.protectPrivatePaths([local]);
  const configuration = await FileResourceConfiguration.open(local),
    config = configuration.snapshot();
  const credentials = options.credentials || (await loadModelCredentials(local));
  const sessions = new FileManagedSessions(path.join(local, 'managed-sessions'));
  const probes = new PrivateJSONFiles(path.join(local, 'resource-probes'));
  const tools = new RepositoryTools(options.executors);
  const budgets = options.budgets || new ProjectRunBudgets(options.projects);
  const requestPolicy = options.requestPolicy || conservativeRequestPolicy;
  const segmentEvidence =
    options.segmentEvidence ||
    (options.workspaces ? new RepositorySegmentEvidence(options.workspaces) : undefined);
  const segmentPolicy =
    options.segmentPolicy || (segmentEvidence ? boundedWorkSegmentPolicy : undefined);
  if (segmentPolicy) {
    validateSegmentLimits(segmentPolicy.limits);
    if (!segmentEvidence || segmentPolicy.revision !== segmentPolicy.limits.revision)
      throw new DomainError('INVALID_SEGMENT_POLICY', 'The work segment policy is incomplete.');
  }
  const workerStepChecks =
    options.workerStepChecks ||
    (segmentEvidence && options.checks
      ? new WorkerStepChecks({
          projects: options.projects,
          checks: options.checks,
          evidence: segmentEvidence,
          executors: options.executors,
        })
      : undefined);
  if (
    typeof requestPolicy.revision !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,100}$/.test(requestPolicy.revision) ||
    typeof requestPolicy.prepare !== 'function'
  )
    throw new DomainError('INVALID_REQUEST_POLICY', 'The request policy needs a stable revision.');
  const connectionKey = (connection: (typeof config.connections)[number]) =>
    JSON.stringify([connection.kind, endpointURL(connection.endpoint).href]);
  const capacities = new Map<string, number>();
  for (const connection of config.connections)
    capacities.set(
      connectionKey(connection),
      Math.min(capacities.get(connectionKey(connection)) || Infinity, connection.capacity),
    );
  const gates = new Map([...capacities].map(([key, capacity]) => [key, new RequestGate(capacity)]));
  const providers = new Map<string, OllamaProvider | DeepSeekProvider>();
  for (const connection of config.connections) {
    const common = {
      id: connection.id,
      endpoint: connection.endpoint,
      fetch: options.fetch,
      gate: gates.get(connectionKey(connection))!,
    };
    providers.set(
      connection.id,
      connection.kind === 'ollama'
        ? new OllamaProvider({ ...common, think: connection.think, trust: connection.trust })
        : new DeepSeekProvider({
            ...common,
            apiKey: () => credentials(connection.apiKeyEnv),
            thinking: connection.thinking,
          }),
    );
  }
  const runtimes: AgentRuntime[] = [],
    resources: RuntimeResource[] = [];
  for (const runtime of config.runtimes) {
    if (runtime.client === 'codex') {
      runtimes.push(
        new CodexRuntime({
          projects: options.projects,
          executors: options.executors,
          ...options.codex,
        }),
      );
      resources.push({
        id: runtime.id,
        client: 'codex',
        local: false,
        configurationRevision: createHash('sha256')
          .update(JSON.stringify(['codex-buro-dispatch-v1', options.codex || {}]))
          .digest('hex'),
      });
    } else {
      const provider = providers.get(runtime.connectionId)!;
      runtimes.push(
        new ManagedAgentRuntime({
          id: runtime.id,
          model: runtime.model,
          provider,
          sessions,
          tools,
          projects: options.projects,
          idGenerator: randomUUID,
          limits: runtime.limits,
          requestPolicy,
          budgets,
          segmentPolicy,
          segmentEvidence,
          workerStepChecks,
        }),
      );
      resources.push({
        id: runtime.id,
        client: 'managed',
        providerId: provider.id,
        model: runtime.model,
        local: provider.local && !/(?:[:_-]cloud)(?:$|:)/i.test(runtime.model),
        configurationRevision: createHash('sha256')
          .update(
            JSON.stringify([
              provider.revision,
              runtime.model,
              runtime.limits,
              requestPolicy.revision,
              ...(segmentPolicy ? [[segmentPolicy.revision, segmentPolicy.limits]] : []),
              ...(workerStepChecks ? [WORKER_STEP_CHECK_REVISION] : []),
            ]),
          )
          .digest('hex'),
      });
    }
  }
  const activeSelection = new ResourceSelection({
    projects: options.projects,
    profiles: config.profiles,
    runtimes: resources,
    defaultProfile: () => configuration.snapshot().defaultProfile,
  });
  // Editing a connection never retargets an active provider or a frozen run.
  const pending = (connectionId: string) => {
    const saved = configuration.snapshot().connections.find((item) => item.id === connectionId);
    const active = config.connections.find((item) => item.id === connectionId);
    return (
      !!saved &&
      (!active ||
        connectionConfigurationRevision(saved) !== connectionConfigurationRevision(active))
    );
  };
  const assertActive = (connectionId: string) => {
    if (pending(connectionId))
      throw new DomainError(
        'CONNECTION_RESTART_REQUIRED',
        'Restart the service to apply this model connection before starting new work.',
      );
  };
  const selection: RuntimeSelection = {
    forProject(projectId) {
      const selected = activeSelection.forProject(projectId);
      for (const resource of [
        selected.coordinator,
        selected.worker,
        selected.reviewer,
        ...(selected.workerPool || []),
      ])
        if (resource.providerId) assertActive(resource.providerId);
      return selected;
    },
  };
  const list = async (projectId?: string) => ({
    defaultProfile: configuration.snapshot().defaultProfile,
    profiles: config.profiles,
    runtimes: resources,
    connections: configuration.snapshot().connections.map((connection) => ({
      ...connection,
      revision: connectionConfigurationRevision(connection),
      credentialConfigured: connection.kind !== 'deepseek' || !!credentials(connection.apiKeyEnv),
      activeEndpoint: config.connections.find((item) => item.id === connection.id)?.endpoint,
      restartRequired: pending(connection.id),
    })),
    ...(projectId ? { selected: activeSelection.forProject(projectId) } : {}),
    probes: (
      await Promise.all(
        resources.map(async (resource) => {
          if (resource.providerId && pending(resource.providerId)) return undefined;
          const result = (await probes.load(resource.id)) as
            | { configurationRevision?: string }
            | undefined;
          return result?.configurationRevision === resource.configurationRevision
            ? result
            : undefined;
        }),
      )
    ).filter(Boolean),
  });
  const models = async (connectionId: string) => {
    assertActive(connectionId);
    const provider = providers.get(connectionId);
    if (!provider) throw new DomainError('CONNECTION_UNAVAILABLE', 'Model connection unavailable.');
    return provider.listModels(AbortSignal.timeout(15000));
  };
  const probeService = new CapabilityProbeService({
    binding: (runtimeId) => {
      const runtime = config.runtimes.find((item) => item.id === runtimeId);
      const resource = resources.find((item) => item.id === runtimeId);
      if (!runtime || runtime.client !== 'managed' || !resource)
        throw new DomainError(
          'PROBE_UNSUPPORTED',
          'Select a managed model runtime for the capability probe.',
        );
      return {
        provider: providers.get(runtime.connectionId)!,
        model: runtime.model,
        configurationRevision: resource.configurationRevision,
        contextTokens: runtime.limits.contextTokens,
        maxOutputTokens: runtime.limits.maxOutputTokens,
      };
    },
    store: {
      loadRequest: async (id) => (await probes.load('request-' + id)) as ProbeReceipt | undefined,
      saveRequest: (receipt) => probes.save('request-' + receipt.id, receipt),
      saveResult: (result) => probes.save(result.runtimeId, result),
    },
    now: () => new Date().toISOString(),
    id: randomUUID,
  });
  const probe = async (runtimeId: string, meta: { id: string; fingerprint: string }) => {
    const runtime = config.runtimes.find((item) => item.id === runtimeId);
    if (runtime?.client === 'managed') assertActive(runtime.connectionId);
    return probeService.probe(meta.id, meta.fingerprint, runtimeId);
  };
  const saveConnection = (
    connection: ResourceConnection,
    expectedRevision: string | null,
    meta: { id: string; fingerprint: string },
  ) => configuration.save(meta.id, meta.fingerprint, connection, expectedRevision);
  return {
    configuration,
    runtimes,
    resources,
    selection,
    list,
    models,
    probe,
    saveConnection,
    dispose: () => probeService.dispose(),
  };
}
